import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// PV7-04b — a report's download link also marks the report read. The marker is fired from the click and NEVER prevents the
// browser's own download: a failed or rejected marker is swallowed and the report simply stays New.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/portalActions", () => ({ markPortalReportRead: vi.fn() }));

import { markPortalReportRead } from "@/lib/portalActions";
import { PortalReportDownload } from "./PortalReportDownload";

const mark = vi.mocked(markPortalReportRead);
const mount = (isNew: boolean) =>
  render(<PortalReportDownload tenant="northwind" reportId="r1" fileId="f1" label="Download PDF" title="September report" isNew={isNew} />);

// `fireEvent.click` returns false when a handler called preventDefault, which would stop the browser's download.
const clickAndCheckNotPrevented = async (el: HTMLElement): Promise<boolean> => fireEvent.click(el);

beforeEach(() => { mark.mockReset(); refresh.mockReset(); });

describe("PortalReportDownload", () => {
  it("links the portal's own file route for the file, with an accessible name that includes the report's title", () => {
    mount(true);
    const a = screen.getByRole("link", { name: "Download PDF: September report" });
    expect(a).toHaveAttribute("href", "/api/northwind/portal/files/f1");
    expect(a).toHaveAttribute("download");
  });

  it("marks a New report read on click, leaves the click alone, then refreshes the page", async () => {
    mark.mockResolvedValue({ ok: true, id: "r1" });
    mount(true);
    const a = screen.getByRole("link");
    expect(await clickAndCheckNotPrevented(a)).toBe(true);
    expect(mark).toHaveBeenCalledWith("r1");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("sends no marker for a report already read", async () => {
    mount(false);
    fireEvent.click(screen.getByRole("link"));
    expect(mark).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a failed marker does not break the download, throw, or refresh", async () => {
    mark.mockResolvedValue({ ok: false, error: "report not found" });
    mount(true);
    expect(await clickAndCheckNotPrevented(screen.getByRole("link"))).toBe(true);
    await waitFor(() => expect(mark).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a rejected marker is swallowed", async () => {
    mark.mockRejectedValue(new Error("network"));
    mount(true);
    expect(await clickAndCheckNotPrevented(screen.getByRole("link"))).toBe(true);
    await waitFor(() => expect(mark).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });
});
