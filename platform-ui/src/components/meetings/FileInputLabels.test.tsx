import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AudioUploadForm } from "./AudioUploadForm";
import { RecordControls } from "./RecordControls";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/meetingsActions", () => ({ startRecordingAction: vi.fn(), registerAndUploadAudioAction: vi.fn() }));

// PV4-12: axe `label` (critical) — every <input type="file"> on the meeting page needs an accessible name.
describe("meeting file inputs have an accessible name", () => {
  it("AudioUploadForm", () => {
    const action = vi.fn();
    render(<AudioUploadForm recordingId="r1" initialStatus="failed" hasAudioRef={false} uploadAction={action} retryAction={action} />);
    const input = screen.getByLabelText("Audio or video file");
    expect(input).toHaveAttribute("type", "file");
  });
  it("RecordControls (upload form)", () => {
    render(<RecordControls clientId="c1" />);
    screen.getByRole("button", { name: "Upload a file" }).click();
    return screen.findByLabelText("Audio or video file").then((input) => expect(input).toHaveAttribute("type", "file"));
  });
});
