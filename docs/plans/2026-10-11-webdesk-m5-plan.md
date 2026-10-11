# WebDesk M5: the gaiada.com admin panel beyond content (working plan)

**Started:** 2026-10-11 · **Status lives in** [`TASKS.md`](../../TASKS.md) (M5) · **Rulings:**
[`webdesk-design-v2.md`](../blueprints/webdesk-design-v2.md) §14, WSK-D66 to D69 (owner, 2026-10-11) ·
**Source:** [`2026-10-10-gaiada-com-website-cms-analytics.md`](./2026-10-10-gaiada-com-website-cms-analytics.md)
(the handoff) and gaiada-web-revamp's `docs/CMS_PLAN.md` and `docs/TRACKING.md` · **Follows:** M1 to M4
([`2026-10-10-webdesk-gaiada-proof.md`](./2026-10-10-webdesk-gaiada-proof.md), [`2026-10-11-webdesk-m3-plan.md`](./2026-10-11-webdesk-m3-plan.md))

Status words are the estate's: PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED (driven on a Linux
server, with the result observed). WebDesk tickets are gated by `webdesk/qa/linux-gate.sh` on sumopod, and ERP
tickets by the platform-nest and platform-ui suites in the Linux container gate plus `next build`. Each ticket
also has its own checks. Ticket ids are M5-local (`M5-A1` and so on), so they cannot collide with WSK numbers that
other sessions are taking.

## The rulings this plan works from

| Ruling | In short |
|---|---|
| WSK-D66 | Umami unparked, stock, in its own compose project on `gda-aicenter`. Only the collector is public; the ERP pulls read-only. **Precondition: M4's CPU-budget decision** |
| WSK-D67 | Tracking covers the whole plan (phases 0–5), consent-first. Each phase goes live only once the visitor addendum covers it and counsel has reviewed it |
| WSK-D68 | `/onboard` seeds the lead; AD-1 follows the first call; the website never links straight to AD-1 |
| WSK-D69 | A small pipeline adopts `agency_leads`: stages, value, currency, stage history. A stage change drives conversion uploads |

## What already exists (probed 2026-10-11 on `origin/main` c679aab1, not read from a tracker)

- **Site side (gaiada-web-revamp, `astro-site`):** consent banner (Consent Mode v2, denied by default); GA4, both
  Google Ads accounts, Meta Pixel and Clarity behind consent; the event list (`src/scripts/tracking/events.ts`,
  the contract); a hidden `attribution` form field; `generate_lead` de-duplicated by a submission id. There is
  **no privacy page yet**, and it is needed before launch.
- **WebDesk forms API:** `POST /v1/t/:tenant/forms/:formId/submit` exists, with a honeypot, Turnstile (stub mode
  by default), Redis rate limits, the consent text and version snapshotted per submission, and a retention purge.
  It has **no attribution field**. The Zone B `form.received` envelope carries ids only (site, form, submission);
  the tenant webhook carries `fields`.
- **`wd-zoneb-intake`** verifies, de-duplicates and notifies. **Nothing turns a submission into an
  `agency_leads` row.** On live, Zone B events do not leave WebDesk at all (`WEBDESK_ZONEB_BRIDGE_URL` is empty;
  M3 tracks that defect).
- **`agency_leads`:** `source` is limited to `invite`/`open`/`staff`. It has no stage, value or attribution
  columns, and its header calls it "NOT a CRM". D69 changes that on purpose.
- **Editorial:** there are two tiers on `webdesk_content_item`: editor (`read/create/update/request_publish`) and
  publisher (`publish/schedule` under WS4, `unpublish/delete`). The policy already carries `collectionKey` and
  `locale` "for later writer/translator roles". `publish_state` has no review state. The advisory placeholder
  lint runs on save. Scheduled publish (WSK-61) and preview tokens (WSK-46) have shipped.
- **`search`:** `search_properties.umami_site_id` exists (migration 0034). `SEARCH_ADS_WRITE_MODE` is
  `simulate|live`, and its only write code is Google Ads campaign mutation. Conversion uploads, Meta, LinkedIn,
  Business Profile, Bing and IndexNow are all **new** code.
- **The D36 internal sentinel client is not created yet.** gaiada.com's `search_properties` row needs it.
- **Legal:** the `legal/` pack covers the employee bot only, and every file in it is a DRAFT. The 2026-08-13
  "Gate 1 bypassed" ruling covered mock employee data only. Website visitors and real prospects are real
  personal data, which is why M5-G1 exists.

## Tickets

| # | Scope | Seat | Migration | Order |
|---|---|---|---|---|
| **M5-G0** | D36 internal sentinel client + gaiada.com's `search_properties` row, as an idempotent one-off script (never a migration); the owner runs the live write | Sonnet, Opus review | — | wave 0 |
| **M5-G1** | `legal/website-visitor-addendum.md`: DPIA, LIA, RoPA rows, retention, rights, a privacy-notice draft, open items for counsel; one row in `legal/README-NOTES.md` | Sonnet draft, Opus review | — | wave 0 (IN PROGRESS) |
| **M5-G2** | Counsel reviews the addendum; the owner confirms retention and controller entity | **owner** | — | after G1 |
| **M5-G3** | The site's `/privacy-policy/` page (EN + ID) from the addendum's notice draft, linked from the banner | with the site session | — | after G1; before launch |
| **M5-G4** | Vendor register rows: Umami, its geo source, the phase 5 IP/company data source | Haiku | — | with A3 / V1 |
| **M5-G5** | Data-subject rights across the website's data (addendum §9.3): WSK-38 matches a normalised phone as well as email; a platform-nest `privacy` find/export/erase for `agency_leads` and AD-1, which scrubs the person's fields and keeps the row; retention on `agency_leads` and AD-1; a hashed suppression list so an erased person is not re-imported or re-uploaded; one request fans out to every system | Sonnet, Opus review | platform-nest timestamped | before L4 goes live |
| **M5-G6** | Server-side consent log (addendum R-V3): the banner's choice is recorded under a random consent id (version, categories, time), so consent can be proven; withdrawal deletes the server-side profile | Sonnet, Opus review | its own | with A3 |
| **M5-A3** | Umami deploy (D66): compose project, own Postgres, egress default-deny, limits, collector-only nginx vhost, admin UI unpublished, nightly backup, a sumopod probe, runbook. Server work by the orchestrator | Sonnet (compose, runbook), Opus review | Umami's own | after M4's CPU decision + the CNAME |
| **M5-A4** | ERP read path: `search` pulls Umami summaries with the read-only token (env through compose `environment:`), BFF + MCP tools, an **Analytics** tab in the Website workspace (section map, sources, CTA and form funnel) | Sonnet, Opus review | — | after A3 |
| **M5-A5** | Site tracker sends the event list to Umami as custom events (cookieless, aggregate, D67); the host CSP allows the collector | with the site session | — | after A3; live after G2 |
| **M5-L1** | gaiada.com's contact, audit and onboard forms as WebDesk form definitions (field ids equal to the site's; consent text and version; retention; live Turnstile keys); the site moves off Web3Forms and shows a consent notice on each form (the API requires `consent: true`; `FormShell` has no notice today). **Defects found 2026-10-11:** `data_subject_ref` is taken only from a field named `email`, but the site's ids are `email_address` and `contact_email`, so WSK-38 cannot find gaiada.com's submitters; and the forms path has no PAN/national-ID scrub (AD-1 has `scrubText`) | Sonnet, Opus review; the site part with the site session | — | wave 1 |
| **M5-L2** | Attribution as a first-class, allow-listed, size-capped member of a submission (landing page, first and last touch, `utm_*`, click ids, external referrer, sections seen), plus a **snapshot of the visitor's marketing consent** (given or not, banner version, time) that P2–P4 require before any upload; stored in their own columns; in the tenant webhook; the Zone B envelope stays ids-only | Sonnet, Opus review | WebDesk next | wave 1 |
| **M5-L4** | `form.received` → `agency_leads`: the ERP fetches the submission over the authenticated API (never trusts the event as data), maps it, and creates the lead idempotently on the submission id; `source` gains `web`; attribution and submission id stored on the lead; an MCP tool for the same action | Sonnet, Opus review | platform-nest timestamped | after L1, L2, M3's Zone B bridge box; live after G2 |
| **M5-L5** | Staff alert for a new web lead through wa-chat-bot (lead id, first name and a link only, never the message body), to a group outside the work-summary bot's ingestion (addendum R-V13) | Sonnet | — | after L4 |
| **M5-L6** | A **Leads** tab in the Website workspace: submissions, attribution, the lead's ERP status | Sonnet | — | after L4 |
| **M5-W1** | Writers' room roles: writer, editor, SEO reviewer, translator, publisher on `webdesk_content_item`, as data-driven grants using the carried `collectionKey`/`locale` (aligned with the IAM program's roles-as-data); six-artifact Cerbos work | Opus design, Sonnet build, Opus review | platform-nest timestamped | after O-4 |
| **M5-W2** | Review flow: brief → draft → review → SEO/AEO sign-off → approve → schedule → publish, as an editorial state on the item version in WebDesk's control plane (`/v1` untouched); publish stays WS4 | Opus design, Sonnet build, Opus review | WebDesk next | after W1 design |
| **M5-W3** | On-save checks from the site's `CONTENT_RULES.md`: one H1, meta lengths, alt text, sources, internal links, the ID twin, an AEO extractability score; advisory, beside the existing placeholder lint | Sonnet | — | wave 2 |
| **M5-W4** | Briefs from `search` (target query, intent, AI questions, gaps), linked to a draft | Sonnet | platform-nest timestamped | after W2 |
| **M5-W5** | Editorial calendar and workflow board in the Website workspace | Sonnet, senior-uiux review | — | after W2 |
| **M5-W6** | AI assist through `ai-gateway-go` (outline, meta description, FAQ, EN→ID first draft, alt text); a human accepts every suggestion | Sonnet, Opus review | — | after W2 |
| **M5-W7** | Author profiles as records, linked to posts (E-E-A-T) | Sonnet | — | wave 2 |
| **M5-W8** | Writer dashboard: views and read depth (Umami), Search Console queries, leads that read the article, decay alert | Sonnet | — | after A4, L4 |
| **M5-P1** | Lead pipeline (D69): `stage`, `deal_value`, `currency` on `agency_leads`, an append-only stage-event table, the header note rewritten; Cerbos, BFF, MCP tools, UI in the agency leads view | Opus design, Sonnet build, Opus review | platform-nest timestamped | wave 3 |
| **M5-P2** | Google Ads click conversions (gclid) + enhanced conversions for leads (hashed email/phone) from `search` on a stage change, WS4-gated, de-duplicated by submission id; only for leads whose visit had marketing consent | Sonnet, Opus review | — | after P1, L2; live after G2 |
| **M5-P3** | Meta Conversions API, de-duplicated with the Pixel by the same event id | Sonnet, Opus review | — | after P1; **blocked on Meta Business Verification** |
| **M5-P4** | LinkedIn Insight tag (site, marketing consent) + LinkedIn Conversions API | Sonnet, Opus review | — | after P1 |
| **M5-P5** | `search` connectors: Google Business Profile, Bing Webmaster + an IndexNow ping on publish, an AI-crawler log from web server access logs; SM-16 AI-visibility panels | Sonnet | — | wave 4 |
| **M5-V1** | Vendor review of the IP → geo/company source (DB-IP Lite, CC BY 4.0, vs MaxMind GeoLite2); register row | Sonnet, Opus review | — | wave 4 |
| **M5-V2** | Enrichment collector in front of Umami: resolves the IP once (geo, network, company, bot flag), then drops it; consent-aware | Opus design, Sonnet build, Opus review | its own | after V1; live after G2 |
| **M5-V3** | Consented visitor profiles: a persistent id after consent, interests by industry and service, lead scoring, company shown against a profile; a **Visitors** tab (consented visitors only) | Sonnet, Opus review | platform-nest timestamped | after V2 |
| **M5-V4** | Content-decay alerts (clicks and views falling per page) | Sonnet | — | after A4 |
| **M5-V5** | A/B tests on blocks: variants in WebDesk, assignment on the site, results from Umami | Opus design, Sonnet build | WebDesk next | wave 5 |
| **M5-V6** | Our own sampled session replay for consented visitors | Opus design, Sonnet build | its own | after O-5 |

**Merging.** WebDesk tickets merge to main only after `webdesk/qa/linux-gate.sh` is green on the merged tree, and
ERP tickets only after the Linux container gate is green. The WebDesk orchestrator releases anything that needs a
Cerbos restart or a deploy. Release numbers are claimed one step at a time.

## Open, and whose

| # | Question | Owner | Gates |
|---|---|---|---|
| O-1 | M4's CPU budget on `gda-aicenter` (lower WebDesk to ~1.0 vCPU, or resize the box). Umami is counted inside it | **owner** (M4) | A3 |
| O-2 | The collector's name under `erp.gaiada.com` (proposed `insights.erp.gaiada.com`, a CNAME to `aicenter.erp.gaiada.com`) and its record in the gaiada.com zone | **owner** (DNS) | A3 |
| O-3 | Counsel for the addendum: who, and when | **owner** | G2, and everything live after it |
| O-4 | Freelance writers get ERP logins (staff-side, writers' room only)? The plan assumes yes; it adds a new kind of external principal | **owner** | W1 |
| O-5 | Does our own replay (V6) replace Clarity, or run beside it? Until then, Clarity is a session recorder filed under "analytics", so the banner must say so, and its masking must cover typed input (addendum §11.10) | **owner** | V6; the banner wording before launch |
| O-9 | **GA4 advanced vs basic Consent Mode.** The site, as built, sends cookieless pings to Google before consent; D67 allows only our own counts before consent. Basic mode (no Google contact until consent) matches D67; advanced keeps Google's modelled conversions. Recommended: basic | **owner** | the site's launch |
| O-10 | Interim Web3Forms: acceptable for real lead data until L1, or hold the forms until L1? (terms, region and retention unknown) | **owner** | the site's launch |
| O-6 | Production Turnstile keys for gaiada.com's forms | **owner** (Cloudflare) | L1 live |
| O-7 | Meta Business Verification | SMM team | P3 |
| O-8 | The purpose of Google Ads `AW-630595339`, and an access audit of the old GTM container and both Ads accounts (the handoff found ~50 unknown linker domains) | ads team / owner | P2 |

## Session log

**2026-10-11.** M5 started. The owner ruled D66 to D69 in one round of questions. The ERP sweep corrected the
handoff in five places: scheduled publish exists; `form.received` carries no attribution; the intake flow
creates no leads; `agency_leads` forbids stages by design; the sentinel client does not exist. G1 was drafted
(Sonnet, 531 lines) and reviewed. One error was corrected: the forms purge IS scheduled, by WSK-61. Its findings
became L1's two defects, L2's consent snapshot, G5, G6, O-9 and O-10. No server work, because the ERP cut-over to
`erp.gaiada.com` (M1) held the box.
