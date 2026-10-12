import { readDetail, resolveSiteProperty } from "@/lib/visitors";
import { shortId } from "@/lib/visitorsModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { VisitorDetailView } from "@/components/webdesk/visitors/VisitorDetailView";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string; visitorId: string }>;

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

  const d = await readDetail(c.userId, c.company, r.property.id, visitorId);
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
      <VisitorDetailView visitor={d.visitor} listHref={list} />
    </div>
  );
}
