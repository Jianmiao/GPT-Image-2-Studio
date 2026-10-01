'use strict';
/**
 * 端到端冒烟测试（不需要真实 API Key）
 *
 * 1. 起一个"模拟中转站"：/v1/models、/v1/images/generations、/v1/images/edits、/v1/chat/completions
 * 2. 起本工具的服务端
 * 3. 走一遍：获取模型 → 文生图（含流式预览帧）→ 图生图 → 单次提交保护 → 错误提示
 */
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离测试数据：历史与图片写到系统临时目录，避免污染真实配置
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-smoke-'));
process.env.GPTIMAGE2_DATA_DIR = TEST_DATA_DIR;
const { start } = require('../server/server');

/* ------------------------- 最小 PNG 编码器 ------------------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size = 8, rgb = [255, 180, 84]) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) { raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2]; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------- 模拟中转站 ------------------------- */

function readAll(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c)));
  });
}

const VALID_KEY = 'sk-test-1234567890';

function createMockRelay({ mode = 'normal' } = {}) {
  const png = makePng();
  const log = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Connection', 'close');
    const body = await readAll(req);
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', size: body.length });
    const send = (code, obj, headers) => {
      const s = JSON.stringify(obj);
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }, headers || {}));
      res.end(s);
    };
    if (req.url === '/fixture/out.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    if (req.url === '/fixture/missing.png') return send(503, { error: 'local image storage unavailable' });
    const imageUrl = 'http://127.0.0.1:' + server.address().port + '/fixture/out.png';
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return send(401, { error: { message: '缺少 API Key' } });
    if (auth.slice(7) !== VALID_KEY) {
      return send(401, { error: { message: '无效的 API Key：当前令牌无法访问该分组', type: 'invalid_request_error', code: 'invalid_api_key' } }, { 'x-request-id': 'req_mock_401' });
    }

    if (req.url === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', owned_by: 'openai' },
          { id: 'text-embedding-3-small', owned_by: 'openai' },
          { id: 'gpt-image-2', owned_by: 'openai' },
          { id: 'gpt-image-2-vip', owned_by: 'relay' },
          { id: 'gpt-image-1', owned_by: 'openai' },
          { id: 'dall-e-3', owned_by: 'openai' },
          { id: 'deepseek-chat', owned_by: 'deepseek' }
        ]
      });
    }

    if (req.url === '/v1/images/generations') {
      if (mode === 'url-result') return send(200, { created: 1, data: [{ url: imageUrl }] });
      if (mode === 'url-failure') return send(200, { created: 1, data: [{ url: imageUrl.replace('out.png', 'missing.png') }] });
      if (mode === 'no-images') return send(200, { created: 1, data: [] });
      if (mode === 'broken-json') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>bad gateway</html>'); }
      return send(200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: png.toString('base64'), revised_prompt: 'mock' }],
        usage: { input_tokens: 12, output_tokens: 100, total_tokens: 112, output_tokens_details: { image_tokens: 100 } }
      });
    }

    if (req.url === '/v1/images/edits') {
      const ctype = String(req.headers['content-type'] || '');
      if (mode === 'edits-405' && ctype.includes('multipart')) return send(405, { error: { message: 'multipart not supported, use json' } });
      if (mode === 'edits-missing' && ctype.includes('json')) return send(404, { error: { message: 'not found' } });
      return send(200, { created: 1, data: [{ b64_json: png.toString('base64') }] });
    }

    if (req.url === '/v1/chat/completions') {
      return send(200, {
        choices: [{ message: { role: 'assistant', content: '![img](' + imageUrl + ')' } }]
      });
    }

    if (req.url === '/v1/responses') {
      return send(200, { output: [{ type: 'image_generation_call', result: png.toString('base64') }] });
    }

    return send(404, { error: { message: 'unknown endpoint ' + req.url } });
  });
  return { server, log };
}

/* ------------------------- 断言辅助 ------------------------- */

function ok(name, cond, extra) {
  if (cond) { console.log('  \x1b[32m✓\x1b[0m ' + name); return true; }
  console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : ''));
  process.exitCode = 1;
  return false;
}

async function post(url, payload) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, ctype: res.headers.get('content-type') || '' };
}

async function sse(url, payload) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await res.text();
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
  }
  return { status: res.status, events, text };
}

/* ------------------------- 主流程 ------------------------- */

(async () => {
  const mock = createMockRelay({ mode: 'normal' });
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const mockUrl = 'http://127.0.0.1:' + mock.server.address().port;
  console.log('模拟中转站：' + mockUrl);

  const app = await start(0, '127.0.0.1');
  console.log('工具服务端：' + app.url);
  const base = app.url;
  const key = VALID_KEY;
  const common = { baseUrl: mockUrl, apiKey: key, allowPrivateHost: true };

  // 0. 健康检查
  const health = await fetch(base + '/api/health').then((r) => r.json());
  ok('GET /api/health', health.ok === true, JSON.stringify(health));

  // 1. 自动获取模型
  try {
    const r = await post(base + '/api/models', common);
    ok('POST /api/models 成功', r.json && r.json.ok === true, r.text.slice(0, 200));
    ok('模型总数 = 7', r.json && r.json.total === 7, String(r.json && r.json.total));
    const imgs = (r.json && r.json.imageModels) || [];
    ok('筛出图像模型 4 个', imgs.length === 4, JSON.stringify(imgs));
    ok('gpt-image-2 排第一', imgs[0] === 'gpt-image-2', JSON.stringify(imgs));
    ok('排除了文本/embedding 模型', !imgs.includes('gpt-4o-mini') && !imgs.includes('text-embedding-3-small'), JSON.stringify(imgs));
  } catch (e) { ok('POST /api/models', false, e.message); }

  // 2. 连通性检测
  try {
    const r = await post(base + '/api/test', common);
    ok('POST /api/test 通过', r.json && r.json.ok === true, r.text.slice(0, 200));
  } catch (e) { ok('POST /api/test', false, e.message); }

  // 3. 文生图（流式）
  try {
    const r = await sse(base + '/api/generate', Object.assign({}, common, {
      model: 'gpt-image-2', prompt: '一只坐在暗房工作台上的虎斑猫', size: '1024x1024', quality: 'high', count: 1, stream: true
    }));
    const types = r.events.map((e) => e.type);
    ok('SSE 返回 start 事件', types.includes('start'), JSON.stringify(types));
    ok('SSE 返回 phase 事件', types.includes('phase'), JSON.stringify(types));
    ok('SSE 返回 done 事件', types.includes('done'), JSON.stringify(types) + ' | ' + r.text.slice(0, 300));
    const done = r.events.find((e) => e.type === 'done');
    if (done) {
      ok('返回 1 张图', done.item.images.length === 1, JSON.stringify(done.item.images));
      ok('图片落地为 /gallery/ 路径', String(done.item.images[0].url).startsWith('/gallery/'), done.item.images[0].url);
      ok('记录了 usage', Boolean(done.item.usage && done.item.usage.imageOutputTokens === 100), JSON.stringify(done.item.usage));
      const imgRes = await fetch(base + done.item.images[0].url);
      ok('图片可通过 /gallery 访问', imgRes.status === 200 && Number(imgRes.headers.get('content-length')) > 50, imgRes.status + ' ' + imgRes.headers.get('content-length'));
    }
  } catch (e) { ok('文生图流式', false, e.message); }

  // 4. 图生图（multipart 上传 → edits）
  try {
    const refPng = 'data:image/png;base64,' + makePng(6, [80, 200, 190]).toString('base64');
    const r = await sse(base + '/api/generate', Object.assign({}, common, {
      model: 'gpt-image-2', prompt: '把背景换成雨夜霓虹街道', size: '1024x1536', count: 1, stream: true,
      images: [refPng, refPng]
    }));
    const done = r.events.find((e) => e.type === 'done');
    ok('图生图成功', Boolean(done), r.text.slice(0, 300));
    if (done) ok('走了 images/edits·multipart', /images\/edits·multipart/.test(done.item.method), done.item.method);
    const editCall = mock.log.filter((l) => l.url === '/v1/images/edits').pop();
    ok('上游收到 multipart 请求', Boolean(editCall) && editCall.size > 200, JSON.stringify(editCall));
  } catch (e) { ok('图生图', false, e.message); }

  // 5. 历史记录持久化
  try {
    const r = await fetch(base + '/api/history').then((x) => x.json());
    ok('历史记录有 2 条', r.items.length === 2, String(r.items.length));
  } catch (e) { ok('历史记录', false, e.message); }

  // 6. 上游 401 → 错误透传
  try {
    const before = mock.log.length;
    const r = await sse(base + '/api/generate', Object.assign({}, common, { apiKey: 'bad', model: 'gpt-image-2', prompt: 'x', stream: true }));
    console.log('    [debug] 本次上游请求：', JSON.stringify(mock.log.slice(before)));
    const err = r.events.find((e) => e.type === 'error');
    ok('上游 401 时返回 error 事件', Boolean(err), r.text.slice(0, 300));
    if (err) {
      ok('错误信息包含鉴权提示', /401|API Key|缺少/.test(err.message), err.message);
      ok('透传上游 request-id', err.requestId === 'req_mock_401', String(err.requestId));
    }
  } catch (e) { ok('401 透传', false, e.message); }

  // 7. 参数校验
  try {
    const r = await post(base + '/api/generate', Object.assign({}, common, { model: 'gpt-image-2', prompt: '' }));
    ok('空提示词被拒绝', r.status === 400 && /提示词/.test(r.json.error || ''), r.text.slice(0, 200));
  } catch (e) { ok('空提示词校验', false, e.message); }

  // 7b. 显式传空 API Key 时不得回落到本地已保存的密钥
  try {
    const r = await post(base + '/api/generate', Object.assign({}, common, { apiKey: '', model: 'gpt-image-2', prompt: 'x' }));
    ok('空 API Key 被拒绝（不回落到本地配置）', r.status === 400 && /API Key/.test(r.json.error || ''), r.text.slice(0, 200));
  } catch (e) { ok('空 Key 校验', false, e.message); }

  // 8. 模型列表接口不可用时的回退
  try {
    const r = await post(base + '/api/models', { baseUrl: 'http://127.0.0.1:9/', apiKey: key, allowPrivateHost: true });
    ok('拉取失败时回退内置模型', r.json && r.json.ok === false && Array.isArray(r.json.imageModels) && r.json.imageModels.includes('gpt-image-2'), r.text.slice(0, 200));
  } catch (e) { ok('模型回退', false, e.message); }

  // 8b. 上游返回图片 URL（而非 base64）
  const mockUrl4 = createMockRelay({ mode: 'url-result' });
  await new Promise((r) => mockUrl4.server.listen(0, '127.0.0.1', r));
  try {
    const r = await post(base + '/api/generate', {
      baseUrl: 'http://127.0.0.1:' + mockUrl4.server.address().port, apiKey: key, allowPrivateHost: true,
      model: 'gpt-image-2', prompt: 'URL 返回', count: 1, stream: false
    });
    const image = r.json && r.json.item && r.json.item.images[0];
    ok('上游图片 URL 自动保存到 gallery', image && image.url.startsWith('/gallery/'), r.text.slice(0, 200));
    if (image && image.url.startsWith('/gallery/')) {
      const actual = fs.readFileSync(path.join(TEST_DATA_DIR, image.url));
      ok('URL 图片逐字节保留原文件', actual.equals(makePng()), 'bytes=' + actual.length);
    }
    const imageGets = mockUrl4.log.filter(entry => entry.url === '/fixture/out.png');
    ok('下载图片只发一次 GET 且不转发密钥', imageGets.length === 1 && imageGets[0].method === 'GET' && imageGets[0].auth === '', JSON.stringify(imageGets));
    ok('URL 图片保存不重复生图', mockUrl4.log.filter(entry => entry.method === 'POST').length === 1);
  } catch (e) { ok('URL 返回', false, e.message); }
  mockUrl4.server.close();

  const missingImage = createMockRelay({ mode: 'url-failure' });
  await new Promise(resolve => missingImage.server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await post(base + '/api/generate', {
      baseUrl: 'http://127.0.0.1:' + missingImage.server.address().port, apiKey: key, allowPrivateHost: true,
      model: 'gpt-image-2', prompt: 'local failed image download', count: 1, stream: false, proxy: 'off'
    });
    const image = r.json && r.json.item && r.json.item.images[0];
    ok('图片下载失败仍保留生成成功及保存错误', r.status === 200 && r.json.ok && image.remote && Boolean(image.saveError), r.text.slice(0, 200));
    ok('下载失败不重发生图请求', missingImage.log.filter(entry => entry.method === 'POST').length === 1);
  } catch (e) { ok('URL 下载失败保留结果', false, e.message); }
  missingImage.server.close();

  // 9. 内网地址默认拦截
  try {
    const r = await post(base + '/api/models', { baseUrl: mockUrl, apiKey: key, allowPrivateHost: false });
    ok('默认拦截内网地址', r.json && r.json.ok === false && /内网/.test(r.json.error || ''), r.text.slice(0, 200));
  } catch (e) { ok('内网拦截', false, e.message); }

  // 10. 编辑接口不支持 multipart 时不自动换格式重发
  const mock2 = createMockRelay({ mode: 'edits-405' });
  await new Promise((r) => mock2.server.listen(0, '127.0.0.1', r));
  try {
    const refPng = 'data:image/png;base64,' + makePng(6).toString('base64');
    const r = await sse(base + '/api/generate', {
      baseUrl: 'http://127.0.0.1:' + mock2.server.address().port, apiKey: key, allowPrivateHost: true,
      model: 'gpt-image-2', prompt: '改图', images: [refPng], count: 1, stream: true
    });
    const err = r.events.find((e) => e.type === 'error');
    ok('multipart 405 后直接返回错误', Boolean(err), JSON.stringify(r.events.map((e) => e.type)));
    const editCalls = mock2.log.filter((entry) => entry.url === '/v1/images/edits');
    ok('multipart 405 时上游只收到 1 次请求', editCalls.length === 1, '实际 ' + editCalls.length);
  } catch (e) { ok('改图单次提交保护', false, e.message); }
  mock2.server.close();

  // 11. 上游返回非 JSON
  const mock3 = createMockRelay({ mode: 'broken-json' });
  await new Promise((r) => mock3.server.listen(0, '127.0.0.1', r));
  try {
    const r = await sse(base + '/api/generate', {
      baseUrl: 'http://127.0.0.1:' + mock3.server.address().port, apiKey: key, allowPrivateHost: true,
      model: 'gpt-image-2', prompt: 'x', count: 1, stream: true
    });
    const err = r.events.find((e) => e.type === 'error');
    ok('上游返回 HTML 时给出可读错误', Boolean(err) && /非 JSON|没有找到图片/.test(err.message), err && err.message);
  } catch (e) { ok('非 JSON 处理', false, e.message); }
  mock3.server.close();

  // 12. 静态资源
  try {
    const idx = await fetch(base + '/');
    const html = await idx.text();
    ok('首页可访问', idx.status === 200 && html.includes('GPT Image 2'), String(idx.status));
    const js = await fetch(base + '/app.js');
    ok('前端脚本可访问', js.status === 200 && (js.headers.get('content-type') || '').includes('javascript'), String(js.status));
    const css = await fetch(base + '/styles.css');
    ok('样式表可访问', css.status === 200, String(css.status));
  } catch (e) { ok('静态资源', false, e.message); }

  mock.server.close();
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log('\n测试数据目录：' + TEST_DATA_DIR + '（已清理）');
  console.log(process.exitCode ? '\n\x1b[31m冒烟测试存在失败项\x1b[0m' : '\n\x1b[32m全部冒烟测试通过\x1b[0m');
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})().catch((e) => {
  console.error('冒烟测试异常：', e);
  process.exit(1);
});
