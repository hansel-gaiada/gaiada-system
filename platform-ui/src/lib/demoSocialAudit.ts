import "server-only";
// SCP-5g (BFF §63.28) — what DEMO_MODE answers for the social audit, in the server's order of checks and with its gates (SCP-Q34):
//
//   GET    audits?subject=                  the list, worst first                         POST   audits                        a client's draft (or its existing one), or a prospect's audit
//   GET    audits/:auditId                  the scorecard                                 PATCH  audits/:auditId               typed scores, the summary, the month or the prospect's fields (drafts)
//   POST   audits/:auditId/ai-summary       a PROPOSAL; nothing is saved                  POST   audits/:auditId/finalize | attach     freeze the scorecard; a prospect becomes a client
//   DELETE audits/:auditId                  a draft only
//
// THE GATES. Reading: any staff member (a client contact is refused). A CLIENT's audit is written by `manage` on the client's would-be post: its officer and the four approvers (403 `not_officer_or_approver`).
// A PROSPECT's audit, and attaching, are `plan`: the four (403 `not_a_social_approver`). An automation is refused every write (403 `automation_cannot_act`).
// THE ORDER OF CHECKS is the server's own (`audit.service.ts`): an unknown audit is 404 `audit_not_found`; then the gate, CHOSEN FROM THE AUDIT'S SUBJECT and read before the body; then 400 `{field}`; then 409
// (`audit_final` for an edit, a proposal and a delete of a final audit). A create answers 404 `engagement_not_found` for a client that is not there, then the gate, then the body.
//
// THE SCORECARD is the company's rules as seeded (`socialRulesDefaults.json`: twelve dimensions of weight 1, bands from 75 and 50), scored by the same arithmetic as the server (`audit-score.ts`): five times the
// ratio to the nearest half, an overall over the scored dimensions only, the three lowest as the fixes. The six automatic rules read the demo pipeline's own live posts for the audit's month, so the demo draws a
// real scorecard, including a dimension that cannot be scored with its reason. A FINAL audit freezes the scorecard when it is finalized and answers it from then on, whatever the pipeline does.
//
// THE DATA is invented: Northwind Traders has a draft for last month (its stories dimension overridden, with a note), Saltmarsh Day Spa a final audit of last month, Harborlight Hotel none yet (its month has a
// simulated post, so a draft of it says SIMULATED), and one prospect, Fernhill Bakery, has a draft of typed scores with the public numbers it was read from.
import { PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, demoMonthShift, isClientContact, isDemoSocialApprover, who, type DemoResult } from "./demoSocialPipeline";
import { todayIsoInDisplayZone } from "./format";
import fixture from "./scpStageMachine.json";
import rules from "./socialRulesDefaults.json";
import { AUDIT_LIMITS, PUBLIC_KEYS, isHalfScore } from "./socialAudit";

const FX = fixture as { refusals: Record<string, { http: number }> };
const refuse = (code: string, extra: Record<string, unknown> = {}): DemoResult => {
  const http = FX.refusals[code]?.http;
  if (http === undefined) throw new Error(`demoSocialAudit: refusal '${code}' is not in the fixture`);
  return { status: http, json: { error: code, ...extra } };
};
const bad = (field: string): DemoResult => refuse("invalid_field", { field });
const missing = (field: string): DemoResult => refuse("missing_field", { field });
const denied = (action: string): DemoResult => ({ status: 403, json: { error: `not authorized: cerbos denied ${action} on social_post` } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });

const isRes = (v: unknown): v is DemoResult => isObj(v) && typeof v.status === "number" && "json" in v;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const len = (s: string): number => [...s].length;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[\w-]{1,64}$/;
const isAutomation = (userId: string): boolean => /^(demo-)?(automation|bot)\b/.test(userId);
const isRealDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// ── the company's scorecard (the seed: the demo company has not edited its rules) ─────────────────

interface Dimension { key: string; label: string; weight: number; source: string; advice: string }
const DIMENSIONS: readonly Dimension[] = rules.audit.dimensions as Dimension[];
const BANDS = [...(rules.audit.bands as Array<{ key: string; label: string; from: number }>)].sort((a, b) => b.from - a.from);
const RULES_REF = `default:${rules.defaultsVersion}`;

// ── the arithmetic, as `audit-score.ts` does it ──────────────────────────────────────────────────

const ratioScore = (actual: number, expected: number): number => Math.min(5, Math.round(10 * Math.min(1, Math.max(0, actual / expected)) + 1e-9) / 2);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: Array<number | null>): number | null => {
  const k = xs.filter((x): x is number => x !== null);
  return k.length === 0 ? null : k.reduce((a, b) => a + b, 0) / k.length;
};
const round6 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);
const DAY = 86_400_000;
const dayNo = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
const addDays = (iso: string, n: number): string => new Date((dayNo(iso) + n) * DAY).toISOString().slice(0, 10);
const weekStart = (iso: string): string => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const nextMonth = (month: string): string => `${demoMonthShift(month, 1)}-01`;
const weeksTouching = (month: string): string[] => {
  const first = `${month}-01`;
  const last = addDays(nextMonth(month), -1);
  const out: string[] = [];
  for (let w = weekStart(first); w <= last; w = addDays(w, 7)) out.push(w);
  return out;
};

interface LivePost { format: string; isExtra: boolean; week: string; rate: number | null; simulated: boolean }
const rateOf = (m: { reach: number; likes: number; comments: number; shares: number; saves: number } | null): number | null =>
  m && m.reach > 0 ? round6((m.likes + m.comments + m.shares + m.saves) / m.reach) : null;

function livePosts(engagementId: string, from: string, to: string): LivePost[] {
  return PIPE_POSTS.filter((p) => p.engagementId === engagementId && p.pipelineStatus === "live" && !p.archivedAt && p.wentLiveAt && p.wentLiveAt.slice(0, 10) >= from && p.wentLiveAt.slice(0, 10) <= to)
    .map((p) => ({ format: p.format, isExtra: p.isExtra, week: weekStart((p.wentLiveAt as string).slice(0, 10)), rate: rateOf(p.metrics), simulated: p.simulated }));
}

interface Auto { score: number | null; reason: string | null; evidence: Record<string, unknown> }
const none = (reason: string, evidence: Record<string, unknown>): Auto => ({ score: null, reason, evidence });
const scored = (actual: number, expected: number, evidence: Record<string, unknown>): Auto => ({ score: ratioScore(actual, expected), reason: null, evidence });

function automatic(engagementId: string, month: string): { results: Record<string, Auto>; simulated: boolean } {
  const posts = livePosts(engagementId, `${month}-01`, addDays(nextMonth(month), -1));
  const a = allocStore.byEngagement[engagementId];
  const results: Record<string, Auto> = {};
  const counted = posts.filter((p) => !p.isExtra && p.format !== "story").length;
  const target = a?.postsPerCycle ?? null;
  results.consistency = target && target > 0 ? scored(counted, target, { actual: counted, expected: target, unit: "posts" }) : none("no_target", { actual: counted, expected: null, unit: "posts" });
  const formats = [...new Set(a?.formats ?? [])];
  if (formats.length === 0) results.format_mix = none("no_allocated_formats", { actual: null, expected: null, unit: "formats" });
  else {
    const used = formats.filter((f) => posts.some((p) => p.format === f));
    results.format_mix = scored(used.length, formats.length, { actual: used.length, expected: formats.length, unit: "formats", used, allocated: formats });
  }
  // The benchmark: the median of the other clients' rates over the 90 days to the month's end (no client has a business type here, so it is the median of all the others).
  const end = addDays(nextMonth(month), -1);
  const peers = PIPE_ENGAGEMENTS.filter((e) => e.id !== engagementId && e.status !== "closed")
    .map((e) => mean(livePosts(e.id, addDays(end, -90), end).map((p) => p.rate)))
    .filter((r): r is number => r !== null);
  const expected = median(peers);
  const rate = mean(posts.map((p) => p.rate));
  const detail = { benchmarkBasis: expected === null ? null : "own_clients_median_all", peers: peers.length, posts: posts.filter((p) => p.rate !== null).length };
  if (rate === null) results.engagement_rate = none("no_rate", { actual: null, expected: round6(expected), unit: "rate", ...detail });
  else if (expected === null || !(expected > 0)) results.engagement_rate = none("no_benchmark", { actual: round6(rate), expected: round6(expected), unit: "rate", ...detail });
  else results.engagement_rate = scored(rate, expected, { actual: round6(rate), expected: round6(expected), unit: "rate", ...detail });
  const reels = posts.filter((p) => p.format === "reel");
  const feed = posts.filter((p) => p.format === "feed" || p.format === "carousel");
  if (reels.length === 0) results.reels = none("no_reels", { actual: null, expected: null, unit: "rate", reels: 0 });
  else {
    const rr = mean(reels.map((p) => p.rate));
    const fr = mean(feed.map((p) => p.rate));
    if (rr === null) results.reels = none("no_reel_rate", { actual: null, expected: round6(fr), unit: "rate", reels: reels.length });
    else if (fr === null || !(fr > 0)) results.reels = none("no_feed_baseline", { actual: round6(rr), expected: round6(fr), unit: "rate", reels: reels.length });
    else results.reels = scored(rr, fr, { actual: round6(rr), expected: round6(fr), unit: "rate", reels: reels.length });
  }
  const weeks = weeksTouching(month);
  const withStory = new Set(posts.filter((p) => p.format === "story").map((p) => p.week));
  const actualWeeks = weeks.filter((w) => withStory.has(w)).length;
  results.stories = scored(actualWeeks, weeks.length, { actual: actualWeeks, expected: weeks.length, unit: "weeks" });
  // Boosts: the demo's agreed budgets are not part of this twin, so a client has none agreed (the reason is shown).
  results.boosting = none("no_agreed_budget", { actual: 0, expected: 0, unit: "cycles", cycles: 0 });
  return { results, simulated: posts.some((p) => p.simulated) };
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────

interface Typed { score: number | null; note: string }
interface DimView { key: string; label: string; kind: "automatic" | "typed"; weight: number; advice: string; auto: Auto | null; typed: Typed | null; used: number | null }
interface Card { dimensions: DimView[]; overall: number | null; band: { key: string; label: string } | null; scored: number; total: number; fixes: Array<{ key: string; label: string; score: number; advice: string }>; simulated: boolean }

export interface AuditRec {
  id: string;
  subject: "client" | "prospect";
  engagementId: string | null;
  prospectName: string | null;
  businessType: string | null;
  month: string | null;
  publicNumbers: Record<string, number | string>;
  scores: Record<string, Typed>;
  summary: string | null;
  summaryVia: "ai" | "template" | "typed" | null;
  status: "draft" | "final";
  /** The scorecard as it stood at finalize. */
  frozen: Card | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finalizedBy: string | null;
  finalizedAt: string | null;
  deleted: boolean;
}
export interface AuditStore { audits: AuditRec[]; seq: number }
export const emptyAuditStore = (): AuditStore => ({ audits: [], seq: 0 });

/** The scorecard of a record now: a client's automatic part read from the pipeline, a prospect's twelve typed. */
function cardOf(r: Pick<AuditRec, "subject" | "engagementId" | "month" | "scores">): Card {
  const auto = r.subject === "client" && r.engagementId && r.month ? automatic(r.engagementId, r.month) : null;
  const dimensions: DimView[] = DIMENSIONS.map((d) => {
    const a = d.source !== "typed" && auto ? auto.results[d.source] ?? null : null;
    const t = has(r.scores, d.key) ? { score: r.scores[d.key].score, note: r.scores[d.key].note } : null;
    const used = t && t.score !== null ? t.score : a ? a.score : null;
    return { key: d.key, label: d.label, kind: d.source === "typed" ? "typed" : "automatic", weight: d.weight, advice: d.advice, auto: a, typed: t, used };
  });
  let num = 0;
  let den = 0;
  for (const d of dimensions) {
    if (d.used === null) continue;
    const w = Math.round(d.weight * 100);
    num += w * Math.round(d.used * 2);
    den += w;
  }
  const overall = den === 0 ? null : Math.floor((20 * num + den) / (2 * den));
  const band = overall === null ? null : BANDS.find((b) => overall >= b.from) ?? BANDS[BANDS.length - 1];
  const fixes = dimensions.map((d, order) => ({ d, order })).filter((x): x is { d: DimView & { used: number }; order: number } => x.d.used !== null)
    .sort((a, b) => a.d.used - b.d.used || a.order - b.order).slice(0, 3).map(({ d }) => ({ key: d.key, label: d.label, score: d.used, advice: d.advice }));
  return { dimensions, overall, band: band ? { key: band.key, label: band.label } : null, scored: dimensions.filter((d) => d.used !== null).length, total: dimensions.length, fixes, simulated: auto?.simulated ?? false };
}

const engagementOf = (id: string) => PIPE_ENGAGEMENTS.find((e) => e.id === id && e.status !== "closed");
const officerOf = (engagementId: string): string | null => allocStore.byEngagement[engagementId]?.officerId ?? null;
const iso = (ms: number): string => new Date(ms).toISOString();
const hoursAgo = (h: number): string => iso(Date.now() - h * 3_600_000);
const monthNow = (): string => todayIsoInDisplayZone().slice(0, 7);

/** The demo's invented audits (see the file header), built from the demo pipeline's own clients and the day the store is first touched. */
export function seedAuditStore(): AuditStore {
  const s = emptyAuditStore();
  const M = monthNow();
  const last = demoMonthShift(M, -1);
  const [north, spa] = PIPE_ENGAGEMENTS;
  const base = (o: Partial<AuditRec> & Pick<AuditRec, "subject" | "createdBy">): AuditRec => {
    const r: AuditRec = {
      id: `soc-audit-${++s.seq}`, engagementId: null, prospectName: null, businessType: null, month: null, publicNumbers: {}, scores: {}, summary: null, summaryVia: null, status: "draft", frozen: null,
      createdAt: hoursAgo(48), updatedAt: hoursAgo(24), finalizedBy: null, finalizedAt: null, deleted: false, ...o,
    };
    s.audits.push(r);
    return r;
  };
  if (north) {
    base({
      subject: "client", engagementId: north.id, month: last, createdBy: "u-social",
      scores: {
        stories: { score: 4, note: "Stories run every day in the highlights, outside the pipeline, so the automatic count undersells them." },
        profile: { score: 4, note: "Clear bio; the link in bio is current." },
        highlights: { score: 3.5, note: "Two highlights are out of date." },
        visual: { score: 4.5, note: "" },
        caption_cta: { score: 3, note: "Half of the captions end without a call to action." },
        community: { score: 3.5, note: "" },
      },
      summary: "Northwind posts steadily and its look is consistent. The weakest areas are the call to action in captions and keeping the highlights fresh.", summaryVia: "typed",
    });
  }
  if (spa) {
    const r = base({
      subject: "client", engagementId: spa.id, month: last, createdBy: "u-social-2", createdAt: hoursAgo(24 * 20), updatedAt: hoursAgo(24 * 18),
      scores: { profile: { score: 4.5, note: "" }, highlights: { score: 4, note: "" }, visual: { score: 5, note: "Soft natural light on every post." }, caption_cta: { score: 3.5, note: "" }, community: { score: 4, note: "" }, cross_platform: { score: 2.5, note: "The Facebook page has not been updated since spring." } },
      summary: "Saltmarsh has a calm, consistent look and answers its community well. Posting volume and the second network are where to start.", summaryVia: "template",
    });
    r.frozen = cardOf(r);
    r.status = "final";
    r.finalizedBy = "u-pm";
    r.finalizedAt = hoursAgo(24 * 18);
  }
  base({
    subject: "prospect", prospectName: "Fernhill Bakery", businessType: "Bakery", createdBy: "u-pm", createdAt: hoursAgo(72), updatedAt: hoursAgo(70),
    publicNumbers: { followers: 3100, postsLast30Days: 6, avgLikes: 54.5, avgComments: 3, lastPostOn: demoMonthShift(M, 0) + "-02" },
    scores: { consistency: { score: 2, note: "Six posts in a month, none on weekends." }, format_mix: { score: 1.5, note: "Photos only." }, profile: { score: 3, note: "The bio does not say where the bakery is." }, visual: { score: 3.5, note: "" } },
  });
  return s;
}

// ── the api ──────────────────────────────────────────────────────────────────────────────────────

export function auditApi(store: AuditStore) {
  const find = (id: string) => store.audits.find((a) => a.id === id && !a.deleted);
  const nameOf = (r: AuditRec): string => (r.subject === "prospect" ? r.prospectName ?? "" : engagementOf(r.engagementId ?? "")?.clientName ?? PIPE_ENGAGEMENTS.find((e) => e.id === r.engagementId)?.clientName ?? "");
  const monthLabel = (m: string | null): string | null => m;

  // ── gates ────────────────────────────────────────────────────────────────────────────────────

  const isFour = (userId: string): boolean => isDemoSocialApprover(userId);
  const mayManageClient = (userId: string, engagementId: string | null): boolean => isDemoSocialApprover(userId) || (engagementId !== null && officerOf(engagementId) === userId);
  /** The write gate of an audit that exists, from its subject. Null when allowed. */
  const gateWrite = (userId: string, r: Pick<AuditRec, "subject" | "engagementId">): DemoResult | null => {
    if (isAutomation(userId)) return refuse("automation_cannot_act");
    if (r.subject === "prospect") return isFour(userId) ? null : refuse("not_a_social_approver");
    return mayManageClient(userId, r.engagementId) ? null : refuse("not_officer_or_approver");
  };
  const mayWrite = (userId: string, r: Pick<AuditRec, "subject" | "engagementId">): boolean => !isAutomation(userId) && gateWrite(userId, r) === null;

  // ── answers ──────────────────────────────────────────────────────────────────────────────────

  const dimAnswer = (d: DimView) => ({ key: d.key, label: d.label, kind: d.kind, weight: d.weight, advice: d.advice, auto: d.auto, typed: d.typed, used: d.used });
  /** The audit as the routes answer it: a draft computed now, a final one its frozen scorecard. */
  function answer(r: AuditRec, canWrite: boolean): Record<string, unknown> {
    const card = r.status === "final" && r.frozen ? r.frozen : cardOf(r);
    const draft = r.status === "draft";
    return {
      id: r.id, subject: r.subject, engagementId: r.engagementId, name: nameOf(r), prospectName: r.prospectName, businessType: r.businessType, month: monthLabel(r.month),
      publicNumbers: r.publicNumbers, status: r.status, rulesRef: RULES_REF, summary: r.summary, summaryVia: r.summaryVia, dimensions: card.dimensions.map(dimAnswer),
      overall: card.overall, band: card.band?.key ?? null, bandLabel: card.band?.label ?? null, scored: card.scored, total: card.total, fixes: card.fixes, simulated: card.simulated,
      createdBy: who(r.createdBy), createdAt: r.createdAt, updatedAt: r.updatedAt, finalizedBy: r.finalizedBy ? who(r.finalizedBy) : null, finalizedAt: r.finalizedAt,
      canWrite: canWrite && draft, canFinalize: canWrite && draft,
    };
  }

  function listItem(r: AuditRec): Record<string, unknown> {
    const card = r.status === "final" && r.frozen ? r.frozen : cardOf(r);
    return {
      auditId: r.id, subject: r.subject, engagementId: r.engagementId, name: nameOf(r), status: r.status, month: monthLabel(r.month), overall: card.overall, band: card.band?.key ?? null,
      bandLabel: card.band?.label ?? null, scored: card.scored, total: card.total, topFix: card.fixes[0] ?? null, finalizedAt: r.finalizedAt, simulated: card.simulated,
    };
  }

  const worstFirst = (xs: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    [...xs].sort((a, b) => {
      const ao = a.overall as number | null;
      const bo = b.overall as number | null;
      if (ao === null && bo !== null) return 1;
      if (ao !== null && bo === null) return -1;
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      return String(a.name).localeCompare(String(b.name), "en");
    });

  // ── GET audits ───────────────────────────────────────────────────────────────────────────────

  function list(params: URLSearchParams, userId: string): DemoResult {
    if (isClientContact(userId)) return denied("read");
    for (const k of params.keys()) if (k !== "subject") return bad(k);
    const s = params.get("subject");
    if (s !== null && s !== "" && s !== "client" && s !== "prospect") return bad("subject");
    const subject = s === "client" || s === "prospect" ? s : null;
    const items: Array<Record<string, unknown>> = [];
    if (subject !== "prospect") {
      for (const e of PIPE_ENGAGEMENTS.filter((x) => x.status !== "closed")) {
        const mine = store.audits.filter((a) => !a.deleted && a.subject === "client" && a.engagementId === e.id);
        const draft = mine.find((a) => a.status === "draft");
        const final = mine.filter((a) => a.status === "final").sort((a, b) => (b.finalizedAt ?? "").localeCompare(a.finalizedAt ?? ""))[0];
        const row = draft ?? final;
        items.push(row ? listItem(row) : {
          auditId: null, subject: "client", engagementId: e.id, name: e.clientName, status: null, month: null, overall: null, band: null, bandLabel: null, scored: 0, total: DIMENSIONS.length,
          topFix: null, finalizedAt: null, simulated: false,
        });
      }
    }
    if (subject !== "client") for (const p of store.audits.filter((a) => !a.deleted && a.subject === "prospect")) items.push(listItem(p));
    return ok({ items: worstFirst(items), canAddProspect: !isAutomation(userId) && isFour(userId) });
  }

  // ── GET audits/:id ───────────────────────────────────────────────────────────────────────────

  function read(id: string, userId: string): DemoResult {
    if (isClientContact(userId)) return denied("read");
    const r = find(id);
    if (!r) return refuse("audit_not_found");
    return ok(answer(r, mayWrite(userId, r)));
  }

  // ── POST audits ──────────────────────────────────────────────────────────────────────────────

  const publicNumbersOf = (v: unknown, field = "publicNumbers"): DemoResult | Record<string, number | string> => {
    if (v === null) return {};
    if (!isObj(v)) return bad(field);
    const out: Record<string, number | string> = {};
    for (const k of Object.keys(v)) if (!(PUBLIC_KEYS as readonly string[]).includes(k)) return bad(`${field}.${k}`);
    for (const k of ["followers", "postsLast30Days"]) {
      const x = v[k];
      if (x === undefined || x === null) continue;
      if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > AUDIT_LIMITS.count) return bad(`${field}.${k}`);
      out[k] = x;
    }
    for (const k of ["avgLikes", "avgComments"]) {
      const x = v[k];
      if (x === undefined || x === null) continue;
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > AUDIT_LIMITS.count) return bad(`${field}.${k}`);
      out[k] = Math.round(x * 100) / 100;
    }
    if (v.lastPostOn !== undefined && v.lastPostOn !== null) {
      if (!isRealDay(v.lastPostOn)) return bad(`${field}.lastPostOn`);
      out.lastPostOn = v.lastPostOn;
    }
    return out;
  };

  const parseMonth = (v: unknown, field: string): DemoResult | string => {
    if (typeof v !== "string") return bad(field);
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v.trim());
    if (!m || (m[3] !== undefined && m[3] !== "01") || Number(m[2]) < 1 || Number(m[2]) > 12) return bad(field);
    return `${m[1]}-${m[2]}`;
  };

  function create(body: string | undefined, userId: string): DemoResult {
    let json: unknown;
    try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
    const subject = isObj(json) && (json.subject === "client" || json.subject === "prospect") ? json.subject : null;
    if (subject === "client") {
      const eid = isObj(json) && typeof json.engagementId === "string" && ID.test(json.engagementId) ? json.engagementId : null;
      const eng = eid ? engagementOf(eid) : undefined;
      if (eid && !eng) return refuse("engagement_not_found");
      if (isAutomation(userId)) return refuse("automation_cannot_act");
      if (!mayManageClient(userId, eng ? eng.id : null)) return refuse("not_officer_or_approver");
    } else {
      if (isAutomation(userId)) return refuse("automation_cannot_act");
      if (!isFour(userId)) return refuse("not_a_social_approver");
    }
    if (!isObj(json)) return bad("body");
    if (json.subject === undefined || json.subject === null) return missing("subject");
    if (subject === null) return bad("subject");
    const allowed = subject === "client" ? ["id", "subject", "engagementId", "month"] : ["id", "subject", "prospectName", "businessType", "publicNumbers"];
    for (const k of Object.keys(json)) if (!allowed.includes(k)) return bad(k);
    let id: string | null = null;
    if (json.id !== undefined && json.id !== null) {
      if (typeof json.id !== "string" || !UUID.test(json.id)) return bad("id");
      id = json.id.toLowerCase();
    }
    const M = monthNow();
    let month = "";
    let engagementId = "";
    let prospectName = "";
    let businessType: string | null = null;
    let publicNumbers: Record<string, number | string> = {};
    if (subject === "client") {
      if (json.engagementId === undefined || json.engagementId === null) return missing("engagementId");
      if (typeof json.engagementId !== "string" || !ID.test(json.engagementId)) return bad("engagementId");
      engagementId = json.engagementId;
      if (json.month === undefined || json.month === null) month = demoMonthShift(M, -1);
      else { const m = parseMonth(json.month, "month"); if (typeof m !== "string") return m; month = m; }
      if (month > M) return bad("month");
    } else {
      if (json.prospectName === undefined || json.prospectName === null) return missing("prospectName");
      if (typeof json.prospectName !== "string") return bad("prospectName");
      prospectName = json.prospectName.trim();
      if (prospectName === "") return missing("prospectName");
      if (len(prospectName) > AUDIT_LIMITS.prospectName) return bad("prospectName");
      if (json.businessType !== undefined && json.businessType !== null) {
        if (typeof json.businessType !== "string") return bad("businessType");
        const t = json.businessType.trim();
        if (len(t) > AUDIT_LIMITS.businessType) return bad("businessType");
        businessType = t === "" ? null : t;
      }
      if (json.publicNumbers !== undefined) { const p = publicNumbersOf(json.publicNumbers); if (isRes(p)) return p; publicNumbers = p; }
    }
    // A replayed `id` answers the audit as it stands; an `id` of another client or subject, or a deleted audit's, is 400 `{field: 'id'}`.
    if (id) {
      const taken = store.audits.find((a) => a.id === id);
      if (taken) {
        const same = subject === "client" ? taken.subject === "client" && taken.engagementId === engagementId : taken.subject === "prospect";
        if (!same || taken.deleted) return bad("id");
        return ok({ audit: answer(taken, true), created: false });
      }
    }
    if (subject === "client") {
      const draft = store.audits.find((a) => !a.deleted && a.subject === "client" && a.engagementId === engagementId && a.status === "draft");
      if (draft) return ok({ audit: answer(draft, true), created: false });
    }
    const now = new Date().toISOString();
    const rec: AuditRec = {
      id: id ?? `soc-audit-${++store.seq}`, subject, engagementId: subject === "client" ? engagementId : null, prospectName: subject === "prospect" ? prospectName : null, businessType,
      month: subject === "client" ? month : null, publicNumbers, scores: {}, summary: null, summaryVia: null, status: "draft", frozen: null, createdBy: userId, createdAt: now, updatedAt: now,
      finalizedBy: null, finalizedAt: null, deleted: false,
    };
    store.audits.push(rec);
    return ok({ audit: answer(rec, true), created: true }, 201);
  }

  // ── PATCH audits/:id ─────────────────────────────────────────────────────────────────────────

  function patch(id: string, body: string | undefined, userId: string): DemoResult {
    const r = find(id);
    if (!r) return refuse("audit_not_found");
    const g = gateWrite(userId, r);
    if (g) return g;
    let json: unknown;
    try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
    if (!isObj(json)) return bad("body");
    const own = r.subject === "client" ? ["month"] : ["prospectName", "businessType", "publicNumbers"];
    for (const k of Object.keys(json)) if (!["scores", "summary", "summaryVia", ...own].includes(k)) return bad(k);
    const dims = new Map(DIMENSIONS.map((d) => [d.key, d]));
    const scorePatch: Record<string, Typed | null> = {};
    if (has(json, "scores")) {
      const s = json.scores;
      if (!isObj(s)) return bad("scores");
      for (const key of Object.keys(s)) {
        const dim = dims.get(key);
        if (!dim) return bad(`scores.${key}`);
        const e = s[key];
        if (e === null) { scorePatch[key] = null; continue; }
        if (!isObj(e)) return bad(`scores.${key}`);
        for (const k of Object.keys(e)) if (k !== "score" && k !== "note") return bad(`scores.${key}.${k}`);
        if (!has(e, "score")) return missing(`scores.${key}.score`);
        if (e.score !== null && !isHalfScore(e.score)) return bad(`scores.${key}.score`);
        let note: string;
        if (has(e, "note") && e.note !== undefined && e.note !== null) {
          if (typeof e.note !== "string") return bad(`scores.${key}.note`);
          note = e.note.trim();
          if (len(note) > AUDIT_LIMITS.note) return bad(`scores.${key}.note`);
        } else note = r.scores[key]?.note ?? "";
        if (e.score === null) { scorePatch[key] = note === "" ? null : { score: null, note }; continue; }
        if (r.subject === "client" && dim.source !== "typed" && note === "") return missing(`scores.${key}.note`);
        scorePatch[key] = { score: e.score as number, note };
      }
    }
    let summary: { text: string | null; via: AuditRec["summaryVia"] } | undefined;
    if (has(json, "summary") || has(json, "summaryVia")) {
      const text = has(json, "summary") ? json.summary : undefined;
      if (text === undefined) return missing("summary");
      if (text === null) {
        if (json.summaryVia !== undefined && json.summaryVia !== null) return bad("summaryVia");
        summary = { text: null, via: null };
      } else {
        if (typeof text !== "string") return bad("summary");
        const t = text.trim();
        if (len(t) > AUDIT_LIMITS.summary) return bad("summary");
        let via: AuditRec["summaryVia"] = "typed";
        if (json.summaryVia !== undefined && json.summaryVia !== null) {
          if (json.summaryVia !== "ai" && json.summaryVia !== "template" && json.summaryVia !== "typed") return bad("summaryVia");
          via = json.summaryVia;
        }
        summary = t === "" ? { text: null, via: null } : { text: t, via };
      }
    }
    let month: string | undefined;
    let prospectName: string | undefined;
    let businessType: string | null | undefined;
    let publicNumbers: Record<string, number | string> | undefined;
    if (r.subject === "client") {
      if (has(json, "month")) { const m = parseMonth(json.month, "month"); if (typeof m !== "string") return m; if (m > monthNow()) return bad("month"); month = m; }
    } else {
      if (has(json, "prospectName")) {
        if (typeof json.prospectName !== "string") return bad("prospectName");
        const t = json.prospectName.trim();
        if (t === "") return missing("prospectName");
        if (len(t) > AUDIT_LIMITS.prospectName) return bad("prospectName");
        prospectName = t;
      }
      if (has(json, "businessType")) {
        if (json.businessType !== null && typeof json.businessType !== "string") return bad("businessType");
        const t = typeof json.businessType === "string" ? json.businessType.trim() : "";
        if (len(t) > AUDIT_LIMITS.businessType) return bad("businessType");
        businessType = t === "" ? null : t;
      }
      if (has(json, "publicNumbers")) { const p = publicNumbersOf(json.publicNumbers); if (isRes(p)) return p; publicNumbers = p; }
    }
    if (r.status === "final") return refuse("audit_final");
    if (Object.keys(json).length === 0) return ok({ audit: answer(r, true) });
    for (const [k, v] of Object.entries(scorePatch)) { if (v === null) delete r.scores[k]; else r.scores[k] = v; }
    if (summary) { r.summary = summary.text; r.summaryVia = summary.via; }
    if (month !== undefined) r.month = month;
    if (prospectName !== undefined) r.prospectName = prospectName;
    if (businessType !== undefined) r.businessType = businessType;
    if (publicNumbers !== undefined) r.publicNumbers = publicNumbers;
    r.updatedAt = new Date().toISOString();
    return ok({ audit: answer(r, true) });
  }

  // ── POST audits/:id/ai-summary ───────────────────────────────────────────────────────────────

  function aiSummary(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return refuse("audit_not_found");
    const g = gateWrite(userId, r);
    if (g) return g;
    if (r.status === "final") return refuse("audit_final");
    const card = cardOf(r);
    const name = nameOf(r);
    const subject = r.subject === "client" ? `${name}'s social media${r.month ? ` for ${r.month}` : ""}` : `${name}'s social media`;
    if (card.overall === null) return ok({ summary: `${subject}: nothing is scored yet, so there is no overall score. Score the dimensions to see where to start.`, draftedVia: "template" });
    const best = [...card.dimensions].filter((d) => d.used !== null).sort((a, b) => (b.used as number) - (a.used as number))[0];
    const fixes = card.fixes.map((f) => `${f.label} (${f.score} out of 5)`).join(", ");
    const head = `${subject} scores ${card.overall} out of 100 (${card.band?.label ?? "no band"}), with ${card.scored} of ${card.total} dimensions scored.`;
    // The gateway is answered for a client whose numbers are real; a simulated audit and a prospect's get the plain template (as if the gateway were down), so both sentences can be seen.
    if (!card.simulated && r.subject === "client") {
      return ok({ summary: `${head} ${best ? `${best.label} is the strongest area at ${best.used} out of 5. ` : ""}Start with ${fixes}: ${card.fixes[0]?.advice ?? ""}`.trim(), draftedVia: "ai" });
    }
    return ok({ summary: `${head} ${best ? `The strongest area is ${best.label} at ${best.used} out of 5. ` : ""}Start with: ${fixes}. ${card.fixes[0]?.advice ?? ""}`.trim(), draftedVia: "template" });
  }

  // ── POST audits/:id/finalize ─────────────────────────────────────────────────────────────────

  function finalize(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return refuse("audit_not_found");
    const g = gateWrite(userId, r);
    if (g) return g;
    if (r.status === "final") return ok({ alreadyApplied: true, audit: answer(r, true) });
    r.frozen = cardOf(r);
    r.status = "final";
    r.finalizedBy = userId;
    r.finalizedAt = new Date().toISOString();
    r.updatedAt = r.finalizedAt;
    return ok({ audit: answer(r, true) });
  }

  // ── POST audits/:id/attach ───────────────────────────────────────────────────────────────────

  function attach(id: string, body: string | undefined, userId: string): DemoResult {
    const r = find(id);
    if (!r) return refuse("audit_not_found");
    // Attaching is the four's, whatever the audit.
    if (isAutomation(userId)) return refuse("automation_cannot_act");
    if (!isFour(userId)) return refuse("not_a_social_approver");
    let json: unknown;
    try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
    if (!isObj(json)) return bad("body");
    for (const k of Object.keys(json)) if (k !== "engagementId") return bad(k);
    if (json.engagementId === undefined || json.engagementId === null) return missing("engagementId");
    if (typeof json.engagementId !== "string" || !ID.test(json.engagementId)) return bad("engagementId");
    const eng = engagementOf(json.engagementId);
    if (!eng) return refuse("engagement_not_found");
    if (r.subject !== "prospect") return refuse("not_a_prospect_audit");
    if (r.engagementId === eng.id) return ok({ alreadyApplied: true, audit: answer(r, true) });
    if (r.engagementId !== null) return refuse("audit_attached");
    r.engagementId = eng.id;
    r.updatedAt = new Date().toISOString();
    return ok({ audit: answer(r, true) });
  }

  // ── DELETE audits/:id ────────────────────────────────────────────────────────────────────────

  function remove(id: string, userId: string): DemoResult {
    const r = find(id);
    if (!r) return refuse("audit_not_found");
    const g = gateWrite(userId, r);
    if (g) return g;
    if (r.status === "final") return refuse("audit_final");
    r.deleted = true;
    return ok({ deleted: true, id: r.id });
  }

  /** The routes of 63.28 by `tail` (the path after `modules/social/`); null for any other path or method (the caller falls through). */
  function staff(method: string, tail: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
    const m = method.toUpperCase();
    let x: RegExpExecArray | null;
    if (tail === "audits") return m === "GET" ? list(params, userId) : m === "POST" ? create(body, userId) : null;
    if ((x = /^audits\/([^/]+)$/.exec(tail))) {
      const id = decodeURIComponent(x[1]);
      return m === "GET" ? read(id, userId) : m === "PATCH" ? patch(id, body, userId) : m === "DELETE" ? remove(id, userId) : null;
    }
    if ((x = /^audits\/([^/]+)\/(ai-summary|finalize|attach)$/.exec(tail))) {
      if (m !== "POST") return null;
      const id = decodeURIComponent(x[1]);
      return x[2] === "ai-summary" ? aiSummary(id, userId) : x[2] === "finalize" ? finalize(id, userId) : attach(id, body, userId);
    }
    return null;
  }

  return { staff, store, find };
}

// ── the demo's own store, pinned to globalThis like the other demo stores ───────────────────────────────────────────────
const KEY = Symbol.for("gaiada.demoSocial.audits");
const demoStore: AuditStore = ((globalThis as Record<symbol, unknown>)[KEY] ??= seedAuditStore()) as AuditStore;
export const demoAudits = auditApi(demoStore);

/** The routes of 63.28 by `tail`; null when `tail` is none of them. */
export const demoAuditRoute = demoAudits.staff;
