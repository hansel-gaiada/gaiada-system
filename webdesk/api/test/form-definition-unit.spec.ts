// M5-L1d — the forms.define validator (src/control/forms/form-definition.ts), pure: no database, no Nest.
// The HTTP behaviour (envelope, audit, the notice rule, RLS) is test/forms-define.spec.ts, which needs the Linux gate;
// the checked-in gaiada.com definitions are validated by test/form-definitions-gaiada.spec.ts.
import { describe, expect, it } from "vitest";
import {
  MAX_RETENTION_DAYS,
  RESERVED_BODY_MEMBERS,
  parseFormDefinition,
  type FormDefinitionIssue,
} from "../src/control/forms/form-definition";
import { CLIENT_EDITOR_COMMANDS, COMMAND_REGISTRY, EDITORIAL_COMMANDS } from "../src/control/command-types";
import { deriveSubjectRefs } from "../src/forms/subject-refs";

const base = () => ({
  schema: {
    fields: [
      { key: "name", type: "text", required: true, maxLength: 200 },
      { key: "email_address", type: "email", required: true },
      { key: "phone_number", type: "tel" },
      { key: "topic", type: "select", options: ["a", "b"] },
      { key: "message", type: "textarea" },
    ],
    honeypotField: "_hp",
    consentNotice: { text: "We use this to reply. /privacy-policy/" },
  },
  notify: {},
  retentionDays: 90,
  consentNoticeVersion: "v1",
});

type Mut = (b: ReturnType<typeof base>) => unknown;
const paths = (issues: FormDefinitionIssue[]) => issues.map((i) => i.path);
function refused(mut: Mut, key = "contact"): FormDefinitionIssue[] {
  const b = base();
  const body = mut(b) ?? b;
  const r = parseFormDefinition(key, body);
  if (r.ok) throw new Error("expected the definition to be refused");
  return r.issues;
}

describe("parseFormDefinition: accepts", () => {
  it("a complete definition, normalised (the notice trimmed), with nothing dropped", () => {
    const b = base();
    b.schema.consentNotice.text = "  We use this to reply.  ";
    const r = parseFormDefinition("contact", b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.key).toBe("contact");
    expect(r.value.schema.consentNotice.text).toBe("We use this to reply.");
    expect(r.value.schema.honeypotField).toBe("_hp");
    expect(r.value.schema.fields).toHaveLength(5);
    expect(r.value.retentionDays).toBe(90);
    expect(r.value.notify).toEqual({});
  });

  it("an omitted honeypot and an omitted notify are fine (the defaults apply)", () => {
    const b = base() as Record<string, unknown>;
    delete (b.schema as Record<string, unknown>).honeypotField;
    delete b.notify;
    const r = parseFormDefinition("audit", b);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.schema.honeypotField).toBeUndefined();
  });

  it("notify with a recipient and an autoresponder, attachments with a cap", () => {
    const b = base() as Record<string, unknown>;
    b.notify = { to: { email: "web@example.com", name: "Web" }, templateKey: "form-notification", autoresponder: true, autoresponderTemplateKey: "form-autoresponder" };
    (b.schema as Record<string, unknown>).attachments = { allowed: true, maxCount: 3 };
    expect(parseFormDefinition("contact", b).ok).toBe(true);
  });
});

describe("parseFormDefinition: refuses", () => {
  const cases: Array<[string, Mut, string]> = [
    ["a field key with an uppercase letter", (b) => { b.schema.fields[0].key = "Name"; }, "schema.fields[0].key"],
    ["a field key with a dash", (b) => { b.schema.fields[0].key = "first-name"; }, "schema.fields[0].key"],
    ["a field key over 64 characters", (b) => { b.schema.fields[0].key = "a".repeat(65); }, "schema.fields[0].key"],
    ["an unknown field type", (b) => { b.schema.fields[0].type = "checkbox"; }, "schema.fields[0].type"],
    ["a missing field type", (b) => { delete (b.schema.fields[0] as Record<string, unknown>).type; }, "schema.fields[0].type"],
    ["a duplicate field key", (b) => { b.schema.fields[1].key = "name"; }, "schema.fields"],
    ["no fields at all", (b) => { b.schema.fields = []; }, "schema.fields"],
    ["more than 60 fields", (b) => { b.schema.fields = Array.from({ length: 61 }, (_, i) => ({ key: `f${i}`, type: "text" })); }, "schema.fields"],
    ["an unknown member of a field", (b) => { (b.schema.fields[0] as Record<string, unknown>).format = "email"; }, "schema.fields[0].format"],
    ["a maxLength on a number field", (b) => { b.schema.fields[0] = { key: "age", type: "number", maxLength: 3 } as never; }, "schema.fields[0].maxLength"],
    ["a maxLength above the submit cap", (b) => { b.schema.fields[0].maxLength = 5001; }, "schema.fields[0].maxLength"],
    ["min above max", (b) => { b.schema.fields[0] = { key: "age", type: "number", min: 5, max: 1 } as never; }, "schema.fields[0].min"],
    ["a select without options", (b) => { delete (b.schema.fields[3] as Record<string, unknown>).options; }, "schema.fields[3].options"],
    ["duplicate select options", (b) => { b.schema.fields[3].options = ["a", "a"]; }, "schema.fields[3].options"],
    ["options on a text field", (b) => { (b.schema.fields[0] as Record<string, unknown>).options = ["x"]; }, "schema.fields[0].options"],
    ["an email-looking field typed text (privacy.find would lose its submitters)", (b) => { b.schema.fields[1].type = "text"; }, "schema.fields[1].type"],
    ["a phone-looking field typed text", (b) => { b.schema.fields[2].type = "text"; }, "schema.fields[2].type"],
    ["a honeypot that is also a field key", (b) => { b.schema.honeypotField = "message"; }, "schema.honeypotField"],
    ["a honeypot named like a submit-body member", (b) => { b.schema.honeypotField = "consent"; }, "schema.honeypotField"],
    ["a malformed honeypot", (b) => { b.schema.honeypotField = "Bot Check"; }, "schema.honeypotField"],
    ["a missing consent notice", (b) => { delete (b.schema as Record<string, unknown>).consentNotice; }, "schema.consentNotice"],
    ["an empty consent notice text", (b) => { b.schema.consentNotice.text = "   "; }, "schema.consentNotice.text"],
    ["a consent notice over 4000 characters", (b) => { b.schema.consentNotice.text = "x".repeat(4001); }, "schema.consentNotice.text"],
    ["a missing consent version", (b) => { delete (b as Record<string, unknown>).consentNoticeVersion; }, "consentNoticeVersion"],
    ["a consent version with a space", (b) => { b.consentNoticeVersion = "v 1"; }, "consentNoticeVersion"],
    ["a missing retention", (b) => { delete (b as Record<string, unknown>).retentionDays; }, "retentionDays"],
    ["retention of 0 (the table's own CHECK)", (b) => { b.retentionDays = 0; }, "retentionDays"],
    ["a fractional retention", (b) => { b.retentionDays = 90.5; }, "retentionDays"],
    ["a retention above the cap", (b) => { b.retentionDays = MAX_RETENTION_DAYS + 1; }, "retentionDays"],
    ["a notify recipient that is not an email", (b) => { (b as Record<string, unknown>).notify = { to: { email: "not-an-email" } }; }, "notify.to.email"],
    ["an unknown notify member", (b) => { (b as Record<string, unknown>).notify = { cc: "x@example.com" }; }, "notify.cc"],
    ["an unknown schema member", (b) => { (b.schema as Record<string, unknown>).format = "x"; }, "schema.format"],
    ["an unknown top-level member", (b) => { (b as Record<string, unknown>).consentVersion = "x"; }, "consentVersion"],
    ["attachments.maxCount above the cap", (b) => { (b.schema as Record<string, unknown>).attachments = { maxCount: 21 }; }, "schema.attachments.maxCount"],
  ];
  for (const [name, mut, path] of cases) {
    it(name, () => {
      expect(paths(refused(mut))).toContain(path);
    });
  }

  it("a body that is not an object, and a form key that is not a key", () => {
    expect(parseFormDefinition("contact", null).ok).toBe(false);
    expect(parseFormDefinition("contact", []).ok).toBe(false);
    expect(parseFormDefinition("Contact Form", base()).ok).toBe(false);
    expect(parseFormDefinition("", base()).ok).toBe(false);
    expect(parseFormDefinition("a".repeat(65), base()).ok).toBe(false);
  });

  it("reports EVERY problem, not only the first", () => {
    const issues = refused((b) => {
      b.retentionDays = 0;
      b.schema.fields[0].type = "checkbox";
      b.schema.honeypotField = "name";
    });
    expect(paths(issues)).toEqual(expect.arrayContaining(["retentionDays", "schema.fields[0].type", "schema.honeypotField"]));
  });

  it("every submit-body member is refused as a honeypot", () => {
    for (const m of RESERVED_BODY_MEMBERS) {
      const b = base();
      b.schema.honeypotField = m;
      const r = parseFormDefinition("contact", b);
      expect(r.ok, m).toBe(false);
    }
  });
});

describe("a definition that passes drives the data-subject correlators (M5-L1)", () => {
  it("the first email-typed and tel-typed fields are the submitter's refs", () => {
    const r = parseFormDefinition("contact", base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const refs = deriveSubjectRefs(r.value.schema, { name: "Jane", email_address: " Jane@Example.com ", phone_number: "+62 812-3456-7890" });
    expect(refs).toEqual({ email: "jane@example.com", phone: "6281234567890" });
  });
});

describe("forms.define in the command registry", () => {
  it("is MEDIUM / webdesk:operate with no WS4 approval class; the two reads are read / webdesk:read", () => {
    expect(COMMAND_REGISTRY["forms.define"]).toMatchObject({ impactClass: "medium", scope: "webdesk:operate", jobTracked: false });
    expect(COMMAND_REGISTRY["forms.def.list"]).toMatchObject({ impactClass: "read", scope: "webdesk:read" });
    expect(COMMAND_REGISTRY["forms.def.get"]).toMatchObject({ impactClass: "read", scope: "webdesk:read" });
  });
  it("is not an editorial command and not on the client-editor allow-list (a client-editor principal cannot be expressed on it)", () => {
    for (const c of ["forms.define", "forms.def.list", "forms.def.get"] as const) {
      expect(EDITORIAL_COMMANDS.has(c), c).toBe(false);
      expect(CLIENT_EDITOR_COMMANDS.has(c), c).toBe(false);
    }
  });
});
