import { describe, it, expect } from "vitest";
import {
  canManageClientAdmin,
  canManageWebsiteEditor,
  describeRefusal,
  displayName,
  parseWebsiteAccessList,
} from "./clientWebsiteAccessView";
import type { Me } from "./platform";

const me = (roles: Me["roles"]): Me =>
  ({ userId: "u", name: "U", email: "u@x.test", title: null, assurance: "high", companies: [], roles }) as Me;

describe("parseWebsiteAccessList", () => {
  const row = { contactId: "c1", userId: "u1", name: "Dana", email: "d@x.test", capability: "signer", status: "active", isAdmin: false, websiteEditor: true };

  it("reads the documented §16i shape", () => {
    const list = parseWebsiteAccessList({ clientId: "cl", role: "client_website_editor", contacts: [row] });
    expect(list?.contacts).toEqual([{ ...row }]);
  });

  it("derives isAdmin from the capability, not from a separate flag that could disagree", () => {
    const list = parseWebsiteAccessList({ clientId: "cl", contacts: [{ ...row, capability: "admin", isAdmin: false }] });
    expect(list?.contacts[0]).toMatchObject({ capability: "admin", isAdmin: true });
  });

  it("treats a drifted body as unreadable (null), never as an empty list", () => {
    expect(parseWebsiteAccessList(null)).toBeNull();
    expect(parseWebsiteAccessList({ clientId: "cl" })).toBeNull();
    expect(parseWebsiteAccessList({ clientId: "cl", contacts: [{ ...row, capability: "owner" }] })).toBeNull();
    expect(parseWebsiteAccessList({ clientId: "cl", contacts: [{ contactId: "c1" }] })).toBeNull();
  });

  it("only an explicit true counts as a website editor", () => {
    const list = parseWebsiteAccessList({ clientId: "cl", contacts: [{ ...row, websiteEditor: "yes" }] });
    expect(list?.contacts[0].websiteEditor).toBe(false);
  });
});

describe("staff-side mirror of who may manage", () => {
  it("website editor: company_admin, manager, owner (this company) and a global platform_admin", () => {
    expect(canManageWebsiteEditor(me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a")).toBe(true);
    expect(canManageWebsiteEditor(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]), "co-a")).toBe(true);
    expect(canManageWebsiteEditor(me([{ role: "owner", scopeType: "company", scopeId: "co-a" }]), "co-a")).toBe(true);
    expect(canManageWebsiteEditor(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]), "co-a")).toBe(true);
  });

  it("admin: NOT a manager (manage_admin has no manager rule)", () => {
    expect(canManageClientAdmin(me([{ role: "manager", scopeType: "company", scopeId: "co-a" }]), "co-a")).toBe(false);
    expect(canManageClientAdmin(me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), "co-a")).toBe(true);
  });

  it("never for a member, a viewer or a client, nor for another company's admin", () => {
    for (const role of ["member", "viewer", "client", "client_website_editor"]) {
      expect(canManageWebsiteEditor(me([{ role, scopeType: "company", scopeId: "co-a" }]), "co-a")).toBe(false);
    }
    expect(canManageWebsiteEditor(me([{ role: "company_admin", scopeType: "company", scopeId: "co-b" }]), "co-a")).toBe(false);
    expect(canManageWebsiteEditor(me([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]), null)).toBe(false);
  });
});

describe("describeRefusal", () => {
  it("maps the BFF's machine-code prefix to plain words", () => {
    expect(describeRefusal("self_grant_forbidden: a principal may not grant a role to themselves (D-9)")).toMatch(/yourself/);
    expect(describeRefusal("website_editor_is_client_wide: this contact row is scoped to one project")).toMatch(/one project/);
  });
  it("shows an unknown message as the server worded it, never a guess", () => {
    expect(describeRefusal("to must be 'signer' or 'viewer'")).toBe("to must be 'signer' or 'viewer'");
  });
});

describe("displayName", () => {
  it("falls back to the email when there is no name", () => {
    expect(displayName({ name: null, email: "a@x.test" })).toBe("a@x.test");
    expect(displayName({ name: "  ", email: "a@x.test" })).toBe("a@x.test");
    expect(displayName({ name: "Ann", email: "a@x.test" })).toBe("Ann");
  });
});
