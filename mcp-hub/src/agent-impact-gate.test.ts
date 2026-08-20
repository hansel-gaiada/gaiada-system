// 2026-08-20 — the D14 impact gate applies to AGENT-DRIVEN calls, not only to n8n.
//
// ── THE DEFECT, AND WHY IT SURVIVED SO LONG ──────────────────────────────────────────────────────
// `runAgent` sends the requesting HUMAN's OBO envelope verbatim — deliberately, so an agent can never
// act with more authority than the person it serves. The consequence nobody had followed through: the
// hub therefore saw `provider: "whatsapp"` (or `platform`) for an agent-driven call, `isAutomation()`
// is literally `provider === "n8n"`, and the medium/high-impact suspend branch sat INSIDE that check.
//
// So an n8n workflow calling a HIGH-impact write suspended for human approval, and an agent calling
// THE SAME TOOL ran it unattended. The protection D14 exists to provide was unenforceable against
// precisely the caller it was designed for, in both the in-code engine AND the Cerbos policy.
//
// Every test below FAILS against the pre-fix code: without `principal.agent` and `isUnattended`, each
// agent-driven case returns `allow: true`.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { config } from "./config";
import { resetRegistry, registerTool } from "./registry";
import { authorize, authorizeCall } from "./policy";
import { mintPrincipal, isUnattended, type Principal } from "./principal";

const HUMAN: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "verified" };
const AGENT: Principal = { ...HUMAN, agent: "agent:task-filer" };
const N8N: Principal = { provider: "n8n", externalId: "wf:delivery", assurance: "verified" };

function tool(name: string, over: Partial<{ write: boolean; impact: "low" | "medium" | "high" }> = {}) {
  registerTool({
    name,
    description: "x",
    minAssurance: "low",
    inputSchema: { type: "object" },
    handler: async () => "",
    ...over,
  });
}

describe("isUnattended — the predicate the impact gate needed", () => {
  it("an n8n workflow is unattended", () => {
    expect(isUnattended(N8N)).toBe(true);
  });

  it("🔴 an AGENT-DRIVEN call is unattended even though its provider is a human channel", () => {
    // This is the whole defect in one assertion: same provider, same externalId, different answer.
    expect(isUnattended(AGENT)).toBe(true);
    expect(isUnattended(HUMAN)).toBe(false);
  });

  it("a plain human on an interactive surface is ATTENDED — they do not approve their own click", () => {
    for (const provider of ["whatsapp", "telegram", "platform"]) {
      expect(isUnattended({ provider, externalId: "u1", assurance: "verified" }), provider).toBe(false);
    }
  });
});

describe("mintPrincipal carries the co-author", () => {
  it("keeps the agent marker from the envelope", () => {
    expect(mintPrincipal({ provider: "whatsapp", externalId: "x", agent: "agent:a" }).agent).toBe("agent:a");
  });

  it("omits the field entirely when absent — a non-agent principal keeps its old shape byte-for-byte", () => {
    // Rate-limit keys and audit refs are built from this object; an added `agent: undefined` would be
    // harmless in JS and noisy in JSON, and "unchanged for existing callers" is easier to verify as
    // an absent key than as a falsy one.
    expect("agent" in mintPrincipal({ provider: "whatsapp", externalId: "x" })).toBe(false);
  });

  it("🔴 an ANONYMOUS principal still carries the agent marker", () => {
    // Dropping it here would hand back the hole for the caller shape that deserves it least.
    const p = mintPrincipal({ agent: "agent:a" });
    expect(p.assurance).toBe("anonymous");
    expect(p.agent).toBe("agent:a");
  });
});

describe("the in-code gate (fail-closed fallback)", () => {
  beforeEach(() => {
    resetRegistry();
    config.cerbosUrl = "";
  });

  it("🔴 THE CORE PROOF — an agent calling a HIGH-impact write SUSPENDS", () => {
    tool("iam.grantRole", { write: true, impact: "high" });
    const d = authorize(AGENT, "iam.grantRole");
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/^suspend:/);
      // The reason names the agent, so an operator reading a suspended approval knows what drove it.
      expect(d.reason).toContain("agent:task-filer");
    }
  });

  it("a MEDIUM-impact write also suspends for an agent", () => {
    tool("iam.assignPosition", { write: true, impact: "medium" });
    expect(authorize(AGENT, "iam.assignPosition").allow).toBe(false);
  });

  it("an UNCLASSIFIED write suspends for an agent — absent impact is not permission", () => {
    tool("some.write", { write: true });
    const d = authorize(AGENT, "some.write");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("unclassified");
  });

  it("a LOW-impact write still runs unattended", () => {
    tool("iam.requestOverride", { write: true, impact: "low" });
    expect(authorize(AGENT, "iam.requestOverride").allow).toBe(true);
  });

  it("a READ runs unattended", () => {
    tool("iam.listPositions");
    expect(authorize(AGENT, "iam.listPositions").allow).toBe(true);
  });

  it("🔴 the SAME high-impact write is ALLOWED for the same human without an agent", () => {
    // The control that proves the gate keys on attendance and not on the tool: a human doing this
    // deliberately is attended, and requiring them to approve their own action would be theatre.
    tool("iam.grantRole", { write: true, impact: "high" });
    expect(authorize(HUMAN, "iam.grantRole").allow).toBe(true);
  });

  it("an agent is NOT subjected to the n8n workflow-scope check", () => {
    // Scope is a `wf:*` allow-list lookup; an agent has no workflow id, so applying it would deny
    // every agent read for a reason that was never about agents. Split conjuncts, split concerns.
    tool("iam.listPositions");
    const d = authorize(AGENT, "iam.listPositions");
    expect(d.allow).toBe(true);
  });

  it("an n8n workflow still suspends exactly as before — no regression to the original path", () => {
    tool("deploy.production", { write: true, impact: "high" });
    const d = authorize(N8N, "deploy.production");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("automation requires human approval");
  });
});

describe("the Cerbos payload (authoritative when configured)", () => {
  const realFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    resetRegistry();
    sent = [];
    config.cerbosUrl = "http://cerbos.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (!String(url).startsWith("http://cerbos.test")) return realFetch(url as never, init as never);
        const body = JSON.parse(init?.body ?? "{}") as { principal?: Record<string, unknown> };
        sent.push(body.principal ?? {});
        // Allow everything, so the ONLY thing under test is what we told Cerbos about the caller.
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ resource: { id: "t" }, actions: { call: "EFFECT_ALLOW" } }] }),
        } as never;
      }) as unknown as typeof fetch,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("🔴 sends isUnattended=true for an agent — the attribute the policy now keys the gate on", async () => {
    // Fixing only the in-code branch would have left the LIVE deployment open, because Cerbos is
    // authoritative whenever CERBOS_URL is set. This asserts the wire payload, not an internal.
    tool("t", { write: true, impact: "high" });
    await authorizeCall(AGENT, "t");
    const attr = (sent[0]?.attr ?? {}) as Record<string, unknown>;
    expect(attr.isUnattended).toBe(true);
    expect(attr.agent).toBe("agent:task-filer");
    // isAutomation stays FALSE: the workflow-scope conjunct must not start applying to agents.
    expect(attr.isAutomation).toBe(false);
  });

  it("sends isUnattended=false for a plain human", async () => {
    tool("t");
    await authorizeCall(HUMAN, "t");
    const attr = (sent[0]?.attr ?? {}) as Record<string, unknown>;
    expect(attr.isUnattended).toBe(false);
    expect(attr.agent).toBe("");
  });

  it("sends isUnattended=true AND isAutomation=true for n8n — both, not either", async () => {
    tool("t");
    await authorizeCall(N8N, "t");
    const attr = (sent[0]?.attr ?? {}) as Record<string, unknown>;
    expect(attr.isAutomation).toBe(true);
    expect(attr.isUnattended).toBe(true);
  });
});
