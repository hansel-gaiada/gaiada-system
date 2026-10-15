"use client";
import { Field } from "@/components/forms/Field";
import type { PolicyResult } from "@/lib/hrPolicyActions";
import { CYCLE_KINDS, CYCLE_STATUSES, PARTICIPANT_STATUSES, PARTICIPANT_OUTCOMES } from "@/lib/hrPolicy";
import { fullRow, dimStyle } from "./RecruitmentBits";
import { FormShell, type Option, type PolicyFormApi } from "./PolicyFormShell";

// The review-cycle write forms (DW-7f-4). Appraisal content is not written here: a participant links OUT to its
// appraisal and the reports program owns that. Everything below sends ids as USER ids, which is what the server keys
// participants and reviewers on.

export type CycleInitial = { name: string; status: string; opensOn: string | null; closesOn: string | null };

// ---- Create a cycle ----
export function ReviewCycleForm({ tenantId, action }: { tenantId: string; action: PolicyFormApi }) {
  return (
    <FormShell title="New review cycle" openLabel="New review cycle" submitLabel="Create cycle" pendingLabel="Creating…"
      tenantId={tenantId} action={action}
      intro="A cycle starts as a draft. The period is what is being reviewed; the window is when the reviews must be completed.">
      <Field name="name" label="Name" required hint="For example: 2026 H2 performance review" />
      <Field name="kind" label="Kind" type="select" options={[...CYCLE_KINDS]} defaultValue="periodic" required
        hint="Probation cycles record a pass, extend or fail verdict" />
      <Field name="periodStart" label="Period start" type="date" required />
      <Field name="periodEnd" label="Period end" type="date" required />
      <Field name="opensOn" label="Window opens" type="date" hint="Optional" />
      <Field name="closesOn" label="Window closes" type="date" hint="Optional" />
    </FormShell>
  );
}

// ---- Edit a cycle ----
export function ReviewCycleEditForm({ tenantId, cycleId, initial, action }: {
  tenantId: string;
  cycleId: string;
  initial: CycleInitial;
  action: (tenantId: string, cycleId: string, formData: FormData) => Promise<PolicyResult>;
}) {
  return (
    <FormShell title="Edit review cycle" openLabel="Edit cycle" submitLabel="Save cycle" pendingLabel="Saving…" secondary
      tenantId={tenantId} action={(t, fd) => action(t, cycleId, fd)} closeOnSuccess
      intro="The period and the kind are fixed when a cycle is created. Any status can be set from any other; the server does not enforce an order. A blank date clears it.">
      <Field name="name" label="Name" required defaultValue={initial.name} />
      <Field name="status" label="Status" type="select" options={[...CYCLE_STATUSES]} defaultValue={initial.status} required />
      <Field name="opensOn" label="Window opens" type="date" defaultValue={initial.opensOn ?? ""} />
      <Field name="closesOn" label="Window closes" type="date" defaultValue={initial.closesOn ?? ""} />
    </FormShell>
  );
}

// ---- Add participants ----
export function ParticipantsAddForm({ tenantId, cycleId, people, reviewers, excluded, action }: {
  tenantId: string;
  cycleId: string;
  /** Who can be added: employees with a login account who are not already in the cycle. Values are USER ids. */
  people: Option[];
  /** Who can review: employees with a login account. Values are USER ids. */
  reviewers: Option[];
  /** How many employees were left out because they have no login account. */
  excluded: number;
  action: (tenantId: string, cycleId: string, formData: FormData) => Promise<PolicyResult>;
}) {
  return (
    <FormShell title="Add participants" openLabel="Add participants" submitLabel="Add to cycle" pendingLabel="Adding…"
      tenantId={tenantId} action={(t, fd) => action(t, cycleId, fd)}
      intro="Tick everyone to add. The reviewer and due date below apply to all of them; leave the reviewer blank to assign it later.">
      <fieldset style={{ ...fullRow, margin: 0, padding: 8, border: "1px solid var(--erp-line)", borderRadius: 8, display: "grid", gap: 6, maxHeight: 220, overflowY: "auto" }}>
        <legend style={{ font: "400 12px var(--font-body)", padding: "0 4px" }}>People to add</legend>
        {people.length === 0 ? (
          <span style={dimStyle}>Nobody left to add: everyone with a login account is already in this cycle.</span>
        ) : people.map((p) => (
          <label key={p.value} style={{ display: "flex", gap: 8, alignItems: "center", font: "400 13px var(--font-body)" }}>
            <input type="checkbox" name="subjectUserId" value={p.value} />
            <span>{p.label}</span>
          </label>
        ))}
      </fieldset>
      {excluded > 0 && (
        <p style={{ margin: 0, ...fullRow, ...dimStyle }}>
          {excluded} {excluded === 1 ? "employee has" : "employees have"} no login account and cannot be added: a review is
          keyed to a user.
        </p>
      )}
      <Field name="reviewerUserId" label="Reviewer" type="select" optionItems={reviewers} placeholder="Assign later" />
      <Field name="dueOn" label="Due on" type="date" hint="Optional" />
    </FormShell>
  );
}

// ---- Update a participant ----
export function ParticipantUpdateForm({ tenantId, participants, reviewers, showOutcome, action }: {
  tenantId: string;
  /** The cycle's participants, as a value (participant id) and a label. */
  participants: Option[];
  reviewers: Option[];
  /** Probation cycles only: the server records a verdict nowhere else. */
  showOutcome: boolean;
  action: PolicyFormApi;
}) {
  return (
    <FormShell title="Update a participant" openLabel="Update a participant" submitLabel="Save participant" pendingLabel="Saving…" secondary
      tenantId={tenantId} action={action}
      intro="Only what you fill in is changed; a blank field is left as it is. Setting the status to submitted records the submission time. Appraisal scores and packs live in the reports program, not here.">
      <Field name="participantId" label="Participant" type="select" required placeholder="Select a participant…" optionItems={participants} />
      <Field name="status" label="Status" type="select" options={[...PARTICIPANT_STATUSES]} placeholder="Leave as is" />
      <Field name="reviewerUserId" label="Reviewer" type="select" optionItems={reviewers} placeholder="Leave as is" />
      {showOutcome && (
        <>
          <Field name="outcome" label="Outcome" type="select" options={[...PARTICIPANT_OUTCOMES]} placeholder="Leave as is"
            hint="The probation verdict. Extend means a new cycle, not a status change" />
          <Field name="outcomeNote" label="Outcome note" />
        </>
      )}
    </FormShell>
  );
}
