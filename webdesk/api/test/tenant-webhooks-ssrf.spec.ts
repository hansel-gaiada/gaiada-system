// WSK-37 — THE SECURITY QUESTION, proven directly: a per-tenant webhook target is client-supplied
// outbound HTTP from inside Zone B, so `checkSsrfSafe()` (ssrf-guard.ts) is the ONE gate deciding
// whether a candidate URL is safe to open a connection to. This suite exercises it with literal IP
// addresses only (no live DNS dependency, so it runs identically with or without network access,
// and cannot be flaky in CI) — the hostname/DNS-rebind path is covered separately in
// tenant-webhooks-delivery.spec.ts using a real (fake, but resolvable) local hostname.
import { describe, it, expect } from "vitest";
import { checkSsrfSafe } from "../src/tenant-webhooks/ssrf-guard";

describe("WSK-37 · SSRF guard — the new client-controlled egress class", () => {
  it("REFUSES the cloud-metadata address (169.254.169.254) — the canonical SSRF-to-credential-theft target", async () => {
    const result = await checkSsrfSafe("https://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/disallowed address range/);
  });

  it("REFUSES loopback (127.0.0.1)", async () => {
    const result = await checkSsrfSafe("https://127.0.0.1/admin");
    expect(result.ok).toBe(false);
  });

  it("REFUSES IPv6 loopback (::1)", async () => {
    const result = await checkSsrfSafe("https://[::1]/admin");
    expect(result.ok).toBe(false);
  });

  it("REFUSES IPv6 link-local (fe80::/10) — same class as the IPv4 169.254.0.0/16 case", async () => {
    const result = await checkSsrfSafe("https://[fe80::1]/");
    expect(result.ok).toBe(false);
  });

  it("REFUSES IPv6 unique-local (fc00::/7)", async () => {
    const result = await checkSsrfSafe("https://[fd12:3456:789a::1]/");
    expect(result.ok).toBe(false);
  });

  it("REFUSES an IPv4-mapped IPv6 address that unwraps to a private range (::ffff:10.0.0.5)", async () => {
    const result = await checkSsrfSafe("https://[::ffff:10.0.0.5]/");
    expect(result.ok).toBe(false);
  });

  it.each([
    ["10.0.0.5", "RFC1918 10.0.0.0/8"],
    ["172.16.5.1", "RFC1918 172.16.0.0/12"],
    ["172.31.255.255", "RFC1918 172.16.0.0/12 upper bound"],
    ["192.168.1.1", "RFC1918 192.168.0.0/16"],
    ["100.64.0.1", "CGNAT 100.64.0.0/10"],
    ["0.0.0.0", "this-network 0.0.0.0/8"],
    ["169.254.1.1", "link-local 169.254.0.0/16 (metadata-adjacent)"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("REFUSES private/reserved IPv4 %s (%s)", async (ip) => {
    const result = await checkSsrfSafe(`https://${ip}/`);
    expect(result.ok).toBe(false);
  });

  it("REFUSES a plain http:// target — HTTPS is mandatory (§03)", async () => {
    const result = await checkSsrfSafe("http://8.8.8.8/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/);
  });

  it("REFUSES the literal hostname 'localhost'", async () => {
    const result = await checkSsrfSafe("https://localhost/");
    expect(result.ok).toBe(false);
  });

  it("REFUSES a malformed URL", async () => {
    const result = await checkSsrfSafe("not-a-url-at-all");
    expect(result.ok).toBe(false);
  });

  it("ACCEPTS an ordinary public IPv4 unicast address over https — the positive control every refusal above is measured against", async () => {
    const result = await checkSsrfSafe("https://8.8.8.8/webhook");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedIp).toBe("8.8.8.8");
  });
});
