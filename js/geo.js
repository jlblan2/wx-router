// Great-circle helpers. Distances in nautical miles, angles in degrees true.
const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distanceNm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
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

// Point a fraction f of the way along the great circle from a to b.
export function interpolate(a, b, f) {
  return destinationPoint(a, bearingDeg(a, b), distanceNm(a, b) * f);
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
