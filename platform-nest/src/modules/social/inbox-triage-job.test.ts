// SMM-16 — `inbox-triage-job.ts` against a live Postgres. No Nest app, no hub, no Cerbos — mirrors
// `inbox-sync-job.test.ts`'s own split.
//
// ── ⚠ THE CROSS-CLIENT LEAK TEST — the assertion the ticket named as mattering most ───────────────
// (T1)/(T1b) classify two threads belonging to two DIFFERENT clients in the SAME tenant, in the
// SAME sweep, and prove the gateway call for each thread's own prompt contains ONLY that thread's
// own comment text — never the other client's. This proves the thing SMM-19/SMM-23 both had to
// prove for their own AI surfaces: a classifier that could see another client's comments is the
// worst defect this module can ship, and this file is the one place that risk actually lives for
// SMM-16 (there is no WS8 retrieval step here to be a second leak boundary — see `ai-drafts.ts`'s
// own header on `TriageGroundingFacts`).
//
// ── THE MODULE-GUC REGRESSION TESTS ─────────────────────────────────────────────────────────────────
// Every write path below (classification write, SLA refresh, SLA breach, spike detection) declares
// its own module scope. (T2)/(T6)/(T7)/(T9) each call the relevant function on a transaction with NO
// `{modules:['social']}` option and assert a REAL row changed — the same shape this module's other
// jobs use, because "0 rows changed" is exactly what a silently-dropped module scope looks like.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../config";
import { newId, withTenants, withGlobal } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import {
  classifyOneThread, pullTenantInboxTriage, runTenantSlaGuard, runTenantSpikeDetection,
} from "./inbox-triage-job";
import type { Network } from "./media-rules";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm16-triage-${label}-${++seq}`;

async function makeTenant(name: string): Promise<string> {
  return createCompany(name, ["social"]);
}

async function makeClient(tenant: string): Promise<string> {
  const clientId = newId();
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'triage client','central')`, [clientId, tenant]));
  return clientId;
}

async function makeAccount(tenant: string, clientId: string, network: Network): Promise<string> {
  const orgId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
      [orgId, tenant, clientId, uniq("org")]), MODULES);
  const accountId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,'connected','{}','central')`,
      [accountId, tenant, clientId, orgId, network, uniq("@brand")]), MODULES);
  return accountId;
}

/** An engagement with a given `tool_scope.inbox.slaMinutes` (or none, when `slaMinutes` is null) —
 *  0105's own example shape, never a number this test (or the job) invents. */
async function makeEngagement(tenant: string, clientId: string, slaMinutes: number | null): Promise<string> {
  const engagementId = newId();
  const toolScope = slaMinutes === null ? {} : { inbox: { enabled: true, slaMinutes } };
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'triage engagement','active',$4,10,'central')`,
      [engagementId, tenant, clientId, JSON.stringify(toolScope)]), MODULES);
  return engagementId;
}

async function makeEngagementOwner(tenant: string, email: string): Promise<string> {
  const userId = newId();
  await withGlobal((c) =>
    c.query(`INSERT INTO users (id, email, name, kind, origin_site) VALUES ($1,$2,'Triage Owner','employee','central')`, [userId, email]));
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO company_memberships (id, tenant_id, user_id, status, origin_site) VALUES ($1,$2,$3,'active','central')`,
      [newId(), tenant, userId]));
  return userId;
}

async function setEngagementOwner(tenant: string, engagementId: string, ownerId: string): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(`UPDATE social_engagements SET owner_id = $1 WHERE id = $2`, [ownerId, engagementId]), MODULES);
}

/** A published post + variant under `engagementId`, and returns the variant id — the chain
 *  `refreshThreadSla`/the breach notifier walk to find an engagement for a thread.
 *  `svar_dispatched_has_approval` (0105) requires a real `approval_id` for any non-draft, non-
 *  native-import variant — mirrors `inbox-sync-job.test.ts#makePublishedVariant`'s own seed shape. */
async function makePublishedVariant(tenant: string, engagementId: string, accountId: string): Promise<string> {
  const postId = newId();
  const variantId = newId();
  const approvalId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(
      `INSERT INTO automation_approvals
         (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
      [approvalId, tenant]);
    await c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
       VALUES ($1,$2,$3,'triage post','published','central')`, [postId, tenant, engagementId]);
    await c.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id, status, published_at, origin_site)
       VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,'published', now() - interval '1 day', 'central')`,
      [variantId, tenant, postId, accountId, approvalId],
    );
  }, MODULES);
  return variantId;
}

interface ThreadOpts {
  postVariantId?: string;
  lastMessageAt?: Date;
  slaDueAt?: Date | null;
  slaAlertedAt?: Date | null;
  status?: string;
}

async function makeThread(tenant: string, accountId: string, network: Network, opts: ThreadOpts = {}): Promise<string> {
  const threadId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_inbox_threads
         (id, tenant_id, account_id, network, kind, external_thread_id, post_variant_id, status,
          last_message_at, sla_due_at, sla_alerted_at, origin_site)
       VALUES ($1,$2,$3,$4,'comment',$5,$6,$7,$8,$9,$10,'central')`,
      [
        threadId, tenant, accountId, network, uniq("thread"), opts.postVariantId ?? null,
        opts.status ?? "open", opts.lastMessageAt ?? new Date(), opts.slaDueAt ?? null, opts.slaAlertedAt ?? null,
      ],
    ), MODULES);
  return threadId;
}

async function addMessage(tenant: string, threadId: string, body: string, postedAt: Date): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_inbox_messages (tenant_id, thread_id, direction, external_id, body, posted_at, source, origin_site)
       VALUES ($1,$2,'in',$3,$4,$5,'direct_sync','central')`,
      [tenant, threadId, uniq("msg"), body, postedAt],
    ), MODULES);
}

async function readThread(tenant: string, threadId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT sentiment, category, urgency, ai_triage_status AS "aiTriageStatus", ai_triage_at AS "aiTriageAt",
              sla_due_at AS "slaDueAt", sla_alerted_at AS "slaAlertedAt"
         FROM social_inbox_threads WHERE id = $1`,
      [threadId],
    ), MODULES);
  return rows[0];
}

/** A fake gateway: records every prompt it was asked to complete, and returns a fixed classification
 *  keyed by a marker string embedded in the prompt (never a shared module-level mock — see this
 *  module's own recurring defect class #7 — this is a fresh closure per test). */
function fakeGateway(reply: { sentiment: string; category: string; urgency: string } | "unavailable") {
  const prompts: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt: string };
    prompts.push(body.prompt);
    if (reply === "unavailable") {
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ text: JSON.stringify(reply) }) } as Response;
  }) as unknown as typeof fetch;
  return { prompts, gatewayOpts: { gatewayUrl: "https://gw.test", gatewayToken: "tok", fetchImpl } };
}

describe.skipIf(!TEST_URL)("SMM-16 · inbox-triage-job", () => {
  let A: string;

  beforeAll(async () => {
    await initTestDb();
    A = await makeTenant("SMM-16 Triage Agency");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // ══ (T1)/(T1b) ⭐⭐ THE CROSS-CLIENT LEAK TEST ═══════════════════════════════════════════════════

  it("(T1) CROSS-CLIENT LEAK TEST: classifying client A's thread never sends client B's comment text to the gateway", async () => {
    const clientA = await makeClient(A);
    const clientB = await makeClient(A);
    const accountA = await makeAccount(A, clientA, "linkedin");
    const accountB = await makeAccount(A, clientB, "instagram");
    const threadA = await makeThread(A, accountA, "linkedin");
    const threadB = await makeThread(A, accountB, "instagram");
    await addMessage(A, threadA, "CLIENT_A_SECRET: this coffee blend is amazing", new Date());
    await addMessage(A, threadB, "CLIENT_B_SECRET: your shipping was terrible", new Date());

    const { prompts, gatewayOpts } = fakeGateway({ sentiment: "positive", category: "praise", urgency: "low" });
    await classifyOneThread(A, { threadId: threadA, network: "linkedin", engagementName: null }, new Date(), gatewayOpts);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("CLIENT_A_SECRET");
    expect(prompts[0]).not.toContain("CLIENT_B_SECRET"); // the leak this ticket exists to prevent
  });

  it("(T1b) ...and the same holds in reverse, and across a REAL sweep with both threads eligible at once", async () => {
    const clientA = await makeClient(A);
    const clientB = await makeClient(A);
    const accountA = await makeAccount(A, clientA, "linkedin");
    const accountB = await makeAccount(A, clientB, "instagram");
    const threadA = await makeThread(A, accountA, "linkedin");
    const threadB = await makeThread(A, accountB, "instagram");
    await addMessage(A, threadA, "ONLY_A_TEXT: love the new packaging", new Date());
    await addMessage(A, threadB, "ONLY_B_TEXT: when is my refund arriving", new Date());

    const { prompts, gatewayOpts } = fakeGateway({ sentiment: "neutral", category: "question", urgency: "normal" });
    const result = await pullTenantInboxTriage(A, new Date(), gatewayOpts);
    expect(result.attempted).toBeGreaterThanOrEqual(2);

    // Every prompt that mentions one marker never mentions the other — no batching across threads.
    const promptsWithA = prompts.filter((p) => p.includes("ONLY_A_TEXT"));
    const promptsWithB = prompts.filter((p) => p.includes("ONLY_B_TEXT"));
    expect(promptsWithA.length).toBeGreaterThan(0);
    expect(promptsWithB.length).toBeGreaterThan(0);
    for (const p of promptsWithA) expect(p).not.toContain("ONLY_B_TEXT");
    for (const p of promptsWithB) expect(p).not.toContain("ONLY_A_TEXT");
  });

  // ══ (T2) ⭐ THE MODULE-GUC REGRESSION TEST — classification write ═══════════════════════════════

  it("(T2) ⭐ a classification write reads/writes a REAL row through a caller-side transaction with NO module scope — fails if declareSocialModuleScope is ever removed", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const threadId = await makeThread(A, accountId, "linkedin");
    await addMessage(A, threadId, "a perfectly ordinary comment", new Date());

    const { gatewayOpts } = fakeGateway({ sentiment: "positive", category: "praise", urgency: "low" });
    const outcome = await classifyOneThread(A, { threadId, network: "linkedin", engagementName: null }, new Date(), gatewayOpts);
    expect(outcome.classified).toBe(true);

    const thread = await readThread(A, threadId);
    expect(thread.aiTriageStatus).toBe("classified");
    expect(thread.sentiment).toBe("positive");
    expect(thread.category).toBe("praise");
    expect(thread.urgency).toBe("low");
    expect(thread.aiTriageAt).not.toBeNull();
  });

  // ══ (T3) UNAVAILABLE ≠ A GUESS — the ticket's own named distinction ═══════════════════════════

  it("(T3) a gateway failure writes 'unavailable', never a guessed sentiment/category/urgency", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const threadId = await makeThread(A, accountId, "linkedin");
    await addMessage(A, threadId, "does this even work", new Date());

    const { gatewayOpts } = fakeGateway("unavailable");
    const outcome = await classifyOneThread(A, { threadId, network: "linkedin", engagementName: null }, new Date(), gatewayOpts);
    expect(outcome.classified).toBe(false);

    const thread = await readThread(A, threadId);
    expect(thread.aiTriageStatus).toBe("unavailable");
    expect(thread.sentiment).toBeNull();
    expect(thread.category).toBeNull();
    expect(thread.urgency).toBeNull();
    expect(thread.aiTriageAt).not.toBeNull(); // an ATTEMPT happened — distinct from 'unclassified'
  });

  it("(T4) UNCLASSIFIED ≠ UNAVAILABLE — a thread with no messages yet is left untouched, not marked unavailable", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const threadId = await makeThread(A, accountId, "linkedin");
    // No messages added.

    const { gatewayOpts } = fakeGateway({ sentiment: "positive", category: "praise", urgency: "low" });
    const outcome = await classifyOneThread(A, { threadId, network: "linkedin", engagementName: null }, new Date(), gatewayOpts);
    expect(outcome.classified).toBe(false);

    const thread = await readThread(A, threadId);
    expect(thread.aiTriageStatus).toBe("unclassified"); // never touched, never 'unavailable'
    expect(thread.aiTriageAt).toBeNull();
  });

  // ══ (T5) SHAPE CHECK — the structural three(+one)-fact guarantee ═══════════════════════════════

  it("(T5) the database itself refuses a 'classified' row with no sentiment (sit_triage_shape), independent of any application code", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO social_inbox_threads
             (tenant_id, account_id, network, kind, external_thread_id, status, ai_triage_status)
           VALUES ($1,$2,'linkedin','comment',$3,'open','classified')`,
          [A, accountId, uniq("shape-thread")],
        ), MODULES),
    ).rejects.toThrow(/sit_triage_shape/);
  });

  // ══ (T6) ⭐ MODULE-GUC REGRESSION — SLA refresh ═════════════════════════════════════════════════

  it("(T6) ⭐ refreshThreadSla sets sla_due_at from the engagement's OWN tool_scope.inbox.slaMinutes, on a transaction with no module scope passed at the call site", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const engagementId = await makeEngagement(A, clientId, 240); // 4h — 0105's own example number
    const variantId = await makePublishedVariant(A, engagementId, accountId);
    const lastMessageAt = new Date("2026-08-20T10:00:00.000Z");
    const threadId = await makeThread(A, accountId, "linkedin", { postVariantId: variantId, lastMessageAt });

    // runTenantSlaGuard declares its OWN module scope internally (see the file's header) — this call
    // site passes none, exactly like inbox-sync-job.test.ts's (T1).
    await runTenantSlaGuard(A, new Date());

    const thread = await readThread(A, threadId);
    expect(new Date(thread.slaDueAt).toISOString()).toBe(new Date("2026-08-20T14:00:00.000Z").toISOString());
  });

  it("(T6b) NO INVENTED THRESHOLD — an engagement with no tool_scope.inbox.slaMinutes gets no sla_due_at at all", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const engagementId = await makeEngagement(A, clientId, null); // no slaMinutes configured
    const variantId = await makePublishedVariant(A, engagementId, accountId);
    const threadId = await makeThread(A, accountId, "linkedin", { postVariantId: variantId, lastMessageAt: new Date() });

    await runTenantSlaGuard(A, new Date());

    const thread = await readThread(A, threadId);
    expect(thread.slaDueAt).toBeNull(); // never a fallback duration invented to give it one
  });

  // ══ (T7) ⭐ MODULE-GUC REGRESSION — SLA breach detection + notification ════════════════════════

  it("(T7) ⭐ a thread past its own sla_due_at is marked alerted exactly once per breach, on a transaction with no module scope passed at the call site", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const engagementId = await makeEngagement(A, clientId, 60);
    const ownerId = await makeEngagementOwner(A, `${uniq("owner")}@example.com`);
    await setEngagementOwner(A, engagementId, ownerId);
    const variantId = await makePublishedVariant(A, engagementId, accountId);
    // `runTenantSlaGuard` REFRESHES `sla_due_at` from the engagement's own `slaMinutes` before
    // checking for breaches (see the header on why: a fresh comment restarts the clock) — seeding
    // `sla_due_at` directly would be overwritten by that refresh. Seed `last_message_at` far enough
    // in the past instead: 60 slaMinutes ago = 2h ago means the refreshed due date (last_message_at
    // + 60min = 1h ago) is ALREADY breached.
    const threadId = await makeThread(A, accountId, "linkedin", {
      postVariantId: variantId, lastMessageAt: new Date(Date.now() - 2 * 3600_000),
    });

    const result = await runTenantSlaGuard(A, new Date());
    expect(result.breaches).toBeGreaterThanOrEqual(1);
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const thread = await readThread(A, threadId);
    expect(thread.slaAlertedAt).not.toBeNull();

    // Re-running immediately does NOT re-notify the SAME breach (sla_alerted_at >= sla_due_at).
    const second = await runTenantSlaGuard(A, new Date());
    expect(second.notified).toBe(0);
  });

  it("(T7b) a thread whose SLA has NOT yet passed is left alone", async () => {
    const clientId = await makeClient(A);
    const accountId = await makeAccount(A, clientId, "linkedin");
    const engagementId = await makeEngagement(A, clientId, 60);
    const variantId = await makePublishedVariant(A, engagementId, accountId);
    // `last_message_at` defaults to "now" (see `makeThread`) — refreshed due date = now + 60min,
    // comfortably in the future. `sla_due_at` is not seeded directly; see (T7)'s own comment on why.
    const threadId = await makeThread(A, accountId, "linkedin", { postVariantId: variantId });

    await runTenantSlaGuard(A, new Date());
    const thread = await readThread(A, threadId);
    expect(thread.slaAlertedAt).toBeNull();
  });

  // ══ (T8) SPIKE DETECTION — config-driven, no invented business number ══════════════════════════

  // `runTenantSpikeDetection` scans EVERY connected account in the tenant, so each of these gets its
  // OWN fresh tenant — reusing the shared `A` (which by this point in file-declaration order already
  // holds several other tests' connected accounts/threads) would let an EARLIER test's burst count
  // toward THIS test's result, exactly this module's own recurring defect class #7 (shared state
  // polluting across `it()`s in file order), just at the fixture layer instead of a `vi.fn()`.

  it("(T8) a burst of recent comments against a near-zero baseline is a spike, above the configured absolute floor", async () => {
    const T = await makeTenant("SMM-16 Spike T8");
    const clientId = await makeClient(T);
    const accountId = await makeAccount(T, clientId, "linkedin");
    await makeEngagement(T, clientId, 240);
    const threadId = await makeThread(T, accountId, "linkedin");

    const minRecent = config.social.triage.slaGuard.spikeMinRecentCount;
    // Comfortably above the floor, all inside the recent window, none in the baseline window.
    for (let i = 0; i < minRecent + 3; i += 1) {
      await addMessage(T, threadId, `burst comment ${i}`, new Date(Date.now() - 60_000));
    }

    const result = await runTenantSpikeDetection(T, new Date());
    expect(result.spikes).toBeGreaterThanOrEqual(1);
  });

  it("(T8b) ordinary, below-floor volume on a brand-new account is NOT a spike", async () => {
    const T = await makeTenant("SMM-16 Spike T8b");
    const clientId = await makeClient(T);
    const accountId = await makeAccount(T, clientId, "linkedin");
    await makeEngagement(T, clientId, 240);
    const threadId = await makeThread(T, accountId, "linkedin");
    await addMessage(T, threadId, "a single ordinary comment", new Date());

    const result = await runTenantSpikeDetection(T, new Date());
    expect(result.spikes).toBe(0);
  });

  // ══ (T9) ⭐ MODULE-GUC REGRESSION — spike detection ════════════════════════════════════════════

  it("(T9) ⭐ spike detection reads through a transaction with no module scope passed at the call site — fails (0 spikes on a real burst) if declareSocialModuleScope is ever removed", async () => {
    const T = await makeTenant("SMM-16 Spike T9");
    const clientId = await makeClient(T);
    const accountId = await makeAccount(T, clientId, "linkedin");
    await makeEngagement(T, clientId, 240);
    const threadId = await makeThread(T, accountId, "linkedin");
    const minRecent = config.social.triage.slaGuard.spikeMinRecentCount;
    for (let i = 0; i < minRecent + 5; i += 1) {
      await addMessage(T, threadId, `burst ${i}`, new Date());
    }
    const result = await runTenantSpikeDetection(T, new Date());
    expect(result.spikes).toBeGreaterThanOrEqual(1); // would read 0 accounts/0 spikes if scope were dropped
  });
});
