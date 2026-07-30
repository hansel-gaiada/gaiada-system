// WD-28 — PM per-project short-codes (OQ-7 default). Shared by every project-creation call site
// (core.controller.ts createProject, pm.controller.ts duplicateProject) and every pm_task-creation
// call site (pm.controller.ts createTask/duplicateTask/duplicateProject/recurrence-spawn), so the
// derivation algorithm and the atomic allocator each have exactly one implementation. Migration
// 0050_pm_short_codes.sql carries the full rationale + the backfill that seeds this for existing
// data; this file is what keeps NEW projects/tasks in the same invariant going forward.
import type { PoolClient } from "pg";

/** Same derivation as the 0050 backfill's first pass: 3-4 uppercase alnum chars of the name,
 *  padded with 'X' if short, 'PRJ' if the name has no alnum characters at all. */
export function deriveShortCodeBase(name: string): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (base.length < 3) base = base.padEnd(3, "X");
  if (base === "") base = "PRJ";
  return base;
}

/** Derives a short_code for a brand-new project and guarantees tenant-uniqueness by probing the
 *  candidate (and numeric-suffixed fallbacks) against the live table — called from INSIDE the
 *  caller's `withTenants` transaction, immediately before the project INSERT, so the eventual
 *  INSERT's own `projects_short_code_uidx` unique index is the hard backstop against a race this
 *  probe might still lose (two concurrent creates deriving the same base name). Callers MUST
 *  catch a unique-violation on the insert and retry with a fresh candidate if that backstop ever
 *  fires in practice — in this codebase project creation is not a hot enough path for that to be
 *  a realistic contention point, so a probe-then-insert (not a locking scheme) is the right cost
 *  tradeoff here, unlike the per-project task_seq counter below which IS hot and DOES need the
 *  atomic RETURNING form. */
export async function deriveUniqueShortCode(c: PoolClient, tenantId: string, name: string): Promise<string> {
  const base = deriveShortCodeBase(name);
  let candidate = base;
  let n = 1;
  // Bounded loop (mirrors uniqueStatusId's shape in pm.controller.ts) — practically never
  // iterates more than once or twice; a runaway would mean thousands of same-named-prefix
  // projects in one tenant, at which point falling back to a base+timestamp suffix is fine.
  for (let i = 0; i < 1000; i++) {
    const exists = await c.query(
      `SELECT 1 FROM projects WHERE tenant_id = $1 AND short_code = $2 AND deleted_at IS NULL`,
      [tenantId, candidate],
    );
    if (!exists.rows[0]) return candidate;
    n += 1;
    candidate = `${base}${n}`;
  }
  return `${base}${Date.now().toString(36)}`;
}

/** Atomically allocates the next per-project task sequence number. Single UPDATE...RETURNING —
 *  see 0050's header comment for why this is the concurrency-correct mechanism (a real DB-level
 *  guarantee via row-lock-for-transaction-duration, not a SELECT-max-then-write race). Must be
 *  called from inside the same transaction/connection that will perform the pm_tasks INSERT
 *  using the returned value, so the row lock covers both. */
export async function allocateTaskSeq(c: PoolClient, projectId: string): Promise<number> {
  const r = await c.query<{ taskSeq: number }>(
    `UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq AS "taskSeq"`,
    [projectId],
  );
  return r.rows[0].taskSeq;
}

/** `CODE-SEQ` display form (e.g. `WEB-142`), or null if either half is missing (a project that
 *  predates the backfill somehow, or a task whose seq wasn't allocated through this module). */
export function displayCode(shortCode: string | null, seq: number | null): string | null {
  return shortCode != null && seq != null ? `${shortCode}-${seq}` : null;
}
