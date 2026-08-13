// SMM-05 — the port's contract tests. No database, no Cerbos, and — deliberately — NO LIVE POSTIZ.
//
// Postiz is not deployed (SMM-04 is PROTOTYPED; nothing has been run on either host), so a suite
// that needed it would be a suite nobody could run. Everything below drives either the mock driver
// or the real Postiz driver over an injected `fetchImpl`, which also means the transport assertions
// are made at the wire — the only place a claim like "the API key never leaves the Authorization
// header" can actually be proved.
import { describe, it, expect, vi } from "vitest";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OrgHandle, SocialPublisherError, type PublisherCapability, type SocialPublisher,
} from "./types";
import { resolveAccountCapabilities, deriveAccountStatus, KNOWN_NETWORKS } from "./capabilities";
import { resolveOrgApiKey, envVarForKeyRef, describeKeyRef, DEFAULT_KEY_REF } from "./keys";
import {
  createPostizDriver, parseContentPublishingLimit, normalizeIntegrations, normalizePosts,
  X_POST_USD, X_POST_WITH_LINK_USD,
} from "./postiz";
import { createMockPublisher, newMockPublisherState } from "./mock-driver";
import { registerPublisher, resetPublishers, resolvePublisher, invokePublisher } from "./registry";
import { assertPublisherBaseUrlIsPrivate, PublicPublisherBaseUrlError } from "./boot";

const KEY = "s3cr3t-org-key-do-not-log";
const handle = (): OrgHandle => new OrgHandle("row-1", "org-abc", KEY);

function driverWithFetch(fetchImpl: typeof fetch, quotaProbeTool = ""): SocialPublisher {
  return createPostizDriver({
    baseUrl: "http://10.88.0.2:4007",
    apiPrefix: "/api/public/v1",
    readTimeoutMs: 1000,
    uploadTimeoutMs: 2000,
    connectTimeoutMs: 500,
    quotaProbeTool,
    fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("SMM-05 · OrgHandle — custody split (b) cannot leak through a log line", () => {
  // D-5 forbids the org key from reaching platform-ui, n8n credentials, a tenant row, an audit line
  // or a log field. The first four are enforced by where it is READ; this is the fifth, and it is
  // the one that erodes: "never log the key" holds until someone debugs a failing call by dumping
  // the object. Both incidental-serialization paths a Node process actually uses are covered.
  it("redacts the key under JSON.stringify", () => {
    expect(JSON.stringify(handle())).not.toContain(KEY);
    expect(JSON.parse(JSON.stringify(handle()))).toEqual({
      publisherOrgId: "row-1", orgId: "org-abc", apiKey: "[redacted]",
    });
  });

  it("redacts the key under util.inspect (pino / console.log / a vitest diff)", () => {
    const rendered = inspect(handle(), { depth: 5 });
    expect(rendered).not.toContain(KEY);
    expect(rendered).toContain("[redacted]");
  });

  it("still exposes the key to the one caller allowed to have it", () => {
    expect(handle().secret()).toBe(KEY);
  });
});

describe("SMM-05 · key alias resolution (D-5 custody split (b))", () => {
  it("resolves the default alias from SOCIAL_POSTIZ_ORG_API_KEY", () => {
    expect(resolveOrgApiKey(DEFAULT_KEY_REF, { SOCIAL_POSTIZ_ORG_API_KEY: "k1" } as NodeJS.ProcessEnv)).toBe("k1");
  });

  it("resolves a named alias from its own env var", () => {
    expect(envVarForKeyRef("acme-brand")).toBe("SOCIAL_POSTIZ_ORG_API_KEY__ACME_BRAND");
    expect(resolveOrgApiKey("acme-brand", { SOCIAL_POSTIZ_ORG_API_KEY__ACME_BRAND: "k2" } as NodeJS.ProcessEnv)).toBe("k2");
  });

  it("NEVER falls back to the default key for an unresolvable alias", () => {
    // This is the wrong-account-publish nightmare arriving through the side door: falling back
    // would call client A's org with whatever credential happened to be configured.
    expect(() => resolveOrgApiKey("acme-brand", { SOCIAL_POSTIZ_ORG_API_KEY: "k1" } as NodeJS.ProcessEnv))
      .toThrowError(/no publisher API key is configured for alias 'acme-brand'/);
    try {
      resolveOrgApiKey("acme-brand", { SOCIAL_POSTIZ_ORG_API_KEY: "k1" } as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as SocialPublisherError).code).toBe("org_key_unresolved");
      // The refusal names the alias and the env var to set — never the key it would have used.
      expect((err as Error).message).not.toContain("k1");
    }
  });

  it("refuses an empty ref rather than guessing", () => {
    expect(() => resolveOrgApiKey("", {} as NodeJS.ProcessEnv)).toThrowError(/names no credential alias/);
    expect(describeKeyRef(null)).toBe("(unset)");
  });
});

describe("SMM-05 · capability matrix — the four OQ-1 research returns, encoded", () => {
  const postizCaps = new Set<PublisherCapability>([
    "org_verify", "integrations", "schedule", "account_metrics", "post_metrics",
  ]);
  const inboxCapableCaps = new Set<PublisherCapability>([
    "org_verify", "integrations", "schedule", "account_metrics", "post_metrics", "inbox_read",
  ]);

  it("TikTok comments are false BECAUSE OF THE NETWORK — no comment scope exists (§A4h)", () => {
    // The reason matters as much as the boolean: a driver swap would not help here, and a console
    // that said "our engine cannot" would send someone off to evaluate Mixpost for nothing.
    const caps = resolveAccountCapabilities("tiktok", inboxCapableCaps);
    expect(caps.comments).toBe(false);
    expect(caps.unsupported.comments).toBe("network");
  });

  it("LinkedIn, YouTube and TikTok DMs are false because NO DM API EXISTS (§A4e/§A4g/§A4h)", () => {
    for (const network of ["linkedin", "youtube", "tiktok"]) {
      const caps = resolveAccountCapabilities(network, inboxCapableCaps);
      expect(caps.dm, network).toBe(false);
      expect(caps.unsupported.dm, network).toBe("network");
    }
  });

  it("Instagram/Facebook DMs are a NETWORK capability — only the driver stands in the way", () => {
    // OQ-4's answer in full: only these two could ever offer DMs, and today's engine cannot reach
    // even those. Two different facts, kept distinguishable.
    for (const network of ["instagram", "facebook"]) {
      expect(resolveAccountCapabilities(network, inboxCapableCaps).dm, network).toBe(true);
      expect(resolveAccountCapabilities(network, postizCaps).dm, network).toBe(false);
      expect(resolveAccountCapabilities(network, postizCaps).unsupported.dm, network).toBe("driver");
    }
  });

  it("under a driver with no inbound surface, EVERY network reports comments false (spike §8b)", () => {
    for (const network of KNOWN_NETWORKS) {
      expect(resolveAccountCapabilities(network, postizCaps).comments, network).toBe(false);
    }
    // ...and Instagram's reason is 'driver', not 'network' — Meta's API genuinely has comments.
    expect(resolveAccountCapabilities("instagram", postizCaps).unsupported.comments).toBe("driver");
  });

  it("YouTube and TikTok cannot post publicly — the audit locks (§A4g/§A4h)", () => {
    expect(resolveAccountCapabilities("youtube", postizCaps).directPost).toBe(false);
    expect(resolveAccountCapabilities("tiktok", postizCaps).directPost).toBe(false);
    // TikTok additionally cannot be SCHEDULED while OQ-8 is open.
    expect(resolveAccountCapabilities("tiktok", postizCaps).schedule).toBe(false);
  });

  it("Facebook is the only network with NATIVE scheduling (§A4i)", () => {
    expect(resolveAccountCapabilities("facebook", postizCaps).nativeSchedule).toBe(true);
    expect(resolveAccountCapabilities("instagram", postizCaps).nativeSchedule).toBe(false);
  });

  it("an unresearched network reports 'unverified', not a confident no", () => {
    const caps = resolveAccountCapabilities("bluesky", postizCaps);
    expect(caps.comments).toBe(false);
    expect(caps.unsupported.comments).toBe("unverified");
  });

  it("maps engine connection state onto 0105's status vocabulary", () => {
    expect(deriveAccountStatus({ id: "i", network: "instagram", handle: "h" })).toBe("connected");
    // refreshNeeded -> 'expiring' (the state that TRIGGERS a nudge), never 'expired'.
    expect(deriveAccountStatus({ id: "i", network: "instagram", handle: "h", refreshNeeded: true })).toBe("expiring");
    expect(deriveAccountStatus({ id: "i", network: "instagram", handle: "h", disabled: true })).toBe("expired");
    expect(deriveAccountStatus({ id: "i", network: "instagram", handle: "h", error: "boom" })).toBe("error");
  });
});

describe("SMM-05 · the Postiz driver speaks HTTP+JSON and nothing else", () => {
  it("sends the org key ONLY as an Authorization header, against the configured host", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await driverWithFetch(fetchImpl).listIntegrations(handle());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://10.88.0.2:4007/api/public/v1/integrations");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(KEY);
    // The key must not appear anywhere else on the wire — not in the URL, not in a body.
    expect(calls[0].url).not.toContain(KEY);
    expect(String(calls[0].init.body ?? "")).not.toContain(KEY);
  });

  it("turns a transport failure into publisher_unreachable, loudly", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(driverWithFetch(fetchImpl).listIntegrations(handle()))
      .rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("carries the upstream STATUS but never re-throws the upstream BODY", async () => {
    // The spike's verified unauthenticated answer, verbatim.
    const fetchImpl = vi.fn(async () => jsonResponse({ msg: "No API Key found" }, 401)) as unknown as typeof fetch;
    try {
      await driverWithFetch(fetchImpl).verifyOrg(handle());
      throw new Error("should have refused");
    } catch (err) {
      const e = err as SocialPublisherError;
      expect(e.code).toBe("publisher_http_error");
      expect(e.upstreamStatus).toBe(401);
      // Content from the licence zone does not get republished into our surfaces.
      expect(e.message).not.toContain("No API Key found");
    }
  });

  it("refuses createOrg with capability_unsupported — there is no such route (spike §6)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(driverWithFetch(fetchImpl).createOrg({ name: "x" }))
      .rejects.toMatchObject({ code: "capability_unsupported" });
    // ...and it did not attempt a call to find out.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not implement the inbox surface at all (spike §8b: the engine has none)", () => {
    const d = driverWithFetch(vi.fn() as unknown as typeof fetch);
    // ABSENT, not throwing: a method that threw would read as a bug, while an absent one is a
    // capability fact the registry mirrors and the console explains.
    expect(d.listComments).toBeUndefined();
    expect(d.sendReply).toBeUndefined();
    expect(d.capabilities.has("inbox_read")).toBe(false);
    expect(d.capabilities.has("inbox_reply")).toBe(false);
  });

  it("refuses a dispatch with no one-shot approval id (D-6), before any network call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(driverWithFetch(fetchImpl).schedulePost(handle(), {
      integrationId: "i-1", network: "instagram", body: "hi", approvalId: "", variantId: "v-1",
    })).rejects.toMatchObject({ code: "approval_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends our approval id or variant id to the licence zone", async () => {
    let sent = "";
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? "");
      return jsonResponse({ id: "p-1" });
    }) as unknown as typeof fetch;
    await driverWithFetch(fetchImpl).schedulePost(handle(), {
      integrationId: "i-1", network: "instagram", body: "hi",
      approvalId: "approval-42", variantId: "variant-7",
    });
    expect(sent).not.toContain("approval-42");
    expect(sent).not.toContain("variant-7");
  });

  it("refuses an AMBIGUOUS publish rather than retrying it (design §11)", async () => {
    // A 2xx with no post id. Off-machine since SMM-04b, this stopped being theoretical — and a
    // blind re-dispatch is how one approval becomes two public posts.
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(driverWithFetch(fetchImpl).schedulePost(handle(), {
      integrationId: "i-1", network: "instagram", body: "hi", approvalId: "a", variantId: "v",
    })).rejects.toMatchObject({ code: "publisher_http_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // exactly once — no retry
  });

  it("batches the status sweep into ONE ranged call, not one per post (§A4l §4)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { id: "p-1", state: "PUBLISHED", releaseURL: "https://x.invalid/1" },
      { id: "p-2", state: "QUEUE" },
      { id: "p-3", state: "PUBLISHED" },
    ])) as unknown as typeof fetch;
    const out = await driverWithFetch(fetchImpl).getPostStatus(handle(), ["p-1", "p-2"], { from: "2026-08-01", to: "2026-08-31" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out.map((p) => p.providerPostId)).toEqual(["p-1", "p-2"]);
    expect(out[0]).toMatchObject({ state: "published", publishedUrl: "https://x.invalid/1" });
  });

  it("prices only X, and prices a link post differently (design §05 / OQ-2)", () => {
    const d = driverWithFetch(vi.fn() as unknown as typeof fetch);
    expect(d.estimateCostUsd({ network: "instagram" })).toBe(0);
    expect(d.estimateCostUsd({ network: "linkedin", items: 10 })).toBe(0);
    expect(d.estimateCostUsd({ network: "x" })).toBe(X_POST_USD);
    expect(d.estimateCostUsd({ network: "x", hasLink: true })).toBe(X_POST_WITH_LINK_USD);
    expect(d.estimateCostUsd({ network: "x", items: 3 })).toBeCloseTo(X_POST_USD * 3, 10);
  });
});

describe("SMM-05 · quota is READ LIVE or reported unknown — never a constant (§A4f)", () => {
  it("does not advertise quota_probe, and returns undefined, when no trigger is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const d = driverWithFetch(fetchImpl); // no quotaProbeTool
    expect(d.capabilities.has("quota_probe")).toBe(false);
    const out = await d.getQuota(handle(), { id: "i-1", network: "instagram", handle: "h", networkAccountId: "17841" });
    expect(out).toBeUndefined();
    // Crucially: it did NOT invent a cap, and it did not call anything to try.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the account's OWN limit when the probe is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ quota_usage: 7, config: { quota_total: 100, quota_duration: 86400 } }],
    })) as unknown as typeof fetch;
    const d = driverWithFetch(fetchImpl, "content_publishing_limit");
    expect(d.capabilities.has("quota_probe")).toBe(true);
    const out = await d.getQuota(handle(), { id: "i-1", network: "instagram", handle: "h", networkAccountId: "17841" });
    // 100 comes from the ACCOUNT, not from us. Meta's doc says 100 in one place and 50 in another,
    // and the design's long-carried "25" appears nowhere in it — which is exactly why we ask.
    expect(out).toEqual({ igPosts24h: { used: 7, cap: 100 } });
  });

  it("returns undefined (unknown) rather than throwing when the engine cannot carry the probe", async () => {
    // The documented upstream gap: `integration-trigger` is gated on a `@Tool` decorator the
    // TikTok provider provably lacks and the Instagram provider may lack. An unavailable probe is
    // an expected outcome, not an incident — and one account's gap must not fail the whole sync.
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "not found" }, 404)) as unknown as typeof fetch;
    const d = driverWithFetch(fetchImpl, "content_publishing_limit");
    await expect(d.getQuota(handle(), { id: "i", network: "instagram", handle: "h", networkAccountId: "1" }))
      .resolves.toBeUndefined();
  });

  it("parses nothing into nothing — a partial payload is UNKNOWN, never a default", () => {
    expect(parseContentPublishingLimit({})).toBeUndefined();
    expect(parseContentPublishingLimit({ data: [{ quota_usage: 3 }] })).toBeUndefined();          // no cap
    expect(parseContentPublishingLimit({ data: [{ config: { quota_total: 50 } }] })).toBeUndefined(); // no usage
  });

  it("carries NO quota constant anywhere in the publisher sources", () => {
    // A regression pin with teeth: the obsolete "25 posts/24h" (and the equally obsolete
    // youtubeUnitsToday: 1600) must never reappear as a literal in a quota position. Reading the
    // sources is cruder than a type, and it is exactly what catches a well-meaning "sensible
    // default" added in a hurry.
    for (const file of ["postiz.ts", "capabilities.ts", "provisioning.ts"]) {
      const src = readFileSync(join(__dirname, file), "utf8");
      // strip comments — the reasoning ABOUT the numbers is the point of this ticket
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code, file).not.toMatch(/igPosts24h\s*:\s*\{\s*used\s*:\s*\d/);
      expect(code, file).not.toMatch(/cap\s*:\s*(25|50|100)\b/);
      expect(code, file).not.toMatch(/youtubeUnitsToday/);
    }
  });
});

describe("SMM-05 · response normalizers are tolerant but never inventive", () => {
  it("skips an integration row it cannot key, rather than guessing", () => {
    const out = normalizeIntegrations([
      { id: "i-1", providerIdentifier: "INSTAGRAM", profile: "@brand", name: "Brand" },
      { id: "i-2" },                              // no network
      { providerIdentifier: "linkedin" },          // no id
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "i-1", network: "instagram", handle: "@brand" });
  });

  it("maps an unknown post state to 'unknown' rather than optimistically to 'published'", () => {
    expect(normalizePosts([{ id: "p", state: "SOMETHING_NEW" }])[0].state).toBe("unknown");
  });
});

describe("SMM-05 · the registry fails closed and instruments every call", () => {
  it("refuses publisher_not_configured when nothing is registered", () => {
    resetPublishers();
    expect(() => resolvePublisher("postiz")).toThrowError(/no social publisher is configured/);
    try { resolvePublisher("postiz"); } catch (e) {
      expect((e as SocialPublisherError).code).toBe("publisher_not_configured");
    }
  });

  it("honours-or-refuses a named driver — it never substitutes a different engine", () => {
    resetPublishers();
    registerPublisher(createMockPublisher(newMockPublisherState()));
    expect(resolvePublisher("postiz").key).toBe("postiz");
    try { resolvePublisher("mixpost"); } catch (e) {
      expect((e as SocialPublisherError).code).toBe("unknown_publisher");
    }
    resetPublishers();
  });

  it("normalizes a raw thrown Error into a typed refusal (no body-less 500s)", async () => {
    await expect(invokePublisher({ op: "test" }, async () => { throw new Error("socket hang up"); }))
      .rejects.toMatchObject({ code: "publisher_unreachable", name: "SocialPublisherError" });
  });

  it("passes a typed refusal through unchanged", async () => {
    await expect(invokePublisher({ op: "test" }, async () => {
      throw new SocialPublisherError("capability_unsupported", "nope");
    })).rejects.toMatchObject({ code: "capability_unsupported" });
  });
});

describe("SMM-05 · boot: unreachable is fine, PUBLIC is a boot error", () => {
  it("accepts the tunnel address", () => {
    expect(() => assertPublisherBaseUrlIsPrivate("http://10.88.0.2:4007", false)).not.toThrow();
    expect(() => assertPublisherBaseUrlIsPrivate("http://127.0.0.1:4007", false)).not.toThrow();
  });

  it("refuses a public address — the containment perimeter moved", () => {
    expect(() => assertPublisherBaseUrlIsPrivate("https://postiz.example.com", false))
      .toThrowError(PublicPublisherBaseUrlError);
  });

  it("treats an unset base URL as a supported deployment, not an error", () => {
    // Keyless/URL-less is the DEFAULT. The platform boots, reads keep working, and publisher paths
    // refuse with a typed 503 — which is the whole "degrades visibly" requirement.
    expect(() => assertPublisherBaseUrlIsPrivate("", false)).not.toThrow();
  });

  it("has an override for a deliberately proxied deployment", () => {
    expect(() => assertPublisherBaseUrlIsPrivate("https://postiz.example.com", true)).not.toThrow();
  });
});

describe("SMM-05 · containment, asserted inside the suite as well as in CI", () => {
  it("declares no Postiz package dependency", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "package.json"), "utf8"));
    const names = [
      ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
    expect(names.filter((n) => /postiz|gitroom/i.test(n))).toEqual([]);
  });

  it("imports nothing from outside this repo in the driver", () => {
    // The lint (npm run lint:postiz-deps) is the CI gate; this is the local one, and it is
    // stricter: the driver may import ONLY relative paths. A third-party HTTP client, a Postiz
    // types package, a generated SDK — all of them fail here before anyone reaches CI.
    const src = readFileSync(join(__dirname, "postiz.ts"), "utf8");
    const specifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s.startsWith("."))).toBe(true);
  });
});
