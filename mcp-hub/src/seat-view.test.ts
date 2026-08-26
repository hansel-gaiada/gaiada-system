// Layer 2 of the allow-list: the per-principal tool view (P1 item 15).
//
// The property under test is the DEMOTION itself. Hermes today holds the whole aggregated surface as
// one flat list under one identity; these tests pin that a seat sees only its own namespaces, that a
// human is untouched, and — the case most likely to be "fixed" wrongly later — that a seat whose
// registry row cannot be read sees NOTHING rather than everything.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { mintPrincipal } from "./principal";
import { resetRegistry, registerTool, allTools, type HubTool } from "./registry";
import { resolveSeatView, filterToolsForSeat, seatNameOf, namespaceOf, resetSeatCache } from "./seat-view";

const seatPrincipal = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us", agent: "agent:dept-pm" });
const humanPrincipal = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });

function tool(name: string): HubTool {
  return { name, description: name, minAssurance: "low", inputSchema: {}, handler: async () => "ok" };
}

function seatsStub(seats: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ seats }) })) as unknown as typeof fetch;
}

let savedUrl: string;
beforeEach(() => {
  resetRegistry();
  resetSeatCache();
  savedUrl = config.platformUrl;
  config.platformUrl = "http://platform.test";
  config.revocationTtlMs = 60_000;
  for (const n of ["pm.listTasks", "pm.setStatus", "money.transfer", "deploy.production", "agents.invoke", "agents.status"]) {
    registerTool(tool(n));
  }
});
afterEach(() => {
  config.platformUrl = savedUrl;
});

describe("seatNameOf — only a well-formed marker is a seat", () => {
  it("strips the agent: prefix runAgent stamps", () => {
    expect(seatNameOf(seatPrincipal)).toBe("dept-pm");
  });
  it("a human is not a seat", () => {
    expect(seatNameOf(humanPrincipal)).toBeUndefined();
  });
  it("a malformed marker is not a seat name — inventing one would look up a row that cannot exist", () => {
    expect(seatNameOf(mintPrincipal({ provider: "x", externalId: "y", agent: "dept-pm" }))).toBeUndefined();
    expect(seatNameOf(mintPrincipal({ provider: "x", externalId: "y", agent: "agent:" }))).toBeUndefined();
  });
  it("namespaceOf takes everything before the first dot", () => {
    expect(namespaceOf("pm.listTasks")).toBe("pm");
    expect(namespaceOf("whoami")).toBe("whoami");
  });
});

describe("a seat sees ONLY its namespaces — this is the demotion", () => {
  it("narrows to the registry row", async () => {
    const f = seatsStub([{ name: "dept-pm", toolNamespaces: ["pm"], enabled: true }]);
    const view = await resolveSeatView(seatPrincipal, f);
    const names = filterToolsForSeat(allTools(), view).map((t) => t.name).sort();
    // pm.* survives; money/deploy do not. agents.* is the deliberate exception (below).
    expect(names).toEqual(["agents.invoke", "agents.status", "pm.listTasks", "pm.setStatus"]);
  });

  it("a HUMAN is untouched — their gate is assurance, not the registry", async () => {
    const f = seatsStub([]);
    const view = await resolveSeatView(humanPrincipal, f);
    expect(view.seat).toBeUndefined();
    expect(filterToolsForSeat(allTools(), view)).toHaveLength(allTools().length);
    // A human must never trigger a registry lookup at all.
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("agents.* stays visible even when the row omits it", async () => {
    // Without this a router whose registry row had a typo would be silently INERT: able to answer,
    // unable to route, with nothing to show for it.
    const f = seatsStub([{ name: "dept-pm", toolNamespaces: ["pm"], enabled: true }]);
    const view = await resolveSeatView(seatPrincipal, f);
    const names = filterToolsForSeat(allTools(), view).map((t) => t.name);
    expect(names).toContain("agents.invoke");
  });
});

describe("an unresolvable seat sees NOTHING — the contestable choice, pinned", () => {
  // The tempting fallback is "show everything, Cerbos still gates it". True about safety, wrong
  // about purpose: it silently restores the pre-demotion behaviour and nothing surfaces it.
  it("a seat missing from the registry gets an empty view", async () => {
    const f = seatsStub([{ name: "dept-seo", toolNamespaces: ["search"], enabled: true }]);
    const view = await resolveSeatView(seatPrincipal, f);
    expect(view.resolved).toBe(false);
    expect(filterToolsForSeat(allTools(), view).map((t) => t.name)).toEqual(["agents.invoke", "agents.status"]);
  });

  it("a DISABLED seat gets an empty view — enabled=false is the kill switch", async () => {
    const f = seatsStub([{ name: "dept-pm", toolNamespaces: ["pm"], enabled: false }]);
    const view = await resolveSeatView(seatPrincipal, f);
    expect(view.reason).toMatch(/disabled/);
    expect(filterToolsForSeat(allTools(), view).some((t) => t.name.startsWith("pm."))).toBe(false);
  });

  it("an unreachable platform gets an empty view, not a full one", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const view = await resolveSeatView(seatPrincipal, boom);
    expect(view.resolved).toBe(false);
    expect(view.namespaces).toEqual([]);
  });
});

describe("caching: resolved answers are cached, failures are NOT", () => {
  it("serves a resolved view from cache within the window", async () => {
    const f = seatsStub([{ name: "dept-pm", toolNamespaces: ["pm"], enabled: true }]);
    await resolveSeatView(seatPrincipal, f, 1000);
    await resolveSeatView(seatPrincipal, f, 1000 + 30_000);
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("never caches an unresolved view — one blip must not blind a seat for a whole TTL", async () => {
    const boom = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await resolveSeatView(seatPrincipal, boom, 1000);
    await resolveSeatView(seatPrincipal, boom, 1000 + 10);
    expect((boom as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });
});

describe("layer 2 can only REMOVE", () => {
  it("a namespace the authority already withheld is not restored by the registry", () => {
    // filterToolsForSeat operates over what it is GIVEN. If Cerbos withheld money.transfer, the seat
    // row naming `money` cannot bring it back — the filter never consults the full registry.
    const authorityAllowed = [tool("pm.listTasks")];
    const view = { seat: "dept-pm", namespaces: ["pm", "money"], resolved: true };
    expect(filterToolsForSeat(authorityAllowed, view).map((t) => t.name)).toEqual(["pm.listTasks"]);
  });
});
