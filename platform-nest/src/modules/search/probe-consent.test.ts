import { describe, it, expect } from "vitest";
import { searchModule } from "./index";
import {
  validateConsentBasis, PROBE_CONSENT_ATTESTATION, PROBE_CONSENT_WORKFLOW, PROBE_CONSENT_TOOL,
  CONSENT_BASIS_MAX,
} from "./probe-consent";
import { getExecutable } from "../../core/approval-executables";

// Pure assertions only — no DATABASE_URL_TEST needed, so these run everywhere including a laptop
// with no containers. The DB-backed half (the grant itself, its idempotency, the approver gate) is
// exercised by the approvals suites on the Linux gate.

describe("probe consent — the reference note is mandatory (RULING §2)", () => {
  it("refuses a non-string, so a missing field is not silently an empty basis", () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(validateConsentBasis(v).ok, String(v)).toBe(false);
    }
  });

  it("refuses whitespace-only — trimmed before measuring", () => {
    for (const v of ["", "   ", "\t\n"]) expect(validateConsentBasis(v).ok, JSON.stringify(v)).toBe(false);
  });

  it("names what to cite in the refusal, not merely that a field is required", () => {
    const v = validateConsentBasis("");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/contract clause|email|ticket/i);
  });

  it("accepts a real reference and returns it TRIMMED", () => {
    const v = validateConsentBasis("  MSA clause 7.2  ");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.basis).toBe("MSA clause 7.2");
  });

  it("bounds the length, so the field cannot become free storage", () => {
    expect(validateConsentBasis("x".repeat(CONSENT_BASIS_MAX)).ok).toBe(true);
    expect(validateConsentBasis("x".repeat(CONSENT_BASIS_MAX + 1)).ok).toBe(false);
  });
});

describe("probe consent — the attestation is the compliance artefact (RULING §3)", () => {
  it("is the exact sentence the owner ruled", () => {
    expect(PROBE_CONSENT_ATTESTATION).toBe(
      "I confirm monitoring this domain is covered by our service agreement with this client.",
    );
  });

  it("claims the service agreement, not the client's written permission", () => {
    // The rejected alternative was a stronger claim we could not evidence per-domain for the 63
    // unconsented domains on the live estate. "Strengthening" this wording is a ruling change.
    expect(PROBE_CONSENT_ATTESTATION).toMatch(/service agreement/);
    expect(PROBE_CONSENT_ATTESTATION).not.toMatch(/written permission/);
  });

  it("matches platform-ui's copy of the same sentence", () => {
    // The UI duplicates it (it must render before any request exists, and the two projects share no
    // package). Pinned from both sides; the value STORED on the approval row is the authority, and
    // this pair is what keeps the label from drifting away from it while they are meant to agree.
    const uiCopy = "I confirm monitoring this domain is covered by our service agreement with this client.";
    expect(PROBE_CONSENT_ATTESTATION).toBe(uiCopy);
  });
});

describe("probe consent — the grant can never become agent-callable", () => {
  it("its tool name is NOT in the D14 executable registry", () => {
    // The registry re-drives MCP tool calls through the hub. Registering a consent-granting tool
    // would make "we may probe this client's website" something an agent can propose and an
    // approval can execute unattended. `getExecutable` returning undefined is the safe default the
    // registry's own doctrine describes, and this pins it for THIS tool specifically.
    expect(getExecutable(PROBE_CONSENT_TOOL)).toBeUndefined();
  });

  it("the search module still registers NO automation_approval.decided handler", () => {
    // The invariant `search-sem-apply.test.ts` owns, restated here from the consent side because
    // this flow is what nearly broke it. The first implementation registered a handler on that
    // event; the module's OTHER approval path is sem-apply, which spends a client's ad budget, and
    // "no handler exists" is a structural guarantee that cannot regress into "a handler that grew a
    // second branch". The grant therefore runs IN-BAND from the decide route instead.
    expect(Object.keys(searchModule.eventHandlers ?? {})).not.toContain("automation_approval.decided");
  });

  it("the workflow discriminator is stable — the decide route's authority gate keys on it", () => {
    // `automation-approvals.controller.ts` selects the extra `resource_search_property · update`
    // check by (origin='search', workflow_id). Renaming this constant without updating that branch
    // would silently drop the approver gate back to the generic `decide`.
    expect(PROBE_CONSENT_WORKFLOW).toBe("search:probe_consent");
  });
});
