import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getActiveTenant } from "@/lib/tenant";
import { getMe } from "@/lib/platform";
import { getChangeProposal, getCampaign } from "@/lib/searchMarketing";

// SM-19 — the download half of SM-30's manual-mode export (`ApplyProposalTwins.tsx`). The export
// SERVER ACTION only ever returns metadata (`{fileId,filename,...}` — `search.controller.ts`'s
// `exportChangeProposal` never inlines the CSV bytes; they are stored via `storage()` and served
// separately by `GET :tenantId/files/:fileId/content`, `platformFetch`'s helper because that helper
// always `.json()`s the response, which would corrupt a binary/text download — this route exists
// SPECIFICALLY so a browser `<a href>` can hit an ordinary authenticated GET without the UI needing
// its own fetch-and-Blob dance.
//
// The proposal id is read off the PATH and re-resolved to its CURRENT `exportFileId` server-side
// (never trusts a client-supplied fileId) — same "re-read authoritatively" convention
// `saveEngagementScope` already uses, and it doubles as the authorization check: `getChangeProposal`
// goes through the same Cerbos `read` gate on `resource_search_campaign` the panel itself needs, so
// a caller who cannot read this proposal gets a 404 here too, never a bare files-table id guess.
export const dynamic = "force-dynamic";

// Demo-only: DEMO_MODE has no binary/files backend at all (Attachments.tsx's own note: "Binary/
// multipart upload is a documented backend follow-up; this attaches references today" — the same is
// true of file CONTENT, never modelled by demoFixtures.ts's JSON-only dispatcher). Rather than teach
// that dispatcher a whole new binary-response shape for one download link, this synthesizes a small,
// CLEARLY-LABELLED stand-in CSV from the proposal's own (already-real, already-fetched) demo record —
// deterministic from the proposal's own fields, per this module's "a demo figure must be reproducible,
// not merely plausible-looking" house rule, and never claiming to be the real Ads-Editor artifact
// SM-30 builds server-side (that fidelity is real-backend-only, correctly).
function demoCsv(proposalId: string, campaignName: string, kind: string): string {
  const rows = [
    ["DEMO MODE — synthesized locally, not read from real file storage"],
    ["Campaign", "Proposal", "Kind"],
    [campaignName, proposalId, kind],
  ];
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.redirect(new URL("/login", req.url));

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return NextResponse.json({ error: "no active company selected" }, { status: 400 });

  const proposal = await getChangeProposal(userId, tenant, id);
  if (!proposal) return NextResponse.json({ error: "change proposal not found" }, { status: 404 });
  if (!proposal.exportFileId) {
    return NextResponse.json({ error: "this proposal has not been exported yet — use \"Export CSV\" first" }, { status: 404 });
  }

  if (process.env.DEMO_MODE === "1") {
    const campaign = await getCampaign(userId, tenant, proposal.campaignId);
    const csv = demoCsv(proposal.id, campaign?.name ?? "(unknown campaign)", proposal.kind);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="demo-${proposal.id}.csv"`,
        "x-content-type-options": "nosniff",
      },
    });
  }

  // Real mode: proxy raw bytes from platform-nest's own authenticated content route. Not
  // `platformFetch` (it always `.json()`s) — same auth-header resolution as `platformUpload` in
  // lib/platform.ts, duplicated here rather than widening that helper's contract for one binary GET.
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let authHeaders: Record<string, string>;
  try {
    const { getSession } = await import("@/lib/session-server");
    const s = await getSession();
    authHeaders = s?.mode === "oidc"
      ? { authorization: `Bearer ${s.accessToken}` }
      : { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`, "x-user-id": userId };
  } catch {
    authHeaders = { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`, "x-user-id": userId };
  }

  const upstream = await fetch(`${base}/api/${tenant}/files/${proposal.exportFileId}/content`, {
    headers: authHeaders,
    cache: "no-store",
  });
  if (!upstream.ok) {
    return NextResponse.json({ error: `platform ${upstream.status}` }, { status: upstream.status });
  }
  const bytes = await upstream.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": upstream.headers.get("content-disposition") ?? `attachment; filename="export-${proposal.exportFileId}.csv"`,
      "x-content-type-options": "nosniff",
    },
  });
}
