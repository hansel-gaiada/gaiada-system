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
// ── EVERY TAB IN THE STRIP NOW HAS A PAGE ──────────────────────────────────────────────────────
// This map used to carry five entries — chart of accounts, receivables, payables, tax and period
// close. All five are built, so their entries are gone: a "not built yet" description sitting
// beside a page that exists is worse than no description, because it is confidently wrong and the
// reader has no way to know which of the two to believe.
//
// The route stays. It catches a MISTYPED or STALE `/finance/<something>` path and says plainly that
// there is no such page, rather than 404ing — a 404 reads as "the app is broken" and gives the
// reader nothing to do next. If a future tab ships in the strip before its page exists, add it back
// here with what already works behind it and what is missing.
const PLANNED: Record<string, { title: string; state: string; detail: string }> = {};

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
