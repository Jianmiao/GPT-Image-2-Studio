package com.jianmiao.imagestudio;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/** Offline response fixtures only. No provider address, API key, or live generation. */
public final class NativeApiParserTest {
    private static final String PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/i8sAAAAASUVORK5CYII=";
    private static int checks;
    private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); checks++; }
    private static Object parse(String body, String type) throws Exception {
        Map<String, String> headers = new HashMap<>(); headers.put("content-type", type);
        Method parser = NativeApi.class.getDeclaredMethod("parseResponse", RelayClient.Response.class); parser.setAccessible(true);
        try { return parser.invoke(null, new RelayClient.Response(200, headers, body.getBytes(StandardCharsets.UTF_8))); }
        catch (InvocationTargetException e) { throw (Exception) e.getCause(); }
    }
    private static List<?> images(Object parsed) throws Exception { Field field = parsed.getClass().getDeclaredField("images"); field.setAccessible(true); return (List<?>) field.get(parsed); }
    private static String imageField(Object image, String name) throws Exception { Field field = image.getClass().getDeclaredField(name); field.setAccessible(true); return (String) field.get(image); }
    private static String event(JSONObject data) { return "data: " + data + "\n\n"; }
    public static void main(String[] args) throws Exception {
        check(NativeApi.normalizeSize(" 1024 * 1536 ").equals("1024x1536"), "asterisk size notation");
        check(NativeApi.normalizeSize("1536 × 864").equals("1536x864"), "multiplication sign notation");
        check(NativeApi.normalizeBase("https://example.invalid/proxy/v1/images/edits").equals("https://example.invalid/proxy"), "normalize complete endpoint");
        Object plain = parse("{\"data\":[{\"b64_json\":\"" + PNG + "\"}]}", "application/json");
        check(images(plain).size() == 1, "standard Images JSON");
        String partial = event(NativeApi.object("type", "image_generation.partial_image", "b64_json", "A".repeat(96)));
        String complete = event(NativeApi.object("type", "image_generation.completed", "b64_json", PNG));
        Object streamed = parse(partial + complete + "data: [DONE]\n\n", "text/event-stream");
        check(images(streamed).size() == 1 && PNG.equals(imageField(images(streamed).get(0), "b64")), "completed replaces partial preview");
        check(images(parse(partial, "text/event-stream")).isEmpty(), "partial alone is not a completed image");
        Object nested = parse("{\"output\":[{\"type\":\"image_generation_call\",\"status\":\"completed\",\"result\":\"" + PNG + "\"}]}", "application/json");
        check(images(nested).size() == 1, "Responses nested image generation");
        String mark = "{\"choices\":[{\"message\":{\"content\":\"![result](https://example.invalid/generated?id=123)\"}}]}";
        check(images(parse(mark, "application/json")).size() == 1, "chat markdown image URL without extension");
        String delta1 = "data: {\"choices\":[{\"delta\":{\"content\":\"![result](https://example.invalid/\"}}]}\n\n";
        String delta2 = "data: {\"choices\":[{\"delta\":{\"content\":\"image.png)\"}}]}\n\n";
        check(images(parse(delta1 + delta2 + "data: [DONE]\n\n", "text/event-stream")).size() == 1, "split chat streaming markdown");
        String dupe = "{\"data\":[{\"b64_json\":\"" + PNG + "\"},{\"b64_json\":\"" + PNG + "\"}]}";
        check(images(parse(dupe, "application/json")).size() == 1, "duplicate final output deduplicated");
        try { parse("{\"error\":{\"message\":\"Rejected by moderation\",\"code\":\"content_policy_violation\"}}", "application/json"); throw new AssertionError("policy error not raised"); }
        catch (Exception e) { check(e.getMessage().contains("Rejected by moderation"), "policy rejection preserved"); }
        try { parse(event(NativeApi.object("type", "response.completed", "response", NativeApi.object("status", "incomplete"))), "text/event-stream"); throw new AssertionError("incomplete not rejected"); }
        catch (Exception e) { check(e.getMessage().contains("incomplete"), "incomplete task rejected"); }
        System.out.println("NativeApiParserTest: " + checks + " offline checks passed");
    }
}
