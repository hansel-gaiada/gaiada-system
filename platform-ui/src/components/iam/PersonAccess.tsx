"use client";
import { IamAction, type ActionResult } from "./IamAction";

// P2-11 — the per-person access controls on the dept-head page: grant, revoke, request an override.
//
// ⚠ THE OVERRIDE PATH IS THE POINT OF THIS COMPONENT. A department head granting above their own
// ceiling is REFUSED by `grant-write.service.ts`, and the refusal carries `ceiling_exceeded` /
// `override_required`. That is not a dead end — it is the routed-override mechanism telling them to ask
// someone who can. So the grant control passes an `onNextStep` that renders the override request
// pre-aimed at the same person and role, and the refusal renders as guidance rather than an error.
// Without that, a dept head hits a wall the system deliberately built a door next to.
//
// ⚠ A POSITION-MANAGED GRANT HAS NO REVOKE CONTROL AT ALL. `revocable: false` means the reconciler
// would restore it on its next pass, so offering the button would produce a revoke that silently
// un-revokes itself and an operator who concludes the UI lies. The row says where it comes from
// instead — change the position.

interface Props {
  userId: string;
  personLabel: string;
  roleOptions: { value: string; label: string; disabled?: boolean; hint?: string }[];
  unitOptions: { value: string; label: string }[];
  canGrant: boolean;
  grantRole: (fd: FormData) => Promise<ActionResult>;
  requestOverride: (fd: FormData) => Promise<ActionResult>;
}

export function PersonAccess({ userId, personLabel, roleOptions, unitOptions, canGrant, grantRole, requestOverride }: Props) {
  if (!canGrant) return null;

  const scopeFields = [
    {
      name: "scopeType",
      label: "Scope",
      type: "select" as const,
      required: true,
      defaultValue: "company",
      options: [
        { value: "company", label: "Whole company" },
        { value: "org_unit", label: "One org unit" },
      ],
    },
    {
      name: "scopeId",
      label: "Org unit (only if scoped to a unit)",
      type: "select" as const,
      options: unitOptions,
      hint: "Ignored when the scope is the whole company.",
    },
  ];

  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
      <IamAction
        label="Grant role"
        title={`Grant a role to ${personLabel}`}
        hidden={{ userId }}
        fields={[
          {
            name: "roleId",
            label: "Role",
            type: "select",
            required: true,
            options: roleOptions,
            hint: "Roles you may not grant are shown disabled with the reason.",
          },
          ...scopeFields,
          {
            name: "expiresInDays",
            label: "Expires in (days)",
            type: "number",
            hint: "Leave blank for a standing grant. A temporary grant is swept automatically when it lapses.",
          },
          { name: "reason", label: "Reason", placeholder: "optional" },
        ]}
        action={grantRole}
        onNextStep={(step) =>
          step === "request_override" ? (
            <IamAction
              label="Request override"
              title={`Request an override for ${personLabel}`}
              variant="solid"
              hidden={{ userId }}
              fields={[
                { name: "roleId", label: "Role", type: "select", required: true, options: roleOptions },
                ...scopeFields,
                {
                  name: "justification",
                  label: "Justification",
                  type: "textarea",
                  required: true,
                  hint: "An override is an exception. This is the reason an auditor will read later, so write it for them.",
                },
                { name: "expiresInDays", label: "Expires in (days)", type: "number" },
              ]}
              action={requestOverride}
            />
          ) : null
        }
      />

      {/* Available without first being refused: a dept head who already knows the grant is above their
          ceiling should not have to trip over the wall to find the door. */}
      <IamAction
        label="Request override"
        title={`Request an override for ${personLabel}`}
        hidden={{ userId }}
        fields={[
          { name: "roleId", label: "Role", type: "select", required: true, options: roleOptions },
          ...scopeFields,
          { name: "justification", label: "Justification", type: "textarea", required: true },
          { name: "expiresInDays", label: "Expires in (days)", type: "number" },
        ]}
        action={requestOverride}
      />
    </span>
  );
}
