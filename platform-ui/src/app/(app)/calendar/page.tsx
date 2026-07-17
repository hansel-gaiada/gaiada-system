import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAllPmTasks } from "@/lib/pm";
import { listDeliverables, listProjects } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card, StatusBadge, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate } from "@/lib/format";

interface Item { date: string; kind: "task" | "deliverable" | "project"; title: string; href?: string; status: string; who?: string }

function bucketLabel(dateISO: string, today: string): string {
  const d = new Date(dateISO), t = new Date(today);
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (days < 0) return "Overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days <= 7) return "This week";
  if (days <= 30) return "This month";
  return "Later";
}
const ORDER = ["Overdue", "Today", "Tomorrow", "This week", "This month", "Later"];

export default async function CalendarPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Workspace" title="Calendar" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  const [tasks, deliverables, projects] = await Promise.all([
    listAllPmTasks(userId, tenant), listDeliverables(userId, tenant), listProjects(userId, tenant).catch(() => []),
  ]);

  const items: Item[] = [];
  for (const t of tasks) if (t.dueDate && t.status !== "done") items.push({ date: t.dueDate, kind: "task", title: t.title, href: `/tasks/${t.id}`, status: t.status, who: t.assignee?.responsibleName });
  for (const d of deliverables) if (d.due_date && d.status !== "done") items.push({ date: d.due_date, kind: "deliverable", title: d.name, status: d.status });
  for (const p of projects) if (p.due_date && p.status !== "completed" && p.status !== "archived") items.push({ date: p.due_date, kind: "project", title: p.name, href: `/projects/${p.id}`, status: p.status });
  items.sort((a, b) => a.date.localeCompare(b.date));

  const today = new Date().toISOString().slice(0, 10);
  const buckets = new Map<string, Item[]>();
  for (const it of items) {
    const b = bucketLabel(it.date, today);
    const arr = buckets.get(b) ?? [];
    arr.push(it);
    buckets.set(b, arr);
  }

  // Workload: open tasks per responsible person.
  const load = new Map<string, number>();
  for (const t of tasks) if (t.status !== "done") { const w = t.assignee?.responsibleName ?? "Unassigned"; load.set(w, (load.get(w) ?? 0) + 1); }
  const workload = [...load.entries()].sort((a, b) => b[1] - a[1]);
  const maxLoad = Math.max(1, ...workload.map(([, n]) => n));

  const overdue = (buckets.get("Overdue") ?? []).length;

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Calendar" subtitle="Everything with a due date across this company — tasks, deliverables and projects." />

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Due items" value={String(items.length)} />
        <KpiTile label="Overdue" value={String(overdue)} />
        <KpiTile label="Due today" value={String((buckets.get("Today") ?? []).length)} />
        <KpiTile label="This week" value={String((buckets.get("This week") ?? []).length + (buckets.get("Tomorrow") ?? []).length)} />
      </div>

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "1.6fr 1fr", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {items.length === 0 ? (
            <Card><EmptyNote>Nothing scheduled. Due dates on tasks, deliverables and projects show up here.</EmptyNote></Card>
          ) : ORDER.filter((b) => buckets.has(b)).map((b) => (
            <Card key={b} title={b} headerRight={<span style={{ font: "700 10px var(--font-body)", letterSpacing: ".08em", textTransform: "uppercase", color: b === "Overdue" ? "#B5622F" : "var(--erp-ink-50)" }}>{buckets.get(b)!.length}</span>}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {buckets.get(b)!.map((it, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "0.5px solid var(--erp-hairline-soft)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span style={{ font: "700 9px var(--font-body)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--erp-ink-50)", border: "0.5px solid var(--erp-hairline)", padding: "2px 6px" }}>{it.kind}</span>
                      {it.href ? <Link href={it.href} style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)", textDecoration: "none" }}>{it.title}</Link> : <span style={{ font: "400 14px var(--font-body)" }}>{it.title}</span>}
                      {it.who && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>· {it.who}</span>}
                    </span>
                    <span style={{ display: "inline-flex", gap: 10, alignItems: "center", whiteSpace: "nowrap" }}>
                      <StatusBadge label={it.status} />
                      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{formatDate(it.date)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>

        <Card title="Workload — open tasks">
          {workload.length === 0 ? <EmptyNote>No open tasks.</EmptyNote> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {workload.map(([who, n]) => (
                <div key={who} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", font: "400 13px var(--font-body)" }}><span>{who}</span><span style={{ color: "var(--erp-ink-50)" }}>{n}</span></div>
                  <span style={{ height: 6, background: "rgba(26,25,22,.08)", position: "relative" }}><span style={{ position: "absolute", inset: "0 auto 0 0", width: `${(n / maxLoad) * 100}%`, background: "var(--erp-accent)" }} /></span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
