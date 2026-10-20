// Water depth along candidate legs, so routes stay out of water shallower than
// the captain's minimum.
//
// Each source takes [{lat, lon}] and returns depth in feet for each point:
// positive = water that deep, 0 or less = land or drying, null = no data.
import { distanceNm, interpolate } from './geo.js';
import { edgeKey } from './router.js';

const M_TO_FT = 3.28084;

// NOAA NCEI "DEM Global Mosaic": NOAA's coastal and regional bathymetric
// elevation models, filled in with global bathymetry offshore. Elevations are in
// metres, negative below the model's vertical datum (mostly mean high water or
// NAVD88 near the coast, not chart datum).
export const noaaDepth = {
  name: 'NOAA NCEI bathymetry (DEM Global Mosaic)',
  url: 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/getSamples',
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
        const res = await fetch(this.url, { method: 'POST', body });
        if (!res.ok) throw new Error(`depth service ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error.message || 'depth service error');
        for (const sm of json.samples || []) {
          const v = parseFloat(sm.value);
          if (Number.isFinite(v)) out[c * CHUNK + sm.locationId] = -v * M_TO_FT;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  },
};

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

// Checks lattice edges once each and remembers the shallowest depth found.
export class DepthChecker {
  constructor(source, minDepthFt) {
    this.source = source;
    this.minDepthFt = minDepthFt;
    this.shallowest = new Map(); // edge key -> shallowest depth ft (null if no data)
    this.shallowNodes = new Set(); // waypoint ids sitting in water that's too shallow
  }

  // One quick pass over every candidate waypoint first; it rules out most
  // shallow areas before the slower leg-by-leg checks.
  async checkNodes(nodes) {
    const free = nodes.filter((n) => !n.fixed);
    const depths = await this.source.getDepthsFt(free);
    free.forEach((n, i) => {
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
    const pts = [];
    const owner = [];
    todo.forEach(([a, b], k) => {
      const len = distanceNm(a, b);
      const n = Math.max(2, Math.ceil(len / SPACING_NM));
      for (let i = 0; i <= n; i++) {
        const along = (len * i) / n;
        if (a.fixed && along < ENDS_NM) continue;
        if (b.fixed && len - along < ENDS_NM) continue;
        pts.push(interpolate(a, b, i / n));
        owner.push(k);
      }
    });
    const depths = pts.length ? await this.source.getDepthsFt(pts) : [];
    const mins = todo.map(() => undefined);
    depths.forEach((d, i) => {
      const k = owner[i];
      if (d == null) return;
      mins[k] = mins[k] === undefined ? d : Math.min(mins[k], d);
    });
    todo.forEach(([a, b], k) => this.shallowest.set(edgeKey(a, b), mins[k] ?? null));
    return todo.length;
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
