import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects, listMembers } from "@/lib/entities";
import { listWorkActivity, objectLabel, activityHref, humanizeVerb, actorLabel } from "@/lib/activity";
import { Card } from "@/components/ui";
import { ActivityFeed, type ActivityItem } from "@/components/departments/ActivityFeed";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async.
type SearchParams = Promise<{ projectId?: string; personId?: string }>;

const FULL_FEED_LIMIT = 200;

// Activity — the full-length cross-source feed (F2 `work_activity`). Same
// component Home renders as a compact preview; this tab shows it at full
// length, filterable by owned project and person (P1-07). Filters are a
// plain GET form (no client JS) — mirrors /admin/audit's filter pattern.
export default async function DepartmentActivityPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const projectId = sp.projectId ?? "";
  const personId = sp.personId ?? "";

  const [allProjects, members, feed] = await Promise.all([
    listProjects(userId, tenant).catch(() => []),
    listMembers(userId, tenant).catch(() => []),
    listWorkActivity(userId, tenant, {
      deptId,
      projectId: projectId || undefined,
      personId: personId || undefined,
      limit: FULL_FEED_LIMIT,
    }),
  ]);
  const owned = allProjects.filter((p) => p.department_id === deptId);
  const nameById = new Map(members.map((mm) => [mm.user_id, mm.name]));

  const items: ActivityItem[] = feed.map((row) => ({
    id: row.id,
    actor: actorLabel(row, Object.fromEntries(nameById)),
    automated: !row.actorUserId,
    verb: humanizeVerb(row.verb),
    objectLabel: objectLabel(row),
    href: activityHref(row),
    occurredAt: row.occurredAt,
    source: row.source,
  }));

  return (
    <>
      <Card style={{ marginBottom: 20 }}>
        <form className="lux-filters" method="get" aria-label="Activity filters">
          <label className="lux-filters__field">
            <span>Project</span>
            <select name="projectId" defaultValue={projectId}>
              <option value="">All owned projects</option>
              {owned.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="lux-filters__field">
            <span>Person</span>
            <select name="personId" defaultValue={personId}>
              <option value="">Everyone</option>
              {members.map((mm) => (
                <option key={mm.user_id} value={mm.user_id}>{mm.name}</option>
              ))}
            </select>
          </label>
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
            <a href={`/departments/${deptId}/activity`} className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
          </div>
        </form>
      </Card>

      <Card title="Activity">
        <ActivityFeed
          items={items}
          nowIso={new Date().toISOString()}
          emptyTitle={projectId || personId ? "No activity matches these filters" : undefined}
          emptyBody={projectId || personId ? "Try a broader project or person, or reset the filters above." : undefined}
        />
      </Card>
    </>
  );
}
