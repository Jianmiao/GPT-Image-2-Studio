'use strict';
/**
 * GPT Image 2 · 中转站生图工具 —— 本地后端
 *
 * 职责：
 *   1. 托管前端静态资源（同源，规避 CORS）
 *   2. /api/models 依据「API Key + 供应商地址」自动获取可用模型
 *   3. /api/generate 代理生图 / 改图请求（JSON 直返 或 SSE 流式进度）
 *
 * 零依赖：仅使用 Node 内置模块。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const relay = require('./relay');
const net = require('./net');
const { UpstreamError } = relay;

const WEB_DIR = path.join(__dirname, '..', 'web');
const PKG = require('../package.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* --------------------------- 基础工具 --------------------------- */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limitBytes = 96 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大（超过 ' + Math.round(limitBytes / 1048576) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('请求体不是合法 JSON'); }
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

/** 把前端传来的 dataURL / base64 规范化为 { buffer, contentType, filename, dataUrl } */
function normalizeImage(input, index) {
  let s = String(input || '').trim();
  if (!s) throw new Error('第 ' + (index + 1) + ' 张参考图内容为空');
  let mime = 'image/png';
  if (/^data:/i.test(s)) {
    const m = /^data:([^;,]+)[^,]*,/i.exec(s);
    if (m) mime = m[1];
    s = s.slice(s.indexOf(',') + 1);
  } else if (/^https?:\/\//i.test(s)) {
    return { remoteUrl: s, contentType: 'image/png', filename: 'ref-' + (index + 1) + '.png', dataUrl: s };
  }
  const b64 = s.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('第 ' + (index + 1) + ' 张参考图不是合法的 base64 数据');
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw new Error('第 ' + (index + 1) + ' 张参考图解码失败');
  const ext = extFromMime(mime);
  return { buffer, contentType: mime, filename: 'ref-' + (index + 1) + '.' + ext, dataUrl: 'data:' + mime + ';base64,' + b64 };
}

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

/**
 * 取请求参数：请求体里"显式给过"就用请求体的值（哪怕为空串），
 * 只有完全没传时才回落到本地保存的配置。
 */
function pick(obj, key, fallback) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null) {
    return typeof obj[key] === 'string' ? obj[key].trim() : obj[key];
  }
  return fallback;
}

function randomId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
}

/* --------------------------- 上游调用 --------------------------- */

async function upstreamFetch(url, options, timeoutMs, fetchImpl) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, Object.assign({}, options, { signal: ctrl.signal, timeoutMs }));
    return res;
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new Error('等待上游出图超过 ' + Math.round(timeoutMs / 1000) + ' 秒，已放弃。'
        + '通常是该模型在这个中转站上排不上队或本身就慢——先换成 gpt-image-2 试，或在「高级设置」里把超时调到 900 秒。');
    }
    const msg = String((e && e.message) || e);
    const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : '';
    // 代理相关的错误已经在 net.js 里归因清楚了，别再套一层会误导的提示
    if (/经代理请求失败|代理无法连到目标|隧道/.test(msg)) {
      const err = new Error(msg);
      err.cause = e && e.cause;
      throw err;
    }
    throw new Error('无法连接中转站' + (cause ? '（' + cause + '）' : '')
      + '。请检查供应商地址是否正确、网络代理是否可用（界面「网络代理」可点「探测」查看出口）。');
  } finally {
    clearTimeout(timer);
  }
}

/** 解析一次上游响应（支持流式 SSE） */
async function consumeUpstream(res, onPartial) {
  if (!res || !res.headers || (typeof res.headers.get !== 'function')) {
    throw new Error('上游返回了无法解析的响应（可能是网关截断或该接口不被支持）');
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('text/event-stream')) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('上游声称是流式响应，但没有可读数据流（该网关可能不支持 stream，可在高级设置里关掉「流式预览」）');
    }
    return await consumeSse(res, onPartial);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!json) {
    // 有些中转站直接返回二进制图片
    if (/^image\//.test(ctype)) {
      return { images: [{ b64: Buffer.from(text, 'binary').toString('base64'), mime: ctype }], usage: null, text: '' };
    }
    throw new UpstreamError({ status: res.status, message: '上游返回了非 JSON 内容：' + relay.shortBody(text), raw: relay.shortBody(text) });
  }
  return {
    images: relay.extractImages(json),
    usage: relay.extractUsage(json),
    text: relay.extractText(json),
    raw: json
  };
}

/** 读取 SSE 流，透传 partial image 事件 */
async function consumeSse(res, onPartial) {
  const images = [];
  let usage = null;
  let text = '';
  let errored = null;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const handleEvent = (raw) => {
    const dataLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return;
    let ev = null;
    try { ev = JSON.parse(data); } catch (_) { return; }
    const type = String(ev.type || '');
    if (type.includes('error') || ev.error) {
      errored = (ev.error && (ev.error.message || ev.error.code)) || ev.message || '上游流式返回错误';
      return;
    }
    if (type.includes('image_generation.partial_image') || type.includes('partial_image')) {
      const b64 = ev.b64_json || ev.partial_image_b64 || (ev.item && ev.item.result);
      if (typeof b64 === 'string' && b64.length > 64) {
        const index = Number(ev.partial_image_index || ev.output_index || 0) || 0;
        images[index] = { b64 };
        if (onPartial) onPartial({ index, b64, mime: ev.output_format ? 'image/' + ev.output_format : 'image/png' });
      }
      return;
    }
    if (type.includes('image_generation.completed') || type.includes('response.completed') || type.includes('image_generation_call')) {
      const node = ev.item || ev.response || ev;
      const got = relay.extractImages(node);
      got.forEach((img, i) => { if (!images[i]) images[i] = img; });
      const u = relay.extractUsage(ev.response || ev);
      if (u) usage = u;
      const t = relay.extractText(ev.response || ev);
      if (t) text = t;
      return;
    }
    // 兼容中转站把 OpenAI 普通 JSON 包进 SSE 的情况
    const got = relay.extractImages(ev);
    if (got.length) got.forEach((img, i) => { if (!images[i]) images[i] = img; });
    const u = relay.extractUsage(ev);
    if (u) usage = u;
  };

  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() || '';
    for (const p of parts) handleEvent(p);
  }
  if (buf.trim()) handleEvent(buf);
  if (errored && !images.filter(Boolean).length) {
    throw new UpstreamError({ status: 502, message: errored });
  }
  return { images: images.filter(Boolean), usage, text };
}

/* --------------------------- 业务：模型 --------------------------- */

async function handleModels(body) {
  const cfg = store.getConfig();
  const baseUrl = pick(body, 'baseUrl', cfg.baseUrl);
  const apiKey = pick(body, 'apiKey', cfg.apiKey);
  const allowPrivate = body.allowPrivateHost !== undefined ? Boolean(body.allowPrivateHost) : cfg.allowPrivateHost;
  if (!baseUrl) throw new Error('请先填写供应商地址（Base URL）');
  if (!apiKey) throw new Error('请先填写 API Key');

  const fetchImpl = net.makeFetch(pick(body, 'proxy', cfg.proxy));
  try {
    const r = await relay.fetchModels({ baseUrl, apiKey, allowPrivate, fetchImpl });
    return {
      ok: true,
      source: 'api',
      url: r.url,
      total: r.total,
      models: r.models,
      imageModels: r.imageModels,
      proxy: fetchImpl.proxy,
      endpoint: relay.normalizeBaseUrl(baseUrl)
    };
  } catch (e) {
    // 回退：接口不可用时给出常见模型名，允许用户手填
    let advice = '';
    let kind = '';
    try {
      const c = net.classifyError(e, new URL(relay.normalizeBaseUrl(baseUrl)).hostname);
      advice = c.advice;
      kind = c.kind;
    } catch (_) {}
    return {
      ok: false,
      source: 'builtin',
      error: e.message,
      advice,
      kind,
      proxy: fetchImpl.proxy,
      models: relay.BUILTIN_IMAGE_MODELS,
      imageModels: relay.BUILTIN_IMAGE_MODELS,
      endpoint: relay.endpointPreview(baseUrl)
    };
  }
}

/* --------------------------- 业务：生成 --------------------------- */

function buildCommonParams(body, cfg) {
  const images = Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 10) : [];
  // 接受用户常用的“宽*高”写法，统一转换成上游 API 要求的“宽x高”。
  const size = String(body.size || cfg.size || 'auto').trim().replace(/\s*\*\s*/g, 'x');
  return {
    model: String(body.model || cfg.model || 'gpt-image-2').trim(),
    prompt: String(body.prompt || '').trim(),
    size,
    quality: String(body.quality || cfg.quality || 'auto').trim(),
    background: String(body.background || cfg.background || 'auto').trim(),
    outputFormat: String(body.outputFormat || cfg.outputFormat || 'auto').trim(),
    moderation: String(body.moderation || cfg.moderation || 'auto').trim(),
    count: Math.max(1, Math.min(10, Number(body.count || cfg.count || 1) || 1)),
    timeoutSeconds: Math.max(30, Math.min(3600, Number(body.timeoutSeconds || cfg.timeoutSeconds || 600))),
    method: String(body.method || cfg.method || 'auto'),
    editEndpoint: String(body.editEndpoint || cfg.editEndpoint || 'auto'),
    stream: body.stream === undefined ? Boolean(cfg.streamUpstream) : Boolean(body.stream),
    rawImages: images,
    images: images.map((s, i) => normalizeImage(s, i))
  };
}

/**
 * 每次生成只向上游提交一次。
 * 返回 { images, usage, text, method, attempts }
 */
async function generateWithFallback(params, opts, hooks) {
  const { baseUrl, apiKey } = opts;
  const timeoutMs = params.timeoutSeconds * 1000;
  const isEdit = params.images.length > 0;
  const attempts = [];

  const method = params.method && params.method !== 'auto' ? params.method : 'images';
  const variant = method === 'images' && isEdit
    ? (params.editEndpoint === 'json' ? 'json' : 'multipart')
    : 'default';
  const label = method === 'images'
    ? (isEdit ? 'images/edits·' + variant : 'images/generations')
    : method;
  if (hooks && hooks.onPhase) hooks.onPhase('正在调用 ' + label + ' …');

  try {
    const result = await runMethod(method, variant, params, opts, timeoutMs, hooks);
    if (result.images && result.images.length) {
      attempts.push({ method: label, ok: true });
      return Object.assign(result, { method: label, attempts });
    }
    const err = new UpstreamError({
      status: 200,
      message: '接口调用成功，但返回内容里没有找到图片数据（本次只提交了一次）'
    });
    attempts.push({ method: label, ok: false, error: err.message });
    err.attempts = attempts;
    throw err;
  } catch (e) {
    if (!attempts.length) attempts.push({ method: label, ok: false, error: e.message });
    e.attempts = attempts;
    throw e;
  }
}

async function runMethod(method, variant, params, opts, timeoutMs, hooks) {
  const { baseUrl, apiKey } = opts;
  const headers = relay.makeHeaders(apiKey);
  let url, init;

  if (method === 'images' && params.images.length === 0) {
    url = relay.buildUrl(baseUrl, 'images/generations');
    const payload = relay.buildImagesPayload(params, 'images');
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(payload) };
  } else if (method === 'images' && variant === 'gen-with-image') {
    // 图生图但走生图接口：把参考图放进 image 字段（字符串或数组都试）
    url = relay.buildUrl(baseUrl, 'images/generations');
    const payload = relay.buildImagesPayload(params, 'images');
    payload.image = params.images.length === 1 ? params.images[0].dataUrl : params.images.map((i) => i.dataUrl);
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(payload) };
  } else if (method === 'images') {
    if (variant === 'multipart') {
      url = relay.buildUrl(baseUrl, 'images/edits');
      const fields = {
        model: params.model,
        prompt: params.prompt,
        n: params.count,
        size: params.size
      };
      if (params.quality && params.quality !== 'auto') fields.quality = params.quality;
      if (params.background && params.background !== 'auto') fields.background = params.background;
      if (params.outputFormat && params.outputFormat !== 'auto') fields.output_format = params.outputFormat;
      const files = params.images.map((img, i) => ({
        field: 'image',
        filename: img.filename || 'ref-' + (i + 1) + '.png',
        contentType: img.contentType || 'image/png',
        buffer: img.buffer
      }));
      const enc = relay.encodeMultipart(fields, files);
      headers['Content-Type'] = enc.contentType;
      init = { method: 'POST', headers, body: enc.body };
    } else {
      url = relay.buildUrl(baseUrl, 'images/edits');
      const payload = relay.buildImagesPayload(params, 'images');
      payload.image = params.images.length === 1 ? params.images[0].dataUrl : params.images.map((i) => i.dataUrl);
      headers['Content-Type'] = 'application/json';
      init = { method: 'POST', headers, body: JSON.stringify(payload) };
    }
  } else if (method === 'responses') {
    url = relay.buildUrl(baseUrl, 'responses');
    const payload = relay.buildResponsesPayload(params);
    if (params.images.length) {
      payload.input = [{ role: 'user', content: [{ type: 'input_text', text: params.prompt }].concat(params.images.map((i) => ({ type: 'input_image', image_url: i.dataUrl }))) }];
    }
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(payload) };
  } else if (method === 'chat') {
    url = relay.buildUrl(baseUrl, 'chat/completions');
    const payload = relay.buildChatPayload(params);
    headers['Content-Type'] = 'application/json';
    init = { method: 'POST', headers, body: JSON.stringify(payload) };
  } else {
    throw new Error('未知的调用方式：' + method);
  }

  const res = await upstreamFetch(url, init, timeoutMs, opts.fetchImpl);
  if (!res.ok) {
    const info = await relay.readError(res);
    throw new UpstreamError(info);
  }
  const onPartial = hooks && hooks.onPartial ? hooks.onPartial : null;
  const out = await consumeUpstream(res, onPartial);
  return { images: out.images, usage: out.usage, text: out.text || '', url };
}

/* --------------------------- 落盘历史 --------------------------- */

function persistImages(id, images) {
  const saved = [];
  images.forEach((img, i) => {
    if (img.b64) {
      const ext = extFromMime(img.mime || 'image/png');
      try {
        const info = store.saveImage(id, i, img.b64, ext);
        saved.push({ url: info.url, bytes: info.bytes, mime: 'image/' + ext });
      } catch (_) {
        saved.push({ url: 'data:' + (img.mime || 'image/png') + ';base64,' + img.b64, inline: true });
      }
    } else if (img.url) {
      saved.push({ url: img.url, remote: !img.url.startsWith('data:') });
    }
  });
  return saved;
}

/* --------------------------- HTTP 路由 --------------------------- */

async function handleGenerate(req, res, body) {
  const cfg = store.getConfig();
  const baseUrl = pick(body, 'baseUrl', cfg.baseUrl);
  const apiKey = pick(body, 'apiKey', cfg.apiKey);
  const allowPrivate = body.allowPrivateHost !== undefined ? Boolean(body.allowPrivateHost) : cfg.allowPrivateHost;
  if (!baseUrl) throw new Error('请先填写供应商地址（Base URL）');
  if (!apiKey) throw new Error('请先填写 API Key');

  const fetchImpl = net.makeFetch(pick(body, 'proxy', cfg.proxy));
  const params = buildCommonParams(body, cfg);
  if (!params.prompt) throw new Error('请输入提示词');
  if (!params.model) throw new Error('请先选择或填写模型名称');

  relay.assertHostAllowed(baseUrl, allowPrivate);

  const started = Date.now();
  const id = randomId();
  const streamMode = body.stream !== false; // 默认流式返回进度

  let sse = null;
  const partials = [];
  const hooks = {
    onPhase: (text) => { if (sse) sse.send({ type: 'phase', text }); },
    onPartial: (p) => {
      partials.push(p);
      if (sse) sse.send({ type: 'partial', index: p.index, b64: p.b64, mime: p.mime });
    }
  };

  if (streamMode) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    let alive = true;
    const heartbeat = setInterval(() => {
      if (alive) {
        try { res.write(': ping ' + Date.now() + '\n\n'); } catch (_) {}
      }
    }, 10000);
    sse = {
      send(obj) {
        if (!alive) return;
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {}
      }
    };
    req.on('close', () => { alive = false; clearInterval(heartbeat); });
    sse.send({ type: 'start', id, method: params.method, model: params.model, at: Date.now() });
    try {
      const result = await generateWithFallback(params, { baseUrl, apiKey, fetchImpl }, hooks);
      const images = persistImages(id, result.images);
      const elapsed = Date.now() - started;
      const item = {
        id,
        createdAt: new Date().toISOString(),
        elapsedMs: elapsed,
        model: params.model,
        prompt: params.prompt,
        size: params.size,
        quality: params.quality,
        background: params.background,
        outputFormat: params.outputFormat,
        count: result.images.length,
        method: result.method,
        usage: result.usage || null,
        text: result.text || '',
        hasRefs: params.images.length > 0,
        refCount: params.images.length,
        images
      };
      store.addHistory(item);
      sse.send({ type: 'done', item });
    } catch (e) {
      sse.send({
        type: 'error',
        message: e.message || '生成失败',
        status: e.status || 0,
        requestId: e.requestId || '',
        raw: e.raw || '',
        attempts: e.attempts || []
      });
    } finally {
      alive = false;
      clearInterval(heartbeat);
      try { res.end(); } catch (_) {}
    }
    return;
  }

  // 非流式（同步 JSON）
  const result = await generateWithFallback(params, { baseUrl, apiKey, fetchImpl }, hooks);
  const images = persistImages(id, result.images);
  const item = {
    id, createdAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    model: params.model, prompt: params.prompt, size: params.size, quality: params.quality,
    background: params.background, outputFormat: params.outputFormat,
    count: result.images.length, method: result.method, usage: result.usage || null,
    text: result.text || '', hasRefs: params.images.length > 0, refCount: params.images.length, images
  };
  store.addHistory(item);
  return item;
}

async function handleTest(body) {
  const cfg = store.getConfig();
  const baseUrl = pick(body, 'baseUrl', cfg.baseUrl);
  const apiKey = pick(body, 'apiKey', cfg.apiKey);
  const allowPrivate = body.allowPrivateHost !== undefined ? Boolean(body.allowPrivateHost) : cfg.allowPrivateHost;
  const out = { endpoint: relay.endpointPreview(baseUrl), steps: [] };

  if (!apiKey) { out.steps.push({ name: 'API Key', ok: false, detail: '未填写' }); out.ok = false; return out; }
  try { relay.assertHostAllowed(baseUrl, allowPrivate); }
  catch (e) { out.steps.push({ name: '地址校验', ok: false, detail: e.message }); out.ok = false; return out; }

  // 1) 网络通路诊断（自动探测系统代理，再退回直连）
  const proxySetting = pick(body, 'proxy', cfg.proxy);
  const detected = net.resolveProxy(proxySetting);
  out.steps.push({
    name: '网络出口',
    ok: true,
    detail: detected.url ? ('使用代理 ' + detected.url + '（来源：' + detected.source + '）') : '直连（未检测到代理）'
  });
  const diag = await net.diagnose(relay.normalizeBaseUrl(baseUrl), proxySetting, '/v1/models');
  for (const st of diag.steps) out.steps.push({ name: '通路检测 · ' + st.name, ok: st.ok, detail: st.detail });
  const effProxy = diag.workingProxy !== null ? diag.workingProxy : proxySetting;
  const fetchImpl = net.makeFetch(effProxy === 'off' ? 'off' : effProxy);

  // 2) 鉴权可用性（/v1/models）
  try {
    const r = await relay.fetchModels({ baseUrl, apiKey, allowPrivate, fetchImpl });
    out.steps.push({ name: 'GET /v1/models', ok: true, detail: '共 ' + r.total + ' 个模型，其中图像模型 ' + r.imageModels.length + ' 个：' + r.imageModels.slice(0, 6).join(', ') });
    out.imageModels = r.imageModels;
  } catch (e) {
    const c = net.classifyError(e, new URL(relay.normalizeBaseUrl(baseUrl)).hostname);
    out.steps.push({ name: 'GET /v1/models', ok: false, detail: c.kind + '：' + c.advice });
  }
  // 2) Key 是否像 JWT（部分中转站用 JWT，可读到期时间）
  const exp = relay.decodeJwtExp(apiKey);
  if (exp) out.steps.push({ name: 'API Key 类型', ok: exp > Date.now(), detail: 'JWT 令牌，到期时间 ' + new Date(exp).toLocaleString('zh-CN') });
  out.ok = out.steps.some((s) => s.ok);
  return out;
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(WEB_DIR)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) { sendJson(res, 404, { error: 'not found', path: rel }); return; }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
  });
}

function serveGallery(req, res, urlPath) {
  const name = urlPath.replace(/^\/gallery\//, '');
  const file = store.galleryPath(name);
  if (!file) { sendJson(res, 404, { error: 'not found' }); return; }
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
  fs.createReadStream(file).pipe(res);
}

/** 远程图片中转下载（避免浏览器 CORS 限制） */
async function proxyDownload(req, res, query) {
  const target = query.get('url');
  if (!target) { sendJson(res, 400, { error: '缺少 url 参数' }); return; }
  let u;
  try { u = new URL(target); } catch (_) { sendJson(res, 400, { error: 'url 不合法' }); return; }
  if (!/^https?:$/.test(u.protocol)) { sendJson(res, 400, { error: '仅支持 http/https' }); return; }
  const cfg = store.getConfig();
  if (!cfg.allowPrivateHost && relay.isPrivateHost(u.hostname)) { sendJson(res, 403, { error: '禁止访问内网地址' }); return; }
  try {
    const upstream = await upstreamFetch(u.toString(), { method: 'GET' }, 60000, net.makeFetch(cfg.proxy));
    if (!upstream.ok) { sendJson(res, upstream.status, { error: '远程下载失败 HTTP ' + upstream.status }); return; }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="' + (query.get('name') || 'image.png') + '"'
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

const routes = {
  'GET /api/health': async (req, res) => sendJson(res, 200, { ok: true, version: PKG.version, node: process.version, uptime: Math.round(process.uptime()) }),
  'GET /api/config': async (req, res) => sendJson(res, 200, store.publicConfig()),
  'POST /api/config': async (req, res) => {
    const body = await readJsonBody(req);
    const saved = store.saveConfig(body);
    sendJson(res, 200, Object.assign({}, saved, { apiKey: '', apiKeyMasked: store.maskKey(saved.apiKey), hasApiKey: Boolean(saved.apiKey) }));
  },
  'POST /api/models': async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await handleModels(body));
  },
  'POST /api/test': async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await handleTest(body));
  },
  'POST /api/endpoints': async (req, res) => {
    const body = await readJsonBody(req);
    const cfg = store.getConfig();
    const preview = relay.endpointPreview(body.baseUrl || cfg.baseUrl);
    preview.proxy = net.resolveProxy(pick(body, 'proxy', cfg.proxy));
    sendJson(res, 200, preview);
  },
  'POST /api/generate': async (req, res) => {
    const body = await readJsonBody(req);
    const item = await handleGenerate(req, res, body);
    if (item) sendJson(res, 200, { ok: true, item });
  },
  'GET /api/history': async (req, res) => sendJson(res, 200, { items: store.getHistory() }),
  'DELETE /api/history': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const items = id ? store.removeHistory(id) : store.clearHistory();
    sendJson(res, 200, { ok: true, items });
  },
  'GET /api/download': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    await proxyDownload(req, res, url.searchParams);
  }
};

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlPath = (req.url || '/').split('?')[0];
  try {
    const key = req.method + ' ' + urlPath;
    const handler = routes[key];
    if (handler) {
      await handler(req, res);
      return;
    }
    if (/^\/api\//.test(urlPath)) { sendJson(res, 404, { error: '未知接口 ' + key }); return; }
    if (/^\/gallery\//.test(urlPath)) { serveGallery(req, res, urlPath); return; }
    serveStatic(req, res, urlPath);
  } catch (e) {
    if (res.headersSent) {
      try { res.end(); } catch (_) {}
    } else {
      sendJson(res, e instanceof UpstreamError ? (e.status >= 400 && e.status < 600 ? e.status : 502) : 400, {
        error: e.message || '服务端错误',
        status: e.status || 0,
        requestId: e.requestId || '',
        raw: e.raw || '',
        attempts: e.attempts || []
      });
    }
  } finally {
    const ms = Date.now() - started;
    if (process.env.GPTIMAGE2_VERBOSE) console.log('[%s] %s %sms', req.method, urlPath, ms);
  }
});

function start(port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({ port: p, url: 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + p });
    });
  });
}

module.exports = {
  server, start, buildCommonParams, generateWithFallback, persistImages, randomId, extFromMime,
  // 供测试使用的内部函数
  consumeUpstream, consumeSse, upstreamFetch, handleModels, handleGenerate
};
