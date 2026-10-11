// M6-P3c — Cerbos matrix for the `webdev_site` kind (the `webdev_sites` portfolio registry's own kind).
//
// THE CLAIM UNDER TEST: BEHAVIOUR-PRESERVING. Until M6-P3c the registry's routes borrowed
// `webdev_provisioned_site`'s actions. The new kind must allow exactly the principals the old action
// allowed, per route, and no others:
//
//   route                                   old (kind · action)                    new (kind · action)
//   POST  sites                             webdev_provisioned_site · provision    webdev_site · create
//   GET   sites/:id, GET console/portfolio  webdev_provisioned_site · read         webdev_site · read
//   PATCH sites/:id (vault_ref)             webdev_provisioned_site · operate      webdev_site · update
//   POST  console/probe-consent-requests    webdev_provisioned_site · read         webdev_site · request_probe_consent
//
// Two layers, both below:
//   1. an EXPLICIT table (role x action -> allowed), so the intent is readable and a policy edit that
//      changes reach fails with a named cell;
//   2. an EQUIVALENCE sweep that asks Cerbos BOTH kinds the same question for every principal and
//      asserts identical answers — so if `webdev_provisioned_site` ever changes, this fails and the
//      divergence has to be decided on purpose.
//
// Talks to Cerbos directly (same `check()` the controllers use) — needs a live CERBOS_URL loaded with
// the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit), skips otherwise (same
// convention as cerbos-webdev-matrix.test.ts). Run on the Linux gate host.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-2222-0000-0000-000000000001"; // home tenant
const T2 = "aaaaaaaa-2222-0000-0000-000000000002"; // rival tenant

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"]; rootCompanies?: string[] } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: "u-site", assurance: opts.assurance ?? "high", companies,
    rootCompanies: opts.rootCompanies ?? companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
  };
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });

const site = (tenantId = T1, id?: string): Resource => ({ kind: "webdev_site", tenantId, module: "webdev", ...(id ? { id } : {}) });
const oldSite = (tenantId = T1, id?: string): Resource => ({ kind: "webdev_provisioned_site", tenantId, module: "webdev", ...(id ? { id } : {}) });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

/** new action -> the old `webdev_provisioned_site` action it replaced. */
const REPLACES: Record<string, string> = {
  read: "read",
  create: "provision",
  update: "operate",
  request_probe_consent: "read",
};
const ACTIONS = Object.keys(REPLACES);

type Cell = Record<string, boolean>;
const ALL: Cell = { read: true, create: true, update: true, request_probe_consent: true };
const NONE: Cell = { read: false, create: false, update: false, request_probe_consent: false };
const READ_ONLY: Cell = { read: true, create: false, update: false, request_probe_consent: true };

describe.skipIf(!live)("M6-P3c Cerbos matrix — webdev_site (role x action, behaviour-preserving)", () => {
  // [label, principal, expected per new action]
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1", principal([co("company_admin")]), ALL],
    ["manager @T1", principal([co("manager")]), ALL],
    ["webdev_manager @T1 (module_manager)", principal([co("webdev_manager")]), ALL],
    ["webdev_staff @T1 (module_staff): read + ask for consent, no writes", principal([co("webdev_staff")]), READ_ONLY],
    ["member @T1", principal([co("member")]), NONE],
    ["client @T1 — the client grant appears nowhere in this policy", principal([co("client")]), NONE],
    ["hr_manager @T1 (another module's manager tier)", principal([co("hr_manager")]), NONE],
    ["group_executive (global) — IAM-15 removed the role, nothing here", principal([glob("group_executive")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["webdev_manager @T1 at LOW assurance", principal([co("webdev_manager")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, site(), action), `${label}: webdev_site · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("each action carries the EXACT reach of the old action it replaced, for every principal in the table", async () => {
    for (const [label, p] of table) {
      for (const action of ACTIONS) {
        const now = await allow(p, site(), action);
        const before = await allow(p, oldSite(), REPLACES[action]);
        expect(now, `${label}: webdev_site · ${action} vs webdev_provisioned_site · ${REPLACES[action]}`).toBe(before);
      }
    }
  });

  it("an instance id (GET/PATCH sites/:id name a webdev_sites row) does not change any decision", async () => {
    for (const [label, p] of table) {
      for (const action of ACTIONS) {
        expect(await allow(p, site(T1, "11111111-1111-1111-1111-111111111111"), action), `${label} · ${action}`)
          .toBe(await allow(p, site(), action));
      }
    }
  });

  it("an unlisted action on the new kind is a deny, never a wildcard leak (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), site(), "delete")).toBe(false);
    expect(await allow(principal([co("webdev_manager")]), site(), "promote")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), site(), "delete")).toBe(true); // the wildcard, as on the old kind
  });

  it("the old kind is unchanged for its own provisioning routes: reconcile/promote stay out of the new kind", async () => {
    const p = principal([co("company_admin")]);
    expect(await allow(p, oldSite(), "reconcile")).toBe(true);
    expect(await allow(p, site(), "reconcile")).toBe(false);
    expect(await allow(p, oldSite(), "promote")).toBe(true);
    expect(await allow(p, site(), "promote")).toBe(false);
  });
});

describe.skipIf(!live)("M6-P3c Cerbos matrix — webdev_site, the B12 permission-mirror arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; companies?: string[] } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  // old key held -> allowed old action  <=>  new key held -> allowed new action (read, create, request_probe_consent)
  const MIRRORED: Array<[string, string, string, string]> = [
    // [new action, new perm key, old action, old perm key]
    ["read", "webdev.site.read", "read", "webdev.provisioned_site.read"],
    ["create", "webdev.site.create", "provision", "webdev.provisioned_site.provision"],
    ["request_probe_consent", "webdev.site.request_probe_consent", "read", "webdev.provisioned_site.read"],
  ];

  for (const [action, key, oldAction, oldKey] of MIRRORED) {
    it(`permission ${key} ALONE allows ${action} — exactly as ${oldKey} allowed ${oldAction}`, async () => {
      expect(await allow(permP(key), site(), action)).toBe(true);
      expect(await allow(permP(oldKey), oldSite(), oldAction)).toBe(true);
    });

    it(`permission ${key} does not bleed into the sibling actions it was not granted`, async () => {
      for (const other of ACTIONS.filter((a) => a !== action)) {
        expect(await allow(permP(key), site(), other), `${key} must not allow ${other}`).toBe(false);
      }
    });

    it(`permission ${key}: no cross-tenant reach, no low-assurance reach`, async () => {
      expect(await allow(permP(key), site(T2), action)).toBe(false);
      expect(await allow(permP(key, "company", { assurance: "low" }), site(), action)).toBe(false);
    });
  }

  it("`update` has NO mirror arm (the old `operate` had none): the permission alone allows nothing", async () => {
    expect(await allow(permP("webdev.site.update"), site(), "update")).toBe(false);
    expect(await allow(permP("webdev.provisioned_site.operate"), oldSite(), "operate")).toBe(false);
  });

  it("the OLD keys no longer reach the new kind (the migration copies them onto the new keys instead)", async () => {
    expect(await allow(permP("webdev.provisioned_site.read"), site(), "read")).toBe(false);
    expect(await allow(permP("webdev.provisioned_site.provision"), site(), "create")).toBe(false);
  });

  it("a global-scope permission covers the tenant the principal is authorised for (same as the role arm)", async () => {
    expect(await allow(permP("webdev.site.read", "global"), site(), "read")).toBe(true);
  });
});
