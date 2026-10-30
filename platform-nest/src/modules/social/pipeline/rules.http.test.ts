// SCP-5 W5-A0 — the company rules' routes (BFF §63.30.4, §63.30.7; PERMISSION §57) against REAL Postgres (the three walls) and REAL Cerbos,
// through the real HTTP layer. Skips without DATABASE_URL_TEST; runs for real on the Linux CI gate (a skip is not a pass).
//
// THE CLAIMS UNDER TEST
//   1. A company with no row works on the seed: `GET rules` answers version 0, the seed's defaultsVersion and the defaults; a cycle made there
//      records 'default:<defaultsVersion>'.
//   2. The four write (a Social Media seat, a GM seat, an `owner`, `platform_admin`), each save one version, consecutive. Nobody else does: the
//      client's officer, a `company_admin`, a Web Dev head holding `manager`, a `social_manager` grant, an unattended automation and another
//      company's member are 403 `not_a_social_approver` on every write, the history and the preview, BEFORE the body is read.
//   3. Validation: 400 `invalid_field` with its field, for the request and for the value; 409 `rules_changed` with the current version on a stale
//      `expectedVersion`; two saves at once take one version each, never the same one.
//   4. The history is append-only (the table refuses UPDATE and DELETE), newest first, with each version's diff, filtered and paged.
//   5. Reset writes a new version whose section is the seed's, marked `reset`.
//   6. A record keeps its version: a cycle and a report made under version N still name it after N + 1, and read N's rules through it.
//   7. The preview saves nothing; each write records `rules_changed` with its diff.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { withGlobal, withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";
import { DEFAULTS_VERSION, DEFAULT_RULES, fiscalYearStartMonth, rulesByRef, type RulesDoc } from "./rules";

vi.mock("../gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async () => ({
      text: JSON.stringify({
        narrative: "A steady month for the brand.",
        notes: {
          followers: { insight: "Followers held steady.", suggestion: "Keep the weekly series." },
          engagement: { insight: "Comments rose.", suggestion: "Answer every comment." },
          audience: { insight: "Mostly local.", suggestion: "Post at lunchtime." },
        },
        actionPlan: [{ action: "Plan next month's reels.", owner: "agency" }],
      }),
      provider: "mock",
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["social"] };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const today = todayIsoInTz(config.reportsTz);
/** `YYYY-MM` of this month plus `k`. */
function monthPlus(k: number): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

interface Answer {
  version: number; defaultsVersion: string; rules: RulesDoc; defaults: RulesDoc; canEdit: boolean;
  sections: Record<string, { changed: boolean; version: number; editedBy: { id: string; name: string } | null; effectiveFrom: string | null }>;
}

describe.skipIf(!TEST_URL)("SCP-5 W5-A0 · the company rules (BFF §63.30)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency: social on, the pipeline org tree
  let C: string; // another company that never saves: it lives on the seed
  const U: Record<string, string> = {};
  let engA: string;
  let engC: string;

  const url = (path: string, tenant = A) => `/api/${tenant}/modules/social/${path}`;
  const get = (who: string, path: string, tenant = A) => app.inject({ method: "GET", url: url(path, tenant), headers: asUser(U[who]) });
  const send = (method: "PUT" | "POST", who: string, path: string, payload: unknown, tenant = A) =>
    app.inject({ method, url: url(path, tenant), headers: asUser(U[who]), payload: payload as object });
  const put = (who: string, section: string, payload: unknown) => send("PUT", who, `rules/${section}`, payload);
  const reset = (who: string, section: string, payload: unknown) => send("POST", who, `rules/${section}/reset`, payload);
  function ok<T = Answer>(r: LightMyRequestResponse, status: number, label: string): T {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json() as T;
  }
  function refused(r: LightMyRequestResponse, status: number, error: string, label: string, field?: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    expect(r.json().error, label).toBe(error);
    if (field !== undefined) expect(r.json().field, label).toBe(field);
  }
  const read = async (who = "smHead", tenant = A): Promise<Answer> => ok(await get(who, "rules", tenant), 200, `${who} GET rules`);
  const versionsInDb = async (tenant = A): Promise<number[]> =>
    (await adminPool().query<{ version: number }>(`SELECT version FROM social_rule_versions WHERE tenant_id = $1 ORDER BY version`, [tenant])).rows.map((r) => r.version);
  const ideas = (metricRequired: boolean, sharedInMonthlyReport = false) => ({ metricRequired, sharedInMonthlyReport });

  async function makeEngagement(tenant: string, name: string): Promise<string> {
    const clientId = await createClient(tenant, name);
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_due_day, step_estimates)
       VALUES ($1, $2, $3, $4, 'active', 10, '{"proofread":1,"hod":1,"design":2,"final":1,"client":2,"schedule":1}'::jsonb)`,
      [id, tenant, clientId, `${name} engagement`],
    ), S);
    return id;
  }
  const putCycle = (who: string, tenant: string, eng: string, month: string) =>
    send("PUT", who, "cycles", { month, rows: [{ engagementId: eng, deadline: `${month}-01` }] }, tenant);
  const cycleRef = async (tenant: string, eng: string, month: string): Promise<string> =>
    (await adminPool().query<{ rules_ref: string }>(
      `SELECT rules_ref FROM social_cycles WHERE tenant_id = $1 AND engagement_id = $2 AND month = $3::date AND deleted_at IS NULL`,
      [tenant, eng, `${month}-01`],
    )).rows[0]?.rules_ref;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("W5A0 Mock Agency", ["social"]);
    C = await createCompany("W5A0 Mock Other", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = [
      "smHead", "gmHead", "owner", "platformAdmin", // the four
      "officer", "companyAdmin", "webDevHead", "socialManager", "bot", // refused
      "staff", "stranger", "cHead",
    ];
    for (const p of people) U[p] = await createUser(`w5a0-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "stranger" && x !== "cHead")) await addMembership(A, U[p]);
    await addMembership(C, U.stranger);
    await addMembership(C, U.cHead);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));

    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff");
    await grantSocialSeat(A, units.gm, U.gmHead);
    await grantSocialRole(A, U.gmHead, "social_staff");
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.officer, "social_staff");
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.webDev, U.webDevHead);
    await grantSocialRole(A, U.webDevHead, "manager");
    await grantSocialRole(A, U.socialManager, "social_manager");
    await grantSocialRole(A, U.bot, "owner"); // an owner grant on an automation: the plan DENY still refuses it
    await grantSocialRole(A, U.staff, "social_staff");
    await grantSocialRole(C, U.stranger, "social_staff");
    await grantSocialRole(C, U.cHead, "owner");

    engA = await makeEngagement(A, "W5A0 Mock Brand");
    engC = await makeEngagement(C, "W5A0 Mock Other Brand");
    await placeOfficerOnAllocation(A, engA, U.officer);

    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. no row: the seed ─────────────────────────────────────────────────────────────────────────────────────────────────────
  it("a company with no row reads the seed as version 0; the team reads, and only the four may edit", async () => {
    const a = await read("officer");
    expect(a.version).toBe(0);
    expect(a.defaultsVersion).toBe(DEFAULTS_VERSION);
    expect(a.rules).toEqual(DEFAULT_RULES);
    expect(a.defaults).toEqual(DEFAULT_RULES);
    expect(a.canEdit).toBe(false);
    for (const s of ["reports", "ideas", "cycle", "audit", "saved"]) expect(a.sections[s]).toEqual({ changed: false, version: 0, editedBy: null, effectiveFrom: null });
    expect((await read("smHead")).canEdit).toBe(true);
    expect((await read("staff")).canEdit).toBe(false);
    // Another company's member reads nothing of A's.
    expect((await get("stranger", "rules")).statusCode).toBe(403);
    expect(await versionsInDb()).toEqual([]);
  });

  it("a company that never saves works on the seed: its new cycle records the seed's version", async () => {
    const month = monthPlus(2);
    ok(await putCycle("cHead", C, engC, month), 200, "C plans a cycle");
    expect(await cycleRef(C, engC, month)).toBe(`default:${DEFAULTS_VERSION}`);
    expect((await read("cHead", C)).version).toBe(0);
  });

  // ── 2. who edits ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the officer, a company_admin, a Web Dev head, a social_manager, an automation and another company's member are 403 on every write, before the body", async () => {
    for (const who of ["officer", "companyAdmin", "webDevHead", "socialManager", "bot", "stranger", "staff"]) {
      for (const body of [{ expectedVersion: 0, value: ideas(false) }, { nonsense: true }, ["not", "an", "object"]]) {
        refused(await put(who, "ideas", body), 403, "not_a_social_approver", `${who} PUT`);
        refused(await put(who, "no_such_section", body), 403, "not_a_social_approver", `${who} PUT unknown section`);
      }
      refused(await reset(who, "ideas", { expectedVersion: 0 }), 403, "not_a_social_approver", `${who} reset`);
      refused(await get(who, "rules/versions"), 403, "not_a_social_approver", `${who} history`);
      refused(await send("POST", who, "rules/preview", { section: "ideas", value: ideas(false) }), 403, "not_a_social_approver", `${who} preview`);
    }
    expect(await versionsInDb()).toEqual([]);
  });

  it("the four each save: one version each, consecutive, the other sections unchanged, and the activity records the diff", async () => {
    let expected = (await read()).version;
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const flip = expected % 2 === 0;
      const a = ok(await put(who, "ideas", { expectedVersion: expected, value: ideas(!flip, flip) }), 200, `${who} saves`);
      expected += 1;
      expect(a.version).toBe(expected);
      expect(a.rules.ideas).toEqual(ideas(!flip, flip));
      expect(a.rules.reports).toEqual(DEFAULT_RULES.reports);
      expect(a.sections.ideas).toMatchObject({ version: expected, editedBy: { id: U[who] } });
      expect(a.canEdit).toBe(true);
    }
    expect(await versionsInDb()).toEqual([1, 2, 3, 4]);
    const acts = await withTenants([A], (c) => c.query<{ actor_id: string; metadata: { section: string; version: number; reset: boolean; diff: unknown[] } }>(
      `SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = 'rules_changed' AND target_entity_type = 'social_rules' ORDER BY (metadata->>'version')::int`,
      [A],
    ));
    expect(acts.rows.map((r) => r.metadata.version)).toEqual([1, 2, 3, 4]);
    expect(acts.rows[0]).toMatchObject({ actor_id: U.smHead, metadata: { section: "ideas", reset: false } });
    expect(acts.rows[0].metadata.diff).toEqual([
      { path: "ideas.metricRequired", from: true, to: false }, { path: "ideas.sharedInMonthlyReport", from: false, to: true },
    ]);
  });

  // ── 3. validation and concurrency ─────────────────────────────────────────────────────────────────────────────────────────
  it("validation: the request's fields and the value's, each 400 invalid_field with its field", async () => {
    const v = (await read()).version;
    refused(await put("smHead", "no_such_section", { expectedVersion: v, value: {} }), 400, "invalid_field", "unknown section", "section");
    refused(await put("smHead", "ideas", { value: ideas(true) }), 400, "invalid_field", "no expectedVersion", "expectedVersion");
    refused(await put("smHead", "ideas", { expectedVersion: -1, value: ideas(true) }), 400, "invalid_field", "negative expectedVersion", "expectedVersion");
    refused(await put("smHead", "ideas", { expectedVersion: v }), 400, "invalid_field", "no value", "value");
    refused(await put("smHead", "ideas", { expectedVersion: v, value: ideas(true), approvers: [] }), 400, "invalid_field", "unknown body key", "approvers");
    refused(await put("smHead", "ideas", { expectedVersion: v, value: { ...ideas(true), sharedInPortal: true } }), 400, "invalid_field", "unknown rule", "ideas.sharedInPortal");
    const badBands = clone(DEFAULT_RULES.audit);
    badBands.bands[1].from = 90;
    refused(await put("smHead", "audit", { expectedVersion: v, value: badBands }), 400, "invalid_field", "bands out of order", "audit.bands");
    const badDue = clone(DEFAULT_RULES.reports) as unknown as { kinds: { daily: { due: unknown } } };
    badDue.kinds.daily.due = { rule: "report_due_day" };
    refused(await put("smHead", "reports", { expectedVersion: v, value: badDue }), 400, "invalid_field", "a due rule the kind cannot take", "reports.kinds.daily.due");
    const nothing = clone(DEFAULT_RULES.saved);
    nothing.categories[2].holds = [];
    refused(await put("smHead", "saved", { expectedVersion: v, value: nothing }), 400, "invalid_field", "a category that holds nothing", "saved.categories.2.holds");
    refused(await reset("smHead", "ideas", { expectedVersion: v, value: {} }), 400, "invalid_field", "reset takes no value", "value");
    expect((await read()).version).toBe(v); // nothing was written
  });

  it("a stale expectedVersion is 409 rules_changed with the current version; two saves at once never take one version", async () => {
    const v = (await read()).version;
    const stale = await put("smHead", "ideas", { expectedVersion: v - 1, value: ideas(true) });
    refused(stale, 409, "rules_changed", "stale");
    expect(stale.json().detail).toEqual({ currentVersion: v });
    const [x, y] = await Promise.all([
      put("smHead", "ideas", { expectedVersion: v, value: ideas(true) }),
      put("gmHead", "cycle", { expectedVersion: v, value: DEFAULT_RULES.cycle }),
    ]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes, `${x.body} | ${y.body}`).toEqual([200, 409]);
    const loser = x.statusCode === 409 ? x : y;
    expect(loser.json()).toMatchObject({ error: "rules_changed", detail: { currentVersion: v + 1 } });
    // Saved again on the version it was told: consecutive, no gap, no repeat.
    const retry = loser === x ? () => put("smHead", "ideas", { expectedVersion: v + 1, value: ideas(true) }) : () => put("gmHead", "cycle", { expectedVersion: v + 1, value: DEFAULT_RULES.cycle });
    ok(await retry(), 200, "the retry");
    const all = await versionsInDb();
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
  });

  it("the version table refuses UPDATE and DELETE, as the app and as the owner", async () => {
    await expect(withTenants([A], (c) => c.query(`UPDATE social_rule_versions SET reset = true WHERE tenant_id = $1`, [A]), S)).rejects.toThrow(/append-only/);
    await expect(withTenants([A], (c) => c.query(`DELETE FROM social_rule_versions WHERE tenant_id = $1`, [A]), S)).rejects.toThrow(/append-only/);
    await expect(adminPool().query(`UPDATE social_rule_versions SET section = 'audit' WHERE tenant_id = $1 AND version = 1`, [A])).rejects.toThrow(/append-only/);
    await expect(adminPool().query(`DELETE FROM social_rule_versions WHERE tenant_id = $1 AND version = 1`, [A])).rejects.toThrow(/append-only/);
  });

  // ── 4. history and reset ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("reset writes a new version whose section is the seed's, marked reset; the history shows it newest first with its diff", async () => {
    const before = await read();
    expect(before.sections.ideas.changed).toBe(before.rules.ideas.metricRequired !== true || before.rules.ideas.sharedInMonthlyReport !== false);
    ok(await put("smHead", "ideas", { expectedVersion: before.version, value: ideas(false, true) }), 200, "change ideas");
    const after = ok(await reset("owner", "ideas", { expectedVersion: before.version + 1 }), 200, "reset ideas");
    expect(after.version).toBe(before.version + 2);
    expect(after.rules.ideas).toEqual(DEFAULT_RULES.ideas);
    expect(after.sections.ideas).toMatchObject({ changed: false, version: before.version + 2, editedBy: { id: U.owner } });
    const row = (await adminPool().query(`SELECT section, reset, defaults_version, edited_by FROM social_rule_versions WHERE tenant_id = $1 AND version = $2`, [A, after.version])).rows[0];
    expect(row).toEqual({ section: "ideas", reset: true, defaults_version: DEFAULTS_VERSION, edited_by: U.owner });

    const h = ok<{ items: Array<{ version: number; section: string; reset: boolean; editedBy: { id: string }; diff: unknown[] }>; nextCursor: string | null }>(
      await get("gmHead", "rules/versions?section=ideas"), 200, "history");
    expect(h.items[0]).toMatchObject({ version: after.version, section: "ideas", reset: true, editedBy: { id: U.owner } });
    expect(h.items[0].diff).toEqual([
      { path: "ideas.metricRequired", from: false, to: true }, { path: "ideas.sharedInMonthlyReport", from: true, to: false },
    ]);
    expect(h.items.every((i) => i.section === "ideas")).toBe(true);
    expect(h.items.map((i) => i.version)).toEqual([...h.items.map((i) => i.version)].sort((p, q) => q - p));
    // Paging: one a page, until the end.
    const seen: number[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const page: { items: Array<{ version: number }>; nextCursor: string | null } = ok(
        await get("smHead", `rules/versions?limit=1${cursor ? `&cursor=${cursor}` : ""}`), 200, "page");
      seen.push(...page.items.map((i) => i.version));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...(await versionsInDb())].reverse());
    refused(await get("smHead", "rules/versions?cursor=nope"), 400, "invalid_field", "bad cursor", "cursor");
    refused(await get("smHead", "rules/versions?section=people"), 400, "invalid_field", "bad section", "section");
    refused(await get("smHead", "rules/versions?limit=101"), 400, "invalid_field", "bad limit", "limit");
  });

  // ── 5. a record keeps its version ─────────────────────────────────────────────────────────────────────────────────────────
  it("a cycle and a report made under version N keep N after the rules change; the next ones take the new version", async () => {
    const n = (await read()).version;
    const m1 = monthPlus(3);
    ok(await putCycle("smHead", A, engA, m1), 200, "plan a cycle");
    expect(await cycleRef(A, engA, m1)).toBe(`company:${n}`);
    const rep = ok<{ id: string }>(await send("POST", "smHead", `engagements/${engA}/reports`, { kind: "monthly", period: "2026-09" }), 201, "draft a report");
    const repRef = async (id: string) => (await adminPool().query<{ rules_ref: string }>(`SELECT rules_ref FROM social_reports WHERE id = $1`, [id])).rows[0].rules_ref;
    expect(await repRef(rep.id)).toBe(`company:${n}`);

    const fy = clone(DEFAULT_RULES.reports);
    fy.fiscalYearStartMonth = 4;
    ok(await put("gmHead", "reports", { expectedVersion: n, value: fy }), 200, "fiscal year from April");

    // Re-planning the same month keeps the cycle's own version; a new month takes the new one.
    ok(await putCycle("smHead", A, engA, m1), 200, "re-plan the same month");
    expect(await cycleRef(A, engA, m1)).toBe(`company:${n}`);
    const m2 = monthPlus(4);
    ok(await putCycle("smHead", A, engA, m2), 200, "plan the next month");
    expect(await cycleRef(A, engA, m2)).toBe(`company:${n + 1}`);
    expect(await repRef(rep.id)).toBe(`company:${n}`);
    const rep2 = ok<{ id: string }>(await send("POST", "smHead", `engagements/${engA}/reports`, { kind: "monthly", period: "2026-08" }), 201, "another report");
    expect(await repRef(rep2.id)).toBe(`company:${n + 1}`);

    // Each reads its own rules through its ref.
    const [old, now] = await withTenants([A], async (c) => [await rulesByRef(c, A, `company:${n}`), await rulesByRef(c, A, `company:${n + 1}`)], S);
    expect(fiscalYearStartMonth(old.rules)).toBe(1);
    expect(fiscalYearStartMonth(now.rules)).toBe(4);
  });

  // ── 6. the preview ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the preview answers the next due dates and the next cycle's steps, refuses a bad value, and saves nothing", async () => {
    const before = await versionsInDb();
    const fy = clone(DEFAULT_RULES.reports);
    fy.kinds.weekly.due = { rule: "weekday", weekday: 2, week: "next" } as never;
    const p = ok<{ section: string; reports: Array<{ kind: string; period: string; due: string | null }> }>(
      await send("POST", "smHead", "rules/preview", { section: "reports", value: fy, engagementId: engA }), 200, "preview reports");
    expect(p.reports.map((r) => r.kind)).toEqual(["daily", "weekly", "monthly", "quarterly", "semester", "yearly"]);
    for (const r of p.reports) expect(r.due! >= today, `${r.kind} ${r.due}`).toBe(true);
    expect(new Date(`${p.reports[1].due}T00:00:00Z`).getUTCDay()).toBe(2); // a Tuesday
    const noClient = ok<{ reports: Array<{ kind: string; due: string | null }>; reason: string }>(
      await send("POST", "smHead", "rules/preview", { section: "reports", value: fy }), 200, "preview without a client");
    expect(noClient.reason).toBe("no_client");
    expect(noClient.reports.find((r) => r.kind === "monthly")!.due).toBeNull(); // report_due_day needs a client's day

    const steps = clone(DEFAULT_RULES.cycle);
    steps.steps[1].autoClose = { rule: "manual" };
    const cy = ok<{ cycle: { month: string; readyBy: string } | null; steps: Array<{ key: string; title: string; due: string | null; autoClose: string }> }>(
      await send("POST", "owner", "rules/preview", { section: "cycle", value: steps, engagementId: engA }), 200, "preview cycle");
    expect(cy.cycle).not.toBeNull();
    expect(cy.steps.map((s) => s.key)).toEqual(["report", "planning", "copy_lock", "artwork", "client_window", "deploy"]);
    expect(cy.steps[1].autoClose).toBe("manual");
    expect(cy.steps[5].due).toBe(cy.cycle!.readyBy);
    expect(cy.steps[1].due! < cy.steps[5].due!).toBe(true); // planning is before ready-by by the estimates

    // A bad value names its path, `<section>.<path>` (rules.controller.ts header): here the first rule broken is the missing bands.
    refused(await send("POST", "smHead", "rules/preview", { section: "audit", value: { dimensions: [] } }), 400, "invalid_field", "bad value", "audit.bands");
    refused(await send("POST", "smHead", "rules/preview", { section: "ideas", value: ideas(true), engagementId: newId() }), 404, "engagement_not_found", "unknown client");
    refused(await send("POST", "smHead", "rules/preview", { section: "ideas", value: ideas(true), engagementId: engC }), 404, "engagement_not_found", "another company's client");
    expect(await versionsInDb()).toEqual(before);
  });

  it("the walls: an unset tenant GUC, a missing module scope and another tenant read no version row", async () => {
    expect((await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM social_rule_versions WHERE tenant_id = $1`, [A])).rows[0].n).toBeGreaterThan(0);
    const q = `SELECT count(*)::int AS n FROM social_rule_versions`;
    expect((await withGlobal((c) => c.query<{ n: number }>(q))).rows[0].n, "unset GUC").toBe(0);
    expect((await withTenants([A], (c) => c.query<{ n: number }>(q))).rows[0].n, "no module scope").toBe(0);
    expect((await withTenants([C], (c) => c.query<{ n: number }>(q), S)).rows[0].n, "another tenant").toBe(0);
    expect((await withTenants([A], (c) => c.query<{ n: number }>(q), S)).rows[0].n, "the company itself").toBeGreaterThan(0);
  });
});
