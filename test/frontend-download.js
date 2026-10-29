'use strict';

// Real browser downloads with isolated storage and local image/API fixtures.
// Does not load the app backend, user settings, user browser profile or any key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { makePng } = require('./png');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-download-ui-'));
const profile = path.join(scratch, 'browser');
const downloads = path.join(scratch, 'downloads');
fs.mkdirSync(profile); fs.mkdirSync(downloads);
const webRoot = path.resolve(__dirname, '../web');
const png = makePng(72, 48, { seed: 31 });
const browserPath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
const requests = [], blocked = [], errors = [], completed = [];
let mode = 'error', releaseDownload, downloadGate;
let origin, imageOrigin, child, ws, seq = 0;
const pending = new Map();
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function imageReply(res) { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png); }
const imageServer = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, undefined, 'Image host must receive no credentials');
  requests.push('IMAGE ' + req.url);
  imageReply(res);
});
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, origin || 'http://localhost').pathname;
  requests.push(req.method + ' ' + route);
  if (route === '/api/config') return json(res, { baseUrl: '', hasApiKey: false, model: 'fixture-model', moderation: 'low' });
  if (route === '/api/appearance') return json(res, { themePreference: 'dark' });
  if (route === '/api/endpoints') return json(res, { error: 'No provider configured' });
  if (route === '/api/history') return json(res, { items: [{ id: 'download-fixture', prompt: '本地下载回归', model: 'fixture-model', size: '72x48', count: 4, createdAt: '2026-10-29T00:00:00Z', elapsedMs: 1,
    images: [{ url: imageOrigin + '/original.png', mime: 'image/png', remote: true, saveError: 'ECONNRESET' },
      { url: '/gallery/local.png', mime: 'image/png' }, { url: 'data:image/png;base64,' + png.toString('base64'), mime: 'image/png' },
      { url: imageOrigin.replace('://', '://user:pass@') + '/credential-url.png', mime: 'image/png', remote: true, saveError: 'fixture URL must not become a link' }]
  }] });
  if (route === '/api/download') {
    assert.equal(req.headers.authorization, undefined, 'Download endpoint must receive no provider key');
    if (downloadGate) await downloadGate;
    if (mode === 'error') return json(res, { error: '本地模拟 ECONNRESET' }, 502);
    if (mode === 'invalid') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>expired image link</html>'); }
    if (mode === 'empty') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(); }
    return imageReply(res);
  }
  if (route === '/gallery/local.png') return imageReply(res);
  const name = route === '/' ? 'index.html' : route.slice(1);
  if (!['index.html', 'styles.css', 'theme.js', 'app.js', 'android-bridge.js'].includes(name)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(fs.readFileSync(path.join(webRoot, name)));
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 12000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(70); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  assert.ok(browserPath, 'Provide BROWSER_PATH for Edge/Chrome');
  imageOrigin = await listen(imageServer); origin = await listen(server);
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-allow-origins=*', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const active = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(active), 'Browser debugging port');
  const [port, socket] = fs.readFileSync(active, 'utf8').trim().split(/\r?\n/);
  ws = new WebSocket('ws://127.0.0.1:' + port + socket);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') completed.push(m.params.guid);
    if (m.method === 'Fetch.requestPaused') {
      const u = new URL(m.params.request.url);
      const allowed = [origin, imageOrigin].includes(u.origin) || ['data:', 'blob:'].includes(u.protocol);
      if (!allowed) blocked.push(u.origin);
      cdp(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: m.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, m.sessionId).catch(error => errors.push(error.message));
    }
  });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp(method, params, sessionId);
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = (expression, label) => until(() => evaluate(expression), label);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const downloadCount = () => requests.filter(value => value === 'GET /api/download').length;
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url: origin });
  await wait('!!document.querySelector(".history-item")', 'History fixture loaded');
  await click('.history-item');
  await wait('document.querySelectorAll(".result-card").length === 1', 'Result card opened');
  await click('.result-actions button');
  await wait('document.getElementById("toasts").textContent.includes("下载失败")', 'Remote HTTP error is visible to the user');
  assert.equal(downloadCount(), 1, 'One manual click means one download request');
  assert.equal(completed.length, 0, 'Failed HTTP response is never downloaded as an image');
  assert.match(await evaluate('document.querySelector(".result-card").textContent'), /下载失败.*ECONNRESET/);
  const link = await evaluate(`(() => { const a=document.querySelector('.result-card a[data-original-image]');return {href:a?.href,target:a?.target,rel:a?.rel}; })()`);
  assert.equal(link.href, imageOrigin + '/original.png'); assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/);
  assert.equal(await evaluate('document.querySelectorAll("a[data-original-image]").length'), 1, 'Credential-bearing source URLs must not become recovery links');
  console.log('PASS HTTP download errors are visible, persistent and offer a safe original-image link');

  for (const nextMode of ['invalid', 'empty']) {
    mode = nextMode; await click('.result-actions button');
    await wait('document.querySelector(".result-actions button").disabled === false && !document.querySelector(".result-card [data-download-feedback]").hidden', 'Invalid download is rejected');
    assert.match(await evaluate('document.querySelector(".result-card [data-download-feedback]").textContent'), /下载失败/);
    assert.equal(completed.length, 0, 'Invalid response cannot become a saved image');
  }
  console.log('PASS HTML and empty image bodies are rejected without a false success');

  mode = 'ok'; downloadGate = new Promise(resolve => { releaseDownload = resolve; });
  const before = downloadCount();
  await click('.result-media img'); await click('#lbDownload');
  await wait('document.getElementById("lbDownload").disabled && document.querySelector(".result-actions button").disabled', 'Both download buttons lock during the same image request');
  assert.equal(await evaluate('document.querySelectorAll(".result-card a[data-original-image]").length'), 0, 'The recovery link is only shown after a download failure');
  await click('.result-actions button');
  await until(() => downloadCount() - before === 1, 'One loopback download reaches its hold point');
  assert.equal(downloadCount() - before, 1, 'Card/lightbox cannot download the same image concurrently');
  await click('#lbClose'); await click('.result-media figure:nth-child(2) img');
  assert.equal(await evaluate('document.getElementById("lbDownload").disabled'), false, 'Switching lightbox image does not inherit another image download lock');
  releaseDownload(); downloadGate = null;
  await until(() => completed.length === 1, 'Remote browser download completed');
  await wait('document.querySelector(".result-actions button").disabled === false', 'Original button is restored');
  assert.match(await evaluate('document.getElementById("toasts").textContent'), /已交给浏览器下载.*下载列表/);
  assert.equal(await evaluate('document.querySelector(".result-card [data-download-feedback]").hidden'), true, 'Successful manual retry clears stale download error');
  await click('#lbDownload'); await until(() => completed.length === 2, 'Local gallery browser download completed');
  await click('#lbClose'); await click('.result-media figure:nth-child(3) img'); await click('#lbDownload');
  await until(() => completed.length === 3, 'Inline browser download completed');
  for (const filename of fs.readdirSync(downloads)) {
    assert.ok(!filename.endsWith('.crdownload'), 'No unfinished browser downloads');
    assert.deepEqual(fs.readFileSync(path.join(downloads, filename)), png, 'Browser preserves exact image bytes for ' + filename);
  }
  assert.equal(fs.readdirSync(downloads).length, 3, 'Remote, gallery and data URLs each saved one image');
  console.log('PASS concurrent click guard, retry, lightbox switching and three exact-byte browser downloads');

  const credentialImageRequests = requests.filter(value => value === 'IMAGE /credential-url.png').length;
  const downloadsBeforeCredential = completed.length;
  await click('.result-actions button:nth-child(4)');
  await wait('document.getElementById("toasts").textContent.includes("账号或密码")', 'Credential-bearing image URLs are rejected');
  await pause(100);
  assert.equal(requests.filter(value => value === 'IMAGE /credential-url.png').length, credentialImageRequests, 'No browser request uses a credential-bearing URL');
  assert.equal(completed.length, downloadsBeforeCredential, 'Credential-bearing URL is never downloaded');
  console.log('PASS credential-bearing image URLs are rejected without opening them');

  await evaluate('window.nativeDownloads = []; window.NativeBridge = {download: (...args) => window.nativeDownloads.push(args)}');
  const requestsBeforeNative = downloadCount(); await click('#lbDownload');
  assert.equal(await evaluate('window.nativeDownloads.length'), 1, 'NativeBridge download behavior is preserved');
  assert.equal(downloadCount(), requestsBeforeNative, 'Native downloads bypass the web download endpoint');
  assert.equal(requests.some(value => value.includes('/api/generate')), false, 'No generation request may occur');
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  console.log('PASS NativeBridge handoff, no generation, no credentials and local-only network');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (releaseDownload) releaseDownload();
  if (ws) { await cdp('Browser.close').catch(() => {}); ws.close(); }
  if (child) child.kill();
  for (const s of [server, imageServer]) { s.closeAllConnections(); if (s.listening) await new Promise(resolve => s.close(resolve)); }
  console.log('Test artifacts: ' + scratch);
});
