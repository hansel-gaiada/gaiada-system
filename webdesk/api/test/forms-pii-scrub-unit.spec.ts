// M5-L1 — the WebDesk-local PAN / national-ID scrub (src/forms/pii-scrub.ts), ported from platform-nest's
// `scrubText` with false-positive guards. Pure: no database. The guards matter as much as the redactions: a
// public contact form must not eat a phone number.
import { describe, expect, it } from "vitest";
import { NIK_TAG, PAN_TAG, luhnValid, nikStructureValid, scrubFreeTextFields, scrubIdentifiers } from "../src/forms/pii-scrub";
import type { FormSchemaDef } from "../src/forms/form-schema.service";

// Well-known test card numbers (all Luhn-valid).
const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005";
const DINERS = "30569309025904"; // 14 digits

// A structurally valid NIK that is NOT Luhn-valid: province 32 (Jawa Barat), day 15, month 08, year 90, serial 0001.
const NIK = "3201151508900001";
// A woman's NIK encodes day + 40 (here 15 + 40 = 55).
const NIK_WOMAN = "3201155508900002";

describe("luhnValid / nikStructureValid", () => {
  it("knows the Luhn checksum", () => {
    for (const n of [VISA, MASTERCARD, AMEX, DINERS]) expect(luhnValid(n)).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
  it("fixtures are what the tests below assume", () => {
    expect(luhnValid(NIK)).toBe(false);
    expect(nikStructureValid(NIK)).toBe(true);
    expect(nikStructureValid(NIK_WOMAN)).toBe(true);
  });
  it("rejects structurally impossible NIKs", () => {
    expect(nikStructureValid("0001151508900001")).toBe(false); // province 00
    expect(nikStructureValid("9901151508900001")).toBe(false); // province 99
    expect(nikStructureValid("3201153208900001")).toBe(false); // day 32
    expect(nikStructureValid("3201151500900001")).toBe(false); // month 00
    expect(nikStructureValid("3201151513900001")).toBe(false); // month 13
    expect(nikStructureValid("320115150890000")).toBe(false); // 15 digits
  });
});

describe("scrubIdentifiers: what IS redacted", () => {
  it("a Luhn-valid card number, contiguous", () => {
    for (const n of [VISA, MASTERCARD, AMEX, DINERS]) {
      const r = scrubIdentifiers(`please charge ${n} thanks`);
      expect(r.text).toBe(`please charge ${PAN_TAG} thanks`);
      expect(r.redactions).toBe(1);
    }
  });
  it("a card number grouped the way it is printed (spaces or dashes; Amex 4-6-5)", () => {
    expect(scrubIdentifiers("4111 1111 1111 1111").text).toBe(PAN_TAG);
    expect(scrubIdentifiers("4111-1111-1111-1111").text).toBe(PAN_TAG);
    expect(scrubIdentifiers("3782 822463 10005").text).toBe(PAN_TAG);
  });
  it("a card number at the start, at the end, in brackets, after punctuation", () => {
    expect(scrubIdentifiers(`${VISA} is mine`).text).toBe(`${PAN_TAG} is mine`);
    expect(scrubIdentifiers(`mine: ${VISA}`).text).toBe(`mine: ${PAN_TAG}`);
    expect(scrubIdentifiers(`(${VISA}).`).text).toBe(`(${PAN_TAG}).`);
    expect(scrubIdentifiers(`card#${VISA}`).text).toBe(`card#${PAN_TAG}`);
  });
  it("an Indonesian NIK (16 digits, valid structure), for men and women", () => {
    expect(scrubIdentifiers(`NIK saya ${NIK}`)).toEqual({ text: `NIK saya ${NIK_TAG}`, redactions: 1 });
    expect(scrubIdentifiers(`KTP: ${NIK_WOMAN}`)).toEqual({ text: `KTP: ${NIK_TAG}`, redactions: 1 });
  });
  it("counts several in one text, of both kinds", () => {
    const r = scrubIdentifiers(`${VISA} and ${NIK} and ${AMEX}`);
    expect(r.text).toBe(`${PAN_TAG} and ${NIK_TAG} and ${PAN_TAG}`);
    expect(r.redactions).toBe(3);
  });
  it("redacts across newlines and keeps the rest of the text byte for byte", () => {
    const r = scrubIdentifiers(`Hello,\nmy card is ${VISA}\nand my phone is 0812-3456-7890.\nBye`);
    expect(r.text).toBe(`Hello,\nmy card is ${PAN_TAG}\nand my phone is 0812-3456-7890.\nBye`);
  });
});

describe("scrubIdentifiers: false-positive guards (what must NOT be redacted)", () => {
  it("a phone number, in any common notation", () => {
    for (const phone of [
      "0812-3456-7890",
      "0812 3456 7890",
      "081234567890",
      "+62 812-3456-7890",
      "+6281234567890",
      "62 812 3456 7890", // 13 digits, country code, no plus: odd grouping keeps it out
      "(021) 555-1234",
      "+1 (415) 555-2671",
      "+86 138 1234 5678",
      "+44 20 7946 0958",
    ]) {
      const text = `call me on ${phone} please`;
      expect(scrubIdentifiers(text)).toEqual({ text, redactions: 0 });
    }
  });
  it("a '+'-prefixed long number is never a card, even when the digits pass Luhn", () => {
    const text = `+${VISA}`;
    expect(scrubIdentifiers(text)).toEqual({ text, redactions: 0 });
  });
  it("a 13-19 digit run that fails Luhn (an order or reference number)", () => {
    for (const n of ["1234567890123", "1234567890123456789", "9999999999999999"]) {
      expect(luhnValid(n)).toBe(false);
      expect(scrubIdentifiers(`ref ${n}`).redactions).toBe(0);
    }
  });
  it("a Luhn-valid number inside a LONGER digit run (20+ digits) is not a card", () => {
    const text = `${VISA}1234`;
    expect(scrubIdentifiers(text)).toEqual({ text, redactions: 0 });
    const text2 = `99${VISA}`;
    expect(scrubIdentifiers(text2)).toEqual({ text: text2, redactions: 0 });
  });
  it("a 16-digit run with no NIK structure and no Luhn (a timestamp-like or id-like number)", () => {
    const text = "id 9999999999999999 and 1234567812345678";
    expect(luhnValid("9999999999999999")).toBe(false);
    expect(luhnValid("1234567812345678")).toBe(false);
    expect(scrubIdentifiers(text)).toEqual({ text, redactions: 0 });
  });
  it("ordinary numbers and dates", () => {
    for (const text of ["2026-10-11 09:00", "Invoice 2026/00123", "Rp 1.500.000,00", "budget 50000000", "version 1.0.0-alpha.302", "postcode 12950"]) {
      expect(scrubIdentifiers(text)).toEqual({ text, redactions: 0 });
    }
  });
  it("an email address is left alone (unlike platform-nest's scrubText: on a lead form it is the point)", () => {
    const text = "reach me at jane.doe@example.com";
    expect(scrubIdentifiers(text)).toEqual({ text, redactions: 0 });
  });
  it("empty and whitespace input", () => {
    expect(scrubIdentifiers("")).toEqual({ text: "", redactions: 0 });
    expect(scrubIdentifiers("   \n ")).toEqual({ text: "   \n ", redactions: 0 });
  });
});

describe("scrubFreeTextFields", () => {
  const schema: FormSchemaDef = {
    fields: [
      { key: "name", type: "text" },
      { key: "message", type: "textarea" },
      { key: "contact_email", type: "text", format: "email" } as unknown as FormSchemaDef["fields"] extends (infer F)[] | undefined ? F : never,
      { key: "phone", type: "text", format: "tel" } as unknown as FormSchemaDef["fields"] extends (infer F)[] | undefined ? F : never,
      { key: "budget", type: "number" },
      { key: "agree", type: "boolean" },
      { key: "service", type: "select" },
      { key: "when", type: "date" },
    ],
  };

  it("scrubs text and textarea fields only", () => {
    const input = { name: `Jane ${VISA}`, message: `my NIK ${NIK}`, service: VISA, when: VISA, budget: 5, agree: true };
    const r = scrubFreeTextFields(input, schema);
    expect(r.fields).toEqual({ name: `Jane ${PAN_TAG}`, message: `my NIK ${NIK_TAG}`, service: VISA, when: VISA, budget: 5, agree: true });
    expect(r.redactions).toBe(2);
  });
  it("never touches an email or tel field, even when it is declared as free text", () => {
    const input = { contact_email: "jane@example.com", phone: "+62 812-3456-7890", message: "hi" };
    const r = scrubFreeTextFields(input, schema);
    expect(r.fields).toEqual(input);
    expect(r.redactions).toBe(0);
  });
  it("does not mutate its input and returns a count only", () => {
    const input = { message: `card ${VISA}` };
    const copy = { ...input };
    const r = scrubFreeTextFields(input, schema);
    expect(input).toEqual(copy);
    expect(Object.keys(r).sort()).toEqual(["fields", "redactions"]);
  });
  it("a field the definition does not declare is left alone (zod strips those before this runs)", () => {
    const input = { mystery: `card ${VISA}` };
    expect(scrubFreeTextFields(input, schema).fields).toEqual(input);
  });
});
