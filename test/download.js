'use strict';

// Only loopback image fixtures and an in-memory configuration; no personal files or keys.
const assert = require('node:assert/strict');
const http = require('node:http');
delete process.env.GPTIMAGE2_API_KEY;
delete process.env.GPTIMAGE2_BASE_URL;
const store = require('../server/store');
const originalConfig = store.getConfig;
let allowPrivateHost = true;
store.getConfig = () => ({ proxy: 'off', allowPrivateHost, apiKey: 'must-never-be-forwarded' });
const app = require('../server/server');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/i8sAAAAASUVORK5CYII=', 'base64');
const requests = [];
let redirectOrigin;

function imageReply(res) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length, Connection: 'close' });
  res.end(PNG);
}
function record(req) { requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization }); }
const redirected = http.createServer((req, res) => { record(req); imageReply(res); });
const images = http.createServer((req, res) => {
  record(req);
  if (req.url === '/redirect') { res.writeHead(302, { Location: redirectOrigin + '/final' }); res.end(); return; }
  if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
  if (req.url === '/reset') { req.socket.destroy(); return; }
  if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>not an image</html>'); return; }
  if (req.url === '/large') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 128 * 1024 * 1024 + 1 }); res.flushHeaders(); return; }
  if (req.url === '/keepalive' || req.url === '/truncated') {
    const data = req.url === '/truncated' ? PNG.subarray(0, 16) : PNG;
    res.socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: '
      + PNG.length + '\r\nConnection: keep-alive\r\n\r\n'), data]));
    if (req.url === '/truncated') res.socket.end();
    return;
  }
  imageReply(res);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
async function close(server) {
  if (!server.listening) return;
  const stopped = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await stopped;
}

async function main() {
  redirectOrigin = await listen(redirected);
  const origin = await listen(images);
  const { url } = await app.start(0, '127.0.0.1');
  function download(remote, name = 'picture.png') {
    return fetch(url + '/api/download?url=' + encodeURIComponent(origin + remote) + '&name=' + encodeURIComponent(name), {
      signal: AbortSignal.timeout(2000)
    });
  }
  async function assertImage(response, label) {
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG, label + ' preserves original bytes');
  }
  const chinese = '\u6a58\u732b-\u4e2d\u6587\u56fe\u7247.png';
  const named = await download('/image', chinese);
  await assertImage(named, 'Chinese filename downloads successfully');
  const disposition = named.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), chinese);

  const unsafe = await download('/image', '../bad\\name\r\n"\u6a58\u732b.png');
  await assertImage(unsafe, 'Filename control and path characters cannot break headers');
  const cleanName = decodeURIComponent(unsafe.headers.get('content-disposition').split("filename*=UTF-8''")[1]);
  assert.doesNotMatch(cleanName, /[\x00-\x1f\x7f/\\:"<>|?*]/);
  const longName = await download('/image', 'a'.repeat(500) + '.png');
  await assertImage(longName, 'Long filename is bounded');
  assert.ok(decodeURIComponent(longName.headers.get('content-disposition').split("filename*=UTF-8''")[1]).length <= 180);

  for (const route of ['/keepalive', '/redirect']) await assertImage(await download(route), route);
  for (const route of ['/html', '/truncated', '/reset', '/large', '/loop']) {
    const response = await download(route);
    assert.equal(response.status, 502, route + ' returns a download error');
    const error = await response.json();
    assert.ok(error.error, route + ' returns a readable JSON error');
  }
  const beforeBlocked = requests.length;
  allowPrivateHost = false;
  assert.equal((await download('/image')).status, 403, 'Private-host setting keeps its existing status');
  assert.equal(requests.length, beforeBlocked, 'Blocked target is never contacted');
  assert.equal(requests.filter(r => r.url === '/loop').length, 4, 'Redirect loop stops after three redirects');
  for (const request of requests) {
    assert.equal(request.method, 'GET', 'Downloading never resubmits image generation');
    assert.equal(request.authorization, undefined, 'Neither image origin nor redirect receives an API key');
  }
  console.log('PASS local downloads: Unicode filenames, sanitation, complete keepalive, redirects, invalid/truncated/reset/oversize errors, private-host gate and no credentials or generation POSTs');
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  store.getConfig = originalConfig;
  await Promise.all([app.server, images, redirected].map(close));
});
