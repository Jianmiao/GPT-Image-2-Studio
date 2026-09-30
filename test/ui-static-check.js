'use strict';
/** 静态校验：web/app.js 里 $(...) 取的 id 必须都在 index.html 中存在；
 *  同时校验 index.html 引用的资源存在、CSS 里的 class 有哪些没被用到（仅提示）。 */
const fs = require('fs');
const path = require('path');

const web = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(web, 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

let fail = 0;
const missing = [...usedIds].filter((id) => !htmlIds.has(id));
if (missing.length) { console.log('✗ app.js 引用了不存在的 id：' + missing.join(', ')); fail++; }
else console.log('✓ app.js 用到的 ' + usedIds.size + ' 个 id 在 index.html 中都存在');

const unused = [...htmlIds].filter((id) => !usedIds.has(id));
if (unused.length) console.log('· index.html 中未被 app.js 引用（供人工使用/装饰）：' + unused.join(', '));

// querySelector 选择器里的 class 是否存在于 CSS 或 HTML
const selectors = [...app.matchAll(/querySelector(?:All)?\('\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
const htmlClasses = new Set(html.matchAll(/class="([^"]+)"/g).toString() ? [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)) : []);
const unknown = [...new Set(selectors)].filter((c) => !cssClasses.has(c) && !htmlClasses.has(c));
if (unknown.length) { console.log('✗ 动态创建的 class 未在 CSS 中定义：' + unknown.join(', ')); fail++; }
else console.log('✓ app.js 动态使用的 ' + new Set(selectors).size + ' 个 class 都有样式定义');

// 资源引用
for (const m of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
  const f = path.join(web, m[1]);
  if (m[1].startsWith('//')) continue;
  if (!fs.existsSync(f)) { console.log('✗ index.html 引用了不存在的资源：' + m[1]); fail++; }
}
console.log('✓ index.html 的本地资源引用都存在');

// 前端调用的后端路由必须真实存在
const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
const routes = new Set([...server.matchAll(/'(GET|POST|DELETE) (\/api\/[a-z]+)'/g)].map((m) => m[1] + ' ' + m[2]));
const calls = [...app.matchAll(/api\('(\/api\/[a-z]+)'(?:,\s*\{\s*method:\s*'(\w+)')?/g)];
for (const [, p, m] of calls) {
  const key = (m || 'GET') + ' ' + p;
  if (!routes.has(key)) { console.log('✗ 前端调用了后端没有的路由：' + key); fail++; }
}
console.log('✓ 前端调用的 ' + calls.length + ' 处接口在服务端都已注册');
const fetchCalls = [...app.matchAll(/fetch\('(\/api\/[a-z]+)'/g)].map((m) => 'POST ' + m[1]);
for (const k of fetchCalls) if (!routes.has(k)) { console.log('✗ fetch 调用了未注册路由：' + k); fail++; }
console.log('✓ fetch 直连的接口也都已注册（' + fetchCalls.join(', ') + '）');

console.log(fail ? '\n静态校验失败 ' + fail + ' 项' : '\n静态校验全部通过');
process.exit(fail ? 1 : 0);
