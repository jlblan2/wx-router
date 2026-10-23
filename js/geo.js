// Navigation helpers. Distances in nautical miles, angles in degrees true.
const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Routes are rhumb lines: a constant compass course, which is what the boat
// steers and what the chart (Mercator) draws as a straight line, so depth
// samples, the drawn route and the course all follow the same track.
const merc = (latDeg) => Math.log(Math.tan(Math.PI / 4 + rad(latDeg) / 2));
const dLonRad = (a, b) => {
  let d = rad(b.lon - a.lon);
  if (Math.abs(d) > Math.PI) d = d > 0 ? d - 2 * Math.PI : d + 2 * Math.PI;
  return d;
};

export function distanceNm(a, b) {
  const dPhi = rad(b.lat - a.lat);
  const dPsi = merc(b.lat) - merc(a.lat);
  const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(rad(a.lat));
  return Math.hypot(dPhi, q * dLonRad(a, b)) * R_NM;
}

export function bearingDeg(a, b) {
  const dPsi = merc(b.lat) - merc(a.lat);
  return (deg(Math.atan2(dLonRad(a, b), dPsi)) + 360) % 360;
}

export function destinationPoint(p, bearing, distNm) {
  const d = distNm / R_NM;
  const b = rad(bearing);
  const lat1 = rad(p.lat);
  const lon1 = rad(p.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: deg(lat2), lon: ((deg(lon2) + 540) % 360) - 180 };
}

// Point a fraction f of the way along the rhumb line from a to b.
export function interpolate(a, b, f) {
  const lat = a.lat + (b.lat - a.lat) * f;
  const dl = deg(dLonRad(a, b));
  const dPsi = merc(b.lat) - merc(a.lat);
  const g = Math.abs(dPsi) > 1e-12 ? (merc(lat) - merc(a.lat)) / dPsi : f;
  return { lat, lon: ((a.lon + dl * g + 540) % 360) - 180 };
}

export function formatLatLon(p) {
  const fmt = (v, pos, neg) => {
    const h = v >= 0 ? pos : neg;
    const av = Math.abs(v);
    const d = Math.floor(av);
    const m = (av - d) * 60;
    return `${d}°${m.toFixed(2).padStart(5, '0')}'${h}`;
  };
  return `${fmt(p.lat, 'N', 'S')} ${fmt(p.lon, 'E', 'W')}`;
}
