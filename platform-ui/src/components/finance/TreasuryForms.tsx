"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { createInstrument, postInstrumentAccrual } from "@/lib/financeActions";
// TYPE-ONLY import, deliberately. `lib/finance.ts` opens with `import "server-only"` and this file
// is `"use client"` — pulling in any VALUE from that module drags the guard into the client bundle
// and fails the build. ArForms.tsx and ApForms.tsx hit this same wall first.
import type { InstrumentScheduleRow } from "@/lib/finance";

const today = () => new Date().toISOString().slice(0, 10);

type InstrumentKind = "loan_payable" | "loan_receivable" | "bond_issued" | "lease";
const KINDS: Array<{ value: InstrumentKind; label: string }> = [
  { value: "loan_payable", label: "Loan (we owe)" },
  { value: "loan_receivable", label: "Loan (owed to us)" },
  { value: "bond_issued", label: "Bond issued" },
  { value: "lease", label: "Lease" },
];

export function CreateInstrumentForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <Card
      title="Record an instrument"
      hint="A loan, bond or lease — one model, distinguished by kind. This is the first step toward the treasury tie-out going green: today's discrepancy is untagged accounts, not a missing entry."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const maturity = String(fd.get("maturityDate") || "");
          const nominal = String(fd.get("nominalRate") || "");
          const effective = String(fd.get("effectiveRate") || "");
          start(async () => {
            const r = await createInstrument({
              code: String(fd.get("code")).trim(),
              name: String(fd.get("name")).trim(),
              kind: String(fd.get("kind")) as InstrumentKind,
              counterpartyName: String(fd.get("counterpartyName") || "") || undefined,
              currencyCode: String(fd.get("currencyCode") || "IDR"),
              principal: Number(fd.get("principal") || 0),
              nominalRate: nominal ? Number(nominal) : null,
              effectiveRate: effective ? Number(effective) : null,
              startDate: String(fd.get("startDate")),
              maturityDate: maturity || undefined,
              paymentMonths: Number(fd.get("paymentMonths") || 1),
              repaymentMethod: String(fd.get("repaymentMethod") || "annuity"),
            });
            if (r.ok) setDone(`${r.result?.code ?? "Instrument"} recorded.`);
            else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="instr-code">Code</label>
          <input id="instr-code" name="code" required placeholder="BCA-02" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-name">Name</label>
          <input id="instr-name" name="name" required placeholder="Kredit investasi BCA" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-kind">Kind</label>
          <select id="instr-kind" name="kind" defaultValue="loan_payable">
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-counterparty">Counterparty</label>
          <input id="instr-counterparty" name="counterpartyName" placeholder="Bank BCA" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-currency">Currency</label>
          <input id="instr-currency" name="currencyCode" defaultValue="IDR" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-principal">Principal</label>
          <input id="instr-principal" name="principal" type="number" min="1" step="1000" required />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-nominal">Nominal rate (%)</label>
          <input id="instr-nominal" name="nominalRate" type="number" min="0" max="100" step="0.1" />
          <span className="fin-muted">A percent — 11.5 for 11.5%, unlike AP withholding elsewhere in this module, which is a rate.</span>
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-effective">Effective rate (%)</label>
          <input id="instr-effective" name="effectiveRate" type="number" min="0" max="100" step="0.1" />
          <span className="fin-muted">Leave blank to amortise at the nominal rate.</span>
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-start">Start date</label>
          <input id="instr-start" name="startDate" type="date" defaultValue={today()} required />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-maturity">Maturity date</label>
          <input id="instr-maturity" name="maturityDate" type="date" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-months">Payment months</label>
          <input id="instr-months" name="paymentMonths" type="number" min="1" step="1" defaultValue={1} />
          <span className="fin-muted">1 for monthly instalments.</span>
        </div>
        <div className="fin-form__field">
          <label htmlFor="instr-repayment">Repayment method</label>
          <input id="instr-repayment" name="repaymentMethod" defaultValue="annuity" />
        </div>

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Recording…" : "Record instrument"}</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Post the accrual for ONE INSTALMENT — keyed on the schedule SEQ, never a fiscal period. See
 * `lib/financeActions.ts::postInstrumentAccrual`'s own note on why that is the correct key: the
 * schedule is derived at the effective rate, so instalment #n has a definite interest figure
 * regardless of which period it lands in.
 *
 * No confirmation gate — this is a repeatable, idempotent post in the same sense
 * `RunDepreciationForm` is: the server refuses a `seq` the schedule does not contain, and posting
 * the same instalment twice is a question for the database, not a typed-confirmation dialog.
 */
export function PostAccrualForm({
  instrumentId, instrumentCode, schedule,
}: {
  instrumentId: string;
  instrumentCode: string;
  schedule: InstrumentScheduleRow[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [seq, setSeq] = useState(schedule[0]?.seq ?? 1);

  if (schedule.length === 0) {
    return (
      <p className="fin-muted" style={{ marginBlockStart: 16 }}>
        No schedule could be derived for this instrument, so there is no instalment to accrue.
      </p>
    );
  }

  return (
    <form
      className="fin-form"
      style={{ marginBlockStart: 16 }}
      action={() => {
        setError(null); setDone(null);
        start(async () => {
          const r = await postInstrumentAccrual(instrumentId, seq);
          if (r.ok) setDone(`Instalment #${r.result?.seq} accrued and posted.`);
          else setError(r.error ?? "Failed.");
        });
      }}
    >
      <div className="fin-form__field">
        <label htmlFor="accrual-seq">Instalment</label>
        <select id="accrual-seq" value={seq} onChange={(e) => setSeq(Number(e.target.value))}>
          {schedule.map((s) => (
            <option key={s.seq} value={s.seq}>
              #{s.seq} · due {s.dueDate} · interest {Number(s.interest).toLocaleString("id-ID")}
            </option>
          ))}
        </select>
        <span className="fin-muted">
          Interest accrues whether or not anyone records it — a schedule row left unposted
          understates both the expense and the debt.
        </span>
      </div>

      {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
      {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

      <div className="fin-form__actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Posting…" : `Post accrual for ${instrumentCode} #${seq}`}
        </Button>
      </div>
    </form>
  );
}
