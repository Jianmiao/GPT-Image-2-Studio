'use strict';

// Start the real CLI using only its supplied Node executable; no keys or providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const version = require('../package.json').version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function verifyLaunch(missingShell) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gptimage2-cli-test-'));
  const env = { ...process.env, GPTIMAGE2_DATA_DIR: root, GPTIMAGE2_API_KEY: '', GPTIMAGE2_BASE_URL: '' };
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  env.PATH = '';
  if (missingShell) {
    for (const key of Object.keys(env)) if (/^comspec$/i.test(key)) delete env[key];
    env.ComSpec = path.join(root, 'missing-cmd.exe');
  }
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/cli.js'), '--port', String(port), '--no-open'], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let spawnError;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { spawnError = error; });
  try {
    let health;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !health) {
      assert.equal(spawnError, undefined, 'CLI process starts');
      assert.equal(child.exitCode, null, 'CLI remains alive without a system PATH: ' + output);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(500) });
        if (response.ok) health = await response.json();
      } catch (_) {}
      if (!health) await pause(75);
    }
    assert.ok(health && health.ok, 'CLI health endpoint is ready: ' + output);
    assert.equal(health.version, version);
    await pause(100);
    assert.equal(child.exitCode, null, 'Optional console setup cannot crash the app: ' + output);
    console.log('PASS CLI starts with empty PATH' + (missingShell ? ' and unavailable optional shell' : ''));
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('gptimage2-cli-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  await verifyLaunch(false);
  if (process.platform === 'win32') await verifyLaunch(true);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
