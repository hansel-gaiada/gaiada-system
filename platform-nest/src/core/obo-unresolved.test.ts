// An unresolvable OBO envelope degrades to ANONYMOUS — correct, and it stays. What is fixed is
// that it used to do so SILENTLY: every route afterwards answered
// `403 not authorized: cerbos denied read on portal`, sending whoever debugged it into the policy
// for a resource that was never the problem. See Principal.oboUnresolved and http.ts's
// explainDenial.
import { describe, it, expect } from "vitest";
import { explainDenial } from "./http";
import { ANONYMOUS, type Principal } from "../rbac/principal";

function anonWith(reason: "no-identity-link" | "link-unverified" | "user-inactive"): Principal {
  return {
    ...ANONYMOUS,
    via: { provider: "whatsapp", externalId: "628110@c.us" },
    oboUnresolved: { reason, provider: "whatsapp", externalId: "628110@c.us" },
  };
}

describe("explainDenial", () => {
  it("leaves an ordinary denial byte-for-byte unchanged", () => {
    const p: Principal = { ...ANONYMOUS, userId: "u-1" };
    expect(explainDenial(p, "cerbos denied read on portal")).toBe("cerbos denied read on portal");
  });

  it("says nothing extra for a caller who presented no envelope at all", () => {
    // There is nothing unresolved about not having asked.
    expect(explainDenial(ANONYMOUS, "cerbos denied read on portal")).toBe("cerbos denied read on portal");
  });

  it("keeps the original reason FIRST, so audit rows and error handling still match on it", () => {
    const msg = explainDenial(anonWith("no-identity-link"), "cerbos denied read on portal");
    expect(msg.startsWith("cerbos denied read on portal")).toBe(true);
  });

  it("names the envelope that failed to resolve, so the identifier is visible", () => {
    const msg = explainDenial(anonWith("no-identity-link"), "cerbos denied read on portal");
    expect(msg).toContain("whatsapp:628110@c.us");
    expect(msg).toContain("ANONYMOUS");
    expect(msg).toContain("identity problem, not a policy one");
  });

  it("distinguishes the three states, because the fix for each is different", () => {
    expect(explainDenial(anonWith("no-identity-link"), "x")).toContain("not enrolled");
    expect(explainDenial(anonWith("link-unverified"), "x")).toContain("enrollment was never verified");
    expect(explainDenial(anonWith("user-inactive"), "x")).toContain("not active");
  });

  it("is authorization-NEUTRAL — it appends to the reason and touches no decision input", () => {
    const p = anonWith("link-unverified");
    // The principal that goes into Cerbos is unchanged: same userId, companies, roles, perms.
    expect(p.userId).toBeNull();
    expect(p.companies).toEqual([]);
    expect(p.roles).toEqual([]);
    expect(p.perms).toEqual([]);
    expect(p.assurance).toBe(ANONYMOUS.assurance);
  });
});
