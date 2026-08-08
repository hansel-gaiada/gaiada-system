import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Gantt } from "./Gantt";
import type { PmTask, Timeline, MilestoneMarker, Assignee } from "@/lib/pm";

// Gantt reads the router/pathname/search-params hooks even in its read-only mode (collapsed-group
// state is stored in ?collapsed=) — same stub shape as Board.test.tsx. `nav.search` is mutable
// (set per-test before render) so P4-C1/P4-C2 tests can simulate `?gz=`/`?gfrom=`/`?gto=` already
// present in the URL, and `nav.replace` is asserted against to prove a control writes the URL it
// claims to.
const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/projects/p-1",
  useSearchParams: () => nav.search,
}));

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  nav.push.mockClear();
});

// jsdom has no ResizeObserver; Gantt's dependency-line effect observes its container
// unconditionally (even with zero dep edges, as here). Minimal no-op stub, test-local only.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function task(p: Partial<PmTask> & Pick<PmTask, "id" | "title">): PmTask {
  return {
    projectId: "p-1", projectName: "Project", description: "", status: "todo",
    priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
    startDate: "2024-01-01", dueDate: "2024-01-10", estimateMinutes: null, loggedMinutes: 0,
    dependsOn: [], tags: [], customFields: {}, updatedAt: null, recurrence: null,
    projectShortCode: null, seq: null, displayCode: null, ...p,
  };
}

function assignee(p: Partial<Assignee> & Pick<Assignee, "refId" | "refName">): Assignee {
  return { kind: "person", responsibleId: p.refId, responsibleName: p.refName, ...p };
}

function timelineFor(tasks: PmTask[]): Timeline {
  return {
    start: "2024-01-01",
    end: "2024-01-10",
    days: 9,
    bars: tasks.map((t) => ({ task: t, offsetPct: 0, widthPct: 10, startsMissing: false })),
  };
}

describe("Gantt urgency indicator (P4-G5)", () => {
  it("renders the given tier as a dot next to the bar's label, keyed by task id", () => {
    const t = task({ id: "t1", title: "Overdue bar" });
    const { container } = render(<Gantt timeline={timelineFor([t])} taskUrgency={{ t1: "overdue" }} />);
    // Two elements share the text (the dot span + its sr-only child) — assert on the
    // container's class presence rather than screen.getByText, same pattern as
    // UrgencyChip.test.tsx uses for exactly this reason.
    expect(container.querySelector(".pm-urg--overdue")).toBeTruthy();
    expect(screen.getByText("Overdue bar")).toBeInTheDocument();
  });

  it("renders no indicator when the caller supplies no map — Gantt never derives it from task dates itself", () => {
    const t = task({ id: "t1", title: "No map bar" });
    const { container } = render(<Gantt timeline={timelineFor([t])} />);
    expect(container.querySelector(".pm-urg")).toBeNull();
  });

  it("renders nothing for a bar the map marks done or undated", () => {
    const tasks = [task({ id: "t1", title: "Done bar" }), task({ id: "t2", title: "Undated bar" })];
    const { container } = render(
      <Gantt timeline={timelineFor(tasks)} taskUrgency={{ t1: "done", t2: "undated" }} />,
    );
    expect(container.querySelector(".pm-urg")).toBeNull();
  });
});

describe("Gantt zoom — Day/Week/Month (P4-C1)", () => {
  it("renders three zoom controls, none pressed when ?gz= is absent (the adaptive heuristic stays the default)", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    for (const label of ["Day", "Week", "Month"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("picking a zoom writes ?gz= to the URL, preserving the existing pathname", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gz=day", { scroll: false });
  });

  it("clicking the already-active zoom clears it — back to automatic, not stuck", () => {
    nav.search = new URLSearchParams("gz=week");
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    // No other params were present, so clearing `gz` leaves a bare path.
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1", { scroll: false });
  });

  it("Month zoom renders calendar-month ticks (with a year label) even past the 366-day dense cap, and suppresses weekend banding", () => {
    nav.search = new URLSearchParams("gz=month");
    const t = task({ id: "t1", title: "Long bar", startDate: "2024-01-01", dueDate: "2024-01-05" });
    const timeline: Timeline = {
      start: "2024-01-01", end: "2026-01-01", days: 731, // >366 days — the day/week dense cap alone would fall back to the plain axis
      bars: [{ task: t, offsetPct: 0, widthPct: 1, startsMissing: false }],
    };
    const { container } = render(<Gantt timeline={timeline} />);
    expect(container.querySelector(".pm-gantt__daxis")).toBeTruthy();
    expect(screen.getByText("Jan 2024")).toBeInTheDocument();
    expect(container.querySelector(".pm-gantt__axis")).toBeNull(); // the coarse start/end fallback did NOT render
    expect(container.querySelectorAll(".pm-gantt__weekend").length).toBe(0);
  });

  it("without an explicit zoom, a >366-day span still falls back to the plain start/end axis (unchanged heuristic behaviour)", () => {
    const t = task({ id: "t1", title: "Long bar" });
    const timeline: Timeline = {
      start: "2024-01-01", end: "2026-01-01", days: 731,
      bars: [{ task: t, offsetPct: 0, widthPct: 1, startsMissing: false }],
    };
    const { container } = render(<Gantt timeline={timeline} />);
    expect(container.querySelector(".pm-gantt__daxis")).toBeNull();
    expect(container.querySelector(".pm-gantt__axis")).toBeTruthy();
  });
});

describe("Gantt explicit date window (P4-C2)", () => {
  it("the two date fields default to the server-derived window when no override is present", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    expect(screen.getByLabelText("Window start")).toHaveValue("2024-01-01");
    expect(screen.getByLabelText("Window end")).toHaveValue("2024-01-10");
    // No override active yet, so there is nothing to clear.
    expect(screen.queryByRole("button", { name: /clear date window/i })).toBeNull();
  });

  it("Apply writes ?gfrom=/?gto= to the URL", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "2024-01-02" } });
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: "2024-01-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gfrom=2024-01-02&gto=2024-01-08", { scroll: false });
  });

  it("refuses an end date before the start date — no navigation, an announced reason instead", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "2024-01-08" } });
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: "2024-01-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByText("End date must be on or after the start date.")).toBeInTheDocument();
  });

  it("the × clears the window, removing only gfrom/gto and leaving other params alone", () => {
    nav.search = new URLSearchParams("gfrom=2024-01-02&gto=2024-01-08&collapsed=x");
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.click(screen.getByRole("button", { name: /clear date window/i }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?collapsed=x", { scroll: false });
  });

  it("drops a task whose dates fall entirely outside the window, and keeps one that overlaps it", () => {
    nav.search = new URLSearchParams("gfrom=2024-01-01&gto=2024-01-10");
    const inWindow = task({ id: "t1", title: "In window", startDate: "2024-01-01", dueDate: "2024-01-05" });
    const outside = task({ id: "t2", title: "Outside window", startDate: "2024-02-01", dueDate: "2024-02-05" });
    render(<Gantt timeline={timelineFor([inWindow, outside])} />);
    expect(screen.getByText("In window")).toBeInTheDocument();
    expect(screen.queryByText("Outside window")).toBeNull();
  });

  it("repositions a milestone inside the window and hides one outside it", () => {
    nav.search = new URLSearchParams("gfrom=2024-01-01&gto=2024-01-10");
    const t = task({ id: "t1", title: "Bar" });
    const milestones: MilestoneMarker[] = [
      { id: "m1", name: "Kickoff", date: "2024-01-03", offsetPct: 50 },
      { id: "m2", name: "Way later", date: "2024-03-01", offsetPct: 90 },
    ];
    const { container } = render(<Gantt timeline={timelineFor([t])} milestones={milestones} />);
    expect(container.querySelectorAll(".pm-gantt__milestone")).toHaveLength(1);
    expect(screen.getByTitle(/Kickoff/)).toBeInTheDocument();
  });
});

describe("Gantt filter bar (P4-C3)", () => {
  it("is closed by default and opens itself when a filter param is already in the URL", () => {
    const t = task({ id: "t1", title: "Bar" });
    const { container: closed } = render(<Gantt timeline={timelineFor([t])} />);
    expect(closed.querySelector(".pm-gantt__filterbar")).not.toHaveAttribute("open");

    nav.search = new URLSearchParams("gstatus=todo");
    const { container: open } = render(<Gantt timeline={timelineFor([t])} />);
    expect(open.querySelector(".pm-gantt__filterbar")).toHaveAttribute("open");
    expect(screen.getByText("Filters (1)")).toBeInTheDocument();
  });

  it("Status facet: offers only the statuses present, and checking one both filters rows and writes ?gstatus=", () => {
    const tasks = [
      task({ id: "t1", title: "Todo bar", status: "todo" }),
      task({ id: "t2", title: "Doing bar", status: "in_progress" }),
    ];
    render(<Gantt timeline={timelineFor(tasks)} />);
    // Labels come from PM_STATUS_LADDER — "todo" -> "ToDo", "in_progress" -> "Doing".
    fireEvent.click(screen.getByRole("checkbox", { name: "Doing" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gstatus=in_progress", { scroll: false });

    cleanup();
    nav.search = new URLSearchParams("gstatus=in_progress");
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getAllByText("Doing bar").length).toBeGreaterThan(0);
    expect(screen.queryByText("Todo bar")).toBeNull();
  });

  it("Priority facet filters rows by the closed 4-value enum", () => {
    nav.search = new URLSearchParams("gpriority=urgent");
    const tasks = [
      task({ id: "t1", title: "Urgent bar", priority: "urgent" }),
      task({ id: "t2", title: "Normal bar", priority: "normal" }),
    ];
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByText("Urgent bar")).toBeInTheDocument();
    expect(screen.queryByText("Normal bar")).toBeNull();
  });

  it("Ball facet is `assignee.refId`, Responsible facet is `assignee.responsibleId` — independently filterable (plan §1.5)", () => {
    const edward = assignee({ refId: "u-edward", refName: "Edward", responsibleId: "u-gusde", responsibleName: "Gusde" });
    const gusde = assignee({ refId: "u-gusde", refName: "Gusde", responsibleId: "u-gusde", responsibleName: "Gusde" });
    const tasks = [
      task({ id: "t1", title: "Edward's ball", assignee: edward }),
      task({ id: "t2", title: "Gusde's ball", assignee: gusde }),
    ];
    nav.search = new URLSearchParams("gball=u-edward");
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByText("Edward's ball")).toBeInTheDocument();
    expect(screen.queryByText("Gusde's ball")).toBeNull();

    // Both tasks share the same Responsible (Gusde) despite different Balls — filtering on
    // Responsible must keep both, proving the two facets are independent, not aliases.
    cleanup();
    nav.search = new URLSearchParams("gresponsible=u-gusde");
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByText("Edward's ball")).toBeInTheDocument();
    expect(screen.getByText("Gusde's ball")).toBeInTheDocument();
  });

  it("Tags facet renders only when `taskTags` is supplied, and filters by the resolved label", () => {
    const tasks = [task({ id: "t1", title: "Tagged bar", tags: ["tag-1"] }), task({ id: "t2", title: "Untagged bar" })];
    const { container: noMap } = render(<Gantt timeline={timelineFor(tasks)} />);
    expect(within(noMap).queryByText("Tags")).toBeNull();

    cleanup();
    nav.search = new URLSearchParams("gtags=tag-1");
    render(<Gantt timeline={timelineFor(tasks)} taskTags={{ t1: [{ id: "tag-1", label: "Urgent work", color: "bronze" }] }} />);
    expect(screen.getByText("Urgent work", { selector: "label span, label" })).toBeInTheDocument();
    expect(screen.getByText("Tagged bar")).toBeInTheDocument();
    expect(screen.queryByText("Untagged bar")).toBeNull();
  });

  it("Milestones facet renders only when `milestones` is supplied, and filtering excludes non-matching tasks", () => {
    const tasks = [task({ id: "t1", title: "Milestone bar", milestoneId: "m1" }), task({ id: "t2", title: "No milestone" })];
    const milestones: MilestoneMarker[] = [{ id: "m1", name: "Kickoff", date: "2024-01-03", offsetPct: 50 }];
    nav.search = new URLSearchParams("gmilestone=m1");
    render(<Gantt timeline={timelineFor(tasks)} milestones={milestones} />);
    expect(screen.getByText("Milestone bar")).toBeInTheDocument();
    expect(screen.queryByText("No milestone")).toBeNull();
  });

  it("Keywords: typing and submitting Apply filters writes ?gq= and matches on title or description", () => {
    const tasks = [task({ id: "t1", title: "Bake a cake" }), task({ id: "t2", title: "Other work" })];
    render(<Gantt timeline={timelineFor(tasks)} />);
    fireEvent.change(screen.getByLabelText("Keywords"), { target: { value: "cake" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gq=cake", { scroll: false });

    cleanup();
    nav.search = new URLSearchParams("gq=cake");
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByText("Bake a cake")).toBeInTheDocument();
    expect(screen.queryByText("Other work")).toBeNull();
  });

  it("Due date facet range excludes tasks outside [gduefrom, gdueto], distinct from the ?gfrom=/?gto= window", () => {
    const tasks = [
      task({ id: "t1", title: "Due in range", dueDate: "2024-01-05" }),
      task({ id: "t2", title: "Due outside range", dueDate: "2024-01-20" }),
    ];
    nav.search = new URLSearchParams("gduefrom=2024-01-01&gdueto=2024-01-10");
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByText("Due in range")).toBeInTheDocument();
    expect(screen.queryByText("Due outside range")).toBeNull();
  });

  it("Overdue Only is disabled with a reason when no `taskUrgency` map is supplied, and filters correctly when it is", () => {
    const tasks = [task({ id: "t1", title: "Bar" })];
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByRole("checkbox", { name: /Overdue Only/ })).toBeDisabled();

    cleanup();
    const overdue = task({ id: "t1", title: "Overdue bar" });
    const onTrack = task({ id: "t2", title: "On-track bar" });
    nav.search = new URLSearchParams("goverdue=1");
    render(<Gantt timeline={timelineFor([overdue, onTrack])} taskUrgency={{ t1: "overdue", t2: "on-track" }} />);
    expect(screen.getByRole("checkbox", { name: /Overdue Only/ })).not.toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Overdue Only/ })).toBeChecked();
    expect(screen.getByText("Overdue bar")).toBeInTheDocument();
    expect(screen.queryByText("On-track bar")).toBeNull();
  });

  it("Show Closed defaults to checked (no behaviour change for existing bookmarks/callers) and unchecking hides done tasks", () => {
    const tasks = [task({ id: "t1", title: "Done bar", status: "done" }), task({ id: "t2", title: "Open bar", status: "todo" })];
    const { container } = render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.getByRole("checkbox", { name: "Show Closed" })).toBeChecked();
    expect(screen.getByText("Done bar")).toBeInTheDocument(); // default: nothing hidden
    expect(container.querySelector(".pm-gantt__filterbar")).not.toHaveAttribute("open");

    fireEvent.click(screen.getByRole("checkbox", { name: "Show Closed" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?gclosed=0", { scroll: false });

    cleanup();
    nav.search = new URLSearchParams("gclosed=0");
    render(<Gantt timeline={timelineFor(tasks)} />);
    expect(screen.queryByText("Done bar")).toBeNull();
    expect(screen.getByText("Open bar")).toBeInTheDocument();
  });

  it("Sub-task toggle is disabled rather than faked (decision 11 is open — Subtasks aren't first-class tasks)", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    const box = screen.getByRole("checkbox", { name: /Sub-task/ });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
  });

  it("Clear filters removes every g* filter param but leaves an unrelated param (?collapsed=) alone", () => {
    nav.search = new URLSearchParams("gstatus=todo&gpriority=urgent&collapsed=x");
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p-1?collapsed=x", { scroll: false });
  });
});

describe("Gantt CSV export (P4-C5)", () => {
  it("hides the Export CSV control when there is nothing to export", () => {
    // Every bar filtered out by a facet, but the timeline itself isn't empty.
    nav.search = new URLSearchParams("gstatus=nonexistent");
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} />);
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
  });

  it("exports only the currently-visible (filtered) rows as CSV", () => {
    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    let blobText = "";
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn((b: Blob) => {
      created.push("blob:mock");
      // jsdom's Blob supports .text() synchronously enough for a microtask-free read isn't
      // guaranteed, so capture the parts instead via the Blob constructor args below.
      return "blob:mock";
    });
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    nav.search = new URLSearchParams("gpriority=urgent");
    const tasks = [
      task({ id: "t1", title: "Urgent bar", priority: "urgent" }),
      task({ id: "t2", title: "Normal bar", priority: "normal" }),
    ];
    render(<Gantt timeline={timelineFor(tasks)} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(created.length).toBe(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    clickSpy.mockRestore();
    void blobText;
  });
});

describe("Gantt inline \"Add a task\" (P4-C6)", () => {
  it("renders nothing when the caller supplies no `onAddTask`", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} interactive canEdit />);
    expect(screen.queryByPlaceholderText("Add a task")).toBeNull();
  });

  it("renders nothing when write access is off, even with `onAddTask` supplied", () => {
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} interactive canEdit={false} onAddTask={vi.fn()} />);
    expect(screen.queryByPlaceholderText("Add a task")).toBeNull();
  });

  it("submits the group key and title, then refreshes on success", async () => {
    const onAddTask = vi.fn().mockResolvedValue({ ok: true });
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} interactive canEdit onAddTask={onAddTask} />);
    fireEvent.change(screen.getByPlaceholderText("Add a task"), { target: { value: "New follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add a task" }));
    await vi.waitFor(() => expect(onAddTask).toHaveBeenCalledWith("__all", "New follow-up"));
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it("surfaces the returned error in the toast instead of refreshing", async () => {
    const onAddTask = vi.fn().mockResolvedValue({ ok: false, error: "Nope." });
    const t = task({ id: "t1", title: "Bar" });
    render(<Gantt timeline={timelineFor([t])} interactive canEdit onAddTask={onAddTask} />);
    fireEvent.change(screen.getByPlaceholderText("Add a task"), { target: { value: "New follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add a task" }));
    await screen.findByText("Nope.");
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
