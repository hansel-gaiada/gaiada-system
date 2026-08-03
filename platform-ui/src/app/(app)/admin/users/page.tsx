import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listUsers, listRoles } from "@/lib/adminData";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { RoleManager } from "@/components/admin/RoleManager";
import { assignRoleAction, revokeRoleAction, revokeSessionAction } from "./actions";

const COLUMNS = [
  { label: "Name" },
  { label: "Email" },
  { label: "Title" },
  { label: "Status" },
  { label: "Roles & access" },
];
const TCOLS = "1.2fr 1.6fr 1fr 0.8fr 2.4fr";

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

  const roles = tenant ? await listRoles(userId, tenant) : [];

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
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={users.map((u) => [
              u.isService ? (
                <span key={`${u.id}-name`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {u.name}
                  <StatusBadge label="service" />
                </span>
              ) : (
                u.name
              ),
              u.email,
              u.title ?? "—",
              <StatusBadge key={`${u.id}-status`} label={u.status} />,
              <RoleManager
                key={`${u.id}-roles`}
                userId={u.id}
                currentRoles={u.roles}
                roles={roles}
                assign={assignRoleAction.bind(null, u.id)}
                revoke={revokeRoleAction.bind(null, u.id)}
                revokeSession={revokeSessionAction.bind(null, u.id)}
              />,
            ])}
          />
        )}
      </Card>
    </>
  );
}
