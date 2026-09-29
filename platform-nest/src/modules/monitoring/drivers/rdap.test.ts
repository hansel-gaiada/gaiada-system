import { afterEach, describe, expect, it } from "vitest";
import { lookupDomainExpiry, registrableDomain, resetRdapBootstrap } from "./rdap";
import { peerCertExpiry } from "./http";
import { monitorHost } from "../runner";

const BOOT = {
  services: [
    [["com", "net"], ["http://insecure.example/", "https://rdap.verisign.com/com/v1/"]],
    [["id"], ["https://rdap.pandi.id/rdap"]],
    [["online"], ["https://rdap.radix.host/rdap/"]],
  ],
};

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  };
  return { fn, calls };
}

afterEach(() => resetRdapBootstrap());

describe("registrableDomain", () => {
  it.each([
    ["www.blossomcatering.online", "blossomcatering.online"],
    ["schoolcatering.gaiada.online", "gaiada.online"],
    ["essentialbali.com", "essentialbali.com"],
    ["www.ypi.or.id", "ypi.or.id"],
    ["shop.example.co.uk", "example.co.uk"],
    ["EXAMPLE.COM.", "example.com"],
  ])("%s -> %s", (host, want) => expect(registrableDomain(host)).toBe(want));

  it.each(["localhost", "10.0.0.1", "", "exa mple.com", "or.id"])("refuses %j", (h) => {
    expect(registrableDomain(h)).toBeNull();
  });
});

describe("lookupDomainExpiry", () => {
  const bootUrl = "https://data.iana.org/rdap/dns.json";

  it("reads the expiration event from the TLD's https registry", async () => {
    const f = fakeFetch({
      [bootUrl]: { status: 200, body: BOOT },
      "https://rdap.verisign.com/com/v1/domain/essentialbali.com": {
        status: 200,
        body: { events: [{ eventAction: "registration", eventDate: "2015-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-03-01T00:00:00Z" }] },
      },
    });
    const d = await lookupDomainExpiry("www.essentialbali.com", f.fn);
    expect(d?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    // The http:// base listed first is skipped: only an https registry is ever dialled.
    expect(f.calls.some((u) => u.startsWith("http://"))).toBe(false);
  });

  it("adds the missing trailing slash to a registry base", async () => {
    const f = fakeFetch({
      [bootUrl]: { status: 200, body: BOOT },
      "https://rdap.pandi.id/rdap/domain/ypi.or.id": { status: 200, body: { events: [{ eventAction: "expiration", eventDate: "2026-12-31T00:00:00Z" }] } },
    });
    expect((await lookupDomainExpiry("ypi.or.id", f.fn))?.getUTCFullYear()).toBe(2026);
  });

  it("returns null — never a guess — for no record, no expiry event, or an unlisted TLD", async () => {
    const f = fakeFetch({
      [bootUrl]: { status: 200, body: BOOT },
      "https://rdap.radix.host/rdap/domain/noevent.online": { status: 200, body: { events: [] } },
    });
    expect(await lookupDomainExpiry("missing.com", f.fn)).toBeNull(); // 404
    expect(await lookupDomainExpiry("noevent.online", f.fn)).toBeNull();
    expect(await lookupDomainExpiry("example.xyz", f.fn)).toBeNull();
  });

  it("throws on a registry error so the runner records 'not checked', not a date", async () => {
    const f = fakeFetch({ [bootUrl]: { status: 200, body: BOOT }, "https://rdap.verisign.com/com/v1/domain/down.com": { status: 503 } });
    await expect(lookupDomainExpiry("down.com", f.fn)).rejects.toThrow(/503/);
  });

  it("fetches the IANA bootstrap once per day, not once per lookup", async () => {
    const f = fakeFetch({ [bootUrl]: { status: 200, body: BOOT } });
    const t0 = Date.UTC(2026, 8, 29);
    await lookupDomainExpiry("a.com", f.fn, t0);
    await lookupDomainExpiry("b.com", f.fn, t0 + 60_000);
    expect(f.calls.filter((u) => u === bootUrl)).toHaveLength(1);
    await lookupDomainExpiry("c.com", f.fn, t0 + 25 * 3600_000);
    expect(f.calls.filter((u) => u === bootUrl)).toHaveLength(2);
  });
});

describe("peerCertExpiry", () => {
  it("reads valid_to off a TLS socket", () => {
    const sock = { getPeerCertificate: () => ({ valid_to: "Apr  8 02:28:18 2027 GMT" }) };
    expect(peerCertExpiry(sock)?.toISOString()).toBe("2027-04-08T02:28:18.000Z");
  });
  it.each([
    ["a plain socket", {}],
    ["no certificate", { getPeerCertificate: () => ({}) }],
    ["an unparseable date", { getPeerCertificate: () => ({ valid_to: "soon" }) }],
    ["a throwing socket", { getPeerCertificate: () => { throw new Error("gone"); } }],
    ["null", null],
  ])("null for %s — never a thrown probe", (_n, sock) => expect(peerCertExpiry(sock)).toBeNull());
});

describe("monitorHost", () => {
  it("prefers the config URL, then the target (URL or bare host)", () => {
    expect(monitorHost({ url: "https://www.site.com/path" }, "other.com")).toBe("www.site.com");
    expect(monitorHost({}, "site.com")).toBe("site.com");
    expect(monitorHost(null, "http://site.com:8080")).toBe("site.com");
    expect(monitorHost({}, null)).toBeNull();
  });
});
