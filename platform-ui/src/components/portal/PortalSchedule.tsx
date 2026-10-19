import Link from "next/link";
import { money, portalAddedAfterSigning, portalInstalmentDue, portalInstalmentState, type PortalSchedule as Schedule } from "@/lib/portal";
import { Card } from "@/components/ui";

// DW-10f-2b (BFF §61.6, §61.9) — the "Payment schedule" of one agreement, as the CLIENT reads it: a label, an amount, when it is due, and
// where it stands in the client's words ("On signing", "Due 12 Oct 2026", "Due", "Invoiced, <number>", "Paid", "Not billed").
//
// What the client NEVER sees here: an instalment id, a claim time, an invoice that is not issued yet (a draft invoice reads "Due",
// PV3-02d: the server already folds it, and this file never asks), or who on our side added a schedule after signing. A schedule added
// after the agreement was signed says so with the date: nobody signed it, so the page never implies they did. Renders nothing for
// a contract with no schedule. A plain server-safe component.
export function PortalSchedule({ schedule, company }: { schedule: Schedule | null | undefined; company?: string | null }) {
  if (!schedule || schedule.instalments.length === 0) return null;
  const cur = schedule.currency;
  return (
    <Card title="Payment schedule" hint="How the agreement's price is invoiced. Each instalment is invoiced once.">
      <table className="cp-sched" aria-label="Payment schedule instalments">
        <thead>
          <tr>
            <th scope="col">Instalment</th>
            <th scope="col">Due</th>
            <th scope="col" className="cp-sched__num">Amount</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {schedule.instalments.map((i) => {
            const state = portalInstalmentState(i);
            return (
              <tr key={i.position}>
                <td>{i.label}</td>
                <td>{portalInstalmentDue(i.due)}</td>
                <td className="cp-sched__num">{money(i.amount, cur)}</td>
                <td>
                  {i.invoice ? <Link className="cp-sched__link" href={`/portal/invoices/${encodeURIComponent(i.invoice.id)}`}>{state}</Link> : state}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>Total</th>
            <td className="cp-sched__num">{money(schedule.total, cur)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      {schedule.addedAfterSigning && <p className="cp-sched__note">{portalAddedAfterSigning(schedule.addedAfterSigning, company)}.</p>}
    </Card>
  );
}
