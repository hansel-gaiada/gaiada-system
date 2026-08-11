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
// ⚠ `org_unit` is deliberately NOT offered yet — see ORG_UNIT_SCOPE_ENABLED below.
const SCOPE_TYPES = ["company", "global", "project"];

// HIER-2 flips this to `true`, in the same change that ships the `org_unit_lead` role and its
// Cerbos subtree cascade. Everything else needed to offer the scope — the org-node picker, the
// `flattenOrgUnits()` helper, the `orgUnits` prop threaded from the page — is already built and
// tested below; this constant is the only gate.
//
// WHY IT IS OFF (resolved 2026-08-10, cross-agent conflict):
//   1. THE API REJECTS IT. `platform-nest/src/admin/admin-identity.controller.ts`'s own
//      `SCOPE_TYPES` is `{global, company, project}` — submitting `org_unit` returns a 400
//      "invalid scopeType". Offering it here produced a UI option the server refuses.
//   2. THE BACKEND'S REASON IS THE RIGHT ONE, and it outranks the "offer it with an honest hint"
//      approach this component originally took. Its header argues that offering the scope before
//      anything consumes it "would let an admin mint a grant that is inert by construction — the
//      exact 'vestigial scope' pattern this whole program exists to retire, not to re-create."
//      That is this program's central thesis: an inert grant nobody can act on is how `team`
//      became a dead concept wired into ~23 policies and 70% of the IAM-04 rollout hazard. A
//      caveat label does not stop a grant from being created; not offering it does.
//
// So: no pre-staging. The scope becomes available the moment it does something.
const ORG_UNIT_SCOPE_ENABLED = false;

// ⚠ Honesty note, not a capability gate: an `org_unit`-scoped grant is fully STORABLE today
// (0100 landed the column/CHECK support) but confers NOTHING yet — the `org_unit_lead` role and
// its Cerbos subtree cascade are HIER-2, un-built. Offering the scope without saying so would
// recreate exactly the "dead grant" pattern this whole program spent 2026-08-10 removing (see the
// `team_lead` post-mortem). The picker below carries the caveat in two places an admin can't miss
// mid-flow: the dropdown option label (visible before they even open the picker) and the field
// hint under the org-unit select itself. Deliberately NOT a disabled option — the grant is real,
// useful storage an admin may legitimately want to pre-stage before HIER-2 ships (e.g. seeding
// department-lead assignments ahead of the role landing) — just never presented as doing anything
// today.
const ORG_UNIT_INERT_NOTE =
  "Stores the grant only — no role reads org-unit scope yet. Access starts once the department-lead role (HIER-2) ships.";

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
              {/* One gate, one place: flipping ORG_UNIT_SCOPE_ENABLED in HIER-2 re-enables the
                  option AND the org-node picker below, which is already built and tested. */}
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
              hint={ORG_UNIT_INERT_NOTE}
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
