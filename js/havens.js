// Safe haven ports and anchorages near a route, from OpenStreetMap's nautical
// (OpenSeaMap) data. Anchorages that would be on a lee shore in the forecast
// wind are left out; the rest get a confidence level.
import { bearingDeg, destinationPoint, distanceNm } from './geo.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
export const SEARCH_NM = 15; // how far off the route to look
const MAX_PORTS = 8;
const MAX_ANCHORAGES = 8;
const STAY_HOURS = 12; // an anchorage is judged from when you'd get there until 12 h later

// Shelter is judged from how much open water lies upwind (the fetch) and
// whether land lies close downwind.
const BEARINGS = 16;
const PROBE_NM = [0.15, 0.3, 0.5, 0.75, 1, 1.5, 2, 3];
const OPEN_FETCH_NM = 2; // this much open water upwind lets seas build
const SHELTER_FETCH_NM = 1;
const LEE_LAND_NM = 1; // land this close downwind makes it a lee shore
const CALM_KT = 8; // lighter winds don't matter
const LEE_KT = 10; // a lee shore in this much wind rules an anchorage out

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

const cache = new Map(); // overpass query -> { at, elements }

async function overpass(bbox) {
  const [s, w, n, e] = bbox.map((v) => v.toFixed(3));
  const q = `[out:json][timeout:25];
(
  nwr["seamark:type"~"^(harbour|anchorage|anchor_berth)$"](${s},${w},${n},${e});
  nwr["leisure"="marina"](${s},${w},${n},${e});
);
out center tags 400;`;
  const c = cache.get(q);
  if (c && Date.now() - c.at < 3600000) return c.elements;
  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error(`harbour data service ${res.status}`);
  const json = await res.json();
  cache.set(q, { at: Date.now(), elements: json.elements || [] });
  return json.elements || [];
}

function classify(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const type = t['seamark:type'];
  const anchorage = type === 'anchorage' || type === 'anchor_berth';
  const cat = t['seamark:harbour:category'] || (t.leisure === 'marina' ? 'marina' : '');
  return {
    id: `${el.type}/${el.id}`,
    kind: anchorage ? 'anchorage' : 'port',
    name: t.name || t['seamark:name'] || null,
    category: anchorage ? t['seamark:anchorage:category'] || '' : cat,
    charted: !!type, // from nautical chart tagging, not just a map label
    lat,
    lon,
  };
}

// Closest point of the route to p: distance off, distance along, and the index
// of the route point it falls after.
function nearestOnRoute(route, p) {
  let best = { off: Infinity, along: 0, i: 0, f: 0 };
  let along = 0;
  const k = Math.cos((p.lat * Math.PI) / 180);
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const len = distanceNm(a, b);
    const ax = (a.lon - p.lon) * k, ay = a.lat - p.lat;
    const bx = (b.lon - p.lon) * k, by = b.lat - p.lat;
    const dx = bx - ax, dy = by - ay;
    const f = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    const off = Math.hypot(ax + f * dx, ay + f * dy) * 60;
    if (off < best.off) best = { off, along: along + f * len, i, f };
    along += len;
  }
  return best;
}

function dedupe(list) {
  const out = [];
  for (const h of list.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0))) {
    if (!out.some((o) => o.kind === h.kind && distanceNm(o, h) < 0.3)) out.push(h);
  }
  return out;
}

// Open water upwind from each of 16 directions, in nm (Infinity if no land
// within the probes), and the depth at the spot itself.
async function shelterProfiles(depthSource, spots) {
  const pts = [];
  for (const s of spots) {
    pts.push(s);
    for (let b = 0; b < BEARINGS; b++) for (const d of PROBE_NM) pts.push(destinationPoint(s, (b * 360) / BEARINGS, d));
  }
  const depths = await depthSource.getDepthsFt(pts);
  const per = 1 + BEARINGS * PROBE_NM.length;
  return spots.map((_, k) => {
    const base = k * per;
    const fetch = [];
    for (let b = 0; b < BEARINGS; b++) {
      let f = Infinity;
      for (let j = 0; j < PROBE_NM.length; j++) {
        const d = depths[base + 1 + b * PROBE_NM.length + j];
        if (d != null && d <= 0) {
          f = PROBE_NM[j];
          break;
        }
      }
      fetch.push(f);
    }
    return { depthFt: depths[base], fetch };
  });
}

// Worst (largest) fetch within ±22.5° of a direction, and nearest land there.
function fetchToward(fetch, deg, worst) {
  const i = Math.round((((deg % 360) + 360) % 360) / (360 / BEARINGS)) % BEARINGS;
  const near = [fetch[(i + BEARINGS - 1) % BEARINGS], fetch[i], fetch[(i + 1) % BEARINGS]];
  return worst ? Math.max(...near) : Math.min(...near);
}

// Judge one anchorage over its stay: lee shore (ruled out) or a confidence level.
function assess(spot, profile, wind, stay, minDepthFt, nowT) {
  const hours = [];
  for (let t = stay.from; t <= stay.to; t += 3600) {
    const i = Math.round((t - wind.times[0]) / 3600);
    const kt = wind.speed?.[i];
    const from = wind.dir?.[i];
    if (kt == null || from == null) continue;
    const up = fetchToward(profile.fetch, from, true);
    const down = fetchToward(profile.fetch, from + 180, false);
    let status = 'sheltered';
    if (kt >= CALM_KT) {
      if (up >= OPEN_FETCH_NM && down <= LEE_LAND_NM) status = 'lee';
      else if (up >= OPEN_FETCH_NM) status = 'exposed';
      else if (up > SHELTER_FETCH_NM) status = 'partial';
    }
    hours.push({ t, kt, from, status });
  }
  const lee = hours.filter((h) => h.status === 'lee' && h.kt >= LEE_KT);
  if (lee.length) {
    const w = lee.reduce((a, b) => (b.kt > a.kt ? b : a));
    return { excluded: `lee shore in the forecast ${compass(w.from)} ${Math.round(w.kt)} kt wind (${fmtShort(w.t)})` };
  }
  if (profile.depthFt != null && profile.depthFt > 0 && profile.depthFt < minDepthFt) {
    return { excluded: `about ${Math.round(profile.depthFt)} ft at the charted spot, under your ${minDepthFt} ft minimum` };
  }
  // Score: shelter over the stay, weighted by wind strength, then adjusted for
  // how far ahead the forecast is, the depth data and the chart data.
  const weight = (h) => Math.max(1, h.kt - CALM_KT + 1);
  const total = hours.reduce((s, h) => s + weight(h), 0);
  const good = hours.reduce((s, h) => s + weight(h) * (h.status === 'sheltered' ? 1 : h.status === 'partial' ? 0.6 : 0.2), 0);
  const shelter = total ? good / total : 0.5;
  const reasons = [];
  let score = 0.35 + 0.6 * shelter;
  const maxKt = hours.length ? Math.max(...hours.map((h) => h.kt)) : null;
  const dirs = [...new Set(hours.filter((h) => h.kt >= CALM_KT).map((h) => compass(h.from)))];
  if (!hours.length) {
    score -= 0.2;
    reasons.push('no wind forecast for the stay');
  } else if (!dirs.length) {
    reasons.push(`light winds forecast (under ${CALM_KT} kt)`);
  } else {
    const word = shelter >= 0.85 ? 'well sheltered from' : shelter >= 0.55 ? 'partly sheltered from' : 'open to';
    reasons.push(`${word} the forecast ${dirs.slice(0, 4).join(', ')} wind, up to ${Math.round(maxKt)} kt`);
  }
  if (maxKt != null && maxKt > 25) score -= 0.15;
  const ahead = (stay.from - nowT) / 3600;
  if (ahead > 120) {
    score -= 0.2;
    reasons.push(`forecast ${Math.round(ahead / 24)} days out`);
  } else if (ahead > 72) {
    score -= 0.1;
    reasons.push(`forecast ${Math.round(ahead / 24)} days out`);
  }
  if (profile.depthFt != null && profile.depthFt > 0) reasons.push(`about ${Math.round(profile.depthFt)} ft at the charted spot`);
  else {
    score -= 0.1;
    reasons.push('depth at the spot not known');
  }
  if (!spot.charted) score -= 0.05;
  if (spot.name) score += 0.05;
  const level = score >= 0.75 ? 'High' : score >= 0.55 ? 'Medium' : 'Low';
  return { level, score, reasons, maxKt };
}

const fmtShort = (t) =>
  new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// route: [{lat, lon, t}] the route's points with the time the boat is there.
// opts: { depthSource, provider, apiKey, minDepthFt, onProgress }
export async function findHavens(route, opts) {
  const lats = route.map((p) => p.lat);
  const lons = route.map((p) => p.lon);
  const padLat = SEARCH_NM / 60;
  const padLon = SEARCH_NM / (60 * Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180));
  const bbox = [Math.min(...lats) - padLat, Math.min(...lons) - padLon, Math.max(...lats) + padLat, Math.max(...lons) + padLon];
  opts.onProgress?.('Looking up harbours and anchorages…');
  const all = dedupe((await overpass(bbox)).map(classify).filter(Boolean));
  for (const h of all) {
    const n = nearestOnRoute(route, h);
    const a = route[n.i];
    const b = route[n.i + 1] || a;
    Object.assign(h, { off: n.off, along: n.along, t: a.t + (b.t - a.t) * n.f });
  }
  const near = all.filter((h) => h.off <= SEARCH_NM).sort((a, b) => a.off - b.off);
  const ports = near.filter((h) => h.kind === 'port').slice(0, MAX_PORTS).sort((a, b) => a.along - b.along);
  const candidates = near.filter((h) => h.kind === 'anchorage').slice(0, MAX_ANCHORAGES * 2);
  const anchorages = [];
  const excluded = [];
  if (candidates.length) {
    opts.onProgress?.('Checking anchorages for shelter and lee shores…');
    const [profiles, fc] = await Promise.all([
      shelterProfiles(opts.depthSource, candidates),
      opts.provider.getForecast(candidates, () => {}, { apiKey: opts.apiKey }),
    ]);
    const nowT = Date.now() / 1000;
    candidates.forEach((c, k) => {
      const node = fc.nodes[k];
      const wind = { times: fc.times, speed: node.windSpeed, dir: node.windDirection };
      const from = Math.max(c.t, nowT);
      const r = assess(c, profiles[k], wind, { from, to: from + STAY_HOURS * 3600 }, opts.minDepthFt, nowT);
      if (r.excluded) excluded.push({ ...c, reason: r.excluded });
      else anchorages.push({ ...c, ...r, stayFrom: from });
    });
  }
  const order = { High: 0, Medium: 1, Low: 2 };
  anchorages.sort((a, b) => order[a.level] - order[b.level] || a.off - b.off);
  return {
    ports,
    anchorages: anchorages.slice(0, MAX_ANCHORAGES).sort((a, b) => a.along - b.along),
    excluded,
  };
}
