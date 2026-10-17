import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseRoutes, unwrap, encodeRoutingValue, b64ToUtf8, neshanUrl, parseNeshanUrl, parseLatLng,
  getRoutes, setFetch, clearRouteCache, NeshanError, setRequestTimeout, setMaxConcurrent, setPacing, parseTransit,
  routeGap, setRouteGap,
} from '../src/lib/neshan.js';
import { haversine, offset, sharedLength } from '../src/lib/geo.js';
import {
  parseGoogleDirections, parseGoogleSearch, parseGoogleUrl, googleUrl, directionsPb, getGoogleRoutes, clearGoogleCache, googleSearch,
} from '../src/lib/google.js';
import { findMeetingPoint, evaluateMeetingPoint, scoreLegs } from '../src/lib/meet.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('encodeRoutingValue matches the neshan.org shuffle', () => {
  const v = encodeRoutingValue({ lat: 35.7036, lng: 51.3966 }, { lat: 35.710118, lng: 51.401749 });
  // undo the shuffle and decode
  const orig = v.slice(0, 5) + v.slice(v.length - 5) + v.slice(5, v.length - 5);
  assert.deepEqual(JSON.parse(b64ToUtf8(orig)), [{ lat: 35.7036, lng: 51.3966 }, { lat: 35.710118, lng: 51.401749 }]);
});

test('parse a real pedestrian response (2 alternatives)', () => {
  const routes = parseRoutes(JSON.parse(fx('route_pedestrian.json')));
  assert.equal(routes.length, 2);
  const [r] = routes;
  assert.equal(r.duration, 826);
  assert.equal(r.distance, 1142);
  assert.match(r.summary, /خیابان انقلاب/);
  // geometry starts near the origin and ends near the destination
  const first = { lat: r.coords[0][0], lng: r.coords[0][1] };
  const last = { lat: r.coords.at(-1)[0], lng: r.coords.at(-1)[1] };
  assert.ok(haversine(first, { lat: 35.7036, lng: 51.3966 }) < 60);
  assert.ok(haversine(last, { lat: 35.710118, lng: 51.401749 }) < 60);
  // polyline length should be close to the reported distance
  let len = 0;
  for (let i = 1; i < r.coords.length; i++) len += haversine({ lat: r.coords[i - 1][0], lng: r.coords[i - 1][1] }, { lat: r.coords[i][0], lng: r.coords[i][1] });
  assert.ok(Math.abs(len - r.distance) / r.distance < 0.1, `poly ${len} vs ${r.distance}`);
  assert.ok(r.steps.length > 3 && r.steps[0].name.length > 0);
});

test('parse a real car response', () => {
  const [r] = parseRoutes(JSON.parse(fx('route_car.json')));
  assert.equal(r.duration, 236);
  assert.equal(r.distance, 1535);
  assert.ok(r.coords.length > 20);
});

test('parse a real public-transport response (BRT, bus, metro)', () => {
  const routes = parseTransit(JSON.parse(fx('route_transit.json')));
  assert.equal(routes.length, 2);
  const [r] = routes;
  assert.equal(r.summary, 'BRT7، بعد BRT1');
  assert.equal(r.transit.fare, 7280);
  assert.deepEqual(r.transit.segments.map((g) => g.type), ['walk', 'BRT', 'walk', 'BRT', 'walk']);
  assert.equal(r.transit.segments[1].stops, 12);
  // Neshan gives no times here; the estimate must be plausible for ~8 km across Tehran
  assert.ok(r.duration > 20 * 60 && r.duration < 70 * 60, `${r.duration / 60} min`);
  const ll = (c) => ({ lat: c[0], lng: c[1] });
  assert.ok(haversine(ll(r.coords[0]), { lat: 35.7572, lng: 51.4099 }) < 60);
  assert.ok(haversine(ll(r.coords.at(-1)), { lat: 35.7006, lng: 51.3913 }) < 60);
  assert.match(routes[1].summary, /مترو 4/);
  assert.throws(() => parseTransit({ code: 0, data: null }), (e) => e.kind === 'noroute');
});

test('public transport asks bus-routing with p1..p4', async () => {
  let url = '';
  setFetch(async (u) => { url = u; return { ok: true, status: 200, text: async () => fx('route_transit.json') }; });
  clearRouteCache();
  const r = await getRoutes({ mode: 'PUBLIC_TRANSPORTATION', origin: { lat: 35.7572, lng: 51.4099 }, dest: { lat: 35.7006, lng: 51.3913 } });
  assert.match(url, /bus-routing\/\?p1=35\.7572&p2=51\.4099&p3=35\.7006&p4=51\.3913/);
  assert.equal(r[0].transit.fare, 7280);
  setFetch((...a) => fetch(...a));
});

test('parseRoutes reports no-route and junk', () => {
  assert.throws(() => parseRoutes({ res: { data: { s: 'NoRoute', r: [] } } }), (e) => e.kind === 'noroute');
  assert.throws(() => parseRoutes({ res: { error: 1, message: ['x'] } }), NeshanError);
});

test('unwrap search + address payloads', () => {
  const s = unwrap(fx('search.txt'));
  assert.ok(s.items.some((i) => i.title.includes('میدان انقلاب') && i.metadata?.location));
  const a = unwrap(fx('address.txt'));
  assert.ok(a.formatted_address.length > 3);
});

test('neshan links round-trip', () => {
  const u = neshanUrl('PEDESTRIAN', { lat: 35.7036, lng: 51.3966 }, { lat: 35.710118, lng: 51.401749 });
  assert.equal(u, 'https://neshan.org/maps/routing/pedestrian/origin/35.703600,51.396600/destination/35.710118,51.401749');
  const p = parseNeshanUrl(u + '#c35.707-51.399-15z-0p');
  assert.equal(p.mode, 'PEDESTRIAN');
  assert.equal(p.dest.lng, 51.401749);
  assert.equal(parseNeshanUrl('https://neshan.org/maps/routing/motor/origin/1,2/destination/3,4').mode, 'MOTOR');
  assert.equal(parseNeshanUrl('https://example.com'), null);
});

test('parseLatLng accepts Persian digits', () => {
  assert.deepEqual(parseLatLng('۳۵٫۷'.replace('٫', '.') + '، ۵۱.۴'), { lat: 35.7, lng: 51.4 });
  assert.deepEqual(parseLatLng('35.70 51.4'), { lat: 35.7, lng: 51.4 });
  assert.equal(parseLatLng('میدان'), null);
  assert.equal(parseLatLng('200,10'), null);
});

test('getRoutes caches, retries 5xx, and does not cache failures', async () => {
  const body = fx('route_car.json');
  let n = 0;
  setFetch(async () => {
    n++;
    if (n === 1) return { ok: false, status: 502, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  });
  clearRouteCache();
  const args = { mode: 'CAR', origin: { lat: 35.70, lng: 51.40 }, dest: { lat: 35.71, lng: 51.41 } };
  const r1 = await getRoutes(args);
  const r2 = await getRoutes(args);
  assert.equal(n, 2); // one 502 + one success, second call cached
  assert.equal(r1, r2);

  setFetch(async () => ({ ok: false, status: 400, text: async () => '' }));
  const bad = { ...args, dest: { lat: 1, lng: 1 } };
  await assert.rejects(getRoutes(bad));
  let ok = 0;
  setFetch(async () => { ok++; return { ok: true, status: 200, text: async () => body }; });
  await getRoutes(bad); // retried after failure, not served from cache
  assert.equal(ok, 1);
  setFetch((...a) => fetch(...a));
});

test('a stalled request times out and is retried', async () => {
  const body = fx('route_car.json');
  let n = 0;
  setRequestTimeout(100);
  setFetch((url, { signal }) => {
    n++;
    if (n === 1) return new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('t', 'AbortError'))));
    return Promise.resolve({ ok: true, status: 200, text: async () => body });
  });
  clearRouteCache();
  const r = await getRoutes({ mode: 'CAR', origin: { lat: 1, lng: 2 }, dest: { lat: 3, lng: 4 } });
  assert.equal(n, 2);
  assert.equal(r[0].duration, 236);
  setRequestTimeout(15000);
  setFetch((...a) => fetch(...a));
});

test('never more than maxConcurrent requests in flight', async () => {
  const body = fx('route_car.json');
  let inFlight = 0, peak = 0;
  setMaxConcurrent(3);
  setPacing({ gap: 0 });
  setFetch(async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    inFlight--;
    return { ok: true, status: 200, text: async () => body };
  });
  clearRouteCache();
  await Promise.all(Array.from({ length: 40 }, (_, i) => getRoutes({ mode: 'CAR', origin: { lat: i, lng: 0 }, dest: { lat: 0, lng: i } })));
  assert.equal(peak, 3);
  setPacing({ gap: 150 });
  setFetch((...a) => fetch(...a));
});

test('request starts are spaced out', async () => {
  const body = fx('route_car.json');
  const starts = [];
  setFetch(async () => { starts.push(Date.now()); return { ok: true, status: 200, text: async () => body }; });
  clearRouteCache();
  await Promise.all(Array.from({ length: 6 }, (_, i) => getRoutes({ mode: 'CAR', origin: { lat: 10 + i, lng: 0 }, dest: { lat: 0, lng: 1 } })));
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 140, `gap ${starts[i] - starts[i - 1]}`);
  setFetch((...a) => fetch(...a));
});

test('429 pauses all requests (Retry-After) and then gives a clear rate-limit error', async () => {
  const body = fx('route_car.json');
  const r429 = { ok: false, status: 429, text: async () => '', headers: { get: (h) => (h === 'retry-after' ? '1' : null) } };
  let n = 0;
  setFetch(async () => (++n === 1 ? r429 : { ok: true, status: 200, text: async () => body, headers: { get: () => null } }));
  clearRouteCache();
  const t0 = Date.now();
  await getRoutes({ mode: 'CAR', origin: { lat: 20, lng: 0 }, dest: { lat: 0, lng: 2 } });
  assert.equal(n, 2);
  assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');

  setFetch(async () => r429);
  clearRouteCache();
  await assert.rejects(getRoutes({ mode: 'CAR', origin: { lat: 21, lng: 0 }, dest: { lat: 0, lng: 2 } }), (e) => e.kind === 'ratelimit');
  setPacing({ cooldown: 0 });
  setFetch((...a) => fetch(...a));
});

test('learnt route pace can be restored and is bounded', () => {
  const g = routeGap();
  setRouteGap(4500);
  assert.equal(routeGap(), 4500);
  setRouteGap(60000);
  assert.equal(routeGap(), 10000);
  setRouteGap(1);
  assert.ok(routeGap() >= 0 && routeGap() < 1000);
  setRouteGap(g);
});

test('403 (blocked) is not retried and gives a plain explanation', async () => {
  let n = 0;
  setFetch(async () => { n++; return { ok: false, status: 403, text: async () => '', headers: { get: () => null } }; });
  clearRouteCache();
  await assert.rejects(getRoutes({ mode: 'CAR', origin: { lat: 22, lng: 0 }, dest: { lat: 0, lng: 2 } }),
    (e) => e.kind === 'ratelimit' && /۴۰۳/.test(e.message));
  assert.equal(n, 1);
  setPacing({ cooldown: 0 });
  setFetch((...a) => fetch(...a));
});

// ---------- optimiser on a synthetic "city" where travel time = straight-line distance / speed

const SPEED = { CAR: 10, PEDESTRIAN: 1.4 };
function fakeRouter(t, from, to) {
  const d = haversine(from, to);
  return Promise.resolve({ duration: d / SPEED[t.mode], distance: d, coords: [[from.lat, from.lng], [to.lat, to.lng]] });
}
async function mkTrip(id, mode, origin, dest, departSec = 0) {
  const t = { id, mode, origin, dest, departSec };
  t.base = await fakeRouter(t, origin, dest);
  return t;
}

test('a rate limit ends the meeting search with the best point so far (partial)', async () => {
  const X = { lat: 35.7, lng: 51.4 };
  const trips = await Promise.all([
    mkTrip('a', 'CAR', offset(X, 2000, 270), offset(X, 2000, 90)),
    mkTrip('b', 'CAR', offset(X, 2000, 180), offset(X, 2000, 0)),
  ]);
  // Every real request is refused; requests still in flight must be cancelled.
  const signals = [];
  const limited = (t, f, to, signal) => {
    signals.push(signal);
    if (signals.length === 1) return Promise.reject(new NeshanError('slow down', 'ratelimit'));
    return new Promise((_, rej) => signal.addEventListener('abort', () => rej(new NeshanError('x', 'aborted'))));
  };
  const res = await findMeetingPoint({ trips, router: limited });
  assert.equal(res.partial, true);
  // points on both routes need no requests, so the crossing is still found
  assert.ok(haversine(res.best.p, X) < 40, `${haversine(res.best.p, X)} m from the crossing`);
  assert.ok(signals.length >= 1 && signals.every((s) => s.aborted), 'outstanding requests were cancelled');

  // without route geometry nothing is free: a rate limit is then a plain error
  const bare = trips.map((t) => ({ ...t, base: { ...t.base, coords: [] } }));
  signals.length = 0;
  await assert.rejects(findMeetingPoint({ trips: bare, router: limited }), (e) => e.kind === 'ratelimit');
});

test('points on a person’s own route cost no requests for that person', async () => {
  const X = { lat: 35.7, lng: 51.4 };
  const trips = await Promise.all([
    mkTrip('a', 'CAR', offset(X, 3000, 270), offset(X, 3000, 90)),
    mkTrip('b', 'CAR', offset(X, 3000, 180), offset(X, 3000, 0)),
  ]);
  let calls = 0;
  const router = (...a) => { calls++; return fakeRouter(...a); };
  const onBoth = await findMeetingPoint({ trips, router, maxCalls: 200 });
  assert.ok(haversine(onBoth.best.p, X) < 40);
  const free = onBoth.best.per.every((x) => x.legA.coords.length >= 2 && x.legB.coords.length >= 2);
  assert.ok(free, 'legs carry geometry taken from the routes');
  assert.ok(calls < onBoth.evaluated * 4, `${calls} requests for ${onBoth.evaluated} points`);
});

test('three routes crossing at one point meet at the crossing', async () => {
  const X = { lat: 35.7, lng: 51.4 };
  const trips = await Promise.all([
    mkTrip('a', 'CAR', offset(X, 3000, 270), offset(X, 3000, 90)),
    mkTrip('b', 'CAR', offset(X, 3000, 180), offset(X, 4000, 0)),
    mkTrip('c', 'CAR', offset(X, 3000, 225), offset(X, 2500, 45)),
  ]);
  let calls = 0;
  const router = (...a) => { calls++; return fakeRouter(...a); };
  const res = await findMeetingPoint({ trips, router, objective: 'sum', includeWait: true });
  const d = haversine(res.best.p, X);
  assert.ok(d < 120, `meeting point ${d.toFixed(0)} m from the crossing`);
  assert.ok(res.best.sum < 30, `total extra ${res.best.sum}s`);
  assert.ok(calls <= 150 && res.calls === calls);
});

test('waiting time pulls the meeting point toward the late person', async () => {
  // Same crossing, but b leaves 5 minutes later: with waiting counted, the others
  // should not just sit at the crossing; the result must beat "meet at crossing".
  const X = { lat: 35.7, lng: 51.4 };
  const trips = await Promise.all([
    mkTrip('a', 'CAR', offset(X, 3000, 270), offset(X, 3000, 90)),
    mkTrip('b', 'CAR', offset(X, 3000, 180), offset(X, 3000, 0), 300),
  ]);
  const atX = await evaluateMeetingPoint({ trips, router: fakeRouter, point: X, includeWait: true });
  const res = await findMeetingPoint({ trips, router: fakeRouter, includeWait: true });
  assert.ok(res.best.value <= atX.value + 1, `${res.best.value} vs crossing ${atX.value}`);
  const noWait = await findMeetingPoint({ trips, router: fakeRouter, includeWait: false });
  assert.ok(haversine(noWait.best.p, X) < 120);
});

test('fair objective lowers the worst-off person', async () => {
  const X = { lat: 35.7, lng: 51.4 };
  // Two people share most of a corridor; a third comes from far away.
  const trips = await Promise.all([
    mkTrip('a', 'CAR', offset(X, 4000, 270), offset(X, 4000, 90)),
    mkTrip('b', 'CAR', offset(offset(X, 300, 0), 4000, 270), offset(offset(X, 300, 0), 4000, 90)),
    mkTrip('c', 'CAR', offset(X, 5000, 180), offset(X, 6000, 200)),
  ]);
  const sum = await findMeetingPoint({ trips, router: fakeRouter, objective: 'sum', includeWait: false });
  const fair = await findMeetingPoint({ trips, router: fakeRouter, objective: 'max', includeWait: false });
  assert.ok(fair.best.max <= sum.best.max + 1, `fair max ${fair.best.max} vs sum max ${sum.best.max}`);
  assert.ok(sum.best.sum <= fair.best.sum + 1);
});

test('mixed modes compare in time, not distance', async () => {
  const X = { lat: 35.7, lng: 51.4 };
  // The walker should not be dragged far; the car should come to them.
  const trips = await Promise.all([
    mkTrip('walk', 'PEDESTRIAN', offset(X, 600, 270), offset(X, 600, 90)),
    mkTrip('car', 'CAR', offset(X, 5000, 180), offset(X, 5000, 160)),
  ]);
  const res = await findMeetingPoint({ trips, router: fakeRouter, includeWait: false });
  const walker = res.best.per[0];
  assert.ok(walker.detour < 120, `walker detour ${walker.detour}s`);
});

test('close to brute force on 30 random scenarios', async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const X = { lat: 35.7, lng: 51.4 };
  const rp = () => offset(offset(X, (rnd() - 0.5) * 12000, 0), (rnd() - 0.5) * 12000, 90);
  let worst = 0;
  for (let s = 0; s < 30; s++) {
    const n = 2 + (s % 3);
    const trips = await Promise.all(
      Array.from({ length: n }, (_, i) => mkTrip(`t${i}`, rnd() < 0.2 ? 'PEDESTRIAN' : 'CAR', rp(), rp(), rnd() < 0.3 ? Math.round(rnd() * 600) : 0)),
    );
    const objective = s % 2 ? 'max' : 'sum';
    const includeWait = s % 4 < 2;
    const res = await findMeetingPoint({ trips, router: fakeRouter, objective, includeWait, maxCalls: 40 * n + 30 });
    let brute = Infinity;
    for (let dy = -8000; dy <= 8000; dy += 200) {
      for (let dx = -8000; dx <= 8000; dx += 200) {
        const p = offset(offset(X, dy, 0), dx, 90);
        const ev = await evaluateMeetingPoint({ trips, router: fakeRouter, point: p, objective, includeWait });
        brute = Math.min(brute, ev.value);
      }
    }
    const gap = res.best.value - brute;
    worst = Math.max(worst, gap / Math.max(brute, 60));
    assert.ok(gap <= Math.max(60, brute * 0.1), `scenario ${s} (${n} trips, ${objective}, wait=${includeWait}): ${res.best.value.toFixed(0)} vs brute ${brute.toFixed(0)}`);
  }
});

test('sharedLength of overlapping routes', () => {
  const X = { lat: 35.7, lng: 51.4 };
  const ll = (p) => [p.lat, p.lng];
  const A = [ll(offset(X, 1000, 270)), ll(X), ll(offset(X, 1000, 90))]; // 2 km west-east
  const B = [ll(offset(X, 1000, 180)), ll(X), ll(offset(X, 1000, 90))]; // shares the east km
  const s = sharedLength(A, B);
  assert.ok(Math.abs(s - 1000) < 60, `shared ${s}`);
  assert.equal(sharedLength(A, [ll(offset(X, 5000, 0)), ll(offset(X, 6000, 0))]), 0);
});

test('scoreLegs maths', () => {
  const trips = [{ base: { duration: 100 }, departSec: 0 }, { base: { duration: 100 }, departSec: 50 }];
  const s = scoreLegs(trips, [{ a: 40, b: 70 }, { a: 20, b: 80 }], { includeWait: true });
  // arrivals 40 and 70 -> meet 70; waits 30, 0; detours 10, 0
  assert.equal(s.meet, 70);
  assert.deepEqual(s.per.map((p) => [p.wait, p.detour, p.extra]), [[30, 10, 40], [0, 0, 0]]);
  assert.equal(s.value, 40);
});

test('unreachable candidates are skipped, all-unreachable throws', async () => {
  const X = { lat: 35.7, lng: 51.4 };
  const trips = await Promise.all([
    mkTrip('a', 'CAR', offset(X, 2000, 270), offset(X, 2000, 90)),
    mkTrip('b', 'CAR', offset(X, 2000, 180), offset(X, 2000, 0)),
  ]);
  // Every point needing a real request is unreachable: only spots on both routes work.
  const none = () => Promise.reject(new NeshanError('x', 'noroute'));
  const res = await findMeetingPoint({ trips, router: none });
  assert.ok(haversine(res.best.p, X) < 40, 'falls back to the crossing of the routes');
  // A point in a 600 m hole off the routes is skipped, the search still finishes.
  const Y = offset(X, 900, 45);
  const holey = (t, f, to) => (haversine(f, Y) < 600 || haversine(to, Y) < 600 ? none() : fakeRouter(t, f, to));
  assert.ok((await findMeetingPoint({ trips, router: holey })).best);
  // No route geometry and no reachable point: an error.
  const bare = trips.map((t) => ({ ...t, base: { ...t.base, coords: [] } }));
  await assert.rejects(findMeetingPoint({ trips: bare, router: none }));
});

// ---------- Google Maps (recorded responses of google.com/maps' own web app)

test('Google: parse a car route (Tehran)', () => {
  const alts = parseGoogleDirections(fx('google_drive.txt'), 'CAR');
  assert.equal(alts.length, 3);
  assert.deepEqual(alts.labels, ['KitchenMarket', 'انتشارات فلفل قرمز Felfel Ghermez Publications']);
  const [r] = alts;
  assert.equal(r.distance, 9485);
  assert.ok(r.duration > 25 * 60 && r.duration < 60 * 60);
  assert.match(r.summary, /کردستان/);
  const ll = (c) => ({ lat: c[0], lng: c[1] });
  assert.ok(haversine(ll(r.coords[0]), { lat: 35.7572, lng: 51.4099 }) < 150);
  assert.ok(haversine(ll(r.coords.at(-1)), { lat: 35.7006, lng: 51.3913 }) < 150);
  assert.equal(r.transit, undefined);
});

test('Google: parse public transport (real times, lines, stops, fare)', () => {
  const [r] = parseGoogleDirections(fx('google_transit.txt'), 'PUBLIC_TRANSPORTATION');
  assert.equal(r.summary, 'U8، بعد U7');
  assert.equal(r.transit.estimated, false);
  assert.match(r.transit.fareText, /€/);
  const rides = r.transit.segments.filter((g) => g.type === 'transit');
  assert.deepEqual(rides.map((g) => [g.line, g.from, g.to]), [['U8', 'Alexanderplatz', 'Hermannplatz'], ['U7', 'Hermannplatz', 'Eisenacher Str.']]);
});

test('Google: empty answer and blocked page', () => {
  const empty = `)]}'${String.fromCharCode(10)}${JSON.stringify([[null, []]])}`;
  assert.throws(() => parseGoogleDirections(empty, 'BIKE'), (e) => e.kind === 'noroute' && /حالت/.test(e.message));
  assert.throws(() => parseGoogleDirections('<html>unusual traffic</html>', 'CAR'), (e) => e.kind === 'ratelimit');
});

test('Google: search results', () => {
  const [p] = parseGoogleSearch(fx('google_search.txt'));
  assert.equal(p.title, 'میدان انقلاب');
  assert.ok(Math.abs(p.lat - 35.701) < 0.01 && Math.abs(p.lng - 51.3915) < 0.01);
});

test('Google: request template carries points, mode and a request id', () => {
  const pb = directionsPb('PUBLIC_TRANSPORTATION', { lat: 35.7572, lng: 51.4099 }, { lat: 35.7006, lng: 51.3913 });
  assert.match(pb, /^!1m4!3m2!3d35\.757200!4d51\.409900!6e2!1m4!3m2!3d35\.700600!4d51\.391300!6e2/);
  assert.match(pb, /!20m5!1e3!/);
  assert.match(pb, /!15m3!1s[A-Za-z0-9_-]{22}!7e81/);
});

test('Google: links both ways', () => {
  const u = googleUrl('PEDESTRIAN', { lat: 35.7572, lng: 51.4099 }, { lat: 35.7006, lng: 51.3913 });
  assert.equal(u, 'https://www.google.com/maps/dir/35.757200,51.409900/35.700600,51.391300/data=!4m2!4m1!3e2');
  assert.deepEqual(parseGoogleUrl(u).origin, { lat: 35.7572, lng: 51.4099 });
  assert.equal(parseGoogleUrl(u).mode, 'PEDESTRIAN');
  // places by name: coordinates come from the data parameter
  const named = 'https://www.google.com/maps/dir/Vanak+Square/Enghelab+Square/@35.7,51.4,13z/data=!4m14!4m13!1m5!1m1!1s0x1:0x2!2m2!1d51.4099!2d35.7572!1m5!1m1!1s0x3:0x4!2m2!1d51.3913!2d35.7006!3e0';
  const n = parseGoogleUrl(named);
  assert.deepEqual([n.origin, n.dest, n.mode], [{ lat: 35.7572, lng: 51.4099 }, { lat: 35.7006, lng: 51.3913 }, 'CAR']);
  assert.equal(parseGoogleUrl('https://www.google.com/maps/@35.7,51.4,12z'), null);
});

test('Google: requests go through the shared pacing and cache', async () => {
  let n = 0;
  setFetch(async (u) => { n++; assert.match(u, /^\/maps\/preview\/directions\?authuser=0&hl=fa&pb=/); return { ok: true, status: 200, text: async () => fx('google_drive.txt') }; });
  clearGoogleCache();
  const a = { mode: 'CAR', origin: { lat: 35.7572, lng: 51.4099 }, dest: { lat: 35.7006, lng: 51.3913 } };
  await getGoogleRoutes(a);
  await getGoogleRoutes(a);
  assert.equal(n, 1);
  setFetch((...x) => fetch(...x));
});

// A signed-in Google session answers our requests with 400 (it wants a per-page token),
// so the extension must never send the user's Google cookies.
test('Google: route and search requests go out without cookies', async () => {
  const seen = [];
  setFetch(async (u, init) => {
    seen.push([u, init?.credentials]);
    return { ok: true, status: 200, text: async () => fx(u.startsWith('/search') ? 'google_search.txt' : 'google_drive.txt') };
  });
  clearGoogleCache();
  await getGoogleRoutes({ mode: 'CAR', origin: { lat: 35.7572, lng: 51.4099 }, dest: { lat: 35.7006, lng: 51.3913 } });
  await googleSearch('میدان تجریش', { lat: 35.8, lng: 51.43 });
  assert.equal(seen.length, 2);
  for (const [u, c] of seen) assert.equal(c, 'omit', u);
  setFetch((...x) => fetch(...x));
});
