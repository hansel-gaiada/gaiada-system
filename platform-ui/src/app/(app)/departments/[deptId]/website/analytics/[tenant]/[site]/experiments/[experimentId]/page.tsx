import { notFound } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { readExperimentDetail } from "@/lib/experiments";
import { can } from "@/lib/rbac";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import { ExperimentDetailView } from "../_components/ExperimentDetailView";

type Params = Promise<{ deptId: string; tenant: string; site: string; experimentId: string }>;

// One test: progress and the sample-ratio check until its planned size is reached, the full result after. Same guards as
// the list page. The result body is parsed so that nothing but progress can come out of a pre-horizon answer.
export default async function WebsiteExperimentPage({ params }: { params: Params }) {
  const { deptId, tenant, site, experimentId } = await params;
  const c = await requireWebsiteCtx(deptId, "analytics");
  if (!can(c.me, "search.view", c.company)) notFound();
  const analyticsHref = `${c.analyticsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const listHref = `${analyticsHref}/experiments`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the test" retryHref={listHref} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the test" />;

  const crumbs = [{ label: "Website" }, { label: "Analytics", href: c.analyticsBase }, { label: s.name, href: analyticsHref }, { label: "Experiments", href: listHref }, { label: "Test" }];
  const res = await readExperimentDetail(c.userId, c.company, s.environments.map((e) => e.domain), experimentId);
  if (res.kind === "no_property") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs} />
        <EmptyNote>No search property matches {s.name}&apos;s domain, so this test cannot be read.</EmptyNote>
      </div>
    );
  }
  if (res.kind !== "ok") return <WdRefusal result={res} subject="the test" retryHref={`${listHref}/${encodeURIComponent(experimentId)}`} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs} />
      <ExperimentDetailView experiment={res.experiment} results={res.results} canUpdate={can(c.me, "search.manage", c.company)} listHref={listHref} propertyId={res.propertyId} />
    </div>
  );
}
