/* Local appearance preferences; independent of provider settings and credentials. */
(() => {
  'use strict';
  const key = 'gptimage2.theme.v1';
  const allowed = ['dark', 'light', 'system'];
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const native = !!window.NativeBridge;
  let preference = 'dark';
  let cachedPreference = null;
  let revision = 0;
  let saveQueue = Promise.resolve();
  try {
    const saved = localStorage.getItem(key);
    if (allowed.includes(saved)) preference = cachedPreference = saved;
  } catch (_) {}

  function cachePreference() {
    try { localStorage.setItem(key, preference); } catch (_) {}
  }

  function showSaveStatus(text, failed = false) {
    const hint = document.getElementById('themeHint');
    if (!hint) return;
    hint.textContent = text;
    hint.className = failed ? 'hint is-error' : 'hint';
  }

  function persistPreference(value, changeRevision) {
    showSaveStatus('正在保存显示模式…');
    // Serialize rapid selections so an older write cannot finish after the last choice.
    saveQueue = saveQueue.then(async () => {
      if (changeRevision !== revision) return;
      try {
        const response = await window.fetch('/api/appearance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ themePreference: value }), keepalive: true
        });
        if (!response.ok) throw new Error('Appearance save failed');
        const result = await response.json();
        if (result.themePreference !== value) throw new Error('Appearance was not saved');
        if (changeRevision === revision) showSaveStatus('已保存到工具本地，重新打开后仍保留。');
      } catch (_) {
        if (changeRevision === revision) showSaveStatus('显示已切换，但未能保存到工具。请确认服务已更新并启动，再重新选择。', true);
      }
    });
    return saveQueue;
  }

  async function restorePreference(selector) {
    const loadRevision = revision;
    try {
      const response = await window.fetch('/api/appearance', { cache: 'no-store' });
      if (!response.ok) throw new Error('Appearance read failed');
      const saved = await response.json();
      // The user may have already selected a theme while this request was in flight.
      if (revision !== loadRevision) return;
      if (allowed.includes(saved.themePreference)) {
        preference = saved.themePreference;
        cachePreference();
        if (selector) selector.value = preference;
        applyTheme();
        showSaveStatus('已保存到工具本地，重新打开后仍保留。');
      } else if (saved.themePreference === null && cachedPreference !== null) {
        await persistPreference(preference, revision); // Migrate the existing browser choice once.
      } else {
        showSaveStatus('立即应用，并保存到工具本地；重新打开仍保留。');
      }
    } catch (_) {
      if (revision === loadRevision) showSaveStatus('暂时无法读取工具保存的主题，正在使用浏览器记录。请确认服务已启动。', true);
    }
  }

  function applyTheme() {
    const resolved = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === 'light' ? '#f7f8fa' : '#191919';
    if (window.NativeBridge && typeof window.NativeBridge.setTheme === 'function') {
      window.NativeBridge.setTheme(resolved);
    }
  }
  applyTheme();
  const systemChanged = () => { if (preference === 'system') applyTheme(); };
  if (system.addEventListener) system.addEventListener('change', systemChanged);
  else system.addListener(systemChanged);

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(); // Also synchronize native system bars after the page is ready.
    const selector = document.getElementById('themePreference');
    if (selector) {
      selector.value = preference;
      selector.addEventListener('change', () => {
        if (!allowed.includes(selector.value)) return;
        preference = selector.value;
        revision++;
        cachePreference();
        applyTheme();
        if (!native) persistPreference(preference, revision);
      });
    }
    if (!native) restorePreference(selector);
    // Expanding at the bottom of the settings scroller otherwise leaves all
    // fields below the visible area, behind the fixed save footer.
    document.querySelectorAll('#settingsModal .adv').forEach(details => {
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        requestAnimationFrame(() => {
          const scroller = details.closest('.modal-content');
          const heading = details.querySelector('summary');
          if (!scroller || !heading) return;
          scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
        });
      });
    });
  });
})();
