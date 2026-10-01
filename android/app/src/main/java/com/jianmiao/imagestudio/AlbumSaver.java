package com.jianmiao.imagestudio;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** Publishes already downloaded images to the system album without any network access. */
public final class AlbumSaver {
    public static final String ALBUM_NAME = "GPT Image 2";
    private static final String RELATIVE_PATH = "Pictures/" + ALBUM_NAME + "/";
    private static final Object SAVE_LOCK = new Object();
    private final Context context;

    public AlbumSaver(Context context) {
        this.context = context.getApplicationContext();
    }

    public String save(File source, String mime) throws IOException {
        synchronized (SAVE_LOCK) {
            validateSource(source, mime);
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    return saveScoped(source, mime, new AndroidMediaStore(context.getContentResolver()));
                }
                if (context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    throw new IOException("请允许存储权限，以便自动保存到相册");
                }
                File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ALBUM_NAME);
                File destination = saveLegacyFile(source, directory);
                MediaScannerConnection.scanFile(context, new String[] {destination.getAbsolutePath()}, new String[] {mime}, null);
                return destination.toURI().toString();
            } catch (SecurityException e) {
                throw new IOException("没有相册写入权限，请检查系统权限设置", e);
            } catch (RuntimeException e) {
                throw new IOException("相册保存失败，请手动保存图片", e);
            }
        }
    }

    interface MediaStoreAccess {
        String findPublished(String name, long size) throws IOException;
        String insertPending(String name, String mime) throws IOException;
        OutputStream open(String uri) throws IOException;
        void publish(String uri) throws IOException;
        void delete(String uri) throws IOException;
    }

    static String saveScoped(File source, String mime, MediaStoreAccess store) throws IOException {
        validateSource(source, mime);
        String existing = store.findPublished(source.getName(), source.length());
        if (existing != null) return existing;
        String uri = store.insertPending(source.getName(), mime);
        if (uri == null) throw new IOException("无法在相册中创建图片");
        try {
            try (OutputStream output = store.open(uri)) {
                if (output == null) throw new IOException("无法写入相册图片");
                copy(source, output);
            }
            // Publish only after both streams close, so the gallery never sees partial images.
            store.publish(uri);
            return uri;
        } catch (IOException | RuntimeException failure) {
            try { store.delete(uri); }
            catch (IOException | RuntimeException cleanup) { failure.addSuppressed(cleanup); }
            throw new IOException("相册保存失败，请手动保存图片", failure);
        }
    }

    static File saveLegacyFile(File source, File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建相册文件夹");
        File destination = new File(directory, source.getName());
        if (destination.exists()) {
            if (destination.isFile() && destination.length() == source.length()) return destination;
            throw new IOException("相册中存在同名文件，请手动另存图片");
        }
        File temporary = File.createTempFile(".image-", ".tmp", directory);
        try {
            try (OutputStream output = new FileOutputStream(temporary)) { copy(source, output); }
            if (!temporary.renameTo(destination)) throw new IOException("无法完成相册图片保存");
            return destination;
        } finally {
            if (temporary.exists()) temporary.delete();
        }
    }

    private static void validateSource(File source, String mime) throws IOException {
        if (source == null || !source.isFile() || source.length() == 0) throw new IOException("本地图片尚未保存完成");
        if (mime == null || !mime.startsWith("image/")) throw new IOException("无法识别图片格式");
    }

    private static void copy(File source, OutputStream output) throws IOException {
        try (FileInputStream input = new FileInputStream(source)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
    }

    private static final class AndroidMediaStore implements MediaStoreAccess {
        private final ContentResolver resolver;
        AndroidMediaStore(ContentResolver resolver) { this.resolver = resolver; }

        public String findPublished(String name, long size) throws IOException {
            String where = MediaStore.Images.Media.DISPLAY_NAME + "=? AND " + MediaStore.Images.Media.RELATIVE_PATH
                    + "=? AND " + MediaStore.Images.Media.IS_PENDING + "=0 AND " + MediaStore.Images.Media.SIZE + "=?";
            try (Cursor cursor = resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[] {MediaStore.Images.Media._ID}, where,
                    new String[] {name, RELATIVE_PATH, Long.toString(size)}, null)) {
                if (cursor == null) throw new IOException("无法读取相册，请稍后重试");
                return cursor.moveToFirst() ? ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cursor.getLong(0)).toString() : null;
            }
        }

        public String insertPending(String name, String mime) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            values.put(MediaStore.Images.Media.MIME_TYPE, mime);
            values.put(MediaStore.Images.Media.RELATIVE_PATH, RELATIVE_PATH);
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            return uri == null ? null : uri.toString();
        }

        public OutputStream open(String uri) throws IOException { return resolver.openOutputStream(Uri.parse(uri), "w"); }

        public void publish(String uri) throws IOException {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (resolver.update(Uri.parse(uri), values, null, null) != 1) throw new IOException("相册图片发布失败");
        }

        public void delete(String uri) throws IOException {
            if (resolver.delete(Uri.parse(uri), null, null) != 1) throw new IOException("相册临时图片清理失败");
        }
    }
}
