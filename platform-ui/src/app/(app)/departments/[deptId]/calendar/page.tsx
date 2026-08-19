import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { AccessDenied } from "@/components/social/AccessDenied";
import { CalendarGrid, type CalendarGridDay } from "@/components/social/CalendarGrid";
import { listPosts, listEngagements, type SocialPost } from "@/lib/social";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ month?: string; engagementId?: string }>;

function parseMonth(raw: string | undefined): { year: number; month: number } {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const [y, m] = raw.split("-").map(Number);
    if (m >= 1 && m <= 12) return { year: y, month: m - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function adjacentMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Sunday-first 6-row grid, always 42 cells so the layout never reflows week to week. */
function buildGridDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(new Date(year, month, 1 - startOffset + i));
  return days;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Calendar (SMM-11, drag-to-reschedule + quota-aware composer added in SMM-12) — the month grid of
// posts and their per-network variant chips, driven entirely by `GET posts` (lib/social.ts's
// `listPosts`), which already carries the variant roll-up (status, schedule, published URL,
// metered cost) — no N+1 read per post. This server component builds the grid/day-grouping as
// plain data and hands it to `CalendarGrid` (a client component — see its own header) for the
// interactive part: dragging a post card to another day.
//
// ⚠ The roll-up does NOT carry network/handle (only `accountId`) — `social.controller.ts`'s
// `listPosts` joins nothing beyond `social_post_variants`, unlike `getPost`'s detail join against
// `social_accounts`. Chips here are therefore STATUS chips, not network chips; open a post in the
// Composer to see which network each variant targets. Flagged in this ticket's final report as a
// real (if minor) BFF-surface gap, not a UI oversight.
export default async function DepartmentCalendarPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const { year, month } = parseMonth(sp.month);
  const prev = adjacentMonth(year, month, -1);
  const next = adjacentMonth(year, month, 1);

  const engagements = await listEngagements(userId, tenant);
  const posts = await listPosts(userId, tenant, { engagementId: sp.engagementId });
  // `social.manage` — the same capability that gates authoring a post/variant in the Composer.
  // Drag-to-reschedule calls `updatePost`/`updateVariant` under the hood, so it rides that same
  // capability rather than inventing a `social.reschedule` key the permission catalog never named.
  const canReschedule = can(me, "social.manage", tenant);

  // A 403 on EITHER read is a denial, not "nothing scheduled" — surface it honestly and stop,
  // rather than rendering an empty-looking grid that reads as "no posts this month."
  if (engagements.forbidden || posts.forbidden) {
    return (
      <Card title="Calendar">
        <AccessDenied what="view the content calendar" />
      </Card>
    );
  }

  // A plain object, not a Map — `CalendarGrid` is a client component, and props crossing the
  // server/client boundary must be plain serializable values.
  const byDay: Record<string, SocialPost[]> = {};
  const unscheduled: SocialPost[] = [];
  for (const p of posts.data) {
    if (!p.scheduledAt) { unscheduled.push(p); continue; }
    const k = dateKey(new Date(p.scheduledAt));
    (byDay[k] ??= []).push(p);
  }

  const gridDays: CalendarGridDay[] = buildGridDays(year, month).map((d) => ({
    key: dateKey(d), dayNumber: d.getDate(), inMonth: d.getMonth() === month,
  }));
  const monthLabel = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const filterHref = (m: { year: number; month: number }) =>
    `/departments/${deptId}/calendar?month=${monthKey(m.year, m.month)}${sp.engagementId ? `&engagementId=${sp.engagementId}` : ""}`;

  return (
    <Card
      title="Calendar"
      headerRight={
        <nav aria-label="Month" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link href={filterHref(prev)} className="lux-btn lux-btn--ghost lux-btn--sm">‹ Prev</Link>
          <span style={{ font: "700 13px var(--font-body)", color: "var(--text-primary)" }}>{monthLabel}</span>
          <Link href={filterHref(next)} className="lux-btn lux-btn--ghost lux-btn--sm">Next ›</Link>
        </nav>
      }
    >
      {engagements.data.length > 1 && (
        <form method="get" aria-label="Engagement filter" style={{ marginBottom: 14 }}>
          <input type="hidden" name="month" value={monthKey(year, month)} />
          <label className="lux-filters__field" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>Engagement</span>
            <select name="engagementId" defaultValue={sp.engagementId ?? ""}>
              <option value="">All engagements</option>
              {engagements.data.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ marginLeft: 8 }}>Filter</button>
        </form>
      )}

      {posts.data.length === 0 ? (
        <TeachState
          glyph="◷"
          title="No posts yet"
          body="Draft a master post and its per-network variants in the Composer — once it carries a scheduled date it appears here."
          ctaLabel="Open Composer"
          ctaHref={`/departments/${deptId}/composer`}
        />
      ) : (
        <CalendarGrid
          tenantId={tenant} deptId={deptId} gridDays={gridDays} byDay={byDay}
          unscheduled={unscheduled} canReschedule={canReschedule}
        />
      )}
    </Card>
  );
}
