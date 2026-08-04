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

  it("an ordinary staff address is never mistaken for a client", () => {
    for (const e of ["pm@gaiada.com", "owner@gaiada.com", "dewi@gaiada.com"]) {
      expect(demoIdentityFor(e)).toBe("demo-hansel");
    }
  });
});
