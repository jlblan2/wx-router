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
    const skip = (a, b, len, along) => (a.fixed && along < ENDS_NM) || (b.fixed && len - along < ENDS_NM);

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
    });
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
