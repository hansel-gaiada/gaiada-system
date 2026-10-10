# gaiada.com content inventory (WSK-53)

Status: **PROTOTYPED**. Analysis only: nothing was built or run in the site; every count below was read from files (Grep, Glob, Read, `wc`, `du`, read-only `node` over JSON/Markdown). Written 2026-10-10 for the architect (WSK-62) and the importer author.

Machine-readable twin: `inventory.json` (same folder). Gap ids `G1..G16` and question ids `Q1..Q12` are the same in both files.

## 1. What was read

| Item | Value |
|---|---|
| Site | `C:/Users/Hansel/Documents/Hansel/Projects/gaiada-web-revamp`, branch `astro-site` (read-only) |
| Commit at start | `57f583d537f07ad32a144e706c2928bc2fc7871a` |
| Commit at end | `075ff5f1b93543615de86a6ab64f1946c0fbe52b` (another session committed meanwhile; `git diff 57f583d HEAD -- src/config data content docs public` = `src/config/chat.ts`, 2 lines) |
| Uncommitted changes | `?? .claude/` only (untracked, not site content) |
| WebDesk contract read | `webdesk/payload/vocabulary/{primitives,blocks,composition,envelope,locale}.ts`, `collections/redirects.ts`, `migrations/0002_content.sql`, `sites/wsk17-proof/README.md` |
| Scope | all 33 files under `src/config/**` (4,490 lines), `content/{en,id}` (315 files), `data/*.json`, `public/`, `src/scripts/tracking/`, `src/scripts/deck/` |

Not read or run: `npm`, `astro`, any build (a build writes `dist/`), any git command that changes state.

## 2. Headline numbers

| Thing | Number |
|---|---|
| Config modules (`src/config/**`) | **33** files, 4,490 lines; by module class: CMS content 18, CMS global 4, ERP-fed later 2, stays in git 9 (several modules mix content and design fields; see per-field `kind`) |
| Exports with CMS-relevant data, described field by field | 131 (of 158 exported `const`/`function` values; the rest are code helpers, listed per module as `otherExportedValues`) |
| Section types (template x role bindings) | **101**: home 11, About 8, Process 6, Team 9, Careers 7, Contact 7, Pricing 14, Industry 14, Industries hub 3, Services hub 1, Service hero 1, standard kinds 11 + shapes 6, Blog 3 |
| Long-form kinds | **15** (see 5), **315** pages: **235 EN + 80 ID**; 68 EN<->ID pairs; 79 pages built at launch (51 EN + 28 ID) |
| Globals | **9** candidates: company, navigation, footer, contact-channels, assistant, token-registry, ui-strings, redirects, consent |
| `data/*.json` | 7 files + 2 geo TopoJSON; tokens: 256 registered, 252 unresolved, 238 used in content (3,637 occurrences) |
| Media in `public/` | **165 files, 9,237,445 bytes** (about 8.8 MB): 83 OG cards (4.27 MB, generated), 38 diorama posters (2.12 MB, generated), 11 client logos (0.30 MB), 16 brand marks (0.66 MB), 12 fonts (0.39 MB), relief (1.46 MB, generated), 3 mascot posters. **No content photography; no 3D model files** |
| Vocabulary gaps | **16** (section 8). Of the 9 block types only `form` and `logoCloud` fit a site section near as-is (plus `richText` if richtext can hold Markdown, and `testimonial` in shape only); `hero` and `cta` fit partly; `faq` and `featureGrid` need collections that are not defined; `gallery` has no use |

**Read section 8 (vocabulary gaps) and section 9 (stable ids) first; sections 3 to 7 are the supporting inventory.**

**Counts that differ from the docs** (the files win): EN 235 / ID 80 (CONTENT-CLAUDE.md says 228 / 87); 256 tokens with 252 unresolved (README says 248 of 252); launch pages 79 (PAGE_PLAN.md says 78: `/about/team/` is SHOW in the newer `page-plan.json`); `h1` is present in front matter of all 315 pages (`frontmatter.ts` says no page has one); `[CONFIRM` count 4,450 incl. front matter (PAGE_PLAN says 3,774 in bodies; bodies alone give 3,767).

## 3. Summary table: module to class to target

Class = primary class of the module; a module can also contain design/behaviour fields (see the per-module field tables). "Items" = list lengths / records recorded in that module.

| Module | Lines | Class | Target (proposal) | Items | Locales | Consumers |
|---|---|---|---|---|---|---|
| `site.ts` | 64 | CMS global | global `company` | 1 record, 7 people | neutral (+EN boilerplate) | 23 files |
| `links.ts` | 44 | CMS global | global `contact-channels`, `navigation` | 4 message templates | EN + ID | 16 files |
| `env.ts` | 65 | stays in git | git | 8 flags | n/a | 15 files |
| `forms.ts` | 76 | stays in git | git (form-definition contract) | 11 field ids | n/a | 3 files |
| `tracking.ts` | 63 | stays in git | git (+ `consent` global) | 4 ids + 1 label | n/a | 8 files |
| `footer.ts` | 119 | CMS global | global `footer` | 4 titles, 13 links, 4 fact labels | EN+ID pairs | 1 file |
| `page-names.ts` | 81 | CMS content | field `navName` on page items | 31 ID + 28 EN names | EN-only and ID-only tables | 4 files |
| `places.ts` | 69 | stays in git | git (disconnected) | 10 places (dead) | n/a | 2 files |
| `services.ts` | 330 | CMS content | `service` / `industry` item fields; design stays in git | 9 services, 9 industries, 7 seeds | EN (ID in floaters/service-hero) | 47 files |
| `service-hero.ts` | 60 | CMS content | `service` item fields; services hub | 9 + hub | EN+ID | 3 files |
| `industries.ts` | 75 | CMS content | `industry` item fields; ui-strings | 9 x 3 names + 5 UI | EN+ID pairs | 12 files |
| `industries-hub.ts` | 114 | CMS content | industries hub page item | 9 windows (12 spans), 6 ticks, 11 UI | EN data; UI pairs (ID gaps) | 3 files |
| `industry-worlds.ts` | 261 | stays in git | git (design) | 9 worlds (design) | n/a | 24 files |
| `pricing.ts` | 217 | CMS content | pricing page item; `service` item chips | 2 locales; 9 service chip lists (34); 8 driver ends; 2 routes | per-locale record + EN-only | 22 files |
| `blog.ts` | 156 | CMS content | `post`.topic, blog hub item, topic list | 4 topics, 19 post topics, 4 featured, 10 cover words | EN-only | 7 files |
| `chat.ts` | 448 | CMS global | global `assistant` + starter collection | 51 strings x2; 14+1 families; 9 industry nouns | per-locale record + pairs | 3 files |
| `chat-time.ts` | 16 | stays in git | git | 1 function | n/a | 3 files |
| `home/opening.ts` | 129 | CMS content | home page: hero, proof, whatwedo sections | 2 locales proof; 4 metrics; 6 + 3 strings | per-locale record (different shape) + pairs | 4 files |
| `home/case-studies.ts` | 70 | ERP-fed later | home page: casestudies (ERP later) | 3 cases; 4 strings | EN+ID pairs | 4 files |
| `home/client-logos.ts` | 32 | stays in git | git | 1 function | n/a | 1 file |
| `home/cta.ts` | 12 | CMS content | home page: cta | 1 label | EN+ID pair | 1 file |
| `home/faq.ts` | 33 | stays in git | git | constants | n/a | 1 file |
| `home/floaters.ts` | 160 | CMS content | `service` item fields; placement in git | 9 floaters, 7 ghosts | ID one-liner; EN elsewhere | 46 files |
| `home/how-we-work.ts` | 195 | CMS content | home page: howwework | 5 stages x3 bullets x2; 26 panel words; 3 labels | per-locale record (different stages) + pairs | 5 files |
| `home/where-we-work.ts` | 111 | CMS content | home page: wherewework; `company`.office | 10 areas; 3 lines | proper nouns + pairs | 5 files |
| `home/where-we-work-static.ts` | 80 | stays in git | generated | generated | n/a | 1 file |
| `home/who-we-work-with.ts` | 120 | ERP-fed later | `client-logo` collection (ERP later) | 11 client logos; 2 strings | neutral + pairs | 1 file |
| `home/why-gaia.ts` | 66 | CMS content | home page: whyus | 1 heading; 3 nav; 4 art groups | EN+ID pairs | 3 files |
| `company/about.ts` | 134 | CMS content | company.about page item | 10 fact rows; 8 scene lines; 8 ring labels | pairs + per-locale rows | 7 files |
| `company/careers.ts` | 142 | CMS content | company.careers page item | 8 + 5 lists; 16 strings; LIFE 14 keys | EN only | 7 files |
| `company/contact.ts` | 269 | CMS content | company.contact page item | about 49 strings x2 + chips | per-locale record | 7 files |
| `company/process.ts` | 499 | CMS content | company.process page item | EN 10 steps, ID 5 steps + timeline 4 + price | per-locale record (different structure) | 8 files |
| `company/team.ts` | 180 | CMS content | company.team item; `team-member` (ERP later) | 7 people; 9 disciplines; 7 lines; 16 UI keys | EN only | 10 files |

Consumers = files under `src/**` (outside `src/config`) that import the module, from the import graph (relative `from` specifiers resolved to `src/config/*`), plus other config modules that import it. Full lists are in `inventory.json` (`modules[].consumers`).

### Classification rules applied

- **CMS content**: words, numbers, images, order and visibility an editor may change (per CMS_PLAN principle 3).
- **CMS global**: one-per-site records read by many pages (company, navigation, footer, assistant).
- **stays in git**: motion, layout, colour, light rigs, coordinates of drawings, env flags, vendor ids, field-id contracts, build helpers.
- **ERP-fed later** (CMS_PLAN): team members (HR), case-study results (project reports), job openings (HR), client logos (clients module), Google rating (Business Profile). Found here: `site.people`, `home/case-studies.ts` CASES, `home/who-we-work-with.ts` CLIENTS, `site.aggregateRating` and the proof figures in `home/opening.ts`, `data/area-projects.json` counts, and the empty `OPEN` roles block in `careers.ts`.

## 4. Bilingual handling

Two systems, and they do not meet.

**Markdown pages** (`content/en`, `content/id`): two separate trees and two Astro collections (`en`, `id`). English is the source; Indonesian "is written natively rather than translated" (CONTENT_RULES.md). The pair is linked by **absolute paths in front matter**: the EN page carries `hreflang_id`, the ID page carries `hreflang_en`. Measured: 68 EN pages <-> 68 ID pages, every pair reciprocal, no dangling pointer. 167 EN pages have no ID twin (all 66 blog posts, careers, team, guides, research ...). 12 ID pages have no EN twin (4 ID blog posts, 8 keyword landing pages such as `/id/jasa-seo-bali/`). Twins are **not section-for-section**: EN `/about/` has 10 `##` sections, ID `/about/` has 10 but a different set; EN process has 10 steps, ID has 5 stages.

**Config copy** (`src/config/**`): five spellings of one idea, chosen per module:

| Pattern | Where | Example |
|---|---|---|
| Paired object `{ en, id }` per string | footer, industries, industries-hub UI, home strings, case-studies, why-gaia, about (type names `Bi`, `Bilingual`, `L10n`, `Localised`, `Text`: five declarations of one shape; 222 `en:` keys across 16 modules) | `footerWhatsapp = { en: "WhatsApp us", id: "Chat WhatsApp" }` |
| `Record<Locale, X>` where X differs per locale | `PROCESS`, `contactCopy`, `PRICING_COPY`, `CHAT_STRINGS`, `PROOF_TOKENS`, HWW bullets, `FACTS.rows`, `WHY.rings` | `PROCESS.en.steps` has 10 entries, `PROCESS.id.steps` has 5; ID adds `timeline` and `price` |
| Flat columns `label` / `label_id` | `data/navigation.json` | `{ "label": "Services", "label_id": "Layanan", "hub": "All services", "hub_id": "Semua layanan" }` |
| English only (no Indonesian exists) | `careers.ts`, `team.ts`, `SERVICE_COVERS`, `CHOOSE_ROUTES`, `WINDOWS_EN`, `boilerplate_short` | careers page "has no Indonesian twin" |
| Empty string or `[]` means "not drawn in this locale" | `process.ts` EN art/why keys for ID-only scenes, `HUB_UI` id gaps, `contact.ts` ID `form.privacy` | `windowsCaption: { en: "How far ahead ...", id: "" }` |

Two further facts: the **same service one-liner exists in two Indonesian versions** (`floaters.lineId` and `service-hero.kickerId`), and UI strings live in a **third place** outside `src/config` (`src/lib/i18n/strings.ts`, 135 keys x 2 locales), plus inline `{ en, id }` literals in `components/**` (ConsentBanner, scenes/data, industry signature scenes, mh-content).

**What this means for the model (evidence, not a design):**

- A **long-form page** maps cleanly to one `content_items` row per locale with `localization_group_id` = one stable page id. The 12 ID-only pages are singleton groups. The 68 pairs already carry the link.
- A **config section** (home proof, process, pricing scenes, contact) is *not* one item per locale linked by a group: the English and Indonesian versions have different structure and different numbers of parts. It is either one item holding both locales' data in locale-keyed form, or one item per locale with no 1:1 child mapping. Paired `{en,id}` strings inside one record cannot be expressed per field today (G5).
- The locale code differs by layer: front matter `en-GB` / `id`, code `en` / `id`, WebDesk examples `en-US` / `id-ID`; `site.json defaultLocale` is `en` while `0002_content.sql` comments that `id-ID` is the tenant default (Q11).

## 5. Long-form content (`content/en`, `content/id`)

Kinds are derived by URL pattern (the site's own dispatch, `lib/route/pages.ts`), **not** from the front-matter `template`, which is unreliable (`/pricing/` is `case-study`, `/about/` is `core`). Page ids are in `inventory.json` `longForm.pages[]`.

| Kind | Proposed collection | EN | ID | Plan actions | Built at launch | Words (min / mean / max) | Note |
|---|---|---|---|---|---|---|---|
| blog-post | `post` | 66 | 4 | KEEP 14, LATER 31, MERGE 8, CUT 17 | 14 | 597 / 1757 / 2796 | 66 EN + 4 ID. 14 KEEP, 31 LATER (28 EN + 3 ID, scheduled P2/P3), 8 MERGE, 17 CUT (the 12 "best X agencies" listicles + others). isPostUrl() decides post vs article |
| service | `service` | 26 | 26 | MERGE 30, SHOW 22 | 22 | 1301 / 1841 / 2859 | 9 pillars + /services/seo/local-seo/ + /services/paid-media/google-ads/ are SHOW (11 EN + 11 ID); 30 are MERGE (15 EN + 15 ID sub-services folded into pillars). |
| glossary-term | `glossary-term` | 40 | 0 | MERGE 40 | 0 | 500 / 616 / 733 | 40 terms folded into one /glossary/ page (anchors); MERGE. /glossary/ is VISITOR_HIDDEN: built for search, linked from nowhere |
| landing-page | `landing-page` | 10 | 18 | MERGE 28 | 0 | 1280 / 1631 / 2074 | 10 EN keyword variants of an industry page + their 8 ID mirrors/keyword pages; all MERGE into the industry/service they duplicate (page_plan.py) |
| case-study | `case-study` | 25 | 0 | HOLD 25 | 0 | 769 / 962 / 1197 | 25 shells; every figure is a token; all HOLD (D4) |
| location | `location` | 12 | 12 | MERGE 2, CUT 22 | 0 | 1111 / 1518 / 1875 | 12 EN + 12 ID location pages; cut (one office, D1): 22 CUT, 2 MERGE |
| hub | `page` | 13 | 5 | MERGE 3, SHOW 6, HOLD 6, CUT 3 | 6 | 563 / 1121 / 1876 | SHOW: services, industries, blog, glossary (EN) + services, industries (ID). The rest are held, merged or cut. |
| industry | `industry` | 9 | 9 | SHOW 18 | 18 | 718 / 1672 / 2746 | nine industries, all SHOW in both languages; 5 have a per-industry "signature" scene component |
| company-page | `page` | 7 | 5 | SHOW 12 | 12 | 835 / 1384 / 1982 | section roles matched by heading regex per template (AboutTemplate, ProcessTemplate, TeamTemplate, CareersTemplate, ContactTemplate); pricing by shape (lib/pricing/plan.ts). Note data/pages.json calls /pricing/ template "case-study" and about/careers/contact "core". |
| research-report | `research-report` | 7 | 0 | HOLD 7 | 0 | 1591 / 1988 / 2420 | 7 reports with no data; HOLD |
| team-person | `team-member` | 6 | 0 | HOLD 6 | 0 | 487 / 632 / 871 | 6 person pages with no names; HOLD |
| author | `author` | 5 | 0 | MERGE 5 | 0 | 332 / 408 / 524 | 5 role-only author pages, duplicates of team pages; MERGE |
| guide | `guide` | 5 | 0 | KEEP 5 | 5 | 2790 / 3075 / 3637 | 5 pillar guides, all KEEP; rendered through the blog post template |
| tool | `tool` | 3 | 0 | HOLD 3 | 0 | 1017 / 1148 / 1253 | 3 tools that are not built; HOLD |
| home | `page` | 1 | 1 | SHOW 2 | 2 | 1237 / 1347 / 1456 | sections are matched to components BY POSITION (HomeTemplate); copy is the ## sections of index.md plus config/home/* |
| **Total** | | **235** | **80** | SHOW 60, KEEP 19, LATER 31, HOLD 47, MERGE 116, CUT 42 | **79** | | |

### Front matter (the same 17 keys on every kind)

15 keys on all 315 files; `hreflang_id` on 68 EN files and `hreflang_en` on 68 ID files.

| Key | Proposed primitive | Present | Note |
|---|---|---|---|
| `url` | text (req) | 315 | canonical path; starts with /; the site's hard rule "URLs are fixed" |
| `template` | select (req) | 315 | UNRELIABLE as a kind: /pricing/ is "case-study", /about/ is "core"; real dispatch is by URL (lib/route/pages.ts kindOf, lib/company/pages.ts) Options: core, service, industry-location, case-study, article, glossary, mirror. |
| `section` | select (req) | 315 | becomes the analytics `content_group` Options: core, combination, resource, results, article, glossary, indonesian, industry, location, service. |
| `language` | select (req) | 315 | en-GB on all 235 EN pages, "id" on all 80 ID pages. The Locale type in code is en\|id. Options: en-GB, id. |
| `title` | text (req) | 315 | <title>; advisory max 60 chars |
| `description` | text (req) | 315 | meta description; advisory max 155 (1 page is 156) |
| `h1` | text | 315 | PRESENT ON ALL 315 although src/lib/content/frontmatter.ts says "No page has one" and reads it from the manifest; the body also starts with a "# " line. Differs from title (title adds "\| Gaia Digital Agency"). |
| `primary_keyword` | text | 315 | some are "N/A (brand/nav page)" or an em dash |
| `phase` | select (req) | 315 | L 200, P2 78, P3 37. The package's own launch phasing; the plan overrides it Options: L, P2, P3. |
| `schema` | text (list) | 315 | free-form strings such as "Organization ∪ ProfessionalService", "inLanguage id" |
| `hreflang_id` | relation | 68 | on the EN page: absolute path of its ID twin |
| `hreflang_en` | relation | 68 | on the ID page: absolute path of its EN twin |
| `author` | relation | 315 | usually the literal "[CONFIRM: author name and role]" |
| `last_updated` | date | 315 | usually the literal "{{PUBLISH_DATE}}" |
| `publish_ready` | select (req) | 315 | boolean; FALSE on all 315 today |
| `schema_notes` | text | 315 | multi-line prose/YAML-in-YAML block scalar; EN and ID use different internal formats; source of JSON-LD values |
| `image_alt_texts` | text (list) | 315 | 741 entries on 303 pages describing images that do not exist in the repo |

### The body

- Markdown: 2,690 `##` sections with 1,661 distinct headings; 2,340 `###` blocks; 241 tables (1,455 rows) on 174 pages; 5,936 links (5,740 internal); 12 `## Heading {#anchor}`; 30 pages with HTML fragments; 10 image tags on 9 pages (none points at a real file).
- FAQ: 844 EN + 352 ID Q&A pairs (`###` under a FAQ `##`) on 272 pages; 6 + 6 on the home page.
- The front matter `image_alt_texts` (741 entries on 303 pages) describes images that do not exist; there is no content photography.
- A section's component is chosen **at build time** by heading regex (company pages, `lib/sections/rules.ts`), by position (home), by shape (pricing, standard) or by role (industries). Editing a heading can change the layout.

### Visibility today (`data/page-plan.json`)

Generated by `scripts/page_plan.py`; the Python rule list is the source. SHOW 60 (32 EN, 28 ID), KEEP 19, LATER 31 (28 EN + 3 ID; P2 / P3), HOLD 47, MERGE 116 (carry a `to` target), CUT 42. Built = SHOW + KEEP = **79**. HOLD and LATER build only with `PUBLIC_PREVIEW_HELD=true`. Separate from this: `publish_ready` is `false` on all 315, so every page is `noindex` until flipped; `/glossary/` is built but visitor-hidden (`VISITOR_HIDDEN`); `lib/content/curate.ts` hides unverified lines at render.

## 6. `data/*.json`, media, globals

### 6.1 `data/`

| File | Bytes | Shape | Target | Count | Note |
|---|---|---|---|---|---|
| `data/site.json` | 1,855 | object: name, legalName, domain, address{5}, phone, email, people[7]{name,role,email?}, foundingDate, founder, certifications, aggregateRating (4 x [CONFIRM] strings), sameAs[4], areaServed[1], languages[2], defaultLocale, priceCurrency[2], boilerplate_short | CMS global: company | 1 record, 18 top-level keys | single source for Organization schema, llms.txt, footer, contact; people = ERP-fed later (HR) |
| `data/navigation.json` | 1,935 | object: primary[6]{label,label_id,hub?,hub_id?,url,children?[]}, cta{label,label_id,url}, footer_extra[4] | CMS global: navigation | 6 groups (children 9/9/1/0/0/4 = 23 URLs), 1 CTA, 4 footer extras | children are bare English URLs resolved per locale against the manifest and plan; an entry for an unbuilt page is dropped. Label pairs are flat label/label_id columns, a THIRD bilingual convention. |
| `data/redirects.json` | 775 | object: note, redirects[7]{from,to,status} | CMS collection: redirect (the one existing data-only collection) | 7 rows | a TEMPLATE ("regenerate from the live gaiada.com sitemap before launch; every one of the 82 existing URLs must map"). 2 of 7 rows redirect a URL to itself (/services/social-media/ and /blog/). Maps to redirects.ts: slug=from, seo.redirect={toPath,status,active}; the file has no `active`. |
| `data/tokens.json` | 61,758 | object: _instructions, tokens{ "{{NAME}}": { value: string\|null, occurrences, pages[], page_count, source } } | CMS global: token registry (or fields), plus a publish gate | 256 tokens; 252 unresolved (value null), 4 resolved (ADDRESS, PHONE, PRICE_SEO_LOW_IDR, PRICE_SEO_LOW); 238 distinct tokens appear in content; 18 registered tokens are used nowhere; sources: operator 252, factsheet 2, pricelist 2 | README says 248 of 252 unresolved; the file has 256 tokens and 252 null. Families: PRICE 134, RESULT 21, PERSON 30, CPC 18, CLIENT 14, AVG 10, others. |
| `data/pages.json` | 392,928 | array[315]: url, path, lang, template, section, phase, title, h1, primary_keyword, schema[], hreflang_en\|null, hreflang_id\|null, words, tokens[], confirm_count, internal_links[], publish_ready | stays generated (derived from content front matter + body); informs page items | 315 rows, 235 en + 80 id; 297 pages carry >=1 token; publish_ready false on all | a build artefact of the content package; carries computed columns (words, tokens, confirm_count, internal_links). Becomes the importer's cross-check, not a source. |
| `data/page-plan.json` | 66,242 | array[315]: url, lang, section, phase, action(SHOW\|KEEP\|HOLD\|LATER\|MERGE\|CUT), to, why | field on page items: visibility + merge target + reason | SHOW 60 (32 en, 28 id), KEEP 19, LATER 31, HOLD 47, MERGE 116, CUT 42; built at launch = SHOW + KEEP = 79 (51 en + 28 id) | GENERATED by scripts/page_plan.py (the Python rule list is the real source: "To change a decision, edit the script and run it again"). docs/PAGE_PLAN.md says 78 launch pages and 31 EN SHOW; the JSON (newer) has /about/team/ as SHOW, so 79 / 32. 116 rows carry `to` (merge target). |
| `data/area-projects.json` | 601 | object: status("mock"), note, as_of(null), projects{10 area keys -> number} | ERP-fed later (project counts); currently disconnected | 10 numbers, all mock | status "mock": a production build hides every count. The areas map itself was removed (PAGE_PLAN D1). |
| `data/geo/bali-topo.json` | 7,771 | TopoJSON | stays in git / generated (feeds scripts/build_area_maps.py) | 1 file | design/geography asset |
| `data/geo/indonesia-topo.json` | 150,616 | TopoJSON | stays in git / generated (feeds scripts/build-relief.mjs -> public/geo/indonesia-relief.*, and where-we-work-static.ts) | 1 file | design/geography asset |

### 6.2 Globals (candidates)

| Global | Built from | Note |
|---|---|---|
| `company` | data/site.json; src/config/site.ts; src/config/home/where-we-work.ts (OFFICE) | NAP, entity boilerplate, sameAs, areaServed, languages, people (ERP-fed), unresolved founder/foundingDate/certifications/aggregateRating (ERP-fed rating) |
| `navigation` | data/navigation.json; src/config/page-names.ts; src/config/links.ts (erpLogin) | 6 groups, 23 child URLs, 1 CTA; per-locale labels; short page names |
| `footer` | src/config/footer.ts | 4 titles, 7+4+2 links, facts labels, WhatsApp button, clock, consent link label |
| `contact-channels` | src/config/links.ts | four WhatsApp prefill message templates |
| `assistant` | src/config/chat.ts | 51 strings x 2 locales, 4 greetings x 2, 14 starter families + industry family, default starters |
| `token-registry` | data/tokens.json | 256 placeholders and their (mostly null) values and provenance |
| `ui-strings` | src/lib/i18n/strings.ts (outside src/config); src/config/industries.ts UI; src/config/home/opening.ts OPENING_STRINGS; src/config/home/why-gaia.ts NAV | the site's UI string table: 135 keys x 2 locales in strings.ts (not inventoried field by field; outside src/config) |
| `redirects` | data/redirects.json | WebDesk collection `redirect` already exists |
| `consent` | src/config/tracking.ts (consentSettings); src/components/tracking/ConsentBanner.astro (copy, outside src/config) | CMS_PLAN governance: consent text and version |

### 6.3 Media (`public/`, `du`-equivalent by summing file sizes)

| Kind | Path | Files | Bytes | Class | Referenced by |
|---|---|---|---|---|---|
| client logos | `public/brand/clients` | 11 | 302,330 | CMS content, ERP-fed later (clients module) | src/config/home/who-we-work-with.ts CLIENTS |
| brand marks and logos | `public/brand (excluding clients)` | 16 | 660,222 | stays in git (design): gaia-tree at 8 widths, wordmarks, lockups, mark | header, footer, faq, deck, OG renderer |
| OG share cards | `public/og` | 83 | 4,268,054 | GENERATED by scripts/render-og.mjs from page title/keyword, committed. 55 EN (incl. blog 14, guides 5, services, industries) + 28 ID. Regenerated from CMS fields, not uploaded. | lib/seo/meta.ts ogImageMeta(); pages without a card fall back to /og/default.jpg |
| industry diorama posters | `public/industries` | 38 | 2,122,012 | GENERATED by scripts/render-dioramas.mjs from the 3D scene code (9 industries x day/night x full/720 + island x2). Design asset, stays in git. | industry pages, hub |
| assistant mascot posters | `public/chat` | 3 | 38,664 | GENERATED by scripts/render-mascot-poster.mjs; design | chat widget |
| fonts | `public/fonts` | 12 | 387,196 | stays in git (design) | tokens.css |
| geo relief | `public/geo` | 2 | 1,458,967 | GENERATED by scripts/build-relief.mjs from data/geo/indonesia-topo.json (binary heightfield); design | where-we-work 3D scene |
| **Total** | | **165** | **9,237,445** | | |

- No .glb/.gltf/.hdr/.ktx2 anywhere in the repo (excluding node_modules/dist). All 3D is procedural code (src/scripts/home/three/*); only baked posters and the relief binary are files.
- There is none. Markdown has 10 image tags on 9 pages, none pointing at a real file (placeholders such as "(placeholder)", "(#)", "(/)", one absolute https://www.gaiada.com/id/images/local-pack-ubud.jpg). 741 image_alt_texts entries on 303 pages describe images that do not exist.
- dist/ is a build output (20,061 KB on disk at read time) and was not counted.
- Content assets the CMS must carry: the 11 client logos (and future photography). Design assets (brand marks, fonts, posters, relief) stay in git; OG cards are regenerated from CMS page fields by `scripts/render-og.mjs` (which today needs a built site: "Render them with `node scripts/render-og.mjs <built site>`, then rebuild").

## 7. Per-module detail

Legend for fields: `name:primitive` then `!` required, `[n]` list of n, `{n}` record of n keys, locale tag (`pair` = `{en,id}` object, `record` = `Record<Locale,X>`, `EN`, `ID`), `<design|behaviour|contract|erp>` when not copy, `Gx` = gap id (section 8), `{...}` nested members. The primitive is the *closest* of the 8; where the shape cannot be expressed the gap id says why.

### `site.ts` (64 lines, CMS global, 23 consumer files)

Entity facts read from data/site.json (the byte-identical NAP/entity strings). `[CONFIRM: ...]` values are filtered out by confirmed().

Consumed by: `components/company/about/AboutFacts.astro`, `components/company/about/AboutWhere.astro`, `components/company/contact/VisitScene.astro`, `components/company/contact/data.ts`, `components/company/team/TeamWhere.astro`, `components/media-hero/mh-content.ts` and 17 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `site` | `{ name; legalName; productionOrigin; phone; email; address:{street,locality,region,country,full}; people:Person[]; boilerplate?; areaServed:` | CMS global | company (global, singleton) |  | name:text!<br>legalName:text!<br>domain:text!<br>phone:text!<br>email:text!<br>address:text! G1 {street:text!, locality:text, region:text, country:text, full:text}<br>people:relation[7] <erp> G3 {name:text!, role:text!, email:text}<br>boilerplate_short:text EN<br>areaServed:text[1] G2<br>sameAs:text[4] G2<br>foundingDate:date G10<br>founder:text G10<br>certifications:text G10<br>aggregateRating:text <erp> G10<br>languages:select[2] G2<br>defaultLocale:select<br>priceCurrency:select[2] G2 |
| `isUnconfirmed / confirmed` | `function` | stays in git |  |  |  |
| `Person` | `interface { name; role; email? }` | stays in git |  |  |  |

- **site**: Source file is data/site.json (see data[]); site.ts is only the typed reader. site.json also has languages, defaultLocale, priceCurrency that site.ts does not re-export.
  - `name` example: Gaia Digital Agency
  - `legalName` example: Gaia Digital Agency
  - `domain` example: https://gaiada.com (exported as productionOrigin (trailing slash stripped))
- **isUnconfirmed / confirmed**: The `[CONFIRM` convention: a string containing it is treated as absent. See gap G10.
- Note: Many config strings re-state the address ("Mas, Ubud") as literals (about.ts, contact.ts, team.ts) instead of reading it from here.
- Code-only exports (stay in git): `phoneDigits`.

### `links.ts` (44 lines, CMS global, 16 consumer files)

Outbound links: WhatsApp deep links with a prefilled message, mailto, tel, optional ERP login.

Consumed by: `components/blocks/CtaBlock.astro`, `components/company/CoClose.astro`, `components/company/about/AboutHero.astro`, `components/company/contact/data.ts`, `components/company/process/ProcessHero.astro`, `components/company/team/TeamWhere.astro` and 10 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `whatsappUrl(context?) / whatsappUrlId(context?)` | `(context?: string) => string` | CMS global | contact-channels (global) | 4 | whatsappMessageEn:text! EN<br>whatsappMessageEnDefault:text! EN<br>whatsappMessageId:text! ID<br>whatsappMessageIdDefault:text! ID |
| `mailtoUrl, telUrl` | `string (derived from site)` | stays in git |  |  |  |
| `erpLogin / erpLoginId` | `{ href; label } \| undefined` | CMS global | navigation (global) |  | label:text pair G5<br>href:text <behaviour> |

- **whatsappUrl(context?) / whatsappUrlId(context?)**: Four prefilled-message templates live inside the function bodies (EN/ID, with/without context). The Indonesian CTA is WhatsApp-first, so these strings are on the conversion path (`click_whatsapp`).
  - `whatsappMessageEn` example: Hello {name}, I would like to ask about {context}.
  - `whatsappMessageEnDefault` example: Hello {name}, I would like to ask about your services.
  - `whatsappMessageId` example: Halo {name}, saya ingin bertanya tentang {context}.
- **erpLogin / erpLoginId**: href comes from env PUBLIC_ERP_URL (absent today, so the item is omitted). Labels are copy.
  - `label` example: {en:"Client login",id:"Masuk klien"}
  - `href` example: env PUBLIC_ERP_URL (empty)

### `env.ts` (65 lines, stays in git, 15 consumer files)

Build-time environment, resolved once (import.meta.env).

Consumed by: `components/chat/ChatWidget.astro`, `components/nav/StagingNotice.astro`, `config/forms.ts`, `config/forms.ts`, `config/links.ts`, `config/links.ts` and 9 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `env` | `{ siteUrl, deployEnv, isProduction, isStaging, web3formsKey, web3formsCaptcha, erpUrl, previewHeld, tracking, chatEnabled }` | stays in git |  |  | siteUrl:text <behaviour><br>deployEnv:select <behaviour><br>web3formsKey:text <behaviour><br>web3formsCaptcha:select <behaviour> G4<br>erpUrl:text <behaviour><br>previewHeld:select <behaviour> G4<br>tracking:select <behaviour><br>chatEnabled:select <behaviour> G4 |

- **env**: Deployment flags, not content. previewHeld is the only build-level switch for the plan's HOLD/LATER pages.
  - `siteUrl` example: https://24-pyevq.gaiada.com (staging default)
  - `deployEnv` example: staging\|production
  - `web3formsKey` example: (empty)

### `forms.ts` (76 lines, stays in git, 3 consumer files)

Form transport (Web3Forms) and the field-id contract for the contact and audit forms.

Consumed by: `components/forms/AuditForm.astro`, `components/forms/ContactForm.astro`, `components/forms/FormShell.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `forms` | `{ endpoint, accessKey, captcha, honeypotField, redirectPath }` | stays in git | form-definition (WebDesk forms API replaces Web3Forms per CMS_PLAN) |  | endpoint:text <behaviour><br>accessKey:text <behaviour><br>honeypotField:text <behaviour><br>redirectPath:text <behaviour> G9 |
| `CONTACT_FIELDS` | `{ name, contactMethod, email, phone, message } -> string` | stays in git | form-definition | 5 | name:text <contract><br>contactMethod:text <contract><br>email:text <contract><br>phone:text <contract><br>message:text <contract> |
| `AUDIT_FIELDS` | `{ name, email, phone, website, business, message } -> string` | stays in git | form-definition | 6 | name:text <contract><br>email:text <contract><br>phone:text <contract><br>website:text <contract><br>business:text <contract><br>message:text <contract> |

  - `endpoint` example: https://api.web3forms.com/submit
  - `accessKey` example: (empty: PUBLIC_WEB3FORMS_KEY not set)
  - `honeypotField` example: botcheck
- **CONTACT_FIELDS**: Field ids are an integration contract ("rewording a label is free, renaming an id breaks whatever reads the submission"). Labels live in lib/i18n/strings.ts (outside src/config).
  - `name` example: name
  - `contactMethod` example: selectcontact
  - `email` example: email_address
  - `name` example: name
  - `email` example: email_address
  - `phone` example: phone_number
- Code-only exports (stay in git): `WEB3FORMS_ENDPOINT`, `WEB3FORMS_SCRIPT`, `formsAreLive`.

### `tracking.ts` (63 lines, stays in git, 8 consumer files)

Vendor ids, Google Ads conversion labels, consent storage settings. The event list in src/scripts/tracking/events.ts is the contract.

Consumed by: `components/nav/Footer.astro`, `components/tracking/TrackingHead.astro`, `layouts/BaseLayout.astro`, `scripts/tracking/banner.ts`, `scripts/tracking/consent.ts`, `scripts/tracking/events.ts` and 2 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `trackingIds` | `{ ga4, googleAds: [2], metaPixel, clarity }` | stays in git |  |  | ga4:text <behaviour><br>googleAds:text[2] <behaviour> G2<br>metaPixel:text <behaviour><br>clarity:text <behaviour> |
| `adsConversions` | `Record<lead\|whatsapp\|phone\|email, string>` | stays in git |  | 4 | lead:text <behaviour> |
| `consentSettings` | `{ version, storageKey, maxAgeDays }` | stays in git | consent (CMS_PLAN Governance: consent text and versions) |  | version:number <behaviour><br>storageKey:text <behaviour><br>maxAgeDays:number <behaviour> |

  - `ga4` example: G-5VQ8SV62QD
  - `googleAds` example: AW-623220639
  - `metaPixel` example: 1279605996682911
- **adsConversions**: Only `lead` has a label today; the other three are empty strings meaning "send nothing".
  - `lead` example: AW-623220639/cVuSCPuwr6kaEJ-vlqkC
- **consentSettings**: `version` is bumped to re-ask everyone; CMS_PLAN wants consent text and version in governance. The banner copy is in src/components/tracking/ConsentBanner.astro (outside src/config).
  - `version` example: 1
  - `storageKey` example: gaia-consent
  - `maxAgeDays` example: 365
- Code-only exports (stay in git): `trackingMode`, `trackingConfig`.

### `footer.ts` (119 lines, CMS global, 1 consumer file)

The footer's link tables and labels. Services and industries are NOT here (drawn from services.ts, so the footer and the menu cannot disagree).

Consumed by: `components/nav/Footer.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `footerTitles` | `Record<services\|industries\|company\|resources, {en,id}>` | CMS global | footer (global) | 4 | title:text{4} pair G5 |
| `companyLinks` | `FooterLink[]` | CMS global | footer (global) | 7 | label:text! pair G5<br>path:relation! G9 |
| `resourceLinks` | `FooterLink[]` | CMS global | footer (global) | 4 | label:text! pair G5<br>path:text! G9 |
| `legalLinks` | `FooterLink[]` | CMS global | footer (global) | 2 | label:text! pair G5<br>path:relation! G9 |
| `footerConsent` | `{en,id}` | CMS global | footer (global) |  | footerConsent:text pair G5 |
| `footerFacts` | `Record<phone\|email\|office\|time, {en,id}>` | CMS global | footer (global) | 4 | label:text{4} pair G5 |
| `footerWhatsapp` | `{en,id}` | CMS global | footer (global) |  | footerWhatsapp:text pair G5 |
| `footerClock` | `{ label:{en,id}; zone:{en,id} }` | CMS global | footer (global) |  | label:text pair G1,G5<br>zone:text pair G5 |
| `socialNames` | `Record<host, string>` | stays in git |  | 8 |  |

  - `title` example: {en:"Company",id:"Perusahaan"}
- **companyLinks**: 7 rows; order = array order. A row whose page is not built drops out at build time (footerHref).
  - `label` example: {en:"Our process",id:"Proses kerja"}
  - `path` example: /about/process/ (English path; the ID reader gets the /id/ twin when built, else the EN page)
  - `label` example: {en:"FAQ",id:"FAQ"}
  - `path` example: /#faq (a page plus a hash anchor; the relation value {collection, slug} has no hash)
- **legalLinks**: /privacy-policy/ and /terms/ do not exist yet (not in the 315-page package).
  - `label` example: {en:"Privacy policy",id:"Kebijakan privasi"}
  - `path` example: /privacy-policy/
  - `footerConsent` example: {en:"Cookie settings",id:"Pengaturan cookie"}
  - `label` example: {en:"Phone & WhatsApp",id:"Telepon & WhatsApp"}
  - `footerWhatsapp` example: {en:"WhatsApp us",id:"Chat WhatsApp"}
  - `label` example: {en:"{time} in Ubud",id:"{time} di Ubud"} with a {time} placeholder
  - `zone` example: {en:"GMT+8",id:"WITA"}
- **socialNames**: host -> display name lookup (linkedin.com -> LinkedIn). The profile URLs are site.sameAs.
- Code-only exports (stay in git): `socialName`, `footerHref`.

### `page-names.ts` (81 lines, CMS content, 4 consumer files)

Short page names for menus and cards (the h1 carries a keyword; a menu wants "SEO"), per locale, keyed by English path.

Consumed by: `components/nav/Footer.astro`, `components/nav/LanguageSwitcher.astro`, `lib/content/curate.ts`, `lib/navigation/index.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `ID_NAMES (not exported)` | `Record<englishPath, string>` | CMS content | field `navName` on each page item, locale id | 31 | navName:text{31} ID |
| `EN_NAMES (not exported)` | `Record<englishPath, string>` | CMS content | field `navName` on each page item, locale en | 28 | navName:text{28} EN |

- **ID_NAMES (not exported)**: 31 hand-written Indonesian short names: 9 services + 2 sub-services + 2 hubs + 9 industries + company pages + glossary/pricing. Each restates what the page already calls itself.
  - `navName` example: /services/ai-search-optimization/ -> "Optimasi AI Search"
- **EN_NAMES (not exported)**: 10 literals + 18 derived from SERVICES[].label and INDUSTRIES[].label (so those 9+9 names are also in services.ts).
  - `navName` example: /about/team/ -> "Team"
- Note: The same nine service names are written in 4 places (services.ts label, page-names.ts, service-hero.ts short, nav/footer) and the nine industries in 5 (INDUSTRIES.label, industries.ts NAMES + SHORT_NAMES, page-names ID_NAMES, chat INDUSTRY_WORDS).
- Code-only exports (stay in git): `englishPath`, `pageName`.

### `places.ts` (69 lines, stays in git, 2 consumer files)

Coordinates and project counts for the areas map. DISCONNECTED: docs/PAGE_PLAN.md D1 removed the areas map; files stay until the home branches merge.

Consumed by: `components/blocks/AreaMap.astro`, `components/blocks/AreasServed.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `PLACES (not exported)` | `Record<key, PlaceGeo>` | stays in git | (none; dead per PAGE_PLAN D1) | 10 | key:text <design><br>map:select <design><br>lat:number <design><br>lon:number <design> G14 |
| `areaStatus / projectsAt` | `reads data/area-projects.json` | ERP-fed later |  |  |  |

- **PLACES (not exported)**: Importer should skip. Places: ubud, canggu, seminyak, uluwatu, sanur, nusa-dua, denpasar, jimbaran, lombok-gili, jakarta.
  - `key` example: ubud
  - `map` example: bali\|java
  - `lat` example: -8.5069
- **areaStatus / projectsAt**: Per-area project counts are mock (status "mock"); a production build hides them. Real counts would come from ERP project reports.
- Code-only exports (stay in git): `MAP_ORIGINS`, `placeFor`.

### `services.ts` (330 lines, CMS content, 47 consumer files)

The nine services and nine industries as the home page composes them. Labels/descriptions are copy; colours, floats and coordinates are design (WHY THIS IS A CONFIG FILE: "a copywriter could "fix" a number that is actually a position").

Consumed by: `components/blocks/LinkCards.astro`, `components/blocks/PageHero.astro`, `components/company/about/AboutHero.astro`, `components/company/about/about-data.ts`, `components/company/contact/FormScene.astro`, `components/home/HomeHero.astro` and 41 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `SERVICES` | `Service[]` | CMS content | service (copy fields land on the service page item; design fields stay in git keyed by `key`) | 9 | key:text! <contract> G9<br>label:text! EN<br>description:text! EN<br>href:relation! G9<br>tone:text <design><br>tint:text <design><br>breakAfter:text <design><br>amp:number <design><br>pad:number[2] <design> G14<br>duration:number <design><br>delay:number <design><br>hero:number[2] <design> G14<br>proof:number[2] <design> G14 |
| `INDUSTRIES` | `Industry[]` | CMS content | industry (copy on the industry page item; tone stays in git) | 9 | key:text! <contract> G9<br>label:text! EN<br>href:relation! G9<br>tone:text <design> |
| `SEEDS` | `{key,cx,cy,fill}[]` | stays in git |  | 7 | key:text <design><br>cx:number <design><br>cy:number <design><br>fill:text <design> |
| `serviceKeyOf / serviceTone / shortLabel` | `functions` | stays in git |  |  |  |

- **SERVICES**: Order = paint order = what overlaps what. 9 = the latest decision (docs/DECISIONS.md); earlier docs said 6 and 7.
  - `key` example: ai-search (also the CSS suffix and the DOM data value. NOT equal to the URL slug (ai-search vs ai-search-optimization; pr-digital-pr vs public-relations))
  - `label` example: AI Search Optimisation
  - `description` example: Named when travellers ask ChatGPT or AI Overviews. (the Indonesian twin is in floaters.lineId AND service-hero.kickerId: two different Indonesian sentences for the same service)
- **INDUSTRIES**: key here (hotels, villas, restaurants, ...) differs from INDUSTRY_KEYS in industry-worlds.ts (hotels-resorts, villas-vacation-rentals, ...). The design OMITTED Restaurants & Bars and shows no client counts (deliberate, see file note).
  - `key` example: hotels
  - `label` example: Hotels & Resorts
  - `href` example: /industries/hotels-resorts/
- **SEEDS**: Coordinates of the 7 coloured seeds on the logo mark (viewBox 100). Pure design.
  - `key` example: social-media
  - `cx` example: 28.489
  - `cy` example: 84.311
- **serviceKeyOf / serviceTone / shortLabel**: shortLabel trims "Marketing Agency Bali" etc. off h1s with regexes; the short names it cannot derive come from SERVICES/INDUSTRIES labels.

### `service-hero.ts` (60 lines, CMS content, 3 consumer files)

Kicker line above each service hero, plus the services hub kicker.

Consumed by: `components/hub/Switchboard.astro`, `components/media-hero/MediaHero.astro`, `components/scenes/StartScene.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `SERVICE_HERO` | `Record<serviceKey, { short; kickerId }>` | CMS content | service (fields shortName, kickerId) | 9 | short:text!<br>kickerId:text! ID |
| `HUB_HERO` | `Record<en\|id, { kicker; mapLabel }>` | CMS content | services hub page item | 2 | kicker:text pair G5<br>mapLabel:text pair G5 |
| `serviceKicker` | `function` | stays in git |  |  |  |

  - `short` example: AI Search (fixed entity name cut short; same in both languages)
  - `kickerId` example: Disebut saat wisatawan bertanya ke ChatGPT atau AI Overviews.
  - `kicker` example: {en:"Nine services, priced alone or combined.",id:"Sembilan layanan, dipakai terpisah atau digabung."}
  - `mapLabel` example: {en:"Services",id:"Layanan"}
- Note: The services hub kicker says "Nine services" as a literal: a tenth service would make the copy false (see open questions).

### `industries.ts` (75 lines, CMS content, 12 consumer files)

Words the industry pages show that are not a section of their copy: names, short names, outcomes, UI labels.

Consumed by: `components/company/about/AboutIndustries.astro`, `components/company/about/about-data.ts`, `components/industries/IndPlaybook.astro`, `components/industries/IndServices.astro`, `components/industries/IndWhere.astro`, `components/industries/hero/HeroDiorama.astro` and 6 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `NAMES` | `Record<IndustryKey, {en,id}>` | CMS content | industry page item (field name) | 9 | name:text! pair G5 |
| `SHORT_NAMES` | `Record<IndustryKey, {en,id}>` | CMS content | industry page item (field shortName) | 9 | shortName:text! pair G5 |
| `OUTCOMES` | `Record<IndustryKey, {en,id}>` | CMS content | industry page item (field outcome) | 9 | outcome:text! pair G5 |
| `UI` | `{drag, figuresPending, neighbours, step, of} -> {en,id}` | CMS content | ui-strings (global) | 5 | string:text{5} pair G5 |
| `industryKeyOf / isIndustryHub` | `functions` | stays in git |  |  |  |

  - `name` example: {en:"Restaurants, Cafés & Bars",id:"Restoran, Kafe & Bar"}
  - `shortName` example: {en:"Villas",id:"Vila"}
- **OUTCOMES**: each outcome restates the page's own services heading
  - `outcome` example: {en:"Direct bookings",id:"Direct booking"}
  - `string` example: {en:"Neighbouring industries",id:"Industri terdekat"}

### `industries-hub.ts` (114 lines, CMS content, 3 consumer files)

What the industries hub draws: decision windows (how far ahead each industry decides), the time axis, and UI strings.

Consumed by: `components/industries/hub/HubHero.astro`, `components/industries/hub/HubReason.astro`, `templates/IndustryHubTemplate.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `WINDOWS_EN` | `Window[] = { key: IndustryKey; label?: string; spans: { from:number; to:number; note:string }[] }[]` | CMS content | industries hub page item, list field `decisionWindows` | 9 | key:relation! G9<br>label:text EN<br>spans:text![1-2 per row (12 total)] G3 {from:number!, to:number!, note:text!} |
| `TICKS_EN` | `{h:number,label:string}[]` | CMS content | industries hub page item | 6 | h:number<br>label:text EN |
| `AXIS` | `{far, near}` | stays in git |  |  |  |
| `HUB_UI` | `{kicker, find, none, hint, windowsCaption, booking, yearCaption, high, months, drivers, range} -> {en,id}` | CMS content | industries hub page item | 11 | string:text{11} pair G5,G2,G13 |
| `HUB_STYLE` | `string (CSS custom properties)` | stays in git |  |  |  |
| `axisX` | `function` | stays in git |  |  |  |

- **WINDOWS_EN**: 9 rows (wellness appears twice: retreats and spas), 12 spans. Every number restates a sentence on the industry page (the source sentence is quoted in a code comment). Hours are computed from months/weeks/days. Only the English hub shows the chart.
  - `key` example: wellness-retreats-spas
  - `label` example: Retreats
  - `spans` example: {from: 8*WEEK, to: 16*WEEK, note: "8-16 weeks"}
  - `h` example: 8760
  - `label` example: 1 year
- **HUB_UI**: Several id values are empty strings meaning "not drawn in Indonesian" (windowsCaption, drivers, range). `months` and `drivers` are space/pipe-delimited strings pretending to be lists.
  - `string` example: {en:"Property size\|Number of locations\|Ad spend",id:""}

### `industry-worlds.ts` (261 lines, stays in git, 24 consumer files)

The nine industry "worlds": hue, sky, light rig for the 3D diorama. Pure design ("the CMS edits content, not design"). Its only CMS-relevant contribution is the registry of the nine industry keys.

Consumed by: `components/company/about/AboutIndustries.astro`, `components/company/about/about-data.ts`, `components/industries/IndCta.astro`, `components/industries/IndDifferent.astro`, `components/industries/IndHero.astro`, `components/industries/IndPlaybook.astro` and 18 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `INDUSTRY_KEYS` | `readonly string[] (9)` | stays in git | industry (slug registry) | 9 | key:text <contract> |
| `WORLDS` | `Record<IndustryKey, World>` | stays in git |  | 9 | hue:text <design><br>sky:text[3] <design> G2<br>dark:select <design> G4<br>day:text <design> G1 |
| `NIGHT` | `Rig` | stays in git |  |  |  |
| `worldStyle` | `function` | stays in git |  |  |  |

- **INDUSTRY_KEYS**: hotels-resorts, villas-vacation-rentals, restaurants-bars, wellness-retreats-spas, beach-clubs-nightlife, real-estate-developers, tours-experiences, retail-fashion-lifestyle, international-brands-indonesia
  - `key` example: hotels-resorts
- **WORLDS**: World = { key, hue, sky:[3 colours], dark:boolean, paper, wash, deep, glow, day:Rig{16 numeric fields}, materials? }. All design.
  - `hue` example: #0e5c8a
  - `sky` example: ["#dcebf2","#eef4f2","#fbf6e9"]
  - `dark` example: false
- Code-only exports (stay in git): `isIndustryKey`.

### `pricing.ts` (217 lines, CMS content, 22 consumer files)

The pricing page's own design copy: the short line each scene is drawn around, in both languages. "Every line restates the page"; no figure appears here that the page does not already state.

Consumed by: `components/pricing/DriversScene.astro`, `components/pricing/PillarsScene.astro`, `components/pricing/PriceTag.astro`, `components/pricing/PricingClose.astro`, `components/pricing/PricingHero.astro`, `components/pricing/PzScene.astro` and 16 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `PRICING_COPY` | `Record<Locale, PricingCopy>` | CMS content | pricing page item (one per locale) | 2 | cover:text![2] G2<br>outcomes:text![3] G2<br>labels:text{9 en / 5 id} G1<br>eyebrows:text!{12} G1<br>perMonth / oneOff / from / pending / illustrative / covers / includes / bestFor / fullScope / scope / scopeLean / scopeFull / quotedIn / closeRange / closeYours:text{15} |
| `SERVICE_COVERS` | `Record<serviceKey, string[]>` | CMS content | service page item, list field `coversChips` | 9 | chips:text[3-5 each (34 total)] G2 |
| `DRIVER_ENDS` | `Record<string, [string,string]>` | CMS content | pricing page item, list field `driverEnds` | 8 | lead:text! G9,G13<br>ends:text![2] G2 |
| `CHOOSE_ROUTES` | `Route[] = { who, baseline, first:string[], then:string[], why }[]` | CMS content | pricing page item, list field `routes` | 2 | who:text! EN<br>baseline:text! EN<br>first:relation![] G2,G9<br>then:relation[] G2,G9<br>why:text! EN |
| `PricingRole` | `union of 12 roles` | stays in git |  |  |  |

- **PRICING_COPY**: The two locales have different key sets: EN labels has 9 keys, ID labels 5 (missing scenes are simply absent); both have 12 eyebrows.
  - `cover` example: ["Priced in ranges.","Measured in bookings."]
  - `outcomes` example: ["Found on Google","Recommended by AI","Booked direct"]
  - `labels` example: {spend:"Most of a budget works in the market, not in our fee.", ...} (keyed by PricingRole; one large line per scene)
- **SERVICE_COVERS**: "English only, because only the English page has per-service paragraphs". 34 chips in total.
  - `chips` example: ["Technical fixes","On-page work","Local SEO","Google Business Profile","Link building"]
- **DRIVER_ENDS**: KEYED BY THE LOWERCASED BOLD LEAD-IN of a markdown bullet ("number of locations or listings"). Editing that bullet's wording silently drops the dial.
  - `lead` example: number of locations or listings
  - `ends` example: ["One venue","A group of outlets"]
- **CHOOSE_ROUTES**: first/then hold SERVICE KEYS (seo, social-media, ...), i.e. references to the services collection written as strings.
  - `who` example: A restaurant in Ubud
  - `baseline` example: No reviews strategy, a weak Google Business Profile
  - `first` example: ["seo","social-media"]
- **PricingRole**: spend, rates, drivers, services, tiers, results, choose, report, steps, pillars, prose, related. The role of each pricing section is decided by lib/pricing/plan.ts from the section's SHAPE, not stored anywhere.

### `blog.ts` (156 lines, CMS content, 7 consumer files)

The blog's editorial settings: topics, per-post topic assignment, featured stories, cover words.

Consumed by: `components/blog/MagCover.astro`, `components/blog/PostCard.astro`, `components/blog/ScreenArt.astro`, `components/scenes/reading/shelf.ts`, `lib/content/blog-index.ts`, `templates/BlogTemplate.astro` and 1 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `BLOG_TOPICS` | `BlogTopic[] = { key, label, service, art }` | CMS content | blog-topic (small collection) or select options | 4 | key:text! <contract><br>label:text! EN<br>service:relation <design> G9<br>art:select <design> |
| `TOPIC_BY_URL (not exported)` | `Record<url, topicKey>` | CMS content | field `topic` on each blog-post / guide item | 19 | topic:select! EN |
| `FEATURED_URLS` | `string[]` | CMS content | blog hub page item, ordered relation list `featured` | 4 | featured:relation![4] G2,G6,G9 |
| `COVER_SUBJECTS` | `string[]` | CMS content | blog hub page item, list field `coverSubjects` | 10 | coverSubjects:text![10] G2,G6 |
| `ARCHIVE_PAGE_SIZE / ARCHIVE_PAGE_SIZE_PHONE / WORDS_PER_MINUTE` | `numbers` | stays in git |  |  |  |
| `topicPastel / artFor / topicFor` | `functions` | stays in git |  |  |  |

  - `key` example: ai-search
  - `label` example: AI search
  - `service` example: ai-search (the service whose pastel the topic borrows)
- **TOPIC_BY_URL (not exported)**: 5 guides + 14 posts. A post not listed falls back to regex rules on its URL (topicFor): cost|price -> pricing, geo|aeo|chatgpt|ai- -> ai-search, seo|google -> seo, else marketing.
  - `topic` example: ai-search (select options = BLOG_TOPICS keys)
- **FEATURED_URLS**: The lead story then 02-04. A URL that is not built is skipped and the next fills in.
  - `featured` example: ["/guides/get-recommended-by-chatgpt/", ...]
- **COVER_SUBJECTS**: The cover line's rotating subject; the LAST word is also the static HTML for crawlers.
  - `coverSubjects` example: ["hotels","villas",...,"businesses"]
- **ARCHIVE_PAGE_SIZE / ARCHIVE_PAGE_SIZE_PHONE / WORDS_PER_MINUTE**: layout and reading-speed constants (6, 3, 220)

### `chat.ts` (448 lines, CMS global, 3 consumer files)

Tunas, the site assistant: every word the widget shows, plus page-aware starter questions and teaser lines.

Consumed by: `components/chat/ChatWidget.astro`, `scripts/chat/index.ts`, `scripts/chat/panel.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `MASCOT_NAME` | `'Tunas'` | CMS global | assistant (global) |  | mascotName:text! |
| `CHAT_STRINGS` | `Record<Locale, ChatStrings>` | CMS global | assistant (global) | 2 | strings:text!{51} G1 |
| `GREET (not exported)` | `Record<Locale, [4 strings]>` | CMS global | assistant (global) | 2 | greet:text![4] G2 |
| `FAMILIES (not exported)` | `Family[] = { test(path), q:{en:[Q,Q], id:[Q,Q]}, teaser:{en,id} }` | CMS global | assistant-starter (collection) keyed by URL prefix | 14 | pathPrefix:text! <behaviour><br>questions:text![2] pair G3,G5 {text:text!, icon:select}<br>teaser:text! pair G5 |
| `DEFAULT_Q / DEFAULT_TEASER (not exported)` | `fallback starter set` | CMS global | assistant (global) | 1 |  |
| `INDUSTRY_WORDS (not exported)` | `Record<industryKey, {en,id}>` | CMS content | industry page item (field audienceNoun) | 9 | audienceNoun:text! pair G5 |
| `QUIET (not exported)` | `['/contact/','/onboard/','/thank-you/']` | stays in git |  |  |  |
| `startersFor / teaserFor / chatPayload / englishPathOf / WA_SLOT` | `functions and a constant` | stays in git |  |  |  |

  - `mascotName` example: Tunas
- **CHAT_STRINGS**: 51 string keys per locale (EN object has 51; the ChatStrings interface lists them). Contacts are never typed here: they come from site.ts and links.ts. Strings carry placeholders {t} and {n}.
  - `strings` example: {pill:"Ask Tunas", leadDone:"Thank you, {n}. The team has your details ...", ...}
  - `greet` example: ["Selamat pagi.","Selamat siang.","Selamat sore.","Selamat malam."]
- **FAMILIES (not exported)**: 14 families: 9 service pillars + services hub + pricing + careers + contact + about, matched by a code predicate on the English path prefix, plus one DYNAMIC industry family built from INDUSTRY_WORDS (9). Each question is a [text, icon] tuple.
  - `pathPrefix` example: /services/seo/ (a function today (starts(...)))
  - `questions` example: [["How long does SEO take?","clock"],["How much does SEO cost?","tag"]]
  - `teaser` example: {en:"Wondering how long SEO takes? Ask me.",id:"Penasaran berapa lama SEO memberi hasil? Tanya saya."}
- **INDUSTRY_WORDS (not exported)**: a THIRD wording of the nine industries ("hotels and resorts", "tour and activity operators")
  - `audienceNoun` example: {en:"property developers",id:"pengembang properti"}
- Note: The assistant also has a knowledge pack built from content/ + data/ by scripts/build-chat-kb.mjs (generated, never edited) and a server in /chat. Neither is CMS content; both would consume CMS output instead of markdown.
- Code-only exports (stay in git): `baliPeriod`.

### `chat-time.ts` (16 lines, stays in git, 3 consumer files)

baliPeriod(): which part of the Bali day it is (WITA). Code only.

Consumed by: `config/chat.ts`, `config/chat.ts`, `scripts/chat/panel.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `baliPeriod` | `(now?: Date) => 0\|1\|2\|3` | stays in git |  |  |  |


### `home/opening.ts` (129 lines, CMS content, 4 consumer files)

Home opening: the proof figures and the strings the design adds that the content file does not hold. Serves home.hero, home.proof and home.whatwedo.

Consumed by: `components/home/HomeHero.astro`, `components/home/HomeProof.astro`, `components/home/HomeWhatWeDo.astro`, `scripts/home-journey.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `PROOF_TOKENS` | `Record<Locale, ProofPiece[][]>  (ProofPiece = string \| { gold:string; tally?:boolean; badge?:boolean })` | CMS content | home page item, section `proof` | 2 | pieces:text![EN 6 runs / ID 3 runs] record G3,G10,G5 {text:text, gold:text!, tally:select, badge:select} |
| `PROOF_METRICS` | `ProofMetric[] = { kicker?:Localised; label:Localised; stars?:boolean; from?:number }[]` | CMS content | home page item, section `proof` | 4 | kicker:text pair G5<br>label:text! pair G5<br>stars:select G4<br>from:number <design> |
| `PROOF_SEATS` | `Record<serviceKey, [number,number]>` | stays in git |  | 9 | serviceKey:text <design> G14 |
| `OPENING_STRINGS` | `Record<6 keys, Localised>` | CMS content | ui-strings (global) or home page item | 6 | scrollContinue / wwdGaugeLabel / wwdGoTo / learnMore / learnMoreTopic / wwdSubtitle:text{6} pair G5 |
| `HERO_STRINGS` | `{brand, descriptor, capabilities} -> Localised` | CMS content | home page item, section `hero` | 3 | brand:text pair G5<br>descriptor:text pair G5<br>capabilities:text pair G5 |

- **PROOF_TOKENS**: REPLACES the content file's [CONFIRM: ...] placeholders in the proof paragraph, in order. EN has 6 token slots (rating, count, platform, status, brands, year), ID has 3 slots each a whole sentence. If the page carries a different number of tokens the section falls back to the paragraph as written. THESE ARE UNVERIFIED CLAIMS (4.9 stars, 127 reviews, 60+ brands, since 2017) that bypass the {{TOKEN}} gate; site.json aggregateRating and foundingDate are still [CONFIRM].
  - `pieces` example: EN [ [{gold:'4.9',tally:true}], [{gold:'127',tally:true}], [{gold:'Google'}], ['a ',{gold:'Google Partner',badge:true}], ... ] (a union: each run is a plain string OR an object)
- **PROOF_METRICS**: One entry per tally in PROOF_TOKENS, same order; the FIGURE always comes from PROOF_TOKENS (so figure and label are joined by array position across two exports). If counts differ the section shows the sentence instead.
  - `kicker` example: {en:"Since",id:"Sejak"}
  - `label` example: {en:"Reviews on Google",id:"Ulasan di Google"}
  - `stars` example: true (draws 5 stars)
- **PROOF_SEATS**: where the nine pills sit round the metrics (percent of field)
  - `serviceKey` example: 'social-media': [16, 15]
  - `scrollContinue / wwdGaugeLabel / wwdGoTo / learnMore / learnMoreTopic / wwdSubtitle` example: {en:"Nine services, one team, working from the same office in Ubud, Bali.",id:"Sembilan layanan, satu tim, bekerja dari kantor yang sama di Ubud, Bali."} (6 keys; the subtitle says "Nine" as a literal)
- **HERO_STRINGS**: h1 reads "Gaia Digital Marketing Agency": brand from the wordmark, descriptor from here. The positioning line was removed by the owner on 2026-10-09.
  - `brand` example: {en:"Gaia",id:"Gaia"}
  - `descriptor` example: {en:"Digital Marketing Agency",id:"Digital Marketing Agency"}
  - `capabilities` example: {en:"What we do",id:"Layanan kami"}
- Note: The home hero h1/answer/CTA line, the proof paragraph, "What we do" list, results lines and FAQ are NOT here: they are the ## sections of content/{en,id}/index.md. Sections are matched to components BY POSITION (HomeTemplate DESIGNED_COUNT = 10), so a CMS section needs an explicit role/position, not a heading.

### `home/case-studies.ts` (70 lines, ERP-fed later, 4 consumer files)

Featured case studies on the home page: three result figures and the strings the content file lacks. Unverified client claims, shipped "as designed" (decision 2026-10-07).

Consumed by: `components/home/CaseStudiesCard.astro`, `components/home/HomeCaseStudies.astro`, `scripts/home/sections/case-studies-chart.ts`, `scripts/home/sections/case-studies.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `CASES` | `CaseFigures[] = { stat, baseline?, result, months, label:L10n, resultLine:L10n, monthsLine:L10n, tone }` | ERP-fed later | home page item, section `casestudies` (later: linked to case-study items fed from project reports) | 3 | stat:number! <erp> G10<br>baseline:number <erp><br>result:number! <erp><br>months:number! <erp><br>label:text! pair G5<br>resultLine:text! pair G5<br>monthsLine:text! pair G5<br>tone:relation <design> G9 |
| `STRINGS` | `{result, challenge, button, href} -> L10n` | CMS content | home page item, section `casestudies` | 4 | result / challenge / button:text{3} pair G5<br>href:relation pair G9 |
| `toneOf / Loc / L10n` | `helper + types` | stays in git |  |  |  |

- **CASES**: Fills the content's [CONFIRM: ...] placeholders. Order = column order. stat=64 (baseline 120 -> result 197 in 6 months), 87 (5 months), 46 (4 months). Result lines carry a {n} placeholder and a static "%".
  - `stat` example: 64
  - `baseline` example: 120
  - `result` example: 197
  - `result / challenge / button` example: {en:"Full Case Studies",id:"Lihat semua studi kasus"}
  - `href` example: {en:"/case-studies/",id:"/id/case-studies/"} (a locale-specific URL pair typed by hand (the page is held))

### `home/client-logos.ts` (32 lines, stays in git, 1 consumer file)

logoRatio(): reads a WebP file's width/height from its header at build time. Code only.

Consumed by: `components/home/HomeWhoWeWorkWith.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `logoRatio` | `(dir, file) => number` | stays in git |  |  |  |


### `home/cta.ts` (12 lines, CMS content, 1 consumer file)

Home closing CTA button label and the mark's float.

Consumed by: `components/home/HomeCta.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `ctaButton` | `L10n` | CMS content | home page item, section `cta` / cta registry |  | ctaButton:text! pair G5 |
| `ctaMark` | `{size, amplitude, duration, delay}` | stays in git |  |  |  |

  - `ctaButton` example: {en:"Request Free Audit",id:"Minta Audit Gratis"} (the header CTA in data/navigation.json says "Get your free audit" / "Minta audit gratis": two wordings of one CTA)

### `home/faq.ts` (33 lines, stays in git, 1 consumer file)

Home FAQ motion constants (breakpoints, timings, travel). No copy: the FAQ questions and answers are the ### blocks of the content file.

Consumed by: `scripts/home/sections/faq.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `SPLIT_QUERY, CARD_QUERY, T, SWAP_SHIFT, RISE` | `media queries and numbers` | stays in git |  |  |  |


### `home/floaters.ts` (160 lines, CMS content, 46 consumer files)

The hero's nine capability floaters: short name, Indonesian one-liner, pastel, depth and place. Keyed by service key.

Consumed by: `components/company/about/AboutCycle.astro`, `components/company/about/AboutHero.astro`, `components/company/about/AboutServices.astro`, `components/company/about/about-data.ts`, `components/company/careers/CarHero.astro`, `components/company/careers/CarHow.astro` and 40 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `FLOATERS` | `Record<serviceKey, FloaterSpec>` | CMS content | service page item (fields shortName, lineId); placement stays in git | 9 | short:text!<br>lineId:text! ID<br>area:select <design><br>depth:select <design><br>fill:text <design><br>x:number <design><br>y:number <design> |
| `FLOATER_ORDER` | `Record<area, serviceKey[]>` | stays in git |  | 9 |  |
| `GHOSTS` | `Record<area, {x,y,w,fill}[]>` | stays in git |  | 7 |  |
| `floaterLine / glyphDelay` | `functions` | stays in git |  |  |  |

  - `short` example: AI Search
  - `lineId` example: Direkomendasikan saat tamu bertanya ke ChatGPT. (differs from service-hero.kickerId for the same service)
  - `area` example: left\|top\|right\|bottom
- **GHOSTS**: blank out-of-focus pills; nothing to read

### `home/how-we-work.ts` (195 lines, CMS content, 5 consumer files)

Home "How we work": per-stage bullets, panel labels, button and link; plus the motion constants. The heading, lede and the five stage titles are in the content file.

Consumed by: `components/blocks/CtaBlock.astro`, `components/home/HomeHowWeWork.astro`, `components/home/HowWeWorkPanels.astro`, `scripts/home/sections/how-we-work-camera.ts`, `scripts/home/sections/how-we-work.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `bullets (not exported; via howWeWorkStrings)` | `Record<Locale, string[][]>` | CMS content | home page item, section `howwework` (stage list per locale) | 2 | stages:text![5 per locale] record G3,G5 {bullet:text!}<br>scene:select[5] <design> G2 |
| `panel (not exported; via howWeWorkStrings().words)` | `Record<26 keys, Bilingual \| {en:string[]; id:string[]}>` | CMS content | home page item, section `howwework` | 26 | word:text{26} pair G5,G2 |
| `label (not exported)` | `{button, timeline, stage} -> Bilingual` | CMS content | home page item, section `howwework` | 3 | button / timeline / stage:text{3} pair G5 |
| `href (not exported)` | `Bilingual` | CMS content | home page item, section `howwework` |  | href:relation pair G9 |
| `HWW_TONES, HWW_NODES, HWW` | `colours, node positions, motion numbers` | stays in git |  |  |  |
| `howWeWorkStrings, HwwScene` | `function and type` | stays in git |  |  |  |

- **bullets (not exported; via howWeWorkStrings)**: EN has 5 stages x 3 bullets, ID has 5 stages x 3 bullets, but the stages differ: EN starts at Free audit, ID at Konsultasi gratis. "Each locale carries its own lists in its own stage order rather than translations of one another." Each list is condensed from the process page.
  - `stages` example: EN[0] = ['A 45-minute discovery call', 'Website, Google Business Profile, ad accounts and social channels', 'A prioritised PDF of the findings']
  - `scene` example: en ['audit','plan','build','measure','scale'] / id ['talk','audit','plan','build','measure'] (which drawing each stage gets)
- **panel (not exported; via howWeWorkStrings().words)**: Labels printed on the floating panels ("labels only, never values"). Some values are arrays of strings in each language, with different lengths per language.
  - `word` example: steps: {en:['Local SEO','Campaigns','Content'], id:['Booking langsung','Traffic organik','Leads']}
- **label (not exported)**: stage has {n} and {total} placeholders
  - `button / timeline / stage` example: {en:"Step {n} of {total}",id:"Langkah {n} dari {total}"}
  - `href` example: {en:"/about/process/",id:"/id/about/process/"}

### `home/where-we-work.ts` (111 lines, CMS content, 5 consumer files)

Home "Where we work": the ten areas, the camera frames and timings, and three short lines. One office, in Ubud.

Consumed by: `components/home/HomeWhereWeWork.astro`, `config/home/where-we-work-static.ts`, `config/home/where-we-work-static.ts`, `scripts/home/sections/where-we-work-overlay.ts`, `scripts/home/sections/where-we-work.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `AREAS` | `readonly Area[] = { id, lon, lat, name, short?, region, side, glow }[]` | CMS content | home page item, section `wherewework` (area list) | 10 | id:text! <contract><br>name:text!<br>short:text<br>lon:number! G14<br>lat:number! G14<br>region:select <design><br>side:select <design><br>glow:number <design> |
| `OFFICE` | `{lon, lat}` | CMS global | company (global) |  | office:geo! G14 |
| `LINES` | `{office, clients, also} -> Text` | CMS content | home page item, section `wherewework` | 3 | office / clients / also:text{3} pair G5 |
| `BALI_GROUP` | `Text` | CMS content | home page item, section `wherewework` |  | baliGroup:text pair |
| `FRAMES, NARROW, MID, TIMING` | `camera boxes (lon/lat), breakpoints, seconds` | stays in git |  |  |  |
| `Region, Box` | `types` | stays in git |  |  |  |

- **AREAS**: In the content's order: 8 Bali areas, Jakarta, Lombok & the Gili Islands. Names only, never offices. The page plan (D1) says there is one office and no location pages, but the home section still names these areas as client areas.
  - `id` example: canggu
  - `name` example: Uluwatu & the Bukit
  - `short` example: Uluwatu
- **OFFICE**: Ubud, the one office. Duplicates AREAS[0] and (rounded differently) the contact map.
  - `office` example: {lon:115.2625, lat:-8.5069}
- **LINES**: composed from the content's own words
  - `office / clients / also` example: {en:"One office, in Ubud, Bali.",id:"Satu kantor, di Ubud, Bali."}
  - `baliGroup` example: {en:"Bali",id:"Bali"}
- **FRAMES, NARROW, MID, TIMING**: TIMING.STACK_H etc.

### `home/where-we-work-static.ts` (80 lines, stays in git, 1 consumer file)

GENERATED at build from data/geo/indonesia-topo.json: the static SVG map (Java, Bali, Lombok) for no-JS and no-WebGL. Never edited.

Consumed by: `components/home/HomeWhereWeWork.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `STATIC_MAP` | `{ vw, vh, d, office, dots, jakarta, lombok }` | stays in git |  |  |  |

- **STATIC_MAP**: derived from AREAS/OFFICE and the TopoJSON; stays generated

### `home/who-we-work-with.ts` (120 lines, ERP-fed later, 1 consumer file)

Home "Who we work with": the logo marquee data (11 clients/projects) and UI strings; plus pure layout maths.

Consumed by: `components/home/HomeWhoWeWorkWith.astro`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `CLIENTS` | `Client[] = { name, file, alt, ink? }[]` | ERP-fed later | client-logo (collection) with media; later fed by the ERP clients module | 11 | name:text!<br>file:media!<br>alt:text!<br>ink:number <design> |
| `CLIENT_DIR` | `'/brand/clients/'` | stays in git |  |  |  |
| `STRINGS` | `{clients, list} -> Bilingual` | CMS content | home page item, section `whowework` | 2 | clients / list:text{2} pair G5 |
| `rowCount, sizeOf, planMarquee, industrySlug, Sized, Row, GAP_UNITS` | `layout maths` | stays in git |  |  |  |

- **CLIENTS**: CMS_PLAN lists client logos as ERP-fed. One entry is an unidentified emblem with alt "" (decorative until named). `ink` is a MEASURED optical-weight number (0..1) used only for sizing. Adding a logo is "data only" by design.
  - `name` example: BIMC Hospital
  - `file` example: skills.webp (public/brand/clients/*.webp (11 files, 302,330 bytes))
  - `alt` example: BIMC Hospital ("" means decorative; the media primitive's `alt` is optional, so "" vs absent is not distinguishable)
- **STRINGS**: assistive-tech labels
  - `clients / list` example: {en:"Clients and projects",id:"Klien dan proyek"}

### `home/why-gaia.ts` (66 lines, CMS content, 3 consumer files)

Home "Why Gaia": the visible heading and the drawings' labels. The four reasons themselves are the ### blocks of the content file.

Consumed by: `components/home/HomeWhyGaia.astro`, `components/home/WhyGaiaArt.astro`, `scripts/home/sections/why-gaia.ts`.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `HEADING` | `Bi` | CMS content | home page item, section `whyus` |  | heading:text! pair G5 |
| `NAV` | `{label, of, reason} -> Bi` | CMS content | ui-strings (global) | 3 | label / of / reason:text{3} pair G5 |
| `ART` | `{season, search, bilingual, pricing} with labels and a pastel key each` | CMS content | home page item, section `whyus` | 4 | labels:text{6} pair G1,G5<br>pricing.factors:text[3] pair G2,G5<br>pastel:relation <design> G9 |
| `ART_ORDER, ArtKind, OUT_S` | `order and timing` | stays in git |  |  |  |

- **HEADING**: REPLACES the content H2 ("Why we're the digital marketing agency in Bali built for hospitality") on user ruling 2026-10-07; broadened 2026-10-09
  - `heading` example: {en:"Bali’s agency built for growth",id:"Agensi Bali yang dibangun untuk pertumbuhan"}
  - `label / of / reason` example: {en:"Reason",id:"Alasan"}
- **ART**: Labels only: "the drawings carry no figures". pricing.factors is a list of 3 Bi pairs (Property size / Locations / Ad spend). season.months is the string "JFMAMJJASOND".
  - `labels` example: season.high = {en:'High season', id:'Musim tinggi'}, search.answer = {en:'AI answer', id:'Jawaban AI'}
  - `pricing.factors` example: [{en:'Property size',id:'Ukuran properti'}, ...]
  - `pastel` example: web-design

### `company/about.ts` (134 lines, CMS content, 7 consumer files)

About page scene labels, bilingual. Serves company.about sections hero, facts, services, industries, why, cycle, where.

Consumed by: `components/company/about/AboutCycle.astro`, `components/company/about/AboutFacts.astro`, `components/company/about/AboutHero.astro`, `components/company/about/AboutIndustries.astro`, `components/company/about/AboutServices.astro`, `components/company/about/AboutWhere.astro` and 1 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `ROOT_ORDER` | `{ left:[4 keys]; centre:[1]; right:[4] }` | stays in git |  | 9 |  |
| `HERO` | `{ rootsLabel: Bi }` | CMS content | company.about page item, section hero |  | rootsLabel:text pair G5 |
| `FACTS` | `{ line:Bi; tab:Bi; rows: Record<Locale, Fact[]> } with Fact = { icon:FactIcon; label; value; address?:boolean }` | CMS content | company.about page item, section facts | 10 | line:text pair G5<br>tab:text pair G5<br>rows:text![5 en / 5 id] record G3,G5 {icon:select!, label:text!, value:text!, address:select} |
| `SERVICES_SCENE / INDUSTRIES_SCENE` | `{ line: Bi }` | CMS content | company.about page item | 2 | line:text pair G5 |
| `WHY` | `{ line:Bi; rings: Record<Locale,string[]> }` | CMS content | company.about page item, section why | 2 | line:text pair G5<br>rings:text![4 per locale] record G2,G5 |
| `CYCLE` | `{ line:Bi; back:Bi }` | CMS content | company.about page item, section cycle | 2 | line / back:text{2} pair G5 |
| `WHERE` | `{ line, pin, island, meet: Record<Locale,string[]>, contact, address }` | CMS content | company.about page item, section where | 6 | line / pin / island / contact / address:text{5} pair G5<br>meet:text[2 per locale] record G2,G5 |
| `Bi, Fact, FactIcon` | `types` | stays in git |  |  |  |

- **ROOT_ORDER**: where the nine service chips sit round the trunk
  - `rootsLabel` example: {en:"Our nine services",id:"Sembilan layanan kami"}
- **FACTS**: EN 5 rows (studio, core services, industries served, languages, reply time); ID 5 rows but a different set (adds "Wilayah layanan / Seluruh Bali", drops industries). "Nine" appears as a literal value.
  - `line` example: {en:"Based in Ubud, nine services, nine industries",id:"Berbasis di Ubud, sembilan layanan inti"}
  - `tab` example: {en:"Company file",id:"Berkas perusahaan"}
  - `rows` example: {icon:'pin', label:'The studio', value:'Mas, Ubud, Bali', address:true}
  - `line` example: {en:"Nine services, one outcome: found and booked",id:"Sembilan layanan, berdiri sendiri atau digabung"}
- **WHY**: The EN and ID ring labels name DIFFERENT parts (EN: Ubud, Credentials, The team, Bali businesses; ID: Satu masalah, Pasar Bali, Google dan AI, Dwibahasa) because the two pages' "why" sections have different structures.
  - `line` example: {en:"Started in Ubud, still in Ubud",id:"Dibangun dari pasar Bali"}
  - `rings` example: ['Ubud, Bali','Credentials','The team','Bali businesses']
  - `line / back` example: {en:"Back to strategy, every quarter",id:"Kembali ke strategi, setiap bulan"} (EN says quarterly, ID says monthly: the two pages disagree and the label restates each)
  - `line / pin / island / contact / address` example: {en:"One office, in Mas, Ubud",id:"Satu kantor, di Mas, Ubud"}
  - `meet` example: en ['In Ubud','Over video call'] / id ['Di area Ubud','Panggilan video']
- Note: Every string is a label printed on a drawing; each carries a code comment quoting the sentence of the page copy it restates ("Labels restate the page's own copy", docs/COMPANY_PAGES.md). Nothing here adds a fact.

### `company/careers.ts` (142 lines, CMS content, 7 consumer files)

Careers page labels. ENGLISH ONLY: the careers page has no Indonesian twin. Open roles: none are listed ("Roles are listed here when they open").

Consumed by: `components/company/careers/CarHero.astro`, `components/company/careers/CarHow.astro`, `components/company/careers/CarLife.astro`, `components/company/careers/CarOpen.astro`, `components/company/careers/CarWho.astro`, `components/company/careers/CarWhy.astro` and 1 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `DISCIPLINES` | `{ key, label }[] as const` | CMS content | derived from services (8 of the 9: no AI Search) | 8 | key:relation! G9<br>label:text! EN |
| `ROLES` | `{ title; keys: DisciplineKey[]; note? }[]` | CMS content | company.careers page item, section who | 5 | title:text! EN<br>keys:relation[] G2,G9<br>note:text EN |
| `HERO / WHO / OPEN` | `objects of 6 / 2 / 8 strings` | CMS content | company.careers page item | 16 | strings:text{16} EN G1 |
| `LIFE` | `object, 14 top-level keys` | CMS content | company.careers page item, section life |  | podLine / podRoles / lead / client / yearLine / high / highMonths / highDoes / low / lowDoes / illustrative:text{11} EN G1,G2<br>highIdx:number[4] G2 |
| `HOW` | `{ cv, call, task, team, offer, illustrative }` | CMS content | company.careers page item, section how | 5 | steps:text{5} EN G1,G2 |
| `WHY` | `{ line, live, ai, base }` | CMS content | company.careers page item, section why | 4 | cards:text{4} EN G1,G2 |
| `mailtoFor / DisciplineKey` | `function, type` | stays in git |  |  |  |

- **DISCIPLINES**: a THIRD list of the disciplines (team.ts has a 9-item version with `short`)
  - `key` example: paid-media
  - `label` example: Web Design & Development
- **ROLES**: "Roles we hire for"; each marks which disciplines it draws on; "Account leads" stands outside the eight
  - `title` example: SEO specialists
  - `keys` example: ['content-creation','social-media','pr-digital-pr']
  - `note` example: One point of contact
- **HERO / WHO / OPEN**: OPEN.email = site.email; OPEN.subjectBase builds the mailto subject; no role is "open" today
  - `strings` example: HERO.register = 'Register interest'; OPEN.line = 'No role matching your background? Register your interest.'
- **LIFE**: includes months initials (12), month names (12) and highIdx [0,6,7,11] = which months are high season, written as indices; plus high/low season months text "July-August, December-January"
  - `podLine / podRoles / lead / client / yearLine / high / highMonths / highDoes / low / lowDoes / illustrative` example: podRoles:['Strategist','Specialist','Creative']
  - `highIdx` example: [0,6,7,11] (month indices; the same high season ("July-August, December-January") is also stated in text, in why-gaia ART, process.ts and pricing)
- **HOW**: each hiring step as an artefact; nested objects with lists (task.items 2, offer.rows 3)
  - `steps` example: task: { title:'Skills task', paid:'Paid', items:['Mini technical SEO audit','Content sample for a Bali brand'] }
  - `cards` example: ai: { chips:['Google AI Overviews','ChatGPT','Perplexity'], query:'Where is search going?' }
- Note: Every string is a label printed on a drawing; each carries a code comment quoting the sentence of the page copy it restates ("Labels restate the page's own copy", docs/COMPANY_PAGES.md). Nothing here adds a fact.
- Note: Job openings are ERP-fed later (CMS_PLAN: HR, with JobPosting schema). The OPEN block is the "register interest" fallback, which stays CMS copy.

### `company/contact.ts` (269 lines, CMS content, 7 consumer files)

Contact page labels, EN and ID, as two full ContactCopy objects.

Consumed by: `components/company/contact/AfterScene.astro`, `components/company/contact/ContactHero.astro`, `components/company/contact/FormScene.astro`, `components/company/contact/VisitScene.astro`, `components/company/contact/WhatsAppScene.astro`, `components/company/contact/data.ts` and 1 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `contactCopy` | `(locale) => ContactCopy = { hero:HeroWords; wa:WhatsAppWords; form:FormWords; after:AfterWords; visit:VisitWords; maps:string }` | CMS content | company.contact page item (one per locale) | 2 | hero:text!{15} record G1<br>wa:text!{9} record G1 {chips:text}<br>form:text!{4} record G1<br>after:text!{13} record G1<br>visit:text!{9} record G1<br>maps:text! G9 |
| `HeroWords, WhatsAppChip, WhatsAppWords, FormWords, AfterWords, VisitWords, ContactCopy` | `interfaces` | stays in git |  |  |  |

- **contactCopy**: About 49 strings per locale in 5 groups (hero 15, wa 8 plus the chips list, form 4, after 13, visit 9) + the Google Maps URL. Indonesian has 4 WhatsApp chips, English 3. Empty strings in ID mean "not drawn" (form.privacy, after.forward). Opening hours are [CONFIRM] in the copy so no string mentions them.
  - `hero` example: { save:'Save contact', toast:'We reply within one business day.', vcfName:'gaia-digital-agency.vcf', ... }
  - `wa` example: { line, barWho, you, chips, empty, open, hint, chatLabel, delivered }
  - `form` example: { line, letterhead:'Gaia Digital Agency - Mas, Ubud', guide, privacy }
- Note: Every string is a label printed on a drawing; each carries a code comment quoting the sentence of the page copy it restates ("Labels restate the page's own copy", docs/COMPANY_PAGES.md). Nothing here adds a fact.
- Note: src/components/company/contact/data.ts (65 lines, outside src/config) builds the vCard and the WhatsApp message from site facts + these strings.

### `company/process.ts` (499 lines, CMS content, 8 consumer files)

Our Process page labels, EN and ID. The two locales describe DIFFERENT processes: EN has ten steps, ID has five stages.

Consumed by: `components/company/process/ProcessArtefact.astro`, `components/company/process/ProcessCloseArt.astro`, `components/company/process/ProcessHero.astro`, `components/company/process/ProcessPrice.astro`, `components/company/process/ProcessSteps.astro`, `components/company/process/ProcessTimeline.astro` and 2 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `PROCESS` | `Record<Locale, ProcessCopy>` | CMS content | company.process page item (one per locale) | 2 | chipGet / chipWhen / chipNeed / illustrative / stepsLine / stepsRailLabel / whyLine / closeStep:text{8} record<br>hero:text! record G1,G3 {etaWeeks:text}<br>steps:text![10 en / 5 id] record G3,G5 {kind:select!, short:text!, get:text!, when:text!, need:text}<br>art:text!{11} record G1,G2,G3<br>why:text!{18} record G1,G2<br>timeline:text ID G1,G3 {rows:text}<br>price:text ID G1,G10<br>stepOf:text record <behaviour> G13 |
| `ArtKind, StepSpec, ProcessCopy, ArtLabels, WhyLabels, TimelineLabels, PriceLabels` | `types` | stays in git |  |  |  |

- **PROCESS**: EN: 10 StepSpec (audit, research, roadmap, proposal, kickoff, production, launch, optimise, report, refresh). ID: 5 StepSpec (audit, roadmap, launch, optimise, report) plus two ID-ONLY scenes: `timeline` (4 rows) and `price` (a hard-coded "IDR 19 juta hingga IDR 45 juta per bulan"). `art.*` holds ~10 artefact label groups, filled with "" / [] in the locale that lacks the scene. `stepOf` is a FUNCTION (n,total) => string.
  - `chipGet / chipWhen / chipNeed / illustrative / stepsLine / stepsRailLabel / whyLine / closeStep` example: chipGet: 'You get' / 'Anda dapat'
  - `hero` example: { etaLabel, etaValue:'within four weeks of signing', etaWeeks:[{label:'Week 1', w:1}, ...], free, marker, railLabel }
  - `steps` example: { kind:'audit', short:'Audit', get:'A prioritised PDF', when:'3-5 business days', need:'Admin access to your profile, analytics, ad accounts and CMS' }
- Note: Every string is a label printed on a drawing; each carries a code comment quoting the sentence of the page copy it restates ("Labels restate the page's own copy", docs/COMPANY_PAGES.md). Nothing here adds a fact.

### `company/team.ts` (180 lines, CMS content, 10 consumer files)

Team page labels and the people-to-look mapping. ENGLISH ONLY. People come from data/site.json (`site.people`), which CMS_PLAN marks ERP-fed (HR).

Consumed by: `components/company/team/TeamAccount.astro`, `components/company/team/TeamBadge.astro`, `components/company/team/TeamHero.astro`, `components/company/team/TeamIndustries.astro`, `components/company/team/TeamNumbers.astro`, `components/company/team/TeamProcess.astro` and 4 more.

| Export | TS type | Class | Target | Items | Fields |
|---|---|---|---|---|---|
| `teamPeople (derived)` | `(people = site.people) => TeamPerson[]` | ERP-fed later | team-member (collection, ERP-fed) | 7 | name:text! <erp><br>role:text! <erp><br>look:text <design> G1 |
| `LOOKS (not exported)` | `{ match: RegExp; look: PersonLook }[]` | stays in git |  | 7 |  |
| `DISCIPLINES` | `{ key, label, short }[]` | CMS content | derived from services | 9 | key:relation! G9<br>label:text! EN<br>short:text! EN |
| `LINES` | `7 big-line strings` | CMS content | company.team page item | 7 | numbers / meet / what / who / why / how / where:text{7} EN |
| `UI` | `object, 16 top-level keys` | CMS content | company.team page item |  | labels:text{16} EN G1,G2,G3 |
| `STAMPS` | `{ match: RegExp; mark }[]` | stays in git |  | 4 |  |
| `initialsOf / PersonLook / TeamPerson` | `function, types` | stays in git |  |  |  |

- **teamPeople (derived)**: Computed per person: title and scope parsed from "Role (scope)", monogram initials (honorific stripped), head = no seat. "Nobody is called a founder (site.json: the founder is unconfirmed), and no email shows." Eight leads in the content package have no names and stay hidden.
  - `name` example: Lord Fakhri Andi
  - `role` example: Web Development Maintenance Manager
  - `look` example: { seats:['seo'], fill:'176,202,250', accent:'18,70,199' } (chosen by REGEX on the role text (LOOKS); a new role gets a grey default)
  - `key` example: ai-search
  - `label` example: AI Search Optimisation
  - `short` example: AI Search
  - `numbers / meet / what / who / why / how / where` example: Nine disciplines. One studio in Ubud.
- **UI**: includes lists: account.docks (3 {key,name}), industries (4 {slug,name}), otherIndustries (5 slugs), facts (3 {kind,big,label}), languages (2)
  - `labels` example: facts: [{kind:'disciplines', big:'9', label:'disciplines'}, {kind:'studio', big:'1', label:'studio, in Ubud'}, {kind:'languages', big:'2', label:'languages'}] (hard-coded counts 9/1/2)
- **STAMPS**: picks a stamp glyph from the heading text by regex
- Note: Every string is a label printed on a drawing; each carries a code comment quoting the sentence of the page copy it restates ("Labels restate the page's own copy", docs/COMPANY_PAGES.md). Nothing here adds a fact.

## 8. Gaps against the vocabulary (the main output)

The vocabulary today: 8 primitives (`text`, `richtext`, `media`, `relation`, `number`, `date`, `select`, `geo`), `FieldDef = { name, primitive, required?, options?, relationTo?, multiple? }`, `CollectionComposition = { fields?, blocks? }`, 9 flat block types, item = `{ collection, slug, locale, localizations[], seo, meta, blocks[] }`. Nothing below proposes a fix.

### G1. Nested objects (a group of named fields inside one field)

- **Vocabulary today:** FieldDef is flat: name + one primitive (+ required, options, relationTo, multiple). No object/group primitive. Block props are a flat map of primitives.
- **Cannot be expressed:** Any field whose value is a record with its own typed members.
- **Evidence:**
  - site.address = { street, locality, region, country, full } (data/site.json)
  - PROOF_METRICS[i].label = { en, id }; footerClock = { label:{en,id}, zone:{en,id} }
  - contactCopy(locale) = { hero{15}, wa{8 + chips}, form{4}, after{13}, visit{9}, maps } (config/company/contact.ts)
  - PROCESS[locale].art = 11 artefact label groups, each a different object shape (config/company/process.ts)
  - WORLDS[key].day = Rig with 16 numeric fields (design, stays in git)
- **How much:** 10 of 33 modules have a field with a nested object (23 fields in this inventory)

### G2. Lists of scalars

- **Vocabulary today:** `multiple` is honoured only for `relation` and `media` (primitives.ts validateOne). A `text`, `number`, `select` or `date` field with multiple:true is not validated as an array: validateField would reject an array as "expected a string".
- **Cannot be expressed:** An ordered list of strings, numbers, URLs or select values.
- **Evidence:**
  - site.sameAs (4 URLs), site.areaServed, site.languages, site.priceCurrency (data/site.json)
  - COVER_SUBJECTS (10 words), SERVICE_COVERS (9 lists, 34 chips), GREET (4), LIFE.months/monthNames (12 each), HWW bullets (5 stages x 3 per locale)
  - CHOOSE_ROUTES[i].first / .then = service keys as string lists
  - front matter: schema[] and image_alt_texts[] on 315 pages (741 alt entries)
  - PRICING_COPY.cover = [string, string]; outcomes = [string,string,string] (fixed-length tuples)
- **How much:** 30 list-of-scalar fields recorded in this inventory (13 modules) plus 2 front-matter lists

### G3. Lists of objects (repeating groups whose members have typed fields, order and identity)

- **Vocabulary today:** Only workaround in the vocabulary: `relation` arrays to another collection (featureGrid.items -> `feature`, faq.items -> `faqItem`), which are conceptual and not defined as collections. A relation value is {collection, slug}, so each member must be a published content_items row with its own slug.
- **Cannot be expressed:** An inline array of records, e.g. [{ q, a }].
- **Evidence:**
  - FAQ items {question, answer}: 6 on the home page per locale; 844 EN + 352 ID across 272 pages (### under the FAQ ##)
  - site.people[7] = {name, role, email?}; CLIENTS[11] = {name, file, alt, ink?}; CASES[3]; AREAS[10] = {id, lon, lat, name, short?, ...}
  - PROCESS.en.steps[10] = {kind, short, get, when, need?}; PROCESS.id.timeline.rows[4]; hero.etaWeeks[4] = {label, w}
  - FACTS.rows[5] per locale = {icon, label, value, address?}; footer links [7] = {label:{en,id}, path}
  - data/navigation.json primary[6] = {label, label_id, hub, hub_id, url, children[]}: a list of objects containing a list
  - a list of stats (value + label): PROOF_METRICS[4] (label per locale, value in another export), team.ts UI.facts [{kind, big, label}] = 9 disciplines / 1 studio / 2 languages
- **How much:** 14 list-of-object fields recorded in this inventory (9 modules), plus FAQ lists in 272 pages and 241 tables

### G4. Booleans

- **Vocabulary today:** No boolean primitive. redirects.ts models `active` as a closed select with options ["true","false"] and compares strings.
- **Cannot be expressed:** true/false flags.
- **Evidence:**
  - front matter publish_ready (false on all 315)
  - ProofMetric.stars, ProofPiece.tally / .badge, Fact.address, FloaterSpec/World.dark, onboarding field .required/.allowOther
  - env flags previewHeld, chatEnabled, web3formsCaptcha (these stay in git)
- **How much:** a handful of content-side flags; more on the design side

### G5. Locale-aware values and per-locale structure

- **Vocabulary today:** The locale axis belongs to the ITEM (content_items.locale, localization_group_id). A FieldDef cannot say "this field is per locale". `localeFallbackFlag` gives item-level fallback only.
- **Cannot be expressed:** Three bilingual conventions exist side by side, none expressible as a field: (a) paired objects {en, id} per string; (b) Record<Locale, X> where the X differ in shape per locale; (c) flat columns label / label_id. Also: "empty string = not drawn in this locale"; English-only modules that have no Indonesian twin.
- **Evidence:**
  - (a) 222 `en:` keys across 16 of the 33 config modules (type declarations included): footerTitles, footerFacts, NAMES, SHORT_NAMES, OUTCOMES, HUB_UI, ctaButton, STRINGS ... (type names Bi, Bilingual, L10n, Localised, Text are five declarations of the same thing)
  - (b) PROCESS: EN 10 steps vs ID 5 stages + ID-only timeline and price scenes; PROOF_TOKENS: EN 6 runs vs ID 3 whole sentences; HWW bullets: EN starts at "Free audit", ID at "Konsultasi gratis"; FACTS.rows differ in membership; WHY.rings name different parts
  - (c) data/navigation.json label / label_id / hub / hub_id
  - English-only: careers.ts, team.ts, SERVICE_COVERS, CHOOSE_ROUTES, WINDOWS_EN, boilerplate_short
  - Placeholders in strings: {n}, {total}, {t}, {time}, {context}, {name} (no placeholder vocabulary)
  - Locale codes: front matter en-GB / id, code en / id; WebDesk examples use en-US, id-ID; site.json defaultLocale "en" vs 0002_content.sql comment "id-ID is the tenant DEFAULT locale per section 05".
- **How much:** copy fields recorded in this inventory by locale shape: {"neutral":83,"en-only":26,"id-only":7,"en+id pair":49,"per-locale record":15}

### G6. Item ordering

- **Vocabulary today:** No position/sort field on collection items. The only list endpoint order in the API is `ORDER BY updated_at DESC` (api/src/content/content.service.ts). Array position is order only inside one block prop.
- **Cannot be expressed:** Editor-controlled order of items in a collection or relation list.
- **Evidence:**
  - SERVICES order = paint order = overlap order on the home hero; the nine are listed in the design's own order, not alphabetical
  - footer links (7+4+2), nav children (23 URLs), FEATURED_URLS (lead story then 02-04), COVER_SUBJECTS (rotation order ending on "businesses"), CLIENTS (reading order within a row), HWW stages, process steps, FAQ questions
  - data/navigation.json children are listed alphabetically by URL, but the rendered menu order is resolved in lib/navigation.
- **How much:** every list above

### G7. Visibility and lifecycle states (page, section, item)

- **Vocabulary today:** content_items.publish_state in {draft, scheduled, published, unpublished} + publish_at/unpublish_at; envelope meta.draft. Nothing finer.
- **Cannot be expressed:** shown / SEO-only / held / hidden (CMS_PLAN). Today visibility is spread over FOUR mechanisms: (1) page-plan action SHOW/KEEP/HOLD/LATER/MERGE/CUT + `to`; (2) front-matter publish_ready (false on all 315) + the token gate; (3) VISITOR_HIDDEN in lib/manifest/plan.ts (the glossary: built, in sitemap and llms.txt, linked from nowhere); (4) lib/content/curate.ts hides unverified lines/sections at render. MERGE and CUT are routing decisions (redirect or unlink), not visibility.
- **Evidence:**
  - page-plan.json: SHOW 60, KEEP 19, LATER 31 (P2/P3 schedule), HOLD 47 (waiting on client data), MERGE 116 (+ target), CUT 42
  - /glossary/ is SHOW but visitor-hidden; its 40 term pages are MERGE with anchors
  - Section visibility has no home: curate.ts empties Results and Featured case studies on the home page (the design still draws the latter)
  - env.previewHeld builds HOLD+LATER for review
- **How much:** 315 pages with one of 6 actions; sections need their own flag

### G8. Rich text that is really Markdown with section structure

- **Vocabulary today:** richtext accepts a Lexical-shaped {root} document OR "a plain string fallback"; nothing says the string is Markdown. blocks.richText has a single `content` prop.
- **Cannot be expressed:** GFM tables with captions, ### sub-sections, bold lead-ins, numbered/linked lists, `{#anchor}` heading ids, links, a few HTML fragments; and the ## section boundaries that drive component choice.
- **Evidence:**
  - 315 bodies; 2,690 ## sections / 1,661 distinct headings; 2,340 ### blocks
  - 241 tables (1,455 rows) in 174 pages; 2 "*Table caption: ...*" lines the template converts to <caption>
  - 5,936 markdown links, 5,740 of them internal paths; 12 `## Heading {#anchor}` explicit anchors; 30 pages with embedded HTML
  - Sections are split at build by splitBody() on "## " and classified by heading regex (lib/sections/rules.ts: 10 kinds, EN + ID patterns) and body shape (lib/sections/shape.ts). A single richtext field would erase the section list that the templates need.
  - The home page ALSO takes its h1, answer paragraph, CTA line, proof paragraph, nine service links, nine industry links and FAQ from the Markdown, while config supplies the rest of the same section.
- **How much:** 315 pages

### G9. References between pages, sections and keys

- **Vocabulary today:** relation = { collection, slug }: one target collection per field (relationTo), no locale, no hash/anchor, no polymorphism.
- **Cannot be expressed:** Typed links to any page (any collection), to a page + #section, locale-aware; and references by KEY between config tables.
- **Evidence:**
  - 5,740 internal markdown links by absolute path; footer path "/#faq"; Contact "maps" URL; STRINGS.href = {en:"/case-studies/", id:"/id/case-studies/"} typed per locale
  - rewriteLinks() (lib/manifest/plan.ts) re-points a link to a MERGE target, unlinks CUT/HOLD targets and turns glossary links into /glossary/#anchor at render: link resolution is a build-time policy, not data
  - Three or four key vocabularies for the same entity: SERVICES.key "ai-search" / URL slug "ai-search-optimization"; "pr-digital-pr" / "public-relations"; INDUSTRIES.key "hotels" / INDUSTRY_KEYS "hotels-resorts" / chat INDUSTRY_WORDS key "hotels"
  - FLOATERS, SERVICE_HERO, SERVICE_COVERS, PROOF_SEATS, CHOOSE_ROUTES, TOPIC_BY_URL all key other data by service key or URL
  - Twin pointers hreflang_id / hreflang_en (68 pairs) and page-plan `to`
- **How much:** every module that mentions a service, industry or URL

### G10. Unresolved placeholders and verification state

- **Vocabulary today:** `text` validates any string, so a placeholder is valid content. No notion of "unverified".
- **Cannot be expressed:** A value that exists but must not publish. Three inline syntaxes: {{TOKEN}}, [CONFIRM: ...], [CLIENT: ...]; a registry that maps tokens to values; a publish gate; a placeholder rendered as an em dash.
- **Evidence:**
  - {{TOKEN}}: 238 distinct tokens, 3,637 occurrences in 295 pages; registry data/tokens.json has 256 tokens, 252 null
  - [CONFIRM: ...] 4,450 occurrences, [CLIENT: ...] 486 (content + front matter)
  - site.json founder, foundingDate, certifications, aggregateRating are [CONFIRM] strings; front matter author "[CONFIRM: author name and role]", last_updated "{{PUBLISH_DATE}}"
  - Config bypasses the gate: opening.ts ships 4.9 stars / 127 reviews / 60+ brands / since 2017 and case-studies.ts ships 64% / 87% / 46%, "as designed", while the same facts are [CONFIRM] in site.json and the content
  - process.ts (ID) hard-codes "IDR 19 juta hingga IDR 45 juta per bulan"; the ID process page spells the USD side as {{PRICE_HOTEL_LOW_USD}}
  - Token values are typed things written as strings: "7.500.000" (money with dots), percentages, dates, names
- **How much:** 8,573 placeholder occurrences in content and front matter (3,637 tokens + 4,450 [CONFIRM] + 486 [CLIENT])

### G11. Item-level typed fields and singletons (globals)

- **Vocabulary today:** CollectionComposition.fields declares fields on the COLLECTION, but content_items has no field-value column. redirects.ts parks its values inside `seo.redirect`. There is no singleton/global concept.
- **Cannot be expressed:** Typed page-level fields (h1, primary_keyword, author, last_updated, phase, schema types, navName, topic ...) and one-per-site records.
- **Evidence:**
  - every page has h1, primary_keyword, schema[], phase, author, last_updated, publish_ready (front matter) that the envelope has no typed home for except free-form `seo`
  - page h1 differs from seo.title ("SEO Agency Bali" vs "SEO Agency Bali | Gaia Digital Agency")
  - globals: company (site.json), navigation, footer, assistant, token registry are all single records, per locale or locale-neutral

### G12. URL / path

- **Vocabulary today:** A content item is addressed by (collection, locale, slug) and WebDesk's sitemap renderer emits /{collection_key}/{slug}.
- **Cannot be expressed:** The site's URL scheme is fixed by rule ("URLs are fixed", CONTENT-CLAUDE.md) and is NOT /{collection}/{slug}: nested paths, root-level slugs and an /id/ locale prefix.
- **Evidence:**
  - / and /id/ (home); /about/process/; /services/seo/local-seo/; /services/paid-media/google-ads/ (two-level slugs)
  - root-level landing pages /hotel-marketing-agency-bali/ ...; ID-only /id/jasa-seo-bali/ (the /id/ prefix is the locale)
  - /pricing/, /free-audit/, /contact/ (single segment, not under a collection)
  - The ID audit page route is /id/free-audit/ but CoreTemplate.formFor checks /id/audit-gratis/ (see surprising findings)
- **How much:** all 315 urls

### G13. Structured data packed into strings, and bindings by text pattern

- **Vocabulary today:** text and richtext only.
- **Cannot be expressed:** Data that the site extracts from text with regexes, or encodes in delimiters.
- **Evidence:**
  - Home Results bullets: "+[CONFIRM: %] direct bookings . [CLIENT: 12-villa estate, Canggu] . [CONFIRM: timeframe]" = a record {metric, client, timeframe} in one line
  - HUB_UI.months = "Jan Feb Mar ..." (space-delimited list); HUB_UI.drivers = "Property size|Number of locations|Ad spend" (pipe-delimited)
  - DRIVER_ENDS keyed by the lowercased bold lead-in of a Markdown bullet ("number of locations or listings"): reword the bullet and the dial is silently lost
  - schema_notes: a multi-line block scalar in 315 files whose inner format differs between EN (YAML-ish "Service: name: ...") and ID ("- \"Service: ...\" - ...")
  - Section roles from heading regexes in 5 company templates, lib/industries/roles.ts, lib/sections/rules.ts, STAMPS, LOOKS; "a renamed heading can lose a picture but never break the page"
  - PROCESS.stepOf is a function (n,total) => string inside a data object

### G14. Numeric tuples and coordinates

- **Vocabulary today:** The `geo` primitive is a single {lat, lng}. `number` is a single finite number.
- **Cannot be expressed:** Coordinate pairs named lon/lat, fixed-length numeric tuples.
- **Evidence:**
  - AREAS[10] and OFFICE use {lon, lat}; the geo primitive uses {lat, lng}
  - SERVICES[i].pad [block, inline], hero [x, y], proof [x, y]; PROOF_SEATS [x, y]; HWW_NODES [fx, fy] (all design, stay in git)
  - Only OFFICE and AREAS are content-side; the rest are design.

### G15. Bespoke section types vs the 9 generic blocks

- **Vocabulary today:** 9 block types (hero, richText, gallery, cta, featureGrid, form, testimonial, faq, logoCloud) with flat props; an unknown block type renders nothing and is not an error (renderer invariant).
- **Cannot be expressed:** About 101 (template, role) bindings on this site, drawn by dedicated Astro components; a section's component is chosen by position (home), heading regex (company pages), shape (pricing, standard) or fixed slot. See sectionTypes[] and blockCoverage[].
- **Evidence:**
  - Only form and logoCloud (and richText if it can hold Markdown) carry a site section close to as-is; hero and cta carry part; faq and featureGrid need collections that do not exist; gallery is unused.
  - No block type carries: proof/metrics band, what-we-do ring, who-we-work-with marquee + industry folders, why-gaia reasons with drawings, how-we-work stages, where-we-work map, pricing scenes, process steps/timeline, team roster, careers pod, contact scenes, industry numbers/playbook scenes.

### G16. Media metadata

- **Vocabulary today:** media = {url, alt?, width?, height?, mime?}; media_assets row = bucket_key, mime, size_bytes, scan_status (no alt, no dimensions).
- **Cannot be expressed:** Decorative-image convention, a display name distinct from alt, usage-specific alt, and a measured optical weight.
- **Evidence:**
  - CLIENTS[].alt "" marks a decorative mark ("Unnamed emblem": an orange carved-mask emblem whose owner is not identified)
  - CLIENTS[].ink is a measured number used only for optical sizing (derivable)
  - logoRatio() reads width/height from the WebP header at build time because the config has no dimensions
  - OG cards, diorama posters and the relief are generated artefacts, never uploaded media

### 8.1 Can the 9 generic blocks carry any section as-is?

Short answer: apart from a `form` embed and a logo cloud, no section is carried as-is; most of the 101 bindings are bespoke.

| Block | Carries | Detail |
|---|---|---|
| `hero` | PARTIAL | heading (h1), subheading (answer paragraph), ctaLabel/ctaHref (primary CTA) fit a page lead. Missing: the optional caption line under the button (home), the kicker (services), the `media` is an image/URL while service heroes are code-drawn artefacts, the WhatsApp-first locale rule (ID CTA href is built from site phone + page context, not a static href). |
| `richText` | YES, only if richtext can hold Markdown | carries the default `prose` kind (rules.ts: the special kinds cover 34% of sections, the other 66% are prose, of 2,690 ## sections) but a richText block has only `content`: no heading, anchor, role or kind, so the section boundary and the heading regex bindings are lost. |
| `gallery` | UNUSED | no section on the site is a gallery; there is no content photography. |
| `cta` | PARTIAL | heading + body + buttonLabel + buttonHref fits CtaBlock / CoClose / HomeCta text. Missing: WhatsApp prefill context, the secondary caption, and ID vs EN CTA kind; `body` is text, not richtext. |
| `featureGrid` | NOT AS-IS | items is a multiple relation to a conceptual `feature` collection {heading, body, icon} that is not defined anywhere (validateField only checks the {collection, slug} shape). Candidates: why-gaia reasons (4), pillar grids (the ### blocks, 2,340 H3), services grid (9), disciplines. Each item would need its own content_items row with its own slug. |
| `form` | YES | formKey -> form_defs: carries form.contact, form.audit, form.onboard once a `form_defs` collection exists. Field ids are a contract (CONTACT_FIELDS, AUDIT_FIELDS, onboard-questions.ts) and stay in git or move wholesale. |
| `testimonial` | YES (shape) but no data | quote richtext + author + role + avatar matches the `quote` kind / case-study client quote. Every real quote is a {{QUOTE_*}} token today (3 tokens, all null). |
| `faq` | NOT AS-IS | items is a multiple relation to a conceptual `faqItem` collection that is not defined. The site has 844 EN + 352 ID Q&A pairs (###-under-FAQ in 272 pages); as relations they would be 1,196 content_items. FAQ answers must also be reproduced verbatim in FAQPage JSON-LD and stay in the DOM. |
| `logoCloud` | YES (mostly) | logos is a multiple media array {url, alt?, width?, height?, mime?} and carries the 11 client logos. Missing: client `name` (distinct from alt), the measured `ink`, and the decorative-alt convention (alt "" vs absent). |

### 8.2 Section types (template x role), counts of bindings

| Section id | Page | Role | Component | Source | Bound by | Locale instances |
|---|---|---|---|---|---|---|
| `home.hero` | home | hero | HomeHero | md lead (h1, answer, CTA line) + config/home/opening.ts HERO_STRINGS + floaters | fixed (first) | 2 |
| `home.results` | home | results | (not rendered: curated out; figures live in Proof) | md ## Results (4 bullets: "metric . [CLIENT] . timeframe") | position 0 | 2 |
| `home.proof` | home | proof | HomeProof | md ## Proof + config/home/opening.ts PROOF_TOKENS/PROOF_METRICS | position 1 | 2 |
| `home.whatwedo` | home | whatwedo | HomeWhatWeDo | md ## What we do (9 linked services) + config/services.ts + OPENING_STRINGS | position 2 | 2 |
| `home.whowework` | home | whowework | HomeWhoWeWorkWith | md ## Who we work with (9 industries) + config/home/who-we-work-with.ts CLIENTS | position 3 | 2 |
| `home.whyus` | home | whyus | HomeWhyGaia | md ## Why ... (4 ### reasons) + config/home/why-gaia.ts | position 4 | 2 |
| `home.casestudies` | home | casestudies | HomeCaseStudies | md ## Featured case studies + config/home/case-studies.ts CASES | position 5 | 2 |
| `home.howwework` | home | howwework | HomeHowWeWork | md ## How we work (5 stages) + config/home/how-we-work.ts | position 6 | 2 |
| `home.wherewework` | home | wherewework | HomeWhereWeWork | md ## Where we work + config/home/where-we-work.ts | position 7 | 2 |
| `home.faq` | home | faq | HomeFaq | md ## FAQ (6 ### Q + answer per locale) | kind = faq | 2 |
| `home.cta` | home | cta | HomeCta | md ## Start with a free audit + config/home/cta.ts | kind = cta | 2 |
| `company.about.hero` | company.about | hero | AboutHero | md ## + config/company/about.ts | fixed | 2 |
| `company.about.facts` | company.about | facts | AboutFacts | md ## + config/company/about.ts | heading regex (AboutTemplate ROLES) | 2 |
| `company.about.services` | company.about | services | AboutServices | md ## + config/company/about.ts | heading regex (AboutTemplate ROLES) | 2 |
| `company.about.industries` | company.about | industries | AboutIndustries | md ## + config/company/about.ts | heading regex (AboutTemplate ROLES) | 2 |
| `company.about.why` | company.about | why | AboutWhy | md ## + config/company/about.ts | heading regex (AboutTemplate ROLES) | 2 |
| `company.about.cycle` | company.about | cycle | AboutCycle | md ## + config/company/about.ts | heading regex (AboutTemplate ROLES) | 2 |
| `company.about.where` | company.about | where | AboutWhere | md ## + config/company/about.ts | heading regex (AboutTemplate ROLES) | 2 |
| `company.about.cta` | company.about | cta | CoClose | md ## + config/company/about.ts | kind = cta | 2 |
| `company.process.hero` | company.process | hero | ProcessHero | md ## + config/company/process.ts | fixed | 2 |
| `company.process.steps` | company.process | steps | ProcessSteps | md ## + config/company/process.ts | heading regex (ProcessTemplate ROLES) | 2 |
| `company.process.why` | company.process | why | ProcessWhy | md ## + config/company/process.ts | heading regex (ProcessTemplate ROLES) | 2 |
| `company.process.timeline` | company.process | timeline | ProcessTimeline | md ## + config/company/process.ts | heading regex (ProcessTemplate ROLES) | 1 (ID only) |
| `company.process.price` | company.process | price | ProcessPrice | md ## + config/company/process.ts | heading regex (ProcessTemplate ROLES) | 1 (ID only) |
| `company.process.cta` | company.process | cta | CoClose | md ## + config/company/process.ts | kind = cta | 2 |
| `company.team.hero` | company.team | hero | TeamHero | md ## + config/company/team.ts + site.people | fixed | 1 (EN only) |
| `company.team.numbers` | company.team | numbers | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.meet` | company.team | meet | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.what` | company.team | what | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.who` | company.team | who | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.why` | company.team | why | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.how` | company.team | how | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.where` | company.team | where | Team* | md ## + config/company/team.ts + site.people | heading regex (TeamTemplate ROLES) | 1 (EN only) |
| `company.team.cta` | company.team | cta | CoClose | md ## + config/company/team.ts + site.people | kind = cta | 1 (EN only) |
| `company.careers.hero` | company.careers | hero | CarHero | md ## + config/company/careers.ts | fixed | 1 (EN only) |
| `company.careers.life` | company.careers | life | CarLife | md ## + config/company/careers.ts | heading regex (CareersTemplate ROLES) | 1 (EN only) |
| `company.careers.who` | company.careers | who | CarWho | md ## + config/company/careers.ts | heading regex (CareersTemplate ROLES) | 1 (EN only) |
| `company.careers.open` | company.careers | open | CarOpen | md ## + config/company/careers.ts | heading regex (CareersTemplate ROLES) | 1 (EN only) |
| `company.careers.how` | company.careers | how | CarHow | md ## + config/company/careers.ts | heading regex (CareersTemplate ROLES) | 1 (EN only) |
| `company.careers.why` | company.careers | why | CarWhy | md ## + config/company/careers.ts | heading regex (CareersTemplate ROLES) | 1 (EN only) |
| `company.careers.cta` | company.careers | cta | CoClose | md ## + config/company/careers.ts | kind = cta | 1 (EN only) |
| `company.contact.hero` | company.contact | hero | ContactHero | md ## + config/company/contact.ts | fixed | 2 |
| `company.contact.whatsapp` | company.contact | whatsapp | WhatsappScene | md ## + config/company/contact.ts | heading regex (ContactTemplate ROLES) | 2 |
| `company.contact.form` | company.contact | form | FormScene | md ## + config/company/contact.ts | heading regex (ContactTemplate ROLES) | 2 |
| `company.contact.after` | company.contact | after | AfterScene | md ## + config/company/contact.ts | heading regex (ContactTemplate ROLES) | 2 |
| `company.contact.visit` | company.contact | visit | VisitScene | md ## + config/company/contact.ts | heading regex (ContactTemplate ROLES) | 2 |
| `company.contact.cost` | company.contact | cost | CostScene | md ## + config/company/contact.ts | heading regex (ContactTemplate ROLES) | 1 (ID only) |
| `company.contact.cta` | company.contact | cta | CoClose | md ## + config/company/contact.ts | kind = cta | 2 |
| `pricing.hero` | pricing | hero | PricingHero | md lead + config/pricing.ts PRICING_COPY | fixed | 2 |
| `pricing.spend` | pricing | spend | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.rates` | pricing | rates | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.drivers` | pricing | drivers | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.services` | pricing | services | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.tiers` | pricing | tiers | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.results` | pricing | results | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.choose` | pricing | choose | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.report` | pricing | report | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.steps` | pricing | steps | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.pillars` | pricing | pillars | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.prose` | pricing | prose | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.related` | pricing | related | Pz* scene (lib/pricing/plan.ts) | md ## + config/pricing.ts | shape of the section (lib/pricing/plan.ts) | 2 |
| `pricing.close` | pricing | close | PricingClose | md cta section | kind = cta | 2 |
| `industry.hero` | industry | hero | IndHero + HeroDiorama | md lead + config/industries.ts + industry-worlds.ts | fixed | 18 |
| `industry.numbers` | industry | numbers | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.different` | industry | different | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.services` | industry | services | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.results` | industry | results | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.playbook` | industry | playbook | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.pricing` | industry | pricing | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.where` | industry | where | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.why` | industry | why | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.index` | industry | index | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.cta` | industry | cta | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.faq` | industry | faq | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.related` | industry | related | Ind* | md ## (+ lib/industries/figures.ts, facts.ts, tables.ts derive from the markdown) | heading regex + shape (lib/industries/roles.ts roleOf) | 18 |
| `industry.signature` | industry | signature | signature/{Hotels,Villas,Restaurants,Wellness,BeachClubs} | component code with inline {en,id} strings | per-industry component | 10 (5 of 9 industries have one) |
| `industries-hub.hero` | industries hub | hero | HubHero | md + config/industries-hub.ts | fixed | 2 |
| `industries-hub.index` | industries hub | index | HubIndex | md + config/industries-hub.ts | fixed | 2 |
| `industries-hub.reason` | industries hub | reason | HubReason | md + config/industries-hub.ts | fixed | 2 |
| `services-hub.switchboard` | services hub | switchboard | Switchboard / MhHub | md + config/services.ts + service-hero.ts HUB_HERO | fixed | 2 |
| `service.media-hero` | service pages | hero | MediaHero (10 mediums: serp, chat, feed, canvas, guide, print, finder, post, release, hub) | md lead + config/service-hero.ts + components/media-hero/mh-content.ts | by service key | 22 |
| `standard.kind.faq` | standard template (services, blog, guides, free-audit, glossary ...) | faq | FaqBlock | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.takeaways` | standard template (services, blog, guides, free-audit, glossary ...) | takeaways | Takeaways | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.toc` | standard template (services, blog, guides, free-audit, glossary ...) | toc | TableOfContents | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.related` | standard template (services, blog, guides, free-audit, glossary ...) | related | RelatedLinks | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.results` | standard template (services, blog, guides, free-audit, glossary ...) | results | ResultsStrip | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.pricing` | standard template (services, blog, guides, free-audit, glossary ...) | pricing | PricingBlock | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.summary` | standard template (services, blog, guides, free-audit, glossary ...) | summary | SummaryBox | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.quote` | standard template (services, blog, guides, free-audit, glossary ...) | quote | QuoteBlock | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.sources` | standard template (services, blog, guides, free-audit, glossary ...) | sources | SourcesList | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.cta` | standard template (services, blog, guides, free-audit, glossary ...) | cta | CtaBlock | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.kind.prose` | standard template (services, blog, guides, free-audit, glossary ...) | prose | ProseSection | md ## | heading regex (lib/sections/rules.ts, EN+ID patterns) | many |
| `standard.shape.subsections` | standard template | subsections | PillarGrid | md ## body shape | body shape (lib/sections/shape.ts) | many |
| `standard.shape.steps` | standard template | steps | ProcessSteps | md ## body shape | body shape (lib/sections/shape.ts) | many |
| `standard.shape.teasers` | standard template | teasers | TeaserCards | md ## body shape | body shape (lib/sections/shape.ts) | many |
| `standard.shape.linked-list` | standard template | linked-list | LinkCards | md ## body shape | body shape (lib/sections/shape.ts) | many |
| `standard.shape.places` | standard template | places | AreasServed (disconnected) | md ## body shape | body shape (lib/sections/shape.ts) | many |
| `standard.shape.chapters` | standard template | chapters | ProseSection (indexed) | md ## body shape | body shape (lib/sections/shape.ts) | many |
| `blog.cover` | blog hub | cover | MagCover | config/blog.ts + post front matter | fixed | 1 |
| `blog.archive` | blog hub | archive | PostCard grid | config/blog.ts + post front matter | fixed | 1 |
| `blog.topic-filter` | blog hub | topic-filter | blog-archive.ts | config/blog.ts + post front matter | fixed | 1 |

## 9. Stable ids

The ids are a contract that analytics, search and leads key on. What the site already sends: `section_view` carries `section_id` = the DOM `id` of the `[data-layer]` / `section[id]` element, `section_name` = its heading text or `data-deck-label`, `section_index`, `section_step`; `cta_click` carries `link_location` (the enclosing section's DOM id, or `header` / `footer`), `link_text` (free text, max 100 chars) and `link_url`; form events carry `form_id` = the `<form id>`; every event carries `content_group` (manifest `section`), `page_template` and `page_locale`. The deck reports `html[data-deck-at="faq:2"]` (`<section id>:<step>`).

| Rule | Proposal |
|---|---|
| scheme | <kind>.<last-path-segment>, unique per kind; the home page is `home`; company pages are company.about\|process\|team\|careers\|contact; pricing and free-audit are top-level; hubs are hub.<slug>; blog posts are post.<slug> |
| separators | dots only (matches the brief's home.opening / company.about / form.contact examples) |
| twins | an EN page and its ID twin share one id (= localization_group_id); the 12 ID-only pages get their own id |
| sections | <page-id>.<role>, where role is the leaf the site already uses as its DOM id where one exists (home: hero, proof, whatwedo, whowework, whyus, casestudies, howwework, wherewework, faq, cta), else the template role name |
| trackingContinuity | The tracker sends section_id = the section element's DOM id (not the CMS id) and has no page id parameter beyond content_group/page_template/page_locale; GA4 joins on (page_path, section_id). To keep history, the leaf of a proposed section id equals today's DOM id. |
| instability | For every markdown-driven section the DOM id is slugify(heading) (src/lib/sections/split.ts), which differs per locale (where-we-work vs di-mana-kantor-kami) and changes when a writer edits a heading. Only `hero`, `form`, `faq` and the home ids are literal. The site already supports an authored `## Heading {#anchor}` override (12 uses), which an importer could use to pin a stable DOM id. |

### 9.1 Home page (the sections that already have literal DOM ids)

| Proposed id | Current DOM id (= tracking `section_id`) | Source |
|---|---|---|
| `home.hero` | `hero` | section#hero |
| `home.results` | (none) | (not rendered; authored ## Results) |
| `home.proof` | `proof` | section#proof |
| `home.whatwedo` | `whatwedo` | section#whatwedo |
| `home.whowework` | `whowework` | section#whowework |
| `home.whyus` | `whyus` | section#whyus |
| `home.casestudies` | `casestudies` | section#casestudies |
| `home.howwework` | `howwework` | section#howwework |
| `home.wherewework` | `wherewework` | section#wherewework |
| `home.faq` | `faq` | section#faq |
| `home.cta` | `cta` | section#cta |

The brief's example `home.opening` has no DOM counterpart: `config/home/opening.ts` serves three sections (`home.hero`, `home.proof`, `home.whatwedo`). Chrome ids: `header` and `footer` (`#sitefoot`) are what `sectionOf()` reports for header/footer clicks.

### 9.2 Company pages: today's heading-derived DOM ids vs proposed ids

The current DOM id is `slugify(heading)`, so it is different per locale and changes when the heading is edited. `hero`, `form` (Contact form scene) and `faq` are literal.

| Page | Locale | Heading (as written) | Current DOM id | Role | Proposed id |
|---|---|---|---|---|---|
| company.about | en | Gaia Digital Agency by the numbers | `gaia-digital-agency-by-the-numbers` | facts | `company.about.facts` |
| company.about | en | Proof, in brief | `proof-in-brief` | facts | `company.about.facts` |
| company.about | en | What do we do? | `what-do-we-do` | services | `company.about.services` |
| company.about | en | Who do we work with? | `who-do-we-work-with` | industries | `company.about.industries` |
| company.about | en | Why Gaia Digital Agency | `why-gaia-digital-agency` | why | `company.about.why` |
| company.about | en | Featured case studies | `featured-case-studies` | (unmatched) | (needs an id) |
| company.about | en | How do we work? | `how-do-we-work` | cycle | `company.about.cycle` |
| company.about | en | Where we work | `where-we-work` | where | `company.about.where` |
| company.about | en | Frequently asked questions | `frequently-asked-questions` | faq | `company.about.faq` |
| company.about | en | Ready to see what Gaia Digital Agency can do for you? | `ready-to-see-what-gaia-digital-agency-can-do-for-you` | cta | `company.about.cta` |
| company.about | id | Apa yang perlu Anda ketahui tentang Gaia Digital Agency? | `apa-yang-perlu-anda-ketahui-tentang-gaia-digital-agency` | facts | `company.about.facts` |
| company.about | id | Apa hasil klien kami? | `apa-hasil-klien-kami` | (unmatched) | (needs an id) |
| company.about | id | Apa yang kami kerjakan? | `apa-yang-kami-kerjakan` | services | `company.about.services` |
| company.about | id | Siapa yang kami layani? | `siapa-yang-kami-layani` | industries | `company.about.industries` |
| company.about | id | Mengapa bisnis di Bali memilih Gaia Digital Agency? | `mengapa-bisnis-di-bali-memilih-gaia-digital-agency` | why | `company.about.why` |
| company.about | id | Bagaimana cara kami bekerja? | `bagaimana-cara-kami-bekerja` | cycle | `company.about.cycle` |
| company.about | id | Di mana kantor kami? | `di-mana-kantor-kami` | where | `company.about.where` |
| company.about | id | Berapa biaya bekerja dengan kami? | `berapa-biaya-bekerja-dengan-kami` | (unmatched) | (needs an id) |
| company.about | id | Siap membahas kebutuhan bisnis Anda? | `siap-membahas-kebutuhan-bisnis-anda` | cta | `company.about.cta` |
| company.about | id | Pertanyaan yang sering diajukan | `pertanyaan-yang-sering-diajukan` | faq | `company.about.faq` |
| company.process | en | Our process in numbers | `our-process-in-numbers` | (unmatched) | (needs an id) |
| company.process | en | How does our digital marketing process work? | `how-does-our-digital-marketing-process-work` | steps | `company.process.steps` |
| company.process | en | Why does this process work for Bali businesses? | `why-does-this-process-work-for-bali-businesses` | why | `company.process.why` |
| company.process | en | What results have clients seen from this process? | `what-results-have-clients-seen-from-this-process` | (unmatched) | (needs an id) |
| company.process | en | Ready to start with a free audit? | `ready-to-start-with-a-free-audit` | cta | `company.process.cta` |
| company.process | en | Frequently asked questions | `frequently-asked-questions` | faq | `company.process.faq` |
| company.process | en | Related reading | `related-reading` | related | `company.process.related` |
| company.process | id | Bagaimana proses kerja digital agency kami berjalan? | `bagaimana-proses-kerja-digital-agency-kami-berjalan` | steps | `company.process.steps` |
| company.process | id | Berapa lama sampai ada hasil? | `berapa-lama-sampai-ada-hasil` | timeline | `company.process.timeline` |
| company.process | id | Berapa biaya proses kerja digital agency? | `berapa-biaya-proses-kerja-digital-agency` | price | `company.process.price` |
| company.process | id | Mengapa proses ini berhasil di Bali? | `mengapa-proses-ini-berhasil-di-bali` | why | `company.process.why` |
| company.process | id | Apa hasil nyata dari proses ini? | `apa-hasil-nyata-dari-proses-ini` | (unmatched) | (needs an id) |
| company.process | id | Siap memulai proses kerja Anda bersama Gaia Digital Agency? | `siap-memulai-proses-kerja-anda-bersama-gaia-digital-agency` | cta | `company.process.cta` |
| company.process | id | Pertanyaan yang sering diajukan | `pertanyaan-yang-sering-diajukan` | faq | `company.process.faq` |
| company.process | id | Artikel dan layanan terkait | `artikel-dan-layanan-terkait` | related | `company.process.related` |
| company.team | en | Gaia Digital Agency in numbers | `gaia-digital-agency-in-numbers` | numbers | `company.team.numbers` |
| company.team | en | Meet the Gaia Digital Agency team | `meet-the-gaia-digital-agency-team` | meet | `company.team.meet` |
| company.team | en | What does the team do? | `what-does-the-team-do` | what | `company.team.what` |
| company.team | en | Who does the team work with? | `who-does-the-team-work-with` | who | `company.team.who` |
| company.team | en | Why choose this team? | `why-choose-this-team` | why | `company.team.why` |
| company.team | en | Team-led results | `team-led-results` | (unmatched) | (needs an id) |
| company.team | en | How does the team work? | `how-does-the-team-work` | how | `company.team.how` |
| company.team | en | Where does the team work? | `where-does-the-team-work` | where | `company.team.where` |
| company.team | en | Frequently asked questions | `frequently-asked-questions` | faq | `company.team.faq` |
| company.team | en | Ready to work with the team? | `ready-to-work-with-the-team` | cta | `company.team.cta` |
| company.careers | en | What is life like at Gaia Digital Agency? | `what-is-life-like-at-gaia-digital-agency` | life | `company.careers.life` |
| company.careers | en | Who do we hire for digital marketing jobs in Bali? | `who-do-we-hire-for-digital-marketing-jobs-in-bali` | who | `company.careers.who` |
| company.careers | en | Open roles | `open-roles` | open | `company.careers.open` |
| company.careers | en | How do we hire? | `how-do-we-hire` | how | `company.careers.how` |
| company.careers | en | Why work with us? | `why-work-with-us` | why | `company.careers.why` |
| company.careers | en | Ready to see how we think before you apply? | `ready-to-see-how-we-think-before-you-apply` | cta | `company.careers.cta` |
| company.careers | en | Frequently asked questions | `frequently-asked-questions` | faq | `company.careers.faq` |
| company.careers | en | Related reading | `related-reading` | related | `company.careers.related` |
| company.contact | en | How do you contact our digital marketing agency in Bali? | `how-do-you-contact-our-digital-marketing-agency-in-bali` | whatsapp | `company.contact.whatsapp` |
| company.contact | en | What should you send in the contact form? | `what-should-you-send-in-the-contact-form` | form | `company.contact.form` |
| company.contact | en | What happens after you contact us? | `what-happens-after-you-contact-us` | after | `company.contact.after` |
| company.contact | en | Where can you visit us in Ubud? | `where-can-you-visit-us-in-ubud` | visit | `company.contact.visit` |
| company.contact | en | Ready to talk? | `ready-to-talk` | cta | `company.contact.cta` |
| company.contact | en | Frequently asked questions | `frequently-asked-questions` | faq | `company.contact.faq` |
| company.contact | id | Bagaimana contact jasa digital marketing Bali lewat WhatsApp? | `bagaimana-contact-jasa-digital-marketing-bali-lewat-whatsapp` | whatsapp | `company.contact.whatsapp` |
| company.contact | id | Apa yang perlu Anda kirim? | `apa-yang-perlu-anda-kirim` | form | `company.contact.form` |
| company.contact | id | Berapa biaya jasa digital marketing di Bali? | `berapa-biaya-jasa-digital-marketing-di-bali` | cost | `company.contact.cost` |
| company.contact | id | Apa yang terjadi setelah Anda mengirim pesan? | `apa-yang-terjadi-setelah-anda-mengirim-pesan` | after | `company.contact.after` |
| company.contact | id | Di mana kantor kami di Ubud? | `di-mana-kantor-kami-di-ubud` | visit | `company.contact.visit` |
| company.contact | id | Siap berbicara dengan kami? | `siap-berbicara-dengan-kami` | cta | `company.contact.cta` |
| company.contact | id | Pertanyaan yang sering diajukan | `pertanyaan-yang-sering-diajukan` | faq | `company.contact.faq` |
| company.contact | id | Artikel dan layanan terkait | `artikel-dan-layanan-terkait` | related | `company.contact.related` |

Role collisions and gaps seen in the table: EN `/about/` has TWO sections that match `facts` ("by the numbers" and "Proof, in brief"), so one proposed id would label two sections; 7 of the company-page headings match no role and are drawn as generic prose (EN: Featured case studies, Our process in numbers, What results have clients seen from this process?, Team-led results; ID: Apa hasil klien kami?, Berapa biaya bekerja dengan kami?, Apa hasil nyata dari proses ini?). The same role also sits at different positions per locale (ID Process has `timeline` and `price`, EN does not). Pricing, Free audit, Services hub, Industries hub and Blog hub headings were not mapped here.

### 9.3 Other pages

| Pattern | Roles | Current DOM id |
|---|---|---|
| `pricing.<role>` | hero, spend, rates, drivers, services, tiers, results, choose, report, steps, pillars, prose, related, close | slugify(heading) |
| `industry.<slug>.<role>` | hero, numbers, different, services, results, playbook, pricing, where, why, index, signature, cta, faq, related | slugify(heading) |
| `service.<slug>.<kind>` | hero, faq, results, pricing, related, cta, prose-NN | slugify(heading) (unclassified prose sections have no role; propose <page>.s01.. in source order unless the editor names them) |
| `post.<slug>.<kind> / guide.<slug>.<kind>` | takeaways, toc, sources, faq, related, cta, prose-NN | main h2[id] heading slug (articles report headings, not sections) |

### 9.4 CTAs

| Proposed id | Where | Source | Tracking today |
|---|---|---|---|
| `cta.header.audit` | header primary nav CTA | data/navigation.json cta {label "Get your free audit", label_id "Minta audit gratis", url /free-audit/} | cta_click link_location=header link_text=<label> |
| `cta.mobilenav.audit` | mobile nav drawer | same navigation cta | cta_click |
| `cta.home.hero` | home hero button | first link of the index.md lead + HomeHero | cta_click link_location=hero |
| `cta.home.whatwedo.<serviceKey>` | home What we do, "Learn More" x9 | OPENING_STRINGS.learnMore + SERVICES[].href | cta_click link_location=whatwedo |
| `cta.home.casestudies` | home Featured case studies button | case-studies.ts STRINGS.button/href | cta_click link_location=casestudies |
| `cta.home.howwework` | home How we work button | how-we-work.ts label.button/href | cta_click link_location=howwework |
| `cta.home.close` | home closing CTA | home/cta.ts ctaButton ("Request Free Audit" / "Minta Audit Gratis") | cta_click link_location=cta |
| `cta.footer.whatsapp` | footer button | footer.ts footerWhatsapp + links.ts whatsappUrl | click_whatsapp link_location=footer |
| `cta.<page-id>.close` | closing CTA of every company/standard/industry/pricing page | the page's cta-kind ## section (CoClose, CtaBlock, IndCta, PricingClose); EN = free audit, ID = WhatsApp | cta_click link_location=<heading slug> |
| `cta.company.contact.whatsapp / .call / .mail / .directions / .vcard / .message` | contact hero actions | contact.ts HeroWords + site facts | click_whatsapp, click_phone, click_email, click_directions, save_contact |
| `cta.company.careers.register` | careers "Register interest" mailto (per discipline) | careers.ts OPEN + mailtoFor() | click_email |
| `cta.chat.launcher / .audit / .human / .whatsapp` | Tunas assistant | chat.ts CHAT_STRINGS + starters | none of the chat actions go through auto.ts (chat lead card is not form.form[id]) |

Today a CTA is identified by `(link_location, link_text)`: relabelling a button ("Request Free Audit" vs the header's "Get your free audit" for the same action) forks the report.

### 9.5 Forms

| Proposed id | DOM id | Hosted on | Field contract | Tracking |
|---|---|---|---|---|
| `form.contact` | `contact-form` | company.contact (en, id) | CONTACT_FIELDS (5 ids, byte-identical to the live site) | lead_form_start / lead_form_send / generate_lead form_id=contact-form Note: the contact FormScene wrapper has DOM id "form"; the <form> inside has id contact-form |
| `form.audit` | `audit-form` | free-audit (en) | AUDIT_FIELDS (6 ids) | form_id=audit-form Note: NOT rendered on /id/free-audit/: CoreTemplate.formFor tests /id/audit-gratis/, a URL that does not exist |
| `form.onboard` | `onboard-form` | /onboard/ (en only; src/pages/onboard.astro, not in the manifest) | lib/forms/onboard-questions.ts: SCHEMA_VERSION onboard.2026-09-07.v1, 2 stages, 13 fields, 4 group labels; ids are the ERP contract | lead_form_step step_index/step_name; form_id=onboard-form |
| `form.chat-lead` | (none) | Tunas assistant lead card (JS-built) | chat/server.mjs; fields fName, fContact, fBusiness, fConsent labels in chat.ts | not reported as lead_form_* (formOf requires form.form[id]) |

### 9.6 Page ids (examples; all 315 in `inventory.json` `longForm.pages[]`)

| URL (EN) | Page id | Twin |
|---|---|---|
| `/` | `home` | `/id/` |
| `/about/` | `company.about` | `/id/about/` |
| `/about/process/` | `company.process` | `/id/about/process/` |
| `/about/team/` | `company.team` | none |
| `/careers/` | `company.careers` | none |
| `/contact/` | `company.contact` | `/id/contact/` |
| `/pricing/` | `pricing` | `/id/pricing/` |
| `/free-audit/` | `free-audit` | `/id/free-audit/` |
| `/services/` | `hub.services` | `/id/services/` |
| `/services/seo/` | `service.seo` | `/id/services/seo/` |
| `/services/seo/local-seo/` | `service.local-seo` | `/id/services/seo/local-seo/` |
| `/industries/hotels-resorts/` | `industry.hotels-resorts` | `/id/industries/hotels-resorts/` |
| `/blog/` | `hub.blog` | none |
| `/blog/aeo-vs-seo-vs-geo/` | `post.aeo-vs-seo-vs-geo` | none |
| `/guides/local-seo-bali/` | `guide.local-seo-bali` | none |
| `/hotel-marketing-agency-bali/` | `landing.hotel-marketing-agency-bali` | `/id/hotel-marketing-agency-bali/` |
| `/id/jasa-seo-bali/` | `landing.jasa-seo-bali` | none (ID-only) |

## 10. Open questions for the owner

- **Q1.** Unverified figures ship in config and bypass the placeholder gate. home/opening.ts shows 4.9 stars, 127 Google reviews, 60+ brands, since 2017 and a Google Partner badge; home/case-studies.ts shows +64%, +87%, +46% (120 -> 197 direct bookings in 6 months). Meanwhile data/site.json aggregateRating, foundingDate and certifications are still [CONFIRM] and every content-file equivalent is a placeholder. In the CMS, are these approved claims (publishable now), or should they carry an unverified state and block publish until the ERP supplies them? _Why it matters: CMS_PLAN rule: "A page cannot publish while a placeholder is unresolved"; the ERP is the intended source for rating and case results._
- **Q2.** Client logos: 11 client/project names are shown on the home page (BRCA, John Hardy, Viceroy Bali, BIMC Hospital, ...), one is an unidentified emblem with empty alt. Are all cleared for public display? PAGE_PLAN says real client names attached to results were scrubbed elsewhere. _Why it matters: Decides whether CLIENTS is imported as publishable or held._
- **Q3.** Import scope: all 315 pages (so HOLD 47 / LATER 31 exist as drafts and MERGE 116 / CUT 42 as unpublished with redirect targets) or only the 79 built at launch? The 40 glossary terms are folded into one page; the 12 "best X agencies" posts are cut. _Why it matters: Sets importer size and whether MERGE/CUT rows become redirects._
- **Q4.** Visibility vocabulary: confirm the CMS states (shown / SEO-only / held / hidden) and their mapping from the plan: SHOW+KEEP -> shown; /glossary/ (VISITOR_HIDDEN) -> SEO-only; HOLD -> held; LATER -> held with a scheduled date (P2 = months 4-6, P3 = 7-12, no dates exist); MERGE/CUT -> not visibility but redirect/unlink. _Why it matters: G7; the architect needs the owner's words, not mine._
- **Q5.** Which languages must each piece have? 167 of 235 EN pages have no ID twin (all 66 EN blog posts have no ID twin; the 4 ID blog posts are ID-only), careers/team/pricing extras are English-only, and 12 ID pages have no EN twin. Is the target "every EN page gets an ID twin", or does the CMS simply record the languages that exist? _Why it matters: Decides whether missing twins are errors or normal._
- **Q6.** Counts written as words: "nine services", "nine industries", "Nine disciplines", "Sembilan layanan" appear as literals in copy strings (about.ts FACTS rows and scene lines, team.ts LINES and UI.facts, opening.ts wwdSubtitle, service-hero.ts HUB_HERO, industries-hub.ts HUB_UI.kicker, why-gaia). Should those become computed from the collection size, or stay editable text? _Why it matters: If an editor adds a tenth service, literal copy becomes false._
- **Q7.** Prices: 134 PRICE_* tokens (one resolved) live in markdown; process.ts (ID) hard-codes "IDR 19 juta hingga IDR 45 juta per bulan" and the ID process page repeats it. Where do prices live in the CMS: a pricing global the pages read, or inline per page? _Why it matters: Money path: one source or many; the owner decides._
- **Q8.** Two Indonesian one-liners exist per service (floaters.lineId "Halaman pertama Google untuk pencarian tamu Anda." vs service-hero.kickerId "Halaman satu untuk pencarian yang benar-benar diketik tamu Anda.") and EN uses services.description for both. Which is canonical, or are both wanted? _Why it matters: Import would otherwise create two fields for one idea._
- **Q9.** The areas map and data/area-projects.json (mock counts) are disconnected per PAGE_PLAN D1 but the home "Where we work" section still names 10 areas as client areas with coordinates. Import the 10 areas as content, drop the project counts until the ERP supplies them? _Why it matters: Affects AREAS and area-projects.json._
- **Q10.** Team: data/site.json lists 7 people including the honorific in the name ("Lord Ray", "Lady Monica", "Bli Gusde"). Import as a global now and switch to the ERP (HR) later, or wait? Eight further lead roles have no names and stay hidden. _Why it matters: CMS_PLAN marks people ERP-fed._
- **Q11.** Default locale: data/site.json says "en", the content tree is EN-source with ID mirrors, but migrations/0002_content.sql says id-ID is the tenant default per design section 05. Which is gaiada.com's default locale in WebDesk, and which codes (en-GB / id vs en-US / id-ID)? _Why it matters: Locale fallback (meta.x.localeFallback) and URLs depend on it._
- **Q12.** Should an Indonesian audit form exist? /id/free-audit/ currently renders no form (CoreTemplate tests /id/audit-gratis/). If that is a bug, who owns the fix, since this ticket is read-only on the site? _Why it matters: Surprising finding; affects form.audit hosting._

## 11. Surprising findings

1. **Section ids are not stable**: for every markdown-driven section the DOM id (and therefore `section_id` in GA4) is `slugify(heading)`; it differs between EN and ID and changes when a writer edits a heading. Only `hero`, `form`, `faq` and the ten home ids are literal.
2. **Layout is bound to heading text**: five company templates, the industry pages and the section classifier pick a component by regex over the heading (or by position on the home page). "A renamed heading can lose a picture but never break the page" (CareersTemplate).
3. **Unverified claims ship from config**: 4.9 stars, 127 reviews, 60+ brands, since 2017, a Google Partner badge, three case-study results and a hard-coded Indonesian price range are in `src/config` while the same facts are `[CONFIRM]` / `{{TOKEN}}` everywhere else (Q1, Q7).
4. **The `h1` claim in `frontmatter.ts` is stale**: all 315 files carry `h1:`.
5. **`/id/free-audit/` renders no form**: `CoreTemplate.formFor` tests `/id/audit-gratis/`, a URL no file has (Q12). The chat lead card is also outside the form tracking (`formOf` needs `form.form[id]`).
6. **`data/redirects.json` has two self-redirects** (`/services/social-media/` and `/blog/` to themselves) and is a template to be regenerated.
7. **`page-plan.json` is generated by a Python script**; the script, not the JSON, is where decisions live. The doc (PAGE_PLAN.md) trails the JSON by one page.
8. **No content photography and no 3D files**: the 83 OG cards, 38 diorama posters and the relief are generated; 741 alt-text entries describe images that do not exist.
9. **Static pages outside the 315-page manifest** (`/onboard/`, `/thank-you/`, 404; `src/pages/*.astro`) carry their own copy in the component or `lib/i18n/strings.ts`; not inventoried field by field.
10. **Duplicated facts**: the nine services are named in at least five places (services.ts label, floaters.short, service-hero.short, page-names ID_NAMES, careers/team DISCIPLINES) and the nine industries in five (INDUSTRIES.label, NAMES, SHORT_NAMES, ID_NAMES, chat INDUSTRY_WORDS), a service has two Indonesian one-liners, the Ubud address is re-typed in about/contact/team copy, "high season" months appear in careers.ts (text and indices), process.ts and why-gaia.ts.

## 12. What I could not determine, and limits

- Consumers are per **module** (import graph), not per field; an export-level usage map would need reading each component.
- `src/lib/i18n/strings.ts` (135 keys x 2), `components/**` inline `{en,id}` literals (ConsentBanner, `components/scenes/data/*`, industry `signature/*`, `mh-content.ts`) and the three static pages are outside `src/config`; listed, not inventoried field by field.
- For standard-template pages I did not enumerate per-page sections (2,690 `##` headings); only the kind/shape classification and the home/company/pricing/industry roles are mapped. Role assignment for company pages replicates the template regexes and was run on the `content/` text, not through Astro.
- Whether each of the 79 built pages has an OG card (`ogFallbacks`) was not checked (needs a build).
- I did not verify that `components/blocks/AreaMap`, `AreasServed` and `config/places.ts` are really unreferenced at runtime; PAGE_PLAN says "disconnected" while import statements still exist.
- Token occurrence counts: my regex over files gives 3,637 (front matter + body, 2,977 in bodies); `tokens.json` records `occurrences` that sum to 1,528. Not reconciled.

