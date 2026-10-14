import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/driveActions", () => ({ loadPickerCredentialsAction: vi.fn(), attachDriveFileAction: vi.fn() }));
vi.mock("@/lib/drivePicker", () => ({ openDrivePicker: vi.fn() }));

import { loadPickerCredentialsAction, attachDriveFileAction } from "@/lib/driveActions";
import { openDrivePicker } from "@/lib/drivePicker";
import { DrivePicker } from "./DrivePicker";

// DW-6i UI: the "Attach from Google Drive" button. On click it asks the server for a fresh Picker answer, opens the Picker with it,
// posts EVERY picked id to the attach action for this task, and refreshes. A refusal is a sentence; a cancel does nothing.

const creds = { accessToken: "ya29.tok", apiKey: "key", appId: "proj" };

beforeEach(() => {
  vi.mocked(loadPickerCredentialsAction).mockReset().mockResolvedValue({ ok: true, credentials: creds });
  vi.mocked(attachDriveFileAction).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(openDrivePicker).mockReset();
  refresh.mockClear();
});

const click = () => fireEvent.click(screen.getByRole("button", { name: "Attach from Google Drive" }));

describe("DrivePicker", () => {
  it("does nothing until it is clicked: no credentials read, no Picker", () => {
    render(<DrivePicker taskId="t1" />);
    expect(loadPickerCredentialsAction).not.toHaveBeenCalled();
    expect(openDrivePicker).not.toHaveBeenCalled();
  });

  it("opens the Picker with the credentials it was given, then attaches every picked id to the task and refreshes", async () => {
    vi.mocked(openDrivePicker).mockResolvedValue(["f1", "f2", "f3"]);
    render(<DrivePicker taskId="t1" />);
    click();
    expect(await screen.findByText("Attached 3 files from Google Drive.")).toBeInTheDocument();
    expect(openDrivePicker).toHaveBeenCalledWith(creds);
    expect(vi.mocked(attachDriveFileAction).mock.calls).toEqual([["t1", "f1"], ["t1", "f2"], ["t1", "f3"]]);
    expect(refresh).toHaveBeenCalled();
  });

  it("says one file in the singular", async () => {
    vi.mocked(openDrivePicker).mockResolvedValue(["f1"]);
    render(<DrivePicker taskId="t1" />);
    click();
    expect(await screen.findByText("Attached 1 file from Google Drive.")).toBeInTheDocument();
  });

  it("a cancel attaches nothing and says nothing", async () => {
    vi.mocked(openDrivePicker).mockResolvedValue([]);
    render(<DrivePicker taskId="t1" />);
    click();
    await waitFor(() => expect(openDrivePicker).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Attach from Google Drive" })).not.toBeDisabled());
    expect(attachDriveFileAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("when the credentials are refused it says why and never opens the Picker", async () => {
    vi.mocked(loadPickerCredentialsAction).mockResolvedValue({ ok: false, error: "Google no longer accepts the saved Drive connection. Reconnect Google Drive to continue." });
    render(<DrivePicker taskId="t1" />);
    click();
    expect(await screen.findByRole("alert")).toHaveTextContent("Reconnect Google Drive to continue.");
    expect(openDrivePicker).not.toHaveBeenCalled();
  });

  it("when Google's script cannot load it says so and attaches nothing", async () => {
    vi.mocked(openDrivePicker).mockRejectedValue(new Error("Google's Picker script could not be loaded."));
    render(<DrivePicker taskId="t1" />);
    click();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(attachDriveFileAction).not.toHaveBeenCalled();
  });

  it("one refused file does not stop the others; the refusal is said once and the page still refreshes", async () => {
    vi.mocked(openDrivePicker).mockResolvedValue(["f1", "f2", "f3"]);
    vi.mocked(attachDriveFileAction)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "That file is already attached to this task." })
      .mockResolvedValueOnce({ ok: false, error: "That file is already attached to this task." });
    render(<DrivePicker taskId="t1" />);
    click();
    expect(await screen.findByText("Attached 1 file from Google Drive.")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("That file is already attached to this task.");
    expect(attachDriveFileAction).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps the token out of the page", async () => {
    vi.mocked(openDrivePicker).mockResolvedValue(["f1"]);
    const { container } = render(<DrivePicker taskId="t1" />);
    click();
    await screen.findByText("Attached 1 file from Google Drive.");
    expect(container.innerHTML).not.toContain("ya29");
  });
});
