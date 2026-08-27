// WSK-31 (docs/blueprints/webdesk-design.md §07) — "THE TEST THAT MATTERS": reads are free, MEDIUM
// writes suspend for automation/agent (unattended) principals only, and HIGH webdesk writes suspend
// for EVERY principal class — including an ATTENDED human, which is the estate's normal exemption
// (see `agent-impact-gate.test.ts`'s own "the SAME high-impact write is ALLOWED for the same human
// without an agent" case) and the one this ticket's `ALWAYS_WS4_TOOLS` constant deliberately does
// NOT grant to these seven tool names.
//
// Model: `agent-impact-gate.test.ts` (byte-for-byte the same harness shape — throwaway
// `registerTool()` fixtures, the in-code fallback engine directly, and a mocked Cerbos fetch that
// asserts the WIRE payload rather than an internal). Kept as its own file rather than appended to
// that one: this suite is about a NEW, tool-named override, not the `isUnattended` predicate itself.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { config } from "./config";
import { resetRegistry, registerTool } from "./registry";
import { authorize, authorizeCall, ALWAYS_WS4_TOOLS } from "./policy";
import type { Principal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";

// NOT cross-imported from platform-nest's `WEBDESK_ALWAYS_WS4_TOOLS` — the estate rule is "separate
// projects, no shared package layer" (root CLAUDE.md), so the two lists are independently declared,
// exactly like the D14-13 grant-lift bracket list already is (approval-executables.ts's list and
// resource_mcp_tool.yaml's list are hand-duplicated with a stated "drift fails closed" discipline,
// not cross-checked by an import either). This literal MUST be kept in sync BY HAND with
// `modules/webdev/index.ts`'s `WEBDESK_ALWAYS_WS4_TOOLS` and with
// `resource_mcp_tool.yaml`'s always-WS4 bracket — three places, one list, drift fails closed.
const EXPECTED_ALWAYS_WS4_TOOLS = [
  "webdesk.site.promote", "webdesk.site.rollback", "webdesk.site.setDomain",
  "webdesk.key.mint", "webdesk.key.rotate", "webdesk.key.revoke", "webdesk.site.archive",
];

const HUMAN: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "verified" };
const ADMIN_CONSOLE: Principal = { provider: "platform", externalId: "admin-1", assurance: "verified" };
const AGENT: Principal = { ...HUMAN, agent: "agent:webdesk-ops" };

// The gate's scope conjunct runs BEFORE the impact conjunct (isAutomation must be in-scope for the
// tool at all, `policy.ts`'s own comment order), so a REAL wf: identity that is not scoped for these
// brand-new tool names (none is — WSK-31 deliberately confines `wf:webdesk-zoneb-intake` to
// `record`+`notify` only, and no other wf: identity has ever been scoped for a webdesk.* tool) would
// be denied at the SCOPE check and never reach the impact-suspend branch this suite exists to prove.
// A test-only allow-list entry lets the REAL `isAutomation`/`workflowScope` code paths run exactly
// as production does, rather than mocking them away.
const N8N_TEST_WORKFLOW = "wf:wsk31-test-fixture";
const N8N: Principal = { provider: "n8n", externalId: N8N_TEST_WORKFLOW, assurance: "verified" };

function registerRead(name: string) {
  registerTool({ name, description: "x", minAssurance: "low", inputSchema: { type: "object" }, handler: async () => "" });
}
function registerWrite(name: string, impact: "low" | "medium" | "high") {
  registerTool({ name, description: "x", minAssurance: "low", write: true, impact, inputSchema: { type: "object" }, handler: async () => "" });
}

describe("WSK-31 — the hub's ALWAYS_WS4_TOOLS is exactly the §07 HIGH command set", () => {
  it("has exactly the seven §07 HIGH tool names — a change here is a policy decision, not a typo fix", () => {
    expect(ALWAYS_WS4_TOOLS).toEqual(new Set(EXPECTED_ALWAYS_WS4_TOOLS));
  });
});

describe("WSK-31 — the in-code gate (fail-closed fallback)", () => {
  beforeEach(() => {
    resetRegistry();
    config.cerbosUrl = "";
    // Test-only scope injection — see N8N_TEST_WORKFLOW's own comment above for why this beats a
    // mock: the tool set changes per-test (registerRead/registerWrite re-register a fresh tool each
    // time), so the scope is widened to every §07 tool name this suite exercises, once.
    (AUTOMATION_ALLOWLIST as Record<string, readonly string[]>)[N8N_TEST_WORKFLOW] = [
      "webdesk.listSites", "webdesk.schema.apply", "webdesk.site.provision", "webdesk.deploy.staging",
      ...ALWAYS_WS4_TOOLS, "some.other.highImpactTool",
    ];
  });

  it("reads are free for every principal class — human, admin-console, agent, n8n alike", () => {
    registerRead("webdesk.listSites");
    for (const p of [HUMAN, ADMIN_CONSOLE, AGENT, N8N]) {
      expect(authorize(p, "webdesk.listSites").allow, JSON.stringify(p)).toBe(true);
    }
  });

  describe("MEDIUM webdesk writes (schema.apply / site.provision / deploy.staging)", () => {
    for (const name of ["webdesk.schema.apply", "webdesk.site.provision", "webdesk.deploy.staging"]) {
      it(`${name}: ALLOWED for an attended human — the estate's normal exemption still applies`, () => {
        registerWrite(name, "medium");
        expect(authorize(HUMAN, name).allow).toBe(true);
        expect(authorize(ADMIN_CONSOLE, name).allow).toBe(true);
      });

      it(`${name}: SUSPENDS for an n8n workflow (unattended)`, () => {
        registerWrite(name, "medium");
        const d = authorize(N8N, name);
        expect(d.allow).toBe(false);
        if (!d.allow) expect(d.reason).toContain("only low-impact writes run unattended");
      });

      it(`${name}: SUSPENDS for an agent-driven call (unattended, even though the channel is human)`, () => {
        registerWrite(name, "medium");
        const d = authorize(AGENT, name);
        expect(d.allow).toBe(false);
        if (!d.allow) expect(d.reason).toContain("agent:webdesk-ops");
      });
    }
  });

  describe("🔴 HIGH webdesk writes (promote/rollback/setDomain/key.*/archive) — ALWAYS WS4", () => {
    for (const name of ALWAYS_WS4_TOOLS) {
      it(`${name}: SUSPENDS for an ATTENDED human — the estate's normal exemption does NOT apply here`, () => {
        registerWrite(name, "high");
        const d = authorize(HUMAN, name);
        expect(d.allow, `${name} must suspend for an attended human`).toBe(false);
        if (!d.allow) {
          expect(d.reason).toMatch(/^suspend:/);
          expect(d.reason).toContain("always requires human approval");
          expect(d.reason).not.toContain("automation requires"); // distinct reason from the unattended branch
        }
      });

      it(`${name}: SUSPENDS for a human on the admin console too — no channel is exempt`, () => {
        registerWrite(name, "high");
        expect(authorize(ADMIN_CONSOLE, name).allow).toBe(false);
      });

      it(`${name}: SUSPENDS for an n8n workflow`, () => {
        registerWrite(name, "high");
        expect(authorize(N8N, name).allow).toBe(false);
      });

      it(`${name}: SUSPENDS for an agent-driven call`, () => {
        registerWrite(name, "high");
        expect(authorize(AGENT, name).allow).toBe(false);
      });
    }
  });

  it("a HIGH tool NOT in ALWAYS_WS4_TOOLS keeps the ordinary attended-exemption (control: the override is scoped, not global)", () => {
    registerWrite("some.other.highImpactTool", "high");
    expect(authorize(HUMAN, "some.other.highImpactTool").allow).toBe(true);
    expect(authorize(N8N, "some.other.highImpactTool").allow).toBe(false);
  });
});

describe("WSK-31 — the Cerbos payload (authoritative when configured)", () => {
  const realFetch = globalThis.fetch;
  let lastAllow = true;

  beforeEach(() => {
    resetRegistry();
    config.cerbosUrl = "http://cerbos.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (!String(url).startsWith("http://cerbos.test")) return realFetch(url as never, init as never);
        const body = JSON.parse(init?.body ?? "{}") as {
          resources?: Array<{ resource?: { id?: string } }>;
        };
        // Echo back the REAL requested resource id(s) — `cerbosAllowsTool` matches the decision by
        // `resource.id`, so a mock that hardcodes a mismatched id (an earlier draft of this file did)
        // makes every call look denied regardless of `lastAllow`, for the wrong reason entirely.
        const results = (body.resources ?? []).map((r) => ({
          resource: { id: r.resource?.id },
          actions: { call: lastAllow ? "EFFECT_ALLOW" : "EFFECT_DENY" },
        }));
        return { ok: true, status: 200, json: async () => ({ results }) } as never;
      }) as unknown as typeof fetch,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("Cerbos is authoritative when it DENIES — an attended human still cannot promote", async () => {
    lastAllow = false;
    registerWrite("webdesk.site.promote", "high");
    const d = await authorizeCall(HUMAN, "webdesk.site.promote");
    expect(d.allow).toBe(false);
  });

  it("🔴 IF THE SIDECAR IS NOT RESTARTED to load the always-WS4 conjunct, Cerbos ALLOWS and Cerbos WINS — this is why the restart+probe step is load-bearing, not ceremony", async () => {
    // `authorizeCall()`'s own contract: "Cerbos is authoritative whenever CERBOS_URL is set" — an
    // ALLOW from Cerbos returns allow:true UNCONDITIONALLY, regardless of what the in-code fallback
    // (this ticket's ALWAYS_WS4_TOOLS branch) would have said. The in-code branch is real protection
    // ONLY when Cerbos is unset/unreachable/erroring (the fail-closed-fallback posture the file
    // header describes) — it is NOT a second vote once Cerbos is live. So a stale, unrestarted
    // Cerbos sidecar that has never heard of this ticket's new conjunct would ALLOW an attended
    // human to call `webdesk.site.promote` with no approval at all — the exact "healthy Cerbos
    // serving two-day-stale policy" trap the estate's own CLAUDE.md names. This assertion pins that
    // failure mode on purpose, so it is a known, tested fact rather than a surprise: the restart +
    // a live probe against the running sidecar (this ticket's own verification step) is what
    // actually closes it, not this test file.
    lastAllow = true;
    registerWrite("webdesk.site.promote", "high");
    const d = await authorizeCall(HUMAN, "webdesk.site.promote");
    expect(d.allow).toBe(true); // documents the risk; the LIVE probe is what proves it does not apply
  });
});
