import { describe, expect, it } from "vitest";
import { describeAccess, groupPeople, splitProjects } from "@/lib/portalPeople";
import type { PortalProfile } from "@/lib/portal";

const contact = (id: string, side?: "client" | "provider", projectId: string | null = null): PortalProfile["contacts"][number] =>
  ({ id, name: id, email: `${id}@x.test`, capability: "viewer", status: "active", clientId: "c1", projectId, side });

describe("splitProjects", () => {
  it("splits on finished: true, false and undefined (undefined is active)", () => {
    const { active, past } = splitProjects([
      { id: "a", finished: false },
      { id: "b", finished: true },
      { id: "c" },
    ]);
    expect(active.map((p) => p.id)).toEqual(["a", "c"]);
    expect(past.map((p) => p.id)).toEqual(["b"]);
  });
  it("ignores status entirely", () => {
    const { active, past } = splitProjects([
      { id: "a", status: "completed", finished: false },
      { id: "b", status: "active", finished: true },
    ]);
    expect(active.map((p) => p.id)).toEqual(["a"]);
    expect(past.map((p) => p.id)).toEqual(["b"]);
  });
  it("handles an empty list", () => {
    expect(splitProjects([])).toEqual({ active: [], past: [] });
  });
});

describe("groupPeople", () => {
  const clients = [
    { id: "c1", name: "One", status: "active", contact: {}, projectCount: 1, accountManager: { name: "Am", email: "am@x.test" } },
    { id: "c2", name: "Two", status: "active", contact: {}, projectCount: 0, accountManager: null },
    { id: "c3", name: "Three", status: "active", contact: {}, projectCount: 0 },
  ];
  it("groups contacts by side, with undefined side as client", () => {
    const g = groupPeople({ clients, contacts: [contact("a", "client"), contact("b", "provider"), contact("c")] });
    expect(g.yourPeople.map((c) => c.id)).toEqual(["a", "c"]);
    expect(g.onOurSide.map((c) => c.id)).toEqual(["b"]);
  });
  it("emits an account manager line only for clients that have one", () => {
    const g = groupPeople({ clients, contacts: [] });
    expect(g.accountManagers).toEqual([{ clientId: "c1", clientName: "One", name: "Am", email: "am@x.test" }]);
  });
  it("leaves onOurSide empty when no provider contact exists", () => {
    expect(groupPeople({ clients, contacts: [contact("a")] }).onOurSide).toEqual([]);
  });
});

describe("describeAccess", () => {
  it("reads capability and scope", () => {
    expect(describeAccess({ capability: "signer", projectId: null })).toEqual({ capability: "Can sign", scope: "Whole account" });
    expect(describeAccess({ capability: "viewer", projectId: "p" })).toEqual({ capability: "View only", scope: "One project" });
    // WSK-49f: an admin implies signer (owner ruling 2026-10-11), so the People page says they can sign.
    expect(describeAccess({ capability: "admin", projectId: null })).toEqual({ capability: "Admin, can sign", scope: "Whole account" });
  });
});
