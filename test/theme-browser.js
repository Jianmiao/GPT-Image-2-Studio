'use strict';
// Real desktop server + isolated Edge/Chrome profile. No user settings, keys or generation calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-theme-browser-'));
const data = path.join(scratch, 'data'), profile = path.join(scratch, 'browser');
fs.mkdirSync(data); fs.mkdirSync(profile);
process.env.GPTIMAGE2_DATA_DIR = data;
process.env.GPTIMAGE2_API_KEY = 'fake-no-key';
delete process.env.GPTIMAGE2_BASE_URL;
const config = JSON.stringify({ baseUrl: '', apiKey: '', proxy: 'off' });
fs.writeFileSync(path.join(data, 'config.json'), config);
fs.writeFileSync(path.join(data, 'history.json'), '[]');
const { server, start } = require('../server/server');
const browserPath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
let child, ws, seq = 0;
const pending = new Map(), blocked = [], origins = new Set();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 10000);
  pending.set(id, { resolve, reject, timer, method });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function tab(origin) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp(method, params, sessionId);
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error('Browser condition not met: ' + expression);
  };
  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.themeBeforeLoad=localStorage.getItem('gptimage2.theme.v1')" });
  await send('Page.navigate', { url: origin });
  await wait("!!document.getElementById('themePreference') && document.readyState === 'complete'");
  const saved = () => wait("document.getElementById('themeHint').textContent.startsWith('已保存到工具本地')");
  const select = async value => {
    await evaluate(`document.getElementById('btnSettings').click();document.getElementById('themePreference').value=${JSON.stringify(value)};document.getElementById('themePreference').dispatchEvent(new Event('change'))`);
    await saved();
    assert.equal(await evaluate("document.getElementById('themePreference').value"), value);
  };
  return { send, evaluate, wait, saved, select, close: () => cdp('Target.closeTarget', { targetId }) };
}
(async () => {
  assert.ok(browserPath, 'Provide BROWSER_PATH for Edge/Chrome (Node 22+ required)');
  let { url: origin } = await start(0, '127.0.0.1'); origins.add(origin);
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-allow-origins=*', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const active = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(active); i++) await pause(100);
  const [port, socket] = fs.readFileSync(active, 'utf8').trim().split(/\r?\n/);
  ws = new WebSocket('ws://127.0.0.1:' + port + socket);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(p.method + ': ' + m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Fetch.requestPaused') {
      const u = new URL(m.params.request.url);
      const allowed = origins.has(u.origin) && (!u.pathname.startsWith('/api/') || ['/api/config', '/api/history', '/api/appearance', '/api/endpoints'].includes(u.pathname));
      if (!allowed) blocked.push(m.params.request.method + ' ' + u.pathname);
      cdp(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: m.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, m.sessionId).catch(() => {});
    }
  });
  let page = await tab(origin);
  await page.select('light');
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light');
  await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await page.close();
  page = await tab(origin); await page.saved();
  assert.equal(await page.evaluate('window.themeBeforeLoad'), null, 'Fresh tab starts without a browser preference');
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light', 'Clearing browser data must preserve the tool preference');
  await page.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const oldOrigin = origin;
  ({ url: origin } = await start(0, '127.0.0.1')); origins.add(origin);
  assert.notEqual(origin, oldOrigin, 'Restart on a different port');
  page = await tab(origin); await page.saved();
  assert.equal(await page.evaluate('window.themeBeforeLoad'), null, 'New origin has empty storage');
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light', 'Different origin uses the stored theme');
  await page.select('system');
  await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await page.close();
  page = await tab(origin); await page.saved();
  assert.equal(await page.evaluate("document.getElementById('themePreference').value"), 'system', 'System preference persists without browser storage');
  for (const value of ['dark', 'light']) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    await page.wait(`document.documentElement.dataset.theme === '${value}'`);
  }
  await page.evaluate("for(const value of ['dark','light']){const s=document.getElementById('themePreference');s.value=value;s.dispatchEvent(new Event('change'));}");
  await page.saved();
  assert.deepEqual(await (await fetch(origin + '/api/appearance')).json(), { themePreference: 'light' }, 'Rapid changes save the last selection');
  assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), config, 'Theme does not change connection settings');
  assert.equal(fs.readFileSync(path.join(data, 'history.json'), 'utf8'), '[]', 'Theme does not change history');
  assert.deepEqual(blocked, [], 'No external, model or generation requests');
  console.log('PASS real browser: saved theme survives tab close, cleared storage, new origin and server restart; system changes and rapid selection persist');
  await cdp('Browser.close');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  if (ws) ws.close(); if (child) child.kill();
  server.closeAllConnections(); server.close();
  console.log('Isolated test data: ' + scratch);
});
