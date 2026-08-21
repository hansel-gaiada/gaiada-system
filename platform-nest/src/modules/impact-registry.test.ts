// AGN-5 — impact classification as a property of the REGISTRY, not of per-endpoint memory.
//
// Readiness-bar criterion 4: "Impact-classified writes. Low → direct; medium/high → D14 approval, and
// the approval must actually execute on decision." Its stated failure signal is exactly one thing:
// **"Write not registered with the impact gate."** The plan's action item 5 asks for that to become a
// registry property, because the alternative is remembering, per endpoint, forever.
//
// WHY AN UNCLASSIFIED WRITE IS NOT ALREADY SAFE. It very nearly is: `mcp-hub/src/policy.ts` gates on
// `tool.impact !== "low"`, so an UNDECLARED impact is treated as not-low and suspends for approval —
// fail-closed, and deliberately so. But "safe by accident of a falsy check" is a different property
// from "classified", and it fails in a direction nobody notices: a genuinely low-impact write that
// nobody classified silently demands human approval forever, which trains people to approve without
// reading. The gate protects the estate either way; the CLASSIFICATION is what keeps the gate
// credible.
//
// ⚠ WHY THIS REGISTERS THE WHOLE ESTATE. `mcp-tools.controller.test.ts` registers four modules
// because that is all its assertions need. An audit that did the same would pass while leaving ten
// modules unexamined — the exact shape of "green because we didn't look". This file mirrors main.ts's
// registration block instead, and asserts the count so a NEW module cannot be added to main.ts and
// quietly skipped here.
import { describe, it, expect, beforeAll } from "vitest";
import { resetModules, registerModule, allModules } from "./registry";
import { allCoreTools, resetCoreTools, registerIamCoreTools } from "../core/core-tools";
import type { McpToolDef } from "./contract";

import { agencyModule } from "./agency";
import { pmModule } from "./pm";
import { itModule } from "./it";
import { monitoringModule } from "./monitoring";
import { billingModule } from "./billing";
import { clientsModule } from "./clients";
import { knowledgeModule } from "./knowledge";
import { automationConsoleModule } from "./automation-console";
import { hrModule } from "./hr";
import { assistantModule } from "./assistant";
import { searchModule } from "./search";
import { reportsModule } from "./reports";
import { webdevModule } from "./webdev";
import { socialModule } from "./social";

/** Mirrors main.ts's registration block. Kept as a list so the count can be asserted. */
const ALL_MODULES = [
  agencyModule, pmModule, itModule, monitoringModule, billingModule, clientsModule,
  knowledgeModule, automationConsoleModule, hrModule, assistantModule, searchModule,
  reportsModule, webdevModule, socialModule,
];

let tools: McpToolDef[];

describe("AGN-5 · every write is impact-classified in the registry", () => {
  beforeAll(() => {
    resetModules();
    // `core-tools.ts` registers the IAM core tools as an import-time side effect, so resetting the
    // registry means re-registering them explicitly — otherwise this audit silently omits the nine
    // `iam.*` tools, which are the highest-impact writes in the estate.
    resetCoreTools();
    registerIamCoreTools();
    for (const m of ALL_MODULES) registerModule(m);
    tools = [...allCoreTools(), ...allModules().flatMap((m) => m.mcpTools)];
  });

  it("registers the whole estate — an audit over a subset is 'green because we didn't look'", () => {
    // Positive control, and a tripwire: if main.ts gains a module and this list does not, the count
    // drifts and this fails, which is the only way a new module cannot silently escape the audit.
    expect(allModules().length, "module count drifted from main.ts's registration block").toBe(14);
    expect(tools.length, "no tools collected — the audit below would pass vacuously").toBeGreaterThan(80);
  });

  it("🔴 no write reaches the hub without an impact class", () => {
    const unclassified = tools
      .filter((t) => t.write && !t.impact)
      .map((t) => t.name)
      .sort();
    expect(
      unclassified,
      "these are MUTATING tools with no `impact`. The hub's gate treats an undeclared impact as " +
        "not-low, so they suspend for approval — safe, but by accident of a falsy check rather than " +
        "by decision. Classify each: `low` for a write whose worst case a human would wave through " +
        "without reading, `medium`/`high` for one that must be decided. Leaving it undeclared makes " +
        "a genuinely-low write demand approval forever, which is how people learn to approve " +
        "without looking.",
    ).toEqual([]);
  });

  it("impact is only ever declared on writes — a read with an impact class is a category error", () => {
    // A read cannot be gated by D14 (there is nothing to suspend and execute later), so an `impact`
    // on one is either a copy-paste or a misunderstanding of what the field does. Either way the
    // registry should not carry a value the gate will never consult.
    const readsWithImpact = tools.filter((t) => !t.write && t.impact).map((t) => `${t.name}:${t.impact}`);
    expect(readsWithImpact).toEqual([]);
  });

  it("every impact value is one the gate actually understands", () => {
    // The type says low|medium|high, but these defs cross a JSON boundary into the hub, so a typo
    // reaches the gate as a string it has no branch for — and `!== "low"` would quietly suspend it.
    const bad = tools
      .filter((t) => t.impact && !["low", "medium", "high"].includes(t.impact))
      .map((t) => `${t.name}:${t.impact}`);
    expect(bad).toEqual([]);
  });

  it("a mutating METHOD and the `write` flag agree — one implies the other", () => {
    // `write` drives the gate; `method` drives the transport. They are declared separately, so they
    // can disagree, and the dangerous direction is a POST/PATCH/DELETE that forgot `write: true`:
    // that tool is a mutation the impact gate never sees at all, which no amount of impact
    // classification would catch.
    const mutatingMethods = ["POST", "PATCH", "DELETE"];
    const writesWithoutFlag = tools
      .filter((t) => t.method && mutatingMethods.includes(t.method) && !t.write)
      .map((t) => `${t.name} (${t.method})`)
      .sort();
    expect(
      writesWithoutFlag,
      "these tools use a mutating HTTP method but are not marked `write: true`, so the hub's D14 " +
        "gate never inspects them — an unclassified write is at least suspended, but an unflagged " +
        "one runs unattended.",
    ).toEqual([]);

    // The reverse is a smell rather than a defect: a `write` with no method is informational-only
    // (the contract allows omitting method), so it is reported, not failed.
    const flaggedWithoutMethod = tools.filter((t) => t.write && !t.method).map((t) => t.name);
    if (flaggedWithoutMethod.length) {
      // eslint-disable-next-line no-console
      console.warn(`[AGN-5] write-flagged tools with no method (informational?): ${flaggedWithoutMethod.join(", ")}`);
    }
  });
});
