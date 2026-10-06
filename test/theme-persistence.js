'use strict';
/** Appearance persistence checks: isolated VM, no keys, user data or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'theme.js'), 'utf8');
const THEME_KEY = 'gptimage2.theme.v1';

function element() {
  const listeners = new Map();
  return {
    value: '', textContent: '', dataset: {}, style: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(event, callback) { listeners.set(event, callback); },
    setAttribute(name, value) { this[name] = String(value); },
    dispatch(event) { return listeners.get(event)?.({ target: this }); }
  };
}

function harness({ store = { preference: null }, cache = new Map(), cacheUnavailable = false,
    darkSystem = true, getResponse, postResponse } = {}) {
  const events = new Map();
  const selector = element(), hint = element(), meta = element();
  const system = {
    matches: darkSystem,
    addEventListener(_, callback) { this.changed = callback; },
    addListener(callback) { this.changed = callback; }
  };
  const document = {
    documentElement: { dataset: {}, style: {} }, readyState: 'loading',
    querySelector(query) { return query === 'meta[name="theme-color"]' ? meta : null; },
    querySelectorAll() { return []; },
    getElementById(id) { return id === 'themePreference' ? selector : id === 'themeHint' ? hint : null; },
    addEventListener(event, callback) { events.set(event, callback); }
  };
  const localStorage = {
    getItem(key) { if (cacheUnavailable) throw new Error('Storage disabled'); return cache.get(key) ?? null; },
    setItem(key, value) { if (cacheUnavailable) throw new Error('Storage disabled'); cache.set(key, String(value)); }
  };
  const requests = [];
  const window = { matchMedia() { return system; } };
  const fetch = async (url, options = {}) => {
    assert.equal(url, '/api/appearance', 'Theme code only accesses local appearance settings');
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, method, body });
    if (method === 'GET') return getResponse ? getResponse() : response({ themePreference: store.preference });
    assert.equal(method, 'POST');
    assert.ok(['dark', 'light', 'system'].includes(body.themePreference));
    if (postResponse) return postResponse(body);
    store.preference = body.themePreference;
    return response({ themePreference: store.preference });
  };
  window.fetch = fetch;
  const context = vm.createContext({ window, document, localStorage, fetch, console,
    requestAnimationFrame(callback) { callback(); }, setTimeout, clearTimeout, URL, Promise });
  vm.runInContext(source, context, { filename: 'theme.js' });
  return { document, selector, hint, system, cache, requests,
    loaded() { document.readyState = 'complete'; return events.get('DOMContentLoaded')?.(); },
    choose(value) { selector.value = value; return selector.dispatch('change'); }
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(setImmediate);
}
function assertAppearance(h, preference, resolved = preference) {
  assert.equal(h.selector.value, preference, 'Selection represents the saved preference');
  assert.equal(h.document.documentElement.dataset.theme, resolved, 'Page applies the effective appearance');
  assert.equal(h.document.documentElement.style.colorScheme, resolved);
}

(async () => {
  const h = harness({ store: { preference: 'light' } });
  h.loaded();
  await settle();
  assert.equal(h.document.documentElement.dataset.theme, 'light',
    'Desktop must recover its saved light preference when browser localStorage is empty');
  assertAppearance(h, 'light');
  console.log('PASS desktop restores preference without browser cache');

  const persisted = { preference: 'dark' };
  const unavailable = harness({ store: persisted, cacheUnavailable: true });
  unavailable.loaded();
  await settle();
  unavailable.choose('light');
  await settle();
  assertAppearance(unavailable, 'light');
  assert.equal(persisted.preference, 'light', 'Disabled browser storage must not discard preference changes');
  const restarted = harness({ store: persisted, cacheUnavailable: true });
  restarted.loaded();
  await settle();
  assertAppearance(restarted, 'light');
  const otherOrigin = harness({ store: persisted, cache: new Map() });
  otherOrigin.loaded();
  await settle();
  assertAppearance(otherOrigin, 'light');
  console.log('PASS unavailable/cleared browser storage and a fresh browser origin retain the tool preference');

  const staleCache = harness({ store: { preference: 'light' }, cache: new Map([[THEME_KEY, 'dark']]) });
  staleCache.loaded();
  await settle();
  assertAppearance(staleCache, 'light');
  assert.equal(staleCache.requests.filter(r => r.method === 'POST').length, 0,
    'A stale browser cache must not overwrite the tool preference');
  console.log('PASS durable preference takes precedence over stale browser cache');

  const systemStore = { preference: 'system' };
  const followSystem = harness({ store: systemStore, darkSystem: false });
  followSystem.loaded();
  await settle();
  assertAppearance(followSystem, 'system', 'light');
  followSystem.system.matches = true;
  followSystem.system.changed();
  assertAppearance(followSystem, 'system', 'dark');
  assert.equal(systemStore.preference, 'system', 'System changes must not replace the follow-system preference');
  assert.equal(followSystem.requests.filter(r => r.method === 'POST').length, 0);
  const nextSystemSession = harness({ store: systemStore, darkSystem: false });
  nextSystemSession.loaded();
  await settle();
  assertAppearance(nextSystemSession, 'system', 'light');
  console.log('PASS follow-system persists as a preference across system changes and reloads');

  const migrationStore = { preference: null };
  const migrated = harness({ store: migrationStore, cache: new Map([[THEME_KEY, 'light']]) });
  migrated.loaded();
  await settle();
  assertAppearance(migrated, 'light');
  assert.equal(migrationStore.preference, 'light');
  assert.equal(migrated.requests.filter(r => r.method === 'POST').length, 1,
    'An existing browser choice migrates once when the tool has no preference');
  const afterMigration = harness({ store: migrationStore });
  afterMigration.loaded();
  await settle();
  assertAppearance(afterMigration, 'light');
  const unreadable = harness({ cache: new Map([[THEME_KEY, 'light']]),
    getResponse: () => response({ error: 'Storage read failed' }, 500) });
  unreadable.loaded();
  await settle();
  assertAppearance(unreadable, 'light');
  assert.equal(unreadable.requests.filter(r => r.method === 'POST').length, 0,
    'Failed hydration must not be treated as an empty tool preference and overwritten');
  console.log('PASS browser preference migration only after a successful empty read');

  const read = deferred(), raceStore = { preference: 'light' };
  const race = harness({ store: raceStore, getResponse: () => read.promise });
  race.loaded();
  race.choose('dark');
  await settle();
  read.resolve(response({ themePreference: 'light' }));
  await settle();
  assertAppearance(race, 'dark');
  assert.equal(raceStore.preference, 'dark', 'A late startup read cannot undo the latest user change');
  console.log('PASS delayed startup read cannot overwrite a new user choice');

  const firstWrite = deferred(), rapidStore = { preference: 'dark' };
  const applied = [];
  let active = 0, peak = 0;
  const rapid = harness({ store: rapidStore, postResponse: async body => {
    active++;
    peak = Math.max(peak, active);
    if (applied.length === 0) await firstWrite.promise;
    applied.push(body.themePreference);
    rapidStore.preference = body.themePreference;
    active--;
    return response({ themePreference: body.themePreference });
  } });
  rapid.loaded();
  await settle();
  rapid.choose('light');
  await settle();
  rapid.choose('system');
  rapid.choose('dark');
  await settle();
  assert.equal(rapid.requests.filter(r => r.method === 'POST').length, 1,
    'Subsequent writes wait while an earlier theme write is still in flight');
  firstWrite.resolve();
  await settle();
  assertAppearance(rapid, 'dark');
  assert.equal(peak, 1, 'Theme writes must be serialized to prevent storage races');
  assert.deepEqual(applied, ['light', 'dark'],
    'Queued obsolete choices may be coalesced, while in-flight and latest choices retain their values');
  assert.equal(rapidStore.preference, 'dark');
  console.log('PASS rapid changes save in order, leaving the latest choice on disk');

  let failure = 'http';
  const failedStore = { preference: 'dark' };
  const failed = harness({ store: failedStore, postResponse: async body => {
    if (failure === 'network') throw new Error('Local server unavailable');
    if (failure === 'http') return response({ error: 'Storage write failed' }, 500);
    failedStore.preference = body.themePreference;
    return response({ themePreference: body.themePreference });
  } });
  failed.loaded();
  await settle();
  failed.choose('light');
  await settle();
  assertAppearance(failed, 'light');
  assert.equal(failedStore.preference, 'dark');
  assert.match(failed.hint.textContent, /未能|失败/, 'A failed save must be visible');
  assert.doesNotMatch(failed.hint.textContent, /已保存|已记住/, 'Failed persistence cannot show false success');
  failure = 'network';
  failed.choose('system');
  await settle();
  assert.match(failed.hint.textContent, /未能|失败/);
  failure = '';
  failed.choose('light');
  await settle();
  assert.equal(failedStore.preference, 'light', 'A failed write must not permanently break later saves');
  assert.doesNotMatch(failed.hint.textContent, /未能|失败/);
  console.log('PASS HTTP/network save failures are visible and later choices can still save');
  console.log('Theme persistence checks passed with mocked local storage only');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
