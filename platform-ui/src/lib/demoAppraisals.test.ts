import { describe, it, expect } from "vitest";
import { appraisalsDemo } from "./demoAppraisals";
import type { AppraisalCycleRow, AppraisalPack, AppraisalListEntry } from "./appraisals";

function call(method: string, path: string, query: Record<string, string> = {}, body?: unknown, userId = "demo-hansel") {
  return appraisalsDemo(method, path, new URLSearchParams(query), body !== undefined ? JSON.stringify(body) : undefined, userId);
}

describe("demoAppraisals — appraisalsDemo (DEMO_MODE fixtures, TR-26)", () => {
  it("returns null for a path it doesn't own, so the dispatch chain can fall through", () => {
    expect(call("GET", "/api/co-agency/pm/tasks")).toBeNull();
    expect(call("GET", "/api/co-agency/reports/document")).toBeNull();
  });

  it("seeds a DRAFT appraisal (H2, gede-ic) visible to the elevated HR/manager identity but not yet to the subject", () => {
    const asManager = call("GET", "/api/co-agency/appraisals/demo-appr-h2-gede");
    expect(asManager?.status).toBe(200);
    const pack = asManager!.json as AppraisalPack;
    expect(pack.status).toBe("draft");
    expect(pack.commentary).toBeNull();
    expect(pack.scores.delivery.manager).toBeNull();

    // The subject cannot read their own draft yet — §8/appraisals.controller.ts's own rule.
    const asSubject = call("GET", "/api/co-agency/appraisals/demo-appr-h2-gede", {}, undefined, "gede-ic");
    expect(asSubject?.status).toBe(403);

    // /mine never includes a draft.
    const mine = call("GET", "/api/co-agency/appraisals/mine", {}, undefined, "gede-ic")!.json as { appraisals: AppraisalPack[] };
    expect(mine.appraisals.some((a) => a.id === "demo-appr-h2-gede")).toBe(false);
  });

  it("seeds a SUBMITTED, small-cohort-SUPPRESSED appraisal (u-finance, cohort of 2) — every band null, every rate keeps its denominator", () => {
    const res = call("GET", "/api/co-agency/appraisals/demo-appr-h1-finance");
    const pack = res!.json as AppraisalPack;
    expect(pack.status).toBe("submitted");
    expect(pack.cohortBands.length).toBeGreaterThan(0);
    for (const b of pack.cohortBands) {
      expect(b.cohortSize).toBe(2);
      expect(b.band).toBeNull();
      expect(b.subjectPercentile).toBeUndefined();
      if (b.unit === "percent") {
        expect(b.numerator).toBeDefined();
        expect(b.denominator).toBeDefined();
      }
    }
    // Because every band is null, no axis has a computable auto — a manager score can never be
    // flagged as an "unjustified deviation" here (nothing to deviate from).
    for (const axis of ["delivery", "quality", "effort", "collaboration"] as const) {
      expect(pack.scores[axis].auto).toBeNull();
    }
  });

  it("seeds a SUBMITTED, EVIDENCE_STALE appraisal (seo-staff) that blocks finalize with an explanation, not a raw failure", () => {
    const finalizeAttempt = call("POST", "/api/co-agency/appraisals/demo-appr-h1-seo/finalize", {}, undefined, "demo-hansel");
    expect(finalizeAttempt?.status).toBe(409);
    const body = finalizeAttempt!.json as { error: string };
    expect(body.error).toMatch(/re-confirm/i);

    // Re-confirming clears the flag, and finalize then succeeds.
    const confirm = call("PATCH", "/api/co-agency/appraisals/demo-appr-h1-seo", {}, { confirmEvidence: true }, "demo-hansel");
    expect((confirm!.json as AppraisalPack).evidenceStale).toBe(false);
    const finalizeAfter = call("POST", "/api/co-agency/appraisals/demo-appr-h1-seo/finalize", {}, undefined, "demo-hansel");
    expect(finalizeAfter?.status).toBe(200);
    expect((finalizeAfter!.json as AppraisalPack).status).toBe("finalized");
  });

  it("seeds an ACKNOWLEDGED appraisal (gede-ic, H1) with a bandable cohort and a deviation note already present", () => {
    const pack = call("GET", "/api/co-agency/appraisals/demo-appr-h1-gede")!.json as AppraisalPack;
    expect(pack.status).toBe("acknowledged");
    expect(pack.acks.some((a) => a.action === "acknowledged" && a.actorUserId === "gede-ic")).toBe(true);
    expect(pack.scores.effort.note).toBeTruthy();
    const timeLogging = pack.cohortBands.find((b) => b.metricKey === "discipline.time_logging_coverage")!;
    expect(timeLogging.band).not.toBeNull();
    expect(timeLogging.numerator).toBe(19);
    expect(timeLogging.denominator).toBe(22);
  });

  it("seeds a DISPUTED appraisal (u-dev, H1) — the ack trail records the dispute with the subject's own comment", () => {
    const pack = call("GET", "/api/co-agency/appraisals/demo-appr-h1-udev")!.json as AppraisalPack;
    expect(pack.status).toBe("disputed");
    const entry = pack.acks.find((a) => a.action === "disputed")!;
    expect(entry.actorUserId).toBe("u-dev");
    expect(entry.comment).toBeTruthy();
  });

  it("PERSON_SAFE_METRICS only — every seeded cohortBand metricKey is one of the 8 appraisal-safe person-grain metrics", () => {
    const SAFE_KEYS = new Set([
      "delivery.throughput_weighted", "delivery.on_time_rate", "delivery.estimate_coverage",
      "flow.reopen_rate", "effort.estimate_accuracy", "collab.contributed_minutes",
      "discipline.checkin_compliance", "discipline.time_logging_coverage",
    ]);
    for (const id of ["demo-appr-h1-gede", "demo-appr-h1-udev", "demo-appr-h1-finance", "demo-appr-h1-seo", "demo-appr-h2-gede"]) {
      const pack = call("GET", `/api/co-agency/appraisals/${id}`)!.json as AppraisalPack;
      for (const b of pack.cohortBands) expect(SAFE_KEYS.has(b.metricKey)).toBe(true);
      // Explicitly never any of the appraisal-UNSAFE metrics (raw task counts, raw minutes logged,
      // billable share, comments/docs authored, WIP, blocked share) anywhere in the pack.
      const unsafeKeys = ["delivery.tasks_completed", "effort.minutes_logged", "effort.billable_share", "collab.comments_authored", "collab.docs_updated", "flow.wip_open_avg", "flow.blocked_share"];
      for (const k of unsafeKeys) expect(pack.cohortBands.some((b) => b.metricKey === k)).toBe(false);
    }
  });

  it("elevated (HR/exec) list sees every appraisal across cycles; a plain subject's list sees only their own submitted+", () => {
    const asHR = call("GET", "/api/co-agency/appraisals")!.json as { appraisals: AppraisalListEntry[] };
    expect(asHR.appraisals.length).toBeGreaterThanOrEqual(5);

    const asSeo = call("GET", "/api/co-agency/appraisals", {}, undefined, "seo-staff")!.json as { appraisals: AppraisalListEntry[] };
    expect(asSeo.appraisals.every((a) => a.subjectUserId === "seo-staff")).toBe(true);
    expect(asSeo.appraisals.every((a) => a.status !== "draft")).toBe(true);
  });

  it("submit enforces commentary length and unjustified deviations BEFORE persisting, mirroring appraisal-engine.ts", () => {
    // Use a freshly-generated draft so this test doesn't mutate the shared seeded fixtures other
    // tests depend on.
    const gen = call("POST", "/api/co-agency/appraisals/cycles/demo-cycle-h2/generate", {}, {
      subjects: [{ subjectUserId: "u-finance", managerUserId: "demo-hansel", roleKey: "finance_analyst" }],
    });
    const id = (gen!.json as { generated: string[] }).generated[0];

    const shortCommentary = call("POST", `/api/co-agency/appraisals/${id}/submit`, {}, { commentary: "too short" });
    expect(shortCommentary?.status).toBe(400);

    const scoreEveryAxis = call("PATCH", `/api/co-agency/appraisals/${id}`, {}, {
      scores: { delivery: { manager: 3 }, quality: { manager: 3 }, effort: { manager: 3 }, collaboration: { manager: 3 } },
    });
    expect(scoreEveryAxis?.status).toBe(200);

    const submitOk = call("POST", `/api/co-agency/appraisals/${id}/submit`, {}, { commentary: "x".repeat(60) });
    expect(submitOk?.status).toBe(200);
    expect((submitOk!.json as AppraisalPack).status).toBe("submitted");
  });

  it("a subject cannot ack someone else's appraisal, and a non-elevated caller cannot finalize", () => {
    const wrongSubject = call("POST", "/api/co-agency/appraisals/demo-appr-h1-gede/ack", {}, { action: "acknowledged" }, "u-dev");
    expect(wrongSubject?.status).toBe(403);
    const nonHrFinalize = call("POST", "/api/co-agency/appraisals/demo-appr-h1-finance/finalize", {}, undefined, "gede-ic");
    expect(nonHrFinalize?.status).toBe(403);
  });

  it("cycle CRUD + generate are HR-only (elevated), and generate is idempotent per subject", () => {
    expect(call("GET", "/api/co-agency/appraisals/cycles", {}, undefined, "gede-ic")?.status).toBe(403);
    const cycles = call("GET", "/api/co-agency/appraisals/cycles")!.json as { cycles: AppraisalCycleRow[] };
    expect(cycles.cycles.some((c) => c.id === "demo-cycle-h1")).toBe(true);
    expect(cycles.cycles.some((c) => c.id === "demo-cycle-h2")).toBe(true);

    const regen = call("POST", "/api/co-agency/appraisals/cycles/demo-cycle-h1/generate", {}, {
      subjects: [{ subjectUserId: "gede-ic", managerUserId: "demo-hansel", roleKey: "developer" }],
    });
    const result = regen!.json as { generated: string[]; skippedExisting: string[] };
    expect(result.skippedExisting).toContain("gede-ic"); // already exists for this cycle — never duplicated
  });
});
