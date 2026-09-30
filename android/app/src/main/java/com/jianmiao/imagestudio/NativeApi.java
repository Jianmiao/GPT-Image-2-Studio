package com.jianmiao.imagestudio;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Native equivalents of the desktop API. All network calls run off the UI thread. */
public final class NativeApi {
    private final SharedPreferences prefs;
    private final File gallery;
    private final AtomicFile history;
    private final Object historyLock = new Object();
    private final RelayClient relay = new RelayClient();
    private final AtomicBoolean generating = new AtomicBoolean(false);
    private final java.util.concurrent.ConcurrentHashMap<String, String> remoteSources = new java.util.concurrent.ConcurrentHashMap<>();
    private static final String[] BUILTIN = {"gpt-image-2", "gpt-image-2-auto", "gpt-image-2.5-auto", "gpt-image-1.5", "gpt-image-1", "dall-e-3"};
    private static final Set<String> CONFIG_KEYS = new HashSet<>(java.util.Arrays.asList("providerName", "baseUrl", "apiKey", "model", "size", "quality", "count", "background", "outputFormat", "method", "editEndpoint", "timeoutSeconds", "moderation", "proxy", "allowPrivateHost", "streamUpstream"));
    private static final Pattern DATA_IMAGE = Pattern.compile("^data:(image/[a-zA-Z0-9.+-]+);base64,([\\s\\S]+)$");
    private static final Pattern MARKDOWN_IMAGE = Pattern.compile("!\\[[^\\]]*\\]\\((https?://[^)\\s]+|data:image/[^)\\s]+)\\)");
    private static final Pattern IMAGE_MODEL = Pattern.compile("gpt.?image|dall.?e|image|flux|seedream|nano.?banana|ideogram|recraft|stable.?diffusion", Pattern.CASE_INSENSITIVE);

    public NativeApi(Context context) {
        prefs = context.getSharedPreferences("image-studio-private", Context.MODE_PRIVATE);
        gallery = new File(context.getFilesDir(), "gallery");
        if (!gallery.exists()) gallery.mkdirs();
        history = new AtomicFile(new File(context.getFilesDir(), "history.json"));
    }
    public static final class Result {
        public final int status; public final JSONObject body;
        Result(int status, JSONObject body) { this.status = status; this.body = body; }
    }
    public static final class Download {
        public final String name, mime; public final byte[] bytes;
        Download(String name, String mime, byte[] bytes) { this.name = name; this.mime = mime; this.bytes = bytes; }
    }
    private static final class ApiFailure extends Exception {
        final int status; final String raw, requestId, source, code;
        ApiFailure(int status, String message, String raw, String requestId, String source, String code) {
            super(message); this.status = status; this.raw = raw; this.requestId = requestId; this.source = source; this.code = code;
        }
    }
    private static final class ImageResult {
        final String b64, url, mime;
        ImageResult(String b64, String url, String mime) { this.b64 = b64; this.url = url; this.mime = mime; }
    }
    static JSONObject object(Object... pairs) {
        JSONObject out = new JSONObject();
        try { for (int i = 0; i + 1 < pairs.length; i += 2) out.put(String.valueOf(pairs[i]), pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]); }
        catch (Exception e) { throw new IllegalArgumentException(e); }
        return out;
    }
    public Result handle(JSONObject request) {
        JSONObject input = new JSONObject();
        String path = request.optString("path", ""), method = request.optString("method", "GET").toUpperCase(Locale.ROOT);
        try {
            Object body = request.opt("body");
            if (body instanceof JSONObject) input = (JSONObject) body;
            else if (body instanceof String && !((String) body).trim().isEmpty()) input = new JSONObject((String) body);
            Uri uri = Uri.parse(path);
            if (!path.startsWith("/api/") || uri.getHost() != null) return new Result(403, object("error", "拒绝非本地 API 请求"));
            String route = method + " " + uri.getPath();
            switch (route) {
                case "GET /api/health": return new Result(200, object("ok", true, "platform", "android", "version", "1.1.0"));
                case "GET /api/config": return new Result(200, publicConfig(config()));
                case "POST /api/config": return new Result(200, saveConfig(input));
                case "POST /api/endpoints": return new Result(200, endpoints(merged(input)));
                case "POST /api/models": return new Result(200, redact(models(merged(input)), input));
                case "POST /api/test": return new Result(200, redact(testConnection(merged(input)), input));
                case "GET /api/history": return new Result(200, object("items", readHistory()));
                case "DELETE /api/history": return new Result(200, object("ok", true, "items", removeHistory(uri.getQueryParameter("id"))));
                case "POST /api/generate":
                    if (!generating.compareAndSet(false, true)) return new Result(409, object("error", "已有生成任务在运行，请等待当前任务完成。没有重复提交。"));
                    try { return new Result(200, object("ok", true, "item", generate(merged(input)))); }
                    finally { generating.set(false); }
                default: return new Result(404, object("error", "未找到本地接口"));
            }
        } catch (ApiFailure e) {
            JSONObject out = object("error", e.getMessage(), "raw", e.raw, "requestId", e.requestId,
                "source", e.source, "errorSource", e.source, "code", e.code, "status", e.status);
            if (path.startsWith("/api/generate")) outPut(out, "attempts", new JSONArray().put(object("method", input.optString("method", "images"), "ok", false, "error", e.getMessage())));
            return new Result(e.status >= 400 && e.status < 600 ? e.status : 502, redact(out, input));
        } catch (Exception e) {
            String message = e.getMessage() == null ? "请求失败" : e.getMessage();
            JSONObject out = object("error", message, "source", e instanceof IOException ? "network" : "local", "raw", "");
            if (path.startsWith("/api/generate")) {
                outPut(out, "error", message + " 本工具没有自动重发；再次生成前请先核对供应商任务记录。");
                outPut(out, "attempts", new JSONArray().put(object("method", input.optString("method", "images"), "ok", false, "error", message)));
            }
            return new Result(e instanceof IOException ? 502 : 400, redact(out, input));
        }
    }
    private static void outPut(JSONObject obj, String key, Object value) { try { obj.put(key, value); } catch (Exception ignored) {} }
    private JSONObject redact(JSONObject data, JSONObject input) {
        String text = data.toString();
        for (String key : new String[]{input.optString("apiKey", ""), config().optString("apiKey", "")}) {
            if (!key.isEmpty()) { String escaped = JSONObject.quote(key); text = text.replace(escaped.substring(1, escaped.length() - 1), "[已隐藏密钥]"); }
        }
        try { return new JSONObject(text); } catch (Exception ignored) { return object("error", "请求失败"); }
    }
    private synchronized JSONObject config() {
        JSONObject out = object("providerName", "", "baseUrl", "https://api.openai.com", "apiKey", "", "model", "gpt-image-2", "size", "1024x1024",
            "quality", "high", "background", "auto", "outputFormat", "auto", "count", 1, "method", "auto", "editEndpoint", "auto",
            "timeoutSeconds", 600, "moderation", "auto", "streamUpstream", false, "proxy", "auto", "allowPrivateHost", true);
        try { merge(out, new JSONObject(prefs.getString("config", "{}"))); } catch (Exception ignored) {}
        return out;
    }
    private JSONObject merged(JSONObject input) { JSONObject cfg = config(); merge(cfg, input); return cfg; }
    private static void merge(JSONObject into, JSONObject from) { Iterator<String> keys = from.keys(); while (keys.hasNext()) { String k = keys.next(); outPut(into, k, from.opt(k)); } }
    private static JSONObject publicConfig(JSONObject cfg) {
        String key = cfg.optString("apiKey", "");
        outPut(cfg, "apiKey", ""); outPut(cfg, "hasApiKey", !key.isEmpty());
        outPut(cfg, "apiKeyMasked", key.isEmpty() ? "" : key.length() <= 10 ? key.substring(0, Math.min(2, key.length())) + "****" : key.substring(0, 6) + "…" + key.substring(key.length() - 4));
        return cfg;
    }
    private synchronized JSONObject saveConfig(JSONObject patch) throws Exception {
        JSONObject cfg = config();
        Iterator<String> keys = patch.keys();
        while (keys.hasNext()) {
            String key = keys.next(); if (!CONFIG_KEYS.contains(key)) continue;
            if (key.equals("apiKey") && (patch.optString(key).trim().isEmpty() || patch.optString(key).matches("\\*+"))) continue;
            cfg.put(key, patch.get(key));
        }
        cfg.put("size", normalizeSize(cfg.optString("size", "1024x1024")));
        if (!prefs.edit().putString("config", cfg.toString()).commit()) throw new IOException("无法保存本机设置");
        return publicConfig(cfg);
    }
    static String normalizeBase(String input) throws Exception {
        String raw = input.trim(); if (raw.isEmpty()) throw new IllegalArgumentException("请先填写供应商地址");
        if (!raw.matches("(?i)^https?://.*")) raw = "https://" + raw;
        URI uri = new URI(raw);
        if (uri.getHost() == null || uri.getUserInfo() != null || !("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))) throw new IllegalArgumentException("供应商地址格式不正确");
        String path = uri.getRawPath() == null ? "" : uri.getRawPath().replaceAll("/+$", "");
        path = path.replaceFirst("(?i)/v1/(images/generations|images/edits|models|chat/completions|responses)$", "").replaceFirst("(?i)/v1$", "");
        return uri.getScheme().toLowerCase(Locale.ROOT) + "://" + uri.getRawAuthority() + path;
    }
    static String normalizeSize(String value) {
        String size = value.trim().toLowerCase(Locale.ROOT).replaceAll("\\s*[*×x]\\s*", "x");
        if (size.equals("auto")) return size;
        if (!size.matches("\\d{2,5}x\\d{2,5}")) throw new IllegalArgumentException("分辨率格式应为宽x高，例如 1024*1536");
        String[] pair = size.split("x"); int w = Integer.parseInt(pair[0]), h = Integer.parseInt(pair[1]);
        if (w < 16 || h < 16 || w % 16 != 0 || h % 16 != 0) throw new IllegalArgumentException("分辨率宽高必须是 16 的倍数");
        return size;
    }
    private JSONObject endpoints(JSONObject cfg) throws Exception {
        String base = normalizeBase(cfg.optString("baseUrl", ""));
        String proxy = cfg.optString("proxy", "auto");
        return object("base", base, "models", base + "/v1/models", "generations", base + "/v1/images/generations", "edits", base + "/v1/images/edits",
            "responses", base + "/v1/responses", "chat", base + "/v1/chat/completions",
            "proxy", object("url", proxy.startsWith("http://") ? proxy : "", "source", proxy.equals("auto") ? "Android 系统网络 / VPN" : "手动设置"));
    }
    private JSONObject models(JSONObject cfg) throws Exception {
        String base = normalizeBase(cfg.optString("baseUrl", "")), key = cfg.optString("apiKey", "").trim();
        if (key.isEmpty()) throw new IllegalArgumentException("请先填写 API Key");
        String url = base + "/v1/models";
        try {
            RelayClient.Response res = relay.request(url, "GET", null, null, key, 30, cfg.optString("proxy", "auto"), cfg.optBoolean("allowPrivateHost", true));
            checkResponse(res);
            Object value = new JSONTokener(res.text()).nextValue();
            JSONArray list = value instanceof JSONArray ? (JSONArray) value : null;
            if (value instanceof JSONObject) {
                JSONObject obj = (JSONObject) value;
                list = obj.optJSONArray("data"); if (list == null) list = obj.optJSONArray("models"); if (list == null) list = obj.optJSONArray("result");
                if (list == null && obj.optJSONObject("data") != null) list = obj.optJSONObject("data").optJSONArray("models");
            }
            if (list == null) throw new IOException("模型接口未返回模型列表");
            Set<String> seen = new HashSet<>(); List<String> ids = new ArrayList<>(), images = new ArrayList<>();
            for (int i = 0; i < list.length(); i++) {
                Object model = list.opt(i); String id = "";
                if (model instanceof String) id = (String) model;
                if (model instanceof JSONObject) {
                    JSONObject item = (JSONObject) model;
                    for (String k : new String[]{"id", "model", "name", "slug"}) { id = item.optString(k, "").trim(); if (!id.isEmpty()) break; }
                }
                if (!id.isEmpty() && seen.add(id)) { ids.add(id); if (IMAGE_MODEL.matcher(id).find()) images.add(id); }
            }
            Comparator<String> sort = Comparator.comparingInt(NativeApi::modelRank).thenComparing(String::compareToIgnoreCase);
            Collections.sort(ids, sort); Collections.sort(images, sort);
            return object("ok", true, "source", "api", "url", url, "total", ids.size(), "models", new JSONArray(ids), "imageModels", new JSONArray(images));
        } catch (Exception e) {
            return object("ok", false, "source", "builtin", "url", url, "error", e.getMessage(), "advice", "可手动填写供应商支持的模型名称。", "total", BUILTIN.length,
                "models", new JSONArray(java.util.Arrays.asList(BUILTIN)), "imageModels", new JSONArray(java.util.Arrays.asList(BUILTIN)));
        }
    }
    private static int modelRank(String id) { String s = id.toLowerCase(Locale.ROOT); return s.startsWith("gpt-image-2") ? 0 : s.startsWith("gpt-image") ? 1 : IMAGE_MODEL.matcher(s).find() ? 2 : 3; }
    private JSONObject testConnection(JSONObject cfg) throws Exception {
        JSONObject result = models(cfg);
        return object("ok", result.optBoolean("ok"), "steps", new JSONArray().put(object("ok", result.optBoolean("ok"), "name", "GET /v1/models",
            "detail", result.optBoolean("ok") ? "已连接，找到 " + result.optInt("total") + " 个模型（未发送生图请求）" : result.optString("error"))),
            "imageModels", result.optBoolean("ok") ? result.optJSONArray("imageModels") : new JSONArray());
    }
    private static void checkResponse(RelayClient.Response res) throws ApiFailure {
        if (res.status >= 200 && res.status < 300) return;
        String raw = truncate(res.text(), 20000), message = "上游返回 HTTP " + res.status, code = "";
        try {
            JSONObject obj = new JSONObject(res.text()); JSONObject err = obj.optJSONObject("error");
            if (err != null) { message = err.optString("message", err.optString("code", message)); code = err.optString("code", ""); }
            else message = obj.optString("message", obj.optString("error", obj.optString("detail", message)));
        } catch (Exception ignored) { if (!raw.isEmpty()) message = raw; }
        if (res.status >= 300 && res.status < 400) message = "供应商返回重定向（HTTP " + res.status + "），为避免重复提交已停止。请在设置中使用最终接口地址。";
        throw new ApiFailure(res.status, message, raw, res.header("x-request-id"), "upstream", code);
    }
    private static String truncate(String text, int max) { return text.length() <= max ? text : text.substring(0, max) + "…"; }

    private JSONObject generate(JSONObject cfg) throws Exception {
        String base = normalizeBase(cfg.optString("baseUrl", "")), key = cfg.optString("apiKey", "").trim();
        String prompt = cfg.optString("prompt", "").trim(), model = cfg.optString("model", "").trim();
        if (key.isEmpty()) throw new IllegalArgumentException("请先在设置中填写 API Key");
        if (prompt.isEmpty()) throw new IllegalArgumentException("请输入提示词");
        if (model.isEmpty()) throw new IllegalArgumentException("请选择模型");
        String size = normalizeSize(cfg.optString("size", "1024x1024"));
        String method = cfg.optString("method", "auto"); if (method.equals("auto")) method = "images";
        int count = Math.max(1, Math.min(10, cfg.optInt("count", 1)));
        int timeout = Math.max(30, Math.min(3600, cfg.optInt("timeoutSeconds", 600)));
        JSONArray refs = cfg.optJSONArray("images"); if (refs == null) refs = new JSONArray();
        if (refs.length() > 10) throw new IllegalArgumentException("参考图最多 10 张");
        for (int i = 0; i < refs.length(); i++) {
            String image = refs.optString(i, "");
            if (!DATA_IMAGE.matcher(image).matches() || image.length() > 28 * 1024 * 1024) throw new IllegalArgumentException("参考图必须是小于 20 MB 的图片");
        }
        boolean stream = cfg.has("stream") ? cfg.optBoolean("stream") : cfg.optBoolean("streamUpstream");
        JSONObject body; String endpoint, label = method, contentType = "application/json"; byte[] bytes;
        if (method.equals("images")) {
            body = object("model", model, "prompt", prompt, "n", count, "size", size);
            option(body, cfg, "quality", "quality"); option(body, cfg, "background", "background"); option(body, cfg, "moderation", "moderation");
            if (model.toLowerCase(Locale.ROOT).startsWith("gpt-image")) option(body, cfg, "outputFormat", "output_format");
            if (stream) body.put("stream", true);
            endpoint = refs.length() > 0 ? "images/edits" : "images/generations";
            label = endpoint;
            if (refs.length() > 0 && !cfg.optString("editEndpoint", "auto").equals("json")) {
                String boundary = "----GPTImage2Android" + UUID.randomUUID().toString().replace("-", "");
                bytes = multipart(body, refs, boundary); contentType = "multipart/form-data; boundary=" + boundary;
                label += "·multipart";
            } else {
                if (refs.length() > 0) { body.put("image", refs.length() == 1 ? refs.getString(0) : refs); label += "·json"; }
                bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            }
        } else if (method.equals("chat")) {
            JSONArray content = new JSONArray().put(object("type", "text", "text", prompt));
            for (int i = 0; i < refs.length(); i++) content.put(object("type", "image_url", "image_url", object("url", refs.getString(i))));
            body = object("model", model, "messages", new JSONArray().put(object("role", "user", "content", content)), "stream", stream);
            endpoint = "chat/completions"; bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        } else if (method.equals("responses")) {
            JSONObject tool = object("type", "image_generation");
            if (!size.equals("auto")) tool.put("size", size);
            option(tool, cfg, "quality", "quality"); option(tool, cfg, "background", "background"); option(tool, cfg, "outputFormat", "output_format");
            body = object("model", model, "input", prompt, "tools", new JSONArray().put(tool), "stream", stream);
            if (refs.length() > 0) {
                JSONArray content = new JSONArray().put(object("type", "input_text", "text", prompt));
                for (int i = 0; i < refs.length(); i++) content.put(object("type", "input_image", "image_url", refs.getString(i)));
                body.put("input", new JSONArray().put(object("role", "user", "content", content)));
            }
            endpoint = "responses"; bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        } else throw new IllegalArgumentException("不支持的调用方式：" + method);
        if (bytes.length > 100 * 1024 * 1024) throw new IllegalArgumentException("参考图总大小过大，请减少参考图");
        long started = System.currentTimeMillis(); String id = UUID.randomUUID().toString();
        // Exactly one upstream POST. Never switch endpoint, body format, proxy, or retry.
        RelayClient.Response response = relay.request(base + "/v1/" + endpoint, "POST", bytes, contentType, key, timeout,
            cfg.optString("proxy", "auto"), cfg.optBoolean("allowPrivateHost", true));
        checkResponse(response);
        Parsed parsed = parseResponse(response);
        if (parsed.images.isEmpty()) throw new ApiFailure(502, "上游响应中没有完整图片。请核对供应商任务记录，本工具没有自动重发。",
            truncate(parsed.text, 12000), response.header("x-request-id"), "upstream", "no_image_result");
        JSONArray saved = new JSONArray();
        for (int i = 0; i < parsed.images.size(); i++) {
            ImageResult image = parsed.images.get(i);
            try { saved.put(persistImage(id, i, image, cfg)); }
            catch (Exception e) {
                // Retain recoverable generated data even if a download or disk write fails.
                if (image.url != null) {
                    String local = "/remote-image/" + id + "-" + i;
                    remoteSources.put(local, image.url);
                    saved.put(object("url", local, "sourceUrl", image.url, "remote", true, "mime", image.mime, "saveError", e.getMessage()));
                }
                else saved.put(object("url", "data:" + image.mime + ";base64," + image.b64, "inline", true, "mime", image.mime, "saveError", e.getMessage()));
            }
        }
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US); iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        JSONObject item = object("id", id, "createdAt", iso.format(new Date()), "elapsedMs", System.currentTimeMillis() - started,
            "model", model, "prompt", prompt, "size", size, "quality", cfg.optString("quality", "auto"), "background", cfg.optString("background", "auto"),
            "outputFormat", cfg.optString("outputFormat", "auto"), "count", saved.length(), "method", label, "usage", parsed.usage,
            "text", parsed.text, "hasRefs", refs.length() > 0, "refCount", refs.length(), "images", saved);
        try { addHistory(item); }
        catch (Exception e) { item.put("historyError", "图片已返回，但历史记录未能保存：" + e.getMessage()); }
        return item;
    }
    private static void option(JSONObject body, JSONObject cfg, String field, String wire) throws Exception { String value = cfg.optString(field, "auto"); if (!value.isEmpty() && !value.equals("auto")) body.put(wire, value); }
    private static byte[] multipart(JSONObject fields, JSONArray images, String boundary) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Iterator<String> keys = fields.keys();
        while (keys.hasNext()) { String key = keys.next(); write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + key + "\"\r\n\r\n" + fields.get(key) + "\r\n"); }
        for (int i = 0; i < images.length(); i++) {
            Matcher m = DATA_IMAGE.matcher(images.getString(i)); if (!m.matches()) throw new IllegalArgumentException("参考图编码无效");
            String mime = m.group(1); byte[] data = Base64.decode(m.group(2), Base64.DEFAULT);
            if (data.length > 20 * 1024 * 1024) throw new IllegalArgumentException("单张参考图不能超过 20 MB");
            write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"reference-" + (i + 1) + "." + extension(mime) + "\"\r\nContent-Type: " + mime + "\r\n\r\n");
            out.write(data); write(out, "\r\n");
        }
        write(out, "--" + boundary + "--\r\n"); return out.toByteArray();
    }
    private static void write(ByteArrayOutputStream out, String text) throws IOException { out.write(text.getBytes(StandardCharsets.UTF_8)); }

    static final class Parsed { final List<ImageResult> images = new ArrayList<>(); JSONObject usage; String text = ""; }
    private static Parsed parseResponse(RelayClient.Response response) throws Exception {
        Parsed out = new Parsed(); String raw = response.text().trim();
        if (response.header("content-type").toLowerCase(Locale.ROOT).startsWith("image/")) {
            out.images.add(new ImageResult(Base64.encodeToString(response.bytes, Base64.NO_WRAP), null, response.header("content-type").split(";")[0])); return out;
        }
        if (response.header("content-type").contains("text/event-stream") || raw.startsWith("data:") || raw.startsWith("event:") || raw.startsWith(":")) {
            StringBuilder text = new StringBuilder();
            for (String block : raw.split("\\r?\\n\\r?\\n")) {
                StringBuilder data = new StringBuilder(); String eventName = "";
                for (String line : block.split("\\r?\\n")) {
                    if (line.startsWith("data:")) { if (data.length() > 0) data.append('\n'); data.append(line.substring(5).trim()); }
                    else if (line.startsWith("event:")) eventName = line.substring(6).trim();
                }
                if (data.length() == 0 || data.toString().equals("[DONE]")) continue;
                JSONObject event;
                try { event = new JSONObject(data.toString()); } catch (Exception ignored) { continue; }
                checkEnvelope(event, response.header("x-request-id"));
                String type = event.optString("type", eventName).toLowerCase(Locale.ROOT);
                if (type.contains("error") || type.endsWith("failed")) throw new ApiFailure(502, event.optString("message", "上游流式任务失败"), truncate(event.toString(), 20000), response.header("x-request-id"), "upstream", "");
                // Partial previews must never be mistaken for a completed paid result.
                if (!type.contains("partial") && !type.contains("in_progress") && !type.endsWith(".delta")) extract(event, out.images, 0);
                appendChatDeltas(event, text);
                if (type.equals("response.output_text.delta")) text.append(event.optString("delta", ""));
                JSONObject usage = event.optJSONObject("usage");
                if (usage == null && event.optJSONObject("response") != null) usage = event.optJSONObject("response").optJSONObject("usage");
                if (usage != null) out.usage = usage;
            }
            out.text = text.toString(); extractTextImages(out.text, out.images);
        } else {
            Object value;
            try { value = new JSONTokener(raw).nextValue(); } catch (Exception e) { throw new ApiFailure(502, "上游返回了无法识别的内容", truncate(raw, 20000), response.header("x-request-id"), "upstream", "invalid_response"); }
            if (value instanceof JSONObject) {
                checkEnvelope((JSONObject) value, response.header("x-request-id"));
                out.usage = ((JSONObject) value).optJSONObject("usage");
                out.text = ((JSONObject) value).optString("output_text", "");
            }
            extract(value, out.images, 0);
        }
        LinkedHashMap<String, ImageResult> unique = new LinkedHashMap<>();
        for (ImageResult image : out.images) {
            String key = image.b64 != null ? Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(image.b64.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP) : image.url;
            unique.put(key, image);
        }
        out.images.clear(); out.images.addAll(unique.values());
        if (out.images.isEmpty() && out.text.isEmpty()) out.text = truncate(raw, 20000);
        return out;
    }
    private static void checkEnvelope(JSONObject obj, String requestId) throws ApiFailure {
        Object error = obj.opt("error"); JSONObject err = error instanceof JSONObject ? (JSONObject) error : null;
        if (error != null && error != JSONObject.NULL && !(error instanceof Boolean && !((Boolean) error))) {
            String msg = err == null ? String.valueOf(error) : err.optString("message", err.optString("code", "上游返回失败"));
            throw new ApiFailure(502, msg, truncate(obj.toString(), 20000), requestId, "upstream", err == null ? "" : err.optString("code", ""));
        }
        String status = obj.optString("status", "");
        if (status.equals("failed") || status.equals("cancelled") || status.equals("incomplete"))
            throw new ApiFailure(502, obj.optString("message", "上游任务未完成：" + status), truncate(obj.toString(), 20000), requestId, "upstream", status);
        if (obj.optJSONObject("response") != null) checkEnvelope(obj.optJSONObject("response"), requestId);
    }
    private static void appendChatDeltas(JSONObject event, StringBuilder text) {
        JSONArray choices = event.optJSONArray("choices"); if (choices == null) return;
        for (int i = 0; i < choices.length(); i++) {
            JSONObject choice = choices.optJSONObject(i); if (choice == null) continue;
            JSONObject delta = choice.optJSONObject("delta"); if (delta == null) continue;
            Object content = delta.opt("content"); if (content instanceof String) text.append((String) content);
        }
    }
    private static void extract(Object node, List<ImageResult> found, int depth) {
        if (node == null || node == JSONObject.NULL || depth > 12) return;
        if (node instanceof JSONArray) { JSONArray arr = (JSONArray) node; for (int i = 0; i < arr.length(); i++) extract(arr.opt(i), found, depth + 1); return; }
        if (node instanceof String) { extractTextImages((String) node, found); return; }
        if (!(node instanceof JSONObject)) return;
        JSONObject obj = (JSONObject) node; String type = obj.optString("type", ""), status = obj.optString("status", "");
        if (type.contains("partial") || type.contains("in_progress") || status.equals("in_progress") || status.equals("queued")) return;
        String mime = obj.optString("mime_type", obj.optString("mimeType", "image/png"));
        for (String key : new String[]{"b64_json", "image_base64", "base64", "b64"}) {
            Object value = obj.opt(key); if (value instanceof String && ((String) value).length() > 64) addBase64((String) value, mime, found);
        }
        for (String key : new String[]{"url", "image_url"}) { Object value = obj.opt(key); if (value instanceof String) addUrl((String) value, mime, found); }
        Object result = obj.opt("result");
        if (result instanceof String) {
            String value = (String) result;
            if (value.matches("[A-Za-z0-9+/=\\s]{64,}")) addBase64(value, mime, found);
            else addUrl(value, mime, found);
        }
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String key = keys.next(); if (java.util.Arrays.asList("b64_json", "image_base64", "base64", "b64", "url", "result").contains(key)) continue;
            Object value = obj.opt(key);
            if (value instanceof JSONObject || value instanceof JSONArray || ((key.equals("content") || key.equals("text") || key.equals("output_text")) && value instanceof String)) extract(value, found, depth + 1);
        }
    }
    private static void addBase64(String data, String mime, List<ImageResult> found) {
        Matcher m = DATA_IMAGE.matcher(data);
        if (m.matches()) found.add(new ImageResult(m.group(2).replaceAll("\\s", ""), null, m.group(1)));
        else found.add(new ImageResult(data.replaceAll("\\s", ""), null, mime));
    }
    private static void addUrl(String url, String mime, List<ImageResult> found) {
        if (url.startsWith("data:image/")) addBase64(url, mime, found);
        else if (url.matches("(?is)^https?://[^\\s]+$")) found.add(new ImageResult(null, url, mime));
    }
    private static void extractTextImages(String text, List<ImageResult> found) {
        if (text.startsWith("data:image/")) { addBase64(text, "image/png", found); return; }
        Matcher matcher = MARKDOWN_IMAGE.matcher(text); while (matcher.find()) addUrl(matcher.group(1), "image/png", found);
        if (text.trim().matches("(?is)^https?://[^\\s]+\\.(png|jpe?g|webp|gif)(\\?[^\\s]*)?$")) addUrl(text.trim(), "image/png", found);
    }
    private JSONObject persistImage(String id, int index, ImageResult image, JSONObject cfg) throws Exception {
        byte[] bytes;
        if (image.b64 != null) bytes = Base64.decode(image.b64, Base64.DEFAULT);
        else {
            RelayClient.Response r = relay.request(image.url, "GET", null, null, null, 90, cfg.optString("proxy", "auto"), cfg.optBoolean("allowPrivateHost", true));
            checkResponse(r); bytes = r.bytes;
        }
        String mime = imageMime(bytes); String name = id + "-" + index + "." + extension(mime);
        File file = new File(gallery, name);
        try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(bytes); }
        return object("url", "/gallery/" + name, "bytes", bytes.length, "mime", mime);
    }
    private static String extension(String mime) { return mime.contains("jpeg") || mime.contains("jpg") ? "jpg" : mime.contains("webp") ? "webp" : mime.contains("gif") ? "gif" : "png"; }
    private static String imageMime(byte[] b) throws IOException {
        if (b.length >= 8 && (b[0] & 255) == 137 && b[1] == 80 && b[2] == 78 && b[3] == 71) return "image/png";
        if (b.length >= 3 && (b[0] & 255) == 255 && (b[1] & 255) == 216 && (b[2] & 255) == 255) return "image/jpeg";
        if (b.length >= 6 && b[0] == 71 && b[1] == 73 && b[2] == 70) return "image/gif";
        if (b.length >= 12 && b[0] == 82 && b[1] == 73 && b[2] == 70 && b[3] == 70 && b[8] == 87 && b[9] == 69 && b[10] == 66 && b[11] == 80) return "image/webp";
        throw new IOException("返回内容不是受支持的 PNG、JPEG、WebP 或 GIF 图片");
    }
    public File galleryFile(String name) {
        if (name == null || !name.matches("[A-Za-z0-9_-]+\\.(png|jpg|jpeg|webp|gif)")) return null;
        File file = new File(gallery, name); return file.isFile() ? file : null;
    }
    private JSONArray readHistory() throws Exception {
        synchronized (historyLock) {
            if (!history.getBaseFile().exists()) return new JSONArray();
            try (FileInputStream in = history.openRead()) {
                JSONArray items = new JSONObject(new String(RelayClient.readAll(in, 150 * 1024 * 1024), StandardCharsets.UTF_8)).optJSONArray("items");
                return items == null ? new JSONArray() : items;
            }
        }
    }
    private void writeHistory(JSONArray items) throws Exception {
        FileOutputStream out = null;
        try { out = history.startWrite(); out.write(object("items", items).toString().getBytes(StandardCharsets.UTF_8)); history.finishWrite(out); }
        catch (Exception e) { if (out != null) history.failWrite(out); throw e; }
    }
    private void addHistory(JSONObject item) throws Exception {
        synchronized (historyLock) {
            JSONArray before = readHistory(), next = new JSONArray().put(item);
            for (int i = 0; i < before.length() && next.length() < 300; i++) next.put(before.get(i));
            writeHistory(next);
        }
    }
    private JSONArray removeHistory(String id) throws Exception {
        synchronized (historyLock) {
            JSONArray next = new JSONArray();
            if (id != null) {
                JSONArray before = readHistory(); for (int i = 0; i < before.length(); i++) if (!id.equals(before.getJSONObject(i).optString("id"))) next.put(before.get(i));
            }
            writeHistory(next); return next;
        }
    }
    private String knownRemoteSource(String localPath) {
        if (!localPath.matches("/remote-image/[a-zA-Z0-9_-]+")) return null;
        String cached = remoteSources.get(localPath); if (cached != null) return cached;
        try {
            JSONArray items = readHistory();
            for (int i = 0; i < items.length(); i++) {
                JSONArray images = items.getJSONObject(i).optJSONArray("images"); if (images == null) continue;
                for (int j = 0; j < images.length(); j++) {
                    JSONObject image = images.getJSONObject(j);
                    if (localPath.equals(image.optString("url")) && image.has("sourceUrl")) {
                        String source = image.optString("sourceUrl"); remoteSources.put(localPath, source); return source;
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }
    public Download download(String url, String filename) throws Exception {
        if (url == null) throw new IllegalArgumentException("没有图片地址");
        String name = filename == null ? "image.png" : filename.replaceAll("[\\\\/:*?\"<>|\\r\\n\\x00]", "_");
        if (name.length() > 180) name = name.substring(0, 170) + ".png";
        if (name.isEmpty()) name = "GPT-Image-2.png";
        byte[] bytes;
        String path = url.startsWith(MainActivity.ORIGIN + "/") ? url.substring(MainActivity.ORIGIN.length()) : url;
        if (path.startsWith("/gallery/")) {
            File file = galleryFile(Uri.parse(path).getLastPathSegment()); if (file == null) throw new IOException("图片文件不存在");
            try (FileInputStream in = new FileInputStream(file)) { bytes = RelayClient.readAll(in, 128 * 1024 * 1024); }
        } else if (path.startsWith("data:image/")) {
            Matcher m = DATA_IMAGE.matcher(path); if (!m.matches()) throw new IOException("图片编码无效"); bytes = Base64.decode(m.group(2), Base64.DEFAULT);
        } else if (path.startsWith("/remote-image/") && knownRemoteSource(path) != null) {
            String recoveryName = path.substring("/remote-image/".length());
            for (String ext : new String[]{"png", "jpg", "webp", "gif"}) {
                File local = galleryFile(recoveryName + "." + ext);
                if (local != null) {
                    try (FileInputStream in = new FileInputStream(local)) {
                        bytes = RelayClient.readAll(in, 128 * 1024 * 1024);
                        return new Download(name, imageMime(bytes), bytes);
                    }
                }
            }
            JSONObject cfg = config();
            RelayClient.Response r = relay.request(knownRemoteSource(path), "GET", null, null, null, 90, cfg.optString("proxy", "auto"), cfg.optBoolean("allowPrivateHost", true));
            checkResponse(r); bytes = r.bytes;
            String recoveredMime = imageMime(bytes);
            try (FileOutputStream out = new FileOutputStream(new File(gallery, recoveryName + "." + extension(recoveredMime)))) { out.write(bytes); }
        } else throw new IllegalArgumentException("只能保存本工具生成的图片");
        String mime = imageMime(bytes); return new Download(name, mime, bytes);
    }
}
