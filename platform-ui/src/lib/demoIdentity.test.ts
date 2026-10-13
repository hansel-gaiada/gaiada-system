import { describe, it, expect } from "vitest";
import { demoIdentityFor } from "./demoIdentity";

describe("demoIdentityFor — dev-login identity tiers", () => {
  it("resolves the obvious cases", () => {
    expect(demoIdentityFor("seo-staff@gaiada.com")).toBe("seo-staff");
    expect(demoIdentityFor("gede@gaiada.com")).toBe("gede-ic");
    expect(demoIdentityFor("hansel@gaiada.com")).toBe("demo-hansel");
    expect(demoIdentityFor("dana@northwind.example")).toBe("demo-client");
    expect(demoIdentityFor("someone-client@example.com")).toBe("demo-client");
  });

  it("a CLIENT address containing 'ic' is still a client — the ordering this exists to pin", () => {
    // The bug this prevents: "ic" as a substring is extremely common in real names, so testing the IC
    // tier before the client tier would hand external clients the staff dashboard. These addresses all
    // contain "ic" AND identify a client.
    expect(demoIdentityFor("erica@northwind.example")).toBe("demo-client");
    expect(demoIdentityFor("nicole@northwind.example")).toBe("demo-client");
    expect(demoIdentityFor("client-ic@example.com")).toBe("demo-client");
  });

  it("seo-staff wins over both, since its address contains neither token by luck alone", () => {
    // Asserted rather than assumed: if "seo-staff" ever gains an "ic" or "client" substring, the
    // precedence must still hold, and this is the test that would fail.
    expect(demoIdentityFor("seo-staff-client@gaiada.com")).toBe("seo-staff");
  });

  it("is case-insensitive", () => {
    expect(demoIdentityFor("DANA@NORTHWIND.EXAMPLE")).toBe("demo-client");
    expect(demoIdentityFor("SEO-Staff@Gaiada.com")).toBe("seo-staff");
  });

  it("viceroy-marketing resolves to its own identity, not the IC tier its 'ic' substring would give it", () => {
    expect(demoIdentityFor("viceroy-marketing@gaiada.com")).toBe("demo-viceroy-marketing");
    expect(demoIdentityFor("Viceroy-Marketing@Gaiada.com")).toBe("demo-viceroy-marketing");
  });

  it("two-companies resolves to the two-company client, not the generic client", () => {
    expect(demoIdentityFor("two-companies@deity-labs.example")).toBe("demo-two-company-client");
    expect(demoIdentityFor("Two-Companies@Deity-Labs.example")).toBe("demo-two-company-client");
  });

  it("WSK-49f: the Northwind admin and viewer resolve to their own identities, not the generic client", () => {
    expect(demoIdentityFor("admin@northwind.example")).toBe("demo-client-admin");
    expect(demoIdentityFor("ADMIN@Northwind.example")).toBe("demo-client-admin");
    expect(demoIdentityFor("viewer@northwind.example")).toBe("demo-client-viewer");
    // Every other Northwind address is still Dana.
    expect(demoIdentityFor("dana@northwind.example")).toBe("demo-client");
  });

  it("group-owner resolves to the demo owner, while plain owner@ stays an ordinary staff address", () => {
    expect(demoIdentityFor("group-owner@gaiada.com")).toBe("demo-owner");
    expect(demoIdentityFor("Group-Owner@Gaiada.com")).toBe("demo-owner");
  });

  it("an ordinary staff address is never mistaken for a client", () => {
    for (const e of ["pm@gaiada.com", "owner@gaiada.com", "dewi@gaiada.com"]) {
      expect(demoIdentityFor(e)).toBe("demo-hansel");
    }
  });

  it("DW-3a: webdev resolves to u-dev, the person placed in Web Dev, and wins over the IC and client tests", () => {
    expect(demoIdentityFor("webdev@gaiada.com")).toBe("u-dev");
    expect(demoIdentityFor("WebDev@Gaiada.com")).toBe("u-dev");
    // Placed BEFORE the "ic" test: a webdev address that happens to contain "ic" is still u-dev.
    expect(demoIdentityFor("webdev-ic@gaiada.com")).toBe("u-dev");
    // And no existing address changes: gede is still the IC tier, ordinary staff are still demo-hansel.
    expect(demoIdentityFor("gede@gaiada.com")).toBe("gede-ic");
    expect(demoIdentityFor("made@gaiada.com")).toBe("demo-hansel");
  });
});
