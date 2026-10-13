// DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34) — pull requests and CI status on PM tasks.
//
// This file holds the pieces that are not webhook plumbing:
//   * the LINK RULE (§34.5): which task does a pull request name? `extractTaskKeys` / `candidateTaskKeys` are PURE (no DB,
//     unit-tested on their own); `resolveTaskKey` / `linkTaskKey` are the DB lookup that turns a candidate into a live
//     task in the org tenant. `linkTaskKey` is exported for DW-4h, which attaches the same pull request's work_activity
//     rows to the task later (6f does not change work_activity).
//   * the CI SUMMARY (§34.4): computed on read, never stored.
//
// The handlers that fill `github_pull_requests` stay in github-webhook-handlers.ts (they are the existing per-event
// handlers); the read is in modules/pm/pm.controller.ts.
import type { PoolClient } from "pg";

// ── the link rule: pure part ───────────────────────────────────────────────────────────────────────

/**
 * A candidate task key: a letter, 1 to 9 letters or digits, a hyphen, then 1 to 6 digits, standing between characters
 * that are not letters or digits (or at either end of the text). The look-arounds are what keep `xWEB-12abc` and
 * `WEB-1234567` from matching: a key glued to letters or digits is not a key.
 */
const TASK_KEY_RE = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,6}(?![A-Za-z0-9])/g;

/** Defensive cap on candidates sent to the database (a title is at most a few hundred characters in practice). */
const MAX_CANDIDATES = 20;

export interface TaskKeyCandidate {
  /** The key as written in the title or branch, for display and audit (`task_key`). */
  raw: string;
  /** The project short code, upper-cased (matched case-insensitively against `projects.short_code`). */
  code: string;
  /** The task's sequence number within the project. */
  seq: number;
}

/** Every candidate key in one text, left to right, duplicates (case-insensitive) dropped. Pure. */
export function extractTaskKeys(text: string | null | undefined): TaskKeyCandidate[] {
  if (!text) return [];
  const out: TaskKeyCandidate[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TASK_KEY_RE)) {
    const raw = m[0];
    const dash = raw.lastIndexOf("-");
    const code = raw.slice(0, dash).toUpperCase();
    const seq = Number.parseInt(raw.slice(dash + 1), 10);
    const id = `${code}-${seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ raw, code, seq });
  }
  return out;
}

/** The title's candidates first, then the branch's, each left to right; a key named twice appears once. Pure. */
export function candidateTaskKeys(title: string | null | undefined, headRef: string | null | undefined): TaskKeyCandidate[] {
  const out: TaskKeyCandidate[] = [];
  const seen = new Set<string>();
  for (const c of [...extractTaskKeys(title), ...extractTaskKeys(headRef)]) {
    const id = `${c.code}-${c.seq}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out.slice(0, MAX_CANDIDATES);
}

// ── the link rule: database part ───────────────────────────────────────────────────────────────────

export interface TaskLink {
  pmTaskId: string;
  /** The candidate key as written, for `github_pull_requests.task_key`. */
  taskKey: string;
}

/**
 * The first candidate (in order) that names a live task of a live project in `tenantId`, or null. `client` must be inside
 * `withTenants([tenantId], ...)`; RLS is the second wall behind the explicit tenant filter.
 */
export async function resolveTaskKey(client: PoolClient, tenantId: string, candidates: TaskKeyCandidate[]): Promise<TaskLink | null> {
  if (!candidates.length) return null;
  const r = await client.query<{ id: string; raw: string }>(
    `SELECT t.id, c.raw
       FROM unnest($1::text[], $2::int[], $3::text[]) WITH ORDINALITY AS c(code, seq, raw, ord)
       JOIN projects p ON p.tenant_id = $4 AND p.deleted_at IS NULL AND p.short_code IS NOT NULL
                      AND upper(p.short_code) = c.code
       JOIN pm_tasks t ON t.project_id = p.id AND t.tenant_id = $4 AND t.deleted_at IS NULL AND t.seq = c.seq
      ORDER BY c.ord, p.created_at, p.id
      LIMIT 1`,
    [candidates.map((c) => c.code), candidates.map((c) => c.seq), candidates.map((c) => c.raw), tenantId],
  );
  const row = r.rows[0];
  return row ? { pmTaskId: row.id, taskKey: row.raw } : null;
}

/** §34.5 end to end: extract (title, then branch), then resolve in the org tenant. The first that resolves wins. */
export async function linkTaskKey(
  client: PoolClient,
  tenantId: string,
  pr: { title: string | null | undefined; headRef: string | null | undefined },
): Promise<TaskLink | null> {
  return resolveTaskKey(client, tenantId, candidateTaskKeys(pr.title, pr.headRef));
}

// ── the CI summary (§34.4), computed on read ───────────────────────────────────────────────────────

/** One workflow's latest run, as stored in `github_pull_requests.ci[<workflow name>]`. */
export interface CiRun {
  runId: number | null;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  at: string | null;
}

export type CiSummary = "passing" | "failing" | "running" | "none";

const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/**
 * `failing` when any workflow's latest run has concluded with anything that is not a pass (the contract names failure,
 * timed_out, cancelled and action_required; startup_failure, stale and a completed run with no conclusion are not passes
 * either); else `running` when any is not `completed`; else `passing`; `none` with no entries.
 */
export function summarizeCi(ci: Record<string, CiRun> | null | undefined): CiSummary {
  const runs = Object.values(ci ?? {});
  if (!runs.length) return "none";
  const completed = runs.filter((r) => r.status === "completed");
  if (completed.some((r) => !PASSING_CONCLUSIONS.has(r.conclusion ?? ""))) return "failing";
  if (runs.some((r) => r.status !== "completed")) return "running";
  return "passing";
}
