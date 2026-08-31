import { describe, it, expect } from "vitest";
import { approvalTrack, briefingPhase, flowCounts, orderBriefings, scopeToDepartment } from "./prdFlow";
import type { PipelineGate } from "./pipeline";

function gate(over: Partial<PipelineGate>): PipelineGate {
  return {
    id: "g-1", run_id: "r-1", stage_id: null, kind: "prd_review", actor_side: "internal",
    status: "pending", decision: null, note: null, decided_by: null, decided_at: null,
    created_at: "2026-07-01T00:00:00Z", ...over,
  };
}

describe("briefingPhase — one recording status → one phase, one headline, one next step", () => {
  it("a freshly created briefing is waiting for its recording", () => {
    for (const status of ["scheduled", "recording"] as const) {
      const p = briefingPhase(status);
      expect(p.phase).toBe("capture");
      expect(p.headline).toBe("No recording yet");
      expect(p.next).toMatch(/record here|helper|upload/i);
    }
  });

  it("recorded/transcribing are hands-off processing states", () => {
    for (const status of ["recorded", "transcribing"] as const) {
      const p = briefingPhase(status);
      expect(p.phase).toBe("processing");
      expect(p.headline).toBe("Transcribing");
      expect(p.next).toMatch(/updates by itself/i);
    }
  });

  it("transcribed is the only state where converting is the next step", () => {
    const p = briefingPhase("transcribed");
    expect(p.phase).toBe("ready");
    expect(p.headline).toBe("Transcript ready");
    expect(p.next).toMatch(/convert/i);
  });

  it("failed offers retry or a different file", () => {
    const p = briefingPhase("failed");
    expect(p.phase).toBe("failed");
    expect(p.headline).toBe("Transcription failed");
    expect(p.next).toMatch(/retry/i);
  });

  it("ingested has left the briefing list — nothing further to do here", () => {
    const p = briefingPhase("ingested");
    expect(p.phase).toBe("in_pipeline");
    expect(p.next).toBeNull();
  });
});

describe("approvalTrack — the two beats a PRD run must clear: GM review, then client sign-off", () => {
  it("with no PRD review gate yet, both chips are idle and the sentence says the PRD is drafting", () => {
    const t = approvalTrack({ status: "extracting" }, []);
    expect(t.gm).toEqual({ label: "Not yet", tone: "idle" });
    expect(t.client).toEqual({ label: "Not yet", tone: "idle" });
    expect(t.sentence).toMatch(/no prd review yet/i);
    expect(t.sentence).toMatch(/run workspace/i);
    expect(t.pendingGmGate).toBeNull();
  });

  it("a pending prd_review is 'waiting on GM' and is exposed as the gate to decide", () => {
    const g = gate({ id: "g-review", kind: "prd_review", status: "pending" });
    const t = approvalTrack({ status: "extracting" }, [g]);
    expect(t.gm).toEqual({ label: "Waiting on GM", tone: "waiting" });
    expect(t.client).toEqual({ label: "Not yet", tone: "idle" });
    expect(t.sentence).toMatch(/waiting on the gm/i);
    expect(t.pendingGmGate?.id).toBe("g-review");
  });

  it("GM approved, no client gate opened yet", () => {
    const t = approvalTrack({ status: "extracting" }, [
      gate({ kind: "prd_review", status: "decided", decision: "approved" }),
    ]);
    expect(t.gm).toEqual({ label: "Approved", tone: "done" });
    expect(t.client).toEqual({ label: "Not yet", tone: "idle" });
    expect(t.sentence).toMatch(/gm approved/i);
    expect(t.pendingGmGate).toBeNull();
  });

  it("GM approved and the client sign-off is pending → waiting on client", () => {
    const t = approvalTrack({ status: "extracting" }, [
      gate({ id: "a", kind: "prd_review", status: "decided", decision: "approved" }),
      gate({ id: "b", kind: "prd_sign", actor_side: "client", status: "pending", created_at: "2026-07-02T00:00:00Z" }),
    ]);
    expect(t.gm.tone).toBe("done");
    expect(t.client).toEqual({ label: "Waiting on client", tone: "waiting" });
    expect(t.sentence).toMatch(/waiting on the client to sign/i);
  });

  it("both cleared → signed, build unlocked", () => {
    const t = approvalTrack({ status: "delivery_active" }, [
      gate({ id: "a", kind: "prd_review", status: "decided", decision: "approved" }),
      gate({ id: "b", kind: "prd_sign", actor_side: "client", status: "decided", decision: "signed" }),
    ]);
    expect(t.gm).toEqual({ label: "Approved", tone: "done" });
    expect(t.client).toEqual({ label: "Signed", tone: "done" });
    expect(t.sentence).toMatch(/signed/i);
    expect(t.sentence).toMatch(/build/i);
  });

  it("GM asked for changes → attention on the GM chip, client still idle", () => {
    const t = approvalTrack({ status: "extracting" }, [
      gate({ kind: "prd_review", status: "decided", decision: "changes_requested" }),
    ]);
    expect(t.gm).toEqual({ label: "Changes requested", tone: "attention" });
    expect(t.client.tone).toBe("idle");
    expect(t.sentence).toMatch(/asked for changes/i);
  });

  it("the client sending it back is attention on the client chip", () => {
    const t = approvalTrack({ status: "blocked" }, [
      gate({ id: "a", kind: "prd_review", status: "decided", decision: "approved" }),
      gate({ id: "b", kind: "prd_sign", actor_side: "client", status: "decided", decision: "changes_requested" }),
    ]);
    expect(t.client).toEqual({ label: "Changes requested", tone: "attention" });
    expect(t.sentence).toMatch(/client asked for changes/i);
  });

  it("uses the LATEST gate of each kind when a review was reopened", () => {
    const t = approvalTrack({ status: "extracting" }, [
      gate({ id: "old", kind: "prd_review", status: "decided", decision: "changes_requested", created_at: "2026-07-01T00:00:00Z" }),
      gate({ id: "new", kind: "prd_review", status: "pending", created_at: "2026-07-03T00:00:00Z" }),
    ]);
    expect(t.gm.tone).toBe("waiting");
    expect(t.pendingGmGate?.id).toBe("new");
  });

  it("ignores gates that are not part of the PRD beat (pm_review, scope_signoff)", () => {
    const t = approvalTrack({ status: "extracting" }, [
      gate({ kind: "pm_review", status: "pending" }),
      gate({ kind: "scope_signoff", actor_side: "client", status: "pending" }),
    ]);
    expect(t.gm.tone).toBe("idle");
    expect(t.client.tone).toBe("idle");
    expect(t.pendingGmGate).toBeNull();
  });
});

describe("flowCounts — the numbers the flow header shows", () => {
  it("buckets briefings by phase and runs by which approval they wait on", () => {
    const counts = flowCounts(
      [{ status: "recording" }, { status: "scheduled" }, { status: "transcribing" }, { status: "transcribed" }, { status: "failed" }, { status: "ingested" }],
      [
        { run: { status: "extracting" }, gates: [gate({ kind: "prd_review", status: "pending" })] },
        { run: { status: "extracting" }, gates: [gate({ kind: "prd_review", status: "decided", decision: "approved" }), gate({ kind: "prd_sign", actor_side: "client", status: "pending" })] },
        { run: { status: "complete" }, gates: [] },
        { run: { status: "extracting" }, gates: [] },
      ],
    );
    expect(counts).toEqual({ toCapture: 2, processing: 1, readyToConvert: 1, failed: 1, awaitingGm: 1, awaitingClient: 1, complete: 1 });
  });
});

describe("scopeToDepartment — a department tab shows the department's work only", () => {
  const webDev = new Set(["p-web-1", "p-web-2"]);
  const rec = (id: string, project_id: string | null, department_id: string | null = null, meeting_id = `mtg-${id}`) => ({ id, project_id, department_id, meeting_id, status: "transcribed" as const });
  const run = (id: string, project_id: string | null | undefined, source_meeting_id: string | null, department_id: string | null = null) => ({ id, project_id, department_id, source_meeting_id });

  it("the stored department_id decides first", () => {
    const { recordings, runs } = scopeToDepartment("dept-1", webDev, [
      rec("a", null, "dept-1"),            // no project, but stored as Web Dev → in
      rec("b", "p-web-1", "dept-3"),       // Web Dev project but stored as SEO → out (the field wins)
    ], [
      run("r1", null, null, "dept-1"),     // in
      run("r2", "p-web-1", null, "dept-3"),// out
    ]);
    expect(recordings.map((r) => r.id)).toEqual(["a"]);
    expect(runs.map((r) => r.id)).toEqual(["r1"]);
  });

  it("rows that pre-date the field (department_id null) fall back to the project, then the source briefing", () => {
    const { recordings, runs } = scopeToDepartment("dept-1", webDev, [
      rec("a", "p-web-1"),                 // in via project
      rec("b", "p-seo-1"),                 // out
      rec("c", null),                      // unattributable → out
    ], [
      run("r1", "p-web-1", null),          // in via project
      run("r2", null, "mtg-a"),            // in via briefing a's project
      run("r3", null, "mtg-c"),            // out
      run("r4", null, null),               // out
    ]);
    expect(recordings.map((r) => r.id)).toEqual(["a"]);
    expect(runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});


describe("orderBriefings — what a person must act on first, and converted ones linger briefly", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const rec = (id: string, status: Parameters<typeof briefingPhase>[0], created: string, updated = created) => ({ id, status, created_at: created, updated_at: updated });
  it("ready → failed → capture → processing, newest first inside a group; ingested only if updated within the window", () => {
    const rows = orderBriefings([
      rec("old-ingested", "ingested", "2026-07-01T00:00:00Z"),
      rec("just-ingested", "ingested", "2026-08-01T00:00:00Z", "2026-08-26T11:30:00Z"),
      rec("cap-old", "recording", "2026-08-01T00:00:00Z"),
      rec("cap-new", "scheduled", "2026-08-20T00:00:00Z"),
      rec("proc", "transcribing", "2026-08-22T00:00:00Z"),
      rec("ready", "transcribed", "2026-08-10T00:00:00Z"),
      rec("fail", "failed", "2026-08-15T00:00:00Z"),
    ], now);
    expect(rows.map((r) => r.id)).toEqual(["ready", "fail", "cap-new", "cap-old", "proc", "just-ingested"]);
  });
});
