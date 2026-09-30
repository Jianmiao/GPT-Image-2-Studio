'use strict';
/** Run the chat UI against a local fake relay in an isolated browser profile.
 * Requires Node 22+ and Edge/Chrome. Does not read the user's config or key.
 * Screenshots remain in the printed temporary directory for visual review.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { makePng } = require('./png');
const autoModeOnly = process.argv.includes('--auto-mode-only');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-chat-ui-'));
const dataDir = path.join(root, 'data');
const profile = path.join(root, 'browser');
const screenshotDir = process.env.GPTIMAGE2_UI_OUTPUT_DIR ? path.resolve(process.env.GPTIMAGE2_UI_OUTPUT_DIR) : root;
fs.mkdirSync(dataDir);
fs.mkdirSync(profile);
fs.mkdirSync(screenshotDir, { recursive: true });
process.env.GPTIMAGE2_DATA_DIR = dataDir;
process.env.GPTIMAGE2_API_KEY = 'sk-ui-test';
delete process.env.GPTIMAGE2_BASE_URL;
const KEY = 'sk-ui-test';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let relayMode = 'json';
let modelIds = ['gpt-image-2', 'gpt-image-2-auto'];
let modelDelay = 0;
const requests = [];
const blocked = [];
const png = makePng(640, 400, { seed: 2 });
const refFile = path.join(root, 'reference.png');
fs.writeFileSync(refFile, png);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const relayServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  const contentType = req.headers['content-type'] || '';
  const payload = contentType.includes('json') ? JSON.parse(body || '{}') : {};
  requests.push({ method: req.method, url: req.url, body, payload, contentType, auth: req.headers.authorization });
  if (req.headers.authorization !== 'Bearer ' + KEY) return json(res, 401, { error: { message: 'Only the fake UI test key is allowed' } });
  if (req.url === '/v1/models') {
    const data = modelIds.map((id) => ({ id }));
    if (modelDelay) await pause(modelDelay);
    return json(res, 200, { data });
  }
  if (!['/v1/images/generations', '/v1/images/edits'].includes(req.url)) return json(res, 404, { error: { message: 'Unknown local test endpoint' } });
  await pause(180);
  if (relayMode === 'error') return json(res, 400, { error: { message: '本地模拟审核拒绝', code: 'content_policy_violation' } });
  if (relayMode === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: png.toString('base64') }) + '\n\n');
    await pause(200);
    res.end('data: ' + JSON.stringify({ type: 'image_generation.completed', b64_json: png.toString('base64') }) + '\n\ndata: [DONE]\n\n');
    return;
  }
  json(res, 200, { created: 1, data: [{ b64_json: png.toString('base64') }] });
});

function browserPath() {
  const options = [process.env.BROWSER_PATH,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const found = options.find((value) => value && fs.existsSync(value));
  assert.ok(found, 'Set BROWSER_PATH to an installed Edge or Chrome');
  return found;
}

async function cdpClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const call = pending.get(msg.id);
    if (call) {
      clearTimeout(call.timer);
      pending.delete(msg.id);
      if (msg.error) call.reject(new Error(call.method + ': ' + msg.error.message));
      else call.resolve(msg.result);
    } else {
      for (const listener of listeners) listener(msg);
    }
  });
  return {
    ws, listeners,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 12000);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
  };
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  let app;
  let browser;
  let cdp;
  let pageSend;
  try {
    await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
    const relayUrl = 'http://127.0.0.1:' + relayServer.address().port;
    const configuredUrl = relayUrl + '/v1';
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ baseUrl: relayUrl, apiKey: '', proxy: 'off', allowPrivateHost: true }));
    const net = require('../server/net');
    const makeFetch = net.makeFetch;
    net.makeFetch = (...args) => {
      const original = makeFetch(...args);
      return Object.assign(async (url, init) => {
        assert.equal(new URL(url).origin, relayUrl, 'No upstream request may leave the local mock relay');
        const headers = new Headers(init && init.headers);
        assert.equal(headers.get('authorization'), 'Bearer ' + KEY, 'No real key may be used');
        return original(url, init);
      }, original);
    };
    app = require('../server/server');
    const started = await app.start(0, '127.0.0.1');
    browser = spawn(browserPath(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--remote-allow-origins=*', '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    const activePort = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(activePort); i++) await pause(100);
    assert.ok(fs.existsSync(activePort), 'Browser debugging port must start');
    const [port, socketPath] = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
    cdp = await cdpClient('ws://127.0.0.1:' + port + socketPath);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    pageSend = send;
    const errors = [];
    cdp.listeners.push((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Fetch.requestPaused') {
        const url = msg.params.request.url;
        const allowed = url.startsWith(started.url + '/') || url.startsWith('data:') || url.startsWith('blob:');
        if (!allowed) blocked.push(url);
        send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: msg.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch((e) => errors.push(e.message));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, label, timeout = 10000) => {
      const until = Date.now() + timeout;
      do {
        if (await evaluate(expression)) return;
        await pause(70);
      } while (Date.now() < until);
      throw new Error('Timed out: ' + label + '\n' + JSON.stringify(await evaluate('({ status: document.getElementById("statusText")?.textContent, error: document.querySelector(".error-card")?.textContent, toasts: document.getElementById("toasts")?.textContent })')));
    };
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (id, value) => evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const shot = async (name) => {
      await pause(180);
      // Hosted Windows runners may not expose a screenshot compositor. All
      // interaction and geometry assertions still run when capture is disabled.
      if (process.env.UI_SCREENSHOTS === '0') return;
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(screenshotDir, name + '.png');
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
      console.log('Screenshot: ' + file);
    };
    const postCount = () => requests.filter((r) => r.method === 'POST').length;
    const success = async (label) => {
      await waitFor('document.querySelectorAll("#results .result-media img").length > 0 && !document.querySelector("#results [data-role=live]") && !document.getElementById("btnGenerate").disabled', label);
      assert.equal(await evaluate('document.querySelectorAll("#results [data-role=live]").length'), 0, 'Finished requests remove live placeholders');
    };
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('gptimage2.ui.v1', JSON.stringify({ mode: 'edit' }));` });
    await send('Page.navigate', { url: started.url });
    await waitFor('document.getElementById("btnSettings") && document.getElementById("baseUrl").value.startsWith("http://127.0.0.1:")', 'UI ready');
    await waitFor('!document.getElementById("btnFetchModels").disabled && document.querySelectorAll("#modelSelect option:not(:disabled)").length === 2', 'Initial models loaded');
    await evaluate('if (document.getElementById("helpModal")) document.getElementById("helpModal").hidden = true');
    assert.equal(await evaluate('document.getElementById("refs").hidden'), true, 'A stale saved edit mode without uploaded images must start as text generation');
    assert.equal(await evaluate('document.querySelectorAll(".tab[data-mode]").length'), 0, 'Image mode is inferred from attachments, without manual mode tabs');
    assert.match(await evaluate('document.getElementById("generationModeLabel").textContent'), /文生图/);
    console.log('PASS stale saved edit mode is ignored; mode derives from attachments');
    if (autoModeOnly) return;
    assert.equal(await evaluate('document.getElementById("settingsModal").hidden'), true, 'Settings hidden by default');
    await shot('desktop-empty');

    await click('#btnSettings');
    assert.equal(await evaluate('document.getElementById("settingsModal").hidden'), false);
    await fill('baseUrl', configuredUrl);
    await fill('apiKey', KEY);
    await fill('modelManual', 'gpt-image-2');
    await fill('proxy', 'off');
    await evaluate('document.getElementById("allowPrivateHost").checked = true');
    await click('#btnFetchModels');
    await waitFor('!document.getElementById("btnFetchModels").disabled && !document.getElementById("settingsFeedback").hidden', 'Model feedback visible');
    await shot('desktop-settings');
    await click('#btnSaveSettings');
    await waitFor('document.getElementById("settingsModal").hidden', 'Settings saved');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(saved.baseUrl, configuredUrl);
    assert.equal(saved.apiKey, KEY);
    assert.equal(saved.model, 'gpt-image-2');
    assert.match(await evaluate('document.getElementById("modelLabel").textContent'), /gpt-image-2/);
    assert.equal(await evaluate('document.querySelectorAll("#modelSelect option:not(:disabled)").length'), 2, 'Saving a new provider preserves the models just fetched');
    const originalModels = await evaluate('[...document.getElementById("modelSelect").options].map(e => e.value)');
    modelIds = ['gpt-image-cancel-test'];
    await click('#btnSettings');
    await fill('baseUrl', relayUrl);
    await click('#btnFetchModels');
    await waitFor('!document.getElementById("btnFetchModels").disabled && document.getElementById("modelSelect").options[0].value === "gpt-image-cancel-test"', 'Draft provider models loaded');
    await click('#settingsClose');
    assert.equal(await evaluate('document.getElementById("baseUrl").value'), configuredUrl, 'Cancel restores saved provider');
    assert.deepEqual(await evaluate('[...document.getElementById("modelSelect").options].map(e => e.value)'), originalModels, 'Cancel restores saved model choices');
    modelDelay = 350;
    await click('#btnSettings');
    await fill('baseUrl', relayUrl);
    await click('#btnFetchModels');
    await click('#settingsClose');
    await waitFor('!document.getElementById("btnFetchModels").disabled', 'Stale model response settled');
    assert.deepEqual(await evaluate('[...document.getElementById("modelSelect").options].map(e => e.value)'), originalModels, 'Canceled pending response cannot replace saved models');
    modelDelay = 0;
    modelIds = originalModels;
    console.log('PASS settings save/cancel, model feedback and model list retention');

    await evaluate('document.getElementById("sizeCustom").closest("details").open = true');
    await fill('sizeCustom', '1280 * 720');
    await click('#btnSizeCustom');
    assert.equal(await evaluate('document.getElementById("sizeCustom").value'), '1280x720');
    await evaluate('document.querySelectorAll("details[open]").forEach(e => e.open = false)');
    const styles = await evaluate('document.querySelectorAll("#styleOptions .choice-item").length');
    assert.ok(styles > 1, 'Style menu must include selectable presets');
    await evaluate('document.getElementById("styleOptions").closest("details").open = true');
    await click('#styleOptions .choice-item:nth-child(2)');
    assert.ok(await evaluate('document.querySelector("#styleOptions .is-active") !== null'), 'Style selection updates');
    await evaluate('document.getElementById("templateOptions").closest("details").open = true');
    await click('#templateOptions [data-template]');
    assert.ok((await evaluate('document.getElementById("prompt").value')).length > 10, 'Template populates prompt');
    await evaluate('document.querySelectorAll("details[open]").forEach(e => e.open = false)');
    console.log('PASS size normalization, style and template');

    await fill('prompt', '本地测试：柔和光线下的一只橘猫');
    let before = postCount();
    await click('#btnGenerate');
    await success('JSON generation');
    assert.equal(postCount() - before, 1, 'JSON generation sends once');
    assert.equal(requests.filter((r) => r.method === 'POST').at(-1).payload.size, '1280x720');
    await shot('desktop-result');
    console.log('PASS JSON generation and final result');

    await click('#btnNewChat');
    assert.equal(await evaluate('document.querySelectorAll("#results .result-card").length'), 0, 'New chat clears displayed results');
    await waitFor('document.querySelectorAll("#archive .history-item").length === 1', 'History refreshed');
    assert.equal(await evaluate('document.querySelectorAll("#archive .history-item").length'), 1, 'New chat preserves history');
    await click('#archive .history-item');
    assert.equal(await evaluate('document.querySelectorAll("#results .result-card").length'), 1, 'History opens previous result');
    await fill('historySearch', '没有这个生成记录');
    assert.equal(await evaluate('document.querySelectorAll("#archive .history-item").length'), 0, 'History search filters');
    await fill('historySearch', '');
    await click('#btnNewChat');
    console.log('PASS history navigation, search and new chat');

    relayMode = 'sse';
    await evaluate('document.getElementById("streamUpstream").checked = true; document.getElementById("streamUpstream").dispatchEvent(new Event("change", { bubbles: true }))');
    await fill('prompt', '本地测试：流式生成');
    before = postCount();
    await click('#btnGenerate');
    await success('SSE generation');
    assert.equal(postCount() - before, 1, 'SSE generation sends once');
    console.log('PASS SSE completion');

    await click('#btnNewChat');
    relayMode = 'json';
    await evaluate('document.getElementById("streamUpstream").checked = false; document.getElementById("streamUpstream").dispatchEvent(new Event("change", { bubbles: true }))');
    await fill('prompt', '本地测试：参考图更换背景');
    await evaluate(`window.__originalUiRead = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function (...args) { setTimeout(() => window.__originalUiRead.apply(this, args), 450); };`);
    const doc = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
    before = postCount();
    await send('DOM.setFileInputFiles', { nodeId, files: [refFile] });
    await evaluate(`document.getElementById('btnGenerate').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));`);
    await pause(120);
    assert.equal(postCount(), before, 'Cannot submit before a reference file finishes loading');
    await waitFor('document.querySelectorAll("#refsList img").length === 1', 'Reference file loaded');
    await evaluate('FileReader.prototype.readAsDataURL = window.__originalUiRead; delete window.__originalUiRead');
    assert.equal(await evaluate('document.getElementById("refs").hidden'), false, 'Reference upload switches to edit mode');
    before = postCount();
    await click('#btnGenerate');
    await success('Image edit');
    const edit = requests.filter((r) => r.method === 'POST').at(-1);
    assert.equal(postCount() - before, 1, 'Image edit sends once');
    assert.equal(edit.url, '/v1/images/edits');
    assert.match(edit.contentType, /multipart\/form-data/);
    assert.match(await evaluate('document.getElementById("generationModeLabel").textContent'), /图生图/);
    console.log('PASS upload auto-switch and multipart edit');

    await click('#refsList .ref-del');
    assert.equal(await evaluate('document.getElementById("refs").hidden'), true, 'Removing the final reference hides the reference section');
    assert.match(await evaluate('document.getElementById("generationModeLabel").textContent'), /文生图/);
    await fill('prompt', '本地测试：删除最后一张参考图后自动文生图');
    before = postCount();
    await click('#btnGenerate');
    await success('Text generation after final reference removal');
    assert.equal(postCount() - before, 1, 'Removing the last reference then generating sends once');
    assert.equal(requests.filter((r) => r.method === 'POST').at(-1).url, '/v1/images/generations');
    await send('DOM.setFileInputFiles', { nodeId, files: [refFile] });
    await waitFor('document.querySelectorAll("#refsList img").length === 1', 'Reference re-added for clear test');
    await click('#btnClearRefs');
    assert.equal(await evaluate('document.getElementById("refs").hidden'), true, 'Clearing references hides the reference section');
    assert.match(await evaluate('document.getElementById("generationModeLabel").textContent'), /文生图/);
    await fill('prompt', '本地测试：清空参考图后自动文生图');
    before = postCount();
    await click('#btnGenerate');
    await success('Text generation after clearing references');
    assert.equal(postCount() - before, 1, 'Clearing references then generating sends once');
    assert.equal(requests.filter((r) => r.method === 'POST').at(-1).url, '/v1/images/generations');
    console.log('PASS removing the final image and clearing images automatically restore text generation');

    await click('#btnNewChat');
    await fill('prompt', '本地测试：阻止双击和快捷键重复提交');
    await evaluate(`window.__originalUiTestFetch = window.fetch; window.fetch = async (...args) => { if (args[0] === '/api/config' && args[1]?.method === 'POST') await new Promise(r => setTimeout(r, 450)); return window.__originalUiTestFetch(...args); }`);
    before = postCount();
    await evaluate(`document.getElementById('btnGenerate').click(); document.getElementById('btnGenerate').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));`);
    await success('Duplicate guard');
    await pause(650);
    assert.equal(postCount() - before, 1, 'Double click and Ctrl+Enter send only one upstream POST');
    await evaluate('window.fetch = window.__originalUiTestFetch; delete window.__originalUiTestFetch');
    console.log('PASS duplicate submission guard during delayed config save');

    await click('#btnNewChat');
    relayMode = 'error';
    await fill('prompt', '本地测试：失败不可重试');
    before = postCount();
    await click('#btnGenerate');
    await waitFor('document.querySelector(".error-card") && !document.getElementById("btnGenerate").disabled', 'Failure shown');
    await pause(300);
    assert.equal(postCount() - before, 1, 'Failure never triggers a second upstream submission');
    assert.match(await evaluate('document.querySelector(".error-card").textContent'), /本地模拟审核拒绝/);
    assert.equal(await evaluate('document.querySelectorAll("#results [data-role=live]").length'), 0);
    console.log('PASS visible error without retry');

    await click('#btnNewChat');
    await waitFor('document.getElementById("toasts").children.length === 0', 'Transient notices dismissed');
    for (const width of [820, 1024]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const menu of ['model', 'size', 'style', 'template', 'more']) {
        await evaluate(`document.querySelectorAll('details[open]').forEach(e => e.open = false); document.querySelector('.${menu}-menu').open = true`);
        await pause(80);
        const bounds = await evaluate(`(() => { const p = document.querySelector('.${menu}-menu .tool-panel'); const r = p.getBoundingClientRect(); const center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, visible: p.contains(center) }; })()`);
        assert.ok(bounds.fits && bounds.visible, width + 'px ' + menu + ' menu must fit and remain visible: ' + JSON.stringify(bounds));
      }
      await shot('tablet-' + width + '-more');
    }
    await evaluate('document.querySelectorAll("details[open]").forEach(e => e.open = false)');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await pause(150);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile page must not overflow horizontally');
    const mobileFont = await evaluate(`({ prompt: parseFloat(getComputedStyle(document.getElementById('prompt')).fontSize), options: [...document.querySelectorAll('.tool-menu > summary')].map(e => ({ title: e.title, size: parseFloat(getComputedStyle(e).fontSize) })), targets: ['btnPickFiles', 'btnGenerate', 'btnToggleSidebar'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { id, width: r.width, height: r.height }; }) })`);
    assert.ok(mobileFont.prompt >= 16, 'Mobile prompt font must be at least 16px: ' + JSON.stringify(mobileFont));
    assert.ok(mobileFont.options.every(e => e.size >= 14), 'Mobile options must be at least 14px: ' + JSON.stringify(mobileFont));
    assert.ok(mobileFont.targets.every(e => e.width >= 44 && e.height >= 44), 'Primary mobile touch targets must be at least 44px: ' + JSON.stringify(mobileFont));
    assert.doesNotMatch(await evaluate('document.querySelector(".composer").innerText'), /Ctrl\s*\+?\s*V|拖拽|拖入|拖动/, 'Mobile composer must show touch-first instructions');
    await shot('mobile-empty');
    await send('DOM.setFileInputFiles', { nodeId, files: [refFile] });
    await waitFor('document.querySelectorAll("#refsList img").length === 1', 'Mobile reference loaded');
    assert.doesNotMatch(await evaluate('document.querySelector(".composer").innerText'), /Ctrl\s*\+?\s*V|拖拽|拖入|拖动/, 'Mobile reference section must not instruct dragging or Ctrl+V');
    await shot('mobile-reference');
    await click('#btnClearRefs');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
    for (const menu of ['model', 'size', 'style', 'template', 'more']) {
      await evaluate(`document.querySelectorAll('details[open]').forEach(e => e.open = false); document.querySelector('.${menu}-menu > summary').click()`);
      await pause(100);
      const bounds = await evaluate(`(() => { const p = document.querySelector('.${menu}-menu .tool-panel'); const r = p.getBoundingClientRect(); const center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, visible: p.contains(center) }; })()`);
      assert.ok(bounds.fits && bounds.visible, 'Mobile keyboard-height viewport ' + menu + ' menu stays visible: ' + JSON.stringify(bounds));
    }
    await evaluate('document.querySelectorAll("details[open]").forEach(e => e.open = false)');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    console.log('PASS mobile option panels fit when the keyboard reduces viewport height');
    await click('#btnToggleSidebar');
    await click('#btnSettings');
    await shot('mobile-settings');
    assert.ok(await evaluate('(() => { const e = document.getElementById("settingsModal").querySelector(".modal-dialog, .settings-dialog, .modal-card, .modal-panel") || document.getElementById("settingsModal").firstElementChild; const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1; })()'), 'Mobile settings stay in viewport');
    await click('#settingsClose');
    await evaluate('document.getElementById("sizeCustom").closest("details").open = true');
    await shot('mobile-size');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile size menu must not overflow horizontally');
    assert.deepEqual(errors, [], 'No uncaught browser exceptions');
    assert.deepEqual(blocked, [], 'No attempted external browser requests');
    assert.ok(requests.every((request) => request.auth === 'Bearer ' + KEY));
    assert.ok(fs.existsSync(path.join(dataDir, 'history.json')));
    console.log('PASS mobile layout and isolated data/network');
    console.log('All chat UI checks passed. Screenshots: ' + screenshotDir);
  } catch (error) {
    if (pageSend && process.env.UI_SCREENSHOTS !== '0') {
      try {
        const shot = await pageSend('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(path.join(screenshotDir, 'failure.png'), Buffer.from(shot.data, 'base64'));
      } catch (_) {}
    }
    throw error;
  } finally {
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.ws.close(); }
    if (browser) browser.kill();
    await closeServer(app && app.server);
    await closeServer(relayServer);
    // Profile cleanup is best-effort because Windows may still hold browser files.
    await pause(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    console.log('Test artifacts: ' + root);
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
