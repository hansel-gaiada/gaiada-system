import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { downloadHeaders } from "@/lib/fileDownload";
import { exportRefusalMessage, isPlausibleJobId } from "@/lib/reportExport";

// DW-4k — the download half of a report export.
//
// `GET /api/reports/exports/:jobId` streams the bytes of the platform's
// `GET /api/:t/reports/exports/:jobId/download` through this server with the CALLER'S session
// (`platformAuthHeaders`: their OIDC token, or the dev bearer + x-user-id). The platform authorizes: it
// re-derives the report's grain and scope from the stored job and re-runs the same check as the document
// read, on every download. This route adds no permission of its own and widens none.
//
// The tenant is the caller's ACTIVE company (same as every staff page), never a value from the URL.
//
// A refusal is a JSON `{error}` with the platform's own status (400/401/403/404/422, or a 5xx as sent) so
// the control that fetched it can say so in place; a failed export never looks like a download (no
// attachment headers on an error, no empty 200). A success keeps the platform's content type and
// disposition (rebuilt through `downloadHeaders`, which pins nosniff, a sandbox CSP and no-store) and is
// streamed, not buffered.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const refuse = (status: number, message?: string) =>
  NextResponse.json({ error: message ?? exportRefusalMessage(status) }, { status, headers: noStore });

/** The platform's own sentence when it sent one (`{error}`), else null. */
async function upstreamSentence(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" && body.error ? body.error : null;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await ctx.params;
  if (!isPlausibleJobId(jobId)) return refuse(400);

  const userId = await getSessionUserId();
  if (!userId) return refuse(401);

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return refuse(400, "No active company is selected, so the export cannot be looked up. Choose a company from the top bar.");

  if (isDemoMode()) {
    // DEMO_MODE renders no report document, so there is nothing real to export: answer a small, clearly
    // labelled placeholder (the demo job id is `demo-<format>`) through the same attachment headers.
    const format = /^demo-(pdf|xlsx|csv)$/.exec(jobId)?.[1] ?? "file";
    return new Response(
      `DEMO MODE: this is a placeholder, not a report.\nDemo mode renders no report document, so no ${format.toUpperCase()} export is produced.\nA real export is built from live data and marked AD HOC · UNSEALED unless its period is sealed.\n`,
      {
        status: 200,
        headers: downloadHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="demo-report-export-${format}.txt"` })),
      },
    );
  }

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/${encodeURIComponent(tenant)}/reports/exports/${encodeURIComponent(jobId)}/download`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[report-exports] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  if (!upstream.ok) {
    // As sent: the platform's status (a 4xx is the platform's answer, a 5xx its fault) and its sentence. A
    // redirect (the platform never sends one from a bearer call) is "could not serve", not a blank page.
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    return refuse(status, (await upstreamSentence(upstream)) ?? undefined);
  }

  return new Response(upstream.body, { status: 200, headers: downloadHeaders(upstream.headers) });
}
