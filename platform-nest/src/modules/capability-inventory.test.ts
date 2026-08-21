// AGN-6 — the capability inventory, GENERATED from the registry and drift-checked.
//
// Exit-bar criterion 6, quoted in full because its second sentence is the requirement: "A capability
// inventory exists showing, per capability, its endpoint + its tool + its impact class. **If that
// table cannot be generated, the estate is not agentic-native regardless of how it feels.**"
//
// So the deliverable is not a document — it is the GENERATABILITY. A hand-maintained table satisfies
// the first sentence and fails the second: it can only ever describe the estate as someone last
// remembered it. This suite renders the table from the live registry and fails when the committed
// artifact disagrees, which is the same contract `scripts/gen-map.mjs --check` already enforces for
// docs/MAP.md.
//
// ⚠ WHY A VITEST SUITE AND NOT A `scripts/*.mjs` GENERATOR, which is this repo's usual shape. Every
// existing generator (gen-map, generate-role-bundles, lint-withtenants) parses SOURCE TEXT with
// regexes, because plain node cannot import TypeScript. Doing that here would mean regex-parsing ~90
// object literals across 14 module files, and a MISREAD inventory is worse than no inventory at all
// — it is a confident wrong answer about what the estate exposes, which is precisely what criterion 6
// exists to prevent. Vitest is the only TypeScript-capable runner in this package's toolchain, so it
// imports the real `mcpTools` arrays and there is nothing to misparse.
//
// REGENERATE (from platform-nest/):
//     bash/CI     UPDATE_INVENTORY=1 npx vitest run src/modules/capability-inventory.test.ts
//     PowerShell  $env:UPDATE_INVENTORY=1; npx vitest run src/modules/capability-inventory.test.ts
//
// Deliberately NOT an npm script yet. It would need `cross-env` (not a dependency here) to be
// cross-platform, and adding it means editing package.json — which another session currently holds
// uncommitted. Adding a dependency to dodge a two-line documented command is the wrong trade, and
// staging a shared file to save a keystroke is how work gets swept.
//
// WHAT THIS TABLE DELIBERATELY DOES NOT CLAIM: refusal vocabulary and `work_activity` coverage are
// NOT derivable from a tool def, and `docs/modules/social-capability-inventory.md` (SMM-33) covers
// them for one module by reading controllers directly. That document is the deeper, hand-built
// treatment; this one is the estate-wide, always-current spine. Neither replaces the other, and this
// file does not pretend to the columns it cannot compute.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

const ARTIFACT = join(__dirname, "..", "..", "..", "docs", "modules", "CAPABILITY-INVENTORY.md");

const ALL_MODULES = [
  agencyModule, pmModule, itModule, monitoringModule, billingModule, clientsModule,
  knowledgeModule, automationConsoleModule, hrModule, assistantModule, searchModule,
  reportsModule, webdevModule, socialModule,
];

interface Row {
  owner: string;
  tool: string;
  method: string;
  endpoint: string;
  kind: "write" | "read";
  impact: string;
}

function cell(v: string | undefined, fallback = "—"): string {
  // A blank cell reads as "nothing here"; an em dash reads as "does not apply". The distinction is
  // the same one criterion 5 is about, applied to a table.
  return v && v.length ? `\`${v}\`` : fallback;
}

function render(rows: Row[], silentModules: string[]): string {
  const writes = rows.filter((r) => r.kind === "write");
  const byImpact = (i: string) => writes.filter((r) => r.impact === `\`${i}\``).length;
  const lines: string[] = [];
  lines.push("# Capability inventory — every MCP-reachable capability in the estate");
  lines.push("");
  lines.push("🤖 **GENERATED — do not edit by hand.** From `platform-nest/`:");
  lines.push("`UPDATE_INVENTORY=1 npx vitest run src/modules/capability-inventory.test.ts`");
  lines.push("(PowerShell: `$env:UPDATE_INVENTORY=1; npx vitest run src/modules/capability-inventory.test.ts`).");
  lines.push("Drift fails that suite, so this file cannot quietly describe an estate that no longer exists.");
  lines.push("");
  lines.push("Satisfies the agentic-native **exit-bar criterion 6**: one row per capability naming its");
  lines.push("endpoint, its MCP tool and its D14 impact class. The criterion's own test is that the table");
  lines.push("*can be generated* — a hand-kept one only ever describes the estate as someone last");
  lines.push("remembered it.");
  lines.push("");
  lines.push("**Not covered here, deliberately:** typed refusal vocabulary and `work_activity` coverage are");
  lines.push("not derivable from a tool definition. `social-capability-inventory.md` (SMM-33) covers those");
  lines.push("for one module by reading its controllers directly — the deeper treatment, of which this is");
  lines.push("the estate-wide spine, not a replacement.");
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- **${rows.length}** capabilities across **${new Set(rows.map((r) => r.owner)).size}** owners`);
  lines.push(`- **${writes.length}** writes · ${rows.length - writes.length} reads`);
  lines.push(`- Writes by impact: **high ${byImpact("high")}** · medium ${byImpact("medium")} · low ${byImpact("low")}`);
  lines.push("");
  lines.push("`high`/`medium` writes suspend for a human decision when the caller is unattended (D14, and");
  lines.push("see PERMISSION-CONTRACT §15 on why that is keyed on attendance rather than identity). `low`");
  lines.push("writes run directly. A write with NO impact class cannot exist — `impact-registry.test.ts`");
  lines.push("fails the build on one.");
  lines.push("");
  lines.push("An endpoint of — means the tool is declared but not callable over the hub (no");
  lines.push("`pathTemplate`), which the hub skips outright. Those are stubs awaiting their dispatch work.");
  lines.push("");
  // ⚠ A MODULE WITH NO TOOLS MUST BE VISIBLE, not absent. An inventory that simply omits it makes
  // "this module exposes nothing to agents" indistinguishable from "this module does not exist" —
  // which is the same empty-list-as-claim defect criterion 5 is about, committed by the very document
  // that exists to prevent confident wrong answers. Readiness-bar criterion 1 (tool parity) fails
  // for anything listed here, so it is stated rather than inferred from a gap in the table.
  if (silentModules.length) {
    lines.push("## Registered modules exposing NO capabilities");
    lines.push("");
    lines.push("Listed explicitly: an absent row would read as \"module does not exist\" rather than");
    lines.push("\"module reaches no agent\". Readiness-bar criterion 1 (tool parity) fails for each.");
    lines.push("");
    for (const k of silentModules) lines.push(`- **${k}** — registered in main.ts, contributes 0 MCP tools`);
    lines.push("");
  }
  lines.push("## Capabilities");
  lines.push("");
  lines.push("| Owner | Tool | Method | Endpoint | Kind | Impact |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.owner} | \`${r.tool}\` | ${r.method} | ${r.endpoint} | ${r.kind} | ${r.impact} |`);
  }
  lines.push("");
  return lines.join("\n");
}

let rendered: string;

describe("AGN-6 · capability inventory is generated, not remembered", () => {
  beforeAll(() => {
    resetModules();
    // core-tools self-registers at import; a reset without this omits the nine `iam.*` tools.
    resetCoreTools();
    registerIamCoreTools();
    for (const m of ALL_MODULES) registerModule(m);

    const rows: Row[] = [];
    const push = (owner: string, defs: McpToolDef[]) => {
      for (const d of defs) {
        rows.push({
          owner,
          tool: d.name,
          method: cell(d.method),
          endpoint: cell(d.pathTemplate),
          kind: d.write ? "write" : "read",
          impact: d.write ? cell(d.impact) : "—",
        });
      }
    };
    push("core", allCoreTools());
    for (const m of allModules()) push(m.key, m.mcpTools);
    // Stable order so the artifact does not churn on registration order alone.
    rows.sort((a, b) => (a.owner === b.owner ? a.tool.localeCompare(b.tool) : a.owner.localeCompare(b.owner)));
    const silent = allModules().filter((m) => m.mcpTools.length === 0).map((m) => m.key).sort();
    rendered = render(rows, silent);

    if (process.env.UPDATE_INVENTORY === "1") writeFileSync(ARTIFACT, rendered, "utf8");
  });

  it("renders a non-trivial table — an empty render would make the drift check vacuous", () => {
    expect(rendered.split("\n").filter((l) => l.startsWith("| ")).length).toBeGreaterThan(80);
    expect(rendered).toContain("| Owner | Tool | Method | Endpoint | Kind | Impact |");
  });

  it("🔴 the committed artifact matches the live registry", () => {
    expect(existsSync(ARTIFACT), `${ARTIFACT} is missing — run: npm run gen:capability-inventory`).toBe(true);
    const onDisk = readFileSync(ARTIFACT, "utf8").replace(/\r\n/g, "\n");
    expect(
      onDisk,
      "docs/modules/CAPABILITY-INVENTORY.md no longer matches the registry. A tool was added, removed " +
        "or reclassified without regenerating: run `npm run gen:capability-inventory`. This is the " +
        "whole point of criterion 6 — an inventory that can drift is an inventory that lies.",
    ).toBe(rendered.replace(/\r\n/g, "\n"));
  });

  it("a module exposing nothing is NAMED, not merely absent from the table", () => {
    const silent = allModules().filter((m) => m.mcpTools.length === 0).map((m) => m.key);
    for (const k of silent) {
      expect(
        rendered,
        `${k} contributes no MCP tools and is not named in the artifact — its absence would read as ` +
          `"module does not exist" instead of "module reaches no agent", which is the confident-wrong-` +
          `answer failure this inventory exists to prevent`,
      ).toContain(`**${k}** — registered in main.ts, contributes 0 MCP tools`);
    }
  });

  it("every row names an owner and a tool — a nameless capability is unauditable", () => {
    const bad = rendered
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Owner") && !l.startsWith("|---"))
      .filter((l) => {
        const cols = l.split("|").map((c) => c.trim());
        return !cols[1] || !cols[2] || cols[2] === "``";
      });
    expect(bad).toEqual([]);
  });
});
