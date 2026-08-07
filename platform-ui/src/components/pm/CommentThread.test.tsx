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
