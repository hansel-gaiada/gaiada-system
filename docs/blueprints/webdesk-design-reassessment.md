# WebDesk — Plan Reassessment vs Industry Standard

> **Status:** Assessment — proposes amendments to [`webdesk-design.md`](./webdesk-design.md) v1.0
> (2026-08-07). **Changes no version and overturns no lock on its own.** Five rulings (R-1…R-5)
> need the owner; everything else is a mechanical amendment.
> **Version:** v1.0 · **Date:** 2026-08-26 · **Author:** Claude (assessment pass)
> **Ground-checked against the repo today:** `webdesk/` still absent · `webdesk 0.0.0 PLANNED` in
> MODULES.md · no `webdev` module in `platform-nest/src/modules/` · migration ledger now
> **timestamp-named** (head `202608252230_finance_record_coa_template.sql`).

---

## §00 · Verdict in one page

**The plan is strong where most agency platform plans are weak, and thin where most are strong.**

Its trust-boundary work (§03), its versioning semantics (§05), its determinism gate, and its
per-ticket procurement classification are genuinely above industry norm — most shops building a
"one backend for all client sites" never write an enumerated channel table or define what makes a
contract change breaking. That work should survive intact.

Its weaknesses are all of one family: **it is a security-and-governance architecture that has not
yet been pressure-tested as a product.** Three consequences:

1. **It builds several things the industry buys.** FE hosting, per-branch previews, custom
   domains + TLS, atomic deploy/rollback, cache purge — these are Cloudflare Pages' product,
   and Cloudflare is already in the design as an edge. Building them ourselves is what makes the
   two KVM8 boxes a hard gate and what makes P4 the biggest phase (10 tickets).
2. **It has a hard technical bet at its centre that Payload does not support.** WSK-04 (RLS
   underneath Payload's query layer) is correctly flagged `opus·high`, but flagging risk is not
   the same as removing it. Payload's own multi-tenancy answer is application-layer, not RLS;
   there is no supported hook that guarantees every Payload query — Local API, REST, admin,
   migrations, jobs — runs on a connection carrying our tenant GUC. This is the one ticket that
   can fail *architecturally* rather than just take longer.
3. **It is missing content-platform table stakes** — most importantly **localization**, on an
   envelope that §05 declares frozen at `/v1` forever. Also absent: pagination shape, error
   envelope, redirects, sitemap, scheduled publishing, on-the-fly image transforms, per-tenant
   outbound webhooks, form file uploads, and any data-protection posture for the third-party PII
   it will hold (Indonesia's UU PDP — we are a **processor** for our clients here, and the plan
   never says so).

Nothing here invalidates the program. The recommended net effect is **a smaller, earlier-shipping
platform**: roughly 36 tickets → ~30, the three procurement-gated tickets reduced to one, and
first real client value moved from wave ~9 to wave ~5.

---

## §01 · Staleness — 19 days of estate drift

| # | Stale claim in v1.0 | Reality 2026-08-26 | Fix |
|---|---|---|---|
| S-1 | "migration = **next-unused number** at merge; head was `0087`" — repeated in §04 and WSK-19 as standing policy | The ledger moved to **timestamp-named migrations** (`YYYYMMDDHHMM_*.sql`). There is no next number to look up. | Amend §04 + WSK-19: name the Zone A mirror migration `<timestamp>_webdev_contract_snapshots.sql`. The whole "number racing" hazard is gone; the `automation_approvals.origin` widen-only DO-block advice still stands. |
| S-2 | "no `webdev` module in `platform-nest/src/modules/`" as a *risk* to verify | Still true — but the module directory has since grown `finance`, `lms`, `monitoring`, `billing`, `agency`, `assistant`. WSK-19's ModuleContract registration now lands into a much busier registry. | Re-verify `contract.ts` + `impact-registry.test.ts` shapes at ticket time; the pattern to copy is now `finance`, not `hr`. |
| S-3 | "the two KVM8 boxes do not exist yet" | Still true for Zone B — but **GDA-AI01** now exists as a second box. | Explicitly rule it **out** as the Zone B staging box unless it is emptied: it hosts OpenClaw multi-tenant workloads, and co-tenanting Zone B with unrelated internet-facing services destroys the containment statement §03 is built on. Worth naming so nobody "saves money" on it later. |
| S-4 | F-1 (MODULES.md heading-vs-table version drift) | Unresolved; registry still shows `webdesk 0.0.0 PLANNED`. | Unchanged — still a junior docs-truth chore, not this program's. |
| S-5 | The `/v1` envelope frozen with no locale axis | Nothing has changed, which is exactly the problem — freezing has not happened yet, so this is the **last cheap moment** to fix it (R-4). | See §03. |

---

## §02 · Industry-standard scorecard

Benchmarks: commercial headless CMS platforms (Contentful, Sanity, Storyblok, Strapi Cloud,
Payload Cloud), agency multi-site platforms (WP VIP, Netlify/Vercel + headless CMS), and the
normal shape of a B2B multi-tenant SaaS.

| Dimension | Industry standard | This plan | Verdict |
|---|---|---|---|
| Trust boundary / zone split | Rare — most agency platforms have one blended zone | Enumerated channels, blast-radius table, two-place impact gate | **Above standard.** Keep. |
| Tenant isolation mechanism | App-layer scoping (Contentful/Storyblok), or DB/schema-per-tenant at low tenant counts | Shared DB + RLS **under a third-party ORM** | **Below standard in feasibility.** Highest-risk decision in the plan → **R-1** |
| Content model + typed clients | Types generated from the CMS's own schema output (`payload generate:types`, sanity typegen, graphql-codegen) | Hand-built vocabulary + hand-built multi-target codegen + byte-determinism gate | **Above standard in rigor, below in build-vs-buy** → **R-3** |
| Localization | Table stakes; first-class in Payload | **Absent entirely**, on a frozen envelope | **Below standard, and time-critical** → **R-4** |
| Preview / visual editing | Per-branch preview URLs (free on Pages/Vercel), live visual preview | Self-built preview slots on our own staging box, `[PROC]`-gated | **Below standard, and self-inflicted** → **R-2** |
| Deploy / rollback of sites | Atomic deploy + one-click rollback + CDN, bought | Self-built promotion engine (`opus·medium`) + Caddy on-demand TLS + purge/warm | **Reinventing Netlify** → **R-2** |
| API surface | REST **+ GraphQL**, cursor pagination, RFC 9457 errors, per-tenant outbound webhooks | REST only; no pagination shape; no error envelope; no tenant webhooks | **Below standard** (§04) |
| Media | On-the-fly transforms via URL params (Cloudflare Images / imgproxy) | Pre-generated responsive variants | Below standard; cheap to fix |
| Forms | Turnstile + rate limit + retention + **file uploads + CRM webhook + consent record** | First three yes; last three absent | Mostly at standard |
| Data protection | Processor/controller split, DSR deletion path, DPA, residency statement | Retention days only | **Below standard for a platform holding clients' customers' PII** → **R-5** |
| Availability | Stated RTO/RPO; the CMS is the only stateful thing | Backups + restore drill + sentinel; **no RTO/RPO, single box, single-disk MinIO** | Below standard; mostly a documentation + R2 fix |
| Unit economics | Per-tenant cost, quotas, overage | **Nothing** — no cost model anywhere in either doc | Below standard (§05) |
| Security controls (keys, RLS, egress, audit, injection posture) | — | Key hashing + pepper, egress allowlist, immutable audit, structural anti-injection | **Above standard.** Keep verbatim. |
| Delivery sequencing | Thin vertical slice to one real customer, then generalize | 6 phases, gate per phase, first *production* value at P2's deferred leg | Below standard → §06 |

---

## §03 · The five rulings

### R-1 — Tenant isolation: stop betting the platform on RLS under Payload

**The problem.** WSK-04 requires FORCE RLS on Payload's own tables with a `webdesk.tenant_ctx`
GUC set per request. For that to hold, *every* query Payload issues must run on a connection that
carries the GUC — including Local API calls from our own services, the admin panel, the jobs
queue, and migrations. Payload/Drizzle uses a pooled connection and does not expose a supported
"wrap every operation in my transaction" seam. The plan's own AC ("cross-tenant probes read ZERO
rows via **every** access path") is the correct bar and is the bar most likely to be unmeetable
without forking the adapter. A fork is a permanent maintenance tax on the component we chose
*because* it was low-maintenance.

**Options.**

| Option | Isolation strength | Cost | Notes |
|---|---|---|---|
| A. RLS under shared Payload (as planned) | Strong *if it works* | High + fork risk | The plan as written |
| B. **Schema-per-tenant, one Payload deployment per tenant, shared control plane** | Strongest (no shared query path at all) | Low per tenant, linear | Agency-scale reality: tens of sites, not thousands. A Payload container is small. |
| C. App-layer scoping (Payload's own multi-tenant approach) + RLS only on **our** tables | Standard | Lowest | Accepts that a Payload access-control bug is a cross-tenant read |
| D. **Split the bet**: Payload becomes per-tenant (B); forms/mail/media/control-plane stay one genuinely multi-tenant NestJS service with real RLS on tables *we* own | Strong where the PII is | Low | RLS lives only where we control every query |

**Recommendation was D.** It would have preserved the security posture exactly where it matters
(form submissions, keys, audit, releases — our tables, our queries, RLS trivially enforceable) and
removed the architectural coin-flip.

> ### ⚖ RULED 2026-08-26 — **Option A: keep RLS under shared Payload.**
> The 2026-07-23 "single shared instance" lock stands. WSK-04 keeps its `opus·high` rating and its
> full AC (zero rows via *every* access path).

**Because the risk is accepted rather than removed, WSK-04 gains three preconditions** — these are
the cheapest available insurance, not a re-argument of the ruling:

1. **A time-boxed feasibility spike precedes the ticket** (≤2 days, `senior-db`): prove a
   per-request `SET LOCAL` tenant GUC survives Payload's Local API, REST, the admin panel, the
   jobs queue, and migrations, on a pooled connection. Deliverable is a probe suite, not a design.
   **Exit criterion: if any access path cannot be made to carry the GUC without patching
   `@payloadcms/db-postgres`, the spike returns to this ruling with evidence** — not to a
   workaround invented mid-ticket.
2. **If a fork/patch turns out to be required, it is a named, versioned, pinned artifact** with an
   owner and an upgrade runbook — a patch-package entry and a CI check that fails when Payload's
   adapter version moves. An unnamed fork is how this becomes a permanent tax silently.
3. **Defence in depth regardless of RLS outcome:** app-layer tenant scoping ships *as well*, so a
   GUC gap is a bug, not a breach. WSK-09's cross-tenant battery probes both layers
   independently (disable one, the other must still return zero rows).

**Fallback trigger (write it down now, not during the incident):** if the spike fails or WSK-04
overruns its estimate by 2×, the program falls back to **Option D** without a fresh design round —
per-tenant Payload schema, RLS retained on our own tables. Everything downstream of WSK-04 is
unaffected by that swap, which is what makes it a safe fallback.

---

### R-2 — Don't host client frontends. Put them on Cloudflare Pages.

Cloudflare is already the edge in this design. Pages/Workers gives, as product: per-branch preview
URLs, custom domains with automatic TLS, atomic deploys, instant rollback, global CDN, and deploy
hooks. The plan builds each of these:

| Plan ticket | What it builds | What Pages already does |
|---|---|---|
| WSK-26 `[PROC]` | preview slots on the staging box, wildcard DNS, slot caps, TTLs | per-branch preview URLs |
| WSK-27 `[PROC]` | `setDomain` → Caddy on-demand TLS + allowlist callback | custom domains + TLS, API-driven |
| WSK-25 `opus·medium` | FE artifact deploy + domain activate + purge/warm inside the promotion engine | atomic deploy + rollback + cache |

**Recommendation:** Zone B boxes host the **backend only** (Payload, API, worker, Postgres,
Redis, media, ClamAV). Client site frontends deploy to Cloudflare Pages, driven by the same
control plane through a Pages-scoped API token held in Zone A.

> ### ⚖ RULED 2026-08-26 — **Adopted.** FE hosting moves to Cloudflare Pages.
> Amendments this forces in [`webdesk-design.md`](./webdesk-design.md): WSK-26 and WSK-27 merge
> into a single `senior-integrator` "Pages deploy + domain adapter" ticket; WSK-25's promotion
> engine drops FE-artifact deploy, TLS activation, and purge/warm (content promotion + deploy hook
> only — re-rate from `opus·medium` at ticket time); §03's Zone B egress allowlist gains the
> **Pages/Cloudflare deploy API** as an explicit destination, with the deploy token held in
> **Zone A** (Zone B never deploys frontends); §12's `[PROC]` set becomes **WSK-28 alone**.
> Preview URLs come from Pages and attach to `customer_feedback` gate rows exactly as D-8
> specifies — the gate machinery is unchanged, only its URL source is.

**Effects:** WSK-26 and WSK-27 collapse into one small `senior-integrator` ticket ("Pages deploy +
domain adapter"). WSK-25's promotion engine shrinks to *content* promotion + a deploy hook — it
probably stops being `opus·medium`. **The [PROC] set drops from 3 tickets to 1** (WSK-28, box ops
baseline), so procurement stops gating the program's shape; only the live *backend* box does.
Trade-off: a Cloudflare dependency for site delivery. Given the design already routes all client
traffic through Cloudflare, this adds a vendor tier, not a vendor.

---

### R-3 — Generate the SDKs from a schema; don't hand-write a multi-target generator

WSK-15 builds composition × vocabulary → TS SDK + OpenAPI + Markdown, with canonical
serialization and a byte-identical double-run CI gate, and WSK-34 adds a PHP target. The
determinism gate is excellent and should stay. The **generator** is the part to shrink.

**Recommendation:** make the pipeline emit **one artifact by hand — `openapi.v1.json`** — and
derive the rest with standard tooling (`openapi-typescript` for TS, `openapi-generator` for PHP,
a spec-to-Markdown renderer for `CONTENT-CONTRACT.md`). Pin tool versions in the WS10-signed
generator image; the double-run byte gate then covers the whole chain and proves *more* than a
hand-rolled generator would. Also consider exposing Payload's GraphQL for internal/console use
while `/v1` REST stays the frozen client contract.

**Effect:** WSK-15 gets materially smaller, WSK-34 (PHP SDK) becomes near-free, and we stop owning
a codegen product.

---

### R-4 — Add a locale axis to the envelope **before** freezing `/v1`

Zero hits for `locale`, `i18n`, or `localization` across both design docs. §05 freezes the
envelope permanently ("envelope evolution means `/v2` as a new path, never a mutation"). Gaiada's
clients are Indonesian; ID/EN sites are the norm, not an edge case. Adding locale after the freeze
means a `/v2` and a migration of every pinned site.

**Recommendation:** before WSK-06 lands, extend v1 with reserved axes:

```jsonc
{ "collection": "case-study", "slug": "acme-rebrand",
  "locale": "id-ID",                      // NEW — required; defaults to the tenant's default locale
  "localizations": [ { "locale": "en-US", "slug": "acme-rebrand-en" } ],  // NEW — sibling links
  "seo":  { }, "meta": { "publishedAt": "…", "updatedAt": "…", "draft": false },
  "blocks": [ ] }
```

…and pin, in the same pass, the three other shapes the plan never defines and will need:
**collection-list pagination** (cursor + `hasMore`), the **error envelope** (RFC 9457 problem
details), and a `meta.x` extension namespace. Payload supports localization natively, so the cost
is mostly in the vocabulary package and the renderer, both of which are unbuilt today. **This is
the single most time-critical item in this document** — its cost rises the moment WSK-06 merges.

---

### R-5 — Name the data-protection posture

The platform stores **our clients' customers'** form submissions: names, phones, emails, message
bodies, and (once file uploads exist) documents. The plan handles this as a retention setting.
Industry treats it as a legal role.

**Recommendation** — a short `§11a` in the design covering:

- **We are a processor**, each client is the controller. That belongs in the client contract, not
  just the architecture (Indonesia's UU PDP No. 27/2022; GDPR-shaped if any client has EU
  end-users).
- **DSR path:** delete/export a single data subject's submissions across a tenant, exposed as a
  control-plane command (WS4-gated, audited) and surfaced in the console. Today deletion only
  happens by time-based retention, which cannot answer a deletion request.
- **Consent record** on form submissions: which notice text and version the submitter accepted,
  stored with the submission.
- **Residency statement** per tenant (where content, media, and backups physically sit) —
  a question clients ask during procurement, and one the R2/MinIO/Cloudflare split needs a real
  answer for.

---

## §04 · Functional gaps (mechanical amendments — no ruling needed)

Each is a small ticket or an AC addition; none change architecture.

| Gap | Why it matters | Where it lands |
|---|---|---|
| **Pagination + error envelope** | Every list endpoint needs them; retrofitting a frozen envelope is a `/v2` | Fold into R-4 / WSK-06 |
| **Redirects + sitemap + robots** | Every real site migration needs redirect management; the SEO dept will ask on day one | New collection in vocabulary v1 (data, not code) |
| **Scheduled publishing** | Standard editorial expectation; Payload supports it | WSK-02/06 AC |
| **On-the-fly image transforms** | Pre-generated variants age badly; Cloudflare Images or imgproxy is the norm | WSK-07 amendment |
| **Per-tenant outbound webhooks** | Clients want submissions in their CRM; without it every integration is bespoke | Small P2 ticket after WSK-12 (reuse the HMAC emitter) |
| **Form file uploads** | Very common client requirement; interacts with ClamAV + retention + size caps | WSK-10 amendment |
| **Content search** | Absent; even basic full-text (Postgres tsvector) is expected | WSK-06 amendment |
| **Per-tenant read quotas / noisy-neighbour limits** | Rate limiting is specified for forms only, not content reads | WSK-05 amendment |
| **Stated RTO / RPO** | Backups exist but no recovery objective; single box + single-disk MinIO | WSK-28 amendment; consider **R2 for all media from day one**, which removes the single-disk risk rather than backing it up |
| **Status page / client incident comms** | Clients notice their own site being down before we do | WSK-28 amendment |
| **Payload governance check** | Payload's ownership changed hands in 2025; MIT is irrevocable for shipped versions, but roadmap and trademark posture affect a 5-year bet — and "rebranding" touches trademark, which MIT does not license | One-hour owner/legal check before WSK-02 |
| **Cloudflare Access for the control vhost** | §03 layer 1 hand-rolls mTLS via synccert; CF Access service tokens + mTLS do this at the edge with no cert-rotation ops | Optional simplification of WSK-22 |

---

## §05 · Unit economics — the missing section

Neither design doc contains a cost model. This is a product sold to clients; before P4 there
should be a one-page `§15 · Cost & quotas`:

- **Per-tenant monthly cost** (compute share, storage GB, media egress, mail volume, Cloudflare).
- **Included quotas + overage** per tier, enforced by the same rate-limit machinery.
- **Break-even tenant count** for the two-box topology — this is what actually answers OQ-W1
  (procurement timing), better than "order the staging box at P3 exit".
- **What web3forms + current site hosting cost today**, so the P2 kill has a number attached.

---

## §06 · Recommended re-sequencing — ship to one real client sooner

The current wave plan reaches the first *production* client value at the deferred leg of P2
(~wave 9) and real hosted sites only after wave 20. Industry practice is a thin vertical slice to
one real customer, then generalize.

**Proposed Milestone 0 — "gaiada.com lives on WebDesk"** (tenant zero, per OQ-W6), pulling
forward only what one real site needs:

```
WSK-01 skeleton → WSK-02 Payload → WSK-03 schema+roles → WSK-04′ (RLS on OUR tables, per R-1)
→ WSK-05 keys → WSK-06 envelope+vocabulary (WITH R-4 locale/pagination/errors)
→ WSK-10 forms → WSK-11 mail → WSK-08′ real gaiada.com site on Cloudflare Pages (per R-2)
→ WSK-09/13 combined QA gate
```

That is ~10 tickets to: our own site running on our own platform, our own forms off web3forms,
with the security walls real. Everything after — codegen, the rail, the ERP console, AI drafting,
WordPress — generalizes a thing that already works in production, instead of a thing proven only
on the dev stack. It also makes the backend box the *only* procurement question, and makes that
question concrete (one real site's load).

Phases 3–6 keep their content and order; they follow Milestone 0 rather than preceding a
dev-stack-only proof.

---

## §07 · What this changes in the Web Dev interface

The console surface in §08 survives — but three of its cards change shape:

1. **Sites tab → environments split.** With FE on Pages (R-2), each site shows *backend env*
   (staging/production content) and *frontend deployments* (Pages previews + production) as two
   distinct columns with independent state. The current single "env chip" model hides the fact
   that content and frontend promote independently.
2. **Contract card gains a locale row.** Pinned `contract@X.Y` + vocabulary version + **enabled
   locales per site** (R-4). Locale coverage ("3 of 5 pages translated") is the kind of status a
   client account manager actually asks for.
3. **New: Data & Privacy card** (R-5) — retention setting, consent notice version, and the DSR
   "find and delete a data subject" action (WS4-gated, audited). This is a new console surface the
   design does not currently have.

Plus one deletion: the preview-slot management UI implied by WSK-26 disappears — Pages preview
URLs become links attached to gate rows.

---

## §08 · Decision summary

| Ruling | Status | Outcome | Cost of deferring |
|---|---|---|---|
| **R-1** tenant isolation model | ⚖ **RULED 2026-08-26** | **Option A — RLS under shared Payload retained.** WSK-04 gains a feasibility spike, a named-fork rule, app-layer defence in depth, and a written Option-D fallback trigger (§03) | — |
| **R-2** FE hosting | ⚖ **RULED 2026-08-26** | **Adopted — Cloudflare Pages.** WSK-26+27 merge; WSK-25 shrinks; `[PROC]` set → WSK-28 alone | — |
| **R-4** locale + pagination + error envelope in v1 | **OPEN — decide first** | Recommended: adopt before WSK-06 | Rises to a `/v2` migration and a re-pin of every site the moment WSK-06 merges |
| **R-3** derive SDKs from OpenAPI | **OPEN** | Recommended: adopt | We own a codegen product forever |
| **R-5** data-protection posture | **OPEN** | Recommended: adopt | Cannot answer a client deletion request; client-contract gap |
| §04 gaps · §05 economics · §06 re-sequencing | Mechanical | Fold in at ticket time | Late discovery during client onboarding |

**Live tracker:** [`../plans/2026-08-26-webdesk-PROGRESS.md`](../plans/2026-08-26-webdesk-PROGRESS.md)
is the source of truth for what is done, on progress, and not done.

**Next action.** R-4 is the only remaining item whose cost is time-sensitive; R-3 and R-5 can be
folded at ticket time. Once R-4 is ruled, the amendments in this document should be applied into
[`webdesk-design.md`](./webdesk-design.md) as a v1.1 revision — this assessment is the rationale
record, not the build document.

*Cross-references:* [webdesk design v1.0](./webdesk-design.md) · [webdev design](./webdev-design.md) ·
[webdev foundation](./webdev-foundation.md) · [BLUEPRINTS index](../BLUEPRINTS.md) ·
[MODULES registry](../modules/MODULES.md)
