import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { downloadHeaders, fileRefusalMessage, isPlausibleFileId } from "@/lib/fileDownload";

// DW-5c UI — the STAFF download of a delivered creative asset (the link on a request page). `GET /api/creative-assets/:id`
// streams the bytes of the platform's `GET /api/:t/creative/assets/:id/content` with the CALLER'S session, exactly as
// `app/api/files/[fileId]` does for stored files, and with the same four download headers (attachment, nosniff, sandbox
// CSP, private no-store): an asset is user-supplied content served from our own origin. The platform authorizes (`read`
// on the file kind); this route adds no permission and widens none. The tenant is the caller's ACTIVE company, never a
// value from the URL, so an asset id cannot reach into another company.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const refuse = (status: number, message?: string) =>
  NextResponse.json({ error: message ?? fileRefusalMessage(status) }, { status, headers: noStore });

export async function GET(_req: Request, ctx: { params: Promise<{ assetId: string }> }): Promise<Response> {
  const { assetId } = await ctx.params;
  if (!isPlausibleFileId(assetId)) return refuse(400);

  const userId = await getSessionUserId();
  if (!userId) return refuse(401);

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return refuse(400, "No active company is selected, so the asset cannot be looked up. Choose a company from the top bar.");

  if (isDemoMode()) {
    return new Response(`DEMO MODE: placeholder for asset ${assetId}.\nNo real asset is stored in demo mode.\n`, {
      status: 200,
      headers: downloadHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="demo-${assetId}.txt"` })),
    });
  }

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/${encodeURIComponent(tenant)}/creative/assets/${encodeURIComponent(assetId)}/content`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[creative-assets] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  if (!upstream.ok) {
    const status = upstream.status === 401 || upstream.status === 403 || upstream.status === 404 ? upstream.status : 502;
    return refuse(status);
  }
  return new Response(upstream.body, { status: 200, headers: downloadHeaders(upstream.headers) });
}
