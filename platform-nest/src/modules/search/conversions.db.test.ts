// M5-P2 — ad-platform conversion uploads against REAL Postgres (and the real HTTP layer). Needs DATABASE_URL_TEST (+ REDIS_URL_TEST for the
// last test): the Linux gate. NOT run on the dev laptop (owner order 2026-10-12: no local Docker); skipped without it.
//
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §8 and the P2 ticket's acceptance list:
//   consent absent / false / malformed -> no upload, no approval (ledger `skipped` with a reason); suppression -> skipped; no identifier ->
//   skipped; a won lead with consent + gclid -> exactly ONE claim and ONE approval; replay and regress-and-advance -> no second upload;
//   decide() executes in simulate mode and records the outcome; the approval row, the outbox and the logs contain no email, phone or gclid;
//   the denial paths; the consumer loop really delivers the event to the handler.
//
// Authorization uses the recording Cerbos double (as content-decay.db.test.ts does), so what is asserted is WHICH kind/action each route and decide()
// ask for, and that a denial leaves the row `pending` and sends nothing. Every denial sends a VALID body, so validation never pre-empts authz.
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
import { addContactSuppressions } from "../../core/agency-privacy.service";
import { contactHashes } from "../../core/agency-privacy.subject";
import { relayBatch } from "../../events/relay";
import { consumeOnce } from "../../events/consumer.service";
import type { OutboxEvent } from "../../events/types";
import { conversionContentHash, sha256Hex, SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV, normalizeEmailForGoogle, type ConversionBinding } from "./conversions";
import { handleStageChanged } from "./conversions.service";
import { registerLiveConversionUploader, resetLiveConversionUploaders } from "./conversions-uploaders";
import type { UploadInput, UploadResult } from "./conversions-google";

const calls: Array<{ kind: string; action: string; id?: string; tenantId?: string }> = [];
let denyAll = false;
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (_p: never, resource: { kind: string; id?: string; tenantId?: string }, action: string) => {
      calls.push({ kind: resource.kind, action, id: resource.id, tenantId: resource.tenantId });
      return denyAll ? { allow: false as const, reason: "test-forced-deny" } : { allow: true as const };
    }),
  };
});

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
/** Capture every console line a handler or executor writes, so "the logs contain no personal data" is asserted, not assumed. */
const consoleSpies: Array<{ mockRestore: () => void }> = [];
function spyConsole() {
  const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  consoleSpies.push(...spies);
  return spies;
}
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const SLUG = "site-a";

interface TestLead {
  id: string; submissionRef: string; orgName: string; name: string; email: string; phone: string; gclid: string;
}

describe.skipIf(!TEST_URL)("M5-P2 · ad-platform conversion uploads", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let uA: string;
  let uB: string;
  let propA: string;
  let propB: string;

  let seq = 0;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => adminPool().query(sql, params).then((r) => r.rows as T[]);

  /** A web lead as the app role. Distinctive contact fields and click id so a grep for personal data can find them. */
  async function newWebLead(over: {
    consent?: unknown; attribution?: unknown; email?: string | null; phone?: string | null; slug?: string; status?: string; submissionRef?: string | null;
  } = {}): Promise<TestLead> {
    const n = ++seq;
    const lead: TestLead = {
      id: newId(), submissionRef: over.submissionRef === null ? "" : (over.submissionRef ?? newId()),
      orgName: `Conv Org ${n}`, name: `Prospect Zebedee${n}`, email: `zebedee${n}.person@pii-check.test`,
      phone: `+62 811 777 ${String(1000 + n)}`, gclid: `GCLIDvalue${n}_abc-DEF`,
    };
    const consent = "consent" in over ? over.consent : { analytics: true, marketing: true, version: "3", decided_at: "2026-10-11T09:00:00Z" };
    const attribution = "attribution" in over ? over.attribution : { landing: "/services/", gclid: lead.gclid, utm_source: "google" };
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, owner_id, origin_site,
                                   submission_ref, origin_form, web_site_slug, attribution, visitor_consent)
         VALUES ($1,$2,$3,$4,$5,$6,'web',$7,'enquiry',$8,'test',$9,'contact',$10,$11,$12)`,
        [
          lead.id, A, lead.orgName, lead.name, over.email === undefined ? lead.email : over.email, over.phone === undefined ? lead.phone : over.phone,
          over.status ?? "in_review", uA, over.submissionRef === null ? null : lead.submissionRef, over.slug ?? SLUG,
          attribution === undefined ? null : JSON.stringify(attribution), consent === undefined ? null : JSON.stringify(consent),
        ],
      ),
    );
    return lead;
  }

  /** The stage_changed outbox row for a lead, as the event the consumer would hand the handler. */
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
    q<{ id: string; status: string; reason: string | null; mode: string | null; approval_id: string | null; stage: string; conversion_key: string; deal_value: string | null; deal_currency: string | null; outcome: Record<string, unknown> | null; stage_event_id: string; content_hash: string | null }>(
      `SELECT id, status, reason, mode, approval_id, stage, conversion_key, deal_value::text AS deal_value, deal_currency, outcome, stage_event_id, content_hash
         FROM search_conversion_uploads WHERE lead_id = $1 ORDER BY created_at, id`, [leadId]);
  const approvalsFor = (leadId: string) =>
    q<{ id: string; origin: string; workflow_id: string; tool_name: string; impact: string; status: string; execution_status: string; execution_error: string | null; execution_result: unknown; requested_by: string | null; executed_by: string | null; decided_by: string | null; tool_args: Record<string, unknown>; reason: string | null }>(
      `SELECT id, origin, workflow_id, tool_name, impact, status, execution_status, execution_error, execution_result, requested_by, executed_by, decided_by, tool_args, reason
         FROM automation_approvals WHERE tool_args->>'leadId' = $1 ORDER BY created_at, id`, [leadId]);

  /** Every place personal data could land, as text. The tenant-wide scans are what make "contains no email/phone/gclid" real. */
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
    const normalised = normalizeEmailForGoogle(lead.email) as string;
    const digits = lead.phone.replace(/\D/g, "");
    for (const secret of [
      lead.email, lead.email.toUpperCase(), lead.name, lead.gclid, digits, lead.phone,
      sha256Hex(normalised), sha256Hex(`+${digits}`), "zebedee",
    ]) {
      expect(text.toLowerCase(), `personal data "${secret.slice(0, 6)}..." must not be stored`).not.toContain(secret.toLowerCase());
    }
  }

  const decide = (approvalId: string, decision: "approved" | "rejected", user = uA) =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(user), payload: { decision } });

  /** A lead moved to `stage`, handled, returning the pieces. */
  async function planFor(stage: string, lead?: TestLead, deal?: { value: string; currency: string }) {
    const l = lead ?? (await newWebLead());
    const moved = await moveLeadStage(A, l.id, { stage, ...(deal ? { deal } : {}) }, uA);
    if (moved.outcome !== "ok") throw new Error(`move failed: ${JSON.stringify(moved)}`);
    const ev = await stageEvent(l.id, stage);
    await handleStageChanged(ev);
    return { lead: l, ev, ledger: await ledgerFor(l.id), approvals: await approvalsFor(l.id) };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("M5P2 Co A", ["search"]);
    B = await createCompany("M5P2 Co B", ["search"]);
    uA = await createUser("m5p2-a@a.test");
    uB = await createUser("m5p2-b@b.test");
    await addMembership(A, uA);
    await addMembership(B, uB);
    const clientA = await createClient(A, "M5P2 Client A");
    const clientB = await createClient(B, "M5P2 Client B");
    app = await buildApp();
    const mkProp = async (tenant: string, client: string, domain: string): Promise<string> => {
      const id = newId();
      await withTenants([tenant], (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at) VALUES ($1,$2,$3,$4,$5,now())`,
        [id, tenant, client, domain, `https://${domain}`]), S);
      return id;
    };
    propA = await mkProp(A, clientA, "site-a.example.com");
    propB = await mkProp(B, clientB, "site-b.example.com");

    // The two targets the tests use, created through the real route (and asserted in the route tests below).
    for (const t of [
      { stage: "qualified", conversionKey: "lead_qualified", sendValue: false },
      { stage: "won", conversionKey: "lead_won", sendValue: true },
    ]) {
      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/properties/${propA}/conversion-targets`, headers: asUser(uA),
        payload: { webSiteSlug: SLUG, platform: "google_ads", conversionAction: "customers/111/conversionActions/222", ...t },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    calls.length = 0;
    denyAll = false;
    delete process.env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV];
    resetLiveConversionUploaders();
  });
  afterEach(() => {
    delete process.env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV];
    for (const sp of consoleSpies.splice(0)) sp.mockRestore();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // schema
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("the origin CHECK admits search AND still every earlier value (catalog-read widening, nothing deleted); the claim index is partial; both tables are RLS-walled", async () => {
    const def = (await q<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'automation_approvals'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%origin%' AND pg_get_constraintdef(oid) ILIKE '%automation%'`));
    expect(def).toHaveLength(1);
    for (const v of ["automation", "agent", "hr", "iam", "github", "credential_reveal", "webdesk", "search"]) expect(def[0].d, v).toContain(`'${v}'`);
    // Behavioural, not textual: every origin that existed before still PASSES the CHECK, `search` passes, and a value that is not an origin
    // (or NULL, which the column's NOT NULL refuses) does not. Rolled back, so nothing is left behind.
    const client = await adminPool().connect();
    try {
      await client.query("BEGIN");
      for (const origin of ["automation", "agent", "hr", "iam", "github", "credential_reveal", "webdesk", "search"]) {
        await client.query("SAVEPOINT o");
        await client.query(
          `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, origin, origin_site) VALUES ($1,$2,'w','t',$3,'test')`,
          [newId(), A, origin],
        );
        await client.query("ROLLBACK TO SAVEPOINT o");
      }
      await client.query("SAVEPOINT bad");
      await expect(client.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, origin, origin_site) VALUES ($1,$2,'w','t','not_an_origin','test')`,
        [newId(), A],
      )).rejects.toThrow(/origin_check|check constraint/i);
      await client.query("ROLLBACK TO SAVEPOINT bad");
      await client.query("SAVEPOINT nul");
      await expect(client.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, origin, origin_site) VALUES ($1,$2,'w','t',NULL,'test')`,
        [newId(), A],
      )).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT nul");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const idx = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_search_conv_claim'`);
    expect(idx[0].indexdef).toMatch(/UNIQUE/);
    expect(idx[0].indexdef).toMatch(/submission_ref/);
    expect(idx[0].indexdef).toMatch(/status <> 'skipped'/);
    const force = await q<{ relname: string; relforcerowsecurity: boolean }>(`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('search_conversion_targets','search_conversion_uploads')`);
    expect(force.map((r) => r.relforcerowsecurity)).toEqual([true, true]);
  });

  it("RLS: no search scope reads ZERO ledger rows, and another tenant never sees them", async () => {
    const { ledger } = await planFor("qualified");
    expect(ledger).toHaveLength(1);
    const noScope = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_conversion_uploads`));
    expect(noScope.rowCount).toBe(0);
    const scoped = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_conversion_uploads`), S);
    expect(scoped.rowCount).toBeGreaterThan(0);
    const other = await withTenants([B], (c) => c.query(`SELECT 1 FROM search_conversion_uploads`), S);
    expect(other.rowCount).toBe(0);
    const otherTargets = await withTenants([B], (c) => c.query(`SELECT 1 FROM search_conversion_targets`), S);
    expect(otherTargets.rowCount).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // the gate, at planning
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a won lead with consent and a gclid -> exactly ONE claim and ONE WS4 approval (origin search, impact high, content-bound), the value riding because the target sends it", async () => {
    const lead = await newWebLead();
    const conv = await convertAgencyLead({ tenantId: A, leadId: lead.id, actorUserId: uA, delegations: [], deal: { value: "2500.50", currency: "USD" } });
    expect(conv.outcome).toBe("converted");
    const ev = await stageEvent(lead.id, "won");
    const logs = spyConsole();
    await handleStageChanged(ev);

    const ledger = await ledgerFor(lead.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "pending_approval", stage: "won", conversion_key: "lead_won", deal_value: "2500.5000", deal_currency: "USD", reason: null });
    const approvals = await approvalsFor(lead.id);
    expect(approvals).toHaveLength(1);
    const a = approvals[0];
    expect(a).toMatchObject({
      origin: "search", workflow_id: "search.conversions.upload", tool_name: "search.conversions.upload", impact: "high", status: "pending",
      execution_status: "not_applicable", requested_by: uA,
    });
    expect(a.id).toBe(ledger[0].approval_id);
    // The args are exactly the filed shape, with the binding hash of the ledger row.
    expect(Object.keys(a.tool_args).sort()).toEqual(["contentHash", "conversionKey", "dealCurrency", "dealValue", "leadId", "ledgerId", "platform", "propertyId", "stage", "stageEventId"]);
    const binding: ConversionBinding = {
      ledgerId: ledger[0].id, tenantId: A, propertyId: propA, leadId: lead.id, stageEventId: ev.payload.stageEventId as string,
      submissionRef: lead.submissionRef, platform: "google_ads", stage: "won", conversionKey: "lead_won", dealValue: "2500.5000", dealCurrency: "USD",
    };
    expect(a.tool_args.contentHash).toBe(conversionContentHash(binding));
    expect(ledger[0].content_hash).toBe(a.tool_args.contentHash);

    assertNoPersonalData(await evidenceText(), lead);
    assertNoPersonalData(JSON.stringify(logs.flatMap((s) => s.mock.calls)), lead);
  });

  it("a redelivery of the SAME event (and a burst of concurrent deliveries) converges: still one ledger row and one approval", async () => {
    const { lead, ev } = await planFor("qualified");
    await handleStageChanged(ev);
    await Promise.all([1, 2, 3, 4, 5].map(() => handleStageChanged(ev)));
    expect(await ledgerFor(lead.id)).toHaveLength(1);
    expect(await approvalsFor(lead.id)).toHaveLength(1);
  });

  it("a lead that regresses and advances again never uploads twice: the second stage event is recorded `skipped: already_claimed`, with no second approval", async () => {
    const { lead } = await planFor("qualified");
    await moveLeadStage(A, lead.id, { stage: "contacted" }, uA);
    await moveLeadStage(A, lead.id, { stage: "qualified" }, uA);
    await handleStageChanged(await stageEvent(lead.id, "qualified"));
    const ledger = await ledgerFor(lead.id);
    expect(ledger.map((l) => [l.status, l.reason])).toEqual([["pending_approval", null], ["skipped", "already_claimed"]]);
    expect(await approvalsFor(lead.id)).toHaveLength(1);
  });

  it("consent absent, false, \"true\", a bare analytics flag or malformed -> NO upload and NO approval; the ledger says why", async () => {
    const cases: Array<[unknown, string]> = [
      [undefined, "consent_unknown"],
      [null, "consent_unknown"],
      [{ analytics: true, version: "3" }, "consent_unknown"],
      [{ marketing: "true" }, "consent_unknown"],
      [{ marketing: 1 }, "consent_unknown"],
      ["marketing", "consent_unknown"],
      [[true], "consent_unknown"],
      [{ marketing: false, analytics: true }, "consent_not_given"],
    ];
    for (const [consent, reason] of cases) {
      const { lead, ledger, approvals } = await planFor("qualified", await newWebLead({ consent }));
      expect(ledger, JSON.stringify(consent)).toHaveLength(1);
      expect(ledger[0], JSON.stringify(consent)).toMatchObject({ status: "skipped", reason, approval_id: null });
      expect(approvals, JSON.stringify(consent)).toHaveLength(0);
      expect(lead.id).toBeTruthy();
    }
  });

  it("a contact on G5's ad_upload suppression list -> skipped: suppressed (a marketing withdrawal blocks the upload and erases nothing)", async () => {
    const lead = await newWebLead();
    await withTenants([A], (c) => addContactSuppressions(c, A, contactHashes({ email: lead.email }), { scope: "ad_upload", reason: "marketing_withdrawal", dsrRequestId: null, createdBy: null }));
    const { ledger, approvals } = await planFor("qualified", lead);
    expect(ledger[0]).toMatchObject({ status: "skipped", reason: "suppressed" });
    expect(approvals).toHaveLength(0);
    const kept = await q(`SELECT contact_email FROM agency_leads WHERE id = $1`, [lead.id]);
    expect(kept[0]).toMatchObject({ contact_email: lead.email }); // not erased
  });

  it("no usable identifier (no click id, no email, no E.164 phone) -> skipped: no_identifier; an email alone IS enough (enhanced conversions for leads)", async () => {
    const none = await planFor("qualified", await newWebLead({ attribution: { landing: "/x/" }, email: null, phone: "0812 3456 7890" }));
    expect(none.ledger[0]).toMatchObject({ status: "skipped", reason: "no_identifier" });
    expect(none.approvals).toHaveLength(0);
    const emailOnly = await planFor("qualified", await newWebLead({ attribution: null, phone: null }));
    expect(emailOnly.ledger[0]).toMatchObject({ status: "pending_approval" });
    expect(emailOnly.approvals).toHaveLength(1);
  });

  it("no target (other site slug, wrong stage, or a disabled target) means skip with NO ledger row; a staff lead (no submissionRef) is skipped at once", async () => {
    const otherSite = await planFor("qualified", await newWebLead({ slug: "site-zzz" }));
    expect(otherSite.ledger).toHaveLength(0);
    const wrongStage = await planFor("contacted"); // no target on `contacted`
    expect(wrongStage.ledger).toHaveLength(0);
    await q(`UPDATE search_conversion_targets SET enabled = false WHERE tenant_id = $1 AND stage_key = 'qualified'`, [A]);
    try {
      const disabled = await planFor("qualified");
      expect(disabled.ledger).toHaveLength(0);
    } finally {
      await q(`UPDATE search_conversion_targets SET enabled = true WHERE tenant_id = $1 AND stage_key = 'qualified'`, [A]);
    }
    // A staff lead: submissionRef null in the event payload, so the handler never even reads the lead.
    const staff = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO agency_leads (id, tenant_id, org_name, contact_email, source, status, stage, origin_site) VALUES ($1,$2,'Staff Org','s@pii-check.test','staff','in_review','enquiry','test')`, [staff, A]));
    await moveLeadStage(A, staff, { stage: "qualified" }, uA);
    await handleStageChanged(await stageEvent(staff, "qualified"));
    expect(await ledgerFor(staff)).toHaveLength(0);
  });

  it("a malformed event payload is ignored without throwing (a throw would be redelivered five times)", async () => {
    const ev = await stageEvent((await planFor("qualified")).lead.id, "qualified");
    await expect(handleStageChanged({ ...ev, payload: { v: 1, leadId: "x" } })).resolves.toBeUndefined();
    await expect(handleStageChanged({ ...ev, payload: { ...ev.payload, extra: "dropped", toStage: "Won!" } })).resolves.toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // decide() — in-band execution, in simulate mode
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("decide(approved) executes IN-BAND in simulate mode as the decider, records what WOULD be sent (kinds only), and nothing is stored that identifies the lead", async () => {
    const { lead, approvals, ledger } = await planFor("qualified");
    const logs = spyConsole();
    const res = await decide(approvals[0].id, "approved");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: approvals[0].id, status: "approved",
      conversionUpload: { ledgerId: ledger[0].id, platform: "google_ads", mode: "simulate", status: "simulated", identifierKinds: ["gclid", "email", "phone"] },
    });
    // decide() asked Cerbos for the generic decide AND `update` on THIS property.
    expect(calls).toContainEqual(expect.objectContaining({ kind: "automation_approval", action: "decide" }));
    expect(calls).toContainEqual(expect.objectContaining({ kind: "resource_search_property", action: "update", id: propA, tenantId: A }));

    const [row] = await approvalsFor(lead.id);
    expect(row).toMatchObject({ status: "approved", execution_status: "executed", executed_by: uA, decided_by: uA, execution_error: null });
    expect(JSON.stringify(row.execution_result)).toContain("simulated");
    const [led] = await ledgerFor(lead.id);
    expect(led).toMatchObject({ status: "simulated", mode: "simulate", reason: null });
    expect(led.outcome).toMatchObject({
      platform: "google_ads", conversionKey: "lead_qualified", identifierKinds: ["gclid", "email", "phone"], valueSent: false,
      consent: { adUserData: "GRANTED" }, partialFailure: true,
    });
    assertNoPersonalData(await evidenceText(), lead);
    assertNoPersonalData(JSON.stringify(logs.flatMap((s) => s.mock.calls)), lead);
  });

  it("a second decide is refused and never sends a second time; the executor cannot be re-entered either", async () => {
    const { approvals, lead } = await planFor("qualified");
    expect((await decide(approvals[0].id, "approved")).statusCode).toBe(200);
    expect((await decide(approvals[0].id, "approved")).statusCode).toBe(404);
    expect((await decide(approvals[0].id, "rejected")).statusCode).toBe(404);
    const [led] = await ledgerFor(lead.id);
    expect(led.status).toBe("simulated");
    // The D14 retry cannot re-drive an executed row (409 on its state)...
    const retry = await app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${approvals[0].id}/retry`, headers: asUser(uA) });
    expect(retry.statusCode).toBe(409);
    expect((await ledgerFor(lead.id))[0].status).toBe("simulated");
  });

  it("the gate runs AGAIN at execution: consent withdrawn, a suppression added, or the lead deleted between filing and approving -> nothing sent, ledger skipped, claim released", async () => {
    const consentLead = await planFor("qualified");
    await q(`UPDATE agency_leads SET visitor_consent = $2::jsonb WHERE id = $1`, [consentLead.lead.id, JSON.stringify({ marketing: false })]);
    const r1 = await decide(consentLead.approvals[0].id, "approved");
    expect(r1.json().conversionUpload).toMatchObject({ status: "skipped", reason: "consent_not_given" });
    expect((await ledgerFor(consentLead.lead.id))[0]).toMatchObject({ status: "skipped", reason: "consent_not_given", mode: null });
    expect((await approvalsFor(consentLead.lead.id))[0]).toMatchObject({ status: "approved", execution_status: "failed", execution_error: "conversion_gate: consent_not_given" });

    const supLead = await planFor("qualified");
    await withTenants([A], (c) => addContactSuppressions(c, A, contactHashes({ phone: supLead.lead.phone }), { scope: "ad_upload", reason: "marketing_withdrawal", dsrRequestId: null, createdBy: null }));
    expect((await decide(supLead.approvals[0].id, "approved")).json().conversionUpload).toMatchObject({ status: "skipped", reason: "suppressed" });

    const delLead = await planFor("qualified");
    await q(`UPDATE agency_leads SET deleted_at = now() WHERE id = $1`, [delLead.lead.id]);
    expect((await decide(delLead.approvals[0].id, "approved")).json().conversionUpload).toMatchObject({ status: "skipped", reason: "lead_deleted" });

    // The claim was RELEASED: the same conversion for the same submission can be planned again by a later stage change.
    await moveLeadStage(A, consentLead.lead.id, { stage: "contacted" }, uA);
    await q(`UPDATE agency_leads SET visitor_consent = $2::jsonb WHERE id = $1`, [consentLead.lead.id, JSON.stringify({ marketing: true })]);
    await moveLeadStage(A, consentLead.lead.id, { stage: "qualified" }, uA);
    await handleStageChanged(await stageEvent(consentLead.lead.id, "qualified"));
    expect((await ledgerFor(consentLead.lead.id)).map((l) => l.status)).toEqual(["skipped", "pending_approval"]);
  });

  it("a REJECTED approval closes the ledger row `rejected`, sends nothing, and the claim STAYS: nobody is asked twice", async () => {
    const { lead, approvals } = await planFor("qualified");
    const res = await decide(approvals[0].id, "rejected");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: approvals[0].id, status: "rejected" });
    expect((await ledgerFor(lead.id))[0]).toMatchObject({ status: "rejected", reason: "approval_rejected", mode: null });
    expect((await approvalsFor(lead.id))[0]).toMatchObject({ status: "rejected", execution_status: "not_applicable" });
    await moveLeadStage(A, lead.id, { stage: "contacted" }, uA);
    await moveLeadStage(A, lead.id, { stage: "qualified" }, uA);
    await handleStageChanged(await stageEvent(lead.id, "qualified"));
    expect((await ledgerFor(lead.id)).map((l) => [l.status, l.reason])).toEqual([["rejected", "approval_rejected"], ["skipped", "already_claimed"]]);
    expect(await approvalsFor(lead.id)).toHaveLength(1);
  });

  it("the approval is CONTENT-BOUND: a value changed on the ledger row, or a contact field slipped into the stored args, is refused unsent", async () => {
    const tampered = await planFor("qualified");
    await q(`UPDATE search_conversion_uploads SET deal_value = 1, deal_currency = 'USD' WHERE id = $1`, [tampered.ledger[0].id]);
    const r = await decide(tampered.approvals[0].id, "approved");
    expect(r.json().conversionUpload).toMatchObject({ status: "failed", reason: "content_changed" });
    expect((await ledgerFor(tampered.lead.id))[0]).toMatchObject({ status: "failed", reason: "content_changed" });

    const extra = await planFor("qualified");
    await q(`UPDATE automation_approvals SET tool_args = tool_args || '{"email":"x@y.test"}'::jsonb WHERE id = $1`, [extra.approvals[0].id]);
    // decide() refuses an upload row whose stored args are not ours BEFORE it decides anything.
    const r2 = await decide(extra.approvals[0].id, "approved");
    expect(r2.statusCode).toBe(400);
    expect((await approvalsFor(extra.lead.id))[0]).toMatchObject({ status: "pending" });
    expect((await ledgerFor(extra.lead.id))[0].status).toBe("pending_approval");
  });

  it("DENIAL: decide() under a Cerbos deny is 403 with a VALID body, leaves the approval `pending` and the ledger `pending_approval`, and sends nothing", async () => {
    const { lead, approvals } = await planFor("qualified");
    denyAll = true;
    const res = await decide(approvals[0].id, "approved");
    expect(res.statusCode).toBe(403);
    denyAll = false;
    expect((await approvalsFor(lead.id))[0]).toMatchObject({ status: "pending", execution_status: "not_applicable" });
    expect((await ledgerFor(lead.id))[0]).toMatchObject({ status: "pending_approval", mode: null });
    // Rejecting is also a decision about the property: the same wall applies.
    denyAll = true;
    expect((await decide(approvals[0].id, "rejected")).statusCode).toBe(403);
    denyAll = false;
    expect((await ledgerFor(lead.id))[0].status).toBe("pending_approval");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // live mode (a fake uploader: nothing here touches Google)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("LIVE (platform listed, uploader registered): exactly ONE send carrying the hashed identifiers; the ledger stores only the summary", async () => {
    process.env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV] = "google_ads";
    const sent: UploadInput[] = [];
    registerLiveConversionUploader("google_ads", async (input) => { sent.push(input); return { ok: true } as UploadResult; });
    const { lead, approvals } = await planFor("qualified");
    const res = await decide(approvals[0].id, "approved");
    expect(res.json().conversionUpload).toMatchObject({ status: "uploaded", mode: "live" });
    expect(sent).toHaveLength(1);
    const conv = (sent[0].body.conversions as Array<Record<string, unknown>>)[0];
    expect(conv).toMatchObject({ gclid: lead.gclid, consent: { adUserData: "GRANTED" }, orderId: `${lead.submissionRef}:lead_qualified` });
    expect(JSON.stringify(conv.userIdentifiers)).toContain(sha256Hex(normalizeEmailForGoogle(lead.email) as string));
    expect(sent[0]).toMatchObject({ tenantId: A, propertyId: propA, conversionAction: "customers/111/conversionActions/222" });
    expect((await ledgerFor(lead.id))[0]).toMatchObject({ status: "uploaded", mode: "live" });
    assertNoPersonalData(await evidenceText(), lead);
  });

  it("LIVE, ambiguous answer: the row is `failed`, the uploader was called ONCE and never again; a refusal is typed; an uploader that throws is ambiguous", async () => {
    process.env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV] = "google_ads";
    let calls1 = 0;
    registerLiveConversionUploader("google_ads", async () => { calls1 += 1; return { ok: false, error: "conversion_ambiguous", ambiguous: true }; });
    const a = await planFor("qualified");
    expect((await decide(a.approvals[0].id, "approved")).json().conversionUpload).toMatchObject({ status: "failed", reason: "conversion_ambiguous" });
    expect(calls1).toBe(1);
    expect((await approvalsFor(a.lead.id))[0]).toMatchObject({ execution_status: "failed", execution_error: "conversion_ambiguous" });
    expect((await decide(a.approvals[0].id, "approved")).statusCode).toBe(404);
    expect(calls1).toBe(1);
    // ...and a human pressing D14's Retry on the FAILED row re-sends nothing: that executor refuses any origin outside automation|agent.
    const retry = await app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${a.approvals[0].id}/retry`, headers: asUser(uA) });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(calls1).toBe(1);
    expect((await ledgerFor(a.lead.id))[0].status).toBe("failed");

    registerLiveConversionUploader("google_ads", async () => ({ ok: false, error: "google_refused:400", ambiguous: false }));
    const b = await planFor("qualified");
    expect((await decide(b.approvals[0].id, "approved")).json().conversionUpload).toMatchObject({ status: "failed", reason: "google_refused:400" });

    registerLiveConversionUploader("google_ads", async () => { throw new Error("boom"); });
    const c = await planFor("qualified");
    expect((await decide(c.approvals[0].id, "approved")).json().conversionUpload).toMatchObject({ status: "failed", reason: "conversion_ambiguous" });
    // `failed` still holds the claim: it is not retried by a later stage change.
    expect((await ledgerFor(c.lead.id))[0].status).toBe("failed");
  });

  it("the won path with a value: simulate records valueSent true and the deal currency, and the value is the one approved", async () => {
    const lead = await newWebLead();
    await convertAgencyLead({ tenantId: A, leadId: lead.id, actorUserId: uA, delegations: [], deal: { value: "10.25", currency: "USD" } });
    await handleStageChanged(await stageEvent(lead.id, "won"));
    const [approval] = await approvalsFor(lead.id);
    expect((await decide(approval.id, "approved")).json().conversionUpload).toMatchObject({ status: "simulated", mode: "simulate" });
    expect((await ledgerFor(lead.id))[0].outcome).toMatchObject({ valueSent: true, currency: "USD", conversionKey: "lead_won" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // the config + ledger routes
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("POST conversion-targets is an idempotent upsert; the same slug/platform/stage cannot be re-pointed at another property; an unknown stage is typed", async () => {
    const url = `/api/${A}/modules/search/properties/${propA}/conversion-targets`;
    const body = { webSiteSlug: "site-route", platform: "google_ads", stage: "proposal", conversionKey: "lead_proposal", conversionAction: "333" };
    const first = await app.inject({ method: "POST", url, headers: asUser(uA), payload: body });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ created: true, target: { stage: "proposal", sendValue: false, enabled: true, mode: "simulate" } });
    const again = await app.inject({ method: "POST", url, headers: asUser(uA), payload: { ...body, sendValue: true } });
    expect(again.json()).toMatchObject({ created: false, target: { sendValue: true } });
    expect(calls).toContainEqual(expect.objectContaining({ kind: "resource_search_property", action: "update", id: propA }));

    const list = await app.inject({ method: "GET", url, headers: asUser(uA) });
    expect(list.statusCode).toBe(200);
    expect((list.json().targets as Array<{ stage: string }>).map((t) => t.stage)).toEqual(expect.arrayContaining(["proposal", "qualified", "won"]));

    const unknownStage = await app.inject({ method: "POST", url, headers: asUser(uA), payload: { ...body, stage: "nonesuch" } });
    expect(unknownStage.statusCode).toBe(400);
    expect(unknownStage.json()).toMatchObject({ reason: "stage_unknown" });
    // M5-P3/P4 gave meta_capi and linkedin_capi adapters; a platform with no adapter is still refused before the CHECK.
    const unsupported = await app.inject({ method: "POST", url, headers: asUser(uA), payload: { ...body, platform: "tiktok" } });
    expect(unsupported.json()).toMatchObject({ reason: "platform_unsupported" });

    // Another tenant's property id is invisible (404), and no row is written for it.
    const cross = await app.inject({ method: "POST", url: `/api/${A}/modules/search/properties/${propB}/conversion-targets`, headers: asUser(uA), payload: body });
    expect(cross.statusCode).toBe(404);
    expect((await q(`SELECT 1 FROM search_conversion_targets WHERE property_id = $1`, [propB]))).toHaveLength(0);
  });

  it("DENIAL: the config write and the reads are 403 under a Cerbos deny, each with a VALID request", async () => {
    denyAll = true;
    const url = `/api/${A}/modules/search/properties/${propA}/conversion-targets`;
    const write = await app.inject({
      method: "POST", url, headers: asUser(uA),
      payload: { webSiteSlug: SLUG, platform: "google_ads", stage: "won", conversionKey: "lead_won", conversionAction: "customers/111/conversionActions/222" },
    });
    expect(write.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: asUser(uA) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propA}/conversion-uploads`, headers: asUser(uA) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/${A}/modules/search/leads/${newId()}/conversion-uploads`, headers: asUser(uA) })).statusCode).toBe(403);
    // (A principal outside the tenant is refused by the REAL Cerbos + RLS wall, which this recording double replaces; the cross-tenant
    // evidence here is the 404 for another company's property id on the config write, and the RLS reads in the first tests.)
    denyAll = false;
  });

  it("the ledger routes list newest first and carry ids, statuses, reasons and identifier KINDS only; the lead route feeds the pipeline card", async () => {
    const { lead, approvals } = await planFor("qualified");
    await decide(approvals[0].id, "approved");
    const byProperty = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propA}/conversion-uploads?leadId=${lead.id}`, headers: asUser(uA) });
    expect(byProperty.statusCode, byProperty.body).toBe(200);
    expect(byProperty.json().uploads).toHaveLength(1);
    expect(byProperty.json().uploads[0]).toMatchObject({ leadId: lead.id, status: "simulated", mode: "simulate", platform: "google_ads", stage: "qualified" });
    assertNoPersonalData(byProperty.body, lead);
    const byLead = await app.inject({ method: "GET", url: `/api/${A}/modules/search/leads/${lead.id}/conversion-uploads`, headers: asUser(uA) });
    expect(byLead.json()).toMatchObject({ leadId: lead.id });
    expect(byLead.json().uploads).toHaveLength(1);
    expect(calls).toContainEqual(expect.objectContaining({ kind: "resource_search_property", action: "read" }));
    expect((await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propA}/conversion-uploads?status=bogus`, headers: asUser(uA) })).statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // the consumer loop, for real. LAST in the file: draining the stream hands the handler every event the tests above emitted.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it.skipIf(!REDIS_TEST_URL)("emit -> relay -> consumeOnce('agency_lead') delivers agency.lead.stage_changed to the handler with NO direct call", async () => {
    const lead = await newWebLead();
    const moved = await moveLeadStage(A, lead.id, { stage: "qualified" }, uA);
    expect(moved.outcome).toBe("ok");
    expect(await ledgerFor(lead.id)).toHaveLength(0); // nothing has called the handler
    for (let i = 0; i < 10; i++) {
      const relayed = await relayBatch(500);
      const consumed = await consumeOnce("agency_lead");
      if (relayed === 0 && consumed === 0) break;
    }
    const ledger = await ledgerFor(lead.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "pending_approval", conversion_key: "lead_qualified" });
    expect(await approvalsFor(lead.id)).toHaveLength(1);
  });
});
