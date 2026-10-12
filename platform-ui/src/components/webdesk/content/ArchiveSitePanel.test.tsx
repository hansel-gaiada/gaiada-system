import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { WdResult, ArchiveRequestFiled } from "@/lib/webdeskContentModel";

vi.mock("@/lib/webdeskContentActions", () => ({ requestSiteArchiveAction: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import * as A from "@/lib/webdeskContentActions";
import { ArchiveSitePanel } from "./ArchiveSitePanel";

const requestArchive = vi.mocked(A.requestSiteArchiveAction);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const ok = (d: ArchiveRequestFiled): WdResult<ArchiveRequestFiled> => ({ kind: "ok", data: d });

const setup = (over: Partial<React.ComponentProps<typeof ArchiveSitePanel>> = {}) =>
  render(<ArchiveSitePanel allowed archived={false} siteName="gaiada.com" scope={SCOPE} {...over} />);
const open = () => fireEvent.click(screen.getByTestId("archive-site-open"));
const confirm = async () => { await act(async () => { fireEvent.click(screen.getByTestId("archive-site-confirm-submit")); }); };

beforeEach(() => { requestArchive.mockReset(); });

describe("ArchiveSitePanel: who sees it", () => {
  it("renders NOTHING for a user who cannot promote: no section, no button, no hint", () => {
    const { container } = setup({ allowed: false });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the control for a user who can: a heading, one plain sentence saying it needs approval, and a button", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Archive this site" })).toBeTruthy();
    expect(screen.getByTestId("archive-site-explain").textContent).toBe("Archiving takes the site out of service and cannot be undone. It needs approval from a second person first.");
    expect(screen.getByTestId("archive-site-open").textContent).toBe("Archive site…");
  });

  it("an already-archived site says so and offers no control, to anyone who can see the page", () => {
    setup({ archived: true, allowed: false });
    expect(screen.getByTestId("archive-site-archived").textContent).toContain("This site is archived.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("archive-site-open")).toBeNull();
  });
});

describe("ArchiveSitePanel: the confirm step", () => {
  it("clicking the button sends NOTHING; it opens a confirm that names the site, lists what archiving does, and says it needs approval", () => {
    setup();
    open();
    expect(requestArchive).not.toHaveBeenCalled();
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.textContent).toContain("Request to archive this site?");
    expect(screen.getByTestId("archive-site-name").textContent).toBe("gaiada.com");
    expect(screen.getByTestId("archive-site-consequences").textContent).toMatch(/stops serving content/);
    expect(screen.getByTestId("archive-site-consequences").textContent).toMatch(/cannot be un|no way to un-archive/);
    expect(dlg.textContent).toContain("Nothing is archived until someone else approves it.");
  });

  it("Cancel closes the confirm and sends nothing", () => {
    setup();
    open();
    fireEvent.click(screen.getByTestId("archive-site-cancel"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("archive-site-open")).toBeTruthy();
    expect(requestArchive).not.toHaveBeenCalled();
  });
});

describe("ArchiveSitePanel: filing", () => {
  it("confirming files the request for THIS site, then says 'Archive requested — waiting for approval.' with a link to it (never 'archived')", async () => {
    requestArchive.mockResolvedValue(ok({ approvalId: "ap-0001", alreadyPending: false }));
    setup();
    open();
    await confirm();
    expect(requestArchive).toHaveBeenCalledTimes(1);
    expect(requestArchive).toHaveBeenCalledWith(SCOPE);
    const msg = screen.getByTestId("archive-site-message");
    expect(msg.textContent).toContain("Archive requested — waiting for approval.");
    expect(msg.textContent).not.toMatch(/site (was|has been) archived/i);
    expect(msg.getAttribute("role")).toBe("status");
    expect(screen.getByRole("link", { name: "View the request" }).getAttribute("href")).toBe("/approvals/ap-0001");
    expect(screen.queryByRole("alertdialog")).toBeNull(); // the confirm is closed
  });

  it("already pending: its own sentence, with the same link", async () => {
    requestArchive.mockResolvedValue(ok({ approvalId: "ap-0007", alreadyPending: true }));
    setup();
    open();
    await confirm();
    expect(screen.getByTestId("archive-site-message").textContent).toContain("Already requested — waiting for approval.");
    expect(screen.getByRole("link", { name: "View the request" }).getAttribute("href")).toBe("/approvals/ap-0007");
  });

  it.each<[string, WdResult<ArchiveRequestFiled>, string]>([
    ["forbidden", { kind: "forbidden", reason: "x" }, "You can't request archiving this site."],
    ["site-archived (409)", { kind: "conflict", slug: "site-archived", message: "raw", currentHeadVersion: null, currentContentHash: null, updatedAt: null }, "This site is already archived."],
    ["unavailable (503)", { kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" }, "Archiving is unavailable. WebDesk can't be reached. Nothing has been changed."],
  ])("%s is a plain sentence in an alert, with NO link and no raw slug", async (_n, result, text) => {
    requestArchive.mockResolvedValue(result);
    setup();
    open();
    await confirm();
    const msg = screen.getByTestId("archive-site-message");
    expect(msg.textContent).toBe(text);
    expect(msg.getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a second click while the request is in flight does not file twice", async () => {
    let release: (r: WdResult<ArchiveRequestFiled>) => void = () => {};
    requestArchive.mockReturnValue(new Promise((res) => { release = res; }));
    setup();
    open();
    await act(async () => { fireEvent.click(screen.getByTestId("archive-site-confirm-submit")); fireEvent.click(screen.getByTestId("archive-site-confirm-submit")); });
    expect(requestArchive).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("archive-site-confirm-submit") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(ok({ approvalId: "a", alreadyPending: false })); });
  });
});
