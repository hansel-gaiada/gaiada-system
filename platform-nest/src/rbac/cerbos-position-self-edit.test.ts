// SCP-1q (SCP-Q23, docs/PERMISSION-CONTRACT.md §53.4 "A gap outside SCP") — nobody edits a position they hold.
//
// THE CLAIMS UNDER TEST
//   1. `resource_position.yaml` carries an EFFECT_DENY on `update`, on roles [user] (every principal, deny-overrides beats every
//      ALLOW including platform_admin's wildcard), reading the position's open holders as `holderIds`, written in the fail-safe
//      `has() && list.exists(...)` form. `assign`'s own self-DENY is untouched, and `retire` / `create` are NOT covered.
//   2. `holderIds` is a real attribute: in the Resource type AND the resourcePayload() allow-list. A Resource field missing from
//      that allow-list is silently dropped and the DENY never fires, so the carriage is proved on the WIRE below, not only by
//      reading the source.
//   3. The decision, against the real engine: a holder is refused `update` as company_admin, hr_manager (hr_people_ops) and
//      platform_admin; a non-holder of the same roles is still allowed; an unfed or empty `holderIds` denies nobody new; the
//      holder's other actions on the position are not narrowed.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/resource_position.yaml and pins the structure; reads cerbos.ts.
//   B. LIVE (needs CERBOS_URL): the decision matrix against the real engine loaded with the CURRENT policy files (restart
//      `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parsePositionRules(): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, "resource_position.yaml"), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length, "resource_position.yaml must hold exactly one resourcePolicy").toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe("position");
  return (docs[0].resourcePolicy.rules ?? []).map((r: any) => ({
    actions: r.actions ?? [],
    effect: r.effect ?? "EFFECT_ALLOW",
    derivedRoles: r.derivedRoles ?? [],
    roles: r.roles ?? [],
    condition: (r.condition?.match?.expr ?? "").replace(/\s+/g, " ").trim(),
  }));
}

// ─── A. STATIC ────────────────────────────────────────────────────────────────────────────────────────────────
describe("SCP-1q static pin — resource_position.yaml self-EDIT DENY", () => {
  const rules = parsePositionRules();
  const denies = rules.filter((r) => r.effect === "EFFECT_DENY");

  it("two EFFECT_DENY rules, both on roles [user]: the existing self-assign DENY and the new self-edit DENY", () => {
    expect(denies.length).toBe(2);
    for (const d of denies) expect(d.roles).toEqual(["user"]);
    for (const d of denies) expect(d.derivedRoles).toEqual([]);
  });

  it("the self-edit DENY is on `update` ONLY, and reads holderIds in the fail-safe has() && exists() form", () => {
    const d = denies.find((r) => r.actions.includes("update"))!;
    expect(d, "a DENY on update").toBeTruthy();
    expect(d.actions).toEqual(["update"]);
    expect(d.condition).toBe(
      "has(request.resource.attr.holderIds) && request.resource.attr.holderIds.exists(id, id == request.principal.id)",
    );
  });

  it("the self-assign DENY is untouched: `assign` only, on targetUserId", () => {
    const d = denies.find((r) => r.actions.includes("assign"))!;
    expect(d.actions).toEqual(["assign"]);
    expect(d.condition).toContain("request.resource.attr.targetUserId == request.principal.id");
  });

  it("`retire` and `create` carry no DENY (neither can promote a holder), and no DENY names `read`, `assign`-adjacent actions beyond its own", () => {
    for (const a of ["retire", "create", "read", "unassign"]) {
      expect(denies.filter((r) => r.actions.includes(a)), a).toEqual([]);
    }
  });

  it("holderIds reaches the policy: the Resource type AND the resourcePayload() allow-list carry it, failing closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("holderIds?: string[];");
    expect(src).toContain("holderIds: r.holderIds ?? []");
  });
});

// ─── The allow-list carries holderIds ON THE WIRE (the request body Cerbos receives) ─────────────────────────────
describe("SCP-1q — holderIds is carried in the request body check() sends (never silently dropped)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const sentResource = async (r: Resource) => {
    let body: any = null;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}");
      return { ok: true, json: async () => ({ results: [{ actions: { update: "EFFECT_ALLOW" } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await check(
      { userId: "22222222-2222-4222-8222-222222222222", assurance: "high", companies: [], roles: [], perms: [], sessionVersion: 1 } as unknown as Principal,
      r,
      "update",
    );
    return body.resources[0].resource.attr;
  };

  it("a fed holderIds list is sent as attr.holderIds", async () => {
    const attr = await sentResource({ kind: "position", id: "p", tenantId: "t", holderIds: ["a", "b"] });
    expect(attr.holderIds).toEqual(["a", "b"]);
  });

  it("an unfed holderIds is sent as [] (contains nobody)", async () => {
    const attr = await sentResource({ kind: "position", id: "p", tenantId: "t" });
    expect(attr.holderIds).toEqual([]);
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const POSITION = "44444444-4444-4444-8444-444444444444";
const ME = "22222222-2222-4222-8222-222222222222";
const SOMEONE = "55555555-5555-4555-8555-555555555555";

/** A synthetic principal carrying exactly ONE role grant, so nothing else can be what answers. */
function principalWith(role: string, userId = ME): Principal {
  const global = role === "platform_admin";
  return {
    userId,
    assurance: "high",
    companies: [TENANT],
    roles: [{ role, scopeType: global ? "global" : "company", scopeId: global ? null : TENANT }],
    perms: [],
    sessionVersion: 1,
  } as unknown as Principal;
}

const position = (holderIds?: string[]): Resource => ({
  kind: "position",
  id: POSITION,
  tenantId: TENANT,
  ...(holderIds === undefined ? {} : { holderIds }),
});

const TIERS = ["company_admin", "hr_manager", "platform_admin"] as const;

describe.skipIf(!live)("SCP-1q live — position · update self-EDIT DENY", () => {
  for (const role of TIERS) {
    it(`${role}: allowed to update a position they do NOT hold (the control: the DENY is not a blanket refusal)`, async () => {
      expect((await check(principalWith(role), position([SOMEONE]), "update")).allow).toBe(true);
    });

    it(`${role}: REFUSED update on a position they hold (the DENY beats the ALLOW, platform_admin's wildcard included)`, async () => {
      expect((await check(principalWith(role), position([SOMEONE, ME]), "update")).allow).toBe(false);
      expect((await check(principalWith(role), position([ME]), "update")).allow).toBe(false);
    });

    it(`${role}: an unfed or empty holderIds denies nobody new (fails open for a DENY: it loses nothing it had)`, async () => {
      expect((await check(principalWith(role), position(), "update")).allow).toBe(true);
      expect((await check(principalWith(role), position([]), "update")).allow).toBe(true);
    });

    it(`${role}: the holder's OTHER actions on the position are not narrowed (read, retire, create, unassign)`, async () => {
      const p = principalWith(role);
      for (const action of ["read", "retire", "create", "unassign"]) {
        expect((await check(p, position([ME]), action)).allow, action).toBe(true);
      }
    });
  }

  it("the DENY matches the CALLER, not anyone: another person's seat in the list does not refuse an administrator who is not on it", async () => {
    expect((await check(principalWith("company_admin"), position([SOMEONE, "66666666-6666-4666-8666-666666666666"]), "update")).allow).toBe(true);
  });

  it("the tenant gate is unchanged: an administrator of another company is still refused (not by the new DENY)", async () => {
    const other: Resource = { ...position([SOMEONE]), tenantId: OTHER_TENANT };
    expect((await check(principalWith("company_admin"), other, "update")).allow).toBe(false);
  });

  it("the self-assign DENY still fires beside it", async () => {
    const selfTarget: Resource = { ...position([SOMEONE]), targetUserId: ME, unitAncestors: [] };
    expect((await check(principalWith("company_admin"), selfTarget, "assign")).allow).toBe(false);
  });
});
