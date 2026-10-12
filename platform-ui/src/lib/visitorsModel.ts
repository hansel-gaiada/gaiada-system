// M5-V3-i — Website -> Visitors: the shapes of platform-nest's consented-visitor API (docs/FRONTEND-BFF-CONTRACT.md §28f,
// platform-nest/src/modules/search/visitors.service.ts), a STRICT parser, and the pure words the screens draw. Pure: no
// server-only imports, so the browser and the tests can use it.
//
// Rules the screens rest on:
//   * a visitor is shown by its first 8 characters only (`shortId`); the full id is only ever in a link;
//   * rows keep the SERVER's order: nothing here sorts;
//   * a non-ok status is words (`STATUS_TITLE` + the server's message), never an empty list or a zero;
//   * a list row says only `linked` or `none`; only the detail can carry a lead id, and a restricted lead carries none;
//   * a body that is off-contract is a contract defect (VisitorsShapeError), not an empty screen.

export class VisitorsShapeError extends Error {}

export const HEADER_LINE = "Only visitors who accepted analytics. A score is a guide for follow-up, never a decision about a person.";

export type InterestFacet = "industry" | "service";
export interface InterestEntry { tag: string; score: number }
export interface Interests { industry: InterestEntry[]; service: InterestEntry[] }
export interface ScoreParts { recency: number; frequency: number; depth: number; intent: number }
/** `kind` says which of Network or Company this is; the resolver also reports a confidence and where it came from. */
export interface Resolved { kind: string | null; name: string | null; domain: string | null; confidence: string | null; source: string | null }

export type RowLead = { state: "none" } | { state: "linked" };
export type DetailLead = { state: "none" } | { state: "readable"; id: string } | { state: "restricted"; message: string };

export interface VisitorRow {
  visitorId: string; firstSeenAt: string; lastSeenAt: string; visits: number; pageviews: number; device: string;
  country: string | null; city: string | null; network: Resolved | null; company: Resolved | null; interests: Interests; score: number; lead: RowLead;
}
export interface VisitorEvent { occurredAt: string; kind: "pageview" | "event"; path: string | null; name: string | null; data: Record<string, string | number | boolean> | null }
export interface VisitorDetail extends Omit<VisitorRow, "lead"> {
  lead: DetailLead; scoreParts: ScoreParts; scoreMax: ScoreParts; events: VisitorEvent[]; eventsTruncated: boolean;
}
export interface VisitorList { propertyId: string; visitors: VisitorRow[]; nextCursor: string | null }

export interface InterestRule { id: string; match: "path_prefix" | "section_prefix"; pattern: string; facet: InterestFacet; tag: string; weight: number }
export interface RuleDraft { match: InterestRule["match"]; pattern: string; facet: InterestFacet; tag: string; weight: number }
export interface InterestRules { propertyId: string; rules: InterestRule[]; note: string }

export type StatusState = "ok" | "not_configured" | "disabled" | "no_website" | "unreachable" | "rejected";
export interface BotCounts { from: string; to: string; days: number; total: number; byReason: Record<string, number> }
export interface VisitorStatus {
  state: StatusState; message: string | null; configured: boolean; enabled: boolean;
  lastOkIngestAt: string | null; lastRunAt: string | null; lastOutcome: string | null; bots: BotCounts | null;
}

// ── strict readers ───────────────────────────────────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): Record<string, unknown> => { if (!isObj(v)) throw new VisitorsShapeError(`${at}: expected an object`); return v; };
const arr = (v: unknown, at: string): unknown[] => { if (!Array.isArray(v)) throw new VisitorsShapeError(`${at}: expected an array`); return v; };
const str = (v: unknown, at: string): string => { if (typeof v !== "string") throw new VisitorsShapeError(`${at}: expected a string`); return v; };
const strN = (v: unknown, at: string): string | null => (v === null || v === undefined ? null : str(v, at));
const bool = (v: unknown, at: string): boolean => { if (typeof v !== "boolean") throw new VisitorsShapeError(`${at}: expected true or false`); return v; };
const int = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new VisitorsShapeError(`${at}: expected a whole number of 0 or more`);
  return v;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, at: string): string => { const s = str(v, at); if (!UUID_RE.test(s)) throw new VisitorsShapeError(`${at}: expected an id`); return s; };

function resolved(v: unknown, at: string): Resolved | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, at);
  // Confidence arrives as text from the resolver's JSON (`short()` in the ingest job) but may be a number: say it either way.
  const conf = o.confidence;
  return {
    kind: strN(o.kind, `${at}.kind`), name: strN(o.name, `${at}.name`), domain: strN(o.domain, `${at}.domain`),
    confidence: typeof conf === "number" ? String(conf) : strN(conf, `${at}.confidence`), source: strN(o.source, `${at}.source`),
  };
}

function interests(v: unknown, at: string): Interests {
  const o = obj(v ?? {}, at);
  const facet = (k: InterestFacet): InterestEntry[] =>
    o[k] === undefined ? [] : arr(o[k], `${at}.${k}`).map((e, i) => { const r = obj(e, `${at}.${k}[${i}]`); return { tag: str(r.tag, `${at}.${k}[${i}].tag`), score: int(r.score, `${at}.${k}[${i}].score`) }; });
  return { industry: facet("industry"), service: facet("service") };
}

function parts(v: unknown, at: string): ScoreParts {
  const o = obj(v, at);
  return { recency: int(o.recency, `${at}.recency`), frequency: int(o.frequency, `${at}.frequency`), depth: int(o.depth, `${at}.depth`), intent: int(o.intent, `${at}.intent`) };
}

function rowBase(o: Record<string, unknown>, at: string) {
  return {
    visitorId: uuid(o.visitorId, `${at}.visitorId`), firstSeenAt: str(o.firstSeenAt, `${at}.firstSeenAt`), lastSeenAt: str(o.lastSeenAt, `${at}.lastSeenAt`),
    visits: int(o.visits, `${at}.visits`), pageviews: int(o.pageviews, `${at}.pageviews`), device: str(o.device, `${at}.device`),
    country: strN(o.country, `${at}.country`), city: strN(o.city, `${at}.city`),
    network: resolved(o.network, `${at}.network`), company: resolved(o.company, `${at}.company`),
    interests: interests(o.interests, `${at}.interests`), score: int(o.score, `${at}.score`),
  };
}

export function parseVisitorList(body: unknown): VisitorList {
  const o = obj(body, "visitors");
  const visitors = arr(o.visitors, "visitors.visitors").map((r, i): VisitorRow => {
    const at = `visitors[${i}]`;
    const row = obj(r, at);
    const lead = obj(row.lead, `${at}.lead`);
    // A list row says only linked or none. An id here would be a contract break (a per-row probe was ruled out), so refuse it.
    if (lead.state !== "none" && lead.state !== "linked") throw new VisitorsShapeError(`${at}.lead.state: expected linked or none`);
    if ("id" in lead) throw new VisitorsShapeError(`${at}.lead: a list row must not carry a lead id`);
    return { ...rowBase(row, at), lead: { state: lead.state } };
  });
  return { propertyId: uuid(o.propertyId, "visitors.propertyId"), visitors, nextCursor: strN(o.nextCursor, "visitors.nextCursor") };
}

export function parseVisitorDetail(body: unknown): VisitorDetail {
  const top = obj(body, "visitor");
  const o = obj(top.visitor, "visitor.visitor");
  const l = obj(o.lead, "visitor.lead");
  let lead: DetailLead;
  if (l.state === "none") lead = { state: "none" };
  else if (l.state === "readable") lead = { state: "readable", id: uuid(l.id, "visitor.lead.id") };
  else if (l.state === "restricted") lead = { state: "restricted", message: typeof l.message === "string" && l.message ? l.message : LEAD_RESTRICTED_WORDS }; // never an id
  else throw new VisitorsShapeError("visitor.lead.state: expected none, readable or restricted");
  const events = arr(o.events, "visitor.events").map((e, i): VisitorEvent => {
    const at = `visitor.events[${i}]`;
    const r = obj(e, at);
    if (r.kind !== "pageview" && r.kind !== "event") throw new VisitorsShapeError(`${at}.kind: expected pageview or event`);
    let data: VisitorEvent["data"] = null;
    if (r.data !== null && r.data !== undefined) {
      data = {};
      for (const [k, v] of Object.entries(obj(r.data, `${at}.data`))) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") data[k] = v;
    }
    return { occurredAt: str(r.occurredAt, `${at}.occurredAt`), kind: r.kind, path: strN(r.path, `${at}.path`), name: strN(r.name, `${at}.name`), data };
  });
  return { ...rowBase(o, "visitor"), lead, scoreParts: parts(o.scoreParts, "visitor.scoreParts"), scoreMax: parts(o.scoreMax, "visitor.scoreMax"), events, eventsTruncated: bool(o.eventsTruncated, "visitor.eventsTruncated") };
}

export function parseInterestRules(body: unknown): InterestRules {
  const o = obj(body, "interest rules");
  const rules = arr(o.rules, "rules").map((r, i): InterestRule => {
    const at = `rules[${i}]`;
    const x = obj(r, at);
    if (x.match !== "path_prefix" && x.match !== "section_prefix") throw new VisitorsShapeError(`${at}.match: expected path_prefix or section_prefix`);
    if (x.facet !== "industry" && x.facet !== "service") throw new VisitorsShapeError(`${at}.facet: expected industry or service`);
    return { id: str(x.id, `${at}.id`), match: x.match, pattern: str(x.pattern, `${at}.pattern`), facet: x.facet, tag: str(x.tag, `${at}.tag`), weight: int(x.weight, `${at}.weight`) };
  });
  return { propertyId: uuid(o.propertyId, "rules.propertyId"), rules, note: str(o.note, "rules.note") };
}

const STATES: readonly StatusState[] = ["ok", "not_configured", "disabled", "no_website", "unreachable", "rejected"];

export function parseVisitorStatus(body: unknown): VisitorStatus {
  const o = obj(body, "status");
  if (typeof o.state !== "string" || !(STATES as readonly string[]).includes(o.state)) throw new VisitorsShapeError("status.state: unknown state");
  const state = o.state as StatusState;
  let bots: BotCounts | null = null;
  if (o.bots !== null && o.bots !== undefined) {
    const b = obj(o.bots, "status.bots");
    const byReason: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj(b.byReason ?? {}, "status.bots.byReason"))) byReason[k] = int(v, `status.bots.byReason.${k}`);
    bots = { from: str(b.from, "status.bots.from"), to: str(b.to, "status.bots.to"), days: int(b.days, "status.bots.days"), total: int(b.total, "status.bots.total"), byReason };
  }
  // `ok` without bot counts is off-contract: the figure would silently be a zero.
  if (state === "ok" && !bots) throw new VisitorsShapeError("status.bots: an ok status must carry bot counts");
  return {
    state, message: typeof o.message === "string" && o.message ? o.message : null,
    configured: bool(o.configured, "status.configured"), enabled: bool(o.enabled, "status.enabled"),
    lastOkIngestAt: strN(o.lastOkIngestAt, "status.lastOkIngestAt"), lastRunAt: strN(o.lastRunAt, "status.lastRunAt"), lastOutcome: strN(o.lastOutcome, "status.lastOutcome"), bots,
  };
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const LEAD_RESTRICTED_WORDS = "a lead you cannot open";

/** A visitor is shown by the first 8 characters of its id, never the whole id. */
export const shortId = (visitorId: string): string => visitorId.replace(/-/g, "").slice(0, 8).toLowerCase();

export const STATUS_TITLE: Record<Exclude<StatusState, "ok">, string> = {
  not_configured: "Visitor collection is not set up",
  disabled: "Visitor profiles are switched off",
  no_website: "No collector website linked",
  unreachable: "The visitor collector is unreachable",
  rejected: "The visitor collector refused the request",
};
/** Used only if a non-ok status arrives without the server's own words (it should not). */
export const STATUS_FALLBACK_WORDS = "The visitor pipeline is not working, so an empty list below does not mean there were no visitors.";
export const statusWords = (s: VisitorStatus): string => s.message ?? STATUS_FALLBACK_WORDS;

/** "2026-10-12 09:30 UTC" from an ISO instant; an unreadable value is shown as it came, never as a guess. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The Network or Company cell, by `kind`. A company result outranks the network it came from; confidence is said in words. */
export function whoLabel(row: Pick<VisitorRow, "network" | "company">): string {
  const pick = (r: Resolved | null): r is Resolved => !!r && !!(r.name || r.domain);
  const c = pick(row.company) ? row.company : null;
  const n = pick(row.network) ? row.network : null;
  const r = c ?? n;
  if (!r) return "Not resolved";
  const label = r.kind === "company" ? "Company" : r.kind === "network" ? "Network" : c ? "Company" : "Network";
  const who = r.name ?? r.domain ?? "";
  return r.confidence ? `${label}: ${who} (${r.confidence} confidence)` : `${label}: ${who}`;
}

export function placeLabel(row: Pick<VisitorRow, "country" | "city">): string {
  if (row.city && row.country) return `${row.city}, ${row.country}`;
  return row.city ?? row.country ?? "Unknown";
}

/** Top interests, in the order the server sent: industry first, then service. */
export function interestChips(i: Interests): string[] {
  return [...i.industry.map((e) => e.tag), ...i.service.map((e) => e.tag)];
}

export const PART_LABELS: Record<keyof ScoreParts, string> = { recency: "Recency", frequency: "Frequency", depth: "Depth", intent: "Intent" };

// ── bot figure (Analytics tab) ───────────────────────────────────────────────────────────────────────────────────
/** The date the collector's bot filter (V2) went live on the site, `YYYY-MM-DD`. Unknown until V2 is deployed: set it
 *  here when it is, and the Analytics note names the day. While null the note says the date is not recorded. */
export const BOT_FILTER_LIVE_DATE: string | null = null;

export function botFilterNote(liveDate: string | null = BOT_FILTER_LIVE_DATE): string {
  return liveDate
    ? `The bot filter went live on ${liveDate}. Umami's visit counts drop from that day, because bot hits are no longer forwarded to it.`
    : "Umami's visit counts drop from the day the bot filter went live, because bot hits are no longer forwarded to it. That day is not recorded here yet.";
}

// ── interest rules: refusal sentences ────────────────────────────────────────────────────────────────────────────
const RULE_REASONS: Record<string, string> = {
  rules_invalid: "The rules were not sent as a complete list. Reload the page and try again.",
  rules_too_many: "There are too many rules: at most 100 are allowed.",
  rule_match_invalid: "A rule matches on something other than a page path or a section. Pick one from the list.",
  rule_pattern_invalid: "A rule's pattern must be between 1 and 200 characters.",
  rule_facet_invalid: "A rule's kind must be industry or service.",
  rule_tag_invalid: "A tag may use only lower-case letters, digits and dashes, 1 to 40 characters.",
  rule_weight_invalid: "A weight must be a whole number from 1 to 10.",
  rule_duplicate: "Two rules are identical (same match, pattern, kind and tag). Remove one.",
};

/** The sentence for a refusal of the rules write. Plain words: a code is never shown. */
export function ruleRefusalSentence(status: number, reason: string | null | undefined): string {
  if (status === 403) return "You are not allowed to change the interest rules.";
  if (status === 404) return "That property no longer exists, so the rules were not saved.";
  if (status === 401) return "Your session has ended. Sign in again, then save the rules.";
  if (reason && RULE_REASONS[reason]) return RULE_REASONS[reason];
  if (status === 400 || status === 422) return "The rules were refused as invalid. Check each row and try again.";
  return "The rules could not be saved just now. Nothing was changed. Try again in a moment.";
}

/** Client-side check before the round trip, with the same sentences the server's refusal would give. null = fine. */
export function checkRuleDrafts(rules: RuleDraft[]): string | null {
  if (rules.length > 100) return RULE_REASONS.rules_too_many;
  const seen = new Set<string>();
  for (const r of rules) {
    if (r.pattern.length < 1 || r.pattern.length > 200) return RULE_REASONS.rule_pattern_invalid;
    if (!/^[a-z0-9-]{1,40}$/.test(r.tag)) return RULE_REASONS.rule_tag_invalid;
    if (!Number.isInteger(r.weight) || r.weight < 1 || r.weight > 10) return RULE_REASONS.rule_weight_invalid;
    const k = JSON.stringify([r.match, r.pattern, r.facet, r.tag]);
    if (seen.has(k)) return RULE_REASONS.rule_duplicate;
    seen.add(k);
  }
  return null;
}

// ── list filters (a plain GET form) ──────────────────────────────────────────────────────────────────────────────
export interface ListQuery { minScore?: string; order?: string; facet?: string; tag?: string; hasLead?: string; seenFrom?: string; cursor?: string }

/** Only the filters the API understands, each trimmed; an unusable value is dropped here and the page says so. */
export function cleanListQuery(q: ListQuery): { query: Record<string, string>; ignored: string[] } {
  const out: Record<string, string> = {};
  const ignored: string[] = [];
  const t = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");
  const put = (k: string, v: string, ok: boolean, label: string) => { if (!v) return; if (ok) out[k] = v; else ignored.push(label); };
  const ms = t(q.minScore);
  put("minScore", ms, /^\d{1,3}$/.test(ms) && Number(ms) <= 100, "minimum score");
  const ord = t(q.order);
  put("order", ord, ord === "score" || ord === "recent", "order");
  const fc = t(q.facet);
  put("facet", fc, fc === "industry" || fc === "service", "interest kind");
  const tg = t(q.tag);
  put("tag", tg, /^[a-z0-9-]{1,40}$/.test(tg), "interest tag");
  const hl = t(q.hasLead);
  put("hasLead", hl, hl === "true" || hl === "false", "lead filter");
  const sf = t(q.seenFrom);
  put("seenFrom", sf, /^\d{4}-\d{2}-\d{2}$/.test(sf) && !Number.isNaN(Date.parse(`${sf}T00:00:00Z`)), "seen-from date");
  const cu = t(q.cursor);
  put("cursor", cu, /^[A-Za-z0-9_-]{1,512}$/.test(cu), "page");
  return { query: out, ignored };
}
