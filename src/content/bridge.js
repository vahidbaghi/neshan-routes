// Isolated-world helper on neshan.org: the in-page panel (MAIN world) cannot use
// extension APIs, so it asks this script over window.postMessage to read/write
// extension storage. Only our own keys are reachable.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const KEYS = new Set(['state', 'openPanel']);

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__nr !== 'req') return;
    const { id, op, key, value } = e.data;
    if (!KEYS.has(key)) return;
    let result = null;
    try {
      if (op === 'get') result = (await api.storage.local.get(key))[key] ?? null;
      else if (op === 'set') await api.storage.local.set({ [key]: value });
      else if (op === 'remove') await api.storage.local.remove(key);
    } catch (err) {
      console.warn('neshan-routes storage:', err); // e.g. extension reloaded while the tab stayed open
    }
    window.postMessage({ __nr: 'res', id, result }, location.origin);
  });

  // Toolbar button pressed while this tab is active.
  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle-panel') window.postMessage({ __nr: 'toggle' }, location.origin);
  });
})();
