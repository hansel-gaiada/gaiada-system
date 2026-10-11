import { describe, it, expect, beforeEach } from "vitest";
import { portalDashboardDemo } from "./demoPortal";
import { portalCallerContact, resetDemoWebsiteAccess, websiteAccessDemo } from "./demoWebsiteAccess";

// The demo store models the REAL §16i controller's refusals (that is what drives the e2e), so it gets its
// own pins: a fixture that is friendlier than the server makes a browser test pass for the wrong reason.
const T = "co-agency";
const staffList = (u: string) => websiteAccessDemo("GET", `/api/${T}/clients/cl-1/website-access`, u);
const staffEditor = (m: string, u: string, c: string) => websiteAccessDemo(m, `/api/${T}/clients/cl-1/contacts/${c}/website-editor`, u);
const staffAdmin = (m: string, u: string, c: string, body?: string) => websiteAccessDemo(m, `/api/${T}/clients/cl-1/contacts/${c}/admin`, u, body);
const portalList = (u: string) => websiteAccessDemo("GET", `/api/${T}/portal/clients/cl-1/website-access`, u);
const portalEditor = (m: string, u: string, c: string) => websiteAccessDemo(m, `/api/${T}/portal/clients/cl-1/contacts/${c}/website-editor`, u);

beforeEach(() => resetDemoWebsiteAccess());

describe("lists", () => {
  it("lists only client-wide contacts (the project-scoped one is not eligible)", () => {
    const body = staffList("demo-hansel")!.json as { contacts: Array<{ contactId: string }> };
    const ids = body.contacts.map((c) => c.contactId);
    expect(ids).toContain("cc-dana");
    expect(ids).not.toContain("cc-erica");
  });

  it("a staff member without the read grant, and a client, are refused on the staff route", () => {
    expect(staffList("demo-client-admin")!.status).toBe(403);
    expect(staffList("nobody")!.status).toBe(403);
  });

  it("the portal list is for a client ADMIN only: a signer, a viewer and staff are 403", () => {
    expect(portalList("demo-client-admin")!.status).toBe(200);
    expect(portalList("demo-client")!.status).toBe(403);
    expect(portalList("demo-client-viewer")!.status).toBe(403);
    expect(portalList("demo-hansel")!.status).toBe(403);
  });
});

describe("staff writes", () => {
  it("authorizes BEFORE it looks at the contact: a refused caller gets 403 even for an unknown id", () => {
    expect(staffEditor("PUT", "gede-ic", "no-such")!.status).toBe(403);
    expect(staffEditor("PUT", "dept-manager", "no-such")!.status).toBe(404);
  });

  it("grant then grant again: the second is changed:false", () => {
    expect((staffEditor("PUT", "demo-hansel", "cc-dana")!.json as { changed: boolean }).changed).toBe(true);
    expect((staffEditor("PUT", "demo-hansel", "cc-dana")!.json as { changed: boolean }).changed).toBe(false);
    expect((staffEditor("DELETE", "demo-hansel", "cc-dana")!.json as { changed: boolean }).changed).toBe(true);
    expect((staffEditor("DELETE", "demo-hansel", "cc-dana")!.json as { changed: boolean }).changed).toBe(false);
  });

  it("a project-scoped contact cannot be granted", () => {
    const r = staffEditor("PUT", "demo-hansel", "cc-erica")!;
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/website_editor_is_client_wide/);
  });

  it("make admin: a manager is refused (no manager rule), a company admin succeeds, and it is idempotent", () => {
    expect(staffAdmin("PUT", "dept-manager", "cc-dana")!.status).toBe(403);
    expect(staffAdmin("PUT", "demo-hansel", "cc-dana")!.json).toMatchObject({ capability: "admin", changed: true });
    expect(staffAdmin("PUT", "demo-hansel", "cc-dana")!.json).toMatchObject({ capability: "admin", changed: false });
    // The People page reads it from the same store.
    expect(portalCallerContact("demo-client")).toMatchObject({ capability: "admin" });
  });

  it("remove admin takes an explicit target and defaults to viewer", () => {
    expect(staffAdmin("DELETE", "demo-hansel", "cc-aria")!.json).toMatchObject({ capability: "viewer", changed: true });
    staffAdmin("PUT", "demo-hansel", "cc-aria");
    expect(staffAdmin("DELETE", "demo-hansel", "cc-aria", JSON.stringify({ to: "signer" }))!.json).toMatchObject({ capability: "signer", changed: true });
  });

  it("remove admin from someone who is not an admin is a no-op that reports the real capability", () => {
    expect(staffAdmin("DELETE", "demo-hansel", "cc-vera")!.json).toMatchObject({ capability: "viewer", changed: false });
  });

  it("an invalid `to` is a 400", () => {
    expect(staffAdmin("DELETE", "demo-hansel", "cc-aria", JSON.stringify({ to: "admin" }))!.status).toBe(400);
  });
});

describe("portal writes", () => {
  it("only a client admin may grant, and only the website editor", () => {
    expect(portalEditor("PUT", "demo-client", "cc-vera")!.status).toBe(403);
    expect(portalEditor("PUT", "demo-client-viewer", "cc-vera")!.status).toBe(403);
    expect(portalEditor("PUT", "demo-hansel", "cc-vera")!.status).toBe(403);
    expect(portalEditor("PUT", "demo-client-admin", "cc-vera")!.json).toMatchObject({ websiteEditor: true, changed: true });
    // There is no portal route for `admin`.
    expect(websiteAccessDemo("PUT", `/api/${T}/portal/clients/cl-1/contacts/cc-vera/admin`, "demo-client-admin")).toBeNull();
  });

  it("a grant to yourself is refused; a self-revoke is allowed", () => {
    const r = portalEditor("PUT", "demo-client-admin", "cc-aria")!;
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/self_grant_forbidden/);
    expect(portalEditor("DELETE", "demo-client-admin", "cc-aria")!.status).toBe(200);
  });

  it("an unknown contact is a 404; a revoked grant is idempotent", () => {
    expect(portalEditor("PUT", "demo-client-admin", "cc-nobody")!.status).toBe(404);
    expect(portalEditor("DELETE", "demo-client-admin", "cc-vera")!.json).toMatchObject({ changed: false });
  });

  it("a demoted admin immediately loses the portal route", () => {
    staffAdmin("DELETE", "demo-hansel", "cc-aria");
    expect(portalList("demo-client-admin")!.status).toBe(403);
  });
});

describe("the portal profile reads the same store", () => {
  const profile = (u: string) =>
    portalDashboardDemo("GET", `/api/${T}/portal/profile`, u)!.json as {
      me: { id: string }; contacts: Array<{ id: string; capability: string }>;
      access: { canSign: boolean; wholeClient: boolean; grants: Array<{ capability: string }> };
    };

  it("each client persona sees their own capability, and an admin can sign", () => {
    expect(profile("demo-client").access).toMatchObject({ canSign: true, grants: [{ capability: "signer" }] });
    expect(profile("demo-client-admin").access).toMatchObject({ canSign: true, wholeClient: true, grants: [{ capability: "admin" }] });
    expect(profile("demo-client-viewer").access).toMatchObject({ canSign: false, grants: [{ capability: "viewer" }] });
    expect(profile("demo-client-admin").me.id).toBe("demo-client-admin");
  });

  it("contact ids are USER ids, as in the real profile, and follow a staff change", () => {
    expect(profile("demo-client").contacts.map((c) => c.id)).toContain("demo-client-viewer");
    staffAdmin("PUT", "demo-hansel", "cc-vera");
    expect(profile("demo-client").contacts.find((c) => c.id === "demo-client-viewer")?.capability).toBe("admin");
    expect(profile("demo-client-viewer").access.grants[0].capability).toBe("admin");
  });
});
