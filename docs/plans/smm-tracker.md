# SMM department — delivery tracker

**This file is the single source of truth for SMM ticket state.** It is updated as part of the work,
not afterwards.

- **Binding design:** `docs/blueprints/smm-design-addendum-2026-08-12.md` (overrides `smm-design.md` v1.0)
- **Session log + decisions:** `docs/superpowers/plans/2026-08-14-smm-session-handoff.md`
- **Ops runbook:** `docs/runbooks/social-postiz-org-ceremony.md`
- **App-review dossier:** `docs/blueprints/smm-app-review-dossier.md`

## Update protocol — read before ticking anything

1. **A ticket moves to ✅ only when it is merged to `main` AND its acceptance was verified by running
   something.** Not "the seat reported green" — this module produced five silent no-ops in one week,
   every one behind a passing suite.
2. **Record the evidence**, not the claim: test counts as passed/failed/**skipped** (three numbers), and
   whether a UI change was driven **in a real browser** or only unit-tested. A skipped suite is not a
   passing suite; an in-process test can be silent about the thing that breaks.
3. **🟡 partial is a real state.** Use it, and say in one line what is missing.
4. **Status language:** PLANNED → IN PROGRESS → DEV-VERIFIED. Never "done" or "complete".
   Distinguish **deferred** (a scheduling fact) from **blocked** (an impediment).
5. Update `docs/modules/MODULES.md` + `CHANGELOG.md` in the same commit when a module version moves.
6. Keep the **Recurring defect classes** section current. It is the most useful thing here.

---

## Scoreboard

| Phase | Landed | Total |
|---|---|---|
| P0 foundation | **6** | 6 ✅ |
| P1 publish loop | **12** | 12 ✅ |
| P2 inbox + client approval | 0 | 6 |
| PD `direct` driver (SMM-38) | 0 | 5 phases |
| P3 content ops | 1 (+2 partial) | 8 |
| P4 agents + assistant | 0 | 3 |
| Decision-gated | — | 3 (1 dead) |

Module: `social-media 0.5.2 · IN PROGRESS` — publish loop **DEV-VERIFIED against the mock driver**;
live network publishing **deferred to staging** (D-23).

---

## P0 — foundation ✅

| # | Ticket | State | Evidence |
|---|---|---|---|
| SMM-01 | Schema: 16 tables, two RLS walls (`0105`) | ✅ | applied in production |
| SMM-30 | IAM: 36 perms, 8 Cerbos policies, 9 groups, `social_staff`/`social_manager` (`0106`) | ✅ | 6 guard suites green; UI parity 548/548 |
| SMM-03 | Cerbos policies + both arms | ✅ | absorbed into SMM-30 (bundles generate from policies) |
| SMM-02 | Module shell, contract, engagement CRUD, tool-scope, 4 MCP tools | ✅ | |
| SMM-04/04b | Postiz containment spike; 9→5 services; retargeted at the VPS over WireGuard | ✅ | deployed; ERP→Postiz 401 in 43 ms |
| SMM-05 | `SocialPublisher` port + Postiz driver + org provisioning + registry sync | ✅ | |

## P1 — publish loop on own accounts ✅

| # | Ticket | State | Evidence |
|---|---|---|---|
| SMM-08 | Composer backend, validation engine, `args_sha256` | ✅ | |
| SMM-11 | Console shell, toolkit, Calendar + Composer, `lib/social.ts` | ✅ | |
| SMM-37 | Validator gaps: media format, FB schedule window, YouTube 3-bucket quota | ✅ | |
| SMM-06 | Config plumbing + compose `environment:` passthrough | ✅ | **found the ERP receiving ZERO `SOCIAL_*` vars**; verified live: all nine reach the container |
| SMM-09 | **The publish gate** — 6-stage precondition, grant verification, edit-invalidates-approval, replay refused, no auto-retry, barred metered twin | ✅ | 66 new tests; caught the module-GUC trap in the executor |
| SMM-36 | Per-network inbox retention + purge | ✅ | LinkedIn 24h/48h documented, all others explicitly `unverified`; 14/14 on live PG after fixing a dead purge |
| SMM-10 | Dispatch + reconcile, single-transaction `approval_id`+`provider_post_id` stamp, MCP tool declared, D-22 verifier installed | ✅ | 217/217; mcp-hub 247/247 |
| SMM-12 | Calendar/Composer UX: grid, chips, drag-reschedule, quota strips, submit-with-preview | ✅ | all 16 refusal tokens rendered; **browser-driven in SMM-14** |
| SMM-13 | Events → notifications + risk-shaped mail | ✅ | 3 real defects fixed (module GUC, empty `toEmail`, vacuous assertions) + the wiring fix below |
| SMM-39 | Media upload before dispatch; refs in `uploaded_media`, outside the approval hash | ✅ | 225/225; idempotent per (variant, file); partial failure refuses |
| SMM-07 | Account connect — BFF-brokered, org-scoped, resumable | ✅ | 234/234; three new refusal codes; no migration needed |
| SMM-14 | **QA gate** — P1 e2e, golden cases, MODULES/CHANGELOG | ✅ | 289 / 0 / 0 backend · 2329 / 0 / 0 UI; 3 assertions driven in a real browser |
| — | **Consumer-loop wiring fix** (`social_post_variant`) | ✅ | `main.ts` never drained the stream; SMM-13's handlers were never invoked |
| — | **Postiz org ceremony** | ✅ | one org `Gaiada`, alias `default`; signup proven closed; key rotated twice; driver registering at boot |

## P2 — engagement inbox + client approval ⬜

| # | Ticket | State | Gate |
|---|---|---|---|
| SMM-31 | Client review backend: `social_post_client_reviews` state machine, portal decide, `portal.approve_post`, idempotent decision | 🔵 **IN FLIGHT** | none — buildable now |
| SMM-32 | Client review portal UI: preview + approve / request-changes | ⬜ | SMM-31 |
| SMM-15 | Inbox sync (`pullInbox`, idempotent upsert) | ⬜ | **SMM-38** — Postiz has ZERO inbound surface (OQ-4) |
| SMM-16 | AI triage: sentiment/category/urgency, spike detection, SLA | ⬜ | SMM-15 |
| SMM-17 | Reply flow: drafts → WS4 → send (own registry entry) | ⬜ | SMM-15; should set `neverAutoRetry` |
| SMM-18 | Inbox tab UI: triage queue, thread view, SLA timers | ⬜ | SMM-15/16/17 |

## PD — the `direct` driver (D-20) ⬜

Second `SocialPublisher` implementation alongside Postiz, switched per capability. The only free path
that removes the AGPL zone, both fork exceptions and the inbox gap together.

| Phase | Scope | State |
|---|---|---|
| 38a | Driver skeleton + per-capability switch (defaults to `postiz`) + shared contract suite | ⬜ |
| 38b | **Token custody** — encrypted at rest on the tenant wall, refresh-ahead, revocation fails closed | ⬜ |
| 38c | **LinkedIn** — OAuth, org-page publish, media, `pullComments` (48h retention) | ⬜ depends on SMM-36 ✅ |
| 38d | **YouTube** — OAuth, resumable upload, 3-bucket quota, `pullComments` | ⬜ |
| 38e | Flip LinkedIn + YouTube to `direct`; Postiz retained for IG/FB/TikTok | ⬜ |

⚠ 38b reverses D-5 (client tokens deliberately live *inside* Postiz so we never hold them). That is a
security decision the owner accepted with D-20, not a convenience.

## P3 — content ops ⬜

| # | Ticket | State | Note |
|---|---|---|---|
| SMM-19 | Brand-voice RAG + AI drafting, cross-client leak test | ✅ | |
| SMM-20 | Asset attach only; `ai.imageGen` ships inert and names why | ⬜ | |
| SMM-21 | Metrics → `social_metrics_daily`, nightly flow, Analytics tab | ⬜ | |
| SMM-22 | X metering live: stop-loss in dispatch **and** precondition, usage panel | ⬜ | widens SMM-09's budget stage |
| SMM-23 | Reports: snapshot + AI narrative → approve → render → Drive | ⬜ | |
| SMM-24 | Docs/registration, BFF rows, toolkit entry, MAP regen, AGPL source-offer footer | 🟡 partial | runbook + MODULES/CHANGELOG done; **AGPL footer + toolkit entry outstanding** |
| SMM-25 | Full-stack e2e + Playwright suite + DEMO_MODE fixtures | 🟡 partial | DEMO_MODE social fixture landed in SMM-14 |
| SMM-33 | Capability inventory + eval register | 🟡 partial | golden-case table landed in SMM-14 |

## P4 — agents + assistant ⬜

| # | Ticket | State |
|---|---|---|
| SMM-26 | MCP agent surface for automation principals (OBO, D14); agents draft, never publish | ⬜ |
| SMM-27 | Best-time-to-post: classical stats + suggestion chip | ⬜ |
| SMM-35 | Assistant integration via ASST-23 propose → confirm → approve | ⬜ |

## Decision-gated — do not mobilise

| # | Ticket | State |
|---|---|---|
| SMM-28 | Mixpost Pro swap | ☠ **DEAD** — free-only constraint + D-20 |
| SMM-29 | ClipsAI video repurposing (OQ-6) | ⬜ gated |
| SMM-34 | Generative images | ⬜ gated on `render-gateway-go` leaving `0.0.0` |

---

## Open items not owned by any ticket

| Item | Owner / when |
|---|---|
| Platform-app reviews — **Meta first**, its Business Verification is the only serial prerequisite | **staging** (D-23) |
| Google SSO on Postiz login: does `DISABLE_REGISTRATION` block a *first-time* sign-in? | staging checklist — **do not test on the live instance** |
| Postiz OAuth finalization route — "reasoned from source, not yet driven" | whoever first holds a live app credential |
| AGPL counsel sign-off before any client account connects (OQ-3) | owner |
| Fork exception **D-21 granted but not applied** — TikTok `creator_info` + IG quota probe (~15 lines) | unscheduled |
| rbac artifact CRLF: 4 files carry CRLF in the index, REGEN guards fail locally | own small ticket, when no IAM session is live |

## Owner decisions — do not relitigate

| # | Decision |
|---|---|
| OQ-2 | X ships **disabled** — keeps the publish path $0 and D14-registry-eligible |
| OQ-5 | Media rides `files` + Drive mirror |
| OQ-7 | Postiz runs on the SumoPod VPS, not `gda-aicenter` |
| D-16 | Client post-approval builds in P2, on a plain-tenant-wall table |
| D-17 | Image generation deferred — no generative backend exists |
| **D-20** | Build the `direct` driver now; Postiz is the incumbent, not the destination |
| **D-21** | Fork exception granted **once**, both items in scope |
| **D-22** | Composer selections ARE TikTok consent; `creator_info` re-verified at dispatch |
| **D-23** | Platform-app reviews **deferred to staging** — a phase boundary, not a blocker |

---

## Recurring defect classes — check every ticket against these

**1. The module GUC (four occurrences).** Every `social_*` table carries `0105`'s third wall
`app_module_allowed('social')`, which `withTenants([tenantId])` does **not** satisfy. Without
`declareSocialModuleScope`, queries read **zero rows and raise nothing**. It produced: a gate that
would refuse every healthy publish · a purge job reporting "0 purged, all clean" forever · a status
sync applying nothing · event handlers routing nothing. **Every new `social_*` query path needs a
regression test that fails if the declaration is removed.**

**2. Registered but never invoked (one occurrence).** `main.ts`'s `startConsumerLoop([...])` omitted
`"social_post_variant"`, so SMM-13's handlers existed, were registered, and were never reached. Its
own suite was green because it called them directly. **Verify the caller, not just the callee.**

**3. Tests that pass while the feature is dead.** Two shipped this week: `.resolves.not.toThrow()`
assertions that survive deleting the function body, and reads through `withTenants([])` — an empty
tenant scope reads zero rows under RLS, making "nothing was sent" assertions vacuous. `mail_log` must
be read via `adminPool()` and `config.mail.enabled` flipped in-test.

**4. A skipped suite reporting green.** SMM-36 passed typecheck, lint and 1810 repo tests while all
nine of its DB tests silently skipped for want of `DATABASE_URL_TEST` — and shipped a purge job that
was dead on a type-inference bug. **Any seat touching migrations or DB-backed jobs gets the test-DB
URL, and the acceptance-critical suites get re-run at merge.**

**5. In-process tests are silent about bundling.** `demoSocial.ts` mutated a plain module array; Next
bundles the `"use server"` action graph and the RSC read graph separately, so the write and the read
saw different copies. A vitest passed by construction — one module instance. **Only a real browser
against a real server can see this class.** Mutable DEMO_MODE stores pin to `globalThis`.

**6. `healthy` is not `working`.** Postiz's healthcheck probes only its frontend; with the backend
dead every call 502s while the container reports healthy. And the ERP's own publisher treats a missing
base URL as a *supported* mode — 200s everywhere, publish refusing 503. **Prove with a call that
expects a specific status.**

## Cross-session hazards

- **Migration numbering is CLOSED at `0118`.** New migrations are `YYYYMMDDHHMM_snake_case.sql` (UTC) —
  `platform-nest/scripts/lint-migration-names.mjs` enforces it. Duplicate prefixes are *functionally*
  safe (the ledger keys on full filename); **never rename an applied migration.**
- **`GAIADA_TAG` moves under you.** A deploy landed mid-ceremony and moved the running tag; a stale
  `.env` would have rolled the API back as a side effect of a config change. Re-check immediately
  before any `up -d`.
- **The compose set on `gda-aicenter` is three files** (`vps` + `hostdata` + `observability`). Read it
  off the running container's own labels rather than guessing.
- **Worktrees can be cut before a commit made in the same turn.** Commit design docs a turn earlier,
  and restate binding constraints in the ticket body.
- **`docs/MAP.md` conflicts on almost every parallel merge** — regenerate, never hand-merge.
