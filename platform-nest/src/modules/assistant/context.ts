// ASST-06 — context assembly + compaction v1.
// ASST-19 — user-memory injection, quarantined to CONFIRMED rows only (see below).
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-06", "### ASST-19").
// Design: docs/blueprints/assistant-foundation.md §4.1 ("thread memory" — resuming an old session
// is EXACT, not approximate) and §4.1's "four memories" (user memory is #2 of 4) and §5
// (streaming/transport).
//
// ── WHY THIS BUILDS ONE PROMPT STRING, NOT A CHAT-MESSAGES ARRAY ─────────────────────────────────
// ai-gateway-go's `/complete` and `/complete/stream` both take a single `{ prompt: string }` body
// (server.go) — there is no messages-array shape on this wire. So "context assembly" here means
// rendering the system preamble + rolling compaction summary + recent transcript into ONE string,
// not picking a chat-completions message format.
//
// ── COMPACTION v1 (blueprint §4.1) ─────────────────────────────────────────────────────────────────
// The RAW messages are NEVER deleted or edited — `assistant_messages` is the exact, replayable
// transcript (that is the whole point of not being aivory's localStorage sessions, blueprint §8's
// "where the ERP must deliberately diverge" #1). What compaction does is fold the OLDEST messages
// beyond the current budget into `assistant_threads.compaction_summary` (via one `/complete` call
// to the gateway) and advance `compaction_summary_upto_seq`, so a later resume of an old thread
// still shows every message (GET /threads/:id already pages through all of them) while a NEW
// generation's prompt only carries the summary + the newest messages that fit the budget — never a
// silently-truncated transcript.
//
// ── THE QUARANTINE (ASST-19 — THE INVARIANT THAT MATTERS MOST) ────────────────────────────────────
// `assistant_memory` writes are PROPOSALS (blueprint §4.1): the assistant asks "remember this?",
// and a row is recorded immediately with `confirmed_at IS NULL` — for audit and for the confirm
// UI — but it is NOT yet trusted. `fetchConfirmedMemory` below is the ONLY place this file reads
// `assistant_memory`, and its WHERE clause is the entire gate: `confirmed_at IS NOT NULL`. An
// unconfirmed row must NEVER reach a model call — the same discipline
// `ai-agents/src/memory/episodic.ts` applies to untrusted feedback (recorded, never fed as
// signal). Do not add a second read path for this table that skips the predicate, and do not
// relax it under test pressure — that is exactly the leak class this file exists to prevent (the
// assistant would start treating unverified guesses as user facts).
import type { PoolClient } from "pg";
import { config } from "../../config";
import { recordGatewayCall, outcomeForGatewayStatus, readGatewayUsage, type AiCallAttribution } from "../ai-usage/gateway-usage";
import { refreshThreadCost } from "./thread-cost";
import { searchKnowledgeStrict, type KnowledgeHit, type KnowledgeStoreHit } from "../search/knowledge-client";
import { collapseHits, filterReadableHits, searchTopK } from "../knowledge/search-filter";
import { assemblePrincipal, type Principal } from "../../rbac/principal";

/** The assistant's fixed system preamble. Deliberately generic in Phase 1 — no per-department
 *  persona (blueprint D-B: "one Hermes front door", personas deferred), no tool-capability list
 *  (the tool broker is Phase 3, ASST-05's header). */
const SYSTEM_PREAMBLE =
  "You are the Gaiada ERP Assistant, a helpful assistant embedded in the company's internal " +
  "platform. Answer the user's latest message directly and concisely, using the conversation so " +
  "far (and the summary of anything older, if present) as context.";

interface ThreadForContext {
  ownerUserId: string;
  compactionSummary: string | null;
  compactionSummaryUptoSeq: number | null;
}

interface MessageForContext {
  seq: number;
  role: string;
  content: string | null;
}

function speakerLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    default:
      return "System";
  }
}

function renderMessage(m: MessageForContext): string {
  return `${speakerLabel(m.role)}: ${m.content ?? ""}`;
}

function renderTranscript(messages: MessageForContext[]): string {
  return messages.map(renderMessage).join("\n");
}

// ── ASST-19: confirmed-only user memory ────────────────────────────────────────────────────────────

interface MemoryForContext {
  content: string;
}

/** Default cap on how much confirmed memory can occupy in the prompt — kept small and separate
 *  from `contextCharBudget` (the recent-transcript budget) so a long memory list can never crowd
 *  out the actual conversation. */
const DEFAULT_MEMORY_CHAR_BUDGET = 2000;
/** Row cap on the underlying query — belt-and-braces alongside the char budget below; a runaway
 *  memory list should never turn this into an unbounded scan. */
const MEMORY_ROW_LIMIT = 100;

/**
 * THE QUARANTINE GATE (see this file's header). Reads `assistant_memory` for exactly one owner,
 * filtered to `confirmed_at IS NOT NULL` — an unconfirmed (proposed-but-not-yet-confirmed) row is
 * invisible to this query, full stop. `scope` ('user' | 'company') is NOT filtered here: per
 * ASST-02, `assistant_memory` access (including this read) is owner-only end to end with no
 * broader company-visibility grant yet — `scope` currently only describes WHAT the fact is about
 * (a personal preference vs. something about the company the user chose to have remembered), not
 * WHO else can see it. Both scopes are therefore equally "this owner's confirmed memory" today;
 * see assistant.controller.ts's header for the fuller rationale.
 *
 * Ordered pinned-first, then most-recently-confirmed — the same priority the confirm UI uses, so
 * if the char budget below truncates the list, what survives is the same "most important first"
 * ordering a human would expect.
 */
async function fetchConfirmedMemory(c: PoolClient, ownerUserId: string): Promise<MemoryForContext[]> {
  const { rows } = await c.query<MemoryForContext>(
    `SELECT content FROM assistant_memory
       WHERE owner_user_id = $1 AND confirmed_at IS NOT NULL
       ORDER BY pinned DESC, confirmed_at DESC
       LIMIT $2`,
    [ownerUserId, MEMORY_ROW_LIMIT],
  );
  return rows;
}

/** Render confirmed memory rows into a bulleted block, truncated to `charBudget`. Returns `null`
 *  (never an empty string) when there is nothing to say, so callers can `if (block)` cleanly. */
function renderMemory(rows: MemoryForContext[], charBudget: number): string | null {
  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = `- ${r.content}`;
    if (used + line.length > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export interface SummarizeOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
  fetchImpl?: typeof fetch;
  tenantId?: string;
}

export class CompactionGatewayError extends Error {}

/** One non-streaming `POST /complete` call to fold an excerpt into the rolling summary. Fails
 *  LOUDLY (throws) rather than silently skipping compaction — a swallowed failure here would let
 *  context assembly silently keep exceeding its budget on every subsequent send to a long thread,
 *  which is a worse failure mode than the send itself failing once and being retried. */
async function summarizeExcerpt(excerpt: string, existingSummary: string | null, attribution: AiCallAttribution, opts?: SummarizeOptions): Promise<string> {
  const url = (opts?.gatewayUrl ?? config.services.gateway.url).replace(/\/$/, "");
  if (!url) {
    throw new CompactionGatewayError("ai-gateway-go is not configured (GATEWAY_URL unset) — cannot compact this thread's context");
  }
  const prompt =
    `Summarize the following excerpt from a conversation in a few dense sentences, preserving ` +
    `concrete facts, decisions and open questions. Do not add commentary or preamble, output only ` +
    `the summary.${existingSummary ? ` Fold it into this EXISTING summary rather than replacing it ` +
    `(merge, don't just append):\n\nEXISTING SUMMARY:\n${existingSummary}` : ""}\n\nEXCERPT:\n${excerpt}`;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // AIP-03a: ONE usage row per compaction call, after the answer is in hand, fire-and-forget (never throws, never awaited here).
  const record = (facts: Parameters<typeof recordGatewayCall>[1]): void => {
    void recordGatewayCall(attribution, facts).then((r) => (r?.ok && attribution.threadId ? refreshThreadCost(attribution.tenantId, attribution.threadId) : undefined));
  };
  let res: Response;
  try {
    res = await fetchImpl(`${url}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts?.gatewayToken ?? config.services.gateway.token}`,
        ...(opts?.tenantId ? { "x-tenant-id": opts.tenantId } : {}),
      },
      body: JSON.stringify({ prompt }),
    });
  } catch (err) {
    record({ capability: "llm", outcome: "error" });
    throw err;
  }
  if (!res.ok) {
    record({ capability: "llm", outcome: outcomeForGatewayStatus(res.status) });
    throw new CompactionGatewayError(`ai-gateway /complete (compaction) returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { text?: string; provider?: string; model?: string; usage?: unknown };
  record({
    capability: "llm", outcome: "ok", provider: typeof body.provider === "string" ? body.provider : null,
    model: typeof body.model === "string" ? body.model : null, usage: readGatewayUsage(body.usage),
  });
  const summary = (body.text ?? "").trim();
  if (!summary) throw new CompactionGatewayError("ai-gateway /complete (compaction) returned an empty summary");
  return summary;
}

// ── ASST-18: RAG retrieval + citations, fail-soft ──────────────────────────────────────────────────
// One retrieval per generation, against the live pgvector tiers (WS8's knowledge service), as the
// thread OWNER (`searchKnowledgeStrict` self-links the owner's OBO envelope, so the store's tenant
// pre-filter is the owner's own authorized-tenant-set). `aclScope: ""` matches erp-source.ts's own
// convention — every internal-tier ERP document is ingested with an EMPTY acl (`acl = '{}'`), which
// the store reads as "every member of this tenant".
//
// ── DW-D26 (BFF §46.9): THE STORE'S RULE IS NOT THE ERP'S RULE ─────────────────────────────────────
// "Every member of this tenant" is wider than the ERP's own reads (a meeting transcript, a file under
// a contract, ...). So the store's candidates NEVER go to the prompt as they come: they are collapsed
// to one per record and run through DW-8i's `filterReadableHits` for the thread OWNER's principal and
// THIS thread's company, and only the internal-tier hits of that company that pass are cited (the public
// tier, the published website corpus, is kept as it was: it needs no record check). A hit
// the owner cannot open is dropped silently, before the prompt is built, so it can be neither quoted
// nor cited. Reports, people and org are withheld for everyone (§46.2). Any failure on this path (no
// tenant, owner unresolvable, knowledge service down, Cerbos down) leaves the turn with NO knowledge:
// grounding is additive, so it never fails the turn, and it NEVER falls back to the unfiltered chunks.
export type ContextCitation = KnowledgeHit;

/** The candidate source, injectable for tests (default: the live `searchKnowledgeStrict`). It returns the
 *  store's hits WHOLE (tenant and tier included, which the filter keys on) and throws when the service
 *  cannot answer. Its output is only ever a candidate list: see the DW-D26 note above. */
export type KnowledgeQueryFn = (userId: string, query: string, topK: number) => Promise<KnowledgeStoreHit[]>;

/** The per-record read filter, injectable for tests (default: DW-8i's `filterReadableHits`). */
export type KnowledgeFilterFn = typeof filterReadableHits;

export interface AssembledContext {
  /** The full prompt to send to `/complete(/stream)`. */
  prompt: string;
  /** Set ONLY when this call folded more of the prefix into the summary — the caller MUST persist
   *  this onto `assistant_threads` (compaction_summary / compaction_summary_upto_seq) or the same
   *  excerpt gets re-summarized (and re-billed) on the next send. */
  compactionUpdate?: { summary: string; uptoSeq: number };
  /** ASST-18 — whatever knowledge chunks grounded this turn, in ranked order. Always an array (never
   *  `undefined`) so callers can persist/emit it unconditionally; empty means either retrieval found
   *  nothing relevant OR the knowledge service degraded — both render identically to the user
   *  (no citation chips), which is correct: "we have nothing to cite" and "we couldn't check" are
   *  the same actionable fact from the reader's side. */
  citations: ContextCitation[];
}

/** DW-D26. Ask the store for more candidates than will be kept (`searchTopK`, the §46.1 arithmetic), keep the
 *  internal-tier hits of THIS company (one per record), pass them through the read filter as the thread OWNER, add the
 *  public-tier hits (no check: published), then cut to `topK` by score. THROWS on any failure; the caller turns a throw into
 *  "no knowledge". With no company in scope nothing can be checked, so nothing is returned. */
async function retrieveReadableKnowledge(
  ownerUserId: string,
  tenantId: string | undefined,
  query: string,
  topK: number,
  opts?: { queryKnowledge?: KnowledgeQueryFn; filterKnowledge?: KnowledgeFilterFn; principal?: Principal },
): Promise<ContextCitation[]> {
  if (!tenantId || !ownerUserId) return [];
  const queryFn = opts?.queryKnowledge ?? searchKnowledgeStrict;
  const filterFn = opts?.filterKnowledge ?? filterReadableHits;
  const hits = await queryFn(ownerUserId, query, searchTopK(topK));
  // The public tier is the published corpus (the website): anyone may read it, so it needs no record check and stays in
  // the grounding as before DW-D26 ("the public tier is unchanged"). Its refs resolve to no ERP page, so they render as
  // plain chips (citations.ts).
  const seen = new Set<string>();
  const publicHits = hits.filter((h) => h?.audience === "public" && !seen.has(h.sourceRef) && !!seen.add(h.sourceRef));
  const candidates = collapseHits(hits, tenantId);
  let internal: KnowledgeStoreHit[] = [];
  if (candidates.length > 0) {
    const principal =
      opts?.principal && opts.principal.userId === ownerUserId ? opts.principal : await assemblePrincipal(ownerUserId, "low");
    // an unresolvable owner can open nothing internal
    if (principal) internal = (await filterFn(principal, tenantId, candidates)).map((a) => a.candidate.hit);
  }
  return [...internal, ...publicHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((h) => ({ sourceRef: h.sourceRef, text: h.text, score: h.score }));
}

/** Assemble the prompt for a new generation in `threadId`, folding older messages into the
 *  thread's rolling summary if the recent-messages window (everything with `seq < excludeFromSeq`,
 *  i.e. everything up to and including the just-sent user message) overflows `charBudget`.
 *
 *  `excludeFromSeq` is the seq of the not-yet-generated assistant placeholder itself — callers
 *  pass the placeholder row's own `seq`, so "context" is exactly "everything before this reply". */
export async function assembleContext(
  c: PoolClient,
  threadId: string,
  thread: ThreadForContext,
  excludeFromSeq: number,
  opts?: SummarizeOptions & {
    charBudget?: number;
    memoryCharBudget?: number;
    /** ASST-18 test seam — default is the live `searchKnowledgeStrict`. */
    queryKnowledge?: KnowledgeQueryFn;
    /** DW-D26 test seam — default is DW-8i's `filterReadableHits`. */
    filterKnowledge?: KnowledgeFilterFn;
    /** DW-D26 — the requester's own principal (the session's real assurance). Used for the read filter only
     *  when it IS the thread owner; otherwise (or when absent) the owner's principal is assembled at `low`
     *  assurance, which can only narrow. */
    principal?: Principal;
    /** ASST-18 — how many chunks to ask for. Default `config.assistant.knowledgeTopK`; `0` (or a
     *  negative override) skips retrieval entirely rather than asking for none. */
    knowledgeTopK?: number;
  },
): Promise<AssembledContext> {
  const budget = opts?.charBudget ?? config.assistant.contextCharBudget;

  const { rows } = await c.query<MessageForContext>(
    `SELECT seq, role, content FROM assistant_messages
       WHERE thread_id = $1 AND seq < $2 AND ($3::int IS NULL OR seq > $3)
       ORDER BY seq ASC`,
    [threadId, excludeFromSeq, thread.compactionSummaryUptoSeq],
  );

  let summary = thread.compactionSummary;
  let compactionUpdate: AssembledContext["compactionUpdate"];
  let kept = rows;

  if (renderTranscript(rows).length > budget && rows.length > 1) {
    // Fold the oldest messages until the KEPT remainder fits the budget. Always keep at least the
    // single most recent message verbatim (never silently truncate the latest turn), even if it
    // alone exceeds the budget — that one case is accepted as-is, not folded.
    let cut = 0;
    while (cut < rows.length - 1 && renderTranscript(rows.slice(cut + 1)).length > budget) {
      cut++;
    }
    const toFold = rows.slice(0, cut + 1);
    kept = rows.slice(cut + 1);
    const excerpt = renderTranscript(toFold);
    // AIP-03a: the compaction call is the thread owner's, on this thread. With no company in scope there is nothing to attribute: no row.
    const newSummary = await summarizeExcerpt(
      excerpt, summary,
      { tenantId: opts?.tenantId ?? "", userId: thread.ownerUserId, surface: "compaction", threadId, task: "assistant.compaction" },
      opts,
    );
    summary = newSummary;
    const uptoSeq = toFold[toFold.length - 1].seq;
    compactionUpdate = { summary: newSummary, uptoSeq };
  }

  // ASST-19: the quarantine gate — `fetchConfirmedMemory` reads ONLY `confirmed_at IS NOT NULL`
  // rows for this thread's owner. A proposed-but-unconfirmed memory is invisible here by
  // construction, never reaching this prompt.
  const memoryRows = await fetchConfirmedMemory(c, thread.ownerUserId);
  const memoryBlock = renderMemory(memoryRows, opts?.memoryCharBudget ?? DEFAULT_MEMORY_CHAR_BUDGET);

  // ASST-18: retrieve against the LATEST user message in `kept` — the one this generation is
  // actually replying to. Never against `excerpt`/the folded prefix: what was just asked is the
  // right retrieval query, not the running summary of everything asked before it.
  const knowledgeTopK = opts?.knowledgeTopK ?? config.assistant.knowledgeTopK;
  let citations: ContextCitation[] = [];
  const lastUserMessage = [...kept].reverse().find((m) => m.role === "user" && m.content);
  if (lastUserMessage?.content && knowledgeTopK > 0) {
    try {
      citations = await retrieveReadableKnowledge(thread.ownerUserId, opts?.tenantId, lastUserMessage.content, knowledgeTopK, opts);
    } catch {
      citations = []; // grounding is additive — see this section's header; never fails the turn, never unfiltered.
    }
  }

  const sections = [SYSTEM_PREAMBLE];
  if (memoryBlock) sections.push(`Known facts and preferences about this user (confirmed):\n${memoryBlock}`);
  if (summary) sections.push(`Summary of the earlier conversation:\n${summary}`);
  const transcript = renderTranscript(kept);
  if (transcript) sections.push(transcript);
  if (citations.length > 0) {
    const block = citations.map((h, i) => `[${i + 1}] (${h.sourceRef}) ${h.text}`).join("\n\n");
    sections.push(`Relevant company knowledge — cite it as [1], [2], … where you use it:\n${block}`);
  }
  sections.push("Assistant:");
  return { prompt: sections.join("\n\n"), compactionUpdate, citations };
}

/** Persist a compaction update produced by `assembleContext` onto the thread row. Separate from
 *  `assembleContext` itself (which only reads) so the caller controls exactly when/whether the
 *  write happens — e.g. inside the same transaction as the rest of the send flow. */
export async function persistCompactionUpdate(
  c: PoolClient,
  threadId: string,
  update: { summary: string; uptoSeq: number },
): Promise<void> {
  await c.query(
    `UPDATE assistant_threads SET compaction_summary = $1, compaction_summary_upto_seq = $2, updated_at = now() WHERE id = $3`,
    [update.summary, update.uptoSeq, threadId],
  );
}
