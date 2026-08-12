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
