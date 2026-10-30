import { turnBudgetLine, type TurnBudget } from "@/lib/aiBudget";

// AIP-18 (BFF §66.11) — the soft stop's one quiet line under a reply: "You have reached today's AI allowance. Replies continue in a lighter mode until
// <time>." or "Your department has reached its AI budget for <Month>. Replies continue in a lighter mode." Never a modal, never blocking the composer, and no
// number in it. The reset time is said in the viewer's own time zone with UTC beside it, so the text depends on the browser: the line is only drawn from a
// message the client has already fetched (or a live frame), never from server-rendered HTML, and `suppressHydrationWarning` covers the one case where it is.
export function TurnBudgetLine({ budget }: { budget: TurnBudget }) {
  return (
    <p className="asst-msg__budget" role="note" data-kind={budget.kind}>
      <span suppressHydrationWarning>{turnBudgetLine(budget)}</span>
    </p>
  );
}
