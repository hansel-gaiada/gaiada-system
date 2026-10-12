import { redirect } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SitesPanel } from "@/components/webdesk/content/SitesPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string }>;

// Website -> Visitors. Which site's visitors to open. Same shape as Analytics and Leads: one site goes straight in, several are
// listed, a failed read is a refusal and never an empty list of sites. `requireWebsiteCtx(…, "visitors")` 404s without the
// toolkit tab AND without `read_visitors`.
export default async function WebsiteVisitorsIndexPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const c = await requireWebsiteCtx(deptId, "visitors");
  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the visitors" retryHref={c.visitorsBase} />;

  const all = sites.data.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (all.length === 1) redirect(`${c.visitorsBase}/${encodeURIComponent(all[0].t.slug)}/${encodeURIComponent(all[0].s.siteId)}`);
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Visitors" }]} />
      <p className="wc-lede">Pick a website to see the visitors who accepted analytics on it.</p>
      <SitesPanel sites={sites.data} contentBase={c.visitorsBase} />
    </div>
  );
}
