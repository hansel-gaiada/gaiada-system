// SCP-5g (W5-B4) — the rows of the social audit and the pipeline reads its six automatic dimensions need (FRONTEND-BFF-CONTRACT §63.28; table
// `social_audits`, migration 202610301102). Every function takes the caller's client: the caller owns the transaction, its tenant scope and its row
// locks. `social_audits`, `social_posts`, `social_post_variants`, `social_cycles` and `social_engagements` carry the third wall, so each caller runs
// inside `withTenants([tenantId], …, { modules: ["social"] })` and each reader declares the scope itself.
//
// The writes keep the table's CHECKs true by construction (they are the second line, not the first): a client has an engagement and a month and no
// prospect name or public numbers; a prospect has a name and no month; final ⇔ finalized_at ⇔ finalized_by ⇔ frozen; overall and band only on a final
// audit and together; summary ⇔ summary_via; deleted_at ⇔ deleted_by and only a draft is deleted.
import type { PoolClient } from "pg";
import { declareSocialModuleScope } from "../module-scope";
import { SIMULATED_SQL } from "./overview-data";
import { userNames } from "./pipeline-data";
import {
  addDaysIso, BENCHMARK_WINDOW_DAYS, BOOST_MONTHS, isoWeeksTouching, meanOf, monthsBefore, nextMonthStart, resolveBenchmark, weekStartOf,
  type AutoInputs, type LivePost, type TypedScore,
} from "./audit-score";
import { postRate, type MetricSource, type Snapshot } from "./post-metrics";
import { readStoredScores, type AuditStatus, type AuditSubject, type PublicNumbers, type SummaryVia } from "./audit";
import type { AuditRules } from "./rules";

/** A `social_audits` row, the columns the routes read. Timestamps are ISO strings; `month` is `YYYY-MM-01`. */
export interface AuditRow {
  id: string;
  subject: AuditSubject;
  engagement_id: string | null;
  prospect_name: string | null;
  business_type: string | null;
  month: string | null;
  public_numbers: PublicNumbers;
  scores: Record<string, TypedScore>;
  frozen: Record<string, unknown> | null;
  overall: number | null;
  band: string | null;
  summary: string | null;
  summary_via: SummaryVia | null;
  status: AuditStatus;
  rules_ref: string;
  simulated: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  finalized_by: string | null;
  finalized_at: string | null;
}

const ISO = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const AUDIT_COLUMNS = `a.id::text AS id, a.subject, a.engagement_id::text AS engagement_id, a.prospect_name, a.business_type,
  to_char(a.month, 'YYYY-MM-DD') AS month, a.public_numbers, a.scores, a.frozen, a.overall::int AS overall, a.band, a.summary, a.summary_via, a.status,
  a.rules_ref, a.simulated, a.created_by::text AS created_by, ${ISO("a.created_at")} AS created_at, ${ISO("a.updated_at")} AS updated_at,
  a.finalized_by::text AS finalized_by, ${ISO("a.finalized_at")} AS finalized_at`;

type RawAudit = Omit<AuditRow, "scores"> & { scores: unknown };
const toRow = (r: RawAudit): AuditRow => ({ ...r, scores: readStoredScores(r.scores) });

/** The audit, LIVE (not deleted), or null. `lock` takes the row lock a write holds for its decision (a final audit is read under it too). */
export async function loadAudit(c: PoolClient, tenantId: string, auditId: string, lock = false): Promise<AuditRow | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<RawAudit>(
    `SELECT ${AUDIT_COLUMNS} FROM social_audits a WHERE a.tenant_id = $1 AND a.id = $2 AND a.deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, auditId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** The audit by id, deleted or not: the create's replay test ("an `id` used for another subject is 400"). */
export async function loadAuditAnyState(c: PoolClient, tenantId: string, auditId: string): Promise<(AuditRow & { deleted: boolean }) | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<RawAudit & { deleted: boolean }>(
    `SELECT ${AUDIT_COLUMNS}, (a.deleted_at IS NOT NULL) AS deleted FROM social_audits a WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, auditId],
  );
  return rows[0] ? { ...toRow(rows[0]), deleted: rows[0].deleted } : null;
}

/** The client's live draft, or null. */
export async function loadClientDraft(c: PoolClient, tenantId: string, engagementId: string): Promise<AuditRow | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<RawAudit>(
    `SELECT ${AUDIT_COLUMNS} FROM social_audits a
      WHERE a.tenant_id = $1 AND a.engagement_id = $2 AND a.subject = 'client' AND a.status = 'draft' AND a.deleted_at IS NULL`,
    [tenantId, engagementId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Another transaction's first INSERT of a client's draft (the unique index) answers false here: the caller then reads the draft that won. */
export async function insertClientAudit(
  c: PoolClient, a: { tenantId: string; id: string; engagementId: string; month: string; rulesRef: string; actorId: string },
): Promise<boolean> {
  await declareSocialModuleScope(c);
  const r = await c.query(
    `INSERT INTO social_audits (id, tenant_id, subject, engagement_id, month, rules_ref, created_by, updated_by)
     VALUES ($1, $2, 'client', $3, $4::date, $5, $6, $6) ON CONFLICT DO NOTHING`,
    [a.id, a.tenantId, a.engagementId, a.month, a.rulesRef, a.actorId],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function insertProspectAudit(
  c: PoolClient,
  a: { tenantId: string; id: string; prospectName: string; businessType: string | null; publicNumbers: PublicNumbers; rulesRef: string; actorId: string },
): Promise<boolean> {
  await declareSocialModuleScope(c);
  const r = await c.query(
    `INSERT INTO social_audits (id, tenant_id, subject, prospect_name, business_type, public_numbers, rules_ref, created_by, updated_by)
     VALUES ($1, $2, 'prospect', $3, $4, $5::jsonb, $6, $7, $7) ON CONFLICT (id) DO NOTHING`,
    [a.id, a.tenantId, a.prospectName, a.businessType, JSON.stringify(a.publicNumbers), a.rulesRef, a.actorId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** A draft's editable columns; a key left out stays. */
export interface AuditColumns {
  scores?: Record<string, TypedScore>;
  summary?: { text: string | null; via: SummaryVia | null };
  month?: string;
  prospectName?: string;
  businessType?: string | null;
  publicNumbers?: PublicNumbers;
}

/** Updates a DRAFT's columns (the caller holds its lock and has judged it a draft). */
export async function updateAuditDraft(c: PoolClient, tenantId: string, auditId: string, cols: AuditColumns, actorId: string): Promise<void> {
  await declareSocialModuleScope(c);
  const sets: string[] = ["updated_by = $3", "updated_at = now()"];
  const params: unknown[] = [tenantId, auditId, actorId];
  const set = (sql: (n: number) => string, v: unknown): void => { params.push(v); sets.push(sql(params.length)); };
  if (cols.scores !== undefined) set((n) => `scores = $${n}::jsonb`, JSON.stringify(cols.scores));
  if (cols.summary !== undefined) {
    set((n) => `summary = $${n}`, cols.summary.text);
    set((n) => `summary_via = $${n}`, cols.summary.via);
  }
  if (cols.month !== undefined) set((n) => `month = $${n}::date`, cols.month);
  if (cols.prospectName !== undefined) set((n) => `prospect_name = $${n}`, cols.prospectName);
  if (cols.businessType !== undefined) set((n) => `business_type = $${n}`, cols.businessType);
  if (cols.publicNumbers !== undefined) set((n) => `public_numbers = $${n}::jsonb`, JSON.stringify(cols.publicNumbers));
  await c.query(`UPDATE social_audits SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2 AND status = 'draft' AND deleted_at IS NULL`, params);
}

export async function softDeleteAuditDraft(c: PoolClient, tenantId: string, auditId: string, actorId: string): Promise<void> {
  await declareSocialModuleScope(c);
  await c.query(
    `UPDATE social_audits SET deleted_at = now(), deleted_by = $3, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft' AND deleted_at IS NULL`,
    [tenantId, auditId, actorId],
  );
}

/** Freezes the draft: written once, every CHECK of a final audit true together. */
export async function finalizeAuditRow(
  c: PoolClient,
  a: {
    tenantId: string; auditId: string; actorId: string; frozen: unknown; overall: number | null; band: string | null; simulated: boolean; businessType: string | null;
  },
): Promise<void> {
  await declareSocialModuleScope(c);
  await c.query(
    `UPDATE social_audits SET status = 'final', frozen = $3::jsonb, overall = $4, band = $5, simulated = $6, business_type = $7,
            finalized_by = $8, finalized_at = now(), updated_by = $8, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft' AND deleted_at IS NULL`,
    [a.tenantId, a.auditId, JSON.stringify(a.frozen), a.overall, a.band, a.simulated, a.businessType, a.actorId],
  );
}

/** Records the client a prospect became (a final audit's `frozen` is not touched). */
export async function attachAuditRow(c: PoolClient, tenantId: string, auditId: string, engagementId: string, actorId: string): Promise<void> {
  await declareSocialModuleScope(c);
  await c.query(
    `UPDATE social_audits SET engagement_id = $3, updated_by = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND subject = 'prospect' AND deleted_at IS NULL`,
    [tenantId, auditId, engagementId, actorId],
  );
}

/** The names of the people on rows, as `{id, name}`. */
export async function personRefs(c: PoolClient, ids: Array<string | null>): Promise<Map<string, { id: string; name: string }>> {
  const names = await userNames(c, ids);
  return new Map([...names.entries()].map(([id, name]) => [id, { id, name }]));
}

// ═══ The client side of an audit ══════════════════════════════════════════════════════════════════════════════════════════

export interface ClientFacts {
  engagementId: string;
  clientId: string;
  clientName: string;
  postsPerCycle: number | null;
  formats: string[];
  businessType: string | null;
}

/** The engagement (live), with its client's name, allocation and business type; null when it is not this company's. */
export async function loadClientFacts(c: PoolClient, tenantId: string, engagementId: string): Promise<ClientFacts | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; client_id: string; client_name: string; posts_per_cycle: number | null; formats: string[] | null; business_type: string | null }>(
    `SELECT e.id::text AS id, e.client_id::text AS client_id, cl.name AS client_name, e.posts_per_cycle, e.formats, ccp.business_type
       FROM social_engagements e
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
       LEFT JOIN client_centre_profiles ccp ON ccp.tenant_id = e.tenant_id AND ccp.client_id = e.client_id
      WHERE e.tenant_id = $1 AND e.id = $2 AND e.deleted_at IS NULL`,
    [tenantId, engagementId],
  );
  const r = rows[0];
  return r
    ? {
      engagementId: r.id, clientId: r.client_id, clientName: r.client_name, postsPerCycle: r.posts_per_cycle === null ? null : Number(r.posts_per_cycle),
      formats: r.formats ?? [], businessType: r.business_type,
    }
    : null;
}

interface RawLive { id: string; engagement_id: string; format: string | null; is_extra: boolean; live_day: string; simulated: boolean }
interface RawSnap { post_id: string; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; source: MetricSource; fetched_at: Date | string }

/**
 * The live pipeline posts of `engagementIds` that went live on a company day in [`from`, `toExcl`), with each post's 63.10 rate (the variants' newest
 * snapshots, `postRate`: null without a reach). "Live" is `pipeline_status = 'live'`, not archived, not deleted.
 */
async function readLivePosts(
  c: PoolClient, tenantId: string, engagementIds: readonly string[], range: { from: string; toExcl: string; tz: string },
): Promise<Map<string, Array<LivePost & { day: string }>>> {
  const out = new Map<string, Array<LivePost & { day: string }>>();
  if (engagementIds.length === 0) return out;
  await declareSocialModuleScope(c);
  const posts = await c.query<RawLive>(
    `SELECT p.id::text AS id, p.engagement_id::text AS engagement_id, p.format, p.is_extra,
            to_char(p.went_live_at AT TIME ZONE $3, 'YYYY-MM-DD') AS live_day, ${SIMULATED_SQL} AS simulated
       FROM social_posts p
      WHERE p.tenant_id = $1 AND p.engagement_id = ANY($2::uuid[]) AND p.pipeline_status = 'live' AND p.went_live_at IS NOT NULL
        AND p.deleted_at IS NULL AND p.archived_at IS NULL
        AND (p.went_live_at AT TIME ZONE $3)::date >= $4::date AND (p.went_live_at AT TIME ZONE $3)::date < $5::date`,
    [tenantId, [...engagementIds], range.tz, range.from, range.toExcl],
  );
  if (posts.rows.length === 0) return out;
  const snaps = await c.query<RawSnap>(
    `SELECT v.post_id::text AS post_id, m.reach, m.likes, m.comments, m.shares, m.saves, m.source, m.fetched_at
       FROM social_post_variants v
       JOIN LATERAL (
         SELECT x.reach, x.likes, x.comments, x.shares, x.saves, x.source, x.fetched_at
           FROM social_post_metrics x
          WHERE x.tenant_id = v.tenant_id AND x.variant_id = v.id
          ORDER BY x.fetched_at DESC, x.created_at DESC, x.id DESC LIMIT 1
       ) m ON true
      WHERE v.tenant_id = $1 AND v.post_id = ANY($2::uuid[]) AND v.deleted_at IS NULL`,
    [tenantId, posts.rows.map((p) => p.id)],
  );
  const byPost = new Map<string, Snapshot[]>();
  for (const s of snaps.rows) {
    const snap: Snapshot = {
      reach: s.reach, impressions: null, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves, videoViews: null, clicks: null,
      source: s.source, capturedAt: new Date(s.fetched_at),
    };
    byPost.set(s.post_id, [...(byPost.get(s.post_id) ?? []), snap]);
  }
  for (const p of posts.rows) {
    const mine = byPost.get(p.id) ?? [];
    const post = {
      format: p.format, isExtra: p.is_extra === true, weekStart: weekStartOf(p.live_day), rate: postRate(mine),
      simulated: p.simulated === true || mine.some((s) => s.source === "simulated"), day: p.live_day,
    };
    out.set(p.engagement_id, [...(out.get(p.engagement_id) ?? []), post]);
  }
  return out;
}

/**
 * The OTHER clients' rates over the 90 days to the end of the month: each other open engagement of another client with at least one live post that has a
 * rate, its mean post rate, split by whether the client shares `businessType` (compared ignoring case and edges; a client with no type shares with nobody).
 */
async function readPeerRates(
  c: PoolClient, tenantId: string, self: ClientFacts, month: string, tz: string,
): Promise<{ sameType: number[]; all: number[] }> {
  await declareSocialModuleScope(c);
  const peers = await c.query<{ id: string; business_type: string | null }>(
    `SELECT e.id::text AS id, ccp.business_type
       FROM social_engagements e
       LEFT JOIN client_centre_profiles ccp ON ccp.tenant_id = e.tenant_id AND ccp.client_id = e.client_id
      WHERE e.tenant_id = $1 AND e.deleted_at IS NULL AND e.status <> 'closed' AND e.client_id <> $2::uuid`,
    [tenantId, self.clientId],
  );
  const toExcl = nextMonthStart(month);
  const live = await readLivePosts(c, tenantId, peers.rows.map((p) => p.id), { from: addDaysIso(toExcl, -BENCHMARK_WINDOW_DAYS), toExcl, tz });
  const want = (self.businessType ?? "").trim().toLowerCase();
  const sameType: number[] = [];
  const all: number[] = [];
  for (const p of peers.rows) {
    const rate = meanOf((live.get(p.id) ?? []).map((x) => x.rate));
    if (rate === null) continue;
    all.push(rate);
    if (want !== "" && (p.business_type ?? "").trim().toLowerCase() === want) sameType.push(rate);
  }
  return { sameType, all };
}

async function readBoostFacts(c: PoolClient, tenantId: string, engagementId: string, month: string): Promise<AutoInputs["boosts"]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ ran: boolean; agreed: boolean; simulated: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM social_boosts b WHERE b.tenant_id = cy.tenant_id AND b.cycle_id = cy.id AND b.status IN ('stopped', 'completed')) AS ran,
            EXISTS (SELECT 1 FROM social_boost_budgets bb WHERE bb.tenant_id = cy.tenant_id AND bb.cycle_id = cy.id AND bb.status = 'agreed' AND bb.amount_minor > 0) AS agreed,
            EXISTS (SELECT 1 FROM social_boosts b WHERE b.tenant_id = cy.tenant_id AND b.cycle_id = cy.id AND b.status IN ('stopped', 'completed') AND b.simulated) AS simulated
       FROM social_cycles cy
      WHERE cy.tenant_id = $1 AND cy.engagement_id = $2 AND cy.deleted_at IS NULL AND cy.month >= $3::date AND cy.month < $4::date`,
    [tenantId, engagementId, monthsBefore(month, BOOST_MONTHS - 1), nextMonthStart(month)],
  );
  return {
    cycles: rows.length, ran: rows.filter((r) => r.ran).length, agreed: rows.filter((r) => r.agreed).length, simulated: rows.some((r) => r.simulated),
  };
}

/**
 * Everything the six automatic rules read for one client and month, in the caller's transaction. `benchmark` is the scorecard's (a draft's own rules, or
 * the edited ones a rules preview asks about). The peers are read only when the benchmark is the company's own median.
 */
export async function readAutoInputs(
  c: PoolClient, tenantId: string, client: ClientFacts, a: { month: string; tz: string; benchmark: AuditRules["benchmark"] },
): Promise<AutoInputs> {
  const live = await readLivePosts(c, tenantId, [client.engagementId], { from: a.month, toExcl: nextMonthStart(a.month), tz: a.tz });
  const posts: LivePost[] = (live.get(client.engagementId) ?? []).map(({ day: _day, ...p }) => p);
  const peers = a.benchmark.source === "own_clients_median" ? await readPeerRates(c, tenantId, client, a.month, a.tz) : { sameType: [], all: [] };
  return {
    target: client.postsPerCycle, allocatedFormats: client.formats, posts, weeks: isoWeeksTouching(a.month),
    benchmark: resolveBenchmark(a.benchmark, client.businessType, peers),
    boosts: await readBoostFacts(c, tenantId, client.engagementId, a.month),
  };
}

// ═══ The list ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface OpenClient { engagementId: string; clientName: string }

/** Every open engagement (not closed, not deleted), by client name. */
export async function readOpenClients(c: PoolClient, tenantId: string): Promise<OpenClient[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; client_name: string }>(
    `SELECT e.id::text AS id, cl.name AS client_name
       FROM social_engagements e JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.deleted_at IS NULL AND e.status <> 'closed'
      ORDER BY cl.name, e.id`,
    [tenantId],
  );
  return rows.map((r) => ({ engagementId: r.id, clientName: r.client_name }));
}

/** Each client's live draft and latest final (client audits), and every prospect audit, in the order a list reads them (newest first). */
export async function readAuditsForList(
  c: PoolClient, tenantId: string, which: { client: boolean; prospect: boolean },
): Promise<{ drafts: Map<string, AuditRow>; finals: Map<string, AuditRow>; prospects: AuditRow[] }> {
  await declareSocialModuleScope(c);
  const drafts = new Map<string, AuditRow>();
  const finals = new Map<string, AuditRow>();
  let prospects: AuditRow[] = [];
  if (which.client) {
    const { rows } = await c.query<RawAudit>(
      `SELECT DISTINCT ON (a.engagement_id, a.status) ${AUDIT_COLUMNS}
         FROM social_audits a
        WHERE a.tenant_id = $1 AND a.subject = 'client' AND a.deleted_at IS NULL
        ORDER BY a.engagement_id, a.status, a.finalized_at DESC NULLS LAST, a.created_at DESC, a.id`,
      [tenantId],
    );
    for (const r of rows) {
      const row = toRow(r);
      if (row.engagement_id) (row.status === "draft" ? drafts : finals).set(row.engagement_id, row);
    }
  }
  if (which.prospect) {
    const { rows } = await c.query<RawAudit>(
      `SELECT ${AUDIT_COLUMNS} FROM social_audits a WHERE a.tenant_id = $1 AND a.subject = 'prospect' AND a.deleted_at IS NULL ORDER BY a.created_at DESC, a.id`,
      [tenantId],
    );
    prospects = rows.map(toRow);
  }
  return { drafts, finals, prospects };
}

/** The name a client row is shown under. */
export async function clientNameOf(c: PoolClient, tenantId: string, engagementId: string): Promise<string | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ name: string }>(
    `SELECT cl.name FROM social_engagements e JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id WHERE e.tenant_id = $1 AND e.id = $2`,
    [tenantId, engagementId],
  );
  return rows[0]?.name ?? null;
}
