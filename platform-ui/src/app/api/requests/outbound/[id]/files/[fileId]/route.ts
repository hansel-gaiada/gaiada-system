import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { downloadHeaders, fileRefusalMessage, isPlausibleFileId } from "@/lib/fileDownload";

// DW-10e (BFF §60.5, §60.9) — the SENDER's download of a file on a request their company sent to another group company.
// `GET /api/requests/outbound/:id/files/:fileId` streams the bytes of the platform's
// `GET /api/:t/requests/outbound/:id/files/:fileId/content` with the CALLER'S session, under the ASKING company (their ACTIVE one,
// never a value from the URL), with the same four download headers as `/api/creative-assets` and `/api/files` (attachment, nosniff,
// sandbox CSP, private no-store): the bytes are user-supplied content served from our own origin. The platform authorizes (the
// sender's own request, or any of the company's for its managers and administrators, DW-D40) and answers 404 for anything else;
// this route adds no permission and widens none. The receiving company's own routes are not used: the sender holds no right there.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const refuse = (status: number, message?: string) =>
  NextResponse.json({ error: message ?? fileRefusalMessage(status) }, { status, headers: noStore });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; fileId: string }> }): Promise<Response> {
  const { id, fileId } = await ctx.params;
  if (!isPlausibleFileId(id) || !isPlausibleFileId(fileId)) return refuse(400);

  const userId = await getSessionUserId();
  if (!userId) return refuse(401);

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return refuse(400, "No active company is selected, so the request cannot be looked up. Choose a company from the top bar.");

  if (isDemoMode()) {
    return new Response(`DEMO MODE: placeholder for file ${fileId} of request ${id}.
No real file is stored in demo mode.
`, {
      status: 200,
      headers: downloadHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="demo-${fileId}.txt"` })),
    });
  }

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/${encodeURIComponent(tenant)}/requests/outbound/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/content`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[requests-outbound-files] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  if (!upstream.ok) {
    const status = upstream.status === 401 || upstream.status === 403 || upstream.status === 404 ? upstream.status : 502;
    return refuse(status);
  }
  return new Response(upstream.body, { status: 200, headers: downloadHeaders(upstream.headers) });
}
