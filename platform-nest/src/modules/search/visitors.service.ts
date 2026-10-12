// M5-V3-g — the read/write half of the consented-visitor routes (visitors.controller.ts; design 2026-10-12 §4.8).
// Pure parsing (filters, cursor, rule bodies) is exported for the unit tests; the DB functions take a tenant id and run
// through withTenants([tenant], fn, {modules:['search']}) (FORCE RLS: an unset scope reads zero rows silently).
//
// Nothing here is personal beyond what the consented profile already holds. Every list/detail carries its own words for a
// non-ok state: a missing or failing source is a `state`, never an empty list.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import {
  InsightsError, insightsSettings, readBotCounts, type BotCounts, type InsightsOpts,
} from "./insights-client";
import { isVisitorJobsEnabled } from "./visitor-jobs";
import { SCORE_MAX, type InterestFacet, type InterestMatch, type Interests, type ScoreParts } from "./visitor-scoring";

const SEARCH = { modules: ["search"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^[a-z0-9-]{1,40}$/;
const FACETS: readonly InterestFacet[] = ["industry", "service"];
const MATCHES: readonly InterestMatch[] = ["path_prefix", "section_prefix"];

export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 50;
export const DETAIL_EVENT_LIMIT = 200;
export const MAX_RULES = 100;
export const LEAD_RESTRICTED_WORDS = "a lead you cannot open";

export type VisitorOrder = "score" | "recent";

export class VisitorRequestError extends Error {
  constructor(readonly reason: string, message: string) { super(message); this.name = "VisitorRequestError"; }
}
const bad = (reason: string, message: string) => new VisitorRequestError(reason, message);

// ── list filters + cursor ───────────────────────────────────────────────────────────────────────────────────────

export interface ListFilters {
  minScore: number | null;
  facet: InterestFacet | null;
  tag: string | null;
  hasLead: boolean | null;
  seenFrom: string | null; // ISO instant
  order: VisitorOrder;
  limit: number;
  cursor: Cursor | null;
}

interface Cursor { s: number | null; t: string; v: string }

export function encodeCursor(c: Cursor): string { return Buffer.from(JSON.stringify(c), "utf8").toString("base64url"); }

export function decodeCursor(raw: string, order: VisitorOrder): Cursor {
  let c: unknown;
  try { c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { throw bad("cursor_invalid", "cursor is not one this server issued"); }
  const o = c as { s?: unknown; t?: unknown; v?: unknown };
  const okT = typeof o?.t === "string" && /^\d{4}-\d{2}-\d{2}[ T][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/.test(o.t);
  const okS = order === "score" ? Number.isInteger(o?.s) && (o.s as number) >= 0 && (o.s as number) <= 100 : o?.s === null || o?.s === undefined;
  if (!o || !okT || !okS || typeof o.v !== "string" || !UUID_RE.test(o.v)) throw bad("cursor_invalid", "cursor is not one this server issued");
  return { s: order === "score" ? (o.s as number) : null, t: o.t as string, v: o.v };
}

type Q = Record<string, string | undefined>;

export function parseListFilters(q: Q): ListFilters {
  const order = (q.order ?? "score") as VisitorOrder;
  if (order !== "score" && order !== "recent") throw bad("order_invalid", "order must be score or recent");
  let minScore: number | null = null;
  if (q.minScore !== undefined && q.minScore !== "") {
    const n = Number(q.minScore);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw bad("min_score_invalid", "minScore must be a whole number from 0 to 100");
    minScore = n;
  }
  let facet: InterestFacet | null = null;
  if (q.facet !== undefined && q.facet !== "") {
    if (!(FACETS as readonly string[]).includes(q.facet)) throw bad("facet_invalid", "facet must be industry or service");
    facet = q.facet as InterestFacet;
  }
  let tag: string | null = null;
  if (q.tag !== undefined && q.tag !== "") {
    if (!TAG_RE.test(q.tag)) throw bad("tag_invalid", "tag must be lower-case letters, digits and dashes (1 to 40)");
    tag = q.tag;
  }
  let hasLead: boolean | null = null;
  if (q.hasLead !== undefined && q.hasLead !== "") {
    if (q.hasLead !== "true" && q.hasLead !== "false") throw bad("has_lead_invalid", "hasLead must be true or false");
    hasLead = q.hasLead === "true";
  }
  let seenFrom: string | null = null;
  if (q.seenFrom !== undefined && q.seenFrom !== "") {
    const d = new Date(q.seenFrom);
    if (!/^\d{4}-\d{2}-\d{2}/.test(q.seenFrom) || Number.isNaN(d.getTime())) throw bad("seen_from_invalid", "seenFrom must be an ISO date or time");
    seenFrom = d.toISOString();
  }
  let limit = LIST_DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== "") {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) throw bad("limit_invalid", `limit must be 1 to ${LIST_MAX_LIMIT}`);
    limit = n;
  }
  const cursor = q.cursor !== undefined && q.cursor !== "" ? decodeCursor(q.cursor, order) : null;
  return { minScore, facet, tag, hasLead, seenFrom, order, limit, cursor };
}

// ── DTOs ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LeadLink =
  | { state: "none" }
  | { state: "readable"; id: string }
  | { state: "restricted"; message: string };

export interface VisitorRow {
  visitorId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
  pageviews: number;
  device: string;
  country: string | null;
  city: string | null;
  network: Record<string, unknown> | null;
  company: Record<string, unknown> | null;
  interests: Interests;
  score: number;
  lead: LeadLink;
}

export interface VisitorEvent { occurredAt: string; kind: "pageview" | "event"; path: string | null; name: string | null; data: Record<string, unknown> | null }

export interface VisitorDetail extends VisitorRow {
  scoreParts: ScoreParts;
  scoreMax: ScoreParts;
  events: VisitorEvent[];
  eventsTruncated: boolean;
}

export interface InterestRuleDto { id: string; match: InterestMatch; pattern: string; facet: InterestFacet; tag: string; weight: number }

/** The lead ids behind a page's consent ids (newest lead wins), and whether the caller may open each: injected so tests can stub Cerbos. */
export type LeadReadProbe = (leadId: string) => Promise<boolean>;

type ProfileRow = {
  visitor_id: string; consent_id: string; first_seen_at: Date; last_seen_at: Date; ts: string; visits: number; pageviews: number; device: string;
  country: string | null; city: string | null; network: Record<string, unknown> | null; company: Record<string, unknown> | null;
  interests: Interests; score: number; score_parts: ScoreParts;
};

const PROFILE_COLS = `p.visitor_id, p.consent_id, p.first_seen_at, p.last_seen_at, p.last_seen_at::text AS ts, p.visits, p.pageviews, p.device,
  p.country, p.city, p.network, p.company, p.interests, p.score, p.score_parts`;

async function leadIdsFor(c: PoolClient, tenantId: string, consentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!consentIds.length) return out;
  const { rows } = await c.query<{ consent_id: string; id: string }>(
    `SELECT DISTINCT ON (visitor_consent->>'consentId') visitor_consent->>'consentId' AS consent_id, id
       FROM agency_leads
      WHERE tenant_id = $1 AND deleted_at IS NULL AND (visitor_consent->>'consentId') = ANY($2::text[])
      ORDER BY (visitor_consent->>'consentId'), created_at DESC, id`,
    [tenantId, consentIds],
  );
  for (const r of rows) out.set(r.consent_id.toLowerCase(), r.id);
  return out;
}

async function leadLinks(
  c: PoolClient, tenantId: string, consentIds: string[], mayRead: LeadReadProbe,
): Promise<Map<string, LeadLink>> {
  const ids = await leadIdsFor(c, tenantId, [...new Set(consentIds.map((x) => x.toLowerCase()))]);
  const verdict = new Map<string, boolean>();
  for (const leadId of new Set(ids.values())) verdict.set(leadId, await mayRead(leadId));
  const out = new Map<string, LeadLink>();
  for (const [consent, leadId] of ids) {
    out.set(consent, verdict.get(leadId) ? { state: "readable", id: leadId } : { state: "restricted", message: LEAD_RESTRICTED_WORDS });
  }
  return out;
}

const iso = (d: Date) => new Date(d).toISOString();

function rowOf(r: ProfileRow, lead: LeadLink): VisitorRow {
  return {
    visitorId: r.visitor_id, firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at), visits: Number(r.visits), pageviews: Number(r.pageviews),
    device: r.device, country: r.country, city: r.city, network: r.network, company: r.company, interests: r.interests ?? {}, score: Number(r.score), lead,
  };
}

/** Resolves the property inside the tenant wall. Null = no such property for this company (404). */
async function propertyExists(c: PoolClient, propertyId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]);
  return r.rows.length > 0;
}

export async function listVisitors(
  tenantId: string, propertyId: string, f: ListFilters, mayRead: LeadReadProbe,
): Promise<{ visitors: VisitorRow[]; nextCursor: string | null } | null> {
  return withTenants([tenantId], async (c) => {
    if (!(await propertyExists(c, propertyId))) return null;
    const args: unknown[] = [tenantId, propertyId];
    const where = ["p.tenant_id = $1", "p.property_id = $2"];
    const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
    if (f.minScore !== null) where.push(`p.score >= ${arg(f.minScore)}`);
    if (f.seenFrom !== null) where.push(`p.last_seen_at >= ${arg(f.seenFrom)}::timestamptz`);
    if (f.tag !== null) {
      const tagJson = arg(JSON.stringify([{ tag: f.tag }]));
      const facets = f.facet ? [f.facet] : [...FACETS];
      where.push("(" + facets.map((fa) => `p.interests->'${fa}' @> ${tagJson}::jsonb`).join(" OR ") + ")");
    } else if (f.facet !== null) {
      where.push(`jsonb_array_length(COALESCE(p.interests->${arg(f.facet)}::text, '[]'::jsonb)) > 0`);
    }
    if (f.hasLead !== null) {
      where.push(`${f.hasLead ? "" : "NOT "}EXISTS (SELECT 1 FROM agency_leads l WHERE l.tenant_id = p.tenant_id AND l.deleted_at IS NULL
                   AND (l.visitor_consent->>'consentId') = p.consent_id::text)`);
    }
    if (f.cursor) {
      const t = arg(f.cursor.t); const v = arg(f.cursor.v);
      where.push(f.order === "score"
        ? `(p.score, p.last_seen_at, p.visitor_id) < (${arg(f.cursor.s)}::smallint, ${t}::timestamptz, ${v}::uuid)`
        : `(p.last_seen_at, p.visitor_id) < (${t}::timestamptz, ${v}::uuid)`);
    }
    const orderBy = f.order === "score" ? "p.score DESC, p.last_seen_at DESC, p.visitor_id DESC" : "p.last_seen_at DESC, p.visitor_id DESC";
    const { rows } = await c.query<ProfileRow>(
      `SELECT ${PROFILE_COLS} FROM search_visitor_profiles p WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ${arg(f.limit + 1)}`, args,
    );
    const page = rows.slice(0, f.limit);
    const links = await leadLinks(c, tenantId, page.map((r) => r.consent_id), mayRead);
    const last = page[page.length - 1];
    return {
      visitors: page.map((r) => rowOf(r, links.get(r.consent_id.toLowerCase()) ?? { state: "none" })),
      nextCursor: rows.length > f.limit && last ? encodeCursor({ s: f.order === "score" ? Number(last.score) : null, t: last.ts, v: last.visitor_id }) : null,
    };
  }, SEARCH);
}

export async function getVisitor(
  tenantId: string, propertyId: string, visitorId: string, mayRead: LeadReadProbe,
): Promise<{ propertyFound: false } | { propertyFound: true; visitor: VisitorDetail | null }> {
  return withTenants([tenantId], async (c) => {
    if (!(await propertyExists(c, propertyId))) return { propertyFound: false as const };
    const p = await c.query<ProfileRow & { id: string }>(
      `SELECT p.id, ${PROFILE_COLS} FROM search_visitor_profiles p WHERE p.tenant_id = $1 AND p.property_id = $2 AND p.visitor_id = $3`,
      [tenantId, propertyId, visitorId],
    );
    const r = p.rows[0];
    if (!r) return { propertyFound: true as const, visitor: null };
    const ev = await c.query<{ occurred_at: Date; kind: "pageview" | "event"; path: string | null; name: string | null; data: Record<string, unknown> | null }>(
      `SELECT occurred_at, kind, path, name, data FROM search_visitor_events WHERE profile_id = $1
        ORDER BY occurred_at DESC, collector_event_id DESC LIMIT ${DETAIL_EVENT_LIMIT + 1}`, [r.id],
    );
    const links = await leadLinks(c, tenantId, [r.consent_id], mayRead);
    const events = ev.rows.slice(0, DETAIL_EVENT_LIMIT).map((e) => ({ occurredAt: iso(e.occurred_at), kind: e.kind, path: e.path, name: e.name, data: e.data }));
    return {
      propertyFound: true as const,
      visitor: {
        ...rowOf(r, links.get(r.consent_id.toLowerCase()) ?? { state: "none" }),
        scoreParts: r.score_parts, scoreMax: { ...SCORE_MAX }, events, eventsTruncated: ev.rows.length > DETAIL_EVENT_LIMIT,
      },
    };
  }, SEARCH);
}

// ── interest rules ──────────────────────────────────────────────────────────────────────────────────────────────

export async function listInterestRules(tenantId: string, propertyId: string): Promise<InterestRuleDto[] | null> {
  return withTenants([tenantId], async (c) => {
    if (!(await propertyExists(c, propertyId))) return null;
    const { rows } = await c.query<InterestRuleDto>(
      `SELECT id, match, pattern, facet, tag, weight FROM search_interest_rules WHERE tenant_id = $1 AND property_id = $2
        ORDER BY facet, tag, match, pattern`, [tenantId, propertyId],
    );
    return rows.map((r) => ({ ...r, weight: Number(r.weight) }));
  }, SEARCH);
}

export interface RuleInput { match: InterestMatch; pattern: string; facet: InterestFacet; tag: string; weight: number }

/** Body of PUT visitors/interest-rules: `{rules: [...]}`, the COMPLETE set (a rule left out is removed). */
export function parseRulesBody(body: unknown): RuleInput[] {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!Array.isArray(b.rules)) throw bad("rules_invalid", "rules must be an array (the complete set of rules)");
  if (b.rules.length > MAX_RULES) throw bad("rules_too_many", `at most ${MAX_RULES} rules`);
  const seen = new Set<string>();
  return b.rules.map((raw, i) => {
    const r = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const at = `rules[${i}]`;
    if (typeof r.match !== "string" || !(MATCHES as readonly string[]).includes(r.match)) throw bad("rule_match_invalid", `${at}.match must be path_prefix or section_prefix`);
    if (typeof r.pattern !== "string" || r.pattern.length < 1 || r.pattern.length > 200) throw bad("rule_pattern_invalid", `${at}.pattern must be 1 to 200 characters`);
    if (typeof r.facet !== "string" || !(FACETS as readonly string[]).includes(r.facet)) throw bad("rule_facet_invalid", `${at}.facet must be industry or service`);
    if (typeof r.tag !== "string" || !TAG_RE.test(r.tag)) throw bad("rule_tag_invalid", `${at}.tag must be lower-case letters, digits and dashes (1 to 40)`);
    if (typeof r.weight !== "number" || !Number.isInteger(r.weight) || r.weight < 1 || r.weight > 10) throw bad("rule_weight_invalid", `${at}.weight must be a whole number from 1 to 10`);
    const key = JSON.stringify([r.match, r.pattern, r.facet, r.tag]);
    if (seen.has(key)) throw bad("rule_duplicate", `${at} repeats an earlier rule`);
    seen.add(key);
    return { match: r.match as InterestMatch, pattern: r.pattern, facet: r.facet as InterestFacet, tag: r.tag, weight: r.weight };
  });
}

/** Replace the property's rule set in one transaction. Null = no such property. Scores follow at the next refresh (V3-e). */
export async function replaceInterestRules(
  tenantId: string, propertyId: string, rules: RuleInput[],
): Promise<{ rules: InterestRuleDto[]; removed: number } | null> {
  return withTenants([tenantId], async (c) => {
    if (!(await propertyExists(c, propertyId))) return null;
    const del = await c.query(
      `DELETE FROM search_interest_rules r WHERE r.tenant_id = $1 AND r.property_id = $2
          AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS k(m, p, f, t)
                           WHERE k.m = r.match AND k.p = r.pattern AND k.f = r.facet AND k.t = r.tag)`,
      [tenantId, propertyId, rules.map((r) => r.match), rules.map((r) => r.pattern), rules.map((r) => r.facet), rules.map((r) => r.tag)],
    );
    for (const r of rules) {
      await c.query(
        `INSERT INTO search_interest_rules (id, tenant_id, property_id, match, pattern, facet, tag, weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT ON CONSTRAINT search_interest_rules_key DO UPDATE SET weight = EXCLUDED.weight, updated_at = now()`,
        [newId(), tenantId, propertyId, r.match, r.pattern, r.facet, r.tag, r.weight],
      );
    }
    const { rows } = await c.query<InterestRuleDto>(
      `SELECT id, match, pattern, facet, tag, weight FROM search_interest_rules WHERE tenant_id = $1 AND property_id = $2 ORDER BY facet, tag, match, pattern`,
      [tenantId, propertyId],
    );
    return { rules: rows.map((x) => ({ ...x, weight: Number(x.weight) })), removed: del.rowCount ?? 0 };
  }, SEARCH);
}

// ── status ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type VisitorStatusState = "ok" | "not_configured" | "disabled" | "no_website" | "unreachable" | "rejected";

export interface VisitorStatus {
  state: VisitorStatusState;
  /** Plain words for every non-ok state. */
  message?: string;
  configured: boolean;
  enabled: boolean;
  lastOkIngestAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  bots: (BotCounts & { days: number }) | null;
}

export const STATUS_WORDS: Record<Exclude<VisitorStatusState, "ok">, string> = {
  not_configured: "The visitor collector is not set up on this server yet (its address and keys are missing), so no visitor has been read.",
  disabled: "Visitor profiles are switched off on this server, so nothing is being collected into profiles. The list shows only what was stored before.",
  no_website: "This property is not linked to a collector website yet, so no visitor can be read for it.",
  unreachable: "The visitor collector could not be reached just now. Profiles already stored are shown; bot counts are unavailable.",
  rejected: "The visitor collector refused the ERP's key or does not know this website. Bot counts are unavailable.",
};

const BOT_WINDOW_DAYS = 30;

export async function buildVisitorStatus(
  tenantId: string, propertyId: string, opts: { insights?: InsightsOpts; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<VisitorStatus | null> {
  const env = opts.env ?? process.env;
  const row = await withTenants([tenantId], async (c) => {
    const p = await c.query<{ website: string | null }>(`SELECT umami_site_id::text AS website FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]);
    if (!p.rows[0]) return null;
    const s = await c.query<{ last_ok_at: Date | null; last_run_at: Date | null; last_outcome: string | null }>(
      `SELECT last_ok_at, last_run_at, last_outcome FROM search_visitor_ingest_state WHERE tenant_id = $1 AND property_id = $2`, [tenantId, propertyId],
    );
    return { website: p.rows[0].website, state: s.rows[0] ?? null };
  }, SEARCH);
  if (!row) return null;
  const settings = opts.insights?.settings === undefined ? insightsSettings(env) : opts.insights.settings;
  const base = {
    configured: settings !== null, enabled: isVisitorJobsEnabled(env),
    lastOkIngestAt: row.state?.last_ok_at ? iso(row.state.last_ok_at) : null,
    lastRunAt: row.state?.last_run_at ? iso(row.state.last_run_at) : null,
    lastOutcome: row.state?.last_outcome ?? null,
    bots: null as VisitorStatus["bots"],
  };
  const fail = (state: Exclude<VisitorStatusState, "ok">): VisitorStatus => ({ state, message: STATUS_WORDS[state], ...base });
  if (!settings) return fail("not_configured");
  if (!base.enabled) return fail("disabled");
  if (!row.website || !UUID_RE.test(row.website)) return fail("no_website");
  const now = opts.now ?? new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (BOT_WINDOW_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  try {
    const bots = await readBotCounts(row.website, { from, to }, { ...opts.insights, settings });
    return { state: "ok", ...base, bots: { ...bots, days: BOT_WINDOW_DAYS } };
  } catch (e) {
    if (e instanceof InsightsError) {
      if (e.kind === "not_configured") return fail("not_configured");
      if (e.kind === "rejected" || e.kind === "not_found") return fail("rejected");
      return fail("unreachable");
    }
    throw e;
  }
}
