import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { downloadHeaders, fileRefusalMessage, isPlausibleFileId } from "@/lib/fileDownload";

// PV3-08 follow-up — the STAFF download of a stored file: a contract's PDF, a payment's proof of payment.
//
// `GET /api/files/:fileId` streams the bytes of the platform's `GET /api/:t/files/:id/content` through
// this server with the CALLER'S session (`platformAuthHeaders`: their OIDC token, or the dev bearer +
// x-user-id). The platform does the authorizing, exactly as it does for the file's metadata: a `read` on the
// file AND a `read` on the entity it hangs off (the contract, the invoice payment). This route adds no
// permission of its own and widens none: whoever the platform refuses, this refuses, and says so in words.
//
// WHAT IT NEVER DOES: expose a storage URL or key (the browser only ever sees `/api/files/:id`), render the
// file inline, or let the content type be guessed. See `downloadHeaders()` (lib/fileDownload.ts) for the four
// headers every response carries and why.
//
// The tenant is the caller's ACTIVE company (same as every staff page), never a value from the URL, so a
// file id cannot be used to reach into another company: the platform's RLS sees only the tenant asked for.
//
// This is the STAFF route. The client portal serves files through its own `/portal/files/:id`, which
// resolves ownership through the portal scope; do not point the portal at this one (BFF contract §26).
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const refuse = (status: number, message?: string) =>
  NextResponse.json({ error: message ?? fileRefusalMessage(status) }, { status, headers: noStore });

export async function GET(_req: Request, ctx: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await ctx.params;
  if (!isPlausibleFileId(fileId)) return refuse(400);

  const userId = await getSessionUserId();
  if (!userId) return refuse(401);

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return refuse(400, "No active company is selected, so the file cannot be looked up. Choose a company from the top bar.");

  if (isDemoMode()) {
    // DEMO_MODE has no file storage: answer with a small, clearly labelled stand-in so the link is drivable.
    // Same headers as the real thing, so the demo exercises the same attachment behaviour.
    return new Response(`DEMO MODE: placeholder for file ${fileId}.\nNo real file is stored in demo mode.\n`, {
      status: 200,
      headers: downloadHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="demo-${fileId}.txt"` })),
    });
  }

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/${encodeURIComponent(tenant)}/files/${encodeURIComponent(fileId)}/content`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[files] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  // 401/403/404 pass through as themselves, with words. A redirect (the platform never sends one from a
  // bearer call) or any other non-200 is "could not serve", not a 500 and not a blank page.
  if (!upstream.ok) {
    const status = upstream.status === 401 || upstream.status === 403 || upstream.status === 404 ? upstream.status : 502;
    return refuse(status);
  }

  // Streamed, not buffered: a contract scan can be tens of MB. The headers are rebuilt, never copied
  // wholesale, so nothing the upstream sends can weaken the four that matter.
  return new Response(upstream.body, { status: 200, headers: downloadHeaders(upstream.headers) });
}
