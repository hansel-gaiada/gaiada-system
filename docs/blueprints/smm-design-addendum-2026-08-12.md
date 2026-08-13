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

- **`{"youtubeUnitsToday":1600}` in 0105's comment is actively misleading.** YouTube's model is now
  three buckets (100 `search.list`/day, 100 `videos.insert`/day, 10,000 units for the rest, uploads
  costing 1 unit). A quota reading built on that example would report headroom while uploads are
  already blocked. Folded into **SMM-37**.
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
