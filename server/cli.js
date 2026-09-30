#!/usr/bin/env node
'use strict';
/**
 * 启动本地服务并（可选）打开浏览器
 *   node server/cli.js [--port 8787] [--host 127.0.0.1] [--no-open]
 */
const path = require('path');
const { spawn } = require('child_process');
const { start } = require('./server');

function parseArgs(argv) {
  const out = { port: Number(process.env.PORT || 8787), host: '127.0.0.1', open: true, lan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--host') out.host = argv[++i] || out.host;
    else if (a === '--lan') { out.host = '0.0.0.0'; out.lan = true; }
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') {
      console.log('用法：node server/cli.js [--port 8787] [--host 127.0.0.1] [--lan] [--no-open]');
      process.exit(0);
    }
  }
  return out;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
}

/** Windows 控制台默认可能是 GBK(936)，而 Node 输出是 UTF-8，会让中文变乱码 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  try {
    spawn('cmd', ['/c', 'chcp 65001 >nul'], { stdio: 'ignore', windowsHide: true, detached: false });
  } catch (_) {}
}

(async () => {
  ensureUtf8Console();
  const args = parseArgs(process.argv.slice(2));
  try {
    const { url, port } = await start(args.port, args.host);
    console.log('');
    console.log('  \x1b[38;5;214m* GPT Image 2 · 中转站生图工具\x1b[0m');
    console.log('  -------------------------------------');
    console.log('  本地地址   \x1b[36m' + url + '\x1b[0m');
    if (args.lan) console.log('  局域网     已开启（--lan），注意他人可访问本机配置');
    console.log('  停止服务   Ctrl + C');
    console.log('');
    if (args.open) openBrowser(url);
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      console.error('端口 ' + args.port + ' 已被占用，请换一个：node server/cli.js --port 8788');
    } else {
      console.error('启动失败：', e && e.message ? e.message : e);
    }
    process.exit(1);
  }
})();
