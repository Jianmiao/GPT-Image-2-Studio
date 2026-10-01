'use strict';

// Isolated local providers, synthetic image bytes and a fake key only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-desktop-gallery-'));
process.env.GPTIMAGE2_DATA_DIR = dataDir;
process.env.GPTIMAGE2_API_KEY = 'sk-gallery-local-only';
delete process.env.GPTIMAGE2_BASE_URL;
const app = require('../server/server');
const store = require('../server/store');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/i8sAAAAASUVORK5CYII=', 'base64');
const KEY = 'sk-gallery-local-only';
const relayRequests = [];
const imageRequests = [];
const redirectRequests = [];
let currentCase = 'url';
let imageOrigin;
let redirectOrigin;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
}
async function close(server) {
  if (!server.listening) return;
  const done = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await done;
}
function imageReply(res) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length, Connection: 'close' });
  res.end(PNG);
}
function logRequest(log, req) {
  log.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
}
const redirectServer = http.createServer((req, res) => {
  logRequest(redirectRequests, req);
  imageReply(res);
});
const imageServer = http.createServer((req, res) => {
  logRequest(imageRequests, req);
  if (req.url === '/keepalive.png') {
    // Deliberately ignore Connection: close and never end the response/socket.
    res.socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: '
      + PNG.length + '\r\nConnection: keep-alive\r\n\r\n'), PNG]));
    return;
  }
  if (req.url === '/truncated.png') {
    const socket = res.socket;
    socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: '
      + PNG.length + '\r\nConnection: close\r\n\r\n'), PNG.subarray(0, 16)]), () => socket.destroy());
    return;
  }
  res.setHeader('Connection', 'close');
  if (req.url === '/missing.png') { res.writeHead(503); res.end('local storage unavailable'); return; }
  if (req.url === '/redirect.png') { res.writeHead(302, { Location: redirectOrigin + '/final.png' }); res.end(); return; }
  if (req.url === '/invalid.png') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>not an image</html>'); return; }
  imageReply(res);
});
const relayServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  logRequest(relayRequests, req);
  res.setHeader('Connection', 'close');
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (currentCase === 'binary') { imageReply(res); return; }
  const filename = currentCase === 'failure' ? 'missing.png'
    : currentCase === 'redirect' ? 'redirect.png'
    : currentCase === 'keepalive' ? 'keepalive.png'
    : currentCase === 'truncated' ? 'truncated.png'
    : currentCase === 'invalid' ? 'invalid.png' : 'original.png';
  const output = currentCase.startsWith('base64')
    ? { b64_json: PNG.toString('base64') } : { url: imageOrigin + '/' + filename };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'image_generation.completed', data: [output] }) + '\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [output] }));
  }
});

async function main() {
  redirectOrigin = await listen(redirectServer);
  imageOrigin = await listen(imageServer);
  const relayOrigin = await listen(relayServer);
  const { url } = await app.start(0, '127.0.0.1');
  async function generate(name, stream = false, expectHistory = true) {
    currentCase = name;
    const before = relayRequests.length;
    const response = await fetch(url + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: relayOrigin, apiKey: KEY, model: 'gpt-image-2', prompt: 'local synthetic test',
        method: 'images', size: '1024x1024', proxy: 'off', allowPrivateHost: true, stream })
    });
    assert.equal(response.status, 200, name + ': generation succeeds');
    const text = await response.text();
    let item;
    if (stream) {
      const events = text.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.filter(event => event.type === 'error').length, 0, name + ': no generation error event');
      const done = events.filter(event => event.type === 'done');
      assert.equal(done.length, 1, name + ': one completion event');
      item = done[0].item;
    } else {
      const result = JSON.parse(text);
      assert.equal(result.ok, true, name + ': JSON success');
      item = result.item;
    }
    assert.equal(relayRequests.length - before, 1, name + ': exactly one upstream request');
    assert.equal(relayRequests.at(-1).method, 'POST');
    assert.equal(relayRequests.at(-1).url, '/v1/images/generations');
    assert.equal(relayRequests.at(-1).authorization, 'Bearer ' + KEY);
    assert.equal(item.images.length, 1);
    const history = store.getHistory().find(entry => entry.id === item.id);
    if (expectHistory) assert.deepEqual(history.images, item.images, name + ': history records the completed save result');
    else assert.ok(item.historyError, name + ': history write failure is separate from generation success');
    return item.images[0];
  }
  function assertLocal(image, label) {
    assert.match(image.url, /^\/gallery\//, label + ': successful remote image must be saved in gallery');
    assert.deepEqual(fs.readFileSync(path.join(dataDir, image.url)), PNG, label + ': preserve every original image byte');
    assert.equal(image.saveError, undefined, label + ': no save error');
  }
  for (const stream of [false, true]) {
    const before = imageRequests.length;
    assertLocal(await generate('url', stream), stream ? 'SSE URL' : 'JSON URL');
    assert.equal(imageRequests.length - before, 1, 'Fetch each returned image URL exactly once');
  }
  const beforeKeepalive = imageRequests.length;
  const keepaliveStarted = performance.now();
  let forcedClose = false;
  const keepaliveDeadline = setTimeout(() => {
    forcedClose = true;
    imageServer.closeAllConnections();
  }, 2000);
  try {
    const image = await generate('keepalive');
    assert.equal(forcedClose, false, 'A complete Content-Length image must finish without waiting for socket closure');
    assert.ok(performance.now() - keepaliveStarted < 2000, 'Save a complete keep-alive response in under two seconds');
    assertLocal(image, 'Complete Content-Length over a persistent socket');
    assert.equal(imageRequests.length - beforeKeepalive, 1, 'A persistent image response does not trigger another GET');
  } finally { clearTimeout(keepaliveDeadline); }
  const beforeRedirect = redirectRequests.length;
  assertLocal(await generate('redirect'), 'Cross-origin image redirect');
  assert.equal(redirectRequests.length - beforeRedirect, 1, 'Follow image redirect with one GET');
  for (const name of ['failure', 'invalid', 'truncated']) {
    for (const stream of [false, true]) {
      const before = imageRequests.length;
      const galleryBefore = fs.readdirSync(path.join(dataDir, 'gallery')).sort();
      const image = await generate(name, stream);
      assert.equal(image.remote, true, name + ': preserve remote result for manual recovery');
      assert.match(image.url, /^http:\/\/127\.0\.0\.1:/);
      assert.ok(image.saveError, name + ': explain local save failure without rejecting generation');
      assert.equal(imageRequests.length - before, 1, name + ': failed image download is not retried');
      assert.deepEqual(fs.readdirSync(path.join(dataDir, 'gallery')).sort(), galleryBefore, name + ': never store a broken or truncated image');
    }
  }
  const beforeBase64 = imageRequests.length;
  assertLocal(await generate('binary'), 'Direct upstream PNG response');
  assert.equal(imageRequests.length, beforeBase64, 'Direct image responses do not download again');
  assertLocal(await generate('base64'), 'Existing base64 result');
  assert.equal(imageRequests.length, beforeBase64, 'Base64 results never fetch an image URL');
  const originalSave = store.saveImage;
  store.saveImage = () => { throw new Error('synthetic local disk failure'); };
  try {
    const image = await generate('base64-save-failure');
    assert.equal(image.inline, true, 'Base64 disk failure keeps usable inline result');
    assert.equal(image.url, 'data:image/png;base64,' + PNG.toString('base64'));
    assert.equal(imageRequests.length, beforeBase64, 'Base64 disk failure never calls a remote fallback');
    const remote = await generate('url');
    assert.equal(remote.remote, true, 'Downloaded image disk failure keeps the original URL');
    assert.equal(remote.url, imageOrigin + '/original.png');
    assert.ok(remote.saveError, 'Downloaded image disk failure is explained in the successful result');
    assert.equal(imageRequests.length, beforeBase64 + 1, 'Disk failure never downloads the same image again');
  } finally { store.saveImage = originalSave; }
  const originalHistory = store.addHistory;
  store.addHistory = () => { throw new Error('synthetic history write failure'); };
  try {
    for (const stream of [false, true]) assertLocal(await generate('base64', stream, false), 'History failure keeps saved image');
  } finally { store.addHistory = originalHistory; }
  for (const request of [...imageRequests, ...redirectRequests]) {
    assert.equal(request.method, 'GET', 'Image storage only receives GET');
    assert.equal(request.authorization, undefined, 'Never forward provider authorization to image storage or redirects');
  }
  console.log('PASS desktop gallery: JSON/SSE URL and binary bytes, keep-alive completion, truncation, redirects, save failures, base64, one POST and no key forwarding');
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await Promise.all([app.server, relayServer, imageServer, redirectServer].map(close));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.match(path.basename(dataDir), /^image-desktop-gallery-/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
