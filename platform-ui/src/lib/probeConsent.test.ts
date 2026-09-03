import { describe, it, expect } from "vitest";
import {
  consentState, pendingConsentRequests, basisError,
  PROBE_CONSENT_ATTESTATION, PROBE_CONSENT_WORKFLOW, CONSENT_BASIS_MAX,
  type PendingConsentRequest,
} from "./probeConsent";
import type { FlatSite, PortfolioSite } from "./webdeskPortfolio";

function site(over: Partial<FlatSite>): FlatSite {
  const base: PortfolioSite = {
    id: "s1", domain: over.domain ?? "example.com", environment: "production",
    hostKind: "our-box", hostRef: null, access: "none", kind: null, adoption: "tracked",
    repoUrl: null, repoBranch: null, contractVersion: null, origin: "probe",
    propertyId: over.propertyId ?? null,
    hostingProvider: null, controlPanel: null, stack: null, topologyCheckedAt: null,
    crawlConsent: over.crawlConsent ?? false, notes: null,
  };
  return { ...base, clientName: null, projectName: null, projectId: null, clientId: null };
}

const req = (over: Partial<PendingConsentRequest> = {}): PendingConsentRequest => ({
  approvalId: over.approvalId ?? "aa-1",
  propertyId: over.propertyId ?? "p1",
  domain: over.domain ?? "example.com",
  basis: over.basis ?? "MSA clause 7.2",
  requestedBy: null,
  createdAt: null,
});

describe("consentState — four answers, and none of them may be collapsed", () => {
  it("is GRANTED when consent is on record", () => {
    expect(consentState(site({ crawlConsent: true, propertyId: "p1" }), [])).toEqual({ kind: "granted" });
  });

  it("is REQUESTABLE when a property exists and nothing is open", () => {
    expect(consentState(site({ propertyId: "p1" }), [])).toEqual({ kind: "requestable", propertyId: "p1" });
  });

  it("is PENDING when a request for THIS property is open", () => {
    const open = req({ propertyId: "p1" });
    expect(consentState(site({ propertyId: "p1" }), [open])).toEqual({ kind: "pending", request: open });
  });

  it("does not treat another property's open request as this one's", () => {
    // The join is on propertyId, not domain: two portfolio rows can share a domain across
    // environments, and a request is about the PROPERTY.
    expect(consentState(site({ propertyId: "p1" }), [req({ propertyId: "p2" })]))
      .toEqual({ kind: "requestable", propertyId: "p1" });
  });

  it("is NO-PROPERTY when the domain has no SEO property row — NOT 'requestable'", () => {
    // The distinction the whole flow rests on. A domain with no property row has nothing that
    // could carry `verified_at`, so offering "request consent" would file a request nobody can
    // action. Most of the 63 unconsented sites on the live estate are in exactly this state.
    expect(consentState(site({ propertyId: null }), [])).toEqual({ kind: "no-property" });
  });

  it("prefers GRANTED over a stale open request", () => {
    // Consent arriving by another route (someone verified the property in the SEO console) must
    // win: the flow's job is done, whatever the queue still says.
    expect(consentState(site({ crawlConsent: true, propertyId: "p1" }), [req({ propertyId: "p1" })]))
      .toEqual({ kind: "granted" });
  });
});

describe("pendingConsentRequests — shaping an untyped jsonb column", () => {
  it("keeps only this workflow's rows", () => {
    const rows = pendingConsentRequests([
      { id: "a", workflowId: PROBE_CONSENT_WORKFLOW, toolArgs: { propertyId: "p1", domain: "a.com", basis: "b" } },
      { id: "b", workflowId: "iam:position_assign", toolArgs: { positionId: "x", userId: "u" } },
    ]);
    expect(rows.map((r) => r.approvalId)).toEqual(["a"]);
  });

  it("drops a row that names no property rather than rendering it against the wrong site", () => {
    // `tool_args` is jsonb and carries a different shape per workflow, so every field is checked
    // rather than cast. A malformed row must vanish, not attach itself to a domain.
    const rows = pendingConsentRequests([
      { id: "a", workflowId: PROBE_CONSENT_WORKFLOW, toolArgs: { domain: "a.com" } },
      { id: "b", workflowId: PROBE_CONSENT_WORKFLOW, toolArgs: null },
      { id: "c", workflowId: PROBE_CONSENT_WORKFLOW, toolArgs: { propertyId: 42 } },
    ]);
    expect(rows).toEqual([]);
  });

  it("ignores a decided row when the list carries mixed statuses", () => {
    const rows = pendingConsentRequests([
      { id: "a", workflowId: PROBE_CONSENT_WORKFLOW, status: "approved", toolArgs: { propertyId: "p1" } },
      { id: "b", workflowId: PROBE_CONSENT_WORKFLOW, status: "pending", toolArgs: { propertyId: "p2" } },
    ]);
    expect(rows.map((r) => r.propertyId)).toEqual(["p2"]);
  });

  it("carries the basis through, because the approver needs it", () => {
    const rows = pendingConsentRequests([
      { id: "a", workflowId: PROBE_CONSENT_WORKFLOW, toolArgs: { propertyId: "p1", basis: "MSA 7.2" } },
    ]);
    expect(rows[0].basis).toBe("MSA 7.2");
  });
});

describe("basisError — RULING §2, the note is mandatory", () => {
  it("refuses empty and whitespace-only", () => {
    for (const v of ["", "   ", "\t\n"]) expect(basisError(v)).toBeTruthy();
  });
  it("refuses something too short to be a reference", () => {
    expect(basisError("x")).toBeTruthy();
  });
  it("accepts a real reference", () => {
    expect(basisError("MSA clause 7.2")).toBeNull();
    expect(basisError("GDA-412")).toBeNull();
  });
  it("refuses one long enough to be abuse of the field", () => {
    expect(basisError("x".repeat(CONSENT_BASIS_MAX + 1))).toBeTruthy();
  });
  it("says WHAT to cite, not merely that the field is required", () => {
    // The message is the only guidance the requester gets; "required" alone would send them
    // looking for the rule elsewhere.
    expect(basisError("")).toMatch(/contract clause|email|ticket/i);
  });
});

describe("the attestation is the compliance artefact", () => {
  it("is the exact sentence the owner ruled, verbatim", () => {
    // Ruling §3. Changing this string changes what people are agreeing to, so it is pinned here
    // rather than left to a refactor. The backend keeps its own copy and stores it ON the record,
    // so a grant always carries the words actually agreed to — this test is what keeps the two in
    // step while they are supposed to be identical.
    expect(PROBE_CONSENT_ATTESTATION).toBe(
      "I confirm monitoring this domain is covered by our service agreement with this client.",
    );
  });

  it("claims the service agreement, not the client's written permission", () => {
    // The rejected alternative was a stronger claim we could not evidence per-domain for 63
    // domains. If someone later "strengthens" this wording, that is a ruling change, not a tidy-up.
    expect(PROBE_CONSENT_ATTESTATION).toMatch(/service agreement/);
    expect(PROBE_CONSENT_ATTESTATION).not.toMatch(/written permission/);
  });
});
