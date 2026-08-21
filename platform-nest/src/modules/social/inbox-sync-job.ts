// SMM-15 — `pullInbox`: idempotent per-post comment sync into `social_inbox_threads` /
// `social_inbox_messages`, and the `smm-inbox-pull` scheduled flow. Unblocked by SMM-38c putting
// LinkedIn's `pullComments` on the `direct` driver (design addendum §PD) — this is the first P2
// inbox ticket to actually land.
//
// ── THE CONSTRAINT THAT SHAPES THIS WHOLE FILE: PER-POST, NEVER PER-ACCOUNT ───────────────────────
// `SocialPublisher.listComments(org, integrationId, since)` was widened by 38c so that for `direct`,
// `integrationId` names a POST's `providerPostId` (a LinkedIn share URN or a YouTube video id), NOT
// a connected account's integration id — neither network's API has an "every comment across my whole
// account" endpoint (`direct.ts`'s own header). So this sync walks `social_post_variants` rows that
// actually carry a `provider_post_id` and calls `listComments` ONCE PER POST, never once per
// account. `direct.ts`'s own comment on `listComments` says this in as many words: "SMM-15, whenever
// it is built, must call this once per published post it wants freshly pulled, not once per
// connected account." This file is that caller.
//
// ── THE CURSOR: PER (account, post), NOT A GLOBAL WATERMARK ───────────────────────────────────────
// Each post's own `since` is the existing thread's `last_message_at` (0105's own idempotency key,
// `UNIQUE(account_id, external_thread_id)`, where `external_thread_id` is the post's
// `providerPostId` — every comment on one post lands in the SAME thread row, exactly how
// `linkedin-client.ts#normalizeComments`/`youtube-client.ts#normalizeCommentThreads` both set
// `externalThreadId` to the post id for every item they return) when a thread already exists, or the
// variant's own `published_at` when it does not — no comment can exist before its post was
// published, so that is a correct, tight lower bound for a first pull, and it needs no new column.
//
// ── QUOTA-AWARE FROM THE START, NEVER AN INVENTED NUMBER ──────────────────────────────────────────
// Neither LinkedIn's nor YouTube's Standard-tier rate limit is published anywhere reachable without
// a live Developer Portal session (D-23) — `types.ts`'s own "a driver must never synthesize a cap"
// rule for `getQuota` is honoured here in the same spirit: this file invents NOTHING about what
// LinkedIn/YouTube will tolerate. What it DOES bound is its OWN call volume: eligible posts are
// capped to `config.social.inboxPull.maxPostsPerAccountPerRun` per account per sweep (newest first),
// a SELF-IMPOSED safety valve, not a claimed vendor limit — see config.ts's own comment on that key.
//
// ── UNSUPPORTED vs EMPTY — THE TICKET'S OWN NAMED DISTINCTION ─────────────────────────────────────
// `listComments` is OPTIONAL on the port (`types.ts` header item (a)): a driver that cannot read an
// inbox simply does not implement it, and callers must check `capabilities` and refuse honestly
// rather than call a phantom default. `resolvePublisherForCapability` does NOT itself check whether
// the resolved driver actually advertises `inbox_read` when no config override names a different
// driver (it only refuses eagerly when an override names a driver that `coversNetworkCapability`
// says does not cover it) — so THIS file is the one that checks `driver.capabilities.has("inbox_read")
// && typeof driver.listComments === "function"` before ever calling it. A network/account combo that
// fails that check is counted as `unsupported` (Postiz, every network, by default — spike §8b: ZERO
// inbound surface) and is never conflated with a post that WAS asked and genuinely has nothing new —
// that second case is counted as `posts` (examined) with zero new rows, a real, distinct fact.
//
// ── RETENTION: ROWS LAND WHERE THE EXISTING PURGE CAN ALREADY REACH THEM — NO PURGE CHANGE ────────
// `retention-policy.ts`/`inbox-retention-job.ts` (SMM-36) already purge `social_inbox_threads`/
// `social_inbox_messages` generically for any network whose policy is `evidence: 'documented'`
// (LinkedIn's 24h/48h today). This file writes the SAME two tables, the SAME columns those purgers
// scrub, and it is careful about ONE interaction 0113's own state-law CHECKs enforce: a thread whose
// `activity_content_purged_at`/`profile_data_purged_at` marker is already SET must never be given a
// fresh `excerpt`/`author_handle` (the CHECK requires the purged column stay NULL) — see
// `upsertInboxItems`'s own comment. Individual MESSAGE rows need no such guard: each comment is a
// FRESH row with its own `created_at`, so a brand-new message inserted today starts its OWN 48h/24h
// clock, exactly like every other row that table has ever held. No migration, no purge-side change.
//
// ── SHAPE mirrors `metrics-job.ts`/`post-status-sync-job.ts`/`inbox-retention-job.ts` deliberately:
// read (own transaction, own declared module scope) → call the driver (NO transaction — the same
// discipline `CreatorInfoVerifier`/every `RetentionPurger` holds, since a slow/failing outbound call
// held inside a transaction would turn one tenant's pull into a stalled connection for every other
// query on it) → write (own transaction, own declared module scope). Per-tenant, per-post failures
// are caught and logged so one client's outage or one bad post never aborts the whole sweep.
//
// ── ⚠ THE MODULE GUC (recurring defect class #1 — restated here, as every social job in this module
// independently gets bitten by it) ─────────────────────────────────────────────────────────────────
// Every `social_*` table carries 0105's THIRD RLS wall: `app_module_allowed('social')`, which
// `withTenants([tenantId])` alone does NOT satisfy. `upsertInboxItems` below declares its OWN module
// scope via `declareSocialModuleScope` before touching a row — delete that call and the INSERT reads
// as "0 rows written", silently, through the same RLS wall, forever. `inbox-sync-job.test.ts`'s own
// module-GUC regression test proves this by calling `upsertInboxItems` on a transaction the TEST
// itself opened with NO `{modules:['social']}` option and asserting a real row exists afterward.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { declareSocialModuleScope } from "./publish-precondition";
import { resolveDispatchOrgHandle } from "./publisher/provisioning";
import { invokePublisher } from "./publisher/registry";
import { SocialPublisherError, type InboxItem } from "./publisher/types";
import type { Network } from "./media-rules";

// ── reads (own transaction, own declared scope, no network I/O) ───────────────────────────────────

interface EligiblePostRow {
  variantId: string;
  accountId: string;
  network: Network;
  providerPostId: string;
  publishedAt: string;
  orgId: string;
  orgClientId: string;
  orgDriver: string;
  orgPostizOrgId: string;
  orgApiKeyRef: string;
  orgStatus: string;
}

/** Every published variant that (a) has a `provider_post_id` (never `native_import`'s NULL — there
 *  is nothing to ask the network about for a post we never dispatched) and (b) sits on a currently
 *  connected account, within the lookback window. Ordered newest-first so the per-account cap below
 *  keeps the freshest content, not an arbitrary slice. */
async function loadEligiblePosts(c: PoolClient, lookbackDays: number): Promise<EligiblePostRow[]> {
  const { rows } = await c.query<EligiblePostRow>(
    `SELECT v.id AS "variantId", v.account_id AS "accountId", a.network AS "network",
            v.provider_post_id AS "providerPostId", v.published_at AS "publishedAt",
            o.id AS "orgId", o.client_id AS "orgClientId", o.driver AS "orgDriver",
            o.postiz_org_id AS "orgPostizOrgId", o.api_key_ref AS "orgApiKeyRef", o.status AS "orgStatus"
       FROM social_post_variants v
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
       JOIN social_publisher_orgs o ON o.id = a.publisher_org_id AND o.tenant_id = v.tenant_id
      WHERE v.status = 'published' AND v.provider_post_id IS NOT NULL AND v.deleted_at IS NULL
        AND a.status = 'connected' AND a.deleted_at IS NULL
        AND v.published_at IS NOT NULL
        AND v.published_at >= now() - make_interval(days => $1::int)
      ORDER BY v.published_at DESC`,
    [lookbackDays],
  );
  return rows;
}

/** The self-imposed safety valve (config.ts's own comment) — never a claimed vendor rate limit.
 *  `posts` is already ordered newest-first, so slicing to the first N per account keeps the freshest
 *  content and defers the rest to the next sweep. */
function capPerAccount(posts: EligiblePostRow[], maxPerAccount: number): EligiblePostRow[] {
  const seen = new Map<string, number>();
  const capped: EligiblePostRow[] = [];
  for (const p of posts) {
    const n = seen.get(p.accountId) ?? 0;
    if (n >= maxPerAccount) continue;
    seen.set(p.accountId, n + 1);
    capped.push(p);
  }
  return capped;
}

interface ThreadCursorRow {
  accountId: string;
  externalThreadId: string;
  lastMessageAt: string | null;
}

/** The per-(account, post) cursor: the existing thread's `last_message_at`, or absent when no
 *  thread has ever been created for that post yet (the caller falls back to the post's own
 *  `published_at` in that case — see the file header). */
async function loadThreadCursors(
  c: PoolClient, posts: EligiblePostRow[],
): Promise<Map<string, Date>> {
  const cursors = new Map<string, Date>();
  if (posts.length === 0) return cursors;
  const accountIds = posts.map((p) => p.accountId);
  const postIds = posts.map((p) => p.providerPostId);
  const { rows } = await c.query<ThreadCursorRow>(
    `SELECT account_id AS "accountId", external_thread_id AS "externalThreadId",
            last_message_at AS "lastMessageAt"
       FROM social_inbox_threads
      WHERE deleted_at IS NULL
        AND (account_id, external_thread_id) IN (
          SELECT * FROM unnest($1::uuid[], $2::text[])
        )`,
    [accountIds, postIds],
  );
  for (const r of rows) {
    if (r.lastMessageAt) cursors.set(`${r.accountId}:${r.externalThreadId}`, new Date(r.lastMessageAt));
  }
  return cursors;
}

// ── the idempotent write (own transaction, own declared scope — see the header's ⚠) ───────────────

export interface InboxUpsertResult {
  threadsWritten: number;
  messagesWritten: number;
}

/** Upsert one post's freshly-pulled comments. Idempotent on BOTH of 0105's own unique keys:
 *  `UNIQUE(account_id, external_thread_id)` for the thread (re-running never creates a second
 *  thread for the same post) and the partial `UNIQUE(thread_id, external_id)` for each message
 *  (re-running never duplicates an already-seen comment — `ON CONFLICT ... DO NOTHING`, since an
 *  already-synced comment's own content cannot retroactively change through this same read-only
 *  surface). Declares its OWN module scope — see the file header's ⚠. Returns `{0,0}` on an empty
 *  batch without opening a transaction at all, so a post with nothing new costs nothing to write. */
export async function upsertInboxItems(
  tenantId: string,
  args: { accountId: string; network: string; providerPostId: string; postVariantId: string; items: InboxItem[] },
): Promise<InboxUpsertResult> {
  const { accountId, network, providerPostId, postVariantId, items } = args;
  if (items.length === 0) return { threadsWritten: 0, messagesWritten: 0 };

  // The latest item BY postedAt across this batch. Safe to treat as the overall latest: the caller's
  // own cursor (`since`) already excludes anything the driver itself filtered as older than the
  // thread's existing `last_message_at` (both `normalizeComments`/`normalizeCommentThreads` apply
  // `since` client-side before returning), so nothing older than the thread's current watermark is
  // ever in `items` to begin with.
  let latest = items[0];
  for (const item of items) {
    if (item.postedAt > latest.postedAt) latest = item;
  }

  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const threadRes = await c.query<{ id: string }>(
      `INSERT INTO social_inbox_threads
         (tenant_id, account_id, network, kind, external_thread_id, post_variant_id,
          author_handle, author_name, excerpt, status, last_message_at, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,'central')
       ON CONFLICT (account_id, external_thread_id) DO UPDATE SET
         post_variant_id = COALESCE(social_inbox_threads.post_variant_id, EXCLUDED.post_variant_id),
         -- Never write a fresh excerpt/author onto a thread whose retention window already closed —
         -- 0113's own state-law CHECKs (sit_profile_purge_scrubs_author,
         -- sit_activity_purge_scrubs_excerpt) require the purged column stay NULL once its marker
         -- is set, and a thread's marker is keyed off the THREAD's own created_at, never reset by
         -- new activity (SMM-36's own design -- see inbox-retention-job.ts). Message rows below carry
         -- no such guard: each is a brand-new row with its own fresh created_at and purge clock.
         author_handle = CASE WHEN social_inbox_threads.profile_data_purged_at IS NULL
                               THEN COALESCE(EXCLUDED.author_handle, social_inbox_threads.author_handle)
                               ELSE social_inbox_threads.author_handle END,
         author_name = CASE WHEN social_inbox_threads.profile_data_purged_at IS NULL
                             THEN COALESCE(EXCLUDED.author_name, social_inbox_threads.author_name)
                             ELSE social_inbox_threads.author_name END,
         excerpt = CASE WHEN social_inbox_threads.activity_content_purged_at IS NULL
                        THEN EXCLUDED.excerpt ELSE social_inbox_threads.excerpt END,
         last_message_at = GREATEST(social_inbox_threads.last_message_at, EXCLUDED.last_message_at),
         updated_at = now()
       RETURNING id`,
      [
        tenantId, accountId, network, latest.kind, providerPostId, postVariantId,
        latest.authorHandle ?? null, latest.authorName ?? null, latest.body, latest.postedAt,
      ],
    );
    const threadId = threadRes.rows[0].id;

    let messagesWritten = 0;
    for (const item of items) {
      const res = await c.query(
        `INSERT INTO social_inbox_messages
           (tenant_id, thread_id, direction, external_id, body, author_handle, posted_at, source, origin_site)
         VALUES ($1,$2,'in',$3,$4,$5,$6,'direct_sync','central')
         ON CONFLICT (thread_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
        [tenantId, threadId, item.externalId, item.body, item.authorHandle ?? null, item.postedAt],
      );
      messagesWritten += res.rowCount ?? 0;
    }
    return { threadsWritten: 1, messagesWritten };
  });
}

// ── one tenant's sweep ─────────────────────────────────────────────────────────────────────────────

export interface TenantInboxPullResult {
  accounts: number;
  posts: number;
  threadsWritten: number;
  messagesWritten: number;
  unsupported: number;
  errors: number;
}

/** One tenant's pull, one post at a time — the ticket's own per-post constraint (see the file
 *  header). A single post's driver failure, or one account's unsupported network, is caught/counted
 *  and never aborts the rest of the sweep, mirroring `pullTenantMetrics`'s/`reconcileTenantPostStatus`'s
 *  own per-unit isolation. */
export async function pullTenantInbox(
  tenantId: string, now: Date = new Date(),
): Promise<TenantInboxPullResult> {
  const lookbackDays = config.social.inboxPull.lookbackDays;
  const maxPerAccount = config.social.inboxPull.maxPostsPerAccountPerRun;

  const eligible = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadEligiblePosts(c, lookbackDays);
  });
  const capped = capPerAccount(eligible, maxPerAccount);

  const cursors = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadThreadCursors(c, capped);
  });

  const accountIds = new Set<string>();
  let threadsWritten = 0;
  let messagesWritten = 0;
  let unsupported = 0;
  let errors = 0;

  for (const post of capped) {
    accountIds.add(post.accountId);
    try {
      const { driver, handle } = await resolveDispatchOrgHandle(
        tenantId,
        {
          org: {
            id: post.orgId, clientId: post.orgClientId, driver: post.orgDriver,
            postizOrgId: post.orgPostizOrgId, apiKeyRef: post.orgApiKeyRef, status: post.orgStatus,
          },
          network: post.network,
          accountId: post.accountId,
        },
        "inbox_read",
      );

      // The "unsupported vs empty" distinction the ticket names by name: `resolvePublisherForCapability`
      // does not itself check whether the resolved driver actually advertises `inbox_read` when NO
      // override names a different one (that is the default for every deployment today — Postiz,
      // every network, per spike §8b) — so this file is the one that checks. An absent capability or
      // an absent `listComments` member is refused HERE, honestly, never silently treated as "zero
      // comments".
      if (!driver.capabilities.has("inbox_read") || typeof driver.listComments !== "function") {
        unsupported += 1;
        continue;
      }

      const key = `${post.accountId}:${post.providerPostId}`;
      const since = cursors.get(key) ?? new Date(post.publishedAt);

      const items = await invokePublisher(
        { op: "listComments", org: handle, network: post.network },
        () => driver.listComments!(handle, post.providerPostId, since),
      );

      if (items.length > 0) {
        const written = await upsertInboxItems(tenantId, {
          accountId: post.accountId, network: post.network, providerPostId: post.providerPostId,
          postVariantId: post.variantId, items,
        });
        threadsWritten += written.threadsWritten;
        messagesWritten += written.messagesWritten;
      }
    } catch (err) {
      if (err instanceof SocialPublisherError && err.code === "capability_unsupported") {
        // A configured override names a (network, capability) pair the resolved driver does not
        // actually cover (registry.ts's own eager, data-driven refusal) — the SAME honest-refusal
        // fact as the in-file check above, just raised one layer up. Counted the same way.
        unsupported += 1;
        continue;
      }
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[SOCIAL-INBOX-PULL] post ${post.variantId} (account ${post.accountId}, tenant ${tenantId}) failed:`,
        (err as Error).message,
      );
    }
  }

  return {
    accounts: accountIds.size, posts: capped.length, threadsWritten, messagesWritten, unsupported, errors,
  };
}

/** Sweep every tenant. Mirrors `runInboxRetentionPurge`/`runMetricsPull`/`runPostStatusSync`
 *  verbatim: `withGlobal` for the company list (companies carry no tenant_id — they ARE the
 *  tenants), per-tenant failures logged and swallowed so one tenant's bad account/outage can never
 *  abort the sweep for every other tenant. */
export async function runInboxPull(now: Date = new Date()): Promise<{
  tenants: number; accounts: number; posts: number; threadsWritten: number; messagesWritten: number;
  unsupported: number; errors: number;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let accounts = 0;
  let posts = 0;
  let threadsWritten = 0;
  let messagesWritten = 0;
  let unsupported = 0;
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const r = await pullTenantInbox(tenantId, now);
      accounts += r.accounts;
      posts += r.posts;
      threadsWritten += r.threadsWritten;
      messagesWritten += r.messagesWritten;
      unsupported += r.unsupported;
      errors += r.errors;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-INBOX-PULL] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, accounts, posts, threadsWritten, messagesWritten, unsupported, errors };
}

// ── env-gated loop (`smm-inbox-pull`) ──────────────────────────────────────────────────────────────

/** Only started by main.ts when `config.social.inboxPull.pullEnabled` is true — dark by default,
 *  same convention as every other sweep in this module. See config.ts's own comment for why. */
export function startInboxPullLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runInboxPull();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-INBOX-PULL] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-INBOX-PULL] tick failed:", (err as Error).message);
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
