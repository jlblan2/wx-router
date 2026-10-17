import { SECTORS, buildGrid, planRoute, evaluateDirect, findEarliestDeparture } from './router.js';
import { providers } from './providers.js';
import { formatLatLon } from './geo.js';

const $ = (id) => document.getElementById(id);
const STORE = 'wxrouter.settings.v1';

const DEFAULTS = {
  name: '',
  lengthFt: '',
  freeboardFt: '',
  draftFt: '',
  speedKt: 8,
  limitsFt: [4, 4.5, 5, 5, 4.5, 4],
  provider: 'open-meteo',
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {}
}

let settings = loadSettings();
const state = { start: null, dest: null, picking: null, layers: [] };

// ---------- Views ----------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showView(t.dataset.view))
);
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === id));
  if (id === 'routeView') map.invalidateSize();
}
function updateBadge() {
  const s = settings;
  $('vesselBadge').textContent = s.name
    ? `${s.name}${s.lengthFt ? ` · ${s.lengthFt}′` : ''} · ${s.speedKt} kt`
    : '';
}

// ---------- Settings screen ----------
const form = $('settingsForm');
$('limitInputs').innerHTML = SECTORS.map(
  (s, i) => `<label><span>${s.label}<br><span class="range">${s.range} off the bow</span></span>
    <input type="number" step="0.1" min="0" inputmode="decimal" name="limit${i}" required></label>`
).join('');
$('providerSelect').innerHTML = Object.values(providers)
  .map((p) => `<option value="${p.id}">${p.name}</option>`)
  .join('');

function fillForm() {
  for (const k of ['name', 'lengthFt', 'freeboardFt', 'draftFt', 'speedKt', 'provider']) {
    form.elements[k].value = settings[k];
  }
  settings.limitsFt.forEach((v, i) => (form.elements[`limit${i}`].value = v));
  drawDiagram(settings.limitsFt);
}
function readForm() {
  const num = (k) => (form.elements[k].value === '' ? '' : Number(form.elements[k].value));
  return {
    name: form.elements.name.value.trim(),
    lengthFt: num('lengthFt'),
    freeboardFt: num('freeboardFt'),
    draftFt: num('draftFt'),
    speedKt: num('speedKt'),
    provider: form.elements.provider.value,
    limitsFt: SECTORS.map((_, i) => Number(form.elements[`limit${i}`].value)),
  };
}
form.addEventListener('input', () => drawDiagram(readForm().limitsFt));
form.addEventListener('submit', (e) => {
  e.preventDefault();
  settings = readForm();
  saveSettings(settings);
  updateBadge();
  $('savedMsg').hidden = false;
  setTimeout(() => ($('savedMsg').hidden = true), 2000);
});

// Boat seen from above, bow up, with the six sectors on each side.
function drawDiagram(limits) {
  const svg = $('limitsDiagram');
  const max = Math.max(...limits.filter((v) => v > 0), 1);
  const pt = (ang, r) => {
    const a = ((ang - 90) * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  const wedge = (a1, a2, r) => {
    const [x1, y1] = pt(a1, r);
    const [x2, y2] = pt(a2, r);
    return `M0 0 L${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
  };
  let out = '';
  SECTORS.forEach((s, i) => {
    const v = limits[i] || 0;
    const shade = 0.25 + 0.6 * (v / max);
    for (const side of [1, -1]) {
      const a1 = side === 1 ? i * 30 : -(i + 1) * 30;
      const a2 = a1 + 30;
      out += `<path d="${wedge(a1, a2, 100)}" fill="rgba(31,122,153,${shade.toFixed(2)})" stroke="var(--card)" stroke-width="1.5"/>`;
      const [tx, ty] = pt(side * (i * 30 + 15), 76);
      out += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}">${v || '–'}</text>`;
    }
  });
  out += `<path d="M0 -34 C14 -18 14 10 11 30 L-11 30 C-14 10 -14 -18 0 -34 Z" fill="var(--navy)" stroke="#fff" stroke-width="1.5"/>`;
  out += `<text x="0" y="-48" style="font-weight:600">BOW</text>`;
  svg.innerHTML = out;
}

// ---------- Chart ----------
const map = L.map('map', { zoomControl: true }).setView([26.0, -80.0], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: 'Seamarks &copy; OpenSeaMap',
}).addTo(map);

const pinIcon = (color, label) =>
  L.divIcon({
    className: '',
    html: `<div style="background:${color};color:#fff;border:2px solid #fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4)">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
const markers = {};

function setPoint(which, latlng) {
  const p = { lat: latlng.lat, lon: latlng.lng ?? latlng.lon };
  state[which] = p;
  if (markers[which]) markers[which].setLatLng([p.lat, p.lon]);
  else {
    markers[which] = L.marker([p.lat, p.lon], {
      draggable: true,
      icon: pinIcon(which === 'start' ? '#2e8b57' : '#c0392b', which === 'start' ? 'S' : 'D'),
    })
      .addTo(map)
      .on('dragend', (e) => setPoint(which, e.target.getLatLng()));
  }
  $(which === 'start' ? 'startText' : 'destText').textContent = formatLatLon(p);
  clearRoute();
}

function setPicking(which) {
  state.picking = state.picking === which ? null : which;
  $('btnPickStart').classList.toggle('on', state.picking === 'start');
  $('btnPickDest').classList.toggle('on', state.picking === 'dest');
  $('pickHint').hidden = !state.picking;
  $('pickHint').textContent = `Tap the chart to set the ${state.picking === 'start' ? 'start' : 'destination'}`;
}
$('btnPickStart').onclick = () => setPicking('start');
$('btnPickDest').onclick = () => setPicking('dest');
map.on('click', (e) => {
  if (!state.picking) return;
  setPoint(state.picking, e.latlng);
  setPicking(null);
  fitPoints();
});
$('btnLocate').onclick = () => {
  if (!navigator.geolocation) return showError('This device cannot share its location.');
  $('btnLocate').disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('btnLocate').disabled = false;
      setPoint('start', { lat: pos.coords.latitude, lng: pos.coords.longitude });
      fitPoints();
    },
    (err) => {
      $('btnLocate').disabled = false;
      showError(`Could not get your location (${err.message}).`);
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
};
function fitPoints() {
  const pts = [state.start, state.dest].filter(Boolean).map((p) => [p.lat, p.lon]);
  if (pts.length === 2) map.fitBounds(pts, { padding: [40, 40] });
  else if (pts.length === 1) map.panTo(pts[0]);
}

// Default departure: top of the next hour.
(function initDepart() {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  $('departAt').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
})();

// ---------- Planning ----------
function clearRoute() {
  state.layers.forEach((l) => map.removeLayer(l));
  state.layers = [];
  $('result').innerHTML = '';
}
function showError(msg) {
  $('result').innerHTML = `<div class="card bad">${msg}</div>`;
}
function progress(msg) {
  $('progress').hidden = !msg;
  $('progress').textContent = msg || '';
}

$('btnPlan').onclick = async () => {
  clearRoute();
  const problems = [];
  if (!state.start) problems.push('set a start point');
  if (!state.dest) problems.push('set a destination');
  if (!(settings.speedKt > 0)) problems.push('enter a cruise speed in Settings');
  if (!settings.limitsFt.every((v) => v > 0)) problems.push('enter all six sea limits in Settings');
  const departT = Math.floor(new Date($('departAt').value).getTime() / 1000);
  if (!departT) problems.push('choose a departure date and time');
  if (problems.length) return showError(`Please ${problems.join(', ')}.`);

  const vessel = { speedKt: settings.speedKt, limitsFt: settings.limitsFt };
  const provider = providers[settings.provider] || providers['open-meteo'];
  $('btnPlan').disabled = true;
  try {
    progress('Laying out candidate waypoints…');
    const grid = buildGrid(state.start, state.dest);
    const forecast = await provider.getForecast(grid.nodes, progress);
    const { times } = forecast;
    if (departT < times[0] || departT > times[times.length - 1]) {
      return showError(
        `The forecast runs from ${fmtTime(times[0])} to ${fmtTime(times[times.length - 1])}. Pick a departure inside that window.`
      );
    }
    progress('Finding the best route…');
    const route = planRoute(grid, forecast, departT, vessel);
    const direct = evaluateDirect(grid, forecast, departT, vessel);
    if (route.ok) {
      drawRoute(route);
      renderRoute(route, direct, forecast.source);
    } else {
      const later = findEarliestDeparture(grid, forecast, departT, vessel);
      renderNoRoute(route, later, forecast);
      if (later) drawRoute(later, true);
    }
  } catch (e) {
    showError(`Could not get the forecast: ${e.message}. Check the connection and try again.`);
  } finally {
    progress('');
    $('btnPlan').disabled = false;
  }
};

const ratioColor = (r) => (r < 0.7 ? '#2e8b57' : r < 0.9 ? '#d08a00' : '#c0392b');

function drawRoute(route, dashed = false) {
  const pts = [];
  route.legs.forEach((l, i) => {
    if (i === 0) pts.push([l.from.lat, l.from.lon]);
    pts.push([l.to.lat, l.to.lon]);
    const line = L.polyline(
      [
        [l.from.lat, l.from.lon],
        [l.to.lat, l.to.lon],
      ],
      { color: ratioColor(l.worst?.ratio ?? 0), weight: 5, opacity: 0.9, dashArray: dashed ? '8 8' : null }
    ).addTo(map);
    state.layers.push(line);
    if (i > 0) {
      state.layers.push(
        L.circleMarker([l.from.lat, l.from.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#0b3d5c', fillOpacity: 1 })
          .bindTooltip(`WP${i} · ${fmtTime(l.t0)}`)
          .addTo(map)
      );
    }
  });
  map.fitBounds(pts, { padding: [40, 40] });
}

function fmtTime(t) {
  return new Date(t * 1000).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
const fmtDur = (h) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;
const deg3 = (d) => String(Math.round(d) % 360).padStart(3, '0') + '°';

function legsTable(route) {
  const rows = route.legs
    .map((l, i) => {
      const w = l.worst;
      const seas = w
        ? `<span class="dot" style="background:${ratioColor(w.ratio)}"></span>${w.hsFt.toFixed(1)} ft ${SECTORS[w.sector].label.toLowerCase()} (limit ${w.limitFt})`
        : '–';
      const wind = w?.windKt != null ? `${Math.round(w.windKt)} kt from ${deg3(w.windFrom)}` : '–';
      return `<tr><td>${i === 0 ? 'Start' : 'WP' + i}<br><small>${formatLatLon(l.from)}</small></td>
        <td>${fmtTime(l.t0)}</td><td>${deg3(l.heading)}<br>${l.dist.toFixed(1)} nm</td><td>${seas}<br><small>${wind}</small></td></tr>`;
    })
    .join('');
  const last = route.legs[route.legs.length - 1];
  return `<table class="legs"><thead><tr><th>Waypoint</th><th>Depart</th><th>Course</th><th>Worst seas / wind</th></tr></thead>
    <tbody>${rows}<tr><td>Arrive<br><small>${formatLatLon(last.to)}</small></td><td>${fmtTime(last.t1)}</td><td></td><td></td></tr></tbody></table>`;
}

function summaryStats(route) {
  return `<div class="stats">
    <div class="stat"><div class="k">Distance</div><div class="v">${route.distanceNm.toFixed(1)} nm</div></div>
    <div class="stat"><div class="k">Time underway</div><div class="v">${fmtDur((route.arriveT - route.departT) / 3600)}</div></div>
    <div class="stat"><div class="k">Arrive</div><div class="v">${fmtTime(route.arriveT)}</div></div>
    <div class="stat"><div class="k">Worst vs. limit</div><div class="v">${Math.round(route.maxRatio * 100)}%</div></div>
  </div>`;
}

function renderRoute(route, direct, source) {
  let cmp = '';
  if (!direct.ok && direct.reason === 'seas') {
    cmp = `<p class="note">The direct line would put ${direct.worst.hsFt.toFixed(1)} ft ${SECTORS[direct.worst.sector].label.toLowerCase()} on the boat (limit ${direct.worst.limitFt} ft), so this route goes around it.</p>`;
  } else if (!direct.ok && direct.reason === 'land') {
    cmp = `<p class="note">The direct line crosses land or water too close to shore for the forecast, so this route goes around it.</p>`;
  } else if (direct.ok) {
    const extra = route.distanceNm - direct.distanceNm;
    cmp = extra > 0.5
      ? `<p class="note">The direct line is within limits too, but this route adds ${extra.toFixed(1)} nm for a more comfortable ride (worst ${Math.round(direct.maxRatio * 100)}% of limit on the direct line).</p>`
      : `<p class="note">The direct line is within your limits.</p>`;
  }
  $('result').innerHTML = `<div class="card"><h3>Route${settings.name ? ' for ' + escapeHtml(settings.name) : ''}</h3>
    ${summaryStats(route)}${cmp}${legsTable(route)}
    <p class="note">Forecast: ${source}. Colours show the worst seas on each leg against your limit: green under 70%, amber 70–90%, red over 90%.</p>
    <button class="btn" id="btnGpx">Export GPX</button></div>`;
  $('btnGpx').onclick = () => exportGpx(route);
}

function renderNoRoute(route, later, forecast) {
  const why = route.stats.seas
    ? 'the seas forecast along every candidate path exceed your limits'
    : route.stats.beyond
      ? 'the passage runs past the end of the forecast'
      : 'no open-water path was found between the two points';
  let html = `<div class="card bad"><h3>No route within your limits</h3><p>For this departure, ${why}.</p></div>`;
  if (later) {
    html += `<div class="card"><h3>Earliest workable departure: ${fmtTime(later.departT)}</h3>
      ${summaryStats(later)}${legsTable(later)}
      <p class="note">Shown dashed on the chart. Forecast: ${forecast.source}.</p>
      <button class="btn" id="btnUseLater">Use this departure</button></div>`;
  } else {
    html += `<div class="card"><p class="note">No departure in the rest of the forecast (to ${fmtTime(forecast.times[forecast.times.length - 1])}) works with these limits.</p></div>`;
  }
  $('result').innerHTML = html;
  if (later) {
    $('btnUseLater').onclick = () => {
      const d = new Date(later.departT * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      $('departAt').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      $('btnPlan').click();
    };
  }
}

function exportGpx(route) {
  const pts = [route.legs[0].from, ...route.legs.map((l) => l.to)];
  const name = settings.name || 'Wx Router';
  const rtepts = pts
    .map((p, i) => {
      const nm = i === 0 ? 'Start' : i === pts.length - 1 ? 'Destination' : `WP${i}`;
      return `    <rtept lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><name>${nm}</name></rtept>`;
    })
    .join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wx Router" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>${escapeHtml(name)} ${new Date(route.departT * 1000).toISOString().slice(0, 16)}</name>
${rtepts}
  </rte>
</gpx>
`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = 'wx-route.gpx';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Start up ----------
fillForm();
updateBadge();
try {
  if (!localStorage.getItem(STORE)) showView('settingsView');
} catch {}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
