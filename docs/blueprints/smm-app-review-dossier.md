# SMM Platform-App Review Dossier (OQ-1)

**Status: PLANNED** (nothing submitted; this document is the pre-submission research pack)
**Owner decision it serves:** 2026-08-13 — submit all four now: Meta (Instagram + Facebook),
LinkedIn, TikTok, YouTube.
**Gates:** *client* account connects (design §03, OQ-1). It does **not** gate the build — own-brand
accounts carry P1 without any of this.
**All web sources accessed 2026-08-13** unless noted otherwise.

> **How to read this.** Every fact here is either (a) quoted from a first-party developer doc with
> a URL, or (b) explicitly marked **UNVERIFIED**. A wrong scope string costs a rejection cycle
> measured in weeks, so gaps are left as gaps. §7 is the most important section in the file: it
> lists **19 places where this research contradicts what `smm-design.md` currently assumes**.

---

## §0 · Submit Meta first — and why

**Submit Meta (Instagram + Facebook) first.** Three reasons, in order of weight:

1. **Meta's long pole is a prerequisite, not a review.** Advanced Access requires **Business
   Verification**, and Business Verification must *complete before you can submit App Review at
   all* — it is a serial dependency with no parallel path, and Meta publishes no SLA for it
   ([Access Levels](https://developers.facebook.com/docs/graph-api/overview/access-levels),
   [community report of 10+ days
   "in review"](https://communityforums.atmeta.com/discussions/Questions_Discussions/business-verification-in-review-10-days-%E2%80%94-blocking-app-review-submission/1372323)).
   Every day it is not started is a day added to the end of the whole programme. Nothing else in
   the fleet has a blocking prerequisite of this shape.
2. **Meta is the only one of the four networks with a DM API at all.** Instagram Messaging exists
   (`instagram_business_manage_messages`); LinkedIn, TikTok and YouTube expose **no** DM surface to
   third-party developers (§7-C4). If the P2 engagement inbox is to have DMs in it, Meta is the
   only source. Approving Meta therefore unlocks strictly more product than approving any other.
3. **One submission, two networks.** Instagram and Facebook Page publishing ride the same Meta app
   and the same Business Verification. It is the highest-yield single review in the fleet.

**But do not serialise the other three behind it.** LinkedIn **Development Tier** is a form with no
verification prerequisite and should be filed the *same day* — it is free, fast, and its 12-month
clock is the thing that actually needs starting early (§7-C12). TikTok and YouTube audits both
require a **working, demonstrable integration** and are therefore correctly sequenced *after* SMM-05
/ SMM-08 land, not now.

**Recommended calendar order:**

| When | Action | Why then |
|---|---|---|
| Day 0 | Start **Meta Business Verification** | Serial blocker with no SLA; longest pole |
| Day 0 | File **LinkedIn Community Management — Development Tier** | Form only, no verification prereq, starts the 12-month integration clock |
| Verification clears | Submit **Meta App Review** (IG + FB permissions in one submission) | Cannot be submitted earlier |
| After SMM-05/08 are demoable | **LinkedIn Standard Tier** upgrade (screencast) | Requires a *fully integrated* app |
| After the Post-to-TikTok UX exists | **TikTok audit** | Audit is a UX-conformance review, not a paperwork review (§7-C8) |
| With the first video client | **YouTube audit / quota extension** | Default quota may be sufficient; audit is for *extension* (§7-C2) |

---

## §1 · Summary table

| Network | App type | Key scopes (publish / read / analytics / DM) | Verification needed | Realistic lead time | Blocking unknowns |
|---|---|---|---|---|---|
| **Instagram** | Meta app, **Business** type. Two configs: *Instagram API with Instagram Login* (`graph.instagram.com`) or *with Facebook Login* (`graph.facebook.com`) | IG-Login: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`, `instagram_business_manage_messages` · FB-Login: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_messages` (+ `pages_show_list`, `pages_read_engagement`) | **Meta Business Verification** (blocks submission) + App Review per permission + Advanced Access | **UNVERIFIED — no Meta SLA.** Third-party consensus ≈ 2–4 weeks for App Review *after* verification; verification itself days→weeks | Which config Postiz drives (IG-Login vs FB-Login) determines the whole scope list. Not yet established. |
| **Facebook Page** | Same Meta app | `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`, `pages_show_list`, `pages_read_user_content`, `read_insights`; `publish_video` for video; `pages_messaging` for DM (**UNVERIFIED — not re-confirmed against a first-party page in this pass**) | Same as Instagram (same app) | Rides the Instagram submission | `pages_read_user_engagement` appears in the Pages API doc but not in the permissions reference — **UNVERIFIED**, possibly a doc error |
| **LinkedIn** | LinkedIn developer app, **Community Management API** product, on a **verified LinkedIn Company Page** | Page posts: `w_organization_social`, `r_organization_social` · Comments/reactions: `r_organization_social_feed`, `w_organization_social_feed` · Member posts: `w_member_social`, `w_member_social_feed` · Page admin: `rw_organization_admin` · **DM: none exists** | Registered legal entity, business email verified, org website+domain verified, **app verified by a super admin of the matching LinkedIn Page**, live privacy policy | **UNVERIFIED — no LinkedIn SLA.** Two-stage: Dev Tier (form) → Standard Tier (screencast, needs a *complete* integration) | Standard-tier rate limits are **not published anywhere** — only visible in the Developer Portal after you make a call (§7-C11) |
| **TikTok** | TikTok for Developers app, **Content Posting API** + audit | Publish: `video.publish` (Direct Post) · Draft/inbox: `video.upload` · Read: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list` · **Comments: none exist** · **DM: none exists** | App approval for `video.publish` **plus a separate client audit** against the Content Sharing Guidelines; unaudited clients' posts are forced private | 5–10 business days typical, 1–2 weeks common; **each rejection adds 1–2 weeks** ([TokPortal](https://www.tokportal.com/learn/tiktok-content-posting-api-developer-guide), [PostPeer](https://www.postpeer.dev/blog/best-tiktok-posting-api) — third-party, **UNVERIFIED** against TikTok) | Whether our approve-now/publish-later model can pass a UX audit that demands live creator-info fetch + explicit consent at post time (§7-C8). **This is the single biggest open risk in the fleet.** |
| **YouTube** | Google Cloud project + OAuth client, YouTube Data API v3 (+ Analytics API) | Upload: `https://www.googleapis.com/auth/youtube.upload` · Manage: `.../auth/youtube` · Comments (read+write): `.../auth/youtube.force-ssl` · Read: `.../auth/youtube.readonly` · Analytics: `.../auth/yt-analytics.readonly`, `.../auth/yt-analytics-monetary.readonly` · **DM: none exists** | **Google OAuth app verification** (sensitive scopes) + **YouTube API Compliance Audit** if quota beyond default is needed | **UNVERIFIED — no Google SLA.** Audit doc says only "a member of YouTube's API Services team will contact you as soon as possible" | Whether default quota suffices (§7-C2) — if yes, no audit needed at all for v1 |

---

## §2 · Instagram (Meta)

### 2.1 App type and configuration fork

Meta ships **two mutually-exclusive Instagram configurations**, and they have **different scope
strings for the same capability**
([Instagram Platform overview](https://developers.facebook.com/docs/instagram-platform/overview)):

| | Instagram API **with Instagram Login** | Instagram API **with Facebook Login** |
|---|---|---|
| Host | `graph.instagram.com` | `graph.facebook.com` |
| Token | Instagram User token | Facebook User / Page token |
| Requires a linked FB Page | No | **Yes** |
| Scope prefix | `instagram_business_*` | `instagram_*` |
| Adds | — | hashtag search, product tagging, partnership ads |
| Cannot do | ads, tagging | — |

**Action required from the owner/engineering before submitting:** determine which configuration
**Postiz** actually drives. This is not a preference — it decides the entire scope list on the
submission form. Submitting the wrong prefix is a guaranteed rejection.

### 2.2 Exact scope strings

**Instagram Login configuration**
([source](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login)):

| Capability | Scope string |
|---|---|
| Basic account read | `instagram_business_basic` |
| (a) Publish a post | `instagram_business_content_publish` |
| (b) Comments + replies | `instagram_business_manage_comments` |
| (c) Insights | `instagram_business_manage_insights` |
| (d) DMs | `instagram_business_manage_messages` |

> Deprecated as of 2025-01-27 and **must not appear on a submission**: `business_basic`,
> `business_content_publish`, `business_manage_comments`, `business_manage_messages`.

**Facebook Login configuration**
([permissions reference](https://developers.facebook.com/docs/permissions),
[content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing),
[insights](https://developers.facebook.com/docs/instagram-platform/insights)):

| Capability | Scope strings | Declared dependencies |
|---|---|---|
| Basic | `instagram_basic` | `pages_read_user_content`, `pages_show_list` |
| (a) Publish | `instagram_content_publish` | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |
| (b) Comments | `instagram_manage_comments` | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |
| (c) Insights | `instagram_manage_insights` | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |
| (d) DMs | `instagram_manage_messages` | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |

If the app user holds their Page role **via Business Manager**, `ads_management` and `ads_read` are
*additionally* required for publishing and insights — a genuine landmine, because most agency
clients hold their Page role exactly that way, and those are ads permissions we otherwise have no
business asking for.

**Mentions:** the Instagram Platform doc lists "Discovering @mentions" as a capability, but the
dedicated mentions permission page 404s at
`developers.facebook.com/docs/instagram-platform/mentions`. Mentions are believed to ride
`instagram_manage_comments` / `instagram_business_manage_comments`. **UNVERIFIED — confirm before
the submission form is filled.**

### 2.3 Verification requirements

- **Business Verification is mandatory for Advanced Access** as of 2023-02-01
  ([access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)) and
  **must complete before App Review can be submitted**. Requires accurate legal entity details in
  the Business Portfolio (legal name, registered address, website, business email) plus supporting
  documents; Meta publishes no SLA and reports of multi-week reviews are common.
- **Advanced Access** is required because we serve accounts we do not own. Standard Access only
  reaches users with a *role on the app*, which covers own-brand dogfooding and nothing else.
- Per-permission App Review with a **use-case description and a screencast** for each non-default
  permission.
- Live **privacy policy URL**, **terms of service URL**, **app icon**, app in **Live** mode, and a
  reviewer-usable test path — "submissions will be rejected entirely if Meta cannot access the app
  for testing" ([App Review](https://developers.facebook.com/docs/app-review)).
- **Tech Provider verification is *not* required for IG/FB publishing** — it is a WhatsApp Business
  Solution Provider programme. Do not conflate them.

### 2.4 Quota regime (populates `social_accounts.quota` / `social_platform_apps.quota_regime`)

| Limit | Value | Source |
|---|---|---|
| **API-published posts** | **"Instagram accounts are limited to 100 API-published posts within a 24-hour moving period."** Carousels count as **one** post. | [content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing) |
| Carousel sub-limit | The same page also states "Accounts are limited to 50 published posts within a 24-hour period" in a carousel context. Relationship to the 100 figure is **UNVERIFIED**. | ibid. |
| Live counter endpoint | `GET /<IG_ID>/content_publishing_limit` — **use this, do not model the cap statically** | ibid. |
| Instagram Platform general | `Calls within 24 hours = 4800 × Number of Impressions` | [rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/) |
| Instagram messaging | 100 calls/sec (text/links), 10 calls/sec (audio/video) | ibid. |
| App-level (app token) | `Calls within one hour = 200 × Number of Users` (DAU) | ibid. |

Proposed `quota_regime` shape:

```json
{
  "igPosts24h": { "cap": 100, "window": "24h_moving", "carouselCountsAsOne": true,
                  "liveSource": "GET /{ig-id}/content_publishing_limit" },
  "igPlatformCalls24h": { "formula": "4800 * impressions" },
  "appCalls1h": { "formula": "200 * dau" }
}
```

### 2.5 Scheduling / automation blockers

- **Instagram has no native scheduling.** There is no `scheduled_publish_time` on the IG publish
  path; publishing is a two-call flow (`POST /{ig-user-id}/media` → `POST
  /{ig-user-id}/media_publish`) that fires immediately. Scheduling is entirely our (Postiz's) job.
- **Media containers expire after 24 hours.** A container cannot be built at approval time and
  published days later. The container must be created at *dispatch* time, which means the approved
  payload must still resolve to fetchable media at dispatch — directly relevant to D-6's
  one-shot-approval + `args_sha256` flow.
- Stories and Reels publishing are supported; Stories publishing is limited to **business**
  accounts (not creator).

### 2.6 Copy-ready checklist — Meta

- [ ] Confirm which Instagram configuration Postiz drives (IG-Login vs FB-Login) → freezes the scope list
- [ ] Meta Business Portfolio created under the correct legal entity, 2FA on, complete address/website/email
- [ ] **Business Verification submitted** (this is day 0 — it blocks everything downstream)
- [ ] Meta app created, type **Business**
- [ ] App icon uploaded (square, high-res)
- [ ] Privacy policy URL live and reachable
- [ ] Terms of Service URL live and reachable
- [ ] Data Deletion Instructions URL or callback configured
- [ ] App set to **Live** mode
- [ ] Own-brand IG **Business** account (not Creator, if Stories publishing is in scope) linked to an own-brand FB Page
- [ ] Advanced Access requested for each permission in the frozen list
- [ ] Screencast per permission: full OAuth flow → the exact feature the permission enables → data displayed in our UI
- [ ] Reviewer test path: credentials or a public demo route that does not require our SSO
- [ ] Verified redirect URI on the edge-allowlisted Postiz callback path (design D-11)
- [ ] Diarise the annual **Data Use Checkup** (→ `social_platform_apps.expires_at`)

### 2.7 What we still need from the owner — Meta

1. **Which legal entity** submits (Gaiada legal name, registered address, business email domain) and
   who holds Business Portfolio admin.
2. **Verification documents** for that entity (incorporation certificate / utility bill / bank
   statement — exact accepted list is in Meta's Business Help Center, **UNVERIFIED here**).
3. A decision on **whether we ask for `instagram_manage_messages` in wave 1**. It is the most
   scrutinised of the set and its rejection would delay the publishing permissions that ship with
   it in the same submission. Consider splitting DMs into a second submission.
4. Sign-off that the **privacy policy** covers third-party social data processing on behalf of
   clients (overlaps OQ-3 / counsel).

---

## §3 · Facebook Pages (same Meta app)

### 3.1 Scopes

From the [permissions reference](https://developers.facebook.com/docs/permissions) and the
[Pages API posts doc](https://developers.facebook.com/docs/pages-api/posts):

| Capability | Scope strings |
|---|---|
| (a) Publish / manage posts | `pages_manage_posts` (deps: `pages_read_engagement`, `pages_show_list`) |
| (a) Publish video | `publish_video` |
| (b) Read comments / user content | `pages_read_user_content`, `pages_read_engagement` |
| (b) Reply/moderate comments | `pages_manage_engagement` (deps: `pages_read_user_content`, `pages_show_list`) |
| (c) Page insights | `read_insights` (deps: `pages_read_engagement`, `pages_show_list`) |
| List manageable Pages | `pages_show_list` |
| Manage assets on behalf of others | `business_management` — **explicitly flagged as requiring Business Verification for Advanced Access** |
| (d) Page DMs (Messenger) | `pages_messaging` — **UNVERIFIED in this pass**; not re-confirmed against a first-party page |

> **Doc discrepancy:** the Pages API posts page lists `pages_read_user_engagement`, a string that
> does **not** appear in the permissions reference. Treat as **UNVERIFIED / probable doc error** and
> do **not** put it on a submission form.

### 3.2 Scheduling — the one network that schedules natively

Facebook Pages **do** support server-side scheduling: `published=false` plus
`scheduled_publish_time`, accepting Unix seconds / ISO 8601 / `strtotime` strings.

> **"The publish date must be between 10 minutes and 30 days from the time of the API request."**

Our calendar must therefore refuse a Facebook variant scheduled **more than 30 days out or less
than 10 minutes out** — a validator rule that does not currently exist in the SMM-08 spec.

### 3.3 Checklist — Facebook Pages

- [ ] Rides the Meta checklist in §2.6 — same app, same verification, same submission
- [ ] Own-brand Facebook **Page** available for the screencast
- [ ] Screencast additionally demonstrates: publishing to a Page, a comment on that post surfacing in our inbox, and Page insights rendering
- [ ] Confirm `pages_messaging` string and whether Messenger DMs are in v1 scope at all
- [ ] Add the 10-minute / 30-day scheduling window to the composer validator (SMM-08)

### 3.4 What we still need from the owner — Facebook

1. Whether **Facebook Page DMs (Messenger)** are in the v1 inbox at all, or whether the inbox is
   Instagram-DM-only. This changes the permission list and the screencast.
2. An own-brand Page with real content for the reviewer to see (an empty Page reads as a shell app
   and is a known rejection driver).

---

## §4 · LinkedIn

### 4.1 App type and access tiers

Product: **Community Management API**, a *vetted* product with two tiers
([overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-07),
[app review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-07),
[migration guide](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide?view=li-lms-2026-07)).

| | **Development Tier** | **Standard Tier** |
|---|---|---|
| How | Access-request form | Second form + screencast, after full integration |
| Limits | **500 API calls/app/24h**, **100 calls/member/24h**; **no BATCH_GET**; **social-action webhooks disabled** | No stated restrictions; all features enabled |
| Duration | **"During the Development Tier or 12 months max"** | — |
| Rejection consequence | **You cannot re-apply with the same app. You must create a new app and start over.** | Same — rejection sends you back to a *new* Dev Tier application |

The webhook restriction matters: the design's engagement inbox and the `social.inbox.*` events lean
on push notifications for social actions, which **Dev Tier does not deliver**. Dev Tier can only be
polled.

### 4.2 Exact scope strings

| Capability | Scope string(s) | Note |
|---|---|---|
| (a) Publish to an organization page | `w_organization_social` | Posts API |
| Read organization posts | `r_organization_social` | Posts API |
| (a) Publish as a member | `w_member_social` | Posts API |
| (b) **Read** comments / reactions / socialMetadata | **`r_organization_social_feed`** | **Replaced `r_organization_social` for these endpoints in June 2023** |
| (b) **Write** comments / reactions | **`w_organization_social_feed`** | Replaced `w_organization_social` for these endpoints |
| (b) Member-side comments / reactions | `w_member_social_feed` | Replaced `w_member_social` for these endpoints |
| Read member feed | `r_member_social` | **CLOSED — "We're not accepting access requests at this time due to resource constraints."** |
| Page admin / access control / brands | `rw_organization_admin` | |
| (c) Analytics (follower/page/share/video stats) | Covered by `r_organization_social` + `w_organization_social` per the migration guide's Content Analysis row | Exact per-endpoint mapping **UNVERIFIED** |
| (d) **DMs** | **None. LinkedIn exposes no public messaging API.** | See §7-C4 |

The `*_social_feed` split is the single most rejection-prone detail on LinkedIn: a submission that
lists only `r_organization_social` will be approved and then **fail at runtime** on every
comment-read call.

### 4.3 Verification requirements

Directly from the app-review doc:

- "Our Community Management APIs are only available to **registered legal organizations for
  commercial use cases only**."
- Business email address — **verified**, and "**personal email addresses won't pass the vetting
  process**."
- Organization **legal name, registered address, website, privacy policy**.
- Verified organization **website and domain address**.
- "Ensure a **super admin of the LinkedIn Page** associated with your organization has verified your
  application." (LinkedIn Page ↔ developer app association.)
- "Ensure that your application doesn't include any portion of the **LinkedIn or Microsoft names or
  logos** (e.g. Linked or In)." — *check the Postiz-facing app name and our console branding.*
- Standard Tier additionally: valid privacy policy, compliance with the **data storage
  requirements**, test credentials, and a screencast.

**Screencast requirements** (Standard Tier): high resolution, downloadable, **under 5 minutes**,
only our app's windows on screen, narration recommended. For the *Page Management* use case it must
show: full OAuth consent → a user posting to a LinkedIn Page via our app → a member's comment on
that post displayed in our app → **exactly which personal-data fields from the commenter's profile
we display** → any other core functionality touching member personal data. For *Page Analytics*: how
post performance is displayed and which commenter personal-data fields surface.

### 4.4 Quota regime

| Tier | Limit |
|---|---|
| Development | 500 calls/app/24h; 100 calls/member/24h; resets midnight UTC |
| Standard | **Not published.** "Standard rate limits are not published in documentation." Visible only in the Developer Portal → app → **Analytics** tab, and **only for endpoints you have already called at least once today (UTC)**. |

Alerting: Developer Admins get email at **75%** of an application-level quota, delayed ~1–2 hours,
**application-level breaches only** — no member-level alerts
([rate limits](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits?view=li-lms-2026-07)).

Consequence for us: `quota_regime` for LinkedIn **cannot be populated from documentation**. It must
be filled from the Developer Portal after approval, per endpoint, by making one probe call each.
Model it as a discovered value with a `source: "portal"` marker, not a constant.

### 4.5 Scheduling / automation blockers

- No documented native scheduling on the Posts API — **UNVERIFIED**, but no `scheduled_publish_time`
  equivalent surfaced in this pass. Assume our layer schedules.
- Dev Tier's **disabled social-action webhooks** mean the inbox must poll until Standard Tier.
- Dev Tier's **500 calls/app/day is a fleet-wide ceiling, not per client** — with polling, a handful
  of client pages exhausts it. Do not plan multi-client LinkedIn on Dev Tier.

### 4.6 Copy-ready checklist — LinkedIn

- [ ] Gaiada **LinkedIn Company Page** exists, is complete, and we control a **super admin** on it
- [ ] Organization website + domain match the entity and resolve over HTTPS
- [ ] **Business email on the company domain** (not gmail/personal) for the developer account
- [ ] Privacy policy URL live
- [ ] Create a **brand-new developer app** with **no other API products on it** (the Community Management request is greyed out otherwise)
- [ ] App name and logo contain **no** "Linked"/"In"/Microsoft marks
- [ ] Super admin **verifies the app against the Company Page**
- [ ] Read the [Marketing API Terms](https://www.linkedin.com/legal/l/marketing-api-terms) and the [restricted use cases](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases) list before writing the use case
- [ ] File **Development Tier** access request — declare the use cases (Page Management, Page Analytics; note whether Brand Engagement / Employee Advocacy are claimed)
- [ ] Record the **12-month Dev Tier expiry** into `social_platform_apps.expires_at` on approval
- [ ] Build the full integration, then record the **<5 min** Standard Tier screencast per §4.3
- [ ] File **Standard Tier** upgrade
- [ ] After approval: probe each endpoint once, read the Analytics tab, populate `quota_regime`

### 4.7 What we still need from the owner — LinkedIn

1. Confirmation that Gaiada is a **registered legal organization** with the page/domain/email triad
   aligned, and who the LinkedIn Page super admin is.
2. Which **use cases** we claim. Claiming Employee Advocacy or Executive Management widens the
   screencast obligations substantially; claiming only Page Management + Page Analytics is the
   narrow, faster path.
3. Acceptance that a rejection **burns the app** — client_id churn is guaranteed on any rejection,
   so `credential_ref` must be treated as replaceable, not stable.

---

## §5 · TikTok

### 5.1 App type and the two posting modes

TikTok for Developers app with the **Content Posting API** product
([get started](https://developers.tiktok.com/doc/content-posting-api-get-started/),
[direct post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/),
[scopes](https://developers.tiktok.com/doc/tiktok-api-scopes/),
[content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/)).

| Mode | Scope | What it does |
|---|---|---|
| **Direct Post** | `video.publish` — *"Directly post content to a user's TikTok profile"* | Publishes to the profile. **Unaudited clients: forced private.** |
| **Upload / inbox (draft)** | `video.upload` — *"Share content to creator's account as a draft to further edit and post in TikTok"* | Lands in the creator's TikTok inbox; **a human finishes the post inside the TikTok app** |

> **"All content posted by unaudited clients will be restricted to private viewing mode."** The
> error code is `unaudited_client_can_only_post_to_private_accounts`.

Our validator's existing "direct-post vs inbox" warning is **correct and load-bearing** — this is
the one design assumption in the whole dossier that research fully confirms.

### 5.2 Exact scope strings

| Capability | Scope |
|---|---|
| (a) Publish (direct) | `video.publish` |
| (a) Publish (draft/inbox) | `video.upload` |
| (c) Account stats | `user.info.stats` (likes, followers, following, video counts) |
| (c) Profile | `user.info.basic`, `user.info.profile` |
| (c) Post list / metrics | `video.list` — *"Read a user's public videos on TikTok"* |
| (b) **Comments** | **No scope exists.** `comment.list` / `comment.create` do **not** appear in TikTok's scopes documentation. The only comment control is the `allow_comment` boolean at post time. Read-only comment listing exists **only** in the Research API (`POST /v2/research/video/comment/list/`), restricted to academic researchers at approved institutions. |
| (d) **DMs** | **No messaging API.** The only DM-adjacent scopes are data-portability exports: `portability.directmessages.single` / `.ongoing` — a GDPR data-export surface, not an inbox. |

### 5.3 Audit requirements — what the audit actually checks

The audit is a **UX-conformance review of our posting screen**, not a paperwork review. Per the
Content Sharing Guidelines, the app must:

1. **Fetch creator info at render time** — *"retrieve the latest creator info when rendering the
   Post to TikTok page"*, displaying nickname and honouring the API-returned max post duration.
2. **Manual metadata control** — title, privacy status chosen from API-returned options **with no
   default pre-selected**, and interaction toggles (comment/duet/stitch) **unchecked by default**.
3. **Commercial content disclosure** — "Your brand" and "Branded content" toggles with the
   corresponding labelling warnings; branded content restricted to public/friends visibility.
4. **Legal declarations** — a Music Usage Confirmation agreement; Branded Content Policy agreement
   where applicable.
5. **User awareness and control** — content preview, **explicit consent immediately before upload**,
   and status polling so the user sees processing progress.
6. Technical: never embed the client secret; `PULL_FROM_URL` for server-stored media, `FILE_UPLOAD`
   only for device files; **no watermarks**.

Known rejection drivers: content copied from other platforms, functionality limited to internal
teams, promotional watermarks, missing UX controls.

### 5.4 Quota regime

| Limit | Value | Source |
|---|---|---|
| Direct Post | **"Each user access_token is limited to 6 requests per minute."** | [direct post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/) |
| Daily post cap | **UNVERIFIED** — no daily cap surfaced in this pass | — |
| Video constraints | MP4 / H.264; max **300 s** duration; photo posts require **verified domain URLs** | [get started](https://developers.tiktok.com/doc/content-posting-api-get-started/) |

```json
{ "tiktokDirectPostPerMin": { "cap": 6, "per": "user_access_token" },
  "tiktokMaxVideoSeconds": 300,
  "tiktokDailyCap": "UNVERIFIED" }
```

### 5.5 Scheduling / automation blockers — read this before promising TikTok

- **No native scheduling.** TikTok's Content Posting API accepts no future timestamp; a scheduler
  must be an external job queue that fires the upload flow at the target time.
- **The audit UX guidelines are in tension with headless scheduled publishing.** Creator info must
  be fetched *when the posting page renders*; privacy status must be *selected by the user with no
  default*; consent must be *explicit and immediately before upload*. Our model is: a human approves
  at T, a queue publishes at T+hours with no human present. Whether that passes audit is **not
  answerable from the documentation** — but it is the risk that would invalidate TikTok
  direct-posting for us entirely. **UNVERIFIED, and the highest-value question in this dossier.**
- **Mitigation if direct post fails audit:** ship TikTok as `video.upload` **inbox mode only** —
  the client finishes the post in the TikTok app. That is a materially different product promise and
  must be said to clients up front, not discovered later.
- Photo posts require **domain-verified** media URLs — our media host must be verified with TikTok.

### 5.6 Copy-ready checklist — TikTok

- [ ] TikTok for Developers account under the Gaiada entity
- [ ] App created; privacy policy + terms URLs live
- [ ] **Media host domain verified with TikTok** (required for `PULL_FROM_URL` photo posts)
- [ ] Build a genuine **"Post to TikTok" screen** meeting all five UX requirements in §5.3 — this is a build item, not paperwork (feed it into SMM-08/SMM-12 as an explicit requirement)
- [ ] `video.publish` scope requested and approved
- [ ] Integration tested end-to-end in the forced-private state
- [ ] Submit for **client audit**; expect 1–2 weeks, and 1–2 more per resubmission
- [ ] **Decision recorded:** if direct post is refused, do we ship TikTok inbox-only or not at all?
- [ ] Set `social_accounts.capabilities` for TikTok to `{"comments": false, "dm": false}` — not "not yet", but "never"

### 5.7 What we still need from the owner — TikTok

1. **A ruling on the scheduled-publish tension (§5.5).** Options: (a) submit direct-post and accept
   the audit risk; (b) build a "publish now, human present" TikTok path that conforms exactly; (c)
   ship inbox-mode only. This decision changes the SMM-08/SMM-12 build.
2. Acceptance that **TikTok has no comment and no DM API** — the P2 engagement inbox will show
   nothing for TikTok. That must be in the client-facing service description.
3. Which domain hosts our media, for TikTok domain verification.

---

## §6 · YouTube

### 6.1 App type

Google Cloud project + OAuth 2.0 client, YouTube Data API v3 enabled (+ YouTube Analytics API for
metrics). Two independent gates: **Google OAuth app verification** (because YouTube scopes are
sensitive) and the **YouTube API Compliance Audit** (only if quota beyond default is needed).

### 6.2 Exact scope strings

From [Data API auth](https://developers.google.com/youtube/v3/guides/auth/installed-apps) and
[Analytics API reference](https://developers.google.com/youtube/analytics/reference):

| Capability | Scope |
|---|---|
| (a) Upload a video | `https://www.googleapis.com/auth/youtube.upload` |
| Manage account | `https://www.googleapis.com/auth/youtube` |
| (b) Comments — see, edit, delete | `https://www.googleapis.com/auth/youtube.force-ssl` |
| Read-only | `https://www.googleapis.com/auth/youtube.readonly` |
| (c) Analytics | `https://www.googleapis.com/auth/yt-analytics.readonly` |
| (c) Monetary analytics | `https://www.googleapis.com/auth/yt-analytics-monetary.readonly` |
| Channel memberships | `https://www.googleapis.com/auth/youtube.channel-memberships.creator` |
| Partner / CMS | `https://www.googleapis.com/auth/youtubepartner` |
| (d) **DMs** | **None. YouTube has no messaging API.** |

**Mentions:** no first-party mentions endpoint. Discovery would go through `search.list`, which sits
in a **100-calls/day bucket** (§6.4) — effectively unusable for per-client mention monitoring.
**UNVERIFIED** whether any cheaper mention surface exists.

### 6.3 Verification requirements

- **Google OAuth app verification.** *"Apps that request access to scopes categorized as sensitive
  or restricted must complete Google's OAuth app verification"*
  ([source](https://support.google.com/cloud/answer/13463073)). YouTube Data API scopes are believed
  **sensitive** (not restricted — i.e. no third-party CASA security assessment). **UNVERIFIED** —
  confirm on the OAuth consent screen, which labels each scope, before assuming no CASA.
- Verification generally needs: verified domain ownership, an app homepage on that domain, a live
  privacy policy on that domain, an app icon, and a **demo video** showing the OAuth consent screen
  and each sensitive scope in use.
- **YouTube API Compliance Audit** — *"If you would like to request additional quota beyond the
  default allocation, you must first complete an audit to show that your project is in compliance"*
  ([quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)).
  Submitted via the [Audit and Quota Extension
  Form](https://support.google.com/youtube/contact/yt_api_form). The doc references *"completed an
  API Compliance Audit within the last 12 months"* — treat the audit as having a **12-month
  validity** (→ `expires_at`). No timeline is stated beyond *"a member of YouTube's API Services
  team will contact you as soon as possible."*
- **Unverified API clients get their uploads locked down.** Community reports describe videos
  uploaded by a third-party tool that failed verification being set to limited access
  ([youtubeuploader#86](https://github.com/porjo/youtubeuploader/issues/86)). Not restated in the
  current first-party docs in this pass — **UNVERIFIED but plan for it**: it is the YouTube analogue
  of TikTok's unaudited-client private lock, and our design only warns about TikTok.

### 6.4 Quota regime — this is not the model we had

Quoted verbatim from [getting started](https://developers.google.com/youtube/v3/getting-started):

> *"Projects that enable the YouTube Data API have a default quota allocation of **100 `search.list`
> calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints**."*

> *"A read operation that retrieves a list of resources ... usually costs 1 unit."*
> *"A write operation that creates, updates, or deletes a resource usually costs 50 units."*
> *"A search query costs 1 unit."* · *"A video upload costs 1 unit."*

Per-method costs from [determine quota cost](https://developers.google.com/youtube/v3/determine_quota_cost):
`videos.list` 1 · `commentThreads.list` 1 · `channels.list` 1 · `comments.insert` 50 ·
`playlistItems.insert` 50 · caption updates 450.

Proposed `quota_regime`:

```json
{
  "ytSearchCallsPerDay":  { "cap": 100 },
  "ytVideoInsertsPerDay": { "cap": 100 },
  "ytUnitsPerDay":        { "cap": 10000, "scope": "all_other_endpoints" },
  "ytCosts": { "videos.list": 1, "commentThreads.list": 1, "channels.list": 1,
               "comments.insert": 50, "playlistItems.insert": 50, "captions.update": 450 }
}
```

This is **three independent buckets**, not one pool. See §7-C2.

### 6.5 Scheduling / automation blockers

- YouTube **does** support scheduled publishing natively (`status.publishAt` with
  `privacyStatus: private`) — **UNVERIFIED in this pass**, not re-confirmed against a first-party
  page. Confirm before relying on it.
- The binding constraint for us is **100 video uploads/day across the entire fleet**, not per
  client. Fine for v1; a hard ceiling if video volume grows.
- `comments.insert` at 50 units means ~200 comment replies/day maximum against the 10,000-unit
  bucket, before any other read traffic. Reply-heavy engagement work will hit the unit pool first.

### 6.6 Copy-ready checklist — YouTube

- [ ] Google Cloud project under a Gaiada Workspace account (not a personal Google account)
- [ ] YouTube Data API v3 + YouTube Analytics API enabled
- [ ] OAuth consent screen configured: app name, logo, support email, **authorised domain**
- [ ] **Domain ownership verified** in Google Search Console for the app homepage + privacy policy domain
- [ ] App homepage and privacy policy live on that domain
- [ ] Read the scope-sensitivity labels on the consent screen; confirm **sensitive, not restricted** (restricted would add a third-party security assessment and months)
- [ ] Demo video: OAuth consent screen → each sensitive scope in use
- [ ] Submit for **Google OAuth verification**
- [ ] Measure actual unit consumption against the three buckets on own-brand accounts
- [ ] Only if a bucket is exceeded: file the **Audit and Quota Extension Form**; record the 12-month validity into `expires_at`
- [ ] Verify the "unverified client uploads are limited" behaviour on an own-brand channel **before** any client connects

### 6.7 What we still need from the owner — YouTube

1. Which **Google Workspace account / Cloud org** owns the project, and which domain we verify.
2. Whether YouTube is in v1 at all — the design's own OQ-1 default was *"YouTube quota request with
   the first video client."* Nothing in this research contradicts deferring the **audit**; the
   **OAuth verification** should still be started, since it is required for any external user.
3. Acceptance that YouTube contributes **no DM and no mention monitoring** to the inbox.

---

## §7 · Where this research CONTRADICTS the design

The most valuable section. Each item names the exact place in our documents that is wrong or
under-specified.

### C1 · Instagram is **100** posts/24h, not ~25 — *design is wrong by 4×*

Meta: *"Instagram accounts are limited to **100** API-published posts within a 24-hour moving
period."* Carousels count as one.
([content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing))

Contradicts:
- `smm-design.md` §00 item 2 — "IG ~25 posts/24h"
- §08 console spec — "per-network quota strips (IG n/25·24h …)"
- §12 SMM-08 — "quota pre-check (IG 25/24h counter …)"
- `0105_module_social.sql` line ~80 comment — `{"igPosts24h":25}`

The 25 figure is a stale third-party number still circulating on blogs
([Postproxy](https://postproxy.dev/blog/post-to-instagram-via-api/)). **Fix:** the cap should not be
hardcoded at all — Meta exposes `GET /{ig-id}/content_publishing_limit`, so the composer should
read the live counter and treat any static number as a fallback. That is a better design than either
25 or 100.

*Also unresolved:* the same Meta page carries a second sentence, *"Accounts are limited to 50
published posts within a 24-hour period,"* in a carousel context. The relationship between 100 and
50 is **UNVERIFIED**. One more reason to read the live endpoint.

### C2 · YouTube's quota model changed shape — our `{"youtubeUnitsToday":1600}` example is wrong

The design's `social_accounts.quota` example models YouTube as a single 10,000-unit pool with
expensive uploads (the classic 1,600-units-per-upload regime). Current docs describe **three
separate daily buckets**: 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units for
everything else — with `search.list` and `videos.insert` each costing **1 unit**.

Contradicts: `smm-design.md` §04 `social_accounts.quota` example `{"youtubeUnitsToday":1600}`, and
the same string in `0105_module_social.sql`.

Practical effect: the binding YouTube constraint is **call counts in two small buckets**, not unit
spend. A quota model that only tracks units will report "plenty of headroom" while uploads are
already blocked.

### C3 · TikTok has **no comments API at all**

Not "thin", not "behind approval" — absent. No `comment.list`, no `comment.create` in
[TikTok's scopes doc](https://developers.tiktok.com/doc/tiktok-api-scopes/). The only lever is
`allow_comment` at post time (all-or-nothing). Comment *reading* exists only in the Research API for
credentialed academics.

Contradicts: §04's `capabilities` example `{"comments":true, …}` as a per-network resolvable, the P2
engagement inbox scope, and OQ-4's framing that only *DMs* might be thin.

### C4 · Only **one** of our four networks has a DM API

| Network | DM API |
|---|---|
| Instagram | **Yes** — `instagram_business_manage_messages` / `instagram_manage_messages` |
| Facebook Messenger | Probably (`pages_messaging`) — **UNVERIFIED** |
| LinkedIn | **No** public messaging API |
| TikTok | **No** — only GDPR `portability.directmessages.*` exports |
| YouTube | **No** |

Contradicts: OQ-4's default, *"Comments+mentions v1; DMs where Postiz supports them; revisit per
network."* The blocker is **not Postiz** — it is that three of four networks have nothing to
support. Re-frame OQ-4: DMs are a **Meta-only feature** by construction, and no amount of publisher
work changes that. And on TikTok the fallback ("comments+mentions") is *also* empty (C3), so TikTok
contributes **zero** inbox surface.

### C5 · TikTok's audit UX rules may be incompatible with our approve-then-queue publishing model

The Content Sharing Guidelines require creator info fetched *at render time*, privacy status
selected by the user *with no default*, and explicit consent *immediately before upload*. Our model
is a human approving at T and a queue publishing at T+hours, unattended.

Contradicts: the design frames TikTok as "no-native-scheduling" and "direct-vs-inbox" — a *plumbing*
problem. It is potentially a **compliance** problem with our core WS4 approve-then-execute spine
(D-6, D-14). Whether an audit accepts a prior-consent-plus-queue flow is **UNVERIFIED**. This is the
one finding that could force a product-level change rather than a code change.

### C6 · Instagram has no native scheduling **and** its media containers expire in 24 hours

We knew IG doesn't schedule. We did not model the **24-hour container expiry**: a container cannot
be built at approval time and published later. Combined with D-6's one-shot approval + `args_sha256`
match, this means the *approved payload* must still resolve to fetchable media at dispatch time, and
container creation must happen inside the dispatch choke-point, not at approval.

Contradicts: nothing stated, but §11's dispatch-choke-point description does not account for a
two-call, time-bounded publish primitive.

### C7 · Facebook Pages **do** schedule natively, with a hard 10-minute / 30-day window

*"The publish date must be between 10 minutes and 30 days from the time of the API request."*
Our calendar has no such bound. A post scheduled 45 days out will be accepted by our composer and
rejected by Facebook — precisely the failure mode D-12 exists to prevent.

Contradicts: D-12 ("we never rely on Postiz or the network to reject") is not currently satisfied
for Facebook; add the window to SMM-08's validator.

### C8 · Meta Business Verification **blocks** App Review submission

It is a serial prerequisite, not a parallel workstream. Any plan that says "submit Meta now" is
really "start verification now, submit in N weeks."

Contradicts: §A5's "OQ-1 platform-app review submissions … starting now" implies submissions can
start immediately. For Meta, only *verification* can start immediately.

### C9 · LinkedIn comment/reaction reading needs `*_social_feed` scopes, not `r_organization_social`

Since June 2023, `/socialActions/comments`, `/socialActions/likes`, `/reactions`, `/socialMetadata`
require `r_organization_social_feed` / `w_organization_social_feed` / `w_member_social_feed`. A
submission listing only `r_organization_social` / `w_organization_social` will be **approved and then
fail at runtime** on every comment call.

Contradicts: nothing in our docs (we never enumerated LinkedIn scopes) — this is a gap that would
have become a rejection or, worse, a silent post-approval failure.

### C10 · `r_member_social` is **closed** — LinkedIn member-feed reading is unavailable at any price

*"`r_member_social` is a closed permission. We're not accepting access requests at this time due to
resource constraints."* Any executive-personal-profile monitoring is off the table.

### C11 · LinkedIn Standard-tier rate limits are **not published** — `quota_regime` cannot be seeded

*"Standard rate limits are not published in documentation."* They appear only in the Developer
Portal's per-app Analytics tab, and only for endpoints already called today.

Contradicts: `social_platform_apps.quota_regime jsonb` is described as "documented caps". For
LinkedIn there are no documented caps. The column needs a provenance marker
(`"source": "portal_discovered"` vs `"source": "docs"`) or it will silently contain fiction.

### C12 · LinkedIn Dev Tier expires in 12 months, and rejection **burns the app**

*"During the Development Tier or 12 months max."* And: *"If your application is rejected … create a
new app and submit a new Development tier access request form. You won't be able to re-apply … with
your existing app."*

Contradicts: the implicit assumption that `credential_ref` and a network's client_id are stable
identifiers. On LinkedIn, a rejection **guarantees** a new client_id and a full OpenBao alias
rotation. `expires_at` is doing real work here — it should be populated with the Dev Tier deadline
on approval day.

### C13 · LinkedIn Dev Tier disables social-action webhooks

Push notifications for social actions are off during Dev Tier. Our inbox must poll — against a
**500 calls/app/day** ceiling shared across every client. Multi-client LinkedIn engagement is not
viable before Standard Tier.

Contradicts: §10's `smm-*` polling/notification flows implicitly assume a usable event stream.

### C14 · YouTube likely has TikTok's unaudited-lock problem too

Uploads from unverified/unaudited API clients being limited to private is reported for YouTube, not
just TikTok. **UNVERIFIED** against a current first-party doc, but plan for it.

Contradicts: §08's quota strip design calls out a "TikTok inbox-mode badge" as the only
degraded-publishing state. YouTube may need the same badge.

### C15 · `access_tier` is a fleet-wide concept, not a LinkedIn quirk

Every network in the fleet has a tier: Meta **Standard vs Advanced Access**, TikTok **unaudited vs
audited**, YouTube **default-quota vs audited**, LinkedIn **Development vs Standard**.

Contradicts: `0105_module_social.sql` line ~78 comments `access_tier` as *"e.g. LinkedIn Dev vs
Standard"*, which reads as a LinkedIn-specific escape hatch. It is the primary axis on all four.
No schema change needed — but the console must render it for every network, and
`review_status='approved'` is **meaningless without `access_tier`** (approved-at-Dev-Tier is not
approved-for-clients).

### C16 · `review_status` has no state for "verification pending, cannot yet submit"

Meta's blocking Business Verification, Google's OAuth verification, and LinkedIn's page-verification
prerequisite all occupy weeks *before* `'submitted'` is even possible. The enum
`('sandbox','submitted','approved','rejected','suspended')` maps that whole period to `'sandbox'`,
which the console will render as "we haven't started" when in fact the longest pole is already
running.

Recommendation: no enum change (migrations are shipped) — carry it in `review_notes` with a
convention, or in `quota_regime`-adjacent JSON. Flagging it so the console copy doesn't lie.

### C17 · The IG scope prefix depends on a configuration choice nobody has made

`instagram_business_*` (Instagram Login) vs `instagram_*` (Facebook Login) are different strings for
the same capabilities, and the choice is forced by which flow **Postiz** implements. Nothing in our
docs records which. Submitting the wrong set is a guaranteed rejection cycle.

### C18 · `ads_management` / `ads_read` may be forced onto us by client Page topology

Meta: if the app user holds their Page role **via Business Manager** — the normal agency case —
publishing and insights *additionally* require `ads_management` and `ads_read`. That drags ads
permissions into a design whose §01 explicitly scopes paid ads **out**, and ads permissions attract
heavier review.

Contradicts: §01 non-goals ("paid ads OUT") vs the permission set we may be compelled to request.
Worth an explicit owner decision.

### C19 · TikTok photo posts require a **domain-verified** media host

`PULL_FROM_URL` photo posting requires verified domain URLs. Our media origin must be registered and
verified with TikTok — an infra task nobody has been assigned, and one that interacts with the
edge-allowlist doctrine (D-11).

---

## §8 · Mapping onto `social_platform_apps`

One row per network. Suggested initial values (all `review_status='sandbox'` until anything is
filed):

| Column | instagram | facebook | linkedin | tiktok | youtube |
|---|---|---|---|---|---|
| `app_name` | Gaiada Social (Meta) | *same app* | Gaiada Community Mgmt | Gaiada Publisher | Gaiada YouTube |
| `review_status` | `sandbox` | `sandbox` | `sandbox` | `sandbox` | `sandbox` |
| `access_tier` | `standard_access` → `advanced_access` | ditto | `development` → `standard` | `unaudited` → `audited` | `default_quota` → `audited` |
| `scopes` | §2.2 list, **prefix TBD (C17)** | §3.1 list | §4.2 list incl. `*_social_feed` | §5.2 list | §6.2 list |
| `quota_regime` | §2.4 JSON | shares Meta limits | `{"source":"portal_discovered"}` (C11) | §5.4 JSON | §6.4 JSON |
| `credential_ref` | OpenBao alias | *same* | alias — **expect rotation on rejection (C12)** | alias | alias |
| `expires_at` | annual Data Use Checkup | ditto | **Dev Tier +12 months** | — | **audit +12 months** |
| `review_notes` | verification-blocked state (C16) | — | claimed use cases | direct-post vs inbox ruling | scope sensitivity finding |

Corresponding `social_accounts.capabilities` truths (not aspirations):

```json
{ "instagram": {"schedule": false, "directPost": true,  "stories": true,  "comments": true,  "dm": true,  "analytics": true },
  "facebook":  {"schedule": true,  "directPost": true,  "stories": false, "comments": true,  "dm": "UNVERIFIED", "analytics": true },
  "linkedin":  {"schedule": false, "directPost": true,  "stories": false, "comments": true,  "dm": false, "analytics": true },
  "tiktok":    {"schedule": false, "directPost": "audit-gated", "stories": false, "comments": false, "dm": false, "analytics": true },
  "youtube":   {"schedule": "UNVERIFIED", "directPost": true, "stories": false, "comments": true, "dm": false, "analytics": true } }
```

`schedule: false` means *the network has no native scheduling* — our layer does it. It is not a
capability gap; it is a statement about who owns the clock.

---

## §9 · Open items to close before any submission

1. **C17** — which Instagram configuration does Postiz drive? Freezes the Meta scope list. *(SMM-04
   containment spike can answer this.)*
2. **C5** — the TikTok scheduled-publish/audit tension. Needs an owner ruling and possibly a
   pre-submission question to TikTok developer support.
3. **C18** — do we accept requesting `ads_management`/`ads_read` for Meta despite paid ads being out
   of scope?
4. Meta's accepted **business verification document list** (Business Help Center) — **UNVERIFIED**.
5. `pages_messaging` string and Messenger DM scope — **UNVERIFIED**.
6. Instagram **mentions** permission — **UNVERIFIED** (docs page 404s).
7. YouTube scope **sensitivity classification** (sensitive vs restricted) — restricted would add a
   third-party security assessment and months of lead time.
8. YouTube `status.publishAt` native scheduling — **UNVERIFIED**.
9. LinkedIn Posts API native scheduling — **UNVERIFIED**.
10. **No network publishes a review SLA.** Every lead time in §1 is third-party estimate or blank.
    Do not put these numbers in a client contract.

---

## §10 · Sources

Accessed **2026-08-13**.

**Meta / Instagram / Facebook**
- https://developers.facebook.com/docs/instagram-platform/overview
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
- https://developers.facebook.com/docs/instagram-platform/content-publishing
- https://developers.facebook.com/docs/instagram-platform/insights
- https://developers.facebook.com/docs/permissions
- https://developers.facebook.com/docs/pages-api/posts
- https://developers.facebook.com/docs/graph-api/overview/access-levels
- https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- https://developers.facebook.com/docs/app-review
- https://developers.facebook.com/docs/development/release/business-verification
- https://communityforums.atmeta.com/discussions/Questions_Discussions/business-verification-in-review-10-days-%E2%80%94-blocking-app-review-submission/1372323 *(community, corroborative only)*

**LinkedIn**
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-07
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-07
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide?view=li-lms-2026-07
- https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits?view=li-lms-2026-07
- https://www.linkedin.com/legal/l/marketing-api-terms

**TikTok**
- https://developers.tiktok.com/doc/content-posting-api-get-started/
- https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/
- https://developers.tiktok.com/doc/tiktok-api-scopes/
- https://developers.tiktok.com/doc/content-sharing-guidelines/
- https://www.tokportal.com/learn/tiktok-content-posting-api-developer-guide *(third-party, timelines only)*
- https://www.postpeer.dev/blog/best-tiktok-posting-api *(third-party, timelines only)*

**YouTube / Google**
- https://developers.google.com/youtube/v3/getting-started
- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.google.com/youtube/v3/guides/auth/installed-apps
- https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- https://developers.google.com/youtube/analytics/reference
- https://support.google.com/youtube/contact/yt_api_form
- https://support.google.com/cloud/answer/13463073
- https://github.com/porjo/youtubeuploader/issues/86 *(community, corroborative only)*

---

*Cross-references:* [SMM design](./smm-design.md) ·
[SMM addendum 2026-08-12](./smm-design-addendum-2026-08-12.md) ·
[`0105_module_social.sql`](../../platform-nest/migrations/0105_module_social.sql) ·
[SMM foundation](./smm-foundation.md) · [BLUEPRINTS index](../BLUEPRINTS.md)

> **Document note:** the task brief referenced `smm-design-addendum-2026-08-12.md` **§A4d**. That
> section does not exist — the addendum runs §A0–§A5 with a §A4b insert. The addendum content
> relevant to OQ-1 is **§A5 item 4** ("Non-code, starting now … OQ-1 platform-app review
> submissions"), which is what this dossier executes against.
