// M5-P5a — IndexNow on publish, the DB side: the per-property key and switch, the idempotent submission
// ledger / retry queue (search_indexnow_submissions), the publish -> ping flow, the manual submit, and the
// retry sweep. The network lives in indexnow.ts (IndexNow) and bing-client.ts (Bing's URL Submission API, the
// non-IndexNow fallback); this file holds no fetch.
//
// TENANCY. Every query runs through withTenants([tenantId], fn, { modules: ["search"] }): another company's
// property id is simply not visible (404), and the third RLS wall (the module scope) is declared on every call
// (omit it and these tables read ZERO rows with no error). Callers authorize first (the controller:
// resource_search_property read/update; the WebDesk handler: the approval already carries the tenant). The
// retry sweep walks companies one tenant at a time, never across tenants in one query.
//
// THE FLAG. SEARCH_INDEXNOW_ENABLED must be exactly "1" (indexnow.ts). It is checked FIRST in every entry
// point, before any DB access, so OFF means no query, no row and no byte on the wire. A manual submit with the
// flag off is a typed 409, not a silent no-op.
//
// IDEMPOTENT PER (property, engine, url, version). Rows are inserted ON CONFLICT DO NOTHING on the UNIQUE
// index and ONLY the rows that were actually inserted are sent by the event path: a redelivered publish event
// (the bus delivers at least once, a webhook may fire twice) inserts nothing and sends nothing. A row that
// failed is not re-sent by a repeat of the event; it is re-sent by the retry sweep, from its own row, with
// backoff. A claim is a lease (next_attempt_at pushed 5 minutes out) taken with FOR UPDATE SKIP LOCKED, so an
// event handler and the sweep never send the same rows twice, and a crashed sender's rows come back by
// themselves.
//
// LIMITS. Batches of INDEXNOW_BATCH_SIZE URLs, sent one at a time. A rolling DAILY_URL_CAP of accepted URLs per
// property and engine: beyond it the rows stay pending and are deferred an hour (never dropped). Manual submit:
// at most MANUAL_MAX_URLS_PER_CALL per call and MANUAL_HOURLY_URL_LIMIT per property per hour (429 beyond).
//
// LOGS carry ids and typed tokens only: never a URL's query, a response body or a key.
import { BadRequestException, HttpException, Logger, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { readAccessToken } from "../../core/integrations.service";
import { isModuleEnabled } from "../registry";
import {
  INDEXNOW_BATCH_SIZE, INDEXNOW_MAX_ATTEMPTS, buildPageUrls, generateIndexNowKey, hashUrl,
  isIndexNowEnabled, keyFileBody, keyFileName, normalizeSubmitUrls, pingIndexNow, siteOriginOf, verifyKeyFile, versionTag,
  type ChangedItem, type FetchImpl, type PageSkipReason, type Resolver,
} from "./indexnow";
import { BING_SUBMIT_BATCH_SIZE, BingError, bingMode, getUrlSubmissionQuota, submitUrlBatch } from "./bing-client";

const logger = new Logger("SearchIndexNow");

export const DAILY_URL_CAP = 5000;
export const MANUAL_MAX_URLS_PER_CALL = 100;
export const MANUAL_HOURLY_URL_LIMIT = 300;
const LEASE_MS = 5 * 60_000;
const DEFER_MS = 60 * 60_000;
const MAX_BATCHES_PER_RUN = 20;
const SWEEP_LOCK_NS = 0x53430005; // 'SC' + 5, beside the pull scheduler's ...03 and the decay job's ...04

export type Engine = "indexnow" | "bing";
type Transition = "publish" | "unpublish" | "manual";

export interface IndexNowDeps {
  fetchImpl?: FetchImpl;
  resolve?: Resolver;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

let testDeps: IndexNowDeps | null = null;
/** Tests only: the HTTP layer reaches these services without a deps argument. */
export function setIndexNowDepsForTests(d: IndexNowDeps | null): void { testDeps = d; }
const depsOf = (d?: IndexNowDeps): Required<Pick<IndexNowDeps, "now" | "env">> & IndexNowDeps => ({
  ...(testDeps ?? {}), ...(d ?? {}), now: d?.now ?? testDeps?.now ?? (() => new Date()), env: d?.env ?? testDeps?.env ?? process.env,
});

const SEARCH = { modules: ["search"] };

// ── the property ─────────────────────────────────────────────────────────────────────────────────

export interface IxProperty {
  id: string; tenantId: string; clientId: string; domain: string; siteUrl: string; status: string;
  verifiedAt: Date | null; indexnowKey: string | null; indexnowKeyVerifiedAt: Date | null; indexnowEnabled: boolean; bingConnectionId: string | null;
}
const PROP_COLS = `id, tenant_id AS "tenantId", client_id AS "clientId", domain, site_url AS "siteUrl", status, verified_at AS "verifiedAt",
  indexnow_key AS "indexnowKey", indexnow_key_verified_at AS "indexnowKeyVerifiedAt", indexnow_enabled AS "indexnowEnabled",
  bing_connection_id AS "bingConnectionId"`;

async function loadProperty(c: PoolClient, id: string, lock = false): Promise<IxProperty | null> {
  const r = await c.query<IxProperty>(`SELECT ${PROP_COLS} FROM search_properties WHERE id = $1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [id]);
  return r.rows[0] ?? null;
}
async function requireProperty(tenantId: string, id: string): Promise<IxProperty> {
  const p = await withTenants([tenantId], (c) => loadProperty(c, id), SEARCH);
  if (!p) throw new NotFoundException("property not found");
  return p;
}

/** A typed refusal. The app's error filter (http-error.filter.ts) forwards only `error`, `reason` and `existing`, so
 *  structured detail travels under `existing` (the filter's channel for "the error carries a usable result"). */
const refusal = (status: number, message: string, reason: string, detail?: Record<string, unknown>): HttpException =>
  new HttpException({ message, reason, ...(detail ? { existing: detail } : {}) }, status);

// ── key ──────────────────────────────────────────────────────────────────────────────────────────

export interface KeyInfo {
  propertyId: string;
  /** The key itself. Public by protocol design; safe to return to anyone who may read the property. */
  key: string;
  fileName: string;
  /** Where the site must serve it, e.g. https://example.com/<key>.txt. null when site_url is not a plain origin. */
  location: string | null;
  /** The exact body of the file. */
  fileBody: string;
  contentType: "text/plain; charset=utf-8";
  enabled: boolean;
  verifiedAt: string | null;
}
function keyInfoOf(p: IxProperty): KeyInfo | null {
  if (!p.indexnowKey) return null;
  const origin = siteOriginOf(p.siteUrl);
  return {
    propertyId: p.id, key: p.indexnowKey, fileName: keyFileName(p.indexnowKey), location: origin ? `${origin}/${keyFileName(p.indexnowKey)}` : null,
    fileBody: keyFileBody(p.indexnowKey), contentType: "text/plain; charset=utf-8", enabled: p.indexnowEnabled,
    verifiedAt: p.indexnowKeyVerifiedAt ? new Date(p.indexnowKeyVerifiedAt).toISOString() : null,
  };
}

/** The key file the site build must serve. 404 when no key was generated yet. */
export async function readKey(tenantId: string, propertyId: string): Promise<KeyInfo> {
  const info = keyInfoOf(await requireProperty(tenantId, propertyId));
  if (!info) throw new NotFoundException({ message: "no IndexNow key has been generated for this property", reason: "indexnow_key_missing" });
  return info;
}

/** Generate the key (idempotent: an existing key is returned unchanged). `rotate` replaces it and switches
 *  IndexNow OFF again (the new key has not been proven on the site). */
export async function generateKey(tenantId: string, propertyId: string, opts: { rotate: boolean }): Promise<{ created: boolean; rotated: boolean; info: KeyInfo }> {
  return withTenants([tenantId], async (c) => {
    const cur = await loadProperty(c, propertyId, true);
    if (!cur) throw new NotFoundException("property not found");
    if (cur.indexnowKey && !opts.rotate) return { created: false, rotated: false, info: keyInfoOf(cur)! };
    const key = generateIndexNowKey();
    await c.query(
      `UPDATE search_properties SET indexnow_key = $2, indexnow_key_verified_at = NULL, indexnow_enabled = false, updated_at = now() WHERE id = $1`,
      [propertyId, key],
    );
    const after = (await loadProperty(c, propertyId))!;
    return { created: !cur.indexnowKey, rotated: !!cur.indexnowKey, info: keyInfoOf(after)! };
  }, SEARCH);
}

// ── switch ───────────────────────────────────────────────────────────────────────────────────────

/** Enable needs: the platform flag, a verified active property, a key, an https site_url, and the key file
 *  FETCHED BACK from the site. Each failure is a typed 409; none of them changes anything. Disable always works. */
export async function setIndexNowEnabled(tenantId: string, propertyId: string, enabled: boolean, depsIn?: IndexNowDeps): Promise<{ enabled: boolean; verifiedAt: string | null }> {
  const deps = depsOf(depsIn);
  const p = await requireProperty(tenantId, propertyId);
  if (!enabled) {
    await withTenants([tenantId], (c) => c.query(`UPDATE search_properties SET indexnow_enabled = false, updated_at = now() WHERE id = $1`, [propertyId]), SEARCH);
    return { enabled: false, verifiedAt: p.indexnowKeyVerifiedAt ? new Date(p.indexnowKeyVerifiedAt).toISOString() : null };
  }
  if (!isIndexNowEnabled(deps.env)) throw refusal(409, "IndexNow is switched off on this server", "indexnow_platform_disabled");
  if (p.status !== "active" || !p.verifiedAt) throw refusal(409, "the property must be active and verified first", "property_not_verified");
  if (!p.indexnowKey) throw refusal(409, "generate the IndexNow key first", "indexnow_key_missing");
  const origin = siteOriginOf(p.siteUrl);
  if (!origin) throw refusal(409, "the property's site_url is not a plain http(s) origin", "site_url_invalid");
  const proof = await verifyKeyFile({ origin, key: p.indexnowKey }, { fetchImpl: deps.fetchImpl, resolve: deps.resolve });
  if (!proof.ok) {
    throw refusal(409, `the key file is not being served by the site yet (${proof.reason}); nothing was enabled`, "indexnow_key_file_unreachable", {
      check: proof.reason, ...(proof.httpStatus ? { httpStatus: proof.httpStatus } : {}), location: `${origin}/${keyFileName(p.indexnowKey)}`,
    });
  }
  const at = deps.now();
  const r = await withTenants([tenantId], (c) =>
    c.query(
      // The key may have been rotated while we were fetching: only flip it for the key we proved.
      `UPDATE search_properties SET indexnow_enabled = true, indexnow_key_verified_at = $3, updated_at = now() WHERE id = $1 AND indexnow_key = $2 AND deleted_at IS NULL`,
      [propertyId, p.indexnowKey, at],
    ), SEARCH);
  if (!r.rowCount) throw refusal(409, "the key changed while it was being verified; try again", "indexnow_key_changed");
  return { enabled: true, verifiedAt: at.toISOString() };
}

// ── status ───────────────────────────────────────────────────────────────────────────────────────

export interface IndexNowStatus {
  propertyId: string;
  platformEnabled: boolean;
  enabled: boolean;
  propertyVerified: boolean;
  hasKey: boolean;
  keyVerifiedAt: string | null;
  keyLocation: string | null;
  bingConnected: boolean;
  last7Days: Record<string, number>;
  recent: Array<{ id: string; engine: Engine; url: string; transition: Transition; status: string; attempts: number; errorCode: string | null; sentAt: string | null; createdAt: string; simulated: boolean }>;
}

export async function getStatus(tenantId: string, propertyId: string, depsIn?: IndexNowDeps): Promise<IndexNowStatus> {
  const deps = depsOf(depsIn);
  return withTenants([tenantId], async (c) => {
    const p = await loadProperty(c, propertyId);
    if (!p) throw new NotFoundException("property not found");
    const counts = await c.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM search_indexnow_submissions WHERE property_id = $1 AND created_at > $2 GROUP BY status`,
      [propertyId, new Date(deps.now().getTime() - 7 * 86400_000)],
    );
    const recent = await c.query(
      `SELECT id, engine, url, transition, status, attempts, error_code AS "errorCode", sent_at AS "sentAt", created_at AS "createdAt", simulated
         FROM search_indexnow_submissions WHERE property_id = $1 ORDER BY created_at DESC, id LIMIT 20`,
      [propertyId],
    );
    const info = keyInfoOf(p);
    return {
      propertyId, platformEnabled: isIndexNowEnabled(deps.env), enabled: p.indexnowEnabled, propertyVerified: !!p.verifiedAt && p.status === "active",
      hasKey: !!p.indexnowKey, keyVerifiedAt: info?.verifiedAt ?? null, keyLocation: info?.location ?? null, bingConnected: !!p.bingConnectionId,
      last7Days: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])),
      recent: recent.rows.map((r) => ({
        ...r, sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null, createdAt: new Date(r.createdAt).toISOString(),
      })),
    };
  }, SEARCH);
}

// ── enqueue + dispatch ───────────────────────────────────────────────────────────────────────────

interface QueuedUrl { url: string; version: string }

async function enqueue(
  c: PoolClient,
  a: { tenantId: string; propertyId: string; engine: Engine; transition: Transition; urls: QueuedUrl[]; now: Date; simulated: boolean; requestedBy: string | null },
): Promise<number> {
  if (a.urls.length === 0) return 0;
  const r = await c.query(
    `INSERT INTO search_indexnow_submissions
       (tenant_id, property_id, engine, url, url_hash, version, transition, status, next_attempt_at, simulated, requested_by, origin_site)
     SELECT $1::uuid, $2::uuid, $3::text, u.url, u.hash, u.version, $4::text, 'pending', $5::timestamptz, $6::boolean, $7::uuid, $8::text
       FROM unnest($9::text[], $10::text[], $11::text[]) AS u(url, hash, version)
     ON CONFLICT (tenant_id, property_id, engine, url_hash, version) DO NOTHING`,
    [
      a.tenantId, a.propertyId, a.engine, a.transition, a.now, a.simulated, a.requestedBy, config.originSite,
      a.urls.map((u) => u.url), a.urls.map((u) => hashUrl(u.url)), a.urls.map((u) => u.version),
    ],
  );
  return r.rowCount ?? 0;
}

export interface DispatchResult { sent: number; retrying: number; rejected: number; gaveUp: number; deferred: number }
const emptyDispatch = (): DispatchResult => ({ sent: 0, retrying: 0, rejected: 0, gaveUp: 0, deferred: 0 });

/** Close one claimed batch. A `failed` row backs off 60s * 2^attempts (capped at 6h) unless the engine said how long
 *  (`retryAfterMs`); the attempt that reaches INDEXNOW_MAX_ATTEMPTS becomes `gave_up`. The backoff is computed in SQL from
 *  the row's OWN attempt count (the right-hand sides of an UPDATE read the old row), so every row of a batch is right. */
async function finishRows(
  tenantId: string, ids: string[], status: "sent" | "failed" | "rejected",
  f: { httpStatus: number | null; errorCode: string | null; now: Date; retryAfterMs?: number | null },
): Promise<{ gaveUp: number }> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ status: string }>(
      `UPDATE search_indexnow_submissions
          SET status = CASE WHEN $2 = 'failed' AND attempts + 1 >= $7 THEN 'gave_up' ELSE $2 END,
              next_attempt_at = CASE WHEN $2 = 'failed'
                                     THEN $5::timestamptz + (LEAST(COALESCE($6::double precision, 60000 * power(2, attempts)), 21600000) * interval '1 millisecond')
                                     ELSE next_attempt_at END,
              attempts = attempts + 1, http_status = $3, error_code = $4,
              sent_at = CASE WHEN $2 = 'sent' THEN $5::timestamptz ELSE sent_at END, updated_at = now()
        WHERE id = ANY($1::uuid[]) RETURNING status`,
      [ids, status, f.httpStatus, f.errorCode, f.now, f.retryAfterMs ?? null, INDEXNOW_MAX_ATTEMPTS],
    ), SEARCH);
  return { gaveUp: r.rows.filter((x) => x.status === "gave_up").length };
}

/** Send every due row of one (property, engine), batch by batch, within the daily cap. Never throws. */
export async function dispatchDue(tenantId: string, propertyId: string, engine: Engine, depsIn?: IndexNowDeps): Promise<DispatchResult> {
  const deps = depsOf(depsIn);
  const out = emptyDispatch();
  if (!isIndexNowEnabled(deps.env)) return out;
  try {
    const now = deps.now();
    const p = await withTenants([tenantId], (c) => loadProperty(c, propertyId), SEARCH);
    if (!p) return out;
    const origin = siteOriginOf(p.siteUrl);
    const live = bingMode(deps.env) === "live";

    const closeAll = async (code: string) => {
      const ids = await withTenants([tenantId], async (c) => (await c.query<{ id: string }>(
        `UPDATE search_indexnow_submissions SET status = 'rejected', error_code = $4, updated_at = now()
          WHERE tenant_id = $1 AND property_id = $2 AND engine = $3 AND status IN ('pending','failed') RETURNING id`, [tenantId, propertyId, engine, code])).rows, SEARCH);
      out.rejected += ids.length;
    };
    if (!origin) { await closeAll("site_url_invalid"); return out; }
    if (engine === "indexnow" && (!p.indexnowEnabled || !p.indexnowKey || !p.indexnowKeyVerifiedAt)) { await closeAll("not_enabled"); return out; }
    if (engine === "bing" && !p.bingConnectionId) { await closeAll("not_connected"); return out; }

    const sent24 = await withTenants([tenantId], async (c) => Number((await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM search_indexnow_submissions WHERE property_id = $1 AND engine = $2 AND status = 'sent' AND sent_at > $3`,
      [propertyId, engine, new Date(now.getTime() - 86400_000)])).rows[0].n), SEARCH);
    let budget = Math.max(0, DAILY_URL_CAP - sent24);
    const batchSize = engine === "bing" ? BING_SUBMIT_BATCH_SIZE : INDEXNOW_BATCH_SIZE;

    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      if (budget <= 0) {
        const n = await withTenants([tenantId], async (c) => (await c.query(
          `UPDATE search_indexnow_submissions SET next_attempt_at = $4, updated_at = now()
            WHERE tenant_id = $1 AND property_id = $2 AND engine = $3 AND status IN ('pending','failed') AND next_attempt_at <= $5`,
          [tenantId, propertyId, engine, new Date(now.getTime() + DEFER_MS), now])).rowCount ?? 0, SEARCH);
        out.deferred += n;
        break;
      }
      const claimed = await withTenants([tenantId], async (c) => (await c.query<{ id: string; url: string }>(
        `UPDATE search_indexnow_submissions SET next_attempt_at = $5, updated_at = now()
          WHERE id IN (SELECT id FROM search_indexnow_submissions
                        WHERE tenant_id = $1 AND property_id = $2 AND engine = $3 AND status IN ('pending','failed') AND next_attempt_at <= $6
                        ORDER BY created_at, url, id LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING id, url`,
        [tenantId, propertyId, engine, Math.min(batchSize, budget), new Date(now.getTime() + LEASE_MS), now])).rows, SEARCH);
      if (claimed.length === 0) break;
      // UPDATE .. RETURNING does not keep the subquery's ORDER BY (it returns rows in physical order), so sort here: the batch
      // MEMBERS are chosen by the ORDER BY + LIMIT above, and the request lists them in a stable (URL) order.
      claimed.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
      const ids = claimed.map((r) => r.id);
      const urls = claimed.map((r) => r.url);
      budget -= claimed.length;

      if (engine === "indexnow") {
        const o = await pingIndexNow({ origin, key: p.indexnowKey!, urls }, { fetchImpl: deps.fetchImpl });
        if (o.outcome === "sent") { await finishRows(tenantId, ids, "sent", { httpStatus: o.httpStatus, errorCode: null, now }); out.sent += ids.length; }
        else if (o.outcome === "rejected") { await finishRows(tenantId, ids, "rejected", { httpStatus: o.httpStatus, errorCode: o.errorCode, now }); out.rejected += ids.length; }
        else {
          const f = await finishRows(tenantId, ids, "failed", { httpStatus: o.httpStatus, errorCode: o.errorCode, now, retryAfterMs: o.retryAfterMs });
          out.gaveUp += f.gaveUp; out.retrying += ids.length - f.gaveUp;
          logger.warn(`indexnow property ${propertyId}: ${ids.length} url(s) will retry (${o.errorCode})`);
          break; // the engine is unhappy: stop this run, the sweep comes back after the backoff
        }
        continue;
      }

      // engine = bing: SIMULATE never calls out; LIVE submits through the URL Submission API within its quota.
      if (!live) { await finishRows(tenantId, ids, "sent", { httpStatus: null, errorCode: null, now }); out.sent += ids.length; continue; }
      try {
        const key = await withTenants([tenantId], (c) => readAccessToken(c, p.bingConnectionId!), SEARCH);
        if (!key) { await finishRows(tenantId, ids, "rejected", { httpStatus: null, errorCode: "no_key", now }); out.rejected += ids.length; continue; }
        const bingSite = `${origin}/`;
        const quota = await getUrlSubmissionQuota(key, bingSite, { fetchImpl: deps.fetchImpl });
        if (quota !== null && quota.daily < ids.length) {
          await withTenants([tenantId], (c) => c.query(`UPDATE search_indexnow_submissions SET next_attempt_at = $2, error_code = 'quota', updated_at = now() WHERE id = ANY($1::uuid[])`, [ids, new Date(now.getTime() + DEFER_MS)]), SEARCH);
          out.deferred += ids.length;
          break;
        }
        await submitUrlBatch(key, bingSite, urls, { fetchImpl: deps.fetchImpl });
        await finishRows(tenantId, ids, "sent", { httpStatus: 200, errorCode: null, now }); out.sent += ids.length;
      } catch (e) {
        if (e instanceof BingError && e.kind === "rejected") { await finishRows(tenantId, ids, "rejected", { httpStatus: e.httpStatus, errorCode: e.httpStatus ? `http_${e.httpStatus}` : "rejected", now }); out.rejected += ids.length; continue; }
        const f = await finishRows(tenantId, ids, "failed", { httpStatus: e instanceof BingError ? e.httpStatus : null, errorCode: e instanceof BingError ? e.kind : "error", now });
        out.gaveUp += f.gaveUp; out.retrying += ids.length - f.gaveUp;
        break;
      }
    }
  } catch (err) {
    // Fail-soft by design: a ledger or network surprise must never turn a publish into an error. The rows
    // keep their lease and come back through the sweep.
    logger.warn(`dispatch for property ${propertyId} failed (${(err as Error)?.name ?? "error"})`);
  }
  return out;
}

// ── the publish -> ping flow ─────────────────────────────────────────────────────────────────────

export interface ContentChange {
  /** Name the property directly, or let `domains` find it (the site's environment domains, production first). */
  propertyId?: string;
  domains?: readonly string[];
  transition: "publish" | "unpublish";
  /** A stable name for the event (approval id, Zone B event id): part of the idempotency key. */
  ref?: string | null;
  items: ChangedItem[];
}

export type NotifyStatus = "disabled" | "no_property" | "property_not_verified" | "not_enabled" | "nothing_to_send" | "queued";
export interface NotifyResult {
  status: NotifyStatus;
  propertyId?: string;
  engine?: Engine;
  /** Page URLs this change maps to. */
  urls: number;
  skipped: Array<{ itemIndex: number; reason: PageSkipReason }>;
  /** Rows already in the ledger for this event (a redelivery): not sent again. */
  duplicates: number;
  dispatch?: DispatchResult;
}

const normDomain = (d: string): string => d.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

export async function notifyContentChange(tenantId: string, change: ContentChange, depsIn?: IndexNowDeps): Promise<NotifyResult> {
  const deps = depsOf(depsIn);
  const base: NotifyResult = { status: "disabled", urls: 0, skipped: [], duplicates: 0 };
  if (!isIndexNowEnabled(deps.env)) return base;

  const wanted = new Set((change.domains ?? []).map(normDomain).filter(Boolean));
  const prop = await withTenants([tenantId], async (c) => {
    if (change.propertyId) return loadProperty(c, change.propertyId);
    if (wanted.size === 0) return null;
    const r = await c.query<IxProperty>(`SELECT ${PROP_COLS} FROM search_properties WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active' ORDER BY created_at, id`, [tenantId]);
    const hits = r.rows.filter((x) => wanted.has(normDomain(x.domain)));
    return hits.find((x) => x.verifiedAt) ?? hits[0] ?? null;
  }, SEARCH);
  if (!prop) return { ...base, status: "no_property" };
  const out: NotifyResult = { ...base, propertyId: prop.id };
  if (prop.status !== "active" || !prop.verifiedAt) return { ...out, status: "property_not_verified" };

  const origin = siteOriginOf(prop.siteUrl);
  // IndexNow when it is proven for this site; otherwise Bing's own submission API when a Bing key is linked.
  const engine: Engine | null = prop.indexnowEnabled && prop.indexnowKey && prop.indexnowKeyVerifiedAt ? "indexnow" : prop.bingConnectionId ? "bing" : null;
  if (!origin || !engine) return { ...out, status: "not_enabled" };

  const built = buildPageUrls(origin, change.items);
  out.urls = built.urls.length;
  out.skipped = built.skipped;
  if (built.urls.length === 0) return { ...out, status: "nothing_to_send", engine };

  const now = deps.now();
  const queued: QueuedUrl[] = built.urls.map((u) => ({ url: u.url, version: versionTag(change.transition, u.version, change.ref) }));
  const inserted = await withTenants([tenantId], (c) => enqueue(c, {
    tenantId, propertyId: prop.id, engine, transition: change.transition, urls: queued, now,
    simulated: engine === "bing" && bingMode(deps.env) !== "live", requestedBy: null,
  }), SEARCH);
  out.engine = engine;
  out.duplicates = built.urls.length - inserted;
  out.status = "queued";
  // Only the event's own FIRST delivery sends; a redelivery finds nothing new and leaves failures to the sweep.
  if (inserted > 0) out.dispatch = await dispatchDue(tenantId, prop.id, engine, deps);
  logger.log(`property ${prop.id}: ${change.transition} -> ${engine}, ${inserted} new url(s), ${out.duplicates} duplicate(s), ${built.skipped.length} skipped`);
  return out;
}

// ── manual submit ────────────────────────────────────────────────────────────────────────────────

export interface ManualSubmitResult {
  propertyId: string;
  engine: Engine;
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; reason: string }>;
  dispatch: DispatchResult;
}

/** "Submit these URLs now": paths or absolute URLs ON THIS PROPERTY'S HOST. Low impact, rate limited. */
export async function submitUrlsManually(tenantId: string, propertyId: string, inputs: unknown, userId: string | null, depsIn?: IndexNowDeps): Promise<ManualSubmitResult> {
  const deps = depsOf(depsIn);
  if (!Array.isArray(inputs) || inputs.length < 1) throw new BadRequestException("urls must be a non-empty array");
  if (inputs.length > MANUAL_MAX_URLS_PER_CALL) throw new BadRequestException(`urls may hold at most ${MANUAL_MAX_URLS_PER_CALL} entries per call`);
  const p = await requireProperty(tenantId, propertyId);
  if (!isIndexNowEnabled(deps.env)) throw refusal(409, "IndexNow is switched off on this server", "indexnow_platform_disabled");
  const origin = siteOriginOf(p.siteUrl);
  if (!origin) throw refusal(409, "the property's site_url is not a plain http(s) origin", "site_url_invalid");
  const engine: Engine | null = p.indexnowEnabled && p.indexnowKey && p.indexnowKeyVerifiedAt ? "indexnow" : p.bingConnectionId ? "bing" : null;
  if (!engine) throw refusal(409, "enable IndexNow (or connect Bing) for this property first", "no_submission_channel");

  const { urls, rejected } = normalizeSubmitUrls(origin, inputs);
  if (urls.length === 0) throw refusal(400, "none of the urls belong to this property's site", "url_not_on_property", { rejected });

  const now = deps.now();
  const recent = await withTenants([tenantId], async (c) => Number((await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM search_indexnow_submissions WHERE property_id = $1 AND transition = 'manual' AND created_at > $2`,
    [propertyId, new Date(now.getTime() - 3600_000)])).rows[0].n), SEARCH);
  if (recent + urls.length > MANUAL_HOURLY_URL_LIMIT) {
    throw refusal(429, `manual submissions are limited to ${MANUAL_HOURLY_URL_LIMIT} URLs per property per hour; try again within the hour`, "rate_limited", { retryAfterSeconds: 3600 });
  }

  const version = `manual:${now.toISOString().slice(0, 13)}`;
  const inserted = await withTenants([tenantId], (c) => enqueue(c, {
    tenantId, propertyId, engine, transition: "manual", urls: urls.map((url) => ({ url, version })), now,
    simulated: engine === "bing" && bingMode(deps.env) !== "live", requestedBy: userId,
  }), SEARCH);
  const dispatch = inserted > 0 ? await dispatchDue(tenantId, propertyId, engine, deps) : emptyDispatch();
  return { propertyId, engine, accepted: urls.length, duplicates: urls.length - inserted, rejected, dispatch };
}

// ── the retry sweep ──────────────────────────────────────────────────────────────────────────────

export interface SweepResult { skippedLocked: boolean; tenants: number; groups: number; sent: number; retrying: number; errors: number }

/** Re-send what is due (failed with an expired backoff, a lapsed lease, or deferred by the cap). Off unless the flag is "1". */
export async function runIndexNowSweep(depsIn?: IndexNowDeps): Promise<SweepResult> {
  const deps = depsOf(depsIn);
  const res: SweepResult = { skippedLocked: false, tenants: 0, groups: 0, sent: 0, retrying: 0, errors: 0 };
  if (!isIndexNowEnabled(deps.env)) return res;
  return withGlobal(async (c) => {
    const lock = await c.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [SWEEP_LOCK_NS, 0]);
    if (!lock.rows[0]?.locked) { res.skippedLocked = true; return res; }
    try {
      const { rows: companies } = await c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC`);
      for (const { id: tenantId } of companies) {
        try {
          if (!(await isModuleEnabled(tenantId, "search"))) continue;
          const groups = await withTenants([tenantId], async (t) => (await t.query<{ property_id: string; engine: Engine }>(
            `SELECT DISTINCT property_id, engine FROM search_indexnow_submissions WHERE status IN ('pending','failed') AND next_attempt_at <= $1`,
            [deps.now()])).rows, SEARCH);
          if (groups.length === 0) continue;
          res.tenants += 1;
          for (const g of groups) {
            res.groups += 1;
            const d = await dispatchDue(tenantId, g.property_id, g.engine, deps);
            res.sent += d.sent;
            res.retrying += d.retrying;
          }
        } catch (err) {
          res.errors += 1;
          logger.warn(`sweep for tenant ${tenantId} failed (${(err as Error)?.name ?? "error"})`);
        }
      }
      return res;
    } finally {
      await c.query("SELECT pg_advisory_unlock($1, $2)", [SWEEP_LOCK_NS, 0]);
    }
  });
}

/** The loop. Returns null (no timer, no DB, no network) unless SEARCH_INDEXNOW_ENABLED is exactly "1". */
export function startIndexNowRetryLoop(
  env: NodeJS.ProcessEnv = process.env,
  opts: { intervalMs?: number; initialDelayMs?: number; sweep?: () => Promise<SweepResult> } = {},
): { stop: () => void } | null {
  if (!isIndexNowEnabled(env)) return null;
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const sweep = opts.sweep ?? (() => runIndexNowSweep());
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await sweep();
      if (r.sent > 0 || r.retrying > 0 || r.errors > 0) console.log("[SEARCH-INDEXNOW] sweep:", { groups: r.groups, sent: r.sent, retrying: r.retrying, errors: r.errors });
    } catch (err) {
      console.error("[SEARCH-INDEXNOW] sweep failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, opts.initialDelayMs ?? 2 * 60_000);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

