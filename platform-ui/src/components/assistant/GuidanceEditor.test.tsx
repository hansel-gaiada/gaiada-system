import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// AIP-13b (BFF section 65): the guidance editor. The form is a mirror (shown to a person who may edit); the saved state is the server's answer, and
// "What the assistant reads" is the server's `preview` verbatim. A refusal keeps what was typed and is said as the form's error.
vi.mock("@/lib/assistantGuidanceActions", () => ({ savePreambleAction: vi.fn() }));

import { savePreambleAction } from "@/lib/assistantGuidanceActions";
import { PREAMBLE_MAX, type PreambleView } from "@/lib/assistantGuidance";
import { GuidanceEditor } from "./GuidanceEditor";

const DEFAULT = "Web Dev default: say which build.";
const previewOf = (text: string | null) => (text === null ? null : `You are helping someone in the Web Dev department.\n\nDepartment guidance:\n${text}`);
const defaultView = (over: Partial<PreambleView> = {}): PreambleView => ({
  unitNodeId: "d-web", department: { name: "Web Dev", key: "web-dev" }, custom: null, defaultText: DEFAULT, effective: DEFAULT,
  updatedAt: null, updatedBy: null, preview: previewOf(DEFAULT), contextEnabled: true, ...over,
});
const customView = (text = "Our own rule."): PreambleView =>
  defaultView({ custom: text, effective: text, updatedAt: "2026-10-29T10:00:00.000Z", updatedBy: { id: "u1", name: "Ketut Arta" }, preview: previewOf(text) });

const mount = (view: PreambleView, canEdit = true) => render(<GuidanceEditor tenantId="co-a" view={view} canEdit={canEdit} />);
const field = () => screen.getByRole("textbox", { name: /what the assistant should know/i }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const reset = () => screen.getByRole("button", { name: "Use the default" }) as HTMLButtonElement;
const previewText = () => document.querySelector(".ag-preview")?.textContent;
const stateLine = () => document.querySelector(".ag-state");

beforeEach(() => vi.mocked(savePreambleAction).mockReset());

describe("what the page says", () => {
  it("default: says it is the default, starts from the default text, and shows the server's preview exactly", () => {
    mount(defaultView());
    expect(stateLine()).toHaveAttribute("data-state", "default");
    expect(stateLine()).toHaveTextContent("Web Dev uses the default text.");
    expect(field().value).toBe(DEFAULT);
    expect(previewText()).toBe(previewOf(DEFAULT));
    expect(screen.getByText("Nobody has changed it: the assistant uses the default.")).toBeInTheDocument();
  });
  it("custom: says it is the company's own, starts from it, and names who changed it and when", () => {
    mount(customView());
    expect(stateLine()).toHaveAttribute("data-state", "custom");
    expect(stateLine()).toHaveTextContent("Web Dev uses the company's own text.");
    expect(field().value).toBe("Our own rule.");
    expect(previewText()).toBe(previewOf("Our own rule."));
    expect(screen.getByText("Last changed by Ketut Arta on 29 Oct 2026.")).toBeInTheDocument();
  });
  it("a department with no default and no custom text says so, and the preview is the context line alone", () => {
    mount(defaultView({ defaultText: null, effective: null, preview: "You are helping someone in the Operations department.", department: { name: "Operations", key: "operations" } }));
    expect(screen.getByText(/no default text/)).toBeInTheDocument();
    expect(field().value).toBe("");
    expect(previewText()).toBe("You are helping someone in the Operations department.");
  });
  it("says the assistant does not use department guidance yet when contextEnabled is false, and still lets the person save", () => {
    mount(defaultView({ contextEnabled: false }));
    expect(screen.getByRole("note")).toHaveTextContent("The assistant does not use department guidance in this company yet");
    type("x");
    expect(save()).toBeEnabled();
  });
  it("says nothing about the switch when it is on", () => {
    mount(defaultView());
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
  it("carries the one note that everyone gets this text and the assistant may repeat it, as a description of the field", () => {
    mount(defaultView());
    const note = screen.getByText(/Everyone who uses the assistant in this department gets this text, and the assistant may repeat it/);
    expect(note).toHaveTextContent("Keep anything secret out of it.");
    expect(field().getAttribute("aria-describedby")).toContain(note.id);
  });
});

describe("the count", () => {
  it("is a description of the field, against 1,000, and follows what is typed", () => {
    mount(defaultView());
    const count = screen.getByText(/of 1,000 characters/);
    expect(field().getAttribute("aria-describedby")).toContain(count.id);
    type("a".repeat(412));
    expect(count).toHaveTextContent("412 of 1,000 characters");
  });
  it("counts code points: 1,000 emoji are fine and 1,001 disable Save, saying how many are over", () => {
    mount(defaultView());
    type("\u{1F600}".repeat(PREAMBLE_MAX));
    expect(screen.getByText(/of 1,000 characters/)).toHaveTextContent("1,000 of 1,000 characters");
    expect(save()).toBeEnabled();
    type("\u{1F600}".repeat(PREAMBLE_MAX + 1));
    expect(screen.getByText(/over the limit/)).toHaveTextContent("1,001 of 1,000 characters: 1 over the limit");
    expect(save()).toBeDisabled();
    expect(field()).toHaveAttribute("aria-invalid", "true");
  });
  it("an over-limit text is never sent, even by submitting the form", () => {
    mount(defaultView());
    type("a".repeat(PREAMBLE_MAX + 5));
    fireEvent.submit(field().closest("form")!);
    expect(savePreambleAction).not.toHaveBeenCalled();
  });
  it("measures after the trim, as the server does", () => {
    mount(defaultView());
    type(`   ${"a".repeat(PREAMBLE_MAX)}   `);
    expect(save()).toBeEnabled();
  });
});

describe("Save", () => {
  it("is off while nothing has changed (saving the default as it stands would freeze it as the company's own)", () => {
    mount(defaultView());
    expect(save()).toBeDisabled();
    type("Changed.");
    expect(save()).toBeEnabled();
    type(DEFAULT);
    expect(save()).toBeDisabled();
  });
  it("sends the text for this company and unit, then shows the SERVER's answer: the text, the preview, who and when, and a Saved status", async () => {
    mount(defaultView());
    vi.mocked(savePreambleAction).mockResolvedValue({ ok: true, view: customView("Our own rule.") });
    type("  Our own rule.  ");
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved."));
    expect(savePreambleAction).toHaveBeenCalledWith("co-a", "d-web", "  Our own rule.  ");
    expect(field().value).toBe("Our own rule.");
    expect(previewText()).toBe(previewOf("Our own rule."));
    expect(screen.getByText("Last changed by Ketut Arta on 29 Oct 2026.")).toBeInTheDocument();
    expect(stateLine()).toHaveAttribute("data-state", "custom");
    // The button reads "Saving…" until the action settles; once it is "Save" again nothing has changed, so it is off.
    expect(await screen.findByRole("button", { name: "Save" })).toBeDisabled();
  });
  it("a status region exists before any save and is empty until one has happened", () => {
    mount(defaultView());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
  it("a refusal is said plainly, keeps what was typed, and leaves the saved state alone", async () => {
    mount(customView());
    vi.mocked(savePreambleAction).mockResolvedValue({ ok: false, error: "Only this department's head or a company admin can change this." });
    type("Typed and refused.");
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only this department's head or a company admin can change this.");
    expect(field().value).toBe("Typed and refused.");
    expect(previewText()).toBe(previewOf("Our own rule."));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(field().getAttribute("aria-describedby")).toContain(alert.id);
  });
  it("a 400's own message is shown, and the next attempt clears it", async () => {
    mount(defaultView());
    vi.mocked(savePreambleAction).mockResolvedValueOnce({ ok: false, error: "body must be at most 1000 characters", field: "body" });
    type("Scrubbed text that grew.");
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("body must be at most 1000 characters");
    vi.mocked(savePreambleAction).mockResolvedValueOnce({ ok: true, view: customView("Scrubbed text that grew.") });
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
  it("emptying the text and saving sends an empty body and says it is back to the default", async () => {
    mount(customView());
    vi.mocked(savePreambleAction).mockResolvedValue({ ok: true, view: defaultView() });
    type("   ");
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Back to the default."));
    expect(savePreambleAction).toHaveBeenCalledWith("co-a", "d-web", "   ");
    expect(field().value).toBe(DEFAULT);
  });
});

describe("Use the default", () => {
  it("sends an EMPTY body (which deletes the company's row), then shows the default and its preview", async () => {
    mount(customView());
    vi.mocked(savePreambleAction).mockResolvedValue({ ok: true, view: defaultView() });
    expect(reset()).toBeEnabled();
    fireEvent.click(reset());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Back to the default."));
    expect(savePreambleAction).toHaveBeenCalledWith("co-a", "d-web", "");
    expect(field().value).toBe(DEFAULT);
    expect(previewText()).toBe(previewOf(DEFAULT));
    expect(stateLine()).toHaveAttribute("data-state", "default");
    await waitFor(() => expect(reset()).toBeDisabled());
  });
  it("is off while the department already uses the default: there is nothing to reset", () => {
    mount(defaultView());
    expect(reset()).toBeDisabled();
  });
  it("a refusal is said plainly and the custom text stays", async () => {
    mount(customView());
    vi.mocked(savePreambleAction).mockResolvedValue({ ok: false, error: "This department was not found. It may have been removed, or it is not a department of this company." });
    fireEvent.click(reset());
    expect(await screen.findByRole("alert")).toHaveTextContent("This department was not found");
    expect(field().value).toBe("Our own rule.");
  });
});

describe("a person who may not edit", () => {
  it("sees the text the assistant reads and who changed it, and no form", () => {
    mount(customView(), false);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(previewText()).toBe(previewOf("Our own rule."));
    expect(screen.getByText(/You can see this text but not change it/)).toBeInTheDocument();
    expect(screen.getByText(/gets this text, and the assistant may repeat it/)).toBeInTheDocument();
  });
});
