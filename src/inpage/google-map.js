// Runs in the google.com/maps page (MAIN world). Google's web map exposes no map object,
// so routes and pins are drawn on a layer placed over the map canvas and positioned from
// the view in the URL (@lat,lng,zoom z, Web Mercator, URL centre = canvas centre).
// While the map is dragged the layer follows the pointer; after zooming it is redrawn as
// soon as Google updates the URL. The map cannot be moved silently: an explicit "show on
// map" reloads the page at the new view (the panel restores itself from storage).
import mapLayerCss from './maplayer.css';

const R2D = 180 / Math.PI;
const worldPx = (z) => 256 * 2 ** z;
const project = (lat, lng, z) => {
  const s = Math.sin(lat / R2D);
  const w = worldPx(z);
  return [((lng + 180) / 360) * w, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w];
};
const unproject = (x, y, z) => {
  const w = worldPx(z);
  return { lat: R2D * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / w)), lng: (x / w) * 360 - 180 };
};

export function readView(href = location.href) {
  const m = String(href).match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/);
  return m ? { lat: +m[1], lng: +m[2], z: +m[3] } : null;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const DASH = { alt: '6 7', dot: '0.1 9' };

export class GoogleMap {
  constructor() {
    this.lines = [];
    this.pins = [];
    this.picking = null;
    this.offset = [0, 0];
    this.themeCbs = [];
    this.m = null; // no map object on Google

    this.host = document.createElement('div');
    this.host.id = 'nr-map-layer';
    Object.assign(this.host.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '1', overflow: 'hidden' });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${mapLayerCss}
      svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
      .moving { will-change: transform; }</style>
      <div class="layer"><svg></svg><div class="pins"></div></div><div class="toast" hidden></div>`;
    this.layer = this.root.querySelector('.layer');
    this.svg = this.root.querySelector('svg');
    this.pinBox = this.root.querySelector('.pins');

    const dark = matchMedia('(prefers-color-scheme: dark)');
    dark.addEventListener?.('change', () => this.themeCbs.forEach((f) => f(this.isDark())));
  }

  // Wait for Google's map canvas, then attach the layer next to it (so Google's own panels
  // stay above our lines).
  async ready(timeoutMs = 45000) {
    const t0 = Date.now();
    while (!this.canvas()) {
      if (Date.now() - t0 > timeoutMs) throw new Error('نقشهٔ گوگل پیدا نشد');
      await new Promise((r) => setTimeout(r, 300));
    }
    this.attach();
    this.view = readView();
    this.watch();
    this.render();
    return this;
  }

  canvas() {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = c; }
    }
    return area > 200 * 200 ? best : null;
  }

  attach() {
    const c = this.canvas();
    const parent = c?.parentElement;
    if (parent && this.host.parentElement !== parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      this.host.style.position = 'absolute';
      parent.appendChild(this.host);
    } else if (!c && !this.host.isConnected) document.body.appendChild(this.host);
  }

  rect() { return (this.host.parentElement || document.body).getBoundingClientRect(); }

  watch() {
    // URL changes (end of a drag/zoom) -> redraw; the canvas may be re-created -> re-attach
    setInterval(() => {
      if (!this.host.isConnected || this.host.parentElement !== this.canvas()?.parentElement) this.attach();
      const v = readView();
      const changed = v && (!this.view || v.lat !== this.view.lat || v.lng !== this.view.lng || v.z !== this.view.z);
      if (changed) { this.view = v; this.render(); }
    }, 120);
    addEventListener('resize', () => this.render());

    // follow drags 1:1 until Google reports the new view. Google puts a transparent
    // gesture layer over its canvas, so "on the map" means: over the canvas area and not
    // on one of Google's panels, buttons or links (nor on our own panel).
    const UI = 'button, a, input, textarea, select, [role="button"], [role="main"], [role="dialog"], [role="navigation"], [role="menu"], [role="listbox"], #neshan-routes-ext';
    const onMap = (e) => {
      const c = this.canvas();
      if (!c || !(e.target instanceof Element) || e.target.closest(UI)) return false;
      const r = c.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    let drag = null;
    addEventListener('pointerdown', (e) => {
      if (this.picking || e.button !== 0 || !onMap(e)) return;
      drag = { x: e.clientX, y: e.clientY };
    }, true);
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.setOffset(e.clientX - drag.x, e.clientY - drag.y);
    }, true);
    const end = () => {
      if (!drag) return;
      drag = null;
      clearTimeout(this.settle);
      // Google reports the new view in the URL only seconds later; until then the drag
      // offset keeps the layer in place (a drag moves the map exactly with the pointer)
      this.settle = setTimeout(() => this.render(), 15000);
    };
    addEventListener('pointerup', end, true);
    addEventListener('pointercancel', end, true);
    // zooming animates first and reports the view after: hide until then
    const hideTillNextView = () => {
      this.layer.style.opacity = '0';
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.render(), 15000);
    };
    addEventListener('wheel', (e) => { if (onMap(e)) hideTillNextView(); }, { capture: true, passive: true });
    addEventListener('dblclick', (e) => { if (onMap(e)) hideTillNextView(); }, true);
    addEventListener('click', (e) => {
      const b = e.target.closest?.('button');
      if (b && /zoom|بزرگ|کوچک/i.test(b.getAttribute('aria-label') || '')) hideTillNextView();
    }, true);

    // picking a point: the click must not reach Google (it would open a place card)
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
      addEventListener(type, (e) => {
        if (!this.picking || !onMap(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === 'click') {
          const p = this.unprojectClient(e.clientX, e.clientY);
          const cb = this.picking;
          this.stopPick();
          if (p) cb(p);
        }
      }, true);
    }
  }

  setOffset(dx, dy) {
    this.offset = [dx, dy];
    this.layer.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  toScreen(lat, lng) {
    const v = this.view;
    if (!v) return null;
    const r = this.rect();
    const [cx, cy] = project(v.lat, v.lng, v.z);
    const [x, y] = project(lat, lng, v.z);
    return [x - cx + r.width / 2, y - cy + r.height / 2];
  }

  unprojectClient(clientX, clientY) {
    const v = this.view;
    if (!v) return null;
    const r = this.rect();
    const [cx, cy] = project(v.lat, v.lng, v.z);
    return unproject(cx + (clientX - r.left - r.width / 2), cy + (clientY - r.top - r.height / 2), v.z);
  }

  render() {
    clearTimeout(this.settle);
    this.setOffset(0, 0);
    // satellite/3D views put metres instead of a zoom in the URL: we cannot place lines then
    const ok = !!this.view;
    this.layer.style.opacity = ok ? '1' : '0';
    if (!ok) return;
    this.renderLines();
    this.placePins();
  }

  renderLines() {
    const casing = this.isDark() ? '#0b0e14' : '#ffffff';
    const parts = [];
    for (const ln of this.lines) {
      if (!ln.coords?.length) continue;
      const pts = [];
      for (const [lat, lng] of ln.coords) {
        const p = this.toScreen(lat, lng);
        pts.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      const d = `M${pts.join('L')}`;
      const w = ln.width || 5;
      const op = ln.opacity ?? 1;
      const dash = DASH[ln.dash] ? ` stroke-dasharray="${DASH[ln.dash]}"` : '';
      if (ln.casing !== false && ln.dash !== 'alt') {
        parts.push(`<path d="${d}" fill="none" stroke="${casing}" stroke-width="${w + 4}" stroke-linecap="round" stroke-linejoin="round" opacity="${0.9 * op}"/>`);
      }
      parts.push(`<path d="${d}" fill="none" stroke="${ln.color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"${dash}/>`);
    }
    this.svg.innerHTML = parts.join('');
  }

  setLines(lines) {
    this.lines = lines;
    this.renderLines();
  }

  setPins(pins) {
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
    this.placePins();
  }

  placePins() {
    for (const p of this.pins) {
      if (p.dragging) continue;
      const s = this.toScreen(p.lat, p.lng);
      if (s) p.el.style.transform = `translate(${s[0]}px, ${s[1]}px)`;
    }
  }

  bindPin(p) {
    const el = p.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const r = this.rect();
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!p.draggable) return;
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        p.dragging = true;
        el.classList.add('dragging');
        el.style.transform = `translate(${ev.clientX - r.left - this.offset[0]}px, ${ev.clientY - r.top - this.offset[1]}px)`;
      };
      const up = (ev) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        p.dragging = false;
        el.classList.remove('dragging');
        if (moved) {
          const ll = this.unprojectClient(ev.clientX, ev.clientY);
          if (ll) { p.lat = ll.lat; p.lng = ll.lng; }
          this.placePins();
          if (ll) p.onDragEnd?.(ll.lat, ll.lng);
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
    const c = this.canvas();
    if (c) c.style.cursor = 'crosshair';
  }
  stopPick() {
    this.picking = null;
    const c = this.canvas();
    if (c) c.style.cursor = '';
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

  isDark() { return matchMedia('(prefers-color-scheme: dark)').matches; }
  onThemeChange(cb) { this.themeCbs.push(cb); }

  getCenter() { const v = this.view || readView(); return v ? { lat: v.lat, lng: v.lng } : { lat: 35.7, lng: 51.4 }; }
  getZoom() { return (this.view || readView())?.z ?? 12; }

  // Google's map can only be moved by loading a new view; only explicit requests do that.
  goTo(lat, lng, z) {
    const at = `@${lat.toFixed(7)},${lng.toFixed(7)},${Math.max(3, Math.min(21, z)).toFixed(2)}z`;
    const u = new URL(location.href);
    const path = /@-?[\d.]+,-?[\d.]+,[\d.]+[zm]/.test(u.pathname)
      ? u.pathname.replace(/@-?[\d.]+,-?[\d.]+,[\d.]+[zm]/, at)
      : `/maps/${at}`;
    location.assign(`${u.origin}${path}${u.search}`);
  }
  flyTo(lat, lng, zoom, opts = {}) {
    if (opts.explicit) this.goTo(lat, lng, zoom ?? Math.max(this.getZoom(), 15));
  }
  fitPoints(points, padding, opts = {}) {
    if (!opts.explicit || !points.length) return;
    const r = this.rect();
    let s = 90, w = 180, n = -90, e = -180;
    for (const [lat, lng] of points) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng); }
    const availW = Math.max(100, r.width - (padding?.left || 0) - (padding?.right || 0));
    const availH = Math.max(100, r.height - (padding?.top || 0) - (padding?.bottom || 0));
    const [x1, y1] = project(n, w, 0);
    const [x2, y2] = project(s, e, 0);
    const z = Math.min(16, Math.log2(Math.min(availW / Math.max(1e-9, x2 - x1), availH / Math.max(1e-9, y2 - y1))));
    // centre the box in the free area (not under the panel)
    const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const shift = ((padding?.left || 0) - (padding?.right || 0)) / 2 / worldPx(z) * worldPx(0);
    const shiftY = ((padding?.top || 0) - (padding?.bottom || 0)) / 2 / worldPx(z) * worldPx(0);
    const c = unproject(cx - shift, cy - shiftY, 0);
    this.goTo(c.lat, c.lng, z);
  }
}
