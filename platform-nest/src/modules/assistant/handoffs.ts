// ASST-21 — "hand off to a specialist" + the agent roster.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-21").
// Design: docs/blueprints/assistant-foundation.md §8's "agent roster" line, D-B ("one Hermes front
// door + a visible agent roster... you can hand a longer task to").
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE AUTHZ DESIGN PIN — restated, because it is the reason this file is shaped the way it is
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// A handoff runs under the CHATTING USER's own OBO envelope — `broker.ts`'s `oboEnvelopeFor`, the ONE
// function in this codebase that can spell one, reused here VERBATIM (never re-derived). That is what
// makes the run's transcript safe for that same user to read back later: it is output fetched under
// their OWN authority, not an elevation. `createHandoff` below is therefore the SECOND caller of
// `oboEnvelopeFor` (broker.ts's tool turns are the first) — if you ever find a third code path that
// starts a goal run from the assistant surface WITHOUT going through this function or the broker,
// that is the bug this whole ticket exists to prevent.
//
// `assistant_handoffs` (migration 0084) is the durable link `admin/intelligence.controller.ts`'s
// `GET :t/agents/runs/:runId` reads (via `fetchHandoffByRunId`) to decide whether a NON-elevated
// caller may read a specific run's transcript — see that file's edit and `resource_agent_run.yaml`
// for the additive Cerbos rule this table's `owner_user_id` feeds.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// CLOSING THE CONFIRM-CHIP BYPASS (2026-08-07) — read this before touching fileOnSuspend below
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// §7.2.5 of the ASST-23 unblock design (`docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md`)
// scoped a handoff's goal submission OUT of T2b/T3b's confirm machinery, on the reasoning "the
// handoff click is itself the explicit consent". The owner overruled that on 2026-08-07 (see
// `docs/superpowers/plans/2026-08-07-handoff-confirm-report.md`): clicking "hand off to a
// specialist" is consent to RUN AN AGENT, not consent to ONE SPECIFIC WRITE with THESE SPECIFIC
// ARGUMENTS — which is exactly what the confirm chip shows (redacted) before anything is filed. A
// separate modal at handoff time would just be consent to a blank cheque.
//
// So `createHandoff` below now sends `fileOnSuspend: false`, exactly like `broker.ts`'s chat-path
// tool turn — and when a handoff's underlying goal suspends with a `suspendedIntent`,
// `refreshHandoff` (below) HARVESTS it into the SAME `assistant_write_intents` draft + a new
// `assistant_tool_calls` row, appended to the THREAD as a fresh `assistant_messages` row. This is
// deliberately NOT a second mechanism: it reuses the identical tables, the identical
// `POST …/tool-calls/:callId/confirm`/`.../dismiss` endpoints, and the identical GET-thread
// card-state join `broker.ts`'s stream handler already feeds — "same mechanism, same guarantees,
// one fewer concept", per the owner's own framing. The FE's existing `ProposalCard` (T4) renders it
// with ZERO changes, because from GET thread's point of view a harvested handoff intent is
// indistinguishable in shape from a chat-turn intent.
//
// Idempotency without a new column: `harvestSuspendedIntent` reuses THIS handoff row's OWN `id` as
// the synthesized `assistant_tool_calls.id` (a different table's PK space — no collision risk) —
// a goal can suspend at most ONCE ever (agent.ts ends the goal at the first unresolved high_write),
// so "does a tool_call with this id already exist" is an exact, race-safe "have I already harvested
// this handoff's one-and-only suspension" check, taken under the SAME per-thread advisory lock
// `sendMessage` uses (`thread-lock.ts`) so a concurrent chat turn on the same thread can never
// collide on `assistant_messages`' `UNIQUE (thread_id, seq)`.
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId } from "../../db";
import { BadRequestException } from "@nestjs/common";
import { ensurePlatformSelfLink, oboEnvelopeFor, redactToolArgs, type ChattingUser } from "./broker";
import { intentTtlMs } from "./write-intents";
import { lockAssistantThread } from "./thread-lock";

const MAX_GOAL_LENGTH = 4000;

// ── the runner registry (the roster's REAL source — never a hand-maintained mirror) ───────────────

export interface RosterAgent {
  name: string;
  tools: string[];
  maxSteps: number;
  maxToolCalls: number;
  writeCapable: boolean;
  evaledProviders: string[];
}

export interface Roster {
  agents: RosterAgent[];
  supervisor: { name: string } | null;
  /** Distinguishes "the runner has zero specialists" from "we could not ask it" — same convention
   *  as broker.ts's `listUserVisibleTools` fail-closed-to-empty, spelled out so the UI never confuses
   *  an unreachable runner with an empty roster. */
  runnerConfigured: boolean;
}

interface FetchOpts {
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}

function runnerBase(opts: FetchOpts): string {
  return (opts.runnerUrl ?? config.services.agents.url).replace(/\/$/, "");
}

async function timedFetch(url: string, opts: FetchOpts, init: RequestInit = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? config.adminProbeTimeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The roster's registry half. Fails CLOSED to an empty, `runnerConfigured:false` list on any
 *  transport/parse problem — never a cached or hardcoded fallback that could drift from what the
 *  runner would actually accept at handoff time. */
export async function fetchRoster(opts: FetchOpts = {}): Promise<Roster> {
  const base = runnerBase(opts);
  const token = opts.runnerToken ?? config.services.agents.token;
  if (!base) return { agents: [], supervisor: null, runnerConfigured: false };
  try {
    const res = await timedFetch(`${base}/agents`, opts, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return { agents: [], supervisor: null, runnerConfigured: false };
    const body = (await res.json()) as { agents?: RosterAgent[]; supervisor?: { name: string } | null };
    return { agents: Array.isArray(body.agents) ? body.agents : [], supervisor: body.supervisor ?? null, runnerConfigured: true };
  } catch {
    return { agents: [], supervisor: null, runnerConfigured: false };
  }
}

/** Episodic run history for a SPECIFIC set of run ids — never "give me this tenant's whole history"
 *  (see runner/service.ts's `/episodes` header for why an Episode carries no user column, and why
 *  the caller-supplied run-id set is what turns tenant-wide history into THIS user's history). Fails
 *  closed to `[]` — an unreachable runner reads as "no history available", never an error the roster
 *  panel has to render specially. */
export async function fetchEpisodicHistory(tenantId: string, runIds: string[], opts: FetchOpts = {}): Promise<unknown[]> {
  if (runIds.length === 0) return [];
  const base = runnerBase(opts);
  const token = opts.runnerToken ?? config.services.agents.token;
  if (!base) return [];
  try {
    const qs = new URLSearchParams({ tenant: tenantId, runIds: runIds.join(",") });
    const res = await timedFetch(`${base}/episodes?${qs.toString()}`, opts, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { episodes?: unknown[] };
    return Array.isArray(body.episodes) ? body.episodes : [];
  } catch {
    return [];
  }
}

// ── the handoff row ─────────────────────────────────────────────────────────────────────────────────

export interface HandoffRow {
  id: string;
  tenantId: string;
  threadId: string;
  ownerUserId: string;
  agent: string;
  goalText: string;
  goalId: string;
  runId: string | null;
  status: string;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

const HANDOFF_SELECT = `
  SELECT id, tenant_id AS "tenantId", thread_id AS "threadId", owner_user_id AS "ownerUserId",
         agent, goal_text AS "goalText", goal_id AS "goalId", run_id AS "runId", status, outcome,
         error_kind AS "errorKind", approval_id AS "approvalId",
         created_at AS "createdAt", updated_at AS "updatedAt"
  FROM assistant_handoffs`;

export async function fetchHandoffsForThread(c: PoolClient, threadId: string): Promise<HandoffRow[]> {
  const r = await c.query<HandoffRow>(`${HANDOFF_SELECT} WHERE thread_id = $1 ORDER BY created_at DESC`, [threadId]);
  return r.rows;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ASST-21's OWN half of the additive Cerbos rule: "is this runId a handoff, and whose?" — read by
 * `admin/intelligence.controller.ts`'s `GET :t/agents/runs/:runId` BEFORE it ever asks Cerbos. Scoped
 * by the caller's `withTenants([tenantId], …)` (RLS + the module wall), so a runId from a DIFFERENT
 * tenant can never match here even though `run_id` alone has no tenant qualifier in this query — the
 * row simply isn't visible under a different tenant's RLS session.
 *
 * A non-uuid `runId` (the ai-agents runner's OWN run ids are real uuids, but this route's `:runId`
 * param is client-supplied and unvalidated upstream) short-circuits to `null` BEFORE the query, never
 * a query at all: `run_id` is a `uuid` column, so a malformed value would otherwise make Postgres
 * throw "invalid input syntax for type uuid" — turning a plain "this isn't a handoff" into a 500
 * instead of the honest, silent "fall through to elevated-only" this file exists to provide.
 */
export async function fetchHandoffByRunId(c: PoolClient, runId: string): Promise<{ ownerUserId: string } | null> {
  if (!UUID_RE.test(runId)) return null;
  const r = await c.query<{ ownerUserId: string }>(
    `SELECT owner_user_id AS "ownerUserId" FROM assistant_handoffs WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0] ?? null;
}

const NON_TERMINAL_GOAL_STATUSES = new Set(["queued", "running"]);

/** T2b/T3b's deferred-filing shape, mirrored from `broker.ts`'s `RunnerSuspendedIntent` — the SAME
 *  `GET /goals/:id` merge the chat-path broker reads. `impact` is ALREADY the wire label
 *  (T1's `toWireImpact`) — never re-derived here, see this file's header. */
interface RunnerSuspendedIntent {
  tool: string;
  impact: string;
  args: Record<string, unknown>;
}

interface RunnerGoalDetail {
  status: string;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  runs?: Array<{ runId: string }>;
  /** Present only on a `fileOnSuspend:false` suspension (this file's only mode since 2026-08-07) —
   *  absent once the runner's own in-memory TTL map evicts the entry (see `harvestSuspendedIntent`'s
   *  doc for what that degrades to). */
  suspendedIntent?: RunnerSuspendedIntent | null;
}

/**
 * The confirm-chip bypass fix's own core: when a handoff's goal reports `suspended` +
 * `suspendedIntent`, surface it in the thread EXACTLY the way `broker.ts`'s stream handler surfaces
 * a chat-turn suspension — a new `assistant_messages` row, a matching `assistant_tool_calls` row,
 * and an `assistant_write_intents` DRAFT the owner must confirm/dismiss via the existing
 * `POST …/tool-calls/:callId/confirm`/`.../dismiss` endpoints. No filing, no decider notification —
 * exactly the same "unconfirmed intents notify nobody" invariant T3b already holds for the chat path.
 *
 * IDEMPOTENT, without a new column (see this file's header): the synthesized
 * `assistant_tool_calls.id` is `row.id` (the handoff's OWN primary key, a DIFFERENT table's PK
 * space — no collision) — a goal can suspend at most once ever
 * (`ai-agents/src/agent.ts` ends the goal at the first unresolved `high_write`), so "does a
 * tool_call with this id already exist" is an exact, race-safe "already harvested" check. Called
 * from `refreshHandoff` on EVERY poll while the goal is suspended (cheap: one SELECT when there is
 * nothing left to do) — never re-inserts.
 *
 * Takes the SAME per-thread advisory lock `sendMessage` uses (`thread-lock.ts`) before the seq
 * allocation below, so a concurrent chat turn on the same thread can never collide on
 * `assistant_messages`' `UNIQUE (thread_id, seq)`.
 */
async function harvestSuspendedIntent(c: PoolClient, row: HandoffRow, intent: RunnerSuspendedIntent): Promise<void> {
  await lockAssistantThread(c, row.threadId);

  const already = await c.query(`SELECT 1 FROM assistant_tool_calls WHERE id = $1`, [row.id]);
  if ((already.rowCount ?? 0) > 0) return; // already harvested on an earlier poll — no-op

  const seqRes = await c.query<{ next: number }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM assistant_messages WHERE thread_id = $1`,
    [row.threadId],
  );
  const messageId = newId();
  const redactedArgs = redactToolArgs(intent.args);
  const content =
    `I've drafted a ${intent.tool} write via the ${row.agent} handoff. Confirm it in this thread to send it ` +
    "for approval, or dismiss it — nothing has been changed or sent yet.";
  await c.query(
    `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, parts, origin_site)
     VALUES ($1, $2, $3, $4, 'assistant', $5, $6::jsonb, $7)`,
    [
      messageId,
      row.tenantId,
      row.threadId,
      seqRes.rows[0].next,
      content,
      // Additive, informational only — no existing reader (readTurnMode et al.) matches this type,
      // and none needs to: it exists purely so a future admin/audit read can tell a harvested
      // handoff-intent message apart from an ordinary chat-turn one without a second join.
      JSON.stringify([{ type: "handoff_intent", handoffId: row.id, agent: row.agent }]),
      config.originSite,
    ],
  );
  await c.query(
    `INSERT INTO assistant_tool_calls
       (id, tenant_id, message_id, tool_name, mcp_server, args, result_summary, status, authority_user_id,
        approval_id, duration_ms, origin_site)
     VALUES ($1,$2,$3,$4,'mcp-hub',$5::jsonb,$6,'pending',$7,NULL,NULL,$8)`,
    [
      row.id,
      row.tenantId,
      messageId,
      intent.tool,
      JSON.stringify(redactedArgs),
      "awaiting your confirmation before this is sent for approval",
      row.ownerUserId,
      config.originSite,
    ],
  );
  await c.query(
    `INSERT INTO assistant_write_intents
       (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args,
        impact, status, expires_at, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'draft',$11,$12)`,
    [
      newId(),
      row.tenantId,
      row.threadId,
      messageId,
      row.id, // == the assistant_tool_calls.id inserted above
      row.ownerUserId,
      row.agent,
      intent.tool,
      // The REAL (unredacted) args — the ONLY durable pre-filing home, exactly as broker.ts's own
      // harvest does it for the chat path.
      JSON.stringify(intent.args ?? {}),
      intent.impact,
      new Date(Date.now() + intentTtlMs()).toISOString(),
      config.originSite,
    ],
  );
  await c.query(
    `UPDATE assistant_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`,
    [row.threadId],
  );
}

/**
 * Create a handoff: validate the agent against the REAL registry, mint the OBO envelope for the
 * CHATTING USER (never any other identity), submit the goal to the runner, and persist the link row.
 *
 * `ownerId` is the caller's own `req.principal.userId` — the route's `authorize(..., "handoff")` has
 * already proven they own `threadId` before this is ever called (see assistant.controller.ts).
 */
export async function createHandoff(
  c: PoolClient,
  input: { tenantId: string; threadId: string; ownerId: string; agent: string; goal: string },
  opts: FetchOpts & { ensureLink?: (userId: string) => Promise<void> } = {},
): Promise<{ id: string; goalId: string; status: string }> {
  const goal = input.goal.trim();
  if (!goal) throw new BadRequestException("goal is required");
  if (goal.length > MAX_GOAL_LENGTH) throw new BadRequestException(`goal exceeds max length (${MAX_GOAL_LENGTH})`);

  const roster = await fetchRoster(opts);
  if (!roster.runnerConfigured) throw new BadRequestException("the agent runner is not configured — no handoff is possible right now");
  // Supervisor fan-out is deliberately NOT offered here: a handoff hands the thread to ONE named
  // specialist, and the run-linking model above assumes exactly one run per handoff (see migration
  // 0084's `ux_assistant_handoffs_run_id` header) — a supervisor goal can fan out into several.
  const known = roster.agents.some((a) => a.name === input.agent);
  if (!known) {
    throw new BadRequestException(
      `agent must be one of ${roster.agents.map((a) => a.name).join(", ") || "(none registered)"}`,
    );
  }

  const user: ChattingUser = { userId: input.ownerId, tenantId: input.tenantId };
  const envelope = oboEnvelopeFor(user); // throws ServicePrincipalRefusedError on anything but a real user id
  await (opts.ensureLink ?? ensurePlatformSelfLink)(input.ownerId);

  const base = runnerBase(opts);
  const token = opts.runnerToken ?? config.services.agents.token;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base}/goals`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      tenantId: input.tenantId,
      goal,
      agent: input.agent,
      // The ONE envelope, from the ONE function that can spell one. Never body-supplied.
      envelope,
      requestedBy: envelope.externalId,
      // 2026-08-07 (closing the confirm-chip bypass, see this file's header) — a handoff's write
      // half now defers filing exactly like the chat-path tool turn (`broker.ts`'s `runToolTurn`):
      // a `high_write` suspends as a DRAFT the owner must confirm in-thread, never filed on their
      // behalf just because they clicked "hand off". Harmless for a read-only agent or a goal that
      // never suspends (the flag is only ever consulted on the write-gate's throw).
      fileOnSuspend: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BadRequestException(`the agent runner refused the handoff (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
  const body = (await res.json()) as { id?: unknown };
  if (typeof body?.id !== "string" || !body.id) throw new BadRequestException("the agent runner returned no goal id");

  const id = newId();
  await c.query(
    `INSERT INTO assistant_handoffs (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, status, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8)`,
    [id, input.tenantId, input.threadId, input.ownerId, input.agent, goal, body.id, config.originSite],
  );
  return { id, goalId: body.id, status: "queued" };
}

/**
 * Lazily sync ONE handoff row from the runner's own goal state. Idempotent (re-syncing a
 * still-terminal row is a no-op write of the same values) and a no-op for a row already terminal
 * WITH a run_id (nothing left to learn). Never throws on a runner hiccup — the row simply keeps its
 * last-known state, which is honest (the UI already shows "queued"/"running" as in-flight).
 */
export async function refreshHandoff(c: PoolClient, row: HandoffRow, opts: FetchOpts = {}): Promise<HandoffRow> {
  if (!NON_TERMINAL_GOAL_STATUSES.has(row.status) && row.runId) return row; // nothing left to learn
  const base = runnerBase(opts);
  const token = opts.runnerToken ?? config.services.agents.token;
  if (!base) return row;
  try {
    const res = await timedFetch(`${base}/goals/${encodeURIComponent(row.goalId)}?tenant=${encodeURIComponent(row.tenantId)}`, opts, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return row;
    const goal = (await res.json()) as RunnerGoalDetail;
    // 2026-08-07 (closing the confirm-chip bypass, see this file's header) — a suspended-with-
    // suspendedIntent goal is harvested into the thread's own confirm-chip machinery BEFORE the
    // handoff row's own status is synced below, so a caller that reads the thread right after this
    // call already sees the draft. `goal.approvalId` (the legacy filed-at-suspend shape) is left
    // untouched below either way — this file no longer requests it (fileOnSuspend is always false),
    // but a future runner that ignores the flag must still be handled, not silently mishandled.
    if (goal.status === "suspended" && goal.suspendedIntent) {
      await harvestSuspendedIntent(c, row, goal.suspendedIntent);
    }
    const runId = goal.runs?.[0]?.runId ?? row.runId;
    const updated = await c.query<HandoffRow>(
      `UPDATE assistant_handoffs
         SET status = $1, outcome = $2, error_kind = $3, approval_id = $4, run_id = COALESCE($5, run_id), updated_at = now()
         WHERE id = $6
         RETURNING id, tenant_id AS "tenantId", thread_id AS "threadId", owner_user_id AS "ownerUserId",
                   agent, goal_text AS "goalText", goal_id AS "goalId", run_id AS "runId", status, outcome,
                   error_kind AS "errorKind", approval_id AS "approvalId",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
      [goal.status, goal.outcome ?? null, goal.errorKind ?? null, goal.approvalId ?? null, runId ?? null, row.id],
    );
    return updated.rows[0] ?? row;
  } catch {
    return row; // a runner hiccup must not fail the whole list — see this function's header
  }
}

/** List a thread's handoffs, refreshing each non-terminal one from the runner first — the run-watch
 *  view's one read. */
export async function listHandoffsForThread(c: PoolClient, threadId: string, opts: FetchOpts = {}): Promise<HandoffRow[]> {
  const rows = await fetchHandoffsForThread(c, threadId);
  const refreshed: HandoffRow[] = [];
  for (const row of rows) {
    refreshed.push(await refreshHandoff(c, row, opts));
  }
  return refreshed;
}
