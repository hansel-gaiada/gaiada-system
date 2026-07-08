import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSkill, routeCommand, listSkills, resetSkills, registerBuiltins, type SkillCtx } from "./skills";
import { resolvePrincipal } from "./principal";
import type { InboundMessage } from "./waha";

vi.mock("./store", () => ({
  saveMessage: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  getPendingMedia: vi.fn(async () => []),
  updateMedia: vi.fn(async () => undefined),
  initStore: vi.fn(async () => undefined),
}));
vi.mock("./llm", () => ({
  complete: vi.fn(async () => "AI"),
  describeMedia: vi.fn(async () => ""),
}));

const callHubTool = vi.fn(async (_t: string, _a: Record<string, unknown>, _e: unknown) => "[]");
vi.mock("./hub", async (importOriginal) => {
  const real = await importOriginal<typeof import("./hub")>();
  return {
    HubDeniedError: real.HubDeniedError,
    callHubTool: (t: string, a: Record<string, unknown>, e: unknown) => callHubTool(t, a, e),
  };
});
import { config } from "./config";
import { HubDeniedError } from "./hub";

function ctx(over: Partial<InboundMessage> = {}, args = ""): SkillCtx {
  const msg: InboundMessage = {
    chatId: "g@g.us",
    senderId: "628110@c.us",
    senderName: "Budi",
    waMessageId: "w1",
    ts: 1,
    text: "",
    isGroup: true,
    fromMe: false,
    replyToBot: false,
    media: null,
    ...over,
  };
  return { msg, args, principal: resolvePrincipal("whatsapp", msg.senderId) };
}

describe("skill framework (Task 3.1)", () => {
  beforeEach(() => {
    resetSkills();
  });

  it("routes a command to its registered skill", async () => {
    registerSkill({ name: "echo", description: "echoes", handler: async (c) => `echo:${c.args}` });
    expect(await routeCommand("echo", ctx({}, "hello"))).toBe("echo:hello");
  });

  it("unknown command → help", async () => {
    registerBuiltins();
    expect(await routeCommand("nope", ctx())).toContain("help");
  });

  it("built-ins are registered: ping, help, summarize, capture, captures, actions", async () => {
    registerBuiltins();
    const names = listSkills().map((s) => s.name);
    for (const n of ["ping", "help", "summarize", "capture", "captures", "actions"]) {
      expect(names).toContain(n);
    }
    expect(await routeCommand("ping", ctx())).toBe("pong");
    expect(await routeCommand("help", ctx())).toContain("summarize");
  });

  it("/know searches the WS8 knowledge service via the hub with the sender envelope (5a.9)", async () => {
    registerBuiltins();
    callHubTool.mockClear();
    config.hubServiceToken = "hub-token";
    callHubTool.mockResolvedValue(JSON.stringify([{ text: "diesel delivery arrives thursday", sourceRef: "doc-1" }]));
    const reply = await routeCommand("know", ctx({ chatId: "tg:-100", senderId: "tg:555" }, "when is diesel coming"));
    const [tool, args, envelope] = callHubTool.mock.calls[0];
    expect(tool).toBe("knowledge.search");
    expect(args).toEqual({ query: "when is diesel coming", scope: "tg:-100" });
    expect(envelope).toEqual({ provider: "telegram", externalId: "tg:555" });
    expect(reply).toBe("AI"); // llm.complete over the retrieved context
  });

  it("/know denial → step-up, never data (D4/D9)", async () => {
    registerBuiltins();
    config.hubServiceToken = "hub-token";
    callHubTool.mockRejectedValue(new HubDeniedError("denied"));
    const reply = await routeCommand("know", ctx({}, "secret question"));
    expect(reply).toContain("link and verify");
  });

  it("/projects forwards the sender's envelope to the hub and renders the platform's answer", async () => {
    registerBuiltins();
    callHubTool.mockClear();
    config.hubServiceToken = "hub-token";
    config.defaultTenantId = "tenant-1";
    callHubTool.mockResolvedValue(JSON.stringify([{ name: "Rebrand", status: "active" }]));
    const reply = await routeCommand("projects", ctx({ chatId: "tg:-100", senderId: "tg:555" }));
    expect(reply).toContain("Rebrand");
    const [tool, args, envelope] = callHubTool.mock.calls[0];
    expect(tool).toBe("projects.list");
    expect(args).toEqual({ tenantId: "tenant-1" });
    expect(envelope).toEqual({ provider: "telegram", externalId: "tg:555" });
  });

  it("/projects: a platform denial becomes a step-up message, never data (D4)", async () => {
    registerBuiltins();
    config.hubServiceToken = "hub-token";
    config.defaultTenantId = "tenant-1";
    callHubTool.mockRejectedValue(new HubDeniedError("denied: low-assurance"));
    const reply = await routeCommand("projects", ctx());
    expect(reply).toContain("link and verify");
    expect(reply).not.toContain("denied:");
  });

  it("a skill requiring verified assurance step-ups a low-assurance caller instead of answering (Task 3.2)", async () => {
    registerSkill({
      name: "payroll",
      description: "company data",
      minAssurance: "verified",
      handler: async () => "SECRET-PAYROLL",
    });
    const reply = await routeCommand("payroll", ctx());
    expect(reply).not.toContain("SECRET-PAYROLL");
    expect(reply.toLowerCase()).toContain("verified");
  });
});
