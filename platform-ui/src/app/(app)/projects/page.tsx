import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers, listProjects, type Member, type Project } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";

const COLUMNS = [{ label: "Name" }, { label: "Status" }, { label: "Due date" }, { label: "Owner", align: "right" as const }];
const TCOLS = "2fr 1fr 1fr 1fr";

export default async function ProjectsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  let projects: Project[];
  let members: Member[];
  try {
    [projects, members] = tenant
      ? await Promise.all([listProjects(userId, tenant), listMembers(userId, tenant)])
      : [[], []];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Projects" />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              You don&apos;t have access to this in the current company.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }
  const ownerName = new Map(members.map((m) => [m.user_id, m.name]));

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Projects"
        actions={
          <Link href="/projects/new" className="lux-btn lux-btn--solid lux-btn--sm">
            New project
          </Link>
        }
      />
      <Card>
        {projects.length === 0 ? (
          <div className="dash-empty">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>No projects yet</div>
            <p>Create the first project to get started.</p>
          </div>
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={projects.map((p) => [
              <Link key={p.id} href={`/projects/${p.id}`}>{p.name}</Link>,
              <StatusBadge key={`${p.id}-status`} label={p.status} />,
              p.due_date ?? "—",
              (p.owner_id && ownerName.get(p.owner_id)) ?? "—",
            ])}
          />
        )}
      </Card>
    </>
  );
}
