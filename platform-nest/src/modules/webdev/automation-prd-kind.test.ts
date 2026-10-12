// M6-P4e -- the delivery automation picks the site kind from the signed PRD and feeds code.scaffold v2
// the inputs it now requires.
//
// Like slug-parity.test.ts, this EXTRACTS AND EXECUTES the shipped workflow nodes (wd-provision.json and
// pipeline-delivery.json) instead of restating them: a hand-copied expectation would keep passing while
// the real workflow drifted. Nothing here needs a service.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STACK_TO_FRAMEWORK } from "./provisioning.service";

const DIR = join(__dirname, "..", "..", "..", "..", "automation", "workflows");

interface WfNode { name: string; type: string; parameters: { jsCode?: string; jsonBody?: string } }
interface Wf { nodes: WfNode[]; connections: Record<string, { main: Array<Array<{ node: string }>> }> }
const load = (f: string): Wf => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Wf;
const node = (wf: Wf, name: string): WfNode => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`workflow has no node "${name}"`);
  return n;
};
/** Every node name an edge leaves `from` through output `idx`. */
const targets = (wf: Wf, from: string, idx = 0): string[] => (wf.connections[from]?.main[idx] ?? []).map((e) => e.node);
/** Every (source, output) that feeds `to`. */
const incoming = (wf: Wf, to: string): string[] => {
  const out: string[] = [];
  for (const [src, c] of Object.entries(wf.connections)) c.main.forEach((grp, i) => { if (grp.some((e) => e.node === to)) out.push(`${src}#${i}`); });
  return out;
};

type Json = Record<string, unknown>;
const sse = (result: unknown): { json: { data: string } } => ({ json: { data: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n` } });
const ok = (payload: unknown) => sse({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const err = (text: string) => sse({ isError: true, content: [{ type: "text", text }] });

/** Run a Code node the way n8n does: `$input.first()` is the incoming item, `$('Name').first()` an earlier node's. */
function run(code: string, input: { json: Json }, named: Record<string, Json>): Json {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function("$input", "$", "$env", code) as (i: unknown, d: unknown, e: unknown) => Array<{ json: Json }>;
  const out = fn(
    { first: () => input },
    (name: string) => {
      if (!(name in named)) throw new Error(`node "${name}" not wired in this test`);
      return { first: () => ({ json: named[name] }) };
    },
    {},
  );
  return out[0].json;
}

describe("M6-P4e -- wd-provision.json takes the site kind from the signed PRD", () => {
  const wf = load("wd-provision.json");
  const provision = node(wf, "MCP webdev.provisionSite (wf:delivery)");
  const approval = node(wf, "MCP approvals.request (webdev.provisionSite)");

  it("sends `stack` and hardcodes no framework, on the call AND on the approval it files", () => {
    for (const n of [provision, approval]) {
      expect(n.parameters.jsonBody).toContain("stack:");
      expect(n.parameters.jsonBody).not.toMatch(/framework/);
      expect(n.parameters.jsonBody).not.toContain("vite");
    }
    expect(provision.parameters.jsonBody).toContain("stack: $json.stack");
  });

  it("reads the PRD before provisioning, and a missing/unusable hint never reaches the provision call", () => {
    expect(incoming(wf, "MCP webdev.provisionSite (wf:delivery)")).toEqual(["PRD stack hint present?#0"]);
    expect(targets(wf, "When Executed by Another Workflow")).toEqual(["MCP pipeline.getRun (PRD stack hint)"]);
    expect(targets(wf, "PRD stack hint present?", 1)).toEqual(["MCP notify (no PRD stack hint)"]);
    expect(targets(wf, "MCP notify (no PRD stack hint)")).toEqual(["Return (no usable stack hint)"]);
  });

  const extract = node(wf, "Extract PRD stack hint").parameters.jsCode as string;
  const trigger = { tenantId: "t1", runId: "r1" };
  const hint = (prdText: string | null, via: "ok" | "err" = "ok"): Json => {
    const stages = prdText === null ? [] : [{ name: "prd_extract", artifact_ref: prdText }];
    return run(extract, via === "ok" ? ok({ id: "r1", stages }) : err("boom"), { "When Executed by Another Workflow": trigger });
  };

  it("the runtime vocabulary is exactly the platform's STACK_TO_FRAMEWORK keys (no drift)", () => {
    const m = /const KNOWN = (\[[^\]]*\]);/.exec(extract);
    expect(m).not.toBeNull();
    expect([...(JSON.parse(m![1]) as string[])].sort()).toEqual(Object.keys(STACK_TO_FRAMEWORK).sort());
  });

  it.each([
    ["Stack: static", "static"],
    ["**Stack:** C", "c"],
    ["- Stack: full stack (Next + Nest)", "full-stack"],
    ["## Tech stack: WordPress + MySQL", "wordpress"],
    ["> Stack = Next.js", "next"],
    ["Stack: B", "b"],
    ["Stack: Astro", "astro"],
  ])("%s -> stack %s", (line, expected) => {
    const r = hint(`# Acme\n\nObjective: a site\n${line}\nPages: home\n`);
    expect(r.stack).toBe(expected);
    expect(r.ok).toBe(true);
    // and the platform maps what the workflow extracted (never `unsupported_stack`)
    expect(STACK_TO_FRAMEWORK[expected]).toBeDefined();
  });

  it("a PRD with no Stack line is refused loudly as prd_stack_missing, never defaulted", () => {
    const r = hint("# Acme\n\nObjective: a site\nPages: home\n");
    expect(r).toMatchObject({ ok: false, stack: "" });
    expect(String(r.reason)).toMatch(/^prd_stack_missing/);
  });

  it("an unrecognized stack token is refused as unsupported_stack", () => {
    const r = hint("Stack: Elixir Phoenix");
    expect(r).toMatchObject({ ok: false, stack: "" });
    expect(String(r.reason)).toMatch(/^unsupported_stack/);
  });

  it("a run with no prd_extract stage, or an unreadable run, is refused too", () => {
    expect(hint(null)).toMatchObject({ ok: false });
    const r = hint("x", "err");
    expect(r).toMatchObject({ ok: false });
    expect(String(r.reason)).toMatch(/^prd_unreadable/);
  });
});

describe("M6-P4e -- pipeline-delivery.json code stage", () => {
  const wf = load("pipeline-delivery.json");

  it("code.scaffold is reachable ONLY through the completion check (parks otherwise)", () => {
    expect(incoming(wf, "MCP code.scaffold")).toEqual(["Scaffold ready?#0"]);
    expect(targets(wf, "Scaffold ready?", 1)).toEqual(["MCP notify code parked"]);
    expect(targets(wf, "Site provisioned?", 1)).toEqual(["MCP notify code parked"]);
    expect(targets(wf, "MCP notify code parked")).toEqual(["Respond (code parked)"]);
    // the repo gate now leads into the provisioned-site read, not straight into the scaffold
    expect(targets(wf, "Repo exists?", 0)).toEqual(["MCP webdev.provisionedSites.list"]);
  });

  it("passes contractSnapshotId, siteKind and BOTH artifact refs to code.scaffold", () => {
    const body = node(wf, "MCP code.scaffold").parameters.jsonBody as string;
    for (const k of ["contractSnapshotId: $json.contractSnapshotId", "siteKind: $json.siteKind", "prdArtifact: $json.prdRef", "prototypeArtifact: $json.protoRef", "provisionedSiteId: $json.siteId"]) {
      expect(body).toContain(k);
    }
  });

  const complete = node(wf, "Provisioning complete?").parameters.jsCode as string;
  const pickedSite = { tenantId: "t1", runId: "r1", prdRef: "stage:p", protoRef: "stage:d", slug: "acme", framework: "vite", siteId: "site-1" };
  const verdict = (site: Json): Json => run(complete, ok(site), { "Pick provisioned site": pickedSite });
  const done = { state: "complete", next: "done", contractSnapshotId: "snap-1", error: null };

  it("parks (retryable reason, no snapshot id) until completion.state is complete", () => {
    for (const state of [null, "repo_created", "tenant_created", "failed"]) {
      const r = verdict({ framework: "vite", completion: { state, next: "tenant", contractSnapshotId: null, error: null } });
      expect(r.ready2).toBe("false");
      expect(String(r.reason)).toMatch(/provisioning not complete yet/);
    }
    expect(verdict({ framework: "vite", completion: null }).ready2).toBe("false");
  });

  it("parks when complete but no snapshot is pinned", () => {
    const r = verdict({ framework: "vite", completion: { ...done, contractSnapshotId: null } });
    expect(r.ready2).toBe("false");
    expect(String(r.reason)).toMatch(/no contract snapshot/);
  });

  it.each([["astro", "astro"], ["vite", "astro"], ["node", "node"], ["nextjs", "node"], ["wp", "wp"]])(
    "complete %s site -> siteKind %s with the pinned snapshot",
    (framework, siteKind) => {
      const r = verdict({ framework, completion: done });
      expect(r).toMatchObject({ ready2: "true", siteKind, contractSnapshotId: "snap-1", prdRef: "stage:p", protoRef: "stage:d", siteId: "site-1" });
    },
  );

  it("an unmappable framework parks instead of guessing a kind", () => {
    const r = verdict({ framework: "drupal", completion: done });
    expect(r.ready2).toBe("false");
    expect(String(r.reason)).toMatch(/unsupported site framework/);
  });

  it("parks when the PRD or design stage has no artifact to hand the scaffold", () => {
    const r = run(complete, ok({ framework: "vite", completion: done }), { "Pick provisioned site": { ...pickedSite, protoRef: "" } });
    expect(r.ready2).toBe("false");
  });

  it("'Pick provisioned site' ignores failed sites and parks when there is none", () => {
    const pick = node(wf, "Pick provisioned site").parameters.jsCode as string;
    const repoReady = { tenantId: "t1", runId: "r1", prd: "x", proto: "y", prdRef: "stage:p", protoRef: "stage:d", slug: "acme" };
    const none = run(pick, ok([{ id: "s0", status: "failed", framework: "vite" }]), { "Repo ready?": repoReady });
    expect(none).toMatchObject({ hasSite: "false", siteId: "" });
    const one = run(pick, ok([{ id: "s0", status: "failed", framework: "vite" }, { id: "s1", status: "ready", framework: "node" }]), { "Repo ready?": repoReady });
    expect(one).toMatchObject({ hasSite: "true", siteId: "s1", framework: "node" });
    expect(run(pick, ok([]), { "Repo ready?": repoReady })).toMatchObject({ hasSite: "false" });
  });

  // M6-P4b2: the code.scaffold call names the provisioned site, so the finished job hands its tree to platform-nest, which
  // commits it as the repo's first fill with the ERP App. The node's expression is EVALUATED here against the real output
  // of 'Provisioning complete?', not string-matched.
  it("M6-P4b2: code.scaffold carries provisionedSiteId = the completed site, from the completion check's own output", () => {
    const ready = verdict({ framework: "astro", completion: done });
    const expr = String(node(wf, "MCP code.scaffold").parameters.jsonBody);
    expect(expr.startsWith("={{") && expr.endsWith("}}")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const evaluate = new Function("$json", "$env", `return (${expr.slice(3, -2)});`) as (j: Json, e: Json) => string;
    const rpc = JSON.parse(evaluate(ready, {})) as { method: string; params: { name: string; arguments: Json } };
    expect(rpc.method).toBe("tools/call");
    expect(rpc.params.name).toBe("code.scaffold");
    expect(rpc.params.arguments).toMatchObject({
      tenantId: "t1", runId: "r1", contractSnapshotId: "snap-1", siteKind: "astro", prdArtifact: "stage:p", prototypeArtifact: "stage:d",
      provisionedSiteId: "site-1",
    });
    // the workflow never names a remote, a token or a mode: it cannot select a push
    expect(JSON.stringify(rpc.params.arguments)).not.toMatch(/remote|token|mode|push/i);
    // and the commit itself is not a workflow node: the job's completion triggers it (no node calls the commit tool)
    expect(wf.nodes.some((n) => String(n.parameters.jsonBody ?? "").includes("commitScaffold"))).toBe(false);
  });

  it("'Load + decide' emits stage:<id> refs for the signed PRD and the accepted design", () => {
    const decide = node(wf, "Load + decide").parameters.jsCode as string;
    const runDoc = {
      id: "r1", tenant_id: "t1", title: "Acme Site",
      stages: [
        { id: "s-prd", name: "prd_extract", artifact_ref: "the prd text" },
        { id: "s-d1", name: "claude_design", artifact_ref: "design v1" },
        { id: "s-d2", name: "claude_design", artifact_ref: "design v2" },
      ],
      gates: [], scopeSignoffs: [],
    };
    const r = run(decide, ok(runDoc), {});
    expect(r).toMatchObject({ prdRef: "stage:s-prd", protoRef: "stage:s-d2" }); // the LATEST design
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// M6-P4e2 -- a parked delivery code stage resumes by itself on ev/webdev.site.contract_pinned.
//
// The driver below WALKS the shipped workflow graph: it executes every Code node, evaluates every IF and every
// expression in a node's body, answers each MCP call from a small stateful fake of the platform, and stops at the
// Respond node. So the scenarios exercise the real wiring (trigger -> site read -> run read -> Load + decide -> the
// EXISTING code-stage path), not a restatement of it. Any tool the fake does not know is a test failure.
// ════════════════════════════════════════════════════════════════════════════════════════════════
interface LNode {
  name: string;
  type: string;
  webhookId?: string;
  parameters: {
    path?: string; httpMethod?: string; responseMode?: string; jsCode?: string; jsonBody?: string; responseBody?: string;
    conditions?: { conditions: Array<{ leftValue: string; rightValue: string; operator: { operation: string } }> };
  };
}
interface LWf { nodes: LNode[]; connections: Record<string, { main: Array<Array<{ node: string }>> }> }
const loadL = (f: string): LWf => JSON.parse(readFileSync(join(DIR, f), "utf8")) as LWf;

class ToolError extends Error {}
interface Call { node: string; tool: string; args: Json }
interface Driven { visited: string[]; calls: Call[]; response: Json | null; out: Record<string, Json> }
type Mcp = Record<string, (args: Json) => unknown>;
interface Item { json: Json }

function drive(wf: LWf, start: string, first: Item, mcp: Mcp, store: Json, env: Json = { N8N_BRIDGE_SECRET: "s3cret" }): Driven {
  const out: Record<string, Json> = {};
  const visited: string[] = [];
  const calls: Call[] = [];
  let response: Json | null = null;
  const nodeOf = (name: string): LNode => {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`no node "${name}"`);
    return n;
  };
  // n8n: `$('X')` on a node that has not run in THIS execution throws.
  const dollar = (name: string) => {
    if (!(name in out)) throw new Error(`Node '${name}' hasn't been executed`);
    return { first: () => ({ json: out[name] }) };
  };
  const expr = (e: string, input: Item): unknown => {
    if (!(e.startsWith("={{") && e.endsWith("}}"))) throw new Error(`not a single expression: ${e.slice(0, 40)}`);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function("$json", "$env", "$", `return (${e.slice(3, -2)});`)(input.json, env, dollar);
  };
  const queue: Array<{ name: string; input: Item }> = [{ name: start, input: first }];
  while (queue.length) {
    const { name, input } = queue.shift()!;
    visited.push(name);
    const n = nodeOf(name);
    let branch = 0;
    let output: Json = input.json;
    if (n.type === "n8n-nodes-base.webhook") {
      output = input.json;
    } else if (n.type === "n8n-nodes-base.code") {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const fn = new Function("$input", "$", "$env", "$getWorkflowStaticData", n.parameters.jsCode as string) as (...a: unknown[]) => Item[];
      output = fn({ first: () => input }, dollar, env, () => store)[0].json;
    } else if (n.type === "n8n-nodes-base.if") {
      const cs = n.parameters.conditions!.conditions;
      expect(cs.every((c) => c.operator.operation === "equals")).toBe(true);
      branch = cs.every((c) => String(expr(c.leftValue, input)) === c.rightValue) ? 0 : 1;
    } else if (n.type === "n8n-nodes-base.httpRequest") {
      const rpc = JSON.parse(expr(n.parameters.jsonBody as string, input) as string) as { params: { name: string; arguments: Json } };
      const { name: tool, arguments: args } = rpc.params;
      calls.push({ node: name, tool, args });
      const handler = mcp[tool];
      if (!handler) throw new Error(`UNEXPECTED MCP CALL ${tool} from "${name}"`);
      try { output = ok(handler(args)).json; } catch (e) { if (e instanceof ToolError) output = err(e.message).json; else throw e; }
    } else if (n.type === "n8n-nodes-base.respondToWebhook") {
      response = JSON.parse(expr(n.parameters.responseBody as string, input) as string) as Json;
      out[name] = input.json;
      continue;
    } else {
      throw new Error(`the driver does not run a ${n.type} ("${name}")`);
    }
    out[name] = output;
    for (const e of wf.connections[name]?.main[branch] ?? []) queue.push({ name: e.node, input: { json: output } });
  }
  return { visited, calls, response, out };
}

const TENANT = "t1", RUN = "r1", SITE = "11111111-1111-4111-8111-111111111111";
const gate = (kind: string, stage: string | null, decision: string, at: string): Json => ({ id: `g-${kind}`, kind, stage_id: stage, status: "decided", decision, created_at: at });
interface World { run: { stages: Json[]; gates: Json[] } & Json; site: Json }
/** A run whose design is fully accepted (all three beats) and whose site has finished provisioning. */
function world(): World {
  return {
    run: {
      id: RUN, tenant_id: TENANT, title: "Acme Site", status: "active",
      stages: [{ id: "s-prd", name: "prd_extract", artifact_ref: "prd text" }, { id: "s-d1", name: "claude_design", artifact_ref: "design text" }],
      gates: [
        gate("prd_sign", null, "signed", "2026-10-01"), gate("pm_review", "s-d1", "approved", "2026-10-02"),
        gate("customer_feedback", "s-d1", "approved", "2026-10-03"), gate("pm_approval", "s-d1", "approved", "2026-10-04"),
      ],
      scopeSignoffs: [{ party: "provider" }, { party: "client" }],
    },
    site: { id: SITE, tenantId: TENANT, pipelineRunId: RUN, status: "provisioned", framework: "astro", completion: { state: "complete", next: "done", contractSnapshotId: "snap-1", error: null }, scaffold: null },
  };
}
/** The platform as the workflow sees it through the hub. createStage dedupes claude_code like platform-nest does (SINGLE_SHOT). */
function platform(w: World): Mcp {
  return {
    "pipeline.getRun": () => w.run,
    "github.repoStatus": () => ({ exists: true, fullName: "gaiada/acme-site" }),
    "webdev.provisionedSites.list": () => [{ id: SITE, status: w.site.status, framework: w.site.framework }],
    "webdev.provisionedSites.get": (a) => {
      if (a.siteId !== SITE) throw new ToolError("provisioned site not found");
      return w.site;
    },
    "code.scaffold": () => ({ goalId: "goal-1", status: "queued", content: "code.scaffold v2 job goal-1 queued" }),
    "pipeline.createStage": (a) => {
      const existing = w.run.stages.find((s) => s.name === a.name);
      if (existing) return { id: existing.id, deduped: true };
      w.run.stages.push({ id: "s-code", name: a.name, status: a.status, artifact_ref: a.artifactRef });
      return { id: "s-code" };
    },
    "pipeline.openGate": () => ({ id: "gate-new" }),
    notify: () => ({ ok: true }),
  };
}
const SECRET = "s3cret";
const envelope = (over: Json = {}): Json => ({
  v: 1, id: "ev-1", eventType: "webdev.site.contract_pinned", entityType: "webdev_provisioned_site", tenantId: TENANT, entityId: SITE,
  originSite: "erp", createdAt: "2026-10-12T00:00:00Z", payload: { snapshotId: "snap-1", contractVersion: "1.0.0" }, ...over,
});
const hook = (body: Json, secret: string | null = SECRET): Item => ({ json: { headers: secret === null ? {} : { "x-gaiada-bridge-secret": secret }, body } });
const gateDecided = (): Item => hook({ v: 1, id: "ev-g1", eventType: "pipeline.gate.decided", entityType: "pipeline_gate", tenantId: TENANT, entityId: "gate-x", payload: { runId: RUN } });
const PINNED = "Trigger: site.contract_pinned";
/** Fire the pinned event at the workflow: the webhook node hands its item to the first node behind it. */
const fire = (w: World, store: Json, body: Json = envelope(), secret: string | null = SECRET): Driven =>
  drive(loadL("pipeline-delivery.json"), "Verify (pinned)", hook(body, secret), platform(w), store);
const scaffoldCalls = (d: Driven): Call[] => d.calls.filter((c) => c.tool === "code.scaffold");
const WRITE_TOOLS = ["code.scaffold", "pipeline.createStage", "pipeline.openGate", "design.prototype", "deploy.staging", "deploy.production", "pipeline.updateRun"];
const writes = (d: Driven): string[] => d.calls.map((c) => c.tool).filter((t) => WRITE_TOOLS.includes(t));

describe("M6-P4e2 -- pipeline-delivery.json resumes a parked code stage on ev/webdev.site.contract_pinned", () => {
  const wf = load("pipeline-delivery.json");
  const lwf = loadL("pipeline-delivery.json");

  it("every connection of every shipped workflow names an existing node, and node names are unique", () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
      const w = load(f);
      const names = w.nodes.map((n) => n.name);
      expect(new Set(names).size, `${f}: duplicate node names`).toBe(names.length);
      for (const [from, c] of Object.entries(w.connections)) {
        expect(names, `${f}: connection from unknown node "${from}"`).toContain(from);
        for (const grp of c.main) for (const e of grp) expect(names, `${f}: "${from}" -> unknown node "${e.node}"`).toContain(e.node);
      }
    }
  });

  it("the trigger is a POST webhook on ev/webdev.site.contract_pinned, answering from a Respond node, with its own webhookId", () => {
    const t = lwf.nodes.find((n) => n.name === PINNED)!;
    expect(t.type).toBe("n8n-nodes-base.webhook");
    expect(t.parameters).toMatchObject({ httpMethod: "POST", path: "ev/webdev.site.contract_pinned", responseMode: "responseNode" });
    const hooks = lwf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook");
    expect(new Set(hooks.map((h) => h.webhookId)).size).toBe(hooks.length);
    expect(new Set(hooks.map((h) => h.parameters.path)).size).toBe(hooks.length);
    expect(targets(wf, PINNED)).toEqual(["Verify (pinned)"]);
  });

  it("it checks x-gaiada-bridge-secret exactly as the other two triggers do (same first lines), and a bad or missing secret throws", () => {
    const head = (name: string): string => String(node(wf, name).parameters.jsCode).split("\n").slice(0, 4).join("\n");
    expect(head("Verify (pinned)")).toBe(head("Verify (gate)"));
    expect(head("Verify (pinned)")).toBe(head("Verify (scope)"));
    expect(() => fire(world(), {}, envelope(), "wrong")).toThrow(/bad bridge secret/);
    expect(() => fire(world(), {}, envelope(), null)).toThrow(/bad bridge secret/);
    expect(() => fire(world(), {}, envelope({ v: 2 }))).toThrow(/bad envelope v/);
  });

  it("the wiring: site read -> eligibility -> the EXISTING run read; ineligible -> the existing noop response", () => {
    expect(targets(wf, "Verify (pinned)")).toEqual(["MCP webdev.provisionedSites.get (pinned)"]);
    expect(targets(wf, "MCP webdev.provisionedSites.get (pinned)")).toEqual(["Parse pinned site"]);
    expect(targets(wf, "Parse pinned site")).toEqual(["Resume code?"]);
    expect(targets(wf, "Resume code?", 0)).toEqual(["MCP getRun"]);
    expect(targets(wf, "Resume code?", 1)).toEqual(["Respond (noop)"]);
    expect(String(node(wf, "MCP webdev.provisionedSites.get (pinned)").parameters.jsonBody)).toContain("siteId: $json.siteId");
  });

  it("code.scaffold stays ONE node with ONE way in; the new trigger reaches it only through the existing path", () => {
    expect(lwf.nodes.filter((n) => String(n.parameters.jsonBody ?? "").includes('"code.scaffold"')).map((n) => n.name)).toEqual(["MCP code.scaffold"]);
    expect(incoming(wf, "MCP code.scaffold")).toEqual(["Scaffold ready?#0"]);
    const seen = new Set<string>([PINNED]);
    const q = [PINNED];
    while (q.length) for (const nx of (wf.connections[q.shift()!]?.main ?? []).flat().map((e) => e.node)) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
    for (const n of ["MCP getRun", "Load + decide", "Release code?", "MCP github.repoStatus", "Provisioning complete?", "Scaffold ready?", "MCP code.scaffold", "MCP createStage code", "MCP openGate web-dev", "Respond (code)"]) {
      expect(seen.has(n), `${n} reachable from the pinned trigger`).toBe(true);
    }
  });

  it("every tool the new nodes call is in wf:delivery's hub allow-list", () => {
    const policy = readFileSync(join(DIR, "..", "..", "mcp-hub", "src", "automation-policy.ts"), "utf8");
    const line = policy.split("\n").find((l) => l.includes('"wf:delivery"'))!;
    const body = String(node(wf, "MCP webdev.provisionedSites.get (pinned)").parameters.jsonBody);
    const tool = /name: "([^"]+)"/.exec(body)![1];
    expect(tool).toBe("webdev.provisionedSites.get");
    expect(line).toContain(`"${tool}"`);
  });

  it("a PARKED stage resumes: the normal path parks, then the event takes the SAME code path and starts exactly one scaffold", () => {
    const w = world();
    w.site.completion = { state: "tenant_ready", next: "complete", contractSnapshotId: null, error: null };
    // 1. the gate path parks it, retryable, and starts nothing
    const parked = drive(lwf, "Verify (gate)", gateDecided(), platform(w), {});
    expect(parked.response).toMatchObject({ ok: true, action: "code_parked", retryable: true });
    expect(scaffoldCalls(parked)).toHaveLength(0);
    // 2. §08 completion lands: the pinned snapshot and the event
    w.site.completion = { state: "complete", next: "done", contractSnapshotId: "snap-1", error: null };
    const resumed = fire(w, {});
    expect(resumed.response).toMatchObject({ ok: true, action: "released_code", runId: RUN });
    expect(scaffoldCalls(resumed)).toHaveLength(1);
    expect(writes(resumed)).toEqual(["code.scaffold", "pipeline.createStage", "pipeline.openGate"]);
    expect(resumed.visited.slice(0, 6)).toEqual(["Verify (pinned)", "MCP webdev.provisionedSites.get (pinned)", "Parse pinned site", "Resume code?", "MCP getRun", "Load + decide"]);
  });

  it("the resumed scaffold call carries EXACTLY the arguments the normal gate path sends", () => {
    const viaGate = drive(lwf, "Verify (gate)", gateDecided(), platform(world()), {});
    const viaPinned = fire(world(), {});
    expect(scaffoldCalls(viaGate)).toHaveLength(1);
    expect(scaffoldCalls(viaPinned)).toHaveLength(1);
    expect(scaffoldCalls(viaPinned)[0].args).toEqual(scaffoldCalls(viaGate)[0].args);
    expect(scaffoldCalls(viaPinned)[0].args).toEqual({
      tenantId: TENANT, runId: RUN, contractSnapshotId: "snap-1", siteKind: "astro", prdArtifact: "stage:s-prd", prototypeArtifact: "stage:s-d1",
      repo: "acme-site", provisionedSiteId: SITE,
    });
    // the claude_code stage and its web-dev review gate come out the same way too
    expect(writes(viaPinned)).toEqual(writes(viaGate));
    expect(viaPinned.response).toEqual(viaGate.response);
  });

  it("a normal gate-path execution is NOT changed by the guard (the pinned node never ran there)", () => {
    const w = world();
    w.run.gates = w.run.gates.filter((g) => g.kind !== "pm_approval"); // beat 3 still to open
    const r = drive(lwf, "Verify (gate)", gateDecided(), platform(w), {});
    expect(r.response).toMatchObject({ ok: true, action: "opened_pm_approval" });
    expect(r.calls.map((c) => c.tool)).toContain("pipeline.openGate");
  });

  describe("everything else is a noop that starts and writes nothing", () => {
    const expectNoop = (d: Driven, why: RegExp): void => {
      expect(d.response).toMatchObject({ ok: true, action: "noop" });
      expect(String(d.response?.reason)).toMatch(why);
      expect(writes(d)).toEqual([]);
    };

    it("no run: the site is not tied to a pipeline run", () => {
      const w = world();
      w.site.pipelineRunId = null;
      const d = fire(w, {});
      expectNoop(d, /not tied to a pipeline run/);
      expect(d.calls.map((c) => c.tool)).toEqual(["webdev.provisionedSites.get"]); // never even reads a run
    });

    it("an unknown site (404) is a noop; any other read failure THROWS so the bridge redelivers", () => {
      const w = world();
      expectNoop(fire(w, {}, envelope({ entityId: "22222222-2222-4222-8222-222222222222" })), /not found/);
      const m = platform(w);
      m["webdev.provisionedSites.get"] = () => { throw new ToolError("platform /api/t1/modules/webdev/provisioned-sites/x 503"); };
      expect(() => drive(lwf, "Verify (pinned)", hook(envelope()), m, {})).toThrow(/provisioned-site read failed/);
    });

    it("the site is in another state: failed, not complete, no pin, a different pin, another company's", () => {
      const cases: Array<[(w: World) => void, RegExp]> = [
        [(w) => { w.site.status = "failed"; }, /failed provisioning/],
        [(w) => { w.site.completion = { state: "tenant_ready", next: "complete", contractSnapshotId: null, error: null }; }, /not complete \(state: tenant_ready\)/],
        [(w) => { w.site.completion = { state: "complete", next: "done", contractSnapshotId: null, error: null }; }, /not complete/],
        [(w) => { w.site.completion = null; }, /not complete \(state: none\)/],
        [(w) => { w.site.completion = { state: "complete", next: "done", contractSnapshotId: "snap-2", error: null }; }, /no longer the pinned one/],
        [(w) => { w.site.tenantId = "t-other"; }, /another company/],
      ];
      for (const [mutate, why] of cases) {
        const w = world();
        mutate(w);
        expectNoop(fire(w, {}), why);
      }
    });

    it("an event that is not a pinned-site event is a noop", () => {
      expectNoop(fire(world(), {}, envelope({ eventType: "webdev.site.provision_registered" })), /not a webdev\.site\.contract_pinned event/);
      expectNoop(fire(world(), {}, envelope({ entityType: "pipeline_run" })), /not a webdev\.site\.contract_pinned event/);
    });

    it("a run that is not at the code stage yet never gets its design released, a gate opened or a revision started", () => {
      const noDesign = world(); noDesign.run.stages = noDesign.run.stages.filter((s) => s.name !== "claude_design"); noDesign.run.gates = noDesign.run.gates.filter((g) => g.kind === "prd_sign");
      expectNoop(fire(noDesign, {}), /next action would be: release_design/);
      const beat3 = world(); beat3.run.gates = beat3.run.gates.filter((g) => g.kind !== "pm_approval");
      expectNoop(fire(beat3, {}), /next action would be: open_gate/);
      const beat2 = world(); beat2.run.gates = beat2.run.gates.filter((g) => !["pm_approval", "customer_feedback"].includes(String(g.kind)));
      expectNoop(fire(beat2, {}), /next action would be: open_gate/);
      const revise = world(); revise.run.gates = revise.run.gates.map((g) => (g.kind === "customer_feedback" ? { ...g, decision: "changes_requested" } : g));
      expectNoop(fire(revise, {}), /next action would be: revise_design/);
      const unsigned = world(); unsigned.run.gates = unsigned.run.gates.filter((g) => g.kind !== "prd_sign");
      expectNoop(fire(unsigned, {}), /not waiting at it/);
    });

    it("a blocked run is a noop", () => {
      const w = world(); w.run.status = "blocked";
      expectNoop(fire(w, {}), /not waiting at it/);
    });

    it("the code stage already started or running is a noop (the stage row exists, whatever its status)", () => {
      for (const status of ["pending", "running", "awaiting_gate"]) {
        const w = world();
        w.run.stages.push({ id: "s-code", name: "claude_code", status, artifact_ref: "job queued" });
        expectNoop(fire(w, {}), /not waiting at it/);
      }
    });

    it("a run PAST the code stage (reviewed, staging, production) is a noop and deploys nothing", () => {
      const reviewed = world();
      reviewed.run.stages.push({ id: "s-code", name: "claude_code", status: "done", artifact_ref: "x" });
      reviewed.run.gates.push(gate("pm_review", "s-code", "approved", "2026-10-05")); // the normal path would now deploy staging
      expectNoop(fire(reviewed, {}), /next action would be: deploy\)/);
      const staged = world();
      staged.run.stages.push({ id: "s-code", name: "claude_code", status: "done", artifact_ref: "x" }, { id: "s-stg", name: "staging", status: "done", artifact_ref: "y" });
      staged.run.gates.push(gate("pm_review", "s-code", "approved", "2026-10-05"), gate("customer_feedback", "s-stg", "approved", "2026-10-06"), gate("pm_approval", "s-stg", "approved", "2026-10-07"));
      expectNoop(fire(staged, {}), /next action would be: deploy_prod/);
    });

    it("a scaffold that has already started on the site is a noop, even if its stage row was never written", () => {
      for (const state of ["pending", "commit_created", "committed"]) {
        const w = world(); w.site.scaffold = { state };
        expectNoop(fire(w, {}), new RegExp(`already started for this site \\(state: ${state}\\)`));
      }
    });
  });

  it("a DUPLICATE event is a noop: the first delivery resumes once, every replay finds the stage it created", () => {
    const w = world();
    const store: Json = {}; // one workflow's static data, as in n8n
    const first = fire(w, store);
    expect(first.out["Verify (pinned)"].dup).toBe(false);
    expect(first.response).toMatchObject({ action: "released_code" });
    expect(w.run.stages.filter((s) => s.name === "claude_code")).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      const again = fire(w, store); // the SAME envelope id, redelivered
      expect(again.out["Verify (pinned)"].dup).toBe(true);
      expect(again.response).toMatchObject({ ok: true, action: "noop" });
      expect(writes(again)).toEqual([]);
    }
    // and a replay with a fresh envelope id (a different outbox row) is just as inert
    const other = fire(w, store, envelope({ id: "ev-2" }));
    expect(other.out["Verify (pinned)"].dup).toBe(false);
    expect(other.response).toMatchObject({ action: "noop" });
    expect(writes(other)).toEqual([]);
  });

  it("a seen envelope id never skips a resume: a retry after a first attempt that died early still starts the scaffold", () => {
    const w = world();
    const store: Json = {};
    // first attempt: the id is recorded, then the run read blows up (a 5xx): nothing was started, the bridge redelivers
    const m = platform(w);
    m["pipeline.getRun"] = () => { throw new Error("hub 503"); };
    expect(() => drive(lwf, "Verify (pinned)", hook(envelope()), m, store)).toThrow();
    const retry = fire(w, store);
    expect(retry.out["Verify (pinned)"].dup).toBe(true);
    expect(retry.response).toMatchObject({ action: "released_code" });
    expect(scaffoldCalls(retry)).toHaveLength(1);
  });
});
