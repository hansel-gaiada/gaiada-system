import Link from "next/link";
import { HairlineTable } from "@/components/ui";
import { EMPLOYMENT_LABEL, type EmployeeDetail } from "@/lib/iam";
import { EmployeeActions } from "./EmployeeActions";
import type { ActionResult } from "./IamAction";

// P2-10 — the employee record, as rendered on `/people/[userId]`. A server component: everything here
// is a read, and only the action controls need a client island.
//
// ⚠ TWO STATES THIS DELIBERATELY SPELLS OUT RATHER THAN LEAVING BLANK.
//   * NO EMPLOYEE RECORD — the person is a platform member with no HR record. Common and not an error
//     (bots, contractors, anyone added before the record existed), but a blank panel here would read as
//     "loading" or "no data". It says which.
//   * NO CURRENT SEAT — the record exists but nobody has placed them. That means their access does NOT
//     follow the org chart and never will until someone does. Silence would let a reader assume the
//     placement is implied by employment.
//
// Past seats are shown, not hidden: "where were they before this move" is exactly the question asked
// when auditing why access changed.

interface Props {
  employee: EmployeeDetail | null;
  /** Positions the viewer may transfer into. Empty ⇒ the transfer control is not offered. */
  positionOptions: { value: string; label: string }[];
  canManage: boolean;
  transferEmployee: (fd: FormData) => Promise<ActionResult>;
  terminateEmployee: (fd: FormData) => Promise<ActionResult>;
  updateEmployee: (fd: FormData) => Promise<ActionResult>;
}

export function EmployeeRecord({ employee, positionOptions, canManage, transferEmployee, terminateEmployee, updateEmployee }: Props) {
  if (!employee) {
    return (
      <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)", margin: 0 }}>
        No employee record in this company. They are a platform member without one — which is normal for
        service accounts and for anyone added before HR records existed. Hiring them from{" "}
        <Link href="/hr/people" style={{ color: "var(--erp-accent)" }}>HR › People</Link> creates the
        record and can place them in a seat at the same time.
      </p>
    );
  }

  const current = employee.seats.filter((s) => s.current);
  const past = employee.seats.filter((s) => !s.current);
  const terminated = employee.employmentStatus === "terminated";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <Field label="Status" value={EMPLOYMENT_LABEL[employee.employmentStatus]} />
        <Field label="Work email" value={employee.workEmail ?? "—"} />
        <Field label="Hire date" value={employee.hireDate ?? "—"} />
        {terminated ? <Field label="Terminated" value={employee.terminatedAt?.slice(0, 10) ?? "—"} /> : null}
      </div>

      {current.length === 0 && !terminated ? (
        <div className="iam-scope-note">
          <strong>No current position.</strong>
          <span>
            Their access does not follow the org chart, and will not until someone places them in a seat.
            Any access they have was granted by hand and will survive a move.
          </span>
        </div>
      ) : null}

      {current.length > 0 ? (
        <HairlineTable
          columns={[{ label: "Current seat" }, { label: "Unit" }, { label: "Since", align: "right" }]}
          rows={current.map((s) => [s.title, s.unitNodeId, s.validFrom])}
          tcols="1.4fr 1fr 0.6fr"
        />
      ) : null}

      {past.length > 0 ? (
        <details>
          <summary style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", cursor: "pointer" }}>
            {past.length} previous seat(s)
          </summary>
          <div style={{ marginTop: 8 }}>
            <HairlineTable
              columns={[{ label: "Seat" }, { label: "Unit" }, { label: "From" }, { label: "To", align: "right" }]}
              rows={past.map((s) => [s.title, s.unitNodeId, s.validFrom, s.validTo ?? "—"])}
              tcols="1.4fr 1fr 0.6fr 0.6fr"
            />
          </div>
        </details>
      ) : null}

      {employee.notes ? (
        <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", margin: 0 }}>{employee.notes}</p>
      ) : null}

      {canManage && !terminated ? (
        <EmployeeActions
          employeeId={employee.id}
          displayName={employee.displayName}
          positionOptions={positionOptions}
          hasSeat={current.length > 0}
          transferEmployee={transferEmployee}
          terminateEmployee={terminateEmployee}
          updateEmployee={updateEmployee}
        />
      ) : null}

      {terminated ? (
        <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)", margin: 0 }}>
          This person has left. Their seats are closed and this company&apos;s manual grants were revoked;
          whether their login survives depends on whether they are still a member of another company.
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "grid", gap: 2 }}>
      <span style={{ font: "700 9px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
        {label}
      </span>
      <span style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)" }}>{value}</span>
    </span>
  );
}
