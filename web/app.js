/* ==========================================================================
   GPT Image 2 · 中转站生图台 —— 前端逻辑
   零框架、零构建：原生 ES Module
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  statusPill: $('statusPill'), statusText: $('statusText'), endpointChip: $('endpointChip'),
  baseUrl: $('baseUrl'), apiKey: $('apiKey'), keyHint: $('keyHint'),
  btnToggleKey: $('btnToggleKey'), btnFetchModels: $('btnFetchModels'), btnTest: $('btnTest'), btnHelp: $('btnHelp'),
  modelSelect: $('modelSelect'), modelManual: $('modelManual'), modelHint: $('modelHint'), btnShowAllModels: $('btnShowAllModels'),
  endpoints: $('endpoints'), allowPrivateHost: $('allowPrivateHost'),
  proxy: $('proxy'), proxyHint: $('proxyHint'), btnProbeProxy: $('btnProbeProxy'),
  sizeChips: $('sizeChips'), sizeCustom: $('sizeCustom'), btnSizeCustom: $('btnSizeCustom'),
  quality: $('quality'), count: $('count'), background: $('background'), outputFormat: $('outputFormat'),
  method: $('method'), editEndpoint: $('editEndpoint'), timeoutSeconds: $('timeoutSeconds'), moderation: $('moderation'),
  streamUpstream: $('streamUpstream'),
  btnResetParams: $('btnResetParams'),
  modeNote: $('modeNote'), generationModeLabel: $('generationModeLabel'),
  refs: $('refs'), refsList: $('refsList'), refCount: $('refCount'), dropZone: $('dropZone'),
  fileInput: $('fileInput'), btnPickFiles: $('btnPickFiles'), btnClearRefs: $('btnClearRefs'),
  prompt: $('prompt'), promptLen: $('promptLen'), btnClearPrompt: $('btnClearPrompt'), btnGenerate: $('btnGenerate'),
  stage: $('stage'), stageEmpty: $('stageEmpty'), progress: $('progress'), progressText: $('progressText'),
  progressBar: $('progressBar'), progressLog: $('progressLog'), elapsed: $('elapsed'), results: $('results'),
  archive: $('archive'), btnRefreshHistory: $('btnRefreshHistory'), btnClearHistory: $('btnClearHistory'),
  lightbox: $('lightbox'), lbImage: $('lbImage'), lbMeta: $('lbMeta'), lbClose: $('lbClose'),
  lbDownload: $('lbDownload'), lbCopyPrompt: $('lbCopyPrompt'), lbReuse: $('lbReuse'),
  helpModal: $('helpModal'), helpClose: $('helpClose'), toasts: $('toasts'),
  btnSettings: $('btnSettings'), settingsModal: $('settingsModal'), settingsClose: $('settingsClose'), btnSaveSettings: $('btnSaveSettings'),
  settingsFeedback: $('settingsFeedback'),
  btnNewChat: $('btnNewChat'), btnToggleSidebar: $('btnToggleSidebar'), sidebarBackdrop: $('sidebarBackdrop'),
  historySearch: $('historySearch'), chatTitle: $('chatTitle'), composer: $('composer'), conversation: $('conversation'),
  modelLabel: $('modelLabel'), sizeLabel: $('sizeLabel'), styleLabel: $('styleLabel'),
  styleOptions: $('styleOptions'), templateOptions: $('templateOptions')
};

// 尺寸预设（全部 16 的倍数）。更大尺寸各家支持不一，用「自定义」填。
const SIZE_LABELS = { auto: '自动', '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3',
  '1536x864': '16:9', '864x1536': '9:16', '1536x1152': '4:3', '1152x1536': '3:4' };
const SIZES = Object.keys(SIZE_LABELS);
const STYLES = [
  { id: 'none', label: '默认', detail: '跟随你的描述', prompt: '' },
  { id: 'photo', label: '真实摄影', detail: '自然光影 · 镜头质感', prompt: '真实摄影，自然光影，细腻的材质与镜头质感。' },
  { id: 'anime', label: '日系动漫', detail: '清晰线条 · 精致上色', prompt: '日系动漫插画，清晰流畅的线条，精致上色，细腻光影。' },
  { id: 'watercolor', label: '水彩手绘', detail: '轻盈色彩 · 纸张肌理', prompt: '水彩手绘，通透柔和的色彩，自然晕染，纸张肌理。' },
  { id: 'cinema', label: '电影感', detail: '叙事构图 · 氛围光影', prompt: '电影级构图，富有叙事感的光影，克制的色彩，胶片质感。' },
  { id: '3d', label: '3D 质感', detail: '立体造型 · 柔和照明', prompt: '精致的三维渲染，立体造型，柔和的环境光，细节丰富的材质。' }
];
const TEMPLATES = [
  { id: 'photo', label: '拍一张电影感照片', detail: '把日常，变成一个镜头', prompt: '雨后街角的一家小咖啡馆，窗边放着一杯拿铁，暖光映在湿润的石板路上。电影感摄影，安静自然，细节丰富。' },
  { id: 'illustration', label: '画一个想象中的世界', detail: '让灵感有自己的形状', prompt: '漂浮在云海上的小岛，一座被绿植环绕的书店，窗外有鲸鱼缓缓游过。治愈系插画，柔和配色，富有想象力。' },
  { id: 'product', label: '设计一张产品大片', detail: '为你的产品找到好角度', prompt: '一瓶简约的白色香水，置于浅色石台上，旁边有枝叶投下的柔和阴影。高级产品摄影，干净背景，留出文字空间。' },
  { id: 'poster', label: '做一张创意海报', detail: '用画面说出你的想法', prompt: '设计一张以“向野而生”为主题的户外海报，远山、森林与清晨薄雾，简洁排版，标题清晰，整体自然、有呼吸感。' }
];

const state = {
  refs: [],              // [{ dataUrl, name, bytes }]
  imageModels: [],       // 自动筛出的图像模型
  allModels: [],         // 全量模型
  showAll: false,
  history: [],
  busy: false,
  stream: null,
  elapsedTimer: null,
  startedAt: 0,
  lbCurrent: null,
  activeId: null,
  appliedSize: '1024x1024',
  style: 'none',
  hasSavedKey: false,
  configReady: false,
  settingsSnapshot: null,
  settingsModelsSnapshot: null,
  modalFocus: null,
  modelsProvider: '',
  modelRequestVersion: 0,
  pendingUploads: 0
};

const LS_KEY = 'gptimage2.ui.v1'; // 本机界面偏好，不存密钥或生成记录

/* ───────────────────────────── 工具 ───────────────────────────── */

function toast(message, kind = 'info', ms = 4200) {
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .28s ease, transform .28s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 300);
  }, ms);
}

function setStatus(text, stateName = 'idle') {
  el.statusText.textContent = text;
  el.statusPill.dataset.state = stateName;
}

async function api(path, options = {}) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.payload = json || {};
    throw err;
  }
  return json;
}

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function guessExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  return 'png';
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(text, n = 24) {
  const s = String(text || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim();
  return (s.slice(0, n).trim().replace(/\s+/g, '-')) || 'image';
}

async function copyText(text) {
  if (window.NativeBridge && typeof window.NativeBridge.copyText === 'function') {
    window.NativeBridge.copyText(String(text));
    toast('已复制到剪贴板', 'ok', 1800);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok', 1800);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制到剪贴板', 'ok', 1800);
  }
}

/* ─────────────────────── 配置读取与持久化 ─────────────────────── */

function currentForm() {
  return {
    baseUrl: el.baseUrl.value.trim(),
    apiKey: el.apiKey.value.trim(),
    model: el.modelManual.value.trim() || (el.modelSelect.value || ''),
    size: selectedSize(),
    quality: el.quality.value,
    count: Number(el.count.value) || 1,
    background: el.background.value,
    outputFormat: el.outputFormat.value,
    method: el.method.value,
    editEndpoint: el.editEndpoint.value,
    timeoutSeconds: Number(el.timeoutSeconds.value) || 600,
    moderation: el.moderation.value,
    allowPrivateHost: el.allowPrivateHost.checked,
    proxy: el.proxy.value.trim() || 'auto',
    streamUpstream: el.streamUpstream.checked
  };
}

function selectedSize() {
  return state.appliedSize;
}

/** 只保存风格偏好；生成方式始终由当前参考图决定。 */
function persistUi() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ style: state.style })); } catch (_) {}
}

function restoreUi() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) {}
  if (saved && STYLES.some((s) => s.id === saved.style)) state.style = saved.style;
  // 旧版本记录过 mode:edit，但参考图并不跨次保存，不能恢复成空图改图。
  persistUi();
}

const MODE_NOTES = {
  text: '描述画面，或添加参考图开始创作',
  edit: '可以用「图1」「图2」指定参考图，并描述想修改的内容'
};

function syncGenerationMode() {
  const hasImages = state.refs.length > 0;
  el.refs.hidden = !hasImages;
  el.modeNote.textContent = MODE_NOTES[hasImages ? 'edit' : 'text'];
  el.generationModeLabel.textContent = hasImages ? '图生图' : '文生图';
  el.prompt.placeholder = hasImages
    ? '描述你想怎样修改参考图…'
    : '描述你想要的图片，让想象发生…';
  el.fileInput.dataset.remaining = String(Math.max(0, 10 - state.refs.length));
  if (window.NativeBridge && typeof window.NativeBridge.setReferenceLimit === 'function') {
    window.NativeBridge.setReferenceLimit(Math.max(0, 10 - state.refs.length));
  }
  positionToolPanels();
}

/* ───────────────────────────── 尺寸 ───────────────────────────── */

function renderSizes() {
  el.sizeChips.innerHTML = '';
  for (const s of SIZES.concat(['custom'])) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.size = s;
    chip.textContent = s === 'custom' ? '自定义' : SIZE_LABELS[s];
    chip.title = s === 'custom' ? '输入宽和高' : s;
    chip.addEventListener('click', () => { selectSize(s); if (s !== 'custom') saveConfig(); });
    el.sizeChips.appendChild(chip);
  }
  selectSize('1024x1024');
}

function selectSize(size) {
  size = String(size).trim().toLowerCase().replace(/\s*[*×x]\s*/g, 'x');
  const value = SIZES.includes(size) ? size : 'custom';
  if (size !== 'custom') state.appliedSize = size;
  el.sizeChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.size === value));
  if (value === 'custom') {
    if (size !== 'custom') el.sizeCustom.value = size;
    if (size === 'custom') el.sizeCustom.focus();
  }
  syncToolbar();
  persistUi();
}

function applyCustomSize() {
  const v = el.sizeCustom.value.trim().toLowerCase().replace(/\s*[*×x]\s*/g, 'x');
  el.sizeCustom.value = v;
  if (!/^auto$|^\d{2,5}x\d{2,5}$/i.test(v)) { toast('自定义尺寸格式应为 宽x高，例如 1280x720', 'err'); return; }
  if (v !== 'auto') {
    const [w, h] = v.toLowerCase().split('x').map(Number);
    if (w % 16 || h % 16) {
      toast(`尺寸 ${v} 不合法：宽高都必须能被 16 整除（如 1280x720、1024x1536），否则上游会直接 400`, 'err', 8000);
      return;
    }
  }
  selectSize(v);
  saveConfig();
  toast('尺寸已设为 ' + v, 'ok', 1600);
}

/* ───────────────────────── 对话界面 ───────────────────────── */

function syncToolbar() {
  el.modelLabel.textContent = el.modelManual.value.trim() || el.modelSelect.value || '选择模型';
  el.modelLabel.title = el.modelLabel.textContent;
  el.sizeLabel.textContent = SIZE_LABELS[state.appliedSize] || state.appliedSize;
  el.styleLabel.textContent = (STYLES.find((s) => s.id === state.style) || STYLES[0]).label;
}

function closeMenus(except = null) {
  document.querySelectorAll('.tool-menu[open]').forEach((menu) => { if (menu !== except) menu.open = false; });
}

// Position mobile menus above the whole composer, including reference images
// and a growing prompt; fixed coordinates keep them out of the scrolling toolbar.
function positionToolPanels() {
  if (!el.composer) return;
  requestAnimationFrame(() => {
    const rect = el.composer.getBoundingClientRect();
    const viewport = window.visualViewport;
    // Headless Chromium can expose visualViewport.height as 0 during a metrics
    // update. Treat that transient value as unavailable or it becomes a huge
    // `bottom` offset and sends fixed menus above the visible viewport.
    const viewportHeight = viewport && Number.isFinite(viewport.height) && viewport.height > 100
      ? viewport.height : window.innerHeight;
    const visibleHeight = Math.max(1, viewportHeight || window.innerHeight || document.documentElement.clientHeight);
    const rawViewportTop = viewport && Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0;
    // During mobile emulation Chromium may report a negative visual viewport
    // offset while applying new device metrics. CSS top coordinates cannot be
    // negative here: clamp it to the visible layout range before positioning.
    const layoutHeight = Math.max(visibleHeight, window.innerHeight || visibleHeight);
    const viewportTop = Math.max(0, Math.min(rawViewportTop, Math.max(0, layoutHeight - visibleHeight)));
    const roomAbove = rect.top - viewportTop - 24;
    const composerVisible = rect.top <= viewportTop + visibleHeight;
    const room = roomAbove >= 180 && composerVisible ? Math.min(460, roomAbove) : Math.max(80, visibleHeight - 24);
    const panelTop = roomAbove >= 180 && composerVisible
      ? Math.max(viewportTop + 12, rect.top - room - 12)
      : viewportTop + 12;
    document.documentElement.style.setProperty('--tool-panel-top', panelTop + 'px');
    document.documentElement.style.setProperty('--tool-panel-max-height', room + 'px');
    if (window.innerWidth <= 1030) {
      document.querySelectorAll('.tool-menu[open] .tool-panel').forEach((panel) => {
        panel.style.setProperty('position', 'fixed', 'important');
        panel.style.setProperty('top', panelTop + 'px', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
        panel.style.setProperty('max-height', room + 'px', 'important');
      });
    }
  });
}

function pickReferenceImages() {
  if (state.busy || state.pendingUploads) return;
  if (state.refs.length >= 10) { toast('已选满 10 张图片，请先移除一张', 'info'); return; }
  closeMenus();
  el.prompt.blur();
  el.fileInput.click();
}

function showDialog(dialog, focusTarget) {
  closeMenus();
  state.modalFocus = document.activeElement;
  document.body.classList.remove('sidebar-open');
  dialog.hidden = false;
  document.body.classList.add('modal-open');
  (focusTarget || dialog.querySelector('button, input, select')).focus();
}

function hideDialog(dialog) {
  dialog.hidden = true;
  document.body.classList.remove('modal-open');
  if (state.modalFocus && document.contains(state.modalFocus)) state.modalFocus.focus();
}

const CONNECTION_FIELDS = ['baseUrl', 'apiKey', 'proxy', 'allowPrivateHost', 'streamUpstream',
  'method', 'editEndpoint', 'timeoutSeconds', 'moderation'];

function openSettings(focusTarget) {
  if (state.busy) return;
  state.settingsSnapshot = Object.fromEntries(CONNECTION_FIELDS.map((key) => [key,
    el[key].type === 'checkbox' ? el[key].checked : el[key].value]));
  state.settingsModelsSnapshot = { allModels: state.allModels, imageModels: state.imageModels,
    modelsProvider: state.modelsProvider, model: el.modelManual.value,
    hint: el.modelHint.textContent, hintClass: el.modelHint.className };
  showDialog(el.settingsModal, focusTarget || el.baseUrl);
}

function closeSettings(saved = false) {
  if (el.btnSaveSettings.disabled) return;
  if (!saved && state.settingsSnapshot) {
    state.modelRequestVersion++;
    CONNECTION_FIELDS.forEach((key) => {
      if (el[key].type === 'checkbox') el[key].checked = state.settingsSnapshot[key];
      else el[key].value = state.settingsSnapshot[key];
    });
    const models = state.settingsModelsSnapshot;
    Object.assign(state, { allModels: models.allModels, imageModels: models.imageModels, modelsProvider: models.modelsProvider });
    el.modelManual.value = models.model;
    el.modelHint.textContent = models.hint;
    el.modelHint.className = models.hintClass;
    renderModelList();
    syncToolbar();
    setSettingsFeedback('');
  }
  el.apiKey.type = 'password';
  el.btnToggleKey.textContent = '显示密钥';
  state.settingsSnapshot = null;
  state.settingsModelsSnapshot = null;
  hideDialog(el.settingsModal);
  updateEndpointPreview();
}

function setSettingsFeedback(message) {
  el.settingsFeedback.textContent = message;
  el.settingsFeedback.hidden = !message;
}

async function saveSettings() {
  if (el.btnSaveSettings.disabled) return;
  if (!/^https?:\/\//i.test(el.baseUrl.value.trim())) {
    toast('请填写以 http:// 或 https:// 开头的供应商地址', 'err'); el.baseUrl.focus(); return;
  }
  const changedProvider = state.settingsSnapshot && state.settingsSnapshot.baseUrl !== el.baseUrl.value;
  el.btnSaveSettings.disabled = true;
  const saved = await saveConfig({ connection: true });
  el.btnSaveSettings.disabled = false;
  if (!saved) return;
  if (changedProvider && state.modelsProvider !== el.baseUrl.value.trim()) {
    state.allModels = []; state.imageModels = []; renderModelList();
  }
  closeSettings(true);
  setStatus(state.hasSavedKey ? '已就绪' : '请设置 API Key', state.hasSavedKey ? 'ok' : 'idle');
  toast('设置已保存', 'ok', 1800);
}

function scrollConversation() {
  requestAnimationFrame(() => { el.conversation.scrollTop = el.conversation.scrollHeight; });
}

function renderUserMessage(prompt, refs = []) {
  const message = document.createElement('div');
  message.className = 'user-message';
  if (refs.length) {
    const images = document.createElement('div');
    images.className = 'user-refs';
    refs.forEach((ref) => {
      const img = document.createElement('img'); img.src = ref.dataUrl; img.alt = ref.name;
      images.appendChild(img);
    });
    message.appendChild(images);
  }
  const p = document.createElement('p'); p.textContent = prompt; message.appendChild(p);
  el.results.appendChild(message);
  el.stageEmpty.hidden = true;
}

function newChat() {
  if (state.busy || state.pendingUploads) return;
  state.activeId = null;
  state.refs = [];
  el.results.replaceChildren();
  el.stageEmpty.hidden = false;
  el.progress.hidden = true;
  el.progressLog.replaceChildren();
  el.prompt.value = '';
  el.chatTitle.textContent = '新建图片';
  updateRefs();
  updatePromptLen();
  renderArchive();
  closeMenus();
  document.body.classList.remove('sidebar-open');
  setStatus(state.hasSavedKey ? '已就绪' : '请先完成设置', state.hasSavedKey ? 'ok' : 'idle');
  el.prompt.focus();
}

function openHistory(item) {
  if (state.busy) { toast('请等当前生成完成后再切换记录', 'info'); return; }
  state.activeId = item.id;
  el.results.replaceChildren();
  renderUserMessage(item.prompt);
  finishCard(item);
  el.chatTitle.textContent = item.prompt.slice(0, 36);
  el.progress.hidden = true;
  renderArchive();
  document.body.classList.remove('sidebar-open');
  scrollConversation();
}

function useTemplate(id) {
  if (state.busy) return;
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) return;
  el.prompt.value = template.prompt;
  updatePromptLen();
  closeMenus();
  el.prompt.focus();
}

function renderCreativeOptions() {
  el.styleOptions.replaceChildren();
  for (const style of STYLES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice-item' + (style.id === state.style ? ' is-active' : '');
    btn.dataset.style = style.id; btn.setAttribute('aria-pressed', String(style.id === state.style));
    const label = document.createElement('strong'); label.textContent = style.label;
    const detail = document.createElement('span'); detail.textContent = style.detail;
    btn.append(label, detail);
    btn.addEventListener('click', () => {
      state.style = style.id; persistUi(); renderCreativeOptions(); syncToolbar(); closeMenus();
    });
    el.styleOptions.appendChild(btn);
  }
  el.templateOptions.replaceChildren();
  for (const template of TEMPLATES) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'choice-item';
    btn.dataset.template = template.id;
    const label = document.createElement('strong'); label.textContent = template.label;
    const detail = document.createElement('span'); detail.textContent = template.detail;
    btn.append(label, detail); btn.addEventListener('click', () => useTemplate(template.id));
    el.templateOptions.appendChild(btn);
  }
}

/* ───────────────────────── 连接与模型 ───────────────────────── */

async function loadConfig() {
  let cfg = null;
  try {
    cfg = await api('/api/config');
  } catch (e) {
    toast('读取本地配置失败：' + e.message, 'err');
    updateEndpointPreview();
    return;
  }
  const simple = ['quality', 'background', 'outputFormat', 'count', 'method', 'editEndpoint', 'timeoutSeconds', 'moderation'];

  // 先回填所有"开关/下拉"，最后再回填会触发持久化的尺寸与页签，
  // 否则中途一次 saveConfig 会把还没回填的项写回默认值。
  el.apiKey.value = '';
  if (cfg.baseUrl) el.baseUrl.value = cfg.baseUrl;
  updateSavedKey(cfg);
  el.modelManual.value = cfg.model || 'gpt-image-2';
  simple.forEach((k) => { if (cfg[k] !== undefined && cfg[k] !== '') el[k].value = String(cfg[k]); });
  if (typeof cfg.allowPrivateHost === 'boolean') el.allowPrivateHost.checked = cfg.allowPrivateHost;
  if (cfg.proxy) el.proxy.value = cfg.proxy;
  if (typeof cfg.streamUpstream === 'boolean') el.streamUpstream.checked = cfg.streamUpstream;
  selectSize(cfg.size ? String(cfg.size) : '1024x1024');
  state.configReady = true;
  syncToolbar();
  updateEndpointPreview();
}

function updateSavedKey(cfg) {
  state.hasSavedKey = Boolean(cfg.hasApiKey);
  el.keyHint.textContent = state.hasSavedKey
    ? '已保存密钥 ' + (cfg.apiKeyMasked || '') + '，留空可继续使用。'
    : '密钥保存在本机，仅用于请求你设置的供应商。';
}

/** 普通操作只保存成像参数；设置窗口确认后才保存连接与密钥。 */
async function saveConfig({ connection = false } = {}) {
  if (!state.configReady) return false;
  const f = currentForm();
  const payload = {
    model: f.model, size: f.size, quality: f.quality, count: f.count,
    background: f.background, outputFormat: f.outputFormat
  };
  if (connection) {
    Object.assign(payload, { baseUrl: f.baseUrl, proxy: f.proxy, allowPrivateHost: f.allowPrivateHost,
      streamUpstream: f.streamUpstream, method: f.method, editEndpoint: f.editEndpoint,
      timeoutSeconds: f.timeoutSeconds, moderation: f.moderation });
    if (f.apiKey) payload.apiKey = f.apiKey;
  }
  try {
    const saved = await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    if (connection) { updateSavedKey(saved); el.apiKey.value = ''; }
    return true;
  } catch (e) { toast('设置保存失败：' + e.message, 'err'); return false; }
}

async function updateEndpointPreview() {
  try {
    const ep = await api('/api/endpoints', { method: 'POST', body: JSON.stringify({ baseUrl: el.baseUrl.value.trim() }) });
    if (ep.error) { el.endpoints.innerHTML = ''; el.endpointChip.textContent = '—'; return; }
    el.endpointChip.textContent = ep.base;
    el.endpoints.replaceChildren();
    [['生图', ep.generations], ['改图', ep.edits], ['模型', ep.models]].forEach(([label, url]) => {
      const line = document.createElement('span');
      line.textContent = label + ' ' + url;
      el.endpoints.appendChild(line);
    });
  } catch (_) {}
}

function renderModelList() {
  const list = state.showAll ? state.allModels : state.imageModels;
  el.modelSelect.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.textContent = '（暂无模型，请点「获取模型」）';
    el.modelSelect.appendChild(opt);
    return;
  }
  for (const id of list) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (id === el.modelManual.value.trim()) opt.selected = true;
    el.modelSelect.appendChild(opt);
  }
  if (!el.modelManual.value.trim() && list.length) el.modelManual.value = list[0];
  syncToolbar();
}

async function fetchModels({ silent = false } = {}) {
  const requestVersion = ++state.modelRequestVersion;
  const baseUrl = el.baseUrl.value.trim();
  const apiKey = el.apiKey.value.trim();
  // 输入框为空但本地已保存密钥时，由服务端用保存值兜底，这里不报错
  const hasSavedKey = el.keyHint.textContent.includes('已保存密钥');
  if (!baseUrl) { if (!silent) { toast('请先填写供应商地址', 'err'); el.baseUrl.focus(); } return; }
  if (!apiKey && !hasSavedKey) { if (!silent) { toast('请先填写 API Key', 'err'); el.apiKey.focus(); } return; }
  setStatus('正在拉取模型列表…', 'busy');
  el.btnFetchModels.disabled = true;
  try {
    await saveConfig();
    // apiKey 可能为空串（本地已保存密钥，由服务端兜底）；显式传空会覆盖掉保存值，所以这里不传该字段
    const payload = { baseUrl, allowPrivateHost: el.allowPrivateHost.checked, proxy: el.proxy.value.trim() || 'auto' };
    if (apiKey) payload.apiKey = apiKey;
    const r = await api('/api/models', { method: 'POST', body: JSON.stringify(payload) });
    if (requestVersion !== state.modelRequestVersion || baseUrl !== el.baseUrl.value.trim()) return;
    state.allModels = r.models || [];
    state.imageModels = r.imageModels || [];
    state.modelsProvider = baseUrl;
    renderModelList();
    if (r.ok) {
      setStatus(`已连接 · ${r.total} 个模型 / ${state.imageModels.length} 个图像模型`, 'ok');
      el.modelHint.className = 'hint is-ok';
      el.modelHint.textContent = `来源 ${r.url}：共 ${r.total} 个模型，已筛出 ${state.imageModels.length} 个图像模型并优先排序。`;
      setSettingsFeedback('已获取 ' + state.imageModels.length + ' 个图像模型，可在输入框下方选择。');
      if (!silent) toast(`获取成功：${r.total} 个模型，其中图像模型 ${state.imageModels.length} 个`, 'ok');
      if (!state.imageModels.length) toast('没有识别到图像模型，点「显示全部模型」手动挑选', 'warn', 6000);
    } else {
      setStatus('模型列表接口不可用', 'error');
      el.modelHint.className = 'hint is-error';
      const via = r.proxy && r.proxy.url ? `出口 ${r.proxy.url}（${r.proxy.source}）` : '出口 直连';
      el.modelHint.textContent = '自动获取失败：' + r.error + '｜' + via + (r.advice ? '｜' + r.advice : '');
      setSettingsFeedback(el.modelHint.textContent);
      if (!silent) toast('自动获取模型失败：' + r.error, 'err', 7000);
    }
    await updateEndpointPreview();
  } catch (e) {
    if (requestVersion !== state.modelRequestVersion) return;
    setStatus('获取模型失败', 'error');
    setSettingsFeedback(e.message);
    toast('获取模型失败：' + e.message, 'err', 7000);
  } finally {
    el.btnFetchModels.disabled = false;
  }
}

async function runConnectivityTest() {
  const baseUrl = el.baseUrl.value.trim();
  setStatus('正在检测连通性…', 'busy');
  setSettingsFeedback('正在检测连接…');
  el.btnTest.disabled = true;
  try {
    const r = await api('/api/test', {
      method: 'POST',
      body: JSON.stringify(Object.assign(
        { baseUrl: el.baseUrl.value.trim(), allowPrivateHost: el.allowPrivateHost.checked, proxy: el.proxy.value.trim() || 'auto' },
        el.apiKey.value.trim() ? { apiKey: el.apiKey.value.trim() } : {}
      ))
    });
    if (el.settingsModal.hidden || baseUrl !== el.baseUrl.value.trim()) return;
    const lines = r.steps.map((s) => `${s.ok ? '✓' : '✕'} ${s.name}：${s.detail}`).join('\n');
    setSettingsFeedback(lines);
    appendLog(lines.split('\n').map((l) => ({ text: l, cls: l.startsWith('✓') ? 'good' : 'bad' })));
    if (r.imageModels && r.imageModels.length) {
      state.imageModels = r.imageModels;
      state.modelsProvider = baseUrl;
      if (!state.allModels.length) state.allModels = r.imageModels;
      renderModelList();
    }
    setStatus(r.ok ? '连通性正常' : '连通性异常', r.ok ? 'ok' : 'error');
    toast(r.ok ? '连通性检测通过' : '连接异常，详情见设置窗口', r.ok ? 'ok' : 'err', 6000);
  } catch (e) {
    setStatus('检测失败', 'error');
    setSettingsFeedback(e.message);
    toast('检测失败：' + e.message, 'err', 6000);
  } finally {
    el.btnTest.disabled = false;
  }
}

/* ───────────────────────────── 参考图 ───────────────────────────── */

function addRefFromDataUrl(dataUrl, name) {
  if (state.refs.length >= 10) { toast('参考图最多 10 张', 'warn'); return; }
  const bytes = Math.round((dataUrl.length - (dataUrl.indexOf(',') + 1)) * 0.75);
  state.refs.push({ dataUrl, name: name || ('ref-' + (state.refs.length + 1)), bytes });
  updateRefs();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败：' + file.name));
    fr.readAsDataURL(file);
  });
}

async function addFiles(files) {
  if (state.busy) return;
  const list = Array.from(files || []).filter((f) => /^image\//.test(f.type));
  if (!list.length) return;
  state.pendingUploads++;
  el.btnGenerate.disabled = true;
  el.btnNewChat.disabled = true;
  el.btnClearRefs.disabled = true;
  el.refsList.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  let added = 0;
  try {
    for (const f of list) {
      if (state.refs.length >= 10) { toast('参考图最多 10 张', 'warn'); break; }
      try {
        const dataUrl = await readFileAsDataUrl(f);
        addRefFromDataUrl(dataUrl, f.name);
        added++;
      } catch (e) { toast(e.message, 'err'); }
    }
    if (added) toast(`已添加 ${added} 张参考图`, 'ok', 2000);
  } finally {
    state.pendingUploads--;
    el.btnGenerate.disabled = state.busy || state.pendingUploads > 0;
    el.btnNewChat.disabled = state.busy || state.pendingUploads > 0;
    el.btnClearRefs.disabled = state.busy || state.pendingUploads > 0;
    el.refsList.querySelectorAll('button').forEach((button) => { button.disabled = state.busy || state.pendingUploads > 0; });
  }
}

function updateRefs() {
  syncGenerationMode();
  el.refCount.textContent = String(state.refs.length);
  el.refsList.innerHTML = '';
  state.refs.forEach((r, i) => {
    const box = document.createElement('div');
    box.className = 'ref-thumb';
    box.title = `${r.name} · ${humanBytes(r.bytes)}`;
    const img = document.createElement('img');
    img.src = r.dataUrl;
    img.alt = r.name;
    const idx = document.createElement('span');
    idx.className = 'ref-index';
    idx.textContent = '图' + (i + 1);
    const del = document.createElement('button');
    del.className = 'ref-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = '移除';
    del.disabled = state.busy || state.pendingUploads > 0;
    del.addEventListener('click', () => {
      if (state.busy || state.pendingUploads) return;
      state.refs.splice(i, 1);
      updateRefs();
    });
    box.append(img, idx, del);
    el.refsList.appendChild(box);
  });
}

/* ───────────────────────────── 生成 ───────────────────────────── */

function appendLog(entries) {
  for (const e of entries) {
    const line = document.createElement('div');
    if (e.cls) line.className = e.cls;
    line.textContent = e.text;
    el.progressLog.appendChild(line);
  }
  el.progressLog.scrollTop = el.progressLog.scrollHeight;
}

function startElapsed() {
  state.startedAt = Date.now();
  el.elapsed.textContent = '0.0s';
  state.elapsedTimer = setInterval(() => {
    el.elapsed.textContent = ((Date.now() - state.startedAt) / 1000).toFixed(1) + 's';
  }, 100);
}

function stopElapsed() {
  if (state.elapsedTimer) clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

function setBusy(busy) {
  state.busy = busy;
  el.composer.querySelectorAll('input, textarea, select, button').forEach((control) => { control.disabled = busy; });
  el.btnNewChat.disabled = busy;
  el.btnSettings.disabled = busy;
  el.btnGenerate.classList.toggle('is-busy', busy);
  el.btnGenerate.disabled = busy;
  el.btnGenerate.setAttribute('aria-label', busy ? '正在生成图片' : '生成图片');
  el.btnGenerate.title = busy ? '正在生成图片' : '生成图片（Ctrl + Enter）';
  el.btnGenerate.querySelector('.btn-label').textContent = busy ? '生成中…' : '生成图片';
  el.composer.setAttribute('aria-busy', String(busy));
}

function ensureMediaBlock() {
  const card = document.createElement('article');
  card.className = 'result-card';
  card.dataset.role = 'live';
  const media = document.createElement('div');
  media.className = 'result-media';
  media.dataset.role = 'live-media';
  const body = document.createElement('div');
  body.className = 'result-body';
  body.dataset.role = 'live-body';
  card.append(media, body);
  el.results.appendChild(card);
  el.stageEmpty.hidden = true;
  return { card, media, body };
}

function renderLivePlaceholders(n) {
  const { media } = ensureMediaBlock();
  media.innerHTML = '';
  const slots = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.alt = '正在生成第 ' + (i + 1) + ' 张图片';
    img.className = 'is-partial';
    fig.appendChild(img);
    media.appendChild(fig);
    slots.push(img);
  }
  return slots;
}

function finishCard(item) {
  const card = document.createElement('article');
  card.className = 'result-card';
  card.dataset.id = item.id;
  const media = document.createElement('div');
  media.className = 'result-media';
  item.images.forEach((img, i) => {
    const fig = document.createElement('figure');
    const im = document.createElement('img');
    im.src = img.url;
    im.alt = '结果 ' + (i + 1);
    im.loading = 'lazy';
    im.tabIndex = 0;
    im.setAttribute('role', 'button');
    im.setAttribute('aria-label', '放大查看第 ' + (i + 1) + ' 张图片');
    im.addEventListener('click', () => openLightbox(item, i));
    im.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(item, i); } });
    const cap = document.createElement('figcaption');
    cap.textContent = `#${i + 1}${img.bytes ? ' · ' + humanBytes(img.bytes) : ''}`;
    fig.append(im, cap);
    media.appendChild(fig);
  });
  const body = document.createElement('div');
  body.className = 'result-body';

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const tags = [
    ['hl', item.model],
    ['', item.size],
    ['', '质量 ' + (item.quality || 'auto')],
    ['', (item.elapsedMs / 1000).toFixed(1) + 's'],
    ['', item.count + ' 张']
  ];
  if (item.hasRefs) tags.splice(1, 0, ['warn', '参考图 ×' + item.refCount]);
  for (const [cls, text] of tags) {
    if (!text) continue;
    const t = document.createElement('span');
    t.className = 'tag ' + cls;
    t.textContent = text;
    meta.appendChild(t);
  }

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  item.images.forEach((img, i) => {
    actions.appendChild(mkBtn('下载 #' + (i + 1), () => downloadImage(img, item, i)));
  });
  actions.appendChild(mkBtn('复制提示词', () => copyText(item.prompt)));
  actions.appendChild(mkBtn('复用参数', () => reuseItem(item)));

  body.append(meta, actions);
  card.append(media, body);
  el.results.appendChild(card);
  el.stageEmpty.hidden = true;
  scrollConversation();
}

function renderError(message, detail, attempts) {
  const card = document.createElement('div');
  card.className = 'error-card';
  const h = document.createElement('h4');
  h.textContent = '生成失败';
  const p = document.createElement('p');
  p.textContent = message;
  card.append(h, p);
  const lines = [];
  if (Array.isArray(attempts) && attempts.length) {
    lines.push('尝试记录：');
    attempts.forEach((a) => lines.push(`  ${a.ok ? '✓' : '✕'} ${a.method}${a.error ? ' → ' + a.error : ''}`));
  }
  if (detail) { lines.push('上游原始返回：'); lines.push(detail); }
  if (lines.length) {
    const pre = document.createElement('pre');
    pre.textContent = lines.join('\n');
    card.appendChild(pre);
  }
  el.results.appendChild(card);
  el.stageEmpty.hidden = true;
  scrollConversation();
}

function clearLiveCards() {
  el.results.querySelectorAll('[data-role="live"]').forEach((card) => card.remove());
}

function onGenerationDone(item) {
  clearLiveCards();
  state.activeId = item.id;
  finishCard(item);
  loadHistory();
  const secs = (item.elapsedMs / 1000).toFixed(1);
  setStatus('生成完成 · ' + item.count + ' 张', 'ok');
  appendLog([{ text: `完成：${item.count} 张，用时 ${secs}s`, cls: 'good' }]);
}

async function generate() {
  if (state.busy || !state.configReady || !el.settingsModal.hidden || !el.lightbox.hidden || !el.helpModal.hidden) return;
  if (state.pendingUploads) { toast('参考图正在读取，请稍候', 'info'); return; }
  const form = currentForm();
  if (!form.baseUrl) { toast('请先在设置中填写供应商地址', 'err'); openSettings(el.baseUrl); return; }
  if (!form.apiKey && !state.hasSavedKey) { toast('请先在设置中填写 API Key', 'err'); openSettings(el.apiKey); return; }
  if (!form.allowPrivateHost && /^https?:\/\/(127\.0\.0\.1|localhost|\[[^\]]*\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(form.baseUrl)) {
    toast('请在设置中开启「允许内网地址」', 'warn', 6000); openSettings(el.allowPrivateHost); return;
  }
  if (!form.model) {
    toast('请先选择或输入模型', 'err'); el.modelManual.closest('details').open = true; el.modelManual.focus(); return;
  }
  if (!el.prompt.value.trim()) { toast('请输入提示词', 'err'); el.prompt.focus(); return; }

  const chosenStyle = STYLES.find((s) => s.id === state.style) || STYLES[0];
  const prompt = el.prompt.value.trim();
  const styleHint = chosenStyle.prompt ? '\n\n画面风格：' + chosenStyle.prompt : '';
  const refs = [...state.refs];
  const payload = Object.assign({}, form, {
    prompt: styleHint && !prompt.endsWith(styleHint) ? prompt + styleHint : prompt,
    images: refs.map((r) => r.dataUrl),
    stream: form.streamUpstream
  });
  if (!form.apiKey) delete payload.apiKey;

  // 在任何异步操作前锁定入口；一次点击、双击或快捷键交错都只提交一次。
  setBusy(true);
  closeMenus();
  document.body.classList.remove('sidebar-open');
  state.activeId = null;
  el.chatTitle.textContent = prompt.slice(0, 36);
  renderUserMessage(payload.prompt, refs);
  setStatus('正在生成…', 'busy');
  el.progress.hidden = false;
  el.progressLog.innerHTML = '';
  el.progressText.textContent = '正在向中转站提交任务…';
  startElapsed();

  const slots = renderLivePlaceholders(form.count);
  let receivedPartial = 0;
  scrollConversation();

  try {
    await saveConfig();
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      let detail = '';
      let attempts = null;
      try {
        const j = await res.json();
        msg = j.error || j.message || msg;
        detail = j.raw || '';
        attempts = j.attempts || null;
      } catch (_) {}
      throw Object.assign(new Error(msg), { detail, attempts });
    }
    if (!ctype.includes('text/event-stream')) {
      const j = await res.json();
      if (!j.item) throw new Error(j.error || '没有收到图片结果，请先检查中转站任务记录。');
      onGenerationDone(j.item);
      return;
    }

    // 读取 SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;
    const liveCard = el.results.querySelector('[data-role="live"]');

    const handle = (raw) => {
      if (finished) return;
      const dataLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
      if (!dataLines.length) return;
      let ev = null;
      try { ev = JSON.parse(dataLines.map((l) => l.slice(5).trim()).join('\n')); } catch (_) { return; }

      if (ev.type === 'phase') {
        el.progressText.textContent = ev.text;
        appendLog([{ text: '· ' + ev.text }]);
      } else if (ev.type === 'partial') {
        receivedPartial++;
        const img = slots[ev.index % slots.length];
        if (img && ev.b64) {
          img.src = 'data:' + (ev.mime || 'image/png') + ';base64,' + ev.b64;
          const fig = img.closest('figure');
          let cap = fig && fig.querySelector('figcaption');
          if (fig && !cap) { cap = document.createElement('figcaption'); fig.appendChild(cap); }
          if (cap) cap.textContent = '显影中 · 第 ' + receivedPartial + ' 帧';
        }
        el.progressText.textContent = '已接收 ' + receivedPartial + ' 帧低清预览，正在精修…';
      } else if (ev.type === 'done') {
        finished = true;
        onGenerationDone(ev.item);
      } else if (ev.type === 'error') {
        finished = true;
        if (liveCard) liveCard.remove();
        renderError(ev.message || '生成失败', ev.raw || '', ev.attempts);
        appendLog([{ text: '✕ ' + (ev.message || '生成失败'), cls: 'bad' }]);
        setStatus('生成失败', 'error');
        toast('生成失败：' + (ev.message || ''), 'err', 8000);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || '';
      parts.forEach(handle);
    }
    if (buf.trim()) handle(buf);
    if (!finished) {
      if (liveCard) liveCard.remove();
      setStatus('连接中断', 'error');
      renderError('连接已中断，未收到完整结果。请先查看中转站任务记录，本工具没有自动重发。');
    }
  } catch (e) {
    const liveCard = el.results.querySelector('[data-role="live"]');
    if (liveCard) liveCard.remove();
    renderError(e.message || '请求失败', e.detail || '', e.attempts);
    appendLog([{ text: '✕ ' + (e.message || '请求失败'), cls: 'bad' }]);
    setStatus('生成失败', 'error');
    toast('生成失败：' + (e.message || ''), 'err', 8000);
  } finally {
    clearLiveCards();
    setBusy(false);
    stopElapsed();
    el.progress.hidden = true;
    if (receivedPartial) appendLog([{ text: `共接收 ${receivedPartial} 帧流式预览` }]);
  }
}

/* ───────────────────────────── 下载 ───────────────────────────── */

function downloadImage(img, item, index) {
  const name = `${fileStamp()}-${slug(item.prompt)}-#${index + 1}.${guessExt(img.mime)}`;
  if (window.NativeBridge && typeof window.NativeBridge.download === 'function') {
    window.NativeBridge.download(img.url, name);
    return;
  }
  let href = img.url;
  if (typeof href === 'string' && /^https?:\/\//.test(href)) {
    href = '/api/download?url=' + encodeURIComponent(img.url) + '&name=' + encodeURIComponent(name);
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ───────────────────────────── 灯箱 ───────────────────────────── */

function openLightbox(item, index) {
  const img = item.images[index];
  if (!img) return;
  state.lbCurrent = { item, index };
  el.lbImage.src = img.url;
  el.lbMeta.textContent = [
    '模型   ' + item.model,
    '尺寸   ' + item.size + '   质量 ' + (item.quality || 'auto'),
    '接口   ' + (item.method || '-'),
    '耗时   ' + (item.elapsedMs / 1000).toFixed(1) + 's',
    '时间   ' + new Date(item.createdAt).toLocaleString('zh-CN'),
    item.hasRefs ? '参考图 ' + item.refCount + ' 张' : '',
    img.bytes ? '体积   ' + humanBytes(img.bytes) : '',
    '',
    '提示词',
    item.prompt
  ].filter((l) => l !== '').join('\n');
  showDialog(el.lightbox, el.lbClose);
}

function closeLightbox() { hideDialog(el.lightbox); el.lbImage.src = ''; state.lbCurrent = null; }

function reuseItem(item) {
  if (state.busy) return;
  if (item.prompt) { el.prompt.value = item.prompt; updatePromptLen(); }
  if (item.size) selectSize(item.size);
  if (item.quality) el.quality.value = item.quality;
  if (item.model) {
    el.modelManual.value = item.model;
    const opt = Array.from(el.modelSelect.options).find((o) => o.value === item.model);
    if (opt) opt.selected = true;
  }
  state.style = 'none'; persistUi(); renderCreativeOptions(); syncToolbar();
  if (item.hasRefs) toast('已复用提示词和参数，改图时请重新添加参考图', 'info');
  if (!el.lightbox.hidden) closeLightbox();
  el.prompt.focus();
  toast('已复用该次参数', 'ok', 2000);
}

/* ───────────────────────────── 档案 ───────────────────────────── */

async function loadHistory() {
  try {
    const r = await api('/api/history');
    state.history = r.items || [];
    renderArchive();
  } catch (e) { /* 忽略 */ }
}

function renderArchive() {
  el.archive.innerHTML = '';
  const query = el.historySearch.value.trim().toLowerCase();
  const items = state.history.filter((item) => (item.prompt + ' ' + item.model).toLowerCase().includes(query));
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.textContent = query ? '没有找到相关记录' : '你的创作，会留在这里';
    el.archive.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'history-row';
    const btn = document.createElement('button'); btn.type = 'button';
    btn.className = 'history-item' + (state.activeId === item.id ? ' is-active' : '');
    btn.setAttribute('aria-current', state.activeId === item.id ? 'true' : 'false');
    btn.title = item.prompt;
    const thumb = document.createElement('span'); thumb.className = 'history-thumb';
    if (item.images && item.images[0]) {
      const img = document.createElement('img'); img.src = item.images[0].url; img.alt = ''; img.loading = 'lazy';
      thumb.appendChild(img);
    }
    const text = document.createElement('span'); text.className = 'history-text';
    const title = document.createElement('strong'); title.className = 'history-title'; title.textContent = item.prompt;
    const meta = document.createElement('span'); meta.className = 'history-meta';
    meta.textContent = new Date(item.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' · ' + item.count + ' 张图片';
    text.append(title, meta); btn.append(thumb, text);
    btn.addEventListener('click', () => openHistory(item));
    const del = document.createElement('button'); del.type = 'button'; del.className = 'history-delete';
    del.textContent = '×'; del.title = '删除记录'; del.setAttribute('aria-label', '删除记录：' + item.prompt.slice(0, 24));
    del.addEventListener('click', async () => {
      if (state.busy) return;
      if (!confirm('删除这条历史记录？本地图片文件会保留。')) return;
      try {
        await api('/api/history?id=' + encodeURIComponent(item.id), { method: 'DELETE' });
        if (state.activeId === item.id) newChat();
        await loadHistory();
      } catch (e) { toast('删除失败：' + e.message, 'err'); }
    });
    row.append(btn, del); el.archive.appendChild(row);
  }
}

/* ───────────────────────────── 事件绑定 ───────────────────────────── */

function updatePromptLen() {
  el.promptLen.textContent = String(el.prompt.value.length);
  el.prompt.style.height = 'auto';
  el.prompt.style.height = Math.min(el.prompt.scrollHeight, 180) + 'px';
  positionToolPanels();
}

function bind() {

  el.baseUrl.addEventListener('change', updateEndpointPreview);
  el.baseUrl.addEventListener('input', () => { clearTimeout(bind._t); bind._t = setTimeout(updateEndpointPreview, 400); });
  el.btnSettings.addEventListener('click', () => openSettings());
  el.settingsClose.addEventListener('click', () => closeSettings());
  el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) closeSettings(); });
  el.btnSaveSettings.addEventListener('click', saveSettings);
  el.btnNewChat.addEventListener('click', newChat);
  el.historySearch.addEventListener('input', renderArchive);
  el.btnToggleSidebar.addEventListener('click', () => {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    document.body.classList.toggle(mobile ? 'sidebar-open' : 'sidebar-collapsed');
    el.btnToggleSidebar.setAttribute('aria-expanded', String(mobile
      ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-collapsed')));
  });
  el.sidebarBackdrop.addEventListener('click', () => {
    document.body.classList.remove('sidebar-open'); el.btnToggleSidebar.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll('.tool-menu').forEach((menu) => {
    menu.addEventListener('toggle', () => { if (menu.open) { closeMenus(menu); positionToolPanels(); } });
  });
  window.addEventListener('resize', positionToolPanels);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', positionToolPanels);
    window.visualViewport.addEventListener('scroll', positionToolPanels);
  }
  if (window.ResizeObserver) new ResizeObserver(positionToolPanels).observe(el.composer);
  document.addEventListener('click', (e) => { if (!e.target.closest('.tool-menu')) closeMenus(); });
  document.querySelectorAll('[data-template]').forEach((btn) => btn.addEventListener('click', () => useTemplate(btn.dataset.template)));
  el.btnProbeProxy.addEventListener('click', async () => {
    el.btnProbeProxy.disabled = true;
    try {
      const r = await api('/api/endpoints', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: el.baseUrl.value.trim(), proxy: el.proxy.value.trim() || 'auto' })
      });
      if (r.proxy) {
        const used = r.proxy.url ? `${r.proxy.url}（来源：${r.proxy.source}）` : '未检测到代理，将直连';
        el.proxyHint.className = 'hint is-ok';
        el.proxyHint.textContent = '当前出口：' + used;
        toast('代理探测：' + used, 'ok', 4000);
        if (!r.proxy.url) toast('没探测到系统代理。若浏览器能打开站点，请手动填代理地址（如 http://127.0.0.1:7890）', 'warn', 7000);
      } else {
        el.proxyHint.className = 'hint is-error';
        el.proxyHint.textContent = '探测失败：' + (r.error || '未知错误');
      }
    } catch (e) {
      toast('探测失败：' + e.message, 'err');
    } finally {
      el.btnProbeProxy.disabled = false;
    }
  });

  el.btnToggleKey.addEventListener('click', () => {
    const on = el.apiKey.type === 'password';
    el.apiKey.type = on ? 'text' : 'password';
    el.btnToggleKey.textContent = on ? '隐藏密钥' : '显示密钥';
  });

  el.btnFetchModels.addEventListener('click', () => fetchModels({ silent: false }));
  el.btnTest.addEventListener('click', runConnectivityTest);
  el.btnHelp.addEventListener('click', () => showDialog(el.helpModal, el.helpClose));
  el.helpClose.addEventListener('click', () => hideDialog(el.helpModal));
  el.helpModal.addEventListener('click', (e) => { if (e.target === el.helpModal) hideDialog(el.helpModal); });

  el.btnShowAllModels.addEventListener('click', () => {
    state.showAll = !state.showAll;
    el.btnShowAllModels.dataset.on = state.showAll ? '1' : '0';
    renderModelList();
    toast(state.showAll ? '显示全部模型' : '仅显示图像模型', 'info', 1600);
  });

  el.modelSelect.addEventListener('change', () => {
    if (el.modelSelect.value) el.modelManual.value = el.modelSelect.value;
    syncToolbar(); saveConfig();
  });
  el.modelManual.addEventListener('input', syncToolbar);
  el.modelManual.addEventListener('change', () => { syncToolbar(); saveConfig(); });

  el.btnSizeCustom.addEventListener('click', applyCustomSize);
  el.sizeCustom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustomSize(); } });

  ['quality', 'count', 'background', 'outputFormat'].forEach((k) => {
    el[k].addEventListener('change', () => saveConfig());
  });

  el.btnResetParams.addEventListener('click', () => {
    el.quality.value = 'high'; el.count.value = '1'; el.background.value = 'auto'; el.outputFormat.value = 'auto';
    state.style = 'none'; renderCreativeOptions();
    selectSize('1024x1024'); persistUi(); saveConfig();
    toast('参数已重置', 'ok', 1600);
  });

  el.btnPickFiles.addEventListener('click', pickReferenceImages);
  el.dropZone.addEventListener('click', pickReferenceImages);
  el.fileInput.addEventListener('change', async () => { await addFiles(el.fileInput.files); el.fileInput.value = ''; });
  el.btnClearRefs.addEventListener('click', () => { if (state.busy || state.pendingUploads) return; state.refs = []; updateRefs(); });

  ['dragenter', 'dragover'].forEach((ev) => el.composer.addEventListener(ev, (e) => { e.preventDefault(); el.composer.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => el.composer.addEventListener(ev, (e) => { e.preventDefault(); el.composer.classList.remove('is-over'); }));
  el.composer.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

  document.addEventListener('paste', (e) => {
    if (!el.settingsModal.hidden || !el.helpModal.hidden || !el.lightbox.hidden) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) if (it.kind === 'file' && /^image\//.test(it.type)) files.push(it.getAsFile());
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  el.prompt.addEventListener('input', updatePromptLen);
  el.btnClearPrompt.addEventListener('click', () => { el.prompt.value = ''; updatePromptLen(); el.prompt.focus(); });
  el.btnGenerate.addEventListener('click', generate);

  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    if (e.key === 'Escape') {
      if (!el.lightbox.hidden) closeLightbox();
      else if (!el.settingsModal.hidden) closeSettings();
      else if (!el.helpModal.hidden) hideDialog(el.helpModal);
      else { closeMenus(); document.body.classList.remove('sidebar-open'); }
    }
    const dialog = [el.lightbox, el.settingsModal, el.helpModal].find((node) => !node.hidden);
    if (dialog && e.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')]
        .filter((node) => !node.disabled && node.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!focusable.includes(document.activeElement) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });

  el.btnRefreshHistory.addEventListener('click', () => { loadHistory(); toast('历史记录已刷新', 'ok', 1500); });
  el.btnClearHistory.addEventListener('click', async () => {
    if (!confirm('清空全部历史记录？（已下载的图片不受影响，gallery 目录里的文件不会被删除）')) return;
    if (state.busy) return;
    try {
      await api('/api/history', { method: 'DELETE' });
      newChat(); await loadHistory(); toast('历史已清空', 'ok');
    } catch (e) { toast('清空失败：' + e.message, 'err'); }
  });

  el.lbClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox) closeLightbox(); });
  el.lbDownload.addEventListener('click', () => {
    if (!state.lbCurrent) return;
    downloadImage(state.lbCurrent.item.images[state.lbCurrent.index], state.lbCurrent.item, state.lbCurrent.index);
  });
  el.lbCopyPrompt.addEventListener('click', () => { if (state.lbCurrent) copyText(state.lbCurrent.item.prompt); });
  el.lbReuse.addEventListener('click', () => { if (state.lbCurrent) reuseItem(state.lbCurrent.item); });
}

/* ───────────────────────────── 启动 ───────────────────────────── */

async function boot() {
  restoreUi();
  renderSizes();
  bind();
  updatePromptLen();
  renderCreativeOptions();
  await loadConfig();
  updateRefs();
  syncToolbar();
  await loadHistory();

  if (window.NativeBridge) {
    el.streamUpstream.closest('label').querySelector('.hint').textContent = '支持接收流式结果；安卓版会在响应完成后显示图片，暂不逐帧预览。';
    el.proxyHint.textContent = 'auto 使用手机的系统网络 / VPN，off 直连。手动代理地址应能从手机访问。';
    el.helpModal.querySelectorAll('p').forEach((p) => {
      if (p.textContent.includes('.gptimage2/gallery/')) {
        p.textContent = '图片与提示词历史保存在应用私有目录；点下载可导出图片。手机与电脑版数据分别保存。';
      }
    });
  }

  const hasSavedKey = el.keyHint.textContent.includes('已保存密钥');
  if (el.baseUrl.value && (el.apiKey.value || hasSavedKey)) {
    setStatus(hasSavedKey && !el.apiKey.value ? '已就绪 · 使用本地已保存密钥' : '已就绪', 'ok');
    fetchModels({ silent: true });
  } else {
    setStatus('未连接中转站', 'idle');
  }
  window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });
}

boot().catch((e) => { setStatus('页面初始化失败', 'error'); toast(e.message, 'err'); });
