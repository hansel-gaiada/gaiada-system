import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { accessibleCompanies, isManagerTier } from "@/lib/rbac";
import { getMyWorkQueue } from "@/lib/queue";
import { getActivity, weeklyThroughput } from "@/lib/data";
import { myPlacement } from "@/lib/departments";
import { getCheckinCardData } from "@/lib/checkins-data";
import { submitCheckin } from "@/lib/checkinActions";
import { Eyebrow } from "@/components/ui";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import { BackendPending } from "@/components/BackendPending";
import type { QueueFilter } from "@/components/dashboard/FilterChips";
import { CommandCenterHome } from "@/components/dashboard/CommandCenterHome";
import { QueueAgendaHome } from "@/components/dashboard/QueueAgendaHome";
import { listMyTasks } from "@/lib/agenda";
import type { QueueItem } from "@/lib/queueUrgency";
import { CheckinCard } from "@/components/dashboard/CheckinCard";
import { decideQueueItem } from "./actions";

function timeOfDay(): string {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

const FILTER_KEYS: QueueFilter[] = ["overdue", "due_today", "approvals", "mentions"];
function parseFilter(raw: string | undefined): QueueFilter | undefined {
  return FILTER_KEYS.includes(raw as QueueFilter) ? (raw as QueueFilter) : undefined;
}

type SearchParams = Promise<{ scope?: string; filter?: string }>;

// The role-differentiated Home (UX-2 §1, WSUX-5 headline). Scope defaults to
// ALL companies (owner decision 2); manager-tier gets the Command Center
// (§1.2 A2), everyone else gets the Queue+Agenda hybrid (A1×A3). Both share
// ONE ranked queue — `getMyWorkQueue` (R-1) — so there is no drift between
// what a manager and an IC see for the same underlying work.
export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  // An external client has no business on the staff dashboard. `navFor` has always given a
  // client-only user portal-only navigation, but NOTHING sent them there: login returns to `/`, so a
  // client landed on My Work — a staff queue/agenda that resolves to nothing for them (every read
  // 403s and degrades) and made their own projects something they had to go find in the sidebar.
  //
  // The client -> /portal redirect moved UP to `(app)/layout.tsx`: on this page alone it still let a
  // client reach /projects or /tasks and get the staff shell. One guard, at the group boundary.

  const tenantId = await getActiveTenant(me);
  const { scope: rawScope, filter: rawFilter } = await searchParams;
  const firstName = me.name.split(/\s+/)[0];

  const companies = accessibleCompanies(me);
  const scope = rawScope && companies.some((c) => c.id === rawScope) ? rawScope : "all";
  const filter = parseFilter(rawFilter);

  const [queue, placement, activity, checkinData, mine] = await Promise.all([
    getMyWorkQueue(me, userId, companies),
    tenantId ? myPlacement(userId, tenantId, userId).catch(() => null) : Promise.resolve(null),
    tenantId ? getActivity(userId, tenantId) : Promise.resolve([]),
    tenantId ? getCheckinCardData(tenantId, userId) : Promise.resolve(null),
    // The agenda cannot come from the queue's own task leg: that reads
    // GET /api/:t/tasks?assignee=me — the LEGACY flat `tasks` table — while every task the app
    // actually creates lives in `pm_tasks`. On live data that endpoint returns [], so "Your work"
    // rendered "Nothing scheduled" while the same user had four open PM tasks. /api/tasks/mine is
    // the reader that spans both models (it is what /calendar uses), so the agenda uses it directly.
    // NOTE: the queue's ranking still misses PM tasks entirely — an overdue PM task never reaches
    // "Needs you". That is a deeper fix in lib/queue.ts (shared with the department rail and its
    // tests) and is deliberately NOT smuggled in here.
    listMyTasks(userId, { scope: "all" }).then((r) => r.envelope.items).catch(() => []),
  ]);

  // Scope=one company: filter the queue, no envelope banner (UX-2 §4.3 — the
  // envelope is an ALL-scope concern only). Scope=all: show everything the
  // fan-out returned, plus the banner if any company was excluded.
  const scopedItems = scope === "all" ? queue.items : queue.items.filter((i) => i.companyId === scope);
  const agendaItems: QueueItem[] = mine
    .filter((t) => t.status !== "done" && (scope === "all" || t.tenantId === scope))
    .map((t) => ({
      id: `mine:${t.id}`, type: "task" as const, title: t.title, companyId: t.tenantId,
      company: t.company, href: t.href, dueDate: t.dueDate, createdAt: "", decidable: true,
      urgencyScore: 0,
    }));
  const manager = isManagerTier(me);
  const throughput = weeklyThroughput(activity);

  const buildScopeHref = (v: "all" | string) => {
    const p = new URLSearchParams();
    if (v !== "all") p.set("scope", v);
    if (filter) p.set("filter", filter);
    const qs = p.toString();
    return qs ? `/?${qs}` : "/";
  };
  const buildFilterHref = (next: QueueFilter | undefined) => {
    const p = new URLSearchParams();
    if (scope !== "all") p.set("scope", scope);
    if (next) p.set("filter", next);
    const qs = p.toString();
    return qs ? `/?${qs}` : "/";
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 22 }}>
        <div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>
            {manager ? "Command center" : "Your workspace"}
          </Eyebrow>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>
            Good {timeOfDay()}, {firstName}
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ScopePill companies={companies} value={scope} onChangeHref={buildScopeHref} />
          {placement && (
            <Link href={`/departments/${placement.deptId}`} className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>
              My department: {placement.deptName}{placement.divisionName ? ` · ${placement.divisionName}` : ""} →
            </Link>
          )}
        </div>
      </div>

      {scope === "all" && <EnvelopeBanner companies={queue.companies} />}

      {/* TR-10 — the mandatory EOD check-in, on My Work (its natural home): scope-independent
          (a check-in is about the person, not a company filter) and shown to every tier, manager
          or IC alike, ahead of the role-split queue below. */}
      {tenantId && (
        checkinData ? (
          <CheckinCard
            tenantId={tenantId}
            today={checkinData.today}
            selfCompliance={checkinData.selfCompliance}
            submitAction={submitCheckin}
          />
        ) : (
          <BackendPending
            what="Today's check-in card needs the check-in endpoints."
            contract="GET/POST /api/:t/checkins, GET /api/:t/checkins/today"
          />
        )
      )}

      {manager ? (
        <CommandCenterHome
          items={scopedItems}
          filter={filter}
          buildFilterHref={buildFilterHref}
          decide={decideQueueItem}
          throughput={throughput}
          agendaItems={agendaItems}
        />
      ) : (
        <QueueAgendaHome items={scopedItems} decide={decideQueueItem} agendaItems={agendaItems} />
      )}
    </>
  );
}
