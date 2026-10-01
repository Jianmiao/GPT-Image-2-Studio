/* Local appearance preferences; independent of provider settings and credentials. */
(() => {
  'use strict';
  const key = 'gptimage2.theme.v1';
  const allowed = ['dark', 'light', 'system'];
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'dark';
  try {
    const saved = localStorage.getItem(key);
    if (allowed.includes(saved)) preference = saved;
  } catch (_) {}

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
        try { localStorage.setItem(key, preference); } catch (_) {}
        applyTheme();
      });
    }
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
