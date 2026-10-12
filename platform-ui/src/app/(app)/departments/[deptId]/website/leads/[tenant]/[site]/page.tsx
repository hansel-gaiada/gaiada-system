import { listSites } from "@/lib/webdeskContent";
import { listWebLeads } from "@/lib/websiteLeads";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { LeadsView } from "@/components/webdesk/leads/LeadsView";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website -> Leads -> site. The site must be one of this company's (listSites is the company wall), then the leads come
// from platform-nest filtered by the WebDesk tenant slug. Anything that is not data is words: a refusal is a notice and
// never an empty table, and "no leads" is only ever drawn from a successful read.
export default async function WebsiteLeadsPage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId, "leads");
  const here = `${c.leadsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the leads" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the leads" />;

  const res = await listWebLeads(c.userId, c.company, t.slug);
  if (res.kind !== "ok") return <WdRefusal result={res} subject="the leads" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Leads", href: c.leadsBase }, { label: s.name }]} />
      <LeadsView siteName={s.name} body={res.data} />
    </div>
  );
}
