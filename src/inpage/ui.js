// The panel shown on neshan.org/maps: several named routes on Neshan's own map,
// comparison, and the meeting-point search. Runs in the page (MAIN world).
import {
  MODES, parseLatLng, requestCount,
  transitLineLabel,
  onPacing, routeGap, setRouteGap,
} from '../lib/neshan.js';
import { findMeetingPoint, evaluateMeetingPoint } from '../lib/meet.js';
import { sharedLength, haversine } from '../lib/geo.js';
import { store, onToggle } from './store.js';
import panelCss from './panel.css';

const COLORS = ['#e53935', '#1e88e5', '#43a047', '#8e24aa', '#fb8c00', '#00897b', '#d81b60', '#6d4c41'];
// Routing-request budgets for the meeting search (n = number of people). Measured on
// synthetic cities against brute force: 'normal' stays within ~30 s of the best point.
// The total is capped so that selecting many people does not mean hundreds of requests.
const PRECISION = {
  fast: (n) => Math.min(60, 12 * n + 12),
  normal: (n) => Math.min(100, 24 * n + 16),
  precise: (n) => Math.min(160, 36 * n + 24),
};
const GAP_MEMORY_MS = 6 * 60 * 60 * 1000; // how long a learnt (slower) request pace is kept
const ROUTE_REUSE_MS = 30 * 60 * 1000;
const AVOID_LABELS = { trafficZone: 'طرح ترافیک', oddEven: 'زوج و فرد', toll: 'عوارضی' };
const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="14" fill="#1976d2"/>
  <path d="M10 15 21 19 32 31 45 41 54 54" stroke="#ff6b6b" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <path d="M9 50 20 41 32 31 41 20 55 12" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <path d="M31 56 30 44 32 31 47 29 56 31" stroke="#7ee081" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <circle cx="32" cy="31" r="9" fill="#fde047" stroke="#1976d2" stroke-width="2"/><circle cx="32" cy="31" r="3.2" fill="#111827"/></svg>`;

// ---------------------------------------------------------------- formatting

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v) => String(v).replace(/\d/g, (d) => FA_DIGITS[d]).replace(/\./g, '٫');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return 'کمتر از ۱ دقیقه';
  const m = Math.round(s / 60);
  if (m < 60) return `${fa(m)} دقیقه`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${fa(h)} ساعت${r ? ` و ${fa(r)} دقیقه` : ''}`;
}
// Neshan gives no times for public transport; ours are estimates, said so with «حدود».
const durText = (r) => (r?.transit && r.transit.estimated !== false ? `حدود ${fmtDur(r.duration)}` : fmtDur(r.duration));
const fmtToman = (n) => `${fa(Math.round(n).toLocaleString('en-US').replace(/,/g, '٬'))} تومان`;
const fmtExtra = (sec) => (sec < 45 ? 'بدون وقت اضافه' : `+${fmtDur(Math.max(60, sec))}`);
function fmtDist(m) {
  if (m < 1000) return `${fa(Math.max(10, Math.round(m / 10) * 10))} متر`;
  return `${fa((m / 1000).toFixed(m < 10000 ? 1 : 0))} کیلومتر`;
}
const fmtCoord = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m ? +m[1] * 60 + +m[2] : null;
}
function fmtClock(minOfDay) {
  const t = ((Math.round(minOfDay) % 1440) + 1440) % 1440;
  return fa(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
}

const PANEL_HTML = `
  <button class="launcher" id="launcher" title="مسیرها و محل قرار">${LOGO}<span>مسیرها و قرار</span><span class="count" id="launcherCount" hidden></span></button>
  <aside class="panel" id="panel" hidden>
    <header class="panel-head">
      ${LOGO}
      <h1>مسیرها و محل قرار</h1>
      <div class="menu-wrap">
        <button class="icon-btn" id="moreBtn" title="بیشتر" aria-label="بیشتر" aria-haspopup="menu">⋯</button>
        <div class="menu" id="moreMenu" role="menu" hidden>
          <button role="menuitem" data-act="fit">نمایش همهٔ مسیرها روی نقشه</button>
          <button role="menuitem" data-act="export">ذخیره در فایل…</button>
          <button role="menuitem" data-act="import">بازکردن فایل…</button>
          <button role="menuitem" data-act="clear">پاک کردن همه</button>
        </div>
      </div>
      <button class="icon-btn" id="closeBtn" title="بستن پنل" aria-label="بستن پنل">✕</button>
    </header>
    <div class="from-neshan" id="fromNeshan" hidden>
      <span></span>
      <button class="btn small primary" id="fromNeshanBtn">+ افزودن</button>
    </div>
    <nav class="tabs" role="tablist">
      <button role="tab" class="tab active" data-tab="trips" aria-selected="true">مسیرها <span class="badge" id="tripCount" hidden>۰</span></button>
      <button role="tab" class="tab" data-tab="compare" aria-selected="false">مقایسه</button>
      <button role="tab" class="tab" data-tab="meet" aria-selected="false">محل قرار</button>
    </nav>
    <section class="tab-body" id="tab-trips" role="tabpanel">
      <div id="tripList" class="trip-list"></div>
      <div class="add-row">
        <button class="btn primary" id="addTripBtn">+ مسیر تازه</button>
        <form class="link-form" id="linkForm">
          <input type="text" id="linkInput" placeholder="یا لینک یک مسیر نشان را اینجا بچسبانید" dir="auto" autocomplete="off">
          <button class="btn ghost" type="submit">افزودن</button>
        </form>
      </div>
    </section>
    <section class="tab-body" id="tab-compare" role="tabpanel" hidden><div id="compareBody"></div></section>
    <section class="tab-body" id="tab-meet" role="tabpanel" hidden>
      <div class="card meet-card">
        <p class="lead">جایی را پیدا می‌کنیم که همه سر راهشان به آن برسند و کمترین وقت اضافه را بدهند.</p>
        <div class="chips" id="meetPeople" aria-label="چه کسانی قرار می‌گذارند"></div>
        <p class="hint" id="meetHint" hidden></p>
        <div class="row">
          <button class="btn primary big grow" id="meetBtn">پیدا کردن محل قرار</button>
          <button class="btn" id="meetCancel" hidden>لغو</button>
        </div>
        <p class="hint" id="meetEstimate" hidden></p>
        <div class="progress" id="meetProgress" hidden><div class="bar"></div><span class="ptext"></span></div>
        <details class="more" id="meetSettings">
          <summary>تنظیمات <span class="sum" id="meetSummary"></span></summary>
          <div class="more-body">
            <div class="field-label">بهترین یعنی</div>
            <div class="seg" role="radiogroup">
              <label><input type="radio" name="objective" value="sum" checked><span>کمترین وقت کل</span></label>
              <label><input type="radio" name="objective" value="max"><span>عادلانه</span></label>
            </div>
            <p class="hint" id="objectiveHint"></p>
            <label class="check"><input type="checkbox" id="includeWait" checked> <span>معطل شدن برای بقیه هم وقت اضافه حساب شود</span></label>
            <div class="field-label">دقت جستجو</div>
            <div class="seg" role="radiogroup">
              <label><input type="radio" name="precision" value="fast"><span>سریع</span></label>
              <label><input type="radio" name="precision" value="normal" checked><span>معمولی</span></label>
              <label><input type="radio" name="precision" value="precise"><span>دقیق</span></label>
            </div>
            <p class="hint">دقیق‌تر یعنی مسیریابی بیشتر و کمی صبر بیشتر.</p>
          </div>
        </details>
      </div>
      <div id="meetResult"></div>
    </section>
  </aside>
  <input type="file" id="importFile" accept="application/json,.json" hidden>`;

// nm: the map adapter (NeshanMap or GoogleMap); P: the site (providers.js)
export function mountUI(nm, P) {
  const STORAGE_KEY = P.storageKey;
  const hasAvoid = (mode) => P.avoid && (mode === 'CAR' || mode === 'MOTOR');
  // ---------------------------------------------------------------- shell
  const host = document.createElement('div');
  host.id = 'neshan-routes-ext';
  const R = host.attachShadow({ mode: 'open' });
  R.innerHTML = `<style>${panelCss}</style>${PANEL_HTML}`;
  document.body.appendChild(host);
  // Keep typing in our inputs away from neshan.org's own keyboard shortcuts.
  for (const ev of ['keydown', 'keyup', 'keypress']) {
    host.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === 'keydown' && e.key === 'Escape' && picking) endPick();
    });
  }

  const $ = (sel, root = R) => root.querySelector(sel);
  const $$ = (sel, root = R) => [...root.querySelectorAll(sel)];
  const toast = (msg, opts) => nm.toast(msg, opts);
  const hideToast = () => nm.hideToast();

  const applyTheme = () => host.classList.toggle('dark', nm.isDark());
  applyTheme();
  nm.onThemeChange(() => { applyTheme(); redraw(); });

  // ---------------------------------------------------------------- state
  const state = {
    trips: [],
    settings: { objective: 'sum', includeWait: true, precision: 'normal', panelOpen: true },
    meeting: null,
  };
  const rt = new Map(); // per-trip runtime: {status, alts, error, seq}
  const runtime = (id) => { if (!rt.has(id)) rt.set(id, { status: 'idle', alts: null, error: '', seq: 0 }); return rt.get(id); };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const tripById = (id) => state.trips.find((t) => t.id === id);
  const tripIndex = (id) => state.trips.findIndex((t) => t.id === id);

  function newTrip(partial = {}) {
    const used = new Set(state.trips.map((t) => t.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[state.trips.length % COLORS.length];
    return {
      id: uid(), name: `مسیر ${fa(state.trips.length + 1)}`, color, mode: 'CAR', origin: null, dest: null,
      depart: '', inMeeting: true, hidden: false, avoid: { trafficZone: false, oddEven: false, toll: false }, alt: 0,
      ...partial,
    };
  }

  let saveTimer;
  const snapshot = () => ({ trips: state.trips, settings: state.settings, meeting: state.meeting });
  // save(true) writes right away and resolves when stored (before a page reload)
  function save(now = false) {
    clearTimeout(saveTimer);
    if (now) return store.set(STORAGE_KEY, snapshot());
    saveTimer = setTimeout(() => store.set(STORAGE_KEY, snapshot()), 250);
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- drawing on Neshan's map
  let activeTab = 'trips';
  const meetingOnMap = () => activeTab === 'meet' && state.meeting && !state.meeting.stale;

  function redraw() {
    const lines = [];
    const pins = [];
    const inMeeting = meetingOnMap() ? new Set(state.meeting.participants) : null;
    state.trips.forEach((t, idx) => {
      if (t.hidden || (inMeeting && !inMeeting.has(t.id))) return;
      const r = runtime(t.id);
      const f = !!inMeeting;
      if (r.status === 'ok' && r.alts) {
        // Neshan's other public-transport options overlap a lot: they stay as buttons only
        if (t.mode !== 'PUBLIC_TRANSPORTATION') {
          r.alts.forEach((a, i) => { if (i !== t.alt) lines.push({ coords: a.coords, color: t.color, width: 4, dash: 'alt', opacity: f ? 0.25 : 0.6 }); });
        }
        const sel = r.alts[t.alt] || r.alts[0];
        if (sel.transit?.segments?.some((g) => g.coords?.length)) {
          for (const g of sel.transit.segments) {
            lines.push({ coords: g.coords, color: t.color, width: g.type === 'walk' ? 4 : 6, dash: g.type === 'walk' ? 'dot' : undefined, opacity: f ? 0.3 : 1 });
          }
        } else lines.push({ coords: sel.coords, color: t.color, width: 5, opacity: f ? 0.3 : 1 });
      }
      for (const which of ['origin', 'dest']) {
        const p = t[which];
        if (!p) continue;
        pins.push({
          key: `${t.id}-${which}`, lat: p.lat, lng: p.lng, z: 2, draggable: true,
          html: `<div class="pin ${which === 'dest' ? 'dest' : ''}" style="--c:${t.color}"><span>${fa(idx + 1)}</span></div>`,
          title: `${which === 'origin' ? 'مبدا' : 'مقصد'} ${t.name} — برای جابه‌جایی بکشید`,
          onDragEnd: (lat, lng) => setPoint(t.id, which, { lat, lng }),
          onClick: () => highlightCard(t.id),
        });
      }
    });
    const m = state.meeting;
    if (meetingOnMap()) {
      const opt = shownOption();
      m.participants.forEach((id, i) => {
        const t = tripById(id);
        const per = opt.per[i];
        if (!t || !per) return;
        lines.push({ coords: per.legA.coords, color: t.color, width: 5, dash: 'dot' });
        lines.push({ coords: per.legB.coords, color: t.color, width: 5 });
      });
      m.options.forEach((o, i) => {
        if (o === opt) return;
        pins.push({
          key: `meet-${i}`, lat: o.p.lat, lng: o.p.lng, z: 4,
          html: `<div class="meet alt">${fa(i + 1)}</div>`, title: i === 0 ? 'بهترین گزینه' : `گزینهٔ ${fa(i + 1)}`,
          onClick: () => showOption(i),
        });
      });
      pins.push({
        key: 'meet', lat: opt.p.lat, lng: opt.p.lng, z: 5, draggable: true,
        html: '<div class="meet">🤝</div>', title: 'محل قرار — برای سنجیدن جای دیگر بکشید',
        onDragEnd: (lat, lng) => evaluateManual({ lat, lng }),
        onClick: () => { openPanel(); switchTab('meet'); },
      });
    }
    nm.setLines(lines);
    nm.setPins(pins);
  }

  const fitPadding = () => ({ top: 90, bottom: 50, right: 110, left: state.settings.panelOpen ? 480 : 80 });
  function fitAll(explicit = false) {
    const pts = [];
    for (const t of state.trips) {
      if (t.hidden) continue;
      if (t.origin) pts.push([t.origin.lat, t.origin.lng]);
      if (t.dest) pts.push([t.dest.lat, t.dest.lng]);
      const r = runtime(t.id);
      if (r.alts?.[t.alt]) pts.push(...r.alts[t.alt].coords);
    }
    nm.fitPoints(pts, fitPadding(), { explicit });
  }

  // ---------------------------------------------------------------- picking
  let picking = null; // {tripId, which}
  function startPick(tripId, which) {
    picking = { tripId, which };
    $$('.pick-btn').forEach((b) => b.classList.toggle('active', b.dataset.trip === tripId && b.dataset.which === which));
    const t = tripById(tripId);
    toast(`روی نقشه بزنید: ${which === 'origin' ? 'مبدا' : 'مقصد'} «${t.name}» — Esc برای لغو`, { ms: 0 });
    nm.startPick((p) => {
      const cur = picking;
      endPick();
      if (cur) setPoint(cur.tripId, cur.which, p);
    });
  }
  function endPick() {
    picking = null;
    nm.stopPick();
    $$('.pick-btn').forEach((b) => b.classList.remove('active'));
    hideToast();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking) endPick(); });

  // ---------------------------------------------------------------- trips: data
  function markMeetingStale(tripId) {
    if (state.meeting && !state.meeting.stale && state.meeting.participants.includes(tripId)) {
      state.meeting.stale = true;
      renderMeetResult();
      redraw();
    }
  }

  async function setPoint(tripId, which, p, label = '') {
    const t = tripById(tripId);
    if (!t) return;
    t[which] = { lat: p.lat, lng: p.lng, label: label || fmtCoord(p) };
    updatePointInput(t, which);
    markMeetingStale(tripId);
    save();
    const hadRoute = runtime(tripId).status === 'ok';
    routeTrip(t).then(() => { if (!hadRoute && runtime(tripId).status === 'ok') fitAll(); });
    redraw();
    if (!label) {
      try {
        const addr = await P.reverse(p);
        const cur = tripById(tripId)?.[which];
        if (addr && cur && cur.lat === p.lat && cur.lng === p.lng) {
          cur.label = addr;
          updatePointInput(t, which);
          save();
        }
      } catch { /* keep coordinates as the label */ }
    }
  }

  async function routeTrip(t) {
    const r = runtime(t.id);
    const seq = ++r.seq;
    if (!t.origin || !t.dest) {
      r.status = 'idle'; r.alts = null;
      updateResult(t); redraw(); renderSide();
      return;
    }
    // Reuse a recent result (also across reloads) instead of asking neshan.org again.
    const key = P.routeKey(t.mode, t.origin, t.dest, t.avoid);
    if (t.cache?.key === key && Date.now() - t.cache.at < ROUTE_REUSE_MS && t.cache.alts?.length) {
      r.alts = t.cache.alts; r.status = 'ok'; r.error = '';
      if (!(t.alt < r.alts.length)) t.alt = 0;
      updateResult(t); redraw(); renderSide();
      return;
    }
    r.status = 'loading';
    updateResult(t);
    try {
      const alts = await P.getRoutes({ mode: t.mode, origin: t.origin, dest: t.dest, avoid: t.avoid });
      // Google returns the names of both points with the route: use them for picked points
      if (alts.labels) {
        ['origin', 'dest'].forEach((w, i) => {
          if (alts.labels[i] && t[w] && /^-?\d+\.\d+, -?\d+\.\d+$/.test(t[w].label)) { t[w].label = alts.labels[i]; updatePointInput(t, w); }
        });
      }
      if (seq !== r.seq) return;
      r.alts = alts; r.status = 'ok'; r.error = '';
      t.cache = { key, at: Date.now(), alts: alts.map(({ duration, distance, summary, coords, transit }) => ({ duration, distance, summary, coords, transit })) };
      save();
      if (!(t.alt < alts.length)) t.alt = 0;
    } catch (e) {
      if (seq !== r.seq) return;
      r.status = 'error'; r.alts = null; r.error = e.message || 'خطا';
    }
    updateResult(t);
    redraw();
    renderSide();
  }

  function selectAlt(tripId, i) {
    const t = tripById(tripId);
    t.alt = i;
    save(); updateResult(t); redraw(); renderCompare();
  }

  function removeTrip(id) {
    const i = tripIndex(id);
    if (i < 0) return;
    state.trips.splice(i, 1);
    rt.delete(id);
    if (state.meeting?.participants.includes(id)) state.meeting = null;
    save(); renderTrips(); renderMeetResult(); redraw();
  }

  function addTrip(partial) {
    const t = newTrip(partial);
    state.trips.push(t);
    openId = t.id;
    save();
    renderTrips();
    return t;
  }

  function addTripsFromLink(text) {
    const parsed = P.parseLink(text);
    if (!parsed) return false;
    const t = addTrip({ mode: parsed.mode });
    setPoint(t.id, 'origin', parsed.origin);
    setPoint(t.id, 'dest', parsed.dest);
    return true;
  }

  // ---------------------------------------------------------------- trips: rendering
  const modeButtons = (sel) => P.modes.map((k) => [k, MODES[k]]).map(([k, m]) =>
    `<button type="button" class="mode ${k === sel ? 'sel' : ''}" data-mode="${k}" role="radio" aria-checked="${k === sel}" title="${m.label}">${m.icon}<span>${m.label}</span></button>`).join('');

  // 24-hour departure time: hour 00–23 and minute (5-minute steps) as two lists.
  function departHTML(depart) {
    const [h, m] = /^(\d{1,2}):(\d{2})$/.test(depart || '') ? depart.split(':').map(Number) : [null, null];
    const two = (n) => String(n).padStart(2, '0');
    const mins = Array.from({ length: 12 }, (_, i) => i * 5);
    if (m !== null && !mins.includes(m)) mins.push(m), mins.sort((a, b) => a - b);
    const hourOpts = `<option value="">--</option>${Array.from({ length: 24 }, (_, i) =>
      `<option value="${two(i)}" ${i === h ? 'selected' : ''}>${fa(two(i))}</option>`).join('')}`;
    const minOpts = mins.map((i) => `<option value="${two(i)}" ${i === (m ?? 0) ? 'selected' : ''}>${fa(two(i))}</option>`).join('');
    return `<span class="time-pick" title="ساعت حرکت (۲۴ ساعته)"><span class="field-label inline">ساعت حرکت</span>
      <span class="hm" dir="ltr">
        <select data-f="dep-h" aria-label="ساعت حرکت">${hourOpts}</select><b>:</b><select data-f="dep-m" aria-label="دقیقهٔ حرکت" ${h === null ? 'disabled' : ''}>${minOpts}</select>
      </span>
      <button class="link-btn" data-f="dep-now" title="ساعت الان">الان</button>
      <button class="link-btn danger" data-f="dep-clear" title="بدون ساعت حرکت" ${h === null ? 'hidden' : ''}>✕</button>
    </span>`;
  }

  function setDepart(el, id, value) {
    const trip = tripById(id);
    trip.depart = value;
    $('.time-pick', el).outerHTML = departHTML(value);
    markMeetingStale(id); save(); updateResult(trip); renderCompare();
  }

  // A route is a one-line row (number/colour matching its pins, name, time · distance);
  // clicking it opens the editor below it. One editor is open at a time.
  function tripCardHTML(t) {
    const avoid = Object.entries(AVOID_LABELS)
      .map(([k, lbl]) => `<label class="check"><input type="checkbox" data-f="avoid" data-k="${k}" ${t.avoid?.[k] ? 'checked' : ''}> <span>بدون ${lbl}</span></label>`).join('');
    const pt = (which, tag) => `
      <div class="pt-row">
        <input type="text" data-f="${which}" dir="auto" autocomplete="off" aria-label="${tag}"
          placeholder="${tag}: جستجو کنید یا 📍 را بزنید" value="${esc(t[which]?.label || '')}">
        <button class="pick-btn" data-trip="${t.id}" data-which="${which}" title="${tag} را روی نقشه بزنید" aria-label="انتخاب ${tag} روی نقشه">📍</button>
        <div class="suggest" hidden></div>
      </div>`;
    return `
      <div class="trip-row" data-f="toggle" role="button" tabindex="0" aria-expanded="false">
        <span class="num"></span>
        <span class="row-main"><b class="row-name"></b><span class="row-sub"></span></span>
        <span class="row-mode"></span>
        <button class="icon-btn eye" data-f="hide" title="نمایش یا پنهان کردن روی نقشه" aria-label="نمایش یا پنهان کردن روی نقشه">👁</button>
        <span class="chev" aria-hidden="true">⌄</span>
      </div>
      <div class="trip-body" hidden>
        <div class="name-line">
          <button class="swatch" data-f="color" title="تغییر رنگ" aria-label="تغییر رنگ"></button>
          <label class="name-wrap" title="اسم این مسیر">
            <input type="text" class="trip-name" data-f="name" value="${esc(t.name)}" placeholder="اسم مسیر، مثلاً علی" aria-label="اسم مسیر" maxlength="40">
            <span class="pencil" aria-hidden="true">✎</span>
          </label>
        </div>
        <div class="modes" role="radiogroup" aria-label="با چه وسیله‌ای">${modeButtons(t.mode)}</div>
        <div class="od">
          <div class="rail" aria-hidden="true"><i class="r-o"></i><i class="r-line"></i><i class="r-d"></i></div>
          <div class="od-fields">${pt('origin', 'مبدا')}${pt('dest', 'مقصد')}</div>
          <button class="icon-btn swap-btn" data-f="swap" title="جابه‌جا کردن مبدا و مقصد" aria-label="جابه‌جا کردن مبدا و مقصد">⇅</button>
        </div>
        <div class="trip-result"></div>
        <details class="more">
          <summary>ساعت حرکت و گزینه‌های بیشتر</summary>
          <div class="more-body">
            ${departHTML(t.depart)}
            <div class="avoid-opts" ${hasAvoid(t.mode) ? '' : 'hidden'}>${avoid}</div>
          </div>
        </details>
        <div class="card-actions">
          <a class="link-btn neshan-link" href="#" hidden>نمایش در خود ${P.siteName}</a>
          <button class="link-btn" data-f="dup">کپی این مسیر</button>
          <button class="link-btn danger" data-f="del">حذف</button>
        </div>
      </div>`;
  }

  let openId = null; // the route whose editor is open
  function setOpen(id) {
    openId = id;
    for (const el of $$('.trip')) {
      const on = el.dataset.id === id;
      el.classList.toggle('open', on);
      $('.trip-body', el).hidden = !on;
      $('.trip-row', el).setAttribute('aria-expanded', String(on));
    }
  }

  // The one-line summary of a route.
  function updateRow(t, el = cardEl(t.id)) {
    if (!el) return;
    $('.num', el).textContent = fa(tripIndex(t.id) + 1);
    $('.row-name', el).textContent = t.name;
    const nameInput = $('input[data-f="name"]', el);
    if (nameInput && R.activeElement !== nameInput && nameInput.value !== t.name) nameInput.value = t.name;
    for (const b of $$('.mode', el)) {
      const on = b.dataset.mode === t.mode;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('.avoid-opts', el).hidden = !hasAvoid(t.mode);
    $('.row-mode', el).textContent = MODES[t.mode].icon;
    $('.row-mode', el).title = MODES[t.mode].label;
    const r = runtime(t.id);
    const sub = $('.row-sub', el);
    sub.classList.toggle('err', r.status === 'error');
    if (r.status === 'ok') {
      const sel = r.alts[t.alt] || r.alts[0];
      const dep = parseClock(t.depart);
      sub.textContent = `${durText(sel)}، ${fmtDist(sel.distance)}${dep !== null ? `، رسیدن ${fmtClock(dep + sel.duration / 60)}` : ''}`;
    } else if (r.status === 'loading') sub.textContent = 'در حال مسیریابی…';
    else if (r.status === 'error') sub.textContent = 'مسیر گرفته نشد';
    else sub.textContent = t.origin ? 'مقصد را مشخص کنید' : 'مبدا و مقصد را مشخص کنید';
  }

  function renderTrips() {
    const list = $('#tripList');
    const existing = new Map($$('.trip', list).map((el) => [el.dataset.id, el]));
    const frag = document.createDocumentFragment();
    for (const t of state.trips) {
      let el = existing.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'trip';
        el.dataset.id = t.id;
        el.innerHTML = tripCardHTML(t);
        bindCard(el, t.id);
      }
      el.style.setProperty('--c', t.color);
      el.classList.toggle('off', !!t.hidden);
      existing.delete(t.id);
      frag.appendChild(el);
      updateResult(t, el);
    }
    existing.forEach((el) => el.remove());
    list.appendChild(frag);
    if (!state.trips.length) {
      list.innerHTML = `<div class="empty-state">
        <ol class="steps">
          <li><b>مسیرها را اضافه کنید</b><span>هر نفر یک مسیر: از کجا به کجا</span></li>
          <li><b>روی نقشه مقایسه کنید</b><span>زمان، مسافت و راه‌های مشترک</span></li>
          <li><b>محل قرار را پیدا کنید</b><span>جایی سر راه همه، با کمترین وقت اضافه</span></li>
        </ol></div>`;
    } else $('.empty-state', list)?.remove();
    if (openId && !tripById(openId)) openId = null;
    setOpen(openId);
    $('#tripCount').textContent = fa(state.trips.length);
    $('#tripCount').hidden = !state.trips.length;
    $('#launcherCount').textContent = fa(state.trips.length);
    $('#launcherCount').hidden = !state.trips.length;
    redraw(); // pin numbers may have changed
    renderSide();
  }

  const cardEl = (id) => $(`.trip[data-id="${id}"]`);

  function updatePointInput(t, which) {
    const inp = cardEl(t.id)?.querySelector(`input[data-f="${which}"]`);
    if (inp && R.activeElement !== inp) inp.value = t[which]?.label || '';
  }

  function updateResult(t, el = cardEl(t.id)) {
    if (!el) return;
    updateRow(t, el);
    const box = $('.trip-result', el);
    const r = runtime(t.id);
    const link = $('.neshan-link', el);
    link.hidden = !(t.origin && t.dest);
    if (t.origin && t.dest) link.href = P.link(t.mode, t.origin, t.dest);
    if (r.status === 'loading') { box.innerHTML = '<span class="spinner"></span> <span class="muted">در حال گرفتن مسیر از نشان…</span>'; return; }
    if (r.status === 'error') { box.innerHTML = `<span class="err">${esc(r.error)}</span> <button class="link-btn" data-f="retry">دوباره</button>`; return; }
    if (r.status !== 'ok') { box.innerHTML = ''; return; }
    const sel = r.alts[t.alt] || r.alts[0];
    const alts = r.alts.length > 1
      ? `<div class="alts"><span class="muted">راه‌های نشان:</span>${r.alts.map((a, i) => `<button class="alt ${i === t.alt ? 'sel' : ''}" data-alt="${i}" title="راه ${fa(i + 1)}${a.transit ? `: ${esc(a.summary)}` : ''}">${durText(a)}</button>`).join('')}</div>`
      : '';
    const dep = parseClock(t.depart);
    const tr = sel.transit;
    box.innerHTML = `
      <div class="main">
        <span class="big">${durText(sel)}</span>
        <span>${fmtDist(sel.distance)}</span>
        ${dep !== null ? `<span class="muted">رسیدن ${fmtClock(dep + sel.duration / 60)}</span>` : ''}
      </div>
      ${tr ? transitHTML(tr) : sel.summary ? `<div class="muted via">از ${esc(sel.summary)}</div>` : ''}
      ${alts}`;
  }

  // Public transport, step by step: walk, ride a line for N stops, get off at ...
  function transitHTML(tr) {
    const steps = tr.segments.map((g) => g.type === 'walk'
      ? `<li class="walk"><span class="ic">🚶</span><span>${fmtDist(g.distance)} پیاده${g.to ? ` تا ${esc(g.to)}` : ''}</span></li>`
      : `<li class="ride"><span class="ic">${g.type === 'metro' ? '🚇' : g.type === 'transit' ? '🚆' : '🚌'}</span><span><b>${esc(g.type === 'transit' ? g.line : transitLineLabel(g))}</b>${g.stops ? `، ${fa(g.stops)} ایستگاه` : ''}${g.from ? ` از ${esc(g.from)}` : ''}${g.to ? ` تا ${esc(g.to)}` : ''}${g.type === 'transit' && g.duration ? `، ${fmtDur(g.duration)}` : ''}</span></li>`).join('');
    const fare = tr.fareText || (tr.fare ? fmtToman(tr.fare) : '');
    return `<div class="muted via">${fare ? `کرایه ${esc(fare)}، ` : ''}${fmtDist(tr.walk)} پیاده‌روی</div>
      <ol class="transit">${steps}</ol>
      ${tr.estimated === false ? '' : '<p class="hint">زمان مسیرهای همگانی تخمینی است؛ خود نشان برای این حالت زمان نمی‌دهد.</p>'}`;
  }

  function highlightCard(id) {
    openPanel();
    switchTab('trips');
    const el = cardEl(id);
    if (!el) return;
    setOpen(id);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.add('hl');
    setTimeout(() => el.classList.remove('hl'), 1200);
  }

  function bindCard(el, id) {
    const t = () => tripById(id);
    el.addEventListener('input', (e) => {
      if (e.target.dataset.f === 'name') {
        t().name = e.target.value.trim() || 'بی‌نام';
        updateRow(t(), el);
        save(); renderSide();
      }
    });
    el.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      const trip = t();
      if (f === 'dep-h' || f === 'dep-m') {
        const h = $('select[data-f="dep-h"]', el).value;
        setDepart(el, id, h ? `${h}:${$('select[data-f="dep-m"]', el).value || '00'}` : '');
      } else if (f === 'avoid') {
        trip.avoid = { ...trip.avoid, [e.target.dataset.k]: e.target.checked };
        markMeetingStale(id); save(); routeTrip(trip);
      }
    });
    el.addEventListener('click', (e) => {
      const trip = t();
      const a = e.target.closest('a.neshan-link');
      if (a) {
        // Show this route in Neshan's own routing panel (same tab, the panel stays open).
        e.preventDefault();
        location.assign(a.href);
        return;
      }
      const b = e.target.closest('button');
      if (!b) {
        if (e.target.closest('.trip-row')) setOpen(openId === id ? null : id);
        return;
      }
      if (b.dataset.mode) setMode(el, id, b.dataset.mode);
      else if (b.classList.contains('pick-btn')) {
        if (picking && picking.tripId === id && picking.which === b.dataset.which) endPick();
        else startPick(id, b.dataset.which);
      } else if (b.dataset.alt) selectAlt(id, +b.dataset.alt);
      else if (b.dataset.f === 'color') {
        trip.color = COLORS[(COLORS.indexOf(trip.color) + 1) % COLORS.length];
        el.style.setProperty('--c', trip.color);
        save(); redraw(); renderSide(); renderMeetResult();
      } else if (b.dataset.f === 'hide') {
        trip.hidden = !trip.hidden;
        el.classList.toggle('off', trip.hidden);
        b.title = trip.hidden ? 'پنهان است؛ برای نمایش روی نقشه بزنید' : 'نمایش یا پنهان کردن روی نقشه';
        save(); redraw();
      } else if (b.dataset.f === 'dep-now') {
        const d = new Date();
        const total = Math.round((d.getHours() * 60 + d.getMinutes()) / 5) * 5 % 1440;
        setDepart(el, id, `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`);
      } else if (b.dataset.f === 'dep-clear') {
        setDepart(el, id, '');
      } else if (b.dataset.f === 'swap') {
        [trip.origin, trip.dest] = [trip.dest, trip.origin];
        updatePointInput(trip, 'origin'); updatePointInput(trip, 'dest');
        markMeetingStale(id); save(); routeTrip(trip); redraw();
      } else if (b.dataset.f === 'del') removeTrip(id);
      else if (b.dataset.f === 'dup') {
        const { id: _id, color: _c, ...rest } = structuredClone(trip);
        const copy = newTrip({ ...rest, name: `${trip.name} (کپی)` });
        state.trips.splice(tripIndex(id) + 1, 0, copy);
        openId = copy.id;
        save(); renderTrips(); routeTrip(copy);
      } else if (b.dataset.f === 'retry') routeTrip(trip);
    });
    $('.trip-row', el).addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('trip-row')) {
        e.preventDefault();
        setOpen(openId === id ? null : id);
      }
    });
    for (const which of ['origin', 'dest']) bindSearch(el, id, which);
  }

  function setMode(el, id, mode) {
    const trip = tripById(id);
    if (!MODES[mode]) return;
    for (const b of $$('.mode', el)) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('.avoid-opts', el).hidden = !hasAvoid(mode);
    if (trip.mode === mode) return;
    trip.mode = mode; trip.alt = 0;
    markMeetingStale(id); save(); routeTrip(trip);
  }

  function bindSearch(el, id, which) {
    const input = $(`input[data-f="${which}"]`, el);
    const box = input.parentElement.querySelector('.suggest');
    let items = [], sel = -1, timer = null, ac = null;
    const close = () => { box.hidden = true; items = []; sel = -1; };
    const show = (list, emptyText = '') => {
      items = list; sel = list.length ? 0 : -1;
      box.innerHTML = list.length
        ? list.map((it, i) => `<button type="button" data-i="${i}" class="${i === sel ? 'sel' : ''}">${esc(it.title)}${it.subtitle ? `<small>${esc(it.subtitle)}</small>` : ''}</button>`).join('')
        : `<div class="empty">${esc(emptyText)}</div>`;
      box.hidden = false;
    };
    const choose = (it) => {
      close();
      input.value = it.title;
      setPoint(id, which, { lat: it.lat, lng: it.lng }, it.coordsOnly ? '' : it.title + (it.subtitle ? `، ${it.subtitle}` : ''));
      nm.flyTo(it.lat, it.lng);
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      ac?.abort();
      const v = input.value.trim();
      const link = P.parseLink(v);
      if (link) {
        setMode(el, id, link.mode);
        input.blur();
        close();
        setPoint(id, 'origin', link.origin);
        setPoint(id, 'dest', link.dest);
        return;
      }
      const ll = parseLatLng(v);
      if (ll) { show([{ title: `مختصات ${fmtCoord(ll)}`, subtitle: '', ...ll, coordsOnly: true }]); return; }
      if (v.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        ac = new AbortController();
        box.hidden = false;
        box.innerHTML = '<div class="empty"><span class="spinner"></span> جستجو…</div>';
        try {
          const res = await P.search(v, nm.getCenter(), ac.signal);
          if (input.value.trim() === v) show(res.slice(0, 8), 'چیزی پیدا نشد');
        } catch (e) {
          if (e.kind !== 'aborted') show([], 'جستجو انجام نشد');
        }
      }, 300);
    });
    input.addEventListener('keydown', (e) => {
      if (box.hidden || !items.length) {
        if (e.key === 'Enter') e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        $$('button', box).forEach((b, i) => b.classList.toggle('sel', i === sel));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (sel >= 0) choose(items[sel]);
      } else if (e.key === 'Escape') close();
    });
    box.addEventListener('mousedown', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      e.preventDefault(); // keep focus so blur does not close first
      choose(items[+b.dataset.i]);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (R.activeElement === input) return; // focus came back meanwhile
        close();
        input.value = tripById(id)?.[which]?.label || '';
      }, 150);
    });
  }

  // ---------------------------------------------------------------- compare tab
  const routedTrips = () => state.trips.filter((t) => runtime(t.id).status === 'ok')
    .map((t) => ({ t, r: runtime(t.id).alts[t.alt] || runtime(t.id).alts[0] }));

  // Routes whose origin (or destination) lies within GROUP_RADIUS_M of a group's first
  // point form one group: the same place picked twice is rarely the exact same point.
  const GROUP_RADIUS_M = 150;
  const shortLabel = (p) => String(p?.label || '').split('،')[0].trim() || (p ? fmtCoord(p) : 'نامشخص');
  function groupRows(rows, key) {
    const groups = [];
    for (const row of rows) {
      const p = row.t[key];
      let g = p && groups.find((x) => x.anchor && haversine(x.anchor, p) <= GROUP_RADIUS_M);
      if (!g) { g = { anchor: p, title: shortLabel(p), rows: [] }; groups.push(g); }
      g.rows.push(row);
    }
    return groups;
  }

  function groupedHTML(rows, by) {
    const maxDur = Math.max(...rows.map((x) => x.r.duration));
    const groups = groupRows(rows, by === 'dest' ? 'dest' : 'origin');
    return groups.map((g) => {
      const sorted = [...g.rows].sort((a, b) => a.r.duration - b.r.duration);
      const ids = g.rows.map(({ t }) => t.id).join(',');
      return `<div class="card group">
        <div class="group-head">
          <b>${by === 'dest' ? 'به' : 'از'} ${esc(g.title)}</b>
          <span class="muted">${fa(g.rows.length)} مسیر</span>
          <button class="link-btn" data-only="${ids}" title="بقیهٔ مسیرها موقتاً از روی نقشه پنهان می‌شوند">فقط این‌ها روی نقشه</button>
        </div>
        ${sorted.map(({ t, r }, i) => `
          <div class="g-row" style="--c:${t.color}">
            <span class="dot"></span>
            <span class="nm" title="${esc(t.name)}">${esc(t.name)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${maxDur ? (100 * r.duration) / maxDur : 0}%"></div></div>
            <span class="val"><b>${durText(r)}</b><small>${fmtDist(r.distance)}</small></span>
            ${i === 0 && sorted.length > 1 ? '<span class="best-tag">نزدیک‌ترین</span>' : ''}
          </div>`).join('')}
      </div>`;
    }).join('');
  }

  function renderCompare() {
    const box = $('#compareBody');
    const rows = routedTrips();
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state"><p>وقتی مسیرها آماده شوند، زمان و مسافتشان اینجا کنار هم می‌آید.</p></div>';
      return;
    }
    const by = ['origin', 'dest'].includes(state.settings.compareGroup) ? state.settings.compareGroup : 'none';
    const hiddenCount = state.trips.filter((t) => t.hidden).length;
    const toolbar = `
      <div class="cmp-tools">
        <span class="field-label inline">گروه‌بندی</span>
        <div class="seg small" role="radiogroup">
          <label><input type="radio" name="compareGroup" value="none" ${by === 'none' ? 'checked' : ''}><span>هیچ</span></label>
          <label><input type="radio" name="compareGroup" value="origin" ${by === 'origin' ? 'checked' : ''}><span>مبدا</span></label>
          <label><input type="radio" name="compareGroup" value="dest" ${by === 'dest' ? 'checked' : ''}><span>مقصد</span></label>
        </div>
      </div>
      ${hiddenCount ? `<div class="hidden-note">${fa(hiddenCount)} مسیر روی نقشه پنهان است. <button class="link-btn" data-act="show-all">نمایش همه</button></div>` : ''}`;
    const byTime = [...rows].sort((a, b) => a.r.duration - b.r.duration);
    const maxDur = Math.max(...rows.map((x) => x.r.duration));
    const maxDist = Math.max(...rows.map((x) => x.r.distance));
    const anyDep = rows.some((x) => parseClock(x.t.depart) !== null);
    const table = `
      <table class="cmp">
        <thead><tr><th>مسیر</th><th>زمان</th><th>مسافت</th><th>سرعت</th>${anyDep ? '<th>رسیدن</th>' : ''}</tr></thead>
        <tbody>${byTime.map(({ t, r }, i) => {
          const dep = parseClock(t.depart);
          const kmh = r.duration ? (r.distance / r.duration) * 3.6 : 0;
          return `<tr>
            <td><span class="dot" style="--c:${t.color}"></span>${esc(t.name)} <span title="${MODES[t.mode].label}">${MODES[t.mode].icon}</span>${i === 0 && rows.length > 1 ? '<span class="best-tag">سریع‌ترین</span>' : ''}</td>
            <td class="num-cell">${durText(r)}</td>
            <td class="num-cell">${fmtDist(r.distance)}</td>
            <td class="num-cell">${fa(Math.round(kmh))} <small class="muted">km/h</small></td>
            ${anyDep ? `<td>${dep !== null ? fmtClock(dep + r.duration / 60) : '—'}</td>` : ''}
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    const bars = (key, max, fmt) => `<div class="bars">${[...rows].sort((a, b) => a.r[key] - b.r[key]).map(({ t, r }) => `
        <div class="bar-row" style="--c:${t.color}">
          <span class="nm">${esc(t.name)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${max ? (100 * r[key]) / max : 0}%"></div></div>
          <span class="val">${key === 'duration' ? durText(r) : fmt(r[key])}</span>
        </div>`).join('')}</div>`;
    let matrix = '';
    if (rows.length > 5) {
      // a big matrix does not fit the panel: list the pairs that share the most road
      const pairs = [];
      rows.forEach((a, i) => rows.slice(i + 1).forEach((b) => {
        const s = Math.min(sharedLength(a.r.coords, b.r.coords), sharedLength(b.r.coords, a.r.coords));
        if (s >= 50) pairs.push({ a, b, s });
      }));
      pairs.sort((x, y) => y.s - x.s);
      matrix = `<details class="more card"><summary>چقدر از راهشان مشترک است؟</summary>
        ${pairs.length ? `<div class="pairs">${pairs.slice(0, 10).map(({ a, b, s }) => `
          <div class="pair"><span><span class="dot" style="--c:${a.t.color}"></span>${esc(a.t.name)}</span>
            <span><span class="dot" style="--c:${b.t.color}"></span>${esc(b.t.name)}</span>
            <b>${fmtDist(s)}</b></div>`).join('')}</div>` : '<p class="hint">هیچ دو مسیری راه مشترکِ قابل‌توجهی ندارند.</p>'}
        <p class="hint">جفت‌مسیرهایی که بیشترین راه مشترک را دارند (کمتر از ۲۵ متر فاصله).</p></details>`;
    } else if (rows.length >= 2) {
      matrix = `<details class="more card"><summary>چقدر از راهشان مشترک است؟</summary>
        <table class="cmp matrix"><thead><tr><th></th>${rows.map(({ t }) => `<th><span class="dot" style="--c:${t.color}"></span>${esc(t.name)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((a) => `<tr><th><span class="dot" style="--c:${a.t.color}"></span>${esc(a.t.name)}</th>${rows.map((b) => {
          if (a === b) return '<td class="muted">—</td>';
          const s = sharedLength(a.r.coords, b.r.coords);
          return `<td>${s < 50 ? '<span class="muted">—</span>' : `${fmtDist(s)}<br><small class="muted">${fa(Math.round((100 * s) / a.r.distance))}٪</small>`}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table>
        <p class="hint">چه مقدار از مسیرِ هر ردیف روی مسیرِ ستون هم هست.</p></details>`;
    }
    if (by !== 'none') {
      box.innerHTML = `${toolbar}${groupedHTML(rows, by)}${matrix}`;
      return;
    }
    const metric = state.settings.compareBy === 'distance' ? 'distance' : 'duration';
    box.innerHTML = `${toolbar}
      <div class="card">${table}</div>
      <div class="card">
        <div class="seg small" role="radiogroup" id="compareBy">
          <label><input type="radio" name="compareBy" value="duration" ${metric === 'duration' ? 'checked' : ''}><span>زمان</span></label>
          <label><input type="radio" name="compareBy" value="distance" ${metric === 'distance' ? 'checked' : ''}><span>مسافت</span></label>
        </div>
        ${metric === 'duration' ? bars('duration', maxDur, fmtDur) : bars('distance', maxDist, fmtDist)}
      </div>
      ${matrix}`;
  }
  $('#compareBody').addEventListener('change', (e) => {
    if (e.target.name === 'compareBy') state.settings.compareBy = e.target.value;
    else if (e.target.name === 'compareGroup') state.settings.compareGroup = e.target.value;
    else return;
    save(); renderCompare();
  });
  $('#compareBody').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.only) {
      const keep = new Set(b.dataset.only.split(','));
      for (const t of state.trips) t.hidden = !keep.has(t.id);
    } else if (b.dataset.act === 'show-all') {
      for (const t of state.trips) t.hidden = false;
    } else return;
    save(); renderTrips(); renderCompare(); fitAll();
  });

  // ---------------------------------------------------------------- meeting tab
  function renderMeetPeople() {
    const box = $('#meetPeople');
    const hint = $('#meetHint');
    if (!state.trips.length) {
      box.innerHTML = '';
      hint.hidden = false;
      hint.textContent = 'اول در تب «مسیرها» مسیر هر نفر را اضافه کنید.';
      $('#meetBtn').disabled = true;
      return;
    }
    box.innerHTML = state.trips.map((t) => {
      const r = runtime(t.id);
      const ready = r.status === 'ok';
      const why = ready ? '' : r.status === 'loading' ? 'در حال مسیریابی' : r.status === 'error' ? 'مسیر گرفته نشد' : 'مبدا/مقصد ناقص';
      const on = t.inMeeting && ready;
      return `<button type="button" class="chip ${on ? 'on' : ''}" data-id="${t.id}" aria-pressed="${on}" ${ready ? '' : 'disabled'}
        style="--c:${t.color}" title="${ready ? (on ? 'در قرار هست؛ برای کنار گذاشتن بزنید' : 'در قرار نیست؛ برای اضافه کردن بزنید') : why}">
        <span class="dot"></span>${esc(t.name)}${why ? `<small>${why}</small>` : ''}</button>`;
    }).join('');
    const n = meetingParticipants().length;
    hint.hidden = n >= 2;
    hint.textContent = 'دست‌کم دو نفر با مسیر آماده لازم است؛ روی اسم‌ها بزنید.';
    if (!meetAbort) $('#meetBtn').disabled = n < 2;
    renderMeetEstimate();
  }

  // Before starting: roughly how long it can take at the pace Neshan currently accepts.
  function renderMeetEstimate() {
    const el = $('#meetEstimate');
    const n = meetingParticipants().length;
    if (n < 2 || meetAbort) { el.hidden = true; return; }
    const budget = PRECISION[state.settings.precision](n);
    const secs = (budget * routeGap()) / 1000;
    el.hidden = false;
    el.textContent = (secs < 60 ? 'کمتر از یک دقیقه طول می‌کشد.' : `حداکثر حدود ${fmtDur(secs)} طول می‌کشد.`)
      + (n > 4 ? ` با ${fa(n)} نفر، فقط کسانی را که واقعاً قرار می‌گذارند انتخاب کنید تا جواب بهتر و سریع‌تر شود.` : '');
  }
  $('#meetPeople').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    const t = b && tripById(b.dataset.id);
    if (!t || b.disabled) return;
    t.inMeeting = !t.inMeeting;
    save(); renderMeetPeople();
  });

  const meetingParticipants = () => state.trips.filter((t) => t.inMeeting && runtime(t.id).status === 'ok');

  function buildMeetTrips(trips) {
    const deps = trips.map((t) => parseClock(t.depart));
    const known = deps.filter((d) => d !== null);
    const ref = known.length ? Math.min(...known) : null;
    return {
      ref,
      mtrips: trips.map((t, i) => {
        const base = runtime(t.id).alts.reduce((a, b) => (b.duration < a.duration ? b : a));
        return {
          id: t.id, mode: t.mode, origin: t.origin, dest: t.dest, avoid: t.avoid,
          departSec: ref !== null && deps[i] !== null ? (deps[i] - ref) * 60 : 0,
          base: { duration: base.duration, distance: base.distance, coords: base.coords },
        };
      }),
    };
  }

  const router = async (t, from, to, signal) => {
    const alts = await P.getRoutes({ mode: t.mode, origin: from, dest: to, avoid: t.avoid, signal });
    const best = alts.reduce((a, b) => (b.duration < a.duration ? b : a));
    // Google names the end point of each route: that names the meeting point for free
    return alts.labels?.[1] ? { ...best, endLabel: alts.labels[1] } : best;
  };

  // Keep only what is needed to redraw and explain a result (it is persisted).
  const slimEval = (e) => e && {
    p: e.p, value: e.value, meet: e.meet, sum: e.sum, max: e.max,
    per: e.per.map((x) => ({
      a: x.a, b: x.b, arrival: x.arrival, wait: x.wait, detour: x.detour, extra: x.extra,
      legA: { duration: x.legA.duration, distance: x.legA.distance, coords: x.legA.coords, endLabel: x.legA.endLabel || '' },
      legB: { duration: x.legB.duration, distance: x.legB.distance, coords: x.legB.coords },
    })),
  };

  let meetAbort = null;
  async function runMeeting() {
    const trips = meetingParticipants();
    if (trips.length < 2) { toast('دست‌کم دو مسیرِ آماده با تیک «در قرار» لازم است.', { error: true }); return; }
    const { ref, mtrips } = buildMeetTrips(trips);
    const settings = { objective: state.settings.objective, includeWait: state.settings.includeWait };
    meetAbort = new AbortController();
    const btn = $('#meetBtn'), cancel = $('#meetCancel'), prog = $('#meetProgress');
    btn.disabled = true; btn.hidden = true; cancel.hidden = false; prog.hidden = false;
    $('#meetEstimate').hidden = true;
    const PH = { estimate: 'تخمین اولیه…', shortlist: 'بررسی نقطه‌های امیدوارکننده…', refine: 'دقیق‌تر کردن…', done: 'تمام' };
    let last = { phase: 'estimate', done: 0, total: 0 };
    let pauseUntil = 0;
    const paint = () => {
      const { phase, done, total } = last;
      $('.bar', prog).style.width = `${total ? Math.min(100, (100 * done) / total) : 0}%`;
      const wait = Math.ceil((pauseUntil - Date.now()) / 1000);
      // route requests start at most one per routeGap() ms
      const left = Math.ceil(((total - done) * routeGap()) / 1000);
      $('.ptext', prog).textContent = wait > 0
        ? `نشان سرعت را محدود کرده؛ آهسته‌تر ادامه می‌دهیم (${fa(wait)} ثانیه)…`
        : `${PH[phase] || ''}${total && done < total ? ` حداکثر حدود ${fa(Math.max(1, left))} ثانیه` : ''}`;
    };
    const onProgress = (p) => { last = p; paint(); };
    const stopPacing = onPacing(({ until }) => { pauseUntil = until; paint(); });
    const ticker = setInterval(paint, 1000);
    try {
      const res = await findMeetingPoint({
        trips: mtrips, router, ...settings, signal: meetAbort.signal, onProgress,
        maxCalls: PRECISION[state.settings.precision](mtrips.length),
      });
      state.meeting = {
        participants: mtrips.map((t) => t.id), ref, settings,
        options: [slimEval(res.best), ...res.alternatives.map(slimEval)],
        show: 0, manual: null, stale: false, calls: res.calls, partial: res.partial,
      };
      renderMeetResult();
      redraw();
      fitMeeting();
      save();
      lookupAddress(0);
    } catch (e) {
      if (e.kind !== 'aborted') toast(e.message || 'محاسبه انجام نشد', { error: true });
    } finally {
      clearInterval(ticker); stopPacing();
      btn.hidden = false; cancel.hidden = true; prog.hidden = true; meetAbort = null;
      renderMeetPeople();
    }
  }

  function fitMeeting(explicit = false) {
    const m = state.meeting;
    const opt = shownOption();
    if (!opt) return;
    const pts = [[opt.p.lat, opt.p.lng]];
    m.participants.forEach((id) => { const t = tripById(id); if (t) pts.push([t.origin.lat, t.origin.lng], [t.dest.lat, t.dest.lng]); });
    nm.fitPoints(pts, fitPadding(), { explicit });
  }

  async function lookupAddress(idx) {
    const m = state.meeting;
    const opt = idx === 'manual' ? m.manual : m.options[idx];
    if (!opt || opt.address) return;
    try {
      opt.address = (await P.reverse(opt.p)) || opt.per.map((x) => x.legA?.endLabel).find(Boolean) || '';
      if (state.meeting === m) { renderMeetResult(); save(); }
    } catch { /* coordinates are shown instead */ }
  }

  function shownOption() {
    const m = state.meeting;
    if (!m) return null;
    return m.show === 'manual' ? m.manual : m.options[m.show] || m.options[0];
  }

  function showOption(i) {
    state.meeting.show = i;
    renderMeetResult(); redraw(); save();
    lookupAddress(i);
  }

  async function evaluateManual(ll) {
    const m = state.meeting;
    const trips = m.participants.map(tripById);
    if (trips.some((t) => !t || runtime(t.id).status !== 'ok')) return;
    const { mtrips } = buildMeetTrips(trips);
    toast('در حال سنجیدن این نقطه…', { ms: 0 });
    try {
      const e = await evaluateMeetingPoint({ trips: mtrips, router, point: { lat: ll.lat, lng: ll.lng }, ...m.settings });
      if (state.meeting !== m) return;
      m.manual = slimEval(e);
      m.show = 'manual';
      hideToast();
      renderMeetResult(); redraw(); save();
      lookupAddress('manual');
    } catch (err) {
      toast(err.message || 'برای این نقطه مسیر پیدا نشد', { error: true });
      redraw();
    }
  }

  function renderMeetResult() {
    const box = $('#meetResult');
    const m = state.meeting;
    if (!m) { box.innerHTML = ''; return; }
    if (m.stale) {
      box.innerHTML = '<div class="card note">بعد از آخرین محاسبه، مسیرها عوض شده‌اند. دوباره «پیدا کردن محل قرار» را بزنید.</div>';
      return;
    }
    const opt = shownOption();
    const best = m.options[0];
    const title = m.show === 'manual' ? 'نقطه‌ای که خودتان گذاشتید' : m.show === 0 ? 'بهترین محل قرار' : `گزینهٔ ${fa(m.show + 1)}`;
    const vsBest = opt !== best ? `<div class="meet-sub">${opt.value - best.value < 45 ? 'تقریباً هم‌اندازهٔ بهترین گزینه' : `${fmtDur(opt.value - best.value)} بدتر از بهترین گزینه`}</div>` : '';
    const when = m.ref !== null ? `همه ساعت ${fmtClock(m.ref + opt.meet / 60)} آنجا هستند` : `همه ${fmtDur(opt.meet)} بعد از حرکت آنجا هستند`;
    const people = m.participants.map((id, i) => {
      const t = tripById(id);
      const p = opt.per[i];
      if (!t || !p) return '';
      const dep = parseClock(t.depart);
      const startMin = m.ref !== null ? (dep ?? m.ref) : null;
      const total = p.a + p.wait + p.b;
      const before = total - p.extra - (m.settings.includeWait ? 0 : p.wait);
      const cls = p.extra < 180 ? 'good' : p.extra > 900 ? 'warn' : '';
      return `<details class="person" style="--c:${t.color}">
        <summary><span class="dot"></span><b>${esc(t.name)}</b>
          <span class="muted">${fmtDur(p.a)} تا قرار${p.wait >= 45 ? `، ${fmtDur(p.wait)} معطلی` : ''}</span>
          <span class="extra ${cls}">${fmtExtra(p.detour + p.wait)}</span></summary>
        <div class="legs">
          <span>تا محل قرار</span><b>${fmtDur(p.a)}، ${fmtDist(p.legA.distance)}${startMin !== null ? ` (رسیدن ${fmtClock(startMin + p.a / 60)})` : ''}</b>
          <span>معطلی</span><b>${p.wait < 45 ? '—' : fmtDur(p.wait)}</b>
          <span>بعد تا مقصد</span><b>${fmtDur(p.b)}، ${fmtDist(p.legB.distance)}</b>
          <span>کل راه</span><b>${fmtDur(total)} <span class="muted">(بدون قرار ${fmtDur(before)})</span></b>
        </div>
        <div class="person-links">
          <a href="${P.link(t.mode, t.origin, opt.p)}" target="_blank" rel="noopener">مسیر تا قرار در ${P.siteName} ↗</a>
          <a href="${P.link(t.mode, opt.p, t.dest)}" target="_blank" rel="noopener">از قرار تا مقصد ↗</a>
        </div>
      </details>`;
    }).join('');
    const choices = m.options.length > 1 || m.manual
      ? `<div class="seg small options">${m.options.map((o, i) => `<button class="${m.show === i ? 'on' : ''}" data-opt="${i}">${i === 0 ? 'بهترین' : `گزینهٔ ${fa(i + 1)}`}</button>`).join('')}${m.manual ? `<button class="${m.show === 'manual' ? 'on' : ''}" data-opt="manual">نقطهٔ شما</button>` : ''}</div>`
      : '';
    box.innerHTML = `<div class="card result">
      ${choices}
      <div class="meet-head"><span class="meet-pin">🤝</span><div>
        <div class="meet-sub">${title}</div>
        <div class="meet-addr">${opt.address ? esc(opt.address) : `<span dir="ltr">${fmtCoord(opt.p)}</span>`}</div>
        ${vsBest}
      </div></div>
      <div class="when">${when}</div>
      <div class="totals">وقت اضافهٔ همه روی هم <b>${fmtDur(opt.sum)}</b>، بیشترینِ یک نفر <b>${fmtDur(opt.max)}</b></div>
      ${m.partial ? '<p class="note warn-note">نشان وسط کار درخواست‌ها را محدود کرد؛ این بهترین جایی است که تا آن لحظه پیدا شد. کمی بعد دوباره بزنید تا دقیق‌تر شود.</p>' : ''}
      <div class="people-list">${people}</div>
      <div class="res-actions">
        <button class="link-btn" data-act="zoom-meet">نمایش روی نقشه</button>
        <button class="link-btn" data-act="copy-meet">کپی مختصات</button>
      </div>
      <p class="hint">نشانگر 🤝 را روی نقشه بکشید تا هر جای دیگری را هم بسنجید. «وقت اضافه» یعنی چقدر بیشتر از رفتن مستقیم${m.settings.includeWait ? '، با معطلی' : ''}.</p>
    </div>`;
  }
  $('#meetResult').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.opt !== undefined) showOption(b.dataset.opt === 'manual' ? 'manual' : +b.dataset.opt);
    else if (b.dataset.act === 'zoom-meet') save(true).then(() => fitMeeting(true));
    else if (b.dataset.act === 'copy-meet') {
      const p = shownOption().p;
      navigator.clipboard?.writeText(fmtCoord(p)).then(() => toast('مختصات کپی شد'), () => toast(fmtCoord(p)));
    }
  });

  $('#meetBtn').addEventListener('click', runMeeting);
  $('#meetCancel').addEventListener('click', () => meetAbort?.abort());
  const OBJ_HINT = {
    sum: 'جمع وقتی که همه روی هم بیشتر در راهند کمترین شود.',
    max: 'به هیچ‌کس خیلی سخت نگذرد: بیشترین وقت اضافهٔ یک نفر کمترین شود.',
  };
  const PREC_LABEL = { fast: 'سریع', normal: 'معمولی', precise: 'دقیق' };
  function renderMeetSettings() {
    const st = state.settings;
    $(`input[name="objective"][value="${st.objective}"]`).checked = true;
    $(`input[name="precision"][value="${st.precision}"]`).checked = true;
    $('#includeWait').checked = st.includeWait;
    $('#objectiveHint').textContent = OBJ_HINT[st.objective];
    $('#meetSummary').textContent = `${st.objective === 'max' ? 'عادلانه' : 'کمترین وقت کل'}، ${st.includeWait ? 'با معطلی' : 'بدون معطلی'}، ${PREC_LABEL[st.precision]}`;
  }
  $('#meetSettings').addEventListener('change', (e) => {
    const st = state.settings;
    if (e.target.name === 'objective') st.objective = e.target.value;
    else if (e.target.name === 'precision') st.precision = e.target.value;
    else if (e.target.id === 'includeWait') st.includeWait = e.target.checked;
    save(); renderMeetSettings(); renderMeetEstimate();
  });

  // ---------------------------------------------------------------- panel, tabs, header
  function openPanel() {
    $('#panel').hidden = false;
    $('#launcher').hidden = true;
    if (!state.settings.panelOpen) { state.settings.panelOpen = true; save(); }
  }
  function closePanel() {
    $('#panel').hidden = true;
    $('#launcher').hidden = false;
    endPick();
    if (state.settings.panelOpen) { state.settings.panelOpen = false; save(); }
  }
  $('#launcher').addEventListener('click', openPanel);
  $('#closeBtn').addEventListener('click', closePanel);
  onToggle(() => ($('#panel').hidden ? openPanel() : closePanel()));

  function switchTab(name) {
    $$('.tab').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
    $$('.tab-body').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
    if (name === 'compare') renderCompare();
    if (name === 'meet') renderMeetPeople();
    if (activeTab !== name) { activeTab = name; redraw(); }
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  function renderSide() {
    if (!$('#tab-compare').hidden) renderCompare();
    renderMeetPeople();
  }

  $('#addTripBtn').addEventListener('click', () => {
    const t = addTrip();
    const name = cardEl(t.id)?.querySelector('input[data-f="name"]');
    name?.focus();
    name?.select(); // type the name straight away
  });
  $('#linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#linkInput').value.trim();
    if (!v) return;
    if (addTripsFromLink(v)) $('#linkInput').value = '';
    else toast('این لینک مسیر نشان نیست. لینکی شبیه neshan.org/maps/routing/… لازم است.', { error: true });
  });

  // The route currently open in Neshan's own routing panel (from the page URL).
  let lastPath = '';
  function syncFromNeshan() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const cur = P.currentRoute();
    $('#fromNeshan').hidden = !cur;
    if (cur) $('#fromNeshan span').textContent = `مسیرِ ${MODES[cur.mode].label} که الان در ${P.siteName} باز است:`;
  }
  setInterval(syncFromNeshan, 700);
  $('#fromNeshanBtn').addEventListener('click', () => {
    if (addTripsFromLink(location.href)) toast(`مسیر ${P.siteName} اضافه شد`);
  });

  $('#moreBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#moreMenu').hidden = !$('#moreMenu').hidden; });
  R.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('#moreMenu').hidden = true; });
  $('#moreMenu').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    $('#moreMenu').hidden = true;
    if (act === 'fit') save(true).then(() => fitAll(true));
    else if (act === 'export') exportFile();
    else if (act === 'import') $('#importFile').click();
    else if (act === 'clear' && confirm('همهٔ مسیرها پاک شوند؟')) {
      rt.clear();
      state.trips = []; state.meeting = null;
      save(); renderTrips(); renderMeetResult(); redraw();
    }
  });

  function exportFile() {
    const trips = state.trips.map(({ cache, ...t }) => t);
    const data = { app: 'neshan-routes', version: 1, trips };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `routes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const validPt = (p) => p == null || (typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'neshan-routes' || !Array.isArray(data.trips)) throw new Error('bad');
      const pt = (p) => p && { lat: p.lat, lng: p.lng, label: String(p.label || fmtCoord(p)).slice(0, 200) };
      rt.clear();
      state.trips = []; state.meeting = null;
      for (const t of data.trips.filter((x) => validPt(x.origin) && validPt(x.dest) && MODES[x.mode])) {
        const trip = newTrip({
          mode: t.mode, origin: pt(t.origin), dest: pt(t.dest),
          depart: /^\d{1,2}:\d{2}$/.test(t.depart || '') ? t.depart : '', inMeeting: t.inMeeting !== false,
          avoid: { trafficZone: !!t.avoid?.trafficZone, oddEven: !!t.avoid?.oddEven, toll: !!t.avoid?.toll },
        });
        if (String(t.name || '').trim()) trip.name = String(t.name).trim().slice(0, 40);
        if (COLORS.includes(t.color)) trip.color = t.color;
        state.trips.push(trip);
      }
      save(); renderTrips(); renderMeetResult();
      await Promise.all(state.trips.map(routeTrip));
      fitAll();
      toast(`${fa(state.trips.length)} مسیر بارگذاری شد`);
    } catch {
      toast('این فایل قابل خواندن نیست.', { error: true });
    }
  });

  onPacing(() => {
    state.settings.routeGap = { gap: routeGap(), at: Date.now() };
    save();
  });

  // ---------------------------------------------------------------- boot
  (async () => {
    const saved = await store.get(STORAGE_KEY);
    if (saved?.trips) state.trips = saved.trips.filter((t) => t && MODES[t.mode]);
    if (saved?.settings) Object.assign(state.settings, saved.settings);
    if (saved?.meeting) state.meeting = saved.meeting;
    if (await store.get('openPanel')) { state.settings.panelOpen = true; store.remove('openPanel'); }
    const learnt = state.settings.routeGap;
    if (learnt?.gap && Date.now() - learnt.at < GAP_MEMORY_MS) setRouteGap(learnt.gap);
    if (!PREC_LABEL[state.settings.precision]) state.settings.precision = 'normal';
    renderMeetSettings();
    if (state.settings.panelOpen) openPanel(); else closePanel();
    syncFromNeshan();
    renderTrips();
    renderMeetResult();
    await Promise.all(state.trips.map(routeTrip));
    redraw();
  })();

  // Test hook (used by the automated browser tests).
  window.__routes = {
    provider: P,
    state, runtime, setPoint, routeTrip, runMeeting, switchTab, addTripsFromLink, fitAll, nm, root: R,
    get requestCount() { return requestCount; },
  };
}
