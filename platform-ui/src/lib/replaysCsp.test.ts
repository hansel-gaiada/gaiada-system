import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { MAX_DOMAINS, buildReplayCsp, cleanDomains, playerPathParts, replayCspFor, signedDomainParams, verifiedDomains } from "./replaysCsp";

// The player page's policy: images (and media) only from the site's own domains, never anything a value can smuggle in, and a signed
// link so only the page's own read can widen it.

const V = "0194a3b2-1111-7000-8000-000000000001";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const PATH = `/departments/d1/website/visitors/gaiada/site-1/${V}/recordings/${R}`;
const SECRET = "test-secret-for-replay-csp";
beforeAll(() => { process.env.SESSION_SECRET = SECRET; });
afterEach(() => { process.env.SESSION_SECRET = SECRET; });
const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

describe("buildReplayCsp", () => {
  it("admits images only from self, data: and the property's own domains", () => {
    const csp = buildReplayCsp(["gaiada.com", "staging.gaiada.com"]);
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: https://gaiada.com https://staging.gaiada.com");
    expect(directive(csp, "media-src")).toBe("media-src 'self' data: https://gaiada.com https://staging.gaiada.com");
  });

  it("with no domains it is the floor: self and data: only", () => {
    expect(directive(buildReplayCsp([]), "img-src")).toBe("img-src 'self' data:");
  });

  it("never widens: no wildcard, no http:, no blob:, no bare https:, no other host", () => {
    const img = directive(buildReplayCsp(["gaiada.com"]), "img-src") ?? "";
    expect(img).not.toMatch(/\*/);
    expect(img).not.toMatch(/(^|\s)https?:(\s|$)/);
    expect(img).not.toContain("blob:");
    expect(img).not.toContain("http://");
    expect(img.split(" ").slice(1)).toEqual(["'self'", "data:", "https://gaiada.com"]);
  });

  it("does not touch script-src (the recorded content's scripts are stopped by the replayer's sandbox, not by this policy)", () => {
    const csp = buildReplayCsp(["gaiada.com"]);
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("default-src");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("repeats frame-ancestors 'self' (this header replaces next.config's on this route) and shuts objects and base", () => {
    const csp = buildReplayCsp([]);
    expect(csp.split("; ")).toEqual(expect.arrayContaining(["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'"]));
  });

  it("a domain that is not a plain hostname cannot add a source or a directive", () => {
    const csp = buildReplayCsp(["evil.com; script-src *", "a.com img-src *", "https://x.com", "x.com:8080", "*.x.com", "x.com/path", "'self'", "good.com"]);
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: https://good.com");
    expect(csp.match(/;/g)?.length).toBe(4);
  });
});

describe("cleanDomains", () => {
  it("lower-cases, drops empties and nulls, de-duplicates and sorts", () => {
    expect(cleanDomains(["B.com", null, "", "a.com", "b.com", undefined, " a.com "])).toEqual(["a.com", "b.com"]);
  });
  it("needs a dotted hostname", () => {
    expect(cleanDomains(["localhost", "a.b", "-a.com", "a-.com", "a..com"])).toEqual(["a.b"]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => `h${String(i).padStart(2, "0")}.example.com`);
    expect(cleanDomains(many)).toHaveLength(MAX_DOMAINS);
  });
});

describe("playerPathParts", () => {
  it("matches only the player page, and decodes tenant and site", () => {
    expect(playerPathParts(PATH)).toEqual({ tenant: "gaiada", site: "site-1" });
    expect(playerPathParts(`${PATH}/`)).toEqual({ tenant: "gaiada", site: "site-1" });
    expect(playerPathParts(`/departments/d1/website/visitors/a%20b/s/${V}/recordings/${R}`)).toEqual({ tenant: "a b", site: "s" });
  });
  it("not the visitor page, the list, the rules page, or anything deeper", () => {
    for (const p of [
      `/departments/d1/website/visitors/gaiada/site-1/${V}`, "/departments/d1/website/visitors", "/departments/d1/website/visitors/gaiada/site-1/interest-rules",
      `${PATH}/x`, `/departments/d1/website/visitors/gaiada/site-1/${V}/recordings`, "/", "/departments/d1/website/content",
    ]) expect(playerPathParts(p), p).toBeNull();
  });
});

describe("the signed link", () => {
  it("round-trips: the verified domains are the signed ones", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", ["gaiada.com", "Staging.gaiada.com"]);
    expect(d).toBe("gaiada.com,staging.gaiada.com");
    expect(verifiedDomains("gaiada", "site-1", d, s)).toEqual(["gaiada.com", "staging.gaiada.com"]);
  });

  it("an empty list is signable (the floor) and verifies as empty", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", []);
    expect(d).toBe("");
    expect(verifiedDomains("gaiada", "site-1", d, s)).toEqual([]);
  });

  it("a forged or edited list proves nothing", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", ["gaiada.com"]);
    expect(verifiedDomains("gaiada", "site-1", "gaiada.com,evil.com", s)).toBeNull();
    expect(verifiedDomains("gaiada", "site-1", d, `${s}x`)).toBeNull();
    expect(verifiedDomains("gaiada", "site-1", d, "")).toBeNull();
    expect(verifiedDomains("gaiada", "site-1", d, undefined)).toBeNull();
    expect(verifiedDomains("gaiada", "site-1", undefined, s)).toBeNull();
  });

  it("is bound to its tenant and site", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", ["gaiada.com"]);
    expect(verifiedDomains("gaiada", "site-2", d, s)).toBeNull();
    expect(verifiedDomains("other", "site-1", d, s)).toBeNull();
  });

  it("a non-canonical list is refused", () => {
    const real = signedDomainParams("t", "s", ["a.com"]);
    expect(verifiedDomains("t", "s", "B.com,a.com", real.s)).toBeNull();
  });

  it("without SESSION_SECRET nothing verifies and nothing throws (signing does, so the page can say so)", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", ["gaiada.com"]);
    delete process.env.SESSION_SECRET;
    expect(() => verifiedDomains("gaiada", "site-1", d, s)).not.toThrow();
    expect(verifiedDomains("gaiada", "site-1", d, s)).toBeNull();
    expect(() => signedDomainParams("gaiada", "site-1", ["gaiada.com"])).toThrow();
  });

  it("a session cookie signature is never a valid signature over a domain list (the key is derived and labelled)", async () => {
    const { sealSession } = await import("./session");
    const sealed = sealSession("gaiada\nsite-1\ngaiada.com");
    expect(verifiedDomains("gaiada", "site-1", "gaiada.com", sealed.slice(sealed.lastIndexOf(".") + 1))).toBeNull();
  });
});

describe("replayCspFor (what the proxy sets)", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  it("null for any other path: nothing else in the app gets this policy", () => {
    expect(replayCspFor("/dashboard", q({}))).toBeNull();
    expect(replayCspFor(`/departments/d1/website/visitors/gaiada/site-1/${V}`, q({}))).toBeNull();
  });

  it("a validly signed URL gets exactly its domains", () => {
    const { d, s } = signedDomainParams("gaiada", "site-1", ["gaiada.com"]);
    const csp = replayCspFor(PATH, q({ d, s })) ?? "";
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: https://gaiada.com");
  });

  it("no params, forged params or another site's params get the floor", () => {
    const floor = "img-src 'self' data:";
    expect(directive(replayCspFor(PATH, q({})) ?? "", "img-src")).toBe(floor);
    expect(directive(replayCspFor(PATH, q({ d: "evil.com", s: "forged" })) ?? "", "img-src")).toBe(floor);
    const other = signedDomainParams("gaiada", "site-2", ["gaiada.com"]);
    expect(directive(replayCspFor(PATH, q(other)) ?? "", "img-src")).toBe(floor);
  });

  it("never throws, even with no secret", () => {
    delete process.env.SESSION_SECRET;
    expect(() => replayCspFor(PATH, q({ d: "a.com", s: "x" }))).not.toThrow();
    expect(directive(replayCspFor(PATH, q({ d: "a.com", s: "x" })) ?? "", "img-src")).toBe("img-src 'self' data:");
  });
});
