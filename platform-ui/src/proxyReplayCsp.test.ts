// M5-V6-c — proxy.ts sets the player page's Content-Security-Policy (and only that page's). See lib/replaysCsp.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { sealSession, encodeSession } from "./lib/session";
import { cookieName, HOST_COOKIES } from "./lib/cookieNames";
import { signedDomainParams } from "./lib/replaysCsp";

beforeAll(() => { process.env.SESSION_SECRET ??= "test-secret-for-replay-proxy"; });

const V = "0194a3b2-1111-7000-8000-000000000001";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const PATH = `/departments/d1/website/visitors/gaiada/site-1/${V}/recordings/${R}`;
const session = () => sealSession(encodeSession({ mode: "dev", userId: "u1" }));
function req(path: string, method = "GET") {
  const r = new NextRequest(new URL(`https://erp.example${path}`), { method });
  r.cookies.set(cookieName(HOST_COOKIES.session), session());
  return r;
}
const img = (res: Response) => (res.headers.get("content-security-policy") ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

describe("proxy: the replay player's CSP", () => {
  it("a signed player URL gets a CSP with exactly the site's domains", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", ["gaiada.com", "staging.gaiada.com"]);
    const res = proxy(req(`${PATH}?${new URLSearchParams({ d, s })}`));
    expect(img(res)).toBe("img-src 'self' data: https://gaiada.com https://staging.gaiada.com");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });

  it("an unsigned player URL gets the floor", () => {
    expect(img(proxy(req(PATH)))).toBe("img-src 'self' data:");
    expect(img(proxy(req(`${PATH}?d=evil.com&s=nope`)))).toBe("img-src 'self' data:");
  });

  it("no other page gets a policy from the proxy", () => {
    for (const p of ["/dashboard", `/departments/d1/website/visitors/gaiada/site-1/${V}`, "/departments/d1/website/visitors", "/api/meetings/m1/audio"]) {
      expect(proxy(req(p)).headers.get("content-security-policy"), p).toBeNull();
    }
  });

  it("only a GET navigation carries it", () => {
    expect(proxy(req(PATH, "POST")).headers.get("content-security-policy")).toBeNull();
  });
});
