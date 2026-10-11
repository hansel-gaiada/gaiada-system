// WSK-49c / WSK-D58, D59, D60 -- the CONSUMER rules for the derived role `client_website_editor` on
// `webdesk_content_item` and `webdesk_media_asset`, decided by a LIVE Cerbos through the real `check()` (so the
// allow-listed attribute path `principalPayload()` / `resourcePayload()` is part of what is proven).
//
// DENIALS SEND VALID RESOURCES: every denial below is a request an allowed caller (the positive control beside it)
// would have succeeded with, so a DENY is Cerbos's decision about the client / tenant / action and nothing else.
// The self-approval negatives use a BATCH, because WSK-D46 R4 lets a single-item self-publish through.
//
// Two parts: a structural pin on the YAML (no live Cerbos needed) and the live decision matrix (skips without
// CERBOS_URL, same convention as client-website-editor-cerbos.test.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const POLICIES = join(__dirname, "../../cerbos/policies");
const T1 = "aaaaaaaa-1111-0000-0000-000000000001";
const T2 = "aaaaaaaa-1111-0000-0000-000000000002";
const CA = "cccccccc-0000-0000-0000-00000000000a";
const CB = "cccccccc-0000-0000-0000-00000000000b";
const ME = "user-self";
const OTHER = "user-other";

const load = (f: string) => (yaml.load(readFileSync(join(POLICIES, f), "utf8")) as any).resourcePolicy.rules as any[];
const clientRules = (rules: any[]) => rules.filter((r) => (r.derivedRoles ?? []).includes("client_website_editor"));
const codeOnly = (f: string) =>
  readFileSync(join(POLICIES, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("WSK-49c — the client-editor rules are pinned structurally", () => {
  const item = load("resource_webdesk_content_item.yaml");
  const media = load("resource_webdesk_media_asset.yaml");
  const norm = (r: any) => String(r.condition?.match?.expr ?? "").replace(/\s+/g, " ");

  it("content_item: the client rules grant exactly read/create/update/request_publish and publish, and nothing else", () => {
    const granted = clientRules(item).flatMap((r) => r.actions as string[]).sort();
    expect(granted).toEqual(["create", "publish", "read", "request_publish", "update"]);
    for (const never of ["delete", "unpublish", "schedule", "apply_schema", "*"]) expect(granted).not.toContain(never);
    for (const r of clientRules(item)) expect(r.effect).toBe("EFFECT_ALLOW");
  });
  it("media_asset: the client rule grants read/upload/update and never delete or a wildcard", () => {
    const rules = clientRules(media);
    expect(rules).toHaveLength(1);
    expect([...rules[0].actions].sort()).toEqual(["read", "update", "upload"]);
  });
  it("every client rule keeps the tenant, assurance and module tests of the staff editor tier", () => {
    for (const r of [...clientRules(item), ...clientRules(media)]) {
      const e = norm(r);
      expect(e).toContain("variables.inTenant");
      expect(e).toContain("variables.notLow");
      expect(e).toContain('request.resource.attr.module == "webdev"');
    }
  });
  it("publish for a client: approval id + a KNOWN creator, and (own && itemCount == 1) || creator != principal", () => {
    const [pub] = clientRules(item).filter((r) => r.actions.includes("publish"));
    const e = norm(pub);
    expect(e).toContain('request.resource.attr.approvalId != ""');
    expect(e).toContain('request.resource.attr.creatorId != ""');
    expect(e).toContain("request.resource.attr.creatorId == request.principal.id && has(request.resource.attr.itemCount) && request.resource.attr.itemCount == 1");
    expect(e).toContain("request.resource.attr.creatorId != request.principal.id");
  });
  it("the self-approval DENYs (every principal, `user` role) are still there and unchanged in shape", () => {
    const denies = item.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBeGreaterThanOrEqual(4);
    const selfBatch = denies.find((r) => r.actions.length === 1 && r.actions[0] === "publish" && norm(r).includes("creatorId == request.principal.id"));
    expect(selfBatch, "the publish self-approval DENY").toBeTruthy();
    expect(norm(selfBatch)).toContain("!(has(request.resource.attr.itemCount) && request.resource.attr.itemCount == 1)");
  });
  it("no variables.local in any policy, and the client rules name no other derived role and no perm_* mirror", () => {
    for (const f of ["resource_webdesk_content_item.yaml", "resource_webdesk_media_asset.yaml"]) {
      expect(codeOnly(f).includes("variables.local"), f).toBe(false);
    }
    for (const r of [...clientRules(item), ...clientRules(media)]) expect(r.derivedRoles).toEqual(["client_website_editor"]);
  });
  it("webdesk_collection (schema) has no client rule at all", () => {
    expect(clientRules(load("resource_webdesk_collection.yaml"))).toHaveLength(0);
  });
});

function principal(grants: RoleGrant[], extra: Partial<Principal> = {}): Principal {
  return { userId: ME, assurance: "high", companies: [T1], rootCompanies: [T1], roles: grants, sessionVersion: 1, ...extra };
}
const editor = (client = CA, tenant = T1): RoleGrant => ({ role: "client_website_editor", scopeType: "client", scopeId: client, scopeTenantId: tenant });
const real = (...clients: string[]) => principal([{ role: "client", scopeType: "company", scopeId: T1 }, ...clients.map((c) => editor(c))]);

const item = (extra: Partial<Resource> = {}): Resource => ({ kind: "webdesk_content_item", tenantId: T1, module: "webdev", clientId: CA, collectionKey: "service", locale: "en", ...extra });
const media = (extra: Partial<Resource> = {}): Resource => ({ kind: "webdesk_media_asset", tenantId: T1, module: "webdev", clientId: CA, ...extra });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("WSK-49c — client editors on webdesk_content_item / webdesk_media_asset (live Cerbos)", () => {
  it("a client editor on THEIR client's site: read, create, update, request_publish are allowed", async () => {
    for (const a of ["read", "create", "update", "request_publish"]) expect(await allow(real(CA), item(), a), a).toBe(true);
  });

  it("another client in the SAME tenant is denied (positive control: their own client is allowed)", async () => {
    const p = real(CA);
    for (const a of ["read", "create", "update", "request_publish"]) {
      expect(await allow(p, item(), a), `${a} own`).toBe(true);
      expect(await allow(p, item({ clientId: CB }), a), `${a} other client`).toBe(false);
    }
    for (const a of ["read", "upload", "update"]) {
      expect(await allow(p, media(), a), `media ${a} own`).toBe(true);
      expect(await allow(p, media({ clientId: CB }), a), `media ${a} other client`).toBe(false);
    }
  });

  it("another TENANT is denied: the same client id under T2, and a grant whose tenant is T2 on a T1 resource", async () => {
    const p = real(CA);
    expect(await allow(p, item(), "update")).toBe(true);
    expect(await allow(p, item({ tenantId: T2 }), "update")).toBe(false);
    expect(await allow(p, media({ tenantId: T2 }), "update")).toBe(false);
    const wrongTenantGrant = principal([editor(CA, T2)], { companies: [T1, T2] });
    expect(await allow(wrongTenantGrant, item(), "read")).toBe(false);
    expect(await allow(wrongTenantGrant, item({ tenantId: T2 }), "read")).toBe(true);
    // a client editor whose authorised company set lacks the tenant gets nothing (inTenant)
    expect(await allow(principal([editor(CA, T1)], { companies: [T2] }), item(), "read")).toBe(false);
  });

  it("an unfed resource (no clientId) and a resource with no module confer nothing", async () => {
    const p = real(CA);
    expect(await allow(p, item(), "read")).toBe(true);
    expect(await allow(p, item({ clientId: "" }), "read")).toBe(false);
    expect(await allow(p, item({ clientId: undefined }), "read")).toBe(false);
    expect(await allow(p, item({ module: "" }), "read")).toBe(false);
    expect(await allow(p, media({ clientId: undefined }), "read")).toBe(false);
    expect(await allow(p, media({ module: "hr" }), "read")).toBe(false);
  });

  it("delete, unpublish and schedule are DENIED, even on a shape the staff publisher is allowed (controls beside)", async () => {
    const p = real(CA);
    expect(await allow(p, item(), "update")).toBe(true); // control
    expect(await allow(p, item(), "delete")).toBe(false);
    expect(await allow(p, item(), "unpublish")).toBe(false);
    expect(await allow(p, item({ approvalId: "a1", creatorId: OTHER, itemCount: 1 }), "schedule")).toBe(false);
    expect(await allow(p, item({ approvalId: "a1", creatorId: ME, itemCount: 1 }), "schedule")).toBe(false);
    const staff = principal([{ role: "webdev_manager", scopeType: "company", scopeId: T1 }]);
    expect(await allow(staff, item({ approvalId: "a1", creatorId: OTHER, itemCount: 1 }), "schedule")).toBe(true); // the same resource, a staff publisher
    expect(await allow(staff, item(), "unpublish")).toBe(true);
  });

  it("nothing on the collection (schema) kind: the composition is read by the BFF under content_item:read", async () => {
    const p = real(CA);
    for (const a of ["read", "apply_schema"]) expect(await allow(p, { kind: "webdesk_collection", tenantId: T1, module: "webdev", clientId: CA }, a)).toBe(false);
  });

  it("D58: self-publish ONE item they requested is allowed; self-approve a BATCH is DENIED; another editor's batch is allowed", async () => {
    const p = real(CA);
    const pub = (extra: Partial<Resource>) => item({ approvalId: "appr-1", ...extra });
    expect(await allow(p, pub({ creatorId: ME, itemCount: 1 }), "publish")).toBe(true); // single, own
    expect(await allow(p, pub({ creatorId: ME, itemCount: 2 }), "publish")).toBe(false); // batch, own: DENIED
    expect(await allow(p, pub({ creatorId: ME, itemCount: 5 }), "publish")).toBe(false);
    expect(await allow(p, pub({ creatorId: ME }), "publish")).toBe(false); // itemCount omitted -> 0 -> two-person rule
    expect(await allow(p, pub({ creatorId: OTHER, itemCount: 5 }), "publish")).toBe(true); // another editor's batch
    expect(await allow(p, pub({ creatorId: OTHER, itemCount: 1 }), "publish")).toBe(true);
  });

  it("publish is HIGH for a client too: no approval id, or an unknown creator, is denied whoever the creator is", async () => {
    const p = real(CA);
    expect(await allow(p, item({ approvalId: "appr-1", creatorId: OTHER, itemCount: 5 }), "publish")).toBe(true); // control
    expect(await allow(p, item({ creatorId: OTHER, itemCount: 5 }), "publish")).toBe(false);
    expect(await allow(p, item({ approvalId: "appr-1", itemCount: 5 }), "publish")).toBe(false);
    expect(await allow(p, item({ creatorId: ME, itemCount: 1 }), "publish")).toBe(false);
  });

  it("publish for ANOTHER client's site is denied even with a valid approval (positive control on the right client)", async () => {
    const p = real(CA);
    const shape = { approvalId: "appr-1", creatorId: ME, itemCount: 1 };
    expect(await allow(p, item(shape), "publish")).toBe(true);
    expect(await allow(p, item({ ...shape, clientId: CB }), "publish")).toBe(false);
    expect(await allow(p, item({ ...shape, tenantId: T2 }), "publish")).toBe(false);
  });

  it("media: read, upload and update are allowed for their client; DELETE is denied", async () => {
    const p = real(CA);
    for (const a of ["read", "upload", "update"]) expect(await allow(p, media(), a), a).toBe(true);
    expect(await allow(p, media(), "delete")).toBe(false);
    const staffAdmin = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }]);
    expect(await allow(staffAdmin, media(), "delete")).toBe(true); // the same resource: staff may
  });

  it("a low-assurance session, a plain `client` contact with no website grant, and a client ADMIN with no grant get nothing", async () => {
    expect(await allow(principal([editor(CA)], { assurance: "low" }), item(), "read")).toBe(false);
    expect(await allow(principal([{ role: "client", scopeType: "company", scopeId: T1 }]), item(), "read")).toBe(false);
    expect(await allow(principal([{ role: "client", scopeType: "company", scopeId: T1 }], { clientAdminOf: [{ tenantId: T1, clientId: CA }] }), item(), "read")).toBe(false);
  });

  it("an editor of A and B reaches each, never a third; the grant at company scope or under another role name is refused", async () => {
    const two = real(CA, CB);
    expect(await allow(two, item({ clientId: CA }), "read")).toBe(true);
    expect(await allow(two, item({ clientId: CB }), "read")).toBe(true);
    expect(await allow(two, item({ clientId: "cccccccc-0000-0000-0000-00000000000c" }), "read")).toBe(false);
    expect(await allow(principal([{ role: "client_website_editor", scopeType: "company", scopeId: CA, scopeTenantId: T1 }]), item(), "read")).toBe(false);
    expect(await allow(principal([{ role: "company_admin", scopeType: "client", scopeId: CA, scopeTenantId: T1 }]), item(), "read")).toBe(false);
  });

  it("an automation principal holding the grant may edit but never publish (the T7 DENY by kind still bites)", async () => {
    const bot = principal([editor(CA)], { kind: "automation" });
    expect(await allow(bot, item(), "update")).toBe(true);
    expect(await allow(bot, item({ approvalId: "appr-1", creatorId: OTHER, itemCount: 5 }), "publish")).toBe(false);
  });

  it("the staff tiers are unchanged: webdev_staff edits but never publishes/deletes; webdev_manager keeps R4 and maker != checker", async () => {
    const staffEditor = principal([{ role: "webdev_staff", scopeType: "company", scopeId: T1 }]);
    const manager = principal([{ role: "webdev_manager", scopeType: "company", scopeId: T1 }]);
    expect(await allow(staffEditor, item(), "update")).toBe(true);
    expect(await allow(staffEditor, item(), "delete")).toBe(false);
    expect(await allow(manager, item({ approvalId: "a1", creatorId: OTHER, itemCount: 5 }), "publish")).toBe(true);
    expect(await allow(manager, item({ approvalId: "a1", creatorId: ME, itemCount: 2 }), "publish")).toBe(false);
    expect(await allow(manager, item({ approvalId: "a1", creatorId: ME, itemCount: 1 }), "publish")).toBe(true);
  });
});
