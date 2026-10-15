// PV7-02 — the hub overview's BALL (`needsUs` and `needsClient`), pinned before it moves.
//
// WHY THIS FILE EXISTS. The two lists are about to leave `clients.controller.ts` (`clientOverview`) for
// `client-ball.ts`, rewritten as set-based reads over `clientIds[]` so the health board can ask for 71 clients
// in a fixed number of queries (BFF §54). The hub overview calls the new code for ONE client and its output must
// not change by a single field. This suite pins the OLD output on a fixed fixture, over HTTP, through the real
// route. It was committed and run green BEFORE the refactor; the refactor commit adds the second describe below.
//
// WHAT IS PINNED. Every item of both lists, in order, with every field: `kind`, `id`, `label`, `context`, `href`,
// `since` and `clientVisible`. Every `since` is an explicit timestamp written by the fixture (never `now()`), so
// the expectation is an exact `toEqual`, not a shape check. The fixture reaches each branch of each list and a row
// that must NOT appear for each (another client's row, a soft-deleted row, a thread we already answered, an
// internal gate, a decided gate), so "everything" and "nothing" both fail.
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise: check the skip count). Runs on the Linux CI
// gate, not on the laptop.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { variantArgsSha256 } from "../social/canonical-args";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { FIXTURE_TERMS, FIXTURE_TERMS_SHA256 } from "../../testing/contract-fixtures";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { createIssuedInvoice, ensureBillingSetup } from "../../seed/billing-setup";
import { staffThreadHref } from "../../core/conversation-notify";
import { loadClientBall, toHubItem } from "./client-ball";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };
const site = () => config.originSite;

/** A fixed instant on day `d` of September 2026, in the JSON form the route returns. */
const at = (d: number) => `2026-09-${String(d).padStart(2, "0")}T10:00:00.000Z`;

interface Item { kind: string; id: string; label: string; context: string; href: string; since: string; clientVisible: boolean }
const item = (kind: string, id: string, label: string, context: string, href: string, since: string, clientVisible: boolean): Item =>
  ({ kind, id, label, context, href, since, clientVisible });

describe.skipIf(!TEST_URL)("PV7-02 · the hub overview's ball is pinned (needsUs, needsClient)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let clientA: string;
  let clientB: string;
  let projA: string;
  const f = {
    invA: newId(), invDraft: newId(), invB: "",
    payA1: newId(), payA2: newId(), payDraft: newId(), payB: newId(),
    crA: newId(), crDeleted: newId(), crB: newId(),
    kDraft: newId(), kSent: newId(), kSentB: newId(),
    threadAwaiting: newId(), threadAnswered: newId(), threadProject: newId(), threadB: newId(),
    runA: newId(), runB: newId(),
    gateA: newId(), gateInternal: newId(), gateDecided: newId(), gateB: newId(),
    reviewChanges: newId(), reviewPending: newId(), reviewB: newId(),
  };

  const overview = async (clientId: string) => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/overview`, headers: asUser(admin) });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json() as { needsUs: Item[]; needsClient: Item[]; conversationsAwaitingReply: number };
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Ball Co", ["clients", "invoice", "pm", "social", "webdev"]);
    admin = await createUser("admin@ball-parity.test", "Ada Admin");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);

    clientA = await createClient(co, "Ball Client A");
    clientB = await createClient(co, "Ball Client B");
    projA = await createProject(co, "Ball A project", admin);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projA, clientA]));

    await ensureBillingSetup(co);
    // `sent` means ISSUED (PV5-01b), so the issued invoices go through the real issue path.
    f.invA = (await createIssuedInvoice(co, { clientId: clientA, actorId: admin, lines: [{ description: "Fixture work", amount: 1000 }] })).id;
    f.invB = (await createIssuedInvoice(co, { clientId: clientB, actorId: admin, lines: [{ description: "Fixture work", amount: 500 }] })).id;

    await withTenants([co], async (c) => {
      // A draft invoice: a pending claim on it is a needsUs item the client CANNOT see (clientVisible false).
      await c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, current_date - 30, current_date - 1, 'draft', 'IDR', '[{"description":"Work","amount":1000}]'::jsonb, 1000, $4)`,
        [f.invDraft, co, clientA, site()],
      );
      const payment = (id: string, invoiceId: string, clientId: string, amount: number, createdAt: string) =>
        c.query(
          `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, created_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'IDR', current_date - 2, 'pending', $6::timestamptz, $7)`,
          [id, co, invoiceId, clientId, amount, createdAt, site()],
        );
      await payment(f.payA1, f.invA, clientA, 400, at(2));
      await payment(f.payDraft, f.invDraft, clientA, 100, at(3));
      await payment(f.payA2, f.invA, clientA, 250, at(4));
      await payment(f.payB, f.invB, clientB, 77, at(1));

      // Change requests: a new one (needsUs), a soft-deleted new one (never), and another client's.
      const cr = (id: string, clientId: string, title: string, createdAt: string, deleted: boolean) =>
        c.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, client_id, project_id, requested_by, created_at, deleted_at, origin_site)
           VALUES ($1, $2, 'portal', 'content', $3, 'new', $4, NULL, $5, $6::timestamptz, CASE WHEN $7 THEN now() ELSE NULL END, $8)`,
          [id, co, title, clientId, admin, createdAt, deleted, site()],
        );
      await cr(f.crA, clientA, "Update the footer", at(6), false);
      await cr(f.crDeleted, clientA, "Deleted request", at(6), true);
      await cr(f.crB, clientB, "Other client's request", at(6), false);

      // Contracts: a draft (needsUs, hidden from the client) and a sent one (needsClient); B's sent one.
      const contract = (id: string, clientId: string, status: string, title: string, createdAt: string) =>
        c.query(
          `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, status, currency, sent_at, body_md,
                                  content_sha256, content_fixed_at, signature_tier, created_by, created_at, origin_site)
           VALUES ($1, $2, $3, NULL, $4, $5, 'IDR', CASE WHEN $5 = 'draft' THEN NULL ELSE now() END, $8,
                   CASE WHEN $5 = 'draft' THEN NULL ELSE $9 END, CASE WHEN $5 = 'draft' THEN NULL ELSE now() END,
                   CASE WHEN $5 = 'draft' THEN NULL ELSE 'attested' END, $6, $10::timestamptz, $7)`,
          [id, co, clientId, title, status, admin, site(), FIXTURE_TERMS, FIXTURE_TERMS_SHA256, createdAt],
        );
      await contract(f.kDraft, clientA, "draft", "Draft SOW", at(7));
      await contract(f.kSent, clientA, "sent", "Master agreement", at(2));
      await contract(f.kSentB, clientB, "sent", "B master agreement", at(2));

      // Conversation: one client-wide thread awaiting our reply (a client has ONE: ux_conv_threads_client_wide), one project thread we already answered, one on a project with no subject, and B's.
      const thread = (id: string, clientId: string, projectId: string | null, subject: string | null) =>
        c.query(
          `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7)`,
          [id, co, clientId, projectId, subject, admin, site()],
        );
      const message = (threadId: string, side: "client" | "staff", createdAt: string) =>
        c.query(
          `INSERT INTO conversation_messages (id, tenant_id, thread_id, author_id, author_side, body, created_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'hello', $6::timestamptz, $7)`,
          [newId(), co, threadId, admin, side, createdAt, site()],
        );
      await thread(f.threadAwaiting, clientA, null, "Logo question");
      await message(f.threadAwaiting, "client", at(8));
      await thread(f.threadAnswered, clientA, projA, "Answered already");
      await message(f.threadAnswered, "client", at(8));
      await message(f.threadAnswered, "staff", at(9));
      await thread(f.threadProject, clientA, projA, null);
      await message(f.threadProject, "client", at(10));
      await thread(f.threadB, clientB, null, "B question");
      await message(f.threadB, "client", at(8));

      // Delivery runs and gates: a pending client gate (needsClient), an internal pending gate and a decided client gate (never).
      const run = (id: string, clientId: string, title: string) =>
        c.query(
          `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
           VALUES ($1, $2, $3, 'delivery_active', $4, NULL, $5)`,
          [id, co, title, clientId, site()],
        );
      await run(f.runA, clientA, "Website delivery");
      await run(f.runB, clientB, "B delivery");
      const gate = (id: string, runId: string, kind: string, side: string, status: string, createdAt: string) =>
        c.query(
          `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, decided_at, created_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'decided' THEN 'approved' ELSE NULL END,
                   CASE WHEN $6 = 'decided' THEN now() ELSE NULL END, $7::timestamptz, $8)`,
          [id, co, runId, kind, side, status, createdAt, site()],
        );
      await gate(f.gateA, f.runA, "prd_sign", "client", "pending", at(1));
      await gate(f.gateInternal, f.runA, "pm_review", "internal", "pending", at(1));
      await gate(f.gateDecided, f.runA, "scope_signoff", "client", "decided", at(1));
      await gate(f.gateB, f.runB, "customer_feedback", "client", "pending", at(1));
    });

    // Post reviews sit behind the social third wall, so the posts and variants are seeded with the module scope.
    await withTenants([co], async (c) => {
      const infra = async (clientId: string, tag: string) => {
        const engagement = newId();
        const org = newId();
        const account = newId();
        await c.query(
          `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, 10, $7)`,
          [engagement, co, clientId, `Ball engagement ${tag}`, admin, JSON.stringify({ networks: { instagram: true }, posting: { requiresClientOk: true } }), site()],
        );
        await c.query(
          `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
           VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', $5)`,
          [org, co, clientId, `ball-org-${tag}`, site()],
        );
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
           VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}', $6)`,
          [account, co, clientId, org, `@ball-${tag}`, site()],
        );
        return { engagement, account };
      };
      const review = async (
        i: { engagement: string; account: string }, clientId: string, reviewId: string, title: string,
        status: "pending" | "changes_requested", requestedAt: string, decidedAt: string | null,
      ) => {
        const post = newId();
        const variant = newId();
        const sha = variantArgsSha256({
          tenantId: co, id: variant, accountId: i.account, body: "copy", firstComment: null, media: [], settings: {}, scheduledAt: null,
        });
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1, $2, $3, $4, 'draft', $5)`,
          [post, co, i.engagement, title, site()],
        );
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
           VALUES ($1, $2, $3, $4, 'copy', $5, 'draft', $6)`,
          [variant, co, post, i.account, sha, site()],
        );
        await c.query(
          `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, decided_by, decided_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, $9)`,
          [reviewId, co, variant, clientId, status, requestedAt, decidedAt ? admin : null, decidedAt, site()],
        );
      };
      const a = await infra(clientA, "a");
      const b = await infra(clientB, "b");
      await review(a, clientA, f.reviewChanges, "Post one", "changes_requested", at(4), at(5));
      await review(a, clientA, f.reviewPending, "Post two", "pending", at(3), null);
      await review(b, clientB, f.reviewB, "B post", "pending", at(3), null);
    }, SOCIAL);

    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("the OLD output, pinned (the hub overview, one client at a time)", () => {
    it("client A: needsUs, in kind order and oldest first within a kind, every field", async () => {
      const o = await overview(clientA);
      const billing = `/clients/${clientA}/billing`;
      const requests = `/clients/${clientA}/requests`;
      expect(o.needsUs).toEqual([
        item("payment", f.payA1, "Confirm a client-recorded payment", "IDR 400", billing, at(2), true),
        item("payment", f.payDraft, "Confirm a client-recorded payment", "IDR 100", billing, at(3), false),
        item("payment", f.payA2, "Confirm a client-recorded payment", "IDR 250", billing, at(4), true),
        item("review", f.reviewChanges, "Client asked for changes on a post", "Post one", requests, at(5), true),
        item("request", f.crA, "Triage a new change request", "Update the footer", requests, at(6), true),
        item("contract", f.kDraft, "Send a drafted agreement", "Draft SOW", billing, at(7), false),
        item("conversation", f.threadAwaiting, "A client message is waiting for our reply", "Logo question",
          staffThreadHref(clientA, f.threadAwaiting), at(8), true),
        item("conversation", f.threadProject, "A client message is waiting for our reply", "Ball A project",
          staffThreadHref(clientA, f.threadProject), at(10), true),
      ]);
      // The conversation count the hub badge reads is the number of conversation items.
      expect(o.conversationsAwaitingReply).toBe(2);
    });

    it("client A: needsClient, gates then contracts then post reviews", async () => {
      const o = await overview(clientA);
      expect(o.needsClient).toEqual([
        item("gate", f.gateA, "Sign off the project requirements", "Website delivery", `/pipeline/${f.runA}`, at(1), true),
        item("contract", f.kSent, "Awaiting client signature", "Master agreement", `/clients/${clientA}/billing`, at(2), true),
        item("review", f.reviewPending, "Awaiting client post approval", "Post two", `/clients/${clientA}/requests`, at(3), true),
      ]);
    });

    it("client B: only its own rows, and none of A's", async () => {
      const o = await overview(clientB);
      expect(o.needsUs).toEqual([
        item("payment", f.payB, "Confirm a client-recorded payment", "IDR 77", `/clients/${clientB}/billing`, at(1), true),
        item("request", f.crB, "Triage a new change request", "Other client's request", `/clients/${clientB}/requests`, at(6), true),
        item("conversation", f.threadB, "A client message is waiting for our reply", "B question",
          staffThreadHref(clientB, f.threadB), at(8), true),
      ]);
      expect(o.needsClient).toEqual([
        item("gate", f.gateB, "Share feedback", "B delivery", `/pipeline/${f.runB}`, at(1), true),
        item("contract", f.kSentB, "Awaiting client signature", "B master agreement", `/clients/${clientB}/billing`, at(2), true),
        item("review", f.reviewB, "Awaiting client post approval", "B post", `/clients/${clientB}/requests`, at(3), true),
      ]);
    });

    it("the rows that must not appear do not: another client's, soft-deleted, answered, internal and decided", async () => {
      const o = await overview(clientA);
      const ids = [...o.needsUs, ...o.needsClient].map((i) => i.id);
      for (const hidden of [f.payB, f.crDeleted, f.crB, f.kSentB, f.threadAnswered, f.threadB, f.gateInternal, f.gateDecided, f.gateB, f.reviewB]) {
        expect(ids, `${hidden} must not be in client A's ball`).not.toContain(hidden);
      }
    });
  });

  // ── AFTER the refactor: the hub overview calls client-ball.ts for one client; the board calls it for many ──────────
  describe("the set-based read (client-ball.ts)", () => {
    const wire = (rows: ReturnType<typeof toHubItem>[]) => JSON.parse(JSON.stringify(rows)) as Item[];

    it("one call for both clients gives each client exactly what the hub overview gives it", async () => {
      const both = await withTenants([co], (c) => loadClientBall(c, [clientA, clientB]), SOCIAL);
      for (const id of [clientA, clientB]) {
        const o = await overview(id);
        expect(wire(both.get(id)!.needsUs.map(toHubItem)), `needsUs for ${id}`).toEqual(o.needsUs);
        expect(wire(both.get(id)!.needsClient.map(toHubItem)), `needsClient for ${id}`).toEqual(o.needsClient);
      }
    });

    it("a client with nothing outstanding maps to two empty lists, and an id that was not asked for is absent", async () => {
      const quiet = await createClient(co, "Ball Quiet Client");
      const r = await withTenants([co], (c) => loadClientBall(c, [quiet]), SOCIAL);
      expect(r.get(quiet)).toEqual({ needsUs: [], needsClient: [] });
      expect(r.has(clientA)).toBe(false);
      expect((await withTenants([co], (c) => loadClientBall(c, []), SOCIAL)).size).toBe(0);
    });

    it("each row names its client and its project, and the hub item drops both", async () => {
      const r = await withTenants([co], (c) => loadClientBall(c, [clientA]), SOCIAL);
      const thread = r.get(clientA)!.needsUs.find((i) => i.id === f.threadProject)!;
      expect(thread.clientId).toBe(clientA);
      expect(thread.projectId).toBe(projA);
      expect(Object.keys(toHubItem(thread)).sort()).toEqual(["clientVisible", "context", "href", "id", "kind", "label", "since"]);
      expect(r.get(clientA)!.needsUs.find((i) => i.id === f.payA1)!.projectId).toBeNull();
    });

    it("THE SOCIAL WALL: without { modules: [\"social\"] } the post reviews read ZERO rows and nothing raises", async () => {
      // The trap the hub overview documents. The two review items vanish, every other kind is untouched.
      const without = await withTenants([co], (c) => loadClientBall(c, [clientA]));
      const kinds = [...without.get(clientA)!.needsUs, ...without.get(clientA)!.needsClient].filter((i) => i.kind === "review");
      expect(kinds).toEqual([]);
      const withScope = await withTenants([co], (c) => loadClientBall(c, [clientA]), SOCIAL);
      expect([...withScope.get(clientA)!.needsUs, ...withScope.get(clientA)!.needsClient].filter((i) => i.kind === "review")).toHaveLength(2);
    });
  });
});
