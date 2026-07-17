// Knowledge source review proxy (§7) — the platform authorizes then proxies the write to the
// knowledge service (stubbed here). Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("knowledge review proxy (§7)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let lastBody: unknown;
  let tenant: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency"]);
    admin = await createUser("admin@a.test");
    member = await createUser("mem@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, member);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);

    const { server, base } = await new Promise<{ server: Server; base: string }>((resolve) => {
      const s = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          if (/\/sources\/.*\/review$/.test(req.url ?? "") && req.method === "POST") {
            lastBody = JSON.parse(raw || "{}");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, updated: 3 }));
          } else {
            res.writeHead(404);
            res.end("{}");
          }
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
    });
    stub = server;
    config.services.knowledge = { url: base, token: "k-token" };
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
    await teardownTestDb();
  });

  it("admin review proxies decision to the knowledge service", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/knowledge/sources/${encodeURIComponent("drive://folder/doc")}/review`,
      headers: asUser(admin), payload: { decision: "approved" },
    });
    expect(r.statusCode).toBe(200);
    expect(lastBody).toMatchObject({ tenantId: tenant, decision: "approved" });
  });

  it("invalid decision → 400; non-admin → 403", async () => {
    expect((await app.inject({ method: "POST", url: `/api/${tenant}/knowledge/sources/x/review`, headers: asUser(admin), payload: { decision: "maybe" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/${tenant}/knowledge/sources/x/review`, headers: asUser(member), payload: { decision: "approved" } })).statusCode).toBe(403);
  });

  it("unconfigured knowledge service → 404 (UI degrades to 'pending')", async () => {
    const prev = config.services.knowledge;
    config.services.knowledge = { url: "", token: "" };
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/knowledge/sources/x/review`, headers: asUser(admin), payload: { decision: "rejected" } });
    expect(r.statusCode).toBe(404);
    config.services.knowledge = prev;
  });
});
