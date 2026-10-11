// M5-L2 — the allow-list, limits and drop rules of the two optional submit members (src/forms/attribution.ts).
// Pure: no database, no Nest. Every rule of the shared contract has a case, and the "never throws, never
// refuses" property is pinned with hostile inputs.
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_ALLOWED_KEYS,
  ATTRIBUTION_MAX_BYTES,
  sanitizeAttribution,
  sanitizeVisitorConsent,
} from "../src/forms/attribution";

describe("sanitizeAttribution", () => {
  it("absent or null is simply no attribution, and nothing was dropped", () => {
    expect(sanitizeAttribution(undefined)).toEqual({ value: null, dropped: 0 });
    expect(sanitizeAttribution(null)).toEqual({ value: null, dropped: 0 });
  });

  it("keeps every allow-listed key as given", () => {
    const input = {
      landing: "/services/web/",
      form_page: "/contact/",
      referrer: "www.google.com",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "launch",
      utm_term: "web agency",
      utm_content: "hero",
      gclid: "g1",
      gbraid: "g2",
      wbraid: "g3",
      fbclid: "f1",
      msclkid: "m1",
      li_fat_id: "l1",
      fbp: "fb.1.1596403881668.1116446470",
      fbc: "fb.1.1554763741205.AbCdEfGhIj",
      sections_seen: ["home.hero", "pricing.step3"],
    };
    const r = sanitizeAttribution(input);
    expect(r.dropped).toBe(0);
    expect(r.value).toEqual(input);
    expect(Object.keys(input).sort()).toEqual([...ATTRIBUTION_ALLOWED_KEYS].sort());
  });

  it("drops unknown keys (counted) and keeps the rest; the submission is never refused", () => {
    const r = sanitizeAttribution({ landing: "/a/", email: "jane@example.com", __proto__x: 1, ip: "1.2.3.4" });
    expect(r.value).toEqual({ landing: "/a/" });
    expect(r.dropped).toBe(3);
  });

  it("a value over its limit drops THAT key only", () => {
    const r = sanitizeAttribution({
      landing: "/" + "a".repeat(512), // 513 > 512
      form_page: "/" + "a".repeat(511), // exactly 512
      referrer: "a".repeat(250) + ".com", // 254 > 253
      utm_source: "x".repeat(201),
      utm_medium: "x".repeat(200),
    });
    expect(r.value).toEqual({ form_page: "/" + "a".repeat(511), utm_medium: "x".repeat(200) });
    expect(r.dropped).toBe(3);
  });

  it("a value of the wrong type drops THAT key only", () => {
    const r = sanitizeAttribution({ landing: 5, utm_source: { a: 1 }, gclid: ["x"], fbp: true, utm_medium: "cpc", sections_seen: "home.hero" });
    expect(r.value).toEqual({ utm_medium: "cpc" });
    expect(r.dropped).toBe(5);
  });

  it("an empty string and a string with a control character are dropped", () => {
    const r = sanitizeAttribution({ utm_source: "", utm_medium: "a\u0000b", utm_campaign: "line\nbreak", utm_term: "ok" });
    expect(r.value).toEqual({ utm_term: "ok" });
    expect(r.dropped).toBe(3);
  });

  describe("paths (landing, form_page): path only", () => {
    it("cuts a query string and a fragment off (they can carry an email address or a token)", () => {
      expect(sanitizeAttribution({ landing: "/pricing/?email=jane@example.com&utm_source=x#top" }).value).toEqual({ landing: "/pricing/" });
      expect(sanitizeAttribution({ landing: "/#section" }).value).toEqual({ landing: "/" });
    });
    it("drops anything that is not a path: a full URL, a relative path, a protocol-relative URL", () => {
      for (const bad of ["https://gaiada.com/x", "pricing/", "//evil.example/x", "?only=query", "javascript:alert(1)"]) {
        expect(sanitizeAttribution({ landing: bad })).toEqual({ value: null, dropped: 1 });
      }
    });
  });

  describe("referrer: an external host only", () => {
    it("lower-cases a host and keeps it", () => {
      expect(sanitizeAttribution({ referrer: "WWW.Google.COM" }).value).toEqual({ referrer: "www.google.com" });
    });
    it("drops a URL, a path, a port, spaces or an empty host", () => {
      for (const bad of ["https://www.google.com/", "google.com/search", "google.com:443", "a b.com", "-bad.com", "bad-.com"]) {
        expect(sanitizeAttribution({ referrer: bad })).toEqual({ value: null, dropped: 1 });
      }
    });
  });

  describe("sections_seen", () => {
    it("keeps up to 50 items", () => {
      const items = Array.from({ length: 50 }, (_, i) => `s.${i}`);
      expect(sanitizeAttribution({ sections_seen: items }).value).toEqual({ sections_seen: items });
    });
    it("51 items drops the whole key", () => {
      const items = Array.from({ length: 51 }, (_, i) => `s.${i}`);
      expect(sanitizeAttribution({ sections_seen: items, landing: "/a/" })).toEqual({ value: { landing: "/a/" }, dropped: 1 });
    });
    it("filters bad items individually: not a string, over 64 chars, outside [A-Za-z0-9_.:-]", () => {
      const r = sanitizeAttribution({ sections_seen: ["ok.one", 7, "x".repeat(65), "bad item", "<script>", "a/b", "x".repeat(64), "colon:dash-under_dot."] });
      expect(r.value).toEqual({ sections_seen: ["ok.one", "x".repeat(64), "colon:dash-under_dot."] });
      expect(r.dropped).toBe(5);
    });
    it("an array with no surviving item leaves no key", () => {
      expect(sanitizeAttribution({ sections_seen: ["bad item"] })).toEqual({ value: null, dropped: 1 });
      expect(sanitizeAttribution({ sections_seen: [] })).toEqual({ value: null, dropped: 0 });
    });
  });

  describe("the 4 KB cap", () => {
    it("an object whose serialized form is over 4096 bytes is dropped WHOLE", () => {
      // Every key at its own limit is legal on its own; together they overflow.
      const big: Record<string, unknown> = { landing: "/" + "a".repeat(500), form_page: "/" + "b".repeat(500) };
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "li_fat_id", "fbp", "fbc"]) {
        big[k] = "v".repeat(200);
      }
      big.sections_seen = Array.from({ length: 50 }, (_, i) => `section.${"x".repeat(40)}.${i}`);
      expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(ATTRIBUTION_MAX_BYTES);
      const r = sanitizeAttribution(big);
      expect(r.value).toBeNull();
      expect(r.dropped).toBeGreaterThanOrEqual(1);
    });
    it("one under the cap is kept", () => {
      const ok = { landing: "/" + "a".repeat(500), utm_source: "v".repeat(200), sections_seen: ["a.b"] };
      expect(sanitizeAttribution(ok).value).toEqual(ok);
    });
  });

  it("never throws and never returns a value for a hostile or non-object input", () => {
    for (const hostile of ["string", 42, true, [], [{ landing: "/a/" }], () => 1, Symbol("x")]) {
      const r = sanitizeAttribution(hostile as unknown);
      expect(r.value).toBeNull();
      expect(r.dropped).toBe(1);
    }
    expect(() => sanitizeAttribution(JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"landing":"/ok/"}'))).not.toThrow();
    expect(sanitizeAttribution(JSON.parse('{"__proto__":{"x":1},"landing":"/ok/"}')).value).toEqual({ landing: "/ok/" });
  });
});

describe("sanitizeVisitorConsent", () => {
  const good = { analytics: true, marketing: false, version: "3", decided_at: "2026-10-11T09:00:00Z" };

  it("absent or null is unknown, not malformed", () => {
    expect(sanitizeVisitorConsent(undefined)).toEqual({ value: null, malformed: false });
    expect(sanitizeVisitorConsent(null)).toEqual({ value: null, malformed: false });
  });

  it("a well-formed record is kept, with decided_at normalised to UTC", () => {
    expect(sanitizeVisitorConsent(good)).toEqual({ value: { ...good, decided_at: "2026-10-11T09:00:00.000Z" }, malformed: false });
    expect(sanitizeVisitorConsent({ ...good, decided_at: "2026-10-11T16:00:00+07:00" }).value?.decided_at).toBe("2026-10-11T09:00:00.000Z");
  });

  it("unknown keys are dropped from a kept record", () => {
    const r = sanitizeVisitorConsent({ ...good, ip: "1.2.3.4", extra: 1 });
    expect(r.value).toEqual({ ...good, decided_at: "2026-10-11T09:00:00.000Z" });
  });

  it("a malformed record is null, flagged malformed, and never throws", () => {
    const bad: unknown[] = [
      "yes",
      42,
      [],
      { ...good, analytics: "true" },
      { ...good, marketing: 1 },
      { ...good, analytics: undefined },
      { marketing: true, version: "3", decided_at: good.decided_at },
      { ...good, version: "" },
      { ...good, version: "v".repeat(33) },
      { ...good, version: 3 },
      { ...good, decided_at: "yesterday" },
      { ...good, decided_at: "2026-10-11" }, // a date with no time and no zone is not an instant
      { ...good, decided_at: "2026-13-45T99:00:00Z" },
      { ...good, decided_at: 1760173200000 },
    ];
    for (const b of bad) {
      expect(sanitizeVisitorConsent(b)).toEqual({ value: null, malformed: true });
    }
  });

  it("a 32-character version is the longest accepted", () => {
    expect(sanitizeVisitorConsent({ ...good, version: "v".repeat(32) }).value?.version).toBe("v".repeat(32));
  });
});
