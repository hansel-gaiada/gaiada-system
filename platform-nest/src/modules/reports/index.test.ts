// TR-28 — pure inventory/contract assertions on `reportsModule.mcpTools` (§9.2, §12, §15). No DB,
// no Cerbos, no hub — this is the cheap, always-runnable guard against the exact failure mode §15
// warns about: "an omission that isn't tested is an omission that gets added back by the next
// well-meaning ticket." reports-mcp-tools.db.test.ts covers the live Cerbos-parity half; this file
// covers the static-shape half (exactly six, never more, never the excluded ones, schemas
// internally consistent with the hub's actual fronting mechanics).
import { describe, it, expect } from "vitest";
import { reportsModule } from "./index";

const EXPECTED_NAMES = [
  "reports.getDocument",
  "reports.listPeriods",
  "reports.getMetrics",
  "reports.getCompliance",
  "checkin.getToday",
  "checkin.submit",
];

// §9.2's own text + the standing ruling: seal/amend/periods-pin (exec ceremony) and every
// appraisal read/write/ack/finalize tool are deliberately NOT exposed over MCP at all. Matched
// against both the tool NAME and its pathTemplate — a def could pass a naive name check while
// still routing at an excluded route (e.g. a mis-scoped "reports.getDocument" pointed at
// "/periods/:id/seal"), so both are asserted.
const EXCLUDED_NAME_FRAGMENTS = ["seal", "amend", "pin", "recompute", "appraisal"];
const EXCLUDED_PATH_FRAGMENTS = ["/seal", "/amend", "/periods/pin", "/facts/recompute", "/appraisals"];

describe("TR-28 — reportsModule.mcpTools (§9.2's six, no more, no less)", () => {
  it("registers EXACTLY six tools, no more", () => {
    expect(reportsModule.mcpTools).toHaveLength(6);
  });

  it("registers exactly the six named tools — nothing renamed, nothing extra", () => {
    const names = reportsModule.mcpTools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_NAMES].sort());
  });

  it("never exposes a seal/amend/pin/recompute/appraisal tool — by name", () => {
    for (const tool of reportsModule.mcpTools) {
      for (const fragment of EXCLUDED_NAME_FRAGMENTS) {
        expect(tool.name.toLowerCase(), `${tool.name} must not reference "${fragment}"`).not.toContain(fragment);
      }
    }
  });

  it("never exposes a seal/amend/pin/recompute/appraisal tool — by route (pathTemplate)", () => {
    for (const tool of reportsModule.mcpTools) {
      if (!tool.pathTemplate) continue;
      for (const fragment of EXCLUDED_PATH_FRAGMENTS) {
        expect(tool.pathTemplate, `${tool.name}'s pathTemplate must not route through "${fragment}"`).not.toContain(fragment);
      }
    }
  });

  it("checkin.submit keeps the documented minAssurance:'low' deviation (never 'verified')", () => {
    const tool = reportsModule.mcpTools.find((t) => t.name === "checkin.submit")!;
    expect(tool.minAssurance).toBe("low");
    expect(tool.write).toBe(true);
    expect(tool.impact).toBe("low");
  });

  it("checkin.getToday and the three plain read tools stay minAssurance:'low'", () => {
    for (const name of ["checkin.getToday", "reports.getDocument", "reports.listPeriods", "reports.getMetrics"]) {
      expect(reportsModule.mcpTools.find((t) => t.name === name)!.minAssurance).toBe("low");
    }
  });

  it("reports.getCompliance keeps §9.2's literal minAssurance:'verified' (deliberately dormant, see index.ts header)", () => {
    expect(reportsModule.mcpTools.find((t) => t.name === "reports.getCompliance")!.minAssurance).toBe("verified");
  });

  it("checkin.submit's schema exposes no field that could name a subject other than the OBO caller", () => {
    const props = Object.keys((reportsModule.mcpTools.find((t) => t.name === "checkin.submit")!.inputSchema as { properties: Record<string, unknown> }).properties);
    for (const forbidden of ["userId", "subjectUserId", "actorUserId", "onBehalfOf"]) {
      expect(props).not.toContain(forbidden);
    }
  });

  it("reports.getMetrics' description states the ratio/additivity rule (the model's only warning against average-of-averages)", () => {
    const desc = reportsModule.mcpTools.find((t) => t.name === "reports.getMetrics")!.description.toLowerCase();
    expect(desc).toContain("numerator");
    expect(desc).toContain("denominator");
    expect(desc).toMatch(/never average|average-of-averages/);
  });

  it("the four range-taking tools' periodKind enum includes 'custom' and carries an 'end' field", () => {
    for (const name of ["reports.getDocument", "reports.listPeriods" /* uses 'kind', checked below */, "reports.getCompliance"]) {
      const tool = reportsModule.mcpTools.find((t) => t.name === name)!;
      const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
      const kindField = name === "reports.listPeriods" ? props.kind : props.periodKind;
      expect(kindField?.enum).toContain("custom");
    }
    expect(Object.keys((reportsModule.mcpTools.find((t) => t.name === "reports.getDocument")!.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("end");
    expect(Object.keys((reportsModule.mcpTools.find((t) => t.name === "reports.getCompliance")!.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("end");
  });

  it("reports.getMetrics carries an arbitrary from/to window (the range params the custom-range amendment added)", () => {
    const props = Object.keys((reportsModule.mcpTools.find((t) => t.name === "reports.getMetrics")!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toEqual(expect.arrayContaining(["from", "to"]));
  });

  // ─────────────────────── the hub-fronting self-consistency guard (see index.ts's header) ───────
  // mcp-hub's callPlatform() drops any GET arg not consumed by a `:token` in pathTemplate, and
  // fillPath() throws if a `:token` present in the template has no arg at all — so every property
  // this file embeds as a query-string `:token` MUST also be in `required`, or a spec-compliant
  // caller omitting an "optional" field would get a hub-side crash instead of a clean HTTP call.
  // This guard makes that invariant a regression test rather than a comment someone can drift past.
  it("every :token in a tool's pathTemplate is in that tool's own 'required' list (no optional query-string token)", () => {
    for (const tool of reportsModule.mcpTools) {
      if (!tool.pathTemplate) continue;
      const tokens = [...tool.pathTemplate.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      for (const token of tokens) {
        expect(required, `${tool.name}'s pathTemplate references :${token}, which must be in 'required'`).toContain(token);
      }
    }
  });

  it("every 'required' property actually exists in the tool's own schema properties (no dangling requirement)", () => {
    for (const tool of reportsModule.mcpTools) {
      const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      for (const key of schema.required ?? []) {
        expect(Object.keys(schema.properties), `${tool.name} requires "${key}" but never declares it as a property`).toContain(key);
      }
    }
  });
});
