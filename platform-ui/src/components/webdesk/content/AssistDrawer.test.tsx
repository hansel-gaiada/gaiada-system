import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import type { FieldDef } from "@/lib/webdeskContentModel";
import { assistFailureCopy, type ApplyCtx, type AssistBody, type AssistFailure, type AssistResult, type AssistSuggestion, type DraftState } from "@/lib/webdeskAssistModel";

vi.mock("@/lib/webdeskAssistActions", () => ({ assistAction: vi.fn() }));

import * as A from "@/lib/webdeskAssistActions";
import { AssistDrawer } from "./AssistDrawer";

// M5-W6: the editor's writing assistant. The wiring into the editor (the draft changes, nothing is saved) is in ItemEditor.assist.test.tsx;
// here: when the drawer is offered, each kind, Apply/Copy, every typed failure in words, the cancellable loading state, the translate label.

const assist = vi.mocked(A.assistAction);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const DEFS = (service as unknown as { fields: FieldDef[] }).fields;
const DRAFT: DraftState = { fields: { h1: "SEO Agency", body: "# SEO Agency\n" }, seo: { title: "T" } };
const ctx = (over: Partial<ApplyCtx> = {}): ApplyCtx => ({ defs: DEFS, draft: DRAFT, locale: "en", defaultLocale: "en", seoCarrier: false, localeNeutralCollection: false, ...over });

const body = (kind: AssistBody["kind"], suggestions: AssistSuggestion[], over: Partial<AssistBody> = {}): AssistBody => ({
  kind, itemId: "i1", version: 3, headVersion: 3, locale: "en", suggestions, notice: null, provider: "p", usage: { callsUsed: 2, callsLimit: 40, tokensEstimatedUsed: 500, tokensLimit: 1000 }, ...over,
});
const ok = (b: AssistBody): AssistResult => ({ ok: true, data: b });
const fail = (failure: AssistFailure): AssistResult => ({ ok: false, failure });

const META: AssistSuggestion = { id: "s1", kind: "meta_description", target: "/seo/description", text: "We help hotels in Bali rank for local searches and win more direct bookings.", length: 76 };
const TRANSLATE: AssistSuggestion = { id: "s1", kind: "translate_draft", sourcePath: "/blocks/0/props/h1", field: "h1", locale: "id", text: "Agen SEO", notice: "First draft — needs a human" };

function setup(over: Partial<React.ComponentProps<typeof AssistDrawer>> = {}) {
  const onApply = vi.fn();
  const utils = render(
    <AssistDrawer scope={SCOPE} itemId="i1" allowed={{ read: true, update: true }} baseVersion={3} dirty={false} ctx={ctx()} applyBlocked={null} onApply={onApply} {...over} />,
  );
  return { onApply, ...utils };
}
const open = async () => { await act(async () => { fireEvent.click(screen.getByTestId("assist-toggle")); }); };
const run = async (kind: string) => { await act(async () => { fireEvent.click(screen.getByTestId(`assist-run-${kind}`)); }); };
const click = async (id: string) => { await act(async () => { fireEvent.click(screen.getByTestId(id)); }); };

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  assist.mockReset();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
});
afterEach(() => { cleanup(); fetchSpy.mockRestore(); });

describe("AssistDrawer: when it is offered (item read's `allowed.update`)", () => {
  it("renders nothing when `allowed` is absent (could not be checked is not 'allowed')", () => {
    setup({ allowed: undefined });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("renders nothing for a read-only caller", () => {
    setup({ allowed: { read: true, update: false, comment: true } });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("renders nothing when `update` is missing from `allowed`", () => {
    setup({ allowed: { read: true } });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("is offered when `allowed.update` is true, closed until opened, then lists the five actions", async () => {
    setup();
    expect(screen.getByTestId("assist-drawer")).toBeTruthy();
    expect(screen.queryByTestId("assist-panel")).toBeNull();
    expect(screen.getByTestId("assist-toggle").getAttribute("aria-expanded")).toBe("false");
    await open();
    expect(screen.getByTestId("assist-toggle").getAttribute("aria-expanded")).toBe("true");
    for (const k of ["outline", "meta_description", "faq", "translate_draft", "alt_text"]) expect(screen.getByTestId(`assist-run-${k}`)).toBeTruthy();
    expect(screen.getByTestId("assist-panel").textContent).toMatch(/Suggestions only\. Nothing is applied or saved until you choose Apply, and then Save\./);
    expect(assist).not.toHaveBeenCalled(); // opening asks for nothing
  });
});

describe("AssistDrawer: meta description, Apply and Copy", () => {
  it("asks for the kind on the item, shows the suggestion, and Apply hands the editor a NEW draft (SEO description set, nothing else changed)", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    const { onApply } = setup();
    await open();
    await run("meta_description");
    expect(assist).toHaveBeenCalledTimes(1);
    expect(assist).toHaveBeenCalledWith(SCOPE, "i1", "meta_description");
    expect(screen.getByTestId("suggestion-text").textContent).toBe(META.text);
    expect(onApply).not.toHaveBeenCalled(); // never auto-applied

    await click("apply-s1");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ fields: DRAFT.fields, seo: { title: "T", description: META.text } });
    expect(DRAFT.seo).toEqual({ title: "T" }); // the draft it was given is not mutated
    expect(screen.getByTestId("applied-s1").textContent).toMatch(/Not saved yet/);
    expect((screen.getByTestId("apply-s1") as HTMLButtonElement).disabled).toBe(true);
    expect(assist).toHaveBeenCalledTimes(1); // Apply asks the BFF for nothing: it does not save, publish or call anything
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Copy puts the text on the clipboard, and says so; a clipboard refusal is said too", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    setup();
    await open(); await run("meta_description");
    await click("copy-s1");
    expect(writeText).toHaveBeenCalledWith(META.text);
    expect(screen.getByTestId("copied-s1").textContent).toBe("Copied.");

    writeText.mockRejectedValue(new Error("denied"));
    await click("copy-s1");
    expect(screen.getByTestId("copy-failed-s1").textContent).toMatch(/Couldn.t copy/);
  });

  it("Apply is off, with the editor's reason beside it, while the form is read-only or stale", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    const { onApply } = setup({ applyBlocked: "Disabled until WebDesk answers again." });
    await open(); await run("meta_description");
    expect((screen.getByTestId("apply-s1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("apply-blocked-s1").textContent).toBe("Disabled until WebDesk answers again.");
    await click("apply-s1");
    expect(onApply).not.toHaveBeenCalled();
    expect((screen.getByTestId("copy-s1") as HTMLButtonElement).disabled).toBe(false); // Copy still works
  });

  it("a collection with no description control offers Copy only, and says why", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    setup({ ctx: ctx({ seoCarrier: true }) });
    await open(); await run("meta_description");
    expect(screen.queryByTestId("apply-s1")).toBeNull();
    expect(screen.getByTestId("apply-why-s1").textContent).toMatch(/no search description field/);
    expect(screen.getByTestId("copy-s1")).toBeTruthy();
  });
});

describe("AssistDrawer: outline, FAQ and alt text", () => {
  it("an outline adds to the end of a text field", async () => {
    assist.mockResolvedValue(ok(body("outline", [{ id: "s1", kind: "outline", headings: [{ level: 2, text: "Intro" }, { level: 3, text: "Why" }], markdown: "## Intro\n\n### Why" }])));
    const { onApply } = setup();
    await open(); await run("outline");
    expect(screen.getByTestId("suggestion-text").textContent).toContain("H2");
    await click("apply-s1");
    expect(onApply).toHaveBeenCalledWith({ fields: { h1: "SEO Agency", body: "# SEO Agency\n\n## Intro\n\n### Why" }, seo: { title: "T" } });
  });

  it("an FAQ: each suggestion is applied one by one, and the editor chooses where", async () => {
    const withList: FieldDef[] = [...DEFS, { name: "faq", primitive: "group", multiple: true, fields: [{ name: "question", primitive: "text" }, { name: "answer", primitive: "markdown" }] }];
    assist.mockResolvedValue(ok(body("faq", [
      { id: "s1", kind: "faq", question: "What is local SEO?", answer: "It is how a business shows up in nearby searches." },
      { id: "s2", kind: "faq", question: "How long does it take?", answer: "Usually a few months of steady work." },
    ])));
    const { onApply } = setup({ ctx: ctx({ defs: withList, draft: { fields: { ...DRAFT.fields, faq: [] }, seo: {} } }) });
    await open(); await run("faq");
    expect(screen.getAllByRole("listitem").filter((li) => li.getAttribute("data-testid")?.startsWith("suggestion-"))).toHaveLength(2);
    const where = screen.getByTestId("apply-target-s2") as HTMLSelectElement;
    expect(Array.from(where.options).map((o) => o.value)).toEqual(["row:faq", "append:body"]);
    await click("apply-s2");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].fields.faq).toEqual([{ question: "How long does it take?", answer: "Usually a few months of steady work." }]);
    expect((screen.getByTestId("apply-s1") as HTMLButtonElement).disabled).toBe(false); // the other is still open
    await act(async () => { fireEvent.change(screen.getByTestId("apply-target-s1"), { target: { value: "append:body" } }); });
    await click("apply-s1");
    expect(onApply.mock.calls[1][0].fields.body).toContain("**What is local SEO?**");
  });

  it("alt text puts the alt on the image; an image that already has alt is said in words and nothing is applied", async () => {
    const alt: AssistSuggestion = { id: "s1", kind: "alt_text", target: "/blocks/0/props/body", index: 0, imageRef: "/img/team.jpg", alt: "The team at work" };
    assist.mockResolvedValue(ok(body("alt_text", [alt])));
    const { onApply, unmount } = setup({ ctx: ctx({ draft: { fields: { body: "Hi\n\n![](/img/team.jpg)\n" }, seo: {} } }) });
    await open(); await run("alt_text");
    await click("apply-s1");
    expect(onApply).toHaveBeenCalledWith({ fields: { body: "Hi\n\n![The team at work](/img/team.jpg)\n" }, seo: {} });
    unmount();

    onApply.mockReset();
    const again = setup({ ctx: ctx({ draft: { fields: { body: "![already](/img/team.jpg)" }, seo: {} } }) });
    await open(); await run("alt_text");
    await click("apply-s1");
    expect(again.onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId("apply-error-s1").textContent).toMatch(/already has alt text/);
    expect(screen.queryByTestId("applied-s1")).toBeNull();
  });
});

describe("AssistDrawer: the translated first draft", () => {
  const notice = "First draft — needs a human";

  it("is labelled 'First draft — needs a human' (on the result and on the suggestion)", async () => {
    assist.mockResolvedValue(ok(body("translate_draft", [TRANSLATE], { notice })));
    setup();
    await open(); await run("translate_draft");
    expect(screen.getByTestId("assist-notice").textContent).toBe(notice);
    expect(screen.getByTestId("first-draft-s1").textContent).toBe(notice);
  });

  it("shows the label even when the BFF left the notice off", async () => {
    assist.mockResolvedValue(ok(body("translate_draft", [{ ...TRANSLATE, notice: "" }], { notice: null })));
    setup();
    await open(); await run("translate_draft");
    expect(screen.getByTestId("assist-notice").textContent).toBe(notice);
    expect(screen.getByTestId("first-draft-s1").textContent).toBe(notice);
  });

  it("an editor on the English item has no Indonesian field set: Copy only, and the reason is said", async () => {
    assist.mockResolvedValue(ok(body("translate_draft", [TRANSLATE], { notice })));
    const { onApply } = setup({ ctx: ctx({ locale: "en" }) });
    await open(); await run("translate_draft");
    expect(screen.queryByTestId("apply-s1")).toBeNull();
    expect(screen.getByTestId("apply-why-s1").textContent).toMatch(/ID version is a separate item/);
    expect(screen.getByTestId("copy-s1")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("applies only where the editor already is on that locale and has the field", async () => {
    assist.mockResolvedValue(ok(body("translate_draft", [TRANSLATE], { notice })));
    const { onApply } = setup({ ctx: ctx({ locale: "id" }) });
    await open(); await run("translate_draft");
    await click("apply-s1");
    expect(onApply).toHaveBeenCalledWith({ fields: { h1: "Agen SEO", body: "# SEO Agency\n" }, seo: { title: "T" } });
  });
});

describe("AssistDrawer: every typed failure, in words", () => {
  const CASES: Array<[string, AssistFailure, RegExp]> = [
    ["422 not applicable (no text)", { kind: "not_applicable", reason: "no_text" }, /no text yet/],
    ["422 not applicable (not enough text)", { kind: "not_applicable", reason: "not_enough_text" }, /not enough text/],
    ["422 not applicable (not English)", { kind: "not_applicable", reason: "source_not_english" }, /not in English/],
    ["422 not applicable (no image without alt)", { kind: "not_applicable", reason: "no_image_without_alt" }, /already has alt text/],
    ["429 budget: when it resets", { kind: "budget", retryAfterSeconds: 5 * 3600 }, /resets at 00:00 UTC \(in about 5 hours\)/],
    ["503 unavailable", { kind: "unavailable", reason: "gateway_unavailable" }, /The writing assistant is not available right now/],
    ["502 invalid output", { kind: "invalid_output" }, /not in a form that fits this page's rules/],
    ["409 deleted", { kind: "deleted" }, /has been deleted/],
    ["403", { kind: "forbidden" }, /don't have permission/],
    ["404", { kind: "not_found" }, /no longer exists/],
    ["401", { kind: "session" }, /session has expired/],
    ["network", { kind: "unreachable" }, /could not be reached/],
    ["drift", { kind: "drift", reason: "assist.kind: expected string, got number" }, /unexpected/],
  ];
  for (const [name, failure, re] of CASES) {
    it(name, async () => {
      assist.mockResolvedValue(fail(failure));
      setup();
      await open(); await run("faq");
      const box = screen.getByTestId("assist-error");
      expect(box.textContent).toBe(assistFailureCopy(failure));
      expect(box.textContent).toMatch(re);
      expect(box.textContent).not.toMatch(/assist-|\b[45]\d\d\b|gateway_/); // never a slug or a status code
      expect(box.getAttribute("role")).toBe("alert");
      expect(screen.queryByTestId("assist-results")).toBeNull(); // a failure is never an empty list of suggestions
      // the buttons come back, so the user can try another
      expect((screen.getByTestId("assist-run-faq") as HTMLButtonElement).disabled).toBe(false);
    });
  }

  it("a server action that throws is 'could not be reached', not a crash", async () => {
    assist.mockRejectedValue(new Error("boom"));
    setup();
    await open(); await run("outline");
    expect(screen.getByTestId("assist-error").textContent).toMatch(/could not be reached/);
    expect(screen.getByTestId("assist-error").textContent).not.toMatch(/boom/);
  });

  it("a later success replaces an earlier failure", async () => {
    assist.mockResolvedValueOnce(fail({ kind: "unavailable", reason: null }));
    assist.mockResolvedValueOnce(ok(body("meta_description", [META])));
    setup();
    await open(); await run("meta_description");
    expect(screen.getByTestId("assist-error")).toBeTruthy();
    await run("meta_description");
    expect(screen.queryByTestId("assist-error")).toBeNull();
    expect(screen.getByTestId("assist-results")).toBeTruthy();
  });
});

describe("AssistDrawer: loading, and cancelling it", () => {
  it("shows a loading state with a Cancel; the actions are off meanwhile", async () => {
    let resolve!: (r: AssistResult) => void;
    assist.mockReturnValue(new Promise<AssistResult>((r) => { resolve = r; }));
    setup();
    await open(); await run("meta_description");
    expect(screen.getByTestId("assist-running").textContent).toMatch(/Asking the assistant for meta description/);
    expect((screen.getByTestId("assist-run-faq") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve(ok(body("meta_description", [META]))); });
    expect(screen.queryByTestId("assist-running")).toBeNull();
    expect(screen.getByTestId("assist-results")).toBeTruthy();
  });

  it("Cancel stops waiting: the late answer is dropped, and the words say the request may still count", async () => {
    let resolve!: (r: AssistResult) => void;
    assist.mockReturnValue(new Promise<AssistResult>((r) => { resolve = r; }));
    setup();
    await open(); await run("meta_description");
    await click("assist-cancel");
    expect(screen.queryByTestId("assist-running")).toBeNull();
    expect(screen.getByTestId("assist-cancelled").textContent).toMatch(/Cancelled\. Nothing was changed\. The request may already have counted/);
    expect((screen.getByTestId("assist-run-faq") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { resolve(ok(body("meta_description", [META]))); });
    expect(screen.queryByTestId("assist-results")).toBeNull(); // the answer to a cancelled call never appears
  });

  it("a cancelled call's answer cannot overwrite the next call's", async () => {
    let first!: (r: AssistResult) => void;
    assist.mockReturnValueOnce(new Promise<AssistResult>((r) => { first = r; }));
    assist.mockResolvedValueOnce(ok(body("faq", [{ id: "s1", kind: "faq", question: "Q?", answer: "The second answer, which is the one that counts." }])));
    setup();
    await open(); await run("meta_description");
    await click("assist-cancel");
    await run("faq");
    await act(async () => { first(ok(body("meta_description", [META]))); });
    const results = screen.getByTestId("assist-results");
    expect(results.getAttribute("data-kind")).toBe("faq");
    expect(within(results).getByTestId("suggestion-text").textContent).toContain("second answer");
  });
});

describe("AssistDrawer: what the suggestions were made from", () => {
  it("says when the head has moved on since the suggestions were made", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META], { version: 3, headVersion: 5 })));
    setup();
    await open(); await run("meta_description");
    expect(screen.getByTestId("assist-stale").textContent).toBe("These suggestions were made from v3, but the latest saved version is v5. Check them against the current text.");
  });
  it("says when unsaved edits were not seen", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    setup({ dirty: true });
    await open();
    expect(screen.getByTestId("assist-panel").textContent).toMatch(/not from your unsaved edits/);
    await run("meta_description");
    expect(screen.getByTestId("assist-stale").textContent).toMatch(/unsaved edits when you asked/);
  });
  it("says when the editor is on another version than the one used", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META], { version: 2, headVersion: 2 })));
    setup({ baseVersion: 3 });
    await open(); await run("meta_description");
    expect(screen.getByTestId("assist-stale").textContent).toMatch(/made from v2; this editor is on v3/);
  });
  it("no warning when nothing differs", async () => {
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    setup();
    await open(); await run("meta_description");
    expect(screen.queryByTestId("assist-stale")).toBeNull();
    expect(screen.getByTestId("assist-usage").textContent).toMatch(/2 of 40/);
  });
});

describe("AssistDrawer: no suggestion text goes anywhere but the screen and the clipboard", () => {
  it("a whole session (ask, apply, copy) makes no browser network call and writes nothing to the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const beacon = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    assist.mockResolvedValue(ok(body("meta_description", [META])));
    setup();
    await open(); await run("meta_description");
    await click("apply-s1");
    await click("copy-s1");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    for (const spy of [log, info, warn]) expect(spy).not.toHaveBeenCalled();
    log.mockRestore(); info.mockRestore(); warn.mockRestore();
  });
});
