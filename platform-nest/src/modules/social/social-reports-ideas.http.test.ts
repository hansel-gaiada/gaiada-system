// SCP-5 W5-B2 — the monthly report lists the client's shared ideas (BFF §63.25.1, §63.30.7) against REAL Postgres and REAL Cerbos, through the
// real HTTP layer. Skips without DATABASE_URL_TEST; on CI it runs for real. The PDF round trip through the renderer stand-in also needs
// REDIS_URL_TEST (the print job token lives in Redis); without it the send answers the 503 `pdf_render_not_configured` refusal, as the other
// report suites do.
//
// THE CLAIMS UNDER TEST
//   1. With `ideas.sharedInMonthlyReport` on, a monthly report's document lists the client's ideas marked shared since the PREVIOUS monthly
//      report: not older ones, not a proposed one, not a deleted one, not another client's. The list is frozen with the report.
//   2. With the setting off, nothing is listed and the document has no such table.
//   3. A report keeps the rules it was made under (`rules_ref`): a live draft reads its own setting, not today's, both ways.
//   4. Another kind never lists ideas.
//   5. The page's read and the PDF agree.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import Redis from "ioredis";
import { config } from "../../config";
import { newId } from "../../db";
import { buildApp } from "../../main";
import { setRedis, closeRedis } from "../../events/redis";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../testing/social-pipeline-fixtures";
import { todayIsoInTz } from "../reports/person-scope";
import { addDays } from "../hr/working-days";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { DEFAULTS_VERSION, DEFAULT_RULES, type RulesDoc } from "./pipeline/rules";
import { periodOf, periodRange } from "./pipeline/rules-periods";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

// The gateway: a deterministic stand-in (a monthly create drafts a summary, the three notes and an action plan in one call).
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  const notes = {
    followers: { insight: "Followers held steady.", suggestion: "Keep the weekly series going." },
    engagement: { insight: "Comments rose on the behind-the-scenes posts.", suggestion: "Answer every comment within a day." },
    audience: { insight: "Most of the audience is local.", suggestion: "Post at lunchtime." },
  };
  return {
    ...actual,
    completeViaGateway: async (prompt: string) => {
      if (prompt.includes('"nextPeriod"')) return { text: JSON.stringify({ narrative: "A good period for the brand.", nextPeriod: "More posts are coming." }), provider: "mock" };
      return { text: JSON.stringify({ narrative: "A steady period for the brand.", notes, actionPlan: [{ action: "Plan the next period's reels.", owner: "agency" }] }), provider: "mock" };
    },
  };
});

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });
const DAY = 86_400_000;

/** A name with no digit in it: a digit in a client's name is a "grounded number" the summary guard would accept. */
const alpha = (n: number): string => {
  let s = "";
  let k = n;
  do { s = String.fromCharCode(97 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0);
  return s;
};

interface Doc { tables: Array<{ key: string; label: string; rows: Array<Record<string, unknown>> }>; simulated?: boolean }

describe.skipIf(!TEST_URL)("SCP-5 W5-B2 · the monthly report lists the shared ideas (BFF §63.25.1)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  let seq = 0;
  const rendererBefore = config.reportRenderer;
  let nestBaseUrl = "";
  let sidecar: Server | null = null;
  let sidecarUrl = "";
  const printed: Doc[] = [];

  const TODAY = todayIsoInTz(config.reportsTz);
  const monthsAgo = (n: number): string => periodOf("monthly", addDays(TODAY, -31 * n), 1);
  const base = () => `/api/${A}/modules/social`;
  const get = (who: string, url: string) => app.inject({ method: "GET", url, headers: as(U[who]) });
  const post = (who: string, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: as(U[who]), payload: payload as object });
  const patch = (who: string, url: string, payload: unknown) => app.inject({ method: "PATCH", url, headers: as(U[who]), payload: payload as object });
  const create = (engagementId: string, kind: string, period: string) => post("officer", `${base()}/engagements/${engagementId}/reports`, { kind, period });
  const submit = (id: string) => patch("officer", `${base()}/reports/${id}`, { status: "in_review" });
  const read = async (id: string) => ok(await get("officer", `${base()}/reports/${id}`), 200, `read ${id}`);
  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  const ideasOf = (doc: Doc) => doc.tables.find((t) => t.key === "ideas_shared");
  const sawOf = (doc: Doc): string[] => (ideasOf(doc)?.rows ?? []).map((r) => String(r.saw));
  const frozenTables = async (id: string): Promise<string[]> =>
    ((await adminPool().query(`SELECT metrics FROM social_reports WHERE id = $1`, [id])).rows[0].metrics.tables as Array<{ key: string }>).map((t) => t.key);
  const rulesRefOf = async (id: string): Promise<string> => (await adminPool().query(`SELECT rules_ref FROM social_reports WHERE id = $1`, [id])).rows[0].rules_ref as string;

  interface Eng { id: string; clientId: string }
  async function makeEngagement(name: string): Promise<Eng> {
    const n = ++seq;
    const clientId = await createClient(A, `${name} ${alpha(n)}`);
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_due_day) VALUES ($1, $2, $3, $4, 'active', 10)`,
      [id, A, clientId, `${name} engagement`]);
    await placeOfficerOnAllocation(A, id, U.officer);
    return { id, clientId };
  }

  /** An idea of `e`: proposed, or shared `shared` days ago (and, when `deleted`, since deleted). */
  async function idea(e: Eng, saw: string, o: { shared?: number; deleted?: boolean } = {}): Promise<string> {
    const id = newId();
    const shared = o.shared !== undefined;
    await adminPool().query(
      `INSERT INTO social_ideas (id, tenant_id, engagement_id, saw, metric, suggestion, status, shared_at, shared_by, deleted_at, deleted_by, created_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz, $11, $12, 'central')`,
      [id, A, e.id, saw, `metric of ${saw}`, `suggestion for ${saw}`, shared ? "shared" : "proposed",
        shared ? new Date(Date.now() - o.shared! * DAY) : null, shared ? U.officer : null,
        o.deleted ? new Date() : null, o.deleted ? U.officer : null, U.officer]);
    return id;
  }
  /** Moves a report's creation back in time: the previous monthly report's boundary. */
  const madeDaysAgo = (id: string, days: number) =>
    adminPool().query(`UPDATE social_reports SET created_at = $2::timestamptz WHERE id = $1`, [id, new Date(Date.now() - days * DAY)]);

  /** A new version of the company's rules, as a save from Settings would write it. */
  async function saveRules(mutate: (doc: RulesDoc) => void, section = "ideas"): Promise<void> {
    const cur = (await adminPool().query(`SELECT version, rules FROM social_rule_versions WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`, [A])).rows[0];
    const doc: RulesDoc = JSON.parse(JSON.stringify(cur ? cur.rules : DEFAULT_RULES));
    mutate(doc);
    await adminPool().query(
      `INSERT INTO social_rule_versions (tenant_id, version, rules, section, defaults_version, edited_by) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [A, (cur?.version ?? 0) + 1, JSON.stringify(doc), section, DEFAULTS_VERSION, U.owner]);
  }
  /** The company's setting; `freezeAtSubmit` makes a monthly draft read its numbers (and its rules) live until it is submitted. */
  const setting = (on: boolean, freezeAtSubmit = false) =>
    saveRules((d) => { d.ideas.sharedInMonthlyReport = on; d.reports.kinds.monthly.freezeAt = freezeAtSubmit ? "submit" : "create"; });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    if (REDIS_TEST_URL) setRedis(new Redis(REDIS_TEST_URL));
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5 Ideas Agency", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = ["officer", "hod", "owner"];
    for (const p of people) U[p] = await createUser(`scp5i-${p}@mock.test`, `Mock ${p}`);
    for (const p of people) await addMembership(A, U[p]);
    for (const p of ["officer", "hod"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialRole(A, U.owner, "owner");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    nestBaseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // The renderer stand-in relays to OUR real print-payload route and keeps the document it was asked to print.
    sidecar = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (req.method !== "POST" || req.url !== "/render" || req.headers.authorization !== "Bearer render-tok") { res.writeHead(401).end(); return; }
        const { url } = JSON.parse(raw) as { url: string };
        const payloadRes = await fetch(`${nestBaseUrl}/internal/reports/print-payload/${url.slice(url.lastIndexOf("/") + 1)}`);
        if (!payloadRes.ok) { res.writeHead(502).end(); return; }
        printed.push(((await payloadRes.json()) as { document: Doc }).document);
        res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from("%PDF-fake"));
      });
    });
    await new Promise<void>((resolve) => sidecar!.listen(0, "127.0.0.1", resolve));
    sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    config.reportRenderer = rendererBefore;
    if (sidecar) await new Promise<void>((r) => sidecar!.close(() => r()));
    await app?.close();
    if (REDIS_TEST_URL) await closeRedis();
    await teardownTestDb();
  });

  /** An engagement with its previous monthly report (made 10 days ago) and the ideas around that moment, and another client's idea. */
  async function withHistory(name: string) {
    const e = await makeEngagement(name);
    const other = await makeEngagement(`${name} other`);
    const prev = ok(await create(e.id, "monthly", monthsAgo(2)), 201, "the previous monthly report").id as string;
    await madeDaysAgo(prev, 10);
    const ids = {
      older: await idea(e, "Older shared idea", { shared: 20 }),
      fresh: await idea(e, "Fresh shared idea", { shared: 5 }),
      freshToo: await idea(e, "Second fresh shared idea", { shared: 1 }),
      proposed: await idea(e, "Only proposed idea"),
      deleted: await idea(e, "Deleted shared idea", { shared: 3, deleted: true }),
      elsewhere: await idea(other, "Another client's shared idea", { shared: 5 }),
    };
    return { e, other, prev, ids };
  }
  const FRESH = ["Fresh shared idea", "Second fresh shared idea"]; // oldest share first

  it("setting on: the report lists the ideas shared since the previous monthly report, and no other; the list is frozen", async () => {
    await setting(true);
    const h = await withHistory("On");
    const id = ok(await create(h.e.id, "monthly", monthsAgo(1)), 201, "this month's report").id as string;
    const doc = (await read(id)).document as Doc;
    expect(sawOf(doc)).toEqual(FRESH);
    expect(ideasOf(doc)).toMatchObject({
      label: "Ideas we shared",
      rows: [{ saw: "Fresh shared idea", metric: "metric of Fresh shared idea", suggestion: "suggestion for Fresh shared idea" }, expect.anything()],
    });
    // The previous report was made before them: it never listed these.
    expect(sawOf((await read(h.prev)).document as Doc)).toEqual([]);
    // Frozen with the report: an idea shared afterwards, and one deleted afterwards, change nothing.
    await idea(h.e, "Shared after the report", { shared: 0 });
    await adminPool().query(`UPDATE social_ideas SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [h.ids.fresh, U.officer]);
    expect(sawOf((await read(id)).document as Doc)).toEqual(FRESH);
    expect(await frozenTables(id)).toContain("ideas_shared");
  });

  it("with no previous monthly report every shared idea counts, a proposed one still does not", async () => {
    await setting(true);
    const e = await makeEngagement("First");
    await idea(e, "Shared long ago", { shared: 200 });
    await idea(e, "Shared last week", { shared: 7 });
    await idea(e, "Never shared");
    const id = ok(await create(e.id, "monthly", monthsAgo(1)), 201, "the first monthly report").id as string;
    expect(sawOf((await read(id)).document as Doc)).toEqual(["Shared long ago", "Shared last week"]);
  });

  it("setting off: nothing is listed and the document has no ideas table", async () => {
    await setting(false);
    const h = await withHistory("Off");
    const id = ok(await create(h.e.id, "monthly", monthsAgo(1)), 201, "this month's report").id as string;
    const doc = (await read(id)).document as Doc;
    expect(ideasOf(doc)).toBeUndefined();
    expect(await frozenTables(id)).not.toContain("ideas_shared");
    expect(doc.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["notes", "action_plan"]));
  });

  it("a report keeps the rules it was made under: a live draft reads its own setting, not today's, both ways", async () => {
    // Report ON: made with the setting on. Report OFF: made with it off. Both drafts read their numbers live (freeze at submit).
    await setting(true, true);
    const on = await withHistory("Kept on");
    const onId = ok(await create(on.e.id, "monthly", monthsAgo(1)), 201, "made with the setting on").id as string;
    await setting(false, true);
    const off = await withHistory("Kept off");
    const offId = ok(await create(off.e.id, "monthly", monthsAgo(1)), 201, "made with the setting off").id as string;
    expect(await rulesRefOf(offId)).not.toBe(await rulesRefOf(onId));

    // Today the company has it OFF: the report made ON still lists its ideas, and the one made OFF none.
    const a = await read(onId);
    expect(a.live).toBe(true);
    expect(sawOf(a.document as Doc), "made on, read while the company has it off").toEqual(FRESH);
    // Turn it ON: the report made OFF stays without, the submit freezes under its own rules.
    await setting(true, true);
    const b = await read(offId);
    expect(b.live).toBe(true);
    expect(ideasOf(b.document as Doc), "made off, read while the company has it on").toBeUndefined();
    ok(await submit(offId), 200, "submit the one made off");
    expect(await frozenTables(offId)).not.toContain("ideas_shared");
    // And back OFF: the submit of the one made ON freezes the list.
    await setting(false, true);
    ok(await submit(onId), 200, "submit the one made on");
    expect(await frozenTables(onId)).toContain("ideas_shared");
    expect(sawOf((await read(onId)).document as Doc)).toEqual(FRESH);
  });

  it("another kind never lists ideas, whatever the setting", async () => {
    await setting(true);
    const e = await makeEngagement("Kinds");
    await idea(e, "Shared this week", { shared: 1 });
    const before = (kind: "weekly" | "quarterly") => periodOf(kind, addDays(periodRange(kind, periodOf(kind, TODAY, 1), 1)!.start, -1), 1);
    const weekly = ok(await create(e.id, "weekly", before("weekly")), 201, "a weekly report").id as string;
    const quarterly = ok(await create(e.id, "quarterly", before("quarterly")), 201, "a quarterly report").id as string;
    for (const id of [weekly, quarterly]) {
      expect(ideasOf((await read(id)).document as Doc), id).toBeUndefined();
      expect(await frozenTables(id), id).not.toContain("ideas_shared");
    }
  });

  it("the PDF carries the same list as the page (503 `pdf_render_not_configured` without a renderer)", async () => {
    await setting(true);
    const h = await withHistory("Pdf");
    const id = ok(await create(h.e.id, "monthly", monthsAgo(1)), 201, "this month's report").id as string;
    ok(await submit(id), 200, "submit");
    ok(await post("hod", `${base()}/reports/${id}/approve`), 200, "approve");
    const page = sawOf((await read(id)).document as Doc);
    expect(page).toEqual(FRESH);
    if (!REDIS_TEST_URL) {
      const r = await post("owner", `${base()}/reports/${id}/deliver`);
      expect(r.statusCode, r.body).toBe(503);
      expect(r.json()).toMatchObject({ error: "pdf_render_not_configured" });
      return;
    }
    config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
    try {
      expect(ok(await post("owner", `${base()}/reports/${id}/deliver`), 200, "the owner sends").status).toBe("delivered");
      const doc = printed[printed.length - 1];
      expect(ideasOf(doc)).toMatchObject({ label: "Ideas we shared" });
      expect(sawOf(doc)).toEqual(page);
    } finally {
      config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
    }
  });
});
