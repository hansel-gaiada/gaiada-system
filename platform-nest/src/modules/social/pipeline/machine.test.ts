// SCP-1b — the stage machine's pure suite (FRONTEND-BFF-CONTRACT §63.3, §63.21). No database, no Cerbos, no clock:
// every case feeds `decide()` plain objects. The HTTP suite (phase 2) runs the same scenarios against real rows and a
// real Cerbos.
//
// What this file proves:
//   1. the fixture loads, validates and agrees with the code (every prose value the code interprets is pinned here);
//   2. every fixture scenario of the post machine runs green, step by step, through one small adapter;
//   3. the boost, budget and report scenarios are named as owned elsewhere, and an unlisted scenario fails;
//   4. the phase, holder, engine-status and primary-action mappings, for every status and change case;
//   5. every refusal code a guard names is reachable through `decide()`;
//   6. every hand-off check of §63.3.4 refuses and passes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_CHANGE_CASE_TUPLES, SCP, SCP_FIXTURE_PATH, isCodeToken, parseScpFixture, readScpFixtureText, scpAction,
  validateScpFixture, type ScpFixture, type ScpScenario, type ScpScenarioStep,
} from "./fixture";
import {
  FORMATS_NEEDING_ON_IMAGE_TEXT, MUST_HAVE_KEYS, MUST_HAVES_RULE_PREFIX, ON_IMAGE_TEXT_RULE, captionWithHashtags, dayInZone,
  decideSend, failingHandoffChecks, failingRequiredToSend, readChecks, type HandoffInput,
} from "./handoff-checks";
import {
  EXPLICIT_PARAM_RULES, GUARDS, PROSE, actionsFromStatus, cerbosActionsToAsk, cerbosChecksFor, changeCaseOf, decide,
  editableFields, engineStatusOf, holderOf, machineCoverageProblems, phaseOf, postStateFromRow, primaryActionOf, probe,
  type CerbosDecisions, type PipelinePostState, type StageApplied, type StageContext, type StageFacts, type StageResult,
} from "./machine";
import { maxHashtagsFor } from "../media-rules";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The adapter: scenario actors and start states → contexts
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const NOW = new Date("2026-11-02T03:00:00.000Z");
const FUTURE = "2026-11-20T10:00:00.000Z";
const PAST = "2026-10-30T10:00:00.000Z";
const READY_BY = "2026-11-14";
const UUID_A = "11111111-1111-4111-8111-111111111111";

/** One user id per scenario persona (fixture `scenarioPersonas` and the actors scenarios name). Mock ids only. */
const IDS: Record<string, string> = {
  officer: "u-officer", copywriter: "u-copywriter", approver: "u-hod", second_approver: "u-gm", owner: "u-owner",
  platform_admin: "u-superadmin", company_admin: "u-company-admin", social_manager: "u-social-manager",
  manager_of_another_department: "u-webdev-head", designer: "u-request-designer", request_designer: "u-request-designer",
  in_team_designer: "u-in-team-designer", client: "u-client-contact", automation: "u-n8n-bot",
};

/** An agent acting for a person arrives as that person (SCP-Q17): `agent_acting_for_<persona>` is `<persona>`. */
function personaOf(actor: string): string {
  const m = /^agent_acting_for_(.+)$/.exec(actor);
  const p = m ? m[1] : actor;
  if (!(p in IDS)) throw new Error(`the adapter has no persona '${actor}'`);
  return p;
}

const SEATS = new Set(["approver", "second_approver"]);

/** A stand-in for Cerbos, written from PERMISSION-CONTRACT §53.2 to §53.4 (who holds what). It answers every fixture
 *  Cerbos action for one persona on one post, the maker/checker DENY included. */
function cerbosOracle(persona: string, post: PipelinePostState | null, world: World): CerbosDecisions {
  const id = IDS[persona];
  const isOfficer = world.officerId === id;
  const isMaker = isOfficer || (post?.authorId ?? null) === id;
  const admin = persona === "platform_admin";
  const team = isOfficer || SEATS.has(persona) || admin; // manage, record_client, boost
  const d: CerbosDecisions = {
    author: isOfficer || admin,
    schedule: isOfficer || admin,
    manage: team,
    record_client: team,
    boost: team,
    proofread: (persona === "copywriter" || admin) && !isMaker,
    approve: (SEATS.has(persona) || persona === "owner" || admin) && !isMaker,
    design:
      admin ||
      (persona === "request_designer" || persona === "designer" ? post?.creativeSource === "creatives" : false) ||
      (persona === "in_team_designer" ? post?.creativeSource === "in_team" : false),
    create: ["officer", "approver", "second_approver", "owner", "platform_admin", "company_admin", "social_manager", "manager_of_another_department"].includes(persona) || isOfficer,
    cancel: admin || SEATS.has(persona) || persona === "company_admin",
    "portal:approve_post": persona === "client",
  };
  if (persona === "automation") for (const k of Object.keys(d)) d[k] = false;
  for (const k of Object.keys(SCP.cerbosActions)) if (!(k in d)) d[k] = false;
  return d;
}

interface World {
  officerId: string;
  creativeSource: string;
  designCount: number;
  reviewHash: string | null;
  hashSeq: number;
  everyReviewPending: boolean;
  approvedSchedule: { scheduledAt: string | null; placement: string[] } | null;
  publisherAvailable: boolean;
}

/** The content of a well-formed post: every hand-off check passes. Scenarios describe stage moves; the officer's
 *  writing between them is this baseline. */
function baseContent(): Pick<PipelinePostState,
  "title" | "format" | "pillar" | "angle" | "objective" | "keyMessage" | "visualDirection" | "rawAssets" | "placement" |
  "scheduledAt" | "mustHaves" | "caption" | "onAssetText" | "cta" | "hashtags"> {
  return {
    title: "Mock bakery: morning pastries", format: "feed", pillar: "Product", angle: "Fresh every morning",
    objective: "Footfall", keyMessage: "Baked at dawn", visualDirection: "Warm light, close crop",
    rawAssets: [{ url: "https://example.invalid/ref.jpg", label: "Reference", source: "own", aiNote: null }],
    placement: ["instagram"], scheduledAt: FUTURE, mustHaves: [...MUST_HAVE_KEYS],
    caption: "Fresh pastries every morning.", onAssetText: "Open daily", cta: "Visit us", hashtags: ["mockbakery"],
  };
}

function blankPost(): PipelinePostState {
  return {
    id: UUID_A, pipelineStatus: null, deleted: false, archived: false, authorId: null,
    changeBy: null, changeKind: null, returnTo: null, changeNote: null, changedOnly: false, copyBefore: null,
    blockedFrom: null, blockReason: null, blockWaitingOn: null, blockedAt: null,
    creativeSource: null, creativeState: null, scheduleVia: null, clientFirstSentAt: null, lastActionId: null,
    ...baseContent(), suggestions: {},
  };
}

function withCase(post: PipelinePostState, key: string): void {
  const c = SCP.changeCases.find((x) => x.key === key);
  if (!c) throw new Error(`unknown change case ${key}`);
  post.changeBy = c.changeBy;
  post.changeKind = c.changeKind;
  post.returnTo = c.returnTo;
  post.changeNote = "Mock note.";
  if (key === "client_copy") {
    post.changedOnly = true;
    post.copyBefore = { caption: post.caption, on_asset_text: post.onAssetText, cta: post.cta, hashtags: post.hashtags };
  }
}

const AFTER_DESIGN = new Set(["final", "client", "approved", "scheduled", "live"]);
const DESIGN_CASES = new Set(["final_design", "client_design"]);

/** The start-state keys the adapter reads. An unknown key fails the suite rather than being ignored. */
const START_KEYS = new Set(["status", "creativeState", "changeCase", "authorIs", "officerIs", "approvedTimeIsPast", "publisherRegistered", "failingChecks", "blockedFrom"]);

function startOf(sc: ScpScenario): { post: PipelinePostState | null; world: World } {
  const start = sc.start ?? {};
  for (const k of Object.keys(start)) if (!START_KEYS.has(k)) throw new Error(`scenario '${sc.name}': the adapter does not read start.${k}`);
  const officer = typeof start.officerIs === "string" ? personaOf(start.officerIs) : "officer";
  const world: World = {
    officerId: IDS[officer], creativeSource: sc.creativeSource ?? "creatives", designCount: 0, reviewHash: null, hashSeq: 1,
    everyReviewPending: false, approvedSchedule: null, publisherAvailable: start.publisherRegistered === true,
  };
  if (start.status === undefined) return { post: null, world };
  const status = String(start.status);
  const post = blankPost();
  post.pipelineStatus = status;
  post.authorId = IDS[typeof start.authorIs === "string" ? personaOf(start.authorIs) : officer];
  if (typeof start.changeCase === "string") withCase(post, start.changeCase);
  const caseKey = changeCaseOf(post);
  const designed = AFTER_DESIGN.has(status) || status === "design" || (caseKey !== null && caseKey !== "copywriter_copy" && caseKey !== "hod_copy");
  if (designed) post.creativeSource = world.creativeSource;
  post.creativeState = typeof start.creativeState === "string"
    ? start.creativeState
    : status === "design" ? "not_started"
      : AFTER_DESIGN.has(status) ? "submitted"
        : caseKey && DESIGN_CASES.has(caseKey) ? "revision"
          : caseKey === "final_copy" || caseKey === "client_copy" ? "submitted" : null;
  if (status === "scheduled" || status === "live") post.scheduleVia = "manual";
  if (status === "blocked") {
    post.blockedFrom = typeof start.blockedFrom === "string" ? start.blockedFrom : "drafting";
    post.blockReason = "Mock reason.";
    post.blockWaitingOn = "client";
    post.blockedAt = NOW.toISOString();
  }
  if (status === "live") {
    // not used by a scenario start; kept consistent with the CHECKs
  }
  if (start.approvedTimeIsPast === true) post.scheduledAt = PAST;
  for (const code of (start.failingChecks as string[] | undefined) ?? []) failPostCheck(post, code);
  if (AFTER_DESIGN.has(status) || (caseKey !== null && DESIGN_CASES.has(caseKey)) || caseKey === "final_copy" || caseKey === "client_copy") world.designCount = 1;
  if (status === "client" || AFTER_DESIGN.has(status) || caseKey?.startsWith("client_")) world.reviewHash = "hash-1";
  world.everyReviewPending = status === "client";
  if (status === "approved" || status === "scheduled" || status === "live") world.approvedSchedule = { scheduledAt: post.scheduledAt, placement: [...post.placement] };
  return { post, world };
}

/** Make the post fail one hand-off check. */
function failPostCheck(post: PipelinePostState, code: string): void {
  const m: Record<string, () => void> = {
    must_haves_unticked: () => { post.mustHaves = MUST_HAVE_KEYS.filter((k) => k !== "logo"); },
    caption_missing: () => { post.caption = ""; },
  };
  if (!m[code]) throw new Error(`the adapter cannot fail check '${code}'`);
  m[code]();
}

function factsOf(world: World): StageFacts {
  return {
    now: NOW, cycleExists: true, cycleId: "c-cycle", engagementId: "e-engagement",
    engagementCreativeSource: world.creativeSource, creativesUnitExists: true,
    assetExists: true, designExists: true, designCount: world.designCount, unstoredDesignIds: [],
    accountsByNetwork: { instagram: 1, facebook: 1 }, reviewHash: world.reviewHash, everyReviewPending: world.everyReviewPending,
    variantStatuses: [], anyVariantPublishing: false, mediaFailures: [], publisherAvailable: world.publisherAvailable,
    approvedSchedule: world.approvedSchedule, decidedByThisContact: true, withinUndoWindow: true, nothingHappenedSince: true,
    callerHoldsPost: false, lastFollowUpAt: null,
    handoff: { platforms: ["instagram", "facebook"], hashtagSets: [{ name: "Core", tags: ["mockbakery"] }], readyBy: READY_BY },
  };
}

/** Scenario params that are descriptions ("a later date and time") become values here. */
function resolveParams(step: ScpScenarioStep, post: PipelinePostState | null, world: World): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(step.params ?? {}) };
  if (out.at === "a later date and time") out.at = new Date(Date.parse(post!.scheduledAt!) + 2 * 86400000).toISOString();
  else if (out.at === "a future date and time") out.at = new Date(NOW.getTime() + 10 * 86400000).toISOString();
  if (out.placement === "a different network list") out.placement = post!.placement.includes("facebook") ? ["instagram"] : ["instagram", "facebook"];
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && / a /.test(` ${v} `) && (k === "at" || k === "placement")) throw new Error(`unresolved description ${k}: ${v}`);
  }
  // Body values a scenario leaves out because they are not its point.
  const defaults: Record<string, Record<string, unknown>> = {
    create: { title: "Mock bakery: morning pastries" },
    add_design: { assetGroupId: UUID_A },
    client_approve: { seenHash: world.reviewHash },
    client_change: { seenHash: world.reviewHash },
    record_client_approve: { channel: "whatsapp", note: "Approved on a call." },
    record_client_change: { channel: "whatsapp", note: "Asked on a call." },
  };
  return { ...(defaults[step.action] ?? {}), ...out };
}

function contextFor(step: ScpScenarioStep, post: PipelinePostState | null, world: World): StageContext {
  const action = scpAction(step.action)!;
  const persona = personaOf(step.actor);
  const id = IDS[persona];
  const isCreate = action.kind === "create";
  const target = isCreate ? null : post;
  return {
    action: step.action,
    params: resolveParams(step, post, world),
    post: target,
    principal: { userId: id, isAutomation: persona === "automation", isAuthor: target?.authorId === id, isOfficer: world.officerId === id },
    cerbos: cerbosOracle(persona, target, world),
    expectedStatus: isCreate ? undefined : step.expectedStatus ?? post?.pipelineStatus ?? undefined,
    facts: factsOf(world),
    surface: typeof action.cerbosAction === "string" && action.cerbosAction.startsWith("portal:") ? "portal" : "staff",
  };
}

/** What a scenario's `expect` keys mean at the pure level. Keys only an HTTP test can see are listed in HTTP_ONLY. */
const notifyEffects = (name: string) => [`notify:${name}`, `notify:${name}_once_per_post`];
const EXPECT: Record<string, (r: StageApplied, post: PipelinePostState, world: World, v: unknown) => void> = {
  status: (_r, p, _w, v) => expect(p.pipelineStatus).toBe(v),
  phase: (_r, p, _w, v) => expect(phaseOf(p)).toBe(v),
  engineStatus: (r, _p, _w, v) => expect(r.engineStatus).toBe(v),
  changeCase: (_r, p, _w, v) => expect(changeCaseOf(p)).toBe(v),
  creativeState: (_r, p, _w, v) => expect(p.creativeState).toBe(v),
  changedOnly: (_r, p, _w, v) => expect(p.changedOnly).toBe(v),
  scheduleVia: (_r, p, _w, v) => expect(p.scheduleVia).toBe(v),
  blockedFrom: (_r, p, _w, v) => expect(p.blockedFrom).toBe(v),
  skippedChecks: (r, _p, _w, v) => expect(r.appendSkippedChecks?.codes).toEqual(v),
  joinedMonthRequest: (r, _p, _w, v) => expect(r.effects.includes("join_or_open_month_request")).toBe(v),
  variantsCreated: (r, _p, _w, v) => expect(r.effects.includes("sync_variants_from_master")).toBe(v),
  scheduledAtIsApproved: (r, p, w, v) => {
    expect(r.effects.includes("schedule_by_hand_at_approved_date_time_and_placement")).toBe(v);
    expect("scheduled_at" in r.set).toBe(false);
    expect(p.scheduledAt).toBe(w.approvedSchedule?.scheduledAt);
  },
  copyLogged: (r, _p, _w, v) => {
    expect(r.effects.includes("copy_log_when_in_changes")).toBe(v);
    expect(r.copyLog.length > 0).toBe(v);
    expect(r.copyLog.every((e) => e.via === "fix")).toBe(true);
  },
  notified: (r, _p, _w, v) => {
    for (const n of v as string[]) expect(notifyEffects(n).some((e) => r.effects.includes(e)), `notify ${n}`).toBe(true);
  },
  everyReviewPending: (r, _p, _w, v) =>
    expect(["request_client_reviews_on_every_variant", "request_client_reviews"].some((e) => r.effects.includes(e))).toBe(v),
  variantsSyncedToPlacement: (r, _p, _w, v) => {
    expect(r.effects.includes("sync_variants_dates_and_networks")).toBe(v);
    expect(Array.isArray(r.set.placement)).toBe(v);
  },
  publishApprovalsFiled: (r, _p, _w, v) => expect(r.effects.includes("file_one_publish_approval_per_variant")).toBe(v),
};
/** Expectations about the activity row, which the pure core does not write (phase 2's HTTP suite asserts them). */
const HTTP_ONLY = new Set(["activityVia", "activityActor"]);

/** Bring the world along after an applied step (what the I/O effects would have done to the rows the facts read). */
function advanceWorld(world: World, step: ScpScenarioStep, r: StageApplied, post: PipelinePostState): void {
  if (step.action === "add_design") world.designCount += 1;
  if (r.effects.some((e) => ["sync_variants_from_master", "request_client_reviews", "request_client_reviews_on_every_variant"].includes(e))) {
    world.hashSeq += 1;
    world.reviewHash = `hash-${world.hashSeq}`;
    world.everyReviewPending = true;
  }
  if (step.action === "client_approve" || step.action === "record_client_approve") {
    world.everyReviewPending = false;
    world.approvedSchedule = { scheduledAt: post.scheduledAt, placement: [...post.placement] };
  }
  if (step.action === "client_change" || step.action === "record_client_change") world.everyReviewPending = false;
}

/** The scenarios of other machines: SCP-4 (boosts and the monthly budget) and SCP-5a (the monthly report). */
const OWNED_ELSEWHERE: Record<string, string> = {
  "monthly boost budget: committed, lowering and the stopped boost's spend": "SCP-4 (boosts and the monthly budget)",
  "the monthly report: Draft, HoD check, Ready, Sent": "SCP-5a (the monthly report)",
};

const POST_ACTIONS = new Set(SCP.actions.map((a) => a.action));
const isPostScenario = (sc: ScpScenario) => sc.steps.every((s) => POST_ACTIONS.has(s.action));
const POST_SCENARIOS = SCP.scenarios.filter((sc) => !(sc.name in OWNED_ELSEWHERE));

function runScenario(sc: ScpScenario): void {
  const start = startOf(sc);
  const world = start.world;
  let post = start.post;
  for (const [i, step] of sc.steps.entries()) {
    const label = `${sc.name} · step ${i + 1} ${step.action} by ${step.actor}`;
    const ctx = contextFor(step, post, world);
    const r = decide(ctx);
    if (step.refusal !== undefined) {
      expect(r.ok, label).toBe(false);
      if (!r.ok) {
        expect(r.code, label).toBe(step.refusal);
        if (step.field !== undefined) expect(r.field, label).toBe(step.field);
        expect(r.http, label).toBe(SCP.refusals[r.code]?.http ?? r.http);
      }
      continue;
    }
    if (!r.ok) throw new Error(`${label}: refused ${r.code} (${r.guard}) ${JSON.stringify(r.detail ?? r.blockers ?? r.field ?? "")}`);
    expect(r.alreadyApplied, label).toBe(false);
    const next = r.next!;
    post = scpAction(step.action)!.kind === "create" ? { ...next, ...baseContent(), title: next.title } : next;
    advanceWorld(world, step, r, post);
    for (const [k, v] of Object.entries(step.expect ?? {})) {
      if (HTTP_ONLY.has(k)) continue;
      const check = EXPECT[k];
      if (!check) throw new Error(`${label}: the adapter does not read expect.${k}`);
      check(r, post, world, v);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The fixture and the code agree
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe("SCP fixture · loads and validates", () => {
  it("is read from the module's directory and parses to the same object", () => {
    expect(SCP_FIXTURE_PATH.replace(/\\/g, "/")).toMatch(/modules\/social\/scp-stage-machine\.json$/);
    expect(JSON.parse(readFileSync(SCP_FIXTURE_PATH, "utf8"))).toEqual(SCP);
    expect(readScpFixtureText()).toBe(readFileSync(SCP_FIXTURE_PATH, "utf8"));
  });

  it("has no structural problem and no gap against the code", () => {
    expect(validateScpFixture(SCP)).toEqual([]);
    expect(machineCoverageProblems()).toEqual([]);
  });

  it("covers exactly the six change cases of the social_posts CHECK", () => {
    const tuples = SCP.changeCases.map((c) => [c.changeBy, c.changeKind, c.returnTo]);
    expect(new Set(tuples.map((t) => t.join("/")))).toEqual(new Set(CONTRACT_CHANGE_CASE_TUPLES.map((t) => t.join("/"))));
  });

  const mutate = (fn: (f: ScpFixture) => void): ScpFixture => {
    const f = structuredClone(SCP);
    fn(f);
    return f;
  };
  it.each<[string, (f: ScpFixture) => void, RegExp]>([
    ["a status missing from phaseOf", (f) => { delete (f.phaseOf as Record<string, string>).hod; }, /phaseOf has no entry for status 'hod'/],
    ["a status missing from holders", (f) => { delete (f.holders as Record<string, unknown>).final; }, /holders has no entry for status 'final'/],
    ["a status missing from the engine mapping", (f) => { delete f.engineStatus.byPipelineStatus.live; }, /byPipelineStatus has no entry for status 'live'/],
    ["a status missing from primaryAction", (f) => { delete f.primaryAction.client; }, /primaryAction has no entry for status 'client'/],
    ["an unknown Cerbos action", (f) => { f.actions[1].cerbosAction = "authorr"; }, /cerbosAction 'authorr' is not a known Cerbos action/],
    ["a from naming an unknown status", (f) => { f.actions[1].from = [{ status: "planed" }]; }, /names unknown status 'planed'/],
    ["a from naming an unknown change case", (f) => { f.actions[2].from[2].changeCase = ["copy_x"]; }, /names unknown change case 'copy_x'/],
    ["a guard refusal not catalogued", (f) => { f.actions[0].guards[0].refusal = "cycle_gone"; }, /'cycle_gone' is not in refusals/],
    ["a common guard refusal not catalogued", (f) => { f.commonGuards[0].refusal = "what_action"; }, /'what_action' is not in refusals/],
    ["a seventh change case", (f) => { f.changeCases.push({ ...f.changeCases[0], key: "hod_design", changeBy: "hod", changeKind: "design" }); }, /differ from the contract CHECK's six/],
    ["a missing change case", (f) => { f.changeCases.pop(); }, /differ from the contract CHECK's six/],
  ])("refuses to load with %s", (_n, fn, msg) => {
    expect(() => parseScpFixture(mutate(fn))).toThrow(msg);
  });
});

describe("SCP fixture · the prose the code interprets is pinned verbatim", () => {
  it("each interpreted value is the text the code reads", () => {
    expect(SCP.phaseOf.changes).toBe("from the change case: see changeCases[].phase");
    expect(SCP.holders.changes).toBe("from the change case: see changeCases[].holder");
    expect(SCP.holders.scheduled).toBe("officer when scheduleVia is 'manual'; publisher when 'publisher'");
    expect(SCP.holders.blocked).toBe("from blockWaitingOn");
    expect(SCP.primaryAction.design).toBe("start_design while creativeState is 'not_started', else submit_design");
    expect(SCP.primaryAction.changes).toEqual({ copywriter_copy: "send_to_proofread", client_copy: "send_to_proofread", hod_copy: "resend", final_copy: "resend", final_design: "submit_design", client_design: "submit_design" });
    expect(scpAction("resolve")!.to).toEqual({ from: "blockedFrom" });
    expect(scpAction("unschedule")!.cerbosAction).toEqual({ manual: "schedule", publisher: "approve" });
    expect(scpAction("unschedule")!.actors).toEqual({ manual: ["officer"], publisher: ["approver"] });
    expect(scpAction("reschedule")!.extraCerbos).toEqual({ publisher: ["cancel"] });
    expect(scpAction("create")!.extraCerbos).toEqual({ anyOf: ["author", "approve"] });
    expect(scpAction("start_design")!.effects).toEqual(["creative_state: not_started becomes in_progress; revision stays revision; in_progress replays as alreadyApplied"]);
    expect(SCP.cerbosActions.create.refusal).toBe("403 as today");
    expect(SCP.cerbosActions["portal:approve_post"].refusal).toBe("404 outside the portal scope");
    expect(SCP.portalStatusRefusal).toBe(PROSE.portalStatusRefusal);
    expect(SCP.phaseRule).toBe(PROSE.phaseRule);
    expect(SCP.editRules.at(-1)!.status).toBe("any other");
    expect(SCP.commonGuards.find((g) => g.guard === "cerbos")!.refusal).toBe(PROSE.commonCerbosRefusal);
    expect(SCP.commonGuards.find((g) => g.guard === "maker_checker")!.appliesTo).toEqual(["proofread", "approve"]);
    expect(SCP.handoffChecks.find((c) => c.code === "must_haves_unticked")!.rule.startsWith(MUST_HAVES_RULE_PREFIX)).toBe(true);
    expect(SCP.handoffChecks.find((c) => c.code === "on_image_text_missing")!.rule).toBe(ON_IMAGE_TEXT_RULE);
    expect(SCP.handoffChecks.find((c) => c.code === "too_many_hashtags")!.rule).toBe("at most 30 hashtags when Instagram is placed");
    expect(SCP.handoffChecks.find((c) => c.code === "caption_too_long")!.rule).toBe("caption plus hashtags within each placement network's limit (2,200 characters on Instagram)");
  });

  it("the interpretations read what the prose says", () => {
    expect(MUST_HAVE_KEYS).toEqual(["logo", "brand_colours", "brand_fonts", "contact_info", "handle_and_tags", "mandatory_words", "no_forbidden_claims", "price_terms_checked", "location_tag", "hashtag_set"]);
    expect(FORMATS_NEEDING_ON_IMAGE_TEXT).toEqual(["feed", "carousel", "story"]);
    // "at most 30 hashtags when Instagram is placed" and "2,200 characters on Instagram" are media-rules' numbers.
    expect(maxHashtagsFor("instagram")).toBe(30);
  });

  it("every explicit param rule carries the fixture's prose", () => {
    for (const [action, params] of Object.entries(EXPLICIT_PARAM_RULES)) {
      for (const [name, rule] of Object.entries(params)) expect(scpAction(action)!.params[name], `${action}.${name}`).toBe(rule.prose);
    }
  });

  it("the phase rule's 'equivalently' clause holds for every change case", () => {
    for (const c of SCP.changeCases) {
      const rule = c.changeBy === "client" ? "client_changes" : c.returnTo === "final" || c.changeKind === "design" ? "in_production" : "brief";
      expect(c.phase, c.key).toBe(rule);
    }
  });

  it("edit's from is exactly the statuses whose edit rule allows a field", () => {
    const fromEdit = scpAction("edit")!.from.flatMap((f) => (f.changeCase ? f.changeCase.map((cc) => `changes/${cc}`) : [f.status]));
    const editable: string[] = [];
    for (const s of SCP.statuses) {
      if (s === "changes") {
        for (const c of SCP.changeCases) {
          const p = blankPost();
          p.pipelineStatus = "changes";
          withCase(p, c.key);
          if (editableFields(p).fields.length) editable.push(`changes/${c.key}`);
        }
      } else {
        const p = blankPost();
        p.pipelineStatus = s;
        if (s === "blocked") { p.blockedFrom = "drafting"; p.blockWaitingOn = "client"; }
        if (s === "scheduled") p.scheduleVia = "manual";
        if (editableFields(p).fields.length) editable.push(s);
      }
    }
    expect(new Set(editable)).toEqual(new Set(fromEdit));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2 and 3. The scenarios
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe("SCP scenarios · every post-machine scenario runs green at the pure level", () => {
  it("each scenario is either the post machine's or named as owned elsewhere", () => {
    for (const sc of SCP.scenarios) {
      if (sc.name in OWNED_ELSEWHERE) expect(isPostScenario(sc), `${sc.name} is listed as owned elsewhere but is all post actions`).toBe(false);
      else expect(isPostScenario(sc), `scenario '${sc.name}' has non-post actions and is not listed in OWNED_ELSEWHERE`).toBe(true);
    }
    for (const name of Object.keys(OWNED_ELSEWHERE)) expect(SCP.scenarios.some((s) => s.name === name), name).toBe(true);
    expect(POST_SCENARIOS.length).toBe(SCP.scenarios.length - Object.keys(OWNED_ELSEWHERE).length);
    expect(POST_SCENARIOS.length).toBeGreaterThanOrEqual(18);
  });

  it.each(POST_SCENARIOS.map((sc) => [sc.name, sc] as const))("%s", (_name, sc) => {
    runScenario(sc);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. The mappings, for every status and change case
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

function postIn(status: string, changeCase?: string, extra: Partial<PipelinePostState> = {}): PipelinePostState {
  const p = blankPost();
  p.pipelineStatus = status;
  p.authorId = IDS.officer;
  if (changeCase) withCase(p, changeCase);
  if (status === "scheduled" || status === "live") p.scheduleVia = "manual";
  if (status === "blocked") { p.blockedFrom = "drafting"; p.blockWaitingOn = "client"; p.blockReason = "Mock."; p.blockedAt = NOW.toISOString(); }
  if (status === "design") { p.creativeSource = "creatives"; p.creativeState = "not_started"; }
  return Object.assign(p, extra);
}

const NON_CHANGE = SCP.statuses.filter((s) => s !== "changes");

describe("SCP mappings · phase, holder, engine status and primary action", () => {
  const PHASE: Record<string, string> = {
    planned: "brief", drafting: "brief", blocked: "brief", proofread: "in_production", hod: "in_production", design: "in_production",
    final: "in_production", client: "with_client", approved: "client_approved", scheduled: "client_approved", live: "posted",
  };
  const CASE_PHASE: Record<string, string> = {
    copywriter_copy: "brief", hod_copy: "brief", final_copy: "in_production", final_design: "in_production", client_copy: "client_changes", client_design: "client_changes",
  };
  const HOLDER: Record<string, string | null> = {
    planned: "officer", drafting: "officer", proofread: "copywriter", hod: "approver", design: "designer", final: "approver",
    client: "client", approved: "officer", scheduled: "officer", live: null, blocked: "client",
  };
  const CASE_HOLDER: Record<string, string> = {
    copywriter_copy: "officer", hod_copy: "officer", final_copy: "officer", final_design: "designer", client_copy: "officer", client_design: "designer",
  };
  const ENGINE: Record<string, string> = {
    planned: "draft", drafting: "draft", proofread: "draft", hod: "draft", design: "draft", final: "draft", changes: "draft", blocked: "draft",
    client: "in_review", approved: "approved", scheduled: "scheduled", live: "published",
  };
  const PRIMARY: Record<string, string> = {
    planned: "start_draft", drafting: "send_to_proofread", proofread: "approve_copy", hod: "approve_for_design", design: "start_design",
    final: "final_approve", client: "follow_up", approved: "schedule", scheduled: "mark_live", live: "request_boost", blocked: "resolve",
  };

  it("the pins cover every status and change case", () => {
    expect(new Set([...Object.keys(PHASE), "changes"])).toEqual(new Set(SCP.statuses));
    expect(new Set(Object.keys(CASE_PHASE))).toEqual(new Set(SCP.changeCases.map((c) => c.key)));
    expect(new Set(Object.keys(ENGINE))).toEqual(new Set(SCP.statuses));
  });

  it.each(NON_CHANGE)("status %s", (s) => {
    const p = postIn(s);
    expect(phaseOf(p)).toBe(PHASE[s]);
    expect(holderOf(p)).toBe(HOLDER[s]);
    expect(engineStatusOf(p, [], false)).toBe(ENGINE[s]);
    expect(primaryActionOf(p)).toBe(PRIMARY[s]);
  });

  it.each(SCP.changeCases.map((c) => c.key))("changes · %s", (cc) => {
    const p = postIn("changes", cc);
    expect(phaseOf(p)).toBe(CASE_PHASE[cc]);
    expect(holderOf(p)).toBe(CASE_HOLDER[cc]);
    expect(engineStatusOf(p, [], false)).toBe("draft");
    expect(primaryActionOf(p)).toBe((SCP.primaryAction.changes as Record<string, string>)[cc]);
  });

  it("blocked: the phase stays brief and the holder is who we wait on, whatever the kept change case", () => {
    for (const w of ["client", "designer", "copywriter", "approver", "officer", "external"]) {
      const p = postIn("blocked", "final_design", { blockedFrom: "changes", blockWaitingOn: w });
      expect(phaseOf(p)).toBe("brief");
      expect(holderOf(p)).toBe(w);
      expect(changeCaseOf(p)).toBe("final_design");
    }
  });

  it("scheduled: the holder follows scheduleVia", () => {
    expect(holderOf(postIn("scheduled", undefined, { scheduleVia: "manual" }))).toBe("officer");
    expect(holderOf(postIn("scheduled", undefined, { scheduleVia: "publisher" }))).toBe("publisher");
  });

  it("design: the primary action follows creativeState", () => {
    expect(primaryActionOf(postIn("design", undefined, { creativeState: "not_started" }))).toBe("start_design");
    expect(primaryActionOf(postIn("design", undefined, { creativeState: "in_progress" }))).toBe("submit_design");
    expect(primaryActionOf(postIn("design", undefined, { creativeState: "revision" }))).toBe("submit_design");
  });

  it("engine status: the overrides, top to bottom", () => {
    expect(engineStatusOf(postIn("scheduled"), ["scheduled", "failed"], false)).toBe("failed");
    expect(engineStatusOf(postIn("scheduled"), ["publishing", "failed"], false)).toBe("failed");
    expect(engineStatusOf(postIn("scheduled"), ["publishing"], false)).toBe("publishing");
    expect(engineStatusOf(postIn("live"), ["published", "failed"], false)).toBe("partially_published");
    expect(engineStatusOf(postIn("live"), ["publishing"], false)).toBe("published");
    expect(engineStatusOf(postIn("approved"), [], true)).toBe("archived");
    expect(engineStatusOf(postIn("scheduled"), ["failed"], true)).toBe("archived");
    expect(engineStatusOf({ pipelineStatus: null }, [], false)).toBeNull();
  });

  it("actionsFromStatus lists the fixture actions whose from matches", () => {
    expect(actionsFromStatus(postIn("planned")).sort()).toEqual(["archive", "block", "discard", "edit", "start_draft"]);
    expect(actionsFromStatus(postIn("live"))).toEqual([]);
    expect(actionsFromStatus(postIn("changes", "client_design")).sort()).toEqual(
      ["add_design", "archive", "block", "client_undo", "follow_up", "remove_design", "start_design", "submit_design"],
    );
  });

  it("editableFields follows editRules", () => {
    expect(editableFields(postIn("planned")).fields).toEqual(SCP.fieldGroups.planning);
    expect(new Set(editableFields(postIn("drafting")).fields)).toEqual(new Set([...SCP.fieldGroups.planning, ...SCP.fieldGroups.copy]));
    const team = editableFields(postIn("changes", "hod_copy"));
    expect(new Set(team.fields)).toEqual(new Set([...SCP.fieldGroups.copy, "scheduledAt", "mustHaves", "placement"]));
    expect(team.copyLog).toBe(true);
    const client = editableFields(postIn("changes", "client_copy"));
    expect(client.fields.includes("placement")).toBe(false);
    expect(client.fields.includes("scheduledAt")).toBe(true);
    for (const s of ["proofread", "hod", "design", "final", "client", "approved", "scheduled", "live", "blocked"]) {
      expect(editableFields(postIn(s)), s).toEqual({ fields: [], copyLog: false, refusal: "field_locked" });
    }
    expect(editableFields(postIn("changes", "final_design")).fields).toEqual([]);
  });

  it("postStateFromRow maps a social_posts row", () => {
    const p = postStateFromRow({
      id: UUID_A, pipeline_status: "changes", deleted_at: null, archived_at: new Date("2026-11-01T00:00:00Z"), author_id: "u1",
      change_by: "hod", change_kind: "copy", return_to: "hod", change_note: "n", changed_only: false, copy_before: null,
      blocked_from: null, block_reason: null, block_waiting_on: null, blocked_at: null, creative_source: null, creative_state: null,
      schedule_via: null, client_first_sent_at: null, last_action_id: null, title: "t", format: "feed", pillar: null, angle: null,
      objective: null, key_message: "k", visual_direction: null, raw_assets: [], placement: ["instagram"], scheduled_at: new Date(FUTURE),
      must_haves: [], caption: "c", on_asset_text: null, cta: null, hashtags: [], suggestions: {},
    });
    expect(p.archived).toBe(true);
    expect(p.keyMessage).toBe("k");
    expect(p.scheduledAt).toBe(FUTURE);
    expect(changeCaseOf(p)).toBe("hod_copy");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Every refusal code is reachable through decide()
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A persona that passes each primary Cerbos action (and is never the maker on proofread and approve). */
const PERSONA_FOR: Record<string, string> = {
  author: "officer", schedule: "officer", manage: "officer", record_client: "officer", boost: "officer",
  proofread: "copywriter", approve: "approver", design: "designer", create: "officer", "portal:approve_post": "client",
};

/** A valid body for each action. */
const VALID_PARAMS: Record<string, Record<string, unknown>> = {
  create: { id: UUID_A, title: "Mock post", isExtra: false, format: "feed", pillar: "Product", scheduledAt: FUTURE, placement: ["instagram"] },
  start_draft: {},
  edit: { fields: { title: "Mock post, again" } },
  accept_suggestion: { field: "caption" },
  send_to_proofread: {},
  suggest: { field: "caption", value: "Fresh pastries, every morning." },
  approve_copy: {},
  return_copy: { note: "Tighten the opening." },
  approve_for_design: {},
  hod_changes: { note: "Use the promo name." },
  resend: {},
  start_design: {},
  add_design: { assetGroupId: UUID_A, position: 1 },
  remove_design: { designId: UUID_A },
  submit_design: {},
  final_approve: {},
  final_changes: { changeKind: "copy", note: "Fix the price." },
  client_approve: { seenHash: "hash-1" },
  client_change: { changeKind: "design", note: "Brighter, please.", anchor: { x: 0.5, y: 0.25, fileId: UUID_A }, seenHash: "hash-1" },
  client_undo: {},
  record_client_approve: { channel: "email", note: "Approved by email." },
  record_client_change: { changeKind: "copy", channel: "meeting", note: "Asked in a meeting." },
  schedule: {},
  schedule_publisher: {},
  unschedule: {},
  reschedule: { at: "2026-11-25T10:00:00.000Z" },
  mark_live: { url: "https://example.invalid/p/1" },
  block: { reason: "Waiting for photos.", waitingOn: "client" },
  resolve: {},
  follow_up: { note: "Any news?" },
  discard: {},
  archive: { reason: "Client cancelled." },
};

function baseline(actionName: string): StageContext {
  const a = scpAction(actionName)!;
  const isCreate = a.kind === "create";
  const fr = a.from[0];
  const post = isCreate ? null : postIn(fr?.status ?? "planned", fr?.changeCase?.[0]);
  if (post) {
    if (post.pipelineStatus === "design" || (post.pipelineStatus === "changes" && DESIGN_CASES.has(changeCaseOf(post) ?? ""))) {
      post.creativeSource = "creatives";
      post.creativeState = post.pipelineStatus === "design" ? "not_started" : "revision";
    }
    if (AFTER_DESIGN.has(post.pipelineStatus!)) { post.creativeSource = "creatives"; post.creativeState = "submitted"; }
    if (actionName === "accept_suggestion") post.suggestions = { caption: { value: "Better caption.", base: post.caption, by: IDS.copywriter, at: NOW.toISOString() } };
  }
  const world: World = {
    officerId: IDS.officer, creativeSource: "creatives", designCount: 1, reviewHash: "hash-1", hashSeq: 1, everyReviewPending: true,
    approvedSchedule: { scheduledAt: FUTURE, placement: ["instagram"] }, publisherAvailable: true,
  };
  const persona = PERSONA_FOR[typeof a.cerbosAction === "string" ? a.cerbosAction : a.cerbosAction.manual];
  const id = IDS[persona];
  return {
    action: actionName,
    params: structuredClone(VALID_PARAMS[actionName]),
    post,
    principal: { userId: id, isAutomation: false, isAuthor: post?.authorId === id, isOfficer: world.officerId === id },
    cerbos: cerbosOracle(persona, post, world),
    expectedStatus: post?.pipelineStatus ?? undefined,
    facts: factsOf(world),
    surface: typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:") ? "portal" : "staff",
  };
}

/** For each fixture guard, a change that makes it refuse (and leaves the others passing). */
const GUARD_FAILERS: Record<string, (c: StageContext) => void> = {
  cycle_exists: (c) => { c.facts.cycleExists = false; },
  fields_allowed_in_status: (c) => { c.params = { fields: { caption: "Locked in planned." } }; },
  suggestion_exists: (c) => { c.post!.suggestions = {}; },
  required_to_send: (c) => { c.post!.caption = ""; },
  handoff_checks_pass_or_send_anyway: (c) => { c.post!.mustHaves = []; },
  suggestions_not_stale: (c) => { c.post!.suggestions = { caption: { value: "New.", base: "An older caption.", by: IDS.copywriter, at: NOW.toISOString() } }; },
  creatives_unit_exists_when_source_creatives: (c) => { c.facts.engagementCreativeSource = "creatives"; c.facts.creativesUnitExists = false; },
  asset_exists: (c) => { c.facts.assetExists = false; },
  design_exists: (c) => { c.facts.designExists = false; },
  design_present: (c) => { c.facts.designCount = 0; },
  designs_stored: (c) => { c.facts.unstoredDesignIds = ["d-link-only"]; },
  one_account_per_placement_network: (c) => { c.facts.accountsByNetwork = {}; },
  account_not_ambiguous: (c) => { c.facts.accountsByNetwork = { instagram: 2 }; },
  seen_hash_matches: (c) => { c.params.seenHash = "hash-stale"; },
  every_variant_review_pending: (c) => { c.facts.everyReviewPending = false; },
  own_decision: (c) => { c.facts.decidedByThisContact = false; },
  within_undo_window: (c) => { c.facts.withinUndoWindow = false; },
  nothing_happened_since: (c) => { c.facts.nothingHappenedSince = false; },
  approved_time_not_passed: (c) => { c.facts.approvedSchedule = { scheduledAt: PAST, placement: ["instagram"] }; },
  media_rules_pass: (c) => { c.facts.mediaFailures = [{ variantId: "v1", errors: [{ rule: "media_required", message: "x" }] }]; },
  publisher_available: (c) => { c.facts.publisherAvailable = false; },
  no_variant_publishing: (c) => { c.facts.anyVariantPublishing = true; },
  something_changes: (c) => { c.params = {}; },
  holder_is_someone_else: (c) => { c.facts.callerHoldsPost = true; },
  once_per_holder_per_24h: (c) => { c.facts.lastFollowUpAt = new Date(NOW.getTime() - 3600_000).toISOString(); },
};

const produced = new Set<string>();
const run = (c: StageContext): StageResult => {
  const r = decide(c);
  if (!r.ok) produced.add(r.code);
  return r;
};

describe("SCP refusals · every code a guard names is reachable", () => {
  it.each(SCP.actions.map((a) => a.action))("%s: the baseline applies", (name) => {
    const r = run(baseline(name));
    if (!r.ok) throw new Error(`${name} baseline refused ${r.code} (${r.guard}) ${JSON.stringify(r.detail ?? r.field ?? r.blockers ?? "")}`);
    expect(r.ok).toBe(true);
  });

  it.each(SCP.actions.flatMap((a) => a.guards.map((g) => [`${a.action} · ${g.guard}`, a.action, g.guard, g.refusal] as const)))(
    "%s",
    (_l, action, guard, refusal) => {
      const c = baseline(action);
      const failer = GUARD_FAILERS[guard];
      if (!failer) throw new Error(`no failer for guard ${guard}`);
      failer(c);
      const r = run(c);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(refusal);
        expect(r.guard).toBe(guard);
        expect(r.http).toBe(SCP.refusals[refusal].http);
      }
    },
  );

  it.each(SCP.actions.map((a) => a.action))("%s: the common steps refuse in order", (name) => {
    const a = scpAction(name)!;
    const isCreate = a.kind === "create";
    // 1. unknown action
    expect(run({ ...baseline(name), action: `${name}_nope` })).toMatchObject({ ok: false, code: "unknown_action", http: 400 });
    if (!isCreate) {
      // 2. no post; a deleted post
      expect(run({ ...baseline(name), post: null })).toMatchObject({ ok: false, code: "post_not_found", http: 404 });
      const del = baseline(name);
      del.post!.deleted = true;
      expect(run(del)).toMatchObject({ code: "post_not_found" });
      // 3. a Composer post
      const comp = baseline(name);
      comp.post!.pipelineStatus = null;
      expect(run(comp)).toMatchObject({ code: "not_a_pipeline_post", http: 409 });
      // 4. a replay answers alreadyApplied, before anything else is judged
      const rep = baseline(name);
      rep.post!.lastActionId = UUID_A;
      rep.actionId = UUID_A;
      rep.cerbos = {};
      expect(decide(rep)).toMatchObject({ ok: true, alreadyApplied: true, set: {} });
      // 5. archived
      const arc = baseline(name);
      arc.post!.archived = true;
      expect(run(arc)).toMatchObject({ code: "post_archived", http: 409 });
    }
    // 6. an unattended automation
    const bot = baseline(name);
    bot.principal = { ...bot.principal, isAutomation: true };
    expect(run(bot)).toMatchObject({ code: "automation_cannot_act", http: 403 });
    // 7. maker/checker, on proofread and approve
    const mc = baseline(name);
    mc.principal = { ...mc.principal, isAuthor: true };
    const appliesTo = SCP.commonGuards.find((g) => g.guard === "maker_checker")!.appliesTo!;
    if (typeof a.cerbosAction === "string" && appliesTo.includes(a.cerbosAction)) expect(run(mc)).toMatchObject({ code: "author_cannot_approve", http: 403 });
    else expect(run(mc).ok).toBe(true);
    // 8. Cerbos: the primary action's code
    const den = baseline(name);
    for (const k of Object.keys(den.cerbos)) den.cerbos[k] = false;
    const primary = cerbosChecksFor(a, den.post)[0];
    expect(run(den)).toMatchObject({ ok: false, code: primary.refusal.code, http: primary.refusal.http });
    if (!isCreate) {
      // 9. expectedStatus
      const st = baseline(name);
      st.expectedStatus = st.post!.pipelineStatus === "live" ? "planned" : "live";
      expect(run(st)).toMatchObject({ code: "status_changed", http: 409, detail: { status: st.post!.pipelineStatus, phase: phaseOf(st.post!) } });
      const noExp = baseline(name);
      noExp.expectedStatus = undefined;
      expect(run(noExp)).toMatchObject({ code: "missing_field", field: "expectedStatus" });
      // 10. the status is not in from (live is in no action's from)
      const tr = baseline(name);
      // A designed post, so the designer's Cerbos rule (creativeSource) passes and the status check is what refuses.
      tr.post = postIn("live", undefined, { creativeSource: "creatives", creativeState: "submitted" });
      tr.expectedStatus = "live";
      tr.cerbos = cerbosOracle(PERSONA_FOR[typeof a.cerbosAction === "string" ? a.cerbosAction : a.cerbosAction.manual], tr.post, { officerId: IDS.officer } as World);
      const expected = tr.surface === "portal" ? "post_not_with_client" : "invalid_transition";
      expect(run(tr)).toMatchObject({ code: expected, http: 409 });
    }
    // 11. the body: a value of the wrong shape, and a required one left out
    for (const p of Object.keys(a.params)) {
      const bad = baseline(name);
      bad.params[p] = { bogus: true };
      expect(run(bad), `${name}.${p}`).toMatchObject({ ok: false, code: "invalid_field" });
    }
    const badId = baseline(name);
    badId.actionId = "not-a-uuid";
    if (!isCreate) expect(run(badId)).toMatchObject({ code: "invalid_field", field: "actionId" });
  });

  it("required params left out answer missing_field with the field", () => {
    const cases: Array<[string, string]> = [
      ["create", "title"], ["return_copy", "note"], ["hod_changes", "note"], ["final_changes", "changeKind"], ["final_changes", "note"],
      ["client_approve", "seenHash"], ["client_change", "changeKind"], ["client_change", "seenHash"], ["record_client_approve", "channel"],
      ["record_client_change", "note"], ["mark_live", "url"], ["block", "reason"], ["block", "waitingOn"], ["archive", "reason"],
      ["accept_suggestion", "field"], ["suggest", "field"], ["suggest", "value"], ["remove_design", "designId"], ["edit", "fields"],
      ["add_design", "assetGroupId"],
    ];
    for (const [action, field] of cases) {
      const c = baseline(action);
      delete c.params[field];
      expect(run(c), `${action}.${field}`).toMatchObject({ ok: false, code: "missing_field", field });
    }
  });

  it("the extra Cerbos checks: create's author-or-approve, reschedule's cancel on a publisher schedule", () => {
    const cr = baseline("create");
    cr.cerbos = { ...cr.cerbos, create: true, author: false, approve: false };
    expect(run(cr)).toMatchObject({ code: "not_officer_or_approver", http: 403 });
    cr.cerbos.approve = true;
    expect(run(cr).ok).toBe(true);
    const cr2 = baseline("create");
    cr2.cerbos = { ...cr2.cerbos, create: false };
    expect(run(cr2)).toMatchObject({ code: "not_authorized", http: 403, generic: true });

    const rs = baseline("reschedule");
    rs.post = postIn("scheduled", undefined, { scheduleVia: "publisher", creativeSource: "creatives", creativeState: "submitted" });
    rs.expectedStatus = "scheduled";
    expect(cerbosActionsToAsk("reschedule", rs.post)).toEqual(["schedule", "cancel"]);
    rs.cerbos = { ...rs.cerbos, schedule: true, cancel: false };
    expect(run(rs)).toMatchObject({ code: "cancel_required", http: 403 });
    rs.cerbos.cancel = true;
    expect(run(rs).ok).toBe(true);
    expect(cerbosActionsToAsk("reschedule", postIn("approved"))).toEqual(["schedule"]);
  });

  it("unschedule asks its Cerbos action by scheduleVia", () => {
    expect(cerbosActionsToAsk("unschedule", postIn("scheduled", undefined, { scheduleVia: "manual" }))).toEqual(["schedule"]);
    expect(cerbosActionsToAsk("unschedule", postIn("scheduled", undefined, { scheduleVia: "publisher" }))).toEqual(["approve"]);
    const u = baseline("unschedule");
    u.post!.scheduleVia = "publisher";
    expect(run(u)).toMatchObject({ code: "not_an_approver" });
  });

  it("a portal post outside the scope reads 404 post_not_found; the staff route does not take the client's actions", () => {
    const c = baseline("client_approve");
    c.cerbos["portal:approve_post"] = false;
    expect(run(c)).toMatchObject({ code: "post_not_found", http: 404 });
    const s = baseline("client_approve");
    s.surface = "staff";
    expect(run(s)).toMatchObject({ code: "unknown_action" });
    const p = baseline("approve_for_design");
    p.surface = "portal";
    expect(run(p)).toMatchObject({ code: "unknown_action" });
  });

  it("the follow-up refusal carries retryAfterSeconds", () => {
    const c = baseline("follow_up");
    c.facts.lastFollowUpAt = new Date(NOW.getTime() - 3600_000).toISOString();
    expect(decide(c)).toMatchObject({ code: "follow_up_too_soon", retryAfterSeconds: 23 * 3600 });
  });

  it("every refusal code a guard, a Cerbos action or a common step names was produced", () => {
    const named = new Set<string>();
    for (const a of SCP.actions) {
      for (const g of a.guards) named.add(g.refusal);
      for (const c of cerbosChecksFor(a, postIn("scheduled", undefined, { scheduleVia: "publisher" }))) if (!c.refusal.generic) named.add(c.refusal.code);
      for (const c of cerbosChecksFor(a, postIn("scheduled", undefined, { scheduleVia: "manual" }))) if (!c.refusal.generic) named.add(c.refusal.code);
    }
    for (const g of SCP.commonGuards) if (g.refusal && isCodeToken(g.refusal)) named.add(g.refusal);
    for (const code of ["missing_field", "invalid_field", "cancel_required", "not_officer_or_approver", "post_not_with_client"]) named.add(code);
    const missing = [...named].filter((c) => !produced.has(c));
    expect(missing).toEqual([]);
  });
});

// ── The output a transaction writes ────────────────────────────────────────────────────────────────────────────────

describe("SCP decide · the column changes", () => {
  const ok = (r: StageResult): StageApplied => {
    if (!r.ok) throw new Error(`refused ${r.code}`);
    return r;
  };

  it("create writes the new row's columns", () => {
    const r = ok(decide(baseline("create")));
    expect(r.set).toMatchObject({
      id: UUID_A, title: "Mock post", is_extra: false, format: "feed", pillar: "Product", scheduled_at: FUTURE, placement: ["instagram"],
      pipeline_status: "planned", status: "draft", status_since: NOW.toISOString(), cycle_id: "c-cycle", engagement_id: "e-engagement",
    });
    expect(r.effects).toEqual(["content_month_progress"]);
    expect("last_action_id" in r.set).toBe(false);
    expect(r.from).toBeNull();
    expect(r.to).toBe("planned");
  });

  it("a create replay (the id exists) answers alreadyApplied", () => {
    const c = baseline("create");
    c.post = postIn("planned");
    expect(decide(c)).toMatchObject({ ok: true, alreadyApplied: true });
  });

  it("start_draft sets the author once", () => {
    const c = baseline("start_draft");
    c.post!.authorId = null;
    expect(ok(decide(c)).set.author_id).toBe(IDS.officer);
    expect("author_id" in ok(decide(baseline("start_draft"))).set).toBe(false);
  });

  it("block keeps the change case and records where it came from; resolve returns", () => {
    const c = baseline("block");
    c.post = postIn("changes", "final_design", { creativeSource: "creatives", creativeState: "revision" });
    c.expectedStatus = "changes";
    const r = ok(decide(c));
    expect(r.set).toMatchObject({ pipeline_status: "blocked", blocked_from: "changes", block_reason: "Waiting for photos.", block_waiting_on: "client", blocked_at: NOW.toISOString(), status: "draft" });
    expect("change_by" in r.set).toBe(false);
    expect(r.changeCase).toEqual({ before: "final_design", after: "final_design" });
    const back = baseline("resolve");
    back.post = r.next!;
    back.expectedStatus = "blocked";
    const r2 = ok(decide(back));
    expect(r2.set).toMatchObject({ pipeline_status: "changes", blocked_from: null, block_reason: null, block_waiting_on: null, blocked_at: null });
    expect(r2.effects).toContain("notify:holder");
  });

  it("send anyway appends the skipped checks; no reason means 400", () => {
    const c = baseline("send_to_proofread");
    c.post!.mustHaves = [];
    c.params = { sendAnyway: true, sendAnywayReason: "Client confirmed by phone." };
    const r = ok(decide(c));
    expect(r.appendSkippedChecks).toEqual({ codes: ["must_haves_unticked"], reason: "Client confirmed by phone.", by: IDS.officer, at: NOW.toISOString() });
    expect(r.activity.metadata.checksSkipped).toEqual(["must_haves_unticked"]);
    c.params = { sendAnyway: true, sendAnywayReason: "short" };
    expect(decide(c)).toMatchObject({ code: "invalid_field", field: "sendAnywayReason" });
    c.post!.caption = "";
    c.params = { sendAnyway: true, sendAnywayReason: "Client confirmed by phone." };
    expect(decide(c)).toMatchObject({ code: "incomplete_post", blockers: [{ code: "caption_missing" }] });
  });

  it("approve_copy applies every suggestion and logs each field", () => {
    const c = baseline("approve_copy");
    c.post!.suggestions = {
      caption: { value: "Better caption.", base: c.post!.caption, by: IDS.copywriter, at: NOW.toISOString() },
      hashtags: { value: ["mockbakery", "pastry"], base: c.post!.hashtags, by: IDS.copywriter, at: NOW.toISOString() },
    };
    const r = ok(decide(c));
    expect(r.set).toMatchObject({ caption: "Better caption.", hashtags: ["mockbakery", "pastry"], suggestions: {}, pipeline_status: "hod" });
    expect(r.copyLog.map((e) => [e.field, e.via, e.suggestedBy, e.stage])).toEqual([["caption", "suggestion", IDS.copywriter, "proofread"], ["hashtags", "suggestion", IDS.copywriter, "proofread"]]);
    expect(r.effects).toContain("notify:approvers");
    expect(r.effects).not.toContain("notify:client");
  });

  it("suggest stores the base; a null value drops it", () => {
    const c = baseline("suggest");
    const r = ok(decide(c));
    expect(r.set.suggestions).toEqual({ caption: { value: "Fresh pastries, every morning.", base: c.post!.caption, by: IDS.copywriter, at: NOW.toISOString() } });
    c.post!.suggestions = r.set.suggestions as PipelinePostState["suggestions"];
    c.params = { field: "caption", value: null };
    expect(ok(decide(c)).set.suggestions).toEqual({});
  });

  it("start_design: in_progress is a replay", () => {
    const c = baseline("start_design");
    c.post!.creativeState = "in_progress";
    expect(decide(c)).toMatchObject({ ok: true, alreadyApplied: true, set: {} });
  });

  it("archive keeps pipeline_status and sets the engine status to archived; discard soft-deletes", () => {
    const c = baseline("archive");
    const r = ok(decide(c));
    expect(r.to).toBe("archived");
    expect("pipeline_status" in r.set).toBe(false);
    expect(r.set).toMatchObject({ archived_at: NOW.toISOString(), archived_by: IDS.officer, archive_reason: "Client cancelled.", status: "archived" });
    expect(r.effects).toEqual(["withdraw_pending_client_reviews", "withdraw_pending_publish_approvals", "content_month_progress"]);
    const d = ok(decide(baseline("discard")));
    expect(d.to).toBe("deleted");
    expect(d.set).toMatchObject({ deleted_at: NOW.toISOString() });
    expect(d.next).toBeNull();
  });

  it("mark_live by the publisher takes the first published variant's link", () => {
    const c = baseline("mark_live");
    c.principal = { isAutomation: false, isAuthor: false, isOfficer: false, isPublisher: true };
    c.cerbos = {};
    c.params = {};
    c.facts.publisherLiveUrl = "https://example.invalid/p/2";
    const r = ok(decide(c));
    expect(r.set).toMatchObject({ pipeline_status: "live", live_url: "https://example.invalid/p/2", went_live_at: NOW.toISOString(), status: "published" });
    expect(r.effects).toContain("from_published_variants");
    expect(r.effects).not.toContain("variants_become_native_import_published");
  });

  it("the engine status of a scheduled post reads its variants", () => {
    const c = baseline("schedule");
    c.facts.variantStatuses = ["failed"];
    expect(ok(decide(c)).set.status).toBe("failed");
    const m = baseline("schedule");
    delete m.facts.variantStatuses;
    expect(() => decide(m)).toThrow(/variantStatuses/);
  });

  it("an action without an actionId clears last_action_id; with one, records it", () => {
    expect(ok(decide(baseline("start_draft"))).set.last_action_id).toBeNull();
    const c = baseline("start_draft");
    c.actionId = UUID_A;
    expect(ok(decide(c)).set).toMatchObject({ last_action_id: UUID_A, last_action_at: NOW.toISOString() });
  });

  it("probe decides actions[] without a body", () => {
    const c = baseline("send_to_proofread");
    c.post!.mustHaves = []; // soft checks never block the button: send anyway exists
    expect(probe({ ...c, facts: {} })).toEqual({ action: "send_to_proofread", allowed: true });
    c.post!.caption = "";
    expect(probe({ ...c, facts: factsOf({ officerId: IDS.officer, creativeSource: "creatives", designCount: 0, reviewHash: null, hashSeq: 1, everyReviewPending: false, approvedSchedule: null, publisherAvailable: false }) })).toEqual({
      action: "send_to_proofread", allowed: false, reason: "incomplete_post",
    });
    const a = baseline("approve_for_design");
    a.principal = { ...a.principal, isAuthor: true };
    expect(probe(a)).toEqual({ action: "approve_for_design", allowed: false, reason: "author_cannot_approve" });
  });

  it("a missing fact is the caller's bug, not a pass", () => {
    const c = baseline("final_approve");
    delete c.facts.unstoredDesignIds;
    expect(() => decide(c)).toThrow(/unstoredDesignIds/);
    const n = baseline("start_draft");
    delete n.cerbos.author;
    expect(() => decide(n)).toThrow(/no Cerbos decision/);
  });

  it("every guard implementation is used by the fixture", () => {
    const used = new Set(SCP.actions.flatMap((a) => a.guards.map((g) => g.guard)));
    expect(Object.keys(GUARDS).filter((g) => !used.has(g))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 6. The hand-off checks (§63.3.4)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

function handoffBase(): HandoffInput {
  const c = baseContent();
  return {
    format: c.format, caption: c.caption, scheduledAt: c.scheduledAt, placement: c.placement, hashtags: c.hashtags,
    onAssetText: c.onAssetText, mustHaves: c.mustHaves, rawAssets: c.rawAssets, platforms: ["instagram", "facebook", "x"],
    hashtagSets: [{ name: "Core", tags: ["mockbakery"] }], readyBy: READY_BY,
  };
}

const HANDOFF_FAILERS: Record<string, (i: HandoffInput) => void> = {
  format_missing: (i) => { i.format = null; i.onAssetText = "x"; },
  caption_missing: (i) => { i.caption = "   "; },
  date_missing: (i) => { i.scheduledAt = null; },
  placement_missing: (i) => { i.placement = []; },
  must_haves_unticked: (i) => { i.mustHaves = ["logo"]; },
  caption_too_long: (i) => { i.caption = "a".repeat(2190); i.hashtags = ["mockbakery"]; },
  too_many_hashtags: (i) => { i.hashtags = Array.from({ length: 31 }, (_v, n) => `tag${n}`); },
  on_image_text_missing: (i) => { i.onAssetText = " "; },
  asset_link_missing: (i) => { i.rawAssets = [{ url: "", source: "own" }]; },
  asset_source_unknown: (i) => { i.rawAssets = [{ url: "https://example.invalid/a.jpg", source: "unknown" }]; },
  ai_note_missing: (i) => { i.rawAssets = [{ url: "https://example.invalid/a.jpg", source: "ai", aiNote: "" }]; },
  date_before_ready_by: (i) => { i.scheduledAt = "2026-11-10T10:00:00.000Z"; },
};

describe("SCP hand-off checks · each refuses and passes", () => {
  it("the base input passes every check", () => {
    expect(failingRequiredToSend(handoffBase())).toEqual([]);
    expect(failingHandoffChecks(handoffBase())).toEqual([]);
    expect(readChecks(handoffBase()).every((c) => c.ok)).toBe(true);
  });

  it("there is a failer for exactly the fixture's codes", () => {
    expect(new Set(Object.keys(HANDOFF_FAILERS))).toEqual(new Set([...SCP.requiredToSend, ...SCP.handoffChecks].map((c) => c.code)));
  });

  it.each(SCP.requiredToSend.map((c) => c.code))("hard · %s fails alone", (code) => {
    const i = handoffBase();
    HANDOFF_FAILERS[code](i);
    expect(failingRequiredToSend(i).map((b) => b.code)).toEqual([code]);
    const d = decideSend(i, { sendAnyway: true, sendAnywayReason: "Client confirmed by phone." });
    expect(d).toMatchObject({ ok: false, code: "incomplete_post", http: 409 });
    expect(readChecks(i).find((c) => c.code === code)).toMatchObject({ ok: false, skippable: false });
  });

  it.each(SCP.handoffChecks.map((c) => c.code))("soft · %s fails alone and is skippable with a reason", (code) => {
    const i = handoffBase();
    HANDOFF_FAILERS[code](i);
    expect(failingRequiredToSend(i)).toEqual([]);
    expect(failingHandoffChecks(i).map((b) => b.code)).toEqual([code]);
    expect(decideSend(i, {})).toMatchObject({ ok: false, code: "checks_failed", http: 409, blockers: [{ code }] });
    expect(decideSend(i, { sendAnyway: true })).toMatchObject({ ok: false, code: "missing_field", field: "sendAnywayReason", http: 400 });
    expect(decideSend(i, { sendAnyway: true, sendAnywayReason: "too short" })).toMatchObject({ code: "invalid_field", field: "sendAnywayReason" });
    expect(decideSend(i, { sendAnyway: true, sendAnywayReason: "x".repeat(501) })).toMatchObject({ code: "invalid_field" });
    expect(decideSend(i, { sendAnyway: true, sendAnywayReason: "Client confirmed by phone." })).toEqual({ ok: true, skippedCodes: [code], reason: "Client confirmed by phone." });
    expect(readChecks(i).find((c) => c.code === code)).toMatchObject({ ok: false, skippable: true });
  });

  it("blockers list every failing check at once, in the fixture's order", () => {
    const i = handoffBase();
    HANDOFF_FAILERS.must_haves_unticked(i);
    HANDOFF_FAILERS.date_before_ready_by(i);
    HANDOFF_FAILERS.asset_source_unknown(i);
    expect(failingHandoffChecks(i).map((b) => b.code)).toEqual(["must_haves_unticked", "asset_source_unknown", "date_before_ready_by"]);
    const h = handoffBase();
    h.format = null;
    h.caption = "";
    expect(failingRequiredToSend(h).map((b) => b.code)).toEqual(["format_missing", "caption_missing"]);
  });

  it("placement must be the client's platforms", () => {
    const i = handoffBase();
    i.placement = ["tiktok"];
    expect(failingRequiredToSend(i)).toEqual([{ code: "placement_missing", message: expect.stringContaining("tiktok") }]);
  });

  it("the caption limit counts the hashtags, per placed network (media-rules' numbers)", () => {
    const i = handoffBase();
    i.caption = "a".repeat(2180);
    i.hashtags = [];
    expect(failingHandoffChecks(i)).toEqual([]);
    i.hashtags = ["mockbakery", "pastries"]; // 2180 + "\n\n" + "#mockbakery #pastries" (21) = 2203 > 2200
    expect(captionWithHashtags(i.caption, i.hashtags).length).toBe(2203);
    expect(failingHandoffChecks(i).map((b) => b.code)).toEqual(["caption_too_long"]);
    const x = handoffBase();
    x.placement = ["x"];
    x.caption = "b".repeat(281);
    expect(failingHandoffChecks(x).map((b) => b.code)).toEqual(["caption_too_long"]);
  });

  it("thirty hashtags pass on Instagram; thirty-one do not; other networks carry no cap", () => {
    const i = handoffBase();
    i.hashtags = Array.from({ length: 30 }, (_v, n) => `tag${n}`);
    expect(failingHandoffChecks(i)).toEqual([]);
    i.hashtags.push("tag30");
    expect(failingHandoffChecks(i).map((b) => b.code)).toEqual(["too_many_hashtags"]);
    i.placement = ["facebook"];
    expect(failingHandoffChecks(i)).toEqual([]);
  });

  it("on-image text is needed for feed, carousel and story, not reel", () => {
    for (const f of ["feed", "carousel", "story", "reel"]) {
      const i = handoffBase();
      i.format = f;
      i.onAssetText = null;
      expect(failingHandoffChecks(i).map((b) => b.code), f).toEqual(f === "reel" ? [] : ["on_image_text_missing"]);
    }
  });

  it("an AI asset with its note passes", () => {
    const i = handoffBase();
    i.rawAssets = [{ url: "https://example.invalid/a.jpg", source: "ai", aiNote: "Generated background." }];
    expect(failingHandoffChecks(i)).toEqual([]);
  });

  it("the ready-by check compares the company's day", () => {
    const i = handoffBase();
    i.scheduledAt = "2026-11-13T20:00:00.000Z"; // the 13th in UTC, the 14th in Bali (UTC+8)
    expect(failingHandoffChecks(i).map((b) => b.code)).toEqual(["date_before_ready_by"]);
    i.timeZone = "Asia/Makassar";
    expect(dayInZone(i.scheduledAt, i.timeZone)).toBe("2026-11-14");
    expect(failingHandoffChecks(i)).toEqual([]);
    i.scheduledAt = "2026-11-14T00:00:00.000Z";
    i.timeZone = undefined;
    expect(failingHandoffChecks(i)).toEqual([]);
  });

  it("the read form returns every check with its verdict", () => {
    const i = handoffBase();
    HANDOFF_FAILERS.must_haves_unticked(i);
    const r = readChecks(i);
    expect(r.map((c) => c.code)).toEqual([...SCP.requiredToSend, ...SCP.handoffChecks].map((c) => c.code));
    expect(r.filter((c) => !c.ok).map((c) => c.code)).toEqual(["must_haves_unticked"]);
    expect(r.find((c) => c.code === "must_haves_unticked")!.message).toContain("hashtag_set");
    expect(r.find((c) => c.code === "must_haves_unticked")!.message).toContain("Core");
  });
});
