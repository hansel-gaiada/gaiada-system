// SMM-10 — `smm-post-status-sync`: the reconcile half of the publish gate. A dispatched variant's
// `status` (`queued`/`publishing`) is our OWN queue's belief; this file is what makes it converge on
// the network's authoritative answer, because — per addendum §A4e/§A4f/§A4l — several networks have
// NO server-side scheduling at all, which makes "our queue is watching" a correctness property, not
// an optimization.
//
// SHAPE: mirrors `inbox-retention-job.ts` (SMM-36) deliberately — a per-tenant sweep, its own module
// scope declaration, per-tenant failures logged and swallowed. Two entry points share one
// idempotent apply function:
//   1. THE SAFETY POLL (`runPostStatusSync`, `startPostStatusSyncLoop`) — every `SOCIAL_RECONCILE_
//      INTERVAL_MS` (default 15 minutes; addendum §A4 already reasoned publish LATENCY is not where
//      this programme's cost lives), a batched `getPostStatus` sweep over every in-flight variant.
//   2. THE WEBHOOK INTAKE (`reconcileOneProviderPost`, wired in `social.controller.ts`) — ids only,
//      NEVER trusted content. A caller may name a `providerPostId`; nothing else it sends is ever
//      read, let alone written. This function re-fetches the authoritative state itself
//      (`SocialPublisher.getPostStatus`) rather than trusting anything the caller claims about it —
//      the same "never trust webhook content" discipline `d14-09-redelivery-storm.test.ts`'s own
//      family of tests apply to automation_approval redelivery, here applied to a second untrusted
//      transport.
//
// ── THE DOUBLE-POST PATH IS TESTED, NOT A COMMENT ────────────────────────────────────────────────────
// "Assume every webhook/event fires twice" (this seat's own standing brief). `applyPostStatuses`'
// UPDATE is guarded by `WHERE status IN ('queued','publishing')`: a second delivery for an already-
// terminal row (`published`/`failed`/`cancelled`) touches zero rows and emits nothing a second time.
// `post-status-sync-job.test.ts` drives this twice, asserting exactly one `social.post.failed` event.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { declareSocialModuleScope } from "./publish-precondition";
import { openOrg, type PublisherOrgRow } from "./publisher/provisioning";
import type { PostStatus } from "./publisher/types";
import { invokePublisher } from "./publisher/registry";
import { emitEvent } from "../../events/outbox.service";

/** One tenant's worth of in-flight rows, grouped by their publisher org so `getPostStatus` can be
 *  called ONCE per (org, window) rather than once per variant (addendum §A4l §4 — the batched-read
 *  design decision `types.ts`'s port header already made; this job is its only caller today). */
interface InFlightRow {
  variant_id: string;
  provider_post_id: string;
  org_id: string;
  network: string;
}

async function loadInFlight(c: PoolClient, providerPostIds?: string[]): Promise<InFlightRow[]> {
  const params: unknown[] = [];
  let filter = "";
  if (providerPostIds && providerPostIds.length > 0) {
    params.push(providerPostIds);
    filter = "AND v.provider_post_id = ANY($1::text[])";
  }
  const { rows } = await c.query<InFlightRow>(
    `SELECT v.id AS variant_id, v.provider_post_id, a.publisher_org_id AS org_id, a.network
       FROM social_post_variants v
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE v.status IN ('queued', 'publishing')
        AND v.provider_post_id IS NOT NULL
        AND v.deleted_at IS NULL
        ${filter}`,
    params,
  );
  return rows;
}

async function loadOrg(c: PoolClient, orgId: string): Promise<PublisherOrgRow | null> {
  const { rows } = await c.query<PublisherOrgRow>(
    `SELECT id, client_id AS "clientId", driver, postiz_org_id AS "postizOrgId",
            api_key_ref AS "apiKeyRef", status
       FROM social_publisher_orgs WHERE id = $1 AND deleted_at IS NULL`,
    [orgId],
  );
  return rows[0] ?? null;
}

/** Postgres `state` -> the CHECK-constrained `social_post_variants.status` vocabulary. `unknown`
 *  intentionally maps to nothing (the row is left exactly where it is — "the engine couldn't tell us"
 *  is not a fact about our own queue, and must never overwrite one). */
const APPLY_STATUS: Partial<Record<PostStatus["state"], "published" | "failed" | "cancelled" | "publishing">> = {
  published: "published",
  failed: "failed",
  cancelled: "cancelled",
  publishing: "publishing",
};

/**
 * Apply a batch of AUTHORITATIVE statuses for ONE tenant. Idempotent by construction (see the file
 * header): the UPDATE only ever touches a row still `queued`/`publishing`, so a repeat delivery of
 * the same status is a silent no-op, never a second failure event for an already-`failed` row.
 * Declares its own module scope — same trap, same fix, as every other social write path.
 */
export async function applyPostStatuses(tenantId: string, statuses: PostStatus[]): Promise<{ applied: number }> {
  if (statuses.length === 0) return { applied: 0 };
  let applied = 0;
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    for (const s of statuses) {
      const nextStatus = APPLY_STATUS[s.state];
      if (!nextStatus) continue; // 'unknown' (or a state we don't map) — leave the row alone
      // `provider_post_id` is unique among non-null values (0105's `ux_social_post_variants_provider`
      // partial index), so this WHERE identifies at most one row without needing tenant_id in the
      // predicate — the surrounding `withTenants` connection already scopes every table this query
      // touches via RLS.
      const upd = await c.query<{ id: string; engagement_id: string; network: string }>(
        `UPDATE social_post_variants v
            SET status = $2, published_url = COALESCE($3, v.published_url),
                published_at = CASE WHEN $2 = 'published' THEN COALESCE($4::timestamptz, now()) ELSE v.published_at END,
                last_error = CASE WHEN $2 = 'failed' THEN COALESCE($5, v.last_error) ELSE v.last_error END,
                updated_at = now()
          FROM social_posts p, social_accounts a
          WHERE v.provider_post_id = $1 AND v.status IN ('queued', 'publishing')
            AND p.id = v.post_id AND p.tenant_id = v.tenant_id
            AND a.id = v.account_id AND a.tenant_id = v.tenant_id
          RETURNING v.id, p.engagement_id, a.network`,
        [s.providerPostId, nextStatus, s.publishedUrl ?? null, s.publishedAt ?? null, s.error ?? null],
      );
      const row = upd.rows[0];
      if (!row) continue; // already terminal (a repeat delivery), or no such provider id in this tenant
      applied += 1;
      if (nextStatus === "failed") {
        await emitEvent(c, tenantId, "social_post_variant", row.id, "social.post.failed", {
          reason: "network_reported_failed", network: row.network, engagementId: row.engagement_id,
          providerPostId: s.providerPostId, detail: s.error ?? null,
        });
      } else if (nextStatus === "published") {
        await emitEvent(c, tenantId, "social_post_variant", row.id, "social.post.published", {
          network: row.network, engagementId: row.engagement_id, providerPostId: s.providerPostId,
        });
      }
    }
  });
  return { applied };
}

/** One tenant's sweep: group its in-flight rows by publisher org, one `getPostStatus` call per org
 *  (never per variant), then apply. A single org's driver failure (unreachable publisher) is
 *  swallowed and logged — the SAME per-tenant/per-org isolation `inbox-retention-job.ts` already
 *  established, so one client's outage never blocks reconciling every other client's posts. */
export async function reconcileTenantPostStatus(tenantId: string, now: Date = new Date()): Promise<{ orgs: number; applied: number; errors: number }> {
  const rows = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadInFlight(c);
  });
  const byOrg = new Map<string, InFlightRow[]>();
  for (const r of rows) {
    const list = byOrg.get(r.org_id) ?? [];
    list.push(r);
    byOrg.set(r.org_id, list);
  }

  let applied = 0;
  let errors = 0;
  const from = new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10); // 60d back — comfortably covers any realistic in-flight window
  const to = now.toISOString().slice(0, 10);

  for (const [orgId, orgRows] of byOrg) {
    try {
      // ⚠ `social_publisher_orgs` carries 0105's third wall too — this transaction is otherwise
      // module-less (matching the executor's own shape elsewhere in this module), so the scope must
      // be declared explicitly or this read comes back empty, silently, and every org is skipped as
      // if unprovisioned. Caught by this file's own test (post-status-sync-job.test.ts (T4)) the
      // first time this function was exercised end to end rather than only unit-tested in isolation.
      const org = await withTenants([tenantId], async (c) => {
        await declareSocialModuleScope(c);
        return loadOrg(c, orgId);
      });
      if (!org) continue;
      const { driver, handle } = openOrg(org);
      if (!driver.capabilities.has("post_status")) continue;
      const ids = orgRows.map((r) => r.provider_post_id);
      const statuses = await invokePublisher(
        { op: "getPostStatus", org: handle },
        () => driver.getPostStatus(handle, ids, { from, to }),
      );
      const result = await applyPostStatuses(tenantId, statuses);
      applied += result.applied;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-POST-STATUS-SYNC] org ${orgId} (tenant ${tenantId}) failed:`, (err as Error).message);
    }
  }
  return { orgs: byOrg.size, applied, errors };
}

/** Sweep every tenant. Mirrors `runInboxRetentionPurge`'s shape verbatim: `withGlobal` for the
 *  company list, per-tenant failures logged and swallowed. */
export async function runPostStatusSync(now: Date = new Date()): Promise<{ tenants: number; applied: number; errors: number }> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let applied = 0;
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const r = await reconcileTenantPostStatus(tenantId, now);
      applied += r.applied;
      errors += r.errors;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-POST-STATUS-SYNC] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, applied, errors };
}

/** THE WEBHOOK INTAKE. `providerPostId` is the ONLY input this function trusts — it re-fetches the
 *  authoritative state itself rather than believing anything else a caller might have sent. Returns
 *  `false` when the id resolves to no in-flight row in this tenant (already terminal, or unknown) —
 *  a caller cannot use this to probe for the existence of another tenant's post: the lookup is
 *  `withTenants`-scoped, so a foreign id and an unknown id are the same "not found" answer. */
export async function reconcileOneProviderPost(tenantId: string, providerPostId: string): Promise<boolean> {
  const row = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const found = await loadInFlight(c, [providerPostId]);
    return found[0] ?? null;
  });
  if (!row) return false;
  const org = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadOrg(c, row.org_id);
  });
  if (!org) return false;
  const { driver, handle } = openOrg(org);
  if (!driver.capabilities.has("post_status")) return false;
  const statuses = await invokePublisher(
    { op: "getPostStatus", org: handle },
    () => driver.getPostStatus(handle, [providerPostId]),
  );
  await applyPostStatuses(tenantId, statuses);
  return true;
}

/** The safety-poll loop. Only started by main.ts when `config.social.reconcileEnabled` is set —
 *  mirrors `startInboxRetentionPurgeLoop`'s shape exactly. */
export function startPostStatusSyncLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runPostStatusSync();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-POST-STATUS-SYNC] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-POST-STATUS-SYNC] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
