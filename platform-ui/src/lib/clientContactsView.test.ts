import { describe, it, expect } from "vitest";
import { CAPABILITY_LABEL, canCountersign, type ClientContact } from "./clientContactsView";

const c = (capability: ClientContact["capability"], status: ClientContact["status"] = "active"): ClientContact => ({
  id: "c", clientId: "cl", userId: "u", projectId: null, capability, status, email: "a@x.test", name: null,
  invitedAt: "2026-01-01T00:00:00Z", activatedAt: null, hasAccount: true,
});

describe("canCountersign (WSK-49f: admin implies signer)", () => {
  it("an active signer and an active admin may countersign; a viewer may not", () => {
    expect(canCountersign(c("signer"))).toBe(true);
    expect(canCountersign(c("admin"))).toBe(true);
    expect(canCountersign(c("viewer"))).toBe(false);
  });
  it("never from an account that was not activated or has been revoked", () => {
    expect(canCountersign(c("admin", "invited"))).toBe(false);
    expect(canCountersign(c("admin", "revoked"))).toBe(false);
  });
  it("every capability has a label", () => {
    expect(CAPABILITY_LABEL.admin).toMatch(/admin/i);
  });
});
