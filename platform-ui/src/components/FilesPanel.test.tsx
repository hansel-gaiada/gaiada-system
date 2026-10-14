import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileMeta } from "@/lib/entities";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/driveActions", () => ({ loadPickerCredentialsAction: vi.fn(), attachDriveFileAction: vi.fn() }));
vi.mock("@/lib/drivePicker", () => ({ openDrivePicker: vi.fn() }));
const upload = vi.fn();
const attach = vi.fn();
vi.mock("@/lib/collabActions", () => ({
  attachFileAction: (...a: unknown[]) => attach(...a),
  deleteFileAction: vi.fn(async () => ({ ok: true })),
  uploadFileAction: (...a: unknown[]) => upload(...a),
}));

import { FilesPanel } from "./FilesPanel";

// DW-8h (contract 45): the panel's honest sentences, the 25 MB refusal, the scrubbed notice, the download link and the
// revalidated path.

const file = (over: Partial<FileMeta> = {}): FileMeta => ({
  id: "f1", filename: "Brief.pdf", content_type: "application/pdf", byte_size: 1536, scrubbed: false, uploader_id: "u1",
  created_at: "2026-10-14T08:00:00Z", url: null, ...over,
});
const base = { entityType: "work_request", entityId: "r1", revalidate: "/requests/r1" };

beforeEach(() => { upload.mockReset(); attach.mockReset(); });

describe("FilesPanel: a read that did not return files", () => {
  it("says a refusal as a refusal, never as an empty list", () => {
    render(<FilesPanel {...base} result={{ kind: "forbidden" }} />);
    expect(screen.getByText("You can't see this item's files.")).toBeInTheDocument();
    expect(screen.queryByText("No attachments.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });
  it("says a missing item as missing", () => {
    render(<FilesPanel {...base} result={{ kind: "unavailable", reason: "target_not_found" }} />);
    expect(screen.getByText("This item no longer exists.")).toBeInTheDocument();
  });
  it("says an unreachable platform as that", () => {
    render(<FilesPanel {...base} result={{ kind: "unavailable", reason: "502 bad gateway" }} />);
    expect(screen.getByText("Files can't be read right now.")).toBeInTheDocument();
    expect(screen.queryByText("No attachments.")).toBeNull();
  });
  it("an honest empty list still says there are none", () => {
    render(<FilesPanel {...base} result={{ kind: "ok", data: [] }} />);
    expect(screen.getByText("No attachments.")).toBeInTheDocument();
  });
});

describe("FilesPanel: the files", () => {
  it("links an uploaded file to the download route", () => {
    render(<FilesPanel {...base} result={{ kind: "ok", data: [file()] }} />);
    expect(screen.getByRole("link", { name: "Download Brief.pdf" })).toHaveAttribute("href", "/api/files/f1");
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
  });
  it("shows the staff-only line when given", () => {
    render(<FilesPanel {...base} entityType="client" result={{ kind: "ok", data: [] }} note="Only staff see these files." />);
    expect(screen.getByText("Only staff see these files.")).toBeInTheDocument();
  });
  it("offers Upload and the link attach to an editor, and neither to a reader", () => {
    const { unmount } = render(<FilesPanel {...base} result={{ kind: "ok", data: [] }} />);
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    unmount();
    render(<FilesPanel {...base} canEdit={false} result={{ kind: "ok", data: [] }} />);
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });
});

describe("FilesPanel: upload", () => {
  const pick = (f: File) => {
    const input = screen.getByLabelText("File to upload") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [f] } });
    fireEvent.submit(input.form as HTMLFormElement);
  };

  it("sends the file to the action with the page path to revalidate", async () => {
    upload.mockResolvedValue({ ok: true, id: "n1", scrubbed: false });
    render(<FilesPanel {...base} result={{ kind: "ok", data: [] }} />);
    pick(new File(["hello"], "a.txt", { type: "text/plain" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0].slice(0, 3)).toEqual(["work_request", "r1", "/requests/r1"]);
    expect(screen.queryByText("Personal data was removed from the stored copy.")).toBeNull();
  });

  it("refuses a file over 25 MB before anything is sent", async () => {
    render(<FilesPanel {...base} result={{ kind: "ok", data: [] }} />);
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    pick(big);
    expect(await screen.findByText("Files can be at most 25 MB.")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it("says when personal data was removed from the stored copy", async () => {
    upload.mockResolvedValue({ ok: true, id: "n1", scrubbed: true });
    render(<FilesPanel {...base} result={{ kind: "ok", data: [] }} />);
    pick(new File(["call 0812"], "a.txt", { type: "text/plain" }));
    expect(await screen.findByText("Personal data was removed from the stored copy.")).toBeInTheDocument();
  });

  it("shows the action's refusal sentence", async () => {
    upload.mockResolvedValue({ ok: false, error: "Only the people on this request can add files." });
    render(<FilesPanel {...base} result={{ kind: "ok", data: [] }} />);
    pick(new File(["x"], "a.txt"));
    expect(await screen.findByText("Only the people on this request can add files.")).toBeInTheDocument();
  });
});
