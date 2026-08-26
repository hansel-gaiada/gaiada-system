"use client";
import { ConfirmAction } from "@/components/finance/ConfirmAction";
import { signOffPeriod, closePeriod } from "@/lib/financeActions";

// Sign-off and close, in the order they actually happen.
//
// ── TWO ACTS, NOT ONE BUTTON WITH TWO EFFECTS ──────────────────────────────────────────────────
// Signing off is the accountant's assertion that the books are right. Closing is the operational
// act that stops the ledger accepting entries dated inside the period. They are separate because
// `NO_ACCOUNTANT_SIGNOFF` is an INPUT to the close gate: sign-off is one of the things readiness
// checks for, so collapsing them would mean the gate checked a condition the same click had just
// satisfied — a check that can never fail is not a check.
//
// It also means signing off a period whose subledgers do not tie is possible (and sometimes
// correct — you assert what you know and then go fix the tie-out), while CLOSING one is not.
export function ClosePeriodActions({
  periodId, periodName, state, signedOff, ready, blockerCount, readinessUnknown,
}: {
  periodId: string;
  periodName: string;
  state: string;
  signedOff: boolean;
  ready: boolean;
  blockerCount: number;
  readinessUnknown: boolean;
}) {
  const closed = state !== "OPEN";

  return (
    <div style={{ display: "grid", gap: 26 }}>
      <section>
        <h3 style={{ margin: "0 0 8px" }}>1 · Sign off</h3>
        <ConfirmAction
          expected={periodName}
          expectedLabel="period"
          consequence={
            "Records that you assert this period's books are right. It does not lock anything — "
            + "sign-off is one of the conditions the close gate checks, not the close itself."
          }
          actionLabel="Sign off this period"
          disabledNote={
            signedOff
              ? `${periodName} is already signed off.`
              : closed
                ? `${periodName} is ${state === "HARD_LOCK" ? "hard-locked" : "closed"} — signing off afterwards would assert nothing.`
                : null
          }
          run={({ confirm }) => signOffPeriod(periodId, { confirm })}
        />
      </section>

      <section>
        <h3 style={{ margin: "0 0 8px" }}>2 · Close</h3>
        <ConfirmAction
          expected={periodName}
          expectedLabel="period"
          consequence={
            "The ledger stops accepting entries dated inside this period. A correction afterwards "
            + "must be posted in a later period, which is what closing is for. Reversible by someone "
            + "holding the reopen grant — company administrators do not have it."
          }
          actionLabel="Close this period (soft lock)"
          requireReason
          reasonHint="e.g. month-end close, reviewed with the controller"
          disabledNote={
            closed
              ? `${periodName} is already ${state === "HARD_LOCK" ? "hard-locked" : "closed"}.`
              : readinessUnknown
                ? "Readiness could not be read for this period, so the close gate cannot be evaluated. That is not the same as ready."
                : !ready
                  ? `${blockerCount} blocker(s) above must be resolved first. The server re-checks this at the moment you close, so clearing them here is what unlocks it — not reloading the page.`
                  : null
          }
          run={({ confirm, reason }) => closePeriod(periodId, { confirm, reason })}
        />
      </section>

      {/* Hard lock is offered ONLY once the period is soft-locked. Presenting both at once would
          invite someone to skip straight to the irreversible one, and the soft lock exists
          precisely so the routine monthly act is the recoverable one. */}
      {state === "SOFT_LOCK" ? (
        <section>
          <h3 style={{ margin: "0 0 8px" }}>3 · Hard lock</h3>
          <ConfirmAction
            expected={periodName}
            expectedLabel="period"
            consequence={
              "Makes this period the audit boundary. There is no reopen path from a hard lock — not "
              + "for administrators, not for the owner. Do this when the period has been reported "
              + "externally and must never move again."
            }
            actionLabel="Hard lock this period"
            requireReason
            reasonHint="e.g. filed with the bank pack, 2026 Q3"
            run={({ confirm, reason }) => closePeriod(periodId, { confirm, reason, hard: true })}
          />
        </section>
      ) : null}
    </div>
  );
}
