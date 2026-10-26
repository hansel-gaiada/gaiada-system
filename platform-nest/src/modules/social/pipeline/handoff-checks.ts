// SCP-1b — the hand-off checks of `send_to_proofread` (FRONTEND-BFF-CONTRACT §63.3.4, plan §4.6; fixture
// `requiredToSend`, `handoffChecks` and `handoffCheckRule`). Pure: no I/O, no clock.
//
// - The hard requirements (`requiredToSend`) can never be skipped: any failure is 409 `incomplete_post`, with every
//   failing one in `blockers`.
// - The soft checks (`handoffChecks`) fail as 409 `checks_failed`, with every failing one in `blockers`, unless the
//   body says `sendAnyway: true` with a `sendAnywayReason` of 10 to 500 characters. Then the skipped codes come back
//   for `skipped_checks` and the activity row.
// - The same checks are a read (`readChecks`): `GET posts/:postId/pipeline` shows `checks: [{code, ok, message,
//   skippable}]` before the officer sends.
//
// The codes and their order are the fixture's. Each code has one implementation below, keyed by the code; a fixture
// code without one (or an implementation the fixture no longer names) refuses to load (`assertHandoffCoverage`).
//
// THE NETWORK LIMITS ARE media-rules.ts's. "Caption plus hashtags within each placement network's limit" and "at most
// 30 hashtags when Instagram is placed" are answered by running `validateVariant` (the composer's, the submit gate's
// and the dispatcher's one validator) on the caption with its hashtags, per placed network, and reading its own
// `body_too_long` / `body_over_base_limit` and `too_many_hashtags` verdicts. No second table of limits exists here.
import { NETWORKS, isNetwork, validateVariant, type Network } from "../media-rules";
import { SCP, type ScpCheck } from "./fixture";

export interface Blocker {
  code: string;
  message: string;
}

export interface RawAsset {
  url?: string | null;
  label?: string | null;
  source?: string | null;
  aiNote?: string | null;
}

/** What the checks read. The post's own fields, the engagement's `platforms`, the brand profile's
 *  `hashtag_strategy.sets` and the cycle's `ready_by`. */
export interface HandoffInput {
  format: string | null;
  caption: string;
  scheduledAt: string | null;
  placement: string[];
  hashtags: string[];
  onAssetText: string | null;
  mustHaves: string[];
  rawAssets: RawAsset[];
  /** `social_engagements.platforms`: what we produce for. */
  platforms: string[];
  /** `social_brand_profiles.hashtag_strategy.sets`. Named in the must-have message when `hashtag_set` is unticked. */
  hashtagSets: Array<{ name: string; tags: string[] }>;
  /** `social_cycles.ready_by`, `YYYY-MM-DD`. */
  readyBy: string | null;
  /** The company's report time zone (BFF §63.0 "Days and time zone"); UTC when unset, as live is today. */
  timeZone?: string;
}

export interface CheckRead {
  code: string;
  ok: boolean;
  message: string;
  skippable: boolean;
}

// ── Prose the fixture holds that this file interprets (pinned verbatim by machine.test.ts) ─────────────────────────

/** `handoffChecks[must_haves_unticked].rule` names the ten keys after "ticked: ". BFF §63.1 points `must_haves` at
 *  this list ("`<@` the ten must-have keys (fixture handoffChecks)"), so it is read from the prose, not retyped. */
export const MUST_HAVES_RULE_PREFIX = "all ten must-haves are ticked: ";

/** `handoffChecks[on_image_text_missing].rule`: the formats that need on-image text, interpreted from its
 *  parenthesis "(feed, carousel, story)". */
export const ON_IMAGE_TEXT_RULE = "onAssetText is not blank when the format needs it (feed, carousel, story)";

function checkRule(code: string): string {
  const c = [...SCP.requiredToSend, ...SCP.handoffChecks].find((x) => x.code === code);
  if (!c) throw new Error(`scp handoff: the fixture has no check '${code}'`);
  return c.rule;
}

function parseMustHaveKeys(): string[] {
  const rule = checkRule("must_haves_unticked");
  if (!rule.startsWith(MUST_HAVES_RULE_PREFIX)) {
    throw new Error(`scp handoff: must_haves_unticked's rule no longer starts '${MUST_HAVES_RULE_PREFIX}'; re-read it`);
  }
  const keys = rule.slice(MUST_HAVES_RULE_PREFIX.length).split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length !== 10 || new Set(keys).size !== 10) throw new Error(`scp handoff: expected ten must-have keys, read ${keys.length}`);
  return keys;
}

function parseOnImageFormats(): string[] {
  const rule = checkRule("on_image_text_missing");
  if (rule !== ON_IMAGE_TEXT_RULE) throw new Error("scp handoff: on_image_text_missing's rule changed; re-read its formats");
  const m = /\(([^)]*)\)/.exec(rule);
  return (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The ten must-have keys, in the fixture's order. */
export const MUST_HAVE_KEYS: readonly string[] = parseMustHaveKeys();

/** The formats whose posts need on-image text. */
export const FORMATS_NEEDING_ON_IMAGE_TEXT: readonly string[] = parseOnImageFormats();

/** BFF §63.3.4: "sendAnywayReason (10 to 500 characters)". */
export const SEND_ANYWAY_REASON_MIN = 10;
export const SEND_ANYWAY_REASON_MAX = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const blank = (s: string | null | undefined): boolean => s === null || s === undefined || s.trim() === "";

/** The caption as a network sees it, hashtags included: the caption, a blank line, then `#tag #tag …`. This is the
 *  "caption plus hashtags" of the rule, whatever the brand's `hashtag_strategy.placement` (body or first comment)
 *  later does with them: the check is on the copy, before any variant exists. */
export function captionWithHashtags(caption: string, hashtags: string[]): string {
  const tags = hashtags.filter((t) => !blank(t)).map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  if (!tags) return caption;
  return caption ? `${caption}\n\n${tags}` : tags;
}

/** `scheduledAt`'s calendar day in `timeZone`, `YYYY-MM-DD`; null when it is not a date. */
export function dayInZone(iso: string, timeZone = "UTC"): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD; the zone is pinned, so the runtime's own zone never matters.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function placedNetworks(input: HandoffInput): Network[] {
  return input.placement.filter((n): n is Network => isNetwork(n));
}

/** The media-rules verdict for the copy alone, on one network. Media, settings and quota are not the copy's
 *  business here (they are the schedule step's `media_rules_pass`), so only the copy rules are read from it. */
function copyVerdict(network: Network, input: HandoffInput) {
  return validateVariant(network, { body: captionWithHashtags(input.caption, input.hashtags) });
}

// ── The implementations, one per fixture code ───────────────────────────────────────────────────────────────────────

type CheckFn = (input: HandoffInput) => string | null; // null = passes; else the failure message

const REQUIRED: Record<string, CheckFn> = {
  format_missing: (i) => (blank(i.format) ? "Choose the post's format." : null),
  caption_missing: (i) => (blank(i.caption) ? "Write the caption." : null),
  date_missing: (i) => (blank(i.scheduledAt) ? "Set the date and time." : null),
  placement_missing: (i) => {
    if (i.placement.length === 0) return "Choose at least one network.";
    const outside = i.placement.filter((n) => !i.platforms.includes(n));
    return outside.length ? `Not one of the client's platforms: ${outside.join(", ")}.` : null;
  },
};

const SOFT: Record<string, CheckFn> = {
  must_haves_unticked: (i) => {
    const unticked = MUST_HAVE_KEYS.filter((k) => !i.mustHaves.includes(k));
    if (!unticked.length) return null;
    const sets = unticked.includes("hashtag_set") && i.hashtagSets.length
      ? ` The client's hashtag sets: ${i.hashtagSets.map((s) => s.name).join(", ")}.`
      : "";
    return `Not ticked: ${unticked.join(", ")}.${sets}`;
  },
  caption_too_long: (i) => {
    const over: string[] = [];
    for (const n of placedNetworks(i)) {
      const v = copyVerdict(n, i);
      const hit = [...v.errors, ...v.warnings].find((x) => x.rule === "body_too_long" || x.rule === "body_over_base_limit");
      if (hit) over.push(hit.message);
    }
    return over.length ? `The caption with its hashtags is too long: ${over.join("; ")}.` : null;
  },
  too_many_hashtags: (i) => {
    const hits = placedNetworks(i).map((n) => copyVerdict(n, i).errors.find((x) => x.rule === "too_many_hashtags")).filter(Boolean);
    return hits.length ? hits.map((h) => h!.message).join("; ") : null;
  },
  on_image_text_missing: (i) =>
    i.format !== null && FORMATS_NEEDING_ON_IMAGE_TEXT.includes(i.format) && blank(i.onAssetText)
      ? `A ${i.format} post needs its on-image text.`
      : null,
  asset_link_missing: (i) => {
    const n = i.rawAssets.filter((a) => blank(a.url)).length;
    return n ? `${n} reference asset(s) have no link.` : null;
  },
  asset_source_unknown: (i) => {
    const n = i.rawAssets.filter((a) => blank(a.source) || a.source === "unknown").length;
    return n ? `${n} reference asset(s) have no known source.` : null;
  },
  ai_note_missing: (i) => {
    const n = i.rawAssets.filter((a) => a.source === "ai" && blank(a.aiNote)).length;
    return n ? `${n} AI-made asset(s) have no AI note.` : null;
  },
  date_before_ready_by: (i) => {
    if (blank(i.scheduledAt) || blank(i.readyBy)) return null;
    const day = dayInZone(i.scheduledAt!, i.timeZone);
    if (day === null) return null;
    return day < i.readyBy! ? `The date (${day}) is before the cycle's ready-by (${i.readyBy}): it needs an earlier hand-off.` : null;
  },
};

/** Fail at load when the fixture and the implementations disagree, so no check is silently skipped. */
export function assertHandoffCoverage(): void {
  const problems: string[] = [];
  const cmp = (label: string, fixture: ScpCheck[], impl: Record<string, CheckFn>) => {
    for (const c of fixture) if (!(c.code in impl)) problems.push(`${label} '${c.code}' has no implementation`);
    for (const k of Object.keys(impl)) if (!fixture.some((c) => c.code === k)) problems.push(`${label} implementation '${k}' is not in the fixture`);
  };
  cmp("requiredToSend", SCP.requiredToSend, REQUIRED);
  cmp("handoffChecks", SCP.handoffChecks, SOFT);
  if (problems.length) throw new Error(`scp handoff checks out of step with the fixture:\n  - ${problems.join("\n  - ")}`);
}
assertHandoffCoverage();

// The networks media-rules knows are the ten the placement CHECK allows (BFF §63.1); a placed network media-rules does
// not know could not be checked, so the two lists must stay one list.
export const HANDOFF_NETWORKS: readonly string[] = NETWORKS;

// ── The API ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function run(fixture: ScpCheck[], impl: Record<string, CheckFn>, input: HandoffInput): Blocker[] {
  const out: Blocker[] = [];
  for (const c of fixture) {
    const msg = impl[c.code](input);
    if (msg !== null) out.push({ code: c.code, message: msg });
  }
  return out;
}

/** Every failing hard requirement, in the fixture's order. */
export function failingRequiredToSend(input: HandoffInput): Blocker[] {
  return run(SCP.requiredToSend, REQUIRED, input);
}

/** Every failing soft check, in the fixture's order. */
export function failingHandoffChecks(input: HandoffInput): Blocker[] {
  return run(SCP.handoffChecks, SOFT, input);
}

/** The read form for the post page: every check, hard ones first, each with its verdict. */
export function readChecks(input: HandoffInput): CheckRead[] {
  const read = (fixture: ScpCheck[], impl: Record<string, CheckFn>, skippable: boolean): CheckRead[] =>
    fixture.map((c) => {
      const msg = impl[c.code](input);
      return { code: c.code, ok: msg === null, message: msg ?? c.rule, skippable };
    });
  return [...read(SCP.requiredToSend, REQUIRED, false), ...read(SCP.handoffChecks, SOFT, true)];
}

export interface SendAnywayParams {
  sendAnyway?: unknown;
  sendAnywayReason?: unknown;
}

export type ParamProblem = { code: "missing_field" | "invalid_field"; field: string };

/** The body rule for "send anyway": `sendAnyway` a boolean when present; with it true, `sendAnywayReason` is required
 *  and 10 to 500 characters (BFF §63.3.4: "missing, 400 {field: "sendAnywayReason"}"). A reason sent without
 *  `sendAnyway` must still be a string of that length, so a typo cannot hide. */
export function validateSendAnyway(params: SendAnywayParams): ParamProblem | null {
  const { sendAnyway, sendAnywayReason } = params;
  if (sendAnyway !== undefined && typeof sendAnyway !== "boolean") return { code: "invalid_field", field: "sendAnyway" };
  const reasonGiven = sendAnywayReason !== undefined && sendAnywayReason !== null && !(typeof sendAnywayReason === "string" && sendAnywayReason.trim() === "");
  if (sendAnyway === true && !reasonGiven) return { code: "missing_field", field: "sendAnywayReason" };
  if (reasonGiven) {
    if (typeof sendAnywayReason !== "string") return { code: "invalid_field", field: "sendAnywayReason" };
    const len = [...sendAnywayReason.trim()].length;
    if (len < SEND_ANYWAY_REASON_MIN || len > SEND_ANYWAY_REASON_MAX) return { code: "invalid_field", field: "sendAnywayReason" };
  }
  return null;
}

export type SendDecision =
  | { ok: true; skippedCodes: string[]; reason: string | null }
  | { ok: false; http: number; code: string; field?: string; blockers?: Blocker[] };

/** The whole `send_to_proofread` hand-off rule, in the machine's order (BFF §63.3.2: the body is step 11, the action's
 *  guards step 12): the body, then the hard requirements, then the soft checks. On a pass, `skippedCodes` is what
 *  "send anyway" skipped (empty when every check passed). */
export function decideSend(input: HandoffInput, params: SendAnywayParams): SendDecision {
  const bad = validateSendAnyway(params);
  if (bad) return { ok: false, http: SCP.refusals[bad.code].http, code: bad.code, field: bad.field };
  const hard = failingRequiredToSend(input);
  if (hard.length) return { ok: false, http: SCP.refusals.incomplete_post.http, code: "incomplete_post", blockers: hard };
  return decideSoft(input, params);
}

/** The soft half alone (the body already validated): `checks_failed`, or the codes "send anyway" skips. */
export function decideSoft(input: HandoffInput, params: SendAnywayParams): SendDecision {
  const soft = failingHandoffChecks(input);
  if (!soft.length) return { ok: true, skippedCodes: [], reason: null };
  if (params.sendAnyway === true && typeof params.sendAnywayReason === "string") {
    return { ok: true, skippedCodes: soft.map((b) => b.code), reason: params.sendAnywayReason.trim() };
  }
  return { ok: false, http: SCP.refusals.checks_failed.http, code: "checks_failed", blockers: soft };
}
