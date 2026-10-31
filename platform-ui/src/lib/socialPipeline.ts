// SCP-1e — the Social Media post page's types and pure helpers (BFF §63.6.2 `GET posts/:postId/pipeline`, §63.6.3 to §63.6.6 the writes). No
// server-only import, so a client component may import the values.
//
// Readers live in `lib/socialPipeline-data.ts` (server-only, `ReadResult`), the writes in `lib/socialPipelineActions.ts` ("use server").
// The answer is parsed defensively (`asPipelinePost`): a 200 with the wrong shape must read as "cannot tell", never as a plausible empty post.
//
// THE MACHINE IS THE FIXTURE. Phases, statuses, holders, the primary action, which action exists from which status, which Cerbos action each needs,
// which fields an edit may write in which status, and every refusal code are read from `scpStageMachine.json` (through `scpStageMachine.ts`);
// nothing here restates a transition. What IS typed here is words (labels, the sentence for each refusal code, the sentence for each history line)
// and the page's own presentation (the eight steps, which dialog an action needs); `socialPipeline.test.ts` pins each of them against the fixture,
// so a change to the machine breaks a test instead of drawing a stale page. The server decides every write; this file only decides what to draw.
import fixture from "./scpStageMachine.json";
import { scpActionsFromStatus, scpHolderOf, scpPhaseLabel, SCP_STATUSES } from "./scpStageMachine";
import { ALLOCATION_NETWORKS, NETWORK_LABEL } from "./socialAllocation";
import { asHealth, PLAN_REFUSAL_REASON, type Health } from "./socialCycles";
import { DISPLAY_TZ } from "./format";
import { asBoostRowOrNull, type BoostRow } from "./socialBoostRow";

// ── The fixture, as this file reads it ───────────────────────────────────────────────────────────────────────────────────────

interface FxAction {
  action: string;
  kind?: string;
  cerbosAction?: string | Record<string, string>;
  params: Record<string, string>;
  from: Array<{ status: string; changeCase?: string[] }>;
}
const F = fixture as unknown as {
  refusals: Record<string, { http: number; with?: string }>;
  fieldGroups: Record<string, string[]>;
  editRules: Array<{ status: string; changeCases?: string[]; fieldGroups: string[]; alsoFields?: string[]; copyLog?: boolean; refusal?: string }>;
  cerbosActions: Record<string, { actors: unknown; refusal: string }>;
  actions: FxAction[];
  changeCases: Array<{ key: string; changeBy: string; changeKind: string; returnTo: string; phase: string; holder: string }>;
  handoffChecks: Array<{ code: string }>;
  requiredToSend: Array<{ code: string }>;
};

/** The actions `POST posts/:postId/actions` takes: every fixture action except the ones with a route of their own (create, edit, suggest and the two
 *  design writes) and the client's own (the portal's). The server's `ACTION_ROUTE_ACTIONS`, by the same rule. */
const OWN_ROUTE = new Set(["create", "edit", "suggest", "add_design", "remove_design"]);
export const PIPELINE_ACTIONS: readonly string[] = F.actions
  .filter((a) => !OWN_ROUTE.has(a.action) && !(typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:")))
  .map((a) => a.action);

/** The fixture's refusal codes: the catalogue the words below must cover. */
export const REFUSAL_CODES: readonly string[] = Object.keys(F.refusals);

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One Asset Library asset a designer may add to a post: its version group and its latest version. */
export interface AssetChoice { groupId: string; versionId: string; versionNo: number; name: string }
export interface PersonRef { id: string; name: string }
export interface RawAsset { url: string; label: string; source: string; aiNote: string | null }
export interface DesignRow {
  id: string;
  position: number;
  asset: { groupId: string; versionId: string; versionNo: number; name: string; source: string; aiNote: string | null } | null;
  link: { url: string; source: string; aiNote: string | null } | null;
  fileId: string | null;
}
export interface Suggestion { value: unknown; base: unknown; stale: boolean; by: PersonRef | null; at: string }
export interface PostCheck { code: string; ok: boolean; message: string; skippable: boolean }
export interface ActionRow { action: string; allowed: boolean; reason?: string }
export interface HistoryRow {
  action: string; from: string | null; to: string | null; by: PersonRef | null; agent: string | null; at: string;
  recorded: { channel: string } | null; viaPortal: boolean;
}
export interface CopyLogRow { field: string; before: unknown; after: unknown; via: string; by: PersonRef | null; suggestedBy: PersonRef | null; stage: string; at: string }
/** SCP-Sc: `simulated` is the variant's own mark (the simulator served it); `lastError` is the failure the server recorded, only on a failed variant. */
export interface VariantRow { id: string; network: string; handle: string | null; status: string; reviewStatus: string; simulated: boolean; lastError: string | null }
/** SCP-Sc (BFF §63.10): "Publish now (simulated)". null when the button is not part of this post's page; else whether the caller may press it, and the refusal code if not. */
export interface SimulatedPublishOffer { allowed: boolean; reason?: string }

/** BFF §63.6.2's PipelinePost, the parts the page draws. */
export interface PipelinePost {
  id: string; engagementId: string; clientId: string; clientName: string; cycleId: string | null; cycleMonth: string;
  title: string; format: string | null; pillar: string | null; angle: string | null; objective: string | null; keyMessage: string | null;
  caption: string; onAssetText: string | null; cta: string | null; hashtags: string[]; visualDirection: string | null;
  rawAssets: RawAsset[]; placement: string[]; scheduledAt: string | null; isExtra: boolean; isStory: boolean; mustHaves: string[];
  pipelineStatus: string; phase: string | null; statusSince: string | null; engineStatus: string | null;
  change: { by: string; kind: string; returnTo: string; note: string | null; case: string } | null;
  changedOnly: boolean; copyBefore: Record<string, unknown> | null;
  block: { reason: string; waitingOn: string; from: string; at: string | null } | null;
  creativeSource: "creatives" | "in_team" | null; creativeState: string | null;
  creativeRequest: { id: string; title: string; status: string } | null;
  designs: DesignRow[];
  suggestions: Record<string, Suggestion>;
  checks: PostCheck[]; skippedChecks: Array<{ codes: string[]; reason: string; by: PersonRef | null; at: string }>;
  officer: PersonRef | null; author: PersonRef | null;
  holder: { role: string | null; userIds: string[]; label: string };
  health: Health | null;
  variants: VariantRow[];
  approvedSchedule: { scheduledAt: string | null; placement: string[] } | null;
  scheduleVia: "manual" | "publisher" | null; reviewHash: string | null;
  liveUrl: string | null; wentLiveAt: string | null; simulated: boolean; archivedAt: string | null;
  simulatedPublishNow: SimulatedPublishOffer | null;
  /** SCP-4b (BFF §63.6.2, §63.11): the post's boost: its open one, else its latest, or null. Optional so a hand-built post of a test need not name it. */
  boost?: BoostRow | null;
  /** The client's latest decision (SCP-2, BFF §63.6.2): given in the portal, or recorded by staff on the client's behalf. Null before one, and again once the
   *  post goes back to the client. */
  clientDecision: ClientDecision | null;
  copyLog: CopyLogRow[]; history: HistoryRow[];
  actions: ActionRow[]; nextAction: string | null;
}

export interface ClientDecision {
  decisionId: string; kind: "approved" | "changes"; changeKind: string | null; note: string | null; decidedAt: string;
  via: "portal" | "recorded"; channel: string | null; decidedBy: PersonRef | null; recordedBy: PersonRef | null;
}

function asClientDecision(v: unknown): ClientDecision | null {
  if (!isObj(v) || typeof v.decisionId !== "string" || (v.kind !== "approved" && v.kind !== "changes")) return null;
  return {
    decisionId: v.decisionId, kind: v.kind, changeKind: str(v.changeKind), note: str(v.note), decidedAt: str(v.decidedAt) ?? "",
    via: v.via === "recorded" ? "recorded" : "portal", channel: str(v.channel), decidedBy: person(v.decidedBy), recordedBy: person(v.recordedBy),
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const person = (v: unknown): PersonRef | null => (isObj(v) && typeof v.id === "string" ? { id: v.id, name: str(v.name) ?? "" } : null);

function asDesign(v: unknown): DesignRow | null {
  if (!isObj(v) || typeof v.id !== "string") return null;
  const a = isObj(v.asset) ? v.asset : null;
  const l = isObj(v.link) ? v.link : null;
  return {
    id: v.id, position: typeof v.position === "number" ? v.position : 1,
    asset: a && typeof a.groupId === "string"
      ? { groupId: a.groupId, versionId: str(a.versionId) ?? "", versionNo: typeof a.versionNo === "number" ? a.versionNo : 1, name: str(a.name) ?? "", source: str(a.source) ?? "unknown", aiNote: str(a.aiNote) }
      : null,
    link: l && typeof l.url === "string" ? { url: l.url, source: str(l.source) ?? "unknown", aiNote: str(l.aiNote) } : null,
    fileId: str(v.fileId),
  };
}

/**
 * A `PipelinePost` from a read, or from a write's answer: a write answers `{post, applied, warnings}` (the server's `answer()`), a read answers the post itself,
 * so either is accepted. Throws on a body that is neither (the reader turns that into "cannot tell"; an action turns it into an error line).
 */
export function asPipelinePost(raw: unknown): PipelinePost {
  const o = isObj(raw) && isObj(raw.post) && typeof raw.pipelineStatus !== "string" ? raw.post : raw;
  if (!isObj(o) || typeof o.id !== "string" || typeof o.pipelineStatus !== "string") throw new Error("pipeline post: not a PipelinePost");
  const change = isObj(o.change) && typeof o.change.case === "string"
    ? { by: str(o.change.by) ?? "", kind: str(o.change.kind) ?? "", returnTo: str(o.change.returnTo) ?? "", note: str(o.change.note), case: o.change.case }
    : null;
  const block = isObj(o.block) && typeof o.block.from === "string"
    ? { reason: str(o.block.reason) ?? "", waitingOn: str(o.block.waitingOn) ?? "external", from: o.block.from, at: str(o.block.at) }
    : null;
  const suggestions: Record<string, Suggestion> = {};
  if (isObj(o.suggestions)) {
    for (const [k, s] of Object.entries(o.suggestions)) {
      if (isObj(s)) suggestions[k] = { value: s.value, base: s.base, stale: s.stale === true, by: person(s.by), at: str(s.at) ?? "" };
    }
  }
  const holder = isObj(o.holder) ? o.holder : {};
  const approved = isObj(o.approvedSchedule) ? { scheduledAt: str(o.approvedSchedule.scheduledAt), placement: strList(o.approvedSchedule.placement) } : null;
  const creativeRequest = isObj(o.creativeRequest) && typeof o.creativeRequest.id === "string"
    ? { id: o.creativeRequest.id, title: str(o.creativeRequest.title) ?? "", status: str(o.creativeRequest.status) ?? "" }
    : null;
  return {
    id: o.id, engagementId: str(o.engagementId) ?? "", clientId: str(o.clientId) ?? "", clientName: str(o.clientName) ?? "", cycleId: str(o.cycleId),
    cycleMonth: str(o.cycleMonth) ?? "",
    title: str(o.title) ?? "", format: str(o.format), pillar: str(o.pillar), angle: str(o.angle), objective: str(o.objective), keyMessage: str(o.keyMessage),
    caption: str(o.caption) ?? "", onAssetText: str(o.onAssetText), cta: str(o.cta), hashtags: strList(o.hashtags), visualDirection: str(o.visualDirection),
    rawAssets: arr(o.rawAssets).filter(isObj).map((a) => ({ url: str(a.url) ?? "", label: str(a.label) ?? "", source: str(a.source) ?? "unknown", aiNote: str(a.aiNote) })),
    placement: strList(o.placement), scheduledAt: str(o.scheduledAt), isExtra: o.isExtra === true, isStory: o.isStory === true, mustHaves: strList(o.mustHaves),
    pipelineStatus: o.pipelineStatus, phase: str(o.phase), statusSince: str(o.statusSince), engineStatus: str(o.engineStatus),
    change, changedOnly: o.changedOnly === true, copyBefore: isObj(o.copyBefore) ? o.copyBefore : null, block,
    creativeSource: o.creativeSource === "creatives" || o.creativeSource === "in_team" ? o.creativeSource : null, creativeState: str(o.creativeState),
    creativeRequest,
    designs: arr(o.designs).map(asDesign).filter((d): d is DesignRow => d !== null),
    suggestions,
    checks: arr(o.checks).filter(isObj).map((c) => ({ code: str(c.code) ?? "", ok: c.ok === true, message: str(c.message) ?? "", skippable: c.skippable === true })),
    skippedChecks: arr(o.skippedChecks).filter(isObj).map((s) => ({ codes: strList(s.codes), reason: str(s.reason) ?? "", by: person(s.by), at: str(s.at) ?? "" })),
    officer: person(o.officer), author: person(o.author),
    holder: { role: str(holder.role), userIds: strList(holder.userIds), label: str(holder.label) ?? "" },
    health: asHealth(o.health),
    variants: arr(o.variants).filter(isObj).map((v) => ({ id: str(v.id) ?? "", network: str(v.network) ?? "", handle: str(v.handle), status: str(v.status) ?? "", reviewStatus: str(v.reviewStatus) ?? "", simulated: v.simulated === true, lastError: str(v.lastError) })),
    approvedSchedule: approved, scheduleVia: o.scheduleVia === "manual" || o.scheduleVia === "publisher" ? o.scheduleVia : null, reviewHash: str(o.reviewHash),
    liveUrl: str(o.liveUrl), wentLiveAt: str(o.wentLiveAt), simulated: o.simulated === true, archivedAt: str(o.archivedAt),
    simulatedPublishNow: isObj(o.simulatedPublishNow) && typeof o.simulatedPublishNow.allowed === "boolean"
      ? { allowed: o.simulatedPublishNow.allowed, ...(typeof o.simulatedPublishNow.reason === "string" ? { reason: o.simulatedPublishNow.reason } : {}) }
      : null,
    clientDecision: asClientDecision(o.clientDecision),
    boost: asBoostRowOrNull(o.boost),
    copyLog: arr(o.copyLog).filter(isObj).map((c) => ({
      field: str(c.field) ?? "", before: c.before, after: c.after, via: str(c.via) ?? "", by: person(c.by), suggestedBy: person(c.suggestedBy), stage: str(c.stage) ?? "", at: str(c.at) ?? "",
    })),
    history: arr(o.history).filter(isObj).map((h) => ({
      action: str(h.action) ?? "", from: str(h.from), to: str(h.to), by: person(h.by), agent: str(h.agent), at: str(h.at) ?? "",
      recorded: isObj(h.recorded) && typeof h.recorded.channel === "string" ? { channel: h.recorded.channel } : null, viaPortal: h.viaPortal === true,
    })),
    actions: arr(o.actions).filter(isObj).filter((a) => typeof a.action === "string").map((a) => ({
      action: a.action as string, allowed: a.allowed === true, ...(typeof a.reason === "string" ? { reason: a.reason } : {}),
    })),
    nextAction: str(o.nextAction),
  };
}

// ── The refusal words (one map, every fixture code) ────────────────────────────────────────────────────────────────────────

/** The sentence for each refusal code of the fixture. `socialPipeline.test.ts` fails when a code of the fixture has no words, and when a word has no code. */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  unknown_action: "The server does not know this action.",
  missing_field: "A required value is missing.",
  invalid_field: "A value is not valid.",
  post_not_found: "This post no longer exists.",
  cycle_not_found: "This client's cycle no longer exists.",
  engagement_not_found: "This client is no longer on the list.",
  decision_not_found: "That decision no longer exists.",
  design_not_found: "That design is already gone. Reload the page.",
  asset_not_found: "That asset is not in the Asset Library.",
  suggestion_not_found: "That suggestion is already gone. Reload the page.",
  boost_not_found: "That boost no longer exists.",
  proposal_not_found: "That proposal no longer exists.",
  automation_cannot_act: "An automation cannot take this step. A person has to.",
  author_cannot_approve: "You wrote or look after this post, so you cannot pass it at this step. Another person has to.",
  not_the_officer: "Only the client's officer can do this.",
  not_a_copywriter: "Only a copywriter can do this.",
  not_an_approver: "Only the Social Media head, the GM, the owner or the superadmin can do this.",
  not_the_designer: "Only the designer on this client can do this.",
  not_officer_or_approver: "Only the client's officer, the Social Media head, the GM, the owner or the superadmin can do this.",
  not_a_social_approver: PLAN_REFUSAL_REASON,
  not_your_decision: "Only the person who made a decision can undo it.",
  cancel_required: "This post is scheduled through the publisher, so rescheduling it also needs the right to cancel. Ask one of the four approvers to unschedule it first.",
  social_approver_required: "Only the Social Media head, the GM, the owner or the superadmin can decide this, and never the post's author or officer.",
  view_only: "Your access to this client is view-only.",
  not_a_pipeline_post: "This is a Composer post, not a pipeline post.",
  post_archived: "This post is archived and cannot change.",
  status_changed: "Someone moved this post while you were looking at it.",
  invalid_transition: "This action is not possible from the post's current step.",
  field_locked: "That field cannot be changed at this step.",
  incomplete_post: "The post is not complete enough to send. These cannot be skipped.",
  checks_failed: "Some hand-off checks failed. Fix them, or send anyway with a reason.",
  suggestion_stale: "A suggestion was made against text that has changed since. Ask the copywriter to suggest again, or drop it.",
  creatives_unit_missing: "The company has no Creatives department, so the design request cannot be opened.",
  request_kind_unavailable: "Project Management is off for this company, so the design request to Creatives cannot be opened. Ask an admin to turn it on.",
  design_missing: "Add at least one design first.",
  design_not_stored: "A design that is only a link has nothing to show the client. Add it from the Asset Library.",
  no_account_for_network: "The client has no account on a network the post is placed on.",
  ambiguous_account: "The client has more than one account on a network the post is placed on, so the server cannot choose.",
  publisher_kinds_mixed: "This post's networks mix simulated and real accounts. Place it on one kind only.",
  content_changed: "The post changed after the client was shown it.",
  post_not_with_client: "The post is not with the client.",
  client_review_already_decided: "The client has already decided on this post.",
  undo_window_passed: "The time to undo has passed.",
  approved_time_passed: "The time the client approved has passed. Reschedule it: the client will be asked again.",
  no_change: "Nothing changes. Give a new date or time, or a different placement.",
  media_rules_failed: "A network's media rules are not met.",
  publisher_unavailable: "No publisher is registered, so it cannot be scheduled through the publisher.",
  dispatch_in_flight: "A network is publishing this post right now. Try again in a moment.",
  post_is_live: "The post is live and cannot change.",
  nobody_to_follow_up: "Nobody else holds this post, so there is nobody to follow up with.",
  follow_up_too_soon: "The holder was followed up with in the last 24 hours.",
  post_not_live: "The post is not live yet.",
  open_boost_exists: "This post already has an open boost.",
  currency_mismatch: "The boost's currency does not match the client's.",
  boost_not_waiting: "That boost is not waiting for a decision.",
  boost_already_decided: "That boost has already been decided.",
  boost_status_changed: "That boost changed while you were looking at it.",
  invalid_boost_transition: "That boost cannot move there from its current state.",
  proposal_pending: "A proposal is already waiting.",
  budget_below_committed: "The budget cannot go below what is already committed.",
  budget_already_decided: "That budget change has already been decided.",
  decide_per_post: "Boost decisions are made one post at a time.",
  pipeline_post: "This post is in the pipeline, so it is changed through its steps, not the Composer.",
  officer_not_member: "The officer must be a member of the company.",
  officer_set_by_allocation: "The officer is set on the Allocation page.",
  rules_changed: "Someone else saved the rules first. Reload them, then make your change again.",
  saved_item_not_found: "That saved item is gone. It may have been deleted. Reload Saved.",
  audit_not_found: "That audit is gone. It may have been deleted. Go back to the audit list.",
  audit_final: "This audit is final, so it cannot change. A final audit is a dated record; start a new one for the client instead.",
  audit_attached: "This prospect audit is already attached to another client.",
  not_a_prospect_audit: "Only a prospect's audit can be attached to a client.",
  idea_not_found: "That idea is gone. It may have been deleted. Reload the report.",
  idea_planned: "That idea is already in a plan, so it cannot change. Discard its post first to free it.",
  cycle_closed: "That plan month is already over. Pick a later month.",
};

/**
 * SCP-Sc: the refusals of `POST posts/:postId/simulated-publish-now` (BFF §63.10) that are not in the stage machine's fixture, so not in
 * `REFUSAL_WORDS` (`socialPipeline.test.ts` pins that map to the fixture's codes exactly). `not_an_approver` and `automation_cannot_act`
 * are the fixture's and are worded there.
 */
export const SIMULATED_PUBLISH_WORDS: Readonly<Record<string, string>> = {
  simulation_disabled: "The social simulator is switched off, so nothing can be published through it.",
  not_scheduled_by_publisher: "This post is not scheduled through the publisher, so there is nothing to publish now.",
  simulated_account_required: "A network on this post is not a simulated account, so the simulator will not publish it.",
  simulated_approval_not_decided: "Every network's publish approval has to be decided in Approvals first. This button never approves anything.",
  simulated_not_dispatched: "A decided approval has not been sent to the simulator yet, or its send failed. Give it a moment, or unschedule the post.",
};

/** The reason in words for a disabled button: the code alone, as the read's `actions[].reason` carries it (no detail). */
export function reasonWords(code: string | undefined): string {
  if (!code) return "You cannot take this step.";
  return REFUSAL_WORDS[code] ?? SIMULATED_PUBLISH_WORDS[code] ?? genericWords(code);
}

function genericWords(code: string): string {
  if (code.startsWith("not authorized")) return "You are not allowed to do this.";
  const s = code.replace(/_/g, " ").trim();
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : "The server refused this.";
}

/** A refusal as the page gets it from a write: the code, and whatever the server added (BFF §63.0 Refusals). */
export interface Refusal {
  status: number;
  error: string;
  field?: string;
  detail?: Record<string, unknown>;
  blockers?: Array<{ code: string; message: string }>;
  retryAfterSeconds?: number;
  reason?: string;
}

/** The refusal parts a raw error body carries (`PlatformError.body`). */
export function refusalFromBody(status: number, error: string, body: unknown, field?: string, reason?: string): Refusal {
  const b = isObj(body) ? body : {};
  const blockers = arr(b.blockers).filter(isObj).filter((x) => typeof x.code === "string").map((x) => ({ code: x.code as string, message: str(x.message) ?? "" }));
  return {
    status, error, ...(field ? { field } : {}), ...(isObj(b.detail) ? { detail: b.detail } : {}), ...(blockers.length ? { blockers } : {}),
    ...(typeof b.retryAfterSeconds === "number" ? { retryAfterSeconds: b.retryAfterSeconds } : {}), ...(reason ? { reason } : {}),
  };
}

/** The label of a field (the words a person knows it by). */
export const FIELD_LABEL: Readonly<Record<string, string>> = {
  title: "Title", format: "Format", pillar: "Pillar", angle: "Angle", objective: "Objective", keyMessage: "Key message", visualDirection: "Visual direction",
  rawAssets: "Reference images", placement: "Networks", scheduledAt: "Date and time", mustHaves: "Must-haves", caption: "Caption", onAssetText: "Text on the image",
  cta: "Call to action", hashtags: "Hashtags", expectedStatus: "The post's step", actionId: "The request", note: "The note", reason: "The reason",
  waitingOn: "Who you are waiting on", changeKind: "The kind of change", channel: "The channel", url: "The link", at: "The date and time", sendAnywayReason: "The reason",
  sendAnyway: "Send anyway", anchor: "The pin", assetGroupId: "The asset", linkUrl: "The link", linkSource: "The link's source", linkAiNote: "The AI note",
  position: "The position", designId: "The design", fields: "The fields", field: "The field", value: "The value",
  // SCP-3c: the metrics form's fields (BFF §63.10).
  // SCP-4b: the boost and boost-budget forms' fields (BFF §63.11).
  goal: "The goal", audience: "The audience", audienceNote: "The audience note", dailyBudgetMinor: "The daily budget", days: "The days", startsOn: "The start date",
  spendMinor: "The spend", paidReach: "The paid reach", amountMinor: "The amount", decision: "The decision",
  capturedAt: "The capture time", reach: "Reach", impressions: "Impressions", likes: "Likes", comments: "Comments", shares: "Shares", saves: "Saves", videoViews: "Video views", clicks: "Clicks",
};
const fieldName = (f: string | undefined): string => (f ? FIELD_LABEL[f] ?? f : "A value");

const STATUS_WORD: Record<string, string> = {
  planned: "Planned", drafting: "Draft", proofread: "Proofread", hod: "HoD approval", design: "Creative", final: "Final check", client: "With the client",
  approved: "Client approved", scheduled: "Scheduled", live: "Live", changes: "Changes asked", blocked: "Blocked",
};
/** A status in words (`planned` is "Planned", `hod` is "HoD approval"). */
export const statusLabel = (s: string | null | undefined): string => (s ? STATUS_WORD[s] ?? s : "");

/** A refusal in a sentence or two. The code stays the contract; this is the words, with the figures the server added. */
export function refusalText(r: Refusal): string {
  const d = r.detail ?? {};
  const base = REFUSAL_WORDS[r.error] ?? SIMULATED_PUBLISH_WORDS[r.error] ?? genericWords(r.error);
  switch (r.error) {
    case "missing_field": return `${fieldName(r.field)} is required.`;
    case "invalid_field": return `${fieldName(r.field)} is not valid.`;
    case "status_changed": {
      const s = typeof d.status === "string" ? d.status : null;
      return s ? `${base} It is now at ${statusLabel(s)}. The page has been refreshed.` : base;
    }
    case "invalid_transition": {
      const s = typeof d.status === "string" ? d.status : null;
      return s ? `${base} The post is at ${statusLabel(s)}.` : base;
    }
    case "field_locked": {
      const f = typeof d.field === "string" ? FIELD_LABEL[d.field] ?? d.field : "That field";
      const s = typeof d.status === "string" ? statusLabel(d.status) : "this step";
      return `${f} cannot be changed at ${s}.`;
    }
    case "suggestion_stale": {
      const f = Array.isArray(d.fields) ? d.fields.filter((x): x is string => typeof x === "string").map((x) => FIELD_LABEL[x] ?? x) : [];
      return f.length ? `${base} Out of date: ${f.join(", ")}.` : base;
    }
    case "no_account_for_network": case "ambiguous_account": {
      const n = Array.isArray(d.networks) ? d.networks.filter((x): x is string => typeof x === "string").map((x) => NETWORK_LABEL[x] ?? x) : [];
      return n.length ? `${base} Check: ${n.join(", ")}.` : base;
    }
    case "follow_up_too_soon": {
      const s = r.retryAfterSeconds;
      if (typeof s !== "number") return base;
      const h = Math.floor(s / 3600);
      const m = Math.ceil((s % 3600) / 60);
      return `${base} Try again in ${h > 0 ? `${h} h ` : ""}${m} min.`;
    }
    case "media_rules_failed": return base;
    default:
      if (r.status === 403 && r.reason === "assurance_required") return "This step needs a stronger sign-in. Sign in again with your second factor.";
      return base;
  }
}

/** One line per blocker, in the server's own words. */
export const blockerLines = (r: Refusal): string[] => (r.blockers ?? []).map((b) => b.message || genericWords(b.code));

// ── Actions: labels, dialogs, params ─────────────────────────────────────────────────────────────────────────────────────────

/** SCP-Sc: the label of the simulated publish's own button (it is a route of its own, not a stage action of the fixture). */
export const PUBLISH_NOW_LABEL = "Publish now (simulated)";

/** SCP-Sc: why a scheduled post is failed, one line per failed variant: the network and the server's recorded message, without its leading code. */
export function failedPublishLines(post: Pick<PipelinePost, "pipelineStatus" | "engineStatus" | "variants">): Array<{ network: string; text: string }> {
  if (post.pipelineStatus !== "scheduled" || post.engineStatus !== "failed") return [];
  return post.variants.filter((v) => v.status === "failed").map((v) => {
    const raw = v.lastError ?? "";
    const i = raw.indexOf(": ");
    const text = (i > 0 && /^[a-z_]+$/.test(raw.slice(0, i)) ? raw.slice(i + 2) : raw).trim();
    return { network: v.network, text: text || "No reason was recorded." };
  });
}

export const ACTION_LABEL: Readonly<Record<string, string>> = {
  start_draft: "Start draft", accept_suggestion: "Accept suggestion", send_to_proofread: "Send to proofread", approve_copy: "Approve copy",
  return_copy: "Return with edits", approve_for_design: "Approve for design", hod_changes: "Ask for changes", resend: "Send back for approval",
  start_design: "Start design", submit_design: "Submit for the final check", final_approve: "Send to the client", final_changes: "Ask for changes",
  record_client_approve: "Record client approval", record_client_change: "Record client change", schedule: "Schedule in Meta",
  schedule_publisher: "Schedule through the publisher", unschedule: "Unschedule", reschedule: "Reschedule", mark_live: "Mark live", block: "Block",
  resolve: "Resolve", follow_up: "Follow up", discard: "Discard", archive: "Archive",
};

export type DialogKind =
  | "note" | "change" | "block" | "record_approve" | "record_change" | "send" | "schedule" | "reschedule" | "mark_live" | "archive" | "follow_up" | "confirm";

/** Which small dialog collects an action's params; `null` posts straight away. */
export const ACTION_DIALOG: Readonly<Record<string, DialogKind | null>> = {
  start_draft: null, accept_suggestion: null, send_to_proofread: "send", approve_copy: null, return_copy: "note", approve_for_design: null, hod_changes: "note",
  resend: null, start_design: null, submit_design: null, final_approve: null, final_changes: "change", record_client_approve: "record_approve",
  record_client_change: "record_change", schedule: "schedule", schedule_publisher: "schedule", unschedule: "confirm", reschedule: "reschedule", mark_live: "mark_live",
  block: "block", resolve: null, follow_up: "follow_up", discard: "confirm", archive: "archive",
};

export const CHANNELS = ["whatsapp", "email", "meeting"] as const;
export const CHANNEL_LABEL: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", email: "Email", meeting: "A meeting" };
export const CHANGE_KINDS = ["copy", "design"] as const;
export const CHANGE_KIND_LABEL: Readonly<Record<string, string>> = { copy: "The copy", design: "The design" };
export const WAITING_ON = ["client", "designer", "copywriter", "approver", "officer", "external"] as const;
export const WAITING_ON_LABEL: Readonly<Record<string, string>> = {
  client: "The client", designer: "The designer", copywriter: "The copywriter", approver: "An approver", officer: "The officer", external: "Someone outside",
};
export const SOURCES = ["own", "client", "stock", "ai", "unknown"] as const;
export const SOURCE_LABEL: Readonly<Record<string, string>> = { own: "Our own", client: "From the client", stock: "Stock", ai: "Made with AI", unknown: "Not known" };

export const NOTE_MAX = 2000;
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const SEND_ANYWAY_MIN = 10;
export const SEND_ANYWAY_MAX = 500;
export const FOLLOW_UP_NOTE_MAX = 500;
const len = (s: string): number => [...s.trim()].length;
export const isHttpUrl = (s: string): boolean => {
  if (s.length > 500 || !/^https?:\/\/\S+$/i.test(s)) return false;
  try { new URL(s); return true; } catch { return false; }
};

/** What a dialog collected, as strings and flags (the form's own state). */
export interface DialogInput {
  note?: string; reason?: string; waitingOn?: string; channel?: string; changeKind?: string; url?: string; at?: string;
  placement?: string[]; anchor?: { x: number; y: number; fileId: string } | null; sendAnyway?: boolean; sendAnywayReason?: string;
}
export type ParamsResult = { ok: true; params: Record<string, unknown> } | { ok: false; field: string; message: string };
const bad = (field: string, message: string): ParamsResult => ({ ok: false, field, message });
const oneOf = (v: string | undefined, list: readonly string[]): v is string => typeof v === "string" && list.includes(v);

/** The body params of an action from what its dialog collected, validated by the fixture's own rules (the server checks again and decides). */
export function buildActionParams(action: string, i: DialogInput, post?: Pick<PipelinePost, "approvedSchedule">): ParamsResult {
  const note = (min: number, max: number, field = "note"): ParamsResult | string => {
    const v = (field === "reason" ? i.reason : i.note) ?? "";
    const n = len(v);
    if (n < min) return bad(field, min <= 1 ? "Write a note first." : `Give a reason of at least ${min} characters.`);
    if (n > max) return bad(field, `Keep it to ${max} characters or fewer.`);
    return v.trim();
  };
  switch (action) {
    case "return_copy": case "hod_changes": {
      const n = note(1, NOTE_MAX);
      return typeof n === "string" ? { ok: true, params: { note: n } } : n;
    }
    case "final_changes": {
      if (!oneOf(i.changeKind, CHANGE_KINDS)) return bad("changeKind", "Say whether the copy or the design needs to change.");
      const n = note(1, NOTE_MAX);
      return typeof n === "string" ? { ok: true, params: { changeKind: i.changeKind, note: n } } : n;
    }
    case "block": {
      const r = note(REASON_MIN, REASON_MAX, "reason");
      if (typeof r !== "string") return r;
      if (!oneOf(i.waitingOn, WAITING_ON)) return bad("waitingOn", "Say who you are waiting on.");
      return { ok: true, params: { reason: r, waitingOn: i.waitingOn } };
    }
    case "archive": {
      const r = note(REASON_MIN, REASON_MAX, "reason");
      return typeof r === "string" ? { ok: true, params: { reason: r } } : r;
    }
    case "record_client_approve": case "record_client_change": {
      const change = action === "record_client_change";
      if (change && !oneOf(i.changeKind, CHANGE_KINDS)) return bad("changeKind", "Say whether the client asked for a copy or a design change.");
      if (!oneOf(i.channel, CHANNELS)) return bad("channel", "Say how the client told you.");
      const n = note(1, NOTE_MAX);
      if (typeof n !== "string") return n;
      return { ok: true, params: { ...(change ? { changeKind: i.changeKind } : {}), channel: i.channel, note: n, ...(change && i.anchor ? { anchor: i.anchor } : {}) } };
    }
    case "send_to_proofread": {
      if (!i.sendAnyway) return { ok: true, params: {} };
      const r = (i.sendAnywayReason ?? "").trim();
      const n = len(r);
      if (n < SEND_ANYWAY_MIN) return bad("sendAnywayReason", `Give a reason of at least ${SEND_ANYWAY_MIN} characters.`);
      if (n > SEND_ANYWAY_MAX) return bad("sendAnywayReason", `Keep the reason to ${SEND_ANYWAY_MAX} characters or fewer.`);
      return { ok: true, params: { sendAnyway: true, sendAnywayReason: r } };
    }
    case "reschedule": {
      const at = (i.at ?? "").trim();
      const placement = i.placement;
      const ap = post?.approvedSchedule ?? null;
      const atChanges = at !== "" && (!ap?.scheduledAt || Date.parse(at) !== Date.parse(ap.scheduledAt));
      const placementChanges = Array.isArray(placement) && placement.length > 0 && !(ap && placement.length === ap.placement.length && placement.every((n) => ap.placement.includes(n)));
      if (at !== "" && Number.isNaN(Date.parse(at))) return bad("at", "Give a real date and time.");
      if (!atChanges && !placementChanges) return bad("at", "Give a new date or time, or a different placement.");
      return { ok: true, params: { ...(atChanges ? { at } : {}), ...(placementChanges ? { placement } : {}) } };
    }
    case "mark_live": {
      const url = (i.url ?? "").trim();
      if (url === "") return bad("url", "Paste the link to the post.");
      if (!isHttpUrl(url)) return bad("url", "The link must start with http:// or https://.");
      const at = (i.at ?? "").trim();
      if (at !== "" && Number.isNaN(Date.parse(at))) return bad("at", "Give a real date and time.");
      return { ok: true, params: { url, ...(at ? { at } : {}) } };
    }
    case "follow_up": {
      const n = (i.note ?? "").trim();
      if (len(n) > FOLLOW_UP_NOTE_MAX) return bad("note", `Keep the note to ${FOLLOW_UP_NOTE_MAX} characters or fewer.`);
      return { ok: true, params: n ? { note: n } : {} };
    }
    default:
      return { ok: true, params: {} };
  }
}

// ── Who may do what (read off the fixture, from the read's own `actions[]`) ───────────────────────────────────────────────

/** The Cerbos action a fixture action needs on this post (unschedule: by how it was scheduled). */
export function cerbosKeyOf(action: string, scheduleVia: string | null): string | null {
  const a = F.actions.find((x) => x.action === action);
  if (!a || a.cerbosAction === undefined) return null;
  return typeof a.cerbosAction === "string" ? a.cerbosAction : a.cerbosAction[scheduleVia ?? "manual"] ?? null;
}

/** The Cerbos actions whose actors are exactly `record_client`'s (the officer and the two seat approvers: `manage` and `boost` too). A client-visible comment
 *  needs `record_client` on the post (BFF §63.8), and the read lists `record_client_*` only while the post is with the client, so the rest of the time the
 *  read's answer for one of its same-actor siblings is the server's answer for it. */
export const RECORD_CLIENT_KEYS: readonly string[] = Object.keys(F.cerbosActions).filter(
  (k) => !k.includes(":") && JSON.stringify(F.cerbosActions[k].actors) === JSON.stringify(F.cerbosActions.record_client.actors),
);

const allowedKeys = (post: Pick<PipelinePost, "actions" | "scheduleVia">): Set<string> =>
  new Set(post.actions.filter((a) => a.allowed).map((a) => cerbosKeyOf(a.action, post.scheduleVia)).filter((k): k is string => k !== null));

/** May the viewer write a comment the client sees (`social_post` · `record_client`)? The server decides on the write. */
export const canWriteClientComment = (post: Pick<PipelinePost, "actions" | "scheduleVia">): boolean => {
  const keys = allowedKeys(post);
  return RECORD_CLIENT_KEYS.some((k) => keys.has(k));
};
/** May the viewer edit the post's fields (`social_post` · `author`, the client's officer)? */
export const canAuthorPost = (post: Pick<PipelinePost, "actions" | "scheduleVia">): boolean => allowedKeys(post).has("author");
/** May the viewer write suggestions (`proofread`, a copywriter)? */
export const canSuggest = (post: Pick<PipelinePost, "actions" | "scheduleVia">): boolean => allowedKeys(post).has("proofread");
/** May the viewer work on the designs (`design`, the client's designer)? */
export const canDesignPost = (post: Pick<PipelinePost, "actions" | "scheduleVia">): boolean => allowedKeys(post).has("design");

// ── Fields: which are editable in which status (fixture `editRules`) ───────────────────────────────────────────────────────

export interface FieldSpec { key: string; label: string; kind: "text" | "longtext" | "format" | "networks" | "datetime" | "hashtags" | "musthaves" | "rawassets"; tab: "post" | "brief"; max?: number }

/** The page's field rows, in order. Every editable field of the fixture has one (the test pins it). */
export const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "title", label: "Title", kind: "text", tab: "post", max: 200 },
  { key: "format", label: "Format", kind: "format", tab: "post" },
  { key: "caption", label: "Caption", kind: "longtext", tab: "post", max: 5000 },
  { key: "onAssetText", label: "Text on the image", kind: "text", tab: "post", max: 500 },
  { key: "cta", label: "Call to action", kind: "text", tab: "post", max: 120 },
  { key: "hashtags", label: "Hashtags", kind: "hashtags", tab: "post" },
  { key: "scheduledAt", label: "Date and time", kind: "datetime", tab: "post" },
  { key: "placement", label: "Networks", kind: "networks", tab: "post" },
  { key: "mustHaves", label: "Must-haves", kind: "musthaves", tab: "post" },
  { key: "pillar", label: "Pillar", kind: "text", tab: "brief", max: 60 },
  { key: "angle", label: "Angle", kind: "longtext", tab: "brief", max: 500 },
  { key: "objective", label: "Objective", kind: "text", tab: "brief", max: 200 },
  { key: "keyMessage", label: "Key message", kind: "longtext", tab: "brief", max: 500 },
  { key: "visualDirection", label: "Visual direction", kind: "longtext", tab: "brief", max: 2000 },
  { key: "rawAssets", label: "Reference images", kind: "rawassets", tab: "brief" },
];

export const MUST_HAVES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "logo", label: "Logo" }, { key: "brand_colours", label: "Brand colours" }, { key: "brand_fonts", label: "Brand fonts" },
  { key: "contact_info", label: "Contact information" }, { key: "handle_and_tags", label: "Handle and tags" }, { key: "mandatory_words", label: "Mandatory words" },
  { key: "no_forbidden_claims", label: "No forbidden claims" }, { key: "price_terms_checked", label: "Price and terms checked" }, { key: "location_tag", label: "Location tag" },
  { key: "hashtag_set", label: "Hashtag set" },
];

/** The copy fields the Copywriter may suggest on (fixture `fieldGroups.suggestible`). */
export const SUGGESTIBLE_FIELDS: readonly string[] = F.fieldGroups.suggestible;

/** The fields the post's status lets the officer write (the fixture's first matching `editRules` row, as the server reads it). */
export function editableFieldsOf(post: Pick<PipelinePost, "pipelineStatus" | "change">): { fields: string[]; copyLog: boolean } {
  const s = post.pipelineStatus;
  const kase = s === "changes" ? post.change?.case ?? null : null;
  for (const r of F.editRules) {
    const statusOk = r.status === "any other" || r.status === s;
    const caseOk = r.changeCases === undefined || (kase !== null && r.changeCases.includes(kase));
    if (!statusOk || !caseOk) continue;
    return { fields: [...new Set([...r.fieldGroups.flatMap((g) => F.fieldGroups[g] ?? []), ...(r.alsoFields ?? [])])], copyLog: r.copyLog === true };
  }
  return { fields: [], copyLog: false };
}

/** Why a field is read-only at this step, in words. */
export function lockedWords(post: Pick<PipelinePost, "pipelineStatus" | "scheduleVia">, field: string): string {
  const s = post.pipelineStatus;
  if (s === "live") return "The post is live.";
  if (s === "client") return "The client is looking at it.";
  if ((field === "scheduledAt" || field === "placement") && (s === "approved" || s === "scheduled")) return "Use Reschedule: the client will be asked again.";
  if (field === "scheduledAt" || field === "placement") return `The date and the networks are fixed at ${statusLabel(s)}.`;
  if (s === "blocked") return "The post is blocked.";
  return `It cannot be changed at ${statusLabel(s)}.`;
}

// ── The stepper (plan §1: eight steps) ───────────────────────────────────────────────────────────────────────────────────────

/** The eight steps people see. The statuses are the fixture's; a step names the statuses it shows (`socialPipeline.test.ts` pins that together they are
 *  every status of the fixture but the two side branches, once each, in the fixture's order). */
export const STEPS: ReadonlyArray<{ key: string; label: string; statuses: readonly string[] }> = [
  { key: "draft", label: "Draft", statuses: ["planned", "drafting"] },
  { key: "proofread", label: "Proofread", statuses: ["proofread"] },
  { key: "hod", label: "HoD approval", statuses: ["hod"] },
  { key: "design", label: "Creative", statuses: ["design"] },
  { key: "final", label: "Final check", statuses: ["final"] },
  { key: "client", label: "Client", statuses: ["client"] },
  { key: "schedule", label: "Schedule", statuses: ["approved", "scheduled"] },
  { key: "live", label: "Live", statuses: ["live"] },
];
/** The two statuses that sit beside the line, not on it. */
export const SIDE_STATUSES: readonly string[] = ["changes", "blocked"];

/** Where the post is on the stepper, and the side branch it is on (changes or blocked), if any. A post in changes sits at the step of whoever holds it
 *  (the officer: Draft; the designer: Creative); a blocked post sits at the step it was blocked from. */
export function stepOf(post: Pick<PipelinePost, "pipelineStatus" | "change" | "block" | "scheduleVia" | "creativeState">): { index: number; side: "changes" | "blocked" | null } {
  const at = (status: string): number => STEPS.findIndex((s) => s.statuses.includes(status));
  const changed = (kase: string | null): number => {
    const holder = scpHolderOf({ pipelineStatus: "changes", changeCase: kase });
    return at(holder === "designer" ? "design" : "drafting");
  };
  const s = post.pipelineStatus;
  if (s === "changes") return { index: changed(post.change?.case ?? null), side: "changes" };
  if (s === "blocked") {
    const from = post.block?.from ?? "drafting";
    return { index: from === "changes" ? changed(post.change?.case ?? null) : at(from), side: "blocked" };
  }
  return { index: at(s), side: null };
}

/** The status chip's words: the step, and for a change or a block who asked or what we wait on. */
export function statusChipText(post: Pick<PipelinePost, "pipelineStatus" | "change" | "block">): string {
  const s = post.pipelineStatus;
  if (s === "changes" && post.change) {
    const by = ({ copywriter: "the copywriter", hod: "the HoD", final: "the final check", client: "the client" } as Record<string, string>)[post.change.by] ?? post.change.by;
    return `Changes asked by ${by}: ${post.change.kind === "design" ? "design" : "copy"}`;
  }
  if (s === "blocked" && post.block) return `Blocked: waiting on ${(WAITING_ON_LABEL[post.block.waitingOn] ?? post.block.waitingOn).toLowerCase()}`;
  return statusLabel(s);
}

/** The phase's label from the twin (Brief, In production, With client, Client changes, Client approved, Posted). */
export const phaseText = (phase: string | null): string => (phase ? scpPhaseLabel(phase) : "");

// ── The image ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PostImage { src: string; alt: string; /** The file a pin sits on; null when none of the post's files is stored yet. */ fileId: string | null; from: "design" | "reference" }

/**
 * The picture the page shows, and the file a pin may sit on. A pin needs a file of the post (a design's stored file: the server refuses any other,
 * 400 `{field: "anchor"}`), and a design's file exists only once the final check sent it to the client. Before that the page shows what there is (the
 * latest design's asset, else the first reference image) and says pins come later.
 * `demo`: DEMO_MODE stores no bytes, so the download routes would answer a text note; the page then shows the reference image the demo store holds.
 */
export function postImage(post: Pick<PipelinePost, "title" | "designs" | "rawAssets">, opts: { demo?: boolean } = {}): PostImage | null {
  const designs = [...post.designs].sort((a, b) => a.position - b.position);
  const pinFile = designs.find((d) => d.fileId)?.fileId ?? null;
  const reference = post.rawAssets.find((a) => /^(data:image\/|https?:\/\/)/i.test(a.url));
  if (!opts.demo) {
    const stored = designs.find((d) => d.fileId);
    if (stored?.fileId) return { src: `/api/files/${encodeURIComponent(stored.fileId)}`, alt: `Design for ${post.title}`, fileId: stored.fileId, from: "design" };
    const withAsset = designs.find((d) => d.asset?.versionId);
    if (withAsset?.asset) return { src: `/api/creative-assets/${encodeURIComponent(withAsset.asset.versionId)}`, alt: `Design for ${post.title}`, fileId: null, from: "design" };
  }
  if (reference) return { src: reference.url, alt: `Reference image for ${post.title}`, fileId: opts.demo ? pinFile : null, from: "reference" };
  return null;
}

// ── History and the copy log, in words ──────────────────────────────────────────────────────────────────────────────────────

const ACTIVITY_WORDS: Readonly<Record<string, string>> = {
  create: "created the post", start_draft: "started the draft", accept_suggestion: "accepted a suggestion", send_to_proofread: "sent it to proofread",
  approve_copy: "approved the copy", return_copy: "returned the copy with edits", approve_for_design: "approved it for design", hod_changes: "asked for changes",
  resend: "sent it back for approval", start_design: "started the design", submit_design: "submitted the design for the final check", final_approve: "sent it to the client",
  final_changes: "asked for changes at the final check", client_approve: "approved it", client_change: "asked for changes", client_undo: "took the decision back",
  record_client_approve: "recorded the client's approval", record_client_change: "recorded the client's change request", schedule: "scheduled it in Meta",
  schedule_publisher: "scheduled it through the publisher", unschedule: "unscheduled it", reschedule: "rescheduled it, so the client is asked again",
  mark_live: "marked it live", block: "blocked it", resolve: "resolved the block", follow_up: "followed up", discard: "discarded it", archive: "archived it",
  edit: "edited the post", suggest: "suggested copy", add_design: "added a design", remove_design: "removed a design", changed_after_client: "changed it after the client approved, so it went back to the client",
};
export const activityWords = (action: string): string => ACTIVITY_WORDS[action] ?? action.replace(/_/g, " ");

/** "Komang Lestari sent it to proofread (Draft to Proofread)", with the agent, the channel and the portal where they apply. */
export function historyLine(h: HistoryRow): { who: string; what: string; move: string | null } {
  const who = h.viaPortal ? "The client" : h.by?.name || "Someone";
  let what = activityWords(h.action);
  if (h.recorded) what += ` (by ${CHANNEL_LABEL[h.recorded.channel] ?? h.recorded.channel})`;
  if (h.viaPortal) what += " in the portal";
  if (h.agent) what += `, with ${h.agent}`;
  const move = h.from && h.to && h.from !== h.to ? `${statusLabel(h.from)} to ${statusLabel(h.to)}` : null;
  return { who, what, move };
}

/** A copy-log value for display. */
export function logValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (Array.isArray(v)) return v.length ? v.map((x) => `#${String(x)}`).join(" ") : "empty";
  return String(v);
}

export const NETWORKS = ALLOCATION_NETWORKS;
export const networkLabel = (n: string): string => NETWORK_LABEL[n] ?? n;
export const SCP_STATUS_LIST = SCP_STATUSES;
export const actionsExistingFor = scpActionsFromStatus;

// ── Date and time in the display zone (hydration-safe, the same zone as every other date on screen) ─────────────────────────

function partsIn(zone: string, ms: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/** An instant as the value of a `datetime-local` input, in the display zone ("2026-10-23T09:30"); "" for none. */
export function isoToZoneInput(iso: string | null | undefined, zone: string = DISPLAY_TZ): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const p = partsIn(zone, ms);
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${z(p.y, 4)}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

/** The inverse: a `datetime-local` value read in the display zone, as an ISO instant; "" when it is not a date and time. */
export function zoneInputToIso(local: string, zone: string = DISPLAY_TZ): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return "";
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // The zone's offset at that wall time: guess the instant, read the wall clock it shows there, move by the difference; twice settles across a DST edge.
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = partsIn(zone, guess);
    guess += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  const back = partsIn(zone, guess);
  if (Date.UTC(back.y, back.mo - 1, back.d, back.h, back.mi) !== wall) return ""; // a wall time that does not exist (the DST gap)
  return new Date(guess).toISOString();
}

/** A new action id for each click (BFF §63.0 Idempotency). */
export function newActionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 3) | 8).toString(16);
  });
}

/** Hand-off check codes of the fixture, in its order (the hard ones first). The dialog lists the read's `checks[]`; this is what the test compares. */
export const CHECK_CODES: readonly string[] = [...F.requiredToSend, ...F.handoffChecks].map((c) => c.code);
