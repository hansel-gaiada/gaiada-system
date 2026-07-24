import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GroupRegistry, type BotGroupConfig, type BotGroupsSnapshot, type GroupsActionState } from "./GroupRegistry";

function snapshot(overrides: Partial<BotGroupsSnapshot> = {}): BotGroupsSnapshot {
  return {
    registryActive: true,
    groups: [
      { id: "111@g.us", name: "Ops", category: "internal", isManagement: false },
      { id: "222@g.us", name: "Client A", category: "client", isManagement: true },
    ],
    discovered: [{ id: "333@g.us", name: "New Group", firstSeenAt: "2026-07-24T00:00:00Z" }],
    managementGroupId: "222@g.us",
    ...overrides,
  };
}

async function ok(): Promise<GroupsActionState> {
  return { ok: true };
}

describe("GroupRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the limited-access note when not elevated, without rendering any table", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated={false} initial={snapshot()} action={action} />);
    expect(screen.getByText(/limited to superadmins\/owners/i)).toBeInTheDocument();
    expect(screen.queryByText("Ops")).not.toBeInTheDocument();
  });

  it("shows an empty note when the bot admin API hasn't connected (initial=null)", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={null} action={action} />);
    expect(screen.getByText(/appears once the bot admin api is connected/i)).toBeInTheDocument();
  });

  it("renders the monitored-groups table and the discovered list", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);
    expect(screen.getByDisplayValue("Ops")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Client A")).toBeInTheDocument();
    expect(screen.getByText("New Group")).toBeInTheDocument();
    // The current management group is pre-selected.
    expect(screen.getByRole("radio", { name: "Set Client A as the management group" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Set Ops as the management group" })).not.toBeChecked();
  });

  it("adds a discovered group to the table with one click, and removes it from discovered", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByDisplayValue("New Group")).toBeInTheDocument();
    expect(screen.getByText(/no newly-discovered groups/i)).toBeInTheDocument();
  });

  it("switching the management radio clears it on every other row", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    fireEvent.click(screen.getByRole("radio", { name: "Set Ops as the management group" }));

    expect(screen.getByRole("radio", { name: "Set Ops as the management group" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Set Client A as the management group" })).not.toBeChecked();
  });

  it("removing a row drops it from the Save payload", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove group Ops" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(action).toHaveBeenCalledTimes(1);
    const payload = action.mock.calls[0][0];
    expect(payload).toEqual([{ id: "222@g.us", name: "Client A", category: "client", isManagement: true }]);
  });

  it("Save PUTs the full replacement list shape: {id, name, category, isManagement}[]", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    fireEvent.change(screen.getByDisplayValue("Ops"), { target: { value: "Ops Team" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(action).toHaveBeenCalledWith([
      { id: "111@g.us", name: "Ops Team", category: "internal", isManagement: false },
      { id: "222@g.us", name: "Client A", category: "client", isManagement: true },
    ]);
  });

  it("renders a field-level validation error inline on a 400 {error, field} response", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]): Promise<GroupsActionState> => ({
      ok: false,
      error: "name exceeds 200 chars",
      field: "name",
    }));
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(screen.getByText(/name exceeds 200 chars/)).toBeInTheDocument();
    expect(screen.getByText(/field: name/)).toBeInTheDocument();
  });

  it("renders a generic error without a field suffix when none is given", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]): Promise<GroupsActionState> => ({
      ok: false,
      error: "The bot isn't reachable right now — try again shortly.",
    }));
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(screen.getByText(/bot isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/field:/)).not.toBeInTheDocument();
  });
});
