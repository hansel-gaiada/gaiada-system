// DW-7h — which addresses IT may block, and the same-address comparison behind `blocks_yourself`.
import { describe, it, expect } from "vitest";
import { classifyBlockableIp, sameAddress } from "./ip-rules";

describe("classifyBlockableIp", () => {
  it("accepts public IPv4 and IPv6 addresses, written canonically", () => {
    expect(classifyBlockableIp("203.0.113.9")).toEqual({ ok: true, ip: "203.0.113.9" });
    expect(classifyBlockableIp("  8.8.8.8 ")).toEqual({ ok: true, ip: "8.8.8.8" });
    expect(classifyBlockableIp("2001:db8::1")).toEqual({ ok: true, ip: "2001:db8::1" });
    expect(classifyBlockableIp("::ffff:203.0.113.9")).toEqual({ ok: true, ip: "203.0.113.9" });
  });

  it("refuses the edges of the private blocks and accepts the first address outside them", () => {
    for (const ip of ["10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.1", "192.168.255.255"]) {
      expect(classifyBlockableIp(ip), ip).toEqual({ ok: false, reason: "private" });
    }
    for (const ip of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0"]) {
      expect(classifyBlockableIp(ip).ok, ip).toBe(true);
    }
  });

  it("refuses IPv6 unique-local, loopback and link-local, and a mapped private IPv4", () => {
    expect(classifyBlockableIp("fc00::1")).toEqual({ ok: false, reason: "private" });
    expect(classifyBlockableIp("fd12:3456::1")).toEqual({ ok: false, reason: "private" });
    expect(classifyBlockableIp("fe00::1").ok).toBe(true);
    expect(classifyBlockableIp("::1")).toEqual({ ok: false, reason: "loopback" });
    expect(classifyBlockableIp("fe80::1")).toEqual({ ok: false, reason: "link_local" });
    expect(classifyBlockableIp("febf::1")).toEqual({ ok: false, reason: "link_local" });
    expect(classifyBlockableIp("fec0::1").ok).toBe(true);
    expect(classifyBlockableIp("::ffff:10.1.2.3")).toEqual({ ok: false, reason: "private" });
  });

  it("refuses loopback, link-local and the reserved blocks", () => {
    expect(classifyBlockableIp("127.0.0.1")).toEqual({ ok: false, reason: "loopback" });
    expect(classifyBlockableIp("127.255.0.9")).toEqual({ ok: false, reason: "loopback" });
    expect(classifyBlockableIp("169.254.10.10")).toEqual({ ok: false, reason: "link_local" });
    expect(classifyBlockableIp("0.0.0.0")).toEqual({ ok: false, reason: "reserved" });
    expect(classifyBlockableIp("224.0.0.1")).toEqual({ ok: false, reason: "reserved" });
    expect(classifyBlockableIp("255.255.255.255")).toEqual({ ok: false, reason: "reserved" });
    expect(classifyBlockableIp("::")).toEqual({ ok: false, reason: "reserved" });
    expect(classifyBlockableIp("ff02::1")).toEqual({ ok: false, reason: "reserved" });
  });

  it("refuses anything that is not one address", () => {
    for (const bad of ["", "abc", "1.2.3", "1.2.3.4.5", "256.1.1.1", "203.0.113.0/24", "2001:db8::/32", "example.com", "1.2.3.4 ", "1.2.3.4;drop", null, undefined, 42, {}]) {
      const r = classifyBlockableIp(bad as unknown);
      // Leading/trailing blanks are trimmed by cleanIp, so "1.2.3.4 " is the one entry that is valid.
      if (bad === "1.2.3.4 ") expect(r.ok).toBe(true);
      else expect(r, String(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("sameAddress", () => {
  it("compares addresses, not spellings", () => {
    expect(sameAddress("203.0.113.9", "203.0.113.9")).toBe(true);
    expect(sameAddress("::ffff:203.0.113.9", "203.0.113.9")).toBe(true);
    expect(sameAddress("2001:DB8::1", "2001:db8:0:0:0:0:0:1")).toBe(true);
    expect(sameAddress("203.0.113.9", "203.0.113.10")).toBe(false);
    expect(sameAddress("2001:db8::1", "2001:db8::2")).toBe(false);
  });
  it("an unknown or unparsable address is never the caller's", () => {
    expect(sameAddress(null, "203.0.113.9")).toBe(false);
    expect(sameAddress("203.0.113.9", null)).toBe(false);
    expect(sameAddress(null, null)).toBe(false);
    expect(sameAddress("nonsense", "nonsense")).toBe(false);
  });
});
