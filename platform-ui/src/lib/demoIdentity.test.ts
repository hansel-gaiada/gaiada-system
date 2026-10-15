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

  it("DW-3h: webhead resolves to u-webhead, the head of Web Dev, and moves no other address", () => {
    expect(demoIdentityFor("webhead@gaiada.com")).toBe("u-webhead");
    expect(demoIdentityFor("WebHead@Gaiada.com")).toBe("u-webhead");
    // Before the "ic" test, like webdev: an address with "ic" in it is still the head.
    expect(demoIdentityFor("webhead-ic@gaiada.com")).toBe("u-webhead");
    // The Web Dev employee is a different identity, and so is every other tier.
    expect(demoIdentityFor("webdev@gaiada.com")).toBe("u-dev");
    expect(demoIdentityFor("manager@gaiada.com")).toBe("dept-manager");
    expect(demoIdentityFor("gede@gaiada.com")).toBe("gede-ic");
  });
});

describe("DW-9a: the department persona logins", () => {
  const LOGINS: [string, string][] = [
    ["seo-specialist@gaiada.com", "u-seo"],
    ["social@gaiada.com", "u-social"],
    ["creative@gaiada.com", "u-creative"],
    ["hr-staff@gaiada.com", "u-hr"],
    ["finance-staff@gaiada.com", "u-finance-staff"],
    ["it-admin@gaiada.com", "u-it"],
    ["resort-staff@gaiada.com", "u-resort"],
  ];

  it("each new address resolves to its own identity, never the IC tier, and is case-insensitive", () => {
    for (const [email, id] of LOGINS) {
      expect(demoIdentityFor(email)).toBe(id);
      expect(demoIdentityFor(email.toUpperCase())).toBe(id);
    }
  });

  it("none of the new addresses contains the IC or client token by accident", () => {
    for (const [email] of LOGINS) {
      expect(email.includes("ic")).toBe(false);
      expect(email.includes("client")).toBe(false);
    }
  });

  it("the older addresses still resolve as before", () => {
    expect(demoIdentityFor("seo-staff@gaiada.com")).toBe("seo-staff");
    expect(demoIdentityFor("gede@gaiada.com")).toBe("gede-ic");
    expect(demoIdentityFor("webdev@gaiada.com")).toBe("u-dev");
    expect(demoIdentityFor("webhead@gaiada.com")).toBe("u-webhead");
    expect(demoIdentityFor("manager@gaiada.com")).toBe("dept-manager");
    expect(demoIdentityFor("group-owner@gaiada.com")).toBe("demo-owner");
    expect(demoIdentityFor("viceroy-marketing@gaiada.com")).toBe("demo-viceroy-marketing");
    expect(demoIdentityFor("hansel@gaiada.com")).toBe("demo-hansel");
  });

  it("the plain-word tokens match their exact address only, so another tier keeps its addresses", () => {
    expect(demoIdentityFor("social-manager@gaiada.com")).toBe("dept-manager");
    expect(demoIdentityFor("creative-manager@gaiada.com")).toBe("dept-manager");
  });

  it("a client address that contains a new token is still a client", () => {
    expect(demoIdentityFor("social-client@northwind.example")).toBe("demo-client");
    expect(demoIdentityFor("creative@northwind.example")).toBe("demo-client");
  });
});
