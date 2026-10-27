// SCP-Sa — THE SOCIAL SIMULATOR: a labelled, flag-gated publisher for the dev-review stage (plan SCP-D1, SCP-D3, §5).
//
// ⚠ READ simulation.ts's HEADER FIRST. This file reverses the module's standing "no simulator" rule (mock-driver.ts,
// boot.ts), and the six fences that make the reversal safe live there and in boot.ts. This header covers only what the
// driver itself owes.
//
// ── IT IS NOT THE TEST DOUBLE ──────────────────────────────────────────────────────────────────────────────────────
// `mock-driver.ts` stays exactly what it was: an in-memory double for the suites, registered by tests only, never by
// boot under any flag (publisher.test.ts pins that). This file is a different thing with a different job: the driver a
// DEPLOYMENT runs while the owner reviews the pipeline on mock data. It carries the structural `simulated: true` marker
// (the SM-33 shape, `simulation.ts#isSimulatedPublisher`), registers only under the key 'simulated', and boot registers
// it only while SOCIAL_SIMULATION_ENABLED is on (`boot.ts#wireSocialPublisher`).
//
// ── HOW DISPATCH REACHES IT, AND WHY NOTHING ELSE CAN ──────────────────────────────────────────────────────────────
// The org `driver` column cannot name it: 0105's CHECK admits only 'postiz'|'mixpost'. Widening that CHECK would make
// "simulated" a property of a client's whole ORG, settable by any row edit, and would put a real client's org one UPDATE
// away from fake publishing. So the route keys on the ACCOUNT instead, where the mock data actually is:
//
//   `provisioning.ts#assertDispatchChain` reads `social_accounts.simulated` into the chain, and
//   `provisioning.ts#resolveDispatchOrgHandle` (dispatch.ts's ONE resolver for `media_upload`/`schedule`, also used by
//   the cancel effect) sends a simulated account to `registry.ts#resolveSimulatedPublisher` and every other account down
//   the unchanged real path. The status sweep (post-status-sync-job.ts) routes the same way for `post_status`.
//
// Nothing else reaches it: `resolvePublisher` and `getPublisher` refuse it by name, a capability override naming it is
// refused (registry.ts) and refused at boot (boot.ts), and `resolveSimulatedPublisher` itself refuses while the switch
// is off. A real account never carries `simulated = true`: while the switch is on no real account can exist (boot and
// the account writers refuse), and while it is off nothing may write the mark (`assertSimulatedWriteAllowed`).
//
// ── WHAT A SIMULATED PUBLISH IS ────────────────────────────────────────────────────────────────────────────────────
// It takes the REAL dispatch path (`dispatch.ts#dispatchApprovedPublish`): the D14 approval is filed and DECIDED by a
// person through `/approvals`, the executor claims it, the precondition (client review, hash, quota, budget) re-runs
// under the lock, and only then does `schedulePost` reach this driver. Then, in order (cheapest and most structural first,
// the module's own doctrine):
//   1. no `approvalId`                         -> `approval_required` (the port's own structural D-6 check);
//   2. the switch is off                       -> `simulation_disabled`;
//   3. the handle is not a `SimulatedOrgHandle` -> `simulated_account_required`;
//   4. the variant's account is not simulated, or the variant is not the handle's account's
//                                              -> `simulated_account_required` (read from OUR rows, not trusted);
//   5. no DECIDED publish approval names this variant
//                                              -> `simulated_approval_not_decided`. The simulator reads
//      `automation_approvals`; it never inserts or decides one (BFF §63.10);
//   6. the caption contains `[simulate-fail]`  -> `simulated_publish_failed`: dispatch.ts records the variant `failed`
//      with that code in `last_error`, emits `social.post.failed` and writes the `failed` activity row, exactly as for a
//      real engine's refusal (the failed-post path, plan §5);
//   7. otherwise it returns a provider post id `simulated:<network>:<publishAtMs>:<uuid>`, and dispatch.ts stamps the
//      variant `queued` with `simulated = true` in its one transactional UPDATE.
// The status sweep then asks `getPostStatus`, which answers `published` at `publishAt` (the dispatch time, or the
// approved `scheduledAt` when that is later: a scheduled post goes live at its time, not before) with the URL
// `https://simulated.invalid/<network>/<uuid>`, and post-status-sync-job.ts writes `published_url`/`published_at` and the
// `published` event and activity row through its unchanged idempotent apply.
//
// The driver holds no state between calls (types.ts rule 2): everything `getPostStatus` needs is in the id.
//
// ── SIMULATED METRICS (SCP-Sd) ─────────────────────────────────────────────────────────────────────────────────────
// `getAccountMetrics` and `getPostMetrics` answer from `simulated-metrics.ts`'s pure generator, through the SAME seam a real
// engine's numbers take: the nightly job (`metrics-job.ts`) resolves this driver through `resolveSimulatedPublisher` for a
// simulated account and writes what comes back; nothing else writes a simulated number. Both answer behind the switch and a
// `SimulatedOrgHandle`, like every other method here, and read the FACTS they need (the account's network, a post's format
// and go-live moment) from OUR rows through a seam (`SimulatedMetricsFacts`, below), only for a variant on a SIMULATED account
// and only for an id this driver minted. The driver holds no state: the same rows and the same clock give the same answer.
//   - `getPostMetrics(org, ids)`: one entry per (post, due day), `day` in 1, 3, 7 once `went_live_at + day days <= now`, each
//     stamped `capturedAt = went_live_at + day days` and carrying `reach`. So a post that went live three days ago gets days 1
//     and 3 in one answer (the catch-up), and the job's idempotency is "a simulated row stamped so already exists".
//   - `getAccountMetrics(org, _, range)`: one row per date of the range (the job asks a 30-day window for a simulated account).
//
// ── SEAMS FOR THE NEXT TICKETS (do not build them here) ────────────────────────────────────────────────────────────
//   SCP-Sc  the every-minute due job and "Publish now (simulated)": file and get a DECIDED approval, then call the same
//           `dispatchApprovedPublish`; run `reconcileTenantPostStatus` to move queued -> published without waiting for
//           the 15-minute safety poll. `pipeline-data.ts`'s `publisherAvailable` still reads the ORG's driver and will say
//           false for a simulated account until Sc teaches it `resolveSimulatedPublisher`.
import { randomUUID } from "node:crypto";
import { withTenants } from "../../../db";
import { declareSocialModuleScope } from "../module-scope";
import { SOCIAL_PUBLISH_METERED_TOOL, SOCIAL_PUBLISH_TOOL } from "../publish-precondition";
import { dueSnapshotDays, simulatedDailySeries, simulatedPostMetrics, snapshotCapturedAt } from "./simulated-metrics";
import {
  SIMULATED_PUBLISHER_KEY, SIMULATED_URL_ORIGIN, SIMULATE_FAIL_KEYWORD, SOCIAL_SIMULATION_ENV,
  SOCIAL_SIMULATION_REFUSAL, SimulatedOrgHandle, isSocialSimulationEnabled,
} from "./simulation";
import {
  SocialPublisherError,
  type DailyMetrics,
  type DateRange,
  type OrgHandle,
  type PostMetrics,
  type PostStatus,
  type PublisherCapability,
  type SocialPublisher,
  type VariantDispatch,
} from "./types";

/** What the simulator simulates today. `schedule` + `post_status` are the publish; `media_upload` lets a post with
 *  pictures publish (nothing is uploaded anywhere); `cancel` lets `unschedule` withdraw a queued simulated post;
 *  `account_metrics` + `post_metrics` are SCP-Sd's deterministic numbers. NOT `connect_url`/`integrations`/`org_verify`:
 *  simulated accounts are SEEDED (SCP-Sb), never connected. NOT the inbox. */
export const SIMULATED_CAPABILITIES: readonly PublisherCapability[] = [
  "schedule", "post_status", "cancel", "media_upload", "account_metrics", "post_metrics",
];

/** The ids this driver mints, and only these, are ones it will answer for. */
const SIMULATED_POST_ID = /^simulated:([a-z]+):(\d+):([0-9a-f-]{36})$/;

export interface SimulatedDispatchCheck {
  code: typeof SOCIAL_SIMULATION_REFUSAL.accountNotSimulated | typeof SOCIAL_SIMULATION_REFUSAL.approvalNotDecided;
  message: string;
}

/** The two facts the simulator must read from OUR rows before it reports a publish: the variant's account is simulated
 *  (and is the handle's account), and a DECIDED publish approval names the variant. A seam so the driver's ordering and
 *  refusals can be proved without a database; the default reads Postgres. `null` = both hold. */
export type SimulatedDispatchGuard = (handle: SimulatedOrgHandle, req: VariantDispatch) => Promise<SimulatedDispatchCheck | null>;

/** The real guard. Read-only, one transaction, the social module scope declared on it (an omitted declaration reads
 *  ZERO rows silently and would refuse every publish as "not simulated": fail-closed, but confusing). */
export const dbSimulatedDispatchGuard: SimulatedDispatchGuard = async (handle, req) =>
  withTenants([handle.tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const v = await c.query<{ account_id: string; account_simulated: boolean }>(
      `SELECT v.account_id, a.simulated AS account_simulated
         FROM social_post_variants v
         JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
        WHERE v.id = $1 AND v.deleted_at IS NULL AND a.deleted_at IS NULL`,
      [req.variantId],
    );
    const row = v.rows[0];
    if (!row || row.account_id !== handle.accountId || row.account_simulated !== true) {
      return {
        code: SOCIAL_SIMULATION_REFUSAL.accountNotSimulated,
        message: `variant ${req.variantId} does not target a simulated account: the social simulator publishes only to `
          + "accounts marked simulated, never to a real one",
      };
    }
    const a = await c.query(
      `SELECT 1 FROM automation_approvals
        WHERE id = $1 AND tenant_id = $2 AND status = 'approved'
          AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND deleted_at IS NULL
          AND tool_name = ANY($3::text[]) AND tool_args @> $4::jsonb`,
      [req.approvalId, handle.tenantId, [SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_METERED_TOOL], JSON.stringify({ variantId: req.variantId })],
    );
    if (a.rowCount !== 1) {
      return {
        code: SOCIAL_SIMULATION_REFUSAL.approvalNotDecided,
        message: `approval ${req.approvalId} is not a decided publish approval for variant ${req.variantId}: the social `
          + "simulator never mints or decides an approval itself",
      };
    }
    return null;
  });

/** What the metrics generator needs from OUR rows about one simulated post: which variant it is (the seed), the network and
 *  the post's format, and the moment it went live (`social_posts.went_live_at`, else the variant's `published_at`). */
export interface SimulatedPostFact {
  providerPostId: string;
  variantId: string;
  network: string;
  format: string | null;
  wentLiveAt: Date;
}

/** The two reads the metrics methods make, as a seam so the driver's ordering, due-day arithmetic and refusals can be proved
 *  without a database; the default reads Postgres. Both answer ONLY for rows on a `social_accounts.simulated = true` account:
 *  a real account's variant or account is simply absent from the answer. */
export interface SimulatedMetricsFacts {
  posts(tenantId: string, providerPostIds: string[]): Promise<SimulatedPostFact[]>;
  /** The network of a simulated account, or null when it is absent, deleted or NOT simulated. */
  account(tenantId: string, accountId: string): Promise<{ network: string } | null>;
}

/** The real reads. Read-only, one transaction each, the social module scope declared (an omitted declaration reads ZERO
 *  rows silently, which here would mean a simulated account that never gets a number). */
export const dbSimulatedMetricsFacts: SimulatedMetricsFacts = {
  async posts(tenantId, providerPostIds) {
    if (providerPostIds.length === 0) return [];
    return withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      const { rows } = await c.query<{ provider_post_id: string; variant_id: string; network: string; format: string | null; went_live_at: Date }>(
        `SELECT v.provider_post_id, v.id::text AS variant_id, a.network, p.format,
                COALESCE(p.went_live_at, v.published_at) AS went_live_at
           FROM social_post_variants v
           JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
           JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
          WHERE v.provider_post_id = ANY($1::text[]) AND v.status = 'published' AND v.deleted_at IS NULL
            AND a.simulated = true AND a.deleted_at IS NULL AND p.deleted_at IS NULL
            AND COALESCE(p.went_live_at, v.published_at) IS NOT NULL`,
        [providerPostIds],
      );
      return rows.map((r) => ({
        providerPostId: r.provider_post_id, variantId: r.variant_id, network: r.network, format: r.format, wentLiveAt: new Date(r.went_live_at),
      }));
    });
  },
  async account(tenantId, accountId) {
    return withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      const { rows } = await c.query<{ network: string }>(
        `SELECT network FROM social_accounts WHERE id = $1 AND simulated = true AND deleted_at IS NULL`,
        [accountId],
      );
      return rows[0] ?? null;
    });
  },
};

export interface SimulatedPublisherOptions {
  /** Defaults to `dbSimulatedDispatchGuard`. Tests pass a stub to prove ordering without Postgres. */
  guard?: SimulatedDispatchGuard;
  /** Defaults to `dbSimulatedMetricsFacts`. Tests pass a stub to prove the numbers' wiring without Postgres. */
  metricsFacts?: SimulatedMetricsFacts;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

function refuse(code: SocialPublisherError["code"], message: string): never {
  throw new SocialPublisherError(code, message);
}

function requireSwitch(op: string): void {
  if (!isSocialSimulationEnabled()) {
    refuse(SOCIAL_SIMULATION_REFUSAL.disabled, `social simulator '${op}' refused: ${SOCIAL_SIMULATION_ENV} is off`);
  }
}

function requireSimulatedHandle(org: OrgHandle, op: string): SimulatedOrgHandle {
  if (!(org instanceof SimulatedOrgHandle)) {
    refuse(
      SOCIAL_SIMULATION_REFUSAL.accountNotSimulated,
      `social simulator '${op}' refused: it was handed a real org handle, not a simulated account's`,
    );
  }
  return org;
}

function unsupported(op: string, why: string): never {
  refuse("capability_unsupported", `the social simulator does not simulate '${op}': ${why}`);
}

/** Build the simulator. Boot registers exactly one, and only with the switch on (boot.ts); `registerPublisher` refuses it
 *  otherwise. */
export function createSimulatedPublisher(opts: SimulatedPublisherOptions = {}): SocialPublisher {
  const guard = opts.guard ?? dbSimulatedDispatchGuard;
  const metricsFacts = opts.metricsFacts ?? dbSimulatedMetricsFacts;
  const now = opts.now ?? Date.now;

  return {
    key: SIMULATED_PUBLISHER_KEY,
    simulated: true,
    capabilities: new Set<PublisherCapability>(SIMULATED_CAPABILITIES),

    async createOrg() {
      unsupported("createOrg", "simulated accounts hang from a seeded org (SCP-Sb)");
    },
    async verifyOrg() {
      unsupported("verifyOrg", "there is no engine org to verify");
    },
    async connectUrl() {
      unsupported("connectUrl", "simulated accounts are seeded, never connected through OAuth");
    },
    async listIntegrations() {
      unsupported("listIntegrations", "simulated accounts are seeded, never synced from an engine");
    },
    async getQuota() {
      // No `quota_probe`: "unknown", never a synthesized cap (types.ts's warning on this method applies here too).
      return undefined;
    },

    async schedulePost(org: OrgHandle, req: VariantDispatch): Promise<{ providerPostId: string }> {
      // (1) The port's structural D-6 check, first, exactly as every driver makes it.
      if (!req.approvalId) {
        refuse("approval_required", "social simulator refused a dispatch with no approval id");
      }
      requireSwitch("schedulePost"); // (2)
      const handle = requireSimulatedHandle(org, "schedulePost"); // (3)
      const check = await guard(handle, req); // (4) + (5)
      if (check) refuse(check.code, check.message);
      if (req.body.includes(SIMULATE_FAIL_KEYWORD)) { // (6)
        refuse(
          SOCIAL_SIMULATION_REFUSAL.simulatedFailure,
          `simulated publish failed on purpose: the caption contains ${SIMULATE_FAIL_KEYWORD} (SIMULATED, nothing was sent)`,
        );
      }
      // (7) Live at dispatch time, or at the approved time when that is later.
      const at = req.scheduledAt ? Date.parse(req.scheduledAt) : NaN;
      const publishAt = Math.max(now(), Number.isFinite(at) ? at : 0);
      return { providerPostId: `simulated:${req.network}:${publishAt}:${randomUUID()}` };
    },

    async cancelPost(org: OrgHandle, providerPostId: string): Promise<void> {
      requireSwitch("cancelPost");
      requireSimulatedHandle(org, "cancelPost");
      if (!SIMULATED_POST_ID.test(providerPostId)) {
        refuse(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated, "social simulator refused to cancel a post it did not make");
      }
      // Nothing is queued anywhere: the variant's own status (pipeline-effects.ts) is the whole state of a cancel.
    },

    async getPostStatus(org: OrgHandle, providerPostIds: string[]): Promise<PostStatus[]> {
      requireSwitch("getPostStatus");
      requireSimulatedHandle(org, "getPostStatus");
      const t = now();
      return providerPostIds.map((id): PostStatus => {
        const m = SIMULATED_POST_ID.exec(id);
        // An id this driver never minted is "unknown": post-status-sync-job.ts leaves such a row exactly where it is.
        if (!m) return { providerPostId: id, state: "unknown" };
        const [, network, atMs, uuid] = m;
        const publishAt = Number(atMs);
        if (t < publishAt) return { providerPostId: id, state: "queued" };
        return {
          providerPostId: id,
          state: "published",
          publishedUrl: `${SIMULATED_URL_ORIGIN}/${network}/${uuid}`,
          publishedAt: new Date(publishAt).toISOString(),
        };
      });
    },

    async uploadMedia(org: OrgHandle): Promise<{ id: string; url?: string }> {
      requireSwitch("uploadMedia");
      requireSimulatedHandle(org, "uploadMedia");
      const id = randomUUID();
      return { id: `simulated-media:${id}`, url: `${SIMULATED_URL_ORIGIN}/media/${id}` };
    },

    async getAccountMetrics(org: OrgHandle, _integrationId: string, range: DateRange): Promise<DailyMetrics[]> {
      requireSwitch("getAccountMetrics");
      const handle = requireSimulatedHandle(org, "getAccountMetrics");
      if (!handle.accountId) {
        refuse(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated, "social simulator 'getAccountMetrics' refused: the handle names no account");
      }
      // Read from OUR row, not trusted from the handle: only a simulated account gets simulated numbers.
      const account = await metricsFacts.account(handle.tenantId, handle.accountId);
      if (!account) {
        refuse(
          SOCIAL_SIMULATION_REFUSAL.accountNotSimulated,
          `account ${handle.accountId} is not a simulated account: the social simulator makes up numbers only for those`,
        );
      }
      return simulatedDailySeries(handle.accountId, account.network, range).map((r): DailyMetrics => ({
        date: r.date, followers: r.followers, impressions: r.impressions, reach: r.reach, engagements: r.engagements,
        linkClicks: r.linkClicks, videoViews: r.videoViews, raw: { simulated: true },
      }));
    },
    async getPostMetrics(org: OrgHandle, providerPostIds: string[]): Promise<PostMetrics[]> {
      requireSwitch("getPostMetrics");
      const handle = requireSimulatedHandle(org, "getPostMetrics");
      // Only ids this driver minted are answered for: anything else (a real engine's id) is silently absent, like the status read.
      const mine = providerPostIds.filter((id) => SIMULATED_POST_ID.test(id));
      if (mine.length === 0) return [];
      const facts = await metricsFacts.posts(handle.tenantId, mine);
      const at = new Date(now());
      const out: PostMetrics[] = [];
      for (const f of facts) {
        // One entry per DUE day, oldest first. A post that has not been live a day yet has none: "we do not know yet".
        for (const day of dueSnapshotDays(f.wentLiveAt, at)) {
          const s = simulatedPostMetrics(f.variantId, f.network, f.format, day);
          out.push({
            providerPostId: f.providerPostId,
            reach: s.reach, impressions: s.impressions, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves,
            clicks: s.clicks, ...(s.videoViews !== undefined ? { videoViews: s.videoViews } : {}),
            capturedAt: snapshotCapturedAt(f.wentLiveAt, day).toISOString(),
          });
        }
      }
      return out;
    },

    estimateCostUsd(): number {
      // Nothing is spent: no network is called and no metered post goes out.
      return 0;
    },
  };
}
