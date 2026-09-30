package com.jianmiao.imagestudio;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.LruCache;
import android.util.Size;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.AbsListView;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Local-only album sheet. Media queries and thumbnail decoding never block the UI. */
final class PhotoPickerDialog extends Dialog {
    interface Listener {
        void onSelected(Uri[] images);
        void onFiles();
        void onRequestAccess();
    }

    private static final int PAGE_SIZE = 128;
    private static final int SURFACE = Color.rgb(28, 28, 28);
    private static final int TEXT = Color.rgb(238, 238, 238);
    private static final int MUTED = Color.rgb(170, 170, 170);
    private final Activity activity;
    private final Listener listener;
    private final int limit;
    private final ExecutorService queryWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService thumbnailWorkers = Executors.newFixedThreadPool(2);
    private final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(16 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap bitmap) { return bitmap.getByteCount(); }
    };
    private final ArrayList<Photo> photos = new ArrayList<>();
    private final ArrayList<Album> albums = new ArrayList<>();
    private final LinkedHashMap<String, Uri> selected = new LinkedHashMap<>();
    private final PhotoAdapter photoAdapter = new PhotoAdapter();
    private final AlbumAdapter albumAdapter = new AlbumAdapter();
    private FrameLayout root, body;
    private LinearLayout panel;
    private GridView grid;
    private ListView albumList;
    private TextView title, albumsToggle, expand, confirm, count, hint, empty;
    private boolean expanded, showingAlbums, handled, loading, hasMore = true;
    private volatile boolean disposed;
    private String bucketId;
    private String bucketName = "所有照片";
    private int queryVersion;
    private float dragStart;

    PhotoPickerDialog(Activity activity, int limit, Listener listener) {
        super(activity, android.R.style.Theme_Material_NoActionBar);
        this.activity = activity;
        this.limit = Math.max(1, Math.min(10, limit));
        this.listener = listener;
    }

    static boolean hasFullAccess(Activity activity) {
        String permission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES : Manifest.permission.READ_EXTERNAL_STORAGE;
        return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasPartialAccess(Activity activity) {
        return Build.VERSION.SDK_INT >= 34 && activity.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED;
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window window = getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.dimAmount = .58f;
        window.setAttributes(attributes);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(SURFACE);
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false);

        root = new FrameLayout(activity);
        root.setOnClickListener(v -> cancel());
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                v.post(this::sizePanel);
                return insets;
            });
        } else root.setFitsSystemWindows(true);
        panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(round(SURFACE, 22));
        panel.setClipToOutline(true);
        panel.setOnClickListener(v -> {});
        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(-1, -1, Gravity.BOTTOM);
        root.addView(panel, panelParams);

        FrameLayout handleArea = new FrameLayout(activity);
        View handle = new View(activity);
        handle.setBackground(round(Color.rgb(92, 92, 92), 3));
        FrameLayout.LayoutParams handleParams = new FrameLayout.LayoutParams(dp(40), dp(5), Gravity.CENTER);
        handleArea.addView(handle, handleParams);
        panel.addView(handleArea, new LinearLayout.LayoutParams(-1, dp(24)));
        handleArea.setContentDescription("上滑展开相册，下滑收起");
        handleArea.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) { dragStart = event.getRawY(); return true; }
            if (event.getAction() == MotionEvent.ACTION_UP) {
                float travel = event.getRawY() - dragStart;
                if (travel < -dp(24)) setExpanded(true);
                else if (travel > dp(24)) setExpanded(false);
                else setExpanded(!expanded);
                v.performClick();
                return true;
            }
            return true;
        });

        LinearLayout header = row();
        header.setPadding(dp(10), 0, dp(10), dp(6));
        TextView close = button("×", 28, R.id.picker_close);
        close.setContentDescription("关闭相册");
        close.setOnClickListener(v -> cancel());
        header.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout titleGroup = row();
        titleGroup.setGravity(Gravity.CENTER);
        titleGroup.setId(R.id.picker_albums);
        titleGroup.setContentDescription("切换分类相册");
        titleGroup.setClickable(true);
        titleGroup.setOnClickListener(v -> showAlbums(!showingAlbums));
        title = label("所有照片", 19, TEXT);
        title.setId(R.id.picker_title);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        titleGroup.addView(title, new LinearLayout.LayoutParams(-2, -2));
        albumsToggle = label("⌄", 22, TEXT);
        albumsToggle.setPadding(dp(7), 0, 0, 0);
        titleGroup.addView(albumsToggle);
        header.addView(titleGroup, new LinearLayout.LayoutParams(0, dp(48), 1));
        expand = button("展开", 15, R.id.picker_expand);
        expand.setOnClickListener(v -> setExpanded(!expanded));
        header.addView(expand, new LinearLayout.LayoutParams(dp(56), dp(48)));
        panel.addView(header);

        LinearLayout actions = row();
        actions.setPadding(dp(14), 0, dp(14), dp(8));
        TextView files = button("文件 / 系统相册", 15, R.id.picker_files);
        files.setBackground(round(Color.rgb(47, 47, 47), 12));
        files.setPadding(dp(14), 0, dp(14), 0);
        files.setOnClickListener(v -> { handled = true; dismiss(); listener.onFiles(); });
        actions.addView(files, new LinearLayout.LayoutParams(-2, dp(44)));
        TextView note = label("最多添加 " + this.limit + " 张", 13, MUTED);
        note.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        actions.addView(note, new LinearLayout.LayoutParams(0, dp(44), 1));
        panel.addView(actions);

        hint = button("", 14, R.id.picker_permission_hint);
        hint.setPadding(dp(16), dp(8), dp(16), dp(8));
        hint.setTextColor(Color.rgb(183, 209, 247));
        hint.setOnClickListener(v -> listener.onRequestAccess());
        panel.addView(hint, new LinearLayout.LayoutParams(-1, -2));

        body = new FrameLayout(activity);
        grid = new GridView(activity);
        grid.setId(R.id.picker_grid);
        grid.setNumColumns(activity.getResources().getConfiguration().screenWidthDp >= 600 ? 4 : 3);
        grid.setVerticalSpacing(dp(3));
        grid.setHorizontalSpacing(dp(3));
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setClipToPadding(false);
        grid.setPadding(dp(3), 0, dp(3), dp(3));
        grid.setAdapter(photoAdapter);
        // Let GridView dispatch the tap to the selected adapter position. A
        // competing child click listener can swallow touches on some Android
        // 15 Dialog windows and leave the selection count unchanged.
        grid.setOnItemClickListener((parent, view, position, id) -> toggleSelection(photos.get(position)));
        grid.setOnScrollListener(new AbsListView.OnScrollListener() {
            public void onScrollStateChanged(AbsListView view, int state) {}
            public void onScroll(AbsListView view, int first, int visible, int total) {
                if (visible > 0 && first + visible >= total - 18) loadNextPage();
            }
        });
        body.addView(grid, new FrameLayout.LayoutParams(-1, -1));
        albumList = new ListView(activity);
        albumList.setBackgroundColor(SURFACE);
        albumList.setDividerHeight(0);
        albumList.setAdapter(albumAdapter);
        albumList.setVisibility(View.GONE);
        albumList.setOnItemClickListener((parent, view, position, id) -> {
            Album album = albums.get(position);
            bucketId = album.id;
            bucketName = album.name;
            showAlbums(false);
            reloadPhotos();
        });
        body.addView(albumList, new FrameLayout.LayoutParams(-1, -1));
        empty = label("正在读取相册…", 16, MUTED);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(dp(24), dp(24), dp(24), dp(24));
        body.addView(empty, new FrameLayout.LayoutParams(-1, -1));
        panel.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout footer = row();
        footer.setPadding(dp(18), dp(12), dp(18), dp(12));
        footer.setBackgroundColor(Color.rgb(35, 35, 35));
        count = label("已选 0 / " + limit, 16, MUTED);
        footer.addView(count, new LinearLayout.LayoutParams(0, dp(46), 1));
        confirm = button("添加", 16, R.id.picker_confirm);
        confirm.setPadding(dp(25), 0, dp(25), 0);
        confirm.setBackground(round(Color.rgb(170, 200, 240), 23));
        confirm.setTextColor(Color.rgb(22, 32, 48));
        confirm.setOnClickListener(v -> {
            if (selected.isEmpty()) return;
            handled = true;
            listener.onSelected(selected.values().toArray(new Uri[0]));
            dismiss();
        });
        footer.addView(confirm, new LinearLayout.LayoutParams(-2, dp(46)));
        panel.addView(footer);
        setContentView(root);
        window.setLayout(-1, -1);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> { if (b - t != ob - ot || r - l != or - ol) sizePanel(); });
        root.post(this::sizePanel);
        updateSelection();
        refreshAccess();
    }

    private void sizePanel() {
        if (root == null || root.getHeight() == 0) return;
        int available = root.getHeight() - root.getPaddingTop() - root.getPaddingBottom();
        int wanted = expanded ? available : Math.min(available, Math.max(dp(350), Math.round(available * .60f)));
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) panel.getLayoutParams();
        if (lp.height != wanted) { lp.height = wanted; panel.setLayoutParams(lp); }
    }

    private void setExpanded(boolean value) {
        expanded = value;
        expand.setText(value ? "收起" : "展开");
        expand.setContentDescription(value ? "收起相册" : "全屏展开相册");
        sizePanel();
    }

    private void showAlbums(boolean show) {
        showingAlbums = show;
        if (show) setExpanded(true);
        albumList.setVisibility(show ? View.VISIBLE : View.GONE);
        grid.setVisibility(show ? View.GONE : View.VISIBLE);
        title.setText(show ? "所有相册" : bucketName);
        albumsToggle.setText(show ? "⌃" : "⌄");
        updateEmpty();
    }

    void refreshAccess() {
        if (disposed || grid == null) return;
        boolean full = hasFullAccess(activity), partial = hasPartialAccess(activity);
        hint.setVisibility(full ? View.GONE : View.VISIBLE);
        hint.setText(partial ? "当前仅显示已授权照片 · 点击选择更多" : "允许访问照片，直接浏览相册 · 点击授权");
        if (!full && !partial) {
            queryVersion++;
            photos.clear(); albums.clear(); photoAdapter.notifyDataSetChanged(); albumAdapter.notifyDataSetChanged(); refreshGridAccessibility();
            empty.setText("未获得照片访问权限\n你仍可点击「文件 / 系统相册」选择图片");
            empty.setVisibility(View.VISIBLE);
            return;
        }
        reloadPhotos();
        loadAlbums();
    }

    private void reloadPhotos() {
        queryVersion++;
        loading = false;
        hasMore = true;
        photos.clear();
        photoAdapter.notifyDataSetChanged();
        refreshGridAccessibility();
        grid.setSelection(0);
        empty.setText("正在读取相册…");
        empty.setVisibility(View.VISIBLE);
        loadNextPage();
    }

    private void loadNextPage() {
        if (disposed || loading || !hasMore || (!hasFullAccess(activity) && !hasPartialAccess(activity))) return;
        loading = true;
        int version = queryVersion;
        long beforeId = photos.isEmpty() ? Long.MAX_VALUE : ContentUris.parseId(photos.get(photos.size() - 1).uri);
        String album = bucketId;
        queryWorker.execute(() -> {
            ArrayList<Photo> page = new ArrayList<>();
            String problem = null;
            String selection = MediaStore.Images.Media._ID + " < ?"
                + (album == null ? "" : " AND " + MediaStore.Images.Media.BUCKET_ID + "=?");
            String[] args = album == null ? new String[]{String.valueOf(beforeId)} : new String[]{String.valueOf(beforeId), album};
            String[] columns = { MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME };
            try {
                Bundle query = new Bundle();
                query.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
                query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
                query.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, MediaStore.Images.Media._ID + " DESC");
                query.putInt(ContentResolver.QUERY_ARG_LIMIT, PAGE_SIZE);
                try (Cursor cursor = activity.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, query, null)) {
                    if (cursor != null) {
                        // Keyset paging also works when an older provider ignores QUERY_ARG_LIMIT.
                        while (page.size() < PAGE_SIZE && cursor.moveToNext()) {
                            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cursor.getLong(0));
                            page.add(new Photo(uri, cursor.getString(1)));
                        }
                    }
                }
            } catch (Exception e) { problem = "暂时无法读取相册，请使用文件选择器"; }
            String error = problem;
            activity.runOnUiThread(() -> {
                if (disposed || version != queryVersion) return;
                loading = false;
                hasMore = page.size() == PAGE_SIZE && error == null;
                photos.addAll(page);
                photoAdapter.notifyDataSetChanged();
                refreshGridAccessibility();
                if (error != null) { empty.setText(error); empty.setVisibility(View.VISIBLE); }
                else updateEmpty();
            });
        });
    }

    private void loadAlbums() {
        queryWorker.execute(() -> {
            LinkedHashMap<String, Album> groups = new LinkedHashMap<>();
            Album all = new Album(null, "所有照片", null);
            String[] columns = { MediaStore.Images.Media._ID, MediaStore.Images.Media.BUCKET_ID, MediaStore.Images.Media.BUCKET_DISPLAY_NAME };
            try (Cursor cursor = activity.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, null, null, MediaStore.Images.Media.DATE_ADDED + " DESC")) {
                while (!disposed && cursor != null && cursor.moveToNext()) {
                    Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cursor.getLong(0));
                    String id = cursor.getString(1), name = cursor.getString(2);
                    if (all.cover == null) all.cover = uri;
                    all.count++;
                    Album group = groups.get(id);
                    if (group == null) { group = new Album(id, name == null || name.isEmpty() ? "其他照片" : name, uri); groups.put(id, group); }
                    group.count++;
                }
            } catch (Exception ignored) {}
            activity.runOnUiThread(() -> {
                if (disposed) return;
                albums.clear(); albums.add(all); albums.addAll(groups.values());
                albumAdapter.notifyDataSetChanged();
                if (showingAlbums) updateEmpty();
            });
        });
    }

    private void updateEmpty() {
        boolean noItems = showingAlbums ? albums.isEmpty() : photos.isEmpty();
        empty.setText(loading ? "正在读取相册…" : "这个相册还没有图片\n也可以从文件或系统相册中选择");
        empty.setVisibility(noItems ? View.VISIBLE : View.GONE);
    }

    private void toggleSelection(Photo photo) {
        String key = photo.uri.toString();
        if (selected.containsKey(key)) selected.remove(key);
        else if (selected.size() < limit) selected.put(key, photo.uri);
        else { Toast.makeText(activity, "最多还能添加 " + limit + " 张参考图", Toast.LENGTH_SHORT).show(); return; }
        updateSelection();
        photoAdapter.notifyDataSetChanged();
        refreshGridAccessibility();
    }

    /** Notify TalkBack/UiAutomation after asynchronous GridView data changes. */
    private void refreshGridAccessibility() {
        if (grid == null) return;
        grid.post(() -> {
            if (!disposed) {
                grid.requestLayout();
                grid.invalidate();
                grid.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
            }
        });
    }

    private void updateSelection() {
        count.setText("已选 " + selected.size() + " / " + limit);
        count.setGravity(Gravity.CENTER_VERTICAL);
        confirm.setText(selected.isEmpty() ? "添加" : "添加（" + selected.size() + "）");
        confirm.setEnabled(!selected.isEmpty());
        confirm.setAlpha(selected.isEmpty() ? .45f : 1f);
    }

    private void bindThumbnail(ImageView image, Uri uri) {
        String key = uri == null ? "" : uri.toString();
        image.setTag(key);
        image.setImageDrawable(null);
        Bitmap known = cache.get(key);
        if (known != null) { image.setImageBitmap(known); return; }
        if (uri == null || disposed) return;
        try { thumbnailWorkers.execute(() -> {
            if (disposed || !key.equals(image.getTag())) return;
            Bitmap bitmap = cache.get(key);
            if (bitmap == null) {
                try {
                    if (Build.VERSION.SDK_INT >= 29) bitmap = activity.getContentResolver().loadThumbnail(uri, new Size(256, 256), null);
                    else {
                        BitmapFactory.Options options = new BitmapFactory.Options();
                        options.inJustDecodeBounds = true;
                        try (InputStream stream = activity.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(stream, null, options); }
                        options.inJustDecodeBounds = false;
                        options.inSampleSize = 1;
                        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 512) options.inSampleSize *= 2;
                        try (InputStream stream = activity.getContentResolver().openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(stream, null, options); }
                    }
                    if (bitmap != null) cache.put(key, bitmap);
                } catch (Exception ignored) {}
            }
            Bitmap result = bitmap;
            activity.runOnUiThread(() -> { if (!disposed && key.equals(image.getTag()) && result != null) image.setImageBitmap(result); });
        }); } catch (RejectedExecutionException ignored) {}
    }

    private final class PhotoAdapter extends BaseAdapter {
        public int getCount() { return photos.size(); }
        public Object getItem(int position) { return photos.get(position); }
        public long getItemId(int position) { return position; }
        public View getView(int position, View recycled, ViewGroup parent) {
            FrameLayout cell;
            if (recycled instanceof FrameLayout) cell = (FrameLayout) recycled;
            else {
                cell = new FrameLayout(activity);
                cell.setBackgroundColor(Color.rgb(48, 48, 48));
                ImageView image = new ImageView(activity);
                image.setScaleType(ImageView.ScaleType.CENTER_CROP);
                image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                cell.addView(image, new FrameLayout.LayoutParams(-1, -1));
                TextView mark = label("", 16, TEXT);
                mark.setGravity(Gravity.CENTER);
                mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                FrameLayout.LayoutParams badge = new FrameLayout.LayoutParams(dp(30), dp(30), Gravity.TOP | Gravity.RIGHT);
                badge.setMargins(0, dp(8), dp(8), 0);
                cell.addView(mark, badge);
            }
            int width = grid.getColumnWidth();
            if (width <= 0) width = activity.getResources().getDisplayMetrics().widthPixels / grid.getNumColumns();
            cell.setLayoutParams(new AbsListView.LayoutParams(-1, width));
            Photo photo = photos.get(position);
            cell.setContentDescription(photo.name);
            cell.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
            cell.setFocusable(false);
            cell.setClickable(false);
            cell.setEnabled(true);
            bindThumbnail((ImageView) cell.getChildAt(0), photo.uri);
            int index = new ArrayList<>(selected.keySet()).indexOf(photo.uri.toString());
            TextView badge = (TextView) cell.getChildAt(1);
            badge.setText(index < 0 ? "" : String.valueOf(index + 1));
            GradientDrawable background = round(index < 0 ? 0x55000000 : Color.rgb(116, 164, 232), 15);
            background.setStroke(dp(2), Color.WHITE);
            badge.setBackground(background);
            cell.setSelected(index >= 0);
            return cell;
        }
    }

    private final class AlbumAdapter extends BaseAdapter {
        public int getCount() { return albums.size(); }
        public Object getItem(int position) { return albums.get(position); }
        public long getItemId(int position) { return position; }
        public View getView(int position, View recycled, ViewGroup parent) {
            LinearLayout row;
            if (recycled instanceof LinearLayout) row = (LinearLayout) recycled;
            else {
                row = row();
                row.setPadding(dp(18), dp(10), dp(18), dp(10));
                ImageView cover = new ImageView(activity);
                cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
                cover.setBackground(round(Color.rgb(45, 45, 45), 9));
                cover.setClipToOutline(true);
                row.addView(cover, new LinearLayout.LayoutParams(dp(78), dp(78)));
                LinearLayout labels = new LinearLayout(activity);
                labels.setOrientation(LinearLayout.VERTICAL);
                labels.setPadding(dp(18), 0, 0, 0);
                labels.addView(label("", 18, TEXT));
                labels.addView(label("", 14, MUTED));
                row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
            }
            Album album = albums.get(position);
            row.setContentDescription(album.name);
            bindThumbnail((ImageView) row.getChildAt(0), album.cover);
            LinearLayout labels = (LinearLayout) row.getChildAt(1);
            ((TextView) labels.getChildAt(0)).setText(album.name);
            ((TextView) labels.getChildAt(1)).setText(album.count + " 张");
            return row;
        }
    }

    @Override public void onBackPressed() {
        if (showingAlbums) showAlbums(false);
        else if (expanded) setExpanded(false);
        else cancel();
    }

    void dismissQuietly() { handled = true; dismiss(); }

    @Override public void dismiss() {
        if (!disposed) {
            disposed = true;
            queryVersion++;
            queryWorker.shutdownNow();
            thumbnailWorkers.shutdownNow();
            cache.evictAll();
        }
        super.dismiss();
        if (!handled) { handled = true; listener.onSelected(null); }
    }

    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private LinearLayout row() { LinearLayout row = new LinearLayout(activity); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); return row; }
    private TextView label(String value, int sp, int color) { TextView view = new TextView(activity); view.setText(value); view.setTextSize(sp); view.setTextColor(color); return view; }
    private TextView button(String value, int sp, int id) { TextView view = label(value, sp, TEXT); view.setId(id); view.setGravity(Gravity.CENTER); view.setClickable(true); view.setFocusable(true); view.setMinHeight(dp(44)); return view; }
    private GradientDrawable round(int color, int radius) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable; }
    private static final class Photo { final Uri uri; final String name; Photo(Uri uri, String name) { this.uri = uri; this.name = name == null ? "照片" : name; } }
    private static final class Album { final String id, name; Uri cover; int count; Album(String id, String name, Uri cover) { this.id = id; this.name = name; this.cover = cover; } }
}
