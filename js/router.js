// Weather-constrained route planner.
//
// The planner lays a lattice of candidate waypoints over a corridor around the
// direct line, pulls a forecast for every lattice node, then runs a
// time-dependent shortest-path search. A leg is only allowed if, at the time
// the boat would be on it, the seas never exceed the captain's limit for the
// direction the seas hit the vessel from (relative to its heading).
import { distanceNm, bearingDeg, destinationPoint, interpolate } from './geo.js';

export const M_TO_FT = 3.28084;

// Six sectors of relative wave direction, 0° = seas on the bow, 180° = astern.
// Port and starboard are treated alike.
export const SECTORS = [
  { key: 'head', label: 'Head seas', range: '0–30°' },
  { key: 'bow', label: 'On the bow', range: '30–60°' },
  { key: 'fwdBeam', label: 'Forward of the beam', range: '60–90°' },
  { key: 'aftBeam', label: 'Abaft the beam', range: '90–120°' },
  { key: 'quarter', label: 'On the quarter', range: '120–150°' },
  { key: 'following', label: 'Following seas', range: '150–180°' },
];

// Angle between where the seas come FROM and where the boat is heading, 0..180.
export function relativeAngle(seasFromDeg, headingDeg) {
  const d = ((((seasFromDeg - headingDeg) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

export function sectorIndex(rel) {
  return Math.min(5, Math.floor(rel / 30));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Lattice of layers from start to destination. Layer 0 is the start, the last
// layer is the destination, and each layer in between spans the corridor.
export function buildGrid(start, dest, opts = {}) {
  const D = distanceNm(start, dest);
  const layersCount = opts.layers ?? clamp(Math.round(D / 4), 4, 30);
  const lanes = opts.lanes ?? 6; // lanes either side of the direct line
  const halfWidth = opts.halfWidthNm ?? clamp(D * 0.3, 3, 150);
  const nodes = [];
  const layers = [];
  for (let i = 0; i <= layersCount; i++) {
    const f = i / layersCount;
    const layer = [];
    if (i === 0 || i === layersCount) {
      const p = i === 0 ? start : dest;
      const n = { id: nodes.length, i, j: 0, lat: p.lat, lon: p.lon, fixed: true };
      nodes.push(n);
      layer.push(n);
    } else {
      const c = interpolate(start, dest, f);
      const brg = bearingDeg(c, dest);
      // Narrow the corridor near the ends so lanes fan out from the start
      // and converge on the destination.
      const taper = Math.min(1, 3 * Math.min(f, 1 - f));
      for (let j = -lanes; j <= lanes; j++) {
        const off = (j / lanes) * halfWidth * taper;
        const p = off === 0 ? c : destinationPoint(c, brg + 90, off);
        const n = { id: nodes.length, i, j, lat: p.lat, lon: p.lon, fixed: false };
        nodes.push(n);
        layer.push(n);
      }
    }
    layers.push(layer);
  }
  return { nodes, layers, lanes, distanceNm: D };
}

// Forecast value for node k at unix time t (seconds). Heights interpolate
// linearly between hours; directions use the nearer hour.
export function sample(forecast, k, t) {
  const node = forecast.nodes[k];
  if (!node || !node.sea) return null;
  const { times } = forecast;
  const x = (t - times[0]) / 3600;
  if (x < 0 || x > times.length - 1) return { beyond: true };
  const i0 = Math.floor(x);
  const i1 = Math.min(times.length - 1, i0 + 1);
  const w = x - i0;
  const lerp = (arr) => {
    if (!arr) return null;
    const a = arr[i0];
    const b = arr[i1];
    if (a == null) return b;
    if (b == null) return a;
    return a + (b - a) * w;
  };
  const near = (arr) => (arr ? arr[w < 0.5 ? i0 : i1] : null);
  const hs = lerp(node.waveHeight);
  if (hs == null) return null;
  return {
    hsFt: hs * M_TO_FT,
    seasFrom: near(node.waveDirection),
    periodS: lerp(node.wavePeriod),
    windKt: lerp(node.windSpeed),
    windFrom: near(node.windDirection),
    gustKt: lerp(node.windGust),
  };
}

// Check one leg a->b leaving at t0. Returns the worst sea state on the leg,
// or an infeasible marker with the reason.
export function evaluateLeg(forecast, a, b, t0, vessel) {
  const dist = distanceNm(a, b);
  const hrs = dist / vessel.speedKt;
  const t1 = t0 + hrs * 3600;
  const heading = bearingDeg(a, b);
  const checks = [];
  // Ends of the leg at the times the boat is there, plus both ends at mid-leg.
  // Start and destination may sit in a harbour with no wave data; skip those.
  if (!a.fixed) checks.push([a.id, t0]);
  if (!a.fixed) checks.push([a.id, (t0 + t1) / 2]);
  if (!b.fixed) checks.push([b.id, (t0 + t1) / 2]);
  if (!b.fixed) checks.push([b.id, t1]);
  let worst = null;
  for (const [k, t] of checks) {
    const s = sample(forecast, k, t);
    if (!s) return { ok: false, reason: 'land', dist, hrs, heading };
    if (s.beyond) return { ok: false, reason: 'beyond', dist, hrs, heading };
    const dir = s.seasFrom ?? heading; // no direction: assume worst case, head seas
    const rel = relativeAngle(dir, heading);
    const sec = sectorIndex(rel);
    const limit = vessel.limitsFt[sec];
    const ratio = limit > 0 ? s.hsFt / limit : Infinity;
    const info = { ...s, rel, sector: sec, limitFt: limit, ratio, t };
    if (!worst || ratio > worst.ratio) worst = info;
    if (ratio > 1) return { ok: false, reason: 'seas', dist, hrs, heading, worst };
  }
  return { ok: true, dist, hrs, heading, t1, worst };
}

// Time-dependent search over the lattice for one departure time.
// cost = hours underway + comfort penalty for running close to the limits.
export function planRoute(grid, forecast, departT, vessel, opts = {}) {
  const maxJump = opts.maxJump ?? 2;
  const comfort = opts.comfortWeight ?? 0.6;
  const labels = new Map();
  const stats = { seas: 0, land: 0, beyond: 0 };
  labels.set(grid.layers[0][0].id, { cost: 0, t: departT, prev: null, leg: null });
  for (let i = 0; i < grid.layers.length - 1; i++) {
    const next = grid.layers[i + 1];
    for (const a of grid.layers[i]) {
      const la = labels.get(a.id);
      if (!la) continue;
      for (const b of next) {
        if (!b.fixed && !a.fixed && Math.abs(b.j - a.j) > maxJump) continue;
        if (!b.fixed && !forecast.nodes[b.id]?.sea) continue;
        const r = evaluateLeg(forecast, a, b, la.t, vessel);
        if (!r.ok) {
          stats[r.reason]++;
          continue;
        }
        const ratio = r.worst ? r.worst.ratio : 0;
        const cost = la.cost + r.hrs * (1 + comfort * ratio * ratio);
        const lb = labels.get(b.id);
        if (!lb || cost < lb.cost) {
          labels.set(b.id, { cost, t: r.t1, prev: a, leg: { ...r, from: a, to: b, t0: la.t } });
        }
      }
    }
  }
  const destNode = grid.layers[grid.layers.length - 1][0];
  const end = labels.get(destNode.id);
  if (!end) return { ok: false, stats };
  const legs = [];
  for (let n = destNode, l = end; l.leg; n = l.prev, l = labels.get(n.id)) legs.unshift(l.leg);
  return summarize(legs, departT);
}

// Follow the direct line (centre lane) without any routing, for comparison.
export function evaluateDirect(grid, forecast, departT, vessel) {
  const path = grid.layers.map((layer) => layer.find((n) => n.j === 0));
  const legs = [];
  let t = departT;
  for (let i = 0; i < path.length - 1; i++) {
    const r = evaluateLeg(forecast, path[i], path[i + 1], t, vessel);
    if (!r.ok) return { ok: false, failedLeg: i, reason: r.reason, worst: r.worst, t };
    legs.push({ ...r, from: path[i], to: path[i + 1], t0: t });
    t = r.t1;
  }
  return summarize(legs, departT);
}

function summarize(legs, departT) {
  const distance = legs.reduce((s, l) => s + l.dist, 0);
  const arriveT = legs.length ? legs[legs.length - 1].t1 : departT;
  const maxRatio = legs.reduce((m, l) => Math.max(m, l.worst ? l.worst.ratio : 0), 0);
  return { ok: true, legs: mergeLegs(legs), distanceNm: distance, departT, arriveT, maxRatio };
}

// Join consecutive legs that hold the same heading so the waypoint list reads
// like a passage plan rather than a lattice walk.
function mergeLegs(legs) {
  const out = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(relativeAngle(prev.heading, l.heading)) < 2) {
      prev.to = l.to;
      prev.dist += l.dist;
      prev.hrs += l.hrs;
      prev.t1 = l.t1;
      prev.heading = bearingDeg(prev.from, prev.to);
      if (l.worst && (!prev.worst || l.worst.ratio > prev.worst.ratio)) prev.worst = l.worst;
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

// If the requested departure has no safe route, step forward in time and
// report the earliest departure that works.
export function findEarliestDeparture(grid, forecast, fromT, vessel, opts = {}) {
  const step = (opts.stepHours ?? 3) * 3600;
  const lastT = forecast.times[forecast.times.length - 1];
  for (let t = fromT + step; t < lastT; t += step) {
    const r = planRoute(grid, forecast, t, vessel, opts);
    if (r.ok) return r;
  }
  return null;
}
