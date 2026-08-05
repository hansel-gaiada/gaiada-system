import "server-only";
// TEMP DEMO MODE — stateful in-memory store for the `/assistant` workspace (ASST-07), mirroring
// demoMeetings.ts/demoPm.ts. Module-level state persists per dev-server process, resets on restart.
// Active only via DEMO_MODE=1; routed from demoFixtures.getDemoResponse. Owner-only scoping is
// mirrored here too (filtered by `ownerUserId === userId` on every read) so the demo behaves like
// the real Cerbos policy even with no backend running. Safe to delete once a live backend is used.
//
// The one thing this file does that no other demoX.ts needs to: it also answers the SSE STREAM
// itself (`demoAssistantStreamBody`), not just the JSON CRUD routes — `getDemoResponse` only ever
// returns `{status, json}`, which has no way to represent a stream, so the stream proxy route
// (`app/api/assistant/threads/[id]/stream/route.ts`) calls this file directly instead of going
// through `platformFetch`'s DEMO_MODE branch. See that route's header for the split.
import type { AssistantMessageRole, AssistantThreadStatus } from "./assistant";

interface DemoThread {
  id: string;
  tenantId: string;
  ownerUserId: string;
  title: string | null;
  brainProvider: string | null;
  brainModel: string | null;
  hermesSessionId: string | null;
  status: AssistantThreadStatus;
  pinned: boolean;
  lastMessageAt: string | null;
  totalTokens: number;
  totalCostUsd: string;
  compactionSummary: string | null;
  compactionSummaryUptoSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

interface DemoMessage {
  id: string;
  tenantId: string;
  threadId: string;
  seq: number;
  role: AssistantMessageRole;
  content: string | null;
  /** Text streamed so far for a still-pending assistant row — read by `stop` to finalize with
   *  whatever was actually shown to the client, mirroring the real backend's "partial reply is
   *  always visible, never silently discarded" rule (docs/FRONTEND-BFF-CONTRACT.md §18). */
  partial: string;
  parts: unknown;
  provider: string | null;
  model: string | null;
  tokens: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  createdAt: string;
}

const now = () => new Date().toISOString();
const DEMO_OWNER = "demo-hansel";

function seedThreads(): DemoThread[] {
  return [
    {
      id: "asst-thread-1", tenantId: "co-agency", ownerUserId: DEMO_OWNER,
      title: "Draft the Q3 client update", brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: true, lastMessageAt: "2026-08-04T09:10:00Z",
      totalTokens: 340, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: "2026-08-04T09:00:00Z", updatedAt: "2026-08-04T09:10:00Z",
    },
    {
      id: "asst-thread-2", tenantId: "co-agency", ownerUserId: DEMO_OWNER,
      title: "Explain the D14 execution gate", brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: false, lastMessageAt: "2026-08-03T14:22:00Z",
      totalTokens: 180, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: "2026-08-03T14:20:00Z", updatedAt: "2026-08-03T14:22:00Z",
    },
    {
      id: "asst-thread-3", tenantId: "co-agency", ownerUserId: DEMO_OWNER,
      title: "Older scratch thread", brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: false, lastMessageAt: "2026-07-10T08:00:00Z",
      totalTokens: 60, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: "2026-07-10T07:55:00Z", updatedAt: "2026-07-10T08:00:00Z",
    },
  ];
}

function seedMessages(): DemoMessage[] {
  return [
    {
      id: "asst-msg-1", tenantId: "co-agency", threadId: "asst-thread-1", seq: 1, role: "user",
      content: "Draft a short client update for Northwind on the site redesign.", partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null,
      createdAt: "2026-08-04T09:00:00Z",
    },
    {
      id: "asst-msg-2", tenantId: "co-agency", threadId: "asst-thread-1", seq: 2, role: "assistant",
      content: "Here's a draft:\n\n**Northwind — Site Redesign Update**\n\nWe're on track for the Q3 milestone. The homepage hero is wired and checkout QA is in progress. No blockers.",
      partial: "", parts: null, provider: null, model: null, tokens: 96, latencyMs: 1400, errorKind: null,
      createdAt: "2026-08-04T09:00:04Z",
    },
    {
      id: "asst-msg-3", tenantId: "co-agency", threadId: "asst-thread-2", seq: 1, role: "user",
      content: "What does the D14 execution gate actually do?", partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null,
      createdAt: "2026-08-03T14:20:00Z",
    },
    {
      id: "asst-msg-4", tenantId: "co-agency", threadId: "asst-thread-2", seq: 2, role: "assistant",
      content: "It separates DECIDING an automation write (approved/rejected) from EXECUTING it. Approving used to execute nothing — D14 adds a registry-scoped executor that re-drives the call as the original requester, with a single-use grant.",
      partial: "", parts: null, provider: null, model: null, tokens: 84, latencyMs: 1100, errorKind: null,
      createdAt: "2026-08-03T14:20:03Z",
    },
  ];
}

// ── WHY THIS SITS ON `globalThis` INSTEAD OF A PLAIN MODULE-LEVEL `const` (found empirically —
// this bit the very first live drive of ASST-07 under DEMO_MODE) ────────────────────────────────
// Next.js compiles Server Actions and Route Handlers as SEPARATE module graphs ("layers"), even
// when both run in the same Node.js process. A thread created via `createThreadAction` (the
// "action" layer, calling `assistantDemo` below) landed in one instance of this module's `THREADS`
// array; the SSE stream proxy route (`app/api/assistant/threads/[id]/stream/route.ts`, the "route"
// layer, calling `demoAssistantStreamBody`) read a SECOND, independently-initialized instance that
// never saw it — every send 404'd with "no pending generation for this messageId". Every OTHER
// `demoX.ts` store in this codebase is read only from Server Actions/Server Components (one layer),
// so this cross-layer sharing requirement is unique to this file (it is also why the portal's own
// SSE proxy, `lib/portal-stream-server.ts`, never attempted synthetic DEMO_MODE data — it sidesteps
// this exact problem by falling back to polling instead). `globalThis` is the one thing every layer
// in the same process actually shares — the identical pattern Next.js apps use to keep a Prisma
// client a true singleton across repeated module instantiation.
declare global {
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantThreads: DemoThread[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantMessages: DemoMessage[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantSeq: { n: number } | undefined;
}

const THREADS: DemoThread[] = globalThis.__gaiadaDemoAssistantThreads ?? (globalThis.__gaiadaDemoAssistantThreads = seedThreads());
const MESSAGES: DemoMessage[] = globalThis.__gaiadaDemoAssistantMessages ?? (globalThis.__gaiadaDemoAssistantMessages = seedMessages());
const seqBox = globalThis.__gaiadaDemoAssistantSeq ?? (globalThis.__gaiadaDemoAssistantSeq = { n: 1 });
const nid = (p: string) => `${p}-demo-${seqBox.n++}`;

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });

function pinnedThenRecent(a: DemoThread, b: DemoThread): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const av = a.lastMessageAt ? Date.parse(a.lastMessageAt) : -Infinity;
  const bv = b.lastMessageAt ? Date.parse(b.lastMessageAt) : -Infinity;
  if (av !== bv) return bv - av;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function pubThread(t: DemoThread) {
  const { tenantId, ...rest } = t;
  void tenantId;
  return rest;
}
function pubMessage(m: DemoMessage) {
  const { tenantId, threadId, partial, ...rest } = m;
  void tenantId; void threadId; void partial;
  return rest;
}

/** Returns a DemoResult for any `/api/:t/assistant/*` CRUD route, or null if it doesn't match. */
export function assistantDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();

  const messagesM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/messages$/);
  if (messagesM && m === "POST") {
    const [, tenantId, threadId] = messagesM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const pending = MESSAGES.some((msg) => msg.threadId === threadId && msg.role === "assistant" && msg.content === null && msg.errorKind === null);
    if (pending) return { status: 409, json: { error: "a response is already streaming for this thread — stop it or wait for it to finish" } };
    const b = JSON.parse(body || "{}") as { content?: string };
    const content = (b.content ?? "").trim();
    if (!content) return { status: 400, json: { error: "content is required" } };
    const threadMsgs = MESSAGES.filter((msg) => msg.threadId === threadId);
    const nextSeq = (threadMsgs.length ? Math.max(...threadMsgs.map((msg) => msg.seq)) : 0) + 1;
    MESSAGES.push({
      id: nid("asst-msg"), tenantId, threadId, seq: nextSeq, role: "user", content, partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: now(),
    });
    const assistantId = nid("asst-msg");
    MESSAGES.push({
      id: assistantId, tenantId, threadId, seq: nextSeq + 1, role: "assistant", content: null, partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: now(),
    });
    return { status: 201, json: { messageId: assistantId, streamUrl: `/api/${tenantId}/assistant/threads/${threadId}/stream?messageId=${assistantId}` } };
  }

  const stopM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/stop$/);
  if (stopM && m === "POST") {
    const [, tenantId, threadId] = stopM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const row = MESSAGES.find((msg) => msg.threadId === threadId && msg.role === "assistant" && msg.content === null && msg.errorKind === null);
    if (!row) return ok({ ok: true, stopped: false });
    row.content = row.partial;
    row.errorKind = "stopped";
    return ok({ ok: true, stopped: true });
  }

  const detailM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)$/);
  if (detailM) {
    const [, tenantId, threadId] = detailM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (m === "PATCH") {
      if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
      const b = JSON.parse(body || "{}") as { title?: string | null; pinned?: boolean; status?: string; brainProvider?: string | null; brainModel?: string | null };
      if (Object.prototype.hasOwnProperty.call(b, "title")) thread.title = typeof b.title === "string" ? b.title.trim().slice(0, 500) || null : null;
      if (typeof b.pinned === "boolean") thread.pinned = b.pinned;
      if (b.status === "active" || b.status === "archived") thread.status = b.status;
      if (Object.prototype.hasOwnProperty.call(b, "brainProvider")) thread.brainProvider = b.brainProvider ?? null;
      if (Object.prototype.hasOwnProperty.call(b, "brainModel")) thread.brainModel = b.brainModel ?? null;
      thread.updatedAt = now();
      return ok({ id: thread.id });
    }
    if (m === "DELETE") {
      if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
      const idx = THREADS.indexOf(thread);
      THREADS.splice(idx, 1);
      for (let i = MESSAGES.length - 1; i >= 0; i--) if (MESSAGES[i].threadId === threadId) MESSAGES.splice(i, 1);
      return ok({ ok: true });
    }
    // GET
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const messageLimit = Math.max(1, Math.min(500, Number(params.get("messageLimit")) || 200));
    const beforeSeqRaw = params.get("beforeSeq");
    const beforeSeq = beforeSeqRaw ? Number(beforeSeqRaw) : null;
    let msgs = MESSAGES.filter((msg) => msg.threadId === threadId).sort((a, b) => a.seq - b.seq);
    if (beforeSeq != null) msgs = msgs.filter((msg) => msg.seq < beforeSeq);
    const page = msgs.slice(-messageLimit);
    return ok({ thread: pubThread(thread), messages: page.map(pubMessage), hasMoreMessages: page.length === messageLimit });
  }

  const listCreateM = p.match(/^\/api\/([^/]+)\/assistant\/threads$/);
  if (listCreateM) {
    const [, tenantId] = listCreateM;
    if (m === "POST") {
      const b = JSON.parse(body || "{}") as { title?: string; brainProvider?: string; brainModel?: string };
      const t: DemoThread = {
        id: nid("asst-thread"), tenantId, ownerUserId: userId,
        title: (b.title ?? "").trim().slice(0, 500) || null,
        brainProvider: b.brainProvider ?? null, brainModel: b.brainModel ?? null, hermesSessionId: null,
        status: "active", pinned: false, lastMessageAt: null, totalTokens: 0, totalCostUsd: "0.00",
        compactionSummary: null, compactionSummaryUptoSeq: null, createdAt: now(), updatedAt: now(),
      };
      THREADS.push(t);
      return { status: 201, json: { id: t.id } };
    }
    // GET — owner-only list, mirrors the real `WHERE owner_user_id = $1`.
    const q = (params.get("q") ?? "").trim().toLowerCase();
    const status = params.get("status");
    const limit = Math.max(1, Math.min(200, Number(params.get("limit")) || 50));
    const offset = Math.max(0, Number(params.get("offset")) || 0);
    let rows = THREADS.filter((t) => t.tenantId === tenantId && t.ownerUserId === userId);
    if (status) rows = rows.filter((t) => t.status === status);
    if (q) rows = rows.filter((t) => (t.title ?? "").toLowerCase().includes(q));
    rows = [...rows].sort(pinnedThenRecent);
    const total = rows.length;
    return ok({ items: rows.slice(offset, offset + limit).map(pubThread), total });
  }

  return null;
}

// ============================================================== The SSE stream (demo mode only) ====
// `demoAssistantStreamBody` is called directly by the Next.js proxy route
// (`app/api/assistant/threads/[id]/stream/route.ts`) when DEMO_MODE=1 — NOT through
// `getDemoResponse`, which only knows how to answer JSON. It echoes the preceding user message back
// word-by-word as `token` events, in the exact wire format `sseLine()` produces on the real backend
// (`event: <name>\ndata: <json>\n\n`), so the client-side parser in `lib/assistant.ts` exercises the
// real framing even with no backend running.
//
// TWO DELIBERATE TEST HOOKS, both triggered by literal text in the SENT message (so they're drivable
// from the Composer with no dev-tools):
//   - a message containing "STALL_TEST" never emits `done`/`error` and never closes the stream on its
//     own — this is what proves the client's 120s idle-timeout+AbortController path (ASST-07's own
//     acceptance criterion: "a stalled stream shows a visible error after the idle timeout, not a
//     forever-spinner") without needing a real hung upstream to reproduce it.
//   - a message containing "ERROR_TEST" ends the stream with `event: error` immediately, to prove the
//     UI renders a stream failure as an error bubble rather than a silently-completed one.
//
// STOP support: rather than a separate cancellation registry, each loop iteration re-reads the
// message row from the store. `assistantDemo`'s `stop` handler finalizes that row (content set,
// errorKind='stopped') — the generator notices on its NEXT tick and closes without emitting `done`,
// which is exactly the real backend's behavior (a stop mid-generation never reaches the `done` path).
function findPendingRow(threadId: string, messageId: string): DemoMessage | undefined {
  return MESSAGES.find((m) => m.id === messageId && m.threadId === threadId && m.role === "assistant" && m.content === null && m.errorKind === null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function demoAssistantStreamBody(tenantId: string, threadId: string, messageId: string): ReadableStream<Uint8Array> | null {
  const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
  if (!thread) return null;
  const placeholder = findPendingRow(threadId, messageId);
  if (!placeholder) return null;
  const userMsg = MESSAGES.find((msg) => msg.threadId === threadId && msg.seq === placeholder.seq - 1 && msg.role === "user");
  const sourceText = (userMsg?.content ?? "").trim();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (line: string) => {
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // controller already closed (client aborted) — nothing left to do.
        }
      };
      if (/ERROR_TEST/i.test(sourceText)) {
        await sleep(250);
        enqueue(`event: error\ndata: ${JSON.stringify({ error: "Demo-forced failure (message contained ERROR_TEST).", errorKind: "upstream_error" })}\n\n`);
        placeholder.content = "";
        placeholder.errorKind = "upstream_error";
        controller.close();
        return;
      }
      if (/STALL_TEST/i.test(sourceText)) {
        // Deliberately never emits done/error and never closes — see header. The client's own
        // 120s idle timer (or the user hitting Stop) is what ends this, exercised by ASST-07's
        // idle-timeout acceptance test.
        return;
      }

      const reply =
        `You said: "${sourceText || "(nothing)"}"\n\n` +
        "This is a demo-mode reply, streamed word by word so the composer, stop button, and " +
        "incremental rendering are all exercisable with no backend running. It includes a fenced " +
        "code block to prove multi-paragraph + code-fence markdown renders correctly:\n\n" +
        "```ts\nfunction hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n```\n\n" +
        "Refreshing the page replays this exact transcript from the demo store.";
      const parts = reply.split(/(\s+)/).filter((s) => s.length > 0);

      for (const part of parts) {
        const row = findPendingRow(threadId, messageId);
        if (!row) {
          // Stopped externally (POST .../stop already finalized the row: content=partial,
          // errorKind='stopped') — emit the SAME terminal `error` event the real backend's
          // `relayGeneration` sends on an explicit stop (docs/FRONTEND-BFF-CONTRACT.md §18), rather
          // than just closing the socket. Closing with no event at all is indistinguishable, on the
          // wire, from `abnormal_drop` — a bug this fix caught: the FIRST live drive of the Stop
          // button showed "connection ended before the reply finished" instead of "Stopped."
          enqueue(`event: error\ndata: ${JSON.stringify({ error: "Stopped.", errorKind: "stopped" })}\n\n`);
          controller.close();
          return;
        }
        row.partial += part;
        enqueue(`event: token\ndata: ${JSON.stringify({ text: part })}\n\n`);
        await sleep(30);
      }

      const row = findPendingRow(threadId, messageId);
      if (!row) {
        enqueue(`event: error\ndata: ${JSON.stringify({ error: "Stopped.", errorKind: "stopped" })}\n\n`);
        controller.close();
        return;
      }
      const finalText = row.partial;
      const tokensEstimate = Math.max(1, Math.ceil(finalText.length / 4));
      const latencyMs = parts.length * 30;
      row.content = finalText;
      row.tokens = tokensEstimate;
      row.latencyMs = latencyMs;
      thread.totalTokens += tokensEstimate;
      thread.lastMessageAt = now();
      thread.updatedAt = now();
      enqueue(`event: usage\ndata: ${JSON.stringify({ tokens: tokensEstimate, latencyMs })}\n\n`);
      enqueue(`event: done\ndata: {}\n\n`);
      controller.close();
    },
  });
}
