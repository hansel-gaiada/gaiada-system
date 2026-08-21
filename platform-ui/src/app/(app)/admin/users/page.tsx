import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listUsers, listRoles } from "@/lib/adminData";
import { getOrgStructure, flattenOrgUnits } from "@/lib/org";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { RoleManager } from "@/components/admin/RoleManager";
import { assignRoleAction, revokeRoleAction, revokeSessionAction } from "./actions";

// Name and email were two columns, and the `service` badge sat inline after the name in the first
// of them — so on every automation account the badge ran into the email text in the column beside
// it. They are ONE identity, so they are now one cell (name over email), which removes the
// collision and buys the width back for the column that actually needed it.
const COLUMNS = [
  { label: "Member" },
  { label: "Title" },
  { label: "Status" },
  { label: "Roles & access" },
];
const TCOLS = "2.1fr 1fr 0.7fr 2.2fr";

export default async function AdminUsersPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  let users: Awaited<ReturnType<typeof listUsers>>;
  try {
    // includeService: this is where an automation account's grants get audited and revoked, so
    // hiding non-human principals here would hide exactly what needs governing. Badged below.
    // The People directory takes the default and omits them.
    users = tenant ? await listUsers(userId, tenant, true) : [];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Settings" title="Users & Roles" subtitle="Members, access grants and session control." />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              This page is limited to administrators.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  // Humans first. `listUsers(…, true)` includes service principals on purpose (this is where an
  // automation account's grants get audited — hiding them would hide exactly what needs governing,
  // see the call above), but the endpoint returns them in whatever order it likes and on the live
  // company that put FOUR automation accounts at the top: an admin opening this page met a screen
  // of bots before a single colleague. Service accounts are the exception case, so they sort last;
  // within each group, by name, so the order is stable rather than endpoint-dependent.
  const sortedUsers = [...users].sort((a, b) =>
    Number(a.isService) - Number(b.isService) || a.name.localeCompare(b.name),
  );

  const roles = tenant ? await listRoles(userId, tenant) : [];
  // The `org_unit` scope picker (RoleManager) reuses the same org chart the org builder reads —
  // no new fetch, per IAM-UI-SCOPE's constraint. Falls back to an empty list (renders as "no
  // departments/divisions yet") if there's no active company at all.
  const company = tenant ? me.companies.find((c) => c.id === tenant) ?? { id: tenant, name: tenant, type: null } : null;
  const orgUnits = tenant && company ? flattenOrgUnits((await getOrgStructure(userId, tenant, company)).structure) : [];

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Users & Roles"
        subtitle="Members of the active company, their role grants, and session control."
      />
      <Card>
        {users.length === 0 ? (
          <EmptyNote>No members found for the active company.</EmptyNote>
        ) : (
          // Same guard the department console tabs use: `HairlineTable` is an fr-column grid with no
          // track minimum and no stacked mode, so below its no-wrap width every cell breaks
          // mid-phrase. 720px is this table's measured floor.
          <div className="lux-table-scroll erp-scroll" style={{ ["--lux-table-min" as string]: "720px" }}>
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={sortedUsers.map((u) => [
              <span key={`${u.id}-who`} className="lux-who">
                <span className="lux-who__name">
                  {u.name}
                  {u.isService && <StatusBadge label="service" />}
                </span>
                <span className="lux-who__email">{u.email}</span>
              </span>,
              u.title ?? "—",
              <StatusBadge key={`${u.id}-status`} label={u.status} />,
              <RoleManager
                key={`${u.id}-roles`}
                userId={u.id}
                currentRoles={u.roles}
                roles={roles}
                orgUnits={orgUnits}
                assign={assignRoleAction.bind(null, u.id)}
                revoke={revokeRoleAction.bind(null, u.id)}
                revokeSession={revokeSessionAction.bind(null, u.id)}
              />,
            ])}
          />
          </div>
        )}
      </Card>
    </>
  );
}
