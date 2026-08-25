import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listProjects } from "@/lib/entities";
import { listAllPmTasksPaged } from "@/lib/pm";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate } from "@/lib/format";

// CC-3 — the Work tab: this client's projects, and their tasks grouped under them.
//
// ── BOTH READS ARE SERVER-FILTERED ──────────────────────────────────────────────────────────────
// `listProjects(.., clientId)` and `listAllPmTasksPaged(.., { clientId })` push the client down to
// SQL (CC-1). The alternative — fetch the tenant's work and narrow in the browser — is what the old
// client page did for projects, and it stops being a filter the moment a tenant has more rows than
// one page: the reader gets a silently truncated list that looks complete.
//
// ── TASKS ARE GROUPED BY PROJECT, NOT LISTED FLAT ───────────────────────────────────────────────
// A flat task list is what `/tasks` already is. The reason to look at work through a client is to see
// which of THEIR projects is moving and which is stuck, so the project is the unit and the tasks hang
// off it. A project with no tasks still renders — an empty project is a finding, not a row to hide.
export default async function ClientWorkPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const [projects, tasks] = await Promise.all([
    listProjects(userId, tenant, clientId).catch(() => []),
    // `includeClosed` defaults to true in the reader; kept explicit because "Done" tasks are part of
    // the story a client's work tells — a project reading 100% with nothing listed is not a finding.
    listAllPmTasksPaged(userId, tenant, { clientId, includeClosed: true }),
  ]);

  if (projects.length === 0) {
    return (
      <EmptyNote>
        This client has no projects yet. Create one from <Link href="/projects">Projects</Link> and it
        will appear here — along with its tasks, milestones and deliverables.
      </EmptyNote>
    );
  }

  const byProject = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const list = byProject.get(t.projectId);
    if (list) list.push(t);
    else byProject.set(t.projectId, [t]);
  }

  // Tasks whose project is not in this client's project list. Should be empty — both reads apply the
  // same server-side client predicate — so if it is ever non-empty the two filters disagree, which is
  // worth SHOWING rather than silently dropping. An orphan here means one of them is wrong.
  const projectIds = new Set(projects.map((p) => p.id));
  const orphans = tasks.filter((t) => !projectIds.has(t.projectId));

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {projects.map((p) => {
        const own = byProject.get(p.id) ?? [];
        const done = own.filter((t) => t.status === "done").length;
        const overdue = own.filter((t) => t.status !== "done" && t.dueDate && t.dueDate < todayIso()).length;
        return (
          <Card
            key={p.id}
            title={p.name}
            headerRight={
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                {overdue > 0 && <StatusBadge label={`${overdue} overdue`} />}
                <StatusBadge label={p.status} />
              </span>
            }
          >
            <p style={{ margin: "0 0 10px", font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
              {own.length === 0 ? "No tasks yet" : `${done}/${own.length} tasks done`}
              {p.due_date ? ` · due ${formatDate(p.due_date)}` : ""}
              {" · "}
              <Link href={`/projects/${p.id}`} style={{ color: "var(--erp-accent)", textDecoration: "none" }}>
                open project
              </Link>
            </p>
            {own.length === 0 ? (
              <EmptyNote>Nothing has been broken down on this project yet.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Task" }, { label: "Status" }, { label: "Ball" }, { label: "Due" }]}
                rows={own.map((t) => [
                  <Link key="t" href={`/tasks/${t.id}`} style={{ color: "var(--ink-strong)", textDecoration: "none" }}>
                    {t.title}
                  </Link>,
                  <StatusBadge key="s" label={t.status} />,
                  t.assignee?.refName ?? "—",
                  t.dueDate ? formatDate(t.dueDate) : "—",
                ])}
              />
            )}
          </Card>
        );
      })}

      {orphans.length > 0 && (
        <Card title={`Tasks outside this client's projects · ${orphans.length}`} hint="This should be empty. If it is not, the project filter and the task filter disagree about which projects belong to this client — surfaced rather than dropped, because a dropped row is invisible.">
          <HairlineTable
            columns={[{ label: "Task" }, { label: "Project" }]}
            rows={orphans.map((t) => [t.title, t.projectName])}
          />
        </Card>
      )}
    </div>
  );
}

/** Local `today` in ISO, computed once per render. Not imported from `pmUrgency` because this page
 *  needs only a string comparison against `dueDate` (also a `YYYY-MM-DD` string), and string
 *  comparison on ISO dates is correct without parsing either side into a Date. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
