"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable, StatusBadge } from "@/components/ui";
import { ConfirmAction } from "@/components/finance/ConfirmAction";
import {
  createApVendorCredit, applyApVendorCredit, recordBupotAmendment, writeOffApBill,
} from "@/lib/financeActions";
// TYPE-ONLY import, deliberately — see CreditNotesForms.tsx / ArForms.tsx / ApForms.tsx for the same
// note. `lib/finance.ts` opens with `import "server-only"`; a VALUE import here would fail the build.
import type { ApVendor, ApOpenBill, ApVendorCredit, ApBupotException } from "@/lib/finance";

const today = () => new Date().toISOString().slice(0, 10);

// ── THIS IS NOT ArForms/CreditNotesForms WITH THE NOUNS SWAPPED ──────────────────────────────────
// A receivables credit note and a payables vendor credit look like mirror images — both shrink a
// balance with no cash moving — but three consequences carry money and none of them is a sign flip:
//
//   1. INPUT VAT, NOT OUTPUT VAT — and validated the OTHER way round. An AR credit note reverses
//      output VAT the company CHARGED; a vendor credit reverses input VAT (PPN Masukan, account
//      1170) the company CLAIMED. Indonesian law (PMK 65/2010) validates that reversal with a nota
//      retur the BUYER — this company — issues to the vendor, not the vendor's own credit note. Get
//      the direction wrong and the VAT return is wrong, which is why `notaReturNo` is on this form
//      and has no AR equivalent.
//
//   2. WITHHOLDING CAN BE LEFT OVERSTATED, ON PURPOSE. A vendor credit unwinds whatever PPh was
//      withheld on the original bill. That can make an already-issued bukti potong overstate what
//      was actually withheld — and the owner's ruling (c) is that the credit still posts. It is
//      never blocked waiting on a tax filing. The exposure is FLAGGED instead
//      (`requiresBupotAmendment`), and `BupotExceptionsCard` below is the chase list a human clears
//      by filing the amendment and recording its reference.
//
//   3. A WRITE-OFF IS INCOME HERE, NOT AN EXPENSE. An AR write-off debits bad-debt expense — it
//      reduces profit. An AP write-off credits OTHER INCOME (7300) — released debt (pembebasan
//      utang) is taxable income under UU PPh, so writing off a payable INCREASES taxable profit.
//      Reading it as symmetric with AR is exactly the mistake that misstates a tax position.
//
// Which is why this is a second file with its own copy, not `CreditNotesForms.tsx` reused with
// "customer" swapped for "vendor".

const CREDIT_REASONS: Array<{ value: string; label: string }> = [
  { value: "return", label: "Goods returned" },
  { value: "overbilling", label: "Overbilling" },
  { value: "discount", label: "Discount agreed after billing" },
  { value: "service_failure", label: "Service failure" },
  { value: "price_correction", label: "Price correction" },
  { value: "other", label: "Other" },
];

const WRITE_OFF_REASONS: Array<{ value: string; label: string }> = [
  { value: "vendor_dissolved", label: "Vendor dissolved" },
  { value: "statute_barred", label: "Statute-barred" },
  { value: "disputed_abandoned", label: "Dispute abandoned by vendor" },
  { value: "unclaimed", label: "Never claimed by the vendor" },
  { value: "other", label: "Other" },
];

export function IssueVendorCreditForm({
  vendors, openBills, expenseAccounts, liabilityAccounts,
}: {
  vendors: ApVendor[];
  openBills: ApOpenBill[];
  /** The vendor credit's own lines post to the account the original spend hit — the real expense
   *  chart, never a hardcoded code. Unlike the AR side there is no contra-revenue convention to
   *  protect here. */
  expenseAccounts: Array<{ code: string; name: string }>;
  /** Where a withheld amount lands when no `originalBillId` is named — see the field's own note. */
  liabilityAccounts: Array<{ code: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [taxRate, setTaxRate] = useState("12");
  const [amount, setAmount] = useState("");
  const [originalBillId, setOriginalBillId] = useState("");
  const [whtAmount, setWhtAmount] = useState("");
  const [whtCode, setWhtCode] = useState("");
  const [whtRatePercent, setWhtRatePercent] = useState("");
  const [whtAccountCode, setWhtAccountCode] = useState("");
  const [applyNow, setApplyNow] = useState(false);

  const base = Number(amount || 0);
  const previewTax = Number(taxRate) > 0 ? Math.round(base * (11 / 12) * (Number(taxRate) / 100)) : 0;
  const wht = Number(whtAmount || 0);

  if (vendors.length === 0) {
    return (
      <Card title="Issue a vendor credit">
        <p className="fin-muted">There are no vendors on this company&rsquo;s payables ledger yet.</p>
      </Card>
    );
  }
  if (expenseAccounts.length === 0) {
    return (
      <Card title="Issue a vendor credit">
        <p className="fin-muted">
          No postable expense account exists in this company&rsquo;s chart, so there is nowhere to
          post the credit against.
        </p>
      </Card>
    );
  }

  const vendorBills = openBills.filter(
    (b) => !vendorId || b.vendorName === vendors.find((v) => v.id === vendorId)?.name,
  );

  return (
    <Card
      title="Issue a vendor credit"
      hint="The vendor never should have billed this. Reverses INPUT VAT along with the spend — validated by a nota retur THIS company issues, not the vendor's own document — and posted immediately, same as a bill."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          const applyToBillId = String(fd.get("applyToBillId") || "") || undefined;
          const whtAmt = Number(fd.get("withholdingAmount") || 0);
          const wp = Number(fd.get("whtRatePercent") || 0);
          start(async () => {
            const r = await createApVendorCredit({
              vendorId: String(fd.get("vendorId")),
              creditNo: String(fd.get("creditNo")).trim(),
              creditDate: String(fd.get("creditDate")),
              reasonCode: String(fd.get("reasonCode")),
              reason: String(fd.get("reason")).trim(),
              originalBillId: String(fd.get("originalBillId") || "") || undefined,
              notaReturNo: String(fd.get("notaReturNo") || "").trim() || undefined,
              withholdingAmount: whtAmt > 0 ? whtAmt : undefined,
              withholdingCode: whtAmt > 0 ? (String(fd.get("whtCode") || "").trim() || undefined) : undefined,
              withholdingRate: whtAmt > 0 && wp > 0 ? wp / 100 : undefined,
              withholdingAccountCode: whtAmt > 0 ? (String(fd.get("whtAccountCode") || "") || undefined) : undefined,
              applyToBillId,
              applyAmount: applyToBillId ? (Number(fd.get("applyAmount") || 0) || undefined) : undefined,
              lines: [{
                description: String(fd.get("description")).trim(),
                amount: Number(fd.get("amount") || 0),
                creditAccountCode: String(fd.get("creditAccountCode")),
                taxRate: Number(fd.get("taxRate")) || null,
              }],
            });
            if (r.ok) {
              setDone(
                r.result?.requiresBupotAmendment
                  ? `${r.result?.creditNo ?? "Vendor credit"} issued and posted. It unwound withholding — `
                    + `see the bukti potong exceptions list below; an amendment still needs to be filed.`
                  : `${r.result?.creditNo ?? "Vendor credit"} issued and posted.`,
              );
            } else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="vc-vendorId">Vendor</label>
          <select
            id="vc-vendorId" name="vendorId" value={vendorId}
            onChange={(e) => {
              setVendorId(e.target.value);
              setOriginalBillId("");
              const v = vendors.find((x) => x.id === e.target.value);
              setWhtCode(v?.defaultWithholdingCode ?? "");
              setWhtRatePercent(v?.defaultWithholdingRate ? String(Number(v.defaultWithholdingRate) * 100) : "");
            }}
          >
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-no">Credit number</label>
          <input id="vc-no" name="creditNo" required placeholder="VCN-2026-001" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-date">Date</label>
          <input id="vc-date" name="creditDate" type="date" defaultValue={today()} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-original">Original bill</label>
          <select
            id="vc-original" name="originalBillId" value={originalBillId}
            onChange={(e) => {
              setOriginalBillId(e.target.value);
              const bill = vendorBills.find((b) => b.id === e.target.value);
              if (bill) setWhtAmount(bill.withholdingAmount ? String(Number(bill.withholdingAmount)) : "");
            }}
          >
            <option value="">— not tied to one —</option>
            {vendorBills.map((b) => <option key={b.id} value={b.id}>{b.billNo}</option>)}
          </select>
          <span className="fin-muted">
            Strongly preferred over naming a withholding account directly: picking a bill is how the
            server knows which withholding liability the reversal belongs in — the same one the bill
            credited.
          </span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-notaRetur">Nota retur number</label>
          <input id="vc-notaRetur" name="notaReturNo" placeholder="NR-2026-0xx" />
          <span className="fin-muted">
            The document THIS company issues to the vendor — under PMK 65/2010 this, not the
            vendor&rsquo;s own credit note, is what validates reversing the input VAT already claimed.
          </span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-reasonCode">Reason</label>
          <select id="vc-reasonCode" name="reasonCode" defaultValue="return">
            {CREDIT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="vc-reason-text">Explain</label>
          <input id="vc-reason-text" name="reason" required placeholder="Barang dikembalikan — cacat produksi" />
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="vc-description">Line description</label>
          <input id="vc-description" name="description" required placeholder="Retur — 2 unit" />
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-amount">Amount</label>
          <input
            id="vc-amount" name="amount" type="number" min="0" step="1000" required
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-account">Account credited</label>
          <select id="vc-account" name="creditAccountCode">
            {expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="vc-taxRate">PPN rate (%)</label>
          <input
            id="vc-taxRate" name="taxRate" type="number" min="0" max="100" step="1"
            value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
          />
          <span className="fin-muted">Reverses input VAT already claimed — see the nota retur note above.</span>
        </div>

        {base > 0 ? (
          <p className="fin-muted fin-form__field--wide">
            Preview: base {base.toLocaleString("id-ID")} + input PPN reversed {previewTax.toLocaleString("id-ID")} ={" "}
            <strong>{(base + previewTax).toLocaleString("id-ID")}</strong> credited.{" "}
            <em>The server recomputes this and its figure is the one posted.</em>
          </p>
        ) : null}

        <div className="fin-form__field">
          <label htmlFor="vc-whtAmount">Withholding to unwind</label>
          <input
            id="vc-whtAmount" name="withholdingAmount" type="number" min="0" step="1000"
            value={whtAmount} onChange={(e) => setWhtAmount(e.target.value)}
          />
          <span className="fin-muted">
            Copied from the original bill&rsquo;s own withheld amount when a bill is picked above —
            NOT recomputed from a rate. Leave at zero if the bill withheld nothing.
          </span>
        </div>

        {wht > 0 ? (
          <>
            <div className="fin-form__field">
              <label htmlFor="vc-whtCode">Withholding code</label>
              <input id="vc-whtCode" name="whtCode" placeholder="PPH23" value={whtCode} onChange={(e) => setWhtCode(e.target.value)} />
            </div>
            <div className="fin-form__field">
              <label htmlFor="vc-whtRate">Withholding rate (%)</label>
              <input
                id="vc-whtRate" name="whtRatePercent" type="number" min="0" max="100" step="0.1"
                value={whtRatePercent} onChange={(e) => setWhtRatePercent(e.target.value)}
              />
              <span className="fin-muted">
                Copy the RATE from the original bill, not today&rsquo;s vendor default — this is a
                record of what is being reversed, not a new withholding decision. Sent as a fraction
                (2% → 0.02).
              </span>
            </div>
            {!originalBillId ? (
              <div className="fin-form__field">
                <label htmlFor="vc-whtAccountCode">Withholding liability account</label>
                <select id="vc-whtAccountCode" name="whtAccountCode" value={whtAccountCode} onChange={(e) => setWhtAccountCode(e.target.value)}>
                  <option value="">— none —</option>
                  {liabilityAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                </select>
                <span className="fin-muted">
                  Required because no original bill is named above — the server cannot otherwise tell
                  which liability this reversal belongs in and will refuse the credit.
                </span>
              </div>
            ) : null}
            <p className="fin-form__field--wide" style={{ color: "var(--status-warning-fg)" }}>
              This will leave the bukti potong already issued to this vendor overstating what was
              withheld. The credit still posts — it is never blocked on this — but the exposure is
              flagged below (&ldquo;Bukti potong amendments needed&rdquo;) until someone files the
              amendment.
            </p>
          </>
        ) : null}

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="vc-apply-toggle" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="vc-apply-toggle" type="checkbox"
              checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)}
            />
            Apply this credit to a bill immediately
          </label>
        </div>

        {applyNow ? (
          <>
            <div className="fin-form__field">
              <label htmlFor="vc-applyTo">Apply to bill</label>
              <select id="vc-applyTo" name="applyToBillId" defaultValue="">
                <option value="">— choose —</option>
                {vendorBills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.billNo} · outstanding {Number(b.outstanding).toLocaleString("id-ID")}
                  </option>
                ))}
              </select>
            </div>
            <div className="fin-form__field">
              <label htmlFor="vc-applyAmount">Amount to apply</label>
              <input id="vc-applyAmount" name="applyAmount" type="number" min="0" step="1000" />
              <span className="fin-muted">Leave blank to apply the full credit (net of withholding).</span>
            </div>
          </>
        ) : null}

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue vendor credit"}</Button>
        </div>
      </form>
    </Card>
  );
}

/** The vendor credits already on file, and — for an unapplied one — a way to apply it. The
 *  &ldquo;Bukti potong&rdquo; column is the whole reason this table is not `CreditNotesTable` with a
 *  relabelled header: it is the one state an AR credit note can never be in. */
export function VendorCreditsTable({
  credits, openBills,
}: {
  credits: ApVendorCredit[];
  openBills: ApOpenBill[];
}) {
  if (credits.length === 0) {
    return <p className="fin-muted">No vendor credits recorded for this company yet.</p>;
  }
  return (
    <HairlineTable
      columns={[
        { label: "No." }, { label: "Date" }, { label: "Vendor" }, { label: "Reason" },
        { label: "Total", align: "right" }, { label: "Unapplied", align: "right" },
        { label: "Bukti potong" }, { label: "Status" }, { label: "" },
      ]}
      rows={credits.map((c) => [
        c.creditNo,
        c.creditDate,
        `${c.vendorCode} · ${c.vendorName}`,
        c.reason,
        Number(c.total).toLocaleString("id-ID"),
        Number(c.unapplied).toLocaleString("id-ID"),
        c.requiresBupotAmendment ? (
          c.bupotAmendedAt ? (
            <span key={`${c.id}-b`}><StatusBadge label="active" /> <span className="fin-muted">amended</span></span>
          ) : (
            <span key={`${c.id}-b`}><StatusBadge label="review" /> <span className="fin-muted">amendment needed</span></span>
          )
        ) : <span key={`${c.id}-b`} className="fin-muted">—</span>,
        <StatusBadge
          key={`${c.id}-s`}
          label={c.status === "applied" ? "active" : c.status === "void" ? "archived" : "review"}
        />,
        c.status === "issued" && Number(c.unapplied) > 0 ? (
          <ApplyVendorCreditCell
            key={c.id}
            creditId={c.id}
            unapplied={c.unapplied}
            candidateBills={openBills.filter((b) => b.vendorName === c.vendorName)}
          />
        ) : null,
      ])}
    />
  );
}

function ApplyVendorCreditCell({
  creditId, unapplied, candidateBills,
}: {
  creditId: string;
  unapplied: string;
  candidateBills: ApOpenBill[];
}) {
  const [pending, start] = useTransition();
  const [billId, setBillId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) return <span className="fin-muted">applied</span>;
  if (candidateBills.length === 0) {
    return <span className="fin-muted">no open bill for this vendor</span>;
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <select
        value={billId} onChange={(e) => setBillId(e.target.value)}
        style={{ maxWidth: 140 }} aria-label="Apply credit to bill"
      >
        <option value="">— bill —</option>
        {candidateBills.map((b) => <option key={b.id} value={b.id}>{b.billNo}</option>)}
      </select>
      <Button
        size="sm" disabled={pending || !billId}
        onClick={() => {
          setError(null);
          start(async () => {
            const r = await applyApVendorCredit(creditId, { billId, amount: Number(unapplied) });
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
 * The bukti potong chase list — owner ruling (c)'s resolution half. Every row here is a vendor
 * credit that unwound withholding and left an already-issued bukti potong overstating what was
 * withheld; nothing here was blocked from posting, which is the whole reason this list exists rather
 * than a validation error at issue time.
 *
 * A first-class card, not a footnote: this is the one place a human clears the exposure the credit
 * form above deliberately does not stop to ask about.
 *
 * ⚠ `GET .../ap/bupot-exceptions` carries no credit id — only `creditNo`, because it is read straight
 * off `finance_ap_bupot_amendment_exceptions()`, a SQL function shaped like the efaktur-exceptions
 * chase list, neither of which was built to key a follow-up write. `recordBupotAmendment` needs the
 * id, so `credits` (the same `listApVendorCredits` read the table above already made) is passed in
 * to resolve `creditNo → id` here rather than adding a second network round-trip or a new endpoint.
 */
export function BupotExceptionsCard({
  exceptions, credits,
}: {
  exceptions: ApBupotException[];
  credits: ApVendorCredit[];
}) {
  return (
    <Card
      title="Bukti potong amendments needed"
      hint="Each of these vendor credits unwound withholding after the bukti potong was already issued. The credit posted regardless — owner ruling (c) — so this is a chase list, not a blocker."
    >
      {exceptions.length === 0 ? (
        <p className="fin-muted">Nothing outstanding — every vendor credit that touched withholding has its amendment filed.</p>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {exceptions.map((x) => (
            <BupotExceptionRow
              key={x.creditNo}
              exception={x}
              creditId={credits.find((c) => c.creditNo === x.creditNo)?.id}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function BupotExceptionRow({
  exception, creditId,
}: {
  exception: ApBupotException;
  /** `undefined` when the credit that raised this exception is not in the caller's `credits` list —
   *  a status filter on that read, or the two reads racing against a write between them. The action
   *  is disabled rather than sent with a blank id and left to surface a confusing 404. */
  creditId: string | undefined;
}) {
  const [pending, start] = useTransition();
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <div className="fin-form" style={{ borderTop: "1px solid var(--erp-hairline)", paddingTop: 14 }}>
      <p style={{ gridColumn: "1 / -1", margin: 0 }}>
        <strong>{exception.creditNo}</strong> · {exception.creditDate} · {exception.vendorCode} · {exception.vendorName}
        {exception.npwp ? ` · NPWP ${exception.npwp}` : ""}
      </p>
      <p className="fin-muted" style={{ gridColumn: "1 / -1", margin: 0 }}>{exception.detail}</p>
      {done ? (
        <p className="fin-muted" style={{ gridColumn: "1 / -1" }}>Amendment recorded.</p>
      ) : (
        <>
          <div className="fin-form__field">
            <label htmlFor={`bupot-ref-${exception.creditNo}`}>Amended bukti potong reference</label>
            <input
              id={`bupot-ref-${exception.creditNo}`} value={ref} onChange={(e) => setRef(e.target.value)}
              placeholder="e-Bupot amendment number"
            />
          </div>
          <div className="fin-form__actions">
            <Button
              size="sm" disabled={pending || !ref.trim() || !creditId}
              onClick={() => {
                if (!creditId) return;
                setError(null);
                start(async () => {
                  const r = await recordBupotAmendment(creditId, { amendmentRef: ref.trim() });
                  if (r.ok) setDone(true); else setError(r.error ?? "Failed.");
                });
              }}
            >
              {pending ? "Recording…" : "Mark amendment filed"}
            </Button>
          </div>
          {!creditId ? (
            <p className="fin-muted" style={{ gridColumn: "1 / -1" }}>
              This credit is not in the current vendor-credits list (a status filter, most likely) —
              open <code>/finance/payables</code> with no filter to clear it from here.
            </p>
          ) : null}
        </>
      )}
      {error ? <p className="fin-form__error" style={{ gridColumn: "1 / -1" }}>{error}</p> : null}
    </div>
  );
}

/**
 * Write off a payable the company will not pay. Confirmation-gated on the BILL NUMBER, matching
 * `lib/financeActions.ts::writeOffApBill` and the AR side's identical convention.
 *
 * ⚠ Unlike the AR form this credits OTHER INCOME, not an expense — see the header note. That is
 * stated here as a consequence, not a warning adjective, matching `ConfirmAction`'s own convention.
 */
export function WriteOffBillForm({ openBills }: { openBills: ApOpenBill[] }) {
  const [billId, setBillId] = useState(openBills[0]?.id ?? "");
  const [amount, setAmount] = useState(openBills[0]?.outstanding ?? "");
  const [writeOffDate, setWriteOffDate] = useState(today());
  const [reasonCode, setReasonCode] = useState("vendor_dissolved");
  const [reasonText, setReasonText] = useState("");

  const bill = openBills.find((b) => b.id === billId);

  if (openBills.length === 0) {
    return (
      <Card title="Write off a bill">
        <p className="fin-muted">No open bill to write off.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Write off a bill"
      hint="The company owed this and will not pay it. Credits OTHER INCOME (7300), not an expense — released debt (pembebasan utang) is taxable income under UU PPh, so this INCREASES taxable profit. No VAT is reversed; the input VAT on the original purchase was validly claimed."
    >
      <div className="fin-form">
        <div className="fin-form__field">
          <label htmlFor="apwo-bill">Bill</label>
          <select
            id="apwo-bill" value={billId}
            onChange={(e) => {
              setBillId(e.target.value);
              const b = openBills.find((x) => x.id === e.target.value);
              setAmount(b?.outstanding ?? "");
            }}
          >
            {openBills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.billNo} · {b.vendorName} · outstanding {Number(b.outstanding).toLocaleString("id-ID")}
              </option>
            ))}
          </select>
        </div>

        <div className="fin-form__field">
          <label htmlFor="apwo-amount">Amount to write off</label>
          <input
            id="apwo-amount" type="number" min="0" step="1000"
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
          <span className="fin-muted">Defaults to the full outstanding balance; can be less for a partial write-off.</span>
        </div>

        <div className="fin-form__field">
          <label htmlFor="apwo-date">Write-off date</label>
          <input id="apwo-date" type="date" value={writeOffDate} onChange={(e) => setWriteOffDate(e.target.value)} />
        </div>

        <div className="fin-form__field">
          <label htmlFor="apwo-reasonCode">Reason</label>
          <select id="apwo-reasonCode" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {WRITE_OFF_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor="apwo-reason-text">Explain</label>
          <input
            id="apwo-reason-text" value={reasonText} onChange={(e) => setReasonText(e.target.value)}
            placeholder="Vendor dibubarkan — tidak ada entitas penerus untuk ditagih"
          />
        </div>
      </div>

      {bill ? (
        <ConfirmAction
          expected={bill.billNo}
          expectedLabel="bill number"
          consequence={
            "Reduces this bill's outstanding balance to reflect a debt the company will not pay, and books "
            + "it as other income, not an expense. Corrected only by a reversal afterwards — re-typing the "
            + "bill number is the cheapest guard against writing off the wrong one."
          }
          actionLabel="Write off this bill"
          run={({ confirm }) =>
            writeOffApBill(bill.id, {
              amount: Number(amount || bill.outstanding),
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
