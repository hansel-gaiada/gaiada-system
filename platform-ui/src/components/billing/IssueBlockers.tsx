import Link from "next/link";
import { blockerFix } from "@/lib/billingView";
import "./billing-screens.css";

// PV5-09 — every reason an invoice cannot be issued, all at once (design decision 7), each with the place that clears it.
//
// Shown TWICE, on purpose: before anyone clicks (the page reads `GET …/issue-readiness`), and again after a click if the
// server's own re-check inside the issue transaction found something the page did not (the page can be minutes old).
// A plain server-safe component: no state, so the page can render it without shipping it to the browser.
//
// The `code` decides the link, never the message text; a code this UI does not know gets the message and no link.
export function IssueBlockers({ blockers, lead, role, contractsHref }: {
  blockers: { code: string; message: string }[];
  /** The sentence above the list. */
  lead: string;
  /** `alert` when it is the answer to a click (announced at once); none when it is simply on the page. */
  role?: "alert";
  /** DW-10f-3a: where the invoice's contracts are listed (the client's Contracts & billing page), for the three instalment blockers. */
  contractsHref?: string | null;
}) {
  if (blockers.length === 0) return null;
  return (
    <div className="bs-blockers" role={role}>
      <p className="bs-blockers__lead">{lead}</p>
      <ul>
        {blockers.map((b) => {
          const fix = blockerFix(b.code, { contractsHref });
          return (
            <li key={b.code + b.message}>
              {b.message}
              {fix && <Link href={fix.href}>{fix.label}</Link>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
