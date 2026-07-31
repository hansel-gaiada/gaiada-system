# Search-Marketing Design Addendum — Multi-Vendor Providers, Simulation Mode, Cost Model v2

> **Status:** Ratified design addendum to [`seo-sem-design.md`](./seo-sem-design.md) v1.1.
> **Version:** A1.7 · **Date:** 2026-07-31 (A1.0/A1.1 2026-07-29; A1.1 adds §A8, the SM-33/34/35 ⚡
> gate amendments; A1.2 adds §A9, the SM-36/44 ⚡ gate amendments + P2 readiness — §A4.7 widened to
> pre-existing readers, two of my own claims corrected, one QA-caught tier-4 breach ratified fixed;
> A1.3 adds §A10, the vendor-sandbox provenance ruling + SM-49 + SM-41 amendment;
> A1.4 adds §A11, the incurred-cost ledger ruling — SM-50, with the binding consumer enumeration;
> A1.5 adds §A12, the Google client-account surfaces ruling — SM-51 + the SM-25 decomposition;
> A1.6 adds §A14, echo-validation — the response-vs-request standing rule, tracker §6bc;
> A1.7 adds §A14.5, identity mismatch at a billing point — record the money, refuse the data, tracker §6bi)
> · **Author:** System Architect (Claude)
> **Trigger:** owner directive 2026-07-29 (tracker §6): (1) no live vendor API until staging —
> dev/demo runs a deterministic simulation; (2) three data vendors (Semrush + Ahrefs already paid,
> DataForSEO under consideration), all integration-ready behind `SearchDataProvider`; (3) reuse
> MCP Hub + AI Gateway, never re-implement their logic here.
> **What this amends:** design §05 (provider layer), §12 (phase gating for P2), foundation §8a
> (cost model — superseded in part, see §A3). **What it does not touch:** §04 schema principles,
> §07 AI routing, §11 trust posture, D-1…D-11. The fail-closed money-path posture (tracker §4d)
> is preserved by every ruling below and is a review criterion for every ticket this addendum emits.
> Status vocabulary per [`../modules/MODULES.md`](../modules/MODULES.md) — nothing here is
> "done"; build state lives in the [execution tracker](./seo-sem-execution-tracker.md).

---

## §A0 · Summary of rulings

1. **Phase gating:** OQ-2 (the $50 DataForSEO deposit) is demoted from a *build* gate to a
   *staging acceptance* gate. P2 (SM-14/15/16/17) builds and demos against simulation mode.
2. **Capability × vendor matrix** (§A2): serp→DataForSEO · volume→Semrush · difficulty→annotated,
   never blended, rides the volume pull · suggestions→DataForSEO (scraper $0 fallback) ·
   backlinks→Ahrefs · competitors→Semrush · ai_visibility→DataForSEO. Conflicting metrics are a
   product-ruled display: one source per capability per engagement, provider-labelled, never averaged.
3. **Cost model v2** (§A3): prepaid vendors are priced at an **amortized standard unit rate**
   (plan price ÷ monthly unit allowance); the ledger's meaning becomes **cost-to-serve at standard
   rates**, not cash; an unset unit rate means the driver is **not registered** (never $0); a new
   per-provider monthly ceiling (SM-40) protects the shared subscription allowances.
4. **Simulation contract** (§A4): budget counters are **mode-filtered** (sim spend accrues against
   sim counters through the same gates); cache reads are **mode-symmetric** (`simulated = <mode>`
   predicate — a live read can never serve a simulated row, confirmed, and vice versa); simulated
   data is **kept and badged forever**, never purged for correctness; production cleanliness is an
   environment-hygiene rule, not a purge script.
5. **Boundary ruling** (§A5): vendor SEO APIs only via `SearchDataProvider` drivers through
   `dispatchProviderOp`; AI only via `ai-gateway-go`; MCP Hub serves *our* `search.*` tools and is
   never a client transport to a vendor. **SM-28 (Semrush MCP driver) is re-scoped: deferred —
   superseded by the SM-34 HTTP driver.** Confirmed, with reasons.
6. **Ticket corrections** (§A6): mid-flight amendments to SM-33 and SM-34/35; SM-36/37/38/39
   re-specced with full AC; two new tickets SM-40 (per-provider ceiling) and SM-41 (staging
   real-data acceptance). No new Opus flags — the hazardous patterns now have test-pinned templates.
7. **Vendor sandbox** (§A10): a local server speaking the three vendors' envelopes so the LIVE
   drivers' real HTTP path runs pre-staging — ruled a **test-harness fixture, never a deployable
   environment**. The `simulated` boolean keeps its single meaning; no third provenance value, no
   `sandbox` mode. New invariant: `simulated=false` rows may exist only where real vendor
   credentials exist or in throwaway per-file test DBs. SM-49 builds it; SM-41's checklist is
   unchanged (its *risk* shrinks, not its clauses); a private-host boot guard closes the
   repointed-base-URL hazard.
8. **Incurred cost (§A11):** a provider failure AFTER a billable side effect (DFS `task_post`
   charges at post) writes a NEW-status **`incurred`** ledger row outside the rolled-back
   transaction — `failed` keeps its cost-0 invariant; all four money sums and the monetary
   rollup are status-blind (verified), so the burn binds every budget tier with zero changes to
   them; driver declares billing points dynamically via the SM-42 capture store
   (`recordIncurredCostUsd`); `vendor_ref` column for reconciliation; SM-50 MUST land before
   OQ-11 funds the deposit. Full consumer enumeration: §A11.2.
9. **Google surfaces (§A12):** GSC/GA4/Ads are a THIRD egress class — client-private,
   $0-billed, per-client OAuth: module-internal clients only, never `dispatchProviderOp`, never
   `search_data_cache`; Ads writes stay under SM-21 + WS4. OAuth machine path exercisable
   against local Keycloak + a stateful sandbox token endpoint (SM-51); consent/quota/token-
   longevity/developer-token facts are staging clauses (SM-41G). SM-25 decomposed →
   SM-25a (OAuth core, opus·medium ⚡) / SM-25b (GSC+GA4 reads) / SM-25c (Ads read binding).

---

## §A1 · Phase-plan change (amends design §12 gating)

Design §12 gated P2 on OQ-2 ("needs the $50 DataForSEO deposit"). That gate conflated two things:
*building* the paid-data surfaces and *proving them against a real vendor*. SM-05 already split
those cleanly (mock-server ACs LANDED; real-data AC gated). This addendum applies the same split
to all of P2:

- **SM-14/15/16/17 are unblocked for build** against SM-33 simulation mode. Their in-dev
  acceptance runs the real `dispatchProviderOp` path (cache, single-flight, all five gates, ledger)
  with simulated providers and synthetic dollars.
- Each P2 ticket's **real-data clause moves to SM-41** (§A6), a single staging-phase acceptance
  ticket that runs one real pull per capability per credentialed vendor and reconciles the ledger
  against the vendor's own console.
- **OQ-2 is restated:** "fund the DataForSEO deposit" is now one of three per-vendor staging
  prerequisites (§A7) and blocks only SM-41's DataForSEO rows. It no longer blocks any build ticket.
- Wave-2 order (supersedes tracker §3 steps 8+ for sequencing): SM-33 ∥ SM-34/35 (in flight) →
  SM-36 → SM-40 ∥ SM-37 → SM-38 → SM-39 → SM-17 → SM-14 ∥ SM-15 → SM-16 → SM-41 (staging, per
  vendor as credentials land). Respect the 1–2 agent concurrency cap throughout.

---

## §A2 · Capability × vendor matrix (input to SM-36)

### The ruling

Per-capability **platform default preference lists** (ordered; dispatch falls through only to a
*registered + capable* provider; an explicit per-engagement override remains an operator
instruction — honor it or refuse, never substitute, exactly as `resolveProvider` already enforces):

| Capability | Authoritative | Fallback order | Why |
|---|---|---|---|
| `serp` (rank capture) | **DataForSEO** | **none — refuse if unregistered** | The only true on-demand SERP-measurement API of the three: a fresh, per-location/device SERP fetch per request, PAYG per task. Semrush/Ahrefs positions data are *database snapshots* on the vendor's own refresh schedule — different product semantics. Silently substituting a snapshot for a live capture would change what a client report's "position" means, so serp does not auto-fall-back; if DFS is unregistered the pull refuses visibly. |
| `volume` | **Semrush** | dataforseo → ahrefs | Already paid (marginal cost ≈ one API unit vs real DFS dollars), and it is the number the team already quotes from the Semrush UI — the ERP disagreeing with the tool operators cross-check in generates permanent "why is this different" noise. DFS Keywords-Data volume (the literal Google Ads planner number) stays available as a per-engagement override for SEM planning parity — the mechanism (`tool_scope.provider`) already exists. |
| `difficulty` | **provider-annotated, never blended** — rides the volume pull, so its source = the engagement's volume provider (default Semrush) | (with the volume pull) | Semrush KD% and Ahrefs KD are *different formulas on different scales* (Semrush: authority/link profile of ranking pages; Ahrefs: referring domains needed for top-10). They are not the same number and must never be averaged, mixed within one keyword set, or displayed unlabelled. See conflict ruling below. |
| `suggestions` | **DataForSEO** (Labs) | scraper ($0) | Bulk idea generation is exactly the programmatic volume that eats a subscription's unit allowance; PAYG per-item maps to the per-client meter (Labs ≈ $0.012/task + $0.00012/item). The free `scraper` driver (autocomplete/PAA) remains the $0 floor. Semrush related-keyword reports may join the list once its per-line unit cost is confirmed (§A7) — adding a capability later is additive. |
| `backlinks` | **Ahrefs** | semrush → dataforseo | Its link index is the reason the team pays for Ahrefs; already paid. Authority metrics (Ahrefs DR / Semrush AS / DFS rank) are different scales — same never-blend rule as difficulty: stored with provider annotation, one source per engagement. |
| `competitors` | **Semrush** | ahrefs | Organic-competitor/gap analysis is Semrush's historical strength and the team's current workflow. Not a standalone `OpKind` in v1 (rides Labs/metrics pulls) — this row is forward-looking for when it becomes one. |
| `ai_visibility` | **DataForSEO** (Google AI-mode/AI-Overview SERP surface, as the SM-05 driver already reads) | **none — refuse** | Per-query PAYG suits per-engagement cadence. Semrush (AI toolkit) and Ahrefs (Brand Radar) both have AI-visibility *products*, but their API exposure is unverified (§A7) — do not advertise the capability on those drivers until verified. Non-Google engines (ChatGPT/Perplexity/…) arrive as future drivers under this same capability, per design §05. |

Mechanically this becomes `config.search.capabilityPreference: Record<Capability, ProviderKey[]>`
(env-overridable), consulted by SM-36's cascade at the *platform default* tier. The engagement and
tenant tiers keep today's single-key semantics. The cache already keys on provider class
(`buildCacheKey(provider.key, op)`), so cross-vendor cache contamination is structurally impossible
— switching a client's preferred vendor never serves them another vendor's cached numbers. That
existing property is load-bearing; SM-36 must not weaken it.

### The conflict ruling (product decision — binding on every UI ticket)

When two vendors have been fetched for the same metric and disagree (difficulty is the canonical
case; volume and authority scores equally):

1. **One source of truth per capability per engagement.** The engagement's resolved provider for
   that capability supplies the headline number everywhere — workbench, console, report.
2. **Every vendor-sourced metric renders with its provenance** ("KD 45 · Semrush"), backed by
   provider columns on the tenant rows (§A6, SM-36's migration adds `metrics_provider` to
   `search_keywords`; snapshot tables already carry `provider`).
3. **Never blend, never average, never silently swap.** A second source's number may appear only
   in an explicit internal "compare sources" affordance in the workbench — never as the headline,
   and **never in a client-facing report**, which shows one provider's figure plus a methodology
   footer naming the data sources used.
4. Changing an engagement's preferred provider for a capability is a scope-config event
   (`search:scope:write`, visible in the scope editor) — historical rows keep their original
   provenance; the console must not retro-label old numbers with the new provider.

This is not left to whoever writes the UI: SM-38 and every P2/P3 surface ticket inherit clauses
1–4 as acceptance criteria.

### Stated uncertainty (do not treat the matrix as vendor-verified)

The matrix is a **policy default, deliberately config-repointable without code change**, because
three vendor facts are unverified from this desk: (a) the team's Semrush plan tier — the Analytics
API historically requires the Business tier plus purchased API units; lower tiers have no API;
(b) whether the team's Ahrefs plan includes API v3 at all — historically Enterprise-gated, newer
plans sell API access separately; (c) API exposure of Semrush/Ahrefs AI-visibility products.
Resolution: the owner reads the two account consoles (§A7). If either paid account turns out to
have no API access, the matrix degrades gracefully — that vendor's driver simply never registers
(keyless-disable, SM-06 pattern) and the preference lists fall through.

---

## §A3 · Cost model v2 (amends foundation §8a; supersedes its per-client arithmetic)

### The problem

`estimateCostUsd` is a pure, synchronous pre-dispatch input to the fail-closed budget stop-loss.
DataForSEO bills USD per call — estimate ≈ truth. Semrush and Ahrefs bill **API units against a
subscription**: the marginal cash cost of one more call is $0 until the allowance exhausts. Two
naive treatments both fail: pricing prepaid calls at $0 disarms every budget tier for two of three
vendors (the §4d fail-open class, arriving through config instead of code); pricing them at ad-hoc
made-up figures makes the ledger meaningless.

### The ruling — amortized standard rates, uniform stop-loss semantics

1. **Per-op USD for prepaid vendors = the standard unit rate:** plan monthly price ÷ plan monthly
   unit allowance × units this op consumes. The derivation is written in the config comment with
   the two owner-supplied inputs named (plan price, allowance). The stop-loss keeps operating on
   USD uniformly — no second code path, no per-vendor branching in `evaluateBudget`.
2. **Why amortized rather than marginal-$0:** the stop-loss's real job is bounding consumption of
   an exhaustible shared resource, not only cash. A subscription allowance is exactly such a
   resource — also consumed by the team's *interactive* use of the same accounts. Amortized USD is
   proportional to units by construction, so a USD cap bounds units exactly.
3. **Fail-closed rule: an unset or non-positive unit rate means the driver does not register**
   (per-vendor keyless-disable log, SM-06 pattern). It must never default to $0 — a $0 rate
   silently disarms every budget tier for that vendor. This is a mid-flight AC addition to
   SM-34/35 (§A6).
4. **Estimates are upper bounds.** Where a vendor bills per row/line and the row count is unknown
   pre-dispatch (Ahrefs), the estimate assumes the op's bounded maximum; true-up adjusts downward
   from response metadata where the vendor exposes actual units consumed (both vendors are believed
   to expose consumption in responses/headers — verify at implementation; where unverified, the
   conservative estimate stands as final).
5. **New budget tier — per-provider monthly ceiling (SM-40):** evaluated engagement → tenant →
   **provider** → global. For prepaid vendors the provider cap is the ERP's *reserved share* of the
   allowance in amortized USD (default reservation 50% of the plan, env-tunable — the other half is
   the humans' interactive usage, which the ERP cannot see and must not starve); for DataForSEO it
   is the deposit-burn ceiling. Cross-tenant sum ⇒ same treatment as `sumGlobalMonthToDate`:
   exported shape-pinned SQL, ratified allowlist entry, TTL cache, and a fail-closed
   `unavailable ⇒ refuse` error — reuse the SM-04/§4d template verbatim.
6. **The global cap's meaning shifts** from "cash out the door" to "total platform cost-to-serve
   at standard rates" (the cash-exposure bound specifically is the DataForSEO provider cap, the
   only PAYG vendor). `SEARCH_GLOBAL_MONTHLY_CAP_USD=150` remains a sane default.

### What the per-client ledger now *means* — and what replaces $8–10/client/mo

- A `search_provider_calls.cost_usd` row is **cost-to-serve at standard rates** — the basis for
  per-client billing, fairness caps, and margin analysis. For PAYG vendors it coincides with cash.
  Cache hits stay $0 (a hit consumes neither cash nor units). The `search.provider_cost.month`
  rollup keeps working unchanged; its label should read "cost-to-serve".
- The platform's actual monthly cash is now **two lines: fixed subscriptions** (Semrush + Ahrefs
  invoices, sunk regardless of usage) **+ marginal PAYG** (DataForSEO ledger sum, if adopted).
- The foundation's blended "~$8–10/client/mo, ~$800/mo DFS at 100 clients" model is **superseded**:
  with Semrush+Ahrefs prepaid, DataForSEO cash shrinks to the capabilities where it is
  authoritative (serp, ai_visibility, suggestions). The replacement blended figure is
  **computed, not assumed**: `(fixed subscriptions + PAYG cash) ÷ active engagements`, reported by
  a rollup, recomputed after the first month of staging under real cadences. Do not quote a new
  per-client dollar figure until then — simulation telemetry proves the *pipes*, not the *usage mix*.

---

## §A4 · The simulation contract (rulings on SM-33's open points)

**Mode is platform-global** (`config.search.providerMode: 'live' | 'simulate'`, default `live`,
per SM-34's wiring). Provenance is a `simulated boolean NOT NULL DEFAULT false` on
`search_provider_calls` and `search_data_cache` (migration 0047, SM-33). `DEFAULT false` is
load-bearing: every pre-0047 row was produced in live mode, and a NULL-vs-false mismatch in a
budget WHERE clause is a fail-open (§4d class).

1. **Budget counters are mode-filtered — same gates, disjoint ledgers.** `sumMonthToDate` and
   `sumGlobalMonthToDate` (and SM-40's provider sum) gain `AND simulated = <current mode>`. In sim
   mode, budgets bind against simulated spend — so the stop-loss demo is the *real* choke-point
   refusing on *real* arithmetic, which is the whole point. In live mode only real rows count — a
   mode flip can neither refuse real clients for phantom dollars nor let sim history mask real
   spend. Failure-direction analysis: a wrong filter in sim mode under-counts sim spend (demo lies,
   $0 real risk — still AC-pinned); a wrong filter in live mode that *includes* sim rows
   over-counts and refuses early (fail-closed direction); the only fail-open shape is live mode
   *excluding real rows*, which the NOT NULL DEFAULT false + the mixed-table AC below forecloses.
   ⚠️ `GLOBAL_MTD_QUERY_SQL` is shape-pinned by `ledger.test.ts` as the enforcement half of a
   ratified allowlist — the implementer must amend the shape assertion *deliberately*, never work
   around it; the amended pin (still single scalar aggregate, read-only) carries the ratification
   forward.
2. **Cache cross-mode reads: forbidden, and symmetric — the implementer's instruction is
   confirmed and extended.** Mechanism ruling (SM-33 offered key-on-mode vs refuse-cross-mode):
   a **`simulated` column + equality predicate** in `readFreshCache` (`AND simulated = <mode>`),
   not a key-string change. A live read serving a simulated row would put an unlabelled plausible
   number in front of a client — the most expensive kind of lie; a sim read serving a live row
   would silently misrepresent what simulation mode is and poison determinism. The PK stays
   `cache_key` alone: after a mode flip, a write for the same key overwrites the other mode's row
   *with payload and flag updated atomically* — provenance can never mismatch payload; the cost is
   cache churn on a rare, deliberate environment event, which is acceptable and documented.
3. **Mode/driver mutual exclusion at registration.** `main.ts` (SM-34's wiring surface) registers
   simulation providers **only** in simulate mode and real drivers **only** in live mode;
   registering a simulation provider in live mode is a boot error, not a warning. This is the
   structural guarantee behind "no simulated row can be created in live mode" — stronger than any
   per-dispatch check.
4. **Transition: keep + badge forever; no purge for correctness.** Simulated rows are audit
   history of demos and tests; rulings 1–2 make them permanently inert to live-mode money and
   cache paths, and SM-38's chip badges them permanently in any historical view. The
   staging→production transition is an environment boundary, not a data migration: **a production
   database starts from migrations + seeds, never from a copy of a simulated-era database** (one
   ops-runbook line, owed by SM-23). Flipping a long-lived env sim→live requires no purge;
   `DELETE FROM … WHERE simulated` is documented as optional cosmetic cleanup only. Quarantine
   tables are over-engineering — rejected.
5. **Simulated prices use real rate tables.** Sim drivers price ops from the same constants as the
   real drivers (`DFS_RATES`; SM-34/35's configured unit rates when set, else a clearly-named
   `PLACEHOLDER` constant never asserted as vendor truth). Otherwise SM-29's cost projections and
   the stop-loss demo diverge from staging behaviour, which defeats the demo's purpose.
6. **Determinism is contractual:** same query ⇒ same output, forever (seeded from the query
   string, per-vendor divergence included, as SM-33 already specs). Tracked-rank `bypassCache`
   pulls stay stable under this rule.

---

## §A5 · The MCP / AI-Gateway boundary ruling (binding; cite this section against drift)

- **B-1 · Vendor data:** every vendor SEO API (Semrush, Ahrefs, DataForSEO, any future) is reached
  **only** via a `SearchDataProvider` driver inside `platform-nest/src/modules/search/providers/`,
  dispatched **only** through `dispatchProviderOp` — the single money choke-point. No vendor SDK,
  no MCP connector, no n8n HTTP node, no UI-side call, no exceptions for "just a read".
- **B-2 · AI:** every inference/embedding call goes through `ai-gateway-go` (`/complete`,
  `/embed`); `providers/gateway-client.ts` is this module's sole AI egress (already test-enforced).
  Corollary for GEO: if any driver ever needs an LLM to *judge* fetched text, that inference is a
  gateway call — never a direct OpenAI/Perplexity/Anthropic call from this module.
- **B-3 · MCP Hub:** the hub aggregates *our* `search.*` tools from `ModuleContract.mcpTools` and
  serves them to agents. It is a **server of our tools, never a client-side transport to a
  vendor**. Nothing module-side may reach a vendor *through* the hub or any MCP connector.
- **B-4 · n8n:** flows call `search.*` MCP tools only (backbone rule, design §10) — never a vendor
  API, never the gateway.

### SM-28 (Semrush MCP "premium driver") — re-scope CONFIRMED

Re-scoped to: **deferred — superseded by the SM-34 HTTP driver.** Reasons, in force order:

1. **Two Semrush paths = two cost meters.** The MCP-connector path structurally bypasses
   `dispatchProviderOp` — no scope gate, no stop-loss, no ledger, no cache. It is a fail-OPEN
   money path by construction: exactly the defect class the §4d gate exists to catch, arriving as
   architecture instead of a bug.
2. **Wrong trust zone.** The connector is a claude.ai *user-level* OAuth integration — its
   credential lives in a chat product, not in server config, and cannot be platform key custody
   (§11: keys are platform-nest env → OpenBao).
3. **It buys nothing.** SM-34 provides Semrush behind the abstraction, metered, cached, budgeted.

Residual legitimate use: the claude.ai Semrush connector may serve **interactive human/Claude
research sessions** — and its output must never be ingested into `search_*` tables. OQ-3 is
restated accordingly: it no longer gates any platform work; the Semrush staging prerequisite is
plan-tier/unit confirmation (§A7), not connector OAuth. Foundation §8's line "register `open-seo`
MCP + Semrush MCP connector as paid source" was already superseded by design §06/D-2 and is now
doubly so — recorded here so no future session resurrects it.

---

## §A6 · Ticket corrections (tracker §6 drafts, reviewed)

Tier/model = agent-army seat defaults unless flagged. **No new Opus flags in this wave**: the two
hazardous patterns it touches (cross-tenant money aggregates, mode-filtered budget WHERE clauses)
now have established, test-pinned templates from SM-04/§4d, and every money-path ticket carries a
⚡ gate. SM-21 (opus·high) and SM-25 (opus·medium) retain their existing flags unchanged.

### SM-33 ⚡ — senior-be — **IN FLIGHT: the following are mid-flight amendments, not a rewrite**

Draft confirmed (deterministic seeded simulators per vendor key, real-dispatch flow, provenance on
ledger + cache, migration 0047, SM-34 owns wiring). Amend:

- **A1 (closes a draft gap): budget sums are mode-filtered.** The draft's "a budget cap still
  refuses" did not say *which rows count*. Apply §A4.1: `simulated = <mode>` in `sumMonthToDate`
  and `sumGlobalMonthToDate`; column `NOT NULL DEFAULT false` on both tables. **New AC:** with a
  mixed table (real rows from a previous mode present), sim-mode MTD sums only sim rows and
  live-mode MTD sums only real rows — pinned in both directions. `GLOBAL_MTD_QUERY_SQL` +
  its shape-pin test amended deliberately (§A4.1 warning), never bypassed.
- **A2: cache mode predicate is symmetric** (§A4.2): `readFreshCache` gains
  `AND simulated = <mode>`; `writeCache` stamps the mode; PK unchanged; overwrite-across-modes
  documented. **New AC:** a fresh row written in one mode is invisible to a read in the other, both
  directions.
- **A3: sim pricing from real rate tables** (§A4.5). **New AC:** dataforseo-sim `estimateCostUsd`
  equals `DFS_RATES` arithmetic for every op kind.
- The ⚡ gate review must specifically inspect the two WHERE clauses (A1/A2) — a missed predicate
  here is the §4d class.

### SM-34 + SM-35 — senior-be, one agent — **IN FLIGHT: mid-flight amendments**

Draft confirmed (drivers speak HTTP only; mock-server tests, injected `fetchImpl`, no
credentials; SM-34 owns `ProviderKey` widening + config + `providerMode` wiring + registration;
default mode `live`; capability sets **as drafted** — `ai_visibility` deliberately absent from
both, `suggestions` deliberately absent from Semrush pending §A7 unit costs). Amend:

- **B1: unset/non-positive `costPerUnitUsd` ⇒ driver not registered** (§A3.3). **New AC:** a
  configured Semrush credential with no unit rate logs the keyless-disable line and registers
  nothing; no code path can yield a $0 estimate from an unconfigured rate.
- **B2: estimates are upper bounds** (§A3.4): where rows/lines are unknown pre-dispatch, estimate
  the op's bounded max; true-up downward from response consumption metadata where available (add a
  mock asserting it when the vendor envelope carries it; skip-with-comment where unverified).
- **B3: registration mutual exclusion** (§A4.3): live mode never registers simulation providers,
  simulate mode never registers real drivers; violation is a boot error. **New AC** (lands here
  because SM-34 owns `main.ts`).
- **B4:** the unit→USD derivation comment must name its two owner-supplied inputs (plan price,
  allowance) as UNVERIFIED until §A7 resolves them — no invented vendor figures asserted as fact.

### SM-36 ⚡ — per-capability provider preference — medior (re-specced)

Deps SM-34/35 (hard); SM-33 makes the cascade demoable on the dev stack (soft). Scope:

- `config.search.capabilityPreference` seeded from the §A2 matrix (env-overridable). Cascade:
  engagement per-tool override (single key, honor-or-refuse, **unchanged semantics**) → engagement
  default → tenant default → **platform per-capability ordered list**, falling through only across
  registered+capable providers. `serp` and `ai_visibility` lists are length-1 by policy (§A2) —
  they refuse rather than substitute.
- **Additive migration 0048** (one nullable `metrics_provider text` + `metrics_simulated boolean
  NOT NULL DEFAULT false` on `search_keywords`) so keyword volume/difficulty/CPC carry provenance
  (§A2 conflict ruling clause 2; SM-38 needs it). No RLS change, additive only — senior-db eyes on
  this migration at the ⚡ gate.
- **AC:** explicit override to an unregistered/incapable provider still refuses (regression-pin
  today's behavior); platform list falls through to first registered+capable and the ledger row
  records the provider actually billed; per-capability defaults match §A2 byte-for-byte; serp with
  DFS unregistered refuses rather than falling back; metrics writes stamp `metrics_provider`;
  cache-key-includes-provider property regression-pinned (§A2 "load-bearing").

### SM-37 — demo seed — junior (confirmed; correction is RETROACTIVE — it reached DEV-VERIFIED mid-review)

Scope confirmed as drafted and as landed (engagement, property, keyword sets with clusters +
intent labels, ingested audit with findings, KPI targets, brief; idempotent; **no rank-history
rows** — those arrive via SM-14's real ingest path; no keyword metric values seeded, so nothing
violates the provenance rule today). Retroactive correction, standing for any future seed
extension: a seeded metric value on keywords MUST set `metrics_simulated = true` + a plausible
`metrics_provider` (needs 0048 ⇒ after SM-36) — provenance is the only honest marker and must be
present, or the value must not be seeded at all.

### SM-38 — simulated-data badging — senior-fe (confirmed tier; AC made concrete)

Deps SM-33 (ledger/projection provenance) + SM-36 (0048 keyword provenance). AC:

- Chip renders **adjacent to each provenance-carrying number** (ledger rows, cost projections,
  keyword volume/difficulty), not merely page-level; engagement header states platform mode when
  simulate.
- §A2 conflict clauses 1–4 applied to every touched surface (provider label next to metric).
- Every fetcher shape-guards the provenance fields, and **each rendered field is verified against
  the controller's actual SELECT and response envelope** — not the fixture, not the TS interface
  (the §4i lesson, now an AC).
- A surface whose backend genuinely lacks provenance shows no chip and no claim either way, and
  files the gap naming the owning ticket (BackendPending discipline) — silence must never read as
  "real".

### SM-39 — boundary audit — senior-integrator (slimmed: the ruling is §A5; this ticket proves obedience)

- **Egress-inventory test:** the only outbound hosts reachable from `src/modules/search/` are the
  gateway URL (via `gateway-client.ts`) and vendor base URLs via driver `fetchImpl` paths —
  extend the gateway-client sole-egress pattern to the whole module.
- Verify the 18 `search.*` mcpTools aggregate via `GET /mcp/tool-defs` on the live stack.
- Apply the doc edits this addendum owes the tracker: SM-28 row → "deferred — superseded by SM-34
  (addendum §A5)"; OQ-3 restated; §0/§1 P2 rows → "build unblocked vs SM-33 sim; real-data AC →
  SM-41". AC: tracker rows match this addendum; tests green.

### SM-40 · **NEW** — per-provider monthly ceiling — senior-be ⚡ — deps SM-34/35

§A3.5. `config.search.providerMonthlyCapUsd` per vendor; `evaluateBudget` gains the provider tier
(engagement → tenant → **provider** → global); cross-tenant per-provider MTD sum built on the
SM-04 template: exported shape-pinned SQL, reasoned `lint:withtenants` allowlist entry (submit for
ratification at the ⚡ gate), 30s TTL cache, fail-closed `unavailable ⇒ refuse` with a cost-0
audit row. Mode-filtered per §A4.1. **AC:** breach at the provider tier refuses + emits
`search.provider.budget_threshold` with `tier:"provider"`; an uncomputable provider sum refuses
(never degrades to $0); unset cap ⇒ tier skipped (matches tenant-tier semantics); interim safety
argument recorded: until this lands, prepaid consumption is still bounded by the global cap.

### SM-41 · **NEW** — staging real-data acceptance — qa — GATED per vendor (§A7)

Absorbs every P2 ticket's and SM-05's "real data" clause. Per credentialed vendor on staging: one
real pull per advertised capability through the full dispatch path; assert parse, provenance
`simulated=false`, ledger row, and **reconcile ledger cost against the vendor console's own
reported consumption** (the estimate-vs-truth check that proves §A3 arithmetic). AC: a
per-vendor/per-capability checklist lands in the tracker with pass/fail + measured deltas;
any estimate deviating >20% from vendor-reported consumption is ticketed before that vendor
serves real engagements.

---

## §A7 · Open questions — genuinely the owner's

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| OQ-9 | **Semrush plan facts:** exact tier (API is believed Business-gated), monthly API-unit allowance, unit price list from the account console | SM-34 registration in staging; §A2 suggestions-list revisit | Driver stays unregistered (keyless-disable); simulation covers dev |
| OQ-10 | **Ahrefs API access:** does the current plan include API v3 (historically Enterprise-gated / separately sold)? Allowance + row-unit price table | SM-35 registration in staging | Same — unregistered until confirmed |
| OQ-11 | **DataForSEO adoption:** fund the $50 deposit (ex-OQ-2, now staging-only)? Without it, `serp`/`ai_visibility` have no live provider by §A2 policy (they refuse rather than substitute) | SM-41 DFS rows; live rank tracking + GEO | Hold; simulation covers dev/demo indefinitely |
| OQ-12 | **Allowance headroom:** ratify the 50% default ERP reservation of each subscription's units (§A3.5), or set another fraction | SM-40 config default | 50% |

---

## §A8 · Gate amendments — SM-33/34/35 ⚡ design review (2026-07-29)

Rulings issued at the wave-2 gate (tracker §6c is the full record). Two of A1.0's rulings were
wrong or under-scoped in contact with the code; they are corrected here rather than papered over.

1. **§A3.3 scope clarification (placeholder rates RATIFIED).** "Unset rate ⇒ driver not
   registered" governs **live vendor drivers only** — its purpose is preventing unmetered real
   spend, a failure a simulator cannot produce. Simulation pricing is governed by §A4.5, which
   already licenses a clearly-named `PLACEHOLDER` fallback. The `PLACEHOLDER_*_USD_PER_UNIT`
   constants in `simulation.ts` are ratified on this containment invariant: they are computed
   through the live drivers' own derivation functions, are reachable **only** from the simulation
   pricing path (live factories return `null` on a non-positive rate — two-layer, test-pinned), and
   every number they price is necessarily created by a simulated driver and therefore carries
   `simulated = true` through ledger, cache, projection and rollup. **A placeholder-priced figure
   can never appear anywhere without the simulated flag traveling with it** — that, not the
   constant's name, is what stops it being read as a real rate. Config supersession is test-pinned
   (`simulation.test.ts` "a configured plan rate REPLACES the placeholder").
2. **§A4.1 was under-enumerated — superseded by a coverage rule (new §A4.7).** A1.0 named only the
   two stop-loss sums; the `search.provider_cost.month` rollup (monetary, exec-facing) was found
   unfiltered by accident, and the snapshot tables (item 3) are a second instance of the same
   under-enumeration. **Rule: every code path that reads, aggregates, or persists provider-derived
   rows must state its mode handling (filter, stamp, or badge) in its ticket's AC — silence fails
   the gate.** Complete surface inventory as of 0047: `sumMonthToDate` (filtered) ·
   `GLOBAL_MTD_QUERY_SQL` (filtered, shape-pinned) · rollup `search.provider_cost.month` (filtered)
   · `readFreshCache` (filtered) · `writeCache`/`insertLedgerRow` (stamped) · `trueUpLedger`
   (mode-inherent: updates one row by id, never touches its flag) · cost-projection (per-tool
   `simulated` + `providerMode`, additive) · SM-17's future usage surface (AC inherits badge duty)
   · SM-14/16's future snapshot persistence (item 3). `search_campaign_metrics_daily` (SM-20) is
   outside the provider-mode domain — external import, never dispatched — but any future demo seed
   touching it inherits SM-37's retroactive provenance rule.
3. **§A4.4 promised what the schema could not deliver — 0048 scope extended.**
   "Badged forever in any historical view" is unimplementable for rank/backlink/AI-visibility
   history: `search_rank_snapshots`, `search_backlink_snapshots`, `search_ai_visibility` carry
   `provider` + a **nullable** `provider_call_id` but no `simulated` column, so SM-14/16 would
   persist synthetic payloads with nowhere to stamp the provenance `DispatchResult.simulated`
   exists to hand them. Deriving it at read time through the nullable FK is the §4i
   confident-wrong-answer shape — rejected. **SM-36's migration 0048 gains
   `simulated boolean NOT NULL DEFAULT false` on all three snapshot tables** (still additive, same
   senior-db eyes), and SM-14/16 AC: every persisted snapshot stamps it from `DispatchResult.simulated`.
4. **The amended `GLOBAL_MTD_QUERY_SQL` shape pin: ratification CARRIES FORWARD.** The query is
   still one scalar aggregate, read-only, single statement, no client-private column
   (`simulated` is platform provenance, not tenant data); the mode predicate is parameterized with
   exactly one placeholder, no `OR`, exactly one `AND` — the amended pin is stricter than the
   original. The per-mode TTL cache key is a **necessary consequence** of §A4.1, not an independent
   decision: A1 made the cached quantity mode-dependent, and a cache in front of a function must
   key on every argument its value depends on. Both confirmed.
5. **The rollup mode filter (current-mode) is RATIFIED, with its boundary stated:** correct in both
   directions because live-mode rows are `simulated = false` by construction (boot-time mutual
   exclusion + the dispatch OR-stamp), so under live mode the filter excludes only formerly-sim
   history, and under simulate mode the demo total is the honest answer. The boundary: after ANY
   mid-month mode flip the rollup reports only the current partition — acceptable because a flip is
   an environment-rebuild event (§A4.4), never a runtime toggle on an env with real spend; if both
   lines are ever wanted, add a second metric (`search.provider_cost.month.simulated`), never a blend.
6. **Line-keyed lint allowlist: my "arguably the right bias" claim (SM-11 review) is empirically
   WRONG — reversed.** Three re-points (70→80→124→162) in two days, each done mechanically by the
   editor in passing; a line shift forces a re-point, not a re-look, while the real invariant is now
   content-enforced by `ledger.test.ts`. **Ruled: re-key entries by file + first-argument source
   text + expected match count (exactly 1), keeping the stale-entry warning** — a new cross-tenant
   call with different arg text still fails, a second identical call trips the count, and edits
   elsewhere in the file stop invalidating ratified entries. Ticketed as SM-43.
7. **Ahrefs true-up (B2 carry-over): acceptable to ship, deadline set, own ticket.** Billing at the
   conservative estimate fails safe (over-count refuses early), but it overstates Ahrefs
   cost-to-serve — which biases per-client fairness caps, margin analysis, and the §A3 computed
   blended figure. **SM-42 (new, senior-be) owns the `SearchDataProvider` true-up seam and MUST land
   before SM-41**, because SM-41's ledger-vs-console reconciliation and §A3's first-staging-month
   recompute are what the bias would poison. Not SM-40's: the ceiling tier and an interface change
   are different invariants under different review focus. Corollary correction: SM-35's "estimates
   equal the true cost of the exact calls" **overclaims** — Ahrefs per-field cost classes (some
   fields 5–10 units, not 1) are unverified for the exact `select=` list, so the volume estimate is
   not proven an upper bound; SM-41's Ahrefs row must reconcile that op explicitly (the ≥20% delta
   tripwire already ticketed).
8. **Minor divergences ticketed (SM-44, junior):** `writeCache`'s `simulated` parameter defaults to
   `false` while `readFreshCache` made it required — the same "forgot the mode" hazard, open on the
   write side, in the under-labelling (expensive) direction; make it required. The DFS simulator
   prices `serp`/`ai_visibility` at the Standard rate unconditionally while the live driver is
   queue-dependent — read `config.search.dataforseo.queue` in `estimateFor` so a live-queue demo
   prices like staging. Ahrefs advertises `serp` while `rankTrackerProjectId` is unset, a capability
   it structurally cannot serve (refusal is loud and pre-network, but projection prices $0 for an
   impossible pull) — drop `serp` from the advertised set at construction when the id is absent
   (SM-06 keyless-disable pattern at capability granularity).

---

## §A9 · Gate amendments — SM-36/44 ⚡ design review + P2 readiness (2026-07-29)

Rulings issued at the wave-3 gate (tracker §6j is the full record, incl. the P2 inherited ACs and
build order). Two of my own prior claims were wrong on contact with the code and one defect passed
my read and was caught by the QA half — recorded here, not papered over.

1. **Tier-4 empty-list fallback: a REAL §A2 breach, found by the QA half, fix RATIFIED.**
   `resolveProvider`'s tier 4 fell back to `config.search.defaultProvider` — a *different vendor* —
   when `capabilityPreference[capability]` was empty or missing, and a pre-existing test pinned that
   fallback as correct (exercised only for `volume`, where substitution is permitted). Unreachable
   via env (`preferenceList()` guarantees non-empty) but reachable by any future capability added
   without a preference entry and by direct config mutation. **Ruled: an empty or missing preference
   list refuses (`NoCapableProviderError`) — uniformly, for every capability.** An empty list is a
   misconfiguration; honoring it with a silently-chosen vendor is the §A2 violation class, and
   tier 3 (`tenantDefaultProvider`) remains the explicit route if an operator really wants one key
   everywhere. The original branch comment called this fallback "defensive fail-closed" — the
   fail-direction analysis was wrong (substitution is fail-OPEN for no-substitute capabilities),
   **and my design half read that branch and its test and accepted the comment's framing**. The
   adversarial half caught what the design half rationalized; that division of the gate is working
   as designed and stays.
2. **A safety invariant in env-overridable config: the data mechanism is ACCEPTED, with one
   enforcement change.** Seeding "serp/ai_visibility never substitute" as length-1 lists is the
   right mechanism — a rule expressed as data cannot be forgotten by the next branch editor, and
   the §A2 matrix stays legible in one place. But `SEARCH_PREFERENCE_SERP`/`_AI_VISIBILITY` let a
   well-meaning operator widen — or worse, *repoint* (`=semrush` is a silent product-semantics
   swap) — with no design gate, and the only guard was a comment at the point of temptation, which
   this program has proven three times is not a guard. **Ruled: remove the env parse for exactly
   those two keys** — hardcode the §A2 literals with the no-widen comment (SM-46d). Widening then
   requires a code change, which is precisely the design-decision gate §A2 demands; an env var
   whose only ratified value is its default is an attractive nuisance. The other five lists stay
   env-overridable (that repointability is genuinely needed while OQ-9/10 are open — operators are
   trusted with far larger levers, e.g. `SEARCH_PROVIDER_MODE`). Enforcement is now four-layer:
   seeded literals test-pinned byte-for-byte · empty/missing ⇒ refuse (item 1) · no env channel for
   the two no-substitute keys · mutation-tested widening pins (2 tests red on widening, verified).
3. **§A4.7 WIDENED — it had a hole its own author fell into.** As written it binds *future*
   readers/persisters; it never triggered a re-enumeration of **pre-existing** readers when §A8.3
   added provenance columns to three existing tables — readers that were "harmless" only because
   their tables were empty, a property that expires unrecorded the moment SM-14/16 write the first
   row. §A8.2's "complete surface inventory" was complete only for the 0047 tables. **Rule, as
   amended: adding a provenance column to an existing table obliges the adding ticket's gate to
   re-enumerate every EXISTING reader of that table and assign each a disposition (filter / stamp /
   badge / mode-inherent). "The table is currently empty" is not a disposition — it is a deferral
   that expires silently.** Inventory as of 0048, now complete (both current `search_rank_snapshots`
   readers were caught — one by QA, one by this review): tracker §6j carries the full table.
   Headline: `search.rank.top10` rollup + `draftReportNarrative`'s top-10 count → **filter on
   current mode, fixed NOW (SM-46a/b)**, because the second is the client-facing report narrative —
   the reader least able to detect a blended synthetic count; `search_backlink_snapshots` /
   `search_ai_visibility` have zero readers (SM-16 writes first); `search_keywords`: `listKeywords`
   = badge (SELECT widens with SM-14's writer), keyword PATCH/import/clustering/brief-grounding =
   mode-inherent (none touches metric values; standing note — if PATCH ever gains metric editing,
   §A4.7 fires), demo seed = **stamp, in violation today (item 4)**.
4. **§A6's SM-37 note was factually WRONG — corrected.** I wrote "no keyword metric values seeded,
   so nothing violates the provenance rule today"; `src/seed/search.ts` in fact seeds
   volume/difficulty/cpc on all 25 keywords. With 0048 landed, the retroactive rule I set now
   FIRES: the seed writes plausible metric values stamped `metrics_simulated=false` (the default)
   with no provider — incoherent provenance at rest in the dev DB. **SM-46c: both INSERTs stamp
   `metrics_simulated = true` + a plausible `metrics_provider`, per the rule as originally stated.**
5. **SM-44 rulings.** (a) `writeCache` required param — **confirmed**; the compiler is the pin
   (sole caller passes explicitly; a defaulted mode was the §4d shape on the under-labelling side).
   (b) queue-aware sim pricing — **correct and faithfully inherits the typo-safety property**: the
   `anything ≠ "live" ⇒ standard` normalization lives once at the config parse boundary
   (`config.ts:156`) and both consumers strict-compare the normalized value — one normalization
   point is stronger than two independent ones. Benign divergence noted: the live driver captures
   the queue at construction, the sim reads config at call time (both process-constant in prod).
   **But the branch is UNPINNED** — delete the conditional and the suite stays green; the parity
   test asserts only the Standard rate. By this chain's own mutation standard that is unproven —
   **SM-46e pins it** (flip queue in try/finally, assert `serp` + `ai_visibility` at
   `serpLivePerTask`, restore). Also noted: sim clamps `items` to ≥1, live drivers use `items ?? 1`
   (items:0 prices $0 on live serp) — sim's shape is the safer one; SM-42's interface pass aligns
   the live drivers to `Math.max(1, ·)`. (c) Ahrefs conditional `serp` — **confirmed**:
   construction-time capability drop, pinned at the set level and the direct-call refusal,
   defence-in-depth kept, and the projection now yields the honest `note`/null-provider instead of
   a $0 price for an impossible pull.
6. **Migration 0048 RATIFIED** (the senior-db eyes §A6 asked for): additive-only, all four
   `simulated`/`metrics_simulated` columns `NOT NULL DEFAULT false` with the same load-bearing
   justification as 0047 (pre-existing rows are genuinely real — the default is a fact, not a
   guess); `ADD COLUMN ... DEFAULT false NOT NULL` is metadata-only on this PG (no rewrite);
   partial `WHERE simulated` indexes are near-zero-cost on live deployments; `metrics_provider`
   deliberately unconstrained (provider keys are extensible; provenance here is display-honesty,
   not referential integrity). Column comments carry the stamping law — good practice, keep it.
7. **The undischarged AC ("metrics writes stamp `metrics_provider`") — carry-forward to SM-14
   CONFIRMED as the right disposition.** No provider-metrics writer exists; a test against a fake
   writer would prove nothing about SM-14's real one, and marking the clause satisfied would be the
   dishonest option. Loss-prevention is now threefold, not doc-only: the AC is restated verbatim in
   SM-14's inherited spec (tracker §6j), the 0048 column comments name SM-14/16's stamping duty at
   the exact schema location the implementer will read, and the §A9.3 inventory lists `listKeywords`
   as badge-owned by SM-14. **SM-14 is additionally marked ⚡** (first snapshot persister, first
   metrics writer, widens the BFF keyword envelope) — its gate re-verifies the SM-46 filters against
   real written rows and mutation-tests the stamps.
8. **SM-14 ∥ SM-15 blessing WITHDRAWN (amends §A1's wave order).** SM-15's postback flow needs a
   platform callback surface, and flows-batch tickets must own **zero** platform-nest routes
   (backbone rule: n8n orchestrates, modules own their HTTP surface) — so the completion-callback
   route belongs to SM-14, putting both tickets in `search.controller.ts` if run concurrently.
   Controller contention has been this program's main operational risk; sequence SM-14 → SM-15.
   Revised order + the only blessed concurrency pairs: tracker §6j.

---

## §A10 · Vendor sandbox — the provenance ruling (2026-07-29, binding)

**Trigger:** owner question ("can we simulate it, so we can still build while waiting for
staging?"). §A1 already unblocked everything *above* `invokeProvider` — proven in live traffic
(tracker §6l/§6s). The remaining gap is everything *below* it: the live drivers
(`dataforseo.ts`/`semrush.ts`/`ahrefs.ts`) have never run their real HTTP path end-to-end —
credentialed factory registration, auth-header serialization on a real socket, envelope parsing
from real bytes, the Standard-queue `task_post`→`task_get` 40602 poll driven against a stateful
server, vendor errors inside a 200, timeout aborts, and the Ahrefs
`x-api-units-cost-total-actual` true-up under genuine network concurrency. Today SM-41 would meet
every defect there for the first time against a funded account. The proposal: a local HTTP server
speaking all three vendors' envelopes, `*_BASE_URL` repointed at it, live drivers running the
whole chain with fake credentials.

### A10.1 · The hazard, named before the ruling

The provenance stamp is `simulated = <mode is simulate> OR <driver's own marker>`
(`dispatch.ts:287`). Live drivers carry no marker; a sandbox-fed dispatch in live mode therefore
stamps **`simulated = false`** on rows whose bytes and dollars are fabricated — unlabelled fake
data in the ledger, the cache, the snapshot tables, and every console the owner bills from. That
is the §4d/§A4.7 defect class at its most expensive, arriving as *architecture*. The ruling below
exists to make that row impossible to mint anywhere it could be believed.

### A10.2 · The ruling — the sandbox is a TEST-HARNESS FIXTURE, never a deployable environment

The sandbox is an in-process HTTP server started inside a test file on `127.0.0.1` at an
ephemeral port, exercising factory-built live drivers through the full
`registry → dispatchProviderOp → cache → ledger → true-up` chain **against per-file throwaway
test databases only** (the tracker §0 protocol). It has no compose service, no Dockerfile, no
long-lived process, no boot registration, and no reachable form outside a test run. Option (c)
from the proposal, hardened; (a) and (b) are rejected with reasons:

- **(a) "sandbox stamps `simulated = true`" — REJECTED on mechanism and on meaning.** Mechanism:
  the stamp derives from mode OR marker; to get `true` from live drivers you must either register
  live drivers under simulate mode — dismantling §A4.3's ratified branch purity (`main.ts`'s
  simulate branch never calls a `create*ProviderFromConfig()`, and that structural property is
  the guarantee) — or infer "fake" from the URL on the money path, a heuristic where a wrong
  guess is the expensive lie. Meaning: `simulated = true` today promises SM-33's contract —
  deterministic seeded output (§A4.6), priced from real rate tables (§A4.5). Sandbox rows keep
  neither promise by construction, so the boolean would silently mean two things, and every
  consumer (mode-filtered sums, cache predicate, badges) would be unable to tell which it got.
- **(b) a third provenance value (enum or second column) — REJECTED for having no consumer.**
  Every downstream decision this programme has ratified is binary: synthetic dollars vs paid
  dollars (budget sums), synthetic bytes vs vendor bytes (cache predicate, badges, report
  filters). No code path would ever branch three ways — "sandbox" collapses into "not vendor" at
  every decision point. A provenance dimension nobody consumes re-opens 0047/0048's columns and
  every ratified mode-filtered WHERE clause (§A8.2's full inventory) on the money path, for zero
  decision value. That is maximal §4d-class exposure purchased for nothing.
- **(c) is honest by LOCUS, not by label.** In a throwaway per-file database,
  `simulated = false` is *correct*: the harness is a staging rehearsal, and rehearsing the exact
  provenance staging will stamp is a feature, not a leak — the mode-filtered sums, the cache
  predicate, and SM-42's true-up all execute on `false` rows exactly as SM-41 will exercise
  them. Precedent already exists: `mock-provider.ts` rows stamp `false` in test DBs today. What
  (c) forecloses is not the row but the row's *audience* — no sandbox row can ever reach a
  database any surface reads.

**The invariant, binding and quotable:** `simulated = false` asserts *"these bytes and dollars
descend from a credentialed vendor call (or a cache hit on one)."* Rows carrying it may exist in
exactly two places: **(i)** environments holding real vendor credentials (staging, production),
**(ii)** throwaway per-file test databases. The sandbox may only ever produce (ii). Anything that
would mint a `simulated = false` row from fabricated bytes in a shared environment is refused at
design time — there is no labelling scheme that repairs it, because the defect is the audience,
not the label.

### A10.3 · No `sandbox` value for `SEARCH_PROVIDER_MODE` — confirmed against §A4.3

The mode exists to select **what boot registers in a deployment**. Under this ruling the sandbox
is never deployed, so there is nothing for a third mode to select — the harness bypasses
`main.ts` entirely and calls the live factories directly, as every provider test already does.
Keeping the mode binary is also what keeps the *column* binary: a third mode forces the
`simulated = <mode>` predicates into the enum question, which is (b) through the back door.
§A4.3's mutual-exclusion boot error survives byte-for-byte.

### A10.4 · Enforcement — the repointed-base-URL boot guard (new, SM-49 AC 9)

The one-env-var hazard exists **today, independent of any sandbox**: `SEARCH_PROVIDER_MODE=live`
plus `SEMRUSH_BASE_URL=http://something.local:9999` boots cleanly and mints `simulated = false`
rows from whatever answers. Ruled: `main.ts`'s **live branch** refuses to boot (thrown error
naming the vendor, the host, and the override) when a configured vendor base URL is lexically
private — loopback, RFC1918/link-local literal, `::1`, single-label hostname (docker service
names), or a `.local`/`.localhost`/`.internal`/`.test`/`.lan`/`.home.arpa` suffix — unless
`SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL=1` (documented for genuine proxy/tunnel deployments). An
unparseable URL also refuses. Stated honestly: this is lexical, an **accident guard, not authz**
— a public DNS name resolving privately passes it. The primary containment remains A10.2: the
sandbox has no deployable form to point at. Simulate mode is untouched (its branch calls no
factory). Tests are untouched (they never pass through `main.ts` registration).

### A10.5 · What a sandbox proves — and what still requires real credentials

A sandbox we author validates our code against **our own model of the vendors**; fixture and
parser agree by construction (§4i transposed to the vendor boundary). Confirmed, with the
sharpening that its genuine value is everything an injected `fetchImpl` structurally cannot
exercise:

**Proves now (our defects, findable pre-staging):** real-socket mechanics (auth-header
serialization, URL/query encoding, body framing, gzip, connection reuse, `AbortController`
timeouts actually firing); the DFS poll driven as a state machine against a server that holds
task state, not a scripted response list; the full-chain composition through the real factories,
registry, gates, cache, ledger; SM-42's ALS true-up capture under genuinely concurrent HTTP
(`getBacklinkSummary`'s two parallel calls on real sockets); and **strict request validation
centralized in one place** — the sandbox 404s unknown paths and refuses missing params in vendor
shape, so a driver silently sending garbage fails here, where a lenient per-test mock would have
accepted it.

**Cannot prove (SM-41's irreducible core — a green sandbox is NOT a validated integration):**
envelope fidelity (whether the real vendor's field names/nesting/nullability match our fixtures);
the error-code inventory as actually emitted; whether `x-api-units-cost-total-actual` is spelled,
cased, and formatted as we assume; per-field billing units (Ahrefs 5-vs-10, OQ-10) and every
§A7 plan fact (OQ-9/OQ-10/OQ-11 — all unchanged by this ruling); whether our auth form is
*accepted* (the sandbox asserts our own expectation of it); real 429/`Retry-After`/queue-latency
behaviour; and the ledger-vs-vendor-console reconciliation that proves §A3's arithmetic. **What a
green sandbox buys SM-41 is a changed failure profile: defects surviving to staging should be
wrong vendor *facts*, not broken plumbing** — triage on a funded account starts from "which
assumption was false", not "why did the socket hang".

### A10.6 · Recorded real responses — design toward them NOW, at fixture-file cost

Recorded envelopes (captured once from a credentialed account, redacted, replayed) are a
materially stronger artifact than hand-authored fixtures: they settle *shape* facts — field
names, nullability as-of-recording, error shapes actually observed, the true-up header as
actually sent — piercing the §4i circularity for everything recorded. They still cannot settle
billing/plan facts (console-side consumption, allowances, drift after recording, unrecorded error
paths), and **they change nothing about A10.2**: replayed-real bytes still carry fabricated
dollars, so recordings live as redacted test fixtures only, never as demo data (also the
ToS-safe posture for vendor-licensed data). Ruling: SM-49's sandbox is **fixture-file-driven from
day one** (per-vendor/per-op files, never inline literals), so recorded envelopes drop in as
replacement fixtures with zero sandbox code change; SM-41 gains the capture-and-backport duty
(A10.7). Initial fixtures are copied from the landed driver unit tests' envelopes — the current
single source of our vendor assumptions — never newly invented shapes.

### A10.7 · SM-41 amendment (scope UNCHANGED — three additions)

Not one clause of SM-41 moves: every clause is about vendor facts (parse of *real* envelopes,
provenance on *real* rows, reconciliation against the *vendor's* console), and A10.5 shows no
sandbox can discharge any of them. Amendments:

1. **New prerequisite:** SM-49 landed — so staging failures triage to vendor facts, not plumbing.
2. **New closing clause (fixture backport):** every vendor deviation SM-41 finds — an envelope
   field, an error code, a header spelling, a billing unit — is backported into the sandbox
   fixtures **in the same PR as the driver fix**, with the fixture's UNVERIFIED header replaced
   by a recorded-on date. The sandbox converges toward recorded truth or it rots into §4i.
3. **New capture duty:** one redacted real envelope per vendor per capability is captured into
   the fixture directory (A10.6). Redact credentials and account identifiers; SERP payloads are
   public data.

The >20% estimate-delta tripwire, the per-vendor/per-capability checklist, and the
ledger-vs-console reconciliation stand verbatim.

### A10.8 · The door deliberately left closed

If console-visible sandbox traffic is ever demanded (clicking the dev console while live drivers
poll a fake DataForSEO), the **only** admissible wiring is marker-`true` wrapper drivers
registered under **simulate** mode — rows stamp `true`, badges fire, budgets bind the sim ledger
— and it requires its own design review, because it erodes §A4.3's branch purity. It is *not*
designed here, because it buys almost nothing: everything above `invokeProvider` is already
proven in traffic against the simulators (§6l/§6s), and the only visible difference sandbox
traffic would add to a console demo is queue latency. Do not implement it as a lighter variant
of SM-49.

Full SM-49 ticket spec (tier, file ownership, ACs, MUST-NOTs, build-order slot): tracker **§6u**.

---

## §A11 · Incurred-cost ledger rows — the SM-50 ruling (2026-07-30, binding)

**Trigger (tracker §6w):** a provider exception inside `runInCacheCriticalSection`'s transaction,
before `insertLedgerRow`, rolls the whole critical section back — a deliberate, tested SM-04
decision that is **correct before the vendor was engaged** and **wrong after a billable side
effect**. DataForSEO Standard `task_post` charges at post (~$0.0006/task); post → charged → poll
exhausts → throw → rollback leaves **money spent at the vendor and nothing in our ledger**. The
stop-loss sums the ledger, so repeated poll failures burn deposit no budget tier can see: a
fail-open reached through transactional atomicity rather than through a guard. No live exposure
today (simulate charges nothing; DataForSEO unfunded); **binding trigger: SM-50 must be LANDED
before OQ-11 funds the deposit**, and before SM-41.

### A11.1 · The five rulings

1. **Locus — a compensating write OUTSIDE the rolled-back transaction** (new
   `recordIncurred()`, `recordBlocked`'s fresh-short-`withTenants` pattern, `{ modules: ["search"] }`),
   guarded by the §4d secondary-failure template: if the audit write itself fails, the original
   provider error still propagates and the audit failure becomes a span event. Nothing inside a
   rolled-back transaction can survive by definition, so the only alternatives are this or
   write-ahead intent rows — see A11.4 for why write-ahead is rejected in v1 and what would
   revive it.
2. **Status — a NEW ledger status `incurred`**, never a cost-bearing `failed` row. Semantics,
   quotable: *"the vendor was engaged and confirmably charged (standard-rate accounting) and no
   data was delivered."* The `failed ⇒ cost_usd = 0` invariant (ledger.ts header, SM-04) is
   **preserved** — refusals and pre-engagement failures keep writing `failed`/0 rows exactly as
   today. Encoding "charged" as `failed AND cost_usd > 0` was rejected as an implicit semantic —
   the §6r class: every consumer would have to know a convention nothing enforces. Migration:
   additive CHECK widening on 0034's `('posted','completed','failed')` (0034:175) plus a nullable
   `vendor_ref text` column; senior-db eyes at the gate; no RLS change; no backfill (no incurred
   row can exist before the code that writes one).
3. **Driver declaration — dynamic, at the billing point, composed with SM-42.** A billing point
   is an *event with an amount*, not a static method property, so the interface is
   **`recordIncurredCostUsd(usd, vendorRef?)`** on the existing SM-42 AsyncLocalStorage store
   (one store per dispatch, two channels), called by the driver the instant the vendor confirmably
   charges: DFS `task_post` on parsed acceptance (accepted tasks × published queue rate — rejected
   tasks are not charged and not recorded), prepaid vendors per served 2xx response.
   **`recordActualCostUsd` (SM-42) implies incurred** — a vendor-confirmed actual charge is by
   definition an incurred charge, so Ahrefs's existing capture feeds both channels with no second
   call site to drift. `withActualCostCapture` catches `fn`'s rejection and rethrows wrapped
   (`ProviderFailedAfterSpendError { cause, incurredUsd, vendorRefs }`) **only when incurred > 0**;
   when nothing was recorded, today's behaviour is byte-for-byte preserved (rollback, no row —
   still correct before the vendor was engaged). This deliberately does NOT overload
   `takeActualCostUsd`: a *correction* signal (SM-42) and a *liability* signal (this) mean
   different things, and overloading one meaning onto two readers is the §6r class again.
4. **Reconciliation — `vendor_ref`, and a callback interlock.** The driver's vendor-side id (DFS
   task id) is stamped on incurred rows AND on successful rows going forward (one column, both
   paths — it is also what SM-41's console reconciliation matches line items against). The SM-14
   Standard-queue callback path (`POST rank-pulls/callback`, landed) must **never re-post a paid
   task** (task_get only) and, on late completion of a written-off task, MAY advance
   `incurred → completed` at the **same cost** while persisting through the normal writers —
   never a second cost-bearing row for the same charge. Generic `trueUpLedger` stays
   `posted`-only: correcting an estimate on a delivered call and reconciling an orphan are
   different operations and keep different code paths.
5. **Attribution honesty — no new labelling axis.** An incurred row's cost is standard-rate
   accounting **exactly like every other ledger figure** (§A3: the ledger is cost-to-serve at
   standard rates, not cash), so an estimate-valued incurred row is precisely as honest as a
   `posted` row at its estimate; the SM-17 "actual"-wording prohibition (§6p, row-scoped,
   Ahrefs-only, post-SM-41) already forecloses the overclaim. Ambiguous timeouts — the request
   died where the charge is unknowable — deliberately **under-record** (record only at parsed
   vendor acknowledgements); the residue is bounded to cents per op and SM-41's
   ledger-vs-console reconciliation with its ≥20% tripwire is the designed catch. Simulators
   never record incurred (their dollars are synthetic; the rollback loses nothing real), so no
   incurred row can exist in simulate mode; live-path incurred rows stamp `simulated` from the
   dispatch value like every other row (§A10's audience invariant unchanged).

### A11.2 · The consumer enumeration (binding dispositions — not left to the implementer)

Every current reader/writer of `search_provider_calls`, its verified behaviour, and what it must
do when `incurred` rows exist. **The load-bearing fact, verified in the SQL: all four money sums
and the monetary rollup are status-blind** — none carries a status predicate — so incurred cost
binds every budget tier and the exec rollup with ZERO changes to them. The ACs pin that property
rather than assume it.

| # | Consumer | Verified today | Disposition under `incurred` |
|---|---|---|---|
| 1 | `sumMonthToDate` (engagement + tenant tiers), `ledger.ts:68` | WHERE month + `simulated` (+ engagement) — **no status predicate** | Counts incurred automatically — **this is the fix**. No code change. AC: mutation probe — adding any status filter turns the headline burn-then-refuse test red |
| 2 | `sumGlobalMonthToDate` / `GLOBAL_MTD_QUERY_SQL`, `ledger.ts:111` | Status-blind; shape-pinned (anchored assertion, §6d) as the enforcement half of a ratified allowlist entry | Counts incurred. **The pinned shape must NOT gain a status predicate** — any future "exclude incurred from the ceiling" idea is fail-open by construction and requires a design gate, and the pin blocks it mechanically |
| 3 | `sumProviderMonthToDate` / `PROVIDER_MTD_QUERY_SQL`, `ledger.ts:185` | Status-blind; same pin scheme (SM-40, ratified §6x.1) | Same as #2 — the DataForSEO deposit-burn ceiling now sees the burn, which is the whole point |
| 4 | The two 30s TTL caches (global/provider MTD) | Keyed per mode (and provider); staleness accepted as coarse-by-design | Incurred rows written after a cached read are invisible ≤ TTL — the identical, already-accepted coarseness every dispatch has. No change; documented |
| 5 | `search.provider_cost.month` rollup, `modules/search/index.ts:67-72` | `SUM(cost_usd)` month + mode — status-blind, `isMonetary`, exec-facing | Includes incurred — **correct**: cost-to-serve includes charges that returned nothing. One comment line stating the inclusion is deliberate, so no future reader "fixes" it |
| 6 | SM-17 ledger endpoint + console (`search.controller.ts` ledger GET; `searchMarketingShared` types) | `costToServeUsd`/row counts mode-filtered, status-blind; rows render `status` verbatim with fallbacks (§6n) | Sums include incurred; `incurred` renders as-is. Owed in the SAME diff (§4i discipline): the BFF status union widens, and one legend line lands — *"incurred = the vendor charged for a call that returned no data (e.g. a queued task that never completed); counted in cost-to-serve"* |
| 7 | `trueUpLedgerOnConnection` / `trueUpLedger`, `ledger.ts:253/268` | `WHERE status = 'posted'` | Incurred rows are **not** advanceable by generic true-up (deliberate — see A11.1.4). The callback advance is its own same-cost operation, pinned separately |
| 8 | `recordBlocked`, `ledger.ts:279` | Writes `failed`/cost-0 in a fresh txn | Unchanged. The `failed ⇒ 0` invariant is preserved — that is why `incurred` exists |
| 9 | `DispatchResult.status` (`"completed" \| "posted"`) | A successful dispatch never returns a failure state | **Unchanged** — the incurred path THROWS; no successful return carries it. Only `LedgerStatus` and `insertLedgerRow`'s input widen |
| 10 | SM-04 pin "provider failure rolls back the whole critical section — no billed row, no poisoned cache" (`dispatch.test.ts`) + §6w's sandbox pin (`rows).toHaveLength(0)`) | Pins the CURRENT behaviour for all failures | **Split**: before-billable keeps the no-row property (negative control); after-billable asserts exactly one `incurred` row + no cache row. The §6w pin flips — the discrepancy that surfaced SM-50 becomes its acceptance evidence |
| 11 | Notifications (`modules/search/notifications.ts`, SM-13 — LANDED §6y) | Nine §09 event types; no ledger reads | Additive: new `search.provider.incurred_cost` event emitted with the row (provider, endpoint, costUsd, vendorRef, correlationId) + bell href to the engagement ledger tab. Repeated incurred failures must reach a human, not only the sums — SM-13's dedupe/cross-tenant test pattern reused |
| 12 | SM-22 reports / margin analysis (future) | — | Standing note inherited into SM-22's AC: cost-to-serve includes incurred; **deliverable/work counts use `completed` only** — an incurred row is money, never output |
| 13 | SM-41 staging reconciliation | Checklist per vendor/capability | Incurred rows + `vendor_ref` are the **reconciling entries** for console charges with no matching data row; its checklist gains that row explicitly |
| 14 | Writers' inventory | `insertLedgerRow` (hit/dispatched), `recordBlocked` (failed/0) | Plus exactly one new writer: `recordIncurred` (incurred, cost > 0, vendor_ref, guarded per A11.1.1). No other code path may write `incurred` |

Two behaviours enumerated so nobody re-derives them wrongly: **retry after an incurred failure**
double-charges the vendor and writes two rows (one incurred, one posted) — ledger equals vendor
truth, no deduplication is attempted; **single-flight racing** — the first racer's rollback
releases the advisory locks, the second racer re-dispatches and is charged again — two rows,
matching two vendor charges, honest by the same rule.

### A11.3 · Rejected alternatives (recorded so they are not re-proposed)

- **`failed` rows carrying cost** — implicit status semantics; the §6r lesson says enumerate or
  it will be assumed. Rejected.
- **Write-ahead intent rows** (commit a `posted` row before `invokeProvider`) — the only scheme
  that also survives a crash mid-poll, and rejected for v1: it dismantles SM-04's
  single-transaction atomicity (cache write + ledger row commit together; exactly-once under the
  advisory locks), triples hot-path transactions, and buys only a crash window whose loss is
  bounded to cents and caught by SM-41's monthly reconciliation. **Revisit trigger, binding:**
  any driver whose single-op incurred cost can exceed ~$1 (e.g. bulk task_post batches) gets
  write-ahead for that driver before it ships.
- **Overloading `takeActualCostUsd`** as the failure channel — a correction signal and a
  liability signal are different meanings; one mechanism, two channels (A11.1.3) keeps both
  honest.
- **A dead-letter/outbox table instead of the ledger** — a second money table is a second thing
  for every sum and every surface to forget; the ledger already has the row shape, the RLS, the
  provenance column, and the consumers.

Full ticket spec (tier `senior-be` · opus·medium · ⚡, file ownership, eight ACs incl. the
burn-then-refuse headline test and the mutation probes): tracker **§6x.2**.

---

## §A12 · Google client-account surfaces (GSC / GA4 / Ads) — dev-buildability ruling (2026-07-30, binding)

**Trigger:** owner directive — credentials gate *acceptance*, not *construction* (the §A1 split,
already applied to the vendor deposit and, via §A10, to the vendor drivers). SM-25 had been
treated as construction-blocked on a Google OAuth client when only its verification is. This
section makes SM-25/SM-26 dev-buildable; SM-51 is the enabling harness ticket (tracker §6x.3).

### A12.1 · A THIRD egress class — scope clarification of §A5 B-1

§A5's B-1 ("vendor SEO APIs only via `SearchDataProvider` through `dispatchProviderOp`") governs
**shared market-data vendors** — the money choke-point exists because that spend is shared,
metered and cached cross-tenant. GSC/GA4/Ads data is different on every axis that motivated B-1:
**client-private, $0-API-billed, per-client-OAuth.** Ruled:

- Reached ONLY via module-internal clients in `modules/search/google/` (the
  `gateway-client.ts`/`knowledge-client.ts` precedent), added to §6e's egress-inventory
  set-equality pin **deliberately, by exact filename** — never a driver, never through
  `dispatchProviderOp`, and **never touching `search_data_cache`**: that table is no-RLS shared
  market data by design (D-4), and a client's own Search Console rows in it would be a
  cross-tenant leak *by construction*. Google-derived rows live in tenant-scoped RLS'd tables
  only.
- No USD ledger rows for Google reads — there are no dollars to meter, and inventing synthetic
  ones would pollute §A3's cost-to-serve meaning. The bounding resource is **Google quota**:
  per-op row/page caps and scope-driven cadence, stated in each consuming ticket's AC.
- Google Ads **writes** remain governed by SM-21's approve-execute-replay + WS4 one-shot
  approval regardless of transport (D-8). The read/write asymmetry is the decomposition boundary
  (A12.4).

### A12.2 · Provenance, transposed

- Every new Google-derived table carries `simulated boolean NOT NULL DEFAULT false` **from day
  one** — the §A8.2 external-import precedent plus SM-37's retroactive seed rule: demo/seeded
  rows must be stampable or must not exist. §A4.7 applies verbatim: every reader/persister of
  these tables states its mode handling (filter / stamp / badge / mode-inherent) in its ticket's
  AC.
- The §A10 audience invariant transposes: a row asserting descent from a client's real Google
  account may exist only **(i)** where a real Google connection exists, **(ii)** in throwaway
  per-file test databases. Dev demo data therefore arrives via **seeds stamped simulated** —
  never via a fake Google client registered in a deployed stack.

### A12.3 · The OAuth flow against a local issuer — exercisable, with named limits

- **The machine path: YES.** The stack already runs Keycloak (P5b) and the credential vault is
  LANDED (0033 secret-box, `setConnectionTokens`, `hasToken`-only reads; **0035 already widened
  `provider`/`owner_kind` for exactly these Google providers + `'client'`**). A `google-dev`
  realm client exercises the full authorization-code round trip (state + PKCE + redirect
  validation), token exchange, refresh **including rotation**, RFC-7009 revocation, expiry
  handling, and encrypted vault storage — the entire token-custody surface SM-25's opus flag
  exists for. The SM-51 sandbox additionally serves Google's token endpoint as a **stateful**
  fixture machine (the DFS-task-state precedent), so the client's real HTTP path runs on real
  sockets in per-file tests.
- Endpoints come from `config.search.google.*` seams; §A10.4's boot guard **extends to them in
  live mode** (a private issuer/base host refuses boot unless the documented override).
- **Honesty rule:** any connections surface renders the issuer host whenever it is not Google's —
  a dev-issuer connection must be readable as one at a glance. Proportionate, deliberately short
  of §A10's full ceremony: connection rows are tenant-scoped credential *metadata*, not
  cross-tenant market data with dollars attached.
- **Cannot be exercised locally — SM-41G's staging clauses, stated so a green harness is never
  mistaken for a working integration:** Google's consent screen, incremental consent and
  scope-grant semantics; refresh-token longevity under the OAuth app's publish status
  (Testing-mode refresh tokens expire in 7 days — a production fact no local issuer can
  rehearse); Google-side revocation; quota/429 behaviour; Ads developer-token approval +
  MCC/login-customer-id semantics; and whether real Google accepts our serialized requests at
  all.

### A12.4 · Decomposition RATIFIED — read ingestion and live-ads writes are different risk classes

**SM-25a** OAuth core (senior-be · **opus·medium** ⚡ — token custody + callback-forgery edge
cases; publish the attack list, the §4g standard) → **SM-25b** GSC + GA4 read-only ingestion
(medior · default — read-only, $0, sandbox-proven) → **SM-25c** Ads read binding (senior-be ·
default). **SM-26** scope unchanged: its code builds against SM-51's mutate fixtures once SM-21 +
SM-25c land; its real-push AC is staging (test account). **SM-41G** is the Google staging
acceptance sibling of SM-41, with A10.7's fixture-backport + capture duties transposed.

### A12.5 · Carried forward unchanged

No third `SEARCH_PROVIDER_MODE` value (A10.3 verbatim); fixture discipline, `UNVERIFIED` markers
and recorded-envelope convergence (A10.6/A10.7 → SM-41G); and the binding sentence, transposed:
**a green Google sandbox / local-issuer harness is a validated client of our own model of
Google, not a validated Google integration.**

Full ticket specs (SM-51, SM-25a/b/c, SM-41G — tiers, deps, ACs, build-order slots): tracker
**§6x.3/§6x.4**.

---

## §A13 · Automation and the money path — the assurance ruling (2026-07-30, binding)

Rules on tracker §6ac (SM-15's block), §6aa (SM-53's status mapping), and SM-15's two contract
gaps. Full ticket specs in tracker **§6ad**.

### A13.1 · The confirmed mechanics (all verified in code 2026-07-30)

Every `search.*` write tool is `minAssurance:'verified'` (`modules/search/index.ts`, matching the
hr/pm/automation-console write-tool convention — verified, not assumed). Every n8n principal is
minted `assurance:'low'` by construction (`mcp-hub/src/principal.ts`: *"verified principals will
come from the platform IdP — never from an envelope"*). `permits()`/`authorize()`
(`mcp-hub/src/policy.ts`) check assurance **before** the allow-list and before the D14 impact gate.
Net: **no n8n workflow can reach any search write tool**, and the D14 suspend path §07 describes
for paid pulls is unreachable for automation — §07's sentence "automation principals route through
the D14 gate" and the same section's `minAssurance:'verified'` convention are mutually exclusive.
Separately verified today: D14 approval-decide records + emits but **does not re-drive** the
approved call (`core/automation-approvals.controller.ts` header + body); the WSD-4 per-module
decided-event seam exists (HR's `applyLeaveDecision`) but nothing search-side subscribes.

### A13.2 · The ruling — automation never spends; scheduled pulls are a platform module job

**SM-15's proposed fix (lower `minAssurance` per tool) is REFUSED — the maintainer's refusal is
ratified on the merits.** The convention is deliberate and uniform; the tools automation can reach
are cheap and reversible; a paid pull is neither. The assurance gate is the control that keeps
chat-surface envelopes away from vendor spend, and it is placed correctly.

**Automation (n8n) must not be able to trigger paid pulls — through any mechanism.** The cadence
loop was never automation-shaped work: it is recurring in-module work executing configuration a
verified human already set. It moves into **platform-nest as a module scheduler job** (SM-54),
following the repo's own precedent (`startReconcileLoop`, `startDriftSweepLoop`,
`startBurndownSnapshotLoop` — dark-by-default env-gated chained-setTimeout loops in `main.ts`; plus
`automation-policy.ts`'s recorded `wf:digest-fanout` exception: a service-job trigger needs no hub
scope).

**The standing authorization artifact is the engagement's scope config**: tool toggle + cadence +
budget cap, settable only under `search:scope:write` (verified human, Cerbos-gated). Enforcement
stays at the dispatch choke-point — scope, pillar kill-switch, budget stop-loss, ledger, advisory
lock — which the scheduler enters through the SAME module functions the routes call. This is §07's
own "the approved row is the authorization artifact" pattern transposed to recurring spend: the
approved **config** authorizes, the budget cap bounds, the ledger audits, the toggle revokes.
Attribution: scheduler-initiated ledger rows record `requested_by = NULL` +
`correlationId 'sched:<tool>'` (amends §07's "requested_by = the OBO automation user").

**`impact:'medium'` on paid pulls STAYS.** It is retained as the tool's risk classification —
recorded into `automation_approvals` rows, displayed in the admin console, and load-bearing for the
agent surface (WS8 agent writes gate on impact, origin `'agent'`) — but it is **no longer claimed
as an automation entry path**. §07/D-5's rationale column is amended accordingly; the
`index.ts:124` comment clause "routes through the D14 automation-write gate" is struck (SM-55).

**Backbone-rule amendment — explicit, not by implication.** "n8n orchestrates, MCP accesses"
continues to govern how automation reaches platform data: n8n keeps cross-system glue, event-reactive
flows (outbox → n8n bridge), and webhook edges. It is **amended** with two clauses: (1) recurring
in-module cadence work whose only job is invoking module logic on module-owned configuration is a
platform module job, not an n8n flow — design §10's `sm-rank-pull`, `sm-keyword-refresh`,
`sm-backlink-snapshot`, `sm-ai-visibility` rows are reassigned to SM-54 accordingly; (2) **hard
rule: no n8n workflow may ever be allow-listed for a tool that spends vendor money** — paid-pull
tools stay `minAssurance:'verified'`, and the assurance gate is the enforcing control. This
amendment needs the owner's nod (§A13.7) because §09 records the original rule as a design
commitment.

### A13.3 · Rejected alternatives (recorded so they are not re-proposed)

- **Verified service principal for n8n** — violates `principal.ts`'s constitutional line (verified
  only from the platform IdP, never from an envelope), and even with it the D14 impact gate would
  still suspend every medium write from an automation principal — so it requires TWO weakened
  controls on the money path to avoid writing one loop. If WS4's target-state RBAC-minted
  short-lived creds + Temporal land, revisit; not now, and never as an envelope change.
- **WS4 approval per run** — non-functional today (no re-drive, verified §A13.1), and wrong-shaped
  even if built: a human approval on every routine daily tick for spend the human already authorized
  via scope config is duplicate authorization that trains rubber-stamping and degrades the approvals
  surface for the decisions that need it. Per-run approval remains the right shape for
  **exceptional** spend only (the existing `search:provider:admin` cap-override path).

### A13.4 · SM-53 ratification — status mapping is an API-contract addition (Ruling 2)

- **409 for `scope_disabled`/`budget_exceeded` — RATIFIED.** RFC 9110 409 is "conflict with the
  current state of the target resource, resolvable by the user, resubmittable" — exactly a refusal
  the operator fixes by changing the engagement's own config. **422 rejected** (the request content
  is well-formed; the conflict is resource state). **402 rejected** (would be the codebase's only
  402, no client branches on it, and its real-world semantics are provider-billing; the `code`
  discriminator already separates budget from scope).
- **503 for the five unavailability codes, unmapped-future-code → 503, never 500 — RATIFIED.**
  Verified exhaustive: the `ProviderDispatchError` code union (`providers/types.ts`) is exactly the
  seven mapped codes. Reserving 500 for genuine faults is ratified as the module's contract.
- **`code` in the error body — RATIFIED as an additive contract extension, and it DOES need a
  contract entry:** FRONTEND-BFF-CONTRACT gains a Conventions line — error bodies are
  `{ error: string, field?: string, code?: string }`, clients must tolerate additional keys, `code`
  is a stable machine discriminator (SM-57).
- **Placement — correct as-is.** The filter file lives in `modules/search/` (it catches a
  search-owned type) and is registered globally in `main.ts` (the type can escape any search
  controller); `@Catch(ProviderDispatchError)` gives it zero cross-module blast radius. Do NOT
  generalize the search mapping app-wide.
- **The latent class is real, with one more verified instance in the same module:**
  `GatewayNotConfiguredError` escapes `POST keyword-sets/:id/embed` and `/cluster` uncaught
  (`clustering.ts` embed loop; the controller maps only `KeywordSetTooLargeError`) → the same
  message-less 500 that SM-53 fixed, discarding a deliberately actionable message (SM-57). The
  AI-draft routes are NOT affected (verified: they wrap the gateway call with a deterministic
  fallback). Platform-wide sweep: the only plain-Error domain classes in `platform-nest/src` are
  the six in the search module/app guard; other modules throw `HttpException` directly — no
  cross-module instance exists today, but the structural floor gap is platform-level: any future
  uncaught plain Error surfaces as a 500 with no `{ error }` body, breaking UI/bot `.error` parity.
  **Platform finding → SM-58** (app-wide last-resort filter; 500 `{error:"internal error"}`, stack
  logged server-side, never leaking internals, with tests pinning that the two specific filters
  still win).

### A13.5 · SM-15's two contract gaps (Ruling 3)

- **`search.keywordResearch` / `search.runAudit` missing `method`/`pathTemplate` — DELIBERATE
  DEFERRALS, not defects.** `index.ts`'s own comment documents the stub protocol per tool, and
  `module-tools.ts` skips non-`pathTemplate` defs by design (informational-only; the hub advertises
  nothing it can't call, so no caller sees a broken tool). Human paths to the underlying
  capabilities exist today (`keyword-sets/:id/metrics-pull`; `POST audits` ingest). Bindings land
  with their owners: `keywordResearch` → the ticket that builds the research/suggestions route (on
  SM-05's driver); `runAudit` → SM-07 (the crawl job trigger — a `run`, distinct from SM-08's
  ingest `create`). Reaffirmed; no new tickets.
- **`search.ingestRankResults` — a REAL contract inconsistency, resolved by RETIRING the tool, not
  building it.** A vendor-postback relay is service-to-service data delivery, not an agent action —
  it should never be an MCP tool. Amended shape (SM-56, parked): n8n stays the webhook edge
  (INGEST_SECRET precedent), relaying task-id-only postbacks to the platform callback route
  authenticated by `SEARCH_CALLBACK_SECRET` (an env that exists today and is consumed by NOTHING
  platform-side — dangling until SM-56); the route switches from "re-run the paid dispatch" (today's
  documented limitation: a second charge per callback) to SM-05's unbuilt task-id-keyed
  authoritative re-fetch (free — the result was paid for at post time). Design §10's
  `sm-rank-collect` row is amended; the dead `wf:sm-rank-collect` allow-list entry is removed now
  (SM-55). **No MCP tool for SM-08's audit-ingest either — not a gap:** crawler→platform report
  delivery is the same service-edge class; recorded so it is not re-filed.

### A13.6 · What this supersedes

§07's "automation principals route through the D14 gate…" sentence and D-5's rationale clause
(as automation-entry claims) · §10's four scheduled-pull flow rows (reassigned to SM-54; the
`sm-rank-collect` row re-specced per A13.5) · §09's automation row gains the A13.2 amendment ·
tracker §6ac's open question (this section answers it). `sm-rank-pull.json`'s `meta.description`
instruction to lower `minAssurance` is **countermanded** and must leave the repo (SM-55) — a
committed directive that contradicts a binding ruling is a live hazard to future agents.

### A13.7 · Owner decisions this ruling needs

1. **Ratify the backbone-rule amendment** (A13.2) — recommended; it is a clarification with in-repo
   precedent, but §09 records the original rule as a commitment, so it is the owner's to amend.
2. **SM-56 timing** — the Standard-queue collect edge is the cheaper rank-pull economics; it stays
   PARKED until wanted (needs the funded DataForSEO deposit + staging). Approve parking, or pull it
   forward.

---

## §A14 · Echo-validation — validate the response against the constraint you asked for (2026-07-31, binding; tracker §6bc)

**Trigger:** the §6bc gate found `pullGscPerformanceForProperty` correctly clamping the *requested*
end date to the freshness-lag boundary while persisting a *returned* row dated inside the window,
unflagged — and SM-63 (§6bb) had just closed the same defect on the identity axis (a collect
trusting the caller's engagement claim over the ledger row's own). Two instances, one shape, so the
rule is written down before the next driver (SM-25c, SM-62) is built.

### A14.1 · The rule

**Any constraint or identity an outbound request carries — date range, row/volume bound, filter,
task/engagement identity — must be re-verified on the response before persistence. Violations are
skipped (never persisted), counted, and disclosed on the outcome; identity mismatches are refused
in the same shape as "not found" (no oracle). Nothing is ever silently absorbed.**

Doctrine, from §A10.5: a green sandbox validates our code against **our own model of the vendor**.
A constraint enforced only outbound is therefore enforced only in our model — every invariant
claimed of persisted data ("no partial rows", "at most N rows", "this row belongs to this
engagement") is a vendor-trust assumption in disguise until the response side enforces it.
Echo-validation converts an unverifiable vendor fact into an enforced local invariant that holds
whether or not the vendor behaves.

### A14.2 · Disposition pattern (rejected alternatives recorded, tracker §6bc Ruling 1)

- **Skip + count + disclose** for out-of-contract *data* rows — the `malformedRowsSkipped` pattern
  extended by one validity predicate. The counter is the operator-visible signal; contents never
  reach a table any surface reads. Loss is bounded deferral (the idempotent UPSERT re-fetches once
  the fact settles), never destruction.
- **Refuse-as-not-found** for *identity* mismatches (SM-63's shape): the scope comes back as data
  for the caller to judge, is compared outside the `WHERE` clause, and the refusal conflates
  "wrong scope" with "no such row" so no probing oracle exists.
- **Flagging is foreclosed** — it re-opens the schema column 0061 refused, creates a second
  partial-data state every reader must remember to check, and a forgotten predicate silently blends
  the flagged row anyway. **Silent dropping is foreclosed** — it hides the vendor-anomaly signal
  SM-41G exists to observe. **Whole-pull failure is foreclosed** — one stray row must not convert a
  data-quality anomaly into an availability incident.

### A14.3 · Honest limits

Echo-validation checks what IS in the response against what was asked. It cannot detect
under-return (a short page that lies about completeness) — that stays a vendor fact for SM-41G's
ledger/console reconciliation. It does not validate our own constants (a wrong lag-day figure skews
clamp and check together). Scope: vendor-boundary ingest paths — the paid providers and the §A12
third egress class — not a tax on internal APIs.

### A14.4 · Instance inventory (as of 2026-07-31; dispositions in tracker §6bc Ruling 3)

GSC/GA4 date window + GSC page-cap echo → **SM-64** · GA4 header-indexed parsing is **already the
exemplar** (parses via the response's own `dimensionHeaders`/`metricHeaders` — copy this in new
drivers, never positional trust) · collect identity → **SM-63, landed** · paid-driver response
identity (task echo, true-up header units, volume keyword echo) → **SM-65 audit**. Every new driver
ticket inherits echo-validation as an AC-generator: enumerate the request's constraints; each one
is either response-checked or a named, deliberate trust with an SM-41-class verification owner.

### A14.5 · Identity mismatch at a billing point — record the money, refuse the data (tracker §6bi, binding)

When the mismatched artifact is one the vendor has **already charged for** (DFS `task_post` charges
at enqueue), the identity remedy splits across two orthogonal axes — conflating them produces
either a money lie or a data lie:

- **Money:** every charge the vendor's acknowledgement implies is **recorded unconditionally**
  (`vendor_ref` = the vendor's own id — ids are pairing-independent), echo-clean or not, BEFORE any
  throw. The ledger states liability truth; withholding a record to "reject" a task re-opens the
  SM-50 orphan class. Only vendor-side *rejections* (not charged) stay unrecorded.
- **Data:** a canonical identity mismatch refuses the data path — the artifact is never returned,
  fetched, or persisted; the call throws after all charges are recorded. The charge lands as an
  `incurred` row ("money spent, data not in hand"), retrievable later via the collect edge once
  identity is resolved. Refusal is a bounded re-buy; acceptance is a mislabelled row feeding
  another key's history — on the money path the expensive direction is the lie, not the re-buy.
- **Pairing discriminator:** a violated *data* constraint impeaches one row (skip it, keep the
  pull); a violated *identity* constraint on a **positionally-paired** response impeaches the
  addressing scheme — every later position is equally suspect, so the remedy is
  record-everything-then-throw, never skip-and-continue.
- **Canonicalize before comparing** (trim + NFC + lowercase + collapse whitespace): raw-only
  variance is vendor restatement — accept and count; canonical mismatch is a different identity —
  refuse. Absent echo is no signal, not a mismatch.
- **Fixture-truthfulness corollary (tracker §6bi Ruling 2):** production behaviour is never
  weakened to green a fixture that cannot occur against the real counterparty — mocks echo what
  was actually posted (request-aware), or they are the defect.

---

*Cross-references:* [design](./seo-sem-design.md) §05/§12 · [tracker](./seo-sem-execution-tracker.md)
§4d/§4g/§4i/§6 · [foundation](./seo-sem-foundation.md) §8a (cost model superseded in part by §A3) ·
[`providers/types.ts`](../../platform-nest/src/modules/search/providers/types.ts) ·
[`providers/dispatch.ts`](../../platform-nest/src/modules/search/providers/dispatch.ts) ·
[`providers/ledger.ts`](../../platform-nest/src/modules/search/providers/ledger.ts) ·
[`providers/cache.ts`](../../platform-nest/src/modules/search/providers/cache.ts) ·
agent-army standard (project memory `agent-army-standard`: seat defaults, per-ticket Opus at plan time)
