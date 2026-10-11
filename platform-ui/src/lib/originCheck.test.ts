// B0 — the CSRF origin decision (lib/originCheck.ts). Pure; the proxy wiring is in proxy.test.ts.
import { describe, it, expect } from "vitest";
import { allowedOrigins, isOriginAllowed, normalizeOrigin, requestOwnOrigin, ORIGIN_CHECK_EXEMPT_PATHS } from "./originCheck";

const ERP = "https://erp.gaiada.com";
const allowed = [ERP];
const check = (o: { method?: string; origin?: string | null; site?: string | null }) =>
  isOriginAllowed({ method: o.method ?? "POST", origin: o.origin ?? null, secFetchSite: o.site ?? null, allowed });

describe("isOriginAllowed", () => {
  it("never checks safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(check({ method, origin: "https://evil.example", site: "cross-site" }), method).toBe(true);
    }
  });

  it("checks every state-changing method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(check({ method, origin: "https://evil.example" }), method).toBe(false);
    }
  });

  describe("Origin present", () => {
    it("allows an exact allowed origin", () => {
      expect(check({ origin: ERP })).toBe(true);
    });

    it("refuses a sibling subdomain — the same-site case SameSite=Lax cannot stop", () => {
      expect(check({ origin: "https://staging.gaiada.com", site: "same-site" })).toBe(false);
      expect(check({ origin: "https://www.gaiada.com" })).toBe(false);
      expect(check({ origin: "https://api.erp.gaiada.com" })).toBe(false);
    });

    it("refuses look-alikes: other scheme, other port, suffix tricks", () => {
      expect(check({ origin: "http://erp.gaiada.com" })).toBe(false);
      expect(check({ origin: "https://erp.gaiada.com:8443" })).toBe(false);
      expect(check({ origin: "https://erp.gaiada.com.evil.example" })).toBe(false);
      expect(check({ origin: "https://evilerp.gaiada.com" })).toBe(false);
    });

    it("refuses Origin: null and an empty Origin", () => {
      expect(check({ origin: "null" })).toBe(false);
      expect(check({ origin: "" })).toBe(false);
    });

    it("Origin wins over Sec-Fetch-Site: a foreign Origin is refused even if the site header says same-origin", () => {
      expect(check({ origin: "https://evil.example", site: "same-origin" })).toBe(false);
    });
  });

  describe("no Origin, Sec-Fetch-Site present", () => {
    it("allows same-origin and none (a typed or bookmarked navigation)", () => {
      expect(check({ site: "same-origin" })).toBe(true);
      expect(check({ site: "none" })).toBe(true);
    });

    it("refuses same-site and cross-site", () => {
      expect(check({ site: "same-site" })).toBe(false);
      expect(check({ site: "cross-site" })).toBe(false);
    });
  });

  it("neither header: allowed (non-browser client — curl, scripts, the report renderer)", () => {
    expect(check({})).toBe(true);
  });
});

describe("allowedOrigins", () => {
  it("ALLOWED_ORIGINS wins: comma-separated, trimmed, normalised", () => {
    expect(
      allowedOrigins({ ALLOWED_ORIGINS: " https://erp.gaiada.com , https://ERP.gaiada.online/ ", PUBLIC_ORIGIN: "https://x.example" }, "http://localhost:3005"),
    ).toEqual(["https://erp.gaiada.com", "https://erp.gaiada.online"]);
  });

  it("falls back to PUBLIC_ORIGIN", () => {
    expect(allowedOrigins({ PUBLIC_ORIGIN: "https://erp.gaiada.online/" }, "http://localhost:3005")).toEqual(["https://erp.gaiada.online"]);
  });

  it("treats an EMPTY ALLOWED_ORIGINS as unset (compose passes ${X:-} as an empty string)", () => {
    expect(allowedOrigins({ ALLOWED_ORIGINS: "", PUBLIC_ORIGIN: ERP }, null)).toEqual([ERP]);
    expect(allowedOrigins({ ALLOWED_ORIGINS: "  ", PUBLIC_ORIGIN: ERP }, null)).toEqual([ERP]);
  });

  it("with nothing configured (next dev / e2e), allows the request's own origin only", () => {
    expect(allowedOrigins({}, "http://localhost:3005")).toEqual(["http://localhost:3005"]);
    expect(allowedOrigins({ ALLOWED_ORIGINS: "", PUBLIC_ORIGIN: "" }, "http://localhost:3005")).toEqual(["http://localhost:3005"]);
  });

  it("drops entries that are not origins rather than matching on them", () => {
    expect(allowedOrigins({ ALLOWED_ORIGINS: "erp.gaiada.com, javascript:alert(1), https://erp.gaiada.com" }, null)).toEqual([ERP]);
  });
});

describe("requestOwnOrigin", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });

  it("prefers the forwarded proto and host (behind nginx)", () => {
    expect(requestOwnOrigin(h({ "x-forwarded-proto": "https", "x-forwarded-host": "erp.gaiada.com" }), "http://10.0.0.5:3005/x")).toBe(ERP);
  });

  it("takes the first value of a forwarded list", () => {
    expect(requestOwnOrigin(h({ "x-forwarded-proto": "https, http", "x-forwarded-host": "erp.gaiada.com, inner" }), "http://a/")).toBe(ERP);
  });

  it("falls back to the URL under next dev", () => {
    expect(requestOwnOrigin(h({}), "http://localhost:3005/approvals")).toBe("http://localhost:3005");
  });
});

describe("normalizeOrigin", () => {
  it("lower-cases, drops default ports and paths, rejects non-http schemes", () => {
    expect(normalizeOrigin("HTTPS://Erp.Gaiada.com:443/path")).toBe(ERP);
    expect(normalizeOrigin("ftp://erp.gaiada.com")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});

it("no path is exempt today — platform-ui has no third-party browser POST target", () => {
  // Adding one is a security decision: exact path, a comment naming the caller, and this test updated.
  expect([...ORIGIN_CHECK_EXEMPT_PATHS]).toEqual([]);
});
