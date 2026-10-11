// M5-L1 — data-subject refs derived from the FORM DEFINITION (src/forms/subject-refs.ts), and the DSR
// identifier resolution built on the same normaliser (src/privacy/identifier.ts). Pure: no database.
import { describe, expect, it } from "vitest";
import { deriveSubjectRefs, emailFieldKey, isContactField, normalizePhone, phoneFieldKey } from "../src/forms/subject-refs";
import { hashIdentifier, resolveSubject } from "../src/privacy/identifier";

// gaiada.com's real field ids: `email_address` (audit) and `contact_email` (contact), neither of them `email`.
const CONTACT = {
  fields: [
    { key: "name", type: "text" },
    { key: "contact_email", type: "text", format: "email" },
    { key: "phone", type: "text", format: "tel" },
    { key: "message", type: "textarea" },
  ],
};
const AUDIT = {
  fields: [
    { key: "site_url", type: "text" },
    { key: "email_address", type: "email" },
  ],
};

describe("emailFieldKey / phoneFieldKey", () => {
  it("finds the first field marked format:email (or the form builder's type:email)", () => {
    expect(emailFieldKey(CONTACT)).toBe("contact_email");
    expect(emailFieldKey(AUDIT)).toBe("email_address");
  });
  it("is the FIRST such field in definition order, not the last", () => {
    expect(emailFieldKey({ fields: [{ key: "a", format: "email" }, { key: "b", format: "email" }] })).toBe("a");
  });
  it("reads a JSON-schema `properties` object too, in key order", () => {
    expect(emailFieldKey({ properties: { n: { type: "string" }, work_mail: { type: "string", format: "email" } } })).toBe("work_mail");
    expect(phoneFieldKey({ properties: { mobile: { type: "string", format: "tel" } } })).toBe("mobile");
  });
  it("is null when the definition declares none, and for junk definitions", () => {
    expect(emailFieldKey({ fields: [{ key: "email", type: "text" }] })).toBeNull(); // a NAME is not a declaration
    expect(emailFieldKey({})).toBeNull();
    for (const junk of [null, undefined, "x", 5, [], { fields: "nope" }, { fields: [null, 3, { type: "email" }] }]) {
      expect(emailFieldKey(junk)).toBeNull();
      expect(phoneFieldKey(junk)).toBeNull();
    }
  });
  it("phone: only format:tel (or type:tel); a field merely named `phone` is not one", () => {
    expect(phoneFieldKey(CONTACT)).toBe("phone");
    expect(phoneFieldKey({ fields: [{ key: "phone", type: "text" }] })).toBeNull();
    expect(phoneFieldKey({ fields: [{ key: "wa", type: "tel" }] })).toBe("wa");
  });
});

describe("normalizePhone", () => {
  it("keeps digits only", () => {
    expect(normalizePhone("(415) 555-2671")).toBe("4155552671");
    expect(normalizePhone("0812-3456-7890")).toBe("081234567890");
    expect(normalizePhone("  021 5551234 ")).toBe("0215551234");
  });
  it("drops a leading + or 00: what follows is the country code", () => {
    expect(normalizePhone("+62 812-3456-7890")).toBe("6281234567890");
    expect(normalizePhone("+62812.3456.7890")).toBe("6281234567890");
    expect(normalizePhone("0062 812 3456 7890")).toBe("6281234567890");
    expect(normalizePhone("+1 (415) 555-2671")).toBe("14155552671");
  });
  it("does NOT rewrite a national leading 0 into a country code (no country is hard-wired)", () => {
    expect(normalizePhone("0812 3456 7890")).toBe("081234567890");
    expect(normalizePhone("0812 3456 7890")).not.toBe(normalizePhone("+62 812 3456 7890"));
  });
  it("is null for anything that is not a plausible phone number", () => {
    for (const bad of ["", "   ", "call me", "123456", "1234567890123456", "+", "12ab34567", "08123456789 ext 4", "+62 812 +3456", "a@b.co"]) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });
  it("accepts the 7 and 15 digit boundaries", () => {
    expect(normalizePhone("1234567")).toBe("1234567");
    expect(normalizePhone("+123456789012345")).toBe("123456789012345");
  });
});

describe("deriveSubjectRefs", () => {
  it("gaiada.com contact form: the email ref comes from contact_email, the phone ref from the tel field", () => {
    const refs = deriveSubjectRefs(CONTACT, { name: "Jane", contact_email: "  Jane.Doe@Example.COM ", phone: "+62 812-3456-7890", message: "hi" });
    expect(refs).toEqual({ email: "jane.doe@example.com", phone: "6281234567890" });
  });
  it("gaiada.com audit form: email_address", () => {
    expect(deriveSubjectRefs(AUDIT, { site_url: "https://x.test", email_address: "A@B.co" })).toEqual({ email: "a@b.co", phone: null });
  });
  it("falls back to the legacy `email` key only when the definition declares no email field", () => {
    expect(deriveSubjectRefs({ fields: [{ key: "email", type: "text" }] }, { email: "Old@Style.test" })).toEqual({ email: "old@style.test", phone: null });
    expect(deriveSubjectRefs({}, { email: "old@style.test" }).email).toBe("old@style.test");
  });
  it("does NOT fall back to `email` when an email field IS declared (the declaration wins)", () => {
    const refs = deriveSubjectRefs(CONTACT, { email: "decoy@example.com", name: "x" });
    expect(refs.email).toBeNull();
  });
  it("is null for an absent, empty, or non-string value", () => {
    expect(deriveSubjectRefs(CONTACT, {})).toEqual({ email: null, phone: null });
    expect(deriveSubjectRefs(CONTACT, { contact_email: "   ", phone: "n/a" })).toEqual({ email: null, phone: null });
    expect(deriveSubjectRefs(CONTACT, { contact_email: 5, phone: 5 })).toEqual({ email: null, phone: null });
  });
});

describe("isContactField", () => {
  it("is true for email and tel fields only", () => {
    expect(isContactField(CONTACT, "contact_email")).toBe(true);
    expect(isContactField(CONTACT, "phone")).toBe(true);
    expect(isContactField(CONTACT, "message")).toBe(false);
    expect(isContactField(CONTACT, "nope")).toBe(false);
    expect(isContactField(undefined, "x")).toBe(false);
  });
});

describe("privacy identifier resolution (resolveSubject)", () => {
  it("an email is the email ref only: no phone ref", () => {
    expect(resolveSubject("  Jane@Example.COM ")).toEqual({ normalized: "jane@example.com", phoneRef: null, hashBasis: "jane@example.com" });
  });
  it("a phone number also resolves to the phone ref, and the ledger hashes the digits", () => {
    const a = resolveSubject("+62 812-3456-7890");
    const b = resolveSubject("62 8123456 7890");
    expect(a.phoneRef).toBe("6281234567890");
    expect(b.phoneRef).toBe("6281234567890");
    expect(hashIdentifier(a.hashBasis)).toBe(hashIdentifier(b.hashBasis));
  });
  it("a name or free value has no phone ref and hashes as before (lower-cased, trimmed)", () => {
    expect(resolveSubject(" Budi ").phoneRef).toBeNull();
    expect(resolveSubject(" Budi ").hashBasis).toBe("budi");
  });
  it("the ledger hash is a one-way sha256, never the digits", () => {
    const h = hashIdentifier(resolveSubject("+62 812-3456-7890").hashBasis);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("6281234567890");
  });
});
