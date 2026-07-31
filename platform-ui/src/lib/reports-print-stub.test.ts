import { describe, it, expect } from "vitest";
import { getStubPrintPayload } from "./reports-print-stub";
import { PrintTokenError } from "./reports-print-data";

// TR-20 — this file is a TEST FIXTURE (see reports-print-stub.ts's header comment): it exercises
// the print route's rendering before TR-21's real minting/print-payload endpoint exists. These tests
// pin the fixture's own behaviour, not any real contract.
describe("reports-print-stub — labeled test fixture for exercising the print route pre-TR-21", () => {
  it("an unrecognized token 404s the same way a real un-minted token would", async () => {
    await expect(getStubPrintPayload("not-a-real-token")).rejects.toBeInstanceOf(PrintTokenError);
    await expect(getStubPrintPayload("not-a-real-token")).rejects.toMatchObject({ reason: "not_found" });
  });

  it("every registered grain fixture resolves to a shape usable by the print route", async () => {
    const tokens = [
      "stub-person-unsealed", "stub-person-sealed",
      "stub-project-unsealed", "stub-department-unsealed",
      "stub-company-unsealed", "stub-company-sealed",
    ];
    for (const token of tokens) {
      const payload = await getStubPrintPayload(token);
      expect(payload.document.header).toBeTruthy();
      expect(Array.isArray(payload.document.kpis)).toBe(true);
    }
  });

  it("the *-sealed fixtures are actually header.sealed === true, with a sealHash", async () => {
    const person = await getStubPrintPayload("stub-person-sealed");
    expect(person.document.header.sealed).toBe(true);
    expect(person.sealHash).toBeTruthy();

    const company = await getStubPrintPayload("stub-company-sealed");
    expect(company.document.header.sealed).toBe(true);
    expect(company.sealHash).toBeTruthy();
  });

  it("the *-unsealed fixtures are actually header.sealed === false, with no sealHash", async () => {
    const person = await getStubPrintPayload("stub-person-unsealed");
    expect(person.document.header.sealed).toBe(false);
    expect(person.sealHash).toBeUndefined();
  });

  it("grain fixtures carry the grain their token names", async () => {
    expect((await getStubPrintPayload("stub-person-unsealed")).document.header.grain).toBe("person");
    expect((await getStubPrintPayload("stub-project-unsealed")).document.header.grain).toBe("project");
    expect((await getStubPrintPayload("stub-department-unsealed")).document.header.grain).toBe("department");
    expect((await getStubPrintPayload("stub-company-unsealed")).document.header.grain).toBe("company");
  });
});
