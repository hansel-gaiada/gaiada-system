// WSK M3 T1 — four defects on the public /v1 read path:
//   D2  path segments are percent-decoded exactly once (non-ASCII slugs are reachable)
//   D3  a bad pagination cursor is a 400 (not a 500 carrying Postgres's message), and no 500 carries
//       the thrown error's message
//   D4  an undecodable `%` in the path is problem+json (not Fastify's default 400 body)
// (D1, the reserved collection keys, is reserved-collection-keys.spec.ts + schema-reserved-keys.spec.ts.)
// Router-level cases drive createV1Handler with stub dependencies (no database); the rest run over
// real HTTP against real Postgres, like delivery-routes.spec.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "../helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "../helpers/fixtures";
import { ApiKeysService } from "../../src/api-keys/api-keys.service";
import { DeliveryAuthService } from "../../src/delivery/delivery-auth.service";
import { createV1Handler } from "../../src/delivery/router";
import { decodeCursor, InvalidCursorError } from "../../src/delivery/content-read";
import type { DeliveryDb } from "../../src/delivery/db";
import type { ResolvedApiKey, ResolvedTenant } from "../../src/delivery/auth";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const SECRET = 'SECRET relation "api_keys" does not exist at 10.9.8.7:5432';

describe("M3 T1 — router (stub dependencies)", () => {
  const tenant: ResolvedTenant = { id: "t1", slug: "acme", status: "active", defaultLocale: "en-US", locales: ["en-US"] };
  const auth = { tenantId: "t1", siteId: "s1", envName: "production", tenantDefaultLocale: "en-US" } as unknown as ResolvedApiKey;

  function build(db?: DeliveryDb) {
    const slugsLookedUp: string[] = [];
    const handler = createV1Handler({
      db:
        db ??
        {
          withTenant: async () => {
            throw new Error(SECRET);
          },
        },
      resolveTenantBySlug: async (slug) => {
        slugsLookedUp.push(slug);
        return tenant;
      },
      resolveApiKey: async () => auth,
    });
    const get = (path: string) =>
      handler(new Request(`http://delivery.internal${path}`, { headers: { authorization: "Bearer k", "x-request-id": "rid-1" } }));
    return { get, slugsLookedUp };
  }

  it("D2: a malformed escape in any segment is 400 problem+json and reaches no lookup", async () => {
    for (const path of ["/v1/t/acme/%E0%A4%A", "/v1/t/acme/post/%E0%A4%A", "/v1/t/%E0%A4%A/post", "/v1/t/acme/%C3%28"]) {
      const { get, slugsLookedUp } = build();
      const res = await get(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(((await res.json()) as { type: string }).type).toBe(`${PROBLEM}invalid-path-encoding`);
      expect(slugsLookedUp).toEqual([]);
    }
  });

  it("D2: a decoded `/` or NUL never matches anything: 404 not-found, before any lookup", async () => {
    for (const path of ["/v1/t/acme/post/a%2Fb", "/v1/t/acme/po%2Fst", "/v1/t/..%2Facme/post", "/v1/t/acme/post/%00", "/v1/t/acme/post/a%2fb"]) {
      const { get, slugsLookedUp } = build();
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { type: string }).type, path).toBe(`${PROBLEM}not-found`);
      expect(slugsLookedUp, path).toEqual([]);
    }
  });

  it("D2: the tenant segment is decoded once too; `%2541` is the literal text `%41`", async () => {
    const { get, slugsLookedUp } = build();
    await get("/v1/t/caf%C3%A9/post");
    await get("/v1/t/a%2541/post");
    expect(slugsLookedUp).toEqual(["café", "a%41"]);
  });

  it("D3: an unexpected failure is a 500 whose body never carries the thrown message (it is logged instead)", async () => {
    const { get } = build(); // db.withTenant throws SECRET
    const res = await get("/v1/t/acme/post");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("api_keys");
    expect(JSON.parse(text)).toMatchObject({ type: `${PROBLEM}internal-error`, status: 500, instance: "/v1/t/acme/post", requestId: "rid-1" });
  });

  it("D3: a resolveApiKey failure is the same fixed 500 (the second leak site)", async () => {
    const handler = createV1Handler({
      db: {
        withTenant: async () => {
          throw new Error("unreachable");
        },
      },
      resolveTenantBySlug: async () => tenant,
      resolveApiKey: async () => {
        throw new Error(SECRET);
      },
    });
    const res = await handler(new Request("http://delivery.internal/v1/t/acme/post", { headers: { authorization: "Bearer k" } }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(JSON.parse(text).type).toBe(`${PROBLEM}internal-error`);
  });
});

describe("M3 T1 D3 — decodeCursor is strict", () => {
  const id = randomUUID();
  it("accepts exactly what the encoder writes (Postgres timestamptz::text) in every offset spelling", () => {
    for (const ts of [
      "2026-10-11 09:30:00+00",
      "2026-10-11 09:30:00.1+00",
      "2026-10-11 09:30:00.123456+00",
      "2026-10-11 09:30:00+07",
      "2026-10-11 09:30:00-03:30",
      "2024-02-29 23:59:59.999999+05:30",
    ]) {
      expect(decodeCursor(b64(`${ts}|${id}`)), ts).toEqual({ createdAt: ts, id });
    }
  });

  it("refuses everything else with InvalidCursorError", () => {
    const bad = [
      "garbage",
      "!!!",
      "",
      b64("nopipe"),
      b64("|"),
      b64(`|${id}`),
      b64("2026-10-11 09:30:00+00|"),
      b64(`notadate|${id}`),
      b64(`2026-10-11|${id}`),
      b64(`2026-10-11T09:30:00Z|${id}`), // ISO, not the text format the encoder writes
      b64(`2026-10-11 09:30:00|${id}`), // no offset
      b64(`2026-13-11 09:30:00+00|${id}`),
      b64(`2026-02-30 09:30:00+00|${id}`),
      b64(`2025-02-29 09:30:00+00|${id}`),
      b64(`2026-10-11 24:00:00+00|${id}`),
      b64(`2026-10-11 09:60:00+00|${id}`),
      b64(`2026-10-11 09:30:00.1234567+00|${id}`),
      b64("2026-10-11 09:30:00+00|not-a-uuid"),
      b64(`2026-10-11 09:30:00+00|${id}x`),
      b64(`2026-10-11 09:30:00+00|${id}|${id}`),
      b64(`2026-10-11 09:30:00+00'); DROP TABLE content_items;--|${id}`),
    ];
    for (const c of bad) expect(() => decodeCursor(c), c).toThrow(InvalidCursorError);
  });
});

describe("M3 T1 — over real HTTP", () => {
  let app: NestFastifyApplication;
  let t: FixtureTenant;
  let key: string;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startTestApp();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    t = await createFixtureTenant("m3t1");
    key = (await app.get(ApiKeysService).mint(t.tenantId, t.productionEnvId, "read", "m3t1-test")).key;
    for (const slug of ["kafé-ü", "a%41", "aA", "p1", "p2", "p3"]) await seedContentItem(t, { slug, locale: "en-US", publishState: "published" });
  }, 60_000);

  afterAll(async () => {
    await stopTestApp(app);
  });

  const get = (path: string, headers: Record<string, string> = bearer(key)) =>
    app.inject({ method: "GET", url: `/v1/t/${t.slug}${path}`, headers });

  /** A raw request whose path is sent byte for byte (no client-side URL normalisation). */
  function rawGet(path: string, headers: Record<string, string> = {}): Promise<{ status: number; contentType: string | undefined; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method: "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, contentType: res.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  describe("D2 percent-decoding", () => {
    it("a non-ASCII slug is reachable by its percent-encoded URL", async () => {
      const res = await get(`/case-study/${encodeURIComponent("kafé-ü")}?locale=en-US`);
      expect(res.statusCode).toBe(200);
      expect(res.json().slug).toBe("kafé-ü");
      const literal = await get("/case-study/kaf%C3%A9-%C3%BC?locale=en-US"); // the same, spelled out
      expect(literal.statusCode).toBe(200);
    });

    it("double-encoding is decoded once, never twice", async () => {
      const res = await get("/case-study/a%2541?locale=en-US"); // `a%41`, the literal text
      expect(res.statusCode).toBe(200);
      expect(res.json().slug).toBe("a%41"); // not `aA`
      const aA = await get("/case-study/aA?locale=en-US");
      expect(aA.json().slug).toBe("aA");
    });

    it("a decoded segment holding `/` matches nothing (404, never a cross-segment match)", async () => {
      const res = await get("/case-study%2Fp1?locale=en-US");
      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe(`${PROBLEM}not-found`);
      expect((await get("/case-study/p1%2F?locale=en-US")).statusCode).toBe(404);
    });
  });

  describe("limit", () => {
    it("a non-integer limit is truncated, never a 500 (it used to reach LIMIT $n as 2.5)", async () => {
      const res = await get("/case-study?locale=en-US&limit=2.5");
      expect(res.statusCode).toBe(200);
      expect(res.json().page.limit).toBe(2);
      expect(res.json().items).toHaveLength(2);
      const tiny = await get("/case-study?locale=en-US&limit=0.5");
      expect(tiny.statusCode).toBe(200);
      expect(tiny.json().page.limit).toBe(1);
    });
  });

  describe("D3 cursors", () => {
    it("a valid cursor still pages (the encoder's own output round-trips through the strict decoder)", async () => {
      const first = await get("/case-study?locale=en-US&limit=2");
      expect(first.statusCode).toBe(200);
      const p1 = first.json();
      expect(p1.page.hasMore).toBe(true);
      const second = await get(`/case-study?locale=en-US&limit=2&cursor=${encodeURIComponent(p1.page.cursor)}`);
      expect(second.statusCode).toBe(200);
      const seen = [...p1.items, ...second.json().items].map((i: { slug: string }) => i.slug);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("garbage / non-timestamp / non-uuid cursors are 400 invalid-cursor on list AND search, with no SQL text", async () => {
      const cursors = [
        "garbage",
        "!!!",
        b64("nopipe"),
        b64(`notadate|${randomUUID()}`),
        b64("2020-01-01 00:00:00+00|not-a-uuid"),
        b64(`2026-13-45 00:00:00+00|${randomUUID()}`),
      ];
      for (const cursor of cursors) {
        for (const path of [`/case-study?limit=2&cursor=${encodeURIComponent(cursor)}`, `/search?q=p&limit=2&cursor=${encodeURIComponent(cursor)}`]) {
          const res = await get(path);
          expect(res.statusCode, path).toBe(400);
          expect(res.headers["content-type"]).toBe("application/problem+json");
          const body = res.json();
          expect(body.type, path).toBe(`${PROBLEM}invalid-cursor`);
          expect(body.status).toBe(400);
          expect(res.body, path).not.toMatch(/invalid input syntax|timestamp|uuid|postgres|SELECT|syntax error/i);
        }
      }
    });
  });

  describe("D3 internal errors", () => {
    it("a forced resolveApiKey failure is a 500 that does not carry the thrown message", async () => {
      const spy = vi.spyOn(app.get(DeliveryAuthService), "resolveApiKey").mockRejectedValueOnce(new Error(SECRET));
      const res = await get("/case-study");
      spy.mockRestore();
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toBe("application/problem+json");
      expect(res.body).not.toContain("SECRET");
      expect(res.body).not.toContain("api_keys");
      expect(res.json().type).toBe(`${PROBLEM}internal-error`);
    });
  });

  describe("D4 undecodable URL", () => {
    it("GET /v1/t/x/%E0%A4%A -> 400 application/problem+json in the vocabulary's shape", async () => {
      const res = await rawGet("/v1/t/x/%E0%A4%A", { "x-request-id": "req-m3t1-d4" });
      expect(res.status).toBe(400);
      expect(res.contentType).toBe("application/problem+json");
      expect(JSON.parse(res.body)).toEqual({
        type: `${PROBLEM}invalid-path-encoding`,
        title: "Invalid path encoding",
        status: 400,
        detail: "The request path is not valid percent-encoding.",
        instance: "/v1/t/x/%E0%A4%A",
        requestId: "req-m3t1-d4",
      });
      expect(res.body).not.toContain("FST_ERR");
    });

    it("the same over inject, and on a non-/v1 path, with a generated request id when none is sent", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/t/x/%E0%A4%A" });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe("application/problem+json");
      expect(res.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
      const other = await rawGet("/control/v1/%E0%A4%A");
      expect(other.status).toBe(400);
      expect(other.contentType).toBe("application/problem+json");
    });
  });
});
