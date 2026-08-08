// Unit tests for the explicit tool-name alias map (see tool-aliases.ts's header for the full
// reasoning: hand-written map, no fuzzy matching, reads only). Order-of-resolution-vs-authorization is
// a SEPARATE, dedicated file (`tool-alias-resolution-order.test.ts`) because that property has to be
// proven against `runAgent` itself, not against this module in isolation.
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveToolAlias, toolAliasEntries, __setTestAlias, __clearTestAliases } from "./tool-aliases";

describe("resolveToolAlias", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __clearTestAliases();
  });

  it("passes an unrecognized name through UNCHANGED — no fuzzy matching, ever", () => {
    expect(resolveToolAlias("tasks.list")).toBe("tasks.list"); // already canonical
    expect(resolveToolAlias("totally.invented.name")).toBe("totally.invented.name");
    expect(resolveToolAlias("pm.createTask")).toBe("pm.createTask"); // a real write tool, not an alias
  });

  // RETIRED 2026-08-08 (P4-J5): pm.listTasks/pm.getTask used to alias to tasks.list/tasks.get (the
  // 2026-08-07 near-miss fix). mcp-hub/src/pm-tools.ts (P4-J1) then made BOTH real, DIFFERENT,
  // canonical tools — tenant-wide and facet-rich, not the project-scoped tools they used to redirect
  // to — so redirecting them would now be a correctness bug (a correct call silently rewritten to the
  // wrong tool), not a convenience. These are regression guards: nobody should re-add either entry.
  it("pm.listTasks / pm.getTask are now REAL canonical tools, not aliases — pass through unchanged", () => {
    expect(resolveToolAlias("pm.listTasks")).toBe("pm.listTasks");
    expect(resolveToolAlias("pm.getTask")).toBe("pm.getTask");
  });

  it("is case-sensitive and exact-match only — a near-miss of a real tool name is NOT resolved", () => {
    expect(resolveToolAlias("PM.LISTTASKS")).toBe("PM.LISTTASKS");
    expect(resolveToolAlias("pm.listTask")).toBe("pm.listTask"); // singular, one char off — unchanged
    expect(resolveToolAlias(" pm.listTasks")).toBe(" pm.listTasks"); // stray whitespace — unchanged
  });

  it("logs a resolution (observability) but stays silent on a pass-through — exercised via the test-only overlay, since the production map is currently empty", () => {
    __setTestAlias("test.aliasProbe", "test.canonicalProbe");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveToolAlias("test.aliasProbe")).toBe("test.canonicalProbe");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("test.aliasProbe");
    expect(warn.mock.calls[0][0]).toContain("test.canonicalProbe");
    warn.mockClear();
    resolveToolAlias("not.in.the.map");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("TOOL_ALIASES invariants", () => {
  // Hand-mirrored from the hub registry at ticket time (mcp-hub/src/{pm,platform-write,pipeline,
  // delivery,work-activity}-tools.ts's `write: true` entries) — the SAME "mirrors drift, keep the job
  // narrow" pattern already used by agent-write-guard.test.ts's RERUN_CAPABLE_HIGH_WRITES and
  // impact-reconciliation.test.ts's realRegistry. Re-verify against those files if this ever needs
  // updating; do NOT import mcp-hub from ai-agents (separate standalone projects, per CLAUDE.md).
  const KNOWN_HUB_WRITE_TOOLS: readonly string[] = [
    "pm.createDoc",
    "pm.createTask",
    "pm.setStatus", // P4-J2
    "pm.passBall", // P4-J2
    "pm.setDueDate", // P4-J2
    "pm.comment", // P4-J2
    "projects.create",
    "tasks.create",
    "tasks.update",
    "clients.create",
    "clients.update",
    "deliverables.create",
    "deliverables.update",
    "time.log",
    "time.update",
    "notify",
    "approvals.request",
    "approvals.resolveExecute",
    "pipeline.createRun",
    "pipeline.createStage",
    "pipeline.updateRun",
    "pipeline.updateStage",
    "pipeline.openGate",
    "github.createRepo",
    "deploy.staging",
    "deploy.production",
    "workActivity.relink",
    "agent.feedback",
  ];

  it("no alias target is a known hub WRITE tool — reads only, ever", () => {
    for (const { from, to } of toolAliasEntries()) {
      expect(KNOWN_HUB_WRITE_TOOLS, `alias "${from}" -> "${to}" must not target a write tool`).not.toContain(to);
    }
  });

  it("every alias source is itself absent from the known write-tool list (a write tool is never the thing being ALIASED FROM either)", () => {
    for (const { from } of toolAliasEntries()) {
      expect(KNOWN_HUB_WRITE_TOOLS, `"${from}" collides with a known write tool name`).not.toContain(from);
    }
  });

  it("the map is EMPTY (2026-08-08, P4-J5) — its two former entries were retired once pm.listTasks/pm.getTask became real tools; a reviewer re-adding one should do so deliberately, not by accident", () => {
    expect(toolAliasEntries()).toEqual([]);
  });
});
