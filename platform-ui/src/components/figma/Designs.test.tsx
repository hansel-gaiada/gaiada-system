import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { FigmaLink, FigmaLinks } from "@/lib/figma";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/figmaActions", () => ({
  addFigmaLinkAction: vi.fn(), removeFigmaLinkAction: vi.fn(), exportFigmaLinkAction: vi.fn(),
}));

import { addFigmaLinkAction, exportFigmaLinkAction, removeFigmaLinkAction } from "@/lib/figmaActions";
import { Designs } from "./Designs";

// DW-6k UI: the Designs section's states (BFF §36.6). Pinned: cached values shown; Figma not connected says so once and still
// shows the links; a `null` count is never "0"; stale is said; a refusal is a sentence; an export names its version.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const link = (over: Partial<FigmaLink> = {}): FigmaLink => ({
  id: "l1", targetKind: "pm_task", targetId: "t1", fileKey: "k1", nodeId: "1:2",
  url: "https://www.figma.com/design/k1?node-id=1-2", title: "Brand / Hero", lastModified: "2026-10-14T10:00:00.000Z",
  openComments: 3, cachedAt: "2026-10-14T11:55:00.000Z", assetGroupId: null, stale: false, refreshError: null, ...over,
});
const ok = (items: FigmaLink[], figmaConnected = true): { kind: "ok"; data: FigmaLinks } => ({ kind: "ok", data: { figmaConnected, items } });
const view = (result: Parameters<typeof Designs>[0]["result"], over: Partial<Parameters<typeof Designs>[0]> = {}) =>
  render(<Designs targetKind="pm_task" targetId="t1" result={result} now={NOW} {...over} />);

beforeEach(() => {
  vi.mocked(addFigmaLinkAction).mockReset();
  vi.mocked(removeFigmaLinkAction).mockReset();
  vi.mocked(exportFigmaLinkAction).mockReset();
  refresh.mockClear();
});

describe("Designs: a link with cached values", () => {
  it("shows the thumbnail through platform-ui's proxy, lazily, with the title as its alt text", () => {
    view(ok([link()]));
    const img = screen.getByRole("img", { name: "Brand / Hero" });
    expect(img).toHaveAttribute("src", "/api/figma-links/l1/thumbnail");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("shows the title, when it changed, its open comments (opening Figma at the frame) and Open in Figma", () => {
    view(ok([link()]));
    const item = screen.getByRole("listitem", { name: "Brand / Hero" });
    expect(within(item).getByText("Brand / Hero")).toBeInTheDocument();
    expect(within(item).getByText("changed 2 hours ago")).toBeInTheDocument();
    const comments = within(item).getByRole("link", { name: "3 open comments" });
    expect(comments).toHaveAttribute("href", "https://www.figma.com/design/k1?node-id=1-2");
    expect(comments).toHaveAttribute("target", "_blank");
    expect(comments.getAttribute("rel")).toContain("noopener");
    expect(within(item).getByRole("link", { name: "Open in Figma" })).toHaveAttribute("href", "https://www.figma.com/design/k1?node-id=1-2");
  });

  it("says nothing about stale for a fresh link", () => {
    view(ok([link()]));
    expect(screen.queryByText(/Stale/)).toBeNull();
  });

  it("says a link is stale, and why, while still showing its last values", () => {
    view(ok([link({ stale: true, refreshError: "figma_rate_limited" })]));
    expect(screen.getByText(/^Stale: these are the last values read from Figma\. Figma is limiting requests\.$/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "3 open comments" })).toBeInTheDocument();
  });

  it("falls back to 'Preview unavailable' when the thumbnail cannot be loaded", () => {
    view(ok([link()]));
    fireEvent.error(screen.getByRole("img", { name: "Brand / Hero" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
  });

  it("never turns a stored address that is not a Figma https link into a link", () => {
    view(ok([link({ url: "javascript:alert(1)" })]));
    expect(screen.queryByRole("link", { name: "Open in Figma" })).toBeNull();
    expect(screen.queryByRole("link", { name: "3 open comments" })).toBeNull();
    expect(screen.getByText("3 open comments")).toBeInTheDocument(); // the count is still said, as text
  });
});

describe("Designs: null is 'not read yet', never 0", () => {
  const unread = link({ title: null, lastModified: null, openComments: null, cachedAt: null });

  it("says the comments, title and change time have not been read", () => {
    view(ok([unread], false));
    expect(screen.getByText("Comments not read yet")).toBeInTheDocument();
    expect(screen.getByText("Title not read from Figma yet")).toBeInTheDocument();
    expect(screen.getByText("Last change not read yet")).toBeInTheDocument();
    expect(screen.queryByText(/\b0\b/)).toBeNull();
    expect(screen.queryByText(/No open comments/)).toBeNull();
  });

  it("says 'No open comments' only for a real zero", () => {
    view(ok([link({ openComments: 0 })]));
    expect(screen.getByText("No open comments")).toBeInTheDocument();
  });
});

describe("Designs: Figma is not connected", () => {
  it("still shows the links with their cached values, plus the one line", () => {
    view(ok([link({ stale: true, refreshError: "figma_not_connected" })], false));
    expect(screen.getAllByText(/Figma isn't connected for this company/)).toHaveLength(1);
    expect(screen.getByText("Brand / Hero")).toBeInTheDocument();
    expect(screen.getByText("changed 2 hours ago")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "3 open comments" })).toBeInTheDocument();
  });

  it("offers a manager a link to Tools & connections, and everyone else only the line", () => {
    const { unmount } = view(ok([link()], false), { connectionsHref: "/departments/d-1/connections" });
    expect(screen.getByRole("link", { name: "Connect it under Tools & connections" })).toHaveAttribute("href", "/departments/d-1/connections");
    unmount();
    view(ok([link()], false), { connectionsHref: null });
    expect(screen.queryByRole("link", { name: /Tools & connections/ })).toBeNull();
    expect(screen.getByText(/Figma isn't connected for this company/)).toBeInTheDocument();
  });

  it("says nothing about connection when Figma is connected", () => {
    view(ok([link()], true));
    expect(screen.queryByText(/isn't connected/)).toBeNull();
  });

  it("says 'no designs linked' only for a read that answered with an empty list", () => {
    view(ok([], false));
    expect(screen.getByText("No Figma designs are linked here yet.")).toBeInTheDocument();
    expect(screen.getByText(/Figma isn't connected for this company/)).toBeInTheDocument();
  });
});

describe("Designs: a refused or failed read is never an empty list", () => {
  it("forbidden is said as forbidden", () => {
    view({ kind: "forbidden" });
    expect(screen.getByText("You can't see the designs linked here.")).toBeInTheDocument();
    expect(screen.queryByText(/No Figma designs/)).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("unavailable carries the reason and says it does not mean there are none", () => {
    view({ kind: "unavailable", reason: "socket hang up" });
    expect(screen.getByText(/can't be shown right now \(socket hang up\)\. That doesn't mean there are none\./)).toBeInTheDocument();
    expect(screen.queryByText(/No Figma designs/)).toBeNull();
  });
});

describe("Designs: adding a link", () => {
  const paste = (v: string) => {
    fireEvent.change(screen.getByLabelText("Figma link"), { target: { value: v } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  };

  it("sends the pasted URL for this target and refreshes the page on success", async () => {
    vi.mocked(addFigmaLinkAction).mockResolvedValue({ ok: true, link: link() });
    view(ok([]));
    paste("https://www.figma.com/design/k1");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(addFigmaLinkAction).toHaveBeenCalledWith("pm_task", "t1", "https://www.figma.com/design/k1");
  });

  it("shows the backend's refusal in plain words and does not refresh", async () => {
    vi.mocked(addFigmaLinkAction).mockResolvedValue({ ok: false, error: "That doesn't look like a Figma link. Paste the address of a Figma file or frame." });
    view(ok([]));
    paste("http://example.com");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That doesn't look like a Figma link.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a 403 is a sentence under the form, not a crash", async () => {
    vi.mocked(addFigmaLinkAction).mockResolvedValue({ ok: false, error: "You don't have permission to do that. Ask the item's owner or a manager." });
    view(ok([]));
    paste("https://www.figma.com/design/k1");
    expect(await screen.findByRole("alert")).toHaveTextContent("don't have permission");
  });

  it("asks for a link first when the field is empty, without calling the server", () => {
    view(ok([]));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Paste a Figma link first.");
    expect(addFigmaLinkAction).not.toHaveBeenCalled();
  });

  it("is offered on every state that has a list, so the server decides who may write", () => {
    view(ok([link()]));
    expect(screen.getByRole("form", { name: "Add a Figma link" })).toBeInTheDocument();
  });
});

describe("Designs: export and remove", () => {
  it("exports in the chosen format and says the new version", async () => {
    vi.mocked(exportFigmaLinkAction).mockResolvedValue({
      ok: true, export: { linkId: "l1", assetId: "a1", assetGroupId: "g1", versionNo: 2, name: "Brand / Hero.svg", contentType: "image/svg+xml" },
    });
    view(ok([link()]));
    fireEvent.change(screen.getByLabelText("Export format for Brand / Hero"), { target: { value: "svg" } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Exported as SVG: version 2 of Brand / Hero.svg is in the Asset Library.");
    expect(exportFigmaLinkAction).toHaveBeenCalledWith("l1", "svg");
    expect(refresh).toHaveBeenCalled();
  });

  it("offers PNG, SVG and PDF, PNG first", () => {
    view(ok([link()]));
    const options = within(screen.getByLabelText("Export format for Brand / Hero")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["PNG", "SVG", "PDF"]);
  });

  it("an export refusal is a sentence and no success line", async () => {
    vi.mocked(exportFigmaLinkAction).mockResolvedValue({ ok: false, error: "Figma isn't connected for this company, so this can't be done yet." });
    view(ok([link()], false));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("so this can't be done yet");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("removes a link and refreshes", async () => {
    vi.mocked(removeFigmaLinkAction).mockResolvedValue({ ok: true });
    view(ok([link()]));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(removeFigmaLinkAction).toHaveBeenCalledWith("l1");
  });

  it("a refused removal is a sentence, and the link stays", async () => {
    vi.mocked(removeFigmaLinkAction).mockResolvedValue({ ok: false, error: "You don't have permission to do that. Ask the item's owner or a manager." });
    view(ok([link()]));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
    expect(screen.getByText("Brand / Hero")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
