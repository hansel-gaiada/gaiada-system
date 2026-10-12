import { describe, expect, it } from "vitest";
import { hubTabHref, isHubTabActive } from "./clientHubNav";

describe("isHubTabActive (PV3-05: segment-boundary matching)", () => {
  const id = "cl-1";

  it("lights a tab on its own route", () => {
    expect(isHubTabActive("/clients/cl-1/work", id, "work")).toBe(true);
    expect(isHubTabActive("/clients/cl-1/notes", id, "notes")).toBe(true);
  });

  it("lights a tab for a route nested under it", () => {
    expect(isHubTabActive("/clients/cl-1/profile/finance", id, "profile")).toBe(true);
    expect(isHubTabActive("/clients/cl-1/work/anything", id, "work")).toBe(true);
  });

  it("does NOT light /work for /workshop (a bare prefix is not a segment)", () => {
    expect(isHubTabActive("/clients/cl-1/workshop", id, "work")).toBe(false);
    expect(isHubTabActive("/clients/cl-1/workshop/x", id, "work")).toBe(false);
    expect(isHubTabActive("/clients/cl-1/contacts-archive", id, "contacts")).toBe(false);
  });

  it("matches the Overview exactly and never on another tab's route", () => {
    expect(isHubTabActive("/clients/cl-1", id, "")).toBe(true);
    expect(isHubTabActive("/clients/cl-1/", id, "")).toBe(true);
    expect(isHubTabActive("/clients/cl-1/work", id, "")).toBe(false);
  });

  it("ignores a query string, a hash and a trailing slash", () => {
    expect(isHubTabActive("/clients/cl-1/work/?q=1", id, "work")).toBe(true);
    expect(isHubTabActive("/clients/cl-1/work#meetings", id, "work")).toBe(true);
  });

  it("does not light a tab for another client's route", () => {
    expect(isHubTabActive("/clients/cl-2/work", id, "work")).toBe(false);
    expect(isHubTabActive("/clients/cl-10/work", "cl-1", "work")).toBe(false);
  });

  it("builds hrefs", () => {
    expect(hubTabHref(id, "")).toBe("/clients/cl-1");
    expect(hubTabHref(id, "notes")).toBe("/clients/cl-1/notes");
  });
});

describe("PV4-09: the conversation thread page keeps Projects lit", () => {
  it("lights the Projects tab (and only it) for a thread under /work/conversation", () => {
    const path = "/clients/cl-1/work/conversation/7f1c2b3a-0000-4000-8000-000000000001";
    expect(isHubTabActive(path, "cl-1", "work")).toBe(true);
    expect(isHubTabActive(path, "cl-1", "")).toBe(false);
    expect(isHubTabActive(path, "cl-1", "billing")).toBe(false);
    expect(isHubTabActive(path, "cl-1", "notes")).toBe(false);
  });
});
