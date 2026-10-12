# gaiada.com form definitions (M5-L1d)

Status: **PROTOTYPED**. The three definitions below are data in the `forms.define` body shape. They are validated by the
same function the command runs (`webdesk/api/test/form-definitions-gaiada.spec.ts`), and checked against the ERP's lead
mapping (`platform-nest/src/modules/webdev/form-definitions-contract.test.ts`). **Nothing here has been applied to any
WebDesk tenant.** Applying on the live tenant is an orchestrator/owner step, after the gates listed below.

| File | Form key | Site form |
|---|---|---|
| `contact.json` | `contact` | `ContactForm.astro` (`CONTACT_FIELDS` in `src/config/forms.ts`) |
| `audit.json` | `audit` | `AuditForm.astro` (`AUDIT_FIELDS`) |
| `onboard.json` | `onboard` | `OnboardForm.astro` (`src/lib/forms/onboard-questions.ts`, `SCHEMA_VERSION onboard.2026-09-07.v1`) |

The form keys are what the ERP's lead mapping (`WEB_FORM_MAPPINGS` in `platform-nest/src/core/agency-web-leads.service.ts`) is keyed by: `contact`, `audit`, `onboard`.

## File shape

```jsonc
{
  "key": "contact",                         // the form's stable key; the route's :formKey, NOT part of the request body
  "schema": { "fields": [...], "honeypotField": "_hp", "consentNotice": { "text": "..." } },
  "notify": {},                             // empty on purpose: no WebDesk mail. The ERP files the lead and alerts staff (L4/L5)
  "retentionDays": 90,
  "consentNoticeVersion": "site-2026-10-11"
}
```

The request body of `forms.define` is this object **without `key`**. Rules and answers: `webdesk/api/README.md`, "Form definitions".

## How to apply them (not yet: see the gates)

Through the ERP BFF or its MCP tool, as a user who holds Cerbos `webdesk_collection · apply_schema` (company_admin, webdev_manager, platform_admin):

```
PUT /api/:companyId/modules/webdev/content/sites/gaiada/:siteId/forms/contact      (MCP: webdesk.forms.define, PATCH alias)
Idempotency-Key: <fresh value per request>
body: the file's contents without "key"
```

`:companyId` is the Gaiada company; `gaiada` is the WebDesk tenant slug; `:siteId` comes from `GET /api/:companyId/modules/webdev/content/sites`
(`webdesk.content.listSites`). Do it for `contact`, `audit` and `onboard`. The answer's `form.formId` is the id the site posts to
(`POST /v1/t/gaiada/forms/<formId>/submit`); it **stays the same** when a definition is applied again. Read it back with `GET …/forms` (`webdesk.forms.list`).
An unattended agent or n8n caller suspends for approval and nothing is re-driven yet (`forms.define` is not a D14 executable, see PERMISSION-CONTRACT 27.3), so an attended person does this.

**Changing a definition later.** Edit the JSON, run the spec, apply. If `consentNotice.text` changes, **`consentNoticeVersion` must change too** (WebDesk refuses
with 409 `consent-version-unchanged` otherwise): every submission stores the notice text and version it was accepted under. All three files carry the same notice and version
(the spec checks that); change them together.

### Gates before applying on live (orchestrator / owner)

1. **G2: counsel's review of the consent notice text** (see "DRAFT" below). Applying fixes the text on every submission from then on; a later wording change needs a new version, and the earlier submissions keep the old text.
2. **O-6: the Turnstile keys.** The submit route verifies a Turnstile token; with `TURNSTILE_MODE` stub the form accepts the stub token. Do not point the live site at the forms before real keys are in.
3. **L4 on (`AGENCY_WEB_LEADS_ENABLED=1`) before the 90 days start to matter.** The retention below assumes the enquiry has been delivered to the ERP (addendum section 5 says so); once a submission is purged, a lead that was never filed is gone.
4. The privacy page `/privacy-policy/` must exist (the notice links to it; the addendum marks the page PLANNED).

## DRAFT for counsel (O-3 / G2)

**The consent notice text in these files is a DRAFT. It is not legal advice and it is not approved.** It is drafted from the privacy-notice draft in
`legal/website-visitor-addendum.md` section 10 ("Who we are", "What we collect and why", "Consent", "Who receives your data") and from rule 4 of the phase-4 conversion
proposal (section 9: the form notice must say that hashed contact details may go to the ad platforms if marketing consent was given, and that sending the form does not depend on it).
It names no controller entity or address: the addendum still has `[CONTROLLER ENTITY]` and `[DPO NAME/EMAIL]` as open placeholders, so the text points to the privacy policy for them.
It is English only; the addendum says an Indonesian version is required (the site and the banner are bilingual), and a second language needs its own wording and a decision on how a bilingual
notice is stored (one text per form today). Counsel should review every sentence.

**Retention: 90 days.** Source: `legal/website-visitor-addendum.md`, section 5 "Retention", the row "Form submissions in WebDesk (`submissions`)" (line 250): "propose 90 days once delivered to the ERP
(schema default 180 today)"; and the privacy-notice draft, section 10 item 8's table (line 488): "Form submissions on our form server | 90 days, then removed". It is marked
«ASSUMPTION: defaults for counsel and owner to confirm», so it is a proposal, and the notice text says "90 days": if the number changes, the text and the version change with it
(the spec fails if the text and `retentionDays` disagree on 90).

## Field ids: site, WebDesk, ERP (the integration contract)

Field ids are exactly the site's (`src/config/forms.ts`, `src/lib/forms/onboard-questions.ts`); L4's lead mapping reads them. `type` is what WebDesk validates; `email` and `tel`
typed fields are also what WebDesk derives its data-subject refs from (`privacy.find` / `privacy.erase`, M5-L1), so they are typed on purpose.

### `contact`

| Site field id | WebDesk type | Required | L4 lead column |
|---|---|---|---|
| `name` | text (200) | yes | contact_name (and org_name fallback) |
| `selectcontact` | select: `email`, `whatsapp` | yes | not mapped |
| `email_address` | **email** (320) | no | contact_email |
| `phone_number` | **tel** (40) | no | contact_phone |
| `message` | textarea (5000) | yes | not mapped |

### `audit`

| Site field id | WebDesk type | Required | L4 lead column |
|---|---|---|---|
| `name` | text (200) | yes | contact_name (and org_name fallback) |
| `email_address` | **email** (320) | yes | contact_email |
| `phone_number` | **tel** (40) | no | contact_phone |
| `website_url` | text (2048) | no | not mapped |
| `business_type` | select: the 12 `BUSINESS_TYPES` | no | not mapped (a category, deliberately not org_name) |
| `message` | textarea (5000) | no | not mapped |

### `onboard`

| Site field id | WebDesk type | Required | L4 lead column |
|---|---|---|---|
| `schema_version` | text (64) | no | not mapped (the hidden `onboard.2026-09-07.v1`) |
| `org_name` | text (300) | yes | org_name |
| `contact_name` | text (200) | yes | contact_name |
| `contact_email` | **email** (320) | yes | contact_email |
| `contact_phone` | **tel** (40) | no | contact_phone |
| `business_type` | text (1000): chips joined, see below | no | not mapped |
| `business_type_other` | text (200) | no | not mapped |
| `project_trigger` | textarea (5000) | no | not mapped |
| `current_url` | text (2048) | no | not mapped (the site types it `text`: "none" is a valid answer) |
| `success_metrics` | text (1000): chips joined, see below | no | not mapped |
| `success_metrics_other` | text (200) | no | not mapped |
| `primary_audience` | text (500) | no | not mapped |
| `brand_files` | text (1000) | no | not mapped |
| `brand_colors` | text (500) | no | not mapped |
| `reference_1` | textarea (5000) | no | not mapped |
| `anything_else` | textarea (5000) | no | not mapped |

Every id L4 maps exists in the right form with the right type (the contract test asserts it): contact/audit `name`, `email_address`, `phone_number`; onboard `org_name`, `contact_name`, `contact_email`, `contact_phone`.

## What the site must do when it switches (not done here; the site is not modified by this ticket)

These follow from how the submit route validates (`webdesk/api/src/forms/forms.service.ts`, `form-schema.service.ts`). They are site-side changes, listed so the switch does not fail on the first real visitor:

1. **Send JSON `fields`.** A blank OPTIONAL value (`""` or whitespace, which is what a browser sends for an untouched `email_address`, `phone_number`, `website_url` or an unchosen `business_type` select) is accepted by WebDesk and treated as absent: nothing is stored under that key. A blank REQUIRED value (`name`, `message`, `selectcontact`, `org_name`, `contact_name`, `contact_email`) is a 400. The site may therefore send blanks as they are, but should still validate required fields before sending.
2. **The honeypot is `_hp`** and is a top-level member of the request body, beside `fields` (not inside it). Any non-empty value is silently dropped as spam. (The site's `botcheck` is renamed when it switches.)
3. **Chips become one string.** `business_type[]` and `success_metrics[]` (checkboxes) are sent as `business_type` / `success_metrics`, the chosen options joined with `, ` (no option contains a comma); the free-text "Something else" fields keep their ids `business_type_other` / `success_metrics_other`. WebDesk has no multi-value field type, and an array would be dropped as an unknown shape. If a structured array is wanted later, that is a new field type in `form-schema.service.ts`, not a data change here.
4. **`consent: true`** (the literal boolean) and a `turnstileToken` are required in the request body; neither is a field. The Web3Forms-only members (`access_key`, `subject`, `from_name`, `redirect`) are not sent: `attribution.form_page` carries which page produced the enquiry.
5. **Lengths.** Text fields are capped as in the tables; the longest textarea is 5000 characters (WebDesk's `WEBDESK_FORMS_MAX_FIELD_TEXT_LENGTH` default). The submit body as a whole is capped at 64 KiB of fields.
6. **Free text is scrubbed server-side** (M5-L1): a card or national-ID number typed into a `text` or `textarea` field is replaced by `[REDACTED-PAN]` / `[REDACTED-NIK]` before it is stored. `email` and `tel` fields are never touched.

## Deliberately not decided here

- `notify` is `{}`: WebDesk sends no notification mail for these forms. The lead and the staff alert are the ERP's (M5-L4 / L5). Setting a recipient is a later choice (it needs a mail template per tenant).
- `attachments` is not declared: the forms accept the route's default (up to 5 files, scanned). The site's forms have no file input (the onboard form's `brand_files` is a text description).
- `website_url` and `current_url` are `text`, not a URL type: WebDesk has no `url` field type, and the onboard form accepts "none".

## No Web3Forms (WSK-D75, owner 2026-10-12)

The site's forms post only to the WebDesk forms API. There is no interim Web3Forms transport for real leads: the site switch removes `WEB3FORMS_ENDPOINT`, the `access_key`/`subject`/`from_name`/`redirect` members and `PUBLIC_WEB3FORMS_KEY`/`PUBLIC_WEB3FORMS_CAPTCHA` from the build, and until the WebDesk forms are applied a form says it is not wired (the existing `formsAreLive` pattern), never falls back.
