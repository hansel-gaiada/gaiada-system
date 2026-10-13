"use server";
// PV4-09 — server actions behind the staff conversation screens (BFF §29b) and the meeting minutes (§29c).
//
// The platform is the authority on every one of these: Cerbos `conversation` read/post/draft/manage and
// `meeting_recording` update/share_minutes, then the controllers' own rules (closed
// threads, frozen minutes). Nothing here widens or pre-empts that. The only checks on this side are shape
// checks that save a round trip (empty body, too many files), and the platform repeats them.
//
// Every action returns a value (`{ok:false, error}`), never throws a refusal, so the UI can say what happened in
// words. The tenant is the caller's ACTIVE company, never a value from the browser.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  attachmentsError, bodyError, conversationErrorText,
  type AttachmentInput, type ConvResult, type ThreadSnapshot,
} from "./conversation";
import { getThreadSnapshot } from "./conversation-data";
import { minutesErrorText, type MinutesView, type MinutesResult } from "./meetingMinutes";
import { getMeetingMinutes } from "./meetingMinutes-data";

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown, text: (status: number | null, message: string) => string = conversationErrorText): { ok: false; error: string } {
  if (e instanceof PlatformError) return { ok: false, error: text(e.status, e.message) };
  throw e;
}

const hubPath = (clientId: string) => `/clients/${clientId}/work`;

// ── reads for the poll ───────────────────────────────────────────────────────────────────────────

/** The poll and the after-write reload: the thread, its messages and every draft. Marks the thread read. */
export async function loadThreadAction(threadId: string): Promise<ConvResult<{ snapshot: ThreadSnapshot }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    return { ok: true, snapshot: await getThreadSnapshot(c.userId, c.tenant, threadId) };
  } catch (e) {
    return fail(e);
  }
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────────

function checkMessage(body: string, attachments?: AttachmentInput[]): string | null {
  const b = bodyError(body);
  if (b) return b;
  // Size of the decoded bytes: base64 carries 3 bytes in 4 characters.
  const files = (attachments ?? []).map((a) => ({ name: a.filename, size: Math.floor((a.content.length * 3) / 4) }));
  return attachmentsError(files);
}

/** Reply in an open thread, as the signed-in staff member. */
export async function postMessageAction(
  threadId: string,
  clientId: string,
  input: { body: string; attachments?: AttachmentInput[] },
): Promise<ConvResult<{ messageId: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const bad = checkMessage(input.body, input.attachments);
  if (bad) return { ok: false, error: bad };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/conversation/${encodeURIComponent(threadId)}/messages`, c.userId, {
      method: "POST",
      body: JSON.stringify({ body: input.body, ...(input.attachments?.length ? { attachments: input.attachments } : {}) }),
    });
    revalidatePath(hubPath(clientId));
    return { ok: true, messageId: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Open a thread: on a project, or the client's general thread when `projectId` is absent. */
export async function startConversationAction(input: {
  clientId: string; projectId?: string | null; subject?: string; body: string; attachments?: AttachmentInput[];
}): Promise<ConvResult<{ threadId: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const bad = checkMessage(input.body, input.attachments);
  if (bad) return { ok: false, error: bad };
  try {
    const r = await platformFetch<{ threadId: string }>(`/api/${c.tenant}/conversation`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        clientId: input.clientId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
        body: input.body,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      }),
    });
    revalidatePath(hubPath(input.clientId));
    return { ok: true, threadId: r.threadId };
  } catch (e) {
    return fail(e);
  }
}

/** Close or reopen a thread (`manage`). */
export async function setThreadStatusAction(threadId: string, clientId: string, status: "open" | "closed"): Promise<ConvResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/conversation/${encodeURIComponent(threadId)}`, c.userId, { method: "PATCH", body: JSON.stringify({ status }) });
    revalidatePath(hubPath(clientId));
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────

/** Send a pending draft to the client. The message is authored by the signed-in staff member, not by the agent. */
export async function sendDraftAction(clientId: string, draftId: string): Promise<ConvResult<{ messageId: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/conversation/drafts/${encodeURIComponent(draftId)}/send`, c.userId, { method: "POST" });
    revalidatePath(hubPath(clientId));
    return { ok: true, messageId: r.id };
  } catch (e) {
    return fail(e);
  }
}

export async function editDraftAction(draftId: string, body: string): Promise<ConvResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const bad = bodyError(body);
  if (bad) return { ok: false, error: bad };
  try {
    await platformFetch(`/api/${c.tenant}/conversation/drafts/${encodeURIComponent(draftId)}`, c.userId, { method: "PATCH", body: JSON.stringify({ body }) });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function discardDraftAction(clientId: string, draftId: string): Promise<ConvResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/conversation/drafts/${encodeURIComponent(draftId)}/discard`, c.userId, { method: "POST" });
    revalidatePath(hubPath(clientId));
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── turn a client message into a change request ──────────────────────────────────────────────────

const CR_KINDS = ["content", "design", "feature", "bug"] as const;

/** `POST /webdev/change-requests` with `sourceMessageId` (BFF §16f-ii). The server accepts the message only when it
 *  is in the same tenant and in a thread of the request's own client (400 `source_message_invalid` otherwise). */
export async function createChangeRequestFromMessageAction(input: {
  kind: string; title: string; body: string; clientId: string; projectId: string | null; sourceMessageId: string;
}): Promise<ConvResult<{ requestId: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!(CR_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "Choose what kind of request this is." };
  if (!input.title.trim()) return { ok: false, error: "Give the request a title." };
  try {
    const r = await platformFetch<{ id: string }>(`/api/${c.tenant}/webdev/change-requests`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        kind: input.kind, title: input.title.trim(), body: input.body.slice(0, 5000), clientId: input.clientId,
        ...(input.projectId ? { projectId: input.projectId } : {}), sourceMessageId: input.sourceMessageId,
      }),
    });
    revalidatePath(hubPath(input.clientId));
    return { ok: true, requestId: r.id };
  } catch (e) {
    if (e instanceof PlatformError && e.message === "source_message_invalid") {
      return { ok: false, error: "That message can't be attached to a request for this client." };
    }
    return fail(e);
  }
}

// ── meeting minutes ──────────────────────────────────────────────────────────────────────────────

export async function saveMinutesAction(meetingId: string, bodyMd: string): Promise<MinutesResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const view = await platformFetch<MinutesView>(`/api/${c.tenant}/meetings/${encodeURIComponent(meetingId)}/minutes`, c.userId, {
      method: "PUT", body: JSON.stringify({ bodyMd }),
    });
    revalidatePath(`/meetings/${meetingId}`);
    return { ok: true, view };
  } catch (e) {
    return fail(e, minutesErrorText);
  }
}

/** Share the saved minutes with the meeting's client. One way: there is no unshare. Re-reads the view after. */
export async function shareMinutesAction(meetingId: string): Promise<MinutesResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`/api/${c.tenant}/meetings/${encodeURIComponent(meetingId)}/minutes/share`, c.userId, { method: "POST" });
    const view = await getMeetingMinutes(c.userId, c.tenant, meetingId);
    revalidatePath(`/meetings/${meetingId}`);
    return { ok: true, view };
  } catch (e) {
    return fail(e, minutesErrorText);
  }
}

// ── the Amends picker's read (triage leftovers) ──────────────────────────────────────────────────

/** The client's SIGNED contracts, for the triage panel's "Amends" picker (`GET /contracts?clientId=`). */
export async function listSignedContractsAction(
  clientId: string,
): Promise<ConvResult<{ contracts: { id: string; title: string; reference: string | null }[] }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const rows = await platformFetch<{ id: string; title: string; reference?: string | null; status: string }[]>(
      `/api/${c.tenant}/contracts?clientId=${encodeURIComponent(clientId)}`, c.userId,
    );
    return { ok: true, contracts: rows.filter((r) => r.status === "signed").map((r) => ({ id: r.id, title: r.title, reference: r.reference ?? null })) };
  } catch (e) {
    return fail(e);
  }
}
