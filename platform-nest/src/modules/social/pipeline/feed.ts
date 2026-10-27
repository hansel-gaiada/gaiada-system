// SCP-1d / SCP-1j — the pure side of the Social feed, Messages and Needs you (BFF §63.7): who holds a post, whose turn it is, how
// healthy it is, in what order the feed lists it, and the resource Cerbos sees for each card. No I/O here: `feed-data.ts` reads, and
// `feed.controller.ts` asks Cerbos and answers.
//
// NOTHING IS RETYPED. The holder, the phase and the primary action come from the stage machine (`machine.ts`, which reads the
// fixture); health comes from `schedule-health.ts` through the helpers `cycles-data.ts` uses (`clientSlowerFor`), never a second rule.
import type { WorkingCalendar } from "../../hr/working-days";
import type { Resource } from "../../../rbac/cerbos";
import { socialPostResource } from "../pipeline-authz";
import { SCP } from "./fixture";
import {
  actionsFromStatus, cerbosActionsToAsk, holderOf, phaseOf, primaryActionOf, probe, type CerbosDecisions, type PipelinePostState,
} from "./machine";
import { ACTION_ROUTE_ACTIONS, HOLDER_LABELS } from "./pipeline-read";
import { clientSlowerFor, type EngagementRow } from "./cycles-data";
import { HEALTH_SEVERITY, parseStepEstimates, postHealth, type ApprovalSample, type Health } from "./schedule-health";
import type { FeedCandidate } from "./feed-data";

/** The most a feed page carries: one Cerbos request holds at most 50 resources, and the bar is one such request a page (§63.7). */
export const FEED_PAGE_MAX = 50;
export const FEED_PAGE_DEFAULT = 30;
export const FEED_PHASES: readonly string[] = SCP.phases.map((p) => p.key);

/** What the caller is, as far as the feed needs it. Every flag is read server-side (the principal's grants, the seat rows); never a query value. */
export interface FeedCaller {
  userId: string | null;
  /** A grant of `social_copywriter` that reaches the company (the derived role's own condition). */
  isCopywriter: boolean;
  /** A live lead seat on the company's Social Media or GM unit: one of the two seats of §63.2. The owner and the superadmin are not "seats". */
  isSeatApprover: boolean;
  /** A grant of `social_designer` that reaches the company. */
  isInTeamDesigner: boolean;
}

// ── holder, phase, state ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The machine's view of a candidate: the columns the holder, phase and primary action read; the rest is neutral (a probe reads no body). */
export function stateOfCandidate(c: FeedCandidate): PipelinePostState {
  return {
    id: c.id, pipelineStatus: c.pipelineStatus, deleted: false, archived: false, authorId: c.authorId,
    changeBy: c.changeBy, changeKind: c.changeKind, returnTo: c.returnTo, changeNote: null, changedOnly: c.changedOnly,
    copyBefore: null, blockedFrom: c.blockedFrom, blockReason: null, blockWaitingOn: c.blockWaitingOn, blockedAt: null,
    creativeSource: c.creativeSource, creativeState: c.creativeState, scheduleVia: c.scheduleVia, clientFirstSentAt: null, lastActionId: null,
    title: c.title, format: c.format, pillar: null, angle: null, objective: null, keyMessage: null, visualDirection: null,
    rawAssets: [], placement: [], scheduledAt: c.scheduledAt, mustHaves: [], caption: "", onAssetText: null, cta: null, hashtags: [],
    suggestions: {},
  };
}

/** Who holds the post, from the fixture; null when nobody (live) or when the row is one the machine cannot read (never thrown at a reader). */
export function holderRoleOf(c: FeedCandidate): string | null {
  try { return holderOf(stateOfCandidate(c)); } catch { return null; }
}

export function phaseOfCandidate(c: FeedCandidate): string | null {
  try { return phaseOf(stateOfCandidate(c)); } catch { return null; }
}

/** The maker: the post's author or the client's officer. Their own post is never their turn to proofread or approve (§63.3.2 step 6). */
export const isMakerOf = (c: Pick<FeedCandidate, "authorId" | "ownerId">, userId: string | null): boolean =>
  !!userId && (c.authorId === userId || c.ownerId === userId);

/** Whether the post is the caller's turn: the holder (fixture `holders`) is the caller, as officer, copywriter, seat approver or designer. */
export function isYourTurn(c: FeedCandidate, holder: string | null, who: FeedCaller): boolean {
  const uid = who.userId;
  if (!uid) return false;
  switch (holder) {
    case "officer": return c.ownerId === uid;
    case "copywriter": return who.isCopywriter && !isMakerOf(c, uid);
    case "approver": return who.isSeatApprover && !isMakerOf(c, uid);
    case "designer":
      return c.creativeSource === "in_team" ? who.isInTeamDesigner : c.creativeSource === "creatives" && c.iAmAssignee;
    default: return false;
  }
}

/** Posts the caller's own clients hold elsewhere (the `waiting` view and Messages): somebody else holds them, and a follow-up can reach them. */
export const isWaitingOn = (holder: string | null): boolean => holder !== null && holder !== "officer" && holder !== "publisher";

// ── health ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The post's health (BFF §63.5), or null when its cycle has no ready-by. The same `postHealth` the cycle table and `GET cycles/:id/health` use. */
export function healthOfCandidate(
  c: FeedCandidate, today: string, calendar: WorkingCalendar, samples: Map<string, ApprovalSample[]>,
  slowerCache: Map<string, boolean>,
): Health | null {
  if (!c.readyBy) return null;
  const estimates = parseStepEstimates(c.stepEstimates);
  let slower = slowerCache.get(c.engagementId);
  if (slower === undefined) {
    const e: EngagementRow = {
      id: c.engagementId, clientName: c.clientName, officerId: c.ownerId, officerName: null, deliveryBatch: null, postsPerCycle: null, stepEstimates: estimates,
    };
    slower = clientSlowerFor(e, samples, calendar);
    slowerCache.set(c.engagementId, slower);
  }
  return postHealth({
    today, readyBy: c.readyBy, calendar, estimates, clientSlower: slower,
    post: {
      status: c.pipelineStatus, changeBy: c.changeBy, changeKind: c.changeKind, returnTo: c.returnTo, changedOnly: c.changedOnly,
      blockedFrom: c.blockedFrom, blockWaitingOn: c.blockWaitingOn,
    },
  });
}

/** The feed's order: late, at risk, tight come first (worst first); everything else follows by how long the post has sat in its status. */
export const feedRank = (h: Health | null): number => {
  const s = h?.state;
  return s === "late" || s === "at_risk" || s === "tight" ? HEALTH_SEVERITY[s] : 0;
};

export interface FeedEntry {
  c: FeedCandidate;
  holder: string | null;
  phase: string | null;
  yourTurn: boolean;
  health: Health | null;
  rank: number;
}

/** Sort: health rank descending, then `status_since` ascending (the longest wait first), then id (a stable total order the cursor can use). */
export function compareEntries(a: Pick<FeedEntry, "rank"> & { c: Pick<FeedCandidate, "statusSince" | "id"> }, b: typeof a): number {
  if (a.rank !== b.rank) return b.rank - a.rank;
  if (a.c.statusSince !== b.c.statusSince) return a.c.statusSince < b.c.statusSince ? -1 : 1;
  return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
}

export interface FeedFilters {
  view: "your_turn" | "waiting" | "all";
  phase?: string;
}

/** The candidates the view keeps, with their facts, sorted. PURE. */
export function composeEntries(
  candidates: readonly FeedCandidate[], who: FeedCaller, f: FeedFilters,
  ctx: { today: string; calendar: WorkingCalendar; samples: Map<string, ApprovalSample[]> },
): FeedEntry[] {
  const slowerCache = new Map<string, boolean>();
  const out: FeedEntry[] = [];
  for (const c of candidates) {
    const holder = holderRoleOf(c);
    const yourTurn = isYourTurn(c, holder, who);
    if (f.view === "your_turn" && !yourTurn) continue;
    if (f.view === "waiting" && !(who.userId !== null && c.ownerId === who.userId && isWaitingOn(holder))) continue;
    const phase = phaseOfCandidate(c);
    if (f.phase !== undefined && phase !== f.phase) continue;
    const health = healthOfCandidate(c, ctx.today, ctx.calendar, ctx.samples, slowerCache);
    out.push({ c, holder, phase, yourTurn, health, rank: feedRank(health) });
  }
  return out.sort(compareEntries);
}

// ── the cursor ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An opaque cursor: the sort key of the last card sent. Null for a cursor that is not one of ours. */
export function encodeCursor(e: FeedEntry): string {
  return Buffer.from(JSON.stringify({ r: e.rank, s: e.c.statusSince, i: e.c.id }), "utf8").toString("base64url");
}
export function decodeCursor(raw: string): { rank: number; statusSince: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { r?: unknown; s?: unknown; i?: unknown };
    if (typeof v.r !== "number" || typeof v.s !== "string" || typeof v.i !== "string") return null;
    return { rank: v.r, statusSince: v.s, id: v.i };
  } catch { return null; }
}

/** One page after `cursor` (or the first). `nextCursor` is null at the end. */
export function pageOf(entries: readonly FeedEntry[], cursor: { rank: number; statusSince: string; id: string } | null, size: number): { page: FeedEntry[]; nextCursor: string | null } {
  const start = cursor
    ? entries.findIndex((e) => compareEntries(e, { rank: cursor.rank, c: { statusSince: cursor.statusSince, id: cursor.id } }) > 0)
    : 0;
  if (start < 0) return { page: [], nextCursor: null };
  const page = entries.slice(start, start + size);
  const more = start + size < entries.length;
  return { page, nextCursor: more && page.length > 0 ? encodeCursor(page[page.length - 1]) : null };
}

// ── nextAction: what Cerbos is asked, and how its answer is read ────────────────────────────────────────────────────────

/** The primary action of the post's status when it is one the action route accepts from this status, else null (live's `request_boost` is SCP-4's). */
export function primaryRouteAction(c: FeedCandidate): string | null {
  try {
    const state = stateOfCandidate(c);
    const primary = primaryActionOf(state);
    return primary && ACTION_ROUTE_ACTIONS.includes(primary) && actionsFromStatus(state).includes(primary) ? primary : null;
  } catch { return null; }
}

/** The `social_post` resource of BFF §63.3.3 for one candidate, every value from the rows. */
export function resourceOfCandidate(tenantId: string, c: FeedCandidate, approverIds: readonly string[], assigneeIds: readonly string[]): Resource {
  return socialPostResource(tenantId, {
    postId: c.id, engagementId: c.engagementId, pipelineStatus: c.pipelineStatus, ownerId: c.ownerId ?? "", creatorId: c.authorId ?? "",
    approverIds: [...approverIds], assigneeIds: [...assigneeIds], creativeSource: c.creativeSource ?? "",
  });
}

/** The Cerbos actions one candidate's primary step needs (`cerbosActionsToAsk`, as the post read asks them). */
export function cerbosActionsFor(c: FeedCandidate, action: string): string[] {
  return cerbosActionsToAsk(action, stateOfCandidate(c));
}

/** `nextAction` of a card: the primary step, decided by the machine's `probe` on Cerbos's answers (maker/checker and the status checks included). */
export function nextActionOf(
  c: FeedCandidate, action: string | null, decisions: CerbosDecisions, caller: { userId: string | null; isAutomation: boolean },
): { action: string; allowed: boolean; reason?: string } | null {
  if (action === null) return null;
  const r = probe({
    action, post: stateOfCandidate(c),
    principal: {
      userId: caller.userId ?? undefined, isAutomation: caller.isAutomation,
      isAuthor: !!caller.userId && c.authorId === caller.userId, isOfficer: !!caller.userId && c.ownerId === caller.userId,
    },
    cerbos: decisions, facts: {},
  });
  return r.allowed ? { action: r.action, allowed: true } : { action: r.action, allowed: false, ...(r.reason ? { reason: r.reason } : {}) };
}

// ── the card ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PipelineCard {
  id: string;
  engagementId: string;
  clientName: string;
  title: string;
  format: string | null;
  isExtra: boolean;
  isStory: boolean;
  thumbFileId: string | null;
  pipelineStatus: string;
  phase: string | null;
  holder: { role: string | null; label: string };
  yourTurn: boolean;
  health: Health | null;
  scheduledAt: string | null;
  statusSince: string;
  nextAction: { action: string; allowed: boolean; reason?: string } | null;
  simulated: boolean;
}

export function cardOf(e: FeedEntry, thumbFileId: string | null, nextAction: PipelineCard["nextAction"]): PipelineCard {
  const c = e.c;
  return {
    id: c.id, engagementId: c.engagementId, clientName: c.clientName, title: c.title, format: c.format, isExtra: c.isExtra,
    isStory: c.format === "story", thumbFileId, pipelineStatus: c.pipelineStatus, phase: e.phase,
    holder: e.holder === null ? { role: null, label: "Nobody" } : { role: e.holder, label: HOLDER_LABELS[e.holder] ?? e.holder },
    yourTurn: e.yourTurn, health: e.health, scheduledAt: c.scheduledAt, statusSince: c.statusSince, nextAction, simulated: c.simulated,
  };
}

// ── Needs you (BFF §63.7) ────────────────────────────────────────────────────────────────────────────────────────────────

export type NeedsRole = "officer" | "copywriter" | "approver" | "designer";
export interface NeedsKind { kind: string; role: NeedsRole }

/**
 * The pipeline's leg of "Needs you" for a post that is the caller's turn (plan §6.4): by status and holder. Officer: drafts to send, fixes asked,
 * ready to schedule. Copywriter: the proofread queue. HoD and GM: the HoD approvals and the final checks. Designer: designs and revisions.
 * Anything else is not a queue item (a planned post the officer has not started, a scheduled one waiting for its time). Reports, boosts and
 * "metrics missing" are other sources.
 */
export function needsYouKind(status: string, holder: string | null): NeedsKind | null {
  switch (`${status}:${holder}`) {
    case "drafting:officer": return { kind: "draft_to_send", role: "officer" };
    case "changes:officer": return { kind: "fix_asked", role: "officer" };
    case "approved:officer": return { kind: "ready_to_schedule", role: "officer" };
    case "proofread:copywriter": return { kind: "proofread", role: "copywriter" };
    case "hod:approver": return { kind: "hod_approval", role: "approver" };
    case "final:approver": return { kind: "final_check", role: "approver" };
    case "design:designer": return { kind: "design", role: "designer" };
    case "changes:designer": return { kind: "design_revision", role: "designer" };
    default: return null;
  }
}
