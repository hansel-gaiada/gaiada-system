import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { actorHash, recordActionAudit, readActionAudit } from "./audit";
import { config } from "../config";

describe("action audit", () => {
  beforeEach(() => {
    config.actionAuditFile = "data/action-audit.test.jsonl";
    try { rmSync(config.actionAuditFile); } catch { /* ignore */ }
  });

  it("hashes actors stably and non-reversibly", () => {
    const h = actorHash("whatsapp", "123@c.us");
    expect(h).toEqual(actorHash("whatsapp", "123@c.us"));
    expect(h).not.toContain("123");
    expect(actorHash("telegram", "123@c.us")).not.toEqual(h);
  });

  it("appends and reads back entries", async () => {
    await recordActionAudit({
      ts: 1, surface: "whatsapp", chatId: "g@g.us", actor: actorHash("whatsapp", "u"),
      action: "task.create", argsSummary: "title=x", decision: "allow", outcome: "done",
    });
    const rows = await readActionAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("task.create");
    expect(rows[0].decision).toBe("allow");
  });

  it("scrubs PII from argsSummary before persisting", async () => {
    await recordActionAudit({
      ts: 2, surface: "whatsapp", chatId: "g@g.us", actor: "h",
      action: "note.add", argsSummary: "card 4111 1111 1111 1111", decision: "allow", outcome: "done",
    });
    const rows = await readActionAudit();
    expect(rows[0].argsSummary).not.toContain("4111 1111 1111 1111");
  });
});
