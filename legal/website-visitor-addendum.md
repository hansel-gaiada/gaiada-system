**DRAFT — not legal advice. For review by qualified counsel before use.**

# Website-Visitor and Website-Lead Addendum to the Legal Pack

> ⚠️ **DRAFTS — NOT LEGAL ADVICE.** This document is a working draft to accelerate and reduce the cost of legal review. **A qualified data-protection lawyer in the applicable jurisdiction(s) must review, localize, and sign off before any visitor or lead data is collected on a live site.** Nothing here is a ruling. Facts not established by the sources are marked «ASSUMPTION: …» for counsel or the owner to confirm.

## 0. Header

| Field | Value |
|---|---|
| Document | Website-visitor and website-lead addendum (DPIA + LIA + RoPA rows + notice + DSR changes) |
| Version / status | v0.1 — DRAFT, pending counsel review and owner decisions |
| Date | 2026-10-11 |
| Controller | [CONTROLLER ENTITY] — the Gaiada group / relevant child company «ASSUMPTION: confirm which legal entity operates gaiada.com and its ad accounts» |
| Primary jurisdiction | Indonesia (UU PDP No. 27/2022); drafted to GDPR-grade for EU/SG exposure. See [JURISDICTION] «ASSUMPTION: confirm jurisdictions» |
| DPO / contact | [DPO NAME/EMAIL] |
| Lawful bases used | Legitimate interests (narrow, listed in §3) and consent (everything individual-level, all ad platforms) |
| Sources | `gaiada-web-revamp/docs/TRACKING.md`, `docs/CMS_PLAN.md`; ERP `docs/plans/2026-10-10-gaiada-com-website-cms-analytics.md`; `webdesk/migrations/0003_forms.sql`, `0007_privacy_dsr.sql`, `webdesk/api/src/forms/`, `webdesk/api/src/privacy/`; `platform-nest/migrations/202609050857_agency_discovery_intake.sql` |
| Basis of scope | Owner rulings of 2026-10-11 (Umami first-party store; everything in the plan, phased; consent table binding) |

**How to read this alongside the pack.** The existing pack (`README-NOTES.md`, `lia.md`, `dpia.md`, `ropa.md`, `privacy-notice.md`, `retention-and-dsr-procedure.md`) covers the WhatsApp work-summary bot and its employees. It does **not** cover website visitors. This addendum is separate and stands on its own, but:

- It reuses the pack's conventions: «ASSUMPTION» markers, [CONTROLLER ENTITY] / [JURISDICTION] / [DPO] placeholders, the Likelihood / Severity / Residual risk table.
- §8 holds RoPA rows in the format of `ropa.md`, ready to paste.
- One interaction needs counsel's eye: staff receive lead alerts on WhatsApp through the ERP's bot, which sits inside the existing bot's estate (see R-V13 and open item 12).
- Lawful basis differs from the bot. The bot cannot use consent (employer power imbalance). Visitors are not employees, so consent is available and is used for everything individual-level.

**Status vocabulary** (matches the repo): **BUILT** = exists in code on the site today per `TRACKING.md`; **PLANNED** = not built; **UNVERIFIED** = stated in a plan but not checked against code by the drafter.

---

## 1. Scope

### 1.1 In scope

| Item | Detail |
|---|---|
| Sites | `gaiada.com` (production) and its staging hosts, currently `24-pyevq.gaiada.com`. The site is a static Astro site. «ASSUMPTION: production hosting is undecided (CMS_PLAN decision 8); the hosting provider and region of the access logs must be confirmed» |
| Staging | `PUBLIC_TRACKING=off` is the default outside production, so staging sends nothing to vendors. «ASSUMPTION: staging hosts accept no real personal data in forms and are not indexed; confirm» |
| ERP systems touched | Umami (self-hosted on `gda-aicenter`), the enrichment collector (PLANNED), WebDesk forms API, `agency_leads` and AD-1 Discovery Intake tables in platform-nest, the WhatsApp bot alert, the `search` module's conversion uploads (PLANNED) |
| Third-party systems | Google (GA4, Google Ads), Meta (Pixel; Conversions API PLANNED), Microsoft (Clarity), LinkedIn (Conversions API PLANNED), Cloudflare (Turnstile on the forms API), Web3Forms (interim form transport), a geo/company dataset vendor (DB-IP Lite or MaxMind GeoLite2, not chosen) |

### 1.2 Out of scope (needs its own controller analysis)

- **Client sites later run on WebDesk.** For those, the client is the controller and Gaiada is the processor (WebDesk's own WSK-38 design says this). Offering Umami and the enrichment collector to client sites changes the roles, the notices and the DPIA. It needs a separate assessment before it happens.
- The **live WordPress gaiada.com** (Hostinger) until cut-over. It is addressed only as a possible past incident (§11, item 13).
- The ERP's staff-facing processing (covered by the existing pack).
- The 122-question AD-1 intake as a business-information questionnaire, except for the personal data it holds about the prospect.

### 1.3 Data subjects

| Data subject | Who | Notes |
|---|---|---|
| Visitors | Anyone loading a page | Mostly anonymous. B2B audience «ASSUMPTION: the site is not directed at children and has no age gate; see R-V9» |
| Consented visitors | Visitors who accepted analytics and/or marketing | The only group profiled at individual level |
| Leads / prospects | People who clicked WhatsApp, phone or email, or submitted contact, audit or onboard forms | They asked to be contacted |
| Form submitters | Same as above, at the point of submission | Subset of leads |
| People named in a submission | Colleagues, owners, staff, references typed into free-text fields (e.g. "a website you like", "who are you trying to reach") | Not aware their data is being processed; third parties. Free text is not scrubbed by the WebDesk forms service today (no scrub call found in `forms.service.ts`) |

---

## 2. Processing description and data flows

### 2.1 Description

1. A visitor opens a page. A consent banner offers Reject all, Accept all, and Choose (analytics, marketing). The choice is held only in the visitor's `localStorage` (`gaia-consent`, with version and date; re-asked after 365 days or on a version bump). **BUILT.**
2. The page sends cookieless counts to Umami, our first-party store. **PLANNED** (Umami is not yet deployed; the tracker module and event list are BUILT).
3. A collector in front of Umami resolves the IP once to country/city and a bot flag, then discards the raw IP. For consented visitors only, it also resolves network and company and attaches them to a profile. **PLANNED (phase 5).**
4. Third-party tags load according to consent: GA4 and Google Ads in Google's advanced Consent Mode, Meta Pixel after marketing consent, Clarity after analytics consent. **BUILT.**
5. A visitor may submit a form (contact, audit, onboard) or click WhatsApp, phone or email. Today forms post to Web3Forms, which emails the submission. **BUILT (interim).** The target is the WebDesk forms API, then `agency_leads`, then a WhatsApp alert to staff. **PLANNED (phase 3).**
6. After the first call, a token link to the 122-question AD-1 intake is sent. **BUILT in the ERP** (AD-1); the link from `/onboard/` is PLANNED.
7. Phase 4 adds lead stages, deal value and server-side conversion uploads to Google Ads, Meta and LinkedIn. **PLANNED.**

The site is static. The only live public endpoints are the forms API and the analytics collector.

### 2.2 Data-flow table

Lawful basis codes: **LI** = legitimate interests (§3); **C** = consent; **C-an** = analytics category; **C-mk** = marketing category; **LI/C** = see row.

| # | Flow | Data | Purpose | Basis / consent category | Recipient | Location / transfer | Retention (proposed) | Status |
|---|---|---|---|---|---|---|---|---|
| F1 | Browser → **GA4** (advanced Consent Mode v2) | Before consent: cookieless pings (page, event, IP and user agent as seen by Google, consent state `gcs=G100`). After: cookies, client id, events from the event list | Aggregate analytics; Ads audiences | **Pre-consent pings: no clean basis, see R-V2.** After consent: C-an | Google | US and global. «ASSUMPTION: Google LLC / Google Asia Pacific, DPF-certified; confirm» | 14 months (vendor setting) | BUILT |
| F2 | Browser → **Google Ads** tags (`AW-623220639`, `AW-630595339`) | Same tag as GA4; ad click ids; on the thank-you page, the lead's email and phone are handed to gtag for enhanced conversions (`allow_enhanced_conversions` on both AW ids): gtag hashes them in the browser and uses them only when `ad_user_data` is granted | Ad measurement, conversion counting | C-mk | Google | As F1 | Per Google Ads account settings «ASSUMPTION: confirm» | BUILT |
| F3 | Browser → **Meta Pixel** `1279605996682911` | PageView, *Contact*, *FindLocation*, *Lead* (with event id = submission id); `fbp`/`fbc` cookies; IP, user agent | Ad measurement, audiences | C-mk | Meta | US and global «ASSUMPTION: Meta Platforms Ireland / Inc.; confirm» | Per Meta account settings | BUILT |
| F4 | Browser → **Microsoft Clarity** `r2ajrdrk6h` | Session recording and heatmaps: clicks, scroll, page content, masked per Clarity setting; IP | UX analysis | C-an (but it is a recorder, see R-V1 and R-V2) | Microsoft | US and global | Per Clarity project setting «ASSUMPTION: confirm default (30 days is common)» | BUILT |
| F5 | Browser → **Umami collector** (our server) | Page, event name, referrer, UTM, language, viewport; section/CTA/form-step events; no values typed | Cookieless aggregate analytics | LI before consent; no profile | Us (processor: none) | `gda-aicenter`, «ASSUMPTION: Google Cloud, likely Singapore asia-southeast1; confirm» | 14 months | PLANNED |
| F6 | Browser → **enrichment collector** (pre-consent request) | IP (in memory only), user agent | IP → country/city + bot flag, then discard | LI | Us; geo dataset is a local file lookup (no call out) «ASSUMPTION: DB-IP Lite / GeoLite2 loaded locally, no per-request API call; confirm» | As F5 | Derived country/city/bot flag only, inside F5 aggregates; raw IP never stored | PLANNED |
| F7 | Browser → **enrichment collector** (consented request) | IP (memory only) → network, company, country/city, bot flag; visitor id; pages and sections viewed; interest tags (industries/services) | Visitor profile; company identification; lead scoring | C-an for the profile; **company identification shown against a profile: C (and see R-V1)** | Us; ERP staff via the Website workspace (Visitors) | `gda-aicenter` | Derived attributes on the profile. «ASSUMPTION: profile retention 14 months from last visit» | PLANNED |
| F8 | Browser → **our session replay** (sampled) | DOM mutations, clicks, scroll; form inputs masked by default; no recording of abandoned form input | UX and conversion analysis | C | Us | `gda-aicenter` | 30 days | PLANNED (phase 5, optional) |
| F9 | Browser → **A/B test assignment** | Variant id on the visitor id | Block experiments | C for individual-level assignment; aggregate-only variant counts may fall under LI «ASSUMPTION: counsel to confirm» | Us | `gda-aicenter` | Same as profile | PLANNED |
| F10 | **Form → Web3Forms → email** (interim) | All typed fields, hidden `attribution`, subject; sender IP seen by Web3Forms; honeypot field | Deliver the enquiry to a mailbox | LI (responding to a request) | Web3Forms «ASSUMPTION: processor role, DPA, region and retention are unknown; confirm»; the receiving mailbox (e.g. web@gaiada.com) | Web3Forms location unknown | Mailbox: unlimited today. «ASSUMPTION: set a mailbox retention rule» | BUILT (key not yet set per `HANDOVER.md`) |
| F11 | **Form → WebDesk forms API** | Typed fields, consent flag and notice text + version, attribution, Turnstile token; request IP | Receive the lead | LI (responding to a request) + consent record for the notice | Us; **Cloudflare Turnstile** receives token and `remoteip` | `gda-aicenter`; Cloudflare global | `submissions` per form `retention_days` (default 180 in schema; propose 90 once delivered to ERP) | WebDesk API BUILT; site not yet wired (phase 3) |
| F12 | WebDesk → **`form.received` → n8n `wd-zoneb-intake` → `agency_leads`** | org_name, contact_name, contact_email, contact_phone, source, origin_site, status, and (PLANNED) attribution, first call notes | Lead handling | LI | Staff; n8n (ours) | `gda-aicenter` | Unconverted 24 months, then delete; converted follows client-record retention | Table BUILT; intake flow PLANNED; **no attribution, consent or retention columns exist yet** |
| F13 | ERP bot → **WhatsApp alert to staff** | Lead alert text. «ASSUMPTION: contents are not defined; recommend lead id + first name + link, no message body» | Fast follow-up | LI | Staff in the group; WhatsApp (Meta) as transport | Meta global | Lives in WhatsApp group history for as long as the group keeps it | PLANNED |
| F14 | **AD-1 Discovery Intake** (token link) | 122 answers: business strategy, budget, competitors; contact name, email, phone | Scoping a project | LI / pre-contract steps | Staff | `gda-aicenter` | **No retention default today** (design §7 flags it as a gap); propose same as `agency_leads` | BUILT in ERP |
| F15 | ERP `search` module → **ad platforms, server-side** | Lead stage change event; hashed email/phone; gclid / fbclid / li_fat_id; event id = submission id; (PLANNED) deal value | Teach ad platforms which clicks became clients | **C-mk of the original visit (proposed rule, §3.6)** | Google Ads, Meta, LinkedIn | US and global | Platform-side per account | PLANNED (phase 4) |
| F16 | **Security / access logs** | Raw IP, user agent, URL, timestamp, status; rate-limit counters keyed on IP (Redis) | Abuse prevention, rate limits, incident response | LI | Us; host provider | Web host(s) «ASSUMPTION: confirm»; Redis on `gda-aicenter` | 14 days | Forms rate limits BUILT; log retention policy PLANNED |
| F17 | Browser → **consent record** | Choice, version, date, per-category state | Prove consent | LI (accountability) | Local only today | Visitor's browser | Browser: 365 days. **Server-side proof: none today** (see R-V3) | BUILT locally; server log PLANNED |

### 2.3 Notes on the table

- **F1 is the sharpest conflict with the owner's consent table.** The plan says that before consent only cookieless counts and IP → country/city happen on *our* side. Advanced Consent Mode, as built, still sends cookieless pings to Google before consent: `TrackingHead.astro` sets every signal to denied, then `vendors.ts` loads gtag.js for every visitor. That is a disclosure to a third party, not just our own counting. It is not live anywhere yet (`PUBLIC_TRACKING` is off outside production). Basic mode holds the gtag.js load until analytics or marketing is granted, as Clarity and Meta already wait. See R-V2 and open item 3.
- **F4 Clarity** is a session recorder listed under the *analytics* category. The CMS plan classes session replay as a consented, optional, later feature. The banner wording must say that analytics includes session recording by Microsoft, or Clarity must move behind its own control.
- **F10 and F11 both exist** in the roadmap (stopgap and target). They never run for the same form at the same time; the interim flow should be retired at phase 3.
- **F7 (company identification).** The collector takes the consent state from the browser request. A request without a valid consent flag is treated as not consented. «ASSUMPTION: this design; the collector is not built.»
- **Attribution field.** Click ids, UTMs, landing page and external referrer are online identifiers. With consent the session's first page is kept; without consent the field carries only what the form page itself knows (BUILT per `TRACKING.md`). The plan also lists `_fbp` / `_fbc` among submission attribution fields; those exist only if the Pixel has set them (marketing consent).

---

## 3. Lawful basis per purpose

### 3.1 Summary

| Purpose | Basis | Why |
|---|---|---|
| Aggregate cookieless analytics (Umami, no profile) | LI | Minimal data, no identifier persisted, no third party |
| Security and access logs with raw IP | LI | Needed to run rate limits and respond to abuse |
| IP → country/city + bot flag, then discard | LI | Needed to count geography and filter bots; IP not kept |
| Handling a lead who asked to be contacted | LI (and steps at the person's request) | The person initiated contact |
| GA4 / Ads / Meta / Clarity after banner | Consent (analytics or marketing category) | Persistent identifiers, third-party disclosure |
| Visitor id, cross-visit interest profile, lead scoring | Consent (analytics) | Profiling of an individual |
| Company identification against a profile | Consent, **plus extra notice**; hardest balancing (§3.5) | See §3.5 |
| Session replay (ours) | Consent | Records behaviour in detail |
| A/B tests assigned to an individual | Consent | Individual assignment persisted |
| Ad conversion uploads (server-side) | Consent (marketing), proposed rule §3.6 | Sends identifiers to ad platforms |

«ASSUMPTION: under UU PDP the equivalent of Art. 6(1)(f) GDPR is the "other legitimate interests" ground in the lawful-processing article; counsel to confirm the article, and whether UU PDP requires a documented balancing test as GDPR-grade practice does.» «ASSUMPTION: GDPR-style rules on storing or reading information on a visitor's device (ePrivacy Art. 5(3)) are treated as applying to `localStorage`, `sessionStorage` and pixels for EU visitors; Indonesia has no direct equivalent; confirm.»

### 3.2 Mini-LIA A: aggregate cookieless analytics (Umami)

| Test | Assessment |
|---|---|
| **Purpose** | Know which pages and sections work, where people leave, which sources bring visits. A real, specific, lawful business interest; does not rely on identifying anyone. |
| **Necessity** | Counting visits needs an event per page view. Section and CTA events are the minimum to improve the site. No cookie or persistent id is needed. «ASSUMPTION: Umami's cookieless session id is a salted hash of site, IP and user agent that rotates, and the IP is not stored; confirm for the exact version before launch» |
| **Balancing** | Visitors reasonably expect a site to count visits. Data held: event, page, referrer, UTM, country/city, device class. No identifier survives the rotation window, no profile, no third party. Impact is very low. Withdrawal: an objection channel exists (§9); the visitor cannot be singled out in the store, so a per-person objection cannot be actioned. Counsel to confirm that is acceptable (GDPR Art. 11 situation). |
| **Safeguards** | No cookies, no raw IP stored, no typed values, 14-month retention, first-party hosting. |
| **Outcome** | Passes, if the "no raw IP, no persistent id" facts hold. Re-test if Umami is configured to keep IPs. |

### 3.3 Mini-LIA B: security and access logs with the raw IP

| Test | Assessment |
|---|---|
| **Purpose** | Rate limiting, bot and abuse defence, incident investigation. Also protects the data of people who use the forms. |
| **Necessity** | An IP is the only practical key for a public form's rate limit (the forms API keys its Redis limits on `request.ip`). Logs are needed to investigate abuse. |
| **Balancing** | Standard internet expectation. Short retention, restricted access, used for nothing else. Low impact. |
| **Safeguards** | 14-day retention (PLANNED); no join to analytics or profile; access limited to ops. A log is **not** an analytics source. |
| **Outcome** | Passes. Condition: the 14-day purge exists and is verified. Today only the Redis window expiry is built; web-server log retention is not defined. |

### 3.4 Mini-LIA C: IP → geo + bot flag, then discard

| Test | Assessment |
|---|---|
| **Purpose** | Country/city statistics; excluding bots from counts and from lead scoring. |
| **Necessity** | Needs the IP once. Country/city precision, not street. Bot flag protects data quality. |
| **Balancing** | The raw IP lives in memory for one request. Output is coarse and cannot single out a person. Low impact. |
| **Safeguards** | Raw IP never written to Umami, Postgres, disk or logs (the collector's own access log must **not** record it, or it becomes F16 and needs its own 14 days). Resolver is a local dataset (no call to a third party). |
| **Outcome** | Passes **only if** the collector writes nothing identifying. Needs a test that greps logs and DB for the test IP. |

### 3.5 Mini-LIA D: lead handling for a person who asked to be contacted

| Test | Assessment |
|---|---|
| **Purpose** | Reply to an enquiry, run a discovery call, prepare a proposal, decide whether to convert or decline. |
| **Necessity** | Contact details and the message are needed to reply. Business questionnaire answers are needed to scope work. |
| **Balancing** | The person initiated it and expects a reply. Note: free text can include other people's data and over-sharing; the onboard form says "rough answers are fine". |
| **Safeguards** | Short form (17 fields); no typed value goes to analytics; retention 24 months unconverted; scrub of PAN/national IDs before persist is built for AD-1 (`scrubText`) but not found in the WebDesk forms path. |
| **Outcome** | Passes for the lead's own contact and enquiry. **Does not cover** using that lead's data for ad targeting or conversion uploads: that is §3.6. |

### 3.6 Consent purposes, and where the balancing is hardest

**Why company identification and profiling are behind consent.** Under GDPR-grade analysis a legitimate-interest case for these is weak:

- **Company identification** links an IP-resolved network to a named company and then shows it beside a person's behaviour. In B2B settings people reasonably expect a vendor to know their employer when they identify themselves, not when they browse. The match can be wrong (shared offices, VPNs, coworking, mobile carriers), so it risks mis-attribution of a person to a company. It may also reveal where someone works, a home-office address, or a link to a person who is a sole trader (an individual in law).
- **Cross-visit interest profiles and lead scoring** are profiling. A score used to prioritise follow-up is a decision about a person. Even if no legal effect, the transparency and objection duties are heavy.
- **Combined, they build a record of an identifiable person's interests over time.** The reasonable-expectations limb of the balancing test fails for a first-time visitor.

We therefore put them behind consent and do not run an LIA for them. Counsel should still confirm whether consent is sufficient for company identification or whether **additional notice** is needed to make the processing foreseeable (open item 5).

**Consent quality requirements** (all in the build or required before launch):

| Requirement | Status |
|---|---|
| Reject all and Accept all equal size, same row | BUILT |
| No pre-ticked categories; necessary storage limited to the choice itself | BUILT |
| Granular (analytics, marketing) | BUILT |
| English and Indonesian | BUILT |
| Withdrawal as easy as giving; reopen via footer | BUILT |
| Withdrawal effects: Meta revoked; Clarity stopped and cookies cleared | BUILT |
| Withdrawal deletes the server-side visitor profile | PLANNED |
| Link to the privacy policy | Link exists once `/privacy-policy/` is built; **page does not exist** |
| Banner states recording and profiling in plain words | PLANNED (wording for counsel) |
| Server-side proof of consent | PLANNED (R-V3) |

**Proposed rule for phase-4 server-side conversions** «ASSUMPTION: confirm this is the rule counsel wants»:

1. At form submission, the site snapshots the visitor's marketing-consent state (given / not given, banner version, timestamp) into the submission and into `agency_leads`.
2. The ERP uploads a conversion to Google, Meta or LinkedIn **only** if that snapshot says marketing consent was given.
3. No snapshot, an unknown state, or a withdrawal before upload means **no upload**. A withdrawal after upload stops all further uploads for that lead (later stage changes) and triggers a review of whether platform-side deletion is possible.
4. The form's own consent notice (accepted per submission, text and version stored in WebDesk) must tell the person that, if marketing consent was given, hashed contact details and the outcome may be sent to the ad platforms. This is **not** a bundled condition of sending the enquiry.
5. Option for counsel (stronger): add a separate, unticked checkbox on the form for conversion uploads, instead of relying on the earlier banner choice. This is cleaner if the banner choice is considered too remote in time and context.

---

## 4. Data categories

| Category | Examples | Where | Notes |
|---|---|---|---|
| Visit events | Page, section id, CTA clicks, WhatsApp/phone/email/directions clicks, language, form start/step/send, web vitals, referrer, UTM, ad click ids | Umami (all visitors); GA4, Ads, Meta, Clarity (per consent) | Event list in `src/scripts/tracking/events.ts` is the contract |
| Derived geo | Country, city | Umami | From IP, then IP dropped |
| Bot flag | Boolean | Umami | |
| Device class | Browser, OS, viewport | Umami, GA4 | |
| Online identifiers | Visitor id (PLANNED), GA4 client id, `fbp`/`fbc`, Clarity user id, ad click ids (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `li_fat_id`) | Browser; vendors; submissions (click ids) | Consent required for persistent ones |
| Network / company | ASN/ISP, inferred company name | Profile (PLANNED) | Consent only; may be wrong |
| Interest profile | Industries and services viewed, lead score | Profile (PLANNED) | Consent only; see R-V1 |
| Session replay | Interaction recording | Clarity (BUILT); ours (PLANNED) | Consent only |
| Raw IP and user agent | Access logs; rate-limit key; sent to every vendor by the nature of HTTP | Web host, Redis, vendors | 14 days in our logs |
| Contact data | Name, email, phone/WhatsApp, business name | Web3Forms / WebDesk / `agency_leads` | |
| Enquiry content | Message, project trigger, current URL, audience, brand notes, reference site, "anything else" | Same | Free text; may include third-party data |
| Business info | Business type, goals, budget and strategy in AD-1 | AD-1 tables | Commercially sensitive, not special-category |
| Lead status | Stage, owner, decline reason, deal value (PLANNED), converted client id | `agency_leads` | Deal value is about a business, but attaches to a person |
| Consent record | Banner choice, version, date (browser); form notice text + version + time (WebDesk) | Browser; `submissions` | |
| Hashed identifiers | SHA-256 of email/phone for Google (BUILT, browser) and ad APIs (PLANNED) | Google, Meta, LinkedIn | Hashed is still personal data |

### 4.1 Never collected (binding)

| Not collected | How it is enforced |
|---|---|
| Typed input of abandoned forms | Events carry only `form_id`, step index and step name; `TRACKING.md`: "No parameter ever holds what someone typed". BUILT. Our replay and Clarity must mask all form fields: «ASSUMPTION: Clarity "Balanced" masking covers all typed form input; confirm in the Clarity admin, or choose Strict or a form-level mask» |
| Raw IP in analytics | Collector design (PLANNED). Umami configuration must not store IP |
| Browser fingerprinting to defeat refusal | Banner refusal means no persistent id; no canvas / font / audio fingerprinting code. Code review rule; a CSP and a script allow-list are the technical check |
| Cross-site following | No cross-domain linker domains (BUILT; the live site had ~50) |
| Selling or sharing beyond the named ad platforms | Contract and architecture rule; vendor register |
| Special-category data (health, biometrics, religion, etc.) | Not requested by any form field. Free text could contain it: see R-V7 and R-V12 |
| Children's data | Not targeted; see R-V9 |
| PAN / national ID numbers | Not requested; scrub exists in AD-1, **not found** in WebDesk forms (PLANNED to add) |

---

## 5. Retention

All values are «ASSUMPTION: defaults for counsel and owner to confirm».

| Data | Retention | Trigger | Disposal | Status |
|---|---|---|---|---|
| Umami events | 14 months | Event time | Umami data-retention setting / purge job «ASSUMPTION: confirm Umami has a built-in retention control, otherwise a scheduled SQL delete» | PLANNED |
| Enrichment results | Only as derived attributes on the consented profile; **raw IP in memory only, never persisted** | Request | Memory freed at end of request | PLANNED |
| Visitor profile (visitor id, interest tags, score, network/company) | 14 months from last visit «ASSUMPTION» | Last activity | Delete row; also on withdrawal | PLANNED |
| Raw-IP security and access logs | 14 days | Log time | Rotation; verify the rotation exists on every host | PLANNED |
| Redis rate-limit counters | Window length (minutes) | Window | `PEXPIRE` | BUILT |
| Form submissions in WebDesk (`submissions`) | Per form `retention_days`: propose 90 days once delivered to the ERP (schema default 180 today) | `created_at` | Scrub: payload set to `{}`, consent text tombstoned, status `purged`; row skeleton survives | BUILT: the purge runs hourly on WebDesk's scheduler (WSK-61, `forms-retention-purge`) |
| Web3Forms and the receiving mailbox (interim) | Mailbox: propose 90 days; Web3Forms: unknown «ASSUMPTION: obtain their terms» | Receipt | Manual | Interim |
| `agency_leads` unconverted | 24 months, then delete | Last status change | Hard delete or scrub «ASSUMPTION: counsel to choose; deletion must reach AD-1 answers too» | **PLANNED: no retention exists today (AD-1 design §7 flags this gap)** |
| AD-1 submissions of declined / unconverted leads | Same as the lead | Lead's clock | Same | PLANNED |
| Converted leads | Follow client-record retention | Conversion | Per ERP retention schedule | n/a |
| Session replay (ours) | 30 days | Recording | Delete | PLANNED |
| Clarity recordings | Per Clarity setting «ASSUMPTION: confirm; align to 30 days if configurable» | Recording | Vendor | BUILT |
| GA4 | 14 months (vendor setting) | Event | Vendor | Setting is listed in `TRACKING.md` "Set up in each vendor's admin"; confirm it was applied |
| WhatsApp lead alerts | Not controllable: stays in the group | Message | Manual deletion by group admin | PLANNED; minimise content |
| Consent records | For as long as the data they justify, plus 1 year | Last use of the data | Delete | Browser copy BUILT; server copy PLANNED |
| DSR request log | Use the pack's DSR-log period | Closure | Per `retention-and-dsr-procedure.md` | `dsr_requests` ledger BUILT in WebDesk |

---

## 6. DPIA

A DPIA is warranted: profiling, company identification, large-scale monitoring of behaviour, third-country transfers, and use of new technology (session replay) all appear together. «ASSUMPTION: UU PDP No. 27/2022 requires a DPIA for profiling and large-scale systematic monitoring; counsel to confirm the article and any filing duty.»

Scoring follows the pack: Likelihood and Severity are Low / Medium / High; Residual is after the mitigations in §7 are in place and verified. These are a drafting starting point.

| # | Risk | Likelihood | Severity | Key mitigations | Residual |
|---|---|---|---|---|---|
| **R-V1** | **Profiling and company identification.** An identifiable person's interests are tracked across visits and tied to an employer; match may be wrong; scores could be used against a person | Medium | High | Consent only; transparent notice; no scoring-based decisions with legal effect; manual review before any outreach based on a score; withdrawal deletes profile; confidence flag on company match; no use for HR or any non-marketing purpose | Medium |
| **R-V2** | **Consent quality and pre-consent disclosure.** Banner design, equal Accept/Reject (BUILT), Clarity (recorder) under "analytics", and **GA4 advanced Consent Mode pings to Google before consent** | Medium | High | Equal buttons (BUILT); decision on advanced vs basic Consent Mode (open item 3); banner wording for Clarity; re-ask on version change (BUILT) | Medium, **Low if basic Consent Mode is chosen** |
| **R-V3** | **No server-side proof of consent.** Choice lives only in the visitor's `localStorage`; we cannot evidence it later | High | Medium | Server-side consent log keyed by a random consent id (not by visitor id), recording version, categories, time; the submission snapshot (§3.6) | Low once built |
| **R-V4** | **Third-country transfers to ad platforms (US).** Google, Meta, Microsoft, LinkedIn; UU PDP cross-border rule | High | Medium | Consent as a gate for all four; transfer mechanism per vendor (open item 4); data minimisation (hashed identifiers); vendor register rows | Medium |
| **R-V5** | **Ad-platform joint controllership.** Meta Pixel, Meta CAPI, Google enhanced conversions: the platform decides purposes for its own use. Fashion ID (CJEU C-40/17) makes the site operator a joint controller for collection and transmission, so we owe the notice and the consent | High | Medium | Collect consent before any pixel fires; name each vendor in the notice; joint-controller terms (Meta Controller Addendum; Google Ads data processing terms) accepted and filed; do not send more than the minimum fields | Medium |
| **R-V6** | **Re-identification of "anonymous" analytics.** Umami's hash of IP+UA, small cohorts, rare company or city, joinable with logs | Low–Medium | Medium | Rotating salt «ASSUMPTION»; no join between Umami and security logs; suppress small cells in dashboards; no raw IP retained; separate stores for cookieless vs consented | Low |
| **R-V7** | **Over-collection through free-text fields and attribution.** People type third-party or sensitive data; attribution holds click ids | Medium | Medium | Short forms (17 fields); help text; scrub for PAN/IDs in the WebDesk path (add); attribution limited to the listed fields; no analytics copy of typed values | Low–Medium |
| **R-V8** | **Security of the public collector and forms API.** Exposed endpoint: spam, injection, DoS, poisoning of stats, data exfiltration | Medium | High | Turnstile, honeypot, per-IP and per-form rate limits, origin guard (BUILT in forms API); collector with strict schema, size cap, rate limit, no auth secrets in the page, read-only token for the ERP, separate DB role; tenant RLS (BUILT in WebDesk) | Low–Medium |
| **R-V9** | **Children.** Under-age visitors cannot consent validly; UU PDP treats children's data specially | Low | Medium | Site is B2B, marketed to businesses «ASSUMPTION: confirm no content aimed at minors»; no age gate; if a child's data is found, delete on request | Low |
| **R-V10** | **Over-retention across systems.** Umami, profile, logs, submissions, `agency_leads` (none today), mailbox, WhatsApp | High | Medium | Table in §5; purge jobs (WebDesk's submission purge runs hourly, BUILT); a retention column on `agency_leads` | Low–Medium |
| **R-V11** | **Data-subject rights across 6+ systems.** Google, Meta, Microsoft, LinkedIn, Cloudflare, Web3Forms, Umami, profile store, WebDesk, `agency_leads`, AD-1, mailbox, WhatsApp | High | Medium | Single intake address; per-system runbook (§9); extend WSK-38 and ERP commands; visitor id lookup | Medium |
| **R-V12** | **WSK-38 as built misses the main data.** Find/export/erase read `submissions` and `media_assets` only; matches by exact lower-case value; `data_subject_ref` is set only from a field named `email` (the site's ids are `email_address` and `contact_email`); phone matches only on the identical string | High | High | Extend before launch (§9.3) | Low once extended |
| **R-V13** | **WhatsApp lead alerts spread personal data.** Alert text lands in group history; the existing work-summary bot may ingest it into its store (90 days) and send it to an AI processor | Medium | Medium | Minimal alert (id + first name + link); confirm the alert group is out of the bot's ingestion scope or covered by `dpia.md`; admin deletion rule | Low |
| **R-V14** | **Vendor geo/company dataset licensing and quality.** DB-IP Lite is CC BY 4.0 (attribution required); MaxMind GeoLite2 has its own EULA, an account, update obligations and use limits; company identification data is not in either free set | Medium | Medium | Vendor review before phase 5; attribution on the privacy page; contractual use of any company dataset; record in vendor register | Low–Medium |
| **R-V15** | **Dark patterns / banner parity over time.** Later redesigns could weaken Reject | Low | High | Parity rule recorded in the repo; `check_tracking.py` already checks banner behaviour in both languages | Low |
| **R-V16** | **Past incident on the live WordPress site.** Name, message, email, phone sent to GA4 via a custom tag; ~50 unknown cross-domain linker domains; Meta and Clarity firing without consent | High (already occurred) | High | Assess as a possible incident (open item 13); remove the tags; audit GTM and Ads users; ask Google to delete the affected GA4 property data | Medium until assessed |
| **R-V17** | **Interim Web3Forms transport.** Unknown role, region, retention | Medium | Medium | Review terms; DPA if processor; retire at phase 3 | Low once retired |

### 6.1 Residual summary

Provisional overall residual risk: **Medium**. R-V1, R-V2, R-V4, R-V5 and R-V11 are the items that decide whether this can launch. On this design no residual risk is "high" that cannot be mitigated, which suggests prior consultation with the authority is not triggered. «ASSUMPTION: confirm against UU PDP and [JURISDICTION].»

### 6.2 Re-assessment triggers

Re-run when: client sites on WebDesk get the same analytics; a new vendor is added; Umami is replaced; the enrichment collector starts to keep anything beyond derived attributes; scoring is used for any decision about a person; session replay goes live; the consent rule for conversions changes.

---

## 7. Mitigations mapped to technical safeguards

| Safeguard | Risks | Status |
|---|---|---|
| Consent banner, denied by default, equal Reject / Accept, in EN and ID | R-V2, R-V15 | **BUILT** |
| Consent Mode v2 (GA4, Ads), Meta and Clarity gated on consent | R-V2, R-V4, R-V5 | **BUILT** |
| Withdrawal: footer "Cookie settings"; Meta revoked, Clarity stopped and cleared | R-V2 | **BUILT** |
| Consent re-ask after 365 days or version bump | R-V2 | **BUILT** |
| No typed values in any event; no parameter carries input | R-V7 | **BUILT** |
| No GTM; tags change in code via review | R-V8, R-V16 | **BUILT** |
| No cross-domain linker domains | R-V16 | **BUILT** |
| Attribution without consent limited to what the page knows; session first-page only with consent | R-V1, R-V7 | **BUILT** |
| `sessionStorage` for email/phone only with marketing consent, 30 minutes max, then deleted | R-V4, R-V5 | **BUILT** |
| `PUBLIC_TRACKING` modes; `off` on staging | R-V4 | **BUILT** |
| Automated tracking checks (27 checks) and one live-mode run (17 of 17) | R-V2, R-V15 | **BUILT** |
| WebDesk forms API: Turnstile, honeypot, origin guard, per-IP and per-form Redis limits, tenant RLS, consent text + version snapshot per submission, retention column and purge service | R-V8, R-V10 | **BUILT** (site not wired yet; the purge runs hourly) |
| `submissions` scrub rather than delete; append-only `dsr_requests` ledger | R-V11 | **BUILT** |
| **Privacy page `/privacy-policy/`** | R-V2, R-V5 | **PLANNED** (needed before launch; draft in §10) |
| Host CSP allowing the named vendors only | R-V8 | **PLANNED** (server change at cut-over; today's CSP blocks vendors) |
| Umami deployment, collector, read-only token, DB role | R-V6, R-V8 | **PLANNED** |
| Raw IP never persisted; test that greps logs and DB for a test IP | R-V6 | **PLANNED** |
| 14-day access-log purge | R-V10 | **PLANNED** |
| Server-side consent log | R-V3 | **PLANNED** |
| Snapshot of marketing consent on each submission and lead | R-V5, §3.6 | **PLANNED** |
| Consent-gated conversion uploader | R-V4, R-V5 | **PLANNED** |
| Profile deletion on withdrawal; visitor-id lookup | R-V1, R-V11 | **PLANNED** |
| Scrub of PAN/national IDs in the WebDesk forms path | R-V7 | **PLANNED** |
| Retention columns and purge on `agency_leads` and AD-1 | R-V10 | **PLANNED** |
| WSK-38 extension (§9.3) | R-V11, R-V12 | **PLANNED** |
| Vendor review (geo dataset, Web3Forms, Cloudflare Turnstile terms) | R-V14, R-V17 | **PLANNED** |
| Joint-controller and processor terms filed per vendor | R-V4, R-V5 | **PLANNED** |
| Minimal WhatsApp alert | R-V13 | **PLANNED** |
| Small-cell suppression in dashboards | R-V6 | **PLANNED** |
| Vendor admin settings (GA4 14 months and *Form interactions* off; Clarity cookie consent and masking; Meta domain verification) | R-V2, R-V7 | **UNVERIFIED**: `TRACKING.md` lists them as to-do in each admin |

---

## 8. RoPA entries (rows for `ropa.md`)

Format follows `ropa.md`: one block per processing activity, with the §1–§11 fields compressed. Controller, DPO and jurisdiction are [CONTROLLER ENTITY], [DPO NAME/EMAIL], [JURISDICTION].

### 8.1 Processing activities

| ID | Activity | Purpose | Data subjects | Data categories | Basis | Recipients | Transfer | Retention | Security |
|---|---|---|---|---|---|---|---|---|---|
| W1 | Cookieless site analytics (Umami) | Know which pages and sections work | Visitors | Event, page, referrer, UTM, country/city, device class | LI (`website-visitor-addendum.md` §3.2) | None external | `gda-aicenter`, region «ASSUMPTION: Singapore» | 14 months «ASSUMPTION» | TLS, DB role, no raw IP, no typed values |
| W2 | IP geo-resolution and bot check | Geography counts; bot filtering | Visitors | IP (memory only) → country/city, bot flag | LI (§3.4) | None | Same as W1 | Raw IP: none; derived: as W1 | In-memory; log hygiene |
| W3 | Security and access logs | Abuse prevention | Visitors, form users | Raw IP, user agent, URL, time | LI (§3.3) | Hosting provider «ASSUMPTION» | Host region | 14 days «ASSUMPTION» | Restricted access; no join to analytics |
| W4 | Third-party analytics and ads (GA4, Google Ads, Meta Pixel, Clarity) | Aggregate analytics, ad measurement, UX analysis | Consented visitors (and pre-consent pings to Google, see R-V2) | Online identifiers, events, IP, UA, session recordings (Clarity) | Consent (analytics, marketing) | Google, Meta, Microsoft | US and global «ASSUMPTION: DPF or SCCs; confirm» | GA4 14 months; others per account | Consent gate, CSP, no typed values |
| W5 | Visitor profile, company identification, lead scoring | Understand interests; prioritise follow-up | Consented visitors | Visitor id, interest tags, ASN/company, score | Consent (analytics) + extra notice «ASSUMPTION» | Staff (Website workspace) | `gda-aicenter` | 14 months from last visit «ASSUMPTION» | Role-gated; consent flag required; no decisions with legal effect |
| W6 | Sampled session replay (ours) | UX and conversion analysis | Consented visitors | Interaction recording, inputs masked | Consent | Staff | `gda-aicenter` | 30 days «ASSUMPTION» | Mask all inputs; no abandoned-form text |
| W7 | A/B tests on blocks | Improve conversion | Consented visitors | Variant id on visitor id | Consent | None | `gda-aicenter` | As W5 | |
| W8 | Website forms intake (interim: Web3Forms; target: WebDesk) | Receive enquiries | Leads, submitters, people named | Contact, enquiry text, attribution, consent record | LI | Web3Forms (interim), Cloudflare Turnstile, staff | `gda-aicenter`; vendors global | Submissions 90 days «ASSUMPTION»; mailbox per rule | Turnstile, rate limits, RLS, per-submission consent snapshot |
| W9 | Lead handling in `agency_leads` and AD-1 | Reply, scope, convert or decline | Leads | Contact, enquiry, business info, status | LI | Staff; WhatsApp (alert) | `gda-aicenter`; WhatsApp global | Unconverted 24 months «ASSUMPTION»; converted per client-record rule | Tenant RLS; Cerbos; scrub PAN/IDs (AD-1) |
| W10 | Server-side conversion uploads (phase 4) | Teach ad platforms which clicks became clients | Leads whose visit had marketing consent | Hashed email/phone, click ids, event id, stage, deal value | Consent (marketing), rule §3.6 | Google, Meta, LinkedIn | US and global | Platform-side | Consent-snapshot gate; WS4-gated writes («`SEARCH_ADS_WRITE_MODE`») |
| W11 | Consent records | Prove consent | Visitors, submitters | Choice, version, time | LI (accountability) | None | Browser; server log PLANNED | Data lifetime + 1 year «ASSUMPTION» | Append-only |

### 8.2 Processors and joint controllers

| Party | Role | Function | Safeguard needed |
|---|---|---|---|
| Google (GA4, Ads) | Joint controller for advertising uses; processor for GA4 measurement «ASSUMPTION: confirm» | Analytics and ads | Accept Google's terms; file them; enhanced-conversion terms |
| Meta (Pixel; CAPI) | Joint controller (Fashion ID) | Ads | Meta Business Tools Terms and controller addendum; event minimisation |
| Microsoft (Clarity) | Processor «ASSUMPTION: confirm» | Recording, heatmaps | DPA; masking setting |
| LinkedIn (CAPI, PLANNED) | «ASSUMPTION: joint controller» | Ads | Terms; consent gate |
| Cloudflare (Turnstile) | Processor «ASSUMPTION» | Bot check; receives token and IP | DPA |
| Web3Forms (interim) | «ASSUMPTION: processor, unknown terms» | Email transport | DPA or retire |
| Hosting provider(s) | Processor | Web host, access logs | DPA |
| Geo/company dataset vendor | Licensor (no personal data sent to it) | Dataset | Licence and attribution |
| WhatsApp / Meta | Transport for staff alerts (existing pack §2 "messaging transport") | Alerts | As existing pack |

### 8.3 Transfers

| Item | Detail |
|---|---|
| Trigger | Browser requests to Google, Meta, Microsoft, LinkedIn, Cloudflare, Web3Forms, and server-side uploads |
| Mechanism | «ASSUMPTION: DPF or SCCs for EU data; UU PDP cross-border basis to be confirmed per vendor» → open item 4 |
| Mitigation | Consent gate; hashed identifiers; first-party Umami as the source of truth; GA4 as destination |

---

## 9. Data-subject rights

### 9.1 How each right works, per system

| System | Identify the person by | Access / export | Erasure / objection / withdrawal |
|---|---|---|---|
| Umami (cookieless) | **Cannot be identified** (no persistent id) | Not possible to isolate a person | Not individually possible; explain in the notice; objection stops future counting only by rejecting (no cookie to refuse) «ASSUMPTION: counsel confirms this is acceptable» |
| Visitor profile (consented) | Visitor id (shown on the privacy page; PLANNED) | Export profile by id | Delete by id; **withdrawal in the banner triggers deletion** (PLANNED) |
| Session replay (ours) | Visitor id or session id | Export by id | Delete by id |
| GA4, Google Ads | Google user-deletion API with the client id | Via Google tools | Google data-deletion request; withdraw consent in banner |
| Meta | Meta account tools; CAPI event ids | Meta tools | Meta deletion tools; withdraw consent |
| Clarity | Clarity user id | Clarity tools | Clarity deletion by user id «ASSUMPTION: available; confirm» |
| LinkedIn (PLANNED) | `li_fat_id` / hashed email | LinkedIn tools | LinkedIn tools |
| Access logs | IP the person supplies | Search logs for that IP | Delete lines; expire in 14 days anyway |
| WebDesk `submissions` | Email, phone, or any value the person typed | `privacy.export` (WSK-38) | `privacy.erase` (WSK-38): scrubs payload, clears `data_subject_ref`, writes `dsr_requests` with a SHA-256 of the identifier |
| `agency_leads`, AD-1 | Email, phone, name | **Not covered by WSK-38** | **Not covered**; needs a platform-nest command |
| Mailbox (interim) | Sender address | Mailbox search | Manual delete |
| WhatsApp alerts | Lead name | Group history search | Admin deletion |
| Ad-platform conversions already sent | Event id = submission id | n/a | Request platform-side deletion where available; stop future uploads |

### 9.2 What WSK-38 covers today

- Three commands: `privacy.find`, `privacy.export` (both `webdesk:operate`), `privacy.erase` (`webdesk:promote`), all high-impact and WS4-gated; each call writes `dsr_requests` and `audit_entries`.
- Match: `data_subject_ref` (lower-case) **or** exact lower-case equality to any value in `payload.fields`. Also finds attached media assets.
- Erase: payload set to `{}`, status `erased`, `data_subject_ref` cleared; the consent record's text is kept as evidence of what notice was shown. The audit row survives with a hash of the identifier.
- It is built for the processor/controller model (tenant = client). For gaiada.com as WebDesk's own site, Gaiada is both.

### 9.3 What must be added before launch

| # | Addition | Owner area |
|---|---|---|
| 1 | Set `data_subject_ref` from the site's actual email fields (`email_address`, `contact_email`), not only a field called `email`; add a normalised phone ref (digits only, country code) | WebDesk forms |
| 2 | Match on normalised phone and on name as an optional second key | WebDesk privacy |
| 3 | A `privacy` command in platform-nest covering `agency_leads`, AD-1 submissions and tokens, with the same find / export / erase + ledger shape (erasure must not break the `converted ⇒ client` and `declined ⇒ reason` constraints; scrub the person fields, not the row) | platform-nest |
| 4 | Visitor-data erasers: Umami (events cannot be tied to a person; nothing to do), profile store, session replay, enrichment results, consent log (by consent id) | Website workspace |
| 5 | Fan-out: one request creates one `dsr_requests` row and one checklist across WebDesk, platform-nest, profile store, Google/Meta/Microsoft/LinkedIn manual steps, mailbox and WhatsApp | Governance workspace |
| 6 | Withdrawal hook: banner withdrawal calls a profile-delete endpoint | Site + collector |
| 7 | Attribution on `agency_leads` (landing page, UTMs, click ids) stored with the same retention and included in export/erase; consent snapshot columns | platform-nest |
| 8 | Retention: `retention_days` (or an expiry) on `agency_leads` and AD-1 tables; WebDesk's submission purge already runs hourly (WSK-61) | platform-nest, WebDesk |
| 9 | Suppression list: after erasure, store a hashed contact so the person is not re-imported or re-uploaded to ad platforms | ERP |

---

## 10. Visitor privacy notice (DRAFT, for `/privacy-policy/`)

> **DRAFT — not legal advice.** English text. **An Indonesian version is required** (the site and the banner are bilingual; UU PDP expects the notice in a language the person understands). Brackets are placeholders. Counsel to review every sentence.

### Summary (shown first)

**Your privacy at gaiada.com, in short.**

- We count visits on our own server, without cookies. That count does not identify you.
- We ask before we use anything that follows you. You can say **Reject all** and still use the whole site.
- If you accept **analytics**, we and Google (GA4) and Microsoft (Clarity) measure how the site is used. Clarity records how you use the page. We may also build a profile of the topics you look at and, for businesses, guess which company a visit came from.
- If you accept **marketing**, Google Ads and Meta measure our adverts. If you then contact us, we may tell Google, Meta and LinkedIn that your visit became an enquiry or a client, using scrambled (hashed) contact details.
- If you send us a form, we use what you send to reply to you.
- You can change your choice at any time: **Cookie settings** in the footer.
- Questions or requests: [DPO NAME/EMAIL].

### Full text

**1. Who we are.** [CONTROLLER ENTITY], part of the Gaiada group, [CONTROLLER ADDRESS]. Contact for privacy: [DPO NAME/EMAIL]. «ASSUMPTION: confirm entity.»

**2. What we collect and why.**

| What | Why | Our basis |
|---|---|---|
| Page views and clicks, counted on our own server without cookies; your country and city (worked out from your IP address, which we then discard); whether the visit looks like a bot | To know which pages work and to keep bots out of our numbers | Legitimate interests |
| Technical logs with your IP address, kept [14] days | To stop abuse and run rate limits | Legitimate interests |
| What you send in a form: name, email, phone/WhatsApp, business name, your message and your answers | To reply to you and prepare for a conversation | Legitimate interests, and steps you ask us to take |
| Your cookie choice | To remember and prove it | Legitimate interests |
| Analytics category: Google Analytics 4, Microsoft Clarity (records how you use pages, with typed text masked), our own visitor id, interest profile, company identification, sampled session replay, page experiments | To understand and improve the site; to follow up with the right information | Your consent |
| Marketing category: Google Ads, Meta Pixel, and, after you contact us, server-side reports to Google Ads, Meta and LinkedIn | To measure and improve our adverts | Your consent |

**3. What we never do.** We do not record what you type into a form you do not submit. We do not store your IP address in our analytics. We do not use fingerprinting to track you after you refuse. We do not follow you across other sites. We do not sell your data or share it beyond the advertising platforms named here.

**4. Consent.** You choose Reject all, Accept all, or Choose analytics and/or marketing. Reject and Accept are equal. Refusing does not limit the site. You can change your choice in **Cookie settings**. Withdrawing deletes your visitor profile on our server «PLANNED» and tells Google, Meta and Microsoft tags to stop. We ask again after 12 months or if we change what we do.

**5. Company identification and profiling.** If you accept analytics, we may work out from your network which organisation a visit may come from, and record which topics you view. We use this to see which companies and sectors are interested and to decide whom to answer first. It can be wrong. It does not lead to any decision with legal effect on you. You can object by withdrawing consent.

**6. Who receives your data.**

| Recipient | For | Where |
|---|---|---|
| Google (GA4, Google Ads) | Analytics, adverts | USA and elsewhere «ASSUMPTION» |
| Meta (Pixel, Conversions API) | Adverts | USA and elsewhere |
| Microsoft (Clarity) | Recording and heatmaps | USA and elsewhere |
| LinkedIn (Conversions API) | Adverts | USA and elsewhere |
| Cloudflare (Turnstile) | Checking that a form is sent by a person | Global |
| [Web3Forms, until forms move to our server] | Delivering your message by email | [location] |
| Our hosting provider | Running the site | [location] |
| Our staff, and our WhatsApp alert system | Handling your enquiry | [location] |

Google, Meta and LinkedIn decide for themselves how to use some of the data for their own purposes. Their privacy policies apply to that use: [links].

**7. Sending data abroad.** Several recipients are outside Indonesia, mainly in the USA. We send data to the advertising platforms only after you consent. We rely on [transfer mechanism: confirm per vendor] «ASSUMPTION».

**8. How long we keep it.**

| Data | Kept |
|---|---|
| Our cookieless counts | 14 months |
| Our visitor profile | 14 months after your last visit |
| Session replay | 30 days |
| IP in technical logs | 14 days |
| Google Analytics | 14 months |
| Form submissions on our form server | 90 days, then removed |
| Leads we have not worked with | 24 months, then deleted |
| Records of your cookie choice | While we hold the data it covers, plus 1 year |

«ASSUMPTION: every period above is a proposed default.»

**9. Your rights.** You may ask for access, correction, deletion, restriction, a copy of your data, and to object to processing based on legitimate interests or to profiling, and you may withdraw consent at any time. Write to [DPO NAME/EMAIL]. We reply within [30] days «ASSUMPTION: confirm the UU PDP time limit». To find your analytics profile, give us your visitor id (shown at [location on this page]). You can also complain to [Indonesian authority / lead EU authority] «ASSUMPTION: authority name for [JURISDICTION]».

**10. Children.** This site is for businesses and is not aimed at children. «ASSUMPTION.»

**11. Security.** We protect data with access controls, encryption in transit, and short retention. We will tell you and the authority of a breach as the law requires.

**12. Changes.** We update this page when our tracking changes and ask for your choice again.

**13. Data source notice.** IP-to-location data in our analytics comes from [DB-IP Lite (CC BY 4.0) / MaxMind GeoLite2] «ASSUMPTION: vendor not chosen; attribution text required by the licence».

---

## 11. Open items for counsel and the owner

| # | Item | Decision needed |
|---|---|---|
| 1 | **Controller entity** for gaiada.com, the Google, Meta and LinkedIn ad accounts, Umami and the lead records; whether more than one Gaiada entity is involved | Name the entity; instantiate the RoPA for it |
| 2 | **Ad platforms: joint controllers?** Fashion ID exposure for Meta Pixel and CAPI; Google enhanced conversions and offline conversions; LinkedIn CAPI. What terms to accept and what notice to give | Counsel opinion; accept and file the terms |
| 3 | **GA4 advanced vs basic Consent Mode.** Advanced sends cookieless pings to Google before consent, which conflicts with the "before consent only our own counts" ruling (R-V2). Basic means no Google contact until consent | Decide; if advanced stays, counsel to confirm the basis for pre-consent pings |
| 4 | **UU PDP cross-border transfer basis** for Google, Meta, Microsoft, LinkedIn, Cloudflare and Web3Forms (adequacy, adequate safeguards, or consent); also the EU/SG equivalent for visitors there | Per-vendor mechanism; whether banner consent also covers transfer |
| 5 | **Company identification of consented B2B visitors:** is banner consent enough, or is a separate, more specific notice or control required? Does it matter that sole traders are individuals? | Counsel opinion; possibly a separate "company identification" toggle |
| 6 | **DPO / contact:** appoint or designate; whether UU PDP requires a DPO here; publish the address | Name and email for [DPO NAME/EMAIL] |
| 7 | **Phase-4 conversion consent:** may the banner's marketing category (given earlier, on a visit) support a server-side upload at a later lead stage? Or add a separate unticked form checkbox (§3.6 option 5)? Is storing a consent snapshot on the lead enough? | Pick rule A or B |
| 8 | **Retention values** in §5, especially `agency_leads` 24 months, profile 14 months, replay 30 days, logs 14 days, submissions 90 days | Confirm or change |
| 9 | **Pre-launch gaps in the ERP:** no retention on `agency_leads` or AD-1; no consent or attribution fields on `agency_leads`; WSK-38 does not cover them (R-V10, R-V12) | Owner to schedule the work (§9.3) before phase 3 |
| 10 | **Clarity:** record sessions at all? If kept, confirm masking covers typed input and where it is stored; consider moving it behind the sampled-replay decision | Decide; confirm admin setting |
| 11 | **Interim Web3Forms:** acceptable for any real lead data? Obtain terms, region and retention; or hold launch of forms until phase 3 | Decide |
| 12 | **WhatsApp alerts:** content of the alert; whether the alert group is inside the existing bot's ingestion scope and therefore in `dpia.md` | Define; confirm scope |
| 13 | **Past incident on the live WordPress site (GTM `GTM-MC2BDNP`).** The old container scraped name, message, email and phone into GA4 parameters, sent Email and Phone in a *Leads* event, listed ~50 unrelated cross-domain linker domains (coupon sites, "adctracksystem", temu-store and similar), and loaded Meta and Clarity with no consent. Is this a personal-data incident to assess, document and possibly notify? Who had GTM and Ads access? Should the affected GA4 data be deleted? | Counsel to assess; owner to audit GTM and both Ads user lists; ask Google to delete affected data |
| 14 | **Privacy page and its Indonesian version** are blockers to launch; confirm notice content, language and the link in the banner | Counsel to review §10; translate |
| 15 | **Geo/company dataset vendor** (DB-IP Lite vs GeoLite2, and any company dataset): licence terms, attribution, whether company identification is permitted by the licence | Vendor review before phase 5 |
| 16 | **Hosting and region:** where `gda-aicenter` sits (likely asia-southeast1); where production gaiada.com is served; access-log retention at that host | Confirm; record in RoPA |
| 17 | **Roles for client sites** later offered on WebDesk analytics: processor under client contracts | Separate assessment before offering |
| 18 | **Breach notification and DPIA filing:** the UU PDP timeline and any filing duty for this processing | Counsel |
| 19 | **Second Google Ads account `AW-630595339`:** purpose unknown; remove if retired | Ads team |

---

*This is a DRAFT to accelerate legal review. It is not legal advice and must be reviewed, localized and signed off by qualified counsel in the applicable jurisdiction(s) before any visitor or lead data is collected on a live site. Citations (UU PDP articles, CJEU cases: Fashion ID C-40/17; Planet49 C-673/17 for active consent) are the drafter's pointers and must be verified by counsel.*
