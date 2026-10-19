"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Card, Button, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SecondFactorPrompt } from "@/components/auth/SecondFactorPrompt";
import {
  discardBillAction, draftAllReadyAction, draftBillAction, type DraftAllOutcome, type FlActionResult,
} from "@/lib/freelancersActions";
import { isAssuranceRefusal } from "@/lib/stepUp";
import {
  BLOCKER_TITLE, NO_WITHHOLDING_HINT, WARNING_TITLE, blockerFix, formatAmount, formatHours, isReady, readyFreelancers, splitBills,
  type FlIssue, type FlPreview, type FreelancerBill, type PreviewFreelancer,
} from "@/lib/freelancers";
import type { ReadResult } from "@/lib/readResult";
import "./freelancers.css";

// DW-10f-4b — Finance > Payables > Freelancers > Bills (BFF §61.8): the preview of what drafting a period would make, the draft itself,
// and the drafted bills with Discard.
//
// ── EVERY FIGURE IS THE SERVER'S ────────────────────────────────────────────────────────────────────────────
// The lines, the withholding, the amount payable and the totals are formatted as the server computed them (in SQL `numeric`, rounded once per
// line). Nothing here adds, multiplies or rounds a figure, and "Draft all ready" asks the server again at the click rather than trusting this
// render. A warning never blocks and a blocker does; the server's own sentence is shown for each, with the DW-D47 "no withholding code" warning
// kept visible on the preview AND on the drafted bill until Finance approves or discards it.
//
// ── APPROVAL IS NOT HERE ────────────────────────────────────────────────────────────────────────────────────
// `bill_entry` drafts and `approve` admits to the books, two grants on purpose. A drafted bill links to the existing queue in Payables.

const APPROVE_HREF = "/finance/payables#bills-awaiting-approval";

function useAction() {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsFactor, setNeedsFactor] = useState(false);
  const [blockers, setBlockers] = useState<FlIssue[]>([]);
  const [outcomes, setOutcomes] = useState<DraftAllOutcome[]>([]);
  const run = <T,>(key: string, fn: () => Promise<FlActionResult<T>>, done: (r: FlActionResult<T>) => string) => {
    setError(null); setNotice(null); setNeedsFactor(false); setBlockers([]); setOutcomes([]); setBusy(key);
    start(async () => {
      const r = await fn();
      setNeedsFactor(!r.ok && isAssuranceRefusal(r.reason));
      setBlockers(r.blockers ?? []);
      if (!r.ok) setError(r.error ?? "That did not work.");
      else setNotice(done(r));
    });
  };
  return { pending, busy, error, notice, needsFactor, blockers, outcomes, setOutcomes, run };
}

function IssueList({ items, kind, f }: { items: FlIssue[]; kind: "warn" | "block"; f?: PreviewFreelancer }) {
  if (items.length === 0) return null;
  const titles = kind === "warn" ? WARNING_TITLE : BLOCKER_TITLE;
  return (
    <ul className="fin-fl__notes" aria-label={kind === "warn" ? "Warnings" : "Blockers"}>
      {items.map((i, n) => (
        <li key={`${i.code}-${n}`} className={`fin-fl__note fin-fl__note--${kind}`}>
          <strong>{titles[i.code] ?? i.code}.</strong> {i.message}
          {kind === "warn" && i.code === "NO_WITHHOLDING" ? <span className="fin-fl__hint">{NO_WITHHOLDING_HINT}</span> : null}
          {kind === "block" && blockerFix(i.code) === "link_vendor" ? <span className="fin-fl__hint">Link a vendor to {f?.user.name ?? "them"} in the rates above.</span> : null}
          {kind === "block" && blockerFix(i.code) === "add_rate" ? <span className="fin-fl__hint">Add a rate that covers those days in the rates above.</span> : null}
        </li>
      ))}
    </ul>
  );
}

function PreviewCard({
  f, pending, onDraft,
}: { f: PreviewFreelancer; pending: boolean; onDraft: () => void }) {
  const ready = isReady(f);
  return (
    <section className="fin-fl__person" aria-label={`Preview for ${f.user.name}`}>
      <div className="fin-fl__head">
        <h4 className="fin-fl__name">{f.user.name}</h4>
        <span className="fin-fl__sub">{f.vendor ? `${f.vendor.code} · ${f.vendor.name}` : "No vendor"}</span>
        <StatusBadge label={ready ? "ready" : "blocked"} />
      </div>
      {f.lines.length > 0 ? (
        <HairlineTable
          columns={[{ label: "Project" }, { label: "Dates" }, { label: "Hours", align: "right" }, { label: "Hourly rate", align: "right" }, { label: "Amount", align: "right" }]}
          rows={f.lines.map((l) => [
            l.project.name,
            l.firstDate === l.lastDate ? l.firstDate : `${l.firstDate} to ${l.lastDate}`,
            formatHours(l.hours),
            formatAmount(l.hourlyRate, f.currency),
            formatAmount(l.amount, f.currency),
          ])}
        />
      ) : null}
      <dl className="fin-fl__totals">
        <dt>Subtotal</dt><dd>{formatAmount(f.subtotal, f.currency)}</dd>
        <dt>{f.withholding ? `Withholding (${f.withholding.code})` : "Withholding"}</dt>
        <dd>{f.withholding ? formatAmount(f.withholding.amount, f.currency) : "None"}</dd>
        <dt>Amount payable</dt><dd className="fin-fl__payable">{formatAmount(f.amountPayable, f.currency)}</dd>
      </dl>
      <IssueList items={f.warnings} kind="warn" f={f} />
      <IssueList items={f.blockers} kind="block" f={f} />
      {ready ? (
        <div className="fin-form__actions">
          <button
            type="button" className="lux-btn lux-btn--solid lux-btn--sm" aria-label={`Draft bill for ${f.user.name}`}
            disabled={pending} onClick={onDraft}
          >
            Draft bill
          </button>
        </div>
      ) : (
        <p className="fin-fl__sub">This bill cannot be drafted until the blockers above are cleared.</p>
      )}
    </section>
  );
}

export function FreelancerBills({
  preview, previewError, period, bills,
}: {
  /** `null` when the picked period was not valid: nothing was asked of the server, and `previewError` says why. */
  preview: ReadResult<FlPreview> | null;
  previewError: string | null;
  period: { from: string; to: string };
  bills: ReadResult<FreelancerBill[]>;
}) {
  const a = useAction();
  const ready = preview?.kind === "ok" ? readyFreelancers(preview.data) : [];
  const split = bills.kind === "ok" ? splitBills(bills.data, period.from, period.to) : null;

  function draftAll() {
    a.run("all", async () => {
      const r = await draftAllReadyAction(period.from, period.to);
      if (r.result) a.setOutcomes(r.result);
      return r;
    }, (r) => {
      const made = (r.result ?? []).filter((o) => o.ok).length;
      const failed = (r.result ?? []).length - made;
      return `Drafted ${made} bill${made === 1 ? "" : "s"}.${failed ? ` ${failed} could not be drafted; see below.` : ""}`;
    });
  }

  return (
    <>
      <Card
        title="Preview"
        hint="What drafting the period would make, per freelancer, from their unbilled logged hours. Each hour is priced at the rate in force on its date. Nothing is written until you draft."
      >
        <form method="get" className="fin-fl__period" aria-label="Billing period">
          <label><span>Period start</span><input type="date" name="from" defaultValue={period.from} required /></label>
          <label><span>Period end</span><input type="date" name="to" defaultValue={period.to} required /></label>
          <Button type="submit">Show period</Button>
        </form>

        {previewError ? (
          <p className="fin-form__error" role="alert">{previewError}</p>
        ) : preview === null ? null : preview.kind !== "ok" ? (
          <ReadRefusal
            inline subject="the freelancer preview" kind={preview.kind}
            reason={preview.kind === "unavailable" ? preview.reason : undefined}
          />
        ) : preview.data.freelancers.length === 0 ? (
          <EmptyNote>
            No freelancer has unbilled hours between {preview.data.periodStart} and {preview.data.periodEnd}. Hours already on a bill are not offered again.
          </EmptyNote>
        ) : (
          <div className="fin-fl">
            {preview.data.freelancers.map((f) => (
              <PreviewCard
                key={f.user.id} f={f} pending={a.pending}
                onDraft={() => a.run(
                  `draft:${f.user.id}`,
                  () => draftBillAction(f.user.id, period.from, period.to),
                  (r) => `Drafted bill ${r.result?.billNo ?? ""} for ${f.user.name}${r.result?.deduped ? " (it already existed)" : ""}. It is a draft until someone approves it.`,
                )}
              />
            ))}
            {ready.length > 0 ? (
              <div className="fin-form__actions">
                <Button onClick={draftAll} disabled={a.pending}>
                  {a.pending && a.busy === "all" ? "Drafting…" : `Draft all ready (${ready.length})`}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {a.error && <p className="fin-form__error" role="alert">{a.error}</p>}
        {a.blockers.length > 0 && <IssueList items={a.blockers} kind="block" />}
        {a.needsFactor && <SecondFactorPrompt />}
        {a.outcomes.length > 0 && (
          <ul className="fin-fl__outcomes" aria-label="Draft all results">
            {a.outcomes.map((o) => (
              <li key={o.userId}>{o.ok ? `${o.name}: drafted ${o.billNo}${o.deduped ? " (it already existed)" : ""}.` : `${o.name}: ${o.error}`}</li>
            ))}
          </ul>
        )}
        {a.notice && <p className="fin-muted" role="status" style={{ marginTop: 12 }}>{a.notice}</p>}
      </Card>

      <Card
        title="Drafted bills"
        hint="A draft posts nothing. Approving admits it to the books and is a separate grant, in the Payables approval queue. Discarding a draft hands its hours back to the preview."
        style={{ marginTop: 22 }}
      >
        {bills.kind !== "ok" ? (
          <ReadRefusal
            inline subject="the freelancer bills" kind={bills.kind}
            reason={bills.kind === "unavailable" ? bills.reason : undefined}
          />
        ) : (
          <>
            {split && split.drafts.length === 0 ? (
              <EmptyNote>No freelancer bill is waiting. A draft stays here until it is approved or discarded.</EmptyNote>
            ) : (
              <BillsTable
                bills={split?.drafts ?? []} discardable pending={a.pending}
                onDiscard={(b) => a.run(`discard:${b.billId}`, () => discardBillAction(b.billId), (r) =>
                  `Discarded ${b.billNo}. ${r.result?.releasedEntries ?? 0} time entries are free to bill again.`)}
              />
            )}
            {split && split.inPeriod.length > 0 ? (
              <>
                <p className="fin-fl__sub" style={{ marginTop: 18 }}>Other bills for {period.from} to {period.to}</p>
                <BillsTable bills={split.inPeriod} pending={a.pending} />
              </>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}

function BillsTable({
  bills, discardable, pending, onDiscard,
}: {
  bills: FreelancerBill[]; discardable?: boolean; pending: boolean; onDiscard?: (b: FreelancerBill) => void;
}) {
  return (
    <HairlineTable
      columns={[
        { label: "Bill" }, { label: "Freelancer" }, { label: "Period" }, { label: "Subtotal", align: "right" },
        { label: "Withheld", align: "right" }, { label: "Payable", align: "right" }, { label: "Status" }, { label: "" },
      ]}
      rows={bills.map((b) => [
        <div key="no">
          <span>{b.billNo}</span>
          {b.warnings.length > 0 ? (
            <ul className="fin-fl__notes" aria-label={`Warnings on ${b.billNo}`}>
              {b.warnings.map((w) => (
                <li key={w.code} className="fin-fl__note fin-fl__note--warn"><strong>{WARNING_TITLE[w.code] ?? w.code}.</strong> {w.message}</li>
              ))}
            </ul>
          ) : null}
        </div>,
        <span key="who">{b.user.name}<span className="fin-fl__hint">{b.vendor.code} · {b.vendor.name}</span></span>,
        `${b.periodStart} to ${b.periodEnd}`,
        formatAmount(b.subtotal, b.currency),
        b.withholdingAmount && Number(b.withholdingAmount) !== 0 ? formatAmount(b.withholdingAmount, b.currency) : "None",
        formatAmount(b.amountPayable, b.currency),
        <StatusBadge key="st" label={b.status} />,
        b.status === "draft" ? (
          <span key="act" className="fin-fl__inline">
            <Link href={APPROVE_HREF} aria-label={`Approve ${b.billNo} in Payables`}>Approve in Payables</Link>
            {discardable ? (
              <button
                type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Discard ${b.billNo}`}
                disabled={pending} onClick={() => onDiscard?.(b)}
              >
                Discard
              </button>
            ) : null}
          </span>
        ) : "",
      ])}
    />
  );
}
