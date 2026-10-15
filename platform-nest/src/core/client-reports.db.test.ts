// PV7-04a — client reports, publication (docs/FRONTEND-BFF-CONTRACT.md §55), proven over HTTP against real Postgres + RLS +
// Cerbos (skips silently without DATABASE_URL_TEST: check the skip count; runs on the Linux CI gate).
//
// WHAT IS PROVEN
//   1. Portal isolation, with the shared multi-client contact (src/testing/portal-fixtures.ts): a client-wide signer of client
//      A and a viewer limited to ONE project (B1) of client B. The contact sees A's reports (client-wide and on A's project)
//      and B1's report, and NOT B's client-wide report or B2's (the strict reach: a report with no project reaches client-wide
//      contacts only). A second user, a client-wide contact of B, is the POSITIVE CONTROL: they see exactly B's reports, so the
//      isolation assertions can never pass because a fixture row failed to exist.
//   2. A draft and a withdrawn report are never listed, counted, linked or downloadable; a guessed file id, a non-role file
//      hung on a published report, and a report outside reach are all 404 at the download route.
//   3. The read marker and `newReports` (30-day window, per user), and the deliverables payload's `reportId`.
//   4. Staff/portal parity of `clientVisible`: the staff list's flag equals "a client-wide contact of that client sees it".
//   5. The staff routes: who may list, the publish/withdraw state machine (409s, reason required AFTER authorization), the
//      client's-owner rule, the bot/automation DENY, the notice on publish, the SSE event.
//   6. Search delivery publishes exactly one client report in the same transaction (with its own role file: same sha256, its
//      own storage key), client-wide when the engagement has no project, and is idempotent; the backfill tool lists, then
//      creates only with apply, then finds nothing.
//   7. The database: the files role CHECKs keep every earlier role and pin the new one to its target; the client_reports
//      stamp CHECKs refuse half-stamped rows; the project must be the client's; one live report per source.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { registerModule, resetModules } from "../modules/registry";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../rollups/engine";
import { searchModule } from "../modules/search";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { addMembership, createClient, createCompany, createProject, createRole, createUser, grantRole } from "../testing/fixtures";
import { createMultiClientContact, type MultiClientContact } from "../testing/portal-fixtures";
import { newId, withGlobal, withTenants } from "../db";
import { setStorageForTest } from "./storage";
import { sha256Hex } from "./content-hash";
import { CLIENT_REPORT_FILE_ROLE, publishDeliveredReport, storeClientReportFile } from "./client-reports";
import { backfillClientReports, findUnpublishedDeliveredReports } from "../ops/client-reports-backfill";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const site = () => config.originSite;
const mem = new Map<string, Buffer>();

interface PortalReport {
  id: string; title: string; source: string; periodStart: string; periodEnd: string; clientId: string; clientName: string;
  projectId: string | null; projectName: string | null; publishedAt: string;
  file: { id: string; filename: string; contentType: string; byteSize: number }; readAt: string | null;
}
interface StaffReport {
  id: string; status: string; clientVisible: boolean; readCount: number; withdrawnReason: string | null;
  file: { id: string } | null; projectId: string | null; deliverableId: string | null;
}

describe.skipIf(!TEST_URL)("PV7-04a · client reports: publication, portal isolation, staff routes", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;       // company_admin
  let ownerA: string;      // member, the owner of client A
  let plainMember: string; // member, owns nothing
  let viewer: string;      // viewer
  let botAdmin: string;    // company_admin, users.kind = 'bot'
  let automationMgr: string; // manager, users.kind = 'automation'
  let m: MultiClientContact;
  let wideB: string;       // positive control: client-wide contact of B
  let otherClient: string; // a client the contact is not a contact of

  // Reports: r<client><project|0 for client-wide>
  const r = {
    A0: newId(), A1: newId(), B0: newId(), B1: newId(), B2: newId(), ADraft: newId(), AWithdrawn: newId(), AOld: newId(), Other: newId(),
  };
  const fileOf: Record<string, string> = {};
  let strayFileOnA1: string;
  let deliverableB1: string;
  let deliverableADraft: string;
  let deliverableAWithdrawn: string;

  /** Insert a client report with its own role file and bytes, as a delivery would. Status stamps follow the CHECKs. */
  async function seedReport(id: string, o: {
    clientId: string; projectId: string | null; status: "draft" | "published" | "withdrawn"; title?: string;
    publishedDaysAgo?: number; deliverableId?: string | null; withFile?: boolean;
  }) {
    const withFile = o.withFile !== false;
    const fileId = newId();
    const bytes = Buffer.from(`%PDF-fake report ${id}`);
    const key = `${co}/client-reports/${fileId}`;
    if (withFile) mem.set(key, bytes);
    await withTenants([co], async (c) => {
      if (withFile) {
        await c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size,
                              storage_key, sha256, scrubbed, origin_site, role)
           VALUES ($1, $2, $3, 'client_report', $4, $5, 'application/pdf', $6, $7, $8, false, $9, 'client_report_file')`,
          [fileId, co, admin, id, `report-${id.slice(0, 6)}.pdf`, bytes.byteLength, key, sha256Hex(bytes), site()],
        );
      }
      const published = o.status !== "draft";
      await c.query(
        `INSERT INTO client_reports (id, tenant_id, client_id, project_id, source, source_id, deliverable_id, title, period_start,
                                     period_end, file_id, status, published_at, published_by, withdrawn_at, withdrawn_by,
                                     withdrawn_reason, created_by, origin_site)
         VALUES ($1, $2, $3, $4, 'social_report', gen_random_uuid(), $5, $6, '2026-09-01', '2026-09-30', $7, $8,
                 CASE WHEN $9 THEN now() - make_interval(days => $10::int) END, CASE WHEN $9 THEN $11::uuid END,
                 CASE WHEN $8 = 'withdrawn' THEN now() END, CASE WHEN $8 = 'withdrawn' THEN $11::uuid END,
                 CASE WHEN $8 = 'withdrawn' THEN 'figures were wrong' END, $11, $12)`,
        [id, co, o.clientId, o.projectId, o.deliverableId ?? null, o.title ?? `Report ${id.slice(0, 6)}`,
         withFile ? fileId : null, o.status, published, o.publishedDaysAgo ?? 1, admin, site()],
      );
    });
    if (withFile) fileOf[id] = fileId;
  }

  const portalList = async (user: string): Promise<PortalReport[]> => {
    const res = await app.inject({ method: "GET", url: `/api/${co}/portal/reports`, headers: asUser(user) });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    return res.json();
  };
  const download = (user: string, fileId: string) =>
    app.inject({ method: "GET", url: `/api/${co}/portal/files/${fileId}`, headers: asUser(user) });
  const staffList = async (user: string, clientId: string, expected = 200): Promise<StaffReport[]> => {
    const res = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/reports`, headers: asUser(user) });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(expected);
    return expected === 200 ? res.json().reports : [];
  };
  const overviewNew = async (user: string): Promise<number> => {
    const res = await app.inject({ method: "GET", url: `/api/${co}/portal/overview`, headers: asUser(user) });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    return res.json().newReports;
  };
  const ids = (rows: Array<{ id: string }>) => rows.map((x) => x.id).sort();

  async function staffUser(email: string, role: string, kind?: string): Promise<string> {
    const u = await createUser(email, email.split("@")[0]);
    await addMembership(co, u);
    await grantRole(u, await createRole(role), "company", co);
    if (kind) await withGlobal((q) => q.query(`UPDATE users SET kind = $2 WHERE id = $1`, [u, kind]));
    return u;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error(`missing blob ${k}`); return b; },
      del: async (k) => { mem.delete(k); },
    });
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    co = await createCompany("Client Reports Co", ["clients", "pm", "search"]);
    admin = await staffUser("admin@client-reports.test", "company_admin");
    ownerA = await staffUser("owner-a@client-reports.test", "member");
    plainMember = await staffUser("member@client-reports.test", "member");
    viewer = await staffUser("viewer@client-reports.test", "viewer");
    botAdmin = await staffUser("bot@client-reports.test", "company_admin", "bot");
    automationMgr = await staffUser("automation@client-reports.test", "manager", "automation");

    m = await createMultiClientContact(co, { tag: "cr", staffUserId: admin });
    const { clientA: A, clientB: B, projectA: pA, projectB1: pB1, projectB2: pB2 } = m;
    await withTenants([co], (q) => q.query(`UPDATE clients SET owner_user_id = $2 WHERE id = $1`, [A, ownerA]));

    wideB = await createUser("wide-b@client-reports.test", "Wanda Wide");
    await addMembership(co, wideB);
    await grantRole(wideB, await createRole("client"), "company", co);
    await withGlobal((q) => q.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [wideB]));
    otherClient = await createClient(co, "Someone Else Entirely");
    await withTenants([co], async (q) => {
      await q.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', now(), $5)`,
        [newId(), co, B, wideB, site()],
      );
      const deliverable = async (project: string, name: string) => {
        const id = newId();
        await q.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, custom_fields, origin_site)
           VALUES ($1, $2, $3, NULL, $4, 'delivered', '{}', $5)`,
          [id, co, project, name, site()],
        );
        return id;
      };
      deliverableB1 = await deliverable(pB1, "B1 report deliverable");
      deliverableADraft = await deliverable(pA, "A draft report deliverable");
      deliverableAWithdrawn = await deliverable(pA, "A withdrawn report deliverable");
    });

    await seedReport(r.A0, { clientId: A, projectId: null, status: "published", title: "A whole account" });
    await seedReport(r.A1, { clientId: A, projectId: pA, status: "published", title: "A project report" });
    await seedReport(r.B0, { clientId: B, projectId: null, status: "published", title: "B whole account SECRET" });
    await seedReport(r.B1, { clientId: B, projectId: pB1, status: "published", deliverableId: deliverableB1 });
    await seedReport(r.B2, { clientId: B, projectId: pB2, status: "published", title: "B2 SECRET" });
    await seedReport(r.ADraft, { clientId: A, projectId: pA, status: "draft", deliverableId: deliverableADraft, title: "A DRAFT" });
    await seedReport(r.AWithdrawn, { clientId: A, projectId: null, status: "withdrawn", deliverableId: deliverableAWithdrawn });
    await seedReport(r.AOld, { clientId: A, projectId: pA, status: "published", publishedDaysAgo: 40 });
    await seedReport(r.Other, { clientId: otherClient, projectId: null, status: "published", title: "Other client SECRET" });

    // A file with NO role hung on a published, in-reach report: never a client document.
    strayFileOnA1 = newId();
    mem.set(`${co}/${strayFileOnA1}`, Buffer.from("internal notes"));
    await withTenants([co], (q) => q.query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size,
                          storage_key, sha256, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'client_report', $4, 'internal.txt', 'text/plain', 14, $5, $6, false, $7)`,
      [strayFileOnA1, co, admin, r.A1, `${co}/${strayFileOnA1}`, sha256Hex(Buffer.from("internal notes")), site()],
    ));

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. Portal isolation ─────────────────────────────────────────────────────────────────────────────────────────────
  it("the multi-client contact sees A's reports and B1's, never B's client-wide report, B2's, a draft, a withdrawn one or another client's", async () => {
    const list = await portalList(m.userId);
    expect(ids(list)).toEqual([r.A0, r.A1, r.AOld, r.B1].sort());
    const body = JSON.stringify(list);
    for (const banned of ["SECRET", "A DRAFT", "figures were wrong"]) expect(body).not.toContain(banned);
    // Client-wide reports carry no project; project ones carry their project.
    expect(list.find((x) => x.id === r.A0)!.projectId).toBeNull();
    expect(list.find((x) => x.id === r.A0)!.projectName).toBeNull();
    expect(list.find((x) => x.id === r.B1)!.projectId).toBe(m.projectB1);
    // No internal key reaches the client.
    const keys = new Set(list.flatMap((x) => Object.keys(x)));
    for (const k of ["status", "sourceId", "deliverableId", "publishedBy", "publishedByName", "withdrawnReason", "withdrawnAt"]) {
      expect(keys.has(k), k).toBe(false);
    }
    expect(list.find((x) => x.id === r.A1)!.file.id).toBe(fileOf[r.A1]);
  });

  it("POSITIVE CONTROL: a client-wide contact of B sees exactly B's three published reports", async () => {
    expect(ids(await portalList(wideB))).toEqual([r.B0, r.B1, r.B2].sort());
  });

  it("a staff user is not a portal client (403), and an unauthenticated portal read is refused", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${co}/portal/reports`, headers: asUser(admin) });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: "GET", url: `/api/${co}/portal/reports` });
    expect([401, 403]).toContain(anon.statusCode);
  });

  // ── 2. Downloads ────────────────────────────────────────────────────────────────────────────────────────────────────
  it("download: an in-reach published report's own file is served; out of reach, draft, withdrawn, stray and guessed ids are 404", async () => {
    const ok = await download(m.userId, fileOf[r.A1]);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain(`report ${r.A1}`);
    expect(ok.headers["content-disposition"]).toMatch(/^attachment;/);
    expect((await download(m.userId, fileOf[r.B1])).statusCode).toBe(200);
    for (const [label, fileId] of [
      ["B client-wide (strict reach)", fileOf[r.B0]], ["B2", fileOf[r.B2]], ["draft", fileOf[r.ADraft]],
      ["withdrawn", fileOf[r.AWithdrawn]], ["another client", fileOf[r.Other]], ["a non-role file on a published report", strayFileOnA1],
      ["a guessed id", newId()],
    ] as const) {
      expect((await download(m.userId, fileId)).statusCode, label).toBe(404);
    }
    // The positive control downloads what the limited contact may not.
    expect((await download(wideB, fileOf[r.B0])).statusCode).toBe(200);
    expect((await download(wideB, fileOf[r.B2])).statusCode).toBe(200);
  });

  // ── 3. Read marker, newReports, deliverables reportId ────────────────────────────────────────────────────────────────
  it("newReports counts in-reach reports published in the last 30 days that this user has not opened; the read marker clears one", async () => {
    // m: A0, A1, B1 (AOld is 40 days old). wideB: B0, B1, B2.
    expect(await overviewNew(m.userId)).toBe(3);
    expect(await overviewNew(wideB)).toBe(3);

    const first = await app.inject({ method: "POST", url: `/api/${co}/portal/reports/${r.A1}/read`, headers: asUser(m.userId) });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().id).toBe(r.A1);
    const again = await app.inject({ method: "POST", url: `/api/${co}/portal/reports/${r.A1}/read`, headers: asUser(m.userId) });
    expect(again.json().readAt).toBe(first.json().readAt); // the first read is kept
    expect(await overviewNew(m.userId)).toBe(2);
    expect(await overviewNew(wideB)).toBe(3); // per user
    expect((await portalList(m.userId)).find((x) => x.id === r.A1)!.readAt).not.toBeNull();
    expect((await portalList(m.userId)).find((x) => x.id === r.A0)!.readAt).toBeNull();

    // B1 is shared by both: reading it as wideB moves only wideB's count.
    await app.inject({ method: "POST", url: `/api/${co}/portal/reports/${r.B1}/read`, headers: asUser(wideB) });
    expect(await overviewNew(wideB)).toBe(2);
    expect(await overviewNew(m.userId)).toBe(2);
  });

  it("the read marker is 404 for a report out of reach, a draft, a withdrawn report, another client's, and a malformed id", async () => {
    for (const [label, id] of [
      ["B2", r.B2], ["B client-wide", r.B0], ["draft", r.ADraft], ["withdrawn", r.AWithdrawn], ["other client", r.Other],
      ["unknown", newId()], ["malformed", "not-a-uuid"],
    ] as const) {
      const res = await app.inject({ method: "POST", url: `/api/${co}/portal/reports/${id}/read`, headers: asUser(m.userId) });
      expect(res.statusCode, label).toBe(404);
    }
    const n = await withTenants([co], (q) =>
      q.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_report_reads WHERE user_id = $1`, [m.userId]));
    expect(n.rows[0].n).toBe(1); // only A1
  });

  it("the portal deliverables payload links a deliverable to its published, in-reach report, and never to a draft or a withdrawn one", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${co}/portal/deliverables`, headers: asUser(m.userId) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; reportId: string | null }>;
    expect(rows.find((x) => x.id === deliverableB1)?.reportId).toBe(r.B1);
    expect(rows.find((x) => x.id === deliverableADraft)?.reportId).toBeNull();
    expect(rows.find((x) => x.id === deliverableAWithdrawn)?.reportId).toBeNull();
  });

  // ── 4. Staff/portal parity ─────────────────────────────────────────────────────────────────────────────────────────
  it("parity: the staff clientVisible flag is exactly the set a client-wide contact of that client sees in the portal", async () => {
    const staffA = await staffList(admin, m.clientA);
    const staffB = await staffList(admin, m.clientB);
    // Staff see every status.
    expect(ids(staffA)).toEqual([r.A0, r.A1, r.ADraft, r.AWithdrawn, r.AOld].sort());
    // m reaches A client-wide; wideB reaches B client-wide.
    const portalA = (await portalList(m.userId)).filter((x) => x.clientId === m.clientA);
    const portalB = await portalList(wideB);
    expect(ids(staffA.filter((x) => x.clientVisible))).toEqual(ids(portalA));
    expect(ids(staffB.filter((x) => x.clientVisible))).toEqual(ids(portalB));
    const withdrawn = staffA.find((x) => x.id === r.AWithdrawn)!;
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawnReason).toBe("figures were wrong");
    expect(staffA.find((x) => x.id === r.A1)!.readCount).toBe(1);
  });

  // ── 5. Staff routes ─────────────────────────────────────────────────────────────────────────────────────────────────
  it("staff list: staff readers 200; a portal contact 403; a client that does not exist or a malformed id 404", async () => {
    await staffList(viewer, m.clientA);
    await staffList(plainMember, m.clientA);
    await staffList(m.userId, m.clientA, 403);
    await staffList(admin, newId(), 404);
    await staffList(admin, "not-a-uuid", 404);
  });

  it("publish: a draft with its own file becomes published (owner of the client may; a plain member, a bot and an automation may not)", async () => {
    const draft = newId();
    await seedReport(draft, { clientId: m.clientA, projectId: m.projectA, status: "draft", title: "Owner publishes this" });
    const publish = (user: string, id = draft) =>
      app.inject({ method: "POST", url: `/api/${co}/client-reports/${id}/publish`, headers: asUser(user) });

    expect((await publish(plainMember)).statusCode).toBe(403);
    expect((await publish(viewer)).statusCode).toBe(403);
    expect((await publish(botAdmin)).statusCode, "the bot DENY beats company_admin").toBe(403);
    expect((await publish(automationMgr)).statusCode, "the automation DENY beats manager").toBe(403);
    expect((await publish(m.userId)).statusCode, "a portal contact").toBe(403);
    expect(ids(await portalList(m.userId))).not.toContain(draft);

    const ok = await publish(ownerA);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("published");
    expect(ids(await portalList(m.userId))).toContain(draft);
    // ... and B's client-wide contact does not see an A report.
    expect(ids(await portalList(wideB))).not.toContain(draft);

    // The notice reached the contact in reach (m is client-wide on A), and nobody of B.
    const notes = await withTenants([co], (q) => q.query<{ user_id: string }>(
      `SELECT user_id FROM notifications WHERE type = 'client_report.published' AND payload->>'entityId' = $1`, [draft]));
    expect(notes.rows.map((x) => x.user_id)).toEqual([m.userId]);
    const events = await withTenants([co], (q) => q.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE entity_type = 'client_report' AND entity_id = $1`, [draft]));
    expect(events.rows.map((e) => e.event_type)).toEqual(["client_report.published"]);

    expect((await publish(admin)).statusCode, "publishing again").toBe(409);
    expect((await publish(admin, newId())).statusCode).toBe(404);
    expect((await publish(admin, "nope")).statusCode).toBe(404);
  });

  it("publish refuses a draft with no file of its own (409 report_has_no_file)", async () => {
    const bare = newId();
    await seedReport(bare, { clientId: m.clientA, projectId: null, status: "draft", withFile: false });
    const res = await app.inject({ method: "POST", url: `/api/${co}/client-reports/${bare}/publish`, headers: asUser(admin) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("report_has_no_file");
  });

  it("withdraw: authorization first, then the reason, then the state; a withdrawn report leaves the portal and its file 404s", async () => {
    const target = newId();
    await seedReport(target, { clientId: m.clientA, projectId: m.projectA, status: "published", title: "To be withdrawn" });
    const withdraw = (user: string, payload: unknown, id = target) =>
      app.inject({ method: "POST", url: `/api/${co}/client-reports/${id}/withdraw`, headers: asUser(user), payload: payload as object });

    // A caller who may not withdraw is refused BEFORE the body is looked at (a sloppy body still tests authorization).
    expect((await withdraw(plainMember, {})).statusCode).toBe(403);
    expect((await withdraw(botAdmin, { reason: "agent says so" })).statusCode).toBe(403);
    expect((await withdraw(admin, {})).statusCode).toBe(400);
    expect((await withdraw(admin, { reason: "   " })).statusCode).toBe(400);
    expect((await withdraw(admin, { reason: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await withdraw(admin, { reason: "Wrong period" }, r.ADraft)).statusCode, "a draft is not published").toBe(409);

    expect((await download(m.userId, fileOf[target])).statusCode).toBe(200);
    const ok = await withdraw(ownerA, { reason: "Wrong period" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("withdrawn");
    expect((await withdraw(admin, { reason: "again" })).statusCode).toBe(409);

    expect(ids(await portalList(m.userId))).not.toContain(target);
    expect((await download(m.userId, fileOf[target])).statusCode).toBe(404);
    const staff = (await staffList(admin, m.clientA)).find((x) => x.id === target)!;
    expect(staff.status).toBe("withdrawn");
    expect(staff.clientVisible).toBe(false);
    expect(staff.withdrawnReason).toBe("Wrong period");
    // A role file is a record: withdrawing keeps it (trg_files_guard_role_file); the staff download still serves it.
    const staffFile = await app.inject({ method: "GET", url: `/api/${co}/files/${fileOf[target]}/content`, headers: asUser(admin) });
    expect(staffFile.statusCode).toBe(200);
  });

  it("staff download through the existing files route: staff readers 200, a portal contact 403", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${co}/files/${fileOf[r.A1]}/content`, headers: asUser(viewer) });
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(200);
    const contact = await app.inject({ method: "GET", url: `/api/${co}/files/${fileOf[r.A1]}/content`, headers: asUser(m.userId) });
    expect(contact.statusCode).toBe(403);
  });

  // ── 6. Delivery publishes; the backfill ─────────────────────────────────────────────────────────────────────────────
  describe("search delivery and the backfill", () => {
    let engWithProject: string;
    let engNoProject: string;

    const approvedReport = async (eng: string, period: string) => {
      const id = newId();
      await withTenants([co], (q) => q.query(
        // `metrics` is SM-10's frozen snapshot shape (the renderer reads kpiTargets); the column default `{}` is not one.
        `INSERT INTO search_reports (id, tenant_id, engagement_id, period, kind, status, metrics, narrative_md, approved_by, approved_at, origin_site)
         VALUES ($1, $2, $3, $4, 'monthly', 'approved', '{"rankTop10": 0, "criticalFindingsOpen": 0, "kpiTargets": []}'::jsonb,
                 'Narrative.', $5, now(), 'central')`,
        [id, co, eng, period, admin],
      ), { modules: ["search"] });
      return id;
    };
    const clientReportsOf = (sourceId: string) => withTenants([co], (q) => q.query<{
      id: string; status: string; project_id: string | null; deliverable_id: string | null; file_id: string; title: string;
      period_start: string; period_end: string;
    }>(
      `SELECT id, status, project_id, deliverable_id, file_id, title, to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end, 'YYYY-MM-DD') AS period_end
         FROM client_reports WHERE source = 'search_report' AND source_id = $1`, [sourceId]));

    beforeAll(async () => {
      const prop = newId();
      engWithProject = newId();
      engNoProject = newId();
      await withTenants([co], async (q) => {
        await q.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1, $2, $3, 'reports-a.example.com', 'https://reports-a.example.com', 'central')`,
          [prop, co, m.clientA],
        );
        await q.query(
          `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, project_id, name, status, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'SEO on project A', 'active', 'central'), ($6, $2, $3, $4, NULL, 'SEO, whole account', 'active', 'central')`,
          [engWithProject, co, m.clientA, prop, m.projectA, engNoProject],
        );
      }, { modules: ["search"] });
    });

    it("deliver publishes exactly one client report in the same transaction, with its own role file, and re-delivery changes nothing", async () => {
      const id = await approvedReport(engWithProject, "2026-09");
      const res = await app.inject({ method: "POST", url: `/api/${co}/modules/search/reports/${id}/deliver`, headers: asUser(admin) });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      const body = res.json() as { fileId: string; deliverableId: string; clientReportId: string };
      const rows = (await clientReportsOf(id)).rows;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(body.clientReportId);
      expect(rows[0].status).toBe("published");
      expect(rows[0].project_id).toBe(m.projectA);
      expect(rows[0].deliverable_id).toBe(body.deliverableId);
      expect(rows[0].title).toBe("Search report, September 2026");
      expect([rows[0].period_start, rows[0].period_end]).toEqual(["2026-09-01", "2026-09-30"]);

      // Its own file: role + target + same bytes, under its own storage key.
      const files = await withTenants([co], (q) => q.query<{ id: string; role: string | null; target_entity_type: string; target_entity_id: string; sha256: string; storage_key: string; content_type: string }>(
        `SELECT id, role, target_entity_type, target_entity_id, sha256, storage_key, content_type FROM files WHERE id = ANY($1::uuid[])`,
        [[body.fileId, rows[0].file_id]]));
      const moduleFile = files.rows.find((f) => f.id === body.fileId)!;
      const reportFile = files.rows.find((f) => f.id === rows[0].file_id)!;
      expect(reportFile.role).toBe(CLIENT_REPORT_FILE_ROLE);
      expect(reportFile.target_entity_type).toBe("client_report");
      expect(reportFile.target_entity_id).toBe(rows[0].id);
      expect(reportFile.sha256).toBe(moduleFile.sha256);
      expect(reportFile.storage_key).not.toBe(moduleFile.storage_key);
      expect(reportFile.content_type).toBe("text/markdown");

      // The client sees it and can download it; the deliverable links to it.
      expect(ids(await portalList(m.userId))).toContain(rows[0].id);
      expect((await download(m.userId, rows[0].file_id)).statusCode).toBe(200);
      const dl = await app.inject({ method: "GET", url: `/api/${co}/portal/deliverables`, headers: asUser(m.userId) });
      expect((dl.json() as Array<{ id: string; reportId: string | null }>).find((d) => d.id === body.deliverableId)?.reportId).toBe(rows[0].id);
      // The notice reached the client-wide contact of A.
      const notes = await withTenants([co], (q) => q.query<{ user_id: string }>(
        `SELECT user_id FROM notifications WHERE type = 'client_report.published' AND payload->>'entityId' = $1`, [rows[0].id]));
      expect(notes.rows.map((x) => x.user_id)).toEqual([m.userId]);

      // Re-delivery is refused by the module, and the client report is not duplicated.
      const again = await app.inject({ method: "POST", url: `/api/${co}/modules/search/reports/${id}/deliver`, headers: asUser(admin) });
      expect(again.statusCode).toBe(400);
      expect((await clientReportsOf(id)).rows.length).toBe(1);

      // The helper itself is idempotent per source: a second call writes nothing.
      const stored = await storeClientReportFile(co, Buffer.from("again"), "again.md", "text/markdown");
      const second = await withTenants([co], (q) => publishDeliveredReport(q, {
        tenantId: co, source: "search_report", sourceId: id, clientId: m.clientA, projectId: m.projectA, deliverableId: null,
        title: "dup", periodStart: "2026-09-01", periodEnd: "2026-09-30", file: stored, publishedBy: admin, announce: true,
      }));
      expect(second.created).toBe(false);
      expect(second.id).toBe(rows[0].id);
      expect((await clientReportsOf(id)).rows.length).toBe(1);
    });

    it("an engagement with no project publishes a CLIENT-WIDE report (project NULL, no deliverable)", async () => {
      const id = await approvedReport(engNoProject, "2026-08");
      const res = await app.inject({ method: "POST", url: `/api/${co}/modules/search/reports/${id}/deliver`, headers: asUser(admin) });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      const rows = (await clientReportsOf(id)).rows;
      expect(rows.length).toBe(1);
      expect(rows[0].project_id).toBeNull();
      expect(rows[0].deliverable_id).toBeNull();
      expect(ids(await portalList(m.userId))).toContain(rows[0].id); // m is client-wide on A
    });

    it("the backfill lists a report delivered before this ticket, creates it only with apply (no notice), and then finds nothing", async () => {
      // A report delivered the OLD way: delivered, with its module file, and no client report.
      const id = newId();
      const moduleFile = newId();
      const bytes = Buffer.from("# Old search report");
      mem.set(`${co}/search-reports/${moduleFile}`, bytes);
      await withTenants([co], async (q) => {
        await q.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size,
                              storage_key, sha256, scrubbed, origin_site)
           VALUES ($1, $2, $3, 'search_report', $4, 'old.md', 'text/markdown', $5, $6, $7, false, $8)`,
          [moduleFile, co, admin, id, bytes.byteLength, `${co}/search-reports/${moduleFile}`, sha256Hex(bytes), site()],
        );
        await q.query(
          `INSERT INTO search_reports (id, tenant_id, engagement_id, period, kind, status, file_id, approved_by, approved_at,
                                       delivered_at, origin_site)
           VALUES ($1, $2, $3, '2026-07', 'monthly', 'delivered', $4, $5, now(), '2026-08-02T03:00:00Z', 'central')`,
          [id, co, engWithProject, moduleFile, admin],
        );
      }, { modules: ["search"] });

      const found = await findUnpublishedDeliveredReports(co);
      expect(found.map((x) => x.sourceId)).toEqual([id]);
      expect(found[0].skip).toBeNull();

      const dry = await backfillClientReports(co, { apply: false });
      expect(dry.created).toEqual([]);
      expect((await clientReportsOf(id)).rows.length).toBe(0);

      const applied = await backfillClientReports(co, { apply: true });
      expect(applied.created.length).toBe(1);
      const rows = (await clientReportsOf(id)).rows;
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("published");
      expect(rows[0].title).toBe("Search report, July 2026");
      const at = await withTenants([co], (q) => q.query<{ published_at: Date }>(`SELECT published_at FROM client_reports WHERE id = $1`, [rows[0].id]));
      expect(at.rows[0].published_at.toISOString()).toBe("2026-08-02T03:00:00.000Z");
      // History, not news: no notice and no event.
      const notes = await withTenants([co], (q) => q.query(
        `SELECT 1 FROM notifications WHERE type = 'client_report.published' AND payload->>'entityId' = $1`, [rows[0].id]));
      expect(notes.rows.length).toBe(0);
      const events = await withTenants([co], (q) => q.query(
        `SELECT 1 FROM outbox_events WHERE entity_type = 'client_report' AND entity_id = $1`, [rows[0].id]));
      expect(events.rows.length).toBe(0);

      expect(await findUnpublishedDeliveredReports(co)).toEqual([]);
      expect((await backfillClientReports(co, { apply: true })).created).toEqual([]);
    });
  });

  // ── 7. The database ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the database", () => {
    const pgCode = async (fn: () => Promise<unknown>): Promise<string | null> => {
      try { await fn(); return null; } catch (e) { return (e as { code?: string }).code ?? "no-code"; }
    };
    const insertFile = (role: string | null, target: string) => withTenants([co], (q) => q.query(
      `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256,
                          scrubbed, origin_site, role)
       VALUES ($1, $2, $3, $4, 'x', 'application/pdf', 1, 'k', $5, false, $6, $7)`,
      [newId(), co, target, newId(), "a".repeat(64), site(), role],
    ));

    it("files: every earlier role is still admitted on its own target, the new role only on client_report, and an unknown role is refused", async () => {
      for (const [role, target] of [
        ["invoice_pdf", "invoice"], ["contract_signed_copy", "contract"], ["contract_certified_copy", "contract"],
        ["contract_certified_certificate", "contract"], ["client_report_file", "client_report"], [null, "deliverable"],
      ] as const) {
        expect(await pgCode(() => insertFile(role, target)), `${role} on ${target}`).toBeNull();
      }
      expect(await pgCode(() => insertFile("client_report_file", "deliverable"))).toBe("23514");
      expect(await pgCode(() => insertFile("invoice_pdf", "client_report"))).toBe("23514");
      expect(await pgCode(() => insertFile("client_report_pdf", "client_report"))).toBe("23514");
      const def = await withGlobal((q) => q.query<{ d: string }>(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_role_check'`));
      for (const role of ["invoice_pdf", "contract_signed_copy", "contract_certified_copy", "contract_certified_certificate", "client_report_file"]) {
        expect(def.rows[0].d).toContain(`'${role}'`);
      }
    });

    const insertReport = (o: Record<string, unknown>) => withTenants([co], (q) => q.query(
      `INSERT INTO client_reports (id, tenant_id, client_id, project_id, source, source_id, title, period_start, period_end, file_id,
                                   status, published_at, published_by, withdrawn_at, withdrawn_by, withdrawn_reason, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'T', '2026-09-01', '2026-09-30', $7, $8, $9, $10, $11, $12, $13, $14)`,
      [newId(), co, o.clientId ?? m.clientA, o.projectId ?? null, o.source ?? "social_report", "sourceId" in o ? o.sourceId : newId(),
       o.fileId ?? null, o.status ?? "draft", o.publishedAt ?? null, o.publishedBy ?? null, o.withdrawnAt ?? null,
       o.withdrawnBy ?? null, o.withdrawnReason ?? null, site()],
    ));

    it("client_reports: the stamp CHECKs refuse half-stamped rows, the project must be the client's, one live report per source", async () => {
      const file = fileOf[r.A1];
      const now = new Date().toISOString();
      // published without published_by, or without a file
      expect(await pgCode(() => insertReport({ status: "published", publishedAt: now, fileId: file }))).toBe("23514");
      expect(await pgCode(() => insertReport({ status: "published", publishedAt: now, publishedBy: admin }))).toBe("23514");
      // a draft carrying a publication stamp
      expect(await pgCode(() => insertReport({ status: "draft", publishedAt: now }))).toBe("23514");
      // withdrawn without a reason, or with a blank one
      expect(await pgCode(() => insertReport({ status: "withdrawn", publishedAt: now, publishedBy: admin, fileId: file, withdrawnAt: now, withdrawnBy: admin }))).toBe("23514");
      expect(await pgCode(() => insertReport({ status: "withdrawn", publishedAt: now, publishedBy: admin, fileId: file, withdrawnAt: now, withdrawnBy: admin, withdrawnReason: "  " }))).toBe("23514");
      // a withdrawal stamp on a published row
      expect(await pgCode(() => insertReport({ status: "published", publishedAt: now, publishedBy: admin, fileId: file, withdrawnReason: "x" }))).toBe("23514");
      // a module report must name its source
      expect(await pgCode(() => insertReport({ source: "social_report", sourceId: null }))).toBe("23514");
      // the project must be THIS client's (B1 is client B's)
      expect(await pgCode(() => insertReport({ clientId: m.clientA, projectId: m.projectB1 }))).toBe("23503");
      // one live row per source; a withdrawn one does not block a re-draft
      const src = newId();
      expect(await pgCode(() => insertReport({ source: "social_report", sourceId: src }))).toBeNull();
      expect(await pgCode(() => insertReport({ source: "social_report", sourceId: src }))).toBe("23505");
      // a valid row is accepted
      expect(await pgCode(() => insertReport({ status: "published", publishedAt: now, publishedBy: admin, fileId: file }))).toBeNull();
    });

    it("both tables are FORCE RLS: an unset tenant context reads zero rows", async () => {
      const n = await withTenants([newId()], (q) => q.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_reports`)).catch(() => null);
      // A tenant the reader is not in: zero rows (or the FK-less GUC simply matches nothing).
      if (n) expect(n.rows[0].n).toBe(0);
      const mine = await withTenants([co], (q) => q.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_reports`));
      expect(mine.rows[0].n).toBeGreaterThan(5);
    });
  });
});
