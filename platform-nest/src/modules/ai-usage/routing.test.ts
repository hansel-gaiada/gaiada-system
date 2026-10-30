import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_TASKS, TASK_CLASS_BY_LABEL, UNROUTED_TASKS, gatewayTaskFor, gatewayTaskField, readGatewayTier } from "./routing";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("gatewayTaskFor (AIP-07)", () => {
  it.each([
    ["assistant.reply", "chat"],
    ["assistant.compaction", "summarise"],
    ["search.cluster_label", "summarise"],
    ["social.inbox_triage", "classify"],
    ["search.audit_triage", "classify"],
    ["search.brief_draft", "draft"],
    ["search.brief_polish", "draft"],
    ["search.rsa_draft", "draft"],
    ["search.negatives_proposal", "draft"],
    ["search.report_narrative", "draft"],
    ["social.content_brief_ideas", "draft"],
    ["social.content_brief_caption", "draft"],
    ["social.draft_caption", "draft"],
    ["social.draft_ideas", "draft"],
    ["social.report_narrative", "draft"],
    ["social.report_generate", "draft"],
    ["social.audit_summary", "draft"],
    ["reports.narrative", "draft"],
    ["clients.account_summary", "draft"],
    ["webdev.assist", "draft"],
  ])("%s -> %s", (label, cls) => {
    expect(gatewayTaskFor(label)).toBe(cls);
    expect(gatewayTaskField(label)).toEqual({ task: cls });
  });

  it("returns undefined for embed, unknown, empty and non-string labels, and the field is absent", () => {
    for (const l of ["search.embed_keyword", "nope", "", null, undefined, "__proto__", "constructor"]) {
      expect(gatewayTaskFor(l as string | null | undefined)).toBeUndefined();
      expect("task" in gatewayTaskField(l as string | null | undefined)).toBe(false);
    }
  });

  it("only maps to the five gateway classes", () => {
    for (const cls of Object.values(TASK_CLASS_BY_LABEL)) expect(GATEWAY_TASKS).toContain(cls);
  });

  it("readGatewayTier is an exact match", () => {
    expect(readGatewayTier("fast")).toBe("fast");
    expect(readGatewayTier("standard")).toBe("standard");
    expect(readGatewayTier("strong")).toBe("strong");
    for (const bad of ["turbo", "Fast", " fast", "", null, undefined, 3, {}]) expect(readGatewayTier(bad)).toBeNull();
  });
});

describe("every call-site label in platform-nest src is routed or explicitly unrouted (AIP-07)", () => {
  it("has no label that is neither mapped nor in UNROUTED_TASKS", () => {
    const root = join(__dirname, "..", "..");
    const labels = new Set<string>();
    for (const f of sourceFiles(root)) {
      for (const m of readFileSync(f, "utf8").matchAll(/\btask:\s*"([a-z0-9_]+\.[a-z0-9_]+)"/g)) labels.add(m[1]);
    }
    expect(labels.size).toBeGreaterThan(10);
    const missing = [...labels].filter((l) => !(l in TASK_CLASS_BY_LABEL) && !UNROUTED_TASKS.includes(l));
    expect(missing).toEqual([]);
  });
});
