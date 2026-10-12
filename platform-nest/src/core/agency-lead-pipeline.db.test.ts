// M5-P1-b — the lead-pipeline service layer, driven against REAL Postgres (+ Cerbos for the HTTP legs).
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §2, §3, §5, §7 and the P1-b "accepted when"
// row in §9. Every write here runs as `platform_app_test` (NOSUPERUSER NOBYPASSRLS) through the real
// service functions or the real HTTP surface; `adminPool()` (superuser) is used only to READ evidence,
// to hold a lock for the race, and to set up the legacy state a pre-P1 decline left behind.
//
// The P1-c routes (`POST …/stage`, `…/deal`) do not exist yet, so moves and value edits call the service
// functions those routes will wrap. Convert, decline and the prospect submit go through HTTP where the
// route already exists.
//
// Needs DATABASE_URL_TEST (+ CERBOS_URL): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { HttpException } from "@nestjs/common";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { mintInviteToken } from "./agency-intake-tokens.service";
import { convertAgencyLead } from "./agency-lead-convert.service";
import { createStaffLead, declineLead } from "./agency-leads.service";
import {
  moveLeadStage, readLeadConversionFacts, setLeadDeal, STAGE_CHANGED, STAGE_CHANGED_V1_KEYS, parseStageChangedV1,
} from "./agency-lead-pipeline.service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Status = "new" | "invited" | "submitted" | "in_review" | "nurturing" | "declined";

/** The typed refusal an HttpException carries: status + `reason`. */
async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), reason: (e.getResponse() as { reason?: unknown }).reason };
    throw e;
  }
  throw new Error("expected a typed refusal, but the call succeeded");
}

describe.skipIf(!TEST_URL)("M5-P1-b — transitionStage threaded through move, convert, decline and intake", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Pipeline Agency");
    admin = await createUser("admin@lead-pipeline.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  /** A lead inserted as the app role. Contact fields are distinctive so a payload grep can look for them. */
  async function newLead(status: Status = "in_review", extra: { submissionRef?: string } = {}) {
    const n = ++seq;
    const lead = {
      id: newId(),
      orgName: `Pipeline Org ${String.fromCharCode(97 + (n % 26))}${n}`,
      contactName: `Prospect Person ${String.fromCharCode(97 + (n % 26))}`,
      email: `prospect${n}@pipeline-lead.test`,
      phone: `+62-811-777-${String(1000 + n)}`,
    };
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage,
                                   owner_id, origin_site, declined_reason, submission_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'test', $11, $12)`,
        [
          lead.id, co, lead.orgName, lead.contactName, lead.email, lead.phone, extra.submissionRef ? "web" : "staff", status,
          status === "declined" ? "lost" : "enquiry", admin, status === "declined" ? "legacy decline" : null, extra.submissionRef ?? null,
        ],
      ),
    );
    return lead;
  }

  const leadRow = async (id: string) =>
    (
      await adminPool().query<{ status: string; stage: string; deal_value: string | null; deal_currency: string | null; declined_reason: string | null }>(
        `SELECT status, stage, deal_value::text AS deal_value, deal_currency, declined_reason FROM agency_leads WHERE id = $1`, [id],
      )
    ).rows[0];
  const history = async (leadId: string) =>
    (
      await adminPool().query<{ id: string; from_stage: string; to_stage: string; deal_value: string | null; deal_currency: string | null; actor_id: string | null; occurred_at: Date }>(
        `SELECT id, from_stage, to_stage, deal_value::text AS deal_value, deal_currency, actor_id, occurred_at
           FROM agency_lead_stage_events WHERE lead_id = $1 ORDER BY occurred_at ASC, id ASC`, [leadId],
      )
    ).rows;
  const events = async (leadId: string, type: string) =>
    (
      await adminPool().query<{ payload: Record<string, unknown>; payload_text: string }>(
        `SELECT payload, payload::text AS payload_text FROM outbox_events
          WHERE entity_type = 'agency_lead' AND entity_id = $1 AND event_type = $2 ORDER BY created_at ASC`,
        [leadId, type],
      )
    ).rows;

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // moveStage
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a move writes exactly ONE history row and ONE stage_changed event whose keys EQUAL the v1 set, with no personal data", async () => {
    const ref = newId();
    const lead = await newLead("new", { submissionRef: ref });
    const r = await moveLeadStage(co, lead.id, { stage: "contacted" }, admin);
    expect(r).toMatchObject({ outcome: "ok", stage: "contacted", changed: true });

    const h = await history(lead.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ from_stage: "enquiry", to_stage: "contacted", actor_id: admin, deal_value: null });
    const ev = await events(lead.id, STAGE_CHANGED);
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0].payload).sort()).toEqual([...STAGE_CHANGED_V1_KEYS].sort());
    expect(ev[0].payload).toMatchObject({
      v: 1, leadId: lead.id, stageEventId: h[0].id, submissionRef: ref, fromStage: "enquiry", toStage: "contacted",
      dealValue: null, dealCurrency: null,
    });
    expect(parseStageChangedV1(ev[0].payload)).not.toBeNull();
    for (const pii of [lead.email, lead.phone, lead.contactName, lead.orgName]) expect(ev[0].payload_text).not.toContain(pii);
    expect((await leadRow(lead.id)).stage).toBe("contacted");
  });

  it("a staff lead's event carries submissionRef null (P2 skips it without a read)", async () => {
    const lead = await newLead("submitted");
    await moveLeadStage(co, lead.id, { stage: "qualified" }, admin);
    expect((await events(lead.id, STAGE_CHANGED))[0].payload.submissionRef).toBeNull();
  });

  it("moving to the stage it is already at returns changed:false and writes NOTHING (safe agent retries)", async () => {
    const lead = await newLead("in_review");
    await moveLeadStage(co, lead.id, { stage: "qualified" }, admin);
    const again = await moveLeadStage(co, lead.id, { stage: "qualified" }, admin);
    expect(again).toMatchObject({ outcome: "ok", stage: "qualified", changed: false });
    expect(again).not.toHaveProperty("stageEventId");
    expect(await history(lead.id)).toHaveLength(1);
    expect(await events(lead.id, STAGE_CHANGED)).toHaveLength(1);
  });

  it("deals regress: a backwards move is allowed and recorded", async () => {
    const lead = await newLead("in_review");
    await moveLeadStage(co, lead.id, { stage: "proposal" }, admin);
    await moveLeadStage(co, lead.id, { stage: "contacted" }, admin);
    expect((await history(lead.id)).map((h) => `${h.from_stage}>${h.to_stage}`)).toEqual(["enquiry>proposal", "proposal>contacted"]);
  });

  it("won and lost can NOT be reached through a move (400 stage_terminal); an unknown stage is 400 stage_unknown", async () => {
    const lead = await newLead("in_review");
    expect(await refusal(moveLeadStage(co, lead.id, { stage: "won" }, admin))).toEqual({ status: 400, reason: "stage_terminal" });
    expect(await refusal(moveLeadStage(co, lead.id, { stage: "lost" }, admin))).toEqual({ status: 400, reason: "stage_terminal" });
    expect(await refusal(moveLeadStage(co, lead.id, { stage: "negotiation" }, admin))).toEqual({ status: 400, reason: "stage_unknown" });
    expect(await refusal(moveLeadStage(co, lead.id, { stage: "DROP TABLE" }, admin))).toEqual({ status: 400, reason: "stage_unknown" });
    expect(await refusal(moveLeadStage(co, lead.id, {}, admin))).toEqual({ status: 400, reason: "stage_unknown" });
    expect(await leadRow(lead.id)).toMatchObject({ status: "in_review", stage: "enquiry" });
    expect(await history(lead.id)).toHaveLength(0);
  });

  it("a move on a closed lead (declined or converted) is 409 lead_closed and writes nothing", async () => {
    const declined = await newLead("declined");
    expect(await refusal(moveLeadStage(co, declined.id, { stage: "contacted" }, admin))).toEqual({ status: 409, reason: "lead_closed" });

    const converted = await newLead("submitted");
    const conv = await convertAgencyLead({ tenantId: co, leadId: converted.id, actorUserId: admin, delegations: [] });
    expect(conv.outcome).toBe("converted");
    expect(await refusal(moveLeadStage(co, converted.id, { stage: "proposal" }, admin))).toEqual({ status: 409, reason: "lead_closed" });
    expect((await history(converted.id)).map((h) => h.to_stage)).toEqual(["won"]);
  });

  it("an unknown lead id is not_found, not an error", async () => {
    expect(await moveLeadStage(co, newId(), { stage: "contacted" }, admin)).toEqual({ outcome: "not_found" });
    expect(await setLeadDeal(co, newId(), { value: "1", currency: "USD" })).toEqual({ outcome: "not_found" });
  });

  it("a deal riding on a move is written in the same UPDATE and recorded on the history row and the event", async () => {
    const lead = await newLead("in_review");
    const r = await moveLeadStage(co, lead.id, { stage: "proposal", deal: { value: "15000000", currency: "IDR" } }, admin);
    expect(r).toMatchObject({ changed: true, dealValue: "15000000.0000", dealCurrency: "IDR" });
    expect((await history(lead.id))[0]).toMatchObject({ deal_value: "15000000.0000", deal_currency: "IDR" });
    expect((await events(lead.id, STAGE_CHANGED))[0].payload).toMatchObject({ dealValue: "15000000.0000", dealCurrency: "IDR" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // deal value (design §3)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("precision: IDR 1500.5 is refused, USD 10.25 is accepted, USD 10.255 is refused; XXX is unknown", async () => {
    const lead = await newLead("in_review");
    expect(await refusal(setLeadDeal(co, lead.id, { value: "1500.5", currency: "IDR" }))).toEqual({ status: 400, reason: "deal_value_precision" });
    expect(await refusal(setLeadDeal(co, lead.id, { value: "10.255", currency: "USD" }))).toEqual({ status: 400, reason: "deal_value_precision" });
    expect(await refusal(setLeadDeal(co, lead.id, { value: "10", currency: "XXX" }))).toEqual({ status: 400, reason: "deal_currency_unknown" });
    expect(await refusal(setLeadDeal(co, lead.id, { value: "10" }))).toEqual({ status: 400, reason: "deal_incomplete" });
    expect((await leadRow(lead.id)).deal_value).toBeNull();

    expect(await setLeadDeal(co, lead.id, { value: "10.25", currency: "USD" })).toMatchObject({
      outcome: "ok", changed: true, dealValue: "10.2500", dealCurrency: "USD",
    });
    expect(await setLeadDeal(co, lead.id, { value: 10.25, currency: "usd" })).toMatchObject({ changed: false });
    expect(await setLeadDeal(co, lead.id, { value: "1500", currency: "IDR" })).toMatchObject({ changed: true, dealValue: "1500.0000" });
  });

  it("a value edit emits NO stage event and writes no history; it is allowed on a closed lead; {null,null} clears", async () => {
    const lead = await newLead("declined");
    expect(await setLeadDeal(co, lead.id, { value: "99.5", currency: "SGD" })).toMatchObject({ changed: true, dealValue: "99.5000" });
    expect(await setLeadDeal(co, lead.id, { value: null, currency: null })).toMatchObject({ changed: true, dealValue: null, dealCurrency: null });
    expect(await history(lead.id)).toHaveLength(0);
    expect(await events(lead.id, STAGE_CHANGED)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // convert → won
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("convert sets won and emits stage_changed in the SAME transaction as the rest of convert (with a deal)", async () => {
    const lead = await newLead("in_review");
    await moveLeadStage(co, lead.id, { stage: "proposal" }, admin);
    const r = await convertAgencyLead({
      tenantId: co, leadId: lead.id, actorUserId: admin, delegations: [], deal: { value: "2500.50", currency: "USD" },
    });
    if (r.outcome !== "converted") throw new Error(`expected converted, got ${r.outcome}`);
    expect(r).toMatchObject({ dealValue: "2500.5000", dealCurrency: "USD" });
    expect(await leadRow(lead.id)).toMatchObject({ status: "converted", stage: "won", deal_value: "2500.5000", deal_currency: "USD" });

    const h = await history(lead.id);
    expect(h.map((x) => `${x.from_stage}>${x.to_stage}`)).toEqual(["enquiry>proposal", "proposal>won"]);
    expect(h[1].id).toBe(r.stageEventId);
    const ev = await events(lead.id, STAGE_CHANGED);
    expect(ev).toHaveLength(2);
    expect(ev[1].payload).toMatchObject({ fromStage: "proposal", toStage: "won", stageEventId: r.stageEventId, dealValue: "2500.5000" });
    expect(Object.keys(ev[1].payload).sort()).toEqual([...STAGE_CHANGED_V1_KEYS].sort());
    expect(await events(lead.id, "agency.lead.converted")).toHaveLength(1);

    // SAME transaction: the event, the history row and the spawned run share one transaction id.
    const tx = await adminPool().query<{ n: number }>(
      `SELECT count(DISTINCT xmin::text)::int AS n FROM (
         SELECT xmin FROM outbox_events WHERE entity_id = $1 AND event_type IN ('agency.lead.stage_changed','agency.lead.converted') AND payload->>'toStage' IS DISTINCT FROM 'proposal'
         UNION ALL SELECT xmin FROM agency_lead_stage_events WHERE id = $2
         UNION ALL SELECT xmin FROM pipeline_runs WHERE id = $3) t`,
      [lead.id, r.stageEventId, r.runId],
    );
    expect(tx.rows[0].n).toBe(1);
  });

  it("a convert whose deal is invalid is refused BEFORE anything is spawned, and the lead is untouched", async () => {
    const lead = await newLead("submitted");
    expect(await refusal(convertAgencyLead({
      tenantId: co, leadId: lead.id, actorUserId: admin, delegations: [], deal: { value: "1500.5", currency: "IDR" },
    }))).toEqual({ status: 400, reason: "deal_value_precision" });
    expect(await leadRow(lead.id)).toMatchObject({ status: "submitted", stage: "enquiry" });
    const clients = await adminPool().query(`SELECT 1 FROM clients WHERE name = $1`, [lead.orgName]);
    expect(clients.rowCount).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // decline → lost (AD-5 amendment)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("decline works from EVERY open status, sets lost through the writer, and revokes the lead's UNUSED invite tokens only", async () => {
    for (const status of ["new", "invited", "submitted", "in_review", "nurturing"] as const) {
      const lead = await newLead(status);
      const unused = await mintInviteToken({ tenantId: co, leadId: lead.id, createdBy: admin });
      const used = await mintInviteToken({ tenantId: co, leadId: lead.id, createdBy: admin });
      await adminPool().query(`UPDATE agency_intake_tokens SET used_at = now() - interval '1 day' WHERE id = $1`, [used.id]);
      // mintInviteToken advances new -> invited; put the fixture back where the case says it is.
      await adminPool().query(`UPDATE agency_leads SET status = $2 WHERE id = $1`, [lead.id, status]);

      expect(await declineLead(co, lead.id, admin, "no budget this year")).toEqual({ outcome: "ok" });
      expect(await leadRow(lead.id)).toMatchObject({ status: "declined", stage: "lost", declined_reason: "no budget this year" });
      expect((await history(lead.id)).map((h) => `${h.from_stage}>${h.to_stage}`)).toEqual(["enquiry>lost"]);
      expect((await events(lead.id, STAGE_CHANGED))[0].payload).toMatchObject({ fromStage: "enquiry", toStage: "lost" });

      const toks = await adminPool().query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM agency_intake_tokens WHERE lead_id = $1`, [lead.id],
      );
      const byId = new Map(toks.rows.map((t) => [t.id, t.revoked_at]));
      expect(byId.get(unused.id), `unused token for a '${status}' lead`).not.toBeNull();
      expect(byId.get(used.id), `used token for a '${status}' lead`).toBeNull();
    }
  });

  it("decline over HTTP works from 'new' (a web lead lost before AD-1 is ever sent) and refuses a closed lead naming its status", async () => {
    const lead = await newLead("new");
    const ok = await app.inject({
      method: "POST", url: `/api/${co}/agency/leads/${lead.id}/decline`, headers: asUser(admin), payload: { reason: "not a fit" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: lead.id, status: "declined" });
    const again = await app.inject({
      method: "POST", url: `/api/${co}/agency/leads/${lead.id}/decline`, headers: asUser(admin), payload: { reason: "not a fit" },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toContain("status 'declined'");
    expect(await history(lead.id)).toHaveLength(1);
  });

  it("payload hygiene: agency.lead.declined carries no reason, the staff agency.lead.created carries no orgName", async () => {
    const lead = await newLead("in_review");
    await declineLead(co, lead.id, admin, "Prospect Person said budget is gone");
    const declined = await events(lead.id, "agency.lead.declined");
    expect(declined).toHaveLength(1);
    expect(declined[0].payload).toEqual({ actorId: admin });
    expect(declined[0].payload_text).not.toContain("budget");

    const { id } = await createStaffLead(co, admin, { orgName: "Secret Sole Trader", contactName: null, contactEmail: null, contactPhone: null });
    const created = await events(id, "agency.lead.created");
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({ source: "staff", actorId: admin });
    expect(created[0].payload_text).not.toContain("Secret Sole Trader");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // intake submit guard + late submission (design §2)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const submit = (token: string) =>
    app.inject({
      method: "POST", url: `/api/${co}/intake/submissions`, headers: { "x-intake-token": token },
      payload: { answers: { objective: "late but keen" } },
    });

  it("a token minted before a decline and then submitted: 200, the submission is stored, the lead stays declined/lost, the owner is notified", async () => {
    // The state a PRE-P1 decline left behind: AD-5's old decline (in_review only) revoked nothing, so a
    // re-minted link could still be live on a declined lead. P1's decline revokes, so this is the
    // legacy shape (and the shape a submit that won the lead lock just before a decline sees).
    const lead = await newLead("in_review");
    const tok = await mintInviteToken({ tenantId: co, leadId: lead.id, createdBy: admin });
    await adminPool().query(
      `UPDATE agency_leads SET status = 'declined', stage = 'lost', declined_reason = 'legacy decline', triaged_at = now() WHERE id = $1`,
      [lead.id],
    );

    const res = await submit(tok.plaintext);
    expect(res.statusCode).toBe(200);
    const submissionId = (res.json() as { submissionId: string }).submissionId;
    const stored = await adminPool().query(`SELECT 1 FROM agency_discovery_submissions WHERE id = $1 AND lead_id = $2`, [submissionId, lead.id]);
    expect(stored.rowCount).toBe(1);
    expect(await leadRow(lead.id)).toMatchObject({ status: "declined", stage: "lost" });
    expect(await history(lead.id)).toHaveLength(0); // no prospect action moves a stage

    const notes = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM notifications WHERE type = 'agency.lead.submitted_after_decline' AND payload->>'entityId' = $1`, [lead.id],
    );
    expect(notes.rows.map((n) => n.user_id)).toEqual([admin]);
    const ordinary = await adminPool().query(
      `SELECT 1 FROM notifications WHERE type = 'agency.lead.submitted' AND payload->>'entityId' = $1`, [lead.id],
    );
    expect(ordinary.rowCount).toBe(0);
  });

  it("P1's decline revokes the live link: the same submit after a NEW decline is refused token_revoked, nothing stored", async () => {
    const lead = await newLead("in_review");
    const tok = await mintInviteToken({ tenantId: co, leadId: lead.id, createdBy: admin });
    await declineLead(co, lead.id, admin, "not now");
    const res = await submit(tok.plaintext);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { reason?: string }).reason).toBe("token_revoked");
    const stored = await adminPool().query(`SELECT 1 FROM agency_discovery_submissions WHERE lead_id = $1`, [lead.id]);
    expect(stored.rowCount).toBe(0);
  });

  it("an ordinary submit still moves an open lead to 'submitted' and never touches its stage", async () => {
    const lead = await newLead("invited");
    await moveLeadStage(co, lead.id, { stage: "contacted" }, admin);
    const tok = await mintInviteToken({ tenantId: co, leadId: lead.id, createdBy: admin });
    expect((await submit(tok.plaintext)).statusCode).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({ status: "submitted", stage: "contacted" });
    expect(await history(lead.id)).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // §7 export for P2
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("readLeadConversionFacts returns the P2 shape on the caller's connection, null for another tenant's lead", async () => {
    const ref = newId();
    const lead = await newLead("in_review", { submissionRef: ref });
    await adminPool().query(
      `UPDATE agency_leads SET visitor_consent = '{"marketing":true}'::jsonb, attribution = '{"gclid":"abc"}'::jsonb,
              web_site_slug = 'gaiada', origin_form = 'contact' WHERE id = $1`, [lead.id],
    );
    const facts = await withTenants([co], (c) => readLeadConversionFacts(c, co, lead.id));
    expect(facts).toEqual({
      leadId: lead.id, source: "web", status: "in_review", stage: "enquiry", deletedAt: null, submissionRef: ref,
      originForm: "contact", webSiteSlug: "gaiada", attribution: { gclid: "abc" }, visitorConsent: { marketing: true },
      contactEmail: lead.email, contactPhone: lead.phone, dealValue: null, dealCurrency: null,
    });
    const other = await createCompany("Some Other Agency");
    expect(await withTenants([other], (c) => readLeadConversionFacts(c, other, lead.id))).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE RACE: 20 concurrent moves + 1 convert on one in_review lead
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("RACE: 20 concurrent moves plus one convert leave a CONTIGUOUS chain (each from = previous to) ending in won", async () => {
    const lead = await newLead("in_review");
    const ungranted = async () =>
      (
        await adminPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
      ).rows[0].n;

    // Hold the lead's ROW lock on a dedicated owner connection, so every racer parks on it and the
    // collision is real rather than a matter of timing.
    const holder = await adminPool().connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM agency_leads WHERE id = $1 FOR UPDATE`, [lead.id]);
    let flights: Promise<unknown>[] = [];
    try {
      const stages = ["contacted", "qualified", "proposal", "enquiry"];
      flights = [
        ...Array.from({ length: 20 }, (_, i) =>
          moveLeadStage(co, lead.id, { stage: stages[i % stages.length] }, admin).then(
            (r) => ({ kind: "move", r }),
            (e: unknown) => ({ kind: "move-refused", reason: e instanceof HttpException ? (e.getResponse() as { reason?: string }).reason : String(e) }),
          ),
        ),
        convertAgencyLead({ tenantId: co, leadId: lead.id, actorUserId: admin, delegations: [] }).then((r) => ({ kind: "convert", r })),
      ];
      // The app pool is smaller than 21 in the harness, so not every racer can be parked at once; the
      // rest queue for a connection and arrive while the parked ones drain. Several parked on the SAME
      // row lock at the moment it is released is the collision this test needs.
      const deadline = Date.now() + 15000;
      let seen = 0;
      while (Date.now() < deadline && (seen = await ungranted()) < 6) await new Promise((r) => setTimeout(r, 25));
      expect(seen, "the racers never queued on the row lock, so this proves nothing").toBeGreaterThanOrEqual(6);
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    const results = (await Promise.all(flights)) as Array<{ kind: string; reason?: string; r?: { outcome: string } }>;

    // Every move either landed, was a same-stage no-op, or came after the convert and was refused lead_closed.
    for (const x of results.filter((y) => y.kind === "move-refused")) expect(x.reason).toBe("lead_closed");
    expect(results.find((x) => x.kind === "convert")?.r?.outcome).toBe("converted");

    const h = await history(lead.id);
    expect(h.length).toBeGreaterThanOrEqual(1);
    expect(h[0].from_stage).toBe("enquiry");
    for (let i = 1; i < h.length; i++) expect(h[i].from_stage, `row ${i}`).toBe(h[i - 1].to_stage);
    expect(h[h.length - 1].to_stage).toBe("won");
    expect(h.filter((x) => x.to_stage === "won")).toHaveLength(1);
    expect(await leadRow(lead.id)).toMatchObject({ status: "converted", stage: "won" });

    // One event per history row, each naming its own row.
    const ev = await events(lead.id, STAGE_CHANGED);
    expect(ev.map((e) => e.payload.stageEventId).sort()).toEqual(h.map((x) => x.id).sort());
    const landed = results.filter((x) => x.kind === "move" && (x.r as { changed?: boolean }).changed).length;
    expect(h).toHaveLength(landed + 1);
  }, 60000);
});
