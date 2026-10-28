// SCP-1e (BFF §63.3.2, §63.6.3 to §63.6.7, §63.16) — the DEMO_MODE writes of the Social Media pipeline: `POST posts/:postId/actions` (the one action route),
// `PATCH posts/:postId/pipeline` (edit), `PUT` and `DELETE posts/:postId/suggestions/:field`, `POST`, `PATCH` and `DELETE posts/:postId/designs[/:designId]`,
// and `POST posts/actions` (bulk). It mutates the store of `demoSocialPipeline.ts`, so the read, the cycle counts and the health of the next call see the write.
//
// IT RUNS THE SERVER'S ORDER OF CHECKS (§63.3.2, platform-nest `pipeline/machine.ts`), from the fixture twin: 1 the action is known; 2 the post exists and is a
// pipeline post; 3 a replay of the post's last `actionId`; 4 archived; 5 an unattended automation; 6 maker/checker; 7 Cerbos (the persona's answer, with the
// action's own refusal code); 8 `expectedStatus`; 9 the status is in the action's `from`; 10 the body (400 `missing_field` / `invalid_field` with `field`);
// 11 the action's own guards, in the fixture's order; 12 the effects. The transition (the target, the change case set or cleared, the creative state,
// `changedOnly` and `copyBefore`, the block columns, `scheduleVia`, `statusSince`, the history and the copy log) is read from the fixture's own `to`,
// `setsChangeCase` and `effects`, interpreted the way the server's `COLUMN_EFFECTS` do. An effect with no row in the store (a notification, the content
// month's progress, the variants, which the read derives from the status) is named in `NOOP_EFFECTS`, and the test fails on any fixture effect that is
// neither handled nor named there, so a new effect cannot be silently skipped.
//
// WHAT THE DEMO CANNOT JUDGE it answers as the real data would for the seed: every placed network has exactly one account (the allocation's platforms),
// the publisher is registered, no network is mid-publish, the media rules pass, the Creatives department exists. Demo ids are readable strings, not uuids
// (a design `soc-post-n-1-d1`, an asset `demo-asset-g1`, a file `soc-post-n-1-f1`), so `designId`, `assetGroupId` and a pin's `fileId` are any non-empty
// string here; the `actionId` is a uuid, as on the server.
import fixture from "./scpStageMachine.json";
import { scpActionsFromStatus, scpHolderOf, scpPhaseOf, type ScpPostView } from "./scpStageMachine";
import { ALLOCATION_NETWORKS } from "./socialAllocation";
import { MUST_HAVES, SUGGESTIBLE_FIELDS, editableFieldsOf } from "./socialPipeline";
import { demoAccountKinds, demoNetworksWithoutAccount } from "./demoSocialAccounts";
import {
  PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, cerbosAllows, demoChecks, demoPipelinePost, isDemoSocialApprover, who, type DemoResult, type PipePost,
} from "./demoSocialPipeline";

// ── The fixture, as this file reads it ───────────────────────────────────────────────────────────────────────────────────────

interface FxAction {
  action: string; kind?: string; cerbosAction?: string | Record<string, string>; extraCerbos?: Record<string, string[]>;
  to: unknown; setsChangeCase?: unknown; params: Record<string, string>; guards: Array<{ guard: string; refusal: string }>; effects: string[];
  from: Array<{ status: string; changeCase?: string[] }>;
}
const FX = fixture as unknown as {
  statuses: string[];
  actions: FxAction[];
  refusals: Record<string, { http: number }>;
  cerbosActions: Record<string, { refusal: string }>;
  commonGuards: Array<{ guard: string; appliesTo?: string[] }>;
  changeCases: Array<{ key: string; changeBy: string; changeKind: string; returnTo: string }>;
  pseudoTargets: Record<string, string>;
  fieldGroups: Record<string, string[]>;
};

const OWN_ROUTE = new Set(["create", "edit", "suggest", "add_design", "remove_design"]);
/** The values of `POST posts/:postId/actions` (the server's `ACTION_ROUTE_ACTIONS`). */
export const DEMO_ACTION_ROUTE: readonly string[] = FX.actions
  .filter((a) => !OWN_ROUTE.has(a.action) && !(typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:")))
  .map((a) => a.action);

const MAKER_CHECKER_ON = new Set(FX.commonGuards.find((g) => g.guard === "maker_checker")?.appliesTo ?? []);
const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPROVED_TIME_GRACE_MS = 5 * 60 * 1000;

/** Two invented Asset Library assets, so "add a design by its version group" is drivable in DEMO_MODE (the demo has no creative library of its own). */
export const DEMO_ASSETS: ReadonlyArray<{ groupId: string; versionId: string; versionNo: number; name: string; source: string; aiNote: string | null }> = [
  { groupId: "demo-asset-g1", versionId: "demo-asset-v2", versionNo: 2, name: "Autumn hero - final.png", source: "own", aiNote: null },
  { groupId: "demo-asset-g2", versionId: "demo-asset-v1", versionNo: 1, name: "Studio portrait.png", source: "ai", aiNote: "Background made with an image model; the product is a photograph." },
];

/**
 * `GET /api/:t/creative/assets` with no filter: the Asset Library's latest versions, which is what the post page's designer picker reads (`readAssetChoices`).
 * The demo has no creative library of its own, so the answer is `DEMO_ASSETS`, in the row shape of §35.5 (each version's own id, its group in `versionGroupId`).
 * A read with a filter (a department's library, `trainingReady`, `versions=all`) is not this one: null, and the caller falls through.
 */
export function demoAssetLibraryRead(method: string, p: string, params: URLSearchParams): DemoResult | null {
  if (method.toUpperCase() !== "GET" || !/^\/api\/[^/]+\/creative\/assets$/.test(p) || [...params.keys()].length > 0) return null;
  return {
    status: 200,
    json: DEMO_ASSETS.map((a, i) => ({
      id: a.versionId, name: a.name, content_type: "image/png", width: 1080, height: 1350, preset_id: null, grade: null, department_id: "dept-2",
      has_original: true, original_byte_size: 240000 + i * 1000, graded_byte_size: 180000 + i * 1000, training_ready: false, created_at: "2026-09-20T09:00:00.000Z",
      versionNo: a.versionNo, versionGroupId: a.groupId, supersedesId: null, versionCount: a.versionNo, isLatest: true, review: null, source: a.source, aiNote: a.aiNote,
    })),
  };
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Fail { error: string; field?: string; detail?: Record<string, unknown>; blockers?: Array<{ code: string; message: string }>; retryAfterSeconds?: number }
type Refused = { ok: false; result: DemoResult };
type Out =
  | Refused
  | { ok: true; post: PipePost | null; from: string; to: string; warnings: string[]; alreadyApplied: boolean; designId: string | null };

function refuse(code: string, extra: Omit<Fail, "error"> = {}): Refused {
  const http = FX.refusals[code]?.http;
  if (http === undefined) throw new Error(`demoSocialPipelineRun: refusal '${code}' is not in the fixture`);
  return { ok: false, result: { status: http, json: { error: code, ...extra } } };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;
const textLen = (s: string): number => [...s.trim()].length;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isHttp = (v: unknown): v is string => typeof v === "string" && v.length <= 500 && /^https?:\/\/\S+$/i.test(v);
const isNetwork = (n: unknown): boolean => typeof n === "string" && (ALLOCATION_NETWORKS as readonly string[]).includes(n);
const MUST_HAVE_KEYS = MUST_HAVES.map((m) => m.key);

// ── The post as the machine sees it ─────────────────────────────────────────────────────────────────────────────────────────

const view = (p: PipePost): ScpPostView => ({
  pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState,
});
/** The client an engagement is for (the account guards read the CLIENT's accounts). */
const clientOfEngagement = (engagementId: string): string => PIPE_ENGAGEMENTS.find((e) => e.id === engagementId)?.clientId ?? "";
const officerOf = (p: PipePost): string | null => allocStore.byEngagement[p.engagementId]?.officerId ?? null;
const isAutomation = (userId: string): boolean => /^(demo-)?(automation|bot)\b/.test(userId);

function fromMatches(a: FxAction, p: PipePost): boolean {
  return scpActionsFromStatus(view(p)).includes(a.action) && a.from.some((f) => f.status === p.pipelineStatus);
}

/** The Cerbos action an action needs on this post (unschedule: by how the post was scheduled). */
function cerbosKey(a: FxAction, p: PipePost): string {
  const c = a.cerbosAction;
  if (typeof c === "string") return c;
  return c?.[p.scheduleVia === "publisher" ? "publisher" : "manual"] ?? "approve";
}

// ── The body: one rule per fixture param ────────────────────────────────────────────────────────────────────────────────────

type Problem = { code: "missing_field" | "invalid_field"; field: string };
type Check = (name: string, v: unknown, all: Record<string, unknown>) => Problem | null;
const missing = (field: string): Problem => ({ code: "missing_field", field });
const invalid = (field: string): Problem => ({ code: "invalid_field", field });

const textRule = (min: number, max: number, required: boolean): Check => (name, v) => {
  if (absent(v) || (typeof v === "string" && v.trim() === "" && min > 0)) return required ? missing(name) : null;
  if (typeof v !== "string") return invalid(name);
  const n = textLen(v);
  return n < min || n > max ? invalid(name) : null;
};
const enumRule = (values: readonly string[], required: boolean): Check => (name, v) => {
  if (absent(v) || v === "") return required ? missing(name) : null;
  return typeof v === "string" && values.includes(v) ? null : invalid(name);
};
/** The regular prose shapes of the fixture's params ("1..2000, required", "0..500, optional", "a|b|c, required"), read here the way the server reads them. */
function parseProse(prose: string): Check | null {
  let m = /^(\d+)\.\.(\d+), (required|optional)$/.exec(prose);
  if (m) return textRule(Number(m[1]), Number(m[2]), m[3] === "required");
  m = /^([a-z_]+(?:\|[a-z_]+)+), required$/.exec(prose);
  if (m) return enumRule(m[1].split("|"), true);
  return null;
}

const ASSET_SOURCES = ["own", "client", "stock", "ai", "unknown"];
const ALL_FIELDS = new Set(Object.entries(FX.fieldGroups).filter(([g]) => g !== "suggestible").flatMap(([, f]) => f));
const optText = (max: number) => (v: unknown) => v === null || (typeof v === "string" && [...v].length <= max);
const FIELD_RULES: Record<string, (v: unknown) => boolean> = {
  title: (v) => typeof v === "string" && textLen(v) >= 1 && [...v].length <= 200,
  format: (v) => v === null || (typeof v === "string" && ["feed", "carousel", "reel", "story"].includes(v)),
  pillar: optText(60), angle: optText(500), objective: optText(200), keyMessage: optText(500), visualDirection: optText(2000), onAssetText: optText(500), cta: optText(120),
  caption: (v) => typeof v === "string" && [...v].length <= 5000,
  hashtags: (v) => Array.isArray(v) && v.length <= 60 && v.every((t) => typeof t === "string" && t.trim() !== "" && !t.includes("#") && !/\s/.test(t)),
  rawAssets: (v) => Array.isArray(v) && v.length <= 10 && v.every((a) => isObj(a)
    && (a.url === undefined || a.url === null || typeof a.url === "string") && (a.label === undefined || a.label === null || typeof a.label === "string")
    && typeof a.source === "string" && ASSET_SOURCES.includes(a.source) && (a.aiNote === undefined || a.aiNote === null || (typeof a.aiNote === "string" && [...a.aiNote].length <= 1000))),
  placement: (v) => Array.isArray(v) && v.every(isNetwork) && new Set(v).size === v.length,
  scheduledAt: (v) => v === null || isIso(v),
  mustHaves: (v) => Array.isArray(v) && v.every((k) => typeof k === "string" && MUST_HAVE_KEYS.includes(k)) && new Set(v).size === v.length,
};
const fieldProblem = (field: string, v: unknown, reportAs: string): Problem | null => (v === undefined ? null : FIELD_RULES[field]?.(v) ? null : invalid(reportAs));

const SUGGESTIBLE: Check = (name, v) => {
  if (absent(v) || v === "") return missing(name);
  return typeof v === "string" && SUGGESTIBLE_FIELDS.includes(v) ? null : invalid(name);
};

function sendAnywayProblem(all: Record<string, unknown>, which: string): Problem | null {
  const { sendAnyway, sendAnywayReason } = all;
  let p: Problem | null = null;
  if (sendAnyway !== undefined && typeof sendAnyway !== "boolean") p = invalid("sendAnyway");
  else {
    const given = !absent(sendAnywayReason) && !(typeof sendAnywayReason === "string" && sendAnywayReason.trim() === "");
    if (sendAnyway === true && !given) p = missing("sendAnywayReason");
    else if (given) {
      if (typeof sendAnywayReason !== "string") p = invalid("sendAnywayReason");
      else {
        const n = textLen(sendAnywayReason);
        if (n < 10 || n > 500) p = invalid("sendAnywayReason");
      }
    }
  }
  return p && p.field === which ? p : null;
}

const NONEMPTY: Check = (n, v) => (absent(v) || v === "" ? missing(n) : typeof v === "string" ? null : invalid(n));
const EXPLICIT: Record<string, Record<string, Check>> = {
  edit: {
    fields: (n, v) => {
      if (absent(v)) return missing(n);
      if (!isObj(v) || Object.keys(v).length === 0) return invalid(n);
      for (const [k, val] of Object.entries(v)) {
        if (!ALL_FIELDS.has(k)) return invalid(k);
        const p = fieldProblem(k, val, k);
        if (p) return p;
      }
      return null;
    },
  },
  accept_suggestion: { field: SUGGESTIBLE },
  send_to_proofread: { sendAnyway: (_n, _v, all) => sendAnywayProblem(all, "sendAnyway"), sendAnywayReason: (_n, _v, all) => sendAnywayProblem(all, "sendAnywayReason") },
  suggest: {
    field: SUGGESTIBLE,
    value: (n, v, all) => {
      if (v === null) return null;
      if (v === undefined) return missing(n);
      const f = typeof all.field === "string" ? all.field : "";
      return SUGGESTIBLE_FIELDS.includes(f) ? fieldProblem(f, v, n) : null;
    },
  },
  add_design: {
    assetGroupId: (n, v, all) => {
      if (absent(v) && absent(all.linkUrl)) return missing(n);
      if (!absent(v) && !absent(all.linkUrl)) return invalid(n);
      return absent(v) || (typeof v === "string" && v !== "") ? null : invalid(n);
    },
    linkUrl: (n, v) => (absent(v) || isHttp(v) ? null : invalid(n)),
    linkSource: (n, v, all) => (absent(all.linkUrl) ? (absent(v) ? null : invalid(n)) : enumRule(ASSET_SOURCES, true)(n, v, all)),
    linkAiNote: (n, v, all) => {
      if (all.linkSource === "ai" && (absent(v) || (typeof v === "string" && v.trim() === ""))) return missing(n);
      if (absent(v)) return null;
      if (absent(all.linkUrl)) return invalid(n);
      return typeof v === "string" && textLen(v) <= 1000 ? null : invalid(n);
    },
    position: (n, v) => (absent(v) ? null : Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20 ? null : invalid(n)),
  },
  remove_design: { designId: NONEMPTY },
  record_client_change: {
    anchor: (n, v) => {
      if (absent(v)) return null;
      if (!isObj(v)) return invalid(n);
      const frac = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
      return frac(v.x) && frac(v.y) && (v.fileId === undefined || typeof v.fileId === "string") ? null : invalid(n);
    },
  },
  reschedule: {
    at: (n, v) => (absent(v) ? null : isIso(v) ? null : invalid(n)),
    placement: (n, v) => (absent(v) ? null : Array.isArray(v) && v.length > 0 && v.every(isNetwork) && new Set(v).size === v.length ? null : invalid(n)),
  },
  mark_live: {
    url: (n, v) => (absent(v) || v === "" ? missing(n) : isHttp(v) ? null : invalid(n)),
    at: (n, v) => (absent(v) ? null : isIso(v) ? null : invalid(n)),
  },
};

function paramRule(action: string, param: string, prose: string): Check {
  const ex = EXPLICIT[action]?.[param];
  if (ex) return ex;
  const parsed = parseProse(prose);
  if (!parsed) throw new Error(`demoSocialPipelineRun: no rule for param ${action}.${param}`);
  return parsed;
}

// ── The effects ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Env { a: FxAction; before: PipePost; next: PipePost; params: Record<string, unknown>; userId: string; now: string; target: { status: string; pseudo: string | null; changeCase: string | null }; warnings: string[]; copyLog: Array<Record<string, unknown>>; flags: { alreadyApplied: boolean; deleted: boolean; designId: string | null }; skipped: { codes: string[]; reason: string } | null }
const COPY_FIELDS = ["caption", "onAssetText", "cta", "hashtags"] as const;
const COPY_FIELD_SET = new Set<string>(COPY_FIELDS);
const FIELD_KEY = new Set(ALL_FIELDS);

const valueOf = (p: PipePost, field: string): unknown => (p as unknown as Record<string, unknown>)[field];
function setField(p: PipePost, field: string, v: unknown): void {
  // The store keeps text as a string, never null (a cleared text is empty); a post's date and format are nullable as the server's are.
  const o = p as unknown as Record<string, unknown>;
  const textual = ["pillar", "angle", "objective", "keyMessage", "visualDirection", "onAssetText", "cta"].includes(field);
  o[field] = v === null && textual ? "" : v;
}
const logRow = (env: Env, field: string, before: unknown, after: unknown, via: "suggestion" | "fix", suggestedBy: string | null): void => {
  env.copyLog.push({ field, before, after, via, by: who(env.userId), suggestedBy: suggestedBy ? who(suggestedBy) : null, stage: env.before.pipelineStatus, at: env.now });
};
function writeChange(env: Env, caseKey: string | null): void {
  const c = caseKey ? FX.changeCases.find((x) => x.key === caseKey) : undefined;
  if (caseKey && !c) throw new Error(`demoSocialPipelineRun: unknown change case '${caseKey}'`);
  env.next.changeBy = c?.changeBy ?? null;
  env.next.changeKind = c?.changeKind ?? null;
  env.next.returnTo = c?.returnTo ?? null;
  env.next.changeNote = c ? String(env.params.note).trim() : null;
  env.next.changeCase = c?.key ?? null;
}
const staleFields = (p: PipePost): string[] => Object.entries(p.suggestions).filter(([f, s]) => !same(s.base, valueOf(p, f))).map(([f]) => f);

/** The column effects of the fixture, by name. Each writes the store's row (a draft of it: it is committed only when every effect ran). */
const COLUMN: Record<string, (e: Env) => void> = {
  set_status_since: (e) => { e.next.statusSince = e.now; },
  set_engine_status: () => {}, // derived by the read from the status, the variants and `archivedAt`
  set_author_if_null: (e) => { if (e.next.authorId === null) e.next.authorId = e.userId; },
  write_fields: (e) => {
    const copyLog = editableFieldsOf({ pipelineStatus: e.before.pipelineStatus, change: e.before.changeCase ? { by: "", kind: "", returnTo: "", note: null, case: e.before.changeCase } : null }).copyLog;
    for (const [k, v] of Object.entries(e.params.fields as Record<string, unknown>)) {
      const before = valueOf(e.before, k);
      setField(e.next, k, v);
      if (copyLog && COPY_FIELD_SET.has(k) && !same(before, valueOf(e.next, k))) logRow(e, k, before, valueOf(e.next, k), "fix", null);
    }
  },
  apply_one_suggestion: (e) => {
    const field = String(e.params.field);
    const s = e.next.suggestions[field];
    const before = valueOf(e.before, field);
    setField(e.next, field, s.value);
    logRow(e, field, before, s.value, "suggestion", s.by);
    delete e.next.suggestions[field];
  },
  clear_change_keep_changed_only: (e) => writeChange(e, null),
  append_skipped_checks: (e) => {
    if (e.skipped && e.skipped.codes.length) e.next.skippedChecks = [...e.next.skippedChecks, { codes: e.skipped.codes, reason: e.skipped.reason, by: e.userId, at: e.now }];
  },
  set_or_drop_suggestion_with_base: (e) => {
    const field = String(e.params.field);
    if (e.params.value === null) delete e.next.suggestions[field];
    else e.next.suggestions[field] = { value: e.params.value, base: valueOf(e.before, field), by: e.userId, at: e.now };
  },
  apply_suggestions: (e) => {
    for (const [field, s] of Object.entries(e.before.suggestions)) {
      setField(e.next, field, s.value);
      logRow(e, field, valueOf(e.before, field), s.value, "suggestion", s.by);
    }
  },
  clear_suggestions: (e) => { e.next.suggestions = {}; },
  clear_changed_only: (e) => { e.next.changedOnly = false; e.next.copyBefore = null; },
  set_change: (e) => writeChange(e, e.target.changeCase),
  keep_suggestions: () => {},
  copy_creative_source_from_engagement: (e) => { e.next.creativeSource = allocStore.byEngagement[e.next.engagementId].creativeSource; },
  creative_state_not_started: (e) => { e.next.creativeState = "not_started"; },
  enter_in_team_queue: () => {},
  clear_change: (e) => writeChange(e, null),
  creative_state_submitted: (e) => { e.next.creativeState = "submitted"; },
  creative_state_revision: (e) => { e.next.creativeState = "revision"; },
  set_changed_only_and_copy_before: (e) => {
    e.next.changedOnly = true;
    e.next.copyBefore = { caption: e.before.caption, onAssetText: e.before.onAssetText, cta: e.before.cta, hashtags: e.before.hashtags };
  },
  set_schedule_via_manual: (e) => { e.next.scheduleVia = "manual"; },
  set_schedule_via_publisher: (e) => { e.next.scheduleVia = "publisher"; },
  clear_schedule_via: (e) => { e.next.scheduleVia = null; },
  write_date_and_placement: (e) => {
    if (!absent(e.params.at)) e.next.scheduledAt = new Date(String(e.params.at)).toISOString();
    if (Array.isArray(e.params.placement)) e.next.placement = e.params.placement as string[];
    e.next.rescheduled = true; // the client approves the new date and placement again (SCP-Q13): there is no approved schedule until they do
  },
  set_live_url_and_went_live_at: (e) => {
    e.next.liveUrl = String(e.params.url);
    e.next.wentLiveAt = absent(e.params.at) ? e.now : new Date(String(e.params.at)).toISOString();
  },
  set_blocked_from_and_reason: (e) => {
    e.next.blockedFrom = e.before.pipelineStatus;
    e.next.blockReason = String(e.params.reason).trim();
    e.next.blockWaitingOn = String(e.params.waitingOn);
    e.next.blockedAt = e.now;
  },
  keep_change_case: () => {},
  clear_block: (e) => { e.next.blockedFrom = null; e.next.blockReason = null; e.next.blockWaitingOn = null; e.next.blockedAt = null; },
  soft_delete: (e) => { e.flags.deleted = true; },
  set_archived: (e) => { e.next.archivedAt = e.now; },
  "creative_state: not_started becomes in_progress; revision stays revision; in_progress replays as alreadyApplied": (e) => {
    const s = e.before.creativeState;
    if (s === "not_started") e.next.creativeState = "in_progress";
    else if (s === "in_progress") e.flags.alreadyApplied = true;
  },
  // I/O effects the demo store has a row for:
  join_or_open_month_request: (e) => { e.next.creativeRequestId = `soc-req-${e.next.engagementId}-${e.next.cycleMonth}`; },
  insert_design: (e) => {
    const n = e.next.designs.reduce((m, d) => Math.max(m, Number(/-d(\d+)$/.exec(String(d.id))?.[1] ?? 0)), 0) + 1;
    const id = `${e.next.id}-d${n}`;
    const position = typeof e.params.position === "number" ? e.params.position : e.next.designs.reduce((m, d) => Math.max(m, Number(d.position) || 0), 0) + 1;
    const asset = typeof e.params.assetGroupId === "string" ? DEMO_ASSETS.find((x) => x.groupId === e.params.assetGroupId) : undefined;
    e.next.designs = [...e.next.designs, {
      id, position, fileId: null,
      asset: asset ? { groupId: asset.groupId, versionId: asset.versionId, versionNo: asset.versionNo, name: asset.name, source: asset.source, aiNote: asset.aiNote } : null,
      link: asset ? null : { url: String(e.params.linkUrl), source: String(e.params.linkSource), aiNote: absent(e.params.linkAiNote) ? null : String(e.params.linkAiNote).trim() },
    }];
    e.flags.designId = id;
  },
  mark_design_removed: (e) => { e.next.designs = e.next.designs.filter((d) => d.id !== e.params.designId); },
  materialize_design_files: (e) => { e.next.designs = e.next.designs.map((d) => (d.fileId ? d : { ...d, fileId: `${String(d.id).replace(/-d(\d+)$/, "-f$1")}` })); },
  warn_on_unknown_source: (e) => {
    const unknown = e.next.designs.filter((d) => ((d.asset as { source?: string } | null)?.source ?? (d.link as { source?: string } | null)?.source) === "unknown");
    if (unknown.length) e.warnings.push(`${unknown.length === 1 ? "A design has" : `${unknown.length} designs have`} no source set. Say where ${unknown.length === 1 ? "it" : "they"} came from.`);
  },
};

/** Effects the demo store has nothing to write for: notifications, the content month's progress, and the variants and reviews, which the read derives from the
 *  status. (A prefix match covers `notify:` and `notify_after_undo_window:`.) The test fails on a fixture effect in neither this list nor `COLUMN`. */
export const NOOP_EFFECTS: ReadonlySet<string> = new Set([
  "content_month_progress", "copy_log_when_in_changes", "copy_log", "copy_log_each_field", "link_asset_to_month_request", "sync_variants_copy_from_master",
  "request_client_reviews", "sync_variants_from_master", "request_client_reviews_on_every_variant", "sync_variants_dates_and_networks",
  "approve_every_variant_review_with_args_hash_in_one_transaction", "changes_requested_on_every_variant_review_in_one_transaction", "decision_id", "undo_window_10s",
  "reviews_back_to_pending", "drop_pending_notifications", "recorded_by_and_channel", "schedule_by_hand_at_approved_date_time_and_placement",
  "file_one_publish_approval_per_variant", "cancel_queued_dispatches_and_withdraw_pending_approvals", "unschedule_cancelling_dispatches_and_withdrawing_approvals",
  "variants_become_native_import_published", "from_published_variants", "set_simulated_from_variants", "start_metrics", "activity_only",
  "withdraw_pending_client_reviews", "withdraw_pending_publish_approvals", "restore_pre_decision_fields", "set_client_first_sent_at_if_null", "set_cycle_and_engagement",
]);
export const isNoopEffect = (name: string): boolean => NOOP_EFFECTS.has(name) || /^notify(_after_undo_window)?:[a-z_]+$/.test(name);
export const DEMO_COLUMN_EFFECTS: readonly string[] = Object.keys(COLUMN);

const CONDITIONS: Record<string, (e: Env) => boolean> = {
  "when changedOnly": (e) => e.before.changedOnly,
  "when creatives": (e) => allocStore.byEngagement[e.before.engagementId].creativeSource === "creatives",
  "when in_team": (e) => allocStore.byEngagement[e.before.engagementId].creativeSource === "in_team",
  "when copy": (e) => e.params.changeKind === "copy",
  "when design": (e) => e.params.changeKind === "design",
  "when scheduled": (e) => e.before.pipelineStatus === "scheduled",
  "when publisher": (e) => e.before.scheduleVia === "publisher",
  officer: () => true,
  publisher: () => false, // the publisher's own result is the dispatch path's, not a person's call
};
const START_DESIGN_EFFECT = "creative_state: not_started becomes in_progress; revision stays revision; in_progress replays as alreadyApplied";
function splitEffect(raw: string): { condition: string | null; name: string } {
  if (raw === START_DESIGN_EFFECT) return { condition: null, name: raw };
  const m = /^(when [a-zA-Z_]+|else|officer|publisher): (.+)$/.exec(raw);
  return m ? { condition: m[1], name: m[2] } : { condition: null, name: raw };
}

/** The effect names that apply to this call, in the fixture's order (an `else:` negates the nearest `when` before it). */
function applicableEffects(env: Env): string[] {
  const out: string[] = [];
  let lastWhen: boolean | null = null;
  for (const raw of env.a.effects) {
    const { condition, name } = splitEffect(raw);
    let on = true;
    if (condition === "else") on = lastWhen === null ? true : !lastWhen;
    else if (condition !== null) {
      on = CONDITIONS[condition](env);
      if (condition.startsWith("when ")) lastWhen = on;
    }
    if (on) out.push(name);
  }
  return out;
}

/** Where an action takes the post (the fixture's `to`, `setsChangeCase`, and the resolve of a block). */
function targetOf(a: FxAction, p: PipePost, params: Record<string, unknown>): Env["target"] {
  const to = a.to;
  let status: string;
  let pseudo: string | null = null;
  const when = (w: Record<string, unknown>): boolean => Object.entries(w).every(([k, v]) => (k === "changedOnly" ? p.changedOnly === v : k === "returnTo" ? p.returnTo === v : k === "changeKind" ? params.changeKind === v : false));
  if (to === null || to === undefined) status = p.pipelineStatus;
  else if (typeof to === "string") {
    if (to in FX.pseudoTargets) { status = p.pipelineStatus; pseudo = to; } else status = to;
  } else if (Array.isArray(to)) {
    const hit = (to as Array<{ when: Record<string, unknown>; status: string }>).find((t) => when(t.when));
    if (!hit) throw new Error(`demoSocialPipelineRun: ${a.action}: no 'to' matches the post`);
    status = hit.status;
  } else {
    if (!p.blockedFrom) throw new Error(`demoSocialPipelineRun: ${a.action}: the post has no blockedFrom`);
    status = p.blockedFrom;
  }
  const sc = a.setsChangeCase;
  let changeCase: string | null;
  if (typeof sc === "string") changeCase = sc;
  else if (Array.isArray(sc)) {
    const hit = (sc as Array<{ when: Record<string, unknown>; changeCase: string }>).find((x) => when(x.when));
    if (!hit) throw new Error(`demoSocialPipelineRun: ${a.action}: no change case matches`);
    changeCase = hit.changeCase;
  } else changeCase = status === "changes" || status === "blocked" ? p.changeCase : null;
  return { status, pseudo, changeCase };
}

// ── One stage action, in the server's order ────────────────────────────────────────────────────────────────────────────────

interface Req { postId: string; action: string; params: Record<string, unknown>; expectedStatus?: string; actionId?: string; requireExpectedStatus?: boolean }

function stage(r: Req, userId: string, composer: boolean): Out {
  // 1
  const a = FX.actions.find((x) => x.action === r.action);
  if (!a) return refuse("unknown_action");
  // 2
  const p = PIPE_POSTS.find((x) => x.id === r.postId);
  if (!p) return composer ? refuse("not_a_pipeline_post") : refuse("post_not_found");
  // 3
  if (r.actionId !== undefined && p.lastActionId !== null && r.actionId === p.lastActionId) {
    return { ok: true, post: p, from: p.pipelineStatus, to: p.pipelineStatus, warnings: [], alreadyApplied: true, designId: null };
  }
  // 4
  if (p.archivedAt) return refuse("post_archived");
  // 5
  if (isAutomation(userId)) return refuse("automation_cannot_act");
  // 6
  const officer = officerOf(p);
  if (typeof a.cerbosAction === "string" && MAKER_CHECKER_ON.has(a.cerbosAction) && (userId === p.authorId || userId === officer)) return refuse("author_cannot_approve");
  // 7
  const key = cerbosKey(a, p);
  // The maker/checker DENY also stands behind the one arm the common step skips (unschedule through the publisher): it answers the action's own code.
  const denied = typeof a.cerbosAction !== "string" && key === "approve" && (userId === p.authorId || userId === officer);
  if (denied || !cerbosAllows(key, userId, p)) return refuse(FX.cerbosActions[key]?.refusal ?? "not_the_officer");
  if (a.extraCerbos && p.scheduleVia && a.extraCerbos[p.scheduleVia]) {
    // `cancel`: the officer holds none (they ask one of the four to unschedule first); the four and the superadmin do.
    if (!(userId === "demo-hansel" || isDemoSocialApprover(userId))) return refuse(FX.cerbosActions.cancel.refusal);
  }
  // 8
  if (r.requireExpectedStatus !== false) {
    const exp = r.expectedStatus;
    if (exp === undefined) return refuse("missing_field", { field: "expectedStatus" });
    if (!FX.statuses.includes(exp)) return refuse("invalid_field", { field: "expectedStatus" });
    if (exp !== p.pipelineStatus) return refuse("status_changed", { detail: { status: p.pipelineStatus, phase: scpPhaseOf(view(p)) } });
  }
  // 9
  if (!fromMatches(a, p)) return refuse("invalid_transition", { detail: { status: p.pipelineStatus, changeCase: p.pipelineStatus === "changes" ? p.changeCase : null } });
  // 10
  if (r.actionId !== undefined && !UUID.test(r.actionId)) return refuse("invalid_field", { field: "actionId" });
  for (const [name, prose] of Object.entries(a.params)) {
    const problem = paramRule(a.action, name, prose)(name, r.params[name], r.params);
    if (problem) return refuse(problem.code, { field: problem.field });
  }
  // 11
  const now = new Date();
  const g = guards(a, p, r, userId, now);
  if (g.fail) return g.fail;
  // 12
  return commit(a, p, r, userId, now, g.skipped);
}

function guards(a: FxAction, p: PipePost, r: Req, userId: string, now: Date): { fail: Out | null; skipped: { codes: string[]; reason: string } | null } {
  let skipped: { codes: string[]; reason: string } | null = null;
  for (const g of a.guards) {
    switch (g.guard) {
      case "fields_allowed_in_status": {
        const allowed = editableFieldsOf({ pipelineStatus: p.pipelineStatus, change: p.changeCase ? { by: "", kind: "", returnTo: "", note: null, case: p.changeCase } : null }).fields;
        for (const k of Object.keys(r.params.fields as object)) if (!allowed.includes(k)) return { fail: refuse("field_locked", { detail: { field: k, status: p.pipelineStatus } }), skipped };
        break;
      }
      case "suggestion_exists":
        if (!p.suggestions[String(r.params.field)]) return { fail: refuse("suggestion_not_found"), skipped };
        break;
      case "required_to_send": {
        const blockers = demoChecks(p).filter((c) => !c.skippable && !c.ok).map((c) => ({ code: c.code, message: c.message }));
        if (blockers.length) return { fail: refuse("incomplete_post", { blockers }), skipped };
        break;
      }
      case "handoff_checks_pass_or_send_anyway": {
        const soft = demoChecks(p).filter((c) => c.skippable && !c.ok).map((c) => ({ code: c.code, message: c.message }));
        if (!soft.length) break;
        if (r.params.sendAnyway === true && typeof r.params.sendAnywayReason === "string") skipped = { codes: soft.map((c) => c.code), reason: r.params.sendAnywayReason.trim() };
        else return { fail: refuse("checks_failed", { blockers: soft }), skipped };
        break;
      }
      case "suggestions_not_stale": {
        const fields = staleFields(p);
        if (fields.length) return { fail: refuse("suggestion_stale", { detail: { fields } }), skipped };
        break;
      }
      case "creatives_unit_exists_when_source_creatives": break; // the demo company has a Creatives department
      case "asset_exists":
        if (typeof r.params.assetGroupId === "string" && !DEMO_ASSETS.some((x) => x.groupId === r.params.assetGroupId)) return { fail: refuse("asset_not_found"), skipped };
        break;
      case "design_exists":
        if (!p.designs.some((d) => d.id === r.params.designId)) return { fail: refuse("design_not_found"), skipped };
        break;
      case "design_present":
        if (p.designs.length === 0) return { fail: refuse("design_missing"), skipped };
        break;
      case "designs_stored": {
        const linkOnly = p.designs.filter((d) => !d.asset).map((d) => String(d.id));
        if (linkOnly.length) return { fail: refuse("design_not_stored", { detail: { designIds: linkOnly } }), skipped };
        break;
      }
      case "one_account_per_placement_network": {
        // SCP-Sb: the client's ACCOUNTS decide, as the server's `loadClientAccounts` count does, not the allocation's platform list.
        const placement = Array.isArray(r.params.placement) ? (r.params.placement as string[]) : p.placement;
        const networks = demoNetworksWithoutAccount(clientOfEngagement(p.engagementId), placement);
        if (networks.length) return { fail: refuse("no_account_for_network", { detail: { networks } }), skipped };
        break;
      }
      case "account_not_ambiguous": break; // one account per network in the demo
      case "account_kinds_not_mixed": {
        // SCP-Sa3: the demo has no variants with accounts, so both actions judge the client's accounts on the post's placement (the server's `final_approve` does the
        // same; its `schedule_publisher` reads the live variants, which a demo post's placement stands for).
        const kinds = demoAccountKinds(clientOfEngagement(p.engagementId), p.placement);
        if (kinds.simulated.length > 0 && kinds.real.length > 0) return { fail: refuse("publisher_kinds_mixed", { detail: kinds }), skipped };
        break;
      }
      case "approved_time_not_passed": {
        const at = p.scheduledAt ? Date.parse(p.scheduledAt) : Number.NaN;
        if (Number.isNaN(at) || at < now.getTime() - APPROVED_TIME_GRACE_MS) return { fail: refuse("approved_time_passed"), skipped };
        break;
      }
      case "media_rules_pass": case "publisher_available": case "no_variant_publishing": break;
      case "something_changes": {
        const atChanges = !absent(r.params.at) && (p.scheduledAt === null || Date.parse(String(r.params.at)) !== Date.parse(p.scheduledAt));
        const pl = r.params.placement as string[] | undefined;
        const placementChanges = Array.isArray(pl) && !(pl.length === p.placement.length && pl.every((n) => p.placement.includes(n)));
        if (!atChanges && !placementChanges) return { fail: refuse("no_change"), skipped };
        break;
      }
      case "holder_is_someone_else": {
        const h = (demoPipelinePost(p, userId) as { holder: { role: string | null; userIds: string[] } }).holder;
        if (h.role === null || h.userIds.includes(userId)) return { fail: refuse("nobody_to_follow_up"), skipped };
        break;
      }
      case "once_per_holder_per_24h": {
        // the server's `once_per_holder_per_24h` counts the follow-ups that reached THIS holder (a follow-up of an earlier holder is not this one's)
        const role = scpHolderOf(view(p));
        const last = [...p.history].reverse().find((h) => h.action === "follow_up" && (h.holder === undefined || h.holder === role));
        const elapsed = last ? now.getTime() - Date.parse(String(last.at)) : Number.POSITIVE_INFINITY;
        if (elapsed < FOLLOW_UP_WINDOW_MS) return { fail: refuse("follow_up_too_soon", { retryAfterSeconds: Math.ceil((FOLLOW_UP_WINDOW_MS - elapsed) / 1000) }), skipped };
        break;
      }
      default:
        throw new Error(`demoSocialPipelineRun: guard '${g.guard}' of ${a.action} has no demo rule`);
    }
  }
  return { fail: null, skipped };
}

function commit(a: FxAction, p: PipePost, r: Req, userId: string, now: Date, skipped: { codes: string[]; reason: string } | null): Out {
  const iso = now.toISOString();
  const from = p.pipelineStatus; // `p` is the store row: it is overwritten at the end
  const next = structuredClone(p);
  const target = targetOf(a, p, r.params);
  const env: Env = { a, before: p, next, params: r.params, userId, now: iso, target, warnings: [], copyLog: [], flags: { alreadyApplied: false, deleted: false, designId: null }, skipped };
  if (target.status !== p.pipelineStatus) next.pipelineStatus = target.status;
  for (const name of applicableEffects(env)) {
    const col = COLUMN[name];
    if (col) col(env);
    else if (!isNoopEffect(name)) throw new Error(`demoSocialPipelineRun: effect '${name}' of ${a.action} is neither handled nor named as a no-op`);
  }
  if (env.flags.alreadyApplied) return { ok: true, post: p, from: p.pipelineStatus, to: p.pipelineStatus, warnings: [], alreadyApplied: true, designId: null };
  // `client_approve` on the client's side and a recorded approval both end the "back with the client" state: the date and placement are approved again.
  if (a.action === "record_client_approve" || a.action === "client_approve") next.rescheduled = false;
  if (next.changeCase !== target.changeCase) throw new Error(`demoSocialPipelineRun: ${a.action}: the change case after is '${String(next.changeCase)}', the target says '${String(target.changeCase)}'`);
  next.lastActionId = r.actionId ?? null;
  next.copyLog = [...next.copyLog, ...env.copyLog];
  const channel = typeof r.params.channel === "string" ? r.params.channel : null;
  next.history = [...next.history, {
    action: a.action, from: p.pipelineStatus, to: target.pseudo ?? target.status, by: who(userId), agent: null, at: iso,
    recorded: a.action === "record_client_approve" || a.action === "record_client_change" ? (channel ? { channel } : null) : null,
    viaPortal: typeof a.cerbosAction === "string" && a.cerbosAction.startsWith("portal:"), // the client's own decision, made in the portal (SCP-2)
    ...(a.action === "follow_up" ? { holder: scpHolderOf(view(p)) } : {}), // who it reached: Messages shows the last follow-up of the CURRENT holder
  }];
  const idx = PIPE_POSTS.indexOf(p);
  if (env.flags.deleted) PIPE_POSTS.splice(idx, 1);
  else Object.assign(p, next);
  return { ok: true, post: env.flags.deleted ? null : p, from, to: target.pseudo ?? target.status, warnings: env.warnings, alreadyApplied: false, designId: env.flags.designId };
}

/**
 * SCP-2: the client's own decision (`client_approve`, `client_change`), applied by the SAME `commit` the staff actions use, so the status, the change case,
 * `changedOnly` and `copyBefore`, the creative state, the history row and `statusSince` are the fixture's, and the staff side's post moves exactly as a
 * recorded decision moves it. The portal's own checks (the contact, the post's client, the status, the body, the hash, a replay) come BEFORE this and are
 * `demoSocialPortal.ts`'s; the fixture's guards `seen_hash_matches` and `every_variant_review_pending` are those checks, so `guards()` is not run here.
 */
export function demoCommitPortalDecision(
  p: PipePost, action: "client_approve" | "client_change", params: Record<string, unknown>, userId: string, now: Date,
): { from: string; to: string } {
  const a = FX.actions.find((x) => x.action === action);
  if (!a) throw new Error(`demoSocialPipelineRun: '${action}' is not in the fixture`);
  if (!fromMatches(a, p)) throw new Error(`demoSocialPipelineRun: '${action}' does not start from '${p.pipelineStatus}'`);
  const out = commit(a, p, { postId: p.id, action, params }, userId, now, null);
  if (!out.ok) throw new Error(`demoSocialPipelineRun: ${action} was refused after the portal's own checks`);
  return { from: out.from, to: out.to };
}

// ── The answers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ctrl = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === "string" ? v : "__invalid__");

/** The answer every write gives (the server's `answer()`): `{post, applied, warnings}`; `post` is null when the post can no longer be read (a discarded one). */
function answered(action: string, out: Out, userId: string, status = 200): DemoResult {
  if (!out.ok) return out.result;
  const post = out.post ? demoPipelinePost(out.post, userId) : null;
  const applied = { action, from: out.from, to: out.to };
  if (out.alreadyApplied) return { status: 200, json: { alreadyApplied: true, post, applied, warnings: [] } };
  return { status, json: { post, applied, warnings: out.warnings, ...(out.designId ? { designId: out.designId } : {}) } };
}

/** `POST posts/:postId/actions` (BFF §63.6.5). `composer`: the id is a Composer post of the legacy store (409 `not_a_pipeline_post`). */
export function runDemoPipelineAction(postId: string, body: unknown, userId: string, opts: { composer?: boolean } = {}): DemoResult {
  const b = isObj(body) ? body : {};
  const { action, expectedStatus, actionId, ...params } = b;
  const name = typeof action === "string" && DEMO_ACTION_ROUTE.includes(action) ? action : "__unknown__";
  const out = stage({ postId, action: name, params, expectedStatus: ctrl(expectedStatus), actionId: ctrl(actionId) }, userId, opts.composer === true);
  return answered(name, out, userId);
}

const BULK = new Set(["send_to_proofread", "approve_copy"]);

/**
 * Every other write of the section, by route: edit, suggestions, designs and bulk. Returns null for a path that is none of them (the caller falls through).
 * `tail` is the path after `modules/social/`; `isComposer(id)` says whether an id is a Composer post of the legacy store.
 */
export function runDemoPipelineWrite(method: string, tail: string, body: unknown, userId: string, isComposer: (id: string) => boolean = () => false): DemoResult | null {
  const b = isObj(body) ? body : {};
  const split = () => { const { expectedStatus, actionId, ...rest } = b; return { expectedStatus: ctrl(expectedStatus), actionId: ctrl(actionId), rest }; };

  if (method === "POST" && tail === "posts/actions") {
    if (typeof b.action !== "string") return { status: 400, json: { error: "missing_field", field: "action" } };
    if (!BULK.has(b.action)) return { status: 400, json: { error: "invalid_field", field: "action" } };
    const items = b.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) return { status: 400, json: { error: "invalid_field", field: "items" } };
    const results = items.map((raw, i) => {
      const it = isObj(raw) ? raw : {};
      const postId = typeof it.postId === "string" ? it.postId : "";
      const out = stage({ postId, action: String(b.action), params: {}, expectedStatus: typeof it.expectedStatus === "string" ? it.expectedStatus : undefined, actionId: typeof it.actionId === "string" ? it.actionId : undefined }, userId, isComposer(postId));
      if (out.ok) return { postId, ok: true, ...(out.alreadyApplied ? { alreadyApplied: true } : {}), post: out.post ? demoPipelinePost(out.post, userId) : null };
      const j = out.result.json as Fail;
      return { postId: postId || `items[${i}]`, ok: false, error: j.error, ...(j.field ? { field: j.field } : {}), ...(j.detail ? { detail: j.detail } : {}), ...(j.blockers ? { blockers: j.blockers } : {}) };
    });
    return { status: 200, json: { results } };
  }

  let m = /^posts\/([^/]+)\/pipeline$/.exec(tail);
  if (m && method === "PATCH") {
    const s = split();
    return answered("edit", stage({ postId: m[1], action: "edit", params: { fields: b.fields }, expectedStatus: s.expectedStatus }, userId, isComposer(m[1])), userId);
  }

  m = /^posts\/([^/]+)\/suggestions\/([^/]+)$/.exec(tail);
  if (m && (method === "PUT" || method === "DELETE")) {
    const field = decodeURIComponent(m[2]);
    if (method === "PUT") {
      const s = split();
      // A PUT always sets: `value` null is the DELETE's job, so a PUT without a value is a missing field.
      const value = b.value === null ? undefined : b.value;
      return answered("suggest", stage({ postId: m[1], action: "suggest", params: { field, value }, expectedStatus: s.expectedStatus }, userId, isComposer(m[1])), userId);
    }
    return answered("suggest", stage({ postId: m[1], action: "suggest", params: { field, value: null }, requireExpectedStatus: false }, userId, isComposer(m[1])), userId);
  }

  m = /^posts\/([^/]+)\/designs$/.exec(tail);
  if (m && method === "POST") {
    const s = split();
    return answered("add_design", stage({ postId: m[1], action: "add_design", params: s.rest, expectedStatus: s.expectedStatus }, userId, isComposer(m[1])), userId, 201);
  }

  m = /^posts\/([^/]+)\/designs\/([^/]+)$/.exec(tail);
  if (m && method === "DELETE") {
    return answered("remove_design", stage({ postId: m[1], action: "remove_design", params: { designId: decodeURIComponent(m[2]) }, requireExpectedStatus: false }, userId, isComposer(m[1])), userId);
  }
  if (m && method === "PATCH") return patchDesign(m[1], decodeURIComponent(m[2]), b, userId, isComposer(m[1]));

  return null;
}

/** `PATCH posts/:postId/designs/:designId` (position, source, AI note): the design's own gate (`design`, from a design step), then the design must exist. */
function patchDesign(postId: string, designId: string, b: Record<string, unknown>, userId: string, composer: boolean): DemoResult {
  const p = PIPE_POSTS.find((x) => x.id === postId);
  if (!p) return composer ? refuse("not_a_pipeline_post").result : refuse("post_not_found").result;
  if (p.archivedAt) return refuse("post_archived").result;
  if (!cerbosAllows("design", userId, p)) return refuse(FX.cerbosActions.design.refusal).result;
  const add = FX.actions.find((x) => x.action === "add_design")!;
  if (!fromMatches(add, p)) return refuse("invalid_transition", { detail: { status: p.pipelineStatus, changeCase: p.pipelineStatus === "changes" ? p.changeCase : null } }).result;
  const d = p.designs.find((x) => x.id === designId);
  if (!d) return refuse("design_not_found").result;
  if (b.position !== undefined && !(Number.isInteger(b.position) && (b.position as number) >= 1 && (b.position as number) <= 20)) return refuse("invalid_field", { field: "position" }).result;
  if (b.linkSource !== undefined && !(typeof b.linkSource === "string" && ASSET_SOURCES.includes(b.linkSource))) return refuse("invalid_field", { field: "linkSource" }).result;
  if (b.linkAiNote !== undefined && !(typeof b.linkAiNote === "string" && textLen(b.linkAiNote) <= 1000)) return refuse("invalid_field", { field: "linkAiNote" }).result;
  const link = d.link as { url: string; source: string; aiNote: string | null } | null;
  if ((b.linkSource !== undefined || b.linkAiNote !== undefined) && !link) return refuse("invalid_field", { field: b.linkSource !== undefined ? "linkSource" : "linkAiNote" }).result;
  const source = typeof b.linkSource === "string" ? b.linkSource : link?.source;
  const note = typeof b.linkAiNote === "string" ? b.linkAiNote.trim() || null : link?.aiNote ?? null;
  if (link && source === "ai" && !note) return refuse("missing_field", { field: "linkAiNote" }).result;
  if (typeof b.position === "number") d.position = b.position;
  if (link && source) { link.source = source; link.aiNote = note; }
  return { status: 200, json: { post: demoPipelinePost(p, userId) } };
}

/** `POST posts/:postId/actions` in bulk (BFF §63.6.7): each item runs the one runner on its own. Kept here, beside the runner, so the store module never imports it. */
export const demoBulkActions = (body: Record<string, unknown>, userId: string): DemoResult => runDemoPipelineWrite("POST", "posts/actions", body, userId)!;

/** One stage action on one post, with the store written: the feed preview's swap (`demoSocialFeedPreview.ts`) runs two of these and puts the first back if the second is refused. */
export const runDemoStage = (r: Req, userId: string, composer: boolean): Out => stage(r, userId, composer);
