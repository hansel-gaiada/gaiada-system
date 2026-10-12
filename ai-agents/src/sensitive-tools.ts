// M5-G5c — SENSITIVE-TOOL POLICIES for the agent runner: a tool whose arguments (or result) are personal data
// declares how the PERSISTED / LOGGED / MODEL-FACING copy of a call is reduced. The LIVE call to the hub is
// never touched: `deps.callTool` still receives the real identifier, because the tool needs it to run.
//
// THE GAP THIS CLOSES. M5-G5b made the ERP minimise `agency_privacy.*` args before an approval row or an
// outbox event is written (platform-nest `core/approval-arg-minimisers.ts` + `core/agency-privacy.filing.ts`).
// That left THIS service holding the same email/phone: the model's raw reply (`{"tool":..,"args":{"email":..}}`)
// went into `AgentStep.detail`, so into `agent_runs.steps`, `agent_run_events.detail` (append-only, and pushed
// to the SSE bus), the eval/WS9 trace JSONL; the human's goal text ("erase jane@x.com") sat in
// `agent_goals.goal`, the episodic store and the trace; the final answer and the blackboard echoed it. A tool
// RESULT (`find` / `export`) is the person's data itself and was fed back to the model through the transcript.
//
// ── WHAT IS KEPT INSTEAD ─────────────────────────────────────────────────────────────────────────────
// ARGS   {minimised: "agency-privacy.v1", hashes: {emailHash?, phoneHash?}, hints: {emailHint?, phoneHint?}}
//        The hash is the ERP's `subjectHash` ported byte-for-byte (SHA-256 over the domain-separated,
//        NORMALISED value; the domain is WebDesk's own on purpose, so one person hashes the same in WebDesk's
//        ledger, the ERP's ledger and here). Hints are `***@domain` and `***NN`. Everything else the model sent
//        is DROPPED: an allow-list, never a deny-list, so an unexpected key cannot carry an identifier through.
// RESULT {minimised, outcome?, kind?, replayed?, approvalId?, requestId?, counts?, leads: [{leadId, status}]?,
//        outOfScopeLeadIds?}: counts, ids and status words only. No names, emails, phones, answers or free text.
//
// A FOURTH COPY, M5-G5d: a call SUSPENDED with `fileOnSuspend:false` is handed to the ERP assistant as a
// `SuspendedIntent` (parked in memory, returned on `GET /goals/:id`). For a policy tool its args are
// `intentArgsFor(tool, args)`: the ERP's own already-minimised shape (see `minimiseIntentArgs`), so the confirm
// chip can file the approval from it and no raw identifier ever leaves this service in an intent.
//
// ── THREE LAYERS (a policy is the first; the other two catch what it cannot) ─────────────────────────
// 1. STRUCTURED: a call to a policy tool is recorded in its minimised form (step detail, trace, transcript).
// 2. LITERAL SCRUB: once a policy tool is called, the real identifiers are registered with the goal's
//    `SensitiveScope`; every other string that is persisted (outcome, blackboard, goal text, delegate events,
//    error messages) has those literals (raw, lower-cased and separator-tolerant phone forms) replaced by the
//    hint. The scope is SEEDED from the goal text for an agent that holds a policy tool, because the planner
//    and the delegate event name the person BEFORE any tool call and the event table is append-only.
// 3. AMBIENT: the scope rides an AsyncLocalStorage (like `tenantContext`), so a call site that forgets to pass
//    it cannot fail open: `runAgent` / `runOrchestrator` / `traceRun` always pick it up, or make their own.
//
// This module is a LEAF (node:crypto + node:async_hooks only) and its built-in policies are registered
// STATICALLY below: a policy that had to be "registered at boot" could be forgotten by one process, and a
// forgotten policy fails OPEN. `registerSensitiveToolPolicy` is for the NEXT tool that opts in. A tool with no
// policy is stored byte-for-byte as before (regression-tested).
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const MINIMISED_MARKER = "agency-privacy.v1";

// ═══════════════════════════════════════════════════════════════════ the subject helpers (ERP port)
// Port of platform-nest/src/core/agency-privacy.subject.ts (itself a port of WebDesk's subject-refs.ts). The
// projects share no package (root rule: standalone), so parity is pinned by a test vector in
// sensitive-tools.test.ts that was COMPUTED BY THE ERP IMPLEMENTATION, not by this file.

/** WebDesk's own domain prefix (webdesk/api/src/privacy/identifier.ts `hashIdentifier`). */
export const SUBJECT_HASH_DOMAIN = "webdesk:privacy:subject:";

const PHONE_CHARS = /^\+?[\d\s().-]+$/;
const EMAIL_MAX = 320;
const PHONE_MAX = 40;

/** trim + lower-case; null for an empty string. */
export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** Digits with the country code if one was given; null when it is not a usable phone number. */
export function normalizePhone(raw: string): string | null {
  const v = raw.trim();
  if (!PHONE_CHARS.test(v)) return null;
  let digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) {
    // the digits already are country code + number
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** SHA-256 hex of the domain-separated basis. The basis is an ALREADY-normalised email or phone. */
export function subjectHash(basis: string): string {
  return createHash("sha256").update(`${SUBJECT_HASH_DOMAIN}${basis}`).digest("hex");
}

/** `***@domain` for an ALREADY-NORMALISED email. */
export function emailHint(email: string): string {
  return `***@${email.slice(email.lastIndexOf("@") + 1)}`;
}

/** `***` + the last two digits of an ALREADY-NORMALISED phone (digits only). */
export function phoneHint(digits: string): string {
  return `***${digits.slice(-2)}`;
}

/** The normalised email of a raw value, by the ERP's own validity rule; null when the route would refuse it. */
function validEmail(v: unknown): string | null {
  if (typeof v !== "string" || v.length > EMAIL_MAX) return null;
  const e = normalizeEmail(v);
  return e && /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
}

function validPhone(v: unknown): string | null {
  if (typeof v !== "string" || v.length > PHONE_MAX) return null;
  return normalizePhone(v);
}

// ═══════════════════════════════════════════════════════════════════ the policy contract + registry
/** A literal the scope must scrub out of free text once a call carrying it has been seen. */
export interface SecretLiteral {
  kind: "email" | "phone" | "text";
  value: string;
}

export interface SensitiveToolPolicy {
  toolName: string;
  /** PURE, never throws, drops everything not on its allow-list. The args as they may be persisted. */
  minimiseArgs(args: Record<string, unknown>): Record<string, unknown>;
  /** PURE, never throws. The result as it may be persisted / shown to the model, as a string. */
  minimiseResult(result: string): string;
  /** The real values in these args, so the scope can scrub them from free text. */
  secretsOf(args: Record<string, unknown>): SecretLiteral[];
  /**
   * M5-G5d. PURE, never throws. The args of a SUSPENDED call (`SuspendedIntent.args`) in the shape the ERP's own
   * approval-args policy accepts as already minimised (platform-nest `core/approval-arg-minimisers.ts`), so the
   * assistant can store it and later file the approval WITHOUT this service ever handing over the real value.
   * A different shape from `minimiseArgs` (the record shape): that one is ours, this one is the ERP's input.
   */
  minimiseIntentArgs(args: Record<string, unknown>): Record<string, unknown>;
}

const policies = new Map<string, SensitiveToolPolicy>();
const builtIn = new Set<string>();

/** Opt another tool in. Throws on a duplicate name (a policy is a decision, not a default to overwrite). */
export function registerSensitiveToolPolicy(policy: SensitiveToolPolicy): void {
  if (policies.has(policy.toolName)) throw new Error(`sensitive tool policy already registered: ${policy.toolName}`);
  policies.set(policy.toolName, policy);
}

/** Test seam for a fixture policy. Built-in policies cannot be removed. */
export function unregisterSensitiveToolPolicy(toolName: string): void {
  if (builtIn.has(toolName)) throw new Error(`cannot unregister the built-in sensitive tool policy for '${toolName}'`);
  policies.delete(toolName);
}

export function getSensitiveToolPolicy(toolName: string): SensitiveToolPolicy | undefined {
  return policies.get(toolName);
}

export function listSensitiveToolNames(): string[] {
  return [...policies.keys()];
}

/**
 * M5-G5d. The args a suspended call may be HANDED OVER with (`SuspendedIntent.args`): the policy's ERP-shaped copy
 * for a policy tool, the args themselves (untouched, same object) for every other tool.
 */
export function intentArgsFor(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const p = policies.get(tool);
  return p ? p.minimiseIntentArgs(args) : args;
}

/** True when an agent's allow-list names at least one policy tool (the scope is then seeded from the goal). */
export function holdsSensitiveTool(def: { tools: Record<string, unknown> }): boolean {
  return Object.keys(def.tools).some((t) => policies.has(t));
}

// ═══════════════════════════════════════════════════════════════════ agency_privacy.* policy
/** The MCP tool names (kept in step with platform-nest core-tools.ts `AGENCY_PRIVACY_CORE_TOOLS` by a unit test). */
export const AGENCY_PRIVACY_TOOL_NAMES = ["agency_privacy.find", "agency_privacy.export", "agency_privacy.erase"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const COUNT_KEYS = ["leadCount", "submissionCount", "tokenCount", "outOfScopeCount", "suppressionCount"] as const;
const MAX_LISTED = 200;

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function minimiseAgencyPrivacyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const a = obj(args) ?? {};
  const hashes: Record<string, string> = {};
  const hints: Record<string, string> = {};
  const email = validEmail(a.email);
  if (email) { hashes.emailHash = subjectHash(email); hints.emailHint = emailHint(email); }
  const phone = validPhone(a.phone);
  if (phone) { hashes.phoneHash = subjectHash(phone); hints.phoneHint = phoneHint(phone); }
  return { minimised: MINIMISED_MARKER, hashes, hints };
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KIND_OF_TOOL: Readonly<Record<string, "find" | "export" | "erase">> = Object.freeze({
  "agency_privacy.find": "find",
  "agency_privacy.export": "export",
  "agency_privacy.erase": "erase",
});

/**
 * M5-G5d: the suspended call's args as the ERP's `agency_privacy.*` args policy takes them as ALREADY minimised
 * (platform-nest `core/agency-privacy.filing.ts` `minimiseAgencyPrivacyArgs`, the `alreadyMinimised` branch):
 * `{minimised, kind, identifiers, subject: {emailHash?, emailHint?, phoneHash?, phoneHint?}, tenantId?, approvalId?}`.
 * Allow-list again. The ERP re-validates every field, so a forged shape gains nothing there.
 *
 * A value the ERP's route rules would refuse (present but malformed) is NOT narrowed away: the whole call is
 * reduced to an empty shape, which the ERP refuses with its own `subject_invalid`. Dropping the bad phone and
 * keeping the good email would quietly turn "erase this person by email AND phone" into "by email".
 */
function minimiseAgencyPrivacyIntent(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const a = obj(args) ?? {};
  const kind = KIND_OF_TOOL[toolName];
  const present = (v: unknown) => v !== undefined && v !== null;
  const email = validEmail(a.email);
  const phone = validPhone(a.phone);
  const identifiers: ("email" | "phone")[] = [];
  const subject: Record<string, string> = {};
  if ((present(a.email) && !email) || (present(a.phone) && !phone)) {
    return { minimised: MINIMISED_MARKER, kind, identifiers };
  }
  if (email) { identifiers.push("email"); subject.emailHash = subjectHash(email); subject.emailHint = emailHint(email); }
  if (phone) { identifiers.push("phone"); subject.phoneHash = subjectHash(phone); subject.phoneHint = phoneHint(phone); }
  const out: Record<string, unknown> = { minimised: MINIMISED_MARKER, kind, identifiers };
  if (identifiers.length > 0) out.subject = subject;
  if (typeof a.tenantId === "string" && SAFE_ID_RE.test(a.tenantId)) out.tenantId = a.tenantId;
  if (typeof a.approvalId === "string" && UUID_RE.test(a.approvalId)) out.approvalId = a.approvalId;
  return out;
}

/** Counts, ids and status words only. Anything that does not parse is reduced to its size. */
function minimiseAgencyPrivacyResult(result: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { parsed = undefined; }
  const r = obj(parsed);
  if (!r) return JSON.stringify({ minimised: MINIMISED_MARKER, unparsed: true, bytes: result.length });
  const out: Record<string, unknown> = { minimised: MINIMISED_MARKER };
  if (typeof r.outcome === "string" && STATUS_RE.test(r.outcome)) out.outcome = r.outcome;
  if (r.kind === "find" || r.kind === "export" || r.kind === "erase") out.kind = r.kind;
  if (typeof r.replayed === "boolean") out.replayed = r.replayed;
  if (typeof r.approvalId === "string" && UUID_RE.test(r.approvalId)) out.approvalId = r.approvalId;
  if (typeof r.requestId === "string" && UUID_RE.test(r.requestId)) out.requestId = r.requestId;
  if (typeof r.erasedAt === "string" && ISO_RE.test(r.erasedAt)) out.erasedAt = r.erasedAt;
  // counts: nested (`counts: {..}`, the service shape) or flat (the route spreads them), integers only
  const src = obj(r.counts) ?? r;
  const counts: Record<string, number> = {};
  for (const k of COUNT_KEYS) if (typeof src[k] === "number" && Number.isInteger(src[k]) && (src[k] as number) >= 0) counts[k] = src[k] as number;
  if (Object.keys(counts).length > 0) out.counts = counts;
  if (Array.isArray(r.leads)) {
    out.leads = r.leads.slice(0, MAX_LISTED).flatMap((l) => {
      const o = obj(l);
      if (!o || typeof o.leadId !== "string" || !UUID_RE.test(o.leadId)) return [];
      return [{ leadId: o.leadId, ...(typeof o.status === "string" && STATUS_RE.test(o.status) ? { status: o.status } : {}) }];
    });
  }
  if (Array.isArray(r.outOfScope)) {
    out.outOfScopeLeadIds = r.outOfScope.slice(0, MAX_LISTED).flatMap((l) => {
      const id = obj(l)?.leadId;
      return typeof id === "string" && UUID_RE.test(id) ? [id] : [];
    });
  }
  return JSON.stringify(out);
}

function agencyPrivacySecrets(args: Record<string, unknown>): SecretLiteral[] {
  const a = obj(args) ?? {};
  const out: SecretLiteral[] = [];
  // Even a value the route would refuse as malformed is a value somebody typed: scrub it all the same.
  if (typeof a.email === "string" && a.email.trim()) out.push({ kind: "email", value: a.email });
  if (typeof a.phone === "string" && a.phone.trim()) out.push({ kind: "phone", value: a.phone });
  return out;
}

for (const toolName of AGENCY_PRIVACY_TOOL_NAMES) {
  policies.set(toolName, {
    toolName,
    minimiseArgs: minimiseAgencyPrivacyArgs,
    minimiseResult: minimiseAgencyPrivacyResult,
    secretsOf: agencyPrivacySecrets,
    minimiseIntentArgs: (args) => minimiseAgencyPrivacyIntent(toolName, args),
  });
  builtIn.add(toolName);
}

// ═══════════════════════════════════════════════════════════════════ the literal scrubber
const REDACTED = "[redacted]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Matcher {
  key: string;
  re: RegExp;
  replacement: string;
}

/** A phone matched however it is punctuated: the normalised digits with optional separators between them. */
function phoneRegex(digits: string): RegExp {
  const body = digits.split("").join("[\\s().-]*");
  return new RegExp(`(?<!\\d)(?:(?:\\+|00)[\\s().-]*)?${body}(?!\\d)`, "g");
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_IN_TEXT = /(?<![\w.])\+?\d[\d\s().-]{5,}\d(?![\w])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The literals one goal's tree must never persist. Mutable on purpose: it learns the real values when a policy
 * tool is called (or from the goal text, see `seedFromText`) and from then on scrubs every string handed to it.
 * INACTIVE (nothing registered) it is the identity function, which is what keeps every non-sensitive run
 * byte-identical to before this module existed.
 */
export class SensitiveScope {
  private matchers: Matcher[] = [];

  get active(): boolean {
    return this.matchers.length > 0;
  }

  private add(key: string, build: () => RegExp, replacement: string): void {
    if (this.matchers.some((m) => m.key === key)) return;
    this.matchers.push({ key, re: build(), replacement });
  }

  /** Register one literal (and its normalised / punctuated forms). */
  addSecret(s: SecretLiteral): void {
    const raw = s.value.trim();
    if (!raw) return;
    if (s.kind === "email") {
      const norm = validEmail(raw);
      const replacement = norm ? emailHint(norm) : REDACTED;
      this.add(`t:${raw.toLowerCase()}`, () => new RegExp(escapeRe(raw), "gi"), replacement);
      if (norm && norm !== raw.toLowerCase()) this.add(`t:${norm}`, () => new RegExp(escapeRe(norm), "gi"), replacement);
    } else if (s.kind === "phone") {
      const norm = validPhone(raw);
      const replacement = norm ? phoneHint(norm) : REDACTED;
      this.add(`t:${raw.toLowerCase()}`, () => new RegExp(escapeRe(raw), "gi"), replacement);
      if (norm) this.add(`p:${norm}`, () => phoneRegex(norm), replacement);
    } else {
      this.add(`t:${raw.toLowerCase()}`, () => new RegExp(escapeRe(raw), "gi"), REDACTED);
    }
  }

  /**
   * A call to `tool` is about to be recorded. If it has a policy, learn its real values and say so. Called with
   * the model's RAW args BEFORE any persisted copy of the model's reply is built (including for an off-allow-list
   * name: the reply holding the email is persisted whether or not the tool ever runs).
   */
  observeCall(tool: string, args: Record<string, unknown>): boolean {
    const p = policies.get(tool);
    if (!p) return false;
    for (const s of p.secretsOf(args)) this.addSecret(s);
    return true;
  }

  /** Pre-register the emails and phone numbers written in a goal's text (an agent that holds a policy tool). */
  seedFromText(text: string): void {
    for (const m of text.match(EMAIL_IN_TEXT) ?? []) this.addSecret({ kind: "email", value: m });
    for (const m of text.match(PHONE_IN_TEXT) ?? []) {
      const t = m.trim();
      if (ISO_DATE.test(t)) continue; // a date is not a phone number
      if (validPhone(t)) this.addSecret({ kind: "phone", value: t });
    }
  }

  /** Replace every registered literal with its hint. Identity when nothing is registered. */
  scrub(text: string): string {
    if (this.matchers.length === 0 || !text) return text;
    let out = text;
    for (const m of this.matchers) {
      m.re.lastIndex = 0;
      out = out.replace(m.re, m.replacement);
    }
    return out;
  }

  /** `scrub` over every string inside a JSON-able value (blackboard entries, steps). Identity when inactive. */
  scrubDeep<T>(value: T): T {
    if (this.matchers.length === 0) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.scrub(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }

  /** The args as they may be persisted: the policy's copy, or (no policy) the args themselves, untouched. */
  recordableArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const p = policies.get(tool);
    return p ? p.minimiseArgs(args) : args;
  }

  /** The result as it may be persisted / put in the transcript: the policy's copy, or the result untouched. */
  recordableResult(tool: string, result: string): string {
    const p = policies.get(tool);
    return p ? p.minimiseResult(result) : result;
  }
}

// ═══════════════════════════════════════════════════════════════════ the ambient scope
const scopeContext = new AsyncLocalStorage<SensitiveScope>();

/** The scope of the goal this code is running for, if a caller opened one. */
export function currentSensitiveScope(): SensitiveScope | undefined {
  return scopeContext.getStore();
}

/** Run `fn` inside `scope`; everything it awaits sees it as the ambient scope. */
export function runWithSensitiveScope<T>(scope: SensitiveScope, fn: () => T): T {
  return scopeContext.run(scope, fn);
}

/** The ambient scope, or a fresh one: callers that persist anything use this so they never skip the policy. */
export function scopeOrNew(): SensitiveScope {
  return scopeContext.getStore() ?? new SensitiveScope();
}
