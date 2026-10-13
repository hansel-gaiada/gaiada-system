// M6-P6i — the ERP's mirror of WebDesk's environment-domain rule (webdesk-domain.ts). The vectors below are the SAME lists as
// webdesk/api/test/site-set-domain-unit.spec.ts asserts against WebDesk's own `checkEnvironmentDomain`: the two projects share no
// code, so a rule that drifts on either side turns one of the two suites red. Pure: no database, no network.
import { describe, expect, it } from "vitest";
import { checkWebdeskEnvironmentDomain } from "./webdesk-domain";

const ACCEPTED = [
  "example.com",
  "shop.example.com",
  "a.b.c.example.co.id",
  "my-shop.example.test",
  "xn--exmple-4nf.test",
  "www.example.com",
  "1shop.example.com",
];

const REFUSED: Array<[string, unknown]> = [
  ["upper case", "Example.com"],
  ["mixed case (the capital-I lookalike)", "exampIe.com"],
  ["a scheme", "https://example.com"],
  ["a port", "example.com:8443"],
  ["a path", "example.com/shop"],
  ["a trailing slash", "example.com/"],
  ["a query", "example.com?x=1"],
  ["a fragment", "example.com#x"],
  ["userinfo", "user@example.com"],
  ["a wildcard", "*.example.com"],
  ["leading whitespace", " example.com"],
  ["trailing whitespace", "example.com "],
  ["an inner space", "exa mple.com"],
  ["a trailing root dot", "example.com."],
  ["a leading dot", ".example.com"],
  ["an empty label", "example..com"],
  ["a single label", "localhost"],
  ["a single label that is a word", "intranet"],
  ["an IPv4 literal", "10.0.0.1"],
  ["a public IPv4 literal", "93.184.216.34"],
  ["an IPv6 literal", "[::1]"],
  ["a Cyrillic look-alike (must be punycode)", "exаmple.com"],
  ["a non-ASCII letter", "exämple.com"],
  ["an underscore", "ex_ample.com"],
  ["a leading hyphen label", "-example.com"],
  ["a trailing hyphen label", "example-.com"],
  ["a label over 63 characters", `${"a".repeat(64)}.com`],
  ["a name over 253 characters", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`],
  ["a numeric top-level label", "example.123"],
  ["the .invalid placeholder namespace", "site.provisioned.invalid"],
  ["a .local name", "printer.local"],
  ["a .localhost name", "app.localhost"],
  ["an .internal name", "db.internal"],
  ["too short", "a"],
  ["empty", ""],
  ["a number", 42],
  ["an array", ["example.com"]],
  ["an object", { domain: "example.com" }],
  ["undefined", undefined],
  ["null (a clear is not a domain; the callers handle null before this check)", null],
];

describe("checkWebdeskEnvironmentDomain (parity with WebDesk's checkEnvironmentDomain)", () => {
  it.each(ACCEPTED)("accepts %j", (d) => {
    expect(checkWebdeskEnvironmentDomain(d)).toEqual({ ok: true, domain: d });
  });

  it.each(REFUSED)("refuses %s", (_what, value) => {
    const v = checkWebdeskEnvironmentDomain(value);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
  });
});
