#!/usr/bin/env node
'use strict';
/**
 * 一键跑全部测试（不接触任何真实中转站，不需要 API Key）
 *   node test/run-all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  ['前端一致性', 'ui-static-check.js'],
  ['Android 桥接', 'android-bridge.js'],
  ['尺寸格式兼容', 'size-notation.js'],
  ['网关异常归因', 'gateway-errors.js'],
  ['代理响应形状', 'proxy-shapes.js'],
  ['网络层端到端', 'net-e2e.js'],
  ['图片二进制传输', 'net-binary.js'],
  ['电脑图片自动保存', 'desktop-gallery.js'],
  ['全链路冒烟', 'smoke.js']
];

let failed = 0;
const results = [];
for (const [name, file] of suites) {
  process.stdout.write('▶ ' + name + ' … ');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', windowsHide: true });
  const okSuite = r.status === 0;
  if (!okSuite) failed++;
  results.push({ name, ok: okSuite, out: (r.stdout || '') + (r.stderr || '') });
  console.log(okSuite ? '\x1b[32m通过\x1b[0m' : '\x1b[31m失败\x1b[0m');
}

console.log('');
for (const r of results) {
  if (r.ok) continue;
  console.log('----- ' + r.name + ' 输出 -----');
  console.log(r.out.trim().split('\n').slice(-25).join('\n'));
}
console.log(failed
  ? '\x1b[31m' + failed + ' 个套件失败\x1b[0m'
  : '\x1b[32m全部 ' + results.length + ' 个测试套件通过\x1b[0m');
process.exit(failed ? 1 : 0);
