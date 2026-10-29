// SCP-1j (BFF §63.7, §63.14) — the Social Messages page's types and pure helpers: who holds each of the officer's posts (`GET waiting`), the pipeline's
// leg of "Needs you" (`GET needs-you`) and the words of a follow-up's refusals. No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialMessages-data.ts` (server-only), the follow-up write in `lib/socialMessagesActions.ts` ("use server"). The answers are parsed
// defensively: a 200 with the wrong shape must read as "cannot tell", never as an empty list that says "nobody is holding anything of yours".

export interface WaitingPost {
  id: string;
  title: string;
  clientName: string;
  /** When the post entered the status it sits in (ISO). */
  since: string;
  /** The holder's last follow-up on this post (ISO), or null when there has been none. */
  lastFollowUpAt: string | null;
  /** The status the follow-up must name as `expectedStatus` (additive to §63.7: the button needs it). */
  pipelineStatus: string;
  engagementId: string;
  /** The client, whose conversation a client-held post opens (additive to §63.7). */
  clientId: string;
}

export interface WaitingGroup {
  holder: { role: string; label: string; userIds: string[] };
  posts: WaitingPost[];
}

export interface NeedsYouSocialItem {
  id: string;
  kind: string;
  role: string;
  title: string;
  clientName: string;
  since: string;
  due?: string;
  href: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** `GET waiting`. Throws on a body that is not one (the reader turns that into "cannot tell"); a group or post of the wrong shape is dropped, never invented. */
export function asWaitingGroups(raw: unknown): WaitingGroup[] {
  if (!isObj(raw) || !Array.isArray(raw.groups)) throw new Error("waiting: not a list of groups");
  const groups: WaitingGroup[] = [];
  for (const g of raw.groups) {
    if (!isObj(g) || !isObj(g.holder) || typeof g.holder.role !== "string" || !Array.isArray(g.posts)) continue;
    const posts: WaitingPost[] = [];
    for (const p of g.posts) {
      if (!isObj(p)) continue;
      const id = str(p.id);
      const since = str(p.since);
      const status = str(p.pipelineStatus);
      if (!id || !since || !status) continue;
      posts.push({
        id, title: str(p.title) ?? "Untitled post", clientName: str(p.clientName) ?? "A client", since, lastFollowUpAt: str(p.lastFollowUpAt),
        pipelineStatus: status, engagementId: str(p.engagementId) ?? "", clientId: str(p.clientId) ?? "",
      });
    }
    if (posts.length === 0) continue;
    groups.push({
      holder: {
        role: g.holder.role, label: str(g.holder.label) ?? g.holder.role,
        userIds: Array.isArray(g.holder.userIds) ? g.holder.userIds.filter((u): u is string => typeof u === "string") : [],
      },
      posts,
    });
  }
  return groups;
}

/** `GET needs-you`: the items and the sources that could not be read. Throws on a body that is not one. */
export function asNeedsYouSocial(raw: unknown): { items: NeedsYouSocialItem[]; partial: string[] } {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("needs-you: not a list of items");
  const items: NeedsYouSocialItem[] = [];
  for (const i of raw.items) {
    if (!isObj(i)) continue;
    const id = str(i.id);
    const kind = str(i.kind);
    const title = str(i.title);
    const since = str(i.since);
    const href = str(i.href);
    if (!id || !kind || !title || !since || !href) continue;
    items.push({
      id, kind, role: str(i.role) ?? "", title, clientName: str(i.clientName) ?? "", since, href,
      ...(str(i.due) ? { due: str(i.due) as string } : {}),
    });
  }
  return { items, partial: Array.isArray(raw.partial) ? raw.partial.filter((s): s is string => typeof s === "string") : [] };
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the group is called above its posts: the holder in words (the client's is "the client"). */
export function holderTitle(role: string, label: string): string {
  switch (role) {
    case "client": return "Waiting on the client";
    case "copywriter": return "Waiting on a copywriter";
    case "approver": return "Waiting on the Social Media head or the GM";
    case "designer": return "Waiting on the designer";
    case "external": return "Waiting on someone outside the team";
    default: return `Waiting on ${label.toLowerCase()}`;
  }
}

/** The status in the words a person uses for the step the post is in. */
export const STATUS_WORDS: Readonly<Record<string, string>> = {
  planned: "Planned", drafting: "Drafting", proofread: "Proofread", hod: "Head check", design: "Design", final: "Final check", client: "With the client",
  approved: "Approved", scheduled: "Scheduled", live: "Live", changes: "Changes asked", blocked: "Blocked",
};
export const statusWords = (status: string): string => STATUS_WORDS[status] ?? status;

/** "3 h 20 min", "45 min", "less than a minute": a wait in the words of a person. */
export function waitWords(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return "less than a minute";
  const totalMin = Math.ceil(s / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** How long ago, in the words of a person ("3 h ago", "2 days ago"). `now` is the caller's, so a test pins it. */
export function agoWords(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.floor((now - t) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export interface FollowUpRefusal { error: string; retryAfterSeconds?: number }

/** The words for a refused follow-up (BFF §63.14: 409 `follow_up_too_soon` with `retryAfterSeconds`, 409 `nobody_to_follow_up`, and the machine's common refusals). */
export function followUpRefusalText(r: FollowUpRefusal): string {
  switch (r.error) {
    case "follow_up_too_soon":
      return r.retryAfterSeconds !== undefined
        ? `The holder was reminded in the last 24 hours. You can follow up again in ${waitWords(r.retryAfterSeconds)}.`
        : "The holder was reminded in the last 24 hours. Try again later.";
    case "nobody_to_follow_up": return "Nobody else holds this post right now, so there is nobody to follow up.";
    case "status_changed": return "This post moved on while you were looking. Reload to see who holds it now.";
    case "invalid_transition": return "A follow-up does not fit where this post is now. Reload to see its step.";
    case "post_archived": return "This post has been archived.";
    case "post_not_found": return "This post is no longer there.";
    case "not_officer_or_approver": return "Only the client's officer, the Social Media head or the GM can follow up.";
    case "session_expired": return "Session expired — sign in again.";
    default: return r.error;
  }
}

/** What a "Needs you" row of the pipeline asks of the person, in words (`GET needs-you` `kind`). An unknown kind is shown as it came, never dropped. */
export const NEEDS_KIND_WORDS: Readonly<Record<string, string>> = {
  draft_to_send: "A draft to send", fix_asked: "A fix was asked", ready_to_schedule: "Ready to schedule", metrics_missing: "Metrics missing",
  report_due: "A monthly report is due", report_check: "A report to check", report_send: "A report to send", boost_start: "A boost to start",
  proofread: "To proofread", hod_approval: "Head approval", final_check: "Final check", design: "A design to make", design_revision: "A design to revise",
};
export const needsKindWords = (kind: string): string => NEEDS_KIND_WORDS[kind] ?? kind;

/** A post opens at `{D}/posts/[postId]` (SCP-1e builds the page). */
export const postHref = (deptId: string, postId: string): string => `/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(postId)}`;

/**
 * A client-held post opens the client's conversation (PV-4). The staff hub lists the client's threads under the Work tab's Conversation section; a thread
 * has its own page, but `GET waiting` names no thread (the client's answer waits on the post's review, not on one conversation), so the link is the list.
 */
export const clientConversationHref = (clientId: string): string => `/clients/${encodeURIComponent(clientId)}/work#conversation`;
