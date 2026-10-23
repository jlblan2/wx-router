// Water depth along candidate legs, so routes stay out of water shallower than
// the captain's minimum.
//
// Each source takes [{lat, lon}] and returns depth in feet for each point:
// positive = water that deep, 0 or less = land or drying, null = no data.
import { bearingDeg, destinationPoint, distanceNm, interpolate } from './geo.js';
import { edgeKey } from './router.js';

const M_TO_FT = 3.28084;

// NOAA NCEI elevation models served as ArcGIS image services. Elevations are in
// metres, negative below the model's vertical datum (mostly mean high water or
// NAVD88 near the coast, not chart datum).
function arcgisDepth(name, url, workers = 3) {
  return {
    name,
    url,
    async getDepthsFt(points) {
      const CHUNK = 500; // the service returns at most 1000 samples per request
      const chunks = [];
      for (let i = 0; i < points.length; i += CHUNK) chunks.push(points.slice(i, i + CHUNK));
      const out = new Array(points.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const c = next++;
          const body = new URLSearchParams({
            geometry: JSON.stringify({
              points: chunks[c].map((p) => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]),
              spatialReference: { wkid: 4326 },
            }),
            geometryType: 'esriGeometryMultipoint',
            returnFirstValueOnly: 'true',
            f: 'json',
          });
          const res = await fetch(url, { method: 'POST', body });
          if (!res.ok) throw new Error(`depth service ${res.status}`);
          const json = await res.json();
          if (json.error) throw new Error(json.error.message || 'depth service error');
          for (const sm of json.samples || []) {
            const v = parseFloat(sm.value);
            if (Number.isFinite(v)) out[c * CHUNK + sm.locationId] = -v * M_TO_FT;
          }
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));
      return out;
    },
  };
}

// "DEM Global Mosaic": NOAA's coastal and regional models at up to 1/3
// arc-second, filled in with global bathymetry offshore. Used everywhere.
export const noaaDepth = arcgisDepth(
  'NOAA NCEI bathymetry (DEM Global Mosaic)',
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/getSamples'
);

// "DEM All": every NCEI model, finest on top, including the 1/9 arc-second
// (about 3 m) Continuously Updated DEMs of the US coast. Used near shore.
export const noaaCoastalDepth = arcgisDepth(
  'NOAA NCEI high-resolution coastal bathymetry (1/9 arc-second CUDEM)',
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer/getSamples',
  4
);

// Made-up seabed for the demo weather: deep water with scattered shallow banks.
export const demoDepth = {
  name: 'Demo depths (made-up seabed)',
  async getDepthsFt(points) {
    return points.map((p) => {
      const bank = Math.sin(p.lat * 9) * Math.cos(p.lon * 11);
      return bank > 0.8 ? 3 + (1 - bank) * 40 : 30 + 300 * (0.8 - bank);
    });
  },
};

const SPACING_NM = 0.2;
// Start and destination are usually in a harbour or at a dock; depth isn't
// checked this close to them.
const ENDS_NM = 0.25;
// Within this distance of land, depths come from the coastal source, sampled
// more closely.
export const COASTAL_NM = 3;
const COASTAL_SPACING_NM = 0.05;
// Land is looked for this far either side of each leg, at these steps.
const PROBE_OFFSETS_NM = [1, 2, 3];

// Points found to be land, bucketed so "is there land within 3 nm" is quick.
class LandIndex {
  constructor(cellDeg = 0.05) {
    this.cell = cellDeg;
    this.cells = new Map();
  }
  key(i, j) {
    return `${i},${j}`;
  }
  add(p) {
    const k = this.key(Math.floor(p.lat / this.cell), Math.floor(p.lon / this.cell));
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(p);
  }
  near(p, nm) {
    const i0 = Math.floor(p.lat / this.cell);
    const j0 = Math.floor(p.lon / this.cell);
    const di = Math.ceil(nm / 60 / this.cell);
    const dj = Math.ceil(nm / (60 * this.cell * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180))));
    for (let i = i0 - di; i <= i0 + di; i++) {
      for (let j = j0 - dj; j <= j0 + dj; j++) {
        for (const q of this.cells.get(this.key(i, j)) || []) if (distanceNm(p, q) <= nm) return true;
      }
    }
    return false;
  }
}

// Checks lattice edges once each and remembers the shallowest depth found.
// Within COASTAL_NM of land the coastal source (if given) replaces the main one.
export class DepthChecker {
  constructor(source, minDepthFt, coastal = null) {
    this.source = source;
    this.coastal = coastal;
    this.minDepthFt = minDepthFt;
    this.shallowest = new Map(); // edge key -> shallowest depth ft (null if no data)
    this.shallowNodes = new Set(); // waypoint ids sitting in water that's too shallow
    this.land = new LandIndex();
    this.coastalEdges = new Set(); // edge keys checked with the coastal source
    this.coastalError = null; // why the coastal source couldn't be used, if it failed
    this.landCheck = null; // optional LandCheck: exact coastline and bridge crossings
    this.landError = null;
    this.blockedBy = new Map(); // edge key -> { kind: 'land' | 'bridge', name, at }
  }

  // Coastal depths for the points, or null if the source failed (then the
  // main source's depths stand).
  async coastalDepths(pts) {
    if (!this.coastal || !pts.length) return null;
    try {
      const ds = await this.coastal.getDepthsFt(pts);
      ds.forEach((d, i) => d != null && d <= 0 && this.land.add(pts[i]));
      return ds;
    } catch (e) {
      this.coastalError = e.message;
      return null;
    }
  }

  // One quick pass over every candidate waypoint first; it rules out most
  // shallow areas before the slower leg-by-leg checks.
  async checkNodes(nodes) {
    const free = nodes.filter((n) => !n.fixed);
    const depths = await this.source.getDepthsFt(free);
    free.forEach((n, i) => depths[i] != null && depths[i] <= 0 && this.land.add(n));
    const near = free.map((n, i) => i).filter((i) => this.land.near(free[i], COASTAL_NM));
    const fine = await this.coastalDepths(near.map((i) => free[i]));
    if (fine) near.forEach((i, k) => fine[k] != null && (depths[i] = fine[k]));
    this.nodeDepth = new Map();
    free.forEach((n, i) => {
      this.nodeDepth.set(n.id, depths[i]);
      if (depths[i] != null && depths[i] < this.minDepthFt) this.shallowNodes.add(n.id);
    });
    this.nodesChecked = true;
  }

  isChecked(a, b) {
    return this.shallowest.has(edgeKey(a, b));
  }

  // Edges never seen yet are allowed while searching; they get checked
  // afterwards and the search is run again if any turn out too shallow.
  edgeOk = (a, b) => {
    if (this.shallowNodes.has(a.id) || this.shallowNodes.has(b.id)) return false;
    const d = this.shallowest.get(edgeKey(a, b));
    return d === undefined || d === null || d >= this.minDepthFt;
  };

  // Only edges already checked and deep enough.
  verifiedOk = (a, b) => {
    if (this.shallowNodes.has(a.id) || this.shallowNodes.has(b.id)) return false;
    const d = this.shallowest.get(edgeKey(a, b));
    return d !== undefined && (d === null || d >= this.minDepthFt);
  };

  async check(edges) {
    const seen = new Set();
    const todo = edges.filter(([a, b]) => {
      const k = edgeKey(a, b);
      if (this.shallowest.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!todo.length) return 0;
    // Turns added to get around shallows are checked right up to the turn.
    const skip = (a, b, len, along) => (a.fixed && !a.auto && along < ENDS_NM) || (b.fixed && !b.auto && len - along < ENDS_NM);

    // Pass 1, main source: samples along each edge, plus probes either side of
    // it to find any land within COASTAL_NM.
    const pts = [];
    const probes = [];
    const plans = todo.map(([a, b]) => {
      const len = distanceNm(a, b);
      const n = Math.max(2, Math.ceil(len / SPACING_NM));
      const samples = [];
      for (let i = 0; i <= n; i++) {
        const along = (len * i) / n;
        const p = interpolate(a, b, i / n);
        samples.push({ p, along, idx: skip(a, b, len, along) ? -1 : pts.push(p) - 1 });
      }
      if (this.coastal) {
        const brg = bearingDeg(a, b);
        const m = Math.max(1, Math.ceil(len));
        for (let i = 0; i <= m; i++) {
          const c = interpolate(a, b, i / m);
          for (const off of PROBE_OFFSETS_NM) {
            probes.push(destinationPoint(c, brg + 90, off), destinationPoint(c, brg - 90, off));
            if (i === 0) probes.push(destinationPoint(c, brg + 180, off));
            if (i === m) probes.push(destinationPoint(c, brg, off));
          }
        }
      }
      return { len, samples };
    });
    const all = await this.source.getDepthsFt(pts.concat(probes));
    all.forEach((d, i) => d != null && d <= 0 && this.land.add(i < pts.length ? pts[i] : probes[i - pts.length]));

    // Pass 2, coastal source: every stretch of an edge with land within
    // COASTAL_NM is sampled again, more closely.
    const fine = [];
    plans.forEach((pl, k) => {
      const [a, b] = todo[k];
      pl.stretches = [];
      if (!this.coastal) return;
      const near = pl.samples.map((s) => this.land.near(s.p, COASTAL_NM));
      for (let i = 0; i < pl.samples.length - 1; i++) {
        if (!near[i] && !near[i + 1]) continue;
        const s0 = pl.samples[i];
        const s1 = pl.samples[i + 1];
        const n = Math.max(1, Math.ceil((s1.along - s0.along) / COASTAL_SPACING_NM));
        const idx = [];
        const prev = pl.stretches.at(-1)?.i === i - 1; // shared end already sampled
        for (let j = prev ? 1 : 0; j <= n; j++) {
          const along = s0.along + ((s1.along - s0.along) * j) / n;
          if (!skip(a, b, pl.len, along)) idx.push(fine.push(interpolate(a, b, along / pl.len)) - 1);
        }
        pl.stretches.push({ i, idx });
      }
    });
    const fineDs = await this.coastalDepths(fine);

    todo.forEach(([a, b], k) => {
      const pl = plans[k];
      const replaced = new Set();
      let min;
      const take = (d) => d != null && (min = min === undefined ? d : Math.min(min, d));
      if (fineDs) {
        for (const st of pl.stretches) {
          const ds = st.idx.map((i) => fineDs[i]).filter((d) => d != null);
          if (!ds.length) continue; // no coastal model here; keep the main source
          ds.forEach(take);
          replaced.add(st.i).add(st.i + 1);
        }
        if (replaced.size) this.coastalEdges.add(edgeKey(a, b));
      }
      pl.samples.forEach((s, i) => s.idx >= 0 && !replaced.has(i) && take(all[s.idx]));
      this.shallowest.set(edgeKey(a, b), min ?? null);
      pl.nearLand = pl.samples.some((s) => this.land.near(s.p, COASTAL_NM));
    });

    // Pass 3: legs near land are checked against the mapped coastline and
    // bridges, which catches land narrower than the depth samples' spacing.
    if (this.landCheck) {
      const near = todo.filter((e, k) => plans[k].nearLand && (this.shallowest.get(edgeKey(...e)) ?? 1) > 0);
      try {
        await this.landCheck.prefetch(near);
        this.landChecked = (this.landChecked || 0) + near.length;
        for (const [a, b] of near) {
          const end = (n) => (n.fixed && !n.auto ? ENDS_NM : 0);
          const hit = await this.landCheck.blocking(a, b, { skipStart: end(a), skipEnd: end(b) });
          if (hit) {
            this.shallowest.set(edgeKey(a, b), 0);
            this.blockedBy.set(edgeKey(a, b), hit);
          }
        }
      } catch (e) {
        this.landError = e.message;
      }
    }
    return todo.length;
  }

  // Waypoints with no sea forecast but deep enough water become usable
  // sheltered water (rivers, sounds, harbours). Recomputed each plan, since the
  // forecast is shared between plans with different minimum depths.
  markSheltered(forecast) {
    forecast.nodes.forEach((n, id) => {
      const d = this.nodeDepth?.get(id);
      n.sheltered = !n.sea && d != null && d >= this.minDepthFt;
    });
  }

  // Land or a bridge blocking an edge, for explaining a block.
  edgeBlock = (a, b) => this.blockedBy.get(edgeKey(a, b));

  // Shallowest known depth on an edge or at its ends, for explaining a block.
  edgeDepth = (a, b) => {
    const ds = [this.shallowest.get(edgeKey(a, b)), this.nodeDepth?.get(a.id), this.nodeDepth?.get(b.id)];
    const known = ds.filter((d) => d != null);
    return known.length ? Math.min(...known) : undefined;
  };

  // Whether any part of a route leg was checked with the coastal source.
  legCoastal(leg) {
    return (leg.edges || []).some(([a, b]) => this.coastalEdges.has(edgeKey(a, b)));
  }

  // Shallowest depth found along a route leg (which may span several edges).
  legShallowest(leg) {
    let m = null;
    for (const [a, b] of leg.edges || []) {
      const d = this.shallowest.get(edgeKey(a, b));
      if (d != null) m = m == null ? d : Math.min(m, d);
    }
    return m;
  }
}

// Plan, check the depth along every leg the plan used, block the shallow ones
// and plan again until every leg in the answer has been checked.
// plan(edgeOk) must return the routes it produced (an array, nulls allowed).
export async function planWithDepth(checker, nodes, plan, onProgress = () => {}, maxRounds = 12) {
  let routes;
  if (!checker.nodesChecked) {
    onProgress('Checking water depth…');
    await checker.checkNodes(nodes);
  }
  for (let round = 0; round < maxRounds; round++) {
    routes = plan(checker.edgeOk);
    const edges = [];
    for (const r of routes) for (const l of r?.legs || []) edges.push(...l.edges);
    onProgress(`Checking water depth along the route${round ? ` (pass ${round + 1})` : ''}…`);
    const added = await checker.check(edges);
    if (!added) return { routes, complete: true };
  }
  // Out of passes: answer using only legs already confirmed deep enough.
  return { routes: plan(checker.verifiedOk), complete: false };
}

// ---------- Finding a way around shallow water ----------
// Before the weather routing, the area around each stretch is laid out as a
// grid of depth cells and searched (A*) for the shortest path that keeps to
// water at least the minimum depth. Its turning points steer the weather
// corridor around banks and shoals that a straight corridor can't get past.
// Long passages are searched coarsely first, then each piece of the path is
// searched again on a finer grid, so narrow passes are still found.
const MAX_CELLS = [8000, 2500, 2500];
const MIN_CELL_NM = 0.2;
const REFINE_ABOVE_NM = 1; // cells bigger than this get a finer second look

// blocked: points the path must not pass through (where a straight leg was
// found to cross land or a low bridge), each closing the cells around it.
export async function deepWaterPath(a, b, minDepthFt, source, onProgress = () => {}, level = 0, blocked = []) {
  const turns = await searchDeep(a, b, minDepthFt, source, onProgress, level, blocked);
  if (!turns?.length || turns.cell <= REFINE_ABOVE_NM || level >= MAX_CELLS.length - 1) return turns;
  onProgress('Refining the way around the shallows…');
  const pts = [a, ...turns, b];
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (i) out.push(pts[i]);
    const fine = await deepWaterPath(pts[i], pts[i + 1], minDepthFt, source, onProgress, level + 1, blocked);
    if (fine) out.push(...fine); // no finer way: keep the coarse turn
  }
  return out;
}

async function searchDeep(a, b, minDepthFt, source, onProgress, level, blocked) {
  const D = distanceNm(a, b);
  if (D < 0.5) return [];
  const pad = Math.min(150, Math.max(5, D * 0.3));
  const midLat = (a.lat + b.lat) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  // Plane coordinates in nm around the midpoint.
  const toXY = (p) => [(p.lon - (a.lon + b.lon) / 2) * 60 * k, (p.lat - midLat) * 60];
  const toLL = (x, y) => ({ lat: midLat + y / 60, lon: (a.lon + b.lon) / 2 + x / (60 * k) });
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const x0 = Math.min(ax, bx) - pad, x1 = Math.max(ax, bx) + pad;
  const y0 = Math.min(ay, by) - pad, y1 = Math.max(ay, by) + pad;
  const cell = Math.max(MIN_CELL_NM, Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_CELLS[level]));
  const W = Math.ceil((x1 - x0) / cell);
  const H = Math.ceil((y1 - y0) / cell);
  const centre = (i, j) => toLL(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell);
  const pts = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) pts.push(centre(i, j));
  if (!level) onProgress('Mapping deep water around the route…');
  const depths = await source.getDepthsFt(pts);
  // The minimum depth is the safety margin; the path keeps to it and no more,
  // so it is the shortest way through (the legs are checked more finely later).
  const deepCells = depths.map((d) => d == null || d >= minDepthFt);
  for (const p of blocked) {
    const [px, py] = toXY(p);
    const ci = Math.floor((px - x0) / cell), cj = Math.floor((py - y0) / cell);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj;
      if (i >= 0 && j >= 0 && i < W && j < H) deepCells[j * W + i] = false;
    }
  }
  return search(deepCells);

  async function search(ok) {
    ok = ok.slice();
  const idx = (x, y) => {
    const i = Math.min(W - 1, Math.max(0, Math.floor((x - x0) / cell)));
    const j = Math.min(H - 1, Math.max(0, Math.floor((y - y0) / cell)));
    return j * W + i;
  };
  // The start and finish are usually at a dock or in a harbour: their cells and
  // the ones touching them count as open.
  const sCell = idx(ax, ay);
  const gCell = idx(bx, by);
  for (const c of [sCell, gCell]) {
    const ci = c % W, cj = Math.floor(c / W);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj;
      if (i >= 0 && j >= 0 && i < W && j < H) ok[j * W + i] = true;
    }
  }
  // Straight line clear? Then nothing to steer around.
  const clear = (p, q) => {
    const n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (cell / 2)));
    for (let s = 0; s <= n; s++) if (!ok[idx(p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n)]) return false;
    return true;
  };
  if (clear([ax, ay], [bx, by])) return [];

  // A* over the cells, 8 neighbours, no cutting corners past shallow cells.
  const g = new Float64Array(W * H).fill(Infinity);
  const from = new Int32Array(W * H).fill(-1);
  const gi = gCell % W, gj = Math.floor(gCell / W);
  const h = (c) => Math.hypot((c % W) - gi, Math.floor(c / W) - gj);
  const open = [[h(sCell), sCell]];
  g[sCell] = 0;
  const push = (item) => {
    open.push(item);
    let n = open.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (open[p][0] <= open[n][0]) break;
      [open[p], open[n]] = [open[n], open[p]];
      n = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop();
    if (open.length) {
      open[0] = last;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1;
        let m = n;
        if (l < open.length && open[l][0] < open[m][0]) m = l;
        if (r < open.length && open[r][0] < open[m][0]) m = r;
        if (m === n) break;
        [open[m], open[n]] = [open[n], open[m]];
        n = m;
      }
    }
    return top;
  };
  const done = new Uint8Array(W * H);
  while (open.length) {
    const [, c] = pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === gCell) break;
    const ci = c % W, cj = Math.floor(c / W);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const n = j * W + i;
        if (!ok[n] || done[n]) continue;
        if (di && dj && (!ok[cj * W + i] || !ok[j * W + ci])) continue;
        const cost = g[c] + (di && dj ? Math.SQRT2 : 1);
        if (cost < g[n]) {
          g[n] = cost;
          from[n] = c;
          push([cost + h(n), n]);
        }
      }
    }
  }
  if (!done[gCell]) return null; // no way through at this minimum depth

  const cells = [];
  for (let c = gCell; c !== -1; c = from[c]) cells.unshift(c);
  const xy = cells.map((c) => [x0 + ((c % W) + 0.5) * cell, y0 + (Math.floor(c / W) + 0.5) * cell]);
  xy[0] = [ax, ay];
  xy[xy.length - 1] = [bx, by];
  // Pull the path straight: keep only the turns needed to stay in deep water.
  const turns = [];
  let i = 0;
  while (i < xy.length - 1) {
    let j = xy.length - 1;
    while (j > i + 1 && !clear(xy[i], xy[j])) j--;
    if (j < xy.length - 1) turns.push(toLL(...xy[j]));
    i = j;
  }
  turns.cell = cell;
  return turns;
  }
}
