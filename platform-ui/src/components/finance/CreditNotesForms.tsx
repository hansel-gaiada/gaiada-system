"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable, StatusBadge } from "@/components/ui";
import { ConfirmAction } from "@/components/finance/ConfirmAction";
import { createArCreditNote, applyArCreditNote, writeOffArInvoice } from "@/lib/financeActions";
// TYPE-ONLY import, deliberately — see ArForms.tsx / ApForms.tsx / TreasuryForms.tsx for the same
// note. `lib/finance.ts` opens with `import "server-only"`; a VALUE import here would fail the build.
import type { ArCustomer, ArOpenInvoice, ArCreditNote } from "@/lib/finance";

const today = () => new Date().toISOString().slice(0, 10);

// ── CREDIT NOTE vs WRITE-OFF — the reason this file has two forms, not one ───────────────────────
// A credit note says the customer never owed it: the sale is reversed, and so is the output VAT
// already charged on it. A write-off says they owed it and will not pay: the sale stood, PPN was
// correctly due and has already been remitted, so nothing about the tax is undone. Picking the wrong
// one is not a wrong button — it produces a wrong VAT return — which is why these are two forms with
// two different pieces of copy, never a shared "adjustment" screen with a type dropdown.

const CREDIT_REASONS: Array<{ value: string; label: string }> = [
  { value: "return", label: "Goods returned" },
  { value: "overbilling", label: "Overbilling" },
  { value: "discount", label: "Discount agreed after invoicing" },
  { value: "service_failure", label: "Service failure" },
  { value: "price_correction", label: "Price correction" },
  { value: "other", label: "Other" },
];

const WRITE_OFF_REASONS: Array<{ value: string; label: string }> = [
  { value: "uncollectible", label: "Uncollectible" },
  { value: "customer_insolvent", label: "Customer insolvent" },
  { value: "disputed_abandoned", label: "Dispute abandoned by customer" },
  { value: "below_recovery_cost", label: "Below cost to recover" },
  { value: "statute_barred", label: "Statute-barred" },
  { value: "other", label: "Other" },
];

export function IssueCreditNoteForm({
  customers, openInvoices, creditAccounts,
}: {
  customers: ArCustomer[];
  openInvoices: ArOpenInvoice[];
  creditAccounts: Array<{ code: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [taxRate, setTaxRate] = useState("12");
  const [amount, setAmount] = useState("");
  const [applyNow, setApplyNow] = useState(false);

  const base = Number(amount || 0);
  const previewTax = Number(taxRate) > 0 ? Math.round(base * (11 / 12) * (Number(taxRate) / 100)) : 0;

  if (customers.length === 0) {
    return (
      <Card title="Issue a credit note">
        <p className="fin-muted">There are no customers on this company&rsquo;s receivables ledger yet.</p>
      </Card>
    );
  }
  if (creditAccounts.length === 0) {
    return (
      <Card title="Issue a credit note">
        <p className="fin-muted">
          No contra-revenue account (4200 Potongan Penjualan / 4300 Retur Penjualan) exists in this
          company&rsquo;s chart, so there is nowhere to post the credit against. Crediting the
          original revenue account instead would net the credit away and hide a deteriorating return
          rate inside ordinary sales.
        </p>
      </Card>
    );
  }

  const customerInvoices = openInvoices.filter(
    (i) => !customerId || i.customerName === customers.find((c) => c.id === customerId)?.name,
  );

  return (
    <Card
      title="Issue a credit note"
      hint="The customer never owed this. Reverses output VAT along with the sale — posted immediately, same as an invoice."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const applyToInvoiceId = String(fd.get("applyToInvoiceId") || "") || undefined;
          start(async () => {
            const r = await createArCreditNote({
              customerId: String(fd.get("customerId")),
              creditNoteNo: String(fd.get("creditNoteNo")).trim(),
              creditNoteDate: String(fd.get("creditNoteDate")),
              reasonCode: String(fd.get("reasonCode")),
              reason: String(fd.get("reason")).trim(),
              originalInvoiceId: String(fd.get("originalInvoiceId") || "") || undefined,
              applyToInvoiceId,
              applyAmount: applyToInvoiceId ? (Number(fd.get("applyAmount") || 0) || undefined) : undefined,
              lines: [{
                description: String(fd.get("description")).trim(),
                amount: Number(fd.get("amount") || 0),
                creditAccountCode: String(fd.get("creditAccountCode")),
                taxRate: Number(fd.get("taxRate")) || null,
              }],
            });
            if (r.ok) setDone(`${r.result?.creditNoteNo ?? "Credit note"} issued and posted.`);
            else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="cn-customerId">Customer</label>
          <select id="cn-customerId" name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-no">Credit note number</label>
          <input id="cn-no" name="creditNoteNo" required placeholder="CN-2026-001" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-date">Date</label>
          <input id="cn-date" name="creditNoteDate" type="date" defaultValue={today()} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-original">Relates to invoice (optional)</label>
          <select id="cn-original" name="originalInvoiceId" defaultValue="">
            <option value="">— not tied to one —</option>
            {customerInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNo}</option>)}
          </select>
          <span className="fin-muted">Records intent only. Use &ldquo;apply&rdquo; below to actually reduce an invoice.</span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-reasonCode">Reason</label>
          <select id="cn-reasonCode" name="reasonCode" defaultValue="return">
            {CREDIT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="cn-reason-text">Explain</label>
          <input id="cn-reason-text" name="reason" required placeholder="Barang dikembalikan — cacat produksi" />
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="cn-description">Line description</label>
          <input id="cn-description" name="description" required placeholder="Retur — 2 unit" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-amount">Amount</label>
          <input
            id="cn-amount" name="amount" type="number" min="0" step="1000" required
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-account">Contra-revenue account</label>
          <select id="cn-account" name="creditAccountCode">
            {creditAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="cn-taxRate">PPN rate (%)</label>
          <input
            id="cn-taxRate" name="taxRate" type="number" min="0" max="100" step="1"
            value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
          />
        </div>

        {base > 0 ? (
          <p className="fin-muted fin-form__field--wide">
            Preview: base {base.toLocaleString("id-ID")} + PPN reversed {previewTax.toLocaleString("id-ID")} ={" "}
            <strong>{(base + previewTax).toLocaleString("id-ID")}</strong> credited.{" "}
            <em>The server recomputes this and its figure is the one posted.</em>
          </p>
        ) : null}

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="cn-apply-toggle" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="cn-apply-toggle" type="checkbox"
              checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)}
            />
            Apply this credit to an invoice immediately
          </label>
        </div>

        {applyNow ? (
          <>
            <div className="fin-form__field">
              <label htmlFor="cn-applyTo">Apply to invoice</label>
              <select id="cn-applyTo" name="applyToInvoiceId" defaultValue="">
                <option value="">— choose —</option>
                {customerInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoiceNo} · outstanding {Number(i.outstanding).toLocaleString("id-ID")}
                  </option>
                ))}
              </select>
            </div>
            <div className="fin-form__field">
              <label htmlFor="cn-applyAmount">Amount to apply</label>
              <input id="cn-applyAmount" name="applyAmount" type="number" min="0" step="1000" />
              <span className="fin-muted">Leave blank to apply the full credit.</span>
            </div>
          </>
        ) : null}

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue credit note"}</Button>
        </div>
      </form>
    </Card>
  );
}

/** The credit notes already on file, and — for an unapplied one — a way to apply it. */
export function CreditNotesTable({
  notes, openInvoices,
}: {
  notes: ArCreditNote[];
  openInvoices: ArOpenInvoice[];
}) {
  if (notes.length === 0) {
    return <p className="fin-muted">No credit notes recorded for this company yet.</p>;
  }
  return (
    <HairlineTable
      columns={[
        { label: "No." }, { label: "Date" }, { label: "Customer" }, { label: "Reason" },
        { label: "Total", align: "right" }, { label: "Unapplied", align: "right" },
        { label: "Status" }, { label: "" },
      ]}
      rows={notes.map((n) => [
        n.creditNoteNo,
        n.creditNoteDate,
        `${n.customerCode} · ${n.customerName}`,
        n.reason,
        Number(n.total).toLocaleString("id-ID"),
        Number(n.unapplied).toLocaleString("id-ID"),
        <StatusBadge
          key={`${n.id}-s`}
          label={n.status === "applied" ? "active" : n.status === "void" ? "archived" : "review"}
        />,
        n.status === "issued" && Number(n.unapplied) > 0 ? (
          <ApplyCreditCell
            key={n.id}
            noteId={n.id}
            unapplied={n.unapplied}
            candidateInvoices={openInvoices.filter((i) => i.customerName === n.customerName)}
          />
        ) : null,
      ])}
    />
  );
}

function ApplyCreditCell({
  noteId, unapplied, candidateInvoices,
}: {
  noteId: string;
  unapplied: string;
  candidateInvoices: ArOpenInvoice[];
}) {
  const [pending, start] = useTransition();
  const [invoiceId, setInvoiceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) return <span className="fin-muted">applied</span>;
  if (candidateInvoices.length === 0) {
    return <span className="fin-muted">no open invoice for this customer</span>;
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <select
        value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}
        style={{ maxWidth: 140 }} aria-label="Apply credit to invoice"
      >
        <option value="">— invoice —</option>
        {candidateInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNo}</option>)}
      </select>
      <Button
        size="sm" disabled={pending || !invoiceId}
        onClick={() => {
          setError(null);
          start(async () => {
            const r = await applyArCreditNote(noteId, { invoiceId, amount: Number(unapplied) });
            if (r.ok) setDone(true); else setError(r.error ?? "Failed.");
          });
        }}
      >
        {pending ? "Applying…" : "Apply"}
      </Button>
      {error ? <span className="fin-form__error">{error}</span> : null}
    </span>
  );
}

/**
 * Write off an uncollectible receivable. Confirmation-gated on the INVOICE NUMBER, matching
 * `lib/financeActions.ts::writeOffArInvoice` and `ConfirmAction`'s own convention elsewhere in this
 * module (period name, cutover date, fiscal year, instrument code).
 *
 * The amount/date/reason fields sit OUTSIDE `ConfirmAction`'s own form, because that component's
 * `run` callback only carries `{confirm, reason}` — everything else here is captured by this
 * component's own state and passed through the closure. `ConfirmAction` is reused as the gate, not
 * forked into a second confirmation abstraction to fit more fields.
 */
export function WriteOffInvoiceForm({ openInvoices }: { openInvoices: ArOpenInvoice[] }) {
  const [invoiceId, setInvoiceId] = useState(openInvoices[0]?.id ?? "");
  const [amount, setAmount] = useState(openInvoices[0]?.outstanding ?? "");
  const [writeOffDate, setWriteOffDate] = useState(today());
  const [reasonCode, setReasonCode] = useState("uncollectible");
  const [reasonText, setReasonText] = useState("");

  const invoice = openInvoices.find((i) => i.id === invoiceId);

  if (openInvoices.length === 0) {
    return (
      <Card title="Write off an invoice">
        <p className="fin-muted">No open invoice to write off.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Write off an invoice"
      hint="The customer owed this and will not pay. VAT is NOT reversed — the PPN was properly due and has already been remitted, so this changes nothing about the tax."
    >
      <div className="fin-form">
        <div className="fin-form__field">
          <label htmlFor="wo-invoice">Invoice</label>
          <select
            id="wo-invoice" value={invoiceId}
            onChange={(e) => {
              setInvoiceId(e.target.value);
              const inv = openInvoices.find((i) => i.id === e.target.value);
              setAmount(inv?.outstanding ?? "");
            }}
          >
            {openInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.invoiceNo} · {i.customerName} · outstanding {Number(i.outstanding).toLocaleString("id-ID")}
              </option>
            ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="wo-amount">Amount to write off</label>
          <input
            id="wo-amount" type="number" min="0" step="1000"
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
          <span className="fin-muted">Defaults to the full outstanding balance; can be less for a partial write-off.</span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="wo-date">Write-off date</label>
          <input id="wo-date" type="date" value={writeOffDate} onChange={(e) => setWriteOffDate(e.target.value)} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="wo-reasonCode">Reason</label>
          <select id="wo-reasonCode" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {WRITE_OFF_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="wo-reason-text">Explain</label>
          <input
            id="wo-reason-text" value={reasonText} onChange={(e) => setReasonText(e.target.value)}
            placeholder="Pelanggan bangkrut — kurator mengonfirmasi tidak ada pembagian aset"
          />
        </div>
      </div>

      {invoice ? (
        <ConfirmAction
          expected={invoice.invoiceNo}
          expectedLabel="invoice number"
          consequence={
            "Reduces this invoice's outstanding balance to reflect a debt that will not be collected. "
            + "Corrected only by a reversal afterwards — re-typing the invoice number is the cheapest "
            + "guard against writing off the wrong one."
          }
          actionLabel="Write off this invoice"
          run={({ confirm }) =>
            writeOffArInvoice(invoice.id, {
              amount: Number(amount || invoice.outstanding),
              writeOffDate,
              reasonCode,
              reason: reasonText.trim(),
              confirm,
            })
          }
        />
      ) : null}
    </Card>
  );
}
