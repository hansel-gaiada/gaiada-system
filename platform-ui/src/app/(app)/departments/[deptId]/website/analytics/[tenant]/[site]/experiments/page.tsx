import { notFound } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { readSiteExperiments } from "@/lib/experiments";
import { can } from "@/lib/rbac";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import { ExperimentsView } from "./_components/ExperimentsView";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website -> Analytics -> site -> Experiments (M5-V5-d). The tests registered for the site's search property, in the
// server's order, and the form that registers one. 404s where the department's toolkit has no Analytics tab (the same
// guard as every Website page) or the user cannot view search. Anything that is not data is words.
export default async function WebsiteExperimentsPage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId, "analytics");
  if (!can(c.me, "search.view", c.company)) notFound();
  const analyticsHref = `${c.analyticsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${analyticsHref}/experiments`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the experiments" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the experiments" />;

  const crumbs = [{ label: "Website" }, { label: "Analytics", href: c.analyticsBase }, { label: s.name, href: analyticsHref }, { label: "Experiments" }];
  const res = await readSiteExperiments(c.userId, c.company, s.environments.map((e) => e.domain));
  if (res.kind === "no_property") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs} />
        <EmptyNote>
          No search property matches {s.name}&apos;s domain yet, so there is nowhere to register tests. Add the site as a property in SEO first.
        </EmptyNote>
      </div>
    );
  }
  if (res.kind !== "ok") return <WdRefusal result={res} subject="the experiments" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs} />
      <ExperimentsView
        siteName={s.name} analyticsHref={analyticsHref} hrefBase={here} propertyId={res.propertyId}
        tenantSlug={t.slug} siteId={s.siteId} canUpdate={can(c.me, "search.manage", c.company)} experiments={res.experiments}
      />
    </div>
  );
}
