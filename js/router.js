// Weather-constrained route planner.
//
// The planner lays a lattice of candidate waypoints over a corridor around the
// direct line, pulls a forecast for every lattice node, then runs a
// time-dependent shortest-path search. A leg is only allowed if, at the time
// the boat would be on it, neither the seas nor the wind exceed the captain's
// limit for the direction they strike the vessel from (relative to its heading).
import { distanceNm, bearingDeg, destinationPoint, interpolate } from './geo.js';

export const M_TO_FT = 3.28084;

// Eight points of the compass relative to the vessel, clockwise from the bow.
// Each covers 45°, centred on its point (Bow is 337.5°–22.5° off the bow).
export const SECTORS = [
  { key: 'bow', label: 'Bow', short: 'on the bow', range: '0°' },
  { key: 'stbdBow', label: 'Starboard bow', short: 'on the starboard bow', range: '45°' },
  { key: 'stbdBeam', label: 'Starboard beam', short: 'on the starboard beam', range: '90°' },
  { key: 'stbdQtr', label: 'Starboard quarter', short: 'on the starboard quarter', range: '135°' },
  { key: 'stern', label: 'Stern', short: 'astern', range: '180°' },
  { key: 'portQtr', label: 'Port quarter', short: 'on the port quarter', range: '225°' },
  { key: 'portBeam', label: 'Port beam', short: 'on the port beam', range: '270°' },
  { key: 'portBow', label: 'Port bow', short: 'on the port bow', range: '315°' },
];

// Smallest angle between two directions, 0..180.
export function relativeAngle(aDeg, bDeg) {
  const d = ((((aDeg - bDeg) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

// Where something coming FROM fromDeg strikes a boat on headingDeg,
// measured clockwise from the bow, 0..360 (90 = starboard beam).
export function relativeBearing(fromDeg, headingDeg) {
  return (((fromDeg - headingDeg) % 360) + 360) % 360;
}

// Identifies a lattice edge, for depth checks.
export const edgeKey = (a, b) => `${a.id}-${b.id}`;

export function sectorIndex(relBearing) {
  return Math.round(relBearing / 45) % 8;
}

// Compare one forecast value against the limit for the sector it arrives from.
function against(value, fromDeg, heading, limits) {
  const sector = sectorIndex(relativeBearing(fromDeg ?? heading, heading)); // no direction: assume on the bow
  const limit = limits[sector];
  return { sector, limit, ratio: limit > 0 ? value / limit : Infinity };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Lattice of layers from start to destination. Layer 0 is the start, the last
// layer is the destination, and each layer in between spans the corridor.
// opts.via adds intermediate waypoints: the route must pass through each, in
// order. Each stretch between them gets its own corridor, and every waypoint
// is a one-node layer, so the search can't skip it.
export function buildGrid(start, dest, opts = {}) {
  const stops = [start, ...(opts.via || []), dest];
  const lanes = opts.lanes ?? 6; // lanes either side of the direct line
  const nodes = [];
  const layers = [];
  const addNode = (layer, p, j, fixed, extra = {}) => {
    const n = { id: nodes.length, i: layers.length, j, lat: p.lat, lon: p.lon, fixed, ...extra };
    nodes.push(n);
    layer.push(n);
  };
  let total = 0;
  let userVia = 0;
  for (let s = 0; s < stops.length - 1; s++) {
    const a = stops[s];
    const b = stops[s + 1];
    const D = distanceNm(a, b);
    total += D;
    const layersCount = opts.layers ?? clamp(Math.round(D / 4), 4, 30);
    const halfWidth = opts.halfWidthNm ?? clamp(D * 0.3, 3, 150);
    if (s === 0) {
      const first = [];
      addNode(first, a, 0, true);
      layers.push(first);
    }
    for (let i = 1; i <= layersCount; i++) {
      const f = i / layersCount;
      const layer = [];
      if (i === layersCount) {
        // The captain's waypoints are numbered; turns added to get around
        // shallow water (auto) are not.
        if (s < stops.length - 2) addNode(layer, b, 0, true, b.auto ? { via: true, auto: true } : { via: ++userVia });
        else addNode(layer, b, 0, true);
      } else {
        const c = interpolate(a, b, f);
        const brg = bearingDeg(c, b);
        // Narrow the corridor near the ends so lanes fan out from one stop
        // and converge on the next.
        const taper = Math.min(1, 3 * Math.min(f, 1 - f));
        for (let j = -lanes; j <= lanes; j++) {
          const off = (j / lanes) * halfWidth * taper;
          addNode(layer, off === 0 ? c : destinationPoint(c, brg + 90, off), j, false);
        }
      }
      layers.push(layer);
    }
  }
  return { nodes, layers, lanes, distanceNm: total };
}

// Forecast value for node k at unix time t (seconds). Heights interpolate
// linearly between hours; directions use the nearer hour.
// Nodes with no sea forecast (rivers, sounds, harbours, land) are only usable
// when marked sheltered: water confirmed deep enough by the depth check. There
// only the wind is checked.
export function sample(forecast, k, t) {
  const node = forecast.nodes[k];
  if (!node || !(node.sea || node.sheltered)) return null;
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
  const hs = node.sea ? lerp(node.waveHeight) : null;
  if (hs == null && !node.sheltered) return null;
  return {
    hsFt: hs == null ? null : hs * M_TO_FT,
    sheltered: hs == null,
    seasFrom: near(node.waveDirection),
    periodS: lerp(node.wavePeriod),
    windKt: lerp(node.windSpeed),
    windFrom: near(node.windDirection),
    gustKt: lerp(node.windGust),
    currentKt: lerp(node.currentKt),
    currentTo: near(node.currentTo),
  };
}

// Mean current (as an east/north vector in kt) at the given node samples.
function meanCurrent(samples) {
  let e = 0, n = 0, k = 0;
  for (const s of samples) {
    if (!s || s.currentKt == null || s.currentTo == null) continue;
    const r = (s.currentTo * Math.PI) / 180;
    e += s.currentKt * Math.sin(r);
    n += s.currentKt * Math.cos(r);
    k++;
  }
  return k ? { e: e / k, n: n / k } : null;
}

// Speed over ground making good `heading` at `speedKt` through the water in a
// current: the along-track part of the current adds or subtracts, and the boat
// crabs to cancel the cross-track part. Null if it can't hold the course.
export function speedOverGround(speedKt, heading, cur) {
  if (!cur) return speedKt;
  const r = (heading * Math.PI) / 180;
  const along = cur.e * Math.sin(r) + cur.n * Math.cos(r);
  const cross = cur.e * Math.cos(r) - cur.n * Math.sin(r);
  if (Math.abs(cross) >= speedKt) return null;
  const sog = along + Math.sqrt(speedKt * speedKt - cross * cross);
  return sog > 0.5 ? sog : null;
}

// Check one leg a->b leaving at t0. Returns the worst sea state on the leg,
// or an infeasible marker with the reason.
// With relaxed set, limits don't reject the leg; every limit it goes over is
// listed in violations instead (used to explain why no route fits).
export function evaluateLeg(forecast, a, b, t0, vessel, relaxed = false) {
  const dist = distanceNm(a, b);
  const heading = bearingDeg(a, b);
  // Time on the leg uses speed over ground: the current at both ends, halfway through.
  let hrs = dist / vessel.speedKt;
  const tm = t0 + (hrs * 3600) / 2;
  const sog = speedOverGround(vessel.speedKt, heading, meanCurrent([sample(forecast, a.id, tm), sample(forecast, b.id, tm)]));
  if (sog == null) return { ok: false, reason: 'current', dist, hrs, heading };
  hrs = dist / sog;
  const t1 = t0 + hrs * 3600;
  const checks = [];
  // Ends of the leg at the times the boat is there, plus both ends at mid-leg.
  // Start and destination may sit in a harbour with no wave data; skip those.
  // Your own waypoints are checked too when the forecast covers them.
  const check = (n) => !n.fixed || (n.via && (forecast.nodes[n.id]?.sea || forecast.nodes[n.id]?.sheltered));
  if (check(a)) checks.push([a.id, t0]);
  if (check(a)) checks.push([a.id, (t0 + t1) / 2]);
  if (check(b)) checks.push([b.id, (t0 + t1) / 2]);
  if (check(b)) checks.push([b.id, t1]);
  let worst = null;
  const violations = [];
  for (const [k, t] of checks) {
    const s = sample(forecast, k, t);
    if (!s) return { ok: false, reason: 'land', dist, hrs, heading };
    if (s.beyond) return { ok: false, reason: 'beyond', dist, hrs, heading };
    const sea = s.hsFt != null ? against(s.hsFt, s.seasFrom, heading, vessel.limitsFt) : null;
    // Wind is checked when the source has it and the captain set wind limits.
    const wind =
      s.windKt != null && vessel.windLimitsKt
        ? against(s.windKt, s.windFrom, heading, vessel.windLimitsKt)
        : null;
    const seaRatio = sea ? sea.ratio : 0;
    const ratio = Math.max(seaRatio, wind ? wind.ratio : 0);
    const info = { ...s, sea, wind, ratio, limitedBy: wind && wind.ratio > seaRatio ? 'wind' : 'seas', t };
    if (!worst || ratio > worst.ratio) worst = info;
    const at = forecast.nodes[k] && { lat: (k === a.id ? a : b).lat, lon: (k === a.id ? a : b).lon };
    const found = [];
    // Steep, short-period seas are avoided whatever direction they come from.
    const steep = vessel.steep;
    if (steep && sea && s.periodS != null && s.hsFt > steep.hsFt && s.periodS <= steep.periodS) {
      found.push({ kind: 'steep', value: s.hsFt, limit: steep.hsFt, periodS: s.periodS, over: s.hsFt / steep.hsFt - 1 });
    }
    if (sea && sea.ratio > 1) found.push({ kind: 'seas', value: s.hsFt, limit: sea.limit, sector: sea.sector, over: sea.ratio - 1 });
    if (wind && wind.ratio > 1) found.push({ kind: 'wind', value: s.windKt, limit: wind.limit, sector: wind.sector, over: wind.ratio - 1 });
    // A sailing vessel can't hold a course this close to the wind once there's
    // enough of it to sail; it would have to tack or motor.
    // Not on legs leaving the start or reaching the destination, which are
    // usually motored in and out of harbour.
    const sail = (a.fixed && !a.via) || (b.fixed && !b.via) ? null : vessel.sail;
    if (sail && s.windKt != null && s.windFrom != null && s.windKt >= sail.minWindKt) {
      const off = relativeAngle(s.windFrom, heading);
      if (off < sail.noGoDeg) found.push({ kind: 'beat', value: off, limit: sail.noGoDeg, windKt: s.windKt, over: (sail.noGoDeg - off) / sail.noGoDeg });
    }
    if (found.length && !relaxed) return { ok: false, reason: found[0].kind, dist, hrs, heading, worst: info };
    for (const v of found) violations.push({ ...v, t, at });
  }
  return { ok: true, dist, hrs, heading, t1, worst, violations };
}

// No-cruise hours, in the phone's local time: { start, end } in minutes after
// midnight; start later than end means overnight (e.g. 18:00 to 08:00).
function quietOn(quiet) {
  return !!quiet && quiet.start !== quiet.end;
}
export function isQuiet(quiet, t) {
  if (!quietOn(quiet)) return false;
  const d = new Date(t * 1000);
  const m = d.getHours() * 60 + d.getMinutes();
  return quiet.start > quiet.end ? m >= quiet.start || m < quiet.end : m >= quiet.start && m < quiet.end;
}
// The next time after t that the clock reads `minutes` after midnight.
function nextClock(t, minutes) {
  const d = new Date(t * 1000);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (d.getTime() / 1000 <= t) d.setDate(d.getDate() + 1);
  return d.getTime() / 1000;
}
// Whether being underway from t0 to t1 runs into no-cruise hours.
function runsIntoQuiet(quiet, t0, t1) {
  return quietOn(quiet) && (isQuiet(quiet, t0) || nextClock(t0, quiet.start) < t1);
}

// Time-dependent search over the lattice for one departure time.
// cost = hours underway, using speed over ground in the forecast current, so the
// answer is the quickest route that stays within every limit (with no current,
// quickest = shortest). A tiny comfort term only breaks ties.
// With no-cruise hours set, the route is planned one stretch at a time between
// the captain's waypoints; a stretch that can't be finished before the
// no-cruise hours start waits at the waypoint until they end (an overnight stop).
export function planRoute(grid, forecast, departT, vessel, opts = {}) {
  const stats = { seas: 0, wind: 0, steep: 0, beat: 0, current: 0, land: 0, beyond: 0, quiet: 0 };
  const quiet = opts.relaxed ? null : vessel.quiet;
  const cuts = [0];
  grid.layers.forEach((l, i) => i > 0 && i < grid.layers.length - 1 && l[0].via && !l[0].auto && cuts.push(i));
  cuts.push(grid.layers.length - 1);
  const legs = [];
  let t = departT;
  for (let s = 0; s < cuts.length - 1; s++) {
    const layers = grid.layers.slice(cuts[s], cuts[s + 1] + 1);
    let part = planStretch(layers, forecast, t, vessel, opts, stats, quiet);
    if (!part && s > 0 && quietOn(quiet)) {
      const morning = nextClock(t, quiet.end);
      part = planStretch(layers, forecast, morning, vessel, opts, stats, quiet);
      if (part) part.legs[0].stopFrom = t;
    }
    if (!part) return { ok: false, stats };
    legs.push(...part.legs);
    t = part.t;
  }
  return summarize(legs, departT);
}

function planStretch(layers, forecast, departT, vessel, opts, stats, quiet) {
  // Sailing vessels need wider zig-zags to tack upwind.
  const maxJump = opts.maxJump ?? (vessel.sail ? 4 : 2);
  const edgeOk = opts.edgeOk || (() => true); // e.g. depth: false for edges known to be too shallow
  const comfort = opts.comfortWeight ?? 0.001;
  const relaxed = !!opts.relaxed;
  const labels = new Map();
  labels.set(layers[0][0].id, { cost: 0, t: departT, prev: null, leg: null });
  for (let i = 0; i < layers.length - 1; i++) {
    const next = layers[i + 1];
    for (const a of layers[i]) {
      const la = labels.get(a.id);
      if (!la) continue;
      for (const b of next) {
        if (!b.fixed && !a.fixed && Math.abs(b.j - a.j) > maxJump) continue;
        const nb = forecast.nodes[b.id];
        if (!b.fixed && !(nb?.sea || nb?.sheltered)) {
          stats.land++;
          continue;
        }
        let shallow = null;
        if (!edgeOk(a, b)) {
          stats.shallow = (stats.shallow || 0) + 1;
          if (!relaxed) continue;
          const depth = opts.edgeDepth?.(a, b);
          const min = opts.minDepthFt || 1;
          shallow = { kind: 'depth', value: depth, limit: min, over: depth != null ? Math.max(0, 1 - depth / min) : 1, at: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }, t: la.t };
        }
        const r = evaluateLeg(forecast, a, b, la.t, vessel, relaxed);
        if (!r.ok) {
          stats[r.reason]++;
          continue;
        }
        if (runsIntoQuiet(quiet, la.t, r.t1)) {
          stats.quiet++;
          continue;
        }
        if (shallow) r.violations.unshift(shallow);
        const ratio = r.worst ? r.worst.ratio : 0;
        // Relaxed: going over a limit costs far more than any detour.
        const penalty = relaxed ? r.violations.reduce((p, v) => p + 500 * (0.2 + v.over), 0) : 0;
        const cost = la.cost + r.hrs * (1 + comfort * ratio * ratio) + penalty;
        const lb = labels.get(b.id);
        if (!lb || cost < lb.cost) {
          labels.set(b.id, { cost, t: r.t1, prev: a, leg: { ...r, from: a, to: b, t0: la.t } });
        }
      }
    }
  }
  const destNode = layers[layers.length - 1][0];
  const end = labels.get(destNode.id);
  if (!end) return null;
  const legs = [];
  for (let n = destNode, l = end; l.leg; n = l.prev, l = labels.get(n.id)) legs.unshift(l.leg);
  return { legs, t: end.t };
}

// Follow the direct line (centre lane) without any routing, for comparison.
export function directPath(grid) {
  return grid.layers.map((layer) => layer.find((n) => n.j === 0));
}

export function evaluateDirect(grid, forecast, departT, vessel) {
  const path = directPath(grid);
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
  const violations = legs.flatMap((l) => l.violations || []);
  const underwayHrs = legs.reduce((s, l) => s + l.hrs, 0);
  const stops = legs.filter((l) => l.stopFrom).length;
  return { ok: true, legs: mergeLegs(legs), distanceNm: distance, departT, arriveT, maxRatio, violations, underwayHrs, stops };
}

// How far p lies from the rhumb line a-b (a straight line on the chart).
function offTrackNm(a, b, p) {
  const m = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const k = 3440.065 * Math.cos((p.lat * Math.PI) / 180);
  const P = (q) => [(q.lon * Math.PI) / 180, m(q.lat)];
  const [ax, ay] = P(a), [bx, by] = P(b), [px, py] = P(p);
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1e-12;
  return (Math.abs((px - ax) * dy - (py - ay) * dx) / len) * k;
}

// Join consecutive legs that hold the same heading so the waypoint list reads
// like a passage plan rather than a lattice walk.
function mergeLegs(legs) {
  const out = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    // Only when the joined leg still passes within 0.05 nm of the point being
    // dropped, so the drawn and exported leg is the track that was checked.
    if (prev && !prev.to.via && Math.abs(relativeAngle(prev.heading, l.heading)) < 2 && offTrackNm(prev.from, l.to, prev.to) < 0.05) {
      prev.edges.push([l.from, l.to]);
      prev.to = l.to;
      prev.dist += l.dist;
      prev.hrs += l.hrs;
      prev.t1 = l.t1;
      prev.heading = bearingDeg(prev.from, prev.to);
      if (l.worst && (!prev.worst || l.worst.ratio > prev.worst.ratio)) prev.worst = l.worst;
    } else {
      out.push({ ...l, edges: [[l.from, l.to]] });
    }
  }
  return out;
}

// Try every departure hour the forecast covers and report when the passage
// can be made within the limits.
//   slots:   one per hour, status 'go' | 'nogo' | 'unknown' (arrival would be
//            past the end of the forecast, so it can't be judged yet) | 'quiet'
//            (the weather allows it but it would mean cruising in no-cruise hours)
//   windows: runs of consecutive 'go' hours, as { start, end } departure times
//   best:    the 'go' departure with the least time underway, then the lowest worst-vs-limit
export function scanDepartures(grid, forecast, vessel, opts = {}) {
  const step = (opts.stepHours ?? 1) * 3600;
  const first = forecast.times[0];
  const last = forecast.times[forecast.times.length - 1];
  const minHours = grid.distanceNm / vessel.speedKt;
  const slots = [];
  for (let t = Math.ceil(Math.max(opts.fromT ?? first, first) / 3600) * 3600; t < last; t += step) {
    if (t + minHours * 3600 > last) {
      slots.push({ t, status: 'unknown' });
      continue;
    }
    if (isQuiet(vessel.quiet, t)) {
      slots.push({ t, status: 'quiet' });
      continue;
    }
    const route = planRoute(grid, forecast, t, vessel, opts);
    if (route.ok) slots.push({ t, status: 'go', route });
    else if (route.stats.quiet && planRoute(grid, forecast, t, { ...vessel, quiet: null }, opts).ok) slots.push({ t, status: 'quiet' });
    else slots.push({ t, status: route.stats.beyond && !route.stats.seas && !route.stats.wind && !route.stats.steep && !route.stats.beat ? 'unknown' : 'nogo' });
  }
  const windows = [];
  for (const sl of slots) {
    const w = windows[windows.length - 1];
    if (sl.status !== 'go') continue;
    if (w && sl.t - w.end === step) w.end = sl.t;
    else windows.push({ start: sl.t, end: sl.t });
  }
  let best = null;
  for (const sl of slots) {
    if (sl.status !== 'go') continue;
    const r = sl.route;
    // Quickest passage (time underway, currents included) first; between
    // equally quick ones, the calmer.
    const better =
      !best ||
      r.underwayHrs < best.underwayHrs - 0.05 ||
      (Math.abs(r.underwayHrs - best.underwayHrs) <= 0.05 && r.maxRatio < best.maxRatio);
    if (better) best = r;
  }
  return { slots, windows, best, step };
}
