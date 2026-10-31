// SCP-6a — the one-off sheet import against REAL Postgres (the three walls) and REAL Cerbos (the 1b-iam policies), through the real HTTP layer:
// BFF §63.23 (`POST import/parse`, `POST import/allocation`, `POST import/plan`), PERMISSION §53.6.
//
// THE CLAIMS UNDER TEST
//   1. The four approvers import (a Social Media seat holder, a GM seat holder, an `owner`, `platform_admin`); nobody else does: a company admin, a
//      client's officer and another company's member are refused 403 `not_a_social_approver` on all three routes, BEFORE the body is read.
//   2. `import/parse` reads a csv, pasted text and an xlsx into tabs of text, and refuses what 63.23.1 says (400 codes).
//   3. The allocation: a mock sheet for three mock clients previewed (nothing written) and then applied: the columns written, the event, one activity
//      row per changed client carrying `{via: "sheet_import", importId}`; the replay answers `unchanged` and writes nothing; an empty cell clears
//      nothing; one refused row refuses the whole apply (409 `import_rows_refused`, nothing written) and an unticked row is left out.
//   4. `clientMatches` and `officerMatches` resolve the names the server could not match; another company's engagement, a non-member and a bot are 400.
//   5. The plan: next month's posts for three mock clients previewed and then applied: the cycle a client lacks is made from the A/B pre-fill with its
//      ready-by and its content-month PM task, each post is `planned` with its copy, the activity carries the importId, the replay is `unchanged`, a
//      discarded post is not brought back, and one refused row refuses the whole apply with NO cycle left behind (the transaction rolled back).
//   6. The three routes take bodies far past Fastify's 1 MiB default (`upload-body-limits.ts`) and refuse past their own cap.
//   7. SCP-6b1 (BFF §63.23.9), the team's real file: a synthetic two-tab workbook (posts of two merged rows, an angle cell, "CAROUSEL VIDEO", a story
//      date merged over two stories, one blank date that is not merged), read by `parse` (with the merges), previewed and applied for one engagement
//      (`engagementId`, `allStories`), the replay `unchanged`, and the 400s for `engagementId`, `allStories` and `merges`.
//
// THE DAY. "Today" is the report day in `REPORTS_TZ`; the suite asks the same function and picks the plan's month from it, so it holds on any date.
// Expected deadlines come from a plain Monday-to-Friday walk written here (the company has no holiday calendar), never from the code under test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import ExcelJS from "exceljs";
import { config } from "../../../config";
import { withGlobal, withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";
import { importPostId } from "./sheet-import";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };

// ── a plain calendar, written independently of the code under test ────────────────────────────────────────────────────────────
const dow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWorking = (iso: string): boolean => dow(iso) !== 0 && dow(iso) !== 6;
const weekdayOnOrBefore = (iso: string): string => { let d = iso; while (!isWorking(d)) d = shift(d, -1); return d; };
/** `n` working days before `iso` (the day itself is never counted), Monday to Friday. */
function walkBack(iso: string, n: number): string {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = shift(d, -1);
    if (isWorking(d)) left -= 1;
  }
  return d;
}
const today = todayIsoInTz(config.reportsTz);
const thisMonth = today.slice(0, 7);
/** `YYYY-MM` of the report month plus `k` months. */
function monthPlus(k: number): string {
  const [y, m] = thisMonth.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const planMonth = monthPlus(2);
const prevMonth = monthPlus(1);
const monthAbbr = (month: string): string => MONTH_ABBR[Number(month.slice(5, 7)) - 1];
/** A sheet date in the plan month: `3 Dec`. */
const sheetDay = (d: number): string => `${d} ${monthAbbr(planMonth)}`;
const isoDay = (d: number): string => `${planMonth}-${String(d).padStart(2, "0")}`;
/** The A/B pre-fill for `planMonth`: A the last working day on or before the 15th of the month before, B its last working day. */
const prefillA = weekdayOnOrBefore(`${prevMonth}-15`);
const prefillB = weekdayOnOrBefore(shift(`${planMonth}-01`, -1));

// ── the sheets ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ALLOC_HEADER = ["Client", "Officer", "Posts", "Creative", "Batch", "Report", "Due day", "Platforms", "Formats", "Time"];
const ALLOC_COLS = { client: 0, officer: 1, postsPerCycle: 2, creativeSource: 3, deliveryBatch: 4, reportFormat: 5, reportDueDay: 6, platforms: 7, formats: 8, defaultPostTime: 9 };
const PLAN_HEADER = ["Client", "Date", "Time", "Title", "Format", "Pillar", "Platforms", "Extra", "Angle", "Objective", "Key message", "Visual", "Caption", "On asset", "CTA", "Tags"];
const PLAN_COLS = { client: 0, date: 1, time: 2, title: 3, format: 4, pillar: 5, placement: 6, isExtra: 7, angle: 8, objective: 9, keyMessage: 10, visualDirection: 11, caption: 12, onAssetText: 13, cta: 14, hashtags: 15 };
type PlanKey = keyof typeof PLAN_COLS;
const planRow = (o: Partial<Record<PlanKey, string>>): string[] => {
  const base: Record<PlanKey, string> = {
    client: "", date: "", time: "", title: "", format: "", pillar: "", placement: "", isExtra: "", angle: "", objective: "", keyMessage: "", visualDirection: "",
    caption: "", onAssetText: "", cta: "", hashtags: "",
  };
  return (Object.keys(PLAN_COLS) as PlanKey[]).map((k) => o[k] ?? base[k]);
};

describe.skipIf(!TEST_URL)("social sheet import (SCP-6a)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency: social and pm on, the org tree of the pipeline fixtures, no holiday calendar
  let C: string; // another company: social on
  const U: Record<string, string> = {};
  let units: Awaited<ReturnType<typeof seedSocialOrgTree>>;
  // The allocation's mock clients.
  let bakery: { id: string; clientId: string };
  let studio: { id: string; clientId: string };
  let garden: { id: string; clientId: string };
  let closed: { id: string; clientId: string };
  // The plan's mock clients: a batch A client, a batch B client with a default time, and one with no batch.
  let pastry: { id: string; clientId: string };
  let design: { id: string; clientId: string };
  let tea: { id: string; clientId: string };
  let foreign: { id: string; clientId: string }; // another company's engagement

  const base = (tenant: string) => `/api/${tenant}/modules/social`;
  const imp = (who: string, kind: "parse" | "allocation" | "plan", payload: unknown, tenant = A) =>
    app.inject({ method: "POST", url: `${base(tenant)}/import/${kind}`, headers: asUser(who), payload: payload as Record<string, unknown> });

  async function makeEngagement(
    tenant: string, clientName: string,
    o: { status?: string; batch?: "A" | "B" | null; defaultTime?: string | null; project?: boolean; owner?: string | null; target?: number | null; source?: string;
         reportFormat?: string | null; dueDay?: number | null; platforms?: string[]; formats?: string[] } = {},
  ): Promise<{ id: string; clientId: string }> {
    const clientId = await createClient(tenant, clientName);
    const id = newId();
    const projectId = o.project ? await createProject(tenant, `${clientName} content project`) : null;
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, delivery_batch, default_post_time, project_id, owner_id, posts_per_cycle,
                                         creative_source, report_format, report_due_day, platforms, formats, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7::time, $8, $9, $10, $11, $12, $13, $14, $15, 'central')`,
        [id, tenant, clientId, `${clientName} engagement`, o.status ?? "active", o.batch ?? null, o.defaultTime ?? null, projectId, o.owner ?? null, o.target ?? null,
         o.source ?? "creatives", o.reportFormat ?? null, o.dueDay ?? null, o.platforms ?? [], o.formats ?? []],
      ),
      SOCIAL,
    );
    return { id, clientId };
  }

  interface AllocDb {
    owner_id: string | null; posts_per_cycle: number | null; creative_source: string; delivery_batch: string | null; report_format: string | null;
    report_due_day: number | null; platforms: string[]; formats: string[]; default_post_time: string | null;
  }
  const allocOf = async (engagementId: string): Promise<AllocDb> =>
    (await adminPool().query(
      `SELECT owner_id::text AS owner_id, posts_per_cycle, creative_source, delivery_batch, report_format, report_due_day, platforms, formats,
              to_char(default_post_time, 'HH24:MI') AS default_post_time
         FROM social_engagements WHERE id = $1`,
      [engagementId],
    )).rows[0] as AllocDb;
  const eventsOf = async (engagementId: string): Promise<Array<{ fields: string[] }>> =>
    (await adminPool().query(
      `SELECT payload FROM outbox_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'social.engagement.allocation_changed' ORDER BY created_at`,
      [A, engagementId],
    )).rows.map((r: { payload: { fields: string[] } }) => r.payload);
  const activitiesOf = async (importId: string, entityType: string): Promise<Array<{ id: string; verb: string; entityId: string; metadata: Record<string, unknown> }>> =>
    (await adminPool().query(
      `SELECT id::text AS id, verb, target_entity_id::text AS "entityId", metadata FROM activities
        WHERE tenant_id = $1 AND target_entity_type = $2 AND metadata->>'importId' = $3 ORDER BY occurred_at, id`,
      [A, entityType, importId],
    )).rows;
  const countOf = async (sql: string, params: unknown[]): Promise<number> => Number((await adminPool().query(sql, params)).rows[0].n);
  const cyclesOf = (engagementId: string) => countOf(`SELECT count(*)::int AS n FROM social_cycles WHERE tenant_id = $1 AND engagement_id = $2 AND deleted_at IS NULL`, [A, engagementId]);
  const postsOf = (engagementId: string) => countOf(`SELECT count(*)::int AS n FROM social_posts WHERE tenant_id = $1 AND engagement_id = $2`, [A, engagementId]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP6a Agency", ["social", "pm"]);
    C = await createCompany("SCP6a Other Co", ["social"]);
    units = await seedSocialOrgTree(A);

    const people = [
      "smHead", "gmHead", "owner", "platformAdmin", // the four
      "companyAdmin", "officer", // refused `plan`
      "ayu", "budi", "twinOne", "twinTwo", "bot", // officers to match
      "outsider", "cMember",
    ];
    const names: Record<string, string> = { ayu: "Ayu Mock", budi: "Budi Demo", twinOne: "Twin Person", twinTwo: "Twin  Person" };
    for (const p of people) U[p] = await createUser(`${p.toLowerCase()}@scp6a.test`, names[p] ?? `Mock ${p}`);
    const inA = people.filter((p) => !["outsider", "cMember"].includes(p));
    for (const p of inA) await addMembership(A, U[p]);
    await addMembership(C, U.outsider);
    await addMembership(C, U.cMember);
    // A bot is a member of the company but not a person: `users.kind` is not `employee`.
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));

    // 1. The four.
    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff");
    await grantSocialSeat(A, units.gm, U.gmHead);
    await grantSocialRole(A, U.gmHead, "social_staff");
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    // 2. Refused.
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.officer, "social_staff");
    await grantSocialRole(C, U.outsider, "social_staff");

    // The allocation's clients. The studio already holds values, so a row can equal them (unchanged) or differ in part.
    bakery = await makeEngagement(A, "Mock Bakery");
    studio = await makeEngagement(A, "Demo Studio", {
      batch: "A", defaultTime: "09:00", owner: U.ayu, target: 12, source: "in_team", reportFormat: "email", dueDay: 5, platforms: ["instagram", "facebook"], formats: ["feed", "reel"],
    });
    garden = await makeEngagement(A, "Sample Garden Cafe");
    closed = await makeEngagement(A, "Mock Closed Cafe", { status: "closed" });
    // The plan's clients (each with a project, so a made cycle gets its content-month task).
    pastry = await makeEngagement(A, "Mock Pastry House", { batch: "A", project: true, owner: U.ayu, source: "in_team" });
    design = await makeEngagement(A, "Demo Design Studio", { batch: "B", defaultTime: "18:15", project: true, source: "in_team" });
    tea = await makeEngagement(A, "Sample Tea Garden", { project: true, source: "in_team" });
    foreign = await makeEngagement(C, "Mock Foreign Cafe");

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. nobody but the four ───────────────────────────────────────────────────────────────────────────────────────────────────
  it("a company admin, a client's officer and another company's member are refused 403 not_a_social_approver on all three routes, with a bad body too", async () => {
    const before = await allocOf(studio.id);
    for (const who of ["companyAdmin", "officer"]) {
      for (const [kind, bad] of [["parse", { nope: 1 }], ["allocation", { rows: "bad" }], ["plan", [1, 2]], ["allocation", {}]] as const) {
        const r = await imp(U[who], kind, bad);
        expect(r.statusCode, `${who} ${kind}: ${r.body}`).toBe(403);
        expect(r.json().error, `${who} ${kind}`).toBe("not_a_social_approver");
      }
      const real = await imp(U[who], "allocation", { dryRun: false, headerRow: true, columns: ALLOC_COLS, rows: [ALLOC_HEADER, ["Demo Studio", "", "99"]] });
      expect(real.statusCode, who).toBe(403);
    }
    // Another company's member asks about this company: refused, not an empty answer.
    for (const kind of ["parse", "allocation", "plan"] as const) {
      expect((await imp(U.outsider, kind, { text: "a" })).statusCode, kind).toBe(403);
    }
    expect(await allocOf(studio.id)).toEqual(before); // nothing changed
  });

  it("the four approvers import: a Social Media seat holder, a GM seat holder, an owner and platform_admin can all preview both sheets", async () => {
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const a = await imp(U[who], "allocation", { dryRun: true, headerRow: true, columns: ALLOC_COLS, rows: [ALLOC_HEADER, ["Demo Studio", "", "12"]] });
      expect(a.statusCode, `${who} allocation: ${a.body}`).toBe(200);
      const p = await imp(U[who], "plan", { dryRun: true, headerRow: false, columns: PLAN_COLS, rows: [planRow({ client: "Mock Pastry House", date: sheetDay(3), title: "Preview only" })], month: planMonth, dateOrder: "dmy", timeZone: "Asia/Jakarta" });
      expect(p.statusCode, `${who} plan: ${p.body}`).toBe(200);
      const t = await imp(U[who], "parse", { text: "a\tb\n1\t2" });
      expect(t.statusCode, `${who} parse: ${t.body}`).toBe(200);
    }
  });

  // ── 2. parse ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("parse: a csv (quotes, ;, BOM), a paste with tabs and a quoted newline, and an xlsx, each into tabs of text", async () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const csv = await imp(U.smHead, "parse", { filename: "Clients.csv", contentBase64: b64("﻿Client;Note\r\n\"Mock Bakery; Bali\";\"two\nlines\"\r\n") });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.json()).toEqual({ tabs: [{ name: "Clients", rows: [["Client", "Note"], ["Mock Bakery; Bali", "two\nlines"]] }] });

    const pasted = await imp(U.smHead, "parse", { text: "Client\tCaption\r\nMock Bakery\t\"Line one\nLine two\"\r\n" });
    expect(pasted.json()).toEqual({ tabs: [{ name: "Pasted", rows: [["Client", "Caption"], ["Mock Bakery", "Line one\nLine two"]] }] });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Plan");
    ws.getCell("A1").value = "Date";
    ws.getCell("A2").value = new Date(Date.UTC(2026, 11, 3, 9, 30));
    ws.getCell("B2").value = { formula: "1+2", result: 3 };
    wb.addWorksheet("Hidden", { state: "hidden" }).getCell("A1").value = "secret";
    const xlsx = await imp(U.smHead, "parse", { filename: "plan.xlsx", contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString("base64") });
    expect(xlsx.statusCode, xlsx.body).toBe(200);
    expect(xlsx.json()).toEqual({ tabs: [{ name: "Plan", rows: [["Date", ""], ["2026-12-03 09:30", "3"]] }] });
  });

  it("parse: the 400 codes", async () => {
    const field = async (payload: unknown) => { const r = await imp(U.smHead, "parse", payload); expect(r.statusCode, r.body).toBe(400); return r.json(); };
    expect(await field({})).toMatchObject({ error: "invalid_field", field: "body" });
    expect(await field({ text: "a", filename: "a.csv", contentBase64: "YQ==" })).toMatchObject({ error: "invalid_field", field: "body" });
    expect(await field({ filename: "a.xls", contentBase64: "YQ==" })).toMatchObject({ error: "invalid_field", field: "filename" });
    expect(await field({ filename: "a.csv", contentBase64: "not base64!" })).toMatchObject({ error: "invalid_field", field: "contentBase64" });
    expect(await field({ filename: "a.csv", contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61).toString("base64") })).toMatchObject({ error: "invalid_field", field: "contentBase64" });
    expect(await field({ text: "x".repeat(2 * 1024 * 1024 + 1) })).toMatchObject({ error: "invalid_field", field: "text" });
    expect(await field({ filename: "bad.xlsx", contentBase64: Buffer.from("not a workbook").toString("base64") })).toMatchObject({ error: "unreadable_sheet" });
    expect(await field({ text: Array.from({ length: 2001 }, (_, i) => `r${i}`).join("\n") })).toMatchObject({ error: "sheet_too_large", field: "rows" });
    expect(await field({ text: Array.from({ length: 61 }, (_, i) => `c${i}`).join("\t") })).toMatchObject({ error: "sheet_too_large", field: "columns" });
    expect(await field({ text: "x".repeat(5001) })).toMatchObject({ error: "sheet_too_large", field: "cell" });
  });

  // ── 3. the allocation ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const ALLOC_SHEET = [
    ALLOC_HEADER,
    ["mock BAKERY", "Budi Demo", "10 posts", "In-house", "Batch A", "Zoom", "day 7", "IG / FB", "Reels, Post", "7:30 pm"], // every field differs: ready
    ["Demo Studio", "ayu@scp6a.test", "12", "", "", "", "", "", "", ""], // equal to what is stored, the rest empty: unchanged
    ["Sample Garden Cafe", "", "8", "Creatives", "B", "E-mail", "3", "TT, LI", "Story", "9am"], // an empty officer cell clears nothing
  ];
  const allocBody = (rows: string[][], o: Record<string, unknown> = {}) => ({ dryRun: true, headerRow: true, columns: ALLOC_COLS, rows, ...o });
  let allocImportId = "";

  it("allocation preview: every row's outcome and what would change, importId null, nothing written", async () => {
    const before = [await allocOf(bakery.id), await allocOf(studio.id), await allocOf(garden.id)];
    const r = await imp(U.smHead, "allocation", allocBody(ALLOC_SHEET));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.dryRun).toBe(true);
    expect(a.importId).toBeNull();
    expect(a.summary).toEqual({ rows: 3, ready: 2, unchanged: 1, refused: 0, skipped: 0 });
    expect(a.unmatched).toEqual({ clients: [], officers: [] });
    expect(a.rows.map((x: { row: number; outcome: string }) => [x.row, x.outcome])).toEqual([[1, "ready"], [2, "unchanged"], [3, "ready"]]);
    expect(a.rows[0]).toMatchObject({ engagementId: bakery.id, clientName: "Mock Bakery", refusals: [], warnings: [] });
    expect(a.rows[0].changes).toMatchObject({
      postsPerCycle: { from: null, to: 10 }, creativeSource: { from: "creatives", to: "in_team" }, deliveryBatch: { from: null, to: "A" }, reportFormat: { from: null, to: "meeting" },
      reportDueDay: { from: null, to: 7 }, platforms: { from: [], to: ["instagram", "facebook"] }, formats: { from: [], to: ["reel", "feed"] }, defaultPostTime: { from: null, to: "19:30" },
      officer: { from: null, to: { id: U.budi, name: "Budi Demo" } },
    });
    expect([await allocOf(bakery.id), await allocOf(studio.id), await allocOf(garden.id)]).toEqual(before);
    expect(await eventsOf(bakery.id)).toEqual([]);
  });

  it("allocation apply: the PATCH's columns and event, one activity row per changed client carrying the importId; an empty cell clears nothing", async () => {
    const r = await imp(U.smHead, "allocation", allocBody(ALLOC_SHEET, { dryRun: false }));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.dryRun).toBe(false);
    expect(a.importId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    allocImportId = a.importId;
    expect(a.summary).toEqual({ rows: 3, ready: 2, unchanged: 1, refused: 0, skipped: 0 });

    expect(await allocOf(bakery.id)).toEqual({
      owner_id: U.budi, posts_per_cycle: 10, creative_source: "in_team", delivery_batch: "A", report_format: "meeting", report_due_day: 7,
      platforms: ["instagram", "facebook"], formats: ["reel", "feed"], default_post_time: "19:30",
    });
    expect(await allocOf(garden.id)).toEqual({
      owner_id: null, posts_per_cycle: 8, creative_source: "creatives", delivery_batch: "B", report_format: "email", report_due_day: 3,
      platforms: ["tiktok", "linkedin"], formats: ["story"], default_post_time: "09:00",
    });
    // The studio was equal: untouched, and its officer was not cleared by the empty cells.
    expect(await allocOf(studio.id)).toMatchObject({ owner_id: U.ayu, posts_per_cycle: 12, creative_source: "in_team", delivery_batch: "A" });

    // The event, with the fields (the PATCH's body keys), for the two that changed and none for the unchanged one.
    expect((await eventsOf(bakery.id)).map((e) => [...e.fields].sort())).toEqual([[
      "creativeSource", "defaultPostTime", "deliveryBatch", "formats", "officerId", "platforms", "postsPerCycle", "reportDueDay", "reportFormat",
    ]]);
    // Only the fields that differ are written: the garden's creative source already was `creatives`.
    expect((await eventsOf(garden.id)).map((e) => [...e.fields].sort())).toEqual([[
      "defaultPostTime", "deliveryBatch", "formats", "platforms", "postsPerCycle", "reportDueDay", "reportFormat",
    ]]);
    expect(await eventsOf(studio.id)).toEqual([]);

    // The activity: one `updated` per changed client, carrying the import.
    const acts = await activitiesOf(allocImportId, "social_engagement");
    expect(acts.map((x) => x.entityId).sort()).toEqual([bakery.id, garden.id].sort());
    for (const x of acts) {
      expect(x.verb).toBe("updated");
      expect(x.metadata).toMatchObject({ via: "sheet_import", importId: allocImportId });
      expect(Array.isArray(x.metadata.allocation)).toBe(true);
    }
  });

  it("allocation replay: every row answers unchanged and nothing new is written (no event, no activity)", async () => {
    const eventsBefore = (await eventsOf(bakery.id)).length;
    const r = await imp(U.smHead, "allocation", allocBody(ALLOC_SHEET, { dryRun: false }));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.summary).toEqual({ rows: 3, ready: 0, unchanged: 3, refused: 0, skipped: 0 });
    expect(a.importId).not.toBe(allocImportId);
    expect((await eventsOf(bakery.id)).length).toBe(eventsBefore);
    expect(await activitiesOf(a.importId, "social_engagement")).toEqual([]);
  });

  it("one refused row refuses the whole apply (409 import_rows_refused, the preview as detail, nothing written); unticking it lets the rest through", async () => {
    const rows = [ALLOC_HEADER, ["Mock Bakery", "", "999"], ["Demo Studio", "", "13"]];
    const r = await imp(U.smHead, "allocation", allocBody(rows, { dryRun: false }));
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("import_rows_refused");
    const detail = r.json().detail;
    expect(detail.summary).toEqual({ rows: 2, ready: 1, unchanged: 0, refused: 1, skipped: 0 });
    expect(detail.rows[0]).toMatchObject({ row: 1, outcome: "refused", refusals: [{ field: "postsPerCycle", code: "invalid_field" }] });
    expect((await allocOf(studio.id)).posts_per_cycle).toBe(12); // the valid row was not written either
    expect((await allocOf(bakery.id)).posts_per_cycle).toBe(10);

    const ticked = await imp(U.smHead, "allocation", allocBody(rows, { dryRun: false, skip: [1] }));
    expect(ticked.statusCode, ticked.body).toBe(200);
    expect(ticked.json().summary).toEqual({ rows: 2, ready: 1, unchanged: 0, refused: 0, skipped: 1 });
    expect((await allocOf(studio.id)).posts_per_cycle).toBe(13);
    expect((await allocOf(bakery.id)).posts_per_cycle).toBe(10);
  });

  it("every problem of a row is listed at once, and a closed client is not matched", async () => {
    const r = await imp(U.smHead, "allocation", allocBody([ALLOC_HEADER, ["Mock Bakery", "", "", "agency", "C", "post", "40", "Snapchat", "poster", "25:00"], ["Mock Closed Cafe", "", "5"]]));
    const a = r.json();
    expect(a.rows[0].refusals.map((x: { field: string }) => x.field)).toEqual([
      "creativeSource", "deliveryBatch", "reportFormat", "reportDueDay", "platforms", "formats", "defaultPostTime",
    ]);
    expect(a.rows[1].refusals).toEqual([{ field: "client", code: "client_not_found" }]);
    expect(closed.id).toBeTruthy();
  });

  it("a client named on two rows refuses both with duplicate_client", async () => {
    const r = await imp(U.smHead, "allocation", allocBody([ALLOC_HEADER, ["Mock Bakery", "", "4"], ["MOCK bakery", "", "5"]]));
    const a = r.json();
    expect(a.rows.map((x: { outcome: string }) => x.outcome)).toEqual(["refused", "refused"]);
    for (const row of a.rows) expect(row.refusals).toContainEqual({ field: "client", code: "duplicate_client" });
  });

  it("clientMatches and officerMatches resolve the names the server could not match", async () => {
    const rows = [ALLOC_HEADER, ["The Bread Shop", "Nobody Person", "11"], ["Mock Bakry", "", "12"], ["Sample Garden Cafe", "Twin Person", "8"]];
    const preview = await imp(U.smHead, "allocation", allocBody(rows));
    const p = preview.json();
    expect(p.summary).toMatchObject({ rows: 3, refused: 3 });
    expect(p.unmatched.clients.map((x: { sheetName: string; rows: number[] }) => [x.sheetName, x.rows])).toEqual([["The Bread Shop", [1]], ["Mock Bakry", [2]]]);
    expect(p.unmatched.clients[0].suggestions).toEqual([]);
    // The closest first: the bakery shares "mock" and is the shorter name; the pastry house shares it too.
    expect(p.unmatched.clients[1].suggestions[0]).toEqual({ engagementId: bakery.id, clientName: "Mock Bakery" });
    expect(p.unmatched.clients[1].suggestions.length).toBeLessThanOrEqual(3);
    expect(p.unmatched.officers).toEqual([{ sheetName: "Nobody Person", rows: [1] }, { sheetName: "Twin Person", rows: [3] }]);
    expect(p.rows[0].refusals).toEqual([{ field: "client", code: "client_not_found" }, { field: "officer", code: "officer_not_found" }]);
    expect(p.rows[2].refusals).toEqual([{ field: "officer", code: "officer_ambiguous" }]);

    // The person picks: the first sheet name is the bakery, the officer is Ayu; the garden's twin is the second Twin Person. "Mock Bakry" is unticked.
    const picks = { clientMatches: { "The Bread Shop": bakery.id }, officerMatches: { "Nobody Person": U.ayu, "Twin Person": U.twinTwo }, skip: [2] };
    const applied = await imp(U.smHead, "allocation", allocBody(rows, { dryRun: false, ...picks }));
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().summary).toEqual({ rows: 3, ready: 2, unchanged: 0, refused: 0, skipped: 1 });
    expect(await allocOf(bakery.id)).toMatchObject({ posts_per_cycle: 11, owner_id: U.ayu });
    expect(await allocOf(garden.id)).toMatchObject({ owner_id: U.twinTwo });
  });

  it("another company's engagement, a non-member and a bot in a pick are 400 invalid_field, named by their sheet name", async () => {
    const rows = [ALLOC_HEADER, ["Whoever", "Someone", "5"]];
    const foreignPick = await imp(U.smHead, "allocation", allocBody(rows, { clientMatches: { Whoever: foreign.id } }));
    expect(foreignPick.statusCode, foreignPick.body).toBe(400);
    expect(foreignPick.json()).toMatchObject({ error: "invalid_field", field: "clientMatches.Whoever" });
    const closedPick = await imp(U.smHead, "allocation", allocBody(rows, { clientMatches: { Whoever: closed.id } }));
    expect(closedPick.json()).toMatchObject({ error: "invalid_field", field: "clientMatches.Whoever" });
    for (const [label, id] of [["a member of another company only", U.cMember], ["a bot in the company", U.bot], ["a user that does not exist", newId()]] as const) {
      const r = await imp(U.smHead, "allocation", allocBody(rows, { clientMatches: { Whoever: garden.id }, officerMatches: { Someone: id } }));
      expect(r.statusCode, `${label}: ${r.body}`).toBe(400);
      expect(r.json(), label).toMatchObject({ error: "invalid_field", field: "officerMatches.Someone" });
    }
    const plan = await imp(U.smHead, "plan", {
      dryRun: true, headerRow: false, columns: PLAN_COLS, rows: [planRow({ client: "Whoever", date: sheetDay(3), title: "x" })], month: planMonth, dateOrder: "dmy", timeZone: "UTC",
      clientMatches: { Whoever: foreign.id },
    });
    expect(plan.statusCode, plan.body).toBe(400);
    expect(plan.json()).toMatchObject({ error: "invalid_field", field: "clientMatches.Whoever" });
  });

  it("the body's 400s: a column the route does not know, a required column missing, too many rows, a skip outside the rows", async () => {
    const field = async (o: Record<string, unknown>) => { const r = await imp(U.smHead, "allocation", allocBody([ALLOC_HEADER, ["Mock Bakery"]], o)); expect(r.statusCode, r.body).toBe(400); return r.json(); };
    expect(await field({ columns: { client: 0, date: 1 } })).toMatchObject({ error: "invalid_field", field: "columns.date" });
    expect(await field({ columns: { postsPerCycle: 2 } })).toMatchObject({ error: "invalid_field", field: "columns.client" });
    expect(await field({ columns: { client: 0, postsPerCycle: 0 } })).toMatchObject({ error: "invalid_field", field: "columns.postsPerCycle" });
    expect(await field({ columns: { client: 0, postsPerCycle: 60 } })).toMatchObject({ error: "invalid_field", field: "columns.postsPerCycle" });
    expect(await field({ rows: Array.from({ length: 301 }, () => ["x"]) })).toMatchObject({ error: "invalid_field", field: "rows" });
    expect(await field({ skip: [5] })).toMatchObject({ error: "invalid_field", field: "skip" });
    expect(await field({ dryRun: "yes" })).toMatchObject({ error: "invalid_field", field: "dryRun" });
  });

  // ── 4. the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const PLAN_ROWS = [
    PLAN_HEADER,
    planRow({
      client: "Mock Pastry House", date: sheetDay(3), time: "10:00", title: "Morning pastries", format: "Carousel", pillar: "Product", placement: "IG, FB",
      angle: "Fresh daily", objective: "Awareness", keyMessage: "Baked at dawn", visualDirection: "Warm light", caption: "Start the day right.\nSecond line.",
      onAssetText: "Open daily", cta: "Visit us", hashtags: "#pastry #fresh",
    }),
    planRow({ client: "Mock Pastry House", date: sheetDay(4), format: "Reel", placement: "IG", isExtra: "yes", caption: "A reel caption first line\nmore" }),
    planRow({ client: "Demo Design Studio", date: sheetDay(5), title: "Studio launch", format: "Feed" }),
    planRow({ client: "Sample Tea Garden", date: sheetDay(6), time: "9am", title: "Garden post" }), // no batch: no deadline to pre-fill
  ];
  const planBody = (rows: string[][], o: Record<string, unknown> = {}) => ({
    dryRun: true, headerRow: true, columns: PLAN_COLS, rows, month: planMonth, dateOrder: "dmy", timeZone: "Asia/Jakarta", ...o,
  });
  let planImportId = "";
  const postId = (eng: { id: string }, day: number, title: string) => importPostId(A, eng.id, planMonth, isoDay(day), title);

  it("plan preview: each row's cycle (the pre-fill), post and warnings; a client with no batch is no_cycle_deadline; nothing is written", async () => {
    const r = await imp(U.smHead, "plan", planBody(PLAN_ROWS));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.importId).toBeNull();
    expect(a.summary).toEqual({ rows: 4, ready: 3, unchanged: 0, refused: 1, skipped: 0 });
    expect(a.rows[0]).toMatchObject({
      row: 1, outcome: "ready", refusals: [], warnings: [], engagementId: pastry.id, clientName: "Mock Pastry House",
      cycle: { cycleId: null, deadline: prefillA, created: true },
      post: { id: postId(pastry, 3, "Morning pastries"), title: "Morning pastries", format: "carousel", scheduledAt: `${isoDay(3)}T03:00:00.000Z`, isExtra: false, placement: ["instagram", "facebook"] },
    });
    // No time: the default 09:00 (02:00 UTC in Jakarta), with the warning; no title: the caption's first line, with the warning.
    expect(a.rows[1]).toMatchObject({
      outcome: "ready", post: { title: "A reel caption first line", scheduledAt: `${isoDay(4)}T02:00:00.000Z`, isExtra: true, format: "reel" },
    });
    expect(a.rows[1].warnings).toEqual(expect.arrayContaining([{ field: "time", code: "default_time_used" }, { field: "title", code: "title_from_caption" }]));
    // The client's own default time (18:15 Jakarta = 11:15 UTC), and the batch B pre-fill.
    expect(a.rows[2]).toMatchObject({ outcome: "ready", cycle: { cycleId: null, deadline: prefillB, created: true }, post: { scheduledAt: `${isoDay(5)}T11:15:00.000Z` } });
    expect(a.rows[2].warnings).toEqual([{ field: "time", code: "default_time_used" }]);
    expect(a.rows[3]).toMatchObject({ outcome: "refused", refusals: [{ field: "cycle", code: "no_cycle_deadline" }] });
    for (const e of [pastry, design, tea]) { expect(await cyclesOf(e.id)).toBe(0); expect(await postsOf(e.id)).toBe(0); }
  });

  it("one refused row refuses the whole plan apply, and NO cycle is left behind: the transaction rolled back", async () => {
    const r = await imp(U.smHead, "plan", planBody(PLAN_ROWS, { dryRun: false }));
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("import_rows_refused");
    expect(r.json().detail.rows[3]).toMatchObject({ outcome: "refused" });
    for (const e of [pastry, design, tea]) { expect(await cyclesOf(e.id)).toBe(0); expect(await postsOf(e.id)).toBe(0); }
    expect(await countOf(`SELECT count(*)::int AS n FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle'`, [A])).toBe(0);
  });

  it("plan apply: the missing cycles made from the pre-fill with their content-month tasks, the posts planned with their copy, the activity carrying the importId", async () => {
    const r = await imp(U.smHead, "plan", planBody(PLAN_ROWS, { dryRun: false, skip: [4] }));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    planImportId = a.importId;
    expect(planImportId).toMatch(/^[0-9a-f]{8}-/);
    expect(a.summary).toEqual({ rows: 4, ready: 3, unchanged: 0, refused: 0, skipped: 1 });
    expect(a.rows[3].outcome).toBe("skipped");

    // The cycles: the deadline is the pre-fill, ready-by the default buffer of one working day before it.
    const cyc = async (e: { id: string }) => (await adminPool().query(
      `SELECT id::text AS id, to_char(deadline, 'YYYY-MM-DD') AS deadline, to_char(ready_by, 'YYYY-MM-DD') AS ready_by, to_char(month, 'YYYY-MM') AS month
         FROM social_cycles WHERE tenant_id = $1 AND engagement_id = $2 AND deleted_at IS NULL`, [A, e.id])).rows;
    const [cPastry] = await cyc(pastry);
    const [cDesign] = await cyc(design);
    expect(await cyc(pastry)).toHaveLength(1);
    expect(cPastry).toMatchObject({ deadline: prefillA, ready_by: walkBack(prefillA, 1), month: planMonth });
    expect(cDesign).toMatchObject({ deadline: prefillB, ready_by: walkBack(prefillB, 1), month: planMonth });
    expect(await cyclesOf(tea.id)).toBe(0);
    expect(a.rows[0].cycle).toEqual({ cycleId: cPastry.id, deadline: prefillA, created: true });
    expect(a.rows[2].cycle).toEqual({ cycleId: cDesign.id, deadline: prefillB, created: true });

    // The content-month task of each made cycle (63.13): due on the ready-by, linked to the cycle, one per cycle.
    for (const [c, e] of [[cPastry, pastry], [cDesign, design]] as const) {
      const tasks = (await adminPool().query(
        `SELECT title, progress, to_char(due_date, 'YYYY-MM-DD') AS due FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle' AND linked_id = $2 AND deleted_at IS NULL`,
        [A, c.id])).rows;
      expect(tasks, e.id).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ due: c.ready_by, progress: 0 });
      expect(tasks[0].title).toMatch(/ content$/);
    }

    // The posts: planned, in the cycle, with the machine's create columns and the sheet's copy, under their derived ids.
    const post = async (id: string) => (await adminPool().query(
      `SELECT id::text AS id, cycle_id::text AS cycle_id, engagement_id::text AS engagement_id, title, pipeline_status, format, pillar, placement, scheduled_at, is_extra,
              angle, objective, key_message, visual_direction, caption, on_asset_text, cta, hashtags, created_by::text AS created_by, author_id, source
         FROM social_posts WHERE id = $1`, [id])).rows[0];
    const p1 = await post(postId(pastry, 3, "Morning pastries"));
    expect(p1).toMatchObject({
      cycle_id: cPastry.id, engagement_id: pastry.id, title: "Morning pastries", pipeline_status: "planned", format: "carousel", pillar: "Product", placement: ["instagram", "facebook"],
      is_extra: false, angle: "Fresh daily", objective: "Awareness", key_message: "Baked at dawn", visual_direction: "Warm light", caption: "Start the day right.\nSecond line.",
      on_asset_text: "Open daily", cta: "Visit us", hashtags: ["pastry", "fresh"], created_by: U.smHead, author_id: null, source: "human",
    });
    expect(new Date(p1.scheduled_at).toISOString()).toBe(`${isoDay(3)}T03:00:00.000Z`);
    const p2 = await post(postId(pastry, 4, "A reel caption first line"));
    expect(p2).toMatchObject({ pipeline_status: "planned", format: "reel", is_extra: true, placement: ["instagram"], caption: "A reel caption first line\nmore" });
    expect(new Date(p2.scheduled_at).toISOString()).toBe(`${isoDay(4)}T02:00:00.000Z`);
    const p3 = await post(postId(design, 5, "Studio launch"));
    expect(p3).toMatchObject({ cycle_id: cDesign.id, pipeline_status: "planned", format: "feed", caption: "", hashtags: [] });
    expect(new Date(p3.scheduled_at).toISOString()).toBe(`${isoDay(5)}T11:15:00.000Z`);
    expect(await postsOf(tea.id)).toBe(0);

    // The activity: the create's row, with the import on it, for each new post.
    const acts = await activitiesOf(planImportId, "social_post");
    expect(acts.map((x) => x.entityId).sort()).toEqual([p1.id, p2.id, p3.id].sort());
    for (const x of acts) {
      expect(x.verb).toBe("create");
      expect(x.metadata).toMatchObject({ via: "sheet_import", importId: planImportId, from: null, to: "planned", viaPortal: false });
    }
    expect(acts.find((x) => x.entityId === p1.id)!.metadata).toMatchObject({ cycleId: cPastry.id, engagementId: pastry.id });
  });

  it("the plan replay: every row answers unchanged, with the cycle that exists; nothing new is written", async () => {
    const posts = [await postsOf(pastry.id), await postsOf(design.id)];
    const tasks = await countOf(`SELECT count(*)::int AS n FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle'`, [A]);
    const r = await imp(U.smHead, "plan", planBody(PLAN_ROWS, { dryRun: false, skip: [4] }));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.summary).toEqual({ rows: 4, ready: 0, unchanged: 3, refused: 0, skipped: 1 });
    expect(a.rows[0].cycle).toMatchObject({ deadline: prefillA, created: false });
    expect(a.rows[0].cycle.cycleId).toBeTruthy();
    expect([await postsOf(pastry.id), await postsOf(design.id)]).toEqual(posts);
    expect(await countOf(`SELECT count(*)::int AS n FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle'`, [A])).toBe(tasks);
    expect(await cyclesOf(pastry.id)).toBe(1);
    expect(await activitiesOf(a.importId, "social_post")).toEqual([]);
  });

  it("a post discarded since is unchanged with discarded_since, and the import never brings it back", async () => {
    const id = postId(pastry, 3, "Morning pastries");
    await adminPool().query(`UPDATE social_posts SET deleted_at = now() WHERE id = $1`, [id]);
    const before = await postsOf(pastry.id);
    const r = await imp(U.smHead, "plan", planBody(PLAN_ROWS, { dryRun: false, skip: [4] }));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.rows[0]).toMatchObject({ outcome: "unchanged", warnings: [{ field: "post", code: "discarded_since" }] });
    expect(a.summary.unchanged).toBe(3);
    expect(await postsOf(pastry.id)).toBe(before);
    expect((await adminPool().query(`SELECT deleted_at FROM social_posts WHERE id = $1`, [id])).rows[0].deleted_at).not.toBeNull();
  });

  it("a second month-import into an existing cycle: no new cycle, a same_title_in_cycle warning, and a pick resolves a renamed client", async () => {
    const cyclesBefore = await cyclesOf(pastry.id);
    const rows = [
      PLAN_HEADER,
      planRow({ client: "The Pastry Shop", date: sheetDay(12), time: "10:00", title: "a reel caption FIRST line!", format: "Feed" }), // another post of the cycle has that title
    ];
    const r = await imp(U.smHead, "plan", planBody(rows, { dryRun: false, clientMatches: { "The Pastry Shop": pastry.id } }));
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a.summary).toEqual({ rows: 1, ready: 1, unchanged: 0, refused: 0, skipped: 0 });
    expect(a.rows[0].warnings).toEqual([{ field: "title", code: "same_title_in_cycle" }]);
    expect(a.rows[0].cycle).toMatchObject({ created: false, deadline: prefillA });
    expect(await cyclesOf(pastry.id)).toBe(cyclesBefore);
    expect((await adminPool().query(`SELECT pipeline_status FROM social_posts WHERE id = $1`, [a.rows[0].post.id])).rows[0].pipeline_status).toBe("planned");
  });

  it("date refusals: outside the month, in the past, and an unreadable date; the machine's own field rules", async () => {
    const one = async (o: Partial<Record<PlanKey, string>>, extra: Record<string, unknown> = {}) => {
      const r = await imp(U.smHead, "plan", planBody([planRow({ client: "Mock Pastry House", date: sheetDay(20), title: "Rule check", ...o })], { headerRow: false, ...extra }));
      expect(r.statusCode, r.body).toBe(200);
      return r.json().rows[0] as { outcome: string; refusals: Array<{ field: string; code: string }> };
    };
    expect((await one({ date: `3 ${monthAbbr(monthPlus(3))}` })).refusals).toEqual([{ field: "date", code: "date_outside_month" }]);
    expect((await one({ date: "whenever" })).refusals).toEqual([{ field: "date", code: "invalid_field" }]);
    expect((await one({ caption: "c".repeat(5001) })).refusals).toEqual([{ field: "caption", code: "invalid_field" }]);
    expect((await one({ pillar: "p".repeat(61) })).refusals).toEqual([{ field: "pillar", code: "invalid_field" }]);
    expect((await one({ placement: "IG, Snapchat" })).refusals).toEqual([{ field: "placement", code: "invalid_field" }]);
    // SCP-6b1: with nothing to take a title from, one is made from the format and the date, so this row is no longer refused.
    expect((await one({ title: "", caption: "" })).refusals).toEqual([]);
    if (Number(today.slice(8, 10)) > 1) {
      const past = await one({ date: `1 ${monthAbbr(thisMonth)}` }, { month: thisMonth });
      expect(past.refusals).toEqual([{ field: "date", code: "date_in_past" }]);
    }
    // The month before the report month, an unknown order and an unknown zone are 400 on the body.
    for (const [o, field] of [[{ month: monthPlus(-1) }, "month"], [{ dateOrder: "ydm" }, "dateOrder"], [{ timeZone: "Mars/Olympus" }, "timeZone"]] as const) {
      const r = await imp(U.smHead, "plan", planBody([planRow({ client: "Mock Pastry House", date: sheetDay(3), title: "x" })], { headerRow: false, ...o }));
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ error: "invalid_field", field });
    }
  });

  it("the three date orders read the same day", async () => {
    const dmy = `03/${planMonth.slice(5, 7)}/${planMonth.slice(0, 4)}`;
    const mdy = `${planMonth.slice(5, 7)}/03/${planMonth.slice(0, 4)}`;
    const ymd = `${planMonth}-03`;
    for (const [order, cell] of [["dmy", dmy], ["mdy", mdy], ["ymd", ymd]] as const) {
      const r = await imp(U.smHead, "plan", planBody([planRow({ client: "Demo Design Studio", date: cell, time: "10:00", title: `Order ${order}` })], { headerRow: false, dateOrder: order, timeZone: "UTC" }));
      expect(r.statusCode, `${order}: ${r.body}`).toBe(200);
      expect(r.json().rows[0].post.scheduledAt, order).toBe(`${isoDay(3)}T10:00:00.000Z`);
    }
  });

  // ── 4b. the team's real file (SCP-6b1, BFF §63.23.9) ─────────────────────────────────────────────────────────────────────────
  // A synthetic workbook of the real file's shape (made-up names): a CONTENT PLAN whose posts each span two rows with the date, type, links and angle merged
  // down over the pair, and a STORIES tab with one row per story, a merged date shared by two stories of one day, and one blank date that is NOT merged.
  describe("the team's real file", () => {
    const ANGLE = "Content Pillar: Exclusive Offers & Package\nContent Angle: Black Friday\n\nHighlight the added experiences available when booking direct...";
    const HEAD_PLAN = ["POST DATE", "TYPE OF POST", "LINK FOOTAGE", "EDITED IG & FB CONTENT", "INSTAGRAM CONTENT ANGLES", "CAPTION IG", "CAPTION FB"];
    const HEAD_STORIES = ["NUMBER", "POSTING DATE", "TYPE STORIES", "LINK VIDEO/VIDEO PREVIEW", "TEXT", "CTA LINK"];
    let resort: { id: string; clientId: string };
    let tabs: Array<{ name: string; rows: string[][]; merges: number[][] }>;

    /** The rows from the header on, and the merges moved up with them: what the page sends. */
    const fromTab = (tab: { rows: string[][]; merges: number[][] }, headerIdx: number) => ({
      rows: tab.rows.slice(headerIdx),
      merges: tab.merges.filter((m) => m[0] >= headerIdx).map((m) => [m[0] - headerIdx, m[1], m[2] - headerIdx, m[3]]),
    });
    const planCols = { date: 0, format: 1, assetLinks: 2, angle: 4, caption: 5 };
    const storyCols = { date: 1, assetLinks: 3, onAssetText: 4, cta: 5 };
    const storyTitle = (d: number, n = 1) => `Story ${d} ${monthAbbr(planMonth)}${n > 1 ? ` (${n})` : ""}`;
    const readPost = async (id: string) => (await adminPool().query(
      `SELECT title, pipeline_status, format, pillar, angle, key_message, caption, hashtags, raw_assets, scheduled_at, cycle_id::text AS cycle_id
         FROM social_posts WHERE id = $1`, [id])).rows[0];

    it("parse answers the merged ranges of each tab, and the slave cells stay empty", async () => {
      resort = await makeEngagement(A, "Sample Resort", { batch: "A", project: true, source: "in_team" });
      const wb = new ExcelJS.Workbook();
      const cp = wb.addWorksheet("CONTENT PLAN");
      cp.getCell("A1").value = "PERIOD";
      cp.getCell("A2").value = "OUTPUT";
      cp.getCell("A3").value = "FOOTAGE";
      HEAD_PLAN.forEach((h, i) => { cp.getRow(6).getCell(i + 1).value = h; });
      cp.getCell("A7").value = sheetDay(3);
      cp.getCell("B7").value = "CAROUSEL VIDEO";
      cp.getCell("C7").value = "REEL: https://drive.example/a\n\nTHUMBNAIL: https://drive.example/b";
      cp.getCell("E7").value = ANGLE;
      cp.getCell("F7").value = "Sample Resort caption one.\nBook direct.";
      cp.getCell("G7").value = "A caption for the other network.";
      cp.getCell("F8").value = "#SampleResort #BlackFriday";
      cp.getCell("G8").value = "#OtherNetwork";
      cp.getCell("D8").value = "Image description, plain text";
      cp.getCell("A9").value = sheetDay(5);
      cp.getCell("B9").value = "SINGLE POST";
      cp.getCell("E9").value = "Pillar: Rooms\nAngle: Quiet mornings";
      cp.getCell("F9").value = "Wake up slowly.";
      cp.getCell("F10").value = "#Rooms #Calm";
      for (const col of ["A", "B", "C", "E"]) { cp.mergeCells(`${col}7:${col}8`); cp.mergeCells(`${col}9:${col}10`); }
      const st = wb.addWorksheet("STORIES");
      st.getCell("A1").value = "Client:";
      st.getCell("A2").value = "Period:";
      st.getCell("A3").value = "Link Drive:";
      HEAD_STORIES.forEach((h, i) => { st.getRow(7).getCell(i + 1).value = h; });
      st.getCell("A8").value = 1; st.getCell("B8").value = sheetDay(6); st.getCell("C8").value = "PHOTO";
      st.getCell("D8").value = "https://drive.example/s1"; st.getCell("F8").value = "Plan Your Stay\nhttps://stay.example";
      st.getCell("A9").value = 2; st.getCell("B9").value = sheetDay(7); st.getCell("C9").value = "VIDEO"; st.getCell("D9").value = "https://drive.example/s2";
      st.getCell("A10").value = 3; st.getCell("C10").value = "VIDEO"; st.getCell("D10").value = "https://drive.example/s3";
      st.mergeCells("B9:B10"); // the shared day: only the date is merged
      st.getCell("A11").value = 4; st.getCell("C11").value = "VIDEO"; st.getCell("F11").value = "Sample call to action"; // a blank date, NOT merged
      const bytes = Buffer.from(await wb.xlsx.writeBuffer());

      const r = await imp(U.smHead, "parse", { filename: "Sample_ContentPlan.xlsx", contentBase64: bytes.toString("base64") });
      expect(r.statusCode, r.body).toBe(200);
      tabs = r.json().tabs;
      expect(tabs.map((t) => t.name)).toEqual(["CONTENT PLAN", "STORIES"]);
      expect(tabs[0].merges).toEqual([[6, 0, 7, 0], [8, 0, 9, 0], [6, 1, 7, 1], [8, 1, 9, 1], [6, 2, 7, 2], [8, 2, 9, 2], [6, 4, 7, 4], [8, 4, 9, 4]].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
      expect(tabs[0].rows[7][0]).toBe(""); // the slave cell of the date
      expect(tabs[1].merges).toEqual([[8, 1, 9, 1]]);
      // csv and pasted text carry no merges at all.
      expect((await imp(U.smHead, "parse", { text: "a\tb" })).json().tabs[0]).not.toHaveProperty("merges");
    });

    it("the plan: previewed (nothing written), then applied: the posts with pillar, angle, key message, the Instagram caption, the hashtags of row 2 and the links; the joined rows are not written", async () => {
      const { rows, merges } = fromTab(tabs[0], 5);
      const body = (o: Record<string, unknown> = {}) => planBody(rows, { columns: planCols, engagementId: resort.id, merges, ...o });
      const pv = await imp(U.smHead, "plan", body());
      expect(pv.statusCode, pv.body).toBe(200);
      const a = pv.json();
      expect(a.importId).toBeNull();
      expect(a.summary).toEqual({ rows: 4, ready: 2, unchanged: 0, refused: 0, skipped: 0, joined: 2 });
      expect(a.rows.map((x: { outcome: string }) => x.outcome)).toEqual(["ready", "joined", "ready", "joined"]);
      expect(a.rows[1]).toMatchObject({ joinedTo: 1, clientName: "Sample Resort" });
      expect(await postsOf(resort.id)).toBe(0);

      const ap = await imp(U.smHead, "plan", body({ dryRun: false }));
      expect(ap.statusCode, ap.body).toBe(200);
      expect(ap.json().summary).toEqual({ rows: 4, ready: 2, unchanged: 0, refused: 0, skipped: 0, joined: 2 });
      expect(await postsOf(resort.id)).toBe(2);
      const one = await readPost(importPostId(A, resort.id, planMonth, isoDay(3), "Sample Resort caption one."));
      expect(one).toMatchObject({
        pipeline_status: "planned", format: "carousel", pillar: "Exclusive Offers & Package", angle: "Black Friday",
        key_message: "Highlight the added experiences available when booking direct...", caption: "Sample Resort caption one.\nBook direct.",
        hashtags: ["SampleResort", "BlackFriday"],
        raw_assets: [
          { url: "https://drive.example/a", label: "REEL", source: "unknown", aiNote: null },
          { url: "https://drive.example/b", label: "THUMBNAIL", source: "unknown", aiNote: null },
        ],
      });
      const two = await readPost(importPostId(A, resort.id, planMonth, isoDay(5), "Wake up slowly."));
      expect(two).toMatchObject({ format: "feed", pillar: "Rooms", angle: "Quiet mornings", caption: "Wake up slowly.", hashtags: ["Rooms", "Calm"], raw_assets: [] });
      expect(two.key_message).toBeNull();
    });

    it("the stories: every row a story, the shared day's two stories both written with the shared date and distinct titles, the unmerged blank date refused", async () => {
      const { rows, merges } = fromTab(tabs[1], 6);
      const body = (o: Record<string, unknown> = {}) => planBody(rows, { columns: storyCols, engagementId: resort.id, allStories: true, merges, ...o });
      const pv = await imp(U.smHead, "plan", body());
      expect(pv.statusCode, pv.body).toBe(200);
      const a = pv.json();
      expect(a.summary).toEqual({ rows: 4, ready: 3, unchanged: 0, refused: 1, skipped: 0 });
      const blankDate = a.rows.find((x: { outcome: string }) => x.outcome === "refused");
      expect(blankDate.refusals).toEqual([{ field: "date", code: "missing_value" }]);
      expect(blankDate.row).toBe(4);
      const shared = a.rows.find((x: { row: number }) => x.row === 3);
      expect(shared.warnings).toContainEqual({ field: "date", code: "date_from_merged_cell" });

      // The refused row stops the whole apply; unticking it lets the rest through.
      const stopped = await imp(U.smHead, "plan", body({ dryRun: false }));
      expect(stopped.statusCode, stopped.body).toBe(409);
      expect(stopped.json().error).toBe("import_rows_refused");
      expect(await postsOf(resort.id)).toBe(2);
      const ap = await imp(U.smHead, "plan", body({ dryRun: false, skip: [4] }));
      expect(ap.statusCode, ap.body).toBe(200);
      expect(ap.json().summary).toEqual({ rows: 4, ready: 3, unchanged: 0, refused: 0, skipped: 1 });
      expect(await postsOf(resort.id)).toBe(5);

      const s1 = await readPost(importPostId(A, resort.id, planMonth, isoDay(6), "Plan Your Stay"));
      expect(s1).toMatchObject({ format: "story", pipeline_status: "planned", raw_assets: [{ url: "https://drive.example/s1", label: "", source: "unknown", aiNote: null }] });
      const s2 = await readPost(importPostId(A, resort.id, planMonth, isoDay(7), storyTitle(7)));
      const s3 = await readPost(importPostId(A, resort.id, planMonth, isoDay(7), storyTitle(7, 2)));
      expect(s2).toMatchObject({ format: "story", title: storyTitle(7), raw_assets: [{ url: "https://drive.example/s2", label: "", source: "unknown", aiNote: null }] });
      expect(s3).toMatchObject({ format: "story", title: storyTitle(7, 2), raw_assets: [{ url: "https://drive.example/s3", label: "", source: "unknown", aiNote: null }] });
      // The shared date: the same day for both (the time is the engagement's default, 09:00 in Jakarta).
      expect(new Date(s2.scheduled_at).toISOString()).toBe(`${isoDay(7)}T02:00:00.000Z`);
      expect(new Date(s3.scheduled_at).toISOString()).toBe(`${isoDay(7)}T02:00:00.000Z`);
      expect(s2.cycle_id).toBe(s1.cycle_id); // the stories land in the one cycle of the month
    });

    it("the replay of both tabs: every post is unchanged, the joined rows stay joined, nothing new is written", async () => {
      const p = fromTab(tabs[0], 5);
      const s = fromTab(tabs[1], 6);
      const rp = await imp(U.smHead, "plan", planBody(p.rows, { dryRun: false, columns: planCols, engagementId: resort.id, merges: p.merges }));
      expect(rp.statusCode, rp.body).toBe(200);
      expect(rp.json().summary).toEqual({ rows: 4, ready: 0, unchanged: 2, refused: 0, skipped: 0, joined: 2 });
      const rs = await imp(U.smHead, "plan", planBody(s.rows, { dryRun: false, columns: storyCols, engagementId: resort.id, allStories: true, merges: s.merges, skip: [4] }));
      expect(rs.statusCode, rs.body).toBe(200);
      expect(rs.json().summary).toEqual({ rows: 4, ready: 0, unchanged: 3, refused: 0, skipped: 1 });
      expect(await postsOf(resort.id)).toBe(5);
      expect(await cyclesOf(resort.id)).toBe(1);
    });

    it("the 400s: engagementId beside a client column, a foreign or a closed engagement, allStories beside a format column, bad merges", async () => {
      const p = fromTab(tabs[0], 5);
      const base = { columns: planCols, engagementId: resort.id, merges: p.merges };
      const bad = async (o: Record<string, unknown>, field: string) => {
        const r = await imp(U.smHead, "plan", planBody(p.rows, { ...base, ...o }));
        expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
        expect(r.json()).toMatchObject({ error: "invalid_field", field });
      };
      await bad({ columns: { ...planCols, client: 6 } }, "engagementId");
      await bad({ engagementId: foreign.id }, "engagementId");
      await bad({ engagementId: closed.id }, "engagementId");
      await bad({ engagementId: newId() }, "engagementId");
      await bad({ engagementId: "not-a-uuid" }, "engagementId");
      await bad({ allStories: true }, "allStories"); // planCols has a format column
      await bad({ merges: [[0, 0, 99, 0]] }, "merges");
      await bad({ merges: [[0, 0, 1, 0], [1, 0, 2, 0]] }, "merges");
      await bad({ merges: [[0, 0, 0, 60]] }, "merges");
      await bad({ merges: "x" }, "merges");
      // A dry run asks the same questions, and nothing was written by any of them.
      expect(await postsOf(resort.id)).toBe(5);
    });

    it("a footage cell with text and no link is a note, and an http link or eleven links is refused on assetLinks", async () => {
      const cols = { date: 0, title: 1, assetLinks: 2 };
      const eleven = Array.from({ length: 11 }, (_, i) => `https://drive.example/many/${i}`).join("\n");
      const r = await imp(U.smHead, "plan", planBody([
        ["Date", "Title", "Links"], [sheetDay(20), "No link", "to come"], [sheetDay(21), "Plain http", "http://old.example/x"], [sheetDay(22), "Many links", eleven],
      ], { columns: cols, engagementId: resort.id }));
      expect(r.statusCode, r.body).toBe(200);
      const a = r.json();
      expect(a.rows[0]).toMatchObject({ outcome: "ready" });
      expect(a.rows[0].warnings).toContainEqual({ field: "assetLinks", code: "asset_link_missing_url" });
      expect(a.rows[1]).toMatchObject({ outcome: "refused", refusals: [{ field: "assetLinks", code: "invalid_field" }] });
      expect(a.rows[2]).toMatchObject({ outcome: "refused", refusals: [{ field: "assetLinks", code: "invalid_field" }] });
    });
  });

  // ── 5. the body limits ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the import routes take bodies far past Fastify's 1 MiB default, and refuse past their own cap", async () => {
    const MIB = 1024 * 1024;
    // ~3 MiB of allocation rows (an unmapped notes column carries the weight; one client on every row, so each is refused as a duplicate): not a 413.
    const fat = Array.from({ length: 250 }, () => ["Demo Studio", "", "12", "", "", "", "", "", "", "", "n".repeat(12_000)]);
    const big = allocBody([[...ALLOC_HEADER, "Notes"], ...fat]);
    expect(JSON.stringify(big).length).toBeGreaterThan(2.5 * MIB);
    const ok = await imp(U.smHead, "allocation", big);
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(200);
    expect(ok.json().summary.refused).toBe(250);
    // Past the route's own cap (4 MiB of body, with the envelope) Fastify refuses it before the handler.
    const huge = allocBody([[...ALLOC_HEADER, "Notes"], ...Array.from({ length: 299 }, () => ["Demo Studio", "", "12", "", "", "", "", "", "", "", "n".repeat(22_000)])]);
    expect(JSON.stringify(huge).length).toBeGreaterThan(6 * MIB);
    expect((await imp(U.smHead, "allocation", huge)).statusCode).toBe(413);
    // `parse` takes 2 MiB of file as base64 (2.7 MiB of body): a csv of ~1.5 MB reads.
    const csv = Array.from({ length: 1500 }, (_, i) => `row${i},${"x".repeat(990)}`).join("\n");
    expect(Buffer.from(csv).toString("base64").length).toBeGreaterThan(MIB);
    const parsed = await imp(U.smHead, "parse", { filename: "big.csv", contentBase64: Buffer.from(csv).toString("base64") });
    expect(parsed.statusCode, parsed.body.slice(0, 200)).toBe(200);
    expect(parsed.json().tabs[0].rows).toHaveLength(1500);
  }, 60_000);
});
