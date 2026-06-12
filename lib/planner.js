// Core trip planner.
//
// Strategy: estimate how far the user can get in the available time, pull
// scenic POIs from OpenStreetMap in that band, score candidate destinations by
// scenic density, then verify real drive times (Google Routes with live
// traffic when a key is set, OSRM otherwise) and pick the candidate that best
// fills the requested duration. If real durations diverge from the estimate —
// dense traffic, slow roads — the search radius is re-scaled and retried.
// Round trips return via a different scenic waypoint so the loop doesn't
// retrace itself. One-way trips can also pin an explicit destination.

import {
  haversineKm,
  destinationPoint,
  bearingDeg,
  crossTrackKm,
  angleDiff,
} from "./geo.js";
import {
  fetchScenicPois,
  fetchWikiPois,
  routeMatrix,
  routeThrough,
} from "./providers.js";

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

export async function planDrive({ origin, minutes, roundTrip, sightseeing, destination }) {
  if (destination) {
    return planToDestination({ origin, destination, minutes, sightseeing });
  }

  const totalSec = minutes * 60;
  const outSec = roundTrip ? totalSec / 2 : totalSec;
  let radiusKm = ((outSec / 3600) * AVG_KMH) / ROUTE_FACTOR;

  // Find the destination, re-scaling the search radius once if verified drive
  // times come back far from the target (slow roads, heavy traffic).
  let pois = [];
  let poiRadius = 0;
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (radiusKm > poiRadius) {
      try {
        pois = await fetchScenicPois(origin, radiusKm);
        poiRadius = radiusKm;
      } catch {
        // Overpass down — Wikipedia fallback below.
      }
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

    // Verify real drive times in one matrix call, then pick the candidate
    // that is scenic AND closest to the requested duration.
    let durations;
    try {
      durations = await routeMatrix(origin, candidates);
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
        return {
          ...c,
          outDurationSec: dur,
          fit: c.score * Math.max(0.05, 1 - timeErr * 1.8),
          timeErr,
        };
      })
      .filter((c) => c && c.timeErr < 0.45)
      .sort((a, b) => b.fit - a.fit);

    if (ranked[0] && (!best || ranked[0].timeErr < best.timeErr)) {
      best = ranked[0];
      best.searchRadiusKm = radiusKm;
    }
    if (best && best.timeErr <= 0.22) break;

    // Re-scale the radius from observed durations and try once more.
    const valid = durations.filter((d) => d != null).sort((a, b) => a - b);
    if (!valid.length) break;
    const median = valid[Math.floor(valid.length / 2)];
    const scale = outSec / median;
    if (scale > 0.95 && scale < 1.05) break;
    radiusKm = Math.max(8, radiusKm * Math.min(2.5, Math.max(0.35, scale)));
  }

  const dest = best;
  if (!dest) {
    throw new Error(
      "Couldn't find a good destination for that duration. Try a different duration or start point."
    );
  }
  radiusKm = dest.searchRadiusKm;

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

  const stops = sightseeing ? pickStops(pois, origin, dest, radiusKm) : [];

  return finalizePlan({ origin, dest, via, stops, roundTrip, minutes, totalSec });
}

// One-way trip with a user-chosen destination: keep the endpoint fixed and
// make the drive worthwhile with scenic stops along the corridor.
async function planToDestination({ origin, destination, minutes, sightseeing }) {
  const distKm = haversineKm(origin, destination);
  if (distKm < 1) throw new Error("Start and destination are the same place.");

  let stops = [];
  if (sightseeing) {
    let pois = [];
    const mid = {
      lat: (origin.lat + destination.lat) / 2,
      lon: (origin.lon + destination.lon) / 2,
    };
    try {
      pois = await fetchScenicPois(mid, distKm * 0.6 + 10);
    } catch {
      try {
        pois = await fetchWikiPois(mid, distKm * 0.55);
      } catch {}
    }
    stops = pickStops(pois, origin, destination, distKm);
  }

  const dest = { ...destination, kind: destination.kind || "place" };
  return finalizePlan({
    origin,
    dest,
    via: null,
    stops,
    roundTrip: false,
    minutes,
    // The endpoint is fixed, so the time budget only guards stop detours.
    totalSec: null,
  });
}

// Scenic stops along the outbound corridor, spaced out, in driving order.
function pickStops(pois, origin, dest, scaleKm) {
  const corridor = Math.max(8, scaleKm * 0.08);
  const picked = pois.filter(
    (p) =>
      p.name &&
      p !== dest &&
      ["attraction", "viewpoint", "waterfall", "national_park"].includes(p.kind) &&
      crossTrackKm(p, origin, dest) < corridor &&
      haversineKm(origin, p) > scaleKm * 0.15 &&
      haversineKm(p, dest) > 5
  );
  return diversify(scoreByDensity(picked), Math.max(10, scaleKm * 0.12), 3).sort(
    (a, b) => haversineKm(origin, a) - haversineKm(origin, b)
  );
}

// Verify the final route (preview geometry + true totals). If the extras
// (stops, return via) blow the time budget, simplify until the drive fits.
async function finalizePlan({ origin, dest, via, stops, roundTrip, minutes, totalSec }) {
  // Time budget: the requested duration for discovered destinations, or the
  // direct drive plus a stop allowance when the user pinned the destination.
  let budget = totalSec ? totalSec * 1.3 : Infinity;
  if (!totalSec && stops.length) {
    try {
      const direct = await routeThrough([origin, dest]);
      budget = direct.durationSec * 1.35 + 25 * 60;
    } catch {}
  }

  const configs = [{ stops, via }];
  if (stops.length) configs.push({ stops: [], via });
  if (via) configs.push({ stops: [], via: null });

  let route = null;
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const waypoints = [origin, ...cfg.stops, dest];
    if (roundTrip) {
      if (cfg.via) waypoints.push(cfg.via);
      waypoints.push(origin);
    }
    try {
      const r = await routeThrough(waypoints);
      if (r.durationSec <= budget || i === configs.length - 1) {
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
      : dest.outDurationSec
        ? Math.round((dest.outDurationSec * (roundTrip ? 2 : 1)) / 60)
        : null,
    distanceKm: route ? Math.round(route.distanceKm) : null,
    geometry: route ? route.geometry : null,
    liveTraffic: Boolean(process.env.GOOGLE_MAPS_API_KEY),
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
