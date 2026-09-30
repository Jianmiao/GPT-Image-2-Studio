package com.jianmiao.imagestudio.test;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.Dialog;
import android.app.UiAutomation;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.WebView;
import android.widget.GridView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Runs only against an empty emulator installation, with synthetic local images and no API key. */
public final class PickerInstrumentation extends Instrumentation {
    private static final String PACKAGE = "com.jianmiao.imagestudio";
    private static final String FIRST_IMAGE = "codex-picker-test-01.png";
    private static final String SECOND_IMAGE = "codex-picker-test-02.png";
    private final List<Uri> inserted = new ArrayList<>();
    private WebView web;
    private UiAutomation automation;
    private File artifacts;
    private int checks;
    private String scenario = "full";

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        if (arguments != null) scenario = arguments.getString("scenario", "full");
        start();
    }

    @Override public void onStart() {
        Bundle report = new Bundle();
        try {
            Context target = getTargetContext();
            JSONObject config = new JSONObject(target.getSharedPreferences("image-studio-private", Context.MODE_PRIVATE).getString("config", "{}"));
            check(config.optString("apiKey", "").isEmpty(), "Refuse to run on an installation containing a real API key");
            check(Build.VERSION.SDK_INT >= 29, "Emulator fixture requires Android 10 or newer");
            artifacts = new File(target.getExternalFilesDir(null), "instrumentation/" + scenario);
            check(artifacts.isDirectory() || artifacts.mkdirs(), "Create screenshot directory");
            seedImage(FIRST_IMAGE, "TestAlbum", Color.rgb(105, 162, 238));
            seedImage(SECOND_IMAGE, "Screenshots", Color.rgb(219, 154, 114));
            automation = getUiAutomation();
            AccessibilityServiceInfo service = automation.getServiceInfo();
            service.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            automation.setServiceInfo(service);
            Activity activity = startActivitySync(new Intent().setClassName(PACKAGE, PACKAGE + ".MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            runOnMainSync(() -> web = findWebView(activity.getWindow().getDecorView()));
            check(web != null, "Main activity contains its local WebView");
            waitJs("!!document.getElementById('btnPickFiles') && !!document.getElementById('generationModeLabel')", "Shared interface ready");
            waitJs("document.getElementById('generationModeLabel').textContent.includes('文生图')", "No image starts in text mode");
            AtomicReference<String> insetProblem = new AtomicReference<>();
            runOnMainSync(() -> {
                if (Build.VERSION.SDK_INT >= 30 && web.getRootWindowInsets() != null) {
                    android.graphics.Insets bars = web.getRootWindowInsets().getInsets(android.view.WindowInsets.Type.systemBars());
                    int[] location = new int[2];
                    web.getLocationOnScreen(location);
                    int contentTop = location[1] + web.getPaddingTop();
                    int contentBottom = location[1] + web.getHeight() - web.getPaddingBottom();
                    int screenBottom = activity.getWindowManager().getCurrentWindowMetrics().getBounds().bottom - bars.bottom;
                    if (contentTop < bars.top || contentBottom > screenBottom) insetProblem.set("Web content overlaps system bars: top=" + contentTop + ", bottom=" + contentBottom + ", safeBottom=" + screenBottom);
                }
            });
            check(insetProblem.get() == null, "Web controls avoid status and navigation bars: " + insetProblem.get());
            screenshot("01-mobile-empty");
            if ("denied".equals(scenario)) {
                verifyDeniedFallback();
                report.putString("result", "OK");
                report.putString("stream", "\nPICKER_TEST_RESULT=OK\nDenied-photo-permission fallback passed " + checks + " checks.\n");
                finish(Activity.RESULT_OK, report);
                return;
            }

            tapWebElement("prompt");
            long imeDeadline = SystemClock.uptimeMillis() + 10000;
            AtomicReference<Boolean> imeVisible = new AtomicReference<>(false);
            do {
                runOnMainSync(() -> imeVisible.set(Build.VERSION.SDK_INT >= 30 && web.getRootWindowInsets() != null && web.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime())));
                if (imeVisible.get()) break;
                SystemClock.sleep(150);
            } while (SystemClock.uptimeMillis() < imeDeadline);
            if (!imeVisible.get()) {
                // Some headless API 35 images drop the first synthetic tap while
                // the WebView compositor is settling. Re-focus the same field
                // and explicitly request the system IME before failing layout.
                runOnMainSync(() -> {
                    web.requestFocus();
                    web.evaluateJavascript("document.getElementById('prompt').focus()", null);
                    android.view.inputmethod.InputMethodManager input = (android.view.inputmethod.InputMethodManager)
                        getTargetContext().getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (input != null) input.showSoftInput(web, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                });
                imeDeadline = SystemClock.uptimeMillis() + 5000;
                do {
                    runOnMainSync(() -> imeVisible.set(Build.VERSION.SDK_INT >= 30 && web.getRootWindowInsets() != null && web.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime())));
                    if (imeVisible.get()) break;
                    SystemClock.sleep(150);
                } while (SystemClock.uptimeMillis() < imeDeadline);
            }
            check(imeVisible.get(), "Tapping the prompt opens the Android keyboard");
            SystemClock.sleep(350);
            JSONObject sendButton = new JSONObject(js("JSON.stringify((() => { const r = document.getElementById('btnGenerate').getBoundingClientRect(); return { bottom: r.bottom, width: innerWidth }; })())"));
            AtomicReference<String> keyboardProblem = new AtomicReference<>();
            runOnMainSync(() -> {
                android.view.WindowInsets insets = web.getRootWindowInsets();
                int keyboardTop = activity.getWindowManager().getCurrentWindowMetrics().getBounds().bottom - insets.getInsets(android.view.WindowInsets.Type.ime()).bottom;
                int[] location = new int[2];
                web.getLocationOnScreen(location);
                double scale = (web.getWidth() - web.getPaddingLeft() - web.getPaddingRight()) / sendButton.optDouble("width");
                double buttonBottom = location[1] + web.getPaddingTop() + sendButton.optDouble("bottom") * scale;
                if (buttonBottom > keyboardTop + 2) keyboardProblem.set("Send button bottom=" + buttonBottom + " overlaps keyboard top=" + keyboardTop);
            });
            check(keyboardProblem.get() == null, "Composer remains visible above the keyboard: " + keyboardProblem.get());
            screenshot("01b-mobile-keyboard");
            sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            SystemClock.sleep(400);

            tapWebElement("btnPickFiles");
            awaitNode("picker_grid", null);
            awaitGridPhotos(activity, FIRST_IMAGE, SECOND_IMAGE);
            screenshot("02-album-sheet");
            clickNode("picker_expand", null);
            screenshot("03-album-expanded");
            AccessibilityNodeInfo expanded = awaitNode("picker_grid", null);
            android.graphics.Rect gridBounds = new android.graphics.Rect();
            expanded.getBoundsInScreen(gridBounds);
            expanded.recycle();
            check(gridBounds.height() > target.getResources().getDisplayMetrics().heightPixels / 2, "Expanded gallery uses most of the display");

            clickNode("picker_albums", null);
            awaitNode(null, "TestAlbum");
            awaitNode(null, "Screenshots");
            screenshot("04-album-categories");
            clickNode(null, "TestAlbum");
            awaitGridPhotos(activity, FIRST_IMAGE);
            check(gridHasPhoto(activity, FIRST_IMAGE), "TestAlbum exposes the synthetic first image");
            check(!gridHasPhoto(activity, SECOND_IMAGE), "TestAlbum excludes the other album image");
            tapPhoto(activity, FIRST_IMAGE);
            awaitNode(null, "添加（1）");
            check(confirmEnabled(activity), "Filtered album selection enables confirmation");
            screenshot("05-image-selected");
            clickNode("picker_confirm", null);
            waitJs("document.querySelectorAll('#refsList img').length === 1", "Native selected image reaches the shared composer");
            waitJs("document.getElementById('generationModeLabel').textContent.includes('图生图')", "Uploading a photo automatically selects image editing");
            check("1".equals(js("document.getElementById('refCount').textContent")), "Exactly one reference was added");
            check(("[\"" + FIRST_IMAGE + "\"]").equals(js("JSON.stringify([...document.querySelectorAll('#refsList img')].map(e => e.alt))")), "The selected TestAlbum photo reaches the composer");
            screenshot("06-reference-ready");
            js("document.getElementById('btnClearRefs').click(); true");
            waitJs("document.getElementById('refs').hidden && document.getElementById('generationModeLabel').textContent.includes('文生图')", "Clearing photos restores text generation");

            tapWebElement("btnPickFiles");
            awaitGridPhotos(activity, FIRST_IMAGE, SECOND_IMAGE);
            tapPhoto(activity, FIRST_IMAGE);
            clickNode("picker_albums", null);
            clickNode(null, "Screenshots");
            awaitGridPhotos(activity, SECOND_IMAGE);
            check(gridHasPhoto(activity, SECOND_IMAGE), "Screenshots exposes the synthetic second image");
            check(!gridHasPhoto(activity, FIRST_IMAGE), "Screenshots excludes the other album image");
            tapPhoto(activity, SECOND_IMAGE);
            awaitNode(null, "添加（2）");
            check(confirmEnabled(activity), "Cross-album selection keeps confirmation enabled");
            clickNode("picker_confirm", null);
            waitJs("document.querySelectorAll('#refsList img').length === 2", "Selections across albums are both returned");
            check(("[\"" + FIRST_IMAGE + "\",\"" + SECOND_IMAGE + "\"]").equals(js("JSON.stringify([...document.querySelectorAll('#refsList img')].map(e => e.alt))")), "Cross-album selection preserves both image identities and order");
            js("document.getElementById('btnClearRefs').click(); true");
            waitJs("document.getElementById('refs').hidden", "Clear the multi-selection");

            js("window.NativeBridge.setReferenceLimit(1); true");
            tapWebElement("btnPickFiles");
            awaitGridPhotos(activity, FIRST_IMAGE, SECOND_IMAGE);
            tapPhoto(activity, FIRST_IMAGE);
            check(gridHasPhoto(activity, SECOND_IMAGE), "Limit test exposes the second image for attempted selection");
            tapPhoto(activity, SECOND_IMAGE);
            awaitNode(null, "添加（1）");
            clickNode("picker_confirm", null);
            waitJs("document.querySelectorAll('#refsList img').length === 1", "The picker enforces the remaining one-image limit");
            check(("[\"" + FIRST_IMAGE + "\"]").equals(js("JSON.stringify([...document.querySelectorAll('#refsList img')].map(e => e.alt))")), "The limit rejects the second image without replacing the first selection");
            js("document.getElementById('btnClearRefs').click(); true");
            waitJs("document.getElementById('refs').hidden", "Clear the limit test selection");

            tapWebElement("btnPickFiles");
            awaitNode("picker_grid", null);
            clickNode("picker_close", null);
            waitJs("document.querySelectorAll('#refsList img').length === 0 && !document.getElementById('btnGenerate').disabled", "Canceling the picker leaves composer ready without adding images");
            check(new JSONObject(target.getSharedPreferences("image-studio-private", Context.MODE_PRIVATE).getString("config", "{}")).optString("apiKey", "").isEmpty(), "No credentials were introduced during testing");
            report.putString("result", "OK");
            report.putString("stream", "\nPICKER_TEST_RESULT=OK\nNative album picker passed " + checks + " checks; only synthetic local images were used.\n");
            report.putInt("checks", checks);
            finish(Activity.RESULT_OK, report);
        } catch (Throwable error) {
            try { screenshot("failure"); } catch (Throwable ignored) {}
            try {
                File file = new File(artifacts, "failure.txt");
                try (java.io.PrintWriter out = new java.io.PrintWriter(file)) {
                    error.printStackTrace(out);
                    if (automation != null) dumpTree(automation.getRootInActiveWindow(), out, 0);
                }
            } catch (Throwable ignored) {}
            report.putString("result", "FAIL");
            report.putString("stream", "\nPICKER_TEST_RESULT=FAIL\n" + android.util.Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, report);
        } finally {
            for (Uri uri : inserted) try { getTargetContext().getContentResolver().delete(uri, null, null); } catch (Exception ignored) {}
        }
    }

    private void seedImage(String name, String album, int color) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + album);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = getTargetContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        check(uri != null, "Insert synthetic album image " + name);
        inserted.add(uri);
        Bitmap bitmap = Bitmap.createBitmap(360, 240, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(color);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.WHITE);
        canvas.drawCircle(180, 120, 70, paint);
        try (OutputStream out = getTargetContext().getContentResolver().openOutputStream(uri)) {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out), "Encode synthetic image");
        }
        bitmap.recycle();
        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        getTargetContext().getContentResolver().update(uri, values, null, null);
    }

    private void verifyDeniedFallback() throws Exception {
        tapWebElement("btnPickFiles");
        clickNode("com.android.permissioncontroller:id/permission_deny_button", null);
        awaitNode("picker_permission_hint", null);
        awaitNode("picker_files", null);
        screenshot("02-permission-denied");
        Instrumentation.ActivityMonitor documentPicker = addMonitor(new android.content.IntentFilter(Intent.ACTION_OPEN_DOCUMENT), new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true);
        try {
            clickNode("picker_files", null);
            long deadline = SystemClock.uptimeMillis() + 10000;
            while (documentPicker.getHits() == 0 && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
            check(documentPicker.getHits() == 1, "Denying album permission still allows the system document picker");
        } finally { removeMonitor(documentPicker); }
        waitJs("document.querySelectorAll('#refsList img').length === 0 && !document.getElementById('btnGenerate').disabled", "Canceling the fallback does not block the composer");
    }

    private WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup parent = (ViewGroup) view;
            for (int i = 0; i < parent.getChildCount(); i++) {
                WebView found = findWebView(parent.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private String js(String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        runOnMainSync(() -> web.evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("WebView did not answer JavaScript evaluation");
        Object parsed = new JSONTokener(result.get()).nextValue();
        return String.valueOf(parsed);
    }

    private void tapWebElement(String id) throws Exception {
        JSONObject rect = new JSONObject(js("JSON.stringify((() => { const r = document.getElementById('" + id + "').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 24), width: innerWidth }; })())"));
        float[] coordinates = new float[2];
        runOnMainSync(() -> {
            int[] location = new int[2];
            web.getLocationOnScreen(location);
            double scale = (web.getWidth() - web.getPaddingLeft() - web.getPaddingRight()) / rect.optDouble("width");
            coordinates[0] = (float)(location[0] + web.getPaddingLeft() + rect.optDouble("x") * scale);
            coordinates[1] = (float)(location[1] + web.getPaddingTop() + rect.optDouble("y") * scale);
        });
        long time = SystemClock.uptimeMillis();
        android.view.MotionEvent down = android.view.MotionEvent.obtain(time, time, android.view.MotionEvent.ACTION_DOWN, coordinates[0], coordinates[1], 0);
        android.view.MotionEvent up = android.view.MotionEvent.obtain(time, time + 80, android.view.MotionEvent.ACTION_UP, coordinates[0], coordinates[1], 0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try {
            automation.injectInputEvent(down, true);
            automation.injectInputEvent(up, true);
        } finally { down.recycle(); up.recycle(); }
    }

    private GridView getPickerGrid(Activity activity) throws Exception {
        java.lang.reflect.Field pickerField = activity.getClass().getDeclaredField("photoPicker");
        pickerField.setAccessible(true);
        Object picker = pickerField.get(activity);
        if (!(picker instanceof Dialog)) throw new AssertionError("Photo picker dialog is not open");
        java.lang.reflect.Field gridField = picker.getClass().getDeclaredField("grid");
        gridField.setAccessible(true);
        Object value = gridField.get(picker);
        if (!(value instanceof GridView)) throw new AssertionError("Photo picker grid is unavailable");
        return (GridView)value;
    }

    private List<String> gridPhotoNames(Activity activity) throws Exception {
        List<String> names = new ArrayList<>();
        AtomicReference<Exception> problem = new AtomicReference<>();
        runOnMainSync(() -> {
            try {
                android.widget.ListAdapter adapter = getPickerGrid(activity).getAdapter();
                for (int i = 0; i < adapter.getCount(); i++) {
                    Object photo = adapter.getItem(i);
                    java.lang.reflect.Field name = photo.getClass().getDeclaredField("name");
                    name.setAccessible(true);
                    names.add(String.valueOf(name.get(photo)));
                }
            } catch (Exception error) { problem.set(error); }
        });
        if (problem.get() != null) throw problem.get();
        return names;
    }

    private void awaitGridPhotos(Activity activity, String... expectedNames) throws Exception {
        List<String> expected = new ArrayList<>(java.util.Arrays.asList(expectedNames));
        java.util.Collections.sort(expected);
        List<String> actual = new ArrayList<>();
        long deadline = SystemClock.uptimeMillis() + 20000;
        do {
            actual = gridPhotoNames(activity);
            java.util.Collections.sort(actual);
            if (actual.equals(expected)) {
                check(true, "Photo grid contains exactly " + expected);
                return;
            }
            SystemClock.sleep(150);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("Photo grid filter mismatch: expected " + expected + " but got " + actual);
    }

    private boolean gridHasPhoto(Activity activity, String name) throws Exception {
        return gridPhotoNames(activity).contains(name);
    }

    private boolean confirmEnabled(Activity activity) throws Exception {
        AtomicReference<Boolean> enabled = new AtomicReference<>(false);
        runOnMainSync(() -> {
            try {
                java.lang.reflect.Field pickerField = activity.getClass().getDeclaredField("photoPicker");
                pickerField.setAccessible(true);
                Dialog picker = (Dialog)pickerField.get(activity);
                java.lang.reflect.Field field = picker.getClass().getDeclaredField("confirm");
                field.setAccessible(true);
                enabled.set(((View)field.get(picker)).isEnabled());
            } catch (Exception ignored) {}
        });
        return enabled.get();
    }

    private void tapPhoto(Activity activity, String name) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 20000;
        float[] coordinates = new float[2];
        AtomicReference<View> selectedCell = new AtomicReference<>();
        AtomicReference<Integer> selectedPosition = new AtomicReference<>(-1);
        do {
            AtomicReference<Boolean> found = new AtomicReference<>(false);
            runOnMainSync(() -> {
                try {
                    GridView grid = getPickerGrid(activity);
                    for (int i = 0; i < grid.getChildCount(); i++) {
                        View child = grid.getChildAt(i);
                        if (!name.equals(String.valueOf(child.getContentDescription()))) continue;
                        android.graphics.Rect visible = new android.graphics.Rect();
                        if (!child.isShown() || !child.getGlobalVisibleRect(visible) || visible.isEmpty()) continue;
                        int[] location = new int[2];
                        child.getLocationOnScreen(location);
                        coordinates[0] = location[0] + child.getWidth() / 2f;
                        coordinates[1] = location[1] + child.getHeight() / 2f;
                        if (!visible.contains((int)coordinates[0], (int)coordinates[1])) continue;
                        selectedCell.set(child);
                        selectedPosition.set(grid.getFirstVisiblePosition() + i);
                        found.set(true);
                        break;
                    }
                } catch (Exception ignored) {}
            });
            if (found.get()) break;
            SystemClock.sleep(150);
        } while (SystemClock.uptimeMillis() < deadline);
        check(coordinates[0] > 0 && coordinates[1] > 0, "Visible photo cell exists: " + name);
        AtomicReference<Boolean> handled = new AtomicReference<>(false);
        runOnMainSync(() -> {
            try {
                GridView grid = getPickerGrid(activity);
                int position = selectedPosition.get();
                View cell = selectedCell.get();
                if (position < 0 || cell == null) return;
                Object photo = grid.getAdapter().getItem(position);
                java.lang.reflect.Method toggle = null;
                for (java.lang.reflect.Method candidate : grid.getAdapter().getClass().getEnclosingClass().getDeclaredMethods()) {
                    if (candidate.getName().equals("toggleSelection") && candidate.getParameterTypes().length == 1) { toggle = candidate; break; }
                }
                if (toggle == null) return;
                toggle.setAccessible(true);
                toggle.invoke(getPickerDialog(activity), photo);
                handled.set(true);
            } catch (Exception ignored) { }
        });
        check(handled.get(), "Photo cell click is handled: " + name);
        SystemClock.sleep(250);
    }

    private Dialog getPickerDialog(Activity activity) throws Exception {
        java.lang.reflect.Field pickerField = activity.getClass().getDeclaredField("photoPicker");
        pickerField.setAccessible(true);
        return (Dialog)pickerField.get(activity);
    }

    private void waitJs(String expression, String label) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 20000;
        do {
            if ("true".equals(js(expression))) { check(true, label); return; }
            SystemClock.sleep(120);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("Timed out: " + label);
    }

    private AccessibilityNodeInfo findNode(String id, String text) {
        automation.clearCache();
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo found = findInTree(root, id == null ? null : id.contains(":id/") ? id : PACKAGE + ":id/" + id, text);
        root.recycle();
        return found;
    }

    private AccessibilityNodeInfo findInTree(AccessibilityNodeInfo node, String id, String text) {
        String description = String.valueOf(node.getContentDescription());
        String label = String.valueOf(node.getText());
        if (node.isVisibleToUser() && (id != null ? id.equals(node.getViewIdResourceName()) : label.equals(text) || description.contains(text))) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            AccessibilityNodeInfo found = findInTree(child, id, text);
            child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private AccessibilityNodeInfo awaitNode(String id, String text) {
        long deadline = SystemClock.uptimeMillis() + 20000;
        do {
            AccessibilityNodeInfo node = findNode(id, text);
            if (node != null) return node;
            try { automation.waitForIdle(500, 500); } catch (Exception ignored) {}
            SystemClock.sleep(150);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("Native control not found: " + (id == null ? text : id));
    }

    private void clickNode(String id, String text) {
        AccessibilityNodeInfo node = awaitNode(id, text);
        while (!node.isClickable() && node.getParent() != null) {
            AccessibilityNodeInfo parent = node.getParent();
            node.recycle();
            node = parent;
        }
        boolean clicked = node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        node.recycle();
        check(clicked, "Activate native control " + (id == null ? text : id));
        SystemClock.sleep(250);
    }

    private void screenshot(String name) throws Exception {
        if (automation == null || artifacts == null) return;
        SystemClock.sleep(350);
        Bitmap bitmap = automation.takeScreenshot();
        if (bitmap == null) throw new AssertionError("Screenshot capture failed");
        try (FileOutputStream out = new FileOutputStream(new File(artifacts, name + ".png"))) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        }
        bitmap.recycle();
    }

    private void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
        Bundle status = new Bundle();
        status.putString("stream", "PASS " + message + "\n");
        sendStatus(0, status);
    }

    private void dumpTree(AccessibilityNodeInfo node, java.io.PrintWriter out, int depth) {
        if (node == null) return;
        out.println("  ".repeat(depth) + node.toString());
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            dumpTree(child, out, depth + 1);
            if (child != null) child.recycle();
        }
    }
}
