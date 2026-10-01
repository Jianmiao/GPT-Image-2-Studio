'use strict';

// Local mock servers only: no credentials, settings, or real image services.
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeFetch } = require('../server/net');

const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO5kAAAAASUVORK5CYII=', 'base64');
const text = 'hello \u56fe\u7247 \ud83c\udf08';
const json = { message: text, count: 1 };
let directRequests = 0;
let proxyRequests = 0;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const direct = http.createServer((req, res) => {
  directRequests++;
  const body = req.url === '/png' ? png : req.url === '/text' ? Buffer.from(text)
    : req.url === '/json' ? Buffer.from(JSON.stringify(json)) : binary;
  res.writeHead(200, { 'Content-Type': req.url === '/png' ? 'image/png' : 'application/octet-stream', Connection: 'close' });
  res.write(body.subarray(0, 7));
  setImmediate(() => res.end(body.subarray(7)));
});
const proxy = http.createServer();
proxy.on('connect', (req, socket) => {
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  let input = '';
  const onData = (chunk) => {
    input += chunk.toString('latin1');
    if (!input.includes('\r\n\r\n')) return;
    socket.removeListener('data', onData);
    proxyRequests++;
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ' + png.length + '\r\nConnection: close\r\n\r\n');
    socket.write(png.subarray(0, 11));
    setImmediate(() => socket.end(png.subarray(11)));
  };
  socket.on('data', onData);
});

(async () => {
  try {
    await listen(direct);
    await listen(proxy);
    const base = 'http://127.0.0.1:' + direct.address().port;
    const fetch = makeFetch('off');
    const response = await fetch(base + '/binary');
    const result = await response.arrayBuffer();
    assert.deepEqual(Buffer.from(result), binary, 'arrayBuffer preserves all bytes, including 0xff and 0x00');
    assert.ok(result instanceof ArrayBuffer, 'arrayBuffer returns an ArrayBuffer');
    await assert.rejects(response.text(), TypeError, 'body can only be consumed once');
    assert.deepEqual(Buffer.from(await (await fetch(base + '/png')).arrayBuffer()), png, 'PNG bytes are unchanged');
    assert.equal(await (await fetch(base + '/text')).text(), text, 'text decodes split UTF-8 characters');
    assert.deepEqual(await (await fetch(base + '/json')).json(), json, 'JSON still decodes text');
    const streamed = await fetch(base + '/binary');
    const reader = streamed.body.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assert.deepEqual(Buffer.concat(chunks), binary, 'body remains a byte-readable stream');
    await assert.rejects(streamed.arrayBuffer(), TypeError, 'stream reader retains single consumption');
    const throughProxy = makeFetch('http://127.0.0.1:' + proxy.address().port);
    const proxied = await throughProxy('http://offline-relay.invalid/png');
    assert.equal(proxied._viaProxy, true);
    assert.deepEqual(Buffer.from(await proxied.arrayBuffer()), png, 'proxy response preserves PNG bytes');
    assert.equal(directRequests, 5, 'one direct request per fetch');
    assert.equal(proxyRequests, 1, 'one request through the mock proxy');
    console.log('Binary response checks passed (direct, proxy, stream, text and JSON)');
  } finally {
    direct.closeAllConnections();
    direct.close();
    proxy.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
