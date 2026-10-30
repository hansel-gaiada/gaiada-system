import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CycleStepStrip } from "./CycleStepStrip";
import type { CycleStep } from "@/lib/socialCycleSteps";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

// SCP-5f (BFF §63.27.4): the Plan tab's strip of the month's steps. Every state is said in words; a late step is never shown by colour alone; each step links to its PM task.

const step = (over: Partial<CycleStep>): CycleStep => ({
  step: "planning", title: "March 2027 plan", taskId: "t-plan", dueDate: "2027-02-12", done: false, progress: 0, autoClose: "auto", holder: "The officer", late: false, ...over,
});
const SIX: CycleStep[] = [
  step({ step: "report", title: "Monthly report for January 2027", taskId: "t-report", dueDate: "2027-02-05", done: true, progress: 100, holder: null }),
  step({ step: "planning", late: true, dueDate: "2027-02-10", progress: 60 }),
  step({ step: "copy_lock", title: "March 2027 copy locked", taskId: "t-copy", dueDate: "2027-02-16" }),
  step({ step: "artwork", title: "March 2027 artwork", taskId: "t-art", dueDate: "2027-02-19", autoClose: "manual" }),
  step({ step: "client_window", title: "March 2027 client approval", taskId: null, dueDate: null }),
  step({ step: "deploy", title: "March 2027 scheduled", taskId: "t-deploy", dueDate: null }),
];

describe("the strip of the month's steps", () => {
  it("draws the steps in the server's order, each with its state in words and a link to its task", () => {
    render(<CycleStepStrip steps={SIX} reason={null} />);
    const region = screen.getByRole("region", { name: "The month's steps" });
    const items = within(region).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-step"))).toEqual(["report", "planning", "copy_lock", "artwork", "client_window", "deploy"]);
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "late", "open", "open", "untracked", "open"]);
    expect(items[0]).toHaveTextContent("Monthly report for January 2027");
    expect(items[0]).toHaveTextContent("Done");
    expect(items[1]).toHaveTextContent("Late, was due 10 Feb");
    expect(items[1]).toHaveTextContent("60% of the way");
    expect(items[2]).toHaveTextContent("Open, due 16 Feb");
    expect(items[3]).toHaveTextContent("closed by hand only");
    expect(items[4]).toHaveTextContent("No task yet");
    expect(items[5]).toHaveTextContent("Open, no due date");
    expect(within(items[1]).getByRole("link", { name: "March 2027 plan" })).toHaveAttribute("href", "/tasks/t-plan");
    expect(within(items[4]).queryByRole("link")).toBeNull(); // no task, no link
    expect(screen.getByTestId("steps-summary")).toHaveTextContent("1 of 6 done, 1 late");
  });

  it("says a late step in words, never by colour alone: the state text is in the step itself, whatever the stylesheet does", () => {
    render(<CycleStepStrip steps={[step({ late: true, dueDate: "2027-02-10" })]} reason={null} />);
    const li = screen.getByRole("listitem");
    expect(li).toHaveTextContent(/Late, was due 10 Feb/);
    expect(li.querySelector(".scp-step__state")).toHaveTextContent("Late, was due 10 Feb");
  });

  it("names the holder of an open step as a role, and none for a done step", () => {
    render(<CycleStepStrip steps={SIX} reason={null} />);
    expect(screen.getAllByText("With the officer").length).toBe(5);
    expect(within(screen.getAllByRole("listitem")[0]).queryByText(/With/)).toBeNull();
  });

  it("is keyboard reachable: each linked title is an anchor with an href, in reading order", () => {
    render(<CycleStepStrip steps={SIX} reason={null} />);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/tasks/t-report", "/tasks/t-plan", "/tasks/t-copy", "/tasks/t-art", "/tasks/t-deploy"]);
  });

  it("says why there are no steps for a client with no project, and for a deleted project", () => {
    const { rerender } = render(<CycleStepStrip steps={[]} reason="no_project" />);
    expect(screen.getByTestId("steps-reason")).toHaveTextContent("no project");
    expect(screen.queryByRole("list")).toBeNull();
    rerender(<CycleStepStrip steps={[]} reason="project_not_found" />);
    expect(screen.getByTestId("steps-reason")).toHaveTextContent("project was deleted");
  });

  it("an empty list with no reason says the rules set no steps; an answer with no steps at all draws nothing", () => {
    const { container, rerender } = render(<CycleStepStrip steps={[]} reason={null} />);
    expect(screen.getByText(/No steps are set/)).toBeInTheDocument();
    rerender(<CycleStepStrip steps={null} reason={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
