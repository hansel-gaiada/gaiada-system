import { describe, it, expect, vi, beforeEach } from "vitest";

// WSK-49f — what the STAFF and PORTAL write actions put on the wire. Pinned: the exact path and method
// (the role is a literal in the path, the scope is the client in the path), NO role/scope/permission field
// in any body, the admin removal's explicit `to` defaulting to viewer, ids that cannot change the route, and
// the mapping of each refusal (403 / 404 / 400) and of `changed:false`.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-agency") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-portal" })) }));
const { platformFetch, PlatformError } = vi.hoisted(() => ({
  platformFetch: vi.fn(),
  PlatformError: class PlatformError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock("./platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1" })),
  platformFetch,
  PlatformError,
}));
vi.mock("./clientWebsiteAccess", () => ({
  getStaffWebsiteAccess: vi.fn(async () => ({ kind: "ok", contacts: [] })),
  getPortalWebsiteAccess: vi.fn(async () => ({ kind: "ok", contacts: [] })),
}));

import {
  refreshStaffWebsiteAccessAction,
  setStaffClientAdminAction,
  setStaffWebsiteEditorAction,
} from "./clientWebsiteAccessActions";
import { refreshPortalWebsiteAccessAction, setPortalWebsiteEditorAction } from "./portalWebsiteAccessActions";
import { getPortalWebsiteAccess, getStaffWebsiteAccess } from "./clientWebsiteAccess";

const CL = "11111111-1111-4111-8111-111111111111";
const CT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  platformFetch.mockReset().mockResolvedValue({ websiteEditor: true, changed: true });
});

describe("staff: website editor", () => {
  it("grants with PUT on the literal website-editor path, in the staff tenant, with NO body", async () => {
    const r = await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true });
    expect(platformFetch).toHaveBeenCalledWith(
      `/api/co-agency/clients/${CL}/contacts/${CT}/website-editor`, "u-1", { method: "PUT" },
    );
    expect(r).toEqual({ ok: true, changed: true, websiteEditor: true });
  });

  it("revokes with DELETE, still no body", async () => {
    platformFetch.mockResolvedValue({ websiteEditor: false, changed: true });
    const r = await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: false });
    expect(platformFetch.mock.calls[0][2]).toEqual({ method: "DELETE" });
    expect(r).toEqual({ ok: true, changed: true, websiteEditor: false });
  });

  it("passes `changed:false` through, and a missing `changed` counts as NOT changed", async () => {
    platformFetch.mockResolvedValue({ websiteEditor: true, changed: false });
    expect(await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: true, changed: false });
    platformFetch.mockResolvedValue({ websiteEditor: true });
    expect(await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: true, changed: false });
  });

  it("maps 403 / 404 / 400 / 500 to distinct kinds", async () => {
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: false, kind: "forbidden" });
    platformFetch.mockRejectedValueOnce(new PlatformError(404, "contact not found for this client"));
    expect(await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: false, kind: "not_found" });
    platformFetch.mockRejectedValueOnce(new PlatformError(400, "website_editor_is_client_wide: this contact row is scoped to one project"));
    const refused = await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true });
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(refused.ok === false && refused.message).toMatch(/one project/);
    platformFetch.mockRejectedValueOnce(new PlatformError(500, "boom"));
    expect(await setStaffWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: false, kind: "error" });
  });

  it("refuses an id that could change the route, without calling the BFF", async () => {
    for (const bad of ["../x", "a/b", "a?b=1", "a%2Fb", "", "a.b"]) {
      const r = await setStaffWebsiteEditorAction({ clientId: CL, contactId: bad, grant: true });
      expect(r).toMatchObject({ ok: false, kind: "error" });
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

describe("staff: admin", () => {
  it("make admin is a PUT with no body", async () => {
    platformFetch.mockResolvedValue({ capability: "admin", changed: true });
    const r = await setStaffClientAdminAction({ clientId: CL, contactId: CT, grant: true });
    expect(platformFetch).toHaveBeenCalledWith(`/api/co-agency/clients/${CL}/contacts/${CT}/admin`, "u-1", { method: "PUT" });
    expect(r).toEqual({ ok: true, changed: true, capability: "admin" });
  });

  it("remove admin sends ONLY {to}, defaulting to viewer", async () => {
    platformFetch.mockResolvedValue({ capability: "viewer", changed: true });
    await setStaffClientAdminAction({ clientId: CL, contactId: CT, grant: false });
    expect(platformFetch.mock.calls[0][2]).toEqual({ method: "DELETE", body: JSON.stringify({ to: "viewer" }) });
  });

  it("remove admin keeping signer sends {to:'signer'}", async () => {
    platformFetch.mockResolvedValue({ capability: "signer", changed: true });
    const r = await setStaffClientAdminAction({ clientId: CL, contactId: CT, grant: false, to: "signer" });
    expect(platformFetch.mock.calls[0][2]).toEqual({ method: "DELETE", body: JSON.stringify({ to: "signer" }) });
    expect(r).toMatchObject({ ok: true, capability: "signer" });
  });

  it("refuses a target that is not signer or viewer before any call", async () => {
    const r = await setStaffClientAdminAction({ clientId: CL, contactId: CT, grant: false, to: "admin" as never });
    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("a 403 on the admin route is a forbidden result", async () => {
    platformFetch.mockRejectedValue(new PlatformError(403, "forbidden"));
    expect(await setStaffClientAdminAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("refresh re-reads the staff list in the staff tenant", async () => {
    await refreshStaffWebsiteAccessAction(CL);
    expect(getStaffWebsiteAccess).toHaveBeenCalledWith("u-1", "co-agency", CL);
  });
});

describe("portal: website editor only", () => {
  it("grants on the portal path, in the PORTAL company, with no body and nothing else", async () => {
    const r = await setPortalWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true });
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(platformFetch).toHaveBeenCalledWith(
      `/api/co-portal/portal/clients/${CL}/contacts/${CT}/website-editor`, "u-1", { method: "PUT" },
    );
    expect(r).toEqual({ ok: true, changed: true, websiteEditor: true });
  });

  it("revoke is DELETE on the same path", async () => {
    platformFetch.mockResolvedValue({ websiteEditor: false, changed: true });
    await setPortalWebsiteEditorAction({ clientId: CL, contactId: CT, grant: false });
    expect(platformFetch.mock.calls[0][0]).toBe(`/api/co-portal/portal/clients/${CL}/contacts/${CT}/website-editor`);
    expect(platformFetch.mock.calls[0][2]).toEqual({ method: "DELETE" });
  });

  it("ignores any role / scope / capability smuggled into the input: there is nowhere to put it", async () => {
    await setPortalWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true, role: "company_admin", scope: "global", capability: "admin" } as never);
    const [path, , init] = platformFetch.mock.calls[0];
    expect(path).not.toMatch(/admin|role|scope/);
    expect(init).toEqual({ method: "PUT" });
    expect(init.body).toBeUndefined();
  });

  it("shows the BFF's self-grant refusal in plain words, and a 403 as forbidden, a 404 as not_found", async () => {
    platformFetch.mockRejectedValueOnce(new PlatformError(400, "self_grant_forbidden: a principal may not grant a role to themselves"));
    const refused = await setPortalWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true });
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(refused.ok === false && refused.message).toMatch(/yourself/);
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "not a contact of this client"));
    expect(await setPortalWebsiteEditorAction({ clientId: CL, contactId: CT, grant: true })).toMatchObject({ ok: false, kind: "forbidden" });
    platformFetch.mockRejectedValueOnce(new PlatformError(404, "contact not found for this client"));
    expect(await setPortalWebsiteEditorAction({ clientId: CL, contactId: CT, grant: false })).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("refuses a route-changing id without calling the BFF", async () => {
    expect(await setPortalWebsiteEditorAction({ clientId: "../staff", contactId: CT, grant: true })).toMatchObject({ ok: false });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("refresh uses the portal reader and the portal company", async () => {
    await refreshPortalWebsiteAccessAction(CL);
    expect(getPortalWebsiteAccess).toHaveBeenCalledWith("u-1", "co-portal", CL);
  });
});
