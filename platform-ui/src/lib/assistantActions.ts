"use server";
// ASST-07 — server actions for the `/assistant` workspace. `AssistantWorkspace` (a client
// component — the whole workspace is one JS-driven tree, not a series of page navigations, because
// switching threads/streaming a reply cannot be a full-page reload) calls these directly from
// event handlers, not via `useActionState`/`<form>` — plain typed args, called like any async
// function, which is the idiomatic Next 15 shape for a fully-client-driven surface. `ctx()` mirrors
// `meetingsActions.ts`: it re-derives the active tenant from the session/cookie SERVER-SIDE on every
// call rather than trusting a client-supplied tenant id — the same reason `assistant-stream-server.ts`
// does the same thing for the stream proxy.
//
// `assistant_thread` is owner-only with no admin bypass (ASST-02) — every one of these already gets
// that enforced by the backend's `authorize()` call; nothing here needs its own capability gate.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  listThreads, getThread, listMemory, getCapabilities, resolveCitation, getRoster, listThreadHandoffs,
  THREAD_LIST_LIMIT, type ListThreadsParams, type GetThreadParams,
} from "./assistant-data";
import type {
  AssistantMemoryScope, AssistantThreadStatus, CapabilitiesResult, MemoryListResult, ResolvedCitation, SendMessageResult, StopResult,
  ThreadDetailResult, ThreadListResult, RosterResult, AssistantHandoff,
} from "./assistant";
// ASST-21 — the run-watch view's transcript read reuses the EXISTING Intelligence-console reader
// verbatim (no second implementation of `GET :t/agents/runs/:runId`). It already degrades a 403 to
// `null` (`skipUnavailable`), which is exactly right here too: a run that ISN'T this caller's own
// handoff (or isn't yet linked with a runId) still degrades to "not available" rather than throwing.
import { getAgentRun, type AgentRun } from "./admin";

// The default payload must add NO properties. `Record<string, never>` looks right but isn't: its index
// signature requires EVERY property to be `never`, so `{ ok: true } & Record<string, never>` makes
// `ok: true` unassignable and every bare `return { ok: true }` fails to typecheck.
// `Record<never, never>` has no keys and no index signature, so the intersection is just `{ ok: true }`.
export type ActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string; status?: number };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me: Me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

function fail<T extends object>(e: unknown): ActionResult<T> {
  if (e instanceof PlatformError) return { ok: false, error: e.message, status: e.status };
  throw e;
}

// ---- Rail: list / refresh --------------------------------------------------------------------

export async function refreshThreadsAction(params: ListThreadsParams = {}): Promise<ActionResult<ThreadListResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await listThreads(c.userId, c.tenant, { limit: THREAD_LIST_LIMIT, ...params });
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function refreshThreadAction(threadId: string, params: GetThreadParams = {}): Promise<ActionResult<ThreadDetailResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await getThread(c.userId, c.tenant, threadId, params);
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- Thread CRUD ------------------------------------------------------------------------------

export async function createThreadAction(title?: string): Promise<ActionResult<{ id: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/assistant/threads`, c.userId, {
      method: "POST",
      body: JSON.stringify({ title: title || undefined }),
    });
    revalidatePath("/assistant");
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}

export async function renameThreadAction(threadId: string, title: string): Promise<ActionResult> {
  return patchThread(threadId, { title });
}

export async function setThreadPinnedAction(threadId: string, pinned: boolean): Promise<ActionResult> {
  return patchThread(threadId, { pinned });
}

export async function setThreadStatusAction(threadId: string, status: AssistantThreadStatus): Promise<ActionResult> {
  return patchThread(threadId, { status });
}

// ASST-16 — the right-rail brain picker. Reuses the SAME PATCH endpoint ASST-05 already shipped
// (this ticket adds no new route) — `brainProvider: null` picks "Auto" (no hint; the gateway's
// normal failover chain decides). The backend clears `hermes_session_id` server-side whenever this
// PATCH actually changes the stored value (assistant.controller.ts's patchThread) — switching
// brains mid-thread always starts a fresh provider session, without touching the ERP transcript.
export async function setThreadBrainAction(threadId: string, brainProvider: string | null): Promise<ActionResult> {
  return patchThread(threadId, { brainProvider });
}

async function patchThread(threadId: string, body: Record<string, unknown>): Promise<ActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/assistant/threads/${threadId}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    revalidatePath("/assistant");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteThreadAction(threadId: string): Promise<ActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/assistant/threads/${threadId}`, c.userId, { method: "DELETE" });
    revalidatePath("/assistant");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- Send / stop --------------------------------------------------------------------------------
// `sendMessageAction` deliberately does NOT open the stream itself — it only returns
// `{messageId, streamUrl}` (the POST half of the POST-then-GET pair). The client opens the actual
// stream via `fetch` against `/api/assistant/threads/:id/stream` (this app's own proxy, not the
// backend path literally returned in `streamUrl` — see `assistant-stream-server.ts`'s header for why
// the browser never talks to platform-nest directly).

export async function sendMessageAction(threadId: string, content: string): Promise<ActionResult<SendMessageResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<SendMessageResult>(`/api/${c.tenant}/assistant/threads/${threadId}/messages`, c.userId, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function stopStreamAction(threadId: string): Promise<ActionResult<StopResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<StopResult>(`/api/${c.tenant}/assistant/threads/${threadId}/stop`, c.userId, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- Memory panel (ASST-19) --------------------------------------------------------------------
// `assistant_memory` is owner-only (ASST-02) — same "the backend's own authorize() already
// enforces this, nothing here needs its own capability gate" note as the thread actions above.
// No `revalidatePath` on any of these: the panel is a fully client-driven tree (like send/stop
// above), never fed through page.tsx's SSR props, so there is no Next.js page cache to invalidate.

export async function refreshMemoryAction(): Promise<ActionResult<MemoryListResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await listMemory(c.userId, c.tenant);
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function proposeMemoryAction(
  content: string,
  scope: AssistantMemoryScope = "user",
  sourceThreadId?: string,
): Promise<ActionResult<{ id: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/assistant/memory`, c.userId, {
      method: "POST",
      body: JSON.stringify({ content, scope, sourceThreadId }),
    });
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Confirms a proposal, and doubles as the pin/edit affordance for an already-confirmed row — the
 *  backend has no separate `update` action (see assistant.controller.ts's memory-section header),
 *  so editing `content`/`pinned` on an existing memory reuses this SAME endpoint with just those
 *  fields set; it is idempotent on the original confirmation timestamp. */
export async function confirmMemoryAction(
  memoryId: string,
  edits: { content?: string; pinned?: boolean } = {},
): Promise<ActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/assistant/memory/${memoryId}/confirm`, c.userId, {
      method: "POST",
      body: JSON.stringify(edits),
    });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteMemoryAction(memoryId: string): Promise<ActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/assistant/memory/${memoryId}`, c.userId, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- Capabilities panel + empty-state cards (ASST-18) --------------------------------------------
// `CapabilityCards` (the component BOTH the panel and the empty state render) calls this SAME
// action either way — see that component's own header for why that is the thing that makes "the
// empty state can never drift from what this user can actually do" true, not just asserted.

export async function refreshCapabilitiesAction(): Promise<ActionResult<CapabilitiesResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await getCapabilities(c.userId, c.tenant);
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- Citation resolution (ASST-18) ----------------------------------------------------------------
// `resolved: null` is a NORMAL, expected outcome (an honest "no destination for this chip" — see
// citations.ts's header), not an error — the caller renders the chip as plain text rather than a
// link in that case, never a broken/soon-to-404 `<a>`.

export async function resolveCitationAction(sourceRef: string): Promise<ActionResult<{ resolved: ResolvedCitation | null }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const resolved = await resolveCitation(c.userId, c.tenant, sourceRef);
    return { ok: true, resolved };
  } catch (e) {
    return fail(e);
  }
}

// ---- Agent roster + handoff (ASST-21) --------------------------------------------------------------
// blueprint §8's "agent roster" / D-B ("one Hermes front door + a visible agent roster — hand a
// longer task to a specialist"). `createHandoff` runs under the CHATTING USER's own OBO envelope on
// the backend (broker.ts's `oboEnvelopeFor`, reused verbatim by `modules/assistant/handoffs.ts`) —
// nothing here needs its own capability gate for the SAME reason the thread actions above don't:
// the backend's `authorize()` (owner-only, resource_assistant_thread.yaml's additive `handoff`
// action) already enforces it.

export async function refreshRosterAction(): Promise<ActionResult<RosterResult>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await getRoster(c.userId, c.tenant);
    return { ...r, ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function createHandoffAction(
  threadId: string,
  agent: string,
  goal: string,
): Promise<ActionResult<{ id: string; goalId: string; status: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string; goalId: string; status: string }>(
      `/api/${c.tenant}/assistant/threads/${threadId}/handoff`,
      c.userId,
      { method: "POST", body: JSON.stringify({ agent, goal }) },
    );
    return { ok: true, ...r };
  } catch (e) {
    return fail(e);
  }
}

/** The run-watch view's one poll — the thread's handoffs, each already lazily refreshed from the
 *  runner server-side (`handoffs.ts`'s `refreshHandoff`), so a caller here never has to separately
 *  poll a goal id itself. */
export async function refreshHandoffsAction(threadId: string): Promise<ActionResult<{ items: AssistantHandoff[] }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const items = await listThreadHandoffs(c.userId, c.tenant, threadId);
    return { ok: true, items };
  } catch (e) {
    return fail(e);
  }
}

/** Lazily fetches ONE handoff run's full transcript — never auto-loaded for every handoff in the
 *  list (a transcript can be long; the run-watch view fetches this only when the user opens one). */
export async function getHandoffTranscriptAction(runId: string): Promise<ActionResult<{ run: AgentRun | null }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const run = await getAgentRun(c.userId, c.tenant, runId);
    return { ok: true, run };
  } catch (e) {
    return fail(e);
  }
}
