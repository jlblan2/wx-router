// Forecast data sources. Each provider takes a list of {lat, lon} points and
// returns the same shape, so a different service can be dropped in later:
//
//   { source, times: [unix seconds, hourly],
//     nodes: [{ sea, waveHeight[m], waveDirection[deg from], wavePeriod[s],
//               windSpeed[kt], windDirection[deg from], windGust[kt] }] }

const CHUNK = 80;
const DAYS = 7;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).reason || msg;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
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

export const openMeteo = {
  id: 'open-meteo',
  name: 'Open-Meteo (free marine + weather forecast)',
  async getForecast(points, onProgress = () => {}) {
    const marineBase = 'https://marine-api.open-meteo.com/v1/marine';
    const wxBase = 'https://api.open-meteo.com/v1/forecast';
    const common = `timeformat=unixtime&timezone=GMT&forecast_days=${DAYS}`;
    onProgress('Downloading sea state forecast…');
    // cell_selection=nearest leaves wave data empty over land, which the
    // planner uses to keep the route off the beach.
    const marine = await inChunks(points, async (chunk) => {
      const q = `${coordParams(chunk)}&hourly=wave_height,wave_direction,wave_period&${common}`;
      try {
        return await fetchJson(`${marineBase}?${q}&cell_selection=nearest`);
      } catch (e) {
        if (e.status === 400) return fetchJson(`${marineBase}?${q}`);
        throw e;
      }
    });
    onProgress('Downloading wind forecast…');
    const wind = await inChunks(points, (chunk) =>
      fetchJson(
        `${wxBase}?${coordParams(chunk)}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&${common}`
      )
    );
    const times = marine[0].hourly.time;
    const nodes = points.map((_, k) => {
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
