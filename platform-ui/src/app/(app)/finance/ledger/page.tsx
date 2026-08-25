import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAccounts, getGeneralLedger, money } from "@/lib/finance";
import { Card, HairlineTable, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// The general ledger — one account's movements, in order, with a running balance.
//
// ── WHY THE ACCOUNT IS IN THE URL ──────────────────────────────────────────────────────────────
// `?account=1120` rather than a dropdown holding client state. An accountant checking a figure
// wants to send somebody "look at the bank account for March", and a URL does that. It also means
// the browser back button walks back through the accounts they were comparing, which is exactly
// what comparing accounts feels like.
//
// ── THE RUNNING BALANCE COMES FROM THE SERVER ──────────────────────────────────────────────────
// It would be trivial to accumulate it in this component, and that is precisely the temptation to
// refuse. `finance_account_movement()` computes it next to the data with the account's own
// normal_balance deciding the direction, so a credit-normal account (accumulated depreciation,
// payables) runs the right way without this page knowing anything about contra accounts. A UI-side
// accumulator would have to re-learn that rule and would get it wrong for exactly those accounts.
export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const accounts = await listAccounts(userId, tenant);
  const postable = accounts.filter((a) => a.isPostable);
  const selected = account && postable.some((a) => a.code === account) ? account : null;
  const rows = selected ? await getGeneralLedger(userId, tenant, selected, from, to) : [];
  const chosen = postable.find((a) => a.code === selected);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">General ledger</h1>
        <p className="fin-page__asof">
          Every movement on one account, oldest first, with the balance after each.
        </p>
      </header>

      <Card title="Choose an account">
        {postable.length === 0 ? (
          <p className="fin-muted">This company has no chart of accounts yet.</p>
        ) : (
          <ul className="fin-accountpicker">
            {postable.map((a) => (
              <li key={a.code}>
                <Link
                  href={`/finance/ledger?account=${encodeURIComponent(a.code)}`}
                  aria-current={a.code === selected ? "page" : undefined}
                  className={a.code === selected ? "fin-accountpicker__on" : undefined}
                >
                  {a.code} — {a.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!selected ? (
        // Not an error and not an empty table. A table with no account chosen would read as "this
        // account has no movements", which is a claim about the books rather than about the state
        // of the page.
        <EmptyNote>Pick an account above to see its ledger.</EmptyNote>
      ) : (
        <Card
          title={`${chosen?.code} — ${chosen?.name}`}
          hint={
            chosen?.isControl
              ? "A control account. Its balance is owned by a subledger, and manual journals are barred from it — which is what lets the subledger be trusted to tie."
              : "Balances run in this account’s own normal direction, so a credit-normal account reads positive when it is in credit."
          }
        >
          {rows.length === 0 ? (
            <p className="fin-muted">
              No movements on this account{from || to ? " in that window" : ""}. Nothing has been
              posted to it.
            </p>
          ) : (
            <HairlineTable
              columns={[
                { label: "Seq", align: "right" }, { label: "Date" }, { label: "Description" },
                { label: "Memo" }, { label: "Debit", align: "right" },
                { label: "Credit", align: "right" }, { label: "Balance", align: "right" },
              ]}
              rows={rows.map((r) => [
                r.ledgerSequence,
                r.entryDate,
                r.description,
                r.memo ?? "",
                r.side === "debit" ? money(r.amount) : "",
                r.side === "credit" ? money(r.amount) : "",
                money(r.runningBalance),
              ])}
            />
          )}
        </Card>
      )}
    </div>
  );
}
