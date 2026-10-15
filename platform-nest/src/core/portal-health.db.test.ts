// PV7-02 — `GET :t/portal/health`, the client's own view of how the work is going (BFF §54.5), proven over HTTP against real
// Postgres + RLS + Cerbos (skips silently without DATABASE_URL_TEST: check the skip count; runs on the Linux CI gate).
//
// THE ISOLATION FIXTURE is the shared multi-client contact (src/testing/portal-fixtures.ts): one person, a client-wide signer of
// client A and a viewer limited to ONE project (B1) of client B. B also has a second project (B2) and every kind of CLIENT-WIDE
// item (a project-less run, contract, change request and payment, the general thread, a post review). The contact must see
//   * two sections, A and B;
//   * for A (client-wide): every project, and the client-wide parts;
//   * for B (project-scoped): ONLY B1's health, and NONE of B's client-wide parts or B2's anything.
// A second user, a client-wide contact of B, is the POSITIVE CONTROL: they see exactly the things the first contact must not,
// so the isolation assertions can never pass because a fixture row failed to exist.
//
// ALSO PLANTED, and scanned for in the whole body: an internal gate on a project the contact reaches, a blocked task with a
// recognisable title, a draft agreement, a staff user's name. None of them may appear. And no key of a state label, a task, an
// owner or a person.
//
// Teeth (recorded in the PV7-02 hand-back, run on a throwaway branch with real red CI):
//   1. An internal gate in the payload. The ball has TWO layers against it: the gate predicate in client-ball.ts
//      (`gateClientVisible("g")`) and the `clientVisible` filter in portal-health.controller.ts (`portalBall`). Dropping only the
//      predicate is caught by the hub-ball parity suite (and the filter keeps this payload clean). Dropping BOTH puts the
//      internal gate on A's and B1's projects into the payload: "internal gates are never listed", the exact waiting counts and
//      the body scan fail here.
//   2. In portal-visibility.ts, make `wideOrOwnProject` admit a project-less row (`allowNullProject` true): the project-less
//      triaged requests reach the project-scoped contact's turnaround (n = 6, not 3) and "our side counts ONLY B1's" fails,
//      as does portal-visibility.test.ts. The ball's grouping alone would hide this leak (a project-less item belongs to no
//      project section), which is why the turnaround carries the fixture for it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { variantArgsSha256 } from "../modules/social/canonical-args";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { FIXTURE_TERMS, FIXTURE_TERMS_SHA256 } from "../testing/contract-fixtures";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { createMultiClientContact, type MultiClientContact } from "../testing/portal-fixtures";
import { newId, withTenants, withGlobal } from "../db";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };
const site = () => config.originSite;

interface Ball { count: number; oldestSince: string | null; items: Array<{ kind: string; id: string; context: string | null; since: string | null }> }
interface Section {
  clientId: string; name: string; wide: boolean;
  projects: Array<{
    projectId: string; name: string; status: string;
    milestones: { total: number; done: number; upcoming: number; late: number; undated: number };
    deliverables: { total: number; delivered: number; late: number };
    nextMilestone: { id: string; name: string; dueDate: string } | null;
    waitingOnYou: Ball | null; waitingOnUs: Ball | null;
  }> | null;
  clientWide: { waitingOnYou: Ball | null; waitingOnUs: Ball | null } | null;
  turnaround: { windowDays: number; client: { medianDays: number | null; n: number; withheld: boolean }; ours: { medianDays: number | null; n: number; withheld: boolean } } | null;
}
interface Body { asOf: string; clients: Section[]; unavailable: string[] }

const ids = (b: Ball | null | undefined) => (b?.items ?? []).map((i) => i.id).sort();

/** Every key in the body, at any depth. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

describe.skipIf(!TEST_URL)("PV7-02 · portal health: isolation, per client and per project", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let m: MultiClientContact;
  let wideB: string; // positive control: a client-wide contact of B only
  const f = {
    taskTitle: "SECRET task title: refactor auth before the demo",
    b2Milestone: "B2 late SECRET milestone",
    // runs, gates
    runA: newId(), runA0: newId(), runB1: newId(), runB2: newId(), runB0: newId(),
    gA: newId(), gAint: newId(), gA0: newId(), gB1: newId(), gB1int: newId(), gB2: newId(), gB0: newId(),
    // contracts
    kA0: newId(), kADraft: newId(), kB0: newId(), kB1: newId(), kB2: newId(),
    // change requests
    crA0: newId(), crB0: newId(), crB1: newId(), crB2: newId(),
    // threads
    threadB1: newId(), threadB2: newId(),
    // payments, reviews
    payA: newId(), payB: newId(), rvA: newId(), rvB: newId(),
  };
  const adminName = "Ada Admin";

  const health = async (user: string, expected = 200): Promise<Body> => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/health`, headers: asUser(user) });
    expect(r.statusCode, r.body.slice(0, 400)).toBe(expected);
    return r.json();
  };
  const section = (b: Body, clientId: string) => {
    const s = b.clients.find((x) => x.clientId === clientId);
    expect(s, `a section for ${clientId}`).toBeDefined();
    return s!;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Portal Health Co", ["clients", "invoice", "pm", "social", "webdev"]);
    admin = await createUser("admin@portal-health.test", adminName);
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    m = await createMultiClientContact(co, { tag: "ph", staffUserId: admin });
    const { clientA: A, clientB: B, projectA: pA, projectB1: pB1, projectB2: pB2 } = m;

    // The positive control: a client-wide contact of B only.
    wideB = await createUser("wide-b@portal-health.test", "Wanda Wide");
    await addMembership(co, wideB);
    await grantRole(wideB, await createRole("client"), "company", co);
    await withGlobal((q) => q.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [wideB]));

    await ensureBillingSetup(co);
    const invA = (await createIssuedInvoice(co, { clientId: A, actorId: admin, lines: [{ description: "Work", amount: 1000 }] })).id;
    const invB = (await createIssuedInvoice(co, { clientId: B, actorId: admin, lines: [{ description: "Work", amount: 1000 }] })).id;

    await withTenants([co], async (q) => {
      await q.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', now(), $5)`,
        [newId(), co, B, wideB, site()],
      );

      // ── milestones and deliverables ───────────────────────────────────────────────────────────────
      const milestone = (project: string, name: string, status: string, offset: number) =>
        q.query(
          `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
           VALUES ($1, $2, $3, $4, current_date + $5::int, $6, $7)`,
          [newId(), co, project, name, offset, status, site()],
        );
      await milestone(pA, "A done", "done", -10);
      await milestone(pA, "A late", "open", -3);
      await milestone(pA, "A next", "open", 9);
      await milestone(pB1, "B1 late", "open", -5);
      await milestone(pB2, f.b2Milestone, "open", -6);
      const deliverable = (project: string, name: string, status: string, offset: number) =>
        q.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
           VALUES ($1, $2, $3, NULL, $4, $5, current_date + $6::int, $7)`,
          [newId(), co, project, name, status, offset, site()],
        );
      await deliverable(pA, "A late deliverable", "pending", -4);
      await deliverable(pB1, "B1 delivered", "delivered", -2);
      await deliverable(pB2, "B2 late deliverable", "pending", -8);

      // A blocked task with an internal title on a project the contact reaches: never in the payload.
      await q.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, origin_site) VALUES ($1, $2, $3, $4, 'blocked', $5)`,
        [newId(), co, pA, f.taskTitle, site()],
      );

      // ── delivery runs and gates ───────────────────────────────────────────────────────────────────
      const run = (id: string, clientId: string, projectId: string | null, title: string) =>
        q.query(
          `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
           VALUES ($1, $2, $3, 'delivery_active', $4, $5, $6)`,
          [id, co, title, clientId, projectId, site()],
        );
      await run(f.runA, A, pA, "Run A project");
      await run(f.runA0, A, null, "Run A client-wide");
      await run(f.runB1, B, pB1, "Run B1");
      await run(f.runB2, B, pB2, "Run B2");
      await run(f.runB0, B, null, "Run B client-wide");
      const gate = (id: string | null, runId: string, side: string, decided: boolean, createdDaysAgo: number, tookDays: number) =>
        q.query(
          `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, decided_at, created_at, origin_site)
           VALUES ($1, $2, $3, 'prd_sign', $4, $5, CASE WHEN $6 THEN 'approved' ELSE NULL END,
                   CASE WHEN $6 THEN now() - make_interval(days => $7::int) + make_interval(days => $8::int) ELSE NULL END,
                   now() - make_interval(days => $7::int), $9)`,
          [id ?? newId(), co, runId, side, decided ? "decided" : "pending", decided, createdDaysAgo, tookDays, site()],
        );
      // Pending, client side.
      await gate(f.gA, f.runA, "client", false, 6, 0);
      await gate(f.gA0, f.runA0, "client", false, 7, 0);
      await gate(f.gB1, f.runB1, "client", false, 8, 0);
      await gate(f.gB2, f.runB2, "client", false, 9, 0);
      await gate(f.gB0, f.runB0, "client", false, 10, 0);
      // Pending, INTERNAL: on projects the contact reaches. Never listed.
      await gate(f.gAint, f.runA, "internal", false, 11, 0);
      await gate(f.gB1int, f.runB1, "internal", false, 12, 0);
      // Decided, client side: the turnaround samples. A: 3 x 4 days (project) + 2 x 8 days (client-wide run). B: 3 on B1 (1, 2, 3 days),
      // 5 x 10 days on B2 and 5 x 20 days on the client-wide run. Plus an internal decided gate (50 days) that is never a sample.
      for (let i = 0; i < 3; i++) await gate(null, f.runA, "client", true, 30 + i, 4);
      for (let i = 0; i < 2; i++) await gate(null, f.runA0, "client", true, 40 + i, 8);
      for (const d of [1, 2, 3]) await gate(null, f.runB1, "client", true, 30 + d, d);
      for (let i = 0; i < 5; i++) await gate(null, f.runB2, "client", true, 30 + i, 10);
      for (let i = 0; i < 5; i++) await gate(null, f.runB0, "client", true, 30 + i, 20);
      await gate(null, f.runA, "internal", true, 60, 50);

      // ── contracts ─────────────────────────────────────────────────────────────────────────────────
      const contract = (id: string, clientId: string, projectId: string | null, status: string, title: string) =>
        q.query(
          `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, status, currency, sent_at, body_md,
                                  content_sha256, content_fixed_at, signature_tier, created_by, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'IDR', CASE WHEN $6 = 'draft' THEN NULL ELSE now() END, $9,
                   CASE WHEN $6 = 'draft' THEN NULL ELSE $10 END, CASE WHEN $6 = 'draft' THEN NULL ELSE now() END,
                   CASE WHEN $6 = 'draft' THEN NULL ELSE 'attested' END, $7, $8)`,
          [id, co, clientId, projectId, title, status, admin, site(), FIXTURE_TERMS, FIXTURE_TERMS_SHA256],
        );
      await contract(f.kA0, A, null, "sent", "A master agreement");
      await contract(f.kADraft, A, null, "draft", "A draft SOW");
      await contract(f.kB0, B, null, "sent", "B master agreement");
      await contract(f.kB1, B, pB1, "sent", "B1 SOW");
      await contract(f.kB2, B, pB2, "sent", "B2 SOW");

      // ── change requests (new) ─────────────────────────────────────────────────────────────────────
      const cr = (id: string, clientId: string, projectId: string | null, title: string) =>
        q.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, client_id, project_id, requested_by, origin_site)
           VALUES ($1, $2, 'portal', 'content', $3, 'new', $4, $5, $6, $7)`,
          [id, co, title, clientId, projectId, admin, site()],
        );
      await cr(f.crA0, A, null, "A client-wide request");
      await cr(f.crB0, B, null, "B client-wide request");
      await cr(f.crB1, B, pB1, "B1 request");
      await cr(f.crB2, B, pB2, "B2 request");

      // Change requests we TRIAGED: the "our side" turnaround samples. B1: 3 x 1 day. B2: 3 x 7 days. B with NO project: 3 x 5 days.
      // The project-less ones are what `wideOrOwnProject` must keep from a project-scoped contact (tooth 2).
      const triaged = (clientId: string, projectId: string | null, days: number) =>
        q.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, route, client_id, project_id, requested_by, triaged_by,
                                              triaged_at, created_at, origin_site)
           VALUES ($1, $2, 'portal', 'content', 'Triaged', 'triaged', 'mini_run', $3, $4, $5, $5,
                   now() - interval '10 days' + make_interval(days => $6::int), now() - interval '10 days', $7)`,
          [newId(), co, clientId, projectId, admin, days, site()],
        );
      for (let i = 0; i < 3; i++) {
        await triaged(B, pB1, 1);
        await triaged(B, null, 5);
        await triaged(B, pB2, 7);
      }

      // ── conversation: client messages waiting for our reply ──────────────────────────────────────
      const thread = (id: string, clientId: string, projectId: string, subject: string) =>
        q.query(
          `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7)`,
          [id, co, clientId, projectId, subject, admin, site()],
        );
      const clientMessage = (threadId: string) =>
        q.query(
          `INSERT INTO conversation_messages (id, tenant_id, thread_id, author_id, author_side, body, origin_site)
           VALUES ($1, $2, $3, $4, 'client', 'hello', $5)`,
          [newId(), co, threadId, admin, site()],
        );
      await thread(f.threadB1, B, pB1, "B1 thread");
      await thread(f.threadB2, B, pB2, "B2 thread");
      for (const t of [m.generalThreadA, m.generalThreadB, f.threadB1, f.threadB2]) await clientMessage(t);

      // ── payments pending (client-wide material) ───────────────────────────────────────────────────
      const payment = (id: string, invoiceId: string, clientId: string) =>
        q.query(
          `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, source, origin_site)
           VALUES ($1, $2, $3, $4, 123456, 'IDR', current_date - 1, 'pending', 'client_claim', $5)`,
          [id, co, invoiceId, clientId, site()],
        );
      await payment(f.payA, invA, A);
      await payment(f.payB, invB, B);
    });

    // ── post reviews (the social wall) ───────────────────────────────────────────────────────────────
    await withTenants([co], async (q) => {
      const review = async (clientId: string, tag: string, reviewId: string) => {
        const engagement = newId();
        const org = newId();
        const account = newId();
        const post = newId();
        const variant = newId();
        await q.query(
          `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, 10, $7)`,
          [engagement, co, clientId, `PH engagement ${tag}`, admin, JSON.stringify({ networks: { instagram: true }, posting: { requiresClientOk: true } }), site()],
        );
        await q.query(
          `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
           VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', $5)`,
          [org, co, clientId, `ph-org-${tag}`, site()],
        );
        await q.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
           VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}', $6)`,
          [account, co, clientId, org, `@ph-${tag}`, site()],
        );
        const sha = variantArgsSha256({ tenantId: co, id: variant, accountId: account, body: "copy", firstComment: null, media: [], settings: {}, scheduledAt: null });
        await q.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1, $2, $3, $4, 'draft', $5)`, [post, co, engagement, `PH post ${tag}`, site()]);
        await q.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
           VALUES ($1, $2, $3, $4, 'copy', $5, 'draft', $6)`,
          [variant, co, post, account, sha, site()],
        );
        await q.query(
          `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, origin_site)
           VALUES ($1, $2, $3, $4, 'pending', now() - interval '3 days', $5)`,
          [reviewId, co, variant, clientId, site()],
        );
      };
      await review(A, "a", f.rvA);
      await review(B, "b", f.rvB);
    }, SOCIAL);

    app = await buildApp();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── the contact of two clients ────────────────────────────────────────────────────────────────────
  describe("a contact of two clients, client-wide on A and limited to one project on B", () => {
    it("gets two sections, A and B, in name order, nothing failed", async () => {
      const b = await health(m.userId);
      expect(b.clients.map((s) => s.clientId)).toEqual([m.clientA, m.clientB]);
      expect(b.unavailable).toEqual([]);
      expect(section(b, m.clientA).wide).toBe(true);
      expect(section(b, m.clientB).wide).toBe(false);
    });

    it("A (client-wide): every project, with milestones and deliverables counted, and the ball per project", async () => {
      const a = section(await health(m.userId), m.clientA);
      expect(a.projects!.map((p) => p.projectId)).toEqual([m.projectA]);
      const p = a.projects![0];
      expect(p.milestones).toEqual({ total: 3, done: 1, upcoming: 1, late: 1, undated: 0 });
      expect(p.deliverables).toEqual({ total: 1, delivered: 0, late: 1 });
      expect(p.nextMilestone?.name).toBe("A late");
      // The one pending CLIENT gate on the project. The internal pending gate on the same run is not listed.
      expect(ids(p.waitingOnYou)).toEqual([f.gA]);
      expect(p.waitingOnYou!.count).toBe(1);
      expect(p.waitingOnUs!.count).toBe(0);
    });

    it("A (client-wide): the client-wide parts are present", async () => {
      const a = section(await health(m.userId), m.clientA);
      expect(a.clientWide).not.toBeNull();
      // What waits on the client with no project: a client-side gate on a project-less run, the sent agreement, the unreviewed post.
      expect(ids(a.clientWide!.waitingOnYou)).toEqual([f.gA0, f.kA0, f.rvA].sort());
      // What waits on us with no project: the pending payment, the untriaged request, the general thread.
      expect(ids(a.clientWide!.waitingOnUs)).toEqual([f.payA, f.crA0, m.generalThreadA].sort());
      // A drafted agreement is never listed.
      expect([...ids(a.clientWide!.waitingOnYou), ...ids(a.clientWide!.waitingOnUs)]).not.toContain(f.kADraft);
    });

    it("a payment is listed by kind and age only: no amount", async () => {
      const a = section(await health(m.userId), m.clientA);
      const pay = a.clientWide!.waitingOnUs!.items.find((i) => i.id === f.payA)!;
      expect(pay.kind).toBe("payment");
      expect(pay.context).toBeNull();
      expect(JSON.stringify(a)).not.toContain("123456");
    });

    it("B (limited to B1): ONLY project B1, with B1's own counts", async () => {
      const bSec = section(await health(m.userId), m.clientB);
      expect(bSec.projects!.map((p) => p.projectId)).toEqual([m.projectB1]);
      const p = bSec.projects![0];
      expect(p.milestones).toEqual({ total: 1, done: 0, upcoming: 0, late: 1, undated: 0 });
      expect(p.deliverables).toEqual({ total: 1, delivered: 1, late: 0 });
    });

    it("B (limited to B1): B1's ball is B1's own, and B's client-wide parts are NOT there", async () => {
      const bSec = section(await health(m.userId), m.clientB);
      const p = bSec.projects![0];
      // B1's pending client gate and sent agreement; NOT the internal gate, NOT B2's, NOT the project-less run's gate, NOT B's master agreement.
      expect(ids(p.waitingOnYou)).toEqual([f.gB1, f.kB1].sort());
      // B1's untriaged request and B1's thread; NOT B's project-less request, NOT the general thread, NOT B2's.
      expect(ids(p.waitingOnUs)).toEqual([f.crB1, f.threadB1].sort());
      // No client-wide section at all for a client the caller reaches only through a project.
      expect(bSec.clientWide).toBeNull();
    });

    it("none of what the contact must not reach appears anywhere in the body", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/portal/health`, headers: asUser(m.userId) });
      const text = r.body;
      const hidden: Record<string, string> = {
        "B2 project": m.projectB2, "B's general thread": m.generalThreadB, "B2 thread": f.threadB2,
        "B2's gate": f.gB2, "B client-wide gate": f.gB0, "internal gate on A": f.gAint, "internal gate on B1": f.gB1int,
        "B master agreement": f.kB0, "B2 SOW": f.kB2, "A draft SOW": f.kADraft,
        "B client-wide request": f.crB0, "B2 request": f.crB2, "B payment": f.payB, "B post review": f.rvB,
      };
      for (const [what, id] of Object.entries(hidden)) expect(text, `${what} (${id}) must not be in the body`).not.toContain(id);
      expect(text).not.toContain(f.b2Milestone);
      expect(text).not.toContain(f.taskTitle);
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain(adminName);
      expect(text).not.toContain("Wanda");
    });

    it("internal gates are never listed, and the waiting counts are exact (so one that slipped in fails)", async () => {
      const b = await health(m.userId);
      const all = b.clients.flatMap((s) => [
        ...(s.projects ?? []).flatMap((p) => [p.waitingOnYou, p.waitingOnUs]),
        s.clientWide?.waitingOnYou, s.clientWide?.waitingOnUs,
      ]);
      const listed = all.flatMap((x) => ids(x));
      expect(listed).not.toContain(f.gAint);
      expect(listed).not.toContain(f.gB1int);
      expect(section(b, m.clientA).projects![0].waitingOnYou!.count).toBe(1);
      expect(section(b, m.clientB).projects![0].waitingOnYou!.count).toBe(2);
    });

    it("carries no task, no time, no person, no staff wording and no state label, at any depth", async () => {
      const b = await health(m.userId);
      const keys = allKeys(b);
      for (const banned of [
        "state", "reasons", "reason", "tasks", "task", "blocked", "timeEntries", "minutes", "hours", "activities", "assignee",
        "ownerUserId", "ownerName", "owner", "people", "authorName", "label", "href", "clientVisible", "signals",
        "overdueInvoices", "money", "amount",
      ]) expect(keys.has(banned), `the key "${banned}" must not appear`).toBe(false);
      // The keys that DO appear are the ones the contract names.
      expect([...allKeys(section(b, m.clientA))].sort()).toEqual(
        expect.arrayContaining(["clientId", "name", "wide", "projects", "clientWide", "turnaround", "waitingOnYou", "waitingOnUs", "milestones", "deliverables", "nextMilestone"]),
      );
    });
  });

  // ── turnaround ────────────────────────────────────────────────────────────────────────────────────
  describe("turnaround", () => {
    it("A (client-wide): the median over every client gate decided, the project's and the project-less run's", async () => {
      const a = section(await health(m.userId), m.clientA);
      expect(a.turnaround).toEqual({
        windowDays: 90,
        client: { medianDays: 4, n: 5, withheld: false },
        ours: { medianDays: null, n: 0, withheld: true },
      });
    });

    it("B (limited to B1): ONLY B1's gates count (n = 3, median 2), not B2's and not the project-less run's", async () => {
      const bSec = section(await health(m.userId), m.clientB);
      expect(bSec.turnaround?.client).toEqual({ medianDays: 2, n: 3, withheld: false });
    });

    it("B (limited to B1): our side counts ONLY B1's triaged requests (n = 3, 1 day), never the project-less ones or B2's", async () => {
      const bSec = section(await health(m.userId), m.clientB);
      // 3 on B1 (1 day), 3 with no project (5 days), 3 on B2 (7 days). A reach that admitted the project-less rows would read n = 6.
      expect(bSec.turnaround?.ours).toEqual({ medianDays: 1, n: 3, withheld: false });
    });
  });

  // ── the positive control ──────────────────────────────────────────────────────────────────────────
  describe("the positive control: a client-wide contact of B sees what the limited contact must not", () => {
    it("every project of B, and B's client-wide parts", async () => {
      const bSec = section(await health(wideB), m.clientB);
      expect(bSec.wide).toBe(true);
      expect(bSec.projects!.map((p) => p.projectId).sort()).toEqual([m.projectB1, m.projectB2].sort());
      expect(ids(bSec.clientWide!.waitingOnYou)).toEqual([f.gB0, f.kB0, f.rvB].sort());
      expect(ids(bSec.clientWide!.waitingOnUs)).toEqual([f.payB, f.crB0, m.generalThreadB].sort());
      const b2 = bSec.projects!.find((p) => p.projectId === m.projectB2)!;
      expect(ids(b2.waitingOnYou)).toEqual([f.gB2, f.kB2].sort());
      expect(ids(b2.waitingOnUs)).toEqual([f.crB2, f.threadB2].sort());
    });

    it("and sees ONLY client B (the contact's section for A is not theirs)", async () => {
      const b = await health(wideB);
      expect(b.clients.map((s) => s.clientId)).toEqual([m.clientB]);
      expect(JSON.stringify(b)).not.toContain(m.projectA);
    });

    it("the turnaround counts every client gate of B: 3 + 5 + 5 samples", async () => {
      const bSec = section(await health(wideB), m.clientB);
      expect(bSec.turnaround?.client.n).toBe(13);
      expect(bSec.turnaround?.client.withheld).toBe(false);
      // And every triaged request: 3 + 3 + 3, median of [1,1,1,5,5,5,7,7,7] = 5.
      expect(bSec.turnaround?.ours).toEqual({ medianDays: 5, n: 9, withheld: false });
    });
  });

  // ── who may call ──────────────────────────────────────────────────────────────────────────────────
  describe("access", () => {
    it("a staff member is refused: this is the client's view, and staff have the board", async () => {
      await health(admin, 403);
    });

    it("an unauthenticated call is refused", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/portal/health` });
      expect(r.statusCode).toBe(401);
    });

    it("a client of ANOTHER company gets nothing of this one", async () => {
      const other = await createCompany("Other Health Co", ["clients", "pm"]);
      const stranger = await createUser("stranger@portal-health.test", "Sam Stranger");
      await addMembership(other, stranger);
      await grantRole(stranger, await createRole("client"), "company", other);
      await withGlobal((q) => q.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [stranger]));
      await health(stranger, 403);
    });
  });
});
