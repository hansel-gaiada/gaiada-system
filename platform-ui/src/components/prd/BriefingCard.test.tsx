import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BriefingCard, type BriefingCardActions } from "./BriefingCard";
import type { MeetingRecording } from "@/lib/meetings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

function rec(over: Partial<MeetingRecording> = {}): MeetingRecording {
  return {
    id: "rec-1", meeting_id: "mtg-1", client_id: "cl-1", project_id: null, department_id: "dept-1", title: "Cedar — intake call",
    kind: "audio", status: "recording", started_at: null, ended_at: null, duration_sec: null, size_bytes: null,
    drive_status: "none", drive_link: null, pipeline_run_id: null, created_by: "u-1",
    created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...over,
  };
}
function actions(over: Partial<BriefingCardActions> = {}): BriefingCardActions {
  return {
    upload: vi.fn(async () => ({ ok: true, id: "rec-1", audioRef: "a" })),
    uploadFile: vi.fn(async () => ({ ok: true as const })),
    retry: vi.fn(async () => ({ ok: true, id: "rec-1" })),
    setTranscript: vi.fn(async () => ({ ok: true, id: "rec-1" })),
    ingest: vi.fn(async () => ({ ok: true, id: "rec-1", runId: "run-9" })),
    startRunManually: vi.fn(async () => ({ ok: true, id: "rec-1", runId: "run-9" })),
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
    expect(screen.getByRole("button", { name: /upload a transcript/i })).toBeInTheDocument();
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

describe("BriefingCard — a transcript can be supplied directly, no transcription service needed", () => {
  it("pasting a transcript saves it and the briefing is immediately ready to convert", async () => {
    const setTranscript = vi.fn<BriefingCardActions["setTranscript"]>(async () => ({ ok: true, id: "rec-1" }));
    render(<BriefingCard recording={rec()} actions={actions({ setTranscript })} />);
    fireEvent.click(screen.getByRole("button", { name: /upload a transcript/i }));
    const box = screen.getByLabelText(/paste the transcript/i);
    fireEvent.change(box, { target: { value: "Client wants two-step checkout. Guest checkout stays." } });
    fireEvent.click(screen.getByRole("button", { name: /save transcript/i }));
    await waitFor(() => expect(setTranscript).toHaveBeenCalledTimes(1));
    const fd = setTranscript.mock.calls[0][1];
    expect(fd.get("id")).toBe("rec-1");
    expect(fd.get("text")).toBe("Client wants two-step checkout. Guest checkout stays.");
    await waitFor(() => expect(screen.getByText("Transcript ready")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /convert to prd run/i })).toBeInTheDocument();
  });

  it("a chosen .srt file is read in the browser, cleaned, and shown before saving", async () => {
    render(<BriefingCard recording={rec()} actions={actions()} />);
    fireEvent.click(screen.getByRole("button", { name: /upload a transcript/i }));
    const srt = new File(["1\n00:00:01,000 --> 00:00:04,000\nClient wants two-step checkout.\n"], "call.srt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/transcript file/i), { target: { files: [srt] } });
    await waitFor(() => expect((screen.getByLabelText(/paste the transcript/i) as HTMLTextAreaElement).value).toBe("Client wants two-step checkout."));
    expect(screen.getByText(/1 line · 31 characters/i)).toBeInTheDocument();
  });

  it("the transcript option is also offered when transcription failed", () => {
    render(<BriefingCard recording={rec({ status: "failed" })} actions={actions()} />);
    expect(screen.getByRole("button", { name: /upload a transcript instead/i })).toBeInTheDocument();
  });
});

describe("BriefingCard — uploading a file shows progress, then hands off to transcribing", () => {
  it("streams the chosen file through uploadFile with progress, then flips to Transcribing", async () => {
    let report: ((p: { fraction: number; loaded: number; total: number }) => void) | null = null;
    let finish: ((o: { ok: true }) => void) | null = null;
    const uploadFile = vi.fn<NonNullable<BriefingCardActions["uploadFile"]>>((_id, _file, onProgress) => {
      report = onProgress;
      return new Promise((res) => { finish = res; });
    });
    render(<BriefingCard recording={rec()} actions={actions({ uploadFile })} />);
    fireEvent.click(screen.getByRole("button", { name: /upload a file/i }));
    const input = screen.getByLabelText(/audio or video file/i) as HTMLInputElement;
    const file = new File([new Uint8Array(1024)], "kickoff.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /upload & transcribe/i }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith("rec-1", file, expect.any(Function)));
    report!({ fraction: 0.43, loaded: 86 * 1024 * 1024, total: 200 * 1024 * 1024 });
    await waitFor(() => expect(screen.getByText(/43%/)).toBeInTheDocument());
    expect(screen.getByText(/86 MB of 200 MB/i)).toBeInTheDocument();
    finish!({ ok: true });
    await waitFor(() => expect(screen.getByText("Transcribing")).toBeInTheDocument());
  });

  it("a rejected upload says why, in the platform's words, and lets you pick another file", async () => {
    const uploadFile = vi.fn<NonNullable<BriefingCardActions["uploadFile"]>>(async () => ({ ok: false, status: 413, error: "file exceeds MEETING_VIDEO_MAX_BYTES (500 MB)" }));
    render(<BriefingCard recording={rec()} actions={actions({ uploadFile })} />);
    fireEvent.click(screen.getByRole("button", { name: /upload a file/i }));
    fireEvent.change(screen.getByLabelText(/audio or video file/i), { target: { files: [new File(["x"], "huge.mp4")] } });
    fireEvent.click(screen.getByRole("button", { name: /upload & transcribe/i }));
    await waitFor(() => expect(screen.getByText(/exceeds MEETING_VIDEO_MAX_BYTES/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /upload & transcribe/i })).toBeInTheDocument();
    expect(screen.getByText("No recording yet")).toBeInTheDocument();
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

  it("a missing pipeline bridge is explained in human words, not the env-var message", async () => {
    const a = actions({ ingest: vi.fn(async () => ({ ok: false, error: "Pipeline bridge not configured — set N8N_WEBHOOK_BASE_URL + N8N_BRIDGE_SECRET on the platform.", reason: "bridge_not_configured" })) });
    render(<BriefingCard recording={rec({ status: "transcribed" })} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: /convert to prd run/i }));
    await waitFor(() => expect(screen.getByText(/ai pipeline .*isn.t connected/i)).toBeInTheDocument());
    expect(screen.queryByText(/N8N_WEBHOOK_BASE_URL/)).not.toBeInTheDocument();
  });
});

describe("BriefingCard — when the AI pipeline is not connected, the run can still be started by hand", () => {
  const noBridge = () => vi.fn<BriefingCardActions["ingest"]>(async () => ({ ok: false, error: "Pipeline bridge not configured — set N8N_WEBHOOK_BASE_URL + N8N_BRIDGE_SECRET on the platform.", reason: "bridge_not_configured" }));

  it("explains in plain words and offers to start the run without the AI draft", async () => {
    render(<BriefingCard recording={rec({ status: "transcribed" })} actions={actions({ ingest: noBridge() })} />);
    fireEvent.click(screen.getByRole("button", { name: /convert to prd run/i }));
    await waitFor(() => expect(screen.getByText(/ai pipeline .*isn.t connected/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /start the run without the ai draft/i })).toBeInTheDocument();
  });

  it("starting it by hand converts the briefing and points at the run workspace", async () => {
    const startRunManually = vi.fn<BriefingCardActions["startRunManually"]>(async () => ({ ok: true, id: "rec-1", runId: "run-77" }));
    render(<BriefingCard recording={rec({ status: "transcribed" })} actions={actions({ ingest: noBridge(), startRunManually })} />);
    fireEvent.click(screen.getByRole("button", { name: /convert to prd run/i }));
    const manual = await screen.findByRole("button", { name: /start the run without the ai draft/i });
    fireEvent.click(manual);
    await waitFor(() => expect(startRunManually).toHaveBeenCalledTimes(1));
    expect(startRunManually.mock.calls[0][1].get("id")).toBe("rec-1");
    await waitFor(() => expect(screen.getByText("In the pipeline")).toBeInTheDocument());
    expect(screen.getByText(/write or paste the prd in the run workspace/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the run/i })).toHaveAttribute("href", "/pipeline/run-77");
  });

  it("an ordinary ingest error does NOT offer the manual path", async () => {
    const ingest = vi.fn<BriefingCardActions["ingest"]>(async () => ({ ok: false, error: "Dispatcher error: dispatcher_500.", reason: "dispatcher_500" }));
    render(<BriefingCard recording={rec({ status: "transcribed" })} actions={actions({ ingest })} />);
    fireEvent.click(screen.getByRole("button", { name: /convert to prd run/i }));
    await waitFor(() => expect(screen.getByText(/dispatcher error/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /start the run without the ai draft/i })).not.toBeInTheDocument();
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
