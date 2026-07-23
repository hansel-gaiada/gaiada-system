import { describe, it, expect } from "vitest";
import { providerLabel, findConnection, type ConnectionRow } from "./connections";

function row(over: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "c1", tenantId: "t1", ownerKind: "user", ownerId: "u1", provider: "github",
    externalAccount: null, scopes: [], status: "unconfigured", hasToken: false, hasRefreshToken: false,
    tokenExpiresAt: null, tokenKeyVersion: null, meta: {}, createdBy: "u1", originSite: "central",
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("providerLabel", () => {
  it("maps every provider to its display label", () => {
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("google_drive")).toBe("Google Drive");
    expect(providerLabel("claude")).toBe("Claude");
  });
});

describe("findConnection", () => {
  it("finds the live row for a provider", () => {
    const rows = [row({ id: "c1", provider: "github" }), row({ id: "c2", provider: "claude", status: "linked" })];
    expect(findConnection(rows, "github")?.id).toBe("c1");
    expect(findConnection(rows, "claude")?.id).toBe("c2");
  });
  it("excludes a soft-revoked row — treated the same as never connected", () => {
    const rows = [row({ id: "c1", provider: "github", status: "revoked" })];
    expect(findConnection(rows, "github")).toBeUndefined();
  });
  it("undefined when no row exists for that provider", () => {
    expect(findConnection([], "google_drive")).toBeUndefined();
  });
});
