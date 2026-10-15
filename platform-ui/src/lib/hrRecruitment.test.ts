import { describe, it, expect } from "vitest";
import {
  requisitionMoves, offerMoves, recruitmentControls, zonedLocalToIso, isoToZonedLocal, formatInZone, groupByStage,
  PATCHABLE_REQUISITION_STATUSES, OFFER_SET_STATUSES,
} from "./hrRecruitment";
import type { Application, PipelineStage } from "./hr-full";

// DW-7f-2 — the pure helpers the recruitment screens share.

describe("requisitionMoves", () => {
  it.each([
    ["draft", ["cancelled"]],
    ["pending_approval", []],
    ["open", ["on_hold", "closed", "cancelled"]],
    ["on_hold", ["draft", "closed", "cancelled"]],
    ["filled", []], ["closed", []], ["cancelled", []],
  ])("%s offers %j", (status, to) => {
    expect(requisitionMoves(status).map((m) => m.to)).toEqual(to);
  });

  it("only ever offers a status the server's PATCH accepts (never open or pending_approval)", () => {
    for (const s of ["draft", "pending_approval", "open", "on_hold", "filled", "closed", "cancelled"]) {
      for (const m of requisitionMoves(s)) expect(PATCHABLE_REQUISITION_STATUSES).toContain(m.to);
    }
  });
});

describe("offerMoves", () => {
  it.each([
    ["draft", ["sent", "withdrawn"]],
    ["sent", ["accepted", "declined", "expired", "withdrawn"]],
    ["accepted", ["withdrawn"]],
    ["declined", []], ["expired", []], ["withdrawn", []], ["converted", []], ["pending_approval", []],
  ])("%s offers %j", (status, to) => {
    expect(offerMoves(status).map((m) => m.to)).toEqual(to);
  });

  it("never offers converted (the convert route's alone)", () => {
    for (const s of ["draft", "sent", "accepted"]) for (const m of offerMoves(s)) expect(OFFER_SET_STATUSES).toContain(m.to);
  });
});

describe("recruitmentControls", () => {
  it("manage and convert follow the capabilities exactly", () => {
    expect(recruitmentControls({ view: true, manage: true, approve: false })).toMatchObject({ manage: true, convert: false, update: true, score: true });
    expect(recruitmentControls({ view: true, manage: true, approve: true }).convert).toBe(true);
  });

  it("a view-only reader gets a read-only page, except a panelist who may score", () => {
    expect(recruitmentControls({ view: true, manage: false, approve: false })).toEqual({ manage: false, convert: false, update: false, score: false });
    expect(recruitmentControls({ view: true, manage: false, approve: false }, true)).toEqual({ manage: false, convert: false, update: false, score: true });
  });

  it("someone with no recruitment capability came in through the hiring-manager or panel arm, so update and score are shown", () => {
    expect(recruitmentControls({ view: false, manage: false, approve: false })).toEqual({ manage: false, convert: false, update: true, score: true });
  });
});

describe("time zones", () => {
  it("converts a time typed in Makassar (UTC+8) to the exact instant", () => {
    expect(zonedLocalToIso("2026-10-20T09:00", "Asia/Makassar")).toBe("2026-10-20T01:00:00.000Z");
    expect(zonedLocalToIso("2026-10-20T09:00", "UTC")).toBe("2026-10-20T09:00:00.000Z");
    expect(zonedLocalToIso("2026-01-15T09:00", "America/New_York")).toBe("2026-01-15T14:00:00.000Z");
    expect(zonedLocalToIso("2026-07-15T09:00", "America/New_York")).toBe("2026-07-15T13:00:00.000Z");
  });

  it("returns null for an unknown zone, a malformed value or a date that does not exist", () => {
    expect(zonedLocalToIso("2026-10-20T09:00", "Mars/Olympus")).toBeNull();
    expect(zonedLocalToIso("20 Oct 9am", "UTC")).toBeNull();
    expect(zonedLocalToIso("2026-02-30T09:00", "UTC")).toBeNull();
    expect(zonedLocalToIso("2026-10-20T25:00", "UTC")).toBeNull();
  });

  it("round-trips an instant back to the clock reading in that zone", () => {
    expect(isoToZonedLocal("2026-10-20T01:00:00.000Z", "Asia/Makassar")).toBe("2026-10-20T09:00");
    expect(isoToZonedLocal("not a date", "UTC")).toBe("");
    expect(formatInZone("2026-10-20T01:00:00.000Z", "Asia/Makassar")).toContain("09:00");
    expect(formatInZone("2026-10-20T01:00:00.000Z", "Mars/Olympus")).toBe("2026-10-20T01:00:00.000Z");
  });
});

const stage = (key: string, sortOrder: number, over: Partial<PipelineStage> = {}): PipelineStage => ({
  id: key, key, label: key.toUpperCase(), sortOrder, isTerminal: false, terminalKind: null, requiresInterview: false, isActive: true, ...over,
});
const app = (id: string, stageKey: string): Application => ({
  id, requisitionId: "r", requisitionReference: "R", requisitionTitle: "T", candidateId: id, candidateName: id, candidateHeadline: null,
  stageKey, status: "active", rating: null, appliedOn: "2026-10-01", stageEnteredAt: "2026-10-01T00:00:00Z", daysInStage: 1,
});

describe("groupByStage", () => {
  it("orders by the stages' sort order, skips inactive stages, and keeps empty stages", () => {
    const groups = groupByStage([app("a", "screen"), app("b", "applied")], [stage("screen", 2), stage("applied", 1), stage("old", 0, { isActive: false }), stage("offer", 3)]);
    expect(groups.map((g) => [g.key, g.apps.map((a) => a.id)])).toEqual([["applied", ["b"]], ["screen", ["a"]], ["offer", []]]);
  });

  it("never drops an application whose stage is not configured: it goes under Other stage", () => {
    const groups = groupByStage([app("a", "ghost")], [stage("applied", 1)]);
    expect(groups.at(-1)).toMatchObject({ key: "__other", label: "Other stage" });
    expect(groups.at(-1)?.apps.map((a) => a.id)).toEqual(["a"]);
  });
});
