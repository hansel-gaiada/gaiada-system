// M6-P6i — the DNS checklist and its read-only check, with a STUBBED resolver. Pure: no database, no network, no real resolver.
// What it proves:
//   - `WEBDEV_DNS_TARGETS` parses to documented targets, and a typo REMOVES a target (never invents one);
//   - the records to create come from where the site is delivered, and with no documented target the checklist says "ask the
//     operator" rather than guessing an address;
//   - `evaluateDns` maps what a resolver reported to `pending` or `pointing`, case by case, including the half-finished cut-over
//     and a resolver failure (which is `pending`, never "not pointing");
//   - the lookup seam turns resolver errors into data (an empty answer for "no such record", `error` for a real failure), runs a
//     stub when one is installed, and never dials a resolver under vitest.
import { afterEach, describe, expect, it } from "vitest";
import {
  dnsChecklistFor, evaluateDns, isPlaceholderDomain, normalizeIp, parseDnsTargets, recordsOwnerFor,
  type DnsChecklist, type DnsTargetMap, type ObservedDns,
} from "./domain-dns";
import { lookupDomainRecords, setDnsLookupForTests, settleLookup } from "./domain-dns-lookup";

const TARGETS: DnsTargetMap = new Map([
  ["hostinger-1", [{ type: "A" as const, value: "203.0.113.10" }]],
  ["dual-1", [{ type: "A" as const, value: "203.0.113.20" }, { type: "AAAA" as const, value: "2001:db8::20" }]],
  ["edge-1", [{ type: "CNAME" as const, value: "edge.hosting.example.net" }]],
]);
const none: ObservedDns = { a: [], aaaa: [], cname: [] };

afterEach(() => setDnsLookupForTests(null));

describe("parseDnsTargets (WEBDEV_DNS_TARGETS)", () => {
  const warnings: string[] = [];
  const parse = (json: string) => {
    warnings.length = 0;
    return parseDnsTargets(json, (m) => warnings.push(m));
  };

  it("an empty value configures nothing, silently", () => {
    expect(parse("").size).toBe(0);
    expect(parse("   ").size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("parses address and CNAME targets, normalising IPv6 and CNAME spelling", () => {
    const m = parse(JSON.stringify({
      "hostinger-1": [{ type: "A", value: "203.0.113.10" }],
      "dual-1": [{ type: "A", value: "203.0.113.20" }, { type: "AAAA", value: "2001:0DB8:0:0:0:0:0:20" }],
      "edge-1": [{ type: "CNAME", value: "Edge.Hosting.Example.Net." }],
    }));
    expect(m.get("hostinger-1")).toEqual([{ type: "A", value: "203.0.113.10" }]);
    expect(m.get("dual-1")).toEqual([{ type: "A", value: "203.0.113.20" }, { type: "AAAA", value: "2001:db8::20" }]);
    expect(m.get("edge-1")).toEqual([{ type: "CNAME", value: "edge.hosting.example.net" }]);
    expect(warnings).toEqual([]);
  });

  it.each<[string, string]>([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["a string", '"x"'],
  ])("%s configures nothing and says so", (_n, json) => {
    expect(parse(json).size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it("DROPS a bad entry and keeps the good ones: a typo only ever removes a target", () => {
    const m = parse(JSON.stringify({
      "good-1": [{ type: "A", value: "203.0.113.10" }],
      "Bad Key": [{ type: "A", value: "203.0.113.11" }], // not a host_ref label
      "bad-ip": [{ type: "A", value: "999.1.1.1" }],
      "bad-type": [{ type: "MX", value: "mail.example.net" }],
      "a-is-v6": [{ type: "A", value: "2001:db8::1" }],
      "aaaa-is-v4": [{ type: "AAAA", value: "203.0.113.1" }],
      "bad-cname": [{ type: "CNAME", value: "10.0.0.1" }],
      "mixed": [{ type: "CNAME", value: "edge.example.net" }, { type: "A", value: "203.0.113.30" }],
      "two-cnames": [{ type: "CNAME", value: "a.example.net" }, { type: "CNAME", value: "b.example.net" }],
      "empty": [],
      "not-array": { type: "A" },
    }));
    expect([...m.keys()]).toEqual(["good-1"]);
    expect(warnings).toHaveLength(10);
  });
});

describe("normalizeIp", () => {
  it("makes two spellings of one IPv6 address equal, and leaves IPv4 alone", () => {
    expect(normalizeIp("2001:0DB8:0:0:0:0:0:20")).toBe(normalizeIp("2001:db8::20"));
    expect(normalizeIp("203.0.113.10")).toBe("203.0.113.10");
  });
});

describe("dnsChecklistFor: the records to create", () => {
  const base = { domain: "shop.example.com", hostKind: "shared-hosting", hostRef: "hostinger-1", targets: TARGETS };

  it("a documented address target is an A record on the domain, nothing invented", () => {
    expect(dnsChecklistFor(base)).toEqual({
      state: "ready",
      records: [{ type: "A", name: "shop.example.com", target: "203.0.113.10" }],
      instruction: null,
    });
  });

  it("a dual-stack host gets an A and an AAAA; a CNAME host gets the CNAME", () => {
    expect(dnsChecklistFor({ ...base, hostRef: "dual-1" }).records).toEqual([
      { type: "A", name: "shop.example.com", target: "203.0.113.20" },
      { type: "AAAA", name: "shop.example.com", target: "2001:db8::20" },
    ]);
    expect(dnsChecklistFor({ ...base, hostRef: "edge-1", hostKind: "our-box" }).records).toEqual([
      { type: "CNAME", name: "shop.example.com", target: "edge.hosting.example.net" },
    ]);
  });

  it("a host with NO documented target says to ask the operator, names the host label, and lists no record (no guess)", () => {
    const c = dnsChecklistFor({ ...base, hostRef: "hostinger-2" });
    expect(c.state).toBe("target_unknown");
    expect(c.records).toEqual([]);
    expect(c.instruction).toBe('Ask the operator for the DNS target of the host account "hostinger-2": it is not recorded here, and none is guessed.');
  });

  it("an empty target map is the same answer for every host", () => {
    expect(dnsChecklistFor({ ...base, targets: new Map() }).state).toBe("target_unknown");
  });

  it.each<[string, string, string | null]>([
    ["no binding yet", "unknown", null],
    ["a host kind that is not delivered to by CI", "client-cpanel", "hostinger-1"],
    ["a bindable kind with no host_ref", "shared-hosting", null],
    ["an empty host_ref", "shared-hosting", ""],
  ])("%s needs the delivery binding first", (_n, hostKind, hostRef) => {
    const c = dnsChecklistFor({ ...base, hostKind, hostRef });
    expect(c.state).toBe("needs_binding");
    expect(c.records).toEqual([]);
    expect(c.instruction).toMatch(/Bind the site's delivery target first/);
  });

  it("the registry's placeholder domain is not claimed: no records, whatever the binding", () => {
    for (const domain of ["acme.provisioned.invalid", "x.invalid"]) {
      expect(isPlaceholderDomain(domain)).toBe(true);
      const c = dnsChecklistFor({ ...base, domain });
      expect(c.state).toBe("not_claimed");
      expect(c.records).toEqual([]);
    }
    expect(isPlaceholderDomain("shop.example.com")).toBe(false);
  });

  it("who changes the records: the owner for an internal domain, the client for a client's", () => {
    expect(recordsOwnerFor(true)).toBe("owner");
    expect(recordsOwnerFor(false)).toBe("client");
  });
});

describe("evaluateDns: pending or pointing, from what a resolver reported", () => {
  const ready = (hostRef: string): DnsChecklist => dnsChecklistFor({ domain: "shop.example.com", hostKind: "shared-hosting", hostRef, targets: TARGETS });
  const pending = (reason: string) => ({ state: "pending", reason });
  const pointing = { state: "pointing", reason: null };

  it("POINTING: every observed address is the documented one", () => {
    expect(evaluateDns(ready("hostinger-1"), { ...none, a: ["203.0.113.10"] })).toEqual(pointing);
    expect(evaluateDns(ready("dual-1"), { ...none, a: ["203.0.113.20"], aaaa: ["2001:0db8:0:0:0:0:0:20"] })).toEqual(pointing);
  });

  it("POINTING: a CNAME target is matched on the domain's CNAME, case and trailing dot aside", () => {
    expect(evaluateDns(ready("edge-1"), { ...none, cname: ["EDGE.hosting.example.net."], a: ["198.51.100.7"] })).toEqual(pointing);
  });

  it("PENDING no_records: the domain has no address yet (a new domain, or no record created)", () => {
    expect(evaluateDns(ready("hostinger-1"), none)).toEqual(pending("no_records"));
    expect(evaluateDns(ready("edge-1"), none)).toEqual(pending("no_records"));
  });

  it("PENDING points_elsewhere: it resolves, but not to the documented target", () => {
    expect(evaluateDns(ready("hostinger-1"), { ...none, a: ["198.51.100.7"] })).toEqual(pending("points_elsewhere"));
    expect(evaluateDns(ready("hostinger-1"), { ...none, aaaa: ["2001:db8::99"] })).toEqual(pending("points_elsewhere"));
    expect(evaluateDns(ready("edge-1"), { ...none, cname: ["other.example.net"] })).toEqual(pending("points_elsewhere"));
    expect(evaluateDns(ready("edge-1"), { ...none, a: ["198.51.100.7"] })).toEqual(pending("points_elsewhere"));
  });

  it("PENDING mixed_with_other_hosts: a half-finished cut-over (some answers old, some new) is not pointing", () => {
    expect(evaluateDns(ready("hostinger-1"), { ...none, a: ["203.0.113.10", "198.51.100.7"] })).toEqual(pending("mixed_with_other_hosts"));
    // a documented A plus an undocumented AAAA still sends part of the traffic elsewhere
    expect(evaluateDns(ready("hostinger-1"), { ...none, a: ["203.0.113.10"], aaaa: ["2001:db8::99"] })).toEqual(pending("mixed_with_other_hosts"));
  });

  it("PENDING lookup_failed: a resolver failure is never read as evidence either way", () => {
    expect(evaluateDns(ready("hostinger-1"), { ...none, error: "ESERVFAIL" })).toEqual(pending("lookup_failed"));
    // even with a partial answer in hand
    expect(evaluateDns(ready("hostinger-1"), { ...none, a: ["203.0.113.10"], error: "ETIMEOUT" })).toEqual(pending("lookup_failed"));
  });

  it("PENDING with the checklist's own reason when there is nothing to compare with (the resolver is not even asked)", () => {
    const targetUnknown = dnsChecklistFor({ domain: "shop.example.com", hostKind: "shared-hosting", hostRef: "nope-1", targets: TARGETS });
    const needsBinding = dnsChecklistFor({ domain: "shop.example.com", hostKind: "unknown", hostRef: null, targets: TARGETS });
    const notClaimed = dnsChecklistFor({ domain: "a.provisioned.invalid", hostKind: "shared-hosting", hostRef: "hostinger-1", targets: TARGETS });
    // Even an observation that WOULD match cannot make these pointing: there is no documented target to match.
    const lucky = { ...none, a: ["203.0.113.10"] };
    expect(evaluateDns(targetUnknown, lucky)).toEqual(pending("target_unknown"));
    expect(evaluateDns(needsBinding, lucky)).toEqual(pending("needs_binding"));
    expect(evaluateDns(notClaimed, lucky)).toEqual(pending("domain_not_claimed"));
  });
});

describe("the resolver seam", () => {
  it("settleLookup: records are returned, 'no such record' codes are an EMPTY answer, anything else is an error code", async () => {
    expect(await settleLookup(Promise.resolve(["203.0.113.10"]))).toEqual({ values: ["203.0.113.10"] });
    for (const code of ["ENODATA", "ENOTFOUND", "NXDOMAIN"]) {
      expect(await settleLookup(Promise.reject(Object.assign(new Error("x"), { code })))).toEqual({ values: [] });
    }
    for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"]) {
      expect(await settleLookup(Promise.reject(Object.assign(new Error("x"), { code })))).toEqual({ values: [], error: code });
    }
    expect(await settleLookup(Promise.reject(new Error("no code")))).toEqual({ values: [], error: "ERROR" });
  });

  it("a stub resolver is used when installed, and gets the domain it was asked about", async () => {
    const asked: string[] = [];
    setDnsLookupForTests(async (domain) => (asked.push(domain), { a: ["203.0.113.10"], aaaa: [], cname: [] }));
    expect(await lookupDomainRecords("shop.example.com")).toEqual({ a: ["203.0.113.10"], aaaa: [], cname: [] });
    expect(asked).toEqual(["shop.example.com"]);
  });

  it("under vitest the REAL resolver is off: a lookup answers resolver_unavailable and dials nothing", async () => {
    expect(await lookupDomainRecords("shop.example.com")).toEqual({ a: [], aaaa: [], cname: [], error: "resolver_unavailable" });
  });

  it("end to end with a stub: the stub's answer is what evaluateDns maps (pointing, then pending after the stub changes)", async () => {
    const checklist = dnsChecklistFor({ domain: "shop.example.com", hostKind: "shared-hosting", hostRef: "hostinger-1", targets: TARGETS });
    setDnsLookupForTests(async () => ({ a: ["203.0.113.10"], aaaa: [], cname: [] }));
    expect(evaluateDns(checklist, await lookupDomainRecords("shop.example.com")).state).toBe("pointing");
    setDnsLookupForTests(async () => ({ a: ["198.51.100.7"], aaaa: [], cname: [] }));
    expect(evaluateDns(checklist, await lookupDomainRecords("shop.example.com"))).toEqual({ state: "pending", reason: "points_elsewhere" });
  });
});
