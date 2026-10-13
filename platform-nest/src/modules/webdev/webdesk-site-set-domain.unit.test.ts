// M6-P6i — the site.setDomain approved command, without Postgres, Cerbos or WebDesk: what is hashed, what is parsed, what routes.
//   - the command is routed to the in-band executor by (origin webdesk, workflow_id site.setDomain);
//   - the filed hash is the one WebDesk will compute: over {tenantSlug, siteId} (route params) then {envId, domain} (body), exactly
//     `commandArgsAsZoneBSeesThem`, and a clear (`domain: null`) is a different hash from every set;
//   - a STORED row that is not canonical (a changed domain, a missing key, a non-uuid env) is refused when it is re-parsed, so a
//     row edited after filing can neither execute nor hash.
// The filing, the maker != checker rule, the executor and the rollback are webdesk-site-set-domain.test.ts (real Postgres + Cerbos).
import { describe, expect, it } from "vitest";
import { isWebdeskApprovedCommandRequest, webdeskCommandHashFor, WEBDESK_APPROVAL_ORIGIN } from "./webdesk-approved-command";
import { commandArgsAsZoneBSeesThem, computeCommandHash } from "./webdesk-ws4-assertion";

const SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const ENV = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ENV2 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const base = { command: "site.setDomain", tenantSlug: "gaiada", siteId: SITE, envId: ENV, domain: "shop.example.com" };

describe("site.setDomain routing", () => {
  it("is routed to the WSK-66 in-band executor, and only with the webdesk origin", () => {
    expect(isWebdeskApprovedCommandRequest(WEBDESK_APPROVAL_ORIGIN, "site.setDomain")).toBe(true);
    expect(isWebdeskApprovedCommandRequest("automation", "site.setDomain")).toBe(false);
    expect(isWebdeskApprovedCommandRequest(WEBDESK_APPROVAL_ORIGIN, "site.setDomainX")).toBe(false);
  });
});

describe("the filed command hash is what WebDesk will compute", () => {
  it("is sha256 of `site.setDomain:` + the canonical {...params, ...body}", () => {
    const wire = commandArgsAsZoneBSeesThem({ tenantSlug: "gaiada", siteId: SITE }, { envId: ENV, domain: "shop.example.com" });
    expect(webdeskCommandHashFor(base)).toBe(computeCommandHash("site.setDomain", wire));
    // WebDesk's guard builds `{...request.params, ...request.body}`; the same literal object hashes the same.
    expect(webdeskCommandHashFor(base)).toBe(computeCommandHash("site.setDomain", { tenantSlug: "gaiada", siteId: SITE, envId: ENV, domain: "shop.example.com" }));
  });

  it("differs for any other domain, environment, site or tenant, and for a clear", () => {
    const h = webdeskCommandHashFor(base);
    expect(webdeskCommandHashFor({ ...base, domain: "evil.example.com" })).not.toBe(h);
    expect(webdeskCommandHashFor({ ...base, envId: ENV2 })).not.toBe(h);
    expect(webdeskCommandHashFor({ ...base, siteId: ENV2 })).not.toBe(h);
    expect(webdeskCommandHashFor({ ...base, tenantSlug: "other" })).not.toBe(h);
    const clear = webdeskCommandHashFor({ ...base, domain: null });
    expect(clear).not.toBe(h);
    expect(clear).toBe(computeCommandHash("site.setDomain", { tenantSlug: "gaiada", siteId: SITE, envId: ENV, domain: null }));
  });

  it("is not the hash of any other command over the same arguments (an archive approval cannot set a domain)", () => {
    const wire = { tenantSlug: "gaiada", siteId: SITE, envId: ENV, domain: "shop.example.com" };
    expect(webdeskCommandHashFor(base)).not.toBe(computeCommandHash("site.archive", wire));
    expect(webdeskCommandHashFor(base)).not.toBe(computeCommandHash("key.mint", wire));
  });

  it("ignores the stored-only keys (summary, commandHash): the hash binds the request, not the display", () => {
    const stored = { ...base, summary: { title: "x" }, commandHash: "a".repeat(64) };
    expect(webdeskCommandHashFor(stored)).toBe(webdeskCommandHashFor(base));
  });
});

describe("a stored row is re-validated whenever it is parsed", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a non-canonical domain (upper case)", { ...base, domain: "Shop.Example.com" }],
    ["a domain with a scheme", { ...base, domain: "https://shop.example.com" }],
    ["a domain with a port", { ...base, domain: "shop.example.com:8443" }],
    ["a Cyrillic look-alike", { ...base, domain: "shop.exаmple.com" }],
    ["a placeholder domain", { ...base, domain: "acme.provisioned.invalid" }],
    ["a missing domain key (a clear must say null)", { command: base.command, tenantSlug: base.tenantSlug, siteId: base.siteId, envId: base.envId }],
    ["an empty-string domain", { ...base, domain: "" }],
    ["a non-uuid envId", { ...base, envId: "prod" }],
    ["a missing envId", { command: base.command, tenantSlug: base.tenantSlug, siteId: base.siteId, domain: base.domain }],
    ["a stray item list", { ...base, items: [] }],
    ["a stray scope", { ...base, scope: "read" }],
    ["a non-uuid siteId", { ...base, siteId: "s1" }],
    ["a bad tenant slug", { ...base, tenantSlug: "Not A Slug" }],
  ])("refuses %s", (_what, args) => {
    expect(() => webdeskCommandHashFor(args)).toThrow();
  });
});
