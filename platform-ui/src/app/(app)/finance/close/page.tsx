import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listPeriods, getCloseReadiness, PERIOD_STATE_LABEL, BLOCKER_LABEL, type FiscalPeriod,
} from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ClosePeriodActions } from "@/components/finance/ClosePeriodActions";

// Period close — the checklist that decides whether a month can be locked.
//
// ── READINESS IS SHOWN PER PERIOD, NOT JUST FOR "NOW" ──────────────────────────────────────────
// The overview carries the current period's readiness. This page exists because closing is rarely
// about the current period: on the 5th of a month the question is whether LAST month can be locked,
// and a page that only ever answered for today would never answer the question actually being
// asked. So the period is in the URL and any open period can be inspected.
//
// ── EVERY BLOCKER IS NAMED, INCLUDING ONES NOBODY HAS LABELLED ─────────────────────────────────
// `BLOCKER_LABEL` turns a machine code into a sentence, and an unknown code falls through to the
// code itself rather than to a friendly default. A blocker nobody has labelled must still be
// legible; inventing text for it would hide what the backend actually said.
export default async function FinanceClosePage({
  searchParams,
}: {
  searchParams: Promise<{ periodId?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const periods = await listPeriods(userId, tenant);
  if (periods == null) return <EmptyNote>You do not have finance access for this company.</EmptyNote>;
  if (periods.length === 0) {
    return <EmptyNote>This company has no fiscal calendar, so there is no period to close.</EmptyNote>;
  }

  const today = new Date().toISOString().slice(0, 10);
  // Default to the most recent period that is still OPEN — the one actually awaiting a close —
  // rather than to the calendar's current period, which on the 5th of a month is not the one anyone
  // is trying to lock.
  const open = periods.filter((p) => p.state === "OPEN");
  const fallback = open[open.length - 1]
    ?? periods.find((p) => p.startDate <= today && p.endDate >= today)
    ?? periods[periods.length - 1];
  const selected: FiscalPeriod =
    periods.find((p) => p.id === sp.periodId) ?? fallback;

  const readiness = await getCloseReadiness(userId, tenant, selected.id);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Period close</h1>
        <p className="fin-page__asof">
          {selected.name} · {selected.startDate} to {selected.endDate} ·{" "}
          {PERIOD_STATE_LABEL[selected.state]}
        </p>
      </header>

      <Card title="Readiness" hint="Every check must pass before a period can be locked. Closing is terminal.">
        <div className="fin-verdict" style={{ marginBottom: 16 }}>
          {readiness == null ? (
            <>
              <StatusBadge label="archived" />
              <span className="fin-verdict__note">
                Readiness could not be read for this period, so whether it can be closed is unknown.
                That is not the same as &ldquo;ready&rdquo;.
              </span>
            </>
          ) : readiness.ready ? (
            <>
              <StatusBadge label="active" />
              <span className="fin-verdict__note">
                Every check passes. This period is ready to be closed.
              </span>
            </>
          ) : (
            <>
              <StatusBadge label="blocked" />
              <span className="fin-verdict__note">
                {readiness.blockers.length} blocker(s). This period cannot be closed until each is
                resolved.
              </span>
            </>
          )}
        </div>

        {readiness && readiness.blockers.length > 0 ? (
          <HairlineTable
            columns={[{ label: "Blocker" }, { label: "Detail" }]}
            rows={readiness.blockers.map((b) => [
              // Unknown codes fall through to the code itself — see the header note.
              BLOCKER_LABEL[b.blocker] ?? b.blocker,
              b.detail,
            ])}
          />
        ) : null}
      </Card>

      <Card title="Periods" hint="Pick a period to check. A closed period is shown for reference and cannot be reopened from here." style={{ marginTop: 22 }}>
        <HairlineTable
          columns={[{ label: "Period" }, { label: "Dates" }, { label: "State" }, { label: "Sign-off" }, { label: "" }]}
          rows={periods.map((p) => [
            p.name,
            `${p.startDate} – ${p.endDate}`,
            PERIOD_STATE_LABEL[p.state],
            // "Not signed off" rather than a blank: an empty cell reads as unknown, and sign-off is
            // one of the blockers, so its absence is a fact worth stating.
            p.signedOff ? "signed off" : "not signed off",
            p.id === selected.id
              ? "viewing"
              : <Link key={p.id} href={`/finance/close?periodId=${p.id}`}>check</Link>,
          ])}
        />
      </Card>

      <Card title="Sign off and close" style={{ marginTop: 22 }}>
        <ClosePeriodActions
          periodId={selected.id}
          periodName={selected.name}
          state={selected.state}
          signedOff={selected.signedOff}
          ready={readiness?.ready ?? false}
          blockerCount={readiness?.blockers.length ?? 0}
          readinessUnknown={readiness == null}
        />
      </Card>

      <Card title="Reopening, and what is still not built" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          A soft-locked period can be reopened by someone holding the <code>reopen</code> grant,
          which company administrators deliberately do not have. A hard lock is the audit boundary
          and has no reopen path at all — that is what makes it worth a separate action rather than
          a checkbox on this one.
        </p>
        <p className="fin-muted">
          Reopening is not exposed here yet. Neither is editing the close checklist; the readiness
          gate above computes it, and a hand-editable checklist beside a computed gate would give two
          answers to the same question.
        </p>
      </Card>
    </div>
  );
}
