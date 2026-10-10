# WebDesk write plane: content contract, editorial identity, authoring and read commands (WSK-62)

> **Status: PLANNED.** This is a design only. No code changed, and no ruling is landed here.
> **Date:** 2026-10-10. **Author:** architect seat (Claude Opus), ticket WSK-62.
> **Reads with:** [`webdesk-design-v2.md`](../blueprints/webdesk-design-v2.md) v2.3 (§03, §05, §09,
> §14 D37–D43), the carried v1.1 [`webdesk-design.md`](../blueprints/webdesk-design.md) §05 and §07,
> [`webdesk-independence.md`](../blueprints/webdesk-independence.md) §2–§3, the proof tracker
> [`2026-10-10-webdesk-gaiada-proof.md`](./2026-10-10-webdesk-gaiada-proof.md), and the WSK-53
> inventory (`webdesk/sites/gaiada-com/INVENTORY.md`, cited as "INV §n"; it lives on the WSK-53
> branch and is not yet on this one).
> **Proposed rulings** are in §15. Numbers are assigned when the orchestrator lands them in v2.3
> §14; this file uses R1…R4 to avoid the D37-style collision §14's numbering note records.
> **Ticket ids WSK-63…WSK-67 are new and only proposed.** The orchestrator assigns them.

---

## 0. Decisions at a glance

| # | Question | Decision | One-line reason |
|---|---|---|---|
| **A** | Where do typed field values live on the wire? | **In a `fields` block at `blocks[0]`, typed per collection by the composition.** Vocabulary 1.0.0 → **1.1.0 (MINOR)** adds the primitives `group`, `boolean` and `markdown`; `multiple` now works on every primitive; FieldDef gains `fields`, `itemKey`, `localized` and `ui`; there is one new block type, `fields`. The envelope does not change by a single byte. The 9 generic blocks do not change. | This is the only place in the frozen envelope that `breaking-change.ts` rates MINOR **and** that passes the pinned envelope-contract test (WSK-48a's gate). |
| **A′** | Draft versus live (a gap the brief did not name) | **`content_versions` is the working copy. `content_items` is the live projection that the frozen read path serves.** Publishing is the only way to change what a production key sees. | Today, editing a published item changes `/v1` at once with no publish step (0002:59-87). |
| **B** | Authoring commands (WSK-41) | 7 commands. **publish and schedule are HIGH. unpublish, delete, create, update and restoreVersion are MEDIUM in Zone B.** On the ERP side, draft writes are `low` tools and unpublish/delete are `medium` tools. Every write carries an editorial assertion. | The impact class follows public consequence and reversibility (§3.1). |
| **publish** | Impact class | **HIGH, for every principal class**, executed through **one WS4 approval that runs in-band at `decide()`**, with maker ≠ checker. Editor UX: publishing takes two people. Proposed ruling **R4** offers a narrow self-publish (owner question Q1). | It has a public, crawler-irreversible consequence, and `content.promote` is already HIGH (command-types.ts:95). |
| **C** | Read commands (WSK-51) | 8 live reads (tenants, collections, items, versions, media). No editorial assertion. Not audited. | Reads are authorised in the ERP. "Stale" is impossible by construction because every read is live. |
| **D** | Editorial assertion (WSK-40) | A compact Ed25519 JWS (`typ wd-editorial+jwt`). It is bound to the exact command and arguments (`cmh`), has a 60 s TTL (WebDesk rejects anything over 120 s), and its `jti` is consumed once in the project's queue store. The WebDesk side holds a **pinned JWKS file**. It is verified **after** layers 1–4, before validation. | No new channel and no signing key on the delivery surface (D39). The cheaper layers refuse requests without writing to the store. |
| **E** | Cerbos (WSK-47) | **Two kinds now** (`webdesk_content_item`, `webdesk_collection`) with 10 keys. `webdesk_media_asset` moves to WSK-43. Maker-checker sits in the policy as an inline ALLOW condition plus a `roles: ["user"]` DENY, following the invoice precedent. | A kind with no handler is a grant nothing can serve. |
| **F** | M1 loader principal | **An ERP-side automation principal (a `users` row) over the real control channel.** It writes drafts with editorial assertions like any other principal and files **one** batch-publish WS4 approval, which the owner decides. **No in-box CLI write path.** | That would be a second write path that skips layers 1–4 and the ERP's Cerbos. Nothing in M1 needs it, because parity work runs against dev-stack fixtures. |
| **G** | Publish → rebuild (P-2) | **GitHub Actions in the site repo**, started by `workflow_dispatch` from the ERP's `gaiada-erp` App through the GitHub chokepoint. The `deploy` is authorised by the **publish approval itself**. It deploys to delphi through a forced-command deploy user. Estimated **$0–2/month**, about 3–6 min from publish to live. | Every alternative host is ruled out, either by an existing ruling (aicenter, sumopod) or by role and disk (delphi). See §9. |
| **H** | UI (WSK-44) | A **"Website"** craft group in the Web Dev console → **Content** → site → collection → item editor. Every degraded state (unavailable, conflict, pending approval, rebuild) is rendered explicitly. | dept-interface template; an empty list is a claim. |
| **new** | The control channel does not exist end to end yet | **WSK-63:** mTLS terminates at a **dedicated internal host-nginx vhost**. WSK-63 also delivers the ERP egress client (the half WSK-23 never shipped) and the owner actions. On the critical path of **both** milestones. | `/control/*` is 404 on the only proxy, and no ERP caller exists (§1, rows 11–14). |

---

## 1. Ground truth that constrains this design (read from this branch on 2026-10-10)

| # | Fact | Evidence |
|---|---|---|
| 1 | The item envelope must have **exactly** 7 top-level keys and `meta` exactly 4. `meta.x` must be `{}` when no fallback happened. This is WSK-48a's byte-identical gate. | `payload/test/envelope-contract.test.mjs:179`, `:185`, `:287` |
| 2 | Any added or removed envelope path is **unconditionally MAJOR**. `meta.x` and `seo` are opaque leaves. Arrays are leaves, so the content of `blocks` is invisible to the envelope rule. | `payload/vocabulary/breaking-change.ts:190-205`, `:148-153` |
| 3 | "Any future field addition here is itself a MAJOR vocabulary change unless it lands inside `meta.x`." | `payload/vocabulary/envelope.ts:7-9` |
| 4 | A block is `{type: string, props}`. An unknown type is *valid* and is skipped by the renderer. | `envelope.ts:269`; `blocks.ts:283-286` |
| 5 | `content_items` has no field-value column, no draft/live split and no version pointer. **Editing a published item changes `/v1` at once.** | `migrations/0002_content.sql:59-87` |
| 6 | `content_versions` is append-only, and `created_by` is "Zone A principal id, opaque". | `0002_content.sql:119-134` |
| 7 | Production keys see effective-published rows. **Staging keys see every row, drafts included.** In one instance, content has no environment axis. | `payload/collections/content-read.ts:300`; `0008_promotion.sql:145-158` |
| 8 | `/v1` lists are ordered by `(created_at, id)`. There is no editorial order. | `content-read.ts:380` |
| 9 | Codegen has no wire location for composition `fields` ("informational only"). Codegen already maps **any** `multiple` field to an array, but the validator ignores `multiple` for scalars. | `api/src/codegen/generator/openapi-builder.mts:177-192`; `vocabulary-field-schema.mts:364-367`; `payload/vocabulary/primitives.ts:52-53` |
| 10 | The NestJS api **cannot import** `payload/vocabulary/**` (ESM `.ts` imports under CJS `tsc`). Vendored copies exist with drift checks. | `api/src/codegen/contract-manifest.types.ts:6-9`; `api/src/schema-draft/vocabulary-vendor.ts`; `blocks/scripts/vendor-vocabulary.mjs` |
| 11 | WebDesk's layer 1–4 verifiers exist, but the only proxy **404s `/control/*`**, and no component terminates mTLS. | `proxy/Caddyfile:90-92`; `api/README.md` "WSK-22 … Owner actions required" |
| 12 | **There is no ERP caller.** The contract fetch is "a STUB of the real four-layer control channel". Every WSK-31 route returns 501. There is no `webdesk-control` Keycloak client, no client cert, and no WS4 minting in platform-nest. | `platform-nest/src/config.ts:639-655`; `modules/webdev/webdesk-control.controller.ts:9-18` |
| 13 | The real authenticator marks **every** caller `automation: true`, so WebDesk cannot tell a human from a machine. | `api/src/control/auth/real-control-channel-authenticator.ts:182-192` |
| 14 | Layer 4: HIGH ⇒ a WS4 assertion, always. The single-use race is still open (plain index). Idempotency and jobs are in-memory. | `control/policy/real-policy-decision-point.ts:51-63`, `:101-111`; `control/idempotency/idempotency-store.ts:4-16`; `control/jobs/jobs.service.ts:5-6` |
| 15 | WSK-31's HIGH endpoints **trust the hub's gate**, so a BFF caller would skip WS4. Publish cannot reuse that shape. | `webdesk-control.controller.ts:48-54` |
| 16 | **In-band approval execution exists:** `decide()` executes as the decider, with `approvalId` passed into Cerbos. | `core/automation-approvals.controller.ts:299`, `:481-483`; `core/github/repo-creation.ts:132-162` |
| 17 | Every ERP→GitHub write passes the chokepoint, and `deploy` is D14-gated (approvalId required). | `cerbos/policies/resource_github_repo.yaml` (deploy rule); `core/github/ledger.ts:53` |
| 18 | The site builds **on the laptop** and ships `dist/` to delphi **as root**. delphi's root filesystem is about 92% full. The repo is `gaiadabali/gaiada-web-revamp` and has no workflows. | `gaiada-web-revamp/scripts/deploy-staging.sh:6-19`; `git remote -v` |
| 19 | 315 pages (235 EN, 80 ID), 79 built. Sections are chosen at build time by heading, position or shape. 33 config modules use 5 bilingual conventions, and EN/ID often differ in structure. 238 tokens, 4,450 `[CONFIRM:]` and 486 `[CLIENT:]`. URLs are not `/{collection}/{slug}`. | INV §2, §4, §5, §8 |
| 20 | The tenant-webhook kinds are `form.received` only, **but the column has no value CHECK**, so widening needs code only. The payload cap is 64 KiB. | `api/src/tenant-webhooks/tenant-webhook-event.types.ts:11`; `0006_tenant_webhooks.sql:82-86`; `tenant-webhooks.config.ts:65-66` |

---

## 2. Decision A: the content-model contract

### 2.1 The decision, and what was rejected

**Typed values travel as one block, `{"type":"fields","props":{…}}`.** It is always `blocks[0]` when
the collection's composition declares `fields`, and that composition types it. Vocabulary
blocks may follow it when the composition allows them. This is the orchestrator's "item-level
field-value member", realised inside `blocks` because that is the only place the frozen contract
allows it.

| Option | Verdict | Why |
|---|---|---|
| (i) New shared block types per gaiada section | Rejected | The vocabulary is platform-wide. 101 site-specific bindings (INV §8.2) would each need the §05 governance round and a shared renderer component nobody else uses, and the site chooses sections at build time anyway. |
| (ii) A top-level `fields` envelope member | **Rejected** | MAJOR by `breaking-change.ts:190-205`, which means `/v2`. It also fails `envelope-contract.test.mjs:179`, WSK-48a's byte gate. **This contradicts D41's parenthetical "(a migration plus an envelope MINOR)".** The code's own classifier disagrees with D41, so this is flagged as a conflict (R1 corrects the text), not silently overridden. |
| `meta.x.fields` | Rejected | Fails `envelope-contract.test.mjs:287` (`meta.x` must be `{}`), and puts content into the metadata namespace. |
| `seo.<x>` (the redirect precedent) | Rejected | Neutral for both the classifier and the test, but `seo` already has a job: title and description feed `search_vector` (0002:99-105). The brief also names the redirect parking as the defect. |
| **`fields` block** | **Chosen** | MINOR (a new block type). The envelope shape is untouched. Old renderers skip it under hard rule 2. Codegen already narrows `blocks` per collection. `content_versions.blocks` versions it with no new value column. |

### 2.2 Vocabulary 1.1.0: exact shapes

```ts
// payload/vocabulary/primitives.ts
export type PrimitiveName = 'text' | 'richtext' | 'media' | 'relation' | 'number' | 'date' | 'select' | 'geo'
  | 'group' | 'boolean' | 'markdown'                          // 1.1.0

export interface FieldDef {
  name: string                 // ^[A-Za-z][A-Za-z0-9_]{0,63}$ (snake_case allowed: source keys are kept verbatim)
  primitive: PrimitiveName
  required?: boolean           // "present": not null/undefined. [] still satisfies a required multiple (unchanged semantics)
  options?: string[]           // select
  relationTo?: string          // relation
  multiple?: boolean           // 1.1.0: honoured for EVERY primitive. The value is an ordered array
  fields?: FieldDef[]          // 1.1.0: group only, required and non-empty. Depth ≤ 4
  itemKey?: string             // 1.1.0: group + multiple only. Names a required `text` sub-field whose values are unique in the list
  localized?: boolean          // 1.1.0: default true. false = locale-neutral; the default-locale item's value is authoritative
  ui?: { label?: string; help?: string; readOnly?: boolean; widget?: 'input' | 'textarea' | 'code' }  // 1.1.0: editor-only
}
```

* `group` is a nested object. Its value is `{ [sub.name]: value }`, closed: unknown keys are a violation.
  `group` with `multiple` is a list of objects, ordered, with optional identity via `itemKey`.
* `boolean` is JSON `true`/`false`. The redirect collection keeps its `'true'|'false'` select (§2.7).
* `markdown` is a CommonMark + GFM source string, stored **verbatim** and never normalised.
  It is deliberately a **primitive** and not `richtext` + `format: markdown`. A new FieldDef key is
  invisible to today's classifier, so it would be mis-rated PATCH. Older consumers already treat a
  `richtext` string as "plain text", which would cause a silent semantic mismatch. OQ-3.1 (the
  WYSIWYG `richtext` format, WSK-45) stays independent.

```ts
// payload/vocabulary/composition.ts
export interface CollectionComposition {
  fields?: FieldDef[]          // present ⇒ every item carries blocks[0] = { type: 'fields', props }
  blocks?: BlockType[]         // vocabulary blocks allowed AFTER the fields block. 'fields' may never be listed
  singleton?: boolean          // 1.1.0: at most one non-deleted item per locale
  localized?: boolean          // 1.1.0: default true. false ⇒ items exist only in the tenant default locale
  ui?: { label: string; description?: string; group?: string; order?: number; titleField?: string }
  lint?: { placeholders?: PlaceholderRule[] }                 // 1.1.0: advisory, see §2.5 rule 8
}
export type PlaceholderRule =
  | { kind: 'token'; open: string; close: string
      registry?: { collection: string; listField: string; keyField: string; valueField: string } }
  | { kind: 'marker'; open: string; close: string; label: string }
```
Delimiters are literal strings and no regex is allowed, so a tenant-declared pattern cannot cause ReDoS.

**New block:** `BLOCKS.fields = { type: 'fields', fields: [] }`. Its props are typed by the
composition, not the vocabulary, and `validateBlock` stays unchanged (it treats `fields` as a known block with no vocabulary props).
A new composition-aware check lives in **`payload/vocabulary/item-fields.ts`**:

```ts
export const FIELDS_BLOCK_TYPE = 'fields'
export interface ItemIssue { path: string; message: string; expected?: string }   // JSON-pointer path, e.g. /blocks/0/props/faq/2/answer
export function validateFieldValues(fields: FieldDef[], props: unknown, path?: string): ItemIssue[]
export function validateItemContent(composition: CollectionComposition, blocks: unknown): { valid: boolean; issues: ItemIssue[] }
export function fieldsBlockOf(blocks: unknown): Record<string, unknown> | null
```
`validateItemContent` enforces the following:
* a `fields` block exists **iff** `composition.fields` is declared, it is at index 0, and it appears once;
* the remaining blocks are in `composition.blocks` (absent means every vocabulary block except `fields`);
* props are closed, typed, recursive and depth-checked;
* `itemKey` values are unique per list;
* scalar `multiple` values are arrays.

### 2.3 Rating every extension with `breaking-change.ts`

`classifyVocabularyChange` snapshots `{primitives, blocks, envelopeShape}`. It cannot see FieldDef keys,
composition keys or which primitives accept `multiple`. Where it is blind it would under-rate a change, so
WSK-64 **extends the snapshot first** (row 9). The vocabulary diff is then *computed*, as §05 requires.

| # | Extension | Output of today's classifier | Honest rating | Classifier work (WSK-64) |
|---|---|---|---|---|
| 1 | `group` primitive + `FieldDef.fields` | `minor` ("primitive "group" added") | **MINOR** | `diffFieldDefs` must **recurse** into `fields`. Otherwise removing a sub-field inside a group is rated `patch`, a hidden MAJOR. |
| 2 | list of objects (`group` + `multiple`, `itemKey`) | covered by row 1 | **MINOR** | An `itemKey` change is MAJOR (identity changes). A `multiple` flip is already MAJOR (`breaking-change.ts:120-125`). |
| 3 | `boolean` primitive | `minor` | **MINOR** | none |
| 4 | `markdown` primitive | `minor` | **MINOR** | none |
| 5 | `multiple` honoured for every primitive | `patch` ("no structural change"): **blind** | **MINOR** (a new capability) | Add `multipleCapable: PrimitiveName[]` to the snapshot. Widening is MINOR, narrowing is MAJOR. **No shipped composition declares a scalar `multiple`.** I checked: grep finds `multiple: true` only on media/relation in `blocks.ts` and `blocks/src/types.ts`, so no stored value changes validity. Codegen already published these as arrays (fact 9). |
| 6 | `fields` block type | `minor` ("block type added") | **MINOR** | Document `fields` as the one composition-typed block. |
| 7 | `FieldDef.localized` | blind | **MINOR** (new optional key; no wire change) | Snapshot `fieldDefKeys`. A tenant-level flip true→false is MAJOR (consumers lose non-default values); false→true is MINOR. |
| 8 | `FieldDef.ui`, composition `ui`, `lint`, `singleton`, `localized` | blind | **MINOR** at vocabulary level (new optional keys). Tenant-level `ui` edits are **PATCH** (descriptive) | Snapshot `compositionKeys`. Tenant diff: `ui` changes → patch; `singleton`/`localized` flips → MAJOR. |
| 9 | Envelope | unchanged: no path added | — | `envelope.ts` is **not edited**. A test asserts `currentEnvelopeShapeSignature()` is byte-identical to the 1.0.0 snapshot. |

**Result: `classifyVocabularyChange(v1.0.0-snapshot, current) → minor` with exactly rows 1–8 as reasons.**
`VOCABULARY_VERSION = '1.1.0'`. `validateTenantComposition({vocabularyVersion: '1.0.0'})` validates
against 1.1.0, because a MINOR is a superset. A requested version newer than the current one is refused.
On the tenant-contract axis, gaiada's first apply adds every collection, which is MINOR, so the initial contract is 1.0.0.

### 2.4 Wire shapes (exact JSON)

**(a) A long-form page.** `GET /v1/t/gaiada/service/service.seo?locale=en` with a production key:
```json
{
  "collection": "service",
  "slug": "service.seo",
  "locale": "en",
  "localizations": [{ "locale": "id", "slug": "service.seo" }],
  "seo": { "title": "SEO Agency Bali | Gaia Digital Agency",
           "description": "SEO Agency Bali for hotels, villas and restaurants. Clear pricing, proven results, built for Google & AI search. Get a free audit from Gaia Digital Agency." },
  "meta": { "publishedAt": "2026-10-20T03:12:44.120Z", "updatedAt": "2026-10-20T03:12:44.120Z", "draft": false, "x": {} },
  "blocks": [
    { "type": "fields", "props": {
        "url": "/services/seo/",
        "source_path": "content/en/services/seo.md",
        "template": "service",
        "section": "service",
        "language": "en-GB",
        "h1": "SEO Agency Bali",
        "primary_keyword": "seo agency bali",
        "phase": "L",
        "schema": ["Service", "OfferCatalog", "FAQPage", "AggregateRating"],
        "hreflang_id": "/id/services/seo/",
        "author": "[CONFIRM: author name and role]",
        "last_updated": "{{PUBLISH_DATE}}",
        "publish_ready": false,
        "schema_notes": "Service:\n  name: \"SEO\"\n  provider: \"Gaia Digital Agency\"\n…",
        "image_alt_texts": ["SEO Agency Bali team reviewing Google Search Console data for a hotel client in Ubud",
                            "Five-step SEO process diagram used by Gaia Digital Agency for Bali hospitality clients"],
        "visibility": "shown",
        "plan": { "action": "SHOW", "to": "", "why": "…" },
        "body": "# SEO Agency Bali\n\nGaia Digital Agency is an SEO agency in Bali that helps hotels …"
    } }
  ]
}
```
Its composition is: `{ fields: [url text!, source_path text! ui.readOnly, template select!, section text!, language text!, h1 text,
primary_keyword text, phase select!, schema text multiple, hreflang_id text, hreflang_en text, author text,
last_updated text, publish_ready boolean!, schema_notes text ui.widget=code, image_alt_texts text multiple,
visibility select!, plan group{action select!, to text, why text}, body markdown!], blocks: [], ui: {label:"Service pages",
group:"Pages", titleField:"h1"}, lint: {placeholders: [token {{ }} → token-registry, marker [CONFIRM: ], marker [CLIENT: ]]} }`.

**(b) A per-locale singleton global with locale-neutral members.** Navigation in `en`:
```json
{ "collection": "navigation", "slug": "navigation", "locale": "en",
  "localizations": [{ "locale": "id", "slug": "navigation" }], "seo": {}, "meta": { "…": "…" },
  "blocks": [{ "type": "fields", "props": {
    "primary": [
      { "key": "services", "label": "Services", "hub": "All services", "url": "/services/",
        "children": ["/services/ai-search-optimization/", "/services/branding/"] } ],
    "cta": { "label": "Get your free audit", "url": "/free-audit/" } } }] }
```
Here `primary` is `group multiple itemKey:"key"`, and `key`, `url` and `children` are `localized:false`. The `id` item carries
`"label":"Layanan","hub":"Semua layanan"` with identical neutral members.

**(c) A locale-neutral global.** `company` has `{singleton:true, localized:false}`, so it is one `en` item:
`props = { name, legal_name, domain, address: {street, locality, region, country, full}, phone, email, people: [...],
founding_date, founder, certifications, aggregate_rating, same_as: [...], area_served: [...], languages: [...],
default_locale, price_currency: [...], boilerplate_short }`. These are the INV §6.1 keys, verbatim.

**(d) A config section whose structure differs by locale.** `home-how-we-work` is a singleton. The EN item's
`stages` has 5 entries starting at "Free audit". The ID item's `stages` has 5 different entries starting at
"Konsultasi gratis". The two lists are independent. No `{en, id}` value ever appears.

### 2.5 Modelling rules (binding on WSK-53, WSK-54 and WSK-55)

1. **One item per locale.** Twins share `localization_group_id` (created with `twinOf`). Per-locale structures are
   independent. Values never contain `{en, id}` objects. All 5 of the site's bilingual conventions (INV §4) map to this.
2. **Locale-neutral data** uses `localized:false`, either on the collection (one default-locale item) or on a field
   (the default-locale item's value is authoritative, consumers ignore non-default copies, and the editor
   renders them read-only and writes the default value through). WebDesk validates shape only. This is documented as advisory.
3. **Order belongs to the list that places items, never to an item.** Ordered placements are `multiple` fields
   inside the placing item: the home hero's paint order, footer order and nav order (INV G6). Collections of documents
   have no editorial order, and consumers sort by a field. Never depend on `/v1` list order.
4. **No free-form maps.** A dynamic-key record (`LIFE`, the token registry) becomes `group multiple` + `itemKey`.
   jsonb reorders object keys, so decoders iterate composition order and list order only.
5. **Paths, keys and links are text.** The steer's `path` field is the frontmatter's `url`, with the source key kept verbatim. The site owns routing, link rewriting, `sitemap.xml` and `llms.txt` (INV G9, G12).
   WebDesk's own `/v1/…/sitemap.xml` assumes `/{collection}/{slug}` and is not used by gaiada.com.
6. **Stable ids.** The item slug is the INV §9 id (`home`, `company.about`, `service.local-seo`,
   `post.aeo-vs-seo-vs-geo`). It is shared by twins and **immutable after create**. The slug grammar is
   `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`, ≤ 200 characters (the `redirect` system collection is exempt). Section and list ids are
   `itemKey` values. The item uuid is internal (it surfaces only in the `i:` Cache-Tag).
7. **Visibility** is the reserved field `visibility ∈ {shown, seo-only, held, hidden}`, from the handoff's own words.
   It is allowed on page collections and on any group, and is **orthogonal to `publish_state`**: an imported HOLD page is
   `published` + `held`, so a preview build sees it without seeing real drafts. The page plan's six actions
   (`plan {action,to,why}`) are carried losslessly while the parity gate runs, and the owner rules on retiring them (Q7).
8. **Placeholders stay verbatim.** The composition's `lint.placeholders` declares the three syntaxes. WebDesk computes an
   **advisory** report (`unresolvedTokens`, marker counts) on every save and on publish. The registry is the
   `token-registry` singleton. It **never blocks**, because all 315 pages carry placeholders today and the git site renders
   them. A hard publish gate needs an owner ruling (Q6).
9. **`seo.title` and `seo.description` are the page title and description.** No duplicate fields.
10. **Store sources, never authored derivations.** pages.json's computed columns, token occurrence stats, OG cards and
    page-plan.json are regenerated by the site. Where the site reads a derived file and nothing in the build regenerates
    it, the importer carries the values as `ui.readOnly` fields until WSK-55 regenerates them (its AC).
11. **Design stays in git.** A composition contains only the members INV classes as "CMS content/global". Design members
    are joined back by key in the site.

### 2.6 The write-side storage model (versions and projection)

| State | `content_items` holds (served by the frozen read path) | Writes |
|---|---|---|
| draft / unpublished (`published_version IS NULL`) | the **head** version, so staging keys see the latest draft as today's contract test expects | create/update/restore append version *n+1*, bump `head_version` and **re-project** |
| published / scheduled | the **published** version | update/restore append *n+1* and bump `head_version` **only**. Live content is untouched |
| publish(v) | projection := v, `published_version` := v, `publish_state` := `published` | the only path to production visibility |

`updated_at` changes **only when the projection changes**, which keeps sitemap `lastmod` and the build stamp in §9 honest.
The read SQL is **not edited**, so WSK-48a's port stays byte-identical.

**Migration `webdesk/migrations/0009_content_write_plane.sql`.** This is a sketch; senior-db owns the final text.
```sql
-- No SELECT-based preconditions: under FORCE RLS with no tenant GUC the migrator sees ZERO rows and they would
-- pass silently (the estate's RLS zero-row trap). Each UNIQUE INDEX build IS the precondition, because index builds
-- read the heap, not the policies, and fail loudly on duplicates.
ALTER TABLE content_items
  ADD COLUMN head_version      integer NOT NULL DEFAULT 0 CHECK (head_version >= 0),
  ADD COLUMN published_version integer CHECK (published_version IS NULL OR published_version >= 1),
  ADD COLUMN deleted_at        timestamptz,
  ADD COLUMN last_published_at timestamptz,
  ADD COLUMN last_published_by text;            -- opaque principal, attribution only
-- Deliberately NO cross-column CHECK tying publish_state to published_version: payload/test/v1-fixtures.mjs seeds
-- published rows directly, and the envelope-contract gate must keep passing untouched.
-- Site-scoped on purpose: localization groups belong to one site, and a same-database bundle copy (promotion tests)
-- legitimately reuses group ids on another site.
CREATE UNIQUE INDEX ux_content_items_group_locale ON content_items (site_id, localization_group_id, locale) WHERE deleted_at IS NULL;

ALTER TABLE content_versions
  ADD COLUMN content_hash text,                  -- sha256 hex of canonical {blocks, seo}; NULL only on pre-0009 rows
  ADD COLUMN note         text CHECK (note IS NULL OR length(note) <= 500),
  ADD COLUMN attribution  jsonb NOT NULL DEFAULT '{}'::jsonb;   -- {pk, agt?, req?, apr?}, opaque

-- Closes WSK-22's documented WS4 single-use race. Idempotent replays write `.replay` audit rows, which are excluded.
CREATE UNIQUE INDEX ux_audit_entries_ws4_once ON audit_entries (ws4_approval_id)
  WHERE ws4_approval_id IS NOT NULL AND action NOT LIKE '%.replay';

CREATE TABLE control_idempotency_keys (           -- durable store; WSK-21's flagged in-memory gap
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),           -- NULL = platform-level command
  scope_key text NOT NULL, command text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_flight','completed')),
  response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days');
CREATE UNIQUE INDEX ux_idem_tenant   ON control_idempotency_keys (tenant_id, scope_key) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX ux_idem_platform ON control_idempotency_keys (scope_key)            WHERE tenant_id IS NULL;
ALTER TABLE control_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON control_idempotency_keys FOR ALL
  USING      ((tenant_id IS NOT NULL AND tenant_id = webdesk_tenant_ctx()) OR (tenant_id IS NULL AND webdesk_platform_ctx()))
  WITH CHECK ((tenant_id IS NOT NULL AND tenant_id = webdesk_tenant_ctx()) OR (tenant_id IS NULL AND webdesk_platform_ctx()));
```
Pre-0009 rows (`head_version = 0`) are **adopted on first write**: the service first writes version 1 from the current
projection. No backfill DML runs in the migration. Tenant webhooks need no DDL (fact 20).

### 2.7 Explicitly unchanged

The envelope, the 9 blocks, the read SQL, the Cache-Tag scheme, the codegen determinism gate and the `redirect` collection's
`seo.redirect` storage (`redirects.ts:42-80`) all stay as they are. `redirect` is a **system collection**: the write path stores its `fields` props
under `seo.redirect` with string-typed `status`/`active` and `blocks: []`, because `listRedirects` and WSK-48a's port read
it there. That is one documented special case: `fieldsCarrierFor('redirect') = 'seo.redirect'`.

---

## 3. Decision B: authoring commands (WSK-41, in Zone B)

### 3.1 Registry additions (`api/src/control/command-types.ts`)

All routes are under `/control/v1/tenants/:tenantSlug/sites/:siteId`. All writes need `Idempotency-Key` and an editorial assertion.

| Command | Route | Impact | Scope | Layer 4 WS4 | ERP MCP tool (impact) | Why this class |
|---|---|---|---|---|---|---|
| `content.create` | `POST /content/items` | medium | `webdesk:operate` | no | `webdesk.content.create` (**low**) | A draft, never live |
| `content.update` | `PUT /content/items/:itemId` | medium | operate | no | `webdesk.content.update` (low) | Writes a version; live is untouched (§2.6) |
| `content.restoreVersion` | `POST /content/items/:itemId/restore` | medium | operate | no | `webdesk.content.restoreVersion` (low) | Creates a new draft from an old version |
| `content.publish` | `POST /content/publish` | **high** | `webdesk:promote` | **yes** | none: in-band WS4 only (§6). The request tool is `webdesk.content.requestPublish` (low) | Public and crawler-irreversible; `content.promote` is already HIGH |
| `content.schedule` | `POST /content/schedule` | **high** | promote | **yes** | via `requestPublish` with `publishAt` | A deferred publish |
| `content.unpublish` | `POST /content/items/:itemId/unpublish` | medium | promote | no | `webdesk.content.unpublish` (**medium**) | Reduces exposure and is fully restorable. A takedown **must not wait** for a second human |
| `content.delete` | `POST /content/items/:itemId/delete` | medium | promote | no | `webdesk.content.delete` (medium) | A soft delete of a **non-live** item only. History is kept and an operator can reverse it. A *hard* delete would be HIGH and is not designed here |
| `schema.apply` (changed) | existing | medium | operate | no | existing tool, re-pointed | Now validates the composition (422) and returns `{bump, reasons}`. It **refuses `major`** (409 `contract-major-change`) until WSK-42 governs it |

There is also `EDITORIAL_COMMANDS: ReadonlySet<CommandName>`, the 7 `content.*` writes. Every content service
method takes an `EditorialPrincipal` parameter, so a route that forgets the guard fails to compile, and the registry spec
pins the set. The existing rule "every HIGH command uses promote or keys" holds.

### 3.2 Request and response JSON

```jsonc
// content.create — body. 201 → ItemWriteResult
{ "collectionKey": "service", "locale": "en", "slug": "service.seo",
  "twinOf": null,                          // or an itemId in the same collection, other locale (joins its localization group)
  "fields": { /* required iff the composition declares fields */ },
  "blocks": [ /* optional vocabulary blocks after the fields block */ ],
  "seo": { "title": "…", "description": "…" }, "note": "import 3f2a…" }
// ItemWriteResult
{ "item": { "itemId": "…", "collectionKey": "service", "locale": "en", "slug": "service.seo",
            "localizationGroupId": "…", "headVersion": 1, "publishedVersion": null, "publishState": "draft",
            "publishAt": null, "unpublishAt": null, "deletedAt": null, "updatedAt": "…" },
  "version": { "version": 1, "contentHash": "…", "createdAt": "…" },
  "unchanged": false,                       // update/restore: true when the content hash equals head (no version written)
  "lint": { "placeholders": { "unresolvedTokens": ["{{RESULT_1_METRIC}}"], "markers": { "CONFIRM": 3, "CLIENT": 1 } } },
  "replayed": false }

// content.update — PUT body (full replacement; the editor sends the whole record). 200 → ItemWriteResult
{ "baseVersion": 4, "fields": { }, "blocks": [ ], "seo": { }, "note": "fixed FAQ 3" }
// content.restoreVersion — 200 → ItemWriteResult
{ "version": 2, "baseVersion": 4, "note": "back to the approved wording" }

// content.publish — 1..1000 items, one transaction. 200
{ "items": [ { "itemId": "…", "version": 5 } ], "note": "…" }
→ { "published": [ { "itemId": "…", "collectionKey": "service", "locale": "en", "slug": "service.seo",
                     "version": 5, "publishedAt": "…" } ], "replayed": false }

// content.schedule — 200 → { "scheduled": [ … ] }
{ "items": [ { "itemId": "…", "version": 5 } ], "publishAt": "2026-11-01T00:00:00Z", "unpublishAt": null }
// rules: a future publishAt requires the item NOT live (409 schedule-live-item-requires-worker until WSK-61);
//        publishAt null + unpublishAt requires a live item (a scheduled takedown); the frozen read path honours both by time.

// content.unpublish — 200 → { "item": { … } }
{ "expectedPublishedVersion": 5 }
// content.delete — non-live only. 200 → { "item": { …, "deletedAt": "…" } }
{ "baseVersion": 4 }
```
Bodies may **not** contain the keys `tenantSlug`, `siteId` or `itemId` (400). The command hash merges route parameters and the
body (`command-authorization.guard.ts:43-46`), and a colliding key would make the hash ambiguous across the two sides.

### 3.3 Semantics

* **Gate order** (pinned by tests): L1 mTLS → L2 Keycloak token → L3 scope → L4 WS4 (HIGH) → **L2e editorial
  assertion** (verify, then consume `jti`) → validation (shape → composition → state) → one transaction.
  **Denial tests send valid bodies**, and a positive control with the same body succeeds. This avoids the "validation pre-empts
  authz" trap.
* **Concurrency:** `SELECT … FOR UPDATE` on the item. If `baseVersion ≠ head_version`, return 409 `version-conflict`
  `{currentHeadVersion, currentContentHash, updatedAt}`. `UNIQUE (content_item_id, version)` is the backstop.
* **One transaction** holds the version insert, the projection update and **the audit row**. For the new commands this, together with the
  0009 unique index, closes the WS4 single-use race fully. Older commands keep their after-the-fact audit, which is documented.
* **Idempotency:** the durable store (0009), scope `${tenantSlug}:${command}:${key}`, request hash =
  `computeCommandHash`. A replay returns the stored response with `replayed:true`. Reusing a key with a different hash returns 409.
  **Every HTTP retry carries a fresh editorial assertion** (the `jti` is single-use) and the same `Idempotency-Key`. A retried HIGH
  command cannot re-present a consumed WS4 assertion, so the ERP **reconciles by reading item state** (WSK-51) instead.
  This is WSK-22's retry-safety note, applied.
* **Validation:** `validateItemContent`, the slug grammar, `locale ∈ tenant.locales` (and `= default` when `localized:false`),
  singleton (lock the collection row), `twinOf` (same collection, a free locale in the group), size caps (props ≤ 512 KiB per
  item, ≤ 256 KiB per markdown value). Lint is computed and returned, never fatal.
* **Content hash** is `sha256(canonicalize({blocks, seo}))` using `ws4-assertion.ts`'s `canonicalize`.
  **search_text** is the string leaves of `blocks`, ≤ 64 KiB.
* **After commit (fail-soft):** tenant-webhook kinds `content.published`, `content.unpublished` and `content.scheduled`, with ≤ 100 item
  refs `{itemId, collectionKey, locale, slug, version}` per event and **no values**. The Cache-Tag set
  (`t:`/`c:`/`i:`) is logged as `content.cache_invalidate`. No CDN fronts `/v1` on `api.gaiada.online`, and WSK-27
  wires the purge later.
* **Audit:** action `control.content.<cmd>`, actor = editorial `sub`, `ws4_approval_id` on HIGH commands.
  `content_versions.created_by` = `sub`, and `attribution` = `{pk, agt?, req?, apr?}`.

### 3.4 Errors

Problem types are RFC 9457, with `type = https://webdesk.gaiada.online/errors/<slug>`. Cross-tenant misses are always a uniform 404, so there is no existence oracle.

| Status | Slugs |
|---|---|
| 400 | `invalid-request` (shape, reserved keys) |
| 401 | `editorial-assertion-missing` · `-malformed` · `-unknown-key` · `-invalid-signature` · `-claims` · `-expired` · `-replayed` |
| 403 | `editorial-assertion-scope-mismatch` · `editorial-assertion-command-mismatch` · existing L3/L4 refusals |
| 404 | `item-not-found` · `collection-not-found` · `site-not-found` |
| 409 | `version-conflict` · `idempotency-key-reused` · `slug-taken` · `twin-locale-taken` · `singleton-exists` · `item-is-live` · `item-deleted` · `not-live` · `published-version-changed` · `version-not-found` · `schedule-live-item-requires-worker` · `contract-major-change` |
| 413 | `payload-too-large` |
| 422 | `composition-violation` `{issues:[{path,message,expected}]}` |
| 503 | `editorial-replay-store-unavailable` · `editorial-keys-not-configured` |

---

## 4. Decision C: read commands (WSK-51, in Zone B)

All of these are `read` / `webdesk:read`. None needs an editorial assertion, and none is audited (the precedent is WSK-21's job polls). They return **editor projections**, not `/v1`
envelopes, because the editor needs the state the envelope hides.

| Command | Route | Returns |
|---|---|---|
| `tenant.list` | `GET /control/v1/tenants?companyRef=<uuid>` | `{tenants:[{slug,status,defaultLocale,locales,sites:[{siteId,name,kind,environments:[{envId,name,domain,status}]}]}]}` (platform context; filtered by `company_ref`) |
| `collection.list` | `GET …/sites/:siteId/collections` | `{collections:[{key,composition,vocabularyVersion,counts:{items,byLocale,live,pendingChanges},updatedAt}]}` |
| `collection.get` | `GET …/sites/:siteId/collections/:key` | `{key,composition,vocabularyVersion,updatedAt}` |
| `item.list` | `GET …/collections/:key/items?locale=&state=draft\|live\|scheduled\|unpublished\|deleted\|pending&q=&cursor=&limit≤100` | `{items:[ItemSummary],page:{cursor,hasMore,limit}}`, ordered by `slug, locale, id` (editor order, not `/v1`'s) |
| `item.get` | `GET …/content/items/:itemId?version=head\|live\|<n>` | `{item, version:{n,contentHash,createdAt,createdBy,attribution,note,blocks,seo}, live:{…}\|null, group:[{locale,itemId,slug,headVersion,publishedVersion,publishState}], lint}` |
| `item.versions` | `GET …/content/items/:itemId/versions?cursor=&limit≤100` | `{versions:[{version,contentHash,createdAt,createdBy,attribution,note}],page}` |
| `item.versionGet` | `GET …/content/items/:itemId/versions/:n` | the full version (`blocks`, `seo`) |
| `media.list` | `GET …/sites/:siteId/media?cursor=&limit=&mime=` | `{assets:[{assetId,bucketKey,mime,sizeBytes,scanStatus,createdAt}],page}` |

`ItemSummary` = `{itemId, slug, locale, localizationGroupId, title, headVersion, publishedVersion,
publishState, publishAt, unpublishAt, deletedAt, updatedAt, headCreatedAt, headCreatedBy, pendingChanges}`.
`title` comes from `seo.title`, else `fields[ui.titleField]`. Every content read in the console is now **live**. A failed read is a typed
503 at the BFF and is never `[]`. `tenant.list` also makes the WSK-23 site registry live, as a follow-up.

---

## 5. Decision D: the editorial assertion (WSK-40)

**What it proves:** "The ERP's Cerbos authorised principal *sub* to run command *cmd* with exactly these arguments, just now, once."

```jsonc
// header
{ "alg": "EdDSA", "typ": "wd-editorial+jwt", "kid": "wde-2026-10" }
// payload
{ "iss": "urn:gaiada:erp:webdev", "aud": "urn:gaiada:webdesk:control",
  "sub": "<ERP users.id>",          // opaque to WebDesk (D39)
  "pk":  "human",                   // human | automation | agent  (attribution only, never authorisation)
  "agt": "<persona>",               // present iff pk = agent
  "ten": "gaiada", "site": "<siteId>",            // must equal the route
  "cmd": "content.update",                        // must equal the route's @Command
  "cmh": "<sha256 hex>",                          // computeCommandHash(cmd, params ∪ body), same function as WS4
  "req": "<ERP users.id>",          // optional: original requester of an approved command
  "apr": "<approvalId>",            // HIGH only: must equal x-ws4-assertion's approvalId
  "iat": 1760000000, "exp": 1760000060, "jti": "<uuid v4>" }
```
The header is `x-webdesk-editorial-assertion: <compact JWS>`.

| Concern | Decision |
|---|---|
| Algorithm | **Ed25519 (EdDSA)** via `jose` on both sides (webdesk `jose@^5.10`, platform-nest `jose@^6.2`; compact JWS is version-neutral). `alg` is pinned. `none`, `HS*` and `RS*` are rejected, which includes the alg-confusion case where the public key is used as an HMAC secret. |
| Private key | **platform-nest only.** It is a file mount, `WEBDESK_EDITORIAL_SIGNING_KEY_FILE` (PKCS8 PEM, 0400), plus `WEBDESK_EDITORIAL_SIGNING_KID`. Never put the key in env text: the estate's PEM-in-env_file incident (`real-control-channel-authenticator.ts:42-60`). OpenBao is the target state (v1.1 §11). |
| Public key distribution | **A pinned JWKS file**, `WEBDESK_EDITORIAL_JWKS_FILE`, mounted read-only into `api`. It is shape-validated at boot (`kty:OKP, crv:Ed25519, kid, x`, 1–2 keys), and boot is refused in production when it is missing or invalid. This is the same discipline and channel class as the pinned mTLS CA: **no channel at all, no new egress.** Rejected: fetching an ERP JWKS URL (a new B→A egress), and pushing keys over the control channel (it still needs a bootstrap key, and its compromise model equals the file's). |
| Key generation | `platform-nest/scripts/webdesk-editorial-keygen.mjs` writes `editorial-signing.<kid>.pk8.pem` (ERP secret) and `editorial.jwks.json` (WebDesk mount). |
| Rotation | (1) Generate kid N+1 → (2) append its public JWK to the WebDesk JWKS and restart `api` → (3) switch the ERP to N+1 and restart → (4) after ≥ 4 min (2 × max TTL) remove kid N and restart `api`. **Emergency revocation:** remove the kid and restart `api`. Writes stop until the new key is installed, which is the intended failure mode. |
| TTL and skew | The ERP mints with **60 s**. WebDesk enforces `exp − iat ≤ 120`, `iat ≤ now + 10 s` and `exp > now − 10 s` (`clockTolerance` 10 s). NTP sync is an acceptance criterion of WSK-63, because two hosts are a future case. Today both sides are on one box. |
| Replay store | The webdesk project's queue store (`redis` service). `SET wd:edjti:<jti> 1 NX PX <exp+10s−now>`. A null reply means `replayed` (401). **If the store is unreachable, fail closed with 503**, never fail open. The Valkey 8 swap that OQ-3.3 records as resolved is not in the committed compose on this branch (P-3); the protocol is the same either way. |
| Verification order | L1 → L2 → L3 → L4 → **L2e** → validation. Running the editorial check last means the cheaper refusals never write to the store, and because `cmh` binds the body, the body that gets validated is the body that was asserted. |
| What it does not do | It does not re-derive authorisation; Cerbos decided in the ERP (D39). It does not replace the WS4 assertion; HIGH commands carry both, cross-bound by `apr`. |

**Failure modes:** missing header → 401 `-missing`; not a JWS → `-malformed`; unknown `kid` → `-unknown-key`; bad
signature or algorithm → `-invalid-signature`; wrong `iss`/`aud`/`typ` → `-claims`; expired, future or over-long lifetime → `-expired`;
`ten`/`site` ≠ route → 403 `-scope-mismatch`; `cmd` ≠ route, `cmh` ≠ recomputed or `apr` ≠ WS4 → 403
`-command-mismatch`; `jti` already seen → 401 `-replayed`; store down → 503.

**A consistency gap, flagged and not fixed here:** Layer 4's WS4 assertion is an HMAC with a key shared by both sides
(`WEBDESK_APPROVAL_ASSERTION_KEY`, v1.1 §03/§11; `ws4-assertion.ts`). D39's own reasoning ("the delivery
surface verifies but never mints") argues for moving it to the same Ed25519 signer later. It is not required for the proof.

---

## 6. Publish: impact class, the WS4 flow, and the editor UX

**Classification: `content.publish` and `content.schedule` are HIGH for every principal class.** Zone B's Layer 4 enforces this
structurally (`real-policy-decision-point.ts:55-63`). The rule is not reopened.

**Mechanism: one WS4 approval, executed in-band at `decide()`.** This follows the GH-12 shape (fact 16). The hub path is
unusable for publish, because a BFF caller would skip the hub's gate (fact 15).

```
editor (UI) / agent (MCP) / importer
  └─ POST …/content/sites/:t/:site/publish-requests {items:[{itemId,version}], publishAt?}     ← webdesk.content.requestPublish (low)
       ERP: authorize(request_publish) → read items from Zone B (WSK-51; real collection/locale attrs, live lint)
            → fileAutomationApproval(origin:'webdesk', workflow_id:'content.publish'|'content.schedule',
                                     tool_args:{tenantSlug,siteId,items[{itemId,version,contentHash}],publishAt?,rebuild:'staging'},
                                     impact:'high', requested_by=<requester>)                     → 202 {approvalId}
approver (Approvals inbox) → decide(approve)
  └─ decide(): isWebdeskApprovedCommandRequest(origin, workflow_id) → executeApprovedWebdeskCommand(…, decider)
       authorize(decider, {kind:'webdesk_content_item', tenantId, module:'webdev', approvalId, creatorId:requested_by}, 'publish')
       → mint WS4 {approvalId, commandHash, exp:+60s} + editorial {sub:decider, req:requester, apr:approvalId}
       → egress POST /control/v1/…/content/publish (Idempotency-Key ws4:<approvalId>)
       → success: row executed; rebuild dispatched (§9); requester notified
       → failure: row failed with a typed token, NO auto-retry (outbound-public, the SMM-09 rule). An ambiguous failure
         reconciles by reading item state; published_version == requested means executed.
```

**What the editor experiences** (this is the consequence the brief asked to be named):
* **Publishing takes two people.** The requester sees *"Publish requested — awaiting approval (#id)"*. Someone else must approve.
  Cerbos denies the decider when `creatorId == principal.id`, platform admin included.
* **Today only company admins can approve.** The generic `automation_approval:decide` is company_admin-only
  (`202609010900_…github.sql` header). A non-admin publisher approving needs a `decide_webdesk` action, following the
  `decide_leave` precedent. That is post-proof work, not WSK-47.
* A typo fix on a live page waits for an approver. **Takedown does not wait:** `unpublish` is MEDIUM and runs immediately
  for the publisher tier.
* Approval latency is the approver's response time. For the proof run, the owner is the approver.

**Proposed ruling R4 (owner question Q1). A publisher's self-publish:** a holder of `webdesk_content_item:publish`
requesting a **single-item, non-scheduled** publish files the row and executes it in the **same request**, with `decided_by =
requester` and `decision_basis = 'self_publish_R4'`. Batch and scheduled publishes keep maker ≠ checker. Every structural gate
stays: there is still a WS4 row, a real Layer-4 assertion, Cerbos and the audit trail. Only the second person goes away, and only in the narrowest case. My argument
is that WSK-31's ALWAYS-WS4 exception was ruled for rare, infrastructure-irreversible commands (keys, promote, domain).
High-frequency editorial publishing by an authorised publisher is the case where the estate's own default applies: "a human does
not need their own approval to do what they just asked for" (`mcp-hub/src/policy.ts` D14 header). **Mechanism if adopted:**
WSK-66 sets `subKind: 'self_publish_single'` only on that code path, and the maker-checker DENY in §7 excludes that subKind. A test
proves that self-approval of a batch or a scheduled publish is still denied. **Recommended: adopt.
Default if unanswered: strict maker ≠ checker, which is what is specified above.**

---

## 7. Decision E: Cerbos (WSK-47)

**Kinds:** `webdesk_content_item` and `webdesk_collection`. `webdesk_media_asset` is deferred to WSK-43, because a kind
with no handler grants reach nobody can use (the FINANCE-F0 reasoning in the catalog `countsNote`).

| Action | platform_admin | company_admin | manager | module_manager (`webdev_manager`, "publisher") | module_staff (`webdev_staff`, "editor") | member | client |
|---|---|---|---|---|---|---|---|
| `webdesk_collection:read` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `webdesk_collection:apply_schema` | ✓ | ✓ | — | ✓ | — | — | — |
| `webdesk_content_item:read` · `create` · `update` · `request_publish` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `…:unpublish` · `delete` | ✓ | ✓ | — | ✓ | — | — | — |
| `…:publish` · `schedule` | ✓ ¹ | ✓ ² | — | ✓ ² | — | — | — |

¹ The wildcard rule, but still subject to the DENY below. ² Only with `has(approvalId) && type(approvalId)==string &&
approvalId != ""` **and** `has(creatorId) && creatorId != "" && creatorId != principal.id`, **inline** in the rule.
Do not use `variables.local`: that trap mis-routes IAM overrides. A further rule `EFFECT_DENY, roles:["user"]` on publish/schedule fires when
`creatorId == principal.id`; this is the invoice precedent (`resource_invoice.yaml:75-140`). All ALLOWs also need `variables.inTenant && variables.notLow`. The
`client` role appears nowhere. There is no `perm_*` mirror, because these attribute-instance checks cannot be flattened (`perm-mirror` invariant).
**Attribute rule:** item-targeted ERP calls take `collectionKey`/`locale` from **Zone B's read**, never from the request body.
**Later roles (after the proof, through the IAM data-driven roles program, not WSK-47):** *writer* gets create/update/request_publish
where `collectionKey ∈ {post, guide}`; *translator* gets update where `locale == "id"`; *SEO reviewer* gets read plus request_publish. These use the
two attributes this ticket adds, so no further allow-list change is needed.

**The six artifacts (paths verified on this branch), plus what moves:**

| # | Artifact | Path | Change |
|---|---|---|---|
| 1 | Policies | `platform-nest/cerbos/policies/resource_webdesk_content_item.yaml`, `resource_webdesk_collection.yaml` | new, siblings of `resource_webdev_contract_snapshot.yaml` |
| 2 | Attribute allow-list | `platform-nest/src/rbac/cerbos.ts` (`Resource` and `resourcePayload()`, :9-157) | add `collectionKey?: string`, `locale?: string`, both defaulting to `""` fail-closed. These are inert now and used by the later writer/translator rules. `approvalId`/`creatorId` already exist |
| 3 | Catalog | `platform-nest/src/rbac/permission-catalog.json` | **+10 keys**: `webdev.webdesk_content_item.{read,create,update,request_publish,publish,schedule,unpublish,delete}`, `webdev.webdesk_collection.{read,apply_schema}`. All grantable and `uiGrantable:true`. **Sensitive +5** (publish, schedule, unpublish, delete, apply_schema). Re-derive `_meta` |
| 4 | Groups | `platform-nest/src/rbac/permission-groups.json` | `webdesk_content_editing` (read/create/update/request_publish + collection.read); `webdesk_content_publishing` (`advancedOnly`, the approval-gated precedent) |
| 5 | Seed migration | `platform-nest/migrations/<YYYYMMDDHHMM>_iam_webdesk_content_permissions.sql` | permissions + role_permissions exactly as `npm run gen:role-bundles` derives them, with the DO-block self-assertion owner ≡ company_admin (`owner-role.db.test.ts`). Precedents: `202608271510_iam_webdev_contract_snapshot_permissions.sql`, `202608310900_iam_github_repo_permissions.sql` |
| 6 | Bundle resolvers | `platform-nest/scripts/generate-role-bundles.mjs` **and** `platform-nest/src/rbac/role-permission-parity.db.test.ts` | map both kinds to the webdev staff/manager targets in **both** resolvers. Regenerate `src/rbac/role-permission-bundles.json` **from a clean worktree** |
| + | Pinned counts (as of this branch; **re-derive at merge**, because concurrent sessions move the base) | `iam-215-boundary-pin.test.ts:130,159` · `permission-groups-catalog-parity.test.ts:112` · `ui-grantable-catalog.test.ts:86-87` · `cerbos-catalog-alignment.test.ts:128-129` | kinds 99→**101**, non-exempt 95→**97**, catalog 406→**416**, grantable 391→**401** |
| + | Matrix and contract | `src/rbac/cerbos-webdev-matrix.test.ts`; `docs/PERMISSION-CONTRACT.md` §2 numbers; `modules/webdev/index.ts` `permissions[]` | extend; update the same § in the same change |
| + | **Restart and probe** | the test Cerbos (`gaiada-test-cerbos`) and the live sidecar | `POST /api/check/resources` with `includeMeta:true`, in one request per principal (a split decision fingerprints stale policy): editor update ALLOW / publish DENY even with approvalId; publisher publish ALLOW with approvalId + other creator, DENY when self, DENY without approvalId; platform_admin self-publish DENY; client and member read DENY; a neighbour check that `github_repo:deploy` still needs approvalId |

---

## 8. Decision F: the M1 loader principal

**The loader is an ERP-side automation principal over the real control channel.** Concretely:

* **Principal:** a `users` row of kind automation ("WebDesk importer", `company_memberships.kind='service'`) with a
  `webdev_manager` grant on the gaiada company. The owner provisions it through the existing IAM grant surface, as an operator step
  and not a migration (D36's "data change ⇒ ticket, never a migration" rule).
* **Entry point:** `platform-nest/scripts/webdesk-import.ts`, run inside the platform-nest container. It is a *client of the same
  service layer the BFF uses* (WSK-59's `WebdeskContentService`), so every call is Cerbos-authorised as the importer, signed
  with an editorial assertion (`pk:'automation'`) and carried over the four-layer channel. It accepts only principals that are
  `users.kind='automation'` **and** listed in `WEBDESK_IMPORTER_PRINCIPALS`, which rules out impersonating a human. It exposes
  **only** `apply-compositions`, `upsert-items` and `request-publish`. It cannot publish, unpublish or delete, and the module
  imports no such function (a static test checks this).
* **WS4 for the bulk initial publish:** **one** `requestPublish` covering every imported item at its head version (≤ 1,000
  per command; gaiada's phase 1 is about 330). The approval carries `{bundleSha256, counts by collection}`, and the owner sees *"Initial
  import of gaiada.com: 330 items, bundle sha256 …"*. It executes in-band as one `content.publish` command with one
  WS4 assertion (§6). The requester is the importer and the decider is the owner, so maker ≠ checker holds by construction.
* **Re-runs are no-ops:** an item missing from WebDesk is created; one present with an equal content hash is skipped; one present with a different hash
  is updated with `baseVersion = head`. Idempotency keys are `import:<bundleSha256>:<collection>:<locale>:<slug>`.

**Rejected: an in-box operator CLI** (`docker compose exec api … bootstrap-import`). It would be a second write path that skips
layers 1–4 and the ERP's Cerbos, could not carry a verifiable WS4 assertion, and would need an explicit owner exception under
the full-fidelity mandate. **Nothing in M1 needs it.** Parity *development* (WSK-54/55) runs against a dev WebDesk stack seeded by
the existing test fixtures (`payload/test/v1-fixtures.mjs` pattern), and the **live** load waits for the channel, which M2 needs
anyway. **Consequence for the tracker:** WSK-63, WSK-40, WSK-47 and WSK-66 move onto M1's critical path. WSK-57's tenant, site and environment
provisioning (MEDIUM) and key minting (HIGH, approved in-band through §6's executor, whose allow-list includes `key.mint`;
the plaintext is returned once in the `decide()` response and never persisted) should also run over the channel once WSK-63 lands.

---

## 9. Decision G: publish → rebuild (answers P-2)

**Recommendation: build on GitHub-hosted Actions in `gaiadabali/gaiada-web-revamp`.** The ERP starts it
**directly after a successful in-band publish** with `workflow_dispatch` (`webdesk-rebuild.yml`, `ref: astro-site`). The call goes through
the GitHub chokepoint as `github_repo:deploy` (D14-gated), and **the publish approval's id authorises it**: the approval text
says *"…and rebuild gaiada.com staging"*, so one human decision covers both. The workflow sets
`concurrency: {group: webdesk-rebuild-staging, cancel-in-progress: true}`, so bursts coalesce on GitHub's side and the ERP needs no
debounce. A small `webdev_site_builds` ledger (third-wall RLS) records each dispatch and its stamp verification, so the UI can show build state honestly.

| Question | Answer |
|---|---|
| Where the build runs | A GitHub-hosted `ubuntu-latest` runner: checkout, `npm ci` (cached), `CONTENT_SOURCE=webdesk npm run build:webdesk` (pull from `/v1`, then `astro build` and the site's own gates), deploy |
| Cost | Measure the build time in WSK-60; the laptop build is the only data point. Assume 2–4 min per run at $0.008/min (Linux 2-core) if the repo is private, $0 if public. At 20–60 publishes a month that is **40–240 min ≈ $0.30–$1.90/month**, inside any free allowance. This is negligible against §10's estate total |
| Latency | ≈ 3–6 min from approval to live on staging |
| Credentials, and the blast radius if stolen | **ERP:** the `gaiada-erp` App installed on that one repo with `actions:write` + `metadata:read`. A thief can trigger builds but cannot push. **GitHub secret `WEBDESK_READ_KEY`:** a production-environment **read** key, which reads published, already-public content. **GitHub secret `DELPHI_DEPLOY_KEY`:** a dedicated **non-root** user with a forced command that swaps the `24-pyevq` docroot only (`command=…,no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`), so the worst case is defacing one staging site. Today a root key to a box serving 20+ sites lives on a laptop (`deploy-staging.sh:17-19`). **WebDesk:** no GitHub credential, unchanged from v1.1 §03 |
| Which key the build reads with | **The production-environment key.** In one instance an environment is a *visibility selector* (fact 7), so a staging-environment key would show unpublished drafts and make "publish" meaningless for the proof. The staging **environment** key is kept for previews (WSK-46) |
| "Shows it" signal | The pull step writes `dist/webdesk-build.json` = `{source, pulledAt, maxUpdatedAt, itemCount, sourceSha256}` (the git build writes `{source:"git"}`). The ERP polls `https://24-pyevq.gaiada.com/webdesk-build.json` until `maxUpdatedAt ≥ publishedAt` (every 30 s, up to 20 min), then marks the publish **live on staging**. This uses only frozen-envelope data (`meta.updatedAt`). The parity diff excludes this one file |
| Unpublish and delete | These have no approval, so there is no `deploy` authority and **no automatic rebuild in the proof**. The UI says *"Unpublished from WebDesk — the staging site drops it at the next rebuild"* with a **Request rebuild** button, which files an approval. Proposed ruling **R3 / Q2** would fix this |

**Rejected:** a build container on `gda-aicenter` (§10 lever 1 forbids repo-code execution on the ERP kernel, and D32
makes that stronger); building on delphi (root fs ≈ 92% full, client-delivery host); `sumopod` (observation role, and §10 bans
standing runners there); the WebDesk tenant webhook calling GitHub directly (WebDesk may hold no GitHub credential, and GitHub's
API needs one); a self-hosted isolated runner (the right long-term answer under §10 lever 1, but none exists yet). The tenant
webhook `content.published` is still emitted. It is the generic trigger for client sites whose build hooks are
capability URLs, and for WSK-61's scheduled publishes through a B→A fact.

**Note against §10 lever 2:** "an adopted site stops rebuilding when content changes" holds for sites that read `/v1` at
request time. gaiada.com is static by the handoff's own principle, so **every publish is a rebuild**. The cost above is what
that principle costs.

---

## 10. Decision H: the "Website" workspace (WSK-44)

**Fit to the dept template:** the Web Dev console gains a craft group **Website** (`lib/deptToolkits.ts`), giving
Home · Work · Build · **Website** · Connections. The group holds one tab now, **Content**. Writers' room, SEO & AI search (deep link to SEO),
Analytics, Leads and Governance (handoff areas) come later.

| Route (`app/(app)/departments/[deptId]/website/…`) | Shows |
|---|---|
| `content` | Sites this company can edit (`tenant.list?companyRef`), with a direct redirect when there is exactly one (gaiada.com) |
| `content/[tenant]/[site]` | Collections grouped by `composition.ui.group` (Pages · Home sections · Company pages · Site settings · Redirects): label, items by locale, live, **pending changes** |
| `content/[tenant]/[site]/[collection]` | Item list with filters (locale, state, pending, search). A singleton opens the editor directly |
| `content/[tenant]/[site]/[collection]/[slug]?locale=en` | **Editor:** a form generated from FieldDef (text, markdown with preview, number, boolean, select, date, groups, lists with add/remove/reorder by drag **and** keyboard, read-only locale-neutral members in non-default locales); locale tabs with twin status; side panel with state, PublishBar, lint, version history, "View on staging" (`url` field) |
| `…/[slug]/history` | Versions (author resolved in the ERP), diff against live, **Restore as draft** |
| `approvals/[id]` (existing) | A `WebdeskPublishSummary` renderer for origin `webdesk`: items, live vs requested diff links, lint counts, rebuild target |

**States, each a distinct render (never an empty editor):**

| State | Trigger | Render |
|---|---|---|
| loading | — | skeleton |
| **editorial unavailable** | BFF 503 `editorial_unavailable` (circuit open or egress failure) | Full-page notice: *"Editing is unavailable — WebDesk can't be reached. Nothing has been lost."* No list, no form |
| **stale** | a refresh fails after a successful load | A banner: *"Couldn't refresh — showing what loaded at 10:41."* **Save and publish are disabled** until a read succeeds. The page never shows old data as current |
| not enabled / forbidden | 404 module / 403 Cerbos | `EmptyNote` / `ReadRefusal` (existing components) |
| read-only | no `update` | Form disabled, with the reason |
| dirty / saving / saved vN | local | standard |
| **conflict** | 409 `version-conflict` | Dialog: *"v13 was saved by … at …"* with **Load theirs** or **Save mine on top** (re-save with the new `baseVersion`). Local edits are kept |
| invalid | 422 | Inline errors located by JSON pointer |
| **pending approval** | `requestPublish` 202 | *"Awaiting approval #…"* (polls the approval), with **Withdraw** |
| rejected / failed | approval outcome | The reason token in plain words; **Request again** |
| published vN | executed | *"Published v5 · approved by …"* |
| rebuilding / **live on staging** / rebuild unverified | §9 stamp poll | progress, then a link to staging; a timeout says *unverified*, never *live* |
| unpublished, staging stale | unpublish without rebuild | warning, plus **Request rebuild** |

The UI library is `platform-ui/src/lib/webdeskContent.ts` (server-only), which returns discriminated results `ok | unavailable | forbidden |
not_enabled | conflict`. There is no path that turns a refusal into `[]`.

---

## 11. Making the control channel real (WSK-63)

**Topology decision.** On `gda-aicenter`, host nginx owns `:443` and Caddy is loopback-only (v2 §03 AC 2), so **mTLS
terminates at host nginx on a dedicated internal vhost, `control.webdesk.internal`**. It is not in public DNS. It uses a synccert-issued
server cert and `ssl_verify_client on` with the synccert CA. It proxies to `127.0.0.1:8380`, **overwrites**
`x-webdesk-mtls-cert-pem` with the verified client cert (never passed through), and adds a gate header
(`X-Webdesk-Control-Gate: <secret>`). Caddy routes `/control/*` to `api` **only** when the gate header matches (the
same pattern as the CDN edge-verify header). The public `api.gaiada.online` vhost and Caddy's public routes keep returning 404 for `/control/*`
and strip both headers. platform-nest reaches the vhost through `extra_hosts: control.webdesk.internal:host-gateway`.
**Rejected:** a shared docker network between the projects (it gives bidirectional reachability, effectively a third B→A path, and
reaches WebDesk's unauthenticated queue store); a Caddy TLS listener on the docker bridge (a host port, which AC 2 forbids).

**Pre-existing hole closed by this:** WebDesk's Layer 1 verifies a *forwarded PEM*, which is public material, so any process that can reach
`api:3000` directly can present it. The vhost-overwrites-header rule plus the gate header make "the proxy proved possession of the private key" true.
Layer 2 (the Keycloak token) remains the real cryptographic gate.

**The ERP egress client (the unbuilt half of WSK-23):** `platform-nest/src/modules/webdev/webdesk-control-client.ts`. It uses
`node:https.Agent({cert,key,ca,keepAlive:true,maxSockets:16})` with file-mounted cert, key and CA; a
Keycloak client-credentials token cache with single-flight (the `core/keycloak-admin.ts:104-150` precedent); WS4
minting byte-identical to `webdesk/api/src/control/auth/ws4-assertion.ts`, using shared vectors; retries on transport errors only (the
`contract-fetch-http.ts` doctrine); and a **circuit breaker** (5 failures in 30 s opens it for 30 s), which drives the UI's "editorial unavailable" state.

---

## 12. Tickets (I)

**Parallel waves.** Paths do not collide inside a wave.
**A (start now):** WSK-64 · WSK-65 · WSK-63a · WSK-63b · WSK-47 · WSK-54.
**B:** WSK-41 (needs 64, 65) → WSK-51 (rebases on 41's registry and module files) · WSK-40 (needs 41's seam; disjoint files apart from one binding line) · WSK-66 (needs 47, 63b).
**C:** WSK-59 (needs 41, 51, 40, 47, 66) → WSK-67 · WSK-44 · WSK-55 (dev-stack parity can start after 54) · WSK-60 (needs 55, 66 and owner Q4/Q5).
WSK-41b follows WSK-48a. WSK-56/57 (orchestrator) slot in after WSK-63 and WSK-66.

| Ticket | Tier | Model·effort | Depends on | Owned paths (no one else edits these in the same wave) |
|---|---|---|---|---|
| **WSK-64** Vocabulary 1.1.0 | senior-be | **opus·medium**: a blind classifier mis-rates every future change silently | — | `webdesk/payload/vocabulary/{primitives,blocks,composition,breaking-change,version,index}.ts`, new `item-fields.ts`; `webdesk/payload/test/{vocabulary,wsk14-*}.test.mjs`, new `wsk64-*.test.mjs`, new fixture `test/fixtures/vocabulary-1.0.0.snapshot.json`; `webdesk/api/src/codegen/generator/{vocabulary-field-schema,openapi-builder,content-contract-md}.mts` + `api/test/codegen-*.spec.ts`; `webdesk/api/src/schema-draft/vocabulary-vendor.ts` + `api/test/schema-draft/vendor-drift.spec.ts`; `webdesk/blocks/src/vocabulary/**` (via `npm run vendor:vocabulary`) + `blocks/src/renderer/**` (`fields` is known and non-visual); the api-importable vocabulary (WSK-48a's location if it exists, else new `webdesk/api/src/vocabulary/**`, vendored and drift-checked) |
| **WSK-65** Migration 0009 | senior-db | **opus·medium**: RLS dual-mode table, a unique index on a live audit table | — | `webdesk/migrations/0009_content_write_plane.sql`, `webdesk/migrations/tests/0009*`, `webdesk/scripts/check-rls-integrity.mjs` (if it pins table lists) |
| **WSK-63a** Channel: host + WebDesk side | devops | seat default (mandatory `nginx -t` gate and rollback) | owner Q3 | `webdesk/proxy/Caddyfile`, `webdesk/docker-compose.aicenter.yml`, new `webdesk/ops/nginx/control.webdesk.internal.conf`, new `infra/runbooks/webdesk-control-channel.md`, `webdesk/.env.example` |
| **WSK-63b** ERP egress client | senior-integrator | **opus·medium**: byte-identical cross-service hashing, custody of the mTLS key | owner Q3 | new `platform-nest/src/modules/webdev/{webdesk-control-client,webdesk-ws4-assertion}.ts` (+ `.test.ts`), `platform-nest/src/config.ts` (new `webdeskControl` block), platform-nest compose env in `infra/` |
| **WSK-47** Cerbos kinds | senior-be | **opus·high**: six artifacts, maker-checker; errors are silent denies or silent grants | — | §7's table, exactly |
| **WSK-41** Authoring commands | senior-be | **opus·high**: version and projection invariants, transactional audit, concurrency | 64, 65 | new `webdesk/api/src/control/content/{content-commands.controller,content-commands.service,content-projection,content-lint,search-text}.ts`; new `control/auth/{editorial-principal,editorial-assertion.guard,dev-mode-editorial-principal-resolver,not-configured-editorial-principal-resolver}.ts`; new `control/idempotency/pg-idempotency-store.ts`; `control/command-types.ts` (+ **all** WSK-41 **and** WSK-51 names); `control/control.module.ts`; `control/schema/schema.service.ts` (validation + bump); `tenant-webhooks/{tenant-webhook-event.types,dto,tenant-webhook-dispatcher.service}.ts`; new `api/test/content-*.spec.ts`; `api/test/control-command-registry.spec.ts` |
| **WSK-41b** Read-path deleted filter | junior | seat default | WSK-48a merged | the delivery read queries (`AND ci.deleted_at IS NULL` in item, list, search, localizations) |
| **WSK-51** Read commands | senior-be | seat default | 41 | new `webdesk/api/src/control/content/content-reads.{controller,service}.ts`, new `control/tenants/tenant-reads.{controller,service}.ts`, one line in `control.module.ts`, new `api/test/content-reads*.spec.ts` |
| **WSK-40** Editorial assertion | senior-integrator | **opus·high**: security-critical crypto, replay store and skew | 41 (seam), 63a (mount) | WebDesk: new `control/auth/{editorial-assertion,editorial-jwks,jti-replay-store,real-editorial-principal-resolver}.ts`, one binding line in `control.module.ts`, new `api/test/editorial-assertion-*.spec.ts`. ERP: new `platform-nest/src/modules/webdev/webdesk-editorial-signer.ts` (+test), new `platform-nest/scripts/webdesk-editorial-keygen.mjs` |
| **WSK-66** In-band WS4 execution | senior-be | **opus·high**: approvals, maker-checker, irreversible egress | 47, 63b | new `platform-nest/src/modules/webdev/webdesk-approved-command.ts` (+test), the `decide()` branch in `platform-nest/src/core/automation-approvals.controller.ts`, decider resolution for origin `webdesk` in `core/approval-deciders.ts`, new `platform-nest/migrations/<ts>_automation_approvals_origin_webdesk.sql` (the **catalog-read union** of `202609040505`; never a retyped list) |
| **WSK-59** ERP content BFF + MCP tools | senior-be | seat default | 41, 51, 40, 47, 66 | new `platform-nest/src/modules/webdev/{webdesk-content.controller,webdesk-content.service}.ts` (+tests); `modules/webdev/index.ts` (mcpTools, permissions); `core/approval-executables.ts` + `cerbos/policies/resource_mcp_tool.yaml` (**both**, for unpublish/delete: the D14 pairing); `modules/webdev/webdesk-control.controller.ts` (only `schema/apply` and `sites` re-pointed); `docs/FRONTEND-BFF-CONTRACT.md` new **§27** (claim it by grep at ticket time) |
| **WSK-67** Importer apply CLI | medior | seat default | 59 | new `platform-nest/scripts/webdesk-import.ts` (+ `.test.ts`) |
| **WSK-54** Bundle export (site repo) | medior | seat default | 64 (shapes) | site repo branch `webdesk-importer`: `scripts/webdesk/{export-bundle.mjs,codecs/**,compositions/*.json}`, tests |
| **WSK-55** Site reads `/v1` + parity | senior-fe | **opus·medium**: determinism, key order, YAML round-trip | 54, a dev stack; live after 67 | site repo: `scripts/webdesk/{pull.mjs,parity.mjs,parity-sources.mjs}`, `package.json` scripts, `docs/WEBDESK.md` |
| **WSK-55a** Config copy extraction (phase 2) | senior-fe | seat default | 55 green | site repo: `src/config/**` (copy moved to `src/config/copy/*.json`; a refactor with no output change), one codec per module |
| **WSK-44** Website workspace | senior-fe + senior-uiux | seat default | 59 | `platform-ui/src/lib/{webdeskContent,webdeskContentActions}.ts`, `platform-ui/src/app/(app)/departments/[deptId]/website/**`, `platform-ui/src/components/webdesk/content/**`, `platform-ui/src/lib/deptToolkits.ts` (+ test), `app/(app)/approvals/[id]` renderer |
| **WSK-60** Rebuild | senior-integrator | seat default | 55, 66, owner Q4/Q5 | site repo `.github/workflows/webdesk-rebuild.yml`, `scripts/deploy-staging-ci.sh`; new `platform-nest/src/modules/webdev/site-builds.{service,test}.ts` + migration `<ts>_webdev_site_builds.sql` (third wall); the delphi deploy user (operator, owner-approved) |

### Per-ticket specification ("done when" a QA agent can execute)

**WSK-64.** *Done when:* (1) `classifyVocabularyChange(load('vocabulary-1.0.0.snapshot.json'), currentVocabularySnapshot())`
returns `minor` with exactly §2.3's rows 1–8, and the fixture is captured **before** any edit. (2) Negative controls are MAJOR: a group sub-field removed,
an `itemKey` changed, `localized` flipped true→false, a mutated envelope path; and the classifier is rated `patch`→`major` for a removed
sub-field (this proves the recursion). (3) `validateItemContent` passes ≥ 40 table cases: fields-block position, uniqueness and presence,
closed props, depth > 4 rejected, `itemKey` duplicates, scalar `multiple`, boolean, markdown verbatim, and `'fields'` refused in `composition.blocks`. (4)
`validateCollectionComposition` rejects `fields` on a non-group, an `itemKey` naming a non-text or optional field, and unknown
FieldDef keys. (5) The codegen OpenAPI for a fields collection has `prefixItems:[fieldsBlockSchema]`; `openapi-typescript`
output type-checks a page item, and if it cannot express `prefixItems` the ticket falls back to `items.oneOf` and documents why.
The double-run byte gate passes. (6) **`payload/test/envelope-contract.test.mjs` passes unchanged**, and `envelope.ts` is untouched (git diff is empty).
(7) `blocks` `npm run vendor:check` and the schema-draft drift spec pass after re-vendoring.
*Verify (Linux gate):* `cd webdesk/payload && node --import tsx test/wsk64-classifier.test.mjs && node --import tsx test/wsk64-item-fields.test.mjs && node --import tsx test/envelope-contract.test.mjs` (DB env per the file header);
`cd webdesk/api && npx vitest run test/codegen-*.spec.ts test/schema-draft/vendor-drift.spec.ts && npm run codegen:gate`; `cd webdesk/blocks && npm run build`.

**WSK-65.** *Done when:* the migration applies on a fresh `0001…0008` database and **fails loudly** on a seeded duplicate `(site_id, localization_group_id, locale)` and on a duplicate non-replay `ws4_approval_id`. This uses negative controls built by inserting duplicates under the tenant GUC before applying. `check-rls-integrity.mjs` is green and lists `control_idempotency_keys` as FORCE RLS. A cross-tenant probe (tenant A's GUC reads 0 of tenant B's idempotency rows, and the platform context reads only `tenant_id IS NULL`) passes, with a positive control showing the same query returns rows under the right GUC. **Every existing suite passes after 0009 unchanged:** `envelope-contract.test.mjs`, `api/test/control-*`, `promotion-*`, `privacy-*` and `wsk04-*`. They mint a fresh approval id per call (checked: `randomUUID()` in each spec), and their idempotent replays are `.replay` rows, which the partial index excludes.
*Verify:* the api README's throwaway-Postgres runbook → `npm run migrate` ×2 (idempotent) → `node scripts/check-rls-integrity.mjs` → `migrations/tests/0009*`.

**WSK-63a.** *Done when:* `nginx -t` passes before every reload and a backup of the vhost directory exists. A request without a client cert to
`control.webdesk.internal` fails the TLS handshake. A request with a cert from a different CA fails. A request with a valid cert and a forged inbound
`x-webdesk-mtls-cert-pem` header reaches `api` carrying **the verified cert**, not the forged value (asserted through a debug echo route that is enabled only in this test). On
`api.gaiada.online`, `/control/*` returns 404 with or without headers. Caddy refuses `/control/*` without the gate header (negative control: the same request with the
gate header succeeds). `docker compose … config` shows no new host port (v2 §03 AC 2). NTP sync shows offset < 1 s.
*Verify:* the runbook's `curl --cert/--key/--cacert` matrix on `gda-aicenter`, plus a resolved-config port audit.

**WSK-63b.** *Done when:* (1) three fixed `computeCommandHash` vectors produce identical output in both repos. The ERP side asserts the WebDesk side's literals,
and `ws4-assertion.ts`'s test asserts the same three. (2) A minted WS4 assertion verifies against the real `verifyWs4Signature`, run as a cross-repo
fixture file. (3) The token cache makes exactly one token request for 50 concurrent calls. (4) The breaker opens after 5 transport failures in 30 s
and returns `EditorialUnavailableError` without network I/O while open. (5) There are no retries on HTTP responses (any status). (6) No secret appears in
errors, logs or `JSON.stringify(client)` (the `#private` field precedent). (7) **Live:** `GET /control/v1/tenants/<slug>/contract` succeeds through
all four layers against `gda-aicenter`, and the same call without the client cert fails at Layer 1.
*Verify:* `cd platform-nest && npx vitest run src/modules/webdev/webdesk-control-client.test.ts src/modules/webdev/webdesk-ws4-assertion.test.ts`, plus the live probe in the runbook.

**WSK-47.** *Done when:* §7's six artifacts and the counts land in one change, the pinned tests are updated to the **re-derived**
numbers, the bundles are regenerated from a clean worktree, and `iam-04-reg1-mirror-reach-invariant.test.ts` and `role-permission-parity.db.test.ts` are green.
**Then** both Cerbos instances are restarted and §7's probe matrix is run, with every row showing the expected effect and `matchedPolicy`. The probe includes
the self-publish DENY for platform_admin and the `github_repo:deploy` neighbour.
*Verify:* `cd platform-nest && npx vitest run src/rbac/` (with the full env and 3 containers, per the test-infrastructure note), `docker restart gaiada-test-cerbos`, then the probe script in the ticket report.

**WSK-41.** Signatures:
```ts
interface EditorialPrincipal { sub: string; pk: 'human'|'automation'|'agent'; agt?: string; req?: string; apr?: string; jti: string }
const EDITORIAL_PRINCIPAL_RESOLVER: unique symbol
interface EditorialPrincipalResolver { resolve(req: ControlRequest, command: CommandName, args: Record<string, unknown>): Promise<EditorialPrincipal> }
// bound: NODE_ENV=test → DevModeEditorialPrincipalResolver (header x-webdesk-editorial-principal, as WSK-21 did);
//        otherwise → NotConfiguredEditorialPrincipalResolver (503 editorial-keys-not-configured) until WSK-40 swaps it.
interface EditorialCommandContext { tenant: { id: string; slug: string; defaultLocale: string; locales: string[] };
  siteId: string; principal: EditorialPrincipal; idempotencyKey: string; ws4ApprovalId: string | null; command: CommandName }
class ContentCommandsService {
  createItem(ctx: EditorialCommandContext, input: CreateItemInput): Promise<ItemWriteResult>
  updateItem(ctx: EditorialCommandContext, itemId: string, input: UpdateItemInput): Promise<ItemWriteResult>
  restoreVersion(ctx: EditorialCommandContext, itemId: string, input: { version: number; baseVersion: number; note?: string }): Promise<ItemWriteResult>
  publish(ctx: EditorialCommandContext, input: { items: { itemId: string; version: number }[]; note?: string }): Promise<PublishResult>
  schedule(ctx: EditorialCommandContext, input: ScheduleInput): Promise<ScheduleResult>
  unpublish(ctx: EditorialCommandContext, itemId: string, input: { expectedPublishedVersion: number }): Promise<ItemStateResult>
  deleteItem(ctx: EditorialCommandContext, itemId: string, input: { baseVersion: number }): Promise<ItemStateResult>
}
// pure helpers (content-projection.ts / content-lint.ts / search-text.ts)
function fieldsCarrierFor(collectionKey: string): 'block' | 'seo.redirect'
function contentHash(blocks: unknown, seo: unknown): string
function extractSearchText(blocks: unknown): string
function lintPlaceholders(rules: PlaceholderRule[], blocks: unknown, registry: Map<string, string | null> | null): LintReport
```
*Done when:* real Postgres + the queue store, `NODE_ENV=test` stubs for L1/L2/L2e, and the **forced-real PDP** for Layer 4 (the WSK-22 pattern).
(1) **Draft isolation:** create → publish v1 → update to v2 means the production `/v1` read still serves v1 and staging serves v1 too (the item is live). Publish v2 → production
serves v2, and `meta.updatedAt` moves only on the publish. (2) Unpublish → production 404, staging serves head. Delete of a live item → 409, and delete
of a draft → the item is gone from editor lists. (3) **Concurrency:** 10 parallel updates on the same `baseVersion` give exactly 1×200 and 9×409, with no version
gaps. (4) **Idempotency:** the same key and body twice gives one version and `replayed:true`. After restarting the app, it is still `replayed`. The same key with a different body gives 409.
(5) **Gate order with valid bodies:** no editorial principal → 401; a scopeless token → 403; publish without WS4 → 403; each denial is
paired with a 200 control using the identical body. An invalid body with full authorisation gives 422 (validation runs after authorisation). (6) **WS4 single-use:** the same approval
on a second publish with a new idempotency key → 403. Two concurrent publishes with the same approval → exactly one success (the 0009 index), and the
loser's effect is rolled back (its items are unchanged). (7) Composition cases (singleton, `localized:false` locale, twin collision, the redirect carrier) return
the documented 409/422. (8) Events: one `content.published` delivery per enabled webhook; zero with none registered; the payload has **no** prop
values (keys asserted). (9) `control-command-registry.spec.ts` pins every new command, and `EDITORIAL_COMMANDS` and `test/zz-real-boot.spec.ts` boot the real `AppModule`.
(10) `envelope-contract.test.mjs` is unchanged and green.
*Verify (Linux):* the api README runbook DB + queue store → `npx vitest run test/content-*.spec.ts test/control-command-registry.spec.ts test/zz-real-boot.spec.ts`.

**WSK-41b.** *Done when:* a deleted draft is 404 for staging and production keys in the item, list and search routes, and is excluded from localizations. Undeleted
items behave byte-identically (re-run the envelope-contract gate).

**WSK-51.** *Done when:* each read returns §4's shape against seeded data. Tenant B's item fetched via tenant A's slug → 404, with a positive control. `tenant.list`
filters by `companyRef` (another company's tenant is absent). Drafts, versions and lint are visible. Calls without `webdesk:read` → 403. No `audit_entries` rows are
written (row count unchanged). Pagination is stable while an update runs concurrently.
*Verify:* `npx vitest run test/content-reads*.spec.ts`.

**WSK-40.** *Done when:* the WebDesk adversarial matrix has ≥ 20 rows, each asserting its exact problem slug: missing; malformed; `alg:none`; `HS256` signed
with the public key bytes; unknown `kid`; a tampered payload; a tampered signature; wrong `iss`, `aud` or `typ`; expired; `iat` +11 s refused and +9 s accepted; a lifetime of
121 s refused; `ten`, `site` or `cmd` mismatch; `cmh` mismatch after a one-byte body change; `apr` ≠ the WS4 approval; replay; queue store down → 503; the
happy path. The JWKS loader refuses a truncated or non-Ed25519 file at boot (the CA-loader discipline). The ERP signer's three fixed `(key, input)`
vectors verify on the WebDesk side, the reverse holds too, and both repos pin the same vectors. The rotation runbook is executed once on the dev stack:
both kids are accepted during the overlap, and the old kid is refused after removal.
*Verify:* `cd webdesk/api && npx vitest run test/editorial-assertion-*.spec.ts`; `cd platform-nest && npx vitest run src/modules/webdev/webdesk-editorial-signer.test.ts`.

**WSK-66.** Signatures:
```ts
type WebdeskApprovedCommand = 'content.publish' | 'content.schedule' | 'key.mint'
function isWebdeskApprovedCommandRequest(origin: string, workflowId: string | null): boolean
function fileWebdeskCommandApproval(principal: Principal, tenantId: string, input: { command: WebdeskApprovedCommand;
  tenantSlug: string; siteId: string; args: Record<string, unknown>; summary: WebdeskApprovalSummary }): Promise<{ approvalId: string }>
function executeApprovedWebdeskCommand(tenantId: string, approvalId: string, toolArgs: unknown, requestedBy: string,
  decider: Principal): Promise<WebdeskApprovedCommandResult>   // key.mint: { apiKeyId, plaintextOnce } returned, never persisted
// Cerbos at execution, as the decider with approvalId + creatorId = requestedBy:
//   content.publish / content.schedule → webdesk_content_item : publish / schedule
//   key.mint                           → webdev_provisioned_site : promote   (WSK-31's existing kind and action)
// A command outside the allow-list → 400. The allow-list is a closed union, so a fourth command cannot ride this executor silently.
```
*Done when:* (1) The origin migration unions `'webdesk'` into the **live** CHECK definition. A test proves every previously admitted value is still admitted, which is the
lost-value incident's regression test. (2) Decider = requester → 403 (Cerbos DENY). A decider without `publish` → 403. In both cases Zone B
received nothing (a stub server asserts zero calls). (3) Approve → exactly one Zone B publish carrying a valid WS4 assertion and an editorial assertion
(`sub` = decider, `req` = requester, `apr` = approval). The row is `executed`. (4) Egress failure → row `failed` with a typed token and **no** second attempt.
An ambiguous failure (Zone B committed, response lost) reconciles by reading to `executed`. (5) `tool_args` edited after filing → Zone B 403
command-mismatch → row `failed`. (6) `key.mint`: the plaintext appears only in the `decide()` response body. A DB scan of `automation_approvals`, `activities`
and the logs finds no plaintext.
*Verify:* `cd platform-nest && npx vitest run src/modules/webdev/webdesk-approved-command.test.ts src/core/automation-approvals*.test.ts`.

**WSK-59.** Routes (all `@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))`; **`authorize()` is the first statement** of every handler, before any body validation):
```
GET  /api/:tenantId/modules/webdev/content/sites
GET  /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections
GET  …/sites/:tenantSlug/:siteId/collections/:collectionKey/items
GET  …/sites/:tenantSlug/:siteId/items/:itemId[?version=]
GET  …/sites/:tenantSlug/:siteId/items/:itemId/versions[/:n]
GET  …/sites/:tenantSlug/:siteId/media
POST …/sites/:tenantSlug/:siteId/collections/:collectionKey/items        (create)
PUT  …/sites/:tenantSlug/:siteId/items/:itemId                            (update)
POST …/sites/:tenantSlug/:siteId/items/:itemId/restore
POST …/sites/:tenantSlug/:siteId/publish-requests                         (→ 202 {approvalId}; WSK-66 filing)
POST …/sites/:tenantSlug/:siteId/items/:itemId/unpublish
POST …/sites/:tenantSlug/:siteId/items/:itemId/delete
```
MCP tools (`modules/webdev/index.ts`): the reads `webdesk.content.{listSites,listCollections,listItems,getItem,listVersions,listMedia}`;
`webdesk.content.{create,update,restoreVersion,requestPublish}` with `write:true, impact:"low"`; `webdesk.content.{unpublish,delete}`
with `write:true, impact:"medium"`, plus **both** D14 halves (`approval-executables.ts` entries: precondition = structural args check only,
because Zone B's `expectedPublishedVersion`/`baseVersion` guard is the atomic re-check; and the `resource_mcp_tool.yaml` executable list).
`resolveEditableSite(tenantId, tenantSlug, siteId)` returns 404 unless `tenants.company_ref = tenantId` (via `tenant.list`, cached 60 s), which is the cross-company wall.
Every egress write writes an `activities` row **before** the call and one after (the GH-04 two-row pattern), so that the ERP ledger can resolve the opaque `sub`.
*Done when:* every tool has a golden case (the agentic-native bar's criterion 7). Company A's user editing company B's site → 404, with a positive control. The Cerbos
denial tests send valid bodies. The breaker-open state → 503 `editorial_unavailable` on reads and writes. Typed 409/422 pass through untouched. BFF §27 is
written. An agent calling `unpublish` unattended suspends, and on approval it re-drives as the original principal (end-to-end via the hub, per the d14 pattern).
*Verify:* `cd platform-nest && npx vitest run src/modules/webdev/webdesk-content*.test.ts src/core/approval-executables.test.ts`; `cd mcp-hub && npx vitest run src/module-tools.test.ts`.

**WSK-67.** CLI: `tsx scripts/webdesk-import.ts --tenant-id <erpCompanyId> --site <tenantSlug>/<siteId> --bundle <path>
--principal <importerUserId> [--apply] [--request-publish]`. The default is a dry run, which prints the plan.
*Done when:* the dry run on gaiada's bundle prints counts with zero writes. `--apply` twice → the second run writes 0 versions. One changed item → exactly 1 update.
A human principal id, or one not in `WEBDESK_IMPORTER_PRINCIPALS`, is refused. `--request-publish` files exactly one approval whose `tool_args.items` equals the
bundle's head versions. A static test shows the module imports no publish, unpublish or delete function. The CLI assembles the importer
principal with an explicit non-`low` assurance. This is documented: the operator running a command inside the ERP container is the authentication.
Without it, every `variables.notLow` rule would deny the importer silently. A Cerbos probe shows the importer is ALLOWed `create`
and `apply_schema` and DENYed `publish`, even with an approvalId.

**WSK-54** (site repo). `bundle.json` = `{bundleVersion:1, vocabularyVersion:'1.1.0', site:'gaiada-com', sourceCommit,
compositions:{[key]:CollectionComposition}, items:[{collectionKey, locale, slug, twinOfSlug?, fields, blocks?, seo}], sha256}`.
**Phase 1 scope:** all 315 pages across the 13 kind collections (INV §5), plus `company`, `navigation`, `token-registry` and `redirect` from `data/*.json`,
plus the plan rows. All 315 are needed because `linkTarget()` needs every MERGE and CUT row. Config-copy modules are phase 2 (WSK-55a). This is my sequencing
call: each module's codec is independent and off the proof's critical path, and parity stays page-for-page because both builds read the
same TS config until a module migrates.
*Done when:* two exports from the same commit are byte-identical. For every page, `decode(encode(x))` deep-equals the glob loader's parsed `data` and
equals its `body` string. Every global round-trips. Every item validates against WSK-64's validator (run in the WebDesk repo against the exported bundle).

**WSK-55** (site repo). `CONTENT_SOURCE=webdesk npm run build:webdesk` = `node scripts/webdesk/pull.mjs` → `astro build`.
The pull script **rehydrates the git source tree** inside a clean CI checkout: `content/{en,id}/**.md` (YAML frontmatter in composition order, plus the body verbatim, with
files not present in `/v1` deleted) and the `data/*.json` globals in source key order. It uses the production read key and `?expand=blocks`, and **fails the
build on any `/v1` error**. It never falls back to git files. No Astro content-layer code changes.
*Done when:* (0) **Determinism first:** two git builds of the same commit give an identical `dist/`; otherwise the site's nondeterminism is fixed first.
(1) Source parity: for all 315 files the parsed frontmatter deep-equals and the body equals. (2) **dist parity:** `diff -r dist-git dist-webdesk` is empty (excluding
`webdesk-build.json`) for both the default build and `PUBLIC_PREVIEW_HELD=true`. (3) The site's gates (`manifestParity`, `unresolvedTokens`,
`schemaCoverage`) pass in both modes. (4) pages.json's derived columns are regenerated and equal git's, or are carried as read-only fields with a written reason.
(5) Negative control: change one FAQ answer in WebDesk and publish it → exactly that page's HTML differs.
*Verify (Linux, CI):* `npm run parity`.

**WSK-55a** (phase 2, site repo). *Done when:* each migrated module reads its copy from `src/config/copy/<module>.<locale>.json`; dist is identical
before and after the refactor (git mode); the module's codec round-trips; the parity gate is green in webdesk mode.

**WSK-44.** *Done when:* every state in §10 is reachable in a Playwright run against a stubbed BFF, **including editorial-unavailable, which never renders a
list**; keyboard-only reorder works in list fields; the locale-neutral members are read-only in `id`; a conflict keeps local edits; the approvals detail page shows the
WebDesk summary; `deptToolkits.test.ts` covers the Website group; `next build` passes (a green suite misses server-only violations). The live drive is
§13's proof script.

**WSK-60.** *Done when:* a publish approved in the ERP dispatches exactly one workflow run with that approval's id in the ledger. Two publishes 20 s apart
→ the first run is cancelled and the second deploys. The stamp poll marks the publish *live on staging* only when `maxUpdatedAt ≥ publishedAt`, and a negative control with an
unchanged staging site stays *rebuilding* until timeout and is then *unverified*. The deploy key's forced command refuses any path other than the tarball swap (tested with
`ssh … "ls /"`). The cost per run is measured and recorded.

### The proof script (QA, live, Linux): DEV-VERIFIED when observed
1. A staff editor (`webdev_staff`) opens Website › Content › gaiada.com › Service pages › `service.seo` (en) and edits FAQ answer 3. **Save draft** → v2. The staging site is unchanged.
2. **Request publish** → the owner (company_admin) approves in Approvals → the row is executed → a workflow run starts.
3. Within 10 min `https://24-pyevq.gaiada.com/services/seo/` shows the new answer and `webdesk-build.json.maxUpdatedAt ≥ publishedAt`.
4. `npm run parity` on the published state: the only differing page is `/services/seo/` (and its ID twin, if edited).
5. Negative controls: the editor's own attempt to approve → 403. The same approval re-presented to Zone B → 403. `/control/*` on `api.gaiada.online` → 404.

---

## 13. Owner questions (J)

| # | Question | Recommended | Default if unanswered |
|---|---|---|---|
| **Q1** | **Ruling R4: self-publish by a publisher** for single-item, non-scheduled publishes (§6) | **Adopt.** It keeps every structural gate and removes the second person only for the narrowest case | Strict maker ≠ checker (as specified) |
| **Q2** | **Ruling R3: rebuild class.** Is a staging-only rebuild that directly follows an executed WebDesk content command authorised by that command (not a separate D14 `deploy`)? Production rebuilds stay D14 | **Adopt.** The estate already rates `deploy.staging` low, and takedowns otherwise leave staging stale | Rebuild only through publish approvals; unpublish shows "Request rebuild" |
| **Q3** | Authority for the ERP-side setup: create the `webdesk-control` Keycloak client; issue the `platform-nest-webdesk` client cert and the `control.webdesk.internal` server cert from the synccert CA; generate and install `WEBDESK_APPROVAL_ASSERTION_KEY` and the editorial keypair; add the second host-nginx vhost. **D43 names one vhost and one compose project** | **Extend D43 narrowly to these five actions**, with backup and rollback | You perform them yourself. **M1 and M2 are blocked until then** |
| **Q4** | **P-2: where the build runs, and the site repo's home.** GitHub Actions in `gaiadabali/gaiada-web-revamp` (install the `gaiada-erp` App on that one repo, `actions:write`) or move the repo into the agency org first. Is the repo public or private (billing)? | **GitHub Actions; install the App on the existing repo; keep it private** (≈ $0–2/month) | The rebuild stays a manual operator run |
| **Q5** | A **delphi deploy user** with a forced command for `24-pyevq` only (replacing the root key for automation). delphi is a client-delivery host | **Yes** | Manual deploy from the laptop |
| **Q6** | **Unresolved placeholders at publish:** advisory report, or a hard block? (INV Q1) | **Advisory** for now. Parity requires it, because all 315 pages carry placeholders and the site already noindexes them | Advisory |
| **Q7** | **Visibility vocabulary** (INV Q4): confirm `shown / seo-only / held / hidden` and that the six-action `plan` retires after the parity gate | **Confirm**, and retire `plan` once the site reads `visibility` | Carry both (as specified) |
| **Q8** | **Tenant locales** (INV Q11) | **`en`, `id`, default `en`**: the site's own `Locale` type and URL scheme. The frontmatter `language` stays a field | `en`, `id`, default `en` |

---

## 14. Findings outside this ticket (each needs an owner)

1. **The promotion engine breaks on authored content.** Restore mode hard-deletes `content_items` (`promotion/content-bundle.service.ts:204`),
   which will hit the foreign key once items have `content_versions`. Its upsert (`:157-161`) overwrites the projection without the version pointers. It must
   adopt §2.6 before any multi-instance promotion of an authored tenant. This is not on the proof's path, because there is a single instance.
2. **Layer 1 trusts a forwarded public PEM.** Any process that reaches `api:3000` directly passes it. §11 closes this for the control path; the general
   lesson belongs in WSK-22's README.
3. **`schema.apply` writes any JSON object** with no composition validation (`control/schema/schema.service.ts:78-117`). WSK-41 adds the check. Until
   then, a malformed schema can break codegen for its tenant.
4. **WSK-31's HIGH endpoints trust the hub's gate** (fact 15). Any future UI button on them would skip WS4. They should move to WSK-66's in-band
   executor as each one is wired.
5. **D41's parenthetical "(a migration plus an envelope MINOR)" is contradicted by the code's classifier.** R1 corrects the text.
6. **WebDesk's `sitemap.xml` assumes `/{collection}/{slug}`.** It is wrong for any tenant with its own URL scheme. A composition-declared path field would fix it later.
7. **`/id/free-audit/` renders no form** (INV §11.5). This is a site bug, the site owner's to fix.

---

## 15. Proposed rulings (for v2.3 §14; numbers assigned at landing)

| # | Proposed ruling | Why |
|---|---|---|
| **R1** | **Typed item values ride a `fields` block at `blocks[0]`, typed by the collection composition. Vocabulary 1.1.0 (MINOR, computed by the extended classifier) adds `group`, `boolean`, `markdown`, generalised `multiple`, and FieldDef `fields`/`itemKey`/`localized`/`ui`. The `/v1` envelope is untouched.** This corrects D41's "(… an envelope MINOR)" parenthetical. | A top-level member is MAJOR by `breaking-change.ts:190-205` and fails WSK-48a's byte gate. `meta.x` fails the same gate (`:287`). Only `blocks` is MINOR and gate-neutral. |
| **R2** | **`content_versions` is the editorial working copy; `content_items` is the live projection the frozen read path serves; publishing is the only way to change what a production key sees.** | Today an edit to a published item is live with no publish (0002:59-87). This makes HIGH publish meaningful without editing the frozen read path. |
| **R3** | (owner Q2) A staging-only rebuild that directly follows an executed WebDesk content command is authorised by that command. Production rebuilds stay D14 `deploy`. | `deploy.staging` is already rated low in the estate. Without this, takedowns leave the static staging site stale until a second approval. |
| **R4** | (owner Q1) A holder of `webdesk_content_item:publish` may approve their own **single-item, non-scheduled** publish. The WS4 row, the Layer-4 assertion, Cerbos and the audit trail all remain. | WSK-31's ALWAYS-WS4 exception was ruled for rare, infrastructure-irreversible commands. Frequent editorial publishing by an authorised publisher is the estate's default case. |
