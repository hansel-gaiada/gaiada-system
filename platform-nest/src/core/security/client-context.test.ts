import { describe, it, expect } from "vitest";
import { cleanIp, clientContextOf, USER_AGENT_MAX } from "./client-context";

// BFF §52.2: which address and browser a request came from. The rule that matters: a request that came through nginx
// cannot claim an address with the x-gaiada-client-* headers.
const req = (headers: Record<string, string | string[]>, ip = "10.0.0.9") => ({ headers, ip });

describe("clientContextOf", () => {
  it("takes platform-ui's forwarded address and browser when the request did not pass nginx", () => {
    expect(clientContextOf(req({ "x-gaiada-client-ip": "203.0.113.7", "x-gaiada-client-ua": "Mozilla/5.0 Firefox" }))).toEqual({
      ip: "203.0.113.7", userAgent: "Mozilla/5.0 Firefox", via: "bff",
    });
  });

  it("ignores the forwarded headers on a request that came through nginx, and uses nginx's X-Real-IP", () => {
    const r = req({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "6.6.6.6, 198.51.100.4", "x-gaiada-client-ip": "1.2.3.4", "user-agent": "curl/8" });
    expect(clientContextOf(r)).toEqual({ ip: "198.51.100.4", userAgent: "curl/8", via: "nginx" });
  });

  it("falls back to the RIGHTMOST X-Forwarded-For entry (the one nginx appended), never the leftmost", () => {
    expect(clientContextOf(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" })).ip).toBe("198.51.100.4");
  });

  it("uses the socket peer when there is no header at all", () => {
    expect(clientContextOf(req({}, "::ffff:127.0.0.1"))).toEqual({ ip: "127.0.0.1", userAgent: null, via: "peer" });
  });

  it("says null for an address that does not parse, never a guess", () => {
    expect(clientContextOf(req({ "x-gaiada-client-ip": "not-an-ip", "x-gaiada-client-ua": "UA" })).ip).toBeNull();
    expect(clientContextOf(req({ "x-real-ip": "999.1.1.1" })).ip).toBeNull();
  });

  it("cuts a long user agent to the column's limit", () => {
    const ua = "x".repeat(USER_AGENT_MAX + 50);
    expect(clientContextOf(req({ "x-gaiada-client-ua": ua })).userAgent).toHaveLength(USER_AGENT_MAX);
  });
});

describe("cleanIp", () => {
  it("keeps IPv4 and IPv6, unwraps IPv4-mapped IPv6, and refuses junk", () => {
    expect(cleanIp("203.0.113.7")).toBe("203.0.113.7");
    expect(cleanIp("2001:db8::1")).toBe("2001:db8::1");
    expect(cleanIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(cleanIp("")).toBeNull();
    expect(cleanIp("203.0.113.7:443")).toBeNull();
  });
});
