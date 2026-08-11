// IAM-05a — tests for the published `can()` entry point (can.ts).
//
// Two tiers, deliberately split:
//   1. `can.scopeOnly()` and the catalog-lookup guard rails are PURE — no Cerbos, no DB. They
//      run always.
//   2. `can()` itself talks to Cerbos (it wraps `check()`), so its tests need a LIVE Cerbos —
//      set CERBOS_URL, skips otherwise. STALENESS TRAP (memory `cerbos-new-policy-needs-
//      restart`): this suite proves nothing if the container serving CERBOS_URL predates the
//      IAM-04b pilot's policy edits. `docker inspect gaiada-test-cerbos --format
//      '{{.State.StartedAt}}'` must postdate those edits; this session probed
//      `POST /api/check/resources` directly before trusting any result here.
//
// The core acceptance bar (per the ticket): both arms, both directions (allow AND deny), and
// — the part that actually proves the ruling — cases where `can()` and `can.scopeOnly()`
// LEGITIMATELY DISAGREE, reproducing the exact shape of hazard IAM-04b's pilot caught (a flat
// `perms` bundle entry that looks like reach but Cerbos's real condition denies).
import { describe, it, expect } from "vitest";
import { can } from "./can";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "aaaaaaaa-0000-0000-0000-000000000002";

function principal(
  roles: RoleGrant[],
  perms: PermissionGrant[] = [],
  companies: string[] = [T1],
  assurance: Principal["assurance"] = "high",
  userId = "u1",
): Principal {
  return { userId, assurance, companies, roles, perms, sessionVersion: 1 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Tier 1 — pure, no Cerbos: catalog guard rails + can.scopeOnly()'s own scope semantics.
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("can() and can.scopeOnly() — catalog guard rails (no Cerbos needed)", () => {
  it("can() throws on an uncatalogued permission key (typo protection, not a silent false)", async () => {
    await expect(can(principal([]), "not.a.real.key", { tenantId: T1 })).rejects.toThrow(/not in the permission catalog/);
  });

  it("can.scopeOnly() throws on an uncatalogued permission key", () => {
    expect(() => can.scopeOnly(principal([]), "not.a.real.key", { scopeType: "company", scopeId: T1 })).toThrow(
      /not in the permission catalog/,
    );
  });

  it("can.scopeOnly() THROWS for every relationship-class key — never silently false, always points at can()", () => {
    const relationshipKeys = [
      "assistant.agent_run.read",
      "assistant.thread.read",
      "assistant.memory.list",
      "core.mcp_tool.call",
    ];
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    for (const key of relationshipKeys) {
      expect(() => can.scopeOnly(p, key, { scopeType: "global", scopeId: null }), key).toThrow(/relationship-class/);
      expect(() => can.scopeOnly(p, key, { scopeType: "global", scopeId: null }), key).toThrow(/Use can\(/);
    }
  });

  it("can.scopeOnly() ALLOWS: holding the key at the exact scope answers true", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(can.scopeOnly(p, "pm.task.read", { scopeType: "company", scopeId: T1 })).toBe(true);
  });

  it("can.scopeOnly() DENIES: not holding the key answers false", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(can.scopeOnly(p, "pm.task.update", { scopeType: "company", scopeId: T1 })).toBe(false);
  });

  it("can.scopeOnly() DENIES a company-scope grant asked about a DIFFERENT company", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(can.scopeOnly(p, "pm.task.read", { scopeType: "company", scopeId: T2 })).toBe(false);
  });

  it("can.scopeOnly() ALLOWS: a global-scope grant covers every company scope asked about", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "global", scopeId: null }]);
    expect(can.scopeOnly(p, "pm.task.read", { scopeType: "company", scopeId: T1 })).toBe(true);
    expect(can.scopeOnly(p, "pm.task.read", { scopeType: "company", scopeId: T2 })).toBe(true);
  });

  it("can.scopeOnly() has no Cerbos/network dependency (synchronous, no CERBOS_URL needed) — runs identically whether or not Cerbos is up", () => {
    const p = principal([], [{ key: "hr.case.update", scopeType: "company", scopeId: T1 }]);
    const result = can.scopeOnly(p, "hr.case.update", { scopeType: "company", scopeId: T1 });
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Tier 2 — live Cerbos: can() itself, both arms, both directions, and the disagreements.
// ─────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!live)("can() — wraps check(), both arms, both directions (live Cerbos)", () => {
  it("ALLOW via the permission arm alone (no role held) — can() derives kind/action from the catalog key", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(await can(p, "pm.task.read", { id: "task-1", tenantId: T1 })).toBe(true);
  });

  it("DENY via the permission arm — a key not held denies, no bleed into a sibling action", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    expect(await can(p, "pm.task.update", { id: "task-1", tenantId: T1 })).toBe(false);
  });

  it("ALLOW via the role arm alone (empty perms) — can() is a drop-in for the pre-existing role-name path too", async () => {
    const p = principal([{ role: "manager", scopeType: "company", scopeId: T1 }]);
    expect(await can(p, "pm.task.update", { id: "task-1", tenantId: T1 })).toBe(true);
  });

  it("DENY via the role arm — viewer cannot create", async () => {
    const p = principal([{ role: "viewer", scopeType: "company", scopeId: T1 }]);
    expect(await can(p, "pm.task.create", { id: "task-1", tenantId: T1 })).toBe(false);
  });

  it("DENY: no role, no perms at all", async () => {
    expect(await can(principal([]), "pm.task.read", { id: "task-1", tenantId: T1 })).toBe(false);
  });

  it("cross-tenant is DENIED even with a matching company-scope permission grant (no leak across tenants)", async () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1, T2]);
    expect(await can(p, "pm.task.read", { id: "task-1", tenantId: T2 })).toBe(false);
  });

  it("the wildcard bypass resolves correctly through can() with ZERO perms — platform_admin's role-arm wildcard, not a `*` permission, is what answers (IAM-04c)", async () => {
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], [], []);
    expect(await can(p, "pm.task.delete", { id: "task-1", tenantId: T2 })).toBe(true);
    expect(await can(p, "hr.case.export", { id: "case-1", tenantId: T2, module: "hr" })).toBe(true);
  });

  it("hr_case self-scoped tier: ALLOW on the caller's own case via the permission arm", async () => {
    const p = principal([], [{ key: "hr.case.read", scopeType: "company", scopeId: T1 }]);
    expect(await can(p, "hr.case.read", { id: "case-1", tenantId: T1, module: "hr", subjectUserId: "u1" })).toBe(true);
  });

  it("relationship-class permission: can() answers it directly via Cerbos's ownership/provenance rule (agent_run) — owner+origin ALLOWS, mismatched owner DENIES", async () => {
    const attrs = { id: "run-1", tenantId: T1, ownerId: "u1", origin: "assistant_handoff" };
    expect(await can(principal([], [], [T1], "high", "u1"), "assistant.agent_run.read", attrs)).toBe(true);
    expect(await can(principal([], [], [T1], "high", "someone-else"), "assistant.agent_run.read", attrs)).toBe(false);
  });

  it("relationship-class permission stays bypass-exempt even through can(): platform_admin does NOT reach it (no wildcard rule on this kind — IAM-04c/catalog Ruling 3)", async () => {
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], [], []);
    expect(await can(p, "assistant.agent_run.read", { id: "run-1", tenantId: T1, ownerId: "someone-else", origin: "assistant_handoff" })).toBe(
      false,
    );
  });
});

describe.skipIf(!live)("can() vs can.scopeOnly() — where they LEGITIMATELY DISAGREE (the ruling's whole point)", () => {
  // HIER-3 (2026-08-11): the "DISAGREEMENT: team_lead's dead pm.task bundle entry" case that used
  // to sit here is REMOVED, not replaced — `team_lead` (role, derived role, and bundle) is retired
  // entirely (docs/superpowers/plans/2026-08-11-hier-3-report.md), so there is no longer a
  // role_permissions bundle entry to disagree about. The hr.case example below stands alone as
  // this suite's live proof of the can()-vs-scopeOnly() disagreement class.

  // Finding 1 (IAM-04 report §4): a member's hr.case.read bundle entry is a SELF-ONLY grant
  // once resolved through role_permissions — indistinguishable, once flattened into `perms`,
  // from an unconditional hold of the same key. can.scopeOnly() cannot see the condition;
  // can() evaluates the real subjectUserId check.
  it("DISAGREEMENT: member's self-scoped hr.case.read bundle entry, asked about SOMEONE ELSE's case — scopeOnly says yes, can() says no", async () => {
    const p = principal(
      [{ role: "member", scopeType: "company", scopeId: T1 }],
      [{ key: "hr.case.read", scopeType: "company", scopeId: T1 }],
      [T1],
      "high",
      "u1",
    );
    expect(can.scopeOnly(p, "hr.case.read", { scopeType: "company", scopeId: T1 })).toBe(true); // fast path over-grants
    expect(await can(p, "hr.case.read", { id: "case-1", tenantId: T1, module: "hr", subjectUserId: "someone-else" })).toBe(false); // authoritative: denies
    // Agreement case, for contrast: on the caller's OWN case, both arms end up correct —
    // scopeOnly because it never claimed to know about "someone else," can() because the
    // self-scoped Cerbos rule matches.
    expect(await can(p, "hr.case.read", { id: "case-1", tenantId: T1, module: "hr", subjectUserId: "u1" })).toBe(true);
  });

  // The relationship class: scopeOnly refuses to answer at all (throws), can() answers via
  // Cerbos directly. Not a "disagreement" in the allow/deny sense — a disagreement in whether
  // the question is even answerable by the fast path.
  it("relationship-class key: scopeOnly refuses the question outright; can() answers it (agreement on the RIGHT tool, not a fast-path shortcut)", async () => {
    const p = principal([], [], [T1], "high", "u1");
    expect(() => can.scopeOnly(p, "assistant.agent_run.read", { scopeType: "company", scopeId: T1 })).toThrow();
    expect(await can(p, "assistant.agent_run.read", { id: "run-1", tenantId: T1, ownerId: "u1", origin: "assistant_handoff" })).toBe(true);
  });
});
