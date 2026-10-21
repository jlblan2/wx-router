// Forecast data sources. Each provider takes a list of {lat, lon} points and
// returns the same shape, so a different service can be dropped in later:
//
//   { source, times: [unix seconds, hourly],
//     nodes: [{ sea, waveHeight[m], waveDirection[deg from], wavePeriod[s],
//               windSpeed[kt], windDirection[deg from], windGust[kt] }] }

const CHUNK = 100;
const DAYS = 7;

// Open-Meteo's free service allows about 600 location-requests a minute per
// connection (each point in a multi-point request counts as one). A long
// route's corridor has hundreds of points and two downloads each, so requests
// are paced to stay under the limit, and a "limit exceeded" answer is waited
// out and retried rather than failing the plan.
const MINUTE_BUDGET = 480;
const LOG_KEY = 'wxrouter.openmeteo.log';
let sent = [];
try {
  sent = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
} catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBudget(n, onProgress) {
  for (;;) {
    const now = Date.now();
    sent = sent.filter(([t]) => now - t < 60000);
    const used = sent.reduce((s, [, k]) => s + k, 0);
    if (used + n <= MINUTE_BUDGET || !sent.length) break;
    // Wait until enough of the last minute's requests have aged out.
    let until = now;
    let left = used;
    for (const [t, k] of sent) {
      left -= k;
      until = t + 60000;
      if (left + n <= MINUTE_BUDGET) break;
    }
    const secs = Math.max(1, Math.ceil((until - now) / 1000));
    onProgress(`Pacing downloads to stay inside the free forecast service's per-minute limit (about ${secs} s)…`);
    await sleep(secs * 1000 + 250);
  }
  sent.push([Date.now(), n]);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(sent));
  } catch {}
}

async function fetchJson(url, n = 1, onProgress = () => {}) {
  for (let attempt = 0; ; attempt++) {
    await waitForBudget(n, onProgress);
    const res = await fetch(url);
    if (res.ok) return res.json();
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).reason || msg;
    } catch {}
    const limited = res.status === 429 || /limit exceeded/i.test(msg);
    if (limited && /minutely/i.test(msg) && attempt < 3) {
      for (let s = 60; s > 0; s -= 5) {
        onProgress(`The free forecast service asked us to slow down; trying again in ${s} s…`);
        await sleep(5000);
      }
      continue;
    }
    const err = new Error(
      limited
        ? `the free forecast service's ${/daily/i.test(msg) ? 'daily' : /hourly/i.test(msg) ? 'hourly' : ''} request limit for this connection has been reached (${msg}). Please try again later`
        : msg
    );
    err.status = res.status;
    throw err;
  }
}

function coordParams(points) {
  const lat = points.map((p) => p.lat.toFixed(4)).join(',');
  const lon = points.map((p) => p.lon.toFixed(4)).join(',');
  return `latitude=${lat}&longitude=${lon}`;
}

async function inChunks(points, fn) {
  const out = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const r = await fn(points.slice(i, i + CHUNK));
    out.push(...(Array.isArray(r) ? r : [r]));
  }
  return out;
}

// Points closer together than the forecast models' own grids give the same
// answer, so nearby points share one download.
const SNAP_DEG = 0.04;
function uniquePoints(points) {
  const keyOf = (p) => `${Math.round(p.lat / SNAP_DEG)},${Math.round(p.lon / SNAP_DEG)}`;
  const index = new Map();
  const unique = [];
  const map = points.map((p) => {
    const k = keyOf(p);
    if (!index.has(k)) {
      index.set(k, unique.length);
      unique.push(p);
    }
    return index.get(k);
  });
  return { unique, map };
}

export const openMeteo = {
  id: 'open-meteo',
  name: 'Open-Meteo (free marine + weather forecast)',
  async getForecast(allPoints, onProgress = () => {}) {
    const { unique: points, map } = uniquePoints(allPoints);
    const marineBase = 'https://marine-api.open-meteo.com/v1/marine';
    const wxBase = 'https://api.open-meteo.com/v1/forecast';
    const common = `timeformat=unixtime&timezone=GMT&forecast_days=${DAYS}`;
    onProgress('Downloading sea state forecast…');
    // cell_selection=nearest leaves wave data empty over land, which the
    // planner uses to keep the route off the beach.
    const marine = await inChunks(points, async (chunk) => {
      const q = `${coordParams(chunk)}&hourly=wave_height,wave_direction,wave_period&${common}`;
      try {
        return await fetchJson(`${marineBase}?${q}&cell_selection=nearest`, chunk.length, onProgress);
      } catch (e) {
        if (e.status === 400) return fetchJson(`${marineBase}?${q}`, chunk.length, onProgress);
        throw e;
      }
    });
    onProgress('Downloading wind forecast…');
    const wind = await inChunks(points, (chunk) =>
      fetchJson(
        `${wxBase}?${coordParams(chunk)}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&${common}`,
        chunk.length,
        onProgress
      )
    );
    const times = marine[0].hourly.time;
    const byPoint = points.map((_, k) => {
      const m = marine[k].hourly;
      const w = wind[k]?.hourly;
      const byTime = new Map((w?.time || []).map((t, i) => [t, i]));
      const align = (arr) => (arr ? times.map((t) => arr[byTime.get(t)] ?? null) : null);
      return {
        sea: m.wave_height.some((v) => v != null),
        waveHeight: m.wave_height,
        waveDirection: m.wave_direction,
        wavePeriod: m.wave_period,
        windSpeed: align(w?.wind_speed_10m),
        windDirection: align(w?.wind_direction_10m),
        windGust: align(w?.wind_gusts_10m),
      };
    });
    // Each lattice point gets its own copy, since the planner marks nodes.
    const nodes = map.map((k) => ({ ...byPoint[k] }));
    return { source: this.name, times, nodes };
  },
};

// Made-up but plausible weather for trying the app without a connection:
// a band of rough seas from the northeast drifts south across the area.
export const demo = {
  id: 'demo',
  name: 'Demo data (made-up weather for trying the app)',
  async getForecast(points) {
    const now = Math.floor(Date.now() / 3600000) * 3600;
    const t0 = now - (now % 86400);
    const times = Array.from({ length: DAYS * 24 }, (_, h) => t0 + h * 3600);
    const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lon0 = points.reduce((s, p) => s + p.lon, 0) / points.length;
    const nodes = points.map((p) => {
      const waveHeight = [];
      const waveDirection = [];
      const wavePeriod = [];
      const windSpeed = [];
      const windDirection = [];
      const windGust = [];
      times.forEach((t, h) => {
        const blobLat = lat0 + 1.2 - h * 0.02;
        const dy = (p.lat - blobLat) * 60;
        const dx = (p.lon - (lon0 + 0.15)) * 60 * Math.cos((p.lat * Math.PI) / 180);
        const blob = Math.exp(-(dx * dx + dy * dy) / (2 * 25 * 25));
        const hs = 0.5 + 2.6 * blob + 0.2 * Math.sin(h / 5);
        waveHeight.push(hs);
        waveDirection.push(45 + 20 * Math.sin(h / 12));
        wavePeriod.push(5 + 3 * blob);
        windSpeed.push(8 + 22 * blob);
        windDirection.push(40 + 15 * Math.sin(h / 12));
        windGust.push(12 + 30 * blob);
      });
      return { sea: true, waveHeight, waveDirection, wavePeriod, windSpeed, windDirection, windGust };
    });
    return { source: this.name, times, nodes };
  },
};

export const providers = { [openMeteo.id]: openMeteo, [demo.id]: demo };
