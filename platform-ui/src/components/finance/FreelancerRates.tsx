"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SecondFactorPrompt } from "@/components/auth/SecondFactorPrompt";
import { addRateAction, endRateAction, linkVendorAction, withdrawRateAction, type FlActionResult } from "@/lib/freelancersActions";
import { isAssuranceRefusal } from "@/lib/stepUp";
import { formatAmount, rangeLabel, type Freelancer, type FlRate } from "@/lib/freelancers";
import type { ReadResult } from "@/lib/readResult";
import "./freelancers.css";

// DW-10f-4b — Finance > Payables > Freelancers > Rates (BFF §61.7): who bills by the hour, at what rate, and which vendor pays them.
//
// ── THE SERVER IS THE BOUNDARY ──────────────────────────────────────────────────────────────────────────────
// Rates and the vendor link are `finance_ap` `vendor_master` (money terms and payees: high assurance). The controls here are offered to
// everyone who can read the page (`finance_ap` has no UI capability, DW-7b); Cerbos decides, and a refusal comes back in words. A 403 that
// names assurance shows the second-factor prompt. Every other refusal (`rate_overlap`, `rate_used`, `person_has_vendor`, ...) is a
// sentence from `refusalSentence`. Nothing is guessed here: the rate is sent as the text typed and every figure is re-read after a write.

export interface PersonOption { id: string; name: string; email?: string }
export interface AccountOption { code: string; name: string }
export interface VendorOption { id: string; code: string; name: string; userId?: string | null }

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsFactor, setNeedsFactor] = useState(false);
  const run = <T,>(fn: () => Promise<FlActionResult<T>>, done: (r: FlActionResult<T>) => string) => {
    setError(null); setNotice(null); setNeedsFactor(false);
    start(async () => {
      const r = await fn();
      setNeedsFactor(!r.ok && isAssuranceRefusal(r.reason));
      if (!r.ok) return setError(r.error ?? "That did not work.");
      setNotice(done(r));
    });
  };
  return { pending, error, notice, needsFactor, run };
}

/** The End and Withdraw controls of one rate. A component of its own because each row holds the date it is being ended on. */
function RateActions({ f, r, a }: { f: Freelancer; r: FlRate; a: ReturnType<typeof useAction> }) {
  const [endOn, setEndOn] = useState("");
  const who = f.user.name;
  const label = `${who}, rate ${rangeLabel(r)}`;
  return (
    <span className="fin-fl__inline">
      {r.validTo === null ? (
        <>
          <input
            type="date" aria-label={`Last day of ${label}`} value={endOn} min={r.validFrom}
            onChange={(e) => setEndOn(e.target.value)}
          />
          <button
            type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`End ${label}`} disabled={a.pending || !endOn}
            onClick={() => a.run(() => endRateAction(f.user.id, r.id, endOn), () => `${who}'s rate from ${r.validFrom} now ends on ${endOn}.`)}
          >
            End
          </button>
        </>
      ) : null}
      {r.used ? (
        <span className="fin-muted" title="It priced hours that are on a bill, so it stays on record">Used on a bill</span>
      ) : (
        <button
          type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Withdraw ${label}`} disabled={a.pending}
          onClick={() => a.run(() => withdrawRateAction(f.user.id, r.id), () => `Withdrew ${who}'s rate ${rangeLabel(r)}.`)}
        >
          Withdraw
        </button>
      )}
    </span>
  );
}

function VendorLine({ f, vendors, a }: { f: Freelancer; vendors: VendorOption[]; a: ReturnType<typeof useAction> }) {
  const [vendorId, setVendorId] = useState("");
  if (f.vendor) {
    return (
      <p className="fin-fl__sub">
        Paid through {f.vendor.code} · {f.vendor.name}.{" "}
        {f.vendor.withholdingCode
          ? <>Withholding code {f.vendor.withholdingCode}.</>
          : <strong>No withholding code on the vendor, so their bills withhold nothing.</strong>}
      </p>
    );
  }
  const free = vendors.filter((v) => !v.userId);
  return (
    <div className="fin-fl__inline">
      <span className="fin-fl__sub"><strong>No vendor.</strong> A bill needs one to be paid through.</span>
      {free.length === 0 ? (
        <span className="fin-fl__sub">Every vendor already names a person. Create the vendor under Payables first.</span>
      ) : (
        <>
          <select aria-label={`Vendor for ${f.user.name}`} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Choose a vendor</option>
            {free.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
          </select>
          <button
            type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Link a vendor to ${f.user.name}`} disabled={a.pending || !vendorId}
            onClick={() => a.run(() => linkVendorAction(vendorId, f.user.id), () => `Linked the vendor to ${f.user.name}.`)}
          >
            Link vendor
          </button>
        </>
      )}
    </div>
  );
}

function AddRateForm({ people, accounts, a }: { people: PersonOption[]; accounts: AccountOption[]; a: ReturnType<typeof useAction> }) {
  const [form, setForm] = useState({ userId: "", hourlyRate: "", validFrom: "", expenseAccountCode: "", note: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const name = people.find((p) => p.id === form.userId)?.name ?? "this person";
  return (
    <Card
      title="Add a rate"
      hint="A rate is an hourly price from a date, in the company's functional currency. An open rate that started earlier ends the day before the new one starts."
      style={{ marginTop: 22 }}
    >
      <form
        className="fin-form" aria-label="Add a rate"
        onSubmit={(e) => {
          e.preventDefault();
          a.run(
            () => addRateAction(form.userId, { hourlyRate: form.hourlyRate, validFrom: form.validFrom, expenseAccountCode: form.expenseAccountCode, note: form.note }),
            (r) => {
              const closed = r.result?.closedRate;
              setForm({ userId: "", hourlyRate: "", validFrom: "", expenseAccountCode: "", note: "" });
              return `Added a rate for ${name} from ${form.validFrom}.${closed ? ` The earlier rate now ends on ${closed.validTo}.` : ""}`;
            },
          );
        }}
      >
        <label className="fin-form__field">
          <span>Person</span>
          <select value={form.userId} onChange={set("userId")}>
            <option value="">Choose a person</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.email ? ` (${p.email})` : ""}</option>)}
          </select>
        </label>
        <label className="fin-form__field">
          <span>Hourly rate</span>
          <input value={form.hourlyRate} onChange={set("hourlyRate")} inputMode="decimal" placeholder="e.g. 150000" />
        </label>
        <label className="fin-form__field">
          <span>Starts on</span>
          <input type="date" value={form.validFrom} onChange={set("validFrom")} />
        </label>
        <label className="fin-form__field">
          <span>Expense account</span>
          <select value={form.expenseAccountCode} onChange={set("expenseAccountCode")}>
            <option value="">Choose an account</option>
            {accounts.map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
          </select>
        </label>
        <label className="fin-form__field fin-form__field--wide">
          <span>Note (optional)</span>
          <input value={form.note} onChange={set("note")} maxLength={500} />
        </label>
        <div className="fin-form__actions fin-form__field--wide">
          <Button type="submit" disabled={a.pending}>{a.pending ? "Working…" : "Add rate"}</Button>
        </div>
      </form>
    </Card>
  );
}

export function FreelancerRates({
  freelancers, people, accounts, vendors,
}: {
  freelancers: ReadResult<Freelancer[]>;
  /** The company's active members: the person picker. */
  people: PersonOption[];
  /** Live, postable expense accounts: the account picker. */
  accounts: AccountOption[];
  /** Live vendors, each with the person it names (`userId`): the link picker offers the ones that name nobody. */
  vendors: VendorOption[];
}) {
  const a = useAction();
  return (
    <>
      <Card
        title="Freelancer rates"
        hint="Everyone with a rate or a linked vendor. A rate that priced hours on a bill cannot be withdrawn or ended before them: end it on a later date instead."
      >
        {freelancers.kind !== "ok" ? (
          <ReadRefusal
            inline subject="the freelancer rates" kind={freelancers.kind}
            reason={freelancers.kind === "unavailable" ? freelancers.reason : undefined}
          />
        ) : freelancers.data.length === 0 ? (
          <EmptyNote>No one has a freelancer rate or a linked vendor yet. Add a rate below to start billing someone by the hour.</EmptyNote>
        ) : (
          <div className="fin-fl">
            {freelancers.data.map((f) => (
              <section key={f.user.id} className="fin-fl__person" aria-label={`Rates for ${f.user.name}`}>
                <div className="fin-fl__head">
                  <h4 className="fin-fl__name">{f.user.name}</h4>
                  <span className="fin-fl__sub">{f.user.email}</span>
                  {f.currentRate
                    ? <StatusBadge label="rate in force" />
                    : <span className="fin-fl__sub"><strong>No rate in force today.</strong></span>}
                </div>
                {f.onPayroll ? (
                  <p className="fin-fl__sub">On payroll today, so a new rate for dates payroll pays is refused.</p>
                ) : null}
                <VendorLine f={f} vendors={vendors} a={a} />
                {f.rates.length === 0 ? (
                  <p className="fin-fl__sub">No rates yet.</p>
                ) : (
                  <HairlineTable
                    columns={[{ label: "Applies" }, { label: "Hourly rate", align: "right" }, { label: "Account" }, { label: "Note" }, { label: "" }]}
                    rows={f.rates.map((r) => [
                      <span key="range"><span>{rangeLabel(r)}</span>{r.validTo === null ? <> <StatusBadge label="current" /></> : null}</span>,
                      formatAmount(r.hourlyRate, r.currency),
                      r.expenseAccountCode,
                      r.note ?? "—",
                      <RateActions key="act" f={f} r={r} a={a} />,
                    ])}
                  />
                )}
              </section>
            ))}
          </div>
        )}
      </Card>

      <AddRateForm people={people} accounts={accounts} a={a} />

      {a.error && <p className="fin-form__error" role="alert">{a.error}</p>}
      {a.needsFactor && <SecondFactorPrompt />}
      {a.notice && <p className="fin-muted" role="status" style={{ marginTop: 12 }}>{a.notice}</p>}
    </>
  );
}
