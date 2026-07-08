import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getRollups, type RollupRow } from "@/lib/entities";
import { PlatformError } from "@/lib/platform";
import { groupRollups } from "@/lib/rollups";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { RecomputeButton } from "@/components/RecomputeButton";

export default async function RollupsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  let rows: RollupRow[];
  try {
    rows = await getRollups(userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Rollups" subtitle="Cross-company metrics across the Gaiada group." />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              This view is limited to group executives.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  const groups = groupRollups(rows);
  const period = rows[0]?.period;

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Rollups"
        subtitle={
          <>
            Cross-company metrics across the Gaiada group.{period ? ` Period: ${period}.` : ""}
          </>
        }
      />
      {groups.length === 0 ? (
        <Card>
          <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
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
