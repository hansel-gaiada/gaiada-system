// PV3-07 — `clientVisible` on staff payloads, PROVEN against the portal.
//
// The flag means one thing: a CLIENT-WIDE contact of the row's client can read this row in the portal.
// It is composed in SQL from `portal-visibility.ts`. This suite does not re-derive that rule; it asks
// both sides. Per kind, the ids a staff reader marks `clientVisible: true` must EQUAL the ids the portal
// endpoints return to a client-wide signer of the same client, and every fixture kind carries at least
// one hidden row, so the equality is never satisfied by "everything" or "nothing".
//
// It also pins the portal's NULL-project arms directly, through a PROJECT-SCOPED contact: such a contact
// sees a project-less contract and change request, and does not see a project-less run. PV3-02's teeth
// run showed that no other portal suite catches a change to those arms.
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count). Follows
// portal-payloads.db.test.ts's app.inject() harness. Runs on the Linux server gate, not locally.
//
// Teeth (both recorded in the PV3-07 hand-back):
//   1. In contracts.controller.ts, replace `staffClientVisible("k", contractClientVisible("k"))` with the
//      hand-written `(k.client_id IS NOT NULL AND k.deleted_at IS NULL)` (draft forgotten) and the
//      contracts parity fails on the draft.
//   (PV3-07 follow-up, detail reads) In client-work.controller.ts, replace the detail's
//   `staffDeliverableClientVisible("d", "dp")` with the hand-written `(d.client_id IS NOT NULL AND d.deleted_at IS NULL)`
//   and the deliverable-detail test fails on d3 (no client_id of its own, yet visible through its project).
//   2. In portal-visibility.ts, flip `contractInPortalScope`'s NULL-project arm (`true` -> `false`) and
//      the project-scoped contract assertion fails; flip `runInPortalScope`'s (`false` -> `true`) and
//      the project-scoped run assertion fails.
//   3. (PV4-05, meeting minutes) In portal-visibility.ts, drop `status = 'shared'` from `meetingMinutesClientVisible`:
//      the portal then lists the draft, and the minutes parity fails on it. Flip `meetingMinutesInPortalScope`'s
//      NULL-project arm (`false` -> `true`) and the project-scoped contact's minutes assertion fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { variantArgsSha256 } from "../modules/social/canonical-args";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { FIXTURE_TERMS, FIXTURE_TERMS_SHA256 } from "../testing/contract-fixtures";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { newId, withTenants, withGlobal } from "../db";
import { NEVER_CLIENT_VISIBLE } from "./portal-visibility";
import { ensureBillingSetup } from "../seed/billing-setup";
import { issueInvoice } from "../modules/invoice/issue";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };
const site = () => config.originSite;

type Row = { id: string; clientVisible?: unknown };

describe.skipIf(!TEST_URL)("PV3-07 · clientVisible parity with the portal", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // staff, company_admin
  let signer: string; // client-wide signer contact of `client`
  let scoped: string; // contact of `client` restricted to project p1
  let revoked: string; // a revoked contact of `client`
  let client: string;
  let p1: string; // client project (the scoped contact's)
  let p2: string; // client project (not the scoped contact's)
  let pInternal: string; // no client

  // Fixture ids, by kind. `shown` = the portal shows it to the signer; `hidden` = it does not.
  const f = {
    d1: newId(), d3: newId(), dInternal: newId(),
    kDraft: newId(), kSent: newId(), kSentP2: newId(),
    iDraft: newId(), iSent: newId(), iNoClient: newId(),
    payPendingSent: newId(), payConfirmedSent: newId(), payPendingDraft: newId(),
    r1: newId(), r0: newId(), rInternal: newId(),
    g1: newId(), g2: newId(), g3: newId(), g4: newId(),
    cr0: newId(), cr2: newId(), crInternal: newId(),
    reviewPending: newId(), reviewChanges: newId(),
    task: newId(), meeting: newId(),
    // PV4-05: four meetings with minutes. Shared on a project; shared on no project; a DRAFT; shared on a meeting with NO CLIENT.
    meetShared: newId(), meetWide: newId(), meetDraft: newId(), meetNoClient: newId(),
    mmShared: newId(), mmWide: newId(), mmDraft: newId(), mmNoClient: newId(),
  };

  const get = async (user: string, path: string) => {
    const r = await app.inject({ method: "GET", url: `/api/${co}${path}`, headers: asUser(user) });
    expect(r.statusCode, `GET ${path} as ${user === admin ? "staff" : "client"}: ${r.body.slice(0, 300)}`).toBe(200);
    return r.json();
  };

  /** The parity assertion. Every staff row must carry a real boolean; the `true` ids must equal the
   *  portal's ids; and the fixture must contain a hidden row of this kind, so the check has teeth. */
  const expectParity = (kind: string, staffRows: Row[], portalIds: string[]) => {
    for (const r of staffRows) expect(typeof r.clientVisible, `${kind} ${r.id}: clientVisible is a boolean`).toBe("boolean");
    const staffTrue = staffRows.filter((r) => r.clientVisible === true).map((r) => r.id).sort();
    expect(staffTrue, `${kind}: staff clientVisible=true ids == portal ids`).toEqual([...new Set(portalIds)].sort());
    expect(staffRows.some((r) => r.clientVisible === false), `${kind}: the fixture has a hidden row`).toBe(true);
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Parity Co", ["clients", "invoice", "pm", "social", "webdev"]);
    admin = await createUser("admin@pv307.test", "Ada Admin");
    signer = await createUser("signer@pv307.test", "Sam Signer");
    scoped = await createUser("scoped@pv307.test", "Pat Scoped");
    revoked = await createUser("revoked@pv307.test", "Rex Revoked");
    for (const u of [admin, signer, scoped, revoked]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    const clientRole = await createRole("client");
    await grantRole(signer, clientRole, "company", co);
    await grantRole(scoped, clientRole, "company", co);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'client' WHERE id = ANY($1::uuid[])`, [[signer, scoped, revoked]]));

    client = await createClient(co, "Parity Client");
    p1 = await createProject(co, "Parity — website", admin);
    p2 = await createProject(co, "Parity — campaign", admin);
    pInternal = await createProject(co, "Own brand", admin);

    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET client_id = $2 WHERE id = ANY($1::uuid[])`, [[p1, p2], client]);
      await c.query(`UPDATE projects SET is_internal = true WHERE id = $1`, [pInternal]);

      // Contacts: a client-wide signer, a project-scoped viewer, a revoked one.
      const contact = (userId: string, projectId: string | null, capability: string, status: string) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
          [newId(), co, client, userId, projectId, capability, status, site()],
        );
      await contact(signer, null, "signer", "active");
      await contact(scoped, p1, "viewer", "active");
      await contact(revoked, null, "viewer", "revoked");

      // Deliverables. d3 has NO client_id of its own: its visibility travels through p1, as the portal's does.
      const deliverable = (id: string, projectId: string, clientId: string | null, name: string) =>
        c.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'pending', current_date + 7, $6)`,
          [id, co, projectId, clientId, name, site()],
        );
      await deliverable(f.d1, p1, client, "Homepage");
      await deliverable(f.d3, p1, null, "Logo (no client_id of its own)");
      await deliverable(f.dInternal, pInternal, null, "Own-brand banner");

      // Contracts: a draft (hidden), a project-less sent one, a sent one on p2.
      const contract = (id: string, projectId: string | null, status: string, title: string) =>
        c.query(
          `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, status, currency, sent_at, body_md,
                                  content_sha256, content_fixed_at, signature_tier, created_by, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'IDR', CASE WHEN $6 = 'draft' THEN NULL ELSE now() END, $9,
                   CASE WHEN $6 = 'draft' THEN NULL ELSE $10 END, CASE WHEN $6 = 'draft' THEN NULL ELSE now() END,
                   CASE WHEN $6 = 'draft' THEN NULL ELSE 'attested' END, $7, $8)`,
          [id, co, client, projectId, title, status, admin, site(), FIXTURE_TERMS, FIXTURE_TERMS_SHA256],
        );
      await contract(f.kDraft, null, "draft", "Draft SOW");
      await contract(f.kSent, null, "sent", "Master agreement");
      await contract(f.kSentP2, p2, "sent", "Campaign SOW");

      // Invoices: draft (hidden), issued, and a client-visible status with no client (hidden: nobody can read it).
      // PV5-04: `sent` means ISSUED (PV5-01b), so iSent is inserted `approved` and issued through the real path once
      // this transaction commits (below); an invoice with no client cannot be issued, so iNoClient is a `void` one.
      const invoice = (id: string, clientId: string | null, status: string) =>
        c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
           VALUES ($1, $2, $3, current_date - 30, current_date - 1, $4, 'IDR', '[{"description":"Work","amount":1000}]'::jsonb, 1000, $5)`,
          [id, co, clientId, status, site()],
        );
      await invoice(f.iDraft, client, "draft");
      await invoice(f.iSent, client, "approved");
      await invoice(f.iNoClient, null, "void");

      // Payments: pending + confirmed on the issued invoice; a pending claim on the draft (hidden through
      // its invoice, even though the payment row itself names the client).
      const payment = (id: string, invoiceId: string, status: string) =>
        c.query(
          `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, origin_site)
           VALUES ($1, $2, $3, $4, 100, 'IDR', current_date - 2, $5, $6)`,
          [id, co, invoiceId, client, status, site()],
        );
      await payment(f.payPendingSent, f.iSent, "pending");
      await payment(f.payConfirmedSent, f.iSent, "confirmed");
      await payment(f.payPendingDraft, f.iDraft, "pending");

      // Runs: on p1, with NO project, and with no client. Gates: client + internal on r1, a client gate
      // on the project-less run, and a client gate on the clientless run (hidden through its run).
      const run = (id: string, clientId: string | null, projectId: string | null, title: string) =>
        c.query(
          `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
           VALUES ($1, $2, $3, 'delivery_active', $4, $5, $6)`,
          [id, co, title, clientId, projectId, site()],
        );
      await run(f.r1, client, p1, "Website delivery");
      await run(f.r0, client, null, "Client-wide delivery");
      await run(f.rInternal, null, null, "Own-brand delivery");
      const gate = (id: string, runId: string, kind: string, side: string) =>
        c.query(
          `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
          [id, co, runId, kind, side, site()],
        );
      await gate(f.g1, f.r1, "prd_sign", "client");
      await gate(f.g2, f.r1, "pm_review", "internal");
      await gate(f.g3, f.r0, "prd_sign", "client");
      await gate(f.g4, f.rInternal, "prd_sign", "client");
      const stage = (runId: string, track: string, name: string) =>
        c.query(
          `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'done', $6)`,
          [newId(), co, runId, track, name, site()],
        );
      await stage(f.r1, "delivery", "prd_extract");
      await stage(f.r1, "report", "report_extract");

      // Change requests: project-less (client-wide), on p2, and a staff-logged one with no client.
      const cr = (id: string, source: string, clientId: string | null, projectId: string | null, title: string) =>
        c.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, client_id, project_id, requested_by, origin_site)
           VALUES ($1, $2, $3, 'content', $4, 'new', $5, $6, $7, $8)`,
          [id, co, source, title, clientId, projectId, source === "portal" ? signer : null, site()],
        );
      await cr(f.cr0, "portal", client, null, "Update the footer");
      await cr(f.cr2, "portal", client, p2, "Campaign banner copy");
      await cr(f.crInternal, "internal", null, null, "Rotate our own TLS cert");

      // A task and a meeting: never client-visible, whatever their row state.
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, origin_site) VALUES ($1, $2, $3, 'Build hero', 'todo', $4)`,
        [f.task, co, p1, site()],
      );
      await c.query(
        `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, client_id, project_id, title, origin_site)
         VALUES ($1, $2, 'pv307-meet', $3, $4, 'Kickoff', $5)`,
        [f.meeting, co, client, p1, site()],
      );

      // PV4-05: meetings with minutes. Minutes carry no client or project of their own: both come from the meeting.
      const meeting = (id: string, clientId: string | null, projectId: string | null, title: string) =>
        c.query(
          `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, client_id, project_id, title, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, co, `pv405-${id}`, clientId, projectId, title, site()],
        );
      await meeting(f.meetShared, client, p1, "Shared on a project");
      await meeting(f.meetWide, client, null, "Shared, client-wide");
      await meeting(f.meetDraft, client, p1, "Draft minutes");
      await meeting(f.meetNoClient, null, null, "Internal, shared stamp but no client");
      const minutes = (id: string, meetingId: string, status: "draft" | "shared") =>
        c.query(
          `INSERT INTO meeting_minutes (id, tenant_id, meeting_recording_id, body_md, status, shared_at, shared_by)
           VALUES ($1, $2, $3, 'Minutes text', $4, $5, $6)`,
          [id, co, meetingId, status, status === "shared" ? new Date() : null, status === "shared" ? admin : null],
        );
      await minutes(f.mmShared, f.meetShared, "shared");
      await minutes(f.mmWide, f.meetWide, "shared");
      await minutes(f.mmDraft, f.meetDraft, "draft");
      await minutes(f.mmNoClient, f.meetNoClient, "shared");
    });

    // Post reviews: one pending (needsClient) and one sent back for changes (needsUs). The posts and
    // variants sit behind the social third wall, so they are seeded with the module scope.
    const engagement = newId();
    const org = newId();
    const account = newId();
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1, $2, $3, 'PV3-07 engagement', $4, 'active', $5, 10, $6)`,
        [engagement, co, client, admin, JSON.stringify({ networks: { instagram: true }, posting: { requiresClientOk: true } }), site()],
      );
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', 'pv307-org', 'default', 'active', $4)`,
        [org, co, client, site()],
      );
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1, $2, $3, $4, 'instagram', '@pv307', 'connected', '{}', $5)`,
        [account, co, client, org, site()],
      );
      for (const [reviewId, status] of [[f.reviewPending, "pending"], [f.reviewChanges, "changes_requested"]] as const) {
        const post = newId();
        const variant = newId();
        const sha = variantArgsSha256({
          tenantId: co, id: variant, accountId: account, body: "copy", firstComment: null, media: [], settings: {}, scheduledAt: null,
        });
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1, $2, $3, $4, 'draft', $5)`,
          [post, co, engagement, `Post ${status}`, site()],
        );
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, args_sha256, status, origin_site)
           VALUES ($1, $2, $3, $4, 'copy', $5, 'draft', $6)`,
          [variant, co, post, account, sha, site()],
        );
        await c.query(
          `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, decided_by, decided_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8)`,
          [reviewId, co, variant, client, status, status === "pending" ? null : signer, status === "pending" ? null : new Date(), site()],
        );
      }
    }, SOCIAL);

    await ensureBillingSetup(co);
    // PV5-04b: an invoice needs a service line to be numbered (the seeded `services` line).
    await withTenants([co], (c) => c.query(`UPDATE invoices SET service_line_key = 'services' WHERE id = $1`, [f.iSent]));
    await issueInvoice(co, f.iSent, admin);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── The NULL-project arms, through a project-scoped contact ─────────────────────────────────────
  describe("a project-scoped contact (the arms no other portal suite pins)", () => {
    it("sees a project-less contract, and not a contract on another project", async () => {
      const ids = ((await get(scoped, "/portal/contracts")) as Row[]).map((r) => r.id);
      expect(ids).toContain(f.kSent);
      expect(ids).not.toContain(f.kSentP2);
    });

    it("sees a project-less change request, and not one on another project", async () => {
      const ids = ((await get(scoped, "/portal/change-requests")) as Row[]).map((r) => r.id);
      expect(ids).toContain(f.cr0);
      expect(ids).not.toContain(f.cr2);
    });

    it("PV4-05: does NOT see the minutes of a project-less meeting, only its own project's (PV4-Q1)", async () => {
      const ids = ((await get(scoped, "/portal/meetings")) as Row[]).map((r) => r.id);
      expect(ids).toContain(f.mmShared);
      expect(ids).not.toContain(f.mmWide);
      expect(ids).not.toContain(f.mmDraft);
    });

    it("does NOT see a project-less run, only its own project's", async () => {
      const ids = ((await get(scoped, "/portal/runs")) as Row[]).map((r) => r.id);
      expect(ids).toContain(f.r1);
      expect(ids).not.toContain(f.r0);
    });
  });

  // ── Parity, kind by kind ────────────────────────────────────────────────────────────────────────
  it("projects", async () => {
    const staff = (await get(admin, "/projects")) as Row[];
    const portal = (await get(signer, "/portal/projects")) as Row[];
    expectParity("project", staff, portal.map((r) => r.id));
    expect(staff.find((r) => r.id === pInternal)?.clientVisible).toBe(false);
  });

  it("deliverables (through the project, not the deliverable's own client_id)", async () => {
    const staff = (await get(admin, "/deliverables")) as Row[];
    const portal = (await get(signer, "/portal/deliverables")) as Row[];
    expectParity("deliverable", staff, portal.map((r) => r.id));
    expect(staff.find((r) => r.id === f.d3)?.clientVisible).toBe(true);
  });

  it("contracts: list and detail", async () => {
    const staff = (await get(admin, "/contracts")) as Row[];
    const portal = (await get(signer, "/portal/contracts")) as Row[];
    expectParity("contract", staff, portal.map((r) => r.id));
    expect(((await get(admin, `/contracts/${f.kDraft}`)) as Row).clientVisible).toBe(false);
    expect(((await get(admin, `/contracts/${f.kSent}`)) as Row).clientVisible).toBe(true);
  });

  it("invoices", async () => {
    const staff = (await get(admin, "/invoices")) as Row[];
    const portal = (await get(signer, "/portal/invoices")) as Row[];
    expectParity("invoice", staff, portal.map((r) => r.id));
    expect(staff.find((r) => r.id === f.iNoClient)?.clientVisible).toBe(false);
  });

  it("invoice payments (through the invoice, the portal's detail context)", async () => {
    const staff = (await get(admin, "/invoice-payments")) as Row[];
    const invoices = (await get(signer, "/portal/invoices")) as Row[];
    const portal: string[] = [];
    for (const inv of invoices) {
      const detail = (await get(signer, `/portal/invoices/${inv.id}`)) as { payments: Row[] };
      portal.push(...detail.payments.map((p) => p.id));
    }
    expectParity("invoice payment", staff, portal);
    expect(staff.find((r) => r.id === f.payPendingDraft)?.clientVisible).toBe(false);
  });

  it("runs, and their gates (list with include=gates, and the detail)", async () => {
    const staff = (await get(admin, "/pipeline/runs?include=gates")) as Array<Row & { gates: Row[] }>;
    const portalRuns = (await get(signer, "/portal/runs")) as Row[];
    expectParity("run", staff, portalRuns.map((r) => r.id));

    const portalGates: string[] = [];
    for (const r of portalRuns) {
      const detail = (await get(signer, `/portal/runs/${r.id}`)) as { gates: Row[] };
      portalGates.push(...detail.gates.map((g) => g.id));
    }
    expectParity("gate (list)", staff.flatMap((r) => r.gates), portalGates);

    const details = await Promise.all(staff.map((r) => get(admin, `/pipeline/runs/${r.id}`) as Promise<Row & { gates: Row[] }>));
    for (const d of details) expect(d.clientVisible, `run detail ${d.id}`).toBe(staff.find((r) => r.id === d.id)?.clientVisible);
    expectParity("gate (detail)", details.flatMap((d) => d.gates), portalGates);
  });

  it("run stages: the report track is hidden on the staff side exactly as the portal hides it", async () => {
    const staff = (await get(admin, `/pipeline/runs/${f.r1}`)) as { stages: Array<{ name: string; clientVisible?: unknown }> };
    const portal = (await get(signer, `/portal/runs/${f.r1}`)) as { stages: Array<{ name: string }> };
    expectParity(
      "run stage",
      staff.stages.map((s) => ({ id: s.name, clientVisible: s.clientVisible })),
      portal.stages.map((s) => s.name),
    );
  });

  it("change requests", async () => {
    const staff = (await get(admin, "/webdev/change-requests")) as Row[];
    const portal = (await get(signer, "/portal/change-requests")) as Row[];
    expectParity("change request", staff, portal.map((r) => r.id));
    expect(staff.find((r) => r.id === f.crInternal)?.clientVisible).toBe(false);
  });

  it("client contacts (what the portal People area lists)", async () => {
    const staff = (await get(admin, `/clients/${client}/contacts`)) as Array<{ userId: string; clientVisible?: unknown }>;
    const portal = (await get(signer, "/portal/profile")) as { contacts: Row[] };
    expectParity(
      "client contact",
      staff.map((r) => ({ id: r.userId, clientVisible: r.clientVisible })),
      portal.contacts.map((r) => r.id),
    );
  });

  it("meeting minutes: staff `clientVisible` equals presence in the portal list, with a hidden row of each hiding reason (draft, no client)", async () => {
    const portalIds = ((await get(signer, "/portal/meetings")) as Row[]).map((r) => r.id);
    const staff: Row[] = [];
    for (const [meetingId, minutesId] of [
      [f.meetShared, f.mmShared], [f.meetWide, f.mmWide], [f.meetDraft, f.mmDraft], [f.meetNoClient, f.mmNoClient],
    ] as const) {
      const r = (await get(admin, `/meetings/${meetingId}/minutes`)) as { minutes: { id: string; clientVisible: unknown } };
      expect(r.minutes.id).toBe(minutesId);
      staff.push({ id: r.minutes.id, clientVisible: r.minutes.clientVisible });
    }
    expectParity("meeting minutes", staff, portalIds.filter((id) => staff.some((s) => s.id === id)));
    expect(staff.find((r) => r.id === f.mmShared)?.clientVisible).toBe(true);
    expect(staff.find((r) => r.id === f.mmWide)?.clientVisible).toBe(true);
    expect(staff.find((r) => r.id === f.mmDraft)?.clientVisible).toBe(false);
    expect(staff.find((r) => r.id === f.mmNoClient)?.clientVisible).toBe(false);
    // The meeting itself is still never client-visible, with or without minutes.
    for (const m of [f.meeting, f.meetShared, f.meetWide]) {
      const r = (await get(admin, `/meetings/recordings/${m}`)) as Row;
      expect(r.clientVisible, `meeting ${m}`).toBe(false);
    }
  });

  it("tasks and meetings answer false from NEVER_CLIENT_VISIBLE", async () => {
    expect(NEVER_CLIENT_VISIBLE).toEqual(expect.arrayContaining(["task", "meeting"]));
    const tasks = ((await get(admin, "/pm/tasks")) as { items: Row[] }).items;
    expect(tasks.map((t) => t.id)).toContain(f.task);
    for (const t of tasks) expect(t.clientVisible, `task ${t.id}`).toBe(false);
    const meetings = (await get(admin, "/meetings/recordings")) as Row[];
    expect(meetings.map((m) => m.id)).toContain(f.meeting);
    for (const m of meetings) expect(m.clientVisible, `meeting ${m.id}`).toBe(false);
  });

  // PV3-07 follow-up: the DETAIL reads carry the flag too, and agree with the list AND the portal.
  describe("detail reads agree with the list and with the portal", () => {
    /** For every id the list returned: the detail row's `clientVisible` is a boolean equal to the list row's. */
    const expectDetailsMatchList = async (kind: string, listPath: string, detailPath: (id: string) => string, wantHidden = true) => {
      const list = (await get(admin, listPath)) as Row[];
      const rows = Array.isArray(list) ? list : (list as unknown as { items: Row[] }).items;
      expect(rows.length, `${kind}: the list is not empty`).toBeGreaterThan(0);
      const details = await Promise.all(rows.map(async (r) => ({ list: r, detail: (await get(admin, detailPath(r.id))) as Row })));
      for (const { list: l, detail: d } of details) {
        expect(typeof d.clientVisible, `${kind} detail ${l.id}: clientVisible is a boolean`).toBe("boolean");
        expect(d.clientVisible, `${kind} detail ${l.id}: detail == list`).toBe(l.clientVisible);
      }
      if (wantHidden) expect(details.some(({ detail }) => detail.clientVisible === false), `${kind}: a hidden detail row`).toBe(true);
      return details.map((x) => x.detail);
    };

    it("project detail == list == portal", async () => {
      const details = await expectDetailsMatchList("project", "/projects", (id) => `/projects/${id}`);
      const portal = ((await get(signer, "/portal/projects")) as Row[]).map((r) => r.id);
      expectParity("project (detail)", details, portal);
      expect(details.find((r) => r.id === pInternal)?.clientVisible).toBe(false);
    });

    it("deliverable detail == list == portal (through the project)", async () => {
      const details = await expectDetailsMatchList("deliverable", "/deliverables", (id) => `/deliverables/${id}`);
      const portal = ((await get(signer, "/portal/deliverables")) as Row[]).map((r) => r.id);
      expectParity("deliverable (detail)", details, portal);
      expect(details.find((r) => r.id === f.d3)?.clientVisible).toBe(true); // no client_id of its own
      expect(details.find((r) => r.id === f.dInternal)?.clientVisible).toBe(false);
    });

    it("change request detail == list == portal", async () => {
      const details = await expectDetailsMatchList("change request", "/webdev/change-requests", (id) => `/webdev/change-requests/${id}`);
      const portal = ((await get(signer, "/portal/change-requests")) as Row[]).map((r) => r.id);
      expectParity("change request (detail)", details, portal);
      expect(details.find((r) => r.id === f.crInternal)?.clientVisible).toBe(false);
    });

    it("meeting recording and PM task details answer false, as the list does", async () => {
      const meetings = await expectDetailsMatchList("meeting", "/meetings/recordings", (id) => `/meetings/recordings/${id}`, false);
      expect(meetings.map((m) => m.id)).toContain(f.meeting);
      for (const m of meetings) expect(m.clientVisible, `meeting detail ${m.id}`).toBe(false);
      const tasks = await expectDetailsMatchList("task", "/pm/tasks", (id) => `/pm/tasks/${id}`, false);
      expect(tasks.map((t) => t.id)).toContain(f.task);
      for (const t of tasks) expect(t.clientVisible, `task detail ${t.id}`).toBe(false);
    });
  });

  it("overview items: each item's flag matches the portal, and money items link to the billing page", async () => {
    type Item = Row & { kind: string; href: string };
    const o = (await get(admin, `/clients/${client}/overview`)) as { needsUs: Item[]; needsClient: Item[] };

    // What the portal shows the signer, per item kind.
    const portalPayments: string[] = [];
    for (const inv of (await get(signer, "/portal/invoices")) as Row[]) {
      portalPayments.push(...((await get(signer, `/portal/invoices/${inv.id}`)) as { payments: Row[] }).payments.map((p) => p.id));
    }
    const portalGates: string[] = [];
    for (const r of (await get(signer, "/portal/runs")) as Row[]) {
      portalGates.push(...((await get(signer, `/portal/runs/${r.id}`)) as { gates: Row[] }).gates.map((g) => g.id));
    }
    const portalByKind: Record<string, Set<string>> = {
      payment: new Set(portalPayments),
      gate: new Set(portalGates),
      contract: new Set(((await get(signer, "/portal/contracts")) as Row[]).map((r) => r.id)),
      request: new Set(((await get(signer, "/portal/change-requests")) as Row[]).map((r) => r.id)),
      review: new Set(((await get(signer, "/portal/social-reviews")) as Row[]).map((r) => r.id)),
    };

    const items = [...o.needsUs, ...o.needsClient];
    for (const it of items) {
      expect(typeof it.clientVisible, `${it.kind} ${it.id}: clientVisible is a boolean`).toBe("boolean");
      expect(it.clientVisible, `${it.kind} ${it.id}: flag == portal shows it`).toBe(portalByKind[it.kind].has(it.id));
      if (it.kind === "payment" || it.kind === "contract") expect(it.href).toBe(`/clients/${client}/billing`);
    }

    // The fixture reached every branch: a hidden payment and a hidden draft on our side, and both
    // review states on theirs (post reviews have no staff list; these items are their only marker).
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(f.payPendingSent)?.clientVisible).toBe(true);
    expect(byId.get(f.payPendingDraft)?.clientVisible).toBe(false);
    expect(byId.get(f.kDraft)?.clientVisible).toBe(false);
    expect(byId.get(f.kSent)?.clientVisible).toBe(true);
    expect(byId.get(f.g1)?.clientVisible).toBe(true);
    expect(byId.get(f.g3)?.clientVisible).toBe(true);
    expect(byId.get(f.cr0)?.clientVisible).toBe(true);
    expect(byId.get(f.reviewPending)?.clientVisible).toBe(true);
    expect(byId.get(f.reviewChanges)?.clientVisible).toBe(true);
  });
});
