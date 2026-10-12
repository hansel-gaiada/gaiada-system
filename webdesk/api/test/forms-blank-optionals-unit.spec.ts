// M5-L1d — a blank OPTIONAL value is "not given"; a REQUIRED field stays required. Pure (FormSchemaService.validate).
import { describe, expect, it } from "vitest";
import { FormSchemaService, type FormSchemaDef } from "../src/forms/form-schema.service";

const svc = new FormSchemaService();
const schema: FormSchemaDef = {
  fields: [
    { key: "name", type: "text", required: true },
    { key: "email_address", type: "email" },
    { key: "contact_email", type: "email", required: true },
    { key: "phone_number", type: "tel" },
    { key: "topic", type: "select", options: ["a", "b"] },
    { key: "must_pick", type: "select", options: ["a", "b"], required: true },
    { key: "website_url", type: "text" },
    { key: "message", type: "textarea", required: true },
  ],
};
const good = { name: "Jane", contact_email: "j@example.com", must_pick: "a", message: "Hi" };
const ok = (r: ReturnType<FormSchemaService["validate"]>) => (r.ok ? r.fields : null);

describe("blank optional values", () => {
  it("an optional email / tel / select / text sent as an empty string is accepted and stored as ABSENT", () => {
    const f = ok(svc.validate(schema, { ...good, email_address: "", phone_number: "", topic: "", website_url: "" }));
    expect(f).not.toBeNull();
    for (const k of ["email_address", "phone_number", "topic", "website_url"]) expect(f).not.toHaveProperty(k);
    expect(f).toMatchObject(good);
  });

  it("whitespace-only counts as blank for an optional field", () => {
    const f = ok(svc.validate(schema, { ...good, email_address: "   ", phone_number: " \t" }));
    expect(f).not.toBeNull();
    expect(f).not.toHaveProperty("email_address");
  });

  it("a filled optional field is still validated: a bad optional email is refused, a good one kept", () => {
    expect(svc.validate(schema, { ...good, email_address: "not-an-email" }).ok).toBe(false);
    expect(ok(svc.validate(schema, { ...good, email_address: "a@b.co", topic: "b" }))).toMatchObject({ email_address: "a@b.co", topic: "b" });
    expect(svc.validate(schema, { ...good, topic: "z" }).ok).toBe(false);
  });

  it("a REQUIRED field stays required: \"\" and whitespace are refused for email, select, text and textarea alike", () => {
    for (const k of ["name", "contact_email", "must_pick", "message"]) {
      for (const blank of ["", "   "]) {
        const r = svc.validate(schema, { ...good, [k]: blank });
        expect(r.ok, `${k}=${JSON.stringify(blank)}`).toBe(false);
        if (!r.ok) expect(r.issues.some((i) => i.startsWith(`${k}:`))).toBe(true);
      }
    }
  });

  it("a required field that is absent is still refused; an optional absent one is fine", () => {
    expect(svc.validate(schema, { name: "Jane", contact_email: "j@example.com", must_pick: "a" }).ok).toBe(false);
    expect(svc.validate(schema, good).ok).toBe(true);
  });

  it("does not mutate the caller's object", () => {
    const input = { ...good, email_address: "" };
    svc.validate(schema, input);
    expect(input.email_address).toBe("");
  });
});
