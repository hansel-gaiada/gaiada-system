import { describe, expect, it } from "vitest";
import { isAllowedRenderUrl, isAuthorized } from "./auth.js";

describe("isAuthorized", () => {
  it("rejects a missing Authorization header", () => {
    expect(isAuthorized(undefined, "secret")).toBe(false);
  });

  it("rejects when the server-side token is unset (never fail open)", () => {
    expect(isAuthorized("Bearer secret", "")).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorized("Basic secret", "secret")).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorized("Bearer wrong", "secret")).toBe(false);
  });

  it("accepts a matching Bearer token", () => {
    expect(isAuthorized("Bearer secret", "secret")).toBe(true);
  });
});

describe("isAllowedRenderUrl", () => {
  const allowed = "http://platform-ui:3005";

  it("rejects a malformed url", () => {
    expect(isAllowedRenderUrl("not a url", allowed)).toBe(false);
  });

  it("rejects a different host (SSRF against another internal service)", () => {
    expect(isAllowedRenderUrl("http://cerbos:3592/_cerbos/health", allowed)).toBe(false);
  });

  it("rejects a different scheme even on the same host:port string", () => {
    expect(isAllowedRenderUrl("https://platform-ui:3005/print/x", allowed)).toBe(false);
  });

  it("rejects file:// (would otherwise read the container's filesystem)", () => {
    expect(isAllowedRenderUrl("file:///etc/passwd", allowed)).toBe(false);
  });

  it("rejects an external origin", () => {
    expect(isAllowedRenderUrl("http://evil.example.com/", allowed)).toBe(false);
  });

  it("accepts a same-origin url with any path", () => {
    expect(isAllowedRenderUrl("http://platform-ui:3005/print/reports/abc123", allowed)).toBe(true);
  });
});
