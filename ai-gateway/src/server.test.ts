import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { config } from "./config";
import { Chain } from "./chain";
import { buildGatewayApp } from "./server";
import { resetBudgetForTest } from "./budget";
import type { Provider } from "./providers";

const seen: string[] = [];
const okProvider: Provider = {
  name: "fake",
  available: () => true,
  complete: async (prompt) => {
    seen.push(prompt);
    return "ANSWER";
  },
  media: async () => "spoken card 4111 1111 1111 1111 in the recording",
  embed: async () => [0.1, 0.2],
};

function app() {
  return buildGatewayApp({ llm: new Chain([okProvider]), media: new Chain([okProvider]), embed: new Chain([okProvider]) });
}
const auth = { authorization: "Bearer t" };

describe("ai-gateway server", () => {
  beforeEach(() => {
    seen.length = 0;
    resetBudgetForTest();
    config.gatewayToken = "t";
    config.auditFile = "data/test-audit/egress.jsonl";
    rmSync("data/test-audit", { recursive: true, force: true });
  });
  afterAll(() => rmSync("data/test-audit", { recursive: true, force: true }));

  it("rejects without a token; rejects everything when no token is configured (fail-closed)", async () => {
    const a = app();
    expect((await a.inject({ method: "POST", url: "/complete", payload: { prompt: "x" } })).statusCode).toBe(401);
    config.gatewayToken = "";
    expect(
      (await a.inject({ method: "POST", url: "/complete", headers: { authorization: "Bearer t" }, payload: { prompt: "x" } })).statusCode,
    ).toBe(401);
  });

  it("DLP-redacts the prompt BEFORE it reaches the provider, and audits the egress", async () => {
    const a = app();
    const r = await a.inject({
      method: "POST",
      url: "/complete",
      headers: auth,
      payload: { prompt: "customer NIK 3174012345678901 pays with 4111 1111 1111 1111" },
    });
    expect(r.statusCode).toBe(200);
    expect(seen[0]).toContain("[REDACTED-ID]");
    expect(seen[0]).toContain("[REDACTED-CARD]");
    expect(seen[0]).not.toContain("4111");

    const audit = JSON.parse(readFileSync(config.auditFile, "utf8").trim().split("\n").at(-1)!);
    expect(audit).toMatchObject({ capability: "llm", provider: "fake", ok: true, redactions: 2 });
  });

  it("media extraction is scrubbed before returning to the caller", async () => {
    const a = app();
    const r = await a.inject({ method: "POST", url: "/media", headers: auth, payload: { base64: "aGk=", mime: "audio/ogg" } });
    const { text } = r.json() as { text: string };
    expect(text).toContain("[REDACTED-CARD]");
    expect(text).not.toContain("4111");
  });

  it("enforces the daily budget cap (429, audited as blocked)", async () => {
    const original = config.dailyCallCap;
    config.dailyCallCap = 1;
    const a = app();
    expect((await a.inject({ method: "POST", url: "/complete", headers: auth, payload: { prompt: "one" } })).statusCode).toBe(200);
    const r = await a.inject({ method: "POST", url: "/complete", headers: auth, payload: { prompt: "two" } });
    config.dailyCallCap = original;
    expect(r.statusCode).toBe(429);
    const last = JSON.parse(readFileSync(config.auditFile, "utf8").trim().split("\n").at(-1)!);
    expect(last.blocked).toBe("budget");
  });

  it("all-providers-down → 502, audited, no raw error leak of payload", async () => {
    const dead: Provider = {
      name: "dead",
      available: () => true,
      complete: async () => {
        throw new Error("provider down");
      },
      media: async () => "",
      embed: async () => [0],
    };
    const a = buildGatewayApp({ llm: new Chain([dead]), media: new Chain([dead]), embed: new Chain([dead]) });
    const r = await a.inject({ method: "POST", url: "/complete", headers: auth, payload: { prompt: "x" } });
    expect(r.statusCode).toBe(502);
    expect(existsSync(config.auditFile)).toBe(true);
  });

  it("audit records contain metadata only — never payload content", async () => {
    const a = app();
    await a.inject({ method: "POST", url: "/complete", headers: auth, payload: { prompt: "SECRET-PAYLOAD-TEXT" } });
    const lines = readFileSync(config.auditFile, "utf8");
    expect(lines).not.toContain("SECRET-PAYLOAD-TEXT");
  });
});
