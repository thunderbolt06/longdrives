// External data providers. Everything here works without API keys:
//  - Nominatim (OpenStreetMap) for geocoding
//  - Overpass API for scenic points of interest
//  - OSRM demo server for drive-time routing
// If GOOGLE_MAPS_API_KEY is set, geocoding upgrades to Google's Geocoding API.

import { destinationPoint } from "./geo.js";

const UA = "longdrives/1.0 (scenic drive planner; github.com/thunderbolt06/longdrives)";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function geocode(query) {
  const gkey = process.env.GOOGLE_MAPS_API_KEY;
  if (gkey) {
    const data = await fetchJson(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${gkey}`
    );
    const r = data.results?.[0];
    if (!r) return null;
    return {
      lat: r.geometry.location.lat,
      lon: r.geometry.location.lng,
      name: r.formatted_address,
    };
  }
  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`
  );
  const r = data?.[0];
  if (!r) return null;
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name: r.display_name };
}

export async function reverseGeocode(lat, lon) {
  try {
    const data = await fetchJson(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`
    );
    return data?.display_name || null;
  } catch {
    return null;
  }
}

const POINT_TAGS = [
  '["tourism"="viewpoint"]',
  '["natural"="waterfall"]',
  '["natural"="peak"]["name"]',
  '["natural"="beach"]["name"]',
];

// Fetch scenic POIs around the start: one cheap node-only Overpass query
// (point features index fast; area/relation queries proved too slow on the
// public servers). Callers should fall back to fetchWikiPois on failure.
export async function fetchScenicPois(origin, radiusKm) {
  let query;
  if (radiusKm <= 280) {
    const bbox = bboxAround(origin, radiusKm * 1.15);
    query = `[out:json][timeout:15][bbox:${bbox}];(${POINT_TAGS.map((t) => `node${t};`).join("")});out 500;`;
  } else {
    // Very long drives: a full-area query would time Overpass out, so sample
    // discs on a ring at the target radius.
    const discR = Math.round(Math.min(radiusKm * 0.4, 90) * 1000);
    const around = [];
    for (let i = 0; i < 8; i++) {
      const p = destinationPoint(origin, i * 45, radiusKm);
      for (const t of POINT_TAGS.slice(0, 3)) {
        around.push(`node${t}(around:${discR},${p.lat.toFixed(4)},${p.lon.toFixed(4)});`);
      }
    }
    query = `[out:json][timeout:15];(${around.join("")});out 500;`;
  }
  return runOverpass(query);
}

// Keyless fallback POI source: Wikipedia GeoSearch sampled at points on the
// destination ring and a mid ring. Articles with coordinates are a decent
// proxy for "places worth driving to".
export async function fetchWikiPois(origin, radiusKm) {
  const points = [];
  for (let i = 0; i < 12; i++) {
    points.push(destinationPoint(origin, i * 30, radiusKm * 0.85));
  }
  for (let i = 0; i < 6; i++) {
    points.push(destinationPoint(origin, i * 60 + 30, radiusKm * 0.5));
  }
  const settled = await Promise.allSettled(
    points.map((p) =>
      fetchJson(
        `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${p.lat.toFixed(4)}%7C${p.lon.toFixed(4)}&gsradius=10000&gslimit=30&format=json&origin=*`,
        {},
        8000
      )
    )
  );
  const seen = new Set();
  const pois = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const g of s.value?.query?.geosearch || []) {
      if (seen.has(g.pageid) || WIKI_JUNK.test(g.title)) continue;
      seen.add(g.pageid);
      pois.push({ lat: g.lat, lon: g.lon, name: g.title, kind: "attraction" });
    }
  }
  return pois;
}

// Wikipedia articles that exist for administrative/infrastructure reasons,
// not because anyone would drive to see them.
const WIKI_JUNK =
  /constituency|railway|train station|\bstation\b|district|taluk|tehsil|mandal|airport|university|college|school|hospital|institute|municipality|panchayat|\bdepot\b|power plant|factory|industrial|\bjail\b|prison|court\b|highway|expressway|\broad\b|junction|interchange|toll|bus stand|stadium\b|company|corporation|headquarters/i;

function bboxAround(origin, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.15, Math.cos((origin.lat * Math.PI) / 180)));
  return [
    (origin.lat - dLat).toFixed(4),
    (origin.lon - dLon).toFixed(4),
    (origin.lat + dLat).toFixed(4),
    (origin.lon + dLon).toFixed(4),
  ].join(",");
}

async function runOverpass(query, offset = 0) {
  let lastErr;
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const endpoint = OVERPASS_ENDPOINTS[(i + offset) % OVERPASS_ENDPOINTS.length];
    try {
      const data = await fetchJson(
        endpoint,
        {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
        18000
      );
      return (data.elements || [])
        .map((el) => {
          const lat = el.lat ?? el.center?.lat;
          const lon = el.lon ?? el.center?.lon;
          if (lat == null) return null;
          return {
            lat,
            lon,
            name: el.tags?.name || labelFor(el.tags),
            kind: kindFor(el.tags),
          };
        })
        .filter(Boolean);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass unavailable");
}

function kindFor(tags = {}) {
  if (tags.boundary === "national_park") return "national_park";
  if (tags.leisure === "nature_reserve") return "nature_reserve";
  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.natural === "waterfall") return "waterfall";
  if (tags.natural === "peak") return "peak";
  if (tags.natural === "beach") return "beach";
  if (tags.tourism === "attraction") return "attraction";
  return "place";
}

function labelFor(tags = {}) {
  const kind = kindFor(tags);
  return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const OSRM = "https://router.project-osrm.org";

// One-to-many drive durations (seconds). Returns array aligned with `targets`.
export async function osrmTable(origin, targets) {
  const coords = [origin, ...targets]
    .map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`)
    .join(";");
  const data = await fetchJson(
    `${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration`
  );
  if (data.code !== "Ok") throw new Error("OSRM table failed");
  return data.durations[0].slice(1);
}

// Full route through waypoints. Returns { durationSec, distanceKm, geometry }
export async function osrmRoute(points) {
  const coords = points
    .map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`)
    .join(";");
  const data = await fetchJson(
    `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`
  );
  if (data.code !== "Ok" || !data.routes?.[0]) throw new Error("OSRM route failed");
  const r = data.routes[0];
  return {
    durationSec: r.duration,
    distanceKm: r.distance / 1000,
    geometry: r.geometry.coordinates, // [lon, lat] pairs
  };
}
