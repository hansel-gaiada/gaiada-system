// TR-21 — `POST .../export {format:'pdf'}` end to end against LIVE Postgres + real Cerbos + real
// Redis + a REAL HTTP sidecar stand-in (a genuine `node:http` server on a real socket, not a
// mocked `fetch`) that itself makes a REAL HTTP call back into this SAME running Nest app's real
// listening port to fetch-and-burn the payload — the actual network hop TR-19's real
// `report-renderer` container makes, exercised honestly without needing platform-ui's still-in-
// progress print route (TR-20) or Docker in THIS process. What the stand-in fakes, stated plainly:
// it is not Chromium and does not render HTML — it plays the two roles neither TR-19's sidecar
// (proven separately, live, with a real PDF, per the amendment log) nor TR-20's print route (not
// built yet) can play here: "fetch the url I was given" and "turn a JSON payload into bytes".
// Everything on OUR side of that boundary — mint-after-authorize, the sidecar call's headers/body,
// the internal route's token-only auth, burn-on-read, files-table persistence, re-authorized
// download — is exercised for real.
//
// Acceptance criteria pinned here:
//   * PDF bytes are stored via the EXISTING files plumbing and downloadable with NORMAL authz —
//     the same Cerbos check a document read/xlsx-export runs;
//   * ⚡ requirement 3 (mint AFTER authorizing, never before): a principal DENIED the document read
//     never causes a token to be minted — asserted directly against Redis, not just against the
//     HTTP status;
//   * the AD HOC / SEALED provenance mark "survives into the stored PDF's ... filename" (this
//     ticket's explicit escape hatch, since the sidecar's own headerTemplate is TR-19's file, not
//     touched here) — proven on both an unsealed and a sealed export;
//   * not-configured / sidecar-failure both surface as an honest 503, never a silent downgrade.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { setRedis, closeRedis, getRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RENDERER_TEST_TOKEN = "test-renderer-shared-token";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("TR-21 PDF export (real Postgres + Redis + Cerbos + a real HTTP sidecar stand-in)", () => {
  let app: NestFastifyApplication;
  let nestBaseUrl: string;
  let sidecar: Server;
  let sidecarUrl: string;
  let sidecarRequestsSeen: number;

  let co: string;
  let alice: string; // member, exports her OWN person-grain scope
  let bob: string; // member, NOT alice
  let admin: string; // company_admin
  let projectId: string;

  async function pmTask(id: string, dueDate: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site) VALUES ($1,$2,$3,'task',$4::date,60,'central')`, [id, co, projectId, dueDate]),
    );
  }
  async function ownerAssignee(taskId: string, userId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
         VALUES ($1,$2,$3,'owner','person',$4,$5,'central','2026-01-01'::date)`,
        [newId(), co, taskId, userId, userId],
      ),
    );
  }
  async function completedEvent(taskId: string, dateIso: string, actorUserId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,'central')`,
        [newId(), co, `ev-${newId()}`, actorUserId, taskId, `${dateIso}T10:00:00Z`],
      ),
    );
  }
  async function completeTaskOn(dateIso: string): Promise<void> {
    const taskId = newId();
    await pmTask(taskId, dateIso);
    await ownerAssignee(taskId, alice);
    await completedEvent(taskId, dateIso, alice);
  }

  const createExport = (body: Record<string, unknown>, as = admin) => app.inject({ method: "POST", url: `/api/${co}/reports/export`, headers: asUser(as), payload: body });
  const getStatus = (jobId: string, as = admin) => app.inject({ method: "GET", url: `/api/${co}/reports/exports/${jobId}`, headers: asUser(as) });
  const download = (jobId: string, as = admin) => app.inject({ method: "GET", url: `/api/${co}/reports/exports/${jobId}/download`, headers: asUser(as) });
  const getPeriods = (kind: string, from: string, to: string, as = admin) => app.inject({ method: "GET", url: `/api/${co}/reports/periods?kind=${kind}&from=${from}&to=${to}`, headers: asUser(as) });
  const seal = (id: string, as = admin) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/${id}/seal`, headers: asUser(as) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setRedis(new Redis(REDIS_TEST_URL));
    await syncMetricDefinitions();

    co = await createCompany("TR-21 Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr21.test");
    bob = await createUser("bob@tr21.test");
    admin = await createUser("admin@tr21.test");
    await addMembership(co, alice);
    await addMembership(co, bob);
    await addMembership(co, admin);
    const memberRole = await createRole("member");
    await grantRole(alice, memberRole, "company", co);
    await grantRole(bob, memberRole, "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    projectId = await createProject(co, "Website");
    for (let d = 1; d <= 5; d++) await completeTaskOn(`2026-07-0${d}`);

    app = await buildApp();
    // A REAL listening socket — the sidecar stand-in below reaches the internal route over an
    // actual TCP connection, not `app.inject`'s in-process short-circuit.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.getHttpServer().address() as AddressInfo;
    nestBaseUrl = `http://127.0.0.1:${addr.port}`;

    // The sidecar stand-in (see file header for exactly what it fakes and what it doesn't).
    sidecarRequestsSeen = 0;
    sidecar = createServer((req, res) => {
      sidecarRequestsSeen++;
      if (req.method !== "POST" || req.url !== "/render") {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${RENDERER_TEST_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const { url } = JSON.parse(raw) as { url: string };
        if (!url.startsWith(nestBaseUrl)) {
          res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "url origin not allowed" }));
          return;
        }
        // `url` is `{PLATFORM_UI_INTERNAL_URL}/print/reports/{jobToken}` — TR-20's print-route
        // PATH, per §6.3's contract (§6.3: the sidecar is handed that URL; the PRINT ROUTE is the
        // one that then server-fetches `/internal/reports/print-payload/:jobToken`). TR-20 is not
        // built (out of scope here, another seat's ticket), so this stand-in plays that one extra
        // hop itself — the real Chromium fetch (proven separately, live, by TR-19) and the real
        // print-route relay (TR-20's own job) are BOTH faked; the token-only auth + burn-on-read
        // on OUR side of the internal route is exercised for real, over a real socket.
        const jobToken = url.slice(url.lastIndexOf("/") + 1);
        const payloadUrl = `${nestBaseUrl}/internal/reports/print-payload/${jobToken}`;
        const payloadRes = await fetch(payloadUrl);
        if (!payloadRes.ok) {
          res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "payload fetch failed" }));
          return;
        }
        const payload = (await payloadRes.json()) as { document: { header: { scopeName: string } }; sealHash: string | null };
        const bytes = Buffer.from(`%PDF-fake\nscopeName=${payload.document.header.scopeName}\nsealHash=${payload.sealHash ?? ""}`);
        res.writeHead(200, { "content-type": "application/pdf" }).end(bytes);
      });
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    const sidecarAddr = sidecar.address() as AddressInfo;
    sidecarUrl = `http://127.0.0.1:${sidecarAddr.port}`;

    config.reportRenderer = { url: sidecarUrl, token: RENDERER_TEST_TOKEN, platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => sidecar.close(() => resolve()));
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  // ═══════════════════════════════ happy path — unsealed (custom range) ═══════════════════════

  it("POST /export {format:'pdf'} on a custom (unsealed) range -> {jobId}, via the REAL sidecar round trip", async () => {
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().jobId).toBe("string");
    expect(sidecarRequestsSeen).toBeGreaterThan(0);
  });

  it("GET status: contentType application/pdf, filename ends .pdf and carries the 'adhoc-unsealed' provenance tag", async () => {
    const created = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
    const jobId = created.json().jobId;
    const r = await getStatus(jobId);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.contentType).toBe("application/pdf");
    expect(body.filename).toMatch(/-adhoc-unsealed\.pdf$/);
  });

  it("download returns the REAL bytes the sidecar stand-in produced (proves the whole round trip, not a stub), downloadable via normal authz", async () => {
    const created = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
    const jobId = created.json().jobId;
    const r = await download(jobId);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toContain("attachment");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const text = r.rawPayload.toString("utf8");
    expect(text).toContain("%PDF-fake");
    expect(text).toContain("scopeName=alice"); // the document the sidecar fetched really was Alice's (createUser derives the display name from the email's local part)
  });

  // ═══════════════════════════════ ⚡ mint-after-authorize (requirement 3) ═══════════════════════

  it("⚡ a plain member DENIED the underlying document read (403) causes ZERO tokens to be minted — proven directly against Redis, not just the HTTP status", async () => {
    const before = await getRedis().keys("reports:printjob:*");
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" }, bob);
    expect(r.statusCode).toBe(403);
    const after = await getRedis().keys("reports:printjob:*");
    expect(after.length).toBe(before.length); // authz failed before mintPrintJobToken ever ran
  });

  it("a plain member CAN export their OWN person-grain scope as pdf (mirrors the xlsx/csv 'owns' tier)", async () => {
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" }, alice);
    expect(r.statusCode).toBe(200);
  });

  // ═══════════════════════════════ sealed-period provenance parity ═══════════════════════════

  it("a SEALED calendar-period pdf export carries the sealed provenance tag in its filename, matching the xlsx banner's own hash prefix", async () => {
    const list = (await getPeriods("month", "2026-07-01", "2026-07-01")).json().periods as Array<{ id: string }>;
    const julyId = list[0].id;
    const sealResult = await seal(julyId);
    expect(sealResult.statusCode).toBe(200);
    const sealHash = sealResult.json().sealHash as string;

    const exportResult = await createExport({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16", format: "pdf" });
    expect(exportResult.statusCode).toBe(200);
    const jobId = exportResult.json().jobId;

    const status = await getStatus(jobId);
    expect(status.json().filename).toMatch(new RegExp(`-sealed-rev0-${sealHash.slice(0, 8)}\\.pdf$`));

    const r = await download(jobId);
    expect(r.rawPayload.toString("utf8")).toContain(`sealHash=${sealHash}`);
  });

  // ═══════════════════════════════ not-configured / sidecar failure -> honest 503 ══════════════

  it("pdf export is not configured (missing token) -> 503, never a silent downgrade to another format", async () => {
    const saved = config.reportRenderer;
    config.reportRenderer = { ...saved, token: "" };
    try {
      const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toContain("not configured");
    } finally {
      config.reportRenderer = saved;
    }
  });

  it("a sidecar that refuses the request (wrong bearer, e.g. a stale RENDERER_TOKEN) -> 503, not a crash", async () => {
    const saved = config.reportRenderer;
    config.reportRenderer = { ...saved, token: "wrong-token" };
    try {
      const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toContain("pdf render failed");
    } finally {
      config.reportRenderer = saved;
    }
  });

  it("an unreachable sidecar host -> 503, not a hang or a crash", async () => {
    const saved = config.reportRenderer;
    config.reportRenderer = { ...saved, url: "http://127.0.0.1:1", timeoutMs: 500 };
    try {
      const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
      expect(r.statusCode).toBe(503);
    } finally {
      config.reportRenderer = saved;
    }
  });
});
