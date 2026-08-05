import "server-only";
// ASST-07 — server-only reads for the `/assistant` workspace, following the module-trio convention
// (`X.ts` pure / `X-data.ts` server-only reads / `XActions.ts` writes) documented in
// platform-ui/CLAUDE.md. Consumed by `app/(app)/assistant/page.tsx` for the initial server-rendered
// load; everything after that (thread switch, rail refresh, mutations) goes through
// `lib/assistantActions.ts` because it is triggered by client interaction, not a navigation.
import { platformFetch } from "./platform";
import type { ThreadDetailResult, ThreadListResult, MemoryListResult } from "./assistant";

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
