import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { WebsiteAccessRow } from "@/lib/clientWebsiteAccessView";

// WSK-49f — the staff "Website access" panel on a client's Contacts page. The writes are the server
// actions, mocked here: what is pinned is what the panel DOES with each answer (a toggle shows server
// truth, `changed:false` is never an "updated" toast, a 403 makes the list read-only, a 404 drops the row,
// the admin dialogs keep their promises) and what it never shows.
const setEditor = vi.fn();
const setAdmin = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/clientWebsiteAccessActions", () => ({
  setStaffWebsiteEditorAction: (...a: unknown[]) => setEditor(...a),
  setStaffClientAdminAction: (...a: unknown[]) => setAdmin(...a),
  refreshStaffWebsiteAccessAction: (...a: unknown[]) => refresh(...a),
}));

import { ClientWebsiteAccessPanel } from "./ClientWebsiteAccessPanel";

const row = (over: Partial<WebsiteAccessRow> & { contactId: string }): WebsiteAccessRow => ({
  userId: `u-${over.contactId}`, name: null, email: `${over.contactId}@northwind.test`,
  capability: "viewer", status: "active", isAdmin: false, websiteEditor: false, ...over,
});

const DANA = row({ contactId: "c-dana", name: "Dana Whitfield", capability: "signer" });
const ARIA = row({ contactId: "c-aria", name: "Aria Hartono", capability: "admin", isAdmin: true, websiteEditor: true });
const VERA = row({ contactId: "c-vera", name: "Vera Santoso", capability: "viewer" });
const CL = "cl-1";

function mount(over: Partial<React.ComponentProps<typeof ClientWebsiteAccessPanel>> = {}) {
  return render(
    <ClientWebsiteAccessPanel
      clientId={CL}
      clientName="Northwind Traders"
      initial={{ kind: "ok", contacts: [DANA, ARIA, VERA] }}
      canManageEditor
      canManageAdmin
      {...over}
    />,
  );
}

beforeEach(() => {
  setEditor.mockReset();
  setAdmin.mockReset();
  refresh.mockReset();
});

describe("what a manager sees", () => {
  it("each client-wide contact shows its capability and a Website editor switch named for the person", () => {
    mount();
    for (const who of ["Dana Whitfield", "Aria Hartono", "Vera Santoso"]) {
      expect(screen.getByRole("switch", { name: `Website editor: ${who}` })).toBeInTheDocument();
    }
    const list = screen.getByRole("list", { name: /website access for northwind traders/i });
    expect(within(list).getByText("Admin")).toBeInTheDocument();
    expect(within(list).getByText("Signer")).toBeInTheDocument();
    expect(within(list).getByText("Viewer")).toBeInTheDocument();
    // The stored state is what the switch shows.
    expect(screen.getByRole("switch", { name: "Website editor: Aria Hartono" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" })).not.toBeChecked();
  });

  it("says plainly that a project-limited contact is not listed and can't edit the website", () => {
    mount();
    expect(screen.getByText(/only contacts who cover the whole client are listed/i)).toBeInTheDocument();
    expect(screen.getByText(/limited to one\s+project can.t edit the website/i)).toBeInTheDocument();
  });

  it("offers Make admin to a non-admin and Remove admin to an admin, each naming the person", () => {
    mount();
    expect(screen.getByRole("button", { name: "Make admin: Dana Whitfield" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove admin: Aria Hartono" })).toBeInTheDocument();
  });

  it("falls back to the email when a contact has no name", () => {
    mount({ initial: { kind: "ok", contacts: [row({ contactId: "c-x" })] } });
    expect(screen.getByRole("switch", { name: "Website editor: c-x@northwind.test" })).toBeInTheDocument();
  });
});

describe("the website-editor switch", () => {
  it("granting calls the action with the client and contact ids and NOTHING else, then shows the server's answer", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: true, websiteEditor: true });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" })).toBeChecked());
    expect(setEditor).toHaveBeenCalledTimes(1);
    expect(setEditor).toHaveBeenCalledWith({ clientId: CL, contactId: "c-dana", grant: true });
    expect(screen.getByRole("status")).toHaveTextContent("Website access given to Dana Whitfield.");
  });

  it("revoking calls with grant:false and says it was removed", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: true, websiteEditor: false });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Aria Hartono" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Website editor: Aria Hartono" })).not.toBeChecked());
    expect(setEditor).toHaveBeenCalledWith({ clientId: CL, contactId: "c-aria", grant: false });
    expect(screen.getByRole("status")).toHaveTextContent("Website access removed from Aria Hartono.");
  });

  it("changed:false is reported as nothing changed: no 'given', no 'removed', no 'updated'", async () => {
    setEditor.mockResolvedValue({ ok: true, changed: false, websiteEditor: true });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/already has website access, so nothing changed/i));
    expect(screen.getByRole("status").textContent).not.toMatch(/given|removed|updated|saved/i);
    // It shows what the server says is stored, which is "on".
    expect(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" })).toBeChecked();
  });

  it("a second click while the first is in flight does not send a second write", async () => {
    let resolve!: (v: unknown) => void;
    setEditor.mockReturnValue(new Promise((r) => { resolve = r; }));
    mount();
    const sw = screen.getByRole("switch", { name: "Website editor: Dana Whitfield" });
    fireEvent.click(sw);
    fireEvent.click(sw);
    expect(setEditor).toHaveBeenCalledTimes(1);
    expect(sw).toHaveAttribute("aria-busy", "true");
    // Not the `disabled` attribute: that would throw keyboard focus off the control.
    expect(sw).not.toBeDisabled();
    resolve({ ok: true, changed: true, websiteEditor: true });
    await waitFor(() => expect(sw).not.toHaveAttribute("aria-busy"));
  });

  it("a refused write (400) leaves the switch where it was and says nothing was changed", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "refused", message: "Website access is for people who cover the whole account." });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/cover the whole account\. Nothing was changed\./));
    expect(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" })).not.toBeChecked();
  });

  it("a thrown action (network) is an honest error, not a frozen switch", async () => {
    setEditor.mockRejectedValue(new Error("fetch failed"));
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not reach the server\. Nothing was changed/i));
    expect(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" })).not.toHaveAttribute("aria-busy");
  });
});

describe("a 403 renders a plain read-only list", () => {
  it("the BFF refusing a write removes every control and keeps the facts", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "forbidden", message: "You can't change this." });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" }));
    await waitFor(() => expect(screen.queryAllByRole("switch")).toHaveLength(0));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // The facts remain, as text.
    expect(screen.getByText("Dana Whitfield")).toBeInTheDocument();
    expect(screen.getByText(/website editor: yes/i)).toBeInTheDocument(); // Aria
    expect(screen.getAllByText(/website editor: no/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/this list is read-only for you/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/don.t have permission/i);
  });

  it("a viewer the UI mirror already knows may not manage never gets a control", () => {
    mount({ canManageEditor: false, canManageAdmin: false });
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/takes a company admin or manager/i)).toBeInTheDocument();
  });

  it("a manager gets the switches but no admin buttons (manage_admin has no manager rule)", () => {
    mount({ canManageAdmin: false });
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /admin:/i })).toBeNull();
    expect(screen.getByText(/making someone an admin takes a company admin/i)).toBeInTheDocument();
  });

  it("a 403 on the admin route alone hides the admin buttons and keeps the switches", async () => {
    setAdmin.mockResolvedValue({ ok: false, kind: "forbidden", message: "You can't change this." });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /admin:/i })).toBeNull());
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent(/only a company admin can change who is an admin/i);
  });
});

describe("a 404 means the contact is gone", () => {
  it("drops the row and re-reads the list", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "not_found", message: "That contact no longer exists." });
    refresh.mockResolvedValue({ kind: "ok", contacts: [ARIA] });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Vera Santoso" }));
    await waitFor(() => expect(screen.queryByRole("switch", { name: "Website editor: Vera Santoso" })).toBeNull());
    expect(refresh).toHaveBeenCalledWith(CL);
    // The refreshed list is the truth: Dana is gone too.
    await waitFor(() => expect(screen.queryByText("Dana Whitfield")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent(/Vera Santoso is no longer a contact here, so the list has been refreshed/);
  });

  it("if the re-read fails it still drops the row and says the rest may be out of date", async () => {
    setEditor.mockResolvedValue({ ok: false, kind: "not_found", message: "gone" });
    refresh.mockResolvedValue({ kind: "unavailable", reason: "502" });
    mount();
    fireEvent.click(screen.getByRole("switch", { name: "Website editor: Vera Santoso" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not be refreshed, so it may be out of date/));
    expect(screen.queryByText("Vera Santoso")).toBeNull();
    expect(screen.getByText("Dana Whitfield")).toBeInTheDocument();
  });
});

describe("Make admin", () => {
  it("opens a dialog that explains what admin is, and does nothing until confirmed", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    const dialog = screen.getByRole("dialog", { name: "Make Dana Whitfield an admin?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText(/Can sign, and can give colleagues website access/)).toBeInTheDocument();
    expect(setAdmin).not.toHaveBeenCalled();
  });

  it("confirming calls the action to make admin, then shows Admin and the success message", async () => {
    setAdmin.mockResolvedValue({ ok: true, changed: true, capability: "admin" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove admin: Dana Whitfield" })).toBeInTheDocument());
    expect(setAdmin).toHaveBeenCalledWith({ clientId: CL, contactId: "c-dana", grant: true, to: undefined });
    expect(screen.getByRole("status")).toHaveTextContent("Dana Whitfield is now an admin.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changed:false (already admin) is not reported as a change", async () => {
    setAdmin.mockResolvedValue({ ok: true, changed: false, capability: "admin" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/was already an admin, so nothing changed/));
    expect(screen.getByRole("status").textContent).not.toMatch(/is now an admin/);
  });

  it("Cancel closes without a call, and Escape does too", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setAdmin).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog and restores it to the button that opened it", () => {
    mount();
    const opener = screen.getByRole("button", { name: "Make admin: Dana Whitfield" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab: from the last control it wraps to the first, and Shift+Tab from the first wraps to the last", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Make admin: Dana Whitfield" }));
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("Remove admin", () => {
  it("asks which capability to keep, with Viewer selected by default", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove admin: Aria Hartono" }));
    const dialog = screen.getByRole("dialog", { name: "Remove admin from Aria Hartono?" });
    const viewer = within(dialog).getByRole("radio", { name: /viewer/i });
    const signer = within(dialog).getByRole("radio", { name: /signer/i });
    expect(viewer).toBeChecked();
    expect(signer).not.toBeChecked();
    expect(within(dialog).getByText(/we don.t remember what they had before/i)).toBeInTheDocument();
  });

  it("confirming with the default sends to:'viewer' and shows the contact as Viewer", async () => {
    setAdmin.mockResolvedValue({ ok: true, changed: true, capability: "viewer" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove admin: Aria Hartono" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove admin" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Make admin: Aria Hartono" })).toBeInTheDocument());
    expect(setAdmin).toHaveBeenCalledWith({ clientId: CL, contactId: "c-aria", grant: false, to: "viewer" });
    expect(screen.getByRole("status")).toHaveTextContent("Aria Hartono is no longer an admin and is now a Viewer.");
  });

  it("choosing Signer sends to:'signer'", async () => {
    setAdmin.mockResolvedValue({ ok: true, changed: true, capability: "signer" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove admin: Aria Hartono" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /signer/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove admin" }));
    await waitFor(() => expect(setAdmin).toHaveBeenCalledTimes(1));
    expect(setAdmin).toHaveBeenCalledWith({ clientId: CL, contactId: "c-aria", grant: false, to: "signer" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/now a Signer/));
  });

  it("the choice resets to Viewer each time the dialog opens (it never remembers a past Signer)", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove admin: Aria Hartono" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("radio", { name: /signer/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove admin: Aria Hartono" }));
    expect(within(screen.getByRole("dialog")).getByRole("radio", { name: /viewer/i })).toBeChecked();
  });

  it("removing an admin leaves their website-editor switch alone (a separate grant)", async () => {
    setAdmin.mockResolvedValue({ ok: true, changed: true, capability: "viewer" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove admin: Aria Hartono" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove admin" }));
    await waitFor(() => expect(setAdmin).toHaveBeenCalled());
    expect(screen.getByRole("switch", { name: "Website editor: Aria Hartono" })).toBeChecked();
    expect(setEditor).not.toHaveBeenCalled();
  });
});

describe("states that are not a list", () => {
  it("a refused read (403) says so; it is not an empty list", () => {
    mount({ initial: { kind: "forbidden" } });
    expect(screen.getByText(/you don.t have access to who has website access/i)).toBeInTheDocument();
    expect(screen.queryByText(/no contact covers/i)).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("an unavailable read says it cannot tell, which is not a statement that nobody has access", () => {
    mount({ initial: { kind: "unavailable", reason: "502 bad gateway" } });
    expect(screen.getByText(/this is not a statement that there is nothing here/i)).toBeInTheDocument();
    expect(screen.getByText("502 bad gateway")).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("a genuinely empty list says nobody can be given access yet, and why", () => {
    mount({ initial: { kind: "ok", contacts: [] } });
    expect(screen.getByText(/no contact covers the whole client yet/i)).toBeInTheDocument();
  });

  it("the status line is a polite live region and is always in the document", () => {
    mount();
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).not.toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-seeds when the server hands down a new list (e.g. after a revoke on the other panel)", () => {
    const { rerender } = mount();
    rerender(
      <ClientWebsiteAccessPanel
        clientId={CL}
        clientName="Northwind Traders"
        initial={{ kind: "ok", contacts: [ARIA] }}
        canManageEditor
        canManageAdmin
      />,
    );
    // A revoked contact disappears.
    expect(screen.queryByText("Dana Whitfield")).toBeNull();
    expect(screen.getByText("Aria Hartono")).toBeInTheDocument();
  });

  it("an invited contact is labelled as not signed in yet", () => {
    mount({ initial: { kind: "ok", contacts: [row({ contactId: "c-m", name: "Marco Halim", status: "invited" })] } });
    expect(screen.getByText(/invited, not signed in yet/i)).toBeInTheDocument();
  });
});
