import { describe, it, expect } from "vitest";
import { makeHubAuthorizer } from "./authorize";
import { HubDeniedError } from "../hub";
import type { Action, ActionContext } from "./types";

const action = { cerbos: { resource: "task", action: "create" } } as Action<any>;
const principal = { provider: "whatsapp" as const, externalId: "u", assurance: "low" as const };

function ctxWithHub(hub: ActionContext["hub"]): ActionContext {
  return { principal, surface: "whatsapp", chatId: "g@g.us", senderId: "u", senderName: "U", gateway: {} as any, hub };
}

describe("makeHubAuthorizer (fail-closed, delegates to platform)", () => {
  const authz = makeHubAuthorizer();

  it("passes through an allow decision", async () => {
    const r = await authz(principal, action, ctxWithHub(async () => JSON.stringify({ decision: "allow" })));
    expect(r.decision).toBe("allow");
  });

  it("passes through a deny decision", async () => {
    const r = await authz(principal, action, ctxWithHub(async () => JSON.stringify({ decision: "deny", reason: "nope" })));
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("nope");
  });

  it("maps HubDeniedError (unlinked/unverified) to step-up", async () => {
    const r = await authz(principal, action, ctxWithHub(async () => { throw new HubDeniedError("denied"); }));
    expect(r.decision).toBe("stepup");
  });

  it("fails closed (deny) on any other error", async () => {
    const r = await authz(principal, action, ctxWithHub(async () => { throw new Error("hub 500"); }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/unavailable/);
  });

  it("fails closed on an unexpected response shape", async () => {
    const r = await authz(principal, action, ctxWithHub(async () => JSON.stringify({ foo: "bar" })));
    expect(r.decision).toBe("deny");
  });
});
