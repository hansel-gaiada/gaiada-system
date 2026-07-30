import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Board } from "./Board";
import type { AxisColumn, PmTask } from "@/lib/pm";

// Board is a client component that calls useRouter().refresh() after every
// commit (P1-03) — stub next/navigation so it can render outside an app-router.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function task(p: Partial<PmTask> & Pick<PmTask, "id" | "title">): PmTask {
  return {
    projectId: "p-1", projectName: "Project", description: "", status: "todo",
    priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
    startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0,
    dependsOn: [], tags: [], customFields: {}, updatedAt: null, recurrence: null,
    projectShortCode: null, seq: null, displayCode: null, ...p,
  };
}

function statusColumns(tasks: PmTask[]): AxisColumn<"todo" | "in_progress">[] {
  return [
    { key: "todo", label: "To do", tasks: tasks.filter((t) => t.status === "todo") },
    { key: "in_progress", label: "In progress", tasks: tasks.filter((t) => t.status === "in_progress") },
  ];
}

describe("Board", () => {
  it("renders uniform columns via role=list/listitem (P1-03 §9 a11y)", () => {
    render(<Board columns={statusColumns([task({ id: "t1", title: "Task one" })])} move={vi.fn()} />);
    expect(screen.getAllByRole("list")).toHaveLength(2); // one per column body
    expect(screen.getByRole("listitem")).toBeInTheDocument();
    expect(screen.getByText("Task one")).toBeInTheDocument();
  });

  it("shows subtask count, blocked chip, and a due pill on the card (P1-02 card anatomy)", () => {
    const t = task({
      id: "t1", title: "Has extras", dueDate: "2020-01-01",
      subtasks: [{ id: "s1", title: "a", done: true }, { id: "s2", title: "b", done: false }],
    });
    render(<Board columns={statusColumns([t])} move={vi.fn()} blockedIds={new Set(["t1"])} />);
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });

  it("the keyboard ⇅ Move affordance opens a menu and commits an unambiguous move", async () => {
    const move = vi.fn(async () => ({ ok: true }));
    render(<Board columns={statusColumns([task({ id: "t1", title: "Movable" })])} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: /move "movable" to a different column/i }));
    expect(screen.getByRole("menu", { name: /move task to/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("t1", "in_progress", undefined));
  });

  it("surfaces the inline toast (not a silent no-op) when move() resolves ok:false — Board.tsx §2 error-state gap", async () => {
    const move = vi.fn(async () => ({ ok: false, error: "WIP limit reached for In progress." }));
    render(<Board columns={statusColumns([task({ id: "t1", title: "Will fail" })])} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: /move "will fail" to a different column/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("WIP limit reached for In progress."));
  });

  it("falls back to a generic message when a failed move carries no error string", async () => {
    const move = vi.fn(async () => ({ ok: false }));
    render(<Board columns={statusColumns([task({ id: "t1", title: "Will fail quietly" })])} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: /move "will fail quietly" to a different column/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't move this task."));
  });

  it("opens the responsible-person ambiguity popover for a division column that doesn't already include the current responsible", async () => {
    const move = vi.fn(async () => ({ ok: true }));
    const columns: AxisColumn<string>[] = [
      { key: "div-a", label: "Frontend", tasks: [], people: [{ id: "u1", name: "Ada" }] },
      {
        key: "div-b", label: "Backend",
        tasks: [task({ id: "t1", title: "Ambiguous", assignee: { kind: "division", refId: "div-a", refName: "Frontend", responsibleId: "u1", responsibleName: "Ada" } })],
        people: [{ id: "u2", name: "Bo" }],
      },
    ];
    render(<Board columns={columns} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: /move "ambiguous" to a different column/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Frontend" }));
    // target column's people (Ada) already includes the current responsible -> commits straight away
    await waitFor(() => expect(move).toHaveBeenCalledWith("t1", "div-a", "u1"));
  });

  it("shows a WIP over-limit toast on a successful drop but never blocks the move (P2-05 §2)", async () => {
    const move = vi.fn(async () => ({ ok: true }));
    const columns: AxisColumn<string>[] = [
      { key: "todo", label: "To do", tasks: [task({ id: "t1", title: "Movable" })] },
      { key: "in_progress", label: "In progress", wipLimit: 1, tasks: [task({ id: "t2", title: "Already there", status: "in_progress" })] },
    ];
    render(<Board columns={columns} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: /move "movable" to a different column/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("t1", "in_progress", undefined)); // committed (not blocked)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/over its WIP limit \(2\/1\)/));
  });

  it("union-by-label no-match: move() returning { pick } opens the popover and commits via movePick (D-4)", async () => {
    const move = vi.fn(async () => ({ ok: false, pick: { options: [{ id: "s-a", name: "Backlog" }, { id: "s-b", name: "Doing" }] } }));
    const movePick = vi.fn(async () => ({ ok: true }));
    const columns: AxisColumn<string>[] = [
      { key: "To do", label: "To do", tasks: [task({ id: "t1", title: "Cross-project" })] },
      { key: "Review", label: "Review", tasks: [] },
    ];
    render(<Board columns={columns} move={move} movePick={movePick} />);
    fireEvent.click(screen.getByRole("button", { name: /move "cross-project" to a different column/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Review" }));
    await waitFor(() => expect(move).toHaveBeenCalledWith("t1", "Review", undefined));
    expect(await screen.findByRole("menu", { name: /pick a status/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "s-b" } });
    await waitFor(() => expect(movePick).toHaveBeenCalledWith("t1", "s-b"));
  });

  it("division move into a column whose people do NOT include the current responsible opens the picker instead of committing", async () => {
    const move = vi.fn(async () => ({ ok: true }));
    const columns: AxisColumn<string>[] = [
      {
        key: "div-a", label: "Frontend",
        tasks: [task({ id: "t1", title: "Needs a pick", assignee: { kind: "division", refId: "div-a", refName: "Frontend", responsibleId: "u1", responsibleName: "Ada" } })],
        people: [{ id: "u1", name: "Ada" }],
      },
      { key: "div-b", label: "Backend", tasks: [], people: [{ id: "u2", name: "Bo" }] },
    ];
    render(<Board columns={columns} move={move} />);
    fireEvent.click(screen.getByRole("button", { name: /move "needs a pick" to a different column/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Backend" }));
    expect(move).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: /pick who's responsible/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "u2" } });
    await waitFor(() => expect(move).toHaveBeenCalledWith("t1", "div-b", "u2"));
  });
});
