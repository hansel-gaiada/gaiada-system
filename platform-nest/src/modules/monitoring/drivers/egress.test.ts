// MON-11b — SSRF floor tests. Pure classification, no network, no DB, so this suite CANNOT skip.
// That property matters more here than anywhere else in the module: this is the file standing between
// "monitor this URL" and "read my cloud credentials", and a security guard whose suite skips silently
// is indistinguishable from one that passes.
import { describe, it, expect } from "vitest";
import {
  isDeniedAddress,
  isHostAllowlisted,
  normalizeHost,
  HostRateLimiter,
} from "./egress";

describe("the addresses that matter most", () => {
  it("denies the cloud metadata endpoint in every spelling", () => {
    // This is the reason the file exists. 169.254.169.254 serves instance credentials on GCP/AWS/
    // Azure, so a monitor that can reach it is a credential exfiltration tool with a dashboard.
    expect(isDeniedAddress("169.254.169.254")).toBe(true);
    expect(isDeniedAddress("::ffff:169.254.169.254")).toBe(true);  // IPv4-mapped
    expect(isDeniedAddress("::a9fe:a9fe")).toBe(true);             // IPv4-compatible (deprecated)
    expect(isDeniedAddress("[::ffff:169.254.169.254]")).toBe(true); // bracketed
  });

  it("denies loopback in every spelling, including the form Go's To4() missed", () => {
    expect(isDeniedAddress("127.0.0.1")).toBe(true);
    expect(isDeniedAddress("127.1.2.3")).toBe(true);   // all of 127/8, not just .0.1
    expect(isDeniedAddress("::1")).toBe(true);
    expect(isDeniedAddress("::ffff:127.0.0.1")).toBe(true);
    // The documented hole in the Go version: To4() unwraps only the MAPPED form, so ::7f00:1 was
    // classified PUBLIC. Modern kernels no longer route it, which makes it a logic hole rather than a
    // live bypass — but a classifier must not depend on OS behaviour to stay correct.
    expect(isDeniedAddress("::7f00:1")).toBe(true);
  });

  it("denies RFC1918, CGNAT, ULA and link-local", () => {
    for (const ip of [
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1", "100.127.255.255",   // CGNAT — some metadata services answer here
      "fc00::1", "fdff::1",              // ULA fc00::/7
      "fe80::1",                         // link-local
      "0.0.0.0", "::",                   // unspecified
      "224.0.0.1", "239.255.255.255",    // multicast
      "ff02::1",                         // IPv6 multicast
      "240.0.0.1",                       // reserved 240/4
    ]) {
      expect(isDeniedAddress(ip), `${ip} must be denied`).toBe(true);
    }
  });

  it("allows genuinely public addresses, or the guard would block all real work", () => {
    for (const ip of [
      "8.8.8.8",
      "203.0.113.10",      // TEST-NET-3, routable-shaped
      "172.15.255.255",    // just below RFC1918
      "172.32.0.1",        // just above RFC1918
      "100.63.255.255",    // just below CGNAT
      "100.128.0.1",       // just above CGNAT
      "126.255.255.255",   // just below loopback
      "128.0.0.1",         // just above loopback
      "169.253.255.255",   // just below link-local
      "169.255.0.1",       // just above link-local
      "2606:4700::1111",   // public IPv6
      "fbff::1",           // just below fc00::/7
    ]) {
      expect(isDeniedAddress(ip), `${ip} must be allowed`).toBe(false);
    }
  });

  it("fails CLOSED on anything it cannot parse", () => {
    // "Allow what we don't understand" is how a novel encoding becomes a bypass.
    for (const bad of ["", "not-an-ip", "1.2.3", "1.2.3.4.5", "999.1.1.1", "::gggg",
                       "1::2::3", "0x7f.0.0.1", "010.0.0.1"]) {
      expect(isDeniedAddress(bad), `${bad} must fail closed`).toBe(true);
    }
  });

  it("rejects leading-zero octets rather than guessing octal", () => {
    // Some resolvers read 0177.0.0.1 as octal 127.0.0.1. Rather than replicate that ambiguity, an
    // address with a leading zero is unparseable and therefore denied.
    expect(isDeniedAddress("0177.0.0.1")).toBe(true);
    expect(isDeniedAddress("010.0.0.1")).toBe(true);
  });
});

describe("allowlist is exact, never a suffix", () => {
  it("does not let a lookalike domain pass", () => {
    const allow = ["viceroybali.com"];
    expect(isHostAllowlisted("viceroybali.com", allow)).toBe(true);
    // A suffix rule would let an attacker simply register this and be inside the allowlist.
    expect(isHostAllowlisted("evil-viceroybali.com", allow)).toBe(false);
    expect(isHostAllowlisted("viceroybali.com.evil.net", allow)).toBe(false);
    // Subdomains are separate entries by design: a monitor is registered against a specific
    // property, not a domain tree.
    expect(isHostAllowlisted("www.viceroybali.com", allow)).toBe(false);
  });

  it("normalises case, a trailing dot and brackets, since all three reach the same host", () => {
    expect(isHostAllowlisted("VICEROYBALI.COM", ["viceroybali.com"])).toBe(true);
    expect(isHostAllowlisted("viceroybali.com.", ["viceroybali.com"])).toBe(true);
    expect(normalizeHost("[2606:4700::1111]")).toBe("2606:4700::1111");
  });

  it("an empty allowlist allows nothing", () => {
    expect(isHostAllowlisted("viceroybali.com", [])).toBe(false);
  });
});

describe("per-host rate limiting is per REQUEST, not per dial", () => {
  it("enforces the gap and then releases", () => {
    // A dial-level cap misses every request reusing a keep-alive connection, so one socket could
    // hammer a client's site while the counter sat still.
    const rl = new HostRateLimiter(1000);
    expect(rl.delayFor("a.example", 0)).toBe(0);
    rl.record("a.example", 0);
    expect(rl.delayFor("a.example", 200)).toBe(800);
    expect(rl.delayFor("a.example", 1000)).toBe(0);
    // Independent per host: one slow client must not throttle another.
    expect(rl.delayFor("b.example", 200)).toBe(0);
  });

  it("treats host spellings as the same host, or the cap is trivially bypassed", () => {
    const rl = new HostRateLimiter(500);
    rl.record("A.Example.", 0);
    expect(rl.delayFor("a.example", 100)).toBe(400);
  });
});
