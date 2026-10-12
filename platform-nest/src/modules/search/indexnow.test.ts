// M5-P5a — IndexNow, the parts that need no database: URL building (route pattern, locale paths, skips with a
// reason), manual-submit normalisation, batching, the idempotency tag, backoff, the request and how each answer
// is classified, and the key-file proof (incl. the SSRF floor). Network is a fake fetch throughout.
import { describe, it, expect, vi } from "vitest";
import {
  INDEXNOW_BATCH_SIZE, INDEXNOW_ENDPOINT, assertPublicHttpsOrigin, backoffMs, buildIndexNowBody, buildPageUrls, chunk, generateIndexNowKey,
  hashUrl, isIndexNowEnabled, isValidIndexNowKey, keyFileBody, keyFileName, normalizeSubmitUrls, pagePathOf, pingIndexNow, siteOriginOf,
  verifyKeyFile, versionTag, type ChangedItem,
} from "./indexnow";

const ORIGIN = "https://www.example.com";
const item = (o: Partial<ChangedItem> = {}): ChangedItem => ({ slug: "hello-world", locale: "en", defaultLocale: "en", routePattern: "/blog/{slug}/", ...o });
const PUBLIC = async () => ["93.184.216.34"];

describe("the flag", () => {
  it("is ON only for the exact string 1", () => {
    expect(isIndexNowEnabled({ SEARCH_INDEXNOW_ENABLED: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 ", "01"]) {
      expect(isIndexNowEnabled({ SEARCH_INDEXNOW_ENABLED: v })).toBe(false);
    }
  });
});

describe("the key", () => {
  it("generates a valid 32-hex key, a different one each time, and serves it as <key>.txt", () => {
    const a = generateIndexNowKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidIndexNowKey(a)).toBe(true);
    expect(generateIndexNowKey()).not.toBe(a);
    expect(keyFileName(a)).toBe(`${a}.txt`);
    expect(keyFileBody(a)).toBe(a);
  });
  it("accepts the protocol alphabet and length only", () => {
    expect(isValidIndexNowKey("abcdefgh")).toBe(true);
    expect(isValidIndexNowKey("abc-DEF-123456")).toBe(true);
    for (const bad of ["short", "has space 12345", "under_score_1", "a".repeat(129), "", null, 5]) expect(isValidIndexNowKey(bad)).toBe(false);
  });
});

describe("siteOriginOf", () => {
  it("keeps the origin and drops path, query and fragment", () => {
    expect(siteOriginOf("https://www.example.com/some/path?x=1#y")).toBe("https://www.example.com");
    expect(siteOriginOf("http://example.com:8080/")).toBe("http://example.com:8080");
  });
  it("refuses non-http(s), userinfo and junk", () => {
    for (const bad of ["ftp://example.com", "https://u:p@example.com", "not a url", "", null, undefined, 5]) expect(siteOriginOf(bad)).toBeNull();
  });
});

describe("page URLs from a content change", () => {
  it("builds origin + the route pattern's path, with the slug", () => {
    const r = buildPageUrls(ORIGIN, [item()]);
    expect(r.urls).toEqual([{ url: "https://www.example.com/blog/hello-world/", itemIndex: 0, version: null }]);
    expect(r.skipped).toEqual([]);
  });
  it("an item with no route pattern is SKIPPED with a reason, never guessed", () => {
    for (const routePattern of [undefined, null, ""]) {
      const r = buildPageUrls(ORIGIN, [item({ routePattern })]);
      expect(r.urls).toEqual([]);
      expect(r.skipped).toEqual([{ itemIndex: 0, reason: "no_route_pattern" }]);
    }
  });
  it("a pattern the vocabulary refuses is bad_route_pattern", () => {
    for (const routePattern of ["blog/{slug}/", "/blog/{slug}/{slug}/", "/blog/../{slug}/", 42, "/blog/{slug}/?q=1"]) {
      expect(buildPageUrls(ORIGIN, [item({ routePattern })]).skipped).toEqual([{ itemIndex: 0, reason: "bad_route_pattern" }]);
    }
  });
  it("locale paths: the default language has no /{locale} segment, another language does", () => {
    const p = "/{locale}/blog/{slug}/";
    expect(pagePathOf(item({ routePattern: p, locale: "en" }))).toEqual({ path: "/blog/hello-world/" });
    expect(pagePathOf(item({ routePattern: p, locale: "id" }))).toEqual({ path: "/id/blog/hello-world/" });
    expect(buildPageUrls(ORIGIN, [item({ routePattern: p, locale: "id" })]).urls[0]!.url).toBe("https://www.example.com/id/blog/hello-world/");
  });
  it("a localized collection whose pattern has no {locale} has no address for a non-default language", () => {
    expect(pagePathOf(item({ locale: "id" }))).toEqual({ reason: "locale_not_routable" });
    // ... but a non-localized collection serves every item at the one address
    expect(pagePathOf(item({ locale: "id", localized: false }))).toEqual({ path: "/blog/hello-world/" });
  });
  it("a slug that cannot be a path segment is slug_not_routable", () => {
    expect(pagePathOf(item({ slug: "Has Spaces" }))).toEqual({ reason: "slug_not_routable" });
    expect(pagePathOf(item({ slug: "a/b" }))).toEqual({ reason: "slug_not_routable" });
  });
  it("keeps going past a skipped item, de-duplicates URLs and carries each item's version", () => {
    const r = buildPageUrls(ORIGIN, [item({ version: 3 }), item({ routePattern: undefined }), item({ version: 4 }), item({ slug: "second", version: 1 })]);
    expect(r.urls.map((u) => u.url)).toEqual(["https://www.example.com/blog/hello-world/", "https://www.example.com/blog/second/"]);
    expect(r.urls[0]!.version).toBe(3); // the first item that produced the URL
    expect(r.skipped).toEqual([{ itemIndex: 1, reason: "no_route_pattern" }]);
  });
  it("a root pattern still yields the origin's root", () => {
    expect(buildPageUrls(ORIGIN, [item({ routePattern: "/{slug}/", slug: "about" })]).urls[0]!.url).toBe("https://www.example.com/about/");
  });
});

describe("manual submit normalisation", () => {
  it("accepts paths and absolute URLs on the property's own origin, drops fragments and duplicates", () => {
    const r = normalizeSubmitUrls(ORIGIN, ["/a/", "https://www.example.com/b/#top", "/a/", "https://www.example.com/c/?x=1"]);
    expect(r.urls).toEqual(["https://www.example.com/a/", "https://www.example.com/b/", "https://www.example.com/c/?x=1"]);
    expect(r.rejected).toEqual([]);
  });
  it("refuses another host, another scheme, a protocol-relative URL and non-strings, saying why", () => {
    const r = normalizeSubmitUrls(ORIGIN, ["https://evil.example.org/x", "http://www.example.com/x", "//evil.example.org/x", "javascript:alert(1)", "", 5, "https://www.example.com.evil.org/x"]);
    expect(r.urls).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["wrong_host", "wrong_host", "not_a_url", "bad_scheme", "not_a_url", "not_a_url", "wrong_host"]);
  });
  it("refuses an over-long URL", () => {
    expect(normalizeSubmitUrls(ORIGIN, ["/" + "a".repeat(2100)]).rejected).toEqual([{ index: 0, reason: "too_long" }]);
  });
});

describe("idempotency tag, hash, batching, backoff", () => {
  it("versionTag is <transition>:v<N>:<ref>, stable, and bounded", () => {
    expect(versionTag("publish", 3, "appr-1")).toBe("publish:v3:appr-1");
    expect(versionTag("unpublish", null, null)).toBe("unpublish:v0:-");
    expect(versionTag("publish", 3, "appr-1")).toBe(versionTag("publish", 3, "appr-1"));
    expect(versionTag("publish", 3, "x".repeat(500)).length).toBe(128);
  });
  it("hashUrl is sha256 hex and differs per URL", () => {
    expect(hashUrl("https://a/")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashUrl("https://a/")).not.toBe(hashUrl("https://b/"));
  });
  it("chunks into the batch size", () => {
    const xs = Array.from({ length: 1200 }, (_, i) => i);
    expect(chunk(xs, INDEXNOW_BATCH_SIZE).map((c) => c.length)).toEqual([500, 500, 200]);
    expect(chunk([], 5)).toEqual([]);
  });
  it("backoff doubles from a minute and is capped at 6 hours", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(30)).toBe(6 * 3600_000);
    expect(backoffMs(0)).toBe(60_000);
  });
});

describe("the request", () => {
  it("body is { host, key, keyLocation, urlList }", () => {
    expect(buildIndexNowBody({ host: "a.com", key: "k1k1k1k1", keyLocation: "https://a.com/k1k1k1k1.txt", urls: ["https://a.com/x/"] })).toEqual({
      host: "a.com", key: "k1k1k1k1", keyLocation: "https://a.com/k1k1k1k1.txt", urlList: ["https://a.com/x/"],
    });
  });
  it("POSTs JSON to api.indexnow.org with the property's host and key file location, no redirect following", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _init?: RequestInit) => new Response("", { status: 200 }));
    const o = await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["https://www.example.com/a/", "https://www.example.com/b/"] }, { fetchImpl: f as never });
    expect(o).toEqual({ outcome: "sent", httpStatus: 200 });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(INDEXNOW_ENDPOINT);
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("manual");
    expect((init!.headers as Record<string, string>)["content-type"]).toContain("application/json");
    expect(JSON.parse(String(init!.body))).toEqual({
      host: "www.example.com", key: "abcdef1234567890", keyLocation: "https://www.example.com/abcdef1234567890.txt",
      urlList: ["https://www.example.com/a/", "https://www.example.com/b/"],
    });
  });
  const answer = (status: number, headers: Record<string, string> = {}) => vi.fn(async () => new Response("secret body that must never be surfaced", { status, headers }));
  it("200 and 202 are accepted", async () => {
    for (const s of [200, 202]) expect(await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["https://www.example.com/a/"] }, { fetchImpl: answer(s) as never })).toEqual({ outcome: "sent", httpStatus: s });
  });
  it("429 and 5xx are retryable, Retry-After (seconds) is honoured", async () => {
    const a = await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["u"] }, { fetchImpl: answer(429, { "retry-after": "120" }) as never });
    expect(a).toEqual({ outcome: "retry", httpStatus: 429, errorCode: "http_429", retryAfterMs: 120_000 });
    const b = await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["u"] }, { fetchImpl: answer(503) as never });
    expect(b).toEqual({ outcome: "retry", httpStatus: 503, errorCode: "http_503", retryAfterMs: null });
  });
  it("400, 403 and 422 are REJECTED (a retry cannot fix them); the body is never surfaced", async () => {
    for (const s of [400, 403, 422, 404]) {
      const o = await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["u"] }, { fetchImpl: answer(s) as never });
      expect(o).toEqual({ outcome: "rejected", httpStatus: s, errorCode: `http_${s}` });
      expect(JSON.stringify(o)).not.toContain("secret");
    }
  });
  it("a network failure and a timeout are retryable with their own token", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED 10.0.0.1"); });
    expect(await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["u"] }, { fetchImpl: down as never })).toEqual({ outcome: "retry", httpStatus: null, errorCode: "network", retryAfterMs: null });
    const slow = vi.fn((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => { init!.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); }));
    expect(await pingIndexNow({ origin: ORIGIN, key: "abcdef1234567890", urls: ["u"] }, { fetchImpl: slow as never, timeoutMs: 20 })).toEqual({ outcome: "retry", httpStatus: null, errorCode: "timeout", retryAfterMs: null });
  });
});

describe("the key-file proof", () => {
  const KEY = "abcdef1234567890abcdef1234567890";
  const serve = (status: number, body: string, headers: Record<string, string> = {}) => vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(body, { status, headers }));
  it("passes when https://<host>/<key>.txt serves exactly the key (whitespace around it is tolerated)", async () => {
    const f = serve(200, `${KEY}\n`);
    expect(await verifyKeyFile({ origin: ORIGIN, key: KEY }, { fetchImpl: f as never, resolve: PUBLIC })).toEqual({ ok: true });
    expect(String(f.mock.calls[0]![0])).toBe(`https://www.example.com/${KEY}.txt`);
    expect(f.mock.calls[0]![1]!.redirect).toBe("manual");
  });
  it("is refused, with a reason, when the file is missing, wrong, redirected, an error page or too large", async () => {
    const v = (f: unknown) => verifyKeyFile({ origin: ORIGIN, key: KEY }, { fetchImpl: f as never, resolve: PUBLIC });
    expect(await v(serve(404, "nope"))).toEqual({ ok: false, reason: "not_found", httpStatus: 404 });
    expect(await v(serve(200, "someotherkey"))).toEqual({ ok: false, reason: "key_mismatch" });
    expect(await v(serve(301, "", { location: "https://example.com/x" }))).toEqual({ ok: false, reason: "redirected", httpStatus: 301 });
    expect(await v(serve(500, "boom"))).toEqual({ ok: false, reason: "bad_status", httpStatus: 500 });
    expect(await v(serve(200, "k".repeat(5000)))).toEqual({ ok: false, reason: "too_large" });
    expect(await v(vi.fn(async () => { throw new Error("down"); }))).toEqual({ ok: false, reason: "unreachable" });
  });
  it("makes NO request to a non-https, private, IP-literal, single-label or unresolvable host", async () => {
    const f = serve(200, KEY);
    const v = (origin: string, resolve = PUBLIC) => verifyKeyFile({ origin, key: KEY }, { fetchImpl: f as never, resolve });
    expect(await v("http://www.example.com")).toEqual({ ok: false, reason: "site_url_not_https" });
    expect(await v("https://localhost")).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://intranet")).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://10.0.0.5")).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://169.254.169.254")).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://[::1]")).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://www.example.com:8443")).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://metadata.example.com", async () => ["169.254.169.254"])).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://mixed.example.com", async () => ["93.184.216.34", "10.1.2.3"])).toEqual({ ok: false, reason: "host_not_public" });
    expect(await v("https://gone.example.com", async () => { throw new Error("ENOTFOUND"); })).toEqual({ ok: false, reason: "host_unresolvable" });
    expect(await v("https://empty.example.com", async () => [])).toEqual({ ok: false, reason: "host_unresolvable" });
    expect(f).not.toHaveBeenCalled();
  });
  it("assertPublicHttpsOrigin passes an ordinary public name", async () => {
    expect(await assertPublicHttpsOrigin("https://www.example.com", PUBLIC)).toBeNull();
  });
});
