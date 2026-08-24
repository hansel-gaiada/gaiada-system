import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPayslips, getLeaveLedger, formatMoney, minutesToDays } from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// /me › Pay — the employee's OWN payslips and the ledger behind their leave balance.
//
// This is the personal hub's read, not an HR surface, and the boundary is enforced server-side in two
// places at once (resource_hr_payroll.yaml's member arm requires BOTH `subjectUserId == principal.id`
// AND `published == true`; payroll.controller.ts applies the same two narrowings in SQL). This page
// passes no subject at all — it asks for "mine" and the backend decides what that means, which is the
// only arrangement in which the page and the policy cannot disagree.
//
// A DRAFT payslip mid-run is deliberately invisible here. A run being recalculated would otherwise
// show half-computed figures to the person they are about, who has no way to know they are provisional.
export default async function MyPayPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const year = new Date().getUTCFullYear();
  const [payslips, ledger] = await Promise.all([
    listPayslips(userId, tenant),
    getLeaveLedger(userId, tenant, undefined, year),
  ]);

  const latest = payslips[0];
  // Year-to-date across the published slips this person can see. Deliberately labelled "published"
  // rather than "YTD": a slip that has not been released yet is not in this sum, and calling it a
  // plain year-to-date would quietly under-report.
  const ytdNet = payslips
    .filter((p) => p.periodStart.startsWith(String(year)))
    .reduce((sum, p) => sum + Number(p.net), 0);
  const ytdTax = payslips
    .filter((p) => p.periodStart.startsWith(String(year)))
    .reduce((sum, p) => sum + Number(p.taxWithheld), 0);
  const currency = latest?.currency ?? "IDR";

  const ledgerTotal = (ledger?.entries ?? []).reduce((sum, e) => sum + e.minutes, 0);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="Latest payslip"
          value={latest ? formatMoney(latest.net, latest.currency) : "—"}
          foot={latest ? `${latest.periodStart} → ${latest.periodEnd}` : "nothing published yet"}
        />
        <KpiTile label={`Net ${year}`} value={formatMoney(ytdNet, currency)} foot="published payslips only" />
        <KpiTile label={`Tax withheld ${year}`} value={formatMoney(ytdTax, currency)} foot="PPh 21" />
        <KpiTile
          label="Leave allocated"
          value={`${minutesToDays(ledgerTotal)}d`}
          foot={`${year} · from the accrual ledger`}
        />
      </div>

      <Card title="My payslips" style={{ marginBottom: 22 }}>
        {payslips.length === 0 ? (
          <EmptyNote>
            No payslips have been published to you yet. A payslip becomes visible here when HR publishes
            the run — which is a separate step from approving it, so an approved run may exist without
            anything appearing on this page.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Period" }, { label: "Kind" }, { label: "Gross", align: "right" },
              { label: "Tax", align: "right" }, { label: "Net", align: "right" },
            ]}
            rows={payslips.map((p) => [
              <Link key={p.id} href={`/me/pay/${p.id}`} style={{ color: "var(--erp-accent)" }}>
                {p.periodStart} → {p.periodEnd}
              </Link>,
              p.runKind,
              formatMoney(p.gross, p.currency),
              formatMoney(p.taxWithheld, p.currency),
              formatMoney(p.net, p.currency),
            ])}
          />
        )}
      </Card>

      <Card
        title={`Leave ledger ${year}`}
        hint="Every movement in your allocated leave, and why. This is what a balance figure is made of."
      >
        {!ledger || ledger.entries.length === 0 ? (
          <EmptyNote>
            No accrual entries for {year}. A balance with no ledger behind it is a number somebody typed —
            if you see one on <Link href="/me/leave" style={{ color: "var(--erp-accent)" }}>Leave</Link> but
            nothing here, it predates the accrual engine.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "When" }, { label: "Kind" }, { label: "Type" },
              { label: "Days", align: "right" }, { label: "Why" },
            ]}
            rows={ledger.entries.map((e, i) => [
              e.periodEnd ?? e.createdAt.slice(0, 10),
              e.kind,
              e.leaveType,
              // An expiry or a correction is negative, and the sign is the whole meaning of the row.
              `${e.minutes < 0 ? "−" : "+"}${minutesToDays(Math.abs(e.minutes))}`,
              <span key={i} style={{ color: "var(--erp-ink-60)" }}>{e.reason ?? "—"}</span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
