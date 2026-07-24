# SEO & SEM Department — Foundation Research

> **Status:** Foundation / research blueprint (no code). Feeds a future `search-marketing`
> module + department consoles (same pattern as Web Dev / WebDesk).
> **Date:** 2026-07-23 · **Author:** Claude (research pass)
> Sources are listed at the end. Convert to a MODULES.md `PLANNED` entry when the architect design doc starts.
>
> **📌 SOURCE OF TRUTH — DataForSEO Product Guide:**
> https://my.visme.co/view/8ro79w7m-d3o26vkg17y7lgxw#s1
> (User-supplied canonical reference for the chosen data provider. Full content lives at the URL —
> it's a Visme JS app and can't be scraped into this doc; open the link for products/endpoints/pricing.)

The goal of this document is to get the **foundation right first**: understand the disciplines,
what clients actually pay for, the outcomes we must deliver, the standard toolchain, where AI
genuinely helps, which open-source base to fork, what to modify, and exactly how it plugs into
the gaiada ERP.

---

## 1. What SEO and SEM actually are

Both are **search marketing** — capturing demand from people (and now AI answer engines) who are
actively searching. They differ in *how* visibility is won and *how fast*.

| | **SEO** — Search Engine Optimization | **SEM** — Search Engine Marketing (paid / SEA) |
|---|---|---|
| Mechanism | Earn organic rankings | Buy placement via ad auctions (Google Ads, Bing, etc.) |
| Speed | Slow — compounding asset over months | Instant — traffic the day a campaign goes live |
| Cost shape | Labor-heavy, no per-click cost | Media spend + management fee; stops when budget stops |
| Durability | Durable asset that keeps paying | Rented traffic; ends with the budget |
| Best for | Long-term sustainable growth, brand authority | Fast leads, launches, promotions, filling pipeline gaps |

> **2026 framing (important):** the modern view is not "free vs paid." It's **portfolio management
> of search intent** across SERP formats *and* AI answer engines. SEM is increasingly treated as
> *governance* over the whole demand-capture portfolio, and a third discipline has emerged:
> **GEO / AEO / LLMO** — optimizing to be *cited by* ChatGPT, Google AI Overviews, Gemini, Claude,
> Perplexity. Our module must treat GEO/AEO as a first-class pillar, not an afterthought.

---

## 2. What they *do* — the day-to-day work (deliverables)

### SEO deliverables
1. **Technical SEO** — crawlability, indexation, site speed / Core Web Vitals, structured data
   (schema), sitemaps, canonicals, mobile, log-file analysis.
2. **On-page** — title/meta, headings, internal linking, content optimization to search intent.
3. **Content / topical authority** — keyword & intent research, topic clusters, briefs, publishing calendar.
4. **Off-page / authority** — backlink acquisition, digital PR, link audits, disavow.
5. **Local SEO** (where relevant) — Google Business Profile, citations, reviews.
6. **GEO / AEO** — structured, extractable, citation-worthy content so the brand appears in AI answers.

### SEM deliverables
1. **Account structure** — campaigns, ad groups, keyword/audience segmentation.
2. **Keyword & negative-keyword management** — search-term mining, match types.
3. **Ad creative** — RSAs, extensions/assets, A/B testing, landing-page alignment.
4. **Bidding & budget** — bid strategy, budget pacing, ROAS/CPA targets.
5. **Tracking** — conversion tracking, GA4 events, offline conversion import.
6. **Optimization loop** — weekly search-term/negative sweeps, quality-score work, wasted-spend cuts.

Both feed a **reporting layer** — dashboards + narrative that tie activity to business outcomes.

---

## 3. Expected client benefit & outcome (what we're actually accountable for)

Clients don't buy rankings or clicks — they buy **business outcomes**. Report metrics, commit to KPIs.

**KPIs sit in four buckets (SEO):** visibility (rankings, impressions, share of voice) →
traffic (organic sessions, clicks, CTR) → engagement (engagement rate, dwell) →
**outcome (conversions, revenue, pipeline)**.

**SEM KPIs:** CPC, CTR, Quality Score, CPA, **ROAS**, conversion volume.

**Shared business KPIs (what the client cares about):** qualified leads, cost per lead,
close rate, customer value, revenue attributable to search.

| Discipline | Primary client outcome | Timeframe |
|---|---|---|
| SEO | Durable, compounding organic traffic → leads/revenue at falling cost-per-acquisition | 3–12 months |
| SEM | Immediate qualified traffic and leads at a controllable, predictable CPA/ROAS | Days |
| GEO/AEO | Brand presence & citation inside AI answers (the new zero-click surface) | Emerging |

> **How we fulfill the request/need:** intake the client's goal (leads / revenue / launch) → audit
> current state → strategy → execute deliverables → **measure against the committed KPI** → report
> the *outcome*, not the activity. The ERP must model this as an outcome-tracked engagement, not a task list.

---

## 4. Industry-standard tools (what the pros use)

A practical professional stack = **Search Console + GA4 + one crawler + one research platform +
one reporting layer + one content-workflow tool** (+ Google Ads for SEM).

### The "free essentials" (non-negotiable, always integrated)
- **Google Search Console (GSC)** — ground truth for what Google shows for the site.
- **Google Analytics 4 (GA4)** — what traffic did after the click.
- **Google Ads** — the SEM platform itself.
- **Google Business Profile** — local.
- **Bing Webmaster / Microsoft Ads** — secondary.

### Commercial platforms (the paid data moat)
| Tool | Role | Notes |
|---|---|---|
| **Semrush** | All-in-one SEO+SEM data | Strongest all-rounder; **you already have a Semrush MCP connector** (needs OAuth). |
| **Ahrefs** | Backlink data reference standard | Best-in-class link index. |
| **Screaming Frog** | Desktop technical crawler | The de-facto site-audit spider; integrates GA4+GSC. |
| **Looker Studio** | Reporting/dashboards | Free; pulls GSC/GA4/Semrush/Ahrefs into client dashboards. |

**Key insight:** the professional moat is **data** (SERP volumes, backlink index), not the UI.
Open-source tools replicate the *workflow*; they still need a paid **data API** (Semrush / DataForSEO)
for volume/difficulty/backlink numbers. Our build = OSS workflow + pluggable data provider.

---

## 5. How AI helps — and which AI, used how

The AI-SEO tool market was ~$2.37B in 2025 → ~$3.06B by 2033. AI is now core, not optional.

### Where AI genuinely helps
| Task | AI role | Model class |
|---|---|---|
| **Keyword → intent clustering** | Group thousands of keywords into intent/topic clusters | Embeddings + small LLM |
| **Topic maps / content briefs** | Generate briefs, outlines, entity coverage from SERP + competitors | Mid/large LLM |
| **Content drafting & optimization** | Draft/rewrite to intent, tone, schema; NOT publish-without-review | Large LLM (Opus/Sonnet) |
| **Technical audit triage** | Summarize crawl findings, prioritize by impact, draft fixes | Mid LLM |
| **SEM: search-term mining / negatives** | Classify search terms, propose negatives, draft RSA copy | Mid LLM + rules |
| **GEO/AEO** | Structure content for RAG extraction & citation; track AI mentions | LLM + retrieval |
| **Reporting narrative** | Turn metrics into a client-readable story | Mid LLM |

### Which AI and how
- **Embeddings** for keyword/semantic clustering and RAG (topical authority, GEO). You already run
  **pgvector RAG** (WS8) — reuse it.
- **LLMs via your existing `ai-gateway-go`** — do **not** call vendor APIs directly. Route through the
  gateway so tenancy, cost, model tiering (Opus/Sonnet/Haiku/local Hermes) and audit are enforced.
- **Human-in-the-loop is mandatory** — the 2026 pattern is *AI drafts, human approves* (same model
  you already use for schema drafting and WebDev backend). Route AI-generated content/campaign changes
  through the **WS4 approvals surface** before anything publishes.
- **Agentic use** — expose SEO data as MCP tools so agents (WS8 ai-agents) can query rank/keyword/audit
  data and *propose* actions that land in the approval queue.

> **GEO/AEO note:** AI answer engines use RAG — they retrieve candidate docs and an LLM cites only a
> few. "Citation selection is the visibility bottleneck." Our content tooling should optimize for
> *extractability and citation-worthiness*, and we should track brand mentions across AI engines.

---

## 6. Open-source repositories to base on

No single OSS project covers everything. Recommended: **one all-in-one core + focused best-of-breed
tools per pillar**, unified behind our console.

| Pillar | Base repo | License / signal | Why |
|---|---|---|---|
| **All-in-one core (Semrush/Ahrefs alt)** | [`every-app/open-seo`](https://github.com/every-app/open-seo) | OSS, self-host | Keyword research + rank + backlinks + audit **and already exposes an MCP server** → drops into our MCP Hub. **Primary fork candidate.** |
| **Technical audit** | [`StJudeWasHere/seonaut`](https://github.com/stjudewashere/seonaut) | MIT, Go+MySQL, ~669★ | Severity-ranked audit reports; **Go matches our stack**. |
| **Deep crawler (Screaming Frog alt)** | [`puneetindersingh/open-seo-crawler`](https://github.com/puneetindersingh/open-seo-crawler) | OSS, self-host | Concurrent, CMS-aware, XLSX export, sitemap hygiene. |
| **Page speed / CWV** | [`Unlighthouse`](https://unlighthouse.dev/) | MIT, CLI+CI | Site-wide Lighthouse in parallel; wire into WS10 pipeline. |
| **Rank tracking** | [`towfiqi/serpbear`](https://github.com/towfiqi/serpbear) | Next.js+SQLite, Docker | Matches our Next.js UI; pluggable SERP providers. |
| **Web analytics** | [`matomo-org/matomo`](https://github.com/matomo-org/matomo) (GPL) or [`umami`](https://github.com/umami-software/umami) (MIT) | — | Shared-service analytics across client companies. |
| **SEM / PPC** | [Claude Ads](https://claude-ads.md/) + Google Ads Scripts | MIT | Audits, budget checks, drafts-first launches, client reports across 12 platforms. |
| **Keyword research** | [`chukhraiartur/seo-keyword-research-tool`](https://github.com/chukhraiartur/seo-keyword-research-tool) | Python | Autocomplete / PAA / Related — feeds SEO + SEM. |
| **GEO/AEO** | Ansvisor / GEO-AEO Tracker | OSS | Track brand mentions in ChatGPT / AI Overviews / Gemini / Claude / Perplexity. |

> **SEM reality check:** there is **no true open-source Ahrefs/Semrush** for paid-search intelligence.
> Plan for OSS workflow tooling **+ a paid data API** (Semrush MCP you already have, or DataForSEO).

---

## 7. What to modify (fork strategy)

Do **not** run these as stock external apps. Adapt to the holding-OS model:

1. **Multi-tenancy** — every tool is single-project by default. Add `companyId`/tenant scoping to match
   platform-nest FORCE-RLS. This is the biggest modification for `open-seo`, SerpBear, SEONaut.
2. **AuthN/AuthZ** — strip built-in login; front with **Keycloak OIDC** + **Cerbos** RBAC (per our OIDC SSO work).
3. **AI routing** — replace any direct LLM/vendor calls with our **`ai-gateway-go`**; reuse **pgvector**
   for clustering/RAG.
4. **Data provider abstraction** — make SERP/volume/backlink data a pluggable provider so we can swap
   Semrush MCP ↔ DataForSEO ↔ free scrapers per client/budget.
5. **Approvals** — AI-drafted content & campaign changes route through the **WS4 approvals surface**.
6. **Storage** — persist artifacts (crawls, reports) to Postgres + Shared Drive (per WS11 capture pattern),
   not the tool's local SQLite/MySQL where feasible.
7. **UI** — don't expose the tools' own UIs. Surface data through our **department-console template**
   (department-first nav, rank expands) as SEO / SEM tabs, matching the Web Dev reference.
8. **Events** — emit to the transactional-outbox event backbone so rank drops, crawl errors, budget
   overspend become **notifications/approvals** in the ERP.

---

## 8. Integration points to the ERP

| ERP subsystem | Integration |
|---|---|
| **platform-nest** (core) | New `search-marketing` vertical: engagements, KPIs/targets, audits, reports as first-class entities under the client (agency vertical). Outcome-tracked, RLS-scoped per company. |
| **platform-ui** | SEO console + SEM console built on the **dept-interface-template**; dashboards, rank charts, audit lists, campaign views, approval-gated actions. |
| **ai-gateway-go** | All LLM inference for briefs, drafts, clustering, report narratives. |
| **mcp-hub** | Register `open-seo` MCP + a `search-marketing` MCP so WS8 agents can query rank/keyword/audit data. |
| **pgvector RAG (WS8)** | Keyword clustering, topical authority, GEO extractability. |
| **automation (n8n, WS4)** | Scheduled crawls, weekly rank pulls, search-term/negative sweeps, budget-pacing checks, report generation. |
| **approvals surface (WS4)** | Human-in-the-loop gate for AI content + campaign changes before publish. |
| **event backbone / notifications** | Rank drops, crawl regressions, overspend → alerts + tasks. |
| **Semrush MCP connector** | Paid data source. ⚠️ **Needs OAuth** via claude.ai connector settings — not usable until authorized. |
| **Shared Drive (WS11)** | Store client-facing reports and crawl exports. |
| **observability (WS9)** | Crawl/inference/job telemetry via existing OTel. |

---

## 8a. LOCKED decision — data provider + cost model (2026-07-23)

**Context:** Gaiada is Indonesia-based serving **many smaller clients with variable needs**; IDR/USD
currency pressure means the stack must be *cheapest yet professional*. Decision below is locked;
don't relitigate without a cost reason.

**Provider: DataForSEO (Standard queue) as primary; Semrush MCP as optional premium upsell.**
Rationale: pay-as-you-go maps to per-client billing (no dead subscription floor), `open-seo` is
pre-wired to DataForSEO, and it's a *data layer* (what a build-it-yourself strategy needs) vs. a
finished product. Behind a **pluggable provider abstraction** so Semrush can serve premium clients.

**Cost-control policy (the USD-exposure levers):**
1. **AI bulk work → local Hermes** (`hermes-gateway`); reserve paid Claude for client-facing polish only.
2. **Default DataForSEO Standard queue** ($0.0006/SERP, ~5-min) — 3× cheaper than Live.
3. **Self-hosted crawlers do all audit/crawl/speed work — $0 API** (SEONaut, open-seo-crawler, Unlighthouse).
4. **Cache SERP/volume in Postgres** — no re-querying the same keyword within a window.
5. **Meter per client in the ERP**; one shared $50 DataForSEO deposit pool across all clients.

**DataForSEO published rates (2026):** SERP Standard $0.0006 / Live $0.002; Labs $0.012/task +
$0.00012/item; Keywords Data (Google Ads volume) $0.0012/task + $0.00012/kw; Backlinks pay-as-you-go
(no $100 min); On-page/crawl not used (own crawlers).

**Per full-round client / month:** SEO ≈ $5.40 + SEM ≈ $2.80 + AI ≈ $0–1.50 → **≈ $8–11**.

**100 clients (varied mix) model:**

| Tier | # | Scope | $/client | Subtotal |
|---|---|---|---|---|
| Light | 40 | rank + monthly research (SEO *or* SEM) | ~$3 | $120 |
| Standard | 40 | full SEO *or* full SEM | ~$8 | $320 |
| Heavy | 20 | full SEO **+** SEM (more kw/competitors/backlinks) | ~$18 | $360 |
| DataForSEO total | 100 | | | **≈ $800/mo** |
| AI (local-first + selective cloud) | | | | +$50–150/mo |
| **Grand total** | | | | **≈ $850–950/mo** |

Scenario range: **floor ~$600** (cache-heavy, all-Standard, all-local AI) · **central ~$900** ·
**ceiling ~$1,800** (all 100 full-heavy SEO+SEM on Live queue). Blended **~$8–10/client/mo**.

**IDR @ Rp 22,000/USD** (buffered for currency fluctuation — deliberately conservative):

| Metric | USD | IDR @ 22k |
|---|---|---|
| Floor (100 clients) | $600/mo | ~Rp 13.2M/mo |
| **Central (100 clients)** | **$900/mo** | **~Rp 19.8M/mo** |
| Ceiling (100 clients) | $1,800/mo | ~Rp 39.6M/mo |
| Blended per client | $8–10/mo | ~Rp 176k–220k/mo |
| Full-round per client | $8–11/mo | ~Rp 176k–242k/mo |

Even buffered at 22k, data cost is a rounding error against a professional retainer.
*(Estimates from published per-endpoint pricing + assumed typical usage; tune per real client mix.)*

**vs Semrush for the same 100 clients:** $500/mo base + heavy unit add-ons for programmatic use →
~$2,000–5,000+/mo, and **not** meterable per client. DataForSEO is ~3–5× cheaper and bills the way we sell.

---

## 9. Recommended next steps

1. **Validate the pillars & priority** with stakeholders (SEO-first vs SEM-first vs both).
2. **Architect design doc** — `search-marketing` vertical schema + SEO/SEM console contracts + n8n flows
   (same path as WebDesk backend design).
3. **Spike `open-seo`** — confirm the fork effort for multi-tenancy + gateway/Cerbos wiring; decide
   monolith-adapt vs. data-only (use its MCP, build our own UI).
4. **Data provider — LOCKED (see §8a):** DataForSEO primary (Standard queue) + Semrush MCP premium. Fund the $50 DataForSEO deposit; authorize Semrush MCP OAuth only if premium tier is wanted.
5. **Register** as a `PLANNED` module in `docs/modules/MODULES.md` once the design doc is approved.

---

## Sources
- SEO vs SEM / KPIs: [Semrush](https://semrush.com/blog/seo-vs-sem), [AgencyAnalytics](https://agencyanalytics.com/blog/seo-kpis), [Incremys](https://www.incremys.com/en/resources/blog/sem-seo), [icertGlobal](https://www.icertglobal.com/blog/seo-vs-sem-key-differences-and-2026-strategy-guide)
- Industry tools: [Quicksprout](https://www.quicksprout.com/best-seo-tools/), [Traffic Think Tank](https://trafficthinktank.com/seo-software-for-agencies/), [Backlinko](https://backlinko.com/best-free-seo-tools), [SEO.com Looker Studio](https://www.seo.com/tools/looker-studio/)
- AI / GEO / AEO: [Adobe](https://business.adobe.com/blog/seo-in-2026-fundamentals), [Opinly](https://opinly.ai/blog/llm-content-optimization), [ZUMO](https://www.zumoseo.ch/en/blog/seo-trends-2026), [arXiv GEO](https://arxiv.org/pdf/2605.25517)
- Open-source tools: [serpapi/awesome-seo-tools](https://github.com/serpapi/awesome-seo-tools), [every-app/open-seo](https://github.com/every-app/open-seo), [SEONaut](https://github.com/stjudewashere/seonaut), [open-seo-crawler](https://github.com/puneetindersingh/open-seo-crawler), [SerpBear](https://github.com/towfiqi/serpbear), [Unlighthouse](https://unlighthouse.dev/), [PostHog OSS analytics](https://posthog.com/blog/best-open-source-analytics-tools), [Claude Ads](https://claude-ads.md/)
