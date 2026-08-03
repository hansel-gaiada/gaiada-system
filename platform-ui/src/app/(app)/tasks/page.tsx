import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import { listAllPmTasks } from "@/lib/pm";
import { listTasks } from "@/lib/entities";
import { listMyTasks } from "@/lib/agenda";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";

type Search = Promise<{ assignee?: string; scope?: string }>;

// Single-company view — the original rich PM-backed columns (project,
// assignee, priority, progress). Unchanged from before this ticket.
const COLUMNS: Column[] = [
  { key: "title", header: "Task", sortable: true },
  { key: "project", header: "Project", sortable: true },
  { key: "assignee", header: "Assignee", sortable: true },
  { key: "priority", header: "Priority", sortable: true },
  { key: "progress", header: "Progress", format: "number", sortable: true, align: "right" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

// All-companies view (WSUX-8) — backed by `GET /api/tasks/mine` (WSUX-3),
// which only ever returns the caller's OWN tasks, so there is no
// project/assignee/priority/progress here (those are single-tenant PM
// concepts) — a company column replaces them.
const COLUMNS_ALL: Column[] = [
  { key: "title", header: "Task", sortable: true },
  { key: "company", header: "Company", sortable: true },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
  { key: "due", header: "Due", format: "date", sortable: true, align: "right" },
];

export default async function TasksPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const { assignee, scope: rawScope } = await searchParams;
  const mine = assignee === "me";

  const companies = accessibleCompanies(me);
  const scope = rawScope && companies.some((c) => c.id === rawScope) ? rawScope : "all";

  if (companies.length === 0) {
    return (<><PageHeader eyebrow="Business" title="Tasks" /><EmptyNote>You don&apos;t have access to any company yet.</EmptyNote></>);
  }

  const buildScopeHref = (v: "all" | string) => {
    const p = new URLSearchParams();
    if (v !== "all") p.set("scope", v);
    if (v !== "all" && mine) p.set("assignee", "me"); // the assignee tab is single-company only
    const qs = p.toString();
    return qs ? `/tasks?${qs}` : "/tasks";
  };

  let rows: Record<string, unknown>[];
  let columns: Column[];
  let envelopeBanner: ReactNode = null;

  if (scope === "all") {
    // Cross-company default (WS-UX plan owner decision): the union shim over
    // the forked task model, one company banner if any leg is excluded.
    const { envelope, unavailable } = await listMyTasks(userId, { scope: "all" });
    rows = envelope.items.map((t) => ({ id: t.id, title: t.title, company: t.company, status: t.status, due: t.dueDate }));
    columns = COLUMNS_ALL;
    envelopeBanner = unavailable ? (
      <p className="sys-empty-note" role="status">Cross-company tasks aren&apos;t reachable right now — showing nothing rather than a guess. Try again shortly.</p>
    ) : (
      <EnvelopeBanner companies={envelope.companies} />
    );
  } else {
    // Single-company scope — unchanged behavior, just resolved from the
    // ScopePill's chosen company instead of the top-bar active tenant.
    const tenant = scope;
    const pm = await listAllPmTasks(userId, tenant, mine ? { assignee: "me" } : {});
    if (pm.length > 0) {
      rows = pm.map((t) => ({ id: t.id, title: t.title, project: t.projectName, assignee: t.assignee?.responsibleName ?? "Unassigned", priority: t.priority, progress: t.progress, status: t.status }));
    } else {
      const base = await listTasks(userId, tenant).catch(() => []);
      rows = base.map((t) => ({ id: t.id, title: t.title, project: t.project_name, assignee: t.assignee_id ?? "—", priority: t.priority ?? "—", progress: 0, status: t.status ?? "—" }));
    }
    columns = COLUMNS;
  }

  const tab = (label: string, href: string, active: boolean) => (
    <Link href={href} className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none", ...(active ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}) }}>{label}</Link>
  );

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Tasks"
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <ScopePill companies={companies} value={scope} onChangeHref={buildScopeHref} />
            <Link href="/tasks/new" className="lux-btn lux-btn--solid lux-btn--sm">New task</Link>
          </div>
        }
      />
      {scope !== "all" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {tab("All tasks", `/tasks?scope=${scope}`, !mine)}
          {tab("Assigned to me", `/tasks?scope=${scope}&assignee=me`, mine)}
        </div>
      )}
      {envelopeBanner}
      {rows.length === 0 ? (
        // reva/ui unboxed empty states ("an empty state is a sentence, not a boxed panel") — the
        // Card wrapper is gone. The CONTENT stays: the all-companies leg is assignee-scoped
        // (`/api/tasks/mine` is the only cross-company reader that exists), so "nothing here" does
        // NOT mean "no tasks", and a task you just created unassigned would otherwise look like it
        // was never saved.
        scope === "all" ? (
          <>
            <EmptyNote>
              No tasks assigned to you across your companies. This view shows only your own
              tasks — unassigned tasks and other people&apos;s live under a single company.
            </EmptyNote>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              {companies.map((c) => tab(`All tasks in ${c.name}`, `/tasks?scope=${c.id}`, false))}
            </div>
          </>
        ) : (
          <EmptyNote>{mine ? "No tasks assigned to you." : "No tasks yet. Create one under a project."}</EmptyNote>
        )
      ) : (
        <DataTable columns={columns} rows={rows} link={{ base: "/tasks", idKey: "id", labelKey: "title" }} csvName="tasks" pageSize={25} />
      )}
    </>
  );
}
