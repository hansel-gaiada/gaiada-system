import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import { listMyTasks, type AgendaTaskRow } from "@/lib/agenda";
import { groupMyTasks, isFinishedStatus, todayIsoOf } from "@/lib/myTasks";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
// The rows use the data table's link style (`.dt__link`), which lives in its stylesheet; without it they render as
// default blue underlined links (seen live on 397).
import "@/components/data/data.css";

type Search = Promise<{ show?: string; scope?: string }>;
type Show = "open" | "done" | "all";

const NOTHING_ASSIGNED = "Nothing is assigned to you. This list shows only your own tasks; unassigned tasks and other people’s live inside each project.";

// DW-8a: the person's own tasks across every company they work in, grouped by when they fall due. The
// backend's status filter is exact-match only, so the page reads once and splits open from done itself.
export default async function MyTasksPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const { show: rawShow, scope: rawScope } = await searchParams;
  const show: Show = rawShow === "done" || rawShow === "all" ? rawShow : "open";

  const companies = accessibleCompanies(me);
  const scope = rawScope && companies.some((c) => c.id === rawScope) ? rawScope : "all";
  const multi = companies.length > 1;

  const href = (s: Show, sc: string) => {
    const p = new URLSearchParams();
    if (s !== "open") p.set("show", s);
    if (sc !== "all") p.set("scope", sc);
    const qs = p.toString();
    return qs ? `/me/tasks?${qs}` : "/me/tasks";
  };

  const { envelope, unavailable } = await listMyTasks(userId, { scope });
  const open = envelope.items.filter((t) => !isFinishedStatus(t.status));
  const flat = show === "done" ? envelope.items.filter((t) => isFinishedStatus(t.status)) : envelope.items;

  const filters: { key: Show; label: string }[] = [{ key: "open", label: "Open" }, { key: "done", label: "Done" }, { key: "all", label: "All" }];

  const renderRow = (t: AgendaTaskRow) => (
    <li key={`${t.source}:${t.id}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--erp-border)" }}>
      <Link href={t.href} className="dt__link" style={{ flex: "1 1 240px", minWidth: 0 }}>{t.title}</Link>
      {multi && <span className="sys-empty-note" style={{ margin: 0 }}>{t.company}</span>}
      <StatusBadge label={t.status} />
      <span style={{ minWidth: 96, textAlign: "right" }}>{t.dueDate ? formatDate(t.dueDate) : "No due date"}</span>
    </li>
  );

  let body;
  if (unavailable) {
    body = <p className="sys-empty-note" role="status">Your tasks aren&apos;t reachable right now, so nothing is shown rather than a guess. Try again shortly.</p>;
  } else if (show === "open") {
    body = open.length === 0 ? (
      <EmptyNote>{NOTHING_ASSIGNED}</EmptyNote>
    ) : (
      groupMyTasks(open, todayIsoOf()).map((g) => (
        <section key={g.key} aria-labelledby={`mytasks-${g.key}`} style={{ marginBottom: 20 }}>
          <h2 id={`mytasks-${g.key}`} style={{ fontSize: 15, margin: "0 0 4px" }}>{g.label} ({g.rows.length})</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{g.rows.map(renderRow)}</ul>
        </section>
      ))
    );
  } else if (flat.length === 0) {
    body = <EmptyNote>{show === "done" ? "No finished tasks yet." : NOTHING_ASSIGNED}</EmptyNote>;
  } else {
    body = <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{flat.map(renderRow)}</ul>;
  }

  return (
    <>
      <PageHeader
        eyebrow="You"
        title="My tasks"
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {multi && <ScopePill companies={companies} value={scope} onChangeHref={(v) => href(show, v)} />}
            <Link href="/tasks/new" className="lux-btn lux-btn--solid lux-btn--sm">New task</Link>
          </div>
        }
      />
      <nav aria-label="Task filter" style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {filters.map((f) => {
          const active = f.key === show;
          return (
            <Link
              key={f.key}
              href={href(f.key, scope)}
              className="lux-btn lux-btn--ghost lux-btn--sm"
              aria-current={active ? "page" : undefined}
              style={{ textDecoration: "none", ...(active ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}) }}
            >{f.label}</Link>
          );
        })}
      </nav>
      {!unavailable && <EnvelopeBanner companies={envelope.companies} />}
      {body}
    </>
  );
}
