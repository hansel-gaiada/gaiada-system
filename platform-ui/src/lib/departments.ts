import "server-only";
// Department workspaces — a "place to work" per department, composed from data
// that already exists: the org structure (lib/org) gives each department its
// divisions + placed people; PM tasks (lib/pm) are routed to a department via
// their poly-assignee (kind=department|division refId, or a responsible person
// who sits in the department). No new backend/table needed; when work is tagged
// to a unit or a unit's person, it shows up on that department's board.
import { getOrgStructure, type OrgNode } from "./org";
import { listAllPmTasks, groupByStatus, type PmTask, type BoardColumn } from "./pm";

export interface DeptPerson { id: string; name: string }
export interface DeptDivision { id: string; name: string; people: DeptPerson[] }
export interface DeptSummary { id: string; name: string; divisions: number; people: number; openTasks: number }
export interface DepartmentWorkspace {
  id: string;
  name: string;
  divisions: DeptDivision[];
  people: DeptPerson[];
  tasks: PmTask[];
  columns: BoardColumn[];
}

const company = (t: string) => ({ id: t, name: t, type: null });

// Everything (division ids, person ids/list) inside a department subtree.
function scan(dept: OrgNode) {
  const divisionIds = new Set<string>();
  const personIds = new Set<string>();
  const people: DeptPerson[] = [];
  const divisions: DeptDivision[] = [];
  const collectPeople = (n: OrgNode, into: DeptPerson[]) => {
    for (const c of n.children) {
      if (c.kind === "person" && c.assigneeId) { const p = { id: c.assigneeId, name: c.assigneeName ?? c.name }; into.push(p); if (!people.some((x) => x.id === p.id)) people.push(p); personIds.add(c.assigneeId); }
      collectPeople(c, into);
    }
  };
  for (const child of dept.children) {
    if (child.kind === "division") {
      divisionIds.add(child.id);
      const dp: DeptPerson[] = [];
      collectPeople(child, dp);
      divisions.push({ id: child.id, name: child.name, people: dp });
    }
  }
  // People placed directly under the department (e.g. Social Media / GM with no divisions).
  collectPeople({ ...dept, children: dept.children.filter((c) => c.kind !== "division") }, []);
  return { divisionIds, personIds, people, divisions };
}

function belongs(task: PmTask, deptId: string, divisionIds: Set<string>, personIds: Set<string>): boolean {
  const a = task.assignee;
  if (!a) return false;
  if (a.kind === "department" && a.refId === deptId) return true;
  if (a.kind === "division" && divisionIds.has(a.refId)) return true;
  if (a.responsibleId && personIds.has(a.responsibleId)) return true;
  if (a.kind === "person" && personIds.has(a.refId)) return true;
  return false;
}

async function departmentNodes(u: string, t: string): Promise<OrgNode[]> {
  try {
    const { structure } = await getOrgStructure(u, t, company(t));
    return structure.root.children.filter((c) => c.kind === "department");
  } catch { return []; }
}

export async function listDepartments(u: string, t: string): Promise<DeptSummary[]> {
  const [depts, tasks] = await Promise.all([departmentNodes(u, t), listAllPmTasks(u, t)]);
  return depts.map((d) => {
    const { divisionIds, personIds, people, divisions } = scan(d);
    const open = tasks.filter((x) => x.status !== "done" && belongs(x, d.id, divisionIds, personIds)).length;
    return { id: d.id, name: d.name, divisions: divisions.length, people: people.length, openTasks: open };
  });
}

export interface MyPlacement { deptId: string; deptName: string; divisionName: string | null }
// Where the signed-in employee sits in the active company's org (their department +
// division), for the sidebar "My team" shortcut. Null when they aren't placed.
export async function myPlacement(u: string, t: string, userId: string): Promise<MyPlacement | null> {
  const depts = await departmentNodes(u, t);
  for (const d of depts) {
    // direct under department (no-division depts)
    if (d.children.some((c) => c.kind === "person" && c.assigneeId === userId)) return { deptId: d.id, deptName: d.name, divisionName: null };
    for (const v of d.children.filter((c) => c.kind === "division")) {
      let hit = false;
      const walk = (n: OrgNode) => { for (const c of n.children) { if (c.kind === "person" && c.assigneeId === userId) hit = true; walk(c); } };
      walk(v);
      if (hit) return { deptId: d.id, deptName: d.name, divisionName: v.name };
    }
  }
  return null;
}

export async function getDepartment(u: string, t: string, deptId: string): Promise<DepartmentWorkspace | null> {
  const [depts, tasks] = await Promise.all([departmentNodes(u, t), listAllPmTasks(u, t)]);
  const d = depts.find((x) => x.id === deptId);
  if (!d) return null;
  const { divisionIds, personIds, people, divisions } = scan(d);
  const deptTasks = tasks.filter((x) => belongs(x, d.id, divisionIds, personIds));
  return { id: d.id, name: d.name, divisions, people, tasks: deptTasks, columns: groupByStatus(deptTasks) };
}
