// SM-51 — the §A10.4 private-endpoint boot guard, EXTENDED to the Google seams (§A12.3), plus the
// static pin that main.ts actually calls it.
//
// THE PIN IS THE POINT. A guard that is correct but never invoked changes nothing observable — the exact
// pattern this module has met repeatedly (SM-49's equivalent pin on the vendor base-URL guard caught two
// real bugs). So the last test here reads main.ts and asserts the call site exists inside the LIVE
// branch: deleting that one line must turn this file red.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "../../../config";
import {
  ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV,
  assertLiveGoogleEndpointsAreNotPrivate,
  googleEndpointSeamsFromConfig,
  PrivateGoogleEndpointError,
  type GoogleEndpointSeams,
} from "./endpoint-guard";

const REAL_GOOGLE: GoogleEndpointSeams = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  searchConsoleBaseUrl: "https://searchconsole.googleapis.com",
  analyticsDataBaseUrl: "https://analyticsdata.googleapis.com",
  adsBaseUrl: "https://googleads.googleapis.com",
};

describe("SM-51 · the Google endpoint boot guard (design addendum §A12.3, extending §A10.4)", () => {
  it("the REAL Google endpoints pass — a guard that rejected them would just push operators to the override", () => {
    expect(() => assertLiveGoogleEndpointsAreNotPrivate(REAL_GOOGLE, false)).not.toThrow();
  });

  it("the shipped DEFAULTS pass, so a fresh deployment boots without the override", () => {
    // Reads the live config, so a future edit that changed a default to something private is caught
    // here rather than at someone's first boot.
    expect(() => assertLiveGoogleEndpointsAreNotPrivate(googleEndpointSeamsFromConfig(), false)).not.toThrow();
  });

  it.each([
    ["authorizeUrl", "http://127.0.0.1:8080/realms/gaiada/protocol/openid-connect/auth"],
    ["tokenUrl", "http://localhost:8080/realms/gaiada/protocol/openid-connect/token"],
    ["revokeUrl", "http://keycloak:8080/realms/gaiada/protocol/openid-connect/revoke"],
    ["searchConsoleBaseUrl", "http://10.0.0.5:9999"],
    ["analyticsDataBaseUrl", "http://gsc-mock.local"],
    ["adsBaseUrl", "http://[::1]:9000"],
  ])("REFUSES a private/loopback/internal '%s' in live mode", (seam, url) => {
    const seams = { ...REAL_GOOGLE, [seam]: url } as GoogleEndpointSeams;
    expect(() => assertLiveGoogleEndpointsAreNotPrivate(seams, false)).toThrow(PrivateGoogleEndpointError);
    // The refusal must NAME the seam and the host, or an operator cannot act on it.
    try {
      assertLiveGoogleEndpointsAreNotPrivate(seams, false);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(seam);
      expect(msg).toContain(url);
      expect(msg).toContain(ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV);
    }
  });

  it("names the real hazard, not a generic one: vault rows minted from a non-Google issuer", () => {
    // The message is the only thing a 3am operator reads. It must say WHY this is refused.
    try {
      assertLiveGoogleEndpointsAreNotPrivate({ ...REAL_GOOGLE, tokenUrl: "http://localhost:8080/token" }, false);
      throw new Error("expected a refusal");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/credential-vault|linked/i);
      // And it states its own limit honestly — a lexical check is not an authz control.
      expect(msg).toMatch(/ACCIDENT guard/);
      expect(msg).toMatch(/no DNS resolution/);
    }
  });

  it("an unparseable endpoint is refused too (a value that is not even a URL is unfit for live)", () => {
    expect(() => assertLiveGoogleEndpointsAreNotPrivate({ ...REAL_GOOGLE, tokenUrl: "not a url" }, false)).toThrow(
      PrivateGoogleEndpointError,
    );
  });

  it("the documented override releases it — for a genuine proxy/tunnel or deliberate local work", () => {
    const seams = { ...REAL_GOOGLE, tokenUrl: "http://localhost:8080/token" };
    expect(() => assertLiveGoogleEndpointsAreNotPrivate(seams, true)).not.toThrow();
  });

  it("the override is SEPARATE from the vendor one — two different risks, two different switches", () => {
    // Deciding that a private DataForSEO base URL is acceptable is NOT deciding that client OAuth
    // credentials may be issued by a non-Google issuer. Pinned so the two are never merged for tidiness.
    expect(ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV).toBe("SEARCH_ALLOW_PRIVATE_GOOGLE_ENDPOINT");
    expect(ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV).not.toBe("SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL");
  });

  it("REGISTRATION PIN · main.ts's LIVE branch actually calls the guard (delete the call ⇒ this goes red)", () => {
    const mainTs = readFileSync(join(__dirname, "..", "..", "..", "main.ts"), "utf8");
    expect(mainTs).toContain("assertLiveGoogleEndpointsAreNotPrivate(");
    expect(mainTs).toContain("googleEndpointSeamsFromConfig()");
    expect(mainTs).toContain("ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV");

    // Anchored to the LIVE branch, not merely to the file: the guard is meaningless in the simulate
    // branch (which registers no live factory and holds no real credential), and §A10.4 rules simulate
    // mode untouched. `else {` opens the live branch in main.ts's mode switch.
    const liveBranchStart = mainTs.indexOf("} else {");
    expect(liveBranchStart).toBeGreaterThan(0);
    const liveBranch = mainTs.slice(liveBranchStart);
    expect(liveBranch).toContain("assertLiveGoogleEndpointsAreNotPrivate(");
    // And it runs BEFORE any vendor factory call, like its SM-49 sibling — a guard that fires after the
    // thing it guards has already been constructed is decoration.
    expect(liveBranch.indexOf("assertLiveGoogleEndpointsAreNotPrivate(")).toBeLessThan(
      liveBranch.indexOf("createDataForSeoProviderFromConfig()"),
    );
  });

  it("config exposes the six seams the guard checks — a seventh added later must be added here too", () => {
    const seams = googleEndpointSeamsFromConfig();
    expect(Object.keys(seams).sort()).toEqual(
      ["adsBaseUrl", "analyticsDataBaseUrl", "authorizeUrl", "revokeUrl", "searchConsoleBaseUrl", "tokenUrl"].sort(),
    );
    // Sanity that it reads the real config object rather than a copy that could drift.
    expect(seams.tokenUrl).toBe(config.search.google.tokenUrl);
  });
});
