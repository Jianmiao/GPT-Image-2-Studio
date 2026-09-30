'use strict';
/**
 * 开发/演示用模拟中转站：实现一套 OpenAI 兼容网关。
 *   node test/mock-relay.js [--port 8899] [--token sk-anything] [--stream]
 * 用于在拿到真实中转站之前，完整验证界面与链路。
 */
const http = require('http');
const { makePng } = require('./png');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(arg('port', 8899));
const TOKEN = arg('token', 'sk-mock-token');
const STREAM = argv.includes('--stream');

const MODELS = [
  'gpt-4o', 'gpt-4o-mini', 'deepseek-chat', 'text-embedding-3-large',
  'gpt-image-2', 'gpt-image-2-vip', 'gpt-image-1', 'gpt-image-1-mini',
  'dall-e-3', 'flux-1.1-pro', 'seedream-4.0', 'nano-banana'
];

let jobNo = 0;

function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const body = await readBody(req);
  const json = (code, obj, headers) => {
    const s = JSON.stringify(obj);
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) }, headers || {}));
    res.end(s);
  };
  const log = (msg) => console.log('[mock-relay] ' + req.method + ' ' + url + ' · ' + msg);

  if (url === '/v1/models') {
    if (!String(req.headers.authorization || '').startsWith('Bearer ')) return json(401, { error: { message: 'missing api key' } });
    log(MODELS.length + ' 个模型');
    return json(200, { object: 'list', data: MODELS.map((id, i) => ({ id, object: 'model', created: 1700000000 + i, owned_by: id.startsWith('gpt') || id.startsWith('dall') ? 'openai' : 'third-party' })) });
  }

  if (url === '/v1/images/generations' || url === '/v1/images/edits') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (token !== TOKEN) return json(401, { error: { message: 'invalid api key: ' + (token || '(empty)'), code: 'invalid_api_key' } }, { 'x-request-id': 'req_mock_' + Date.now() });
    let payload = {};
    if (String(req.headers['content-type'] || '').includes('json')) {
      try { payload = JSON.parse(body.toString('utf8')); } catch (_) {}
    } else {
      const text = body.toString('latin1');
      for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) payload[m[1]] = m[2];
      payload.__images = (text.match(/name="image"; filename=/g) || []).length;
    }
    const n = Math.max(1, Math.min(4, Number(payload.n) || 1));
    log(`model=${payload.model} size=${payload.size} quality=${payload.quality} n=${n} 参考图=${payload.__images || 0}`);
    const [w, h] = /^(\d+)x(\d+)$/.test(payload.size || '') ? payload.size.split('x').map(Number) : [64, 64];
    const png = makePng(Math.min(w, 96), Math.min(h, 96), { seed: jobNo++ });
    const pngs = Array.from({ length: n }, (_, i) => makePng(Math.min(w, 96), Math.min(h, 96), { seed: jobNo + i }));

    // 是否走流式：优先看客户端请求体里的 stream 字段（真中转站也是这样判断的）
    const wantStream = payload.stream === true || payload.stream === 'true' || STREAM;
    if (wantStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      // 先推几帧低清预览（模拟 gpt-image 的 partial_image），再给最终成片
      let step = 0;
      const timer = setInterval(() => {
        step++;
        const partial = makePng(20 + step * 4, 20 + step * 4, { seed: step });
        send({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: partial.toString('base64'), output_format: 'png' });
        log('  ↳ 预览帧 ' + step);
        if (step >= 3) {
          clearInterval(timer);
          const payloadOut = {
            type: 'image_generation.completed',
            b64_json: pngs[0].toString('base64'),
            usage: { input_tokens: 20, output_tokens: 120 * n, total_tokens: 20 + 120 * n, output_tokens_details: { image_tokens: 120 * n } }
          };
          const okWrite = res.write('data: ' + JSON.stringify(payloadOut) + '\n\n');
          log('  ↳ 最终成片 ' + Math.round(JSON.stringify(payloadOut).length / 1024) + 'KB, write=' + okWrite + ', destroyed=' + res.destroyed + ', writableEnded=' + res.writableEnded);
          res.write('data: [DONE]\n\n');
          res.end();
          log('  ↳ 流已结束');
        }
      }, 1100);
      res.on('close', () => clearInterval(timer));
      return;
    }

    setTimeout(() => {
      json(200, {
        created: Math.floor(Date.now() / 1000),
        data: pngs.map((p) => ({ b64_json: p.toString('base64'), revised_prompt: payload.prompt || '' })),
        usage: { input_tokens: 20, output_tokens: 120 * n, total_tokens: 20 + 120 * n, output_tokens_details: { image_tokens: 120 * n } }
      });
    }, 400);
    return;
  }

  if (url === '/v1/chat/completions') {
    const png = makePng(64, 64, { seed: 9 });
    return json(200, { choices: [{ message: { role: 'assistant', content: '这是结果：\n\n![image](data:image/png;base64,' + png.toString('base64') + ')' } }] });
  }

  if (url === '/v1/responses') {
    const png = makePng(64, 64, { seed: 10 });
    return json(200, { output: [{ type: 'image_generation_call', result: png.toString('base64') }] });
  }

  json(404, { error: { message: 'unknown endpoint: ' + url } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock-relay] 模拟中转站已启动：http://127.0.0.1:' + PORT);
  console.log('[mock-relay] API Key：' + TOKEN + (STREAM ? '（流式预览模式）' : ''));
  console.log('[mock-relay] 地址填 http://127.0.0.1:' + PORT + '，记得勾选"允许内网地址"');
});
