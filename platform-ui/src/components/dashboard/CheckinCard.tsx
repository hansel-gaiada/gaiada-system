"use client";
import { useState, useTransition, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import type { CheckinToday, SelfComplianceSummary } from "@/lib/checkins";
import type { CheckinActionResult } from "@/lib/checkinActions";
import "@/components/forms/forms.css";
import "./dashboard.css";

export type SubmitCheckinAction = (formData: FormData) => Promise<CheckinActionResult>;

// TR-10 — the My Work check-in card. The blueprint's <30s acceptance bar is a product constraint,
// not a nicety (Blueprint §5.3/§6.2 header comment: "if this is a blank textarea, compliance dies
// in week two"), so the MINIMUM path is exactly one click: the textarea already holds the backend's
// live-derived draft (`today.draft.summaryText`, composed server-side from today's time_entries +
// work_activity), so accepting it as-is and clicking "Confirm & submit" is the whole flow. Editing
// first costs one more interaction (focus + type counts as one), so the realistic ceiling is
// edit-then-submit = 2 interactions, both well inside the ticket's ≤3 budget — see the component's
// test file for the exact count asserted.
//
// Four-state honesty (§5.3, standing across this whole program): "already submitted", "excused",
// "not expected" (weekend/holiday/leave), and the default confirm-and-edit form are FOUR distinct
// render branches below — never collapsed. `today.expected` coming back `false` is never treated as
// a miss (there is no "missed" branch here at all — a miss is something a PAST day earns via the
// nightly job, never something today's own card can render, so "today is never shown as missed"
// falls out structurally rather than needing a special case).
export function CheckinCard({ tenantId, today, selfCompliance, submitAction }: {
  tenantId: string;
  today: CheckinToday;
  selfCompliance: SelfComplianceSummary;
  submitAction: SubmitCheckinAction;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ summary: string; blockers: string | null } | null>(
    today.alreadySubmitted && today.existing ? { summary: today.existing.summary, blockers: today.existing.blockers } : null,
  );
  const [editing, setEditing] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await submitAction(formData);
      if (!res.ok) {
        setError(res.error ?? "That didn't go through — try again.");
        return;
      }
      setSubmitted({ summary: res.result?.summary ?? "", blockers: res.result?.blockers ?? null });
      setEditing(false);
    });
  }

  // State 1 of 4: excused. A day a manager/HR has already excused is never re-prompted for
  // submission (the backend 409s a submit against it anyway — see checkinActions.ts) and, per
  // §5.3, is never rendered as if it were a miss.
  if (today.existing?.status === "excused") {
    return (
      <CheckinLine status="Excused" note="Excused by your manager or HR — nothing to submit." s={selfCompliance} />
    );
  }

  // State 2 of 4: already submitted (and not currently re-editing it).
  if (submitted && !editing) {
    return (
      <CheckinLine
        status="Submitted"
        statusTone="submitted"
        note={submitted.summary}
        extra={submitted.blockers ? <span className="checkin-line__blockers"><strong>Blockers:</strong> {submitted.blockers}</span> : null}
        s={selfCompliance}
        action={<button type="button" className="checkin-line__action" onClick={() => setEditing(true)}>Edit</button>}
      />
    );
  }

  // State 3 of 4: not expected today (weekend/holiday/approved leave) — a quiet, distinct state,
  // never the same visual as "missed". Submission is still allowed (the backend doesn't gate on
  // expected-ness), reachable via the explicit "Check in anyway" opt-in.
  if (!today.expected && !forceOpen) {
    return (
      <CheckinLine
        status="Not expected today"
        note="Not a working day, or you’re on approved leave."
        s={selfCompliance}
        action={<button type="button" className="checkin-line__action" onClick={() => setForceOpen(true)}>Check in anyway</button>}
      />
    );
  }

  // State 4 of 4: the confirm-and-edit form (the common case) — prefilled and visibly a prefill.
  const initialSummary = editing && submitted ? submitted.summary : today.draft.summaryText;
  const initialBlockers = editing && submitted ? (submitted.blockers ?? "") : "";

  return (
    <Card title="Today's check-in" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="checkin-card__form">
        <input type="hidden" name="tenantId" value={tenantId} />
        <p className="checkin-card__prefill-note">
          Drafted from today&rsquo;s logged time and activity — review and edit before submitting, it&rsquo;s not sent yet.
        </p>
        <div className="lux-form-grid" style={{ gridTemplateColumns: "1fr" }}>
          <Field name="summary" label="Summary" type="textarea" defaultValue={initialSummary} required />
          <Field name="blockers" label="Blockers (optional)" type="textarea" defaultValue={initialBlockers} />
        </div>
        {error && <p className="checkin-card__error">{error}</p>}
        <div className="checkin-card__actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Submitting…" : "Confirm & submit"}
          </button>
          {editing && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
          )}
        </div>
      </form>
      <ComplianceStrip s={selfCompliance} />
    </Card>
  );
}

// The three states that need nothing from you — excused, already submitted, not a working day —
// render as ONE LINE, not a card.
//
// They used to be full cards in hero position, so the largest thing on the landing screen was
// usually a panel announcing that nothing was due, while the item that actually needed the user sat
// below it as a small unframed row. TR-10's placement (check-in above the queue, prompted every
// working day) is preserved exactly: state 4 — a check-in that IS due — is still the card. Only the
// idle states shrink, which is what makes the prompt itself stand out when it appears.
function CheckinLine({ status, statusTone, note, extra, action, s }: {
  status: string;
  statusTone?: "submitted";
  note: string;
  extra?: ReactNode;
  action?: ReactNode;
  s: SelfComplianceSummary;
}) {
  return (
    <div className="checkin-line">
      <span className={`checkin-line__pill${statusTone === "submitted" ? " checkin-line__pill--submitted" : ""}`}>{status}</span>
      <span className="checkin-line__note">{note}</span>
      {extra}
      {action}
      <span className="checkin-line__compliance"><ComplianceStrip s={s} /></span>
    </div>
  );
}

function ComplianceStrip({ s }: { s: SelfComplianceSummary }) {
  // Self can never read the official §18 compliance grid (structurally self-⛔, see lib/checkins.ts's
  // header comment) — this strip is built from the self-permitted history read instead, and stays
  // silent rather than showing a misleading "0/0" when there's no history yet.
  if (s.windowDays === 0) return null;
  return (
    <div className="checkin-card__streak">
      {s.currentStreak > 0 && <span className="checkin-card__streak-chip">{s.currentStreak}-day streak</span>}
      {s.rate !== null && (
        <span className="checkin-card__streak-chip checkin-card__streak-chip--quiet">
          {s.submittedCount}/{s.submittedCount + s.missedCount} submitted ({Math.round(s.rate * 100)}%) · last {s.windowDays} tracked days
        </span>
      )}
      {s.excusedCount > 0 && (
        <span className="checkin-card__streak-chip checkin-card__streak-chip--quiet">{s.excusedCount} excused — not counted against you</span>
      )}
    </div>
  );
}
