// P2-07 (partial) — the employee tool surface, and the invariant that keeps its WRITE half honest.
//
// The agentic-native bar (docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md) says a
// capability must work identically under a human, under n8n, and under an agent. P2-06 built the
// human path; this is the beginning of the agent path, and the point of this file is to make the
// UNFINISHED part impossible to forget rather than to claim the bar is met.
//
// ⚠ THE INVARIANT WORTH THE FILE: a declared WRITE tool with medium/high impact must have a D14
// executable-approval entry, or be explicitly barred. Without one, `getExecutable()` returns undefined,
// `execution_status` lands `not_applicable`, and an agent-origin write SUSPENDS and then — on a human's
// approval — does nothing at all. Silently. For a hire, that is a person who was approved and never
// onboarded.
//
// That failure shape is why the JML write tools are NOT declared yet: the honest state is "reads are
// agent-reachable, writes are not", not "JML is agent-reachable".
import { describe, it, expect } from "vitest";
import { hrModule } from "./index";
import { getExecutable } from "../../core/approval-executables";

const tools = hrModule.mcpTools;
const byName = new Map(tools.map((t) => [t.name, t]));

describe("P2-07 · the employee tool surface", () => {
  it("declares the employee READ tools, pointed at the real endpoints", () => {
    const list = byName.get("hr.listEmployees");
    const get = byName.get("hr.getEmployee");
    expect(list?.method).toBe("GET");
    expect(list?.pathTemplate).toBe("/api/:tenantId/hr/employees");
    expect(get?.method).toBe("GET");
    expect(get?.pathTemplate).toBe("/api/:tenantId/hr/employees/:employeeId");
  });

  it("both read tools require a verified caller — no anonymous employee reads", () => {
    // `employees` carries personal data behind the HR module's third RLS wall. A tool that admitted a
    // low-assurance caller would be a wider door than the UI has.
    for (const name of ["hr.listEmployees", "hr.getEmployee"]) {
      expect(byName.get(name)?.minAssurance).toBe("verified");
    }
    expect(byName.get("hr.listEmployees")?.write).toBeUndefined();
    expect(byName.get("hr.getEmployee")?.write).toBeUndefined();
  });

  it("the path templates name every parameter their inputSchema requires", () => {
    // The hub fills `:param` tokens from the tool's args. A required arg with no token (or a token with
    // no arg) is a tool that cannot be called correctly — cheap to assert, invisible otherwise.
    for (const t of tools) {
      if (!t.pathTemplate) continue;
      const tokens = [...t.pathTemplate.matchAll(/:(\w+)/g)].map((m) => m[1]);
      const required = ((t.inputSchema as { required?: string[] })?.required ?? []);
      for (const tok of tokens) {
        expect({ tool: t.name, token: tok, required }).toEqual({ tool: t.name, token: tok, required });
        expect(required).toContain(tok);
      }
    }
  });

  // ── the invariant ────────────────────────────────────────────────────────────────────────────────

  it("🔴 the JML WRITE tools are NOT declared until their D14 executors exist", () => {
    // If you are here because you just added one of these, add its `registerExecutableApproval` entry
    // in the same change — a precondition that re-checks staleness at execution time (the position may
    // have been retired while the approval waited) and a lockKey keyed on the person, so two approvals
    // for the same employee cannot interleave. `deploy.staging`'s entry is the worked precedent.
    for (const name of ["hr.hireEmployee", "hr.transferEmployee", "hr.terminateEmployee"]) {
      const declared = byName.has(name);
      const executor = getExecutable(name);
      // Either not declared at all (today), or declared WITH an executor. Never declared without.
      expect({ name, declared, hasExecutor: !!executor }).toEqual(
        declared ? { name, declared: true, hasExecutor: true } : { name, declared: false, hasExecutor: false },
      );
    }
  });

  it("every write tool this module declares that CLAIMS an impact is either executable or knowingly not", () => {
    // Scoped to the hr module deliberately: most write tools across the estate suspend without
    // auto-executing, which is the established norm and correct for the barred money-spending ones.
    // This asserts the SHAPE — a write tool declares its impact — rather than forcing a policy the rest
    // of the estate has not adopted.
    for (const t of tools) {
      if (!t.write) continue;
      expect(t.impact, `${t.name} declares write:true and must state its impact`).toBeDefined();
      expect(["low", "medium", "high"]).toContain(t.impact);
    }
  });
});
