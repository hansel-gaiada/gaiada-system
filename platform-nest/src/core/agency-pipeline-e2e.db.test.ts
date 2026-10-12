// M5-P1-f — the lead pipeline, driven END TO END over the real HTTP routes (app.inject) against REAL
// Postgres (RLS on, NOSUPERUSER app role) and REAL Cerbos. Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md
// (§2 stages, §3 deal value, §5 the event, §6 authz and tools, §9 the P1-f row).
//
// Only ONE thing is stubbed: the WebDesk egress (`webdeskZoneB.resolveEditableTenant` and `.read`, the
// `forms.submission.get` fetch). Everything else is the shipped code path.
//
//   Lead A  web lead (L4 path, AGENCY_WEB_LEADS_ENABLED=1) -> contacted -> qualified (+ deal) -> invite ->
//           prospect submit -> open -> proposal -> convert with a deal -> WON.
//   Lead B  a second web lead, declined from `new` -> LOST.
//   Then    outbox payload keys, the personal-data grep over every outbox row, the history chain, the deal
//           round trip, Cerbos denials with VALID bodies (+ a positive control), and the MCP tools driven the
//           way the hub drives them (GET /mcp/tool-defs, fill :params, the rest of the args as the JSON body,
//           the x-obo-* envelope), asserting the same Cerbos outcomes as the routes.
//
// Where the build differs from the design the case is marked `it.fails` with the reason, and reported.
// Needs DATABASE_URL_TEST (+ CERBOS_URL, REDIS_URL_TEST): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { webdeskZoneB } from "../modules/webdev/webdesk-content.service";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ── the web submissions the stub serves ───────────────────────────────────────────────────────────
const SUB_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const SUB_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const SUB_C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const SITE = "gaiada-e2e";

const A_EMAIL = "Citra.Wulandari@Prospect-Example.test"; // mixed case on purpose: the grep checks the lower-cased form too
const A_PHONE = "+62 811-2233-4455";
const A_PHONE_DIGITS = "62811223344" + "55";
const A_NAME = "Citra Wulandari";
const A_ORG = "Villa Sari Residences";
const A_MESSAGE = "Please call me about the villa-rebrand-zq7 budget";
const B_REASON = "budget far too small for the scope zq9";

const FIELDS: Record<string, Record<string, unknown>> = {
  // `onboard` maps org_name / contact_name / contact_email / contact_phone to their own ids; `message` is carried
  // as submitted content (unmapped, so it never reaches a lead column) to prove a message body never reaches the bus.
  [SUB_A]: { org_name: A_ORG, contact_name: A_NAME, contact_email: A_EMAIL, contact_phone: A_PHONE, message: A_MESSAGE },
  [SUB_B]: { org_name: "Warung Biru", contact_name: "Budi Hartono", contact_email: "budi.hartono@biru-example.test", contact_phone: "+62 812-9000-1111", message: "just browsing" },
};
const FORM_KEY: Record<string, string> = { [SUB_A]: "onboard", [SUB_B]: "onboard", [SUB_C]: "contact" };
// Lead C uses the /contact/ form, which has no business-name field: org_name falls back to the person's name.
FIELDS[SUB_C] = { name: "Dewi Anggraini", email_address: "dewi.anggraini@contact-example.test", phone_number: "+62 813-7777-8888", message: "hello" };

const V1_KEYS = ["dealCurrency", "dealValue", "fromStage", "leadId", "occurredAt", "stageEventId", "submissionRef", "toStage", "v"];

interface ToolDef { name: string; method?: string; pathTemplate?: string; impact?: string; write?: boolean; minAssurance?: string }

describe.skipIf(!TEST_URL)("M5-P1-f — lead pipeline end to end: web lead -> won, web lead -> lost", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coB: string;
  let viewer: string;
  let member: string;
  let manager: string;
  let admin: string;
  let adminB: string;
  let clientUser: string;

  let leadA = "";
  let leadB = "";
  let leadC = "";

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.AGENCY_WEB_LEADS_ENABLED = "1";
    delete process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS; // no alert recipients: the bell is not the subject here
    resetModules();
    resetCoreRollupProviders();

    // The WebDesk egress, the only stub. `resolveEditableTenant` is the cross-company wall (resolves = this
    // company owns the site); `read` is `forms.submission.get`.
    vi.spyOn(webdeskZoneB, "resolveEditableTenant").mockResolvedValue({} as never);
    vi.spyOn(webdeskZoneB, "read").mockImplementation((async (req: { params?: Record<string, string> }) => {
      const id = req.params?.submissionId ?? "";
      return {
        body: {
          submissionId: id, formId: "f-" + id.slice(0, 4), formKey: FORM_KEY[id], siteSlug: SITE, createdAt: "2026-10-11T09:00:00Z", status: "new",
          fields: FIELDS[id],
          attribution: { landing: "/services/web/", sections_seen: ["home.hero"] },
          visitorConsent: { analytics: true, marketing: true, version: "3" },
        },
      };
    }) as never);

    co = await createCompany("Pipeline E2E A");
    coB = await createCompany("Pipeline E2E B");
    const mk = async (email: string, role: string, tenant: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole(role), "company", tenant);
      return id;
    };
    viewer = await mk("viewer@pipeline-e2e.test", "viewer", co);
    member = await mk("member@pipeline-e2e.test", "member", co);
    manager = await mk("manager@pipeline-e2e.test", "manager", co);
    admin = await mk("admin@pipeline-e2e.test", "company_admin", co);
    adminB = await mk("admin-b@pipeline-e2e.test", "company_admin", coB);
    clientUser = await mk("client@pipeline-e2e.test", "client", co); // client side: a portal role, never staff
    // The hub reaches the platform through an OBO envelope, so the staff who drive the tools need verified links.
    await linkIdentity(manager, "platform", "ext-manager", true);
    await linkIdentity(member, "platform", "ext-member", true);
    await linkIdentity(viewer, "platform", "ext-viewer", true);
    await linkIdentity(adminB, "platform", "ext-admin-b", true);
    app = await buildApp();
  }, 90000);

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    await app?.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  const post = (tenant: string, user: string, path: string, payload?: unknown) =>
    app.inject({ method: "POST", url: `/api/${tenant}/agency/${path}`, headers: asUser(user), payload: payload as never });
  const get = (tenant: string, user: string, path: string) =>
    app.inject({ method: "GET", url: `/api/${tenant}/agency/${path}`, headers: asUser(user) });
  const fromWeb = (tenant: string, user: string, submissionId: string) =>
    post(tenant, user, "leads/from-web-submission", { siteSlug: SITE, submissionId });
  const leadRow = async (id: string) =>
    (await adminPool().query<{ status: string; stage: string; deal_value: string | null; deal_currency: string | null; source: string; submission_ref: string | null }>(
      `SELECT status, stage, deal_value::text AS deal_value, deal_currency, source, submission_ref FROM agency_leads WHERE id = $1`, [id],
    )).rows[0];
  const history = async (id: string) =>
    (await adminPool().query<{ id: string; from_stage: string; to_stage: string; deal_value: string | null; deal_currency: string | null; occurred_at: Date; via_agent: string | null; actor_id: string | null }>(
      `SELECT id, from_stage, to_stage, deal_value::text AS deal_value, deal_currency, occurred_at, via_agent, actor_id
         FROM agency_lead_stage_events WHERE lead_id = $1 ORDER BY occurred_at ASC, id ASC`, [id],
    )).rows;
  const stageEvents = async (id: string) =>
    (await adminPool().query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload FROM outbox_events WHERE entity_type = 'agency_lead' AND entity_id = $1 AND event_type = 'agency.lead.stage_changed'`, [id],
    )).rows.sort((a, b) => String(a.payload.occurredAt).localeCompare(String(b.payload.occurredAt)));
  const allOutboxText = async () =>
    (await adminPool().query<{ event_type: string; t: string }>(`SELECT event_type, payload::text AS t FROM outbox_events`)).rows;
  const IDR = { value: "15000000", currency: "IDR" };

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // LEAD A: web -> contacted -> qualified(+value) -> invite -> submit -> open -> proposal -> convert(+deal) -> won
  // ══════════════════════════════════════════════════════════════════════════════════════════
  let inviteToken = "";

  it("A1 · a web submission becomes a lead at status new / stage enquiry (L4 path, flag on)", async () => {
    const r = await fromWeb(co, admin, SUB_A);
    expect(r.statusCode).toBe(201);
    leadA = r.json().id;
    expect(await leadRow(leadA)).toMatchObject({ status: "new", stage: "enquiry", source: "web", submission_ref: SUB_A, deal_value: null });
    expect(await history(leadA)).toHaveLength(0); // history starts at the FIRST move (design §2)
  });

  it("A2 · a manager moves it to contacted, then to qualified WITH a deal value", async () => {
    const a = await post(co, manager, `leads/${leadA}/stage`, { stage: "contacted" });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ id: leadA, stage: "contacted", changed: true });
    const b = await post(co, manager, `leads/${leadA}/stage`, { stage: "qualified", deal: IDR });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ stage: "qualified", changed: true });
    expect(await leadRow(leadA)).toMatchObject({ stage: "qualified", deal_value: "15000000.0000", deal_currency: "IDR" });
  });

  it("A3 · staff invite (update on agency_lead) mints a token and advances new -> invited; the stage is untouched", async () => {
    const r = await post(co, member, `leads/${leadA}/invite`, {});
    expect(r.statusCode).toBe(201);
    inviteToken = r.json().token;
    expect(inviteToken).toBeTruthy();
    expect(await leadRow(leadA)).toMatchObject({ status: "invited", stage: "qualified" });
  });

  it("A4 · the PROSPECT submits: status -> submitted, and NO stage moves and NO history row is written (design D3)", async () => {
    const before = (await history(leadA)).length;
    const r = await app.inject({
      method: "POST", url: `/api/${co}/intake/submissions`, headers: { "x-intake-token": inviteToken },
      payload: { answers: { objective: "Rebrand the villa group site and grow direct bookings." } },
    });
    expect(r.statusCode).toBe(200);
    expect(await leadRow(leadA)).toMatchObject({ status: "submitted", stage: "qualified" });
    expect((await history(leadA)).length).toBe(before);
  });

  it("A5 · staff open it (submitted -> in_review) and move it to proposal", async () => {
    const o = await post(co, manager, `leads/${leadA}/open`);
    expect(o.statusCode).toBe(200);
    expect(o.json()).toMatchObject({ status: "in_review" });
    const m = await post(co, manager, `leads/${leadA}/stage`, { stage: "proposal" });
    expect(m.statusCode).toBe(200);
    expect(await leadRow(leadA)).toMatchObject({ status: "in_review", stage: "proposal", deal_value: "15000000.0000" });
  });

  it("A6 · a company_admin converts WITH a deal: the lead is won, the deal is the converted value, and stage_changed fired", async () => {
    const r = await post(co, admin, `leads/${leadA}/convert`, { delegations: [], deal: { value: "20000000", currency: "IDR" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "converted", dealValue: "20000000.0000", dealCurrency: "IDR" });
    expect(await leadRow(leadA)).toMatchObject({ status: "converted", stage: "won", deal_value: "20000000.0000", deal_currency: "IDR" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // LEAD B: declined from `new` -> lost
  // ══════════════════════════════════════════════════════════════════════════════════════════
  it("B · a second web lead declined straight from `new` goes to lost, with one history row enquiry -> lost", async () => {
    const r = await fromWeb(co, admin, SUB_B);
    expect(r.statusCode).toBe(201);
    leadB = r.json().id;
    expect(await leadRow(leadB)).toMatchObject({ status: "new", stage: "enquiry" });
    const d = await post(co, manager, `leads/${leadB}/decline`, { reason: B_REASON });
    expect(d.statusCode).toBe(200);
    expect(await leadRow(leadB)).toMatchObject({ status: "declined", stage: "lost" });
    expect((await history(leadB)).map((h) => `${h.from_stage}>${h.to_stage}`)).toEqual(["enquiry>lost"]);
    // a closed lead refuses any further move, with a valid body and an authorised caller
    const again = await post(co, manager, `leads/${leadB}/stage`, { stage: "contacted" });
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe("lead_closed");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE EVENT, THE PERSONAL-DATA GREP, THE CHAIN, THE VALUE
  // ══════════════════════════════════════════════════════════════════════════════════════════
  it("every agency.lead.stage_changed payload has EXACTLY the v1 keys, and they agree with the history rows", async () => {
    for (const [lead, expectedChain] of [[leadA, ["enquiry>contacted", "contacted>qualified", "qualified>proposal", "proposal>won"]], [leadB, ["enquiry>lost"]]] as const) {
      const hist = await history(lead);
      const evs = await stageEvents(lead);
      expect(evs, "one event per history row").toHaveLength(hist.length);
      expect(hist.map((h) => `${h.from_stage}>${h.to_stage}`)).toEqual(expectedChain);
      for (const e of evs) {
        expect(Object.keys(e.payload).sort()).toEqual(V1_KEYS); // no more, no fewer
        expect(e.payload.v).toBe(1);
        expect(e.payload.leadId).toBe(lead);
        expect(e.payload.submissionRef).toBe(lead === leadA ? SUB_A : SUB_B);
        const h = hist.find((x) => x.id === e.payload.stageEventId);
        expect(h, "stageEventId names the history row").toBeDefined();
        expect(e.payload.fromStage).toBe(h!.from_stage);
        expect(e.payload.toStage).toBe(h!.to_stage);
        expect(e.payload.dealValue).toBe(h!.deal_value);
        expect(e.payload.dealCurrency).toBe(h!.deal_currency);
        expect(new Date(e.payload.occurredAt as string).getTime()).toBe(h!.occurred_at.getTime());
      }
    }
  });

  it("the deal value round-trips EXACTLY as a decimal string (never a number), through history, the event and the API", async () => {
    const hist = await history(leadA);
    // the qualified move carried 15000000 IDR; the won row carries the convert's 20000000 IDR
    expect(hist.map((h) => h.deal_value)).toEqual([null, "15000000.0000", "15000000.0000", "20000000.0000"]);
    expect(hist.map((h) => h.deal_currency)).toEqual([null, "IDR", "IDR", "IDR"]);
    const evs = await stageEvents(leadA);
    for (const e of evs) expect(["string", "object"]).toContain(typeof e.payload.dealValue); // string, or null (object)
    expect(evs.map((e) => e.payload.dealValue)).toEqual([null, "15000000.0000", "15000000.0000", "20000000.0000"]);
    const detail = (await get(co, viewer, `leads/${leadA}`)).json();
    expect(detail).toMatchObject({ stage: "won", dealValue: "20000000.0000", dealCurrency: "IDR" });
    expect(typeof detail.dealValue).toBe("string");
    // a USD value keeps its two minor-unit decimals exactly (numeric(20,4) pads to four, never rounds)
    const lead = (await post(co, admin, "leads", { orgName: "Usd Org", contactEmail: "usd@pipeline-e2e.test" })).json().id as string;
    const set = await post(co, member, `leads/${lead}/deal`, { value: "10.25", currency: "USD" });
    expect(set.json()).toMatchObject({ dealValue: "10.2500", dealCurrency: "USD" });
    expect((await post(co, member, `leads/${lead}/deal`, { value: "10.255", currency: "USD" })).json().reason).toBe("deal_value_precision");
    expect((await leadRow(lead)).deal_value).toBe("10.2500");
  });

  it("the stage history chain of each lead is contiguous: from = previous to, first from = enquiry, timestamps non-decreasing", async () => {
    for (const lead of [leadA, leadB]) {
      const hist = await history(lead);
      expect(hist.length).toBeGreaterThan(0);
      expect(hist[0].from_stage).toBe("enquiry"); // entry into enquiry is created_at (design §2): the first from is the initial stage
      for (let i = 1; i < hist.length; i++) {
        expect(hist[i].from_stage, `row ${i} from`).toBe(hist[i - 1].to_stage);
        expect(hist[i].occurred_at.getTime()).toBeGreaterThanOrEqual(hist[i - 1].occurred_at.getTime());
      }
    }
    expect((await history(leadA)).at(-1)!.to_stage).toBe("won");
    expect((await history(leadB)).at(-1)!.to_stage).toBe("lost");
  });

  it("NO outbox payload written during the test holds lead A's email, phone, name or message (any case)", async () => {
    const rows = await allOutboxText();
    expect(rows.length).toBeGreaterThan(8); // the grep has something to search: created, submitted, stage_changed, converted, ...
    const needles = [A_EMAIL, A_EMAIL.toLowerCase(), A_PHONE, A_PHONE_DIGITS, A_NAME, A_NAME.toLowerCase(), "citra", "wulandari", "zq7", "prospect-example"];
    const hits: string[] = [];
    for (const r of rows) {
      const t = r.t.toLowerCase();
      for (const n of needles) if (t.includes(n.toLowerCase())) hits.push(`${r.event_type} contains ${JSON.stringify(n)}`);
    }
    expect(hits).toEqual([]);
    // the same grep for lead B, whose decline reason is free text that must never ride an event (design §5)
    for (const r of rows) {
      const t = r.t.toLowerCase();
      for (const n of ["budi", "hartono", "biru-example", "9000-1111", B_REASON.toLowerCase(), "zq9"]) expect(t, `${r.event_type} / ${n}`).not.toContain(n);
    }
    // and the declined event carries no reason at all
    const declined = await adminPool().query(`SELECT payload FROM outbox_events WHERE event_type = 'agency.lead.declined' AND entity_id = $1`, [leadB]);
    expect(declined.rows).toHaveLength(1);
    expect(Object.keys(declined.rows[0].payload)).not.toContain("reason");
  });

  it("the stage history API is newest first, names the actor, and holds no personal data", async () => {
    const rows = (await get(co, viewer, `leads/${leadA}/stage-history`)).json() as Record<string, unknown>[];
    expect(rows.map((r) => `${r.fromStage}>${r.toStage}`)).toEqual(["proposal>won", "qualified>proposal", "contacted>qualified", "enquiry>contacted"]);
    expect(rows[3]).toMatchObject({ actorId: manager });
    const text = JSON.stringify(rows).toLowerCase();
    for (const n of ["citra", "wulandari", "prospect-example", "62 811", "zq7"]) expect(text).not.toContain(n);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // CERBOS DENIALS (valid bodies) + a positive control; tenancy
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("authorization, with valid bodies", () => {
    let lead = "";
    const snapshot = async () => ({ row: await leadRow(lead), hist: (await history(lead)).length });

    beforeAll(async () => {
      lead = (await post(co, admin, "leads", { orgName: "Authz Org", contactEmail: "authz@pipeline-e2e.test" })).json().id;
    });

    it("a member is DENIED a stage move (default: triage is manager+), with and without a deal; nothing changes", async () => {
      const before = await snapshot();
      expect((await post(co, member, `leads/${lead}/stage`, { stage: "contacted" })).statusCode).toBe(403);
      expect((await post(co, member, `leads/${lead}/stage`, { stage: "contacted", deal: IDR })).statusCode).toBe(403);
      expect(await snapshot()).toEqual(before);
    });

    it("POSITIVE CONTROL: the same body from a manager succeeds", async () => {
      const r = await post(co, manager, `leads/${lead}/stage`, { stage: "contacted" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ stage: "contacted", changed: true });
    });

    it("a viewer reads but cannot move or set a value; a manager cannot convert", async () => {
      expect((await get(co, viewer, `leads/${lead}/stage-history`)).statusCode).toBe(200);
      expect((await post(co, viewer, `leads/${lead}/stage`, { stage: "qualified" })).statusCode).toBe(403);
      expect((await post(co, viewer, `leads/${lead}/deal`, IDR)).statusCode).toBe(403);
      expect((await post(co, manager, `leads/${lead}/convert`, { delegations: [], deal: IDR })).statusCode).toBe(403);
      expect((await leadRow(lead)).stage).toBe("contacted");
    });

    it("a CLIENT-side principal gets 403 on every pipeline route (reads and writes), valid bodies throughout", async () => {
      const before = await snapshot();
      expect((await get(co, clientUser, `leads/${lead}`)).statusCode).toBe(403);
      expect((await get(co, clientUser, `leads/${lead}/stage-history`)).statusCode).toBe(403);
      expect((await get(co, clientUser, "pipeline/reference")).statusCode).toBe(403);
      expect((await post(co, clientUser, `leads/${lead}/stage`, { stage: "qualified" })).statusCode).toBe(403);
      expect((await post(co, clientUser, `leads/${lead}/stage`, { stage: "qualified", deal: IDR })).statusCode).toBe(403);
      expect((await post(co, clientUser, `leads/${lead}/deal`, IDR)).statusCode).toBe(403);
      expect((await post(co, clientUser, `leads/${lead}/convert`, { delegations: [], deal: IDR })).statusCode).toBe(403);
      expect((await post(co, clientUser, `leads/${lead}/decline`, { reason: "no" })).statusCode).toBe(403);
      expect(await snapshot()).toEqual(before);
    });

    it("another company's admin: 403 on this tenant's path, 404 (RLS) on their own path naming this lead; nothing changes", async () => {
      const before = await snapshot();
      expect((await post(co, adminB, `leads/${lead}/stage`, { stage: "qualified" })).statusCode).toBe(403);
      expect((await post(co, adminB, `leads/${lead}/deal`, IDR)).statusCode).toBe(403);
      expect((await post(co, adminB, `leads/${lead}/convert`, { delegations: [], deal: IDR })).statusCode).toBe(403);
      expect((await get(co, adminB, `leads/${lead}/stage-history`)).statusCode).toBe(403);
      expect((await post(coB, adminB, `leads/${lead}/stage`, { stage: "qualified" })).statusCode).toBe(404);
      expect((await post(coB, adminB, `leads/${lead}/deal`, IDR)).statusCode).toBe(404);
      expect((await get(coB, adminB, `leads/${lead}/stage-history`)).statusCode).toBe(404);
      expect((await get(coB, adminB, `leads/${lead}`)).statusCode).toBe(404);
      expect(await snapshot()).toEqual(before);
      // the web-lead create is walled the same way: B naming A's site is refused by the wall, not by luck
      (webdeskZoneB.resolveEditableTenant as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("site_not_found"), { getStatus: () => 404, status: 404 }));
      const wall = await fromWeb(coB, adminB, SUB_C);
      expect(wall.statusCode).toBeGreaterThanOrEqual(400);
      expect((await adminPool().query(`SELECT 1 FROM agency_leads WHERE submission_ref = $1`, [SUB_C])).rowCount).toBe(0);
    });

    it("won and lost cannot be reached through a move (typed 400 stage_terminal), even for a manager", async () => {
      for (const stage of ["won", "lost"]) {
        const r = await post(co, manager, `leads/${lead}/stage`, { stage });
        expect(r.statusCode).toBe(400);
        expect(r.json().reason).toBe("stage_terminal");
      }
      expect((await leadRow(lead)).stage).toBe("contacted");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // MCP: the tools, driven the way the hub drives them
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe("MCP tools through the hub's dispatch shape", () => {
    let defs: ToolDef[] = [];
    let lead = "";
    const obo = (externalId: string, agent?: string) => ({
      ...svc, "x-obo-provider": "platform", "x-obo-external-id": externalId, ...(agent ? { "x-obo-agent": agent } : {}),
    });

    /** mcp-hub/src/module-tools.ts callPlatform(), step for step: fill :params (URL-encoded) from args, every arg
     *  that was not a path param is the JSON body of a non-GET, the OBO envelope is the identity. */
    async function callTool(name: string, args: Record<string, unknown>, headers: Record<string, string>) {
      const def = defs.find((d) => d.name === name);
      if (!def?.pathTemplate) throw new Error(`tool not advertised: ${name}`);
      const used = new Set<string>();
      const path = def.pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => {
        used.add(p);
        const v = args[p];
        if (v == null || v === "") throw new Error(`missing path parameter: ${p}`);
        return encodeURIComponent(String(v));
      });
      const method = (def.method ?? "GET") as "GET" | "POST";
      if (method === "GET") return app.inject({ method, url: path, headers });
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
      return app.inject({ method, url: path, headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(rest) });
    }

    beforeAll(async () => {
      const r = await app.inject({ method: "GET", url: "/mcp/tool-defs", headers: svc });
      expect(r.statusCode).toBe(200);
      defs = r.json() as ToolDef[];
      lead = (await post(co, admin, "leads", { orgName: "Tool Org", contactEmail: "tool@pipeline-e2e.test" })).json().id;
    });

    it("the four agency_pipeline.* tools are advertised; the writes are low impact and verified-assurance", () => {
      const names = defs.map((d) => d.name).filter((n) => n.startsWith("agency_pipeline."));
      expect(names.sort()).toEqual(["agency_pipeline.moveStage", "agency_pipeline.reference", "agency_pipeline.setDealValue", "agency_pipeline.stageHistory"]);
      for (const n of ["agency_pipeline.moveStage", "agency_pipeline.setDealValue"]) {
        const d = defs.find((x) => x.name === n)!;
        expect(d).toMatchObject({ write: true, impact: "low", minAssurance: "verified" });
      }
      // there is deliberately no tool that moves a lead to won or lost
      expect(names.some((n) => /won|lost/i.test(n))).toBe(false);
    });

    it("moveStage as a MEMBER is 403 (the same outcome as the route) and changes nothing", async () => {
      const r = await callTool("agency_pipeline.moveStage", { tenantId: co, leadId: lead, stage: "contacted" }, obo("ext-member"));
      expect(r.statusCode).toBe(403);
      expect((await leadRow(lead)).stage).toBe("enquiry");
      expect((await history(lead)).length).toBe(0);
    });

    it("moveStage as a MANAGER succeeds, and the history names the agent that drove it (via_agent)", async () => {
      const r = await callTool("agency_pipeline.moveStage", { tenantId: co, leadId: lead, stage: "contacted" }, obo("ext-manager", "pipeline-agent"));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id: lead, stage: "contacted", changed: true });
      const h = await history(lead);
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ from_stage: "enquiry", to_stage: "contacted", actor_id: manager, via_agent: "pipeline-agent" });
      // a retry is safe: same stage, changed:false, no second row
      const again = await callTool("agency_pipeline.moveStage", { tenantId: co, leadId: lead, stage: "contacted" }, obo("ext-manager", "pipeline-agent"));
      expect(again.json()).toEqual({ id: lead, stage: "contacted", changed: false });
      expect(await history(lead)).toHaveLength(1);
    });

    it("moveStage to a terminal stage is the same typed 400 through the tool as through the route", async () => {
      const r = await callTool("agency_pipeline.moveStage", { tenantId: co, leadId: lead, stage: "won" }, obo("ext-manager"));
      expect(r.statusCode).toBe(400);
      expect(r.json().reason).toBe("stage_terminal");
    });

    it("moveStage cross-company: 403 on the other tenant's id, 404 on the caller's own tenant naming this lead", async () => {
      expect((await callTool("agency_pipeline.moveStage", { tenantId: co, leadId: lead, stage: "qualified" }, obo("ext-admin-b"))).statusCode).toBe(403);
      expect((await callTool("agency_pipeline.moveStage", { tenantId: coB, leadId: lead, stage: "qualified" }, obo("ext-admin-b"))).statusCode).toBe(404);
      expect((await leadRow(lead)).stage).toBe("contacted");
    });

    it("setDealValue: a member may set it (update), a viewer may not, and the value is a decimal string", async () => {
      const denied = await callTool("agency_pipeline.setDealValue", { tenantId: co, leadId: lead, value: "5000000", currency: "IDR" }, obo("ext-viewer"));
      expect(denied.statusCode).toBe(403);
      const ok = await callTool("agency_pipeline.setDealValue", { tenantId: co, leadId: lead, value: "5000000", currency: "IDR" }, obo("ext-member"));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ dealValue: "5000000.0000", dealCurrency: "IDR" });
    });

    it("the read tools return what the routes return: stageHistory (same rows) and reference (six ordered stages)", async () => {
      const viaTool = await callTool("agency_pipeline.stageHistory", { tenantId: co, leadId: lead }, obo("ext-viewer"));
      const viaRoute = await get(co, viewer, `leads/${lead}/stage-history`);
      expect(viaTool.statusCode).toBe(200);
      expect(viaTool.json()).toEqual(viaRoute.json());
      expect((viaTool.json() as { toStage: string }[]).map((r) => r.toStage)).toEqual(["contacted"]);
      const ref = await callTool("agency_pipeline.reference", { tenantId: co }, obo("ext-viewer"));
      expect(ref.statusCode).toBe(200);
      expect((ref.json() as { stages: { key: string }[] }).stages.map((s) => s.key)).toEqual(["enquiry", "contacted", "qualified", "proposal", "won", "lost"]);
      // and the cross-company read is refused the same way as the route
      expect((await callTool("agency_pipeline.stageHistory", { tenantId: co, leadId: lead }, obo("ext-admin-b"))).statusCode).toBe(403);
      expect((await callTool("agency_pipeline.stageHistory", { tenantId: coB, leadId: lead }, obo("ext-admin-b"))).statusCode).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Personal data on the bus through convert's pipeline.run.created (found by M5-P1-f, fixed by M5-P1-g)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Design §5/§10 risk 6: "no personal data on the bus". Convert used to emit `pipeline.run.created` with
  // `title: row.org_name`. For the /contact/ and /audit/ web forms there is no business name field, so
  // mapSubmissionToLead falls back to the PERSON'S NAME as org_name, and the full name rode the outbox the moment such
  // a lead was converted. Lead A above is on the `onboard` form (a real org name), which is why its grep was clean.
  // The title is no longer in the payload; this asserts no outbox row carries the person's name, email or phone.
  describe("lead C: a /contact/-form web lead is converted", () => {
    beforeAll(async () => {
      const r = await fromWeb(co, admin, SUB_C);
      expect(r.statusCode).toBe(201);
      leadC = r.json().id;
      await adminPool().query(`UPDATE agency_leads SET status = 'in_review' WHERE id = $1`, [leadC]); // a convertible status without the invite round trip
      expect((await post(co, admin, `leads/${leadC}/convert`, { delegations: [] })).statusCode).toBe(200);
    });

    it("the person's name, email and phone are NOT on the outbox (pipeline.run.created carries no title)", async () => {
      const rows = await allOutboxText();
      expect(rows.length).toBeGreaterThan(0); // the convert did emit; the grep is not vacuous
      for (const needle of ["dewi anggraini", "dewi.anggraini@contact-example.test", "813-7777-8888"]) {
        const hits = rows.filter((x) => x.t.toLowerCase().includes(needle)).map((x) => x.event_type);
        expect(hits, needle).toEqual([]);
      }
    });
  });
});
