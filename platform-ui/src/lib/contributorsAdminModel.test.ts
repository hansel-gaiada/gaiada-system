import { describe, it, expect } from "vitest";
import { contributorRefusalCopy, maxValidUntilDay, statusWords, validEmail, validUntilFromDay, type ContributorRow } from "./contributorsAdminModel";

// M5-W1f: the staff invite form's rules. The server checks the same ones (400 invalid_request after authorization).
const NOW = Date.parse("2026-10-27T10:00:00.000Z");

describe("validUntilFromDay", () => {
  it("takes the end of the chosen UTC day when it is in the future and within 180 days", () => {
    expect(validUntilFromDay("2026-11-27", NOW)).toEqual({ ok: true, iso: "2026-11-27T23:59:59.000Z" });
    expect(validUntilFromDay("2026-10-27", NOW)).toEqual({ ok: true, iso: "2026-10-27T23:59:59.000Z" }); // later today
  });
  it("refuses a past day, an empty or malformed day", () => {
    expect(validUntilFromDay("2026-10-26", NOW).ok).toBe(false);
    expect(validUntilFromDay("", NOW).ok).toBe(false);
    expect(validUntilFromDay("27/11/2026", NOW).ok).toBe(false);
    expect(validUntilFromDay("2026-13-40", NOW).ok).toBe(false);
  });
  it("refuses more than 180 days ahead, and says so", () => {
    const r = validUntilFromDay("2027-05-01", NOW);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toMatch(/180 days/);
  });
  it("the latest day the form offers is itself accepted", () => {
    const day = maxValidUntilDay(NOW);
    expect(validUntilFromDay(day, NOW).ok).toBe(true);
  });
});

describe("validEmail", () => {
  it("accepts an address and rejects the rest", () => {
    expect(validEmail("ayu@example.com")).toBe(true);
    expect(validEmail(" ayu@example.com ")).toBe(true);
    for (const bad of ["", "ayu", "ayu@", "a yu@x.com", "@x.com"]) expect(validEmail(bad), bad).toBe(false);
  });
});

describe("contributorRefusalCopy", () => {
  it("says each typed refusal in words", () => {
    expect(contributorRefusalCopy({ kind: "conflict", slug: "contributor_conversion_refused", message: "x", currentHeadVersion: null, currentContentHash: null, updatedAt: null })).toMatch(/staff member/);
    expect(contributorRefusalCopy({ kind: "conflict", slug: "contributor_already_active", message: "x", currentHeadVersion: null, currentContentHash: null, updatedAt: null })).toMatch(/already an active/);
    expect(contributorRefusalCopy({ kind: "invalid", issues: [], message: "x", slug: "self_invite_forbidden" })).toMatch(/yourself/);
    expect(contributorRefusalCopy({ kind: "forbidden", reason: "forbidden" })).toMatch(/publisher/);
  });
  it("an unknown outcome says it is unknown", () => {
    expect(contributorRefusalCopy({ kind: "unavailable", code: "upstream_error", reason: "webdesk_ambiguous" })).toMatch(/couldn't confirm|could not confirm|couldn't confirm/i);
  });
});

describe("statusWords", () => {
  const row = (over: Partial<ContributorRow>): ContributorRow => ({ contributorId: "c", userId: "u", name: "A", email: "a@x.com", status: "active", live: true, validUntil: "2026-12-01T00:00:00Z", sponsorUserId: null, invitedAt: "t", activatedAt: null, endedAt: null, hasAccount: true, ...over });
  it("separates active, expired, invited and ended", () => {
    expect(statusWords(row({}))).toBe("Active");
    expect(statusWords(row({ live: false }))).toBe("Expired");
    expect(statusWords(row({ status: "invited", live: false }))).toMatch(/not yet accepted/);
    expect(statusWords(row({ status: "ended", live: false }))).toBe("Ended");
  });
});
