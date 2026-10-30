// SCP-1b — the stage machine's pure core (FRONTEND-BFF-CONTRACT §63.3, plan §4.3). No I/O: no database, no Cerbos,
// no clock. Phase 2's service feeds it real rows, real Cerbos answers and the facts its guards need; the tests feed it
// plain objects. What it answers is everything one transaction needs to write.
//
// ── THE FIXTURE IS THE CONTRACT ────────────────────────────────────────────────────────────────────────────────────
// Statuses, phases, holders, the engine-status mapping, every transition, the edit rules, the guard order and the
// refusal codes are read from `SCP` (`fixture.ts`). Code here is only:
//   - the implementation of each guard, keyed by the fixture's guard name;
//   - the implementation of each column effect, keyed by the fixture's effect name (I/O effects are returned by name
//     for phase 2 to run);
//   - the body validators, keyed by the fixture's action and param names;
//   - the interpretation of the few fixture values that are prose. Each is pinned below as `PROSE.*`, verbatim, and
//     `assertMachineCoverage()` refuses to load when the fixture's text differs, so a fixture edit forces a review of
//     the code that reads it.
// A fixture guard, effect, param or condition with no implementation also refuses to load. Nothing is skipped.
//
// ── THE ORDER OF CHECKS ────────────────────────────────────────────────────────────────────────────────────────────
// `decide()` runs the fixture's `commonGuards` in their `order`, each step by its guard name (BFF §63.3.2):
// action_known, post_exists, post_in_pipeline, replay_of_last_action_id, post_not_archived,
// not_unattended_automation, maker_checker, cerbos, expected_status_matches, status_in_from, params_valid,
// action_guards. Then it computes the target and the column changes. The Cerbos call itself is the caller's: the core
// says which actions to ask (`cerbosChecksFor`) and maps each denial to its refusal code.
import { isNetwork } from "../media-rules";
import { SCP, isCodeToken, scpAction, scpChangeCase, type ScpAction, type ScpWhen } from "./fixture";
import {
  decideSoft, failingRequiredToSend, validateSendAnyway, MUST_HAVE_KEYS,
  type Blocker, type HandoffInput, type RawAsset,
} from "./handoff-checks";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** One stored suggestion (BFF §63.1 `social_posts.suggestions`: `{<field>: {value, base, by, at}}`). */
export interface Suggestion {
  value: unknown;
  base: unknown;
  by: string;
  at: string;
}

/** A pipeline post as the machine sees it. Content fields carry the fixture's `fieldGroups` names (camelCase); the
 *  rest are the §63.1 columns in camelCase. `postStateFromRow` builds one from a `social_posts` row. */
export interface PipelinePostState {
  id: string;
  /** NULL: a Composer post (409 `not_a_pipeline_post`). */
  pipelineStatus: string | null;
  deleted: boolean;
  archived: boolean;
  authorId: string | null;
  changeBy: string | null;
  changeKind: string | null;
  returnTo: string | null;
  changeNote: string | null;
  changedOnly: boolean;
  copyBefore: Record<string, unknown> | null;
  blockedFrom: string | null;
  blockReason: string | null;
  blockWaitingOn: string | null;
  blockedAt: string | null;
  creativeSource: string | null;
  creativeState: string | null;
  scheduleVia: string | null;
  clientFirstSentAt: string | null;
  lastActionId: string | null;
  // content (fixture fieldGroups)
  title: string;
  format: string | null;
  pillar: string | null;
  angle: string | null;
  objective: string | null;
  keyMessage: string | null;
  visualDirection: string | null;
  rawAssets: RawAsset[];
  placement: string[];
  scheduledAt: string | null;
  mustHaves: string[];
  caption: string;
  onAssetText: string | null;
  cta: string | null;
  hashtags: string[];
  /** Keyed by column name (`caption`, `on_asset_text`, `cta`, `hashtags`), as stored. */
  suggestions: Record<string, Suggestion>;
}

/** The facts about the caller the core decides on. An agent acting for a person arrives as that person (SCP-Q17), so
 *  these are the person's. */
export interface StagePrincipal {
  /** `users.id`: written as `author_id`, `archived_by`, a suggestion's `by`, a skipped check's `by`. */
  userId?: string;
  /** `users.kind` is `automation` or `bot`: no person behind the call. */
  isAutomation: boolean;
  /** The post's `author_id`. */
  isAuthor: boolean;
  /** The engagement's `owner_id` (the client's officer). */
  isOfficer: boolean;
  /** The system: the publisher's result through the dispatch path (fixture `actors.publisher`). Only an action whose
   *  `actors` names `publisher` accepts it; it skips the person checks (automation, maker/checker, Cerbos). */
  isPublisher?: boolean;
}

/** The facts the action guards and column effects read. Each is optional because each action needs only some; an
 *  action that needs a fact it was not given throws (apply mode) or skips that guard (probe mode). */
export interface StageFacts {
  /** The transaction's clock. Required to apply anything. */
  now?: Date;
  // create
  cycleExists?: boolean;
  cycleId?: string;
  engagementId?: string;
  // approve_for_design
  engagementCreativeSource?: string;
  creativesUnitExists?: boolean;
  // designs
  assetExists?: boolean;
  designExists?: boolean;
  designCount?: number;
  /** The live designs that are only a link (nothing stored to show the client). */
  unstoredDesignIds?: string[];
  // variants and accounts
  /** The client's accounts per network: how many `social_accounts` rows the client has on each. */
  accountsByNetwork?: Record<string, number>;
  /** SCP-Sa3: the networks of the accounts this action would dispatch through, split by KIND (`social_accounts.simulated`).
   *  `final_approve`: the client's accounts on the post's placement; `schedule_publisher`: the accounts of the post's live
   *  variants. Already scoped by the caller, so the guard only asks whether both lists have a network. */
  accountKinds?: { simulated: string[]; real: string[] };
  /** The post's `reviewHash` now (BFF §63.6.2). */
  reviewHash?: string | null;
  everyReviewPending?: boolean;
  /** The statuses of the post's live variants, for the engine-status overrides. */
  variantStatuses?: string[];
  anyVariantPublishing?: boolean;
  /** Per variant, the media validator's errors; empty when every variant passes. */
  mediaFailures?: Array<{ variantId: string; errors: unknown[] }>;
  publisherAvailable?: boolean;
  /** The date, time and placement the client approved. */
  approvedSchedule?: { scheduledAt: string | null; placement: string[] } | null;
  /** mark_live by the publisher: the first published variant's link. */
  publisherLiveUrl?: string;
  // client_undo
  decidedByThisContact?: boolean;
  withinUndoWindow?: boolean;
  nothingHappenedSince?: boolean;
  /** The post's `creative_state` before the client's decision (restored by client_undo). */
  preDecisionCreativeState?: string | null;
  // follow_up
  callerHoldsPost?: boolean;
  /** The last follow-up of the current holder on this post (by anyone: the holder hears once a day); null when none. */
  lastFollowUpAt?: string | null;
  // send_to_proofread
  handoff?: { platforms: string[]; hashtagSets: Array<{ name: string; tags: string[] }>; readyBy: string | null; timeZone?: string };
}

/** The Cerbos decisions the caller made, keyed by the fixture's Cerbos action name (`author`, `approve`, `cancel`,
 *  `create`, `portal:approve_post`, …). `cerbosChecksFor` says which to ask. */
export type CerbosDecisions = Record<string, boolean>;

export interface StageContext {
  /** The fixture action name. */
  action: string;
  /** The body, less `action`, `expectedStatus` and `actionId`. */
  params: Record<string, unknown>;
  /** The post, or null when none was found (or, for `create`, when the supplied `id` is new). */
  post: PipelinePostState | null;
  principal: StagePrincipal;
  cerbos: CerbosDecisions;
  expectedStatus?: string;
  actionId?: string;
  facts: StageFacts;
  /** `portal`: the client's routes (BFF §63.9). Default `staff`. */
  surface?: "staff" | "portal";
  /** `probe`: decide for `actions[]` (BFF §63.6.2): the steps that need no body, no replay, no effects.
   *  `gate`: every common step BEFORE the action's own guards (replay, Cerbos, expectedStatus, from, the body), and no
   *  facts. The route runs it outside its transaction, so a refused caller is answered (and audited) before any row is
   *  locked; it then re-runs the whole decision under the lock (BFF §63.3.2 step 12). */
  mode?: "apply" | "probe" | "gate";
  /** Routes without a body (DELETE …/designs/:id, DELETE …/suggestions/:field) pass false. Default true. */
  requireExpectedStatus?: boolean;
}

export interface StageRefusal {
  ok: false;
  http: number;
  code: string;
  field?: string;
  detail?: Record<string, unknown>;
  blockers?: Blocker[];
  retryAfterSeconds?: number;
  /** A 403 that keeps today's generic `not authorized: …` body (`authorize()`'s), not a code of its own. */
  generic?: boolean;
  /** The commonGuards step (or action guard) that refused. */
  guard: string;
}

export interface CopyLogEntry {
  /** Column name: caption, on_asset_text, cta, hashtags (BFF §63.1 `social_post_copy_edits.field`). */
  field: string;
  before: unknown;
  after: unknown;
  via: "suggestion" | "fix";
  suggestedBy: string | null;
  /** The post's status at the time. */
  stage: string;
}

export interface StageApplied {
  ok: true;
  alreadyApplied: boolean;
  action: string;
  /** The status before (null for create). */
  from: string | null;
  /** The status after, or the pseudo target (`deleted`, `archived`). */
  to: string | null;
  changeCase: { before: string | null; after: string | null };
  /** The phase and engine status after. */
  phase: string | null;
  engineStatus: string | null;
  /** Column changes for the one UPDATE (or INSERT, for create), keyed by `social_posts` column name. */
  set: Record<string, unknown>;
  /** To append to `skipped_checks` (append-only, BFF §63.1). */
  appendSkippedChecks: { codes: string[]; reason: string; by: string; at: string } | null;
  /** Rows for `social_post_copy_edits`. */
  copyLog: CopyLogEntry[];
  /** The I/O effects phase 2 runs, by fixture name, conditions resolved, in fixture order. */
  effects: string[];
  /** The effects already realized in `set`. */
  columnEffects: string[];
  /** The activity row's metadata core (BFF §63.14); phase 2 adds `cycleId`, `engagementId`, `viaPortal`, `via`. */
  activity: { verb: string; metadata: Record<string, unknown> };
  warnings: string[];
  /** The post after, as the machine sees it (null after a discard). */
  next: PipelinePostState | null;
}

export type StageResult = StageRefusal | StageApplied;

/** A broken invariant: unreachable through the database's CHECKs, or a caller that skipped a required input. */
export class ScpMachineError extends Error {}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The prose the fixture holds, and how it is read
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Every fixture value that is prose and that this file interprets, verbatim. `assertMachineCoverage` compares each
 *  with the fixture at load, and machine.test.ts pins them again. */
export const PROSE = {
  /** `phaseOf.changes` → the change case's `phase`. */
  phaseOfChanges: "from the change case: see changeCases[].phase",
  /** `holders.changes` → the change case's `holder`. */
  holderChanges: "from the change case: see changeCases[].holder",
  /** `holders.scheduled` → `officer` for `scheduleVia` manual, `publisher` for publisher. */
  holderScheduled: "officer when scheduleVia is 'manual'; publisher when 'publisher'",
  /** `holders.blocked` → the post's `block_waiting_on`. */
  holderBlocked: "from blockWaitingOn",
  /** `primaryAction.design` → `start_design` while `creative_state` is `not_started`, else `submit_design`. */
  primaryDesign: "start_design while creativeState is 'not_started', else submit_design",
  /** `resolve.to` → `{from: "blockedFrom"}`: the post's `blocked_from`. */
  resolveToFrom: "blockedFrom",
  /** start_design's one effect: not_started → in_progress; revision stays; in_progress is a replay. */
  startDesignEffect: "creative_state: not_started becomes in_progress; revision stays revision; in_progress replays as alreadyApplied",
  /** `cerbosActions.create.refusal`: the generic `authorize()` 403. */
  createRefusal: "403 as today",
  /** `cerbosActions["portal:approve_post"].refusal`: a portal post outside the caller's scope is 404. */
  portalPostRefusal: "404 outside the portal scope",
  /** `portalStatusRefusal`: on the portal, a visible post outside `from` is 409 `post_not_with_client`. */
  portalStatusRefusal: "On the portal routes a post the caller may not see is 404 post_not_found, and a visible post outside the action's 'from' is 409 post_not_with_client (not invalid_transition).",
  /** The last `editRules` row's status. */
  editAnyOther: "any other",
  /** `commonGuards[cerbos].refusal`. */
  commonCerbosRefusal: "the cerbosAction's refusal code; for reschedule's extra cancel check, cancel_required; for create's author-or-approve check, not_officer_or_approver",
  /** `commonGuards[params_valid].refusal`. */
  commonParamsRefusal: "missing_field or invalid_field, with field",
  /** `commonGuards[action_guards].refusal`. */
  commonActionGuardsRefusal: "the action's own codes, in the order listed",
  /** `commonGuards[replay_of_last_action_id].outcome`. */
  replayOutcome: "200 alreadyApplied: the same actionId as the post's last applied action",
  /** `phaseRule`: restated as code in `phaseOf`; the equivalence it states is proved by the test. */
  phaseRule: "phase = phaseOf[status]; for status 'changes', phase = changeCases[the post's (changeBy, changeKind, returnTo)].phase. Equivalently: changeBy 'client' gives client_changes; else returnTo 'final' or changeKind 'design' gives in_production; else brief.",
} as const;

/** BFF §63.10: `approved_time_passed` "when that time is more than 5 minutes in the past". */
export const APPROVED_TIME_GRACE_MS = 5 * 60 * 1000;

/** The follow-up guard's window, from its fixture name `once_per_holder_per_24h`. */
export const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The mappings
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

type ChangeColumns = Pick<PipelinePostState, "changeBy" | "changeKind" | "returnTo">;

/** The post's change case key, or null when it has none. A (changeBy, changeKind, returnTo) the fixture does not know
 *  is unreachable (the database CHECK allows the fixture's six only) and throws. */
export function changeCaseOf(post: ChangeColumns): string | null {
  if (post.changeBy === null && post.changeKind === null && post.returnTo === null) return null;
  const c = SCP.changeCases.find((x) => x.changeBy === post.changeBy && x.changeKind === post.changeKind && x.returnTo === post.returnTo);
  if (!c) throw new ScpMachineError(`no change case for (${post.changeBy}, ${post.changeKind}, ${post.returnTo})`);
  return c.key;
}

function requireCase(post: ChangeColumns, status: string): string {
  const cc = changeCaseOf(post);
  if (cc === null) throw new ScpMachineError(`status '${status}' needs a change case`);
  return cc;
}

export type StatusPost = ChangeColumns & Pick<PipelinePostState, "pipelineStatus" | "scheduleVia" | "blockWaitingOn" | "creativeState">;

/** The phase people see (fixture `phaseOf`, `changes` by the change case). */
export function phaseOf(post: Pick<StatusPost, "pipelineStatus" | "changeBy" | "changeKind" | "returnTo">): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  const v = SCP.phaseOf[s];
  if (v === undefined) throw new ScpMachineError(`unknown status '${s}'`);
  if (v === PROSE.phaseOfChanges) return scpChangeCase(requireCase(post, s))!.phase;
  return v;
}

/** Who holds the post now, as an actor role (fixture `holders`), or null when nobody does (live). */
export function holderOf(post: StatusPost): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  if (!(s in SCP.holders)) throw new ScpMachineError(`unknown status '${s}'`);
  const v = SCP.holders[s];
  if (v === null) return null;
  if (v === PROSE.holderChanges) return scpChangeCase(requireCase(post, s))!.holder;
  if (v === PROSE.holderScheduled) {
    if (post.scheduleVia === "manual") return "officer";
    if (post.scheduleVia === "publisher") return "publisher";
    throw new ScpMachineError("a scheduled post has no scheduleVia");
  }
  if (v === PROSE.holderBlocked) {
    if (!post.blockWaitingOn) throw new ScpMachineError("a blocked post has no blockWaitingOn");
    return post.blockWaitingOn;
  }
  return v;
}

/** `social_posts.status` of a pipeline post: byPipelineStatus, then the first matching override, top to bottom. */
export function engineStatusOf(post: Pick<PipelinePostState, "pipelineStatus">, variantStatuses: string[], archived: boolean): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  let status = SCP.engineStatus.byPipelineStatus[s];
  if (status === undefined) throw new ScpMachineError(`unknown status '${s}'`);
  for (const o of SCP.engineStatus.overrides) {
    if (overrideMatches(o.when, s, variantStatuses, archived)) {
      status = o.engineStatus;
      break;
    }
  }
  return status;
}

function overrideMatches(when: ScpWhen, status: string, variantStatuses: string[], archived: boolean): boolean {
  return Object.entries(when).every(([k, v]) => {
    if (k === "archived") return archived === v;
    if (k === "pipelineStatus") return status === v;
    if (k === "anyVariantStatus") return variantStatuses.includes(String(v));
    throw new ScpMachineError(`unknown override key '${k}'`);
  });
}

/** The statuses whose engine status depends on the variants (an override names them with `anyVariantStatus`). */
export const STATUSES_READING_VARIANTS: ReadonlySet<string> = new Set(
  SCP.engineStatus.overrides.filter((o) => "anyVariantStatus" in o.when && "pipelineStatus" in o.when).map((o) => String(o.when.pipelineStatus)),
);

/** The fixture's primary action for the post's status (the stepper's main button). */
export function primaryActionOf(post: StatusPost): string | null {
  const s = post.pipelineStatus;
  if (s === null) return null;
  const v = SCP.primaryAction[s];
  if (v === undefined) throw new ScpMachineError(`unknown status '${s}'`);
  if (typeof v === "string") {
    if (v === PROSE.primaryDesign) return post.creativeState === "not_started" ? "start_design" : "submit_design";
    return v;
  }
  return v[requireCase(post, s)] ?? null;
}

/** Whether the post's status (and change case) is in one of the action's `from` entries. `decidedBy` is the action's
 *  own guard (`own_decision`), not part of the status check. */
export function fromMatches(action: ScpAction, post: Pick<StatusPost, "pipelineStatus" | "changeBy" | "changeKind" | "returnTo">): boolean {
  const s = post.pipelineStatus;
  if (s === null) return false;
  return action.from.some((f) => {
    if (f.status !== s) return false;
    if (f.changeCase === undefined) return true;
    const cc = changeCaseOf(post);
    return cc !== null && f.changeCase.includes(cc);
  });
}

/** The post-machine actions whose `from` matches the post (create excluded: it has no from). */
export function actionsFromStatus(post: StatusPost): string[] {
  return SCP.actions.filter((a) => a.from.length > 0 && fromMatches(a, post)).map((a) => a.action);
}

export interface EditableFields {
  fields: string[];
  copyLog: boolean;
  refusal: string | null;
}

/** The fields an edit may write in the post's status (fixture `editRules`, first matching row). */
export function editableFields(post: StatusPost): EditableFields {
  const s = post.pipelineStatus;
  const cc = s === "changes" ? changeCaseOf(post) : null;
  for (const r of SCP.editRules) {
    const statusOk = r.status === PROSE.editAnyOther || r.status === s;
    const caseOk = r.changeCases === undefined || (cc !== null && r.changeCases.includes(cc));
    if (!statusOk || !caseOk) continue;
    const fields = [...new Set([...r.fieldGroups.flatMap((g) => SCP.fieldGroups[g]), ...(r.alsoFields ?? [])])];
    return { fields, copyLog: r.copyLog === true, refusal: r.refusal ?? null };
  }
  throw new ScpMachineError("editRules has no row for this post (the fixture's last row should be 'any other')");
}

// ── When-clauses on `to` and `setsChangeCase` ──────────────────────────────────────────────────────────────────────

/** Where each `when` key is read: the post before the action, or the body. */
const WHEN_SOURCES: Record<string, "post" | "params"> = { changedOnly: "post", returnTo: "post", changeKind: "params" };

function whenMatches(when: ScpWhen, post: PipelinePostState, params: Record<string, unknown>): boolean {
  return Object.entries(when).every(([k, v]) => {
    const src = WHEN_SOURCES[k];
    if (src === "post") return (post as unknown as Record<string, unknown>)[k] === v;
    if (src === "params") return params[k] === v;
    throw new ScpMachineError(`unknown when key '${k}'`);
  });
}

export interface Target {
  /** The pipeline status after (unchanged for a pseudo target and for `to: null`). */
  status: string | null;
  /** `deleted` or `archived` (fixture `pseudoTargets`). */
  pseudo: string | null;
  /** The change case after. */
  changeCase: string | null;
}

/** Where an action takes the post. `post` is null only for create. */
export function targetOf(action: ScpAction, post: PipelinePostState | null, params: Record<string, unknown>): Target {
  const before = post?.pipelineStatus ?? null;
  const beforeCase = post ? changeCaseOf(post) : null;
  const to = action.to;
  let status: string | null;
  let pseudo: string | null = null;
  if (to === null) status = before;
  else if (typeof to === "string") {
    if (to in SCP.pseudoTargets) {
      status = before;
      pseudo = to;
    } else status = to;
  } else if (Array.isArray(to)) {
    if (!post) throw new ScpMachineError(`${action.action}: a conditional 'to' needs a post`);
    const hit = to.find((t) => whenMatches(t.when, post, params));
    if (!hit) throw new ScpMachineError(`${action.action}: no 'to' matches the post`);
    status = hit.status;
  } else {
    if (to.from !== PROSE.resolveToFrom) throw new ScpMachineError(`${action.action}: unknown 'to.from' '${to.from}'`);
    if (!post?.blockedFrom) throw new ScpMachineError(`${action.action}: the post has no blockedFrom`);
    status = post.blockedFrom;
  }

  let changeCase: string | null;
  const sc = action.setsChangeCase;
  if (typeof sc === "string") changeCase = sc;
  else if (Array.isArray(sc)) {
    if (!post) throw new ScpMachineError(`${action.action}: a conditional change case needs a post`);
    const hit = sc.find((x) => whenMatches(x.when, post, params));
    if (!hit) throw new ScpMachineError(`${action.action}: no change case matches`);
    changeCase = hit.changeCase;
  } else {
    // No change case of its own: a post that stays in (or is blocked out of) `changes` keeps its case; one that
    // leaves has none. The column effects must agree (checked in `decide`).
    changeCase = status === "changes" || status === "blocked" ? beforeCase : null;
  }
  return { status, pseudo, changeCase };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Cerbos: which actions to ask, and what a denial answers
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface CerbosRefusalCode {
  http: number;
  code: string;
  generic?: boolean;
}

export interface CerbosCheck {
  /** Every one must allow (`all`), or at least one (`anyOf`). */
  mode: "all" | "anyOf";
  actions: string[];
  refusal: CerbosRefusalCode;
}

/** The refusal a denial of one fixture Cerbos action answers. */
export function cerbosRefusalOf(cerbosAction: string): CerbosRefusalCode {
  const c = SCP.cerbosActions[cerbosAction];
  if (!c) throw new ScpMachineError(`unknown Cerbos action '${cerbosAction}'`);
  if (isCodeToken(c.refusal)) return { http: SCP.refusals[c.refusal].http, code: c.refusal };
  if (c.refusal === PROSE.createRefusal) return { http: 403, code: "not_authorized", generic: true };
  if (c.refusal === PROSE.portalPostRefusal) return { http: SCP.refusals.post_not_found.http, code: "post_not_found" };
  throw new ScpMachineError(`Cerbos action '${cerbosAction}' has a refusal this core cannot read: '${c.refusal}'`);
}

function scheduleViaKey(post: PipelinePostState | null): "manual" | "publisher" {
  // A post outside `scheduled` has no scheduleVia; unschedule then asks the by-hand action and fails at the status
  // check (409 invalid_transition) for the officer, 403 for anyone else.
  return post?.scheduleVia === "publisher" ? "publisher" : "manual";
}

/** The primary Cerbos action of an action for this post (unschedule: by the post's `scheduleVia`). */
export function primaryCerbosAction(action: ScpAction, post: PipelinePostState | null): string {
  if (typeof action.cerbosAction === "string") return action.cerbosAction;
  const name = action.cerbosAction[scheduleViaKey(post)];
  if (!name) throw new ScpMachineError(`${action.action}: no Cerbos action for scheduleVia`);
  return name;
}

/** The Cerbos checks an action needs on this post, in the order they are judged. */
export function cerbosChecksFor(action: ScpAction, post: PipelinePostState | null): CerbosCheck[] {
  const primary = primaryCerbosAction(action, post);
  const checks: CerbosCheck[] = [{ mode: "all", actions: [primary], refusal: cerbosRefusalOf(primary) }];
  const ex = action.extraCerbos as Record<string, string[]> | undefined;
  if (ex) {
    if (Array.isArray(ex.anyOf)) {
      if (!action.extraCerbosRefusal) throw new ScpMachineError(`${action.action}: anyOf needs extraCerbosRefusal`);
      checks.push({ mode: "anyOf", actions: ex.anyOf, refusal: { http: SCP.refusals[action.extraCerbosRefusal].http, code: action.extraCerbosRefusal } });
    } else {
      // Keyed by scheduleVia (reschedule: a publisher schedule also needs cancel). Each extra action answers its own
      // refusal (cancel → cancel_required).
      const via = post?.scheduleVia;
      for (const name of via && ex[via] ? ex[via] : []) checks.push({ mode: "all", actions: [name], refusal: cerbosRefusalOf(name) });
    }
  }
  return checks;
}

/** The flat list of Cerbos actions to ask for an action on this post. */
export function cerbosActionsToAsk(action: string, post: PipelinePostState | null): string[] {
  const a = scpAction(action);
  if (!a) return [];
  return [...new Set(cerbosChecksFor(a, post).flatMap((c) => c.actions))];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The body: one validator per fixture param
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type ParamProblem = { code: "missing_field" | "invalid_field"; field: string };
type ParamCheck = (name: string, value: unknown, all: Record<string, unknown>, env: { principal: StagePrincipal; post: PipelinePostState | null }) => ParamProblem | null;

const missing = (field: string): ParamProblem => ({ code: "missing_field", field });
const invalid = (field: string): ParamProblem => ({ code: "invalid_field", field });
const absent = (v: unknown) => v === undefined || v === null;
const textLen = (s: string) => [...s.trim()].length;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isIsoDateTime = (v: unknown): v is string => typeof v === "string" && ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v));
/** BFF §63.1: `live_url` and `link_url` are http(s), at most 500. */
export const isHttpUrl = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 500 && /^https?:\/\/[^\s]+$/i.test(v) && (() => { try { new URL(v); return true; } catch { return false; } })();

/** Text of `min..max` characters (trimmed, code points). Blank counts as absent. */
function textRule(min: number, max: number, required: boolean): ParamCheck {
  return (name, v) => {
    if (absent(v) || (typeof v === "string" && v.trim() === "" && min > 0)) return required ? missing(name) : null;
    if (typeof v !== "string") return invalid(name);
    const n = textLen(v);
    return n < min || n > max ? invalid(name) : null;
  };
}

function enumRule(values: string[], required: boolean): ParamCheck {
  return (name, v) => {
    if (absent(v) || v === "") return required ? missing(name) : null;
    return typeof v === "string" && values.includes(v) ? null : invalid(name);
  };
}

/** The regular prose shapes, read from the fixture rather than retyped: "1..2000, required", "0..500, optional" and
 *  "a|b|c, required". Anything else needs an explicit rule below. */
export function parseParamProse(prose: string): ParamCheck | null {
  let m = /^(\d+)\.\.(\d+), (required|optional)$/.exec(prose);
  if (m) return textRule(Number(m[1]), Number(m[2]), m[3] === "required");
  m = /^([a-z_]+(?:\|[a-z_]+)+), required$/.exec(prose);
  if (m) return enumRule(m[1].split("|"), true);
  return null;
}

const NETWORK_LIST: ParamCheck = (name, v) => {
  if (absent(v)) return null;
  if (!Array.isArray(v) || v.length === 0) return invalid(name);
  if (!v.every((n) => typeof n === "string" && isNetwork(n)) || new Set(v).size !== v.length) return invalid(name);
  return null;
};

const SUGGESTIBLE: ParamCheck = (name, v) => {
  if (absent(v) || v === "") return missing(name);
  return typeof v === "string" && SCP.fieldGroups.suggestible.includes(v) ? null : invalid(name);
};

const ANCHOR: ParamCheck = (name, v) => {
  if (absent(v)) return null;
  if (typeof v !== "object" || Array.isArray(v)) return invalid(name);
  const a = v as Record<string, unknown>;
  const frac = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (!frac(a.x) || !frac(a.y)) return invalid(name);
  if (a.fileId !== undefined && !isUuid(a.fileId)) return invalid(name);
  return null;
};

/** The explicit rules: the params whose fixture prose is not one of the regular shapes. Each is keyed by the action and
 *  param name and carries the fixture's prose verbatim; machine.test.ts pins that the fixture still says it. */
export const EXPLICIT_PARAM_RULES: Record<string, Record<string, { prose: string; check: ParamCheck }>> = {
  create: {
    id: { prose: "uuid, optional idempotency key", check: (n, v) => (absent(v) ? null : isUuid(v) ? null : invalid(n)) },
    title: { prose: "1..200", check: textRule(1, 200, true) },
    isExtra: { prose: "boolean, default false", check: (n, v) => (absent(v) || typeof v === "boolean" ? null : invalid(n)) },
    format: { prose: "optional", check: (n, v) => fieldValueProblem("format", v, n) },
    pillar: { prose: "optional", check: (n, v) => fieldValueProblem("pillar", v, n) },
    scheduledAt: { prose: "optional", check: (n, v) => fieldValueProblem("scheduledAt", v, n) },
    placement: { prose: "optional", check: (n, v) => fieldValueProblem("placement", v, n) },
  },
  edit: {
    fields: {
      prose: "only the fields editRules allows in the post's status",
      // The shape and each value here (400); whether the status allows the field is the guard (409 field_locked).
      check: (n, v) => {
        if (absent(v)) return missing(n);
        if (typeof v !== "object" || Array.isArray(v) || Object.keys(v as object).length === 0) return invalid(n);
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (!ALL_FIELDS.has(k)) return invalid(k);
          const p = fieldValueProblem(k, val, k);
          if (p) return p;
        }
        return null;
      },
    },
  },
  accept_suggestion: { field: { prose: "one of fieldGroups.suggestible", check: SUGGESTIBLE } },
  send_to_proofread: {
    sendAnyway: { prose: "boolean, default false", check: (_n, _v, all) => sendAnywayProblem(all, "sendAnyway") },
    sendAnywayReason: { prose: "10..500, required when sendAnyway", check: (_n, _v, all) => sendAnywayProblem(all, "sendAnywayReason") },
  },
  suggest: {
    field: { prose: "one of fieldGroups.suggestible", check: SUGGESTIBLE },
    value: {
      prose: "the suggested text, or null to drop the suggestion",
      check: (n, v, all) => {
        if (v === null) return null;
        if (v === undefined) return missing(n);
        const f = typeof all.field === "string" ? all.field : "";
        return SCP.fieldGroups.suggestible.includes(f) ? fieldValueProblem(f, v, n) : null;
      },
    },
  },
  add_design: {
    assetGroupId: {
      prose: "an Asset Library version group, or",
      check: (n, v, all) => {
        if (absent(v) && absent(all.linkUrl)) return missing(n);
        if (!absent(v) && !absent(all.linkUrl)) return invalid(n); // one or the other (BFF §63.1 CHECK)
        return absent(v) || isUuid(v) ? null : invalid(n);
      },
    },
    linkUrl: { prose: "an http(s) link", check: (n, v) => (absent(v) || isHttpUrl(v) ? null : invalid(n)) },
    linkSource: {
      prose: "own|client|stock|ai|unknown, with a link",
      check: (n, v, all) => {
        if (absent(all.linkUrl)) return absent(v) ? null : invalid(n); // a link's source, never an asset's
        return enumRule(["own", "client", "stock", "ai", "unknown"], true)(n, v, all, undefined as never);
      },
    },
    linkAiNote: {
      prose: "required when linkSource is 'ai'",
      check: (n, v, all) => {
        if (all.linkSource === "ai" && (absent(v) || (typeof v === "string" && v.trim() === ""))) return missing(n);
        if (absent(v)) return null;
        if (absent(all.linkUrl)) return invalid(n);
        return typeof v === "string" && textLen(v) <= 1000 ? null : invalid(n); // BFF §63.1: ≤ 1,000
      },
    },
    position: {
      prose: "1..20",
      check: (n, v) => (absent(v) ? null : Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20 ? null : invalid(n)),
    },
  },
  remove_design: { designId: { prose: "uuid", check: (n, v) => (absent(v) ? missing(n) : isUuid(v) ? null : invalid(n)) } },
  client_approve: { seenHash: { prose: "the reviewHash the client was shown", check: (n, v) => (absent(v) || v === "" ? missing(n) : typeof v === "string" ? null : invalid(n)) } },
  client_change: {
    anchor: { prose: "optional pin {x, y, fileId}", check: ANCHOR },
    seenHash: { prose: "the reviewHash the client was shown", check: (n, v) => (absent(v) || v === "" ? missing(n) : typeof v === "string" ? null : invalid(n)) },
  },
  record_client_change: { anchor: { prose: "optional pin", check: ANCHOR } },
  reschedule: {
    at: { prose: "ISO date-time, optional", check: (n, v) => (absent(v) ? null : isIsoDateTime(v) ? null : invalid(n)) },
    // "at least one of the two must change" is the something_changes guard (409 no_change), not the body.
    placement: { prose: "network list, optional; at least one of the two must change", check: NETWORK_LIST },
  },
  mark_live: {
    url: {
      prose: "http(s) link to the post, required from the officer",
      check: (n, v, _all, env) => {
        if (absent(v) || v === "") return env.principal.isPublisher ? null : missing(n);
        return isHttpUrl(v) ? null : invalid(n);
      },
    },
    at: { prose: "ISO date-time, default now", check: (n, v) => (absent(v) ? null : isIsoDateTime(v) ? null : invalid(n)) },
  },
};

function sendAnywayProblem(all: Record<string, unknown>, which: string): ParamProblem | null {
  const p = validateSendAnyway({ sendAnyway: all.sendAnyway, sendAnywayReason: all.sendAnywayReason });
  return p && p.field === which ? p : null;
}

/** The rule for one fixture param: explicit, else parsed from its prose. */
export function paramRule(action: string, param: string): ParamCheck {
  const ex = EXPLICIT_PARAM_RULES[action]?.[param];
  if (ex) return ex.check;
  const a = scpAction(action);
  const prose = a?.params[param];
  const parsed = prose !== undefined ? parseParamProse(prose) : null;
  if (!parsed) throw new ScpMachineError(`no rule for param ${action}.${param}`);
  return parsed;
}

// ── Field values (BFF §63.1, the social_posts columns) ───────────────────────────────────────────────────────────────

const ALL_FIELDS = new Set(Object.entries(SCP.fieldGroups).filter(([g]) => g !== "suggestible").flatMap(([, f]) => f));
const FORMATS = ["feed", "carousel", "reel", "story"]; // BFF §63.1 `format`
const ASSET_SOURCES = ["own", "client", "stock", "ai", "unknown"]; // BFF §63.1 `raw_assets[].source`

const optText = (max: number) => (v: unknown) => v === null || (typeof v === "string" && [...v].length <= max);

/** Each content field's value rule (BFF §63.1). */
const FIELD_VALUE_RULES: Record<string, (v: unknown) => boolean> = {
  title: (v) => typeof v === "string" && textLen(v) >= 1 && [...v].length <= 200,
  format: (v) => v === null || (typeof v === "string" && FORMATS.includes(v)),
  pillar: optText(60),
  angle: optText(500),
  objective: optText(200),
  keyMessage: optText(500),
  visualDirection: optText(2000),
  onAssetText: optText(500),
  cta: optText(120),
  caption: (v) => typeof v === "string" && [...v].length <= 5000,
  hashtags: (v) =>
    Array.isArray(v) && v.length <= 60 && v.every((t) => typeof t === "string" && t.trim() !== "" && !t.includes("#") && !/\s/.test(t)),
  rawAssets: (v) =>
    Array.isArray(v) &&
    v.length <= 10 &&
    v.every((a) => {
      if (typeof a !== "object" || a === null || Array.isArray(a)) return false;
      const r = a as Record<string, unknown>;
      if (r.url !== undefined && r.url !== null && typeof r.url !== "string") return false;
      if (r.label !== undefined && r.label !== null && typeof r.label !== "string") return false;
      if (typeof r.source !== "string" || !ASSET_SOURCES.includes(r.source)) return false;
      if (r.aiNote !== undefined && r.aiNote !== null && (typeof r.aiNote !== "string" || [...r.aiNote].length > 1000)) return false;
      return true;
    }),
  placement: (v) => Array.isArray(v) && v.every((n) => typeof n === "string" && isNetwork(n)) && new Set(v).size === v.length,
  scheduledAt: (v) => v === null || isIsoDateTime(v),
  mustHaves: (v) => Array.isArray(v) && v.every((k) => typeof k === "string" && MUST_HAVE_KEYS.includes(k)) && new Set(v).size === v.length,
};

function fieldValueProblem(field: string, v: unknown, reportAs: string): ParamProblem | null {
  if (v === undefined) return null;
  const rule = FIELD_VALUE_RULES[field];
  if (!rule) return invalid(reportAs);
  return rule(v) ? null : invalid(reportAs);
}

/**
 * The machine's own value rule for one content field (`FIELD_VALUE_RULES`, BFF §63.1), as a problem naming `field`, or null when the value
 * passes. The sheet import (BFF §63.23) validates every post field through this and restates no length or list of values of its own.
 */
export function contentFieldProblem(field: string, value: unknown): ParamProblem | null {
  return fieldValueProblem(field, value, field);
}

/** A content field's column name (camelCase → snake_case: keyMessage → key_message). */
export const columnOf = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const fieldOfColumn = (column: string): string => column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The action guards, one per fixture guard name
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface GuardEnv {
  action: ScpAction;
  post: PipelinePostState | null;
  params: Record<string, unknown>;
  facts: StageFacts;
  principal: StagePrincipal;
  probe: boolean;
}

type GuardFail = { code: string; detail?: Record<string, unknown>; blockers?: Blocker[]; retryAfterSeconds?: number };

interface GuardImpl {
  /** Facts it reads; a missing one throws when applying and skips the guard when probing. */
  facts: Array<keyof StageFacts>;
  /** Reads the body: skipped when probing. */
  body: boolean;
  run: (env: GuardEnv) => GuardFail | null;
}

const fail = (code: string, extra: Omit<GuardFail, "code"> = {}): GuardFail => ({ code, ...extra });

function mustPost(env: GuardEnv): PipelinePostState {
  if (!env.post) throw new ScpMachineError(`${env.action.action}: this guard needs the post`);
  return env.post;
}

function handoffInputOf(post: PipelinePostState, facts: StageFacts): HandoffInput {
  const h = facts.handoff!;
  return {
    format: post.format, caption: post.caption, scheduledAt: post.scheduledAt, placement: post.placement,
    hashtags: post.hashtags, onAssetText: post.onAssetText, mustHaves: post.mustHaves, rawAssets: post.rawAssets,
    platforms: h.platforms, hashtagSets: h.hashtagSets, readyBy: h.readyBy, timeZone: h.timeZone,
  };
}

/** The placement an account guard checks: the new one for reschedule, else the post's. */
function placementFor(env: GuardEnv): string[] {
  const p = env.params.placement;
  return Array.isArray(p) && !env.probe ? (p as string[]) : mustPost(env).placement;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const GUARDS: Record<string, GuardImpl> = {
  cycle_exists: { facts: ["cycleExists"], body: false, run: ({ facts }) => (facts.cycleExists ? null : fail("cycle_not_found")) },
  fields_allowed_in_status: {
    facts: [], body: true,
    run: (env) => {
      const post = mustPost(env);
      const allowed = editableFields(post);
      for (const k of Object.keys((env.params.fields ?? {}) as object)) {
        if (!allowed.fields.includes(k)) return fail(allowed.refusal ?? "field_locked", { detail: { field: k, status: post.pipelineStatus } });
      }
      return null;
    },
  },
  suggestion_exists: {
    facts: [], body: true,
    run: (env) => (mustPost(env).suggestions[columnOf(String(env.params.field))] ? null : fail("suggestion_not_found")),
  },
  required_to_send: {
    facts: ["handoff"], body: false,
    run: (env) => {
      const blockers = failingRequiredToSend(handoffInputOf(mustPost(env), env.facts));
      return blockers.length ? fail("incomplete_post", { blockers }) : null;
    },
  },
  handoff_checks_pass_or_send_anyway: {
    // Probing: "send anyway" always exists, so the soft checks never make the button unavailable; the page shows them.
    facts: ["handoff"], body: true,
    run: (env) => {
      const d = decideSoft(handoffInputOf(mustPost(env), env.facts), { sendAnyway: env.params.sendAnyway, sendAnywayReason: env.params.sendAnywayReason });
      return d.ok ? null : fail(d.code, { blockers: d.blockers });
    },
  },
  suggestions_not_stale: {
    facts: [], body: false,
    run: (env) => {
      const post = mustPost(env);
      const stale = Object.entries(post.suggestions)
        .filter(([col, s]) => !sameJson(s.base, (post as unknown as Record<string, unknown>)[fieldOfColumn(col)]))
        .map(([col]) => fieldOfColumn(col));
      return stale.length ? fail("suggestion_stale", { detail: { fields: stale } }) : null;
    },
  },
  creatives_unit_exists_when_source_creatives: {
    facts: ["engagementCreativeSource", "creativesUnitExists"], body: false,
    run: ({ facts }) => (facts.engagementCreativeSource === "creatives" && !facts.creativesUnitExists ? fail("creatives_unit_missing") : null),
  },
  asset_exists: {
    facts: [], body: true,
    run: ({ params, facts }) => {
      if (absent(params.assetGroupId)) return null;
      if (facts.assetExists === undefined) throw new ScpMachineError("add_design: assetExists is required with an assetGroupId");
      return facts.assetExists ? null : fail("asset_not_found");
    },
  },
  design_exists: { facts: ["designExists"], body: true, run: ({ facts }) => (facts.designExists ? null : fail("design_not_found")) },
  design_present: { facts: ["designCount"], body: false, run: ({ facts }) => ((facts.designCount ?? 0) > 0 ? null : fail("design_missing")) },
  designs_stored: {
    facts: ["unstoredDesignIds"], body: false,
    run: ({ facts }) => (facts.unstoredDesignIds!.length ? fail("design_not_stored", { detail: { designIds: facts.unstoredDesignIds } }) : null),
  },
  one_account_per_placement_network: {
    facts: ["accountsByNetwork"], body: false,
    run: (env) => {
      const networks = placementFor(env).filter((n) => (env.facts.accountsByNetwork![n] ?? 0) === 0);
      return networks.length ? fail("no_account_for_network", { detail: { networks } }) : null;
    },
  },
  account_not_ambiguous: {
    facts: ["accountsByNetwork"], body: false,
    run: (env) => {
      const networks = placementFor(env).filter((n) => (env.facts.accountsByNetwork![n] ?? 0) > 1);
      return networks.length ? fail("ambiguous_account", { detail: { networks } }) : null;
    },
  },
  // SCP-Sa3 (SCP-D9: "a post is wholly simulated or wholly real"). Since Sa2 a client may hold a simulated account on one network
  // and a real one on another; a post placed on both would publish partly into the simulator and partly for real, and the calendar
  // would say "live" while only some networks got it. Refused where the post first commits to its accounts (`final_approve` creates
  // the variants) and again where it is handed to an engine (`schedule_publisher`), because an account can be re-marked in
  // between. `schedule` by hand and `reschedule` dispatch nothing; a reschedule's new placement is judged at the next final step.
  account_kinds_not_mixed: {
    facts: ["accountKinds"], body: false,
    run: ({ facts }) => {
      const k = facts.accountKinds!;
      return k.simulated.length > 0 && k.real.length > 0 ? fail("publisher_kinds_mixed", { detail: { simulated: k.simulated, real: k.real } }) : null;
    },
  },
  seen_hash_matches: {
    facts: ["reviewHash"], body: true,
    run: ({ params, facts }) => (facts.reviewHash !== null && params.seenHash === facts.reviewHash ? null : fail("content_changed")),
  },
  every_variant_review_pending: {
    facts: ["everyReviewPending"], body: false,
    run: ({ facts }) => (facts.everyReviewPending ? null : fail("client_review_already_decided")),
  },
  own_decision: { facts: ["decidedByThisContact"], body: false, run: ({ facts }) => (facts.decidedByThisContact ? null : fail("not_your_decision")) },
  within_undo_window: { facts: ["withinUndoWindow"], body: false, run: ({ facts }) => (facts.withinUndoWindow ? null : fail("undo_window_passed")) },
  nothing_happened_since: { facts: ["nothingHappenedSince"], body: false, run: ({ facts }) => (facts.nothingHappenedSince ? null : fail("undo_window_passed")) },
  approved_time_not_passed: {
    facts: ["approvedSchedule", "now"], body: false,
    run: ({ facts }) => {
      const at = facts.approvedSchedule?.scheduledAt;
      const t = at ? Date.parse(at) : Number.NaN;
      // No approved time to schedule at fails closed: there is nothing the client approved to use.
      if (Number.isNaN(t)) return fail("approved_time_passed");
      return t < facts.now!.getTime() - APPROVED_TIME_GRACE_MS ? fail("approved_time_passed") : null;
    },
  },
  media_rules_pass: {
    facts: ["mediaFailures"], body: false,
    run: ({ facts }) => (facts.mediaFailures!.length ? fail("media_rules_failed", { detail: { variants: facts.mediaFailures } }) : null),
  },
  publisher_available: { facts: ["publisherAvailable"], body: false, run: ({ facts }) => (facts.publisherAvailable ? null : fail("publisher_unavailable")) },
  no_variant_publishing: { facts: ["anyVariantPublishing"], body: false, run: ({ facts }) => (facts.anyVariantPublishing ? fail("dispatch_in_flight") : null) },
  something_changes: {
    facts: ["approvedSchedule"], body: true,
    run: ({ params, facts }) => {
      const ap = facts.approvedSchedule ?? { scheduledAt: null, placement: [] };
      const atChanges = !absent(params.at) && (ap.scheduledAt === null || Date.parse(String(params.at)) !== Date.parse(ap.scheduledAt));
      const pl = params.placement as string[] | undefined;
      const placementChanges = Array.isArray(pl) && !(pl.length === ap.placement.length && pl.every((n) => ap.placement.includes(n)));
      return atChanges || placementChanges ? null : fail("no_change");
    },
  },
  holder_is_someone_else: {
    facts: ["callerHoldsPost"], body: false,
    run: (env) => (holderOf(mustPost(env)) === null || env.facts.callerHoldsPost ? fail("nobody_to_follow_up") : null),
  },
  once_per_holder_per_24h: {
    facts: ["now", "lastFollowUpAt"], body: false,
    run: ({ facts }) => {
      if (!facts.lastFollowUpAt) return null;
      const elapsed = facts.now!.getTime() - Date.parse(facts.lastFollowUpAt);
      if (elapsed >= FOLLOW_UP_WINDOW_MS) return null;
      return fail("follow_up_too_soon", { retryAfterSeconds: Math.ceil((FOLLOW_UP_WINDOW_MS - elapsed) / 1000) });
    },
  },
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Effects: conditions, classification, and the column effects
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface EffectEnv {
  action: ScpAction;
  post: PipelinePostState | null;
  params: Record<string, unknown>;
  facts: StageFacts;
  principal: StagePrincipal;
}

/** The condition prefixes effects carry ("when X: …", "else: …", "officer: …", "publisher: …"). `else` negates the
 *  nearest `when` before it in the same list. */
const EFFECT_CONDITIONS: Record<string, (env: EffectEnv) => boolean> = {
  "when changedOnly": ({ post }) => post?.changedOnly === true,
  "when creatives": ({ facts }) => facts.engagementCreativeSource === "creatives",
  "when in_team": ({ facts }) => facts.engagementCreativeSource === "in_team",
  "when copy": ({ params }) => params.changeKind === "copy",
  "when design": ({ params }) => params.changeKind === "design",
  "when scheduled": ({ post }) => post?.pipelineStatus === "scheduled",
  "when publisher": ({ post }) => post?.scheduleVia === "publisher",
  officer: ({ principal }) => principal.isPublisher !== true,
  publisher: ({ principal }) => principal.isPublisher === true,
};

/** Split "when copy: notify:officer" into its condition and its effect name. The start_design prose effect is one
 *  name, not a condition. */
export function splitEffect(raw: string): { condition: string | null; name: string } {
  if (raw === PROSE.startDesignEffect) return { condition: null, name: raw };
  const m = /^(when [a-zA-Z_]+|else|officer|publisher): (.+)$/.exec(raw);
  return m ? { condition: m[1], name: m[2] } : { condition: null, name: raw };
}

/** The effects with side effects outside the `social_posts` row: phase 2 implements each, by this name. */
export const IO_EFFECTS: ReadonlySet<string> = new Set([
  "content_month_progress", "cycle_steps",
  "copy_log_when_in_changes", "copy_log", "copy_log_each_field",
  "sync_variants_copy_from_master", "request_client_reviews",
  "join_or_open_month_request",
  "insert_design", "link_asset_to_month_request", "mark_design_removed", "warn_on_unknown_source",
  "sync_variants_from_master", "materialize_design_files",
  "approve_every_variant_review_with_args_hash_in_one_transaction", "changes_requested_on_every_variant_review_in_one_transaction",
  "decision_id", "undo_window_10s", "reviews_back_to_pending", "drop_pending_notifications", "recorded_by_and_channel",
  "schedule_by_hand_at_approved_date_time_and_placement", "file_one_publish_approval_per_variant",
  "cancel_queued_dispatches_and_withdraw_pending_approvals", "unschedule_cancelling_dispatches_and_withdrawing_approvals",
  "sync_variants_dates_and_networks", "request_client_reviews_on_every_variant",
  "variants_become_native_import_published", "from_published_variants", "set_simulated_from_variants", "start_metrics",
  "activity_only",
  "withdraw_pending_client_reviews", "withdraw_pending_publish_approvals",
]);

/** Notifications are I/O by their prefix: `notify:<who>` and `notify_after_undo_window:<who>`. */
export const isNotifyEffect = (name: string) => /^notify(_after_undo_window)?:[a-z_]+$/.test(name);

/** Writes to the row, collected for one UPDATE. Each column effect writes through `put`, which keeps `next` in step
 *  for the columns the machine's state carries (`pipeline_status` → `pipelineStatus`); bookkeeping columns (`status`,
 *  `status_since`, `last_action_at`, `deleted_at`, …) have no state field and only go to `set`. */
class RowWriter {
  readonly set: Record<string, unknown> = {};
  constructor(readonly next: PipelinePostState) {}
  put(column: string, value: unknown): void {
    this.set[column] = value;
    const key = fieldOfColumn(column);
    if (key !== "id" && Object.prototype.hasOwnProperty.call(this.next, key)) (this.next as unknown as Record<string, unknown>)[key] = value;
  }
}

interface ColumnEnv extends EffectEnv {
  w: RowWriter;
  target: Target;
  now: string;
  copyLog: CopyLogEntry[];
  skipped: { codes: string[]; reason: string } | null;
  appendSkipped: StageApplied["appendSkippedChecks"];
  alreadyApplied: boolean;
}

const COPY_COLUMNS = ["caption", "on_asset_text", "cta", "hashtags"];

function actorId(env: { principal: StagePrincipal; action: ScpAction }): string {
  if (!env.principal.userId) throw new ScpMachineError(`${env.action.action}: principal.userId is required`);
  return env.principal.userId;
}

function writeChange(env: ColumnEnv, caseKey: string | null): void {
  const c = caseKey ? scpChangeCase(caseKey)! : null;
  env.w.put("change_by", c?.changeBy ?? null);
  env.w.put("change_kind", c?.changeKind ?? null);
  env.w.put("return_to", c?.returnTo ?? null);
  env.w.put("change_note", c ? String(env.params.note).trim() : null);
}

/** The column effects, by fixture name. Each writes only the `social_posts` row. */
export const COLUMN_EFFECTS: Record<string, (env: ColumnEnv) => void> = {
  set_cycle_and_engagement: (env) => {
    if (env.facts.cycleId) env.w.put("cycle_id", env.facts.cycleId);
    if (env.facts.engagementId) env.w.put("engagement_id", env.facts.engagementId);
  },
  set_status_since: (env) => env.w.put("status_since", env.now),
  set_engine_status: () => {
    /* computed last, from the post after (see `decide`) */
  },
  set_author_if_null: (env) => {
    if (env.post && env.post.authorId === null) env.w.put("author_id", actorId(env));
  },
  write_fields: (env) => {
    for (const [k, v] of Object.entries(env.params.fields as Record<string, unknown>)) {
      const col = columnOf(k);
      const before = (env.post as unknown as Record<string, unknown>)[k];
      env.w.put(col, v);
      if (editableFields(env.post!).copyLog && COPY_COLUMNS.includes(col) && !sameJson(before, v)) {
        env.copyLog.push({ field: col, before, after: v, via: "fix", suggestedBy: null, stage: env.post!.pipelineStatus! });
      }
    }
  },
  copy_log_when_in_changes: () => {
    /* rows collected by write_fields; phase 2 inserts `copyLog` */
  },
  apply_one_suggestion: (env) => {
    const col = columnOf(String(env.params.field));
    const s = env.post!.suggestions[col];
    const before = (env.post as unknown as Record<string, unknown>)[fieldOfColumn(col)];
    env.w.put(col, s.value);
    env.copyLog.push({ field: col, before, after: s.value, via: "suggestion", suggestedBy: s.by, stage: env.post!.pipelineStatus! });
    const rest = { ...env.w.next.suggestions };
    delete rest[col];
    env.w.put("suggestions", rest);
  },
  clear_change_keep_changed_only: (env) => writeChange(env, null),
  append_skipped_checks: (env) => {
    if (env.skipped && env.skipped.codes.length) {
      env.appendSkipped = { codes: env.skipped.codes, reason: env.skipped.reason, by: actorId(env), at: env.now };
    }
  },
  set_or_drop_suggestion_with_base: (env) => {
    const field = String(env.params.field);
    const col = columnOf(field);
    const next = { ...env.post!.suggestions };
    if (env.params.value === null) delete next[col];
    else next[col] = { value: env.params.value, base: (env.post as unknown as Record<string, unknown>)[field], by: actorId(env), at: env.now };
    env.w.put("suggestions", next);
  },
  apply_suggestions: (env) => {
    for (const [col, s] of Object.entries(env.post!.suggestions)) {
      const before = (env.post as unknown as Record<string, unknown>)[fieldOfColumn(col)];
      env.w.put(col, s.value);
      env.copyLog.push({ field: col, before, after: s.value, via: "suggestion", suggestedBy: s.by, stage: env.post!.pipelineStatus! });
    }
  },
  copy_log_each_field: () => {
    /* rows collected by apply_suggestions */
  },
  copy_log: () => {
    /* the row collected by apply_one_suggestion */
  },
  clear_suggestions: (env) => env.w.put("suggestions", {}),
  clear_changed_only: (env) => {
    env.w.put("changed_only", false);
    env.w.put("copy_before", null);
  },
  set_change: (env) => writeChange(env, env.target.changeCase),
  keep_suggestions: () => {},
  copy_creative_source_from_engagement: (env) => {
    if (!env.facts.engagementCreativeSource) throw new ScpMachineError("approve_for_design: engagementCreativeSource is required");
    env.w.put("creative_source", env.facts.engagementCreativeSource);
  },
  creative_state_not_started: (env) => env.w.put("creative_state", "not_started"),
  // The in-team design queue is the posts in `design` with creative_source in_team (BFF §63.6.6): the row is the queue.
  enter_in_team_queue: () => {},
  clear_change: (env) => writeChange(env, null),
  [PROSE.startDesignEffect]: (env) => {
    const s = env.post!.creativeState;
    if (s === "not_started") env.w.put("creative_state", "in_progress");
    else if (s === "revision") {
      /* stays revision */
    } else if (s === "in_progress") env.alreadyApplied = true;
    else throw new ScpMachineError(`start_design: creative_state '${String(s)}' is not one the fixture names`);
  },
  creative_state_submitted: (env) => env.w.put("creative_state", "submitted"),
  set_client_first_sent_at_if_null: (env) => {
    if (env.post!.clientFirstSentAt === null) env.w.put("client_first_sent_at", env.now);
  },
  creative_state_revision: (env) => env.w.put("creative_state", "revision"),
  set_changed_only_and_copy_before: (env) => {
    const p = env.post!;
    env.w.put("changed_only", true);
    env.w.put("copy_before", { caption: p.caption, on_asset_text: p.onAssetText, cta: p.cta, hashtags: p.hashtags });
  },
  restore_pre_decision_fields: (env) => {
    writeChange(env, null);
    env.w.put("changed_only", false);
    env.w.put("copy_before", null);
    if (env.facts.preDecisionCreativeState !== undefined) env.w.put("creative_state", env.facts.preDecisionCreativeState);
  },
  set_schedule_via_manual: (env) => env.w.put("schedule_via", "manual"),
  set_schedule_via_publisher: (env) => env.w.put("schedule_via", "publisher"),
  clear_schedule_via: (env) => env.w.put("schedule_via", null),
  write_date_and_placement: (env) => {
    if (!absent(env.params.at)) env.w.put("scheduled_at", new Date(String(env.params.at)).toISOString());
    if (Array.isArray(env.params.placement)) env.w.put("placement", env.params.placement);
  },
  set_live_url_and_went_live_at: (env) => {
    const url = env.principal.isPublisher ? env.facts.publisherLiveUrl : env.params.url;
    if (!url) throw new ScpMachineError("mark_live: no live URL (the officer's url, or facts.publisherLiveUrl)");
    env.w.put("live_url", url);
    env.w.put("went_live_at", absent(env.params.at) ? env.now : new Date(String(env.params.at)).toISOString());
  },
  set_blocked_from_and_reason: (env) => {
    env.w.put("blocked_from", env.post!.pipelineStatus);
    env.w.put("block_reason", String(env.params.reason).trim());
    env.w.put("block_waiting_on", env.params.waitingOn);
    env.w.put("blocked_at", env.now);
  },
  keep_change_case: () => {},
  clear_block: (env) => {
    for (const c of ["blocked_from", "block_reason", "block_waiting_on", "blocked_at"]) env.w.put(c, null);
  },
  soft_delete: (env) => {
    env.w.put("deleted_at", env.now);
    env.w.next.deleted = true;
  },
  set_archived: (env) => {
    env.w.put("archived_at", env.now);
    env.w.put("archived_by", actorId(env));
    env.w.put("archive_reason", String(env.params.reason).trim());
    env.w.next.archived = true;
  },
};

/** The effects that need no code of their own beyond `COLUMN_EFFECTS`' bookkeeping above (the copy-log rows ride in
 *  `copyLog`). They are listed in `columnEffects`, not `effects`, except the copy-log ones, which phase 2 inserts. */
const COPY_LOG_EFFECTS = new Set(["copy_log_when_in_changes", "copy_log", "copy_log_each_field"]);

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The entry point
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

type StepOutcome = StageRefusal | { alreadyApplied: true } | null;

interface StepEnv {
  ctx: StageContext;
  action: ScpAction | undefined;
  post: PipelinePostState | null;
  probe: boolean;
  isCreate: boolean;
  surface: "staff" | "portal";
  skipped: { codes: string[]; reason: string } | null;
}

function refuse(guard: string, code: string, extra: Partial<StageRefusal> = {}): StageRefusal {
  const http = SCP.refusals[code]?.http;
  if (http === undefined && extra.http === undefined) throw new ScpMachineError(`refusal '${code}' is not in the fixture`);
  return { ok: false, http: extra.http ?? http!, code, guard, ...extra };
}

const isPortalAction = (a: ScpAction) => typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:");
const acceptsPublisher = (a: ScpAction) => Array.isArray(a.actors) && a.actors.includes("publisher");

/** The common steps, by the fixture's `commonGuards` guard names. */
const STEPS: Record<string, (e: StepEnv) => StepOutcome> = {
  action_known: (e) => {
    const a = e.action;
    // The client's decisions are the portal's routes and the staff's are not the portal's (BFF §63.6.5, §63.9).
    if (!a || isPortalAction(a) !== (e.surface === "portal")) return refuse("action_known", "unknown_action");
    if (e.ctx.principal.isPublisher && !acceptsPublisher(a)) throw new ScpMachineError(`${a.action}: the publisher does not act on it`);
    return null;
  },
  post_exists: (e) => (e.isCreate || (e.post && !e.post.deleted) ? null : refuse("post_exists", "post_not_found")),
  post_in_pipeline: (e) => (e.isCreate || e.post!.pipelineStatus !== null ? null : refuse("post_in_pipeline", "not_a_pipeline_post")),
  replay_of_last_action_id: (e) => {
    if (e.probe) return null;
    // create's replay is its `id`: the caller passes the existing row as `post` (BFF §63.0 Idempotency: 201 created:false).
    if (e.isCreate) return e.post ? { alreadyApplied: true } : null;
    const id = e.ctx.actionId;
    return id !== undefined && e.post!.lastActionId !== null && id === e.post!.lastActionId ? { alreadyApplied: true } : null;
  },
  post_not_archived: (e) => (e.isCreate || !e.post!.archived ? null : refuse("post_not_archived", "post_archived")),
  not_unattended_automation: (e) => (e.ctx.principal.isAutomation ? refuse("not_unattended_automation", "automation_cannot_act") : null),
  maker_checker: (e) => {
    if (e.ctx.principal.isPublisher) return null;
    const g = SCP.commonGuards.find((x) => x.guard === "maker_checker")!;
    const ca = e.action!.cerbosAction;
    // appliesTo names the action's own `cerbosAction`. unschedule's is a per-scheduleVia map, not the string
    // "approve": its publisher arm is guarded by the Cerbos DENY instead, which answers not_an_approver (the
    // fixture scenario "one of the four files through the publisher" pins that).
    const applies = typeof ca === "string" && (g.appliesTo ?? []).includes(ca);
    const p = e.ctx.principal;
    return applies && (p.isAuthor || p.isOfficer) ? refuse("maker_checker", "author_cannot_approve") : null;
  },
  cerbos: (e) => {
    if (e.ctx.principal.isPublisher) return null;
    for (const check of cerbosChecksFor(e.action!, e.isCreate ? null : e.post)) {
      const answers = check.actions.map((name) => {
        const v = e.ctx.cerbos[name];
        if (v === undefined) throw new ScpMachineError(`${e.action!.action}: no Cerbos decision for '${name}' (ask cerbosActionsToAsk)`);
        return v;
      });
      const ok = check.mode === "all" ? answers.every(Boolean) : answers.some(Boolean);
      if (!ok) return refuse("cerbos", check.refusal.code, { http: check.refusal.http, ...(check.refusal.generic ? { generic: true } : {}) });
    }
    return null;
  },
  expected_status_matches: (e) => {
    if (e.isCreate || e.probe) return null;
    const exp = e.ctx.expectedStatus;
    if (exp === undefined) return e.ctx.requireExpectedStatus === false ? null : refuse("expected_status_matches", "missing_field", { field: "expectedStatus" });
    if (!SCP.statuses.includes(exp)) return refuse("expected_status_matches", "invalid_field", { field: "expectedStatus" });
    return exp === e.post!.pipelineStatus
      ? null
      : refuse("expected_status_matches", "status_changed", { detail: { status: e.post!.pipelineStatus, phase: phaseOf(e.post!) } });
  },
  status_in_from: (e) => {
    if (e.isCreate) return null;
    if (fromMatches(e.action!, e.post!)) return null;
    if (e.surface === "portal") return refuse("status_in_from", "post_not_with_client");
    const changeCase = e.post!.pipelineStatus === "changes" ? changeCaseOf(e.post!) : null;
    return refuse("status_in_from", "invalid_transition", { detail: { status: e.post!.pipelineStatus, changeCase } });
  },
  params_valid: (e) => {
    if (e.probe) return null;
    if (e.ctx.actionId !== undefined && !isUuid(e.ctx.actionId)) return refuse("params_valid", "invalid_field", { field: "actionId" });
    for (const name of Object.keys(e.action!.params)) {
      const p = paramRule(e.action!.action, name)(name, e.ctx.params[name], e.ctx.params, { principal: e.ctx.principal, post: e.post });
      if (p) return refuse("params_valid", p.code, { field: p.field });
    }
    return null;
  },
  action_guards: (e) => {
    const env: GuardEnv = { action: e.action!, post: e.post, params: e.ctx.params, facts: e.ctx.facts, principal: e.ctx.principal, probe: e.probe };
    for (const g of e.action!.guards) {
      const impl = GUARDS[g.guard];
      if (e.probe && impl.body) continue;
      const missingFact = impl.facts.find((f) => e.ctx.facts[f] === undefined);
      if (missingFact) {
        if (e.probe) continue;
        throw new ScpMachineError(`${e.action!.action}: guard ${g.guard} needs facts.${String(missingFact)}`);
      }
      const f = impl.run(env);
      if (f) {
        if (f.code !== g.refusal && !(g.guard === "fields_allowed_in_status")) {
          // A guard answers its fixture code. (fields_allowed_in_status answers the edit rule's own refusal, which the
          // fixture also names field_locked; assertMachineCoverage checks the two agree.)
          throw new ScpMachineError(`guard ${g.guard} answered '${f.code}', the fixture says '${g.refusal}'`);
        }
        return refuse(g.guard, f.code, { detail: f.detail, blockers: f.blockers, retryAfterSeconds: f.retryAfterSeconds });
      }
    }
    if (!e.probe && e.action!.action === "send_to_proofread") {
      const d = decideSoft(handoffInputOf(e.post!, e.ctx.facts), { sendAnyway: e.ctx.params.sendAnyway, sendAnywayReason: e.ctx.params.sendAnywayReason });
      if (d.ok && d.skippedCodes.length) e.skipped = { codes: d.skippedCodes, reason: d.reason! };
    }
    return null;
  },
};

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

const emptyPost = (id: string): PipelinePostState => ({
  id, pipelineStatus: null, deleted: false, archived: false, authorId: null,
  changeBy: null, changeKind: null, returnTo: null, changeNote: null, changedOnly: false, copyBefore: null,
  blockedFrom: null, blockReason: null, blockWaitingOn: null, blockedAt: null,
  creativeSource: null, creativeState: null, scheduleVia: null, clientFirstSentAt: null, lastActionId: null,
  title: "", format: null, pillar: null, angle: null, objective: null, keyMessage: null, visualDirection: null,
  rawAssets: [], placement: [], scheduledAt: null, mustHaves: [], caption: "", onAssetText: null, cta: null, hashtags: [],
  suggestions: {},
});

/**
 * Decide one stage action. Runs the fixture's `commonGuards` in order; on a pass, computes the target, the column
 * changes, the copy-log rows, the skipped checks and the I/O effects. Pure: the same context gives the same answer.
 */
export function decide(ctx: StageContext): StageResult {
  const action = scpAction(ctx.action);
  const isProbe = ctx.mode === "probe";
  const env: StepEnv = {
    ctx, action, post: ctx.post, probe: isProbe,
    isCreate: action?.kind === "create",
    surface: ctx.surface ?? "staff",
    skipped: null,
  };

  for (const g of [...SCP.commonGuards].sort((a, b) => a.order - b.order)) {
    if (ctx.mode === "gate" && g.guard === "action_guards") break;
    const out = STEPS[g.guard](env);
    if (out === null) continue;
    if ("alreadyApplied" in out) return replayed(action!, ctx.post!);
    return out;
  }

  if (isProbe || ctx.mode === "gate") return probeAllowed(action!, ctx.post);
  return apply(action!, ctx, env.skipped);
}

function replayed(action: ScpAction, post: PipelinePostState): StageApplied {
  const status = post.pipelineStatus;
  return {
    ok: true, alreadyApplied: true, action: action.action, from: status, to: status,
    changeCase: { before: changeCaseOf(post), after: changeCaseOf(post) },
    phase: phaseOf(post), engineStatus: null,
    set: {}, appendSkippedChecks: null, copyLog: [], effects: [], columnEffects: [],
    activity: { verb: action.action, metadata: {} }, warnings: [], next: post,
  };
}

function probeAllowed(action: ScpAction, post: PipelinePostState | null): StageApplied {
  const status = post?.pipelineStatus ?? null;
  return {
    ok: true, alreadyApplied: false, action: action.action, from: status, to: null,
    changeCase: { before: post ? changeCaseOf(post) : null, after: null }, phase: null, engineStatus: null,
    set: {}, appendSkippedChecks: null, copyLog: [], effects: [], columnEffects: [],
    activity: { verb: action.action, metadata: {} }, warnings: [], next: null,
  };
}

function apply(action: ScpAction, ctx: StageContext, skipped: { codes: string[]; reason: string } | null): StageApplied {
  if (!ctx.facts.now) throw new ScpMachineError(`${action.action}: facts.now is required to apply`);
  const now = ctx.facts.now.toISOString();
  const isCreate = action.kind === "create";
  const before = isCreate ? null : ctx.post!;
  const target = targetOf(action, before, ctx.params);
  const w = new RowWriter(structuredClone(before ?? emptyPost(String(ctx.params.id ?? ""))));
  const copyLog: CopyLogEntry[] = [];

  if (isCreate) {
    if (!absent(ctx.params.id)) w.put("id", ctx.params.id);
    w.put("title", String(ctx.params.title).trim());
    w.put("is_extra", ctx.params.isExtra === true);
    for (const f of ["format", "pillar", "scheduledAt", "placement"]) if (!absent(ctx.params[f])) w.put(columnOf(f), ctx.params[f]);
  }
  // The status itself (a pseudo target keeps it: archive and discard leave pipeline_status as it was).
  if (target.status !== (before?.pipelineStatus ?? null)) w.put("pipeline_status", target.status);

  // Resolve the effects' conditions, in order.
  const envE: EffectEnv = { action, post: before, params: ctx.params, facts: ctx.facts, principal: ctx.principal };
  const applicable: string[] = [];
  let lastWhen: boolean | null = null;
  for (const raw of action.effects) {
    const { condition, name } = splitEffect(raw);
    let on = true;
    if (condition === "else") {
      if (lastWhen === null) throw new ScpMachineError(`${action.action}: 'else' without a 'when'`);
      on = !lastWhen;
    } else if (condition !== null) {
      on = EFFECT_CONDITIONS[condition](envE);
      if (condition.startsWith("when ")) lastWhen = on;
    }
    if (on) applicable.push(name);
  }

  const cenv: ColumnEnv = { ...envE, w, target, now, copyLog, skipped, appendSkipped: null, alreadyApplied: false };
  const columnEffects: string[] = [];
  const effects: string[] = [];
  for (const name of applicable) {
    const col = COLUMN_EFFECTS[name];
    if (col) {
      col(cenv);
      if (COPY_LOG_EFFECTS.has(name)) effects.push(name);
      else columnEffects.push(name);
    } else effects.push(name);
  }
  if (cenv.alreadyApplied) return replayed(action, before!);

  // The change case after must be the one the target names: a mismatch is a fixture whose effects forgot to set or
  // clear it, and the database CHECK would refuse the row.
  const nextCase = changeCaseOf(w.next);
  if (target.pseudo === null && nextCase !== target.changeCase) {
    throw new ScpMachineError(`${action.action}: the change case after is '${nextCase}', the target says '${target.changeCase}'`);
  }

  const archived = w.next.archived;
  let engineStatus: string | null = null;
  if (applicable.includes("set_engine_status")) {
    const st = w.next.pipelineStatus;
    if (st !== null && STATUSES_READING_VARIANTS.has(st) && ctx.facts.variantStatuses === undefined) {
      throw new ScpMachineError(`${action.action}: facts.variantStatuses is required to set the engine status of a '${st}' post`);
    }
    engineStatus = engineStatusOf(w.next, ctx.facts.variantStatuses ?? [], archived);
    w.put("status", engineStatus);
  } else {
    engineStatus = w.next.pipelineStatus === null ? null : engineStatusOf(w.next, ctx.facts.variantStatuses ?? [], archived);
  }
  if (!isCreate) {
    // The idempotency key of the last applied action (BFF §63.0): an action without one clears it, so an older key
    // can never replay past a later action.
    w.put("last_action_id", ctx.actionId ?? null);
    w.put("last_action_at", now);
  }

  const from = before?.pipelineStatus ?? null;
  const to = target.pseudo ?? target.status;
  return {
    ok: true, alreadyApplied: false, action: action.action, from, to,
    changeCase: { before: before ? changeCaseOf(before) : null, after: nextCase },
    phase: w.next.deleted ? null : phaseOf(w.next),
    engineStatus,
    set: w.set,
    appendSkippedChecks: cenv.appendSkipped,
    copyLog,
    effects,
    columnEffects,
    activity: {
      verb: action.action,
      metadata: stripUndefined({
        from, to,
        changeCase: nextCase ?? undefined,
        checksSkipped: cenv.appendSkipped?.codes,
        channel: typeof ctx.params.channel === "string" ? ctx.params.channel : undefined,
      }),
    },
    warnings: [],
    next: w.next.deleted ? null : w.next,
  };
}

/** Decide one action for the read's `actions[]` (BFF §63.6.2): the steps that need no body. `reason` is the code the
 *  action route would answer. */
export function probe(ctx: Omit<StageContext, "mode" | "params" | "expectedStatus" | "actionId">): { action: string; allowed: boolean; reason?: string } {
  const r = decide({ ...ctx, params: {}, mode: "probe" });
  return r.ok ? { action: ctx.action, allowed: true } : { action: ctx.action, allowed: false, reason: r.code };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Rows
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A `social_posts` row (BFF §63.1 columns), as `pg` returns it. */
export interface SocialPostRow {
  id: string;
  pipeline_status: string | null;
  deleted_at: string | Date | null;
  archived_at: string | Date | null;
  author_id: string | null;
  change_by: string | null;
  change_kind: string | null;
  return_to: string | null;
  change_note: string | null;
  changed_only: boolean;
  copy_before: Record<string, unknown> | null;
  blocked_from: string | null;
  block_reason: string | null;
  block_waiting_on: string | null;
  blocked_at: string | Date | null;
  creative_source: string | null;
  creative_state: string | null;
  schedule_via: string | null;
  client_first_sent_at: string | Date | null;
  last_action_id: string | null;
  title: string;
  format: string | null;
  pillar: string | null;
  angle: string | null;
  objective: string | null;
  key_message: string | null;
  visual_direction: string | null;
  raw_assets: RawAsset[];
  placement: string[];
  scheduled_at: string | Date | null;
  must_haves: string[];
  caption: string;
  on_asset_text: string | null;
  cta: string | null;
  hashtags: string[];
  suggestions: Record<string, Suggestion>;
}

const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : v);

/** The machine's view of a `social_posts` row. */
export function postStateFromRow(r: SocialPostRow): PipelinePostState {
  return {
    id: r.id, pipelineStatus: r.pipeline_status, deleted: r.deleted_at !== null, archived: r.archived_at !== null,
    authorId: r.author_id, changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to, changeNote: r.change_note,
    changedOnly: r.changed_only, copyBefore: r.copy_before,
    blockedFrom: r.blocked_from, blockReason: r.block_reason, blockWaitingOn: r.block_waiting_on, blockedAt: iso(r.blocked_at),
    creativeSource: r.creative_source, creativeState: r.creative_state, scheduleVia: r.schedule_via,
    clientFirstSentAt: iso(r.client_first_sent_at), lastActionId: r.last_action_id,
    title: r.title, format: r.format, pillar: r.pillar, angle: r.angle, objective: r.objective, keyMessage: r.key_message,
    visualDirection: r.visual_direction, rawAssets: r.raw_assets ?? [], placement: r.placement ?? [], scheduledAt: iso(r.scheduled_at),
    mustHaves: r.must_haves ?? [], caption: r.caption ?? "", onAssetText: r.on_asset_text, cta: r.cta, hashtags: r.hashtags ?? [],
    suggestions: r.suggestions ?? {},
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Coverage: the fixture and this file must agree, or nothing loads
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Every disagreement between the fixture and this file. Empty means the machine can run every fixture row. */
export function machineCoverageProblems(): string[] {
  const p: string[] = [];
  const eq = (label: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) p.push(`${label}: the fixture says ${JSON.stringify(actual)}, the code reads ${JSON.stringify(expected)}`);
  };
  // The interpreted prose.
  eq("phaseOf.changes", SCP.phaseOf.changes, PROSE.phaseOfChanges);
  eq("holders.changes", SCP.holders.changes, PROSE.holderChanges);
  eq("holders.scheduled", SCP.holders.scheduled, PROSE.holderScheduled);
  eq("holders.blocked", SCP.holders.blocked, PROSE.holderBlocked);
  eq("primaryAction.design", SCP.primaryAction.design, PROSE.primaryDesign);
  eq("cerbosActions.create.refusal", SCP.cerbosActions.create?.refusal, PROSE.createRefusal);
  eq("cerbosActions.portal:approve_post.refusal", SCP.cerbosActions["portal:approve_post"]?.refusal, PROSE.portalPostRefusal);
  eq("portalStatusRefusal", SCP.portalStatusRefusal, PROSE.portalStatusRefusal);
  eq("phaseRule", SCP.phaseRule, PROSE.phaseRule);
  eq("editRules[last].status", SCP.editRules[SCP.editRules.length - 1]?.status, PROSE.editAnyOther);
  const cg = (name: string) => SCP.commonGuards.find((g) => g.guard === name);
  eq("commonGuards.cerbos.refusal", cg("cerbos")?.refusal, PROSE.commonCerbosRefusal);
  eq("commonGuards.params_valid.refusal", cg("params_valid")?.refusal, PROSE.commonParamsRefusal);
  eq("commonGuards.action_guards.refusal", cg("action_guards")?.refusal, PROSE.commonActionGuardsRefusal);
  eq("commonGuards.replay_of_last_action_id.outcome", cg("replay_of_last_action_id")?.outcome, PROSE.replayOutcome);
  eq("resolve.to", scpAction("resolve")?.to, { from: PROSE.resolveToFrom });
  eq("start_design.effects", scpAction("start_design")?.effects, [PROSE.startDesignEffect]);
  // The cerbos step's prose names two codes the structured rows must agree with.
  eq("cerbosActions.cancel.refusal", SCP.cerbosActions.cancel?.refusal, "cancel_required");
  eq("create.extraCerbosRefusal", scpAction("create")?.extraCerbosRefusal, "not_officer_or_approver");
  // portalStatusRefusal names post_not_with_client; it must be catalogued.
  if (!SCP.refusals.post_not_with_client) p.push("refusals has no post_not_with_client (portalStatusRefusal names it)");

  // Every common step has an implementation, and every implementation a step.
  for (const g of SCP.commonGuards) if (!STEPS[g.guard]) p.push(`commonGuards.${g.guard} has no implementation`);
  for (const k of Object.keys(STEPS)) if (!SCP.commonGuards.some((g) => g.guard === k)) p.push(`step ${k} is not in commonGuards`);

  for (const a of SCP.actions) {
    // Guards.
    for (const g of a.guards) {
      if (!GUARDS[g.guard]) p.push(`${a.action}: guard ${g.guard} has no implementation`);
    }
    if (a.action === "edit") {
      const lockRefusal = SCP.editRules.find((r) => r.refusal)?.refusal;
      const g = a.guards.find((x) => x.guard === "fields_allowed_in_status");
      if (g && lockRefusal !== g.refusal) p.push(`edit: fields_allowed_in_status says '${g.refusal}', editRules says '${String(lockRefusal)}'`);
    }
    // Params.
    for (const name of Object.keys(a.params)) {
      const ex = EXPLICIT_PARAM_RULES[a.action]?.[name];
      if (!ex && !parseParamProse(a.params[name])) p.push(`${a.action}.params.${name} ('${a.params[name]}') has no rule`);
    }
    for (const name of Object.keys(EXPLICIT_PARAM_RULES[a.action] ?? {})) {
      if (!(name in a.params)) p.push(`${a.action}: explicit rule for '${name}', which the fixture does not name`);
    }
    // Effects and their conditions.
    for (const raw of a.effects) {
      const { condition, name } = splitEffect(raw);
      if (condition !== null && condition !== "else" && !EFFECT_CONDITIONS[condition]) p.push(`${a.action}: effect condition '${condition}' has no meaning`);
      if (!COLUMN_EFFECTS[name] && !IO_EFFECTS.has(name) && !isNotifyEffect(name)) p.push(`${a.action}: effect '${name}' is neither a column nor an I/O effect`);
    }
    // When keys.
    const whens: ScpWhen[] = [
      ...(Array.isArray(a.to) ? a.to.map((t) => t.when) : []),
      ...(Array.isArray(a.setsChangeCase) ? a.setsChangeCase.map((s) => s.when) : []),
    ];
    for (const w of whens) for (const k of Object.keys(w)) if (!WHEN_SOURCES[k]) p.push(`${a.action}: when key '${k}' has no source`);
    // Cerbos refusals readable.
    const names = typeof a.cerbosAction === "string" ? [a.cerbosAction] : Object.values(a.cerbosAction);
    const ex = a.extraCerbos as Record<string, string[]> | undefined;
    if (ex && !Array.isArray(ex.anyOf)) names.push(...Object.values(ex).flat());
    for (const n of names) {
      try {
        cerbosRefusalOf(n);
      } catch (err) {
        p.push((err as Error).message);
      }
    }
    // The publisher acts only where the fixture says.
    if (!Array.isArray(a.actors) && !(typeof a.cerbosAction === "object")) p.push(`${a.action}: per-route actors need a per-route cerbosAction`);
  }
  return p;
}

export function assertMachineCoverage(): void {
  const p = machineCoverageProblems();
  if (p.length) throw new Error(`the SCP stage machine is out of step with scp-stage-machine.json (${p.length}):\n  - ${p.join("\n  - ")}`);
}
assertMachineCoverage();
