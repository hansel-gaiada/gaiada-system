// AIP-03b — the door of POST /api/internal/ai-usage, with NO database: an isolated Nest app holding only this controller (the posture
// console-reads-http.test.ts documents). Everything asserted here is decided BEFORE any query: the service-token guard and the 1..100 bound.
// The accepted/rejected behaviour over real Postgres is ingest.http.test.ts (needs DATABASE_URL_TEST).
//
// Proves: no token, a wrong token, a user-session credential (a JWT-shaped bearer, a cookie, an x-user-id with no service token) and an
// unset service token are each 401; and a missing, empty, oversized or non-array `events` is 400 once the token is right.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { AiUsageIngestController } from "./ingest.controller";

const TOKEN = "aip03b-test-service-token";
const URL = "/api/internal/ai-usage";
const event = { tenantId: "11111111-1111-4111-8111-111111111111", surface: "agent", capability: "llm", tokensSource: "none", outcome: "ok" };

describe("AIP-03b · POST /api/internal/ai-usage · guard and bounds (no database)", () => {
  let app: NestFastifyApplication;
  const saved = config.serviceToken;

  beforeAll(async () => {
    config.serviceToken = TOKEN;
    const moduleRef = await Test.createTestingModule({ controllers: [AiUsageIngestController] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    config.serviceToken = saved;
    await app.close();
  });

  const post = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: URL, headers, payload: payload as object });
  const good = { authorization: `Bearer ${TOKEN}` };

  it("refuses a call with no token", async () => {
    const r = await post({}, { events: [event] });
    expect(r.statusCode).toBe(401);
  });

  it("refuses a wrong token, including one of the right length", async () => {
    expect((await post({ authorization: "Bearer not-the-token" }, { events: [event] })).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${"x".repeat(TOKEN.length)}` }, { events: [event] })).statusCode).toBe(401);
    expect((await post({ authorization: TOKEN }, { events: [event] })).statusCode).toBe(401);
  });

  it("refuses a user session: a JWT-shaped bearer, a session cookie, a user id with no service token", async () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln";
    expect((await post({ authorization: `Bearer ${jwt}` }, { events: [event] })).statusCode).toBe(401);
    expect((await post({ cookie: "session=abc123", "x-user-id": "22222222-2222-4222-8222-222222222222" }, { events: [event] })).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${jwt}`, "x-user-id": "22222222-2222-4222-8222-222222222222" }, { events: [event] })).statusCode).toBe(401);
  });

  it("an unset service token refuses everyone, even a caller presenting an empty bearer", async () => {
    config.serviceToken = "";
    try {
      expect((await post({ authorization: "Bearer " }, { events: [event] })).statusCode).toBe(401);
      expect((await post(good, { events: [event] })).statusCode).toBe(401);
    } finally {
      config.serviceToken = TOKEN;
    }
  });

  it("is 400 for a missing, empty, non-array or oversized events list (the token being right)", async () => {
    for (const body of [{}, { events: [] }, { events: "nope" }, { events: { 0: event } }, { events: Array.from({ length: 101 }, () => event) }]) {
      const r = await post(good, body);
      expect(r.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(r.json().error).toMatch(/1 to 100/);
    }
    expect((await post(good, undefined)).statusCode).toBe(400);
  });

  it("checks the guard before the body: a bad body without a token is 401, not 400", async () => {
    expect((await post({}, { events: [] })).statusCode).toBe(401);
  });
});
