'use strict';

// No network or personal configuration: capture requests at the transport boundary.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-moderation-'));
process.env.GPTIMAGE2_DATA_DIR = dataDir;
delete process.env.GPTIMAGE2_API_KEY;
delete process.env.GPTIMAGE2_BASE_URL;
const store = require('../server/store');
const { buildCommonParams, generateWithFallback } = require('../server/server');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/i8sAAAAASUVORK5CYII=';
const reference = 'data:image/png;base64,' + PNG;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function transport(response) {
  const calls = [];
  return {
    calls,
    options: {
      baseUrl: 'http://127.0.0.1:1', apiKey: 'local-moderation-fixture',
      fetchImpl: async (url, init) => {
        calls.push({ url, ...init });
        return response || new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  };
}

test('new configurations default to low and saved auto survives loading and unrelated saves', () => {
  assert.equal(store.getConfig().moderation, 'low');
  assert.equal(store.publicConfig().moderation, 'low');
  store.saveConfig({ moderation: 'auto' });
  assert.equal(store.getConfig().moderation, 'auto');
  store.saveConfig({ quality: 'high' });
  assert.equal(store.getConfig().moderation, 'auto');
});

test('request settings override saved settings, with low as the missing-value default', () => {
  assert.equal(buildCommonParams({}, {}).moderation, 'low');
  assert.equal(buildCommonParams({}, { moderation: 'auto' }).moderation, 'auto');
  assert.equal(buildCommonParams({ moderation: 'auto' }, { moderation: 'low' }).moderation, 'auto');
  assert.equal(buildCommonParams({ moderation: 'low' }, { moderation: 'auto' }).moderation, 'low');
});

const routes = [
  { name: 'Images generation', body: { method: 'images' }, endpoint: '/images/generations' },
  { name: 'default multipart edit', body: { images: [reference] }, endpoint: '/images/edits', multipart: true },
  { name: 'JSON edit', body: { method: 'images', editEndpoint: 'json', images: [reference] }, endpoint: '/images/edits' },
  { name: 'Responses generation', body: { method: 'responses' }, endpoint: '/responses', responses: true },
  { name: 'Responses edit', body: { method: 'responses', images: [reference] }, endpoint: '/responses', responses: true }
];

for (const route of routes) {
  for (const moderation of ['low', 'auto']) {
    test(route.name + ' respects ' + moderation + ' with exactly one upstream submission', async () => {
      const mock = transport();
      const params = buildCommonParams({ model: 'gpt-image-2', prompt: 'A flower', moderation, ...route.body }, {});
      const result = await generateWithFallback(params, mock.options);
      assert.equal(result.images.length, 1);
      assert.equal(mock.calls.length, 1);
      const request = mock.calls[0];
      assert.ok(request.url.endsWith(route.endpoint));
      if (route.multipart) {
        const text = request.body.toString('utf8');
        const field = /name="moderation"\r\n\r\n([^\r]+)/.exec(text);
        assert.equal(field ? field[1] : undefined, moderation === 'low' ? 'low' : undefined);
      } else {
        const payload = JSON.parse(request.body);
        const options = route.responses ? payload.tools[0] : payload;
        assert.equal(options.moderation, moderation === 'low' ? 'low' : undefined);
        if (route.responses) assert.equal(payload.moderation, undefined, 'Moderation belongs on the image tool');
      }
    });
  }
}

for (const images of [[], [reference]]) {
  test('non-GPT Images model omits unsupported moderation, references=' + images.length, async () => {
    const mock = transport();
    await generateWithFallback(buildCommonParams({ model: 'dall-e-3', prompt: 'A flower', images, moderation: 'low' }, {}), mock.options);
    assert.doesNotMatch(mock.calls[0].body.toString(), /moderation/);
  });
}

test('Chat does not invent an unsupported moderation parameter', async () => {
  const mock = transport();
  await generateWithFallback(buildCommonParams({ method: 'chat', prompt: 'A flower', moderation: 'low' }, {}), mock.options);
  assert.equal(JSON.parse(mock.calls[0].body).moderation, undefined);
});

test('an upstream moderation refusal preserves the error and is never retried', async () => {
  const mock = transport(new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'Local moderation fixture refusal' } }), {
    status: 400, headers: { 'Content-Type': 'application/json', 'x-request-id': 'local-refusal' }
  }));
  await assert.rejects(generateWithFallback(buildCommonParams({ prompt: 'A flower', moderation: 'low' }, {}), mock.options), error => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Local moderation fixture refusal');
    assert.equal(error.requestId, 'local-refusal');
    assert.match(error.raw, /moderation_blocked/);
    return true;
  });
  assert.equal(mock.calls.length, 1);
});
