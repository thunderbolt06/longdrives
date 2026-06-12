"use client";

import { useEffect, useRef, useState } from "react";

const KIND_EMOJI = {
  national_park: "🏞️",
  nature_reserve: "🌲",
  viewpoint: "🌄",
  waterfall: "💧",
  beach: "🏖️",
  peak: "⛰️",
  attraction: "📍",
  place: "📍",
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [coords, setCoords] = useState(null); // {lat, lon} from geolocation
  const [hours, setHours] = useState(3);
  const [mode, setMode] = useState("roundtrip");
  const [destQuery, setDestQuery] = useState("");
  const [sightseeing, setSightseeing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation isn't available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setQuery("📍 Current location");
        setError(null);
      },
      () => setError("Couldn't get your location — type a place instead.")
    );
  }

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const body = {
        minutes: Math.round(hours * 60),
        mode,
        sightseeing,
      };
      if (coords && query.startsWith("📍")) {
        body.lat = coords.lat;
        body.lon = coords.lon;
      } else {
        body.query = query;
      }
      if (mode === "oneway" && destQuery.trim()) {
        body.destQuery = destQuery.trim();
      }
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setPlan(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <div className="hero">
        <h1>
          Long<span>Drives</span>
        </h1>
        <p>
          Tell us how long you feel like driving. We find a smooth, scenic
          route — away from traffic, toward the views — and open it in Google
          Maps.
        </p>
      </div>

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label>Start from</label>
          <div className="loc-row">
            <input
              type="text"
              placeholder="City, address or landmark…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCoords(null);
              }}
              required
            />
            <button
              type="button"
              className="btn-loc"
              title="Use my location"
              onClick={useMyLocation}
            >
              🎯
            </button>
          </div>
        </div>

        <div className="field">
          <label>How long do you want to drive?</label>
          <div className="duration-value">
            {hours % 1 === 0 ? hours : hours.toFixed(1)} hour{hours !== 1 ? "s" : ""}
          </div>
          <input
            type="range"
            min="1"
            max="12"
            step="0.5"
            value={hours}
            onChange={(e) => setHours(parseFloat(e.target.value))}
          />
        </div>

        <div className="field">
          <label>Trip type</label>
          <div className="segmented">
            <button
              type="button"
              className={mode === "roundtrip" ? "active" : ""}
              onClick={() => setMode("roundtrip")}
            >
              🔁 Round trip
            </button>
            <button
              type="button"
              className={mode === "oneway" ? "active" : ""}
              onClick={() => setMode("oneway")}
            >
              ➡️ One way
            </button>
          </div>
        </div>

        {mode === "oneway" && (
          <div className="field">
            <label>Destination (optional)</label>
            <input
              type="text"
              placeholder="Leave empty and we'll find a scenic one"
              value={destQuery}
              onChange={(e) => setDestQuery(e.target.value)}
            />
            {destQuery.trim() && (
              <div className="hint">
                We'll route you there the scenic way — drive duration is
                estimated from the route, not the slider.
              </div>
            )}
          </div>
        )}

        <div className="field">
          <div className="toggle-row">
            <div>
              <div className="label-main">Sightseeing stops</div>
              <div className="label-sub">
                Add a few worthwhile places to pull over along the way
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={sightseeing}
                onChange={(e) => setSightseeing(e.target.checked)}
              />
              <span className="slider-ui"></span>
            </label>
          </div>
        </div>

        <button className="btn-primary" disabled={loading}>
          {loading ? "Finding your drive…" : "Plan my drive"}
        </button>

        {error && <div className="error">{error}</div>}
      </form>

      {plan && <Result plan={plan} />}

      <div className="footer">
        Routing by OSRM · Places by OpenStreetMap · Navigation opens in Google
        Maps with live traffic
      </div>
    </main>
  );
}

function Result({ plan }) {
  const h = Math.floor(plan.estimatedMinutes / 60);
  const m = plan.estimatedMinutes % 60;
  return (
    <div className="card result">
      <h2>
        {plan.roundTrip ? "Loop via" : "Drive to"} {plan.destination.name}
      </h2>
      <div className="sub">Starting from {shorten(plan.origin.name)}</div>

      <div className="stats">
        <div className="stat">
          <div className="v">
            {h > 0 ? `${h}h ` : ""}
            {m}m
          </div>
          <div className="k">{plan.liveTraffic ? "With live traffic" : "Drive time"}</div>
        </div>
        {plan.distanceKm && (
          <div className="stat">
            <div className="v">{plan.distanceKm} km</div>
            <div className="k">Distance</div>
          </div>
        )}
        <div className="stat">
          <div className="v">{plan.roundTrip ? "Loop" : "One way"}</div>
          <div className="k">Trip type</div>
        </div>
      </div>

      <ul className="itinerary">
        <li>
          <span className="dot">🚗</span> {shorten(plan.origin.name)}
        </li>
        {plan.stops.map((s, i) => (
          <li key={i}>
            <span className="dot">{KIND_EMOJI[s.kind] || "📍"}</span> {s.name}
          </li>
        ))}
        <li>
          <span className="dot">{KIND_EMOJI[plan.destination.kind] || "🏁"}</span>{" "}
          {plan.destination.name}
        </li>
        {plan.via && (
          <li>
            <span className="dot">{KIND_EMOJI[plan.via.kind] || "↩️"}</span>{" "}
            {plan.via.name} <span style={{ color: "var(--muted)" }}>(return leg)</span>
          </li>
        )}
        {plan.roundTrip && (
          <li>
            <span className="dot">🏠</span> Back to start
          </li>
        )}
      </ul>

      {plan.geometry && <MapPreview plan={plan} />}

      <a
        className="btn-gmaps"
        href={plan.googleMapsUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open in Google Maps ↗
      </a>
    </div>
  );
}

function MapPreview({ plan }) {
  const ref = useRef(null);

  useEffect(() => {
    let map;
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !ref.current) return;
      map = L.map(ref.current, { zoomControl: false, attributionControl: true });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
      }).addTo(map);
      const latlngs = plan.geometry.map(([lon, lat]) => [lat, lon]);
      const line = L.polyline(latlngs, { color: "#4f8cff", weight: 4 }).addTo(map);
      const mark = (p, label) =>
        L.circleMarker([p.lat, p.lon], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#38d39f",
          fillOpacity: 1,
        })
          .addTo(map)
          .bindTooltip(label);
      mark(plan.origin, "Start");
      mark(plan.destination, plan.destination.name);
      plan.stops.forEach((s) => mark(s, s.name));
      if (plan.via) mark(plan.via, plan.via.name);
      map.fitBounds(line.getBounds(), { padding: [24, 24] });
    });
    return () => {
      cancelled = true;
      if (map) map.remove();
    };
  }, [plan]);

  return <div id="map" ref={ref} />;
}

let leafletPromise = null;
function loadLeaflet() {
  if (typeof window === "undefined") return new Promise(() => {});
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = reject;
    document.head.appendChild(js);
  });
  return leafletPromise;
}

function shorten(name = "") {
  return name.split(",").slice(0, 3).join(",");
}
