import "server-only";
// Employee ("people") view data layer — the per-employee 360. Aggregates the
// tenant-wide lists the UI already consumes and slices them by userId, so it
// works against today's endpoints (no dedicated per-user endpoints required)
// and each source degrades independently.
//
// Access: an employee page is visible to the employee themselves, a superadmin
// (platform_admin) or an owner (group_executive) — see canViewEmployee. The UI
// gate is defence-in-depth; the backend RLS/Cerbos is the real boundary.
import type { Me } from "./platform";
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

export interface Employee {
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

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

// Resolve the employee's profile: prefer /users (carries roles); fall back to
// the members list (always available to members) with empty roles.
async function resolveProfile(u: string, t: string, userId: string): Promise<EmployeeProfile | null> {
  const users = await safe(listUsers(u, t), []);
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
  const members = await safe(listMembers(u, t), []);
  const m = members.find((x) => x.user_id === userId);
  if (!m) return null;
  return { id: m.user_id, name: m.name, email: m.email, title: m.title, status: "active", roles: [] };
}

export async function getEmployee(u: string, t: string, userId: string, me: Me): Promise<Employee | null> {
  const profile = await resolveProfile(u, t, userId);
  if (!profile) return null;

  const isSelf = me.userId === userId;

  const [allTasks, allProjects, timeEntries, allLinks, activity, org] = await Promise.all([
    safe(listTasks(u, t), []),
    safe(listProjects(u, t), []),
    safe(listTimeEntries(u, t, isSelf ? { mine: true } : { userId }), []),
    safe(listIdentityLinks(u, t), []),
    safe(getAudit(u, t, { actorId: userId, limit: 25 }), []),
    safe(getOrgStructure(u, t, { id: t, name: profile.name, type: null }), null),
  ]);

  return {
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
