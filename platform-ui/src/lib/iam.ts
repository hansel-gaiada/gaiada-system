import "server-only";
// P2-10 / P2-11 / P2-12-FE — the IAM Phase 2 data layer: employees, positions, role grants.
//
// BFF CONTRACT (all BUILT; rows in docs/FRONTEND-BFF-CONTRACT.md's "IAM Phase 2" sections):
//   GET    /api/:t/hr/employees[?status]                    -> { employees[] }
//   GET    /api/:t/hr/employees/:id                         -> Employee & { seats[] }
//   POST   /api/:t/hr/employees                             -> Employee & { reconciled }
//   PATCH  /api/:t/hr/employees/:id                         -> Employee
//   POST   /api/:t/hr/employees/:id/transfer                -> { ok, closedAssignmentIds[], reconciled }
//   POST   /api/:t/hr/employees/:id/terminate               -> { ok, userDisabled, itFollowUp, … }
//   GET    /api/:t/positions                                -> { positions[], scope: tenant|subtree }
//   GET    /api/:t/positions/attachable-roles               -> { roles[] }
//   POST   /api/:t/positions · PATCH /:id · POST /:id/retire
//   POST   /api/:t/positions/:id/roles · DELETE /:id/roles/:roleId
//   POST   /api/:t/positions/:id/assign · /unassign · /assignment-requests
//   GET    /api/:t/role-grants?userId=                      -> { userId, grants[] }
//   POST   /api/:t/role-grants · DELETE /:grantId · POST /role-grants/overrides
//
// ── WHAT DEGRADES AND WHAT DOES NOT ──────────────────────────────────────────────────────────────
// The READS here degrade to empty on 403/404, matching every other reader in this codebase: an empty
// positions list is honestly "no seats defined", and an empty grant list for a user is honestly "no
// manual grants". Neither asserts anything false.
//
// That is the OPPOSITE of `lib/it-accounts.ts`, and the difference is worth stating: there, an empty
// list claims "everyone has a login". Here it claims nothing. The rule is not "always degrade" or
// "never degrade" — it is "ask what the empty case asserts". See [[empty-list-is-a-claim]].
//
// The one exception is `listPositions`' `scope`, which is NOT a cosmetic label: `subtree` means the
// server narrowed the result to the caller's own lead units, and a page that renders a narrowed list
// as if it were the whole company would mislead a department head about what exists.
import { platformFetch, PlatformError } from "./platform";

// ── employees ────────────────────────────────────────────────────────────────────────────────────

export type EmploymentStatus = "pending_start" | "active" | "on_leave" | "terminated";
export const EMPLOYMENT_STATUSES: EmploymentStatus[] = ["pending_start", "active", "on_leave", "terminated"];

export interface Employee {
  id: string;
  tenantId: string;
  userId: string | null;
  displayName: string;
  legalName: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  phone: string | null;
  hireDate: string | null;
  employmentStatus: EmploymentStatus;
  terminatedAt: string | null;
  managerUserId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Seat {
  assignmentId: string;
  positionId: string;
  title: string;
  unitNodeId: string;
  validFrom: string;
  validTo: string | null;
  current: boolean;
}

export type EmployeeDetail = Employee & { seats: Seat[] };

export async function listEmployees(u: string, t: string, status?: string): Promise<Employee[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const res = await platformFetch<{ employees: Employee[] }>(`/api/${t}/hr/employees${qs}`, u);
    return res.employees ?? [];
  } catch {
    return [];
  }
}

export async function getEmployee(u: string, t: string, employeeId: string): Promise<EmployeeDetail | null> {
  try {
    return await platformFetch<EmployeeDetail>(`/api/${t}/hr/employees/${employeeId}`, u);
  } catch {
    return null;
  }
}

/** The employee record for a PLATFORM USER, which is what `/people/[userId]` has in hand. There is no
 *  by-user endpoint, so this filters the list — cheap at this scale and honest about being a lookup
 *  rather than pretending to be a fetch. */
export async function getEmployeeForUser(u: string, t: string, userId: string): Promise<EmployeeDetail | null> {
  const all = await listEmployees(u, t);
  const match = all.find((e) => e.userId === userId);
  return match ? await getEmployee(u, t, match.id) : null;
}

// ── positions ────────────────────────────────────────────────────────────────────────────────────

export type PositionStatus = "active" | "retired" | "orphaned";
export type ScopeKind = "company" | "own_unit";

export interface RoleSetEntry {
  roleId: string;
  role: string;
  scopeKind: ScopeKind;
}

export interface Position {
  id: string;
  tenantId: string;
  unitNodeId: string;
  title: string;
  isLead: boolean;
  status: PositionStatus;
  orphaned: boolean;
  roleSet: RoleSetEntry[];
  currentHolders: number;
  createdAt: string;
  updatedAt: string;
}

/** `scope` is load-bearing — see the header. `null` means the read failed or was refused. */
export interface PositionsResult {
  positions: Position[];
  scope: "tenant" | "subtree" | null;
}

export async function listPositions(u: string, t: string): Promise<PositionsResult> {
  try {
    const res = await platformFetch<{ positions: Position[]; scope: "tenant" | "subtree" }>(
      `/api/${t}/positions`,
      u,
    );
    return { positions: res.positions ?? [], scope: res.scope ?? null };
  } catch {
    return { positions: [], scope: null };
  }
}

export interface AttachableRole {
  roleId: string;
  role: string;
  attachable: boolean;
  /** Present when `attachable` is false — `denied_role_registry` or `not_ui_grantable: <keys>`. */
  reason: string | null;
}

/** The composer's option list. Unattachable roles come back WITH a reason and must be rendered
 *  disabled-with-explanation, never filtered out: the server is the allow-list, and a UI that hides
 *  the refusal turns a stated boundary into an invisible one. */
export async function listAttachableRoles(u: string, t: string): Promise<AttachableRole[]> {
  try {
    const res = await platformFetch<{ roles: AttachableRole[] }>(`/api/${t}/positions/attachable-roles`, u);
    return res.roles ?? [];
  } catch {
    return [];
  }
}

// ── role grants ──────────────────────────────────────────────────────────────────────────────────

export type GrantSource = "manual" | "position" | "service_assignment";

export interface RoleGrant {
  grantId: string;
  role: string;
  scopeType: string;
  scopeId: string | null;
  source: GrantSource;
  expiresAt: string | null;
  originApprovalId: string | null;
  /** False for position- or service-managed grants: hand-revoking one makes the reconciler restore it
   *  and the operator conclude the UI lied. Render those without a revoke control at all. */
  revocable: boolean;
}

export async function listRoleGrants(u: string, t: string, userId: string): Promise<RoleGrant[]> {
  try {
    const res = await platformFetch<{ userId: string; grants: RoleGrant[] }>(
      `/api/${t}/role-grants?userId=${encodeURIComponent(userId)}`,
      u,
    );
    return res.grants ?? [];
  } catch {
    return [];
  }
}

/** Can this viewer read grants at all? A 403 from the grants endpoint is the server's answer to "do
 *  you have `role_grant · read` for this target", and it is the gate P2-11's page is reachable behind.
 *  Distinguished from "no grants" because the two must not render the same. */
export async function canReadGrants(u: string, t: string, userId: string): Promise<boolean> {
  try {
    await platformFetch<unknown>(`/api/${t}/role-grants?userId=${encodeURIComponent(userId)}`, u);
    return true;
  } catch (err) {
    if (err instanceof PlatformError && err.status === 403) return false;
    // A 400 (missing userId) or a transport error is not an authorization answer — assume readable and
    // let the real read surface its own error rather than hiding the page on an unrelated failure.
    return !(err instanceof PlatformError && err.status === 401);
  }
}

// ── shared display helpers ───────────────────────────────────────────────────────────────────────

export const EMPLOYMENT_LABEL: Record<EmploymentStatus, string> = {
  pending_start: "Pending start",
  active: "Active",
  on_leave: "On leave",
  terminated: "Terminated",
};

export const GRANT_SOURCE_LABEL: Record<GrantSource, string> = {
  manual: "Granted directly",
  position: "From their position",
  service_assignment: "From a service assignment",
};

/** Group positions by their org-unit node — the shape both the positions admin and the dept-head
 *  roster want, and derived once so the two pages cannot disagree about it. */
export function positionsByUnit(positions: Position[]): Map<string, Position[]> {
  const out = new Map<string, Position[]>();
  for (const p of positions) {
    const list = out.get(p.unitNodeId) ?? [];
    list.push(p);
    out.set(p.unitNodeId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/** A seat with no current holder is the thing a dept head is looking for; an orphaned one is the thing
 *  they must escalate. Ordered so both surface above the routine rows. */
export function sortPositions(positions: Position[]): Position[] {
  const rank = (p: Position): number => (p.orphaned ? 0 : p.currentHolders === 0 ? 1 : 2);
  return [...positions].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}
