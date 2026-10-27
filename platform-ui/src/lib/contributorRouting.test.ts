import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { isClientOnly, isContributor, isStaff } from "./rbac";
import { contributorFenceReason, fenceReasonOfResult, shellFor, CONTRIBUTOR_HOME, CONTRIBUTOR_INVITE_BASE } from "./contributorRouting";
import { resultFromError } from "./webdeskContent";
import { PlatformError } from "./platform";

// M5-W1f: which shell a person belongs in. A contributor goes to their own shell; staff and client routing is exactly what it was.
const base = { userId: "u", name: "N", email: "n@x.test", title: null, assurance: "high", companies: [] as Me["companies"] };
const me = (roles: string[], kind?: string): Me => ({ ...base, ...(kind ? { kind } : {}), roles: roles.map((role) => ({ role, scopeType: "company", scopeId: "c1" })) });

describe("isStaff / isContributor", () => {
  it("a contributor holding writers' room role rows is NOT staff (the any-non-client-role rule would otherwise say so)", () => {
    const c = me(["webdesk_writer", "webdesk_translator"], "contributor");
    expect(isContributor(c)).toBe(true);
    expect(isStaff(c)).toBe(false);
    expect(isClientOnly(c)).toBe(false);
  });
  it("the same roles on an employee are unchanged: staff", () => {
    const e = me(["webdesk_writer"], "employee");
    expect(isContributor(e)).toBe(false);
    expect(isStaff(e)).toBe(true);
  });
  it("an older backend with no `kind` is never a contributor", () => {
    expect(isContributor(me(["webdesk_writer"]))).toBe(false);
    expect(isStaff(me(["webdesk_writer"]))).toBe(true);
  });
});

describe("shellFor: staff and client routing unchanged", () => {
  it("contributor -> contributor", () => expect(shellFor(me(["webdesk_seo_reviewer"], "contributor"))).toBe("contributor"));
  it("employee with a manager role -> staff", () => expect(shellFor(me(["manager"], "employee"))).toBe("staff"));
  it("client-only -> portal", () => expect(shellFor(me(["client"]))).toBe("portal"));
  it("a client contact who also holds a staff role -> staff (never taken to the portal)", () => expect(shellFor(me(["client", "manager"]))).toBe("staff"));
  it("the home and the invite base are distinct from the client's /invite", () => {
    expect(CONTRIBUTOR_HOME).toBe("/contributor");
    expect(CONTRIBUTOR_INVITE_BASE).toBe("/contributor-invite");
    expect(CONTRIBUTOR_INVITE_BASE.startsWith("/invite")).toBe(false);
  });
});

const fence = (reason: string) => new PlatformError(403, "contributor_route_forbidden", undefined, undefined, reason, { error: "contributor_route_forbidden", reason });

describe("the fence's refusal", () => {
  it("is recognised from a thrown PlatformError, with its reason", () => {
    expect(contributorFenceReason(fence("assurance_high_required"))).toBe("assurance_high_required");
    expect(contributorFenceReason(fence("route_not_open_to_contributors"))).toBe("route_not_open_to_contributors");
  });
  it("is not confused with any other 403 or error", () => {
    expect(contributorFenceReason(new PlatformError(403, "forbidden"))).toBeNull();
    expect(contributorFenceReason(new PlatformError(401, "contributor_route_forbidden"))).toBeNull();
    expect(contributorFenceReason(new Error("x"))).toBeNull();
    expect(contributorFenceReason(null)).toBeNull();
  });
  it("resultFromError carries the reason in `slug` for the fence only", () => {
    const r = resultFromError(fence("assurance_high_required"));
    expect(r).toMatchObject({ kind: "forbidden", slug: "assurance_high_required" });
    expect(fenceReasonOfResult(r)).toBe("assurance_high_required");
    const other = resultFromError(new PlatformError(403, "nope", undefined, undefined, "something", { error: "nope", reason: "something" }));
    expect(other).toEqual({ kind: "forbidden", reason: "nope" });
    expect(fenceReasonOfResult(other)).toBeNull();
  });
});
