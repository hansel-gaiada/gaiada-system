// M6-P4k — every n8n workflow's MCP `tools/call` must pass each argument its tool REQUIRES.
//
// Found live by the M6 P4 gate (2026-10-13): GH-12's cutover made `github.repoStatus` require `tenantId`, but
// `pipeline-delivery.json` kept calling it with `{ repo }` alone. The hub refused ("tenantId: required"), the
// flow's `Repo ready?` node read the refusal as "repo does not exist yet", and every run's code stage was
// released into a "repo needed" notice instead of `code.scaffold`. Nothing failed loudly; no test read both sides.
//
// This test reads both sides: the hub's own registered schemas (`inputSchema.required`) and every workflow's
// `jsonBody`. Tools the hub only learns at runtime (platform-nest module manifests: `webdev.*` and friends) are not
// in the static registry and are skipped; a call whose arguments are built dynamically (no literal `arguments: {`)
// or spread (`...x`) is skipped too. The coverage floor below keeps the test from passing while checking nothing.
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools, resetRegistry } from "./registry";
import { registerCoreTools } from "./tools";
import { registerAgentsTools } from "./agents-tools";
import { registerDeliveryTools } from "./delivery-tools";
import { registerPipelineTools } from "./pipeline-tools";
import { registerPlatformTools } from "./platform-tools";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { registerPmTools } from "./pm-tools";
import { registerWebdeskDeployTools } from "./webdesk-deploy-tools";
import { registerWorkActivityTools } from "./work-activity-tools";

const WORKFLOWS = join(__dirname, "..", "..", "automation", "workflows");

interface Call {
  file: string;
  node: string;
  tool: string;
  keys: string[] | null; // null: arguments are not a literal object (dynamic), so they cannot be checked statically
}

/** The literal object starting at `open` (a `{`), by brace depth; strings are skipped so a `}` inside one is inert. */
function objectAt(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < s.length && s[i] !== c) i += s[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(open, i + 1);
  }
  throw new Error(`unbalanced object at ${open}`);
}

/** Top-level keys of a JS object literal (`{ a: x, b, ...c }` -> ["a", "b", "..."]). */
function topLevelKeys(obj: string): string[] {
  const body = obj.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let expectKey = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < body.length && body[i] !== c) i += body[i] === "\\" ? 2 : 1;
      continue;
    }
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (depth === 0 && c === ",") expectKey = true;
    else if (depth === 0 && expectKey && /[A-Za-z_$.]/.test(c)) {
      const m = /^(\.\.\.)?([A-Za-z_$][\w$]*)/.exec(body.slice(i));
      if (m) {
        keys.push(m[1] ? "..." : m[2]);
        i += m[0].length - 1;
        expectKey = false;
      }
    }
  }
  return keys;
}

function workflowCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as { nodes?: Array<{ name: string; parameters?: { jsonBody?: unknown } }> };
    for (const n of doc.nodes ?? []) {
      const body = typeof n.parameters?.jsonBody === "string" ? n.parameters.jsonBody : "";
      if (!body.includes("tools/call")) continue;
      const name = /name:\s*"([A-Za-z]+\.[A-Za-z.]+)"/.exec(body);
      if (!name) continue;
      const args = /arguments:\s*\{/.exec(body);
      calls.push({ file, node: n.name, tool: name[1], keys: args ? topLevelKeys(objectAt(body, args.index + args[0].length - 1)) : null });
    }
  }
  return calls;
}

describe("workflow MCP calls pass every argument their tool requires (M6-P4k)", () => {
  let required: Map<string, string[]>;
  let calls: Call[];

  beforeAll(() => {
    expect(existsSync(WORKFLOWS), `automation/workflows not found at ${WORKFLOWS}`).toBe(true);
    resetRegistry();
    registerCoreTools();
    registerAgentsTools();
    registerDeliveryTools();
    registerPipelineTools();
    registerPlatformTools();
    registerPlatformWriteTools();
    registerPmTools();
    registerWebdeskDeployTools();
    registerWorkActivityTools();
    required = new Map(
      allTools().map((t) => [t.name, Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : []]),
    );
    calls = workflowCalls();
  });

  it("parses object keys the way the workflows write them", () => {
    expect(topLevelKeys("{ tenantId: $('Load + decide').first().json.tenantId, repo: x.slug }")).toEqual(["tenantId", "repo"]);
    expect(topLevelKeys("{ a: { b: 1, c: 2 }, d, ...e }")).toEqual(["a", "d", "..."]);
    expect(topLevelKeys("{ note: 'a, b: c', kind: \"x}\" }")).toEqual(["note", "kind"]);
  });

  it("checks a meaningful share of the calls (the floor keeps an empty scan from passing)", () => {
    const checkable = calls.filter((c) => c.keys !== null && required.has(c.tool));
    expect(checkable.length).toBeGreaterThanOrEqual(40);
    expect(checkable.some((c) => c.file === "pipeline-delivery.json" && c.tool === "github.repoStatus")).toBe(true);
  });

  it("no call omits a required argument", () => {
    const missing = calls
      .filter((c) => c.keys !== null && !c.keys.includes("...") && required.has(c.tool))
      .flatMap((c) => {
        const absent = (required.get(c.tool) ?? []).filter((r) => !c.keys!.includes(r));
        return absent.length ? [`${c.file} › ${c.node} › ${c.tool}: missing ${absent.join(", ")}`] : [];
      });
    expect(missing).toEqual([]);
  });
});
