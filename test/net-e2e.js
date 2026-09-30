'use strict';
/**
 * 网络层端到端测试（纯本地，用假密钥，不打任何真实中转站）
 * 覆盖：直连 / 经代理 / 本机地址永不走代理 / SSE 流式 / 超时归因
 */
const http = require('http');
const net = require('../server/net');
const relay = require('../server/relay');
const zlib = require('zlib');

let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name + (cond ? '' : '  → ' + extra));
  if (!cond) fail = 1;
};

function makePng(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size); let o = 0;
  for (let y = 0; y < size; y++) { raw[o++] = 0; for (let x = 0; x < size; x++) { raw[o++] = 255; raw[o++] = 180; raw[o++] = 84; } }
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  const crc = (b) => { let c = -1; for (const x of b) c = (c >>> 8) ^ table[(c ^ x) & 0xff]; return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const png = makePng(32);
  let sawAuth = '';
  const relaySrv = http.createServer(async (req, res) => {
    sawAuth = String(req.headers.authorization || '');
    const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-4o' }] }));
    }
    if (req.url === '/v1/images/generations') {
      const stream = String(req.headers.accept || '').includes('text/event-stream') || /"stream":true/.test(body.toString());
      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: png.toString('base64') }) + '\n\n');
        setTimeout(() => {
          res.write('data: ' + JSON.stringify({ type: 'image_generation.completed', b64_json: png.toString('base64') }) + '\n\n');
          res.end('data: [DONE]\n\n');
        }, 40);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'nope' } }));
  });
  await new Promise((r) => relaySrv.listen(0, '127.0.0.1', r));
  const relayUrl = 'http://127.0.0.1:' + relaySrv.address().port;

  // 一个"用了就证明走了代理"的假代理：它只会拒绝，若真被用到就会失败
  const proxySrv = http.createServer((req, res) => { res.writeHead(599); res.end(); });
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r));
  const proxyUrl = 'http://127.0.0.1:' + proxySrv.address().port;

  /* 1. auto 模式下，本机地址不应走代理 */
  {
    const f = net.makeFetch('auto');
    ok('探测到系统代理', Boolean(f.proxy.url) || f.proxy.source === 'none', JSON.stringify(f.proxy));
    const r = await relay.fetchModels({ baseUrl: relayUrl, apiKey: 'sk-fake', allowPrivate: true, fetchImpl: f });
    ok('本机地址绕过代理直连成功', r.total === 2, JSON.stringify(r).slice(0, 120));
    ok('请求带上了 Authorization', sawAuth === 'Bearer sk-fake', sawAuth);
  }

  /* 2. 显式指定一个坏代理时，本机地址仍应绕过它 */
  {
    const f = net.makeFetch(proxyUrl);
    ok('显式代理已被解析', f.proxy.url === proxyUrl, JSON.stringify(f.proxy));
    const r = await relay.fetchModels({ baseUrl: relayUrl, apiKey: 'sk-fake', allowPrivate: true, fetchImpl: f });
    ok('本机地址不因坏代理而失败', r.total === 2, JSON.stringify(r).slice(0, 120));
  }

  /* 3. 直连（off）走非流式生图 */
  {
    const f = net.makeFetch('off');
    const res = await f(relayUrl + '/v1/images/generations', {
      method: 'POST', timeoutMs: 10000,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-fake' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'x', n: 1 })
    });
    ok('直连生图 HTTP 200', res.status === 200, String(res.status));
    const json = JSON.parse(await res.text());
    ok('直连生图能解析出图片', relay.extractImages(json).length === 1, JSON.stringify(json).slice(0, 120));
  }

  /* 4. 流式：SSE 要能逐帧读到（这是以前会崩 getReader 的路径） */
  {
    const f = net.makeFetch('auto');
    const res = await f(relayUrl + '/v1/images/generations', {
      method: 'POST', timeoutMs: 15000,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-fake' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'x', stream: true })
    });
    ok('流式响应有 body.getReader', res.body && typeof res.body.getReader === 'function', typeof res.body);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    ok('读到 partial 帧', /partial_image/.test(text), JSON.stringify(text.slice(0, 80)));
    ok('读到 completed 帧', /completed/.test(text), JSON.stringify(text.slice(0, 120)));
  }

  /* 5. 超时归因 */
  {
    const f = net.makeFetch('off');
    const t0 = Date.now();
    try {
      await f('http://10.255.255.1:9/v1/models', { method: 'GET', timeoutMs: 1200 });
      ok('不可达地址应抛错', false, '竟然成功');
    } catch (e) {
      ok('不可达地址在超时后抛错', Date.now() - t0 < 6000, String(Date.now() - t0) + 'ms');
      ok('错误信息可读', /超时|无法连接|断开/.test(String(e.message)), String(e.message).slice(0, 120));
    }
  }

  relaySrv.close(); proxySrv.close();
  console.log(fail ? '\n\x1b[31m网络层端到端测试失败\x1b[0m' : '\n\x1b[32m网络层端到端测试通过\x1b[0m');
  process.exit(fail);
})();
