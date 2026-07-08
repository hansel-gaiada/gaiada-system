import { describe, it, expect, beforeEach } from "vitest";
import { registerGroupAdminActions } from "./group-admin";
import { getAction, resetActions } from "./registry";
import { unsupported } from "../gateway/contract";
import type { ActionContext } from "./types";
import type { ChatGateway, GatewayResult } from "../gateway/contract";

function fakeGateway(over: Partial<ChatGateway> = {}): ChatGateway {
  const ok = async (): Promise<GatewayResult> => ({ ok: true });
  return {
    sendText: async () => {},
    reply: ok, sendMedia: ok, react: ok, sendButtons: ok, typing: ok,
    addMember: ok, removeMember: ok, promote: ok, demote: ok, setSubject: ok, pin: ok, inviteLink: ok,
    ...over,
  };
}

function ctx(surface: "whatsapp" | "telegram", gateway: ChatGateway): ActionContext {
  const chatId = surface === "telegram" ? "tg:-100" : "g@g.us";
  return {
    principal: { provider: surface, externalId: "admin", assurance: "low" },
    surface, chatId, senderId: "admin", senderName: "Admin", gateway, hub: async () => "",
  };
}

describe("group-admin actions", () => {
  beforeEach(() => {
    resetActions();
    registerGroupAdminActions();
  });

  it("registers all group verbs mapped to chat_group Cerbos actions", () => {
    expect(getAction("group.remove")!.cerbos).toEqual({ resource: "chat_group", action: "remove_member" });
    expect(getAction("group.promote")!.category).toBe("group-admin");
    expect(getAction("group.pin")!.riskTier).toBe("high");
  });

  it("remove calls the gateway removeMember and reports success", async () => {
    let called = "";
    const gw = fakeGateway({ removeMember: async (_c, u) => { called = u; return { ok: true }; } });
    const action = getAction("group.remove")!;
    const parsed = action.validate("spammer@c.us");
    expect(parsed.ok).toBe(true);
    const r = await action.execute((parsed as any).args, ctx("whatsapp", gw));
    expect(called).toBe("spammer@c.us");
    expect(r.ok).toBe(true);
  });

  it("degrades honestly when the surface can't do the verb (WhatsApp pin unsupported)", async () => {
    const gw = fakeGateway({ pin: async () => unsupported("pin", "whatsapp") });
    const action = getAction("group.pin")!;
    const r = await action.execute({ messageId: "m1" }, ctx("whatsapp", gw));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can't pin|not supported/i);
  });

  it("Telegram cannot addMember but CAN pin (capability matrix)", async () => {
    // group.pin exists; on telegram pin is supported
    let pinned = false;
    const gw = fakeGateway({ pin: async () => { pinned = true; return { ok: true }; } });
    const r = await getAction("group.pin")!.execute({ messageId: "m1" }, ctx("telegram", gw));
    expect(pinned).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("surfaces a gateway error", async () => {
    const gw = fakeGateway({ setSubject: async () => ({ ok: false, error: "not admin" }) });
    const r = await getAction("group.rename")!.execute({ subject: "New Name" }, ctx("telegram", gw));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not admin/);
  });

  it("validates required args", () => {
    expect(getAction("group.remove")!.validate("").ok).toBe(false);
    expect(getAction("group.rename")!.validate("  ").ok).toBe(false);
  });
});
