// Test-only stand-in for neshan.org's API (bundled into dist-test builds, never into releases).
// Active only when localStorage 'nr-fake' is '1' on neshan.org.
// Answers in Neshan's real wire formats so the app's decoders are exercised:
// base64 fields, the shuffled `value` param, scrambled polylines, 28-char wrapped payloads.
// Routes are L-shaped (two alternatives per request) with per-mode speeds.
import { setFetch, setPacing, clearRouteCache } from '../../src/lib/neshan.js';

const b64 = (s) => {
  let bin = '';
  for (const x of new TextEncoder().encode(s)) bin += String.fromCharCode(x);
  return btoa(bin);
};
const swapEnds = (s) => (s.length > 1 ? s[s.length - 1] + s.slice(1, -1) + s[0] : s);
const encNum = (v) => {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
  return out + String.fromCharCode(n + 63);
};
const encPoly = (pts) => {
  let la = 0, lo = 0, out = '';
  for (const [lat, lng] of pts) {
    const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5);
    out += encNum(a - la) + encNum(b - lo);
    la = a; lo = b;
  }
  return out;
};
const geom = (pts) => swapEnds(b64(swapEnds(encPoly(pts))));
const rad = (x) => (x * Math.PI) / 180;
const hav = (a, b) => {
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(s));
};
const SPEED = { CAR: 8, MOTOR: 9, PEDESTRIAN: 1.3, BIKE: 4 };

function route(o, d, mode, variant) {
  const c = variant ? { lat: o.lat, lng: d.lng } : { lat: d.lat, lng: o.lng };
  const dist = Math.round(hav(o, c) + hav(c, d));
  const du = Math.round(dist / (SPEED[mode] || 8)) + 20 + variant * 40;
  const pts = [[o.lat, o.lng], [c.lat, c.lng], [d.lat, d.lng]];
  const step = (name) => ({ n: b64(name), rd: b64(String(dist)), du: b64(String(du)), ds: b64('x'), l: [o.lng, o.lat], g: geom(pts) });
  return {
    du: b64(String(du)),
    ds: b64(`${(dist / 1000).toFixed(1)} کیلومتر`),
    lg: [{ s: b64(variant ? 'بلوار آزمایشی - خیابان دوم' : 'خیابان آزمایشی'), ds: b64('x'), rd: b64(String(dist)), du: b64(String(du)), st: [step('خیابان یک')] }],
  };
}
// public transport: walk -> bus line -> walk, as Neshan's bus-routing encodes it
const KEY = new TextEncoder().encode('https://rajman.org');
const xorB64 = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b, i) => { bin += String.fromCharCode(b ^ KEY[i % KEY.length]); });
  return btoa(bin);
};
function transitRoute(o, d, line, type) {
  const a = { lat: o.lat + (d.lat - o.lat) * 0.05, lng: o.lng + (d.lng - o.lng) * 0.05 };
  const b = { lat: o.lat + (d.lat - o.lat) * 0.95, lng: o.lng + (d.lng - o.lng) * 0.95 };
  const seg = (t, from, to, extra = {}) => ({
    section: { type: t, distance: t === 'walk' ? hav(from, to) : 0 }, travel_time: 0, cost: t === 'walk' ? 0 : 3640,
    path: { list: [{ path: [from, to], metadata: { strokeColor: '#00D46A' } }] },
    end: { ...to, unique_id: t === 'walk' ? 'ایستگاه آزمایشی' : 'ایستگاه پایانی' }, line_name: null, station_between: null, ...extra,
  });
  return [seg('walk', o, a), seg(type, a, b, { line_name: line, station_between: 9 }), seg('walk', b, d), { section: null }];
}

const wrap = (obj) => `${'x'.repeat(28)}${b64(JSON.stringify(obj))}@0${'y'.repeat(28)}`;

export const stats = { routing: 0, search: 0, address: 0 };
const recent = [];

async function fakeFetch(url) {
  const u = new URL(url);
  await new Promise((r) => setTimeout(r, 15));
  if (u.pathname.endsWith('/vehicle-routing/')) {
    stats.routing++;
    // optional: behave like a rate limiter allowing `max` routing requests per `windowMs`
    const lim = globalThis.__fakeRateLimit;
    if (lim) {
      const now = Date.now();
      recent.push(now);
      while (recent.length && recent[0] < now - lim.windowMs) recent.shift();
      if (recent.length > lim.max) {
        stats.limited = (stats.limited || 0) + 1;
        return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      }
    }
    const v = u.searchParams.get('value');
    const [o, d] = JSON.parse(atob(v.slice(0, 5) + v.slice(-5) + v.slice(5, -5)));
    const mode = u.searchParams.get('type');
    const body = { res: { error: 0, data: { s: 'Ok', r: [route(o, d, mode, 0), route(o, d, mode, 1)] } } };
    return new Response(JSON.stringify(body), { status: 200 });
  }
  if (u.pathname.endsWith('/bus-routing/')) {
    stats.routing++;
    const q = (k) => Number(u.searchParams.get(k));
    const o = { lat: q('p1'), lng: q('p2') }, d = { lat: q('p3'), lng: q('p4') };
    return new Response(JSON.stringify({ code: 0, data: xorB64([transitRoute(o, d, 'BRT1', 'BRT'), transitRoute(o, d, '4', 'metro')]), messages: [] }));
  }
  if (u.pathname.includes('suggestion-v2')) {
    stats.search++;
    const term = JSON.parse(decodeURIComponent(atob(decodeURIComponent(u.searchParams.get('data'))))).term;
    return new Response(wrap({ items: [
      { title: term, type: 'KEYWORD' },
      { title: `${term} (آزمایشی)`, subtitle: 'محله تست', type: 'NON_POI', metadata: { location: { x: 51.3913, y: 35.7006 } } },
    ] }));
  }
  if (u.pathname.includes('location-to-address')) {
    stats.address++;
    return new Response(wrap({ formatted_address: `نشانی آزمایشی ${u.searchParams.get('lat').slice(0, 7)}` }));
  }
  return new Response('', { status: 404 });
}

export function install() {
  clearRouteCache();
  setFetch(fakeFetch);
  setPacing({ gap: 0, cooldown: 0 });
  globalThis.__fakeStats = stats;
  return true;
}

let on = false;
try { on = localStorage.getItem('nr-fake') === '1'; } catch { /* storage blocked */ }
if (on) install();
