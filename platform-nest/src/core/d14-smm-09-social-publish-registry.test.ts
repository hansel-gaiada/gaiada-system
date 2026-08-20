// SMM-09 — `social.publishPost` (executable) + `social.publishPostMetered` (BARRED twin): the D14
// registry entry for the one action in this estate that is public and irreversible.
//
// Shape follows `d14-15-pm-registry.test.ts` deliberately: no Nest app is built here — the registry
// and `executeApprovedAutomationWrite` are plain functions over Postgres + a stubbed `fetch`. The
// HTTP surface (the dry-run endpoint, personas, the `message`-vs-`error` filter contract) is
// `modules/social/publish-gate.test.ts`, and neither file duplicates the other.
//
// What this file proves, one block each:
//   (A) doctrine   — the entry is real (not the D14-02 name-only fallback), the twin is BARRED and
//                    provably cannot execute, and neither can be re-registered into the other's role.
//   (B) lockKey    — a pure function of the VARIANT args that fails closed on malformed input
//                    without collapsing every bad call onto one shared lock.
//   (C) chain      — all six stages, called DIRECTLY under a live transaction, each returning the
//                    exact typed token SMM-10/17/22/31 will branch on, in the pinned order.
//   (D) executor   — a stale precondition driven through the REAL executor lands `failed` with
//                    `precondition_failed:*`, and the hub is ASSERTED (not inferred) to have been
//                    called zero times.
//   (E) edit       — editing a variant invalidates its approval, because the hash moves.
//   (F) replay     — a consumed grant cannot execute twice, by two independent mechanisms.
//   (G) no retry   — an AMBIGUOUS failure is never auto-retried, even when the tenant has turned
//                    auto-retry on. Deploy is the positive control that proves the setting works.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  registerExecutableApproval,
  registerBarredExecutable,
  resetExecutableApprovals,
  registerCoreExecutableApprovals,
  registerSocialExecutableApprovals,
  getExecutable,
  getBarredExecutable,
  isBarredExecutable,
  listBarredExecutables,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { variantPublishArgs, variantArgsSha256 } from "../modules/social/canonical-args";
import {
  PUBLISH_REFUSAL,
  PUBLISH_REFUSAL_STAGE,
  PUBLISH_PRECONDITION_STAGES,
  SOCIAL_PUBLISH_TOOL,
  SOCIAL_PUBLISH_METERED_TOOL,
  SOCIAL_PUBLISH_TOOL_CLASSIFICATION,
  evaluatePublishPrecondition,
  setCreatorInfoVerifier,
  resetCreatorInfoVerifier,
} from "../modules/social/publish-precondition";

const GRANT_SECRET = "smm-09-test-secret-not-a-real-one";
const MODULES: { modules: string[] } = { modules: ["social"] };

/** One valid Instagram attachment: IG requires media, and only JPEG images (addendum §A4f item 2). */
const IG_MEDIA = [{ fileId: "file-1", kind: "image", alt: "a photo", format: "jpeg" }];
/** TikTok is video-only, one attachment. */
const TIKTOK_MEDIA = [{ fileId: "file-v", kind: "video", format: "mp4" }];

// 0105 makes `social_publisher_orgs.postiz_org_id` GLOBALLY unique and `social_accounts` unique on
// (tenant, client, network, handle) — so every fixture that mints one needs a fresh label. A
// monotonic counter, NOT a slice of `newId()`: ids are uuidv7, whose leading hex IS a millisecond
// timestamp, so `newId().slice(0, 8)` is identical for every call inside the same ~68-minute window
// and collides on the very first repeat.
let seq = 0;
const uniq = (label: string): string => `smm09-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-09 registry: social.publishPost / social.publishPostMetered", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let otherClientId: string;
  let publisherOrgId: string;
  let igAccount: string;
  /** An account belonging to the OTHER client, created once: 0105 makes `social_publisher_orgs`
   *  unique on (tenant, client), so a second org for the same client is a constraint violation, not
   *  a fixture. */
  let foreignAccount: string;
  let enabledNetworksBefore: string[];

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.smm09.test", token: "hub-token", assuranceToken: "" };
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    // Independent of whatever another test file in this worker left the registry in — restore the
    // deploy pair (block (G)'s positive control needs it) plus the social entry AND its bar via the
    // exported bootstraps, never a hand-rolled second copy of their lock/precondition.
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerSocialExecutableApprovals();
    resetCreatorInfoVerifier();

    co = await createCompany("SMM-09 Social Publish Co", ["social"]);
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;

    clientId = await makeClient("Brand One");
    otherClientId = await makeClient("Brand Two");
    publisherOrgId = await makePublisherOrg(clientId, uniq("org-main"));
    igAccount = await makeAccount(publisherOrgId, clientId, "instagram", uniq("ig-main"));
    const foreignOrg = await makePublisherOrg(otherClientId, uniq("org-other"));
    foreignAccount = await makeAccount(foreignOrg, otherClientId, "instagram", uniq("ig-other"));
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    resetCreatorInfoVerifier();
    await teardownTestDb();
  });

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────

  async function makeClient(name: string): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,$3,'central')`, [id, co, name]),
    );
    return id;
  }

  async function makePublisherOrg(client: string, ref: string): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [id, co, client, ref],
      ), MODULES,
    );
    return id;
  }

  async function makeAccount(orgId: string, client: string, network: string, integrationId: string): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'connected','{}','central')`,
        [id, co, client, orgId, network, `@${network}-${integrationId}`, integrationId],
      ), MODULES,
    );
    return id;
  }

  async function makeEngagement(opts: {
    client?: string; status?: string; networks?: Record<string, boolean>; budgetUsd?: number;
  } = {}): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-09 engagement',$4,$5,$6,'central')`,
        [id, co, opts.client ?? clientId, opts.status ?? "active",
          JSON.stringify({ networks: opts.networks ?? { instagram: true, tiktok: true } }),
          opts.budgetUsd ?? 10],
      ), MODULES,
    );
    return id;
  }

  interface Publishable { variantId: string; args: Record<string, unknown>; engagementId: string; accountId: string }

  /** A variant that passes every stage, unless an option deliberately breaks one. Returns the
   *  publish args the approval would be bound to — built by the SAME function the composer uses, so
   *  the hash the gate recomputes and the hash these args produce are the same value by construction
   *  rather than by a literal copied into this file. */
  async function makePublishable(opts: {
    engagementId?: string; accountId?: string; network?: "instagram" | "tiktok";
    body?: string; media?: unknown; settings?: Record<string, unknown>; status?: string;
    /** Write a DIFFERENT hash into the anchor column than the content implies. */
    corruptStoredHash?: boolean;
  } = {}): Promise<Publishable> {
    const engagementId = opts.engagementId ?? (await makeEngagement());
    const accountId = opts.accountId ?? igAccount;
    const network = opts.network ?? "instagram";
    const postId = newId();
    const variantId = newId();
    const body = opts.body ?? "Hello from the publish gate";
    const media = opts.media ?? (network === "tiktok" ? TIKTOK_MEDIA : IG_MEDIA);
    const settings = opts.settings ?? (network === "tiktok" ? { tiktokMode: "direct" } : { igType: "feed" });
    const args = variantPublishArgs({
      tenantId: co, id: variantId, accountId, body, firstComment: null, media, settings, scheduledAt: null,
    });
    const hash = opts.corruptStoredHash
      ? variantArgsSha256({ tenantId: co, id: variantId, accountId, body: `${body} (edited elsewhere)` })
      : variantArgsSha256({ tenantId: co, id: variantId, accountId, body, firstComment: null, media, settings, scheduledAt: null });
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'SMM-09 post','approved','central')`, [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, first_comment, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,'central')`,
        [variantId, co, postId, accountId, body, JSON.stringify(media), JSON.stringify(settings), hash,
          opts.status ?? "approved"],
      );
    }, MODULES);
    return { variantId, args: args as unknown as Record<string, unknown>, engagementId, accountId };
  }

  /** Run the registered entry's precondition on a live tenant transaction — the same call the
   *  executor makes, minus the claim and the advisory lock. */
  function runPrecondition(args: Record<string, unknown>, toolName = SOCIAL_PUBLISH_TOOL) {
    // Deliberately WITHOUT `{modules:['social']}`: this mirrors the executor's own transaction,
    // which opens with no module scope at all. If the precondition did not declare its own scope,
    // 0105's third RLS wall would make every read here return zero rows and every verdict would be
    // a false `variant_not_found`. That is the single sharpest trap in this module, so the test
    // that would catch it is the DEFAULT here rather than a special case.
    return withTenants([co], (c) => evaluatePublishPrecondition(c, args, toolName));
  }

  // ══ (A) registry doctrine ═══════════════════════════════════════════════════════════════════

  it("(A1) social.publishPost is registered with a REAL lockKey and precondition — not the D14-02 name-only fallback", () => {
    const entry = getExecutable(SOCIAL_PUBLISH_TOOL);
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe(SOCIAL_PUBLISH_TOOL);
    // A name-only registration's lockKey is the literal `executable-approval:<name>` constant.
    expect(entry!.lockKey({})).not.toBe(`executable-approval:${SOCIAL_PUBLISH_TOOL}`);
    expect(entry!.neverAutoRetry).toBe(true);
  });

  it("(A2) social.publishPostMetered is BARRED: absent from the executable registry, present as a bar with a typed reason", () => {
    expect(getExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBeUndefined();
    expect(isBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBe(true);
    expect(getBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toMatchObject({ reason: "metered_tool_barred" });
    expect(listBarredExecutables().map((b) => b.toolName)).toContain(SOCIAL_PUBLISH_METERED_TOOL);
  });

  it("(A3) the barred twin CANNOT be promoted into the executable registry by a later registration", () => {
    expect(() => registerExecutableApproval({ toolName: SOCIAL_PUBLISH_METERED_TOOL })).toThrow(/BARRED/i);
    // ...and it is still absent afterwards, so a swallowed throw could not leave it half-registered.
    expect(getExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBeUndefined();
  });

  it("(A4) the executable tool cannot be silently disarmed by barring it, and neither registration is idempotent-by-overwrite", () => {
    expect(() => registerBarredExecutable({ toolName: SOCIAL_PUBLISH_TOOL, reason: "x", note: "n" }))
      .toThrow(/already registered as an executable/i);
    expect(() => registerExecutableApproval({ toolName: SOCIAL_PUBLISH_TOOL })).toThrow(/already registered/i);
    expect(() => registerBarredExecutable({ toolName: SOCIAL_PUBLISH_METERED_TOOL, reason: "x", note: "n" }))
      .toThrow(/already barred/i);
    // The live entry survived all three attempts intact.
    expect(getExecutable(SOCIAL_PUBLISH_TOOL)!.neverAutoRetry).toBe(true);
  });

  it("(A5) the hub-side classification is pinned: write + impact 'high' — the two values that ARE the D14 gate", () => {
    // `write && impact !== 'low'` is what suspends an automation/agent call into WS4
    // (mcp-hub/src/policy.ts), and `automation_approvals.impact` cannot even REPRESENT a low-impact
    // write. A publish that is not 'high' is a publish that never suspends, so SMM-10 declares the
    // McpToolDef from THIS constant rather than retyping two literals.
    expect(SOCIAL_PUBLISH_TOOL_CLASSIFICATION).toEqual({ write: true, impact: "high" });
  });

  it("(A6) every refusal token maps to exactly one stage, and the stage order is the ticket's", () => {
    expect(PUBLISH_PRECONDITION_STAGES).toEqual(["scope", "quota", "hash", "unconsumed", "budget", "creator_info"]);
    const tokens = Object.values(PUBLISH_REFUSAL);
    expect(new Set(tokens).size).toBe(tokens.length); // no two names share a token
    for (const token of tokens) {
      expect(PUBLISH_PRECONDITION_STAGES).toContain(PUBLISH_REFUSAL_STAGE[token]);
      // The contract rules for a token: snake_case, no identifiers, no prose.
      expect(token).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  // ══ (B) lockKey ═════════════════════════════════════════════════════════════════════════════

  describe("(B) lockKey", () => {
    const entry = () => getExecutable(SOCIAL_PUBLISH_TOOL)!;

    it("keys on the VARIANT id when present, verbatim", () => {
      expect(entry().lockKey({ variantId: "var-123", postId: "post-9" })).toBe("var-123");
    });

    it("is a pure function of the args: the same args always give the same key (the retry requirement)", () => {
      const args = { variantId: "var-stable", body: "x" };
      expect(entry().lockKey(args)).toBe(entry().lockKey({ ...args }));
      expect(entry().lockKey({})).toBe(entry().lockKey({}));
    });

    it("keys on the VARIANT, not the post — a five-network fan-out is not serialized behind itself", () => {
      const a = entry().lockKey({ postId: "post-1", variantId: "var-ig" });
      const b = entry().lockKey({ postId: "post-1", variantId: "var-li" });
      expect(a).not.toBe(b);
    });

    it("keys on the VARIANT, not the tenant — two publishes in one agency do not serialize", () => {
      const a = entry().lockKey({ tenantId: "t-1", variantId: "var-a" });
      const b = entry().lockKey({ tenantId: "t-1", variantId: "var-b" });
      expect(a).not.toBe(b);
    });

    it("a missing/malformed variantId does NOT collapse to a single constant shared by every such call", () => {
      const missing = entry().lockKey({});
      const wrongType = entry().lockKey({ variantId: 42 });
      const empty = entry().lockKey({ variantId: "" });
      const blank = entry().lockKey({ variantId: "   " });
      expect(new Set([missing, wrongType, empty, blank]).size).toBe(4);
      for (const k of [missing, wrongType, empty, blank]) {
        expect(k).not.toBe(SOCIAL_PUBLISH_TOOL);
        expect(k).not.toBe("social");
        expect(k).not.toBe(`executable-approval:${SOCIAL_PUBLISH_TOOL}`);
      }
    });
  });

  // ══ (C) the precondition chain, stage by stage, under a live transaction ════════════════════

  describe("(C) precondition", () => {
    it("(C0) a fully healthy variant passes every stage", async () => {
      const p = await makePublishable();
      expect(await runPrecondition(p.args)).toEqual({ ok: true });
    });

    // ── stage 1: scope ────────────────────────────────────────────────────────────────────────

    it("(C1a) missing/malformed variantId fails closed as variant_not_found, without touching the DB", async () => {
      for (const bad of [{}, { variantId: 42 }, { variantId: "" }, { variantId: null }, { variantId: "   " }]) {
        expect(await runPrecondition(bad as Record<string, unknown>)).toEqual({
          ok: false, stage: "scope", reason: PUBLISH_REFUSAL.variantNotFound,
        });
      }
    });

    it("(C1b) an unknown variant id ⇒ variant_not_found, and it never confirms that some other tenant's row exists", async () => {
      expect(await runPrecondition({ variantId: newId() })).toMatchObject({
        ok: false, reason: PUBLISH_REFUSAL.variantNotFound,
      });
    });

    it("(C1c) a soft-deleted variant is treated as not found", async () => {
      const p = await makePublishable();
      await withTenants([co], (c) =>
        c.query(`UPDATE social_post_variants SET deleted_at = now() WHERE id = $1`, [p.variantId]), MODULES);
      expect(await runPrecondition(p.args)).toMatchObject({ ok: false, reason: PUBLISH_REFUSAL.variantNotFound });
    });

    it("(C1d) ⭐ the target account belongs to a DIFFERENT client than the post's engagement ⇒ cross_client_account", async () => {
      // The module's headline risk, re-derived at execution time: a mis-set accountId puts one
      // client's content on another client's public feed. Every composite FK is satisfied here —
      // both clients live in the same tenant — so only the client-level walk catches it.
      const p = await makePublishable({ accountId: foreignAccount });
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "scope", reason: PUBLISH_REFUSAL.crossClientAccount,
      });
    });

    it("(C1e) an account that is no longer connected ⇒ account_not_connected", async () => {
      const p = await makePublishable();
      await withTenants([co], (c) =>
        c.query(`UPDATE social_accounts SET status = 'expired' WHERE id = $1`, [p.accountId]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "scope", reason: PUBLISH_REFUSAL.accountNotConnected,
      });
      await withTenants([co], (c) =>
        c.query(`UPDATE social_accounts SET status = 'connected' WHERE id = $1`, [p.accountId]), MODULES);
    });

    it("(C1f) a network disabled at the DEPLOYMENT level ⇒ network_disabled, whatever the engagement scope says", async () => {
      const p = await makePublishable();
      const before = config.social.publisher.enabledNetworks;
      config.social.publisher.enabledNetworks = ["linkedin"];
      try {
        expect(await runPrecondition(p.args)).toEqual({
          ok: false, stage: "scope", reason: PUBLISH_REFUSAL.networkDisabled,
        });
      } finally {
        config.social.publisher.enabledNetworks = before;
      }
    });

    it("(C1g) the engagement's own tool_scope does not enable this network ⇒ network_not_in_scope", async () => {
      // The PER-ENGAGEMENT dial SMM-05's assertDispatchChain explicitly left for this ticket. The
      // deployment flag is ON for instagram here, so only this check can refuse.
      const engagementId = await makeEngagement({ networks: { instagram: false, linkedin: true } });
      const p = await makePublishable({ engagementId });
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "scope", reason: PUBLISH_REFUSAL.networkNotInScope,
      });
    });

    it("(C1h) an engagement that is paused/closed/draft ⇒ engagement_inactive", async () => {
      for (const status of ["paused", "closed", "draft"]) {
        const engagementId = await makeEngagement({ status });
        const p = await makePublishable({ engagementId });
        expect(await runPrecondition(p.args)).toEqual({
          ok: false, stage: "scope", reason: PUBLISH_REFUSAL.engagementInactive,
        });
      }
    });

    it("(C1i) ⭐ a METERED-network variant on the FREE tool ⇒ metered_network_requires_metered_tool — it never spends", async () => {
      // D-14's money split, belt-and-braces: the metered twin is barred from the registry, and the
      // free tool refuses a metered variant on its own. X must be enabled at BOTH the deployment and
      // the engagement level to get this far, which is exactly the misconfiguration worth catching.
      const before = config.social.publisher.enabledNetworks;
      config.social.publisher.enabledNetworks = [...before, "x"];
      try {
        const xAccount = await makeAccount(publisherOrgId, clientId, "x", uniq("x-main"));
        const engagementId = await makeEngagement({ networks: { x: true } });
        const p = await makePublishable({
          engagementId, accountId: xAccount, network: "instagram", body: "short", media: [], settings: {},
        });
        expect(await runPrecondition(p.args)).toEqual({
          ok: false, stage: "scope", reason: PUBLISH_REFUSAL.meteredNetworkRequiresMeteredTool,
        });
      } finally {
        config.social.publisher.enabledNetworks = before;
      }
    });

    // ── stage 2: quota (and the network's media/body/schedule rules) ──────────────────────────

    it("(C2a) the account's live posting quota is spent ⇒ quota_exhausted", async () => {
      const p = await makePublishable();
      await withTenants([co], (c) =>
        c.query(`UPDATE social_accounts SET quota = $2 WHERE id = $1`,
          [p.accountId, JSON.stringify({ igPosts24h: { used: 100, cap: 100 } })]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "quota", reason: PUBLISH_REFUSAL.quotaExhausted,
      });
      await withTenants([co], (c) =>
        c.query(`UPDATE social_accounts SET quota = '{}' WHERE id = $1`, [p.accountId]), MODULES);
    });

    it("(C2b) an UNKNOWN quota is a warning, never a refusal — 'we have not synced' must not read as 'the account is full'", async () => {
      // media-rules.ts's standing doctrine, re-asserted at the gate: escalating quota_unknown here
      // would make every unsynced registry look like an exhausted one and block real work.
      const p = await makePublishable();
      expect(await runPrecondition(p.args)).toEqual({ ok: true });
    });

    it("(C2c) the network's media rules failing NOW ⇒ media_rules_failed, told apart from quota_exhausted", async () => {
      // Instagram requires media. A variant whose attachment was removed between approval and
      // execution is not publishable, and saying `quota_exhausted` would send an operator to the
      // wrong investigation entirely.
      const p = await makePublishable({ media: [] });
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "quota", reason: PUBLISH_REFUSAL.mediaRulesFailed,
      });
    });

    it("(C2d) a schedule slot that has since fallen out of the network's window ⇒ media_rules_failed (the TIME-sensitivity that makes this re-check load-bearing)", async () => {
      // Facebook's native scheduling accepts 10 minutes to 30 days out. An approval filed for a slot
      // comfortably inside that window becomes invalid simply by the clock advancing past it — no
      // edit, no state change. This is the case that proves re-validating at execution is not a
      // duplicate of composer-time validation.
      const fbAccount = await makeAccount(publisherOrgId, clientId, "facebook", uniq("fb-main"));
      const engagementId = await makeEngagement({ networks: { facebook: true } });
      const postId = newId();
      const variantId = newId();
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const args = variantPublishArgs({
        tenantId: co, id: variantId, accountId: fbAccount, body: "scheduled a while ago",
        firstComment: null, media: [], settings: {}, scheduledAt: past,
      });
      await withTenants([co], async (c) => {
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site)
                       VALUES ($1,$2,$3,'fb','central')`, [postId, co, engagementId]);
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, media, settings, scheduled_at, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,'scheduled a while ago','[]','{}',$5,$6,'approved','central')`,
          [variantId, co, postId, fbAccount, past,
            variantArgsSha256({ tenantId: co, id: variantId, accountId: fbAccount, body: "scheduled a while ago", scheduledAt: past })],
        );
      }, MODULES);
      expect(await runPrecondition(args as unknown as Record<string, unknown>)).toEqual({
        ok: false, stage: "quota", reason: PUBLISH_REFUSAL.mediaRulesFailed,
      });
    });

    // ── stage 3: hash (edit-invalidates-approval, D-15) ───────────────────────────────────────

    it("(C3a) args that do not hash to the live variant ⇒ args_hash_mismatch", async () => {
      const p = await makePublishable();
      expect(await runPrecondition({ ...p.args, body: "something the human never approved" })).toEqual({
        ok: false, stage: "hash", reason: PUBLISH_REFUSAL.argsHashMismatch,
      });
    });

    it("(C3b) a stored args_sha256 that has DRIFTED from the row's content ⇒ args_hash_mismatch", async () => {
      // Catches a write path that changed content without recomputing the anchor (a direct SQL edit,
      // or a future writer that forgets). The anchor is what the client-review stage compares
      // against too, so a drifted column is a refusal, never a "close enough".
      const p = await makePublishable({ corruptStoredHash: true });
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "hash", reason: PUBLISH_REFUSAL.argsHashMismatch,
      });
    });

    it("(C3c) a field the approver never saw cannot be smuggled in: an EXTRA arg changes the hash and refuses", async () => {
      const p = await makePublishable();
      expect(await runPrecondition({ ...p.args, targetAccountOverride: "someone-else" })).toMatchObject({
        ok: false, reason: PUBLISH_REFUSAL.argsHashMismatch,
      });
    });

    // ── stage 4: unconsumed ───────────────────────────────────────────────────────────────────

    it("(C4a) a variant that already carries a provider_post_id ⇒ already_dispatched", async () => {
      const p = await makePublishable();
      await withTenants([co], (c) =>
        c.query(`UPDATE social_post_variants SET provider_post_id = 'upstream-1' WHERE id = $1`, [p.variantId]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "unconsumed", reason: PUBLISH_REFUSAL.alreadyDispatched,
      });
    });

    it("(C4b) a variant already queued/publishing/published ⇒ already_dispatched, and it OUTRANKS approval_already_consumed", async () => {
      // 0105's `svar_dispatched_has_approval` CHECK means a dispatched row STRUCTURALLY carries an
      // approval id, so both unconsumed arms are live at once here. `already_dispatched` must win:
      // "this post is already out" is the fact that stops a human from retrying, and "a grant was
      // spent" is only how we know.
      for (const status of ["queued", "publishing", "published"]) {
        const p = await makePublishable();
        const spent = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args, "not_applicable");
        await withTenants([co], (c) =>
          c.query(`UPDATE social_post_variants SET status = $2, provider_post_id = $3, approval_id = $4 WHERE id = $1`,
            [p.variantId, status, uniq(`up-${status}`), spent]), MODULES);
        expect(await runPrecondition(p.args)).toMatchObject({ ok: false, reason: PUBLISH_REFUSAL.alreadyDispatched });
      }
    });

    it("(C4c) ⭐ a variant that has already SPENT a grant ⇒ approval_already_consumed", async () => {
      const p = await makePublishable();
      const spentApproval = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args, "not_applicable");
      await withTenants([co], (c) =>
        c.query(`UPDATE social_post_variants SET approval_id = $2 WHERE id = $1`, [p.variantId, spentApproval]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "unconsumed", reason: PUBLISH_REFUSAL.approvalAlreadyConsumed,
      });
    });

    it("(C4d) a variant that is not `approved` ⇒ variant_not_approved (draft, in_review, cancelled)", async () => {
      // `failed` is deliberately absent from this list, and its absence is a SCHEMA fact rather than
      // an oversight: 0105's `svar_dispatched_has_approval` CHECK admits only
      // draft/in_review/approved/cancelled without an approval id, so a `failed` variant necessarily
      // carries one and is refused one arm earlier, as `approval_already_consumed`. A human fixes it
      // and re-files; there is no unattended second shot either way.
      for (const status of ["draft", "in_review", "cancelled"]) {
        const p = await makePublishable({ status });
        expect(await runPrecondition(p.args)).toEqual({
          ok: false, stage: "unconsumed", reason: PUBLISH_REFUSAL.variantNotApproved,
        });
      }
    });

    it("(C4e) a NATIVE IMPORT is refused as already_dispatched — it describes a post a human already made public", async () => {
      // 0105's svar_native_import_is_bookkeeping CHECK means it carries no approval and no provider
      // id; dispatching it would post the same content a SECOND time.
      const engagementId = await makeEngagement();
      const postId = newId();
      const variantId = newId();
      const args = variantPublishArgs({
        tenantId: co, id: variantId, accountId: igAccount, body: "posted by hand",
        firstComment: null, media: IG_MEDIA, settings: {}, scheduledAt: null,
      });
      await withTenants([co], async (c) => {
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site)
                       VALUES ($1,$2,$3,'native','central')`, [postId, co, engagementId]);
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, media, settings, native_import, status, origin_site)
           VALUES ($1,$2,$3,$4,'posted by hand',$5,'{}',true,'published','central')`,
          [variantId, co, postId, igAccount, JSON.stringify(IG_MEDIA)],
        );
      }, MODULES);
      expect(await runPrecondition(args as unknown as Record<string, unknown>)).toMatchObject({
        ok: false, reason: PUBLISH_REFUSAL.alreadyDispatched,
      });
    });

    // ── stage 5: budget ───────────────────────────────────────────────────────────────────────

    it("(C5a) an engagement whose monthly metered cap is already spent ⇒ budget_exceeded", async () => {
      const engagementId = await makeEngagement({ budgetUsd: 1 });
      const p = await makePublishable({ engagementId });
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO social_usage_ledger (id, tenant_id, engagement_id, kind, cost_usd, status, origin_site)
           VALUES ($1,$2,$3,'x_post',1.5,'completed','central')`, [newId(), co, engagementId]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "budget", reason: PUBLISH_REFUSAL.budgetExceeded,
      });
    });

    it("(C5b) FAILED ledger rows do not consume the cap — a spend that did not happen must not block a publish", async () => {
      const engagementId = await makeEngagement({ budgetUsd: 1 });
      const p = await makePublishable({ engagementId });
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO social_usage_ledger (id, tenant_id, engagement_id, kind, cost_usd, status, origin_site)
           VALUES ($1,$2,$3,'x_post',9.99,'failed','central')`, [newId(), co, engagementId]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({ ok: true });
    });

    it("(C5c) a corrupted (non-numeric) budget fails CLOSED, never as 'unlimited'", async () => {
      const engagementId = await makeEngagement();
      const p = await makePublishable({ engagementId });
      await withTenants([co], (c) =>
        c.query(`UPDATE social_engagements SET usage_budget_usd = 'NaN' WHERE id = $1`, [engagementId]), MODULES);
      expect(await runPrecondition(p.args)).toEqual({
        ok: false, stage: "budget", reason: PUBLISH_REFUSAL.budgetExceeded,
      });
    });

    // ── stage 6: creator-info (D-22) ──────────────────────────────────────────────────────────

    describe("(C6) D-22 · TikTok creator consent, re-verified at dispatch", () => {
      let tiktokAccount: string;
      let networksBefore: string[];

      beforeEach(async () => {
        networksBefore = config.social.publisher.enabledNetworks;
        config.social.publisher.enabledNetworks = [...networksBefore, "tiktok"];
        tiktokAccount = await makeAccount(publisherOrgId, clientId, "tiktok", uniq("tt"));
      });
      afterEach(() => {
        config.social.publisher.enabledNetworks = networksBefore;
        resetCreatorInfoVerifier();
      });

      async function tiktokVariant(): Promise<Publishable> {
        const engagementId = await makeEngagement({ networks: { tiktok: true } });
        return makePublishable({ engagementId, accountId: tiktokAccount, network: "tiktok" });
      }

      it("(C6a) ⭐ GOLDEN CASE — no creator-info verification available ⇒ creator_info_unverified, FAIL CLOSED", async () => {
        // TikTok requires consent immediately before upload; we approve at T and publish at T+hours.
        // D-22's answer is that the composer's selections ARE the consent AND creator_info is
        // re-verified at dispatch. Until SMM-10 installs that verifier, "we could not check" must
        // never read as "the creator still agrees" — so an unverifiable TikTok publish refuses.
        // Every earlier stage has already passed here, which is what makes this a real branch and
        // not an artefact of TikTok being disabled.
        const p = await tiktokVariant();
        expect(await runPrecondition(p.args)).toEqual({
          ok: false, stage: "creator_info", reason: PUBLISH_REFUSAL.creatorInfoUnverified,
        });
      });

      it("(C6b) ⭐ GOLDEN CASE — the creator's live settings no longer permit the APPROVED selections ⇒ creator_selection_no_longer_permitted", async () => {
        const p = await tiktokVariant();
        setCreatorInfoVerifier(async () => ({
          ok: false, reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted,
        }));
        expect(await runPrecondition(p.args)).toEqual({
          ok: false, stage: "creator_info", reason: PUBLISH_REFUSAL.creatorSelectionNoLongerPermitted,
        });
      });

      it("(C6c) the verifier is handed the APPROVED selections and the dispatch target — never asked about content it cannot see", async () => {
        const p = await tiktokVariant();
        const seen: unknown[] = [];
        setCreatorInfoVerifier(async (_c, ctx) => { seen.push(ctx); return { ok: true }; });
        expect(await runPrecondition(p.args)).toEqual({ ok: true });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          variantId: p.variantId, accountId: tiktokAccount, network: "tiktok",
          publisherOrgId, settings: { tiktokMode: "direct" },
        });
      });

      it("(C6d) the creator-info stage runs LAST — an earlier refusal is reported instead, and the verifier is never consulted", async () => {
        // Ordering matters for a human reading the refusal: 'the engagement is closed' is a more
        // actionable answer than 'we could not re-check TikTok consent', and asking a creator's
        // settings about a publish that was never allowed is work nobody needs done.
        const engagementId = await makeEngagement({ status: "paused", networks: { tiktok: true } });
        const p = await makePublishable({ engagementId, accountId: tiktokAccount, network: "tiktok" });
        let consulted = 0;
        setCreatorInfoVerifier(async () => { consulted += 1; return { ok: true }; });
        expect(await runPrecondition(p.args)).toMatchObject({ reason: PUBLISH_REFUSAL.engagementInactive });
        expect(consulted).toBe(0);
      });

      it("(C6e) a NON-consent-at-upload network never consults the verifier at all", async () => {
        const p = await makePublishable(); // instagram
        let consulted = 0;
        setCreatorInfoVerifier(async () => { consulted += 1; return { ok: true }; });
        expect(await runPrecondition(p.args)).toEqual({ ok: true });
        expect(consulted).toBe(0);
      });
    });
  });

  // ── filing helper, shared by the executor blocks below ──────────────────────────────────────

  async function fileDecided(
    toolName: string,
    toolArgs: Record<string, unknown>,
    executionStatus: "pending" | "not_applicable" = "pending",
  ): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery',$3,$4,'high','approved',$5,$5,now(),'automation','main',$6)`,
        [id, co, toolName, JSON.stringify(toolArgs), wfUser, executionStatus],
      ),
    );
    return id;
  }

  async function rowOf(id: string) {
    const r = await adminPool().query(
      `SELECT execution_status, execution_error, execution_attempts FROM automation_approvals WHERE id = $1`, [id]);
    return r.rows[0];
  }

  // ══ (D)–(G) through the REAL executor ═══════════════════════════════════════════════════════

  describe("through the executor (executeApprovedAutomationWrite)", () => {
    let hubCalls: Array<{ url: string; tool: string }> = [];
    const realFetch = globalThis.fetch;

    function installHubStub(fail = false): void {
      hubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.smm09.test")) return realFetch(url as any, init);
        const tool = JSON.parse(String(init?.body ?? "{}"))?.params?.name ?? "";
        hubCalls.push({ url: String(url), tool });
        // A THROWN fetch is the AMBIGUOUS failure: the request may or may not have reached the hub,
        // and if it did, the tool may or may not have run. `callHubTool` maps it to `transport`,
        // which the executor records as `hub_unreachable` — "no verdict was obtained".
        if (fail) throw new Error("connection reset");
        return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {}\n\n" };
      });
      vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    }

    beforeEach(() => installHubStub());
    afterEach(() => vi.restoreAllMocks());

    // ── (D) a stale precondition never reaches the hub ────────────────────────────────────────

    it("(D1) an approved publish for a CLOSED engagement ends failed with precondition_failed:engagement_inactive, and the hub is called ZERO times", async () => {
      const engagementId = await makeEngagement({ status: "closed" });
      const p = await makePublishable({ engagementId });
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("failed");
      expect(outcome).toMatchObject({ error: `precondition_failed: ${PUBLISH_REFUSAL.engagementInactive}` });
      // Asserted on the call count the stub recorded — not inferred from the outcome.
      expect(hubCalls).toHaveLength(0);
      const row = await rowOf(id);
      expect(row.execution_status).toBe("failed");
      expect(row.execution_error).toBe(`precondition_failed: ${PUBLISH_REFUSAL.engagementInactive}`);
    });

    it("(D2) ⭐ an approved publish onto ANOTHER CLIENT's account ends failed with precondition_failed:cross_client_account, and the hub is called ZERO times", async () => {
      const p = await makePublishable({ accountId: foreignAccount });
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${PUBLISH_REFUSAL.crossClientAccount}` });
      expect(hubCalls).toHaveLength(0);
    });

    it("(D3) a publish with no variantId at all ends failed with precondition_failed:variant_not_found, and the hub is called ZERO times", async () => {
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, { tenantId: co, body: "orphaned" });
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${PUBLISH_REFUSAL.variantNotFound}` });
      expect(hubCalls).toHaveLength(0);
    });

    it("(D4) ⭐ THE POSITIVE CONTROL, and the RLS proof: a healthy approved publish DOES call the hub exactly once", async () => {
      // If the precondition failed to declare its own `app.scopes` module scope, 0105's third RLS
      // wall would make every social read return zero rows on the executor's module-less transaction
      // and THIS test would fail with `variant_not_found` — which is exactly why it is worth having.
      const p = await makePublishable();
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
      expect(hubCalls[0].tool).toBe(SOCIAL_PUBLISH_TOOL);
    });

    // ── (E) edit-invalidates-approval ─────────────────────────────────────────────────────────

    it("(E1) ⭐ EDITING THE VARIANT INVALIDATES ITS APPROVAL: the hash moves, so the approved publish refuses and the hub is called ZERO times", async () => {
      const p = await makePublishable();
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);

      // The composer's own edit statement, verbatim in effect (social.controller.ts#updateVariant):
      // new content, a RECOMPUTED anchor, the approval dropped and the status reverted — all in one
      // statement, so there is no window in which an approval points at content nobody approved.
      const editedBody = "a caption nobody approved";
      await withTenants([co], (c) =>
        c.query(
          `UPDATE social_post_variants
              SET body = $2, args_sha256 = $3, approval_id = NULL,
                  status = CASE WHEN status IN ('in_review','approved') THEN 'draft' ELSE status END,
                  updated_at = now()
            WHERE id = $1`,
          [p.variantId, editedBody,
            variantArgsSha256({
              tenantId: co, id: p.variantId, accountId: p.accountId, body: editedBody,
              firstComment: null, media: IG_MEDIA, settings: { igType: "feed" }, scheduledAt: null,
            })],
        ), MODULES);

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${PUBLISH_REFUSAL.argsHashMismatch}` });
      expect(hubCalls).toHaveLength(0);
    });

    it("(E2) the invalidation is structural, not policed: it holds for an edit that changes only the SETTINGS", async () => {
      const p = await makePublishable();
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);
      await withTenants([co], (c) =>
        c.query(
          `UPDATE social_post_variants SET settings = $2, args_sha256 = $3 WHERE id = $1`,
          [p.variantId, JSON.stringify({ igType: "story" }),
            variantArgsSha256({
              tenantId: co, id: p.variantId, accountId: p.accountId, body: "Hello from the publish gate",
              firstComment: null, media: IG_MEDIA, settings: { igType: "story" }, scheduledAt: null,
            })],
        ), MODULES);

      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${PUBLISH_REFUSAL.argsHashMismatch}` });
      expect(hubCalls).toHaveLength(0);
    });

    // ── (F) replay refused ────────────────────────────────────────────────────────────────────

    it("(F1) ⭐ REPLAY REFUSED (approval side): the same approval executed twice calls the hub exactly ONCE", async () => {
      const p = await makePublishable();
      const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);

      expect(await executeApprovedAutomationWrite(co, id)).toMatchObject({ status: "executed" });
      expect(hubCalls).toHaveLength(1);

      // A redelivered `automation_approval.decided`, or D14-07's retry firing on a terminal row: the
      // single-use claim (`execution_status='pending'` in the UPDATE's WHERE clause) has nothing left
      // to win, so this is a silent no-op — never a second public post.
      expect(await executeApprovedAutomationWrite(co, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);
    });

    it("(F2) ⭐ REPLAY REFUSED (domain side): a SECOND approval filed for a variant that already spent one refuses, hub called ZERO times", async () => {
      // The claim above protects one approval row against itself. This is the other half, and it is
      // the one that matters for a re-filed proposal: the VARIANT records that a grant was already
      // spent on it, so a fresh, perfectly valid, never-executed approval for the same content still
      // cannot publish it twice.
      const p = await makePublishable();
      const first = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);
      expect(await executeApprovedAutomationWrite(co, first)).toMatchObject({ status: "executed" });
      expect(hubCalls).toHaveLength(1);

      // SMM-10's dispatch stamps `approval_id` + `provider_post_id` together, in one transaction.
      await withTenants([co], (c) =>
        c.query(
          `UPDATE social_post_variants SET approval_id = $2, provider_post_id = $3, status = 'queued' WHERE id = $1`,
          [p.variantId, first, `upstream-${p.variantId.slice(0, 8)}`]), MODULES);

      const second = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);
      const outcome = await executeApprovedAutomationWrite(co, second);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${PUBLISH_REFUSAL.alreadyDispatched}` });
      expect(hubCalls).toHaveLength(1);
    });

    it("(F3) the barred twin: an approved social.publishPostMetered row can NEVER execute", async () => {
      const p = await makePublishable();
      // Even in the state a bug elsewhere would have to produce — `execution_status='pending'`, which
      // neither decide surface can compute for an unregistered tool — the executor fails closed
      // because `getExecutable()` is the ONLY source of a lockKey/precondition pair and it is
      // undefined for a barred name.
      const id = await fileDecided(SOCIAL_PUBLISH_METERED_TOOL, p.args);
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome.status).toBe("failed");
      expect(outcome).toMatchObject({ error: expect.stringContaining("not_executable") });
      expect(hubCalls).toHaveLength(0);
    });

    it("(F4) the barred twin filed the way the decide surface WOULD file it stays not_applicable forever", async () => {
      const p = await makePublishable();
      const id = await fileDecided(SOCIAL_PUBLISH_METERED_TOOL, p.args, "not_applicable");
      // This is what `AutomationApprovalsController.decide()` computes for it: `getExecutable()`
      // returns undefined for a barred tool, so `executionStatus` is 'not_applicable'.
      expect((await rowOf(id)).execution_status).toBe("not_applicable");
      expect(await executeApprovedAutomationWrite(co, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(0);
    });

    // ── (G) no auto-retry on an ambiguous failure ─────────────────────────────────────────────

    describe("(G) an AMBIGUOUS failure is never auto-retried", () => {
      beforeEach(async () => {
        installHubStub(true);
        // The tenant has deliberately turned auto-retry ON, at the maximum the platform allows.
        await withTenants([co], (c) =>
          c.query(
            `UPDATE companies
                SET settings = jsonb_set(jsonb_set(coalesce(settings,'{}'::jsonb), '{automation}',
                      coalesce(settings->'automation','{}'::jsonb), true),
                      '{automation,approvalRetry}', '{"autoRetryCount": 3}'::jsonb, true)
              WHERE id = $1`, [co]));
      });
      afterEach(async () => {
        await withTenants([co], (c) =>
          c.query(`UPDATE companies SET settings = settings - 'automation' WHERE id = $1`, [co]));
      });

      it("(G1) ⭐ a publish whose outcome is UNKNOWN is tried exactly ONCE and surfaces for a human — even with autoRetryCount=3", async () => {
        // The post may ALREADY be on a client's public feed. An unattended second attempt is a
        // coin-flip on a duplicate public post, and the platform cannot observe which way it landed
        // — so it stops, records the ambiguity, and notifies. D14-07's retry endpoint (a HUMAN
        // decision, re-taking the lock and re-running this precondition) is the only way forward.
        const p = await makePublishable();
        const id = await fileDecided(SOCIAL_PUBLISH_TOOL, p.args);

        const outcome = await executeApprovedAutomationWrite(co, id);

        expect(outcome.status).toBe("failed");
        expect(outcome).toMatchObject({ error: expect.stringContaining("hub_unreachable") });
        expect(hubCalls.filter((h) => h.tool === SOCIAL_PUBLISH_TOOL)).toHaveLength(1);
        const row = await rowOf(id);
        expect(row.execution_status).toBe("failed");
        expect(row.execution_attempts).toBe(1);
      });

      it("(G2) THE CONTROL: the same tenant setting DOES drive auto-retry for deploy.staging — so (G1) is the entry's policy, not a broken setting", async () => {
        // Without this, (G1) would pass just as happily if `autoRetryCount` were being ignored
        // entirely, and the test would prove nothing about `neverAutoRetry`.
        const runId = newId();
        await withTenants([co], (c) =>
          c.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1,$2,'delivery_active','main')`,
            [runId, co]));
        const id = await fileDecided("deploy.staging", { runId, repo: "acme/site" });

        const outcome = await executeApprovedAutomationWrite(co, id);

        expect(outcome.status).toBe("failed");
        // 1 initial attempt + 3 auto-retries.
        expect(hubCalls.filter((h) => h.tool === "deploy.staging")).toHaveLength(4);
        expect((await rowOf(id)).execution_attempts).toBe(4);
      });
    });
  });
});
