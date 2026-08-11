// ASST-02 — Cerbos policy parity for the owner-private assistant kinds
// (resource_assistant_thread.yaml, resource_assistant_memory.yaml).
//
// Needs a LIVE Cerbos (skips otherwise) — the container the harness actually reaches is
// `gaiada-test-cerbos` (publishes :3592), NOT the app's own dev `gaiada-cerbos-1`. These are
// BRAND-NEW policy files: a new file is not hot-reloaded over the Windows bind mount, so after
// adding/changing either policy you must `docker restart gaiada-test-cerbos` and wait for
// `healthy` before re-running this suite — see the two policy files' headers for the full
// rationale. An unlisted `kind` is a SILENT DENY (every case in the matrix denies, with no
// error), which is indistinguishable from "the owner rule is wrong" unless something proves the
// kind resolves at all — that is exactly what the first `describe` block below does, via a raw
// `includeMeta` check that reads `matchedPolicy` off the live Cerbos response (`check()` in
// `./cerbos.ts` does not surface that field, so this suite talks to the HTTP API directly for it).
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const CERBOS_URL = process.env.CERBOS_URL ?? "";

const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "aaaaaaaa-0000-0000-0000-000000000002";
const OWNER = "u-owner";
const OTHER = "u-other";
const ADMIN = "u-admin";
const EXEC = "u-exec";

function principal(userId: string, roles: RoleGrant[], companies: string[] = [T1], assurance: Principal["assurance"] = "high"): Principal {
  return { userId, assurance, companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// IAM-04c-1 / Finding G2 (2026-08-10): this matrix used to omit `handoff` (ASST-21) and
// `confirm_write` (ASST-23) — both joined resource_assistant_thread.yaml's owner-only rule after
// this suite was first written and never joined the test matrix. Both are now included.
const THREAD_ACTIONS = ["create", "read", "update", "delete", "message", "stream", "stop", "handoff", "confirm_write"];
const MEMORY_ACTIONS = ["list", "propose", "confirm", "delete"];

describe.skipIf(!live)("Cerbos: assistant_thread / assistant_memory (ASST-02, owner-only)", () => {
  // ── THE UNLISTED-KIND SMOKE CHECK — run this FIRST. If this fails or shows every action
  // denied with no matchedPolicy, the policy files are missing / the container wasn't restarted
  // / the wrong container was restarted — do not trust any DENY result below until this passes. ──
  describe("smoke: the kinds resolve at all (guards against the unlisted-kind silent-DENY trap)", () => {
    async function rawCheckWithMeta(kind: string, ownerId: string, tenantId: string, actions: string[], callerId: string) {
      const res = await fetch(`${CERBOS_URL}/api/check/resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "asst-02-smoke",
          includeMeta: true,
          principal: { id: callerId, roles: ["user"], attr: { assurance: "high", companies: [tenantId], grants: [] } },
          resources: [
            {
              actions,
              resource: {
                kind,
                id: "smoke-1",
                attr: { id: "smoke-1", tenantId, ownerId, projectId: "", teamId: "", module: "", subjectUserId: "" },
              },
            },
          ],
        }),
      });
      expect(res.ok).toBe(true);
      return (await res.json()) as {
        results: Array<{ actions: Record<string, string>; meta?: { actions?: Record<string, { matchedPolicy?: string }> } }>;
      };
    }

    it("assistant_thread: owner-ALLOW really returns ALLOW with a matchedPolicy (not a uniform deny)", async () => {
      const data = await rawCheckWithMeta("assistant_thread", OWNER, T1, THREAD_ACTIONS, OWNER);
      for (const action of THREAD_ACTIONS) {
        expect(data.results[0].actions[action]).toBe("EFFECT_ALLOW");
        expect(data.results[0].meta?.actions?.[action]?.matchedPolicy).toBe("resource.assistant_thread.vdefault");
      }
    });

    it("assistant_memory: owner-ALLOW really returns ALLOW with a matchedPolicy (not a uniform deny)", async () => {
      const data = await rawCheckWithMeta("assistant_memory", OWNER, T1, MEMORY_ACTIONS, OWNER);
      for (const action of MEMORY_ACTIONS) {
        expect(data.results[0].actions[action]).toBe("EFFECT_ALLOW");
        expect(data.results[0].meta?.actions?.[action]?.matchedPolicy).toBe("resource.assistant_memory.vdefault");
      }
    });

    it("a DENY still shows a matchedPolicy (proves the kind resolved, deny is a real rule verdict)", async () => {
      const data = await rawCheckWithMeta("assistant_thread", OWNER, T1, ["read"], OTHER);
      expect(data.results[0].actions.read).toBe("EFFECT_DENY");
      expect(data.results[0].meta?.actions?.read?.matchedPolicy).toBe("resource.assistant_thread.vdefault");
    });
  });

  describe("assistant_thread", () => {
    const thread: Resource = { kind: "assistant_thread", id: "th-1", tenantId: T1, ownerId: OWNER };

    it("owner is ALLOWED on every action", async () => {
      const p = principal(OWNER, []);
      for (const action of THREAD_ACTIONS) {
        expect(await allow(p, thread, action)).toBe(true);
      }
    });

    it("a different user in the SAME company is DENIED on every action", async () => {
      const p = principal(OTHER, []);
      for (const action of THREAD_ACTIONS) {
        expect(await allow(p, thread, action)).toBe(false);
      }
    });

    it("company_admin is DENIED (no admin backdoor)", async () => {
      const p = principal(ADMIN, [{ role: "company_admin", scopeType: "company", scopeId: T1 }]);
      for (const action of THREAD_ACTIONS) {
        expect(await allow(p, thread, action)).toBe(false);
      }
    });

    it("group_executive is DENIED (no admin backdoor) — granted at GLOBAL scope so the derived role actually activates", async () => {
      const p = principal(EXEC, [{ role: "group_executive", scopeType: "global", scopeId: null }], []);
      for (const action of THREAD_ACTIONS) {
        expect(await allow(p, thread, action)).toBe(false);
      }
    });

    // IAM-04c-1 / Finding G2 (2026-08-10): this is the exact case Finding G2 flagged as MISSING —
    // platform_admin is the role the ruling's exempted-by-absence design is FOR. Granted at GLOBAL
    // scope (matching the group_executive case above) so the derived role actually activates.
    it("platform_admin is DENIED (no admin backdoor — this is the case the 215-boundary exemption exists to prove) — granted at GLOBAL scope so the derived role actually activates", async () => {
      const p = principal(ADMIN, [{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
      for (const action of THREAD_ACTIONS) {
        expect(await allow(p, thread, action)).toBe(false);
      }
    });

    it("cross-tenant is DENIED even for the owner (tenant not in the authorized set)", async () => {
      const p = principal(OWNER, [], [T2]); // owner, but only authorized for T2
      for (const action of THREAD_ACTIONS) {
        expect(await allow(p, thread, action)).toBe(false); // thread is in T1
      }
    });

    it("low assurance is DENIED even for the owner (D4 ceiling applies to chat too)", async () => {
      const p = principal(OWNER, [], [T1], "low");
      expect(await allow(p, thread, "read")).toBe(false);
    });
  });

  describe("assistant_memory", () => {
    const memory: Resource = { kind: "assistant_memory", id: "m-1", tenantId: T1, ownerId: OWNER };

    it("owner is ALLOWED on every action", async () => {
      const p = principal(OWNER, []);
      for (const action of MEMORY_ACTIONS) {
        expect(await allow(p, memory, action)).toBe(true);
      }
    });

    it("a different user in the SAME company is DENIED on every action", async () => {
      const p = principal(OTHER, []);
      for (const action of MEMORY_ACTIONS) {
        expect(await allow(p, memory, action)).toBe(false);
      }
    });

    it("company_admin is DENIED (no admin backdoor)", async () => {
      const p = principal(ADMIN, [{ role: "company_admin", scopeType: "company", scopeId: T1 }]);
      for (const action of MEMORY_ACTIONS) {
        expect(await allow(p, memory, action)).toBe(false);
      }
    });

    it("group_executive is DENIED (no admin backdoor) — granted at GLOBAL scope so the derived role actually activates", async () => {
      const p = principal(EXEC, [{ role: "group_executive", scopeType: "global", scopeId: null }], []);
      for (const action of MEMORY_ACTIONS) {
        expect(await allow(p, memory, action)).toBe(false);
      }
    });

    // IAM-04c-1 / Finding G2 (2026-08-10): missing platform_admin case, same rationale as the
    // assistant_thread block above.
    it("platform_admin is DENIED (no admin backdoor) — granted at GLOBAL scope so the derived role actually activates", async () => {
      const p = principal(ADMIN, [{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
      for (const action of MEMORY_ACTIONS) {
        expect(await allow(p, memory, action)).toBe(false);
      }
    });

    it("cross-tenant is DENIED even for the owner (tenant not in the authorized set)", async () => {
      const p = principal(OWNER, [], [T2]);
      for (const action of MEMORY_ACTIONS) {
        expect(await allow(p, memory, action)).toBe(false); // memory row is in T1
      }
    });
  });
});
