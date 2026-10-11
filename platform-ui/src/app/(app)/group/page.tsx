import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Card, Eyebrow } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { formatDateRange } from "@/lib/reports";
import { cardBody, consolidatedNote, sumRows, verticalLabel } from "@/lib/groupReport";
import { GROUP_PERIOD_KINDS, loadGroup, parseGroupPeriod } from "./loadGroup";
import { GroupNotice } from "./GroupNotice";

const MUTED = { margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

// PV1-06b — the group report (PV-D19): one card per company of the root, plus Sum of companies.
// The BFF owns the numbers and the rule for what may be added; this page only lays them out. A
// company with no Company Report shows that fact, never zeros, and the consolidated figure is a
// note until F9 eliminations exist.
export default async function GroupReportPage({ searchParams }: { searchParams: Promise<{ periodKind?: string }> }) {
  const periodKind = parseGroupPeriod((await searchParams).periodKind);
  const load = await loadGroup(periodKind);
  if (load.kind !== "ok") return <GroupNotice title="Group report" load={load} />;

  const { report } = load;
  const sums = sumRows(report);
  return (
    <>
      <PageHeader eyebrow="Group" title="Group report" />

      <nav aria-label="Period" style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
        <p style={MUTED}>{formatDateRange(report.start, report.end)}</p>
        {GROUP_PERIOD_KINDS.map((k) => (
          <Link
            key={k}
            href={`/group?periodKind=${k}`}
            aria-current={k === report.periodKind ? "true" : undefined}
            style={{ font: "600 13px var(--font-body)", color: "var(--erp-accent)", textDecoration: k === report.periodKind ? "underline" : "none" }}
          >
            {k === "day" ? "Day" : k === "week" ? "Week" : "Month"}
          </Link>
        ))}
      </nav>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
        {report.companies.map((card) => {
          const body = cardBody(card);
          return (
            <Card key={card.companyId} title={card.name} headerRight={<Eyebrow>{verticalLabel(card.vertical)}</Eyebrow>}>
              {body.kind === "off" ? (
                <p style={MUTED}>{body.text}</p>
              ) : (
                <DescriptionList
                  items={body.rows.map((r) => ({
                    label: r.label,
                    value: r.parts ? <>{r.value} <span style={{ color: "var(--erp-ink-60)" }}>({r.parts})</span></> : r.value,
                  }))}
                />
              )}
            </Card>
          );
        })}

        <Card title="Sum of companies" hint="Only figures that count separate things in each company are added. Percentages and averages are never added or averaged.">
          {sums.length === 0 ? (
            <p style={MUTED}>Nothing to add up for this period.</p>
          ) : (
            <DescriptionList
              items={sums.map((s) => ({
                label: s.label,
                value: <>{s.value} <span style={{ color: "var(--erp-ink-60)" }}>{s.across}</span></>,
              }))}
            />
          )}
        </Card>
      </div>

      <p role="note" style={{ ...MUTED, marginTop: 18 }}>{consolidatedNote(report.consolidatedReason)}</p>
    </>
  );
}
