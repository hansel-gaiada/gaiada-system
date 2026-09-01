import { describe, it, expect } from "vitest";
import {
  canReconcile, canStartNewProvision, activeSite, failureCopy, describeActionError,
  isValidSlugInput, PROVISION_SLUG_RE,
  type ProvisionedSite,
} from "./webdevProvisionedSites";

function site(over: Partial<ProvisionedSite> & { id: string; status: ProvisionedSite["status"] }): ProvisionedSite {
  return {
    tenantId: "co-agency", pipelineRunId: "run-1", provider: "provision", providerRef: "prov-1",
    slug: "my-site", framework: "vite", repoUrl: null, stagingUrl: null, failureReason: null,
    requestedBy: "u-1", approvalId: null, lastReconciledAt: null,
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    clientId: null, projectId: null,
    ...over,
  };
}

describe("canReconcile — mirrors provisioning.service.ts's reconcileProvisionedSite", () => {
  it("is true for every non-failed, non-live status (still in flight, or a crash-resume 'requested')", () => {
    expect(canReconcile(site({ id: "a", status: "requested" }))).toBe(true);
    expect(canReconcile(site({ id: "b", status: "pending" }))).toBe(true);
    expect(canReconcile(site({ id: "c", status: "provisioned" }))).toBe(true);
  });

  it("is false once live — terminal, nothing left to check", () => {
    expect(canReconcile(site({ id: "d", status: "live" }))).toBe(false);
  });

  it("is true for the two failure shapes that keep a far-side handle (§04: 'honest, not final')", () => {
    expect(canReconcile(site({ id: "e", status: "failed", failureReason: "poll_timeout" }))).toBe(true);
    expect(canReconcile(site({ id: "f", status: "failed", failureReason: "provider_failed" }))).toBe(true);
  });

  it("is false for failures that never got a far-side handle to re-poll — a fresh Provision is the only way forward", () => {
    expect(canReconcile(site({ id: "g", status: "failed", failureReason: "slug_conflict_foreign" }))).toBe(false);
    expect(canReconcile(site({ id: "h", status: "failed", failureReason: "egress_error" }))).toBe(false);
    expect(canReconcile(site({ id: "i", status: "failed", failureReason: "provider_rejected" }))).toBe(false);
  });

  it("is false for an unknown failure reason (never assume reconcilable for a token this UI doesn't recognize)", () => {
    expect(canReconcile(site({ id: "j", status: "failed", failureReason: "something_new" }))).toBe(false);
  });
});

describe("activeSite / canStartNewProvision — the ux_wps_run invariant, client-side", () => {
  it("no rows at all -> no active site, provisioning is offered", () => {
    expect(activeSite([])).toBeNull();
    expect(canStartNewProvision([])).toBe(true);
  });

  it("a single non-failed row is the active one, and blocks a new attempt", () => {
    const rows = [site({ id: "a", status: "live" })];
    expect(activeSite(rows)?.id).toBe("a");
    expect(canStartNewProvision(rows)).toBe(false);
  });

  it("every row failed -> no active site, a retry is offered (a failed row never holds the slot)", () => {
    const rows = [
      site({ id: "a", status: "failed", failureReason: "slug_conflict_foreign", createdAt: "2026-08-01T00:00:00Z" }),
      site({ id: "b", status: "failed", failureReason: "egress_error", createdAt: "2026-08-02T00:00:00Z" }),
    ];
    expect(activeSite(rows)).toBeNull();
    expect(canStartNewProvision(rows)).toBe(true);
  });

  it("finds the active row even when it isn't first in the array (defensive — real reads are createdAt DESC)", () => {
    const rows = [
      site({ id: "old-failed", status: "failed", failureReason: "poll_timeout" }),
      site({ id: "current", status: "pending" }),
    ];
    expect(activeSite(rows)?.id).toBe("current");
  });
});

describe("failureCopy", () => {
  it("gives every known reason a distinct remedy", () => {
    expect(failureCopy("slug_conflict_foreign").remedy).toBe("reprovision");
    expect(failureCopy("egress_error").remedy).toBe("reprovision");
    expect(failureCopy("provider_rejected").remedy).toBe("reprovision");
    expect(failureCopy("poll_timeout").remedy).toBe("reconcile");
    expect(failureCopy("provider_failed").remedy).toBe("reconcile");
    expect(failureCopy("superseded").remedy).toBe("none");
  });

  it("never throws on an unrecognized or null reason — a generic, still-honest fallback", () => {
    expect(failureCopy(null).title).toBe("Provisioning failed");
    expect(failureCopy("a_future_backend_added_this").title).toBe("Provisioning failed");
  });

  it("words slug_conflict_foreign as 'pick a different name', not a generic error", () => {
    expect(failureCopy("slug_conflict_foreign").body.toLowerCase()).toContain("different slug");
  });

  it("words poll_timeout as not final", () => {
    expect(failureCopy("poll_timeout").body.toLowerCase()).toContain("still");
  });
});

describe("isValidSlugInput / PROVISION_SLUG_RE — mirrors platform-nest's slug.ts byte-for-byte", () => {
  it("accepts lowercase alnum + hyphen, 1-40 chars", () => {
    expect(isValidSlugInput("my-project-9")).toBe(true);
    expect(isValidSlugInput("a")).toBe(true);
    expect(isValidSlugInput("a".repeat(40))).toBe(true);
  });
  it("rejects uppercase, spaces, punctuation, empty, and over-length", () => {
    expect(isValidSlugInput("My-Project")).toBe(false);
    expect(isValidSlugInput("my project")).toBe(false);
    expect(isValidSlugInput("my_project")).toBe(false);
    expect(isValidSlugInput("")).toBe(false);
    expect(isValidSlugInput("a".repeat(41))).toBe(false);
  });
  it("PROVISION_SLUG_RE is the exact same pattern", () => {
    expect(PROVISION_SLUG_RE.source).toBe("^[a-z0-9-]{1,40}$");
  });
});

describe("describeActionError", () => {
  it("prefers a known token over the status code, for both request-error and row-failure tokens", () => {
    expect(describeActionError(409, "slug_taken")).toContain("already in use");
    // WSK-D28 / §08: unsupported_stack now means "genuinely unrecognized token", not "non-static".
    expect(describeActionError(400, "unsupported_stack")).toContain("wasn't recognized");
    expect(describeActionError(503, "egress_error")).toBe(failureCopy("egress_error").title);
  });

  it("falls back to an honest, generic message per status code for an unrecognized message", () => {
    // Reproduces the VERIFIED backend bug (see this function's own doc comment): every throw in
    // webdev.controller.ts is serialized down to a useless constructor-derived message by the shared
    // HttpErrorFilter, so this is what the real backend hands back today for every one of its own
    // typed refusals — the status-code branch is not a hypothetical, it's the live behavior.
    expect(describeActionError(409, "Conflict Exception")).toContain("already taken");
    expect(describeActionError(400, "Bad Request Exception")).toContain("wasn't valid");
    expect(describeActionError(503, "Service Unavailable Exception")).toContain("couldn't be reached");
  });

  it("falls back to the raw message for a status this function doesn't special-case", () => {
    expect(describeActionError(500, "boom")).toBe("boom");
  });
});
