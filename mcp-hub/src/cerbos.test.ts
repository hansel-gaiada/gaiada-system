import { describe, it, expect, beforeEach, beforeAll, afterEach, afterAll, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "./config";
import { resetRegistry, registerTool } from "./registry";
import { registerCoreTools } from "./tools";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { registerDeliveryTools } from "./delivery-tools";
import { visibleToolsFor, authorizeCall } from "./policy";
import { mintPrincipal, type Principal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import { buildHubServer } from "./hub";
import {
  computeArgsSha256,
  signGrantPayload,
  verifyExecutionGrant,
  resetGrantNonceCache,
  type VerifiedExecutionGrant,
} from "./approval-grant";

const lowUser = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });
const staleChaser: Principal = { provider: "n8n", externalId: "wf:stale-approval-chaser", assurance: "low" };

// Cerbos stub: allow only the tool names in `allow`; everything else EFFECT_DENY.
function stubCerbos(allow: Set<string>) {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { resources: Array<{ resource: { id: string } }> };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.resources.map((r) => ({
          resource: { id: r.resource.id },
          actions: { call: allow.has(r.resource.id) ? "EFFECT_ALLOW" : "EFFECT_DENY" },
        })),
      }),
    };
  }) as unknown as typeof fetch;
}

describe("Cerbos-authoritative policy (WS2 §5)", () => {
  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    registerPlatformWriteTools();
    config.cerbosUrl = "http://cerbos.test";
  });
  afterEach(() => {
    config.cerbosUrl = "";
    vi.unstubAllGlobals();
  });

  it("visibleToolsFor returns exactly what Cerbos allows (one batched check)", async () => {
    const spy = stubCerbos(new Set(["ping", "whoami"]));
    vi.stubGlobal("fetch", spy);
    const names = (await visibleToolsFor(lowUser)).map((t) => t.name);
    expect(names.sort()).toEqual(["ping", "whoami"]);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1); // batched, not N calls
  });

  it("authorizeCall honors a Cerbos allow", async () => {
    vi.stubGlobal("fetch", stubCerbos(new Set(["whoami"])));
    const d = await authorizeCall(lowUser, "whoami");
    expect(d.allow).toBe(true);
  });

  it("a Cerbos deny keeps the in-code suspend reason for a medium+/unclassified automation write", async () => {
    // projects.create is LOW (auto-allowed); notify is LOW too. Use a medium write via registry.
    const { registerTool } = await import("./registry");
    registerTool({ name: "money.transfer", description: "m", minAssurance: "low", write: true, impact: "medium", inputSchema: { type: "object" }, handler: async () => "ok" });
    const { AUTOMATION_ALLOWLIST } = await import("./automation-policy");
    AUTOMATION_ALLOWLIST["wf:stale-approval-chaser"] = ["money.transfer"];
    vi.stubGlobal("fetch", stubCerbos(new Set())); // Cerbos denies (as the policy would: medium write)
    const d = await authorizeCall(staleChaser, "money.transfer");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*medium-impact/);
    delete AUTOMATION_ALLOWLIST["wf:stale-approval-chaser"];
  });

  it("fails closed to the in-code engine when Cerbos is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch);
    // in-code allows whoami for a low user, so the fallback still returns allow (deny-by-default engine)
    const d = await authorizeCall(lowUser, "whoami");
    expect(d.allow).toBe(true);
    // and denies an unknown tool
    const d2 = await authorizeCall(lowUser, "does.not.exist");
    expect(d2.allow).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D14-13 — the grant-aware impact conjunct.
//
// Two layers, deliberately separate:
//   1. PAYLOAD tests (stubbed): the `approvalId` resource attribute can ONLY come from a branded
//      VerifiedExecutionGrant, is omitted entirely without one, and is un-injectable from args.
//   2. LIVE POLICY tests: the same decisions evaluated by the REAL resource_mcp_tool.yaml in a
//      running Cerbos. This split exists BECAUSE the stub and the live policy disagreed — a stub
//      that returns whatever the test author expected cannot detect a misplaced CEL disjunct.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const GRANT_SECRET = "d14-13-test-secret";
/** Captured before any fetch stubbing, so the live-Cerbos tests can pass through a stubbed fetch. */
const realFetch = globalThis.fetch;

let nonceSeq = 0;
/** Mint a REAL grant and run it through the real verifier — the only way to obtain the branded type
 *  (which is the point: a plain object cannot reach the policy layer). */
function mintVerified(
  toolName: string,
  args: Record<string, unknown>,
  approvalId = "ap-d14-13",
): VerifiedExecutionGrant {
  const prevSecret = config.approvalGrantSecret;
  config.approvalGrantSecret = GRANT_SECRET;
  try {
    const now = Date.now();
    const header = signGrantPayload(
      {
        v: 1,
        approvalId,
        tenantId: "tenant-1",
        toolName,
        argsSha256: computeArgsSha256(args),
        iat: now,
        exp: now + 60_000,
        nonce: `n-${++nonceSeq}`,
      },
      GRANT_SECRET,
    );
    const verdict = verifyExecutionGrant(header, { toolName, args });
    if (!verdict.ok) throw new Error(`fixture grant failed to verify: ${verdict.reason}`);
    return verdict.grant;
  } finally {
    config.approvalGrantSecret = prevSecret;
  }
}

/** The single deploy.production call every test below authorizes. */
const DEPLOY_ARGS = { repo: "acme/site", ref: "main", runId: "run-1" };

type CapturedResource = { attr: Record<string, unknown> };
/** Cerbos stub that RECORDS the outbound resource payloads. */
function capturingCerbos(allow: Set<string>, captured: CapturedResource[][]) {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { resources: Array<{ resource: CapturedResource & { id: string } }> };
    captured.push(body.resources.map((r) => r.resource));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.resources.map((r) => ({
          resource: { id: r.resource.id },
          actions: { call: allow.has(r.resource.id) ? "EFFECT_ALLOW" : "EFFECT_DENY" },
        })),
      }),
    };
  }) as unknown as typeof fetch;
}

const deliveryWf: Principal = { provider: "n8n", externalId: "wf:delivery", assurance: "low" };

/** Tests that drive buildHubServer WRITE to the JSONL tool audit; keep them off the default
 *  `data/tool-audit.jsonl`, which is a real (gitignored) dev artifact. */
const TEST_AUDIT_DIR = "data/test-audit-d14-13";

describe("D14-13 — approvalId resource attribute (payload contract)", () => {
  let captured: CapturedResource[][];
  const realAuditFile = config.auditFile;

  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    registerDeliveryTools();
    config.cerbosUrl = "http://cerbos.test";
    config.auditFile = `${TEST_AUDIT_DIR}/tools.jsonl`;
    captured = [];
    resetGrantNonceCache();
  });
  afterEach(() => {
    config.cerbosUrl = "";
    config.auditFile = realAuditFile;
    vi.unstubAllGlobals();
  });
  afterAll(() => rmSync(TEST_AUDIT_DIR, { recursive: true, force: true }));

  it("omits the attribute entirely without a grant — the pre-D14-13 payload, byte for byte", async () => {
    vi.stubGlobal("fetch", capturingCerbos(new Set(), captured));
    await authorizeCall(deliveryWf, "deploy.production");
    expect(captured[0][0].attr).toEqual({
      name: "deploy.production",
      minAssurance: "low",
      write: true,
      impact: "high",
    });
    expect("approvalId" in captured[0][0].attr).toBe(false);
  });

  it("carries the VERIFIED grant's approvalId (so the Cerbos decision records which approval lifted the gate)", async () => {
    vi.stubGlobal("fetch", capturingCerbos(new Set(["deploy.production"]), captured));
    const grant = mintVerified("deploy.production", DEPLOY_ARGS, "ap-42");
    await authorizeCall(deliveryWf, "deploy.production", grant);
    expect(captured[0][0].attr.approvalId).toBe("ap-42");
  });

  it("never decorates a DIFFERENT tool than the grant names (batch/plumbing safety)", async () => {
    vi.stubGlobal("fetch", capturingCerbos(new Set(), captured));
    const grant = mintVerified("deploy.staging", { repo: "acme/site" });
    await authorizeCall(deliveryWf, "deploy.production", grant);
    expect("approvalId" in captured[0][0].attr).toBe(false);
  });

  it("the tool-LIST (visibility) path never carries an approvalId", async () => {
    vi.stubGlobal("fetch", capturingCerbos(new Set(["ping"]), captured));
    await visibleToolsFor(deliveryWf);
    for (const resource of captured[0]) expect("approvalId" in resource.attr).toBe(false);
  });

  it("cannot be injected through tool args (args never reach the resource attrs)", async () => {
    vi.stubGlobal("fetch", capturingCerbos(new Set(), captured));
    // A caller sending its own approvalId in the arguments, with no grant header at all.
    await authorizeCall(deliveryWf, "deploy.production");
    expect("approvalId" in captured[0][0].attr).toBe(false);

    // …and end-to-end through the hub, where the args ARE attacker-controlled.
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildHubServer(deliveryWf).connect(serverT);
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(clientT);
    await client.callTool({ name: "deploy.production", arguments: { ...DEPLOY_ARGS, approvalId: "forged" } });
    for (const batch of captured) for (const r of batch) expect("approvalId" in r.attr).toBe(false);
  });

  it("a Cerbos DENY still denies with a valid grant present (the grant is not an override)", async () => {
    vi.stubGlobal("fetch", capturingCerbos(new Set(), captured)); // Cerbos denies everything
    const grant = mintVerified("deploy.production", DEPLOY_ARGS);
    const d = await authorizeCall(deliveryWf, "deploy.production", grant);
    expect(d.allow).toBe(false);
  });
});

// ───────────────────────────── LIVE resource_mcp_tool.yaml ─────────────────────────────
//
// Requires a Cerbos serving platform-nest/cerbos/policies (the local stack publishes 3592). Skipped
// when unreachable so CI (which runs mcp-hub standalone) stays green — the same self-skip convention
// the repo uses for DB-backed suites.
//
// ⚠ The policy bind-mount does NOT hot-reload on Windows (inotify does not cross the mount): after
// ANY edit to resource_mcp_tool.yaml run `docker restart gaiada-test-cerbos` before these tests, or
// they grade a stale policy snapshot.
const LIVE_CERBOS = process.env.CERBOS_TEST_URL ?? "http://localhost:3592";
const liveReachable = await (async () => {
  try {
    const res = await realFetch(`${LIVE_CERBOS}/_cerbos/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
})();
if (!liveReachable) {
  console.warn(`[cerbos.test] SKIPPING live resource_mcp_tool checks — no Cerbos at ${LIVE_CERBOS}`);
}

describe.skipIf(!liveReachable)("D14-13 — LIVE resource_mcp_tool.yaml policy", () => {
  const noScopeWf: Principal = { provider: "n8n", externalId: "wf:d14-13-noscope", assurance: "low" };
  const moneyWf: Principal = { provider: "n8n", externalId: "wf:d14-13-money", assurance: "low" };
  const driftWf: Principal = { provider: "n8n", externalId: "wf:d14-13-drift", assurance: "low" };
  const realAuditFile = config.auditFile;
  // A verified, non-automation principal (assurance "verified" comes from the platform IdP, never
  // from an OBO envelope — mintPrincipal can only ever produce "low", so construct it directly).
  const human: Principal = { provider: "platform", externalId: "u-1", assurance: "verified" };

  beforeAll(() => {
    // Fixture workflow scopes (deleted in afterAll). wf:delivery is REAL and already scopes deploy.*.
    AUTOMATION_ALLOWLIST["wf:d14-13-noscope"] = ["ping"];
    AUTOMATION_ALLOWLIST["wf:d14-13-money"] = ["search.setBudget"];
    AUTOMATION_ALLOWLIST["wf:d14-13-drift"] = ["deploy.canary"];
  });
  afterAll(() => {
    delete AUTOMATION_ALLOWLIST["wf:d14-13-noscope"];
    delete AUTOMATION_ALLOWLIST["wf:d14-13-money"];
    delete AUTOMATION_ALLOWLIST["wf:d14-13-drift"];
    rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    registerDeliveryTools();
    // A money-spending tool (permanently barred from core/approval-executables.ts AND from the
    // policy list) and a hypothetical FUTURE registry addition the policy does not yet list.
    registerTool({ name: "search.setBudget", description: "spends a client's ad budget", minAssurance: "low", write: true, impact: "high", inputSchema: { type: "object" }, handler: async () => "BUDGET-CHANGED" });
    registerTool({ name: "deploy.canary", description: "registry-only, not in the policy list", minAssurance: "low", write: true, impact: "high", inputSchema: { type: "object" }, handler: async () => "CANARY-DEPLOYED" });
    config.cerbosUrl = LIVE_CERBOS;
    config.approvalGrantSecret = GRANT_SECRET;
    resetGrantNonceCache();
  });
  afterEach(() => {
    config.cerbosUrl = "";
    config.approvalGrantSecret = "";
    config.auditFile = realAuditFile;
    config.deployProductionUrl = "";
    vi.unstubAllGlobals();
  });

  /** Ask the LIVE policy directly — no in-code engine in the answer, so a misplaced CEL disjunct
   *  cannot hide behind the in-code deny. */
  async function livePolicyAllows(principal: Principal, toolName: string, grant?: VerifiedExecutionGrant) {
    const { cerbosAllowsTool } = await import("./cerbos");
    const { getTool } = await import("./registry");
    return cerbosAllowsTool(principal, getTool(toolName)!, grant);
  }

  it("ALLOW: automation + workflow-scoped + verified grant + tool in the executable list", async () => {
    const grant = mintVerified("deploy.production", DEPLOY_ARGS);
    expect(await livePolicyAllows(deliveryWf, "deploy.production", grant)).toBe(true);
    const d = await authorizeCall(deliveryWf, "deploy.production", mintVerified("deploy.production", DEPLOY_ARGS));
    expect(d.allow).toBe(true);
  });

  it("ALLOW end-to-end: a granted deploy.production actually DISPATCHES through the hub with CERBOS_URL set", async () => {
    config.auditFile = `${TEST_AUDIT_DIR}/tools.jsonl`;
    rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
    config.deployProductionUrl = "http://deploy.test/prod";

    // Pass Cerbos traffic through to the REAL server; intercept only the deploy webhook.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(LIVE_CERBOS)) return realFetch(url, init);
      expect(url).toBe("http://deploy.test/prod");
      return { ok: true, status: 200, text: async (): Promise<string> => "queued" };
    }) as unknown as typeof fetch);

    const header = (() => {
      const now = Date.now();
      return signGrantPayload(
        { v: 1, approvalId: "ap-e2e", tenantId: "tenant-1", toolName: "deploy.production", argsSha256: computeArgsSha256(DEPLOY_ARGS), iat: now, exp: now + 60_000, nonce: `n-e2e-${++nonceSeq}` },
        GRANT_SECRET,
      );
    })();

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildHubServer(deliveryWf, { approvalGrant: header }).connect(serverT);
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(clientT);
    const res = await client.callTool({ name: "deploy.production", arguments: DEPLOY_ARGS });

    expect(res.isError ?? false).toBe(false);
    expect(JSON.stringify(res.content)).toContain("\\\"dispatched\\\":true");

    // The audit records WHICH approval lifted the gate.
    const audit = readFileSync(config.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.find((a) => a.tool === "deploy.production")).toMatchObject({
      decision: "allow",
      ok: true,
      grant: { verdict: "accepted", approvalId: "ap-e2e" },
    });
  });

  it("DENY (MISPLACEMENT DETECTOR): verified grant but the workflow is NOT scoped for the tool", async () => {
    // If the grant disjunct escaped the automationScope conjunction, the LIVE policy would allow
    // this — an approval for one tool would unlock every tool. This assertion is that guard.
    const grant = mintVerified("deploy.production", DEPLOY_ARGS);
    expect(await livePolicyAllows(noScopeWf, "deploy.production", grant)).toBe(false);
    const d = await authorizeCall(noScopeWf, "deploy.production", mintVerified("deploy.production", DEPLOY_ARGS));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/not scoped/);
  });

  it("DENY: verified grant + in scope, but the tool is a MONEY tool absent from the policy list", async () => {
    // The in-code engine ALLOWS this (the grant lifts its impact branch), so the deny can only come
    // from the policy's explicit executable list — exactly the containment ruling (c) buys.
    const grant = mintVerified("search.setBudget", {});
    expect(await livePolicyAllows(moneyWf, "search.setBudget", grant)).toBe(false);
    const { authorize } = await import("./policy");
    expect(authorize(moneyWf, "search.setBudget", mintVerified("search.setBudget", {})).allow).toBe(true);
    const d = await authorizeCall(moneyWf, "search.setBudget", mintVerified("search.setBudget", {}));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("denied by policy: search.setBudget");
  });

  it("DENY (drift direction): a registry tool missing from the policy list fails CLOSED", async () => {
    const grant = mintVerified("deploy.canary", {});
    expect(await livePolicyAllows(driftWf, "deploy.canary", grant)).toBe(false);
    const d = await authorizeCall(driftWf, "deploy.canary", mintVerified("deploy.canary", {}));
    expect(d.allow).toBe(false); // visible refusal -> the approval row lands `failed`, never a silent allow
  });

  it("DENY: no grant ⇒ today's exact behaviour (suspend) for the same call", async () => {
    expect(await livePolicyAllows(deliveryWf, "deploy.production")).toBe(false);
    const d = await authorizeCall(deliveryWf, "deploy.production");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*high-impact write/);
  });

  it("DENY (fail closed): an empty or null approvalId attribute does not lift the gate", async () => {
    // Reaches past the hub's typed seam to prove the POLICY is fail-closed on both shapes, not just
    // that cerbos.ts happens never to send them.
    for (const approvalId of ["", null]) {
      const res = await realFetch(`${LIVE_CERBOS}/api/check/resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "t",
          principal: { id: "wf:delivery", roles: ["hub_caller"], attr: { assurance: "low", provider: "n8n", isAutomation: true, automationScope: ["deploy.production"] } },
          resources: [{ actions: ["call"], resource: { kind: "mcp_tool", id: "deploy.production", attr: { name: "deploy.production", minAssurance: "low", write: true, impact: "high", approvalId } } }],
        }),
      });
      const data = (await res.json()) as { results: Array<{ actions: { call: string } }> };
      expect(data.results[0].actions.call).toBe("EFFECT_DENY");
    }
  });

  it("a grant NEVER buys assurance rank (verified-only tool, low automation caller)", async () => {
    registerTool({ name: "deploy.production", description: "verified-only variant", minAssurance: "verified", write: true, impact: "high", inputSchema: { type: "object" }, handler: async () => "x" });
    const grant = mintVerified("deploy.production", DEPLOY_ARGS);
    expect(await livePolicyAllows(deliveryWf, "deploy.production", grant)).toBe(false);
  });

  it("non-automation principals decide IDENTICALLY with and without a grant", async () => {
    const without = await livePolicyAllows(human, "deploy.production");
    const withGrant = await livePolicyAllows(human, "deploy.production", mintVerified("deploy.production", DEPLOY_ARGS));
    expect(withGrant).toBe(without);
    expect(without).toBe(true); // a verified human may run a high-impact write; D14 never applied to them
  });

  // ── PRV-03 — the SAME grant-lift matrix, for `webdev.provisionSite` (write:true, impact:"medium",
  // added to `wf:delivery`'s REAL allowlist entry and to the executable list in this same policy
  // file). Distinct from deploy.production's block above because the tool is medium-impact (a
  // different in-code suspend-reason string) and is a REAL, permanent AUTOMATION_ALLOWLIST member
  // (not a fixture scope added/removed for this test), so no beforeAll/afterAll wiring is needed.
  describe("PRV-03 — webdev.provisionSite (medium-impact write, wf:delivery)", () => {
    const PROVISION_ARGS = { tenantId: "tenant-1", runId: "run-1", framework: "vite" };

    beforeEach(() => {
      registerTool({
        name: "webdev.provisionSite",
        description: "provision a site+repo",
        minAssurance: "low",
        write: true,
        impact: "medium",
        inputSchema: { type: "object" },
        handler: async () => "PROVISIONED",
      });
    });

    it("ALLOW: automation + workflow-scoped (wf:delivery) + verified grant + tool in the executable list", async () => {
      const grant = mintVerified("webdev.provisionSite", PROVISION_ARGS);
      expect(await livePolicyAllows(deliveryWf, "webdev.provisionSite", grant)).toBe(true);
      const d = await authorizeCall(deliveryWf, "webdev.provisionSite", grant);
      expect(d.allow).toBe(true);
    });

    it("DENY: no grant ⇒ suspend for a medium-impact write (the D14 beat the design's WS4 approval IS)", async () => {
      expect(await livePolicyAllows(deliveryWf, "webdev.provisionSite")).toBe(false);
      const d = await authorizeCall(deliveryWf, "webdev.provisionSite");
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/suspend.*medium-impact/);
    });

    it("DENY (MISPLACEMENT DETECTOR): verified grant but the workflow is NOT scoped to webdev.provisionSite", async () => {
      const grant = mintVerified("webdev.provisionSite", PROVISION_ARGS);
      expect(await livePolicyAllows(noScopeWf, "webdev.provisionSite", grant)).toBe(false);
      const d = await authorizeCall(noScopeWf, "webdev.provisionSite", grant);
      expect(d.allow).toBe(false);
    });

    it("DENY: a grant minted for a DIFFERENT tool name does not lift webdev.provisionSite (args/tool binding)", async () => {
      const grant = mintVerified("deploy.production", DEPLOY_ARGS);
      expect(await livePolicyAllows(deliveryWf, "webdev.provisionSite", grant)).toBe(false);
    });

    it("non-automation principals decide IDENTICALLY with and without a grant (D14 never applied to them)", async () => {
      const without = await livePolicyAllows(human, "webdev.provisionSite");
      const withGrant = await livePolicyAllows(human, "webdev.provisionSite", mintVerified("webdev.provisionSite", PROVISION_ARGS));
      expect(withGrant).toBe(without);
      expect(without).toBe(true);
    });
  });

  it("PARITY: with CERBOS_URL unset the in-code engine yields the same verdicts", async () => {
    config.cerbosUrl = "";
    const { authorize } = await import("./policy");
    // in scope + granted + listed -> allow (matches the live ALLOW above)
    expect(authorize(deliveryWf, "deploy.production", mintVerified("deploy.production", DEPLOY_ARGS)).allow).toBe(true);
    // not scoped + granted -> deny (matches the misplacement detector)
    expect(authorize(noScopeWf, "deploy.production", mintVerified("deploy.production", DEPLOY_ARGS)).allow).toBe(false);
    // no grant -> deny/suspend (matches)
    expect(authorize(deliveryWf, "deploy.production").allow).toBe(false);
    // KNOWN, DELIBERATE ASYMMETRY: the in-code engine has NO executable-tool list, so a granted
    // money/unlisted tool allows in-code and denies under Cerbos (stricter). Cerbos is authoritative
    // wherever it is configured (compose sets CERBOS_URL for both hub instances), and authorizeCall
    // returns the Cerbos deny, so the EFFECTIVE verdict is the strict one. Asserted, not glossed:
    expect(authorize(moneyWf, "search.setBudget", mintVerified("search.setBudget", {})).allow).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2026-08-19 — the batch-limit regression, found on the live box and not by any test.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Cerbos rejects a CheckResources request carrying more resources than its configured batch limit (50
// by default). Once the hub's tool count passed 50, EVERY visibility check failed with
// `InvalidArgument: number of resources in batch (128) exceeds configured limit (50)` and
// `visibleToolsFor` fell back to the in-code engine — a plausible answer plus one warning line, so
// nothing looked broken. Cerbos had stopped being authoritative for the tool list.
//
// These cases fail against the pre-fix client: the first because a single 128-resource request would be
// sent (and the stub asserts no request exceeds the limit), the second because the fallback swallowed
// the error instead of the client never producing it.
describe("cerbosAllowedTools batching (2026-08-19 regression)", () => {
  /** Stub that REFUSES an oversized batch exactly the way the server does, so the test fails if the
   *  client stops chunking — mirroring the real failure rather than asserting an internal detail. */
  function stubCerbosWithLimit(limit: number, allow: (name: string) => boolean, seen: number[]) {
    return vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { resources: Array<{ resource: { id: string } }> };
      seen.push(body.resources.length);
      if (body.resources.length > limit) {
        return { ok: false, status: 400, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: body.resources.map((r) => ({
            resource: { id: r.resource.id },
            actions: { call: allow(r.resource.id) ? "EFFECT_ALLOW" : "EFFECT_DENY" },
          })),
        }),
      };
    }) as unknown as typeof fetch;
  }

  const manyTools = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `bulk.tool${i}`,
      description: "x",
      minAssurance: "low" as const,
      inputSchema: { type: "object" as const },
      handler: async () => ({ content: [] }),
    }));

  beforeEach(() => {
    config.cerbosUrl = "http://cerbos.test";
  });
  afterEach(() => vi.restoreAllMocks());

  it("🔴 128 tools are authorized in chunks no larger than the server's limit — the live failure", async () => {
    const seen: number[] = [];
    vi.stubGlobal("fetch", stubCerbosWithLimit(50, () => true, seen));
    const { cerbosAllowedTools, CERBOS_RESOURCE_BATCH_MAX } = await import("./cerbos");

    const tools = manyTools(128);
    const allowed = await cerbosAllowedTools(lowUser, tools as never);

    expect(allowed.size).toBe(128); // nothing lost across the chunk seam
    expect(seen.length).toBeGreaterThan(1); // it actually chunked
    expect(Math.max(...seen)).toBeLessThanOrEqual(CERBOS_RESOURCE_BATCH_MAX);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(128); // every tool asked about exactly once
  });

  it("merges verdicts across chunks — a deny in a later chunk is still a deny", async () => {
    const seen: number[] = [];
    vi.stubGlobal("fetch", stubCerbosWithLimit(50, (n) => n !== "bulk.tool100", seen));
    const { cerbosAllowedTools } = await import("./cerbos");

    const allowed = await cerbosAllowedTools(lowUser, manyTools(128) as never);

    expect(allowed.has("bulk.tool100")).toBe(false);
    expect(allowed.has("bulk.tool99")).toBe(true);
    expect(allowed.size).toBe(127);
  });

  it("FAILS CLOSED: one chunk erroring rejects the whole call, never a partial allow-set", async () => {
    // A partial answer is indistinguishable from "Cerbos denied those tools", which is precisely the
    // ambiguity that let the original defect hide behind a fallback.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { resources: unknown[] };
        if (++calls === 2) return { ok: false, status: 503, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: (body.resources as Array<{ resource: { id: string } }>).map((r) => ({
              resource: { id: r.resource.id },
              actions: { call: "EFFECT_ALLOW" },
            })),
          }),
        };
      }) as unknown as typeof fetch,
    );
    const { cerbosAllowedTools } = await import("./cerbos");

    await expect(cerbosAllowedTools(lowUser, manyTools(128) as never)).rejects.toThrow(/cerbos 503/);
  });

  it("a single-tool call (the D14-13 path) still sends exactly one resource", async () => {
    const seen: number[] = [];
    vi.stubGlobal("fetch", stubCerbosWithLimit(50, () => true, seen));
    const { cerbosAllowsTool } = await import("./cerbos");

    await cerbosAllowsTool(lowUser, manyTools(1)[0] as never);

    expect(seen).toEqual([1]);
  });
});
