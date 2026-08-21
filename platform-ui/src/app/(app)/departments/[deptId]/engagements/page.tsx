import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import {
  listEngagements,
  listProperties,
  formatUsd,
  isToggleEnabled,
  CAPABILITY_TOGGLE,
  type SearchEngagement,
  type SearchProperty,
} from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Engagements — the one Accounts tab whose backend is fully landed (SM-01/02/04),
// so this renders REAL data rather than a pending banner.
//
// The column that matters most here is "Metered tools": a client engagement can
// exist, be active, and still refuse every paid pull, because each metered
// capability rides its own tool-scope toggle (D-11) and an absent toggle counts
// as OFF. Showing the enabled count next to the budget is what makes a silent
// "why did nothing happen?" into a visible "nothing is switched on". SM-29 turns
// that summary into the editable toggle grid with per-toggle cost projection.
export default async function DepartmentEngagementsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  // Both degrade to empty on 404/403 (module disabled for this tenant, or a
  // Cerbos denial), so the tab renders its empty state instead of erroring.
  const [engagements, properties] = await Promise.all([
    listEngagements(userId, tenant),
    listProperties(userId, tenant),
  ]);

  const canManage = can(me, "search.manage", tenant);
  const canWriteScope = can(me, "search.scope.write", tenant);

  const propertyById = new Map<string, SearchProperty>(properties.map((p) => [p.id, p]));
  const meteredToggles = Object.values(CAPABILITY_TOGGLE);

  function meteredSummary(e: SearchEngagement): string {
    const on = meteredToggles.filter((t) => isToggleEnabled(e.toolScope, t)).length;
    if (on === 0) return "none enabled";
    return `${on} of ${meteredToggles.length} on`;
  }

  const rows = engagements.map((e) => {
    const prop = e.propertyId ? propertyById.get(e.propertyId) : undefined;
    return [
      <Link key="n" href={`/departments/${deptId}/engagements/${e.id}`}>{e.name}</Link>,
      prop ? prop.domain : "—",
      <StatusBadge key="s" label={e.status} />,
      meteredSummary(e),
      formatUsd(e.providerBudgetUsd),
    ];
  });

  return (
    <>
      <Card
        title="Engagements"
        headerRight={<CostTierBadge tier="free" />}
      >
        {engagements.length === 0 ? (
          <TeachState
            glyph="◎"
            title="No engagements yet"
            body={
              canManage
                ? "An engagement is one client's search-marketing retainer: the property it covers, which metered tools are switched on, and the monthly provider budget it may spend. Register a property first, then open an engagement against it."
                : "No client engagements have been set up for this company yet."
            }
            ctaLabel={canManage ? "Manage properties" : undefined}
            ctaHref={canManage ? `/departments/${deptId}/audit` : undefined}
          />
        ) : (
          <div className="lux-table-scroll erp-scroll" style={{ ["--lux-table-min" as string]: "840px" }}>
            <HairlineTable
              columns={[
                { label: "Engagement" },
                { label: "Property" },
                { label: "Status" },
                { label: "Metered tools" },
                { label: "Provider budget", align: "right" },
              ]}
              rows={rows}
              tcols="2fr 1.6fr .8fr 1fr .9fr"
            />
          </div>
        )}
      </Card>

      <Card title="Properties" headerRight={<CostTierBadge tier="free" />}>
        {properties.length === 0 ? (
          <TeachState
            glyph="⌘"
            title="No properties registered"
            body="A property is a client domain this department works on. Crawls, keywords, rankings and briefs all hang off it."
          />
        ) : (
          <div className="lux-table-scroll erp-scroll" style={{ ["--lux-table-min" as string]: "780px" }}>
            <HairlineTable
              columns={[{ label: "Domain" }, { label: "Site URL" }, { label: "Verified" }, { label: "Status" }]}
              rows={properties.map((p) => [
                p.domain,
                p.siteUrl ?? "—",
                p.verifiedAt ? new Date(p.verifiedAt).toLocaleDateString() : "not verified",
                <StatusBadge key="s" label={p.status} />,
              ])}
              tcols="1.4fr 1.6fr .9fr .8fr"
            />
          </div>
        )}
      </Card>

      {!canWriteScope && engagements.length > 0 && (
        <p style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 12 }}>
          Changing which metered tools an engagement may use, or its provider budget, needs the
          elevated <code>search.scope.write</code> permission — the same gate the backend enforces in
          Cerbos, so this is a hint rather than the boundary itself.
        </p>
      )}
    </>
  );
}
