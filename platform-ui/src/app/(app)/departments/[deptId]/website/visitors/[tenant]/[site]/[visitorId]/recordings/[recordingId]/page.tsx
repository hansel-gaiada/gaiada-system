import { notFound, redirect } from "next/navigation";
import { resolveSiteForReplay } from "@/lib/replays";
import { signedDomainParams } from "@/lib/replaysCsp";
import { UUID_RE } from "@/lib/replaysModel";
import { shortId } from "@/lib/visitorsModel";
import { can } from "@/lib/rbac";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReplayPlayer } from "@/components/webdesk/visitors/ReplayPlayer";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import "@/components/webdesk/visitors/visitors.css";

type Params = Promise<{ deptId: string; tenant: string; site: string; visitorId: string; recordingId: string }>;
type Search = Promise<{ d?: string | string[]; s?: string | string[] }>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// Website -> Visitors -> site -> visitor -> one recording: the session-replay player (M5-V6-c, design 2026-10-12 §6.3).
//
//  * 404 for a viewer without `search.replay.view` (the `can()` mirror of Cerbos's `view_replay`), before anything is read: hidden,
//    never an empty player. The server is the authority and refuses the content with 403 on its own.
//  * This page's Content-Security-Policy is set by proxy.ts from the signed `d` and `s` in the URL (lib/replaysCsp.ts): images and media
//    only from this site's own domains. THIS page computes the domains (the site's environments) and, when the URL does not carry the
//    right signed pair, redirects once to the canonical URL, which is why the player is always reached with the correct policy.
//  * Nothing of the recording is read here: the player asks for it page by page through a server action, after an explicit Play (a Play
//    is an audited opening, so a page load must not be one).
//  * Leaving is by plain links, so the next page is a full load and does not inherit this page's policy.
export default async function WebsiteRecordingPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site, visitorId, recordingId } = await params;
  const c = await requireWebsiteCtx(deptId, "visitors");
  if (!can(c.me, "search.replay.view", c.company)) notFound();
  if (!UUID_RE.test(visitorId) || !UUID_RE.test(recordingId)) notFound();

  const list = `${c.visitorsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const visitor = `${list}/${encodeURIComponent(visitorId)}`;
  const here = `${visitor}/recordings/${encodeURIComponent(recordingId)}`;

  const r = await resolveSiteForReplay(c.userId, c.company, tenant, site);
  if (r.kind === "no_site") return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the recording" />;
  if (r.kind === "no_property") {
    return <div className="wc-page"><EmptyNote>No search property matches {r.siteName}&apos;s domain, so there is no recording to play.</EmptyNote></div>;
  }
  if (r.kind !== "ok") return <WdRefusal result={r} subject="the recording" retryHref={here} />;

  // The canonical signed pair for this site's domains. Without SESSION_SECRET nothing can be signed and the proxy serves the floor policy
  // (no images from anywhere but this app); the page still renders.
  let canonical: { d: string; s: string } | null = null;
  try { canonical = signedDomainParams(tenant, site, r.domains); } catch { canonical = null; }
  if (canonical) {
    const sp = await searchParams;
    if (one(sp.d) !== canonical.d || one(sp.s) !== canonical.s) {
      redirect(`${here}?${new URLSearchParams({ d: canonical.d, s: canonical.s }).toString()}`);
    }
  }

  return (
    <div className="wc-page">
      <nav aria-label="Breadcrumb" className="wv-note" data-testid="replay-crumbs">
        {/* Plain links, on purpose: a full page load drops this page's policy (lib/replaysCsp.ts). */}
        <a href={c.visitorsBase}>Visitors</a> / <a href={list}>{r.siteName}</a> / <a href={visitor}>Visitor {shortId(visitorId)}</a> / Recording
      </nav>
      <p className="wc-lede">A recorded visit, replayed from our own server. Images load only from this site&apos;s own domains, and the replayed page runs no scripts.</p>
      <ReplayPlayer propertyId={r.property.id} recordingId={recordingId} backHref={visitor} />
    </div>
  );
}
