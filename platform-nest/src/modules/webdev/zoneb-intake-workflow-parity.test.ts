// The n8n bridge (automation/workflows/wd-zoneb-intake.json) is the FIRST wall every Zone B fact meets, and its
// schema-check is hand-written JS with no compiler. WSK-61 added `schedule.fired` to this validator and the DB CHECK
// but not to that node's KINDS list, so the wake-up hint would have been refused 400 at n8n before it ever reached
// the ERP (found 2026-10-11). This pins the node's list to ZONEB_EVENT_KINDS and runs the node's own code.
// Pure JSON data; no n8n runtime.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZONEB_EVENT_KINDS, validateZoneBEvent } from "./zoneb-event-schema";

const WORKFLOW = resolve(__dirname, "../../../../automation/workflows/wd-zoneb-intake.json");
const workflow = JSON.parse(readFileSync(WORKFLOW, "utf8")) as { nodes: Array<{ name: string; parameters: { jsCode?: string } }> };
const code = workflow.nodes.find((n) => n.name === "Parse + schema-check")?.parameters.jsCode ?? "";

/** Runs the n8n Code node as n8n would: `$json.rawBody` in, `[{ json }]` out. */
function runNode(body: unknown): { valid: boolean; reason?: string } {
  const fn = new Function("$json", code) as (j: { rawBody: string }) => Array<{ json: { valid: boolean; reason?: string } }>;
  return fn({ rawBody: JSON.stringify(body) })[0].json;
}

const TENANT = "019fb652-c68b-7000-8000-000000000001";
const scheduleFired = {
  eventId: "a".repeat(64),
  kind: "schedule.fired",
  tenantId: TENANT,
  originSite: "webdesk",
  occurredAt: "2026-10-11T12:00:00.000Z",
  data: {
    tenantSlug: "gaiada",
    siteId: "019fb652-c68b-7000-8000-000000000002",
    transition: "publish",
    approvalId: null,
    items: [{ itemId: "019fb652-c68b-7000-8000-000000000003", version: 2, effectiveAt: "2026-10-11T12:00:00.000Z" }],
  },
};

describe("wd-zoneb-intake.json schema-check vs ZONEB_EVENT_KINDS", () => {
  it("finds the node's code", () => {
    expect(code).toContain("const KINDS = [");
  });

  it("the node's KINDS list is exactly the ERP's kinds", () => {
    const m = /const KINDS = \[([^\]]*)\]/.exec(code);
    expect(m).not.toBeNull();
    const nodeKinds = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(nodeKinds).toEqual([...ZONEB_EVENT_KINDS].sort());
  });

  it("a schedule.fired the ERP accepts passes the node too", () => {
    expect(validateZoneBEvent(TENANT, scheduleFired).ok).toBe(true);
    expect(runNode(scheduleFired)).toMatchObject({ valid: true });
  });

  it("the node refuses an unknown kind and a schedule.fired without its items (negative controls)", () => {
    expect(runNode({ ...scheduleFired, kind: "schedule.exploded" })).toMatchObject({ valid: false });
    const { items: _items, ...noItems } = scheduleFired.data;
    expect(runNode({ ...scheduleFired, data: noItems })).toMatchObject({ valid: false });
  });

  it("form.received still passes the node unchanged (positive control)", () => {
    const form = { ...scheduleFired, kind: "form.received", data: { siteSlug: "gaiada", formId: "contact", submissionId: "s1", hasAttachments: false } };
    expect(runNode(form)).toMatchObject({ valid: true });
  });
});

// The intake answered WebDesk 200 even when the ERP refused the record, and its result parser JSON-parsed mcp-hub's
// SSE frame whole, so EVERY answer read as unparsed and no form.received could notify (both found live 2026-10-12,
// n8n execution 2660). These run the parse node's own code on the hub's real answer shapes, and pin the wiring:
// only a tool result with a boolean `inserted` reaches "Respond 200"; anything else answers 502.
type WfNode = { name: string; type: string; onError?: string; parameters: { jsCode?: string; options?: { responseCode?: number } } };
type WfConnections = Record<string, { main: Array<Array<{ node: string }>> }>;
const wf = workflow as unknown as { nodes: WfNode[]; connections: WfConnections };
const RECORD_NODE = "MCP webdev.recordZoneBEvent (dedup insert, LOW write)";
const parseCode = wf.nodes.find((n) => n.name === "Parse dedup result + decide routing")?.parameters.jsCode ?? "";

type ParseOut = { recorded: boolean; failReason: string | null; shouldNotify: boolean; outcome: unknown };
function runParse(input: unknown, kind = "schedule.fired", env: Record<string, string> = {}): ParseOut {
  const envelope = { ...scheduleFired, kind };
  const $ = () => ({ first: () => ({ json: { envelope } }) });
  const fn = new Function("$json", "$", "$env", parseCode) as (j: unknown, d: typeof $, e: Record<string, string>) => Array<{ json: ParseOut }>;
  return fn(input, $, env)[0].json;
}
/** mcp-hub's tools/call answer as the HTTP node (responseFormat text) hands it on: an SSE frame in `data`. */
const sse = (rpc: unknown) => ({ data: `event: message\ndata: ${JSON.stringify(rpc)}\n\n` });
const toolResult = (payload: unknown, isError = false) =>
  sse({ result: { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) }, jsonrpc: "2.0", id: 1 });

describe("wd-zoneb-intake.json: a refused record answers 502, never 200", () => {
  it("reads the hub's real SSE answer: a new insert is recorded (the shape execution 2660 got)", () => {
    expect(runParse(toolResult({ id: "a47018c5-0000-4000-8000-000000000001", inserted: true }))).toMatchObject({ recorded: true, failReason: null });
  });

  it("a deduped replay (inserted:false) is still recorded, and never notifies", () => {
    const out = runParse(toolResult({ id: "x", inserted: false }), "form.received", { WEBDEV_ZONEB_NOTIFY_RECIPIENT_ID: "u1" });
    expect(out).toMatchObject({ recorded: true, shouldNotify: false });
  });

  it("a genuine new form.received notifies only when a recipient is configured", () => {
    const answer = toolResult({ id: "x", inserted: true });
    expect(runParse(answer, "form.received", { WEBDEV_ZONEB_NOTIFY_RECIPIENT_ID: "u1" }).shouldNotify).toBe(true);
    expect(runParse(answer, "form.received").shouldNotify).toBe(false);
    expect(runParse(answer, "schedule.fired", { WEBDEV_ZONEB_NOTIFY_RECIPIENT_ID: "u1" }).shouldNotify).toBe(false);
  });

  it("a bare-JSON answer (no SSE framing) still parses", () => {
    const bare = { data: JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ id: "x", inserted: true }) }] }, jsonrpc: "2.0", id: 1 }) };
    expect(runParse(bare).recorded).toBe(true);
  });

  it("refuses: a tool error, a JSON-RPC error, the hub's HTTP error, an unreadable answer, a result without `inserted`", () => {
    const cases: Array<[unknown, RegExp]> = [
      [toolResult("platform 400: body tenantId does not match the route tenant", true), /^record refused: platform 400/],
      [sse({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Authorization failed" } }), /^hub error: Authorization failed/],
      [{ error: { message: "Request failed with status code 401" } }, /^hub request failed: Request failed/],
      [{ data: "event: message\ndata: {not json" }, /^unreadable hub answer/],
      [toolResult({ id: "x" }), /no inserted flag/],
    ];
    for (const [input, reason] of cases) {
      const out = runParse(input, "form.received", { WEBDEV_ZONEB_NOTIFY_RECIPIENT_ID: "u1" });
      expect(out.recorded).toBe(false);
      expect(out.shouldNotify).toBe(false);
      expect(out.failReason).toMatch(reason);
    }
  });

  it("wiring: parse → Recorded? → (Notify configured? | Respond 502); only the recorded branch reaches Respond 200", () => {
    const next = (name: string) => wf.connections[name].main.map((outs) => outs.map((o) => o.node));
    expect(next("Parse dedup result + decide routing")).toEqual([["Recorded?"]]);
    expect(next("Recorded?")).toEqual([["Notify configured?"], ["Respond 502 (record failed)"]]);
    const r502 = wf.nodes.find((n) => n.name === "Respond 502 (record failed)");
    expect(r502?.type).toBe("n8n-nodes-base.respondToWebhook");
    expect(r502?.parameters.options?.responseCode).toBe(502);
    const into200 = Object.entries(wf.connections).filter(([, c]) => c.main.flat().some((o) => o.node === "Respond 200")).map(([k]) => k).sort();
    expect(into200).toEqual(["MCP notify (LOW write)", "Notify configured?"]);
  });

  it("both hub calls continue on error: a failed record reaches the 502 branch, a failed notice keeps the 200", () => {
    expect(wf.nodes.find((n) => n.name === RECORD_NODE)?.onError).toBe("continueRegularOutput");
    expect(wf.nodes.find((n) => n.name === "MCP notify (LOW write)")?.onError).toBe("continueRegularOutput");
  });
});
