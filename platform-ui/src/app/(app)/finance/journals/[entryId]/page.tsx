import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getJournal, money } from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReverseJournalForm } from "@/components/finance/ReverseJournalForm";

// One journal entry, in full.
//
// ── THE HASH IS SHOWN ON PURPOSE ───────────────────────────────────────────────────────────────
// `entryHash` is not decoration and not a database id. It is this entry's link in the chain that
// `finance_ledger_verify` walks: each entry's hash covers its own contents AND its predecessor, so
// altering any posted figure breaks every hash after it. Showing it is what lets a person confirm
// that the entry in front of them is the entry that was posted.
//
// It is displayed in full rather than truncated. A shortened hash is comparable only by eye, and
// the whole point is that it can be compared exactly.
export default async function JournalDetailPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const entry = await getJournal(userId, tenant, entryId);
  if (!entry) {
    return (
      <EmptyNote>
        No journal entry with that id in this company. It may belong to a different company — check
        the company selector in the top bar.
      </EmptyNote>
    );
  }

  const balanced = Number(entry.totalDebit) === Number(entry.totalCredit);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>
          <Link href="/finance/journals">Journals</Link> · #{entry.ledgerSequence}
        </Eyebrow>
        <h1 className="fin-page__title">
          {entry.description}{" "}
          <StatusBadge
            label={entry.status === "reversed" ? "archived" : entry.status === "reversal" ? "review" : "active"}
          />
        </h1>
        <p className="fin-page__asof">
          {entry.entryDate} · {entry.currency} · reference <code>{entry.sourceEventId}</code>
        </p>
      </header>

      {entry.status === "reversed" && (
        <Card title="This entry has been reversed">
          <p className="fin-muted">
            Its figures no longer stand. The reversing entry is a separate row in the register — both
            remain, because an auditor must be able to see that a correction happened rather than
            find a gap where an entry used to be.
          </p>
        </Card>
      )}
      {entry.status === "reversal" && entry.reversalReason && (
        <Card title="Why this reversal was posted">
          <p>{entry.reversalReason}</p>
        </Card>
      )}

      <Card title="Lines">
        <HairlineTable
          columns={[
            { label: "#", align: "right" }, { label: "Account" }, { label: "Memo" },
            { label: "Debit", align: "right" }, { label: "Credit", align: "right" },
          ]}
          rows={[
            ...entry.lines.map((l) => [
              l.lineNo,
              `${l.accountCode} — ${l.accountName}`,
              l.memo ?? "",
              l.side === "debit" ? money(l.amount, entry.currency) : "",
              l.side === "credit" ? money(l.amount, entry.currency) : "",
            ]),
            [
              "",
              "Total",
              // Every posted entry balances by construction — the database refuses otherwise — so
              // this is a restatement, not a check. It is shown because an accountant reading a
              // journal expects to see the totals, and their absence reads as an omission.
              balanced ? "" : "DOES NOT BALANCE",
              money(entry.totalDebit, entry.currency),
              money(entry.totalCredit, entry.currency),
            ],
          ]}
        />
      </Card>

      <Card
        title="Chain"
        hint="Each entry’s hash covers its contents and its predecessor, so altering a posted figure breaks every hash after it."
      >
        <p className="fin-hash">
          <code>{entry.entryHash}</code>
        </p>
      </Card>

      {/* Reversal is offered only where it is possible. An already-reversed entry cannot be reversed
          again — the database refuses it — and rendering a button that always fails teaches people
          to ignore error messages. */}
      {entry.status === "posted" && <ReverseJournalForm entryId={entry.id} />}
    </div>
  );
}
