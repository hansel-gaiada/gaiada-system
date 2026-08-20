// SMM-38/38a (design addendum §PD) — the `direct` driver skeleton, and the shared port contract
// suite run against it. No database, no Cerbos, no network call — this driver makes none.
import { describe, expect, it } from "vitest";
import { OrgHandle, SocialPublisherError } from "./types";
import { createDirectDriver } from "./direct";
import { runPublisherContractSuite } from "./publisher-contract";

const ORG = new OrgHandle("row-1", "org-abc", "unused-key");

describe("SMM-38 · the `direct` driver skeleton (38a) is honest, not half-working", () => {
  it("advertises 'direct' and an EMPTY capability set — nothing is implemented yet", () => {
    const d = createDirectDriver();
    expect(d.key).toBe("direct");
    expect(d.capabilities.size).toBe(0);
  });

  it("has no inbox surface at all — listComments/sendReply are ABSENT, matching Postiz's own gap", () => {
    const d = createDirectDriver();
    expect(d.listComments).toBeUndefined();
    expect(d.sendReply).toBeUndefined();
    expect(d.getCreatorInfo).toBeUndefined();
  });

  it("refuses every required member with a TYPED capability_unsupported — never resolves, never crashes untyped", async () => {
    const d = createDirectDriver();
    const req = { integrationId: "i", network: "linkedin" as const, body: "hi", approvalId: "a", variantId: "v" };
    const calls: Array<Promise<unknown>> = [
      d.createOrg({ name: "x" }),
      d.verifyOrg(ORG),
      d.connectUrl(ORG, "linkedin", "https://example.invalid/callback"),
      d.listIntegrations(ORG),
      d.getQuota(ORG, { id: "i", network: "linkedin", handle: "@h" }),
      d.schedulePost(ORG, req),
      d.cancelPost(ORG, "p-1"),
      d.getPostStatus(ORG, ["p-1"]),
      d.uploadMedia(ORG, { filename: "x.png", contentType: "image/png", bytes: new Uint8Array() }),
      d.getAccountMetrics(ORG, "i", { from: "2026-01-01", to: "2026-01-02" }),
      d.getPostMetrics(ORG, ["p-1"]),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(SocialPublisherError);
      await expect(call).rejects.toMatchObject({ code: "capability_unsupported" });
    }
  });

  it("schedulePost refuses BEFORE ever checking the approval id — it cannot schedule at all yet, " +
     "so an ABSENT approval must not be the reason given", async () => {
    const d = createDirectDriver();
    // Even a well-formed approved request refuses the same way: the gap is "cannot schedule",
    // never "forgot the approval" (D-6's own check is Postiz/mock's job, not this skeleton's).
    await expect(d.schedulePost(ORG, {
      integrationId: "i", network: "linkedin", body: "hi", approvalId: "approval-1", variantId: "v-1",
    })).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("estimateCostUsd is $0 — it cannot dispatch to any network, metered or not", () => {
    const d = createDirectDriver();
    expect(d.estimateCostUsd({ network: "linkedin" })).toBe(0);
    expect(d.estimateCostUsd({ network: "x", hasLink: true })).toBe(0);
  });

  it("names the phase in its refusal message, so an operator knows what to wait for", async () => {
    const d = createDirectDriver();
    try {
      await d.schedulePost(ORG, { integrationId: "i", network: "linkedin", body: "hi", approvalId: "a", variantId: "v" });
      throw new Error("should have refused");
    } catch (err) {
      expect((err as Error).message).toContain("38a");
      expect((err as Error).message).toContain("schedulePost");
    }
  });
});

// SMM-38's own acceptance bar: the shared port contract, generalised, run against this driver too.
runPublisherContractSuite("direct", { build: createDirectDriver });
