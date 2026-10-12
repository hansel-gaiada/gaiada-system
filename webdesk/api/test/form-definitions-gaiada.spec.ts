// M5-L1d — the gaiada.com form definitions (webdesk/sites/gaiada-com/forms/{contact,audit,onboard}.json) are
// validated with the SAME function forms.define runs (parseFormDefinition), so a bad file fails CI instead of
// failing on the live tenant. Pure: no database.
//
// The field ids are the integration contract with the site (gaiada-web-revamp src/config/forms.ts
// CONTACT_FIELDS / AUDIT_FIELDS and src/lib/forms/onboard-questions.ts) and with the ERP's lead mapping
// (platform-nest src/core/agency-web-leads.service.ts WEB_FORM_MAPPINGS). The expected tables below restate the
// site's ids; platform-nest/src/modules/webdev/form-definitions-contract.test.ts checks the ERP side against the
// same files.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFormDefinition } from "../src/control/forms/form-definition";
import { deriveSubjectRefs, emailFieldKey, phoneFieldKey } from "../src/forms/subject-refs";
import { FormSchemaService } from "../src/forms/form-schema.service";
import { resolveHoneypotFieldName } from "../src/forms/honeypot";

const DIR = `${resolve(__dirname, "../../sites/gaiada-com/forms")}/`;
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8"));

/** key -> [type, required] exactly as the site's forms declare them. */
const EXPECTED: Record<string, Record<string, [string, boolean]>> = {
  contact: {
    name: ["text", true],
    selectcontact: ["select", true],
    email_address: ["email", false],
    phone_number: ["tel", false],
    message: ["textarea", true],
  },
  audit: {
    name: ["text", true],
    email_address: ["email", true],
    phone_number: ["tel", false],
    website_url: ["text", false],
    business_type: ["select", false],
    message: ["textarea", false],
  },
  onboard: {
    schema_version: ["text", false],
    org_name: ["text", true],
    contact_name: ["text", true],
    contact_email: ["email", true],
    contact_phone: ["tel", false],
    business_type: ["text", false],
    business_type_other: ["text", false],
    project_trigger: ["textarea", false],
    current_url: ["text", false],
    success_metrics: ["text", false],
    success_metrics_other: ["text", false],
    primary_audience: ["text", false],
    brand_files: ["text", false],
    brand_colors: ["text", false],
    reference_1: ["textarea", false],
    anything_else: ["textarea", false],
  },
};

describe("the gaiada.com form definitions", () => {
  it("are exactly contact, audit and onboard", () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()).toEqual(["audit.json", "contact.json", "onboard.json"]);
  });

  for (const name of Object.keys(EXPECTED)) {
    describe(name, () => {
      const file = load(name);
      const { key, ...body } = file;
      const parsed = parseFormDefinition(key, body);

      it("passes forms.define's validator (no issues)", () => {
        expect(parsed.ok ? [] : parsed.issues).toEqual([]);
        expect(key).toBe(name);
      });

      it("declares exactly the site's field ids, with the right types and required flags", () => {
        if (!parsed.ok) throw new Error("invalid");
        const got = Object.fromEntries(parsed.value.schema.fields.map((f) => [f.key, [f.type, f.required === true]]));
        expect(got).toEqual(EXPECTED[name]);
      });

      it("uses the _hp honeypot, site-2026-10-11, 90 days, and a notice that says 90 days and links the privacy policy", () => {
        if (!parsed.ok) throw new Error("invalid");
        expect(resolveHoneypotFieldName(parsed.value.schema)).toBe("_hp");
        expect(parsed.value.consentNoticeVersion).toBe("site-2026-10-11");
        expect(parsed.value.retentionDays).toBe(90);
        expect(parsed.value.schema.consentNotice.text).toContain("90 days");
        expect(parsed.value.schema.consentNotice.text).toContain("/privacy-policy/");
      });

      it("keeps the notice text and version identical across the three forms (one notice, one version)", () => {
        const texts = Object.keys(EXPECTED).map((n) => ((load(n).schema as { consentNotice: { text: string } }).consentNotice.text));
        expect(new Set(texts).size).toBe(1);
        expect(new Set(Object.keys(EXPECTED).map((n) => load(n).consentNoticeVersion)).size).toBe(1);
      });
    });
  }

  it("the data-subject correlators come from the typed email / tel fields", () => {
    expect(emailFieldKey(load("contact").schema)).toBe("email_address");
    expect(phoneFieldKey(load("contact").schema)).toBe("phone_number");
    expect(emailFieldKey(load("audit").schema)).toBe("email_address");
    expect(phoneFieldKey(load("audit").schema)).toBe("phone_number");
    expect(emailFieldKey(load("onboard").schema)).toBe("contact_email");
    expect(phoneFieldKey(load("onboard").schema)).toBe("contact_phone");
    expect(deriveSubjectRefs(load("onboard").schema, { contact_email: "A@B.co", contact_phone: "+62 812-3456-7890" })).toEqual({
      email: "a@b.co",
      phone: "6281234567890",
    });
  });

  it("a realistic submission validates against each stored schema, and the stored form shape is what the submit path reads", () => {
    const svc = new FormSchemaService();
    const contact = svc.parseSchemaDef(load("contact").schema);
    expect(svc.validate(contact, { name: "Jane", selectcontact: "whatsapp", phone_number: "+62 812-3456-7890", message: "Hello" }).ok).toBe(true);
    // the select is a closed list: the site's empty placeholder option must not be sent
    expect(svc.validate(contact, { name: "Jane", selectcontact: "", message: "Hello" }).ok).toBe(false);
    const audit = svc.parseSchemaDef(load("audit").schema);
    expect(svc.validate(audit, { name: "Jane", email_address: "jane@example.com", business_type: "Events" }).ok).toBe(true);
    expect(svc.validate(audit, { name: "Jane", email_address: "jane@example.com", business_type: "Spaceships" }).ok).toBe(false);
    const onboard = svc.parseSchemaDef(load("onboard").schema);
    expect(
      svc.validate(onboard, { schema_version: "onboard.2026-09-07.v1", org_name: "Villa X", contact_name: "Jane", contact_email: "jane@example.com", business_type: "Villa / rental, Events" }).ok,
    ).toBe(true);
  });
});
