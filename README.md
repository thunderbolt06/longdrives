# LongDrives 🚗

A scenic drive planner for people who just want to *drive*. Tell it how long
you feel like being on the road, and it finds a smooth, scenic route — then
hands you a Google Maps link with every stop pre-loaded so you can navigate
with live traffic.

## How it works

1. **You enter** a start point (or use your location), a drive duration
   (1–12 h), round trip or one way, and optionally toggle sightseeing stops.
2. **The planner** estimates how far you can get in that time, pulls scenic
   points (viewpoints, peaks, waterfalls, beaches, national parks, nature
   reserves) from OpenStreetMap in that band, scores candidate destinations by
   scenic density, and verifies real drive times with OSRM.
3. **Round trips** return through a different scenic waypoint so the loop
   doesn't retrace itself. **Sightseeing mode** adds up to 3 worthwhile stops
   along the corridor.
4. **You get** a route preview and an **Open in Google Maps** button — the
   deep link carries all waypoints, and Google handles live-traffic
   navigation from there.

## Stack

- Next.js (App Router) on Vercel — one serverless API route, one page
- [Nominatim](https://nominatim.org/) — geocoding (no key needed)
- [Overpass API](https://overpass-api.de/) — scenic POIs from OpenStreetMap
- [OSRM](http://project-osrm.org/) demo server — drive-time verification
- Leaflet + CARTO tiles — route preview
- Google Maps deep links — final navigation with live traffic

No API keys required to run.

### Optional: Google Maps API key

Set `GOOGLE_MAPS_API_KEY` (in `.env.local` or Vercel project settings) to
upgrade geocoding to Google's Geocoding API. The routing/POI pipeline can be
pointed at Google Routes & Places APIs later for traffic-aware planning — the
provider layer in `lib/providers.js` is the single place to swap.

## Develop

```bash
npm install
npm run dev
```

## Deploy

```bash
vercel --prod
```
