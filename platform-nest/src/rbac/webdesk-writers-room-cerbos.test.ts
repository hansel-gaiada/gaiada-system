// M5-W1a — the writers' room roles (docs/plans/2026-10-11-m5-writers-room-design.md §2, §7, §9 row W1a).
//
// Three layers, each needing a different kind of proof:
//   (1) STATIC: the payload transport (principalPayload sends a grant's `editorialScopes`, field by field, and
//       leaves every other grant's shape byte-identical) and the structural invariants the design rests on (the
//       derived roles match `company` scope only; no perm_* role for these kinds; no bundle for the four roles).
//   (2) LIVE, through the real check() the controllers use (skips without CERBOS_URL, the convention of
//       cerbos-webdev-matrix.test.ts): the W1a acceptance probes, each denial beside a positive control so a
//       rule that denies everything cannot pass.
//   (3) The full role x action x resource matrix, negatives included, is cerbos/tests/webdesk_writers_room_test.yaml
//       (`cerbos compile --tests`). This file does not repeat it; it proves the same decisions arrive through
//       principalPayload()/resourcePayload(), which the YAML suite bypasses.
//
// Role bundles and role-permission parity are BLIND to all of this (they treat every condition as satisfied and the
// four roles map to no bundle), so these probes are the only evidence the scoped roles do what they claim.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, principalPayload, type Resource } from "./cerbos";
import type { EditorialScope, Principal, RoleGrant } from "./principal";
import bundles from "./role-permission-bundles.json";
import scopeConstrained from "./scope-constrained-roles.json";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-1111-0000-0000-000000000001";
const T2 = "aaaaaaaa-1111-0000-0000-000000000002";
const S1 = "site-1";
const S2 = "site-2";
const WRITER = "u-writer";
const EDITOR = "u-editor";
const OTHER = "u-other";
const EDITORIAL_ROLES = ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"] as const;
const POLICIES = join(__dirname, "../../cerbos/policies");

const scope = (siteId: string, collections: string[] | "all", locales: string[] | "all"): EditorialScope => ({
  siteId,
  allCollections: collections === "all",
  collections: collections === "all" ? [] : collections,
  allLocales: locales === "all",
  locales: locales === "all" ? [] : locales,
});
function principal(userId: string, grants: RoleGrant[], extra: Partial<Principal> = {}): Principal {
  return { userId, assurance: "high", companies: [T1], rootCompanies: [T1], roles: grants, sessionVersion: 1, ...extra };
}
const editorial = (role: string, scopes: EditorialScope[] | undefined, scopeType: RoleGrant["scopeType"] = "company", scopeId: string | null = T1): RoleGrant => ({
  role, scopeType, scopeId, ...(scopes ? { editorialScopes: scopes } : {}),
});
const writer = (extra: Partial<Principal> = {}) => principal(WRITER, [editorial("webdesk_writer", [scope(S1, ["post"], ["en"])])], extra);
const translator = () => principal("u-trans", [editorial("webdesk_translator", [scope(S1, ["post"], ["id"])])]);
const seo = () => principal("u-seo", [editorial("webdesk_seo_reviewer", [scope(S1, "all", "all")])]);
const editor = (userId = EDITOR, extra: Partial<Principal> = {}) => principal(userId, [editorial("webdesk_editor", [scope(S1, ["post", "guide"], "all")])], extra);
const platformAdmin: Principal = { userId: "u-padmin", assurance: "high", companies: [], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1 };

// An item exactly as W1c's ItemGate will present it: every attribute from WebDesk's read or the proven route.
const item = (over: Partial<Resource> = {}): Resource => ({
  kind: "webdesk_content_item", tenantId: T1, module: "webdev", id: "item-1", siteId: S1,
  collectionKey: "post", locale: "en", ownerId: WRITER, reviewState: "draft", ...over,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// ═══════════════════════════════════════ (1) static ═══════════════════════════════════════════════
describe("M5-W1a — principalPayload transports a writers' room grant's scope rows (allow-list, conditional spread)", () => {
  it("sends editorialScopes field by field on an editorial grant, and nothing a caller smuggled onto a row", () => {
    const smuggled = { ...scope(S1, ["post"], ["en"]), extra: "x" } as EditorialScope;
    const p = principal(WRITER, [editorial("webdesk_writer", [smuggled])]);
    const g = principalPayload(p).attr.grants[0] as Record<string, unknown>;
    expect(g).toEqual({
      role: "webdesk_writer", scopeType: "company", scopeId: T1,
      editorialScopes: [{ siteId: S1, allCollections: false, collections: ["post"], allLocales: false, locales: ["en"] }],
    });
  });

  it("every other grant keeps its exact historical shape (no editorialScopes key at all)", () => {
    const p = principal("u-x", [
      { role: "webdev_staff", scopeType: "company", scopeId: T1 },
      { role: "platform_admin", scopeType: "global", scopeId: null },
    ]);
    expect(principalPayload(p).attr.grants).toEqual([
      { role: "webdev_staff", scopeType: "company", scopeId: T1 },
      { role: "platform_admin", scopeType: "global", scopeId: "" },
    ]);
  });

  it("a non-boolean `all*` flag is sent as false, so it can never widen a scope", () => {
    const loose = { siteId: S1, allCollections: "true", collections: ["post"], allLocales: 1, locales: ["en"] } as unknown as EditorialScope;
    const g = principalPayload(principal(WRITER, [editorial("webdesk_writer", [loose])])).attr.grants[0] as { editorialScopes: EditorialScope[] };
    expect(g.editorialScopes[0].allCollections).toBe(false);
    expect(g.editorialScopes[0].allLocales).toBe(false);
  });
});

describe("M5-W1a — the structural invariants (design §2.5)", () => {
  const docs = yaml.loadAll(readFileSync(join(POLICIES, "derived_roles.yaml"), "utf8")) as any[];
  const defs: Array<{ name: string; condition: { match: { expr: string } } }> = docs.flatMap((d) => d?.derivedRoles?.definitions ?? []);
  const expr = (n: string) => String(defs.find((d) => d.name === n)?.condition?.match?.expr ?? "").replace(/\s+/g, " ");
  const EDITORIAL_DERIVED = ["webdesk_editorial_site", "webdesk_editorial_reader", ...EDITORIAL_ROLES];

  it.each(EDITORIAL_DERIVED)("derived role %s: company scope only, tenant-pinned, scope rows required, unfed site matches nothing", (name) => {
    const e = expr(name);
    expect(e, `${name} is defined`).not.toBe("");
    expect([...e.matchAll(/g\.scopeType\s*==\s*"(\w+)"/g)].map((m) => m[1])).toEqual(["company"]);
    expect(e).toContain("g.scopeId == request.resource.attr.tenantId");
    expect(e).toContain("has(g.editorialScopes)");
    expect(e).toMatch(/^has\(request\.resource\.attr\.siteId\) && request\.resource\.attr\.siteId != ""/);
    expect(e).not.toContain("variables.");
  });

  it("the per-role derived roles also require a non-empty collection and locale, and test both against the scope row", () => {
    for (const role of EDITORIAL_ROLES) {
      const e = expr(role);
      expect(e).toContain(`g.role == "${role}"`);
      expect(e).toContain('request.resource.attr.collectionKey != ""');
      expect(e).toContain('request.resource.attr.locale != ""');
      expect(e).toContain("(s.allCollections == true || request.resource.attr.collectionKey in s.collections)");
      expect(e).toContain("(s.allLocales == true || request.resource.attr.locale in s.locales)");
    }
  });

  it("scope-constrained-roles.json pins all four roles to `company` (IAM-SEC-06 drops any other scope)", () => {
    const roles = (scopeConstrained as { roles: Record<string, string[]> }).roles;
    for (const role of EDITORIAL_ROLES) expect(roles[role], role).toEqual(["company"]);
  });

  it("no bundle for the four roles, and no perm_* derived role for any webdesk kind", () => {
    const bundleRoles = Object.keys((bundles as { roles: Record<string, string[]> }).roles);
    for (const role of EDITORIAL_ROLES) expect(bundleRoles, role).not.toContain(role);
    expect(defs.filter((d) => /^perm_webdesk_|^perm_webdev_webdesk_/.test(d.name)).map((d) => d.name)).toEqual([]);
  });

  it("each editorial derived role sits in its OWN rule (never beside a scope-only role) in every webdesk policy", () => {
    for (const f of readdirSync(POLICIES).filter((x) => x.startsWith("resource_webdesk_"))) {
      for (const doc of yaml.loadAll(readFileSync(join(POLICIES, f), "utf8")) as any[]) {
        for (const rule of doc?.resourcePolicy?.rules ?? []) {
          const drs: string[] = rule.derivedRoles ?? [];
          if (drs.some((d) => EDITORIAL_DERIVED.includes(d))) expect(drs, `${f}: ${JSON.stringify(rule.actions)}`).toHaveLength(1);
        }
      }
    }
  });
});

// ═══════════════════════════════════════ (2) live, through check() ══════════════════════════════════
describe.skipIf(!live)("M5-W1a live — writer", () => {
  it("update on its OWN in-scope draft (and changes_requested) ALLOW; submit and comment too", async () => {
    expect(await allow(writer(), item(), "update")).toBe(true);
    expect(await allow(writer(), item({ reviewState: "changes_requested" }), "update")).toBe(true);
    expect(await allow(writer(), item(), "submit")).toBe(true);
    expect(await allow(writer(), item(), "comment")).toBe(true);
  });

  it("update DENY on another collection, another locale, another site, another author, or while in_review", async () => {
    expect(await allow(writer(), item({ collectionKey: "guide" }), "update"), "collection").toBe(false);
    expect(await allow(writer(), item({ locale: "id" }), "update"), "locale").toBe(false);
    expect(await allow(writer(), item({ siteId: S2 }), "update"), "site").toBe(false);
    expect(await allow(writer(), item({ ownerId: OTHER }), "update"), "author").toBe(false);
    expect(await allow(writer(), item({ reviewState: "in_review" }), "update"), "in_review").toBe(false);
    expect(await allow(writer(), item({ reviewState: "approved" }), "update"), "approved").toBe(false);
    expect(await allow(writer(), item(), "update"), "positive control").toBe(true);
  });

  it("reads its collection in any locale; reads nothing outside the scope row", async () => {
    expect(await allow(writer(), item({ locale: "id", ownerId: OTHER }), "read")).toBe(true);
    expect(await allow(writer(), item({ collectionKey: "guide" }), "read")).toBe(false);
    expect(await allow(writer(), item({ siteId: S2 }), "read")).toBe(false);
  });

  it("never reviews, approves, assigns or publishes", async () => {
    const inReview = item({ reviewState: "in_review", creatorId: OTHER });
    for (const a of ["request_changes", "seo_signoff", "approve", "assign", "request_publish", "unpublish", "delete"]) {
      expect(await allow(writer(), inReview, a), a).toBe(false);
    }
  });

  it("an UNFED resource (no siteId / reviewState from the handler) is DENIED — the rules ahead of their transport", async () => {
    const unfed: Resource = { kind: "webdesk_content_item", tenantId: T1, module: "webdev", id: "item-1", collectionKey: "post", locale: "en", ownerId: WRITER };
    for (const a of ["read", "create", "update", "submit"]) expect(await allow(writer(), unfed, a), a).toBe(false);
    // ...while the staff tier, which reads no siteId, is unaffected
    expect(await allow(principal("u-staff", [{ role: "webdev_staff", scopeType: "company", scopeId: T1 }]), unfed, "update")).toBe(true);
  });

  it("a GLOBAL writer grant, a T2 grant, a grant without scope rows, and low assurance: DENY everything", async () => {
    const global = principal(WRITER, [editorial("webdesk_writer", [scope(S1, "all", "all")], "global", null)]);
    const t2 = principal(WRITER, [editorial("webdesk_writer", [scope(S1, ["post"], ["en"])], "company", T2)], { companies: [T1, T2] });
    const noRows = principal(WRITER, [editorial("webdesk_writer", undefined)]);
    const low = writer({ assurance: "low" });
    for (const [label, p] of [["global", global], ["T2 grant", t2], ["no scope rows", noRows], ["low", low]] as const) {
      for (const a of ["read", "create", "update", "submit", "comment"]) expect(await allow(p, item(), a), `${label} ${a}`).toBe(false);
    }
    // positive control for the tenant pin: the T2 grant DOES reach a T2 item in its scope
    expect(await allow(t2, item({ tenantId: T2 }), "read")).toBe(true);
  });
});

describe.skipIf(!live)("M5-W1a live — translator, SEO reviewer, editor", () => {
  it("translator: twin of an APPROVED or LIVE source ALLOW, of a draft source DENY; never an original", async () => {
    const twin = (over: Partial<Resource>) => item({ locale: "id", ownerId: "", ...over });
    expect(await allow(translator(), twin({ reviewState: "approved" }), "create"), "approved source").toBe(true);
    expect(await allow(translator(), twin({ reviewState: "draft", published: true }), "create"), "live source").toBe(true);
    expect(await allow(translator(), twin({ reviewState: "draft" }), "create"), "draft source").toBe(false);
    expect(await allow(translator(), twin({ reviewState: "in_review" }), "create"), "in-review source").toBe(false);
    expect(await allow(translator(), twin({ reviewState: "approved", locale: "en" }), "create"), "locale outside scope").toBe(false);
  });

  it("translator: edits its own twin as a writer would", async () => {
    expect(await allow(translator(), item({ locale: "id", ownerId: "u-trans" }), "update")).toBe(true);
    expect(await allow(translator(), item({ locale: "id", ownerId: OTHER }), "update")).toBe(false);
  });

  it("SEO reviewer: update in_review ALLOW, in draft DENY; signs off and requests changes; never approves or submits", async () => {
    expect(await allow(seo(), item({ reviewState: "in_review" }), "update")).toBe(true);
    expect(await allow(seo(), item({ reviewState: "draft" }), "update")).toBe(false);
    const r = item({ reviewState: "in_review", creatorId: OTHER });
    expect(await allow(seo(), r, "seo_signoff")).toBe(true);
    expect(await allow(seo(), r, "request_changes")).toBe(true);
    for (const a of ["approve", "submit", "create", "request_publish", "assign"]) expect(await allow(seo(), r, a), a).toBe(false);
  });

  it("editor: approve of ANOTHER's version ALLOW; of its own version DENY; of an unknown creator DENY; not in review DENY", async () => {
    expect(await allow(editor(), item({ reviewState: "in_review", creatorId: WRITER }), "approve")).toBe(true);
    expect(await allow(editor(), item({ reviewState: "in_review", creatorId: EDITOR }), "approve"), "own version").toBe(false);
    expect(await allow(editor(), item({ reviewState: "in_review", creatorId: "" }), "approve"), "unknown creator").toBe(false);
    expect(await allow(editor(), item({ reviewState: "draft", creatorId: WRITER }), "approve"), "draft").toBe(false);
  });

  it("editor: the review desk up to request_publish, never publish/schedule/unpublish/delete or seo_signoff", async () => {
    for (const a of ["create", "update", "submit", "comment", "request_changes", "assign", "request_publish"]) {
      expect(await allow(editor(), item({ ownerId: OTHER }), a), a).toBe(true);
    }
    const approved: Resource = item({ approvalId: "appr-1", creatorId: OTHER, itemCount: 1 });
    for (const a of ["publish", "schedule", "unpublish", "delete", "seo_signoff"]) expect(await allow(editor(), approved, a), a).toBe(false);
  });
});

describe.skipIf(!live)("M5-W1a live — four eyes and the machine principals (deny-overrides)", () => {
  const inReviewBy = (creatorId: string) => item({ reviewState: "in_review", creatorId });

  it("platform_admin: self-approve DENY (beats the wildcard); unknown creator DENY; another's version ALLOW", async () => {
    expect(await allow(platformAdmin, inReviewBy("u-padmin"), "approve"), "self").toBe(false);
    expect(await allow(platformAdmin, inReviewBy(""), "approve"), "unknown creator").toBe(false);
    expect(await allow(platformAdmin, inReviewBy(WRITER), "approve"), "positive control").toBe(true);
  });

  it("webdev_manager and company_admin: approve another's version, never their own", async () => {
    for (const [role, id] of [["webdev_manager", "u-pub"], ["company_admin", "u-cadmin"]] as const) {
      const p = principal(id, [{ role, scopeType: "company", scopeId: T1 }]);
      expect(await allow(p, inReviewBy(WRITER), "approve"), `${role} other`).toBe(true);
      expect(await allow(p, inReviewBy(id), "approve"), `${role} self`).toBe(false);
    }
  });

  it("bot and automation principals: approve and seo_signoff DENY (role held or not); the rest of the review desk stays", async () => {
    for (const kind of ["bot", "automation"] as const) {
      for (const base of [principal("u-m", [{ role: "webdev_manager", scopeType: "company", scopeId: T1 }]), principal("u-c", [{ role: "company_admin", scopeType: "company", scopeId: T1 }]), platformAdmin]) {
        const p: Principal = { ...base, kind };
        expect(await allow(p, inReviewBy(WRITER), "approve"), `${kind} approve`).toBe(false);
        expect(await allow(p, inReviewBy(WRITER), "seo_signoff"), `${kind} seo_signoff`).toBe(false);
        expect(await allow(p, inReviewBy(WRITER), "request_changes"), `${kind} request_changes`).toBe(true);
      }
    }
    // control: the same manager as an employee approves and signs off
    const human: Principal = { ...principal("u-m", [{ role: "webdev_manager", scopeType: "company", scopeId: T1 }]), kind: "employee" };
    expect(await allow(human, inReviewBy(WRITER), "approve")).toBe(true);
    expect(await allow(human, inReviewBy(WRITER), "seo_signoff")).toBe(true);
  });

  it("a contributor-kind principal never approves, even holding the editor role (the wall exists before the kind)", async () => {
    const p = editor("u-contrib", { kind: "contributor" as unknown as Principal["kind"] });
    expect(await allow(p, inReviewBy(WRITER), "approve")).toBe(false);
    expect(await allow(p, inReviewBy(WRITER), "request_changes"), "control: the rest of its role").toBe(true);
  });
});

describe.skipIf(!live)("M5-W1a live — the existing tiers (design §2.4) and the collection/media arms", () => {
  const staff = () => principal("u-staff", [{ role: "webdev_staff", scopeType: "company", scopeId: T1 }]);

  it("webdev_staff gains submit and comment, and no review decision", async () => {
    expect(await allow(staff(), item(), "submit")).toBe(true);
    expect(await allow(staff(), item(), "comment")).toBe(true);
    for (const a of ["request_changes", "seo_signoff", "approve", "assign"]) {
      expect(await allow(staff(), item({ reviewState: "in_review", creatorId: OTHER }), a), a).toBe(false);
    }
  });

  it("manager and member gain nothing", async () => {
    for (const role of ["manager", "member"]) {
      const p = principal("u-x", [{ role, scopeType: "company", scopeId: T1 }]);
      for (const a of ["submit", "comment", "request_changes", "seo_signoff", "approve", "assign"]) {
        expect(await allow(p, item({ reviewState: "in_review", creatorId: OTHER }), a), `${role} ${a}`).toBe(false);
      }
    }
  });

  it("manage_editorial: company_admin and webdev_manager ALLOW; webdev_staff, manager and every editorial role DENY", async () => {
    const coll: Resource = { kind: "webdesk_collection", tenantId: T1, module: "webdev", id: "post", siteId: S1, collectionKey: "post" };
    for (const role of ["company_admin", "webdev_manager"]) {
      expect(await allow(principal("u-x", [{ role, scopeType: "company", scopeId: T1 }]), coll, "manage_editorial"), role).toBe(true);
    }
    expect(await allow(platformAdmin, coll, "manage_editorial")).toBe(true);
    for (const role of ["webdev_staff", "manager"]) {
      expect(await allow(principal("u-x", [{ role, scopeType: "company", scopeId: T1 }]), coll, "manage_editorial"), role).toBe(false);
    }
    for (const p of [writer(), translator(), seo(), editor()]) {
      expect(await allow(p, coll, "manage_editorial"), p.roles[0].role).toBe(false);
      expect(await allow(p, coll, "apply_schema"), p.roles[0].role).toBe(false);
      expect(await allow(p, coll, "read"), `${p.roles[0].role} read`).toBe(true);
      expect(await allow(p, { ...coll, siteId: S2 }, "read"), `${p.roles[0].role} read site 2`).toBe(false);
    }
  });

  it("media: every editorial role may LIST its site's library, nothing more", async () => {
    const asset: Resource = { kind: "webdesk_media_asset", tenantId: T1, module: "webdev", id: "a1", siteId: S1 };
    for (const p of [writer(), translator(), seo(), editor()]) {
      expect(await allow(p, asset, "read"), p.roles[0].role).toBe(true);
      expect(await allow(p, { ...asset, siteId: S2 }, "read"), `${p.roles[0].role} site 2`).toBe(false);
      for (const a of ["upload", "update", "delete"]) expect(await allow(p, asset, a), `${p.roles[0].role} ${a}`).toBe(false);
    }
  });
});
