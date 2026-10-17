// Meeting-point optimiser.
//
// Every person i travels O_i -> M -> D_i instead of O_i -> D_i. For a candidate M:
//   a_i = travel time O_i -> M,  b_i = travel time M -> D_i,  T0_i = direct trip time
//   arrival_i = depart_i + a_i,  meet = max(arrival_i),  wait_i = meet - arrival_i
//   detour_i  = a_i + b_i - T0_i
//   extra_i   = detour_i (+ wait_i when waiting counts)
// Objective "sum": minimise Σ extra_i.  Objective "max" (fair): minimise max extra_i
// (with a small Σ term to break ties).
//
// Search: (1) score hundreds of candidates (points along every route + a grid) with a
// cheap estimate based on each person's own route geometry; (2) evaluate a handful of
// diverse top candidates with real routing; (3) refine the best with a shrinking
// hexagonal pattern search. Real routing calls are capped by `maxCalls`.

import { haversine, projector, preparePolyline, nearestOnPolyline, samplePolyline, splitAt, bounds, offset, pt } from './geo.js';

const CIRCUITY = 1.35; // road distance / straight-line distance, typical for a city
const ON_ROUTE_M = 25;  // a point this close to someone's own route needs no routing for them

export function scoreLegs(trips, legs, { objective = 'sum', includeWait = true } = {}) {
  const arrivals = trips.map((t, i) => (t.departSec || 0) + legs[i].a);
  const meet = Math.max(...arrivals);
  const per = trips.map((t, i) => {
    const wait = meet - arrivals[i];
    const detour = legs[i].a + legs[i].b - t.base.duration;
    return { ...legs[i], arrival: arrivals[i], wait, detour, extra: detour + (includeWait ? wait : 0) };
  });
  const extras = per.map((p) => p.extra);
  const sum = extras.reduce((x, y) => x + y, 0);
  const value = objective === 'max' ? Math.max(...extras) + 0.05 * sum : sum;
  return { value, meet, per, sum, max: Math.max(...extras) };
}

// Cheap travel-time estimate for O_i -> M and M -> D_i. Each leg takes the more
// optimistic of two guesses: (1) follow the person's own route to the point nearest M,
// then step off it; (2) straight line scaled by this trip's own road circuity.
// `scale` holds per-trip correction factors learnt from real routing (see calibrate()).
export function makeEstimator(trips) {
  const proj = projector(trips.reduce((s, t) => s + t.origin.lat + t.dest.lat, 0) / (2 * trips.length));
  const preps = trips.map((t) => {
    const prep = preparePolyline(t.base.coords.length ? t.base.coords : [[t.origin.lat, t.origin.lng], [t.dest.lat, t.dest.lng]], proj);
    const roadLen = t.base.distance || prep.length;
    const speed = t.base.duration > 0 ? Math.max(0.5, roadLen / t.base.duration) : 5;
    const crow = haversine(t.origin, t.dest);
    const circuity = crow > 50 ? Math.min(2.5, Math.max(1.05, roadLen / crow)) : CIRCUITY;
    return { prep, speed, circuity };
  });
  const scale = trips.map(() => ({ a: 1, b: 1 }));
  const rawLegs = (M) =>
    trips.map((t, i) => {
      const { prep, speed, circuity } = preps[i];
      const n = nearestOnPolyline(prep, M, proj);
      const frac = prep.length > 0 ? n.along / prep.length : 0;
      const off = (CIRCUITY * n.dist) / speed;
      const aRoute = frac * t.base.duration + off;
      const bRoute = (1 - frac) * t.base.duration + off;
      const aCrow = (circuity * haversine(t.origin, M)) / speed;
      const bCrow = (circuity * haversine(M, t.dest)) / speed;
      return { a: Math.min(aRoute, aCrow), b: Math.min(bRoute, bCrow) };
    });
  const legsFor = (M) => rawLegs(M).map((l, i) => ({ a: l.a * scale[i].a, b: l.b * scale[i].b }));
  // Fit per-trip scale factors from exactly evaluated points [{p, per:[{a,b}]}].
  const calibrate = (samples) => {
    trips.forEach((_, i) => {
      for (const k of ['a', 'b']) {
        let num = 0, den = 0;
        for (const s of samples) {
          const est = rawLegs(s.p)[i][k];
          if (est < 30) continue; // too short to say anything
          num += s.per[i][k];
          den += est;
        }
        if (den > 0) scale[i][k] = Math.min(3, Math.max(0.5, num / den));
      }
    });
  };
  return { proj, preps, legsFor, calibrate, scale };
}

export function generateCandidates(trips, est, { gridN = 24 } = {}) {
  const { proj, preps } = est;
  const cands = [];
  for (const { prep } of preps) {
    const step = Math.max(40, Math.min(300, prep.length / 60));
    cands.push(...samplePolyline(prep, step, proj));
  }
  const all = trips.flatMap((t) => t.base.coords.map(pt)).concat(trips.flatMap((t) => [t.origin, t.dest]));
  const b = bounds(all);
  const padLat = (b.n - b.s) * 0.1, padLng = (b.e - b.w) * 0.1;
  for (let i = 0; i <= gridN; i++) {
    for (let j = 0; j <= gridN; j++) {
      cands.push({
        lat: b.s - padLat + ((b.n - b.s + 2 * padLat) * i) / gridN,
        lng: b.w - padLng + ((b.e - b.w + 2 * padLng) * j) / gridN,
      });
    }
  }
  const diag = haversine({ lat: b.s, lng: b.w }, { lat: b.n, lng: b.e });
  return { cands, diag };
}

function pickDiverse(scored, k, minSep) {
  const out = [];
  for (const c of scored) {
    if (out.every((o) => haversine(o.p, c.p) >= minSep)) out.push(c);
    if (out.length >= k) break;
  }
  return out;
}

const ZERO_LEG = { duration: 0, distance: 0, coords: [] };

export async function findMeetingPoint({
  trips, router, objective = 'sum', includeWait = true, signal, onProgress = () => {},
  maxCalls = 150, topK = 5,
}) {
  if (trips.length < 2) throw new Error('حداقل دو مسیر لازم است');
  const opts = { objective, includeWait };
  const est = makeEstimator(trips);
  const { cands, diag } = generateCandidates(trips, est);

  onProgress({ phase: 'estimate', done: 0, total: 1 });
  const scored = cands
    .map((p) => ({ p, est: scoreLegs(trips, est.legsFor(p), opts).value }))
    .sort((x, y) => x.est - y.est);
  const minSep = Math.max(150, diag * 0.04);
  const shortlist = pickDiverse(scored, topK * 4, minSep);

  // Our own controller, so a fatal error (rate limit) can cancel requests still in flight.
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const sig = ac.signal;

  let calls = 0;
  const legCache = new Map();
  const leg = (t, from, to) => {
    if (haversine(from, to) < 15) return Promise.resolve(ZERO_LEG);
    const key = `${t.id}|${from.lat.toFixed(5)},${from.lng.toFixed(5)}|${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
    if (!legCache.has(key)) {
      calls++;
      legCache.set(key, router(t, from, to, sig));
    }
    return legCache.get(key);
  };

  // A point on a person's own route costs them no requests: their legs are the two
  // halves of the route they already have (time split in proportion to distance).
  const onRoute = (i, p) => {
    const t = trips[i];
    const { prep } = est.preps[i];
    if (!t.base.coords?.length || !prep.length) return null;
    const n = nearestOnPolyline(prep, p, est.proj);
    if (n.dist > ON_ROUTE_M) return null;
    const f = n.along / prep.length;
    const [ca, cb] = splitAt(prep, t.base.coords, n.along);
    const dist = t.base.distance || prep.length;
    return [
      { duration: f * t.base.duration, distance: f * dist, coords: ca },
      { duration: (1 - f) * t.base.duration, distance: (1 - f) * dist, coords: cb },
    ];
  };
  const requestsFor = (p) => trips.reduce((n, _, i) => n + (onRoute(i, p) ? 0 : 2), 0);

  const evaluated = [];
  let lastErr = null;
  const evaluate = async (p) => {
    try {
      const res = await Promise.all(trips.map((t, i) => onRoute(i, p) || Promise.all([leg(t, t.origin, p), leg(t, p, t.dest)])));
      const legs = res.map(([A, B]) => ({ a: A.duration, b: B.duration, legA: A, legB: B }));
      const s = { p, ...scoreLegs(trips, legs, opts) };
      evaluated.push(s);
      return s;
    } catch (e) {
      // Being rate limited or cancelled ends the search; anything else just rules this point out.
      if (e?.kind === 'ratelimit') { ac.abort(); throw e; }
      if (e?.kind === 'aborted' || sig.aborted) throw e;
      if (e?.kind !== 'noroute') lastErr = e;
      return null;
    }
  };

  const callsPerPoint = 2 * trips.length;
  const budgetTotal = maxCalls;
  const progress = (phase) => onProgress({ phase, done: Math.min(calls, budgetTotal), total: budgetTotal });
  const evalAll = async (points, phase) =>
    (await Promise.all(points.map((p) => evaluate(p).then((x) => { progress(phase); return x; })))).filter(Boolean);
  // as many of `points` as the remaining request budget allows (at least one)
  const affordable = (points) => {
    const out = [];
    let left = maxCalls - calls;
    for (const p of points) {
      const need = requestsFor(p);
      if (out.length && need > left) break;
      out.push(p);
      left -= need;
    }
    return out;
  };

  // If Neshan keeps saying "too many requests" even after waiting, stop where we are
  // and return the best point found so far (marked partial) instead of failing.
  let stopped = null;
  const guard = async (fn) => {
    if (stopped) return;
    try {
      await fn();
    } catch (e) {
      if (e?.kind === 'ratelimit' && evaluated.length) stopped = e;
      else throw e;
    }
  };

  // 1) real routing for a diverse shortlist from the raw estimate
  //    (if every point of a batch is unreachable, move on to the next batch)
  progress('shortlist');
  let first = [];
  await guard(async () => {
    for (let i = 0; i < shortlist.length && !first.length && calls + 2 <= maxCalls; i += topK) {
      first = await evalAll(affordable(shortlist.slice(i, i + topK).map((c) => c.p)), 'shortlist');
    }
  });
  if (!evaluated.length) throw lastErr || new Error('برای هیچ نقطه‌ای مسیر پیدا نشد');

  // 2) learn how far off the estimate is for each person, re-rank, try new spots
  await guard(async () => {
    est.calibrate(evaluated);
    const rescored = cands
      .map((p) => ({ p, est: scoreLegs(trips, est.legsFor(p), opts).value }))
      .sort((x, y) => x.est - y.est)
      .filter((c) => evaluated.every((e) => haversine(e.p, c.p) >= minSep / 2));
    if (calls + 2 <= maxCalls) await evalAll(affordable(pickDiverse(rescored, 3, minSep / 2).map((c) => c.p)), 'shortlist');
  });
  let best = evaluated.reduce((a, b) => (b.value < a.value ? b : a));

  // 3) hexagonal pattern search around the best point, shrinking on failure
  await guard(async () => {
    let r = Math.max(120, Math.min(minSep / 2, 800));
    let rot = 0;
    for (let iter = 0; iter < 8 && r >= 50; iter++) {
      const ring = [];
      for (let k = 0; k < 6; k++) ring.push(offset(best.p, r, rot + k * 60));
      if (calls + ring.reduce((n, p) => n + requestsFor(p), 0) > maxCalls) break;
      const rs = await evalAll(ring, 'refine');
      const cand = rs.reduce((a, b) => (!a || b.value < a.value ? b : a), null);
      if (cand && cand.value < best.value - 1) best = cand;
      else r /= 2;
      rot = rot ? 0 : 30;
    }
  });
  best = evaluated.reduce((a, b) => (b.value < a.value ? b : a));

  const alternatives = evaluated
    .filter((e) => e !== best)
    .sort((a, b) => a.value - b.value)
    .reduce((acc, e) => {
      if ([best, ...acc].every((o) => haversine(o.p, e.p) >= minSep)) acc.push(e);
      return acc;
    }, [])
    .slice(0, 2);

  onProgress({ phase: 'done', done: budgetTotal, total: budgetTotal });
  return { best, alternatives, calls, evaluated: evaluated.length, candidates: cands.length, partial: !!stopped };
}

// Exact evaluation of one user-chosen point (e.g. after dragging the marker).
export async function evaluateMeetingPoint({ trips, router, point, objective = 'sum', includeWait = true, signal }) {
  const res = await Promise.all(
    trips.map((t) =>
      Promise.all([
        haversine(t.origin, point) < 15 ? ZERO_LEG : router(t, t.origin, point, signal),
        haversine(point, t.dest) < 15 ? ZERO_LEG : router(t, point, t.dest, signal),
      ]),
    ),
  );
  const legs = res.map(([A, B]) => ({ a: A.duration, b: B.duration, legA: A, legB: B }));
  return { p: point, ...scoreLegs(trips, legs, { objective, includeWait }) };
}
