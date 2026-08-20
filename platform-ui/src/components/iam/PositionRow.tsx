"use client";
import { IamAction, type ActionResult } from "./IamAction";
import type { IamField } from "./IamAction";

// P2-12-FE — the per-position controls. A client island rather than a whole client page: the listing
// itself is server-rendered (it is a read the server already narrows correctly), and only these
// controls need state.

export interface RoleOption {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

export interface MemberOption {
  value: string;
  label: string;
}

interface Props {
  positionId: string;
  title: string;
  status: "active" | "retired" | "orphaned";
  unitOptions: { value: string; label: string }[];
  roleOptions: RoleOption[];
  memberOptions: MemberOption[];
  attachedRoles: { roleId: string; role: string }[];
  canCompose: boolean;
  canPlace: boolean;
  attachRole: (fd: FormData) => Promise<ActionResult>;
  detachRole: (fd: FormData) => Promise<ActionResult>;
  assignPosition: (fd: FormData) => Promise<ActionResult>;
  requestAssignment: (fd: FormData) => Promise<ActionResult>;
  updatePosition: (fd: FormData) => Promise<ActionResult>;
  retirePosition: (fd: FormData) => Promise<ActionResult>;
}

export function PositionRow(p: Props) {
  const scopeField: IamField = {
    name: "scopeKind",
    label: "Scope",
    type: "select",
    required: true,
    defaultValue: "own_unit",
    // `company` and `own_unit` only. There is deliberately no `global`: a position can never confer
    // platform tier, and that is enforced by the DB's own CHECK (0109 §2.3), not by this list.
    options: [
      { value: "own_unit", label: "This unit only (recommended)" },
      { value: "company", label: "Whole company" },
    ],
    hint: "A seat can never confer platform-wide authority — the database refuses it.",
  };

  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {p.canPlace && p.status === "active" ? (
        <IamAction
          label="Place"
          title={`Place someone in "${p.title}"`}
          hidden={{ positionId: p.positionId }}
          fields={[
            { name: "userId", label: "Person", type: "select", required: true, options: p.memberOptions },
            { name: "reason", label: "Reason", placeholder: "optional" },
          ]}
          action={p.assignPosition}
          // The dept-head path: the server refuses a direct placement and says to propose instead. That
          // follow-up control is supplied HERE so the refusal comes with its own remedy.
          onNextStep={(step) =>
            step === "propose_assignment" ? (
              <IamAction
                label="Propose instead"
                title={`Propose a placement in "${p.title}"`}
                variant="solid"
                hidden={{ positionId: p.positionId }}
                fields={[
                  { name: "userId", label: "Person", type: "select", required: true, options: p.memberOptions },
                  {
                    name: "justification",
                    label: "Justification",
                    type: "textarea",
                    required: true,
                    hint: "The approver reads this. It is the audit trail for the exception.",
                  },
                ]}
                action={p.requestAssignment}
              />
            ) : null
          }
        />
      ) : null}

      {p.canCompose ? (
        <>
          <IamAction
            label="Attach role"
            title={`Attach a role to "${p.title}"`}
            hidden={{ positionId: p.positionId }}
            fields={[
              {
                name: "roleId",
                label: "Role",
                type: "select",
                required: true,
                options: p.roleOptions,
                hint: "Roles you may not attach are shown disabled, with the reason — the server decides, not this list.",
              },
              scopeField,
            ]}
            action={p.attachRole}
          />

          {p.attachedRoles.length > 0 ? (
            <IamAction
              label="Detach role"
              title={`Detach a role from "${p.title}"`}
              hidden={{ positionId: p.positionId }}
              fields={[
                {
                  name: "roleId",
                  label: "Role",
                  type: "select",
                  required: true,
                  options: p.attachedRoles.map((r) => ({ value: r.roleId, label: r.role })),
                  hint: "Detaching revokes this role from every current holder immediately, not at the next sweep.",
                },
              ]}
              action={p.detachRole}
              confirm="Detach this role? Every current holder loses it immediately."
            />
          ) : null}

          <IamAction
            label="Edit"
            title={`Edit "${p.title}"`}
            hidden={{ positionId: p.positionId }}
            fields={[
              { name: "title", label: "Title", defaultValue: p.title },
              {
                name: "unitNodeId",
                label: "Org unit",
                type: "select",
                options: p.unitOptions,
                hint: "Moving the unit re-reconciles every holder's access.",
              },
            ]}
            action={p.updatePosition}
          />

          {p.status !== "retired" ? (
            <IamAction
              label="Retire"
              immediate
              hidden={{ positionId: p.positionId }}
              fields={[]}
              action={p.retirePosition}
              confirm="Retire this position? Every open placement is closed and the holders are re-reconciled."
            />
          ) : null}
        </>
      ) : null}
    </span>
  );
}
