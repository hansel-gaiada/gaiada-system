// D14-04 — the hub-side execution grant. These tests are the security proof of the ticket:
// deny-by-default must survive every failure mode, and a valid grant must lift the impact-suspend
// branch and NOTHING else. Read alongside the contract in approval-grant.ts's header.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "./config";
import { buildHubServer } from "./hub";
import { authorize, visibleTools } from "./policy";
import { resetRegistry, registerTool } from "./registry";
import { registerCoreTools } from "./tools";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import type { Principal } from "./principal";
import type { ToolAudit } from "./audit";
import {
  canonicalJson,
  computeArgsSha256,
  signGrantPayload,
  verifyExecutionGrant,
  resetGrantNonceCache,
  GRANT_MAX_WINDOW_MS,
} from "./approval-grant";

const SECRET = "test-approval-grant-secret";
const AUDIT_DIR = "data/test-audit-grant";

const wf = (externalId: string): Principal => ({ provider: "n8n", externalId, assurance: "low" });
const human: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "low" };

let nonceSeq = 0;

/** Mint a grant for a call, via the reference minter (the same shape D14-03 must produce). */
function mintGrant(opts: {
  toolName: string;
  args: Record<string, unknown>;
  tenantId?: string;
  approvalId?: string;
  iat?: number;
  exp?: number;
  nonce?: string;
  argsSha256?: string;
  v?: number;
  secret?: string;
}): string {
  const iat = opts.iat ?? Date.now();
  return signGrantPayload(
    {
      v: (opts.v ?? 1) as 1,
      approvalId: opts.approvalId ?? "apr-0001",
      tenantId: opts.tenantId ?? "tenant-1",
      toolName: opts.toolName,
      argsSha256: opts.argsSha256 ?? computeArgsSha256(opts.args),
      iat,
      exp: opts.exp ?? iat + 60_000,
      nonce: opts.nonce ?? `nonce-${++nonceSeq}`,
    },
    opts.secret ?? SECRET,
  );
}

async function connect(principal: Principal, approvalGrant?: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildHubServer(principal, { approvalGrant }).connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function auditLines(): ToolAudit[] {
  return readFileSync(config.auditFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ToolAudit);
}

/** The audit row for a tool, newest last. */
function lastAuditFor(tool: string): ToolAudit | undefined {
  return auditLines().filter((a) => a.tool === tool).pop();
}

// ─────────────────────────────── canonical JSON (the cross-service contract) ─────────────────────

describe("canonical JSON + argsSha256 (contract §1 — D14-03 must reproduce these exactly)", () => {
  it("sorts keys recursively, preserves array order, and uses no separators", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson({ b: 1, a: { d: 1, c: [3, { y: 2, x: 1 }] } })).toBe('{"a":{"c":[3,{"x":1,"y":2}],"d":1},"b":1}');
    // Array order is DATA — never sorted.
    expect(canonicalJson({ xs: [3, 1, 2] })).toBe('{"xs":[3,1,2]}');
  });

  it("is insertion-order independent (the whole point of canonicalization)", () => {
    const a = { repo: "acme/site", ref: "main", runId: "r1" };
    const b = { runId: "r1", repo: "acme/site", ref: "main" };
    expect(computeArgsSha256(a)).toBe(computeArgsSha256(b));
  });

  it("drops undefined-valued keys, keeps null, and maps non-finite numbers to null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson({ n: NaN, i: Infinity })).toBe('{"i":null,"n":null}');
    // An undefined ARRAY element becomes null (JSON.stringify semantics), it is not dropped.
    expect(canonicalJson({ xs: [1, undefined, 2] })).toBe('{"xs":[1,null,2]}');
  });

  it("emits non-ASCII literally (no unicode escaping, no NFC/NFKC normalization)", () => {
    const precomposed = "caf" + String.fromCodePoint(0x00e9); // e-acute as ONE code point
    const decomposed = "cafe" + String.fromCodePoint(0x0301); // e + combining acute
    // Emitted literally: the canonical form carries the character, never an escape sequence.
    expect(canonicalJson({ k: precomposed })).toBe(JSON.stringify({ k: precomposed }));
    expect(canonicalJson({ k: precomposed }).includes(String.fromCharCode(92, 117))).toBe(false);
    // Precomposed vs decomposed are DIFFERENT args and must hash differently (no normalization).
    expect(computeArgsSha256({ k: precomposed })).not.toBe(computeArgsSha256({ k: decomposed }));
    // String escaping is exactly JSON.stringify's: quotes, backslash and C0 controls, nothing else.
    const tricky = { k: String.fromCharCode(34, 92, 10, 1) };
    expect(canonicalJson(tricky)).toBe(JSON.stringify(tricky));
  });

  it("pins fixed digest vectors (copy these into the platform-side test)", () => {
    expect(computeArgsSha256({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(computeArgsSha256({ b: 1, a: { d: 1, c: [3, { y: 2, x: 1 }] } })).toBe(
      "f2b017ad2046767a1fb4a845843b145aef66713aa8adef3952e980dc15f44ce4",
    );
    expect(computeArgsSha256({ runId: "r1", repo: "acme/site" })).toBe(
      "756a6e9ac2f5873539d73f9a95008a46ed673573ade26e86ff42a6b27b1f9dad",
    );
    // …and that the vectors really are sha256(canonicalJson(args)).
    expect(computeArgsSha256({ x: 1 })).toBe(createHash("sha256").update('{"x":1}', "utf8").digest("hex"));
  });
});

// ───────────────────────────────────── verification unit matrix ──────────────────────────────────

describe("verifyExecutionGrant — deny-by-default on every failure mode", () => {
  const args = { runId: "r1", repo: "acme/site" };
  const call = { toolName: "deploy.production", args };

  beforeEach(() => {
    config.approvalGrantSecret = SECRET;
    resetGrantNonceCache();
  });
  afterEach(() => {
    config.approvalGrantSecret = "";
  });

  it("accepts a well-formed, in-window, matching grant", () => {
    const v = verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args }), call);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.grant.approvalId).toBe("apr-0001");
      expect(v.grant.toolName).toBe("deploy.production");
    }
  });

  it("fails CLOSED when APPROVAL_GRANT_SECRET is unset — every grant rejected, never skipped", () => {
    const header = mintGrant({ toolName: "deploy.production", args });
    config.approvalGrantSecret = "";
    const v = verifyExecutionGrant(header, call);
    expect(v).toEqual({ ok: false, reason: "secret_not_configured" });
  });

  it("rejects a grant signed with the wrong secret, and one whose signature is tampered", () => {
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, secret: "other" }), call)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    const good = mintGrant({ toolName: "deploy.production", args });
    const [payload, sig] = good.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyExecutionGrant(`${payload}.${flipped}`, call)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered PAYLOAD (claims are never trusted before the HMAC verifies)", () => {
    const good = mintGrant({ toolName: "deploy.production", args });
    const sig = good.split(".")[1];
    const forged = Buffer.from(
      JSON.stringify({ v: 1, approvalId: "attacker", tenantId: "tenant-1", toolName: "deploy.production", argsSha256: computeArgsSha256(args), iat: Date.now(), exp: Date.now() + 60_000, nonce: "n" }),
      "utf8",
    ).toString("base64url");
    const v = verifyExecutionGrant(`${forged}.${sig}`, call);
    expect(v).toMatchObject({ ok: false, reason: "bad_signature" });
    // No approvalId is promoted out of an unauthenticated payload.
    expect((v as { approvalId?: string }).approvalId).toBeUndefined();
  });

  it("rejects malformed shapes (no dot, extra dots, empty parts, junk, oversized)", () => {
    for (const bad of ["", "   ", "nodot", "a.b.c", ".sig", "payload.", "not*base64url.sig", "x".repeat(5000) + ".sig"]) {
      expect(verifyExecutionGrant(bad, call).ok).toBe(false);
    }
    expect(verifyExecutionGrant("nodot", call)).toMatchObject({ reason: "malformed" });
  });

  it("rejects a non-v1 payload and structurally bad claims", () => {
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, v: 2 }), call)).toMatchObject({
      ok: false,
      reason: "unsupported_version",
    });
    const noNonce = signGrantPayload(
      { v: 1, approvalId: "a", tenantId: "t", toolName: "deploy.production", argsSha256: computeArgsSha256(args), iat: Date.now(), exp: Date.now() + 1000, nonce: "" },
      SECRET,
    );
    expect(verifyExecutionGrant(noNonce, call)).toMatchObject({ ok: false, reason: "bad_claims" });
  });

  it("rejects an expired grant, a window longer than 120s, and a far-future iat", () => {
    const past = Date.now() - 200_000;
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: past, exp: past + 60_000 }), call)).toMatchObject({
      ok: false,
      reason: "expired",
      approvalId: "apr-0001",
    });
    const now = Date.now();
    expect(
      verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: now, exp: now + GRANT_MAX_WINDOW_MS + 1_000 }), call),
    ).toMatchObject({ ok: false, reason: "bad_window" });
    // exp <= iat is also nonsense.
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: now, exp: now }), call)).toMatchObject({
      ok: false,
      reason: "bad_window",
    });
    const future = Date.now() + 10 * 60_000;
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: future, exp: future + 60_000 }), call)).toMatchObject({
      ok: false,
      reason: "not_yet_valid",
    });
  });

  it("rejects a grant aimed at a different tool, tenant, or args", () => {
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.staging", args }), call)).toMatchObject({
      ok: false,
      reason: "tool_mismatch",
    });
    // Args carrying an explicit tenant must agree with the grant's tenant.
    const tenantArgs = { tenantId: "tenant-2", x: 1 };
    expect(
      verifyExecutionGrant(mintGrant({ toolName: "t", args: tenantArgs, tenantId: "tenant-1" }), { toolName: "t", args: tenantArgs }),
    ).toMatchObject({ ok: false, reason: "tenant_mismatch" });
    // One changed field ⇒ a different call ⇒ no authorization.
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args }), { toolName: "deploy.production", args: { ...args, ref: "hotfix" } })).toMatchObject({
      ok: false,
      reason: "args_mismatch",
    });
    // …including an args hash the minter got wrong.
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, argsSha256: "0".repeat(64) }), call)).toMatchObject({
      ok: false,
      reason: "args_mismatch",
    });
  });

  it("burns the nonce on acceptance only — a replay is rejected, an invalid grant costs nothing", () => {
    const header = mintGrant({ toolName: "deploy.production", args, nonce: "single-use" });
    expect(verifyExecutionGrant(header, call).ok).toBe(true);
    expect(verifyExecutionGrant(header, call)).toMatchObject({ ok: false, reason: "replayed_nonce", approvalId: "apr-0001" });
    // A grant rejected earlier in the chain must not have consumed its nonce.
    const wrongTool = mintGrant({ toolName: "deploy.staging", args, nonce: "not-burned" });
    expect(verifyExecutionGrant(wrongTool, call)).toMatchObject({ reason: "tool_mismatch" });
    const sameNonce = mintGrant({ toolName: "deploy.production", args, nonce: "not-burned" });
    expect(verifyExecutionGrant(sameNonce, call).ok).toBe(true);
  });

  it("accepts equivalent encodings of the same values (interop safety, not a weakening)", () => {
    const now = Date.now();
    // Epoch SECONDS instead of milliseconds.
    const seconds = mintGrant({
      toolName: "deploy.production",
      args,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 60,
      nonce: "sec-units",
    });
    expect(verifyExecutionGrant(seconds, call).ok).toBe(true);
    // base64 argsSha256 instead of hex.
    const b64 = mintGrant({
      toolName: "deploy.production",
      args,
      argsSha256: Buffer.from(computeArgsSha256(args), "hex").toString("base64"),
      nonce: "b64-digest",
    });
    expect(verifyExecutionGrant(b64, call).ok).toBe(true);
    // UPPERCASE hex argsSha256.
    const upper = mintGrant({ toolName: "deploy.production", args, argsSha256: computeArgsSha256(args).toUpperCase(), nonce: "upper" });
    expect(verifyExecutionGrant(upper, call).ok).toBe(true);
    // Each claim is normalized INDEPENDENTLY, so even a mixed-unit payload resolves to the two
    // instants the minter meant — and the ≤120s window is enforced after normalization, in whatever
    // unit was used. A 121s window expressed in SECONDS is still rejected.
    expect(
      verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: Math.floor(now / 1000), exp: now + 60_000, nonce: "mixed-a" }), call).ok,
    ).toBe(true);
    expect(
      verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: now, exp: Math.floor(now / 1000) + 60, nonce: "mixed-b" }), call).ok,
    ).toBe(true);
    const s = Math.floor(now / 1000);
    expect(verifyExecutionGrant(mintGrant({ toolName: "deploy.production", args, iat: s, exp: s + 121, nonce: "sec-too-long" }), call)).toMatchObject({
      ok: false,
      reason: "bad_window",
    });
  });
});

// ─────────────────────────────── the gate itself: what a grant may lift ──────────────────────────

describe("the grant lifts ONLY the impact-suspend branch", () => {
  beforeEach(() => {
    config.approvalGrantSecret = SECRET;
    resetGrantNonceCache();
    resetRegistry();
    registerCoreTools();
    registerTool({
      name: "money.transfer",
      description: "test medium write",
      minAssurance: "low",
      write: true,
      impact: "medium",
      inputSchema: { type: "object" },
      handler: async () => "transferred",
    });
    registerTool({
      name: "vault.open",
      description: "test high write requiring verified assurance",
      minAssurance: "verified",
      write: true,
      impact: "high",
      inputSchema: { type: "object" },
      handler: async () => "opened",
    });
    AUTOMATION_ALLOWLIST["wf:test-grant"] = ["money.transfer", "vault.open"];
  });
  afterEach(() => {
    delete AUTOMATION_ALLOWLIST["wf:test-grant"];
    config.approvalGrantSecret = "";
  });

  const grantFor = (toolName: string, args: Record<string, unknown> = {}) => {
    const v = verifyExecutionGrant(mintGrant({ toolName, args }), { toolName, args });
    if (!v.ok) throw new Error(`fixture grant rejected: ${v.reason}`);
    return v.grant;
  };

  it("a medium write suspends without a grant and runs with one", () => {
    const p = wf("wf:test-grant");
    const without = authorize(p, "money.transfer");
    expect(without.allow).toBe(false);
    if (!without.allow) expect(without.reason).toMatch(/suspend.*medium-impact/);
    expect(authorize(p, "money.transfer", grantFor("money.transfer")).allow).toBe(true);
  });

  it("workflowScope is untouched: a grant cannot reach a tool the workflow is not scoped for", () => {
    // A perfectly valid grant, presented by a workflow with no scope for the tool.
    const d = authorize(wf("wf:not-registered"), "money.transfer", grantFor("money.transfer"));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/denied: workflow wf:not-registered is not scoped for money.transfer/);
  });

  it("minAssurance rank is untouched: a grant cannot step a low principal up to a verified tool", () => {
    const d = authorize(wf("wf:test-grant"), "vault.open", grantFor("vault.open"));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/requires verified assurance/);
  });

  it("a grant for a DIFFERENT tool does not lift this tool's suspension", () => {
    const d = authorize(wf("wf:test-grant"), "money.transfer", grantFor("vault.open"));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*medium-impact/);
  });

  it("tool VISIBILITY is unchanged by grants (they authorize, they never advertise)", () => {
    const before = visibleTools(wf("wf:test-grant")).map((t) => t.name).sort();
    expect(before).toEqual(["money.transfer"]); // vault.open needs verified assurance
    expect(visibleTools(human).map((t) => t.name)).toContain("whoami");
  });
});

// ──────────────────────────── end to end through the MCP call site + audit ───────────────────────

describe("hub tool-call site: grant plumbing, execution, and the JSONL audit", () => {
  const args = { amount: 100, to: "acct-9" };

  beforeEach(() => {
    config.approvalGrantSecret = SECRET;
    config.cerbosUrl = "";
    config.auditFile = `${AUDIT_DIR}/tools.jsonl`;
    rmSync(AUDIT_DIR, { recursive: true, force: true });
    resetGrantNonceCache();
    resetRegistry();
    registerCoreTools();
    registerTool({
      name: "money.transfer",
      description: "test medium write",
      minAssurance: "low",
      write: true,
      impact: "medium",
      inputSchema: { type: "object" },
      handler: async () => "transferred",
    });
    AUTOMATION_ALLOWLIST["wf:test-grant"] = ["money.transfer"];
  });
  afterEach(() => {
    delete AUTOMATION_ALLOWLIST["wf:test-grant"];
    config.approvalGrantSecret = "";
    config.cerbosUrl = "";
    vi.unstubAllGlobals();
  });
  afterAll(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

  it("valid grant + in-scope workflow + Cerbos allow ⇒ the tool EXECUTES, audited with approvalId", async () => {
    config.cerbosUrl = "http://cerbos.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [{ resource: { id: "money.transfer" }, actions: { call: "EFFECT_ALLOW" } }] }),
      })),
    );
    const client = await connect(wf("wf:test-grant"), mintGrant({ toolName: "money.transfer", args, approvalId: "apr-exec" }));
    const res = await client.callTool({ name: "money.transfer", arguments: args });
    expect(res.isError ?? false).toBe(false);
    expect((res.content as Array<{ text: string }>)[0].text).toBe("transferred");

    const row = lastAuditFor("money.transfer");
    expect(row).toMatchObject({ decision: "allow", ok: true, grant: { verdict: "accepted", approvalId: "apr-exec" } });
  });

  it("valid grant + workflow NOT in AUTOMATION_ALLOWLIST ⇒ deny with the UNCHANGED reason", async () => {
    const client = await connect(wf("wf:unlisted"), mintGrant({ toolName: "money.transfer", args }));
    const res = await client.callTool({ name: "money.transfer", arguments: args });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("is not scoped for money.transfer");
    expect(lastAuditFor("money.transfer")).toMatchObject({ decision: "deny", grant: { verdict: "accepted", approvalId: "apr-0001" } });
  });

  it("valid grant + Cerbos DENY ⇒ deny (Cerbos evaluation is unchanged by the grant)", async () => {
    config.cerbosUrl = "http://cerbos.test";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) })));
    const client = await connect(wf("wf:test-grant"), mintGrant({ toolName: "money.transfer", args }));
    const res = await client.callTool({ name: "money.transfer", arguments: args });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("denied by policy: money.transfer");
    expect(JSON.stringify(res.content)).not.toContain("transferred");
    expect(lastAuditFor("money.transfer")).toMatchObject({ decision: "deny", grant: { verdict: "accepted" } });
  });

  const suspends = async (header: string, expectedReason: string, callArgs: Record<string, unknown> = args) => {
    const client = await connect(wf("wf:test-grant"), header);
    const res = await client.callTool({ name: "money.transfer", arguments: callArgs });
    expect(res.isError).toBe(true);
    // Today's EXACT suspend reason — a rejected grant is simply not a grant.
    expect(JSON.stringify(res.content)).toMatch(/suspend: money.transfer is a medium-impact write/);
    expect(JSON.stringify(res.content)).not.toContain("transferred");
    const row = lastAuditFor("money.transfer");
    expect(row?.decision).toBe("deny");
    expect(row?.grant).toMatchObject({ verdict: "rejected", reason: expectedReason });
    return row!;
  };

  it("tampered signature ⇒ suspends as today (and no approvalId is trusted into the audit)", async () => {
    const good = mintGrant({ toolName: "money.transfer", args });
    const [payload, sig] = good.split(".");
    const row = await suspends(`${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, "bad_signature");
    expect(row.grant?.approvalId).toBeUndefined();
  });

  it("expired grant ⇒ suspends as today, audited with the verified approvalId", async () => {
    const past = Date.now() - 300_000;
    const row = await suspends(mintGrant({ toolName: "money.transfer", args, iat: past, exp: past + 60_000, approvalId: "apr-old" }), "expired");
    expect(row.grant?.approvalId).toBe("apr-old");
  });

  it("args-hash mismatch ⇒ suspends as today (the approval binds ONE exact call)", async () => {
    // Grant minted for the approved args; the workflow calls with a bigger amount.
    await suspends(mintGrant({ toolName: "money.transfer", args }), "args_mismatch", { ...args, amount: 9_999_999 });
  });

  it("second use of the same nonce ⇒ suspends as today", async () => {
    const header = mintGrant({ toolName: "money.transfer", args, nonce: "burn-once", approvalId: "apr-replay" });
    const first = await connect(wf("wf:test-grant"), header);
    expect((await first.callTool({ name: "money.transfer", arguments: args })).isError ?? false).toBe(false);
    const row = await suspends(header, "replayed_nonce");
    expect(row.grant?.approvalId).toBe("apr-replay");
  });

  it("unset APPROVAL_GRANT_SECRET ⇒ every grant rejected, tool still suspended (fail closed)", async () => {
    const header = mintGrant({ toolName: "money.transfer", args });
    config.approvalGrantSecret = "";
    await suspends(header, "secret_not_configured");
  });

  it("NO grant header ⇒ byte-for-byte today's behaviour, and no grant field in the audit at all", async () => {
    const client = await connect(wf("wf:test-grant"));
    const res = await client.callTool({ name: "money.transfer", arguments: args });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/suspend: money.transfer is a medium-impact write/);
    const row = lastAuditFor("money.transfer");
    expect(row?.grant).toBeUndefined();
    expect(Object.keys(row ?? {}).sort()).toEqual(["decision", "principal", "reason", "tool", "ts"]);
  });

  it("a NON-automation principal's grant is audit-only — it changes no decision either way", async () => {
    // The gate never applied to a human/agent principal (origin=agent re-drives), so the grant is
    // recorded and nothing else. A read the principal could already do still works…
    const okClient = await connect(human, mintGrant({ toolName: "whoami", args: {} }));
    const ok = await okClient.callTool({ name: "whoami", arguments: {} });
    expect(ok.isError ?? false).toBe(false);
    expect(lastAuditFor("whoami")).toMatchObject({ decision: "allow", grant: { verdict: "accepted" } });
    // …and one it could NOT is still denied for the same reason as before, grant or no grant.
    const denied = await connect(human, mintGrant({ toolName: "rollup.metrics", args: {} }));
    const res = await denied.callTool({ name: "rollup.metrics", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("verified");
    expect(lastAuditFor("rollup.metrics")).toMatchObject({ decision: "deny", grant: { verdict: "accepted" } });
  });

  it("a LOW-impact write is unaffected: it already ran unattended, with or without a grant", async () => {
    registerTool({
      name: "notes.append",
      description: "test low write",
      minAssurance: "low",
      write: true,
      impact: "low",
      inputSchema: { type: "object" },
      handler: async () => "appended",
    });
    AUTOMATION_ALLOWLIST["wf:test-grant"] = ["money.transfer", "notes.append"];
    const client = await connect(wf("wf:test-grant"));
    expect((await client.callTool({ name: "notes.append", arguments: {} })).isError ?? false).toBe(false);
  });
});

// ─────────────── the header actually traverses the real HTTP entrypoint (not inert) ──────────────
//
// The grant arrives as an HTTP header on POST /mcp but is verified deep at the tool-call site, so the
// plumbing between them is load-bearing: drop it and the whole D14 resume path is silently inert
// (every approved automation write keeps suspending, with no signal anything is wrong). This drives
// the real express app with a real MCP client, exactly how platform-nest's executor will call it.
describe("POST /mcp: x-approval-grant reaches the tool-call site over real HTTP", () => {
  const args = { amount: 1, to: "acct-1" };
  let httpServer: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = SECRET;
    config.cerbosUrl = "";
    config.auditFile = `${AUDIT_DIR}-http/tools.jsonl`;
    rmSync(`${AUDIT_DIR}-http`, { recursive: true, force: true });
    resetGrantNonceCache();
    resetRegistry();
    const { buildHttpApp } = await import("./server");
    const app = buildHttpApp(); // registers the real tool groups
    registerTool({
      name: "money.transfer",
      description: "test medium write",
      minAssurance: "low",
      write: true,
      impact: "medium",
      inputSchema: { type: "object" },
      handler: async () => "transferred",
    });
    AUTOMATION_ALLOWLIST["wf:test-grant-http"] = ["money.transfer"];
    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    delete AUTOMATION_ALLOWLIST["wf:test-grant-http"];
    config.approvalGrantSecret = "";
    rmSync(`${AUDIT_DIR}-http`, { recursive: true, force: true });
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("executes the approved medium write once, then rejects the replayed grant", async () => {
    const { Client: HttpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const header = mintGrant({ toolName: "money.transfer", args, approvalId: "apr-http", nonce: "http-once" });
    const client = new HttpClient({ name: "http-grant-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: {
            Authorization: "Bearer svc-token",
            "x-obo-provider": "n8n",
            "x-obo-external-id": "wf:test-grant-http",
            "x-approval-grant": header,
          },
        },
      }),
    );

    const first = await client.callTool({ name: "money.transfer", arguments: args });
    expect(first.isError ?? false).toBe(false);
    expect((first.content as Array<{ text: string }>)[0].text).toBe("transferred");

    // Same transport, same header: the nonce is spent, so the gate is back.
    const second = await client.callTool({ name: "money.transfer", arguments: args });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toMatch(/suspend: money.transfer is a medium-impact write/);
    await client.close();

    const rows = auditLines().filter((a) => a.tool === "money.transfer");
    expect(rows.at(-2)).toMatchObject({ decision: "allow", ok: true, grant: { verdict: "accepted", approvalId: "apr-http" } });
    expect(rows.at(-1)).toMatchObject({ decision: "deny", grant: { verdict: "rejected", reason: "replayed_nonce", approvalId: "apr-http" } });
  });

  it("/admin/info exposes whether the grant secret is configured (a fail-closed misconfig must be visible)", async () => {
    const r = await fetch(`${base}/admin/info`, { headers: { Authorization: "Bearer svc-token" } });
    const body = (await r.json()) as { policy: { executionGrantConfigured: boolean } };
    expect(body.policy.executionGrantConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
