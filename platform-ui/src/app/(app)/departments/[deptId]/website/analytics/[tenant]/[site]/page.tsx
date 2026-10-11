import { listSites } from "@/lib/webdeskContent";
import { readSiteAnalytics } from "@/lib/websiteAnalytics";
import { resolveRange } from "@/lib/websiteAnalyticsModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AnalyticsView } from "@/components/webdesk/analytics/AnalyticsView";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<{ from?: string; to?: string }>;

// Website -> Analytics -> site. Reads the site (for its domains), finds the search property for that domain, then the
// Umami reads through platform-nest. Anything that is not data is words: no property for the site, Umami not configured,
// Umami unreachable, a refusal. An empty dashboard is never drawn for a failed read.
export default async function WebsiteAnalyticsPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "analytics");
  const here = `${c.analyticsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the analytics" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the analytics" />;

  const range = resolveRange(sp.from, sp.to);
  const res = await readSiteAnalytics(c.userId, c.company, s.environments.map((e) => e.domain), range.from, range.to);
  if (res.kind === "no_property") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={[{ label: "Website" }, { label: "Analytics", href: c.analyticsBase }, { label: s.name }]} />
        <EmptyNote>
          No search property matches {s.name}&apos;s domain yet, so there is nothing to read analytics for. Add the site as a property in SEO and link it to its Umami website.
        </EmptyNote>
      </div>
    );
  }
  if (res.kind !== "ok") return <WdRefusal result={res} subject="the analytics" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Analytics", href: c.analyticsBase }, { label: s.name }]} />
      <AnalyticsView siteName={s.name} action={here} range={range} reads={res.reads} />
    </div>
  );
}
