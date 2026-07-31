// SM-58 — unit tests for the mapping/leak/logging behaviour, PLUS the precedence proof the ticket
// names as an explicit AC.
//
// Why precedence needs an EMPIRICAL test, not just a read of Nest's source: this filter's `@Catch()`
// matches every thrown value unconditionally, so where it sits relative to the type-scoped filters
// in `useGlobalFilters(...)` determines whether it backstops them or SWALLOWS them. Nest's own
// resolution is a `find()` over a list that `RouterExceptionFilters.create`/`getGlobalMetadata`
// builds by REVERSING the array `useGlobalFilters(...)` was called with
// (`node_modules/@nestjs/core/router/router-exception-filters.js:23`) — so the LAST argument passed
// is checked FIRST. That is exactly the kind of internal detail this suite should not take on faith:
// it is proven below by actually booting a Nest+Fastify app with the real filter classes and driving
// real HTTP requests through `app.inject`, not by re-deriving it from reading the framework source.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { HttpErrorFilter } from "./http-error.filter";
import { ProviderDispatchErrorFilter } from "./modules/search/provider-dispatch-error.filter";
import { GatewayNotConfiguredErrorFilter } from "./modules/search/gateway-not-configured-error.filter";
import { LastResortExceptionFilter } from "./last-resort-exception.filter";
import { ScopeDisabledError } from "./modules/search/providers/types";
import { GatewayNotConfiguredError } from "./modules/search/providers/gateway-client";
import { NotFoundException } from "@nestjs/common";

// ── Unit tests: the mapping itself, tested the same way the sibling filters test theirs ───────────
function capture(exception: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const reply = {
    status(s: number) { status = s; return this; },
    send(b: unknown) { body = b; return this; },
  };
  const request = { method: "POST", url: "/api/t1/whatever" };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new LastResortExceptionFilter().catch(exception, host as any);
  return { status, body };
}

describe("SM-58 · last-resort filter: shape + leak-nothing", () => {
  it("is 500 with the fixed generic body — never a bare message-less 500 again", () => {
    const { status, body } = capture(new Error("connection to postgres://admin:s3cr3t@10.0.0.9/db failed"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error", code: "internal_error" });
  });

  it("NEVER forwards exception.message to the client, however sensitive", () => {
    const secrets = [
      "postgres://user:hunter2@db.internal:5432/gaiada",
      "Bearer sk-live-abc123",
      "duplicate key value violates unique constraint \"users_email_key\"",
      "ENOENT: no such file or directory, open '/etc/gaiada/secrets.env'",
    ];
    for (const message of secrets) {
      const { body } = capture(new Error(message));
      const text = JSON.stringify(body);
      expect(text).not.toContain(message);
      // Spot-check the tokens that would leak even under a partial-match mistake.
      expect(text.toLowerCase()).not.toContain("hunter2");
      expect(text).not.toContain("sk-live-abc123");
    }
  });

  it("also handles a non-Error throwable without crashing the filter itself", () => {
    // Something threw a string/plain object rather than an Error — must still be caught safely and
    // still leak nothing, not throw inside the filter and produce an even-worse unhandled rejection.
    const { status, body } = capture("a bare string throw, not even an Error");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error", code: "internal_error" });
  });

  it("logs the real fault server-side (name, message, stack, method, url) via console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new TypeError("boom: something truly unexpected");
      capture(err);
      expect(spy).toHaveBeenCalledTimes(1);
      const [line, stack] = spy.mock.calls[0]!;
      expect(line).toContain("POST");
      expect(line).toContain("/api/t1/whatever");
      expect(line).toContain("TypeError");
      expect(line).toContain("boom: something truly unexpected");
      expect(stack).toBe(err.stack);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps `error` for app-wide contract parity and adds a fixed `code` for branching", () => {
    const { body } = capture(new Error("whatever"));
    expect(body).toHaveProperty("error", "internal error");
    expect(body).toHaveProperty("code", "internal_error");
  });
});

// ── Precedence proof: a real Nest+Fastify app, the REAL filter classes, real HTTP via app.inject ──
// Deliberately NOT the full platform app (no DB/Cerbos dependency) — a throwaway controller with one
// route per exception family is enough to prove which filter wins, and keeps this test fast and
// self-contained.
@Controller()
class ProbeController {
  @Get("http-exception")
  throwHttp(): never {
    throw new NotFoundException("nope");
  }
  @Get("dispatch-error")
  throwDispatch(): never {
    throw new ScopeDisabledError("serp", "serp");
  }
  @Get("gateway-error")
  throwGateway(): never {
    throw new GatewayNotConfiguredError();
  }
  @Get("plain-error")
  throwPlain(): never {
    throw new Error("a totally unclassified fault");
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

async function buildProbeApp(filters: unknown[]): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ProbeModule,
    new FastifyAdapter(),
    { logger: false },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.useGlobalFilters(...(filters as any[]));
  await app.init();
  return app;
}

describe("SM-58 · filter precedence — the explicit AC", () => {
  describe("CORRECT order (catch-all FIRST argument, matching main.ts)", () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      app = await buildProbeApp([
        new LastResortExceptionFilter(),
        new HttpErrorFilter(),
        new ProviderDispatchErrorFilter(),
        new GatewayNotConfiguredErrorFilter(),
      ]);
    });
    afterAll(async () => {
      await app.close();
    });

    it("HttpErrorFilter still wins for HttpException — 404 with { error }, not the generic 500", async () => {
      const res = await app.inject({ method: "GET", url: "/http-exception" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "nope" });
    });

    it("ProviderDispatchErrorFilter still wins for its type — 409 with code, not the generic 500", async () => {
      const res = await app.inject({ method: "GET", url: "/dispatch-error" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "scope_disabled" });
    });

    it("GatewayNotConfiguredErrorFilter still wins for its type — 503, not the generic 500", async () => {
      const res = await app.inject({ method: "GET", url: "/gateway-error" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "gateway_not_configured" });
    });

    it("a genuinely unclassified Error reaches LastResortExceptionFilter — 500, generic body", async () => {
      const res = await app.inject({ method: "GET", url: "/plain-error" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal error", code: "internal_error" });
    });
  });

  describe("WRONG order (catch-all LAST argument) — documents exactly the mistake main.ts must avoid", () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      app = await buildProbeApp([
        new HttpErrorFilter(),
        new ProviderDispatchErrorFilter(),
        new GatewayNotConfiguredErrorFilter(),
        new LastResortExceptionFilter(),
      ]);
    });
    afterAll(async () => {
      await app.close();
    });

    it("the catch-all SHADOWS HttpErrorFilter when placed last — proves placement, not merely presence, is the AC", async () => {
      const res = await app.inject({ method: "GET", url: "/http-exception" });
      // If this ever starts failing (i.e. main.ts's real order regresses to this shape), the 404 above
      // would silently become a 500 in production — this test exists so that regression is caught here
      // instead of live.
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal error", code: "internal_error" });
    });
  });
});
