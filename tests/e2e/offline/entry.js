// Offline UI test page: the real panel (src/inpage/ui.js) on a stand-in for Neshan's map,
// talking to the fake Neshan API. Nothing here reaches neshan.org.
import { install } from '../fake_neshan.js';
import { setPacing } from '../../../src/lib/neshan.js';
import { mountUI } from '../../../src/inpage/ui.js';

// stand-in for content/bridge.js (extension storage), kept in memory
const mem = {};
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d?.__nr !== 'req') return;
  let result = null;
  if (d.op === 'get') result = mem[d.key] ?? null;
  else if (d.op === 'set') mem[d.key] = d.value;
  else if (d.op === 'remove') delete mem[d.key];
  window.postMessage({ __nr: 'res', id: d.id, result }, '*');
});

install();
const params = new URLSearchParams(location.search);
if (params.has('ratelimit')) {
  // a limiter allowing 5 routing requests per 5 s, with the extension's real pacing
  globalThis.__fakeRateLimit = { max: 5, windowMs: 5000 };
  setPacing({ gap: 900 });
}

// stand-in for NeshanMap (src/inpage/neshan-map.js): records what would be drawn
const root = document.getElementById('map').attachShadow({ mode: 'open' });
root.innerHTML = '<div class="toast" hidden></div>';
const themeCbs = [];
let dark = false;
const nm = {
  root, lines: [], pins: [],
  m: { getLayer: () => true },
  isDark: () => dark,
  onThemeChange: (cb) => themeCbs.push(cb),
  setLines(l) { this.lines = l; },
  setPins(p) { this.pins = p; },
  toast(t) { const el = root.querySelector('.toast'); el.textContent = t; el.hidden = false; },
  hideToast() { root.querySelector('.toast').hidden = true; },
  startPick() {}, stopPick() {},
  getCenter: () => ({ lat: 35.7, lng: 51.4 }),
  flyTo() {}, fitPoints() {},
};
window.__setDark = (d) => { dark = d; themeCbs.forEach((f) => f(d)); };
mountUI(nm);
