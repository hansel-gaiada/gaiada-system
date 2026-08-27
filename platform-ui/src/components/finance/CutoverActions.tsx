"use client";
import { ConfirmAction } from "@/components/finance/ConfirmAction";
import { commitCutover, closeFiscalYear } from "@/lib/financeActions";

// Committing a cutover, and closing a fiscal year.
//
// Grouped because they are the two acts that move the LINE a company's figures are measured from —
// one at the beginning of its life in this system, one at the end of each year. Neither can be
// undone by an ordinary correction.
export function CommitCutoverAction({
  cutoverId, cutoverDate, status, ready, blockerCount, readinessUnknown,
}: {
  cutoverId: string;
  cutoverDate: string;
  status: string;
  ready: boolean;
  blockerCount: number;
  readinessUnknown: boolean;
}) {
  const committed = status !== "draft";
  return (
    <ConfirmAction
      // The DATE, not an id or a label. It is the line every figure the company ever reports is
      // measured from, so it is the thing worth having read before committing.
      expected={cutoverDate}
      expectedLabel="cutover date"
      consequence={
        "Posts the opening journal and locks every period before this date. Every figure this "
        + "company reports afterwards is measured from that line, and there is no second cutover — "
        + "a correction later is an ordinary journal, not a re-opening."
      }
      actionLabel="Commit this cutover"
      disabledNote={
        committed
          ? `This cutover was already committed (${status}). A cutover happens once.`
          : readinessUnknown
            ? "Readiness could not be read, so the gate cannot be evaluated. That is not the same as ready."
            : !ready
              ? `${blockerCount} blocker(s) above must be resolved first. An unbalanced opening is reported, never plugged — the difference is real and belongs somewhere specific.`
              : null
      }
      run={({ confirm }) => commitCutover(cutoverId, { confirm })}
    />
  );
}

export function CloseFiscalYearAction({
  fiscalYearId, fiscalYearCode, openPeriods,
}: {
  fiscalYearId: string;
  fiscalYearCode: string;
  /** A year with any period still OPEN is refused by the close engine. Disabling here BEFORE a
   *  confirmation is typed — rather than letting the reader learn it from a refusal after — mirrors
   *  the HARD_LOCK note on reopening a period. */
  openPeriods: number;
}) {
  return (
    <ConfirmAction
      expected={fiscalYearCode}
      expectedLabel="fiscal year"
      consequence={
        "Rolls this year's result into RETAINED earnings (3300) and posts the closing journal. "
        + "Deliberately not 3200, the current-year result account — keeping them separate is what "
        + "lets next year's profit start from zero while the accumulated figure keeps its history."
      }
      actionLabel="Close this fiscal year"
      disabledNote={
        openPeriods > 0
          ? `${openPeriods} period(s) in ${fiscalYearCode} are still open. A year with an open period inside it is not closeable — close or lock each one first (see the periods table above).`
          : null
      }
      run={({ confirm }) => closeFiscalYear(fiscalYearId, { confirm })}
    />
  );
}
