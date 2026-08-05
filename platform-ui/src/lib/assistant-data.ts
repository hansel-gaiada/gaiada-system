import "server-only";
// ASST-07 — server-only reads for the `/assistant` workspace, following the module-trio convention
// (`X.ts` pure / `X-data.ts` server-only reads / `XActions.ts` writes) documented in
// platform-ui/CLAUDE.md. Consumed by `app/(app)/assistant/page.tsx` for the initial server-rendered
// load; everything after that (thread switch, rail refresh, mutations) goes through
// `lib/assistantActions.ts` because it is triggered by client interaction, not a navigation.
import { platformFetch, PlatformError } from "./platform";
import type {
  ThreadDetailResult, ThreadListResult, MemoryListResult, CapabilitiesResult, ResolvedCitation, PinnedPageContext,
  RosterResult, AssistantHandoff,
} from "./assistant";

export interface ListThreadsParams {
  q?: string;
  status?: "active" | "archived";
  limit?: number;
  offset?: number;
}

// The rail loads the owner's full thread set in one page (see ThreadRail's header for why search
// is client-side, not per-keystroke) — 200 is the backend's own MAX_LIST_LIMIT, so this is "give me
// everything you'll give me," not an arbitrary UI choice.
export const THREAD_LIST_LIMIT = 200;

export function listThreads(userId: string, tenantId: string, params: ListThreadsParams = {}): Promise<ThreadListResult> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.status) qs.set("status", params.status);
  qs.set("limit", String(params.limit ?? THREAD_LIST_LIMIT));
  if (params.offset) qs.set("offset", String(params.offset));
  return platformFetch<ThreadListResult>(`/api/${tenantId}/assistant/threads?${qs.toString()}`, userId);
}

export interface GetThreadParams {
  messageLimit?: number;
  beforeSeq?: number;
}

export function getThread(userId: string, tenantId: string, threadId: string, params: GetThreadParams = {}): Promise<ThreadDetailResult> {
  const qs = new URLSearchParams();
  if (params.messageLimit) qs.set("messageLimit", String(params.messageLimit));
  if (params.beforeSeq) qs.set("beforeSeq", String(params.beforeSeq));
  const suffix = qs.toString();
  return platformFetch<ThreadDetailResult>(`/api/${tenantId}/assistant/threads/${threadId}${suffix ? `?${suffix}` : ""}`, userId);
}

// ASST-19 — the memory panel's own read. Owner-only (resource_assistant_memory.yaml); no pagination
// params exercised here — the panel loads the owner's whole memory set in one page (the same
// "give me everything you'll give me" call listThreads makes above), matching a durable-facts list
// that is expected to stay small (unlike the message transcript, which genuinely needs paging).
export const MEMORY_LIST_LIMIT = 500; // the backend's own MAX_MEMORY_LIST_LIMIT

export function listMemory(userId: string, tenantId: string): Promise<MemoryListResult> {
  const qs = new URLSearchParams({ limit: String(MEMORY_LIST_LIMIT) });
  return platformFetch<MemoryListResult>(`/api/${tenantId}/assistant/memory?${qs.toString()}`, userId);
}

// ASST-18 — the capabilities panel's AND the empty-state cards' ONE read. Both call THIS same
// function (via `refreshCapabilitiesAction` -> here), so they can never drift about what this user
// can actually do — see `CapabilityCards`'s own header for why that matters.
export function getCapabilities(userId: string, tenantId: string): Promise<CapabilitiesResult> {
  return platformFetch<CapabilitiesResult>(`/api/${tenantId}/assistant/capabilities`, userId);
}

// ASST-18 — resolves ONE citation chip. Returns `null` on a 404 (an unresolvable ref — see
// citations.ts's header: "a chip that 404s is worse than no chip") rather than throwing, so the
// caller can render "unavailable" instead of surfacing a raw platform error for what is an
// expected, honest outcome for several real ingested knowledge kinds.
export async function resolveCitation(userId: string, tenantId: string, sourceRef: string): Promise<ResolvedCitation | null> {
  try {
    return await platformFetch<ResolvedCitation>(`/api/${tenantId}/assistant/citations/${encodeURIComponent(sourceRef)}`, userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}

// ASST-22 — resolves a `@drawer` page-context ref (`lib/assistantContext.ts`'s `derivePageContextRef`)
// through the EXACT SAME endpoint `resolveCitation` above already calls. Deliberately no second
// implementation: a page-context ref and a knowledge-citation ref are the same wire shape
// (`erp:<kind>:<id>`, erp-source.ts's convention), and citations.ts's "never resolve a ref that
// would 404" bar applies just as much to a drawer pin as to a chip under a reply — an unresolvable
// ref (a deleted/renamed row since the page loaded) means the drawer opens with NO pin, not a fake
// one. `null` is passed straight through by both call sites (the intercepted drawer route treats it
// exactly like "no `ctx` param at all").
export async function resolvePageContextRef(userId: string, tenantId: string, ref: string): Promise<PinnedPageContext | null> {
  const resolved = await resolveCitation(userId, tenantId, ref);
  return resolved ? { ref, ...resolved } : null;
}

// ASST-21 — the roster panel's ONE read: the REAL specialist registry plus THIS caller's own
// episodic run history (`modules/assistant/assistant.controller.ts`'s `roster()` — self-scoped by
// construction, no thread/owner param to pass).
export function getRoster(userId: string, tenantId: string): Promise<RosterResult> {
  return platformFetch<RosterResult>(`/api/${tenantId}/assistant/agents`, userId);
}

// The run-watch view's ONE read: a thread's handoffs, lazily refreshed server-side from the runner
// (see handoffs.ts's `refreshHandoff`) — owner-only, same Cerbos gate as every other thread action.
export function listThreadHandoffs(userId: string, tenantId: string, threadId: string): Promise<AssistantHandoff[]> {
  return platformFetch<AssistantHandoff[]>(`/api/${tenantId}/assistant/threads/${threadId}/handoffs`, userId);
}
