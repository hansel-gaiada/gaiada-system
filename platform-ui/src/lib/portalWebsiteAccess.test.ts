import { describe, expect, it } from "vitest";
import { NO_WEBSITE_ACCESS_COPY, pickWebsiteClient, websiteEditorClients, type RoleGrant } from "./portalWebsiteAccess";

const editor = (clientId: string): RoleGrant => ({ role: "client_website_editor", scopeType: "client", scopeId: clientId });
const client: RoleGrant = { role: "client", scopeType: "company", scopeId: "co-1" };

describe("websiteEditorClients (nav visibility and the page guard)", () => {
  it("a client contact WITHOUT the grant sees nothing", () => {
    expect(websiteEditorClients([client], ["c1"])).toEqual([]);
  });
  it("the grant for the active client shows the area", () => {
    expect(websiteEditorClients([client, editor("c1")], ["c1"])).toEqual(["c1"]);
  });
  it("a grant for a client that is NOT one of this company's clients does not count (it belongs to another company's portal)", () => {
    expect(websiteEditorClients([client, editor("elsewhere")], ["c1"])).toEqual([]);
  });
  it("a grant of the right role but the wrong scope kind does not count", () => {
    expect(websiteEditorClients([{ role: "client_website_editor", scopeType: "company", scopeId: "c1" }], ["c1"])).toEqual([]);
    expect(websiteEditorClients([{ role: "client_website_editor", scopeType: "global", scopeId: null }], ["c1"])).toEqual([]);
  });
  it("another role scoped to the client is not the website-editor grant", () => {
    expect(websiteEditorClients([{ role: "manager", scopeType: "client", scopeId: "c1" }], ["c1"])).toEqual([]);
  });
  it("a staff viewer (staff roles only) sees nothing", () => {
    expect(websiteEditorClients([{ role: "platform_admin", scopeType: "global", scopeId: null }, { role: "manager", scopeType: "company", scopeId: "co-1" }], ["c1"])).toEqual([]);
  });
  it("keeps the scope's order, drops duplicates, and survives null/undefined", () => {
    expect(websiteEditorClients([editor("c2"), editor("c1"), editor("c2")], ["c1", "c2", "c1"])).toEqual(["c1", "c2"]);
    expect(websiteEditorClients(null, null)).toEqual([]);
    expect(websiteEditorClients(undefined, ["c1"])).toEqual([]);
  });
});

describe("pickWebsiteClient", () => {
  it("no access is null", () => { expect(pickWebsiteClient([], "c1")).toBeNull(); });
  it("honours the remembered client only when the viewer may edit its website", () => {
    expect(pickWebsiteClient(["c1", "c2"], "c2")).toBe("c2");
    expect(pickWebsiteClient(["c1", "c2"], "c3")).toBe("c1");
    expect(pickWebsiteClient(["c1"], null)).toBe("c1");
  });
});

it("the no-access page copy is the exact words the owner's brief gives", () => {
  expect(NO_WEBSITE_ACCESS_COPY).toBe("You don't have website editing access. Ask your company's admin.");
});
