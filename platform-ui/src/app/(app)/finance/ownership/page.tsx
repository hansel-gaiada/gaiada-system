import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listOwnership, OWNERSHIP_PROBLEM_LABEL, type OwnershipEdge } from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { OwnershipEditor } from "@/components/finance/OwnershipEditor";

// UI-01c — the cap table.
//
// ── THIS PAGE IS ABOUT AUTHORIZATION, NOT ACCOUNTING ────────────────────────────────────────────
// An ownership edge is what `finance_owner_company_ids()` resolves a person's VISIBILITY from, and a
// `holding` edge reaches every descendant company. So this is the surface where somebody grants
// somebody else sight of the group — which is why it sits behind its own Cerbos kind
// (`finance_ownership`) rather than the accounting vocabulary, and why a finance manager can read
// it but not write it.
//
// ── PROBLEMS ARE RENDERED BESIDE THE ROWS, NOT BEHIND A TAB ────────────────────────────────────
// The BFF returns `problems` WITH `edges` for exactly this reason. A cap table that totals 85% or
// 140% has to say so where it is read. Putting the warnings anywhere else means the common case —
// glance at the table, believe it — shows a register that looks authoritative and is not.
//
// ── AND AN INCOMPLETE TABLE IS NOT AN ERROR ────────────────────────────────────────────────────
// A partially-recorded cap table is the normal state of a real one; minority holders are often
// unknown to the group. So STAKE_INCOMPLETE renders as a NOTE, while STAKE_EXCEEDS_100 renders as a
// problem — the same figure treated differently because one is ignorance and the other is wrong.

function stake(e: OwnershipEdge): string {
  // An unknown stake is shown as unknown. A fabricated 0 or 100 would be worse than an honest gap,
  // and the database stores NULL for precisely that reason.
  if (e.stakePct == null) return "not recorded";
  const n = Number(e.stakePct);
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export default async function FinanceOwnershipPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const view = await listOwnership(userId, tenant);

  // `null` is a 403, not an empty register — see lib/finance.ts. Rendering "no owners recorded"
  // here would be an active false statement about the company.
  if (view == null) {
    return (
      <EmptyNote>
        You do not have access to this company&rsquo;s cap table. It is restricted more tightly than
        the rest of finance — an ownership record decides who can see which companies, so it sits
        with company administrators rather than with the accounting team.
      </EmptyNote>
    );
  }

  const live = view.edges.filter((e) => e.effectiveTo == null);
  const ended = view.edges.filter((e) => e.effectiveTo != null);
  const blocking = view.problems.filter((p) => p.problem !== "STAKE_INCOMPLETE");
  const notes = view.problems.filter((p) => p.problem === "STAKE_INCOMPLETE");

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Ownership</h1>
        <p className="fin-page__asof">
          Who holds this company, and from when. A <strong>holding</strong> edge also confers sight
          of every company beneath it.
        </p>
      </header>

      {blocking.length > 0 && (
        <Card title="This cap table has a problem">
          <HairlineTable
            columns={[{ label: "Problem" }, { label: "Detail" }]}
            rows={blocking.map((p) => [OWNERSHIP_PROBLEM_LABEL[p.problem] ?? p.problem, p.detail])}
          />
        </Card>
      )}

      <Card
        title="Current holders"
        hint="A stake shown as “not recorded” is genuinely unknown — it is not zero and it is not a hundred."
      >
        {live.length === 0 ? (
          <p className="fin-muted">No current ownership is recorded for this company.</p>
        ) : (
          <HairlineTable
            columns={[
              { label: "Holder" }, { label: "Type" }, { label: "Edge" },
              { label: "Stake", align: "right" }, { label: "From" },
            ]}
            rows={live.map((e) => [
              e.holderName ?? "(unnamed)",
              e.holderKind === "person" ? "Person" : "Company",
              // The distinction that matters: `holding` carries transitive reach, `shareholder`
              // does not. Shown as a badge rather than buried, because it is the whole difference
              // between "owns a slice of this" and "can see everything under this".
              <StatusBadge key={e.id} label={e.kind === "holding" ? "active" : "review"} />,
              stake(e),
              e.effectiveFrom,
            ])}
          />
        )}
        {notes.map((n) => (
          <p className="fin-muted" key={n.problem}>
            {n.detail}
          </p>
        ))}
      </Card>

      <OwnershipEditor />

      {ended.length > 0 && (
        <Card
          title="Past holders"
          hint="Ownership is end-dated, never deleted — last year’s statements were true under last year’s cap table."
        >
          <HairlineTable
            columns={[{ label: "Holder" }, { label: "Stake", align: "right" }, { label: "From" }, { label: "Until" }]}
            rows={ended.map((e) => [e.holderName ?? "(unnamed)", stake(e), e.effectiveFrom, e.effectiveTo ?? "—"])}
          />
        </Card>
      )}
    </div>
  );
}
