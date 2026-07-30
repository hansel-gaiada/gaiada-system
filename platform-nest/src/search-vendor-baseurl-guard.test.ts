// SM-49 AC 9 (tracker §6u; design addendum §A10.4) — unit tests for the pure lexical predicate + the
// assertion main.ts's live branch calls, plus a static pin proving main.ts actually wires it in (the
// "delete the guard ⇒ a test goes red" mutation probe the ticket's Done-when clause asks for: deleting
// EITHER the predicate's own enforcement below OR the call site in main.ts turns a test in this file
// red, without needing to boot the whole Nest app).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import {
  checkPrivateVendorBaseUrl,
  assertLiveVendorBaseUrlsAreNotPrivate,
  PrivateVendorBaseUrlError,
  SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV,
} from "./search-vendor-baseurl-guard";

describe("SM-49 AC 9 — checkPrivateVendorBaseUrl (pure lexical predicate)", () => {
  it("does NOT flag the three real default vendor base URLs — the guard must never break an unconfigured live boot", () => {
    expect(checkPrivateVendorBaseUrl(config.search.dataforseo.baseUrl).isPrivate).toBe(false);
    expect(checkPrivateVendorBaseUrl(config.search.semrush.baseUrl).isPrivate).toBe(false);
    expect(checkPrivateVendorBaseUrl(config.search.ahrefs.baseUrl).isPrivate).toBe(false);
    // Also pin the literal defaults directly, independent of whatever config.ts currently resolves,
    // so a change to those defaults doesn't silently stop testing the guard against real hostnames.
    expect(checkPrivateVendorBaseUrl("https://api.dataforseo.com").isPrivate).toBe(false);
    expect(checkPrivateVendorBaseUrl("https://api.semrush.com").isPrivate).toBe(false);
    expect(checkPrivateVendorBaseUrl("https://api.ahrefs.com/v3").isPrivate).toBe(false);
  });

  it("flags loopback hostnames and IPv4 literals", () => {
    expect(checkPrivateVendorBaseUrl("http://localhost:8080").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://127.0.0.1:8080").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://127.255.255.255").isPrivate).toBe(true);
  });

  it("flags RFC1918 private IPv4 ranges, respecting the 172.16-172.31 boundary exactly", () => {
    expect(checkPrivateVendorBaseUrl("http://10.0.0.5").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://192.168.1.1").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://172.16.0.0").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://172.31.255.255").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://172.32.0.0").isPrivate).toBe(false);
    expect(checkPrivateVendorBaseUrl("http://172.15.255.255").isPrivate).toBe(false);
  });

  it("flags link-local and unspecified IPv4 literals", () => {
    expect(checkPrivateVendorBaseUrl("http://169.254.1.1").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://0.0.0.0").isPrivate).toBe(true);
  });

  it("flags IPv6 loopback/link-local/unique-local literals, never a public IPv6 literal by shape alone", () => {
    expect(checkPrivateVendorBaseUrl("http://[::1]:8080").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://[fe80::1]").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://[fd12:3456::1]").isPrivate).toBe(true);
    // A real public IPv6 literal is out of this lexical check's declared scope (see the file header)
    // — not flagged, which is an honest limitation, not a bug.
    expect(checkPrivateVendorBaseUrl("http://[2001:4860:4860::8888]").isPrivate).toBe(false);
  });

  it("flags the reserved/private-suffix hostnames named in the AC", () => {
    for (const suffix of ["local", "localhost", "internal", "test", "lan", "home.arpa"]) {
      expect(checkPrivateVendorBaseUrl(`http://myvendor.${suffix}`).isPrivate, suffix).toBe(true);
    }
    // Bare suffix hostnames too (no leading label).
    expect(checkPrivateVendorBaseUrl("http://localhost.").isPrivate).toBe(true);
  });

  it("does NOT flag a suffix appearing mid-hostname, only a true trailing match", () => {
    // "foo.local.example.com" ENDS with ".com", not ".local" — must not misfire on a substring.
    expect(checkPrivateVendorBaseUrl("http://foo.local.example.com").isPrivate).toBe(false);
  });

  it("flags a single-label hostname (the shape of a Docker/K8s service name)", () => {
    expect(checkPrivateVendorBaseUrl("http://semrush-proxy").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("http://mockserver:1080").isPrivate).toBe(true);
  });

  it("does NOT misfire on a real domain that merely starts with letters resembling an IPv6 prefix", () => {
    // "fc-vendor.example.com" must never be treated as an IPv6 literal — it contains no ':'.
    expect(checkPrivateVendorBaseUrl("http://fc-vendor.example.com").isPrivate).toBe(false);
  });

  it("flags an unparseable URL", () => {
    expect(checkPrivateVendorBaseUrl("not a url").isPrivate).toBe(true);
    expect(checkPrivateVendorBaseUrl("").isPrivate).toBe(true);
  });
});

describe("SM-49 AC 9 — assertLiveVendorBaseUrlsAreNotPrivate (what main.ts's live branch actually calls)", () => {
  const publicUrls = { dataforseo: "https://api.dataforseo.com", semrush: "https://api.semrush.com", ahrefs: "https://api.ahrefs.com/v3" };

  it("does not throw when every base URL is public and override is off", () => {
    expect(() => assertLiveVendorBaseUrlsAreNotPrivate(publicUrls, false)).not.toThrow();
  });

  it("throws PrivateVendorBaseUrlError naming the vendor, host, and the override, when ANY base URL is private", () => {
    const withPrivateSemrush = { ...publicUrls, semrush: "http://127.0.0.1:9999" };
    let caught: unknown;
    try {
      assertLiveVendorBaseUrlsAreNotPrivate(withPrivateSemrush, false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrivateVendorBaseUrlError);
    const err = caught as InstanceType<typeof PrivateVendorBaseUrlError>;
    expect(err.vendor).toBe("semrush");
    expect(err.message).toContain("semrush");
    expect(err.message).toContain("127.0.0.1:9999");
    expect(err.message).toContain(SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV);
  });

  it("checks all three vendors independently — a private dataforseo/ahrefs base URL is caught too", () => {
    expect(() => assertLiveVendorBaseUrlsAreNotPrivate({ ...publicUrls, dataforseo: "http://localhost:1080" }, false)).toThrow(PrivateVendorBaseUrlError);
    expect(() => assertLiveVendorBaseUrlsAreNotPrivate({ ...publicUrls, ahrefs: "http://ahrefs-mock" }, false)).toThrow(PrivateVendorBaseUrlError);
  });

  // ── THE MUTATION PROBE (Done-when: "delete the guard ⇒ a test goes red") ─────────────────────────
  it("MUTATION PROBE: the override flag actually suppresses the check — proves the conditional branch is live code, not dead", () => {
    const withPrivateAll = { dataforseo: "http://127.0.0.1", semrush: "http://127.0.0.1", ahrefs: "http://127.0.0.1" };
    expect(() => assertLiveVendorBaseUrlsAreNotPrivate(withPrivateAll, true)).not.toThrow();
    expect(() => assertLiveVendorBaseUrlsAreNotPrivate(withPrivateAll, false)).toThrow(PrivateVendorBaseUrlError);
  });

  it("MUTATION PROBE: main.ts's live branch actually calls assertLiveVendorBaseUrlsAreNotPrivate before any vendor factory — "
    + "a static pin so deleting the CALL SITE in main.ts (not just this predicate) also fails a test", () => {
    const mainTs = readFileSync(join(__dirname, "main.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(mainTs).toContain("import { assertLiveVendorBaseUrlsAreNotPrivate");
    expect(mainTs).toContain("assertLiveVendorBaseUrlsAreNotPrivate(");
    // The call must appear textually BEFORE the first vendor factory call in the live branch, else
    // it isn't actually guarding anything.
    const guardIdx = mainTs.indexOf("assertLiveVendorBaseUrlsAreNotPrivate(\n      {");
    const dfsFactoryIdx = mainTs.indexOf("createDataForSeoProviderFromConfig();");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(dfsFactoryIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(dfsFactoryIdx);
  });
});
