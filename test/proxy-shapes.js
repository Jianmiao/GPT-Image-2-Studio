'use strict';
/** 代理路径的响应形状测试（纯本地）：SSE 流 / 普通 JSON / 截断 */
const netmod = require('net');
const net = require('../server/net');

let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name + (cond ? '' : '  → ' + extra));
  if (!cond) fail = 1;
};

function startProxy(handler) {
  return new Promise((resolve) => {
    const srv = netmod.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) { handler(sock); buf = ''; }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  /* A. 明文 HTTP + SSE：必须能流式读到，不能崩在 getReader */
  const pA = await startProxy((sock) => {
    sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
    const send = (s) => sock.write(Buffer.byteLength(s, 'utf8').toString(16) + '\r\n' + s + '\r\n');
    setTimeout(() => send('data: {"type":"phase","text":"p1"}\n\n'), 20);
    setTimeout(() => send('data: {"type":"done","item":{}}\n\n'), 60);
    setTimeout(() => { sock.write('0\r\n\r\n'); sock.end(); }, 100);
  });
  try {
    const res = await net.makeFetch('http://127.0.0.1:' + pA.address().port)('http://relay.invalid/v1/images/generations', { method: 'POST', timeoutMs: 8000, body: '{}' });
    ok('明文 HTTP+SSE 有可读流', res.body && typeof res.body.getReader === 'function', 'typeof body=' + typeof res.body);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    ok('SSE 内容完整读出', /phase/.test(text) && /done/.test(text), JSON.stringify(text.slice(0, 80)));
    ok('chunked 解码未把分块头混入内容', !/^[0-9a-f]{1,4}\r\n/.test(text), JSON.stringify(text.slice(0, 40)));
  } catch (e) { ok('明文 HTTP+SSE', false, e.message.slice(0, 120)); }
  pA.close();

  /* B. 明文 HTTP + 普通 JSON（Content-Length） */
  const pB = await startProxy((sock) => {
    const body = '{"data":[{"b64_json":"AAAA"}]}';
    sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    setTimeout(() => sock.end(), 30);
  });
  try {
    const res = await net.makeFetch('http://127.0.0.1:' + pB.address().port)('http://relay.invalid/v1/models', { method: 'GET', timeoutMs: 8000 });
    const text = await res.text();
    ok('明文 HTTP+JSON 正常', res.status === 200 && /b64_json/.test(text), JSON.stringify(text.slice(0, 60)));
  } catch (e) { ok('明文 HTTP+JSON', false, e.message.slice(0, 120)); }
  pB.close();

  console.log(fail ? '\n\x1b[31m代理响应形状测试失败\x1b[0m' : '\n\x1b[32m代理响应形状测试通过\x1b[0m');
  process.exit(fail);
})();
