import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getActiveTenant } from "@/lib/tenant";
import { guardAdminRoute } from "@/lib/adminGuard";
import { getRollups, type RollupRow } from "@/lib/entities";
import { getMe, PlatformError } from "@/lib/platform";
import { groupRollups } from "@/lib/rollups";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { RecomputeButton } from "@/components/RecomputeButton";
import { ScopeBar } from "@/components/scope/ScopeBar";
import { currentAxisValue, wholeGroupOption, type ScopeAxisConfig } from "@/lib/scope";
import { groupNameOf } from "@/lib/companyContext";

export default async function RollupsPage({ searchParams }: { searchParams: Promise<{ period?: string; entity?: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenantId = await getActiveTenant(me);
  guardAdminRoute("/rollups", me, tenantId); // DW-D20
  // PV-D13: the group's name comes from data; a person outside the root gets the plain wording.
  const groupName = groupNameOf(me, tenantId);
  const groupSubtitle = groupName ? `Cross-company metrics across the ${groupName} group.` : "Cross-company metrics across your group.";
  const sp = await searchParams;
  const periodParam = sp.period;

  let rows: RollupRow[];
  try {
    rows = await getRollups(userId, periodParam);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Rollups" subtitle={groupSubtitle} />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              This view is limited to group executives.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  const allGroups = groupRollups(rows);
  const period = periodParam ?? rows[0]?.period;

  // The scope bar's reference wiring (UI redesign §3): Rollups is the one page that was ALREADY
  // consolidated-by-default with no control surfacing that fact — exactly the gap the Entity axis
  // exists to close. "Whole group" is the explicit default; picking a company narrows the SAME
  // already-fetched cross-company result set, so this needs no new backend read.
  const entityAxis: ScopeAxisConfig = {
    key: "entity",
    param: "entity",
    label: "Entity",
    defaultValue: "all",
    options: [wholeGroupOption(), ...allGroups.map((g) => ({ value: g.tenantId, label: g.company }))],
  };
  const entityValue = currentAxisValue(sp, entityAxis);
  const groups = entityValue === "all" ? allGroups : allGroups.filter((g) => g.tenantId === entityValue);

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Rollups"
        subtitle={<>{groupSubtitle}{period ? ` Period: ${period}.` : ""}</>}
        actions={
          <form method="get" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="date" name="period" defaultValue={period ?? undefined} aria-label="Period"
              style={{ border: "0.5px solid var(--erp-hairline)", background: "transparent", padding: "6px 8px", font: "400 13px var(--font-body)", color: "var(--text-primary)" }} />
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">View</button>
          </form>
        }
      />
      <ScopeBar basePath="/rollups" searchParams={sp} axes={allGroups.length > 0 ? [entityAxis] : []} />
      {groups.length === 0 ? (
        <Card>
          <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
            No rollup metrics for this period yet — try recomputing a company below once figures are ready.
          </p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
          {groups.map((group) => (
            <Card
              key={group.tenantId}
              title={group.company}
              headerRight={<RecomputeButton tenantId={group.tenantId} />}
            >
              {group.metrics.length <= 4 ? (
                <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                  {group.metrics.map((m) => (
                    <KpiTile
                      key={m.key}
                      label={m.key}
                      value={m.ratio != null ? `${(m.ratio * 100).toFixed(0)}%` : formatMetric(m.value, m.currency)}
                    />
                  ))}
                </div>
              ) : (
                <HairlineTable
                  columns={[{ label: "Metric" }, { label: "Value", align: "right" }, { label: "Ratio", align: "right" }]}
                  rows={group.metrics.map((m) => [
                    m.key,
                    formatMetric(m.value, m.currency),
                    m.ratio != null ? `${(m.ratio * 100).toFixed(0)}%` : "—",
                  ])}
                />
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function formatMetric(value: number, currency: string | null): string {
  const formatted = value.toLocaleString();
  return currency ? `${currency} ${formatted}` : formatted;
}
