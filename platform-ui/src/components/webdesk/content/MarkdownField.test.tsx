import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { PlaceholderSyntax } from "@/lib/markdownCodec";
import { MarkdownField } from "./MarkdownField";

// WSK-45 — the visual markdown editor inside its field. The contract under test is the OBLIGATION of owner ruling WSK-D49:
// a body the user did not change comes out byte-identical. Every body here is synthetic (constructs, not a real site's text).

const PH: PlaceholderSyntax[] = [{ open: "{{", close: "}}" }, { open: "[CONFIRM:", close: "]" }];
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

/** A rich, lossless body in the style the real content uses: CRLF, headings, a table, raw HTML, placeholders, a soft break. */
const BODY = crlf([
  "# Title {{site_name}}",
  "",
  "Alpha **bold** and *italic* with a [link](/x/) and `code`,",
  "continued on a second line. [CONFIRM: check *this* one]",
  "",
  "- one",
  "- two",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | {{tok_a}} |",
  "",
  "<div class=\"note\">",
  "raw",
  "</div>",
].join("\n"));

function Harness({ initial, readOnly = false, onValue, spy }: { initial: string; readOnly?: boolean; onValue?: (v: string) => void; spy?: (set: (v: string) => void, get: () => string) => void }) {
  const [v, setV] = useState(initial);
  spy?.(setV, () => v);
  return (
    <MarkdownField
      value={v}
      onChange={(n) => { setV(n); onValue?.(n); }}
      readOnly={readOnly}
      invalid={false}
      pointer="/blocks/0/props/body"
      label="Body"
      placeholders={PH}
    />
  );
}

const surface = () => document.querySelector(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
async function mounted(): Promise<Editor> {
  await waitFor(() => expect(surface()).not.toBeNull());
  return (surface() as HTMLElement & { editor: Editor }).editor;
}
const textarea = () => screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement;

describe("an unchanged body saves byte-identical", () => {
  it("opens visually, and mounting alone emits nothing", async () => {
    const onValue = vi.fn();
    render(<Harness initial={BODY} onValue={onValue} />);
    await mounted();
    expect(screen.getByTestId("markdown-visual")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Visual" }).getAttribute("aria-selected")).toBe("true");
    expect(onValue).not.toHaveBeenCalled();
  });

  it("typing a character and undoing it hands the ORIGINAL bytes back", async () => {
    const seen: string[] = [];
    render(<Harness initial={BODY} onValue={(v) => seen.push(v)} />);
    const editor = await mounted();
    act(() => { editor.chain().focus().insertContentAt(3, "x").run(); });
    expect(seen.length).toBe(1);
    expect(seen[0]).not.toBe(BODY);
    act(() => { editor.commands.undo(); });
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(BODY); // the very same string, not a re-serialisation that happens to match
  });

  it("deleting what was typed (no undo) is also the original document, so the original string comes back", async () => {
    const seen: string[] = [];
    render(<Harness initial={BODY} onValue={(v) => seen.push(v)} />);
    const editor = await mounted();
    act(() => { editor.chain().focus().insertContentAt(3, "x").run(); });
    expect(editor.state.doc.textBetween(1, 8)).toContain("x");
    act(() => { editor.commands.deleteRange({ from: 3, to: 4 }); });
    expect(editor.state.doc.textBetween(1, 8)).not.toContain("x");
    expect(seen[seen.length - 1]).toBe(BODY);
  });

  it("switching to Source and back with no edit changes nothing and emits nothing", async () => {
    const onValue = vi.fn();
    render(<Harness initial={BODY} onValue={onValue} />);
    await mounted();
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(textarea().value.replace(/\r\n/g, "\n")).toBe(BODY.replace(/\r\n/g, "\n"));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));
    await mounted();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("tab", { name: "Visual" }));
    await mounted();
    expect(onValue).not.toHaveBeenCalled();
  });
});

describe("an edited body is serialised, and keeps its style", () => {
  it("writes the edit, keeps CRLF, and leaves every placeholder verbatim", async () => {
    let last = "";
    render(<Harness initial={BODY} onValue={(v) => { last = v; }} />);
    const editor = await mounted();
    act(() => { editor.chain().focus().insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "A new line with 2 * 3, a_b and <y> and {{typed_tok}}." }] }).run(); });
    expect(last).not.toBe("");
    expect(last.includes("\r\n")).toBe(true);
    expect(last.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const t of ["{{site_name}}", "[CONFIRM: check *this* one]", "{{tok_a}}", "{{typed_tok}}"]) expect(last).toContain(t);
    // the first lines, the table and the raw HTML are exactly as they were
    expect(last.startsWith(BODY.slice(0, BODY.indexOf("| a | b |")))).toBe(true);
    expect(last).toContain(crlf("| a | b |\n|---|---|\n| 1 | {{tok_a}} |"));
    expect(last).toContain(crlf("<div class=\"note\">\nraw\n</div>"));
  });

  it("bold from the toolbar becomes ** in the saved text", async () => {
    let last = "";
    render(<Harness initial="Alpha beta gamma." onValue={(v) => { last = v; }} />);
    const editor = await mounted();
    act(() => { editor.commands.setTextSelection({ from: 7, to: 11 }); });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(last).toBe("Alpha **beta** gamma.");
  });

  it("a heading chosen from the block-style select is saved as ATX", async () => {
    let last = "";
    render(<Harness initial="Alpha beta." onValue={(v) => { last = v; }} />);
    await mounted();
    fireEvent.change(screen.getByRole("combobox", { name: "Block style" }), { target: { value: "h2" } });
    expect(last).toBe("## Alpha beta.");
  });

  it("a link typed into the link bar is saved as a Markdown link", async () => {
    let last = "";
    render(<Harness initial="Alpha beta gamma." onValue={(v) => { last = v; }} />);
    const editor = await mounted();
    act(() => { editor.commands.setTextSelection({ from: 7, to: 11 }); });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = screen.getByLabelText("Link address");
    fireEvent.change(input, { target: { value: "/about/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(last).toBe("Alpha [beta](/about/) gamma.");
  });

  it("refuses a link address with a scheme it does not allow, and says so", async () => {
    let last = "";
    render(<Harness initial="Alpha beta." onValue={(v) => { last = v; }} />);
    const editor = await mounted();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = screen.getByLabelText("Link address");
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toMatch(/http\(s\)/);
    expect(last).toBe("");
  });
});

describe("text the visual editor cannot keep exactly opens as source", () => {
  const LOSSY = "| a | b |\n|---|---|\n| x  | y |"; // a table padded by hand

  it("shows the textarea, a short honest notice, and a disabled Visual tab", () => {
    render(<Harness initial={LOSSY} />);
    expect(textarea().value).toBe(LOSSY);
    const note = screen.getByTestId("markdown-source-notice");
    expect(note.textContent).toMatch(/cannot keep exactly, so it opens as source/);
    expect(note.textContent).toMatch(/table/i);
    const visual = screen.getByRole("tab", { name: "Visual" }) as HTMLButtonElement;
    expect(visual.disabled).toBe(true);
    expect(visual.getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector(".ProseMirror")).toBeNull();
  });

  it("returns to Visual only once the text round-trips, and then emits nothing by itself", async () => {
    const onValue = vi.fn();
    render(<Harness initial={LOSSY} onValue={onValue} />);
    fireEvent.change(textarea(), { target: { value: "| a | b |\n|---|---|\n| x | y |" } });
    expect(screen.queryByTestId("markdown-source-notice")).toBeNull();
    const visual = screen.getByRole("tab", { name: "Visual" }) as HTMLButtonElement;
    expect(visual.disabled).toBe(false);
    onValue.mockClear();
    fireEvent.click(visual);
    await mounted();
    expect(onValue).not.toHaveBeenCalled();
  });

  it("an eligible text can still be edited as source, byte for byte, with CRLF kept", () => {
    const body = crlf("Alpha\n\nBeta");
    const seen: string[] = [];
    render(<Harness initial={body} onValue={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    fireEvent.change(textarea(), { target: { value: "Alpha\n\nBeta!" } }); // a textarea reports LF
    expect(seen[seen.length - 1]).toBe(crlf("Alpha\n\nBeta!"));
  });

  it("a text replaced from outside that cannot be held hands the field to source", async () => {
    let set: (v: string) => void = () => {};
    render(<Harness initial="Alpha." spy={(s) => { set = s; }} />);
    await mounted();
    act(() => { set(LOSSY); });
    await waitFor(() => expect(screen.getByTestId("markdown-source-notice")).toBeTruthy());
    expect(textarea().value).toBe(LOSSY);
  });

  it("a text replaced from outside that CAN be held is adopted as the new baseline", async () => {
    const seen: string[] = [];
    let set: (v: string) => void = () => {};
    render(<Harness initial="Alpha." spy={(s) => { set = s; }} onValue={(v) => seen.push(v)} />);
    const editor = await mounted();
    act(() => { set("# Restored\n\nOther."); });
    await waitFor(() => expect(editor.getText()).toContain("Restored"));
    expect(seen).toEqual([]); // adopting is not an edit
    act(() => { editor.chain().focus().insertContentAt(editor.state.doc.content.size - 1, "!").run(); });
    expect(seen[seen.length - 1]).toBe("# Restored\n\nOther.!");
    act(() => { editor.commands.undo(); });
    expect(seen[seen.length - 1]).toBe("# Restored\n\nOther."); // undo returns the ADOPTED original
  });
});

describe("locks and states", () => {
  it("read-only: the document is not editable, the toolbar is off, and nothing is ever emitted", async () => {
    const onValue = vi.fn();
    render(<Harness initial={BODY} readOnly onValue={onValue} />);
    const editor = await mounted();
    const dom = surface() as HTMLElement;
    expect(editor.isEditable).toBe(false);
    expect(dom.getAttribute("contenteditable")).toBe("false");
    expect(dom.getAttribute("aria-readonly")).toBe("true");
    for (const name of ["Bold", "Italic", "Link", "Bulleted list", "Numbered list", "Quote", "Inline code"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole("combobox", { name: "Block style" }) as HTMLSelectElement).disabled).toBe(true);
    // even a program driving the document cannot make a locked field emit
    act(() => { editor.chain().insertContentAt(1, "x").run(); });
    expect(onValue).not.toHaveBeenCalled();
    // the source view honours the same lock
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(textarea().readOnly).toBe(true);
  });

  it("a field that becomes read-only (a stale or locked page) stops being editable without remounting", async () => {
    const { rerender } = render(<MarkdownField value="Alpha." onChange={() => {}} readOnly={false} invalid={false} pointer="/p" label="Body" placeholders={PH} />);
    const editor = await mounted();
    expect(editor.isEditable).toBe(true);
    rerender(<MarkdownField value="Alpha." onChange={() => {}} readOnly invalid={false} pointer="/p" label="Body" placeholders={PH} />);
    await waitFor(() => expect(editor.isEditable).toBe(false));
  });

  it("the editor is a labelled textbox carrying the field pointer and its describedby / invalid state", async () => {
    render(<MarkdownField value="Alpha." onChange={() => {}} readOnly={false} invalid describedBy="why" pointer="/blocks/0/props/body" label="Body" placeholders={PH} />);
    await mounted();
    const dom = surface() as HTMLElement;
    await waitFor(() => expect(dom.getAttribute("aria-invalid")).toBe("true"));
    expect(dom.getAttribute("role")).toBe("textbox");
    expect(dom.getAttribute("aria-label")).toBe("Body");
    expect(dom.getAttribute("aria-multiline")).toBe("true");
    expect(dom.getAttribute("aria-describedby")?.split(" ")[0]).toBe("why");
    expect(document.getElementById(dom.getAttribute("aria-describedby")?.split(" ")[1] ?? "")?.textContent).toMatch(/Escape/);
    expect(dom.getAttribute("data-pointer")).toBe("/blocks/0/props/body");
  });
});

describe("the toolbar is keyboard operable", () => {
  it("is a labelled toolbar with one tab stop, and the arrow keys, Home and End move along it", async () => {
    render(<Harness initial="Alpha." />);
    await mounted();
    const bar = screen.getByRole("toolbar", { name: "Body formatting" });
    const stops = Array.from(bar.querySelectorAll<HTMLElement>("[data-tb]")).filter((el) => el.tabIndex === 0);
    expect(stops).toHaveLength(1);
    const bold = screen.getByRole("button", { name: "Bold" });
    const italic = screen.getByRole("button", { name: "Italic" });
    bold.focus();
    fireEvent.keyDown(bold, { key: "ArrowRight" });
    expect(document.activeElement).toBe(italic);
    expect(italic.tabIndex).toBe(0);
    fireEvent.keyDown(italic, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(bold);
    fireEvent.keyDown(bold, { key: "End" });
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).not.toBe("Bold");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(bold);
  });

  it("every formatting control is a real button/select with an accessible name and a pressed state where it toggles", async () => {
    render(<Harness initial="Alpha." />);
    await mounted();
    for (const name of ["Bold", "Italic", "Link", "Bulleted list", "Numbered list", "Quote", "Inline code"]) {
      const b = screen.getByRole("button", { name });
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("aria-pressed")).toBe("false");
    }
    expect(screen.getByRole("combobox", { name: "Block style" })).toBeTruthy();
  });

  it("Escape closes the link bar and the toolbar button reflects it", async () => {
    render(<Harness initial="Alpha." />);
    await mounted();
    const link = screen.getByRole("button", { name: "Link" });
    fireEvent.click(link);
    expect(link.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
    expect(screen.queryByLabelText("Link address")).toBeNull();
    expect(link.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("states the editor must be honest about", () => {
  it("Escape leaves the editing surface for the toolbar", async () => {
    render(<Harness initial="Alpha." />);
    await mounted();
    const dom = surface() as HTMLElement;
    dom.focus();
    fireEvent.keyDown(dom, { key: "Escape" });
    expect(document.activeElement?.closest('[role="toolbar"]')).not.toBeNull();
  });

  it("says so when an edit may not save exactly as it looks (a line break inside a heading cannot be written as Markdown)", async () => {
    render(<Harness initial="### Alpha beta" />);
    const editor = await mounted();
    expect(screen.queryByTestId("markdown-unverified")).toBeNull();
    act(() => { editor.chain().focus().insertContentAt(7, { type: "hardBreak" }).run(); });
    await waitFor(() => expect(screen.getByTestId("markdown-unverified").textContent).toMatch(/may not save exactly/));
  });

  it("renders to a string (the server path): the tabs and a readable fallback, never an empty box", () => {
    const html = renderToString(<MarkdownField value={"# Title\n\nAlpha."} onChange={() => {}} readOnly={false} invalid={false} pointer="/p" label="Body" placeholders={PH} />);
    expect(html).toContain("Visual");
    expect(html).toContain("markdown-visual-loading");
    expect(html).toContain("Alpha.");
  });
});
