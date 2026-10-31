import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-C5 (BFF §63.30.5): the panel every rules section sits in. It is exercised here with the smallest section (the two ideas switches) so the behaviour is the panel's: the current value beside the
// default, what changed and who changed it, Save with `expectedVersion`, "Reset to default" behind a confirm, the 409 `rules_changed` that keeps nothing silently, a 400's field in words beside its control,
// the read-only state, and the history.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/socialRulesActions", () => ({ saveRules: vi.fn(), resetRules: vi.fn(), previewRules: vi.fn(), loadRulesHistory: vi.fn() }));

import { loadRulesHistory, resetRules, saveRules } from "@/lib/socialRulesActions";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import { RULES_SECTIONS, asRulesAnswer, rulesRefusalText, type RulesAnswer, type RulesDoc } from "@/lib/socialRules";
import seed from "@/lib/socialRulesDefaults.json";
import { RulesPanel } from "./RulesPanel";
import { ToggleField } from "./RulesFields";

const { _about: _a, defaultsVersion, ...DOC } = seed as unknown as { _about: string; defaultsVersion: string } & RulesDoc;
const sections = (over: Record<string, unknown> = {}) => Object.fromEntries(RULES_SECTIONS.map((s) => [s, { changed: false, version: 0, editedBy: null, effectiveFrom: null, ...(over[s] as object | undefined) }]));
const answer = (over: { version?: number; ideas?: RulesDoc["ideas"]; canEdit?: boolean; sections?: Record<string, unknown> } = {}): RulesAnswer =>
  asRulesAnswer({
    version: over.version ?? 0, defaultsVersion, rules: { ...DOC, ideas: over.ideas ?? DOC.ideas }, defaults: DOC, canEdit: over.canEdit ?? true, sections: sections(over.sections),
  });

function Ideas({ a }: { a: RulesAnswer }) {
  return (
    <RulesPanel section="ideas" title="Ideas for next month" intro="Two switches." answer={a}>
      {({ draft, setDraft, defaults }) => (
        <>
          <ToggleField path="ideas.metricRequired" label="An idea needs a metric" checked={draft.metricRequired} onChange={(b) => setDraft({ ...draft, metricRequired: b })} def={defaults.metricRequired ? "on" : "off"} />
          <ToggleField path="ideas.sharedInMonthlyReport" label="Shared ideas print in the monthly report" checked={draft.sharedInMonthlyReport} onChange={(b) => setDraft({ ...draft, sharedInMonthlyReport: b })} def={defaults.sharedInMonthlyReport ? "on" : "off"} />
        </>
      )}
    </RulesPanel>
  );
}
const refusal = (error: string, status: number, extra: Record<string, unknown> = {}) => ({ ok: false as const, refusal: { status, error, ...extra }, message: rulesRefusalText({ status, error, ...extra }, "save") });
const metric = () => screen.getByRole("checkbox", { name: "An idea needs a metric" });
const shared = () => screen.getByRole("checkbox", { name: "Shared ideas print in the monthly report" });
const saveBtn = () => screen.getByRole("button", { name: "Save ideas for next month" });

beforeEach(() => { vi.clearAllMocks(); });

describe("the current value beside the default", () => {
  it("shows each control with the default in words, and says the company is on the defaults", () => {
    render(<Ideas a={answer()} />);
    expect(metric()).toBeChecked();
    expect(shared()).not.toBeChecked();
    expect(screen.getByText("Default: on")).toBeInTheDocument();
    expect(screen.getByText("Default: off")).toBeInTheDocument();
    expect(screen.getByText("Using the default")).toBeInTheDocument();
    expect(screen.getByText("Nobody has saved this section yet: the company is on the defaults.")).toBeInTheDocument();
    expect(screen.getByText("These values match the default")).toBeInTheDocument();
  });
  it("says what changed and who changed it when, and lists what differs from the default", () => {
    render(<Ideas a={answer({ version: 3, ideas: { metricRequired: false, sharedInMonthlyReport: true }, sections: { ideas: { changed: true, version: 3, editedBy: { id: "u1", name: "Mock Head" }, effectiveFrom: "2026-10-30T02:00:00.000Z" } } })} />);
    expect(screen.getByText("Changed from the default")).toBeInTheDocument();
    expect(screen.getByText(/Last saved by Mock Head on .* \(version 3\)\./)).toBeInTheDocument();
    fireEvent.click(screen.getByText("What differs from the default (2)"));
    expect(screen.getByText("The metric requirement: off (default: on)")).toBeInTheDocument();
    expect(screen.getByText("Shared ideas in the monthly report: on (default: off)")).toBeInTheDocument();
  });
});

describe("save", () => {
  it("is off until something changes, then saves the whole section against the version the person saw", async () => {
    vi.mocked(saveRules).mockResolvedValue({ ok: true, answer: answer({ version: 4 }) });
    render(<Ideas a={answer({ version: 3 })} />);
    expect(saveBtn()).toBeDisabled();
    fireEvent.click(shared());
    expect(saveBtn()).toBeEnabled();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(saveRules).toHaveBeenCalledWith("ideas", 3, { metricRequired: true, sharedInMonthlyReport: true }));
    expect(await screen.findByText(/Saved as version 4\. It applies to new periods and new records only/)).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("discards the edit and goes back to the saved values", () => {
    render(<Ideas a={answer()} />);
    fireEvent.click(metric());
    expect(metric()).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(metric()).toBeChecked();
    expect(saveBtn()).toBeDisabled();
  });
  it("starts the draft again from a newer version when the page reloads with one", () => {
    const { rerender } = render(<Ideas a={answer({ version: 1 })} />);
    fireEvent.click(metric());
    rerender(<Ideas a={answer({ version: 2, ideas: { metricRequired: true, sharedInMonthlyReport: true } })} />);
    expect(metric()).toBeChecked();
    expect(shared()).toBeChecked();
  });
});

describe("409 rules_changed", () => {
  it("says someone else saved first, saves nothing, reloads, and lists what the person had changed", async () => {
    vi.mocked(saveRules).mockResolvedValue(refusal("rules_changed", 409, { detail: { currentVersion: 5 } }));
    render(<Ideas a={answer({ version: 3 })} />);
    fireEvent.click(metric());
    fireEvent.click(saveBtn());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone else saved the rules first (now version 5), so nothing was saved. This section has been reloaded with their values.");
    expect(alert).toHaveTextContent("Your edits, so you can make them again:");
    expect(alert).toHaveTextContent("The metric requirement: on to off");
    expect(nav.refresh).toHaveBeenCalled();
  });
});

describe("400 invalid_field", () => {
  it("says the field in words beside its control, focuses it, and repeats the words under the buttons", async () => {
    vi.mocked(saveRules).mockResolvedValue(refusal("invalid_field", 400, { field: "ideas.metricRequired" }));
    render(<Ideas a={answer()} />);
    fireEvent.click(metric());
    fireEvent.click(saveBtn());
    await waitFor(() => expect(metric()).toHaveFocus());
    expect(metric()).toHaveAttribute("aria-invalid", "true");
    const beside = metric().closest(".rules__field") as HTMLElement;
    expect(within(beside).getByText("The metric requirement is not valid.")).toBeInTheDocument();
    expect(metric()).toHaveAccessibleDescription(/The metric requirement is not valid\./);
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved. The metric requirement is not valid.");
    expect(shared().closest(".rules__field")).not.toHaveTextContent("not valid");
    fireEvent.click(metric());
    expect(metric()).toHaveAttribute("aria-invalid", "false");
  });
  it("says the words without a control when the field points at none", async () => {
    vi.mocked(saveRules).mockResolvedValue(refusal("not_a_social_approver", 403));
    render(<Ideas a={answer()} />);
    fireEvent.click(metric());
    fireEvent.click(saveBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(PLAN_REFUSAL_REASON.replace("change this", "change the company's rules"));
    expect(metric()).toHaveAttribute("aria-invalid", "false");
  });
});

describe("Reset to default", () => {
  const changed = () => answer({ version: 2, ideas: { metricRequired: false, sharedInMonthlyReport: true }, sections: { ideas: { changed: true, version: 2, editedBy: { id: "u1", name: "Mock Head" }, effectiveFrom: "2026-10-30T02:00:00.000Z" } } });
  it("is off while the section is on the defaults", () => {
    render(<Ideas a={answer()} />);
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();
  });
  it("asks first, says what it does, and resets only on the confirm", async () => {
    vi.mocked(resetRules).mockResolvedValue({ ok: true, answer: answer({ version: 3 }) });
    render(<Ideas a={changed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    const dlg = screen.getByRole("dialog");
    expect(dlg).toHaveTextContent("applies to new periods and new records only");
    expect(resetRules).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole("button", { name: "Keep my values" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(resetRules).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(resetRules).toHaveBeenCalledWith("ideas", 2));
    expect(await screen.findByText(/Set back to the default, as version 3\./)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("says someone else saved first when the version is stale", async () => {
    vi.mocked(resetRules).mockResolvedValue(refusal("rules_changed", 409, { detail: { currentVersion: 9 } }));
    render(<Ideas a={changed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to default" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else saved the rules first, so nothing was reset.");
    expect(nav.refresh).toHaveBeenCalled();
  });
});

describe("a person who may not edit", () => {
  it("sees the values read-only: disabled controls, the reason in words, no Save, Reset or history", () => {
    render(<Ideas a={answer({ canEdit: false, ideas: { metricRequired: false, sharedInMonthlyReport: true } })} />);
    expect(metric()).toBeDisabled();
    expect(metric()).not.toBeChecked();
    expect(shared()).toBeDisabled();
    expect(screen.getByText(new RegExp(PLAN_REFUSAL_REASON))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(screen.queryByText("History of this section")).toBeNull();
    expect(screen.getByText("What differs from the default (2)")).toBeInTheDocument();
  });
});

describe("the history", () => {
  const item = (version: number, over: Record<string, unknown> = {}) => ({
    version, section: "ideas" as const, reset: false, editedBy: { id: "u1", name: "Mock Head" }, effectiveFrom: "2026-10-30T02:00:00.000Z",
    diff: [{ path: "ideas.metricRequired", from: true, to: false }], ...over,
  });
  it("reads when opened and lists who changed what on which day", async () => {
    vi.mocked(loadRulesHistory).mockResolvedValue({ ok: true, items: [item(3), item(2, { reset: true, diff: [] })], nextCursor: "next" });
    render(<Ideas a={answer({ version: 3 })} />);
    expect(loadRulesHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("History of this section"));
    await waitFor(() => expect(loadRulesHistory).toHaveBeenCalledWith("ideas", null));
    expect(await screen.findByText(/Version 3\. Changed by Mock Head on .*: The metric requirement: on to off\./)).toBeInTheDocument();
    expect(screen.getByText(/Version 2\. .*Set back to the default\./)).toBeInTheDocument();
    vi.mocked(loadRulesHistory).mockResolvedValue({ ok: true, items: [item(1)], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Show older changes" }));
    await waitFor(() => expect(loadRulesHistory).toHaveBeenLastCalledWith("ideas", "next"));
    expect(await screen.findByText(/Version 1\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show older changes" })).toBeNull();
  });
  it("says it cannot be shown when the read fails, and says so plainly for an empty history", async () => {
    vi.mocked(loadRulesHistory).mockResolvedValueOnce({ ok: false, refusal: { status: 500, error: "x" }, message: "That did not work. Reload the page and try again." });
    const { unmount } = render(<Ideas a={answer()} />);
    fireEvent.click(screen.getByText("History of this section"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The history cannot be shown right now.");
    unmount();
    vi.mocked(loadRulesHistory).mockResolvedValueOnce({ ok: true, items: [], nextCursor: null });
    render(<Ideas a={answer()} />);
    fireEvent.click(screen.getByText("History of this section"));
    expect(await screen.findByText("Nobody has changed this section yet.")).toBeInTheDocument();
  });
});
