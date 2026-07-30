import { describe, it, expect } from "vitest";
import { meetingsDemo, demoUploadAudio, demoRetryAudio } from "./demoMeetings";

// WD-07 (Web Dev Phase 1 §12, Part A) — the DEMO_MODE equivalent of the WD-04 in-ERP
// audio-upload path. These are the demo-mode analogues of the real backend's proven behaviour
// (200MB cap / type allowlist / transcribing→transcribed|failed / retry-only-from-failed).
describe("demoMeetings — WD-04/WD-07 audio upload + retry", () => {
  function freshRecordingId(): string {
    const start = meetingsDemo("POST", "/api/t1/meetings/recordings/start", new URLSearchParams(), JSON.stringify({ kind: "audio" }));
    expect(start).not.toBeNull();
    return (start!.json as { id: string }).id;
  }

  it("uploads audio and resolves to transcribed for an ordinary filename", () => {
    const id = freshRecordingId();
    const res = demoUploadAudio(id, "kickoff.m4a", 4096);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ id, status: "transcribing" });
    // The underlying demo record has already resolved (no real async job in demo mode) —
    // the very next status read reflects the terminal state, same as the real poll contract.
    const detail = meetingsDemo("GET", `/api/t1/meetings/recordings/${id}`, new URLSearchParams());
    expect(detail).not.toBeNull();
    expect((detail!.json as { status: string; transcript: string | null }).status).toBe("transcribed");
    expect((detail!.json as { transcript: string | null }).transcript).toContain("kickoff.m4a");
  });

  it("simulates a whisper-down failure for a filename containing 'fail'", () => {
    const id = freshRecordingId();
    const res = demoUploadAudio(id, "bad-fail-clip.wav", 2048);
    expect(res.status).toBe(202); // the upload response itself is always fire-and-forget 202
    const detail = meetingsDemo("GET", `/api/t1/meetings/recordings/${id}`, new URLSearchParams());
    expect((detail!.json as { status: string }).status).toBe("failed");
  });

  it("404s an upload against an unknown recording id", () => {
    const res = demoUploadAudio("nope", "x.m4a", 10);
    expect(res.status).toBe(404);
  });

  it("retry recovers a failed recording to transcribed", () => {
    const id = freshRecordingId();
    demoUploadAudio(id, "fail-please.mp3", 1024);
    let detail = meetingsDemo("GET", `/api/t1/meetings/recordings/${id}`, new URLSearchParams());
    expect((detail!.json as { status: string }).status).toBe("failed");

    const retry = demoRetryAudio(id);
    expect(retry.status).toBe(202);
    expect(retry.json).toMatchObject({ id, status: "transcribing" });

    detail = meetingsDemo("GET", `/api/t1/meetings/recordings/${id}`, new URLSearchParams());
    expect((detail!.json as { status: string }).status).toBe("transcribed");
  });

  it("refuses a retry when there is no uploaded audio at all", () => {
    const id = freshRecordingId(); // never uploaded — audio_ref stays null
    const res = demoRetryAudio(id);
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/no uploaded audio/);
  });

  it("refuses a retry when the recording is not currently failed", () => {
    const id = freshRecordingId();
    demoUploadAudio(id, "fine.m4a", 1024); // resolves to transcribed, not failed
    const res = demoRetryAudio(id);
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/retry only allowed from status 'failed'/);
  });

  it("client/project scoping survives the start→upload round trip (WD-07 Part B plumbing)", () => {
    const start = meetingsDemo(
      "POST",
      "/api/t1/meetings/recordings/start",
      new URLSearchParams(),
      JSON.stringify({ kind: "audio", clientId: "cl-42", projectId: "p-99" }),
    );
    const id = (start!.json as { id: string }).id;
    const list = meetingsDemo("GET", "/api/t1/meetings/recordings", new URLSearchParams([["projectId", "p-99"]]));
    const rows = list!.json as Array<{ id: string; client_id: string | null; project_id: string | null }>;
    const row = rows.find((r) => r.id === id);
    expect(row).toBeTruthy();
    expect(row!.client_id).toBe("cl-42");
    expect(row!.project_id).toBe("p-99");
  });
});
