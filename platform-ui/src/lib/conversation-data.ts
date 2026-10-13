import "server-only";
// PV4-09 — readers behind the staff conversation screens (BFF §29b). Every reader THROWS on a refusal and the
// caller wraps it in `readResult()`, so a denied or failed read becomes a <ReadRefusal>, never an empty list
// that reads as "no conversations" (readiness-bar criterion 5).
import { platformFetch } from "./platform";
import type { StaffDraft, StaffMessage, StaffThread, ThreadSnapshot } from "./conversation";

export async function listThreads(
  userId: string,
  tenant: string,
  opts: { clientId?: string; projectId?: string; status?: "open" | "closed"; awaitingReply?: boolean; mine?: boolean } = {},
): Promise<StaffThread[]> {
  const q = new URLSearchParams();
  if (opts.clientId) q.set("clientId", opts.clientId);
  if (opts.projectId) q.set("projectId", opts.projectId);
  if (opts.status) q.set("status", opts.status);
  if (opts.awaitingReply !== undefined) q.set("awaitingReply", String(opts.awaitingReply));
  // DW-5g: only threads where the caller is a staff recipient (BFF §29b `mine`).
  if (opts.mine !== undefined) q.set("mine", String(opts.mine));
  const qs = q.toString();
  const r = await platformFetch<{ threads: StaffThread[] }>(`/api/${tenant}/conversation${qs ? `?${qs}` : ""}`, userId);
  return r.threads ?? [];
}

/** The thread, its messages (oldest first) and ALL its drafts. Opening a thread marks it read (§29), so the
 *  poll that calls this keeps the unread badge honest while the page is open. */
export async function getThreadSnapshot(userId: string, tenant: string, threadId: string): Promise<ThreadSnapshot> {
  const id = encodeURIComponent(threadId);
  const [detail, drafts] = await Promise.all([
    platformFetch<{ thread: StaffThread; messages: StaffMessage[] }>(`/api/${tenant}/conversation/${id}`, userId),
    platformFetch<{ drafts: StaffDraft[] }>(`/api/${tenant}/conversation/${id}/drafts?status=all`, userId),
  ]);
  return { thread: detail.thread, messages: detail.messages ?? [], drafts: drafts.drafts ?? [] };
}
