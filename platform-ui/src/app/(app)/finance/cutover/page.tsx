import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listCutovers, getCutoverReadiness, getOpeningBalances, money } from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// Cutover — the opening balances a company starts its books with.
//
// ── AN UNBALANCED OPENING IS REPORTED, NEVER PLUGGED ───────────────────────────────────────────
// The temptation when opening balances do not balance is a suspense account. It makes the books
// balance immediately and leaves a wrong figure sitting in the accounts to be amortised into
// something years later, by which time nobody remembers what it was. The readiness gate refuses the
// cutover instead, and names the difference. That refusal is the feature.
//
// ── THIS IS THE ONE MIGRATION THAT CANNOT BE REDONE ────────────────────────────────────────────
// Committing a cutover posts the opening journal and locks everything before it. Every figure the
// company ever reports is measured from that line, so it is worth being slow about — which is why
// the commit ACTION is deliberately not wired here, only the gate that decides whether it could run.
export default async function FinanceCutoverPage({
  searchParams,
}: {
  searchParams: Promise<{ cutover?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const cutovers = await listCutovers(userId, tenant);
  const selected = sp.cutover ? cutovers.find((c) => c.id === sp.cutover) ?? null : cutovers[0] ?? null;

  const [readiness, opening] = selected
    ? await Promise.all([
        getCutoverReadiness(userId, tenant, selected.id),
        getOpeningBalances(userId, tenant, selected.id),
      ])
    : [null, null];

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Cutover</h1>
        <p className="fin-page__asof">
          {selected ? `Opening balances as at ${selected.cutoverDate} · ${selected.status}` : "No cutover recorded"}
        </p>
      </header>

      <Card title="Cutovers" hint="The line a company's books begin from. Normally exactly one, and only ever committed once.">
        {cutovers.length === 0 ? (
          <EmptyNote>
            No cutover is recorded for this company. A company that has always kept its books in this
            system does not need one — a cutover exists to carry balances in from whatever came
            before, and its absence here means nothing was carried in.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "As at" }, { label: "Status" }, { label: "Lines", align: "right" },
              { label: "Committed" }, { label: "" },
            ]}
            rows={cutovers.map((c) => [
              c.cutoverDate,
              c.status,
              String(c.lineCount),
              c.committedAt ? String(c.committedAt).slice(0, 10) : "not committed",
              c.id === selected?.id ? "viewing" : <a key={c.id} href={`/finance/cutover?cutover=${c.id}`}>open</a>,
            ])}
          />
        )}
      </Card>

      {selected ? (
        <>
          <Card title="Readiness" style={{ marginTop: 22 }}>
            <div className="fin-verdict">
              {readiness == null ? (
                <>
                  <StatusBadge label="archived" />
                  <span className="fin-verdict__note">
                    Readiness could not be read. That is not the same as ready.
                  </span>
                </>
              ) : readiness.ready ? (
                <>
                  <StatusBadge label="active" />
                  <span className="fin-verdict__note">
                    Every check passes — this cutover could be committed.
                  </span>
                </>
              ) : (
                <>
                  <StatusBadge label="blocked" />
                  <span className="fin-verdict__note">
                    {readiness.blockers.length} blocker(s). An unbalanced opening is reported here,
                    never plugged into a suspense account.
                  </span>
                </>
              )}
            </div>
            {readiness && readiness.blockers.length > 0 ? (
              <HairlineTable
                columns={[{ label: "Blocker" }, { label: "Detail" }]}
                rows={readiness.blockers.map((b) => [b.blocker, b.detail])}
              />
            ) : null}
          </Card>

          <Card title="Opening balances" style={{ marginTop: 22 }}>
            {opening == null ? (
              <EmptyNote>The opening balances could not be read for this cutover.</EmptyNote>
            ) : opening.rows.length === 0 ? (
              <EmptyNote>
                This cutover has no lines yet. An empty cutover is a placeholder, not a zeroed opening.
              </EmptyNote>
            ) : (
              <>
                <div className="fin-verdict" style={{ marginBottom: 16 }}>
                  <StatusBadge label={opening.balanced ? "active" : "blocked"} />
                  <span className="fin-verdict__note">
                    {opening.balanced
                      ? `Debits equal credits at ${money(opening.totalDebit)}.`
                      : `DOES NOT BALANCE — debits ${money(opening.totalDebit)} against credits ${money(opening.totalCredit)}.`}
                  </span>
                </div>
                <HairlineTable
                  columns={[
                    { label: "Code" }, { label: "Account" },
                    { label: "Debit", align: "right" }, { label: "Credit", align: "right" },
                    { label: "Memo" },
                  ]}
                  rows={opening.rows.map((r) => [
                    r.accountCode,
                    // A code with no matching account is a REAL state the readiness gate reports, so
                    // it is shown as such rather than hidden by dropping the row.
                    r.accountName ?? "⚠ no such account in the chart",
                    Number(r.debit) ? money(r.debit) : "—",
                    Number(r.credit) ? money(r.credit) : "—",
                    r.memo ?? "—",
                  ])}
                />
              </>
            )}
          </Card>
        </>
      ) : null}

      <Card title="Committing, and the year-end close" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Committing a cutover is <strong>not wired here</strong>, deliberately. It posts the opening
          journal and locks everything before it — every figure the company ever reports is measured
          from that line, and it cannot be redone. The gate above is live; the button is the cautious
          part.
        </p>
        <p className="fin-muted">
          The year-end close (rolling the year&rsquo;s result into retained earnings) is implemented
          in the engine and likewise not exposed. It rolls into a dedicated retained-earnings account
          rather than into the current-year result account, so the two never merge.
        </p>
      </Card>
    </div>
  );
}
