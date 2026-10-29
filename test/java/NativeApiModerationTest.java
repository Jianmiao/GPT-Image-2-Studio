package com.jianmiao.imagestudio;

import android.content.SharedPreferences;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real native requests against loopback only, with in-memory preferences and a fictional key. */
public final class NativeApiModerationTest {
    private static final String KEY = "sk-local-moderation-test-only";
    private static final String IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/i8sAAAAASUVORK5CYII=";
    private static int checks;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }

    private static Object invoke(NativeApi api, String name, JSONObject... args) throws Exception {
        Method method = NativeApi.class.getDeclaredMethod(name, args.length == 0 ? new Class<?>[0] : new Class<?>[] {JSONObject.class});
        method.setAccessible(true);
        try { return method.invoke(api, (Object[]) args); }
        catch (InvocationTargetException e) { throw (Exception) e.getCause(); }
    }

    private static NativeApi api(String savedConfig) throws Exception {
        // Skip the Android constructor so the test cannot open device preferences, files or albums.
        Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
        Field unsafeField = unsafeClass.getDeclaredField("theUnsafe");
        unsafeField.setAccessible(true);
        Object unsafe = unsafeField.get(null);
        NativeApi api = (NativeApi) unsafeClass.getMethod("allocateInstance", Class.class).invoke(unsafe, NativeApi.class);
        Field relay = NativeApi.class.getDeclaredField("relay");
        relay.setAccessible(true);
        relay.set(api, new RelayClient());
        SharedPreferences prefs = (SharedPreferences) Proxy.newProxyInstance(SharedPreferences.class.getClassLoader(),
            new Class<?>[] {SharedPreferences.class}, (proxy, method, args) -> {
                if (method.getName().equals("getString") && args[0].equals("config")) return savedConfig;
                throw new AssertionError("Unexpected preference access: " + method.getName());
            });
        Field preferences = NativeApi.class.getDeclaredField("prefs");
        preferences.setAccessible(true);
        preferences.set(api, prefs);
        return api;
    }

    private static final class Request {
        final String path, type, body, authorization;
        Request(String path, String type, String body, String authorization) {
            this.path = path; this.type = type; this.body = body; this.authorization = authorization;
        }
        JSONObject json() throws Exception { return new JSONObject(body); }
    }

    private static final class LocalRelay implements AutoCloseable {
        final HttpServer server;
        final List<Request> requests = new ArrayList<>();
        LocalRelay() throws Exception {
            server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
            server.createContext("/", exchange -> {
                requests.add(new Request(exchange.getRequestURI().getPath(), exchange.getRequestHeaders().getFirst("Content-Type"),
                    new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8), exchange.getRequestHeaders().getFirst("Authorization")));
                byte[] rejection = "{\"error\":{\"message\":\"Local policy rejection\",\"code\":\"content_policy_violation\"}}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(400, rejection.length);
                try (var output = exchange.getResponseBody()) { output.write(rejection); }
            });
            server.start();
        }
        Request generate(NativeApi api, JSONObject options) throws Exception {
            JSONObject cfg = (JSONObject) invoke(api, "config");
            for (String key : options.keySet()) cfg.put(key, options.get(key));
            cfg.put("baseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            cfg.put("apiKey", KEY);
            cfg.put("proxy", "off");
            cfg.put("allowPrivateHost", true);
            cfg.put("prompt", "A landscape painting, local request fixture");
            int before = requests.size();
            try { invoke(api, "generate", cfg); throw new AssertionError("Local rejection must propagate"); }
            catch (Exception e) { check("Local policy rejection".equals(e.getMessage()), "upstream moderation rejection is preserved"); }
            check(requests.size() == before + 1, "policy rejection sends one request with no retry");
            Request request = requests.get(before);
            check(("Bearer " + KEY).equals(request.authorization), "only the fictional test key is sent");
            return request;
        }
        public void close() { server.stop(0); }
    }

    public static void main(String[] args) throws Exception {
        NativeApi fresh = api("{}");
        try (LocalRelay relay = new LocalRelay()) {
            Request response = relay.generate(fresh, NativeApi.object("method", "responses", "moderation", "low"));
            check(response.path.equals("/v1/responses"), "Responses endpoint");
            check(response.json().getJSONArray("tools").getJSONObject(0).optString("moderation").equals("low"), "Responses image_generation tool must forward low moderation");
            check(!response.json().has("moderation"), "Responses moderation belongs to the tool, not the request root");

            Request refs = relay.generate(fresh, NativeApi.object("method", "responses", "moderation", "low", "images", new JSONArray().put(IMAGE)));
            check(refs.json().getJSONArray("tools").getJSONObject(0).optString("moderation").equals("low"), "Responses with references forwards low moderation");

            Request image = relay.generate(fresh, NativeApi.object("method", "images", "moderation", "low"));
            check(image.path.equals("/v1/images/generations") && image.json().optString("moderation").equals("low"), "Images JSON forwards low moderation");
            Request alias = relay.generate(fresh, NativeApi.object("method", "images", "model", "GPT-Image-2-vip", "moderation", "low"));
            check(alias.json().optString("moderation").equals("low"), "GPT Image aliases forward low moderation regardless of casing");
            Request legacy = relay.generate(fresh, NativeApi.object("method", "images", "model", "dall-e-3", "moderation", "low"));
            check(!legacy.json().has("moderation"), "non GPT Image models receive no unsupported moderation parameter");
            Request edit = relay.generate(fresh, NativeApi.object("method", "images", "moderation", "low", "images", new JSONArray().put(IMAGE)));
            check(edit.path.equals("/v1/images/edits") && edit.type.startsWith("multipart/form-data;"), "reference images use multipart edit requests");
            check(edit.body.contains("name=\"moderation\"\r\n\r\nlow\r\n"), "multipart edits forward low moderation");
            Request jsonEdit = relay.generate(fresh, NativeApi.object("method", "images", "moderation", "low", "editEndpoint", "json", "images", new JSONArray().put(IMAGE)));
            check(jsonEdit.json().optString("moderation").equals("low"), "JSON edits forward low moderation");

            Request chat = relay.generate(fresh, NativeApi.object("method", "chat", "moderation", "low"));
            check(chat.path.equals("/v1/chat/completions") && !chat.json().has("moderation"), "Chat receives no unsupported moderation parameter");

            NativeApi savedAuto = api("{\"moderation\":\"auto\"}");
            for (String method : new String[] {"images", "responses"}) {
                Request automatic = relay.generate(savedAuto, NativeApi.object("method", method));
                JSONObject target = method.equals("responses") ? automatic.json().getJSONArray("tools").getJSONObject(0) : automatic.json();
                check(!target.has("moderation"), "saved auto keeps provider default for " + method);
                Request unknown = relay.generate(fresh, NativeApi.object("method", method, "moderation", "unsupported-mode"));
                JSONObject unknownTarget = method.equals("responses") ? unknown.json().getJSONArray("tools").getJSONObject(0) : unknown.json();
                check(!unknownTarget.has("moderation"), "unknown moderation values are omitted for " + method);
            }

            for (String method : new String[] {"images", "responses"}) {
                Request defaults = relay.generate(fresh, NativeApi.object("method", method));
                JSONObject target = method.equals("responses") ? defaults.json().getJSONArray("tools").getJSONObject(0) : defaults.json();
                check(target.optString("moderation").equals("low"), "new configuration defaults to low for " + method);
            }
        }
        System.out.println("NativeApiModerationTest: " + checks + " local-only checks passed");
    }
}
