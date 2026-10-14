import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { isPlausibleFileId } from "@/lib/fileDownload";

// DW-6k UI — the thumbnail of a Figma link (BFF §36.3, §36.8). `GET /api/figma-links/:linkId/thumbnail` streams the platform's
// `GET /api/:t/figma-links/:id/thumbnail` (a small PNG that Figma rendered; the platform never stores it) with the CALLER'S session,
// the way `app/api/creative-assets/[assetId]` does for asset bytes: the browser's <img> cannot carry the platform's bearer token, so
// this route forwards it. The platform authorizes (`read` on the link's target); this route adds no permission and widens none.
// The tenant is the caller's ACTIVE company, never a value from the URL.
//
// A refusal is an answer an <img> shows as a failed image: the section draws "Preview unavailable" on its onError, so the status here
// only has to be honest. 409 is the platform's own for a Figma failure (not connected, token refused, file not found).
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const refuse = (status: number, error: string) => NextResponse.json({ error }, { status, headers: noStore });

export async function GET(_req: Request, ctx: { params: Promise<{ linkId: string }> }): Promise<Response> {
  const { linkId } = await ctx.params;
  if (!isPlausibleFileId(linkId)) return refuse(400, "That is not a valid Figma link.");

  const userId = await getSessionUserId();
  if (!userId) return refuse(401, "Your session expired. Sign in again.");

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return refuse(400, "No active company is selected.");

  // Demo mode has no Figma data, and no platform to ask.
  if (isDemoMode()) return refuse(404, "There are no Figma previews in demo mode.");

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/${encodeURIComponent(tenant)}/figma-links/${encodeURIComponent(linkId)}/thumbnail`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[figma-thumbnail] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  if (!upstream.ok) {
    const status = [401, 403, 404, 409].includes(upstream.status) ? upstream.status : 502;
    return refuse(status, status === 403 ? "You do not have permission to see this preview." : "The preview is not available right now.");
  }
  // Only a PNG is passed on. Anything else from upstream is not what the platform promised, so it is not served from our origin.
  if (!(upstream.headers.get("content-type") ?? "").toLowerCase().startsWith("image/png")) return refuse(502, "The preview is not available right now.");
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      // Figma's render expires and the platform sends `private, max-age=600`: the same, for this person's browser only.
      "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}
