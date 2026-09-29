import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  diffForActivity, normalizeContactCreate, normalizeContactPatch, normalizeName, normalizeNoteBody,
  normalizeOwner, normalizeStatus, NOTE_MAX,
} from "./client-input";

const bad = (fn: () => unknown) => expect(fn).toThrow(BadRequestException);

describe("client-input (CC-D10)", () => {
  it("name: trimmed; blank, non-string and over-long refused", () => {
    expect(normalizeName("  Harbour  ")).toBe("Harbour");
    bad(() => normalizeName("   "));
    bad(() => normalizeName(42));
    bad(() => normalizeName("x".repeat(201)));
  });

  it("status: a lowercase token; a typo like 'Active ' cannot mint a new facet", () => {
    expect(normalizeStatus("prospect")).toBe("prospect");
    expect(normalizeStatus(" archived ")).toBe("archived");
    bad(() => normalizeStatus("Active"));
    bad(() => normalizeStatus("on hold"));
    bad(() => normalizeStatus(""));
  });

  it("owner: undefined = unchanged, null/'' = clear, a uuid = set, anything else refused", () => {
    expect(normalizeOwner(undefined)).toBeUndefined();
    expect(normalizeOwner(null)).toBeNull();
    expect(normalizeOwner("")).toBeNull();
    expect(normalizeOwner("0192f3a4-5b6c-7d8e-9f01-23456789abcd")).toBe("0192f3a4-5b6c-7d8e-9f01-23456789abcd");
    bad(() => normalizeOwner("u-1; DROP TABLE"));
    bad(() => normalizeOwner(7));
  });

  it("contact patch: strings set (trimmed), null and blank delete, emails are checked", () => {
    expect(normalizeContactPatch({ email: " a@b.co ", phone: null, address: "", billingName: "  " })).toEqual({
      set: { email: "a@b.co" },
      remove: ["phone", "address", "billingName"],
    });
    bad(() => normalizeContactPatch({ billingEmail: "nope" }));
    bad(() => normalizeContactPatch({ phone: 12 }));
    bad(() => normalizeContactPatch({ "bad key": "x" }));
    bad(() => normalizeContactPatch([]));
    bad(() => normalizeContactPatch(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"]))));
  });

  it("contact create: blanks dropped, same checks as patch", () => {
    expect(normalizeContactCreate(undefined)).toEqual({});
    expect(normalizeContactCreate({ email: "a@b.co", phone: "" })).toEqual({ email: "a@b.co" });
    bad(() => normalizeContactCreate({ email: "x" }));
  });

  it("note body: trimmed, not blank, capped", () => {
    expect(normalizeNoteBody("  hi ")).toBe("hi");
    bad(() => normalizeNoteBody(" "));
    bad(() => normalizeNoteBody("x".repeat(NOTE_MAX + 1)));
  });

  it("diffForActivity lists only fields that changed, with contact keys spelled out", () => {
    const before = { name: "A", status: "active", owner_user_id: null, contact: { email: "a@b.co", fax: "1" } };
    const after = { name: "A2", status: "active", owner_user_id: "u-2", contact: { email: "a@b.co", phone: "9" } };
    expect(diffForActivity(before, after)).toEqual([
      { field: "name", before: "A", after: "A2" },
      { field: "owner", before: null, after: "u-2" },
      { field: "contact.fax", before: "1", after: null },
      { field: "contact.phone", before: null, after: "9" },
    ]);
    expect(diffForActivity(before, before)).toEqual([]);
  });
});
