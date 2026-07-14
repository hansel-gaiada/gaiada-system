import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isElevated } from "@/components/shell/nav";
import { listUsers, type UserRow } from "@/lib/adminData";
import { listMembers } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

const SUBTITLE = "Everyone in this company. Open a person to see their full workspace.";

function limited() {
  return (
    <>
      <PageHeader eyebrow="Workspace" title="People" subtitle={SUBTITLE} />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
          The people directory is limited to owners and administrators. You can still open your own
          profile from the account menu.
        </p>
      </Card>
    </>
  );
}

export default async function PeoplePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  if (!isElevated(me)) return limited();

  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Workspace" title="People" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  // Prefer /users (roles + status); fall back to members with empty roles.
  let people: UserRow[] = await listUsers(userId, tenant).catch(() => []);
  if (people.length === 0) {
    const members = await listMembers(userId, tenant).catch(() => []);
    people = members.map((m) => ({ id: m.user_id, name: m.name, email: m.email, title: m.title, status: "active", roles: [] }));
  }

  const rows = people.map((p) => [
    <Link key="n" href={`/people/${p.id}`} style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 400 }}>
      {p.name}
    </Link>,
    p.title ?? "—",
    p.email,
    p.roles.length > 0 ? p.roles.map((r) => r.role).join(", ") : "—",
    <StatusBadge key="s" label={p.status} />,
  ]);

  return (
    <>
      <PageHeader eyebrow="Workspace" title="People" subtitle={SUBTITLE} />
      <Card title={people.length ? `${people.length} ${people.length === 1 ? "person" : "people"}` : undefined}>
        {people.length === 0 ? (
          <EmptyNote>No people found for this company.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Name" }, { label: "Title" }, { label: "Email" }, { label: "Roles" }, { label: "Status", align: "right" }]}
            rows={rows}
            tcols="1.2fr 1fr 1.4fr 1.2fr 0.7fr"
          />
        )}
      </Card>
    </>
  );
}
