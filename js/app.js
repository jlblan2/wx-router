import { SECTORS, buildGrid, planRoute, evaluateDirect, scanDepartures, directPath, isQuiet } from './router.js';
import { noaaDepth, noaaCoastalDepth, demoDepth, DepthChecker, planWithDepth, deepWaterPath, COASTAL_NM } from './depth.js';
import { providers } from './providers.js';
import { formatLatLon, distanceNm } from './geo.js';
import { findHavens, SEARCH_NM } from './havens.js';

const $ = (id) => document.getElementById(id);
const STORE = 'wxrouter.settings.v1';

const DEFAULTS = {
  name: '',
  vesselType: 'motor',
  noGoDeg: 45,
  noGoWindKt: 8,
  lengthFt: '',
  freeboardFt: '',
  draftFt: '',
  speedKt: 8,
  // Eight points around the vessel, clockwise from the bow (see SECTORS).
  limitsFt: [4, 4.5, 5, 5, 4, 5, 5, 4.5],
  windLimitsKt: [20, 22, 25, 25, 25, 25, 25, 22],
  minDepthFt: 6,
  steepHsFt: 6,
  steepPeriodS: 6,
  quietOn: false,
  quietStart: '18:00',
  quietEnd: '08:00',
  provider: 'open-meteo',
  openMeteoKey: '',
};

function loadSettings() {
  try {
    return migrate({ ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') });
  } catch {
    return { ...DEFAULTS };
  }
}
// Settings saved before the eight-point change had six sea limits, port and
// starboard shared (0–30°, 30–60°, 60–90°, 90–120°, 120–150°, 150–180° off the bow).
function migrate(s) {
  const old = s.limitsFt;
  if (Array.isArray(old) && old.length === 6) {
    const beam = Math.min(old[2], old[3]);
    s.limitsFt = [old[0], old[1], beam, old[4], old[5], old[4], beam, old[1]];
  }
  if (!Array.isArray(s.windLimitsKt) || s.windLimitsKt.length !== 8) s.windLimitsKt = [...DEFAULTS.windLimitsKt];
  // Settings saved before the depth setting: draft plus 3 ft, if a draft was entered.
  if (!('minDepthSet' in s)) {
    if (s.draftFt > 0) s.minDepthFt = Math.round((Number(s.draftFt) + 3) * 10) / 10;
    s.minDepthSet = true;
  }
  return s;
}
function saveSettings(s) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {}
}

let settings = loadSettings();
const state = { start: null, dest: null, via: [], wantVia: false, picking: null, layers: [], plan: null };

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
    ? `${s.vesselType === 'sail' ? '⛵ ' : ''}${s.name}${s.lengthFt ? ` · ${s.lengthFt}′` : ''} · ${s.speedKt} kt`
    : '';
}

// ---------- Settings screen ----------
const form = $('settingsForm');
const limitFields = (prefix, step) =>
  SECTORS.map(
    (s, i) => `<label><span>${s.label}<br><span class="range">${s.range} off the bow</span></span>
    <input type="number" step="${step}" min="0" inputmode="decimal" name="${prefix}${i}" required></label>`
  ).join('');
$('seaInputs').innerHTML = limitFields('limit', 0.1);
$('windInputs').innerHTML = limitFields('wind', 1);
$('providerSelect').innerHTML = Object.values(providers)
  .map((p) => `<option value="${p.id}">${p.name}</option>`)
  .join('');

function fillForm() {
  for (const k of ['name', 'vesselType', 'noGoDeg', 'noGoWindKt', 'lengthFt', 'freeboardFt', 'draftFt', 'minDepthFt', 'speedKt', 'steepHsFt', 'steepPeriodS', 'quietStart', 'quietEnd', 'provider', 'openMeteoKey']) {
    form.elements[k].value = settings[k];
  }
  form.elements.quietOn.checked = !!settings.quietOn;
  showQuietTimes();
  showSailOpts();
  settings.limitsFt.forEach((v, i) => (form.elements[`limit${i}`].value = v));
  settings.windLimitsKt.forEach((v, i) => (form.elements[`wind${i}`].value = v));
  drawDiagrams(settings);
}
function readForm() {
  const num = (k) => (form.elements[k].value === '' ? '' : Number(form.elements[k].value));
  return {
    name: form.elements.name.value.trim(),
    vesselType: form.elements.vesselType.value,
    noGoDeg: num('noGoDeg'),
    noGoWindKt: num('noGoWindKt'),
    lengthFt: num('lengthFt'),
    freeboardFt: num('freeboardFt'),
    draftFt: num('draftFt'),
    minDepthFt: num('minDepthFt'),
    minDepthSet: true,
    speedKt: num('speedKt'),
    steepHsFt: num('steepHsFt'),
    steepPeriodS: num('steepPeriodS'),
    quietOn: form.elements.quietOn.checked,
    quietStart: form.elements.quietStart.value || DEFAULTS.quietStart,
    quietEnd: form.elements.quietEnd.value || DEFAULTS.quietEnd,
    provider: form.elements.provider.value,
    openMeteoKey: form.elements.openMeteoKey.value.trim(),
    limitsFt: SECTORS.map((_, i) => Number(form.elements[`limit${i}`].value)),
    windLimitsKt: SECTORS.map((_, i) => Number(form.elements[`wind${i}`].value)),
  };
}
form.addEventListener('input', () => drawDiagrams(readForm()));
function showQuietTimes() {
  const on = form.elements.quietOn.checked;
  $('quietTimes').hidden = !on;
  form.elements.quietStart.required = form.elements.quietEnd.required = on;
}
form.elements.quietOn.addEventListener('change', showQuietTimes);
function showSailOpts() {
  const sail = form.elements.vesselType.value === 'sail';
  $('sailOpts').hidden = $('sailNote').hidden = !sail;
  form.elements.noGoDeg.required = form.elements.noGoWindKt.required = sail;
}
form.elements.vesselType.addEventListener('change', showSailOpts);
const isSail = () => settings.vesselType === 'sail';

// No-cruise hours as the planner wants them, or null when off.
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};
function quietHours(s = settings) {
  return s.quietOn ? { start: toMinutes(s.quietStart), end: toMinutes(s.quietEnd) } : null;
}
const quietText = (s = settings) => `${s.quietStart} to ${s.quietEnd}`;
form.addEventListener('submit', (e) => {
  e.preventDefault();
  settings = readForm();
  saveSettings(settings);
  updateBadge();
  $('savedMsg').hidden = false;
  setTimeout(() => ($('savedMsg').hidden = true), 2000);
});

function drawDiagrams(s) {
  drawDiagram($('seaDiagram'), s.limitsFt, '31,122,153');
  drawDiagram($('windDiagram'), s.windLimitsKt, '92,107,192');
}

// Boat seen from above, bow up, with a 45° wedge for each of the eight points.
function drawDiagram(svg, limits, rgb) {
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
    out += `<path d="${wedge(i * 45 - 22.5, i * 45 + 22.5, 100)}" fill="rgba(${rgb},${shade.toFixed(2)})" stroke="var(--card)" stroke-width="1.5"/>`;
    const [tx, ty] = pt(i * 45, 74);
    out += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}">${v || '–'}</text>`;
  });
  out += `<path d="M0 -34 C14 -18 14 10 11 30 L-11 30 C-14 10 -14 -18 0 -34 Z" fill="var(--navy)" stroke="#fff" stroke-width="1.5"/>`;
  out += `<text x="0" y="-44" style="font-weight:600;font-size:9px">BOW</text>`;
  svg.innerHTML = out;
}

// ---------- Chart ----------
const map = L.map('map', { zoomControl: true, minZoom: 3, maxZoom: 18 }).setView([26.0, -80.0], 7);
// Tiles stay put while zooming and keep a wider ring loaded, so zooming and
// panning on a phone don't leave blank squares.
const tileOpts = { updateWhenZooming: false, keepBuffer: 4 };
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  ...tileOpts,
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
// OpenSeaMap's buoys, lights, rocks, wrecks and other chart symbols. Its tiles
// start at zoom 6 and stop at 18.
const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  ...tileOpts,
  minZoom: 6,
  maxZoom: 18,
  attribution: 'Seamarks &copy; <a href="https://map.openseamap.org/legend.php" target="_blank" rel="noopener">OpenSeaMap</a>',
}).addTo(map);
L.control.layers(null, { 'Chart symbols (OpenSeaMap)': seamarks }, { position: 'bottomleft' }).addTo(map);
// The chart shares the screen with the route sheet, and phone toolbars come and
// go; keep Leaflet's idea of the chart size in step so tiles fill it.
if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe($('map'));

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
  state.cache = null;
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
  $('btnPickVia').classList.toggle('on', state.picking === 'via');
  $('btnPickVia').textContent = state.picking === 'via' ? 'Done' : 'Add on chart';
  $('pickHint').hidden = !state.picking;
  $('pickHint').textContent =
    state.picking === 'via'
      ? `Tap the chart to add waypoint ${state.via.length + 1}`
      : `Tap the chart to set the ${state.picking === 'start' ? 'start' : 'destination'}`;
}

// ---------- Intermediate waypoints ----------
// Only used when the captain says yes to waypoints; the route passes through
// them in the order they were added.
const activeVia = () => (state.wantVia ? state.via : []);

function setWantVia(yes) {
  state.wantVia = yes;
  $('btnViaYes').classList.toggle('on', yes);
  $('btnViaNo').classList.toggle('on', !yes);
  $('btnViaYes').setAttribute('aria-pressed', yes);
  $('btnViaNo').setAttribute('aria-pressed', !yes);
  $('viaPanel').hidden = !yes;
  if (!yes && state.picking === 'via') setPicking(null);
  if (yes && !state.via.length) setPicking('via');
  renderVia();
  state.cache = null;
  clearRoute();
}
$('btnViaYes').onclick = () => setWantVia(true);
$('btnViaNo').onclick = () => setWantVia(false);
$('btnPickVia').onclick = () => setPicking('via');

function renderVia() {
  (markers.via || []).forEach((m) => map.removeLayer(m));
  markers.via = activeVia().map((p, i) =>
    L.marker([p.lat, p.lon], { draggable: true, icon: pinIcon('#0b3d5c', String(i + 1)) })
      .addTo(map)
      .on('dragend', (e) => {
        const ll = e.target.getLatLng();
        state.via[i] = { lat: ll.lat, lon: ll.lng };
        state.cache = null;
        clearRoute();
        renderVia();
      })
  );
  $('viaList').innerHTML = state.via
    .map((p, i) => `<li><span>${formatLatLon(p)}</span> <button class="btn small" data-i="${i}" aria-label="Remove waypoint ${i + 1}">Remove</button></li>`)
    .join('');
  $('viaList').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.via.splice(Number(b.dataset.i), 1);
      state.cache = null;
      clearRoute();
      renderVia();
    })
  );
  if (state.picking === 'via') $('pickHint').textContent = `Tap the chart to add waypoint ${state.via.length + 1}`;
}
$('btnPickStart').onclick = () => setPicking('start');
$('btnPickDest').onclick = () => setPicking('dest');
map.on('click', (e) => {
  if (!state.picking) return;
  if (state.picking === 'via') {
    // Stay in this mode so several waypoints can be added in a row.
    state.via.push({ lat: e.latlng.lat, lon: e.latlng.lng });
    state.cache = null;
    clearRoute();
    renderVia();
    return;
  }
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
  const pts = [state.start, ...activeVia(), state.dest].filter(Boolean).map((p) => [p.lat, p.lon]);
  if (pts.length >= 2) map.fitBounds(pts, { padding: [40, 40] });
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
  state.plan = null;
  state.lastScan = null;
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
  if (!settings.limitsFt.every((v) => v > 0)) problems.push('enter all eight sea limits in Settings');
  if (!settings.windLimitsKt.every((v) => v > 0)) problems.push('enter all eight wind limits in Settings');
  if (!(settings.minDepthFt > 0)) problems.push('enter a minimum water depth in Settings');
  const departT = Math.floor(new Date($('departAt').value).getTime() / 1000);
  if (!departT) problems.push('choose a departure date and time');
  if (problems.length) return showError(`Please ${problems.join(', ')}.`);

  const vessel = {
    speedKt: settings.speedKt,
    limitsFt: settings.limitsFt,
    windLimitsKt: settings.windLimitsKt,
    steep: { hsFt: Number(settings.steepHsFt), periodS: Number(settings.steepPeriodS) },
    quiet: quietHours(),
    sail: isSail() ? { noGoDeg: Number(settings.noGoDeg), minWindKt: Number(settings.noGoWindKt) } : null,
  };
  const provider = providers[settings.provider] || providers['open-meteo'];
  $('btnPlan').disabled = true;
  try {
    progress('Laying out candidate waypoints…');
    const deep = await routeStops(provider);
    const { grid, forecast } = await getForecast(provider, deep.via);
    const { times } = forecast;
    if (departT < times[0] || departT > times[times.length - 1]) {
      return showError(
        `The forecast runs from ${fmtTime(times[0])} to ${fmtTime(times[times.length - 1])}. Pick a departure inside that window.`
      );
    }
    progress('Finding the best route and checking every departure time…');
    await new Promise((r) => setTimeout(r, 0)); // let the message paint
    const fromT = Math.min(departT, Date.now() / 1000);
    let route, scan;
    const plan = (edgeOk) => {
      route = planRoute(grid, forecast, departT, vessel, { edgeOk });
      scan = scanDepartures(grid, forecast, vessel, { fromT, edgeOk });
      return [route.ok ? route : null, ...scan.slots.map((sl) => sl.route)];
    };
    const checker = getDepthChecker(provider);
    let depthNote = '';
    let directShallow = false;
    try {
      if (!checker.nodesChecked) {
        progress('Checking water depth…');
        await checker.checkNodes(grid.nodes);
      }
      checker.markSheltered(forecast);
      const res = await planWithDepth(checker, grid.nodes, plan, progress);
      if (!res.complete) depthNote = 'Some legs could not be depth-checked in time and were left out, so the route may be longer than needed.';
      const path = directPath(grid);
      await checker.check(path.slice(1).map((n, i) => [path[i], n]));
      directShallow = path.slice(1).some((n, i) => !checker.edgeOk(path[i], n));
    } catch (e) {
      // Without depths, water with no sea forecast can't be told from land.
      forecast.nodes.forEach((n) => (n.sheltered = false));
      plan(() => true);
      state.depthChecker = null;
      depthNote = `<strong>Water depth was not checked</strong> (${escapeHtml(e.message)}). Check this route against a chart for shallow water before you go.`;
    }
    const direct = evaluateDirect(grid, forecast, departT, vessel);
    if (route.ok) {
      drawRoute(route);
      renderRoute(route, direct, forecast.source, directShallow);
      state.plan = { route, departT, source: forecast.source };
    } else {
      const later = scan.slots.find((sl) => sl.status === 'go' && sl.t > departT)?.route || null;
      progress('Working out which limits are in the way…');
      // Would the weather allow it if not for the no-cruise hours?
      const free = vessel.quiet && route.stats.quiet ? planRoute(grid, forecast, departT, { ...vessel, quiet: null }, { edgeOk: state.depthChecker?.edgeOk }) : null;
      const quietOnly = free?.ok ? free : null;
      const least = quietOnly ? null : await leastBadRoute(grid, forecast, departT, vessel);
      renderNoRoute(route, later, forecast, least, quietOnly, departT);
      if (later) drawRoute(later, true);
      drawProblems(least);
      state.plan = { route: later, departT, source: forecast.source, alternative: !!later };
    }
    renderWindows(scan, departT, forecast);
    recordCheck(scan);
    showHavens(state.plan.route || null, departT, provider);
    if (depthNote) $('result').insertAdjacentHTML('afterbegin', `<div class="card bad">${depthNote}</div>`);
  } catch (e) {
    showError(`Could not get the forecast: ${escapeHtml(e.message)}.${/request limit/.test(e.message) ? '' : ' Check the connection and try again.'}`);
  } finally {
    progress('');
    $('btnPlan').disabled = false;
  }
};

// The forecast for a start/destination pair is reused for 30 minutes, so
// trying other departure times doesn't download it again.
async function getForecast(provider, via = activeVia()) {
  const key = JSON.stringify([state.start, via, state.dest, provider.id]);
  const c = state.cache;
  if (c && c.key === key && Date.now() - c.at < 30 * 60 * 1000) return c;
  const grid = buildGrid(state.start, state.dest, { via });
  const forecast = await provider.getForecast(grid.nodes, progress, { apiKey: settings.openMeteoKey });
  state.cache = { key, at: Date.now(), grid, forecast };
  return state.cache;
}

// The captain's waypoints, plus turns that take each stretch around water
// shallower than the minimum depth where the straight way is blocked.
// blocked: stretches with no deep-water way through at all.
async function routeStops(provider) {
  const user = activeVia();
  const source = provider.id === 'demo' ? demoDepth : noaaDepth;
  const min = Number(settings.minDepthFt);
  const key = JSON.stringify([state.start, user, state.dest, min, source.name]);
  if (state.deep?.key === key) return state.deep;
  const pts = [state.start, ...user, state.dest];
  const via = [];
  let turns = 0;
  let blocked = 0;
  let failed = null;
  for (let i = 0; i < pts.length - 1; i++) {
    if (i) via.push(user[i - 1]);
    try {
      const t = await deepWaterPath(pts[i], pts[i + 1], min, source, progress);
      if (t === null) blocked++;
      else {
        via.push(...t.map((p) => ({ ...p, auto: true })));
        turns += t.length;
      }
    } catch (e) {
      failed = e.message; // the depth checks later will say depth wasn't checked
    }
  }
  state.deep = { key, via, turns, blocked, failed };
  return state.deep;
}

// Depth results are kept with the forecast, so re-planning only checks new legs.
function getDepthChecker(provider) {
  const demo = provider.id === 'demo';
  const source = demo ? demoDepth : noaaDepth;
  const coastal = demo ? demoDepth : noaaCoastalDepth;
  const min = Number(settings.minDepthFt);
  const c = state.depthChecker;
  if (!c || c.cacheKey !== state.cache.key || c.minDepthFt !== min || c.source !== source) {
    state.depthChecker = Object.assign(new DepthChecker(source, min, coastal), { cacheKey: state.cache.key });
  }
  return state.depthChecker;
}

function setDepart(t) {
  const d = new Date(t * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  $('departAt').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Go/no-go timeline of departure times across the forecast, the windows when
// the passage works, and the departure with the quickest safe route.
function renderWindows(scan, departT, forecast) {
  const { slots, windows, best } = scan;
  if (!slots.length) return;
  const t0 = slots[0].t;
  const span = slots[slots.length - 1].t + scan.step - t0;
  const pct = (t) => (((t - t0) / span) * 100).toFixed(2);
  const bar = slots
    .map((sl) => `<div class="slot ${sl.status}" style="left:${pct(sl.t)}%;width:${((scan.step / span) * 100).toFixed(2)}%" data-t="${sl.t}" title="${fmtTime(sl.t)}: ${{ go: 'within limits', nogo: 'outside limits', unknown: 'beyond forecast', quiet: 'no-cruise hours' }[sl.status]}"></div>`)
    .join('');
  // Midnight ticks with day names.
  let ticks = '';
  const d = new Date(t0 * 1000);
  d.setHours(24, 0, 0, 0);
  for (let t = d.getTime() / 1000; t < t0 + span; t += 86400) {
    ticks += `<div class="tick" style="left:${pct(t)}%"><span>${new Date(t * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span></div>`;
  }
  const marker = departT >= t0 && departT < t0 + span ? `<div class="marker" style="left:${pct(departT)}%" title="Your departure"></div>` : '';
  const fmtWin = (w) =>
    w.start === w.end ? `${fmtTime(w.start)} only` : `${fmtTime(w.start)} to ${fmtTime(w.end)}`;
  const list = windows.length
    ? `<ul class="windows">${windows.map((w) => `<li>${fmtWin(w)}</li>`).join('')}</ul>`
    : `<p>No departure in the forecast keeps the passage within your limits.</p>`;
  const unknownFrom = slots.find((sl) => sl.status === 'unknown');
  const bestHtml = best
    ? `<p><strong>Best departure: ${fmtTime(best.departT)}</strong>, arriving ${fmtTime(best.arriveT)} (${fmtDur((best.arriveT - best.departT) / 3600)}${best.stops ? ` including ${best.stops === 1 ? 'an overnight stop' : `${best.stops} overnight stops`}` : ''}, worst ${Math.round(best.maxRatio * 100)}% of your limits).</p>
       <button class="btn" id="btnUseBest">Use best departure</button>`
    : '';
  $('result').insertAdjacentHTML(
    'afterbegin',
    `<div class="card"><h3>When can you go?</h3>
      <p class="note">Each hour you could leave, checked against your limits for the whole passage. Tap a green hour to plan that departure.</p>
      <div class="timeline">${bar}${ticks}${marker}</div>
      <div class="legend"><span><i class="go"></i>Within limits</span><span><i class="nogo"></i>Outside limits</span><span><i class="unknown"></i>Forecast too short</span>${slots.some((sl) => sl.status === 'quiet') ? '<span><i class="quiet"></i>Would cruise in your no-cruise hours</span>' : ''}</div>
      <h4>Departure windows</h4>${list}${bestHtml}
      ${unknownFrom ? `<p class="note">Departures from ${fmtTime(unknownFrom.t)} on would arrive after the forecast ends (${fmtTime(forecast.times[forecast.times.length - 1])}), so they can't be judged yet.</p>` : ''}
    </div>`
  );
  document.querySelectorAll('.timeline .slot.go').forEach((el) =>
    el.addEventListener('click', () => {
      setDepart(Number(el.dataset.t));
      $('btnPlan').click();
    })
  );
  if (best) {
    $('btnUseBest').onclick = () => {
      setDepart(best.departT);
      $('btnPlan').click();
    };
  }
}

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
          .bindTooltip(`${pointLabel(l.from, i, false)} · ${fmtTime(l.t0)}`)
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

// Course changes are WP1, WP2…; the captain's own waypoints keep their number.
function pointLabel(node, i, last) {
  if (node.via && !node.auto) return `Your waypoint ${node.via}`;
  return i === 0 ? 'Start' : last ? 'Destination' : `WP${i}`;
}

function legsTable(route) {
  const rows = route.legs
    .map((l, i) => {
      const w = l.worst;
      const seas = w && !w.sea
        ? 'Sheltered water (no sea forecast)'
        : w
        ? `<span class="dot" style="background:${ratioColor(w.ratio)}"></span>${w.hsFt.toFixed(1)} ft${w.periodS != null ? ` @ ${Math.round(w.periodS)}s` : ''} ${SECTORS[w.sea.sector].short} (limit ${w.sea.limit})`
        : '–';
      const wind = w?.wind
        ? `${Math.round(w.windKt)} kt ${SECTORS[w.wind.sector].short} (limit ${w.wind.limit})`
        : '–';
      const dep = state.depthChecker?.legShallowest(l);
      const near = state.depthChecker?.legCoastal(l) ? ', near shore' : '';
      const depth = dep != null ? `<br><small>shallowest ${Math.round(dep)} ft${near}</small>` : '';
      const stop = l.stopFrom
        ? `<tr class="stop"><td colspan="4">Overnight stop at ${pointLabel(l.from, i, false).toLowerCase()}: arrive ${fmtTime(l.stopFrom)}, leave ${fmtTime(l.t0)}</td></tr>`
        : '';
      const sog = l.dist / l.hrs;
      const cur = Math.abs(sog - settings.speedKt) >= 0.2
        ? `<br><small>${sog.toFixed(1)} kt over ground (current ${sog > settings.speedKt ? '+' : '−'}${Math.abs(sog - settings.speedKt).toFixed(1)})</small>`
        : '';
      return `${stop}<tr><td>${pointLabel(l.from, i, false)}<br><small>${formatLatLon(l.from)}</small></td>
        <td>${fmtTime(l.t0)}</td><td>${deg3(l.heading)}<br>${l.dist.toFixed(1)} nm${cur}${depth}</td><td>${seas}<br><small>${wind}</small></td></tr>`;
    })
    .join('');
  const last = route.legs[route.legs.length - 1];
  return `<table class="legs"><thead><tr><th>Waypoint</th><th>Depart</th><th>Course</th><th>Worst seas / wind</th></tr></thead>
    <tbody>${rows}<tr><td>Arrive<br><small>${formatLatLon(last.to)}</small></td><td>${fmtTime(last.t1)}</td><td></td><td></td></tr></tbody></table>`;
}

function summaryStats(route) {
  return `<div class="stats">
    <div class="stat"><div class="k">Distance</div><div class="v">${route.distanceNm.toFixed(1)} nm</div></div>
    <div class="stat"><div class="k">Time underway</div><div class="v">${fmtDur(route.underwayHrs ?? (route.arriveT - route.departT) / 3600)}</div></div>
    ${route.stops ? `<div class="stat"><div class="k">Overnight stops</div><div class="v">${route.stops}</div></div>` : ''}
    <div class="stat"><div class="k">Arrive</div><div class="v">${fmtTime(route.arriveT)}</div></div>
    <div class="stat"><div class="k">Worst vs. limit</div><div class="v">${Math.round(route.maxRatio * 100)}%</div></div>
    ${shallowestStat(route)}
  </div>`;
}

function shallowestStat(route) {
  const ds = route.legs.map((l) => state.depthChecker?.legShallowest(l)).filter((d) => d != null);
  if (!ds.length) return '';
  return `<div class="stat"><div class="k">Shallowest water</div><div class="v">${Math.round(Math.min(...ds))} ft</div></div>`;
}

// Which depth data the route was checked against.
function depthSourceNote(route) {
  const dc = state.depthChecker;
  if (!dc) return '';
  const coastal = route.legs.some((l) => dc.legCoastal(l));
  let text = `Depths: ${dc.source.name}`;
  if (coastal) text += `; within ${COASTAL_NM} nm of shore, ${dc.coastal.name}, checked every 100 yards`;
  if (dc.coastalError) text += `. High-resolution coastal depths could not be loaded (${escapeHtml(dc.coastalError)}), so the standard depths were used near shore`;
  return `<p class="note">${text}.</p>`;
}

function renderRoute(route, direct, source, directShallow = false) {
  let cmp = '';
  if (state.deep?.turns) {
    cmp = `<p class="note">Water shallower than your ${settings.minDepthFt} ft minimum blocks the direct way, so the route was laid out around it through deep water (${state.deep.turns} turn${state.deep.turns === 1 ? '' : 's'} added).</p>`;
  } else if (directShallow) {
    cmp = `<p class="note">The direct line crosses water shallower than your ${settings.minDepthFt} ft minimum, so this route goes around it.</p>`;
  } else if (!direct.ok && direct.reason === 'seas') {
    const w = direct.worst;
    cmp = `<p class="note">The direct line would put ${w.hsFt.toFixed(1)} ft seas ${SECTORS[w.sea.sector].short} (limit ${w.sea.limit} ft), so this route goes around it.</p>`;
  } else if (!direct.ok && direct.reason === 'steep') {
    const w = direct.worst;
    cmp = `<p class="note">The direct line runs through ${w.hsFt.toFixed(1)} ft seas only ${Math.round(w.periodS)} seconds apart, so this route goes around them.</p>`;
  } else if (!direct.ok && direct.reason === 'wind') {
    const w = direct.worst;
    cmp = `<p class="note">The direct line would put ${Math.round(w.windKt)} kt of wind ${SECTORS[w.wind.sector].short} (limit ${w.wind.limit} kt), so this route goes around it.</p>`;
  } else if (!direct.ok && direct.reason === 'beat') {
    cmp = `<p class="note">The direct line points too close to the wind to sail, so this route reaches across it instead.</p>`;
  } else if (!direct.ok && direct.reason === 'current') {
    cmp = `<p class="note">The current across the direct line is too strong to hold that course at your speed, so this route goes another way.</p>`;
  } else if (!direct.ok && direct.reason === 'land') {
    cmp = `<p class="note">The direct line crosses land or water too close to shore for the forecast, so this route goes around it.</p>`;
  } else if (direct.ok) {
    const extra = route.distanceNm - direct.distanceNm;
    const saved = (direct.underwayHrs - route.underwayHrs) * 60;
    cmp = extra > 0.5 && saved >= 5
      ? `<p class="note">This route is ${extra.toFixed(1)} nm longer than the direct line but ${fmtDur(saved / 60)} quicker, by making better use of the current.</p>`
      : extra > 0.5
      ? `<p class="note">This route is ${extra.toFixed(1)} nm longer than the direct line, the least extra that keeps within your limits.</p>`
      : `<p class="note">The direct line is within your limits.</p>`;
  }
  $('result').innerHTML = `<div class="card"><h3>Route${settings.name ? ' for ' + escapeHtml(settings.name) : ''}</h3>
    ${summaryStats(route)}${cmp}${legsTable(route)}
    ${depthSourceNote(route)}
    <p class="note">Forecast: ${source}. Colours show the worst seas or wind on each leg against your limits: green under 70%, amber 70–90%, red over 90%.</p>
    <button class="btn" id="btnGpx">Export GPX</button></div>`;
  $('btnGpx').onclick = () => exportGpx(route);
}

// The path that goes over the limits least, so we can say which limits are in
// the way, by how much, and where.
async function leastBadRoute(grid, forecast, departT, vessel) {
  const dc = state.depthChecker;
  const opts = {
    relaxed: true,
    edgeOk: dc ? dc.edgeOk : () => true,
    edgeDepth: dc ? dc.edgeDepth : undefined,
    minDepthFt: Number(settings.minDepthFt),
  };
  let least = planRoute(grid, forecast, departT, vessel, opts);
  if (least.ok && dc) {
    try {
      // Make sure the depth along this path is known before describing it.
      if (await dc.check(least.legs.flatMap((l) => l.edges))) least = planRoute(grid, forecast, departT, vessel, opts);
    } catch {}
  }
  return least;
}

// One line per limit gone over: the worst case, where and when.
function explainViolations(least) {
  const groups = new Map();
  for (const v of least.violations) {
    const key = v.kind + (v.sector ?? '');
    const g = groups.get(key);
    if (!g) groups.set(key, { ...v, count: 1 });
    else {
      g.count++;
      if (v.over > g.over) Object.assign(g, v, { count: g.count });
    }
  }
  const order = { depth: 0, steep: 1, seas: 2, wind: 3, beat: 4 };
  const where = (v) => (v.at ? ` near ${formatLatLon(v.at)}` : '');
  const when = (v) => (v.kind === 'depth' ? '' : `, ${fmtTime(v.t)}`);
  const items = [...groups.values()]
    .sort((a, b) => order[a.kind] - order[b.kind] || b.over - a.over)
    .map((v) => {
      if (v.kind === 'seas') {
        return `<li><strong>Seas ${SECTORS[v.sector].short}:</strong> ${v.value.toFixed(1)} ft against your ${v.limit} ft limit, <strong>${(v.value - v.limit).toFixed(1)} ft over</strong>${where(v)}${when(v)}.</li>`;
      }
      if (v.kind === 'wind') {
        return `<li><strong>Wind ${SECTORS[v.sector].short}:</strong> ${Math.round(v.value)} kt against your ${v.limit} kt limit, <strong>${Math.round(v.value - v.limit)} kt over</strong>${where(v)}${when(v)}.</li>`;
      }
      if (v.kind === 'beat') {
        return `<li><strong>Too close to the wind to sail:</strong> heading ${Math.round(v.value)}° off a ${Math.round(v.windKt)} kt wind, inside your ${v.limit}° limit${where(v)}${when(v)}.</li>`;
      }
      if (v.kind === 'steep') {
        return `<li><strong>Steep, short seas:</strong> ${v.value.toFixed(1)} ft waves ${Math.round(v.periodS)} seconds apart, over your ${v.limit} ft at ${settings.steepPeriodS} s rule by <strong>${(v.value - v.limit).toFixed(1)} ft</strong>${where(v)}${when(v)}.</li>`;
      }
      return v.value != null
        ? `<li><strong>Water depth:</strong> ${Math.max(0, Math.round(v.value))} ft against your ${v.limit} ft minimum, <strong>${Math.round(v.limit - Math.max(0, v.value))} ft too shallow</strong>${where(v)}.</li>`
        : `<li><strong>Water depth:</strong> shallower than your ${v.limit} ft minimum${where(v)}.</li>`;
    });
  return `<p>Even the best path for this departure goes over these limits:</p><ul class="violations">${items.join('')}</ul>
    <p class="note">Red dots on the chart mark where. Changing any of these limits in Settings, or leaving at a different time, may open a route.</p>`;
}

function drawProblems(least) {
  if (!least?.ok) return;
  const pts = least.legs.flatMap((l, i) => (i === 0 ? [l.from, l.to] : [l.to]));
  state.layers.push(L.polyline(pts.map((p) => [p.lat, p.lon]), { color: '#c0392b', weight: 2, opacity: 0.6, dashArray: '2 6' }).addTo(map));
  for (const v of least.violations) {
    if (!v.at) continue;
    const label = { seas: 'Seas over limit', wind: 'Wind over limit', steep: 'Steep, short seas', depth: 'Too shallow', beat: 'Too close to the wind' }[v.kind];
    state.layers.push(
      L.circleMarker([v.at.lat, v.at.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#c0392b', fillOpacity: 0.9 })
        .bindTooltip(label)
        .addTo(map)
    );
  }
}

function renderNoRoute(route, later, forecast, least, quietOnly, departT) {
  const st = route.stats;
  const hit = [st.seas && 'seas', st.wind && 'wind', st.steep && 'steep, short seas', st.beat && 'headings too close to the wind to sail'].filter(Boolean);
  const why = quietOnly
    ? isQuiet(quietHours(), quietOnly.departT)
      ? `the departure time is inside your no-cruise hours (${quietText()})`
      : `the passage takes about ${fmtDur(quietOnly.underwayHrs)} underway and can't be finished before your no-cruise hours start at ${settings.quietStart}${activeVia().length ? '' : '. Leave earlier, or add your own waypoints where you can anchor; the route will stop there overnight and go on the next morning'}`
    : hit.length
    ? `every candidate path runs into ${hit.join(' or ')} beyond your limits`
    : state.deep?.blocked
      ? `there is no way through water at least ${settings.minDepthFt} ft deep within reach of the route, even going well around the shallows. Lower the minimum depth in Settings if your boat can take it, or move the start or destination`
      : st.shallow
      ? `every candidate path crosses water shallower than your ${settings.minDepthFt} ft minimum`
    : route.stats.beyond
      ? 'the passage runs past the end of the forecast'
      : state.depthChecker
        ? `no water path deep enough (${settings.minDepthFt} ft) was found between the two points. If you're starting or finishing up a narrow or winding river, the planner can't follow the channel yet; set that end at the river mouth or inlet and try again`
        : 'no open-water path was found between the two points. Water depth could not be checked, so rivers and other water without a sea forecast could not be used';
  const detail = !quietOnly && least?.ok && least.violations.length ? explainViolations(least) : '';
  const alsoQuiet = !quietOnly && isQuiet(quietHours(), departT) ? ` This departure time is also inside your no-cruise hours (${quietText()}).` : '';
  let html = `<div class="card bad"><h3>No route within your limits</h3><p>For this departure, ${why}.${alsoQuiet}</p>${detail}</div>`;
  if (later) {
    html += `<div class="card"><h3>Earliest workable departure: ${fmtTime(later.departT)}</h3>
      ${summaryStats(later)}${legsTable(later)}
      <p class="note">Shown dashed on the chart. Forecast: ${forecast.source}.</p>
      <button class="btn" id="btnUseLater">Use this departure</button></div>`;
  }
  $('result').innerHTML = html;
  if (later) {
    $('btnUseLater').onclick = () => {
      setDepart(later.departT);
      $('btnPlan').click();
    };
  }
}

function exportGpx(route) {
  const pts = [route.legs[0].from, ...route.legs.map((l) => l.to)];
  const name = settings.name || 'Wx Router';
  const rtepts = pts
    .map((p, i) => {
      const nm = pointLabel(p, i, i === pts.length - 1);
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

// ---------- Clear ----------
$('btnClear').onclick = () => {
  clearRoute();
  for (const which of ['start', 'dest']) {
    if (markers[which]) map.removeLayer(markers[which]);
    markers[which] = null;
    state[which] = null;
  }
  state.cache = null;
  $('startText').textContent = 'Not set';
  $('destText').textContent = 'Not set';
  setPicking(null);
  state.via = [];
  setWantVia(false);
};

// ---------- Safe havens ----------
// Harbours and anchorages within reach of the route, listed under it and
// marked on the chart. Runs after the route is shown, so it never holds it up.
function routePoints(route, departT) {
  if (route) return [{ ...route.legs[0].from, t: route.legs[0].t0 }, ...route.legs.map((l) => ({ lat: l.to.lat, lon: l.to.lon, t: l.t1 }))];
  // No workable route: the straight line through the captain's points.
  const pts = [state.start, ...activeVia(), state.dest];
  let t = departT;
  return pts.map((p, i) => {
    if (i) t += (distanceNm(pts[i - 1], p) / Number(settings.speedKt)) * 3600;
    return { lat: p.lat, lon: p.lon, t };
  });
}

// High-resolution depths around each anchorage for finding the shore, falling
// back to the standard depths.
const havenDepth = (provider) =>
  provider.id === 'demo'
    ? demoDepth
    : {
        async getDepthsFt(pts) {
          try {
            return await noaaCoastalDepth.getDepthsFt(pts);
          } catch {
            return noaaDepth.getDepthsFt(pts);
          }
        },
      };


async function showHavens(route, departT, provider) {
  const run = (state.havenRun = (state.havenRun || 0) + 1);
  $('result').insertAdjacentHTML(
    'beforeend',
    `<div class="card havens" id="havensCard"><h3>Safe havens near the route</h3><p class="note" id="havensMsg">Looking for harbours and anchorages within ${SEARCH_NM} nm…</p></div>`
  );
  try {
    const res = await findHavens(routePoints(route, departT), {
      depthSource: havenDepth(provider),
      provider,
      apiKey: settings.openMeteoKey,
      minDepthFt: Number(settings.minDepthFt),
      onProgress: (m) => run === state.havenRun && $('havensMsg') && ($('havensMsg').textContent = m),
    });
    if (run !== state.havenRun || !$('havensCard')) return; // the route changed meanwhile
    renderHavens(res);
  } catch (e) {
    if (run !== state.havenRun || !$('havensCard')) return;
    $('havensMsg').textContent = `Couldn't look up harbours and anchorages (${e.message}). Try planning again later.`;
  }
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const levelColor = { High: '#2e8b57', Medium: '#d08a00', Low: '#c0392b' };

function renderHavens({ ports, anchorages, excluded }) {
  const label = (h) => escapeHtml(h.name || (h.kind === 'port' ? 'Unnamed harbour' : 'Unnamed anchorage'));
  const where = (h) => `${h.off < 0.5 ? 'On the route' : `${h.off.toFixed(1)} nm off the route`}, ${Math.round(h.along)} nm along`;
  const cat = (h) => (h.category ? ` <small>(${escapeHtml(h.category.replace(/_/g, ' '))})</small>` : '');
  const add = (h) => `<button class="btn small" data-haven="${h.id}">Add as waypoint</button>`;
  const portHtml = ports.length
    ? `<ul class="havens-list">${ports.map((h) => `<li><strong>${label(h)}</strong>${cat(h)}<br><small>${where(h)}</small> ${add(h)}</li>`).join('')}</ul>`
    : `<p class="note">No charted harbours or marinas within ${SEARCH_NM} nm.</p>`;
  const anchHtml = anchorages.length
    ? `<ul class="havens-list">${anchorages
        .map(
          (h) => `<li><strong>${label(h)}</strong>${cat(h)} <span class="conf" style="background:${levelColor[h.level]}">${h.level} confidence</span><br>
          <small>${where(h)}. ${escapeHtml(cap(h.reasons.join('; ')))}. Judged for ${fmtTime(h.stayFrom)} to 12 h later.</small> ${add(h)}</li>`
        )
        .join('')}</ul>`
    : `<p class="note">No charted anchorages within ${SEARCH_NM} nm that stay off a lee shore in the forecast.</p>`;
  const exHtml = excluded.length
    ? `<details><summary>${excluded.length} anchorage${excluded.length === 1 ? '' : 's'} left out</summary><ul class="havens-list">${excluded
        .map((h) => `<li>${label(h)}: ${escapeHtml(h.reason)}</li>`)
        .join('')}</ul></details>`
    : '';
  $('havensCard').innerHTML = `<h3>Safe havens near the route</h3>
    <h4>Safe haven ports</h4>${portHtml}
    <h4>Anchorages</h4>${anchHtml}${exHtml}
    <p class="note">Harbours and anchorages come from OpenSeaMap chart data. Anchorages on a lee shore (open water upwind and the shore close downwind in 10 kt or more of forecast wind) are left out. Confidence weighs shelter from the forecast wind over a 12 hour stay from when you'd reach it, how far ahead the forecast is, and the depth data. Always confirm on a chart and with local knowledge.</p>`;
  const byId = new Map([...ports, ...anchorages].map((h) => [h.id, h]));
  $('havensCard').querySelectorAll('[data-haven]').forEach((b) => (b.onclick = () => addHavenAsWaypoint(byId.get(b.dataset.haven))));
  for (const h of [...ports, ...anchorages]) {
    const color = h.kind === 'port' ? '#1f7a99' : levelColor[h.level];
    const icon = L.divIcon({
      className: '',
      html: `<div class="haven-pin" style="background:${color}">${h.kind === 'port' ? 'H' : '⚓'}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    state.layers.push(
      L.marker([h.lat, h.lon], { icon })
        .bindTooltip(`${label(h)}${h.level ? ` · ${h.level} confidence` : ''}`)
        .addTo(map)
    );
  }
}

// Put the haven into the waypoint list where it adds the least distance.
function addHavenAsWaypoint(h) {
  if (!h) return;
  const p = { lat: h.lat, lon: h.lon };
  const via = activeVia();
  const pts = [state.start, ...via, state.dest];
  let bestI = 0;
  let bestAdd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const add = distanceNm(pts[i], p) + distanceNm(p, pts[i + 1]) - distanceNm(pts[i], pts[i + 1]);
    if (add < bestAdd) [bestAdd, bestI] = [add, i];
  }
  state.via = [...via];
  state.via.splice(bestI, 0, p);
  setWantVia(true);
  fitPoints();
  $('result').innerHTML = `<div class="card">${escapeHtml(h.name || (h.kind === 'port' ? 'That harbour' : 'That anchorage'))} is now waypoint ${bestI + 1}. Tap <strong>Plan route</strong> to plan through it.</div>`;
}

// ---------- Saved routes ----------
// Start, waypoints and destination are kept on this phone so a passage can be
// checked again against later forecasts. Each check's best departure is kept
// with the route to show whether conditions are getting better or worse.
const ROUTES = 'wxrouter.routes.v1';
const MAX_CHECKS = 10;

function loadRoutes() {
  try {
    return JSON.parse(localStorage.getItem(ROUTES) || '[]');
  } catch {
    return [];
  }
}
function saveRoutes(list) {
  try {
    localStorage.setItem(ROUTES, JSON.stringify(list));
  } catch {}
}
const roundPt = (p) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 });
const routeKey = (start, via, dest) => JSON.stringify([start, ...via, dest].map(roundPt));
const currentKey = () => (state.start && state.dest ? routeKey(state.start, activeVia(), state.dest) : null);

$('btnSave').onclick = () => {
  if (!state.start || !state.dest) return showError('Set a start and a destination before saving the route.');
  const list = loadRoutes();
  const key = currentKey();
  const existing = list.find((r) => routeKey(r.start, r.via, r.dest) === key);
  const name = prompt('Name for this route', existing?.name || `Route ${list.length + 1}`);
  if (name == null) return;
  if (existing) existing.name = name.trim() || existing.name;
  else {
    list.push({
      id: Date.now().toString(36),
      name: name.trim() || `Route ${list.length + 1}`,
      start: roundPt(state.start),
      via: activeVia().map(roundPt),
      dest: roundPt(state.dest),
      savedAt: Math.floor(Date.now() / 1000),
      checks: [],
    });
  }
  saveRoutes(list);
  if (state.lastScan) recordCheck(state.lastScan);
  renderSaved();
  $('savedBox').open = true;
};

// After each plan: if this is a saved route, remember what the forecast allowed.
function recordCheck(scan) {
  state.lastScan = scan;
  const list = loadRoutes();
  const r = list.find((x) => routeKey(x.start, x.via, x.dest) === currentKey());
  if (!r) return;
  const b = scan.best;
  r.checks.push({
    at: Math.floor(Date.now() / 1000),
    goHours: scan.slots.filter((sl) => sl.status === 'go').length,
    quietHours: scan.slots.filter((sl) => sl.status === 'quiet').length,
    best: b ? { departT: b.departT, arriveT: b.arriveT, maxRatio: b.maxRatio } : null,
  });
  r.checks = r.checks.slice(-MAX_CHECKS);
  saveRoutes(list);
  renderSaved();
}

function describeCheck(c) {
  if (!c) return 'Not checked yet.';
  const when = `Checked ${fmtTime(c.at)}: `;
  if (!c.best) return when + (c.quietHours ? 'no departure fits both your limits and your cruising hours in the forecast.' : 'no departure within your limits in the forecast.');
  return when + `best departure ${fmtTime(c.best.departT)} (worst ${Math.round(c.best.maxRatio * 100)}% of limits), ${c.goHours} workable departure hour${c.goHours === 1 ? '' : 's'}.`;
}
// Better or worse than the check before, by the number of workable hours and how close to the limits.
function trend(checks) {
  const [a, b] = checks.slice(-2);
  if (!a || !b) return '';
  const score = (c) => (c.best ? 1 + c.goHours / 200 - c.best.maxRatio / 2 : 0);
  const d = score(b) - score(a);
  return Math.abs(d) < 0.02 ? 'About the same as the check before.' : d > 0 ? 'Better than the check before.' : 'Worse than the check before.';
}

function renderSaved() {
  const list = loadRoutes();
  $('savedCount').textContent = list.length;
  $('savedList').innerHTML = list.length
    ? list
        .map((r) => {
          const last = r.checks[r.checks.length - 1];
          const stops = r.via.length ? ` · ${r.via.length} waypoint${r.via.length === 1 ? '' : 's'}` : '';
          return `<li><div class="name">${escapeHtml(r.name)}</div>
            <div class="meta">${formatLatLon(r.start)} to ${formatLatLon(r.dest)}${stops}<br>${describeCheck(last)} ${trend(r.checks)}</div>
            <div class="acts"><button class="btn" data-check="${r.id}">Check now</button><button class="btn" data-del="${r.id}">Delete</button></div></li>`;
        })
        .join('')
    : '<li class="meta">No saved routes yet. Set up a route, then tap Save this route.</li>';
  $('savedList').querySelectorAll('[data-check]').forEach((b) => (b.onclick = () => openSaved(b.dataset.check)));
  $('savedList').querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = () => {
        const r = list.find((x) => x.id === b.dataset.del);
        if (!r || !confirm(`Delete the saved route "${r.name}"?`)) return;
        saveRoutes(list.filter((x) => x !== r));
        renderSaved();
      })
  );
}

// Load a saved route and plan it from the next hour, so the departure windows
// show every time the latest forecast allows.
function openSaved(id) {
  const r = loadRoutes().find((x) => x.id === id);
  if (!r) return;
  setPicking(null);
  state.via = r.via.map((p) => ({ ...p }));
  setWantVia(state.via.length > 0);
  setPoint('start', r.start);
  setPoint('dest', r.dest);
  fitPoints();
  setDepart(Math.ceil(Date.now() / 3600000) * 3600);
  $('btnPlan').click();
  $('result').scrollIntoView?.({ behavior: 'smooth' });
}

// ---------- Print ----------
$('btnPrint').onclick = () => {
  $('printReport').innerHTML = buildReport();
  window.print();
};

function buildReport() {
  const s = settings;
  const v = (x, unit) => (x === '' || x == null ? '–' : `${x} ${unit}`);
  const limitRows = SECTORS.map(
    (sec, i) => `<tr><td>${sec.label} (${sec.range})</td><td>${v(s.limitsFt[i], 'ft')}</td><td>${v(s.windLimitsKt[i], 'kt')}</td></tr>`
  ).join('');
  const provider = providers[s.provider]?.name || s.provider;
  let html = `<h1>Wx Router${s.name ? ' · ' + escapeHtml(s.name) : ''}</h1>
    <p class="printed">Printed ${new Date().toLocaleString()}</p>
    <h2>Vessel settings</h2>
    <table class="kv">
      <tr><td>Vessel name</td><td>${escapeHtml(s.name || '–')}</td></tr>
      <tr><td>Vessel type</td><td>${s.vesselType === 'sail' ? `Sail (no closer than ${s.noGoDeg}° to the wind once it reaches ${s.noGoWindKt} kt)` : 'Motor'}</td></tr>
      <tr><td>Length</td><td>${v(s.lengthFt, 'ft')}</td></tr>
      <tr><td>Freeboard</td><td>${v(s.freeboardFt, 'ft')}</td></tr>
      <tr><td>Draft</td><td>${v(s.draftFt, 'ft')}</td></tr>
      <tr><td>Minimum water depth</td><td>${v(s.minDepthFt, 'ft')}</td></tr>
      <tr><td>Cruise speed</td><td>${v(s.speedKt, 'kt')}</td></tr>
      <tr><td>Steep, short seas</td><td>avoid waves over ${s.steepHsFt} ft at ${s.steepPeriodS} s or less</td></tr>
      <tr><td>No-cruise hours</td><td>${s.quietOn ? quietText(s) : 'none'}</td></tr>
      <tr><td>Forecast source</td><td>${escapeHtml(provider)}</td></tr>
    </table>
    <h3>Limits by direction off the bow</h3>
    <table class="grid"><thead><tr><th>Direction</th><th>Max seas</th><th>Max wind</th></tr></thead><tbody>${limitRows}</tbody></table>
    <h2>Route</h2>
    <table class="kv">
      <tr><td>Start</td><td>${state.start ? formatLatLon(state.start) : 'Not set'}</td></tr>
      ${activeVia().map((p, i) => `<tr><td>Your waypoint ${i + 1}</td><td>${formatLatLon(p)}</td></tr>`).join('')}
      <tr><td>Destination</td><td>${state.dest ? formatLatLon(state.dest) : 'Not set'}</td></tr>
      <tr><td>Departure asked for</td><td>${$('departAt').value ? fmtTime(new Date($('departAt').value).getTime() / 1000) : '–'}</td></tr>
    </table>`;
  if (!state.plan) {
    return html + `<p>No route planned yet. Tap <strong>Plan route</strong> before printing to include it.</p>`;
  }
  if (state.plan.route) html += routeSketch(state.plan.route);
  // Reuse what's on screen, minus the buttons.
  const copy = $('result').cloneNode(true);
  copy.querySelectorAll('button').forEach((b) => b.remove());
  return html + copy.innerHTML;
}

// Simple outline of the route with labelled waypoints (chart tiles don't print reliably).
function routeSketch(route) {
  const pts = [route.legs[0].from, ...route.legs.map((l) => l.to)];
  const k = Math.cos((pts.reduce((a, p) => a + p.lat, 0) / pts.length) * (Math.PI / 180));
  const xs = pts.map((p) => p.lon * k);
  const ys = pts.map((p) => -p.lat);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 600, H = 260, pad = 30;
  const sc = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  const ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * sc) / 2;
  const P = pts.map((_, i) => [ox + (xs[i] - x0) * sc, oy + (ys[i] - y0) * sc]);
  const labels = pts.map((p, i) => pointLabel(p, i, i === pts.length - 1));
  return `<svg class="sketch" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#eef5f8" stroke="#9bb"/>
    <polyline points="${P.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#0b3d5c" stroke-width="3"${state.plan.alternative ? ' stroke-dasharray="8 6"' : ''}/>
    ${P.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5" fill="${i === 0 ? '#2e8b57' : i === P.length - 1 ? '#c0392b' : '#0b3d5c'}"/><text x="${(p[0] + 8).toFixed(1)}" y="${(p[1] - 6).toFixed(1)}" font-size="12">${labels[i]}</text>`).join('')}
    <text x="${W - 8}" y="18" font-size="12" text-anchor="end">N ↑</text>
  </svg>`;
}

// ---------- Exit ----------
// A web app can only close its own window in some browsers, so if it is
// still open a moment later, show a closed screen with how to leave.
$('btnExit').onclick = () => {
  window.close();
  setTimeout(() => {
    if (!window.closed) $('exitScreen').hidden = false;
  }, 300);
};
$('btnReturn').onclick = () => ($('exitScreen').hidden = true);

// ---------- Start up ----------
fillForm();
updateBadge();
renderSaved();
try {
  if (!localStorage.getItem(STORE)) showView('settingsView');
} catch {}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
