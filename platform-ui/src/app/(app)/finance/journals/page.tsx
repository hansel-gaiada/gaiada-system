import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listJournals, listAccounts, money } from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { JournalEntryForm } from "@/components/finance/JournalEntryForm";

// The journal register — the ledger's front door.
//
// This is the only surface in the estate where money movement is RECORDED. Everything else in the
// finance workspace reads what this produced, which is why it sits first in the tab strip after the
// overview.
//
// ── THE LIST SHOWS THE HASH SEQUENCE, NOT A ROW NUMBER ─────────────────────────────────────────
// `ledgerSequence` is the entry's position in the hash chain. It is shown because it is the thing
// an auditor checks against `finance_ledger_verify` — a gap in it is not cosmetic, it means the
// chain has been tampered with or a posting failed halfway. A generic "#1, #2, #3" would look the
// same and mean nothing.
export default async function FinanceJournalsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const [entries, accounts] = await Promise.all([
    listJournals(userId, tenant, 100),
    listAccounts(userId, tenant),
  ]);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Journals</h1>
        <p className="fin-page__asof">
          Every entry in the ledger, newest first. Entries are immutable — a correction is a
          reversal, and both stay visible.
        </p>
      </header>

      {/* The form is ABOVE the register, deliberately: the reason an accountant opens this page is
          usually to record something, not to browse. Browsing is what the general ledger is for. */}
      {accounts.length === 0 ? (
        <EmptyNote>
          This company has no chart of accounts yet, so there is nothing to post to. Seed the
          department with <code>npm run seed:finance-config</code> in platform-nest first.
        </EmptyNote>
      ) : (
        <JournalEntryForm accounts={accounts} />
      )}

      <Card
        title="The register"
        hint="“Seq” is the entry’s place in the hash chain — a gap means the chain was broken, not that a number was skipped."
      >
        {entries.length === 0 ? (
          <p className="fin-muted">
            Nothing has been posted for this company yet. An empty ledger is a truthful state, not a
            missing one.
          </p>
        ) : (
          <HairlineTable
            columns={[
              { label: "Seq", align: "right" }, { label: "Date" }, { label: "Description" },
              { label: "Kind" }, { label: "Amount", align: "right" }, { label: "" },
            ]}
            rows={entries.map((e) => [
              e.ledgerSequence,
              e.entryDate,
              e.description,
              // `status`, not `kind` — the two are not the same and the difference matters most
              // where it is easiest to miss:
              //   "reversed"  this entry WAS undone; its figures no longer stand
              //   "reversal"  this entry UNDOES another; it exists to cancel one
              // Collapsing them would show a cancelled entry and its canceller identically, and a
              // reader would have to open both to tell which way round it went.
              <StatusBadge
                key={e.id}
                label={e.status === "reversed" ? "archived" : e.status === "reversal" ? "review" : "active"}
              />,
              money(e.totalDebit),
              <Link key={`${e.id}-l`} href={`/finance/journals/${e.id}`}>
                Open
              </Link>,
            ])}
          />
        )}
      </Card>
    </div>
  );
}
