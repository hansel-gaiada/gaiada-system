// AD-4/AD-5 — pure unit tests for agency-leads.service.ts's validation and transition-description
// logic. No database, no skipIf, no HTTP: same posture as dept-resolution.test.ts and
// client-filter.test.ts. The DB-touching functions in that file (listLeadsQueue, getLeadDetail,
// listLeadSubmissions, createStaffLead, openLead/declineLead/nurtureLead) are NOT exercised here —
// this environment has no DATABASE_URL_TEST (the 16-container stack is off by owner decision), so
// they are UNVERIFIED by this file and would need a `.db.test.ts` companion to prove the SQL itself.
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  describeIllegalTransition,
  normalizeCreateLeadInput,
  normalizeDeclineReason,
  queueRank,
} from "./agency-leads.service";

describe("queueRank", () => {
  it("orders submitted before invited before everything else", () => {
    expect(queueRank("submitted")).toBeLessThan(queueRank("invited"));
    expect(queueRank("invited")).toBeLessThan(queueRank("in_review"));
    expect(queueRank("in_review")).toBe(queueRank("nurturing"));
    expect(queueRank("in_review")).toBe(queueRank("converted"));
    expect(queueRank("in_review")).toBe(queueRank("declined"));
  });
});

describe("describeIllegalTransition", () => {
  it("names the action and the ACTUAL current status, not the attempted one", () => {
    expect(describeIllegalTransition("open", "invited")).toBe(
      "cannot open a lead in status 'invited' — expected 'submitted'",
    );
    expect(describeIllegalTransition("decline", "submitted")).toBe(
      "cannot decline a lead in status 'submitted' — expected 'in_review'",
    );
    expect(describeIllegalTransition("nurture", "declined")).toBe(
      "cannot nurture a lead in status 'declined' — expected 'in_review'",
    );
  });

  it("never silently no-ops: every action has a distinct, non-empty refusal for every foreign status", () => {
    const actions = ["open", "decline", "nurture"] as const;
    const statuses = ["invited", "submitted", "in_review", "nurturing", "converted", "declined"];
    for (const action of actions) {
      for (const status of statuses) {
        const msg = describeIllegalTransition(action, status);
        expect(msg.length).toBeGreaterThan(0);
        expect(msg).toContain(action);
        expect(msg).toContain(status);
      }
    }
  });
});

describe("normalizeCreateLeadInput", () => {
  it("requires orgName", () => {
    expect(() => normalizeCreateLeadInput({})).toThrow(BadRequestException);
    expect(() => normalizeCreateLeadInput({ orgName: "   " })).toThrow(BadRequestException);
  });

  it("trims orgName/contactName and leaves absent optional fields null, not empty string", () => {
    const out = normalizeCreateLeadInput({ orgName: "  Acme Hotels  " });
    expect(out.orgName).toBe("Acme Hotels");
    expect(out.contactName).toBeNull();
    expect(out.contactEmail).toBeNull();
    expect(out.contactPhone).toBeNull();
  });

  it("does NOT run contactEmail through scrubText's email-redaction rule — the address must survive verbatim", () => {
    const out = normalizeCreateLeadInput({ orgName: "Acme", contactEmail: "prospect@acme.test" });
    expect(out.contactEmail).toBe("prospect@acme.test");
  });

  it("still scrubs orgName/contactName (free text) — an embedded email is redacted there", () => {
    const out = normalizeCreateLeadInput({ orgName: "Acme (ask prospect@acme.test for details)" });
    expect(out.orgName).toContain("[REDACTED-EMAIL]");
    expect(out.orgName).not.toContain("prospect@acme.test");
  });

  it("caps an oversized orgName rather than rejecting it", () => {
    const out = normalizeCreateLeadInput({ orgName: "A".repeat(500) });
    expect(out.orgName.length).toBe(300);
  });
});

describe("normalizeDeclineReason", () => {
  it("rejects an absent, empty, or whitespace-only reason", () => {
    expect(() => normalizeDeclineReason(undefined)).toThrow(BadRequestException);
    expect(() => normalizeDeclineReason("")).toThrow(BadRequestException);
    expect(() => normalizeDeclineReason("   ")).toThrow(BadRequestException);
  });

  it("trims and returns a real reason", () => {
    expect(normalizeDeclineReason("  budget too small  ")).toBe("budget too small");
  });

  it("caps an oversized reason at 1000 chars", () => {
    expect(normalizeDeclineReason("x".repeat(2000)).length).toBe(1000);
  });
});
