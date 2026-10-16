import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";

// DW-10a-2 (BFF §57.8): the notice list, the form and the Edit / Withdraw controls.
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/noticeActions", () => ({ postNoticeAction: vi.fn(), editNoticeAction: vi.fn(), withdrawNoticeAction: vi.fn() }));

import { editNoticeAction, postNoticeAction, withdrawNoticeAction } from "@/lib/noticeActions";
import { NoticeBoard } from "./NoticeBoard";
import { PostNotice } from "./NoticeForm";
import type { NoticeList, NoticeRow } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";

/** The repo has no user-event dependency: a click is a click and typing sets the value, which the form reads from its DOM (uncontrolled fields). */
const userEvent = {
  setup: () => ({
    click: async (el: HTMLElement) => { fireEvent.click(el); },
    clear: async (el: HTMLElement) => { fireEvent.change(el, { target: { value: "" } }); },
    type: async (el: HTMLElement, text: string) => { fireEvent.change(el, { target: { value: (el as HTMLInputElement).value + text.replace(/\{enter\}/g, "\n") } }); },
  }),
};

const NOW = Date.parse("2026-10-16T12:00:00Z");
const row = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id, scope: "unit", unitNodeId: "dept-1", unitName: "Web Dev", title: `Title ${id}`, body: `Body ${id}`, pinned: false, endsOn: null, state: "current",
  author: { id: "u1", name: "Ketut Arta" }, createdAt: "2026-10-16T09:00:00.000Z", editedAt: null, canEdit: false, ...over,
});
const ok = (items: NoticeRow[], nextCursor: string | null = null): ReadResult<NoticeList> => ({ kind: "ok", data: { items, nextCursor } });
const board = (result: ReadResult<NoticeList>, extra: Partial<Parameters<typeof NoticeBoard>[0]> = {}) =>
  render(<NoticeBoard result={result} tenantId="co-a" here="dept-1" state="current" now={NOW} {...extra} />);

beforeEach(() => {
  refresh.mockReset();
  vi.mocked(postNoticeAction).mockReset();
  vi.mocked(editNoticeAction).mockReset();
  vi.mocked(withdrawNoticeAction).mockReset();
});

describe("NoticeBoard: what it says", () => {
  it("draws a notice with its title, unit, author, age and end date, and the body as text", () => {
    board(ok([row("a", { endsOn: "2026-10-30", body: "Line one\nLine two" })]));
    const li = screen.getByRole("listitem");
    expect(li).toHaveAttribute("id", "a");
    expect(within(li).getByRole("heading", { name: "Title a" })).toBeInTheDocument();
    expect(li).toHaveTextContent("Web Dev · by Ketut Arta · 3 h ago · until 30 Oct 2026");
    expect(li.querySelector(".nt-body")?.textContent).toBe("Line one\nLine two");
  });

  it("marks a pinned notice 'Pinned' and no other", () => {
    board(ok([row("a", { pinned: true }), row("b")]));
    const [a, b] = screen.getAllByRole("listitem");
    expect(within(a).getByText("Pinned")).toBeInTheDocument();
    expect(within(b).queryByText("Pinned")).not.toBeInTheDocument();
  });

  it("says 'From <unit>' for a notice posted to a unit above, 'Whole company' for a company-wide one and 'a former unit' for a unit that left the tree", () => {
    board(ok([
      row("up", { unitNodeId: "div", unitName: "Engineering" }),
      row("co", { scope: "company", unitNodeId: null, unitName: null }),
      row("gone", { unitNodeId: "x", unitName: null }),
    ]));
    const [up, co, gone] = screen.getAllByRole("listitem");
    expect(up).toHaveTextContent("From Engineering");
    expect(co).toHaveTextContent("Whole company");
    expect(gone).toHaveTextContent("From a former unit");
  });

  it("never renders the body as HTML or Markdown", () => {
    const { container } = board(ok([row("a", { body: "<img src=x onerror=alert(1)> **bold** [link](http://x)" })]));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong, a[href='http://x']")).toBeNull();
    expect(container.querySelector(".nt-body")?.textContent).toBe("<img src=x onerror=alert(1)> **bold** [link](http://x)");
  });

  it("says 'ended' for a past notice's date and shows no Pinned marker on it", () => {
    board(ok([row("old", { state: "past", pinned: true, endsOn: "2026-10-01" })]), { state: "past" });
    const li = screen.getByRole("listitem");
    expect(li).toHaveTextContent("ended 1 Oct 2026");
    expect(within(li).queryByText("Pinned")).not.toBeInTheDocument();
  });

  it("links the next page when there is one", () => {
    board(ok([row("a")], "c2"), { nextHref: "/departments/dept-1/notices?cursor=c2" });
    expect(screen.getByRole("link", { name: "Next notices" })).toHaveAttribute("href", "/departments/dept-1/notices?cursor=c2");
  });
});

describe("NoticeBoard: honest states", () => {
  it("says 'No current notices' only after a read that succeeded (and 'No past notices' for the past view)", () => {
    board(ok([]));
    expect(screen.getByText("No current notices.")).toBeInTheDocument();
  });
  it("says 'No past notices' in the past view", () => {
    board(ok([]), { state: "past" });
    expect(screen.getByText("No past notices.")).toBeInTheDocument();
  });
  it("says a failed read could not be read, and never 'No current notices'", () => {
    board({ kind: "unavailable", reason: "platform 500" });
    expect(screen.getByText(/can't tell|couldn't|unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No current notices/)).not.toBeInTheDocument();
  });
  it("says a refused read is a refusal, and never 'No current notices'", () => {
    board({ kind: "forbidden" });
    expect(screen.getByText(/You don't have access to this unit's notices/)).toBeInTheDocument();
    expect(screen.queryByText(/No current notices/)).not.toBeInTheDocument();
  });
});

describe("NoticeBoard: Edit and Withdraw", () => {
  it("offers them only on a notice the server says the caller may change (canEdit)", () => {
    board(ok([row("mine", { canEdit: true }), row("theirs", { canEdit: false })]));
    const [mine, theirs] = screen.getAllByRole("listitem");
    expect(within(mine).getByRole("button", { name: "Edit Title mine" })).toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: "Withdraw Title mine" })).toBeInTheDocument();
    expect(within(theirs).queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks before withdrawing, and 'Keep it' withdraws nothing", async () => {
    const user = userEvent.setup();
    board(ok([row("a", { canEdit: true })]));
    await user.click(screen.getByRole("button", { name: "Withdraw Title a" }));
    expect(screen.getByText(/Withdraw this notice\?/)).toBeInTheDocument();
    expect(withdrawNoticeAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(withdrawNoticeAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Withdraw Title a" })).toBeInTheDocument();
  });

  it("withdraws after the confirmation and refreshes the page", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawNoticeAction).mockResolvedValue({ ok: true, id: "a" });
    board(ok([row("a", { canEdit: true })]));
    await user.click(screen.getByRole("button", { name: "Withdraw Title a" }));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw it" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(withdrawNoticeAction).toHaveBeenCalledWith("co-a", "a", "unit");
  });

  it("shows the server's refusal when a withdrawal fails, and does not refresh", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawNoticeAction).mockResolvedValue({ ok: false, error: "This notice no longer exists, or it was withdrawn." });
    board(ok([row("a", { canEdit: true })]));
    await user.click(screen.getByRole("button", { name: "Withdraw Title a" }));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer exists");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("opens the edit form from the notice, saves the changes and refreshes", async () => {
    const user = userEvent.setup();
    vi.mocked(editNoticeAction).mockResolvedValue({ ok: true, id: "a" });
    board(ok([row("a", { canEdit: true, pinned: true, endsOn: "2026-10-30" })]));
    await user.click(screen.getByRole("button", { name: "Edit Title a" }));
    const form = screen.getByRole("form", { name: "Edit this notice" });
    expect(within(form).getByLabelText(/^Title/)).toHaveValue("Title a");
    expect(within(form).getByLabelText(/^Notice/)).toHaveValue("Body a");
    expect(within(form).getByLabelText(/^Show until/)).toHaveValue("2026-10-30");
    expect(within(form).getByLabelText(/Pin to the top/)).toBeChecked();
    await user.clear(within(form).getByLabelText(/^Title/));
    await user.type(within(form).getByLabelText(/^Title/), "New title");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(editNoticeAction).toHaveBeenCalledWith("co-a", "a", { title: "New title", body: "Body a", pinned: true, endsOn: "2026-10-30" }, "unit");
  });

  it("shows a 409 pin_limit from an edit under the form and keeps the form open", async () => {
    const user = userEvent.setup();
    vi.mocked(editNoticeAction).mockResolvedValue({ ok: false, field: "pinned", error: "This unit already has 3 pinned notices. Unpin one, or let one end, to pin another." });
    board(ok([row("a", { canEdit: true })]));
    await user.click(screen.getByRole("button", { name: "Edit Title a" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has 3 pinned notices");
    expect(screen.getByRole("form", { name: "Edit this notice" })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("PostNotice (the form)", () => {
  it("is a button first, and opens the form for a unit's notice", async () => {
    const user = userEvent.setup();
    render(<PostNotice tenantId="co-a" target={{ scope: "unit", unitNodeId: "dept-1" }} />);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Post a notice" }));
    const form = screen.getByRole("form", { name: "Post a notice" });
    expect(within(form).getByLabelText(/^Title/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Notice/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Show until/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/Pin to the top/)).not.toBeChecked();
    // No scope control: the page decides the scope.
    expect(within(form).queryByLabelText(/scope|unit/i)).not.toBeInTheDocument();
  });

  it("posts to the unit with the typed fields, then closes and refreshes", async () => {
    const user = userEvent.setup();
    vi.mocked(postNoticeAction).mockResolvedValue({ ok: true, id: "n9" });
    render(<PostNotice tenantId="co-a" target={{ scope: "unit", unitNodeId: "dept-1" }} />);
    await user.click(screen.getByRole("button", { name: "Post a notice" }));
    await user.type(screen.getByLabelText(/^Title/), "Release freeze");
    await user.type(screen.getByLabelText(/^Notice/), "Line one{enter}Line two");
    await user.click(screen.getByLabelText(/Pin to the top/));
    await user.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(postNoticeAction).toHaveBeenCalledWith("co-a", { scope: "unit", unitNodeId: "dept-1" }, { title: "Release freeze", body: "Line one\nLine two", pinned: true, endsOn: "" });
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("labels the company-wide form and posts with the company scope", async () => {
    const user = userEvent.setup();
    vi.mocked(postNoticeAction).mockResolvedValue({ ok: true, id: "n9" });
    render(<PostNotice tenantId="co-a" target={{ scope: "company" }} />);
    await user.click(screen.getByRole("button", { name: "Post a notice" }));
    expect(screen.getByRole("form", { name: "Post a company-wide notice" })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Title/), "Hello");
    await user.type(screen.getByLabelText(/^Notice/), "Everyone");
    await user.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(postNoticeAction).toHaveBeenCalled());
    expect(vi.mocked(postNoticeAction).mock.calls[0][1]).toEqual({ scope: "company" });
  });

  it("shows a field error under its field and keeps what was typed", async () => {
    const user = userEvent.setup();
    // The server refuses the title (the browser's own `required` check would stop an empty one before it was sent).
    vi.mocked(postNoticeAction).mockResolvedValue({ ok: false, field: "title", error: "title must be 1 to 120 characters" });
    render(<PostNotice tenantId="co-a" target={{ scope: "unit", unitNodeId: "dept-1" }} />);
    await user.click(screen.getByRole("button", { name: "Post a notice" }));
    await user.type(screen.getByLabelText(/^Title/), "A title");
    await user.type(screen.getByLabelText(/^Notice/), "Some text");
    await user.click(screen.getByRole("button", { name: "Post notice" }));
    expect(await screen.findByText("title must be 1 to 120 characters")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^Notice/)).toHaveValue("Some text");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a 403 or a 409 that names no inline field beside the buttons", async () => {
    const user = userEvent.setup();
    vi.mocked(postNoticeAction).mockResolvedValue({ ok: false, field: "pinned", error: "This unit already has 3 pinned notices. Unpin one, or let one end, to pin another." });
    render(<PostNotice tenantId="co-a" target={{ scope: "unit", unitNodeId: "dept-1" }} />);
    await user.click(screen.getByRole("button", { name: "Post a notice" }));
    await user.type(screen.getByLabelText(/^Title/), "T");
    await user.type(screen.getByLabelText(/^Notice/), "B");
    await user.click(screen.getByRole("button", { name: "Post notice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has 3 pinned notices");
  });

  it("Cancel closes the form without posting", async () => {
    const user = userEvent.setup();
    render(<PostNotice tenantId="co-a" target={{ scope: "company" }} />);
    await user.click(screen.getByRole("button", { name: "Post a notice" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(postNoticeAction).not.toHaveBeenCalled();
  });
});
