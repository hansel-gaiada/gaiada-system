"use client";
import { useActionState, useState } from "react";
import type { RoleRow } from "@/lib/adminData";
import type { OrgUnitOption } from "@/lib/org";
import { Button, Eyebrow, StatusBadge, Toast } from "@/components/ui";
import { Field } from "@/components/forms/Field";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

// IAM-UI-SCOPE (2026-08-10) — migration 0100 (HIER-1) widened `user_roles.scope_type` to
// `global | company | org_unit | project` and (as an *expand*, not yet contracted) still permits
// `team`/`record` for one more release while their writers get removed in HIER-3. Per the
// consolidation plan (`docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md`), `team` and
// `record` have ZERO live grants and are scheduled for deletion — this UI stops offering both now
// rather than invite the first-ever grant into a scope that is about to disappear. `org_unit`
// replaces `team` as the mid-level scope; its picker is rendered separately below (a node-id
// STRING off the org chart, never a uuid) because a free-text box would let an admin typo an
// orphaned node id that Cerbos silently grants nothing for (HIER-2's fail-closed design).
// `org_unit` itself is offered — see ORG_UNIT_SCOPE_ENABLED below for why.
const SCOPE_TYPES = ["company", "global", "project"];

// HIER-3 (2026-08-11) flips this to `true`. Both conditions that kept it off are now resolved:
//   1. THE API NOW ACCEPTS IT. `platform-nest/src/admin/admin-identity.controller.ts`'s
//      `SCOPE_TYPES` is `new Set(["global", "company", "project", "org_unit"])` (landed by HIER-2)
//      — submitting `org_unit` no longer 400s.
//   2. IT NOW DOES SOMETHING. HIER-2 shipped the `org_unit_lead` role and its Cerbos subtree
//      cascade (`derived_roles.yaml`, verified live via decision probe, `Alpha 01.036.0086a`) — an
//      `org_unit`-scoped grant confers `reports.department.view` + `appraisal.read` over the
//      granted unit's subtree. It is no longer the inert "vestigial scope" pattern this program
//      exists to retire (see `docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md`).
// The org-node picker, its `flattenOrgUnits()` helper and the `orgUnits` prop were already built
// and tested for this moment; this constant was the only remaining gate.
const ORG_UNIT_SCOPE_ENABLED = true;

// HIER-3: `org_unit` now DOES something (HIER-2's `org_unit_lead` role + subtree cascade,
// `reports.department.view` + `appraisal.read` over the granted unit's subtree), so the picker no
// longer needs an "inert grant" caveat — it carries a plain scope-shape hint instead (see the
// `Field`'s `hint` prop below).
const ORG_UNIT_SCOPE_NOTE =
  "Grants apply to this department/division and its subtree (org_unit_lead's dept-lead reporting + appraisal-read access cascades to child units).";

// One role-grant chip: a StatusBadge + a small "x" revoke button. Has its own
// useActionState so each chip's pending/result state is independent, even
// though `revoke` is the same user-bound action re-bound per grantId here.
function RoleGrantChip({
  grant,
  revoke,
}: {
  grant: { grantId: string; role: string };
  revoke: (grantId: string, prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
}) {
  const [state, formAction, pending] = useActionState(revoke.bind(null, grant.grantId), null);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <StatusBadge label={grant.role} />
      <form action={formAction} style={{ display: "inline" }}>
        <button
          type="submit"
          disabled={pending}
          aria-label={`Revoke ${grant.role}`}
          style={{
            border: "none",
            background: "none",
            cursor: "pointer",
            font: "400 12px var(--font-body)",
            color: "var(--ink-subtle)",
            padding: 0,
          }}
        >
          ×
        </button>
      </form>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message="Role revoked." />}
    </span>
  );
}

// Per-user role management: current grants (each revocable via
// RoleGrantChip) + an assign-role mini-form + a "Revoke sessions" button.
// `assign` and `revokeSession` are bound ahead of time by the page to a
// specific user; `revoke` is bound to the user only — RoleGrantChip binds
// the grantId per chip. Assign/revoke roles degrade gracefully (friendly
// toast) until the backend write endpoints land; revoke-session is real.
export function RoleManager({
  currentRoles,
  roles,
  orgUnits,
  assign,
  revoke,
  revokeSession,
}: {
  userId: string;
  currentRoles: { grantId: string; role: string; scopeType: string; scopeId: string | null }[];
  roles: RoleRow[];
  /** The active company's department/division nodes — the `scope_id` choices for `org_unit`. */
  orgUnits: OrgUnitOption[];
  assign: (prev: AdminActionState | null, formData: FormData) => Promise<AdminActionState>;
  revoke: (grantId: string, prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
  revokeSession: (prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
}) {
  const [assignState, assignFormAction, assignPending] = useActionState(assign, null);
  const [sessionState, sessionFormAction, sessionPending] = useActionState(revokeSession, null);
  // Tracked (not left to the uncontrolled <select> default) so the scope-id control beneath it can
  // switch shape: free-text for company/project, none for global, an org-chart picker for org_unit.
  const [scopeType, setScopeType] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {currentRoles.length === 0 ? (
          <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>No roles</span>
        ) : (
          currentRoles.map((grant) => <RoleGrantChip key={grant.grantId} grant={grant} revoke={revoke} />)
        )}
      </div>

      <form action={assignFormAction} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-end" }}>
        <label className="lux-field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Role</Eyebrow>
          <select name="roleId" defaultValue="" required className="lux-field__control" aria-label="Role">
            <option value="" disabled hidden />
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
        <label className="lux-field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Scope</Eyebrow>
          <span className="lux-field__selectwrap">
            <select
              name="scopeType"
              required
              value={scopeType}
              onChange={(e) => setScopeType(e.target.value)}
              className="lux-field__control"
              aria-label="Scope"
            >
              <option value="" disabled hidden />
              {/* One gate, one place: ORG_UNIT_SCOPE_ENABLED (flipped true in HIER-3) controls both
                  the option AND the org-node picker below. */}
              {(ORG_UNIT_SCOPE_ENABLED ? [...SCOPE_TYPES, "org_unit"] : SCOPE_TYPES).map((s) => (
                <option key={s} value={s}>
                  {s === "org_unit" ? "org unit" : s}
                </option>
              ))}
            </select>
          </span>
        </label>
        {scopeType === "org_unit" ? (
          orgUnits.length > 0 ? (
            <Field
              name="scopeId"
              label="Org unit"
              type="select"
              required
              optionItems={orgUnits.map((u) => ({
                value: u.id,
                label: `${"— ".repeat(Math.max(0, u.depth - 1))}${u.name}`,
              }))}
              hint={ORG_UNIT_SCOPE_NOTE}
            />
          ) : (
            <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              No departments or divisions on this company&apos;s org chart yet.
            </span>
          )
        ) : scopeType === "global" ? null : (
          <Field name="scopeId" label="Scope ID (optional)" type="text" />
        )}
        <Button
          type="submit"
          size="sm"
          disabled={assignPending || (scopeType === "org_unit" && orgUnits.length === 0)}
        >
          {assignPending ? "Assigning…" : "Assign"}
        </Button>
      </form>

      <form action={sessionFormAction}>
        <Button type="submit" variant="ghost" size="sm" disabled={sessionPending}>
          {sessionPending ? "Revoking…" : "Revoke sessions"}
        </Button>
      </form>

      {assignState?.error && <Toast message={assignState.error} />}
      {assignState?.ok && <Toast message="Role assigned." />}
      {sessionState?.error && <Toast message={sessionState.error} />}
      {sessionState?.ok && <Toast message="Sessions revoked." />}
    </div>
  );
}
