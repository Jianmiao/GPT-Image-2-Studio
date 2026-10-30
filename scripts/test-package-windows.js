'use strict';

// Packaging regression: only a temporary Git fixture and the explicitly supplied runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const [nodeExe, nodeLicense] = process.argv.slice(2);
assert.ok(nodeExe && nodeLicense, 'Usage: node scripts/test-package-windows.js <node.exe> <Node-LICENSE.txt>');
const script = path.resolve(__dirname, 'package-windows.ps1');
assert.ok(fs.existsSync(script), 'The release packager must exist');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'image-package-test-'));
const source = path.join(scratch, 'fixture');
fs.mkdirSync(source);
const childEnv = { ...process.env };
// A PowerShell 7 parent can export a module path that hides Windows PowerShell's bundled commands.
delete childEnv.PSModulePath;
delete childEnv.GPTIMAGE2_API_KEY;
delete childEnv.GPTIMAGE2_BASE_URL;
const launcher = '\u542f\u52a8\u5de5\u5177.bat';
const notes = '\u53d1\u5e03\u8bf4\u660e.txt';
const contents = {
  'package.json': JSON.stringify({ name: 'local-package-fixture', version: '1.2.6' }),
  'LICENSE': 'MIT\n',
  'README.md': '# Local fixture\n\n![Preview](docs/ui-preview.png)\n\nKeep this text.\n',
  [launcher]: '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0server\\cli.js" %*\r\n',
  [notes]: 'Local fixture release notes.\n',
  'server/cli.js': 'console.log("local fixture");\n',
  'web/index.html': '<!doctype html><title>Fixture</title>\n',
  'test/png.js': 'exports.makePng = () => Buffer.alloc(0);\n',
  'server/private.png': 'not a real image',
  'test/personal.jpg': 'not a real image',
  'docs/ui-preview.png': 'not a real image',
  '.env': 'TEST_FIXTURE_ONLY=true\n',
  '.gptimage2/config.json': '{"apiKey":"fictional-test-key-do-not-package"}\n',
  'node_modules/private.js': 'throw new Error("do not package");\n'
};
const git = args => cp.execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
function build(output) {
  return cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-SourceRoot', source, '-NodeExe', path.resolve(nodeExe), '-NodeLicense', path.resolve(nodeLicense), '-OutputZip', output],
  { encoding: 'utf8', windowsHide: true, env: childEnv });
}
try {
  for (const [name, content] of Object.entries(contents)) {
    const destination = path.join(source, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  git(['init', '--quiet']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '--', ...Object.keys(contents)]);
  fs.writeFileSync(path.join(source, 'server/untracked.js'), 'throw new Error("untracked");\n');
  const outputs = [path.join(scratch, 'first.zip'), path.join(scratch, 'second.zip')];
  for (const output of outputs) {
    const result = build(output);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(outputs[0]), hash(outputs[1]), 'Same tracked inputs produce byte-identical ZIPs');
  const manifest = fs.readFileSync(outputs[0] + '.manifest.txt', 'utf8');
  for (const required of ['server/cli.js', 'web/index.html', 'test/png.js', launcher, notes, 'runtime/node.exe', 'runtime/LICENSE.txt', 'runtime/ORIGIN.txt']) {
    assert.ok(manifest.includes('  ' + required), 'Package includes ' + required);
  }
  for (const forbidden of ['.env', '.gptimage2', 'node_modules', 'untracked.js', '.png', '.jpg', 'docs/']) {
    assert.ok(!manifest.includes(forbidden), 'Package excludes ' + forbidden);
  }
  const inspectCode = "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('" + outputs[0].replaceAll("'", "''")
    + "'); try { $e=$z.Entries | Where-Object { $_.FullName -match '/README.md$' }; $r=New-Object IO.StreamReader($e.Open()); try { $r.ReadToEnd() } finally { $r.Dispose() } } finally { $z.Dispose() }";
  const inspect = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', inspectCode],
  { encoding: 'utf8', windowsHide: true, env: childEnv });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.ok(inspect.stdout.includes('Keep this text.'), 'Packaged README keeps normal documentation');
  assert.ok(!inspect.stdout.includes('docs/ui-preview.png'), 'Packaged README omits the unbundled preview');
  assert.ok(fs.readFileSync(path.join(source, 'README.md'), 'utf8').includes('docs/ui-preview.png'), 'Source README is unchanged');
  const repeated = build(outputs[0]);
  assert.notEqual(repeated.status, 0, 'An existing output is not silently overwritten');
  console.log('PASS Windows packager: tracked source whitelist, private/media exclusions, runtime/license/provenance, reproducible ZIP, packaged README and no overwrite');
} finally {
  assert.equal(path.dirname(scratch), os.tmpdir());
  assert.ok(path.basename(scratch).startsWith('image-package-test-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
