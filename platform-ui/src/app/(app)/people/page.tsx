import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isElevated, can } from "@/lib/rbac";
import { listUsers, type UserRow } from "@/lib/adminData";
import { listMembers } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";

const SUBTITLE = "Everyone in this company. Open a person to see their full workspace.";
const COLUMNS: Column[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "title", header: "Title", sortable: true },
  { key: "email", header: "Email" },
  { key: "roles", header: "Roles" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

function limited() {
  return (
    <>
      <PageHeader eyebrow="Workspace" title="People" subtitle={SUBTITLE} />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
          The people directory is limited to owners and administrators. You can still open your own profile from the account menu.
        </p>
      </Card>
    </>
  );
}

export default async function PeoplePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!can(me, "people.directory", tenant) && !isElevated(me)) return limited();

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Workspace" title="People" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  let people: UserRow[] = await listUsers(userId, tenant).catch(() => []);
  if (people.length === 0) {
    const members = await listMembers(userId, tenant).catch(() => []);
    people = members.map((m) => ({ id: m.user_id, name: m.name, email: m.email, title: m.title, status: "active", roles: [] }));
  }

  const rows = people.map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title ?? "—",
    email: p.email,
    roles: p.roles.length > 0 ? p.roles.map((r) => r.role).join(", ") : "—",
    status: p.status,
  }));

  const canInvite = can(me, "admin.access", tenant);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="People"
        subtitle={SUBTITLE}
        actions={canInvite ? <Link href="/people/new" className="lux-btn lux-btn--solid lux-btn--sm">Invite employee</Link> : undefined}
      />
      {people.length === 0 ? (
        <Card><EmptyNote>No people found for this company.</EmptyNote></Card>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/people", idKey: "id", labelKey: "name" }} csvName="people" pageSize={20} />
      )}
    </>
  );
}
