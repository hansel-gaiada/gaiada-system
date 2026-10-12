import { describe, it, expect, vi, beforeEach } from "vitest";

// The client write actions (CC-D10). What is pinned:
//   - the gate is `client.write` (ordinary staff), not `pm.manage` (managers) — resource_client.yaml
//     lets members create and edit, and the UI used to hide both from them;
//   - the form sends EVERY contact key it owns, blanks as null, so the backend's key-level merge
//     clears a field the user emptied while never touching keys the form does not render;
//   - New client passes the chosen status (the backend used to drop it);
//   - PV3-04: a business type is REQUIRED on both New and Edit and never reaches the backend blank, and the
//     group-company field is sent only when the form rendered it (a non-operator's save cannot 403).
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
import { PlatformError } from "./platform";
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
      name: "  New Name ", status: "prospect", ownerUserId: "u-9", businessType: "hotel",
      email: "new@x.co", phone: "", address: "Jl. Raya 1", billingName: "", billingEmail: "",
    }));
    expect(updateClient).toHaveBeenCalledWith("u-1", "co-agency", "cl-1", {
      name: "New Name", status: "prospect", ownerUserId: "u-9", businessType: "hotel",
      contact: { email: "new@x.co", phone: null, address: "Jl. Raya 1", billingName: null, billingEmail: null },
    });
    expect(redirect).toHaveBeenCalledWith("/clients/cl-1");
  });

  it("an empty owner select means no owner (null), not 'unchanged'", async () => {
    await updateClientAction("cl-1", null, fd({ name: "A", ownerUserId: "", businessType: "other" }));
    expect(updateClient.mock.calls[0][3].ownerUserId).toBeNull();
  });

  it("a staff member with client.write but not pm.manage may edit", async () => {
    expect(granted.has("pm.manage")).toBe(false);
    await updateClientAction("cl-1", null, fd({ name: "A", businessType: "other" }));
    expect(updateClient).toHaveBeenCalledTimes(1);
  });

  it("refuses a blank name, bad emails, and a caller without client.write — writing nothing", async () => {
    expect(await updateClientAction("cl-1", null, fd({ name: "  " }))).toEqual({ error: "Client name is required." });
    expect(await updateClientAction("cl-1", null, fd({ name: "A", email: "nope", businessType: "other" }))).toEqual({ error: "That email address doesn't look right." });
    expect(await updateClientAction("cl-1", null, fd({ name: "A", billingEmail: "nope", businessType: "other" }))).toEqual({ error: "That billing email doesn't look right." });
    granted.clear();
    expect((await updateClientAction("cl-1", null, fd({ name: "A" }))).error).toMatch(/permission/);
    expect(updateClient).not.toHaveBeenCalled();
  });

  it("🔴 PV3-04: refuses to save without a business type (a client with no profile row has none preselected), writing nothing", async () => {
    expect(await updateClientAction("cl-1", null, fd({ name: "A" }))).toEqual({ error: "Choose a business type." });
    expect(await updateClientAction("cl-1", null, fd({ name: "A", businessType: "  " }))).toEqual({ error: "Choose a business type." });
    expect((await updateClientAction("cl-1", null, fd({ name: "A", businessType: "pirate-ship" }))).error).toMatch(/isn't one of the listed/);
    expect(updateClient).not.toHaveBeenCalled();
  });

  it("PV3-04: groupCompanyId is sent only when the form rendered it; a blank value clears the link", async () => {
    await updateClientAction("cl-1", null, fd({ name: "A", businessType: "hotel" }));
    expect(updateClient.mock.calls[0][3]).not.toHaveProperty("groupCompanyId");
    await updateClientAction("cl-1", null, fd({ name: "A", businessType: "hotel", groupCompanyId: "co-sib" }));
    expect(updateClient.mock.calls[1][3].groupCompanyId).toBe("co-sib");
    await updateClientAction("cl-1", null, fd({ name: "A", businessType: "hotel", groupCompanyId: "" }));
    expect(updateClient.mock.calls[2][3].groupCompanyId).toBeNull();
  });

  it("PV3-04: the platform's typed refusals read as sentences", async () => {
    updateClient.mockRejectedValueOnce(new PlatformError(400, "group_company_other_root"));
    expect((await updateClientAction("cl-1", null, fd({ name: "A", businessType: "hotel", groupCompanyId: "co-x" }))).error)
      .toMatch(/different group/);
    updateClient.mockRejectedValueOnce(new PlatformError(403, "linking a client to a group company needs a platform operator"));
    expect((await updateClientAction("cl-1", null, fd({ name: "A", businessType: "hotel", groupCompanyId: "co-x" }))).error)
      .toMatch(/platform operator/);
  });
});

describe("createClientAction", () => {
  it("passes the chosen status, owner and only the filled-in contact keys", async () => {
    await createClientAction(null, fd({ name: "Villa", businessType: "hotel", status: "prospect", ownerUserId: "u-9", email: "a@b.co", phone: "" }));
    expect(createClient).toHaveBeenCalledWith("u-1", "co-agency", {
      name: "Villa", businessType: "hotel", status: "prospect", ownerUserId: "u-9", contact: { email: "a@b.co" },
    });
    expect(redirect).toHaveBeenCalledWith("/clients/cl-new");
  });

  it("🔴 PV3-04: refuses a missing or unknown business type and creates nothing", async () => {
    expect(await createClientAction(null, fd({ name: "Villa" }))).toEqual({ error: "Choose a business type." });
    expect((await createClientAction(null, fd({ name: "Villa", businessType: "pirate-ship" }))).error).toMatch(/isn't one of the listed/);
    expect(createClient).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("PV3-04: 'other' is a valid explicit choice, and the group company is sent only when offered", async () => {
    await createClientAction(null, fd({ name: "Villa", businessType: "other" }));
    expect(createClient.mock.calls[0][2]).toMatchObject({ businessType: "other" });
    expect(createClient.mock.calls[0][2]).not.toHaveProperty("groupCompanyId");
    await createClientAction(null, fd({ name: "Sibling", businessType: "hotel", groupCompanyId: "co-sib" }));
    expect(createClient.mock.calls[1][2].groupCompanyId).toBe("co-sib");
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
