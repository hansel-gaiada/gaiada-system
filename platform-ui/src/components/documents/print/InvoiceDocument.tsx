import type { InvoicePrintPayload } from "@/lib/documents-print-data";
import { formatAmount, formatDecimal, formatMoney } from "@/lib/documents-format";

// PV5-07 — the invoice of record as a printed document (rendered once at issue and stored; decision 19). Everything
// shown comes from the payload platform-nest built from the database: the issuer block frozen at issue (decision 5),
// the ledger's lines and tax, the number and dates. Nothing is computed here; amounts are formatted, not added.
export function InvoiceDocument({ payload }: { payload: InvoicePrintPayload }) {
  const { invoice, issuer, client, lines, taxLines } = payload;
  const mu = invoice.minorUnit;
  const money = (a: string) => formatMoney(a, invoice.currency, mu);
  const isVoid = invoice.status === "void";
  return (
    <article className="doc-print doc-invoice" aria-label={`Invoice ${invoice.invoiceNo}`}>
      {isVoid && (
        <p className="doc-print__void" role="note">
          VOID: this invoice was cancelled after it was issued and is not payable.
        </p>
      )}
      <header className="doc-print__head">
        <div className="doc-print__issuer">
          <p className="doc-print__issuer-name">{issuer.legalName}</p>
          <p className="doc-print__address">{issuer.address}</p>
          {issuer.npwp && <p>NPWP {issuer.npwp}</p>}
        </div>
        <div className="doc-print__title-block">
          <h1 className="doc-print__title">Invoice</h1>
          <dl className="doc-print__facts">
            <dt>Number</dt>
            <dd>{invoice.invoiceNo}</dd>
            <dt>Issue date</dt>
            <dd>{invoice.issueDate}</dd>
            <dt>Due date</dt>
            <dd>{invoice.dueDate}</dd>
            {invoice.periodStart && invoice.periodEnd && (
              <>
                <dt>Period</dt>
                <dd>
                  {invoice.periodStart} to {invoice.periodEnd}
                </dd>
              </>
            )}
          </dl>
        </div>
      </header>

      <section className="doc-print__section" aria-label="Billed to">
        <h2 className="doc-print__h2">Billed to</h2>
        <p>{client.name}</p>
      </section>

      <section className="doc-print__section" aria-label="Lines">
        <table className="doc-print__table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Description</th>
              <th scope="col" className="num">Quantity</th>
              <th scope="col" className="num">Unit price</th>
              <th scope="col" className="num">Amount</th>
              {taxLines.length > 0 && <th scope="col" className="num">Tax</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td>
                <td>{l.description}</td>
                <td className="num">{formatDecimal(l.quantity)}</td>
                <td className="num">{formatAmount(l.unitPrice, mu)}</td>
                <td className="num">{formatAmount(l.amount, mu)}</td>
                {taxLines.length > 0 && (
                  <td className="num">
                    {l.taxCode ? `${formatAmount(l.taxAmount, mu)} (${l.taxCode}${l.taxRate ? ` ${formatDecimal(l.taxRate)}%` : ""})` : ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="doc-print__totals">
          <dt>Subtotal</dt>
          <dd>{money(invoice.subtotal)}</dd>
          {taxLines.map((t) => (
            <div key={`${t.code}-${t.rate ?? ""}`} className="doc-print__totals-row">
              <dt>
                Tax {t.code}
                {t.rate ? ` ${formatDecimal(t.rate)}%` : ""} on {formatAmount(t.base, mu)}
              </dt>
              <dd>{money(t.amount)}</dd>
            </div>
          ))}
          {taxLines.length === 0 && (
            <>
              <dt>Tax</dt>
              <dd>{money(invoice.taxTotal)}</dd>
            </>
          )}
          <dt className="doc-print__grand">Total due</dt>
          <dd className="doc-print__grand">{money(invoice.total)}</dd>
        </dl>
      </section>

      {!isVoid && (
        <section className="doc-print__section doc-print__pay" aria-label="How to pay">
          <h2 className="doc-print__h2">How to pay</h2>
          {issuer.bank ? (
            <>
              <p>
                Transfer {money(invoice.total)} by {invoice.dueDate} to:
              </p>
              <dl className="doc-print__facts">
                <dt>Bank</dt>
                <dd>{issuer.bank.name}</dd>
                <dt>Account name</dt>
                <dd>{issuer.bank.accountName}</dd>
                <dt>Account number</dt>
                <dd>{issuer.bank.accountNo}</dd>
                <dt>Payment reference</dt>
                <dd>{invoice.invoiceNo}</dd>
              </dl>
              <p>Quote the invoice number as the payment reference so the payment can be matched to this invoice.</p>
            </>
          ) : (
            <p>Pay by {invoice.dueDate}, quoting invoice number {invoice.invoiceNo}.</p>
          )}
        </section>
      )}

      <footer className="doc-print__foot">
        <p>
          Invoice {invoice.invoiceNo}, issued {invoice.issueDate} by {issuer.legalName}. This is the invoice of record; the
          PDF was produced once, when the invoice was issued.
        </p>
      </footer>
    </article>
  );
}
