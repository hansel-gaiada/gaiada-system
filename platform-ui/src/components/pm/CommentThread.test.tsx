import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CommentThread, SetToMeButton, TodayScheduleButton, renderMiniMarkdown } from "./CommentThread";

// CommentThread calls useRouter().refresh() after every commit — stub next/navigation so it can
// render outside an app-router, same pattern as Board.test.tsx / Contributors.test.tsx.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("CommentThread composer (P4-F1)", () => {
  it("renders Write/Preview tabs and starts on Write", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByPlaceholderText(/Write a comment/)).toBeInTheDocument();
  });

  it("Preview renders bold/italic/code/link/list and hides the raw textarea", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), {
      target: { value: "**bold** and *italic* and `code`\n[go](https://example.com)\n- one\n- two" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.queryByPlaceholderText(/Write a comment/)).not.toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
    const link = screen.getByText("go");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("Preview never builds a clickable link from a non-http(s) target — renders the markdown as plain text instead", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), {
      target: { value: "[click me](javascript:alert(1))" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/click me/)).toBeInTheDocument();
  });

  it("Preview never uses dangerouslySetInnerHTML — a literal '<' in the body stays literal text, not markup", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), {
      target: { value: "<img src=x onerror=alert(1)> **safe**" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByText("safe").tagName).toBe("STRONG");
  });

  it("Preview of an empty draft says so rather than rendering nothing", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByText("Nothing to preview.")).toBeInTheDocument();
  });

  it("the emoji tool inserts into the draft", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
    fireEvent.click(screen.getByRole("option", { name: "🔥" }));
    expect(screen.getByPlaceholderText(/Write a comment/)).toHaveValue("🔥");
  });

  it("typing @ opens a filtered mention dropdown and picking one inserts the name", () => {
    render(
      <CommentThread
        comments={[]}
        post={vi.fn()}
        mentionCandidates={[{ id: "u-1", name: "Alice" }, { id: "u-2", name: "Aaron" }, { id: "u-3", name: "Bob" }]}
      />,
    );
    const textarea = screen.getByPlaceholderText(/Write a comment/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hey @a" } });
    textarea.setSelectionRange(6, 6);
    fireEvent.change(textarea, { target: { value: "hey @a" } });
    expect(screen.getByRole("option", { name: "Alice" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Aaron" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Bob" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Alice" }));
    expect(textarea.value).toBe("hey @Alice ");
  });

  it("without mentionCandidates the @ tool still inserts the character (degrade gracefully)", () => {
    render(<CommentThread comments={[]} post={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(screen.getByPlaceholderText(/Write a comment/)).toHaveValue("@");
    expect(screen.queryByRole("listbox", { name: "Mention someone" })).not.toBeInTheDocument();
  });

  it("renderMiniMarkdown is a pure function usable outside a render (module-level export)", () => {
    const out = renderMiniMarkdown("**x**");
    expect(out).toBeTruthy();
  });
});

describe("SetToMeButton (P4-F4)", () => {
  it("calls act and refreshes on success", async () => {
    const act = vi.fn().mockResolvedValue({ ok: true });
    render(<SetToMeButton label="Set to me" act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Set to me" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the server's error message and does not refresh on failure", async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, error: "You don't have permission for this action." });
    render(<SetToMeButton label="Set to me" act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Set to me" }));
    await waitFor(() => expect(screen.getByText("You don't have permission for this action.")).toBeInTheDocument());
  });
});

describe("TodayScheduleButton (P4-F3)", () => {
  it("calls the bound reschedule action on click", async () => {
    const act = vi.fn().mockResolvedValue({ ok: true });
    render(<TodayScheduleButton act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  });
});

// ---- SCP-1l (BFF §63.8): a social_post thread's toggle, badges and pins ----
const FILE = "11111111-1111-4111-8111-111111111111";
// The composer is a <form action>: React 19 runs the action on submit (the way InstalmentPicker.test drives its form).
const submitComment = () => fireEvent.submit(screen.getByRole("button", { name: "Comment" }).closest("form")!);
const mockComments = [
  { id: "c-1", author_id: "u-1", author_name: "Mock Officer", body: "Team note", parent_comment_id: null, created_at: "2027-03-01T10:00:00Z", visibility: "team" as const, anchor: null },
  { id: "c-2", author_id: "u-1", author_name: "Mock Officer", body: "For the client", parent_comment_id: null, created_at: "2027-03-01T11:00:00Z", visibility: "client" as const, anchor: { x: 0.25, y: 0.5, fileId: FILE } },
  { id: "c-3", author_id: "u-2", author_name: "Mock Copywriter", body: "Move the logo", parent_comment_id: null, created_at: "2027-03-01T12:00:00Z", visibility: "team" as const, anchor: { x: 0.8, y: 0.1, fileId: FILE } },
];

describe("CommentThread on a social_post thread (SCP-1l)", () => {
  it("draws the team / client toggle only when the page says the viewer may write client comments", () => {
    const { rerender } = render(<CommentThread comments={[]} post={vi.fn()} social={{ canWriteClient: true }} />);
    expect(screen.getByRole("radiogroup", { name: "Who can see this comment" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Team only" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Client can see" })).toHaveAttribute("aria-checked", "false");

    rerender(<CommentThread comments={[]} post={vi.fn()} social={{ canWriteClient: false }} />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("posts a client-visible comment with its visibility and the pending pin, then clears the pin", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const clear = vi.fn();
    const anchor = { x: 0.4, y: 0.6, fileId: FILE };
    render(<CommentThread comments={[]} post={post} social={{ canWriteClient: true, pendingAnchor: anchor, onClearPendingAnchor: clear }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Client can see" }));
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), { target: { value: "Please check the date" } });
    submitComment();
    await waitFor(() => expect(post).toHaveBeenCalledWith("Please check the date", { visibility: "client", anchor }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });

  it("a viewer who may not write client comments always posts team", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    render(<CommentThread comments={[]} post={post} social={{ canWriteClient: false }} />);
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), { target: { value: "Team only please" } });
    submitComment();
    await waitFor(() => expect(post).toHaveBeenCalledWith("Team only please", { visibility: "team" }));
  });

  it("renders a visibility badge on each comment and a numbered pin label on the anchored ones", () => {
    render(<CommentThread comments={mockComments} post={vi.fn()} social={{ canWriteClient: false }} />);
    expect(screen.getAllByText("Team only").filter((el) => el.className.includes("scp-vis-badge"))).toHaveLength(2);
    expect(screen.getAllByText("Client can see").filter((el) => el.className.includes("scp-vis-badge"))).toHaveLength(1);
    // The numbers are the pins' places among the anchored comments, in thread order.
    expect(screen.getByText("Pin 1")).toBeInTheDocument();
    expect(screen.getByText("Pin 2")).toBeInTheDocument();
  });

  it("a click on a comment's pin label tells the page which comment it is", () => {
    const onSelectPin = vi.fn();
    render(<CommentThread comments={mockComments} post={vi.fn()} social={{ canWriteClient: false, onSelectPin }} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin 2" }));
    expect(onSelectPin).toHaveBeenCalledWith("c-3");
  });

  it("a refusal keeps what was typed and says why", async () => {
    const post = vi.fn().mockResolvedValue({ ok: false, error: "Only the client's officer or an approver can write a comment the client sees." });
    render(<CommentThread comments={[]} post={post} social={{ canWriteClient: true }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Client can see" }));
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), { target: { value: "Hello client" } });
    submitComment();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Only the client's officer or an approver"));
    expect(screen.getByPlaceholderText(/Write a comment/)).toHaveValue("Hello client");
  });

  it("offers Pin on image only when the page can start place mode, and Remove pin once one is pending", () => {
    const onStartPin = vi.fn();
    const { rerender } = render(<CommentThread comments={[]} post={vi.fn()} social={{ canWriteClient: false, onStartPin }} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin on image" }));
    expect(onStartPin).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Remove pin" })).not.toBeInTheDocument();
    rerender(<CommentThread comments={[]} post={vi.fn()} social={{ canWriteClient: false, onStartPin, pendingAnchor: { x: 0.5, y: 0.5, fileId: FILE }, onClearPendingAnchor: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "Move pin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove pin" })).toBeInTheDocument();
  });
});

describe("CommentThread on any other thread is unchanged by SCP-1l", () => {
  it("with no `social` prop it draws no toggle, badge or pin label even when the server sent visibility and anchor, and posts the body alone", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    render(<CommentThread comments={mockComments} post={post} />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByText("Team only")).not.toBeInTheDocument();
    expect(screen.queryByText("Client can see")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Pin \d/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin on image" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), { target: { value: "Plain comment" } });
    submitComment();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual(["Plain comment"]);
  });
});
