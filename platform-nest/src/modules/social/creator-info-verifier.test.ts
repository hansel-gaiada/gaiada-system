// SMM-10/D-22 — `creator-info-verifier.ts` against a live Postgres + a mock publisher driver.
//
// Two halves, tested separately per the seam's own split:
//   (A) `verifyCreatorInfo` — READ-ONLY, no network I/O. Given a snapshot already on the row (or
//       none), what does it decide.
//   (B) `refreshCreatorInfoSnapshot` — the live fetch. Given a mock driver's reported creator_info
//       (or its absence), what does it write — and this is ALSO the module-GUC regression test: the
//       function declares its own scope before writing `social_post_variants`, and every assertion
//       below that finds the write actually landed proves that call is still there.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import type { PublisherOrgRow } from "./publisher/provisioning";
import { declareSocialModuleScope, PUBLISH_REFUSAL, type CreatorInfoContext } from "./publish-precondition";
import { verifyCreatorInfo, refreshCreatorInfoSnapshot, CREATOR_INFO_SNAPSHOT_MAX_AGE_MS } from "./creator-info-verifier";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm10-d22-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-10/D-22 · creator-info-verifier", () => {
  let co: string;
  let clientId: string;
  let orgRow: PublisherOrgRow;
  let tiktokAccount: string;
  let integrationId: string;
  let state: MockPublisherState;

  beforeAll(async () => {
    await initTestDb();
    config.social.publisher.defaultOrgApiKey = "test-org-key";

    co = await createCompany("SMM-10 D-22 Co", ["social"]);
    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
    const orgId = newId();
    const postizOrgRef = uniq("org");
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [orgId, co, clientId, postizOrgRef]), MODULES);
    orgRow = { id: orgId, clientId, driver: "postiz", postizOrgId: postizOrgRef, apiKeyRef: "default", status: "active" };
    integrationId = uniq("tt-integration");
    tiktokAccount = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'tiktok',$5,$6,'connected','{}','central')`,
        [tiktokAccount, co, clientId, orgId, uniq("@brand"), integrationId]), MODULES);
  });

  afterAll(async () => { await teardownTestDb(); });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state, { withCreatorInfoProbe: true }));
  });

  async function makeVariant(): Promise<string> {
    const engagementId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'d22 engagement','active','{}',10,'central')`,
        [engagementId, co, clientId]), MODULES);
    const postId = newId();
    const variantId = newId();
    await withTenants([co], async (c) => {
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
                     VALUES ($1,$2,$3,'d22 post','in_review','central')`, [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, media, settings, status, origin_site)
         VALUES ($1,$2,$3,$4,'tiktok body','[]','{}','approved','central')`,
        [variantId, co, postId, tiktokAccount],
      );
    }, MODULES);
    return variantId;
  }

  async function setSnapshot(variantId: string, snapshot: unknown, fetchedAtMsAgo: number | null): Promise<void> {
    await withTenants([co], async (c) => {
      await declareSocialModuleScope(c);
      if (fetchedAtMsAgo === null) {
        await c.query(`UPDATE social_post_variants SET creator_info_snapshot = NULL, creator_info_fetched_at = NULL WHERE id = $1`, [variantId]);
        return;
      }
      await c.query(
        `UPDATE social_post_variants
            SET creator_info_snapshot = $2::jsonb, creator_info_fetched_at = now() - make_interval(secs => $3)
          WHERE id = $1`,
        [variantId, JSON.stringify(snapshot), fetchedAtMsAgo / 1000],
      );
    });
  }

  function ctxFor(variantId: string, settings: Record<string, unknown>): CreatorInfoContext {
    return { variantId, accountId: tiktokAccount, network: "tiktok", integrationId, publisherOrgId: orgRow.id, settings };
  }

  async function runVerify(variantId: string, settings: Record<string, unknown>) {
    return withTenants([co], async (c) => {
      await declareSocialModuleScope(c);
      return verifyCreatorInfo(c, ctxFor(variantId, settings));
    });
  }

  // ══ (A) verifyCreatorInfo — read-only decision ═══════════════════════════════════════════════

  it("(A1) ⭐ GOLDEN CASE — no snapshot at all ⇒ creator_info_unverified, fail closed", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, null, null);
    const verdict = await runVerify(variantId, { privacyLevel: "PUBLIC_TO_EVERYONE" });
    expect(verdict).toEqual({ ok: false, reason: PUBLISH_REFUSAL.creatorInfoUnverified });
  });

  it("(A2) a snapshot older than the freshness window ⇒ creator_info_unverified — treated as unfetched", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, { privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], commentDisabled: false, duetDisabled: false, stitchDisabled: false }, CREATOR_INFO_SNAPSHOT_MAX_AGE_MS + 60_000);
    const verdict = await runVerify(variantId, { privacyLevel: "PUBLIC_TO_EVERYONE" });
    expect(verdict).toEqual({ ok: false, reason: PUBLISH_REFUSAL.creatorInfoUnverified });
  });

  it("(A3) a fresh snapshot that still permits the approved selection ⇒ ok", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, { privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false }, 30_000);
    const verdict = await runVerify(variantId, { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false });
    expect(verdict).toEqual({ ok: true });
  });

  it("(A4) ⭐ GOLDEN CASE — the approved privacy level is no longer among the creator's live options ⇒ creator_selection_no_longer_permitted", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, { privacyLevelOptions: ["SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false }, 30_000);
    const verdict = await runVerify(variantId, { privacyLevel: "PUBLIC_TO_EVERYONE" });
    expect(verdict).toEqual({ ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted });
  });

  it("(A5) no default privacy level: an approval with none set can never be 'still permitted'", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, { privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], commentDisabled: false, duetDisabled: false, stitchDisabled: false }, 30_000);
    const verdict = await runVerify(variantId, {});
    expect(verdict).toEqual({ ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted });
  });

  it("(A6) the creator turned comments OFF after the human approved commenting ON ⇒ refused", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, { privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], commentDisabled: true, duetDisabled: false, stitchDisabled: false }, 30_000);
    const verdict = await runVerify(variantId, { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false });
    expect(verdict).toEqual({ ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted });
  });

  it("(A7) disabling something the human never asked to enable is never a mismatch", async () => {
    const variantId = await makeVariant();
    await setSnapshot(variantId, { privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], commentDisabled: true, duetDisabled: false, stitchDisabled: false }, 30_000);
    // The human explicitly turned comments OFF too — the creator's account also disabling them is
    // not a conflict with anything the approval actually asked for.
    const verdict = await runVerify(variantId, { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: true });
    expect(verdict).toEqual({ ok: true });
  });

  // ══ (B) refreshCreatorInfoSnapshot — the live fetch + module-GUC regression ═════════════════════

  async function snapshotRow(variantId: string) {
    const { rows } = await withTenants([co], (c) =>
      c.query(
        `SELECT creator_info_snapshot AS "snapshot", creator_info_fetched_at AS "fetchedAt"
           FROM social_post_variants WHERE id = $1`,
        [variantId],
      ), MODULES);
    return rows[0];
  }

  it("(B1) ⭐ writes a fresh snapshot from the driver's live report — and this IS the module-GUC regression test", async () => {
    const variantId = await makeVariant();
    state.creatorInfo.set(integrationId, {
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], commentDisabled: false, duetDisabled: false, stitchDisabled: false,
    });

    await refreshCreatorInfoSnapshot(co, variantId, orgRow, integrationId);

    const row = await snapshotRow(variantId);
    expect(row.snapshot).toMatchObject({ privacyLevelOptions: ["PUBLIC_TO_EVERYONE"] });
    expect(row.fetchedAt).not.toBeNull();
    expect(state.calls.filter((c) => c.op === "getCreatorInfo")).toHaveLength(1);
  });

  it("(B2) the driver reporting nothing (probe unavailable) writes NOTHING — never a fabricated snapshot", async () => {
    const variantId = await makeVariant();
    // Deliberately no state.creatorInfo entry for this integration — mock returns undefined.
    await refreshCreatorInfoSnapshot(co, variantId, orgRow, integrationId);
    const row = await snapshotRow(variantId);
    expect(row.snapshot).toBeNull();
    expect(row.fetchedAt).toBeNull();
  });

  it("(B3) a driver with no creator_info_probe capability is never even called", async () => {
    resetPublishers();
    registerPublisher(createMockPublisher(state)); // withCreatorInfoProbe defaults false
    const variantId = await makeVariant();
    await refreshCreatorInfoSnapshot(co, variantId, orgRow, integrationId);
    expect(state.calls.filter((c) => c.op === "getCreatorInfo")).toHaveLength(0);
    const row = await snapshotRow(variantId);
    expect(row.snapshot).toBeNull();
  });

  it("(B4) a throwing driver fails soft — leaves the row untouched rather than propagating", async () => {
    const variantId = await makeVariant();
    state.failWith = new (await import("./publisher/types")).SocialPublisherError("publisher_unreachable", "simulated outage");
    await expect(refreshCreatorInfoSnapshot(co, variantId, orgRow, integrationId)).resolves.toBeUndefined();
    const row = await snapshotRow(variantId);
    expect(row.snapshot).toBeNull();
  });
});
