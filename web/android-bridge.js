/* Android uses the same interface with a local native API. Desktop keeps fetch. */
(() => {
  'use strict';
  if (!window.NativeBridge || typeof window.NativeBridge.postMessage !== 'function') return;
  const browserFetch = window.fetch.bind(window);
  const pending = new Map();
  // A WebView reload must not reuse IDs while an older request is still running.
  const session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let sequence = 0;

  window.__nativeResponse = (id, status, body, contentType = 'application/json') => {
    const request = pending.get(String(id));
    if (!request) return;
    pending.delete(String(id));
    clearTimeout(request.timer);
    request.cleanup();
    request.resolve(new Response(status === 204 ? null : body, {
      status,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' }
    }));
  };

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return browserFetch(input, init);
    const signal = init.signal || (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const method = init.method || (input instanceof Request ? input.method : 'GET');
    const body = init.body ?? (input instanceof Request && method !== 'GET' ? await input.clone().text() : '');
    const id = session + '-' + (++sequence);
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        const request = pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(id);
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        cleanup();
        reject(new Error('本地服务响应超时，请检查生成记录。'));
      }, 3660000);
      pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        window.NativeBridge.postMessage(JSON.stringify({ id, path: url.pathname + url.search, method, body: String(body || '') }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  };
  document.documentElement.dataset.platform = 'android';
})();
