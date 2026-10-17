// Client for the endpoints neshan.org's own web map uses (no API key needed).
// Formats were reverse engineered from the neshan.org/maps bundle (2026-10):
//   routing:  GET pwa-api/vehicle-routing/?type=&value=<shuffled base64 JSON of [{lat,lng},{lat,lng}]>
//             response fields are base64; step geometry is a scrambled Google polyline.
//   search:   GET pwa-api/neshan-search/suggestion-v2?data=<base64(encodeURIComponent(JSON))>
//   address:  GET pwa-api/location-to-address?lat=&lng=
//   search/address responses are base64 wrapped in 28-char padding (see unwrap()).
//   public transport: GET pwa-api/bus-routing/?p1=lat&p2=lng&p3=lat&p4=lng; `data` is
//             base64 XOR-ed with "https://rajman.org" -> routes, each a list of walk/bus/BRT/
//             metro/van segments. Neshan gives no times for these (all 0), so we estimate them.

import { haversine } from './geo.js';

const BASE = 'https://neshan.org/maps/pwa-api/';

export const MODES = {
  CAR: { label: 'خودرو', icon: '🚗', url: 'car' },
  PUBLIC_TRANSPORTATION: { label: 'همگانی', icon: '🚇', url: 'public_transportation' },
  MOTOR: { label: 'موتور', icon: '🛵', url: 'motor' },
  PEDESTRIAN: { label: 'پیاده', icon: '🚶', url: 'pedestrian' },
  BIKE: { label: 'دوچرخه', icon: '🚲', url: 'bike' },
};

export class NeshanError extends Error {
  constructor(message, kind = 'api') {
    super(message);
    this.kind = kind; // 'network' | 'api' | 'noroute' | 'ratelimit' | 'aborted'
  }
}

// ---------- encoding helpers ----------

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToUtf8(s) {
  if (!s || typeof s !== 'string') return '';
  let t = s.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export function encodeRoutingValue(origin, dest) {
  const json = JSON.stringify([
    { lat: origin.lat, lng: origin.lng },
    { lat: dest.lat, lng: dest.lng },
  ]);
  const l = utf8ToB64(json);
  return l.slice(0, 5) + l.slice(10) + l.slice(5, 10);
}

const swapEnds = (s) => (s.length > 1 ? s[s.length - 1] + s.slice(1, -1) + s[0] : s);

// Step geometry: swap first/last char, base64-decode, swap again, then a standard
// precision-5 Google encoded polyline. Returns [[lat, lng], ...].
export function decodeGeometry(g) {
  const t = swapEnds(b64ToUtf8(swapEnds(g || '')));
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < t.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do {
        b = t.charCodeAt(i++) - 63;
        result |= (b & 31) << shift;
        shift += 5;
      } while (b >= 32 && i < t.length);
      const v = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += v; else lng += v;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

// Search/address payload: drop 28 chars at each end; the tail after the last '@' is
// a split index; the body is base64(rest + head).
export function unwrap(e) {
  let i = e.slice(28, e.length - 28);
  const at = i.lastIndexOf('@');
  const o = parseInt(i.slice(at + 1), 10);
  i = i.slice(0, at);
  return JSON.parse(b64ToUtf8(i.slice(o) + i.slice(0, o)));
}

// ---------- response parsing ----------

export function parseRoutes(body) {
  const data = body?.res?.data;
  if (!data || !Array.isArray(data.r)) {
    const msg = body?.res?.message?.join?.(' ') || 'پاسخ نامعتبر از نشان';
    throw new NeshanError(msg, 'api');
  }
  if (data.s && data.s !== 'Ok') throw new NeshanError(`مسیری پیدا نشد (${data.s})`, 'noroute');
  if (!data.r.length) throw new NeshanError('مسیری پیدا نشد', 'noroute');
  return data.r.map((r) => {
    const leg = r.lg[0];
    const coords = [];
    const steps = [];
    for (const st of leg.st || []) {
      const pts = decodeGeometry(st.g);
      for (const p of pts) {
        const last = coords[coords.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) coords.push(p);
      }
      steps.push({
        name: b64ToUtf8(st.n),
        distance: Number(b64ToUtf8(st.rd)) || 0,
        duration: Number(b64ToUtf8(st.du)) || 0,
        location: st.l ? { lat: st.l[1], lng: st.l[0] } : null,
      });
    }
    return {
      duration: Number(b64ToUtf8(r.du || leg.du)) || 0, // seconds
      distance: Number(b64ToUtf8(leg.rd)) || 0, // metres
      distanceText: b64ToUtf8(r.ds || leg.ds),
      summary: b64ToUtf8(leg.s),
      coords,
      steps,
    };
  });
}

// ---------- public transport ----------

// Neshan returns no durations for public transport, so they are estimated:
// average speed including stops, plus an average wait each time you board.
const TRANSIT = {
  walk: { speed: 1.25, wait: 0, label: 'پیاده' },        // 4.5 km/h
  metro: { speed: 8.3, wait: 240, label: 'مترو' },      // 30 km/h, ~4 min wait
  BRT: { speed: 4.7, wait: 240, label: 'BRT' },         // 17 km/h
  bus: { speed: 3.9, wait: 420, label: 'اتوبوس' },      // 14 km/h, ~7 min wait
  van: { speed: 5.0, wait: 300, label: 'ون' },          // 18 km/h
};
const TRANSIT_KEY = new TextEncoder().encode('https://rajman.org');

export function xorDecode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) ^ TRANSIT_KEY[i % TRANSIT_KEY.length];
  return JSON.parse(new TextDecoder('utf-8').decode(out));
}

const lineLength = (coords) => {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversine({ lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] });
  }
  return d;
};

export function transitLineLabel(seg) {
  if (seg.type === 'metro') return `مترو ${seg.line}`.trim();
  if (seg.type === 'bus') return `اتوبوس ${seg.line}`.trim();
  if (seg.type === 'van') return `ون ${seg.line}`.trim();
  return seg.line || TRANSIT[seg.type]?.label || seg.type;
}

export function parseTransit(body) {
  if (!body || typeof body.data !== 'string' || !body.data) {
    if (body && (body.data === null || body.data === '')) throw new NeshanError('مسیر همگانی پیدا نشد', 'noroute');
    throw new NeshanError('پاسخ نامعتبر از نشان', 'api');
  }
  let routes;
  try { routes = xorDecode(body.data); } catch { throw new NeshanError('پاسخ نامعتبر از نشان', 'api'); }
  if (!Array.isArray(routes) || !routes.length) throw new NeshanError('مسیر همگانی پیدا نشد', 'noroute');
  const out = routes.map((r) => {
    const segs = (Array.isArray(r) ? r : []).filter((x) => x && x.section && x.section.type).map((x) => {
      const type = TRANSIT[x.section.type] ? x.section.type : 'bus';
      const coords = (x.path?.list?.[0]?.path || []).filter((q) => typeof q?.lat === 'number').map((q) => [q.lat, q.lng]);
      const distance = lineLength(coords) || Number(x.section.distance) || 0;
      const t = TRANSIT[type];
      return {
        type, coords, distance,
        duration: distance / t.speed + t.wait,
        line: x.line_name || '',
        stops: Number(x.station_between) || 0,
        to: (x.end && typeof x.end === 'object' ? x.end.unique_id : '') || '',
        cost: Number(x.cost) || 0,
      };
    });
    if (!segs.length) return null;
    const coords = [];
    for (const g of segs) for (const c of g.coords) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
    }
    const rides = segs.filter((g) => g.type !== 'walk');
    return {
      duration: segs.reduce((a, g) => a + g.duration, 0),
      distance: segs.reduce((a, g) => a + g.distance, 0),
      distanceText: '',
      summary: rides.map(transitLineLabel).join('، بعد ') || 'پیاده',
      coords,
      steps: [],
      transit: {
        segments: segs,
        fare: segs.reduce((a, g) => a + g.cost, 0),
        walk: segs.filter((g) => g.type === 'walk').reduce((a, g) => a + g.distance, 0),
      },
    };
  }).filter(Boolean);
  if (!out.length) throw new NeshanError('مسیر همگانی پیدا نشد', 'noroute');
  return out;
}

// ---------- request plumbing ----------

// Be polite to neshan.org. Requests go through two lanes:
//  - 'route' (routing): at most 2 in flight, starts at least ROUTE_GAP_MS apart; the gap
//    grows 1.5x after every 429 (up to MAX_ROUTE_GAP_MS) and relaxes again after a run of
//    successes. The app remembers the learnt gap (setRouteGap) so the next search starts
//    at a speed Neshan accepts.
//  - 'other' (search, address): small requests a person triggers by typing.
// After a 429 every request waits out a shared cooldown instead of hitting the server
// again; listeners registered with onPacing() are told so they can show the pause.
const ROUTE_GAP_MS = 900;
const MAX_ROUTE_GAP_MS = 10000;
const lanes = {
  route: { active: 0, queue: [], max: 2, gap: ROUTE_GAP_MS, minGap: ROUTE_GAP_MS, nextStart: 0, okRun: 0 },
  other: { active: 0, queue: [], max: 3, gap: 150, minGap: 150, nextStart: 0, okRun: 0 },
};
let cooldownUntil = 0;
const pacingListeners = new Set();
export function onPacing(cb) { pacingListeners.add(cb); return () => pacingListeners.delete(cb); }
const notifyPause = () => pacingListeners.forEach((cb) => { try { cb({ until: cooldownUntil }); } catch { /* listener bug */ } });

// Test/tuning hooks (apply to both lanes).
export function setMaxConcurrent(n) { for (const l of Object.values(lanes)) l.max = n; }
export function setPacing({ gap, cooldown } = {}) {
  if (gap !== undefined) for (const l of Object.values(lanes)) { l.gap = gap; l.minGap = gap; }
  if (cooldown !== undefined) cooldownUntil = cooldown;
}
export const routeGap = () => lanes.route.gap;
export function setRouteGap(ms) {
  if (Number.isFinite(ms)) lanes.route.gap = Math.max(lanes.route.minGap, Math.min(MAX_ROUTE_GAP_MS, Math.round(ms)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function limited(fn, signal, lane) {
  const L = lanes[lane];
  if (L.active >= L.max) await new Promise((res) => L.queue.push(res)); // slot handed over by finally
  else L.active++;
  try {
    for (;;) {
      if (signal?.aborted) throw new NeshanError('لغو شد', 'aborted');
      const now = Date.now();
      const wait = Math.max(cooldownUntil - now, L.nextStart - now);
      if (wait <= 0) break;
      await sleep(Math.min(wait, 250));
    }
    L.nextStart = Date.now() + L.gap;
    return await fn();
  } finally {
    const next = L.queue.shift();
    if (next) next();
    else L.active--;
  }
}

let REQUEST_TIMEOUT_MS = 15000;
export function setRequestTimeout(ms) { REQUEST_TIMEOUT_MS = ms; }
let fetchImpl = (...a) => fetch(...a);
export function setFetch(f) { fetchImpl = f; }

// The same plumbing serves neshan.org and google.com/maps; messages name the site.
let SERVICE = 'نشان';
export function setServiceName(name) { SERVICE = name; }
const BLOCKED_PAUSE_MS = 60 * 1000;
const blockedMsg = () => `${SERVICE} فعلاً درخواست‌های این اینترنت را رد می‌کند (۴۰۳). اگر خود نقشهٔ ${SERVICE} هم بالا نمی‌آید، مشکل از دسترسی است نه افزونه؛ کمی بعد یا با اینترنت دیگری امتحان کنید.`;
const rateLimitMsg = () => `${SERVICE} موقتاً جلوی درخواست‌های زیاد را گرفته است. چند دقیقه بعد دوباره امتحان کنید.`;
const MAX_429_RETRIES = 3;

async function getText(url, signal, lane = 'other') {
  const L = lanes[lane];
  let lastErr;
  let failures = 0;
  let limitedTimes = 0;
  for (;;) {
    if (signal?.aborted) throw new NeshanError('لغو شد', 'aborted');
    let res;
    try {
      res = await limited(async () => {
        // A stalled connection must not hang a whole meeting search: time out and retry.
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const r = await fetchImpl(url, { signal: sig, headers: { 'Content-Type': 'application/json' } });
        return {
          ok: r.ok, status: r.status, text: r.ok ? await r.text() : '',
          retryAfter: Number(r.headers?.get?.('retry-after')) || 0,
        };
      }, signal, lane);
    } catch (e) {
      if (signal?.aborted) throw new NeshanError('لغو شد', 'aborted');
      lastErr = new NeshanError(`اتصال به ${SERVICE} برقرار نشد`, 'network');
      if (++failures >= 3) throw lastErr;
      await sleep(600 * failures);
      continue;
    }
    if (res.ok) {
      if (++L.okRun >= 8 && L.gap > L.minGap) { L.gap = Math.max(L.minGap, Math.round(L.gap * 0.85)); L.okRun = 0; }
      return res.text;
    }
    if (res.status === 429) {
      // Slow this lane down for good and wait out the pause; give up after a few rounds.
      L.okRun = 0;
      L.gap = Math.min(lane === 'route' ? MAX_ROUTE_GAP_MS : 4000, Math.round(Math.max(L.gap * 1.5, 300)));
      if (++limitedTimes > MAX_429_RETRIES) throw new NeshanError(rateLimitMsg(), 'ratelimit');
      const pause = Math.min(60, res.retryAfter || 10 * 2 ** (limitedTimes - 1)) * 1000;
      cooldownUntil = Math.max(cooldownUntil, Date.now() + pause);
      notifyPause();
      continue;
    }
    if (res.status === 403) {
      // Neshan has blocked this connection: retrying only makes it worse, so stop
      // everything for a while and say so plainly.
      cooldownUntil = Math.max(cooldownUntil, Date.now() + BLOCKED_PAUSE_MS);
      throw new NeshanError(blockedMsg(), 'ratelimit');
    }
    if (res.status >= 500) {
      lastErr = new NeshanError(`خطای سرور ${SERVICE} (${res.status})`, 'api');
      if (++failures >= 3) throw lastErr;
      await sleep(600 * failures);
      continue;
    }
    throw new NeshanError(`خطای ${SERVICE} (${res.status})`, 'api');
  }
}
export const fetchText = getText;

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const routeCache = new Map();
export function clearRouteCache() { routeCache.clear(); }
export const routeCacheSize = () => routeCache.size;
export let requestCount = 0;

export function routeKey(mode, o, d, avoid = {}) {
  return [mode, round5(o.lat), round5(o.lng), round5(d.lat), round5(d.lng),
    avoid.trafficZone ? 1 : 0, avoid.oddEven ? 1 : 0, avoid.toll ? 1 : 0].join('|');
}

// Returns an array of route alternatives (first = Neshan's recommendation).
export function getRoutes({ mode, origin, dest, avoid = {}, signal }) {
  const key = routeKey(mode, origin, dest, avoid);
  if (routeCache.has(key)) return routeCache.get(key);
  const params = new URLSearchParams({
    type: mode,
    value: encodeRoutingValue(origin, dest),
    eta: 'false',
    avoidTrafficZone: String(!!avoid.trafficZone),
    avoidOddEvenZone: String(!!avoid.oddEven),
    avoidToll: String(!!avoid.toll),
  });
  const transit = mode === 'PUBLIC_TRANSPORTATION';
  const url = transit
    ? `${BASE}bus-routing/?${new URLSearchParams({ p1: origin.lat, p2: origin.lng, p3: dest.lat, p4: dest.lng })}`
    : `${BASE}vehicle-routing/?${params}`;
  const p = (async () => {
    requestCount++;
    const text = await getText(url, signal, 'route');
    let body;
    try { body = JSON.parse(text); } catch { throw new NeshanError('پاسخ نامعتبر از نشان', 'api'); }
    return transit ? parseTransit(body) : parseRoutes(body);
  })();
  routeCache.set(key, p);
  // Do not cache failures (or aborted requests) so a retry can succeed.
  const drop = () => { if (routeCache.get(key) === p) routeCache.delete(key); };
  p.catch(drop);
  signal?.addEventListener('abort', drop, { once: true });
  return p;
}

// Fastest alternative only.
export async function getBestRoute(args) {
  const routes = await getRoutes(args);
  return routes.reduce((a, b) => (b.duration < a.duration ? b : a));
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

export async function search(term, center, signal) {
  const payload = { term, center: { x: center.lng, y: center.lat }, location: null, uuid: uuid() };
  const data = utf8ToB64(encodeURIComponent(JSON.stringify(payload)));
  const text = await getText(`${BASE}neshan-search/suggestion-v2?data=${encodeURIComponent(data)}`, signal);
  const json = unwrap(text);
  const items = json?.items || [];
  return items
    .map((it) => {
      const loc = it?.metadata?.location || it?.location;
      if (!loc || typeof loc.x !== 'number') return null;
      return { title: it.title || '', subtitle: it.subtitle || '', lat: loc.y, lng: loc.x };
    })
    .filter(Boolean);
}

export async function reverse(p, signal) {
  const text = await getText(`${BASE}location-to-address?lat=${p.lat}&lng=${p.lng}`, signal);
  const j = unwrap(text);
  return j?.formatted_address || j?.route_name || '';
}

// ---------- neshan.org links ----------

const f6 = (x) => Number(x).toFixed(6);
export function neshanUrl(mode, o, d) {
  return `https://neshan.org/maps/routing/${MODES[mode]?.url || 'car'}/origin/${f6(o.lat)},${f6(o.lng)}/destination/${f6(d.lat)},${f6(d.lng)}`;
}

export function parseNeshanUrl(url) {
  const m = String(url).match(
    /routing\/([a-z_]+)\/origin\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\/destination\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (!m) return null;
  const urlType = m[1].toLowerCase();
  const mode = Object.keys(MODES).find((k) => MODES[k].url === urlType) || 'CAR';
  return {
    mode,
    origin: { lat: +m[2], lng: +m[3] },
    dest: { lat: +m[4], lng: +m[5] },
  };
}

// "35.70, 51.40" (also accepts Persian digits and the Arabic comma).
export function parseLatLng(s) {
  const t = String(s)
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/،/g, ',');
  const m = t.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
