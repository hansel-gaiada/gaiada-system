"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable } from "@/components/ui";
import { enterApBill, approveApBill, releaseApPayment, createApVendor } from "@/lib/financeActions";
// TYPE-ONLY import, deliberately. `lib/finance.ts` opens with `import "server-only"` and this file
// is `"use client"` — pulling in any VALUE from that module (its `money()` formatter included)
// drags the server-only guard into the client bundle and fails the build. ArForms.tsx hit this
// same wall first; money below is formatted by hand with `.toLocaleString` for the same reason.
import type { ApVendor, ApOpenBill } from "@/lib/finance";

// The payables write surfaces: enter a bill, approve it, release a payment. Mirrors ArForms.tsx —
// same rule: NOTHING is validated here that the server also validates. The withholding split, the
// PPN base, whether an account exists, whether an allocation exceeds its payment — all decided
// server-side, and the message shown is the server's own. The one thing computed client-side is
// the PREVIEW split, labelled as an estimate for exactly that reason.
//
// ── ENTRY AND APPROVAL ARE TWO BUTTONS, NEVER ONE ───────────────────────────────────────────────
// `bill_entry` + `approve` is a seeded blocking conflict in the duty matrix: whoever types a
// vendor's invoice in must not be the one who admits it to the books. `EnterBillForm` below and its
// per-row `ApproveDraftCell` call two different server actions under two different Cerbos actions,
// each with its own `useTransition` — there is no code path in this file that can fire both from
// one click.
//
// ── WHY THE "PENDING APPROVAL" LIST IS SESSION-SCOPED, AND WHY THAT IS A REAL GAP ───────────────
// The contract this page is built against has no `GET .../ap/bills?status=draft`, so there is no
// way to list drafts someone ELSE entered. The list below only remembers what THIS browser session
// created, which lets the same person exercise both steps for testing but does not serve the real
// workflow — a different person, on a different device, approving a bill they did not type in. That
// person currently has no way to discover the draft exists. Closing that gap needs a new read
// endpoint; it is not something this file can fake without pretending a list is complete when it
// is not.
//
// ── WITHHOLDING RATE: THE FORM TAKES A PERCENT, THE API TAKES A FRACTION ────────────────────────
// `finance_ap_bills.withholding_rate` is a fraction (0.02 for PPh 23 at 2%) and the API rejects
// anything above 1 for exactly that reason — a typo of "2" instead of "0.02" would otherwise
// withhold 200% of the bill. Asking a person to type "0.02" into a form is how that typo happens
// again in the other direction, so the field here is a percent (matching the PPN rate field right
// next to it) and is divided by 100 at submit. That division is a UNIT CONVERSION, not a
// re-implementation of the withholding split — the split itself (subtotal × rate, rounded) is only
// mirrored for the preview below, and the server's own figure is what actually posts.

const today = () => new Date().toISOString().slice(0, 10);

/** Adds `days` to an ISO date without a date library (this project has four runtime deps). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface DraftBill {
  id: string;
  billNo: string;
  vendorName: string;
  amountPayable: number;
  withholdingAmount: number;
}

export function EnterBillForm({
  vendors, expenseAccounts, liabilityAccounts,
}: {
  vendors: ApVendor[];
  expenseAccounts: Array<{ code: string; name: string }>;
  liabilityAccounts: Array<{ code: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [billDate, setBillDate] = useState(today());
  const [taxRate, setTaxRate] = useState("0");
  const [unitPrice, setUnitPrice] = useState("");
  const [whtPercent, setWhtPercent] = useState("");
  const [whtCode, setWhtCode] = useState("");
  const [whtAccountCode, setWhtAccountCode] = useState("");
  const [drafts, setDrafts] = useState<DraftBill[]>([]);

  const vendor = vendors.find((v) => v.id === vendorId);
  const terms = vendor?.paymentTermsDays ?? 30;
  const [dueDate, setDueDate] = useState(addDays(today(), terms));

  // A PREVIEW, not the figures that will be posted — see the header note. The server recomputes
  // both the PPN and the withholding split and its answer wins.
  const base = Number(unitPrice || 0);
  const previewPpn = Number(taxRate) > 0 ? Math.round(base * (11 / 12) * (Number(taxRate) / 100)) : 0;
  const previewTotal = base + previewPpn;
  const whtRate = Number(whtPercent || 0) / 100;
  const previewWht = whtRate > 0 ? Math.round(base * whtRate) : 0;
  const previewNet = previewTotal - previewWht;

  if (vendors.length === 0) {
    return (
      <Card title="Enter a bill">
        <p className="fin-muted">
          There are no vendors on this company&rsquo;s payables ledger yet, so there is nobody to
          bill. A vendor record is not just a name — it carries the NPWP, the PKP flag and the
          default withholding code that decide how a bill is taxed.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Enter a bill"
      hint="Creates a DRAFT only. A draft affects nothing until it is approved separately below."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const wp = Number(fd.get("whtPercent") || 0);
          const enteredVendorId = String(fd.get("vendorId"));
          const enteredBillNo = String(fd.get("billNo")).trim();
          start(async () => {
            const r = await enterApBill({
              vendorId: enteredVendorId,
              billNo: enteredBillNo,
              billDate: String(fd.get("billDate")),
              dueDate: String(fd.get("dueDate")),
              withholdingRate: wp > 0 ? wp / 100 : null,
              withholdingCode: wp > 0 ? (String(fd.get("whtCode") || "").trim() || undefined) : undefined,
              withholdingAccountCode: wp > 0 ? (String(fd.get("whtAccountCode") || "") || undefined) : undefined,
              lines: [{
                description: String(fd.get("description")).trim(),
                quantity: Number(fd.get("quantity") || 1),
                unitPrice: Number(fd.get("unitPrice") || 0),
                expenseAccountCode: String(fd.get("expenseAccountCode")),
                taxCode: Number(fd.get("taxRate")) > 0 ? "PPN" : undefined,
                taxRate: Number(fd.get("taxRate")) || null,
              }],
            });
            if (r.ok && r.result) {
              const created = r.result;
              setDone("Bill entered as a draft. It changes nothing until it is approved.");
              setDrafts((ds) => [
                {
                  id: created.id,
                  billNo: enteredBillNo,
                  vendorName: vendors.find((v) => v.id === enteredVendorId)?.name ?? "",
                  amountPayable: created.amountPayable,
                  withholdingAmount: created.withholdingAmount,
                },
                ...ds,
              ]);
            } else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="vendorId">Vendor</label>
          <select
            id="vendorId" name="vendorId" value={vendorId}
            onChange={(e) => {
              setVendorId(e.target.value);
              const v = vendors.find((x) => x.id === e.target.value);
              setDueDate(addDays(billDate, v?.paymentTermsDays ?? 30));
              // Prefilled from the vendor's own defaults, not left blank — a PPh 23 contractor
              // billed with no withholding is the mistake this field exists to prevent.
              setWhtCode(v?.defaultWithholdingCode ?? "");
              setWhtPercent(v?.defaultWithholdingRate ? String(Number(v.defaultWithholdingRate) * 100) : "");
            }}
          >
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.code} · {v.name}</option>
            ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="billNo">Bill number</label>
          <input id="billNo" name="billNo" required placeholder="INV-VENDOR-2026-001" />
          <span className="fin-muted">The VENDOR&rsquo;s own number, not ours.</span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="billDate">Bill date</label>
          <input
            id="billDate" name="billDate" type="date" value={billDate}
            onChange={(e) => { setBillDate(e.target.value); setDueDate(addDays(e.target.value, terms)); }}
          />
        </div>

        <div className="fin-form__field">
          <label htmlFor="dueDate">Due date</label>
          <input id="dueDate" name="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <span className="fin-muted">Default is this vendor&rsquo;s {terms}-day terms.</span>
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="description">Description</label>
          <input id="description" name="description" required placeholder="Jasa konsultasi IT — Agustus 2026" />
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
          <label htmlFor="expenseAccountCode">Expense account</label>
          <select id="expenseAccountCode" name="expenseAccountCode">
            {expenseAccounts.map((a) => (
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

        <div className="fin-form__field">
          <label htmlFor="whtPercent">Withholding rate (%)</label>
          <input
            id="whtPercent" name="whtPercent" type="number" min="0" max="100" step="0.1"
            value={whtPercent} onChange={(e) => setWhtPercent(e.target.value)}
          />
          <span className="fin-muted">
            PPh 23 is typically 2%. Sent to the server as a fraction (2% → 0.02) — see the note above
            on why the field itself takes a percent.
          </span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="whtCode">Withholding code</label>
          <input id="whtCode" name="whtCode" placeholder="PPH23" value={whtCode} onChange={(e) => setWhtCode(e.target.value)} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="whtAccountCode">Withholding payable account</label>
          <select id="whtAccountCode" name="whtAccountCode" value={whtAccountCode} onChange={(e) => setWhtAccountCode(e.target.value)}>
            <option value="">— none —</option>
            {liabilityAccounts.map((a) => (
              <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
            ))}
          </select>
          <span className="fin-muted">
            Required once a withholding rate is entered — the amount withheld is owed to DJP, a
            different creditor from the vendor, and needs an account of its own.
          </span>
        </div>

        {base > 0 ? (
          <p className="fin-muted fin-form__field--wide">
            Preview: bill total {previewTotal.toLocaleString("id-ID")}
            {previewWht > 0 ? (
              <>
                {" "}− withheld {previewWht.toLocaleString("id-ID")} = vendor is paid{" "}
                <strong>{previewNet.toLocaleString("id-ID")}</strong>; DJP is owed{" "}
                <strong>{previewWht.toLocaleString("id-ID")}</strong>.
              </>
            ) : (
              <> = vendor is paid <strong>{previewTotal.toLocaleString("id-ID")}</strong>.</>
            )}{" "}
            <em>The server recomputes both splits and its figures are what post.</em>
          </p>
        ) : null}

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Entering…" : "Enter bill (draft)"}</Button>
        </div>
      </form>

      {drafts.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <p className="fin-muted">
            Entered this browser session, pending approval — see the header note on why this list
            cannot show a draft someone else entered.
          </p>
          <HairlineTable
            columns={[
              { label: "Bill no" },
              { label: "Vendor" },
              { label: "Payable to vendor", align: "right" },
              { label: "Withheld", align: "right" },
              { label: "" },
            ]}
            rows={drafts.map((d) => [
              d.billNo,
              d.vendorName,
              d.amountPayable.toLocaleString("id-ID"),
              d.withholdingAmount.toLocaleString("id-ID"),
              <ApproveDraftCell
                key={d.id}
                billId={d.id}
                billNo={d.billNo}
                onApproved={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))}
              />,
            ])}
          />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The approve action. Its own component, its own `useTransition`, its own call to `approveApBill`.
 *
 * Folding this into the entry form's submit — even as a "save and approve" checkbox — would let
 * whoever enters a bill also post it, which is exactly the conflict `bill_entry` + `approve` exists
 * to prevent. Keeping it a separate component is what makes that structurally true rather than a
 * convention someone could quietly break by editing the form above.
 */
function ApproveDraftCell({
  billId, billNo, onApproved,
}: { billId: string; billNo: string; onApproved: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span>
      <Button
        size="sm" disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const r = await approveApBill(billId);
            if (r.ok) onApproved(); else setError(r.error ?? "Failed.");
          });
        }}
      >
        <span aria-label={`Approve bill ${billNo}`}>{pending ? "Approving…" : "Approve"}</span>
      </Button>
      {error ? <p className="fin-form__error" style={{ marginTop: 4 }}>{error}</p> : null}
    </span>
  );
}

export function ReleasePaymentForm({
  vendors, openBills, bankAccounts,
}: {
  vendors: ApVendor[];
  openBills: ApOpenBill[];
  bankAccounts: Array<{ code: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [billId, setBillId] = useState("");
  const [amount, setAmount] = useState("");
  const [allocate, setAllocate] = useState("");

  if (vendors.length === 0 || bankAccounts.length === 0) {
    return (
      <Card title="Release a payment">
        <p className="fin-muted">
          {vendors.length === 0
            ? "No vendors on the payables ledger yet."
            : "No bank account in the chart of accounts to pay from."}
        </p>
      </Card>
    );
  }

  const onAccount = Number(amount || 0) - Number(allocate || 0);

  return (
    <Card
      title="Release a payment"
      hint="The narrowest grant in the module. Kept separate from bill entry so the person who typed a bill in cannot also be the one who pays it."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const amt = Number(fd.get("amount") || 0);
          const alloc = Number(fd.get("allocate") || 0);
          const bill = String(fd.get("billId") || "");
          start(async () => {
            const r = await releaseApPayment({
              vendorId: String(fd.get("vendorId")),
              paymentNo: String(fd.get("paymentNo")).trim(),
              paymentDate: String(fd.get("paymentDate")),
              amount: amt,
              bankAccountCode: String(fd.get("bankAccountCode")),
              reference: String(fd.get("reference") || "") || undefined,
              // Only send an allocation when BOTH a bill and an amount are given — see the AR
              // receipt form's identical note. Sending none is the legitimate "on account" case.
              allocations: bill && alloc > 0 ? [{ billId: bill, amount: alloc }] : undefined,
            });
            if (r.ok) {
              setDone(
                r.result && r.result.onAccount > 0
                  ? `Payment released. ${r.result.onAccount.toLocaleString("id-ID")} is unallocated and sits on account.`
                  : "Payment released and allocated.",
              );
            } else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="p-vendorId">Vendor</label>
          <select
            id="p-vendorId" name="vendorId" value={vendorId}
            onChange={(e) => { setVendorId(e.target.value); setBillId(""); }}
          >
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="paymentNo">Payment number</label>
          <input id="paymentNo" name="paymentNo" required placeholder="PMT-2026-001" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="paymentDate">Payment date</label>
          <input id="paymentDate" name="paymentDate" type="date" defaultValue={today()} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="amount">Amount released</label>
          <input
            id="amount" name="amount" type="number" min="1" step="1000" required
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
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
          <label htmlFor="billId">Allocate to bill (optional)</label>
          <select id="billId" name="billId" value={billId} onChange={(e) => setBillId(e.target.value)}>
            <option value="">— leave on account —</option>
            {openBills
              .filter((b) => !vendorId || b.vendorName === vendors.find((v) => v.id === vendorId)?.name)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.billNo} · due {b.dueDate} · outstanding {Number(b.outstanding).toLocaleString("id-ID")}
                </option>
              ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="allocate">Amount to allocate</label>
          <input
            id="allocate" name="allocate" type="number" min="0" step="1000"
            value={allocate} onChange={(e) => setAllocate(e.target.value)} disabled={!billId}
          />
        </div>

        {Number(amount) > 0 && onAccount !== 0 ? (
          <p className="fin-muted fin-form__field--wide">
            {onAccount > 0 ? (
              <>
                {onAccount.toLocaleString("id-ID")} will sit <strong>on account</strong> — paid but
                not matched to a bill, so it lowers the net payable while the bill it might settle
                stays in the aging.
              </>
            ) : (
              <>Allocating more than was released will be refused.</>
            )}
          </p>
        ) : null}

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Releasing…" : "Release payment"}</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Add a vendor. `vendor_master`, NOT `manage` — see `lib/financeActions.ts::createApVendor`'s own
 * note on why creation sits on the same grant as editing a vendor's bank details, and is therefore a
 * blocking pair with payment release rather than something bill entry can also do.
 */
export function CreateVendorForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [whtPercent, setWhtPercent] = useState("");

  return (
    <Card title="Add a vendor" hint="Not just a name — this record carries the NPWP, the PKP flag and the default withholding code that decide how a bill is taxed.">
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const wp = Number(fd.get("defaultWithholdingRate") || 0);
          start(async () => {
            const r = await createApVendor({
              code: String(fd.get("code")).trim(),
              name: String(fd.get("name")).trim(),
              npwp: String(fd.get("npwp") || "") || undefined,
              isPkp: fd.get("isPkp") === "on",
              defaultWithholdingCode: String(fd.get("defaultWithholdingCode") || "") || undefined,
              defaultWithholdingRate: wp > 0 ? wp / 100 : undefined,
              paymentTermsDays: Number(fd.get("paymentTermsDays") || 30),
            });
            if (r.ok) setDone(`${r.result?.code ?? "Vendor"} added.`);
            else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="vend-code">Code</label>
          <input id="vend-code" name="code" required placeholder="V-003" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="vend-name">Name</label>
          <input id="vend-name" name="name" required placeholder="CV Contoh Jaya" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="vend-npwp">NPWP</label>
          <input id="vend-npwp" name="npwp" placeholder="01.234.567.8-901.000" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="vend-terms">Payment terms (days)</label>
          <input id="vend-terms" name="paymentTermsDays" type="number" min="0" step="1" defaultValue={30} />
        </div>
        <div className="fin-form__field">
          <label htmlFor="vend-whtCode">Default withholding code</label>
          <input id="vend-whtCode" name="defaultWithholdingCode" placeholder="PPH23" />
        </div>
        <div className="fin-form__field">
          <label htmlFor="vend-whtRate">Default withholding rate (%)</label>
          <input
            id="vend-whtRate" name="defaultWithholdingRate" type="number" min="0" max="100" step="0.1"
            value={whtPercent} onChange={(e) => setWhtPercent(e.target.value)}
          />
          <span className="fin-muted">PPh 23 is typically 2%. Sent as a fraction (2% → 0.02) — see the header note on why the field itself takes a percent.</span>
        </div>
        <div className="fin-form__field">
          <label htmlFor="vend-pkp" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input id="vend-pkp" name="isPkp" type="checkbox" />
            Registered PKP
          </label>
        </div>

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add vendor"}</Button>
        </div>
      </form>
    </Card>
  );
}
