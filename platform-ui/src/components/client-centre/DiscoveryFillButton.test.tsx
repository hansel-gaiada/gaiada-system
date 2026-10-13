import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiscoveryFillButton } from "./DiscoveryFillButton";

let path = "/clients/cl-1/profile/company";
vi.mock("next/navigation", () => ({ usePathname: () => path }));

const noReload = () => {};

describe("DiscoveryFillButton", () => {
  it("shows the count and runs the fill, then toasts how many fields were filled", async () => {
    path = "/clients/cl-1/profile/company";
    const preview = vi.fn(async () => ({ available: true, fillable: ["legal", "website", "cms"] }));
    const fill = vi.fn(async () => ({ ok: true, filled: ["legal", "website"], skipped: [] }));
    render(<DiscoveryFillButton isPortal={false} canEdit previewAction={preview} fillAction={fill} reload={noReload} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fill from discovery answers (3 fields)" }));
    expect(await screen.findByText("2 fields filled from the discovery answers.")).toBeInTheDocument();
    expect(fill).toHaveBeenCalledWith("cl-1");
    expect(preview).toHaveBeenCalledWith("cl-1");
  });

  it("is hidden when nothing is available or fillable", async () => {
    path = "/clients/cl-1/profile/company";
    for (const p of [{ available: false, fillable: [] }, { available: true, fillable: [] }]) {
      const preview = vi.fn(async () => p);
      const { unmount } = render(<DiscoveryFillButton isPortal={false} canEdit previewAction={preview} fillAction={vi.fn()} reload={noReload} />);
      await waitFor(() => expect(preview).toHaveBeenCalled());
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });

  it("is hidden, and never asks the server, for the portal, a read-only caller or a non-staff route", async () => {
    const preview = vi.fn(async () => ({ available: true, fillable: ["legal"] }));
    path = "/clients/cl-1/profile/company";
    render(<DiscoveryFillButton isPortal canEdit previewAction={preview} fillAction={vi.fn()} />);
    render(<DiscoveryFillButton isPortal={false} canEdit={false} previewAction={preview} fillAction={vi.fn()} />);
    path = "/portal/company/cl-1/company";
    render(<DiscoveryFillButton isPortal={false} canEdit previewAction={preview} fillAction={vi.fn()} />);
    await Promise.resolve();
    expect(preview).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the server's error instead of a count when the fill is refused", async () => {
    path = "/clients/cl-1/profile/company";
    const fill = vi.fn(async () => ({ ok: false, error: "no discovery answers for this client" }));
    render(<DiscoveryFillButton isPortal={false} canEdit previewAction={async () => ({ available: true, fillable: ["legal"] })} fillAction={fill} reload={noReload} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fill from discovery answers (1 field)" }));
    expect(await screen.findByText("no discovery answers for this client")).toBeInTheDocument();
  });
});
