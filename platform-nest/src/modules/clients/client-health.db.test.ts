// PV7-02 — client health, staff side (BFF §54): the board, the one-client read, the query-count pin, a failed source and the
// module walls. Real Postgres + Cerbos through `app.inject()` (skips silently without DATABASE_URL_TEST: check the skip count;
// runs on the Linux CI gate, not on the laptop).
//
// The fixture is RELATIVE TO NOW (every age is "N days ago" in SQL), because the state is judged against the real clock. The
// rules themselves are pinned to the day by the golden table (client-health-rules.test.ts); this suite proves the READS feed
// them the right signals, per client, with the right scopes.
//
// Teeth:
//   * THE SOCIAL WALL is proven load-bearing inside the suite: the same board read with the "ball" source's module scope
//     dropped (through the injected reader) sees ZERO post reviews and raises nothing. Dropping `["social"]` from the "ball"
//     read in client-health.ts fails "an unreviewed post counts" the same way.
//   * "a fixed number of queries": a per-client query added to any source changes the count between the board read and the same read after 40 more clients.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { variantArgsSha256 } from "../social/canonical-args";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../testing/fixtures";
import { newId, withTenants, withGlobal } from "../../db";
import { createIssuedInvoice, ensureBillingSetup } from "../../seed/billing-setup";
import { loadClientHealthBoard, type ClientHealthBoard, type ClientHealthDetail, type SourceReader } from "./client-health";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };
const MONITORING = { modules: ["monitoring"] };
const site = () => config.originSite;

describe.skipIf(!TEST_URL)("PV7-02 · client health, staff side", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let outsider: string;
  const c: Record<string, string> = {}; // client ids by short name
  const proj: Record<string, string> = {};

  const board = async (): Promise<ClientHealthBoard> => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/health`, headers: asUser(admin) });
    expect(r.statusCode, r.body.slice(0, 400)).toBe(200);
    return r.json();
  };
  const rowOf = (b: ClientHealthBoard, name: string) => {
    const row = b.clients.find((x) => x.clientId === c[name]);
    expect(row, `the board has a row for ${name}`).toBeDefined();
    return row!;
  };
  const detail = async (clientId: string) => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/health`, headers: asUser(admin) });
    return r;
  };

  /** A project of its own for a client (the client is set at insert, as the composite FKs want). */
  const projectFor = async (name: string) => {
    proj[name] = await createProject(co, `H ${name} project`, admin, c[name]);
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Health Co", ["clients", "invoice", "pm", "social", "webdev", "monitoring", "reports"]);
    admin = await createUser("admin@health.test", "Ada Admin");
    outsider = await createUser("outsider@health.test", "Olly Outsider");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);

    for (const name of [
      "quiet", "ontrack", "wait8", "off15", "late", "late14", "inv", "inv30", "site", "waitclient", "social", "turn",
      "archived", "internal", "deleted",
    ]) c[name] = await createClient(co, `H ${name}`);
    for (const name of ["ontrack", "wait8", "off15", "late", "late14", "inv", "inv30", "site", "waitclient", "turn"]) await projectFor(name);

    await withTenants([co], async (q) => {
      await q.query(`UPDATE clients SET status = 'archived' WHERE id = $1`, [c.archived]);
      await q.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [c.internal]);
      await q.query(`UPDATE clients SET deleted_at = now() WHERE id = $1`, [c.deleted]);
    });

    await ensureBillingSetup(co);
    // wait8: a client-recorded payment pending for 8 days, on an invoice that was really issued.
    const invWait = (await createIssuedInvoice(co, { clientId: c.wait8, actorId: admin, lines: [{ description: "Work", amount: 1000 }] })).id;
    // inv: issued 45 days ago, payment terms 30 days: due 15 days ago. inv30: issued 75 days ago: due 45 days ago.
    const dayOf = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    await createIssuedInvoice(co, { clientId: c.inv, actorId: admin, lines: [{ description: "Work", amount: 1000 }], issueDate: dayOf(45), periodStart: dayOf(76), periodEnd: dayOf(46) });
    await createIssuedInvoice(co, { clientId: c.inv30, actorId: admin, lines: [{ description: "Work", amount: 1000 }], issueDate: dayOf(75), periodStart: dayOf(106), periodEnd: dayOf(76) });

    await withTenants([co], async (q) => {
      await q.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, source, created_at, origin_site)
         VALUES ($1, $2, $3, $4, 400, 'IDR', current_date - 9, 'pending', 'client_claim', now() - make_interval(days => 8), $5)`,
        [newId(), co, invWait, c.wait8, site()],
      );

      // off15: a change request nobody triaged for 15 days.
      await q.query(
        `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, client_id, project_id, requested_by, created_at, origin_site)
         VALUES ($1, $2, 'portal', 'content', 'Fix the footer', 'new', $3, NULL, $4, now() - make_interval(days => 15), $5)`,
        [newId(), co, c.off15, admin, site()],
      );

      // late: one open milestone due 3 days ago, one done milestone, one on time. late14: a deliverable 20 days late.
      const milestone = (project: string, name: string, status: string, dueOffset: number) =>
        q.query(
          `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
           VALUES ($1, $2, $3, $4, current_date + $5::int, $6, $7)`,
          [newId(), co, project, name, dueOffset, status, site()],
        );
      await milestone(proj.late, "Late one", "open", -3);
      await milestone(proj.late, "Done one", "done", -10);
      await milestone(proj.late, "Next one", "open", 9);
      const deliverable = (project: string, name: string, status: string, dueOffset: number) =>
        q.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
           VALUES ($1, $2, $3, NULL, $4, $5, current_date + $6::int, $7)`,
          [newId(), co, project, name, status, dueOffset, site()],
        );
      await deliverable(proj.late14, "Very late", "pending", -20);
      await deliverable(proj.late14, "Delivered", "delivered", -20);
      await deliverable(proj.late, "Future", "pending", 5);

      // waitclient: a pending client-side gate for 15 days. turn: decided client gates, 1/2/3 days, and an INTERNAL one (never a sample).
      const run = async (clientId: string, projectId: string | null, title: string) => {
        const id = newId();
        await q.query(
          `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
           VALUES ($1, $2, $3, 'delivery_active', $4, $5, $6)`,
          [id, co, title, clientId, projectId, site()],
        );
        return id;
      };
      const gate = (runId: string, side: string, status: string, createdDaysAgo: number, decidedDaysAgo: number | null) =>
        q.query(
          `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, decided_at, created_at, origin_site)
           VALUES ($1, $2, $3, 'prd_sign', $4, $5, CASE WHEN $5 = 'decided' THEN 'approved' ELSE NULL END,
                   CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END,
                   now() - make_interval(days => $7::int), $8)`,
          [newId(), co, runId, side, status, decidedDaysAgo, createdDaysAgo, site()],
        );
      const rWait = await run(c.waitclient, proj.waitclient, "Waiting on the client");
      await gate(rWait, "client", "pending", 15, null);
      const rTurn = await run(c.turn, proj.turn, "Turnaround");
      await gate(rTurn, "client", "decided", 11, 10); // 1 day
      await gate(rTurn, "client", "decided", 22, 20); // 2 days
      await gate(rTurn, "client", "decided", 33, 30); // 3 days
      await gate(rTurn, "internal", "decided", 60, 10); // 50 days, internal: must not be a sample

      // turn: two change requests the client raised and we triaged within a day each (n = 2: withheld).
      for (const back of [20, 12]) {
        await q.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, route, client_id, project_id, requested_by, triaged_by,
                                              triaged_at, created_at, origin_site)
           VALUES ($1, $2, 'portal', 'content', 'Triaged one', 'triaged', 'mini_run', $3, $4, $5, $5,
                   now() - make_interval(days => $6::int) + interval '1 day', now() - make_interval(days => $6::int), $7)`,
          [newId(), co, c.turn, proj.turn, admin, back, site()],
        );
      }

      // turn: a conversation. The client wrote 5 days ago and we answered a day later; a second client message in the SAME turn
      // is not a second sample.
      const thread = newId();
      await q.query(
        `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
         VALUES ($1, $2, $3, NULL, 'General', $4, 'staff', $5)`,
        [thread, co, c.turn, admin, site()],
      );
      const message = (side: "client" | "staff", daysAgo: number, hoursAgo = 0) =>
        q.query(
          `INSERT INTO conversation_messages (id, tenant_id, thread_id, author_id, author_side, body, created_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'hi', now() - make_interval(days => $6::int, hours => $7::int), $8)`,
          [newId(), co, thread, admin, side, daysAgo, hoursAgo, site()],
        );
      await message("client", 5);
      await message("client", 5, -1); // an hour later, same turn
      await message("staff", 4);
    });

    // site: a monitor with results (3 up, 1 down: 75%) and an incident open for 2 hours.
    await withTenants([co], async (q) => {
      const monitor = newId();
      await q.query(
        `INSERT INTO monitors (id, tenant_id, client_id, name, kind, target, status, origin_site)
         VALUES ($1, $2, $3, 'Homepage', 'http', 'https://h-site.example/', 'down', $4)`,
        [monitor, co, c.site, site()],
      );
      for (const [hoursAgo, status] of [[1, "up"], [2, "up"], [3, "up"], [4, "down"]] as const) {
        await q.query(
          `INSERT INTO monitor_results (tenant_id, client_id, monitor_id, checked_at, status)
           VALUES ($1, $2, $3, now() - make_interval(hours => $4::int), $5)`,
          [co, c.site, monitor, hoursAgo, status],
        );
      }
      await q.query(
        `INSERT INTO monitor_incidents (id, tenant_id, client_id, monitor_id, opened_at) VALUES ($1, $2, $3, $4, now() - interval '2 hours')`,
        [newId(), co, c.site, monitor],
      );
    }, MONITORING);

    // Delivery on time (PV7-05): ontrack has 3 of 4 due-dated completions on time THIS MONTH, and one more fact row last
    // month that must not count; wait8 has completions but none carried a due date (0/0: no answer, never 0%).
    await withTenants([co], async (q) => {
      const fact = (project: string, dateSql: string, tc: number, onTime: number, withDue: number) =>
        q.query(
          `INSERT INTO report_work_facts (id, tenant_id, fact_date, project_id, tasks_completed, tasks_completed_on_time, tasks_completed_with_due_date, origin_site)
           VALUES ($1, $2, ${dateSql}, $3, $4, $5, $6, $7)`,
          [newId(), co, project, tc, onTime, withDue, site()],
        );
      await fact(proj.ontrack, "current_date", 3, 2, 3);
      await fact(proj.ontrack, "current_date", 1, 1, 1);
      await fact(proj.ontrack, "(date_trunc('month', current_date) - interval '1 day')::date", 5, 0, 5);
      await fact(proj.wait8, "current_date", 2, 0, 0);
    }, { modules: ["reports"] });

    // social: no project at all, but an active engagement (an active SERVICE), and one post the client has not reviewed yet.
    await withTenants([co], async (q) => {
      const engagement = newId();
      const org = newId();
      const account = newId();
      await q.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1, $2, $3, 'H engagement', $4, 'active', $5, 10, $6)`,
        [engagement, co, c.social, admin, JSON.stringify({ networks: { instagram: true }, posting: { requiresClientOk: true } }), site()],
      );
      await q.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', 'h-org', 'default', 'active', $4)`,
        [org, co, c.social, site()],
      );
      await q.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1, $2, $3, $4, 'instagram', '@h', 'connected', '{}', $5)`,
        [account, co, c.social, org, site()],
      );
      const post = newId();
      const variant = newId();
      const sha = variantArgsSha256({ tenantId: co, id: variant, accountId: account, body: "copy", firstComment: null, media: [], settings: {}, scheduledAt: null });
      await q.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1, $2, $3, 'H post', 'draft', $4)`, [post, co, engagement, site()]);
      await q.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
         VALUES ($1, $2, $3, $4, 'copy', $5, 'draft', $6)`,
        [variant, co, post, account, sha, site()],
      );
      await q.query(
        `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, origin_site)
         VALUES ($1, $2, $3, $4, 'pending', now(), $5)`,
        [newId(), co, variant, c.social, site()],
      );
    }, SOCIAL);

    app = await buildApp();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── the board ────────────────────────────────────────────────────────────────────────────────────
  describe("the board", () => {
    it("lists every live client once, and leaves out the archived, the internal and the deleted", async () => {
      const b = await board();
      const names = b.clients.map((r) => r.name);
      for (const n of ["quiet", "ontrack", "wait8", "off15", "late", "late14", "inv", "inv30", "site", "waitclient", "social", "turn"]) {
        expect(names, `H ${n} is on the board`).toContain(`H ${n}`);
      }
      for (const n of ["archived", "internal", "deleted"]) expect(names, `H ${n} is not`).not.toContain(`H ${n}`);
      expect(new Set(b.clients.map((r) => r.clientId)).size).toBe(b.clients.length);
      expect(b.unavailable).toEqual([]);
      expect(() => new Date(b.asOf).toISOString()).not.toThrow();
    });

    it("every source answered, so no signal is null (a null would be a source that failed)", async () => {
      const b = await board();
      for (const row of b.clients) {
        for (const [k, v] of Object.entries(row.signals)) {
          // PV7-05: delivery on time is null for a client with no due-dated completion this month (no answer, not 0%).
          if (k === "deliveryOnTime") continue;
          expect(v, `${row.name}.${k}`).not.toBeNull();
        }
      }
    });

    it("delivery on time: month to date, a ratio of sums, null with no due-dated completion (PV7-05)", async () => {
      const b = await board();
      // 3 of 4 this month; last month's 0 of 5 is outside the range.
      expect(rowOf(b, "ontrack").signals.deliveryOnTime).toBeCloseTo(0.75, 10);
      // Completions with no due date: denominator 0, so null, never 0.
      expect(rowOf(b, "wait8").signals.deliveryOnTime).toBeNull();
      // No facts at all.
      expect(rowOf(b, "quiet").signals.deliveryOnTime).toBeNull();
      expect(b.unavailable).toEqual([]);
    });

    it("quiet: no project, no service", async () => {
      const r = rowOf(await board(), "quiet");
      expect(r.state).toBe("quiet");
      expect(r.reasons).toEqual([{ code: "no_active_work", count: 0, since: null }]);
      expect(r.signals.activeProjects).toBe(0);
      expect(r.signals.activeServices).toBe(0);
    });

    it("on track: an active project and nothing outstanding", async () => {
      const r = rowOf(await board(), "ontrack");
      expect(r.state).toBe("on_track");
      expect(r.reasons).toEqual([]);
      expect(r.signals.activeProjects).toBe(1);
    });

    it("a payment waiting for us 8 days is at risk (waiting_on_us_7d), and the signal carries its age", async () => {
      const r = rowOf(await board(), "wait8");
      expect(r.state).toBe("at_risk");
      expect(r.reasons.map((x) => x.code)).toEqual(["waiting_on_us_7d"]);
      expect(r.signals.waitingOnUs?.count).toBe(1);
      const ageDays = (Date.now() - Date.parse(r.signals.waitingOnUs!.oldestSince!)) / 86_400_000;
      expect(ageDays).toBeGreaterThan(7.9);
      expect(ageDays).toBeLessThan(8.5);
    });

    it("a change request untriaged for 15 days is off track, and counts as an open request", async () => {
      const r = rowOf(await board(), "off15");
      expect(r.state).toBe("off_track");
      expect(r.reasons.map((x) => x.code)).toEqual(["waiting_on_us_14d"]);
      expect(r.signals.openChangeRequests).toBe(1);
    });

    it("a milestone 3 days late is at risk (late_work); a done milestone and a future one are not late", async () => {
      const r = rowOf(await board(), "late");
      expect(r.state).toBe("at_risk");
      expect(r.reasons).toEqual([expect.objectContaining({ code: "late_work", count: 1 })]);
      expect(r.signals.lateMilestones?.count).toBe(1);
      expect(r.signals.lateDeliverables?.count).toBe(0);
    });

    it("a deliverable 20 days late is off track (late_work_14d); a delivered one is not late", async () => {
      const r = rowOf(await board(), "late14");
      expect(r.state).toBe("off_track");
      expect(r.reasons).toEqual([expect.objectContaining({ code: "late_work_14d", count: 1 })]);
      expect(r.signals.lateDeliverables?.count).toBe(1);
    });

    it("an issued invoice 15 days overdue is at risk; one 45 days overdue is off track", async () => {
      const b = await board();
      expect(rowOf(b, "inv").state).toBe("at_risk");
      expect(rowOf(b, "inv").reasons.map((x) => x.code)).toEqual(["invoice_overdue"]);
      expect(rowOf(b, "inv").signals.overdueInvoices?.count).toBe(1);
      expect(rowOf(b, "inv30").state).toBe("off_track");
      expect(rowOf(b, "inv30").reasons.map((x) => x.code)).toEqual(["invoice_overdue_30d"]);
    });

    it("a site incident open 2 hours is at risk, with the 30-day uptime from the monitoring console's own ratio", async () => {
      const r = rowOf(await board(), "site");
      expect(r.state).toBe("at_risk");
      expect(r.reasons.map((x) => x.code)).toEqual(["site_incident_open"]);
      expect(r.signals.site?.openIncidents).toBe(1);
      expect(r.signals.site?.uptime30d).toBe(75);
    });

    it("a client with no monitor has a site of zero incidents and a null uptime, not a null site", async () => {
      const r = rowOf(await board(), "ontrack");
      expect(r.signals.site).toEqual({ openIncidents: 0, oldestOpenSince: null, uptime30d: null });
    });

    it("waiting on the client 15 days is at risk (waiting_on_client_14d)", async () => {
      const r = rowOf(await board(), "waitclient");
      expect(r.state).toBe("at_risk");
      expect(r.reasons.map((x) => x.code)).toEqual(["waiting_on_client_14d"]);
      expect(r.signals.waitingOnClient?.count).toBe(1);
    });

    it("THE SOCIAL WALL: an unreviewed post counts (the ball read declares the social scope), and an active engagement is an active service", async () => {
      const r = rowOf(await board(), "social");
      expect(r.signals.waitingOnClient?.count).toBe(1);
      expect(r.signals.activeServices).toBe(1);
      expect(r.signals.activeProjects).toBe(0);
      expect(r.state).toBe("on_track"); // not quiet: it has a service
    });

    it("THE SOCIAL WALL, proven load-bearing: the same read with the scope dropped sees ZERO reviews and raises nothing", async () => {
      const dropScope: SourceReader = (t, source, modules, fn) =>
        withTenants([t], fn, source === "ball" ? undefined : modules ? { modules } : undefined);
      const b = await loadClientHealthBoard(co, { read: dropScope });
      const r = b.clients.find((x) => x.clientId === c.social)!;
      expect(r.signals.waitingOnClient?.count).toBe(0);
      expect(b.unavailable).toEqual([]);
    });
  });

  // ── cost ──────────────────────────────────────────────────────────────────────────────────────────
  describe("cost", () => {
    const count = async () => {
      const seen: string[] = [];
      const b = await loadClientHealthBoard(co, { onQuery: (sql) => seen.push(sql) });
      return { n: seen.length, clients: b.clients.length };
    };

    it("a fixed number of queries whatever the client count (the board is one read per source, not per client)", async () => {
      const before = await count();
      // 40 more clients, each with a project, so every source has more rows to return.
      for (let i = 0; i < 40; i++) {
        const id = await createClient(co, `H bulk ${String(i).padStart(2, "0")}`);
        await createProject(co, `H bulk project ${i}`, admin, id);
      }
      const after = await count();
      expect(after.clients).toBe(before.clients + 40);
      expect(after.n).toBe(before.n);
      // The absolute number, so an extra query added to a source is noticed: 1 (clients) + projects, milestones, deliverables,
      // requests, invoices (5) + the ball (8) + the site (2) + services (2: social and webdev are on, search is not)
      // + delivery on time (1, PV7-05: one set query over report_work_facts, under the reports wall) = 19.
      expect(before.n).toBe(19);
    });
  });

  // ── a source that fails ───────────────────────────────────────────────────────────────────────────
  describe("a source that fails", () => {
    const failing = (...sources: string[]): SourceReader => (t, source, modules, fn) => {
      if (sources.includes(source)) throw new Error(`boom: ${source}`);
      return withTenants([t], fn, modules ? { modules } : undefined);
    };

    it("is named in unavailable[], its signal is null (never 0), and an on-track client reads unknown", async () => {
      const b = await loadClientHealthBoard(co, { read: failing("invoices") });
      expect(b.unavailable).toEqual(["invoices"]);
      const ok = b.clients.find((x) => x.clientId === c.ontrack)!;
      expect(ok.signals.overdueInvoices).toBeNull();
      expect(ok.state).toBe("unknown");
      expect(ok.reasons).toEqual([{ code: "source_unavailable", count: 1, since: null }]);
      // The other sources still answered.
      expect(ok.signals.activeProjects).toBe(1);
    });

    it("never hides a real finding: a client already off track stays off track, and a quiet one reads unknown", async () => {
      const b = await loadClientHealthBoard(co, { read: failing("invoices") });
      expect(b.clients.find((x) => x.clientId === c.off15)!.state).toBe("off_track");
      expect(b.clients.find((x) => x.clientId === c.quiet)!.state).toBe("unknown");
    });

    it("delivery on time failing is named `reports`, nulls the figure, and never turns a state into unknown (display only)", async () => {
      const b = await loadClientHealthBoard(co, { read: failing("reports") });
      expect(b.unavailable).toEqual(["reports"]);
      const r = b.clients.find((x) => x.clientId === c.ontrack)!;
      expect(r.signals.deliveryOnTime).toBeNull();
      expect(r.state).toBe("on_track");
      expect(r.signals.activeProjects).toBe(1);
    });

    it("the reports module being off is not a failure: the figure is null and `reports` is not unavailable", async () => {
      const b = await loadClientHealthBoard(co, { enabled: new Set(["clients", "invoice", "pm", "social", "webdev", "monitoring"]) });
      expect(b.unavailable).toEqual([]);
      expect(b.clients.find((x) => x.clientId === c.ontrack)!.signals.deliveryOnTime).toBeNull();
    });

    it("THE REPORTS WALL: the same read without the `reports` scope sees zero facts, so the figure is null", async () => {
      const noWall: SourceReader = (t, _source, _modules, fn) => withTenants([t], fn);
      const b = await loadClientHealthBoard(co, { read: noWall });
      expect(b.clients.find((x) => x.clientId === c.ontrack)!.signals.deliveryOnTime).toBeNull();
    });

    it("the ball failing nulls both waiting signals and the conversation count together", async () => {
      const b = await loadClientHealthBoard(co, { read: failing("ball") });
      expect(b.unavailable).toEqual(["ball"]);
      const r = b.clients.find((x) => x.clientId === c.wait8)!;
      expect(r.signals.waitingOnUs).toBeNull();
      expect(r.signals.waitingOnClient).toBeNull();
      expect(r.signals.conversationsAwaitingReply).toBeNull();
      expect(r.state).toBe("unknown");
    });

  });

  // ── the one-client read ──────────────────────────────────────────────────────────────────────────
  describe("the one-client read", () => {
    it("carries the board row, the project, and the milestone and deliverable counts (late counted, done not)", async () => {
      const r = await detail(c.late);
      expect(r.statusCode, r.body.slice(0, 400)).toBe(200);
      const d = r.json() as ClientHealthDetail;
      expect(d.clientId).toBe(c.late);
      expect(d.state).toBe("at_risk");
      expect(d.unavailable).toEqual([]);
      expect(d.projects).toHaveLength(1);
      const p = d.projects![0];
      expect(p.projectId).toBe(proj.late);
      expect(p.clientVisible).toBe(true);
      expect(p.milestones).toEqual({ total: 3, done: 1, upcoming: 1, late: 1, undated: 0 });
      expect(p.deliverables).toEqual({ total: 1, delivered: 0, late: 0 });
      expect(p.nextMilestone?.name).toBe("Late one"); // the earliest OPEN milestone with a date, as the hub overview reads it
    });

    it("turnaround: a median over 3 samples is given, one over 2 is withheld, and an INTERNAL gate is never a sample", async () => {
      const d = (await (await detail(c.turn)).json()) as ClientHealthDetail;
      expect(d.turnaround?.windowDays).toBe(90);
      const gate = d.turnaround!.client.parts.find((p) => p.kind === "client_gate")!;
      expect(gate).toEqual({ kind: "client_gate", medianDays: 2, n: 3, withheld: false, clientVisible: true });
      // The side pools its samples: the three client gates are the only client-side samples.
      expect(d.turnaround!.client.n).toBe(3);
      expect(d.turnaround!.client.medianDays).toBe(2);
      const triage = d.turnaround!.ours.parts.find((p) => p.kind === "change_request_triage")!;
      expect(triage).toMatchObject({ n: 2, withheld: true, medianDays: null, clientVisible: true });
      // One reply sample: the client wrote 5 days ago and we answered a day later; the second client message of the same turn is no sample.
      const reply = d.turnaround!.ours.parts.find((p) => p.kind === "conversation_reply")!;
      expect(reply).toMatchObject({ n: 1, withheld: true, medianDays: null });
      // Six parts, always, in a fixed order.
      expect(d.turnaround!.client.parts.map((p) => p.kind)).toEqual(["client_gate", "contract_signed", "post_review"]);
      expect(d.turnaround!.ours.parts.map((p) => p.kind)).toEqual(["change_request_triage", "payment_confirmed", "conversation_reply"]);
      // The pooled side: 2 triaged + 1 reply = 3 samples, so the OUR side median is given.
      expect(d.turnaround!.ours.n).toBe(3);
      expect(d.turnaround!.ours.withheld).toBe(false);
      expect(d.turnaround!.ours.medianDays).toBe(1);
    });

    it("onTimeKnownSince is an instant or null, and never invented", async () => {
      const d = (await (await detail(c.late)).json()) as ClientHealthDetail;
      expect(d.onTimeKnownSince === null || !Number.isNaN(Date.parse(d.onTimeKnownSince))).toBe(true);
    });

    it("404 for a client that does not exist, is deleted, is the internal sentinel, or is not an id", async () => {
      for (const id of [newId(), c.deleted, c.internal, "not-a-uuid"]) {
        const r = await detail(id);
        expect(r.statusCode, `${id}: ${r.body.slice(0, 120)}`).toBe(404);
      }
    });
  });

  // ── who may read ─────────────────────────────────────────────────────────────────────────────────
  describe("access", () => {
    it("a user who is not in the company is refused, on the board and on one client", async () => {
      const a = await app.inject({ method: "GET", url: `/api/${co}/clients/health`, headers: asUser(outsider) });
      expect(a.statusCode).toBe(403);
      const b = await app.inject({ method: "GET", url: `/api/${co}/clients/${c.late}/health`, headers: asUser(outsider) });
      expect(b.statusCode).toBe(403);
    });

    it("a client contact is refused the staff board (the portal has its own, narrower view)", async () => {
      const contact = await createUser("contact@health.test", "Cora Contact");
      await addMembership(co, contact);
      await grantRole(contact, await createRole("client"), "company", co);
      await withGlobal((q) => q.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [contact]));
      const r = await app.inject({ method: "GET", url: `/api/${co}/clients/health`, headers: asUser(contact) });
      expect(r.statusCode).toBe(403);
    });

    it("a malformed tenant id is a 400 at the router, never a 500", async () => {
      const r = await app.inject({ method: "GET", url: `/api/not-a-uuid/clients/health`, headers: asUser(admin) });
      expect(r.statusCode).toBe(400);
    });
  });
});
