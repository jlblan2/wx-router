// Exact land and bridge check for route legs. Depth models sample the seabed
// every so often and can step over a narrow cay or the neck of land at a
// bridge; a leg that crosses a coastline or a bridge it can't fit under is
// caught here whatever its width. Land comes from the built-in coastline
// (always there) and, where the built-in data shows a coast, from
// OpenStreetMap's mapped coastline and bridges when that service answers.
import { coastTile } from './coast.js';

const OSM_RETRY_MS = 5 * 60 * 1000; // after a failure, leave the service alone this long
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const TILE = 0.1; // degrees; data is fetched and indexed in tiles this size
const BATCH = 40; // tiles per request
const M_TO_FT = 3.28084;

const tileOf = (lat, lon) => [Math.floor(lat / TILE), Math.floor(lon / TILE)];
const keyOf = (i, j) => `${i},${j}`;

// Tiles a straight chart line from p to q passes through.
function tilesAlong(p, q) {
  const keys = new Set();
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(q.lat - p.lat), Math.abs(q.lon - p.lon)) / (TILE / 4)));
  for (let s = 0; s <= n; s++) {
    const [i, j] = tileOf(p.lat + ((q.lat - p.lat) * s) / n, p.lon + ((q.lon - p.lon) * s) / n);
    keys.add(keyOf(i, j));
  }
  return keys;
}

// Mercator plane, so chart-straight lines are straight here too.
const P = (p) => [p.lon, (Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)) * 180) / Math.PI];

// Where segments p1-p2 and q1-q2 cross (fraction along p1-p2), or null.
function crossAt(p1, p2, q1, q2) {
  const [ax, ay] = P(p1), [bx, by] = P(p2), [cx, cy] = P(q1), [dx, dy] = P(q2);
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-15) return null;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / den;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function bridgeInfo(tags) {
  const num = (k) => {
    const v = parseFloat(tags[k]);
    return Number.isFinite(v) ? v * M_TO_FT : null;
  };
  const cat = `${tags['seamark:bridge:category'] || ''} ${tags['bridge:movable'] || ''} ${tags.bridge || ''}`;
  const movable = /opening|bascule|swing|lifting|draw|movable|transporter/i.test(cat) && tags['bridge:movable'] !== 'no';
  const clearanceFt = num('seamark:bridge:clearance_height') ?? num('seamark:bridge:clearance_height_closed') ?? num('clearance');
  return { movable, clearanceFt };
}

export class LandCheck {
  // airDraftFt: height of the boat above the water; '' or 0 if not known.
  constructor(airDraftFt) {
    this.airDraftFt = Number(airDraftFt) || 0;
    this.tiles = new Map(); // tile key -> OpenStreetMap [{ a, b, kind, name, movable, clearanceFt }]
    this.coast = new Map(); // tile key -> built-in coastline [{ a, b, kind, src }]
    this.degs = new Map(); // 1° tile -> 'ok' (built-in data loaded) or 'none' (not covered)
    this.error = null; // why OpenStreetMap couldn't be used, if it failed
    this.coastError = null; // why the built-in coastline couldn't be loaded, if it failed
    this.failedAt = 0;
  }

  // Built-in coastline for the 1° tiles holding these tile keys.
  async loadCoast(keys) {
    const degs = new Set();
    for (const k of keys) {
      const [ti, tj] = k.split(',').map(Number);
      degs.add(`${Math.floor(ti * TILE + 1e-9)},${Math.floor(tj * TILE + 1e-9)}`);
    }
    for (const d of degs) {
      if (this.degs.has(d)) continue;
      const [i, j] = d.split(',').map(Number);
      let segs;
      try {
        segs = await coastTile(i, j);
      } catch (e) {
        this.coastError = e.message;
        continue; // OpenStreetMap is asked for this area instead
      }
      this.degs.set(d, segs ? 'ok' : 'none');
      for (const { a, b } of segs || []) {
        const seg = { a, b, kind: 'land', src: 'coast', name: null };
        for (const k of tilesAlong(a, b)) {
          if (!this.coast.has(k)) this.coast.set(k, []);
          this.coast.get(k).push(seg);
        }
      }
    }
  }

  // Whether the built-in coastline covers a tile key (loaded and inside its area).
  covered(k) {
    const [ti, tj] = k.split(',').map(Number);
    return this.degs.get(`${Math.floor(ti * TILE + 1e-9)},${Math.floor(tj * TILE + 1e-9)}`) === 'ok';
  }

  // Built-in coastline segments inside a box, for steering searches.
  async coastIn(s, w, n, e) {
    const keys = new Set();
    for (let i = Math.floor(s / TILE); i <= Math.floor(n / TILE); i++) {
      for (let j = Math.floor(w / TILE); j <= Math.floor(e / TILE); j++) keys.add(keyOf(i, j));
    }
    await this.loadCoast(keys);
    const out = new Set();
    for (const k of keys) for (const seg of this.coast.get(k) || []) out.add(seg);
    return [...out];
  }

  async load(keys) {
    await this.loadCoast(keys);
    // OpenStreetMap adds bridges and finer detail, only where there is a coast
    // (or no built-in data). If it fails, the built-in coastline still stands.
    if (Date.now() - this.failedAt < OSM_RETRY_MS) return;
    const num = (k) => k.split(',').map(Number);
    // Neighbouring tiles go in the same request, so each response stays small.
    const missing = [...keys]
      .filter((k) => !this.tiles.has(k) && (this.coast.has(k) || !this.covered(k)))
      .sort((x, y) => num(x)[0] - num(y)[0] || num(x)[1] - num(y)[1]);
    try {
      await this.loadOsm(missing);
      this.error = null;
    } catch (e) {
      this.error = e.message;
      this.failedAt = Date.now();
    }
  }

  async loadOsm(missing) {
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const cells = batch.map((k) => k.split(',').map(Number));
      const boxes = cells.map(([ti, tj]) => [ti * TILE, tj * TILE, (ti + 1) * TILE, (tj + 1) * TILE].map((v) => v.toFixed(4)).join(','));
      // Only the parts of long coastlines inside these tiles come back.
      const clip = [
        Math.min(...cells.map(([ti]) => ti)) * TILE,
        Math.min(...cells.map(([, tj]) => tj)) * TILE,
        (Math.max(...cells.map(([ti]) => ti)) + 1) * TILE,
        (Math.max(...cells.map(([, tj]) => tj)) + 1) * TILE,
      ].map((v) => v.toFixed(4)).join(',');
      const q = `[out:json][timeout:60];(${boxes
        .map((b) => `way["natural"="coastline"](${b});way["bridge"]["bridge"!="no"](${b});way["seamark:type"="bridge"](${b});`)
        .join('')});out tags geom(${clip});`;
      const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (!res.ok) throw new Error(`coastline data service ${res.status}`);
      const json = await res.json();
      for (const k of batch) this.tiles.set(k, []);
      for (const w of json.elements || []) {
        const g = w.geometry;
        if (!g || g.length < 2) continue;
        const t = w.tags || {};
        const coast = t.natural === 'coastline';
        const info = coast ? {} : bridgeInfo(t);
        const item = { kind: coast ? 'land' : 'bridge', src: 'osm', name: t.name || t['seamark:name'] || null, ...info };
        for (let n = 0; n < g.length - 1; n++) {
          const a = { lat: g[n].lat, lon: g[n].lon };
          const b = { lat: g[n + 1].lat, lon: g[n + 1].lon };
          const seg = { ...item, a, b }; // one object, so a crossing counts once
          for (const k of tilesAlong(a, b)) this.tiles.get(k)?.push(seg);
        }
      }
    }
  }

  // Load everything needed to check these lines in as few requests as possible.
  async prefetch(lines) {
    const keys = new Set();
    for (const [p, q] of lines) for (const k of tilesAlong(p, q)) keys.add(k);
    await this.load(keys);
  }

  // Whether the boat can pass a bridge it crosses under.
  passes(seg) {
    if (seg.kind !== 'bridge') return false;
    if (seg.movable) return true;
    return seg.clearanceFt != null && this.airDraftFt > 0 && this.airDraftFt + 1 <= seg.clearanceFt;
  }

  // First thing blocking the chart line p-q, as { kind, name, at, clearanceFt },
  // or null. skipNm: ignore crossings this close to either end when that end
  // is marked (start, destination, the captain's waypoints sit at docks).
  async blocking(p, q, opts) {
    return (await this.crossings(p, q, opts))[0] || null;
  }

  // Every blocking crossing along p-q, nearest p first.
  async crossings(p, q, { skipStart = 0, skipEnd = 0 } = {}) {
    const keys = tilesAlong(p, q);
    await this.load(keys);
    const lenNm = Math.hypot(q.lat - p.lat, (q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180)) * 60 || 1e-9;
    const seen = new Set();
    const out = [];
    for (const k of keys) {
      for (const seg of [...(this.coast.get(k) || []), ...(this.tiles.get(k) || [])]) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        const t = crossAt(p, q, seg.a, seg.b);
        if (t == null) continue;
        if (t * lenNm < skipStart || (1 - t) * lenNm < skipEnd) continue;
        if (this.passes(seg)) continue;
        out.push({ t, kind: seg.kind, src: seg.src, name: seg.name, clearanceFt: seg.clearanceFt, at: { lat: p.lat + (q.lat - p.lat) * t, lon: p.lon + (q.lon - p.lon) * t } });
      }
    }
    return out.sort((x, y) => x.t - y.t);
  }

  // Points along p-q that lie on land or under a low bridge: every crossing,
  // plus points every ~0.1 nm between a coastline crossing and the next one
  // (the stretch over land, when p starts in water). Each source's crossings
  // are paired on their own, since the two trace the same shore.
  async blockedPoints(p, q, opts) {
    const cs = await this.crossings(p, q, opts);
    const pts = cs.map((c) => c.at);
    const lenNm = Math.hypot(q.lat - p.lat, (q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180)) * 60;
    for (const src of ['coast', 'osm']) {
      const land = cs.filter((c) => c.kind === 'land' && c.src === src);
      for (let i = 0; i + 1 < land.length; i += 2) {
        const n = Math.min(400, Math.ceil(((land[i + 1].t - land[i].t) * lenNm) / 0.1));
        for (let s = 1; s < n; s++) {
          const t = land[i].t + ((land[i + 1].t - land[i].t) * s) / n;
          pts.push({ lat: p.lat + (q.lat - p.lat) * t, lon: p.lon + (q.lon - p.lon) * t });
        }
      }
    }
    return pts;
  }
}
