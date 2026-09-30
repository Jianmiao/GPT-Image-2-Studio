'use strict';
/** Native bridge contract checks in a VM. No WebView, user config or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'android-bridge.js'), 'utf8');
const ORIGIN = 'https://appassets.androidplatform.net';

function harness({ native = true, throwOnSend = false } = {}) {
  const messages = [], delegated = [], timers = new Map();
  let sequence = 0;
  const originalFetch = (...args) => {
    delegated.push(args);
    return Promise.resolve(new Response('simulated browser resource', { status: 200 }));
  };
  const window = { fetch: originalFetch };
  if (native) window.NativeBridge = {
    postMessage(raw) {
      if (throwOnSend) throw new Error('Native bridge unavailable');
      messages.push(JSON.parse(raw));
    },
    copyText() {}, download() {}
  };
  const document = { documentElement: { dataset: {} } };
  const sandbox = vm.createContext({
    window, document, location: new URL(ORIGIN + '/'), URL, Request, Response, DOMException,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, sandbox, { filename: 'android-bridge.js' });
  return { window, document, messages, delegated, timers, originalFetch,
    reload() { window.fetch = originalFetch; vm.runInContext(source, sandbox, { filename: 'android-bridge.js' }); },
    reply(message, status, value, type = 'application/json') {
      window.__nativeResponse(message.id, status, typeof value === 'string' ? value : JSON.stringify(value), type);
    }
  };
}

async function waitForMessage(h, count = 1) {
  const deadline = Date.now() + 5000;
  while (h.messages.length < count && Date.now() < deadline) await new Promise(setImmediate);
  assert.equal(h.messages.length, count, 'One native message must be dispatched per API call');
  return h.messages.at(-1);
}

(async () => {
  const desktop = harness({ native: false });
  assert.equal(desktop.window.fetch, desktop.originalFetch, 'Desktop keeps its original fetch');
  assert.equal(desktop.document.documentElement.dataset.platform, undefined);

  const h = harness();
  assert.equal(h.document.documentElement.dataset.platform, 'android');
  const config = h.window.fetch('/api/config?view=public');
  assert.deepEqual(h.messages[0], { id: h.messages[0].id, path: '/api/config?view=public', method: 'GET', body: '' });
  assert.ok(h.messages[0].id.length > 5 && h.messages[0].id.length <= 160);
  h.reply(h.messages[0], 200, { hasApiKey: false, model: 'gpt-image-2' });
  const response = await config;
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { hasApiKey: false, model: 'gpt-image-2' });
  assert.equal(h.timers.size, 0, 'Completed API requests remove their timeout');
  console.log('PASS desktop fallback, API routing and JSON responses');

  const body = JSON.stringify({ prompt: '仅本地测试', apiKey: 'sk-ui-test', count: 1 });
  const generation = h.window.fetch(ORIGIN + '/api/generate', { method: 'POST', body });
  assert.deepEqual(h.messages[1], { id: h.messages[1].id, path: '/api/generate', method: 'POST', body });
  assert.notEqual(h.messages[1].id, h.messages[0].id);
  h.reply(h.messages[1], 400, { error: '本地模拟拒绝', code: 'content_policy_violation' });
  const refused = await generation;
  assert.equal(refused.status, 400);
  assert.equal(refused.ok, false);
  assert.deepEqual(await refused.json(), { error: '本地模拟拒绝', code: 'content_policy_violation' });
  assert.equal(h.messages.length, 2, 'HTTP failure never resubmits a native request');

  const empty = h.window.fetch('/api/history', { method: 'DELETE' });
  h.reply(h.messages[2], 204, 'ignored');
  assert.equal(await (await empty).text(), '');
  const requestInput = new Request(ORIGIN + '/api/config', { method: 'POST', body: '{"model":"gpt-image-2"}' });
  const fromRequest = h.window.fetch(requestInput);
  const serialized = await waitForMessage(h, 4);
  assert.equal(serialized.method, 'POST');
  assert.equal(serialized.body, '{"model":"gpt-image-2"}');
  assert.equal(requestInput.bodyUsed, false, 'Reading a clone preserves caller Request body');
  h.reply(serialized, 200, 'saved', 'text/plain');
  const plain = await fromRequest;
  assert.equal(plain.headers.get('content-type'), 'text/plain');
  assert.equal(await plain.text(), 'saved');
  assert.equal(h.timers.size, 0);
  console.log('PASS POST body, Request inputs, HTTP errors and empty responses');

  const resourceOptions = { cache: 'no-store' };
  assert.equal(await (await h.window.fetch('/gallery/test.png', resourceOptions)).text(), 'simulated browser resource');
  await h.window.fetch('https://external.invalid/api/config');
  assert.equal(h.delegated.length, 2);
  assert.equal(h.delegated[0][0], '/gallery/test.png');
  assert.equal(h.delegated[0][1], resourceOptions);
  assert.equal(h.messages.length, 4, 'Non-local API and asset URLs use the browser fetch stub only');
  console.log('PASS non-API resources delegate without network access');

  const abortedBefore = new AbortController();
  abortedBefore.abort();
  await assert.rejects(h.window.fetch('/api/generate', { method: 'POST', body, signal: abortedBefore.signal }), { name: 'AbortError' });
  assert.equal(h.messages.length, 4, 'Already-aborted operations send nothing');

  const abortedDuring = new AbortController();
  const inFlight = h.window.fetch('/api/generate', { method: 'POST', body, signal: abortedDuring.signal });
  const sent = h.messages.at(-1);
  assert.equal(h.messages.length, 5);
  abortedDuring.abort();
  await assert.rejects(inFlight, { name: 'AbortError' });
  h.reply(sent, 200, { images: [] });
  h.reply(sent, 200, { images: [] });
  h.window.__nativeResponse('unknown-request', 200, '{}');
  assert.equal(h.messages.length, 5, 'Abort and late/duplicate callbacks never resend a generation');
  assert.equal(h.timers.size, 0);

  const failing = harness({ throwOnSend: true });
  await assert.rejects(failing.window.fetch('/api/generate', { method: 'POST', body }), /Native bridge unavailable/);
  assert.equal(failing.messages.length, 0);
  assert.equal(failing.timers.size, 0, 'Thrown bridge errors remove pending timers');

  const timed = harness();
  const timedOut = timed.window.fetch('/api/generate', { method: 'POST', body });
  const timer = timed.timers.values().next().value;
  timed.timers.clear(); // Real one-shot timers are consumed before running their callback.
  timer.callback();
  await assert.rejects(timedOut, /本地服务响应超时/);
  timed.reply(timed.messages[0], 200, { images: [] });
  assert.equal(timed.messages.length, 1, 'Timeout never sends a retry');
  console.log('PASS abort, duplicate callbacks, bridge failures and timeout remain single-submit');

  const reload = harness();
  const oldController = new AbortController();
  const oldRequest = reload.window.fetch('/api/generate', { method: 'POST', body, signal: oldController.signal });
  const oldMessage = reload.messages[0];
  reload.reload();
  let newSettled = false;
  const newRequest = reload.window.fetch('/api/config').then((result) => { newSettled = true; return result; });
  const newMessage = reload.messages[1];
  assert.notEqual(newMessage.id, oldMessage.id, 'A reloaded page does not reuse the old page request IDs');
  reload.reply(oldMessage, 200, { images: ['old-result'] });
  await new Promise(setImmediate);
  assert.equal(newSettled, false, 'The new page must not consume a callback from the old page');
  reload.reply(newMessage, 200, { hasApiKey: false });
  assert.deepEqual(await (await newRequest).json(), { hasApiKey: false });
  oldController.abort();
  await assert.rejects(oldRequest, { name: 'AbortError' });
  assert.equal(reload.messages.length, 2);
  assert.equal(reload.timers.size, 0);
  console.log('PASS reload IDs and stale response isolation');
  console.log('Android bridge checks passed without real API keys or network');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
