// The gate that stops `String(args.tenantId)` becoming the literal string "undefined" in a
// platform URL. See validate-args.ts's header for the incident these pin.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { validateToolArgs, invalidArgsMessage } from "./validate-args";
import { registerTool, resetRegistry } from "./registry";
import { buildHubServer } from "./hub";
import { mintPrincipal } from "./principal";
import { config } from "./config";

describe("validateToolArgs", () => {
  it("rejects a missing required argument by NAME, instead of passing undefined through", () => {
    const schema = { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] };
    const r = validateToolArgs(schema, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("tenantId");
    expect(r.errors[0]).toContain("required");
  });

  it("treats an explicit null as absent — String(null) is the same class of garbage as 'undefined'", () => {
    const schema = { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] };
    expect(validateToolArgs(schema, { tenantId: null }).ok).toBe(false);
  });

  it("reports EVERY problem at once, so an agent does not fix one per round trip", () => {
    const schema = {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" } },
      required: ["tenantId", "projectId"],
    };
    const r = validateToolArgs(schema, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(2);
  });

  it("accepts a valid call unchanged", () => {
    const schema = { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] };
    expect(validateToolArgs(schema, { tenantId: "abc" })).toEqual({ ok: true, args: { tenantId: "abc" } });
  });

  it("accepts a schema that declares nothing — ping/whoami take no arguments without ceremony", () => {
    expect(validateToolArgs({ type: "object", properties: {} }, {})).toEqual({ ok: true, args: {} });
    expect(validateToolArgs(undefined, { x: 1 })).toEqual({ ok: true, args: { x: 1 } });
  });

  it("carries unknown properties through untouched — the schema did not forbid them", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(validateToolArgs(schema, { a: "x", extra: 7 })).toEqual({ ok: true, args: { a: "x", extra: 7 } });
  });

  it("rejects a wrong type it cannot losslessly convert", () => {
    const r = validateToolArgs({ type: "object", properties: { limit: { type: "number" } } }, { limit: "not-a-number" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("expected number");
  });

  it("does NOT coerce number → string: that direction hides a type confusion", () => {
    const schema = { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] };
    expect(validateToolArgs(schema, { tenantId: 42 }).ok).toBe(false);
  });

  it("coerces the two lossless directions LLM clients actually get wrong", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "number" }, publicOnly: { type: "boolean" }, n: { type: "integer" } },
    };
    const r = validateToolArgs(schema, { limit: "5", publicOnly: "true", n: "3" });
    expect(r).toEqual({ ok: true, args: { limit: 5, publicOnly: true, n: 3 } });
  });

  it("refuses a fractional string for an integer", () => {
    expect(validateToolArgs({ type: "object", properties: { n: { type: "integer" } } }, { n: "1.5" }).ok).toBe(false);
  });

  it("accepts an integer where a number is declared, but not the reverse", () => {
    expect(validateToolArgs({ type: "object", properties: { n: { type: "number" } } }, { n: 3 }).ok).toBe(true);
    expect(validateToolArgs({ type: "object", properties: { n: { type: "integer" } } }, { n: 1.5 }).ok).toBe(false);
  });

  it("enforces enum", () => {
    const schema = {
      type: "object",
      properties: { rating: { type: "string", enum: ["up", "down"] } },
      required: ["rating"],
    };
    expect(validateToolArgs(schema, { rating: "up" }).ok).toBe(true);
    const bad = validateToolArgs(schema, { rating: "sideways" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors[0]).toContain('"up"');
  });

  it("applies `default` BEFORE the required check, so a defaulted property satisfies it", () => {
    const schema = {
      type: "object",
      properties: { mode: { type: "string", default: "summary" } },
      required: ["mode"],
    };
    expect(validateToolArgs(schema, {})).toEqual({ ok: true, args: { mode: "summary" } });
  });

  it("validates array items when the schema declares them", () => {
    const schema = { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } };
    expect(validateToolArgs(schema, { ids: ["a", "b"] }).ok).toBe(true);
    const bad = validateToolArgs(schema, { ids: ["a", { x: 1 }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors[0]).toContain("ids[1]");
  });

  it("enforces a required field one level down in a nested object", () => {
    const schema = {
      type: "object",
      properties: { filter: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    };
    const bad = validateToolArgs(schema, { filter: {} });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors[0]).toContain("filter.key");
  });

  it("names the accepted arguments in the caller-facing message", () => {
    const schema = {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" } },
      required: ["tenantId"],
    };
    const msg = invalidArgsMessage("projects.list", ["tenantId: required (string) — not provided"], schema);
    expect(msg).toContain("projects.list");
    expect(msg).toContain("Accepted arguments: tenantId, projectId");
  });
});

// ── The regression itself, driven through the real MCP call path ────────────────────────────────
describe("hub tool dispatch enforces the advertised schema", () => {
  const principal = mintPrincipal({ provider: "platform", externalId: "u1" });
  let seen: Record<string, unknown> | undefined;

  async function connect(p = principal): Promise<Client> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildHubServer(p).connect(serverT);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientT);
    return client;
  }

  beforeEach(() => {
    resetRegistry();
    seen = undefined;
    config.auditFile = "data/test-validate-args/tools.jsonl";
    rmSync("data/test-validate-args", { recursive: true, force: true });
  });
  afterAll(() => rmSync("data/test-validate-args", { recursive: true, force: true }));

  const REQUIRED_TENANT = {
    type: "object",
    properties: { tenantId: { type: "string" } },
    required: ["tenantId"],
  };

  /** The real read tool's exact shape — `String(args.tenantId)` interpolated into a platform path
   *  is precisely where the literal "undefined" used to enter the URL. */
  function registerProjectsList(): void {
    registerTool({
      name: "projects.list",
      description: "test double for the real read tool",
      minAssurance: "anonymous",
      inputSchema: REQUIRED_TENANT,
      handler: async (args) => {
        seen = args;
        return `/api/${String(args.tenantId)}/projects`;
      },
    });
  }

  it("a missing tenantId never reaches the handler, and the caller is told which argument", async () => {
    registerProjectsList();
    const res = await (await connect()).callTool({ name: "projects.list", arguments: {} });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain("tenantId");
    expect(text).toContain("Accepted arguments");
    expect(text).not.toContain("/api/undefined");
    expect(seen).toBeUndefined();
  });

  it("the rejection audits as allow+ok:false — a malformed call is not a policy denial", async () => {
    registerProjectsList();
    await (await connect()).callTool({ name: "projects.list", arguments: {} });
    const audit = readFileSync(config.auditFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { tool: string; decision: string; ok?: boolean; reason?: string });
    const row = audit.find((a) => a.tool === "projects.list");
    expect(row?.decision).toBe("allow");
    expect(row?.ok).toBe(false);
    expect(row?.reason).toContain("tenantId");
  });

  it("a valid call still reaches the handler with its arguments intact", async () => {
    registerProjectsList();
    const res = await (await connect()).callTool({ name: "projects.list", arguments: { tenantId: "c-1" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("/api/c-1/projects");
    expect(seen).toEqual({ tenantId: "c-1" });
  });

  it("the handler receives the COERCED arguments, not the raw ones", async () => {
    registerTool({
      name: "activity.feed",
      description: "test double",
      minAssurance: "anonymous",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      handler: async (args) => {
        seen = args;
        return "ok";
      },
    });
    await (await connect()).callTool({ name: "activity.feed", arguments: { limit: "20" } });
    expect(seen).toEqual({ limit: 20 });
  });

  it("an unauthorized caller learns nothing about the tool's arguments", async () => {
    registerTool({
      name: "rollup.probe",
      description: "test double",
      minAssurance: "verified",
      inputSchema: REQUIRED_TENANT,
      handler: async () => "never",
    });
    const res = await (await connect(mintPrincipal({}))).callTool({ name: "rollup.probe", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain("tenantId");
    expect(seen).toBeUndefined();
  });
});
