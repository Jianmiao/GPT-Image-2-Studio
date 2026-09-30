'use strict';
/**
 * 中转站（OpenAI 兼容网关）适配层
 * 负责：URL 归一化、模型自动获取、多种图像协议调用、结果抽取。
 */
const net = require('net');

/* ---------------------------- URL 归一化 ---------------------------- */

const KNOWN_SUFFIXES = ['/v1/images/generations', '/v1/images/edits', '/v1/models', '/v1/chat/completions', '/v1/responses'];

function normalizeBaseUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('请先填写供应商地址（Base URL）');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new Error('供应商地址格式不正确：' + input);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 地址');
  let pathname = u.pathname.replace(/\/+$/, '');
  for (const suffix of KNOWN_SUFFIXES) {
    if (pathname.toLowerCase().endsWith(suffix)) {
      pathname = pathname.slice(0, pathname.length - suffix.length);
      break;
    }
  }
  // 去掉末尾的 /v1，统一由后面拼接
  if (/\/v1$/i.test(pathname)) pathname = pathname.slice(0, -3);
  return (u.origin + pathname).replace(/\/+$/, '') || u.origin;
}

function buildUrl(baseUrl, endpoint) {
  const base = normalizeBaseUrl(baseUrl);
  const ep = String(endpoint || '').replace(/^\/*/, '');
  return base + '/v1/' + ep;
}

function endpointPreview(baseUrl) {
  try {
    return {
      base: normalizeBaseUrl(baseUrl),
      models: buildUrl(baseUrl, 'models'),
      generations: buildUrl(baseUrl, 'images/generations'),
      edits: buildUrl(baseUrl, 'images/edits'),
      responses: buildUrl(baseUrl, 'responses'),
      chat: buildUrl(baseUrl, 'chat/completions')
    };
  } catch (e) {
    return { error: e.message };
  }
}

/* ---------------------------- SSRF 防护 ---------------------------- */

const PRIVATE_V4 = [
  [/^10\./, true], [/^127\./, true], [/^169\.254\./, true],
  [/^172\.(1[6-9]|2\d|3[01])\./, true], [/^192\.168\./, true],
  [/^0\./, true], [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, true]
];

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  if (net.isIPv4(h)) return PRIVATE_V4.some(([re, v]) => v && re.test(h));
  if (net.isIPv6(h)) return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false; // 域名交给 DNS，不做二次解析（最多本地使用，风险可接受）
}

function assertHostAllowed(baseUrl, allowPrivate) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  void u;
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new Error('出于安全默认禁止访问内网地址（' + u.hostname + '）。如确需自建中转，请在配置中开启"允许内网地址"。');
  }
  return u;
}

/* ------------------------------ 模型列表 ------------------------------ */

const IMAGE_HINTS = /(gpt-image|gpt_image|dall-?e|image|imagery|flux|sd[-_]?\d|stable-?diffusion|midjourney|mj[-_]|nano-?banana|banana|seedream|seededit|kolors|hunyuan-?image|qwen-?image|wanx|doubao[-_]?seed|glm-?image|cogview|ideogram|recraft|imagen|photon|sora-?image|kling)/i;
const NEGATIVE_HINTS = /(embedding|whisper|tts|audio|speech|rerank|moderation|vision-only|text-embedding)/i;
const STRONG = /gpt-image|dall-?e|^image-|image-1|nano-?banana|seedream|flux|imagen|ideogram|midjourney/i;

function looksLikeImageModel(id) {
  const s = String(id || '');
  if (!s) return false;
  if (NEGATIVE_HINTS.test(s)) return false;
  return IMAGE_HINTS.test(s);
}

function rankImageModel(id) {
  const s = String(id).toLowerCase();
  if (/gpt-image-2(?![0-9])/.test(s)) return 0;
  if (/gpt-image-2/.test(s)) return 1;
  if (/gpt-image/.test(s)) return 2;
  if (/dall-e-3/.test(s)) return 3;
  if (/dall-e/.test(s)) return 4;
  if (/seedream|nano-?banana|imagen|ideogram|flux/.test(s)) return 5;
  return 6;
}

/** 把各种 /v1/models 返回结构压平成 {id, owned_by, created} 数组 */
function parseModelList(payload) {
  if (!payload) return [];
  let arr = null;
  if (Array.isArray(payload)) arr = payload;
  else if (Array.isArray(payload.data)) arr = payload.data;
  else if (Array.isArray(payload.models)) arr = payload.models;
  else if (Array.isArray(payload.result)) arr = payload.result;
  else if (payload.data && Array.isArray(payload.data.models)) arr = payload.data.models;
  if (!arr) return [];
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    let id = '';
    let owned = '';
    let created = 0;
    if (typeof it === 'string') id = it;
    else if (it && typeof it === 'object') {
      id = it.id || it.model || it.name || it.slug || '';
      owned = it.owned_by || it.owner || it.provider || (it.owned_by === undefined && it.organization) || '';
      created = Number(it.created || it.created_at || 0) || 0;
    }
    id = String(id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, owned_by: String(owned || ''), created });
  }
  return out;
}

/** 拉取模型列表：先用 /v1/models，失败再试 /models */
async function fetchModels(opts) {
  const { baseUrl, apiKey, allowPrivate, timeoutMs = 30000, fetchImpl } = opts || {};
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  assertHostAllowed(baseUrl, allowPrivate);
  const candidates = [buildUrl(baseUrl, 'models')];
  const bare = normalizeBaseUrl(baseUrl) + '/models';
  if (!candidates.includes(bare)) candidates.push(bare);

  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers: Object.assign({ Accept: 'application/json' }, apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status + ' ' + shortBody(text));
        continue;
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) { lastErr = new Error('返回内容不是 JSON：' + shortBody(text)); continue; }
      const list = parseModelList(json);
      if (!list.length) { lastErr = new Error('接口返回成功，但未解析到模型列表'); continue; }
      const imageModels = list.filter((m) => looksLikeImageModel(m.id)).sort((a, b) => rankImageModel(a.id) - rankImageModel(b.id) || a.id.localeCompare(b.id));
      return { url, total: list.length, models: list.map((m) => m.id), imageModels: imageModels.map((m) => m.id), all: list };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('获取模型列表失败：' + (lastErr && lastErr.message ? lastErr.message : '未知错误'));
}

/* ---------------------------- 调用上游 ---------------------------- */

const BUILTIN_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2-vip', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'];

function shortBody(text, n = 400) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function decodeJwtExp(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch (_) { return null; }
}

function makeHeaders(apiKey, extra) {
  return Object.assign({ Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }, extra || {});
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch (_) {}
  let msg = '';
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || j.error.code)) || j.message || j.msg || j.detail || '';
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch (_) { msg = shortBody(text); }
  return { status: res.status, message: msg || ('HTTP ' + res.status), raw: shortBody(text), requestId: res.headers.get('x-request-id') || '' };
}

class UpstreamError extends Error {
  constructor(info) {
    super(info.message);
    this.name = 'UpstreamError';
    this.status = info.status;
    this.requestId = info.requestId;
    this.raw = info.raw;
  }
}

/* --------------------- multipart/form-data 编码 --------------------- */

function encodeMultipart(fields, files) {
  const boundary = '----GPTImage2' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const chunks = [];
  const push = (s) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
  for (const [name, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    push('--' + boundary + '\r\n');
    push('Content-Disposition: form-data; name="' + name + '"\r\n\r\n');
    push(String(value) + '\r\n');
  }
  for (const f of files || []) {
    push('--' + boundary + '\r\n');
    push('Content-Disposition: form-data; name="' + f.field + '"; filename="' + f.filename + '"\r\n');
    push('Content-Type: ' + f.contentType + '\r\n\r\n');
    push(f.buffer);
    push('\r\n');
  }
  push('--' + boundary + '--\r\n');
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}

/* --------------------------- 请求构造 --------------------------- */

// 全部为 16 的倍数；非 16 倍数或超出模型允许集合的尺寸会被上游 400 拒绝
const STANDARD_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '1152x2048'];
const SAFE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
/** 宽高是否都是 16 的倍数 */
function isSizeUsable(size) {
  if (!size || String(size).toLowerCase() === 'auto') return true;
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(String(size).trim());
  if (!m) return false;
  return Number(m[1]) % 16 === 0 && Number(m[2]) % 16 === 0;
}

function buildImagesPayload(params, method) {
  const payload = {
    model: params.model,
    prompt: params.prompt,
    n: Math.max(1, Math.min(10, Number(params.count) || 1)),
    size: params.size || 'auto'
  };
  if (params.quality && params.quality !== 'auto') payload.quality = params.quality;
  if (params.background && params.background !== 'auto') payload.background = params.background;
  if (params.moderation && params.moderation !== 'auto') payload.moderation = params.moderation;
  if (params.outputFormat && params.outputFormat !== 'auto') {
    payload.output_format = params.outputFormat;
    if (!/^gpt-image/i.test(String(params.model))) delete payload.output_format;
  }
  if (params.stream) payload.stream = true;
  return payload;
}

function buildResponsesPayload(params) {
  const tool = { type: 'image_generation' };
  if (params.size && params.size !== 'auto') tool.size = params.size;
  if (params.quality && params.quality !== 'auto') tool.quality = params.quality;
  if (params.background && params.background !== 'auto') tool.background = params.background;
  if (params.outputFormat && params.outputFormat !== 'auto') tool.output_format = params.outputFormat;
  const body = {
    model: params.chatModel || params.model,
    input: params.prompt,
    tools: [tool]
  };
  return body;
}

function buildChatPayload(params) {
  const content = [{ type: 'text', text: params.prompt }];
  for (const img of params.images || []) {
    content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  return { model: params.model, messages: [{ role: 'user', content }], stream: false };
}

/** 判断编辑接口是否应使用 JSON（部分中转站的 edits 接受 JSON + 图片 URL/base64） */
function shouldUseJsonEdit(params) {
  if (params.editEndpoint === 'json') return true;
  if (params.editEndpoint === 'multipart') return false;
  return false; // auto：默认 multipart，失败后由调用方重试 JSON
}

/* --------------------------- 结果抽取 --------------------------- */

/** 从各种可能的返回结构中抽出图片：{ b64, url, mime } */
function extractImages(json) {
  const found = [];
  const pushB64 = (b64, mime) => { if (typeof b64 === 'string' && b64.length > 64) found.push({ b64, mime: mime || 'image/png' }); };
  const pushUrl = (u) => { if (typeof u === 'string' && /^(https?:|data:)/.test(u)) found.push({ url: u }); };
  const visit = (node, depth) => {
    if (!node || depth > 8) return;
    if (typeof node === 'string') {
      if (/^data:image\//.test(node)) { const i = node.indexOf(','); pushB64(node.slice(i + 1), node.slice(5, node.indexOf(';'))); }
      else if (/^https?:\/\//.test(node) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(node)) pushUrl(node);
      return;
    }
    if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
    if (typeof node !== 'object') return;

    const keys = Object.keys(node);
    if (typeof node.b64_json === 'string') pushB64(node.b64_json, node.mime_type || node.mimeType);
    if (typeof node.image_base64 === 'string') pushB64(node.image_base64, node.mime_type);
    if (typeof node.base64 === 'string' && node.base64.length > 256) pushB64(node.base64, node.mime_type);
    if (typeof node.image_url === 'string') pushUrl(node.image_url);
    if (typeof node.url === 'string' && /^(https?:|data:image)/.test(node.url)) pushUrl(node.url);
    if (typeof node.result === 'string') {
      if (/^data:image\//.test(node.result)) { const i = node.result.indexOf(','); pushB64(node.result.slice(i + 1)); }
      else if (/^[A-Za-z0-9+/=\s]{512,}$/.test(node.result)) pushB64(node.result.replace(/\s/g, ''), node.mime_type);
      else if (/^https?:\/\//.test(node.result)) pushUrl(node.result);
    }
    if (node.image && typeof node.image === 'object') visit(node.image, depth + 1);
    // markdown ![](url) 形式的返回
    if (typeof node.text === 'string') {
      const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
      let m;
      while ((m = re.exec(node.text))) pushUrl(m[1]);
    }
    for (const k of keys) {
      if (k === 'b64_json' || k === 'image_base64' || k === 'result' || k === 'text') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(json, 0);
  // 去重
  const seen = new Set();
  const out = [];
  for (const img of found) {
    const key = img.b64 ? img.b64.slice(0, 96) + img.b64.length : img.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(img);
  }
  return out;
}

function extractText(json) {
  if (!json || typeof json !== 'object') return '';
  if (typeof json.output_text === 'string') return json.output_text;
  const chunks = [];
  const visit = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'output_text' && typeof node.text === 'string') chunks.push(node.text);
    if (typeof node.message === 'string' && node.role === 'assistant') chunks.push(node.message);
    Object.values(node).forEach((v) => { if (v && typeof v === 'object') visit(v, depth + 1); });
  };
  visit(json, 0);
  return chunks.join('\n').trim();
}

function extractUsage(json) {
  const u = json && (json.usage || (json.response && json.response.usage));
  if (!u) return null;
  const out = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.total_tokens !== undefined) out.totalTokens = u.total_tokens;
  if (u.input_tokens_details && u.input_tokens_details.image_tokens !== undefined) out.imageInputTokens = u.input_tokens_details.image_tokens;
  if (u.output_tokens_details && u.output_tokens_details.image_tokens !== undefined) out.imageOutputTokens = u.output_tokens_details.image_tokens;
  return Object.keys(out).length ? out : null;
}

module.exports = {
  normalizeBaseUrl, buildUrl, endpointPreview, assertHostAllowed, isPrivateHost,
  parseModelList, fetchModels, looksLikeImageModel, rankImageModel,
  IMAGE_HINTS, BUILTIN_IMAGE_MODELS, STANDARD_SIZES,
  encodeMultipart, buildImagesPayload, buildResponsesPayload, buildChatPayload, shouldUseJsonEdit,
  SAFE_SIZES, isSizeUsable,
  extractImages, extractText, extractUsage, readError, UpstreamError, makeHeaders, shortBody, decodeJwtExp
};
