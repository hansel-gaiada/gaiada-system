// SCP-1r (plan decision SCP-D7, applying owner ruling SCP-Q23; docs/PERMISSION-CONTRACT.md §53.4) -- nobody renames, re-types,
// moves or deletes an org unit they hold a live lead seat on.
//
// THE CLAIMS UNDER TEST
//   1. `resource_org_structure.yaml` carries an EFFECT_DENY on `update`, on roles [user] (deny-overrides beats every ALLOW, the
//      platform_admin wildcard included), reading `touchedLeadHolderIds` in the fail-safe `has() && list.exists(...)` form. It
//      names `update` ONLY: `read` and `read_calendar` are not narrowed.
//   2. `touchedLeadHolderIds` is a real attribute: in the Resource type AND the resourcePayload() allow-list. A Resource field
//      missing from that allow-list is silently dropped and the DENY never fires, so the carriage is proved on the WIRE below, not
//      only by reading the source.
//   3. The decision, against the real engine: a lead of a touched unit is refused `update` as company_admin and as platform_admin;
//      a company_admin who does not lead any touched unit is allowed; an unfed or empty list denies nobody new; the holder's
//      other actions are not narrowed.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/resource_org_structure.yaml and pins the structure; reads cerbos.ts.
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
function parseOrgStructureRules(): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, "resource_org_structure.yaml"), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length, "resource_org_structure.yaml must hold exactly one resourcePolicy").toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe("org_structure");
  return (docs[0].resourcePolicy.rules ?? []).map((r: any) => ({
    actions: r.actions ?? [],
    effect: r.effect ?? "EFFECT_ALLOW",
    derivedRoles: r.derivedRoles ?? [],
    roles: r.roles ?? [],
    condition: (r.condition?.match?.expr ?? "").replace(/\s+/g, " ").trim(),
  }));
}

// ─── A. STATIC ────────────────────────────────────────────────────────────────────────────────────────────────
describe("SCP-1r static pin -- resource_org_structure.yaml unit self-edit DENY", () => {
  const rules = parseOrgStructureRules();
  const denies = rules.filter((r) => r.effect === "EFFECT_DENY");

  it("exactly one EFFECT_DENY, on roles [user] (every principal), with no derived role", () => {
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect(denies[0].derivedRoles).toEqual([]);
  });

  it("the DENY is on `update` ONLY, and reads touchedLeadHolderIds in the fail-safe has() && exists() form", () => {
    const d = denies[0];
    expect(d.actions).toEqual(["update"]);
    expect(d.condition).toBe(
      "has(request.resource.attr.touchedLeadHolderIds) && request.resource.attr.touchedLeadHolderIds.exists(id, id == request.principal.id)",
    );
  });

  it("no DENY names `read` or `read_calendar`, or the wildcard", () => {
    for (const a of ["read", "read_calendar", "*"]) {
      expect(denies.filter((r) => r.actions.includes(a)), a).toEqual([]);
    }
  });

  it("the ALLOW rules the DENY overrides are still there (company_admin and the platform_admin wildcard on update)", () => {
    const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
    expect(allows.some((r) => r.actions.includes("*") && r.derivedRoles.includes("platform_admin"))).toBe(true);
    expect(allows.some((r) => r.actions.includes("update") && r.derivedRoles.includes("company_admin"))).toBe(true);
  });

  it("touchedLeadHolderIds reaches the policy: the Resource type AND the resourcePayload() allow-list carry it, failing closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("touchedLeadHolderIds?: string[];");
    expect(src).toContain("touchedLeadHolderIds: r.touchedLeadHolderIds ?? []");
  });
});

// ─── The allow-list carries touchedLeadHolderIds ON THE WIRE (the request body Cerbos receives) ───────────────────
describe("SCP-1r -- touchedLeadHolderIds is carried in the request body check() sends (never silently dropped)", () => {
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

  it("a fed touchedLeadHolderIds list is sent as attr.touchedLeadHolderIds", async () => {
    const attr = await sentResource({ kind: "org_structure", tenantId: "t", touchedLeadHolderIds: ["a", "b"] });
    expect(attr.touchedLeadHolderIds).toEqual(["a", "b"]);
  });

  it("an unfed touchedLeadHolderIds is sent as [] (contains nobody)", async () => {
    const attr = await sentResource({ kind: "org_structure", tenantId: "t" });
    expect(attr.touchedLeadHolderIds).toEqual([]);
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
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

const orgStructure = (touchedLeadHolderIds?: string[]): Resource => ({
  kind: "org_structure",
  tenantId: TENANT,
  ...(touchedLeadHolderIds === undefined ? {} : { touchedLeadHolderIds }),
});

const TIERS = ["company_admin", "platform_admin"] as const;

describe.skipIf(!live)("SCP-1r live -- org_structure · update unit self-edit DENY", () => {
  for (const role of TIERS) {
    it(`${role}: allowed to update when they lead none of the touched units (the control: the DENY is not a blanket refusal)`, async () => {
      expect((await check(principalWith(role), orgStructure([SOMEONE]), "update")).allow).toBe(true);
    });

    it(`${role}: REFUSED update when they lead a touched unit (the DENY beats the ALLOW, platform_admin's wildcard included)`, async () => {
      expect((await check(principalWith(role), orgStructure([SOMEONE, ME]), "update")).allow).toBe(false);
      expect((await check(principalWith(role), orgStructure([ME]), "update")).allow).toBe(false);
    });

    it(`${role}: an unfed or empty touchedLeadHolderIds denies nobody new (fails open for a DENY: it loses nothing it had)`, async () => {
      expect((await check(principalWith(role), orgStructure(), "update")).allow).toBe(true);
      expect((await check(principalWith(role), orgStructure([]), "update")).allow).toBe(true);
    });

    it(`${role}: the leader's OTHER actions on the structure are not narrowed (read, read_calendar)`, async () => {
      const p = principalWith(role);
      for (const action of ["read", "read_calendar"]) {
        expect((await check(p, orgStructure([ME]), action)).allow, action).toBe(true);
      }
    });
  }

  it("the DENY matches the CALLER, not anyone: other people's seats in the list do not refuse an administrator who is not on it", async () => {
    expect(
      (await check(principalWith("company_admin"), orgStructure([SOMEONE, "66666666-6666-4666-8666-666666666666"]), "update")).allow,
    ).toBe(true);
  });

  it("a person who is NOT an administrator is refused update whatever the list says (the new rule only ever narrows)", async () => {
    expect((await check(principalWith("member"), orgStructure([]), "update")).allow).toBe(false);
    expect((await check(principalWith("manager"), orgStructure([SOMEONE]), "update")).allow).toBe(false);
  });

  it("the tenant gate is unchanged: an administrator of another company is still refused (not by the new DENY)", async () => {
    const other: Resource = { ...orgStructure([SOMEONE]), tenantId: OTHER_TENANT };
    expect((await check(principalWith("company_admin"), other, "update")).allow).toBe(false);
  });
});
