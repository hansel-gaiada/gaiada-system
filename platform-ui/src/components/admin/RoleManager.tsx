"use client";
import { useActionState } from "react";
import type { RoleRow } from "@/lib/adminData";
import { Button, Eyebrow, StatusBadge, Toast } from "@/components/ui";
import { Field } from "@/components/forms/Field";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

const SCOPE_TYPES = ["company", "global", "team", "project"];

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
            color: "rgba(26,25,22,.45)",
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
  assign,
  revoke,
  revokeSession,
}: {
  userId: string;
  currentRoles: { grantId: string; role: string; scopeType: string; scopeId: string | null }[];
  roles: RoleRow[];
  assign: (prev: AdminActionState | null, formData: FormData) => Promise<AdminActionState>;
  revoke: (grantId: string, prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
  revokeSession: (prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
}) {
  const [assignState, assignFormAction, assignPending] = useActionState(assign, null);
  const [sessionState, sessionFormAction, sessionPending] = useActionState(revokeSession, null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {currentRoles.length === 0 ? (
          <span style={{ font: "400 13px var(--font-body)", color: "rgba(26,25,22,.5)" }}>No roles</span>
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
        <Field name="scopeType" label="Scope" type="select" options={SCOPE_TYPES} required />
        <Field name="scopeId" label="Scope ID (optional)" type="text" />
        <Button type="submit" size="sm" disabled={assignPending}>
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
