import { describe, it, expect, beforeEach } from "vitest";
import { proposeAction, confirmAction, confirmByReply, isAffirmative } from "./executor";
import { resetConfirm } from "./confirm";
import { resetRateLimiter } from "../safety/rate-limit";
import { setActionsEnabled } from "../safety/kill-switch";
import type { Action, ActionContext, AuthzDecision, ActionResult } from "./types";

// --- fakes -------------------------------------------------------------------
let executed: string[] = [];

function makeAction(over: Partial<Action<{ title: string }>> = {}): Action<{ title: string }> {
  return {
    name: "task.create",
    description: "create a task",
    category: "business",
    riskTier: "low",
    cerbos: { resource: "task", action: "create" },
    validate: (raw) => {
      const title = typeof raw === "string" ? raw.trim() : String((raw as any).title ?? "").trim();
      return title ? { ok: true, args: { title } } : { ok: false, error: "Usage: title required" };
    },
    preview: (a) => `Create task "${a.title}"`,
    execute: async (a): Promise<ActionResult> => {
      executed.push(a.title);
      return { ok: true, message: `✅ Created "${a.title}"` };
    },
    ...over,
  };
}

const auditLog: string[] = [];
const deps = (authorize: (d: AuthzDecision) => AuthzDecision | Promise<AuthzDecision>, extra: Record<string, unknown> = {}) => ({
  authorize: async () => (await authorize({ decision: "allow" })) as AuthzDecision,
  now: 1000,
  genToken: () => "TOK",
  audit: async (e: { decision: string; outcome: string }) => void auditLog.push(`${e.decision}/${e.outcome}`),
  ...extra,
});

const ctx: ActionContext = {
  principal: { provider: "whatsapp", externalId: "u1", assurance: "low" },
  surface: "whatsapp",
  chatId: "g@g.us",
  senderId: "u1",
  senderName: "U",
  gateway: {} as any,
  hub: async () => "",
};
const ctxFor = () => ctx;
const resolve = (name: string) => (name === "task.create" ? action : undefined);
let action = makeAction();

beforeEach(() => {
  resetConfirm();
  resetRateLimiter();
  setActionsEnabled(true);
  executed = [];
  auditLog.length = 0;
  action = makeAction();
});

// --- tests -------------------------------------------------------------------
describe("proposeAction", () => {
  it("unverified caller gets step-up, never a proposal", async () => {
    const r = await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "stepup", reason: "link your account" })));
    expect(r.proposed).toBe(false);
    expect(r.reply).toMatch(/link your account/);
    expect(auditLog).toContain("stepup/blocked");
  });

  it("denied caller gets a denial, never a proposal", async () => {
    const r = await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "deny", reason: "not your project" })));
    expect(r.proposed).toBe(false);
    expect(r.reply).toMatch(/not your project/);
  });

  it("invalid args are rejected before authorization", async () => {
    const r = await proposeAction(action, "", ctx, deps(() => ({ decision: "allow" })));
    expect(r.proposed).toBe(false);
    expect(r.reply).toMatch(/required/);
  });

  it("allowed caller gets a preview + confirm buttons (no execution yet)", async () => {
    const r = await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    expect(r.proposed).toBe(true);
    expect(r.reply).toMatch(/Create task "Buy cement"/);
    expect(r.buttons?.[0].token).toBe("TOK");
    expect(executed).toEqual([]); // nothing ran
  });

  it("kill-switch blocks proposal", async () => {
    setActionsEnabled(false);
    const r = await proposeAction(action, "x", ctx, deps(() => ({ decision: "allow" })));
    expect(r.proposed).toBe(false);
    expect(r.reply).toMatch(/temporarily disabled/i);
  });

  it("rate limit blocks after capacity", async () => {
    const highRisk = makeAction({ riskTier: "high" }); // capacity 3
    for (let i = 0; i < 3; i++) await proposeAction(highRisk, `t${i}`, ctx, deps(() => ({ decision: "allow" })));
    const r = await proposeAction(highRisk, "t4", ctx, deps(() => ({ decision: "allow" })));
    expect(r.proposed).toBe(false);
    expect(r.reply).toMatch(/too often/);
  });
});

describe("confirmAction (button token)", () => {
  it("confirm executes exactly once; a second confirm is a no-op", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    const first = await confirmAction("g@g.us", "u1", "TOK", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(first.executed).toBe(true);
    expect(executed).toEqual(["Buy cement"]);
    const second = await confirmAction("g@g.us", "u1", "TOK", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(second.executed).toBe(false);
    expect(second.reply).toMatch(/Nothing to confirm/);
    expect(executed).toEqual(["Buy cement"]); // still once
  });

  it("revocation between propose and confirm denies (re-authorized at execute)", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    const r = await confirmAction("g@g.us", "u1", "TOK", resolve, ctxFor, deps(() => ({ decision: "deny", reason: "revoked" })));
    expect(r.executed).toBe(false);
    expect(r.reply).toMatch(/revoked/);
    expect(executed).toEqual([]); // never ran
  });

  it("cancel token discards the pending action", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    const r = await confirmAction("g@g.us", "u1", "cancel:TOK", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(r.reply).toMatch(/Cancelled/);
    // the original token no longer confirms
    const after = await confirmAction("g@g.us", "u1", "TOK", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(after.executed).toBe(false);
  });

  it("kill-switch flipped after propose blocks execution", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    setActionsEnabled(false);
    const r = await confirmAction("g@g.us", "u1", "TOK", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(r.executed).toBe(false);
    expect(executed).toEqual([]);
  });

  it("expired pending cannot be confirmed", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" }), { ttlMs: 1000 }));
    const r = await confirmAction("g@g.us", "u1", "TOK", resolve, ctxFor, deps(() => ({ decision: "allow" }), { now: 999999 }));
    expect(r.executed).toBe(false);
    expect(r.reply).toMatch(/Nothing to confirm/);
  });
});

describe("confirmByReply", () => {
  it("returns null when nothing is pending", async () => {
    const r = await confirmByReply("g@g.us", "u1", "yes", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(r).toBeNull();
  });

  it("an affirmative reply confirms the pending action", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    const r = await confirmByReply("g@g.us", "u1", "yes", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(r?.executed).toBe(true);
    expect(executed).toEqual(["Buy cement"]);
  });

  it("'no' cancels", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    const r = await confirmByReply("g@g.us", "u1", "no", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(r?.reply).toMatch(/Cancelled/);
    expect(executed).toEqual([]);
  });

  it("ambiguous reply returns null (not a confirmation)", async () => {
    await proposeAction(action, "Buy cement", ctx, deps(() => ({ decision: "allow" })));
    const r = await confirmByReply("g@g.us", "u1", "what does that mean?", resolve, ctxFor, deps(() => ({ decision: "allow" })));
    expect(r).toBeNull();
  });
});

describe("isAffirmative", () => {
  it("matches common confirmations", () => {
    for (const t of ["y", "yes", "OK", "confirm", "1", "do it"]) expect(isAffirmative(t)).toBe(true);
    for (const t of ["maybe", "why", ""]) expect(isAffirmative(t)).toBe(false);
  });
});
