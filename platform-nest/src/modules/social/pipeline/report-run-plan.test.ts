// SCP-5 W5-A3 — "Generate with AI", pure (BFF §63.24.5): the listing (who is drafted, skipped or left out), each client's result from the
// create path's answer, the failure reasons, the end notice's words, the run's own report id, and the bound of four drafts in flight.
import { describe, it, expect } from "vitest";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import {
  MAX_DRAFTS_IN_FLIGHT, countResults, failureReason, finishedResults, generatedNoticeTitle, pendingEntries, planRunEntries, resultFromAnswer,
  runBounded, runReportId, type RunCandidate,
} from "./report-run-plan";

const OFFICER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cand = (n: number, name: string, o: Partial<RunCandidate> = {}): RunCandidate => ({
  engagementId: id(n), clientName: name, status: "active", isInternal: false, ownerId: OFFICER, reportKinds: ["weekly"], ...o,
});

describe("planRunEntries: the listing, decided once", () => {
  const all: RunCandidate[] = [
    cand(1, "Bravo"),
    cand(2, "alpha"),
    cand(3, "Charlie", { reportKinds: [] }),
    cand(4, "Delta", { isInternal: true }),
    cand(5, "Echo", { status: "paused" }),
    cand(6, "Foxtrot", { ownerId: OTHER }),
    cand(7, "Golf", { status: "closed", ownerId: OTHER }),
  ];

  it("an officer: their own active clients, by name; not due and internal listed skipped; paused, closed and others' left out", () => {
    const e = planRunEntries(all, { kind: "weekly", mayPlan: false, personId: OFFICER });
    expect(e).toEqual([
      { engagementId: id(2), clientName: "alpha", status: "pending" },
      { engagementId: id(1), clientName: "Bravo", status: "pending" },
      { engagementId: id(3), clientName: "Charlie", status: "skipped", reason: "kind_not_due" },
      { engagementId: id(4), clientName: "Delta", status: "skipped", reason: "internal_client" },
    ]);
  });

  it("one of the four: every active client of the company", () => {
    const e = planRunEntries(all, { kind: "weekly", mayPlan: true, personId: OTHER });
    expect(e.map((x) => [x.clientName, x.status, x.reason ?? null])).toEqual([
      ["alpha", "pending", null], ["Bravo", "pending", null], ["Charlie", "skipped", "kind_not_due"],
      ["Delta", "skipped", "internal_client"], ["Foxtrot", "pending", null],
    ]);
  });

  it("the monthly is every client's: no kind_not_due", () => {
    const e = planRunEntries(all, { kind: "monthly", mayPlan: false, personId: OFFICER });
    expect(e.find((x) => x.clientName === "Charlie")?.status).toBe("pending");
  });

  it("somebody with no person and no plan right lists nobody", () => {
    expect(planRunEntries(all, { kind: "weekly", mayPlan: false, personId: null })).toEqual([]);
  });

  it("chosen clients: only those; one the person may not draft is skipped not_allowed; kind_not_due does not apply", () => {
    const e = planRunEntries(all, { kind: "weekly", mayPlan: false, personId: OFFICER, chosen: [id(3), id(6), id(5).toUpperCase()] });
    expect(e).toEqual([
      { engagementId: id(3), clientName: "Charlie", status: "pending" },
      { engagementId: id(6), clientName: "Foxtrot", status: "skipped", reason: "not_allowed" },
    ]);
  });

  it("matches the officer case-insensitively", () => {
    const e = planRunEntries([cand(1, "Bravo", { ownerId: OFFICER.toUpperCase() })], { kind: "weekly", mayPlan: false, personId: OFFICER });
    expect(e[0].status).toBe("pending");
  });
});

describe("a client's result", () => {
  const entry = { engagementId: id(1), clientName: "Bravo" };
  const own = runReportId(id(99), id(1));

  it("a new draft is created with how it was drafted", () => {
    expect(resultFromAnswer(entry, { id: own, draftedVia: "ai", simulated: false }, own)).toEqual({ ...entry, reportId: own, simulated: false, status: "created", draftedVia: "ai" });
    expect(resultFromAnswer(entry, { id: own, draftedVia: "fallback", simulated: true }, own)).toMatchObject({ status: "created", draftedVia: "fallback", simulated: true });
  });

  it("another report of the client, kind and period is existing, never redrafted", () => {
    expect(resultFromAnswer(entry, { id: id(50), draftedVia: "existing", simulated: false }, own)).toEqual({ ...entry, reportId: id(50), simulated: false, status: "existing" });
  });

  it("the run's own report found again (a resume) is created, as its frozen numbers record", () => {
    expect(resultFromAnswer(entry, { id: own.toUpperCase(), draftedVia: "existing", simulated: false, narrativeSource: "ai" }, own)).toMatchObject({ status: "created", draftedVia: "ai" });
    expect(resultFromAnswer(entry, { id: own, draftedVia: "existing", simulated: false, narrativeSource: "deterministic" }, own)).toMatchObject({ status: "created", draftedVia: "fallback" });
  });

  it("a draft that throws is failed with a typed reason, never prose", () => {
    expect(failureReason(new ForbiddenException("not authorized: cerbos denied create"))).toBe("not_authorized");
    expect(failureReason(new UnauthorizedException("session revoked"))).toBe("session_revoked");
    expect(failureReason(new NotFoundException("engagement not found"))).toBe("engagement_not_found");
    expect(failureReason(new BadRequestException({ message: "internal_client_no_reports" }))).toBe("internal_client_no_reports");
    expect(failureReason(new ConflictException({ message: "report_kind_off" }))).toBe("report_kind_off");
    expect(failureReason(new BadRequestException({ message: "Something with Words and a name" }))).toBe("draft_failed");
    expect(failureReason(new Error("connection reset"))).toBe("draft_failed");
    expect(failureReason(null)).toBe("draft_failed");
  });
});

describe("results, counts and the notice", () => {
  const entries = [
    { engagementId: id(1), clientName: "a", status: "created" as const },
    { engagementId: id(2), clientName: "b", status: "existing" as const },
    { engagementId: id(3), clientName: "c", status: "pending" as const },
    { engagementId: id(4), clientName: "d", status: "skipped" as const, reason: "kind_not_due" },
    { engagementId: id(5), clientName: "e", status: "failed" as const, reason: "draft_failed" },
  ];
  it("pending is the run's bookkeeping: the read answers the finished results only", () => {
    expect(finishedResults(entries).map((e) => e.engagementId)).toEqual([id(1), id(2), id(4), id(5)]);
    expect(pendingEntries(entries).map((e) => e.engagementId)).toEqual([id(3)]);
    expect(countResults(entries)).toEqual({ created: 1, existing: 1, skipped: 1, failed: 1, pending: 1 });
  });
  it("the end notice's words", () => {
    expect(generatedNoticeTitle({ created: 12, existing: 6, skipped: 0, failed: 1 })).toBe("12 drafts ready, 6 already there, 1 failed");
    expect(generatedNoticeTitle({ created: 1, existing: 0, skipped: 2, failed: 0 })).toBe("1 draft ready, 2 skipped");
    expect(generatedNoticeTitle({ created: 0, existing: 0, skipped: 0, failed: 0 })).toBe("0 drafts ready");
  });
});

describe("runReportId: the run's report for a client", () => {
  it("is a uuid, the same for the same run and client in any case, different otherwise", () => {
    const a = runReportId(id(9), id(1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(runReportId(id(9).toUpperCase(), id(1).toUpperCase())).toBe(a);
    expect(runReportId(id(9), id(2))).not.toBe(a);
    expect(runReportId(id(8), id(1))).not.toBe(a);
  });
});

describe("runBounded: at most four drafts in flight", () => {
  it("never passes the bound, reaches it, and runs every item once in order of start", async () => {
    let inFlight = 0;
    let max = 0;
    const started: number[] = [];
    await runBounded(Array.from({ length: 11 }, (_, i) => i), MAX_DRAFTS_IN_FLIGHT, async (i) => {
      started.push(i);
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
      inFlight--;
    });
    expect(MAX_DRAFTS_IN_FLIGHT).toBe(4);
    expect(max).toBe(4);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("stop() starts nothing new; the ones in flight finish", async () => {
    const done: number[] = [];
    let stop = false;
    await runBounded([0, 1, 2, 3, 4, 5, 6, 7], 4, async (i) => {
      if (i === 3) stop = true; // the fourth starts, then the stop: nothing after it starts
      await new Promise((r) => setTimeout(r, 5));
      done.push(i);
    }, () => stop);
    expect(done.sort()).toEqual([0, 1, 2, 3]);
  });

  it("fewer items than the bound, or none", async () => {
    let n = 0;
    await runBounded([1, 2], 4, async () => { n++; });
    await runBounded([], 4, async () => { n++; });
    expect(n).toBe(2);
  });
});
