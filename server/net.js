'use strict';
/**
 * 网络出口模块
 *
 * 设计要点（都是踩过坑之后定下来的）：
 *   1. HTTP 与 HTTPS 目标**统一走裸 TCP + 手写 CONNECT**。
 *      不用 node 的 http.request 做代理转发——它在响应结束后会自行 abort 套接字，
 *      把上游的 SSE 流搅乱（表现为 getReader 拿不到数据）。
 *   2. 明文 HTTP 目标也必须暴露**可读流**。很多中转站是 http:// 且返回 SSE，
 *      没有流就会在 consumeUpstream 里崩在 body.getReader 上。
 *   3. 底层流先 pause，等真有读者（ReadableStream.pull）再 resume，
 *      否则数据会在消费者挂上之前被读走。
 *   4. 失败要精确归因：代理没开 / 代理连不到目标 / HTTP 状态码 / 上游截断，
 *      不要一律说成"请检查地址、代理和密钥"。
 *   5. 本机与内网地址永远不走代理。
 */
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { execFileSync } = require('child_process');

/* --------------------------- 代理探测 --------------------------- */

function envProxy() {
  return String(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY
    || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '').trim();
}

function windowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '$p = Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -ErrorAction SilentlyContinue; if ($p.ProxyEnable -eq 1 -and $p.ProxyServer) { $p.ProxyServer }'
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return String(out || '').trim();
  } catch (_) { return ''; }
}

const NO_PROXY = /^(off|none|direct|0|false|no)$/i;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i;

function isLocalTarget(url) {
  try { return LOCAL_HOST.test(new URL(url).hostname); } catch (_) { return false; }
}

/** 支持 127.0.0.1:7890 / http://host:port 等写法；SOCKS 暂不支持 */
function normalizeProxyUrl(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (/^socks/i.test(u.protocol)) return '';
    if (!u.port) u.port = '80';
    return u.protocol + '//' + u.host;
  } catch (_) { return ''; }
}

function resolveProxy(setting) {
  const s = String(setting === undefined || setting === null ? 'auto' : setting).trim();
  if (NO_PROXY.test(s)) return { url: '', source: 'disabled' };
  if (s && s !== 'auto') return { url: normalizeProxyUrl(s), source: 'manual' };
  const env = envProxy();
  if (env) return { url: normalizeProxyUrl(env), source: 'env' };
  const sys = windowsSystemProxy();
  if (sys) return { url: normalizeProxyUrl(sys), source: 'system' };
  return { url: '', source: 'none' };
}

/* --------------------------- 错误归因 --------------------------- */

function tunnelError(proxyUrl, detail) {
  const err = new Error('代理接受了 CONNECT，但隧道内没有任何响应：' + proxyUrl + ' 这个节点连不到该站点（换节点，或确认该站点当前是否可用）。');
  err.code = 'PROXY_TUNNEL_EMPTY';
  err.viaProxy = true;
  err.detail = detail;
  return err;
}

function classifyNetworkError(code, proxyUrl, info) {
  const i = info || {};
  if (code === 'PROXY_REFUSED') {
    return '代理 ' + proxyUrl + ' 拒绝连接（代理没开，或端口/协议填错了）';
  }
  if (i.connectStatus && i.connectStatus !== 200) {
    return '代理无法连到目标（CONNECT 返回 HTTP ' + i.connectStatus + '）：' + proxyUrl
      + '。该站点在当前代理节点下走不通——换个节点，或确认这个域名/服务是否还有效';
  }
  if (i.tunnelOpened && !i.tunnelBytes) {
    return '代理接受了 CONNECT，但隧道内没有任何响应：' + proxyUrl
      + ' 这个节点连不到该站点（换节点，或确认该站点当前是否可用）';
  }
  if (code === 'ENOTFOUND') return '域名无法解析';
  if (/TIMEOUT/i.test(String(code))) return '超时';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被重置';
  return String(code || '未知错误');
}

function wrapNetError(e, proxyUrl, info) {
  const code = (e && (e.code || e.message)) || 'UNKNOWN';
  const err = new Error('经代理请求失败：' + code + ' —— ' + classifyNetworkError(code, proxyUrl, info));
  err.code = code;
  err.viaProxy = true;
  err.tunnelInfo = info ? {
    connectStatus: info.connectStatus || 0,
    tunnelOpened: !!info.tunnelOpened,
    tunnelBytes: info.tunnelBytes || 0
  } : null;
  return err;
}

/* --------------------------- 底层：一次带代理的请求 --------------------------- */

/**
 * 通过 HTTP 代理发一次请求，返回 { statusText, status, headers, stream, socket, info }。
 * HTTPS 目标用 CONNECT 建隧道后做 TLS；HTTP 目标直接在隧道里发绝对 URI。
 * 出错时抛出的 Error 已经带上精确归因。
 */
function proxyRoundTrip(target, init, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const isHttps = target.protocol === 'https:';
    const port = target.port || (isHttps ? 443 : 80);
    const info = { connectStatus: 0, tunnelOpened: false, tunnelBytes: 0 };
    let settled = false;
    let sock = null;
    let timer = null;

    const done = (fn, arg) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(arg); };
    const fail = (err) => done(reject, err);

    if (init.signal) {
      if (init.signal.aborted) { fail(new Error('已取消')); return; }
      init.signal.addEventListener('abort', () => {
        try { if (sock) sock.destroy(); } catch (_) {}
        fail(new Error('请求超时或被取消'));
      }, { once: true });
    }

    sock = net.connect({ host: p.hostname, port: Number(p.port || 80) });
    timer = setTimeout(() => {
      try { sock.destroy(); } catch (_) {}
      fail(new Error('代理连接超时'));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    sock.on('error', (e) => {
      const code = e.code === 'ECONNREFUSED' ? 'PROXY_REFUSED' : (e.code || e.message);
      fail(wrapNetError({ code }, proxyUrl, info));
    });
    sock.on('close', () => {
      if (!settled) fail(wrapNetError({ code: 'ECONNRESET' }, proxyUrl, info));
    });

    let phase = 'connect';
    let buf = Buffer.alloc(0);
    let stream = null;
    const DBG = !!process.env.NET_DEBUG;
    const dlog = (...a) => { if (DBG) console.log('[net]', ...a); };

    sock.on('connect', () => {
      dlog('TCP 已连上代理 ' + proxyUrl);
      sock.write('CONNECT ' + target.hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + target.hostname + ':' + port + '\r\n\r\n');
    });

    const onConnectReply = () => {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return false;
      const head = buf.slice(0, idx).toString('latin1');
      buf = buf.slice(idx + 4);
      const status = Number((head.split('\r\n')[0] || '').split(' ')[1] || 0);
      info.connectStatus = status;
      dlog('CONNECT 应答 ' + status);
      if (status !== 200) {
        const err = new Error('代理无法连到目标（CONNECT 返回 HTTP ' + status + '）：' + proxyUrl
          + '。该站点在当前代理节点下走不通——换个节点，或确认这个域名/服务是否还有效。');
        err.code = 'PROXY_CONNECT_' + status;
        err.viaProxy = true;
        fail(err);
        return true;
      }
      info.tunnelOpened = true;
      if (isHttps) {
        // 隧道内做 TLS
        sock.removeAllListeners('data');
        dlog('开始 TLS 握手');
        const tlsSock = tls.connect({ socket: sock, servername: target.hostname, rejectUnauthorized: false }, () => {
          dlog('TLS 完成，发送请求');
          sendRequest(tlsSock);
        });
        sock.removeListener('data', onTunnelData);  // 之后由 TLS 套接字负责收数据
        tlsSock.on('data', onTlsData);
        tlsSock.on('error', (e) => fail(wrapNetError(e, proxyUrl, info)));
        tlsSock.on('close', () => {
          if (!settled && !stream) fail(wrapNetError({ code: 'ECONNRESET' }, proxyUrl, info));
        });
        stream = tlsSock;
      } else {
        phase = 'response';
        sendRequest(sock);
      }
      return true;
    };

    const sendRequest = (socket) => {
      const headers = Object.assign({ Host: target.host, Accept: '*/*' }, init.headers || {});
      const lines = [String(init.method || 'GET').toUpperCase() + ' '
        + (isHttps ? (target.pathname + target.search || '/') : target.toString()) + ' HTTP/1.1'];
      const body = init.body;
      if (body && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(body);
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined || v === null) continue;
        lines.push(k + ': ' + v);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (body) socket.write(body);
    };

    /** 解析响应头，并把 body 包成可读流 */
    const onResponseHead = () => {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return false;
      const head = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);
      buf = Buffer.alloc(0);
      const headLines = head.split('\r\n');
      const status = Number((headLines[0] || '').split(' ')[1] || 0);
      const headers = {};
      for (const line of headLines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      info.tunnelBytes += rest.length;

      const socket = stream || sock;
      socket.removeAllListeners('data');
      socket.pause();

      const contentLength = Number(headers['content-length']);
      const isChunked = /chunked/i.test(String(headers['transfer-encoding'] || ''));
      const bodyStream = new ReadableStream({
        pull() { socket.resume(); },
        start(controller) {
          let emitted = 0;
          let pending = Buffer.alloc(0);
          let chunkRemaining = 0;
          let closed = false;
          const push = (c) => {
            if (!c.length || closed) return;
            emitted += c.length;
            try { controller.enqueue(new Uint8Array(c)); } catch (_) {}
          };
          const finish = () => {
            if (closed) return;
            closed = true;
            try { controller.close(); } catch (_) {}
          };
          const abort = (e) => {
            if (closed) return;
            closed = true;
            try { controller.error(e); } catch (_) {}
          };

          if (rest.length) socket.unshift(rest);
          socket.on('data', (c) => {
            try {
              if (!isChunked) { push(c); return; }
              pending = Buffer.concat([pending, c]);
              while (pending.length) {
                if (chunkRemaining === 0) {
                  const nl = pending.indexOf('\r\n');
                  if (nl < 0) return;
                  const size = parseInt(pending.slice(0, nl).toString('latin1').trim(), 16);
                  if (Number.isNaN(size)) { push(pending); pending = Buffer.alloc(0); return; }
                  if (size === 0) { pending = Buffer.alloc(0); finish(); return; }
                  pending = pending.slice(nl + 2);
                  chunkRemaining = size;
                }
                if (pending.length < chunkRemaining) return;
                push(pending.slice(0, chunkRemaining));
                pending = pending.slice(chunkRemaining + 2);
                chunkRemaining = 0;
              }
            } catch (e) { abort(e); }
          });
          socket.on('end', () => {
            if (!isChunked && pending.length) push(pending);
            if (!isChunked && contentLength && emitted < contentLength) {
              abort(new Error('上游响应不完整（收到 ' + emitted + '/' + contentLength + ' 字节）'));
              return;
            }
            finish();
          });
          socket.on('error', (e) => abort(e));
          socket.on('close', () => {
            if (closed) return;
            if (!emitted && contentLength !== 0) {
              abort(tunnelError(proxyUrl, 'socket closed without body'));
              return;
            }
            finish();
          });
        }
      });

      done(resolve, {
        status,
        headers: { get: (name) => headers[String(name).toLowerCase()] || null },
        body: bodyStream,
        info,
        proxyUrl
      });
      return true;
    };

    // 注意：HTTPS 时响应数据走的是 TLS 套接字，必须挂到它上面，
    // 只监听底层 socket 会永远收不到响应（踩过一次）。
    /** CONNECT 阶段：只解析代理对 CONNECT 的应答 */
    const onTunnelData = (chunk) => {
      dlog('收到 ' + chunk.length + ' 字节 phase=' + phase);
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'connect') onConnectReply();
      else onResponseHead();
    };
    /** 隧道建立后（HTTPS）：解密后的数据全是目标响应，不再走 phase 判断 */
    const onTlsData = (chunk) => {
      dlog('TLS 收到 ' + chunk.length + ' 字节');
      buf = Buffer.concat([buf, chunk]);
      onResponseHead();
    };
    sock.on('data', onTunnelData);
    sock.on('end', () => {
      if (settled) return;
      if (phase === 'connect') { fail(tunnelError(proxyUrl, 'closed during CONNECT')); return; }
      if (!stream && !settled) fail(tunnelError(proxyUrl, 'closed before response'));
    });
  });
}

/* --------------------------- 直连（无代理） --------------------------- */

function directFetch(url, init, timeoutMs) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const info = { connectStatus: 0, tunnelOpened: true, tunnelBytes: 0 };
    let settled = false;
    let socket = null;
    const timer = setTimeout(() => { try { socket && socket.destroy(); } catch (_) {} fail(new Error('连接超时')); }, timeoutMs);
    if (timer.unref) timer.unref();
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); };

    if (init.signal) {
      if (init.signal.aborted) { fail(new Error('已取消')); return; }
      init.signal.addEventListener('abort', () => { try { socket && socket.destroy(); } catch (_) {} fail(new Error('请求超时或被取消')); }, { once: true });
    }

    const onConnect = () => {
      const headers = Object.assign({ Host: target.host, Accept: '*/*' }, init.headers || {});
      const lines = [String(init.method || 'GET').toUpperCase() + ' ' + (target.pathname + target.search || '/') + ' HTTP/1.1'];
      const body = init.body;
      if (body && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(body);
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined || v === null) continue;
        lines.push(k + ': ' + v);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (body) socket.write(body);
    };

    try {
      socket = isHttps
        ? tls.connect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname }, onConnect)
        : net.connect({ host: target.hostname, port: Number(target.port || 80) }, onConnect);
    } catch (e) { fail(e); return; }

    socket.on('error', (e) => {
      const err = new Error(e.code === 'ENOTFOUND'
        ? '域名无法解析：' + target.hostname + '（本机 DNS 查不到这个域名，注意有些代理用 fake-ip，浏览器能开不代表这里能解析）'
        : '无法连接 ' + target.host + '：' + (e.code || e.message));
      err.code = e.code || e.message;
      fail(err);
    });
    socket.on('close', () => { if (!settled) fail(new Error('连接在收到响应前被断开（' + target.host + '）')); });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);
      const headLines = head.split('\r\n');
      const status = Number((headLines[0] || '').split(' ')[1] || 0);
      const headers = {};
      for (const line of headLines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      socket.removeListener('data', onData);
      socket.pause();
      buf = Buffer.alloc(0);

      const contentLength = Number(headers['content-length']);
      const isChunked = /chunked/i.test(String(headers['transfer-encoding'] || ''));
      const bodyStream = new ReadableStream({
        pull() { socket.resume(); },
        start(controller) {
          let emitted = 0; let pending = Buffer.alloc(0); let chunkRemaining = 0; let closed = false;
          const push = (c) => { if (!c.length || closed) return; emitted += c.length; try { controller.enqueue(new Uint8Array(c)); } catch (_) {} };
          const finish = () => { if (closed) return; closed = true; try { controller.close(); } catch (_) {} };
          const abort = (e) => { if (closed) return; closed = true; try { controller.error(e); } catch (_) {} };
          if (rest.length) socket.unshift(rest);
          socket.on('data', (c) => {
            if (!isChunked) { push(c); return; }
            pending = Buffer.concat([pending, c]);
            while (pending.length) {
              if (chunkRemaining === 0) {
                const nl = pending.indexOf('\r\n');
                if (nl < 0) return;
                const size = parseInt(pending.slice(0, nl).toString('latin1').trim(), 16);
                if (Number.isNaN(size)) { push(pending); pending = Buffer.alloc(0); return; }
                if (size === 0) { finish(); return; }
                pending = pending.slice(nl + 2);
                chunkRemaining = size;
              }
              if (pending.length < chunkRemaining) return;
              push(pending.slice(0, chunkRemaining));
              pending = pending.slice(chunkRemaining + 2);
              chunkRemaining = 0;
            }
          });
          socket.on('end', () => {
            if (!isChunked && pending.length) push(pending);
            if (!isChunked && contentLength && emitted < contentLength) { abort(new Error('上游响应不完整')); return; }
            finish();
          });
          socket.on('error', (e) => abort(e));
          socket.on('close', () => { if (!emitted && contentLength !== 0) abort(new Error('连接中断，未收到响应体')); else finish(); });
        }
      });
      settled = true;
      clearTimeout(timer);
      resolve({ status, headers: { get: (n2) => headers[String(n2).toLowerCase()] || null }, body: bodyStream, info, proxyUrl: '' });
    };
    socket.on('data', onData);
  });
}

/* --------------------------- 对外：fetch 形状 --------------------------- */

function toResponse(rt) {
  const readerText = async () => {
    const reader = rt.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  };
  return {
    ok: rt.status >= 200 && rt.status < 300,
    status: rt.status,
    headers: rt.headers,
    body: rt.body,
    text: readerText,
    json: async () => JSON.parse(await readerText()),
    arrayBuffer: async () => Buffer.from(await readerText(), 'utf8'),
    _viaProxy: !!(rt.proxyUrl),
    _tunnelInfo: rt.info
  };
}

function makeFetch(proxySetting) {
  const { url: proxyUrl, source } = resolveProxy(proxySetting);
  const impl = async (url, init = {}) => {
    const timeoutMs = init.timeoutMs || 60000;
    // 两条路径都统一包成 Response 形状（都必须有 text()/json()/可读流）
    if (!proxyUrl || isLocalTarget(url)) return toResponse(await directFetch(url, init, timeoutMs));
    const rt = await proxyRoundTrip(new URL(url), init, proxyUrl, timeoutMs);
    return toResponse(rt);
  };
  impl.proxy = { url: proxyUrl, source };
  return impl;
}

/* --------------------------- 诊断 --------------------------- */

function classifyError(e, host) {
  const msg = String((e && (e.cause && (e.cause.code || e.cause.message))) || (e && e.code) || (e && e.message) || e);
  if (/ENOTFOUND|EAI_AGAIN|NXDOMAIN|域名无法解析/i.test(msg)) {
    return { kind: 'dns', advice: '域名解析失败：' + host + ' 在本机 DNS 上不存在。请核对地址是否写错或是否已更换域名；很多代理用 fake-ip，浏览器能打开不代表 Node 能解析。' };
  }
  if (/PROXY_REFUSED|ECONNREFUSED/i.test(msg)) return { kind: 'refused', advice: '代理拒绝连接：代理没开，或端口/协议填错了。' };
  if (/PROXY_CONNECT_|PROXY_TUNNEL_EMPTY|隧道/.test(msg)) return { kind: 'proxy-tunnel', advice: msg };
  if (/ECONNRESET|EPIPE|socket hang up/i.test(msg)) return { kind: 'reset', advice: '连接被重置：目标站点或代理节点不可达。' };
  if (/TIMEOUT|ETIMEDOUT|超时/i.test(msg)) return { kind: 'timeout', advice: '连接超时：网络不通或代理节点太慢。' };
  if (/certificate|self-signed|CERT_/i.test(msg)) return { kind: 'tls', advice: '证书校验失败：确认该站证书是否正常。' };
  return { kind: 'other', advice: '原始错误：' + msg };
}

async function diagnose(baseUrl, proxySetting, probePath) {
  const probeUrl = String(baseUrl).replace(/\/+$/, '') + (probePath || '');
  const steps = [];
  const attempts = [];
  const resolved = resolveProxy(proxySetting);
  if (resolved.url) attempts.push({ label: '通过代理 ' + resolved.url + '（' + resolved.source + '）', proxy: resolved.url });
  attempts.push({ label: '直连（不走代理）', proxy: 'off' });

  for (const attempt of attempts) {
    const f = makeFetch(attempt.proxy);
    const t0 = Date.now();
    try {
      const res = await f(probeUrl, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 20000 });
      const reachable = res.status > 0;
      steps.push({
        ok: reachable,
        name: attempt.label,
        detail: 'HTTP ' + res.status + '（' + (Date.now() - t0) + 'ms）' + (res.status >= 400 ? '，网络可达（状态码由服务端返回）' : '')
      });
      if (reachable) return { ok: true, steps, workingProxy: attempt.proxy, viaProxy: attempt.proxy !== 'off' };
    } catch (e) {
      const c = classifyError(e, new URL(probeUrl).hostname);
      steps.push({ ok: false, name: attempt.label, detail: c.kind + '：' + c.advice });
    }
  }
  return { ok: false, steps, workingProxy: null };
}

module.exports = {
  makeFetch, resolveProxy, normalizeProxyUrl, diagnose, classifyError,
  envProxy, windowsSystemProxy, isLocalTarget
};
