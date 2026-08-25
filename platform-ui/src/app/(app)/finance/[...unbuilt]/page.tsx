import Link from "next/link";
import { Card, Eyebrow } from "@/components/ui";

// A catch-all for finance tabs whose page is not built yet.
//
// ── WHY THIS EXISTS RATHER THAN A SHORTER TAB STRIP ────────────────────────────────────────────
// The tab strip names the whole department on purpose: an accountant should be able to see that
// receivables and the period close are part of this workspace, not wonder whether they live
// somewhere else or were forgotten. But a tab that 404s is worse than a tab that is absent — a 404
// reads as "the app is broken", and the reader has no way to tell it apart from one.
//
// So an unbuilt tab lands here and SAYS what it is, what already works behind it, and what is
// missing. That is this codebase's existing rule for an unfurnished capability
// (components/BackendPending.tsx, systems/EmptyNote.tsx): never a blank table, never a false
// success, and never a dead end that looks like a fault.
const PLANNED: Record<string, { title: string; state: string; detail: string }> = {
  accounts: {
    title: "Chart of accounts",
    state: "The data is live; the page is not built.",
    detail:
      "Every account is already readable — the journal entry form and the general ledger both list them. What is missing is a page to browse the tree, and the ability to add or rename an account from here rather than through a seed.",
  },
  receivables: {
    title: "Receivables",
    state: "Aging and the tie-out are live on the Overview; the working surface is not built.",
    detail:
      "The subledger behind this is complete: invoices, receipts, allocations, and a reconciliation that proves the aging ties to the balance sheet. What is missing is the surface to raise an invoice and record a receipt.",
  },
  payables: {
    title: "Payables",
    state: "Aging and the tie-out are live on the Overview; the working surface is not built.",
    detail:
      "Bills, payments and Indonesian withholding (PPh 21/23/4(2)) are all implemented and tested — a bill splits correctly between what the vendor is owed and what is owed to the tax office. What is missing is the surface to enter one.",
  },
  tax: {
    title: "Tax",
    state: "The figures exist; the page is not built.",
    detail:
      "PPN output and input tax, the creditable/uncreditable split, and the e-Faktur exception list are all computed. What is missing is the page that shows them and the return-preparation flow.",
  },
  close: {
    title: "Period close",
    state: "The checklist is live on the Overview; the close ACTION is not built.",
    detail:
      "Close readiness already reports every blocker — ledger integrity, both subledger tie-outs, bank reconciliation, unrun depreciation, and the accountant sign-off. What is missing is the surface to sign off and to lock the period, which is deliberately the most cautious thing to build: closing is terminal.",
  },
};

export default async function FinanceUnbuiltPage({ params }: { params: Promise<{ unbuilt: string[] }> }) {
  const { unbuilt } = await params;
  const key = unbuilt?.[0] ?? "";
  const known = PLANNED[key];

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">{known?.title ?? "Not part of this workspace"}</h1>
      </header>

      <Card title={known ? "Not built yet" : "No such page"}>
        {known ? (
          <>
            <p>
              <strong>{known.state}</strong>
            </p>
            <p className="fin-muted">{known.detail}</p>
          </>
        ) : (
          <p className="fin-muted">
            There is no <code>/finance/{key}</code> page. Check the tabs above for what this
            workspace holds.
          </p>
        )}
        <p className="fin-muted">
          In the meantime: <Link href="/finance">the overview</Link> carries the position and the
          integrity checks, <Link href="/finance/journals">journals</Link> is where entries are
          posted, and <Link href="/finance/reports">reports</Link> has the three statements.
        </p>
      </Card>
    </div>
  );
}
