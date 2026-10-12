import { listSites } from "@/lib/webdeskContent";
import { readSiteAiVisibility } from "@/lib/aiVisibility";
import { resolveRange } from "@/lib/websiteAnalyticsModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AiVisibilityView } from "@/components/webdesk/analytics/AiVisibilityView";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<{ from?: string; to?: string }>;

// Website -> Analytics -> site -> AI visibility (M5-P5b, SM-16). The AI-crawler log (daily counts per bot from the
// site's access log) and the AI-answer results (brand mentioned / cited). Each read says in words when it has no
// data or failed; a missing log is never drawn as zero hits.
export default async function WebsiteAiVisibilityPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "analytics");
  const analyticsHref = `${c.analyticsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${analyticsHref}/ai-visibility`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the AI visibility" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the AI visibility" />;

  const range = resolveRange(sp.from, sp.to);
  const res = await readSiteAiVisibility(c.userId, c.company, s.environments.map((e) => e.domain), range.from, range.to);
  const crumbs = [{ label: "Website" }, { label: "Analytics", href: c.analyticsBase }, { label: s.name, href: analyticsHref }, { label: "AI visibility" }];
  if (res.kind === "no_property") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs} />
        <EmptyNote>
          No search property matches {s.name}&apos;s domain yet, so there is nothing to read AI visibility for. Add the site as a property in SEO first.
        </EmptyNote>
      </div>
    );
  }
  if (res.kind !== "ok") return <WdRefusal result={res} subject="the AI visibility" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs} />
      <AiVisibilityView siteName={s.name} action={here} analyticsHref={analyticsHref} range={range} crawlers={res.crawlers} visibility={res.visibility} />
    </div>
  );
}
