import "server-only";
// SCP-5 W5-C5 (BFF §63.30.4) — what DEMO_MODE answers for the company rules, in the server's order of checks:
//
//   GET   rules                       {version, defaultsVersion, rules, defaults, sections, canEdit}: a staff read (a client contact is refused); `canEdit` follows the persona
//   GET   rules/versions              the history, newest first, with each version's diff against the one before (the seed before version 1)
//   POST  rules/preview               what an unsaved section would do, saving nothing: the next due dates, the next cycle's steps for a client, a client's score
//   PUT   rules/:section              `{expectedVersion, value}`: version + 1, the other sections unchanged
//   POST  rules/:section/reset        `{expectedVersion}`: version + 1 whose section is the seed's
//
// THE ORDER OF CHECKS is the server's own (`rules.controller.ts`): an automation account 403 `automation_cannot_act`, then anyone but the four 403 `not_a_social_approver` (the gate, decided before the body
// is read), then 400 `invalid_field` (the section, the body's keys, `expectedVersion`, `value`, then the value's own field), then 404 `engagement_not_found` (preview), then 409 `rules_changed` (a save).
//
// THE STORE starts at the seed twin (`socialRulesDefaults.json`, version 0, nothing written until someone saves) and keeps every save, so the history, the diffs and a reset work. The preview is plausible,
// not exact: Monday to Friday with no holidays, in UTC, and a score that gives each automatic dimension 3.5 of 5 and leaves a typed one unscored.
import { allocStore, isClientContact, isDemoSocialApprover, pipelineEngagement, who, type DemoResult } from "./demoSocialPipeline";
import { demoValidateSection } from "./demoSocialRulesValidate";
import fixture from "./scpStageMachine.json";
import seedJson from "./socialRulesDefaults.json";
import {
  PERIODIC_KINDS, RULES_SECTIONS, STEP_KEYS, cloneJson, diffRules, sameJson,
  type AuditPreview, type CycleStepRule, type PeriodicKind, type ReportDueRule, type ReportDueRow, type RulesDiffEntry, type RulesDoc, type RulesSection, type RulesSectionState,
} from "./socialRules";

const FX = fixture as { refusals: Record<string, { http: number }> };
const refuse = (code: string, extra: Record<string, unknown> = {}): DemoResult => {
  const http = FX.refusals[code]?.http;
  if (http === undefined) throw new Error(`demoSocialRules: refusal '${code}' is not in the fixture`);
  return { status: http, json: { error: code, ...extra } };
};
const bad = (field: string): DemoResult => refuse("invalid_field", { field });
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isAutomation = (userId: string): boolean => /^(demo-)?(automation|bot)\b/.test(userId);

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const { _about: _a, defaultsVersion: DEFAULTS_VERSION, ...seedSections } = seedJson as unknown as { _about: string; defaultsVersion: string } & RulesDoc;
const SEED: RulesDoc = seedSections as RulesDoc;

interface Version { version: number; rules: RulesDoc; section: RulesSection; reset: boolean; editedBy: { id: string; name: string }; effectiveFrom: string }
interface Store { versions: Version[] }
const STORE = "__demoSocialRules";
type G = typeof globalThis & { [STORE]?: Store };
const store = (): Store => ((globalThis as G)[STORE] ??= { versions: [] });
/** Test hook: back to the seed. */
export function resetDemoSocialRules(): void { delete (globalThis as G)[STORE]; }

const current = (): { version: number; rules: RulesDoc } => {
  const v = store().versions.at(-1);
  return v ? { version: v.version, rules: v.rules } : { version: 0, rules: cloneJson(SEED) };
};

/** The read answer, as the server's `readRulesAnswer`. */
export function demoRulesAnswer(canEdit: boolean) {
  const cur = current();
  const sections = {} as Record<RulesSection, RulesSectionState>;
  for (const s of RULES_SECTIONS) {
    const last = [...store().versions].reverse().find((v) => v.section === s);
    sections[s] = { changed: !sameJson(cur.rules[s], SEED[s]), version: last?.version ?? 0, editedBy: last?.editedBy ?? null, effectiveFrom: last?.effectiveFrom ?? null };
  }
  return { version: cur.version, defaultsVersion: DEFAULTS_VERSION, rules: cur.rules, defaults: cloneJson(SEED), sections, canEdit };
}

// ── dates (Monday to Friday, UTC) ────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const addDays = (iso: string, n: number): string => { const d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso: string): number => ((utc(iso).getUTCDay() + 6) % 7) + 1; // Monday 1 .. Sunday 7
const mondayOf = (iso: string): string => addDays(iso, 1 - dow(iso));
const lastDayOfMonth = (ym: string): string => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const monthPlus = (ym: string, k: number): string => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + (m - 1) + k; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const addWorkingDays = (iso: string, n: number): string => {
  let d = iso;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) { d = addDays(d, step); if (dow(d) <= 5) left -= 1; }
  return d;
};
const lastWorkingOnOrBefore = (iso: string): string => { let d = iso; while (dow(d) > 5) d = addDays(d, -1); return d; };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (ym: string): string => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function isoWeekKey(iso: string): string {
  const thursday = addDays(mondayOf(iso), 3);
  const year = Number(thursday.slice(0, 4));
  const firstThursday = addDays(mondayOf(`${year}-01-04`), 3);
  const week = Math.round((utc(thursday).getTime() - utc(firstThursday).getTime()) / (7 * 86_400_000)) + 1;
  return `${year}-W${pad(week)}`;
}

/** The period of `kind` holding `iso`, and its days (fiscal quarters, halves and years count from `fy` and are named by the year they start in). */
function periodAt(kind: PeriodicKind, iso: string, fy: number): { period: string; range: { start: string; end: string } } {
  if (kind === "daily") return { period: iso, range: { start: iso, end: iso } };
  if (kind === "weekly") { const start = mondayOf(iso); return { period: isoWeekKey(iso), range: { start, end: addDays(start, 6) } }; }
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (kind === "monthly") return { period: iso.slice(0, 7), range: { start: `${iso.slice(0, 7)}-01`, end: lastDayOfMonth(iso.slice(0, 7)) } };
  const offset = (m - fy + 12) % 12;
  const fyYear = m >= fy ? y : y - 1;
  const months = kind === "quarterly" ? 3 : kind === "semester" ? 6 : 12;
  const first = Math.floor(offset / months) * months;
  const startYm = monthPlus(`${fyYear}-${pad(fy)}`, first);
  const n = Math.floor(first / months) + 1;
  const period = kind === "quarterly" ? `${fyYear}-Q${n}` : kind === "semester" ? `${fyYear}-H${n}` : String(fyYear);
  return { period, range: { start: `${startYm}-01`, end: lastDayOfMonth(monthPlus(startYm, months - 1)) } };
}

const dueDayIn = (ym: string, day: number | null): string | null => (day === null ? null : `${ym}-${pad(Math.min(day, Number(lastDayOfMonth(ym).slice(8, 10))))}`);

function reportDue(due: ReportDueRule, range: { start: string; end: string }, reportDay: number | null): string | null {
  if (due.rule === "working_days_after") return addWorkingDays(range.end, due.n);
  if (due.rule === "weekday") return addDays(mondayOf(range.end), (due.week === "next" ? 7 : 0) + due.weekday - 1);
  return dueDayIn(monthPlus(range.end.slice(0, 7), 1), reportDay);
}

const today = (): string => new Date().toISOString().slice(0, 10);
const reportDayOf = (engagementId: string | null): number | null => (engagementId ? allocStore.byEngagement[engagementId]?.reportDueDay ?? null : null);

function previewReports(reports: RulesDoc["reports"], engagementId: string | null) {
  const t = today();
  const day = reportDayOf(engagementId);
  const rows: ReportDueRow[] = PERIODIC_KINDS.map((kind) => {
    const k = reports.kinds[kind];
    const cur = periodAt(kind, t, reports.fiscalYearStartMonth);
    const prev = periodAt(kind, addDays(cur.range.start, -1), reports.fiscalYearStartMonth);
    const cands = [prev, cur].map((x) => ({ ...x, due: reportDue(k.due, x.range, day) }));
    const pick = cands.find((x) => x.due !== null && x.due >= t) ?? cands[1];
    return { kind, enabled: k.enabled, period: pick.period, range: pick.range, due: pick.due };
  });
  return rows;
}

const titleOf = (title: string, month: string): string => title.replace(/\{month(?:-([1-3]))?\}/g, (_m, k: string | undefined) => monthName(monthPlus(month, k ? -Number(k) : 0)));

function stepDue(step: CycleStepRule, month: string, readyBy: string, estimates: Record<string, number>, day: number | null): string | null {
  const d = step.due;
  if (d.rule === "none") return null;
  if (d.rule === "report_due_day") return dueDayIn(monthPlus(month, d.monthOffset), day);
  let lead = d.lessWorkingDays;
  if (d.lessEstimatesFrom !== null) for (const k of STEP_KEYS.slice(STEP_KEYS.indexOf(d.lessEstimatesFrom))) lead += estimates[k] ?? 0;
  return lead > 0 ? addWorkingDays(readyBy, -lead) : readyBy;
}

function previewCycle(cycle: RulesDoc["cycle"], engagementId: string | null) {
  if (!engagementId) return { cycle: null, steps: [], reason: "no_client" };
  const thisMonth = today().slice(0, 7);
  const month = monthPlus(thisMonth, 1);
  const readyBy = lastWorkingOnOrBefore(`${thisMonth}-14`);
  const alloc = allocStore.byEngagement[engagementId];
  return {
    cycle: { cycleId: `demo-cycle-${engagementId}-${month}`, month, readyBy },
    steps: cycle.steps.map((s) => ({ key: s.key, title: titleOf(s.title, month), due: stepDue(s, month, readyBy, alloc?.stepEstimates ?? {}, alloc?.reportDueDay ?? null), autoClose: s.autoClose.rule })),
  };
}

function previewAudit(audit: RulesDoc["audit"], engagementId: string | null): AuditPreview | null {
  if (!engagementId) return null;
  const dimensions = audit.dimensions.map((d) => ({ key: d.key, label: d.label, weight: d.weight, used: d.source === "typed" ? null : 3.5 }));
  const scored = dimensions.filter((d) => d.used !== null && d.weight > 0);
  const totalWeight = scored.reduce((n, d) => n + d.weight, 0);
  const overall = totalWeight === 0 ? null : Math.round((scored.reduce((n, d) => n + d.weight * (d.used as number), 0) / (5 * totalWeight)) * 100);
  const band = overall === null ? null : audit.bands.find((b) => overall >= b.from) ?? null;
  return { month: monthPlus(today().slice(0, 7), -1), overall, band: band?.key ?? null, bandLabel: band?.label ?? null, scored: scored.length, total: dimensions.length, dimensions };
}

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const parse = (body: string | undefined): unknown => { try { return body ? JSON.parse(body) : null; } catch { return undefined; } };
const isSection = (s: unknown): s is RulesSection => typeof s === "string" && (RULES_SECTIONS as readonly string[]).includes(s);

/** The server's `bodyOf`: an object holding only `allowed` keys, or the field of the first other key. */
function bodyOf(raw: unknown, allowed: readonly string[]): { ok: true; b: Record<string, unknown> } | { ok: false; field: string } {
  if (!isObj(raw)) return { ok: false, field: "body" };
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) return { ok: false, field: k };
  return { ok: true, b: raw };
}

function gate(userId: string): DemoResult | null {
  if (isAutomation(userId)) return refuse("automation_cannot_act");
  if (!isDemoSocialApprover(userId)) return refuse("not_a_social_approver");
  return null;
}

function save(section: RulesSection, expectedVersion: number, value: unknown, reset: boolean, userId: string): DemoResult {
  const cur = current();
  if (cur.version !== expectedVersion) return refuse("rules_changed", { detail: { currentVersion: cur.version } });
  const next = reset ? cloneJson(SEED[section]) : value;
  const rules = { ...cur.rules, [section]: next } as RulesDoc;
  store().versions.push({ version: cur.version + 1, rules, section, reset, editedBy: who(userId), effectiveFrom: new Date().toISOString() });
  return ok(demoRulesAnswer(true));
}

function history(sectionQ: string | null, cursorQ: string | null, limitQ: string | null): DemoResult {
  if (sectionQ !== null && sectionQ !== "" && !isSection(sectionQ)) return bad("section");
  let before: number | null = null;
  if (cursorQ) {
    let decoded = "";
    try { decoded = atob(cursorQ.replace(/-/g, "+").replace(/_/g, "/")); } catch { return bad("cursor"); }
    const m = /^v([1-9][0-9]{0,8})$/.exec(decoded);
    if (!m) return bad("cursor");
    before = Number(m[1]);
  }
  let limit = 30;
  if (limitQ) { if (!/^[0-9]{1,3}$/.test(limitQ) || Number(limitQ) < 1 || Number(limitQ) > 100) return bad("limit"); limit = Number(limitQ); }
  const all = store().versions;
  const rows = [...all].reverse().filter((v) => (!sectionQ || v.section === sectionQ) && (before === null || v.version < before));
  const page = rows.slice(0, limit);
  const items = page.map((v) => {
    const prior = v.version === 1 ? SEED : all[v.version - 2].rules;
    const diff: RulesDiffEntry[] = diffRules(prior[v.section], v.rules[v.section], v.section);
    return { version: v.version, section: v.section, reset: v.reset, editedBy: v.editedBy, effectiveFrom: v.effectiveFrom, diff };
  });
  const nextCursor = rows.length > limit ? btoa(`v${items[items.length - 1].version}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
  return ok({ items, nextCursor });
}

function preview(body: string | undefined): DemoResult {
  const raw = bodyOf(parse(body), ["section", "value", "engagementId"]);
  if (!raw.ok) return bad(raw.field);
  const b = raw.b;
  if (!isSection(b.section)) return bad("section");
  if (!("value" in b)) return bad("value");
  const v = demoValidateSection(b.section, b.value);
  if (!v.ok) return bad(v.field);
  let engagementId: string | null = null;
  if (b.engagementId !== undefined && b.engagementId !== null) {
    if (typeof b.engagementId !== "string" || !/^[\w-]{1,64}$/.test(b.engagementId)) return bad("engagementId");
    engagementId = b.engagementId;
    if (!pipelineEngagement(engagementId)) return refuse("engagement_not_found");
  }
  const out: Record<string, unknown> = { section: b.section, engagementId };
  if (b.section === "reports") {
    out.reports = previewReports(v.value as RulesDoc["reports"], engagementId);
    if (!engagementId) out.reason = "no_client";
  } else if (b.section === "cycle") {
    Object.assign(out, previewCycle(v.value as RulesDoc["cycle"], engagementId));
  } else if (b.section === "audit") {
    out.audit = previewAudit(v.value as RulesDoc["audit"], engagementId);
    if (!engagementId) out.reason = "no_client";
  }
  return ok(out);
}

/** The social routes; null for a path that is not the rules'. `tail` is the path after `/modules/social/`. */
export function demoRulesRoute(m: string, tail: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  if (tail === "rules" && m === "GET") {
    if (isClientContact(userId)) return { status: 403, json: { error: "not authorized: social_post read" } };
    return ok(demoRulesAnswer(!isAutomation(userId) && isDemoSocialApprover(userId)));
  }
  if (tail === "rules/versions" && m === "GET") return gate(userId) ?? history(params.get("section"), params.get("cursor"), params.get("limit"));
  if (tail === "rules/preview" && m === "POST") return gate(userId) ?? preview(body);
  const one = tail.match(/^rules\/([^/]+?)(\/reset)?$/);
  if (!one) return null;
  const reset = one[2] === "/reset";
  if (reset ? m !== "POST" : m !== "PUT") return null;
  const refused = gate(userId);
  if (refused) return refused;
  if (!isSection(one[1])) return bad("section");
  const section = one[1];
  const raw = bodyOf(parse(body), reset ? ["expectedVersion"] : ["expectedVersion", "value"]);
  if (!raw.ok) return bad(raw.field);
  const ev = raw.b.expectedVersion;
  if (typeof ev !== "number" || !Number.isInteger(ev) || ev < 0) return bad("expectedVersion");
  if (reset) return save(section, ev, undefined, true, userId);
  if (!("value" in raw.b)) return bad("value");
  const v = demoValidateSection(section, raw.b.value);
  if (!v.ok) return bad(v.field);
  return save(section, ev, v.value, false, userId);
}
