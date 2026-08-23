// ASST-17 — the assistant's TOOL BROKER: the path a tool-using chat turn takes.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-17").
// Design: docs/blueprints/assistant-foundation.md §6 (authorization), §7 (writes are proposals).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE INVARIANT THIS FILE EXISTS TO ENFORCE
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// EVERY tool a chat turn runs executes under the CHATTING USER's own Cerbos principal. Never a
// service principal. Never an ambient/elevated one. Never an automation one.
//
// Why that is not negotiable (blueprint constraint #2): reading an agent RUN TRANSCRIPT elsewhere in
// this platform is `isElevated`-only BY DESIGN (`admin/intelligence.controller.ts`'s `GET
// :t/agents/runs/:runId`), because a transcript can contain tool output fetched under the triggering
// user's authority. A chat thread IS a transcript (`assistant_messages` + `assistant_tool_calls`).
// The assistant is safe for ordinary, NON-elevated users only because TWO things hold together:
//   (1) threads are owner-private with no admin bypass (ASST-02's Cerbos policy), AND
//   (2) every tool executes as the chatting user.
// Break (2) and (1) stops mattering: a user could read, inside their own private thread, output that
// was fetched under an authority they do not hold. That is an elevation vector in every thread.
//
// Structural consequence, and the thing to preserve if you change anything here: there is EXACTLY
// ONE function in this file that can spell an OBO envelope — `oboEnvelopeFor()` — it takes the
// chatting user and nothing else, it hard-codes `provider: "platform"`, and it throws on anything
// that is not a real user id. No other code path in the broker constructs an envelope, so "did a
// tool run as somebody else?" is answerable by reading one 10-line function instead of auditing a
// call graph. `assistant-broker.test.ts` asserts that property directly (including that an
// automation provider and an empty/service id are REFUSED, not silently substituted).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ARCHITECT DESIGN PIN (binding — do not redesign)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// v1 routes a tool-using turn through the EXISTING ai-agents runtime (`ai-agents/src/agent.ts`'s
// proven tool loop + provider handling, fronted by the agent-runner service at `AGENTS_URL`), under
// the user's OBO envelope, relaying `tool_call`/`tool_result` progress as SSE events and streaming
// the final answer. Per-provider native function-calling in ai-gateway-go is explicitly NOT built
// now, and this file deliberately does NOT grow a third model/tool loop of its own — the runner's is
// the one that is already D13/D14-gated and eval-covered.
//
// ── WHY THAT IS NOT A SERVICE-PRINCIPAL HOP (verified, not assumed) ───────────────────────────────
// The chain a tool call takes is: broker -> agent-runner -> mcp-hub -> platform-nest.
//   * broker -> runner    : `Authorization: Bearer AGENT_RUNNER_TOKEN` + `envelope {provider,
//                           externalId}` in the body. The bearer authenticates the SERVICE (this
//                           process is allowed to talk to the runner at all); the envelope names WHO
//                           the work is for. The runner never invents an envelope — it stores the one
//                           it was given per goal (`runner/store.ts` `envelope_provider` /
//                           `envelope_external_id`) and threads it through the whole run.
//   * runner -> hub       : `Authorization: Bearer HUB_SERVICE_TOKEN` + `x-obo-provider` /
//                           `x-obo-external-id`. `mcp-hub/src/principal.ts`'s own header states the
//                           rule: "the calling SERVICE authenticates with its token; the END USER
//                           arrives as an envelope that the hub — never the client — turns into a
//                           principal. There is no field a client could set to claim a role."
//   * hub -> platform     : `mcp-hub/src/platform-tools.ts` forwards the SAME OBO envelope; the
//                           platform's `AuthGuard` resolves it through `identity_links` (verified
//                           only) into a REAL user principal and applies Cerbos + RLS as that user.
// So the authorization principal at every decision point is the chatting user. The service tokens are
// transport credentials, exactly as they are for the WhatsApp bot and the n8n bridge — they carry no
// roles and cannot widen a decision. If you ever find a hop where the DECIDING principal is a service
// identity, that is a BLOCKER for this whole surface, not a detail to paper over.
//
// ── AND WHY `mcp-hub/src/policy.ts`'s `isAutomation` BRANCH MUST STAY NARROW ──────────────────────
// It is tempting to close the AgentDef-vs-registry impact drift by widening that branch (the D14
// medium+-write suspension) from `provider === "n8n"` to all principals. Do NOT: it would push every
// human/OBO medium+ write into D14 suspension and break this broker for its ordinary read path. The
// human write half is governed instead by §7's proposal model + D14's approvals surface, which this
// file consumes (see `approval_required` below) rather than re-implements.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// TWO WALLS, BOTH UNDER THE USER'S OWN PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//  Wall 1 (this file, `capabilityGate`): before a goal is submitted at all, the broker asks the hub
//    `tools/list` UNDER THE USER'S OWN OBO ENVELOPE. The hub answers with `visibleToolsFor(principal)`
//    — Cerbos-authoritative per principal (`mcp-hub/src/policy.ts` + `cerbos.ts`). Any tool the turn
//    needs that the user cannot see is REFUSED in-thread, typed and visible, and the goal is NEVER
//    POSTed — so nothing runs anywhere, under any principal. This wall is what makes the refusal
//    *provable*: the assertion is not "the user saw an error" (which would pass even if the call had
//    run under the wrong principal) but "the runner received zero requests".
//  Wall 2 (the hub, unchanged): even if wall 1 were wrong or stale, the hub re-authorizes every
//    single `tools/call` under the same principal and the platform re-checks Cerbos + RLS behind it.
//    Wall 1 is an early, honest refusal; wall 2 is the authority. Neither is a bypass of the other.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ARGS ARE ALWAYS REDACTED BEFORE PERSIST (migration 0079's own column comment)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// `assistant_tool_calls.args` is documented in 0079 as "REDACTED before persist (app layer)" — this
// file is that app layer, and `redactToolArgs()` is the only writer. It preserves the SHAPE (key
// names at every depth, and a type tag per leaf) and destroys every VALUE. That is deliberate:
//   - a human auditing a thread needs to know WHICH tool was called with WHICH argument NAMES;
//   - nobody needs the values, and the values are exactly what could carry PII / secrets / another
//     tenant's identifiers into a row that outlives the turn.
// Note the honest scope limit: on the runner path the broker never even SEES raw args (the runner's
// step transcript records `"<tool> ok"`/`"<tool> failed"` and no arguments at all), so those rows
// carry `{}`. The one place real arguments DO reach this process is a suspended write's
// `automation_approvals.tool_args` row — and that is precisely where `redactToolArgs()` runs for
// real. Do not "improve" this by teaching the runner to report raw args; the current split means the
// agents database never holds them either.
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withGlobal } from "../../db";
import { getExecutable } from "../../core/approval-executables";
import { intentTtlMs } from "./write-intents";

// ─────────────────────────────────────── the chatting user ───────────────────────────────────────

/** The identity a whole tool turn runs as. There is no other authority input to this module: the
 *  controller builds this from `req.principal.userId` + the route's already-authorized `:tenantId`,
 *  never from a request body. */
export interface ChattingUser {
  /** `req.principal.userId` — the authenticated human. */
  userId: string;
  /** The route tenant, already through `authorize()` for the thread's `stream` action. */
  tenantId: string;
}

/** The ONLY OBO provider this module will ever name. A constant, not a parameter: an envelope whose
 *  provider came from anywhere else is exactly the bug class this file exists to make impossible. */
export const PLATFORM_OBO_PROVIDER = "platform" as const;

/** Providers that denote an unattended/automation caller in the hub's own policy
 *  (`mcp-hub/src/automation-policy.ts`'s `isAutomation`). Listed here so a refusal is explicit and
 *  named rather than falling out of a generic "not platform" check — if the hub grows a second
 *  automation provider, this is the mirror to update. */
const AUTOMATION_PROVIDERS = new Set(["n8n"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when something that is NOT a plain chatting user tries to become a tool turn's authority.
 *  A hard throw, never a fallback: silently substituting a different principal is the single outcome
 *  this ticket refuses to allow. */
export class ServicePrincipalRefusedError extends Error {
  constructor(reason: string) {
    super(
      `refusing to run assistant tools under a non-user principal (${reason}) — every tool must run ` +
        "as the chatting user's own Cerbos principal (assistant-foundation.md §6)",
    );
  }
}

export interface OboEnvelope {
  provider: typeof PLATFORM_OBO_PROVIDER;
  externalId: string;
}

/**
 * The single place an OBO envelope can be spelled in the assistant surface.
 *
 * Hard-codes the provider, takes the external id from the chatting user and nowhere else, and
 * refuses anything that is not a real user uuid. Called by BOTH walls (the capability gate's
 * `tools/list` and the goal submission) so they can never disagree about who the turn is for.
 */
export function oboEnvelopeFor(user: ChattingUser): OboEnvelope {
  const id = typeof user?.userId === "string" ? user.userId.trim() : "";
  if (!id) throw new ServicePrincipalRefusedError("no authenticated user id");
  if (!UUID_RE.test(id)) throw new ServicePrincipalRefusedError(`external id is not a user uuid: ${id}`);
  return { provider: PLATFORM_OBO_PROVIDER, externalId: id };
}

/** Defence in depth for the envelope's provider: asserted at the ONE place an envelope leaves this
 *  process, so a future edit that threads a provider in from elsewhere fails loudly here instead of
 *  quietly minting an automation principal. */
function assertUserProvider(provider: string): void {
  if (provider !== PLATFORM_OBO_PROVIDER) throw new ServicePrincipalRefusedError(`provider '${provider}' is not '${PLATFORM_OBO_PROVIDER}'`);
  if (AUTOMATION_PROVIDERS.has(provider)) throw new ServicePrincipalRefusedError(`provider '${provider}' is an automation principal`);
}

/**
 * Upsert the platform SELF-link the OBO envelope resolves through — `identity_links(provider =
 * 'platform', external_id = userId, user_id = userId)`, both sides pinned to the SAME authenticated
 * caller, `verified_at = now()`.
 *
 * Identical to `admin/intelligence.controller.ts`'s step (1) and unforgeable for the same reason: the
 * row always points at the caller, and no field of it is ever read from a request. Without it the
 * hub's envelope resolves to `ANONYMOUS` at the platform (`auth/guards.ts` requires `verified_at`),
 * which would read like "the user has no permissions" rather than "the link was never made".
 * `withGlobal` (not `withTenants`) on purpose: `identity_links` is a global identity table, not a
 * tenant-scoped one.
 */
export async function ensurePlatformSelfLink(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(
      `INSERT INTO identity_links (id, user_id, provider, external_id, verified_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (provider, external_id) DO NOTHING`,
      [newId(), userId, PLATFORM_OBO_PROVIDER, userId],
    ),
  );
}

// ────────────────────────────────────────── args redaction ───────────────────────────────────────

const REDACT_MAX_DEPTH = 4;

function typeTag(v: unknown): string {
  if (v === null) return "[redacted:null]";
  if (Array.isArray(v)) return `[redacted:array(${v.length})]`;
  switch (typeof v) {
    case "string":
      return "[redacted:string]";
    case "number":
      return "[redacted:number]";
    case "boolean":
      return "[redacted:boolean]";
    case "object":
      return "[redacted:object]";
    default:
      return "[redacted]";
  }
}

/**
 * Shape-preserving, value-destroying redaction — the only writer of `assistant_tool_calls.args`.
 *
 * Key names survive at every depth (up to `REDACT_MAX_DEPTH`, past which a nested object collapses
 * to its type tag so a hostile/pathological argument tree can never blow up the row); every LEAF
 * becomes a type tag. Arrays collapse to a single `[redacted:array(n)]` tag rather than being walked:
 * an array's INDICES carry no auditing value and walking one would let a 10k-element argument
 * multiply the stored row.
 *
 * A non-object argument bag yields `{}` — the column's own default and the honest answer ("there is
 * no argument structure to describe"), never a synthesized wrapper key.
 */
export function redactToolArgs(args: unknown, depth = 0): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && depth < REDACT_MAX_DEPTH) {
      out[k] = redactToolArgs(v, depth + 1);
    } else {
      out[k] = typeTag(v);
    }
  }
  return out;
}

// ────────────────────────────────── the per-turn tool-call ledger ────────────────────────────────

/** One row destined for `assistant_tool_calls`, and one pair of SSE frames on the way out. `args` is
 *  ALREADY redacted by construction (see `redactToolArgs`) — there is no code path that puts a raw
 *  argument value in here. */
export interface BrokerToolCallRecord {
  /** Stable per-turn id. Correlates the `tool_call` frame with its later `tool_result`/
   *  `approval_required` frame on the wire, and becomes the row's primary key so a reload of the
   *  thread can re-associate them without a second ordering convention. */
  id: string;
  toolName: string;
  /** Which MCP server served (or would have served) it. `"mcp-hub"` for everything today; NULL only
   *  when we genuinely do not know. */
  mcpServer: string | null;
  args: Record<string, unknown>;
  /** Mirrors the column's CHECK exactly (0079): pending|running|succeeded|failed|denied. */
  status: "pending" | "running" | "succeeded" | "failed" | "denied";
  resultSummary: string | null;
  approvalId: string | null;
  durationMs: number | null;
}

/** Cap on `result_summary` — a tool result can be an entire project list; the row is an audit
 *  breadcrumb, not a cache of the payload (the payload's place is the assistant's own answer). */
const MAX_RESULT_SUMMARY = 500;

function summarize(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > MAX_RESULT_SUMMARY ? `${t.slice(0, MAX_RESULT_SUMMARY - 1)}…` : t;
}

/**
 * Persist this turn's ledger. `authorityUserId` is a REQUIRED, separate parameter (not read off the
 * records) and is re-asserted here: the column's whole purpose is "which principal did this run as",
 * so the last thing that touches it before the INSERT checks that it is a real user id rather than
 * trusting whatever the call site had lying around.
 *
 * MUST be called inside `withTenants([tenantId], …, { modules: ["assistant"] })` — the caller owns
 * the transaction so the ledger lands atomically with the assistant message it belongs to. Omitting
 * the module scope writes ZERO rows for the RIGHT tenant (0079's two-sided wall), which looks like
 * "the assistant made no tool calls" rather than an error.
 */
export async function persistToolCalls(
  c: PoolClient,
  input: { tenantId: string; messageId: string; authorityUserId: string; calls: BrokerToolCallRecord[] },
): Promise<number> {
  if (input.calls.length === 0) return 0;
  const authority = typeof input.authorityUserId === "string" ? input.authorityUserId.trim() : "";
  if (!authority || !UUID_RE.test(authority)) {
    throw new ServicePrincipalRefusedError(`authority_user_id is not a user uuid: '${input.authorityUserId}'`);
  }
  for (const call of input.calls) {
    await c.query(
      `INSERT INTO assistant_tool_calls
         (id, tenant_id, message_id, tool_name, mcp_server, args, result_summary, status,
          authority_user_id, approval_id, duration_ms, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
      [
        call.id,
        input.tenantId,
        input.messageId,
        call.toolName,
        call.mcpServer,
        JSON.stringify(call.args ?? {}),
        call.resultSummary,
        call.status,
        authority,
        call.approvalId,
        call.durationMs,
        config.originSite,
      ],
    );
  }
  return input.calls.length;
}

// ─────────────────────────────────────────── SSE emitters ────────────────────────────────────────

/** The three frames ASST-17 adds to the assistant's own SSE wire (see docs/FRONTEND-BFF-CONTRACT.md
 *  §18's ASST-17 addendum). Non-terminal, all of them: a turn still ends with exactly one `done` or
 *  `error`, unchanged from ASST-06. */
export interface BrokerEmit {
  toolCall: (c: { callId: string; toolName: string; args: Record<string, unknown> }) => void;
  toolResult: (r: { callId: string; toolName: string; status: "succeeded" | "failed" | "denied"; summary: string | null }) => void;
  /** Legacy/defensive — see `RunnerGoalDetail.approvalId`'s own doc: this broker no longer requests
   *  `fileOnSuspend:true`, so this emitter fires only if a runner ever ignores that and files
   *  anyway. */
  approvalRequired: (a: { callId: string; toolName: string; approvalId: string | null; impact: string | null }) => void;
  /** T3b (§7.2.7) — a write SUSPENDED WITHOUT FILING (the confirm-chip path, this broker's only mode
   *  today). `args` are REDACTED (shape-preserving, same `redactToolArgs` every other emitter here
   *  uses) — the real args never reach the wire; they are persisted server-side into
   *  `assistant_write_intents.tool_args` by the caller (`assistant.controller.ts`'s stream handler),
   *  keyed by the SAME `intentId` this frame carries. */
  confirmRequired: (a: { callId: string; toolName: string; intentId: string; args: Record<string, unknown>; impact: string; expiresAt: string }) => void;
}

// ─────────────────────────── "this turn may use tools" — a PERSISTED fact ────────────────────────
//
// `assistant_messages` has no `mode` column, and this ticket adds no migration. The turn's mode is
// recorded STRUCTURALLY, in the placeholder row's existing `parts` jsonb — the same "no schema change
// needed" move ASST-12 made for `usageSource` (see stream.ts's `UsageMetaPart`).
//
// WHY THE PERSISTED VALUE IS THE AUTHORITY AND THE QUERY STRING IS NOT: `GET .../stream` is opened by
// an `EventSource` whose URL the browser controls. If the stream route read the mode from `?mode=`, a
// client could flip a plain chat turn into a tool turn on a message the server never accepted as one.
// So `POST .../messages` records the mode at SEND time (from the user's own request, for the user's
// own turn — a preference, not an authority claim) and the stream route reads it back off the ROW.
// The `&mode=tools` in the returned `streamUrl` is a convenience for the client's own rendering and
// has no effect on what the server does.

export interface TurnModePart {
  type: "turn_mode";
  mode: "tools";
  agent: string;
}

/** The `parts` entry that marks a placeholder as a tool turn. */
export function turnModePart(agent: string): TurnModePart {
  return { type: "turn_mode", mode: "tools", agent };
}

/** Read the tool-turn marker back off a `parts` jsonb value. Returns `null` for every plain chat
 *  turn (including the `[]` default and any malformed value) — absent-tolerant, never throwing, so a
 *  hand-edited or future-shaped `parts` can only ever degrade a turn to plain chat, never widen it. */
export function readTurnMode(parts: unknown): TurnModePart | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "turn_mode" && (p as { mode?: unknown }).mode === "tools") {
      const agent = typeof (p as { agent?: unknown }).agent === "string" ? (p as { agent: string }).agent : DEFAULT_TOOL_AGENT;
      return { type: "turn_mode", mode: "tools", agent };
    }
  }
  return null;
}

// ─────────────────────────────────── the agent-runner wire (typed) ───────────────────────────────

/** `ai-agents/src/runner/store.ts`'s `GoalStatus`, minus the ones a fresh goal can never be. */
const TERMINAL_GOAL_STATUSES = new Set(["ok", "suspended", "budget_exhausted", "failed", "interrupted", "cancelled"]);

interface RunnerRunSummary {
  runId: string;
  status: string;
  provider: string | null;
  startedAt: number;
  endedAt: number;
}

/** T3b/T2b — the deferred-filing shape `agent-runner`'s `GET /goals/:id` merges in when a goal
 *  suspended with `fileOnSuspend:false` (`ai-agents/src/write-agent.ts`'s `SuspendedIntent`,
 *  `runner/service.ts`'s in-memory TTL map). `impact` is ALREADY the wire label (T1's `toWireImpact`,
 *  reused — never re-derived here); `args` are the model-composed args VERBATIM — the runner's one
 *  and only hand-off of real args to this process. Absent (undefined) once the runner's own TTL map
 *  evicts the entry — see the suspended-branch handling below for what that degrades to. */
interface RunnerSuspendedIntent {
  tool: string;
  impact: string;
  args: Record<string, unknown>;
}

interface RunnerGoalDetail {
  id: string;
  status: string;
  outcome: string | null;
  errorKind: string | null;
  /** The PRE-T3b, filed-immediately shape (`fileOnSuspend:true`, the runner's own default). This
   *  broker no longer requests that default (see `runToolTurn`'s `POST /goals` body below), so this
   *  field is legacy/defensive on this path now — kept, and still read first if ever present, rather
   *  than deleted: a future caller that submits `fileOnSuspend:true` (or a runner that ignores the
   *  flag) must still be handled correctly, not silently mishandled by code that assumes the newer
   *  shape is the only one. */
  approvalId: string | null;
  /** T3b/T2b — present only on a `fileOnSuspend:false` suspension (this broker's only mode). */
  suspendedIntent?: RunnerSuspendedIntent | null;
  runs?: RunnerRunSummary[];
}

interface RunnerStep {
  kind: "model" | "tool";
  detail: string;
}

interface RunnerRunDetail {
  runId: string;
  provider: string | null;
  steps?: RunnerStep[];
  startedAt: number;
  endedAt: number;
}

/**
 * The tools a given assistant agent may need, mirrored from `ai-agents/src/specialists.ts`
 * (`specialists` for the read-only entries, `writeSpecialists` for `task-filer`).
 *
 * Yes, this is a mirror, and mirrors drift — so keep its JOB narrow: it decides only WHICH tools the
 * capability gate asks the hub about for this turn. It is never an authorization source (the hub +
 * Cerbos are, twice), and a stale entry can only make the gate ask about a tool the run would not
 * have used — an over-strict refusal, never an under-strict allow. That asymmetry is why a mirror is
 * acceptable here and would not be if this list gated execution.
 *
 * ── ASST-23 — THE WRITE-MAP CONTRACT (supersedes the old "read-only agents only" pin) ──────────────
 * Until ASST-23, every agent this map named was read-only BY CONSTRUCTION and that was pinned as a
 * hard invariant (`core/d14-17-assistant-write-registry.test.ts`'s tests (A)/(A-reverse)). That
 * guarantee is now retired, on purpose: `task-filer` is a WRITE-capable agent, and the assistant's
 * write half is §7's proposal model — a `high_write` the agent declares (`ai-agents/src/
 * specialists.ts`'s `writeSpecialists`) suspends and files an `origin='agent'` approval row exactly
 * the way D14 already does for automation, surfaced in-thread as `approval_required` (below), never
 * executed by the broker itself.
 *
 * The successor invariant, now enforced by BOTH a runtime gate (step 0.5 in `runToolTurn`, below) and
 * a rewritten test:
 *   1. Every tool named in `ASSISTANT_AGENT_WRITE_TOOLS[agent]` MUST have a registered
 *      `core/approval-executables.ts` entry (`getExecutable(name) !== undefined`) — enforced live,
 *      not just pinned: a turn naming an agent with an unregistered write tool is refused, typed, at
 *      proposal time, and the runner is never contacted (mirrors wall 1's "provably nothing ran"
 *      shape).
 *   2. `ASSISTANT_AGENT_WRITE_TOOLS[agent]` is always a SUBSET of `ASSISTANT_AGENT_TOOLS[agent]` — the
 *      broker can never propose a write for a tool the agent isn't even allowed to call.
 *   3. Every tool in `ASSISTANT_AGENT_TOOLS` that is NOT also in `ASSISTANT_AGENT_WRITE_TOOLS[agent]`
 *      stays unregistered in `approval-executables.ts` — a read genuinely stays a read; nothing here
 *      quietly promotes a read-only mirror entry into something the executor would act on.
 */
export const ASSISTANT_AGENT_TOOLS: Record<string, readonly string[]> = {
  "status-reporter": ["projects.list", "tasks.list"],
  "approvals-chaser": ["agency.pendingApprovals"],
  // ASST-23 (§7.1 — both v1 PM writes ship together): mirrors ai-agents' `writeSpecialists.task-filer`
  // (T2, `ai-agents/src/specialists.ts`) — read tools it needs to compose a proposal PLUS the two
  // `high_write` tools it may propose. Both write tools already have a D14-15 registry entry
  // (`core/approval-executables.ts`'s `registerPmExecutableApprovals()`), so step 0.5 below passes for
  // this agent today; that registration is what T2's `RERUN_CAPABLE_HIGH_WRITES` allowlist consumes.
  "task-filer": ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"],
  // SMM-35 (closing the assistant's remaining half): mirrors `task-filer`'s own shape exactly — one
  // read the agent needs to compose a sane proposal (`social.listThreadMessages`, so it answers what
  // a thread actually says) plus the ONE `high_write` it may propose. `social.createReplyDraft` only
  // ever inserts our own draft row (never sent, never network-visible) and has its own D14 registry
  // entry (`core/approval-executables.ts`'s `registerSocialReplyDraftExecutableApproval()`), so step
  // 0.5 below passes for this agent today. Deliberately does NOT include `social.sendReply` or
  // `social.publishPost` — see that registry entry's own header for why those stay excluded on
  // SECURITY grounds (SMM-26's "agents draft, never publish"), not a registration gap.
  "social-drafter": ["social.listThreadMessages", "social.createReplyDraft"],
};

/**
 * The WRITE subset of `ASSISTANT_AGENT_TOOLS`, per agent — the tools this agent may PROPOSE (file a
 * D14 approval for), as opposed to merely call as a read. See the write-map contract above.
 *
 * An agent absent from this map (every read-only one, e.g. `status-reporter`/`approvals-chaser`) is
 * read-only in exactly the old sense — `ASSISTANT_AGENT_WRITE_TOOLS[agent] ?? []` is `[]`, so step 0.5
 * is a no-op for it and it can never reach `approval_required` through any tool of its own.
 */
export const ASSISTANT_AGENT_WRITE_TOOLS: Record<string, readonly string[]> = {
  "task-filer": ["pm.createTask", "pm.createDoc"],
  "social-drafter": ["social.createReplyDraft"],
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ASST-23 / T2b FINDING — NEITHER MIRROR ABOVE MAY EVER NAME A DELEGATING/FAN-OUT AGENT
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T2b (ai-agents, landed in parallel with this file) found that a goal routed through the SUPERVISOR's
// fan-out path (`ai-agents/src/specialists.ts`'s `supervisor`, which delegates to sub-runs rather than
// holding its own `tools`) still files a suspended write IMMEDIATELY even under `fileOnSuspend:false`
// — the confirm-chip machinery (§7.2, T2b/T3b) is scoped to a SINGLE write-specialist's own
// suspend-and-file boundary (`runWriteAgent`), not to a fan-out of several. If this broker ever named
// the supervisor here, a chat turn would silently bypass the owner's confirm gate the instant T3b
// ships, with no other signal that it happened.
//
// `ai-agents` and `platform-nest` are separate standalone projects (CLAUDE.md's "not a monorepo"
// rule) — this file cannot import ai-agents' `AgentDef` to check "is this agent delegating"
// structurally from the shape of the real definition. The enforceable boundary AT THIS SIDE is
// therefore by NAME: today there is exactly one delegating construct in ai-agents, named
// `"supervisor"`. If ai-agents ever adds a second fan-out/delegating agent under a different name,
// add that name here too — this denylist is what fails LOUDLY (at import time, not just in a test
// someone could skip) if either mirror above is ever widened to include one.
const FORBIDDEN_DELEGATING_AGENTS = new Set<string>(["supervisor"]);

function assertNoDelegatingAgent(mirror: Record<string, readonly string[]>, mirrorName: string): void {
  for (const name of Object.keys(mirror)) {
    if (FORBIDDEN_DELEGATING_AGENTS.has(name)) {
      throw new Error(
        `${mirrorName} names '${name}', a delegating/fan-out agent. T2b found that a fileOnSuspend:false ` +
          "goal routed through the supervisor still files a write immediately, bypassing the owner's confirm " +
          "chip (§7.2 of docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md) — the broker must only " +
          "ever drive a single specialist/write-specialist per turn, never a fan-out orchestrator.",
      );
    }
  }
}

assertNoDelegatingAgent(ASSISTANT_AGENT_TOOLS, "ASSISTANT_AGENT_TOOLS");
assertNoDelegatingAgent(ASSISTANT_AGENT_WRITE_TOOLS, "ASSISTANT_AGENT_WRITE_TOOLS");

/** The agent a tool turn uses when the caller names none. `status-reporter` is the read-only
 *  specialist whose allow-list is exactly the two company-data reads a chat turn most often needs. */
export const DEFAULT_TOOL_AGENT = "status-reporter";

// ─────────────────────────────────────────── the turn itself ─────────────────────────────────────

export interface ToolTurnInput {
  /** The chatting user. The ONLY authority input — see this file's header. */
  user: ChattingUser;
  /** The assembled prompt (context.ts's output), handed to the runner as the goal. */
  prompt: string;
  /** Which read-only specialist to drive; must be a key of `ASSISTANT_AGENT_TOOLS`. */
  agent?: string;
  emit: BrokerEmit;
  /** Aborted by the same signal the SSE relay uses, so `POST .../stop` and a client disconnect
   *  cancel the poll loop instead of leaving it spinning against the runner. */
  signal?: AbortSignal;

  // ── seams (tests + callers with their own transport). All default to the live wiring. ──────────
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  hubUrl?: string;
  hubToken?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Override the capability gate's source. Default: the hub's `tools/list` under the user's OBO
   *  envelope. Injectable so a test can drive the gate without a hub process — but note the DEFAULT
   *  is the Cerbos-authoritative one, so forgetting to inject fails CLOSED (no visible tools ⇒
   *  refuse), never open. */
  visibleTools?: (user: ChattingUser) => Promise<Set<string>>;
  /** Override the suspended-write lookup (`automation_approvals`). Default: a tenant-scoped read. */
  readApproval?: (approvalId: string, tenantId: string) => Promise<{ toolName: string; args: unknown; impact: string | null } | null>;
  /** Override the self-link upsert. Default: `ensurePlatformSelfLink`. */
  ensureLink?: (userId: string) => Promise<void>;
}

export type ToolTurnOutcome = "answered" | "refused" | "suspended" | "error";

/** T3b — the REAL (unredacted) intent info a caller must persist into `assistant_write_intents`, in
 *  the SAME transaction it persists this turn's (redacted) `toolCalls` ledger row. `id` is the
 *  intent's own future primary key (pre-generated here, mirroring how `BrokerToolCallRecord.id` is
 *  pre-generated) so the `confirm_required` SSE frame (already emitted, by the time the caller sees
 *  this) and the eventual DB row agree on the same id without a second round trip. `toolCallId` names
 *  which entry in THIS SAME result's `toolCalls` array the intent belongs to (composite FK target). */
export interface SuspendedIntentResult {
  id: string;
  toolCallId: string;
  toolName: string;
  impact: string;
  /** REAL args, verbatim from the runner — never redacted here. The caller redacts only when
   *  persisting the `assistant_tool_calls` ledger row; this field is what it persists, unredacted,
   *  into `assistant_write_intents.tool_args`. */
  args: Record<string, unknown>;
  agent: string;
  expiresAt: string; // ISO — config.assistantIntentTtlMs (write-intents.ts's intentTtlMs()) from now
}

export interface ToolTurnResult {
  outcome: ToolTurnOutcome;
  /** What goes into the assistant message's `content` and onto the wire as token text. Always a
   *  string — a refusal and an error both have something for the user to read. */
  text: string;
  toolCalls: BrokerToolCallRecord[];
  /** Set for every non-`answered` outcome, so the caller persists a typed `error_kind` rather than
   *  string-matching `text`. */
  errorKind?: string;
  /** The provider the runner reported for the serving run, when it reported one. */
  provider?: string;
  /** Legacy/defensive — set only on the `approvalId`-filed branch (see `RunnerGoalDetail`'s doc);
   *  this broker's own requests never produce it today. */
  approvalId?: string;
  /** T3b — set only on the confirm-chip branch (`goal.suspendedIntent`, this broker's only mode for a
   *  suspended write). The caller persists it into `assistant_write_intents` alongside `toolCalls`. */
  intent?: SuspendedIntentResult;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

class AbortedError extends Error {}

function runnerBase(input: ToolTurnInput): string {
  return (input.runnerUrl ?? config.services.agents.url).replace(/\/$/, "");
}

/** One tool the hub reports as visible to a principal — `tools/list`'s own `{name, description}`
 *  shape, undecorated. ASST-18's capabilities panel needs the description; the capability GATE
 *  (below) only ever needed the name, which is why this used to return a bare `Set<string>` —
 *  `listUserVisibleTools` is kept as a thin wrapper over this so neither caller can drift from the
 *  other about what the hub actually said. */
export interface VisibleToolDef {
  name: string;
  description: string;
}

/**
 * Ask the hub which tools THIS USER can see, under the user's own OBO envelope — THE ONE fetch this
 * whole assistant surface makes against `tools/list`. Both wall 1 (the capability gate, via
 * `listUserVisibleTools` below) and ASST-18's `GET .../assistant/capabilities`
 * (`./capabilities.ts`) build on this single function, so "did the gate and the capabilities PANEL
 * ever disagree about what the hub said?" cannot happen by construction.
 *
 * The hub answers `tools/list` with `visibleToolsFor(principal)` — Cerbos-authoritative when
 * `CERBOS_URL` is set, deny-by-default in-code otherwise (`mcp-hub/src/policy.ts`). Fails CLOSED in
 * every direction: an unconfigured hub, a non-2xx, an unparsable body or a transport error all yield
 * an EMPTY array, which every caller reads as "this user can see nothing" — never "assume
 * authorized". A hub we cannot reach is not evidence that the user IS authorized, and (ASST-18) not
 * evidence they are NOT, either — it is simply unavailable, which is why the capabilities endpoint
 * reports `hubConfigured` separately rather than collapsing "denied" and "unreachable" into the same
 * silent empty list.
 */
export async function listUserVisibleToolDefs(
  user: ChattingUser,
  opts: { fetchImpl?: typeof fetch; hubUrl?: string; hubToken?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<VisibleToolDef[]> {
  const url = (opts.hubUrl ?? config.services.hub.url).replace(/\/$/, "");
  const token = opts.hubToken ?? config.services.hub.token;
  if (!url || !token) return [];
  const envelope = oboEnvelopeFor(user);
  assertUserProvider(envelope.provider);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? config.adminProbeTimeoutMs * 3);
  const onOuterAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);
  try {
    const res = await fetchImpl(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "x-obo-provider": envelope.provider,
        "x-obo-external-id": envelope.externalId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: ac.signal,
    });
    if (!res.ok) return [];
    const raw = await res.text();
    const source = raw.trim().startsWith("{")
      ? raw.trim()
      : (raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "");
    if (!source) return [];
    const rpc = JSON.parse(source) as { result?: { tools?: Array<{ name?: unknown; description?: unknown }> } };
    const out: VisibleToolDef[] = [];
    for (const t of rpc.result?.tools ?? []) {
      if (typeof t?.name === "string" && t.name) {
        out.push({ name: t.name, description: typeof t.description === "string" ? t.description : "" });
      }
    }
    return out;
  } catch {
    return []; // fail closed — see this function's header
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** The capability GATE's own shape: just the names, as a `Set` for O(1) membership checks. A thin
 *  derivation of `listUserVisibleToolDefs` (above) — never a second fetch. */
export async function listUserVisibleTools(
  user: ChattingUser,
  opts: { fetchImpl?: typeof fetch; hubUrl?: string; hubToken?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Set<string>> {
  const defs = await listUserVisibleToolDefs(user, opts);
  return new Set(defs.map((d) => d.name));
}

/** Default `readApproval`: the suspended write's own row, tenant-scoped. Imported lazily (inside the
 *  function) so this module has no import cycle with the approvals surface. */
async function readApprovalRow(
  approvalId: string,
  tenantId: string,
): Promise<{ toolName: string; args: unknown; impact: string | null } | null> {
  const { withTenants } = await import("../../db");
  return withTenants([tenantId], async (c) => {
    const r = await c.query<{ tool_name: string; tool_args: unknown; impact: string | null }>(
      `SELECT tool_name, tool_args, impact FROM automation_approvals WHERE id = $1`,
      [approvalId],
    );
    const row = r.rows[0];
    return row ? { toolName: row.tool_name, args: row.tool_args, impact: row.impact } : null;
  });
}

/**
 * Run ONE tool-using turn.
 *
 * Never throws for an upstream condition — every failure is classified into a `ToolTurnResult` with a
 * typed `errorKind`, the same "one shape for the caller to persist" discipline `stream.ts`'s
 * `relayGeneration` established. It DOES throw `ServicePrincipalRefusedError`, deliberately and
 * unconditionally, when the authority is not a plain chatting user: that is a programming error in
 * this platform, not an upstream condition, and it must never be degraded into a rendered message.
 */
export async function runToolTurn(input: ToolTurnInput): Promise<ToolTurnResult> {
  // (0) Authority first, before ANY network call: nothing about this turn is allowed to happen if we
  // cannot name a real chatting user for it.
  const envelope = oboEnvelopeFor(input.user);
  assertUserProvider(envelope.provider);

  const agent = input.agent ?? DEFAULT_TOOL_AGENT;
  const required = ASSISTANT_AGENT_TOOLS[agent];
  if (!required) {
    return {
      outcome: "error",
      text: `The assistant cannot run '${agent}' — it is not one of its tool agents.`,
      toolCalls: [],
      errorKind: "unknown_agent",
    };
  }

  const toolCalls: BrokerToolCallRecord[] = [];

  // (0.5) THE REGISTRY GATE (ASST-23, §2.3/§7.4) — every write tool THIS agent may propose must
  // already have a server-side `core/approval-executables.ts` entry, or the turn is refused HERE,
  // typed, before the hub is even asked and LONG before any goal exists. This is deliberately its own
  // step, not folded into wall 1: wall 1 answers "may this USER call this tool" (a Cerbos question);
  // this answers "if this agent's model proposes a write, does anything exist that could ever execute
  // it" (a platform-registry question, decided once, in-process, with no network call of its own).
  // Getting this wrong in the permissive direction would let a `high_write` agent get filed, approved,
  // and then dead-end at `execution_status='not_applicable'` with a human none the wiser until they
  // read the row — this gate is what makes the dead end visible in-thread, at proposal time, instead.
  const writeTools = ASSISTANT_AGENT_WRITE_TOOLS[agent] ?? [];
  const unexecutable = writeTools.filter((toolName) => getExecutable(toolName) === undefined);
  if (unexecutable.length > 0) {
    // Same "provably nothing ran" shape as wall 1's refusal, below: a `denied` row per offending tool,
    // no arguments (none were ever composed — the goal never started), and the runner is NEVER
    // contacted. `errorKind: "tool_not_executable"` is its own typed reason, distinct from wall 1's
    // `tool_denied` (a Cerbos/visibility refusal) — this one is "even if you were allowed to call it,
    // nothing here can execute it yet."
    for (const toolName of unexecutable) {
      const record: BrokerToolCallRecord = {
        id: newId(),
        toolName,
        mcpServer: "mcp-hub",
        args: {},
        status: "denied",
        resultSummary: summarize(
          `denied: '${toolName}' has no registered approval-executable entry yet — the tool was NOT proposed and nothing was run`,
        ),
        approvalId: null,
        durationMs: null,
      };
      toolCalls.push(record);
      input.emit.toolCall({ callId: record.id, toolName, args: record.args });
      input.emit.toolResult({ callId: record.id, toolName, status: "denied", summary: record.resultSummary });
    }
    return {
      outcome: "refused",
      text:
        `I can't propose that write yet: ${unexecutable.join(", ")} ${unexecutable.length === 1 ? "has" : "have"} no ` +
        "approval-executable entry registered on this platform. Nothing was run on your behalf.",
      toolCalls,
      errorKind: "tool_not_executable",
    };
  }

  // (1) WALL 1 — the capability gate, under the user's OWN envelope. Runs BEFORE the goal exists.
  const visible = await (input.visibleTools ?? ((u: ChattingUser) =>
    listUserVisibleTools(u, {
      fetchImpl: input.fetchImpl,
      hubUrl: input.hubUrl,
      hubToken: input.hubToken,
      signal: input.signal,
    })))(input.user);
  const missing = required.filter((t) => !visible.has(t));
  if (missing.length > 0) {
    // Typed, visible, in-thread — and provably nothing ran: we return before the runner is contacted
    // at all, so there is no goal, no hub call, and no principal of any kind involved in an execution.
    for (const toolName of missing) {
      const record: BrokerToolCallRecord = {
        id: newId(),
        toolName,
        mcpServer: "mcp-hub",
        args: {}, // no call was ever made, so there are no arguments to describe
        status: "denied",
        resultSummary: summarize(
          `denied: your account is not authorized to call ${toolName} — the tool was NOT executed (no service principal was used)`,
        ),
        approvalId: null,
        durationMs: null,
      };
      toolCalls.push(record);
      input.emit.toolCall({ callId: record.id, toolName, args: record.args });
      input.emit.toolResult({ callId: record.id, toolName, status: "denied", summary: record.resultSummary });
    }
    return {
      outcome: "refused",
      text:
        `I can't answer that with tools: your account isn't authorized to use ${missing.join(", ")}. ` +
        "Nothing was run on your behalf. Ask an administrator for access, or ask me something I can answer without those tools.",
      toolCalls,
      errorKind: "tool_denied",
    };
  }

  // (2) The self-link the envelope resolves through, then submit the goal.
  const base = runnerBase(input);
  if (!base) {
    return {
      outcome: "error",
      text: "The assistant's tool runtime is not configured (AGENTS_URL unset), so it can't use tools right now.",
      toolCalls,
      errorKind: "not_configured",
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = input.runnerToken ?? config.services.agents.token;
  await (input.ensureLink ?? ensurePlatformSelfLink)(input.user.userId);

  let goalId: string;
  try {
    const res = await fetchImpl(`${base}/goals`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        tenantId: input.user.tenantId,
        goal: input.prompt,
        agent,
        // The ONE envelope, from the ONE function that can spell one. Never a body-supplied value.
        envelope,
        requestedBy: envelope.externalId,
        // T3b (§7.2.2/§7.2.5) — the owner's confirm-chip override. EVERY chat-path tool turn defers
        // filing: a `high_write` suspension is captured as `goal.suspendedIntent`, never filed
        // through the hub, until the owner explicitly confirms it (see the suspended branch below).
        // Harmless for a read-only agent (it never suspends, so the flag is never consulted) and for
        // a goal that never suspends at all — this is why it is sent UNCONDITIONALLY rather than only
        // for write-capable agents. The handoff path (`handoffs.ts`'s `createHandoff`) is a DIFFERENT
        // goal-submission call, but as of 2026-08-07 it ALSO sends `fileOnSuspend: false` — §7.2.5's
        // original "the handoff click is itself the explicit consent" scope note was overruled by the
        // owner (see `docs/superpowers/plans/2026-08-07-handoff-confirm-report.md`): a handoff's
        // suspended write is now harvested into the SAME `assistant_write_intents`/confirm-chip
        // machinery this file's own suspended branch below feeds, just entered from `handoffs.ts`'s
        // `refreshHandoff` instead of from here — see that file's header for the harvest.
        fileOnSuspend: false,
      }),
      signal: input.signal,
    });
    if (!res.ok) {
      return {
        outcome: "error",
        text: `The assistant's tool runtime refused the request (HTTP ${res.status}).`,
        toolCalls,
        errorKind: res.status === 429 ? "runner_busy" : "runner_error",
      };
    }
    const body = (await res.json()) as { id?: unknown };
    if (typeof body?.id !== "string" || !body.id) {
      return { outcome: "error", text: "The assistant's tool runtime returned no goal id.", toolCalls, errorKind: "runner_error" };
    }
    goalId = body.id;
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return {
      outcome: "error",
      text: aborted ? "The tool turn was stopped." : "The assistant's tool runtime is unreachable.",
      toolCalls,
      errorKind: aborted ? "stopped" : "transport_error",
    };
  }

  // (3) Poll to a terminal status. The runner is a QUEUED service (design §3.2) with no incremental
  // output — that is why the final answer arrives at once (see `text` below) rather than being faked
  // into a token cadence the runtime never produced.
  let goal: RunnerGoalDetail;
  try {
    goal = await pollGoal({ base, token, goalId, tenantId: input.user.tenantId, fetchImpl, input });
  } catch (err) {
    if (err instanceof AbortedError) {
      return { outcome: "error", text: "The tool turn was stopped.", toolCalls, errorKind: "stopped" };
    }
    return {
      outcome: "error",
      text: "The assistant's tool runtime stopped responding.",
      toolCalls,
      errorKind: (err as Error)?.message === "timeout" ? "idle_timeout" : "transport_error",
    };
  }

  // (4) Harvest the run transcripts into the ledger + the SSE relay.
  //
  // Reading a run transcript server-side here is NOT the elevated-only read the intelligence
  // controller guards: that rule protects an ADMIN from reading through a DIFFERENT user's authority.
  // This run executed under THIS user's envelope, and its output is being relayed into THIS user's
  // own owner-private thread — the transcript is going exactly where it was already permitted to go.
  const provider = goal.runs?.find((r) => r.provider)?.provider ?? undefined;
  for (const summary of goal.runs ?? []) {
    const run = await fetchRun({ base, token, runId: summary.runId, tenantId: input.user.tenantId, fetchImpl, input });
    if (!run) continue;
    const toolSteps = (run.steps ?? []).filter((s) => s.kind === "tool");
    for (const step of toolSteps) {
      const ok = / ok$/.test(step.detail);
      const toolName = step.detail.replace(/ (ok|failed)$/, "");
      const record: BrokerToolCallRecord = {
        id: newId(),
        toolName,
        mcpServer: "mcp-hub",
        // The runner's step transcript carries no arguments at all — see this file's redaction
        // header for why that is a feature, not a gap to close.
        args: {},
        status: ok ? "succeeded" : "failed",
        resultSummary: ok ? null : summarize(`the tool call failed or was refused under your own permissions (${toolName})`),
        approvalId: null,
        durationMs: null,
      };
      toolCalls.push(record);
      input.emit.toolCall({ callId: record.id, toolName, args: record.args });
      input.emit.toolResult({ callId: record.id, toolName, status: record.status === "succeeded" ? "succeeded" : "failed", summary: record.resultSummary });
    }
  }

  // (5) Terminal mapping.
  if (goal.status === "suspended") {
    // T3b (§7.2.7) — `fileOnSuspend: false` is sent UNCONDITIONALLY above, so `goal.suspendedIntent`
    // is this broker's ONLY suspended-write shape today: a write became a DRAFT, not yet a proposal.
    // Nothing has been filed, nobody has been notified, and D14's chain has not started — see
    // `write-intents.ts`'s header for the confirm/dismiss state machine that takes it from here.
    if (goal.suspendedIntent) {
      const intent = goal.suspendedIntent;
      const intentId = newId();
      const toolCallId = newId();
      const redactedArgs = redactToolArgs(intent.args);
      const expiresAt = new Date(Date.now() + intentTtlMs()).toISOString();
      const record: BrokerToolCallRecord = {
        id: toolCallId,
        toolName: intent.tool,
        mcpServer: "mcp-hub",
        args: redactedArgs,
        status: "pending",
        resultSummary: summarize(goal.outcome ?? "awaiting your confirmation before this is sent for approval"),
        approvalId: null,
        durationMs: null,
      };
      toolCalls.push(record);
      input.emit.confirmRequired({ callId: toolCallId, toolName: intent.tool, intentId, args: redactedArgs, impact: intent.impact, expiresAt });
      return {
        outcome: "suspended",
        text:
          goal.outcome ??
          `I've drafted a ${intent.tool} write. Confirm it to send it for approval, or dismiss it — nothing has been changed or sent yet.`,
        toolCalls,
        errorKind: "confirm_required",
        provider,
        intent: { id: intentId, toolCallId, toolName: intent.tool, impact: intent.impact, args: intent.args, agent, expiresAt },
      };
    }

    // Legacy/defensive fallback — NOT this broker's normal path (see `RunnerGoalDetail`'s doc on
    // `approvalId`): either a runner filed anyway (`fileOnSuspend:true` ignored or a future default
    // change), or the sub-second worst case the design names — the runner's in-memory intent TTL map
    // evicted (or never received) the entry between `finishGoal` and this poll (e.g. a runner restart
    // mid-flight). Both degrade to an honest, typed message rather than a silent hang or a fabricated
    // proposal.
    const approvalId = goal.approvalId ?? undefined;
    let toolName = "(unknown tool)";
    let impact: string | null = null;
    let args: Record<string, unknown> = {};
    if (approvalId) {
      try {
        const row = await (input.readApproval ?? readApprovalRow)(approvalId, input.user.tenantId);
        if (row) {
          toolName = row.toolName;
          impact = row.impact;
          // THE redaction call that matters: these are REAL arguments, from the filed approval row.
          args = redactToolArgs(row.args);
        }
      } catch {
        // A missing/unreadable approval row must not turn a correctly-suspended write into a 500 —
        // the suspension itself is the fact the user needs.
      }
    }
    if (approvalId) {
      const record: BrokerToolCallRecord = {
        id: newId(),
        toolName,
        mcpServer: "mcp-hub",
        args,
        status: "pending",
        resultSummary: summarize(goal.outcome ?? "waiting for human approval"),
        approvalId,
        durationMs: null,
      };
      toolCalls.push(record);
      input.emit.approvalRequired({ callId: record.id, toolName, approvalId, impact });
      return {
        outcome: "suspended",
        text: goal.outcome ?? `That needs a human approval before it can run (approval ${approvalId}). Nothing was changed.`,
        toolCalls,
        errorKind: "approval_required",
        provider,
        approvalId,
      };
    }
    // Neither shape present: the intent was lost (evicted/never-received), not filed. Loud and typed,
    // never a fabricated proposal and never a silent hang.
    return {
      outcome: "error",
      text: "The proposal for that write was lost before it could be shown — please ask again.",
      toolCalls,
      errorKind: "intent_lost",
      provider,
    };
  }

  if (goal.status === "ok") {
    return { outcome: "answered", text: goal.outcome ?? "", toolCalls, provider };
  }

  return {
    outcome: "error",
    text: goal.outcome ?? "The assistant's tool run did not complete.",
    toolCalls,
    errorKind: goal.errorKind ?? goal.status ?? "runner_error",
    provider,
  };
}

async function pollGoal(ctx: {
  base: string;
  token: string;
  goalId: string;
  tenantId: string;
  fetchImpl: typeof fetch;
  input: ToolTurnInput;
}): Promise<RunnerGoalDetail> {
  const interval = ctx.input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (ctx.input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  for (;;) {
    if (ctx.input.signal?.aborted) throw new AbortedError("aborted");
    const res = await ctx.fetchImpl(
      `${ctx.base}/goals/${encodeURIComponent(ctx.goalId)}?tenant=${encodeURIComponent(ctx.tenantId)}`,
      { headers: ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}, signal: ctx.input.signal },
    );
    if (!res.ok) throw new Error(`goal read ${res.status}`);
    const goal = (await res.json()) as RunnerGoalDetail;
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) return goal;
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}

async function fetchRun(ctx: {
  base: string;
  token: string;
  runId: string;
  tenantId: string;
  fetchImpl: typeof fetch;
  input: ToolTurnInput;
}): Promise<RunnerRunDetail | null> {
  try {
    const res = await ctx.fetchImpl(
      `${ctx.base}/runs/${encodeURIComponent(ctx.runId)}?tenant=${encodeURIComponent(ctx.tenantId)}`,
      { headers: ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}, signal: ctx.input.signal },
    );
    if (!res.ok) return null;
    return (await res.json()) as RunnerRunDetail;
  } catch {
    // A transcript we cannot read must not fail a turn whose ANSWER already arrived — the ledger is
    // then simply thinner, which is honest, and the goal's own outcome still reaches the user.
    return null;
  }
}
