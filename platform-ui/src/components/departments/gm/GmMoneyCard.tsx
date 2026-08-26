import Link from "next/link";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { listPeriods, getProfitAndLoss, getArAging } from "@/lib/finance";
import { summarizePnl, summarizeArAging, formatMoneyShort, formatRate } from "@/lib/gmMoney";

// The GM money tier (GM-09) — one card, rendered by both the cockpit and the Clients & Money tab.
//
// ── HISTORY, BECAUSE IT EXPLAINS THE SHAPE ───────────────────────────────────────────────────────
// This was blocked for the whole build as B2: "no tenant-level spend or margin endpoint exists".
// True at the time — the only money data in the estate was `GET engagements/:id/ledger`, one
// department's search-marketing provider spend, and OQ-3 ruled that summing it into a company figure
// was forbidden. A real double-entry finance module then landed (`platform-nest/src/modules/finance`,
// Cerbos-authorized, `finance_profit_and_loss()` in Postgres), and the block dissolved: revenue and
// margin are now available at exactly the grain the cockpit needs, from the books rather than from
// one department's provider bills.
//
// ── WHAT IT ANSWERS, AND WHY ONLY THAT ───────────────────────────────────────────────────────────
// Owner ruling (2026-08-26): the money tier answers **"are we making money?"** first — revenue, net
// margin, and overdue receivables as the single collection signal. The finance module exposes far
// more (balance sheet, AP, tax, close-readiness, ledger integrity) and all of it is one click away in
// `/finance`; putting it here would blow the cockpit's 5–9 element budget and turn an at-a-glance
// surface into a second finance console. Compose and link out — the same ruling as OQ-0.
//
// ── THREE STATES THAT MUST NOT LOOK ALIKE ────────────────────────────────────────────────────────
// `listPeriods` is the GATE read, and it is the only finance reader that distinguishes 403 from 404
// (its own header says so). That distinction is the whole reason it is called here rather than just
// reading the P&L:
//   null → **forbidden.** This principal has no finance access. Render nothing at all on the cockpit
//          rather than a refusal note: a GM without finance access does not need a permanent scolding
//          on their home screen, and the tab states it properly.
//   []   → **reachable, but no fiscal calendar exists** (or the module is not enabled for this
//          company — it is `ModuleEnabledGuard("finance")`-gated per tenant). That is a setup state,
//          not a money state, and it gets a `BackendPending`-style pointer rather than zeros.
//   rows → real books. Only then are figures rendered.
//
// `getProfitAndLoss` and `getArAging` both fold 403/404 into `[]` (`financeData`), so on their own
// they cannot tell "no access" from "no data" — which is exactly why the gate read leads.

const KPI_ROW: React.CSSProperties = {
  display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
};

export interface GmMoneyCardProps {
  userId: string;
  tenantId: string;
  /** Inclusive P&L window. The cockpit passes its own period; the tab passes the same. */
  from: string;
  to: string;
  /** `compact` (the cockpit) renders the three tiles only. The tab renders the worst-payer list too. */
  variant: "compact" | "full";
  /** Rendered when the principal has no finance access. The cockpit passes `false` so the card
   *  disappears entirely; the tab passes `true` so the reason is stated where it was asked for. */
  explainRefusal: boolean;
}

export async function GmMoneyCard({ userId, tenantId, from, to, variant, explainRefusal }: GmMoneyCardProps) {
  const periods = await listPeriods(userId, tenantId);

  if (periods === null) {
    if (!explainRefusal) return null;
    return (
      <Card title="Money">
        <EmptyNote>
          Company finances are limited to finance and administrator roles, and this account holds
          neither. The rest of this tab is unaffected.
        </EmptyNote>
      </Card>
    );
  }

  if (periods.length === 0) {
    return (
      <Card title="Money">
        <BackendPending
          what="This company has no fiscal calendar yet — or the finance module is not enabled for it — so there are no books to report from. This is a setup state, not a zero."
          contract="GET /api/:t/finance/periods"
        />
        <EmptyNote>
          Nothing is rendered above rather than zeros, because a zero here would read as
          &ldquo;we earned nothing&rdquo;.
        </EmptyNote>
      </Card>
    );
  }

  const [pnlRows, arRows] = await Promise.all([
    getProfitAndLoss(userId, tenantId, from, to),
    getArAging(userId, tenantId, to),
  ]);
  const pnl = summarizePnl(pnlRows);
  const ar = summarizeArAging(arRows);

  return (
    <Card
      title="Money"
      headerRight={
        <Link href="/finance/reports" className="lux-btn lux-btn--ghost lux-btn--sm">Finance</Link>
      }
    >
      {pnl.totalsMissing ? (
        <EmptyNote>
          The profit &amp; loss statement carried no totals for this period — a reporting gap, not a
          period in which nothing was earned.
        </EmptyNote>
      ) : (
        <div style={KPI_ROW}>
          <KpiTile
            label="Revenue"
            value={formatMoneyShort(pnl.revenue)}
            foot={`${from} → ${to}`}
            hint="Total revenue for the period, read from the ledger's own P&L totals — never re-summed from the line rows, so it cannot disagree with the finance console."
          />
          <KpiTile
            label="Net margin"
            value={formatRate(pnl.marginRate)}
            foot={pnl.net === null ? "net not reported" : `${formatMoneyShort(pnl.net)} net`}
            hint="Net profit over revenue. A dash means revenue was zero or a total was missing — a margin on no revenue is undefined, not 0%."
          />
          <KpiTile
            label="Overdue receivables"
            value={formatMoneyShort(ar.overdue)}
            foot={ar.over90 > 0 ? `${formatMoneyShort(ar.over90)} past 90 days` : "nothing past 90 days"}
            hint="Outstanding less current, so it follows the server's own total whatever the bucket boundaries are."
          />
        </div>
      )}

      {variant === "full" && ar.worstCustomers.length > 0 && (
        <p style={{ margin: "14px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          <strong>Past 90 days:</strong>{" "}
          {ar.worstCustomers.slice(0, 5).map((c, i) => (
            <span key={c.name}>
              {i > 0 ? " · " : ""}{c.name} {formatMoneyShort(c.over90)}
            </span>
          ))}
          {ar.worstCustomers.length > 5 ? ` · +${ar.worstCustomers.length - 5} more` : ""}
        </p>
      )}
      {variant === "full" && ar.customers === 0 && (
        <p style={{ margin: "14px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No customer has an open receivable balance.
        </p>
      )}
    </Card>
  );
}
