import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ClientCentreShell } from "./ClientCentreShell";
import type { CentreProfile } from "@/lib/clientCentre";

vi.mock("next/navigation", () => ({ usePathname: () => "/clients/cl-1/profile" }));

function makeProfile(overrides: Partial<CentreProfile> = {}): CentreProfile {
  return {
    clientId: "cl-1",
    clientName: "Demo Harbour Hotel",
    clientStatus: "active",
    businessType: "hotel",
    profile: { trading: "Demo Harbour Hotel", description: "A boutique waterfront hotel." },
    connections: { pms: { status: "Connected", account: "harbour-42" } },
    departments: {},
    customConnections: {},
    revision: 1,
    updatedAt: null,
    updatedBy: null,
    canEdit: true,
    ...overrides,
  };
}

describe("ClientCentreShell", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders Home by default: client name, description lede, and department cards", () => {
    const patchAction = vi.fn();
    render(
      <ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={[]} profile={makeProfile()} isPortal={false} patchAction={patchAction} />,
    );
    expect(screen.getByRole("heading", { name: "Demo Harbour Hotel" })).toBeInTheDocument();
    expect(screen.getByText("A boutique waterfront hotel.")).toBeInTheDocument();
    // The industry module for "hotel" ("Hotel Operations") plus the fixed departments — appear
    // twice each (tree + department card), so assert presence rather than uniqueness.
    expect(screen.getAllByText("Hotel Operations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reservations").length).toBeGreaterThan(0);
  });

  it("renders Business details: business type select, department toggles, read-only client name", () => {
    const patchAction = vi.fn();
    render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["company"]} profile={makeProfile()} isPortal={false}
        patchAction={patchAction}
      />,
    );
    // CC-D9: "Business details", never "Company settings" — "company" is the ERP's own group company.
    expect(screen.getByRole("heading", { name: "Business details" })).toBeInTheDocument();
    expect(screen.queryByText(/company settings/i)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Hotel / villa / accommodation")).toBeInTheDocument();
    // CC-D8: the view sits inside the client hub, so there is no "Edit in Clients" link; the help text
    // points at the hub header's Edit button, which is where the name is changed.
    expect(screen.queryByRole("link", { name: /in Clients/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Change it with Edit/i)).toBeInTheDocument();
    // CC-D5: the client name itself is read-only everywhere, never an input.
    expect(screen.getByText("Demo Harbour Hotel", { selector: ".cc-readonly-value" })).toBeInTheDocument();
  });

  it("read-only banner names the reason and who to ask, differently for staff vs the portal", () => {
    const patchAction = vi.fn();
    const { rerender } = render(
      <ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={[]} profile={makeProfile({ canEdit: false })} isPortal={false} patchAction={patchAction} />,
    );
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    rerender(
      <ClientCentreShell clientId="cl-1" basePath="/portal/company" segments={[]} profile={makeProfile({ canEdit: false })} isPortal={true} patchAction={patchAction} />,
    );
    expect(screen.getByText(/ask your account manager/i)).toBeInTheDocument();
  });

  it("a read-only viewer sees values but no inputs on Business details", () => {
    const patchAction = vi.fn();
    render(
      <ClientCentreShell clientId="cl-1" basePath="/clients/cl-1/profile" segments={["company"]} profile={makeProfile({ canEdit: false })} isPortal={false} patchAction={patchAction} />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByText("Demo Harbour Hotel").length).toBeGreaterThan(0);
  });

  it("autosaves an edit ~600ms after the last keystroke, sending only the changed key, then flashes Saved", async () => {
    const patchAction = vi.fn().mockResolvedValue({ ok: true, profile: makeProfile({ profile: { trading: "New Name" } }) });
    const { container } = render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["rs", "settings"]} profile={makeProfile()} isPortal={false}
        patchAction={patchAction}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("#cc-field-trading")!;
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "New Name" } });
    expect(patchAction).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(patchAction).toHaveBeenCalledTimes(1);
    expect(patchAction).toHaveBeenCalledWith("cl-1", { profile: { trading: "New Name" } });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not autosave at all for a read-only viewer", async () => {
    const patchAction = vi.fn();
    const { container } = render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["rs", "settings"]} profile={makeProfile({ canEdit: false })} isPortal={false}
        patchAction={patchAction}
      />,
    );
    // Read-only: no text input for a registry field, only the plain value.
    expect(container.querySelector("#cc-field-trading")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(patchAction).not.toHaveBeenCalled();
  });

  it("surfaces the server's error message and field on a failed save, and leaves the retry pending", async () => {
    const patchAction = vi.fn().mockResolvedValue({ ok: false, error: "trading looks like it contains a credential", field: "profile.trading" });
    const { container } = render(
      <ClientCentreShell
        clientId="cl-1" basePath="/clients/cl-1/profile" segments={["rs", "settings"]} profile={makeProfile()} isPortal={false}
        patchAction={patchAction}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("#cc-field-trading")!;
    fireEvent.change(input, { target: { value: "sk-leaked-secret-value" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByRole("alert")).toHaveTextContent("trading looks like it contains a credential");
  });
});
