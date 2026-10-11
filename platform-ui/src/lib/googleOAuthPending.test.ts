// B0 — the Google OAuth callback's return path (searchMarketingShared.ts `parseGoogleOAuthPending`,
// consumed by app/api/search/google/callback/route.ts). It used to be checked with a bare
// `startsWith("/")`, so `//evil.example` passed and `new URL(returnPath, origin)` left the site.
import { describe, it, expect } from "vitest";
import { parseGoogleOAuthPending } from "./searchMarketingShared";

const pending = (returnPath: unknown, provider: unknown = "google_search_console") =>
  parseGoogleOAuthPending(JSON.stringify({ provider, returnPath }));

describe("parseGoogleOAuthPending", () => {
  it("keeps an ordinary same-site return path, query included", () => {
    expect(pending("/departments/seo?tab=connections")).toEqual({
      provider: "google_search_console",
      returnPath: "/departments/seo?tab=connections",
    });
  });

  it("refuses every off-site form, falling back to / (the flow itself still completes)", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "/%2F%2Fevil",
      "/%2f%2fevil.example",
      "///evil.example",
      "https://evil.example",
      "\\\\evil.example",
      "/%5Cevil.example",
      "javascript:alert(1)",
    ]) {
      const p = pending(bad);
      expect(p?.returnPath, bad).toBe("/");
      // The same check the callback route makes: resolving against our origin must stay on it.
      expect(new URL(p!.returnPath, "https://erp.gaiada.com").origin, bad).toBe("https://erp.gaiada.com");
    }
  });

  it("is null for a missing or malformed cookie, or an unknown provider — never guessed at", () => {
    expect(parseGoogleOAuthPending(undefined)).toBeNull();
    expect(parseGoogleOAuthPending("")).toBeNull();
    expect(parseGoogleOAuthPending("{not json")).toBeNull();
    expect(pending("/x", "google_drive")).toBeNull();
    expect(pending(42)).toBeNull();
  });
});
