"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { PolicyResult } from "@/lib/hrPolicyActions";
import {
  WEEKDAYS, HOLIDAY_KINDS, LEAVE_TYPES, ACCRUAL_METHODS, GRADE_TRACKS, RATE_BASES, PARAMETER_UNITS, INITIAL_PARAMETER_ROWS,
  minutesToDayValue,
} from "@/lib/hrPolicy";
import { ResultMessage, fullRow, dimStyle, panelStyle, textStyle, type Msg } from "./RecruitmentBits";
import { FormShell, type Option, type PolicyFormApi } from "./PolicyFormShell";

// The HR settings write forms (DW-7f-5): calendars and holidays, leave policies and their assignments, pay grades and
// statutory parameter sets, plus the two confirmed actions (delete a holiday, ratify a set). Each form sends what the
// person typed to a server action, shows the SERVER's sentence as sent, and re-reads the page after every call. Nothing
// here decides: the page shows a control only to someone whose capability mirror says it is offered.

type IdApi = (tenantId: string, id: string, formData: FormData) => Promise<PolicyResult>;

// ---- Calendar ----
export function CalendarForm({ tenantId, action }: { tenantId: string; action: PolicyFormApi }) {
  return (
    <FormShell title="Add holiday calendar" openLabel="Add calendar" submitLabel="Create calendar" pendingLabel="Creating…"
      tenantId={tenantId} action={action}
      intro="Making a calendar the default demotes the current default. A calendar needs at least one weekend day: the server cannot save one with none.">
      <Field name="name" label="Name" required hint="For example: Indonesia national" />
      <Field name="countryCode" label="Country" defaultValue="ID" hint="2-letter code" />
      <fieldset style={{ ...fullRow, margin: 0, padding: 8, border: "1px solid var(--erp-line)", borderRadius: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <legend style={{ font: "400 12px var(--font-body)", padding: "0 4px" }}>Weekend days</legend>
        {WEEKDAYS.map((d) => (
          <label key={d.value} style={{ display: "flex", gap: 6, alignItems: "center", font: "400 13px var(--font-body)" }}>
            <input type="checkbox" name="weekendDays" value={d.value} defaultChecked={d.value >= 6} />
            <span>{d.label}</span>
          </label>
        ))}
      </fieldset>
      <Field name="isDefault" label="Make this the default calendar" type="boolean" />
    </FormShell>
  );
}

// ---- Holiday ----
export function HolidayForm({ tenantId, calendarId, action }: { tenantId: string; calendarId: string; action: IdApi }) {
  return (
    <FormShell title="Add holiday" openLabel="Add a holiday" submitLabel="Save holiday" pendingLabel="Saving…"
      tenantId={tenantId} action={(t, fd) => action(t, calendarId, fd)}
      intro="A holiday on a date that already has one REPLACES it. Joint leave (cuti bersama) is normally deducted from the leave entitlement; public and company holidays are not.">
      <Field name="day" label="Date" type="date" required />
      <Field name="name" label="Name" required />
      <Field name="kind" label="Kind" type="select" options={[...HOLIDAY_KINDS]} defaultValue="public" required />
      <Field name="deductsEntitlement" label="Deducts from the leave entitlement" type="boolean" defaultValue
        hint="Only used for joint leave" />
    </FormShell>
  );
}

// ---- Delete a holiday (confirmed) ----
export function DeleteHolidayButton({ tenantId, holidayId, holidayLabel, action }: {
  tenantId: string;
  holidayId: string;
  /** "Name on date", used in the confirmation and the button's accessible name. */
  holidayLabel: string;
  action: (tenantId: string, holidayId: string) => Promise<PolicyResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  function remove() {
    startTransition(async () => {
      const res = await action(tenantId, holidayId);
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Holiday deleted." });
        setConfirming(false);
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // either way: after a refusal the view may be stale
    });
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!confirming ? (
        <div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Delete ${holidayLabel}`}
            onClick={() => { setConfirming(true); setMsg(null); }}>
            Delete
          </button>
        </div>
      ) : (
        <div role="group" aria-label={`Confirm deleting ${holidayLabel}`} style={panelStyle}>
          <p style={textStyle}>
            Delete {holidayLabel}? It is removed for good. Leave already charged against it is not restated, and
            working days counted from now on will include that date.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={remove}>
              {pending ? "Deleting…" : "Yes, delete"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <ResultMessage msg={msg} />}
    </div>
  );
}

// ---- Leave policy ----
type PolicyInitial = {
  name: string; leaveType: string; accrualMethod: string; annualEntitlementMinutes: number; waitingPeriodMonths: number;
  prorateFirstYear: boolean; carryoverMaxMinutes: number; carryoverExpiryMonths: number; allowNegativeBalance: boolean;
  excludesHolidays: boolean; escalateOverMinutes: number | null; minNoticeDays: number; isActive: boolean;
};

function PolicyFields({ initial }: { initial?: PolicyInitial }) {
  const d = (m: number | undefined) => (m === undefined ? undefined : minutesToDayValue(m));
  return (
    <>
      <Field name="name" label="Name" required defaultValue={initial?.name} hint="For example: Annual leave" />
      <Field name="accrualMethod" label="Accrual" type="select" options={[...ACCRUAL_METHODS]} required
        defaultValue={initial?.accrualMethod ?? "upfront"} hint="When the entitlement lands" />
      <Field name="annualEntitlementDays" label="Annual entitlement (days)" type="number" step="any" required={!!initial}
        defaultValue={d(initial?.annualEntitlementMinutes)} hint="Working days a year; 480 minutes is one day" />
      <Field name="waitingPeriodMonths" label="Waiting period (months)" type="number" required={!!initial}
        defaultValue={initial?.waitingPeriodMonths} hint="Service needed before any entitlement, 0 to 60" />
      <Field name="carryoverMaxDays" label="Carry-over limit (days)" type="number" step="any" required={!!initial}
        defaultValue={d(initial?.carryoverMaxMinutes)} hint="0 means nothing carries over" />
      <Field name="carryoverExpiryMonths" label="Carry-over expires after (months)" type="number" required={!!initial}
        defaultValue={initial?.carryoverExpiryMonths} hint="0 to 24; 0 means at year end" />
      <Field name="minNoticeDays" label="Minimum notice (days)" type="number" required={!!initial}
        defaultValue={initial?.minNoticeDays} hint="Whole days, 0 or more" />
      <Field name="escalateOverDays" label="Second approver over (days)" type="number" step="any"
        defaultValue={initial?.escalateOverMinutes != null ? minutesToDayValue(initial.escalateOverMinutes) : undefined}
        hint="Blank means a single approval always" />
      <Field name="prorateFirstYear" label="Prorate the first year" type="boolean" defaultValue={initial?.prorateFirstYear ?? true} />
      <Field name="allowNegativeBalance" label="Allow a negative balance" type="boolean" defaultValue={initial?.allowNegativeBalance ?? false} />
      <Field name="excludesHolidays" label="Skip weekends and holidays when counting" type="boolean" defaultValue={initial?.excludesHolidays ?? true} />
    </>
  );
}

export function LeavePolicyForm({ tenantId, action }: { tenantId: string; action: PolicyFormApi }) {
  return (
    <FormShell title="Add leave policy" openLabel="Add leave policy" submitLabel="Create policy" pendingLabel="Creating…"
      tenantId={tenantId} action={action}
      intro="The leave type is fixed once a policy is created. Entitlements are entered in working days and stored by the server in minutes.">
      <Field name="leaveType" label="Leave type" type="select" options={[...LEAVE_TYPES]} required placeholder="Select a type…" />
      <PolicyFields />
    </FormShell>
  );
}

export function LeavePolicyEditForm({ tenantId, policyId, initial, action }: {
  tenantId: string; policyId: string; initial: PolicyInitial; action: IdApi;
}) {
  return (
    <FormShell title="Edit leave policy" openLabel="Edit this policy" submitLabel="Save policy" pendingLabel="Saving…" secondary
      tenantId={tenantId} action={(t, fd) => action(t, policyId, fd)} closeOnSuccess
      intro={`The leave type (${initial.leaveType}) cannot be changed. A change applies to balances from now on; it does not restate what was already accrued.`}>
      <PolicyFields initial={initial} />
      <Field name="isActive" label="Active" type="boolean" defaultValue={initial.isActive} hint="An inactive policy is kept but no longer offered" />
    </FormShell>
  );
}

// ---- Assignment ----
export function AssignmentForm({ tenantId, policyId, people, action }: {
  tenantId: string; policyId: string;
  /** Employees with a login account; values are USER ids. */
  people: Option[];
  action: IdApi;
}) {
  return (
    <FormShell title="Assign leave policy" openLabel="Assign this policy" submitLabel="Assign" pendingLabel="Assigning…"
      tenantId={tenantId} action={(t, fd) => action(t, policyId, fd)}
      intro="Choose who the policy applies to. The most specific assignment for a person wins: a person over their unit over the company default.">
      <Field name="target" label="Applies to" type="select" required defaultValue="tenant"
        optionItems={[
          { value: "tenant", label: "Everyone in the company (default)" },
          { value: "person", label: "One person" },
          { value: "unit", label: "An org unit" },
        ]} />
      <Field name="subjectUserId" label="Person" type="select" optionItems={people} placeholder="Select a person…"
        hint="Used when Applies to is One person" />
      <Field name="unitNodeId" label="Org unit id" hint="Used when Applies to is An org unit: the id of the org-chart node" />
      <Field name="effectiveFrom" label="From" type="date" required />
      <Field name="effectiveTo" label="Until" type="date" hint="Blank means open-ended" />
    </FormShell>
  );
}

// ---- Pay grade ----
export function PayGradeForm({ tenantId, action, defaultCurrency }: { tenantId: string; action: PolicyFormApi; defaultCurrency: string }) {
  return (
    <FormShell title="Add pay grade" openLabel="Add pay grade" submitLabel="Create grade" pendingLabel="Creating…"
      tenantId={tenantId} action={action}
      intro="Once a person is on a grade, the server refuses a salary outside its band. Amounts take up to 2 decimals. Grades are added here, not edited.">
      <Field name="code" label="Code" required hint="For example: E3 or M2; unique" />
      <Field name="name" label="Name" required />
      <Field name="track" label="Track" type="select" options={[...GRADE_TRACKS]} defaultValue="individual" required />
      <Field name="level" label="Level" type="number" hint="Whole number from 1" defaultValue={1} />
      <Field name="minAmount" label="Band minimum" type="number" step="any" required />
      <Field name="midAmount" label="Band midpoint" type="number" step="any" hint="Optional; between the minimum and the maximum" />
      <Field name="maxAmount" label="Band maximum" type="number" step="any" required />
      <Field name="currency" label="Currency" defaultValue={defaultCurrency} hint="3-letter code" />
      <Field name="rateBasis" label="Rate basis" type="select" options={[...RATE_BASES]} defaultValue="monthly" required
        hint="The unit the band is quoted in" />
    </FormShell>
  );
}

// ---- Statutory parameter set ----
function ParameterRows() {
  const [rows, setRows] = useState(INITIAL_PARAMETER_ROWS);
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <fieldset key={i} style={{ ...fullRow, margin: 0, padding: 8, border: "1px solid var(--erp-line)", borderRadius: 8 }}>
          <legend style={{ font: "400 12px var(--font-body)", padding: "0 4px" }}>Parameter {i + 1}</legend>
          <div className="lux-form-grid">
            <Field name="paramKey" label={`Key ${i + 1}`} hint="For example: ptkp.tk0" />
            <Field name="paramValueNum" label={`Number ${i + 1}`} type="number" step="any" hint="Up to 6 decimals; or a JSON value, not both" />
            <Field name="paramValueJson" label={`JSON value ${i + 1}`} type="textarea" hint="For a table, such as brackets" />
            <Field name="paramUnit" label={`Unit ${i + 1}`} type="select" options={[...PARAMETER_UNITS]} placeholder="None" />
            <Field name="paramNote" label={`Note ${i + 1}`} />
          </div>
        </fieldset>
      ))}
      <div style={fullRow}>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setRows((n) => n + 1)}>
          Add a parameter row
        </button>
      </div>
    </>
  );
}

export function ParameterSetForm({ tenantId, action }: { tenantId: string; action: PolicyFormApi }) {
  return (
    <FormShell title="Add statutory parameter set" openLabel="Add parameter set" submitLabel="Create parameter set" pendingLabel="Creating…"
      tenantId={tenantId} action={action}
      intro="A new set is UNRATIFIED. Approving a payroll run against it needs an explicit override until a company administrator ratifies it. The server refuses a set that overlaps another one for the same country in time. Blank parameter rows are ignored.">
      <Field name="name" label="Name" required hint="For example: Indonesia 2026" />
      <Field name="countryCode" label="Country" defaultValue="ID" hint="2-letter code" />
      <Field name="effectiveFrom" label="Effective from" type="date" required />
      <Field name="effectiveTo" label="Effective until" type="date" hint="Blank means open-ended" />
      <Field name="sourceNote" label="Source note" hint="The regulation reference" />
      <p style={{ margin: 0, ...fullRow, ...dimStyle }}>
        Each parameter needs a key and exactly one of a number or a JSON value.
      </p>
      <ParameterRows />
    </FormShell>
  );
}

// ---- Ratify (confirmed) ----
export function RatifyButton({ tenantId, setId, setName, action }: {
  tenantId: string;
  setId: string;
  setName: string;
  action: (tenantId: string, setId: string, note?: string) => Promise<PolicyResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);

  function ratify() {
    startTransition(async () => {
      const res = await action(tenantId, setId, note);
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Ratified." });
        setConfirming(false);
        setNote("");
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // either way: the set may already have been ratified by someone else
    });
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {!confirming ? (
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setConfirming(true); setMsg(null); }}>
            Ratify this set
          </button>
        </div>
      ) : (
        <div role="group" aria-label={`Ratify ${setName}`} style={panelStyle}>
          <p style={textStyle}>
            Ratifying signs off {setName} as verified. Payroll will use these parameters without an override from now
            on. The first signature is the one that counts: the server will not let it be signed again. It needs a
            company administrator signed in at high assurance.
          </p>
          <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
            <span>Source note (optional; replaces the current source note)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} disabled={pending}
              style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={ratify}>
              {pending ? "Ratifying…" : "Confirm ratification"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <ResultMessage msg={msg} />}
    </div>
  );
}
