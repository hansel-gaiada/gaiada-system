import { describe, it, expect } from "vitest";
import { approvalTrack, briefingPhase, flowCounts } from "./prdFlow";
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
    expect(t.sentence).toMatch(/still being drafted/i);
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
