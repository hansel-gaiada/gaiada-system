// SMM-38 phase 38c — the `direct` driver's first REAL capability (LinkedIn org-page publish, media
// upload, comment read), plus the shared port contract suite run against it. No live LinkedIn app
// credential exists (D-23) — every network-touching case below drives a STUB `fetchImpl`, never a
// real socket, per the ticket's own "reuse platform_app_not_registered / drive a stub, never pretend
// to reach a real network" instruction.
import { describe, expect, it, vi } from "vitest";
import { OrgHandle, SocialPublisherError } from "./types";
import { createDirectDriver } from "./direct";
import { runPublisherContractSuite } from "./publisher-contract";

const ORG = new OrgHandle("row-1", "org-abc", "unused-key");
/** A LinkedIn-shaped handle: `orgId` carries the organization URN, `secret()` carries the
 *  already-resolved bearer token — see direct.ts's header for why `OrgHandle` is repurposed this way
 *  for the `direct` driver. */
const LINKEDIN_ORG = new OrgHandle("acct-1", "urn:li:organization:12345", "bearer-token-never-logged");

/** A fetchImpl that always fails at the transport layer — proves every 38c-real method wraps a
 *  transport failure into a TYPED `publisher_unreachable`, never an untyped crash, without this
 *  suite ever opening a real socket. */
const unreachableFetch = vi.fn(async () => {
  throw new Error("stub: no real network in tests");
}) as unknown as typeof fetch;

describe("SMM-38 · the `direct` driver skeleton (38a) is still honest for everything it does not cover", () => {
  it("advertises 'direct' and EXACTLY the three capabilities 38c made real — nothing more", () => {
    const d = createDirectDriver();
    expect(d.key).toBe("direct");
    expect([...d.capabilities].sort()).toEqual(["inbox_read", "media_upload", "schedule"]);
  });

  it("sendReply/getCreatorInfo stay ABSENT — SMM-17/TikTok are out of this phase's scope", () => {
    const d = createDirectDriver();
    expect(d.sendReply).toBeUndefined();
    expect(d.getCreatorInfo).toBeUndefined();
  });

  it("listComments is now PRESENT — inbox_read is a real capability, not an optional gap", () => {
    const d = createDirectDriver();
    expect(d.listComments).toBeDefined();
  });

  it("refuses every member 38c did not touch with a TYPED capability_unsupported", async () => {
    const d = createDirectDriver();
    const calls: Array<Promise<unknown>> = [
      d.createOrg({ name: "x" }),
      d.verifyOrg(ORG),
      d.connectUrl(ORG, "linkedin", "https://example.invalid/callback"),
      d.listIntegrations(ORG),
      d.getQuota(ORG, { id: "i", network: "linkedin", handle: "@h" }),
      d.cancelPost(ORG, "p-1"),
      d.getPostStatus(ORG, ["p-1"]),
      d.getAccountMetrics(ORG, "i", { from: "2026-01-01", to: "2026-01-02" }),
      d.getPostMetrics(ORG, ["p-1"]),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(SocialPublisherError);
      await expect(call).rejects.toMatchObject({ code: "capability_unsupported" });
    }
  });

  it("estimateCostUsd is $0 for every network — LinkedIn is not metered", () => {
    const d = createDirectDriver();
    expect(d.estimateCostUsd({ network: "linkedin" })).toBe(0);
    expect(d.estimateCostUsd({ network: "x", hasLink: true })).toBe(0);
  });
});

describe("SMM-38c · schedulePost — LinkedIn org-page publish is real; every other network still refuses", () => {
  it("checks the one-shot approval id FIRST, unconditionally — before ever looking at the network", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(LINKEDIN_ORG, {
        integrationId: "i", network: "linkedin", body: "hi", approvalId: "", variantId: "v-1",
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
    // No network call was attempted — the stub was never invoked.
    expect(unreachableFetch).not.toHaveBeenCalled();
  });

  it("a non-LinkedIn network refuses capability_unsupported even though `schedule` is advertised " +
     "driver-wide — the per-network gate the header documents", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(ORG, { integrationId: "i", network: "instagram", body: "hi", approvalId: "a-1", variantId: "v-1" }),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("an approved LinkedIn dispatch that cannot reach the network refuses publisher_unreachable, " +
     "never a crash, never a silent success", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.schedulePost(LINKEDIN_ORG, {
        integrationId: "i", network: "linkedin", body: "hi", approvalId: "a-1", variantId: "v-1",
      }),
    ).rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("a successful LinkedIn publish returns the URN from the `x-restli-id` response header", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/rest/posts");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bearer-token-never-logged" });
      const body = JSON.parse(String(init?.body));
      expect(body.author).toBe("urn:li:organization:12345");
      expect(body.commentary).toBe("hello linkedin");
      return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:999" } });
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const res = await d.schedulePost(LINKEDIN_ORG, {
      integrationId: "i", network: "linkedin", body: "hello linkedin", approvalId: "a-1", variantId: "v-1",
    });
    expect(res).toEqual({ providerPostId: "urn:li:share:999" });
  });

  it("an accepted-but-id-less response refuses honestly rather than guessing — design §11's " +
     "no-auto-retry-of-ambiguous-outcomes rule", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 201 })) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    await expect(
      d.schedulePost(LINKEDIN_ORG, { integrationId: "i", network: "linkedin", body: "hi", approvalId: "a-1", variantId: "v-1" }),
    ).rejects.toMatchObject({ code: "publisher_http_error" });
  });
});

describe("SMM-38c · uploadMedia — LinkedIn's register→PUT asset flow", () => {
  it("a transport failure refuses publisher_unreachable, never a crash", async () => {
    const d = createDirectDriver({ fetchImpl: unreachableFetch });
    await expect(
      d.uploadMedia(LINKEDIN_ORG, { filename: "a.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: "publisher_unreachable" });
  });

  it("register + PUT succeeds and returns the asset URN as the media id", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("initializeUpload")) {
        return new Response(
          JSON.stringify({ value: { uploadUrl: "https://upload.linkedin.example/put-here", image: "urn:li:image:abc" } }),
          { status: 200 },
        );
      }
      if (u === "https://upload.linkedin.example/put-here") {
        expect(init?.method).toBe("PUT");
        return new Response("", { status: 201 });
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const res = await d.uploadMedia(LINKEDIN_ORG, { filename: "a.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(res).toEqual({ id: "urn:li:image:abc" });
  });
});

describe("SMM-38c · listComments — pullComments, the reason this phase exists", () => {
  it("is keyed by providerPostId (a LinkedIn share URN), not an account integration id — see the " +
     "header's documented departure from the port's account-wide doc", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/rest/socialActions/urn%3Ali%3Ashare%3A999/comments");
      return new Response(
        JSON.stringify({
          elements: [
            {
              $URN: "urn:li:comment:1",
              actor: "urn:li:person:abc",
              message: { text: "nice post!" },
              created: { time: Date.parse("2026-08-02T00:00:00Z") },
            },
            // Older than `since` — must be filtered out client-side.
            {
              $URN: "urn:li:comment:0",
              actor: "urn:li:person:xyz",
              message: { text: "too old" },
              created: { time: Date.parse("2026-07-01T00:00:00Z") },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const d = createDirectDriver({ fetchImpl });
    const items = await d.listComments!(LINKEDIN_ORG, "urn:li:share:999", since);
    expect(items).toEqual([
      {
        externalId: "urn:li:comment:1",
        externalThreadId: "urn:li:share:999",
        kind: "comment",
        authorHandle: "urn:li:person:abc",
        authorName: undefined,
        body: "nice post!",
        postedAt: "2026-08-02T00:00:00.000Z",
      },
    ]);
  });
});

// SMM-38's own acceptance bar: the shared port contract, generalised, run against this driver too.
// A STUB fetchImpl throughout — the contract suite's "does its job OR refuses with a TYPED error"
// case for `uploadMedia` gets a typed `publisher_unreachable` from the stub, never a real socket.
runPublisherContractSuite("direct", {
  build: () => createDirectDriver({ fetchImpl: unreachableFetch }),
  integration: { id: "urn:li:share:contract", network: "linkedin", handle: "@contract" },
});
