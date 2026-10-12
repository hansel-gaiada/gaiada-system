import { describe, it, expect } from "vitest";
import type { CentreListItem } from "./clientCentre";
import {
  clientsHref, inBusinessTypeReview, needsBusinessType, preselectedBusinessType, readCentres, REVIEW_BUSINESS_TYPE,
} from "./clientBusinessType";

const item = (clientId: string, businessType: string): CentreListItem => ({
  clientId, clientName: clientId, clientStatus: "active", businessType, city: null,
  fieldsFilled: { filled: 0, total: 10 }, connectionsConnected: { connected: 0, total: 5 }, updatedAt: null,
});

describe("PV3-04 · business type on the staff side", () => {
  it("'other' and a missing type both need review; a real type does not", () => {
    expect(needsBusinessType("other")).toBe(true);
    expect(needsBusinessType(null)).toBe(true);
    expect(needsBusinessType(undefined)).toBe(true);
    expect(needsBusinessType("")).toBe(true);
    expect(needsBusinessType("hotel")).toBe(false);
  });

  it("the Edit form preselects nothing for a client with no profile row (revision 0), even though the backend reports 'other'", () => {
    expect(preselectedBusinessType({ businessType: "other", revision: 0 })).toBeNull();
    expect(preselectedBusinessType(null)).toBeNull();
    // A row exists: its type is an explicit choice, "other" included.
    expect(preselectedBusinessType({ businessType: "other", revision: 3 })).toBe("other");
    expect(preselectedBusinessType({ businessType: "hotel", revision: 1 })).toBe("hotel");
  });

  it("a readable profile list becomes a map; the review filter keys off it", () => {
    const read = readCentres(3, [item("a", "hotel"), item("b", "other"), item("c", "spa")]);
    expect(read.ok).toBe(true);
    expect(inBusinessTypeReview(read, "a")).toBe(false);
    expect(inBusinessTypeReview(read, "b")).toBe(true);
    // A client the list never mentioned is UNKNOWN, not "not set".
    expect(inBusinessTypeReview(read, "z")).toBe(false);
  });

  it("🔴 the internal sentinel client is never on the review list, whatever the profile list says", () => {
    const read = readCentres(2, [item("a", "other"), item("int", "other")]);
    expect(inBusinessTypeReview(read, "a", false)).toBe(true);
    expect(inBusinessTypeReview(read, "int", true)).toBe(false);
  });

  it("🔴 a failed read is a REFUSAL, never an empty list: thrown, null, or empty for a company that has clients", () => {
    const thrown = readCentres(3, null, new Error("503 upstream"));
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.message).toMatch(/could not be read.*503 upstream/);
    expect(readCentres(3, null).ok).toBe(false);
    expect(readCentres(3, []).ok).toBe(false);
    // With no clients at all an empty profile list is simply true.
    expect(readCentres(0, []).ok).toBe(true);
    // And a refused read puts NOBODY on the review list.
    expect(inBusinessTypeReview(thrown, "a")).toBe(false);
  });

  it("clientsHref keeps the other filters", () => {
    expect(clientsHref({})).toBe("/clients");
    expect(clientsHref({ status: "active" })).toBe("/clients?status=active");
    expect(clientsHref({ status: "prospect", review: true })).toBe(`/clients?status=prospect&review=${REVIEW_BUSINESS_TYPE}`);
    expect(clientsHref({ archived: true, review: true })).toBe(`/clients?archived=1&review=${REVIEW_BUSINESS_TYPE}`);
  });
});
