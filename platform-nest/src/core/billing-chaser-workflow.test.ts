// PV-D28 -- automation/workflows/billing-chaser.json (wf:billing-chaser). Pure JSON + the workflow's own Code nodes
// executed the way n8n runs them; no database, no n8n runtime. Pins three things:
//   1. WIRING: the id the live import must keep, the 09:00 Asia/Makassar schedule, the OBO identity it presents to
//      the hub, and that the hub calls it makes are EXACTLY the tools mcp-hub's AUTOMATION_ALLOWLIST gives it
//      (the allow-list is read from the hub's source, so a drift in either direction fails here).
//   2. NEVER DECIDES: no send / countersign / decide / draft tool appears anywhere in the file.
//   3. LOGIC: the three reminders and their day thresholds, silence when nothing qualifies, one digest per
//      recipient, and a refusal from the hub THROWS instead of reading as "nothing to chase".
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const WORKFLOW_PATH = resolve(ROOT, "automation/workflows/billing-chaser.json");
const WF_ID = "wf:billing-chaser";

type Node = { name: string; type: string; parameters: { jsCode?: string; jsonBody?: string; url?: string; rule?: unknown; headerParameters?: { parameters: Array<{ name: string; value: string }> } } };
type Wf = { id: string; name: string; active?: boolean; nodes: Node[]; connections: Record<string, { main: Array<Array<{ node: string }>> }>; settings: { timezone?: string } };
const raw = readFileSync(WORKFLOW_PATH, "utf8");
const wf = JSON.parse(raw) as Wf;
const node = (name: string): Node => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  return n;
};

/** The hub's own allow-list entry for this workflow, read from source so neither side can drift silently. */
const hubSource = readFileSync(resolve(ROOT, "mcp-hub/src/automation-policy.ts"), "utf8");
const scopeMatch = new RegExp(`"${WF_ID}":\\s*\\[([^\\]]*)\\]`).exec(hubSource);
const hubScope = scopeMatch ? [...scopeMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

describe("billing-chaser.json wiring", () => {
  it("declares the id the live import must keep, and is not shipped active", () => {
    expect(wf.id).toBe("wspv3billchase01");
    expect(wf.id).toHaveLength(16); // the repo's declared-id length (wswdstalenag0001, ws11delivery0001, ...)
    expect(wf.active).not.toBe(true);
  });

  it("runs daily at 09:00 in Asia/Makassar", () => {
    const trigger = wf.nodes.find((n) => n.type === "n8n-nodes-base.scheduleTrigger");
    expect(JSON.stringify(trigger?.parameters.rule)).toContain('"expression":"0 9 * * *"');
    expect(wf.settings.timezone).toBe("Asia/Makassar");
  });

  const hubCalls = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");

  it("every hub call goes to the hub's /mcp as wf:billing-chaser, with the chaser's auth and SSE headers", () => {
    expect(hubCalls.length).toBeGreaterThan(0);
    for (const n of hubCalls) {
      expect(n.parameters.url, n.name).toBe("http://mcp-hub:3003/mcp");
      const h = Object.fromEntries(n.parameters.headerParameters!.parameters.map((p) => [p.name, p.value]));
      expect(h["Authorization"], n.name).toBe("=Bearer {{ $env.HUB_SERVICE_TOKEN }}");
      expect(h["Accept"], n.name).toBe("application/json, text/event-stream");
      expect(h["x-obo-provider"], n.name).toBe("n8n");
      expect(h["x-obo-external-id"], n.name).toBe(WF_ID);
    }
  });

  it("the tools it calls are EXACTLY the hub allow-list entry (clients.list, contracts.list, invoicePayments.list, notify)", () => {
    expect([...hubScope].sort()).toEqual(["clients.list", "contracts.list", "invoicePayments.list", "notify"]);
    const called = hubCalls.map((n) => /name: "([^"]+)"/.exec(n.parameters.jsonBody ?? "")?.[1]).sort();
    expect(called).toEqual(["clients.list", "contracts.list", "invoicePayments.list", "notify"]);
  });

  it("🔴 never decides: no send, countersign, payment decision or draft tool appears anywhere in the file", () => {
    for (const t of ["contracts.send", "contracts.countersign", "invoicePayments.decide", "contracts.createDraft", "contracts.updateDraft"]) {
      expect(raw, t).not.toContain(t);
    }
  });

  it("the per-client reads carry the tenant and the client id (the tools require clientId in the path)", () => {
    for (const t of ["contracts.list", "invoicePayments.list"]) {
      const n = hubCalls.find((x) => x.parameters.jsonBody?.includes(`name: "${t}"`))!;
      expect(n.parameters.jsonBody, t).toContain("tenantId: $env.AGENCY_TENANT_ID");
      expect(n.parameters.jsonBody, t).toContain("clientId: $json.clientId");
    }
  });

  it("is one straight line: schedule -> clients -> split -> contracts -> parse -> payments -> evaluate -> notify -> parse", () => {
    const order = ["Daily 09:00 Asia/Makassar", "MCP tools/call clients.list", "Split clients (skip if none)", "MCP tools/call contracts.list",
      "Parse contracts", "MCP tools/call invoicePayments.list", "Evaluate (skip if nothing qualifies)", "MCP notify (in-app digest)", "Parse notify result"];
    for (let i = 0; i < order.length - 1; i++) expect(wf.connections[order[i]].main[0].map((e) => e.node)).toEqual([order[i + 1]]);
    expect(wf.connections[order[order.length - 1]]).toBeUndefined();
  });
});

// ── the Code nodes, run as n8n runs them ─────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
type Item = { json: Json; pairedItem?: { item: number } };
const sse = (result: unknown): Item => ({ json: { data: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n` } });
const ok = (payload: unknown): Item => sse({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const refused = (text: string): Item => sse({ isError: true, content: [{ type: "text", text }] });

function runCode(name: string, input: Item[], named: Record<string, Item[]>, env: Record<string, string>): Item[] {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function("$input", "$", "$env", node(name).parameters.jsCode as string) as (i: unknown, d: unknown, e: unknown) => Item[];
  return fn(
    { first: () => input[0], all: () => input },
    (n: string) => {
      if (!(n in named)) throw new Error(`node "${n}" not wired in this test`);
      return { all: () => named[n], first: () => named[n][0] };
    },
    env,
  );
}

const NOW = new Date("2026-10-13T01:00:00.000Z"); // 09:00 Makassar
const ago = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();
const ENV = { AGENCY_TENANT_ID: "T1", BILLING_NOTIFY_USER_IDS: "u-owner-1, u-owner-2" };

const CLIENTS = [
  { id: "c-a", name: "Acme" },
  { id: "c-b", name: "Beta" },
  { id: "c-c", name: "Quiet Co" },
];
const CONTRACTS: Record<string, unknown[]> = {
  "c-a": [
    { id: "k1", status: "sent", clientSigned: true, providerSigned: false, sentAt: ago(2) }, // (b) counts
    { id: "k2", status: "sent", clientSigned: true, providerSigned: false, sentAt: ago(0.5) }, // under 1 day
    { id: "k3", status: "signed", clientSigned: true, providerSigned: true, sentAt: ago(30) }, // not sent
    { id: "k4", status: "sent", clientSigned: true, providerSigned: true, sentAt: ago(30) }, // we already signed
  ],
  "c-b": [
    { id: "k5", status: "sent", clientSigned: false, providerSigned: false, sentAt: ago(8) }, // (c) counts
    { id: "k6", status: "sent", clientSigned: false, providerSigned: false, sentAt: ago(6) }, // under 7 days
    { id: "k7", status: "draft", clientSigned: false, providerSigned: false, sentAt: null }, // draft
  ],
  "c-c": [],
};
const PAYMENTS: Record<string, unknown[]> = {
  "c-a": [
    { id: "p1", status: "pending", recordedAt: ago(3) }, // (a) counts
    { id: "p2", status: "pending", recordedAt: ago(1) }, // under 2 days
    { id: "p3", status: "confirmed", recordedAt: ago(10) }, // decided
  ],
  "c-b": [],
  "c-c": [],
};

/** Drive the whole chain the way n8n would, from a clients.list reply to the notify items. */
function drive(opts: { clients?: unknown[]; contracts?: Record<string, unknown[]>; payments?: Record<string, unknown[]>; env?: Record<string, string> } = {}) {
  const env = opts.env ?? ENV;
  const split = runCode("Split clients (skip if none)", [ok(opts.clients ?? CLIENTS)], {}, env);
  if (split.length === 0) return { split, notify: [] as Item[] };
  const contracts = opts.contracts ?? CONTRACTS;
  const payments = opts.payments ?? PAYMENTS;
  const parsedContracts = runCode("Parse contracts", split.map((s) => ok(contracts[s.json.clientId as string])), { "Split clients (skip if none)": split }, env);
  const notify = runCode("Evaluate (skip if nothing qualifies)", parsedContracts.map((p) => ok(payments[p.json.clientId as string])), { "Parse contracts": parsedContracts }, env);
  return { split, notify };
}

describe("billing-chaser.json logic", () => {
  afterEach(() => vi.useRealTimers());
  const at = () => { vi.useFakeTimers(); vi.setSystemTime(NOW); };

  it("collects the three PV-D28 reminders with their thresholds and nothing else, naming the clients and linking to their billing tab", () => {
    at();
    const { notify } = drive();
    expect(notify).toHaveLength(2); // one delivery per configured recipient
    expect(notify.map((n) => n.json.recipientId)).toEqual(["u-owner-1", "u-owner-2"]);
    const j = notify[0].json as { tenantId: string; payload: Json };
    expect(j.tenantId).toBe("T1");
    const p = j.payload as { title: string; href: string; body: string; severity: string; counts: Json; clients: Array<Json>; links: Array<Json>; entityType?: string };
    expect(p.counts).toEqual({ paymentsAwaitingConfirmation: 1, contractsAwaitingCountersignature: 1, contractsUnsignedByClient: 1 });
    expect(p.clients).toEqual([
      { id: "c-a", name: "Acme", payments: 1, countersign: 1, unsigned: 0 },
      { id: "c-b", name: "Beta", payments: 0, countersign: 0, unsigned: 1 },
    ]);
    expect(p.body).toContain("1 payment claim waiting over 2 days");
    expect(p.body).toContain("1 contract signed by the client and waiting over 1 day for our countersignature");
    expect(p.body).toContain("1 contract sent over 7 days ago and still unsigned by the client");
    expect(p.body).toContain("Acme (2)");
    expect(p.body).toContain("Beta (1)");
    expect(p.body).not.toContain("Quiet Co");
    expect(p.href).toBe("/clients/c-a/billing");
    expect(p.links).toEqual([{ label: "Acme", href: "/clients/c-a/billing" }, { label: "Beta", href: "/clients/c-b/billing" }]);
    expect(p.entityType).toBeUndefined(); // two clients: no single entity to point at
  });

  it("a single qualifying client is the digest's entity", () => {
    at();
    const { notify } = drive({ clients: [CLIENTS[1]] });
    expect((notify[0].json.payload as Json).entityType).toBe("client");
    expect((notify[0].json.payload as Json).entityId).toBe("c-b");
  });

  it("the thresholds are strict: a contract exactly 7 days old, a claim exactly 2 days old and a countersign wait of exactly 1 day do not qualify", () => {
    at();
    const { notify } = drive({
      clients: [CLIENTS[0]],
      contracts: { "c-a": [{ status: "sent", clientSigned: false, providerSigned: false, sentAt: ago(7) }, { status: "sent", clientSigned: true, providerSigned: false, sentAt: ago(1) }] },
      payments: { "c-a": [{ status: "pending", recordedAt: ago(2) }] },
    });
    expect(notify).toEqual([]);
  });

  it("stops silently when nothing qualifies, and when there are no clients at all", () => {
    at();
    expect(drive({ contracts: { "c-a": [], "c-b": [], "c-c": [] }, payments: { "c-a": [], "c-b": [], "c-c": [] } }).notify).toEqual([]);
    expect(drive({ clients: [] }).split).toEqual([]);
  });

  it("falls back to NOTIFY_USER_ID (the ops lead) when no billing recipients are configured", () => {
    at();
    const { notify } = drive({ env: { AGENCY_TENANT_ID: "T1", NOTIFY_USER_ID: "u-ops" } });
    expect(notify.map((n) => n.json.recipientId)).toEqual(["u-ops"]);
  });

  it("a digest with content but no recipient THROWS rather than vanishing; with nothing to say it does not need one", () => {
    at();
    expect(() => drive({ env: { AGENCY_TENANT_ID: "T1" } })).toThrow(/no recipient/);
    expect(drive({ env: { AGENCY_TENANT_ID: "T1" }, contracts: { "c-a": [], "c-b": [], "c-c": [] }, payments: { "c-a": [], "c-b": [], "c-c": [] } }).notify).toEqual([]);
  });

  it("a hub refusal on any read THROWS: a 403 is never an empty list", () => {
    at();
    expect(() => runCode("Split clients (skip if none)", [refused("workflow wf:billing-chaser is not scoped for clients.list")], {}, ENV)).toThrow(/not scoped/);
    const split = runCode("Split clients (skip if none)", [ok(CLIENTS)], {}, ENV);
    expect(() => runCode("Parse contracts", [refused("denied")], { "Split clients (skip if none)": split }, ENV)).toThrow(/denied/);
    const parsed = runCode("Parse contracts", split.map((s) => ok(CONTRACTS[s.json.clientId as string])), { "Split clients (skip if none)": split }, ENV);
    expect(() => runCode("Evaluate (skip if nothing qualifies)", [refused("403 cerbos denied read on invoice")], { "Parse contracts": parsed }, ENV)).toThrow(/cerbos denied/);
  });

  it("the notify call sends the digest as the in-app typed payload to one recipient", () => {
    at();
    const { notify } = drive();
    const body = node("MCP notify (in-app digest)").parameters.jsonBody as string;
    expect(body).toContain('name: "notify"');
    expect(body).toContain('type: "billing_chaser_digest"');
    // evaluate the n8n expression against the first Evaluate item
    const expr = body.slice(3, -2); // strip `={{ ` ... ` }}`
    // eslint-disable-next-line no-new-func
    const sent = JSON.parse(new Function("$json", `return (${expr});`)(notify[0].json));
    expect(sent.params).toMatchObject({ name: "notify", arguments: { tenantId: "T1", recipientId: "u-owner-1", type: "billing_chaser_digest" } });
    expect(sent.params.arguments.payload.title).toBe("Billing needs attention");
  });

  it("Parse notify result passes a clean run and throws when the hub refused the notify", () => {
    expect(runCode("Parse notify result", [ok({ ok: true }), ok({ ok: true })], {}, ENV)[0].json).toEqual({ ok: true, delivered: 2 });
    expect(() => runCode("Parse notify result", [refused("suspend: ...")], {}, ENV)).toThrow(/suspend/);
  });
});
