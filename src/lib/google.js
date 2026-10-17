// Client for the endpoints google.com/maps' own web app uses (no API key).
// Formats were worked out from the live web app (2026-10). Unofficial: Google can change
// or block them at any time.
//   directions: GET /maps/preview/directions?authuser=0&hl=fa&pb=<template below>
//     response ")]}'\n" + JSON: j[0][0] waypoints (names), j[0][1] routes, j[0][7] geometry
//     (per route: [latE7 deltas, lngE7 deltas, ...]).
//   search:     GET /search?tbm=map&q=...&pb=...  -> ")]}'\n" + JSON, places at item[14].
import { NeshanError, fetchText } from './neshan.js';

const GOOGLE_MODES = { CAR: 0, BIKE: 1, PEDESTRIAN: 2, PUBLIC_TRANSPORTATION: 3 };
// Travel mode in google.com/maps/dir/... links (data=!4m2!4m1!3e<n>)
const LINK_MODE = { CAR: 0, BIKE: 1, PEDESTRIAN: 2, PUBLIC_TRANSPORTATION: 3 };

// A request captured from the web app, with the waypoints and mode as placeholders.
// The !15m3!1s<id> group must stay (public transport needs it); the id can be anything.
const TEMPLATE = '{O}{D}!3m12!1m3!1d25908.462148424842!2d51.2950272!3d35.7370908!2m3!1f0.0!2f0.0!3f0.0!3m2!1i1024!2i768!4f13.1!6m62!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!6m31!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!215b1!216b1!222b1!223b1!234b1!235b1!239b1!246b1!253b1!260b1!262b1!266b1!270b1!271b1!273b1!277b1!281b1!291m0!294b1!302i300!303i100!10b1!12b1!13b1!14b1!16b1!17m1!3e1!20m5!1e{M}!2e3!5e2!6b1!14b1!46m1!1b0!96b1!97m1!2b1!99b1!15m3!1s{ID}!7e81!15i10142!20m28!1m6!1m2!1i0!2i0!2m2!1i530!2i768!1m6!1m2!1i974!2i0!2m2!1i1024!2i768!1m6!1m2!1i0!2i0!2m2!1i1024!2i20!1m6!1m2!1i0!2i748!2m2!1i1024!2i768!27b1!40i799!47m2!8b1!10e2';

const wp = (p) => `!1m4!3m2!3d${p.lat.toFixed(6)}!4d${p.lng.toFixed(6)}!6e2`;
const requestId = () => {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = '';
  for (let i = 0; i < 22; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

export function directionsPb(mode, origin, dest) {
  return TEMPLATE.replace('{O}', wp(origin)).replace('{D}', wp(dest))
    .replace('{M}', String(GOOGLE_MODES[mode] ?? 0)).replace('{ID}', requestId());
}

const BLOCKED_MSG = 'گوگل فعلاً به این درخواست‌ها جواب نمی‌دهد (احتمالاً درخواست‌ها زیاد شده). کمی بعد دوباره امتحان کنید.';

function parseJsonBody(text) {
  if (typeof text !== 'string' || !text.startsWith(")]}'")) throw new NeshanError(BLOCKED_MSG, 'ratelimit');
  try {
    return JSON.parse(text.slice(text.indexOf('\n') + 1));
  } catch {
    throw new NeshanError('پاسخ نامعتبر از گوگل', 'api');
  }
}

const at = (x, ...path) => path.reduce((v, k) => (Array.isArray(v) ? v[k] : undefined), x);
const firstString = (x) => {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) for (const v of x) { const s = firstString(v); if (s) return s; }
  return '';
};
const clean = (s) => String(s || '').replace(/[‎‏‪-‮]/g, '').trim();

function decodeGeometry(g) {
  const lats = at(g, 0) || [], lngs = at(g, 1) || [];
  const out = [];
  let la = 0, lo = 0;
  for (let i = 0; i < Math.min(lats.length, lngs.length); i++) {
    la += lats[i]; lo += lngs[i];
    out.push([la / 1e7, lo / 1e7]);
  }
  return out;
}

export function parseGoogleDirections(text, mode) {
  const j = parseJsonBody(text);
  const routes = at(j, 0, 1) || [];
  if (!routes.length) {
    const msg = mode === 'PUBLIC_TRANSPORTATION' || mode === 'BIKE'
      ? 'گوگل برای این حالت در این منطقه مسیری ندارد'
      : 'گوگل مسیری پیدا نکرد';
    throw new NeshanError(msg, 'noroute');
  }
  const geoms = at(j, 0, 7) || [];
  const labels = (at(j, 0, 0) || []).map((w) => clean(at(w, 0, 1, 1) || at(w, 0, 0, 3) || ''));
  const alts = routes.map((r, i) => {
    const s = r[0] || [];
    const duration = Number(at(s, 10, 0, 0) ?? at(s, 3, 0)) || 0;
    const distance = Number(at(s, 2, 0)) || 0;
    const route = { duration, distance, distanceText: clean(at(s, 2, 1)), summary: clean(s[1]), coords: decodeGeometry(geoms[i]), steps: [] };
    if (mode === 'PUBLIC_TRANSPORTATION') {
      const steps = at(r, 1, 0, 1) || [];
      const segments = steps.map((st) => {
        const x = st[0] || [];
        const walk = x[0] === 2;
        return {
          type: walk ? 'walk' : 'transit',
          coords: [],
          distance: Number(at(x, 2, 0)) || 0,
          duration: Number(at(x, 3, 0)) || 0,
          line: walk ? '' : clean(at(st, 5, 12, 0, 0, 0, 1, 1, 0) || firstString(at(st, 5, 12))),
          from: walk ? '' : clean(at(st, 5, 0, 0)),
          to: walk ? '' : clean(at(st, 5, 1, 0)),
          stops: 0,
          cost: 0,
        };
      });
      const rides = segments.filter((g) => g.type !== 'walk' && g.line);
      route.summary = rides.map((g) => g.line).join('، بعد ') || route.summary;
      route.transit = {
        segments,
        fare: 0,
        fareText: clean(at(s, 11, 1)),
        walk: segments.filter((g) => g.type === 'walk').reduce((a, g) => a + g.distance, 0),
        estimated: false,
      };
    }
    return route;
  });
  alts.labels = labels; // names of origin and destination as Google knows them
  return alts;
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const cache = new Map();
export function clearGoogleCache() { cache.clear(); }
export const googleRouteKey = (mode, o, d) => ['g', mode, round5(o.lat), round5(o.lng), round5(d.lat), round5(d.lng)].join('|');

export function getGoogleRoutes({ mode, origin, dest, signal }) {
  const key = googleRouteKey(mode, origin, dest);
  if (cache.has(key)) return cache.get(key);
  const url = `/maps/preview/directions?authuser=0&hl=fa&pb=${directionsPb(mode, origin, dest)}`;
  const p = (async () => parseGoogleDirections(await fetchText(url, signal, 'route'), mode))();
  cache.set(key, p);
  const drop = () => { if (cache.get(key) === p) cache.delete(key); };
  p.catch(drop);
  signal?.addEventListener('abort', drop, { once: true });
  return p;
}

export function parseGoogleSearch(text) {
  const j = parseJsonBody(text);
  const out = [];
  const seen = new Set();
  const visit = (x, depth) => {
    if (!Array.isArray(x) || depth > 6) return;
    const place = x[14];
    const loc = at(place, 9);
    if (Array.isArray(place) && typeof at(loc, 2) === 'number' && typeof at(loc, 3) === 'number' && typeof place[11] === 'string') {
      const k = `${loc[2].toFixed(5)},${loc[3].toFixed(5)}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ title: clean(place[11]), subtitle: clean(place[18] || place[39] || ''), lat: loc[2], lng: loc[3] });
      }
      return;
    }
    for (const v of x) visit(v, depth + 1);
  };
  visit(j, 0);
  return out;
}

export async function googleSearch(term, center, signal) {
  const pb = `!4m9!1m3!1d30000!2d${center.lng.toFixed(5)}!3d${center.lat.toFixed(5)}!2m0!3m2!1i1400!2i900!4f13.1!7i20!10b1`;
  const text = await fetchText(`/search?tbm=map&authuser=0&hl=fa&q=${encodeURIComponent(term)}&pb=${pb}`, signal, 'other');
  return parseGoogleSearch(text);
}

// ---------- google.com/maps links ----------

const f6 = (x) => Number(x).toFixed(6);
export function googleUrl(mode, o, d) {
  return `https://www.google.com/maps/dir/${f6(o.lat)},${f6(o.lng)}/${f6(d.lat)},${f6(d.lng)}/data=!4m2!4m1!3e${LINK_MODE[mode] ?? 0}`;
}

// The route open in Google Maps: /maps/dir/<a>/<b>/... where a/b are "lat,lng" or names
// whose coordinates are in data=...!1d<lng>!2d<lat>...; the mode is !3e<n>.
export function parseGoogleUrl(url) {
  const s = decodeURIComponent(String(url));
  const m = s.match(/\/maps\/dir\/([^/]+)\/([^/]+)\//);
  if (!m) return null;
  const ll = (t) => { const x = t.match(/^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/); return x ? { lat: +x[1], lng: +x[2] } : null; };
  let origin = ll(m[1]);
  let dest = ll(m[2]);
  const pairs = [...s.matchAll(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g)].map((x) => ({ lat: +x[2], lng: +x[1] }));
  if (!origin && pairs.length >= 2) origin = pairs[0];
  if (!dest && pairs.length >= 2) dest = pairs[pairs.length - 1];
  if (!origin && pairs.length === 1 && dest) origin = pairs[0];
  if (!dest && pairs.length === 1 && origin) dest = pairs[0];
  if (!origin || !dest) return null;
  const mm = s.match(/!3e(\d)/);
  const mode = Object.keys(LINK_MODE).find((k) => LINK_MODE[k] === Number(mm?.[1])) || 'CAR';
  return { mode, origin, dest, names: [m[1], m[2]].map((t) => (ll(t) ? '' : t.replace(/\+/g, ' '))) };
}
