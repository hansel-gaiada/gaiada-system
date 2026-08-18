// SMM-36 — the retention policy map. Pure functions; no DB, no Cerbos, no network.
//
// The point of this suite, mirroring media-rules.test.ts's own framing: the design claim is "never
// invent a retention number for a network nobody has researched", and each case below is a check
// that the map actually honours it, not just says it in a comment.
import { describe, it, expect } from "vitest";
import { KNOWN_NETWORKS } from "./publisher/capabilities";
import { getRetentionPolicy, hasDocumentedRetentionCap } from "./retention-policy";

describe("social inbox retention policy (SMM-36)", () => {
  it("covers every network the schema admits — no silent gap between KNOWN_NETWORKS and this map", () => {
    // Every network must resolve to SOME policy (documented or unverified), never throw and never
    // fall through to the unmodelled-network branch for a network the schema actually allows.
    for (const network of KNOWN_NETWORKS) {
      const policy = getRetentionPolicy(network);
      expect(policy.citation.length).toBeGreaterThan(0);
      expect(policy.citation).not.toMatch(/not in the modeled fleet/);
    }
  });

  it("LinkedIn carries the two DOCUMENTED numbers from the addendum, and only LinkedIn", () => {
    const li = getRetentionPolicy("linkedin");
    expect(li.evidence).toBe("documented");
    expect(li.profileDataMaxHours).toBe(24);
    expect(li.activityContentMaxHours).toBe(48);
    expect(hasDocumentedRetentionCap("linkedin")).toBe(true);

    const documented = KNOWN_NETWORKS.filter((n) => getRetentionPolicy(n).evidence === "documented");
    expect(documented).toEqual(["linkedin"]);
  });

  it("every OTHER known network is explicitly unverified, never a guessed default", () => {
    for (const network of KNOWN_NETWORKS) {
      if (network === "linkedin") continue;
      const policy = getRetentionPolicy(network);
      expect(policy.evidence).toBe("unverified");
      expect(policy.profileDataMaxHours).toBeNull();
      expect(policy.activityContentMaxHours).toBeNull();
      expect(hasDocumentedRetentionCap(network)).toBe(false);
    }
  });

  it("an unmodelled network fails the same way capabilities.ts's unmodelled branch does: unverified, never a guess", () => {
    const policy = getRetentionPolicy("myspace");
    expect(policy.evidence).toBe("unverified");
    expect(policy.profileDataMaxHours).toBeNull();
    expect(policy.activityContentMaxHours).toBeNull();
    expect(policy.citation).toMatch(/not in the modeled fleet/);
    expect(hasDocumentedRetentionCap("myspace")).toBe(false);
  });

  it("X stays unverified even though it is the metered network everything else treats specially", () => {
    // A regression guard against the temptation to special-case X here the way media-rules.ts and
    // publish-precondition.ts both do for cost/impact reasons — retention research never covered it.
    const x = getRetentionPolicy("x");
    expect(x.evidence).toBe("unverified");
  });
});
