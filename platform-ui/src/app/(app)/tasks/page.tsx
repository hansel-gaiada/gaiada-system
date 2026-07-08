import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listTasks, type Task } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";

const COLUMNS = [{ label: "Title" }, { label: "Project" }, { label: "Priority" }, { label: "Due date" }, { label: "Status", align: "right" as const }];
const TCOLS = "2fr 1.5fr 1fr 1fr 1fr";

export default async function TasksPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  let tasks: Task[];
  try {
    tasks = tenant ? await listTasks(userId, tenant) : [];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Tasks" />
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

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Tasks"
        actions={
          <Link href="/tasks/new" className="lux-btn lux-btn--solid lux-btn--sm">
            New task
          </Link>
        }
      />
      <Card>
        {tasks.length === 0 ? (
          <div className="dash-empty">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>No tasks yet</div>
            <p>Create the first task under a project to get started.</p>
          </div>
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={tasks.map((t) => [
              <Link key={t.id} href={`/tasks/${t.id}`}>{t.title}</Link>,
              <Link key={`${t.id}-project`} href={`/projects/${t.project_id}`}>{t.project_name}</Link>,
              t.priority ?? "—",
              t.due_date ?? "—",
              <StatusBadge key={`${t.id}-status`} label={t.status ?? "—"} />,
            ])}
          />
        )}
      </Card>
    </>
  );
}
