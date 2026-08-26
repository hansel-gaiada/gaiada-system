"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { issueArInvoice, recordArReceipt } from "@/lib/financeActions";
import type { ArCustomer, ArOpenInvoice } from "@/lib/finance";

// The receivables write surfaces: raise an invoice, bank a receipt.
//
// ── NOTHING IS VALIDATED HERE THAT THE SERVER ALSO VALIDATES ───────────────────────────────────
// The total, the PPN base (12% of 11/12, not a flat 12%), whether the revenue account exists,
// whether an allocation exceeds its receipt — all decided server-side, and the message shown is the
// server's own. A second copy of a rule in a form is a second thing to drift, and the copy the user
// sees is always the one that drifts: they get "looks fine" from the form and a refusal from the
// server, or worse, the reverse.
//
// The one thing computed client-side is the PREVIEW total, and it is labelled as an estimate for
// exactly that reason — see the note by it.

const today = () => new Date().toISOString().slice(0, 10);

/** Adds `days` to an ISO date without a date library (this project has four runtime deps). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function IssueInvoiceForm({
  customers, revenueAccounts,
}: {
  customers: ArCustomer[];
  revenueAccounts: Array<{ code: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [taxRate, setTaxRate] = useState("12");
  const [unitPrice, setUnitPrice] = useState("");

  const terms = customers.find((c) => c.id === customerId)?.paymentTermsDays ?? 30;
  const [dueDate, setDueDate] = useState(addDays(today(), 30));

  // A PREVIEW, not the figure that will be posted. The server recomputes it and its answer wins —
  // saying so beside the number is the difference between a helpful hint and a quiet second
  // implementation of Indonesian VAT.
  const base = Number(unitPrice || 0);
  const previewTax = Number(taxRate) > 0 ? Math.round(base * (11 / 12) * (Number(taxRate) / 100)) : 0;

  if (customers.length === 0) {
    return (
      <Card title="Raise an invoice">
        <p className="fin-muted">
          There are no customers on this company&rsquo;s receivables ledger yet, so there is nobody to
          invoice. A customer record is separate from a CRM client on purpose — it carries the NPWP,
          the PKP flag and the payment terms that decide how an invoice is taxed and aged.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Raise an invoice" hint="Issued immediately — this posts to the ledger and moves the AR control account.">
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          start(async () => {
            const r = await issueArInvoice({
              customerId: String(fd.get("customerId")),
              invoiceNo: String(fd.get("invoiceNo")).trim(),
              invoiceDate: String(fd.get("invoiceDate")),
              dueDate: String(fd.get("dueDate")),
              lines: [{
                description: String(fd.get("description")).trim(),
                quantity: Number(fd.get("quantity") || 1),
                unitPrice: Number(fd.get("unitPrice") || 0),
                revenueAccountCode: String(fd.get("revenueAccountCode")),
                taxCode: Number(fd.get("taxRate")) > 0 ? "PPN" : undefined,
                taxRate: Number(fd.get("taxRate")) || null,
              }],
            });
            if (r.ok) setDone("Invoice issued and posted."); else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="customerId">Customer</label>
          <select
            id="customerId" name="customerId" value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              const t = customers.find((c) => c.id === e.target.value)?.paymentTermsDays ?? 30;
              setDueDate(addDays(invoiceDate, t));
            }}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
            ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="invoiceNo">Invoice number</label>
          <input id="invoiceNo" name="invoiceNo" required placeholder="INV-2026-001" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="invoiceDate">Invoice date</label>
          <input
            id="invoiceDate" name="invoiceDate" type="date" value={invoiceDate}
            onChange={(e) => { setInvoiceDate(e.target.value); setDueDate(addDays(e.target.value, terms)); }}
          />
        </div>

        <div className="fin-form__field">
          <label htmlFor="dueDate">Due date</label>
          <input id="dueDate" name="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {/* Derived from the customer's terms rather than fixed at +30. Aging buckets by days
              PAST DUE, so a wrong due date silently moves an invoice into the wrong bucket and
              makes a healthy book look distressed. */}
          <span className="fin-muted">Default is this customer&rsquo;s {terms}-day terms.</span>
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="description">Description</label>
          <input id="description" name="description" required placeholder="Jasa digital marketing — retainer Q1" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="quantity">Quantity</label>
          <input id="quantity" name="quantity" type="number" min="1" step="1" defaultValue={1} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="unitPrice">Unit price</label>
          <input
            id="unitPrice" name="unitPrice" type="number" min="0" step="1000" required
            value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)}
          />
        </div>

        <div className="fin-form__field">
          <label htmlFor="revenueAccountCode">Revenue account</label>
          <select id="revenueAccountCode" name="revenueAccountCode">
            {revenueAccounts.map((a) => (
              <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
            ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="taxRate">PPN rate (%)</label>
          <input
            id="taxRate" name="taxRate" type="number" min="0" max="100" step="1"
            value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
          />
        </div>

        {base > 0 ? (
          <p className="fin-muted fin-form__field--wide">
            Preview: base {base.toLocaleString("id-ID")} + PPN {previewTax.toLocaleString("id-ID")} ={" "}
            <strong>{(base + previewTax).toLocaleString("id-ID")}</strong>. PPN is 12% of 11/12 of the
            base, not a flat 12%. <em>The server recomputes this and its figure is the one posted.</em>
          </p>
        ) : null}

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue invoice"}</Button>
        </div>
      </form>
    </Card>
  );
}

export function RecordReceiptForm({
  customers, openInvoices, bankAccounts,
}: {
  customers: ArCustomer[];
  openInvoices: ArOpenInvoice[];
  bankAccounts: Array<{ code: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [allocate, setAllocate] = useState("");

  if (customers.length === 0 || bankAccounts.length === 0) {
    return (
      <Card title="Record a receipt">
        <p className="fin-muted">
          {customers.length === 0
            ? "No customers on the receivables ledger yet."
            : "No bank account in the chart of accounts to receive against."}
        </p>
      </Card>
    );
  }

  const onAccount = Number(amount || 0) - Number(allocate || 0);

  return (
    <Card
      title="Record a receipt"
      hint="Banking the money and deciding which invoice it settles are two separate acts. Allocation is optional."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const amt = Number(fd.get("amount") || 0);
          const alloc = Number(fd.get("allocate") || 0);
          const inv = String(fd.get("invoiceId") || "");
          start(async () => {
            const r = await recordArReceipt({
              customerId: String(fd.get("customerId")),
              receiptNo: String(fd.get("receiptNo")).trim(),
              receiptDate: String(fd.get("receiptDate")),
              amount: amt,
              bankAccountCode: String(fd.get("bankAccountCode")),
              reference: String(fd.get("reference") || "") || undefined,
              // Only send an allocation when BOTH an invoice and an amount are given. Sending a
              // zero-amount allocation would be refused by the server, and sending none is the
              // legitimate "on account" case rather than an omission.
              allocations: inv && alloc > 0 ? [{ invoiceId: inv, amount: alloc }] : undefined,
            });
            if (r.ok) {
              setDone(
                r.result && r.result.onAccount > 0
                  ? `Receipt banked. ${r.result.onAccount.toLocaleString("id-ID")} is unallocated and sits on account.`
                  : "Receipt banked and allocated.",
              );
            } else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="r-customerId">Customer</label>
          <select id="r-customerId" name="customerId" value={customerId}
            onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(""); }}>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="receiptNo">Receipt number</label>
          <input id="receiptNo" name="receiptNo" required placeholder="RCPT-2026-001" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="receiptDate">Receipt date</label>
          <input id="receiptDate" name="receiptDate" type="date" defaultValue={today()} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="amount">Amount received</label>
          <input id="amount" name="amount" type="number" min="1" step="1000" required
            value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="bankAccountCode">Bank account</label>
          <select id="bankAccountCode" name="bankAccountCode">
            {bankAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="reference">Reference</label>
          <input id="reference" name="reference" placeholder="Transfer BCA" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="invoiceId">Allocate to invoice (optional)</label>
          <select id="invoiceId" name="invoiceId" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">— leave on account —</option>
            {openInvoices
              .filter((i) => !customerId || i.customerName === customers.find((c) => c.id === customerId)?.name)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoiceNo} · due {i.dueDate} · outstanding {Number(i.outstanding).toLocaleString("id-ID")}
                </option>
              ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="allocate">Amount to allocate</label>
          <input id="allocate" name="allocate" type="number" min="0" step="1000"
            value={allocate} onChange={(e) => setAllocate(e.target.value)} disabled={!invoiceId} />
        </div>

        {Number(amount) > 0 && onAccount !== 0 ? (
          <p className="fin-muted fin-form__field--wide">
            {onAccount > 0
              ? <>‌{onAccount.toLocaleString("id-ID")} will sit <strong>on account</strong> — banked but not
                  matched to a debt. That lowers the net receivable while the invoice it might settle
                  stays in the aging, so it is reported separately rather than netted away.</>
              : <>Allocating more than was received will be refused.</>}
          </p>
        ) : null}

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Recording…" : "Record receipt"}</Button>
        </div>
      </form>
    </Card>
  );
}
