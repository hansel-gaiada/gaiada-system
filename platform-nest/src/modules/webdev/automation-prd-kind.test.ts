// M6-P4e -- the delivery automation picks the site kind from the signed PRD and feeds code.scaffold v2
// the inputs it now requires.
//
// Like slug-parity.test.ts, this EXTRACTS AND EXECUTES the shipped workflow nodes (wd-provision.json and
// pipeline-delivery.json) instead of restating them: a hand-copied expectation would keep passing while
// the real workflow drifted. Nothing here needs a service.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
    for (const k of ["contractSnapshotId: $json.contractSnapshotId", "siteKind: $json.siteKind", "prdArtifact: $json.prdRef", "prototypeArtifact: $json.protoRef"]) {
      expect(body).toContain(k);
    }
  });

  const complete = node(wf, "Provisioning complete?").parameters.jsCode as string;
  const pickedSite = { tenantId: "t1", runId: "r1", prdRef: "stage:p", protoRef: "stage:d", slug: "acme", framework: "vite" };
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
      expect(r).toMatchObject({ ready2: "true", siteKind, contractSnapshotId: "snap-1", prdRef: "stage:p", protoRef: "stage:d" });
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
