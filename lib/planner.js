// Core trip planner.
//
// Strategy: estimate how far the user can get in the available time, pull
// scenic POIs from OpenStreetMap in that band, score candidate destinations by
// scenic density, then verify real drive times with OSRM and pick the
// candidate that best fills the requested duration. Round trips return via a
// different scenic waypoint so the loop doesn't retrace itself.

import {
  haversineKm,
  destinationPoint,
  bearingDeg,
  crossTrackKm,
  angleDiff,
} from "./geo.js";
import { fetchScenicPois, fetchWikiPois, osrmTable, osrmRoute } from "./providers.js";

const AVG_KMH = 62; // blended average speed for non-highway scenic driving
const ROUTE_FACTOR = 1.3; // road distance vs straight-line distance

const KIND_WEIGHT = {
  national_park: 5,
  nature_reserve: 3,
  viewpoint: 3,
  waterfall: 3,
  beach: 3,
  peak: 2,
  attraction: 1,
  place: 1,
};

export async function planDrive({ origin, minutes, roundTrip, sightseeing }) {
  const totalSec = minutes * 60;
  const outSec = roundTrip ? totalSec / 2 : totalSec;
  const radiusKm = ((outSec / 3600) * AVG_KMH) / ROUTE_FACTOR;

  let pois = [];
  try {
    pois = await fetchScenicPois(origin, radiusKm);
  } catch {
    // Overpass down — Wikipedia fallback below.
  }

  const inBand = (p) => {
    const d = haversineKm(origin, p);
    return d > radiusKm * 0.55 && d < radiusKm * 1.15;
  };

  // Candidate destinations: scenic POIs in the 55%–115% radius band. If OSM
  // gave us nothing there, fall back to notable places from Wikipedia.
  let band = pois.filter(inBand);
  if (band.length < 3) {
    try {
      const wiki = await fetchWikiPois(origin, radiusKm);
      pois = pois.concat(wiki);
      band = pois.filter(inBand);
    } catch {
      // Both sources down — compass-ring fallback below still works.
    }
  }

  let candidates = scoreByDensity(band).filter((c) => c.name);
  candidates = diversify(candidates, Math.max(20, radiusKm * 0.25), 8);

  // Fallback: plain compass-ring points if OSM gave us nothing usable.
  if (candidates.length === 0) {
    candidates = [0, 45, 90, 135, 180, 225, 270, 315].map((b) => ({
      ...destinationPoint(origin, b, radiusKm),
      name: "Turnaround point",
      kind: "place",
      score: 1,
    }));
  }

  // Verify real drive times in one OSRM matrix call, then pick the candidate
  // that is scenic AND closest to the requested duration.
  let durations;
  try {
    durations = await osrmTable(origin, candidates);
  } catch {
    durations = candidates.map(
      (c) => (haversineKm(origin, c) * ROUTE_FACTOR * 3600) / AVG_KMH
    );
  }

  const ranked = candidates
    .map((c, i) => {
      const dur = durations[i];
      if (dur == null) return null;
      const timeErr = Math.abs(dur - outSec) / outSec;
      return { ...c, outDurationSec: dur, fit: c.score * Math.max(0.05, 1 - timeErr * 1.8), timeErr };
    })
    .filter((c) => c && c.timeErr < 0.45)
    .sort((a, b) => b.fit - a.fit);

  const dest = ranked[0];
  if (!dest) {
    throw new Error(
      "Couldn't find a good destination for that duration. Try a different duration or start point."
    );
  }

  // Round trip: return through a scenic via-point off the outbound bearing.
  let via = null;
  if (roundTrip) {
    const outBearing = bearingDeg(origin, dest);
    via = scoreByDensity(
      pois.filter((p) => {
        const d = haversineKm(origin, p);
        const bDiff = angleDiff(bearingDeg(origin, p), outBearing);
        return d > radiusKm * 0.3 && d < radiusKm * 0.85 && bDiff > 20 && bDiff < 75;
      })
    ).filter((p) => p.name)[0] || null;
  }

  // Optional sightseeing stops along the outbound corridor.
  let stops = [];
  if (sightseeing) {
    stops = pois
      .filter(
        (p) =>
          p.name &&
          p !== dest &&
          ["attraction", "viewpoint", "waterfall", "national_park"].includes(p.kind) &&
          crossTrackKm(p, origin, dest) < Math.max(8, radiusKm * 0.08) &&
          haversineKm(origin, p) > radiusKm * 0.15 &&
          haversineKm(p, dest) > 5
      )
      .sort((a, b) => haversineKm(origin, a) - haversineKm(origin, b));
    stops = diversify(scoreByDensity(stops), Math.max(10, radiusKm * 0.12), 3).sort(
      (a, b) => haversineKm(origin, a) - haversineKm(origin, b)
    );
  }

  // Final verified route for the preview map and true totals. If the extras
  // (stops, return via) blow the time budget, simplify until the drive fits.
  const configs = [{ stops, via }];
  if (stops.length) configs.push({ stops: [], via });
  if (via) configs.push({ stops: stops.length ? [] : stops, via: null });
  let route = null;
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const waypoints = [origin, ...cfg.stops, dest];
    if (roundTrip) {
      if (cfg.via) waypoints.push(cfg.via);
      waypoints.push(origin);
    }
    try {
      const r = await osrmRoute(waypoints);
      if (r.durationSec <= totalSec * 1.3 || i === configs.length - 1) {
        route = r;
        stops = cfg.stops;
        via = cfg.via;
        break;
      }
    } catch {
      break; // Preview is optional; the Google Maps link still works.
    }
  }

  return {
    origin,
    destination: pick(dest),
    via: via ? pick(via) : null,
    stops: stops.map(pick),
    roundTrip,
    requestedMinutes: minutes,
    estimatedMinutes: route
      ? Math.round(route.durationSec / 60)
      : Math.round((dest.outDurationSec * (roundTrip ? 2 : 1)) / 60),
    distanceKm: route ? Math.round(route.distanceKm) : null,
    geometry: route ? route.geometry : null,
    googleMapsUrl: buildGoogleMapsUrl({ origin, dest, via, stops, roundTrip }),
  };
}

function pick(p) {
  return { lat: p.lat, lon: p.lon, name: p.name, kind: p.kind };
}

// Score each POI by its own weight plus nearby scenic density (clusters of
// viewpoints/parks beat an isolated pin).
function scoreByDensity(points) {
  return points
    .map((p) => {
      let density = 0;
      for (const q of points) {
        if (q !== p && haversineKm(p, q) < 15) density++;
      }
      return { ...p, score: (KIND_WEIGHT[p.kind] || 1) + Math.min(density, 12) * 0.6 };
    })
    .sort((a, b) => b.score - a.score);
}

// Keep top-scored points that are at least `minKm` apart.
function diversify(sorted, minKm, max) {
  const out = [];
  for (const p of sorted) {
    if (out.every((q) => haversineKm(p, q) >= minKm)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

function buildGoogleMapsUrl({ origin, dest, via, stops, roundTrip }) {
  const fmt = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const o = fmt(origin);
  const wps = [...stops.map(fmt)];
  let destination;
  if (roundTrip) {
    wps.push(fmt(dest));
    if (via) wps.push(fmt(via));
    destination = o;
  } else {
    destination = fmt(dest);
  }
  const params = new URLSearchParams({
    api: "1",
    origin: o,
    destination,
    travelmode: "driving",
  });
  if (wps.length) params.set("waypoints", wps.join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
