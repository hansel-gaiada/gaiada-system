// M5-L1d — no services needed. Two contracts, checked against files in this repo:
//
//   1. The gaiada.com form definitions (webdesk/sites/gaiada-com/forms/*.json) carry every field id the ERP's lead
//      mapping (src/core/agency-web-leads.service.ts WEB_FORM_MAPPINGS, M5-L4) reads, in the RIGHT form and of the
//      RIGHT type (an email column maps an `email`-typed field, a phone column a `tel`-typed one: WebDesk derives its
//      data-subject refs from those types). A renamed id on either side fails here instead of silently losing a lead.
//      (The definitions are validated by WebDesk's own validator in webdesk/api/test/form-definitions-gaiada.spec.ts.)
//   2. The three MCP tools exist with the right class and point at the BFF routes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEB_FORM_MAPPINGS } from "../../core/agency-web-leads.service";
import { webdevModule } from "./index";

const DIR = resolve(__dirname, "../../../../webdesk/sites/gaiada-com/forms");
type Def = { key: string; schema: { fields: Array<{ key: string; type: string; required?: boolean }>; honeypotField?: string; consentNotice: { text: string } }; retentionDays: number; consentNoticeVersion: string };
const load = (name: string): Def => JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8")) as Def;

describe("gaiada.com form definitions ↔ the ERP lead mapping (M5-L4)", () => {
  for (const formKey of Object.keys(WEB_FORM_MAPPINGS)) {
    describe(formKey, () => {
      const def = load(formKey);
      const mapping = WEB_FORM_MAPPINGS[formKey];
      const typeOf = (id: string) => def.schema.fields.find((f) => f.key === id)?.type;

      it("the definition's key is the mapping's key", () => {
        expect(def.key).toBe(formKey);
      });
      it("every id the lead mapping reads exists in the definition", () => {
        for (const id of [...mapping.orgName, ...mapping.contactName, ...mapping.contactEmail, ...mapping.contactPhone]) {
          expect(typeOf(id), `${formKey}.${id}`).toBeDefined();
        }
      });
      it("the email column maps email-typed fields, the phone column tel-typed fields, the name columns text", () => {
        for (const id of mapping.contactEmail) expect(typeOf(id), id).toBe("email");
        for (const id of mapping.contactPhone) expect(typeOf(id), id).toBe("tel");
        for (const id of [...mapping.orgName, ...mapping.contactName]) expect(typeOf(id), id).toBe("text");
      });
    });
  }

  it("every WebDesk form definition in the repo has a lead mapping, and the three definitions share one notice version", () => {
    expect(Object.keys(WEB_FORM_MAPPINGS).sort()).toEqual(["audit", "contact", "onboard"]);
    expect(new Set(Object.keys(WEB_FORM_MAPPINGS).map((k) => load(k).consentNoticeVersion))).toEqual(new Set(["site-2026-10-11"]));
  });
});

describe("M5-L1d MCP tools", () => {
  const tool = (name: string) => webdevModule.mcpTools?.find((t) => t.name === name);

  it("webdesk.forms.define is a MEDIUM write on the PATCH alias; the two reads are plain GETs on the same family of routes", () => {
    const define = tool("webdesk.forms.define");
    expect(define).toMatchObject({
      write: true,
      impact: "medium",
      method: "PATCH",
      pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms/:formKey",
    });
    expect(define?.inputSchema.required).toEqual(
      expect.arrayContaining(["tenantId", "tenantSlug", "siteId", "formKey", "schema", "retentionDays", "consentNoticeVersion"]),
    );
    expect(tool("webdesk.forms.list")).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms" });
    expect(tool("webdesk.forms.get")).toMatchObject({ method: "GET", pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms/:formKey" });
    expect(tool("webdesk.forms.list")?.write).toBeFalsy();
    expect(tool("webdesk.forms.get")?.write).toBeFalsy();
  });
});
