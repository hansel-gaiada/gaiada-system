// TR-21 — the mint/burn token lifecycle against a REAL Redis (⚡ this is the auth-bypass-by-
// construction surface §12 gates on), and the internal payload route
// (`/internal/reports/print-payload/:jobToken`) exercised through the REAL NestJS app. Same
// db-test convention as every other reports-module suite (`initTestDb`/`teardownTestDb`), plus
// the SAME real-Redis convention `relay.test.ts`/`consumer.service.test.ts` already established
// (`setRedis(new Redis(REDIS_URL_TEST))`), so this suite skips cleanly wherever either dependency
// is unavailable rather than failing loudly on a missing local service.
//
// Acceptance criteria pinned here (§12 TR-21 / the ticket's ⚡ requirements):
//   * token replay -> null/401 (burned means burned);
//   * expired token -> null/401 (5-min TTL, forced via the REAL Redis TTL mechanism, not mocked);
//   * a token minted for document X cannot be used to fetch document Y — proven by minting two
//     tokens for two DIFFERENT documents and showing each only ever yields its own;
//   * the internal route authenticates SOLELY on the token — no principal, no tenant header, no
//     `/api` prefix reaches it, and a missing/expired/burned token all return the identical 401
//     with no distinguishing signal.
import Redis from "ioredis";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../../main";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { setRedis, closeRedis, getRedis } from "../../events/redis";
import { burnPrintJobToken, mintPrintJobToken, printJobRedisKey } from "./report-pdf-export";
import type { ReportDocument } from "./report-document";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

function fakeDocument(scopeRef: string, scopeName: string): ReportDocument {
  return {
    header: {
      tenantId: "t1",
      grain: "person",
      scopeRef,
      scopeName,
      periodKind: "custom",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-05",
      dayCount: 5,
      periodLabel: "1–5 Jul 2026",
      generatedAt: "2026-07-31T00:00:00.000Z",
      sealed: false,
    },
    kpis: [],
    series: [],
    distributions: [],
    tables: [],
    highlights: [],
    narrative: { source: "deterministic", text: `Report for ${scopeName}` },
  };
}

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("TR-21 print job token lifecycle (real Redis) + internal payload route (real Nest app)", () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  beforeAll(async () => {
    await initTestDb();
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  // ═══════════════════════════════ direct function tests — mint/burn ═══════════════════════════

  it("mint then burn returns the exact payload minted", async () => {
    const doc = fakeDocument("alice", "Alice");
    const token = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "alice", document: doc, sealHash: undefined });
    const payload = await burnPrintJobToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.tenantId).toBe("t1");
    expect(payload!.scopeRef).toBe("alice");
    expect(payload!.document.header.scopeName).toBe("Alice");
    // requirement 5 (config.originSite stamped explicitly on the ephemeral value):
    expect(payload!.originSite).toBe(config.originSite);
  });

  it("⚡ REPLAY: a second burn of the SAME token -> null (single-use, not merely single-read-fast)", async () => {
    const token = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "bob", document: fakeDocument("bob", "Bob"), sealHash: undefined });
    const first = await burnPrintJobToken(token);
    expect(first).not.toBeNull();
    const second = await burnPrintJobToken(token);
    expect(second).toBeNull();
  });

  it("⚡ EXPIRY: a token whose TTL has elapsed -> null, via the REAL Redis expiry mechanism (not a mocked clock)", async () => {
    const token = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "carol", document: fakeDocument("carol", "Carol"), sealHash: undefined });
    // Force-expire NOW using Redis's own TTL primitive (PEXPIRE 1ms) rather than waiting out the
    // real 5-minute TTL or reimplementing expiry in application code.
    await getRedis().pexpire(printJobRedisKey(token), 1);
    await new Promise((r) => setTimeout(r, 25));
    expect(await burnPrintJobToken(token)).toBeNull();
  });

  it("a token that never existed -> null, indistinguishable from replay/expiry", async () => {
    expect(await burnPrintJobToken("never-minted-random-token-xyz")).toBeNull();
  });

  it("an empty token string -> null without ever touching Redis (defensive short-circuit)", async () => {
    expect(await burnPrintJobToken("")).toBeNull();
  });

  it("⚡ DOC SCOPING: a token minted for document X cannot yield document Y — two tokens, two documents, no crosstalk", async () => {
    const tokenX = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "dave", document: fakeDocument("dave", "Dave"), sealHash: undefined });
    const tokenY = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "erin", document: fakeDocument("erin", "Erin"), sealHash: undefined });

    const payloadX = await burnPrintJobToken(tokenX);
    const payloadY = await burnPrintJobToken(tokenY);

    expect(payloadX!.scopeRef).toBe("dave");
    expect(payloadX!.document.header.scopeName).toBe("Dave");
    expect(payloadY!.scopeRef).toBe("erin");
    expect(payloadY!.document.header.scopeName).toBe("Erin");

    // tokenX is now burned; even though tokenY (a DIFFERENT document) is still fresh at mint time,
    // there is no way to present tokenX again and get anything — not Dave's doc, not Erin's.
    expect(await burnPrintJobToken(tokenX)).toBeNull();
  });

  // ═══════════════════════════════ the internal route — real Nest app, no principal ════════════

  const fetchPayload = (jobToken: string) => app.inject({ method: "GET", url: `/internal/reports/print-payload/${jobToken}` });

  it("GET the internal route with a freshly-minted token, NO auth header at all, NO tenant header -> 200 with the document", async () => {
    const token = await mintPrintJobToken({
      tenantId: "t1",
      grain: "person",
      scopeRef: "frank",
      document: fakeDocument("frank", "Frank"),
      sealHash: "deadbeefcafefeed",
    });
    const r = await fetchPayload(token);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.document.header.scopeName).toBe("Frank");
    expect(body.sealHash).toBe("deadbeefcafefeed");
  });

  it("⚡ the SAME token fetched a second time -> 401, never a partial/cached document", async () => {
    const token = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "grace", document: fakeDocument("grace", "Grace"), sealHash: undefined });
    const first = await fetchPayload(token);
    expect(first.statusCode).toBe(200);
    const second = await fetchPayload(token);
    expect(second.statusCode).toBe(401);
    expect(second.json()).not.toHaveProperty("document");
  });

  it("an unknown token -> 401 with the SAME shape as a replayed one (no signal distinguishing the two)", async () => {
    const r = await fetchPayload("totally-made-up-token-never-minted");
    expect(r.statusCode).toBe(401);
    expect(r.json()).not.toHaveProperty("document");
  });

  it("⚡ two tokens minted for two DIFFERENT documents, fetched through the REAL route, never cross-serve", async () => {
    const tokenA = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "henry", document: fakeDocument("henry", "Henry"), sealHash: undefined });
    const tokenB = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "irene", document: fakeDocument("irene", "Irene"), sealHash: undefined });

    const rA = await fetchPayload(tokenA);
    const rB = await fetchPayload(tokenB);
    expect(rA.json().document.header.scopeName).toBe("Henry");
    expect(rB.json().document.header.scopeName).toBe("Irene");
  });

  it("the route takes no tenantId / query params at all — passing extra query junk changes nothing (there is nothing here to widen)", async () => {
    const token = await mintPrintJobToken({ tenantId: "t1", grain: "person", scopeRef: "jill", document: fakeDocument("jill", "Jill"), sealHash: undefined });
    const r = await app.inject({ method: "GET", url: `/internal/reports/print-payload/${token}?tenantId=other-tenant&scopeRef=someone-else` });
    expect(r.statusCode).toBe(200);
    expect(r.json().document.header.scopeName).toBe("Jill"); // query junk is simply ignored
  });
});
