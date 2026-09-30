package android.util;

/** Test-only JVM shim. The Android app uses the platform implementation. */
public final class Base64 {
    public static final int DEFAULT = 0, NO_WRAP = 2;
    public static String encodeToString(byte[] input, int flags) { return java.util.Base64.getEncoder().encodeToString(input); }
    public static byte[] decode(String input, int flags) { return java.util.Base64.getMimeDecoder().decode(input); }
}
