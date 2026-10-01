package com.jianmiao.imagestudio;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/** Offline storage transaction checks; never loads device settings or calls a relay. */
public final class AlbumSaverTest {
    private static int checks;
    private static final byte[] IMAGE = { (byte) 137, 80, 78, 71, 13, 10, 26, 10 };
    private interface Throwing { void run() throws Exception; }

    private static final class Store implements AlbumSaver.MediaStoreAccess {
        final List<String> events = new ArrayList<>();
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        String fail = "", existing;
        boolean closed;
        public String findPublished(String name, long size) throws IOException {
            events.add("find");
            if (fail.equals("find")) throw new IOException("read unavailable");
            return existing;
        }
        public String insertPending(String name, String mime) throws IOException {
            events.add("insert");
            if (fail.equals("insert")) throw new IOException("full");
            return fail.equals("null-insert") ? null : "content://fake/1";
        }
        public OutputStream open(String uri) throws IOException {
            events.add("open");
            if (fail.equals("open")) throw new IOException("open failed");
            if (fail.equals("null-open")) return null;
            return new OutputStream() {
                public void write(int value) throws IOException {
                    if (fail.equals("write")) throw new IOException("disk full");
                    bytes.write(value);
                }
                public void close() throws IOException {
                    closed = true;
                    events.add("close");
                    if (fail.equals("close")) throw new IOException("close failed");
                }
            };
        }
        public void publish(String uri) throws IOException {
            check(closed, "output must close before publishing");
            events.add("publish");
            if (fail.equals("publish")) throw new IOException("publish failed");
            if (fail.equals("permission")) throw new SecurityException("revoked");
            existing = uri;
        }
        public void delete(String uri) throws IOException {
            events.add("delete");
            if (fail.equals("permission")) throw new IOException("cleanup unavailable");
        }
    }

    public static void main(String[] args) throws Exception {
        Path temp = Files.createTempDirectory("image-album-offline-");
        try {
            File source = temp.resolve("unique-image.png").toFile();
            Files.write(source.toPath(), IMAGE);
            Store success = new Store();
            check("content://fake/1".equals(AlbumSaver.saveScoped(source, "image/png", success)), "returns published image");
            check(Arrays.equals(IMAGE, success.bytes.toByteArray()), "keeps original image bytes");
            check(success.events.equals(List.of("find", "insert", "open", "close", "publish")), "publishes completed write once");
            AlbumSaver.saveScoped(source, "image/png", success);
            check(success.events.equals(List.of("find", "insert", "open", "close", "publish", "find")), "repeat save reuses published item");

            for (String fail : List.of("open", "null-open", "write", "close", "publish", "permission")) {
                Store broken = new Store();
                broken.fail = fail;
                IOException failure = fails(() -> AlbumSaver.saveScoped(source, "image/png", broken));
                check(broken.events.get(broken.events.size() - 1).equals("delete"), fail + " cleans pending item");
                check(broken.existing == null, fail + " leaves no completed item");
                if (fail.equals("permission")) check(failure.getCause().getSuppressed().length == 1, "preserves cleanup error without hiding primary failure");
            }
            for (String fail : List.of("find", "insert", "null-insert")) {
                Store broken = new Store();
                broken.fail = fail;
                fails(() -> AlbumSaver.saveScoped(source, "image/png", broken));
                check(!broken.events.contains("delete"), "does not delete an item it did not create");
            }
            Store invalid = new Store();
            fails(() -> AlbumSaver.saveScoped(temp.resolve("missing.png").toFile(), "image/png", invalid));
            fails(() -> AlbumSaver.saveScoped(source, "text/plain", invalid));
            check(invalid.events.isEmpty(), "invalid input never creates an album item");

            File album = temp.resolve("Pictures/GPT Image 2").toFile();
            File published = AlbumSaver.saveLegacyFile(source, album);
            check(Arrays.equals(IMAGE, Files.readAllBytes(published.toPath())), "legacy write preserves bytes");
            check(published.equals(AlbumSaver.saveLegacyFile(source, album)), "legacy repeat save reuses file");
            check(album.list().length == 1, "legacy leaves only one published image");
            Files.write(published.toPath(), new byte[] {1});
            fails(() -> AlbumSaver.saveLegacyFile(source, album));
            check(Files.readAllBytes(published.toPath())[0] == 1, "legacy does not overwrite conflicting image");
            fails(() -> AlbumSaver.saveLegacyFile(temp.resolve("disappeared.png").toFile(), album));
            check(album.list().length == 1, "legacy read failure removes partial file");
            System.out.println("AlbumSaverTest: " + checks + " offline checks passed");
        } finally {
            try (var paths = Files.walk(temp)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static IOException fails(Throwing action) throws Exception {
        try { action.run(); }
        catch (IOException failure) { checks++; return failure; }
        throw new AssertionError("Expected IOException");
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
}
