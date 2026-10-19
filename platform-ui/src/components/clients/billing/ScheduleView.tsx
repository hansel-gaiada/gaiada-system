import Link from "next/link";
import { addedAfterSigningWords, dueWords, formatAmountNumber, instalmentStateWords, type ContractSchedule } from "@/lib/contracts";
import { formatDate } from "@/lib/format";
import "./billing.css";

// DW-10f-2b (BFF §61.3, §61.9) — a contract's payment schedule, READ-ONLY: a draft's saved rows, and a sent or signed
// contract's fixed ones. Each instalment says its state in §61.3's words, and links the invoice that claims it. A schedule
// added after signing (DW-D49) says who added it and when, and never claims anyone signed it.
//
// Everything is the server's: the state is derived there (never stored, never worked out here), the amounts are formatted
// from the numbers it sent, and a state this file does not know prints as it came. A plain server-safe component.
export function ScheduleView({ schedule }: { schedule: ContractSchedule }) {
  const cur = schedule.currency;
  return (
    <section className="bl-sched" aria-label="Payment schedule">
      <h5 className="bl-sched__title">Payment schedule</h5>
      <table className="bl-sched__table" aria-label="Payment schedule instalments">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Instalment</th>
            <th scope="col">Due</th>
            <th scope="col" className="bl-sched__num">Amount</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {schedule.instalments.map((i) => {
            const words = instalmentStateWords(i, formatDate);
            return (
              <tr key={i.id}>
                <td>{i.position}</td>
                <td>{i.label}</td>
                <td>{dueWords(i.due, formatDate)}</td>
                <td className="bl-sched__num">{formatAmountNumber(i.amount, cur)}</td>
                <td>
                  {i.invoice ? <Link className="bl-filelink" href={`/invoices/${encodeURIComponent(i.invoice.id)}`}>{words}</Link> : words}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>Total</th>
            <td className="bl-sched__num">{formatAmountNumber(schedule.total, cur)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      {schedule.addedAfterSigning && (
        <p className="bl-contract__meta">
          {addedAfterSigningWords(schedule.addedAfterSigning, formatDate)}. The agreement was signed without this schedule; it restates the
          payment terms in its text.
        </p>
      )}
      {!schedule.matchesValue && (
        <p className="bl-msg bl-msg--error">
          This schedule does not add up to the contract&apos;s value ({formatAmountNumber(schedule.total, cur)} of {schedule.value == null ? "no value" : formatAmountNumber(schedule.value, cur)}).
        </p>
      )}
    </section>
  );
}
