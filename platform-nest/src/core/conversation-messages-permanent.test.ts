// PV4-11 / PV-D34 — pure guards (no database, no Redis): the application must never reach for the DB escape hatch,
// and the message read shape must not grow the retired edit/retract fields back.
// The DB behaviour itself is db/pv4-conversation-messages-permanent.db.test.ts (Linux gate).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const MIGRATIONS = join(__dirname, "..", "..", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const appSources = () => walk(SRC).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f));

describe("PV4-11: conversation messages are permanent (static guards)", () => {
  it("no application source names the operator escape hatch app.conversation_purge", () => {
    const offenders = appSources()
      .filter((f) => readFileSync(f, "utf8").includes("conversation_purge"))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("no application source UPDATEs or DELETEs conversation_messages", () => {
    const offenders = appSources()
      .filter((f) => /\b(UPDATE\s+conversation_messages|DELETE\s+FROM\s+conversation_messages)\b/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("the message read shape has no edit/retract fields and the edit window is gone", () => {
    // Code only: the file's comments may name the retired fields to say they are gone.
    const core = readFileSync(join(SRC, "core", "conversation-core.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const retired of ["editableUntil", "editedAt", "EDIT_WINDOW_MINUTES", "applyEdit", "applyRetract", "assertEditable", "retracted: boolean", "edited: boolean"]) {
      expect(core, retired).not.toContain(retired);
    }
  });

  it("the migration documents the errcode and the escape hatch, and asserts the triggers", () => {
    const sql = readFileSync(join(MIGRATIONS, "202610132130_pv4_conversation_messages_permanent.sql"), "utf8");
    expect(sql).toContain("ERRCODE = 'PD034'");
    expect(sql).toContain("current_setting('app.conversation_purge', true) = 'on'");
    expect(sql).toMatch(/NO APPLICATION CODE MAY SET IT/);
    expect(sql).toMatch(/BEFORE UPDATE ON conversation_messages/);
    expect(sql).toMatch(/BEFORE DELETE ON conversation_messages/);
    expect(sql).toMatch(/tgenabled = 'O'/);
  });
});
