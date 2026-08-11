// ASST-21 — Cerbos policy parity for the additive `agent_run` rule (resource_agent_run.yaml).
// IAM-SEC-01 (2026-08-10) extends this file: the `read` rule now also requires
// `variables.notLow`, an OWNER-SIGHTED NARROWING (a low-assurance owner who could read their own
// handoff run before this change is now DENIED). See the policy file's own header for the full
// rationale and the independent-verdict writeup in
// docs/superpowers/plans/2026-08-10-iam-sec-01-report.md.
//
// Needs a LIVE Cerbos (skips otherwise) — the container the harness actually reaches is
// `gaiada-test-cerbos` (publishes :3592), NOT the app's own dev `gaiada-cerbos-1`. This is a
// BRAND-NEW policy file (no `agent_run` kind existed before ASST-21): a new file is not
// hot-reloaded over the Windows bind mount, so after adding it you must `docker restart
// gaiada-test-cerbos` and wait for `healthy` before running this suite — see the policy file's own
// header. An unlisted `kind` is a SILENT DENY (every case denies with no error), indistinguishable
// from "the owner rule is wrong" unless something proves the kind resolves at all — that is exactly
// what the smoke check below does, via a raw `includeMeta` request that reads `matchedPolicy` off
// the live Cerbos response (`check()` in `./cerbos.ts` does not surface that field).
// IAM-SEC-01 note: this is an EDIT to an existing file (item 4 in the policy's own trap writeup) —
// same-file edits have been observed to hot-reload live in this program, but restart anyway before
// trusting the low-assurance-DENY case below: a stale in-memory policy would silently keep ALLOWING
// the old, wider rule, which is the one failure mode a narrowing change must not miss.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const CERBOS_URL = process.env.CERBOS_URL ?? "";

const T1 = "aaaaaaaa-0000-0000-0000-000000000011";
const T2 = "aaaaaaaa-0000-0000-0000-000000000012";
const OWNER = "u-run-owner";
const OTHER = "u-run-other";
const ADMIN = "u-run-admin";

function principal(
  userId: string,
  roles: RoleGrant[],
  companies: string[] = [T1],
  assurance: Principal["assurance"] = "high",
): Principal {
  return { userId, assurance, companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("Cerbos: agent_run (ASST-21, additive)", () => {
  describe("smoke: the kind resolves at all (guards against the unlisted-kind silent-DENY trap)", () => {
    async function rawCheckWithMeta(ownerId: string, tenantId: string, origin: string, callerId: string) {
      const res = await fetch(`${CERBOS_URL}/api/check/resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "asst-21-smoke",
          includeMeta: true,
          principal: { id: callerId, roles: ["user"], attr: { assurance: "high", companies: [tenantId], grants: [] } },
          resources: [
            {
              actions: ["read"],
              resource: {
                kind: "agent_run",
                id: "smoke-run-1",
                attr: { id: "smoke-run-1", tenantId, ownerId, projectId: "", teamId: "", module: "", subjectUserId: "", origin },
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

    it("owner + origin=assistant_handoff -> real ALLOW, with a matchedPolicy (not a uniform deny)", async () => {
      const data = await rawCheckWithMeta(OWNER, T1, "assistant_handoff", OWNER);
      expect(data.results[0].actions.read).toBe("EFFECT_ALLOW");
      expect(data.results[0].meta?.actions?.read?.matchedPolicy).toBe("resource.agent_run.vdefault");
    });

    it("a DENY still shows a matchedPolicy (proves the kind resolved, deny is a real rule verdict)", async () => {
      const data = await rawCheckWithMeta(OWNER, T1, "assistant_handoff", OTHER);
      expect(data.results[0].actions.read).toBe("EFFECT_DENY");
      expect(data.results[0].meta?.actions?.read?.matchedPolicy).toBe("resource.agent_run.vdefault");
    });
  });

  const handoffRun: Resource = { kind: "agent_run", id: "run-1", tenantId: T1, ownerId: OWNER, origin: "assistant_handoff" };

  it("the triggering owner is ALLOWED to read their own handoff run", async () => {
    expect(await allow(principal(OWNER, []), handoffRun, "read")).toBe(true);
  });

  it("a different user in the SAME company is DENIED", async () => {
    expect(await allow(principal(OTHER, []), handoffRun, "read")).toBe(false);
  });

  it("company_admin is DENIED (owner-only, not elevated-scoped — this is the additive rule, not a widened one)", async () => {
    const p = principal(ADMIN, [{ role: "company_admin", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, handoffRun, "read")).toBe(false);
  });

  it("group_executive is DENIED at the Cerbos layer too (the code-level isElevated check happens BEFORE this policy is ever consulted — see intelligence.controller.ts)", async () => {
    const p = principal("u-run-exec", [{ role: "group_executive", scopeType: "global", scopeId: null }], []);
    expect(await allow(p, handoffRun, "read")).toBe(false);
  });

  it("cross-tenant is DENIED even for the owner (tenant not in the authorized set)", async () => {
    expect(await allow(principal(OWNER, [], [T2]), handoffRun, "read")).toBe(false);
  });

  it("REGRESSION GUARD: the SAME owner is DENIED when origin is anything other than 'assistant_handoff' — this rule must never cover a non-handoff run", async () => {
    const notAHandoff: Resource = { kind: "agent_run", id: "run-2", tenantId: T1, ownerId: OWNER, origin: "" };
    expect(await allow(principal(OWNER, []), notAHandoff, "read")).toBe(false);
    const wrongOrigin: Resource = { kind: "agent_run", id: "run-3", tenantId: T1, ownerId: OWNER, origin: "something_else" };
    expect(await allow(principal(OWNER, []), wrongOrigin, "read")).toBe(false);
  });

  // IAM-SEC-01 (2026-08-10) — the `notLow` floor. OWNER-SIGHTED NARROWING: before this change a
  // low-assurance owner could read their own handoff run; this proves that path is now closed,
  // and that it was closed WITHOUT disturbing the assurance tiers this rule already allowed.
  describe("IAM-SEC-01: notLow assurance floor (owner-sighted narrowing, matches resource_assistant_thread.yaml)", () => {
    it("a low-assurance owner is DENIED, even though they own the run and the origin matches", async () => {
      const p = principal(OWNER, [], [T1], "low");
      expect(await allow(p, handoffRun, "read")).toBe(false);
    });

    it("a linked-assurance owner is still ALLOWED (the floor only excludes 'low', it does not raise the bar to 'high')", async () => {
      const p = principal(OWNER, [], [T1], "linked");
      expect(await allow(p, handoffRun, "read")).toBe(true);
    });

    it("a high-assurance owner is still ALLOWED (unchanged from before this ticket)", async () => {
      const p = principal(OWNER, [], [T1], "high");
      expect(await allow(p, handoffRun, "read")).toBe(true);
    });

    it("low assurance does not accidentally OPEN a path for a non-owner or wrong-origin run (the new conjunct is additive-restrictive, not a replacement of the existing conditions)", async () => {
      const p = principal(OTHER, [], [T1], "low");
      expect(await allow(p, handoffRun, "read")).toBe(false);
      const wrongOrigin: Resource = { kind: "agent_run", id: "run-4", tenantId: T1, ownerId: OWNER, origin: "something_else" };
      expect(await allow(principal(OWNER, [], [T1], "low"), wrongOrigin, "read")).toBe(false);
    });
  });
});
