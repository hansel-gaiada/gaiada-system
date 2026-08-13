# SMM design addendum — platform re-base (2026-08-12)

> **Status:** Addendum to [`smm-design.md`](./smm-design.md) v1.0 (2026-07-23). **Binding where it
> contradicts the base doc**; everything the base doc says that is not amended here still stands.
> **Module:** `social-media · 0.0.0 · PLANNED` — still no code.
> **Why it exists:** the base design was written against the platform of 2026-07-23
> (`Alpha 01.02x`, migration head `0033`, permissions-as-role-names, D14 resume path broken). The
> platform is now `Alpha 01.037.0087a`, migration head `0104`, permissions are DATA, D14 is closed
> with a canonical execution contract, and the client portal is live. Six of the base design's
> load-bearing assumptions no longer hold. This addendum re-bases the design and re-plans the ticket
> set; it does **not** relitigate the foundation locks (organic-only scope, Postiz AGPL-contained,
> Chatwoot dropped, human-in-the-loop mandatory).
> **Sibling precedent for this format:** [`seo-sem-design-addendum-providers.md`](./seo-sem-design-addendum-providers.md).

---

## §A0 · The one-paragraph summary

Nothing about the *shape* of SMM changed: master posts + per-network variants, a contained Postiz
engine, a connector registry, a metered ledger, and no auto-publish. What changed is the
**substrate every one of those must now sit on**: permissions are catalog rows with six parity
guards, approvals have a canonical single-use-grant execution contract that must actually *execute*,
the agentic-native bar is binding and names Social Media as the last department that can be built to
it rather than retrofitted, the console inherits far more from the department template than the base
design assumed, image generation has no backend to call, and the live client portal makes
client-side post approval a real (and now in-scope) surface. Net effect: **P0 grows** (a whole IAM
registration ticket + a heavier Cerbos ticket), **P1 gets stricter** (per-capability agentic ACs),
**P2 grows** (client approval), **P3 shrinks** (image generation defers), and the console work
**shrinks** (Home/Work/Connections come for free).

---

## §A1 · Delta register — what changed under the design

| # | Platform change (verified in-repo, 2026-08-12) | Consequence for SMM |
|---|---|---|
| **Δ1** | **Permissions are DATA** (IAM Phase 1, migrations `0091`–`0104`). Catalog = 226 entries / 211 grantable, key format `<domain>.<resource>.<action>`, seeded from `src/rbac/permission-catalog.json`; 861 role→permission bundle pairs across 20 roles; 74 permission groups; `ModuleContract.permissions` is **fail-closed drift-guarded** against the catalog at module boot (`registry.ts` IAM-01d). | Every `social:engagement:read`-style key in base §11 is **invalid**. Rewrite to `social.*` dotted keys, add catalog + group + bundle rows in a migration, add the two module roles (precedent: `search_*`, `webdev_*`, migrations `0097`/`0098`). **New ticket SMM-30.** ⚠ **CORRECTED DURING SMM-30 (2026-08-12):** this row first said `smm_manager`/`smm_staff`. Wrong, and it would have shipped two roles nothing ever matches — `derived_roles.yaml`'s `module_staff`/`module_manager` string-compose `resource.attr.module + "_staff"\|"_manager"` at request time, and the module key is `social`. The only names Cerbos will ever look for are **`social_staff`/`social_manager`**. That is the same silent-skip defect migrations `0069`/`0091`/`0097` each had to close for `reports_*`/`search_*`/`webdev_*`. |
| **Δ2** | **Six IAM guard suites** now pin the permission chain: `cerbos-catalog-alignment`, `permission-groups-catalog-parity`, `role-permission-bundles.db`, `role-bundle-completeness.db`, `role-catalog-drift.db`, `rbac-capability-parity` (UI), plus `iam-07b-chain-meta`. | A module that ships a Cerbos kind without a catalog entry (or vice versa) **fails CI**. SMM-03's definition of done triples: policies + catalog + groups + bundles + UI `ROLE_CAPS` capability, all consistent. |
| **Δ3** | **D14 is CLOSED, both halves.** Approving an eligible suspension **executes** it: the platform mints a single-use HMAC grant (`x-approval-grant`, payload `{v,approvalId,tenantId,toolName,argsSha256,iat,exp,nonce}`, exp−iat ≤ 120s) and re-drives the tool through the hub as the original filing principal, under `pg_advisory_xact_lock(lockKey)` with a server-side `precondition()` re-evaluation. Registry doctrine (`core/approval-executables.ts`): entries are one-per-ticket, an absent entry is the safe default, and **money-spending tools are permanently barred**. | Base §07's bespoke `payload_hash` **is** `argsSha256` — adopt the estate contract byte-for-byte instead of inventing a parallel one. Publish becomes a registry entry with `lockKey` = variant id and a `precondition` that re-checks scope/quota/hash/budget. See **D-14** below for the money split. |
| **Δ4** | **The agentic-native bar is binding** (`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md`, OPEN, must close before staging) and says of this department: *"Module is 0.0.0 PLANNED… It is the last department that can be built TO this bar instead of retrofitted onto it — that option disappears the moment it ships."* Seven criteria: tool parity · deterministic contract · idempotent writes · impact-classified writes that execute · explicit typed refusal · observable (`work_activity`, non-human actor) · one golden case. | Not a P4 concern. **Every SMM ticket's AC gains the criteria its capability touches**, and the module ships a capability-inventory row (endpoint + tool + impact class) per capability — exit-bar item 6. **New ticket SMM-33.** |
| **Δ5** | **Agent attribution is a pre-staging gate** (owner decision 2026-08-08): `Principal` has no channel/agent field, so every audit row says "Alice" where the truth is "Alice's agent". Systemic, gets its own version cut. | SMM must not invent its own attribution. Ledger/activity/approval writes carry the actor exactly as the platform does, and are shaped so the `via:` stamp drops in without a schema change when the gate lands. Recorded as a standing note, not an SMM ticket. |
| **Δ6** | **No image-generation backend exists.** `ai-gateway-go` exposes `/complete`, `/complete/stream`, `/media` (vision), `/embed` — nothing generative. `render-gateway-go` is `0.0.0 PLANNED`; `creative` is `0.1.0 PROTOTYPED` (grading + asset persistence only). | Base §07/§08's "generate image (credits-gated)" calls nothing. **v1 composer is attach-only** (files / Studio-graded `creative_assets`). Generation becomes decision-gated **SMM-34**, unblocked by the Creative `CR-*` render-gateway work. The ledger still ships (X + `ai_cloud_text`), so the seam is ready. |
| **Δ7** | **The client portal is live and deployed** — `/portal/*` routes, `portal.*` as its own permission domain (owner decision DR-4), and a working gate-decide shape (`POST /api/:t/portal/gates/:id/decide`, `portal.decide`). | `tool_scope.posting.requiresClientOk` is now buildable. **Owner decision 2026-08-12: in scope for P2.** New tickets **SMM-31** (backend two-stage gate) and **SMM-32** (portal UI). |
| **Δ8** | **Portal-written tables cannot take the module third wall** (migration `0088` header, D-2a): portal controllers are core and declare no module scope, so `app_module_allowed('social')` would read **zero rows, silently**. | Δ7's consequence: the client-review table takes the **plain core tenant wall**, not the third wall, and is a *separate table* from `social_post_variants` (which stays third-walled). Do not "fix" this for consistency later. |
| **Δ9** | **Migration head is `0104`**, next free `0105`; `0058`/`0059`/`0070` are dead reservations. `ModuleContract.migrations` must list files **at write time** (the search module's own repeated bug — `0047` was omitted and fixed after the fact). | Base §04's "0034+" is stale. SMM-01 takes **0105+**, reserved by creating the file, and every migration is registered in the contract array in the same commit. |
| **Δ10** | **Scope types finished moving** (HIER-3): `global \| company \| org_unit \| project`; `team`/`record` deleted, `teams` dropped, `team_lead` retired, `org_unit_lead` is the department-lead role (narrow: two rules today). `Resource.teamId` is a dead attribute. | SMM Cerbos policies must not name `team_lead` or use `teamId`. Department-lead authority over social work = `org_unit_lead` + the module roles, and `org_unit` is **not** wired everywhere — don't assume subtree cascade beyond its two landing surfaces. |
| **Δ11** | **The department console template grew.** Every toolkit inherits `HOME_GROUP` + `WORK_GROUP` (Projects · Board · **Ball** · Timeline · Charts · Activity — the one-PM-interface change) + `CONNECTIONS_GROUP`, all rendering against generic `/departments/[deptId]/*` pages that already exist. | Base §08's console scope over-counts. **Only the "Publish" craft group is new work.** PM/time/activity for the SMM department comes for free the moment the toolkit is registered. |
| **Δ12** | **The department is named "Social Media"** in the seeded org roster (`src/seed/roster.ts`: `d-social`, "Social Media", "Social Media Manager"), and `deptSlug()` derives **`social-media`**. | Base §08/D-10's dept name "SMM" and slug `smm` are wrong. Routes are `/departments/social-media/{calendar,composer,inbox,analytics}`; the toolkit const is `SOCIAL_MEDIA` with `slug: "social-media"`. Module key stays `social`, tables stay `social_*`. |
| **Δ13** | **Reporting infrastructure exists**: `report-renderer` (`0.1.0 DEV-VERIFIED`, Playwright PDF sidecar), `/internal/reports/print-payload`, `/print/reports/[jobToken]`, and the provenance-banner fix (`f581dd8`). `reports` module is `0.3.1` with the 4-grain tracker. | Base §04's `social_reports` still stands (client-engagement grain ≠ the 4 internal grains, same as `search_reports`), but **rendering and delivery reuse the existing print pipeline** — SMM-23 does not invent a renderer. |
| **Δ14** | **The mail subsystem exists** (`mail 0.0.19 IN PROGRESS`, approvals + risk warnings scope) alongside the notifications bell. | SMM-13's event wiring should route approval-request and risk-shaped events (`social.post.failed`, `social.usage.budget_threshold`, `social.account.expired`) through the mail path where it applies, not bell-only. |
| **Δ15** | **`docs/MAP.md` is generated and CI-gated** (`node scripts/gen-map.mjs`, `docs-map` job) — components, controllers, UI routes, migration head, n8n ids. | Any SMM ticket adding a controller, a route, a migration or a workflow **regenerates MAP.md in the same change**, never hand-patches it. Added as a standing AC. |
| **Δ16** | **The local 16-container stack is OFF; the server is truth** (owner decision 2026-07-31). Deploy traps are documented and have burned tickets: stale-`.env` rollback, `--remove-orphans` deleting off-profile containers, disk filling then rolling back, rsync-without-`--delete` leaving deleted files, a health gate that ran `ps` without `-a`. | SMM-04 is no longer only a containment spike. Postiz + its own Postgres + its own Redis is **three new containers on the live box** — the ticket must carry a compose **profile**, a disk-headroom check, an explicit `--remove-orphans` interaction note, and a deploy-runbook amendment, verified against the server or test containers from source. |

---

## §A2 · New decisions (this addendum) — extend the base §14 log

| # | Decision | Why |
|---|---|---|
| **D-14** | **Publish executes on approval, and money is split out of that path.** `social.publishPost` is registered in the D14 executable-approval registry (`lockKey` = variant id, `precondition` = re-validate tool_scope → media/quota → `argsSha256` match → unconsumed). A **separate tool `social.publishPostMetered`** carries any variant on a metered network (X today) and is **never registered** — it stays caller-re-driven, honoring the money bar. `networks.x` ships **disabled in every scope** (base OQ-2 default), so the v1 publish path is $0 and registry-eligible. | Agentic criterion 4 requires the approval to actually execute, and an "approved but never published" state is exactly the dead-end D14 existed to fix. Splitting by tool name keeps the doctrine's money bar intact without an owner amendment, and makes the metered path visibly different at the tool surface rather than by a runtime branch. Owner decision 2026-08-12. |
| **D-15** | **`payload_hash` IS `argsSha256`** — the hub's canonical-JSON algorithm (`mcp-hub/src/approval-grant.ts` §CANONICAL JSON), reproduced with its published fixed vectors, over the tool args (not over an SMM-private struct). | One hashing contract in the estate. A second one drifts, and the drift is invisible until a grant silently fails to match in production. |
| **D-16** | **Client approval is a real second stage, on its own plain-tenant-wall table** (`social_post_client_reviews`), decided through a portal endpoint modeled on `portal/gates/:id/decide` with a new `portal.approve_post` permission. `social_post_variants` stays third-walled and is never written by a portal controller. Staff approval (WS4) still gates dispatch — client OK is a **precondition of submitting**, never a substitute for it. | Δ7 + Δ8. Two-stage means two tables and two walls; collapsing them reproduces the zero-rows-silently failure 0088's header warns about. Ordering client-first keeps exactly one dispatch choke-point. |
| **D-17** | **v1 composer is attach-only.** No generative-image call ships until the Creative render gateway exists; the `ai.imageGen` toggle and the `ai_image` ledger kind ship inert (documented as "seam present, no backend"), and the composer names that when the toggle is on but unavailable. | Δ6. An inert, honestly-labeled toggle is better than a second image pipeline built outside the Creative module's design and thrown away. |
| **D-18** | **The console builds only the "Publish" craft group.** Home, the PM Work group (Projects · Board · Ball · Timeline · Charts · Activity) and Connections are inherited from `deptToolkits.ts` unchanged; the toolkit registers under slug **`social-media`**. | Δ11 + Δ12. Building a parallel Home or a parallel work view would fork the one-PM-interface decision that just landed. |
| **D-19** | **Every capability ships with its agentic-bar row**: MCP tool ⟷ endpoint ⟷ impact class ⟷ typed refusal ⟷ `work_activity` write ⟷ one golden case. No SMM ticket is DEV-VERIFIED without them. | Δ4 — building to the bar costs a line per ticket; retrofitting it cost every other department a program. |
| **D-20** | **Postiz's three containers ship behind their own compose profile**, with the deploy-runbook amendment written in the same ticket that introduces them. | Δ16 — a profile is what makes `--remove-orphans` and a partial `up -d` survivable on the live box. |

---

## §A3 · Amendments to the base design, by section

- **§04 (schema).** Migrations **0105+**, not 0034+. Register each in `ModuleContract.migrations` at
  write time. Add `social_post_client_reviews` (**plain core tenant wall**, per D-16/Δ8:
  `variant_id`, `client_contact_id`, `status draft|pending|approved|changes_requested`, `comment`,
  `decided_by`, `decided_at`, `UNIQUE (variant_id)` — idempotent by construction). Rename the hash
  column's semantics to `args_sha256` (D-15). `social_platform_apps` stays the single non-RLS table.
- **§05 (publisher + ledger).** Unchanged in shape. The ledger's `ai_image`/`ai_video` kinds ship
  **inert** (D-17); `x_post` and `ai_cloud_text` are the live kinds. The stop-loss chain is
  unchanged and is re-evaluated inside the D14 `precondition`, not only at submit time.
- **§07 (AI + approvals).** Replace the bespoke one-shot mechanism with the D14 grant contract
  (D-15) and the executable registry (D-14). Add the client-review stage ahead of WS4 submission
  when `tool_scope.posting.requiresClientOk` (D-16). Image generation removed from v1 (D-17).
  MCP tool table gains `social.publishPostMetered` (barred) and `social.decideClientReview`.
- **§08 (console).** Slug `social-media`; only the Publish group is built (D-18); the base doc's
  Home/My-work/Connections descriptions are inherited behavior, not tickets. Add the client-review
  state to the composer/calendar chips and the portal-side approval surface.
- **§09 (integration points).** Add: portal (`portal.approve_post`), mail (Δ14), `report-renderer`
  + print payload (Δ13), MAP.md regeneration (Δ15). Permission keys throughout become dotted.
- **§11 (security).** Permission keys dotted; no `team_lead`, no `teamId` (Δ10). Cerbos policies
  ship with the **role arm only — no `perm_social_*` mirror**. ⚠ **REVISED DURING SMM-30
  (2026-08-12):** this section first called for both arms. On building it, that was the wrong call:
  role names still decide every live authorization (PERMISSION-CONTRACT §7), the IAM-04 rollout sits
  at 28 of 60 kinds with batches dissolved or unstarted, and §2/§9 of that contract record an
  **unresolved** hazard — the mirror does not exclude `platform_admin`/`group_executive`, and the
  detector's blind spot is awaiting an architect decision. Mirroring 8 brand-new kinds ahead of that
  decision widens exactly the surface flagged open, for zero runtime effect. The 8 kinds join the
  rollout register as a deliberate batch once it settles; the catalog entries land now, so nothing
  blocks that step. Every policy header states this in place.
- **§12 (rollout).** Superseded by §A4.
- **§13 (open questions).** OQ-2 is **answered** (X ships disabled — D-14 depends on it). OQ-5/OQ-6
  unchanged. OQ-1 (app reviews) and OQ-3 (counsel sign-off) remain the two non-code blockers, both
  still gating **client** connects only, not the build. **New OQ-7:** does the live box have disk
  headroom for three more containers, and which profile do they join (Δ16/D-20)?

---

## §A4 · Re-planned ticket set

Numbering preserves the base doc where a ticket survives; **new tickets take 30+**. Tiers per the
agent-army standard, model = seat default unless flagged. ⚡ = contract-touching (schema / API /
policy / license boundary) → QA gate + architect design-review on the diff. Every ticket carries the
two standing ACs: **(a)** its agentic-bar rows (D-19), **(b)** MAP.md regenerated where structure
moved (Δ15).

### P0 — substrate, IAM, containment

| # | Ticket | Tier | Model | Deps | Changed? |
|---|---|---|---|---|---|
| **SMM-01** ⚡ | Migrations **0105+**: all §04 tables + third-wall RLS + indexes + `social_platform_apps` (global, admin-only) + **`social_post_client_reviews` on the plain core wall** + D17 custom-field targets; every file registered in the contract array at write time | senior-db | **opus·medium** | — | **AMENDED** (Δ8, Δ9, D-16) |
| **SMM-30** ⚡ | **NEW — IAM registration.** `social.*` catalog entries + permission groups + role→permission bundles + `smm_manager`/`smm_staff` roles (+ `portal.approve_post`), as a migration mirroring `0097`/`0098`; all six guard suites green; UI `ROLE_CAPS` capability mapped | senior-be | **opus·medium** — a bundle mistake grants reach nobody reviewed | SMM-01 | **NEW** (Δ1, Δ2) |
| **SMM-02** ⚡ | `social` ModuleContract + controller skeleton + registry + guard + `uiManifest` + engagement/brand-profile/campaign/KPI CRUD + tool-scope endpoints | senior-be | default | SMM-01, SMM-30 | amended (dotted keys, contract drift-guard) |
| **SMM-03** ⚡ | Cerbos policies ×8 (incl. `resource_social_client_review`) with **both arms**, derived-roles wiring (no `team_lead`/`teamId`), policy tests, catalog↔policy alignment, `lib/rbac.ts` mirror | medior | **opus·medium** (was default) | SMM-02, SMM-30 | **AMENDED** (Δ2, Δ10) |
| **SMM-04** ⚡ | **Postiz containment spike + deployable stack**: compose **profile** (app + own PG + own Redis), signup/UI disabled, edge exact-path allowlist, cred injection, containment checklist (REST-only, zero deps, fork budget), **disk-headroom + `--remove-orphans` + runbook amendment**, DM-coverage assessment (OQ-4) | senior-integrator | **opus·medium** — license + security boundary; QA gate mandatory | — | **AMENDED** (Δ16, D-20) |
| **SMM-05** ⚡ | `SocialPublisher` port + Postiz REST driver + org-per-client provisioning + connector-registry sync + OTel attrs + cross-client FK-chain refusal | senior-be | **opus·medium** | SMM-01,02,04 | unchanged |
| **SMM-06** | Config plumbing: key aliases, caps env, per-network flags, `.env.example`, compose `environment:` block (the passthrough trap) | junior | default | SMM-04,05 | unchanged |

### P1 — publish loop on own accounts ($0)

| # | Ticket | Tier | Model | Deps | Changed? |
|---|---|---|---|---|---|
| **SMM-07** | Account connect flow (BFF-brokered OAuth, org-scoped), own brand accounts first | senior-be | default; QA gate | SMM-05 | unchanged |
| **SMM-08** | Composer backend: posts + variants CRUD, media-rule validation engine, quota pre-check, **`args_sha256` maintenance per the hub's canonical JSON (fixed vectors asserted)**, native-import path | senior-be | default | SMM-02 | **AMENDED** (D-15) |
| **SMM-09** ⚡ | **The publish gate.** `social.publishPost` registered `write:true, impact:'high'`; **executable-approval registry entry** with `lockKey`(variant) + `precondition`(scope → quota → hash → unconsumed → budget); grant verification; edit-invalidates-approval; replay refused; no auto-retry on ambiguous failure; `social.publishPostMetered` registered as a **barred** twin | senior-be | **opus·high** — the authz-critical surface for public irreversible actions | SMM-03,05,08 | **AMENDED** (D-14, D-15) |
| **SMM-10** | Dispatch + status reconcile: approval-execution → `schedulePost` (transactional stamp), `smm-post-status-sync` + webhook intake (ids only) + safety poll, failure events | senior-integrator | default | SMM-09 | unchanged |
| **SMM-11** ⚡ | Console shell: toolkit registered as **`social-media`**, **Publish group only** (Home/Work/Connections inherited), Calendar + Composer pages, `lib/social.ts` BFF types | senior-fe | default | SMM-02 | **AMENDED** (D-18, Δ12) |
| **SMM-12** | Calendar + Composer UX: grid, variant chips, drag-reschedule (hash → re-approval), quota strips, submit-with-preview | medior | default | SMM-11,08 | unchanged |
| **SMM-13** | Events → notifications **and mail** where risk-shaped; typed refusals rendered, never folded into empty lists (criterion 5) | junior | default | SMM-10 | **AMENDED** (Δ14, Δ4) |
| **SMM-14** | P1 e2e on the dev stack + **golden cases** for every P1 capability; MODULES.md → IN PROGRESS + CHANGELOG | medior | default | SMM-07..13 | amended (Δ4) |

### P2 — engagement inbox + client approval

| # | Ticket | Tier | Model | Deps | Changed? |
|---|---|---|---|---|---|
| **SMM-15** | Inbox sync (`pullInbox`, idempotent upsert, `smm-inbox-pull`) | medior | default | SMM-05 | unchanged |
| **SMM-16** | AI triage: sentiment/category/urgency, spike detection, SLA guard flows | medior | default | SMM-15 | unchanged |
| **SMM-17** | Reply flow: drafts → WS4 → send (reuses the SMM-09 pattern, own registry entry + precondition) | senior-be | default | SMM-09,15 | amended (D-14) |
| **SMM-18** | Inbox tab UI: triage queue, thread view, assignment + SLA timers, reply approval states | senior-fe | default | SMM-11,15,16,17 | unchanged |
| **SMM-31** ⚡ | **NEW — client review stage (backend).** `social_post_client_reviews` state machine, submission precondition when `requiresClientOk`, portal decide endpoint modeled on `portal/gates/:id/decide`, `portal.approve_post`, notification + typed refusals, idempotent decision | senior-be | **opus·medium** — a second approval surface on the client trust boundary | SMM-01,03,09 | **NEW** (D-16) |
| **SMM-32** | **NEW — client review (portal UI).** Post preview + approve / request-changes in `/portal`, states reflected in the composer and calendar chips | senior-fe | default | SMM-31,12 | **NEW** (D-16) |

### P3 — AI copy + analytics + reports (+ X metering)

| # | Ticket | Tier | Model | Deps | Changed? |
|---|---|---|---|---|---|
| **SMM-19** | Brand-voice RAG + drafting (WS8 corpus ingest, caption/hashtag/idea drafting via the gateway, delivered-post feedback loop, cross-client leak test) | senior-be | default | SMM-02 | unchanged |
| **SMM-20** | **Asset attach only** — files / Drive / Studio `creative_assets` library into variant media; `ai.imageGen` toggle ships inert and names why | medior | default | SMM-19 | **AMENDED — generation removed** (D-17) |
| **SMM-21** | Metrics: `pullMetrics` → `social_metrics_daily` + `social_post_metrics`, nightly flow, Analytics tab | medior | default | SMM-05,11 | unchanged |
| **SMM-22** | **X metering live**: `social.publishPostMetered` path, estimate on the approval card, stop-loss wired into dispatch **and** the precondition, usage panel + rollups + guard flow | medior | default | SMM-08,09 | amended (D-14) |
| **SMM-23** | Reports: snapshot + AI narrative → approve → **render via `report-renderer` / print-payload** → files + Drive + deliverable | medior | default | SMM-19,21 | **AMENDED** (Δ13) |
| **SMM-24** | Docs/registration: MODULES + CHANGELOG, BFF-contract rows, toolkit entry (all four routes exist), **MAP.md regen**, runbook, AGPL source-offer footer | junior | default | SMM-14,18,21 | amended (Δ15) |
| **SMM-25** | Full-stack e2e on the live dev stack + Playwright console suite + DEMO_MODE fixtures | medior | default | all P1–P3 | unchanged |
| **SMM-33** | **NEW — capability inventory + eval register**: the per-capability table (endpoint · tool · impact class · refusal · activity · golden case) that the agentic exit bar item 6 requires | junior | default | SMM-25 | **NEW** (Δ4, D-19) |

### P4 — agents + assistant

| # | Ticket | Tier | Model | Deps | Changed? |
|---|---|---|---|---|---|
| **SMM-26** | MCP agent surface hardened for automation principals (OBO, D14), `smm-agent-content-brief` flow — agents draft, never publish | senior-be | default | SMM-19,09 | amended (image gen dropped from the brief) |
| **SMM-27** | Best-time-to-post: classical stats job + suggestion chip | medior | default | SMM-21 | unchanged |
| **SMM-35** | **NEW — assistant integration**: social drafting/summary reachable from `/assistant` through the write-intent propose → confirm → approve path (ASST-23) | medior | default | SMM-26 | **NEW** |

**Decision-gated (do not mobilize):** **SMM-28** Mixpost-Pro swap (only if SMM-04's tripwires fire) ·
**SMM-29** ClipsAI video repurposing (OQ-6) · **SMM-34** generative images — **gated on
`render-gateway-go` leaving `0.0.0`** (Creative `CR-*`), then wires into the inert `ai.imageGen`
toggle + ledger kind SMM-20 leaves in place.

**Totals:** 30 mobilized (was 27) + 3 decision-gated (was 2). Opus flags: **7** (SMM-01 med,
SMM-30 med, SMM-03 med, SMM-04 med, SMM-05 med, SMM-09 **high**, SMM-31 med). Concurrency: respect
the 1–2 agent cap; safe early pairs are (SMM-03 ∥ SMM-04) and (SMM-07 ∥ SMM-08); **SMM-09 runs
alone** — it defines the spine SMM-10/17/22/31 all consume. SMM-30 must land before SMM-02 boots
(the contract drift-guard fails against an unseeded catalog).

---

---

## §A4b · Landed 2026-08-12 — SMM-01 + SMM-30 (and what building them taught)

Both P0 substrate tickets are **DEV-VERIFIED against a real Postgres and a real Cerbos compile**, not
just written:

| Ticket | Artifacts | Verified how |
|---|---|---|
| **SMM-01** | `migrations/0105_module_social.sql` — 16 tables: 14 third-walled, `social_platform_apps` global/no-RLS, `social_post_client_reviews` on the plain core wall | All 106 migrations applied to a fresh DB; a scripted suite then proved: 14/1/1 wall split with the right tables in each bucket · third wall returns **zero rows** without module scope while the plain wall still serves the portal path · cross-tenant reads zero · unset GUC reads zero (fail-closed) · the state-law CHECKs refuse a `queued` variant with no approval and a native import carrying a provider id · duplicate `provider_post_id`, duplicate `postiz_org_id` and duplicate client reviews all refused · a cross-tenant account target refused by composite FK |
| **SMM-30** | `migrations/0106_iam_social_permissions.sql`, 8 `cerbos/policies/resource_social_*.yaml`, `approve_post` on `resource_portal.yaml`, +36 catalog entries, +9 permission groups, regenerated bundles, generator + parity-suite resolvers | `cerbos compile` clean on the whole policy dir · catalog↔policy alignment green both directions · groups↔catalog exhaustive-coverage green · DB bundles == checked-in artifact · every seeded role has a non-empty bundle · UI capability parity 548/548 · migration 0106's own five assertions fire on a fresh DB |

**Three things the build corrected in this document** (recorded rather than quietly fixed):

1. **Role names** — `smm_*` → **`social_staff`/`social_manager`** (Δ1, above). Derived from the
   module key by `derived_roles.yaml`, not free-form.
2. **The permission arm** — role arm only, for now (§A3 §11, above).
3. **SMM-30 and SMM-03 are one unit, not two tickets.** Role bundles are *generated from the Cerbos
   policies*, and `role-bundle-completeness.db.test.ts` requires every seeded role to have a
   non-empty bundle — so seeding the roles without the policies fails CI, and writing the policies
   without seeding the roles leaves them inert. §A4's dependency graph is amended: **SMM-03 is
   absorbed into SMM-30** (both landed together above); what remains of the original SMM-03 is the
   `lib/rbac.ts` capability mirror, which webdev also deferred and which moves to **SMM-11** (the
   console ticket) where it has a UI to mirror.

**Bundle-diff receipt** (the parity assertion this program requires of every IAM change): 861 → 1023
pairs, **162 added, 0 removed**. No existing user's access changed.

---

## §A4c · SMM-04 pre-spike finding (2026-08-12) — the footprint is 3x what this document assumed

Verified against upstream before mobilising the spike, because it is cheap to check and it moves a
decision. **Two of three premises hold; one is wrong in a way that matters.**

**Holds — the containment premise is intact.** `gitroomhq/postiz-app` is still **AGPL-3.0** with no
licence change, no open-core split and no commercial-edition notice; self-hosting is explicitly
supported ("no difference between the hosted version and the self-hosted version"); the public REST
API exists and is positioned for exactly our use (n8n/Make/Zapier automation, plus a Node SDK);
~34.6k stars; the network list still covers our core five. Nothing here invalidates the
architecture, and the Mixpost fallback stays unmobilised.

**Wrong — "app + own Postgres + own Redis" (§A2 D-20, §A4 SMM-04).** The published compose stack is
**nine services**, not three:

| Service | Image | Verdict for our deploy |
|---|---|---|
| `postiz` | `ghcr.io/gitroomhq/postiz-app` | required |
| `postiz-postgres` | `postgres:17-alpine` | required |
| `postiz-redis` | `redis:7.2` | required |
| `temporal` | `temporalio/auto-setup:1.28.1` | required — the queue engine the publisher runs on |
| `temporal-postgresql` | `postgres:16` | required by Temporal — a **second** Postgres, on a different major |
| `temporal-elasticsearch` | `elasticsearch:7.17.27` | **probably droppable** — Temporal has supported Postgres-backed advanced visibility since 1.20, so this is worth an explicit spike question rather than an assumption |
| `spotlight` | `getsentry/spotlight` | drop — a dev-time error viewer |
| `temporal-admin-tools` | `temporalio/admin-tools` | drop — a CLI toolbox, not a runtime dependency |
| `temporal-ui` | `temporalio/ui:2.34.0` | drop — and our doctrine forbids exposing it anyway |

Plus **6 named volumes** and **2 networks**.

**Why this matters more than a count.** The live box already runs 13 containers, this program has
already had one deploy fill the disk and roll back, and the realistic floor here is **5–6 new
containers** (app, its Postgres, its Redis, Temporal, Temporal's Postgres, and Elasticsearch unless
the spike proves it droppable) — including a second Postgres major version and, worst case, a JVM.
The upstream doc's "tested on 2 GB RAM / 2 vCPU" claim is hard to reconcile with that set and should
be treated as untested marketing until measured.

**Consequences, folded into SMM-04 rather than left as a surprise:**
1. The ticket's first output is a **measured** footprint (RAM/disk at idle and under a publish), not
   a container count. It gates on real numbers from the live box.
2. **Trimming the stack to the required set is packaging** — category (a) of the fork-touchpoint
   budget (§06), so it stays inside the thin-fork line. Dropping Elasticsearch by reconfiguring
   Temporal's visibility store is also config, not a fork.
3. **OQ-7 is upgraded from "is there disk headroom?" to a decision:** does this stack belong on the
   `gda-aicenter` box beside the ERP at all, or on its own host? That is now an owner question with
   a cost attached, and it is better asked before the spike than after it.
4. The **Mixpost fallback's tripwire list gains a line**: "the engine's own infrastructure footprint
   is not affordable on the target host" is a legitimate reason to swap drivers, independent of the
   licence question §06 was written around.

## §A4d · Owner decisions, 2026-08-13 — the open questions are closed

| # | Question | DECISION | Consequence |
|---|---|---|---|
| **OQ-7** | Where the Postiz stack lives | **Same box (`gda-aicenter`), behind its own compose profile.** | SMM-04 is UNBLOCKED and its remit tightens: the stack must be **trimmed to the required set before it is deployed**, not after. Drop `spotlight`, `temporal-admin-tools` and `temporal-ui` outright; attempt Postgres-backed Temporal visibility to drop `temporal-elasticsearch` too, taking the footprint from 9 services to 5 (app, its Postgres, its Redis, Temporal, Temporal's Postgres). The ticket reports **measured** RAM/disk at idle and under a publish, and a disk-headroom check against the live box, BEFORE anything is deployed there. The owner took this decision with the risk stated: a box already running 13 containers, in a programme that has had a deploy fill the disk and roll back. The profile is what keeps `--remove-orphans` from eating it. |
| **OQ-1** | Platform-app reviews | **Submit all four now** — Meta (Instagram + Facebook), LinkedIn, TikTok, YouTube. | Non-code, starts immediately and in parallel with everything else; it is wall-clock, not effort. TikTok's is the most restrictive and may need business verification, so it is the one to start first within the four. Gates **client** account connects only — own-brand accounts ride sandbox/dev tiers and P1 does not wait. |
| **OQ-3** | AGPL counsel sign-off | **Own accounts proceed; client connects wait for sign-off.** | Zero delay to engineering. The containment memo (§06's five invariants + the fork-touchpoint budget + source-offer mechanics) goes to counsel in parallel; no client account is connected until it returns. |
| **OQ-2** | Enable X publishing | **Settled — ships disabled** in every scope. | D-14 depends on it: a $0 publish path is what keeps `social.publishPost` eligible for the D14 executable-approval registry. |
| **OQ-5** | Video/media storage | **Settled — `files` + Drive mirror**, as SMM-08 shipped. | No further decision. |
| **OQ-4** | DM coverage | Deferred to SMM-04's measurement of Postiz's DM surface. | Answerable with evidence rather than in advance. |
| **OQ-6** | Video service line | Parked. | SMM-29 stays decision-gated. |

**Delivery mode, same decision point:** work parallelises across **3–4 agents in ISOLATED GIT
WORKTREES**. Not the shared checkout — that configuration has already produced a red release (a
release commit cut without two files its own ticket needed) and three cancelled CI runs in a single
day, and both failures were silent until something downstream broke. Worktrees keep HEAD still
under each agent and make it impossible for one ticket to sweep another's half-landed work into a
commit.

---

## §A4e · OQ-1 research, first return (LinkedIn) — three findings that change the design

The app-review research is still running; LinkedIn's leg has reported. Recorded here immediately
because one finding lands on schema that is **already deployed**. Sources are cited in the dossier
(`smm-app-review-dossier.md`); anything the researcher could not confirm is marked UNVERIFIED there
rather than guessed at, and this section inherits that discipline.

### 1. ⚠ DATA RETENTION — our schema currently cannot comply (NEW TICKET REQUIRED)

LinkedIn's Data Storage Requirements impose **maximum retention**, not minimum:

| Data | Max retention |
|---|---|
| Another member's profile data (a commenter's name, photo) | **24 hours** |
| A member's social activity (comment text, posts, likes, mentions) | **48 hours** |
| An organization's social activity | 6 weeks (6 months if that org authenticated into our app) |
| Org page admin/reporting data (follower counts, aggregate social actions — no member-level data) | 1 year |
| IDs/URNs, and an authenticated member's own profile | no restriction |

Where two rules overlap, **the shortest applies**.

**The conflict is concrete.** `social_inbox_threads` (`author_handle`, `author_name`, `excerpt`) and
`social_inbox_messages` (`body`, `author_handle`) were designed to retain indefinitely — that is
what an engagement inbox is. For LinkedIn, comment text must be purged at 48h and commenter profile
fields at 24h. `social_post_metrics` is fine (aggregate, no member data); `social_metrics_daily` is
fine (page reporting, 1 year).

This is not a bug in 0105 — it is a requirement nobody had surfaced when 0105 was written. It needs a
**per-network retention policy with a purge job**, and it must exist before the first LinkedIn client
connects, because compliance is checked at Standard Tier review and demonstrated at Technical Sign
Off. Tracked as **SMM-36** (new): retention metadata per network on the inbox tables, a scheduled
purge, and the IDs/URNs deliberately preserved so the thread survives as a shell after its content
is purged.

Two further consequences of the same rules:
- **No member-data export** — client-facing reports (SMM-23) must not carry commenter names for
  LinkedIn. Aggregate engagement only.
- **No social-feed use case** — we may not render a feed of a client's LinkedIn updates as a
  product surface. Our calendar shows *our own* scheduled/published work, which is a different
  thing, but any future "client activity feed" idea is out.

### 2. LinkedIn has NO DM API — this partly answers OQ-4 in advance

There is no messaging/conversation scope anywhere in the Marketing API surface, and the restricted-
use-cases page forbids mass messaging outright. A partner-gated Conversations API is reported to
exist but its scopes and terms are UNVERIFIED and not publicly documented. **Design LinkedIn DMs out
of scope and never promise them to a client.** OQ-4's remaining question is now only about Instagram,
Facebook and TikTok, and SMM-04's Postiz measurement answers those.

### 3. Operational constraints SMM-05/07 must be built around

- **No server-side scheduling.** `lifecycleState` accepts only `PUBLISHED` at creation, so the queue
  is ours (via Postiz) and *our* runner's availability IS publishing reliability. Consistent with
  D-1, but it makes the reconcile flow (SMM-10) load-bearing rather than a safety net.
- **Development-tier quota is 500 calls/app/day and 100/member/day, with NO webhooks and no
  BATCH_GET.** A 15-minute inbox poll per engagement would exhaust that within a handful of clients.
  The sync cadence must be scope-driven and quota-aware from the start (SMM-15), not tuned later.
- **Changing the requested scope set invalidates every existing token**, forcing every client back
  through consent. The scope list must be FROZEN before the first client is onboarded — this is a
  decision to take at SMM-07, not to discover at SMM-15.
- **Tokens need annual human re-consent** (60-day access token; 365-day refresh token whose TTL does
  not reset on use). `social_accounts.status` already models `expiring`/`expired`; the proactive
  nudge is a real requirement, not a nicety.
- **The versioned `Linkedin-Version` header sunsets roughly every 12 months.** Hardcode it and the
  publisher hard-fails about a year after shipping. It goes in config with an alert on the
  deprecation error.
- **A rejected application burns the app registration** — reapplying needs a brand-new app. The
  first submission has to be right, which is the strongest argument for the dossier this research
  is producing.

## §A4f · OQ-1 research, second return (Meta) — a number we have carried since day one is wrong

### 1. ⚠ The "IG ~25 posts/24h" figure in the design is OBSOLETE

Meta's current Content Publishing doc says **100** API-published posts per 24-hour moving period —
and, on the *same page*, **50** in its carousel section. Meta's own documentation contradicts itself,
and **25 appears nowhere in it**: that was the legacy Instagram Business API figure, and the SMM
design (§04/§08/D-12) and 0105's illustrative comment have carried it since 2026-07-23.

**We are not affected in code — by luck of design rather than foresight.** `media-rules.ts` reads the
cap from the account's live quota snapshot (`q.cap`) and hardcodes nothing; the `25`s live only in
comments, examples and docs. Two things follow:

- The registry sync (SMM-05) must populate `social_accounts.quota` from
  **`GET /<IG_ID>/content_publishing_limit`**, per-account and live — never from a constant. That
  also sidesteps the 50-vs-100 ambiguity entirely, because we ask the account what its own limit is.
- The design's `25` references mean "whatever the live endpoint reports". Anyone tempted to
  re-introduce a literal should read this section first.

This is why `checkQuota()` treats an absent counter as `quota_unknown` (a warning) rather than as
zero-used: the shipped behaviour was right, for a reason now vindicated twice.

### 2. ⚠ A real gap in shipped code: we validate media COUNT and KIND, never FORMAT

Instagram accepts **JPEG only** for image posts; PNG and WebP fail at the API. `media-rules.ts`
checks counts, kinds, mixing and alt text — but never the file format, so a PNG passes our validator
and dies at the network. That is precisely the failure D-12 exists to prevent ("we never let a human
queue what the API will reject").

Tracked as **SMM-37** (new, small): per-network accepted media formats in the validation engine, with
the transcode-or-refuse decision made explicitly. Deferred rather than patched in-flight because an
agent currently holds `src/modules/social/` in a worktree and a same-file edit would collide.

### 3. Constraints the publisher chain must be designed around (SMM-05/09/10)

- **Instagram containers expire after 24 hours.** A container cannot be pre-built days ahead: it must
  be created within 24h of the publish moment, then polled to `FINISHED` before publishing. Whether
  Postiz does this correctly is now a **specific question for SMM-04's spike**, not an assumption —
  it decides whether a week-ahead calendar is even possible on Instagram.
- **Instagram has no native API scheduling; Facebook Pages do** (`scheduled_publish_time`, 10 minutes
  to 30 days). The two networks need genuinely different scheduling paths, and for Instagram our
  queue's availability IS publishing reliability — the same conclusion LinkedIn's research reached,
  from a second direction.
- **BUC rate limits are ENGAGEMENT-DENOMINATED** (`4800 × impressions` for Instagram, `4800 × engaged
  users` for Pages). A brand-new client Page has a near-zero quota, so throttling bites hardest on
  exactly the small new accounts an agency onboards. Back off per-business off
  `X-Business-Use-Case-Usage`, never globally.
- **Carousels crop every image to the FIRST image's aspect ratio**, max 10 — worth a composer warning.
- **Stories are business-account only**; Creator accounts may not qualify. Verify per account before
  promising story scheduling.
- `ads_management`/`ads_read` become **required** when the app user holds their Page role via Business
  Manager — the normal case for agency staff. Both are heavily scrutinised at review, so the frozen
  scope list must account for them.

### 4. The review process is heavier than OQ-1 assumed

Business Verification (required for Advanced Access) → App Review with a screen recording **per
permission** → a Data Protection Assessment on a **60-day clock** whenever triggered → an **annual**
Data Use Checkup, forever. The most-cited official rejection reason is that **reviewers could not
access the app** — "your entire submission will be rejected" — which is the default outcome for an
internal ERP behind SSO. **A reachable demo path with test credentials must exist BEFORE we submit**,
and that is a build task, not paperwork.

Planning figure: **8–12 weeks** from cold start to Advanced Access on the full permission set, with at
least two review rounds. No official SLA exists for any of it.

## §A4g · OQ-1 research, third return (YouTube) — we cannot publish there for ~3 months

**Recorded late (2026-08-13).** The command that should have written this section died at bash-parse
time, so it never ran, and it was reported as recorded when it was not. Restored here from the
research verbatim; the gap was caught when the section headings were listed after a merge.

### 1. ⚠ Uploads are LOCKED TO PRIVATE until YouTube's own compliance audit passes

Verified on three official pages: every video uploaded via `videos.insert` from an API project
created after **2020-07-28** is **forced to `private`**, whatever `privacyStatus` we send. It does not
error — it silently lands private. Any project we create today is affected.

**The lift is the YouTube API Services compliance audit — NOT Google OAuth verification.** Two
separate processes, two different teams; passing OAuth does nothing for this. Consequences:

- **YouTube is upload-to-draft only until the audit passes.** A human must open YouTube Studio and
  flip each video public. A scheduled YouTube publisher is not deliverable pre-audit.
- No published SLA; reported outcomes run weeks to months (one documented five-month case). With
  OAuth verification, plan **~3 months** before client-facing YouTube publishing is operable.
- `tool_scope.networks.youtube` ships FALSE and stays false until the audit clears — same reasoning
  as `networks.x`: a toggle that cannot do what its name says is worse than an absent one.
- **UNVERIFIED, worth an empirical check:** whether `publishAt` scheduling fires at all under the
  private lock. Google does not document the interaction. Assume it does not.

### 2. ⚠ Delegated channel managers CANNOT use the API

YouTube's help page states invited Managers/Editors cannot access **YouTube APIs**, though the owner
can. The natural agency pattern — client invites `social@gaiada.com` as a channel Manager, we
authenticate as that account — **does not work**. Every client's channel OWNER must personally
complete our OAuth flow, and the only alternative is the client handing over owner credentials,
which we should refuse.

### 3. Good news, and a validation

- **CASA is NOT required.** Every YouTube/yt-analytics scope is *sensitive*, not *restricted*; only
  restricted scopes trigger the security assessment. Removes ~6 weeks and a four-figure cost.
- **The quota model changed on 2026-06-01, in our favour:** `videos.insert` costs **1 unit** from a
  separate **100 uploads/day** bucket, not 1,600 from the 10,000 pool. The real constraint is the
  default bucket (~50–100 units per fully-configured publish). **Comment polling is the quota eater**
  at agency scale; prefer the bulk Reporting API over Analytics polling.
- **Policy III.I.2 forbids automating uploads/comments "without the user's prior specific and express
  consent"**, and III.E.3.d requires consent *before* execution. **Our WS4 human-in-the-loop design is
  what makes us compliant**, and its absence is a plausible audit rejection. D-6 was right for a
  reason we had not anticipated.
- **YouTube has no DM API** — its 26-resource surface has no messages/inbox resource; the in-app
  feature was discontinued in 2019. Confirmed, not inferred.

## §A4h · OQ-1 research, fourth return (TikTok) — and what all four together mean

### TikTok's three findings

**1. ⚠ Comments and mentions are NOT on the developer platform at all.** There is no comment scope
and no mention scope on `developers.tiktok.com`; the Display API returns no comment bodies. Both live
only on the *separate* `business-api.tiktok.com` platform (Organic Accounts + Mentions APIs), which
needs its own app, Business Center linkage, and — since **2026-03-20** — a separate Accounts API
Access Application Form. **The TikTok inbox is a second workstream with its own approval clock**, not
a scope we tick on the first submission. SMM-15's scope shrinks accordingly.

**2. ⚠ Unaudited clients cannot publish publicly** — `SELF_ONLY` visibility, posting accounts must be
private, 5 users per 24h. The same private-lock shape as YouTube, from a third vendor.

**3. ⚠ Our chosen engine has been REJECTED by this exact audit, twice.** Postiz carries public issues
#1563 and #1362, both TikTok direct-post rejections for UX non-compliance. TikTok requires the API
client to show a content preview, have the creator explicitly choose `privacy_level` from
`creator_info`'s returned options **with no default**, explicitly set Comment/Duet/Stitch toggles with
disabled ones greyed out, display the Music Usage Confirmation, and handle the brand-content
disclosure toggles. UX non-compliance is the top rejection reason.

We build our own composer, so the UX obligation is ours and that half is fine. **The risk is the
transport**: if Postiz's driver does not surface `creator_info`'s options or pass an explicit privacy
level and the toggles through, our composer cannot be compliant however well we build it. This has
been sent to the SMM-04 spike as a specific question, with instructions to answer it from Postiz's
API surface and source rather than its marketing. If it is a genuine gap, it is precisely what the
Mixpost fallback exists for — and far cheaper to learn now than after submitting for audit.

**Also:** no DM API (confirmed — the only DM-adjacent scopes are Data Portability bulk *export*);
access token 24h / refresh 365 days; an undocumented `reached_active_user_cap` limits how many
distinct users may publish per client per day; Business Center caps at 200 TikTok accounts.

---

### What the four legs together change about the module

**OQ-4 is answered without the spike.** LinkedIn: no DM API. YouTube: no DM API. TikTok: no DM API.
**Only Instagram and Facebook can ever offer DMs**, so the engagement inbox is comments + mentions on
three of five networks by necessity, not by choice. SMM-15 should be scoped that way from the start.

**Three of five networks cannot publish publicly until an audit passes.** YouTube (private lock),
TikTok (`SELF_ONLY` lock) and — for client accounts — Meta and LinkedIn (Advanced Access / Standard
Tier). This is the single largest correction to the plan: **P1's "publish loop on our own accounts"
was already the right call, and is now the only possible one.** Client publishing is gated behind
weeks-to-months of review on every network simultaneously.

**Every network requires the client's own owner to authenticate personally** — LinkedIn (no shared
profile), Meta (client grants via Login for Business), YouTube (delegated managers have no API
access), TikTok (no credential-free agency access exists). Onboarding is a scheduled human ceremony
per client per network. SMM-07 must be built as a guided, resumable flow, and the re-consent nudge is
a first-class feature.

**Human-in-the-loop is not just our preference — it is what makes us approvable.** YouTube Policy
III.I.2 and TikTok's Content Sharing Guidelines both require explicit user consent BEFORE an action
executes, and TikTok additionally requires the creator to choose privacy and interaction settings
with no defaults. A fully autonomous "AI drafts and posts" flow is not approvable on either network.
**D-6 (no auto-publish, ever) was written as a safety decision and turns out to be a compliance
requirement.** The design's most conservative choice is the one that aged best.

**Roadmap consequence.** `tool_scope.networks` defaults ship FALSE for **x** (metered), **youtube**
(audit-locked) and **tiktok** (audit-locked + inbox needs a second platform). Realistic first-client
sequence is Instagram/Facebook and LinkedIn, own accounts first, with 8–12 weeks of review running in
parallel — which is exactly why OQ-1 was worth starting before the build needed it.

## §A4i · The dossier's contradictions register — and one that may force a product change

Full detail in [`smm-app-review-dossier.md`](./smm-app-review-dossier.md) (§7 lists 19). The ones
that change what we build:

### ⚠ OPEN QUESTION (OQ-8, NEW): TikTok's consent timing may be incompatible with approve-then-queue

TikTok's Content Sharing Guidelines require the creator to be shown a preview, to choose
`privacy_level` from a **live** `creator_info` fetch with no default, to set the interaction toggles
explicitly, and to **expressly consent immediately before the upload starts**.

Our spine (D-6) approves at time T and publishes unattended at T+hours. If "immediately before"
is read strictly, **scheduled TikTok posting is not approvable at all** — and this is a product
question, not an implementation detail:

- **(a)** TikTok becomes approve-and-publish-now only: no scheduling on that network, the operator
  clicks publish at the moment it goes out.
- **(b)** We treat the composer's preview + explicit selections as the consent, re-fetch
  `creator_info` at dispatch, and refuse if anything the creator chose has since changed. Defensible,
  and closer to what our `args_sha256` hash already enforces — but it is an interpretation, and the
  auditor's reading is the one that counts.
- **(c)** TikTok stays inbox-mode (`video.upload` → the creator finishes in the TikTok app), which
  our validator already warns about and which sidesteps the audit entirely.

**UNVERIFIED and not ours to guess.** The dossier marks it so, and the SMM-04 spike has been asked
whether Postiz can even carry the required fields. Escalated as **OQ-8** — an owner decision once the
spike reports, because it decides whether "schedule a week of TikTok content" is a feature we can
honestly sell.

### The rest, in order of how much they cost if missed

- **The `{"youtubeUnitsToday":1600}` example is obsolete.** YouTube's model is now three buckets
  (100 `search.list`/day, 100 `videos.insert`/day, 10,000 units for the rest, uploads costing 1
  unit); a quota reading built on that example would report headroom while uploads are already
  blocked. Closed by **SMM-37**, which models the three real buckets on `QuotaSnapshot` and gates on
  `videosInsertCallsToday`.
  **⚠ CORRECTION (2026-08-13):** this bullet originally claimed the example lived in `0105`'s
  comment. It does not, and never did — the string appears only in `smm-design.md` §04 (the frozen
  v1.0 base doc) and in the dossier's citation of it. Caught by the SMM-37 agent, which went looking
  for the string it had been told to fix, found it absent, and said so instead of quietly fixing
  something adjacent. The migration was never wrong; this addendum was.
- **TikTok gives the inbox NOTHING.** No comment scope exists on the developer platform — only
  `allow_comment` at post time. `social_accounts.capabilities.comments` must be false for TikTok, and
  P2's inbox covers four networks at most.
- **LinkedIn comment reading needs the `*_social_feed` scopes**, not `r_organization_social`. A
  submission with the wrong strings is approved and then **fails at runtime** — the worst failure
  shape, since it passes review and breaks in front of a client.
- **Facebook Pages schedule natively but only 10 minutes to 30 days out.** Our calendar has no such
  bound, so D-12 ("never let the network do the rejecting") is currently unsatisfied for FB.
  Validator work, folded into **SMM-37**.
- **`access_tier` is fleet-wide, not a LinkedIn quirk**, and `review_status='approved'` means little
  without it — a `social_platform_apps` row can be "approved" and still unable to do the thing.
- **A LinkedIn rejection burns the app registration** (new `client_id`, guaranteed OpenBao rotation).
  First submission has to be right.

### Doc-hygiene note for whoever reads the dossier next

The dossier says "§A4d doesn't exist". It did not, in that agent's worktree — the branch was cut
before §A4d–§A4h were written. Nothing to fix; the sections exist here on `main`. It is a worked
example of the shared-checkout hazard reappearing in worktree form: isolation stops agents
overwriting each other, but it does not stop them reading a stale copy of the world.


## §A4j · SMM-04 spike results (2026-08-13) — measured, and two things that need an architect

Full evidence: [`2026-08-13-smm-04-containment-spike.md`](../superpowers/plans/2026-08-13-smm-04-containment-spike.md).
Recorded here in the §A4b/§A4c style — **findings, not new decisions.** SMM-04 is
**PROTOTYPED**; the deploy is **BLOCKED**.

**The trim worked.** 9 → **5 services**, DEV-VERIFIED on local Docker: all five healthy, Postiz's
REST API driven with a real org key. `temporal-elasticsearch` **is** droppable — `ENABLE_ES`
defaults false and auto-setup provisions a Postgres visibility schema. **But** the SQL visibility
store caps custom Text search attributes at 3, Temporal pre-registers 2 and Postiz needs 2, so
Postiz's backend dies on boot **while the container still reports healthy**. One config-only
bootstrap step fixes it (`search-attribute remove --name CustomStringField`), now in the runbook.
Zero Postiz code was patched — the whole trim is category (a)/(b).

**§A4c's footprint worry was right, and understated.** Measured: **~3.4 GiB RSS** (Postiz alone
**2.27–2.83 GiB**; its orchestrator spawns one Temporal worker per network, 30+ when we need 5,
with no env var to trim it) and **~6.7 GB new disk**. Measured on `gda-aicenter` the same day:
**~4.0 GB RAM available, already 2.45 GB into swap**, 13 GB of 49 GB disk free — and **22
containers, not 13**. **The §A4c footprint tripwire has fired.** Escalated, not worked around.

**Three items that are the architect's, flagged and not taken:**

| # | Finding | Why it is not SMM-04's call |
|---|---|---|
| **1** | **OQ-7 needs revisiting with numbers.** The same-box decision was taken on a stated risk; the risk is now quantified and RAM does not fit. Options: add RAM, own host, or re-open the engine choice. | An owner decision was already taken here; only the owner can amend it. |
| **2** | **OQ-4 is ANSWERED, and the answer breaks P2's plan. Postiz has ZERO inbound surface — no comments, no DMs, for any of the five networks.** Not "unexposed": the capability does not exist. Verified from its live OpenAPI (22 `/public/v1` routes, no comments/messages controller) and its providers (only aggregate `comment_count` metrics). ⚠ `GET /public/posts/{id}/comments` exists and is a **decoy** — Prisma's `Comments` model is internal team notes on a draft. **SMM-15/16/17/18 have nothing to call.** Closing it inside Postiz needs new tables + controllers = the §06 tripwire verbatim. | P2's engagement half must be re-planned (own per-network integrations, or the Mixpost fallback whose inbox is why §06 listed it). That is a design decision. |
| **3** | **TikTok direct-post needs a ~15-line, 1-file fork-budget exception.** Publish parameters are all fine over REST (with inverted polarity + renamed fields our composer must translate). But `creator_info` — which TikTok's guidelines make mandatory — is fetched into dead code that discards `privacy_level_options` and the interaction flags, and is not reachable over REST (no `@Tool` decorator). The patch is additive, uses upstream's own extension mechanism, changes no schema and no tenancy. | It is **not** one of §06's four permitted categories, so it needs an explicit exception rather than a silent pass. SMM-04 recommends granting it. |

**Containment holds, with one caveat.** Four of five invariants verified (isolation + REST-only,
our-side tenancy, zero fork, source-offer intact). **Invariant 5 is at risk**: Postiz's OAuth
`redirect_uri` is `${FRONTEND_URL}/integrations/social/<provider>`, a *Postiz frontend page*, so
the obvious wiring serves its frontend JS to a browser. Config-only fix — point `FRONTEND_URL` at
a path `platform-ui` serves and hand the code to `POST /integrations/social-connect/{integration}`
over loopback, leaving Postiz unexposed entirely. **Reasoned from source, not yet driven; SMM-07
owns proving it** (it needs a real app credential, and OQ-1 is still in flight).

**Not blocked by any of this:** SMM-05/06 can be built against the trimmed stack locally. The
blocker is *where it is hosted*, not whether it works.

---

## §A4k · OQ-7 RESOLVED (2026-08-13) — Postiz moves to the SumoPod VPS, measured

SMM-04's footprint tripwire fired against `gda-aicenter` (§A4j): ~3.4 GiB needed on a box with 4.0 GB
available and already 2.45 GB into swap. The owner proposed an alternative host and it was measured
rather than assumed.

### The decision

**Postiz runs on the SumoPod VPS, not on `gda-aicenter`.** Owner decision 2026-08-13, superseding
§A4d's "same box, own compose profile".

| | SumoPod VPS | `gda-aicenter` | Postiz needs |
|---|---|---|---|
| RAM available | **12 GiB** of 15 | 4.0 GB, **already swapping 2.45 GB** | ~3.4 GiB |
| CPU | 4 × EPYC 7K62, load ~0.9 | contended | modest |
| Disk free | **169 GB** (19% used, after the prune below) | 13 GB of 49 GB | ~6.7 GB day-one + media growth |

RAM headroom is 3.5×, and the disk question is closed outright rather than managed.

### How the disk was freed — and why it was safe on a production box

The VPS carries the owner's **private production projects (19 containers, project-hug among them)**,
so the prune was scoped to what provably cannot affect a running service:

- **Docker build cache: 147.3 GB total, 118.6 GB reclaimable, 2467 entries, ZERO active.** Build
  cache only accelerates future `docker build`s — removing it cannot stop a container or delete an
  image. Pruned. **136 GB reclaimed; 85% → 19% used.**
- **Images (4.3 GB reclaimable) were deliberately NOT pruned.** On a box running someone else's
  production, removing a tagged image risks a restart finding nothing to start from. 4 GB is not
  worth that.
- Volumes and containers untouched. All 19 containers verified still running afterwards.

**Standing operational note:** 2467 cache entries had accumulated to fill a 217 GB disk to 85%. That
will creep back. A periodic `docker builder prune -af` belongs in this box's maintenance, or the same
condition returns and next time it may bite a production deploy rather than our spike.

### What this changes, and the new work it creates

**Accepted by the owner, with reasoning worth recording:** the ERP dev box and the publisher now sit
on different hosts, so `platform-nest → Postiz` leaves the machine. The owner's position is that this
is acceptable now (the company box is a personal dev environment) **and actively useful** — a
cross-host hop produces real latency and failure-mode data for what staging and production will look
like, instead of a localhost illusion that has to be re-learned later. That is a better reason than
convenience and is recorded as the rationale, not just the outcome.

The consequences are real work, and they land on SMM-04/05/06:

1. **§03's "private network" premise no longer holds.** The REST hop crosses the public internet, so
   it needs TLS plus an authenticated, firewalled channel — an org API key over a trusted LAN is no
   longer the whole story. Firewall allowlist both directions between the two hosts.
2. **The edge design changes shape.** The spike built a loopback-only exposure with an exact-path
   nginx allowlist. Now `platform-nest` itself is a remote caller, so the allowlist must admit it
   explicitly — narrowly, by source address, not by opening the API.
3. **Latency enters the reconcile loop.** Publishing is unaffected (it is already async), but the
   status-poll cadence in SMM-10 now pays a network hop per call.
   **⚠ CORRECTED (2026-08-13, measured — see §A4l):** I wrote "internet RTT" as though it were a
   real cost. SMM-04b measured it from `gda-aicenter`: **2.6 ms**, ~3 hops, 8/8 ICMP — a LAN-grade
   number. The 15-minute cadence stands unchanged and sweep cost is dominated by in-flight post
   count, not latency. The genuine latency cost on this hop is **media upload**, which is why the
   adapter splits its timeouts (connect 5 s, read 30 s, upload 120 s) instead of using one value.
4. **The AGPL containment argument is unchanged and arguably stronger** — the licence zone is now a
   different machine entirely, which makes "arm's length, REST only, no shared process" easier to
   demonstrate, not harder.

**SMM-04 is unblocked.** Its compose file, digest pins, `.env` guards and runbook section carry over;
what changes is the host it targets and the ingress/egress rules around it.

> **Implemented and measured in §A4l (SMM-04b), immediately below.**
> Two of the four consequences above shrank once the hop was measured rather than
> assumed. Consequence 1 stands but the hop is **2.6 ms** and ~3 network hops, not internet
> latency; consequence 2 was **not** implemented as an allowlist addition — the edge did not move
> and the public surface did not grow, because the transport is a WireGuard tunnel with no public
> listener on the VPS at all; consequence 3's cadence stays at 15 minutes for reasons §A4l §4
> re-derives; consequence 4 is unchanged. Read §A4l §6 before trusting the spike report: the
> `docker image prune` step in its runbook procedure was **dangerous on this host** and has been
> removed.

## §A4l · SMM-04b — the retarget, and the measurement that shrinks its biggest consequence

§A4k resolved *where* Postiz runs. This section is what implementing that decision actually
costs, and one number that makes a large part of §A4k's own consequence list smaller than it
looked. **Findings and mechanism, not new decisions** — the one thing here that is genuinely a
choice (the transport) is recommended with its alternatives priced, for the owner to accept or
reject. SMM-04 stays **PROTOTYPED**; nothing has been deployed to the VPS, and per the ticket's
hard constraint nothing was.

### 1. ⚠ "The REST hop crosses the public internet" is true in law and misleading in practice

§A4k reasoned about a cross-host hop as though it meant internet latency. Measured, read-only,
from `gda-aicenter` on 2026-08-13:

| Probe | Result |
|---|---|
| ICMP RTT to `150.109.15.108`, 8 packets | **2.473 / 2.604 / 2.956 ms** min/avg/max, 0% loss |
| TCP handshake (`time_connect`), 5 samples | **2.0 – 3.0 ms** |
| `traceroute` | hop 1 is still inside Google's network; ~3 hops apart |
| Path MTU, DF-bit at 1460 bytes | passes end to end |

**The two hosts are effectively in the same metro.** The hop costs ~2.5 ms more than loopback,
not the 50–250 ms "internet RTT" the phrase invites. That does not make the hop private — it is
still off-machine and still needs encryption and authentication — but it removes latency as a
design constraint, and consequence 3 of §A4k ("latency enters the reconcile loop") turns out to
be the smallest of the four rather than the one to budget around. **Section 4 below re-derives
the cadence from the measurement instead of from the assumption.**

### 2. The transport: WireGuard point-to-point — RECOMMENDED, with the alternatives priced

`gda-aicenter` `10.88.0.1` ↔ VPS `10.88.0.2`, UDP/51820, one inbound rule scoped to
`35.240.135.48`. Postiz's published port binds to the tunnel address, so **the VPS gets no
public listener of any kind** — not `:443`, not `:80`, not `:4007`.

| Option | What it costs to operate | Honest read |
|---|---|---|
| **WireGuard (recommended)** | Two `wg0.conf`s, one package, one systemd unit per host. Then: no DNS, no certificate, no renewal, no cron. Health is `wg show wg0 latest-handshakes`. | Peer authenticated **by key**; ChaCha20-Poly1305 below HTTP; silent to unauthenticated probes. Its one real weakness is that keys are long-lived with no expiry to force rotation — **rotation is a manual ops item on host rebuild or staff change**, and that is the thing it does worse than certificates. |
| nginx + Let's Encrypt on the VPS | A DNS record, a public `:443` and `:80` **on a box running the owner's unrelated private production**, a certificate renewing forever, and a source-address ACL. | Satisfies the *letter* of "TLS on the hop". But it authenticates a **network position, not a party**: it holds only while routing, NAT and the ERP's public address are unchanged, and one typo publishes `/api/public/v1/*` to the internet. It also means we introduced a new public attack surface onto someone else's machine. |
| SSH tunnel / `autossh` | Fastest to stand up; no new listener. | **Reject.** It needs a shell-capable credential on the production VPS held by the ERP box — a far larger blast radius than a peer key that reaches one TCP port. `autossh`'s characteristic failure is a half-open tunnel that accepts connections and never delivers: the "green health over a dead service" shape this estate has already been burned by twice. Keep it named only as an emergency bridge. |

**On "the ERP must reach Postiz over TLS".** WireGuard meets the intent — confidentiality,
integrity, and mutual authentication of the hop — with a *stronger* authentication property than
TLS-plus-IP-allowlist, one layer lower. TLS inside the tunnel is cheap to add later if an audit
checklist demands the literal word; it would buy nothing cryptographically and is not
recommended now.

**Measured prerequisites** (read-only, `gda-aicenter`): kernel 6.1.0-51-cloud-amd64, Debian 12;
`wireguard.ko` **present**; `wireguard-tools` **absent** (one `apt install`). The VPS side is
unverified — no credential for that host exists on the working machine, and asking for one was
preferred to inventing one. See §6.

> **⚠ MTU trap, and it targets exactly the wrong traffic.** `wg-quick` defaults the tunnel to
> MTU 1420, derived from a 1500-byte underlay. **`gda-aicenter`'s `ens4` is 1460** (GCP's
> default), so 1420 is 40 bytes too large. Small requests work perfectly and the link looks
> healthy; what black-holes is the traffic that fills packets — **media uploads**, the one thing
> on this hop that sends megabytes. Set `MTU = 1380` on both ends and verify with a DF-bit ping
> before believing the link. Procedure and verification in the runbook.

### 3. The edge did NOT move, and the ERP was NOT added to the allowlist

§A4k's consequence 2 anticipated that the allowlist would have to admit `platform-nest`
explicitly. **It does not, and refusing that is the point.**

- The OAuth callback and webhook blocks **stay on `erp.gaiada.online`, on `gda-aicenter`** — the
  estate's one reviewed public edge, which already terminates TLS, already rate-limits and
  already has a rollback people have used. The only change to
  `infra/nginx/snippets/gaiada-social-postiz.conf` is `proxy_pass`: `127.0.0.1:4007` →
  `10.88.0.2:4007`. Same two paths, same limits, nothing widened.
- **`FRONTEND_URL` is unchanged** (`https://erp.gaiada.online/social`, a path `platform-ui`
  serves). The spike's §7 preferred design gets *cheaper* under the split, not harder: the
  callback still lands on a URL that is public for reasons predating SMM, and the hand-off to
  Postiz's backend goes over the tunnel instead of over loopback. Because the registered
  `redirect_uri` string does not change, **the host move cannot invalidate an already-connected
  account** — that hazard is real but this change does not trip it.
- The ERP reaches `/api/public/v1/*` over the tunnel, where there is no public listener to
  allowlist. **The public surface does not grow by one path as a result of the host move.** If
  anyone later proposes an ERP `location` block on a VPS vhost, that is the proposal to refuse.

**The honest cost, stated rather than buried.** Who can reach Postiz's full surface is unchanged
*in kind* — before, anyone with a shell on `gda-aicenter`; now, anyone with a shell on either
host, or holding the tunnel's private key. The perimeter is two hosts wide instead of one. "The
tunnel is the new loopback" is a claim worth checking, not assuming, and the runbook asserts the
negative (`curl` :4007 from a third machine must time out) as hard as the positive.

### 4. Reconcile cadence (SMM-10) — keep 15 minutes; the latency is not where the cost is

Design §10 sets `smm-post-status-sync` at a webhook trigger plus a 15-minute safety poll.
**Recommendation: leave it at 15 minutes.** The reasoning, now that the number is measured:

- The sweep's wall-clock is dominated by the **number of in-flight posts**, not by RTT. At
  2.6 ms, even a naive per-post loop over 200 variants costs ~0.5 s of network time. 15 minutes
  was chosen for *freshness*, and freshness is unaffected by the host split.
- **Batch the sweep anyway.** `GET /public/v1/posts` takes a date range, so one authenticated
  call per (org, window) covers the period. Per-call RTT then amortises to nothing and the
  cadence stays a freshness decision rather than a cost decision.
- **Do not add a tight post-dispatch poll.** If the console wants "did it publish?" freshness at
  the scheduled instant, use a bounded decaying re-check on that one post — **+60 s, +5 min,
  +15 min**, then fall back to the sweep. Three extra calls, not a busy loop.
- **Set the adapter's HTTP timeouts explicitly.** This estate has already shipped a default
  30 s timeout against a real 31–40 s round trip (the n8n dispatcher, `dispatcher_unreachable`
  after the run was already created). Recommended: **connect 5 s, read 30 s, media upload 120 s.**
- **⚠ The real latency cost is media upload, not status polling.** Every image and video now
  crosses a host boundary before it ever reaches a network. That is the one call whose duration
  changed by more than milliseconds, and it is also the one the MTU trap above breaks silently.
- **Cross-host makes §11's ambiguous-publish rule load-bearing.** A timed-out publish call is
  materially more likely off-machine than over loopback, so "no auto-retry of ambiguous publish
  failures" stops being a theoretical safeguard and becomes the thing that prevents a
  double-post. SMM-10 should treat it as a tested path, not a comment.

### 5. Key custody (D-5) — unchanged in shape; two new facts about where it lives

The three-way split holds exactly as written in §11. What the retarget adds:

- **The Postiz org API key now travels on every call** (custody split (b)), as an `Authorization`
  header, **inside the tunnel**. It is still server-side only: `platform-nest`'s env → the
  adapter → the wire. Never platform-ui, never n8n credentials, never a tenant row, never an
  audit line. Named in the contract as `SOCIAL_POSTIZ_ORG_API_KEY` (see §7) so a rename cannot
  drift across two hosts. Two logging obligations follow, both cheap and both easy to miss: no
  nginx log format on either host may include `$http_authorization`, and the adapter's OTel/module
  logging keeps to org/network/op as §11 already specifies.
- **⚠ The platform-app credentials (custody split (a) — the moat) now live on a host that also
  runs unrelated private production.** `SOCIAL_FACEBOOK_APP_SECRET` and its siblings move to the
  VPS's `.env`, because that is where the Postiz container reads them. That is a real change in
  custody surface and it is an owner-visible fact, not an implementation detail. Mitigations in
  the runbook: `.env` at mode 0600 under a dedicated directory, and rotation on decommission of
  that host. **Client network tokens are unaffected** — custody split (c) keeps them inside
  Postiz, which is now simply a different machine.
- **Confirm the VPS's backup regime does not snapshot the Postiz volumes.** The "never back up
  volumes holding live OAuth tokens" rule is ours; that box's backup policy is the owner's.

### 6. What the host change invalidates in the SMM-04 spike — read before trusting it

The spike report carries a retarget banner and a §12 with the same list. In short:

| Spike claim | Status after the retarget |
|---|---|
| §5, `gda-aicenter` headroom (4.0 GB / 13 GB / 22 containers) | **Moot as a gate, still correct as facts.** The tripwire was cleared by changing hosts, **not** by shrinking the footprint — that is unchanged (~3.4 GiB RSS floor; ~7.6 GB day-one disk on the VPS, up from ~6.7 GB because none of the base images are resident there). |
| §4's `mem_limit: 3g` on `postiz` | **Raised to 4g, deliberately.** 3g was a 6% margin over a measured peak on a process whose RSS was *still climbing* when measurement stopped — on a 12 GiB host that converts a normal soak into a routine OOM-kill and destroys the signal. The limit's job also changed: it no longer protects the ERP (different machine) — **it protects the owner's 19 production containers.** All five limits sum to ~5.97 GiB of ~12 GiB. |
| §11.4, "RSS was still drifting; treat §4 as a floor" | **More important now, not less.** 12 GiB of headroom invites complacency about an orchestrator that spawns 30+ Temporal workers with no env var to trim it. A soak test is still owed. |
| §10, runbook step 0: `docker image prune -a --filter until=168h` | **⚠ DELETED, and must not come back.** It was correct against 13 GB of free disk and our own images. On the VPS it would delete images belonging to production that is not ours. Replaced by a `docker ps -a` baseline/diff and a `df -h`. The safe maintenance item is `docker builder prune -af` (build cache only, provably inert), per §A4k. |
| §10's `--remove-orphans` analysis | **Still true and now doubly so** (separate project *and* unreachable host) — but a **new** trap replaces it: the VPS has 19 containers in other people's compose projects, so any non-project-scoped Docker command there is the danger. Rules in the runbook. |
| §6/§7 containment audit, invariants 1–5 | **Unchanged, and invariant 1 is stronger** — the licence zone is now a separate machine, which makes "arm's length, REST only, no shared process" easier to demonstrate. §A4k's point 4 holds. |
| §7 preferred ingress design | **Unchanged and cheaper.** Still unverified end to end; still SMM-07's to prove. |
| §11.2, "nothing was run on `gda-aicenter`" | **Extend it: nothing has been run on the VPS either.** All footprint numbers remain local-Docker floors. New unverified items: the tunnel itself, and every VPS-side prerequisite in §7 below. |
| §8a (TikTok fork exception), §8b (**OQ-4: Postiz has ZERO inbound surface**) | **Untouched by the host change.** Both remain the architect's, and §8b still means SMM-15/16/17/18 have nothing to call. |

### 7. Blocked on facts, not on decisions — what still needs a credential

Everything above about the VPS is planned from the owner's stated measurements plus this repo,
because **no SSH credential for `150.109.15.108` exists on the working machine** (`~/.ssh/vps_zenvix`
is referenced by project-hug's DEPLOYMENT.md and is absent). Asking was preferred to inventing.
Four read-only checks would close it, and all four are one line:

1. `ls /lib/modules/$(uname -r)/kernel/drivers/net/wireguard/` — is `wireguard.ko` present?
   (Ubuntu 24.04 ships it; unverified on this host.)
2. `ip -o link show` — the underlay MTU, to confirm 1380 is right from that side too.
3. `sudo ufw status` and `sudo iptables -S DOCKER-USER` — what the firewall actually does, and
   whether anything already contends for UDP/51820 or TCP/4007.
4. `docker ps -a --format '{{.Names}}'` — the 19-container baseline to diff against later.

Nothing in the plan changes if all four come back as expected; they are confirmations, and each
one is a thing that would otherwise be discovered during a deploy onto someone else's production.

**The contract SMM-05 implements** (named here so it cannot drift across two hosts):

| Var | Host | Meaning |
|---|---|---|
| `SOCIAL_POSTIZ_BASE_URL` | `gda-aicenter` | `http://10.88.0.2:4007` — the tunnel peer. Not a public hostname, not https: there is no public listener to name, and the tunnel supplies what https would. A tunnel outage must fail closed here, loudly. Never "fix" it by pointing at a public address. |
| `SOCIAL_POSTIZ_ORG_API_KEY` | `gda-aicenter` | Custody split (b). Server-side only; sent as `Authorization`; rotating it is a two-host edit. |
| `SOCIAL_BIND_ADDR` | VPS | `10.88.0.2`. **Never `0.0.0.0`** — Docker's published-port rules are evaluated before ufw's, so a `0.0.0.0` bind is internet-reachable on a box whose firewall reports "deny incoming". Default is `127.0.0.1` so a missing value fails safe. |
| the rest of `SOCIAL_*` | VPS | Filling these into `gda-aicenter`'s `.env` does **nothing** — no service there names them — while scattering the group's app secrets onto a host with no use for them. `.env.example` now banners both halves. |

---

## §A4m · SMM-04b's four outstanding confirmations — closed (2026-08-13, read-only)

SMM-04b could not obtain these (no SSH credential in its worktree) and correctly listed them as
things that would otherwise be discovered mid-deploy on a box running the owner's production. All
four were run read-only against the VPS. **Two came back clean; two produced work.**

| # | Check | Result |
|---|---|---|
| 1 | `wireguard.ko` present | ✅ `/lib/modules/6.8.0-101-generic/.../wireguard.ko.zst` — kernel side ready |
| 1b | `wg` / `wg-quick` userspace tools | ❌ **NOT installed** — `wireguard-tools` is a prerequisite, not an assumption |
| 2 | VPS underlay MTU | `eth0` = **1500** — the VPS is NOT the binding constraint |
| 3 | Firewall | `ufw` **active**; `DOCKER-USER` chain exists but is **EMPTY**. (See the correction below — the port list I first reported was truncated.) |
| 4 | Container baseline | **19 running / 20 total** — matches the pre-prune baseline exactly |

**Two of these change the plan.**

**(a) `wireguard-tools` is missing.** The kernel module is present so the design holds, but
`wg-quick up` would simply fail. It becomes an explicit, ordered prerequisite in the runbook.

**(b) The empty `DOCKER-USER` chain is the important one — and it argues FOR the WireGuard design.**
Docker inserts its own iptables rules ahead of `ufw`, so **a Docker-published port bypasses `ufw`
entirely**: `ufw` reporting "active, 22 and 80 only" would be actively misleading about a container
publishing `4007`. On a box running the owner's private production, that is not theoretical.
SMM-04b's design binds Postiz to the tunnel address and publishes nothing, sidestepping the trap
rather than mitigating it. Had we taken the nginx + public `:443` + source-ACL route, `DOCKER-USER`
is exactly where that ACL would have needed to live — and its emptiness is how such an ACL silently
ends up not applying at all.

**MTU confirmed by derivation, not guess:** the VPS side is 1500, so `gda-aicenter`'s GCP `ens4` at
1460 is the binding end. WireGuard's IPv4/UDP overhead is 60 bytes, giving a 1400 ceiling; SMM-04b's
**MTU 1380** sits safely under and is correct as written. The failure mode it prevents deserves
restating because it is invisible: small requests all succeed and the link looks healthy, while media
upload — the only megabyte traffic on this hop — black-holes.

**DONE (2026-08-13):** `wireguard-tools` v1.0.20210914 installed (`/usr/bin/wg`, `/usr/bin/wg-quick`)
and `ufw allow from 35.240.135.48 to any port 51820 proto udp` added, commented for provenance.
Verified additive: apt reported "No containers need to be restarted", and the container count was 19
before and 19 after.

**⚠ CORRECTION to row 3 (2026-08-13).** I reported `ufw` as "active, allowing 22/tcp and 80/tcp
only". That was an artefact of reading a `head -6` truncation as the whole list. The actual ruleset
also opens **443/tcp, 9090/tcp, 3010/tcp and 3001/tcp to Anywhere**. This changes nothing about our
design — Postiz still publishes no port and rides the tunnel — but it is worth stating plainly for
two reasons: a truncated command output was mistaken for a fact, and **9090 is conventionally
Prometheus, which ships with no authentication**. Those ports belong to the owner's own private
production and are the owner's call, not this programme's; flagged rather than touched.

## §A4n · SMM-05 landed (2026-08-13) — what §05 got wrong, and what the port now says instead

**Findings, not new decisions** — same discipline as §A4b/§A4j. SMM-05 is **DEV-VERIFIED against a
mock/contract suite** (163/163 across `src/modules/social`, 59 of them new); the engine itself is
still undeployed, so nothing here is evidence about a live network. Code:
[`platform-nest/src/modules/social/publisher/`](../../platform-nest/src/modules/social/publisher/).

### 1. Three members of design §05's interface did not survive contact with the product

The §05 sketch predates the measurement. Corrected in the shipped port rather than carried:

| §05 member | What it says now, and why |
|---|---|
| `createOrg(ref)` | **Capability-gated; the Postiz driver refuses `capability_unsupported`.** There is no org-creation route in the 22-route public surface. An org is minted by the runbook's one-shot registration ceremony on the licence-zone host — flip `DISABLE_REGISTRATION` false, `POST /api/auth/register` once, flip it back, verify the door is shut. Giving the ERP an HTTP path to that would mean either forking the engine or leaving its signup open, and the second is containment invariant 5's neighbour. So provisioning **adopts** an operator-created org: `verifyOrg` proves the pair answers and our row is the mapping — which was always the half that was ours (D-2). The method stays on the port because a driver that CAN mint orgs (Mixpost) should not need an interface change to say so. |
| `listComments` / `sendReply` | **OPTIONAL members, unimplemented by the Postiz driver.** §8b's "zero inbound surface" is a capability fact, and making them required would have forced a method that throws — which reads as a bug and invites a retry. Absent, they are a fact the registry mirrors (`capabilities.comments=false, unsupported.comments='driver'`) and the console can explain. |
| `getPostStatus(orgId, ids)` | **Batched and date-ranged**, not a per-id loop, per §A4l §4. One authenticated call per (org, window) keeps the 15-minute cadence a freshness decision instead of a cost decision. |

Everything else in §05 held, including — worth saying plainly — the decision to put the port inside
platform-nest at all. The retarget made the licence zone a separate machine, which makes the
"arm's length, REST only, no shared process" claim easier to demonstrate, not harder.

### 2. The containment lint §11 asked for did not exist. It does now.

§11 states it verbatim — "lint-enforced zero Postiz deps in platform-nest" — and nothing enforced
it. `npm run lint:postiz-deps` is now a CI gate: no Postiz package in `package.json`, no
Postiz-ish specifier in any import/require position in `src/`. It deliberately does **not** ban the
*string* "postiz" (`postiz_org_id` is a column, `SOCIAL_POSTIZ_BASE_URL` is a config key) — banning
the word trains people to work around the lint, and what matters is a module boundary being crossed.

### 3. Two capability facts are now first-class data, because they are not the same fact

`social_accounts.capabilities` carries an `unsupported` reason per false: **`network`** (the platform
has no such API — TikTok comments §A4h, LinkedIn/YouTube/TikTok DMs §A4e/§A4g/§A4h, YouTube/TikTok
public posting), **`driver`** (our engine cannot reach it *yet* — today that is comments and DMs on
every network), **`unverified`** (the four networks 0105 admits that OQ-1 never researched; treated
as unavailable and labelled, rather than given a confident "no"). Collapsing these into one boolean
would send someone to evaluate Mixpost over a gap no engine can close, or leave a closable gap
looking permanent.

### 4. The Instagram live-quota probe is BUILT but transport-BLOCKED, and that is a named gap

§A4f is implemented end to end — `getQuota` → `content_publishing_limit` → `social_accounts.quota`,
with a source-grepping test that fails if anyone reintroduces a cap literal. But we cannot call
Graph ourselves (custody split (c) keeps the token inside the engine), so the probe must ride
`POST /public/v1/integration-trigger/:id`, which upstream gates on a `@Tool` decorator — and the
spike proved the TikTok provider carries none. **Whether the Instagram provider carries one is
UNVERIFIED**, so the trigger name is configuration (`SOCIAL_POSTIZ_QUOTA_PROBE_TOOL`), empty by
default, and the registry records `quotaSource: 'probe_unavailable'` until someone confirms it
against a live engine with a connected IG account. Downstream that is the existing `quota_unknown`
warning, which §A4f already vindicated twice. **If the decorator turns out to be absent there too,
this is a second candidate for the same fork-budget exception §8a requested for `creator_info` —
architect's call, flagged not taken.**

### 5. One boot refusal added, deliberately the inverse of the search module's

`SOCIAL_POSTIZ_BASE_URL` pointing at a **public** address aborts startup. The search guard refuses a
*live* vendor URL pointed somewhere *private*; here the hazard runs the other way — the engine holds
every client's live network tokens and was deliberately given no public listener at all, so the only
correct value is a tunnel address and a public one means the perimeter moved. Same doctrine, opposite
polarity, and the shared host classifier is reused so "what counts as private" cannot drift between
them. It is honest about being a lexical ACCIDENT guard, not an authz control.

### 6. Still owed, and owed by someone else

- **SMM-09 owns the publish gate.** The port exposes `schedulePost` and the dispatch-chain check; no
  approval path, no publish endpoint and no publish MCP tool were wired here, on purpose.
- **P2 (SMM-15/16/17/18) still has nothing behind this port to call.** §A4j finding 2 is unchanged
  and remains the architect's.
- **`connectTimeoutMs` is carried but not independently enforced** — global `fetch` has no
  connect-phase deadline without an undici `Agent`, so a black-holed connection is caught by the read
  deadline instead. Stated in config, `.env.example` and the driver header rather than quietly
  conflated.
- **Every Postiz route beyond the five the spike drove is ⚠UNVERIFIED**, collected in one exported
  `POSTIZ_ROUTES` table so the first live drive (SMM-07) corrects them in one edit.

## §A5 · Sequencing note — what to do first

1. **SMM-30 + SMM-01 together** (they are one schema conversation: tables, then the permission rows
   that reach them). Nothing else can boot cleanly first.
2. **SMM-04 in parallel** — it is the only ticket that can invalidate the architecture (containment
   tripwires → Mixpost), and it needs live-box facts (disk, profile) that take wall-clock to get.
3. Then the P0 remainder → P1 in dependency order, with SMM-09 alone.
4. **Non-code, starting now, independent of all of the above:** OQ-1 platform-app review
   submissions and OQ-3 counsel sign-off. Both gate *client* connects, not the build — own-brand
   accounts carry P1 without either.

---

*Cross-references:* [base design](./smm-design.md) · [foundation](./smm-foundation.md) ·
[agentic-native bar](../superpowers/plans/2026-08-03-agentic-native-erp-plan.md) ·
[permission contract](../PERMISSION-CONTRACT.md) · [BFF contract](../FRONTEND-BFF-CONTRACT.md) ·
[MAP](../MAP.md) · [`approval-executables.ts`](../../platform-nest/src/core/approval-executables.ts) ·
[`approval-grant.ts`](../../mcp-hub/src/approval-grant.ts) ·
[0088's RLS-wall header](../../platform-nest/migrations/0088_webdev_change_requests.sql) ·
[`deptToolkits.ts`](../../platform-ui/src/lib/deptToolkits.ts)
