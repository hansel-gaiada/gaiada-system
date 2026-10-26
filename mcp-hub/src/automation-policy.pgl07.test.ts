// PGL-07 (owner ruling PV-D46 (3), revisiting PV-D27 (3)) — NO n8n WORKFLOW MAY NAME A WRITE TOOL IN `contracts.*` OR
// `invoicePayments.*`. A structural check over EVERY `AUTOMATION_ALLOWLIST` entry, so a workflow added next month is
// covered without anyone remembering to extend a list. (automation-policy.test.ts pins wf:billing-chaser's exact scope
// and five named forbidden tools; this file closes the gap that a NEW write tool, or a new workflow, was not covered.)
//
// THE RULE, FAIL-CLOSED: within those two namespaces only a closed set of READ tools may appear. Any other name in the
// namespace counts as a write, including a name nobody has defined yet: the hub's registry learns the platform's tools
// at boot (GET /mcp/tool-defs), so a static check cannot ask it whether `contracts.void` writes, and an unknown name in
// a money/signature namespace is exactly the one to refuse. The read set is restated from platform-nest's
// `core/core-tools.ts`, where those three are the only non-write defs in the two namespaces; platform-nest's
// `approval-self-approval.test.ts` pins that side (every other def there is `write: true`), so the two cannot drift
// silently.
//
// TEETH: the check runs on mutated COPIES of the real list (a write tool added to wf:billing-chaser, a brand-new
// write name, a new workflow naming one) and must report each, so a check that silently passes everything fails here.
import { describe, it, expect } from "vitest";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";

const NAMESPACES = ["contracts.", "invoicePayments."] as const;
/** The only contract/payment tools any workflow may name: reads (PV-D28). */
const READ_TOOLS: ReadonlySet<string> = new Set(["contracts.list", "contracts.get", "invoicePayments.list"]);

type Allowlist = Record<string, readonly string[]>;

/** Every (workflow, tool) pair that names a contract/payment tool outside the read set. Empty = compliant. */
function contractPaymentWriteViolations(list: Allowlist): string[] {
  const out: string[] = [];
  for (const [workflow, tools] of Object.entries(list)) {
    for (const tool of tools) {
      if (NAMESPACES.some((ns) => tool.startsWith(ns)) && !READ_TOOLS.has(tool)) out.push(`${workflow} -> ${tool}`);
    }
  }
  return out;
}

const copy = (): Record<string, string[]> =>
  Object.fromEntries(Object.entries(AUTOMATION_ALLOWLIST).map(([k, v]) => [k, [...v]]));

describe("PGL-07 · no workflow may hold a contract or payment write tool (PV-D46 (3))", () => {
  it("🔴 the real AUTOMATION_ALLOWLIST: no entry names a contract/payment write", () => {
    expect(contractPaymentWriteViolations(AUTOMATION_ALLOWLIST)).toEqual([]);
  });

  it("today only wf:billing-chaser names any contract/payment tool, and only reads", () => {
    const naming = Object.entries(AUTOMATION_ALLOWLIST)
      .filter(([, tools]) => tools.some((t) => NAMESPACES.some((ns) => t.startsWith(ns))))
      .map(([id]) => id);
    expect(naming).toEqual(["wf:billing-chaser"]);
    const named = AUTOMATION_ALLOWLIST["wf:billing-chaser"].filter((t) => NAMESPACES.some((ns) => t.startsWith(ns)));
    for (const t of named) expect(READ_TOOLS.has(t), t).toBe(true);
  });

  describe("TEETH: the check fails a mutated copy of the list", () => {
    it("adding a known write (contracts.countersign) to wf:billing-chaser is reported", () => {
      const l = copy();
      l["wf:billing-chaser"].push("contracts.countersign");
      expect(contractPaymentWriteViolations(l)).toEqual(["wf:billing-chaser -> contracts.countersign"]);
    });

    it("every current contract/payment write is reported, in any workflow", () => {
      for (const w of ["contracts.send", "contracts.countersign", "contracts.createDraft", "contracts.updateDraft", "contracts.setSchedule", "invoicePayments.decide"]) {
        const l = copy();
        l["wf:task-sla"].push(w);
        expect(contractPaymentWriteViolations(l), w).toEqual([`wf:task-sla -> ${w}`]);
      }
    });

    it("a write tool that does not exist yet (contracts.void, invoicePayments.refund) is reported: unknown means write", () => {
      const l = copy();
      l["wf:billing-chaser"].push("contracts.void");
      l["wf:report"].push("invoicePayments.refund");
      expect(contractPaymentWriteViolations(l).sort()).toEqual(["wf:billing-chaser -> contracts.void", "wf:report -> invoicePayments.refund"]);
    });

    it("a NEW workflow entry naming one is reported", () => {
      const l = copy();
      l["wf:future-collector"] = ["clients.list", "invoicePayments.decide"];
      expect(contractPaymentWriteViolations(l)).toEqual(["wf:future-collector -> invoicePayments.decide"]);
    });

    it("tools outside the two namespaces are not its business (no false positives)", () => {
      const l = copy();
      l["wf:billing-chaser"].push("invoices.list", "contractors.update");
      expect(contractPaymentWriteViolations(l)).toEqual([]);
    });
  });
});
