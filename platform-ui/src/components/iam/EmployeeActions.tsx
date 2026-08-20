"use client";
import { IamAction, type ActionResult } from "./IamAction";

// P2-10 — transfer and terminate, the two JML writes with consequences a form cannot undo.
//
// ⚠ TERMINATE REQUIRES A REASON AND A CONFIRMATION, and both are this surface's addition rather than
// the backend's. The endpoint accepts a bare call; the least reversible action in the product should not
// be one click from a table row. `confirm` states what will actually happen — seats closed, grants
// revoked, login possibly disabled — because "are you sure?" prompts that do not say what they do get
// clicked through.
//
// ⚠ TRANSFER IS OFFERED EVEN WITH NO CURRENT SEAT, deliberately. Moving someone who was never placed is
// a legitimate first placement, the backend handles it (it closes zero seats and opens one), and hiding
// the control would leave an unplaced employee with no path to a seat from their own record.

interface Props {
  employeeId: string;
  displayName: string;
  positionOptions: { value: string; label: string }[];
  hasSeat: boolean;
  transferEmployee: (fd: FormData) => Promise<ActionResult>;
  terminateEmployee: (fd: FormData) => Promise<ActionResult>;
  updateEmployee: (fd: FormData) => Promise<ActionResult>;
}

export function EmployeeActions({
  employeeId, displayName, positionOptions, hasSeat, transferEmployee, terminateEmployee, updateEmployee,
}: Props) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <IamAction
        label={hasSeat ? "Transfer" : "Place in a seat"}
        title={hasSeat ? `Transfer ${displayName}` : `Place ${displayName} in a seat`}
        hidden={{ employeeId }}
        fields={[
          {
            name: "toPositionId",
            label: "Destination seat",
            type: "select",
            required: true,
            options: positionOptions,
            hint: hasSeat
              ? "Their current seat closes, the new one opens, and access follows immediately — not overnight."
              : "Access follows the seat's role-set as soon as this is saved.",
          },
          {
            name: "effectiveDate",
            label: "Effective date",
            type: "date",
            hint: "Defaults to today. A future date is refused — scheduled moves do not exist yet.",
          },
          { name: "reason", label: "Reason", placeholder: "optional" },
        ]}
        action={transferEmployee}
      />

      <IamAction
        label="Terminate"
        title={`Terminate ${displayName}`}
        fields={[
          {
            name: "reason",
            label: "Reason",
            type: "textarea",
            required: true,
            hint: "Recorded in the audit trail. This is the least reversible action here.",
          },
          {
            name: "lastDay",
            label: "Last day",
            type: "date",
            hint: "Defaults to today.",
          },
        ]}
        hidden={{ employeeId }}
        action={terminateEmployee}
        confirm={
          `Terminate ${displayName}? Every seat is closed, this company's manual grants are revoked, and ` +
          `their login is disabled unless they are still a member of another company. This is not undone by a retry.`
        }
      />

      <IamAction
        label="Edit record"
        title={`Edit ${displayName}`}
        hidden={{ employeeId }}
        fields={[
          { name: "displayName", label: "Display name", defaultValue: displayName },
          { name: "legalName", label: "Legal name" },
          { name: "personalEmail", label: "Personal email", type: "email" },
          { name: "phone", label: "Phone" },
          { name: "notes", label: "Notes", type: "textarea" },
        ]}
        action={updateEmployee}
      />
    </div>
  );
}
