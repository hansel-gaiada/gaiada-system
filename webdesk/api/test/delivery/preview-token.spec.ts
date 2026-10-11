// WSK-46 — the pure parts of draft preview (delivery/preview-token.ts): token format, hashing, the CORS
// rule and the log/problem redaction. No database, no app.
import { describe, expect, it } from "vitest";
import {
  allowedPreviewOrigin,
  hashPreviewToken,
  mintPreviewToken,
  PREVIEW_TOKEN_RE,
  PREVIEW_TTL_DEFAULT_SECONDS,
  PREVIEW_TTL_MAX_SECONDS,
  redactPreviewToken,
} from "../../src/delivery/preview-token";

describe("WSK-46 preview token primitives", () => {
  it("a minted token is 32 random bytes as unpadded base64url (43 characters) and matches the route's format check", () => {
    for (let i = 0; i < 50; i++) {
      const t = mintPreviewToken();
      expect(t).toMatch(PREVIEW_TOKEN_RE);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
    }
  });

  it("tokens do not repeat (no fixed seed, no counter): 2000 distinct values", () => {
    expect(new Set(Array.from({ length: 2000 }, () => mintPreviewToken())).size).toBe(2000);
  });

  it("the hash is sha256 hex (64 lowercase chars), deterministic, and not the token", () => {
    const t = mintPreviewToken();
    const h = hashPreviewToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPreviewToken(t)).toBe(h);
    expect(h).not.toContain(t);
    expect(hashPreviewToken(t + "A")).not.toBe(h);
    // sha256("abc") from FIPS 180-2: pins the algorithm, so a "harmless" change to the hash breaks every stored token loudly
    expect(hashPreviewToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("the format check refuses everything that is not exactly 43 base64url characters", () => {
    const a42 = "A".repeat(42);
    for (const bad of ["", "a", "A".repeat(41), "A".repeat(44), `${a42}=`, `${a42}+`, `${a42}/`, `${a42} `, `${a42}\n`, `${a42}é`]) {
      expect(PREVIEW_TOKEN_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(PREVIEW_TOKEN_RE.test("A".repeat(43))).toBe(true);
    expect(PREVIEW_TOKEN_RE.test(`${"-_".repeat(21)}-`)).toBe(true);
  });

  it("the TTL constants are an hour and a day", () => {
    expect(PREVIEW_TTL_DEFAULT_SECONDS).toBe(3600);
    expect(PREVIEW_TTL_MAX_SECONDS).toBe(86_400);
  });
});

describe("WSK-46 allowedPreviewOrigin (the CORS rule)", () => {
  const domains = ["staging.example.test", "www.example.test"];

  it("echoes an origin that is exactly https://<domain> of one of the domains", () => {
    expect(allowedPreviewOrigin("https://staging.example.test", domains)).toBe("https://staging.example.test");
    expect(allowedPreviewOrigin("https://www.example.test", domains)).toBe("https://www.example.test");
  });

  it("is case-insensitive on the host and returns the caller's own string", () => {
    expect(allowedPreviewOrigin("https://WWW.Example.TEST", domains)).toBe("https://WWW.Example.TEST");
    expect(allowedPreviewOrigin("https://www.example.test", ["WWW.EXAMPLE.TEST"])).toBe("https://www.example.test");
  });

  it("refuses every near-miss", () => {
    for (const origin of [
      undefined,
      null,
      "",
      "null",
      "*",
      "http://www.example.test",
      "https://example.test",
      "https://www.example.test:8443",
      "https://www.example.test/",
      "https://www.example.test/path",
      "https://www.example.test.evil.test",
      "https://evilwww.example.test",
      "https://evil.test/https://www.example.test",
      "https://www.example.test@evil.test",
      "https://evil.test@www.example.test",
      "https://www.example.test ",
      " https://www.example.test",
      "//www.example.test",
      "www.example.test",
    ]) {
      expect(allowedPreviewOrigin(origin, domains), JSON.stringify(origin)).toBeNull();
    }
  });

  it("no domains, or domains that are not bare hosts, never match", () => {
    expect(allowedPreviewOrigin("https://www.example.test", [])).toBeNull();
    expect(allowedPreviewOrigin("https://www.example.test", [""])).toBeNull();
    expect(allowedPreviewOrigin("https://www.example.test", ["   "])).toBeNull();
    // a stored value with a scheme or path is not a host: it must never turn into an allowed origin
    expect(allowedPreviewOrigin("https://https://www.example.test", ["https://www.example.test"])).toBeNull();
    expect(allowedPreviewOrigin("https://www.example.test", ["https://www.example.test"])).toBeNull();
    expect(allowedPreviewOrigin("https://www.example.test/x", ["www.example.test/x"])).toBeNull();
    expect(allowedPreviewOrigin("https://evil.test", ["evil.test@www.example.test"])).toBeNull();
  });

  it("a domain with a port matches the same origin with that port (staging on a non-default port)", () => {
    expect(allowedPreviewOrigin("https://staging.example.test:8443", ["staging.example.test:8443"])).toBe("https://staging.example.test:8443");
    expect(allowedPreviewOrigin("https://staging.example.test", ["staging.example.test:8443"])).toBeNull();
  });
});

describe("WSK-46 redactPreviewToken", () => {
  it("replaces the token segment of a preview path and nothing else", () => {
    expect(redactPreviewToken("/v1/t/acme/preview/SECRETSECRET")).toBe("/v1/t/acme/preview/:token");
    expect(redactPreviewToken("/v1/t/acme/preview/%E0%A4%A")).toBe("/v1/t/acme/preview/:token");
    expect(redactPreviewToken("/v1/t/acme/PREVIEW/SECRET")).toBe("/v1/t/acme/PREVIEW/:token");
    // the route matches the DECODED segment, so the redaction must too
    expect(redactPreviewToken("/v1/t/acme/%70review/SECRET")).toBe("/v1/t/acme/%70review/:token");
    expect(redactPreviewToken("/v1/t/acme/preview/SECRET/extra")).toBe("/v1/t/acme/preview/:token/extra");
  });

  it("leaves every other path alone", () => {
    for (const p of ["/v1/t/acme/service/preview", "/v1/t/acme/service/home", "/v1/t/acme/search", "/healthz", "/v1/t/acme/preview", "/v1/t/acme/previews/x"]) {
      expect(redactPreviewToken(p)).toBe(p);
    }
  });
});
