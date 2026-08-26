import { HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { money, type AgingRow, type Problem } from "@/lib/finance";

// The aging bucket table, shared by receivables and payables.
//
// ── ONE COMPONENT, BECAUSE THE TWO ARE THE SAME REPORT ─────────────────────────────────────────
// AR and AP differ in exactly two ways: whose name is in the first column, and which direction the
// money runs. Everything else — five buckets, a total, and a tie-out against the control account —
// is identical, and keeping two copies is how the 61–90 bucket ends up computed one way on one page
// and another way on the other.
//
// ── THE TIE-OUT IS THE HEADLINE, NOT A FOOTNOTE ────────────────────────────────────────────────
// An aging that does not tie to its control account is not a report with a discrepancy — it is two
// contradictory answers to "what are we owed", and neither can be trusted. So the verdict renders
// ABOVE the figures, in the same posture as the trial balance's balanced badge. A reader who scrolls
// past a green badge has lost nothing; a reader who reads a broken aging as fact has lost a lot.
export interface AgingTableProps {
  rows: AgingRow[];
  /** Header for the first column — "Customer" or "Vendor". */
  partyLabel: string;
  /** Pulls the party's display name out of a row; the two subledgers name the field differently. */
  partyName: (row: AgingRow) => string;
  partyCode: (row: AgingRow) => string;
  /** Null when the caller could not read the reconciliation at all (no access), which is NOT the
   *  same as a clean tie-out and must not render as one. */
  verdict: { clean: boolean; problems: Problem[] } | null;
  /** Rendered above the table when there is nothing outstanding. */
  emptyNote: string;
  currency?: string;
}

export function AgingTable({
  rows, partyLabel, partyName, partyCode, verdict, emptyNote, currency = "IDR",
}: AgingTableProps) {
  // Column totals, computed here rather than asked of the API: they must agree with the rows the
  // reader is looking at. A server-side total that disagreed with the visible rows would be the
  // worst of both — authoritative-looking and contradicted on screen.
  const sum = (pick: (r: AgingRow) => string) =>
    rows.reduce((t, r) => t + Number(pick(r) || 0), 0);

  return (
    <>
      {/* Badge labels are the SHARED status vocabulary (`statusColor` in ui.tsx), not free text —
          "active"/"blocked"/"archived" are the same three the overview's Verdict uses for exactly
          these reconciliations. Inventing prettier labels here would silently drop them into the
          default bronze "progress" family, so a broken tie-out would stop rendering as critical. */}
      <div className="fin-verdict" style={{ marginBottom: 16 }}>
        {verdict == null ? (
          // Three distinct states, never collapsed: tied, broken, and NOT CHECKED. Rendering an
          // unreadable reconciliation as "clean" would be a fabricated assurance.
          <StatusBadge label="archived" />
        ) : verdict.clean ? (
          <StatusBadge label="active" />
        ) : (
          <StatusBadge label="blocked" />
        )}
        <span className="fin-verdict__note">
          {verdict == null
            ? "The reconciliation endpoint could not be read, so whether this aging agrees with the balance sheet is unknown. Treat the figures below as unverified."
            : verdict.clean
              ? "The sum of this aging equals the control account's balance in the general ledger, so the subledger and the balance sheet agree."
              : `This aging and the control account disagree across ${verdict.problems.length} check(s). Until that is resolved, the two answer the same question differently and neither is authoritative.`}
        </span>
      </div>

      {verdict && !verdict.clean && verdict.problems.length > 0 ? (
        <HairlineTable
          columns={[{ label: "Problem" }, { label: "Detail" }]}
          rows={verdict.problems.map((p) => [p.problem, p.detail])}
        />
      ) : null}

      {rows.length === 0 ? (
        <EmptyNote>{emptyNote}</EmptyNote>
      ) : (
        <HairlineTable
          columns={[
            { label: partyLabel },
            { label: "Current", align: "right" },
            { label: "1–30", align: "right" },
            { label: "31–60", align: "right" },
            { label: "61–90", align: "right" },
            { label: "90+", align: "right" },
            { label: "Total", align: "right" },
          ]}
          rows={[
            ...rows.map((r) => [
              `${partyCode(r)} · ${partyName(r)}`,
              money(r.current, currency),
              money(r.d1To30, currency),
              money(r.d31To60, currency),
              money(r.d61To90, currency),
              money(r.d90Plus, currency),
              money(r.totalOutstanding, currency),
            ]),
            [
              "Total",
              money(sum((r) => r.current), currency),
              money(sum((r) => r.d1To30), currency),
              money(sum((r) => r.d31To60), currency),
              money(sum((r) => r.d61To90), currency),
              money(sum((r) => r.d90Plus), currency),
              money(sum((r) => r.totalOutstanding), currency),
            ],
          ]}
        />
      )}
    </>
  );
}
