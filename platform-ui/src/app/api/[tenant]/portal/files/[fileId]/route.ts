import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getPortalCompanies } from "@/lib/portal-company";
import { isDemoMode } from "@/lib/demoMode";
import { downloadHeaders, fileRefusalMessage, isPlausibleFileId } from "@/lib/fileDownload";

// SCP-2 (BFF §63.8) — the CLIENT PORTAL's file route as the browser reaches it: `GET /api/:t/portal/files/:fileId`.
//
// The portal's pages link files here (a contract's signed copy, a report, and since SCP-2 every image of a social post, as `<img src>`), but the
// browser cannot call the platform: the session token is server-side. This route is the staff route's twin (`app/api/files/[fileId]/route.ts`): it
// streams the platform's `GET /api/:t/portal/files/:fileId` with the CALLER'S own session auth, and adds no permission of its own. The platform walks
// the file's parent through the portal scope predicate, so a file of another client, or one that has not reached the client, is the platform's 404.
//
// The company is the one in the URL, but only when it is one of the caller's own (`me.clientOf`): anything else is a 404, the same answer as a file that
// does not exist, so the route is no oracle for another company's ids. WHAT IT NEVER DOES: expose a storage URL or key, render a file inline in a page
// of ours, or let the content type be guessed (`downloadHeaders`: attachment, nosniff, sandbox CSP). An image is shown by `<img>`, which those headers
// do not prevent; it is the one kind cached by the browser (privately, five minutes), because a month's grid is dozens of thumbnails.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const refuse = (status: number, message?: string) =>
  NextResponse.json({ error: message ?? fileRefusalMessage(status) }, { status, headers: noStore });

export async function GET(_req: Request, ctx: { params: Promise<{ tenant: string; fileId: string }> }): Promise<Response> {
  const { tenant, fileId } = await ctx.params;
  if (!isPlausibleFileId(fileId) || !isPlausibleFileId(tenant)) return refuse(400);

  const userId = await getSessionUserId();
  if (!userId) return refuse(401);

  let me: Awaited<ReturnType<typeof getMe>>;
  try {
    me = await getMe(userId);
  } catch {
    return refuse(401); // the session cannot be turned into a person: the caller signs in again
  }
  if (!getPortalCompanies(me).some((c) => c.companyId === tenant)) return refuse(404);

  if (isDemoMode()) {
    // DEMO_MODE has no file storage. A social post's image is a generated placeholder at the network's own ratio (lib/demoSocialPortal.ts); any other
    // file is the small labelled stand-in the staff route answers, so the link is drivable.
    const { demoPortalSocialFile } = await import("@/lib/demoSocialPortal");
    const social = demoPortalSocialFile(userId, fileId);
    if (social) {
      if (social.status !== 200 || !social.svg) return refuse(social.status);
      return new Response(social.svg, {
        status: 200,
        headers: { ...downloadHeaders(new Headers({ "content-type": "image/svg+xml", "content-disposition": `attachment; filename="demo-${fileId}.svg"` })), "cache-control": "private, max-age=300" },
      });
    }
    return new Response(`DEMO MODE: placeholder for file ${fileId}.\nNo real file is stored in demo mode.\n`, {
      status: 200,
      headers: downloadHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="demo-${fileId}.txt"` })),
    });
  }

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/${encodeURIComponent(tenant)}/portal/files/${encodeURIComponent(fileId)}`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[portal-files] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  // 401/403/404 pass through as themselves, with words; a redirect or any other non-200 is "could not serve", not a 500.
  if (!upstream.ok) {
    const status = upstream.status === 401 || upstream.status === 403 || upstream.status === 404 ? upstream.status : 502;
    return refuse(status);
  }

  const headers = downloadHeaders(upstream.headers);
  // Images only: the browser may keep them privately for five minutes (a grid of thumbnails, then the same post opened). Everything else stays no-store.
  if (/^image\/(png|jpe?g|webp|gif|avif)\b/i.test(headers["content-type"])) headers["cache-control"] = "private, max-age=300";
  return new Response(upstream.body, { status: 200, headers });
}
