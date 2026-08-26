import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BriefingCard, type BriefingCardActions } from "./BriefingCard";
import type { MeetingRecording } from "@/lib/meetings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

function rec(over: Partial<MeetingRecording> = {}): MeetingRecording {
  return {
    id: "rec-1", meeting_id: "mtg-1", client_id: "cl-1", project_id: null, title: "Cedar — intake call",
    kind: "audio", status: "recording", started_at: null, ended_at: null, duration_sec: null, size_bytes: null,
    drive_status: "none", drive_link: null, pipeline_run_id: null, created_by: "u-1",
    created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...over,
  };
}
function actions(over: Partial<BriefingCardActions> = {}): BriefingCardActions {
  return {
    upload: vi.fn(async () => ({ ok: true, id: "rec-1", audioRef: "a" })),
    retry: vi.fn(async () => ({ ok: true, id: "rec-1" })),
    ingest: vi.fn(async () => ({ ok: true, id: "rec-1", runId: "run-9" })),
    ...over,
  };
}

describe("BriefingCard — waiting for its recording", () => {
  it("says there is no recording yet and offers the three ways to add one", () => {
    render(<BriefingCard recording={rec()} clientName="Cedar Group" actions={actions()} />);
    expect(screen.getByText("No recording yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record here/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /desktop capture helper/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload a file/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /convert to prd run/i })).not.toBeInTheDocument();
  });

  it("choosing 'Upload a file' reveals only that method's panel", () => {
    render(<BriefingCard recording={rec()} actions={actions()} />);
    fireEvent.click(screen.getByRole("button", { name: /upload a file/i }));
    expect(screen.getByLabelText(/audio or video file/i)).toBeInTheDocument();
    expect(screen.queryByText(/meeting id/i)).not.toBeInTheDocument();
  });

  it("choosing the desktop helper shows the meeting id it attaches to", () => {
    render(<BriefingCard recording={rec()} actions={actions()} />);
    fireEvent.click(screen.getByRole("button", { name: /desktop capture helper/i }));
    expect(screen.getByText("mtg-1")).toBeInTheDocument();
  });
});

describe("BriefingCard — processing", () => {
  it("transcribing shows a hands-off note and no actions", () => {
    render(<BriefingCard recording={rec({ status: "transcribing" })} actions={actions()} />);
    expect(screen.getByText("Transcribing")).toBeInTheDocument();
    expect(screen.getByText(/updates by itself/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("BriefingCard — transcript ready", () => {
  it("offers exactly one primary action: convert to a PRD run", async () => {
    const ingest = vi.fn<BriefingCardActions["ingest"]>(async () => ({ ok: true, id: "rec-1", runId: "run-9" }));
    render(<BriefingCard recording={rec({ status: "transcribed" })} actions={actions({ ingest })} />);
    expect(screen.getByText("Transcript ready")).toBeInTheDocument();
    const convert = screen.getByRole("button", { name: /convert to prd run/i });
    fireEvent.click(convert);
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    expect(String(ingest.mock.calls[0][1].get("id"))).toBe("rec-1");
  });

  it("explains an ingest failure in plain words instead of failing silently", async () => {
    const a = actions({ ingest: vi.fn(async () => ({ ok: false, error: "Pipeline bridge not configured — set N8N_WEBHOOK_BASE_URL + N8N_BRIDGE_SECRET on the platform.", reason: "bridge_not_configured" })) });
    render(<BriefingCard recording={rec({ status: "transcribed" })} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: /convert to prd run/i }));
    await waitFor(() => expect(screen.getByText(/bridge not configured/i)).toBeInTheDocument());
  });
});

describe("BriefingCard — failed", () => {
  it("offers a retry and the upload fallback", () => {
    render(<BriefingCard recording={rec({ status: "failed" })} actions={actions()} />);
    expect(screen.getByText("Transcription failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry transcription/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload a different file/i })).toBeInTheDocument();
  });
});
