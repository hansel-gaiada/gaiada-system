// M5-L1d — the ERP side of WebDesk's form definitions: `forms.define` (PUT, MEDIUM), `forms.def.list` and
// `forms.def.get` (reads). Before this, a WebDesk `form_defs` row could only be created by raw SQL.
//
// ROUTES (webdesk-content.controller.ts; the same BFF as the content editor, same base path):
//   GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms             MCP webdesk.forms.list
//   GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms/:formKey    MCP webdesk.forms.get
//   PUT /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms/:formKey    MCP webdesk.forms.define (PATCH alias)
//
// AUTHORIZATION. Cerbos `webdesk_collection`, no new kind: `apply_schema` for the write (company_admin,
// webdev_manager / module_manager, platform_admin: the publisher tier) and `read` for the two reads. The reasoning: a form
// definition is the composition of a PUBLIC intake (what it accepts, which consent notice it records, how long it keeps
// submissions), the same family as a collection's composition, which `apply_schema` already guards; WebDesk classifies
// forms.define MEDIUM / operate exactly like schema.apply. The controller's FIRST statement is `authorizeContent(...)`
// (the "validation pre-empts authz" rule), so a denied caller is denied whatever it sent. A client editor holds
// none of these actions (no `client` rule on `webdesk_collection`), and the client portal BFF does not route here.
//
// WHAT THE ERP CHECKS ITSELF, AND WHAT IT LEAVES TO WEBDESK. The cross-company wall (the site must belong to THIS
// company: a uniform 404 otherwise) and the SHAPE of the body (allow-listed top-level members). The definition's
// content (field types, honeypot, consent notice, retention, the notice-version rule) is validated by WebDesk's own
// validator, once: a 422 `form-definition-invalid` (with `issues`) or a 409 `consent-version-unchanged` passes through
// byte for byte (the WebdeskProblemFilter), so there is no second copy of the rules to drift.
//
// LEDGER. Like every egress write: two `webdesk.forms.define` rows (attempted, then the outcome). Non-secret
// identifiers only: tenant slug, site id, form key and the notice VERSION. Never the notice text, never a field.
import { invalidRequest, isPlainObject, strictBody, webdeskZoneB, type ContentGate, type SiteRef, type ZoneBResult, UUID_RE } from "./webdesk-content.service";

/** WebDesk's own form-key rule (webdesk/api/src/control/forms/form-definition.ts FORM_KEY_RE). */
const FORM_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_FOR_LEDGER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function formKeyOf(raw: string): string {
  if (!FORM_KEY_RE.test(raw)) throw invalidRequest("the form key must match [a-z0-9][a-z0-9_-]{0,63}");
  return raw;
}

const PATH_LIST = "/control/v1/tenants/:tenantSlug/sites/:siteId/forms";
const PATH_ONE = "/control/v1/tenants/:tenantSlug/sites/:siteId/forms/:formKey";

/** `forms.def.list`: the site's form definitions. The caller holds `webdesk_collection:read`. */
export async function listFormDefinitions(gate: ContentGate, site: SiteRef): Promise<ZoneBResult> {
  gate.require("webdesk_collection", "read");
  await gate.resolveSite(webdeskZoneB, site);
  return webdeskZoneB.read({ command: "forms.def.list", path: PATH_LIST, params: { tenantSlug: site.tenantSlug, siteId: site.siteId } });
}

/** `forms.def.get`: one definition by its key. The caller holds `webdesk_collection:read`. */
export async function getFormDefinition(gate: ContentGate, site: SiteRef, formKey: string): Promise<ZoneBResult> {
  gate.require("webdesk_collection", "read");
  const key = formKeyOf(formKey);
  await gate.resolveSite(webdeskZoneB, site);
  return webdeskZoneB.read({
    command: "forms.def.get",
    path: PATH_ONE,
    params: { tenantSlug: site.tenantSlug, siteId: site.siteId, formKey: key },
  });
}

/**
 * `forms.define`: upsert one form definition by `(site, key)`; redefining keeps the form's id. Body:
 * `{ schema, notify?, retentionDays, consentNoticeVersion }` (the shape of webdesk/sites/gaiada-com/forms/*.json minus
 * its `key`, which is the route's `:formKey`). The caller holds `webdesk_collection:apply_schema`.
 * WebDesk answers `{ form, created, consentNoticeChanged, replayed }`; its typed 409 / 422 pass through untouched.
 */
export async function defineFormDefinition(
  gate: ContentGate,
  site: SiteRef,
  formKey: string,
  rawBody: unknown,
  idempotencyKey: string,
): Promise<ZoneBResult> {
  gate.require("webdesk_collection", "apply_schema");
  const key = formKeyOf(formKey);
  const b = strictBody(rawBody, ["schema", "notify", "retentionDays", "consentNoticeVersion"]);
  if (!isPlainObject(b.schema)) throw invalidRequest("schema must be a JSON object ({ fields, honeypotField?, consentNotice, attachments? })");
  if (b.notify !== undefined && !isPlainObject(b.notify)) throw invalidRequest("notify must be a JSON object");
  if (typeof b.retentionDays !== "number") throw invalidRequest("retentionDays is required and must be a number of days");
  if (typeof b.consentNoticeVersion !== "string" || b.consentNoticeVersion === "") throw invalidRequest("consentNoticeVersion is required and must be a string");

  await gate.resolveSite(webdeskZoneB, site);

  const body: Record<string, unknown> = { schema: b.schema, retentionDays: b.retentionDays, consentNoticeVersion: b.consentNoticeVersion };
  if (b.notify !== undefined) body.notify = b.notify;
  return webdeskZoneB.write(gate.principal, gate.tenantId, {
    command: "forms.define",
    verb: "webdesk.forms.define",
    method: "PUT",
    path: PATH_ONE,
    params: { tenantSlug: site.tenantSlug, siteId: site.siteId, formKey: key },
    body,
    idempotencyKey,
    entity: { type: "webdesk_site", id: UUID_RE.test(site.siteId) ? site.siteId : null },
    ledger: {
      tenantSlug: site.tenantSlug,
      siteId: site.siteId,
      formKey: key,
      ...(VERSION_FOR_LEDGER_RE.test(b.consentNoticeVersion) ? { consentNoticeVersion: b.consentNoticeVersion } : {}),
    },
  });
}
