'use strict';
/**
 * 网关异常行为测试（纯本地，不打任何真实 API）
 * 覆盖三类以前会给出误导信息的失败：
 *   1. 代理接受 CONNECT 后隧道内零字节        → 旧: "请检查供应商地址/代理/Key"（误导）
 *   2. 代理拒绝 CONNECT（非 200）             → 旧: 通用 ECONNRESET（丢掉状态码）
 *   3. 响应没有可读流却当流式处理             → 旧: "Cannot read properties of undefined (reading 'getReader')"
 *
 * 注意：模拟代理必须用裸 TCP。用 http.createServer 会对 CONNECT 做特殊处理，
 * 干扰 200/502 应答的观察（写这个测试时踩过两次坑）。
 */
const netmod = require('net');
const net = require('../server/net');

let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name + (cond ? '' : '  → ' + extra));
  if (!cond) fail = 1;
};

/** 迷你代理：mode = 'empty'（200 后立刻断开）| 'refuse'（回 502）| 'ok' */
function startProxy(mode) {
  return new Promise((resolve) => {
    const srv = netmod.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        if (mode === 'refuse') {
          sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
          setTimeout(() => sock.destroy(), 30);
        } else if (mode === 'empty') {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          setTimeout(() => sock.end(), 30);
        } else {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  /* 1. 空隧道：应归因到"代理节点连不到该站点" */
  const p1 = await startProxy('empty');
  try {
    await net.makeFetch('http://127.0.0.1:' + p1.address().port)('https://example.invalid/v1/models', { method: 'GET', timeoutMs: 6000 });
    ok('空隧道应失败', false, '竟然成功了');
  } catch (e) {
    const msg = String(e.message);
    ok('空隧道归因到"代理节点连不到该站点"', /连不到该站点/.test(msg), msg.slice(0, 160));
    ok('空隧道不再误报"请检查供应商地址"', !/请检查供应商地址/.test(msg), msg.slice(0, 160));
    ok('空隧道带了结构化归因信息', /tunnelOpened/.test(JSON.stringify(e.tunnelInfo || {})), JSON.stringify(e.tunnelInfo));
  }
  p1.close();

  /* 2. 代理拒绝 CONNECT：必须保留 502 */
  const p2 = await startProxy('refuse');
  try {
    await net.makeFetch('http://127.0.0.1:' + p2.address().port)('https://example.invalid/v1/models', { method: 'GET', timeoutMs: 6000 });
    ok('拒绝隧道应失败', false, '竟然成功了');
  } catch (e) {
    const msg = String(e.message);
    ok('拒绝隧道报出 502', /502/.test(msg), msg.slice(0, 160));
    ok('拒绝隧道错误码为 PROXY_CONNECT_502', e.code === 'PROXY_CONNECT_502', String(e.code));
    ok('拒绝隧道不再说"目标域名/节点不可达"', !/目标域名\/节点不可达/.test(msg), msg.slice(0, 160));
  }
  p2.close();

  /* 3. 声称流式却没有可读流 */
  try {
    const { consumeUpstream } = require('../server/server');
    await consumeUpstream({ headers: { get: () => 'text/event-stream' } }, null);
    ok('无 body 的流式响应应抛错', false, '没抛错');
  } catch (e) {
    ok('无 body 的流式响应给出可读错误', /没有可读数据流|无法解析的响应/.test(String(e.message)), String(e.message).slice(0, 140));
  }

  console.log(fail ? '\n\x1b[31m网关异常行为测试失败\x1b[0m' : '\n\x1b[32m网关异常行为测试通过\x1b[0m');
  process.exit(fail);
})();
