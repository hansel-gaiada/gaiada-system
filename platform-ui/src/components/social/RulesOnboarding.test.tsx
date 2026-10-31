import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-C5 (BFF §63.29.2, §63.30.5): the Onboarding section: the company's template picker (`PUT settings`) and the chosen template's phases, roles and steps (PM's `PATCH templates/:id`). A refusal is said in
// words beside its control; the four choose, a person without PM's gate is told why the steps are not shown; a failed read says it cannot tell.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/socialOnboardingTemplateActions", () => ({ chooseOnboardingTemplate: vi.fn(), saveTemplateSteps: vi.fn() }));

import { chooseOnboardingTemplate, saveTemplateSteps } from "@/lib/socialOnboardingTemplateActions";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import type { ReadResult } from "@/lib/readResult";
import { templateRefusalText, type ProjectTemplate, type TemplatePayload } from "@/lib/socialOnboardingTemplate";
import { RulesOnboarding } from "./RulesOnboarding";

const payload = (): TemplatePayload => ({
  title: "Client onboarding",
  phases: [{ key: "kickoff", title: "Kickoff" }, { key: "access", title: "Access" }],
  roles: [{ key: "lead", label: "Lead" }, { key: "officer", label: "Officer" }],
  tasks: [
    { key: "meet", title: "Kickoff meeting held", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 },
    { key: "meta", title: "Partner access granted", phase: "access", role: "officer", dueOffsetWorkingDays: 2, description: "Meta business tools" },
    { key: "chat", title: "Chat groups opened", phase: "kickoff", role: "lead", dueOffsetWorkingDays: 0 },
  ],
});
const T1: ProjectTemplate = { id: "t1", name: "Social media client onboarding", updatedAt: "2026-10-30T09:00:00.000Z", payload: payload() };
const T2: ProjectTemplate = { id: "t2", name: "Quick start", updatedAt: null, payload: { ...payload(), title: "Quick" } };
const ok = (t: ProjectTemplate[]): ReadResult<ProjectTemplate[]> => ({ kind: "ok", data: t });
const mount = (over: Partial<Parameters<typeof RulesOnboarding>[0]> = {}) => render(<RulesOnboarding canEdit chosen={{ id: "t1", name: T1.name }} templates={ok([T1, T2])} {...over} />);
const fail = (error: string, status: number, field?: string, kind: "choose" | "save" = "save") => ({ ok: false as const, refusal: { status, error, ...(field ? { field } : {}) }, message: templateRefusalText({ status, error, ...(field ? { field } : {}) }, kind) });
const PICK = /^The company.s onboarding template$/;
const step = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Step ${n}:`) });
const saveSteps = () => screen.getByRole("button", { name: "Save the template's steps" });
const sent = (): TemplatePayload => vi.mocked(saveTemplateSteps).mock.calls[0][1];

beforeEach(() => vi.clearAllMocks());

describe("the picker", () => {
  it("shows the company's template selected among the live project templates", () => {
    mount();
    const sel = screen.getByLabelText(PICK);
    expect(sel).toHaveValue("t1");
    expect(within(sel).getAllByRole("option").map((o) => o.textContent)).toEqual(["No template chosen", "Social media client onboarding", "Quick start"]);
    expect(screen.getByRole("button", { name: "Save the choice" })).toBeDisabled();
  });
  it("chooses another template and says new onboardings start from it", async () => {
    vi.mocked(chooseOnboardingTemplate).mockResolvedValue({ ok: true });
    mount();
    fireEvent.change(screen.getByLabelText(PICK), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the choice" }));
    await waitFor(() => expect(chooseOnboardingTemplate).toHaveBeenCalledWith("t2"));
    expect(await screen.findByText("Saved. New onboardings start from this template.")).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("clears the choice with null and says starting will say so", async () => {
    vi.mocked(chooseOnboardingTemplate).mockResolvedValue({ ok: true });
    mount();
    fireEvent.change(screen.getByLabelText(PICK), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the choice" }));
    await waitFor(() => expect(chooseOnboardingTemplate).toHaveBeenCalledWith(null));
    expect(await screen.findByText(/No template is chosen now/)).toBeInTheDocument();
  });
  it("says in words that the server refused the choice", async () => {
    vi.mocked(chooseOnboardingTemplate).mockResolvedValue(fail("invalid_field", 400, "onboardingTemplateId", "choose"));
    mount();
    fireEvent.change(screen.getByLabelText(PICK), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the choice" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved. That is not a live project template of this company.");
    vi.mocked(chooseOnboardingTemplate).mockResolvedValue(fail("not_a_social_approver", 403, undefined, "choose"));
    // The alert can show while the first save still reads "Working…": wait for the button to come back before the second click.
    fireEvent.click(await screen.findByRole("button", { name: "Save the choice" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(PLAN_REFUSAL_REASON.replace("change this", "choose the onboarding template")));
  });
  it("offers no picker and no steps to a person who may not choose, and says what the template is", () => {
    mount({ canEdit: false, templates: null });
    expect(screen.queryByLabelText(PICK)).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.getByText(PLAN_REFUSAL_REASON + " You can read the template here.")).toBeInTheDocument();
    expect(screen.getByText("Social media client onboarding")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /^Steps of/ })).toBeNull();
  });
  it("says none is chosen, to a reader and to the four", () => {
    const { unmount } = mount({ canEdit: false, chosen: null, templates: null });
    expect(screen.getByText("No onboarding template is chosen yet.")).toBeInTheDocument();
    unmount();
    mount({ chosen: null });
    expect(screen.getByText("Choose a template above to see and edit its steps.")).toBeInTheDocument();
  });
  it("says what it cannot show when PM refuses the list, and when the read fails, never an empty picker", () => {
    const { unmount } = mount({ templates: { kind: "forbidden" } });
    expect(screen.getByText(/The templates cannot be listed for you: choosing and editing them needs the right to manage Project Management templates\./)).toBeInTheDocument();
    expect(screen.getByText("Social media client onboarding")).toBeInTheDocument();
    expect(screen.queryByLabelText(PICK)).toBeNull();
    unmount();
    mount({ templates: { kind: "unavailable", reason: "platform 500" } });
    expect(screen.getByText(/The templates cannot be shown right now \(platform 500\)\./)).toBeInTheDocument();
    expect(screen.queryByLabelText(PICK)).toBeNull();
  });
  it("says so when the chosen template is no longer a live one", () => {
    mount({ chosen: { id: "t9", name: "Old checklist" } });
    expect(screen.getByText(/The chosen template, Old checklist, is not in the list of live project templates/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /^Steps of/ })).toBeNull();
  });
});

describe("the chosen template's steps", () => {
  it("lists the phases, roles and steps grouped by phase, each step with its due day in words", () => {
    mount();
    expect(screen.getByRole("group", { name: /Steps of .Social media client onboarding./ })).toBeInTheDocument();
    expect(screen.getByLabelText("Project title")).toHaveValue("Client onboarding");
    expect(screen.getByLabelText("Phase 2 name")).toHaveValue("Access");
    expect(screen.getByLabelText("Role 2 name")).toHaveValue("Officer");
    expect(screen.getAllByRole("listitem", { name: /^Step \d:/ })).toHaveLength(3);
    const kickoff = screen.getByRole("region", { name: "Steps of the phase Kickoff" });
    expect(within(kickoff).getAllByRole("listitem", { name: /^Step \d:/ }).map((l) => l.getAttribute("aria-label"))).toEqual(["Step 1: Kickoff meeting held", "Step 3: Chat groups opened"]);
    expect(within(step(2)).getByText("Step 2 · 2 working days after the kickoff")).toBeInTheDocument();
    expect(within(step(1)).getByText("Step 1 · On the kickoff day")).toBeInTheDocument();
    expect(within(step(2)).getByLabelText("Working days after the kickoff")).toHaveValue(2);
    expect(within(step(2)).getByLabelText("Description")).toHaveValue("Meta business tools");
  });
  it("saves an edited step through PM's route with the payload alone, and says running onboardings keep their steps", async () => {
    vi.mocked(saveTemplateSteps).mockResolvedValue({ ok: true });
    mount();
    expect(saveSteps()).toBeDisabled();
    fireEvent.change(within(step(2)).getByLabelText("Title"), { target: { value: "Partner access to Meta granted" } });
    fireEvent.change(within(step(2)).getByLabelText("Working days after the kickoff"), { target: { value: "3" } });
    fireEvent.change(within(step(2)).getByLabelText("Role"), { target: { value: "lead" } });
    fireEvent.change(within(step(1)).getByLabelText("Sub-steps, one per line"), { target: { value: "Agenda sent\n\nNotes shared" } });
    fireEvent.click(saveSteps());
    await waitFor(() => expect(saveTemplateSteps).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveTemplateSteps).mock.calls[0][0]).toBe("t1");
    expect(sent().tasks[1]).toMatchObject({ title: "Partner access to Meta granted", dueOffsetWorkingDays: 3, role: "lead", phase: "access" });
    expect(sent().tasks[0].subtasks).toEqual(["Agenda sent", "", "Notes shared"]);
    expect(await screen.findByText("Saved. Onboardings already started keep the steps they were started with; the next ones use these.")).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("adds a phase, a role and a step; moves a step only among its own phase's steps; removes one", async () => {
    vi.mocked(saveTemplateSteps).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a phase" }));
    fireEvent.change(screen.getByLabelText("Phase 3 name"), { target: { value: "First cycle" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a role" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    fireEvent.change(within(step(4)).getByLabelText("Phase"), { target: { value: "phase" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move step 3, Chat groups opened up$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove step 2, Partner access granted$/ }));
    fireEvent.click(saveSteps());
    await waitFor(() => expect(saveTemplateSteps).toHaveBeenCalled());
    const p = sent();
    expect(p.phases.map((x) => x.key)).toEqual(["kickoff", "access", "phase"]);
    expect(p.roles.map((x) => x.key)).toEqual(["lead", "officer", "role"]);
    expect(p.tasks.map((t) => t.key)).toEqual(["chat", "meet", "step"]);
    expect(p.tasks[2]).toEqual({ key: "step", title: "New step", phase: "phase", role: "lead", dueOffsetWorkingDays: 0 });
  });
  it("will not remove a phase or a role a step still uses, and says why", () => {
    mount();
    const rm = screen.getByRole("button", { name: /^Remove phase 1, Kickoff$/ });
    expect(rm).toBeDisabled();
    expect(rm).toHaveAttribute("title", "Steps still use this phase. Move or remove them first.");
    expect(screen.getByRole("button", { name: /^Remove role 2, Officer$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add a phase" }));
    expect(screen.getByRole("button", { name: /^Remove phase 3, New phase$/ })).toBeEnabled();
  });
  it("discards the edit", () => {
    mount();
    fireEvent.change(within(step(1)).getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(within(step(1)).getByLabelText("Title")).toHaveValue("Kickoff meeting held");
    expect(saveSteps()).toBeDisabled();
  });
  it("says the template changed on the server by starting again from it", () => {
    const { rerender } = mount();
    fireEvent.change(within(step(1)).getByLabelText("Title"), { target: { value: "Mine" } });
    const next = { ...T1, updatedAt: "2026-10-31T09:00:00.000Z", payload: { ...payload(), title: "Theirs" } };
    rerender(<RulesOnboarding canEdit chosen={{ id: "t1", name: T1.name }} templates={ok([next, T2])} />);
    expect(screen.getByLabelText("Project title")).toHaveValue("Theirs");
    expect(within(step(1)).getByLabelText("Title")).toHaveValue("Kickoff meeting held");
  });
  it("says that the last save wins, as PM's route has no version", () => {
    mount();
    expect(screen.getByText(/If someone else is editing this template at the same time, the last save wins\./)).toBeInTheDocument();
  });
  it("is labelled throughout", () => {
    mount();
    for (const c of [...screen.getAllByRole("combobox"), ...screen.getAllByRole("textbox"), ...screen.getAllByRole("spinbutton"), ...screen.getAllByRole("button")]) expect(c).toHaveAccessibleName();
  });
});

describe("a refused field, in words, beside its control", () => {
  it("names a step's day count and focuses it", async () => {
    vi.mocked(saveTemplateSteps).mockResolvedValue(fail("invalid_field", 400, "payload.tasks.1.dueOffsetWorkingDays"));
    mount();
    fireEvent.change(within(step(2)).getByLabelText("Working days after the kickoff"), { target: { value: "300" } });
    fireEvent.click(saveSteps());
    const box = within(step(2)).getByLabelText("Working days after the kickoff");
    await waitFor(() => expect(box).toHaveFocus(), { timeout: 4000 });
    expect(box).toHaveAccessibleDescription(/Step 2, the working days after the kickoff is not valid\. Use a whole number of working days from 0 to 250\./);
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved. Step 2, the working days after the kickoff is not valid.");
  });
  it("says in words that PM's own right is missing when it refuses with 403", async () => {
    vi.mocked(saveTemplateSteps).mockResolvedValue(fail("not authorized: cerbos denied manage on pm_task", 403));
    mount();
    fireEvent.change(within(step(1)).getByLabelText("Title"), { target: { value: "X" } });
    fireEvent.click(saveSteps());
    expect(await screen.findByRole("alert")).toHaveTextContent("Editing the template's steps needs the right to manage Project Management templates.");
  });
  it("says the template is gone for a 404", async () => {
    vi.mocked(saveTemplateSteps).mockResolvedValue(fail("template not found", 404));
    mount();
    fireEvent.change(within(step(1)).getByLabelText("Title"), { target: { value: "X" } });
    fireEvent.click(saveSteps());
    expect(await screen.findByRole("alert")).toHaveTextContent("That template is gone.");
  });
});
