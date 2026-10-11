// WSK-49f / WSK-D60 -- the two attribute-gated derived roles and the `client_contact` grant actions, against a
// LIVE Cerbos (skips without CERBOS_URL, same convention as cerbos-webdev-matrix.test.ts).
//
// Two things are proven here, and they need different probes:
//   (1) the DERIVED ROLES match ONLY the granted client in the granted tenant. Nothing references
//       `client_website_editor` in a resource rule yet (WSK-49c adds those), so the only way to see the derived
//       role is Cerbos' own `includeMeta` answer (`effectiveDerivedRoles`). A positive control on the right
//       client sits beside every denial.
//   (2) the DECISIONS on `client_contact` · manage_website_editor / manage_admin, for staff and for a client
//       admin, through the real `check()` the controllers use.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, principalPayload, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-1111-0000-0000-000000000001"; // the serving company
const T2 = "aaaaaaaa-1111-0000-0000-000000000002"; // another company
const CA = "cccccccc-0000-0000-0000-00000000000a"; // client A (T1)
const CB = "cccccccc-0000-0000-0000-00000000000b"; // client B (T1)
const ME = "user-self";

const base = {
  id: "", tenantId: T1, ownerId: "", projectId: "", teamId: "", module: "", subjectUserId: "", origin: "",
  unitAncestors: [], creatorId: "", subKind: "", targetUserId: "", published: false, panelistUserIds: [],
  hiringManagerUserId: "", recruiterUserId: "", approvalId: "", collectionKey: "", locale: "", itemCount: 0, clientId: "",
};

function editorPrincipal(grants: RoleGrant[], extra: Partial<Principal> = {}): Principal {
  return { userId: ME, assurance: "high", companies: [T1], rootCompanies: [T1], roles: grants, sessionVersion: 1, ...extra };
}
// `null` = a grant that arrives WITHOUT its tenant. (It was `undefined` until WSK-49c un-skipped this suite: an
// `undefined` argument takes the DEFAULT, so the "without its tenant" case silently sent T1 and the test could never fail.)
const editorGrant = (clientId: string, tenantId: string | null = T1): RoleGrant => ({
  role: "client_website_editor", scopeType: "client", scopeId: clientId, ...(tenantId ? { scopeTenantId: tenantId } : {}),
});

/** Cerbos' own answer: which derived roles are effective for this principal on this resource. */
async function effectiveDerived(p: Principal, resource: { kind: string; attr: Record<string, unknown> }): Promise<string[]> {
  const res = await fetch(`${process.env.CERBOS_URL}/api/check/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "w49f",
      includeMeta: true,
      principal: principalPayload(p),
      resources: [{ actions: ["read"], resource: { kind: resource.kind, id: "r1", attr: { ...base, ...resource.attr } } }],
    }),
  });
  expect(res.ok).toBe(true);
  const j = (await res.json()) as { results: Array<{ meta?: { effectiveDerivedRoles?: string[] } }> };
  return j.results[0].meta?.effectiveDerivedRoles ?? [];
}

const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// ── Cerbos only reports a derived role as effective for a kind whose policy REFERENCES it in a rule. WSK-49f shipped
// before any resource rule did, so this live matrix switched itself off ("NO CONSUMER YET"); WSK-49c added the
// client-editor rules on `webdesk_content_item` / `webdesk_media_asset`, which is what turns it on. The decisions those
// rules make are pinned in client-website-editor-consumer.cerbos.test.ts.
const POLICIES = join(__dirname, "../../cerbos/policies");
function consumerKind(role: string): string | null {
  for (const f of readdirSync(POLICIES)) {
    if (!f.startsWith("resource_") || !f.endsWith(".yaml")) continue;
    for (const doc of yaml.loadAll(readFileSync(join(POLICIES, f), "utf8")) as any[]) {
      const rp = doc?.resourcePolicy;
      if (rp && (rp.rules ?? []).some((r: any) => (r.derivedRoles ?? []).includes(role))) return rp.resource as string;
    }
  }
  return null;
}
const EDITOR_KIND = consumerKind("client_website_editor");

describe("WSK-49f — derived_roles.yaml: the attribute conditions are pinned structurally", () => {
  const docs = yaml.loadAll(readFileSync(join(POLICIES, "derived_roles.yaml"), "utf8")) as any[];
  const defs: Array<{ name: string; condition: { match: { expr: string } } }> = docs.flatMap((d) => d?.derivedRoles?.definitions ?? []);
  const expr = (n: string) => String(defs.find((d) => d.name === n)?.condition?.match?.expr).replace(/\s+/g, " ");

  it("client_website_editor: scopeType client, scopeId == the resource's clientId, scopeTenantId == its tenant, nothing else", () => {
    const e = expr("client_website_editor");
    expect(e).toContain('request.resource.attr.clientId != ""');
    expect(e).toContain('g.role == "client_website_editor"');
    expect(e).toContain('g.scopeType == "client"');
    expect(e).toContain("g.scopeId == request.resource.attr.clientId");
    expect(e).toContain("g.scopeTenantId == request.resource.attr.tenantId");
    expect(e).not.toMatch(/global|company/);
  });
  it("client_contact_admin: the principal's clientAdminOf must contain THIS client in THIS tenant", () => {
    const e = expr("client_contact_admin");
    expect(e).toContain("request.principal.attr.clientAdminOf.exists(a, a.clientId == request.resource.attr.clientId && a.tenantId == request.resource.attr.tenantId)");
    expect(e).toContain('request.resource.attr.clientId != ""');
  });
  it("neither ROLE has a perm_* mirror (the two ACTIONS do, below), and no policy uses variables.local", () => {
    // A mirror OF THE ROLES would be `perm_client_website_editor` / `perm_client_contact_admin`: a flat key cannot say
    // "this one client". The action mirrors `perm_client_contact_manage_*` (WSK-D60 follow-up) are a different thing.
    expect(defs.some((d) => /^perm_(client_website_editor|client_contact_admin)/.test(d.name))).toBe(false);
    for (const f of readdirSync(POLICIES)) {
      const code = readFileSync(join(POLICIES, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(code.includes("variables.local"), `${f} must not use variables.local (outside comments)`).toBe(false);
    }
  });
  it("the client arm of manage_website_editor names ONLY client_contact_admin, and manage_admin has no client arm", () => {
    const doc = yaml.load(readFileSync(join(POLICIES, "resource_client_contact.yaml"), "utf8")) as any;
    const rules: any[] = doc.resourcePolicy.rules;
    // explicitly-named rules only (platform_admin reaches both through its separate `actions: ["*"]` rule)
    // Role arms only: the permission arm (`perm_*`) is pinned in its own test below.
    const arms = (action: string) => rules.filter((r) => r.effect === "EFFECT_ALLOW" && (r.actions ?? []).includes(action)).flatMap((r) => r.derivedRoles ?? []).filter((d) => !d.startsWith("perm_"));
    expect(arms("manage_website_editor").sort()).toEqual(["client_contact_admin", "company_admin", "manager"].sort());
    expect(arms("manage_admin")).toEqual(["company_admin"]);
    expect(arms("manage_admin")).not.toContain("client_contact_admin");
  });
  // WSK-D60 follow-up (2026-10-12): `owner` is permission-native, so it reaches these two actions only through a perm_*
  // arm. The mirror must be the STAFF shape only (no clientId), so a key holder can never ride the portal arm.
  it("the permission arm of the two actions: ONE perm_* role each, staff shape only (clientId empty), tenant + assurance gated", () => {
    const doc = yaml.load(readFileSync(join(POLICIES, "resource_client_contact.yaml"), "utf8")) as any;
    const rules: any[] = doc.resourcePolicy.rules;
    const permRules = (action: string) => rules.filter((r) => r.effect === "EFFECT_ALLOW" && (r.actions ?? []).includes(action) && (r.derivedRoles ?? []).some((d: string) => d.startsWith("perm_")));
    for (const [action, role] of [["manage_website_editor", "perm_client_contact_manage_website_editor"], ["manage_admin", "perm_client_contact_manage_admin"]] as const) {
      const rs = permRules(action);
      expect(rs.length, `${action}: exactly one perm rule`).toBe(1);
      expect(rs[0].actions, "one rule per action, never a shared list").toEqual([action]);
      expect(rs[0].derivedRoles).toEqual([role]);
      const cond = String(rs[0].condition.match.expr).replace(/\s+/g, " ");
      expect(cond).toContain("variables.inTenant");
      expect(cond).toContain("variables.notLow");
      expect(cond).toContain('request.resource.attr.clientId == ""');
    }
  });
  it("the two perm_* derived roles are plain global-or-company mirrors of exactly their own key", () => {
    for (const [role, key] of [["perm_client_contact_manage_website_editor", "core.client_contact.manage_website_editor"], ["perm_client_contact_manage_admin", "core.client_contact.manage_admin"]] as const) {
      const e = expr(role);
      expect(e).toContain(`g.key == "${key}"`);
      expect(e).toContain('g.scopeType == "global"');
      expect(e).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
      expect(e, "no attribute gate: the narrowing lives in the RULE").not.toContain("request.resource.attr.clientId");
    }
  });
});

describe.skipIf(!live || !EDITOR_KIND)(`WSK-49f — derived role client_website_editor matches ONLY the granted client, in the grant's tenant (live, on kind "${EDITOR_KIND ?? "NO CONSUMER YET — WSK-49c"}")`, () => {
  const p = editorPrincipal([editorGrant(CA)]);
  const kind = EDITOR_KIND ?? "client_contact";

  it("positive control: the right client in the right tenant", async () => {
    expect(await effectiveDerived(p, { kind, attr: { tenantId: T1, clientId: CA } })).toContain("client_website_editor");
  });
  it("DENIED: another client of the SAME tenant", async () => {
    expect(await effectiveDerived(p, { kind, attr: { tenantId: T1, clientId: CB } })).not.toContain("client_website_editor");
  });
  it("DENIED: the same client id under ANOTHER tenant", async () => {
    expect(await effectiveDerived(p, { kind, attr: { tenantId: T2, clientId: CA } })).not.toContain("client_website_editor");
  });
  it("DENIED: an unfed resource (no clientId) — a handler that forgot the attribute confers nothing", async () => {
    expect(await effectiveDerived(p, { kind, attr: { tenantId: T1, clientId: "" } })).not.toContain("client_website_editor");
  });
  it("DENIED: a client-scoped grant that arrives WITHOUT its tenant (fail closed)", async () => {
    const noTenant = editorPrincipal([editorGrant(CA, null)]);
    expect(await effectiveDerived(noTenant, { kind, attr: { tenantId: T1, clientId: CA } })).not.toContain("client_website_editor");
  });
  it("DENIED: the same role name at COMPANY scope (impossible in the DB, still refused by the policy)", async () => {
    const wrongScope = editorPrincipal([{ role: "client_website_editor", scopeType: "company", scopeId: CA, scopeTenantId: T1 }]);
    expect(await effectiveDerived(wrongScope, { kind, attr: { tenantId: T1, clientId: CA } })).not.toContain("client_website_editor");
  });
  it("DENIED: a client-scoped grant under a DIFFERENT role name", async () => {
    const wrongRole = editorPrincipal([{ role: "company_admin", scopeType: "client", scopeId: CA, scopeTenantId: T1 }]);
    expect(await effectiveDerived(wrongRole, { kind, attr: { tenantId: T1, clientId: CA } })).not.toContain("client_website_editor");
  });
  it("two grants: each client matches only its own", async () => {
    const two = editorPrincipal([editorGrant(CA), editorGrant(CB)]);
    expect(await effectiveDerived(two, { kind, attr: { tenantId: T1, clientId: CA } })).toContain("client_website_editor");
    expect(await effectiveDerived(two, { kind, attr: { tenantId: T1, clientId: CB } })).toContain("client_website_editor");
    expect(await effectiveDerived(two, { kind, attr: { tenantId: T1, clientId: "cccccccc-0000-0000-0000-00000000000c" } })).not.toContain("client_website_editor");
  });
  it("the grant carries no permission: the holder is denied every client_contact action", async () => {
    for (const a of ["read", "create", "update", "revoke", "manage_website_editor", "manage_admin"]) {
      expect(await allow(p, { kind: "client_contact", tenantId: T1, clientId: CA }, a)).toBe(false);
    }
  });
});

describe.skipIf(!live)("WSK-49f — derived role client_contact_admin matches ONLY the client the principal administers", () => {
  const admin = editorPrincipal([{ role: "client", scopeType: "company", scopeId: T1 }], { clientAdminOf: [{ tenantId: T1, clientId: CA }] });

  it("positive control", async () => {
    expect(await effectiveDerived(admin, { kind: "client_contact", attr: { tenantId: T1, clientId: CA } })).toContain("client_contact_admin");
  });
  it("DENIED: another client / another tenant / unfed resource", async () => {
    expect(await effectiveDerived(admin, { kind: "client_contact", attr: { tenantId: T1, clientId: CB } })).not.toContain("client_contact_admin");
    expect(await effectiveDerived(admin, { kind: "client_contact", attr: { tenantId: T2, clientId: CA } })).not.toContain("client_contact_admin");
    expect(await effectiveDerived(admin, { kind: "client_contact", attr: { tenantId: T1, clientId: "" } })).not.toContain("client_contact_admin");
  });
  it("DENIED: a principal with no clientAdminOf (every non-admin contact)", async () => {
    const viewer = editorPrincipal([{ role: "client", scopeType: "company", scopeId: T1 }]);
    expect(await effectiveDerived(viewer, { kind: "client_contact", attr: { tenantId: T1, clientId: CA } })).not.toContain("client_contact_admin");
  });
});

describe.skipIf(!live)("WSK-49f — client_contact · manage_website_editor / manage_admin decisions", () => {
  const own: Resource = { kind: "client_contact", tenantId: T1, clientId: CA };
  const staffRes: Resource = { kind: "client_contact", tenantId: T1 };
  const staff = (role: string) => editorPrincipal([{ role, scopeType: "company", scopeId: T1 }]);
  const clientAdmin = editorPrincipal([{ role: "client", scopeType: "company", scopeId: T1 }], { clientAdminOf: [{ tenantId: T1, clientId: CA }] });

  it("client admin: manage_website_editor on OWN client allowed (positive control)", async () => {
    expect(await allow(clientAdmin, own, "manage_website_editor")).toBe(true);
  });
  it("client admin: DENIED on another client, another tenant, and on the staff-shaped resource (no clientId)", async () => {
    expect(await allow(clientAdmin, { ...own, clientId: CB }, "manage_website_editor")).toBe(false);
    expect(await allow(clientAdmin, { ...own, tenantId: T2 }, "manage_website_editor")).toBe(false);
    expect(await allow(clientAdmin, staffRes, "manage_website_editor")).toBe(false);
  });
  it("client admin: manage_admin is DENIED everywhere (admin is assigned only by staff)", async () => {
    expect(await allow(clientAdmin, own, "manage_admin")).toBe(false);
    expect(await allow(clientAdmin, staffRes, "manage_admin")).toBe(false);
  });
  it("client admin: every other client_contact action is DENIED (they cannot invite, edit, revoke, or read the staff list)", async () => {
    for (const a of ["create", "update", "revoke", "read"]) expect(await allow(clientAdmin, own, a)).toBe(false);
  });
  it("client admin: nothing on role_grant, position, employee (no staff surface opens)", async () => {
    for (const kind of ["role_grant", "position", "employee"]) {
      for (const a of ["create", "read", "revoke", "assign"]) {
        expect(await allow(clientAdmin, { kind, tenantId: T1, clientId: CA }, a)).toBe(false);
      }
    }
  });
  it("a plain admin capability holder with a low assurance session is denied (notLow)", async () => {
    expect(await allow({ ...clientAdmin, assurance: "low" }, own, "manage_website_editor")).toBe(false);
  });
  it("staff: company_admin may do both; manager only the website editor; member neither", async () => {
    expect(await allow(staff("company_admin"), staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(staff("company_admin"), staffRes, "manage_admin")).toBe(true);
    expect(await allow(staff("manager"), staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(staff("manager"), staffRes, "manage_admin")).toBe(false);
    expect(await allow(staff("member"), staffRes, "manage_website_editor")).toBe(false);
    expect(await allow(staff("member"), staffRes, "manage_admin")).toBe(false);
    expect(await allow(staff("viewer"), staffRes, "manage_website_editor")).toBe(false);
  });
  it("staff of ANOTHER company are denied on this tenant", async () => {
    const rival = editorPrincipal([{ role: "company_admin", scopeType: "company", scopeId: T2 }], { companies: [T2], rootCompanies: [T2] });
    expect(await allow(rival, staffRes, "manage_website_editor")).toBe(false);
    expect(await allow(rival, staffRes, "manage_admin")).toBe(false);
  });
  it("platform_admin (global) may do both", async () => {
    const pa = editorPrincipal([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    expect(await allow(pa, staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(pa, staffRes, "manage_admin")).toBe(true);
  });

  // ── WSK-D60 follow-up: `owner` is permission-native (zero role rules); it reaches these actions through perm_* only ──
  const KW = "core.client_contact.manage_website_editor";
  const KA = "core.client_contact.manage_admin";
  const permOnly = (keys: string[], scope: "company" | "global" = "company", extra: Partial<Principal> = {}): Principal =>
    editorPrincipal([], { perms: keys.map((key) => ({ key, scopeType: scope, scopeId: scope === "company" ? T1 : null })), ...extra });

  it("owner (perm keys only, no role grants): BOTH actions allowed on the staff shape in its own company", async () => {
    const owner = permOnly([KW, KA]);
    expect(await allow(owner, staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(owner, staffRes, "manage_admin")).toBe(true);
    expect(await allow(owner, { ...staffRes, id: "contact-1" }, "manage_website_editor")).toBe(true);
  });
  it("owner: DENIED in another company (the own-company rows above are the positive controls)", async () => {
    const owner = permOnly([KW, KA]);
    expect(await allow(owner, { ...staffRes, tenantId: T2 }, "manage_website_editor")).toBe(false);
    expect(await allow(owner, { ...staffRes, tenantId: T2 }, "manage_admin")).toBe(false);
  });
  it("owner: DENIED on the PORTAL shape (clientId set) - a key holder never rides the portal arm", async () => {
    const owner = permOnly([KW, KA]);
    expect(await allow(owner, staffRes, "manage_website_editor")).toBe(true); // positive control
    expect(await allow(owner, own, "manage_website_editor")).toBe(false);
    expect(await allow(owner, own, "manage_admin")).toBe(false);
  });
  it("a GLOBAL-scope perm grant still needs the tenant gate", async () => {
    const owner = permOnly([KW, KA], "global");
    expect(await allow(owner, staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(owner, { ...staffRes, tenantId: T2 }, "manage_website_editor")).toBe(false);
  });
  it("each key authorises its OWN action only, and no other client_contact key does either", async () => {
    expect(await allow(permOnly([KW]), staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(permOnly([KW]), staffRes, "manage_admin")).toBe(false);
    expect(await allow(permOnly([KA]), staffRes, "manage_admin")).toBe(true);
    expect(await allow(permOnly([KA]), staffRes, "manage_website_editor")).toBe(false);
    const others = permOnly(["core.client_contact.read", "core.client_contact.update", "core.client_contact.create", "core.client_contact.revoke"]);
    expect(await allow(others, staffRes, "manage_website_editor")).toBe(false);
    expect(await allow(others, staffRes, "manage_admin")).toBe(false);
  });
  it("a perm holder at LOW assurance, or whose company set lacks the tenant, is denied", async () => {
    expect(await allow(permOnly([KW, KA], "company", { assurance: "low" }), staffRes, "manage_website_editor")).toBe(false);
    expect(await allow(permOnly([KW, KA], "company", { companies: [T2], rootCompanies: [T2] }), staffRes, "manage_admin")).toBe(false);
  });
  it("manager keeps manage_admin DENIED even while it holds the website-editor key; member holds neither", async () => {
    const manager = editorPrincipal([{ role: "manager", scopeType: "company", scopeId: T1 }], { perms: [{ key: KW, scopeType: "company", scopeId: T1 }] });
    expect(await allow(manager, staffRes, "manage_website_editor")).toBe(true);
    expect(await allow(manager, staffRes, "manage_admin")).toBe(false);
    expect(await allow(manager, own, "manage_admin")).toBe(false);
    expect(await allow(staff("member"), staffRes, "manage_admin")).toBe(false);
  });
});
