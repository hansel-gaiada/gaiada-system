import "server-only";
// Employee ("people") view data layer — the per-employee 360. Aggregates the
// tenant-wide lists the UI already consumes and slices them by userId, so it
// works against today's endpoints (no dedicated per-user endpoints required)
// and each source degrades independently.
//
// Access: an employee page is visible to the employee themselves, a superadmin
// (platform_admin) or an owner (group_executive) — see canViewEmployee. The UI
// gate is defence-in-depth; the backend RLS/Cerbos is the real boundary.
import { PlatformError, type Me } from "./platform";
import { readResult } from "./readResult";
import { isElevated } from "@/components/shell/nav";
import {
  listMembers,
  listProjects,
  listTasks,
  listTimeEntries,
  type Project,
  type Task,
  type TimeEntry,
} from "./entities";
import { listUsers, listIdentityLinks, getAudit, type IdentityLink, type AuditEntry } from "./adminData";
import { getOrgStructure, type OrgNode, type OrgKind } from "./org";

// Where an employee sits in the company org tree: the ancestor chain from the
// top department down to the immediate parent (e.g. Web Dev › Frontend ›
// Senior Developer). Empty when the person isn't placed in the structure.
export interface OrgPlacementStep { name: string; kind: OrgKind }

export interface EmployeeProfile {
  id: string;
  name: string;
  email: string;
  title: string | null;
  status: string;
  roles: { role: string; scopeType: string; scopeId: string | null }[];
}

/** Which panels could not be read, and why. `null` = the read succeeded (so an empty panel is real). */
export type PanelKey = "tasks" | "projects" | "timeEntries" | "identityLinks" | "activity" | "placement";
export type PanelRefusal = { kind: "forbidden" } | { kind: "unavailable"; reason: string };

export interface Employee {
  /** AGN-3: a refused panel is no longer indistinguishable from an empty one. The page renders a
   *  `<ReadRefusal>` per entry and shows a dash instead of a confident 0 in the matching KPI. */
  refusals: Partial<Record<PanelKey, PanelRefusal>>;
  profile: EmployeeProfile;
  isSelf: boolean;
  tasks: Task[];
  projects: Project[];
  timeEntries: TimeEntry[];
  identityLinks: IdentityLink[];
  activity: AuditEntry[];
  placement: OrgPlacementStep[];
}

// Self OR elevated (superadmin / owner). Pure — unit-tested.
export function canViewEmployee(me: Me, userId: string): boolean {
  return me.userId === userId || isElevated(me);
}

// Depth-first search for the node assigned to userId; returns the ancestor
// chain (excluding the company root) or [] when unplaced. Pure — unit-tested.
export function findPlacement(root: OrgNode, userId: string): OrgPlacementStep[] {
  function walk(node: OrgNode, trail: OrgPlacementStep[]): OrgPlacementStep[] | null {
    if (node.assigneeId === userId && node.kind !== "company") return trail;
    for (const child of node.children) {
      const found = walk(child, [...trail, { name: node.name, kind: node.kind }]);
      if (found) return found;
    }
    return null;
  }
  // Drop the company root from the trail (the first crumb of any match).
  const chain = walk(root, []);
  return chain ? chain.filter((s) => s.kind !== "company") : [];
}

/**
 * ── SCOPE NARROWED TWICE (AGN-3) ─────────────────────────────────────────────────────────────────
 *
 * Started as `catch { return fallback }` — no discrimination at all — which swallowed a 500, a
 * timeout, a JSON parse error and an outright bug in this file identically to "there is no such
 * row", across all seven panels. An empty panel is a CLAIM ("this person has no tasks") and it was
 * being made on no evidence whatsoever.
 *
 * Then narrowed to absence + 403. Now the SIX PANELS no longer use this at all: they went to
 * `readResult` and report their refusals to the page (see `Employee.refusals`). What is left is the
 * one place degrading is genuinely correct — `resolveProfile`'s FALLBACK CHAIN, which tries `/users`
 * (carries roles) and falls back to `/members` (available to any member). A 403 on the first is not
 * a failure there; it is the reason the second exists.
 *
 * 🔴 RESIDUAL, RECORDED: if BOTH reads are refused, `getEmployee` returns null and the page says
 * "Person not found" — the same conflation, one level up. `canViewEmployee` gates the page first, so
 * a viewer should not normally reach it, which is why this is a residual rather than a live defect.
 * Closing it means resolveProfile returning a ReadResult too; not done here to keep this change to
 * the panels it claims to fix.
 */
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405 || e.status === 403)) {
      return fallback;
    }
    throw e;
  }
}

// Resolve the employee's profile: prefer /users (carries roles); fall back to
// the members list (always available to members) with empty roles.
/**
 * AGN-3 residual, now closed. Both reads are a FALLBACK CHAIN — `/users` carries roles, `/members` is
 * readable by any member — so a 403 on the first is not a failure, it is why the second exists. The
 * defect was what happened when BOTH were refused: this returned null, `getEmployee` returned null,
 * and the page rendered "Person not found". That is a claim about the ESTATE ("no such person")
 * derived from a statement about the VIEWER ("you may not look"), and the two are unrelated.
 *
 * `"refused"` is a third outcome distinct from null: null still means "read fine, no such person".
 */
async function resolveProfile(
  u: string,
  t: string,
  userId: string,
): Promise<EmployeeProfile | null | "refused"> {
  const usersR = await readResult(listUsers(u, t), { absentAsEmpty: [] });
  const users = usersR.kind === "ok" ? usersR.data : [];
  const row = users.find((x) => x.id === userId);
  if (row) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      title: row.title,
      status: row.status,
      roles: row.roles.map((r) => ({ role: r.role, scopeType: r.scopeType, scopeId: r.scopeId })),
    };
  }
  const membersR = await readResult(listMembers(u, t), { absentAsEmpty: [] });
  const members = membersR.kind === "ok" ? membersR.data : [];
  const m = members.find((x) => x.user_id === userId);
  if (m) {
    return { id: m.user_id, name: m.name, email: m.email, title: m.title, status: "active", roles: [] };
  }
  // Neither read found them. Only now does it matter WHY: if both were refused we know nothing about
  // whether this person exists, and must not say they do not.
  if (usersR.kind !== "ok" && membersR.kind !== "ok") return "refused";
  return null;
}

export async function getEmployee(u: string, t: string, userId: string, me: Me): Promise<Employee | null | "refused"> {
  const profile = await resolveProfile(u, t, userId);
  // "refused" propagates so the page can distinguish it from a genuine absence.
  if (profile === "refused") return "refused";
  if (!profile) return null;

  const isSelf = me.userId === userId;

  // AGN-3: each panel now reports WHICH non-answer it got. Previously every one of these degraded a
  // 403 to [] and the page rendered "0 open tasks" / "no linked channels" as fact — a claim about
  // this person built on a refusal to tell us anything about them.
  const [tasksR, projectsR, timeR, linksR, activityR, orgR] = await Promise.all([
    readResult(listTasks(u, t), { absentAsEmpty: [] }),
    readResult(listProjects(u, t), { absentAsEmpty: [] }),
    readResult(listTimeEntries(u, t, isSelf ? { mine: true } : { userId }), { absentAsEmpty: [] }),
    readResult(listIdentityLinks(u, t), { absentAsEmpty: [] }),
    readResult(getAudit(u, t, { actorId: userId, limit: 25 }), { absentAsEmpty: [] }),
    readResult(getOrgStructure(u, t, { id: t, name: profile.name, type: null }), { absentAsEmpty: null }),
  ]);
  const refusals: Partial<Record<PanelKey, PanelRefusal>> = {};
  const take = <T,>(key: PanelKey, r: Awaited<ReturnType<typeof readResult<T>>>, fallback: T): T => {
    if (r.kind === "ok") return r.data;
    refusals[key] = r.kind === "forbidden" ? { kind: "forbidden" } : { kind: "unavailable", reason: r.reason };
    return fallback;
  };
  const allTasks = take("tasks", tasksR, []);
  const allProjects = take("projects", projectsR, []);
  const timeEntries = take("timeEntries", timeR, []);
  const allLinks = take("identityLinks", linksR, []);
  const activity = take("activity", activityR, []);
  const org = take("placement", orgR, null);

  return {
    refusals,
    profile,
    isSelf,
    tasks: allTasks.filter((task) => task.assignee_id === userId),
    projects: allProjects.filter((p) => p.owner_id === userId),
    timeEntries,
    identityLinks: allLinks.filter((l) => l.user_id === userId),
    activity,
    placement: org ? findPlacement(org.structure.root, userId) : [],
  };
}
