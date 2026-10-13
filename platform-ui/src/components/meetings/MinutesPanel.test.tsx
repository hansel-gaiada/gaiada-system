import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinutesPanel, type MinutesActions } from "./MinutesPanel";
import type { MeetingMinutes, MinutesView } from "@/lib/meetingMinutes";

const minutes = (over: Partial<MeetingMinutes> = {}): MeetingMinutes => ({
  id: "mm1", bodyMd: "Decisions: ship Friday.", status: "draft", draftedBy: null, updatedBy: "u1", createdAt: "2026-10-13T08:00:00Z",
  updatedAt: "2026-10-13T08:00:00Z", sharedAt: null, sharedBy: null, sharedByName: null, clientVisible: false, ...over,
});
const view = (over: Partial<MinutesView> = {}): MinutesView => ({
  meetingId: "rec1", clientId: "cl-1", projectId: null, title: "Kickoff", shareable: true, minutes: minutes(), ...over,
});

function actionsStub(over: Partial<MinutesActions> = {}): MinutesActions {
  return {
    save: vi.fn().mockImplementation(async (_id: string, bodyMd: string) => ({ ok: true, view: view({ minutes: minutes({ bodyMd }) }) })),
    share: vi.fn().mockResolvedValue({
      ok: true,
      view: view({ minutes: minutes({ status: "shared", sharedAt: "2026-10-13T09:30:00Z", sharedBy: "u1", sharedByName: "Clement Hansel", clientVisible: true }) }),
    }),
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("MinutesPanel: draft", () => {
  it("saves as a draft with the typed text, and says the client cannot see it yet", async () => {
    const actions = actionsStub();
    render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={view()} canWrite actions={actions} />);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "Decisions: ship Friday.\nOwner: Dana." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(actions.save).toHaveBeenCalledWith("rec1", "Decisions: ship Friday.\nOwner: Dana."));
    expect(await screen.findByText(/The client can't see it yet/)).toBeInTheDocument();
    expect(actions.share).not.toHaveBeenCalled();
  });

  it("marks a draft Internal from the backend field, and says nothing when the field is missing", () => {
    const noField = view();
    delete (noField.minutes as Partial<MeetingMinutes>).clientVisible;
    const { unmount } = render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={view()} canWrite actions={actionsStub()} />);
    expect(screen.getByText("Internal")).toBeInTheDocument();
    unmount();
    render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={noField} canWrite actions={actionsStub()} />);
    expect(screen.queryByText("Internal")).not.toBeInTheDocument();
    expect(screen.queryByText("Client sees this")).not.toBeInTheDocument();
  });
});

describe("MinutesPanel: Share with client", () => {
  it("asks first, naming the client, and shares nothing until confirmed", async () => {
    const actions = actionsStub();
    render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={view()} canWrite actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Share with client" }));
    const dialog = await screen.findByRole("dialog", { name: /Share these minutes with Northwind Traders\?/ });
    expect(within(dialog).getByText(/can't be edited or taken back/)).toBeInTheDocument();
    expect(actions.share).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(actions.share).not.toHaveBeenCalled();
  });

  it("after confirming, shows Shared on <date> by <name> and the editor is read-only", async () => {
    const actions = actionsStub();
    render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={view()} canWrite actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Share with client" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Share with Northwind Traders" }));
    await waitFor(() => expect(actions.share).toHaveBeenCalledWith("rec1"));
    expect(await screen.findByText(/Shared on .* by Clement Hansel/)).toBeInTheDocument();
    expect(screen.getByLabelText("Minutes")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share with client" })).not.toBeInTheDocument();
    // the marker is the backend's clientVisible:true
    expect(screen.getByText("Client sees this")).toBeInTheDocument();
  });

  it("minutes that were already shared open frozen", () => {
    const shared = view({ minutes: minutes({ status: "shared", sharedAt: "2026-10-12T09:00:00Z", sharedByName: "Priya", clientVisible: true }) });
    render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={shared} canWrite actions={actionsStub()} />);
    expect(screen.getByText(/Shared on .* by Priya/)).toBeInTheDocument();
    expect(screen.getByLabelText("Minutes")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /Save draft|Share with client/ })).not.toBeInTheDocument();
  });

  it("is not offered at all when the meeting has no client", () => {
    render(<MinutesPanel meetingId="rec1" clientName="the client" initial={view({ clientId: null, shareable: false })} canWrite actions={actionsStub()} />);
    expect(screen.queryByRole("button", { name: "Share with client" })).not.toBeInTheDocument();
    expect(screen.getByText(/no client, so its minutes stay internal/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeInTheDocument();
  });

  it("is not offered for blank minutes, nor while there are unsaved changes", () => {
    const { unmount } = render(<MinutesPanel meetingId="rec1" clientName="X" initial={view({ minutes: null })} canWrite actions={actionsStub()} />);
    expect(screen.queryByRole("button", { name: "Share with client" })).not.toBeInTheDocument();
    unmount();
    render(<MinutesPanel meetingId="rec1" clientName="X" initial={view()} canWrite actions={actionsStub()} />);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "changed" } });
    expect(screen.getByRole("button", { name: "Share with client" })).toBeDisabled();
    expect(screen.getByText(/Save the draft before sharing it/)).toBeInTheDocument();
  });

  it("a save refused with 409 because the minutes were shared meanwhile says so", async () => {
    const actions = actionsStub({ save: vi.fn().mockResolvedValue({ ok: false, error: "These minutes were already shared with the client, so they can no longer be changed." }) });
    render(<MinutesPanel meetingId="rec1" clientName="Northwind Traders" initial={view()} canWrite actions={actions} />);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "late edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already shared/);
  });

  it("a reader without write access gets a read-only editor and no buttons", () => {
    render(<MinutesPanel meetingId="rec1" clientName="X" initial={view()} canWrite={false} actions={actionsStub()} />);
    expect(screen.getByLabelText("Minutes")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /Save draft|Share with client/ })).not.toBeInTheDocument();
  });
});
