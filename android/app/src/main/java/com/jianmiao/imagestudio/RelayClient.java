package com.jianmiao.imagestudio;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.GZIPInputStream;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Small HTTP/1.1 transport deliberately using one socket and one request write.
 * No client connection pool, automatic retry, redirect, authentication replay,
 * protocol fallback, or SDK retry policy can repeat a billable POST.
 */
public final class RelayClient {
    private static final int MAX_BODY = 128 * 1024 * 1024;
    private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "relay-deadlines"); t.setDaemon(true); return t;
    });
    public static final class Response {
        public final int status;
        public final Map<String, String> headers;
        public final byte[] bytes;
        Response(int status, Map<String, String> headers, byte[] bytes) { this.status = status; this.headers = headers; this.bytes = bytes; }
        public String text() { return new String(bytes, StandardCharsets.UTF_8); }
        public String header(String name) { String value = headers.get(name.toLowerCase(Locale.ROOT)); return value == null ? "" : value; }
    }
    private static final class Head {
        final int status; final Map<String, String> headers;
        Head(int status, Map<String, String> headers) { this.status = status; this.headers = headers; }
    }
    public Response request(String url, String method, byte[] body, String contentType, String apiKey,
                            int timeoutSeconds, String proxySetting, boolean allowPrivate) throws Exception {
        URI uri = new URI(url);
        String scheme = uri.getScheme(), host = uri.getHost();
        boolean tls = "https".equalsIgnoreCase(scheme);
        if ((!tls && !"http".equalsIgnoreCase(scheme)) || host == null || uri.getUserInfo() != null) throw new IOException("仅支持不带用户名密码的 HTTP / HTTPS 地址");
        if (!allowPrivate && isPrivateHost(host)) throw new IOException("请在设置中开启允许内网地址");
        if (apiKey != null && (apiKey.contains("\r") || apiKey.contains("\n"))) throw new IOException("API Key 包含无效换行");
        int port = uri.getPort() == -1 ? (tls ? 443 : 80) : uri.getPort();
        int timeout = Math.max(10, Math.min(3600, timeoutSeconds)) * 1000;
        Proxy proxy = chooseProxy(uri, proxySetting);
        Socket raw = proxy.type() == Proxy.Type.SOCKS ? new Socket(proxy) : new Socket();
        AtomicReference<Socket> active = new AtomicReference<>(raw);
        ScheduledFuture<?> watchdog = DEADLINES.schedule(() -> { try { active.get().close(); } catch (Exception ignored) {} }, timeout, TimeUnit.MILLISECONDS);
        long start = System.currentTimeMillis();
        try {
            raw.setSoTimeout(timeout);
            raw.setTcpNoDelay(true);
            boolean httpProxy = proxy.type() == Proxy.Type.HTTP;
            raw.connect(httpProxy ? proxy.address() : new InetSocketAddress(host, port), Math.min(timeout, 30000));
            String authority = (host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host) + ":" + port;
            if (httpProxy && tls) {
                OutputStream tunnel = raw.getOutputStream();
                tunnel.write(("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nProxy-Connection: keep-alive\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                tunnel.flush();
                Head connect = readHead(raw.getInputStream());
                if (connect.status != 200) throw new IOException("代理连接失败：HTTP " + connect.status);
            }
            Socket socket = raw;
            if (tls) {
                SSLSocket secure = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
                active.set(secure);
                SSLParameters params = secure.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                secure.setSSLParameters(params);
                secure.setSoTimeout(timeout);
                secure.startHandshake();
                socket = secure;
            }
            String target = uri.getRawPath();
            if (target == null || target.isEmpty()) target = "/";
            if (uri.getRawQuery() != null) target += "?" + uri.getRawQuery();
            if (httpProxy && !tls) target = scheme + "://" + authority + target;
            StringBuilder header = new StringBuilder(method).append(' ').append(target).append(" HTTP/1.1\r\nHost: ").append(authority)
                .append("\r\nConnection: close\r\nAccept: application/json, text/event-stream, image/*, */*\r\nAccept-Encoding: identity\r\nUser-Agent: GPTImage2-Android/1.0\r\n");
            if (apiKey != null && !apiKey.isEmpty()) header.append("Authorization: Bearer ").append(apiKey).append("\r\n");
            if (body != null) header.append("Content-Type: ").append(contentType).append("\r\nContent-Length: ").append(body.length).append("\r\n");
            header.append("\r\n");
            OutputStream output = socket.getOutputStream();
            output.write(header.toString().getBytes(StandardCharsets.UTF_8));
            if (body != null) output.write(body);
            output.flush(); // This is the only upstream application request write.
            InputStream input = new BufferedInputStream(socket.getInputStream(), 32768);
            Head head = readHead(input);
            int interim = 0;
            while (head.status >= 100 && head.status < 200 && head.status != 101 && interim++ < 8) head = readHead(input);
            byte[] bytes;
            if (head.status == 204 || head.status == 304) bytes = new byte[0];
            else if (head.headers.getOrDefault("transfer-encoding", "").toLowerCase(Locale.ROOT).contains("chunked")) bytes = readChunked(input);
            else if (head.headers.containsKey("content-length")) {
                long length;
                try { length = Long.parseLong(head.headers.get("content-length")); } catch (NumberFormatException e) { throw new IOException("上游返回了无效的响应长度"); }
                if (length < 0 || length > MAX_BODY) throw new IOException("上游响应超过 128 MB 限制");
                bytes = readExact(input, (int) length);
            } else bytes = readAll(input, MAX_BODY);
            if (head.headers.getOrDefault("content-encoding", "").toLowerCase(Locale.ROOT).contains("gzip")) {
                try (GZIPInputStream gzip = new GZIPInputStream(new java.io.ByteArrayInputStream(bytes))) { bytes = readAll(gzip, MAX_BODY); }
            }
            return new Response(head.status, head.headers, bytes); // 3xx is returned to caller; never followed.
        } catch (IOException e) {
            if (System.currentTimeMillis() - start >= timeout - 100 || e instanceof SocketTimeoutException)
                throw new IOException("等待上游响应超时。请求可能已被处理，请先查看供应商记录；本工具没有自动重发。", e);
            throw e;
        } finally {
            watchdog.cancel(false);
            try { active.get().close(); } catch (Exception ignored) {}
            try { raw.close(); } catch (Exception ignored) {}
        }
    }
    private static Proxy chooseProxy(URI target, String setting) throws Exception {
        String value = setting == null ? "auto" : setting.trim();
        if (value.isEmpty() || value.equalsIgnoreCase("off") || value.equalsIgnoreCase("direct")) return Proxy.NO_PROXY;
        if (value.equalsIgnoreCase("auto")) {
            ProxySelector selector = ProxySelector.getDefault();
            if (selector != null) {
                List<Proxy> choices = selector.select(target);
                if (choices != null && !choices.isEmpty()) return choices.get(0);
            }
            return Proxy.NO_PROXY;
        }
        URI proxy = new URI(value);
        if (!"http".equalsIgnoreCase(proxy.getScheme()) || proxy.getHost() == null || proxy.getUserInfo() != null)
            throw new IOException("安卓代理支持 auto、off 或 http://主机:端口");
        return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(proxy.getHost(), proxy.getPort() < 0 ? 80 : proxy.getPort()));
    }
    public static boolean isPrivateHost(String host) {
        String h = host.toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
        return h.equals("localhost") || h.endsWith(".localhost") || h.equals("::1") || h.equals("::")
            || h.startsWith("fc") && h.contains(":") || h.startsWith("fd") && h.contains(":") || h.startsWith("fe80:")
            || h.matches("^(0|10|127)\\..*") || h.startsWith("192.168.") || h.startsWith("169.254.")
            || h.matches("^172\\.(1[6-9]|2[0-9]|3[01])\\..*");
    }
    private static Head readHead(InputStream input) throws IOException {
        String line = readLine(input);
        if (line == null) throw new EOFException("与上游连接已中断，尚未收到 HTTP 响应。请先核对供应商任务记录。");
        String[] status = line.split(" ", 3);
        if (status.length < 2 || !status[0].startsWith("HTTP/1.")) throw new IOException("上游返回了无效的 HTTP 响应");
        int code;
        try { code = Integer.parseInt(status[1]); } catch (NumberFormatException e) { throw new IOException("上游 HTTP 状态无效"); }
        Map<String, String> headers = new LinkedHashMap<>();
        int length = line.length();
        while ((line = readLine(input)) != null && !line.isEmpty()) {
            length += line.length(); if (length > 65536) throw new IOException("上游响应头过大");
            int colon = line.indexOf(':');
            if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
        }
        if (line == null) throw new EOFException("上游响应头不完整");
        return new Head(code, headers);
    }
    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int ch;
        while ((ch = input.read()) != -1) {
            if (ch == '\n') break;
            if (ch != '\r') out.write(ch);
            if (out.size() > 65536) throw new IOException("HTTP 行过长");
        }
        if (ch == -1 && out.size() == 0) return null;
        return out.toString("ISO-8859-1");
    }
    private static byte[] readChunked(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            String line = readLine(input); if (line == null) throw new EOFException("上游分块响应提前中断");
            int semicolon = line.indexOf(';'); if (semicolon >= 0) line = line.substring(0, semicolon);
            long chunk;
            try { chunk = Long.parseLong(line.trim(), 16); } catch (NumberFormatException e) { throw new IOException("上游分块长度无效"); }
            if (chunk < 0 || chunk > MAX_BODY - out.size()) throw new IOException("上游响应超过 128 MB 限制");
            if (chunk == 0) {
                int trailer = 0;
                while ((line = readLine(input)) != null && !line.isEmpty()) { trailer += line.length(); if (trailer > 65536) throw new IOException("上游尾部过大"); }
                if (line == null) throw new EOFException("上游分块响应未完整结束");
                return out.toByteArray();
            }
            out.write(readExact(input, (int) chunk));
            String ending = readLine(input);
            if (ending == null || !ending.isEmpty()) throw new IOException("上游分块结束标记无效");
        }
    }
    private static byte[] readExact(InputStream input, int length) throws IOException {
        byte[] bytes = new byte[length]; int offset = 0;
        while (offset < length) { int n = input.read(bytes, offset, length - offset); if (n < 0) throw new EOFException("上游返回内容不完整。请求可能已成功，请先查看供应商记录。"); offset += n; }
        return bytes;
    }
    public static byte[] readAll(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] block = new byte[32768]; int n;
        while ((n = input.read(block)) != -1) { if (out.size() + n > limit) throw new IOException("文件超过大小限制"); out.write(block, 0, n); }
        return out.toByteArray();
    }
}
