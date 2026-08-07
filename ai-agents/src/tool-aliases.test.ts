// Unit tests for the explicit tool-name alias map (see tool-aliases.ts's header for the full
// reasoning: hand-written map, no fuzzy matching, reads only). Order-of-resolution-vs-authorization is
// a SEPARATE, dedicated file (`tool-alias-resolution-order.test.ts`) because that property has to be
// proven against `runAgent` itself, not against this module in isolation.
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveToolAlias, toolAliasEntries } from "./tool-aliases";

describe("resolveToolAlias", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes an unrecognized name through UNCHANGED — no fuzzy matching, ever", () => {
    expect(resolveToolAlias("tasks.list")).toBe("tasks.list"); // already canonical
    expect(resolveToolAlias("totally.invented.name")).toBe("totally.invented.name");
    expect(resolveToolAlias("pm.createTask")).toBe("pm.createTask"); // a real write tool, not an alias
  });

  it("resolves the observed incident: pm.listTasks -> tasks.list", () => {
    expect(resolveToolAlias("pm.listTasks")).toBe("tasks.list");
  });

  it("resolves the same-cause pre-emptive alias: pm.getTask -> tasks.get", () => {
    expect(resolveToolAlias("pm.getTask")).toBe("tasks.get");
  });

  it("is case-sensitive and exact-match only — a near-miss of the alias itself is NOT resolved", () => {
    expect(resolveToolAlias("PM.LISTTASKS")).toBe("PM.LISTTASKS");
    expect(resolveToolAlias("pm.listTask")).toBe("pm.listTask"); // singular, one char off — unchanged
    expect(resolveToolAlias(" pm.listTasks")).toBe(" pm.listTasks"); // stray whitespace — unchanged
  });

  it("logs a resolution (observability) but stays silent on a pass-through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveToolAlias("pm.listTasks");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("pm.listTasks");
    expect(warn.mock.calls[0][0]).toContain("tasks.list");
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

  it("the map is non-empty and matches the two documented, justified entries — a reviewer adding a third should update this count deliberately", () => {
    expect(toolAliasEntries()).toEqual([
      { from: "pm.listTasks", to: "tasks.list" },
      { from: "pm.getTask", to: "tasks.get" },
    ]);
  });
});
