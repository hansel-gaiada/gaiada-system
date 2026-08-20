import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isElevated, can } from "@/lib/rbac";
import { listUsers, type UserRow } from "@/lib/adminData";
import { listMembers } from "@/lib/entities";
import { listEmployees, listPositions, EMPLOYMENT_LABEL, type Employee } from "@/lib/iam";
import { hireEmployee } from "@/lib/iamActions";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";
import { IamAction } from "@/components/iam/IamAction";
import "@/components/iam/iam.css";

// HR › People — the company people directory. Rows open the employee 360 at /people/[userId].
//
// P2-10 adds the JOINER flow and the employment column. Two things worth stating:
//
// ⚠ THE DIRECTORY AND THE EMPLOYEE RECORDS ARE DIFFERENT SETS, and this page shows both honestly. The
// directory is platform MEMBERSHIPS (everyone who can be in this company, including service accounts);
// `employees` is the HR record. A member with no employee record is normal, and the column says
// "no record" rather than leaving a blank that reads as missing data. The counts above make the gap
// visible, because that gap is exactly what P2-15's backfill exists to close.
//
// ⚠ HIRING WITHOUT A POSITION IS ALLOWED AND CONFERS NOTHING. The form makes the position optional
// because the backend does (a candidate can be recorded before a seat exists), and the success message
// says which of the two happened — a record with no seat gives the person no access and no login, and an
// operator who assumes otherwise has a silent problem.
const COLUMNS: Column[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "employment", header: "Employment", sortable: true },
  { key: "title", header: "Title", sortable: true },
  { key: "email", header: "Email" },
  { key: "roles", header: "Roles" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

export default async function HRPeoplePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!can(me, "people.directory", tenant) && !isElevated(me)) {
    return (
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
          The people directory is limited to owners and administrators. You can still open your own profile from the account menu.
        </p>
      </Card>
    );
  }
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  let people: UserRow[] = await listUsers(userId, tenant).catch(() => []);
  if (people.length === 0) {
    const members = await listMembers(userId, tenant).catch(() => []);
    people = members.map((m) => ({ id: m.user_id, name: m.name, email: m.email, title: m.title, status: "active", roles: [] }));
  }

  const [employees, { positions }] = await Promise.all([
    listEmployees(userId, tenant),
    listPositions(userId, tenant),
  ]);
  const employeeByUser = new Map<string, Employee>();
  for (const e of employees) if (e.userId) employeeByUser.set(e.userId, e);

  const rows = people.map((p) => {
    const emp = employeeByUser.get(p.id);
    return {
      id: p.id,
      name: p.name,
      // "No record" rather than "—": the absence is a fact about HR data, not a missing value.
      employment: emp ? EMPLOYMENT_LABEL[emp.employmentStatus] : "No record",
      title: p.title ?? "—",
      email: p.email,
      roles: p.roles.length > 0 ? p.roles.map((r) => r.role).join(", ") : "—",
      status: p.status,
    };
  });

  const canInvite = can(me, "admin.access", tenant);
  // Hiring is HR's write (`employee · create`); the server decides, and this only avoids rendering a
  // control that would 403.
  const canHire = canInvite || can(me, "people.directory", tenant);
  const positionOptions = positions
    .filter((p) => p.status === "active")
    .map((p) => ({ value: p.id, label: `${p.title} — ${p.unitNodeId}${p.roleSet.length === 0 ? " (confers no access)" : ""}` }));

  const withRecord = employees.filter((e) => e.employmentStatus !== "terminated").length;
  const noRecord = people.length - [...employeeByUser.keys()].filter((k) => people.some((p) => p.id === k)).length;

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="In the directory" value={String(people.length)} foot="platform memberships" />
        <KpiTile label="Employee records" value={String(withRecord)} foot="not terminated" />
        <KpiTile label="No HR record" value={String(Math.max(0, noRecord))} foot="member without one" />
        <KpiTile label="Seats available" value={String(positionOptions.length)} foot="active positions" />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {canHire ? (
          <IamAction
            label="Hire"
            title="Hire an employee"
            variant="solid"
            fields={[
              { name: "displayName", label: "Name", required: true },
              {
                name: "workEmail",
                label: "Work email",
                type: "email",
                required: true,
                hint: "The joiner's natural key — hiring the same address twice is refused.",
              },
              {
                name: "positionId",
                label: "Position",
                type: "select",
                options: positionOptions,
                hint: "Optional. Without a seat they get a record but NO access and NO login.",
              },
              { name: "startDate", label: "Start date", type: "date", hint: "A future date is refused — scheduled joiners do not exist yet." },
              { name: "legalName", label: "Legal name" },
              { name: "phone", label: "Phone" },
            ]}
            action={hireEmployee}
          />
        ) : null}
        {canInvite && (
          <Link href="/people/new" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>
            Invite platform user
          </Link>
        )}
      </div>

      {positionOptions.length === 0 ? (
        <div className="iam-scope-note" style={{ marginBottom: 16 }}>
          <strong>No active positions.</strong>
          <span>
            You can still record employees, but nobody can be placed and access will not follow the org
            chart. Define seats in{" "}
            <Link href="/organization/positions" style={{ color: "var(--erp-accent)" }}>Organization › Positions</Link> first.
          </span>
        </div>
      ) : null}

      {people.length === 0 ? (
        <EmptyNote>No people found for this company.</EmptyNote>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/people", idKey: "id", labelKey: "name" }} csvName="people" pageSize={20} />
      )}
    </>
  );
}
