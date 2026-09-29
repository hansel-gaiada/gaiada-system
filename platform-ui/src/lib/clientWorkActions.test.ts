import { describe, it, expect, vi, beforeEach } from "vitest";

// The client write actions (CC-D10). What is pinned:
//   - the gate is `client.write` (ordinary staff), not `pm.manage` (managers) — resource_client.yaml
//     lets members create and edit, and the UI used to hide both from them;
//   - the form sends EVERY contact key it owns, blanks as null, so the backend's key-level merge
//     clears a field the user emptied while never touching keys the form does not render;
//   - New client passes the chosen status (the backend used to drop it).
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-agency") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a) }));
const granted = new Set<string>();
vi.mock("./rbac", () => ({ can: vi.fn((_me: unknown, cap: string) => granted.has(cap)) }));
vi.mock("./platform", () => ({
  getMe: vi.fn(async () => ({ id: "u-1", companies: [{ id: "co-agency" }] })),
  PlatformError: class PlatformError extends Error { constructor(public status: number, message: string) { super(message); } },
}));
const updateClient = vi.fn();
const createClient = vi.fn();
const createClientNote = vi.fn();
vi.mock("./entities", async () => {
  const actual = await vi.importActual<typeof import("./entities")>("./entities");
  return {
    CLIENT_CONTACT_KEYS: actual.CLIENT_CONTACT_KEYS,
    updateClient: (...a: unknown[]) => updateClient(...a),
    createClient: (...a: unknown[]) => createClient(...a),
    createClientNote: (...a: unknown[]) => createClientNote(...a),
    deleteClient: vi.fn(), deleteClientNote: vi.fn(), createDeliverable: vi.fn(), createTimeEntry: vi.fn(),
  };
});

import { updateClientAction, createClientAction, addClientNoteAction } from "./clientWorkActions";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  updateClient.mockReset().mockResolvedValue({ id: "cl-1" });
  createClient.mockReset().mockResolvedValue({ id: "cl-new" });
  createClientNote.mockReset().mockResolvedValue({ id: "n-1" });
  redirect.mockReset();
  granted.clear();
  granted.add("client.write");
});

describe("updateClientAction", () => {
  it("sends name, status, owner and every contact key — blanks as null for the backend merge", async () => {
    await updateClientAction("cl-1", null, fd({
      name: "  New Name ", status: "prospect", ownerUserId: "u-9",
      email: "new@x.co", phone: "", address: "Jl. Raya 1", billingName: "", billingEmail: "",
    }));
    expect(updateClient).toHaveBeenCalledWith("u-1", "co-agency", "cl-1", {
      name: "New Name", status: "prospect", ownerUserId: "u-9",
      contact: { email: "new@x.co", phone: null, address: "Jl. Raya 1", billingName: null, billingEmail: null },
    });
    expect(redirect).toHaveBeenCalledWith("/clients/cl-1");
  });

  it("an empty owner select means no owner (null), not 'unchanged'", async () => {
    await updateClientAction("cl-1", null, fd({ name: "A", ownerUserId: "" }));
    expect(updateClient.mock.calls[0][3].ownerUserId).toBeNull();
  });

  it("a staff member with client.write but not pm.manage may edit", async () => {
    expect(granted.has("pm.manage")).toBe(false);
    await updateClientAction("cl-1", null, fd({ name: "A" }));
    expect(updateClient).toHaveBeenCalledTimes(1);
  });

  it("refuses a blank name, bad emails, and a caller without client.write — writing nothing", async () => {
    expect(await updateClientAction("cl-1", null, fd({ name: "  " }))).toEqual({ error: "Client name is required." });
    expect(await updateClientAction("cl-1", null, fd({ name: "A", email: "nope" }))).toEqual({ error: "That email address doesn't look right." });
    expect(await updateClientAction("cl-1", null, fd({ name: "A", billingEmail: "nope" }))).toEqual({ error: "That billing email doesn't look right." });
    granted.clear();
    expect((await updateClientAction("cl-1", null, fd({ name: "A" }))).error).toMatch(/permission/);
    expect(updateClient).not.toHaveBeenCalled();
  });
});

describe("createClientAction", () => {
  it("passes the chosen status, owner and only the filled-in contact keys", async () => {
    await createClientAction(null, fd({ name: "Villa", status: "prospect", ownerUserId: "u-9", email: "a@b.co", phone: "" }));
    expect(createClient).toHaveBeenCalledWith("u-1", "co-agency", {
      name: "Villa", status: "prospect", ownerUserId: "u-9", contact: { email: "a@b.co" },
    });
    expect(redirect).toHaveBeenCalledWith("/clients/cl-new");
  });
});

describe("addClientNoteAction", () => {
  it("adds a trimmed note; blank and unauthorised are refused", async () => {
    expect(await addClientNoteAction("cl-1", null, fd({ body: "  Prefers WhatsApp " }))).toEqual({});
    expect(createClientNote).toHaveBeenCalledWith("u-1", "co-agency", "cl-1", "Prefers WhatsApp");
    expect(await addClientNoteAction("cl-1", null, fd({ body: " " }))).toEqual({ error: "Write something first." });
    granted.clear();
    expect((await addClientNoteAction("cl-1", null, fd({ body: "x" }))).error).toMatch(/permission/);
    expect(createClientNote).toHaveBeenCalledTimes(1);
  });
});
