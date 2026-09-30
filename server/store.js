'use strict';
/**
 * 本地持久化：配置 + 历史记录
 * 零依赖，使用 Node 内置 fs。
 * 目录：<project>/.gptimage2/
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.GPTIMAGE2_DATA_DIR
  ? path.resolve(process.env.GPTIMAGE2_DATA_DIR)
  : path.join(__dirname, '..', '.gptimage2');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const GALLERY_DIR = path.join(ROOT, 'gallery');

const DEFAULT_CONFIG = {
  providerName: '',
  baseUrl: 'https://api.openai.com',
  apiKey: '',
  model: '',
  size: '1024x1024', // 保守默认值，避免上游因尺寸校验直接 400
  quality: 'high',
  background: 'auto',
  outputFormat: 'auto',
  count: 1,
  moderation: 'auto',
  timeoutSeconds: 600,
  method: 'auto',       // auto | images | responses | chat
  editEndpoint: 'auto', // auto | json | multipart
  streamUpstream: false, // 文生图时是否把 stream 传给上游
  proxy: 'auto',        // auto（自动探测系统代理）| off | http://host:port
  useProxy: true,
  allowPrivateHost: true
};

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------- config ------------------------------- */

function getConfig() {
  const saved = readJson(CONFIG_FILE, {});
  const cfg = Object.assign({}, DEFAULT_CONFIG, saved || {});
  // 环境变量兜底（方便 CI / 脚本调用）
  if (!cfg.apiKey && process.env.GPTIMAGE2_API_KEY) cfg.apiKey = process.env.GPTIMAGE2_API_KEY;
  if (process.env.GPTIMAGE2_BASE_URL) cfg.baseUrl = process.env.GPTIMAGE2_BASE_URL;
  return cfg;
}

function saveConfig(patch) {
  const current = readJson(CONFIG_FILE, {});
  const next = Object.assign({}, DEFAULT_CONFIG, current || {}, patch || {});
  // 不允许把掩码值写回去
  if (next.apiKey && /^\*+$/.test(String(next.apiKey).trim())) next.apiKey = (current && current.apiKey) || '';
  writeJson(CONFIG_FILE, next);
  return next;
}

/** 对外返回时打码 API Key */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return k.slice(0, 2) + '****';
  return k.slice(0, 6) + '…' + k.slice(-4);
}

function publicConfig() {
  const cfg = getConfig();
  return Object.assign({}, cfg, {
    apiKey: '',
    apiKeyMasked: maskKey(cfg.apiKey),
    hasApiKey: Boolean(cfg.apiKey)
  });
}

/* ------------------------------- history ------------------------------ */

const HISTORY_LIMIT = 300;

function getHistory() {
  const data = readJson(HISTORY_FILE, { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

function addHistory(items) {
  const list = Array.isArray(items) ? items : [items];
  const all = list.concat(getHistory()).slice(0, HISTORY_LIMIT);
  writeJson(HISTORY_FILE, { items: all });
  return all;
}

function removeHistory(id) {
  const all = getHistory().filter((it) => it && it.id !== id);
  writeJson(HISTORY_FILE, { items: all });
  return all;
}

function clearHistory() {
  writeJson(HISTORY_FILE, { items: [] });
  return [];
}

/* ------------------------------- gallery ------------------------------ */
/** 把 base64 图片落盘，返回本地可访问路径，避免历史文件膨胀 */
function saveImage(id, index, base64, ext) {
  ensureDir(GALLERY_DIR);
  const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const name = String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '-' + index + '.' + safeExt;
  const file = path.join(GALLERY_DIR, name);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return { file, url: '/gallery/' + name, bytes: fs.statSync(file).size };
}

function galleryPath(name) {
  const clean = path.basename(String(name || ''));
  if (!/^[a-zA-Z0-9_.-]+$/.test(clean)) return null;
  const file = path.join(GALLERY_DIR, clean);
  if (!fs.existsSync(file)) return null;
  return file;
}

module.exports = {
  ROOT, GALLERY_DIR, DEFAULT_CONFIG,
  getConfig, saveConfig, publicConfig, maskKey,
  getHistory, addHistory, removeHistory, clearHistory,
  saveImage, galleryPath,
  ensureDir
};
