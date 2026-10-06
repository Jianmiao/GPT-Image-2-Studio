'use strict';
// Real local API + fresh processes; uses temporary files and never reads real settings or calls a relay.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

if (process.argv.includes('--worker')) {
  require('../server/server').start(0, '127.0.0.1').then(({ url }) => process.send({ url }));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-appearance-'));
  const config = '{"apiKey":"fake-local-only","model":"fake-model"}';
  const history = '{"items":[]}';
  fs.writeFileSync(path.join(root, 'config.json'), config);
  fs.writeFileSync(path.join(root, 'history.json'), history);
  let child;
  async function start() {
    child = fork(__filename, ['--worker'], { env: { ...process.env, GPTIMAGE2_DATA_DIR: root },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    return new Promise((resolve, reject) => {
      child.once('message', ({ url }) => resolve(url));
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Local server exited: ' + code)));
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await stopped;
    child = null;
  }
  async function request(url, themePreference, extra = {}) {
    return fetch(url + '/api/appearance', themePreference === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themePreference, ...extra })
    });
  }
  (async () => {
    let url = await start();
    let response = await request(url);
    assert.equal(response.status, 200, 'Appearance endpoint must restore a saved theme independently of browser storage');
    assert.deepEqual(await response.json(), { themePreference: null }, 'Missing setting allows migration from the old browser preference');
    for (const theme of ['light', 'dark', 'system']) {
      response = await request(url, theme, { apiKey: 'must-not-be-persisted', extra: true });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { themePreference: theme });
      await stop();
      url = await start();
      assert.deepEqual(await (await request(url)).json(), { themePreference: theme }, 'Fresh process retains ' + theme);
      const file = JSON.parse(fs.readFileSync(path.join(root, 'appearance.json'), 'utf8'));
      assert.deepEqual(file, { themePreference: theme }, 'Appearance stores no keys or unrelated fields');
    }
    for (const invalid of ['auto', '', null, false, {}, ['light']]) {
      assert.equal((await request(url, invalid)).status, 400, 'Reject invalid theme');
    }
    assert.deepEqual(await (await request(url)).json(), { themePreference: 'system' }, 'Invalid writes preserve saved preference');
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), config);
    assert.equal(fs.readFileSync(path.join(root, 'history.json'), 'utf8'), history);
    fs.unlinkSync(path.join(root, 'appearance.json'));
    fs.mkdirSync(path.join(root, 'appearance.json'));
    assert.ok(!(await request(url, 'light')).ok, 'Disk write failure cannot report saved');
    console.log('PASS durable light/dark/system across process restarts, validation, storage failures and isolated connection/history data');
  })().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    await stop();
    // Only this test-created temporary directory is removed.
    fs.rmSync(root, { recursive: true, force: true });
  });
}
