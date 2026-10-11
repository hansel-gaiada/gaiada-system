import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { WebsiteAccessRow } from "@/lib/clientWebsiteAccessView";

// WSK-49f — the client ADMIN's "Website access" card on the portal People page. Pinned: one switch per
// colleague, named for the person; the calls carry the client and contact ids and no role/scope/capability;
// a capability can't be changed here at all; the BFF's own answer is shown (self-grant refusal, 404); and a
// 403 HIDES the whole card rather than leaving a dead control.
const setEditor = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/portalWebsiteAccessActions", () => ({
  setPortalWebsiteEditorAction: (...a: unknown[]) => setEditor(...a),
  refreshPortalWebsiteAccessAction: (...a: unknown[]) => refresh(...a),
}));

import { PortalWebsiteAccessCard } from "./PortalWebsiteAccessCard";

const row = (over: Partial<WebsiteAccessRow> & { contactId: string }): WebsiteAccessRow => ({
  userId: `u-${over.contactId}`, name: null, email: `${over.contactId}@northwind.test`,
  capability: "viewer", status: "active", isAdmin: false, websiteEditor: false, ...over,
});

const ARIA = row({ contactId: "c-aria", userId: "u-aria", name: "Aria Hartono", capability: "admin", isAdmin: true });
const DANA = row({ contactId: "c-dana", userId: "u-dana", name: "Dana Whitfield", capability: "signer" });
const VERA = row({ contactId: "c-vera", userId: "u-vera", name: "Vera Santoso", websiteEditor: true });
const CL = "cl-1";

function mount(over: Partial<React.ComponentProps<typeof PortalWebsiteAccessCard>> = {}) {
  return render(
    <PortalWebsiteAccessCard
      clientId={CL}
      clientName="Northwind Traders"
      showClientName={false}
      meUserId="u-aria"
      initial={{ kind: "ok", contacts: [ARIA, DANA, VERA] }}
      {...over}
    />,
  );
}

beforeEach(() => {
  setEditor.mockReset();
  refresh.mockReset();
});

describe("what a client admin sees", () => {
  it("the card, the plain-words explanation and a Website access switch per colleague, named for them", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Website access" })).toBeInTheDocument();
    expect(
      screen.getByText("Website access: lets this person edit and publish your website in this portal."),
    ).toBeInTheDocument();
    for (const who of ["Aria Hartono (you)", "Dana Whitfield", "Vera Santoso"]) {
      expect(screen.getByRole("switch", { name: `Website access for ${who.replace(" (you)", "")}` })).toBeInTheDocument();
    }
    expect(screen.getByRole("switch", { name: "Website access for Vera Santoso" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Website access for Dana Whitfield" })).not.toBeChecked();
    expect(screen.getByText("Aria Hartono (you)")).toBeInTheDocument();
  });

  it("an admin's capability reads 'Admin, can sign'; the card offers NO way to change a capability or a role", () => {
    mount();
    expect(screen.getByText("Admin, can sign")).toBeInTheDocument();
    expect(screen.getByText("Can sign")).toBeInTheDocument();
    expect(screen.getByText("View only")).toBeInTheDocument();
    // The only controls are the switches: no buttons, no selects, no "make admin".
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryByText(/make admin|remove admin/i)).toBeNull();
  });

  it("with several clients, says which one the card is about", () => {
    mount({ showClientName: true });
    expect(screen.getByRole("heading", { name: "Website access: Northwind Traders" })).toBeInTheDocument();
  });
});

describe("granting and removing", () => {
  it("giving a colleague access sends the client and contact ids and grant:true, and NOTHING else", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: true, websiteEditor: true });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Dana Whitfield" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Website access for Dana Whitfield" })).toBeChecked());
    expect(setEditor).toHaveBeenCalledTimes(1);
    const arg = setEditor.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toEqual({ clientId: CL, contactId: "c-dana", grant: true });
    expect(Object.keys(arg).sort()).toEqual(["clientId", "contactId", "grant"]);
    expect(screen.getByRole("status")).toHaveTextContent("Website access given to Dana Whitfield.");
  });

  it("removing access sends grant:false and the person's switch goes off", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: true, websiteEditor: false });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Vera Santoso" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Website access for Vera Santoso" })).not.toBeChecked());
    expect(setEditor).toHaveBeenCalledWith({ clientId: CL, contactId: "c-vera", grant: false });
    expect(screen.getByRole("status")).toHaveTextContent("Website access removed from Vera Santoso.");
  });

  it("changed:false is 'nothing changed', never a confident update", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: false, websiteEditor: false });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Vera Santoso" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/did not have website access, so nothing changed/i));
    expect(screen.getByRole("status").textContent).not.toMatch(/given|removed|updated/i);
  });

  it("granting yourself is whatever the BFF says: its refusal is shown, the switch stays off", async () => {
    setEditor.mockResolvedValue({
      ok: false, kind: "refused",
      message: "You can't give website access to yourself. Ask a colleague who is an admin.",
    });
    mount();
    // The caller's own row is an ordinary row: no client-side rule stops the click.
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Aria Hartono" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/can.t give website access to yourself/i));
    expect(setEditor).toHaveBeenCalledWith({ clientId: CL, contactId: "c-aria", grant: true });
    expect(screen.getByRole("switch", { name: "Website access for Aria Hartono" })).not.toBeChecked();
  });

  it("a self-revoke is allowed through: the call is made with the caller's own contact id", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: false, websiteEditor: false });
    mount({ initial: { kind: "ok", contacts: [{ ...ARIA, websiteEditor: true }, DANA] } });
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Aria Hartono" }));
    await waitFor(() => expect(setEditor).toHaveBeenCalledWith({ clientId: CL, contactId: "c-aria", grant: false }));
  });
});

describe("403 hides the section", () => {
  it("a 403 on a write removes the whole card: no disabled copy of it is left behind", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "forbidden", message: "nope" });
    const { container } = mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Dana Whitfield" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Website access" })).toBeNull());
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("a 403 on the re-read after a 404 hides it too", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "not_found", message: "gone" });
    refresh.mockResolvedValue({ kind: "forbidden" });
    const { container } = mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Dana Whitfield" }));
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});

describe("404: the colleague is gone", () => {
  it("drops the row and refreshes the list", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "not_found", message: "gone" });
    refresh.mockResolvedValue({ kind: "ok", contacts: [ARIA, VERA] });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website access for Dana Whitfield" }));
    await waitFor(() => expect(screen.queryByRole("switch", { name: "Website access for Dana Whitfield" })).toBeNull());
    expect(refresh).toHaveBeenCalledWith(CL);
    expect(screen.getByRole("status")).toHaveTextContent(/Dana Whitfield is no longer a contact here, so the list has been refreshed/);
    expect(screen.getByRole("switch", { name: "Website access for Vera Santoso" })).toBeInTheDocument();
  });
});

describe("unavailable and empty", () => {
  it("an unavailable read is not an empty list: it says it cannot tell", () => {
    mount({ initial: { kind: "unavailable", reason: "503" } });
    expect(screen.getByText(/this is not a statement that there is nothing here/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByText(/nobody on your account can be given/i)).toBeNull();
  });

  it("a genuinely empty list explains who can have website access", () => {
    mount({ initial: { kind: "ok", contacts: [] } });
    expect(screen.getByText(/only people who cover your whole account can have it/i)).toBeInTheDocument();
  });

  it("every message goes to one polite status region", () => {
    mount();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
