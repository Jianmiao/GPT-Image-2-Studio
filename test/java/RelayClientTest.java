package com.jianmiao.imagestudio;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.SocketException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPOutputStream;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManagerFactory;

/** Pure JDK tests. All sockets are loopback; keys and TLS identity are generated test data. */
public final class RelayClientTest {
    private static final String KEY = "sk-java-local-test";
    private static final byte[] BODY = "{\"prompt\":\"local test only\",\"n\":1}".getBytes(StandardCharsets.UTF_8);
    private static final RelayClient CLIENT = new RelayClient();
    private static int checks;

    private interface Handler { void handle(Socket socket, Request request) throws Exception; }
    private interface Throwing { void run() throws Exception; }
    private static final class SelectedProxy extends ProxySelector implements AutoCloseable {
        private final ProxySelector previous = ProxySelector.getDefault();
        private final List<Proxy> choices;
        final List<URI> selected = new ArrayList<>();
        int failures;
        SelectedProxy(Proxy... choices) { this.choices = List.of(choices); ProxySelector.setDefault(this); }
        @Override public List<Proxy> select(URI target) { selected.add(target); return choices; }
        @Override public void connectFailed(URI target, SocketAddress address, IOException failure) { failures++; }
        @Override public void close() { ProxySelector.setDefault(previous); }
    }
    private static final class Request {
        final String line;
        final Map<String, String> headers;
        final byte[] body;
        Request(String line, Map<String, String> headers, byte[] body) { this.line = line; this.headers = headers; this.body = body; }
    }
    private static final class LocalServer implements AutoCloseable {
        final ServerSocket server;
        final List<Request> requests = new CopyOnWriteArrayList<>();
        final List<Throwable> failures = new CopyOnWriteArrayList<>();
        final Thread worker;
        LocalServer(Handler handler) throws Exception {
            server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            worker = new Thread(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(5000);
                        Request request = readRequest(socket.getInputStream());
                        requests.add(request);
                        handler.handle(socket, request);
                    } catch (SocketException e) { if (!server.isClosed()) failures.add(e); }
                    catch (Throwable error) { failures.add(error); }
                }
            }, "local-relay-test");
            worker.setDaemon(true);
            worker.start();
        }
        String origin() { return "http://127.0.0.1:" + server.getLocalPort(); }
        @Override public void close() throws Exception {
            server.close();
            worker.join(6000);
            check(!worker.isAlive(), "Local test server must stop");
            check(failures.isEmpty(), "Local test server failures: " + failures);
        }
    }
    private static Request readRequest(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int end = 0, value;
        while ((value = input.read()) != -1) {
            bytes.write(value);
            end = (end << 8) | value;
            if (end == 0x0d0a0d0a) break;
            if (bytes.size() > 65536) throw new IOException("Request header too large");
        }
        if (value == -1) throw new EOFException("Missing local request headers");
        String[] lines = bytes.toString(StandardCharsets.ISO_8859_1).split("\r\n");
        Map<String, String> headers = new LinkedHashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon >= 0) headers.put(lines[i].substring(0, colon).toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
        }
        int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
        byte[] body = input.readNBytes(length);
        if (body.length != length) throw new EOFException("Missing local request body");
        return new Request(lines[0], headers, body);
    }
    private static void write(Socket socket, String raw) throws Exception {
        socket.getOutputStream().write(raw.getBytes(StandardCharsets.UTF_8));
        socket.getOutputStream().flush();
    }
    private static void respond(Socket socket, int status, String extra, byte[] body) throws Exception {
        write(socket, "HTTP/1.1 " + status + " Test\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\n" + extra + "Connection: close\r\n\r\n");
        socket.getOutputStream().write(body);
        socket.getOutputStream().flush();
    }
    private static RelayClient.Response send(String url, String proxy) throws Exception {
        return CLIENT.request(url, "POST", BODY, "application/json", KEY, 10, proxy, true);
    }
    private static void check(boolean ok, String detail) {
        checks++;
        if (!ok) throw new AssertionError(detail);
    }
    private static void onePost(LocalServer server) {
        check(server.requests.size() == 1, "Exactly one accepted application request, got " + server.requests.size());
        Request request = server.requests.get(0);
        check(request.line.startsWith("POST "), "A POST was submitted");
        check(("Bearer " + KEY).equals(request.headers.get("authorization")), "Only the fake test key is used");
        check(java.util.Arrays.equals(request.body, BODY), "The request body must reach the local server unchanged");
    }
    private static void expectIOException(Throwing operation) throws Exception {
        boolean failed = false;
        try { operation.run(); } catch (IOException expected) { failed = true; }
        check(failed, "A broken transport must fail rather than fabricate success");
    }

    private static void httpCases() throws Exception {
        String success = "{\"data\":[{\"b64_json\":\"local-only\"}]}";
        try (LocalServer relay = new LocalServer((socket, request) -> respond(socket, 200, "X-Request-Id: local-json\r\n", success.getBytes(StandardCharsets.UTF_8)))) {
            RelayClient.Response result = send(relay.origin() + "/v1/images/generations?local=1", "off");
            check(result.status == 200 && result.text().equals(success), "JSON response stays intact");
            check(result.header("X-Request-ID").equals("local-json"), "Response headers are case insensitive");
            check(relay.requests.get(0).line.equals("POST /v1/images/generations?local=1 HTTP/1.1"), "Direct request keeps relative path and query");
            onePost(relay);
        }
        try (LocalServer relay = new LocalServer((socket, request) -> write(socket, "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;part=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: local\r\n\r\n"))) {
            RelayClient.Response result = send(relay.origin() + "/v1/images/generations", "off");
            check(result.status == 200 && result.text().equals("hello world"), "Interim response, chunk extension and trailer decode");
            onePost(relay);
        }
        String rejection = "{\"error\":{\"message\":\"local policy rejection\",\"code\":\"content_policy_violation\"}}";
        try (LocalServer relay = new LocalServer((socket, request) -> respond(socket, 400, "X-Request-Id: local-rejected\r\n", rejection.getBytes(StandardCharsets.UTF_8)))) {
            RelayClient.Response result = send(relay.origin() + "/v1/images/generations", "off");
            check(result.status == 400 && result.text().equals(rejection), "HTTP 400 preserves the upstream error JSON");
            check(result.header("x-request-id").equals("local-rejected"), "Upstream rejection request ID survives");
            onePost(relay);
        }
        try (LocalServer target = new LocalServer((socket, request) -> respond(socket, 200, "", new byte[0]));
             LocalServer redirect = new LocalServer((socket, request) -> respond(socket, 302, "Location: " + target.origin() + "/must-not-call\r\n", "redirect".getBytes(StandardCharsets.UTF_8)))) {
            RelayClient.Response result = send(redirect.origin() + "/v1/images/generations", "off");
            check(result.status == 302 && result.text().equals("redirect"), "3xx is returned to the caller");
            check(target.requests.isEmpty(), "A billable POST must never follow an upstream redirect");
            onePost(redirect);
        }
        for (String truncated : List.of("HTTP/1.1 200 OK\r\nContent-Length: 30\r\n\r\nshort", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort", "")) {
            try (LocalServer relay = new LocalServer((socket, request) -> { if (!truncated.isEmpty()) write(socket, truncated); })) {
                expectIOException(() -> send(relay.origin() + "/v1/images/generations", "off"));
                onePost(relay);
            }
        }
        ByteArrayOutputStream compressed = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(compressed)) { gzip.write(success.getBytes(StandardCharsets.UTF_8)); }
        try (LocalServer relay = new LocalServer((socket, request) -> respond(socket, 200, "Content-Encoding: gzip\r\n", compressed.toByteArray()))) {
            check(send(relay.origin() + "/v1/images/generations", "off").text().equals(success), "Gzip gateway responses decode");
            onePost(relay);
        }
        try (LocalServer proxy = new LocalServer((socket, request) -> respond(socket, 200, "", "proxy-ok".getBytes(StandardCharsets.UTF_8)))) {
            String target = "http://127.0.0.1:12345/v1/images/generations?proxy=1";
            check(send(target, proxy.origin()).text().equals("proxy-ok"), "Explicit HTTP proxy receives the response");
            check(proxy.requests.get(0).line.equals("POST " + target + " HTTP/1.1"), "Cleartext proxy receives absolute-form request target");
            onePost(proxy);
        }
        System.out.println("PASS HTTP JSON/chunked/gzip/errors/redirect/disconnect and HTTP proxy: one POST each");
    }

    private static void automaticProxyCases() throws Exception {
        // Android's system selector returns unresolved addresses, even for 127.0.0.1.
        // The target deliberately cannot resolve: only the selected proxy may receive it.
        for (String host : List.of("127.0.0.1", "localhost")) {
            for (String method : List.of("GET", "POST")) {
                try (LocalServer proxy = new LocalServer((socket, request) -> respond(socket, 200, "", "auto-proxy-ok".getBytes(StandardCharsets.UTF_8)));
                     SelectedProxy selector = new SelectedProxy(new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(host, proxy.server.getLocalPort())))) {
                    String path = method.equals("GET") ? "/v1/models" : "/v1/images/generations";
                    String url = "http://proxy-target.invalid" + path;
                    RelayClient.Response result = CLIENT.request(url, method, method.equals("POST") ? BODY : null, "application/json", KEY, 10, "auto", false);
                    check(result.status == 200 && result.text().equals("auto-proxy-ok"), "System unresolved " + host + " proxy must serve " + method);
                    check(proxy.requests.size() == 1, "Automatic proxy must receive one " + method);
                    check(proxy.requests.get(0).line.equals(method + " http://proxy-target.invalid:80" + path + " HTTP/1.1"), "Auto HTTP proxy receives the original remote hostname");
                    if (method.equals("POST")) onePost(proxy);
                    check(selector.selected.equals(List.of(new URI(url))), "Resolve the proxy once for the destination, never again for the proxy socket");
                    check(selector.failures == 0, "A successful proxy does not trigger fallback");
                }
            }
        }
        try (LocalServer direct = new LocalServer((socket, request) -> respond(socket, 200, "", "direct-ok".getBytes(StandardCharsets.UTF_8)));
             SelectedProxy selector = new SelectedProxy(new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("invalid-proxy.invalid", 1)))) {
            check(send(direct.origin() + "/v1/images/generations", "off").text().equals("direct-ok"), "Off connects directly despite a system proxy");
            check(selector.selected.isEmpty(), "Off must not consult the system selector indirectly through Socket");
            onePost(direct);
        }
        try (LocalServer direct = new LocalServer((socket, request) -> respond(socket, 200, "", new byte[0]));
             LocalServer failingProxy = new LocalServer((socket, request) -> {});
             SelectedProxy selector = new SelectedProxy(new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("127.0.0.1", failingProxy.server.getLocalPort())), Proxy.NO_PROXY)) {
            expectIOException(() -> send(direct.origin() + "/v1/images/generations", "auto"));
            onePost(failingProxy);
            check(direct.requests.isEmpty(), "A disconnected auto proxy must never cause a second generation through DIRECT");
            check(selector.selected.size() == 1 && selector.failures == 0, "A submitted POST never reselects or retries the proxy");
        }
        System.out.println("PASS unresolved Android system HTTP proxy, GET models, POST once, off and no DIRECT fallback");
    }

    private static void proxyDiagnosticCases() throws Exception {
        URI destination = new URI("https://proxy-target.invalid/v1/models");
        Proxy systemProxy = new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("127.0.0.1", 7890));
        try (SelectedProxy selector = new SelectedProxy(systemProxy)) {
            Proxy selected = RelayClient.chooseProxy(destination, "auto");
            check(selected == systemProxy, "Diagnostics use the same system proxy choice as the transport");
            check(RelayClient.proxyUrl(selected).equals("http://127.0.0.1:7890"), "Diagnostics display unresolved loopback proxy without resolving it");
            check(selector.selected.equals(List.of(destination)), "Diagnostics use the provider URL for PAC and exclusions");
        }
        try (SelectedProxy selector = new SelectedProxy(Proxy.NO_PROXY, systemProxy)) {
            Proxy selected = RelayClient.chooseProxy(destination, "auto");
            check(selected == Proxy.NO_PROXY && RelayClient.proxyUrl(selected).isEmpty(), "System DIRECT decision must be respected, even when another proxy is listed");
        }
        try (SelectedProxy selector = new SelectedProxy(systemProxy)) {
            Proxy selected = RelayClient.chooseProxy(destination, "off");
            check(selected == Proxy.NO_PROXY && selector.selected.isEmpty(), "Off diagnostics do not call the system selector");
        }
        System.out.println("PASS proxy diagnostics use actual target-specific system choice");
    }

    private static SSLContext testTls(Path dir) throws Exception {
        String exe = System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win") ? "keytool.exe" : "keytool";
        Path keytool = Path.of(System.getProperty("java.home"), "bin", exe);
        Path store = dir.resolve("local-test.p12");
        Process process = new ProcessBuilder(keytool.toString(), "-genkeypair", "-alias", "local-test", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1", "-storetype", "PKCS12", "-keystore", store.toString(), "-storepass", "local-test-only", "-keypass", "local-test-only", "-noprompt").redirectErrorStream(true).redirectOutput(dir.resolve("keytool.log").toFile()).start();
        check(process.waitFor(30, TimeUnit.SECONDS), "Local TLS identity creation must finish");
        check(process.exitValue() == 0, "Local TLS identity creation failed: " + new String(Files.readAllBytes(dir.resolve("keytool.log")), java.nio.charset.Charset.defaultCharset()));
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (InputStream input = Files.newInputStream(store)) { keys.load(input, "local-test-only".toCharArray()); }
        KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        km.init(keys, "local-test-only".toCharArray());
        TrustManagerFactory tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tm.init(keys);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(km.getKeyManagers(), tm.getTrustManagers(), null);
        return context;
    }
    private static void connectCases() throws Exception {
        Path temp = Files.createTempDirectory("image-relay-java-test-");
        SSLContext previous = SSLContext.getDefault();
        try {
            SSLContext context = testTls(temp);
            SSLContext.setDefault(context); // Test-only trust; never changes app production code.
            for (boolean automatic : List.of(false, true)) {
                List<Request> tunneled = new CopyOnWriteArrayList<>();
                try (LocalServer proxy = new LocalServer((socket, request) -> {
                    check(request.line.equals("CONNECT localhost:443 HTTP/1.1"), "Proxy tunnel target must match HTTPS origin");
                    check(!request.headers.containsKey("authorization"), "Provider API key must not be sent in CONNECT headers");
                    write(socket, "HTTP/1.1 200 Connection established\r\n\r\n");
                    try (SSLSocket secure = (SSLSocket) context.getSocketFactory().createSocket(socket, "localhost", 443, true)) {
                        secure.setUseClientMode(false);
                        secure.setSoTimeout(5000);
                        secure.startHandshake();
                        tunneled.add(readRequest(secure.getInputStream()));
                        respond(secure, 200, "", "tls-proxy-ok".getBytes(StandardCharsets.UTF_8));
                    }
                }); SelectedProxy selector = new SelectedProxy(new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("127.0.0.1", proxy.server.getLocalPort())))) {
                    RelayClient.Response result = send("https://localhost/v1/images/generations", automatic ? "auto" : proxy.origin());
                    check(result.status == 200 && result.text().equals("tls-proxy-ok"), "HTTPS over CONNECT returns response");
                    check(proxy.requests.size() == 1 && tunneled.size() == 1, "Exactly one CONNECT and one tunneled POST");
                    check(tunneled.get(0).line.equals("POST /v1/images/generations HTTP/1.1"), "Tunneled request uses origin-form path");
                    check(("Bearer " + KEY).equals(tunneled.get(0).headers.get("authorization")), "Fake API key travels only inside TLS");
                    check(java.util.Arrays.equals(tunneled.get(0).body, BODY), "Tunneled POST body is unchanged");
                    check(selector.selected.size() == (automatic ? 1 : 0), "CONNECT proxy selection happens only once in auto mode and never in manual mode");
                }
                }
            try (LocalServer proxy = new LocalServer((socket, request) -> respond(socket, 407, "", "proxy authentication required".getBytes(StandardCharsets.UTF_8)))) {
                expectIOException(() -> send("https://localhost/v1/images/generations", proxy.origin()));
                check(proxy.requests.size() == 1 && proxy.requests.get(0).line.startsWith("CONNECT "), "Failed proxy handshake never falls back or submits a POST");
            }
            System.out.println("PASS local HTTPS CONNECT, fake-key isolation and failed-proxy no-retry");
        } finally {
            SSLContext.setDefault(previous);
            try (var files = Files.walk(temp)) {
                for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file);
            }
        }
    }

    public static void main(String[] args) throws Exception {
        automaticProxyCases();
        proxyDiagnosticCases();
        httpCases();
        connectCases();
        System.out.println("All RelayClient socket checks passed (" + checks + " assertions, localhost and fake keys only)");
    }
}
