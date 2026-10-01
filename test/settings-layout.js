'use strict';
/** Isolated layout/theme browser regression. No app server, keys or external requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-settings-'));
const webRoot = path.resolve(__dirname, '../web');
const browserPath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
assert.ok(browserPath, 'Provide BROWSER_PATH for Edge/Chrome');
const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!['index.html', 'styles.css', 'theme.js'].includes(name)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(path.join(webRoot, name), 'utf8');
  if (name === 'index.html') body = body.replace(/<script[^>]*src="\/(?:app|android-bridge)\.js"[^>]*><\/script>/g, '');
  res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(body);
});
let child, ws;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-allow-origins=*', '--user-data-dir=' + scratch, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const active = path.join(scratch, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(active); i++) await pause(100);
  const [port, socket] = fs.readFileSync(active, 'utf8').trim().split(/\r?\n/);
  ws = new WebSocket('ws://127.0.0.1:' + port + socket);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp(method, params, sessionId);
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  await send('Page.enable');
  for (const [width, height] of [[390, 844], [360, 640], [820, 1180], [1440, 1000]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, mobile: width < 700, deviceScaleFactor: 1 });
    await send('Page.navigate', { url: origin });
    for (let i = 0; i < 80 && !await evaluate("!!document.querySelector('#settingsModal .adv')"); i++) await pause(50);
    await evaluate("document.getElementById('settingsModal').hidden=false; document.querySelector('#settingsModal .modal-content').scrollTop=99999");
    await pause(100);
    await evaluate("document.querySelector('#settingsModal .adv > summary').click()");
    await pause(180);
    const geometry = await evaluate(`(() => { const d=document.querySelector('#settingsModal .adv'),c=document.querySelector('#settingsModal .modal-content'),f=document.getElementById('method'),s=document.getElementById('btnSaveSettings'); const r=f.getBoundingClientRect(),cr=c.getBoundingClientRect(),sr=s.getBoundingClientRect(); return {open:d.open,firstTop:r.top,firstBottom:r.bottom,contentTop:cr.top,contentBottom:cr.bottom,scrollTop:c.scrollTop,scrollHeight:c.scrollHeight,clientHeight:c.clientHeight,saveVisible:sr.top>=0&&sr.bottom<=innerHeight,firstVisible:r.top>=cr.top&&r.bottom<=cr.bottom}; })()`);
    console.log(width + 'x' + height, geometry);
    assert.ok(geometry.open && geometry.firstVisible, 'Opening advanced settings must reveal its first field: ' + JSON.stringify(geometry));
    assert.ok(geometry.saveVisible, 'Save remains visible');
    for (const field of ['method', 'editEndpoint', 'timeoutSeconds', 'moderation', 'streamUpstream']) {
      const visible = await evaluate(`(() => { const e=document.getElementById('${field}');e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(),c=e.closest('.modal-content').getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom; })()`);
      assert.ok(visible, field + ' remains reachable by scrolling');
    }
    await evaluate("document.getElementById('themePreference').value='light';document.getElementById('themePreference').dispatchEvent(new Event('change'))");
    const light = await evaluate("({theme:document.documentElement.dataset.theme,body:getComputedStyle(document.body).backgroundColor,field:getComputedStyle(document.getElementById('method')).backgroundColor,text:getComputedStyle(document.getElementById('method')).color})");
    assert.equal(light.theme, 'light');
    assert.equal(light.body, 'rgb(247, 248, 250)', 'Light canvas is applied');
    assert.equal(light.field, 'rgb(255, 255, 255)', 'Light controls are applied');
    assert.equal(light.text, 'rgb(32, 38, 49)', 'Light controls retain dark, readable text');
    if (process.env.UI_SCREENSHOTS !== '0') {
      const shot=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(scratch,'settings-'+width+'-light.png'),Buffer.from(shot.data,'base64'));
      if (width === 390 || width === 1440) {
        await evaluate("document.querySelector('#settingsModal .modal-content').scrollTop=0");
        const settingsTop=await send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(scratch,'theme-settings-'+width+'.png'),Buffer.from(settingsTop.data,'base64'));
        await evaluate("document.getElementById('settingsModal').hidden=true");
        const main=await send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(scratch,'main-'+width+'-light.png'),Buffer.from(main.data,'base64'));
      }
    }
  }
  console.log('PASS advanced settings visible, scrollable and save button reachable');
  await send('Page.reload');
  for (let i = 0; i < 80 && !await evaluate("document.getElementById('themePreference')?.value==='light'"); i++) await pause(50);
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'light', 'Theme persists across reload');
  await evaluate("document.getElementById('themePreference').value='system';document.getElementById('themePreference').dispatchEvent(new Event('change'))");
  for (const value of ['dark', 'light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    await pause(100);
    assert.equal(await evaluate("document.documentElement.dataset.theme"), value, 'System preference change applies live');
  }
  await evaluate("document.getElementById('themePreference').value='dark';document.getElementById('themePreference').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(25, 25, 25)', 'Explicit dark restores original appearance');
  await evaluate("localStorage.removeItem('gptimage2.theme.v1')");
  await send('Page.reload');
  for (let i = 0; i < 80 && !await evaluate("!!document.getElementById('themePreference')"); i++) await pause(50);
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark', 'No saved preference preserves the original dark default');
  console.log('PASS light/dark/system themes, live system updates and reload persistence');
  await cdp('Browser.close');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => { if (ws) ws.close(); if (child) child.kill(); server.closeAllConnections(); server.close(); console.log('Artifacts: ' + scratch); });
