// SMM-10 — D-22's creator-info verifier, and the live fetch that feeds it.
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md §A4i OQ-8 -> D-22 (owner decision
// 2026-08-18). Seam: `publish-precondition.ts`'s `CreatorInfoVerifier` type + `setCreatorInfoVerifier`
// — read that file's own "D-22: the creator-info re-verify seam" section before touching this one;
// it states the two constraints this file exists to satisfy:
//
//   1. The VERIFIER (`installedCreatorInfoVerifier` below) runs INSIDE the executor's/dispatch's
//      claim transaction, under an advisory lock. It MUST be read-only and MUST NOT perform network
//      I/O — it reads the two columns migration 0114 added and nothing else.
//   2. The LIVE FETCH (`refreshCreatorInfoSnapshot` below) runs at DISPATCH, OUTSIDE that
//      transaction, on `dispatch.ts`'s own network-I/O phase. It writes the snapshot the verifier
//      later reads.
//
// Splitting these two functions across this one file (rather than putting the fetch in dispatch.ts)
// keeps the read half and the write half of the same contract next to each other, where a reviewer
// checking "does the verifier only ever see what the fetch wrote" reads one file.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import {
  PUBLISH_REFUSAL,
  declareSocialModuleScope,
  setCreatorInfoVerifier,
  type CreatorInfoContext,
  type CreatorInfoVerdict,
} from "./publish-precondition";
import { getPublisher, invokePublisher } from "./publisher/registry";
import { openOrg, type PublisherOrgRow } from "./publisher/provisioning";
import type { CreatorInfoSnapshot } from "./publisher/types";

/** How stale a snapshot may be before the verifier treats it as though it never existed. TikTok's
 *  own requirement is consent "immediately before" upload — this cannot literally mean zero seconds
 *  (the dispatch flow itself takes time between the fetch and the actual `schedulePost` call), so a
 *  short, generous-but-bounded window is the honest reading of D-22's "re-verified at dispatch":
 *  the snapshot must have been fetched as PART OF THIS dispatch attempt, not left over from a much
 *  earlier one that never completed (a crash-wedge retry, §"THE CRASH-WEDGE RULE" in
 *  core/approval-execute.ts). 10 minutes comfortably covers one dispatch attempt (HUB_CALL_TIMEOUT_MS
 *  is 30s) while refusing a snapshot that is really "from an attempt that already gave up".
 */
export const CREATOR_INFO_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

interface SnapshotRow {
  creator_info_snapshot: CreatorInfoSnapshot | null;
  creator_info_fetched_at: Date | null;
}

/**
 * THE VERIFIER. Read-only, no network I/O — reads exactly the two columns 0114 added, on the
 * caller's own transaction (already module-scoped and lock-held by the time
 * `evaluatePublishPrecondition` reaches stage 6). Compares the APPROVED selections (`ctx.settings`,
 * which only ever arrives here after the `hash` stage has already matched them against what a human
 * saw) against the snapshot's live permissions.
 *
 * `settings`'s shape is the composer's own TikTok dialect (spike §8a): `privacyLevel`,
 * `disableComment`, `disableDuet`, `disableStitch`. This function does not invent a second one.
 */
export async function verifyCreatorInfo(c: PoolClient, ctx: CreatorInfoContext): Promise<CreatorInfoVerdict> {
  const { rows } = await c.query<SnapshotRow>(
    `SELECT creator_info_snapshot, creator_info_fetched_at
       FROM social_post_variants WHERE id = $1 AND deleted_at IS NULL`,
    [ctx.variantId],
  );
  const row = rows[0];
  const snapshot = row?.creator_info_snapshot ?? null;
  const fetchedAt = row?.creator_info_fetched_at ?? null;
  if (!snapshot || !fetchedAt) {
    return { ok: false, reason: PUBLISH_REFUSAL.creatorInfoUnverified };
  }
  const age = Date.now() - new Date(fetchedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > CREATOR_INFO_SNAPSHOT_MAX_AGE_MS) {
    // Too old (or a clock anomaly) to count as "immediately before" — treat exactly as unfetched.
    return { ok: false, reason: PUBLISH_REFUSAL.creatorInfoUnverified };
  }

  const settings = ctx.settings as { privacyLevel?: unknown; disableComment?: unknown; disableDuet?: unknown; disableStitch?: unknown };
  const privacyLevel = typeof settings.privacyLevel === "string" ? settings.privacyLevel : null;
  // No default privacy level (TikTok's own requirement, §A4h finding 3) — an approval that carries
  // no explicit choice can never be "still permitted", it was never a valid selection to begin with.
  if (!privacyLevel || !snapshot.privacyLevelOptions.includes(privacyLevel)) {
    return { ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted };
  }
  // A toggle the human explicitly turned ON (comment/duet/stitch ENABLED) that the creator's account
  // no longer permits is the exact "selections no longer permitted" fact D-22 exists to catch.
  // Disabling something the human never asked to enable is never a mismatch either direction.
  if (settings.disableComment !== true && snapshot.commentDisabled) {
    return { ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted };
  }
  if (settings.disableDuet !== true && snapshot.duetDisabled) {
    return { ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted };
  }
  if (settings.disableStitch !== true && snapshot.stitchDisabled) {
    return { ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted };
  }
  return { ok: true };
}

/** Install the verifier at boot. Exported so main.ts calls this once, and so a test file can call it
 *  after `resetCreatorInfoVerifier()` without hand-rolling a second copy — same convention as
 *  `registerSocialExecutableApprovals`/`registerRetentionPurger`'s own install functions. */
export function installCreatorInfoVerifier(): void {
  setCreatorInfoVerifier(verifyCreatorInfo);
}

/**
 * THE LIVE FETCH. Called by `dispatch.ts` OUTSIDE the claim transaction, for a TikTok variant only,
 * BEFORE the precondition (and therefore the verifier) runs. Network I/O against the publisher, then
 * a plain, fast, single-row UPDATE — no advisory lock, because writing this row is not the one-shot
 * event the approval/provider-id stamp is (a stale write here just means the verifier sees an older
 * snapshot and refuses `creator_info_unverified`, never a double-publish).
 *
 * Never throws: a probe the engine cannot carry, or an unreachable publisher, is an EXPECTED outcome
 * of a documented upstream gap (see the port's own `getCreatorInfo` doc) — this function reports it
 * by leaving the snapshot columns untouched (or clearing them) rather than raising, and the caller's
 * precondition re-run is what turns "no fresh snapshot" into the typed refusal.
 */
export async function refreshCreatorInfoSnapshot(
  tenantId: string,
  variantId: string,
  org: PublisherOrgRow,
  integrationId: string,
): Promise<void> {
  const driver = getPublisher(org.driver as "postiz" | "mixpost") ?? undefined;
  if (!driver?.getCreatorInfo || !driver.capabilities.has("creator_info_probe")) return;
  let snapshot: CreatorInfoSnapshot | undefined;
  try {
    const { handle } = openOrg(org);
    snapshot = await invokePublisher(
      { op: "getCreatorInfo", org: handle, network: "tiktok" },
      () => driver.getCreatorInfo!(handle, { id: integrationId, network: "tiktok", handle: "" }),
    );
  } catch {
    snapshot = undefined; // fail-soft: an unreachable probe leaves the prior snapshot in place
  }
  if (!snapshot) return; // nothing fresh to write — the verifier will see the old (or absent) one
  await withTenants(
    [tenantId],
    async (c) => {
      await declareSocialModuleScope(c);
      await c.query(
        `UPDATE social_post_variants
            SET creator_info_snapshot = $2::jsonb, creator_info_fetched_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [variantId, JSON.stringify(snapshot)],
      );
    },
  );
}
