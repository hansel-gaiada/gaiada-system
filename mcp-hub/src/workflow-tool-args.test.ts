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

// AIP-03b — every workflow call to a gateway-backed AI tool must name the company it is acting for.
//
// Release 448 records each gateway call as an `ai_usage_events` row, and the company comes ONLY from the tool call's own
// `tenantId` argument (gateway-client.ts). A call without one writes no row, which is correct (never bill the wrong
// company) but silently loses the usage. So each of these calls carries `tenantId` as an n8n EXPRESSION read from the
// workflow's own data (never a literal id: the repo is public and the ERP is multi-company), or, for a workflow that has
// no company in its data, the owner-chosen `$env.N8N_USAGE_TENANT_ID` (empty by default = record nothing).
const AI_TOOLS = ["llm.summarize", "llm.extract", "design.prototype"];
/** Workflows with no company anywhere in their data; they may only use the env fallback. */
const COMPANY_AGNOSTIC: Record<string, string> = { "summarize-via-mcp.json": "$env.N8N_USAGE_TENANT_ID" };

/** The source text of the `tenantId:` value inside a call's literal arguments object, or null when absent. */
function tenantIdExpr(body: string): string | null {
  const args = /arguments:\s*\{/.exec(body);
  if (!args) return null;
  const obj = objectAt(body, args.index + args[0].length - 1);
  const at = /(^|[{,]\s*)tenantId:\s*/.exec(obj);
  if (!at) return null;
  // The value runs to the next top-level comma (strings and brackets are skipped by depth).
  let depth = 0;
  let i = at.index + at[0].length;
  const start = i;
  for (; i < obj.length - 1; i++) {
    const c = obj[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < obj.length && obj[i] !== c) i += obj[i] === "\\" ? 2 : 1;
      continue;
    }
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (depth === 0 && c === ",") break;
  }
  return obj.slice(start, i).trim();
}

describe("workflow AI calls name their company, as an expression (AIP-03b)", () => {
  const aiCalls = () =>
    readdirSync(WORKFLOWS)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .flatMap((file) => {
        const doc = JSON.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as { nodes?: Array<{ name: string; parameters?: { jsonBody?: unknown } }> };
        return (doc.nodes ?? []).flatMap((n) => {
          const body = typeof n.parameters?.jsonBody === "string" ? n.parameters.jsonBody : "";
          const tool = /name:\s*"([A-Za-z]+\.[A-Za-z.]+)"/.exec(body)?.[1];
          return body.includes("tools/call") && tool && AI_TOOLS.includes(tool) ? [{ file, node: n.name, tool, tenant: tenantIdExpr(body) }] : [];
        });
      });

  it("reads the tenantId argument the way the workflows write it", () => {
    expect(tenantIdExpr(`x tools/call arguments: { tenantId: $('A b').first().json.tenantId, text: y }`)).toBe("$('A b').first().json.tenantId");
    expect(tenantIdExpr(`arguments: { kind: "prd", tenantId: $env.X || undefined }`)).toBe("$env.X || undefined");
    expect(tenantIdExpr(`arguments: { text: y }`)).toBeNull();
  });

  it("finds every AI call (the floor keeps an empty scan from passing)", () => {
    const calls = aiCalls();
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const tool of AI_TOOLS) expect(calls.some((c) => c.tool === tool), `no workflow calls ${tool}`).toBe(true);
  });

  it("every call passes a tenantId expression, never a literal id", () => {
    const bad = aiCalls().flatMap((c) => {
      if (c.tenant === null) return [`${c.file} › ${c.node} › ${c.tool}: no tenantId argument`];
      const fromData = /\$json|\$\(|\$env\./.test(c.tenant);
      const literal = /^["'`]|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(c.tenant);
      return fromData && !literal ? [] : [`${c.file} › ${c.node} › ${c.tool}: tenantId is not an expression over the workflow's data (${c.tenant})`];
    });
    expect(bad).toEqual([]);
  });

  it("a company-agnostic workflow uses only the owner-chosen env fallback; no other workflow does", () => {
    const wrong = aiCalls().flatMap((c) => {
      const agnostic = COMPANY_AGNOSTIC[c.file];
      const usesEnv = (c.tenant ?? "").includes("$env.N8N_USAGE_TENANT_ID");
      if (agnostic) return c.tenant?.includes(agnostic) ? [] : [`${c.file} › ${c.node}: company-agnostic, must use ${agnostic}`];
      return usesEnv ? [`${c.file} › ${c.node}: has a company in its data; do not use the env fallback`] : [];
    });
    expect(wrong).toEqual([]);
  });
});
