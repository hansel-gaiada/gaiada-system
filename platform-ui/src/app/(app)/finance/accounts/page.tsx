import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAccounts, type Account, type AccountType } from "@/lib/finance";
import { Card, HairlineTable, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

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
  const accounts = await listAccounts(userId, tenant, q);
  if (accounts == null) {
    return <EmptyNote>You do not have finance access for this company.</EmptyNote>;
  }

  // Statement order, which is what an accountant expects — not alphabetical by type name.
  const GROUPS: Array<{ type: AccountType; label: string }> = [
    { type: "asset", label: "Assets" },
    { type: "liability", label: "Liabilities" },
    { type: "equity", label: "Equity" },
    { type: "revenue", label: "Revenue" },
    { type: "expense", label: "Expenses" },
  ];
  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code));
  const grouped = GROUPS.map((g) => ({ ...g, rows: sorted.filter((a) => a.accountType === g.type) }))
    .filter((g) => g.rows.length > 0);
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

        {sorted.length === 0 ? (
          <EmptyNote>
            {q
              ? `No account matches "${q}". The filter is on code and name; it does not search balances.`
              : "This company has no chart of accounts yet. Run the finance configuration seed to instantiate one from the Indonesian template."}
          </EmptyNote>
        ) : (
          grouped.map((g) => (
            <section key={g.type} style={{ marginBottom: 26 }}>
              <Eyebrow>{g.label}</Eyebrow>
              <HairlineTable
                columns={[
                  { label: "Code" }, { label: "Name" }, { label: "Normal balance" },
                  { label: "Manual posting" }, { label: "Control" },
                ]}
                rows={g.rows.map((a: Account) => [
                  a.code,
                  a.status === "archived" ? `${a.name} (archived)` : a.name,
                  a.normalBalance,
                  // Stated as a refusal, not left blank — a blank would read as "unknown" when it
                  // actually means "the subledger owns this account".
                  a.allowManualPosting ? "allowed" : "subledger only",
                  a.isControl ? (a.controlSubledger ?? "control") : "—",
                ])}
              />
            </section>
          ))
        )}
      </Card>

      <Card title="Editing the chart" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Adding, renaming and deactivating an account is <strong>not built here yet</strong>. The
          chart is instantiated from the Indonesian template by the finance configuration seed, and
          changing it is deliberately not a casual edit: a code that appears in a posted journal can
          never be removed, because the entry that used it is immutable. What an edit surface has to
          offer instead is deactivation and re-parenting, and neither is wired.
        </p>
        <p className="fin-muted">
          Everything else on this page is live — this is the real chart, read from the ledger.
        </p>
      </Card>
    </div>
  );
}
