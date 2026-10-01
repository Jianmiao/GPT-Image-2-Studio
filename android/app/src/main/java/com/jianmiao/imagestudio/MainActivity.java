package com.jianmiao.imagestudio;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.HashMap;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A local, offline-capable WebView UI backed by native Android storage and networking. */
public final class MainActivity extends Activity {
    public static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int PICK_IMAGES = 101, SAVE_IMAGE = 102, PHOTO_ACCESS = 103, ALBUM_WRITE = 104;
    private WebView web;
    private android.widget.FrameLayout webRoot;
    private boolean lightTheme;
    private NativeApi api;
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final Set<String> seenRequests = Collections.synchronizedSet(new LinkedHashSet<>());
    private ValueCallback<Uri[]> fileCallback;
    private PhotoPickerDialog photoPicker;
    private volatile int referenceLimit = 10;
    private int pickerLimit = 10;
    private volatile boolean trustedPage;
    private volatile boolean destroyed;
    private NativeApi.Download pendingExport;
    private JSONObject pendingGeneration;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        api = new NativeApi(this);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(25, 25, 25));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webRoot = new android.widget.FrameLayout(this);
        webRoot.setBackgroundColor(Color.rgb(25, 25, 25));
        webRoot.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        setContentView(webRoot);
        applyTheme(getPreferences(MODE_PRIVATE).getBoolean("light-theme", false));
        // Android 15 enforces edge-to-edge for target 35; keep controls clear of system bars.
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            webRoot.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
                android.widget.FrameLayout.LayoutParams layout = (android.widget.FrameLayout.LayoutParams) web.getLayoutParams();
                if (layout.leftMargin != bars.left || layout.topMargin != bars.top || layout.rightMargin != bars.right || layout.bottomMargin != bars.bottom) {
                    layout.setMargins(bars.left, bars.top, bars.right, bars.bottom);
                    web.setLayoutParams(layout);
                }
                return insets;
            });
            webRoot.requestApplyInsets();
        } else webRoot.setFitsSystemWindows(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // Scoped content:// image picker results only.
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSafeBrowsingEnabled(true);
        web.addJavascriptInterface(new Bridge(), "NativeBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                Uri uri = request.getUrl();
                if (isLocal(uri) && ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath()))) return false;
                openExternal(uri);
                return true;
            }
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                trustedPage = isLocal(Uri.parse(url));
            }
            @Override public void onPageFinished(WebView v, String url) {
                trustedPage = isLocal(Uri.parse(url));
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("data".equals(uri.getScheme()) && uri.toString().startsWith("data:image/")) return null;
                if ("blob".equals(uri.getScheme())) return null;
                if (!isLocal(uri)) return denied(403, "External resources are blocked");
                if (!"GET".equals(request.getMethod())) return denied(405, "Use the native bridge");
                String path = uri.getPath();
                if (path == null || path.contains("..") || path.contains("\\")) return denied(403, "Forbidden");
                try {
                    InputStream stream;
                    if (path.startsWith("/remote-image/")) {
                        NativeApi.Download image = api.download(path, "image.png");
                        return new WebResourceResponse(image.mime, null, new ByteArrayInputStream(image.bytes));
                    } else if (path.startsWith("/gallery/")) {
                        File file = api.galleryFile(path.substring(9));
                        if (file == null) return denied(404, "Image not found");
                        stream = new FileInputStream(file);
                    } else {
                        if (path.startsWith("/api/")) return denied(400, "Native API bridge required");
                        String asset = path.equals("/") ? "index.html" : path.substring(1);
                        if (!asset.matches("[a-zA-Z0-9_./-]+")) return denied(403, "Forbidden");
                        stream = getAssets().open("web/" + asset);
                    }
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-cache");
                    headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
                    return new WebResourceResponse(mime(path), "UTF-8", 200, "OK", headers, stream);
                } catch (Exception e) { return denied(404, "Not found"); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!trustedPage) return false;
                if (photoPicker != null) { photoPicker.dismissQuietly(); photoPicker = null; }
                completeFileSelection(null);
                fileCallback = callback;
                pickerLimit = Math.max(0, Math.min(10, referenceLimit));
                if (pickerLimit == 0) { completeFileSelection(null); toast("已选满参考图，请先移除一张"); return true; }
                showPhotoPicker();
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        web.setDownloadListener((url, userAgent, contentDisposition, type, length) -> {
            if (trustedPage) beginDownload(url, "GPT-Image-2-" + System.currentTimeMillis() + ".png");
        });
        trustedPage = true;
        web.loadUrl(ORIGIN + "/");
    }

    private boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }
    private void openExternal(Uri uri) {
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception e) { toast("没有可用的浏览器"); }
    }
    private static WebResourceResponse denied(int status, String message) {
        return new WebResourceResponse("text/plain", "UTF-8", status, "Blocked", Collections.emptyMap(),
            new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }
    public static String mime(String path) {
        String p = path.toLowerCase(java.util.Locale.ROOT);
        if (p.endsWith(".html") || p.equals("/")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".json")) return "application/json";
        return "image/png";
    }
    private void toast(String text) { runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show()); }
    private void applyTheme(boolean light) {
        lightTheme = light;
        int color = light ? Color.rgb(248, 249, 251) : Color.rgb(25, 25, 25);
        web.setBackgroundColor(color);
        webRoot.setBackgroundColor(color);
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            int flags = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (controller != null) controller.setSystemBarsAppearance(light ? flags : 0, flags);
        } else {
            View decor = getWindow().getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(light ? decor.getSystemUiVisibility() | flags : decor.getSystemUiVisibility() & ~flags);
        }
    }
    private void completeFileSelection(Uri[] images) {
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        if (callback != null) callback.onReceiveValue(images);
    }
    private void showPhotoPicker() {
        photoPicker = new PhotoPickerDialog(this, pickerLimit, lightTheme, new PhotoPickerDialog.Listener() {
            @Override public void onSelected(Uri[] images) { completeFileSelection(images); photoPicker = null; }
            @Override public void onFiles() { photoPicker = null; openImageFiles(); }
            @Override public void onRequestAccess() { requestPhotoAccess(); }
        });
        photoPicker.show();
        if (!PhotoPickerDialog.hasFullAccess(this) && !PhotoPickerDialog.hasPartialAccess(this)
            && !getPreferences(MODE_PRIVATE).getBoolean("photo-access-requested", false)) requestPhotoAccess();
    }
    private void requestPhotoAccess() {
        if (destroyed || fileCallback == null) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("photo-access-requested", true).apply();
        String[] permissions = Build.VERSION.SDK_INT >= 34
            ? new String[]{android.Manifest.permission.READ_MEDIA_IMAGES, android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED}
            : Build.VERSION.SDK_INT >= 33 ? new String[]{android.Manifest.permission.READ_MEDIA_IMAGES}
            : new String[]{android.Manifest.permission.READ_EXTERNAL_STORAGE};
        requestPermissions(permissions, PHOTO_ACCESS);
    }
    private void openImageFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*")
            .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, pickerLimit > 1)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_IMAGES); }
        catch (Exception e) { completeFileSelection(null); toast("无法打开图片选择器"); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == PHOTO_ACCESS && photoPicker != null) photoPicker.refreshAccess();
        if (request == ALBUM_WRITE) {
            JSONObject queued = pendingGeneration;
            pendingGeneration = null;
            // Permission denial affects album export only; dispatch the original
            // generation exactly once, with its original parameters.
            if (queued != null && !destroyed && trustedPage) dispatchRequest(queued);
        }
    }
    private void dispatchRequest(JSONObject request) {
        workers.execute(() -> {
            NativeApi.Result result = api.handle(request);
            respond(request.optString("id"), result.status, result.body.toString());
        });
    }
    private void prepareGeneration(JSONObject request) {
        runOnUiThread(() -> {
            if (destroyed || !trustedPage) return;
            if (pendingGeneration != null) {
                respond(request.optString("id"), 409, "{\"error\":\"请先完成相册权限选择，没有重复提交。\"}");
                return;
            }
            if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED
                || getPreferences(MODE_PRIVATE).getBoolean("album-write-requested", false)) {
                dispatchRequest(request);
                return;
            }
            pendingGeneration = request;
            getPreferences(MODE_PRIVATE).edit().putBoolean("album-write-requested", true).apply();
            try { requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, ALBUM_WRITE); }
            catch (Exception e) { pendingGeneration = null; dispatchRequest(request); }
        });
    }
    private void respond(String id, int status, String body) {
        runOnUiThread(() -> {
            if (destroyed || !trustedPage || !isLocal(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) return;
            web.evaluateJavascript("window.__nativeResponse&&window.__nativeResponse(" + JSONObject.quote(id) + ","
                + status + "," + JSONObject.quote(body) + ",'application/json')", null);
        });
    }
    private final class Bridge {
        @JavascriptInterface public void setTheme(String theme) {
            if (!trustedPage || destroyed || !("light".equals(theme) || "dark".equals(theme))) return;
            runOnUiThread(() -> {
                if (!trustedPage || destroyed) return;
                boolean light = "light".equals(theme);
                applyTheme(light);
                getPreferences(MODE_PRIVATE).edit().putBoolean("light-theme", light).apply();
            });
        }
        @JavascriptInterface public void setReferenceLimit(int remaining) {
            if (!trustedPage || destroyed) return;
            referenceLimit = Math.max(0, Math.min(10, remaining));
        }
        @JavascriptInterface public void postMessage(String text) {
            if (!trustedPage || destroyed || text == null || text.length() > 120 * 1024 * 1024) return;
            String id = "";
            try {
                JSONObject request = new JSONObject(text);
                id = String.valueOf(request.get("id"));
                if (id.length() > 160) return;
                synchronized (seenRequests) {
                    if (!seenRequests.add(id)) return;
                    // Page-scoped monotonic IDs: preserve all generation IDs for the session.
                    if (seenRequests.size() > 20000) { respond(id, 429, "{\"error\":\"请重新打开应用后继续\"}"); return; }
                }
                if (Build.VERSION.SDK_INT <= 28 && "/api/generate".equals(request.optString("path"))
                    && "POST".equalsIgnoreCase(request.optString("method"))) prepareGeneration(request);
                else dispatchRequest(request);
            } catch (Exception e) { respond(id, 400, "{\"error\":\"无效的本地请求\"}"); }
        }
        @JavascriptInterface public void copyText(String text) {
            if (!trustedPage || destroyed || text == null) return;
            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("GPT Image 2", text));
                toast("已复制到剪贴板");
            });
        }
        @JavascriptInterface public void download(String url, String filename) {
            if (!trustedPage || destroyed) return;
            beginDownload(url, filename);
        }
    }
    private void beginDownload(String url, String filename) {
        workers.execute(() -> {
            try {
                NativeApi.Download item = api.download(url, filename);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, item.name);
                    values.put(MediaStore.Downloads.MIME_TYPE, item.mime);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/GPT Image 2");
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new java.io.IOException("无法创建下载文件");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) { if (out == null) throw new java.io.IOException("无法写入下载文件"); out.write(item.bytes); }
                    catch (Exception e) { getContentResolver().delete(uri, null, null); throw e; }
                    values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(uri, values, null, null);
                    toast("图片已保存到下载 / GPT Image 2");
                } else {
                    runOnUiThread(() -> {
                        if (pendingExport != null) { toast("请先完成上一次图片保存"); return; }
                        pendingExport = item;
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType(item.mime).putExtra(Intent.EXTRA_TITLE, item.name);
                        try { startActivityForResult(intent, SAVE_IMAGE); }
                        catch (Exception e) { pendingExport = null; toast("无法打开保存位置选择器"); }
                    });
                }
            } catch (Exception e) { toast("保存失败：" + e.getMessage()); }
        });
    }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == PICK_IMAGES && fileCallback != null) {
            Uri[] selected = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = Math.min(pickerLimit, data.getClipData().getItemCount()); selected = new Uri[count];
                    for (int i = 0; i < count; i++) selected[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) selected = new Uri[]{data.getData()};
            }
            completeFileSelection(selected);
        }
        if (code == SAVE_IMAGE) {
            NativeApi.Download item = pendingExport; pendingExport = null;
            if (result == RESULT_OK && data != null && data.getData() != null && item != null) {
                Uri uri = data.getData();
                workers.execute(() -> {
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new java.io.IOException("无法写入文件");
                        out.write(item.bytes); toast("图片已保存");
                    } catch (Exception e) { toast("保存失败：" + e.getMessage()); }
                });
            }
        }
    }
    @Override public void onBackPressed() {
        if (trustedPage) web.evaluateJavascript("(()=>{const open=!!document.querySelector('.modal:not([hidden]),.lightbox:not([hidden]),.tool-menu[open]')||document.body.classList.contains('sidebar-open');if(open)document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return open})()",
            result -> { if (!"true".equals(result)) moveTaskToBack(true); });
        else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        destroyed = true; trustedPage = false;
        pendingGeneration = null;
        if (photoPicker != null) { photoPicker.dismissQuietly(); photoPicker = null; }
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        web.removeJavascriptInterface("NativeBridge"); web.destroy();
        workers.shutdown(); // Do not cancel a submitted billable request; its result is still saved locally.
        super.onDestroy();
    }
}
