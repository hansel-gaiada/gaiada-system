import { readDetail, resolveSiteProperty } from "@/lib/visitors";
import { readRecordings, type RecordingsRead } from "@/lib/replays";
import { can } from "@/lib/rbac";
import { shortId } from "@/lib/visitorsModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { VisitorDetailView } from "@/components/webdesk/visitors/VisitorDetailView";
import type { RecordingsSectionData } from "@/components/webdesk/visitors/RecordingsCard";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string; visitorId: string }>;

/** The Recordings card's data from the read. A visitor the store does not know, or a body off-contract, is words, never an empty table. */
function recordingsSection(r: RecordingsRead): RecordingsSectionData {
  if (r.kind === "ok") return { kind: "ok", recordings: r.list.recordings };
  if (r.kind === "visitor_not_found") return { kind: "unavailable", message: "The recordings of this visitor could not be found. A visitor who withdrew consent has none." };
  if (r.kind === "drift") return { kind: "unavailable", message: `The recordings answer did not match the contract (${r.message}). This is a defect, not an empty list.` };
  return { kind: "unavailable", message: r.message };
}

// Website -> Visitors -> site -> one visitor: the timeline, interests, score parts and the linked lead. The detail is read with the
// signed-in user's own authority; a lead the viewer may not open comes back as "a lead you cannot open" with no id, and is drawn so.
export default async function WebsiteVisitorPage({ params }: { params: Params }) {
  const { deptId, tenant, site, visitorId } = await params;
  const c = await requireWebsiteCtx(deptId, "visitors");
  const list = `${c.visitorsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${list}/${encodeURIComponent(visitorId)}`;

  const r = await resolveSiteProperty(c.userId, c.company, tenant, site);
  if (r.kind === "no_site") return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the visitor" />;
  if (r.kind === "no_property") {
    return <div className="wc-page"><EmptyNote>No search property matches {r.siteName}&apos;s domain, so there is no visitor to read.</EmptyNote></div>;
  }
  if (r.kind !== "ok") return <WdRefusal result={r} subject="the visitor" retryHref={here} />;

  // Recordings (V6-c) are read ONLY for a viewer who holds `search.replay.view` (the mirror of Cerbos's `view_replay`: search managers and
  // company admins, never plain staff). Without it there is no card and no read. The server answers 403 on its own regardless.
  const canReplay = can(c.me, "search.replay.view", c.company);
  const [d, rec] = await Promise.all([
    readDetail(c.userId, c.company, r.property.id, visitorId),
    canReplay ? readRecordings(c.userId, c.company, r.property.id, visitorId) : Promise.resolve(null),
  ]);
  const crumbs = (label: string) => [{ label: "Website" }, { label: "Visitors", href: c.visitorsBase }, { label: r.siteName, href: list }, { label }];
  if (d.kind === "visitor_not_found") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs("Visitor")} />
        <Card title="Visitor not found"><EmptyNote>There is no consented visitor with this id on this site. A visitor who withdrew consent is removed.</EmptyNote></Card>
      </div>
    );
  }
  if (d.kind !== "ok") return <WdRefusal result={d} subject="the visitor" retryHref={here} />;
  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs(`Visitor ${shortId(d.visitor.visitorId)}`)} />
      <VisitorDetailView
        visitor={d.visitor} listHref={list}
        recordings={rec ? recordingsSection(rec) : undefined} recordingsBase={`${here}/recordings`}
      />
    </div>
  );
}
