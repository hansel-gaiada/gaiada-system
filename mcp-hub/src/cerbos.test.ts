import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { resetRegistry } from "./registry";
import { registerCoreTools } from "./tools";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { visibleToolsFor, authorizeCall } from "./policy";
import { mintPrincipal, type Principal } from "./principal";

const lowUser = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });
const staleChaser: Principal = { provider: "n8n", externalId: "wf:stale-approval-chaser", assurance: "low" };

// Cerbos stub: allow only the tool names in `allow`; everything else EFFECT_DENY.
function stubCerbos(allow: Set<string>) {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { resources: Array<{ resource: { id: string } }> };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.resources.map((r) => ({
          resource: { id: r.resource.id },
          actions: { call: allow.has(r.resource.id) ? "EFFECT_ALLOW" : "EFFECT_DENY" },
        })),
      }),
    };
  }) as unknown as typeof fetch;
}

describe("Cerbos-authoritative policy (WS2 §5)", () => {
  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    registerPlatformWriteTools();
    config.cerbosUrl = "http://cerbos.test";
  });
  afterEach(() => {
    config.cerbosUrl = "";
    vi.unstubAllGlobals();
  });

  it("visibleToolsFor returns exactly what Cerbos allows (one batched check)", async () => {
    const spy = stubCerbos(new Set(["ping", "whoami"]));
    vi.stubGlobal("fetch", spy);
    const names = (await visibleToolsFor(lowUser)).map((t) => t.name);
    expect(names.sort()).toEqual(["ping", "whoami"]);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1); // batched, not N calls
  });

  it("authorizeCall honors a Cerbos allow", async () => {
    vi.stubGlobal("fetch", stubCerbos(new Set(["whoami"])));
    const d = await authorizeCall(lowUser, "whoami");
    expect(d.allow).toBe(true);
  });

  it("a Cerbos deny keeps the in-code suspend reason for a medium+/unclassified automation write", async () => {
    // projects.create is LOW (auto-allowed); notify is LOW too. Use a medium write via registry.
    const { registerTool } = await import("./registry");
    registerTool({ name: "money.transfer", description: "m", minAssurance: "low", write: true, impact: "medium", inputSchema: { type: "object" }, handler: async () => "ok" });
    const { AUTOMATION_ALLOWLIST } = await import("./automation-policy");
    AUTOMATION_ALLOWLIST["wf:stale-approval-chaser"] = ["money.transfer"];
    vi.stubGlobal("fetch", stubCerbos(new Set())); // Cerbos denies (as the policy would: medium write)
    const d = await authorizeCall(staleChaser, "money.transfer");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*medium-impact/);
    delete AUTOMATION_ALLOWLIST["wf:stale-approval-chaser"];
  });

  it("fails closed to the in-code engine when Cerbos is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch);
    // in-code allows whoami for a low user, so the fallback still returns allow (deny-by-default engine)
    const d = await authorizeCall(lowUser, "whoami");
    expect(d.allow).toBe(true);
    // and denies an unknown tool
    const d2 = await authorizeCall(lowUser, "does.not.exist");
    expect(d2.allow).toBe(false);
  });
});
