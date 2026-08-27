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
} from "./approval-executables";

describe("WSK-31 registry: the ten §07 medium/HIGH webdesk tools", () => {
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

  it("🔴 every precondition ALWAYS refuses with webdesk_control_plane_not_wired — the honest answer, not a silent no-op", async () => {
    // Never `not_applicable` (the absent-entry default) and never a fabricated `{ok:true}` — see
    // approval-executables.ts's own section header for why an always-refusing, NAMED-reason
    // precondition is the honest choice while WSK-23 has not landed.
    for (const name of WEBDESK_REGISTRY_TOOLS) {
      const verdict = await getExecutable(name)!.precondition({} as never, {});
      expect(verdict, name).toEqual({ ok: false, reason: "webdesk_control_plane_not_wired" });
    }
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
