import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listConsolidationRuns, getConsolidatedTrialBalance, getConsolidationCompleteness, money,
} from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { CreateConsolidationRunForm, GenerateEliminationsAction } from "@/components/finance/ConsolidationActions";

// Consolidation — the group's trial balance, and what a run has not yet addressed.
//
// ── A SUM OF THE MEMBERS IS NOT A CONSOLIDATION ────────────────────────────────────────────────
// This is the distinction the whole surface exists to hold. Adding up the subsidiaries gives a
// legitimate number — but if the parent invoiced the subsidiary, that revenue is in both books, and
// the sum reports it twice. Consolidation is the sum MINUS the eliminations.
//
// The SQL function refuses to return a consolidated trial balance for a run with no elimination
// entries, and that refusal is deliberate: serving a bare sum under the name "consolidated" is
// exactly how a group overstates its revenue. This page surfaces the refusal rather than falling
// back to the sum, because a plausible wrong total here reaches a bank.
//
// ── "NOT APPLICABLE" AND "NEVER CONSIDERED" LOOK IDENTICAL IN A WORKING PAPER ──────────────────
// Which is why completeness notes are shown beside the figures rather than behind them. A run that
// has not addressed NCI is not wrong yet — it is unfinished, and only the person doing the work can
// tell the difference.
export default async function FinanceConsolidationPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const runs = await listConsolidationRuns(userId, tenant);
  const selected = sp.run ? runs.find((r) => r.id === sp.run) ?? null : runs[0] ?? null;

  // `financeData` degrades a 403/404 to null. A run whose eliminations are missing is refused with a
  // 409, which does NOT degrade — it propagates, and that is intended: the alternative is rendering
  // an unconsolidated sum under a consolidated heading.
  const [tb, completeness] = selected
    ? await Promise.all([
        getConsolidatedTrialBalance(userId, tenant, selected.id).catch(() => null),
        getConsolidationCompleteness(userId, tenant, selected.id).catch(() => null),
      ])
    : [null, null];

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Consolidation</h1>
        <p className="fin-page__asof">
          {selected ? `${selected.label ?? "Run"} · as at ${selected.asOf}` : "No consolidation run selected"}
        </p>
      </header>

      <Card title="Runs" hint="A run is a dated working paper: the members summed, then the eliminations applied.">
        {runs.length === 0 ? (
          <EmptyNote>
            No consolidation run exists for this company. That is expected unless it is a parent with
            subsidiaries — consolidation is a group activity, and a company with no members has
            nothing to consolidate.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "As at" }, { label: "Label" }, { label: "Eliminations", align: "right" }, { label: "" }]}
            rows={runs.map((r) => [
              r.asOf,
              r.label ?? "—",
              String(r.entryCount),
              r.id === selected?.id ? "viewing" : <a key={r.id} href={`/finance/consolidation?run=${r.id}`}>open</a>,
            ])}
          />
        )}
      </Card>

      <div style={{ marginTop: 22 }}>
        <CreateConsolidationRunForm />
      </div>

      {selected ? (
        <>
          <GenerateEliminationsAction runId={selected.id} entryCount={selected.entryCount} />

          <Card title="Consolidated trial balance" style={{ marginTop: 22 }}>
            {tb == null ? (
              <EmptyNote>
                {selected.entryCount === 0
                  ? "This run has no elimination entries, so a consolidated trial balance is REFUSED — deliberately. Summing the members without eliminating intercompany would report the group's internal trading as external revenue. Record the eliminations first."
                  : "The consolidated trial balance could not be read for this run."}
              </EmptyNote>
            ) : (
              <>
                <div className="fin-verdict" style={{ marginBottom: 16 }}>
                  <StatusBadge label={tb.balanced ? "active" : "blocked"} />
                  <span className="fin-verdict__note">
                    {tb.balanced
                      ? `Debits equal credits at ${money(tb.totalDebit)}.`
                      : `OUT OF BALANCE — debits ${money(tb.totalDebit)} against credits ${money(tb.totalCredit)}.`}
                  </span>
                </div>
                <HairlineTable
                  columns={[
                    { label: "Code" }, { label: "Account" }, { label: "Type" },
                    { label: "Debit", align: "right" }, { label: "Credit", align: "right" },
                  ]}
                  rows={tb.rows.map((r) => [
                    r.accountCode, r.accountName, r.accountType,
                    Number(r.debit) ? money(r.debit) : "—",
                    Number(r.credit) ? money(r.credit) : "—",
                  ])}
                />
              </>
            )}
          </Card>

          <Card
            title="What this run has not addressed"
            hint="Unfinished is not the same as wrong — but only the person doing the work can tell them apart, so the gaps are named."
            style={{ marginTop: 22 }}
          >
            {completeness == null ? (
              <EmptyNote>The completeness check could not be read for this run.</EmptyNote>
            ) : completeness.complete ? (
              <div className="fin-verdict">
                <StatusBadge label="active" />
                <span className="fin-verdict__note">
                  Nothing outstanding — every item this check knows about has been considered.
                </span>
              </div>
            ) : (
              <>
                <div className="fin-verdict" style={{ marginBottom: 16 }}>
                  <StatusBadge label="review" />
                  <span className="fin-verdict__note">
                    {completeness.notes.length} item(s) not yet addressed by this run.
                  </span>
                </div>
                <HairlineTable
                  columns={[{ label: "Not addressed" }, { label: "Detail" }]}
                  rows={completeness.notes.map((n) => [n.note, n.detail])}
                />
              </>
            )}
          </Card>
        </>
      ) : null}

      <Card title="What is not built here" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Creating a run and generating its intercompany eliminations are wired above. Recording a
          manual consolidation adjustment is not — non-controlling interests (PSAK 65) and the equity
          method (PSAK 15) still require one, and it is implemented in the engine but has no endpoint
          or form here yet.
        </p>
        <p className="fin-muted">
          DEMO_MODE note: this fixture store is not stateful (see <code>lib/demoFinance.ts</code>) —
          a run created above will not appear in the &ldquo;Runs&rdquo; table in the browser demo,
          though the write itself, and its validation, is real and reachable.
        </p>
      </Card>
    </div>
  );
}
