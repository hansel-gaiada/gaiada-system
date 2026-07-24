# Social Media (SMM) Department — Foundation Research

> **Status:** Foundation / research blueprint (no code). Feeds a future `social-media`
> module + department console (same pattern as Web Dev / WebDesk / SEO-SEM).
> **Date:** 2026-07-23 · **Author:** Claude (research pass)
> Sources are listed at the end. Convert to a MODULES.md `PLANNED` entry when the architect design doc starts.
>
> Sibling blueprint: `docs/blueprints/seo-sem-foundation.md` (search-marketing). SMM shares its
> holding-OS integration model — read the two together; the fork/ERP-integration playbook is identical.

The goal of this document is to get the **foundation right first**: understand the disciplines,
what clients actually pay for, the outcomes we must deliver, the standard toolchain, where AI
genuinely helps, which open-source base to fork, what to modify, and exactly how it plugs into
the gaiada ERP — before any code is written.

> **📌 SCOPE DECISION (2026-07-23, user):** our SMM department is the **organic content-studio +
> publisher** model — **posting for clients, driving engagement, copywriting, and making digital
> assets.** That is service lines 1–3 below (organic / content creation / community engagement).
> **Paid social ads, social listening, and influencer/UGC are OUT of v1 scope** — parked as future
> service lines. This drops the two hardest/most expensive pieces (paid-ad-API integration + licensed
> listening data). Copy maps onto `ai-gateway-go`; digital assets onto the Creative Image Studio.
>
> **📌 OSS DECISION (2026-07-23, REVISED — user prioritized open-source/free):** publisher =
> **Postiz** (`gitroomhq/postiz-app`, AGPL-3.0, free, 14 networks) — run **AGPL-contained** (isolated
> sidecar behind its API, thin fork, tenancy in our own gateway/BFF, offer Postiz source to users).
> A web search confirmed **no permissive-licensed tool covers our needs** — the MIT options (Mixpost
> Lite, etc.) ship ~3 networks + no inbox; every full-coverage free tool is AGPL. **Mixpost Pro**
> (~$299/$1,199, no copyleft) is the **paid fallback** if AGPL containment proves impractical.
> **Chatwoot is dropped** — it overlaps our existing WhatsApp system; social-comment/DM engagement
> uses Postiz's built-in comment/collab surface. See §6.

---

## 1. What Social Media Marketing actually is

SMM is **not one thing** — it's five loosely-coupled disciplines that agencies staff and price
separately. The single most important modeling decision is to treat them as distinct **service
lines**, because they bill on different axes: organic/community/influencer are **labor-bound**
(retainer/hours), paid social is **spend-bound** (% of ad spend or flat mgmt fee), and listening
is a **data/tooling cost** (pass-through or bundled).

| Discipline | Mechanism | Speed | Cost driver | Durability |
|---|---|---|---|---|
| **Organic social** | Post owned content; reach earned via algorithm + followers | Slow — compounds over weeks/months | Labor (content creation) | High — content + audience are owned assets |
| **Paid social (social ads)** | Buy placements via ad auctions (Meta/TikTok/LinkedIn) | Fast — hours/days | Media spend + mgmt fee | Low — ends the moment budget stops |
| **Community management** | Reply to comments/DMs/mentions, moderate, nurture | Continuous / real-time | Labor (coverage hours, SLA) | Medium — builds loyalty & retention |
| **Influencer / UGC** | Pay/gift creators to make or post content | Medium — campaign cycles | Creator fees + product + coordination | Medium — content can be licensed/reused |
| **Social listening** | Monitor mentions/sentiment/competitors/trends | Continuous (intelligence, not output) | Data/tool licensing + analyst labor | N/A — an *input* that informs the other four |

> **2026 framing (important):** the modern view is not "post more." It's **portfolio management of
> attention** — organic builds the owned asset, paid buys reach on demand, community converts
> attention into loyalty, influencer borrows trust, and listening is the intelligence layer feeding
> all four. The ERP must model these as separate, outcome-tracked service lines under a client, not
> one undifferentiated "social" task list.

---

## 2. What they *do* — the day-to-day work (deliverables)

| Deliverable | What it is | Cadence | Consumer |
|---|---|---|---|
| **Content calendar / planning** | Scheduled grid of what posts where/when, by theme/campaign | Monthly plan, weekly adjust | Client approval loop |
| **Content creation** | Graphics, short-form video, carousels, copywriting, captions | Daily/weekly | Publishing pipeline |
| **Scheduling & publishing** | Queue + auto-publish across IG, TikTok, LinkedIn, X, FB, YouTube, Threads, Pinterest | Daily | Platforms (via API) |
| **Community management / inbox** | Unified inbox: comments, DMs, mentions, reviews → reply/route/escalate | Real-time / daily SLA | End audience |
| **Social listening** | Track brand/competitor/keyword mentions, sentiment, share of voice | Continuous + weekly digest | Strategy/reporting |
| **Paid social campaign mgmt** | Build/launch/optimize ad sets, creatives, audiences, budgets | Daily optimization | Ad platforms |
| **Influencer coordination** | Sourcing, briefs, contracts, content approval, tracking | Per campaign | Creators + client |
| **Reporting** | Performance dashboards + narrative (what happened, why, next) | Weekly/monthly | Client |

> **Platform reality:** there is **no universal "post" object.** Each network is a separate
> integration with its own media rules (aspect ratios, video length, carousel limits, first-comment
> hashtags, Stories vs Reels vs feed). The scheduler must model per-network post variants, not one
> canonical post fanned out blindly. See §7.

Both organic and paid feed a **reporting layer** — dashboards + narrative tying activity to
business outcomes.

---

## 3. Expected client benefit & outcome (what we're actually accountable for)

Clients don't buy posts or followers — they buy **business outcomes**. Junior agencies sell reach;
senior agencies sell revenue. Report metrics, commit to KPIs.

**KPIs sit in a funnel (organic + community):** reach/awareness (impressions, reach, video views,
follower growth) → engagement (likes, comments, shares, saves, engagement rate) → community growth
(net growth, active community, repeat commenters) → traffic (link clicks, CTR) →
**outcome (leads, sign-ups, sales, revenue attributed)**. Cross-cutting: **share of voice** and
**sentiment** (from listening).

**Paid-social KPIs:** CPM, CPC, CTR, CPA, **ROAS** (the number that renews the contract).

| Discipline | Primary client outcome | Timeframe |
|---|---|---|
| Organic social | Durable owned audience + presence → compounding awareness & trust | Months |
| Paid social | Immediate reach/leads at a controllable, predictable CPA/ROAS | Days |
| Community mgmt | Retention, loyalty, protected reputation, faster response | Continuous |
| Influencer/UGC | Borrowed trust + reusable creative at campaign scale | Weeks per campaign |
| Social listening | Early-warning + competitive/trend intelligence | Continuous |

> **What clients actually pay for (in practice):** (1) consistent presence they don't have time to
> maintain, (2) paid-social **ROAS**, and (3) the reassurance of monitoring/response (community +
> listening). Awareness metrics are table stakes; retention hinges on demonstrating revenue or
> leads. The ERP must model each engagement as **outcome-tracked**, not a task list.

---

## 4. Industry-standard tools (what the pros use)

A practical professional stack = **one publishing/scheduling suite + one listening platform +
native ad managers + a reporting layer**.

### Publishing / scheduling (the daily workspace)
- **Sprout Social, Hootsuite, Later, Buffer, Loomly, Metricool, Agorapulse** — plan, schedule,
  auto-publish, unified inbox, analytics. This is the category our console competes with.

### Social listening (the intelligence layer — expensive, quote-gated)
| Tool | Approx 2026 pricing | Positioning |
|---|---|---|
| **Brand24** | ~$199–$999/mo | SMB / mid-market |
| **Talkwalker** | ~$149–$999/mo tiers | Mid-market → enterprise |
| **Brandwatch / Meltwater** | Custom, ~$20k–$50k/yr | Enterprise consumer intelligence / PR |
| **Sprinklr** | $150k+/yr | Enterprise unified-CXM |

### Paid social (native, no substitute)
- **Meta Ads Manager**, **TikTok Ads Manager**, **LinkedIn Campaign Manager** — build, optimize,
  and report ad campaigns. There is **no self-hostable substitute** for the auction/optimization data.

**Key insight — the data moat is twofold:** (a) **privileged platform API access** (approved
Meta/TikTok/LinkedIn app tiers — see §7), and (b) **historical listening/mention data** (a
scraped/licensed corpus of social conversation that enterprise vendors guard behind five-figure
contracts). Neither is reproducible with OSS alone. Our build = **OSS publishing/community workflow
+ pluggable paid data providers** for listening and paid-social intelligence.

---

## 5. How AI helps — and which AI, used how

AI touches SMM more heavily than any other agency discipline, because the work is **high-volume
content production** — exactly what generative models accelerate.

### Where AI genuinely helps
| Task | AI role | Model class |
|---|---|---|
| **Content ideation / drafting** | On-brand angles, beats the blank page | LLM (text) |
| **Caption / hashtag generation** | Fast per-platform variants from one brief | LLM (text) |
| **Image generation** | Concepts, variations, on-brand creative | Generative image (diffusion/multimodal) |
| **Video generation** | AI b-roll / shorts (usable for filler, still uncanny for hero) | Generative video |
| **Long-form → short clips (repurposing)** | Biggest labor saver; find highlights, reframe 16:9→9:16 | ASR (Whisper) + LLM highlight + vision reframe |
| **Comment triage / sentiment** | Classify + route inbox at scale | LLM classification + embeddings for clustering |
| **Best-time-to-post** | Mostly statistics, not "AI" | Classical ML / regression on own engagement data |
| **Trend detection** | Semantic clustering of mentions → what's emerging | Embeddings + LLM summary |
| **Listening summarization** | Turn the mention firehose into a digest | LLM (long-context) |
| **Reporting narrative** | Metrics → client-readable "what happened & why" | LLM (text) |

### Which AI and how
- **Embeddings** for trend clustering, mention dedup, topic grouping, and RAG over brand voice.
  You already run **pgvector RAG** (WS8) — reuse it.
- **LLMs via your existing `ai-gateway-go`** — do **not** call vendor APIs directly. Route through
  the gateway so tenancy, cost, model tiering (Opus/Sonnet/Haiku/local Hermes) and audit are
  enforced. Bulk work (captions, triage, narratives) → cheap/mid tiers.
- **Multimodal / vision** — analyze image/video posts, speaker reframing in clip cropping,
  brand-safety checks. The Gateway already exposes `vision`/`transcribe`/`ocr` capabilities via
  the MCP Hub.
- **Generative image/video is the highest-cost class** — gate it behind **WS4 approvals + credits**;
  the Creative Image Studio (already prototyped) is the natural home for the image seam.
- **Human-in-the-loop is mandatory** — the pattern is *AI drafts, human approves*. **Nothing
  auto-publishes to a client's public account without approval.** Route AI-generated content and
  campaign changes through the **WS4 approvals surface** before anything goes live. This is
  stricter than SEO because the output is public and irreversible.
- **Agentic use** — expose social data (scheduled queue, inbox, listening, ad performance) as MCP
  tools so WS8 agents can *propose* posts, replies, and optimizations that land in the approval queue.

---

## 6. Open-source repositories to base on

**DECISION (2026-07-23, REVISED): publisher = Postiz, run AGPL-contained. Mixpost Pro = paid fallback.
Chatwoot dropped.** A web search confirmed **no permissive (MIT/Apache/BSD) tool covers 10 networks +
inbox + multi-tenant** — the permissive ones are crippled or dead; every full-coverage *free* tool is
AGPL. User chose free+open-source (Postiz) over paid-no-copyleft (Mixpost). Recommended shape: **Postiz
publishing core (contained) + a repurposing library**, paid-social/listening out of v1 (see top).

| Pillar | Base repo | License / signal | Verdict |
|---|---|---|---|
| **Publishing / scheduling core** ✅ | [`gitroomhq/postiz-app`](https://github.com/gitroomhq/postiz-app) | **AGPL-3.0**, ~33.7k★, **very active** (NestJS + Prisma/PG + Temporal, agentic/MCP-friendly) | **CHOSEN (free, OSS).** 14 networks (IG/FB/TikTok/LinkedIn/X/YouTube/Threads/Pinterest/Bluesky/Mastodon/Reddit/Discord/Slack/Dribbble); orgs/workspaces/RBAC built in; comment/collab surface covers engagement. Stack matches ours. **Run AGPL-contained** — see §9. |
| **Publishing (paid fallback)** ⚠️ | [`inovector/mixpost`](https://github.com/inovector/mixpost) | Lite **MIT** (~3.4k★); **Pro** proprietary EULA (~$299); **Enterprise** (~$1,199) | **FALLBACK only** if AGPL containment proves impractical. Pro's 11 networks + built-in inbox, fork-and-keep-closed (no copyleft), but **not free** and Lite alone is too crippled (~3 networks, no inbox). |
| **Publishing (rejected — agency-shaped but tiny)** ❌ | [`trypostit/trypost`](https://github.com/trypostit/trypost) | **AGPL-3.0**, ~414★ | Rejected — same AGPL as Postiz but far smaller community = more maintenance risk we'd carry. Postiz is the safer AGPL bet. |
| **Community inbox (dropped)** ❌ | [`chatwoot/chatwoot`](https://github.com/chatwoot/chatwoot) | MIT community; `enterprise/` dir commercial | **DROPPED.** Omnichannel *support* inbox that **overlaps our existing WhatsApp system**, not an SMM tool. Engagement uses **Postiz's built-in comment/collab surface** — no second inbox stack. |
| **Video repurposing (library)** | [`ClipsAI/clipsai`](https://github.com/ClipsAI/clipsai) | **MIT**, ~0.5k★ | Optional. Python lib: long video → clips + 16:9→9:16 reframe (WhisperX + Pyannote + ffmpeg). Use as a **library**, reuses our local faster-whisper. Add when video is a real deliverable. |
| **Video repurposing (app)** | [`SamurAIGPT/AI-Youtube-Shorts-Generator`](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator) | **MIT**, ~4.3k★ | Optional. Long-form → 9:16 shorts via LLM highlight + Whisper + auto-crop. |
| **Digital assets (images)** | — (internal) | — | Use the **Creative Image Studio** (already prototyped) + Gateway generative-image seam. No new OSS. |
| **Copywriting** | — (internal) | — | `ai-gateway-go` + pgvector brand-voice RAG. No new OSS. |
| **Social listening** *(out of v1)* | — | **No credible maintained OSS** | Parked. If added later: buy a paid API (Brand24/Talkwalker), don't build the mention corpus. |
| **Paid-social intelligence** *(out of v1)* | — | **No OSS** | Parked. If added later: integrate native Meta/TikTok/LinkedIn ad APIs; no self-hostable substitute. |

> **AGPL containment (the discipline that makes Postiz safe — lawyer flag):** AGPL copyleft attaches
> to "the Program" and works *based on* it — **not** to independent programs that call it at arm's
> length over a network API (that's "mere aggregation"). So: (1) run Postiz as an **isolated
> service/container**, talk to it **only over its REST API**; our NestJS/Go/Next.js services stay
> uninfected. (2) Implement **multi-tenancy + all proprietary logic OUTSIDE Postiz** (in our
> gateway/BFF) — the trap is baking our tenancy/RBAC IP into the AGPL process. (3) Keep the **fork
> thin** — the more we modify Postiz internals, the more of *those changes* we must offer to users.
> (4) The §13 obligation is only to **offer Postiz's modified source to interacting users** (our
> client-companies' staff) — a footer link to our fork repo satisfies it. Note the Postiz **frontend
> JS is AGPL served to browsers** — a modified UI is also conveyance. **If we can't commit to a thin
> fork, fall back to Mixpost Pro.** Confirm with counsel.
>
> **Rejected/dead:** Mixpost Pro EULA forbids reselling workspaces (would need Enterprise, ~$1,199).
> **Socioboard** effectively abandoned (~2019); **Shoutify** archived/non-functional — do not adopt.

---

## 7. Platform API realities (the hardest constraint on the whole project)

API publishing ranges from "workable with hoops" to "effectively closed." **Every network is a
separate app-review + credential + rate-limit regime** — budget for per-platform onboarding, not a
generic connector. **Approved API app status is itself part of the moat (§4)** — start review
submissions early; they gate the whole publishing product.

| Platform | API publish? | Key 2026 constraints | Difficulty |
|---|---|---|---|
| **Instagram** (Graph API) | Yes | **Business accounts only**; FB Page + Meta app + approved `instagram_business_content_publish`; container→publish 2-step; **cap ~25 API posts / 24h**; Reels + Stories supported | Hard (app review) |
| **Facebook** (Graph API) | Yes | Same Meta app-review regime; Pages only; most mature of the set | Medium |
| **TikTok** (Content Posting API) | Yes | **Very restrictive** — strict review, chunked 2-step upload, Direct Post vs "Upload to Inbox" (manual finish), **no native scheduling**, tight rate limits | Very hard |
| **LinkedIn** (Community Mgmt API) | Yes | **Registered legal orgs, commercial use only**; Dev tier (limited, upgrade within 12mo) → Standard via vetting; versioned APIs sunset regularly | Hard (vetting) |
| **X / Twitter** | Yes | **No free tier** (killed Feb 2026). **Pay-per-use** ~$0.015/post (~$0.20 with a link); legacy Basic/$200 & Pro/$5k closed to new signups; Enterprise ~$42k+/mo | Medium tech, **costly** |
| **YouTube** (Data API v3) | Yes | Quota-based, 10,000 units/day; `videos.insert` dropped ~1,600→~100 units (2025-12-04) → ~100 uploads/day free; search = 100 units | Medium |
| **Threads** (Threads API) | Yes (limited) | Newer Meta API, similar app-review model; feature set behind IG/FB | Medium |
| **Pinterest** (API v5) | Yes | App review required; workable | Medium |

**Design implications for our scheduler:**
1. **Per-network app-review + credential + rate-limit** — model each as a first-class connector with
   its own status, quota, and health, surfaced in the console (like the IT device registry).
2. **IG's ~25/24h and TikTok's no-scheduling + inbox-review flow** break naïve "schedule anything
   anytime" UX — surface these limits in the calendar UI, don't let users queue what the API will reject.
3. **X is now a metered cost center**, not a flat license — **meter it per-post per-tenant** or it
   silently bleeds money. Wire into the same cost-cap/audit discipline as the AI Gateway.
4. **Media rules per network** (aspect ratio, length, carousel limits) must be validated pre-publish.

---

## 8. Integration points to the ERP

| ERP subsystem | Integration |
|---|---|
| **platform-nest** (core) | New `social-media` vertical: engagements, service lines (organic/paid/community/influencer/listening), content calendar, post variants, KPIs/targets, reports as first-class entities under the client. Outcome-tracked, RLS-scoped per company. |
| **platform-ui** | SMM console on the **dept-interface-template** — the already-designed **"Publish" craft group: Calendar · Composer · Inbox · Analytics** (see [[dept-interface-template]], 2026-07-23 note). Approval-gated publish actions. |
| **ai-gateway-go** | All LLM inference — drafts, captions, triage, listening/report narratives, trend summaries. Multimodal `vision`/`transcribe`/`ocr` for clip repurposing + brand-safety. |
| **Creative Image Studio** | Generative-image seam for on-brand creative (already prototyped, phase-1 client-side grading). |
| **mcp-hub** | Register a `social-media` MCP (scheduled queue, inbox, listening, ad performance) so WS8 agents can propose posts/replies/optimizations into the approval queue. |
| **pgvector RAG (WS8)** | Trend clustering, mention dedup, brand-voice RAG for on-brand drafting. |
| **automation (n8n, WS4)** | Scheduled publishing jobs, listening pulls, weekly reports, inbox routing, ad-pacing checks. **n8n orchestrates, MCP accesses** (backbone rule). |
| **approvals surface (WS4)** | **Mandatory** human-in-the-loop gate — nothing publishes to a client's public account or changes a live ad without approval. Stricter than SEO (public, irreversible). |
| **event backbone / notifications** | Publish failures, rate-limit hits, negative-sentiment spikes, ad overspend, inbox SLA breaches → alerts + tasks. |
| **wa-chat-bot** | Stays as-is for WhatsApp/Telegram. **Not** reused for social engagement — social comment/DM inbox lives in Mixpost (Chatwoot dropped to avoid a duplicate inbox stack). |
| **Shared Drive (WS11)** | Store client-facing reports + produced creative/video assets. |
| **observability (WS9)** | Publish/inference/job telemetry + per-platform connector health via existing OTel. |
| **Data providers** *(future)* | Only if paid-social/listening are added later: Brand24/Talkwalker + Meta/TikTok/LinkedIn ad APIs as pluggable providers. Out of v1 scope. |

---

## 9. What to modify (fork strategy)

Same holding-OS playbook as the SEO blueprint — do **not** run these as stock external apps. **NB for
Postiz: reconcile every mod below against AGPL containment (§6) — proprietary logic lives OUTSIDE the
Postiz process, and the fork stays thin.**

1. **Multi-tenancy** — Postiz already has orgs/workspaces; **prefer enforcing tenant scoping in our
   own gateway/BFF (outside the AGPL process)** rather than deep-forking Postiz internals, to keep
   the fork thin and our tenancy IP closed. Add `companyId` mapping at the boundary.
2. **AuthN/AuthZ** — strip built-in login; front with **Keycloak OIDC** + **Cerbos** RBAC.
3. **AI routing** — replace any direct LLM/vendor calls with **`ai-gateway-go`**; reuse **pgvector**.
4. **Provider abstraction** — make listening + paid-social data pluggable (Brand24 ↔ Talkwalker ↔
   DataForSEO; Meta ↔ TikTok ↔ LinkedIn) per client/budget.
5. **Approvals** — every publish + ad change routes through the **WS4 approvals surface**.
6. **Metering** — X per-post cost + AI generation cost run through the Gateway cost-cap/audit discipline.
7. **Storage** — persist calendar, post variants, inbox threads, reports to Postgres + Shared Drive,
   not the tool's local DB where feasible.
8. **UI** — don't expose the tools' own UIs. Surface through the **dept-console template** (the
   designed Calendar/Composer/Inbox/Analytics tabs).
9. **Events** — emit to the transactional-outbox backbone so publish fails, sentiment spikes, and
   overspend become notifications/approvals.
10. **License decision** — ✅ RESOLVED: **Postiz (AGPL, free), run contained** (§6). Mixpost Pro =
    paid fallback; Chatwoot dropped.

---

## 10. Recommended next steps

1. ✅ **Scope decided** — v1 = organic publish + engagement + copywriting + digital assets (see top).
2. ✅ **OSS/license decided** — Postiz (AGPL, free), run contained; Mixpost Pro fallback (see §6).
3. **Spike Postiz** — stand it up locally; evaluate the codebase + the boundary design that keeps the
   fork thin (tenancy in our gateway/BFF, not Postiz internals); confirm its comment/collab surface
   covers our engagement need; validate the AGPL containment (§6) is realistic. Fall back to Mixpost
   Pro if it isn't.
4. **Start platform API app reviews early** — Meta (IG/FB), TikTok, LinkedIn vetting take weeks and
   gate publishing. Treat as a parallel non-code workstream. (Postiz handles the plumbing; we still
   need our own approved app credentials per tenant/client.)
5. **Legal confirm** — AGPL containment boundary (mere-aggregation + thin-fork + source-offer to users).
6. **Architect design doc** — `social-media` vertical schema + SMM console contracts (Calendar/
   Composer/Inbox/Analytics) + n8n flows (same path as WebDesk / SEO-SEM design).
7. **Register** as a `PLANNED` module in `docs/modules/MODULES.md` once the design doc is approved.
   Follow [[status-language-and-versioning]] and [[agent-army-standard]] when building.

> **Deferred to future service lines (explicitly out of v1):** paid social ads, social listening,
> influencer/UGC — each adds a data-provider cost and their own tooling; revisit when a client needs them.

---

## Sources
- OSS repos: [Postiz](https://github.com/gitroomhq/postiz-app), [Mixpost](https://github.com/inovector/mixpost), [Chatwoot](https://github.com/chatwoot/chatwoot), [ClipsAI](https://github.com/ClipsAI/clipsai), [AI-Youtube-Shorts-Generator](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator), [OpenShorts](https://github.com/mutonby/openshorts)
- Platform APIs: [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started), [LinkedIn access tiers](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access), [X API pricing 2026](https://postproxy.dev/blog/x-api-pricing-2026/), [YouTube Data API quota](https://www.getphyllo.com/post/youtube-api-limits-how-to-calculate-api-usage-cost-and-fix-exceeded-api-quota)
- Listening tools/pricing: [Brandwatch](https://www.brandwatch.com/blog/social-listening-tools/), [Brand24](https://brand24.com/blog/social-listening-tools/)

> **Accuracy caveats:** star counts and X-API pricing shift fast — re-verify at build time. Chatwoot
> is MIT for the community edition only (its `enterprise/` dir is separately licensed). Postiz's
> AGPL-3.0 is the biggest licensing decision for a hosted multi-tenant product — legal review needed.
> No maintained OSS exists for social listening or paid-social intelligence — genuine buy-not-build boundaries.
