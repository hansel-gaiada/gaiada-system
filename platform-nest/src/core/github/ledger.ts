// GH-04 (docs/blueprints/github-integration-foundation.md §4.3/§4.4/§4.6) — the activities ledger
// wrapper around GH-01/GH-02's chokepoint call path (http-client.ts / github-app.service.ts). This
// file does NOT modify either of those — it sits around them, exactly as the ticket that produced it
// instructed. Nothing here originates an outbound network call; `perform` (the caller's closure) is
// where the real `githubRequest()` call happens, so this file is DB-only, same discipline
// egress-inventory.test.ts already enforces for the rest of core/github/.
//
// ── WHY BEFORE, WHY TWO ROWS, WHY APPEND-ONLY ───────────────────────────────────────────────────
// §4.3: "The row is written before the call, so a crashed or failed call still leaves a record of
// the attempt." `activities` has no UPDATE path anywhere in this codebase (grep confirms — every
// writer is an INSERT via `writeActivity`), so "record the outcome afterward" cannot mean mutating
// the first row; it means a SECOND row, joined to the first by a correlation id. That is not a
// workaround — it is what makes the two-row shape actually deliver the guarantee the ticket asks
// for: if the process dies between the two `writeActivity` calls, the FIRST row survives and proves
// the attempt was made, exactly like the crash case the ticket names. A reconcile sweep (§4.6) can
// therefore find "attempted but never resolved" rows as a distinct, meaningful state — not an
// ambiguous absence.
//
// RETENTION (§4.3, and blueprint §8 Q4 — an OPEN QUESTION, not defaulted here): "retention must meet
// or exceed the repo history it describes — this ledger is now the only place the mapping exists."
// No purge/TTL job touches `activities` anywhere in this codebase today (checked: no DELETE, no
// retention job), so the requirement is met by omission for now. THAT IS NOT A GUARANTEE — if a
// future generic activities-retention/archival job is ever added, it MUST carve out every row this
// module writes (`verb LIKE 'github.%'`) as a permanent exception, or it silently reintroduces the
// exact gap §1 says the ledger exists to close. The actual retention NUMBER is an owner decision
// (§8 Q4) this ticket does not make.
//
// ── THE CORRELATION ID IS THE FIRST ROW'S OWN id, NOT A SEPARATE UUID ──────────────────────────────
// §4.4's commit trailer is literally `Gaiada-Activity: <activities.id>` — the id of the "attempted"
// row minted before the GitHub call. `writeActivity` now returns that id (see core/http.ts's GH-04
// widening note), so reusing it IS the correlation handle §4.5's webhook reverse-mapping needs;
// inventing a second, unrelated uuid would just be a second thing that has to agree with the first.
//
// ── STRUCTURALLY HARD TO OMIT AUTHOR (the MEASURED TRAP, 2026-08-31) ────────────────────────────
// The Contents/Git Data APIs accept `author`/`committer` as OPTIONAL and silently collapse to
// `gaiada-erp[bot]`/`GitHub` on 2xx when omitted — "the exact failure this whole design exists to
// prevent, with nothing erroring" (blueprint §4.4). This file cannot stop GH-10 from calling
// `githubRequest()` directly without going through the ledger at all (that is still possible — see
// the report this ticket returns). What it CAN do, and does, is make the ONE path this ticket
// controls refuse to compile without a real author for the two actions the blueprint's §4.4 commit-
// attribution requirement actually applies to: `GithubLedgerRequest` is a discriminated union keyed
// on `action`, and `attribution` is a REQUIRED field of the `push`/`merge` branch's type, not an
// optional one threaded in "if you remember" — TypeScript refuses to build a call site for `push` or
// `merge` that omits it. GH-10's job is then to make `withGithubLedger` (or something that composes
// it) the ONLY way a commit gets made, so this compile-time guarantee actually reaches the API call;
// this ticket cannot force that wiring, only make the ledger's own contract impossible to misuse.
import { newId, withTenants } from "../../db";
import { writeActivity } from "../http";

/** The six actions GH-03's Cerbos policy (`resource_github.yaml`) gates, plus `read` for parity —
 *  this ledger only ever gets CALLED for a write (see `GithubLedgerRequest`'s `action` field below),
 *  but the type is shared with the policy's action names so the two cannot drift apart silently. */
export type GithubLedgerAction = "push" | "merge" | "deploy" | "secret_write" | "create_repo" | "delete_repo";

/** §4.4's git `author`/`committer` shape — "Real Name <person@gaiada.com>" — for the TWO actions
 *  that actually produce a commit. Never optional on those actions; see this file's header. */
export interface GithubCommitAttribution {
  name: string;
  email: string;
}

interface GithubLedgerBase {
  /** The operating company that owns the GitHub org (§5.2's ruling) — Gaiada's tenant id, not the
   *  client's, regardless of which client's site the repo serves. Callers do not resolve this
   *  themselves; matching `integrations.service.ts`'s convention (§2.3(c)), it is a parameter here
   *  too. */
  tenantId: string;
  /** users.id of the HUMAN who asked for this — `activities.actor_id`. Never the bot, never an
   *  agent id (agents ride `metadata.via`, populated ambiently by `writeActivity` itself — see
   *  request-context.ts; nothing in this file needs to touch that wiring). */
  actorId: string;
  /** The repo's `org/name` — the "per repo" half of GH-03's gate, and the human-readable identity
   *  this ledger is queryable by until GH-05's `github_repos` registry exists (see `repoId` below). */
  repo: string;
  /** `github_repos.id`, once GH-05 lands and the caller has resolved the repo to a row. Optional and
   *  omitted today — `writeActivity`'s GH-04 widening (core/http.ts) is what makes that safe: a
   *  `null` target_entity_id stores cleanly instead of failing a uuid cast on a bare `org/name`
   *  string. Wiring this once GH-05 ships is a follow-up, not a breaking change — nothing here needs
   *  to change shape to accept it later. */
  repoId?: string | null;
  ref?: string;
}

/** Discriminated on `action`: `attribution` is REQUIRED for `push`/`merge` (the two commit-producing
 *  actions) and optional for the other four. This is the type-level half of "structurally hard to
 *  make a write call without an author" — see this file's header. */
export type GithubLedgerRequest =
  | (GithubLedgerBase & { action: "push" | "merge"; attribution: GithubCommitAttribution })
  | (GithubLedgerBase & { action: "deploy" | "secret_write" | "create_repo" | "delete_repo"; attribution?: GithubCommitAttribution });

/** What the caller's `perform` closure hands back. `sha` is optional (create_repo/delete_repo/
 *  secret_write/deploy don't produce one; push/merge do) — §4.3 asks the ledger to record "the
 *  resulting SHA", not to require every action to have one. */
export interface GithubLedgerPerformResult<T> {
  data: T;
  sha?: string;
}

export interface GithubLedgerOutcome<T> {
  data: T;
  /** = the "attempted" row's `activities.id`. Hand this to GH-10's commit-trailer writer
   *  (`Gaiada-Activity: <correlationId>`) and to whatever files a D14 approval for create_repo/
   *  delete_repo, so every later row that touches this same attempt can reference it. */
  correlationId: string;
}

/** Shared shape for all three rows an attempt can produce. `correlationId` is omitted on the FIRST
 *  row (it does not exist yet — it IS this row's own id, assigned by Postgres on insert) and present
 *  on the second, so anyone scanning the table can join "succeeded"/"failed" back to "attempted"
 *  without needing anything beyond `metadata`. */
function baseMetadata(req: GithubLedgerRequest, correlationId?: string): Record<string, unknown> {
  return {
    repo: req.repo,
    repoId: req.repoId ?? null,
    ref: req.ref ?? null,
    ...(correlationId ? { correlationId } : {}),
    attribution: req.attribution ? { name: req.attribution.name, email: req.attribution.email } : null,
  };
}

/**
 * Write the "attempted" row, run `perform`, write the "succeeded"/"failed" row, and re-throw on
 * failure (the ledger observes, it never swallows). `perform` receives `{ correlationId }` so the
 * actual `githubRequest()` call can stamp it into a commit trailer or a PR body (§4.4) before the
 * network call happens — the id already exists by the time `perform` runs, because the "attempted"
 * row is written FIRST, per §4.3.
 */
export async function withGithubLedger<T>(
  req: GithubLedgerRequest,
  perform: (ctx: { correlationId: string }) => Promise<GithubLedgerPerformResult<T>>,
): Promise<GithubLedgerOutcome<T>> {
  const verb = `github.${req.action}`;
  const entityId = req.repoId ?? null;

  // §4.3 — BEFORE the call. If the process crashes between here and the network call, or the call
  // itself throws before this function can write the second row, this row is what proves the attempt
  // happened. This row's OWN id (returned by writeActivity) IS the correlation id (§4.4) — nothing
  // needs to be written back into it.
  const correlationId = await writeActivity(req.tenantId, req.actorId, verb, "github_repo", entityId, {
    ...baseMetadata(req),
    outcome: "attempted",
  });

  try {
    const result = await perform({ correlationId });
    await writeActivity(req.tenantId, req.actorId, verb, "github_repo", entityId, {
      ...baseMetadata(req, correlationId),
      outcome: "succeeded",
      sha: result.sha ?? null,
    });
    return { data: result.data, correlationId };
  } catch (err) {
    await writeActivity(req.tenantId, req.actorId, verb, "github_repo", entityId, {
      ...baseMetadata(req, correlationId),
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * §4.6 — "A reconcile sweep compares GitHub events authored by gaiada-erp[bot] against activities
 * rows. Any bot action with no ledger row is an alert." This is the OTHER half of that check: rows
 * this module itself left "attempted" with no matching "succeeded"/"failed" row, past a grace window
 * — a crash, a lost response, or (worse) a write that happened AFTER this function's process died but
 * BEFORE GitHub could be asked, are all indistinguishable from here alone and all worth surfacing.
 * Read-only; GH-13 (a separate ticket) owns turning this into a scheduled job + alert. Exported now
 * so that ticket has a query to call rather than reinventing the correlation-id join.
 */
export interface DanglingGithubAttempt {
  correlationId: string;
  repo: string;
  action: string;
  occurredAt: Date;
}

export async function findDanglingGithubAttempts(
  tenantId: string,
  olderThanMs: number,
): Promise<DanglingGithubAttempt[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await withTenants([tenantId], (c) =>
    c.query<{ id: string; verb: string; metadata: { repo?: string }; occurred_at: Date }>(
      `SELECT a.id, a.verb, a.metadata, a.occurred_at
         FROM activities a
        WHERE a.tenant_id = $1
          AND a.verb LIKE 'github.%'
          AND a.metadata->>'outcome' = 'attempted'
          AND a.occurred_at < $2
          AND NOT EXISTS (
            SELECT 1 FROM activities b
             WHERE b.tenant_id = a.tenant_id
               AND b.metadata->>'correlationId' = a.id::text
               AND b.metadata->>'outcome' IN ('succeeded', 'failed')
          )
        ORDER BY a.occurred_at ASC`,
      [tenantId, cutoff],
    ),
  );
  return rows.rows.map((r) => ({
    correlationId: r.id,
    repo: r.metadata?.repo ?? "",
    action: r.verb.replace(/^github\./, ""),
    occurredAt: r.occurred_at,
  }));
}

// Re-exported so a caller only needs one import for "mint a fresh id" if it wants to pre-generate a
// correlation id before this module's own id would exist (no current caller needs this — kept
// available because `newId` is already imported here and a second import elsewhere would be the
// only alternative).
export { newId };
