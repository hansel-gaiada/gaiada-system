// PV4-04 — PV-D5's binding rule, driven through the REAL routes against real Postgres (RLS) and a live
// Cerbos: a change request that changes the price cannot start until the amendment that records the new
// price is SIGNED in Contracts & billing.
//
// Standard applied (same as webdev-change-requests.controller.test.ts): a 200 is not a pass. Every claim is
// read back from the tables through `adminPool()` (so what is asserted is what committed), every refusal also
// asserts the STORED row is unchanged, and every denial sends an otherwise VALID request so a 403 can only
// come from authorization (authz runs before validation).
//
// "Signed" is driven the REAL way wherever it matters: staff write the terms, send, the client's signer signs
// in the portal, a platform admin countersigns. Direct INSERTs are used only for the BASELINE contracts an
// amendment amends (a signed master agreement is a fixture, not the thing under test) and to put a contract
// into a dead state (declined) that has no staff route.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import type { OutboxEvent } from "../events/types";
import { amendmentSignedHandler, AMENDMENT_UNBLOCKED_TYPE } from "./amendment-signed-handler";
import { isDeadContractStatus, isStartBlocked } from "./webdev-amendment";
import { FIXTURE_TERMS_SHA256 } from "../testing/contract-fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SIGN = { signerName: "Platform Signer", signerTitle: "Director" };

// ── Pure units (no database): these run on every machine ─────────────────────────────────────────
describe("PV4-04 · the gate's predicates (pure)", () => {
  it("only a changes_price request whose linked contract is not signed is blocked; everything else is open", () => {
    const row = (price_impact: string, amendment_status: string | null) => ({
      price_impact, amendment_contract_id: amendment_status ? "c1" : null, amendment_status,
    });
    expect(isStartBlocked(row("changes_price", "draft"))).toBe(true);
    expect(isStartBlocked(row("changes_price", "sent"))).toBe(true);
    expect(isStartBlocked(row("changes_price", "declined"))).toBe(true);
    expect(isStartBlocked(row("changes_price", "void"))).toBe(true);
    expect(isStartBlocked(row("changes_price", null))).toBe(true); // fails CLOSED: no readable contract at all
    expect(isStartBlocked(row("changes_price", "signed"))).toBe(false);
    expect(isStartBlocked(row("none", null))).toBe(false);
    expect(isStartBlocked(row("unassessed", null))).toBe(false); // grandfathered: never blocked
  });

  it("declined, void and expired contracts are dead; draft and sent are live; signed is neither", () => {
    for (const s of ["declined", "void", "expired"]) expect(isDeadContractStatus(s), s).toBe(true);
    for (const s of ["draft", "sent", "signed"]) expect(isDeadContractStatus(s), s).toBe(false);
    expect(isDeadContractStatus(null)).toBe(true); // a missing / soft-deleted contract is dead
  });

  it("main.ts registers the contract.signed handler AND drains the `contract` stream it is emitted on", () => {
    // A handler on a stream nobody drains is registered and never invoked (the SMM-14 trap), and the
    // handler's own test calls it directly, so this file-level pin is what catches that regression.
    const main = readFileSync(join(__dirname, "..", "main.ts"), "utf8");
    expect(main).toMatch(/registerAmendmentEventHandlers\(\);/);
    const loop = main.slice(main.indexOf("startConsumerLoop(["));
    expect(loop.slice(0, loop.indexOf("]);"))).toMatch(/^\s*"contract",\s*$/m);
  });
});

describe.skipIf(!TEST_URL)("PV4-04: a price change lands in Contracts & billing (HTTP)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;       // company_admin + membership: triages, drafts, sends, voids; may NOT countersign
  let platform: string;    // platform_admin (global) + membership: may countersign
  let plainMember: string; // `member`: no triage, no contract create
  let signerC: string;     // active signer contact of clientA, client-wide
  let projectScoped: string; // active signer contact of clientA scoped to projY ONLY
  let clientA: string;
  let clientB: string;
  let clientC: string;     // has NO contract at all
  let projX: string;       // clientA's project WITH its own signed contract
  let projY: string;       // clientA's project with NONE (falls back to the master agreement)
  let masterA: string;     // clientA's signed master agreement (project_id NULL)
  let sowX: string;        // clientA's signed SOW on projX
  let masterB: string;     // clientB's signed contract, the cross-client probe

  const sql = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, args: unknown[] = []) =>
    adminPool().query<T>(text, args);

  async function addContact(userId: string, clientId: string, projectId: string | null = null): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'signer', 'active', $6)`,
        [newId(), co, clientId, userId, projectId, config.originSite],
      ),
    );
    await grantRole(userId, await createRole("client"), "company", co);
  }

  /** A contract row written directly: the BASELINE an amendment amends, or a contract forced dead. */
  async function insertContract(o: {
    clientId: string; projectId?: string | null; status?: string; reference?: string | null; title?: string;
  }): Promise<string> {
    const id = newId();
    const status = o.status ?? "signed";
    await sql(
      // PV5-06: a contract that is not a draft must have its content fixed (hash, time and tier together), or the
      // CHECK contracts_content_fixed_when_sent refuses the row; a draft must have none (contracts_draft_not_fixed).
      `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, reference, version, status, body_md, currency,
                              sent_at, signed_at, created_by, origin_site, content_sha256, content_fixed_at, signature_tier)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'Terms.', 'IDR',
               CASE WHEN $7 <> 'draft' THEN now() END, CASE WHEN $7 = 'signed' THEN now() END, $8, $9,
               CASE WHEN $7 <> 'draft' THEN $10 END, CASE WHEN $7 <> 'draft' THEN now() END,
               CASE WHEN $7 <> 'draft' THEN 'attested' END)`,
      [id, co, o.clientId, o.projectId ?? null, o.title ?? "Baseline", o.reference ?? null, status, admin, config.originSite, FIXTURE_TERMS_SHA256],
    );
    return id;
  }

  /** Force a DRAFT contract into a dead state. A declined contract was, by definition, sent, so its content is
   *  fixed in the same UPDATE (PV5-06: contracts_content_fixed_when_sent). `void` of an unsent draft needs none. */
  const kill = (contractId: string, status: "declined" | "void") =>
    sql(
      `UPDATE contracts SET status = $2,
              content_sha256 = COALESCE(content_sha256, $3), content_fixed_at = COALESCE(content_fixed_at, now()),
              signature_tier = COALESCE(signature_tier, 'attested'), sent_at = COALESCE(sent_at, now())
        WHERE id = $1`,
      [contractId, status, FIXTURE_TERMS_SHA256],
    );

  let seq = 0;
  const uniq = () => `pv404-${++seq}-${Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, "z")}`;

  /** An internal-source CR through the real endpoint (staff-logged, so `requested_by` is the admin). */
  async function internalCr(payload: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
    const title = `Change ${uniq()}`;
    const res = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(admin),
      payload: { kind: "feature", title, clientId: clientA, projectId: projX, ...payload },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { id: (res.json() as { id: string }).id, title };
  }

  /** A portal CR raised by the client's signer, so the portal reads have something to show. */
  async function portalCr(): Promise<{ id: string; title: string }> {
    const title = `Portal change ${uniq()}`;
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/change-requests`, headers: asUser(signerC),
      payload: { kind: "feature", title, body: "add a booking widget" },
    });
    expect(r.statusCode, r.body).toBe(201);
    return { id: (r.json() as { id: string }).id, title };
  }

  const triage = (crId: string, payload: Record<string, unknown>, actor = admin) =>
    app.inject({ method: "POST", url: `/api/${co}/webdev/change-requests/${crId}/triage`, headers: asUser(actor), payload });
  const verify = (crId: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/api/${co}/webdev/change-requests/${crId}/verify`, headers: asUser(admin), payload });

  const crRow = async (id: string) =>
    (await sql(
      `SELECT status, route, pipeline_run_id, pm_task_id, price_impact, amendment_contract_id, triaged_by, kind
         FROM webdev_change_requests WHERE id = $1`, [id],
    )).rows[0] as {
      status: string; route: string | null; pipeline_run_id: string | null; pm_task_id: string | null;
      price_impact: string; amendment_contract_id: string | null; triaged_by: string | null; kind: string;
    };
  const contractsOf = async (crId: string) =>
    (await sql(
      `SELECT id, kind, amends_id, status, title, client_id, project_id, change_request_id, supersedes_id
         FROM contracts WHERE change_request_id = $1 ORDER BY created_at ASC`, [crId],
    )).rows as Array<{
      id: string; kind: string; amends_id: string | null; status: string; title: string; client_id: string;
      project_id: string | null; change_request_id: string | null; supersedes_id: string | null;
    }>;
  const statusOf = async (contractId: string) =>
    (await sql(`SELECT status FROM contracts WHERE id = $1`, [contractId])).rows[0].status as string;

  /** Triage `changes_price`; asserts the amendment came back and returns its id. */
  async function changesPrice(crId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await triage(crId, { action: "convert", route: "mini_run", priceImpact: "changes_price", ...extra });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { amendmentContractId: string }).amendmentContractId;
  }

  /** The client's signature the way the portal does it (PV5-06): read the contract, echo the content hash
   *  `send` fixed, so the signer signs WHAT THEY SAW. */
  async function clientSign(contractId: string) {
    const seen = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${contractId}`, headers: asUser(signerC) });
    expect(seen.statusCode, seen.body).toBe(200);
    return app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${contractId}/sign`, headers: asUser(signerC),
      payload: { signerName: "Client Signer", agree: true, contentSha256: (seen.json() as { contentSha256: string }).contentSha256 },
    });
  }

  /** Drive a draft amendment to `signed` the real way: terms, send, the client signs, a platform admin countersigns. */
  async function signForReal(contractId: string): Promise<void> {
    const terms = await app.inject({
      method: "PATCH", url: `/api/${co}/contracts/${contractId}`, headers: asUser(admin), payload: { bodyMd: "The agreed price change." },
    });
    expect(terms.statusCode, terms.body).toBe(200);
    const sent = await app.inject({ method: "POST", url: `/api/${co}/contracts/${contractId}/send`, headers: asUser(admin) });
    expect(sent.statusCode, sent.body).toBe(200);
    const client = await clientSign(contractId);
    expect(client.statusCode, client.body).toBe(200);
    expect(await statusOf(contractId)).toBe("sent"); // one side only: NOT signed yet
    const ours = await app.inject({
      method: "POST", url: `/api/${co}/contracts/${contractId}/countersign`, headers: asUser(platform), payload: SIGN,
    });
    expect(ours.statusCode, ours.body).toBe(200);
    expect(await statusOf(contractId)).toBe("signed");
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("PV404 Agency", ["agency", "clients"]);

    admin = await createUser("admin@pv404.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);

    platform = await createUser("platform@pv404.test");
    await addMembership(co, platform);
    await grantRole(platform, await createRole("platform_admin"), "global", null);

    plainMember = await createUser("member@pv404.test");
    await addMembership(co, plainMember);
    await grantRole(plainMember, await createRole("member"), "company", co);

    // MON-00a: the permission arm is root-bounded; anchor every staff user on the tenant.
    for (const u of [admin, platform, plainMember]) {
      await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    }

    clientA = await createClient(co, "PV404 Client A");
    clientB = await createClient(co, "PV404 Client B");
    clientC = await createClient(co, "PV404 Client C");
    projX = await createProject(co, "PV404 Project X", admin);
    projY = await createProject(co, "PV404 Project Y", admin);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = ANY($1::uuid[])`, [[projX, projY], clientA]));

    signerC = await createUser("signer@client.pv404.test");
    await addContact(signerC, clientA);
    projectScoped = await createUser("scoped@client.pv404.test");
    await addContact(projectScoped, clientA, projY);

    masterA = await insertContract({ clientId: clientA, reference: "PV404-MSA-A", title: "Master services agreement" });
    sowX = await insertContract({ clientId: clientA, projectId: projX, reference: "PV404-SOW-X", title: "SOW for X" });
    masterB = await insertContract({ clientId: clientB, reference: "PV404-MSA-B" });

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 1 · Triage must answer priceImpact
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("triage must answer priceImpact", () => {
    it("a convert with no priceImpact is a typed 400 `price_impact_required`, and the row is untouched", async () => {
      const cr = await internalCr();
      for (const payload of [
        { action: "convert", route: "pm_task" },
        { action: "convert", route: "pm_task", priceImpact: "" },
        { action: "convert", route: "pm_task", priceImpact: null },
      ]) {
        const r = await triage(cr.id, payload);
        expect(r.statusCode, JSON.stringify(payload)).toBe(400);
        expect(r.json()).toMatchObject({ error: "price_impact_required", field: "priceImpact" });
      }
      expect(await crRow(cr.id)).toMatchObject({ status: "new", price_impact: "unassessed", route: null, pm_task_id: null });
    });

    it("`unassessed` is a state, not an answer: it and any other value are `price_impact_invalid`", async () => {
      const cr = await internalCr();
      for (const priceImpact of ["unassessed", "maybe", 7]) {
        const r = await triage(cr.id, { action: "convert", route: "pm_task", priceImpact });
        expect(r.statusCode, String(priceImpact)).toBe(400);
        expect(r.json()).toMatchObject({ error: "price_impact_invalid", field: "priceImpact" });
      }
      expect(await crRow(cr.id)).toMatchObject({ status: "new", price_impact: "unassessed" });
    });

    it("a DECLINE starts and prices nothing, so it is not asked (and the row stays `unassessed`)", async () => {
      const cr = await internalCr();
      const r = await triage(cr.id, { action: "decline", reason: "out of scope" });
      expect(r.statusCode, r.body).toBe(200);
      expect(await crRow(cr.id)).toMatchObject({ status: "declined", price_impact: "unassessed" });
    });

    it("🔴 authorization runs BEFORE validation: a caller who may not triage gets 403 for an empty body, not 400", async () => {
      const cr = await internalCr();
      const r = await triage(cr.id, {}, plainMember);
      expect(r.statusCode, r.body).toBe(403);
      const noPrice = await triage(cr.id, { action: "convert", route: "pm_task" }, plainMember);
      expect(noPrice.statusCode, noPrice.body).toBe(403);
      expect(await crRow(cr.id)).toMatchObject({ status: "new" });
    });

    it("`none` behaves exactly as before: the request converts, `priceImpact` is stored, and NO contract is created", async () => {
      const cr = await internalCr();
      const r = await triage(cr.id, { action: "convert", route: "mini_run", priceImpact: "none" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ id: cr.id, status: "in_progress", route: "mini_run" });
      expect(await crRow(cr.id)).toMatchObject({ status: "in_progress", route: "mini_run", price_impact: "none", amendment_contract_id: null });
      expect((await crRow(cr.id)).pipeline_run_id).toBeTruthy();
      expect(await contractsOf(cr.id)).toHaveLength(0);
    });

    it("`amendsId` only makes sense with `changes_price`: with `none` it is 400 `amends_id_requires_changes_price`", async () => {
      const cr = await internalCr();
      const r = await triage(cr.id, { action: "convert", route: "pm_task", priceImpact: "none", amendsId: masterA });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ error: "amends_id_requires_changes_price" });
      expect(await crRow(cr.id)).toMatchObject({ status: "new" });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 2 · changes_price creates the amendment, in the same transaction
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("changes_price", () => {
    it("creates EXACTLY ONE draft amendment of the project's signed contract, linked both ways; nothing starts", async () => {
      const cr = await internalCr(); // projX: has its own signed SOW AND the client has a master
      const r = await triage(cr.id, { action: "convert", route: "mini_run", priceImpact: "changes_price" });
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as { amendmentContractId: string };
      expect(body).toMatchObject({
        id: cr.id, status: "new", route: null, priceImpact: "changes_price", blocked: true, amendmentKind: "amendment", amendsId: sowX,
      });

      const contracts = await contractsOf(cr.id);
      expect(contracts).toHaveLength(1);
      expect(contracts[0]).toMatchObject({
        id: body.amendmentContractId, kind: "amendment", amends_id: sowX, status: "draft",
        title: `Amendment: ${cr.title}`, client_id: clientA, project_id: projX, change_request_id: cr.id,
        supersedes_id: null, // an amendment is NOT a re-issue
      });
      // The request side of the pair.
      expect(await crRow(cr.id)).toMatchObject({
        status: "new", route: null, pipeline_run_id: null, pm_task_id: null,
        price_impact: "changes_price", amendment_contract_id: body.amendmentContractId, triaged_by: admin,
      });
      // The amended contract is untouched: an amendment never voids or supersedes it.
      expect(await statusOf(sowX)).toBe("signed");
      expect((await sql(`SELECT count(*)::int AS n FROM contracts WHERE supersedes_id = $1`, [sowX])).rows[0].n).toBe(0);
      // No work was started anywhere.
      expect((await sql(`SELECT count(*)::int AS n FROM pipeline_runs WHERE title = $1`, [cr.title])).rows[0].n).toBe(0);
      expect((await sql(`SELECT count(*)::int AS n FROM pm_tasks WHERE title = $1`, [cr.title])).rows[0].n).toBe(0);
    });

    it("with no signed contract on the project, the default target is the client's signed MASTER agreement", async () => {
      const cr = await internalCr({ projectId: projY });
      const id = await changesPrice(cr.id);
      expect(await contractsOf(cr.id)).toEqual([
        expect.objectContaining({ id, kind: "amendment", amends_id: masterA, project_id: projY, status: "draft" }),
      ]);
    });

    it("a client-wide request (no project) also amends the master agreement", async () => {
      const cr = await internalCr({ projectId: undefined });
      const id = await changesPrice(cr.id);
      expect(await contractsOf(cr.id)).toEqual([
        expect.objectContaining({ id, kind: "amendment", amends_id: masterA, project_id: null }),
      ]);
    });

    it("the default skips contracts that are not signed (a sent SOW is not amendable) and amendments themselves", async () => {
      await insertContract({ clientId: clientA, projectId: projY, status: "sent", reference: "PV404-SOW-Y-SENT" });
      const cr = await internalCr({ projectId: projY });
      await changesPrice(cr.id);
      expect((await contractsOf(cr.id))[0].amends_id).toBe(masterA); // not the sent SOW, not any earlier amendment
    });

    it("a client with NO signed contract gets a draft `agreement`, linked the same way (no amends_id)", async () => {
      const cr = await internalCr({ clientId: clientC, projectId: undefined });
      const id = await changesPrice(cr.id);
      const contracts = await contractsOf(cr.id);
      expect(contracts).toHaveLength(1);
      expect(contracts[0]).toMatchObject({
        id, kind: "agreement", amends_id: null, status: "draft", client_id: clientC, change_request_id: cr.id,
      });
      expect(await crRow(cr.id)).toMatchObject({ price_impact: "changes_price", amendment_contract_id: id, status: "new" });
    });

    it("an explicit `amendsId` of the same client's signed contract is honoured over the default", async () => {
      const cr = await internalCr(); // projX would default to sowX
      const id = await changesPrice(cr.id, { amendsId: masterA });
      expect((await contractsOf(cr.id))[0]).toMatchObject({ id, kind: "amendment", amends_id: masterA });
    });

    it("🔴 an explicit `amendsId` that is another client's contract, not signed, unknown, or malformed is 400 and creates NOTHING", async () => {
      const draftOfA = await insertContract({ clientId: clientA, status: "draft", reference: "PV404-A-DRAFT" });
      const cr = await internalCr();
      for (const amendsId of [masterB, draftOfA, newId(), "not-a-uuid"]) {
        const r = await triage(cr.id, { action: "convert", route: "mini_run", priceImpact: "changes_price", amendsId });
        expect(r.statusCode, `${amendsId}: ${r.body}`).toBe(400);
        expect(r.json()).toMatchObject({ error: "amends_id_invalid", field: "amendsId" });
      }
      expect(await contractsOf(cr.id)).toHaveLength(0);
      expect(await crRow(cr.id)).toMatchObject({ status: "new", price_impact: "unassessed", amendment_contract_id: null, triaged_by: null });
    });

    it("a staff request that names no client cannot change a price (400 `client_required_for_price_change`)", async () => {
      const cr = await internalCr({ clientId: undefined, projectId: undefined });
      const r = await triage(cr.id, { action: "convert", route: "pm_task", priceImpact: "changes_price" });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ error: "client_required_for_price_change" });
      expect(await crRow(cr.id)).toMatchObject({ status: "new", price_impact: "unassessed" });
    });

    it("a second `changes_price` triage while the amendment is live makes NO second draft (409, still exactly one)", async () => {
      const cr = await internalCr();
      const id = await changesPrice(cr.id);
      const again = await triage(cr.id, { action: "convert", route: "mini_run", priceImpact: "changes_price" });
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json()).toMatchObject({ error: "amendment_not_signed", existing: { amendmentContractId: id, amendmentStatus: "draft" } });
      expect((await contractsOf(cr.id)).map((c) => c.id)).toEqual([id]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 3 · The rule: nothing that STARTS work while the amendment is unsigned
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("work-starting transitions are refused with 409 `amendment_not_signed` until the amendment is signed", () => {
    const STARTS = [
      { route: "mini_run", label: "route mini_run (links a pipeline_run_id)", ok: 200 },
      { route: "pm_task", label: "route pm_task (links a pm_task_id)", ok: 200 },
      { route: "control_plane", label: "route control_plane", ok: 501 }, // refused as ever once the gate is open
    ] as const;

    for (const s of STARTS) {
      it(`${s.label}: 409 while draft, 409 while sent, then ${s.ok} once signed for real`, async () => {
        const cr = await internalCr();
        const contractId = await changesPrice(cr.id);

        // While DRAFT.
        const draft = await triage(cr.id, { action: "convert", route: s.route, priceImpact: "changes_price" });
        expect(draft.statusCode, draft.body).toBe(409);
        expect(draft.json()).toMatchObject({ error: "amendment_not_signed", existing: { amendmentContractId: contractId, amendmentStatus: "draft" } });
        // The default route (none named) is a start too.
        const dflt = await triage(cr.id, { action: "convert", priceImpact: "changes_price" });
        expect(dflt.statusCode, dflt.body).toBe(409);
        // Refused means UNCHANGED: still `new`, nothing linked, nothing spawned.
        expect(await crRow(cr.id)).toMatchObject({ status: "new", route: null, pipeline_run_id: null, pm_task_id: null });
        expect((await sql(`SELECT count(*)::int AS n FROM pipeline_runs WHERE title = $1`, [cr.title])).rows[0].n).toBe(0);
        expect((await sql(`SELECT count(*)::int AS n FROM pm_tasks WHERE title = $1`, [cr.title])).rows[0].n).toBe(0);

        // While SENT (one side signed is still not signed).
        await app.inject({ method: "PATCH", url: `/api/${co}/contracts/${contractId}`, headers: asUser(admin), payload: { bodyMd: "Terms." } });
        const sent = await app.inject({ method: "POST", url: `/api/${co}/contracts/${contractId}/send`, headers: asUser(admin) });
        expect(sent.statusCode, sent.body).toBe(200);
        const whileSent = await triage(cr.id, { action: "convert", route: s.route, priceImpact: "changes_price" });
        expect(whileSent.statusCode, whileSent.body).toBe(409);
        expect(whileSent.json()).toMatchObject({ error: "amendment_not_signed", existing: { amendmentStatus: "sent" } });

        // Sign it for real: the client signs, then a platform admin countersigns.
        const client = await clientSign(contractId);
        expect(client.statusCode, client.body).toBe(200);
        expect((await triage(cr.id, { action: "convert", route: s.route, priceImpact: "changes_price" })).statusCode).toBe(409);
        const ours = await app.inject({
          method: "POST", url: `/api/${co}/contracts/${contractId}/countersign`, headers: asUser(platform), payload: SIGN,
        });
        expect(ours.statusCode, ours.body).toBe(200);
        expect(await statusOf(contractId)).toBe("signed");

        // Now allowed (and still exactly one amendment: the signed one is reused, never duplicated).
        const go = await triage(cr.id, { action: "convert", route: s.route, priceImpact: "changes_price" });
        expect(go.statusCode, go.body).toBe(s.ok);
        if (s.ok === 200) {
          expect(await crRow(cr.id)).toMatchObject({
            status: "in_progress", route: s.route, price_impact: "changes_price", amendment_contract_id: contractId,
          });
        } else {
          expect(await crRow(cr.id)).toMatchObject({ status: "new", route: null });
        }
        expect((await contractsOf(cr.id)).map((c) => c.id)).toEqual([contractId]);
      });
    }

    it("un-verifying back to `in_progress` is a work-starting transition too: refused when the amendment is no longer signed", async () => {
      const cr = await internalCr();
      const contractId = await changesPrice(cr.id);
      await signForReal(contractId);
      expect((await triage(cr.id, { action: "convert", route: "pm_task", priceImpact: "changes_price" })).statusCode).toBe(200);
      expect((await verify(cr.id)).statusCode).toBe(200);
      // Positive control FIRST: while the amendment is signed, un-verify works...
      const reopened = await app.inject({
        method: "POST", url: `/api/${co}/webdev/change-requests/${cr.id}/verify`, headers: asUser(admin),
        payload: { action: "unverify", reason: "regressed" },
      });
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect((await verify(cr.id)).statusCode).toBe(200);
      // ...then the amendment is voided and the same door shuts.
      const voided = await app.inject({ method: "PATCH", url: `/api/${co}/contracts/${contractId}`, headers: asUser(admin), payload: { status: "void" } });
      expect(voided.statusCode, voided.body).toBe(200);
      const blocked = await app.inject({
        method: "POST", url: `/api/${co}/webdev/change-requests/${cr.id}/verify`, headers: asUser(admin),
        payload: { action: "unverify", reason: "regressed again" },
      });
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(blocked.json()).toMatchObject({ error: "amendment_not_signed" });
      expect(await crRow(cr.id)).toMatchObject({ status: "verified" });
    });

    it("GRANDFATHERED: an `unassessed` request that was already past triage is not blocked by anything", async () => {
      const cr = await internalCr();
      // Past triage, as every row was before PV4: in_progress, route set, price_impact left at the default.
      await sql(`UPDATE webdev_change_requests SET status = 'in_progress', route = 'pm_task', triaged_by = $2, triaged_at = now() WHERE id = $1`, [cr.id, admin]);
      expect(await crRow(cr.id)).toMatchObject({ price_impact: "unassessed", amendment_contract_id: null });
      expect((await verify(cr.id)).statusCode).toBe(200);
      const reopened = await app.inject({
        method: "POST", url: `/api/${co}/webdev/change-requests/${cr.id}/verify`, headers: asUser(admin),
        payload: { action: "unverify", reason: "grandfathered rows keep working" },
      });
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(await crRow(cr.id)).toMatchObject({ status: "in_progress", price_impact: "unassessed" });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 4 · A declined / void amendment leaves the request blocked until staff re-triage
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("a dead amendment", () => {
    for (const dead of ["declined", "void"] as const) {
      it(`a ${dead} amendment keeps the request blocked; re-triage with changes_price makes a FRESH draft and re-points`, async () => {
        const cr = await internalCr();
        const first = await changesPrice(cr.id);
        await kill(first, dead);

        // Still blocked: a work route does not start (it makes the fresh amendment instead of a run/task).
        const again = await triage(cr.id, { action: "convert", route: "mini_run", priceImpact: "changes_price" });
        expect(again.statusCode, again.body).toBe(200);
        const second = (again.json() as { amendmentContractId: string; status: string; route: string | null });
        expect(second).toMatchObject({ status: "new", route: null });
        expect(second.amendmentContractId).not.toBe(first);

        const contracts = await contractsOf(cr.id);
        expect(contracts.map((c) => [c.id, c.status])).toEqual([[first, dead], [second.amendmentContractId, "draft"]]);
        expect(contracts.filter((c) => c.status === "draft")).toHaveLength(1); // exactly one live draft
        expect(await crRow(cr.id)).toMatchObject({ status: "new", amendment_contract_id: second.amendmentContractId, pipeline_run_id: null });
      });
    }

    it("`none` over a LIVE amendment is refused (409 `amendment_exists`); over a dead one it is allowed and clears the link", async () => {
      const cr = await internalCr();
      const first = await changesPrice(cr.id);
      const live = await triage(cr.id, { action: "convert", route: "pm_task", priceImpact: "none" });
      expect(live.statusCode, live.body).toBe(409);
      expect(live.json()).toMatchObject({ error: "amendment_exists", existing: { amendmentContractId: first } });
      expect(await crRow(cr.id)).toMatchObject({ status: "new", price_impact: "changes_price", amendment_contract_id: first });

      await kill(first, "void");
      const dead = await triage(cr.id, { action: "convert", route: "pm_task", priceImpact: "none" });
      expect(dead.statusCode, dead.body).toBe(200);
      expect(await crRow(cr.id)).toMatchObject({ status: "in_progress", route: "pm_task", price_impact: "none", amendment_contract_id: null });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 5 · The contract.signed handler tells the triager
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the contract.signed handler", () => {
    /** The REAL outbox row the countersign route wrote, shaped as the consumer would hand it over. */
    async function signedEventFor(contractId: string): Promise<OutboxEvent> {
      const r = await sql<{ id: string; payload: Record<string, unknown>; origin_site: string; created_at: Date }>(
        `SELECT id, payload, origin_site, created_at FROM outbox_events
          WHERE tenant_id = $1 AND entity_type = 'contract' AND entity_id = $2 AND event_type = 'contract.signed'`,
        [co, contractId],
      );
      expect(r.rows, "the countersign must have emitted exactly one contract.signed").toHaveLength(1);
      return {
        id: r.rows[0].id, tenantId: co, entityType: "contract", entityId: contractId, eventType: "contract.signed",
        payload: r.rows[0].payload, originSite: r.rows[0].origin_site, schemaVersion: 1, createdAt: r.rows[0].created_at.toISOString(),
      };
    }
    const unblocked = async (userId: string, crId: string) =>
      (await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = $3 AND payload->>'entityId' = $4`,
        [co, userId, AMENDMENT_UNBLOCKED_TYPE, crId],
      )).rows;

    it("notifies the request's TRIAGER that it can start, once, and changes no status", async () => {
      const cr = await internalCr();
      const contractId = await changesPrice(cr.id);
      // Not signed yet: a (spurious) event does nothing.
      const early: OutboxEvent = {
        id: newId(), tenantId: co, entityType: "contract", entityId: contractId, eventType: "contract.signed",
        payload: {}, originSite: config.originSite, schemaVersion: 1, createdAt: new Date().toISOString(),
      };
      await amendmentSignedHandler(early);
      expect(await unblocked(admin, cr.id)).toHaveLength(0);

      await signForReal(contractId);
      const event = await signedEventFor(contractId);
      await amendmentSignedHandler(event);
      const rows = await unblocked(admin, cr.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        title: expect.stringContaining("can start"), body: cr.title, entityType: "webdev_change_request", entityId: cr.id,
        href: `/departments/web-dev/requests?request=${cr.id}`,
      });
      // The handler only INFORMS: the request is exactly as triage left it.
      expect(await crRow(cr.id)).toMatchObject({ status: "new", route: null, pipeline_run_id: null, price_impact: "changes_price" });

      // At-least-once delivery: a redelivery must not notify twice.
      await amendmentSignedHandler(event);
      expect(await unblocked(admin, cr.id)).toHaveLength(1);
    });

    it("a signed contract no request waits on is a quiet no-op (and never throws, which would redeliver forever)", async () => {
      const before = (await sql(`SELECT count(*)::int AS n FROM notifications WHERE type = $1`, [AMENDMENT_UNBLOCKED_TYPE])).rows[0].n;
      const event: OutboxEvent = {
        id: newId(), tenantId: co, entityType: "contract", entityId: masterB, eventType: "contract.signed",
        payload: {}, originSite: config.originSite, schemaVersion: 1, createdAt: new Date().toISOString(),
      };
      await expect(amendmentSignedHandler(event)).resolves.toBeUndefined();
      expect((await sql(`SELECT count(*)::int AS n FROM notifications WHERE type = $1`, [AMENDMENT_UNBLOCKED_TYPE])).rows[0].n).toBe(before);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 6 · Contract create: kind / amendsId / changeRequestId (route + tool parity)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("POST /contracts with kind, amendsId and changeRequestId", () => {
    const create = (payload: Record<string, unknown>, actor = admin) =>
      app.inject({ method: "POST", url: `/api/${co}/contracts`, headers: asUser(actor), payload: { clientId: clientA, title: "Draft", ...payload } });

    it("the default is an `agreement`; an amendment REQUIRES a signed `amendsId` of the same client", async () => {
      const plain = await create({});
      expect(plain.statusCode, plain.body).toBe(201);
      expect((await sql(`SELECT kind, amends_id FROM contracts WHERE id = $1`, [plain.json().id])).rows[0]).toMatchObject({ kind: "agreement", amends_id: null });

      const noTarget = await create({ kind: "amendment" });
      expect(noTarget.statusCode).toBe(400);
      expect(noTarget.json()).toMatchObject({ error: "amends_id_required" });
      const agreementWithTarget = await create({ amendsId: masterA });
      expect(agreementWithTarget.statusCode).toBe(400);
      expect(agreementWithTarget.json()).toMatchObject({ error: "amends_id_requires_amendment" });
      const badKind = await create({ kind: "renewal" });
      expect(badKind.statusCode).toBe(400);
      expect(badKind.json()).toMatchObject({ error: "kind_invalid" });
      for (const amendsId of [masterB, newId()]) {
        const r = await create({ kind: "amendment", amendsId });
        expect(r.statusCode, r.body).toBe(400);
        expect(r.json()).toMatchObject({ error: "amends_id_invalid" });
      }

      const ok = await create({ kind: "amendment", amendsId: masterA, bodyMd: "Terms." });
      expect(ok.statusCode, ok.body).toBe(201);
      expect((await sql(`SELECT kind, amends_id, supersedes_id, status FROM contracts WHERE id = $1`, [ok.json().id])).rows[0])
        .toMatchObject({ kind: "amendment", amends_id: masterA, supersedes_id: null, status: "draft" });
      expect(await statusOf(masterA)).toBe("signed"); // the amended contract is untouched
    });

    it("🔴 authorization runs before validation: a caller who may not create gets 403 for a malformed body", async () => {
      const r = await create({ kind: "renewal", amendsId: "nope" }, plainMember);
      expect(r.statusCode, r.body).toBe(403);
    });

    it("`changeRequestId` re-points a request whose amendment is DEAD, and refuses to swap a live one", async () => {
      const cr = await internalCr();
      const first = await changesPrice(cr.id);

      // The request is waiting on a LIVE draft: a second draft may not take its place.
      const live = await create({ kind: "amendment", amendsId: sowX, changeRequestId: cr.id, reference: "PV404-RE-1" });
      expect(live.statusCode, live.body).toBe(409);
      expect(live.json()).toMatchObject({ error: "change_request_already_linked", existing: { amendmentContractId: first } });
      expect((await sql(`SELECT count(*)::int AS n FROM contracts WHERE reference = 'PV404-RE-1'`)).rows[0].n).toBe(0); // rolled back
      expect((await crRow(cr.id)).amendment_contract_id).toBe(first);

      // Declined: the request is blocked and may be re-pointed by drafting the re-issue.
      await kill(first, "declined");
      const fresh = await create({ kind: "amendment", amendsId: sowX, changeRequestId: cr.id, reference: "PV404-RE-2" });
      expect(fresh.statusCode, fresh.body).toBe(201);
      expect((await crRow(cr.id)).amendment_contract_id).toBe(fresh.json().id);
      // Replaying the same reference is the idempotent no-op it always was: no 409, no second row.
      const replay = await create({ kind: "amendment", amendsId: sowX, changeRequestId: cr.id, reference: "PV404-RE-2" });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toMatchObject({ id: fresh.json().id, deduped: true });
    });

    it("`changeRequestId` must be a request of the SAME client that is already `changes_price` (one code for 'not found' and 'not yours')", async () => {
      const cr = await internalCr();
      const unassessed = await create({ kind: "amendment", amendsId: masterA, changeRequestId: cr.id });
      expect(unassessed.statusCode, unassessed.body).toBe(400);
      expect(unassessed.json()).toMatchObject({ error: "change_request_not_price_changing" });

      for (const changeRequestId of [newId(), "nope"]) {
        const r = await create({ kind: "amendment", amendsId: masterA, changeRequestId });
        expect(r.statusCode, r.body).toBe(400);
        expect(r.json()).toMatchObject({ error: "change_request_invalid" });
      }
      // clientB drafting against clientA's request is the same answer as an unknown id.
      const cross = await create({ clientId: clientB, kind: "amendment", amendsId: masterB, changeRequestId: cr.id });
      expect(cross.statusCode, cross.body).toBe(400);
      expect(cross.json()).toMatchObject({ error: "change_request_invalid" });
      expect(await crRow(cr.id)).toMatchObject({ price_impact: "unassessed", amendment_contract_id: null });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 7 · Reads
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("reads", () => {
    it("staff change-request rows (list and detail) carry priceImpact, amendmentContractId and amendmentStatus", async () => {
      const waiting = await internalCr();
      const contractId = await changesPrice(waiting.id);
      const plain = await internalCr();
      await triage(plain.id, { action: "convert", route: "pm_task", priceImpact: "none" });

      const detail = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests/${waiting.id}`, headers: asUser(admin) });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ priceImpact: "changes_price", amendmentContractId: contractId, amendmentStatus: "draft" });

      const list = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests?clientId=${clientA}`, headers: asUser(admin) });
      expect(list.statusCode, list.body).toBe(200);
      const rows = list.json() as Array<{ id: string; priceImpact: string; amendmentContractId: string | null; amendmentStatus: string | null }>;
      expect(rows.find((r) => r.id === waiting.id)).toMatchObject({ priceImpact: "changes_price", amendmentContractId: contractId, amendmentStatus: "draft" });
      expect(rows.find((r) => r.id === plain.id)).toMatchObject({ priceImpact: "none", amendmentContractId: null, amendmentStatus: null });
    });

    it("staff contract rows (list and detail) carry kind, amendsId, amendsReference and changeRequestId", async () => {
      const cr = await internalCr();
      const contractId = await changesPrice(cr.id);
      const detail = await app.inject({ method: "GET", url: `/api/${co}/contracts/${contractId}`, headers: asUser(admin) });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        id: contractId, kind: "amendment", amendsId: sowX, amendsReference: "PV404-SOW-X", changeRequestId: cr.id, status: "draft", supersedesId: null,
      });
      const list = await app.inject({ method: "GET", url: `/api/${co}/contracts?clientId=${clientA}`, headers: asUser(admin) });
      expect(list.statusCode, list.body).toBe(200);
      const rows = list.json() as Array<Record<string, unknown>>;
      expect(rows.find((r) => r.id === contractId)).toMatchObject({ kind: "amendment", amendsId: sowX, amendsReference: "PV404-SOW-X", changeRequestId: cr.id });
      expect(rows.find((r) => r.id === sowX)).toMatchObject({ kind: "agreement", amendsId: null, amendsReference: null, changeRequestId: null });
    });

    it("the PORTAL contract detail shows kind/amendsReference for an amendment, and its change-request read shows priceImpact", async () => {
      const cr = await portalCr(); // raised by the signer; client-wide, so the default target is the master
      const contractId = await changesPrice(cr.id);

      // While a DRAFT the portal sees no contract, and the request's amendmentContractId stays null
      // (the id of a draft the agency has not issued is not disclosed), but the price impact shows.
      const draftDetail = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${contractId}`, headers: asUser(signerC) });
      expect(draftDetail.statusCode).toBe(404);
      const whileDraft = await app.inject({ method: "GET", url: `/api/${co}/portal/change-requests/${cr.id}`, headers: asUser(signerC) });
      expect(whileDraft.statusCode, whileDraft.body).toBe(200);
      expect(whileDraft.json()).toMatchObject({ id: cr.id, priceImpact: "changes_price", amendmentContractId: null, status: "new" });

      await app.inject({ method: "PATCH", url: `/api/${co}/contracts/${contractId}`, headers: asUser(admin), payload: { bodyMd: "The price change." } });
      expect((await app.inject({ method: "POST", url: `/api/${co}/contracts/${contractId}/send`, headers: asUser(admin) })).statusCode).toBe(200);

      const detail = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${contractId}`, headers: asUser(signerC) });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        id: contractId, kind: "amendment", amendsId: masterA, amendsReference: "PV404-MSA-A", changeRequestId: cr.id,
      });
      const list = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts`, headers: asUser(signerC) });
      expect((list.json() as Array<Record<string, unknown>>).find((r) => r.id === contractId))
        .toMatchObject({ kind: "amendment", amendsId: masterA, amendsReference: "PV404-MSA-A", changeRequestId: cr.id });
      expect((list.json() as Array<Record<string, unknown>>).find((r) => r.id === masterA)).toMatchObject({ kind: "agreement", amendsId: null });

      const reqDetail = await app.inject({ method: "GET", url: `/api/${co}/portal/change-requests/${cr.id}`, headers: asUser(signerC) });
      expect(reqDetail.json()).toMatchObject({ priceImpact: "changes_price", amendmentContractId: contractId });
      const reqList = await app.inject({ method: "GET", url: `/api/${co}/portal/change-requests`, headers: asUser(signerC) });
      expect((reqList.json() as Array<Record<string, unknown>>).find((r) => r.id === cr.id))
        .toMatchObject({ priceImpact: "changes_price", amendmentContractId: contractId });
    });

    it("🔴 a project-scoped contact never sees the id or reference of an amended contract outside their scope", async () => {
      // An amendment of projX's SOW, on projY: the project-scoped contact (projY only) can read the
      // amendment once it is sent, but the SOW it amends belongs to projX, outside their scope.
      const cr = await internalCr({ projectId: projY });
      const contractId = await changesPrice(cr.id, { amendsId: sowX });
      await app.inject({ method: "PATCH", url: `/api/${co}/contracts/${contractId}`, headers: asUser(admin), payload: { bodyMd: "Terms." } });
      expect((await app.inject({ method: "POST", url: `/api/${co}/contracts/${contractId}/send`, headers: asUser(admin) })).statusCode).toBe(200);

      const detail = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${contractId}`, headers: asUser(projectScoped) });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ kind: "amendment", amendsId: null, amendsReference: null });
      expect(detail.body).not.toContain(sowX);
      expect(detail.body).not.toContain("PV404-SOW-X");
    });
  });
});
