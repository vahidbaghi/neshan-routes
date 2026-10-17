// Runs in the neshan.org page (MAIN world): finds neshan.org's own mapbox-gl map and
// draws our routes and markers on it.
//
// How the map is found (checked against the 2026-10 neshan.org bundle):
//  1. Get webpack's require by pushing a no-op chunk onto self.__LOADABLE_LOADED_CHUNKS__
//     (webpack runs a pushed chunk's runtime callback with its require function).
//  2. Module 60440 keeps the map instance in its `NI` export.
//  3. Fallback if Neshan rebuilds and that id moves: find the mapbox-gl module and patch
//     Map.prototype._render to catch the instance on its next frame.

import mapLayerCss from './maplayer.css';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMap = (m) => m && typeof m.addLayer === 'function' && typeof m.project === 'function' && typeof m.getContainer === 'function';

async function webpackRequire(timeoutMs) {
  const t0 = Date.now();
  while (!Array.isArray(self.__LOADABLE_LOADED_CHUNKS__)) {
    if (Date.now() - t0 > timeoutMs) throw new Error('webpack runtime not found');
    await sleep(200);
  }
  return new Promise((res) => self.__LOADABLE_LOADED_CHUNKS__.push([[`nr-${Math.random()}`], {}, (r) => res(r)]));
}

function captureViaPrototype(req) {
  return new Promise((resolve) => {
    for (const id of Object.keys(req.m || {})) {
      let src;
      try { src = Function.prototype.toString.call(req.m[id]); } catch { continue; }
      if (!src.includes('getRTLTextPluginStatus')) continue;
      let mod;
      try { mod = req(id); } catch { continue; }
      const Map = mod?.Map || mod?.default?.Map;
      if (!Map?.prototype?._render) continue;
      const orig = Map.prototype._render;
      Map.prototype._render = function (...a) {
        Map.prototype._render = orig;
        resolve(this);
        return orig.apply(this, a);
      };
      window.dispatchEvent(new Event('resize')); // nudge a frame
      return;
    }
  });
}

export async function findNeshanMap(timeoutMs = 45000) {
  const req = await webpackRequire(timeoutMs);
  const t0 = Date.now();
  let fallback = null;
  while (Date.now() - t0 < timeoutMs) {
    let m = null;
    try { m = req(60440)?.NI; } catch { /* module id changed */ }
    if (isMap(m)) return m;
    if (!fallback && Date.now() - t0 > 4000) fallback = captureViaPrototype(req);
    if (fallback) {
      const got = await Promise.race([fallback, sleep(300).then(() => null)]);
      if (isMap(got)) return got;
    } else await sleep(300);
  }
  throw new Error('نقشهٔ نشان پیدا نشد');
}

const SRC = 'nr-lines';
const LAYERS = [
  { id: 'nr-casing', kind: 'casing' },
  { id: 'nr-alt', kind: 'alt', dash: [1.6, 1.6] },
  { id: 'nr-solid', kind: 'solid' },
  { id: 'nr-dot', kind: 'dot', dash: [0.1, 1.9] },
];

export class NeshanMap {
  constructor(m) {
    this.m = m;
    this.lines = [];
    this.pins = [];
    this.picking = null;
    this.themeCbs = [];
    this.lastDark = this.isDark();

    // Overlay for pins and the toast, inside the map container, in its own shadow root.
    const c = m.getContainer();
    this.host = document.createElement('div');
    this.host.id = 'nr-map-layer';
    Object.assign(this.host.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3', overflow: 'hidden' });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${mapLayerCss}</style><div class="pins"></div><div class="toast" hidden></div>`;
    c.appendChild(this.host);
    this.pinBox = this.root.querySelector('.pins');

    const pageStyle = document.createElement('style');
    pageStyle.textContent = '.nr-picking .mapboxgl-canvas-container, .nr-picking canvas { cursor: crosshair !important; }';
    document.head.appendChild(pageStyle);

    const place = () => this.placePins();
    m.on('move', place);
    m.on('resize', place);
    m.on('styledata', () => {
      this.ensureLayers();
      const d = this.isDark();
      if (d !== this.lastDark) { this.lastDark = d; this.themeCbs.forEach((f) => f(d)); }
    });
    this.ensureLayers();

    // Picking: swallow the click before mapbox (and Neshan's own click handlers) see it,
    // but let drags through so the map can still be panned.
    let down = null;
    c.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
    c.addEventListener('click', (e) => {
      if (!this.picking || this.host.contains(e.target)) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      e.stopPropagation();
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const ll = m.unproject([e.clientX - r.left, e.clientY - r.top]);
      const cb = this.picking;
      this.stopPick();
      cb({ lat: ll.lat, lng: ll.lng });
    }, true);
  }

  isDark() {
    try { return /dark/i.test(this.m.getStyle()?.name || ''); } catch { return false; }
  }
  onThemeChange(cb) { this.themeCbs.push(cb); }

  ensureLayers() {
    const m = this.m;
    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type: 'geojson', data: this.geojson() });
      for (const l of LAYERS) {
        if (m.getLayer(l.id)) continue;
        m.addLayer({
          id: l.id,
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'kind'], l.kind],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['get', 'width'],
            'line-opacity': ['get', 'opacity'],
            ...(l.dash ? { 'line-dasharray': l.dash } : {}),
          },
        });
      }
    } catch { /* style still loading; styledata will call again */ }
  }

  geojson() {
    const features = [];
    const casing = this.isDark() ? '#0b0e14' : '#ffffff';
    for (const ln of this.lines) {
      if (!ln.coords?.length) continue;
      const geometry = { type: 'LineString', coordinates: ln.coords.map(([lat, lng]) => [lng, lat]) };
      const kind = ln.dash || 'solid';
      if (ln.casing !== false && kind !== 'alt') {
        features.push({ type: 'Feature', geometry, properties: { kind: 'casing', color: casing, width: (ln.width || 5) + 4, opacity: 0.9 * (ln.opacity ?? 1) } });
      }
      features.push({ type: 'Feature', geometry, properties: { kind, color: ln.color, width: ln.width || 5, opacity: ln.opacity ?? 1 } });
    }
    return { type: 'FeatureCollection', features };
  }

  setLines(lines) {
    this.lines = lines;
    this.ensureLayers();
    this.m.getSource(SRC)?.setData(this.geojson());
  }

  // pins: [{key, lat, lng, html, cls, title, draggable, onDragEnd(lat,lng), onClick(), z}]
  setPins(pins) {
    const old = new Map(this.pins.map((p) => [p.key, p]));
    this.pinBox.textContent = '';
    this.pins = pins.map((p) => {
      const el = document.createElement('div');
      el.className = `pin-wrap ${p.cls || ''}`;
      el.innerHTML = p.html;
      if (p.title) el.title = p.title;
      el.style.zIndex = String(p.z || 1);
      const pin = { ...p, el };
      this.bindPin(pin);
      this.pinBox.appendChild(el);
      return pin;
    });
    old.clear();
    this.placePins();
  }

  placePins() {
    for (const p of this.pins) {
      if (p.dragging) continue;
      const pt = this.m.project([p.lng, p.lat]);
      p.el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    }
  }

  bindPin(p) {
    const el = p.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const c = this.m.getContainer().getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;
      el.setPointerCapture(e.pointerId);
      if (p.draggable) this.m.dragPan.disable();
      const move = (ev) => {
        if (!p.draggable) return;
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        p.dragging = true;
        el.classList.add('dragging');
        el.style.transform = `translate(${ev.clientX - c.left}px, ${ev.clientY - c.top}px)`;
      };
      const up = (ev) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (p.draggable) this.m.dragPan.enable();
        p.dragging = false;
        el.classList.remove('dragging');
        if (moved) {
          const ll = this.m.unproject([ev.clientX - c.left, ev.clientY - c.top]);
          p.lat = ll.lat; p.lng = ll.lng;
          this.placePins();
          p.onDragEnd?.(ll.lat, ll.lng);
        } else {
          this.placePins();
          p.onClick?.();
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  startPick(cb) {
    this.picking = cb;
    this.m.getContainer().classList.add('nr-picking');
  }
  stopPick() {
    this.picking = null;
    this.m.getContainer().classList.remove('nr-picking');
  }

  toast(msg, { error = false, ms = 3500 } = {}) {
    const t = this.root.querySelector('.toast');
    t.textContent = msg;
    t.classList.toggle('error', error);
    t.classList.toggle('dark', this.isDark());
    t.hidden = false;
    clearTimeout(this.toastTimer);
    if (ms) this.toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  hideToast() { this.root.querySelector('.toast').hidden = true; }

  getCenter() { const c = this.m.getCenter(); return { lat: c.lat, lng: c.lng }; }
  getZoom() { return this.m.getZoom(); }
  flyTo(lat, lng, zoom) { this.m.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(this.m.getZoom(), 15) }); }
  fitPoints(points, padding) {
    if (!points.length) return;
    if (points.length === 1) { this.flyTo(points[0][0], points[0][1], 15); return; }
    let s = 90, w = 180, n = -90, e = -180;
    for (const [lat, lng] of points) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng); }
    this.m.fitBounds([[w, s], [e, n]], { padding, maxZoom: 16, duration: 600 });
  }
}
