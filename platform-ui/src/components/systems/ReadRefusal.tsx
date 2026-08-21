import { Card } from "@/components/ui";
import "./systems.css";

/**
 * ── THE THIRD STATE THIS SUITE WAS MISSING ───────────────────────────────────────────────────────
 *
 * Two neighbours already exist and neither means this:
 *   `EmptyNote`       — connected, read succeeded, genuinely nothing here.
 *   `ConnectionState` — this backend admin API is not wired up yet.
 *
 * Neither can say "you were refused" or "nobody can tell right now", so every surface that needed to
 * say it wrote its own prose: the IT-accounts page, the pipeline run page's `projectRefused` branch,
 * the provisioned-sites reader. That is the plan's action item 4 — "one component rendering a typed
 * deny reason, reused wherever authorization can fail" — and this is it.
 *
 * ⚠ WHY THE COPY MATTERS AS MUCH AS THE TYPE. The failure this closes is not a crash, it is a
 * CONFIDENT WRONG ANSWER: a denied read rendered as "nothing found". So the wording of `unavailable`
 * says, in as many words, that it is NOT a statement about contents. Shorten that at your peril — the
 * live incident behind criterion 5 was a portal page cheerfully reporting "your kickoff is being
 * processed" to staff who simply were not allowed to read it.
 *
 * `forbidden` deliberately does NOT hedge about existence. Telling a viewer "this may or may not
 * exist" leaks nothing useful and reads as evasion; "you don't have access" is the honest sentence,
 * and the pipeline page's existing copy ("it exists — ask an admin") is kept available via `detail`
 * for the cases where the caller already knows the row is there.
 */
export function ReadRefusal({
  /** What could not be read, in the page's own words: "account provisioning", "this person's tasks". */
  subject,
  kind,
  /** `unavailable` only: the backend's own message. Shown quietly, never as the headline. */
  reason,
  /** Optional extra sentence — e.g. who to ask, or that the row is known to exist. */
  detail,
  /** Inline surfaces (a panel inside a page) render without the Card chrome. */
  inline = false,
}: {
  subject: string;
  kind: "forbidden" | "unavailable";
  reason?: string;
  detail?: string;
  inline?: boolean;
}) {
  const body =
    kind === "forbidden" ? (
      <p className="sys-refusal__copy">
        You don&apos;t have access to {subject}.{detail ? ` ${detail}` : ""}
      </p>
    ) : (
      <>
        <p className="sys-refusal__copy">
          {subject} cannot be read right now, so <strong>this is not a statement that there is nothing
          here</strong> — it is a statement that we cannot tell.
        </p>
        {detail ? <p className="sys-refusal__copy">{detail}</p> : null}
        {reason ? <p className="sys-refusal__reason">{reason}</p> : null}
      </>
    );

  if (inline) return <div className="sys-refusal sys-refusal--inline">{body}</div>;
  return (
    <Card title={kind === "forbidden" ? "Not available to you" : `${subject} unavailable`}>
      <div className="sys-refusal">{body}</div>
    </Card>
  );
}
