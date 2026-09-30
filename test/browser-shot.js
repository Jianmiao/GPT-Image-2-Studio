'use strict';
/**
 * 无头浏览器截图 / 页面状态检查（Edge 或 Chrome + CDP，无第三方依赖）
 *
 *   node test/browser-shot.js --url http://127.0.0.1:8787 --out shot.png
 *   node test/browser-shot.js --url ... --out shot.png --fill --click --gen-wait 6000
 *
 * --fill 填入示例提示词；--click 点击"开始生成"并等待 --gen-wait 毫秒后截图，
 * 用于一次性截取"有结果的完整界面"。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const URL_ = arg('url', 'http://127.0.0.1:8787');
const OUT = path.resolve(arg('out', 'shot.png'));
const WIDTH = Number(arg('width', 1680));
const HEIGHT = Number(arg('height', 1000));
const WAIT = Number(arg('wait', 4500));
const GEN_WAIT = Number(arg('gen-wait', 6000));
const FILL = argv.includes('--fill');
const CLICK = argv.includes('--click');
const DEBUG_PORT = Number(arg('cdp-port', 9333));
const KEEP = argv.includes('--keep');

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error('没有找到 Edge/Chrome，可用 BROWSER_PATH 环境变量指定');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- 极简 CDP 客户端 --------------------------- */

function createClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const logs = [];
    const events = [];
    let attached = null;

    const send = (method, params, sessionId) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej, method });
      ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); }
      }, 60000);
    });

    ws.addEventListener('open', () => resolve({ send, logs, events, getSession: () => attached, ws }));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败（浏览器可能拒绝了调试连接）')));
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(p.method + ' → ' + (msg.error.message || JSON.stringify(msg.error))));
        else p.res(msg.result);
        return;
      }
      if (msg.method === 'Target.attachedToTarget') attached = msg.params.sessionId;
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        logs.push('[页面异常] ' + (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || msg.params.exceptionDetails.text));
      }
    });
  });
}

async function waitForCdp(port) {
  let last = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
      return await r.json();
    } catch (e) { last = e; await sleep(300); }
  }
  throw new Error('CDP 端口未就绪：' + (last && last.message));
}

/* ------------------------------- 主流程 ------------------------------- */

(async () => {
  const browserPath = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-shot-'));
  const child = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    // 关键：headless 下不加这两个开关，截图可能拿到过期的合成帧
    '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
    '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--window-size=' + WIDTH + ',' + HEIGHT,
    '--remote-debugging-port=' + DEBUG_PORT,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  try {
    const version = await waitForCdp(DEBUG_PORT);
    console.log('浏览器：' + (version.Browser || browserPath));
    const cdp = await createClient(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => cdp.send(method, params, sessionId);

    await S('Page.enable');
    await S('Runtime.enable');
    await S('Log.enable').catch(() => {});
    await S('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url: URL_ });
    await sleep(WAIT);

    if (argv.includes('--no-help')) {
      await S('Runtime.evaluate', { expression: "document.getElementById('helpModal').hidden = true" });
    }

    // --setup <文件>：在截图前执行一段 JS（避免命令行引号地狱）
    const setupFile = arg('setup', '');
    if (setupFile && fs.existsSync(setupFile)) {
      const expr = fs.readFileSync(setupFile, 'utf8');
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      console.log('执行 setup(' + path.basename(setupFile) + ') → ' + JSON.stringify(r.result && r.result.value));
      await sleep(400);
    }

    const PRE = arg('eval', '');
    if (PRE) {
      const r = await S('Runtime.evaluate', { expression: PRE, returnByValue: true });
      console.log('执行 --eval：' + JSON.stringify(r.result && r.result.value));
      await sleep(300);
    }

    if (FILL) {
      const expr = `(() => {
        const p = document.getElementById('prompt');
        p.value = '一只戴着铜制护目镜的橙色虎斑猫，坐在老式暗房的木质工作台上，暖色安全灯从左上方打来，柯达胶片质感，浅景深，4:5 竖构图。';
        p.dispatchEvent(new Event('input', { bubbles: true }));
        const chip = document.querySelector('#sizeChips [data-size="1024x1024"]');
        if (chip) chip.click();
        return p.value.length;
      })()`;
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true });
      console.log('已填入示例提示词（' + (r.result && r.result.value) + ' 字）');
      await sleep(500);
    }

    if (CLICK) {
      await S('Runtime.evaluate', { expression: "document.getElementById('btnGenerate').click()", returnByValue: true });
      console.log('已点击「开始生成」，等待 ' + GEN_WAIT + 'ms …');
      await sleep(GEN_WAIT);
    }

    const dbg = await S('Runtime.evaluate', { expression: "JSON.stringify({href: location.href, ready: document.readyState, hasHelp: !!document.getElementById('helpModal'), helpHidden: document.getElementById('helpModal') && document.getElementById('helpModal').hidden, ctx: 'default'})", returnByValue: true });
    console.log('DOM 探针：' + (dbg.result && dbg.result.value) + (dbg.exceptionDetails ? ' | 异常 ' + JSON.stringify(dbg.exceptionDetails.text) : ''));
    // headless 下 Page.captureScreenshot 偶尔会返回过期的合成帧，
    // 所以先试合成器帧（screencast），拿不到再退回 captureScreenshot。
    let shotData = null;
    let shotFrom = 'captureScreenshot';
    try {
      cdp.events.length = 0;
      await S('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
      for (let i = 0; i < 40 && !shotData; i++) {
        await sleep(120);
        const frames = cdp.events.filter((e) => e.method === 'Page.screencastFrame');
        const frame = frames[frames.length - 1];
        if (frame && frame.params && frame.params.data) {
          shotData = frame.params.data;
          shotFrom = '合成器帧';
          await cdp.send('Page.screencastFrameAck', { sessionId: frame.params.sessionId, frameNumber: frame.params.metadata && frame.params.metadata.frameNumber }, frame.sessionId).catch(() => {});
        }
      }
      await S('Page.stopScreencast').catch(() => {});
    } catch (e) {
      console.log('合成器帧截图不可用：' + e.message);
    }
    if (!shotData) {
      const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      shotData = shot.data;
    }
    console.log('截图方式：' + shotFrom + (shotFrom === 'captureScreenshot' && !shotFrom.includes('合成') ? '' : ''));
    fs.writeFileSync(OUT, Buffer.from(shotData, 'base64'));

    const state = await S('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        status: document.getElementById('statusText').textContent,
        statusState: document.getElementById('statusPill').dataset.state,
        model: document.getElementById('modelManual').value,
        modelOptions: document.getElementById('modelSelect').options.length,
        resultCards: document.querySelectorAll('.result-card').length,
        resultImgs: document.querySelectorAll('.result-media img').length,
        archiveImgs: document.querySelectorAll('.arch-item img').length,
        loadedImgs: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length,
        brokenImgs: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).length,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
        errorText: [...document.querySelectorAll('.error-card p')].map(e => e.textContent),
        logLines: [...document.querySelectorAll('.progress-log div')].map(d => d.textContent),
        modelHint: document.getElementById('modelHint').textContent.slice(0, 120)
      }, null, 1)`,
      returnByValue: true
    });
    console.log('页面状态：' + (state.result && state.result.value));
    if (cdp.logs.length) console.log('页面日志：\n  ' + cdp.logs.join('\n  '));
    console.log('截图：' + OUT + '（' + fs.statSync(OUT).size + ' bytes，' + WIDTH + 'x' + HEIGHT + '）');
    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(600);
    if (!KEEP) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
    else console.log('保留浏览器 profile：' + profile);
  }
})().catch((e) => { console.error('截图失败：' + e.message); process.exit(1); });
