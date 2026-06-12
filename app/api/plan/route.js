import { planDrive } from "../../../lib/planner.js";
import { geocode, reverseGeocode } from "../../../lib/providers.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  try {
    const body = await req.json();
    const minutes = Number(body.minutes);
    if (!minutes || minutes < 30 || minutes > 16 * 60) {
      return err("Duration must be between 30 minutes and 16 hours.", 400);
    }

    let origin;
    if (typeof body.lat === "number" && typeof body.lon === "number") {
      origin = { lat: body.lat, lon: body.lon };
      origin.name = (await reverseGeocode(body.lat, body.lon)) || "Your location";
    } else if (body.query) {
      origin = await geocode(String(body.query));
      if (!origin) return err(`Couldn't find "${body.query}".`, 404);
    } else {
      return err("Provide a start location.", 400);
    }

    const plan = await planDrive({
      origin,
      minutes,
      roundTrip: body.mode !== "oneway",
      sightseeing: Boolean(body.sightseeing),
    });
    return Response.json(plan);
  } catch (e) {
    return err(e.message || "Planning failed. Please try again.", 500);
  }
}

function err(message, status) {
  return Response.json({ error: message }, { status });
}
