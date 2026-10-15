import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAccountsResult } from "@/lib/finance-data";
import { canEditChart } from "@/lib/chartOfAccounts";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ChartOfAccounts } from "@/components/finance/ChartOfAccounts";

// The chart of accounts — the vocabulary every figure in this workspace is expressed in.
//
// ── GROUPED BY TYPE, NOT NESTED BY PARENT ──────────────────────────────────────────────────────
// An accountant reads a chart in statement order — assets, liabilities, equity, revenue, expense —
// because that is the order the balance sheet and P&L present them. The API does not expose a
// parent link, so this groups by `accountType` and orders by code within each group rather than
// inventing a hierarchy from code prefixes (this chart uses 4-digit codes at more than one level,
// so prefix-nesting would draw a tree that is wrong in places and confidently so).
//
// ── THREE COLUMNS THAT LOOK COSMETIC AND ARE NOT ───────────────────────────────────────────────
// `Normal balance`, `Manual posting` and `Control` decide whether a journal will be ACCEPTED, so
// they belong beside the code rather than behind an edit screen:
//
//   • Normal balance is where the sign comes from. A contra account (accumulated depreciation, a
//     sales return) is an asset or revenue account whose normal balance runs the OTHER way, and the
//     reporting layer derives sign from this column — never from a hardcoded list of codes. Reading
//     a chart without it is how somebody posts a debit to a credit-natured account and gets a
//     balance sheet that balances while being wrong.
//
//   • Manual posting says whether a human may touch it at all. A control account is owned by its
//     subledger and REFUSES a hand-written journal — that refusal is what lets the aging be trusted
//     to tie to the balance sheet. Somebody who does not know which those are will keep trying and
//     keep being refused with no idea why, so the owning subledger is named.
//
// ── EDITING (DW-7g-2, BFF §49) ──────────────────────────────────────────────────────────────────
// New account, Rename and Archive or Restore are drawn for `company.manage`, an elevated role or a `finance_manager` grant in the
// company (a superset of the Cerbos `finance_config` write rule, which `lib/rbac.ts` has no capability for); the server
// refuses anyone else in words. The chart is read through `ReadResult`, so a refused or failed read is said as such and is
// never "this company has no chart". Archived accounts are hidden by default behind a "Show archived" switch.
export default async function FinanceAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const q = sp.q?.trim() || undefined;
  const read = await listAccountsResult(userId, tenant, q);
  if (read.kind !== "ok") {
    return (
      <div className="fin-page">
        <header className="fin-page__head">
          <Eyebrow>Finance &amp; Accounting</Eyebrow>
          <h1 className="fin-page__title">Chart of accounts</h1>
        </header>
        <ReadRefusal subject="the chart of accounts" kind={read.kind} reason={read.kind === "unavailable" ? read.reason : undefined} inline />
      </div>
    );
  }
  const accounts = read.data;
  const postable = accounts.filter((a) => a.allowManualPosting).length;
  const archived = accounts.filter((a) => a.status === "archived").length;

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Chart of accounts</h1>
        <p className="fin-muted">
          {accounts.length} account{accounts.length === 1 ? "" : "s"} · {postable} accept a manual
          journal · the rest are control or non-postable headers
          {archived > 0 ? ` · ${archived} archived` : ""}.
        </p>
      </header>

      <Card
        title="Accounts"
        hint="Codes are the vocabulary of every figure in this workspace. Grouped in statement order, by code within each group."
      >
        <form method="get" className="fin-form" style={{ marginBottom: 16 }}>
          <div className="fin-form__field">
            <label htmlFor="q">Filter by code or name</label>
            <input id="q" name="q" type="search" defaultValue={q ?? ""} placeholder="e.g. 1100 or bank" />
          </div>
          <div className="fin-form__actions">
            <button type="submit" className="lux-btn lux-btn--sm">Filter</button>
            {q ? (
              <Link href="/finance/accounts" className="lux-btn lux-btn--ghost lux-btn--sm">Clear</Link>
            ) : null}
          </div>
        </form>

        <ChartOfAccounts accounts={accounts} canEdit={canEditChart(me, tenant)} query={q} />
      </Card>

      <Card title="Changing the chart" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          A code that appears in a posted journal can never change, because the entry that used it is immutable: the code field
          locks once an account has postings, and the way to retire it is to <strong>archive</strong> it and add a new one. An
          archived account refuses new postings and keeps its history. It cannot be archived while it still holds a balance, has
          active child accounts, is a control account, or is still named by a posting rule, tax code, asset class, loan or the
          billing profile. Restoring one needs its parent to be active.
        </p>
        <p className="fin-muted">
          Control accounts (receivables, payables, inventory, fixed assets) come from the template and their subledgers; they
          are not added or archived here. Everything on this page is live: this is the real chart, read from the ledger.
        </p>
      </Card>
    </div>
  );
}
