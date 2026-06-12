import { suggestPlaces } from "../../../lib/providers.js";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return Response.json({ suggestions: [] });
  }
  try {
    const suggestions = await suggestPlaces(q);
    return Response.json({ suggestions });
  } catch {
    return Response.json({ suggestions: [] });
  }
}
