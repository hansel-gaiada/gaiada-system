// WSK-59 — the hub's half of the content editor's MCP tools (platform-nest `modules/webdev/index.ts`, design
// docs/plans/2026-10-10-webdesk-write-plane-design.md §12 WSK-59). Nothing is hardcoded hub-side: these tools reach
// the hub through `GET /mcp/tool-defs` (module-tools.ts), so this file declares the SAME names and impact classes
// by hand — the estate's "separate projects, no shared package" rule, as in webdesk-always-ws4.test.ts — and
// proves what the hub does with them:
//   * reads and the four LOW writes never suspend, for a human, an agent or an n8n workflow;
//   * `unpublish` / `delete` (MEDIUM) run for an ATTENDED human and SUSPEND for an unattended caller (agent / n8n);
//   * the LIVE `resource_mcp_tool.yaml` agrees, including the D14 half: an unattended call is let through ONLY
//     with a verified approval grant AND only for the two names on the executable list (a third, unlisted
//     medium tool with the same grant is DENIED: the list is a real bracket, not a pass-through).
// There is no `webdesk.content.publish` tool, on purpose: publish is HIGH and executes only at decide().
// The platform's half (registry entry + re-drive as the original principal) is
// platform-nest/src/modules/webdev/webdesk-content-d14.test.ts.
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import { config } from "./config";
import { resetRegistry, registerTool, getTool } from "./registry";
import { authorize, authorizeCall } from "./policy";
import type { Principal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import { computeArgsSha256, signGrantPayload, verifyExecutionGrant, resetGrantNonceCache, type VerifiedExecutionGrant } from "./approval-grant";

const READS = [
  "webdesk.content.listSites", "webdesk.content.listCollections", "webdesk.content.listItems", "webdesk.content.getItem",
  "webdesk.content.listVersions", "webdesk.content.getVersion", "webdesk.content.listMedia",
];
const LOW_WRITES = ["webdesk.content.create", "webdesk.content.update", "webdesk.content.restoreVersion", "webdesk.content.requestPublish"];
const MEDIUM_WRITES = ["webdesk.content.unpublish", "webdesk.content.delete"];

const HUMAN: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "verified" };
const AGENT: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "low", agent: "agent:webdesk-ops" };
const N8N_WF = "wf:wsk59-test-fixture";
const N8N: Principal = { provider: "n8n", externalId: N8N_WF, assurance: "low" };

const reg = (name: string, impact?: "low" | "medium" | "high") =>
  registerTool(
    impact
      ? { name, description: "x", minAssurance: "low", write: true, impact, inputSchema: { type: "object" }, handler: async () => "" }
      : { name, description: "x", minAssurance: "low", inputSchema: { type: "object" }, handler: async () => "" },
  );

describe("WSK-59 — the in-code gate (the fail-closed fallback when Cerbos is unset)", () => {
  beforeEach(() => {
    resetRegistry();
    config.cerbosUrl = "";
    // a REAL wf: identity would be refused at the SCOPE check before the impact gate this suite is about
    (AUTOMATION_ALLOWLIST as Record<string, readonly string[]>)[N8N_WF] = [...READS, ...LOW_WRITES, ...MEDIUM_WRITES];
  });
  afterAll(() => {
    delete (AUTOMATION_ALLOWLIST as Record<string, readonly string[]>)[N8N_WF];
  });

  it("reads are free for every principal class", () => {
    for (const name of READS) {
      reg(name);
      for (const p of [HUMAN, AGENT, N8N]) expect(authorize(p, name).allow, `${name} as ${p.provider}`).toBe(true);
    }
  });

  it("the four LOW writes (draft-only, or only FILE an approval) never suspend: an agent and n8n run them unattended", () => {
    for (const name of LOW_WRITES) {
      reg(name, "low");
      for (const p of [HUMAN, AGENT, N8N]) expect(authorize(p, name).allow, `${name} as ${p.provider}`).toBe(true);
    }
  });

  for (const name of MEDIUM_WRITES) {
    it(`🔴 ${name}: ALLOWED for an attended human; an unattended AGENT call SUSPENDS (D14), and so does an n8n workflow`, () => {
      reg(name, "medium");
      expect(authorize(HUMAN, name).allow).toBe(true);
      const a = authorize(AGENT, name);
      expect(a.allow).toBe(false);
      if (!a.allow) {
        expect(a.reason).toMatch(/^suspend:/);
        expect(a.reason).toContain("agent:webdesk-ops");
      }
      const n = authorize(N8N, name);
      expect(n.allow).toBe(false);
      if (!n.allow) expect(n.reason).toMatch(/^suspend:/);
    });
  }
});

// ───────────────────────────── the LIVE policy ─────────────────────────────
// Needs a Cerbos serving platform-nest/cerbos/policies (CERBOS_TEST_URL). Self-skips when unreachable, like cerbos.test.ts.
const realFetch = globalThis.fetch;
const LIVE_CERBOS = process.env.CERBOS_TEST_URL ?? "http://localhost:3592";
const liveReachable = await (async () => {
  try {
    return (await realFetch(`${LIVE_CERBOS}/_cerbos/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!liveReachable) console.warn(`[webdesk-content-tools.test] SKIPPING live resource_mcp_tool checks — no Cerbos at ${LIVE_CERBOS}`);

const GRANT_SECRET = "wsk59-test-secret";
let nonceSeq = 0;
function mintVerified(toolName: string, args: Record<string, unknown>): VerifiedExecutionGrant {
  const prev = config.approvalGrantSecret;
  config.approvalGrantSecret = GRANT_SECRET;
  try {
    const now = Date.now();
    const header = signGrantPayload(
      { v: 1, approvalId: "ap-wsk59", tenantId: "tenant-1", toolName, argsSha256: computeArgsSha256(args), iat: now, exp: now + 60_000, nonce: `n-wsk59-${++nonceSeq}` },
      GRANT_SECRET,
    );
    const verdict = verifyExecutionGrant(header, { toolName, args });
    if (!verdict.ok) throw new Error(`fixture grant failed to verify: ${verdict.reason}`);
    return verdict.grant;
  } finally {
    config.approvalGrantSecret = prev;
  }
}

describe.skipIf(!liveReachable)("WSK-59 — LIVE resource_mcp_tool.yaml: the D14 pairing for unpublish/delete", () => {
  const ARGS = { tenantId: "t", tenantSlug: "gaiada", siteId: "s", itemId: "i", expectedPublishedVersion: 1 };

  beforeAll(() => {
    (AUTOMATION_ALLOWLIST as Record<string, readonly string[]>)[N8N_WF] = [...MEDIUM_WRITES, "webdesk.content.notListed"];
  });
  afterAll(() => {
    delete (AUTOMATION_ALLOWLIST as Record<string, readonly string[]>)[N8N_WF];
  });
  beforeEach(() => {
    resetRegistry();
    for (const n of READS) reg(n);
    for (const n of LOW_WRITES) reg(n, "low");
    for (const n of MEDIUM_WRITES) reg(n, "medium");
    reg("webdesk.content.notListed", "medium"); // a medium write the policy does NOT list: the negative control
    config.cerbosUrl = LIVE_CERBOS;
    config.approvalGrantSecret = GRANT_SECRET;
    resetGrantNonceCache();
  });
  afterEach(() => {
    config.cerbosUrl = "";
    config.approvalGrantSecret = "";
    vi.unstubAllGlobals();
  });

  async function livePolicyAllows(principal: Principal, toolName: string, grant?: VerifiedExecutionGrant): Promise<boolean> {
    const { cerbosAllowsTool } = await import("./cerbos");
    return cerbosAllowsTool(principal, getTool(toolName)!, grant);
  }

  for (const name of MEDIUM_WRITES) {
    it(`${name}: an unattended agent / n8n caller is DENIED with no grant (it suspends), ALLOWED with a verified grant (the re-drive)`, async () => {
      for (const p of [AGENT, N8N]) {
        expect(await livePolicyAllows(p, name), `${name} no grant as ${p.provider}`).toBe(false);
        expect(await livePolicyAllows(p, name, mintVerified(name, ARGS)), `${name} granted as ${p.provider}`).toBe(true);
      }
      expect(await livePolicyAllows(HUMAN, name), "an attended human needs no grant").toBe(true);
    });
  }

  it("🔴 the executable list is a real bracket: an UNLISTED medium tool is denied even with a valid grant", async () => {
    expect(await livePolicyAllows(AGENT, "webdesk.content.notListed", mintVerified("webdesk.content.notListed", ARGS))).toBe(false);
    expect(await livePolicyAllows(N8N, "webdesk.content.notListed", mintVerified("webdesk.content.notListed", ARGS))).toBe(false);
  });

  it("reads and the four LOW writes are allowed for an unattended agent with no grant", async () => {
    for (const name of [...READS, ...LOW_WRITES]) expect(await livePolicyAllows(AGENT, name), name).toBe(true);
  });

  it("the full hub path (authorizeCall) lets the granted unpublish through and refuses the ungranted one", async () => {
    const name = "webdesk.content.unpublish";
    expect((await authorizeCall(AGENT, name)).allow).toBe(false);
    expect((await authorizeCall(AGENT, name, mintVerified(name, ARGS))).allow).toBe(true);
  });
});
