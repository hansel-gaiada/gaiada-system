import { describe, it, expect } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import navigation from "../../../../e2e/webdesk-stub/compositions/navigation.json";
import tokenRegistry from "../../../../e2e/webdesk-stub/compositions/token-registry.json";
import type { CollectionComposition, FieldDef, Issue } from "@/lib/webdeskContentModel";
import { FieldEditor, type FormCtx } from "./FieldEditor";

const defs = (c: unknown) => (c as CollectionComposition).fields as FieldDef[];

const NAV_VALUE = {
  primary: [
    { url: "/services/", label: "Services", children: ["/a/", "/b/"] },
    { url: "/work/", label: "Work", children: [] },
    { url: "/about/", label: "About", children: [] },
  ],
  cta: { label: "Audit", url: "/free-audit/" },
};

function Harness({ composition, initial, ctx, onValue }: { composition: unknown; initial: Record<string, unknown>; ctx?: Partial<FormCtx>; onValue?: (v: Record<string, unknown>) => void }) {
  const [v, setV] = useState(initial);
  return (
    <FieldEditor
      defs={defs(composition)}
      value={v}
      onChange={(n) => { setV(n); onValue?.(n); }}
      ctx={{ issues: [], readOnly: false, neutralLock: false, neutralLocale: "en", ...ctx }}
    />
  );
}

const ptr = (p: string) => document.querySelector(`[data-pointer="/blocks/0/props/${p}"]`) as HTMLInputElement;
const titles = () => [...document.querySelectorAll('fieldset[data-pointer="/blocks/0/props/primary"] > ol > li > .wc-list__bar .wc-list__title')].map((e) => e.textContent);
const handle = (name: RegExp) => screen.getAllByRole("button", { name }).find((b) => name.test(b.getAttribute("aria-label") ?? ""))!;

describe("FieldEditor renders the real compositions", () => {
  it("renders the shared page shape: text, select, boolean, markdown, nested group, text list", () => {
    render(<Harness composition={service} initial={{ url: "/services/seo/", template: "service", publish_ready: true, plan: { action: "SHOW", why: "w" }, schema: ["Service", "FAQPage"], body: "# Hi" }} />);
    expect(ptr("url").value).toBe("/services/seo/");
    expect((ptr("template") as unknown as HTMLSelectElement).value).toBe("service");
    expect(ptr("publish_ready").checked).toBe(true);
    expect(ptr("plan/why").value).toBe("w");
    expect(ptr("schema/1").value).toBe("FAQPage");
    // markdown opens in the visual editor when it round-trips (WSK-45): a labelled textbox, not a textarea
    expect(ptr("body").textContent).toBe("Hi");
    expect(ptr("body").getAttribute("role")).toBe("textbox");
    expect(ptr("schema_notes").className).toContain("wc-code"); // ui.widget = code
  });

  it("ui.readOnly members are read-only; their siblings are not", () => {
    render(<Harness composition={service} initial={{ url: "/x/", source_path: "content/en/x.md" }} />);
    expect(ptr("source_path").readOnly).toBe(true);
    expect(ptr("url").readOnly).toBe(false);
  });

  it("emits edits upward as plain JSON, dropping a cleared number/select and keeping '' for text", () => {
    let last: Record<string, unknown> = {};
    render(<Harness composition={service} initial={{ phase: "L", h1: "A" }} onValue={(v) => { last = v; }} />);
    fireEvent.change(ptr("h1"), { target: { value: "" } });
    expect(last.h1).toBe("");
    fireEvent.change(ptr("phase"), { target: { value: "" } });
    expect("phase" in last).toBe(false);
  });

  it("keeps a stored select value the composition does not list visible, flagged", () => {
    render(<Harness composition={service} initial={{ template: "legacy" }} />);
    const sel = ptr("template") as unknown as HTMLSelectElement;
    expect(sel.value).toBe("legacy");
    expect(within(sel).getByText(/legacy \(not an allowed value\)/)).toBeTruthy();
  });

  it("markdown has a write tab and a preview that never injects HTML", () => {
    render(<Harness composition={service} initial={{ body: "# T\n\n<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1))" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByTestId("markdown-preview");
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector("a[href^='javascript']")).toBeNull();
    expect(preview.textContent).toContain("<img src=x");
  });
});

describe("list field: add · remove · reorder by keyboard AND drag", () => {
  it("reorders with Space (grab), arrows, Space (drop), and announces the move", () => {
    let last: Record<string, unknown> = {};
    render(<Harness composition={navigation} initial={NAV_VALUE} onValue={(v) => { last = v; }} />);
    expect(titles()).toEqual(["/services/", "/work/", "/about/"]);
    const h = handle(/^Reorder \/services\/, position/);
    h.focus();
    fireEvent.keyDown(h, { key: " " });
    expect(h.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(h, { key: "ArrowDown" });
    fireEvent.keyDown(handle(/^Reorder \/services\/, position/), { key: "ArrowDown" });
    fireEvent.keyDown(handle(/^Reorder \/services\/, position/), { key: " " });
    expect(titles()).toEqual(["/work/", "/about/", "/services/"]);
    expect((last.primary as { url: string }[]).map((r) => r.url)).toEqual(["/work/", "/about/", "/services/"]);
    expect(screen.getAllByRole("status").some((s) => /dropped at position 3 of 3/.test(s.textContent ?? ""))).toBe(true);
    expect(handle(/^Reorder \/services\/, position/).getAttribute("aria-pressed")).toBe("false");
  });

  it("Escape cancels a grab and restores the starting order", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} />);
    const h = handle(/^Reorder \/work\/, position/);
    fireEvent.keyDown(h, { key: " " });
    fireEvent.keyDown(handle(/^Reorder \/work\/, position/), { key: "ArrowUp" });
    expect(titles()).toEqual(["/work/", "/services/", "/about/"]);
    fireEvent.keyDown(handle(/^Reorder \/work\/, position/), { key: "Escape" });
    expect(titles()).toEqual(["/services/", "/work/", "/about/"]);
  });

  it("Alt+Arrow moves without grabbing; a bare arrow does nothing", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} />);
    fireEvent.keyDown(handle(/^Reorder \/about\/, position/), { key: "ArrowUp" });
    expect(titles()).toEqual(["/services/", "/work/", "/about/"]);
    fireEvent.keyDown(handle(/^Reorder \/about\/, position/), { key: "ArrowUp", altKey: true });
    expect(titles()).toEqual(["/services/", "/about/", "/work/"]);
  });

  it("reorders by drag and drop", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} />);
    const dt = { setData() {}, setDragImage() {}, effectAllowed: "", dropEffect: "" };
    const rows = document.querySelectorAll('fieldset[data-pointer="/blocks/0/props/primary"] > ol > li');
    fireEvent.dragStart(handle(/^Reorder \/about\/, position/), { dataTransfer: dt });
    fireEvent.dragOver(rows[0], { dataTransfer: dt });
    fireEvent.drop(rows[0], { dataTransfer: dt });
    expect(titles()).toEqual(["/about/", "/services/", "/work/"]);
  });

  it("adds a row (defaults for a group) and removes one", () => {
    let last: Record<string, unknown> = {};
    render(<Harness composition={navigation} initial={NAV_VALUE} onValue={(v) => { last = v; }} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add item" })[0]);
    expect((last.primary as unknown[]).length).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Remove /work/" }));
    expect((last.primary as { url: string }[]).map((r) => r.url)).toEqual(["/services/", "/about/", ""]);
    expect(titles().length).toBe(3);
  });

  it("keeps input identity per row across a reorder (rows are keyed, not indexed)", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} />);
    const input = ptr("primary/0/label");
    fireEvent.keyDown(handle(/^Reorder \/services\/, position/), { key: "ArrowDown", altKey: true });
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("Services");
  });
});

describe("locks", () => {
  it("non-default locale: neutral members read-only (even nested), localized ones editable, structure locked, order free", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} ctx={{ neutralLock: true, neutralLocale: "en" }} />);
    expect(ptr("primary/0/url").readOnly).toBe(true);
    expect(ptr("primary/0/children/0").readOnly).toBe(true);
    expect(ptr("cta/url").readOnly).toBe(true);
    expect(ptr("primary/0/label").readOnly).toBe(false);
    expect(ptr("cta/label").readOnly).toBe(false);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add item" })).toBeNull();
    expect(screen.getAllByText(/Shared across locales — edit it in en/).length).toBeGreaterThan(0);
    expect(handle(/^Reorder \/services\/, position/)).toBeTruthy(); // order is per locale (§2.5 rule 3)
  });

  it("default locale: the same members are editable", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} />);
    expect(ptr("primary/0/url").readOnly).toBe(false);
    expect(ptr("primary/0/children/0").readOnly).toBe(false);
  });

  it("whole-form read-only: no inputs editable, no handles, no add/remove", () => {
    render(<Harness composition={navigation} initial={NAV_VALUE} ctx={{ readOnly: true }} />);
    expect([...document.querySelectorAll<HTMLInputElement>("input")].every((i) => i.readOnly || i.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove|Add/ })).toBeNull();
  });

  it("ui.readOnly inside a list row stays locked while its siblings edit", () => {
    render(<Harness composition={tokenRegistry} initial={{ tokens: [{ token: "{{X}}", value: "", occurrences: 3, pages: ["/"], page_count: 1, source: "factsheet" }] }} />);
    expect(ptr("tokens/0/occurrences").readOnly).toBe(true);
    expect(ptr("tokens/0/pages/0").readOnly).toBe(true);
    expect(ptr("tokens/0/value").readOnly).toBe(false);
    expect(ptr("tokens/0/source").disabled).toBe(false);
  });
});

describe("inline errors by JSON pointer (§2.2 ItemIssue.path)", () => {
  const issues: Issue[] = [
    { path: "/blocks/0/props/phase", message: "phase is required" },
    { path: "/blocks/0/props/plan/why", message: "too short" },
    { path: "/blocks/0/props/schema/1", message: "bad schema type" },
  ];
  it("places each message beside its own control, marks it invalid and counts nested problems on the group", () => {
    render(<Harness composition={service} initial={{ schema: ["a", "b"], plan: {} }} ctx={{ issues }} />);
    expect(ptr("phase").getAttribute("aria-invalid")).toBe("true");
    expect(ptr("phase").closest(".wc-field")?.textContent).toContain("phase is required");
    expect(ptr("plan/why").closest(".wc-field")?.textContent).toContain("too short");
    expect(ptr("schema/1").closest(".wc-field")?.textContent).toContain("bad schema type");
    expect(document.querySelector('fieldset[data-pointer="/blocks/0/props/plan"] legend')?.textContent).toContain("1 problem");
    // an untouched sibling carries no error
    expect(ptr("h1").getAttribute("aria-invalid")).toBeNull();
  });

  it("passes the collection's placeholder syntaxes to the visual markdown editor, and a locked form locks it", async () => {
    let last: Record<string, unknown> = {};
    const { unmount } = render(<Harness composition={service} initial={{ body: "Alpha {{tok_a}} beta." }} ctx={{ placeholders: [{ open: "{{", close: "}}" }] }} onValue={(v) => { last = v; }} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    const editor = (document.querySelector(".ProseMirror") as HTMLElement & { editor: { chain: () => { focus: () => { insertContentAt: (p: number, c: unknown) => { run: () => void } } } } }).editor;
    // typed text Markdown would act on (x*y* is emphasis): that block is written with escapes, the placeholder stays verbatim
    act(() => { editor.chain().focus().insertContentAt(1, "x*y* ").run(); });
    expect(last.body).toBe("x\\*y\\* Alpha {{tok_a}} beta.");
    unmount();
    render(<Harness composition={service} initial={{ body: "Alpha." }} ctx={{ readOnly: true }} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect((document.querySelector(".ProseMirror") as HTMLElement).getAttribute("contenteditable")).toBe("false");
  });
});
