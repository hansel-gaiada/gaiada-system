import { describe, it, expect } from "vitest";
import type { Me } from "./platform";
import { STATIC_PALETTE_ENTRIES, staticPaletteEntries } from "./palette";
import { AGENCY, HOTEL, ROOT, me, member } from "./workspaceFixtures";

// DW-9d: the explicit, gated entries that replaced the classic nav's "today" list. Each gate is the one its nav row had.
const hrefsOf = (m: Me, tenant: string) => staticPaletteEntries(m, tenant).map((e) => e.href);
const grant = (role: string, co = "co-a") => ({ role, scopeType: "company", scopeId: co });

describe("staticPaletteEntries", () => {
  it("offers the ungated pages to every staff person, in every kind of company", () => {
    const ungated = ["/approvals", "/reports/project", "/reports/department", "/learning"];
    for (const [m, t] of [
      [me([member()]), "co-a"],
      [me([member("co-h")], [HOTEL]), "co-h"],
      [me([member("co-root")], [ROOT]), "co-root"],
      [me([]), "co-a"],
    ] as [Me, string][]) {
      for (const href of ungated) expect(hrefsOf(m, t), href).toContain(href);
    }
  });

  it("gives every entry an id, a label, a section and an icon, and a unique href", () => {
    const entries = staticPaletteEntries(me([{ role: "platform_admin", scopeType: "global", scopeId: null }], [ROOT, AGENCY]), "co-a");
    expect(entries).toHaveLength(STATIC_PALETTE_ENTRIES.length);
    expect(new Set(entries.map((e) => e.href)).size).toBe(entries.length);
    for (const e of entries) expect(e).toMatchObject({ id: `static:${e.href}`, label: expect.any(String), section: expect.any(String), icon: expect.any(String) });
  });

  it("Learning authoring needs lms.authoring, as the nav row did: absent for a member, present for a company admin", () => {
    expect(hrefsOf(me([member()]), "co-a")).not.toContain("/learning/authoring");
    expect(hrefsOf(me([member(), grant("company_admin")]), "co-a")).toContain("/learning/authoring");
    expect(hrefsOf(me([{ role: "platform_admin", scopeType: "global", scopeId: null }]), "co-a")).toContain("/learning/authoring");
  });

  it("Learning compliance needs lms.progress.view: HR staff have it and not authoring, a member neither", () => {
    expect(hrefsOf(me([member()]), "co-a")).not.toContain("/learning/compliance");
    const hr = hrefsOf(me([member(), grant("hr_staff")]), "co-a");
    expect(hr).toContain("/learning/compliance");
    expect(hr).not.toContain("/learning/authoring");
  });

  it("reads the ACTIVE company: a right held only in another company does not offer the entry here", () => {
    const m = me([member(), grant("company_admin", "co-h")], [AGENCY, HOTEL]);
    expect(hrefsOf(m, "co-a")).not.toContain("/learning/authoring");
    expect(hrefsOf(m, "co-h")).toContain("/learning/authoring");
  });
});
