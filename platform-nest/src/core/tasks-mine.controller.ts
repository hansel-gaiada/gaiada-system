// WSUX-3 (UX-2 daily-work spec, contract §9b) — `GET /api/tasks/mine`: the cross-company
// My-Work task read, as a UNION SHIM over the forked task model (D-UX-1: the fork stays until
// WS-B; this endpoint never merges the two models, it normalizes+unions them read-only).
//
// Two task models exist today, independently owned:
//   - base `tasks`   — single-person `assignee_id`   (core.controller.ts's own source)
//   - `pm_tasks`     — poly-assignee `assignee` jsonb (pm.controller.ts's own source, module-gated
//                      behind `companies.enabled_modules ∋ 'pm'` / an active service_assignment)
// This endpoint is READ-ONLY and introduces NO new authorization model: each leg below is the
// SAME authorize()/Cerbos "read" check (+ pm's own per-tenant module-enable gate, mirroring
// ModuleEnabledGuard("pm")) the native endpoint already makes. A caller never sees a row here
// they couldn't already see via `/api/:t/tasks?assignee=me` or `/api/:t/pm/tasks?assignee=me`.
//
// D-UX-1/D-UX-2: cross-company reads are N parallel single-tenant `withTenants([t])` legs,
// mirroring approvals.controller.ts (WSUX-1) — never a widened GUC set, so `lint:withtenants`
// (A1) stays green with zero new allowlist entries.
//
// Disjointness (ticket guardrail): a row lives in EXACTLY ONE of the two models. We never dedupe
// on `id` — if the same id somehow appears in both `tasks` and `pm_tasks` for the same tenant,
// that is a DATA BUG (e.g. a botched migration), not a valid merge target, and is surfaced as a
// per-tenant leg failure (`{included:false, reason:"error"}`) rather than silently unioned.
import { BadRequestException, Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withGlobal, withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { isModuleEnabled } from "../modules/registry";
import type { Principal } from "../rbac/principal";
import type { Envelope, EnvelopeCompany } from "./envelope";

export type TaskSource = "task" | "pm_task";

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  dueDate: string | null; // YYYY-MM-DD
  tenantId: string;
  company: string;
  source: TaskSource;
  // Server-computed so the UI never guesses the detail route (additive contract refinement —
  // see docs/FRONTEND-BFF-CONTRACT.md §9b). Both sources resolve to the SAME `/tasks/:id` UI
  // route today (the existing convention — pm.controller.ts's own notify() calls already point
  // pm_task ids at `/tasks/:id`); this field exists so that convention is never re-derived
  // client-side, and so a future per-source route split is a backend-only change.
  href: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    ),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Soft Cerbos probe (mirrors approvals.controller.ts's canDo()): a denial here never propagates
 *  as a request-wide error — it just means this (tenant, model) leg contributes zero items. */
async function canDo(principal: Principal, tenantId: string, kind: string, action: string): Promise<boolean> {
  try {
    await authorize(principal, { kind, tenantId }, action);
    return true;
  } catch {
    return false;
  }
}

/** A same-id row present in BOTH legs for one tenant is a disjointness violation — surfaced as a
 *  thrown error (caught by the per-tenant try/catch in the controller below, which reports it as
 *  `{included:false, reason:"error"}` for that company) rather than silently merged/returned. */
function assertDisjoint(tenantId: string, baseItems: TaskRow[], pmItems: TaskRow[]): void {
  if (!baseItems.length || !pmItems.length) return;
  const baseIds = new Set(baseItems.map((t) => t.id));
  const collision = pmItems.find((t) => baseIds.has(t.id));
  if (collision) {
    throw new Error(
      `WSUX-3 disjointness violation in tenant ${tenantId}: id ${collision.id} exists in BOTH ` +
        `tasks and pm_tasks — this is a data bug (e.g. a migration collision), not a valid union target.`,
    );
  }
}

// ============================================================================================
// WS-B SWAP MARKER — this function is the ONLY place the fork is read as a union. When WS-B
// unifies `tasks`/`pm_tasks` into one model, this function's body collapses to a single query
// against the unified table; the caller (the controller below) and the wire contract
// (Envelope<TaskRow>, `source`+`href`) do not change — `source` becomes a constant/derived value
// instead of "which table did this row come from", and `assertDisjoint` simply falls away.
// ============================================================================================
async function tasksLegForTenant(
  principal: Principal,
  tenantId: string,
  companyName: string,
  status: string | undefined,
  dueBefore: string | undefined,
): Promise<{ items: TaskRow[]; readable: boolean }> {
  let readable = false;

  // ---- leg 1: base `tasks` (single-person assignee_id) ----
  let baseItems: TaskRow[] = [];
  const taskReadable = await canDo(principal, tenantId, "task", "read");
  if (taskReadable) {
    readable = true;
    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ id: string; title: string; status: string; due_date: string | null }>(
        `SELECT t.id, t.title, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date
         FROM tasks t
         WHERE t.deleted_at IS NULL AND t.assignee_id = $1
           AND ($2::text IS NULL OR t.status = $2)
           AND ($3::date IS NULL OR t.due_date <= $3::date)
         ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 200`,
        [principal.userId, status ?? null, dueBefore ?? null],
      ),
    );
    baseItems = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      dueDate: r.due_date,
      tenantId,
      company: companyName,
      source: "task",
      href: `/tasks/${r.id}`,
    }));
  }

  // ---- leg 2: pm_tasks (poly-assignee jsonb) — mirrors ModuleEnabledGuard("pm") + a pm_task
  //      read probe so this leg NEVER sees more than pm.controller.ts's own listTasks() would. ----
  let pmItems: TaskRow[] = [];
  const pmModuleOn = await isModuleEnabled(tenantId, "pm");
  const pmReadable = pmModuleOn && (await canDo(principal, tenantId, "pm_task", "read"));
  if (pmReadable) {
    readable = true;
    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ id: string; title: string; status: string; due_date: string | null }>(
        `SELECT t.id, t.title, t.status, to_char(t.due_date, 'YYYY-MM-DD') AS due_date
         FROM pm_tasks t
         WHERE t.deleted_at IS NULL
           AND (t.assignee->>'responsibleId' = $1 OR (t.assignee->>'kind' = 'person' AND t.assignee->>'refId' = $1))
           AND ($2::text IS NULL OR t.status = $2)
           AND ($3::date IS NULL OR t.due_date <= $3::date)
         ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 200`,
        [principal.userId, status ?? null, dueBefore ?? null],
      ),
    );
    pmItems = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      dueDate: r.due_date,
      tenantId,
      company: companyName,
      source: "pm_task",
      href: `/tasks/${r.id}`,
    }));
  }

  assertDisjoint(tenantId, baseItems, pmItems);
  return { items: [...baseItems, ...pmItems], readable };
}

@Controller("api")
@UseGuards(AuthGuard)
export class TasksMineController {
  @Get("tasks/mine")
  async mine(
    @Req() req: FastifyRequest,
    @Query("scope") scopeRaw = "all",
    @Query("status") status?: string,
    @Query("dueBefore") dueBefore?: string,
  ): Promise<Envelope<TaskRow>> {
    if (dueBefore !== undefined && !ISO_DATE_RE.test(dueBefore)) {
      throw new BadRequestException("dueBefore must be YYYY-MM-DD");
    }

    // D-UX-2: fan out across the caller's OWN authorized companies (live memberships) — never a
    // client-supplied arbitrary tenant set. scope=<companyId> narrows to ONE company (still
    // soft-probed below, never a hard 403 — a crafted/foreign id degrades to an excluded
    // envelope entry instead of leaking whether it exists).
    const scopeIds = scopeRaw === "all" ? [...new Set(req.principal.companies)] : [scopeRaw];

    const nameById = await namesFor(scopeIds);
    const items: TaskRow[] = [];
    const companies: EnvelopeCompany[] = [];

    for (const tenantId of scopeIds) {
      const companyName = nameById.get(tenantId) ?? "";
      try {
        const leg = await tasksLegForTenant(req.principal, tenantId, companyName, status, dueBefore);
        if (!leg.readable) {
          companies.push({ id: tenantId, included: false, reason: "no_access" });
          continue;
        }
        companies.push({ id: tenantId, name: companyName, included: true });
        items.push(...leg.items);
      } catch {
        // A downed leg (query error, OR the disjointness assertion above) is reported, never a
        // request-wide 500 — the OTHER tenants' legs still complete and return real data.
        companies.push({ id: tenantId, included: false, reason: "error" });
      }
    }

    items.sort((a, b) => {
      if (a.dueDate === b.dueDate) return 0;
      if (a.dueDate === null) return 1; // nulls last
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });

    return { items, companies };
  }
}
