import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { StatusSelect } from "./StatusSelect";

// P4-I4 — the chain-enforcement courtesy check must never produce a dead control with no stated
// reason. These pin: a disabled option cannot be selected, the reason is visible (not just a
// hover-only title), and — separately from I4 — the existing P2-05 status-change plumbing keeps
// working once options can carry a `disabled` flag.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const STATUSES = [
  { id: "backlog", label: "Backlog", color: "#111" },
  { id: "todo", label: "ToDo", color: "#222", disabled: true },
  { id: "in_progress", label: "Doing", color: "#333", disabled: true },
  { id: "blocked", label: "Blocked", color: "#444" },
  { id: "done", label: "Done", color: "#555" },
];

describe("StatusSelect", () => {
  it("renders every option enabled, with no hint, when nothing is disabled", () => {
    render(
      <StatusSelect
        current="backlog"
        statuses={STATUSES.map((s) => ({ ...s, disabled: false }))}
        canEdit
        save={vi.fn()}
      />,
    );
    for (const s of STATUSES) {
      expect((screen.getByRole("option", { name: s.label }) as HTMLOptionElement).disabled).toBe(false);
    }
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("disabled options are unselectable AND the reason is visible, not just a hover title", () => {
    render(
      <StatusSelect
        current="backlog"
        statuses={STATUSES}
        canEdit
        save={vi.fn()}
        disabledHint="Blocked by 2 open dependencies — clear them first."
      />,
    );
    expect((screen.getByRole("option", { name: "ToDo (blocked)" }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("option", { name: "Doing (blocked)" }) as HTMLOptionElement).disabled).toBe(true);
    // Backlog/Blocked/Done stay reachable (mirrors reachableStatusIds' own exemptions).
    expect((screen.getByRole("option", { name: "Backlog" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: "Blocked" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option", { name: "Done" }) as HTMLOptionElement).disabled).toBe(false);
    // The reason is stated in the DOM, not merely attached as a hover-only `title` — a disabled
    // control with no explanation reads as a bug, per the ticket's own rule.
    expect(screen.getByRole("note")).toHaveTextContent("Blocked by 2 open dependencies — clear them first.");
  });

  it("no hint renders even with disabled options if the caller passes none (never a silent dead option, but also never a guess)", () => {
    render(<StatusSelect current="backlog" statuses={STATUSES} canEdit save={vi.fn()} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("selecting an enabled option still calls save and refreshes (P2-05 behaviour untouched)", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    render(<StatusSelect current="backlog" statuses={STATUSES} canEdit save={save} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "done" } });
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("done"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("read-only viewers get a plain pill, disabled options irrelevant to them", () => {
    render(<StatusSelect current="backlog" statuses={STATUSES} canEdit={false} save={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });
});
