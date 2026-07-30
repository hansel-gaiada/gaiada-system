import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GroupRegistry, type BotGroupConfig, type BotGroupsSnapshot, type GroupsActionState } from "./GroupRegistry";

function snapshot(overrides: Partial<BotGroupsSnapshot> = {}): BotGroupsSnapshot {
  return {
    registryActive: true,
    groups: [
      { id: "111@g.us", name: "Ops", category: "internal", optIn: true, isManagement: false },
      { id: "222@g.us", name: "Client A", category: "client", optIn: false, isManagement: true },
    ],
    discovered: [{ id: "333@g.us", name: "New Group", firstSeenAt: "2026-07-24T00:00:00Z" }],
    managementGroupId: "222@g.us",
    ignored: [],
    ...overrides,
  };
}

async function ok(): Promise<GroupsActionState> {
  return { ok: true };
}

function ignoreOk() {
  return vi.fn(async (_ids: string[]) => ok());
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

  it("falls back to the JID when the bot hasn't resolved a group's subject yet", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(
      <GroupRegistry
        elevated
        initial={snapshot({ discovered: [{ id: "444@g.us", name: "", firstSeenAt: 0 }] })}
        action={action}
      />,
    );

    // A nameless entry must never render as a blank row next to an Add button.
    expect(screen.getByText("444@g.us")).toBeInTheDocument();

    // ...and adding it seeds the registry row with the JID, not an empty name.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByDisplayValue("444@g.us")).toBeInTheDocument();
  });

  it("warns that saving the first entry switches the bot out of trial mode", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(
      <GroupRegistry
        elevated
        initial={snapshot({
          registryActive: false,
          groups: [],
          discovered: [
            { id: "333@g.us", name: "New Group", firstSeenAt: 0 },
            { id: "444@g.us", name: "Another", firstSeenAt: 0 },
          ],
        })}
        action={action}
      />,
    );

    // Nothing staged yet -> no warning.
    expect(screen.queryByText(/turns the registry on/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
    expect(screen.getByText(/turns the registry on/i)).toBeInTheDocument();
    expect(screen.getByText(/only the groups listed here/i)).toBeInTheDocument();
    // One discovered group is left behind, so the copy is singular.
    expect(screen.getByText(/the other\s+discovered group\s+will/i)).toBeInTheDocument();
  });

  it("does not warn when the registry is already active", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot({ registryActive: true })} action={action} />);
    expect(screen.queryByText(/turns the registry on/i)).not.toBeInTheDocument();
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
    expect(payload).toEqual([
      { id: "222@g.us", name: "Client A", category: "client", optIn: false, isManagement: true },
    ]);
  });

  it("Save PUTs the full replacement list shape: {id, name, category, optIn, isManagement}[]", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);

    fireEvent.change(screen.getByDisplayValue("Ops"), { target: { value: "Ops Team" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(action).toHaveBeenCalledWith([
      // optIn MUST survive a round-trip: the bot's PUT is a full replace, so dropping it here
      // silently disabled per-group digest post-back.
      { id: "111@g.us", name: "Ops Team", category: "internal", optIn: true, isManagement: false },
      { id: "222@g.us", name: "Client A", category: "client", optIn: false, isManagement: true },
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

  it("explains monitored vs ignored so an operator knows the difference before touching anything", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} ignoreAction={ignoreOk()} />);
    expect(screen.getByText(/never read/i)).toBeInTheDocument();
    expect(screen.getByText(/even in trial mode/i)).toBeInTheDocument();
  });

  it("lists already-ignored groups from the snapshot, with an Un-ignore button each", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(
      <GroupRegistry
        elevated
        initial={snapshot({ ignored: [{ id: "999@g.us", name: "Spam Group", firstSeenAt: 0 }] })}
        action={action}
        ignoreAction={ignoreOk()}
      />,
    );
    expect(screen.getByText("Spam Group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Un-ignore Spam Group" })).toBeInTheDocument();
  });

  it("staging Ignore on a discovered row removes it from Discovered and adds it to Ignored", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} ignoreAction={ignoreOk()} />);

    expect(screen.getByText(/no ignored groups/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ignore New Group" }));

    expect(screen.getByText(/no newly-discovered groups/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Un-ignore New Group" })).toBeInTheDocument();
  });

  it("Un-ignore drops the id from the staged ignore list", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(
      <GroupRegistry
        elevated
        initial={snapshot({ ignored: [{ id: "999@g.us", name: "Spam Group", firstSeenAt: 0 }] })}
        action={action}
        ignoreAction={ignoreOk()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Un-ignore Spam Group" }));

    expect(screen.getByText(/no ignored groups/i)).toBeInTheDocument();
    expect(screen.queryByText("Spam Group")).not.toBeInTheDocument();
  });

  it("Save ignored list PUTs the full staged id list, independent of the monitored-groups Save", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    const ignoreAction = ignoreOk();
    render(
      <GroupRegistry
        elevated
        initial={snapshot({ ignored: [{ id: "999@g.us", name: "Spam Group", firstSeenAt: 0 }] })}
        action={action}
        ignoreAction={ignoreAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ignore New Group" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save ignored list" }));
    });

    expect(ignoreAction).toHaveBeenCalledTimes(1);
    expect(ignoreAction).toHaveBeenCalledWith(["999@g.us", "333@g.us"]);
    // The monitored-groups action was never touched by saving the ignore list.
    expect(action).not.toHaveBeenCalled();
  });

  it("disables Save ignored list when no ignoreAction prop is wired yet, without crashing", () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    render(<GroupRegistry elevated initial={snapshot()} action={action} />);
    expect(screen.getByRole("button", { name: "Save ignored list" })).toBeDisabled();
  });

  it("renders a field-level error on the ignore save the same way as the groups save", async () => {
    const action = vi.fn(async (_g: BotGroupConfig[]) => ok());
    const ignoreAction = vi.fn(async (_ids: string[]): Promise<GroupsActionState> => ({
      ok: false,
      error: "unknown group id",
      field: "ids",
    }));
    render(<GroupRegistry elevated initial={snapshot()} action={action} ignoreAction={ignoreAction} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save ignored list" }));
    });

    expect(screen.getByText(/unknown group id/)).toBeInTheDocument();
    expect(screen.getByText(/field: ids/)).toBeInTheDocument();
  });
});
