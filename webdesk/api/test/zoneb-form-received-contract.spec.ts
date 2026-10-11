// Cross-package contract: the REAL emitted `form.received` envelope must match the shared fixture
// (contracts/zoneb/form-received.envelope.json) in key set and per-key type. The ERP side
// (platform-nest zoneb-form-received-contract.test.ts) feeds the same fixture to its validator.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildFormsTestApp, stopFormsTestApp } from "./forms-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, setEnvironmentDomain } from "./helpers/forms-fixtures";
import { turnstileConfig } from "../src/forms/forms.config";
import { verifySignature } from "../src/events/zoneb-event-signature";

const CONTRACT_DIR = resolve(__dirname, "../../../contracts/zoneb");
const fixture = JSON.parse(readFileSync(resolve(CONTRACT_DIR, "form-received.envelope.json"), "utf8"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The type a fixture value pins: "uuid" | "iso-timestamp" | "string" | typeof. */
function typeTag(v: unknown): string {
  if (typeof v === "string") return UUID.test(v) ? "uuid" : ISO.test(v) ? "iso-timestamp" : "string";
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
function matchesTag(v: unknown, tag: string): boolean {
  if (tag === "string") return typeof v === "string"; // a plain-string slot accepts any string
  return typeTag(v) === tag;
}

/** Returns a list of drift problems; empty means the shape matches exactly. */
function shapeDiff(actual: Record<string, unknown>, expected: Record<string, unknown>, path = ""): string[] {
  const problems: string[] = [];
  const a = Object.keys(actual).sort();
  const e = Object.keys(expected).sort();
  for (const k of e) if (!a.includes(k)) problems.push(`missing key ${path}${k}`);
  for (const k of a) if (!e.includes(k)) problems.push(`extra key ${path}${k}`);
  for (const k of e) {
    if (!a.includes(k)) continue;
    const ev = expected[k];
    const av = actual[k];
    if (ev !== null && typeof ev === "object" && !Array.isArray(ev)) {
      if (av === null || typeof av !== "object" || Array.isArray(av)) problems.push(`${path}${k} must be an object`);
      else problems.push(...shapeDiff(av as Record<string, unknown>, ev as Record<string, unknown>, `${path}${k}.`));
    } else if (!matchesTag(av, typeTag(ev))) {
      problems.push(`${path}${k} must be ${typeTag(ev)}, got ${typeTag(av)}`);
    }
  }
  return problems;
}

describe("shape comparison is not vacuous (negative self-checks)", () => {
  it("accepts the fixture against itself", () => {
    expect(shapeDiff(fixture, fixture)).toEqual([]);
  });
  it("rejects a top-level key removed, a data key removed, an extra key, and a retyped key", () => {
    const { eventId: _e, ...noEventId } = fixture;
    expect(shapeDiff(noEventId, fixture)).toContain("missing key eventId");
    const { hasAttachments: _h, ...dataNoFlag } = fixture.data;
    expect(shapeDiff({ ...fixture, data: dataNoFlag }, fixture)).toContain("missing key data.hasAttachments");
    expect(shapeDiff({ ...fixture, extra: 1 }, fixture)).toContain("extra key extra");
    expect(shapeDiff({ ...fixture, data: { ...fixture.data, hasAttachments: "no" } }, fixture)).toHaveLength(1);
    expect(shapeDiff({ ...fixture, tenantId: "not-a-uuid" }, fixture)).toEqual(["tenantId must be uuid, got string"]);
  });
});

describe("WebDesk form.received — real submission matches the shared contract fixture", () => {
  const SECRET = "zoneb-contract-test-secret";
  const DOMAIN = "zoneb-contract.example.test";
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["WEBDESK_ZONEB_EVENTS_ENABLED", "WEBDESK_ZONEB_BRIDGE_URL", "WEBDESK_EVENT_SECRET", "WEBDESK_ZONEB_ORIGIN_SITE", "WEBDESK_ZONEB_EVENT_TIMEOUT_MS"];
  let sink: Server;
  const captured: { headers: IncomingMessage["headers"]; rawBody: string }[] = [];
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let formId: string;

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captured.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const addr = sink.address();
    if (addr === null || typeof addr === "string") throw new Error("sink failed to bind");
    process.env.WEBDESK_ZONEB_EVENTS_ENABLED = "true";
    process.env.WEBDESK_ZONEB_BRIDGE_URL = `http://127.0.0.1:${addr.port}/webhook/wd-zoneb-intake`;
    process.env.WEBDESK_EVENT_SECRET = SECRET;
    process.env.WEBDESK_ZONEB_ORIGIN_SITE = "webdesk";
    process.env.WEBDESK_ZONEB_EVENT_TIMEOUT_MS = "3000";

    app = await buildFormsTestApp();
    tenant = await createFixtureTenant("zoneb-contract");
    await setEnvironmentDomain(tenant, tenant.productionEnvId, DOMAIN);
    const form = await createFormDef(tenant, {
      schema: { fields: [{ key: "name", type: "text", required: true, maxLength: 200 }], consentNotice: { text: "You agree." } },
    });
    formId = form.id;
  }, 30_000);

  afterAll(async () => {
    await stopFormsTestApp(app);
    await new Promise<void>((r) => sink.close(() => r()));
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("emits a signed envelope with the fixture's exact shape and the tenant's company_ref", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
      headers: { origin: `https://${DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.6.1",
      payload: { fields: { name: "Contract Check" }, consent: true, turnstileToken: turnstileConfig.stubPassToken },
    });
    expect(res.statusCode).toBe(201);

    // The emit may be fire-and-forget; wait for the sink to see it.
    for (let i = 0; i < 100 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    const req = captured[0];

    const verdict = verifySignature({
      secret: SECRET,
      timestampHeader: req.headers["x-webdesk-timestamp"] as string | undefined,
      rawBody: req.rawBody,
      signatureHeader: req.headers["x-webdesk-signature"] as string | undefined,
      toleranceMs: 5 * 60_000,
    });
    expect(verdict.ok).toBe(true);

    const envelope = JSON.parse(req.rawBody) as Record<string, unknown>;
    expect(shapeDiff(envelope, fixture)).toEqual([]);

    const migrator = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk" });
    await migrator.connect();
    let companyRef: string;
    try {
      await migrator.query("BEGIN");
      await migrator.query("SET LOCAL webdesk.platform_ctx = 'true'");
      companyRef = (await migrator.query<{ company_ref: string }>("SELECT company_ref FROM tenants WHERE id = $1", [tenant.tenantId])).rows[0].company_ref;
      await migrator.query("COMMIT");
    } finally {
      await migrator.end();
    }
    expect(envelope.tenantId).toBe(companyRef);
    expect(envelope.tenantId).not.toBe(tenant.tenantId);
  }, 30_000);
});
