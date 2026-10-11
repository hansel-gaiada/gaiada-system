// B0 — framing headers from next.config.ts, so the app refuses to be framed by another site even when
// a request reaches it without passing through nginx. Run through Next's own config evaluator.
import { describe, it, expect } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "../next.config";

describe("next.config headers()", () => {
  for (const url of ["https://erp.example/", "https://erp.example/approvals/abc", "https://erp.example/api/meetings/m1/audio", "https://erp.example/print/r1", "https://erp.example/login"]) {
    it(`frames only same-origin: ${new URL(url).pathname}`, async () => {
      const res = await unstable_getResponseFromNextConfig({ url, nextConfig });
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    });
  }

  it("adds no other CSP directive (scripts and styles are a separate change)", async () => {
    const res = await unstable_getResponseFromNextConfig({ url: "https://erp.example/", nextConfig });
    expect(res.headers.get("content-security-policy")?.split(";").map((d) => d.trim()).filter(Boolean)).toEqual(["frame-ancestors 'self'"]);
  });
});
