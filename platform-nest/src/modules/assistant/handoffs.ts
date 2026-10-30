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
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// AIP-18 — HELD HAND-OFFS (docs/plans/2026-10-27-ai-plan.md §6.3 item 9; BFF §66.11; migration 202610301340)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// While the chatting user is soft-stopped (their daily allowance, or their department's `soft_stop` budget), a hand-off starts NO agent run:
// `createHandoff` validates everything exactly as before (the goal, the runner's roster, the agent, the OBO envelope's principal) and then,
// instead of posting the goal, stores the row with status `held`, NO goal id, and why (`hold_kind`, `hold_unit_node_id`). A held hand-off:
//   * STARTS (`releaseHeldHandoffs`) when its owner is no longer stopped (a lift, the next UTC month, the next UTC day, a raised allowance).
//     The 10-minute AI usage job asks for every company, and the lift route asks right after a lift. The owner's state is read FRESH and
//     STRICT (`computeBudgetState` throws on failure, and a failure keeps the row held). It is posted to the runner by `postGoal`, the same
//     function and the same body a fresh hand-off uses.
//   * is posted ONCE, even with two releasers racing: the claim is a conditional `UPDATE .. WHERE status = 'held'` inside the transaction
//     that then posts the goal and stores its id. A second releaser's claim waits on the row lock and, once the first commits, matches no row
//     (status is now `queued`). If the post fails before the runner accepted it (no runner, a network error, a 5xx), the transaction rolls
//     back and the row stays held for the next try; a 4xx refusal or an agent that left the roster ends it as `failed` (`error_kind`
//     `release_refused` / `agent_unavailable`) rather than retrying it forever.
//   * can be CANCELLED by its owner (`cancelHeldHandoff`, `POST .../handoffs/:handoffId/cancel`): only while it is held (a started run is the
//     runner's). The same row lock makes a cancel and a release exclusive: whichever commits first wins, the other matches no row.
//   * is listed with its status wherever hand-offs are listed (`GET .../handoffs`), and is never polled from the runner (it has no goal).
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { BadRequestException } from "@nestjs/common";
import { computeBudgetState, type BudgetState, type BudgetStop } from "../ai-usage/soft-stop";
import { ensurePlatformSelfLink, oboEnvelopeFor, redactToolArgs, type ChattingUser } from "./broker";
import { intentTtlMs, storableIntentArgs } from "./write-intents";
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
  /** AIP-14 — workspace keys this agent is shown in; `[]` = every department. Display metadata only. */
  departments: string[];
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

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
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
    const body = (await res.json()) as { agents?: Array<Omit<RosterAgent, "departments"> & { departments?: unknown }>; supervisor?: { name: string } | null };
    // AIP-14: an older runner sends no `departments`; anything that is not an array of strings reads as [] (every department).
    const agents = Array.isArray(body.agents) ? body.agents.map((a) => ({ ...a, departments: stringList(a.departments) })) : [];
    return { agents, supervisor: body.supervisor ?? null, runnerConfigured: true };
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
  /** The runner's goal id; null only while the hand-off is `held` (AIP-18) or was cancelled while held. */
  goalId: string | null;
  runId: string | null;
  status: string;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  /** AIP-18: why the hand-off was held (`allowance` | `department`), kept after it starts; null for one that was never held. */
  holdKind: string | null;
  /** AIP-18: the stopped unit, for a `department` hold. */
  holdUnitNodeId: string | null;
  /** AIP-18: when it was held. */
  heldAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const HANDOFF_COLS = `id, tenant_id AS "tenantId", thread_id AS "threadId", owner_user_id AS "ownerUserId",
         agent, goal_text AS "goalText", goal_id AS "goalId", run_id AS "runId", status, outcome,
         error_kind AS "errorKind", approval_id AS "approvalId",
         hold_kind AS "holdKind", hold_unit_node_id AS "holdUnitNodeId", held_at AS "heldAt",
         created_at AS "createdAt", updated_at AS "updatedAt"`;

const HANDOFF_SELECT = `
  SELECT ${HANDOFF_COLS}
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

  // M5-G5d — the args this draft may HOLD: the approval-args policy's minimised shape for `agency_privacy.*`
  // (whatever the runner sent), the args themselves for every other tool. Computed FIRST: args the tool would
  // refuse (a malformed identifier) write no draft, no message and no chip, and the poll that reads the handoff
  // goes on working (a throw here would fail every later refresh of this handoff). The refusal carries no value.
  let storableArgs: Record<string, unknown>;
  try {
    storableArgs = storableIntentArgs(intent.tool, intent.args);
  } catch {
    return;
  }

  const already = await c.query(`SELECT 1 FROM assistant_tool_calls WHERE id = $1`, [row.id]);
  if ((already.rowCount ?? 0) > 0) return; // already harvested on an earlier poll — no-op

  const seqRes = await c.query<{ next: number }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM assistant_messages WHERE thread_id = $1`,
    [row.threadId],
  );
  const messageId = newId();
  const redactedArgs = redactToolArgs(storableArgs);
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
      // The args the draft may hold — the ONLY durable pre-filing home, exactly as broker.ts's own harvest
      // does it for the chat path. M5-G5d: minimised for a tool with an approval-args policy; otherwise the real args.
      JSON.stringify(storableArgs),
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

/** What the runner said to one goal post. `retry`: nothing was started and asking again later may work (a 5xx, a 429, a 408). */
type PostGoalResult = { ok: true; goalId: string } | { ok: false; retry: boolean; message: string };

/**
 * Post ONE goal to the runner: the body every hand-off sends, fresh or released (AIP-18: "posted exactly as a fresh one would be"). The
 * envelope is the caller's `oboEnvelopeFor` result, never anything body-supplied. Throws only on a transport failure (the runner was not
 * reached, or the timeout fired); every HTTP answer comes back as a result.
 */
async function postGoal(
  input: { tenantId: string; goal: string; agent: string; envelope: ReturnType<typeof oboEnvelopeFor> },
  opts: FetchOpts & { timeoutMs?: number },
): Promise<PostGoalResult> {
  const base = runnerBase(opts);
  const token = opts.runnerToken ?? config.services.agents.token;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      tenantId: input.tenantId,
      goal: input.goal,
      agent: input.agent,
      // The ONE envelope, from the ONE function that can spell one. Never body-supplied.
      envelope: input.envelope,
      requestedBy: input.envelope.externalId,
      // 2026-08-07 (closing the confirm-chip bypass, see this file's header) — a handoff's write
      // half now defers filing exactly like the chat-path tool turn (`broker.ts`'s `runToolTurn`):
      // a `high_write` suspends as a DRAFT the owner must confirm in-thread, never filed on their
      // behalf just because they clicked "hand off". Harmless for a read-only agent or a goal that
      // never suspends (the flag is only ever consulted on the write-gate's throw).
      fileOnSuspend: false,
    }),
  };
  const res = opts.timeoutMs !== undefined
    ? await timedFetch(`${base}/goals`, { ...opts, timeoutMs: opts.timeoutMs }, init)
    : await (opts.fetchImpl ?? fetch)(`${base}/goals`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      retry: res.status >= 500 || res.status === 429 || res.status === 408,
      message: `the agent runner refused the handoff (HTTP ${res.status})${text ? `: ${text}` : ""}`,
    };
  }
  const body = (await res.json()) as { id?: unknown };
  // A 2xx with no id may still have queued a goal: never retried (a retry could start the run twice).
  if (typeof body?.id !== "string" || !body.id) return { ok: false, retry: false, message: "the agent runner returned no goal id" };
  return { ok: true, goalId: body.id };
}

/** AIP-18: a held hand-off's answer carries why, and when the stop ends on its own (never a figure). */
export interface HandoffHold {
  kind: BudgetStop["kind"];
  unitNodeId?: string;
  resetsAt: string;
}

/**
 * Create a handoff: validate the agent against the REAL registry, mint the OBO envelope for the
 * CHATTING USER (never any other identity), submit the goal to the runner, and persist the link row.
 *
 * `ownerId` is the caller's own `req.principal.userId` — the route's `authorize(..., "handoff")` has
 * already proven they own `threadId` before this is ever called (see assistant.controller.ts).
 *
 * AIP-18: with `opts.stop` (the owner is soft-stopped, decided by the route from the cached `budgetState`), every check above still runs,
 * then the row is stored `held` with no goal and the runner is NOT called. See this file's AIP-18 header for how it starts later.
 */
export async function createHandoff(
  c: PoolClient,
  input: { tenantId: string; threadId: string; ownerId: string; agent: string; goal: string },
  opts: FetchOpts & { ensureLink?: (userId: string) => Promise<void>; stop?: BudgetStop | null } = {},
): Promise<{ id: string; goalId: string | null; status: string; hold?: HandoffHold }> {
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

  // AIP-18: soft-stopped — stored held, nothing posted. The goal text is kept exactly as a fresh hand-off stores it.
  if (opts.stop) {
    const stop = opts.stop;
    const unitNodeId = stop.kind === "department" ? stop.unitNodeId ?? null : null;
    const id = newId();
    await c.query(
      `INSERT INTO assistant_handoffs
         (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, status, hold_kind, hold_unit_node_id, held_at, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,'held',$7,$8,now(),$9)`,
      [id, input.tenantId, input.threadId, input.ownerId, input.agent, goal, stop.kind, unitNodeId, config.originSite],
    );
    return { id, goalId: null, status: "held", hold: { kind: stop.kind, ...(unitNodeId ? { unitNodeId } : {}), resetsAt: stop.resetsAt } };
  }

  await (opts.ensureLink ?? ensurePlatformSelfLink)(input.ownerId);

  const posted = await postGoal({ tenantId: input.tenantId, goal, agent: input.agent, envelope }, opts);
  if (!posted.ok) throw new BadRequestException(posted.message);

  const id = newId();
  await c.query(
    `INSERT INTO assistant_handoffs (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, status, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8)`,
    [id, input.tenantId, input.threadId, input.ownerId, input.agent, goal, posted.goalId, config.originSite],
  );
  return { id, goalId: posted.goalId, status: "queued" };
}

// ── AIP-18: cancel and release a held hand-off ──────────────────────────────────────────────────────

/**
 * The owner cancels a HELD hand-off of this thread (the route has already authorized the thread's owner). `not_found` for an id that is not
 * a hand-off of this thread (or not a uuid); `not_held` for one that already started or ended (a started run is the runner's to stop).
 * The conditional UPDATE is the whole race story: a release that claimed the row first makes this match nothing, and the reverse.
 */
export async function cancelHeldHandoff(c: PoolClient, threadId: string, handoffId: string): Promise<HandoffRow | "not_found" | "not_held"> {
  if (!UUID_RE.test(handoffId)) return "not_found";
  const r = await c.query<HandoffRow>(
    `UPDATE assistant_handoffs SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND thread_id = $2 AND status = 'held'
      RETURNING ${HANDOFF_COLS}`,
    [handoffId, threadId],
  );
  if (r.rows[0]) return r.rows[0];
  const exists = await c.query(`SELECT 1 FROM assistant_handoffs WHERE id = $1 AND thread_id = $2`, [handoffId, threadId]);
  return (exists.rowCount ?? 0) > 0 ? "not_held" : "not_found";
}

/** How long a release waits for the runner to accept one goal before rolling back (the row then stays held for the next try). */
export const RELEASE_POST_TIMEOUT_MS = 15_000;

export interface ReleaseDeps extends FetchOpts {
  ensureLink?: (userId: string) => Promise<void>;
  /** The owner's state, read fresh and STRICT (default `computeBudgetState`: it throws, and a throw keeps the hand-offs held). */
  state?: (tenantId: string, userId: string) => Promise<BudgetState>;
}

export interface ReleaseResult {
  /** Posted to the runner by this call. */
  started: number;
  /** Still held: the owner is still stopped (the reason is refreshed when it changed). */
  stillHeld: number;
  /** Ended as `failed`: the runner refused the goal (4xx) or the agent left the roster. */
  failed: number;
  /** Claimed by someone else first (another releaser, or the owner's cancel). */
  skipped: number;
  /** A state read or a post that failed: those stay held for the next try. */
  errors: number;
}

/**
 * Start ONE held hand-off, at most once. One transaction: claim (`UPDATE .. WHERE status = 'held'`, which takes the row lock: a second
 * releaser or a cancel waits on it and then matches nothing), check the runner and the agent, post the goal exactly as a fresh hand-off does,
 * store its id. A transport failure or a retryable answer THROWS, which rolls the claim back: the row stays held.
 */
export async function startHeldHandoff(tenantId: string, handoffId: string, deps: ReleaseDeps = {}): Promise<"started" | "skipped" | "failed"> {
  return withTenants(
    [tenantId],
    async (c) => {
      const claimed = await c.query<HandoffRow>(
        `UPDATE assistant_handoffs SET updated_at = now() WHERE id = $1 AND status = 'held' RETURNING ${HANDOFF_COLS}`,
        [handoffId],
      );
      const row = claimed.rows[0];
      if (!row) return "skipped" as const;
      const fail = async (errorKind: string) => {
        await c.query(`UPDATE assistant_handoffs SET status = 'failed', error_kind = $2, updated_at = now() WHERE id = $1`, [row.id, errorKind]);
        return "failed" as const;
      };
      const roster = await fetchRoster(deps);
      if (!roster.runnerConfigured) throw new Error("the agent runner is not configured or not reachable; the hand-off stays held");
      if (!roster.agents.some((a) => a.name === row.agent)) return fail("agent_unavailable");
      const envelope = oboEnvelopeFor({ userId: row.ownerUserId, tenantId: row.tenantId });
      await (deps.ensureLink ?? ensurePlatformSelfLink)(row.ownerUserId);
      const posted = await postGoal(
        { tenantId: row.tenantId, goal: row.goalText, agent: row.agent, envelope },
        { ...deps, timeoutMs: deps.timeoutMs ?? RELEASE_POST_TIMEOUT_MS },
      );
      if (!posted.ok) {
        if (posted.retry) throw new Error(posted.message);
        return fail("release_refused");
      }
      await c.query(`UPDATE assistant_handoffs SET status = 'queued', goal_id = $2, updated_at = now() WHERE id = $1`, [row.id, posted.goalId]);
      return "started" as const;
    },
    { modules: ["assistant"] },
  );
}

/**
 * Release the held hand-offs of one company whose owner is no longer stopped. `unitNodeIds` narrows to hand-offs held because of one of
 * those units (the lift route passes the lifted unit's subtree); absent, every held hand-off of the company is looked at (the job). Each
 * owner's state is read fresh and strict, once per call. Never throws: a failure is counted and the hand-off stays held.
 */
export async function releaseHeldHandoffs(
  tenantId: string,
  filter: { unitNodeIds?: string[] } = {},
  deps: ReleaseDeps = {},
): Promise<ReleaseResult> {
  const out: ReleaseResult = { started: 0, stillHeld: 0, failed: 0, skipped: 0, errors: 0 };
  let rows: HandoffRow[];
  try {
    rows = await withTenants(
      [tenantId],
      async (c) => {
        const r = filter.unitNodeIds
          ? await c.query<HandoffRow>(
              `${HANDOFF_SELECT} WHERE tenant_id = $1 AND status = 'held' AND hold_kind = 'department' AND hold_unit_node_id = ANY($2::text[])
                ORDER BY created_at, id`,
              [tenantId, filter.unitNodeIds],
            )
          : await c.query<HandoffRow>(`${HANDOFF_SELECT} WHERE tenant_id = $1 AND status = 'held' ORDER BY created_at, id`, [tenantId]);
        return r.rows;
      },
      { modules: ["assistant"] },
    );
  } catch (err) {
    console.error(`[AIP-18] listing held hand-offs of company ${tenantId} failed:`, (err as Error)?.message ?? err);
    out.errors++;
    return out;
  }
  if (rows.length === 0) return out;

  const byOwner = new Map<string, HandoffRow[]>();
  for (const r of rows) byOwner.set(r.ownerUserId, [...(byOwner.get(r.ownerUserId) ?? []), r]);
  const readState = deps.state ?? ((t: string, u: string) => computeBudgetState(t, u));

  for (const [owner, held] of byOwner) {
    let state: BudgetState;
    try {
      state = await readState(tenantId, owner);
    } catch (err) {
      console.error(`[AIP-18] budget state of a hand-off owner could not be read; ${held.length} hand-off(s) stay held:`, (err as Error)?.message ?? err);
      out.errors += held.length;
      continue;
    }
    if (state.stopped) {
      // Still stopped: keep them held, and keep the reason true (an allowance hold may have become a department one, or another unit).
      const kind = state.stop.kind;
      const unit = kind === "department" ? state.stop.unitNodeId ?? null : null;
      try {
        await withTenants(
          [tenantId],
          (c) =>
            c.query(
              `UPDATE assistant_handoffs SET hold_kind = $2, hold_unit_node_id = $3, updated_at = now()
                WHERE id = ANY($1::uuid[]) AND status = 'held'
                  AND (hold_kind IS DISTINCT FROM $2 OR hold_unit_node_id IS DISTINCT FROM $3)`,
              [held.map((h) => h.id), kind, unit],
            ),
          { modules: ["assistant"] },
        );
      } catch (err) {
        console.error("[AIP-18] refreshing a hold's reason failed:", (err as Error)?.message ?? err);
      }
      out.stillHeld += held.length;
      continue;
    }
    for (const h of held) {
      try {
        const r = await startHeldHandoff(tenantId, h.id, deps);
        out[r]++;
      } catch (err) {
        out.errors++;
        console.error(`[AIP-18] starting held hand-off ${h.id} failed; it stays held:`, (err as Error)?.message ?? err);
      }
    }
  }
  return out;
}

/**
 * Lazily sync ONE handoff row from the runner's own goal state. Idempotent (re-syncing a
 * still-terminal row is a no-op write of the same values) and a no-op for a row already terminal
 * WITH a run_id (nothing left to learn). Never throws on a runner hiccup — the row simply keeps its
 * last-known state, which is honest (the UI already shows "queued"/"running" as in-flight).
 */
export async function refreshHandoff(c: PoolClient, row: HandoffRow, opts: FetchOpts = {}): Promise<HandoffRow> {
  // AIP-18: a held hand-off (or one cancelled while held) has no goal at the runner: there is nothing to ask about.
  if (row.status === "held" || !row.goalId) return row;
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
         RETURNING ${HANDOFF_COLS}`,
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
