import { readRules, resolveSiteProperty } from "@/lib/visitors";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { InterestRulesForm } from "@/components/webdesk/visitors/InterestRulesForm";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website -> Visitors -> site -> Interest rules. Which pages and sections count towards which interest, and how much. The rules are
// the ONLY source of a visitor's interests. A failed read is words and no form: an empty form on a failed read would let a save
// wipe every rule.
export default async function WebsiteInterestRulesPage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId, "visitors");
  const list = `${c.visitorsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${list}/interest-rules`;

  const r = await resolveSiteProperty(c.userId, c.company, tenant, site);
  if (r.kind === "no_site") return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the interest rules" />;
  if (r.kind === "no_property") {
    return <div className="wc-page"><EmptyNote>No search property matches {r.siteName}&apos;s domain, so there are no interest rules to edit.</EmptyNote></div>;
  }
  if (r.kind !== "ok") return <WdRefusal result={r} subject="the interest rules" retryHref={here} />;

  const rules = await readRules(c.userId, c.company, r.property.id);
  const crumbs = [{ label: "Website" }, { label: "Visitors", href: c.visitorsBase }, { label: r.siteName, href: list }, { label: "Interest rules" }];
  if (rules.state !== "ok") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs} />
        <div className="wc-notice wc-notice--bad" role="alert" data-testid="rules-unavailable">
          <h2>The interest rules could not be read</h2>
          <p>{rules.message}</p>
          <p>The form is not shown, so a save cannot overwrite rules that could not be loaded.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs} />
      <p className="wc-lede">
        Interest rules turn a visitor&apos;s page views into interests: a visit to a page whose path starts with a pattern counts its weight towards a tag. Interests and scores follow the rules at the next daily refresh.
      </p>
      <Card title="Interest rules">
        <InterestRulesForm propertyId={rules.data.propertyId} initial={rules.data.rules} note={rules.data.note} />
      </Card>
    </div>
  );
}
