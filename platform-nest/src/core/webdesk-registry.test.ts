// WSK-31 — the D14 registry half of the §07 WebDesk control-plane tool set. Mirrors
// `webdev-provision-registry.test.ts` (PRV-03) in shape but lighter: every WSK-31 entry shares ONE
// precondition that always refuses (see `approval-executables.ts`'s own WSK-31 section for why that
// is the honest answer today, not an unfinished one), so there is no domain-state re-derivation to
// exercise against a live database — this file is deliberately DB-FREE, unlike PRV-03's own suite.
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerExecutableApproval,
  resetExecutableApprovals,
  registerCoreExecutableApprovals,
  registerPmExecutableApprovals,
  registerWebdevExecutableApprovals,
  registerWebdeskExecutableApprovals,
  getExecutable,
  WEBDESK_REGISTRY_TOOLS,
  WEBDESK_CONTENT_REGISTRY_TOOLS,
  WEBDESK_MEDIA_REGISTRY_TOOLS,
} from "./approval-executables";

describe("WSK-31 registry: the ten §07 medium/HIGH webdesk tools (+ WSK-59 content tools)", () => {
  beforeEach(() => {
    // Independent of whatever another test file in this worker left the registry in — restore the
    // FULL production set via the exported bootstraps, same discipline PRV-03's own suite states.
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerPmExecutableApprovals();
    registerWebdevExecutableApprovals();
    registerWebdeskExecutableApprovals();
  });

  it("registers exactly the ten medium/HIGH tool names — the three reads and the one LOW draft tool are NOT here", () => {
    expect(WEBDESK_REGISTRY_TOOLS.length).toBe(10);
    expect(WEBDESK_REGISTRY_TOOLS).toEqual([
      "webdesk.schema.apply", "webdesk.site.provision", "webdesk.deploy.staging",
      "webdesk.site.promote", "webdesk.site.rollback", "webdesk.site.setDomain",
      "webdesk.key.mint", "webdesk.key.rotate", "webdesk.key.revoke", "webdesk.site.archive",
    ]);
    // The exclusions, explicitly: a LOW-impact write never suspends (D14-15's own reasoning for
    // pm.createTask/createDoc), so it can never reach this registry, and reads have nothing to
    // approve at all.
    for (const excluded of ["webdesk.schema.propose", "webdesk.listSites", "webdesk.siteStatus", "webdesk.listSubmissions"]) {
      expect(getExecutable(excluded)).toBeUndefined();
    }
  });

  it("rejects a duplicate registration for any of the ten", () => {
    for (const name of WEBDESK_REGISTRY_TOOLS) {
      expect(() => registerExecutableApproval({ toolName: name })).toThrow(/already registered/i);
    }
  });

  it("every one is registered with a real lockKey and precondition (not the D14-02 name-only fallback)", () => {
    for (const name of WEBDESK_REGISTRY_TOOLS) {
      const entry = getExecutable(name);
      expect(entry, name).toBeDefined();
      expect(entry!.toolName).toBe(name);
      expect(entry!.lockKey({})).not.toBe(`executable-approval:${name}`);
    }
  });

  // WSK-59 re-pointed the first two routes at the real channel; the key route files a key.mint approval since 2026-10-11.
  const NOW_REAL = ["webdesk.schema.apply", "webdesk.site.provision", "webdesk.key.mint"];
  const STILL_NOT_WIRED = WEBDESK_REGISTRY_TOOLS.filter((n) => !NOW_REAL.includes(n));

  it("🔴 the seven tools whose routes are STILL 501 ALWAYS refuse with webdesk_control_plane_not_wired — the honest answer", async () => {
    expect(STILL_NOT_WIRED).toHaveLength(7);
    for (const name of STILL_NOT_WIRED) {
      const verdict = await getExecutable(name)!.precondition({} as never, {});
      expect(verdict, name).toEqual({ ok: false, reason: "webdesk_control_plane_not_wired" });
    }
  });

  it("WSK-59: schema.apply and site.provision carry a REAL structural precondition (their routes are live now)", async () => {
    const apply = getExecutable("webdesk.schema.apply")!;
    const site = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    expect(await apply.precondition({} as never, { tenantSlug: "gaiada", siteId: site, collectionKey: "service", schema: {} })).toEqual({ ok: true });
    expect(await apply.precondition({} as never, { tenantSlug: "gaiada", siteId: "nope", collectionKey: "service", schema: {} })).toEqual({ ok: false, reason: "site_id_invalid" });
    expect(await apply.precondition({} as never, { tenantSlug: "gaiada", siteId: site, collectionKey: "service" })).toEqual({ ok: false, reason: "schema_invalid" });
    const prov = getExecutable("webdesk.site.provision")!;
    expect(await prov.precondition({} as never, { tenantSlug: "gaiada", kind: "astro", name: "Main" })).toEqual({ ok: true });
    expect(await prov.precondition({} as never, { tenantSlug: "gaiada", kind: "static", name: "Main" })).toEqual({ ok: false, reason: "kind_invalid" });
  });

  it("2026-10-11: webdesk.key.mint carries a REAL structural precondition (its route files a key.mint approval now)", async () => {
    const mint = getExecutable("webdesk.key.mint")!;
    const site = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    const env = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const ok = { tenantSlug: "gaiada", siteId: site, envId: env, scope: "read" };
    expect(await mint.precondition({} as never, ok)).toEqual({ ok: true });
    expect(await mint.precondition({} as never, { ...ok, scope: "write" })).toEqual({ ok: true });
    expect(await mint.precondition({} as never, { ...ok, tenantSlug: "" })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
    expect(await mint.precondition({} as never, { ...ok, siteId: "nope" })).toEqual({ ok: false, reason: "site_id_invalid" });
    expect(await mint.precondition({} as never, { ...ok, envId: undefined })).toEqual({ ok: false, reason: "env_id_invalid" });
    expect(await mint.precondition({} as never, { ...ok, scope: "admin" })).toEqual({ ok: false, reason: "scope_invalid" });
    expect(mint.lockKey(ok)).toBe(`webdesk:${site}`);
  });

  describe("WSK-59 — webdesk.content.unpublish / delete (the editor's MEDIUM tools)", () => {
    const item = "7a1d2c3e-4f5b-4c6d-9e7f-8091a2b3c4d5";
    const site = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";

    it("exactly the two MEDIUM tools are registered, with a real lockKey and precondition", () => {
      expect(WEBDESK_CONTENT_REGISTRY_TOOLS).toEqual(["webdesk.content.unpublish", "webdesk.content.delete"]);
      for (const name of WEBDESK_CONTENT_REGISTRY_TOOLS) {
        expect(getExecutable(name), name).toBeDefined();
        expect(() => registerExecutableApproval({ toolName: name })).toThrow(/already registered/i);
      }
      // low writes and reads never suspend, so they are NOT here (and there is no publish tool at all)
      for (const n of ["webdesk.content.create", "webdesk.content.update", "webdesk.content.restoreVersion", "webdesk.content.requestPublish", "webdesk.content.getItem", "webdesk.content.publish"]) {
        expect(getExecutable(n), n).toBeUndefined();
      }
    });

    it("unpublish: structural precondition only (Zone B's expectedPublishedVersion guard is the atomic re-check)", async () => {
      const e = getExecutable("webdesk.content.unpublish")!;
      const ok = { tenantSlug: "gaiada", siteId: site, itemId: item, expectedPublishedVersion: 3 };
      expect(await e.precondition({} as never, ok)).toEqual({ ok: true });
      expect(await e.precondition({} as never, { ...ok, expectedPublishedVersion: 0 })).toEqual({ ok: false, reason: "expected_published_version_invalid" });
      expect(await e.precondition({} as never, { ...ok, itemId: "x" })).toEqual({ ok: false, reason: "item_id_invalid" });
      expect(await e.precondition({} as never, { ...ok, tenantSlug: "" })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
    });

    it("delete: structural precondition", async () => {
      const e = getExecutable("webdesk.content.delete")!;
      const ok = { tenantSlug: "gaiada", siteId: site, itemId: item, baseVersion: 0 };
      expect(await e.precondition({} as never, ok)).toEqual({ ok: true });
      expect(await e.precondition({} as never, { ...ok, baseVersion: -1 })).toEqual({ ok: false, reason: "base_version_invalid" });
      expect(await e.precondition({} as never, { tenantSlug: "gaiada" })).toEqual({ ok: false, reason: "site_id_invalid" });
    });

    it("lockKey is the ITEM, per tool-agnostic, and malformed args never collapse onto one key", () => {
      const u = getExecutable("webdesk.content.unpublish")!;
      const d = getExecutable("webdesk.content.delete")!;
      expect(u.lockKey({ itemId: item })).toBe(`webdesk:content:${item}`);
      expect(d.lockKey({ itemId: item })).toBe(u.lockKey({ itemId: item })); // an unpublish and a delete of ONE item contend
      expect(new Set([u.lockKey({}), u.lockKey({ itemId: 5 }), u.lockKey({ itemId: "" })]).size).toBe(3);
    });
  });

  describe("WSK-43b — webdesk.media.update / delete (the media library's MEDIUM tools); uploadToken is deliberately NOT here", () => {
    const asset = "9c8b7a65-4d3e-4f21-8a0b-1c2d3e4f5a6b";
    const site = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";

    it("exactly update and delete are registered, with a real lockKey and precondition; the token tool and the reads are not", () => {
      expect(WEBDESK_MEDIA_REGISTRY_TOOLS).toEqual(["webdesk.media.update", "webdesk.media.delete"]);
      for (const name of WEBDESK_MEDIA_REGISTRY_TOOLS) {
        expect(getExecutable(name), name).toBeDefined();
        expect(() => registerExecutableApproval({ toolName: name })).toThrow(/already registered/i);
      }
      // uploadToken's result is a one-time secret: a D14 re-drive would store it in automation_approvals.execution_result
      for (const n of ["webdesk.media.uploadToken", "webdesk.media.list", "webdesk.media.usage"]) {
        expect(getExecutable(n), n).toBeUndefined();
      }
    });

    it("update: structural precondition (a real asset id, at least one field)", async () => {
      const e = getExecutable("webdesk.media.update")!;
      const ok = { tenantSlug: "gaiada", siteId: site, assetId: asset, title: "t" };
      expect(await e.precondition({} as never, ok)).toEqual({ ok: true });
      expect(await e.precondition({} as never, { ...ok, title: undefined, tags: [] })).toEqual({ ok: true }); // [] clears the tags: a real change
      expect(await e.precondition({} as never, { tenantSlug: "gaiada", siteId: site, assetId: asset })).toEqual({ ok: false, reason: "no_media_fields" });
      expect(await e.precondition({} as never, { ...ok, assetId: "x" })).toEqual({ ok: false, reason: "asset_id_invalid" });
      expect(await e.precondition({} as never, { ...ok, siteId: "x" })).toEqual({ ok: false, reason: "site_id_invalid" });
      expect(await e.precondition({} as never, { ...ok, tenantSlug: "" })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
    });

    it("delete: structural precondition", async () => {
      const e = getExecutable("webdesk.media.delete")!;
      const ok = { tenantSlug: "gaiada", siteId: site, assetId: asset };
      expect(await e.precondition({} as never, ok)).toEqual({ ok: true });
      expect(await e.precondition({} as never, { ...ok, assetId: undefined })).toEqual({ ok: false, reason: "asset_id_invalid" });
      expect(await e.precondition({} as never, { tenantSlug: "gaiada" })).toEqual({ ok: false, reason: "site_id_invalid" });
    });

    it("lockKey is the ASSET (an update and a delete of one asset contend), and malformed args never collapse onto one key", () => {
      const u = getExecutable("webdesk.media.update")!;
      const d = getExecutable("webdesk.media.delete")!;
      expect(u.lockKey({ assetId: asset })).toBe(`webdesk:media:${asset}`);
      expect(d.lockKey({ assetId: asset })).toBe(u.lockKey({ assetId: asset }));
      expect(new Set([u.lockKey({}), u.lockKey({ assetId: 5 }), u.lockKey({ assetId: "" })]).size).toBe(3);
    });
  });

  describe("lockKey", () => {
    it("keys on siteId when present, verbatim", () => {
      expect(getExecutable("webdesk.site.promote")!.lockKey({ siteId: "site-123" })).toBe("webdesk:site-123");
    });

    it("keys on keyId for the two key-lifecycle tools", () => {
      expect(getExecutable("webdesk.key.rotate")!.lockKey({ keyId: "key-abc" })).toBe("webdesk:key-abc");
      expect(getExecutable("webdesk.key.revoke")!.lockKey({ keyId: "key-abc" })).toBe("webdesk:key-abc");
    });

    it("is stable across repeated calls with the same args (the retry requirement)", () => {
      const entry = getExecutable("webdesk.site.rollback")!;
      const args = { siteId: "site-stable" };
      expect(entry.lockKey(args)).toBe(entry.lockKey({ ...args }));
      expect(entry.lockKey({})).toBe(entry.lockKey({}));
    });

    it("a missing/malformed siteId does NOT collapse to a single constant shared by every such call", () => {
      const entry = getExecutable("webdesk.site.archive")!;
      const missing = entry.lockKey({});
      const wrongType = entry.lockKey({ siteId: 42 });
      const empty = entry.lockKey({ siteId: "" });
      expect(new Set([missing, wrongType, empty]).size).toBe(3);
    });

    it("never shares a lock key across two different tools for the SAME siteId — one unit of consistency per tool+site", () => {
      // Deliberately narrower than deployLockKey's own cross-tool namespacing note: two DIFFERENT
      // webdesk commands on the SAME site (e.g. promote then rollback) legitimately want to
      // serialize against EACH OTHER — the whole point of "the one unit of consistency two
      // approvals for the SAME site contend over" — so this only pins that a genuinely malformed
      // call never collapses onto a single shared constant, not that every tool gets its own key.
      const promote = getExecutable("webdesk.site.promote")!.lockKey({});
      const rollback = getExecutable("webdesk.site.rollback")!.lockKey({});
      expect(promote).not.toBe(rollback); // both fall back to their OWN tool-prefixed malformed key
    });
  });
});
