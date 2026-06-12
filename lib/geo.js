// Geometry helpers (all distances in km, angles in degrees)

const R = 6371;

export function toRad(d) {
  return (d * Math.PI) / 180;
}

export function toDeg(r) {
  return (r * 180) / Math.PI;
}

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Point at `distanceKm` from `origin` along `bearingDeg`
export function destinationPoint(origin, bearingDeg, distanceKm) {
  const δ = distanceKm / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

export function bearingDeg(from, to) {
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lon - from.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Perpendicular distance (km) from point p to the great-circle segment a->b.
// Points behind a or beyond b get their distance to the nearest endpoint, so
// places in the opposite direction can't sneak into a route corridor.
export function crossTrackKm(p, a, b) {
  if (angleDiff(bearingDeg(a, p), bearingDeg(a, b)) > 90) return haversineKm(a, p);
  if (angleDiff(bearingDeg(b, p), bearingDeg(b, a)) > 90) return haversineKm(b, p);
  const d13 = haversineKm(a, p) / R;
  const θ13 = toRad(bearingDeg(a, p));
  const θ12 = toRad(bearingDeg(a, b));
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12)) * R);
}

export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
