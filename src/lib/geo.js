// Small geometry helpers. Points are {lat, lng}; polylines are arrays of [lat, lng].

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const pt = (ll) => ({ lat: ll[0], lng: ll[1] });

// Local equirectangular projection around a reference latitude (metres).
// Accurate to well under 1% across a city, which is all we need for screening.
export function projector(refLat) {
  const kx = Math.cos(toRad(refLat)) * (Math.PI / 180) * R;
  const ky = (Math.PI / 180) * R;
  return {
    fwd: (p) => [p.lng * kx, p.lat * ky],
    inv: (x, y) => ({ lat: y / ky, lng: x / kx }),
  };
}

// Prepare a polyline for repeated nearest-point queries.
export function preparePolyline(coords, proj) {
  const xy = coords.map((c) => proj.fwd(pt(c)));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }
  return { xy, cum, length: cum[cum.length - 1] || 0 };
}

// Nearest point on a prepared polyline to point p.
// Returns {dist, along} in metres (along = distance from the start along the line).
export function nearestOnPolyline(prep, p, proj) {
  const [px, py] = proj.fwd(p);
  const { xy, cum } = prep;
  if (xy.length === 1) return { dist: Math.hypot(px - xy[0][0], py - xy[0][1]), along: 0 };
  let best = { dist: Infinity, along: 0 };
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1];
    const [bx, by] = xy[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best.dist) best = { dist: d, along: cum[i - 1] + t * Math.sqrt(len2) };
  }
  return best;
}

// Points every `step` metres along a prepared polyline (including both ends).
export function samplePolyline(prep, step, proj) {
  const out = [];
  const { xy, cum, length } = prep;
  if (!xy.length) return out;
  if (length === 0) return [proj.inv(xy[0][0], xy[0][1])];
  let seg = 1;
  for (let s = 0; s <= length + 1e-6; s += step) {
    while (seg < cum.length - 1 && cum[seg] < s) seg++;
    const segLen = cum[seg] - cum[seg - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - cum[seg - 1]) / segLen));
    out.push(proj.inv(xy[seg - 1][0] + t * (xy[seg][0] - xy[seg - 1][0]), xy[seg - 1][1] + t * (xy[seg][1] - xy[seg - 1][1])));
  }
  const last = xy[xy.length - 1];
  out.push(proj.inv(last[0], last[1]));
  return out;
}

// Split a polyline (and its prepared form) at `along` metres from the start.
// Returns [head, tail] as [[lat, lng], ...], both containing the split point.
export function splitAt(prep, coords, along) {
  const { cum } = prep;
  if (coords.length < 2) return [coords.slice(), coords.slice()];
  let seg = 1;
  while (seg < cum.length - 1 && cum[seg] < along) seg++;
  const segLen = cum[seg] - cum[seg - 1] || 1;
  const t = Math.max(0, Math.min(1, (along - cum[seg - 1]) / segLen));
  const [a, b] = [coords[seg - 1], coords[seg]];
  const mid = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return [[...coords.slice(0, seg), mid], [mid, ...coords.slice(seg)]];
}

// Length (metres) of route A that runs within `tol` metres of route B.
export function sharedLength(coordsA, coordsB, tol = 25) {
  if (coordsA.length < 2 || coordsB.length < 2) return 0;
  const proj = projector(coordsA[0][0]);
  const a = preparePolyline(coordsA, proj);
  const b = preparePolyline(coordsB, proj);
  const step = 20;
  const samples = samplePolyline(a, step, proj);
  let near = 0;
  for (const s of samples) if (nearestOnPolyline(b, s, proj).dist <= tol) near++;
  return Math.min(a.length, (near / samples.length) * a.length);
}

export function bounds(points) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of points) {
    s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    w = Math.min(w, p.lng); e = Math.max(e, p.lng);
  }
  return { s, w, n, e };
}

// Point at `dist` metres from p in direction `bearingDeg` (0 = north, clockwise).
export function offset(p, dist, bearingDeg) {
  const b = toRad(bearingDeg);
  const dLat = (dist * Math.cos(b)) / R;
  const dLng = (dist * Math.sin(b)) / (R * Math.cos(toRad(p.lat)));
  return { lat: p.lat + (dLat * 180) / Math.PI, lng: p.lng + (dLng * 180) / Math.PI };
}
