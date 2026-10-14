// PV4-03b — the per-route body-limit table and its `onRoute` hook, WITHOUT a database: a bare Fastify
// instance and a bare Nest+Fastify app (no AppModule), so this file runs anywhere. The DB-backed half —
// the REAL routes through the REAL buildApp(), against Postgres + Cerbos — is upload-body-limits.http.test.ts.
//
// What is pinned here:
//   * the arithmetic (limit = ceil(cap * 4/3) + envelope) and that it derives from the handlers' own caps;
//   * the hook raises the limit on a matching route ONLY, and the 1 MiB default is untouched elsewhere;
//   * the drift guard: an entry that matches no route, a hook installed too late, a duplicate entry;
//   * that Nest's own JSON parser (registered with the 1 MiB `initialConfig.bodyLimit`) does NOT override
//     the per-route value — the Nest/Fastify interaction the whole fix rests on;
//   * that every table URL is the path Nest really registers for the real controllers (read from their
//     decorator metadata), so the table cannot name a route spelled differently from the code.
import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Controller, Module, Post, Body, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  UPLOAD_ROUTES, JSON_ENVELOPE_ALLOWANCE_BYTES, base64EncodedBytes, inlineUploadBodyLimit,
  installUploadBodyLimits, describeUploadRoutes, type UploadRoute,
} from "./upload-body-limits";
import { MAX_ATTACHMENT_TOTAL_BYTES } from "./conversation-core";
import { MAX_PROOF_BYTES, PortalCommerceController } from "./portal-commerce.controller";
import { PortalConversationController } from "./portal-conversation.controller";
import { ConversationController } from "./conversation.controller";
import { FilesController, MAX_BYTES } from "./files.controller";

const DEFAULT_LIMIT = 1024 * 1024;
const MIB = 1024 * 1024;
const json = { "content-type": "application/json" };
/** A JSON body of roughly `bytes` bytes. */
const bodyOf = (bytes: number) => JSON.stringify({ pad: "x".repeat(Math.max(0, bytes - 12)) });

describe("upload body limit arithmetic", () => {
  it("base64 inflates by 4/3, rounded up", () => {
    expect(base64EncodedBytes(3)).toBe(4);
    expect(base64EncodedBytes(4)).toBe(6);
    expect(base64EncodedBytes(10 * MIB)).toBe(Buffer.alloc(10 * MIB).toString("base64").length - 2); // 13,981,014 vs padded 13,981,016
  });

  it("the limit is the encoded cap plus the fixed envelope, and always clears a body carrying exactly the cap", () => {
    for (const cap of [MAX_PROOF_BYTES, MAX_ATTACHMENT_TOTAL_BYTES]) {
      const limit = inlineUploadBodyLimit(cap);
      expect(limit).toBe(Math.ceil((cap * 4) / 3) + JSON_ENVELOPE_ALLOWANCE_BYTES);
      // A padded base64 string of `cap` bytes is at most 2 chars longer than the unpadded ceil.
      expect(Buffer.alloc(cap + 1).toString("base64").length).toBeLessThan(limit);
    }
  });

  it("every table entry takes its cap from the handler's own constant, not a restated number", () => {
    const byUrl = new Map(UPLOAD_ROUTES.map((r) => [r.url, r.capBytes]));
    expect(byUrl.get("/api/:tenantId/portal/invoices/:invoiceId/payments")).toBe(MAX_PROOF_BYTES);
    for (const url of [
      "/api/:tenantId/portal/conversation", "/api/:tenantId/portal/conversation/:threadId/messages",
      "/api/:tenantId/conversation", "/api/:tenantId/conversation/:threadId/messages",
    ]) expect(byUrl.get(url), url).toBe(MAX_ATTACHMENT_TOTAL_BYTES);
    expect(byUrl.get("/api/:tenantId/files")).toBe(MAX_BYTES); // DW-8h: staff file upload, the handler's own 25 MB cap
    expect(MAX_BYTES).toBe(25 * MIB);
    expect(UPLOAD_ROUTES).toHaveLength(6);
  });

  it("the boot log has one line per entry naming its limit", () => {
    const lines = describeUploadRoutes();
    expect(lines).toHaveLength(UPLOAD_ROUTES.length);
    expect(lines[0]).toContain(`bodyLimit ${inlineUploadBodyLimit(MAX_PROOF_BYTES)} B`);
  });
});

describe("the table's URLs are the paths Nest registers for the real controllers", () => {
  /** `/api` + the method's path, from the same decorator metadata Nest's router reads. */
  function registered(controller: new (...a: never[]) => unknown, httpMethod: RequestMethod): string[] {
    const base = Reflect.getMetadata("path", controller) as string;
    const out: string[] = [];
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const fn = (controller.prototype as Record<string, unknown>)[name];
      if (typeof fn !== "function" || Reflect.getMetadata("method", fn as object) !== httpMethod) continue;
      const p = Reflect.getMetadata("path", fn as object) as string;
      out.push(`/${[base, p].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`);
    }
    return out;
  }

  it("each entry is a POST route declared on one of the four controllers", () => {
    const all = [
      ...registered(PortalCommerceController as never, RequestMethod.POST),
      ...registered(PortalConversationController as never, RequestMethod.POST),
      ...registered(ConversationController as never, RequestMethod.POST),
      ...registered(FilesController as never, RequestMethod.POST),
    ];
    for (const r of UPLOAD_ROUTES) expect(all.filter((u) => u === r.url), r.url).toHaveLength(1);
  });
});

describe("the onRoute hook on a bare Fastify instance", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  const table: UploadRoute[] = [{ method: "POST", url: "/up/:id/files", capBytes: 3 * MIB, label: "test upload" }];

  async function build(t: readonly UploadRoute[], installBefore = true) {
    const f = Fastify();
    let handle = installBefore ? installUploadBodyLimits(f, t) : undefined;
    f.post("/up/:id/files", async () => ({ ok: true }));
    f.post("/other", async () => ({ ok: true }));
    f.post("/up/:id/other", async () => ({ ok: true }));
    if (!installBefore) handle = installUploadBodyLimits(f, t);
    await f.ready();
    app = f;
    return handle!;
  }
  const post = (url: string, bytes: number) => app!.inject({ method: "POST", url, headers: json, payload: bodyOf(bytes) });

  it("raises the limit on the matching route only; every other route keeps the 1 MiB default", async () => {
    const handle = await build(table);
    handle.assertAllMatched();
    expect(handle.applied).toEqual([{ label: "test upload", method: "POST", url: "/up/:id/files", bodyLimit: inlineUploadBodyLimit(3 * MIB) }]);

    expect((await post("/up/1/files", 2 * MIB)).statusCode).toBe(200);          // above 1 MiB, inside the route limit
    for (const other of ["/other", "/up/1/other"]) {
      const r = await post(other, 2 * MIB);
      expect(r.statusCode, other).toBe(413);
      expect(r.json().code).toBe("FST_ERR_CTP_BODY_TOO_LARGE");
    }
    expect((await post("/other", DEFAULT_LIMIT - 1024)).statusCode).toBe(200);   // the default still admits what it admitted
  });

  it("the matching route still has a ceiling: over the derived limit Fastify refuses", async () => {
    await build(table);
    const r = await post("/up/1/files", inlineUploadBodyLimit(3 * MIB) + 1024);
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("FST_ERR_CTP_BODY_TOO_LARGE");
  });

  it("an entry that matches no registered route throws at assertAllMatched (drift guard)", async () => {
    const handle = await build([...table, { method: "POST", url: "/up/:id/renamed", capBytes: MIB, label: "gone route" }]);
    expect(() => handle.assertAllMatched()).toThrow(/POST \/up\/:id\/renamed \(gone route\) matched 0 registered route/);
  });

  it("a method mismatch is not a match", async () => {
    const f = Fastify();
    const handle = installUploadBodyLimits(f, table);
    f.get("/up/:id/files", async () => ({ ok: true }));
    await f.ready();
    app = f;
    expect(() => handle.assertAllMatched()).toThrow(/matched 0/);
  });

  it("a duplicate table entry is refused at install time", () => {
    const f = Fastify();
    expect(() => installUploadBodyLimits(f, [...table, ...table])).toThrow(/duplicate table entry/);
  });
});

describe("installing the hook too late cannot pass silently", () => {
  it("after the routes are registered the install throws or the guard does — never a quiet 1 MiB fallback", async () => {
    const f = Fastify();
    f.post("/up/:id/files", async () => ({ ok: true }));
    await f.ready();
    const late = () => installUploadBodyLimits(f, [{ method: "POST", url: "/up/:id/files", capBytes: MIB, label: "late" }]).assertAllMatched();
    expect(late).toThrow();
    await f.close();
  });
});

describe("Nest + Fastify: the per-route bodyLimit beats Nest's own 1 MiB-bounded JSON parser", () => {
  @Controller("api")
  class MiniController {
    @Post(":tenantId/portal/conversation")
    open(@Body() b: { pad?: string }) { return { n: b.pad?.length ?? 0 }; }
    @Post(":tenantId/other")
    other(@Body() b: { pad?: string }) { return { n: b.pad?.length ?? 0 }; }
  }
  @Module({ controllers: [MiniController] })
  class MiniModule {}

  let app: NestFastifyApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("the Nest-registered url is exactly `/api/:tenantId/...`, and only that route is raised", async () => {
    const a = await NestFactory.create<NestFastifyApplication>(MiniModule, new FastifyAdapter(), { logger: false });
    const handle = installUploadBodyLimits(
      a.getHttpAdapter().getInstance() as unknown as FastifyInstance,
      [{ method: "POST", url: "/api/:tenantId/portal/conversation", capBytes: 3 * MIB, label: "mini" }],
    );
    await a.init();
    await a.getHttpAdapter().getInstance().ready();
    app = a;
    handle.assertAllMatched();

    const t = "00000000-0000-4000-8000-000000000000";
    const big = await a.inject({ method: "POST", url: `/api/${t}/portal/conversation`, headers: json, payload: bodyOf(2 * MIB) });
    expect(big.statusCode).toBe(201);
    expect(big.json().n).toBeGreaterThan(2 * MIB - 100);
    const other = await a.inject({ method: "POST", url: `/api/${t}/other`, headers: json, payload: bodyOf(2 * MIB) });
    expect(other.statusCode).toBe(413);
  });
});
