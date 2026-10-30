// SCP-5 W5-A3 — "Generate with AI" against REAL Postgres and REAL Cerbos, through the real HTTP layer (BFF §63.24.5, §63.24.6; plan §7 wave 5
// row W5-A3; owner rulings SCP-Q17, Q26, Q37, Q40). Skips without DATABASE_URL_TEST; on CI it runs for real. The gateway is a stand-in that
// never calls a model: it is the REAL gateway client (`completeViaGateway`) with a fake network under it, so every call writes its real
// `ai_usage_events` row, and it counts the calls in flight.
//
// THE CLAIMS UNDER TEST (§63.24.8's run and by-chat lines)
//   1. The gate and the refusals: a member without `create` 403, an automation 403 `automation_cannot_act`, 400 `{field}` for the kind and
//      the period, 400 `period_not_over` for a kind frozen at create (the monthly included).
//   2. An officer's run lists only their own active clients; `kind_not_due` and `internal_client` are listed skipped; a client whose report
//      already exists is `existing` and never redrafted; the gateway down gives a `fallback` draft (`created`); a client whose draft throws
//      is `failed` while the rest finish; never more than four drafts in flight; the end notice; each report's activity names the run.
//   3. Usage: every gateway call of the run is recorded with the run's id and the person, and the progress read sums them (SCP-Q40).
//   4. A second run over the same clients drafts nothing twice (every report `existing`; only the client that failed is drafted).
//   5. The progress read only for the run's person and the four (404 `run_not_found`); the list, the company's for the four.
//   6. The four's run lists every active client of the company.
//   7. One run per company, kind and period (two starts at once: one 202, one 409 `generation_running` `{runId}`) and one RUNNING run per
//      company (a run of another period waits `queued`, then starts by itself when the first ends).
//   8. A worker killed mid-run is resumed by the job with no client drafted twice: one report per client, one gateway call per client.
//   9. By chat: the OBO envelope with an agent runs as the person (their clients only, `requested_by` the person, `via` the agent on the run
//      and on each report's activity); an officer naming another officer's client gets it `skipped` `not_allowed`; the tools' classes.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient, linkIdentity } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { todayIsoInTz } from "../../reports/person-scope";
import { addDays } from "../../hr/working-days";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { periodOf } from "./rules-periods";
import { reportRunsIdle, runReportRunsSweep, setReportRunInterruptForTests } from "./report-runs";
import { MAX_DRAFTS_IN_FLIGHT, runReportId } from "./report-run-plan";

// ── The gateway stand-in ────────────────────────────────────────────────────────────────────────────────────────────────────
// `completeViaGateway` is the real client over a fake network: 200 with provider-reported usage, or 503 for a client named in `downFor`.
// Until `released`, a call waits for MAX_DRAFTS_IN_FLIGHT calls to be in flight together (or 4 s), so the suite sees the bound reached and
// never passed. `hold` keeps every call waiting until the test lets go (the one-run-per-company proofs).
const { gw } = vi.hoisted(() => ({
  gw: {
    calls: 0, inFlight: 0, maxInFlight: 0, released: false, downFor: new Set<string>(),
    hold: null as Promise<void> | null, prompts: [] as string[],
  },
}));
const { kb } = vi.hoisted(() => ({ kb: { throwFor: new Set<string>() } }));
vi.mock("../gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway-client")>();
  return {
    ...actual,
    completeViaGateway: async (prompt: string, opts: Parameters<typeof actual.completeViaGateway>[1]) => {
      gw.calls++;
      gw.prompts.push(prompt);
      gw.inFlight++;
      gw.maxInFlight = Math.max(gw.maxInFlight, gw.inFlight);
      try {
        if (gw.hold) await gw.hold;
        if (!gw.released) {
          const until = Date.now() + 4000;
          while (gw.inFlight < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
          gw.released = true;
        } else {
          await new Promise((r) => setTimeout(r, 20));
        }
        const down = [...gw.downFor].some((name) => prompt.includes(name));
        const fetchImpl = (async () => down
          ? new Response("down", { status: 503 })
          : new Response(JSON.stringify({
            text: JSON.stringify({ narrative: "A good week for the brand.", nextPeriod: "More posts are coming." }),
            provider: "mock", usage: { promptTokens: 100, completionTokens: 40, costUsd: 0.002, source: "provider" },
          }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
        return await actual.completeViaGateway(prompt, { ...opts, gatewayUrl: "http://gateway.test", gatewayToken: "test", fetchImpl });
      } finally {
        gw.inFlight--;
      }
    },
  };
});
// The brand corpus: a client named in `throwFor` makes its draft throw (a failure the template cannot cover).
vi.mock("../knowledge-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../knowledge-client")>();
  return {
    ...actual,
    queryBrandKnowledge: async (_u: string | null, _t: string, clientId: string) => {
      if (kb.throwFor.has(clientId)) throw new Error("mock corpus failure");
      return [];
    },
  };
});

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });
const viaAgent = (externalId: string) => ({ ...SVC, "x-obo-provider": "whatsapp", "x-obo-external-id": externalId, "x-obo-agent": "mock-agent" });

describe.skipIf(!TEST_URL)("SCP-5 W5-A3 · Generate with AI (BFF §63.24.5, §63.24.6)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  const E: Record<string, { id: string; clientId: string; name: string }> = {};
  const flagBefore = config.socialSimulationEnabled;

  const TODAY = todayIsoInTz(config.reportsTz);
  /** The ISO week `k` weeks before this one. */
  const week = (k: number) => periodOf("weekly", addDays(TODAY, -7 * k));

  const base = () => `/api/${A}/modules/social`;
  const generate = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `${base()}/reports/generate`, headers, payload });
  const progress = (who: string, runId: string) => app.inject({ method: "GET", url: `${base()}/reports/generate/${runId}`, headers: as(who) });

  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  function refused(r: LightMyRequestResponse, status: number, code: string, extra: Record<string, unknown> = {}) {
    expect(r.statusCode, `${code}: ${r.body}`).toBe(status);
    expect(r.json(), code).toMatchObject({ error: code, ...extra });
  }
  const resetGateway = () => { gw.calls = 0; gw.maxInFlight = 0; gw.released = false; gw.downFor.clear(); gw.prompts = []; };
  const reportsOf = async (kind: string, period: string) => (await adminPool().query<{ id: string; engagement_id: string; status: string }>(
    `SELECT id::text AS id, engagement_id::text AS engagement_id, status FROM social_reports WHERE tenant_id = $1 AND kind = $2 AND period = $3 AND deleted_at IS NULL`,
    [A, kind, period])).rows;
  const runRow = async (runId: string) => (await adminPool().query(`SELECT to_jsonb(r) AS j FROM social_report_runs r WHERE id = $1`, [runId])).rows[0]?.j as Record<string, any>;
  /** The run's usage rows, once the gateway client's fire-and-forget writes have landed. */
  async function usageRows(runId: string, expected: number) {
    const until = Date.now() + 10_000;
    for (;;) {
      const { rows } = await adminPool().query(`SELECT user_id::text AS user_id, task, outcome, prompt_tokens, completion_tokens, cost_usd FROM ai_usage_events WHERE run_id = $1`, [runId]);
      if (rows.length >= expected || Date.now() > until) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const byName = (results: Array<{ clientName: string }>, name: string) => results.find((r) => r.clientName.startsWith(name));

  async function engagement(key: string, name: string, officer: string, o: { kinds?: string[]; status?: string; internal?: boolean } = {}) {
    let clientId: string;
    if (o.internal) {
      const prior = await adminPool().query<{ id: string }>(`SELECT id::text AS id FROM clients WHERE tenant_id = $1 AND is_internal AND deleted_at IS NULL`, [A]);
      clientId = prior.rows[0]?.id ?? (await createClient(A, name));
      await adminPool().query(`UPDATE clients SET is_internal = true, name = $2 WHERE id = $1`, [clientId, name]);
    } else {
      clientId = await createClient(A, name);
    }
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_kinds) VALUES ($1, $2, $3, $4, $5, $6::text[])`,
      [id, A, clientId, `${name} engagement`, o.status ?? "active", o.kinds ?? ["weekly"]]);
    await placeOfficerOnAllocation(A, id, officer);
    E[key] = { id, clientId, name };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.socialSimulationEnabled = false;
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5 generate agency", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = ["officer", "officer2", "hod", "gm", "member", "bot"];
    for (const p of people) U[p] = await createUser(`scp5-gen-${p}@mock.test`, `Mock ${p}`);
    for (const p of people) await addMembership(A, U[p]);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "officer2", "hod", "gm"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.bot, "company_admin");
    await linkIdentity(U.officer, "whatsapp", "wa-scp5-gen-officer", true);

    // The officer's clients, in the order a run lists them (by name): eight due weekly, one not, the internal client, one paused.
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
    for (const n of names) await engagement(n.toLowerCase(), `Run ${n} client`, U.officer);
    await engagement("india", "Run India client", U.officer, { kinds: [] });
    await engagement("internal", "Run Juliet internal", U.officer, { internal: true });
    await engagement("paused", "Run Kilo client", U.officer, { status: "paused" });
    // The other officer's clients.
    await engagement("lima", "Run Lima client", U.officer2);
    await engagement("mike", "Run Mike client", U.officer2);

    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    setReportRunInterruptForTests(null);
    await reportRunsIdle();
    config.socialSimulationEnabled = flagBefore;
    await app?.close();
    await teardownTestDb();
  });

  it("refuses: a member without create 403, an automation 403, a bad kind or period 400, a period still going 400 period_not_over", async () => {
    expect((await generate(as(U.member), { kind: "weekly", period: week(1) })).statusCode).toBe(403);
    refused(await generate(as(U.bot), { kind: "weekly", period: week(1) }), 403, "automation_cannot_act");
    refused(await generate(as(U.officer), { kind: "campaign", period: week(1) }), 400, "invalid_field", { field: "kind" });
    refused(await generate(as(U.officer), { kind: "weekly", period: "2026-W54" }), 400, "invalid_field", { field: "period" });
    refused(await generate(as(U.officer), { kind: "weekly", period: week(-2) }), 400, "invalid_field", { field: "period" });
    refused(await generate(as(U.officer), { kind: "quarterly", period: periodOf("quarterly", TODAY) }), 400, "period_not_over");
    // The monthly too, unlike its one-client create: a run over a month still going would freeze half of it.
    refused(await generate(as(U.officer), { kind: "monthly", period: periodOf("monthly", TODAY) }), 400, "period_not_over");
    refused(await generate(as(U.officer), { kind: "weekly", period: week(1), engagementIds: ["nope"] }), 400, "invalid_field", { field: "engagementIds" });
    expect(await reportsOf("weekly", week(1))).toEqual([]);
    expect(gw.calls).toBe(0);
  });

  let officerRun = "";
  it("an officer's run: their clients only, skipped and existing listed, the gateway down a fallback, one failure never stops the rest, four in flight", async () => {
    const W = week(1);
    // Bravo's report of the week already exists (a person drafted it): the run must never redraft it.
    gw.released = true;
    const prior = ok(await app.inject({ method: "POST", url: `${base()}/engagements/${E.bravo.id}/reports`, headers: as(U.officer), payload: { kind: "weekly", period: W } }), 201, "Bravo by hand");
    resetGateway();
    gw.downFor.add("Run Charlie client"); // the gateway down for Charlie: the template fills the draft
    kb.throwFor.add(E.delta.clientId); // Delta's draft throws: failed, and the others go on

    const started = ok(await generate(as(U.officer), { kind: "weekly", period: W }), 202, "the officer starts");
    officerRun = started.runId;
    expect(started).toMatchObject({ kind: "weekly", period: W, total: 10 });
    expect(started.clients.map((c: { engagementId: string }) => c.engagementId)).toEqual(
      ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "internal"].map((k) => E[k].id));
    await reportRunsIdle();

    const p = ok(await progress(U.officer, officerRun), 200, "the officer reads the run");
    expect(p).toMatchObject({ runId: officerRun, status: "done", total: 10, done: 10, trigger: "person", scheduleId: null });
    expect(p.finishedAt).not.toBeNull();
    const r = p.results;
    expect(r).toHaveLength(10);
    for (const k of ["Run Alpha", "Run Echo", "Run Foxtrot", "Run Golf", "Run Hotel"]) expect(byName(r, k), k).toMatchObject({ status: "created", draftedVia: "ai" });
    expect(byName(r, "Run Bravo")).toMatchObject({ status: "existing", reportId: prior.id });
    expect(byName(r, "Run Charlie")).toMatchObject({ status: "created", draftedVia: "fallback" });
    expect(byName(r, "Run Delta")).toMatchObject({ status: "failed", reason: "draft_failed" });
    expect(byName(r, "Run India")).toMatchObject({ status: "skipped", reason: "kind_not_due" });
    expect(byName(r, "Run Juliet")).toMatchObject({ status: "skipped", reason: "internal_client" });
    expect(r.some((x: { clientName: string }) => /Kilo|Lima|Mike/.test(x.clientName))).toBe(false);

    // Never more than four drafts in flight, and the four were reached: six clients went to the gateway, once each.
    expect(gw.maxInFlight).toBe(MAX_DRAFTS_IN_FLIGHT);
    expect(gw.calls).toBe(6);
    const reports = await reportsOf("weekly", W);
    expect(reports.filter((x) => x.engagement_id === E.bravo.id)).toHaveLength(1);
    expect(reports.filter((x) => x.engagement_id === E.delta.id)).toHaveLength(0);
    expect(reports).toHaveLength(7); // Bravo's own, and the six the run drafted
    // Each drafted report carries the run in its `created` activity.
    const made = r.filter((x: { status: string }) => x.status === "created").map((x: { reportId: string }) => x.reportId);
    expect(made).toHaveLength(6);
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor, metadata FROM activities WHERE verb = 'created' AND target_entity_type = 'social_report' AND target_entity_id = ANY($1::uuid[])`, [made])).rows;
    expect(acts).toHaveLength(6);
    for (const a of acts) expect(a).toMatchObject({ actor: U.officer, metadata: { runId: officerRun, kind: "weekly", period: W } });
    // The run's row: the person, the company's rules, no agent.
    expect(await runRow(officerRun)).toMatchObject({ requested_by: U.officer, via: null, trigger: "person", status: "done" });

    // The end notice, to the person who started it.
    const notes = (await adminPool().query(`SELECT payload FROM notifications WHERE user_id = $1 AND type = 'social.reports.generated'`, [U.officer])).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0].payload).toMatchObject({ title: "6 drafts ready, 1 already there, 2 skipped, 1 failed", entityId: officerRun, kind: "weekly", period: W });
  });

  it("usage: every call is recorded with the run and the person, and the progress read sums them (SCP-Q40)", async () => {
    const rows = await usageRows(officerRun, 6);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toMatchObject({ user_id: U.officer, task: "social.report_generate" });
    expect(rows.filter((x) => x.outcome === "ok")).toHaveLength(5);
    expect(rows.filter((x) => x.outcome !== "ok")).toHaveLength(1); // Charlie's 503
    const p = ok(await progress(U.officer, officerRun), 200, "the run's usage");
    expect(p.usage).toEqual({ calls: 6, promptTokens: 500, completionTokens: 200, costUsd: 0.01 });
    // The one-client create before the run is recorded with no run.
    const loose = (await adminPool().query(`SELECT count(*)::int AS n FROM ai_usage_events WHERE tenant_id = $1 AND task = 'social.report_generate' AND run_id IS NULL`, [A])).rows[0].n;
    expect(loose).toBe(1);
  });

  it("a second run over the same clients drafts nothing twice: every report is existing, only the one that failed is drafted", async () => {
    const W = week(1);
    resetGateway();
    gw.released = true;
    kb.throwFor.clear();
    const started = ok(await generate(as(U.officer), { kind: "weekly", period: W }), 202, "again");
    await reportRunsIdle();
    const p = ok(await progress(U.officer, started.runId), 200, "the second run");
    expect(p.status).toBe("done");
    expect(byName(p.results, "Run Delta")).toMatchObject({ status: "created", draftedVia: "ai" });
    for (const k of ["Run Alpha", "Run Bravo", "Run Charlie", "Run Echo", "Run Foxtrot", "Run Golf", "Run Hotel"]) {
      expect(byName(p.results, k), k).toMatchObject({ status: "existing" });
    }
    expect(gw.calls).toBe(1);
    const reports = await reportsOf("weekly", W);
    expect(reports).toHaveLength(8);
    for (const k of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]) {
      expect(reports.filter((x) => x.engagement_id === E[k].id), k).toHaveLength(1);
    }
    // A replayed id answers the run as it stands, with no second run.
    const again = ok(await generate(as(U.officer), { id: started.runId, kind: "weekly", period: W }), 200, "replay");
    expect(again).toMatchObject({ runId: started.runId, status: "done", total: 10 });
  });

  it("the progress read is the run's person's and the four's (404 run_not_found otherwise); the list is the company's for the four", async () => {
    refused(await progress(U.officer2, officerRun), 404, "run_not_found");
    refused(await progress(U.officer, newId()), 404, "run_not_found");
    ok(await progress(U.hod, officerRun), 200, "the HoD");
    ok(await progress(U.gm, officerRun), 200, "the GM");
    expect((await progress(U.member, officerRun)).statusCode).toBe(403);
    const mine = ok(await app.inject({ method: "GET", url: `${base()}/reports/generate`, headers: as(U.officer) }), 200, "the officer's list");
    expect(mine.items.map((i: { runId: string }) => i.runId)).toContain(officerRun);
    const theirs = ok(await app.inject({ method: "GET", url: `${base()}/reports/generate`, headers: as(U.officer2) }), 200, "the other officer's list");
    expect(theirs.items).toEqual([]);
    const all = ok(await app.inject({ method: "GET", url: `${base()}/reports/generate`, headers: as(U.hod) }), 200, "the HoD's list");
    expect(all.items.find((i: { runId: string }) => i.runId === officerRun)).toMatchObject({
      kind: "weekly", status: "done", total: 10, counts: { created: 6, existing: 1, skipped: 2, failed: 1 }, requestedBy: U.officer,
    });
  });

  it("one run per company, kind and period (two starts at once: one 202, one 409); one running run per company (the next waits queued)", async () => {
    resetGateway();
    gw.released = true;
    let release!: () => void;
    gw.hold = new Promise<void>((r) => { release = r; });
    const W = week(2);
    const [x, y] = await Promise.all([
      generate(as(U.hod), { kind: "weekly", period: W }),
      generate(as(U.gm), { kind: "weekly", period: W }),
    ]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes, `${x.body} | ${y.body}`).toEqual([202, 409]);
    const winner = (x.statusCode === 202 ? x : y).json();
    refused(x.statusCode === 409 ? x : y, 409, "generation_running", { detail: { runId: winner.runId } });
    // The four's run: every active client of the company, the other officer's too; the paused one left out.
    expect(winner.total).toBe(12);
    expect(winner.clients.map((c: { engagementId: string }) => c.engagementId)).toEqual(expect.arrayContaining([E.lima.id, E.mike.id]));
    expect(winner.clients.map((c: { engagementId: string }) => c.engagementId)).not.toContain(E.paused.id);

    // Another period while the first runs: accepted, but it waits.
    const W3 = week(3);
    const queued = ok(await generate(as(U.officer), { kind: "weekly", period: W3 }), 202, "another period");
    expect((await runRow(queued.runId)).status).toBe("queued");
    expect((await runRow(winner.runId)).status).toBe("running");
    const running = (await adminPool().query(`SELECT count(*)::int AS n FROM social_report_runs WHERE tenant_id = $1 AND status = 'running'`, [A])).rows[0].n;
    expect(running).toBe(1);

    gw.hold = null;
    release();
    await reportRunsIdle();
    expect((await runRow(winner.runId)).status).toBe("done");
    // The first run's end started the queued one by itself.
    expect((await runRow(queued.runId)).status).toBe("done");
    expect(gw.maxInFlight).toBeLessThanOrEqual(MAX_DRAFTS_IN_FLIGHT);
  });

  it("a worker killed mid-run is resumed by the job, and no client is drafted twice (one report and one gateway call each)", async () => {
    resetGateway();
    gw.released = true;
    const W = week(4);
    let written = 0;
    // Die as a crash would: the third client's report is made, its result never written; the drafts in flight at that moment finish
    // their reports but write nothing either.
    setReportRunInterruptForTests(() => ++written === 3);
    const started = ok(await generate(as(U.officer), { kind: "weekly", period: W }), 202, "the run that dies");
    await reportRunsIdle();
    setReportRunInterruptForTests(null);
    const dead = await runRow(started.runId);
    expect(dead.status).toBe("running");
    const pendingAfterDeath = (dead.results as Array<{ status: string }>).filter((e) => e.status === "pending").length;
    expect(pendingAfterDeath).toBeGreaterThan(0);
    const callsBefore = gw.calls;
    const reportsBefore = (await reportsOf("weekly", W)).length;
    expect(reportsBefore).toBeGreaterThan(0); // some drafts were made before the crash

    // A fresh worker would not take it while it beats; once the beat is five minutes old, the job resumes it.
    expect((await runReportRunsSweep({ only: [A], wait: true })).resumed).toBe(0);
    await adminPool().query(`UPDATE social_report_runs SET heartbeat_at = now() - interval '6 minutes' WHERE id = $1`, [started.runId]);
    const sweep = await runReportRunsSweep({ only: [A], wait: true });
    expect(sweep.resumed).toBe(1);
    await reportRunsIdle();

    const p = ok(await progress(U.officer, started.runId), 200, "the resumed run");
    expect(p).toMatchObject({ status: "done", total: 10, done: 10 });
    const drafted = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    for (const k of drafted) {
      expect(byName(p.results, E[k].name), k).toMatchObject({ status: "created", reportId: runReportId(started.runId, E[k].id) });
    }
    const reports = await reportsOf("weekly", W);
    expect(reports).toHaveLength(8);
    for (const k of drafted) expect(reports.filter((x) => x.engagement_id === E[k].id), k).toHaveLength(1);
    // One gateway call per client over the crash and the resume: the reports made before the crash were found again by id.
    expect(gw.calls).toBe(8);
    expect(gw.calls - callsBefore).toBe(8 - reportsBefore);
    expect((await usageRows(started.runId, 8)).length).toBe(8);
  });

  it("by chat: the agent runs as the person (their clients, `via` on the run and the reports); another officer's client is not_allowed", async () => {
    resetGateway();
    gw.released = true;
    const W = week(5);
    const started = ok(await generate(viaAgent("wa-scp5-gen-officer"), { kind: "weekly", period: W }), 202, "the officer's agent");
    expect(started.clients.map((c: { engagementId: string }) => c.engagementId)).not.toContain(E.lima.id);
    await reportRunsIdle();
    const row = await runRow(started.runId);
    expect(row).toMatchObject({ requested_by: U.officer, status: "done", via: { provider: "whatsapp", externalId: "wa-scp5-gen-officer", agent: "mock-agent" } });
    const made = (row.results as Array<{ status: string; reportId?: string }>).filter((e) => e.status === "created").map((e) => e.reportId);
    expect(made).toHaveLength(8);
    const acts = (await adminPool().query(`SELECT actor_id::text AS actor, metadata FROM activities WHERE verb = 'created' AND target_entity_type = 'social_report' AND target_entity_id = ANY($1::uuid[])`, [made])).rows;
    expect(acts).toHaveLength(8);
    for (const a of acts) expect(a).toMatchObject({ actor: U.officer, metadata: { runId: started.runId, via: { agent: "mock-agent" } } });
    const usage = await usageRows(started.runId, 8);
    for (const u of usage) expect(u.user_id).toBe(U.officer);

    // Naming another officer's client: listed skipped, never drafted.
    const W6 = week(6);
    const named = ok(await generate(viaAgent("wa-scp5-gen-officer"), { kind: "weekly", period: W6, engagementIds: [E.alpha.id, E.lima.id] }), 202, "named clients");
    await reportRunsIdle();
    const p = ok(await progress(U.officer, named.runId), 200, "the named run");
    expect(byName(p.results, "Run Lima")).toMatchObject({ status: "skipped", reason: "not_allowed" });
    expect(byName(p.results, "Run Alpha")).toMatchObject({ status: "created" });
    expect((await reportsOf("weekly", W6)).map((x) => x.engagement_id)).toEqual([E.alpha.id]);
    // An automation is refused, by chat as anywhere.
    refused(await generate(as(U.bot), { kind: "weekly", period: W6 }), 403, "automation_cannot_act");
  });

  it("the tools: social.generateReports a medium-impact write on the route, social.reportRun a read", () => {
    const tools = socialModule.mcpTools ?? [];
    const gen = tools.find((t) => t.name === "social.generateReports");
    const read = tools.find((t) => t.name === "social.reportRun");
    expect(gen).toMatchObject({ write: true, impact: "medium", method: "POST", pathTemplate: "/api/:tenantId/modules/social/reports/generate" });
    expect(read).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/social/reports/generate/:runId" });
    expect(read?.write).toBeFalsy();
    // No tool of this ticket approves or sends.
    for (const t of [gen, read]) expect(t?.pathTemplate).not.toMatch(/approve|deliver/);
  });
});
