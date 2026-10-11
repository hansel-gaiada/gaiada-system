// M3 T5b — privacy.find, privacy.export and privacy.erase (all HIGH) claim their WS4 approval BEFORE
// any read or write, in one transaction with the effect, on the durable idempotency store.
//
// Real Postgres (webdesk_app, NOBYPASSRLS), real RustFS, the real PrivacyModule, the NODE_ENV=test
// control-channel and policy stubs. The stub PDP has no "approval already used" pre-check, so a
// concurrent reuse of one approval reaches the service exactly as two racing requests would with the
// real PDP.
//
// "The effect ran" is counted by the rows it creates (dsr_requests, the scrubbed submission), by
// calls to the storage seam (PrivacyAttachmentsService) and by a statement recorder on the pool.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildPrivacyTestApp, privacyHeaders } from "./privacy-test-app";
import {
  createFixtureTenant,
  insertFormDef,
  insertSubmission,
  putFixtureAttachment,
  withTenantRaw,
  type FixtureTenant,
} from "./privacy-fixtures";
import { DbService } from "../src/db/db.service";
import { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import { PrivacyAttachmentsService } from "../src/privacy/privacy-attachments.service";
import { PrivacyRepository } from "../src/privacy/privacy.repository";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
type Res = LightMyRequestResponse;

/** Records the text of every statement issued on a client checked out of the app's pool. */
function recordStatements(app: NestFastifyApplication) {
  const seen: string[] = [];
  const wrapped = new WeakSet<object>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = app.get(DbService).pool as any;
  const connect = pool.connect.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool.connect = async (...args: any[]) => {
    if (typeof args[0] === "function") return connect(...args);
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const query = client.query.bind(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.query = (...qa: any[]) => {
        const text = typeof qa[0] === "string" ? qa[0] : qa[0]?.text;
        if (text) seen.push(text);
        return query(...qa);
      };
    }
    return client;
  };
  return { reset: () => void (seen.length = 0), count: (re: RegExp) => seen.filter((t) => re.test(t)).length };
}

/** Makes `n` concurrent callers all finish their pre-envelope tenant lookup before any of them goes on. */
function holdLookups(app: NestFastifyApplication, n: number) {
  const lookups = app.get(TenantLookupService);
  const real = lookups.bySlug.bind(lookups);
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return vi.spyOn(lookups, "bySlug").mockImplementation(async (slug: string) => {
    const tenant = await real(slug);
    if (++arrived === n) open();
    if (arrived <= n) await gate;
    return tenant;
  });
}

function expectOneWinner(results: Res[], winStatus: number) {
  expect(results.map((r) => r.statusCode).sort()).toEqual([...Array(results.length - 1).fill(403), winStatus].sort());
  const won = results.filter((r) => r.statusCode === winStatus);
  for (const r of results.filter((x) => x.statusCode !== winStatus)) {
    expect(r.json().type).toBe(`${PROBLEM}ws4-approval-already-used`);
  }
  return won[0];
}

const url = (t: FixtureTenant, cmd: "find" | "export" | "erase") => `/control/v1/tenants/${t.slug}/privacy/${cmd}`;
const operateH = (ws4: string | undefined, idem?: string) => privacyHeaders({ scopes: ["webdesk:operate"], ws4, idempotencyKey: idem });
const promoteH = (ws4: string | undefined, idem?: string) => privacyHeaders({ scopes: ["webdesk:promote"], ws4, idempotencyKey: idem });

const approvalActions = (t: FixtureTenant, approval: string) =>
  withTenantRaw(t.tenantId, async (c) =>
    (await c.query(`SELECT action FROM audit_entries WHERE ws4_approval_id = $1 ORDER BY action`, [approval])).rows.map((r) => r.action as string),
  );
const dsrCount = (t: FixtureTenant, kind: string) =>
  withTenantRaw(t.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM dsr_requests WHERE tenant_id = $1 AND kind = $2`, [t.tenantId, kind])).rows[0].n as number);
const idemRows = (t: FixtureTenant, command: string) =>
  withTenantRaw(t.tenantId, async (c) =>
    (await c.query(`SELECT status, response::text AS body FROM control_idempotency_keys WHERE tenant_id = $1 AND command = $2`, [t.tenantId, command])).rows as {
      status: string;
      body: string;
    }[],
  );
const submissionStatus = (t: FixtureTenant, id: string) =>
  withTenantRaw(t.tenantId, async (c) => (await c.query(`SELECT status, data_subject_ref FROM submissions WHERE id = $1`, [id])).rows[0] as { status: string; data_subject_ref: string | null });

/** A tenant with one submission (and optionally one real attachment) for a fresh identifier. */
async function subject(label: string, withAttachment = false) {
  const tenant = await createFixtureTenant(label);
  const formDefId = await insertFormDef(tenant, "contact");
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const attachment = withAttachment ? await putFixtureAttachment(tenant, { filename: "note.txt", contentType: "text/plain", body: Buffer.from("personal bytes") }) : undefined;
  const submissionId = await insertSubmission(tenant, formDefId, {
    fields: { email, name: "Personal Name", message: "personal message" },
    attachments: attachment ? [attachment] : [],
    dataSubjectRef: email,
  });
  return { tenant, email, submissionId, attachment };
}

describe("M3 T5b — privacy.find / export / erase claim the WS4 approval first", () => {
  let app: NestFastifyApplication;
  let rec: ReturnType<typeof recordStatements>;

  beforeAll(async () => {
    app = await buildPrivacyTestApp();
    await app.getHttpAdapter().getInstance().ready();
    rec = recordStatements(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // Concurrency: ONE approval, ten racers
  // ==============================================================================================
  describe("concurrent reuse of one WS4 approval runs the command once", () => {
    it("privacy.erase: 10 parallel requests, one approval, different idempotency keys -> 1 erase, 1 storage delete, 1 dsr row, 9 x 403", async () => {
      const s = await subject("race-erase", true);
      const approval = randomUUID();
      const deleteSpy = vi.spyOn(app.get(PrivacyAttachmentsService), "deleteForErase");
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, randomUUID()), payload: { identifier: s.email } })),
        );
      } finally {
        hold.mockRestore();
      }
      const deletes = deleteSpy.mock.calls.length;
      deleteSpy.mockRestore();
      const winner = expectOneWinner(results, 201);
      expect(winner.json()).toMatchObject({ submissionCount: 1, attachmentCount: 1, replayed: false });
      expect(deletes).toBe(1); // the losers never touched storage
      expect(rec.count(/UPDATE submissions\s+SET status = 'erased'/)).toBe(1);
      expect(await dsrCount(s.tenant, "erase")).toBe(1);
      expect(await approvalActions(s.tenant, approval)).toEqual(["control.privacy.erase"]);
      expect((await idemRows(s.tenant, "privacy.erase")).map((r) => r.status)).toEqual(["completed"]); // the nine losing claims were released
    });

    it("privacy.export: 10 parallel requests, one approval -> 1 read, 1 dsr row, 1 attachment fetch, 9 x 403", async () => {
      const s = await subject("race-export", true);
      const approval = randomUUID();
      const fetchSpy = vi.spyOn(app.get(PrivacyAttachmentsService), "fetchForExport");
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(approval, randomUUID()), payload: { identifier: s.email } })),
        );
      } finally {
        hold.mockRestore();
      }
      const fetches = fetchSpy.mock.calls.length;
      fetchSpy.mockRestore();
      const winner = expectOneWinner(results, 201);
      expect(winner.json().submissions).toHaveLength(1);
      expect(winner.json().submissions[0].fields.email).toBe(s.email);
      expect(fetches).toBe(1);
      expect(rec.count(/FROM submissions/)).toBe(1); // the losers never read personal data
      expect(await dsrCount(s.tenant, "export")).toBe(1);
      expect(await approvalActions(s.tenant, approval)).toEqual(["control.privacy.export"]);
    });

    it("privacy.find: 10 parallel requests, one approval -> 1 read, 1 dsr row, 9 x 403", async () => {
      const s = await subject("race-find");
      const approval = randomUUID();
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(approval, randomUUID()), payload: { identifier: s.email } })),
        );
      } finally {
        hold.mockRestore();
      }
      const winner = expectOneWinner(results, 201);
      expect(winner.json().matches).toHaveLength(1);
      expect(rec.count(/FROM submissions/)).toBe(1);
      expect(await dsrCount(s.tenant, "find")).toBe(1);
      expect(await approvalActions(s.tenant, approval)).toEqual(["control.privacy.find"]);
    });
  });

  // ==============================================================================================
  // Replay
  // ==============================================================================================
  describe("replay", () => {
    it("privacy.export (response withheld: it IS the personal data): a replay is 409 idempotency-response-withheld, no second read, nothing personal stored", async () => {
      const s = await subject("replay-export", true);
      const approval = randomUUID();
      const idem = randomUUID();
      const fetchSpy = vi.spyOn(app.get(PrivacyAttachmentsService), "fetchForExport");
      rec.reset();
      const first = await app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(approval, idem), payload: { identifier: s.email } });
      const second = await app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(approval, idem), payload: { identifier: s.email } });
      const fetches = fetchSpy.mock.calls.length;
      fetchSpy.mockRestore();
      expect(first.statusCode).toBe(201);
      expect(first.json().submissions[0].fields.message).toBe("personal message");
      expect(second.statusCode).toBe(409);
      expect(second.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      for (const needle of [s.email, "Personal Name", "personal message"]) expect(second.body).not.toContain(needle);
      expect(fetches).toBe(1);
      expect(rec.count(/FROM submissions/)).toBe(1);
      expect(await dsrCount(s.tenant, "export")).toBe(1);
      expect(await approvalActions(s.tenant, approval)).toEqual(["control.privacy.export"]); // no .replay row: nothing was served

      const stored = await idemRows(s.tenant, "privacy.export");
      expect(stored).toHaveLength(1);
      for (const needle of [s.email, "Personal Name", "personal message", "personal bytes", Buffer.from("personal bytes").toString("base64")]) {
        expect(stored[0].body).not.toContain(needle);
      }
      expect(Object.keys(JSON.parse(stored[0].body)).sort()).toEqual(["dsrRequestId", "secretWithheld", "submissionCount"]);
    });

    it("privacy.find (response withheld: it lists an identified person's submissions): a replay is 409 withheld; only the ledger reference is stored", async () => {
      const s = await subject("replay-find");
      const approval = randomUUID();
      const idem = randomUUID();
      const first = await app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(approval, idem), payload: { identifier: s.email } });
      const second = await app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(approval, idem), payload: { identifier: s.email } });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(409);
      expect(second.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      expect(await dsrCount(s.tenant, "find")).toBe(1);
      const stored = await idemRows(s.tenant, "privacy.find");
      expect(stored[0].body).not.toContain(s.submissionId);
      expect(stored[0].body).not.toContain(s.email);
      expect(Object.keys(JSON.parse(stored[0].body)).sort()).toEqual(["dsrRequestId", "matchCount", "secretWithheld"]);
    });

    it("find and export without an Idempotency-Key are each a distinct access: two calls, two reads, two dsr rows (as before)", async () => {
      const s = await subject("nokey");
      for (const cmd of ["find", "export"] as const) {
        const a = await app.inject({ method: "POST", url: url(s.tenant, cmd), headers: operateH(randomUUID()), payload: { identifier: s.email } });
        const b = await app.inject({ method: "POST", url: url(s.tenant, cmd), headers: operateH(randomUUID()), payload: { identifier: s.email } });
        expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
        expect(await dsrCount(s.tenant, cmd)).toBe(2);
      }
    });

    it("privacy.erase (a count summary, stored): a replay returns the same summary with replayed:true, one erase, one .replay audit row, no identifier stored", async () => {
      const s = await subject("replay-erase", true);
      const approval = randomUUID();
      const idem = randomUUID();
      const deleteSpy = vi.spyOn(app.get(PrivacyAttachmentsService), "deleteForErase");
      const first = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, idem), payload: { identifier: s.email } });
      const second = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, idem), payload: { identifier: s.email } });
      const deletes = deleteSpy.mock.calls.length;
      deleteSpy.mockRestore();
      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      expect(first.json().replayed).toBe(false);
      expect(second.json().replayed).toBe(true);
      const { replayed: _a, ...b1 } = first.json();
      const { replayed: _b, ...b2 } = second.json();
      expect(b2).toEqual(b1);
      expect(b1).toMatchObject({ tenantSlug: s.tenant.slug, identifier: s.email, submissionCount: 1, attachmentCount: 1 });
      expect(deletes).toBe(1);
      expect(await dsrCount(s.tenant, "erase")).toBe(1);
      expect(await approvalActions(s.tenant, approval)).toEqual(["control.privacy.erase", "control.privacy.erase.replay"]);
      const stored = await idemRows(s.tenant, "privacy.erase");
      expect(stored[0].body).not.toContain(s.email);
      expect(Object.keys(JSON.parse(stored[0].body)).sort()).toEqual(["attachmentCount", "dsrRequestId", "erasedAt", "submissionCount"]);
    });
  });

  // ==============================================================================================
  // Durability
  // ==============================================================================================
  it("a replay still works after the app is stopped and a fresh app is started on the same database", async () => {
    const a = await subject("durable");
    const eraseApproval = randomUUID();
    const eraseIdem = randomUUID();
    const exportApproval = randomUUID();
    const exportIdem = randomUUID();
    const s2 = await subject("durable2");
    const appA = await buildPrivacyTestApp();
    await appA.getHttpAdapter().getInstance().ready();
    const e1 = await appA.inject({ method: "POST", url: url(a.tenant, "erase"), headers: promoteH(eraseApproval, eraseIdem), payload: { identifier: a.email } });
    const x1 = await appA.inject({ method: "POST", url: url(s2.tenant, "export"), headers: operateH(exportApproval, exportIdem), payload: { identifier: s2.email } });
    expect([e1.statusCode, x1.statusCode]).toEqual([201, 201]);
    await appA.close(); // the first process is gone

    const appB = await buildPrivacyTestApp();
    await appB.getHttpAdapter().getInstance().ready();
    try {
      const recB = recordStatements(appB);
      const e2 = await appB.inject({ method: "POST", url: url(a.tenant, "erase"), headers: promoteH(eraseApproval, eraseIdem), payload: { identifier: a.email } });
      const x2 = await appB.inject({ method: "POST", url: url(s2.tenant, "export"), headers: operateH(exportApproval, exportIdem), payload: { identifier: s2.email } });
      expect(e2.statusCode).toBe(201);
      expect(e2.json().replayed).toBe(true);
      expect(e2.json().dsrRequestId).toBe(e1.json().dsrRequestId);
      expect(x2.statusCode).toBe(409);
      expect(x2.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      expect(recB.count(/FROM submissions/)).toBe(0);
      expect(recB.count(/INSERT INTO dsr_requests/)).toBe(0);
      expect(await dsrCount(a.tenant, "erase")).toBe(1);
      expect(await dsrCount(s2.tenant, "export")).toBe(1);
    } finally {
      await appB.close();
    }
  });

  // ==============================================================================================
  // Failure: the effect shares the claim's transaction, so nothing commits and the approval is free
  // ==============================================================================================
  describe("a failure after the audit row rolls everything back and frees the key and the approval", () => {
    it("privacy.erase: the scrub throws -> submission untouched, no audit row, no dsr row, no idempotency row; the retry with the same approval and key succeeds", async () => {
      const s = await subject("fail-erase");
      const approval = randomUUID();
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(PrivacyRepository), "eraseSubmissions").mockRejectedValueOnce(new Error("injected failure after the audit row"));
      rec.reset();
      let bad: Res;
      try {
        bad = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, idem), payload: { identifier: s.email } });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      expect(rec.count(/INSERT INTO audit_entries/)).toBe(1); // the claim WAS written first ...
      expect(await approvalActions(s.tenant, approval)).toEqual([]); // ... and rolled back
      expect(await submissionStatus(s.tenant, s.submissionId)).toEqual({ status: "received", data_subject_ref: s.email });
      expect(await dsrCount(s.tenant, "erase")).toBe(0);
      expect(await idemRows(s.tenant, "privacy.erase")).toEqual([]);

      const retry = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, idem), payload: { identifier: s.email } });
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toMatchObject({ submissionCount: 1, replayed: false });
      expect(await submissionStatus(s.tenant, s.submissionId)).toEqual({ status: "erased", data_subject_ref: null });
    });

    it("privacy.erase: a storage delete fails -> 503, no row touched, the approval is free, the retry succeeds", async () => {
      const s = await subject("fail-storage", true);
      const approval = randomUUID();
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(PrivacyAttachmentsService), "deleteForErase").mockRejectedValueOnce(new Error("injected storage failure"));
      let bad: Res;
      try {
        bad = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, idem), payload: { identifier: s.email } });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(503);
      expect(await submissionStatus(s.tenant, s.submissionId)).toEqual({ status: "received", data_subject_ref: s.email });
      expect(await approvalActions(s.tenant, approval)).toEqual([]);
      expect(await dsrCount(s.tenant, "erase")).toBe(0);
      expect(await idemRows(s.tenant, "privacy.erase")).toEqual([]);
      const retry = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(approval, idem), payload: { identifier: s.email } });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().attachmentCount).toBe(1);
    });

    it("privacy.export: the read throws -> no audit row, no dsr row, no idempotency row; the retry with the same approval succeeds", async () => {
      const s = await subject("fail-export");
      const approval = randomUUID();
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(PrivacyRepository), "findByIdentifier").mockRejectedValueOnce(new Error("injected failure after the audit row"));
      let bad: Res;
      try {
        bad = await app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(approval, idem), payload: { identifier: s.email } });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      expect(await approvalActions(s.tenant, approval)).toEqual([]);
      expect(await dsrCount(s.tenant, "export")).toBe(0);
      expect(await idemRows(s.tenant, "privacy.export")).toEqual([]);
      const retry = await app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(approval, idem), payload: { identifier: s.email } });
      expect(retry.statusCode).toBe(201);
    });
  });

  // ==============================================================================================
  // Refusals before the envelope claim nothing and audit nothing
  // ==============================================================================================
  it("pre-envelope refusals (unknown tenant, bad identifier, bad or missing key, no WS4) write no audit row, no dsr row and claim no idempotency key", async () => {
    const s = await subject("refuse");
    const ghost = { ...s.tenant, slug: `nope-${randomUUID().slice(0, 8)}` };
    const cases: { name: string; status: number; send: () => Promise<Res> }[] = [
      { name: "find unknown tenant", status: 404, send: () => app.inject({ method: "POST", url: url(ghost, "find"), headers: operateH(randomUUID()), payload: { identifier: s.email } }) },
      { name: "export unknown tenant", status: 404, send: () => app.inject({ method: "POST", url: url(ghost, "export"), headers: operateH(randomUUID()), payload: { identifier: s.email } }) },
      { name: "erase unknown tenant", status: 404, send: () => app.inject({ method: "POST", url: url(ghost, "erase"), headers: promoteH(randomUUID(), randomUUID()), payload: { identifier: s.email } }) },
      { name: "find empty identifier", status: 400, send: () => app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(randomUUID()), payload: { identifier: "   " } }) },
      { name: "export missing identifier", status: 400, send: () => app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(randomUUID()), payload: {} }) },
      { name: "erase empty identifier", status: 400, send: () => app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(randomUUID(), randomUUID()), payload: { identifier: "" } }) },
      { name: "erase no Idempotency-Key", status: 400, send: () => app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(randomUUID()), payload: { identifier: s.email } }) },
      { name: "find too-short Idempotency-Key", status: 400, send: () => app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(randomUUID(), "x"), payload: { identifier: s.email } }) },
      { name: "find no WS4 approval", status: 403, send: () => app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(undefined), payload: { identifier: s.email } }) },
      { name: "export no WS4 approval", status: 403, send: () => app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(undefined), payload: { identifier: s.email } }) },
      { name: "erase no WS4 approval", status: 403, send: () => app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(undefined, randomUUID()), payload: { identifier: s.email } }) },
    ];
    for (const c of cases) {
      rec.reset();
      const res = await c.send();
      expect(res.statusCode, c.name).toBe(c.status);
      expect(rec.count(/INSERT INTO audit_entries/), `${c.name}: audit rows`).toBe(0);
      expect(rec.count(/INSERT INTO control_idempotency_keys/), `${c.name}: idempotency claims`).toBe(0);
      expect(rec.count(/INSERT INTO dsr_requests/), `${c.name}: dsr rows`).toBe(0);
    }
  });

  // ==============================================================================================
  // The public contract: today's bodies, exactly
  // ==============================================================================================
  it("response bodies keep their exact shape (find and export carry no `replayed`; erase does)", async () => {
    const s = await subject("shape");
    const find = await app.inject({ method: "POST", url: url(s.tenant, "find"), headers: operateH(randomUUID()), payload: { identifier: s.email } });
    expect(find.statusCode).toBe(201);
    expect(Object.keys(find.json())).toEqual(["tenantSlug", "identifier", "generatedAt", "dsrRequestId", "matches"]);
    const exp = await app.inject({ method: "POST", url: url(s.tenant, "export"), headers: operateH(randomUUID()), payload: { identifier: s.email } });
    expect(exp.statusCode).toBe(201);
    expect(Object.keys(exp.json())).toEqual(["tenantSlug", "identifier", "generatedAt", "dsrRequestId", "submissions"]);
    const erase = await app.inject({ method: "POST", url: url(s.tenant, "erase"), headers: promoteH(randomUUID(), randomUUID()), payload: { identifier: s.email } });
    expect(erase.statusCode).toBe(201);
    expect(Object.keys(erase.json())).toEqual(["erasedAt", "dsrRequestId", "submissionCount", "attachmentCount", "tenantSlug", "identifier", "replayed"]);
  });
});
