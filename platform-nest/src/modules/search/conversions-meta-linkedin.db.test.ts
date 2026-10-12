// M5-P3 (Meta Conversions API) and M5-P4 (LinkedIn Conversions API) against REAL Postgres (and the real HTTP layer). Needs DATABASE_URL_TEST:
// the Linux gate. NOT run on the dev laptop (owner order 2026-10-12: no local Docker); skipped without it. Companion to
// conversions.db.test.ts (P2), same harness shape, its own companies so the two files never share rows.
//
// Acceptance (ticket M5-P3 / M5-P4):
//   a won lead with consent + email files ONE approval per enabled platform target and executes in simulate; no email / phone / fbc /
//   fbp / li_fat_id (nor a hash of the email or phone) in the ledger, the approvals, the outbox, the activity log or the console;
//   a platform without a usable identifier is `skipped` with a reason; the target and ledger CHECKs accept meta_capi and linkedin_capi
//   and still refuse an unknown platform and NULL; the Lead event's id is the bare submission id.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { searchModule } from "./index";
import { convertAgencyLead } from "../../core/agency-lead-convert.service";
import { moveLeadStage } from "../../core/agency-lead-pipeline.service";
import type { OutboxEvent } from "../../events/types";
import { SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV, sha256Hex } from "./conversions";
import { normalizeEmailForMeta, normalizePhoneForMeta } from "./conversions-meta";
import { handleStageChanged } from "./conversions.service";
import { resetLiveConversionUploaders } from "./conversions-uploaders";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const consoleSpies: Array<{ mockRestore: () => void }> = [];
function spyConsole() {
  const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  consoleSpies.push(...spies);
  return spies;
}
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const SLUG = "p34-site";

interface TestLead {
  id: string; submissionRef: string; name: string; email: string; phone: string; fbc: string; fbp: string; liFatId: string;
}

describe.skipIf(!TEST_URL)("M5-P3 / M5-P4 · Meta and LinkedIn conversion uploads (simulate-only)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let uA: string;
  let propA: string;
  let seq = 0;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => adminPool().query(sql, params).then((r) => r.rows as T[]);

  async function newWebLead(over: { consent?: unknown; attribution?: unknown; email?: string | null; phone?: string | null } = {}): Promise<TestLead> {
    const n = ++seq;
    const lead: TestLead = {
      id: newId(), submissionRef: newId(), name: `Prospect Quillon${n}`, email: `quillon${n}.person@pii-check34.test`,
      phone: `+62 811 888 ${String(1000 + n)}`, fbc: `fb.1.1696000000000.IwARfbcvalue${n}abc`, fbp: `fb.1.1696000000000.${9000000000 + n}`,
      liFatId: `fat-${n}-0b3d4c5e8f6a1b2c`,
    };
    const consent = "consent" in over ? over.consent : { analytics: true, marketing: true, version: "3", decided_at: "2026-10-11T09:00:00Z" };
    const attribution = "attribution" in over
      ? over.attribution
      : { landing: "/services/", form_page: "/contact/", fbc: lead.fbc, fbp: lead.fbp, li_fat_id: lead.liFatId, utm_source: "linkedin" };
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, owner_id, origin_site,
                                   submission_ref, origin_form, web_site_slug, attribution, visitor_consent)
         VALUES ($1,$2,$3,$4,$5,$6,'web','in_review','enquiry',$7,'test',$8,'contact',$9,$10,$11)`,
        [
          lead.id, A, `P34 Org ${n}`, lead.name, over.email === undefined ? lead.email : over.email, over.phone === undefined ? lead.phone : over.phone,
          uA, lead.submissionRef, SLUG,
          attribution === undefined ? null : JSON.stringify(attribution), consent === undefined ? null : JSON.stringify(consent),
        ],
      ),
    );
    return lead;
  }

  async function stageEvent(leadId: string, toStage: string): Promise<OutboxEvent> {
    const r = await q<{ id: string; tenant_id: string; entity_type: string; entity_id: string; event_type: string; payload: Record<string, unknown>; origin_site: string; created_at: Date }>(
      `SELECT id, tenant_id, entity_type, entity_id, event_type, payload, origin_site, created_at FROM outbox_events
        WHERE entity_type = 'agency_lead' AND entity_id = $1 AND event_type = 'agency.lead.stage_changed' AND payload->>'toStage' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [leadId, toStage],
    );
    if (!r[0]) throw new Error(`no stage_changed event for ${leadId} -> ${toStage}`);
    return {
      id: r[0].id, tenantId: r[0].tenant_id, entityType: r[0].entity_type, entityId: r[0].entity_id, eventType: r[0].event_type,
      payload: r[0].payload, originSite: r[0].origin_site, schemaVersion: 1, createdAt: new Date(r[0].created_at).toISOString(),
    };
  }

  const ledgerFor = (leadId: string) =>
    q<{ id: string; platform: string; status: string; reason: string | null; mode: string | null; approval_id: string | null; conversion_key: string; deal_value: string | null; outcome: Record<string, unknown> | null }>(
      `SELECT id, platform, status, reason, mode, approval_id, conversion_key, deal_value::text AS deal_value, outcome
         FROM search_conversion_uploads WHERE lead_id = $1 ORDER BY platform, created_at, id`, [leadId]);
  const approvalsFor = (leadId: string) =>
    q<{ id: string; origin: string; workflow_id: string; impact: string; status: string; execution_status: string; execution_error: string | null; tool_args: Record<string, unknown> }>(
      `SELECT id, origin, workflow_id, impact, status, execution_status, execution_error, tool_args
         FROM automation_approvals WHERE tool_args->>'leadId' = $1 ORDER BY tool_args->>'platform', created_at, id`, [leadId]);

  async function evidenceText(): Promise<string> {
    const parts = await Promise.all([
      q<{ t: string }>(`SELECT row_to_json(u)::text AS t FROM search_conversion_uploads u WHERE tenant_id = $1`, [A]),
      q<{ t: string }>(`SELECT row_to_json(a)::text AS t FROM automation_approvals a WHERE tenant_id = $1 AND origin = 'search'`, [A]),
      q<{ t: string }>(`SELECT payload::text AS t FROM outbox_events WHERE tenant_id = $1 AND event_type IN ('agency.lead.stage_changed','automation_approval.decided')`, [A]),
      q<{ t: string }>(`SELECT row_to_json(x)::text AS t FROM activities x WHERE tenant_id = $1 AND (target_entity_type LIKE 'search_conversion%' OR verb IN ('suspended','approved','rejected'))`, [A]),
      q<{ t: string }>(`SELECT row_to_json(n)::text AS t FROM notifications n WHERE tenant_id = $1`, [A]),
    ]);
    return parts.flat().map((r) => r.t).join("\n");
  }
  function assertNoPersonalData(text: string, lead: TestLead): void {
    const email = normalizeEmailForMeta(lead.email) as string;
    const phoneDigits = normalizePhoneForMeta(lead.phone) as string;
    for (const secret of [
      lead.email, lead.email.toUpperCase(), lead.name, lead.fbc, lead.fbp, lead.liFatId, lead.phone, phoneDigits, "quillon",
      sha256Hex(email), sha256Hex(phoneDigits), sha256Hex(`+${phoneDigits}`),
    ]) {
      expect(text.toLowerCase(), `personal data "${secret.slice(0, 6)}..." must not be stored`).not.toContain(secret.toLowerCase());
    }
  }

  const decide = (approvalId: string, decision: "approved" | "rejected") =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(uA), payload: { decision } });

  async function putTarget(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties/${propA}/conversion-targets`, headers: asUser(uA), payload: { webSiteSlug: SLUG, ...payload },
    });
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("M5P34 Co A", ["search"]);
    uA = await createUser("m5p34-a@a.test");
    await addMembership(A, uA);
    const clientA = await createClient(A, "M5P34 Client A");
    app = await buildApp();
    propA = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at) VALUES ($1,$2,$3,$4,$5,now())`,
      [propA, A, clientA, "p34.example.com", "https://p34.example.com"]), S);

    for (const t of [
      { platform: "meta_capi", stage: "qualified", conversionKey: "lead", conversionAction: "Lead", sendValue: false },
      { platform: "meta_capi", stage: "won", conversionKey: "lead_won", conversionAction: "Purchase", sendValue: true },
      { platform: "linkedin_capi", stage: "won", conversionKey: "lead_won", conversionAction: "98765", sendValue: true },
    ]) {
      const res = await putTarget(t);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ created: true, target: { platform: t.platform, stage: t.stage, mode: "simulate" } });
    }
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    delete process.env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV];
    resetLiveConversionUploaders();
  });
  afterEach(() => {
    delete process.env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV];
    for (const sp of consoleSpies.splice(0)) sp.mockRestore();
  });

  async function wonLead(over: Parameters<typeof newWebLead>[0] = {}, deal = { value: "2500.50", currency: "USD" }) {
    const lead = await newWebLead(over);
    const conv = await convertAgencyLead({ tenantId: A, leadId: lead.id, actorUserId: uA, delegations: [], deal });
    expect(conv.outcome).toBe("converted");
    await handleStageChanged(await stageEvent(lead.id, "won"));
    return lead;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // schema
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("the platform CHECKs on the targets and the ledger accept meta_capi and linkedin_capi, still refuse an unknown platform and NULL", async () => {
    const client = await adminPool().connect();
    try {
      await client.query("BEGIN");
      const targetSql = `INSERT INTO search_conversion_targets (id, tenant_id, property_id, web_site_slug, platform, stage_key, conversion_key, conversion_action)
                         VALUES ($1,$2,$3,'chk-site',$4,'won','k','x')`;
      for (const ok of ["google_ads", "meta_capi", "linkedin_capi"]) {
        await client.query("SAVEPOINT s");
        await client.query(targetSql, [newId(), A, propA, ok]);
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      for (const bad of ["tiktok", "META_CAPI", "", null]) {
        await client.query("SAVEPOINT s");
        await expect(client.query(targetSql, [newId(), A, propA, bad]), String(bad)).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      const ledgerSql = `INSERT INTO search_conversion_uploads (id, tenant_id, property_id, platform, lead_id, stage_event_id, submission_ref, stage, conversion_key, status, reason, occurred_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,'won','k','skipped','r',now())`;
      for (const ok of ["meta_capi", "linkedin_capi"]) {
        await client.query("SAVEPOINT s");
        await client.query(ledgerSql, [newId(), A, propA, ok, newId(), newId(), newId()]);
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      for (const bad of ["tiktok", null]) {
        await client.query("SAVEPOINT s");
        await expect(client.query(ledgerSql, [newId(), A, propA, bad, newId(), newId(), newId()]), String(bad)).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("the config route takes a platform's own conversion action and is idempotent; an action from the wrong platform is a typed 400", async () => {
    const again = await putTarget({ platform: "meta_capi", stage: "won", conversionKey: "lead_won", conversionAction: "Purchase", sendValue: true });
    expect(again.json()).toMatchObject({ created: false });
    const wrong = await putTarget({ platform: "meta_capi", stage: "proposal", conversionKey: "p", conversionAction: "customers/1/conversionActions/2" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ reason: "conversion_action_invalid" });
    const wrongLi = await putTarget({ platform: "linkedin_capi", stage: "proposal", conversionKey: "p", conversionAction: "Lead" });
    expect(wrongLi.json()).toMatchObject({ reason: "conversion_action_invalid" });
    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propA}/conversion-targets`, headers: asUser(uA) });
    const platforms = (list.json().targets as Array<{ platform: string }>).map((t) => t.platform);
    expect(platforms).toEqual(expect.arrayContaining(["meta_capi", "linkedin_capi"]));
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // planning
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a won lead with consent and an email -> ONE claim and ONE high-impact WS4 approval per enabled platform target (Meta Purchase, LinkedIn); nothing personal is written", async () => {
    const logs = spyConsole();
    const lead = await wonLead();
    const ledger = await ledgerFor(lead.id);
    expect(ledger.map((l) => [l.platform, l.status, l.conversion_key])).toEqual([
      ["linkedin_capi", "pending_approval", "lead_won"], ["meta_capi", "pending_approval", "lead_won"],
    ]);
    const approvals = await approvalsFor(lead.id);
    expect(approvals).toHaveLength(2);
    for (const a of approvals) expect(a).toMatchObject({ origin: "search", workflow_id: "search.conversions.upload", impact: "high", status: "pending" });
    expect(approvals.map((a) => a.tool_args.platform)).toEqual(["linkedin_capi", "meta_capi"]);
    assertNoPersonalData(await evidenceText(), lead);
    assertNoPersonalData(JSON.stringify(logs.flatMap((s) => s.mock.calls)), lead);
  });

  it("the Lead target (qualified) plans for Meta only; a redelivery converges", async () => {
    const lead = await newWebLead();
    await moveLeadStage(A, lead.id, { stage: "qualified" }, uA);
    const ev = await stageEvent(lead.id, "qualified");
    await handleStageChanged(ev);
    await Promise.all([1, 2, 3].map(() => handleStageChanged(ev)));
    expect((await ledgerFor(lead.id)).map((l) => [l.platform, l.status])).toEqual([["meta_capi", "pending_approval"]]);
    expect(await approvalsFor(lead.id)).toHaveLength(1);
  });

  it("a platform without a usable identifier is `skipped: no_identifier`, the other still files: a lead with a phone and a fbp (no email, no li_fat_id) is Meta-able, not LinkedIn-able", async () => {
    const lead = await newWebLead({ email: null, attribution: { form_page: "/contact/", fbp: "fb.1.1696000000000.5550001111" } });
    await convertAgencyLead({ tenantId: A, leadId: lead.id, actorUserId: uA, delegations: [], deal: { value: "10", currency: "USD" } });
    await handleStageChanged(await stageEvent(lead.id, "won"));
    expect((await ledgerFor(lead.id)).map((l) => [l.platform, l.status, l.reason])).toEqual([
      ["linkedin_capi", "skipped", "no_identifier"], ["meta_capi", "pending_approval", null],
    ]);
    expect(await approvalsFor(lead.id)).toHaveLength(1);
  });

  it("no email, no phone, no cookies, no tracking id -> BOTH are `skipped: no_identifier` and nothing is filed", async () => {
    const lead = await newWebLead({ email: null, phone: null, attribution: { landing: "/x/" } });
    await convertAgencyLead({ tenantId: A, leadId: lead.id, actorUserId: uA, delegations: [], deal: { value: "10", currency: "USD" } });
    await handleStageChanged(await stageEvent(lead.id, "won"));
    expect((await ledgerFor(lead.id)).map((l) => [l.platform, l.status, l.reason])).toEqual([
      ["linkedin_capi", "skipped", "no_identifier"], ["meta_capi", "skipped", "no_identifier"],
    ]);
    expect(await approvalsFor(lead.id)).toHaveLength(0);
  });

  it("consent absent, false or malformed -> both skipped with the consent reason, and fbp / li_fat_id alone never make a lead uploadable", async () => {
    for (const [consent, reason] of [[undefined, "consent_unknown"], [{ marketing: false }, "consent_not_given"], [{ marketing: "true" }, "consent_unknown"]] as const) {
      const lead = await newWebLead({ consent });
      await convertAgencyLead({ tenantId: A, leadId: lead.id, actorUserId: uA, delegations: [], deal: { value: "10", currency: "USD" } });
      await handleStageChanged(await stageEvent(lead.id, "won"));
      expect((await ledgerFor(lead.id)).map((l) => [l.platform, l.status, l.reason]), JSON.stringify(consent)).toEqual([
        ["linkedin_capi", "skipped", reason], ["meta_capi", "skipped", reason],
      ]);
      expect(await approvalsFor(lead.id)).toHaveLength(0);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // decide() — in-band, simulate
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("decide(approved) executes each approval IN-BAND in simulate: kinds and field names recorded, value only on won, nothing identifies the lead", async () => {
    const logs = spyConsole();
    const lead = await wonLead();
    const approvals = await approvalsFor(lead.id);
    const out: Record<string, { status: string; mode: string; identifierKinds: string[] }> = {};
    for (const a of approvals) {
      const res = await decide(a.id, "approved");
      expect(res.statusCode, res.body).toBe(200);
      out[a.tool_args.platform as string] = res.json().conversionUpload;
    }
    expect(out.meta_capi).toMatchObject({ status: "simulated", mode: "simulate", identifierKinds: ["email", "phone", "fbc", "fbp"] });
    expect(out.linkedin_capi).toMatchObject({ status: "simulated", mode: "simulate", identifierKinds: ["email", "li_fat_id"] });

    const ledger = await ledgerFor(lead.id);
    const meta = ledger.find((l) => l.platform === "meta_capi");
    const li = ledger.find((l) => l.platform === "linkedin_capi");
    expect(meta).toMatchObject({ status: "simulated", mode: "simulate", reason: null });
    expect(meta?.outcome).toMatchObject({
      platform: "meta_capi", eventName: "Purchase", eventId: `${lead.submissionRef}:lead_won`, actionSource: "website", valueSent: true, currency: "USD",
      eventSourceUrlSent: true, mergesWithPixelLead: false, identifierKinds: ["email", "phone", "fbc", "fbp"],
      identifierFields: ["user_data.em", "user_data.ph", "user_data.fbc", "user_data.fbp"],
    });
    expect(li).toMatchObject({ status: "simulated", mode: "simulate", reason: null });
    expect(li?.outcome).toMatchObject({
      platform: "linkedin_capi", conversion: "urn:lla:llaPartnerConversion:98765", eventId: `${lead.submissionRef}:lead_won`, valueSent: true, currency: "USD",
      identifierKinds: ["email", "li_fat_id"],
    });
    for (const a of await approvalsFor(lead.id)) expect(a).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
    assertNoPersonalData(await evidenceText(), lead);
    assertNoPersonalData(JSON.stringify(logs.flatMap((s) => s.mock.calls)), lead);
  });

  it("the platform's own Lead event uses the BARE submission id (the Pixel's event id) and does not carry a value", async () => {
    const lead = await newWebLead();
    await moveLeadStage(A, lead.id, { stage: "qualified" }, uA);
    await handleStageChanged(await stageEvent(lead.id, "qualified"));
    const [a] = await approvalsFor(lead.id);
    expect((await decide(a.id, "approved")).json().conversionUpload).toMatchObject({ status: "simulated", platform: "meta_capi" });
    const [led] = await ledgerFor(lead.id);
    expect(led.outcome).toMatchObject({ eventName: "Lead", eventId: lead.submissionRef, mergesWithPixelLead: true, valueSent: false, currency: null });
  });

  it("the gate runs AGAIN at execution: consent withdrawn between filing and approving -> nothing sent, skipped, claim released (Meta and LinkedIn)", async () => {
    const lead = await wonLead();
    await q(`UPDATE agency_leads SET visitor_consent = $2::jsonb WHERE id = $1`, [lead.id, JSON.stringify({ marketing: false })]);
    for (const a of await approvalsFor(lead.id)) {
      expect((await decide(a.id, "approved")).json().conversionUpload, String(a.tool_args.platform)).toMatchObject({ status: "skipped", reason: "consent_not_given" });
    }
    expect((await ledgerFor(lead.id)).map((l) => [l.status, l.reason])).toEqual([["skipped", "consent_not_given"], ["skipped", "consent_not_given"]]);
  });

  it("the identifier is gone at execution (the email erased) -> LinkedIn is skipped `no_identifier`, never sent empty", async () => {
    const lead = await wonLead({ attribution: { form_page: "/contact/" } });
    await q(`UPDATE agency_leads SET contact_email = NULL, contact_phone = NULL WHERE id = $1`, [lead.id]);
    for (const a of await approvalsFor(lead.id)) {
      expect((await decide(a.id, "approved")).json().conversionUpload, String(a.tool_args.platform)).toMatchObject({ status: "skipped", reason: "no_identifier" });
    }
  });

  it("a target whose stored action the platform cannot take (written past the route) is skipped `conversion_request_invalid`, never sent", async () => {
    const lead = await newWebLead();
    await moveLeadStage(A, lead.id, { stage: "qualified" }, uA);
    await handleStageChanged(await stageEvent(lead.id, "qualified"));
    const [a] = await approvalsFor(lead.id);
    await q(`UPDATE search_conversion_targets SET conversion_action = '12345' WHERE tenant_id = $1 AND platform = 'meta_capi' AND stage_key = 'qualified'`, [A]);
    try {
      expect((await decide(a.id, "approved")).json().conversionUpload).toMatchObject({ status: "skipped", reason: "conversion_request_invalid" });
      expect((await ledgerFor(lead.id))[0]).toMatchObject({ status: "skipped", reason: "conversion_request_invalid" });
    } finally {
      await q(`UPDATE search_conversion_targets SET conversion_action = 'Lead' WHERE tenant_id = $1 AND platform = 'meta_capi' AND stage_key = 'qualified'`, [A]);
    }
  });

  it("a rejected approval closes its ledger row `rejected` and sends nothing (the claim stays)", async () => {
    const lead = await wonLead();
    const [first] = await approvalsFor(lead.id);
    expect((await decide(first.id, "rejected")).statusCode).toBe(200);
    const row = (await ledgerFor(lead.id)).find((l) => l.approval_id === first.id);
    expect(row).toMatchObject({ status: "rejected", reason: "approval_rejected" });
  });

  it("in simulate a Meta or LinkedIn ledger row never says `uploaded` (live is refused at boot, unit-tested)", async () => {
    const lead = await wonLead();
    for (const a of await approvalsFor(lead.id)) await decide(a.id, "approved");
    for (const l of await ledgerFor(lead.id)) expect(l.status).not.toBe("uploaded");
  });

  it("the bus still carries only ids: the stage_changed outbox payloads for these leads hold no contact data", async () => {
    const text = (await q<{ t: string }>(`SELECT payload::text AS t FROM outbox_events WHERE tenant_id = $1 AND event_type = 'agency.lead.stage_changed'`, [A])).map((r) => r.t).join("\n");
    expect(text.toLowerCase()).not.toContain("pii-check34");
    expect(text.toLowerCase()).not.toContain("quillon");
  });
});
