import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FileMeta } from "@/lib/entities";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/driveActions", () => ({ loadPickerCredentialsAction: vi.fn(), attachDriveFileAction: vi.fn() }));
vi.mock("@/lib/drivePicker", () => ({ openDrivePicker: vi.fn() }));

import { Attachments } from "./Attachments";

// DW-6i UI: the attachment list opens a reference's link in a new tab (with a Drive mark for Google links), keeps a plain file
// as it was, and offers "Attach from Google Drive" only when the person is connected and Drive is configured.

const file = (over: Partial<FileMeta> = {}): FileMeta => ({
  id: "f1", filename: "Brief.docx", content_type: "application/octet-stream", byte_size: 10, scrubbed: false, uploader_id: "u1",
  created_at: "2026-10-14T08:00:00Z", url: null, ...over,
});
const noop = async () => ({ ok: true });
const base = { canEdit: true, attach: noop, remove: noop };
const driveName = "Attach from Google Drive";

describe("Attachments: a file with a link", () => {
  it("opens the link in a new tab with rel noopener noreferrer", () => {
    render(<Attachments {...base} files={[file({ filename: "Plan", url: "https://example.com/plan" })]} />);
    const a = screen.getByRole("link", { name: "Plan" });
    expect(a).toHaveAttribute("href", "https://example.com/plan");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("marks a Google Drive or Docs link with the Drive mark", () => {
    render(
      <Attachments
        {...base}
        files={[
          file({ id: "a", filename: "Drive file", url: "https://drive.google.com/file/d/abc/view" }),
          file({ id: "b", filename: "Doc", url: "https://docs.google.com/document/d/abc/edit" }),
        ]}
      />,
    );
    expect(screen.getAllByLabelText("Google Drive")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Drive file" })).toHaveAttribute("target", "_blank");
  });

  it("gives another site's link no Drive mark, even when it names Drive in its path", () => {
    render(<Attachments {...base} files={[file({ filename: "Look", url: "https://evil.test/drive.google.com/x" })]} />);
    expect(screen.queryByLabelText("Google Drive")).toBeNull();
    expect(screen.getByRole("link", { name: "Look" })).toBeInTheDocument();
  });
});

describe("Attachments: a file without a link", () => {
  it("stays plain text, with no link and no mark", () => {
    render(<Attachments {...base} files={[file({ filename: "Notes.txt", url: null })]} />);
    expect(screen.getByText("Notes.txt")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByLabelText("Google Drive")).toBeNull();
  });

  it("copes with an older platform that sends no url at all", () => {
    const f = file({ filename: "Old.txt" });
    delete (f as { url?: unknown }).url;
    render(<Attachments {...base} files={[f]} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("Attachments: Attach from Google Drive", () => {
  it("is shown when the person is connected and Drive is configured", () => {
    render(<Attachments {...base} files={[]} canAttachFromDrive driveTaskId="t1" />);
    expect(screen.getByRole("button", { name: driveName })).toBeInTheDocument();
  });

  it("is not shown by default (not connected, not configured, or the read failed)", () => {
    render(<Attachments {...base} files={[]} driveTaskId="t1" />);
    expect(screen.queryByRole("button", { name: driveName })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
  });

  it("is not shown without a task to attach to", () => {
    render(<Attachments {...base} files={[]} canAttachFromDrive />);
    expect(screen.queryByRole("button", { name: driveName })).toBeNull();
  });

  it("is not shown to someone who cannot edit", () => {
    render(<Attachments {...base} canEdit={false} files={[]} canAttachFromDrive driveTaskId="t1" />);
    expect(screen.queryByRole("button", { name: driveName })).toBeNull();
  });
});
