import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PortalStartConversation } from "./PortalStartConversation";
import { generalClientChoices } from "@/lib/portal";

// The server actions import next/headers + the session, and the form pushes to the new thread; none of that exists in
// jsdom and none of it is under test here. This suite is render-only, like PortalChangeRequestForm's.
vi.mock("@/lib/portalActions", () => ({ portalStartConversation: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// PV4-13 — "Start a conversation" offers General PER CLIENT. The contact below is client-wide on Northwind (c-a) and
// limited to one project on Contoso (c-b): the server's `generalClientIds` is ["c-a"], so General exists for Northwind
// only and the form must never offer, name or submit Contoso's.
const PROJECTS = [
  { id: "p-a", name: "Northwind site" },
  { id: "p-b1", name: "Contoso site" },
];
const profileClients = [{ id: "c-a", name: "Northwind" }, { id: "c-b", name: "Contoso" }];
const clientIdInputs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name="clientId"]')];

describe("PortalStartConversation — General is per client", () => {
  it("client-wide on A, project-scoped on B: General is offered for A only, and B's General is never named", () => {
    const generalClients = generalClientChoices(["c-a"], profileClients);
    const { container } = render(<PortalStartConversation projects={PROJECTS} generalClients={generalClients} />);
    const where = screen.getByLabelText(/what is it about/i) as HTMLSelectElement;
    expect([...where.options].map((o) => o.value)).toEqual(["", "p-a", "p-b1"]);
    expect(screen.getByRole("option", { name: /general/i })).toBeInTheDocument();
    // No picker (only one General client), so Contoso cannot be chosen for General anywhere...
    expect(screen.queryByLabelText(/which of your companies/i)).not.toBeInTheDocument();
    // ...and the one client General would be sent for is Northwind, explicitly, not left to the server's default.
    const named = clientIdInputs(container);
    expect(named).toHaveLength(1);
    expect(named[0].value).toBe("c-a");
    expect(container.innerHTML).not.toContain("c-b");
  });

  it("client-wide on several clients: a picker lists exactly those clients, and only those", () => {
    const generalClients = generalClientChoices(["c-a", "c-c"], [...profileClients, { id: "c-c", name: "Fabrikam" }]);
    render(<PortalStartConversation projects={PROJECTS} generalClients={generalClients} />);
    const picker = screen.getByLabelText(/which of your companies/i) as HTMLSelectElement;
    expect([...picker.options].map((o) => [o.value, o.textContent])).toEqual([["c-a", "Northwind"], ["c-c", "Fabrikam"]]);
    expect([...picker.options].map((o) => o.value)).not.toContain("c-b");
  });

  it("client-wide on no client: no General option at all, and the project list is what is left", () => {
    const { container } = render(<PortalStartConversation projects={PROJECTS} generalClients={[]} />);
    const where = screen.getByLabelText(/what is it about/i) as HTMLSelectElement;
    expect([...where.options].map((o) => o.value)).toEqual(["p-a", "p-b1"]);
    expect(screen.queryByRole("option", { name: /general/i })).not.toBeInTheDocument();
    expect(clientIdInputs(container)).toHaveLength(0);
  });

  it("client-wide on no client and no project: explains that there is nowhere to start one", () => {
    render(<PortalStartConversation projects={[]} generalClients={[]} />);
    expect(screen.getByText(/no project on your account/i)).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("preselects the project from ?project= when it is one of the caller's, else General when they have it", () => {
    const generalClients = generalClientChoices(["c-a"], profileClients);
    const { unmount } = render(<PortalStartConversation projects={PROJECTS} generalClients={generalClients} defaultProjectId="p-b1" />);
    expect((screen.getByLabelText(/what is it about/i) as HTMLSelectElement).value).toBe("p-b1");
    unmount();
    render(<PortalStartConversation projects={PROJECTS} generalClients={generalClients} defaultProjectId="not-mine" />);
    expect((screen.getByLabelText(/what is it about/i) as HTMLSelectElement).value).toBe("");
  });
});
