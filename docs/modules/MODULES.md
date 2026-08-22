# Gaiada â€” Module Registry

Single source of truth for **module status, versions, and future plans**. Each module has a
specialized section below. Change history lives in [`CHANGELOG.md`](./CHANGELOG.md).

> **Read the status honestly.** Nothing here is production-finished. See the vocabulary below â€”
> "prototyped" means *works in the dev stack*, not *done*.

## Status vocabulary

| Status | Meaning |
|---|---|
| `PLANNED` | Design/blueprint only â€” no code yet. |
| `IN PROGRESS` | Actively being built; partial. |
| `PROTOTYPED` | Code exists and runs in the **dev** stack; **NOT** production-verified or feature-complete. |
| `DEV-VERIFIED` | Prototyped **and** exercised end-to-end on the local stack (still not production). |

**Versioning:** semver-style, all `0.x` because nothing is in production. Baseline versions were
assigned **2026-07-23** for tracking-forward â€” they are not pre-existing release tags. Bump the
version and add a `CHANGELOG.md` entry on every notable module change.

---

## App version

**`Alpha 01.062.0126a`** â€” see [`VERSIONING.md`](./VERSIONING.md) for the format, and

[`/VERSION`](../../VERSION) for the machine-readable source. The app version composes the module
versions below; the running build reports it at `GET /health`.

---

## Registry (at a glance)

| Module | Ver | Status | Workstream | Since |
|---|---|---|---|---|
| platform-nest | `0.34.0` | IN PROGRESS | WS1 | 2026-08-21 |
| platform-ui | `0.29.1` | IN PROGRESS | WS5 | 2026-08-21 |
| ai-gateway-go | `0.13.2` | PROTOTYPED | WS3 | 2026-08-07 |
| mcp-hub | `0.11.0` | PROTOTYPED | WS2 | 2026-08-20 |
| sync-engine-go | `0.7.0` | PROTOTYPED | WS1 | 2026-07 |
| automation (n8n) | `0.4.1` | DEV-VERIFIED | WS4 | 2026-07 |
| observability | `0.6.1` | DEV-VERIFIED | WS9 | 2026-08-06 |
| infra | `0.8.6` | PROTOTYPED | WS10 | 2026-08-06 |
| wa-chat-bot | `0.9.2` | PROTOTYPED | WS5 | 2026-08-03 |
| ai-agents | `0.7.2` | PROTOTYPED | WS8 | 2026-08-20 |
| hermes-gateway | `0.2.0` | PROTOTYPED | WS3 | 2026-07 |
| capture-helper | `0.2.0` | IN PROGRESS | WS11 | 2026-07 |
| webdev | `0.13.0` | IN PROGRESS | Web Dev | 2026-08-09 |
| webdesk | `0.0.0` | PLANNED | Web Dev | 2026-07-23 |
| search-marketing | `0.5.1` | DEV-VERIFIED | SEO | 2026-08-04 |
| social-media | `0.5.18` | IN PROGRESS | Social Media | 2026-08-23 |
| monitoring | `0.2.0` | IN PROGRESS | Monitoring | 2026-08-19 |
| creative | `0.1.0` | PROTOTYPED | Creative | 2026-07 |
| render-gateway-go | `0.0.0` | PLANNED | Creative | 2026-07-23 |
| reports | `0.3.1` | PROTOTYPED | Cross-cutting | 2026-08-03 |
| report-renderer | `0.1.0` | DEV-VERIFIED | Cross-cutting | 2026-07-31 |
| mail | `0.0.19` | IN PROGRESS | Cross-cutting | 2026-08-06 |

---

## platform-nest â€” Platform Core Â· `0.33.0` Â· IN PROGRESS
**0.22.0 (2026-08-13, IAM authorization hardening — permission arm, scope filter, invoice
maker/checker):** Closed the mis-scoped-grant class at the resolution source — `assemblePrincipal()`
now drops permissions from any grant at a scope the role's own Cerbos condition can never satisfy,
with the role→scope map generated from `derived_roles.yaml` and byte-identity-guarded against drift
(IAM-SEC-06). Closed a privilege escalation where `inviteUser` minted any role at company scope with
no guard, via one shared check both writers call plus a static sweep that fails on any new unguarded
writer (IAM-SEC-05). Removed three deployed permission mirrors that over-granted — including
`hr_record.export`, whose mirror sat one assurance tier below its role arm and let a no-MFA session
export raw employee records — and restored it at the correct tier (IAM-04-REG1/REG2/REG3). Wired the
permission arm onto 11 social actions; `portal` stays blocked on a structural gate. Gave invoices a
maker/checker seam: an `approve` action, creator/approver attribution, an `invoice_revisions` history
covering all four write paths, and the repository's first `EFFECT_DENY` rule so nobody — superadmin
included — approves their own invoice (IAM-GAP-01/02). Gave HR leave decisions their own
`hr.leave.decide` right. A missing `amr` claim now surfaces instead of silently capping every session
below the high-assurance tier (IAM-MFA-01).


**0.21.3 (2026-08-12, HIER-5/TRAP-4 - `group_executive` was denied everywhere it was folded into
an `inTenant` gate):** `group_executive` is a GLOBAL-scope-only role, so a holder has no
`company_memberships` row and `variables.inTenant` is FALSE for them against every resource. Five
policies (`automation_approval`, `pipeline_run`, `pipeline_gate`, `pipeline_stage`,
`scope_signoff`) granted it inside the SAME rule as company_admin/manager, gated on
`inTenant && notLow` - so the grant could never fire, and the cross-company oversight tier was
denied on exactly the kinds it exists to oversee. Confirmed by live probe, not inferred. Split
into its own `notLow`-only rule, matching `resource_appraisal.yaml`, which already had the right
shape. This repairs the fold-in; it does not widen the role (D-7 will delete it). **Role bundles
are unchanged and no migration is needed** - the bundle generator treats resource-instance
conditions as satisfied when computing reach, so the split moves live Cerbos behaviour without
moving computed coverage (`--check` byte-identical, re-verified). Landed by a concurrent session;
recorded here by the `01.039.0091a` release cut, which needs an accurate manifest. The `social`
module's own eight policies were written with this shape from the start and were never affected.

**0.21.2 (2026-08-12, IAM scope guard + hazard detector):** shipped inside `Alpha 01.038.0089a`
alongside the social module's IAM registration - see that release's entry and
`docs/superpowers/plans/2026-08-11-iam-sec-03-report.md`.

**0.21.1 (2026-08-11, HIER-3 — the `team`/`team_lead` retirement, contract half):** migration
`0103` closes the expand/contract pair `0100` opened. `user_roles.scope_type` is now hard-narrowed
to `global | company | org_unit | project` (`team`/`record` DELETED, not just unwritten — 0103
hard-aborts if a leftover row of either exists, then drops the values for real); `teams`/
`team_memberships` are DROPPED (0 rows, count-asserted); the global `team_lead` role and its
`role_permissions` bundle are deleted (cascade); the 4 `core.team.*` catalog permissions are
deleted (catalog 230→226, grantable 215→211, kinds 61→60). Every writer that could mint a
`team`-scoped grant is removed in the SAME change: `core/teams.controller.ts` (and its module
wiring + test file) is deleted outright; `testing/personas.ts`/`seed/personas.ts`'s `team_lead`
persona is reworked to `org_unit_lead` (an org-unit placement + grant, so person-scope narrowing
is actually exercised). 23 Cerbos policy files + `derived_roles.yaml` swept (`team_lead`
derivedRoles entries removed, the `team` kind's `resource_team.yaml` deleted, the 5
`perm_pm_task_*` team_lead-exclusion clauses simplified back to plain global-or-company mirrors).
`permission-arm-hazard-scan.test.ts`'s control kinds swapped (`pm_task`→`time_entry` alongside
`hr_case`, since `pm_task` measurably moved HAZARDOUS→SAFE) and its synthetic teeth-proof rebased
onto `client`. Full detail: `docs/superpowers/plans/2026-08-11-hier-3-report.md`.

**0.21.0 (2026-08-10/11, IAM Phase 1 catch-up — many concurrent tickets, this entry consolidates):**
the permission catalog is now DB-persisted and module-boot-validated (migrations `0091`-`0101`):
215 grantable + 15 relationship permissions seeded (`0093`), 936 role→permission bundle pairs
across 20 roles (`0094`/`0097`/`0098`, `company_admin` widened 199→200 by DR-5's deliberate
`reports.appraisal.read` grant, `0099`), six previously-ungrantable roles seeded (`0091`), the
global-scope-uniqueness dedupe fix (`0092`), and the `org_unit` scope substrate (`0100`,
expand-only — drops `team`/`record` from the CHECK, widens `scope_id` to text) plus its closure
table (`0101`, IAM-09) and the `org_unit_lead` role (`0102`, HIER-2 — landed after this entry was
first written; see 0.21.1 above for its own follow-on retirement of `team_lead`). The
permission-arm rewrite (IAM-04) now covers 28 of 61 Cerbos kinds as an additive, proven-identical
mirror beside the existing role-name matching, which is still what decides every live
authorization. New BFF surface: `GET /api/:t/authz/permissions` + `GET /api/authz/permissions`
(IAM-05c, scope-level effective permissions, ETag-cached on `session_version`). A live defect
(IAM-SEC-02 — elevated roles grantable at non-global scope) was found and fixed at the source
during the rollout. Full detail: `docs/PERMISSION-CONTRACT.md` (updated in the same pass) and
`docs/superpowers/plans/2026-08-10-iam-*` (25+ per-ticket reports). **Nothing here changes an
existing user's access** — every ticket in this wave carried a parity assertion; the one
deliberate widening (DR-5) was an explicit owner decision, not a side effect.

**What exists (dev):** modular multi-tenant NestJS core with FORCE-RLS schema, `ModuleContract`
framework + custom fields, Cerbos RBAC (scope cascade, decision audit, revocation, PlanResources),
OBO + dual-proof identity links, cross-company rollups, the agency vertical (clients/deliverables/
time, campaigns/briefs/creative review, comments, notifications, files), and the transactional-outbox
event backbone. ~92 dev tests pass against live PG + Cerbos.
**0.6.0 (Workstream A+B admin proxies):** `@Controller("api/admin/bot")` (isElevated-gated) proxies wa-chat-bot's
session lifecycle, writable group registry, and safe config write (fail-soft: bot unreachable â†’ 502, not configured â†’ 404);
`admin/intelligence.controller.ts` now makes real HTTP calls to the agent-runner service (`GET /health` for status,
`GET/POST /goals`, `GET /runs` tenant-pinned and elevated-only); platform self-link idempotent upsert (`identity_links`
row on trigger); probeStatus/connectionConfig for both bot and agents now hit real services instead of stubs.
**0.6.2 (bot console proxies):** nine new elevated-gated proxies (kill switch, digest run + history, skills,
media status, ignore list, cross-chat search) with field-level 400s and a 60s budget for the digest run, plus
`optionItems` (value/label) carried through the ConfigField contract for the management-group dropdown.
**0.6.1 (bot-proxy honesty fixes):** `botCall` now surfaces the bot's **404** verbatim (was collapsing every
non-400 into `502 bot admin unreachable`, so a chat with no stored transcript reported the bot as down);
the bot status probe treats a `session: "unknown"` health field as MISSING and falls back to the
authoritative `/admin/session/status`, instead of showing "unknown" as if it were a real session state.
**Known gaps:** not deployed to production.
**Future plans:** additional verticals (resort/marine/print) â†’ hardening to production.

## platform-ui â€” ERP Suite Â· `0.28.5` Â· IN PROGRESS

**0.25.1 (2026-08-10, IAM Phase 1 mirror corrections):** `lib/rbac.ts` and the new
`lib/rbac-capability-map.ts` corrected against re-derived Cerbos ground truth rather than the
hand-written list: `it_admin` loses `company.manage` (DR-6, zero Cerbos overlap), `hr_staff`/
`search_staff`/`reports_staff` gain `people.directory` (DR-7, `resource_member.yaml`'s
`module_staff` rule grants it unconditionally), and `hr.manage` drops `hr.case.cancel` (a map
defect, not an owner decision — no Cerbos rule ever granted `cancel` to `module_manager`/
`company_admin`). Zero Cerbos changes; mirror-only, pinned by 6 new tests plus the pre-existing
547-pair `rbac-capability-parity.test.ts`. See `docs/PERMISSION-CONTRACT.md` for the full IAM
Phase 1 picture this UI correction is one piece of.

**What exists (dev):** Next.js ERP UI, BFF to platform-nest, RBAC-gated nav + company switcher; My Work,
Approvals inbox, Companies/Projects/Tasks, Agency, Rollups, Systems/Intelligence/Admin consoles, People
360, org-structure builder, Repsona-style PM + AI tracker, IT device console, per-department consoles
(Web Dev reference), OIDC PKCE login. Runs backend-free in `DEMO_MODE`; Playwright e2e in dev.
**0.19.1 (A11Y-AUTO-01, automated axe-core auditing):** `@axe-core/playwright` added as a
devDependency ONLY (runtime deps stay at `next`/`react`/`react-dom`/`server-only`) and wired into a
new `e2e/a11y-axe.spec.ts`, covering `/assistant` (empty/active/streaming/proposal-card states),
both drawers, and one dense baseline page, in both light and dark theme, 15 checks total, all
green. Fixed 3 classes of real defects it found (a progressbar + two selects with no accessible
name; six assistant-surface elements using the "decorative only" `--ink-faint` token on real
informational text, now `--ink-subtle`). Deferred (recorded, not silently suppressed) app-wide
sidebar/tag-chip contrast debt this program didn't introduce. Not wired into the CI merge gate
(stays `chromium`-project, on-demand) — see the report for why. New
`docs/a11y-manual-checklist.md` is the ~15-minute human NVDA/VoiceOver script for what axe cannot
check; **no real screen reader has been run yet.** Report:
`docs/superpowers/plans/2026-08-07-a11y-automation-report.md`.
**0.15.3 (UI-01, reauth return-target preservation):** a shared, hardened same-origin-path-only
`?return=` validator (`lib/returnTo.ts`) now guards every login-adjacent redirect — `middleware.ts`'s
redirect-to-login, `/login`, `/step-up`, and (new) the OIDC `/auth/login` → `/auth/callback` round
trip, which previously had no return-path concept at all. Closes the gap MAIL-09 found live: an
emailed approval/pipeline deep link clicked with no session used to land back on `/` after reauth
instead of the entity. See `docs/modules/CHANGELOG.md`'s platform-ui section for the full writeup;
caps at IN PROGRESS pending a deploy to re-walk MAIL-09's ex-Q-V7 leg.
**0.7.1 (digest controls):** "Run now" reports STARTED then polls the history to completion (no more false
"unreachable" on a ~90s run), plus a group picker + "Preview (sends nothing)" rendering the digest text inert.
**0.7.0 (console depth + pagination):** new Controls tab (actions kill switch with off-immediate/on-confirm,
digest run + history, media queue, capabilities); Groups tab ignore/un-ignore; Chats search, cross-chat message
search and load-older paging; shared `Paginator`/`usePagination` + 300ms debounce applied at 30 rows/page across
the Bot, Automation, MCP Hub and AI Gateway consoles (client-side only â€” no new endpoints). Page resets to 1 on a
filter change but NOT on a poll tick, so a refresh can't yank an operator off their page.
**0.6.3 (bot page correctness):** registry rows regained the **optIn** (digest-back) column â€” the bot's PUT
is a full replace, so saving from the ERP silently turned per-group digest post-back OFF for every group;
Groups tab now warns before the FIRST save that it switches the bot out of trial mode (unlisted groups stop
being ingested); Chats/Logs panels no longer sit on "Loadingâ€¦" forever when a fetch fails.
**0.6.2 (bot Logs/Groups panels):** discovered-group rows fall back to the JID when the subject is still
unresolved (blank rows before); the empty action-audit note now explains what populates it instead of
reading as a broken panel.
**0.6.0 (Workstream A+B admin surfaces):** Connect-WhatsApp UI (status pill + QR scanner, Connect/Show-QR/Restart/Stop/Logout buttons,
session event trail); Group Registry UI (monitored-groups table with category/optIn, discovered-list one-click-add, management-group radio);
agents UI extended with trigger card (goal text + agent select, elevated-only), goals list/detail pages with blackboard + run transcripts,
run detail page showing step-chip transcript (text-only, never HTML or raw JSON).
**Known gaps:** not deployed to production.
**Future plans:** dept-console integrations program â†’ prod hardening.

## ai-gateway-go â€” AI Gateway Â· `0.13.0` Â· PROTOTYPED

**What exists (dev):** Go gateway (the `ai-gateway` service on `:3002`), HTTP-parity with the retired Node
gateway; provider chain + failover + circuit breaker, DLP, daily cost cap, egress audit + allowlist,
internal CA + mTLS, site/central topology, DR-burst budget. go build/vet/test green.
**0.11.0 (Workstream B gateway reliability):** NEW `PROVIDER_TIMEOUT_MS` (default 60000) with context timeout
enforcement in every capability handler (Complete/Media/Embed) â€” hung provider becomes clean failover, client disconnect
cancels upstream; **429 taxonomy** â€” providers return typed `RateLimitError{RetryAfter}` (parse Retry-After, cap at 5m),
breaker opens immediately for min(RetryAfter, cap) instead of counting toward consecutiveFails â€” one 429 stops hammering
exactly as advertised, doesn't poison "dying" signal; **error taxonomy in audit + 502 body** â€” attempted-provider errors
tagged `timeout|rate_limit|provider_error` (egress audit + ERP console can distinguish, `Blocked: "rate_limit"` when all
providers rate-limited); per-tenant call cap already EXISTS (x-tenant-id header propagated from runner on `/complete` calls
for tenant-attributed load).
**Known gaps:** **docker build not verified** (no Docker in the dev env) â€” validate on a Docker host before
deploy. Deferred: OpenBao-issued creds, media DLP classification, native per-provider streaming, cert rotation.
**Future plans:** verify container build â†’ OpenBao creds â†’ media DLP â†’ prod.

## mcp-hub â€” Access Layer Â· `0.10.1` Â· PROTOTYPED

**What exists (dev):** MCP server (official SDK, Streamable HTTP, stateless) fronting platform-nest; OBO
principal minting, Cerbos-authoritative policy, full Tools/Resources/Prompts surface, module-aggregated
tool defs, rate limiting, revocation, mTLS floor, site/central topology, JSONL audit. 59 dev tests.
**Known gaps:** OpenBao-minted short-lived creds and Redis-backed multi-instance rate limiting deferred.
**Future plans:** OpenBao creds â†’ multi-instance rate limiting â†’ prod.

## sync-engine-go â€” Cross-Site Sync Â· `0.7.0` Â· PROTOTYPED

**What exists (dev):** one Go binary (central/site modes) reconciling the shared outbox with HLC ordering,
per-field conflict resolution, per-tenant RLS, subscription ACL, new-node bootstrap, watermark-gated GC.
Property-based convergence + partition/chaos passing on a local 2-Postgres harness.
**Known gaps:** runs **idle** (`sync-central`) â€” never exercised against a real second site; not in production.
**Future plans:** activate when a second site exists â†’ prod hardening.

## automation (n8n) â€” Orchestration Â· `0.4.0` Â· DEV-VERIFIED

**What exists (dev):** n8n + MCP-calling templates, scoped n8n accounts, impact gate, platformâ†’n8n event
bridge, approvals-suspension surface. **3 flows verified end-to-end** on the live dev stack (2026-07-15).
**Known gaps:** Temporal (durable workflows) deferred until a durable flow exists; not in production.
**Future plans:** more flows â†’ Temporal for durable orchestration â†’ prod.

## observability â€” Telemetry Â· `0.6.0` Â· DEV-VERIFIED

**What exists (dev):** OTel across all services (fail-soft), opt-in Grafana/Prometheus/Tempo/Loki stack,
multi-burn-rate SLOs, alerting (â‰¥2 transports + dead-man's-switch), synthetics, restore drill. **Verified
end-to-end on a live Docker stack** (2026-07-15).
**Known gaps:** filelogâ†’Loki env-limited on Docker Desktop (works on Linux VPS); not deployed to prod.
**Future plans:** deploy the stack to a real host â†’ tune SLOs against prod traffic.

## infra â€” Platform Engineering & Delivery Â· `0.7.1` Â· PROTOTYPED

**What exists (dev):** full VPS Docker Compose stack, per-component Dockerfiles, local CI (`test-all.sh`),
GH Actions (inert until the repo is standalone), crypto-shred-safe backups, supply-chain pipeline
(SBOM + cosign + SLSA).
**0.5.3 (WAHA pin 2026.6.2 â†’ 2026.7.2):** deliberate, still-pinned bump to pick up the NOWEB
"WhatsApp Web version compatibility" fix in 2026.7.2 and stay current with WA protocol drift.
Explicitly **not** a retry of the ruled-out 2026.7.1 (see `docs/runbooks/wa-ban-recovery.md`).
Validated by `docker compose config` only â€” **re-pair is UNPROVEN**; no live QR scan was possible.
**0.5.0 (Workstream A+B compose):** agent-runner service added to compose stack (`build: ../../ai-agents`, Fastify :3006,
AGENT_RUNNER_TOKEN auth, gaiada_knowledge owner/app roles); wa-chat-bot environment wired for writable group registry
(GROUPS_FILE: /app/data/groups.yaml, GROUPS_SEED_FILE: /app/config/groups.seed.yaml); bot-data volume added for registry + session state;
old groups.yaml bind mount moved to seed path (read-only); .env.example updated with AGENT_RUNNER_TOKEN secret.
**0.5.2 (platform-nest test harness made deterministic):** every test FILE now gets its own physical Postgres
database (`pgtest_f_<sha1(testPath)>`), created and migrated in its own `beforeAll`. Replaces a shared-schema
harness whose `DROP SCHEMA` raced across workers and whose advisory lock, released only in teardown, let one
failed `beforeAll` block every later file (observed: 19 then 57 files failing, from zero real defects).
**Verified green on 4 consecutive full runs** (74 files / 734 tests / 0 skipped). Costs ~7min and ~730MB of
throwaway databases per run â€” correctness over speed; schema-per-file is the lighter follow-up if that bites.
**0.5.1 (local test-infra in the dev override):** `docker-compose.local.yml` now also publishes
**cerbos** (3592/3593 â€” a portless Cerbos fails every authz check, so the platform suites could not
run), **pg-bot** (55434, for wa-chat-bot's DB-backed suites against a dedicated `gaiada_bot_test`
database) and a **disposable `redis-test`** (56380) that MUST stay separate from the live event-backbone
Redis because `n8n-bridge.integration.test.ts` calls `FLUSHALL`. Nothing was added to the VPS compose â€”
it stays internal-only by design. **Bring the stack up with BOTH files**: recreating a container with
the VPS file alone strips the override's published ports (it silently unpublished `platform:3004`, which
the host-run UI depends on).
**Known gaps:** not deployed; K8s/GitOps + SPIFFE/SPIRE are target-state (hiring-gated).
**Future plans:** first production deploy â†’ GitOps â†’ K8s/SPIFFE at target-state.

## wa-chat-bot â€” Messaging Surface Â· `0.9.1` Â· PROTOTYPED

**What exists (dev):** WA (WAHA) + Telegram work-summary/assistant bot; scrub â†’ crypto-shred store â†’
skills/Q&A, digests, media enrichment via gateway. Telegram live in dev; P5a production-grade features.
**0.8.0 (Workstream A WhatsApp admin plane):** session lifecycle admin routes (`POST /admin/session/start|status|qr|stop|logout|restart`),
writable group registry (moved to bot-data volume, YAML + hot-reload + discovered-groups tracking),
safe config write (`PUT /admin/config {postToGroups,managementGroupId}`); session-state tracker records webhook
events into a ring buffer + `/health` session field; webhook already ACKs 200 then processes detached (aire lesson).
Gated by Bearer ADMIN_TOKEN; all engine-tolerant (NOWEB status strings pass verbatim, never enumerated-rejected).
**0.9.1 (digest delivery + async run) â€” DEV-VERIFIED:** the digest DELIVERY TARGET may now be a direct chat
(e.g. the operator's own number via WhatsApp "message yourself"), not just a group, and it is persisted in its
OWN file â€” writing it into the group registry used to activate registry mode with zero monitored groups and
silently stop ALL ingestion. Manual runs are async (202 + poll) and there is a send-nothing digest PREVIEW.
Also fixed: scheduled digests had been failing since the DB role split (`schedule-state` ran DDL as the
restricted runtime role â†’ `permission denied for schema public`), and legacy hyphenated group ids were
rejected by the chat-id validator.
**0.9.0 (bot console depth â€” 4-agent build, DEV-VERIFIED):** ignore list (a group on it is dropped in BOTH
registry modes, so "monitor everything except these" is finally expressible), digest history + next-run times,
skills catalog, media-queue health, chat search + backwards paging (`searchMessages`/`getMessagesPage` on both
FileStore and PgStore), and `managementGroupId` served as a labelled dropdown (registry + discovered groups).
Integration caught three real defects: chat q/kind filters ran AFTER the store limit (a search could answer
"no results" while matches existed), `@lid` DM ids were rejected by a duplicated chat-id regex (every DM 400'd
on click), and an empty registry fell back to a JID text box.
**0.8.3 (group naming everywhere):** `groupName()` falls back to the auto-discovered subject before the
bare JID, so the ERP Chats tab and digest headers stop showing `1203â€¦@g.us` for groups the Groups tab
already names (the registry is empty in trial mode, and it was the only source consulted).
**0.8.2 (session timeline: seeded + durable) â€” DEV-VERIFIED on the live stack:** the status timeline is
persisted (`SESSION_EVENTS_FILE`, default `data/session-events.json`) and restored at boot, and the current
status is now SEEDED from WAHA (`observeStatus`, de-duplicated) on boot and on every `/admin/session/status`
read â€” WAHA only pushes `session.status` on a CHANGE, so a session already WORKING before the bot started
left the Logs tab blank and `/health` reporting "unknown" after every restart.
**0.8.1 (discovery: named + durable) â€” DEV-VERIFIED on the live stack:** discovered groups now persist to
`discovered-groups.json` beside the groups file (survives restart, atomic write, 500-entry cap) and carry a real
subject â€” resolved out-of-band from WAHA (`group-names.ts`, shape-tolerant across the JID-keyed `/groups` map,
array `/chats`, NOWEB `subject` and WEBJS `name`) on the next message and on every `GET /admin/groups` read.
**Known gaps:** trial-lite; blocked on infra (OpenBao VPS, Gemini key, WAHA number) and legal Gate 1
before real ingestion; not in production.
**Future plans:** WAHA primary once number scanned â†’ hardening backlog â†’ prod after gates.

## ai-agents â€” Agent Brigade Â· `0.4.0` Â· PROTOTYPED

**What exists (dev):** specialist framework (status-reporter, approvals-chaser) + supervisor orchestrator
(blackboard, cycle guard, per-goal budget, fan-out cap, approval suspension) + pgvector RAG; D14 safety in code.
**0.4.0 (Workstream B agent runtime e2e):** agent-runner Fastify service (`:3006`, AGENT_RUNNER_TOKEN auth);
goal queue + store (IN-PROCESS FIFO, max-concurrent/max-queue gates, boot-recovery sweep interrupting orphaned goals);
typed goal/run persistence (`gaiada_knowledge` DB, owner-DSN DDL auto-grants to runtime role, zero infra changes needed);
`agent_goals` table (queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled), `agent_runs` full-traced rows;
approval suspension surfaces `approval_id` for deep-link to WS4 inbox; D13 forced_read_only path surfaced honestly in status + UI;
`evaledProviders` enrollment gated by eval suite + tool-contract check (runbook: `docs/runbooks/agent-evaled-providers-enrollment.md`);
all existing gates preserved (D9 scope, D11 revocation, D13/D14 per-principal). **DEV-VERIFIED end-to-end (pipeline+gateway+D13):**
agent-runner service lives, goal/run store persists, goal execution follows approval suspension path, forced_read_only surfaces.
**Known gaps:** steps 4â€“6 (memory/RAG ownership, local-model registry, eval-gated trainer) not built; the
eval harness is the root gate for more autonomy.
**Future plans:** eval harness â†’ memory/RAG â†’ local-model registry â†’ trainer.

## hermes-gateway â€” Local-Model Shim Â· `0.2.0` Â· PROTOTYPED

**What exists (dev):** a shim making a local Hermes model the bot's brain via the Gateway contract; verified
headless. **Known gaps:** dev-only convenience; not in production.
**Future plans:** fold into the local-model registry (WS8) when it lands.

## capture-helper â€” Capture Edge Â· `0.2.0` Â· IN PROGRESS

**What exists (dev):** WS11 capture edge â€” in-ERP record â†’ local Whisper `.txt` â†’ ingest â†’ Shared Drive;
feeds the meetingâ†’MOMâ†’PRD delivery pipeline. **Known gaps:** pipeline tails in progress; not in production.
**Future plans:** complete the delivery pipeline (MOMâ†’PRD/report/scope) â†’ prod.

## webdev â€” Delivery Rail Â· Cockpit Â· `0.13.0` Â· IN PROGRESS

**Design:** [`../blueprints/webdev-design.md`](../blueprints/webdev-design.md) (Â§12 has the ticket
ledger); Phase-3 ticket plan:
[`../superpowers/plans/2026-07-30-webdev-phase3-tickets.md`](../superpowers/plans/2026-07-30-webdev-phase3-tickets.md).
Registered `0.0.0 PLANNED` on design approval (2026-07-24); flipped `IN PROGRESS` on WD-01 (first
merged ticket, 2026-07-29) per the status-language rule; bumped `0.8.0` on WD-28 (first Phase-3
ticket to land, 2026-07-30, per the Phase-3 plan's own instruction to bump the minor on first
merge); bumped `0.11.0` on WD-20 (Phase-1 and Phase-2 close-out, 2026-08-03); bumped `0.12.0` on
MI-06 (maintenance-intake docs truth, 2026-08-08, schema/migrations MI-01..05 DEV-VERIFIED).

**Provision seam (PRV program) — PROTOTYPED, no version bump claimed here.** Design:
[`../blueprints/provision-erp-seam-design.md`](../blueprints/provision-erp-seam-design.md).
Landed so far: PRV-00 (in-process `node:http` mock of the provision contract,
`platform-nest/src/testing/mock-provision/` — fixtures carry the `UNVERIFIED-VENDOR-FIXTURE`
marker until real envelopes are recorded), PRV-01 (`0090_webdev_provisioned_sites.sql` — the mirror
table, THIRD-WALL RLS, three partial uniques), and PRV-02 (the FIRST `src/modules/webdev/` shell:
`ProvisionProvider` driver interface + `provision-http` driver, the provisioning service with
lock → re-read → precondition re-check → egress in one transaction, the 409 adopt-only-if-ours rule,
poller + reconcile, `webdev.provisionSite` McpToolDef, and `POST/GET /api/:t/modules/webdev/*`).
**PROTOTYPED, not DEV-VERIFIED:** every claim rests on CI against the PRV-00 mock. The seam is a real
cross-host hop (gda-aicenter → gda-s01) and per the design's own verification doctrine the
DEV-VERIFIED claim belongs to PRV-07's live leg on the boxes. Still open before the capability is
reachable at all: PRV-03 (hub allowlist + `mcp_tool` policy + D14 registry entry + the Zone A Cerbos
`webdev_provisioned_site` policy — until that policy exists, an unlisted resource kind is a silent
DENY and the endpoints refuse every caller), PRV-04 (UI + BFF contract rows), PRV-05 (QA gate).

**Phase 3 (external wiring) â€” 1 of 10 tickets landed:** WD-28 (PM per-project short-codes, OQ-7
default) â€” **DEV-VERIFIED**: `projects.short_code` (unique per tenant) + `projects.task_seq`
(atomic per-project counter) + `pm_tasks.seq`; atomicity proven under 30 genuinely concurrent live
HTTP requests (zero duplicate/missing seq); backfill migration for pre-existing rows required a
same-day follow-up (`0051`) after live verification caught the first pass (`0050`) silently
backfilling zero rows â€” migrations run as `platform_owner` (no `BYPASSRLS` per the 2026-07-15
DB-topology split) against FORCE-RLS tables with no tenant GUC set, so the owner-run backfill saw
zero rows under RLS with no error; fixed by wrapping the same logic per-tenant. See
`FRONTEND-BFF-CONTRACT.md` Â§5 for the full shape + verification detail. WD-21 (GitHub App +
webhook receiver) is the next dependent ticket (short-code resolution for the commit/branch
linker), gated on OQ-2 (GitHub org + App registration).

**What exists (dev), Phase 1 â€” ENTRY (audioâ†’PRD, from the ERP), 7 of 8 tickets landed:**
WD-01 (live-stack refresh + Ollama Cloud brain + WS11 re-drive, **DEV-VERIFIED** â€” real PRD
extraction, `prdConfidence 0.9`, non-echo); WD-02 (`/pipeline/[runId]` run workspace â€” three
tracks, stage chips, gate history, artifact rendering via `ArtifactMarkdown`, deep links from
`/meetings` + PRD Studio); WD-03 (artifact signature lock â€” stage-artifact edits refused 409 once
the client sign gate decides, enforced in `pipeline.controller.ts`, not convention); WD-04
(in-ERP audio upload â†’ server-side whisper transcription, backend: `POST
/api/:t/meetings/recordings/:id/audio` + `/audio/retry`, `meeting_recordings.audio_ref` additive
column, migration `0049`); WD-05 (delivery-workflow tails â€” bounded revise loop + prod chain on
live n8n); WD-06 (report sink v1 â€” `pm.createDoc`/`pm.createTask` hub tools, `wf:report`-scoped,
fanout report branch). **WD-07 (this ticket, 2026-07-30)** closes two gaps WD-04 left open and
adds the Phase-1 UX/docs polish pass:
- **The WD-04 frontend** (its AC needed a browser upload, only ever curl-verified): an
  `AudioUploadForm` (poll-until-terminal, same pattern as `WhatsAppConnect.tsx`) on
  `/meetings/[id]`'s workbench + a combined register-and-upload path inside `RecordControls`
  (for the no-existing-recording case) â€” surfaces `transcribing` progress and a retry action on
  `failed`, with a DEMO_MODE-equivalent (`demoUploadAudio`/`demoRetryAudio` in `demoMeetings.ts`,
  filename-triggered failure simulation since there's no whisper container in demo mode).
- **Client/project context plumbing verified end-to-end from the UI:** `RecordControls` now takes
  optional `clientId`/`projectId` props (hidden fields into the existing `/start` contract); wired
  into the project workspace (`ProjectWorkspaceView.tsx`, new "Meetings" card) and the client
  detail page, each pre-filled and each showing its own scoped recordings list. The dispatcher's
  client-context drop (WD-01 finding F-1) was fixed by another agent before this ticket started â€”
  this ticket's job was to verify the full chain (UI â†’ `meeting_recordings.client_id`/`project_id`
  â†’ ingested `pipeline_runs.client_id`), not to re-fix it.
- Run-status chips on `/meetings` (a new "Run" column resolving the linked pipeline run's own
  status, not just the recording's) and PRD Studio (source-meeting now links back to
  `/meetings/[id]` when resolvable).
- Helper-offline teach state inside `RecordControls` ("No capture helper installed? Upload an
  audio file" â€” `dept-teach` styling, reused from `TeachState.tsx`'s convention).
- `FRONTEND-BFF-CONTRACT.md` Â§8 meetings/pipeline/portal rows de-staled (they had "no UI
  consumer yet" annotations that were wrong â€” `/meetings`, `/pipeline`, `/portal` all have real
  routes + `lib/*.ts` consumers today).

**Known-live defect, NOT this ticket's to fix (queued for WD-08):** the ingest proxy
(`POST .../ingest`) times out against real dispatcher latency â€” `N8N_BRIDGE_TIMEOUT_MS` defaults
5000ms in `platform-nest/src/config.ts`, dispatcher round-trips run 15â€“23s in practice, so
`{ok:false,reason:"dispatcher_unreachable"}` comes back and the recording never flips to
`ingested` even though the n8n run completes fine server-side. The UI's existing `ingestAction`
already surfaces `reason` verbatim rather than claiming false success â€” confirmed still honest
under this ticket's own live-stack pass.

**Not yet DEV-VERIFIED at the module level:** WD-08 (the Phase-1 QA gate: full live walk incl.
RLS/portal-isolation/artifact-lock probes) has not run â€” Phase 1 is feature-complete, not yet
gated. Phase 2 (WD-20, the webdev-*integrations*-console close-out â€” a sibling program riding the
same tenant, not this delivery-rail one) already ran its own QA gate separately; see its evidence
doc for that program's DEV-VERIFIED status, which does not carry over to this one.

**Maintenance Intake (MI-01 through MI-06) — SCHEMA/MIGRATIONS DEV-VERIFIED, DOCS RECONCILED:**
MI-01..05 shipped a complete maintenance change-request intake surface (portal client submission +
staff triage queue + conversion to pipeline runs or PM tasks). Schema: migration `0088_webdev_change_requests.sql`;
portal endpoints `GET/POST /api/:t/portal/change-requests[/:id]` (client surface) + staff endpoints
`GET/POST /api/:t/webdev/change-requests[/:id]` + `POST …/:id/triage` (triage queue); Cerbos resource
`resource_webdev_change_request.yaml` + `request_change` action on `resource_portal.yaml`; UI at
`(portal)/portal/requests` and `(app)/departments/[deptId]/requests`. Tested: portal list/detail/submit
11/11, unit suite 1535/1535, `tsc` clean, `DEMO_MODE=1 npm run build` green. Scheduled triage gate
(mini_run spawn or pm_task create) is idempotent under concurrent tries (advisory lock + re-check
`status='new'` in one BEGIN/COMMIT). D-2a: `webdev_change_requests` table takes CORE tenant wall,
deliberate (no `app_module_allowed()`). F1: disposition (decline/convert) audience follows authorship
(portal-source requests notify contacts; internal-source requests do not, even when converted to a
mini_run that opens a real `prd_sign` gate the client must sign). F2: D17 custom fields on change
requests DEFERRED. MI-06 documented the five endpoints in `FRONTEND-BFF-CONTRACT.md` (§16f) and
bumped the module version.

**MI-07 (the QA gate) RAN 2026-08-08 — evidence
[`2026-08-08-mi07-evidence.md`](../superpowers/plans/2026-08-08-mi07-evidence.md). It passes on every
check it could execute, with ZERO critical findings, and the feature stays `IN PROGRESS` rather than
DEV-VERIFIED because two checklist items are honestly UNVERIFIED — not reasoned around:**
1. 🔴 **The live n8n fanout leg was never exercised** (MI-07-R2 — `automation/.env` and
   `infra/compose/.env` disagree on `N8N_DB_PASSWORD` and neither matches the live role, so n8n will
   not boot locally; the gate declined to alter a live credential without authorization). This is the
   one leg that would confirm the design's load-bearing **"a mini-run needs zero special-casing"**
   claim end to end — that the spawner's `pipeline.run.created` really is picked up by the shipped
   fanout, which opens `scope_signoff` itself. **Payload-shape parity with `createRun` IS test-pinned,
   so the claim is well-evidenced but not observed.** Close this before the phase is called done.
2. A literal browser-driven Playwright walk of the new pages (MI-07-R3, informational — the e2e
   harness's own `auth.setup.ts` login did not complete; the surfaces were driven over real HTTP
   instead, and the portal/staff e2e specs pass under `DEMO_MODE`).

Proven LIVE with positive controls and notification rows cited by id: the full submit → decline →
convert(`pm_task`) → convert(`mini_run`) → PRD-sign chain; `prd_sign` notifications signers-ONLY
(absence proven beside a presence control); the double-convert race **both** ways — the deterministic
repo test AND a real concurrent HTTP double-fire against the live backend, exactly one run each time;
the whole Cerbos matrix incl. the client-only invariant and the `group_executive`-without-membership
case; RLS incl. an unset-GUC read; and the trap-#2 guard made non-vacuous on a tenant with
`enabled_modules = {}`. Third finding: MI-07-R1 (low) — the local compose files disagree on
postgres/cerbos host ports, so a routine recreate can silently break the dev stack. All three findings
are **infra**, none is webdev code.

**Future plans:** MI-07 (maintenance-intake QA gate) closes the feature; WD-08 (Phase-1 QA gate) closes
Phase 1; Phase 3 (external wiring â€” GitHub App, Drive OAuth, Claude Admin usage) is gated on owner
decisions OQ-2/OQ-3; Phase 4 (webdesk + the one-rail contract-snapshot scaffolder) activates once
webdesk's own P3 codegen lands.

## webdesk â€” Website Platform Â· `0.0.0` Â· PLANNED

**What exists:** blueprint only (approved 2026-07-23) â€” see [`../BLUEPRINTS.md`](../BLUEPRINTS.md). No code.
**Future plans:** phased build P1 Foundation â†’ P2 Forms+Mail â†’ P3 Contract/codegen â†’ P4 ERP control+envs â†’
P5 AI+approvals â†’ P6 WordPress headless.
**2026-08-04 blueprint amendment (still no code):** C-03 unpinned from Hostinger SMTP → rented relay,
three sending identities + separate per-stream provider keys (D14), `From:` our domain +
`Reply-To:` human default with per-tenant custom-domain upgrade, explicit "Zone A mail never routes
through C-03". **v1.2 (same day, Zone A mail v2):** domains locked — C-03's forms stream pinned to
`forms.gaiada.online` on Brevo (deliberately off gaiada.com); Zone A (`notify.`/`auth.gaiada.com`)
moved to the Google Workspace SMTP relay with Brevo failover. Blueprint HTML is v1.2; PDF + hosted
artifact NOT re-rendered yet.

## mail — Zone A Email (platform-nest) · `0.0.19` · IN PROGRESS

**0.0.19 (2026-08-06, devops, MAIL-30) — inbound threading verified live; MAIL-13 and MAIL-29 promoted
to DEV-VERIFIED.** Ran the strengthened replay against deployed `alpha-01.022.0056a` using a real
**mixed-case** token from `mail_log` (`WxgfNc9SNTtwaKif2TnfBA`) — the exact input class MAIL-29 fixed.
16 `mail_messages` rows landed on the correct `pipeline_gate` entity (the NDR fixture correctly
attaching to none); unmatched ⇒ `204` and bad-token ⇒ `401` both byte-identical; hostile HTML inert as
*stored* content; EICAR `scanStatus:"infected"` with `fileRef:null`, never on disk; provider-id
idempotency held. Reaching the rows required `?options=-c app.mail_context=on` on the connection —
MAIL-22's FORCE-RLS GUC gate working exactly as designed.
Module stays **IN PROGRESS**: MAIL-15's live leg is still outstanding.
**Two named gaps, neither a production defect.** (1) `replay-inbound.mjs`'s verifier reports
`THREADING BROKEN` for an intentionally-deduped repost, because it cannot distinguish "nothing landed
because broken" from "nothing landed because correctly deduped" — the mirror image of the original
defect, where the same script reported PASS over a dead path. Both are checks that do not measure what
they claim. (2) The per-attachment **byte** cap is unexercisable at production defaults
(`MAIL_INBOUND_MAX_ATTACHMENT_BYTES=10MB` vs a 48KB fixture); the rejection *mechanism* is proven via
the count cap instead.
**Honest limit:** EICAR's download-refusal-at-every-privilege is code+data proof, not a live 403 with
an admin token — that session was out of scope and was not faked.

**0.0.18 (2026-08-06, senior-be, MAIL-29) — inbound threading had never worked outside tests; fixed,
and the test gap that hid it closed.** `extractAngleAddress()` blanket-lowercased the recipient
address including the VERP token's local part, while tokens are minted mixed-case base64url and
matched exact-case — so any token containing an uppercase character could never match. Proven dead on
the live box: `select count(*) from mail_messages` was **0** after replaying all 18 fixtures. Now
lowercases only the domain (correct email semantics on both counts); matching stays exact-case
because lowercasing the stored token would cost **≈17 bits off a 128-bit value**.
**The instructive part is why tests passed:** `seedMail()` minted tokens from `newId()` — lowercase
UUIDv7 hex — so every token the corpus ever exercised was all-lowercase *by construction*. The
DB-level assertions were genuine; they simply never saw the breaking input class. The harness was
generating its match keys from a different, accidentally-safe alphabet than production. Fixed at
source: `seedMail` now mints tokens the way `queue.ts` does and forces mixed case, so the **whole
corpus** is sensitive to this defect class rather than one added test. `replay-inbound.mjs` gained
DB-backed verification and now fails with `THREADING BROKEN` when a supplied reply token produces
zero new rows — a `204` alone no longer counts as a pass, which is precisely what let this ship.

**0.0.17 (2026-08-06, senior-be, MAIL-24/25/26) — QA findings closed; this heading and the registry
row had drifted apart.** MAIL-24 closed the magic-link timing enumeration oracle (3.25x -> 1.28x,
via equivalent real work rather than fingerprintable sleeps), put `x-forwarded-for` behind a
trusted-proxy allowlist defaulting to trust-nothing (spoofed headers previously defeated the per-IP
rate limit entirely), and made a silent failed auth-send loud via an alert instead of retrying —
retrying would require persisting a raw token, which is deliberately never done. MAIL-26 added
fail-soft counters for the two branches that wrote no DB row (rate-limited mint, rejected consume),
classifying the rejection reason through a sibling CTE so it costs no extra query and creates no new
timing oracle; the HTTP response stays byte-identical and MAIL-24 timing bound re-verified. Counters
are not firing alerts: WS9/Loki is not running, and per-attempt forensics still needs log
aggregation. Full detail in CHANGELOG `[0.0.17]`, which also records why 0.0.15/0.0.16 were
asserted here with no changelog entry (concurrent sessions clobbering these two files).

**0.0.16 (2026-08-05, senior-be, MAIL-25) — the inbound truncation notice is now driven by a
structured field, not an emergent line-shape effect.** MAIL-19's intake cap splices a
`[truncated at intake: N characters omitted here]` marker into `body_text`; MAIL-20's render-side
quote collapse deliberately refused to key off that string (forgeable per corpus case
`18-elision-marker-spoof`), leaving the notice's visibility an ACCIDENT of the marker's own line
never being `>`-prefixed. Closed at the source: migration `0082_mail_truncation_metadata.sql`
adds `mail_messages.body_truncated`/`body_truncated_chars` (additive, `NOT NULL DEFAULT`, zero
backfill DML), set at intake from the SAME length arithmetic `sanitizeInboundText` already used
for the cap — never by parsing content. `ThreadMessageView` (both the entity/portal thread reads
and the admin log thread) now carries `bodyTruncated`/`bodyTruncatedChars`; `QuotedMessageBody`
renders its notice from that field alone, as a separate always-rendered element independent of
`lib/mailQuote.ts`'s structural quote-collapse (which is untouched — still `>`-prefix runs and
`<blockquote>` depth, still content-shape-only). Proven: a forged marker with no structured field
renders as inert plain text with NO notice (`QuotedMessageBody.test.tsx`'s `role="note"` absence
check); a GENUINE marker deliberately constructed on a `>`-prefixed line — inside a quote run that
would have hidden the old marker-text-as-notice behind "Show quoted history" — still shows the
notice, because the notice never looks at `bodyText`. Backend: `npx vitest run src/mail` from
`platform-nest/` — **21 files, 174/174 passing** (own `TEST_DB_PREFIX=mail25`, 14 throwaway DBs
created and dropped, 0 orphaned) — MAIL-19's corpus cases 12/16/17/18 pass unchanged plus new
structured-field assertions reading the columns back from Postgres. Frontend:
`npx vitest run src/lib/mailQuote.test.ts src/components/mail/QuotedMessageBody.test.tsx` green,
plus the full `platform-ui` suite (109 files/1145 tests) green; `next build` (`DEMO_MODE=1`) green.
`tsc --noEmit` clean in both projects for anything this ticket touched (platform-ui carries two
PRE-EXISTING, unrelated failures — a stale `.next/types/validator.ts` route-type error and
`app/(app)/me/leave/page.tsx` — neither touched by this ticket). **Caps at IN PROGRESS**: the live
leg belongs to MAIL-09/deploy, and this ticket makes no deliverability claim.

**0.0.15 (2026-08-05, devops, MAIL-09) — mail ENABLED against the live Mailpit sink on
gda-aicenter; live smokes executed.** Full evidence in `docs/modules/CHANGELOG.md`'s mail section.
Headline: `MAIL_ENABLED=1` + `MAIL_LINK_BASE_URL` set server-side; found and fixed a
compose-env-passthrough bug (`${VAR:-}` → empty string → code's `??` never falls to its compiled
default → empty `From:`/`Reply-To:` domain → Mailpit `553`s every send) by setting explicit
`*.gaiada.invalid` values in `.env`. Smokes 1 (suspended-write warning mail) and 2 (client-gate
signer mail) **PASSED** with real Mailpit captures, correct M12 wording, and correct
staff/portal deep links. Smoke 3 (ex-Q-V7) **SETTLED NEGATIVE**: a real browser walk proved
`platform-ui`'s auth middleware drops the original deep-link target on the `/login` redirect —
reauth always lands on `/`, never back on the entity. This is a `platform-ui` bug, not a mail-tap
bug (MAIL-05/06 build the correct href; nothing carries it through reauth) — needs its own ticket.
Smoke 4 (OTel) not live-claimable (`OTEL_ENABLED=0`, no collector, as expected). Smoke 5: two new
Prometheus alert rules added (`MailQueueDepthHigh`, `MailSendFailureRateHigh`), `promtool check
rules` green (12/12). **Also found, not fixed (out of this ticket's scope):**
`0080_auth_magic_links.sql` (MAIL-10) is untracked in git — never committed, never released, not
applied on the box; `auth_magic_links` does not exist there. MAIL-04/05/06 promoted to
DEV-VERIFIED on the strength of this session's live evidence; MAIL-13/MAIL-15 were NOT re-verified
here (their specific live legs weren't exercised) and stay at their prior status.

**0.0.14 (2026-08-05, senior-be, MAIL-10) — magic links (low-risk convenience login, design §9;
M8/M11 locked).** Migration `0080_auth_magic_links.sql` — re-ran `ls migrations | sort | tail`
immediately before writing DDL per README rule 5; `0077`/`0078`/`0079` were taken, `0080` was free.
`auth_magic_links` is GLOBAL (no `tenant_id` column, deliberately — a magic link authenticates AS
a user before any tenant is selected, the same shape as `mail_log`'s NULL-tenant auth-mail rows),
accessed via `withGlobal` like `users`/`identity_links`; NOT one of the `app.mail_context`-GUC-gated
0077 tables (that GUC answers a different question). Because it carries no `tenant_id`,
`src/db/rls.test.ts`'s "every tenant-scoped table has FORCE RLS" invariant does not select it —
confirmed by running the suite **unmodified**, still green (5/5). This is the RLS decision the
ticket asked to state explicitly, to avoid repeating MAIL-22's mistake (a `tenant_id` column
shipped with no RLS) — the mistake doesn't apply here because there is no `tenant_id` at all.

**Two hard lines, both held:**
- **Never a usable token persisted, anywhere, including `mail_log.payload`.** `auth_magic_links`
  stores only `sha256(rawToken)` hex. The harder case: the rest of `src/mail/` defers rendering to
  an async sender worker that re-renders `{subject,html,text}` from `(template_key, payload)` —
  fine for approval mail (no secret in its `href`), unsafe for a magic link (its `href` IS the
  secret). Resolved by rendering + sending INLINE at mint time (raw token lives only in a
  function-local closure, never assigned to anything `JSON.stringify`/`c.query` touches) and
  writing a REDACTED `mail_log` audit row (no href, no token, `status` starts at `'sending'` so
  the standard `WHERE status='queued'` sender loop never tries to re-render it from a hash it
  cannot reverse). The send is fire-and-forget from the caller's perspective — awaiting it inside
  the HTTP handler would reopen the exact timing oracle the next bullet closes.
- **202 body + timing flattened for existing vs unknown address.** The HTTP handler never awaits
  the SMTP round-trip; both branches do comparable DB-round-trip work (best-effort, not a
  cryptographic constant-time claim — documented as such in `service.ts`). Rate limits
  (3/address/hour, 10/IP/hour) apply BEFORE the user lookup and, when tripped, return the
  identical accepted response with zero DB mint work. Design §5.1's ONE documented exception: a
  known-but-suppressed address gets a distinguishable `503` — deliberate, not a regression.

**M11 (a magic link must never be an approval mechanism)** — restated in three places: a header
comment at the mint site (`service.ts`), a header comment at the template render site
(`templates.ts`'s new `auth.magic_link` function), and a pinned test
(`src/mail/magic-link/m11-non-goal.test.ts`) asserting (a) `approval.warning`/`approval.actionable`'s
own wording never mentions "magic"/"token" and (b) no file outside `src/mail/magic-link/` (with
two named, inspected exemptions: `templates.ts`'s own registration line, and a pre-existing
`migration.test.ts` placeholder row that predates this ticket) references the `auth.magic_link`
template key at all.

**Activities audit — deliberately does NOT write to the `activities` table.**
`activities.tenant_id` is `NOT NULL` (0001_core.sql) and every one of the ~40 call sites in this
codebase resolves a real `:tenantId` route param first — there is no precedent for a tenant-less
write, and a magic-link mint/consume has no tenant (a user in N companies has none to prefer; an
unknown address has none at all). Followed the codebase's own precedent instead:
`src/rbac/principal.ts`'s `auditDecision` — `if (!tenantId) return; // global-scope decisions have
no tenant feed (logged by caller)`. Implemented as: a structured, token-free console audit line per
mint/consume (`[magic-link:audit] …`, ids only, never a token or token hash) PLUS the durable
record that already exists for every other kind of mail — the `mail_log` row (mint) and
`auth_magic_links.consumed_at`/`consumed_ip` (consume), mirroring how `mail_log` itself is already
documented as the A5 audit trail for notifications.

Endpoints (root-level, `ServiceGuard`-only — BFF-internal, never browser-reachable):
`POST /auth/magic-link` (mint, always 202) and `POST /auth/magic-link/consume` (atomic single-use,
one generic error for unknown/replayed/expired). `platform-ui/src/app/auth/magic/route.ts` is the
consume landing page; mints `sealSession(userId)` — the identical plain-payload cookie shape
`login/actions.ts`'s dev-login produces, not `auth/callback/route.ts`'s OIDC-wrapped form.
`MAIL_MAGIC_LINKS_ENABLED` stays `0` by default (config.ts AND the compose `environment:` block —
both already existed from MAIL-13's forward-wiring; this ticket adds the three new
`MAIL_MAGIC_LINK_{TTL_SECONDS,RATE_PER_ADDRESS_HOUR,RATE_PER_IP_HOUR}` vars to both places + the
`.env.example`s). Real-user enablement is staging §15 R5 — explicitly not this ticket.

Proof: `TEST_DB_PREFIX=mail10agent npx vitest run src/mail src/db` (run from `platform-nest/`) →
**291/291 green**, incl. `src/db/rls.test.ts` unmodified (5/5) and the double-consume race
(`Promise.allSettled` over 8 real concurrent connections against the real test Postgres → exactly
1 fulfilled, 7 rejected with the same `MagicLinkConsumeError`). `npx tsc --noEmit` clean;
`npm run lint:migration-rls` and `npm run lint:withtenants` both pass. 22 `mail10agent_*` test
databases created during the run, all dropped after (`pgtest_*` count unchanged at 146 before/after,
151 total databases before/after — no orphans left).

**Cap: IN PROGRESS, not DEV-VERIFIED.** The live round-trip on a deployed box (mint → Mailpit
capture → click → consume → cookie) is **PENDING-DEPLOY** — no deploy path exists while GitHub
Actions is billing-blocked (the release currently in flight is failing on an unrelated SBOM
attestation issue, per the orchestrating session). **No SLO claim anywhere** — M8's p95/p99
auth-stream latency SLO needs ≥7 days of real relay traffic (design §15 R5) and is deferred whole,
not approximated.

**0.0.13 (2026-08-05, senior-be, MAIL-23) — drift guard for the Cerbos decider mirror.**
`src/core/approval-deciders.ts` mirrors two Cerbos policies IN APPLICATION CODE for notification
routing only (Cerbos remains the sole authorization authority); there was no automated check that
the mirror still matched the policies it claims to reproduce, so a policy edit changing WHO may
decide, with no matching edit to the mirror, would silently misroute or drop review-needed mail
with zero signal. New `src/core/approval-deciders-policy-drift.test.ts` reads both policy YAMLs at
test time (no live Cerbos, no DB — pure file parsing, narrow hand-written parser rather than a new
`yaml`/`js-yaml` dependency, since neither is declared in `platform-nest/package.json`) and asserts
each policy's decide-equivalent rule's `derivedRoles` — `resource_automation_approval.yaml`'s
`decide` action and `resource_agency_approval.yaml`'s `approve` action (it has no `decide` action
at all) — matches the concrete role names the mirror's header documents (`company_admin`,
`group_executive`, `hr_manager`; `company_admin`, `agency_approver`). Verified it does NOT
false-positive on the exact live case (D14-06 adding `retry` alongside `decide` with the same role
set) or on an unrelated comment edit, via in-memory mutations of the real policy text — never the
committed policy files, which are off-limits (D14 owns them). Demonstrated the guard actually
fires: a committed test mutates a copy to add a role and asserts the comparator throws an
actionable message (names the policy file, the added role, and that `approval-deciders.ts` must be
updated); separately, manually dropped `hr_manager` from the test's own expected-role constant,
ran the suite, got 4/5 red with that exact message, then reverted to 5/5 green.
`npx vitest run src/core/approval-deciders-policy-drift.test.ts` → 5/5 green; `npx tsc --noEmit` →
clean. No bug found today — the concurrent D14 role set (`company_admin`, `group_executive`)
was and is unchanged; this only makes the NEXT such change loud. Test-only: no migration, no
production-code change, no Cerbos policy edit.

**0.0.12 (2026-08-05, senior-db, MAIL-22) — FORCE-RLS invariant restored on all three mail tables.**
`mail_log`/`mail_messages` carry `tenant_id` (nullable — auth mail has none) and had NO RLS at all
since MAIL-04's original cut, which broke `src/db/rls.test.ts`'s estate-wide "every tenant-scoped
table has FORCE RLS" invariant (the one failing test in an otherwise-green full regression run).
Fixed by amending `platform-nest/migrations/0077_mail_core.sql` in place (never applied to a
persistent database — safe to amend per README rule 4) to add `ENABLE`+`FORCE ROW LEVEL SECURITY`
plus a `mail_context` policy on `mail_log`, `mail_suppressions`, AND `mail_messages`, gated on a
dedicated `app.mail_context` session GUC — the same GUC-gate shape `0015_site_subscriptions_rls.sql`
uses for the sync engine's `app.sync_context`. A new `withMailContext()` wrapper
(`src/db/index.ts`) sets that GUC (SET LOCAL semantics, one transaction) and is now the exclusive
DB entry point for all mail-table access in `src/mail/**` (`queue.ts`, `sender.ts`,
`admin-mail.controller.ts`, `thread.controller.ts`, `webhook.controller.ts`,
`inbound/intake.ts`) — `withGlobal` itself is untouched, so its other callers (`users`,
`identity_links`) are unaffected. NULL-tenant (auth) mail rows are governed by the identical
predicate as every other row (context-opted-in or not), so they remain fully readable/writable by
the mail module and are proven so by a new test in `src/mail/migration.test.ts`, alongside a
defence-in-depth proof that a connection which never opts in (e.g. a future query mistakenly using
`withGlobal`) sees zero rows and cannot write. Stated plainly, not overclaimed: this restores
defence in depth against code that forgets mail's context, not a new access-control layer — the
elevated-only admin log and the A10 parent-entity thread check remain the primary gate.
`npm run lint:migration-rls` and `npm run lint:withtenants` both pass (0077 has zero backfill DML,
so the now-applicable RLS lint finds nothing to flag). Scoped regression (`src/mail src/db`, 26
files / 274 tests) green, including `src/db/rls.test.ts` **unmodified**.

**0.0.11 (2026-08-05, devops, MAIL-21 batch B0) — server↔repo reconciliation + CI restored + a
correction to 0.0.10's own claims.** `COMPOSE_PROFILES` re-verified (`bot,auth,whisper,mail-dev,scan`
— no drift, no write); a deploy-shaped `up -d --remove-orphans` on gda-aicenter (real repo-var
profiles/files, tag-parity-checked first) left mailpit/clamav/the standalone alertmanager pair
running untouched. Full server↔repo diff run: compose files, scripts, and keycloak provisioning
scripts are clean; the realm JSON's `smtpServer` block + `configure-smtp.sh` (MAIL-03) and the
`MAIL_*`/`KC_SMTP_*`/`APPROVAL_GRANT_SECRET` compose passthrough (MAIL-03/04/13 + the concurrent
D14 program) are absent from the server's stale pre-deploy copy — both self-heal via `deploy.yml`'s
existing rsync/scp sync step, confirmed rather than assumed (`docker inspect` shows zero of those
vars in the currently-running container, consistent with the box still being pinned to
`alpha-01.016.0037a`). `.env.alertmanager-mail` documented in `CREDENTIALS.local.md` §6a (keys
only). CI's `push`/`pull_request` triggers restored (secret-free confirmed by grep first) and a run
was executed. **The run surfaced a materially bigger problem than the billing wall:**
`platform-nest/src/mail/` — the entire mail module's code, tests, and fixture corpus — has **never
been committed to git**; it exists only in this shared working tree. `0.0.10`'s and MAIL-13's own
CHANGELOG language ("wired into CI", "committed adversarial corpus") describes the working tree,
not version control. Dev-stage exit criterion #3 is not blocked-and-unprovable, as v4 states — it
is unmet outright, independent of GitHub Actions billing, until someone commits the module. See
CHANGELOG `0.0.11` for the full ledger; not fixed here (`platform-nest/src/mail/` is outside this
devops ticket's remit and off-limits per the concurrent-session boundary in force).

**0.0.10 (2026-08-05, architect) — design v4 amendment + program state.** The dev build's findings
are folded back into the design (see CHANGELOG `0.0.10` for the full list): Brevo signs nothing —
the token wall IS the provider scheme and the built HMAC verifier is OURS (defence-in-depth);
Brevo delivers attachment `DownloadToken`s, not bytes (token→bytes fetch = staging §15 R3);
quoted-history handling decided as **A15** (head+tail intake cap + render-side collapse — new
tickets MAIL-19/20); attachment cap semantics ratified as implemented (drop-but-thread
per-attachment, total cap refuses); the F1 audit corrected (a third `automation_approvals` insert
site in `search.controller.ts`, fixed by MAIL-06); APPR-01 (`/approvals/[id]`, owner-approved,
cross-program) recorded as the per-item approval landing + thread-panel mount, which must also
flip the backend-emitted `payload.href`. **Program state: BLOCKED at the billing wall** — GitHub
Actions billing is off and it is the only deploy path, so MAIL-09/10/11 + MAIL-18's gate and exit
criterion #3 (corpus shown in CI) cannot run; ticket plan v4 defines the deferred
live-verification batch (B0–B4), which MUST start with the `COMPOSE_PROFILES` repo-var fix
(MAIL-21) or the first deploy deletes the mailpit+clamav containers. Also recorded this session:
the eight `MAIL_INBOUND_*`/`MAIL_CLAMAV_*` vars are now forwarded in the `platform` service
`environment:` block (the compose-passthrough follow-up below is CLOSED).

**MAIL-19 landed 2026-08-05 (senior-be) — quoted-history intake cap SHAPE (design A15),
`platform-nest/src/mail/inbound/html-sanitize.ts`'s `sanitizeInboundText`.** Fixes the real
content-loss bug A15 was written to close: the pre-A15 cap kept only the FIRST 128 KiB of an
over-cap plain-text inbound body, so a **bottom-posted** reply (the human's words below a long
quoted thread) could be truncated away entirely with no way to recover it (raw MIME is never
stored). Reshaped to a **head+tail** cap — ~¾ head / ¼ tail of the same 128 KiB budget — with an
explicit `[truncated at intake: N characters omitted here]` marker spliced in at the boundary; `N`
and the split point are computed ENTIRELY from `raw.length`/`maxLength`, never from content, which
is what makes the marker un-forgeable (a sender-embedded decoy string shaped like the marker is
stored back as ordinary text, never treated specially) and keeps intake heuristic-free — no
quote-boundary detection was added, per A15's binding "caps and records, never interprets"
invariant (quote-boundary detection is MAIL-20 render work). `body_html_sanitized` is UNCHANGED
(still head-capped only — splicing HTML mid-document would break the rebuilt-balanced-tags
guarantee; the no-loss guarantee rides on `body_text`, which is NOT NULL). **No schema change, no
migration** (deliberate — the migration ledger is contended; `0078_automation_approval_execution.sql`
landed from a concurrent session the same day). **Three new corpus cases** added to
`src/mail/__fixtures__/inbound/` (16/17/18), wired into `corpus.test.ts`, driven through the real
`POST /api/mail/inbound/brevo` endpoint against live Postgres: `16-bottom-posted-oversize-quote`
(THE regression case — reply below a ~145 KB quote, asserted present in `mail_messages.body_text`
read back from the database), `17-top-posted-oversize-quote` (same size profile, reply first — the
case the old head-only cap already handled, pinned so the reshape can't regress it), and
`18-elision-marker-spoof` (two sender-forged decoy markers, one at the very start and one planted
immediately adjacent to the real elision boundary — asserted to survive verbatim as ordinary
content while exactly one marker in the output carries the mathematically correct omitted-count,
distinguishable from both decoys' bogus counts by that number alone). Five new unit tests in
`html-sanitize.test.ts` pin the same properties at the string-function level (head+tail retention,
top-posted-unchanged, under-cap-verbatim-no-marker, the spoof property). **All 15 pre-existing
corpus cases verified unchanged, incl. `07-oversized-body` (whole-request 413 refusal — an
unrelated cap on raw pre-parse bytes, `MAIL_INBOUND_MAX_BYTES`) and `12-quoted-reply-bloat`** (its
`_meta.expect` text updated to note it sits UNDER the 128 KiB body_text cap and so is not itself an
over-cap case — the genuine head+tail regression coverage lives in 16/17; its test assertions are
unchanged). **Verified this session:** `npx vitest run src/mail` — 15 files, 142 tests green (135
pre-existing + 7 new); `npx tsc --noEmit` clean for everything under `src/mail` (three pre-existing,
unrelated errors surfaced in `src/core/d14-06-approval-decider-policy.test.ts` from concurrent
D14/APPR-01 work in `src/core/**` — not touched by this ticket, not introduced by it); A12 grep
gate re-run scoped to every file this ticket touched (incl. all three new fixtures) returns zero
`gaiada.com`/`gaiada.online` hits; test DBs run under a dedicated `TEST_DB_PREFIX`, all 9 dropped
after the run (zero orphans left behind). **Capped at IN PROGRESS, not DEV-VERIFIED:** no live box
access in this ticket (same constraint recorded on MAIL-04/05/15) — the replay-script leg against
the deployed box is deferred to batch B2 per the ticket plan, unaffected by this change (the
fixture loader picks up 16/17/18 automatically via `fixtureNames()`).

**MAIL-20 landed 2026-08-05 (medior) — quote-collapse at render (design A15.2),
`platform-ui/src/lib/mailQuote.ts` + `components/mail/QuotedMessageBody.tsx`, wired into
`MailThreadPanel` (entity/portal thread panels) and `/admin/mail/[id]`.** Pure, zero-I/O boundary
detectors — `splitQuotedText` (contiguous `>`-prefixed line runs, folding sandwiched blank lines;
an `On … wrote:`/`-----Original Message-----`/Outlook `From:`+`Sent:`+`To:`+`Subject:` header
collapses to the end of the text since it carries no per-line delimiter) and `splitQuotedHtml`
(depth-counted `<blockquote>` spans over the sanitized HTML — the only tag-based signal available,
since the sanitizer strips every attribute including `class`, so a `gmail_quote` class-based
detector as literally named in the ticket brief is structurally impossible against
`bodyHtmlSanitized` and was replaced with tag-based detection) — split a message into alternating
visible/quoted segments, recomputed fresh on every render and **never persisted or sent back to the
server** (design binding). Multiple quote blocks (interleaved-reply) each get their own toggle.
Native `<details>`/`<summary>` (no client JS, no `"use client"` boundary) renders the affordance,
satisfying keyboard-reachability and labelling for free. **The MAIL-19/marker-spoof constraint,
resolved as OPTION 2 (flagged, not invented):** checked `platform-nest/src/mail/thread.controller.ts`
(`ThreadMessageView`) and the `mail_messages` DDL — **no structured `truncated`/`omittedChars` field
is exposed today**, only `bodyText`/`bodyHtmlSanitized`; the true distinguishing signal (the
mathematically correct `N`) lives only in the intake computation and never reaches this layer. With
no trustworthy signal, `lib/mailQuote.ts` and `QuotedMessageBody` **never pattern-match the marker
string at all** — not to extract it, not to keep it specially visible, not to style it — every
classification is driven purely by structural shape (`>`-prefix, `<blockquote>` tag) that ordinary
sender text does not take. On the two MAIL-19 reference shapes (`16-bottom-posted-oversize-quote`,
`17-top-posted-oversize-quote`) the marker ends up visible by default anyway, as an EMERGENT effect
of the marker line not being `>`-prefixed (it breaks the quote run) — not because the code
recognised it; this is stated explicitly in both files' header comments so it isn't misread as a
missed requirement later. **A follow-up is needed if guaranteed marker-visibility (independent of
line shape) is wanted**: platform-nest would need to expose a structured `truncated`/`omittedChars`
field on `ThreadMessageView`/`mail_messages` — deliberately NOT built here (new field ⇒ possible
migration, and the ledger is contended); flagged for architect routing. **Tests:** 12 new cases in
`lib/mailQuote.test.ts` (no-boundary fail-safe, bottom-posted, top-posted, interleaved-reply,
header-style-to-end-of-text, the marker-breaks-a-run emergent property, the forged-marker-verbatim
case, and five HTML/`<blockquote>` cases incl. nesting + multiple top-level blocks + unterminated
tag) plus 5 in `components/mail/QuotedMessageBody.test.tsx` (reply visible without interaction,
`<details>` closed by default, keyboard-reachable native `<summary>`, expansion reveals the full
quote, forged marker renders as plain `<pre>` text with no chrome element). **Verified this
session:** `npx tsc --noEmit` clean (exit 0); full `platform-ui` suite green — 106 files / 1062
tests, incl. the 17 new ones; `DEMO_MODE=1 npx next build` green (`/admin/mail`,
`/admin/mail/[id]`, `/pipeline/[runId]`, `/portal/approvals/[runId]` all present in the route
manifest); A12 grep gate re-run scoped to every file this ticket touched returns zero
`gaiada.com`/`gaiada.online` hits. `demoFixtures.ts` gained a second `run-demo-1` thread message
(a bottom-posted quoted reply at demo scale) so `DEMO_MODE=1 npm run dev` shows the collapsed-quote
UI with no backend. **Nothing about the collapse is stored** — verified by construction: the
functions take a string and return a string split, no DB write, no new BFF field, no new endpoint.
**Capped at IN PROGRESS, not DEV-VERIFIED:** no live-box walk in this ticket (same constraint as
MAIL-04/05/15/19) and no deploy path exists (Actions billing-blocked); the only PENDING-DEPLOY leg
is a live-box eyeball of the rendered collapse, which needs nothing beyond what MAIL-15 already
verified for the panel itself.

**MAIL-15 landed 2026-08-05 (medior) — the mail surface UI, `platform-ui/src/lib/mail.ts` +
`components/mail/` + `/admin/mail`.** Admin log list (`/admin/mail`, filters stream/status/
tenantId/entityType/entityId/since, offset-based "Load more" pagination) and detail
(`/admin/mail/[id]`, an event timeline synthesized from `mail_log`'s own lifecycle timestamps —
there is no separate events table — plus the inbound thread); a self-contained
`MailThreadPanel` server component (fetches its own data via `getEntityMailThread`/
`getPortalRunMailThread`) wired into the pipeline run workspace (`/pipeline/[runId]`) and the
portal run view (`/portal/approvals/[runId]`, via the portal-scoped BFF read — never the elevated
admin path). **Two honesty requirements, both structural, not copy choices:** (1) status chips —
`sent` renders through a dedicated `MailStatusChip` that appends "accepted by relay — not a
delivery confirmation" rather than reusing the bare `StatusBadge`, so a future status can't
silently regress into implying delivery; (2) every thread message the BFF serves carries
`senderVerified:false` (`ThreadMessageView`), and `MailThreadPanel`/the admin detail page render
the "Email reply — sender unverified (‹from_email›)" banner off that field, never a hardcoded
per-page assumption. Thread reads (`GET /api/admin/mail/log/:id/thread`, `GET /api/:t/mail/
threads`, `GET /api/:t/portal/mail/threads`) absence-degrade to an empty thread on 404/405
(`degradeThread` in `lib/mail.ts`) — MAIL-13 landed concurrently with this ticket and the brief
called it "unverified"; a 403 still propagates as a real refusal. **DEMO_MODE** fixtures added to
`demoFixtures.ts` (`DEMO_MAIL_LOG` + thread rows) use only the reserved TLD `*.gaiada.invalid`
(design A12) and are wired into the existing route dispatcher; a permanent smoke test
(`lib/mail-demo-smoke.test.ts`) proves list/detail/admin-thread/entity-thread/portal-thread all
serve with zero backend, and that the portal route still 403s a staff caller exactly like the
real portal-scope predicate would. **Verified this session:** `npx tsc --noEmit` clean; full unit
suite green (1041 tests, incl. the new smoke test); `next build` green with `/admin/mail` and
`/admin/mail/[id]` both present in the route manifest; the A12 grep gate re-run scoped to every
file this ticket touched returns zero `gaiada.com`/`gaiada.online` hits. **Not verified — capped
at IN PROGRESS accordingly:** no live BFF was reached (no server access in this ticket, same
constraint MAIL-04/05 recorded) — the list/filter/paginate-against-the-live-box AC and the
corpus-fed-thread-visible AC are both PENDING a deploy + live walk, tracked as a MAIL-09-style
follow-up, not claimed here. **Deferred, with reason:** the approval-detail surface (`/approvals`)
has no per-item detail page to embed a thread panel into — approvals are decided inline in the
unified `ApprovalsList` component on the list page itself; wiring a thread panel there would mean
restructuring that component, which is out of this ticket's scope. Flagged for the next approvals
UX ticket rather than silently skipped. *(0.0.10 update: that ticket now exists — **APPR-01**,
owner-approved `/approvals/[id]`, in flight cross-program; design §7.5 v4 binds it to also flip
the backend-emitted `payload.href`, since MAIL-05's tap only absolutises what it is handed.)*

**MAIL-03 landed 2026-08-04 (devops) — Keycloak realm SMTP against the Mailpit sink, real auth
flows end-to-end, DEV-VERIFIED on gda-aicenter.** Live realm `smtpServer` configured via `kcadm`
under the `/idp` prefix (host `mailpit`, port `1025`, from `no-reply@auth.gaiada.invalid`, no
auth/TLS); confirmed to survive a `docker compose ... up -d --force-recreate keycloak` (it's
DB-persisted realm state, not import-derived). **ex-Q-V6 settled, dev-provable:** realm-import
does **not** substitute `${env.*}` placeholders — proven by importing a throwaway realm with a
literal `${env.ZZZ_TEST_SMTP_HOST}` placeholder (env var actually set + passed through) and
finding the unexpanded string in the persisted realm afterwards; test realm + probe file deleted,
no residue. `infra/compose/keycloak/gaiada-realm.json` therefore ships a real working dev-default
`smtpServer` block (the Mailpit shape) instead of inert placeholder strings, plus a new
`infra/compose/keycloak/configure-smtp.sh` (reads the keycloak service's own `KC_SMTP_*` env,
pushes it via `kcadm update`) for anyone who needs a non-default value — the honest fresh-boot
path is documented in `docs/runbooks/idp-keycloak.md`. `KC_SMTP_HOST/PORT/FROM/
FROM_DISPLAY_NAME/AUTH/SSL/STARTTLS` added to the keycloak service's compose `environment:` block
and `.env.example` in the same change (the compose-passthrough trap). **Both flows driven
end-to-end on the live `erp.gaiada.online/idp` realm** with disposable dev users (deleted after):
forgot-password (real PKCE authorization-code flow → Mailpit-captured "Reset password" mail →
clicked action-token link → real Bearer token issued) and verify-email (created a user WITHOUT
`emailVerified:true`, forced login → `VERIFY_EMAIL` required action → Mailpit-captured mail →
clicked link → `emailVerified` flipped `false→true`, confirmed via `kcadm get users`). **Retirement
evidence:** the verify-email user proves the `gaiada-provisioner` admin-side
`emailVerified:true` workaround CAN be retired in dev; the provisioner client itself is
**unchanged** — retiring it for real users is staging item §15 R6, not this ticket. **Finding
flagged, not fixed here** (outside MAIL-03's scope): the realm's "Reset Password" flow execution
is `REQUIRED` but observed live behavior authenticates straight through without an inline
new-password form when the user already holds a credential and no `UPDATE_PASSWORD` required
action is queued — reproduced under two different clients, so it's flow behavior, documented in
the runbook for follow-up. Caps at DEV-VERIFIED per program rules — no deliverability claim, the
real-relay leg is staging §15 R1/R8.

**MAIL-05 landed 2026-08-04 (senior-be) — the approval/risk email tap, `src/mail/intake.ts`.**
`notify()` (`core/http.ts`) now calls `mailIntake()` exactly once, AFTER its own `notifications`
row commits: allowlist is EXACTLY `{approval.requested, pipeline.gate.opened}` (probed —
`mention`/`comment`/`approval_decided` produce zero `mail_log` rows even though the bell
notification still lands); recipient email resolves via `users.email` (one path for staff AND
client-contact users, M10); wording class by origin per M12/§7.4 (`automation`/`agent` →
`approval.warning`, everything else incl. `pipeline`/`hr`/`agency`/unspecified → the safer default
`approval.actionable`); every mail gets the entity deep link built from `MAIL_LINK_BASE_URL` (plain
URL — no token, no query string, no literal domain — asserted) and a fresh `reply_token`; no
preference surface of any kind (approvals stay non-opt-out-able). **Fail-soft is enforced by the
caller**: `notify()` wraps the tap in try/catch and only logs on failure — test-pinned by forcing
the tap's enqueue primitive to throw and asserting both that `notify()` itself still resolves and
that the triggering HTTP write (a real client-gate open) still returns 201. The M12 wording gate is
re-asserted on the RENDERED output of a row the tap itself enqueued (not just a hand-crafted
template payload) — `src/mail/tap.test.ts`, 13 tests, green against live Postgres (+ the existing
77-test `src/mail` suite, `client-notifications.test.ts`, `automation-approvals.test.ts`, and
`agency.test.ts` all still green; `tsc --noEmit` clean). **Same pass — a QA-filed defect fixed:**
`GET /api/admin/mail/log`'s `tenantId`/`entityId` (`uuid`) and `since` (`timestamptz`) query
filters now shape-check before the query runs (`admin-mail.controller.ts`, same `UUID_RE` /
`Date.parse` convention as `pm.controller.ts`/`search.controller.ts`) — a malformed value is a
clean 400 instead of an uncaught Postgres error surfacing as a bare 500;
`adversarial-qa.test.ts`'s former `[DOCUMENTS DEFECT]` case is updated to assert 400 and is green.
**Status stays IN PROGRESS, not DEV-VERIFIED:** all evidence above is against live Postgres +
Nest's in-process HTTP injection, not a deployed box — the live probe ("trigger a gate on
gda-aicenter ⇒ mail visible in Mailpit with the correct deep link") is explicitly MAIL-09's job and
is **not claimed here**; this session confirmed the Mailpit container is up and healthy on
gda-aicenter but did not deploy this change to it, so running the probe now would only exercise the
OLD (pre-tap) deployed code — reported as PENDING rather than faked.

**What exists:** MAIL-16D landed 2026-08-04 — the `GmailClient` seam + fixture-backed
implementation + provider-agnostic contract-test suite, DEV-VERIFIED for the seam only, in the
self-contained `platform-nest/src/integrations/gmail/` directory (see that directory's README.md
for the honesty note: thread/label/pagination semantics are UNVERIFIED against real Gmail).
**MAIL-00 + MAIL-14 landed 2026-08-04 (this entry, devops) — the Mailpit dev sink + ClamAV scan
service, DEV-VERIFIED with real gda-aicenter evidence:** `mailpit` (`axllent/mailpit:v1.30.6`,
`mail-dev` profile) and `clamav` (`clamav/clamav:1.5.3`, its own `scan` profile — deliberately
NOT `mail-dev`, since real inbound at staging still needs scanning after the sink retires) added
as new top-level services in `infra/compose/docker-compose.vps.yml` (purely additive — the
concurrently-edited `platform` service block was left untouched). Both live on the box: `docker
inspect` shows `healthy` for both; a keyless authless SMTP transaction against `mailpit:1025`
from inside the stack network was accepted and surfaced in `GET /api/v1/messages` over the
loopback API; `ss -tlnp` on the box confirms `:8025` is bound to `127.0.0.1` only (never
internet-reachable — it will hold live password-reset/magic-link mail); the EICAR test string was
flagged `Eicar-Signature FOUND` via `clamdscan`; both containers survived two consecutive
deploy-shaped `up -d --remove-orphans` runs (the orphan probe). **Known gap, reported not
silently worked around:** the GitHub repo variable `COMPOSE_PROFILES` (currently `bot,auth,
whisper`) could NOT be updated to append `mail-dev,scan` — both `gh variable set` and `gh api`
were denied by this session's permission classifier. The two services were brought up on the box
with the profiles supplied manually for this application + the orphan-probe evidence, but until
the repo variable itself is fixed, **the next real `deploy.yml` run will delete both containers**
(the exact trap this ticket exists to prevent) — see the CHANGELOG entry for the exact command to
run. `deploy.yml`'s lane comment updated in the same change.
**MAIL-04 landed 2026-08-04 — the mail CORE module, `platform-nest/src/mail/`:**
migration `0077_mail_core.sql` (`mail_log`/`mail_suppressions`/`mail_messages`, GLOBAL/no-RLS per
design §6.1); `MailProviderAdapter` (`smtp` via nodemailer + `dev-log`, the TLS rule from design
§4.1 — plaintext allowed only when a stream's user+password are both empty); the internal
`enqueueMail()` primitive; the sender worker (chained-setTimeout sweep, `FOR UPDATE SKIP LOCKED`
claim, `min(2^attempts,60)`-minute backoff, 5-attempt cap, auth-stream-first ordering);
enqueue-time + send-time suppression enforcement; `POST /api/mail/webhooks/brevo` (token-authed,
idempotent, 204-on-unknown); elevated-only `GET /api/admin/mail/log[/:id]`; the three code
templates (`approval.warning`, `approval.actionable`, `auth.shell`) with the M12 wording gate
pinned in tests; the A12 grep gate wired into CI (`src/mail/grep-gate.test.ts`). 49 tests green
against live Postgres, incl. a local fake-SMTP server standing in for the sink. **Also observed
already present in `infra/compose/docker-compose.vps.yml` (landed by a concurrent devops session,
not built or verified by this ticket): the MAIL-00 Mailpit dev sink (`mail-dev` profile,
loopback-only UI) and the MAIL-14 ClamAV scan service (`scan` profile).** The `notify()` tap
(MAIL-05 — what actually populates `mail_log` from real approval/gate events) has **not** landed;
until it does, nothing in the ERP enqueues mail on its own. **Status caps at IN PROGRESS, not
DEV-VERIFIED:** MAIL-04 was verified against a local fake-SMTP stand-in and live Postgres — the
real Mailpit sink on gda-aicenter was never reached (no server access in this ticket); that live
smoke (enqueue → message asserted via the Mailpit API) is a tracked follow-up, not claimed here.
Design **v4 (2026-08-05 — implementation-findings amendment; v3 was 2026-08-04's third same-day
revision: dev stage with zero external keys)** —
[`../superpowers/specs/2026-08-04-zone-a-mail-design.md`](../superpowers/specs/2026-08-04-zone-a-mail-design.md)
+ ticket plan (v4) [`../superpowers/plans/2026-08-04-mail-subsystem-tickets.md`](../superpowers/plans/2026-08-04-mail-subsystem-tickets.md).
*(The "no code / zero email" line that stood here is history — the dev stage has executed; see
the ticket entries above and the plan's Execution state table. Live sending is still OFF pending
the deferred live-verification batch.)*
**v3 (owner directive):** nothing external blocks the dev stage. Dev provider = **Mailpit** sink
(compose service on gda-aicenter, `mail-dev` profile, loopback-only UI); inbound is driven by a
committed **adversarial fixture corpus** (kept permanently as the regression suite); every
domain/link-base is env config with `*.gaiada.invalid` dev defaults (grep-gated — staging swap is
env-only); magic links move up to W6 (SLO + real-user enablement stay staging-gated); Gmail dev
scope = the `GmailClient` seam + fixture only (MAIL-16D) — the live wave is honestly flagged the
program's **highest re-verification risk**. Relay/DNS/Brevo/Google all live in the design's
**§15 Staging Reopen Register**, the single handover table for the staging stage (Q-V1–V9 folded
in). **Status caveat (binding):** Mailpit/fixture evidence caps at DEV-VERIFIED; deliverability,
inbox placement, and the M8 latency SLO stay UNVERIFIED until the reopen closes.
**Scope (v2):** email is NOT a general notification channel — staff notifications stay realtime
in-app; the **digest + per-user prefs surface are cancelled**. Mail fires only on (a) automation/AI
medium-or-higher-risk actions (attached to the existing WS4 impact gate / D14 suspension — no new
classifier) and (b) anything requiring human approval, routed to the resolved decider set (Cerbos
DECIDE mirror; clients ride the same path via the existing pipeline-gate plumbing). D14-aware
sequencing: warning wording first for automation/agent (approving executes nothing today);
actionable wording gated on the D14 resume path. Approval links = plain deep links behind SSO —
no action buttons, no approve-by-reply, never magic links. **Bidirectional:** inbound system-mail
threads via `reply+<token>@notify.gaiada.com` → `mail_messages` (untrusted intake: signature,
caps, sanitizer, ClamAV) threaded onto entities; still no mailbox hosting of ours. ERP mail
surface: `/admin/mail` log UI + entity thread panels. Domains locked: `auth.`/`notify.gaiada.com`
(Workspace root) + `forms.gaiada.online` (Zone B only); **Google Workspace SMTP relay primary for
Zone A**, Brevo = failover + inbound + Zone B forms. Roadmap (staging-ready, not parked): staff
Gmail read surface — internal-type OAuth app, employees only, per-user OAuth (no DWD),
`gmail.readonly`, render-on-demand/cache-nothing, tokens in the 0033 vault, state machine =
WD-23A-1's core `google_oauth_states` (hard dependency). Keycloak + Alertmanager SMTP (zero
code); magic links = low-risk convenience login only, built last behind the p95 SLO gate. Zone A
mail deliberately does NOT route through webdesk C-03.
**Future plans:** dev stage W0–W7 per the v3 ticket plan (MAIL-00 sink → core → tap/inbound →
UI/deploy → magic links → MAIL-18 exit gate) — **no external blockers**; then the staging reopen
W-S0–W-S3 (relay/DNS + Brevo = ex-Q-O1/Q-O3, Gmail wave = ex-Q-O2 + WD-23A-1 landing, ≥7-day SLO
window before real-user magic links). 07/08 stay dropped; dropped numbers not reused.

**MAIL-02 landed 2026-08-04 (devops) — Alertmanager email live against the Mailpit sink, D15
second transport, DEV-VERIFIED with real gda-aicenter evidence.** Added
`smtp_require_tls: ${SMTP_REQUIRE_TLS}` to `infra/observability/alertmanager/alertmanager.yml`'s
`global:` block (Alertmanager's own default is `true`, which flatly refuses the TLS-less sink —
this one line supersedes the earlier "don't edit compose" note) and `SMTP_REQUIRE_TLS:
${SMTP_REQUIRE_TLS:-true}` (secure-by-default) to the `&am_env` anchor in
`infra/compose/docker-compose.observability.yml`; mirrored into a **new standalone compose
project** `infra/compose/docker-compose.alertmanager-mail.yml` (`name: gaiada-alertmanager`,
services `alertmanager-render` + `alertmanager` only — the WS9 stack stays NOT up on the box),
attached to the main stack's network via `networks.stack: {name: gaiada_default, external:
true}` — the n8n precedent, so it survives the main project's `--remove-orphans`. Server-side env
lives in a new, ungitted `infra/compose/.env.alertmanager-mail` (`SMTP_SMARTHOST=mailpit:1025`,
`SMTP_FROM=alerts@notify.gaiada.invalid`, empty auth, `SMTP_REQUIRE_TLS=false`; Telegram/ntfy/
webhook/deadmansswitch given deliberate `*.invalid` placeholder values so every receiver stays
config-valid without needing real third-party credentials — this ticket exercises the email leg
only). **Evidence:** `amtool check-config` inside the running container →
`SUCCESS … 3 receivers … 1 templates` (all of `default-multi`/`page-all`/`deadmansswitch` present,
Telegram/ntfy legs config-valid, not removed); a synthetic `POST /api/v2/alerts`
(`MAIL02SyntheticProbe`) landed in the Mailpit API within the `group_wait` window — message
`From: alerts@notify.gaiada.invalid`, `To: ops@notify.gaiada.invalid`, `Subject: "[FIRING:1]
MAIL02SyntheticProbe mail-02-devops-ticket (warning)"` — captured, then resolved for hygiene; the
real deploy-equivalent command was run for real (`COMPOSE_PROFILES='bot,auth,whisper,mail-dev,
scan' docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --no-build
--remove-orphans`, the exact repo-variable values read live via `gh api`) and both `mailpit` and
the separate `gaiada-alertmanager` project's `alertmanager` container were confirmed unaffected
(`docker ps` before/after) — no orphan removal touched either. `docker-compose.obs-local.yml` and
`alertmanager.local.yml` left untouched. **Cap: DEV-VERIFIED — real-relay leg (Telegram token,
real SMTP relay, real ntfy/webhook/dead-man's-switch endpoints) is staging §15 R8, not claimed
here.** Nothing in `platform-nest/` touched.

**MAIL-13 landed 2026-08-05 (senior-be) — inbound system-mail threads (C1), the untrusted-input
pipeline.** `POST /api/mail/inbound/brevo` is real: token wall (`MAIL_INBOUND_TOKEN`, constant-time,
**fail-closed when unset** — same shape as MAIL-04's `assertWebhookToken`) plus an OPTIONAL
HMAC-SHA256 signature over the RAW request bytes (`MAIL_INBOUND_SIGNING_KEY`; required once
configured). **Finding, architect-visible:** Brevo does **not** sign webhooks at all — its documented
options are basic-auth-in-URL, a token header, or custom headers (verified against Brevo's docs
2026-08-04), so "implemented to Brevo's documented scheme" is the TOKEN, and the HMAC verifier is
ours; §15 R3's "verify signature validation against real signatures" needs re-scoping at staging.
Matching is the VERP `reply+<token>@` local part → `mail_log.reply_token` and nothing else —
`from_email` is stored as display metadata and never consulted for routing or authorization.
Inbound is idempotent on `(provider, provider_message_id)`, and the idempotency decision happens
BEFORE any sanitizing/scanning/quarantine write, so a replayed delivery costs nothing. Raw MIME is
never stored: a tokenize-and-REBUILD HTML allowlist sanitizer (`src/mail/inbound/html-sanitize.ts`,
no new dependency) constructs the stored `body_html_sanitized` from an allowlisted tag set plus
escaped text, so no attribute except a scheme-validated `a[href]` can exist in the output and
`<img>`/`<script>`/`<style>`/`<svg>` are unrepresentable rather than filtered. Attachments land in a
quarantine prefix of the existing file store (never a `files` row) with a `scanStatus` download gate
consuming MAIL-14's clamd: `clean` serves, `infected` refuses at every privilege and its bytes are
never written to disk, `pending` (unscannable — clamd down/absent) stays quarantined at every
privilege, `skipped` (scanning off) is admin-only. Unmatched/absent/unknown token ⇒ counter + log +
**204** (A9) with a response byte-identical to the matched case, so the endpoint is not a token
oracle. Best-effort NDR classification requires TWO independent signals (its harmful failure
direction is a FALSE positive, which would suppress a real recipient's address) and only a 5.x.x
status produces `status='bounced'` + suppression; NDR rows are stored with a NULL entity so a bounce
can never render as a human reply on a decision surface. Thread reads —
`GET /api/:t/mail/threads`, `GET /api/:t/portal/mail/threads`,
`GET /api/:t/mail/messages/:id/attachments/:i`, `GET /api/admin/mail/log/:id/thread` — authorize
against the **PARENT entity** (A10) through one shared `thread-authz.ts` that reproduces each parent
surface's own `authorize()` shape, `module` attribute included.
**New env (all in `src/config.ts`):** `MAIL_INBOUND_SIGNING_KEY`,
`MAIL_INBOUND_SIGNATURE_TOLERANCE_S`, `MAIL_INBOUND_MAX_ATTACHMENT_BYTES`,
`MAIL_INBOUND_MAX_ATTACHMENTS`, `MAIL_INBOUND_RATE_PER_MIN`,
`MAIL_CLAMAV_HOST`/`_PORT`/`_TIMEOUT_MS` *(0.0.10 update: the compose-passthrough gap flagged at
landing is CLOSED — all eight are now forwarded in `docker-compose.vps.yml`'s `platform`
`environment:` block)*.
**Evidence:** `npx vitest run src/mail` → **15 files, 135/135 tests passing** against live Postgres +
Cerbos (the 22-case corpus suite, the 15-probe thread-authorization suite, 21 sanitizer unit tests,
and every pre-existing MAIL-04/05 suite incl. the A12 grep gate, which the new fixtures pass).
Committed adversarial corpus at `src/mail/__fixtures__/inbound/` — 15 provider-shaped fixtures
covering every case design §7.6 enumerates, each self-describing and each with a pinned test; wired
into CI as a named fail-fast step (`npm run test:mail-corpus`). **Three real defects were found by
the corpus and fixed:** (1) the replacement body handed to Fastify's parser was a string, so
`Buffer.concat` threw inside a stream callback and every inbound request HUNG instead of erroring;
(2) `content-length` was not rewritten for that replacement stream, 500-ing every post; (3) `embed`
was subtree-dropped despite being a void element, so a mail containing `<embed>` silently lost every
byte after it. **Caps at IN PROGRESS.** NOT claimed: the replay script has never run against a
deployed box (`npm run mail:replay-inbound -- --base <url>` exists and is **PENDING-DEPLOY**); the
corpus is committed to CI but **cannot be shown running** while GitHub Actions is billing-blocked
(dev-stage exit criterion #3 stays OPEN); real Brevo payload fidelity/signatures (§15 R3), real relay
NDR classifiability (§15 R4), and the live clamd path (proven separately by MAIL-14 on the box, here
driven through a stub scanner) are all unverified here. **Follow-up CLOSED (0.0.10, 2026-08-05):** the new `MAIL_*`
vars are now in `infra/compose/docker-compose.vps.yml`'s `platform` service `environment:` block
(they would otherwise have shipped silently disabled — the standing compose-passthrough trap,
caught in-session this time). Brevo inbound also hands out attachment `DownloadToken`s rather
than bytes, so the token→bytes fetch is staging work behind the existing `NormalizedAttachment`
seam — carried as a named step in design §15 R3 (v4).

## search-marketing â€” SEO Â· SEM Â· GEO Â· `0.5.0` Â· DEV-VERIFIED

**State at 0.5.0 (2026-08-01, SM-24 final QA gate, re-verdict Â§6bu/Â§6by).** Promoted from
`IN PROGRESS` to `DEV-VERIFIED` â€” the vocabulary's own bar ("prototyped and exercised end-to-end
on the local stack"), **not** production-readiness, which still requires real vendor credentials
(SM-41G, staging-only per standing policy). Since 0.4.0: SM-19 (dual-mode apply picker), SM-20
(search-terms sync), SM-21 âš¡ (approve-execute-replay, migration `0064`), SM-22 (client reports),
SM-25c (Google Ads read path), SM-63/67/68/69/70/71/72 (the SM-63 "resolve-by-one-key" pattern
closed at all five confirmed sites, migrations `0065`/`0066`), SM-73 (event-stream notification
wiring), SM-74 (report-lifecycle MCP tools) all landed DEV-VERIFIED with their gates discharged.
**The final gate (SM-24, tracker Â§6bu) found one dev-provable defect** â€” `main.ts`'s
`SEARCH_ADS_WRITE_MODE` boot-safety assertion was wired inside only the `SEARCH_PROVIDER_MODE=live`
branch, so `simulate`-data + `live`-ad-writes (a combination the design addendum itself calls
legitimate) booted silently and would only have failed at request time, after a one-shot approval
had already been spent â€” the department's signature fail-open shape, this time committed by the
orchestrator while completing the ruling that forbids it. **Fixed (Â§6bv), made test-executable by
SM-75's boot-wiring smoke test (Â§6bx), and independently re-verified by the gate itself** (own
negative-control re-nest reproducing the exact 2-of-5-red symptom, restore `sha256sum`-confirmed) â€”
see Â§6by for the re-verdict. A related infra fail-open was found and fixed in the same window:
`docker-compose.vps.yml` had no environment passthrough for the Google/Ads credentials or either
callback secret, so a real key would have had zero effect on the container (Â§6bw). Full
`src/modules/search` suite: **1061 passed / 4 skipped, zero reds**; `tsc` clean; full platform tree
**2552 passed / 4 skipped, zero FAIL markers** post-migration (head `0069`). Real-vendor-account
fidelity remains unproven by design (SM-41G, staging-only) and is not a condition of this status.

**State at 0.4.0 (2026-07-31, SM-23 reconcile).** Since 0.3.0: the bundled âš¡ gate (Â§6bc) PASSED
SM-54/SM-56/SM-59/SM-61/SM-25b (all LANDED); an echo-validation standing rule was adopted (Â§A14,
addendum A1.6/A1.7) and audited across all three vendor drivers (Â§6be); SM-30 (manual apply/export
twin) and SM-20 (search-terms sync, migration `0062`) are DEV-VERIFIED with their own âš¡ gates still
owed; SM-63 (collect-scope fix) LANDED; SM-64 (GSC/GA4 response-window enforcement) and
SM-66/67/69 (driver fail-open hardening) are DEV-VERIFIED, gates owed. **An orchestrator incident,
recovered:** SM-68/70 (the DataForSEO billing-identity fix) were DEV-VERIFIED with the tree fully
green (Â§6bj), then an orchestrator `git checkout` destroyed the uncommitted `providers/dataforseo.ts`
â€” also briefly reverting SM-56's already-LANDED `fetchSerpByTaskId` in the same file â€” and a rebuild
**recovered it in full** (tracker Â§6bk: `tsc` clean, `dataforseo.test.ts` 48/48, full tree 895/4
skipped zero reds, six sha256-verified mutation probes). SM-56 stays LANDED unaffected;
SM-67/68/69/70 still owe their âš¡/QA gates, now against the recovered code. SM-19's frontend
(dual-mode apply picker) is real, committed and wired but was never given a ticket-scoped
verification pass (tracker Â§6bl). None of this moves the module's overall status past
`IN PROGRESS` â€” real-vendor-account fidelity remains unproven and the SM-67/68/69/70/30/20/64/66
gates are still owed.

**State at 0.3.0 (2026-07-30, superseded above).** P0 and P1 are closed and gated. All three divisions are visible in the
`seo` console (Accounts / Optimize / Campaigns), and the department **demos end to end at $0 vendor spend**
via a deterministic simulation mode that flows through the real metered dispatch path.

**Built and gated since 0.2.0:** three vendor drivers behind one `SearchDataProvider` (DataForSEO, Semrush,
Ahrefs) with per-capability routing; simulation mode with provenance stamped in the database, not just the
UI; rank tracking, audit ingest, keyword clustering, AI drafts, backlinks and GEO/AI-visibility data paths;
the cost ledger surface; SEM planning objects plus a SEM console; and a vendor-envelope sandbox that runs
the real drivers over real sockets against fixture files, so the staging cutover is a fixture swap rather
than a rewrite.

**The money path is the most-scrutinised code in the module.** Five ordered stop-loss tiers
(engagement â†’ tenant â†’ provider â†’ global, plus a pillar kill switch), fail-closed at every gate, with an
`incurred` ledger status recording a vendor charge that delivered nothing so burned money cannot hide from
the ceilings. Nine gates found **seven** fail-opens here, every one of the same shape â€” a guard that looked
configured and enforced nothing: a `catch` degrading to `$0`, a shape pin anchoring a table name instead of
a structure, a count that only warned, a remedy that was inert, a config fix covering one variable of nine,
a filter that was correct but possibly unwired, and a compensating write that missed the post-success write
boundary. Each is now pinned by a mutation probe that fails when the guard is removed.

**Not yet DEV-VERIFIED, and precisely why:** no capability has ever run against a real vendor account
(OQ-9/OQ-10/OQ-11 â€” plan facts and a deposit are the owner's), so envelope fidelity, error inventories and
billing units are unproven; Search Console and GA4 are not built (SM-51/SM-25, no Google OAuth client); the
SEM apply path, reports and the platform-side scheduler are not built (SM-19/20/21/22/30, SM-54); and two
known bounded defects must land before any vendor is funded â€” a callback double-charge (SM-56) and a missing
provider predicate on reconciliation (SM-59), both with live repros. Running state + ticket ledger:
[`../blueprints/seo-sem-execution-tracker.md`](../blueprints/seo-sem-execution-tracker.md).

**Design (unchanged):** [`../blueprints/seo-sem-foundation.md`](../blueprints/seo-sem-foundation.md)
(research + locked cost model) and [`../blueprints/seo-sem-design.md`](../blueprints/seo-sem-design.md)
(v1.1 design, Â§00â€“Â§14). A platform-nest module vertical (key `search`, tables `search_*`, third-wall RLS)
+ a `SearchDataProvider` abstraction (DataForSEO Standard primary, Semrush premium) with a Postgres
market-data cache and a per-client cost ledger + budget stop-loss, plus a `seo` department console
(Web-Dev pattern, 3 craft groups). Self-hosted crawlers (SEONaut/open-seo-crawler/Unlighthouse) do
$0-API audit work; AI is local-Hermes-first via the gateway; live-site/live-spend actions are dual-mode
(manual export twin + WS4-gated API twin) and approval-gated. Cost ~$8â€“10/client/mo blended
(~Rp 20M/mo for 100 clients @ 22k).
**Owner-ratified 2026-07-23:** dept name SEO; dual-mode SEM; no-RLS shared cache; per-engagement tool-scope config.

**What exists (dev), superseding the paragraph below that used to sit here:** the paragraph that
follows described the 2026-07-27 P0-in-progress state (SM-04/05/06 "awaiting gate", "no crawlers",
"no console") and was left uncorrected through three landings â€” it is the exact "stale doc read as
current" failure mode this registry warns about. **Reconciled 2026-07-30 against code and the
tracker (SM-23):** P0 (SM-01â€¦06) and P1 (SM-07â€¦13, SM-29) are both **LANDED and gate-cleared**
(tracker Â§0/Â§1). `src/modules/search/` now has 20+ modules incl. real crawler ingestion
(`search-crawl-go/`, SM-07), keyword clustering + AI drafts (SM-09/10), the `seo` platform-ui
console (SM-11/12/29), and the notifications wiring (SM-13) â€” none of which existed when the
paragraph below was written. `lint:withtenants`'s `ledger.ts` allowlist entry (SM-04) was
**RATIFIED** at the P0 gate (tracker Â§4d), not left pending. Migrations through `0053`
(`search_provider_incurred_cost`), `0060` (`search_google_oauth_states`), `0061`
(`search_google_performance`, SM-25b) and `0062` (`search_search_terms`, SM-20) are applied
(corrected 2026-07-31, SM-23 â€” this paragraph previously stopped at `0060`); `0058`/`0059` are a
deliberate reservation for the `reports` module, not a gap (tracker Â§6ap). The platform-nest
migration chain as a whole runs one further, to `0063` (a PM ticket, not search) â€” do not read
`0062` as the platform-wide head.

**Known real gaps, current as of 2026-07-31 (tracker Â§0/Â§1, corrected by SM-23):** the two live
money-path defects noted at 0.3.0 â€” a callback double-charge (SM-56) and a missing `provider`
predicate on reconciliation (SM-59) â€” **cleared their bundled âš¡ gate and are LANDED** (tracker
Â§6bc; this paragraph previously said "gate owed," which was stale). SM-14's remainder and SM-17
still owe QA gates. GA4/GSC read paths are built (SM-25b LANDED, migration `0061`); Ads read (SM-25c)
is still TODO. SEM apply/report/scheduler: SM-30 (manual apply/export) and SM-20 (search-terms
sync) are DEV-VERIFIED, gates owed; SM-19 (dual-mode picker UI) has real committed frontend work
with no ticket-scoped verification (tracker Â§6bl); SM-21 (api-mode execute), SM-22 (reports) remain
TODO; SM-54's platform-side scheduler is **LANDED** (Â§6bc). A new hardening wave (SM-63/64/66-70)
closed an echo-validation gap across all three vendor drivers. **An orchestrator `git checkout`
accidentally destroyed the uncommitted `providers/dataforseo.ts` (SM-67/68/69/70's file, plus
SM-56's already-LANDED code in passing) â€” a rebuild RECOVERED it in full** (tracker Â§6bk: `tsc`
clean, `dataforseo.test.ts` 48/48, full tree 895/4 skipped zero reds, six sha256-verified mutation
probes). SM-56 unaffected/still LANDED; SM-67/68/69/70 still owe their âš¡/QA gates, now against the
recovered code. Real-vendor-account fidelity (billing units, error inventories) remains unproven â€”
no capability has run against a funded account (OQ-2/9/10/11).

**Running state + full ledger:**
[`../blueprints/seo-sem-execution-tracker.md`](../blueprints/seo-sem-execution-tracker.md) (Â§0 state
at a glance, Â§1 per-ticket ledger, Â§6bk for the recovery, Â§6bl for this reconcile).
**Next, updated 2026-07-31 (SM-23; supersedes the Â§6x.4 line below â€” the bundled gate it names has
since PASSED, SM-15 was retired, and SM-23 itself is executing this pass):** owed âš¡/QA gates in
some order (SM-67/68/69/70 against the now-recovered driver, SM-30, SM-20, SM-64, SM-66,
SM-14 remainder/SM-17/SM-47/SM-48/SM-49) â†’ a ticket-scoped verification pass for SM-19 â†’ SM-21 âš¡
(api-mode execute) â†’ SM-25c (Ads read) â†’ SM-26/SM-22 â†’ SM-24. Decision-gated extras stay parked:
Umami (OQ-5), Semrush premium connector (superseded permanently by the SM-34 HTTP driver, OQ-3 no
longer gates anything).

<details><summary>Superseded 2026-07-30 "Next" line (kept for history)</summary>

the bundled âš¡ QA gate (SM-54/56/59/61) â†’ SM-14 remainder/SM-17/SM-47/SM-48/SM-49 owed gates â†’
SM-15 âˆ¥ SM-16 â†’ SM-51/SM-30 â†’ SM-19/SM-20 â†’ SM-21 âš¡ â†’ SM-25a âš¡ â†’ SM-25b â†’ SM-25c â†’ SM-26/SM-22 â†’
SM-23 (this reconciliation) â†’ SM-24.

</details>

## social-media — SMM · Organic Publishing · `0.5.18` · IN PROGRESS

**0.5.18 (2026-08-23, medior) — SMM-27: best-time-to-post, a CLASSICAL STATS job + a suggestion
chip — the last unbuilt ticket in the department.** Worktree was ONE MERGE BEHIND at cut time
(`git log --oneline -1` did not match `main`'s tip — SMM-35's own merge had landed); `git merge
main` (fast-forward, clean) pulled `assistant-summary.ts`/`content-brief.ts` in before any of this
ticket's own code was written.

**Deliberately not an AI ticket — no gateway call, no model, no prompt.** New `best-time.ts`
computes a deterministic per-account verdict over SMM-21's own `social_post_variants.published_at`
+ `social_post_metrics` (append-only; the LATEST snapshot per variant is read, mirroring the
Analytics tab's own reasoning). A published variant whose latest snapshot has every interaction
field NULL is EXCLUDED from the sample entirely — "not yet measured," never "zero engagement,"
`metrics-job.ts`'s own "no invented numbers" rule applied to sample membership. Each measured post's
engagement score is the sum of whichever of likes/comments/shares/saves/clicks it does carry;
posts are bucketed by UTC hour of `published_at`, and the bucket with the highest average score
(among buckets meeting their own sample floor) is the suggestion.

**The clock: UTC, never a guessed local zone.** This module already shipped a real timezone bug at
exactly this seam (SMM-35's `assistant-summary.ts` header: a `date` column parsed at local midnight,
shifted a calendar day backward by a later `.toISOString()`). `published_at` here is `timestamptz`
(unambiguous), but EXTRACTING an hour-of-day still requires picking a zone, and no per-account
timezone column exists anywhere in this schema. Rather than fabricate one, every bucket is the UTC
hour, deterministic regardless of session/process timezone — the chip renders "14:00 UTC" verbatim,
never implying a client-local hour that was never computed.

**Insufficient evidence is a first-class state, config-thresholded, never a fabricated hour.**
`BestTimeStatus` is FOUR distinct facts (`capabilities.ts`'s own three-reasons discipline, extended
by one): `not_yet_computed` (the nightly sweep never ran for this account — what EVERY real
deployment reads today, D-23: no account is connected, no post has ever published anywhere in the
estate), `insufficient_evidence` (fewer measured posts than `config.social.bestTime.
minMeasuredPosts`, default **5** — a classical-stats rule-of-thumb floor on independent
observations, not a claimed significance level and not vendor guidance, documented in `config.ts`
itself — or the winning bucket alone did not reach `minBucketPosts`, default **2**, so one lucky
post cannot "win" an hour outright), `unsupported` (this account's resolved driver never advertises
`post_metrics` at all — a MORE PERMANENT fact than insufficient_evidence, checked via
`driver.capabilities` before ever querying `social_post_metrics`, the same "unsupported vs empty"
discipline `inbox-sync-job.ts` applies to `inbox_read`), and `suggested` (a real answer, carrying its
own `bestHourSampleSize`/`totalMeasuredPosts`). Every threshold rides the API response itself
(`minMeasuredPostsThreshold`/`minBucketPostsThreshold`), so the chip can quote "3 of 5 measured
posts needed" honestly rather than a bare "not enough data."

**The module GUC — closed, and regression-pinned two ways.** New `social_best_time_suggestions`
(THIRD RLS wall, same as every `social_*` table but `social_post_client_reviews`) is written by
`best-time.ts`'s `computeAccountBestTime`/`applyBestTimeSuggestion`, each self-declaring
`declareSocialModuleScope` before touching a row — exactly the shape `metrics-job.ts`/
`inbox-triage-job.ts` already use. `best-time.test.ts`'s (G1) proves the trap ITSELF: a plain
`withTenants([tenantId])` read with no module option sees ZERO ROWS on a table a seeded row plainly
exists in; (G2) proves `computeAccountBestTime`/`applyBestTimeSuggestion`/`getCachedBestTime` —
called exactly as written, no `{modules:['social']}` at any call site — write and read back a REAL,
correct `suggested` verdict from seeded data clearing every threshold, which fails outright (0
measured posts, not a differently-labelled empty result) if either internal declaration is ever
removed. This is the ticket's own named worst failure mode closed: without the declaration, a stats
job would read zero rows silently and still emit a definite, indistinguishable-from-honest
`insufficient_evidence` — a confident answer computed from nothing.

**New migration `202608221603_social_best_time_suggestions.sql`.** `social_best_time_suggestions`
(one row per account, UPSERTED — a current verdict, not a history, mirroring `social_metrics_daily`'s
own per-day cache reasoning), `sbt_status_shape` CHECK making exactly one of the three persisted
statuses (`suggested`/`insufficient_evidence`/`unsupported`) hold structurally (a `suggested` row
without its three supporting numbers, or a non-`suggested` row that leaked one, cannot be written).
THIRD RLS wall, FORCE RLS, self-asserted in the 0106/202608201519 idiom. `npm run
lint:migration-rls` — **green** (132 migrations scanned, 53 baselined, 79 enforced, no unguarded
FORCE-RLS backfill). `lint:migration-names`/`lint:withtenants` also green. Registered in
`socialModule.migrations` at write time.

**The scheduled sweep (`smm-best-time`), and the exact `main.ts` line.** New `best-time-job.ts`
mirrors `metrics-job.ts`/`inbox-triage-job.ts` verbatim: env-gated via `config.social.bestTime.
enabled` (dark by default), `withGlobal` for the tenant list then per-tenant recompute+upsert over
every connected account, per-tenant AND per-account errors caught and logged so one bad
account/tenant can never abort the sweep. `main.ts` was **not** edited (off-limits to this ticket) —
the exact lines for the orchestrator to add:
```ts
import { startBestTimePullLoop } from "./modules/social/best-time-job";
// ...
if (config.social.bestTime.enabled) {
  startBestTimePullLoop(config.social.bestTime.intervalMs);
  console.log(`social best-time-to-post (smm-best-time) on: every ${config.social.bestTime.intervalMs}ms`);
}
```

**New endpoints + MCP tool.** `GET accounts/:accountId/best-time` (read, reuses the existing
`social_account`/`read` Cerbos gate `metrics/daily`/`metrics/posts` already use — no new
permission) reads the cached verdict, answering `{status:'not_yet_computed'}` as DATA (never a 404)
when the sweep has never run; `POST accounts/:accountId/best-time/recompute` (same `read` gate — a
re-derivation of already-readable data, no blast radius of its own, so no D14/write classification)
lets a freshly-connected account get an answer without waiting up to a day for the next sweep tick.
New MCP tool `social.getBestTimeToPost` (read, `minAssurance:"low"`).

**The chip.** `socialShared.ts`'s `describeBestTime`/`formatBestHourUtc` render each of the four
states as itself (criterion-5 discipline, applied to a statistic instead of a refusal token) — never
a blank chip, never a bare number. `VariantCard.tsx`'s new `BestTimeChip`, wired into the Composer
(`composer/[postId]/page.tsx` fetches one `getBestTimeToPost` per DISTINCT account across a post's
variants, keyed on `accountId` — the suggestion is a property of the account's own posting history,
not the post). DEMO_MODE store (`demoSocial.ts`) pins the new `bestTime` array to the SAME
`globalThis`-pinned `SocialStore` every other mutable demo state already uses, seeded across THREE
accounts to drive three of the four states without any interaction (`soc-acc-ig-1` → `suggested`,
`soc-acc-fb-1` → `insufficient_evidence`, `soc-acc-tiktok-1` → `unsupported`; any unlisted account
reads the honest `not_yet_computed` default — `soc-acc-ig-2`/`soc-acc-ig-3` demonstrate it for free).

**Driven in a real browser** (`DEMO_MODE=1 npm run dev`, Playwright, headless Chromium, tenant
switched to `co-agency`, dept `dept-4`): `soc-post-2` (account `soc-acc-ig-1`) rendered *"Best time
to post: around 14:00 UTC, based on 3 of 5 measured posts."* in the positive color; `soc-post-4`
(account `soc-acc-fb-1`) rendered *"Not enough data yet: 2 of 5 measured posts needed before a best
time can be suggested."* in the caution color — **the insufficient-evidence state, the one every
real deployment carries today, confirmed rendering correctly and distinctly from the confident
state**; `soc-post-1` (account `soc-acc-ig-2`) rendered *"Best-time-to-post hasn't been computed yet
for this account."* in the muted color. The `unsupported` state (`soc-acc-tiktok-1`) was not reached
in the browser pass — no demo variant currently targets that account — and is instead proven by
`best-time.test.ts`'s (C1) against the mock driver; named rather than silently left unverified.
`next build` not run (this ticket's own "don't run it repeatedly" instruction); `tsc`/vitest are the
gate.

**Test counts.** `src/modules/social` (full suite, including the three D14 registry files):
**613 / 0 / 5** (37 files + 1 skipped file), measured directly on this worktree; +12 new, all in
`best-time.test.ts`, re-run ALONE twice (12/12 both times) ruling out the shared-test-Postgres
phantom-failure class this file names. `tsc --noEmit` clean on this ticket's own files (platform-nest
whole-repo typecheck returned zero errors; `src/rbac/role-permission-bundles.db.test.ts` is another
session's uncommitted mid-edit and is not present as broken in this worktree). `platform-ui`:
**2615 / 0 / 0** (155 files), measured directly; `socialShared.test.ts` (45/45) re-run alone,
unaffected by the new exports. `tsc --noEmit` clean for `platform-ui`.

**Anything the spec did not answer, named rather than silently decided:** (1) the `unsupported`
state has no demo-driven browser proof (see above) — a schema/fixture gap, not a code gap; (2)
`avgEngagementScore` sums raw interaction counts (likes+comments+shares+saves+clicks) rather than a
normalized engagement RATE (e.g. against impressions) — impressions are optional/absent on many
networks (`metrics-job.ts`'s own "partial reporting" note), so a rate would silently exclude posts a
raw sum can still rank; flagged as a reasonable classical-stats choice, not the only one; (3) no
"which day of week" dimension — only hour-of-day, per the ticket's own "best TIME to post" framing;
a day-of-week axis is a natural follow-up once real volume exists to support a second dimension
without starving both of sample size.

**0.5.17 (2026-08-22, medior) — SMM-35: the assistant's "social summary" read; no social write
reachable from chat this pass.** Worktree was current at `main`'s tip at cut time (`git log
--oneline -1` matched; `git merge main` fast-forwarded cleanly with only unrelated docs/infra
commits, none touching `src/modules/social/**` or `src/modules/assistant/**`).

**New `assistant-summary.ts` + `GET engagements/:engagementId/assistant-summary` + MCP tool
`social.getEngagementSummary`** (read, `minAssurance:"low"`, same Cerbos `read` action on
`social_engagement` that `listEngagements`/`getEngagementScope` already use — no new permission, no
Cerbos edit). One engagement's post-status counts, open/escalated inbox thread counts, each
connected+in-scope account's latest KNOWN follower reading, and its metered-usage snapshot against
all three D-9 stop-loss tiers. `capabilities.ts`'s panel picks this tool up **by construction** —
`visibleToolsFor(user) ∩ tenant's module gates` — no hand-registration needed there; verified by
reading that formula, not assumed.

**"An absent number is not zero," proven three ways, not just asserted.** Reuses `reports.ts`'s own
`sumKnown`/`latestKnown` (never a second copy) for the harder case that file's own header names: a
report shows a gap as an omitted row, but a CHAT ANSWER is prose, and prose silently degrades "never
fetched" into "zero" the instant a caller writes `metric ?? 0`. (1) A connected account with zero
`social_metrics_daily` rows ever reports `followers: null`, never `0`. (2) A row whose `followers`
column is itself `NULL` (the pull ran, that field wasn't in it) still reports `null` but flips
`metrics.everPulled: true` — distinct from "never pulled at all," so a brand-new engagement is never
told "0 followers everywhere" when the honest answer is "never looked." (3) `usage.tenant.capUsd`
rides `usage-ledger.ts`'s own already-correct `null`-when-unconfigured, unchanged. What this does
NOT extend to: `posts.byStatus`/`inbox.open`/`inbox.escalated` are counts of OUR OWN rows — a real
`0` engagement gets a real `0`, the same carve-out `reports.ts`'s header states.

**Accounts (and therefore inbox/metrics) are scoped to the engagement's OWN `tool_scope.networks`**,
mirroring `content-brief.ts`'s exact account-resolution rule — `social_accounts` belongs to the
CLIENT, not the engagement, so a client with two engagements (say, an evergreen one and a campaign
one) must not have one engagement's summary silently include the other's connected accounts just
because they share a client. Found live, by a test: an initial draft queried "every connected account
for this client" and a same-client, same-network second engagement's account leaked into the first
engagement's counts — fixed by re-deriving the SAME `networks[a.network] === true` filter
`content-brief.ts` already uses, rather than inventing a second scoping rule.

**A real node-postgres date-parsing bug, found and fixed before it shipped.** `social_metrics_daily.
date` (a SQL `date` column) defaults to node-postgres parsing it into a JS `Date` at LOCAL midnight;
a later `.toISOString()` on that value silently shifts the reported calendar day backward whenever
the running process's local timezone is behind UTC — caught by a live-PG test expecting "today" and
getting "yesterday." Fixed by casting to `date::text`/`to_char(...)` in SQL and never constructing a
JS `Date` from that column at all.

**Exactly which social writes are reachable from `/assistant`, and why: NONE, this pass — named as a
cross-repo gap, not improvised around.** The assistant broker (`platform-nest/src/modules/assistant/
broker.ts`) can only drive a chat turn through an agent BOTH it (`ASSISTANT_AGENT_TOOLS`/
`ASSISTANT_AGENT_WRITE_TOOLS`) and `ai-agents/src/specialists.ts` (a separate project, per this
repo's own "not a monorepo" rule, and never listed in this ticket's file surface) declare together.
`social.publishPost`/`social.sendReply` are excluded on SECURITY grounds regardless of file surface:
both `impact:"high"`, both already D14-registry executables for the automation/agent-origin suspend
path, and exposing either to chat would be a second, weaker route to a public, irreversible act — the
module's own standing invariant ("agents draft, never publish," SMM-26) forbids it outright.
`social.draftContentBrief` (`write:true,impact:"low"`, genuinely low-stakes — draft rows only) is
excluded for a DIFFERENT, structural reason: the assistant's own binding policy is that every write
it can propose becomes a D14 proposal (`task-filer`'s own header: "every assistant write becomes a
proposal, never a silent commit"), which means a hypothetical social write-agent would have to
declare the tool `high_write` (regardless of its genuinely-low hub tier — exactly the same honest
divergence `task-filer` already documents for `pm.createTask`) and clear D13's eval-provider
enrollment gate (a live run against the shared, weekly-rate-limited Ollama Cloud quota) before
`runWriteAgent` would ever let it execute past `forced_read_only`. That is real `ai-agents/**` work —
a new AgentDef, a `RERUN_CAPABLE_HIGH_WRITES`/`ASSISTANT_FACING_AGENTS` guard update, eval cases, and
an enrollment run — sized and scoped like the original ASST-23 design's own T2 ticket (`senior-be`,
its own dedicated wave). Reaching into that file surface unilaterally, spending shared eval quota
unilaterally, or declaring an impact tier unilaterally were all judged out of bounds for a
platform-nest-scoped ticket; recorded here as a named follow-up rather than silently built or
silently skipped.

**T3b's confirm/expiry/scrub machinery needs zero changes to carry a future social intent.**
`assistant_write_intents`/`confirmWriteIntent`/`dismissWriteIntent`/the lazy-reap-on-GET path
(`write-intents.ts`) are keyed generically by `tool_call_id`/`tool_name`/`agent` — nothing PM-specific
lives in that machinery. The day an `ai-agents` def declares a social `high_write` tool, the existing
confirm/dismiss endpoints, the 1-hour TTL, and the "expiry scrubs `tool_args` to NULL" lazy reap all
apply unchanged — verified by reading `write-intents.ts` and `assistant.controller.ts`'s confirm/
dismiss/GET-thread code, not assumed. This ticket touched none of `src/modules/assistant/**` because
none of it needed touching — no new agent name to mirror.

**Cross-client leak test, and exactly what it proves.** `assistant-summary.test.ts`'s dedicated test
seeds TWO engagements under DIFFERENT clients (same tenant) with distinctive post titles, inbox
thread counts, and follower readings, drives both summaries back to back against the SAME running
app, and asserts every count/account-id/follower-reading in one engagement's response is absent from
the other's, in both directions — proving the per-engagement `client_id`/`tool_scope.networks`
scoping this file adds holds under a live read, not merely under a single-tenant happy path.

Test counts: `src/modules/social` + the three `d14-smm-{09,17,22}-social-*-registry.test.ts` files —
**605 / 0 / 5**, this session's own directly-measured baseline for this exact set: **599 / 0 / 5**
(SMM-26's own previously-stated figure, reproduced by a fresh full run rather than trusted blind);
+6 new, all in `assistant-summary.test.ts`, also re-run ALONE (twice, across two fix iterations) —
6/6 green both times. `tsc --noEmit` clean on this session's own touched files (a separate,
pre-existing failure in `src/rbac/role-permission-bundles.db.test.ts` is another session's
mid-edit, untouched, and not this ticket's). No migration (no new table — every read is against
0105's existing tables); no Cerbos edit (the one authorize() call this ticket adds reuses an action
already granted). `src/modules/assistant/**` untouched. Full detail: `docs/plans/smm-tracker.md`'s
SMM-35 evidence block.

**0.5.16 (2026-08-22, senior-be) — SMM-26: the MCP agent surface audited and hardened, and the
`smm-agent-content-brief` flow built.** Worktree was ONE MERGE BEHIND at cut time (`git log --oneline
-1` did not match local `main`'s tip — SMM-22's own X-metering landing plus the AGN-7 hub commit had
merged); `git merge main` (fast-forward, clean) pulled `usage-ledger.ts`/`module-scope.ts` and the
SMM-22 metered-publish tool in before any of this ticket's own code was written.

**The audit came first: all 34 declared tools, walked one by one, for what an `assurance:"low"`
automation/agent principal actually gets.** `mcp-hub/src/policy.ts#authorize`'s impact gate —
`isUnattended(principal) && tool.write && tool.impact !== "low"` suspends into WS4 unless a verified
D14 grant already covers the call — is what decides this, not `minAssurance` (every one of the 34
tools is `minAssurance:"low"`, so that half of the gate never discriminates among them here).
**Verdict: the invariant already held, with no hole.** 12 reads execute unattended (nothing to
suspend). 15 writes are `impact:"low"` — every one persists a draft row, a knowledge pointer, or
mirrored connector-registry state, never a live-network act — and run unattended by design, matching
D14's own "low-impact writes run unattended" rule. 4 writes are `impact:"medium"`
(`setEngagementScope`, `requestClientReview`, `provisionPublisherOrg`, `deliverReport`) and correctly
suspend an unattended caller. The 2 real publish/send tools
(`social.publishPost`/`social.publishPostMetered`/`social.sendReply` — 3 tools, one shared
classification) are the pinned `write:true,impact:"high"` constant (`SOCIAL_PUBLISH_TOOL_CLASSIFICATION`,
spread everywhere, never retyped) and always suspend an unattended call, reachable in the ordinary
flow only through the D14 executor's own re-drive. No automation-allowlist entry in
`mcp-hub/src/automation-policy.ts` scopes any n8n workflow to a `social.*` tool at all today, so the
only unattended-caller SHAPE this surface meets in practice is an AGENT acting for a human
(`principal.agent` set, `isUnattended` true via that path, not `isAutomation`) — the exact shape D14's
own 2026-08-20 fix (`agent-attribution-gate`) closed. **Nothing was reclassified**; the full
per-tool table is in `docs/plans/smm-tracker.md`'s SMM-26 evidence block.

**The `smm-agent-content-brief` flow: "brief in, drafts out, nothing published," built in
`platform-nest`, not n8n.** New `content-brief.ts` composes SMM-19's own idea-drafting
(`draftPostIdeas`) and caption-drafting (`draftPostVariantCaption`) paths into ONE call: N idea posts
(`source='agent'`, an honest attribution distinct from `draftPostIdeas`'s own `source='ai'` — 0105's
`social_posts.source` CHECK has admitted `'agent'` since SMM-01 and it had sat unused until this
ticket) — count defaults to the engagement's OWN `tool_scope.posting.cadencePerWeek`, never an
invented number — each with one caption-drafted variant per connected account whose network the
engagement has enabled. Every write is a draft row; the tool (`social.draftContentBrief`,
`write:true,impact:"low"`) can never dispatch, publish or send. Idempotent per (idea, account): a
retry finds an existing variant for that pairing and skips both the gateway call and the write,
proven by driving it twice and asserting a second gateway caption call never fires. Never a silent
$0: an unpriced X pairing is skipped and counted (`variantsSkipped.unpriced_network`), matching
`createVariant`'s own discipline. A self-imposed `config.social.contentBrief.maxVariantsPerCall`
(default 20) bounds one call's own gateway-call volume — an N-ideas × M-accounts request has no
natural ceiling otherwise — never a claimed vendor limit.

**Deliberately NOT built: the v1.0 design's "weekly per opted-in engagement" scheduled sweep.**
`smm-design.md` §10 named this flow as an n8n-scheduled "WS8 agent goal" (image generation dropped by
the addendum, D-17); three precedents in this SAME module (SMM-15/16/17's `inbox-sync-job.ts`/
`inbox-triage-job.ts`) already established that despite the v1.0 design table's own framing, this
module's periodic sweeps live in `platform-nest` as scheduled loops, not n8n workflows — followed
here too. But a genuinely scheduled, PRINCIPAL-LESS sweep cannot legitimately call WS8's own
per-principal-scoped `/search` (`knowledge-client.ts`'s own header: the tenant pre-filter needs a
resolvable caller identity) without either shipping permanently-ungrounded drafts or borrowing a
human's identity dishonestly (breaking the `actor_id NULL` honesty precedent SMM-16's own webhook
fix set). Named as a follow-up requiring an architect decision on an automation service identity for
RAG-grounded scheduled jobs generally — not improvised here. What ships instead is the ON-DEMAND,
principal-driven MCP tool/HTTP endpoint (`POST engagements/:engagementId/agent-content-brief`), which
gets FULL RAG grounding via the caller's own OBO userId, exactly like every other AI-drafting
endpoint in this module.

**THE CROSS-CLIENT LEAK TEST, and what it proves.** Unlike SMM-19's single-item `draftPostVariantCaption`,
this flow drafts MULTIPLE ideas × accounts in ONE call — the new risk is a batching bug that lets one
iteration's grounding facts leak into another's prompt. `content-brief.test.ts` seeds two DIFFERENT
clients under the SAME tenant with distinctive corpus markers, runs the flow for BOTH back to back
against one shared mocked gateway/knowledge transcript, and asserts every prompt containing one
client's marker never contains the other's, in both directions, across the WHOLE transcript (idea
AND caption prompts alike) — proving both that SMM-19's existing per-call WS8 scope isolation holds
through this new composite, and that this file's own per-idea/per-variant loop never accumulates a
shared prompt or a shared knowledge-hit list across iterations.

No migration (0105's `social_posts.source` CHECK already admitted `'agent'`; no new table). `main.ts`
— nothing to hand over; no new scheduled loop, no new module registration (same "no line to apply"
shape SMM-22 reported). `mcp-hub` gap found but not fixed (read-only file surface): none — the
existing impact-gate mechanism was already sufficient; reported as a gap only if this audit found a
hole, which it did not.

Test counts: **599 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `d14-smm-17-social-reply-registry.test.ts` + `d14-smm-22-social-metered-publish-registry.test.ts`
(directly measured baseline for this exact set, by stashing: **591 / 0 / 5** — SMM-22's own landed
figure, reproduced; +8 new, all in the new `content-brief.test.ts`, also re-run ALONE afterward — 8/8
green both times, ruling out the shared-test-Postgres phantom-failure class this program names). `tsc
--noEmit` clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/`lint:postiz-deps` all
green (no migration — still 130 files). `test:iam-chain-alignment` **25/25** (no Cerbos policy or
catalog change — every permission/action this ticket's new endpoint uses already existed and is
already catalogued). `platform-ui` untouched (off-limits file surface; no UI change this pass). Full
detail: `docs/plans/smm-tracker.md`'s SMM-26 evidence block.

**0.5.15 (2026-08-22, senior-be) — SMM-22: X metering live — the money path, held back deliberately
all session.** Worktree started 6 commits behind `main` (missing SMM-17's own landing entirely);
`git merge main` (fast-forward, clean) pulled it in before any of this ticket's own code was written.

**The barred twin made real, without unbarring anything by default.** `social.publishPostMetered`
gets a genuine dispatch endpoint (`POST variants/:variantId/publish-metered`, backed by the SAME
`dispatch.ts#dispatchApprovedPublish` the free tool uses, `toolName` threaded through — one
implementation, not two) and a declared `McpToolDef`. `core/approval-executables.ts`'s bar on it is
UNCHANGED by default (`config.social.usage.meteredPublishEnabled` defaults `false`). A new primitive,
`liftBarredExecutable`, is the ONLY way the bar moves, called from exactly one config-gated site
(`registerSocialMeteredExecutableApprovalIfEnabled`) that THROWS AT BOOT if the flag is on while X's
per-post price is unconfigured — an auto-executing money tool with no price is the exact failure
this ticket exists to prevent. `cerbos/policies/resource_mcp_tool.yaml` deliberately left untouched
(named as a follow-up for whoever first turns the flag on for real).

**The D-9 stop-loss chain's tenant + global tiers, proven at BOTH checkpoints — not one.** The
precondition (`publish-precondition.ts`'s budget stage) now evaluates engagement → tenant → global
via one new pure function (`usage-ledger.ts#evaluateUsageBudget`), reused by `dispatch.ts`'s own
reservation — a per-ENGAGEMENT advisory-lock choke-point (`SOCIAL_USAGE_LEDGER_LOCK_NS`, a new
namespace) that re-sums all three tiers ONE LAST TIME and inserts the `posted` ledger row atomically,
before any network call. Proven airtight two ways: a deterministic sequential-reservation test
(`usage-ledger.test.ts`) and a REAL concurrent `Promise.all` race between two dispatches on one
engagement (`dispatch.test.ts`'s (M5), re-run 5× with no flake) — exactly one succeeds, never both.
**A real defect found and fixed before shipping:** the first version applied the tenant/global tiers
to EVERY publish including $0 ones, which would have let one tenant's X overspend freeze every OTHER
tenant's free posting platform-wide. Fixed to gate the two new tiers on an actually-metered network
only; a $0 post's only budget exposure remains the pre-existing, unchanged, engagement-scoped
circuit breaker SMM-09 already shipped.

**X's per-post price is a config fact, never a literal.**
`config.social.usage.xPerPostCostUsd`/`xPerPostWithLinkCostUsd` (`moneyEnv`, no default — design
§05's own figures are explicitly "re-verify at build time"). `media-rules.ts#estimateCostUsd`'s
contract changed from a bare `number` to `{ok:true,costUsd}|{ok:false,reason:"x_price_not_configured"}`
— an absent price now REFUSES everywhere it is consulted (precondition, reservation, every
composer/approval-card read), never a silent $0. The global cap has design §05's own documented
default ($100/mo, `numericEnv`); the tenant cap is optional, unset-skips-tier, mirroring `search`'s
own convention.

**The ledger's own lifecycle.** `dispatch.ts` inserts `posted` at the reservation; a synchronous
dispatch failure releases it (`markUsageLedgerFailed`, cost → 0) before this file even returns.
`post-status-sync-job.ts`'s EXISTING reconcile (`applyPostStatuses`) is extended to true a metered
row up to `completed` (published) or `failed` (cost → 0, for `failed`/`cancelled`) in the SAME
transaction as the variant's own authoritative status flip — X's price is flat, so true-up moves
status only, never an amount.

**The approval card + usage panel.** `GET .../publish-preconditions` now returns
`estimatedCostUsd`/`costUnavailableReason` (computed fresh, `null` only for an unpriced X variant),
rendered by `VariantCard.tsx`'s existing "Check now" preview. New `GET engagements/:id/usage`
(`social.ledger.read`, already 0106-forward-seeded) backs a new `UsagePanel.tsx` on the Analytics tab
— **NOT browser-driven this pass**, unit/type-checked + a DEMO_MODE fixture only, named as a real gap.

No migration (0105's ledger + budget column already anticipated this). `main.ts` — nothing to hand
over; no new scheduled loop, no new module registration, the first SMM ticket in this program with a
genuine "no line to apply" answer.

Test counts: **591 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `d14-smm-17-social-reply-registry.test.ts` + the new `d14-smm-22-social-metered-publish-registry.test.ts`
(directly measured baseline for this exact set: 552, +39 new — exact arithmetic, cross-checked by two
independent clean runs). `tsc --noEmit` clean both sides. All four migration/withTenants linters
green (still 130 migrations; the new cross-tenant global sum needed no lint-withtenants allowlist
entry — implemented as a per-tenant fan-out instead, the lint's own documented preferred
alternative). `test:iam-chain-alignment` green (25/25, unaffected — `social.ledger.read` was already
catalogued from SMM-30's forward-seeding). `platform-ui`: **2592 / 0 / 0**, full suite, twice. Full
detail: `docs/plans/smm-tracker.md`'s SMM-22 evidence block.

**0.5.14 (2026-08-21, senior-be) — SMM-17: the inbox reply flow, draft → WS4 → send, its own D14
registry entry built by REUSING SMM-09's pattern rather than reinventing it.** Worktree started nine
seats behind (`git log --oneline -1` did not match `main`'s tip — SMM-15/16 plus an unrelated
monitoring ticket had landed); `git merge main` (fast-forward, clean) pulled `inbox-sync-job.ts`,
`inbox-triage-job.ts` and the `202608211200_social_inbox_triage.sql` migration in before any of this
ticket's own code was written.

**No migration.** 0105's own `social_inbox_messages` schema — `direction`/`status`
(`draft|in_review|approved|sent|failed`)/`approval_id`/`args_sha256`/`external_id`, the
`sim_sent_reply_has_approval` CHECK and the partial `ux_social_inbox_messages_approval` unique index —
already anticipated this exact flow ("outbound replies are one-shot-gated exactly like publishes",
0105's own header). The one new dial, `tool_scope.inbox.reply`, is additive jsonb.

**The registry entry, reused not reinvented.** New `reply-precondition.ts` mirrors
`publish-precondition.ts` structurally: `SOCIAL_REPLY_TOOL = "social.sendReply"`,
`SOCIAL_REPLY_TOOL_CLASSIFICATION = {...SOCIAL_PUBLISH_TOOL_CLASSIFICATION}` (spread, never retyped),
its own `REPLY_REFUSAL` vocabulary (10 tokens, kept apart from `PUBLISH_REFUSAL`), a four-stage chain
(`scope → hash → unconsumed → retention`, replacing publish's `quota`/`budget`/`creator_info` with the
one stage a text reply actually needs), and `replyLockKey` (the messageId). New `reply-dispatch.ts`
mirrors `dispatch.ts`'s two-phase shape (lock + precondition re-run, network call outside any
transaction, ONE guarded UPDATE stamping `approval_id`+`external_id`+`status='sent'` together).
`core/approval-executables.ts`'s new SMM-17 section registers `social.sendReply` with
**`neverAutoRetry: true`**, independently re-derived: a reply's landed-or-not is unobservable in the
ambiguous window (`hub_unreachable`/`tool_error`), the exact property that makes publish opt out too.
`cerbos/policies/resource_mcp_tool.yaml`'s executable-tool list gets `social.sendReply` alongside
`social.publishPost` (D14-13's both-halves-move-together doctrine; no metered twin, since D-14's
money split is publish-specific).

**Retention — this ticket's own named design question, answered.** A draft reply that quotes/embeds
the comment it answers is subject to LinkedIn's SAME 48h activity-content cap, and free text cannot
be reliably inspected for a quote — so the answer mirrors D-22's TikTok doctrine: FAIL CLOSED ON
UNKNOWN. The `retention` stage refuses `source_content_purged` the instant the THREAD's
`activity_content_purged_at` is set, regardless of whether the reply's own text happens to quote
anything, reusing the EXISTING column SMM-36's purger maintains — no new column, no second job.

**A real, pre-existing defect found and fixed in SMM-36's purger, not introduced by this ticket.**
`inbox-retention-job.ts`'s two per-message purge UPDATEs matched ANY message row past the age
threshold with no `direction` filter — correct while every row was inbound, wrong the instant an
outbound reply row exists on the same table (our own authored text is not a member's social-activity
content LinkedIn's cap is about, and wiping an ALREADY-SENT reply would destroy our own historical
record). Fixed with `m.direction = 'in'` on both UPDATEs; proven with a 60h-old outbound 'sent' reply
surviving untouched alongside a same-age inbound message that purges normally.

**Endpoints + Cerbos split.** Six new routes under `/api/:tenantId/modules/social/threads/:threadId/
messages*` (create draft, edit, approve, dry-run preconditions, send, list) + five new MCP tools.
Matches `resource_social_inbox.yaml`'s (SMM-30) own documented split verbatim: drafting/editing/
approving rides `assign` ("a draft is a row in our DB... never [the reply] action"), sending rides
`reply` — and BOTH `social_staff` and `social_manager` hold both, unlike publish's manager-only tier
(the inbox is the agency's working surface). Proven end to end over real HTTP with a staff persona
completing the full draft→edit→approve→send loop against the mock driver (D-23: no live LinkedIn
credential exists).

Test counts: **559 / 0 / 5** across the SMM-16 baseline's own four-file set (**522 / 0 / 5**; +37 new,
exact arithmetic, cross-checked by two independent clean runs). Baseline was ATTEMPTED via a live
`git stash -u` (it was NOT refused this time, unlike SMM-16's own experience) but the stashed-tree
re-run hit a phantom failure unrelated to this ticket's code (`publisher/provisioning.test.ts`'s
`buildApp()` failed in `beforeAll` on the UNMODIFIED tree) — read as the shared-test-Postgres/
loaded-machine phantom-failure class this program names by name, not a real regression; the stash was
popped back immediately rather than re-fought, and SMM-16's own previously-measured baseline is used
instead, corroborated by the exact +37 arithmetic. `tsc --noEmit` clean; all four migration/withTenants
linters green (no migration — still 129 files). Full detail: `docs/plans/smm-tracker.md`'s P2 row.

**0.5.13 (2026-08-21, SMM-16, medior) — AI triage over SMM-15's inbox rows: sentiment/category/
urgency classification, spike detection, SLA guard flows.** Worktree started behind (`git log
--oneline -1` did not match `main`'s tip — SMM-15's own merge plus a monitoring ticket had landed);
`git merge main` (fast-forward, clean) pulled `inbox-sync-job.ts` and the
`202608211136_social_inbox_message_source_provenance.sql` follow-up in before any of this ticket's
own code was written, per this program's own repeated cross-session-hazard note.

**Migration `202608211200_social_inbox_triage.sql`.** Adds `category`/`urgency`/`ai_triage_status`/
`ai_triage_at`/`sla_alerted_at` to `social_inbox_threads`. The 0105-shipped `sentiment` column is
REUSED, not replaced — its `'urgent'` enum value is left in the CHECK (a live column value is
history, same as the provenance migration's `'postiz_sync'`) but this ticket never writes it going
forward, since urgency is now its own independent axis.

**Classification schema — the three(+one)-fact model, never a nullable column that conflates "never
asked" with "asked, got nothing usable".** `ai_triage_status` is `unclassified` (never attempted) |
`unavailable` (attempted; gateway unreachable/unconfigured/unparsable — NEVER a guessed value) |
`classified` (a real model answer) | `purged` (was classified, then scrubbed on the retention
clock — see below). `sit_triage_shape` (a structural CHECK, the 0106/0113 idiom) makes exactly one
of those four shapes hold at all times: an `unclassified`/`unavailable`/`purged` row cannot carry a
sentiment/category/urgency value, and a `classified` row cannot lack one. **An unclassified thread
differs from a neutral one exactly there**: `sentiment='neutral', ai_triage_status='classified'` is
the model's real answer; `sentiment=NULL, ai_triage_status='unclassified'` is "nobody has looked
yet" — two different facts a single nullable column could never distinguish, mirroring
`publisher/capabilities.ts`'s own three-reasons discipline (`network`/`driver`/`unverified`) applied
to a classification instead of a capability.

**A classification is a guess, never laundered into a fact.** `ai-drafts.ts`'s new
`buildTriagePrompt`/`parseTriageDraft` are the ONE place unlike every other `parse*` in that file
with NO deterministic fallback value: a malformed/out-of-vocabulary/absent response returns
`result: null`, and the caller (`inbox-triage-job.ts#classifyOneThread`) writes `unavailable`, never
a guessed `'neutral'`/`'other'`/`'low'` sitting in the same column a real answer would occupy.

**THE CROSS-CLIENT LEAK TEST, and exactly what it proves.** Unlike SMM-19/SMM-23, this surface has
NO WS8 knowledge-retrieval step to be a second leak boundary — the only safety property is "one
gateway call gets one thread's own messages, never two threads' (and so, potentially, two clients')
text in the same prompt". `inbox-triage-job.test.ts`'s (T1)/(T1b) seed two threads under two
DIFFERENT clients in the SAME tenant, each with a distinctive marker string in its own comment text,
classify both in the SAME sweep, and assert every gateway prompt containing one client's marker
NEVER contains the other's — proving the sweep never batches two threads into one prompt and never
crosses a client boundary within one tenant, in both directions.

**Spike detection — config, not a constant, and why.** No account is connected and app reviews are
deferred to staging (D-23), so there is no real traffic to derive a measured baseline from.
`config.social.triage.slaGuard.{spikeWindowMinutes,spikeBaselineWindows,spikeMultiplier,
spikeMinRecentCount}` are self-imposed operational defaults (60min window, 24-window/24h trailing
baseline, 3x multiplier, a 5-message absolute floor to stop a near-zero baseline from making one
ordinary comment read as a spike) — every value's rationale is written in `config.ts` itself,
explicitly disclaiming any measured or vendor-claimed meaning. `runTenantSpikeDetection` recomputes
per sweep with no persistent dedup — a named, stated limitation (a sustained spike re-fires every
tick), not silently solved, given there is no live traffic to validate a dedup window against yet.

**SLA guard — `0105`'s existing `sla_due_at` + `ix_social_inbox_threads_sla`, never an invented
number.** `social_engagements.tool_scope.inbox.slaMinutes` (0105's own example shape) is the ONLY
source of an SLA target: `refreshThreadSla` sets `sla_due_at = last_message_at + slaMinutes` for
every OPEN thread whose engagement configured it, and leaves `sla_due_at` NULL — no fallback
invented — for an engagement that never set it, or a thread with no linked post to resolve an
engagement from at all. `findAndMarkSlaBreaches` then uses 0105's own SLA index to find threads past
their due date, notifies once per breach (`sla_alerted_at` dedup, re-arming when `sla_due_at` moves
forward again), and rides the ALREADY-DRAINED `"social_post_variant"` stream (SMM-31's own
precedent) rather than a new one, so no `main.ts` change was needed for event delivery — only for
starting the two scheduled loops (see below).

**The retention question, answered rather than left open.** A sentiment/category/urgency label is
distilled from the SAME comment text LinkedIn's 48h activity-content cap governs. Decision: YES, it
inherits that cap, on the SAME clock (`activity_content_purged_at`), not a second one that could
drift from it. `sit_activity_purge_scrubs_triage` (a structural CHECK) makes a purged row
structurally unable to hold a live `classified` state; `inbox-retention-job.ts`'s EXISTING purge
step (SMM-36's seam) was extended — never a second job — to null `sentiment`/`category`/`urgency`
and flip `ai_triage_status` `'classified' → 'purged'` in the SAME UPDATE that already scrubs the
excerpt.

**Two new event handlers**, `event-handlers.ts`: `social.inbox.sla_breached` (bell + mail, risk-
shaped — a customer-visible thread missed its own configured window) and
`social.inbox.spike_detected` (bell only — no measured baseline exists yet to justify escalating to
a risk-warning email). Both registered in `index.ts`'s `eventHandlers` map.

**Two scheduled loops, dark by default, `main.ts` NOT edited (off-limits to this ticket) — exact
lines for the orchestrator to apply:**
```ts
import { startInboxTriageLoop } from "./modules/social/inbox-triage-job";
import { startInboxSlaGuardLoop } from "./modules/social/inbox-triage-job";
// ...
if (config.social.triage.classifyEnabled) {
  startInboxTriageLoop(config.social.triage.classifyIntervalMs);
  console.log(`social inbox triage (smm-inbox-triage) on: every ${config.social.triage.classifyIntervalMs}ms`);
}
if (config.social.triage.slaGuard.guardEnabled) {
  startInboxSlaGuardLoop(config.social.triage.slaGuard.guardIntervalMs);
  console.log(`social inbox SLA guard (smm-inbox-sla-guard) on: every ${config.social.triage.slaGuard.guardIntervalMs}ms`);
}
```

**Anything the spec did not answer, named rather than silently decided:** (1) urgency classification
is informational only and never shrinks/extends `sla_due_at` — doing so would mean inventing an
"urgent posts get N% less time" threshold this ticket has no data to justify; (2) a thread with no
`post_variant_id` (a DM/mention not tied to a post) cannot resolve an engagement and so gets neither
an SLA target nor a notification path — counted `unnotifiable`, never silently dropped, and left as
a gap for SMM-17/18; (3) spike detection has no persistent dedup (see above); (4) spike-detection's
notification resolves an account's engagement by "most recently created active engagement for that
client", a documented simplification for accounts whose client has more than one engagement.

Test counts, full evidence, and lint status: see the SMM-16 evidence block in
`docs/plans/smm-tracker.md`.

**0.5.12 (2026-08-21, SMM-15, medior) — `pullInbox`: the first P2 inbox ticket lands, unblocked by
SMM-38c's `pullComments` on the `direct` LinkedIn driver.** Worktree was already at the SMM-38e
closing-pass merge commit at cut time (`git log --oneline -1` = the 38e closing-pass commit;
`git merge-base --is-ancestor HEAD main` confirmed it) — no merge was needed, stated rather than
assumed, per this program's own repeated cross-session-hazard note. `publisher/linkedin-client.ts`,
`publisher/direct.ts`'s `NETWORK_CAPABILITIES`, and `retention-policy.ts` were all present and
current.

**New file, `inbox-sync-job.ts`, one exported job (`pullTenantInbox`/`runInboxPull`/
`startInboxPullLoop`), the `smm-inbox-pull` scheduled flow.** No migration: 0105's own
`social_inbox_threads`/`social_inbox_messages` tables and their 0113 retention columns already carry
the shape this sync needs.

**Per-post, never per-account — the constraint 38c named.** `listComments(org, integrationId, since)`
is called once per published `social_post_variants` row that carries a `provider_post_id`
(`integrationId` = that post's own provider id, a LinkedIn share URN or YouTube video id — never a
connected account's integration id), because neither network exposes an account-wide comment feed.
The cursor is per (account, post): the existing thread's `last_message_at` when one exists, else the
post's own `published_at` (no comment can predate its post, and no new column is needed). Idempotency
rides 0105's own two unique keys — `UNIQUE(account_id, external_thread_id)` for the thread,
`UNIQUE(thread_id, external_id) WHERE external_id IS NOT NULL` for each message — `ON CONFLICT ...
DO UPDATE`/`DO NOTHING` respectively, proven by running the same pull twice and asserting one thread,
zero duplicate messages (`inbox-sync-job.test.ts`'s (T2)).

**Quota-aware from the start, never an invented number.** Neither network's Standard-tier rate limit
is published anywhere reachable without a live Developer Portal session (D-23); this file invents
nothing about what LinkedIn/YouTube will tolerate. It bounds only its OWN call volume:
`config.social.inboxPull.maxPostsPerAccountPerRun` (default 20) caps how many posts ONE sweep asks
about per account, newest-published first — a SELF-IMPOSED safety valve, named as such in `config.ts`
and proven in (T6), never confused with a vendor ceiling.

**Unsupported vs empty — the ticket's own named distinction, and the caller this port needed.**
`resolvePublisherForCapability` does not itself check whether the DEFAULT (no-override) resolved
driver advertises `inbox_read` — that check belongs to the caller, per `listComments`'s own "absent
capability member ⇒ nothing to check" contract. `pullTenantInbox` is that caller: it checks
`driver.capabilities.has("inbox_read") && typeof driver.listComments === "function"` before ever
calling, and counts a failing check as `unsupported` (Postiz, every network today, spike §8b) —
distinct from `posts` examined with zero new rows (a real, empty result). (T4)/(T4b) prove the two
are never conflated. A `capability_unsupported` thrown one layer up by
`registry.ts#resolvePublisherForCapability`'s own eager, data-driven refusal (a misconfigured
override) is counted the same honest way.

**Retention: rows land where SMM-36's existing purge can already reach them — no purge-side
change.** `upsertInboxItems` writes the SAME two tables and SAME columns
`inbox-retention-job.ts#purgeInboxRetention` already scrubs generically for any
`hasDocumentedRetentionCap` network (LinkedIn's 24h/48h today). One real interaction respected: 0113's
own state-law CHECKs (`sit_profile_purge_scrubs_author`, `sit_activity_purge_scrubs_excerpt`) forbid
writing a fresh `excerpt`/`author_handle` onto a THREAD whose purge marker is already set — the
upsert's `ON CONFLICT` clause guards both columns with a `CASE WHEN ... purged_at IS NULL` so it
never violates that CHECK. Individual MESSAGE rows carry no such guard: each is a brand-new row with
its own fresh `created_at`, so a new comment always starts its own 48h/24h clock — proven in (T7)
against a thread seeded already-purged by hand.

**The module GUC — `upsertInboxItems` self-declares (recurring defect class #1).** Pinned by (T1):
called on a caller-side transaction with NO `{modules:['social']}` option, asserting a real thread +
message row exists afterward — fails with "threadsWritten: 0" if `declareSocialModuleScope` is ever
removed, the exact "0 new comments, looks perfectly healthy" shape the ticket named.

**A locally-scoped test driver, not `mock-driver.ts`.** That file is read-only to this ticket and its
own `listComments` stub always returns `[]` regardless of args, with no per-post-configurable state —
`inbox-sync-job.test.ts` builds its own small `SocialPublisher` shape, scoped to the file, avoiding
this module's own recurring defect class #7 (a shared, stateful module-level mock polluting a later
assertion).

**Config additions only — `config.ts`'s `social.inboxPull` block** (`pullEnabled`/`pullIntervalMs`/
`lookbackDays`/`maxPostsPerAccountPerRun`), dark by default like every other sweep in this module.
`main.ts` was NOT edited (off-limits to this ticket) — the exact line to add is reported to the
orchestrator: `if (config.social.inboxPull.pullEnabled) { startInboxPullLoop(config.social.inboxPull.pullIntervalMs); }`
alongside the existing `inboxRetention`/`reconcileEnabled` gates.

Test counts: **502 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** in this worktree by
stashing this ticket's changes: **494 / 0 / 5**, matching the 38e closing pass's own stated figure
exactly; +8 new, all in the new `inbox-sync-job.test.ts`). The new/changed test file was also re-run
ALONE afterward (8/8 green) to rule out the shared-test-Postgres phantom-failure class this program
warns about. `tsc --noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/
`lint:migration-names` all green (no migration this ticket — 127 migrations, unchanged).
`test:iam-chain-alignment` not re-run (no Cerbos/IAM change this ticket — no MCP tool declared; the
job is a process-level scheduled sweep, the same shape `metrics-job.ts`/`inbox-retention-job.ts`
already use with no tool of their own).

**Anything the spec did not answer, named rather than silently decided:** (1) SMM-16/17/18 (triage,
reply, inbox UI) are unbuilt — this ticket writes rows a human cannot yet see in any UI; (2) the
`source` column's CHECK on `social_inbox_messages` only admits `'postiz_sync'`/`'reply'` — every
inbound sync, `direct`-routed or not, is written as `'postiz_sync'` because that is the only inbound
value the CHECK admits (not a schema gap needing a migration, just a slightly Postiz-named token this
ticket does not own); (3) whether a thread should ever transition OUT of a terminal status
(`dismissed`/`closed`) when fresh comments arrive is left to SMM-16/17/18 — this sync never touches
`status` on conflict, deliberately, so it cannot silently reopen a thread a human closed on purpose.

**0.5.11 (2026-08-21, SMM-33/24 gap-closing pass, senior-be) — the two agentic-exit-bar gaps the
SMM-33 capability inventory named plainly, closed rather than merely documented.** Worktree was cut
6 commits behind `main` (missing `docs/modules/social-capability-inventory.md`, `client-review.ts`,
`publisher/youtube-client.ts` entirely) — `git merge main` (clean fast-forward, no divergent commits)
pulled everything in before any of this pass's own code was written, per this program's own
repeated cross-session hazard note.

**Gap 1 — the entire client-review capability group had zero MCP tool coverage — CLOSED.** Three
new tools declared on `socialModule.mcpTools` (`modules/social/index.ts`), one per staff endpoint
already live on `social.controller.ts` (SMM-31): `social.requestClientReview` (`POST
variants/:variantId/client-review`), `social.getClientReview` (`GET` the same path),
`social.withdrawClientReview` (`POST .../client-review/withdraw`) — each fronting the SAME
`authorize()` call its endpoint already runs (`social_client_review` kind, `request`/`read`/
`withdraw` actions), nothing loosened. Impact classes chosen individually, not copy-pasted from
`setEngagementScope`/`publishPost`: `request` is `write:true, impact:'medium'` — the FIRST moment a
variant becomes visible to an external party outside the tenant (`handleClientReviewRequested`
notifies the client's portal contacts), the same "outward-facing" ground `deliverReport`/
`provisionPublisherOrg` already use for 'medium', so an automation/agent principal is suspended into
WS4 rather than allowed to put draft content in front of a client unsupervised (neither tool is
registered in `approval-executables.ts` — same precedent as `setEngagementScope`/
`provisionPublisherOrg`/`deliverReport`, all 'medium' with no executable entry, so a suspended call
simply stays suspended for a human to act on directly rather than auto-re-driving). `withdraw` is
also `write:true` (never a read — the spec's own warning) but `impact:'low'`: purely corrective,
never notifies the client (`social.client_review.withdrawn` rides the drained stream but has no
registered handler, unlike `.requested`/`.decided` — a real, separate gap named but NOT fixed this
pass, out of file surface), and only retracts exposure that already happened — the same "blast
radius is a stale row, not a post" ground `syncConnectorRegistry` already uses for 'low'. `read`
carries no `write`/`impact` pair at all, matching every other plain read tool on this contract.

**The portal decide stays undeclared, confirmed, not just repeated.** `social-client-review-
portal.controller.ts`'s `decide` action is a `portal.*` Cerbos action (`approve_post`), never a
`social.*` one — no portal capability is ever an MCP tool in this program, because the client's
decision is a human act on the trust boundary, made in a browser session authenticated AS that
client, never something any agent (staff-side or client-side) is ever the caller of. Regression-
pinned in `social.test.ts`: no declared tool name contains "decide", and no `pathTemplate` contains
`/portal/`.

**Gap 2 — the post-status webhook wrote no `work_activity` row — CLOSED, at the shared root, not
just the named function.** `applyPostStatuses` (`post-status-sync-job.ts`) is the ONE place
`social_post_variants.status` ever becomes `'published'`/`'failed'` from the network's OWN
authoritative answer (`dispatch.ts` only ever writes `'dispatched'`/`'failed'` for an IMMEDIATE,
synchronous outcome, or leaves the row for this function to resolve later) — and it is the shared
function BOTH `reconcileOneProviderPost` (the webhook intake, the inventory's own named gap) and
`reconcileTenantPostStatus` (the safety poll) call, so the fix lands once, closing the gap for both
paths rather than patching only the one named. `actorId` is `null`, honestly — the ONLY correct
answer: `postStatusWebhook` doesn't even take a `@Req()`, so there is no principal on that path at
all, and the safety poll has no request context either. This is the SAME convention
`pm.controller.ts`'s `auto_promoted` rows already use for a system-derived state change nobody's own
action caused directly (`activities.actor_id`'s own column comment: "NULL = system/service") — never
the account's connect actor, the composer's last editor, or any other human who merely last touched
the row, which the spec named explicitly as the wrong move. The verb is the network's own vocabulary
(`'published'`/`'failed'`) and the metadata is the SAME facts already carried on the sibling
`emitEvent` call, never a second independently-worded copy. `writeActivity` runs AFTER the update
transaction commits (collected into a `pendingActivity` array during the loop, written once outside
`withTenants`) — the same non-nested sequencing `dispatch.ts`/`pm.controller.ts` already use, not a
second connection held open inside the first for no atomicity gain those callers don't already
accept. No module-GUC exposure introduced: `activities` is a CORE table with no third wall, so
`declareSocialModuleScope` is correctly absent from this new code path.

**Regression tests, driven RED first, not merely asserted.** `post-status-sync-job.test.ts`'s (T1)/
(T2)/(T3)/(T5) gained a `activityRows()` helper reading the `activities` table back for real and new
assertions on top of each existing case (0 new `it()`s — assertions added to the SAME cases that
already carry this file's own module-GUC regression note, per this program's preference for fewer,
denser tests over proliferation): (T1)/(T2) assert exactly one row with the correct verb and
`actor_id IS NULL`; (T3) asserts the redelivered second call adds no second row; (T5) — the webhook
path itself, the exact gap named — asserts the same through `reconcileOneProviderPost`. Verified RED
by temporarily commenting out the `writeActivity` call and re-running: all four assertions failed
exactly as predicted (`expected [] to have a length of 1`), then restored. `social.test.ts`'s
existing registration test gained assertions for all three new tools' `write`/`impact`/`method`/
`pathTemplate` shapes plus the portal-decide-absence checks above.

Test counts: **483 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** in this worktree
by stashing this pass's changes: **483 / 0 / 5** — unchanged, because this pass added assertions to
EXISTING `it()` blocks rather than new ones; one suite, `dispatch.test.ts`, failed on the baseline run
with `tuple concurrently updated` — reproduced as the shared-test-Postgres phantom failure this file
warns about, confirmed by re-running it alone (16/16 green), not counted as a real baseline failure).
`tsc --noEmit` clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/`lint:postiz-deps`
all green (no migration, no new withTenants call needing review — the one new DB touch,
`writeActivity`, is a pre-existing core helper, not a raw `withTenants` call this pass introduced).
No Cerbos policy change (no new executable, so `resource_mcp_tool.yaml`'s grant-lift list is
correctly untouched — request/withdraw are 'medium'/'low' respectively with no `approval-
executables.ts` entry, the same shape `setEngagementScope`/`syncConnectorRegistry` already have);
`test:iam-chain-alignment` unaffected (25/25, not re-run this pass — no IAM/Cerbos change).

**Anything the spec did not answer, named rather than silently decided:** `social.client_review.
withdrawn`'s event has no registered handler in `event-handlers.ts`'s routing table (unlike
`.requested`/`.decided`) — found while reasoning about `withdraw`'s impact class (it's WHY withdraw
never notifies the client, which is part of why it is classified 'low' rather than 'medium'), but
`event-handlers.ts` is outside this pass's file surface and the gap is cosmetic today (nothing
currently depends on a withdrawal notification existing), so it is named here for a future pass
rather than fixed unilaterally.
**0.5.11 (2026-08-21, senior-be) — SMM-38e closing pass: the two gaps 38e's own evidence reported to
the architect rather than deciding, both closed.** Worktree was UP TO DATE with `main` at cut time
(`git log -1` = `d59c730`; `git merge-base --is-ancestor HEAD main` confirmed it) — no merge was
needed, per this file's own "verify first" instruction.

**The upload-terminal gap — CLOSED with a driver-declared property `dispatch.ts` consults, not a
special case buried in a conditional.** New optional `SocialPublisher.isUploadTerminalFor(network)`
(`types.ts`): a driver declares, per network, that its `uploadMedia` IS the publish (no distinct
"reference an already-uploaded asset from a later post" step exists). `direct.ts` declares this `true`
for YouTube ONLY (a `videos.insert` call creates the live video resource directly), `false`/absent for
every other network including LinkedIn (whose `media_upload` genuinely registers an asset for a LATER
`schedulePost` call). Chose the declared-property shape over a documented no-op `schedulePost` for
YouTube: a no-op `schedulePost` would still require `dispatch.ts` to resolve a SECOND
(network, capability) pair, spend a second OTel span, and — if `schedule` were ever misconfigured to a
driver YouTube doesn't cover — reach a refusal AFTER the network already carries a live video; the
declared property lets `dispatch.ts` skip the schedule step ENTIRELY, so the single-transaction stamp
(`approval_id` + `provider_post_id`, SMM-10) is fed straight from the upload's own returned id.
`dispatch.ts#dispatchApprovedPublish` checks it right after `resolveEngineMedia` returns (only when
media was actually uploaded — a text-only variant never asks) and, when true, stamps
`{providerPostId: engineMedia[last].id}` without ever calling `resolveDispatchOrgHandle(..., "schedule")`
or `schedulePost` — proven live in `dispatch.test.ts`'s new (E1)–(E3): (E1) `youtube:media_upload=direct`
alone dispatches successfully, `schedulePost` reached on NEITHER driver, `provider_post_id` is the
upload's own id verbatim; (E2) ALSO setting `youtube:schedule=direct` changes nothing — the
terminal check short-circuits before `schedule` is ever resolved; (E3) `youtube:schedule=direct`
WITHOUT a `media_upload` override still refuses (see the override-safety gap below), proving the two
fixes compose rather than silently relying on each other.

**The override-safety gap — CLOSED with a driver-declared coverage map the resolver refuses against,
never a hand-maintained deny-list.** New optional `SocialPublisher.coversNetworkCapability(network,
capability)` (`types.ts`): a driver declares which (network, capability) pairs it ACTUALLY serves — a
per-network refinement of the existing driver-wide `capabilities` Set, backed on `direct.ts` by ONE new
map (`NETWORK_CAPABILITIES`) that is the single source of truth both for this new port member AND for
the pre-existing in-method runtime gates (`refuseNetworkNotCovered`) — never two lists that could
drift. LinkedIn: `schedule`/`media_upload`/`inbox_read` (not `quota_probe` — unpublished rate limits).
YouTube: `media_upload`/`inbox_read`/`quota_probe` (not `schedule` — see the upload-terminal gap
above). `registry.ts#resolvePublisherForCapability` consults it AFTER the existing "is this driver
name registered" check and BEFORE returning: an override naming a REGISTERED driver that does not
cover the resolved (network, capability) pair now refuses EAGERLY with a typed `capability_unsupported`
— at the earliest point the switch is ever consulted, never after a network call already happened.
Absent method (Postiz, the mock) ⇒ no per-network restriction at all, matching their real, flat shape
— proven inert for every existing deployment by `publisher.test.ts`'s full switch suite (rewritten
where it exercised a (network, capability) pair `direct` does not actually cover — `linkedin:*`
applied to `quota_probe`, `*:schedule` applied to `youtube` — both now assert the EAGER refusal instead
of a silent resolve that would have failed later; the two properties genuinely being tested,
network-wildcard/capability-wildcard PRECEDENCE, were re-pointed at `media_upload`, which both networks
cover, so they still prove precedence rather than accidentally proving coverage). A brand-new test
proves the inverse: a driver with no `coversNetworkCapability` at all is never refused, even for a
(network, capability) pair nothing models.

**A stale comment corrected at the source, not left to mislead the next reader** (this codebase's own
recurring defect class §4b): `provisioning.ts#resolveDispatchOrgHandle`'s own header and `direct.ts`'s
file header both used to name YouTube's `media_upload` flip as unsafe and excluded in principle — both
corrected in place to point at the fix, rather than left standing next to code that now contradicts
them.

**The no-config default stays INERT — proven, not merely claimed.** No default value was added to
`config.social.publisher.capabilityDrivers`. `resolvePublisher`'s `publisher_not_configured` signal
(`anyNonDirectRegistered`) is untouched. `unknown_publisher` for an override naming an unregistered
driver is untouched (checked BEFORE the new coverage check, so it still fires first). Both new port
members are OPTIONAL, so no existing driver (Postiz, the mock) needed a single line changed.

**Capability inventory updated** (`docs/modules/social-capability-inventory.md`'s "Driver per
capability" section): `youtube:media_upload`/`inbox_read`/`quota_probe` move from "principle-only, two
independent reasons" to "principle-safe, credential-gated only, same as LinkedIn"; `youtube:schedule`
gets its own row naming the eager resolver refusal. The recommended override for a
credential-cleared deployment now includes YouTube's three real capabilities.

Test counts: **494 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** in this worktree by
stashing this pass's changes: **483 / 0 / 5**, matching `main`'s own stated 38e figure exactly; +11 new:
`dispatch.test.ts` +3 [(E1)–(E3)], `direct.test.ts` +7 [4 `coversNetworkCapability` cases, 3
`isUploadTerminalFor` cases], `publisher.test.ts` +1 [the absent-method-means-no-restriction case; two
existing cases were REWRITTEN in place, not counted as new, to keep testing wildcard precedence rather
than a coverage pair that no longer silently resolves]). The full `src/modules/social` suite (27 files)
re-run ALONE, and each of the three touched test files re-run alone individually, to rule out the
shared-test-Postgres phantom-failure class this program names — all green (one real regression WAS
found and fixed this way, not shipped: a new `direct.test.ts` case reused the shared module-level
`unreachableFetch` mock with a non-empty approval id, polluting an EARLIER-DECLARED test's own
zero-calls assertion the moment the new describe block landed ahead of it in file order — fixed with a
locally-scoped stub in the new case, never touching the pre-existing test). `tsc --noEmit` clean.
`lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` all green (still 127
migrations — no migration this pass). `test:iam-chain-alignment` green (25/25, unaffected — no
Cerbos/IAM change).

**What this pass did NOT decide:** whether a future third network with a similarly split
upload/schedule shape should widen `listComments`'s own id-namespace heuristic to a real `network`
parameter (38d's own named follow-up, untouched); whether the recommended-override doc string itself
should become a config preset rather than prose (out of this pass's file surface — `config.ts` gained
no new keys, only consumers of the existing `capabilityDrivers` map). Full detail:
`docs/plans/smm-tracker.md`'s 38e row.

**0.5.10 (2026-08-21, SMM-38 phase 38e, senior-integrator) — the flip: closing the three gaps 38c/38d
named, Gap 1's live wiring, and the capability inventory's driver-per-capability rows.** Worktree was
BEHIND main (`5ff9e6f` — the 38c merge commit) at cut time; `git merge main` (clean fast-forward)
pulled 38d in before any of this pass's own code was written.

**Gap 1 — the crux of the phase — CLOSED with a new resolver, not a widened `openOrg`.** New
`provisioning.ts#resolveDispatchOrgHandle(tenantId, chain, capability)`: consults
`registry.ts#resolvePublisherForCapability` and, when it resolves to anything but `direct`, builds
the IDENTICAL Postiz-shaped `OrgHandle` `openOrg` always built; when it resolves to `direct`, resolves
the account's OAuth grant for REAL through `oauth-tokens.ts#resolveActiveAccessToken` (fail-closed on
revoked/expired/missing) and builds the `direct`-shaped handle (`.secret()` = the bearer token,
`.orgId` = `config.social.direct.linkedin.organizationUrn` for LinkedIn — an existing 38c config
constant, sufficient because `direct`-routed LinkedIn connects are already own-brand-only via OQ-3;
unused for YouTube). `openOrg` itself is UNCHANGED — widening it would have re-defined a contract
every Postiz caller already depends on, for the benefit of one driver; a considered decision, not an
oversight. `dispatch.ts#dispatchApprovedPublish` now calls this resolver TWICE, once for
`media_upload` (only when the variant carries attachments) and once for `schedule` — proven live, not
merely asserted: `dispatch.test.ts`'s new (D1)–(D4) drive a REAL `social_oauth_tokens` row through a
REAL `resolveActiveAccessToken` call and a SECOND registered driver (key `"direct"`) actually
receiving the resolved token, including per-CAPABILITY routing (D3: only `media_upload` overridden,
`schedule` still reaches the org's own driver) and fail-closed behaviour on a revoked grant (D4: the
approval is still consumed, `dispatch_error` carries `oauth_token_revoked`, never a crash).

**A gap FOUND while wiring Gap 1, fixed at its source, not worked around.**
`linkedin-oauth.ts#completeLinkedInConnect`/`youtube-oauth.ts#completeYouTubeConnect` (38c/38d)
promoted an account to `connected` without ever setting `postiz_integration_id` — and
`provisioning.ts#assertDispatchChain`'s generic `account_not_connected` gate refuses ANY account
whose `postiz_integration_id` is NULL, regardless of driver. Fixed with a self-describing, non-NULL
sentinel (`'direct:linkedin'` / `'direct:youtube'`) — never a real Postiz-issued id (which never
contains a `:`) — rather than relaxing the generic gate. Regression-pinned in both oauth test files.

**Gap 2 — YouTube's `uploadMedia` metadata channel — CLOSED.** `SocialPublisher.uploadMedia`'s `file`
parameter gains two OPTIONAL fields, `title`/`description` (`types.ts`) — additive, on the SAME bag
`network` was added to in 38d, so `postiz`/mock/LinkedIn simply ignore what they don't use.
`dispatch.ts#resolveEngineMedia` (the one call site) derives both from the variant's own `body` for a
YouTube-network upload (`youtubeUploadMetadata`, new): the body's first line becomes `title`
(truncated to 100 chars, YouTube's commonly-documented limit, ⚠UNVERIFIED, a defensive cap either
way), the full trimmed body becomes `description`. `direct.ts`'s YouTube branch prefers a real
supplied title, falling back to the filename ONLY when none was sent (or it was blank/whitespace) —
never silently overriding a real one. Pinned in `direct.test.ts` (a real title/description sent
verbatim; a blank one still falls back).

**Gap 3 — the YouTube quota counter's durability — CLOSED with an injectable store, not a hard
rewrite.** New `YouTubeQuotaStore` interface (`youtube-quota.ts`): `defaultYouTubeQuotaStore()` wraps
the ORIGINAL 38d module-level functions byte-for-byte (every existing test, including
`resetYouTubeQuotaUsage()`'s own seam, is UNCHANGED — proven by re-running the untouched
`youtube-quota.test.ts` cases verbatim); `createDbYouTubeQuotaStore()` is the new durable
implementation, backed by a NEW GLOBAL table (`social_youtube_quota_usage`, migration
`202608210411_social_youtube_quota_usage.sql`) — no `tenant_id`, no RLS, the SAME D-4 reasoning
`social_platform_apps` already uses (the 100-upload/day cap is a per-Google-Cloud-PROJECT fact, shared
across every tenant's every channel, never per-tenant). `record()` is a single atomic
`INSERT...ON CONFLICT DO UPDATE SET col = col + EXCLUDED.col` — proven under REAL concurrency (10
parallel increments summing to exactly 10, not less) rather than merely asserted from the SQL text.
`direct.ts`'s `DirectDriverOptions` gains `quotaStore?: YouTubeQuotaStore` (default: the in-memory
wrapper — every test in this module keeps its exact 38d behaviour); `boot.ts` wires the DB-backed one
for the real app.

**The flip's config shape — the default stays INERT, proven by re-running the baseline suite
unchanged.** No default value was added to `config.social.publisher.capabilityDrivers` — it ships
exactly as empty as 38a/38b/38c/38d left it. `resolvePublisher`'s `publisher_not_configured` signal
(`anyNonDirectRegistered`) is untouched and unregressed (no new test needed — every existing
`publisher.test.ts` case still passes verbatim). The RECOMMENDED override for a deployment that has
cleared LinkedIn's credential gate (D-23, staging) is
`linkedin:schedule=direct,linkedin:media_upload=direct,linkedin:inbox_read=direct` — deliberately
EXCLUDING any `youtube:*` key: see the capability inventory's new "Driver per capability" section and
this ticket's own report for why YouTube's flip carries a SECOND, independent gap beyond the
credential one (the dispatch state machine has no representation for a network whose publish
terminates at `uploadMedia`, and `dispatch.ts` unconditionally calls `schedulePost` after any upload
for every network today) — reported as an open architecture question, not silently wired around or
silently ignored.

**Capability inventory (SMM-33's deliverable, §PD's own exit criterion for this phase) updated.**
`docs/modules/social-capability-inventory.md`'s new "Driver per capability" section records, for
every (network, capability) pair this wave built something for, which driver serves it today, which
COULD serve it if flipped, and exactly what stands between "could" and "does" — naming the credential
gap (D-23) and YouTube's dispatch-flow gap as two INDEPENDENT reasons, not one collapsed "not live
yet" sentence.

**2026-08-21 (senior-uiux) — the AGPL §13 source-offer, tracked as an open item with no ticket
number since SMM-24's docs pass (2026-08-20), CLOSED.** Postiz (this module's publishing engine)
is AGPL-3.0; §13 requires offering its Corresponding Source to whoever's network interaction it
relays — the STAFF working this console's Calendar/Composer/Inbox/Analytics tabs, not a client (the
client portal never talks to Postiz). New `platform-ui/src/components/social/SourceOfferNotice.tsx`,
rendered from `departments/[deptId]/layout.tsx` gated on `toolkitFor(dept.name).slug ===
"social-media"` — the SAME resolved value the layout already uses for the tab strip, so the notice
survives whatever id/name the org structure assigns and reaches every tab this department has
(including the structurally different full-bleed `DeptShellFrame` branch Calendar uses). **Rejected
the prior seat's own recommendation** of a console-wide footer on `platform-ui/src/app/(app)/layout.tsx`
— that shell wraps every staff page, most of which never call Postiz, and a licence notice in front
of people it has nothing to do with is a second kind of wrong, not a safer one. Copy never names a
version or says "unmodified" (a claim D-21's still-unapplied fork exception would make silently
false); it promises "the source for exactly what we run" and links the upstream repo today — the
component's own header comment states plainly that only the LINK TARGET must move when D-21 lands,
to a publicly reachable fork/mirror, since this console's own staff may not hold private-repo
access. Driven in a real browser (`DEMO_MODE=1`, headless Chromium): present with a resolving link
on the Social Media department's Home/Calendar/Composer tabs, absent on Web Dev. `tsc --noEmit`
clean; `platform-ui` suite unchanged (2444/0/0 with and without the change, measured directly).
Full evidence: `docs/plans/smm-tracker.md`'s "open items" table.

Test counts: **483 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline measured directly in this worktree by
stashing this pass's changes: **470 / 0 / 5**, matching `main`'s own stated baseline exactly — +13:
`dispatch.test.ts` +4 [(D1)–(D4)], `direct.test.ts` +3 [metadata + injectable store], `youtube-quota.test.ts`
+6 [store-seam unit case + 5 durable-store DB cases]; `linkedin-oauth.test.ts`/`youtube-oauth.test.ts`
gained ASSERTIONS on an existing case each, not new `it()`s, so they add 0 to the count while still
pinning the `postiz_integration_id` fix). The full changed/new-file set re-run ALONE afterward
(6 files, 117/117) to rule out the shared-test-Postgres phantom-failure class this program names —
green. `tsc --noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/
`lint:migration-names` all green (127 migrations scanned, 128 files on disk — one non-`.sql` file in
the directory is excluded by the linter's own glob, unrelated to this pass). `test:iam-chain-alignment`
green (25/25, unaffected — no Cerbos/IAM change this phase).

**What SMM-15 (P2 inbox sync, still unbuilt) must build against what this phase leaves:** everything
38c/38d already named for it (LinkedIn/YouTube's `listComments` keyed by `providerPostId`, not an
account integration id) is unchanged; this phase adds nothing new for SMM-15 to react to, since
neither `inbox_read` capability was flipped in the shipped default.

**What the architect must decide, named rather than guessed:** the dispatch-state-machine question
for a network whose publish terminates at `uploadMedia` (YouTube) rather than a separate `schedulePost`
step — see `provisioning.ts#resolveDispatchOrgHandle`'s own header and the capability inventory's new
section for the full reasoning. Until that is decided, `youtube:media_upload` must not be set to
`direct` in `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` on any deployment, credentialed or not.

**0.5.9 (2026-08-21, SMM-38 phase 38d, senior-integrator) — YouTube on the `direct` driver.**
Worktree was already at the 38c merge commit at start (`git log -1` = `5ff9e6f merge: SMM-38c
LinkedIn on the direct driver`; `git merge-base --is-ancestor HEAD main` confirmed HEAD was an
ancestor of `main`, i.e. up to date) — **no merge needed**, so `oauth-tokens.ts`, `linkedin-*` and
the 202608201518 migration were all present from the start.

**The `uploadMedia` collision, resolved as instructed.** The port's `uploadMedia(org, file)` gained
a third parameter, `network: Network` (`types.ts`) — a driver serving two networks with genuinely
different upload protocols (LinkedIn's asset-registration dance vs. YouTube's resumable protocol)
cannot tell them apart from `file.contentType` alone, since both accept the same image/video content
types. Every implementation updated: `postiz.ts` (accepts and ignores it — one generic multipart
endpoint regardless of network), `mock-driver.ts` (accepts it, records `state.lastUploadNetwork` for
test assertions), `direct.ts` (branches: LinkedIn → 38c's existing asset flow; YouTube → the new
resumable upload; anything else → `capability_unsupported`), `publisher-contract.ts` (passes
`integration.network` through). **The one call site**, `dispatch.ts#resolveEngineMedia` — the
variant's `network` (already that function's own parameter) is now cast to `VariantDispatch["network"]`
and threaded through, mirroring the identical cast the SAME function's `schedulePost` request already
uses a few lines below. Nothing else in `dispatch.ts` was touched.

**Google OAuth.** New `publisher/youtube-client.ts` (the wire client: token exchange/refresh against
`oauth2.googleapis.com`, the resumable-upload protocol against `www.googleapis.com/upload/youtube/v3/videos`,
`commentThreads.list` against the Data API) — deliberately does **NOT** reuse
`core/google-oauth/token-endpoint-client.ts`: that file is hard-wired to `config.google.*` (search's
own, separate Google Cloud app; dossier §8's own app-mapping table lists "Gaiada YouTube" as its own
row). New `publisher/youtube-oauth.ts` (mirrors `linkedin-oauth.ts` closely — same HMAC-signed,
time-boxed state scheme, `STATE_PREFIX="yts1"` vs LinkedIn's `"lis1"` so a token minted for one
network can never verify against the other's parser despite sharing the same domain-separated key;
`checkYouTubeConnectReadiness`/`startYouTubeConnect`/`completeYouTubeConnect`/
`registerYouTubeTokenRefresher()`). New `youtube-oauth.controller.ts` (`YouTubeOAuthController`
tenant-scoped start/readiness + `YouTubeOAuthCallbackController` tenant-agnostic fixed path, mirroring
`LinkedInOAuthCallbackController`'s three-point defence exactly). Scopes requested: EXACTLY
`youtube.upload` + `youtube.force-ssl` (dossier §6.2 (a)/(b)) — never the broad `youtube` manage
scope, never analytics, never anything DM-shaped (none exists). `app.module.ts` registers both new
controllers.

**Resumable upload IS YouTube's publish call in this driver — `schedulePost` deliberately stays
UNIMPLEMENTED for YouTube.** A `videos.insert` call creates the video resource directly; there is no
separate "reference an already-uploaded asset from a later post" step the way LinkedIn's flow works.
`DIRECT_CAPABILITIES` gains `quota_probe` (driver-wide); `schedule` stays LinkedIn-only. Metadata sent
on `uploadMedia` is deliberately MINIMAL — `title` from `file.filename`, `privacyStatus: "private"` —
since the port's own signature carries no title/description field and widening it further than the
one `network` parameter this collision required was not this ticket's call to make unilaterally;
named as a follow-up for whoever wires this to a live dispatch path (38e).

**Quota accounting against SMM-37's three real buckets (`QuotaSnapshot.youtubeQuota`,
`media-rules.ts`), not a live probe.** New `publisher/youtube-quota.ts`: the caps (100
`search.list`/day, 100 `videos.insert`/day, 10,000 units/day for everything else) are CITED CONSTANTS
from the dossier's own §6.4 quote of Google's docs — not the same "never synthesize a cap" failure
class `types.ts`'s warning names, because that warning is about Instagram's per-account, genuinely
variable, LIVE-probeable cap, and YouTube's cap is neither variable nor probeable (no such endpoint
exists in the Data API; the dossier names none). The `used` count is this PROCESS's own accounting —
an in-memory, per-UTC-day `Map`, incremented ONLY after a call this driver observed succeed (never
speculatively) — because nobody but the caller can know it: Google exposes no "remaining quota" read.
Named limitation, not silently accepted: in-memory means the counter resets on restart and does not
share state across instances; nothing on a live path increments it today (the same "verified inert"
property 38b's refresh-ahead registry and 38c's OAuth state shipped with), so building a durable,
cross-instance counter for a capability nothing can reach live yet was left as 38e's decision, not
made unilaterally.

**`pullComments` via `commentThreads.list` (`youtube.force-ssl`).** `direct.ts#listComments` now
branches WITHOUT a port-level `network` parameter (that widening was not asked for on this method):
a LinkedIn share URN is always `urn:li:...`-shaped by LinkedIn's OWN wire format, so
`integrationId.startsWith("urn:li:")` is a real, principled tell distinguishing it from a YouTube
video id — not the same class of guess `uploadMedia`'s old `file.contentType` branch would have been
(no such tell exists there). Named as a deliberate, narrower alternative to widening a second port
method; a real `network` parameter on `listComments` is left to the architect/38e/SMM-15 if a future
network's ids collide with this heuristic (none among 0105's admitted networks do today).

**No DM, modelled — not discovered new.** `capabilities.ts`'s YouTube row already carried `dm: false,
reasons: { dm: "network" }` from SMM-05's own research pass (§A4g) — the three-reasons model
(`network`/`driver`/`unverified`) this ticket was asked to apply was already correctly applied before
this phase touched the file. Verified directly (read the row), not re-decided.

**The UNVERIFIED forced-private-lock claim, marked as such, never treated as fact.** The dossier's
own §6.3 community report (uploads from unaudited API clients silently forced private) is
UNVERIFIED and not restated in current first-party docs — `youtube-client.ts`'s
`initiateResumableUpload` requests `privacyStatus: "private"` explicitly as the SAFE default that
happens to match the reported lock, not as a workaround for a fact this pass confirmed.

**A missing credential** refuses `platform_app_not_registered` (SMM-07's existing token, reused
verbatim via `checkYouTubeConnectReadiness`, gated on BOTH `hasRegisteredPlatformApp('youtube')` and
`hasYouTubeAppCredentials()`) — identical shape to LinkedIn's own gate.

**`resolvePublisher`'s `publisher_not_configured` signal still holds** — unaffected by this phase;
`boot.ts` registers `direct` + both refreshers unconditionally, still behaviourally inert on every
live path for the same three reasons 38c's header names (unrevisited this phase).

**No migration.** Reuses 0105's `social_accounts` (CHECK constraint already admits `'youtube'`) and
the already-merged `social_oauth_tokens` table byte-for-byte, exactly as 38c did for LinkedIn.

Test counts: **470 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline measured directly in this worktree
before any change: **420 / 0 / 5** — the ticket brief's stated "425/0/0" did not match what this
worktree actually had, measured rather than trusted, per this file's own repeated instruction; +50
new: `youtube-client.test.ts` 16, `youtube-quota.test.ts` 6, `youtube-oauth.test.ts` 14,
`direct.test.ts` +14 [YouTube upload/quota/listComments cases + a second YouTube-shaped contract-suite
run + updated capability-set/uploadMedia-signature assertions]). Both the full run and the
new/changed files re-run ALONE afterward (8 files, 163/163) to rule out the shared-test-Postgres
phantom-failure class this tracker names — all green both times. `tsc --noEmit` clean.
`lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` all green (no
migration this phase). `test:iam-chain-alignment` green (25/25, unaffected — no Cerbos/IAM change).

**Anything the spec did not answer, named rather than guessed:** (1) YouTube's OAuth exchange uses
NO PKCE (a confidential client with `client_secret`, matching `linkedin-client.ts`'s own shape,
"Follow that shape" being the ticket's own instruction) — `core/google-oauth`'s PKCE use is for a
DIFFERENT client type, not a contradiction; (2) `uploadMedia`'s metadata is minimal (filename-derived
title, no description, hardcoded `private`) because the port carries no field for real video
metadata — a future pass wiring a live dispatch path needs to decide whether that travels through a
widened `uploadMedia` signature or a different seam; (3) the quota day-boundary is UTC, not
verified against Google's own actual reset instant (⚠UNVERIFIED, named in `youtube-quota.ts`'s own
header); (4) `listComments`'s URN-prefix branch is a deliberate, narrower alternative to widening
that port method's signature — left as a follow-up, not a final answer; (5) whether
`status.publishAt` native scheduling exists is UNVERIFIED per the dossier and irrelevant to this
phase's scope (`schedulePost` is not implemented for YouTube at all).

**0.5.8 (2026-08-21, SMM-38 phase 38c, senior-integrator) — LinkedIn on the `direct` driver.**
This worktree was cut before 38b + several other tickets (SMM-21/23/20, SMM-33/24 docs,
`202608201518_social_oauth_tokens.sql`) landed on `main` — fast-forward `git merge main` pulled
them in before any of this ticket's own code was written (the tracker's own repeated
worktree-cut-before-commit hazard, hit directly).

Built: `publisher/linkedin-client.ts` (new — the LinkedIn wire client: token exchange/refresh,
org-page publish via `POST /rest/posts`, the 3-step asset upload dance
[`registerImageUpload`→`uploadImageBytes`], comment read via
`GET /rest/socialActions/{shareUrn}/comments`; every route ⚠UNVERIFIED against a live app — D-23,
no credential exists — reasoned from the app-review dossier §4, collected in ONE routes table
mirroring `postiz.ts`'s own discipline). `publisher/linkedin-oauth.ts` (new — the OAuth grant flow:
HMAC-signed, time-boxed state (`client-invites.ts`'s pattern, reused, deliberately NOT DB-backed —
named simplification in the file's own header), `startLinkedInConnect`/`completeLinkedInConnect`
[reuses `loadOrgByClient`/`hasRegisteredPlatformApp` from `provisioning.ts` read-only; ends by
calling `storeOAuthGrant` and promoting the pending `social_accounts` row to `connected`],
`registerLinkedInTokenRefresher()`). `linkedin-oauth.controller.ts` (new) — `LinkedInOAuthController`
(tenant-scoped start/readiness, reusing the existing `social_account`/`connect` Cerbos action — no
new policy) + `LinkedInOAuthCallbackController` (tenant-agnostic fixed path, mirrors
`SearchGoogleOauthCallbackController`'s exact three-point defence). `direct.ts` — `DIRECT_CAPABILITIES`
now `["schedule","media_upload","inbox_read"]` (LinkedIn only; every other network still refuses
`capability_unsupported` from INSIDE the method body — the same driver-wide-capability +
per-network-gate shape `postiz.ts` already uses for `getQuota`/`getCreatorInfo`, generalised).
`registry.ts` — fixed `resolvePublisher`'s empty-registry heuristic (`anyNonDirectRegistered`, not
`publishers.size===0`) so registering `direct` at boot cannot flip a Postiz-unconfigured
deployment's `publisher_not_configured` into `unknown_publisher`. `boot.ts` — registers `direct` +
the LinkedIn refresher unconditionally, proven still behaviourally inert on every live path today
(three independent reasons, in the file's own header). `publisher-error.filter.ts`/`main.ts` — new
`SocialOAuthErrorFilter` (38b shipped `OAuthTokenError` with no HTTP mapping at all; this is the
first controller to need one).

**No migration.** Reuses 0105's `social_accounts` + the already-merged `social_oauth_tokens`
(202608201518). **A named architecture gap, not silently worked around**: `direct.ts`'s
`connectUrl` port method STILL refuses `capability_unsupported` — the port's `(org: OrgHandle,
network, redirect)` signature carries neither a tenantId nor an accountId, which a real per-account
OAuth flow needs, so LinkedIn's OAuth grant acquisition is a standalone subsystem reached through
its own controller, not through the port. `OrgHandle` is repurposed for `direct`'s three real
methods: `.secret()` carries an ALREADY-RESOLVED LinkedIn bearer token, `.orgId` carries the
organization URN — but **no live call site resolves that token and builds the handle yet**
(`dispatch.ts` off-limits, `provisioning.ts#openOrg` is Postiz-shaped) — left to 38e, which also
owns `uploadMedia`'s own gap (the port carries no `network` parameter at all, so it always assumes
LinkedIn's asset flow — correct by elimination until 38d).

Test counts: **413 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline measured directly in this worktree
after the merge: **393 / 0 / 5**, +20 new: `linkedin-oauth.test.ts` 12, `linkedin-client.test.ts` 7,
`direct.test.ts` +7, `publisher.test.ts` +1 registry regression pin). **7 failures in
`social-client-review-portal.controller.test.ts` reproduced IDENTICALLY with this ticket's changes
stashed out** — a shared-Cerbos-container environmental flake (confirmed, not this ticket's), not
counted above. `tsc --noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/
`lint:migration-names` all green. `test:iam-chain-alignment` green (25/25, unaffected — no
Cerbos/IAM change this pass).

**0.5.7 (2026-08-20, SMM-23 — reports: snapshot + AI narrative → approve → render → files + Drive +
deliverable, medior).** `social_reports` was already in 0105 and its Cerbos policy
(`resource_social_report.yaml`) + catalog rows already in 0106, both from SMM-30's forward-looking
seed, with that yaml's own note that "no real handler for social_report exists anywhere in the tree
yet" — this ticket is that handler. No migration, no Cerbos change.

Built: `social-reports.ts` (new, pure) — `buildSocialReportSnapshot`/`buildSocialReportDocument`,
reading SMM-21's `social_metrics_daily`/`social_post_metrics` and freezing the result into
`social_reports.metrics` at creation time (never recomputed on a later read — the same "frozen
snapshot" contract `search_reports` uses). **No invented numbers, the ticket's own named
highest-stakes instance of this rule**: `sumKnown`/`latestKnown` return `null`, never `0`, when a
metric was never pulled for the period, and the corresponding `ReportKpi` is OMITTED from the array
entirely rather than rendered as zero; a real, own-row count (posts published this period) is the
one exception, since a real zero there is a known fact, not an absent counter. Proven directly:
seeded one day with `impressions` pulled and one day without, and asserted the KPI sums only the
known day while a metric never pulled all period (`reach_period`) is absent from the array, and a
post's `likes` (never fetched) renders `null` in the `top_posts` table, never `0`.

**The narrative rides SMM-19's own gateway path — no second route to ai-gateway-go.**
`ai-drafts.ts` gained `buildReportNarrativePrompt`/`parseReportNarrativeDraft` (fail-soft, same
shape as `buildCaptionPrompt`/`parseCaptionDraft`): the prompt hands the model ONLY the
already-computed, already-filtered KPI numbers and instructs it never to state one it wasn't
given; a gateway hiccup or unparsable response falls back to a deterministic template built from
those same numbers, and which one happened is frozen alongside the snapshot
(`FrozenSocialReportMetrics.narrativeSource`) so a later read never claims an AI narrative that
didn't happen. **Named limitation, not silently solved**: unlike the hashtag cap (a bounded,
mechanically-enforceable property), there is no runtime guard that can strip a hallucinated number
out of free-form narrative prose — the prompt instructs against it, but `parseReportNarrativeDraft`
validates JSON shape, not numeric provenance.

**The cross-client leak test** (`social-reports.test.ts`), same shape SMM-19's own file uses: a
fake WS8 server holding both clients' ingested corpora proves a report for client A's engagement
grounds its narrative ONLY in client A's excerpts (`social-brand:{tenantId}:{clientA}`) — never
client B's, and the same in reverse — with the request scope derived from the report's own
engagement→client join, never a request field.

**Approval — read both existing surfaces, reused neither.** SMM-09's D14 registry is for a write
that must EXECUTE the instant a human approves it; nothing here dispatches on approval, so
registering it would suspend an ordinary sign-off into WS4 for no reason. SMM-31's client-review
stage is the CLIENT's sign-off on a POST before publish, a different resource and a different
audience (`resource_social_report.yaml`'s own invariant: "`client` appears NOWHERE"). What actually
fits, verbatim from `smm-design.md` §07: "Low-impact artifacts (reports, campaign plans) approve
in-console via module permissions." `social-reports.controller.ts` builds exactly that:
`social.report.{create,read,update,approve,deliver}`, mirroring `search-reports.controller.ts`'s
own `draft → in_review → approved → delivered` state law (compare-and-swap UPDATE guards, same
idiom).

**Render reuses TR-21's sidecar, invents nothing.** `deliverReport` shapes the frozen snapshot +
narrative into a `ReportDocument` (the reports module's own contract) and calls the SAME
`mintPrintJobToken`/`renderPdfViaSidecar` (`reports/report-pdf-export.ts`) the 4-grain tracker's PDF
export uses — no new renderer, no new print route. `header.grain` is pinned to `"company"` (the
closest of the four existing grains to a client engagement; adding a fifth grain would touch
`report-document.ts`/`platform-ui/src/lib/reports.ts`, both out of this ticket's file surface) — a
named limitation: the print page's per-grain `GrainCharts` composition (`CompanyCharts`) doesn't
know this document's own series/table keys, so today only the KPI wall, highlights and narrative
render on the PDF; the series/tables are present in the JSON `ReportDocument` (the console read
surface, and any future chart wiring) but not yet on the rendered PDF page. Proven with a REAL
sidecar round trip (a stand-in HTTP server that itself fetches the real
`/internal/reports/print-payload/:jobToken` route, same technique
`reports.controller.export.pdf.db.test.ts` uses) — not a mocked render call. `files` row written
(`target_entity_type='social_report'`), Drive mirror is WS11's existing job (out of this ticket's
scope, per `search-reports.controller.ts`'s own precedent comment), `deliverables` link best-effort
when the engagement carries a `project_id`. Delivering twice is refused (compare-and-swap), and
approving from any status but `in_review` is refused.

**Absent metric on a rendered report:** never a `0` — the KPI is missing from the wall entirely,
the `top_posts` row shows the column blank (`null`), and the narrative names it as "not yet
fetched" rather than implying zero.

**Cross-session hazard hit directly**: this worktree was cut BEFORE SMM-21's merge reached `main`
(`metrics-job.ts`, the two `GET metrics/*` routes) — `git merge main` (clean, no conflicts outside
the additive `app.module.ts`/`index.ts` lines this ticket itself was writing) pulled it in before
any snapshot code was written, per this file's own standing cross-session-hazards note.

6 new MCP tools (`social.draftReport`, `social.listReports`, `social.getReport`,
`social.editReport`, `social.approveReport`, `social.deliverReport`;
`deliverReport` is `impact:'medium'`, matching `search.deliverReport`'s own ratified
"outward-facing and unretractable" widening, the rest `impact:'low'`), 5 new `social.report.*`
permissions declared on the module contract (already-catalogued rows; `delete` stays undeclared —
no endpoint honours it yet, matching `search.report.*`'s own precedent).

Test counts: **370 / 0 / 0** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline 365/0/0, +5: `social-reports.test.ts`
— no-invented-numbers, module-GUC regression, the cross-client leak test both directions folded into
one case, idempotent create, and the full draft→in_review→approved→delivered lifecycle against a
REAL report-renderer sidecar round trip). `tsc --noEmit` clean. `lint:withtenants` green (349 files
scanned). `test:iam-chain-alignment` green (25/25, unaffected). `role-permission-bundles.db.test.ts`/
`role-bundle-completeness.db.test.ts`/`role-catalog-drift.db.test.ts` green (15/15, unaffected — no
catalog/Cerbos change this pass).

**Anything the spec did not answer, named rather than guessed:** (1) `header.grain: "company"` is a
repurposing, not a real fifth grain — see the render section above; (2) the narrative's "no invented
numbers" guarantee is prompt-level only, not a runtime numeric-provenance guard (see above); (3) a
report's `period` for `kind='campaign'/'adhoc'` with no explicit period falls back to a trailing
30-day window (mirrors `search/reports.ts#periodDateRange`'s identical fallback) — not specified by
the ticket, named as a deliberate choice rather than silently picked; (4) KPI-vs-target rendering
(`social_kpi_targets`) is included in the frozen snapshot as its own table when targets exist, but
is not wired into the narrative prompt — a report with targets set gets no AI commentary on
over/under-target, left for a later pass; (5) no delivery notification/mail routing was added for
`social.report.delivered` (the event is emitted; no handler consumes it yet) — lower urgency than
SMM-31's client-review notifications, and adding a handler with no reviewed recipient list felt like
guessing at UX the ticket didn't specify. Full detail: `docs/plans/smm-tracker.md`'s SMM-23 evidence
block.

**Docs-only, 2026-08-20 (SMM-33 + the outstanding half of SMM-24) — no module version change.**
Closes SMM-33's capability inventory + eval register and the remaining BFF-docs/AGPL-gap half of
SMM-24. Built from the code, not the design docs: `docs/modules/social-capability-inventory.md`
(new) — one row per capability (endpoint · MCP tool · D14 impact class · typed refusal vocabulary ·
`work_activity` row) across P0 through the merged half of P3, companion to SMM-14's golden-case
table rather than a duplicate of it. Two structural gaps found and stated plainly: the entire
client-review capability group (request/read/withdraw/decide, SMM-31/32) has no MCP tool, and the
post-status webhook callback (SMM-10) writes no `work_activity` row with no stated reason (unlike
the retention purge and metrics pull, which each name theirs). Corrected a stale count along the
way: 18 MCP tools are declared, not 17. `docs/FRONTEND-BFF-CONTRACT.md` §19 gained three rows that
existed only in prose or not at all — the dispatch endpoint (`POST variants/:variantId/publish`),
the reconcile webhook intake (`POST webhooks/post-status`), and SMM-21's two metrics reads (`GET
metrics/daily`, `GET metrics/posts`) — each checked against the controller source read directly this
pass. The AGPL §13 source-offer gap (Postiz is AGPL-3.0; the staff console has no footer surface at
all) was RE-CONFIRMED, not rebuilt: `departments/[deptId]/layout.tsx`/`DeptShellFrame.tsx` still
carry no footer, `PortalShell.tsx`'s is client-facing (the wrong audience — §13's obligation follows
the STAFF requests that reach Postiz). Recommendation left for the owner/senior-uiux: a one-line
footer on `platform-ui/src/app/(app)/layout.tsx`, the staff-side analogue of `PortalShell.tsx`'s own
footer, not a social-department-scoped component. This worktree also fast-forwarded onto `main`
before any of the above was written (`git merge-base --is-ancestor HEAD main` was true — a clean
fast-forward, no divergent commits) to pick up SMM-21's merge, which had landed on `main` but not
yet reached this worktree's cut point; without it this pass would have built the inventory against a
tree missing `metrics-job.ts` and the two `GET metrics/*` routes entirely. Full detail:
`docs/plans/smm-tracker.md`'s SMM-33/SMM-24 evidence block.

**0.5.6 (2026-08-20, SMM-21 — metrics: `pullMetrics` nightly ingest + Analytics tab):** P3's first
ticket. Schema (`social_metrics_daily`/`social_post_metrics`) was already in 0105 — no migration.
`platform-nest/src/modules/social/metrics-job.ts` (new): the nightly sweep, shaped exactly like
`inbox-retention-job.ts`/`post-status-sync-job.ts` — `withGlobal` for the tenant list, then per-tenant
reads (own declared module scope) → the driver call OUTSIDE any transaction → writes (own declared
module scope again). Two independent halves so one failing does not starve the other: (A) one
`getAccountMetrics` call per connected account, upserted into `social_metrics_daily` on its own
`UNIQUE(account_id, date)`; (B) one `getPostMetrics` call per (publisher org, batch of published
`provider_post_id`s, 30-day lookback), APPENDED into `social_post_metrics` (0105 designs that table
as an append-only snapshot history, never upserted). Dark by default: `socialMetricsPullEnabled()`/
`socialMetricsPullIntervalMs()` read `SOCIAL_METRICS_PULL_ENABLED`/`SOCIAL_METRICS_PULL_INTERVAL_MS`
from `process.env` directly rather than through `config.ts` — that file (and `main.ts`) were held by
SMM-38a's parallel worktree for this ticket's whole duration; `startMetricsPullLoop` is written and
exported but its `main.ts` registration line is handed to the merge orchestrator rather than wired
here (see `docs/plans/smm-tracker.md`'s SMM-21 evidence for the exact line).

**The module GUC, again — the ticket's own named risk.** Every `social_*` read/write in
`metrics-job.ts` runs inside `applyAccountDailyMetrics`/`appendPostMetrics`, each of which declares
its own `declareSocialModuleScope` before touching a row — exactly like
`applyPostStatuses`/`purgeTenantInboxRetention`. `metrics-job.test.ts`'s (T1)/(T5) regression tests
call these functions exactly as written (no `{modules:['social']}` at the call site) and assert a
REAL row exists afterward — delete either declaration and the assertion fails with "written: 0"
instead, the precise "0 rows synced, looks perfectly healthy" failure shape the brief warned about.

**No invented numbers.** `DailyMetrics`/`PostMetrics` (the `SocialPublisher` port) are all-optional
fields; a field the engine never reported is written as SQL NULL end to end — never coerced to 0.
Proven with a direct DB re-read (`metrics-job.test.ts` (T2)/(T6)), through the new controller reads
(`metrics-endpoints.test.ts`), and in the browser (the Analytics tab's `AnalyticsPanel.tsx` renders
an absent counter as an em dash, never `0` — the same discipline `quota_unknown` already holds the
quota strip to).

Two new READ-ONLY BFF routes on `social.controller.ts` (`social_account`/`read`, same permission
`GET accounts` already uses — accounts are client-scoped, not engagement-scoped, so both require
`engagementId` and 400 `missing_field` without it): `GET metrics/daily` (per-account daily series,
optional `accountId`/`from`/`to`) and `GET metrics/posts` (latest `social_post_metrics` snapshot per
published variant, via `DISTINCT ON (variant_id) ... ORDER BY fetched_at DESC`). The `date` column is
selected via `::text`, not handed back as a JS `Date` — the same timezone-shift trap
`pm.controller.ts`/`document-builder.ts` already guard every date column against (found live: an
unqualified `date` column round-tripped through node-pg's `Date` parser and `res.json()` shifted a
day backward under this host's local timezone, caught by `metrics-endpoints.test.ts` before it
shipped).

Frontend: `lib/socialShared.ts`'s `DailyMetricRow`/`PostMetricRow` (all-optional per field, mirroring
the port exactly), `lib/social.ts#listDailyMetrics`/`listPostMetrics`, `components/social/
AnalyticsPanel.tsx` (the one place a number becomes text — `fmtMetric` — so there is exactly one
place to audit for the "never a fabricated 0" rule), and `departments/[deptId]/analytics/page.tsx`
now renders real tables instead of `BackendPending`, with an engagement filter mirroring
`calendar/page.tsx`'s own pattern. DEMO_MODE (`demoSocial.ts`): `dailyMetrics`/`postMetrics` seeded
onto the SAME `globalThis`-pinned `SocialStore` (read-only routes, so no write-path bundling trap
applies, but seeded consistently with the rest of the file regardless), deliberately partial — one
daily row is missing four of six counters, one post-metrics row is missing three — so the "unknown,
never zero" rendering is drivable live, not just asserted in a unit test.

**Driven in a real browser** (`DEMO_MODE=1 npm run dev`, Playwright/headless Chromium; `next build`
not re-run, per this ticket's own instruction): logged in, switched to the agency tenant, opened
Social Media → Analytics, and confirmed the per-account daily table renders real numbers for
followers/impressions on the earliest seeded day while reach/engagements/link-clicks/video-views
render as em dashes (never `0`) for that same day, then full numbers on the following two days; the
published-posts table renders one row with `saves` as an em dash while every other counter is a real
number; the engagement filter switches between both seeded engagements (both correctly show the SAME
account-level series, since accounts are client-scoped, not engagement-scoped — proving the join is
through the engagement's `client_id`, not a fabricated per-engagement slice).

**Anything the spec did not answer, named rather than guessed:** (1) no MCP tool/agentic-surface
entry was added for these two read routes — the ticket brief named `pullMetrics` + the two tables +
the nightly flow + the Analytics tab, not an agent-facing read tool, and inventing one was out of
scope; (2) the post-metrics lookback (30 days) and the daily-pull window (3 days back) are OPERATIONAL
job parameters, not business/quota constants, so the module's "no invented numbers" rule (about
values a caller could mistake for something the engine reported) does not constrain them — flagged
here rather than silently picked; (3) the pull cadence/registration is NOT wired into `main.ts` —
handed to the merge orchestrator per this ticket's own instruction (SMM-38a held that file and
`config.ts` for the ticket's duration).

Test counts: **337 / 0 / 0** `platform-nest` (baseline 318/0/0 + 19 new: `metrics-job.test.ts` 13,
`metrics-endpoints.test.ts` 6); **2399 / 0 / 0** `platform-ui` (baseline 2392/0/0 + 7 new:
`social-metrics.test.ts`). `tsc --noEmit` clean on both sides.

Full detail: `docs/plans/smm-tracker.md`'s SMM-21 evidence block.

**0.5.5 (2026-08-20, SMM-38 phase 38a — the `direct` driver skeleton + the per-capability switch,
design addendum §PD, owner decision D-20):** the first move against the free-only build: a second
`SocialPublisher` implementation alongside Postiz, switched in per capability. **This phase is
deliberately INERT — nothing about the running system's behaviour changed.** No migration, no
Cerbos change, no `main.ts`/`boot.ts` change.

Why it exists: Postiz has zero inbound engagement surface for any network (verified from its live
OpenAPI and provider sources — the P2 finding SMM-15/16/17/18 have been blocked on since SMM-05). D-20
chose building a second, free, in-house driver over forking Postiz or paying for Mixpost Pro. `direct`
ships in five phases (`docs/plans/smm-tracker.md`'s PD table); 38a is the skeleton and the switch only.

`publisher/direct.ts` (new): implements every `SocialPublisher` port member, refusing each one with a
typed `capability_unsupported` naming the exact op and the phase that will bring it. `capabilities` is
an EMPTY `Set` — the honest answer for "nothing is built yet", and the one that makes every existing
capability-gated call site (`capabilities.ts`, `provisioning.ts`'s `driver.capabilities.has(...)`
guards) already get the right answer without reaching a method. `listComments`/`sendReply` stay
ABSENT rather than defined-but-throwing, matching the Postiz driver's own "absent, not throwing"
discipline for the same gap.

`publisher/registry.ts`'s new `resolvePublisherForCapability(orgDriver, capability)`: a NEW dimension
laid ON TOP of `resolvePublisher`'s existing per-ORG resolution (0105's `social_publisher_orgs.driver`
column, untouched — still CHECK-constrained to `'postiz'`/`'mixpost'`; `'direct'` is a type-level
addition to `PublisherKey` only, and reaches a live call solely through this new config-driven switch,
never through the DB column). With no entry in `config.social.publisher.capabilityDrivers` (parsed
from `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS`, empty by default) for a given capability, resolution falls
straight through to `resolvePublisher(orgDriver)` — the identical call every existing caller already
makes. That fallthrough, not a feature flag, is what makes 38a a no-op. An override naming an
unregistered driver still REFUSES (`unknown_publisher`) rather than silently substituting the org's
own driver — `resolvePublisher`'s own honor-or-refuse property, preserved at the new dimension rather
than bypassed by it.

`direct` is deliberately **not registered in `main.ts`/`boot.ts` this phase.** Registering it
unconditionally would make the driver registry non-empty even when `SOCIAL_POSTIZ_BASE_URL` is unset,
which would silently change `resolvePublisher`'s refusal from `publisher_not_configured` to
`unknown_publisher` for every org in an otherwise-unconfigured deployment — a live-behaviour change
this phase's own acceptance bar forbids. Registering `direct` (and, if needed, revisiting
`resolvePublisher`'s empty-registry heuristic) is left to whichever phase first gives it a real
capability to reach (38b at the earliest).

`publisher-contract.ts` (new): the port's own behavioural contract, pulled out of `publisher.test.ts`
into a parameterized `runPublisherContractSuite(label, { build, integration? })` — mirroring
`invokePublisher`'s own "the port owns it, not one driver" reasoning for instrumentation. Each case
reads the driver's OWN `capabilities` set before deciding what "correct" means for THAT driver: a
capability gap asserts the typed refusal (never a skip), a capability present asserts the real
contract (e.g. `schedulePost` refuses `approval_required` before any network call). Run against
`postiz` (a generic 200 stub, no real socket), the mock, and — in `direct.test.ts` — `direct` itself.

Tests: `direct.test.ts` (new, 12: 6 driver-specific + the 6-case shared suite run under label
`direct`); `publisher.test.ts` gained 16 (the shared suite run against `postiz` and the mock, 6 each,
plus 4 for the switch itself: inert-by-default equivalence, an honoured override leaving other
capabilities untouched, refusing an unregistered override, and the per-org refusal property still
reachable through the new entry point).

**346 / 0 / 0** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts` +
`social-client-review-portal.controller.test.ts` (was 318/0/0). `tsc --noEmit` clean.
`lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` green.
`test:iam-chain-alignment` green (25/25, unaffected).

**What 38a leaves for 38b+:** 38b must add token custody (encrypted-at-rest, refresh-ahead,
revocation) before `direct` can advertise a single real capability, and per §PD's custody note this
also promotes SMM-36's retention job from a LinkedIn compliance nicety to load-bearing custody work.
38c/38d build LinkedIn/YouTube against the now-empty `DIRECT_CAPABILITIES` array (grow it exactly once
per landed, verified capability — never ahead of what is built). 38e is the only phase expected to
touch `config.social.publisher.capabilityDrivers` with a real value, and to decide how/whether
`direct` gets registered in `main.ts` at that point.

**0.5.4 (2026-08-20, SMM-32 — client-review portal UI + composer/calendar reflection):** the other
half of P2's first ticket. `platform-ui` only — no migration, no Cerbos change, no new backend
route; every endpoint this pass consumes already shipped in SMM-31.

Portal (`(portal)/portal/social-reviews{,/[reviewId]}/page.tsx`): a list (pending sign-offs first,
decided ones under "Past reviews") and a detail page rendering the exact post content the client is
deciding against, plus the approve/request-changes decision itself (`PortalSocialReviewDecideForm`,
`useActionState`, not the void gate-decide shape — a genuine 409 must be SEEN, not swallowed). New
`lib/portal.ts` types (`PortalSocialReview`, `socialReviewStatusLabel`, `describeSocialReviewError`),
`portal-data.ts` readers (list + a derived single-review lookup — §16h has no dedicated GET),
`portalActions.ts#portalDecideSocialReview`. New un-badged "Post reviews" portal tab (a real count
would need a new always-on fetch every portal page load or a backend extension SMM-31 did not make
— flagged as a follow-up, not silently invented).

Staff (Composer + Calendar): `socialShared.ts` mirrors `CLIENT_REVIEW_REFUSAL`'s 5 tokens by hand
(same reasoning `PUBLISH_PRECONDITION_STAGES`'s own copy gives) plus a new `evaluateClientReviewState`
— a client-safe re-implementation of `evaluateClientReviewPrecondition` (same 5-way branch, same
staleness check against the LIVE `argsSha256`) — and widens `PublishPreconditionResult.stage` to
accept `"client_review"`, which the EXISTING "Check now" preview button already renders correctly
once the type/labels exist (zero new UI on that path). `VariantCard.tsx`'s new `ClientReviewPanel`
(ask / re-ask / withdraw, gated on new `social.client_review.{request,withdraw}` capabilities) and
`CalendarGrid.tsx`'s per-variant chips (RAW status only — `listPosts`'s roll-up carries no
`argsSha256`, so the calendar cannot and does not claim `stale`; only the Composer does). Three new
`rbac.ts` capabilities, verified against `role-permission-bundles.json` (not inferred): `social_staff`
read+request only, `social_manager`/`company_admin`/`manager`/`platform_admin` all three,
`group_executive` read only (wholesale-excepted from the parity guard like every other `social.*`
capability for that role) — `rbac-capability-map.ts` entries added so the 742-case parity suite
covers the three new grantable permissions rather than silently missing them.

**A real, PRE-EXISTING DEMO_MODE gap found and closed** (not introduced by this ticket):
`demoSocial.ts` had no `GET engagements/:id/scope` route at all, so `lib/social.ts`'s
`getEngagementScope` silently degraded to `readGuarded`'s `EMPTY_SCOPE` fallback
(`requiresClientOk: false`) everywhere in DEMO_MODE — invisible for the Composer's panel (renders
regardless of the toggle) but it fully defeated the Calendar's chip feature, which gates its
per-variant fetch on that exact flag. Also silently affected the pre-existing (unrelated)
engagement-scope editor page the whole time. Closed with one new `GET` route — a fixture gap, not a
contract change.

DEMO_MODE state added, `globalThis`-pinned FROM THE START (this file's own 2026-08-20 lesson,
applied rather than repeated): a `clientReviews` array on the SAME shared `SocialStore`, a SECOND
engagement (`soc-eng-2`, `requiresClientOk: true` — kept separate from `soc-eng-1` so SMM-12's own
healthy-dry-run demo scenario stays undisturbed) with four variants spanning
`pending`/`approved-but-stale`/`changes_requested`/`not_requested`, and a second dispatch function
(`socialClientReviewPortalDemo`, wired into `demoFixtures.ts`) answering the portal's
`/api/:t/portal/social-reviews[...]` routes off the IDENTICAL store — a staff "ask" and a client
"decide" in two separate browser sessions agree on the one row.

**Driven in a real browser** (`DEMO_MODE=1 npm run dev`, Playwright/headless Chromium — `next build`
deliberately not re-run this pass, per this ticket's own "don't run it repeatedly" instruction):
all 5 `CLIENT_REVIEW_REFUSAL` tokens rendered as themselves in the Composer (including
`client_review_stale`'s exact honesty framing — "the client approved this, but the content has
changed since... ask again before this can publish"); the full staff request→pending→withdraw→
re-request loop on a live `not_requested` seed; the EXISTING "Check now" preview correctly rendering
the widened `client_review` stage with zero new rendering code; calendar chips showing the raw
status only (confirmed the STALE post's chip reads `approved`, never `stale`); the portal list +
decide flow as `demo-client`; and — the ticket's own idempotent-decision requirement, proven as a
genuine two-tab race rather than merely asserted — two tabs opened the same pending review, tab 1
approved it, tab 2 (stale, unrefreshed) submitted a DIFFERENT decision and received the honest 409
conflict message ("This was already decided, and it doesn't match what you just submitted —
refresh the page to see the current status"), never a crash; reloading tab 2 showed `Approved` with
**no decide control anywhere on the page**. Cross-session consistency was also proven: after the
portal decision, a SEPARATE staff session's Composer card showed "The client approved this exact
content on 8/20/2026" and the precondition preview correctly advanced past the client-review gate to
the next real blocker (`variant_not_approved`) — the gate composition holds across two independent
sessions against one shared store.

Test counts: **2392 / 0 / 0** `platform-ui` (baseline 2329/0/0, +63); `tsc --noEmit` clean;
`rbac-capability-parity.test.ts` 742/742 including the three new capability pairs.

Full detail: `docs/plans/smm-tracker.md`'s SMM-32 evidence block, `docs/FRONTEND-BFF-CONTRACT.md`
§16h/§19.

**0.5.3 (2026-08-20, SMM-31 — client-review stage backend, D-16):** P2's first ticket. Backend only
— the portal UI (SMM-32) is next.

- **Schema and IAM were already in place** (`0105`/`0106`, SMM-01/30): `social_post_client_reviews`
  takes the PLAIN core tenant wall, deliberately, not the third `app_module_allowed('social')` wall
  every other `social_*` table carries. Its primary writer is the client portal, and portal
  controllers declare no module scope by design (D-16 applies 0088's D-2a lesson —
  `webdev_change_requests` — before it could bite here). This ticket added zero migrations and zero
  Cerbos policy changes: `social.client_review.{read,request,withdraw}` and `portal.approve_post`
  were already catalog rows with policy actions behind them, unused until now.
- **The state machine**: `pending → approved | changes_requested | withdrawn`, and — because 0105's
  `UNIQUE(variant_id)` means one row per variant FOREVER — re-requesting from any terminal state
  resets the SAME row back to `pending` rather than inserting a second one. Staff: request (upsert,
  no-op idempotent while already pending), read (`{status:'not_requested'}` when nothing was ever
  asked — data, not a 404), withdraw (manager-tier; idempotent on a repeat withdraw). Client (portal,
  new `SocialClientReviewPortalController`): decide `approved`/`changes_requested`, snapshotting the
  variant's LIVE `args_sha256` into `reviewed_args_sha256` at the moment of decision — so a
  content edit after approval is `stale` by construction, mirroring D-15's edit-invalidates-approval
  rule for the client's own side of the same content.
- **Idempotent decision, proven not asserted**: the portal's `decide()` runs a single guarded
  `UPDATE ... WHERE status = 'pending'` (no advisory lock needed — a single-row compare-and-swap,
  the same idiom `dispatch.ts`'s `stampDispatchOutcome` uses). A retry landing after the row already
  moved is distinguished from "does not exist" only AFTER ownership was already proven by an earlier
  read (existence-oracle-safe) — same decision on file → 200, `alreadyDecided:true`, no second event
  or notification; a DIFFERENT decision → 409, never a silent flip. Test-proven with an assertion on
  `decided_at` not moving and exactly one outbox row existing after two identical decide calls.
- **Where this sits relative to SMM-09's six-stage publish gate — NOT a 7th stage.**
  `PUBLISH_PRECONDITION_STAGES` stays `[scope, quota, hash, unconsumed, budget, creator_info]`,
  pinned verbatim by `d14-smm-09-social-publish-registry.test.ts` and untouched. Client review is a
  separate, additively-composed gate (`evaluateClientReviewPrecondition` +
  `evaluatePublishPreconditionWithClientReview`), run BEFORE the six-stage chain at all three real
  choke points: the D14 executor's own precondition (`core/approval-executables.ts`), SMM-10's
  dispatch re-check (`dispatch.ts`), and the dry-run endpoint
  (`GET .../publish-preconditions`/MCP `social.checkPublishPreconditions`) — which, since this
  codebase has no separate "submit for staff approval" endpoint as of P1 (a variant moves straight
  from composer edits to a generic `POST /api/:t/automation-approvals` filing, with no per-tool
  filing-time hook anywhere in the estate), is the practical moment staff actually observe "would
  this be submittable" before ever filing a WS4 request. Re-derived on every call, never cached, so
  a client withdrawing consent between filing and execution still refuses at dispatch even if the
  dry run was never consulted.
- **New refusal vocabulary, kept apart from `PUBLISH_REFUSAL` on purpose** — same separation
  `dispatch.ts`'s own `DISPATCH_REFUSAL` keeps from the six-stage chain, not folded in "for
  consistency": `CLIENT_REVIEW_REFUSAL` (`client_review_not_requested`, `_pending`,
  `_changes_requested`, `_withdrawn`, `_stale`). `PUBLISH_REFUSAL`'s own six tokens are unchanged.
- **Notifications ride the already-drained `"social_post_variant"` consumer stream** — two new
  `event-handlers.ts` routes (`social.client_review.requested` → client portal contacts via
  `resolveClientRecipients`/`notifyBestEffort`, `.decided` → the engagement owner via the existing
  `loadEngagementOwner` helper), no `main.ts` change needed. Deliberately reused the stream this
  module's own recurring "registered but never invoked" defect (SMM-13's original bug) already
  fixed, rather than adding a new entity-type stream that could repeat it.
- **Verified**: 318/318 across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts` +
  `src/core/social-client-review-portal.controller.test.ts` (was 289/289), **0 skipped**. Two
  regression tests were driven RED first — the `declareSocialModuleScope` call inside
  `evaluateClientReviewPrecondition` and inside the portal controller's `decide()` were each
  temporarily deleted and the corresponding test failed exactly as predicted (a wrongly-permissive
  `{ok:true}` in one case, a 404 instead of 200 in the other) before being restored — proving the
  regression guard is real, not merely asserted. `tsc --noEmit` clean; `lint:withtenants`,
  `lint:migration-rls`, `lint:migration-names` all green; `test:iam-chain-alignment` green (25/25,
  unaffected — no catalog/policy changes this ticket). No migration.

**0.5.2 (2026-08-19, SMM-14 — P1 end-to-end + golden cases, QA gate pass):** P1 is code-complete
(SMM-06/07/09/10/12/13/36/39, all merged) — this pass is verification + one regression pin, not new
product code. Findings, stated plainly per the repo's status-language rule:

- **The publish loop is DEV-VERIFIED against the mock driver, end to end: compose → per-network
  variants → validation → `args_sha256` → approval → the SMM-09 publish gate → SMM-10 dispatch →
  the transactional `approval_id`+`provider_post_id` stamp → status reconcile.** Driven through the
  REAL D14 executor (`executeApprovedAutomationWrite`, `core/d14-smm-09-social-publish-registry.test.ts`
  (D)–(G) blocks) with a stubbed hub boundary asserting the hub is called exactly zero or one times
  per precondition outcome, and through `dispatchApprovedPublish` directly against real Postgres + the
  in-memory mock driver (`dispatch.test.ts` T1–T12). **Live network publishing is DEFERRED TO
  STAGING** (owner decision, 2026-08-20): the platform-app reviews (Meta et al., OQ-1) are non-code,
  weeks-long, and will not be revisited in this ticket. Verified on the live engine 2026-08-19 that
  `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`/`LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`/
  `TIKTOK_CLIENT_ID`/`YOUTUBE_CLIENT_ID` are all length 0 — no platform-app review has landed for any
  network, so OAuth cannot begin today. That state is expected, not a defect, and is not this
  ticket's to close.
- **Every refusal token in `PUBLISH_REFUSAL` (6 stages) and `DISPATCH_REFUSAL` renders as itself** —
  a typed `reason`/`code`, never a generic error or an empty list — proven through the real HTTP
  filters (`publisher-error.filter.ts`, `publish-gate.test.ts`'s HttpErrorFilter-trap pin) and the
  executor's own `execution_error` column. Added one new adversarial case,
  `provisioning.test.ts` — "refuses `platform_app_not_registered` honestly on EVERY
  deployment-enabled network" — looping every network `config.social.publisher.enabledNetworks`
  actually turns on (not just the instagram case the existing suite happened to cover), asserting
  the connect POST is a typed 409 with non-empty prose for each.
- **⚠ REGRESSION FOUND AND FIXED (by another seat, `main@635f9fd`) — SMM-13's notification/mail
  routing was dead code in the running app.** `event-handlers.ts` registers
  `handlePostDispatched`/`handlePostPublished`/`handlePostFailed` against
  `socialModule.eventHandlers`, keyed to events emitted with entity type `"social_post_variant"`
  (`dispatch.ts`, `post-status-sync-job.ts`). `main.ts`'s `startConsumerLoop([...])` — the only
  thing that decides whether a Redis stream is ever drained — did **not** list
  `"social_post_variant"`. The events were written to the outbox and relayed, and read by nobody: no
  in-app notification and no risk-shaped mail ever fired for a real dispatch/publish/failure, in any
  running deployment. `event-handlers.test.ts` stayed green throughout because it calls the three
  handler functions directly, never through the consumer loop — the same "tests that pass while the
  feature is dead" class this module has now produced five times, and the first at the wiring layer
  rather than inside a query. Pinned red by a new static suite,
  `src/modules/social/event-wiring.test.ts` (mirrors `src/events/position-consumer.test.ts`'s own
  P2-05 discipline, reading `main.ts`'s own source rather than trusting the handler tests), caught
  the regression, and now asserts the fix stays fixed: `"social_post_variant"` is in the watched list
  as of `main@635f9fd`, and the suite is green again (289/289, see below). QA found and pinned this;
  QA did not patch `main.ts` — that landed from a separate seat.
- **The UI flow (SMM-12: Calendar drag-to-reschedule, quota strips, submit-with-preview) was driven
  in a REAL browser for the first time**, via a new DEMO_MODE fixture
  (`platform-ui/src/lib/demoSocial.ts`, senior-fe) wired into `demoFixtures.ts`. Login as any email in
  DEMO_MODE, tenant `co-agency`, department `dept-4` (Social Media). Three assertions, driven with
  Playwright against `next dev` (not the production build):
  - **Drag-to-reschedule's warning — CONFIRMED, in a real browser.** Dragging `soc-post-3` ("Weekly
    promo carousel", two APPROVED variants) fires a native `confirm()` **before** the drop commits,
    naming the count verbatim: *"…has 2 approved variants… will discard 2 existing approvals…"*.
    Dismissing leaves the post's day and both variants' `APPROVED` status untouched. Accepting drives
    the real `rescheduleVariants` server action, which returns `approvalInvalidated: true` for both
    variants and renders the correct banner ("One variant moved — its approval no longer applies…").
  - **Drag-to-reschedule's persistence — NOT CONFIRMABLE, and this is a real, diagnosed defect in the
    DEMO_MODE fixture, not a production-logic gap.** A full page reload (and even the SAME page's own
    `router.refresh()`) shows BOTH variants still `APPROVED`, unmoved — reproduced twice, once via the
    drag flow and once via a plain single-field "Save variant" edit, to rule out anything specific to
    drag-and-drop. Root cause, found by reading the codebase's own precedent: Next.js compiles the
    `"use server"` action graph (`socialActions.ts`) and the page's RSC read graph into SEPARATE
    module instances in dev, so a plain module-level array does not stay in sync between them.
    `demoPortal.ts` hit and fixed this EXACT failure mode on 2026-08-08 (its own header: *"the write
    returned 201, the success banner showed, and the request… was absent from the list"*) with a
    `globalThis`-pinned store; `demoMonitoring.ts`'s header states the rule directly: *"the globalThis
    dance… exists to keep a `use server` action graph and the page's RSC read graph pointing at ONE
    mutable array… add the globalThis wrapper the moment a write lands."* `demoSocial.ts` has writes
    (reschedule, save, create, delete) but was built on `demoPipeline.ts`'s PLAIN-array convention
    instead — the wrong one to mirror once writes exist. **Not fixed here** (QA does not patch fixture
    write-paths any more than product code) — flagged for senior-fe: apply the same `Symbol.for(...)`
    + `globalThis` pattern `demoPortal.ts` already uses, to every mutable array in `demoSocial.ts`.
    The REAL backend's edit-invalidates-approval law is separately DEV-VERIFIED end to end against
    real Postgres (`social.test.ts`'s "EDIT INVALIDATES APPROVAL" case, `dispatch.test.ts`, the D14
    registry's E1/E2) — this gap is specific to seeing it work by clicking, not to whether it works.
  - **Quota-unknown — CONFIRMED, in a real browser.** `soc-acc-ig-2` (no quota bucket at all) renders
    *"Unknown — registry not synced (never zero)"* — never "0 used".
  - **`quota_exhausted` as itself — CONFIRMED, in a real browser.** `soc-acc-ig-3` (25/25, at cap):
    clicking "Check now" on its variant renders a `quota` stage badge plus *"This account's live
    posting quota is used up right now."* — the refusal token as its own sentence, not a generic
    error, not an empty state.
- Module GUC audit (0105's third RLS wall, `app_module_allowed('social')`): every `withTenants` call
  touching a `social_*` table across `social.controller.ts`, `dispatch.ts`, `post-status-sync-job.ts`,
  `inbox-retention-job.ts`, `creator-info-verifier.ts`, `publisher/provisioning.ts` and
  `event-handlers.ts` either passes `{modules:["social"]}` or calls the exported
  `declareSocialModuleScope` explicitly — no further silent-zero-rows path found beyond the event-
  wiring regression above (which is a consumer-registration gap, not a GUC gap).
- No vacuous-test patterns (`.resolves.not.toThrow()`, an empty-tenant-scope read) found in the
  existing social suite; `mail_log` assertions already read via `adminPool()` with `config.mail.enabled`
  flipped in-test, matching `mail/queue.test.ts`'s own idiom.
- Test counts (passed/failed/skipped, three separate numbers, DATABASE_URL_TEST present so nothing
  silently skipped), taken AFTER merging `main@635f9fd`'s fix: `src/modules/social` +
  `d14-smm-09-social-publish-registry.test.ts` together **289 passed / 0 failed / 0 skipped**.
  Before that merge, the same run was 288 passed / 1 failed (the `event-wiring.test.ts` pin, red BY
  DESIGN — proof of the regression, not an environmental flake) / 0 skipped. Baseline for
  `src/modules/social` alone was 234 passing; it is now 236 (+1 new provisioning case, +1 new
  event-wiring pin, now green post-merge). `tsc --noEmit` clean both before and after the merge.
  `lint-migration-names.mjs` and `lint-migration-rls.mjs` clean (no migration added by this ticket;
  migration `0119` arrived via the `main` merge, from an unrelated monitoring fix).

**The golden-case table (agentic exit-bar item 6) — one row per P1 capability, each proven against
the real endpoint/tool with a real refusal and a real `work_activity` row:**

| Capability (ticket) | Endpoint | Tool | Impact class | A refusal it proves | `work_activity` row |
|---|---|---|---|---|---|
| Compose a post (SMM-06) | `POST posts/:id/variants` | `social.addPostVariant` | write, low | `variant_not_found` on a bad post id | `created` on `social_post_variant` |
| Connect an account (SMM-07) | `POST publisher-orgs/:clientId/connect` | — (console-only; no MCP tool, by design — an OAuth ceremony needs a human in a browser) | n/a | `platform_app_not_registered` on EVERY enabled network (new test, this pass) | `initiated`/`resumed` on `social_account` |
| Dry-run a publish (SMM-09) | `GET variants/:id/publish-preconditions` | `social.checkPublishPreconditions` | read, low | any of the 6 `PUBLISH_REFUSAL` stages, e.g. `args_hash_mismatch` | (read-only; none) |
| Execute a publish (SMM-09/10) | `POST variants/:id/publish` | `social.publishPost` | write, **high** (D14-suspended) | `metered_network_requires_metered_tool` (the $0/metered split) | `dispatched`/`failed`/`refused` on `social_post_variant` |
| Calendar reschedule + quota + preview (SMM-12) | `PATCH variants/:id`, `GET .../publish-preconditions` | `social.validateVariant` (read tool); the PATCH itself has no tool — an authenticated console edit | write, low (validate) | `quota_exhausted` rendered as itself (browser-CONFIRMED, this pass) | `updated` on `social_post_variant` |
| Post-event notify + risk mail (SMM-13) | — (event-driven, no HTTP surface) | — | n/a | n/a (a notify, not a refusal) — but the CONSUMER-WIRING gap this pass found and `main@635f9fd` fixed is the golden case: a handler registered and never invoked is exactly the failure class criterion 5 exists to catch | `dispatched`/`failed` events → `notify()` + (risk-shaped) `enqueueMail` |
| Inbox retention purge (SMM-36) | — (scheduled sweep, no HTTP surface) | — | n/a | a per-tenant failure is isolated and logged, never silently swallows every tenant (`inbox-retention-job.test.ts`) | none (a purge, not a user action) |
| Media upload on dispatch (SMM-39) | (internal to `POST variants/:id/publish`) | (same as SMM-09/10 above) | write, high | `media_upload_failed` — refuses BEFORE `schedulePost`, never a partial post | same `social_post_variant` row as the publish above |

Two rows have no MCP tool and no `work_activity` row **by design, not by omission**: the account-
connect ceremony is console-only (OAuth needs a human in a browser, D-14's own boundary), and the
retention purge is a scheduled sweep with no user attribution to attach an activity row to.

**platform-ui side of this pass:** the new `demoSocial.ts` fixture + wiring, `tsc --noEmit` clean,
`vitest run` **2319 passed / 0 failed / 0 skipped** (baseline 2309, +10 from the fixture's own test
file and incidental coverage). The production build (`DEMO_MODE=1 npm run build`) was run clean by
the senior-fe seat that authored the fixture, in this same worktree — not re-run here a second time.

**0.5.1 (2026-08-19, SMM-39 — `uploadMedia` actually wired into the dispatch path, DEV-VERIFIED
against a mock driver + a real Postgres):** closes the defect SMM-10 flagged by name in its own
"KNOWN LIMITATION" comment: `dispatch.ts`'s `toDispatchMedia` mapped the composer's `fileId`
descriptor onto the engine ref verbatim — a placeholder, never a real upload — so any post carrying
an attachment failed at the publisher (`publisher_http_error`). No ticket had ever called
`SocialPublisher.uploadMedia` (SMM-05 built it, unused, until now).

- **`resolveEngineMedia`** (`dispatch.ts`) reads each attachment's bytes out of `files` (plain core
  tenant wall — NOT a `social_*` table, so no module GUC, and conflating the two is the trap this
  module has already hit four times) and calls `uploadMedia` for real, ONE attachment at a time,
  OUTSIDE the claim transaction and the advisory lock — the same discipline SMM-10's creator-info
  fetch already established for this file, because the upload is real network I/O against the
  licence zone with its own 120s timeout class.
- **Refs never touch the hashed args.** `social_post_variants.media` stays composer content, inside
  `args_sha256` (D-15); the resolved `{id, url?}` refs live in a NEW additive column,
  `uploaded_media jsonb` (migration `0118_social_variant_uploaded_media.sql`), keyed by `fileId`.
  Writing the upload result into `media` itself would have invalidated the very approval the upload
  is executing under — a self-inflicted `args_hash_mismatch` deadlock this ticket's own brief named.
- **Idempotent per (variant, file), durably.** Each fileId's ref is persisted the instant ITS OWN
  upload succeeds, not batched — so a redispatch (a fresh approval after a prior attempt failed
  partway through) resumes rather than re-uploading everything from zero.
- **Refuses closed on partial failure.** A three-image variant whose second upload fails never
  reaches `schedulePost` at all — no one/two-image post goes out. New token
  `DISPATCH_REFUSAL.mediaUploadFailed` (`media_upload_failed`), added to `dispatch.ts`'s own small
  vocabulary (not `PUBLISH_REFUSAL`) because "we never reached the engine" and "the engine rejected
  it" (`dispatch_error`) are different facts an operator needs to tell apart. The approval is still
  consumed either way (SMM-09's `neverAutoRetry` doctrine).
- **Text-only variants are untouched** — `resolveEngineMedia` returns immediately, before touching
  `files`, `storage()` or the driver, when a variant carries no media.
- 15 new/changed assertions across `dispatch.test.ts` (3 new cases: partial-failure refusal,
  idempotent-redispatch skip, text-only no-op; existing cases updated to attach REAL `files` rows —
  the fixtures had been naming a `fileId` with no row behind it at all, which is exactly the gap this
  ticket closes). 225 passing in `src/modules/social` (was 222), 0 failing, 0 skipped. `tsc --noEmit`
  clean.

**0.5.0 (2026-08-13, SMM-05 — the `SocialPublisher` port + org provisioning + connector-registry
sync, DEV-VERIFIED against a mock/contract suite; the engine itself is still undeployed):**
`src/modules/social/publisher/` is now the ONE place anything in this platform reaches a publishing
engine — the AGPL containment line in code (design §06 invariant 1, §11). Six source files, three
endpoints, no migration.

- **The port** (`publisher/types.ts`) is capability-based, so a partial driver is a modelled state
  rather than a method that throws. One driver ships (`postiz`, HTTP+JSON only); `mixpost` remains a
  driver swap, not a redesign, and 0105 already admits it on `social_publisher_orgs.driver`.
- **Containment is mechanically enforced**, not asserted: `npm run lint:postiz-deps` (new CI gate in
  the `platform-nest` job) fails the build on any Postiz package in `package.json` or any
  Postiz-ish module specifier in an import/require position anywhere in `src/`, and
  `publisher.test.ts` re-asserts it locally plus pins that the driver imports ONLY relative paths.
  Zero deps today. It deliberately does **not** ban the *string* "postiz" — `postiz_org_id` is a
  column, `SOCIAL_POSTIZ_BASE_URL` is a config key, and banning the word would train people to work
  around the lint.
- **Org provisioning is idempotent and lets the DATABASE decide.** 0105's `UNIQUE (tenant_id,
  client_id)` and the GLOBAL `UNIQUE (postiz_org_id)` are honoured rather than re-implemented: a
  repeat returns the existing row (`created:false`), re-pointing a client at a different org refuses
  `org_conflict`, and an org already mapped elsewhere refuses `org_conflict` **including when
  "elsewhere" is a tenant the caller's RLS scope cannot see** — which no SELECT-first check could
  have caught.
- **Connector-registry sync** mirrors status / live quota / resolved capabilities / health into
  `social_accounts`, and **never a token** (D-5 custody split (c)). Instagram quota is read LIVE from
  the account (`content_publishing_limit`, §A4f) or recorded as UNKNOWN — never a constant; a test
  greps the sources to keep it that way. `capabilities` carries an `unsupported` reason per false
  (`network` / `driver` / `unverified`), so "TikTok will never have comments" (§A4h) and "our engine
  cannot read Instagram comments yet" (spike §8b) stay the different sentences they are.
- **The cross-client FK-chain check** (`assertDispatchChain`) is the wrong-account-publish defence at
  the dispatch choke-point. 0105 enforces same-TENANT with composite FKs and says in its own comment
  that the client-level walk belongs here; `variant → post → engagement → client` must equal
  `variant → account → client` must equal `account → publisher_org → client`, or it refuses
  fail-closed with an audit line. It takes an existing transaction client so SMM-09 can run it in
  the same transaction that consumes the approval — a validated-then-dispatched TOCTOU gap would
  defeat the point.
- **Config plumbing absorbs SMM-06**: base URL, alias-resolved org keys, split timeouts (connect 5s
  / read 30s / upload 120s, §A4l §4), per-network deployment flags defaulting to
  `instagram,facebook,linkedin` (§A4h's own roadmap conclusion). **Boots cleanly with the publisher
  unreachable** — registration is a pure decision from config, opens no socket, and an unset base URL
  is a supported deployment. The one boot REFUSAL is the inverse of the search module's guard: a
  base URL that looks PUBLIC aborts startup, because the VPS has no public listener and a public
  value means the containment perimeter moved.
- **Every driver call is OTel-wrapped** at the port (`invokePublisher`), not in the driver — so the
  network/org/op/cost_usd contract is a property of the port and a second driver cannot forget it.

**What SMM-04's findings made obsolete in design §05, corrected here rather than carried:**
`createOrg` is capability-gated and refuses on Postiz (there is no org-creation route — an org is
the runbook's one-shot registration ceremony, by a human, on the licence-zone host);
`listComments`/`sendReply` are OPTIONAL members that the Postiz driver does not implement at all
(the engine has ZERO inbound engagement surface for any network — P2 has nothing behind this port to
call); and `getPostStatus` is a batched, date-ranged sweep rather than a per-id loop.

3 endpoints: `GET accounts`, `POST publisher-orgs`, `POST publisher-orgs/:clientId/sync`, plus
`GET publisher/status` (a read that answers while the engine is down). 4 MCP tools with the same
`authorize()` calls. 3 permissions declared (`social.account.read|connect|update`) — `social.post.publish`
is still deliberately ABSENT: **this ticket builds no publish path**, and the D14 executable-approval
entry is SMM-09's. 163/163 passing across the module (59 new). BFF §19 extended.

**0.4.1 (2026-08-13, SMM-37 — three validation-engine gaps closed, DEV-VERIFIED):**
`media-rules.ts` — the pure pre-publish engine consumed at all three call sites (composer create,
composer edit, `GET variants/:variantId/validation`) — gains three fixes the platform-app research
(addendum §A4f/§A4i) found against the live networks, no schema change:

1. **Media FORMAT is now checked.** Instagram accepts JPEG images only; a PNG/WebP attachment now
   refuses `unsupported_media_format` (a structural error, same class as media count/kind) instead of
   sailing through and dying at the API. The engine REFUSES rather than transcodes — explicit choice,
   reasoned in the file header: no transcode backend exists anywhere in the estate (the same gap D-17
   already named for images), and silently converting bytes a human is about to approve is a worse
   surprise than a re-attach prompt. `MediaItem.format` is composer-supplied — the same trust boundary
   `kind` already uses, not derived from the `files` row (`files.content_type` is itself
   client-supplied, so a DB join there buys no extra assurance). Missing format warns
   (`media_format_unknown`), never blocks, so variants attached before this ticket keep validating.
2. **Facebook's native schedule window is now checked** (10 minutes to 30 days from the publish call,
   `facebook_schedule_window`). Checked ONLY for `facebook` — Instagram has no native API scheduling
   to violate (our own queue publishes it) and no other network in the research trail documents a
   bound. `validateVariant` takes `now` as an optional parameter (default the real clock) precisely so
   this is deterministic in tests and so the identical call, re-run at dispatch against the real
   dispatch moment, catches drift a submit-time check could not have seen.
3. **`QuotaSnapshot`'s YouTube shape is fixed.** YouTube moved to three independent daily buckets on
   2026-06-01 (100 `search.list` calls, 100 `videos.insert` calls, 10,000 units for the rest); the old
   single-pool `{"youtubeUnitsToday":1600}` model this design carried would report headroom in the
   10,000-unit pool while the 100-call upload bucket is already exhausted. `checkQuota` now reads
   `youtubeQuota.videosInsertCallsToday` — the bucket that actually gates an upload — with the same
   "unknown is not zero" doctrine `igPosts24h` already uses. **`migrations/0105_module_social.sql`
   itself carries no such literal comment** (only `smm-design.md` §04, the frozen v1.0 base doc, and
   the dossier's citation of it, do) — nothing there needed fixing, and it would have been
   off-limits regardless (0105 is applied; migrations README forbids editing applied migrations).
   The type + its doc comment are the fix; the historical doc stays as the record of why.

Also carried forward, not a code change: the design's old "IG ~25 posts/24h" figure is obsolete
(Meta's current doc says 100, self-contradicting with 50 in its own carousel section) but nothing
here was ever wrong in code — `igPosts24h.cap` was always read live from the account's connector
registry, never hardcoded. Comments now say so explicitly rather than repeating "25".

36 media-rules tests (was 17); 104/104 passing across the module (`npx vitest run
src/modules/social`). BFF contract §19 extended with the three new tokens. No migration, no new
endpoint, no new route — `scheduledAt` was added to `VariantShape` (engine-internal) and threaded
through the three EXISTING call sites in `social.controller.ts`; MAP.md is unaffected (Δ15's trigger
is a new controller/route/migration/workflow, none of which this ticket adds).

**0.4.0 (2026-08-13, SMM-19 — brand-voice RAG + AI drafting, DEV-VERIFIED):** caption/hashtag/idea
drafting through **ai-gateway-go only** — Hermes by default, Claude only as a per-request `provider`
reorder hint when the engagement's `tool_scope.ai.cloudPolish` is on — grounded in each client's own
brand corpus, ingested as **tenant+client-ACL'd WS8 knowledge sources** (`social-brand:{tenantId}:
{clientId}`, design D-13: WS8 stays the sole owner of derived knowledge stores; `social_brand_profiles`
holds only the `knowledge_source_ids` pointer, never corpus text, never an embedding column — no new
migration needed for this ticket). Three new files (`gateway-client.ts`, `knowledge-client.ts`,
`ai-drafts.ts`) and three new endpoints, all reusing EXISTING permissions
(`social.engagement.update`, `social.post.update`, `social.post.create`) rather than declaring new
catalog reach nothing else enforces:

1. **The cross-client leak test — the assertion that mattered most.** A fake WS8 server
   (`social-ai-drafts.test.ts`) reimplements the real isolation predicate
   (`scope = ANY(acl)`) over a store holding BOTH clients' corpora at once. Drafting for client A's
   variant is proven to retrieve and quote ONLY client A's excerpts — the prompt Hermes actually saw,
   the `groundedOn` sourceRefs returned, and the WS8 `/search` request itself are all asserted
   directly — and the same holds in reverse for client B. The scope string is derived from the
   variant/engagement's own DB-joined `client_id`, never from a request body field, which is what
   makes the property hold even against a caller trying to influence it.
2. **Hashtags are never the model's own answer.** `applyHashtagStrategy()` re-derives the final list
   every time: the brand's `hashtag_strategy` (banned/required/count/placement) and the network's own
   cap — **reused from `media-rules.ts`'s `maxHashtagsFor`/`supportsFirstCommentFor`, never a second
   table of limits** — both apply regardless of what the AI proposed.
3. **Drafts are rows, never dispatches.** Caption drafting reuses the EXACT state law
   `updateVariant` enforces (re-validate, recompute `args_sha256`, invalidate any existing approval
   in the same statement) via a shared private helper — an AI-authored edit is still an edit. Idea
   drafting writes `social_posts` rows (`status='idea', source='ai'`), idempotent via a
   caller-supplied `ids` array. Nothing here can reach a live network.
4. **`ai.drafting` off refuses `ai_drafting_disabled` before any gateway egress**; a `wantImage`
   request refuses `image_generation_unavailable` before any gateway egress either — D-17's "no
   image path" boundary is enforced at the surface, not just documented.

Zero direct vendor calls asserted directly: `gateway-client.test.ts` proves every `/complete` call
targets the ONE configured gateway host (never a vendor SDK), and the cloudPolish `provider` hint is
a pure reorder — this module never asserts a vendor identity. 3 MCP tools added
(`social.ingestBrandCorpus`, `social.draftPostVariant`, `social.draftPostIdeas`), all
`write:true, impact:'low'` with the SAME `authorize()` calls as the HTTP surface. 59 new tests across
three files (22 pure prompt/hashtag unit tests, 5 gateway-client host-isolation tests, 10 golden-case
endpoint tests incl. the leak test) on top of the existing 50; **87/87 passing**. BFF contract §19
extended.

**0.3.0 (2026-08-13, SMM-08 - the composer backend, DEV-VERIFIED):** posts + per-network variants
CRUD, the media-rule validation engine, quota pre-check, `args_sha256` maintenance and the
native-import path. Three things worth naming:

1. **The hash is the estate's, not the module's.** `canonical-args.ts` reproduces the MCP hub's
   canonical-JSON algorithm and asserts its three PUBLISHED fixed vectors, because that value is
   what a single-use approval grant is bound to - if the two implementations drift by a byte,
   every approved publish fails at the grant check. Two standalone projects, no shared package,
   one contract held by copied vectors.
2. **Edit invalidates approval, mechanically.** A content edit recomputes the hash, NULLs
   `approval_id` and drops the variant back to `draft` in the SAME statement - there is no window
   in which an approval points at content nobody approved. Proven end-to-end against a real
   approval row, not asserted in a comment.
3. **Validation refuses what the API would refuse, before an approver is asked.** Per-network
   media/length/hashtag/settings rules plus the live quota, all pure functions so the composer,
   the submit gate and the dispatch re-check share ONE implementation. Caption length counts code
   POINTS (an emoji is one character, not two - counting UTF-16 units would have halved
   Instagram's real allowance). X's 280 is deliberately SOFT (premium tiers exist and we cannot
   see the account's), and an unknown quota WARNS rather than passing - `unknown` must never read
   as `zero used`, which is how you queue the 26th Instagram post of the day.

The network is always taken from the connector registry, never the request body, so a caller
cannot claim a different network to dodge its rules. 50 tests across three files (10 hash, 19
validation-matrix, 21 endpoint golden cases). Five MCP tools added; `submit` and `publish` remain
deliberately UNDECLARED until SMM-09 builds the gate that honours them. BFF contract SS19 extended.

**0.2.0 (2026-08-12, SMM-02 — the module shell, DEV-VERIFIED):** the `social` ModuleContract is
registered in `bootstrap()` and `SocialController` serves `/api/:tenantId/modules/social` behind
`AuthGuard` + `ModuleEnabledGuard("social")` — dark unless the company enables `social` OR an ACTIVE
`service_assignment` serves it (the served path is the normal one here). Endpoints: engagements CRUD,
the **scope dial** on its own endpoint and its own permission (`social.engagement.set_scope`, merged
one level deep under `FOR UPDATE` so a partial patch cannot erase what may be published), brand
profiles (config + WS8 pointers only, D-13), campaigns (`kind` fixed `'organic'`), KPI targets. Six
rollup metrics registered. **Built TO the agentic bar rather than retrofitted onto it** (the one
department that still could be): 4 MCP tools with the same authorize() calls as the HTTP surface,
snake_case refusal tokens an agent can branch on, caller-supplied-uuid idempotency so an
at-least-once retry cannot double-create, `setEngagementScope` impact-classified `medium` (so an
automation principal SUSPENDS into WS4 rather than moving the money dial unattended), and 14 golden
cases driving every capability through the real endpoint. Two bugs its own tests caught before
merge: refusal tokens thrown as `error` were being silently replaced by the global filter (they must
be `message`), and the brand-profile upsert's `COALESCE(EXCLUDED.…)` erased a client's brand voice on
any partial patch. Defaults enforce the owner decisions — every network OFF, `networks.x` false
(keeping the publish path $0 and D14-registry-eligible), `ai.imageGen` false and INERT with a named
warning, since no generative-image backend exists yet. BFF contract §19 documents the surface.

**0.1.0 (2026-08-12, SMM-01 + SMM-30 — the P0 substrate, DEV-VERIFIED against a real Postgres and a
real Cerbos compile):** migration `0105` creates the 16-table schema on **two deliberately different
RLS walls** — 14 `social_*` tables behind the third wall (`app_module_allowed('social')`),
`social_platform_apps` global with no RLS (our own app fleet: zero client data, credential *aliases*
only), and `social_post_client_reviews` on the **plain core tenant wall** because the client portal
writes it and portal controllers declare no module scope, where a third wall would read zero rows
silently (0088's D-2a lesson, applied before it could bite). Structural state law on the variants:
anything past drafting must carry both an approval and its `args_sha256`, a native import can never
carry an approval or a provider id, and `provider_post_id`/`approval_id`/`postiz_org_id` are each
claimable exactly once. Migration `0106` registers the module in the IAM layer — 36 catalog
permissions (35 `social.*` + `portal.approve_post`), 8 Cerbos policies, 9 permission groups, and the
two module roles **`social_staff`/`social_manager`** (names derived by `module_staff`/`module_manager`
from the module key, NOT the `smm_*` the design assumed — that would have repeated the silent-skip
defect 0069/0091/0097 each closed). Bundle diff: **861 → 1023 pairs, 162 added, 0 removed — no
existing user's access changed.** Policies ship with the ROLE arm only; the `perm_*` mirror waits on
the unresolved wildcard-bleed decision (PERMISSION-CONTRACT §2/§9). **No module code yet** — the
`ModuleContract` shell, controllers and console are SMM-02 onward, and nothing grants these roles to
anyone until a `service_assignments` row for `module_key='social'` exists.

**What else exists:** foundation research + architect design + the 2026-08-12 platform re-base. See
[`../blueprints/smm-foundation.md`](../blueprints/smm-foundation.md) (research + locked decisions) and
[`../blueprints/smm-design.md`](../blueprints/smm-design.md) (v1.0 design, Â§00â€“Â§14) + the print blueprint
[`../blueprints/GAIADA-Social-Media-Engineering-Blueprint.pdf`](../blueprints/GAIADA-Social-Media-Engineering-Blueprint.pdf).
A platform-nest module vertical (`ModuleContract` key `social`, tables `social_*`) + the reserved **Publish**
department console (Calendar Â· Composer Â· Inbox Â· Analytics). **Postiz** (AGPL-3.0) is the publishing engine
run **AGPL-CONTAINED** â€” an isolated container reached only over its REST API (mere aggregation; the ERP
stays uninfected); all domain state/tenancy/RBAC/approvals live outside Postiz, which sees a post only after
WS4 approval. No universal post object (master `social_posts` + per-network `social_post_variants`, quota/
media-rule validated pre-queue); a first-class connector registry (`social_accounts` + platform-app fleet,
OpenBao-custodied creds); AI local-Hermes-first via the gateway with brand-voice RAG (copy) + Creative Image
Studio (assets); **human-in-the-loop mandatory and stricter than SEO** â€” every public action is a WS4
high-impact suspension consuming a one-shot payload-hash-matched approvalId (no auto-publish, humans or
agents). One `social_usage_ledger` meters X per-post fees + generative credits (stop-loss chain); no shared
no-RLS cache (all social data client-private). Mixpost Pro is the documented paid fallback if containment
proves impractical; Chatwoot dropped (engagement uses Postiz's comment/collab surface, no second inbox stack).
**Scope v1 = organic publish + engagement + copywriting + digital assets; paid social ads, listening, and
influencer/UGC are parked as future service lines.**
**Future plans â€” RE-PLANNED 2026-08-12, see the addendum
[`../blueprints/smm-design-addendum-2026-08-12.md`](../blueprints/smm-design-addendum-2026-08-12.md)**
(binding over design Â§12). The base plan was written against the 2026-07-23 platform; six assumptions
expired (permissions are now catalog DATA with dotted keys + six parity guards; D14 is closed and carries a
canonical single-use-grant execute contract that replaces the bespoke payload-hash; the agentic-native bar is
binding per capability; there is **no image-generation backend** â€” the gateway has no generative endpoint and
`render-gateway-go` is `0.0.0`; the live client portal makes client post-approval a real surface; migrations
rebase `0034+` â†’ `0105+`). **30 tickets P0â€“P4 + 3 decision-gated:** P0 substrate/IAM/containment (incl. new
SMM-30 IAM registration + `smm_manager`/`smm_staff` roles) â†’ P1 publish loop on own accounts ($0, publish
registered as an executable approval; X ships disabled so the path carries no money) â†’ P2 inbox **+ client
approval via the portal** (new SMM-31/32, plain-tenant-wall table per 0088's lesson) â†’ P3 AI copy +
analytics + reports (attach-only assets) â†’ P4 agents + assistant. Decision-gated: SMM-28 Mixpost fallback,
SMM-29 ClipsAI video, SMM-34 generative images (gated on the Creative render gateway).

## creative â€” Creative Studio Â· `0.1.0` Â· PROTOTYPED

**What exists (dev):** the **Image Studio** â€” client-side auto-correct + hand-LUT colour-grading engine
(WebGL2 LUT shader + Canvas2D fallback, pure/unit-tested imaging lib, 35 UI tests, visually verified) â€”
plus **`creative_assets` persistence** (migrations `0031`/`0032`, `/api/:t/creative/assets` GET/POST/
content/DELETE + training-set curation) and a phase-2 grading-trainer scaffold (`creative-grading-trainer/`,
ONNX seam). Wired as the Creatives dept "Image Studio" tab. See [[creative-image-studio]].
**Known gaps:** the entire expansion below is **PLANNED â€” no code**: image/video generation + editing,
Magnific-replacement upscaling, and the shared DAM (collections/brand-kits/rights/CLIP visual search/
imgproxy renditions). Not in production.
**Foundation + design:** [`../blueprints/creative-foundation.md`](../blueprints/creative-foundation.md)
(research + 4 locked owner decisions + Magnific head-to-head) and
[`../blueprints/creative-design.md`](../blueprints/creative-design.md) (v1.0 design, Â§00â€“Â§14) + the print
blueprint `../blueprints/GAIADA-Creative-Engineering-Blueprint.pdf`.
A platform-nest module vertical (`ModuleContract` key `creative`, tables `creative_*`, third-wall RLS,
migration `0036`): `creative_assets` extended in place (kind/source/rights/license_class/reuse_status/
provenance/checksum/phash/CLIP embedding/caption) + versions, collections/brand-kits, `creative_render_jobs`,
`creative_usage_ledger`, per-client `creative_scopes`. **Build-light DAM on our own stack** (RLS store +
Shared Drive + pgvector CLIP visual/semantic search + BLIP auto-tag + imgproxy renditions) â€” no external DAM.
**Locked owner decisions (2026-07-23):** serverless/rent-by-second GPU first Â· hybrid image licensing
(commercial-clean default Qwen/SDXL/Z-Image, FLUX quarantined behind a paid opt-in) Â· hybrid video
(Wan 2.2 OSS + ~$100â€“300/mo Veo/Kling API budget) Â· build-light DAM. Default model stack is
commercial-license-CLEAN; SUPIR/FLUX-dev/RMBG/IC-Light-V2/SVD quarantined.
**Future plans (27 tickets CR-00â€“CR-26, /army-ready â€” design Â§12):** Phase 0 clarity-upscaler Replicate
spike (kill Magnific now, run inline) â†’ P0 contracts â†’ P1 upscale/Magnific-replacement via the Render
Gateway â†’ P2 image gen/edit â†’ P3 DAM search + cross-dept consumption â†’ P4 video + I2V. Opus-flagged:
CR-01, CR-06, CR-13; QA gates on CR-01/06/12/13/20. Open: OQ-1 FLUX procurement, OQ-2 owned-GPU tripwire,
OQ-3 video-vendor pick, OQ-8 AGPL/GPL counsel sign-off before P2 client volume.

## render-gateway-go â€” Creative Render Gateway Â· `0.0.0` Â· PLANNED

**What exists:** design only â€” the centerpiece of [`../blueprints/creative-design.md`](../blueprints/creative-design.md)
(Â§05). No code.
A separate Go service (mirror of `ai-gateway-go`): a **render job-queue** accepting typed jobs (upscale/
generate/edit/t2v/i2v/analyze), a **`RenderBackend` abstraction** (serverless GPU / self-host ComfyUI /
commercial API) routed per capability + license-class + cost + health, ComfyUI-workflow-as-versioned-JSON
with model manifests, short-lived signed per-job I/O URLs (backends never hold storage creds), an idempotent
`/api/internal/creative/render-callback`, a fail-closed **stop-loss** choke point (per-cost-class envelopes:
image $200 / video $300), a structural **license wall** (non-commercial models can never reach a client
deliverable), and egress audit. Outputs land in the `creative` DAM. Job state machine lives on platform-nest
rows; the gateway is Zone A egress-only.
**Future plans:** built under the `creative` P1â€“P4 tickets (CR-* â€” design Â§12); container-build verification
on a Docker host before deploy (same caveat as ai-gateway-go).

## reports â€” Work Tracker Â· Reports Â· Appraisal Â· `0.3.0` Â· PROTOTYPED

**Design:** [`../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md).

**What exists (dev-verified + prototyped, P0â€“P6 mostly complete as of 2026-07-31):**

**P0â€“P2 (substrate, facts, check-ins) â€” COMPLETE:**
- Substrate blockers closed: `pm_task_assignees` (relational with as-of-date intervals), 
  `org_unit_memberships` (as-of-date), work-activity consumer with real actor propagation.
- **Fact fabric (DEV-VERIFIED, 403+ tests):** `src/modules/reports/fact-job.ts` nightly/backfill 
  compute, owner-takes-all attribution, Î£person â‰¤ Î£unit = company reconciliation, idempotent 
  DELETE+INSERT slices, Â§5.3 leave-aware `auto_missed` check-ins.
- **Metrics + rollups (DEV-VERIFIED):** 21 metric seeds (`metrics.ts` catalog, `appraisalSafe` flags), 
  `RollupProvider` registered in `index.ts`, module-contract aggregated in the hub.
- **Check-ins (endpoints built):** `GET/POST /api/:t/checkins*`, compliance grid, excuse path, 
  pending-reminders for n8n (WA digest loop).

**P3â€“P4 (documents, exports, PDF) â€” COMPLETE (backend AND frontend):**
- **Documents (endpoints built):** `GET /api/:t/reports/document|overview|metrics`, live compute + 
  sealed-period storage, range validation (custom ranges â‰¤400 days), provider view (served-company slices).
- **Periods (endpoints built):** `GET /api/:t/reports/periods*`, pin/seal/amend, audit trail.
- **Exports (DEV-VERIFIED):** PDF sidecar (`report-renderer`, Playwright-based, 14 tests green), 
  XLSX/CSV service (`exceljs`), synchronous render-and-persist, unsealed-range `AD HOC` marking, 
  one-shot token auth on the print route.
- **Report UI (PROTOTYPED, verified in a real browser):** the inline-SVG chart kit
  (`platform-ui/src/components/reports/charts/` â€” KpiTiles/TrendLine/Grouped+StackedBars/Donut/
  CalendarHeatmap/Burndown/CumulativeFlow/CohortBand/DeltaChip, zero external deps so the CSP holds) +
  `ReportViewer` + `PeriodSelector` (Daily/Weekly/Monthly/**Custom range** + presets) + `WarningsBanner`,
  and **all four grain routes** at `platform-ui/src/app/(app)/reports/{person,project,department,company}`
  with the range in the URL (shareable/bookmarkable), a 403 limited-access branch and DEMO_MODE fixtures.
  **862 platform-ui tests green**, `next build` clean; light/dark/print verified by Playwright screenshot,
  which caught 3 defects a green build had passed.
- **Print route (PROTOTYPED):** `platform-ui/src/app/print/reports/[jobToken]/` + `print.css` â€” session-less,
  renders the SAME viewer components (no second rendering path), `AD HOC Â· UNSEALED` / `SEALED Â· rev N`
  provenance repeating on every page, **real multi-page PDFs rendered and inspected** across four grains Ã—
  sealed/unsealed.
- **Gaps:** nothing UI-side in P3/P4. The live `mint â†’ sidecar â†’ real print route â†’ PDF` hop has **not** been
  driven end to end (TR-20 and TR-21 each verified the shared contract by reading the other's source rather
  than touching a concurrently-modified tree) â€” owned by TR-29.

**P5â€“P6 (appraisal, MCP) â€” ENDPOINTS + TOOLS BUILT, NO UI:**
- **Appraisal engine (built, 50+ tests):** cycles, generate from sealed periods, manager scoring 
  (justified deviations Â±1 band), subject ack trail (append-only), finalize.
- **Appraisal endpoints:** `POST/GET /api/:t/appraisals/cycles|generate|*`, manager pack read, 
  subject `/mine` view, ack/dispute/finalize actions.
- **MCP tools (DEV-VERIFIED, all 6 registered):** `reports.getDocument`, `reports.listPeriods`, 
  `reports.getMetrics`, `reports.getCompliance`, `checkin.getToday`, `checkin.submit` 
  (hub integration + WA loop working).
- **Gap:** appraisal UI does not exist (employee acknowledgement surface, manager scoring pack, 
  cycle admin console missing). Endpoints are live and tested.

**Known gaps & deferrals:**
- **Report viewer + chart kit (TR-16/TR-17):** endpoints built, UI stubs only.
- **Appraisal UI (TR-26):** engine complete; no manager scoring screen, employee ack flow, or cycle console.
- **Print route (TR-20):** sidecar running, `/print/reports/[jobToken]` route does not exist.
- **Retroactive leave (TR-41):** compliance grid self-heals; stored check-in history diverges (marked known gap).
- **Production deployment:** entirely untouched. All endpoints verified against live Postgres + Cerbos + Redis; 
  code is DEV-VERIFIED with 400+ tests; no deployed build exists.

**Migrations:** `0054` (assignees), `0055` (memberships), `0056` (calendars/checkins/facts), 
`0057` (metric seeds), `0067` (periods/documents), `0068` (appraisals). 

**Future plans:** UI buildout (appraisal + viewer + print route) â†’ production validation â†’ close final gaps 
(retroactive leave, custom-range appraisal-generate explicitly 422ed).

## report-renderer â€” Print/PDF Sidecar Â· `0.1.0` Â· DEV-VERIFIED

**What exists (TR-19, `devops`, 2026-07-31):** the standalone `report-renderer/` component â€” a
~90-line Node + Express + Playwright service (the only image in the estate carrying Chromium;
platform-ui's Next standalone image stays browser-free by design). `GET /health` (no auth) and
`POST /render {url}` behind `Authorization: Bearer RENDERER_TOKEN` â€” `chromium.launch()` â†’
`page.goto(url, {waitUntil:'networkidle'})` â†’ `page.pdf({format:'A4', printBackground:true, ...
headerTemplate/footerTemplate with page numbers})`, lifting the print-CSS/PDF technique straight
from the working in-repo precedent `docs/blueprints/render-pdf.js` (exact-color printing,
footer page numbers) rather than rediscovering it. **SSRF guard (`src/auth.ts`,
`isAllowedRenderUrl`):** every `url` must be same-origin with `PLATFORM_UI_INTERNAL_URL` â€” this
service fetches whatever URL it is handed, so a leaked `RENDERER_TOKEN` cannot turn it into a
proxy against the internal network (mirrors ai-gateway-go's `DialContext` egress allowlist /
search-crawl-go's egress guard). Compose service added to `infra/compose/docker-compose.vps.yml`
(internal-only, no published port, healthcheck via `node -e fetch(...)` since curl/wget aren't
guaranteed in the Playwright base image), `docker-compose.local.yml` (dev-only published port
3007) and `docker-compose.build.yml`; `.env.example` gained `RENDERER_TOKEN` +
`PLATFORM_UI_INTERNAL_URL`; CI gained a `report-renderer` entry in both the `ci.yml` unit-test
matrix and the `release.yml` / `deploy.yml` image-build-and-verify list.
**Verified (2026-07-31):** `npm run typecheck` and `npm test` both green (14 tests â€” incl. the
acceptance-criteria check that a token-less `POST /render` returns 401). Docker **was** available
in this session (Docker Desktop, Windows/Linux-VM backend) so the container was actually built and
run, not just assumed: `docker build .` succeeds; `docker run` and, separately,
`docker compose -f docker-compose.vps.yml -f docker-compose.local.yml -f docker-compose.build.yml
up --no-deps report-renderer` both came up **healthy**; a real `POST /render` against an
allowed-origin URL made Chromium actually launch, navigate, and return a genuine PDF
(`file` reported `PDF document, version 1.4, 1 page(s)`, 12KB); token-less â†’ 401, wrong-token â†’
401, disallowed-origin â†’ 403 all confirmed against the live container; `docker compose config`
validated cleanly across all three compose files with `report-renderer` in the service list.
Exact commands + output logged in `docs/modules/CHANGELOG.md`.
**NOT verified:** a real deploy to the production Linux VPS (only Docker Desktop was available
here) â€” re-confirm health there before relying on it in production, per
`infra/runbooks/deploy-vps.md`. TR-20/TR-21 aren't built, so no real report renders through the
whole pipeline yet â€” only this sidecar's own contract (auth, SSRF guard, PDF render) is proven.
**Future plans:** TR-20 (`senior-fe`) builds the platform-ui print route this sidecar targets;
TR-21 (`senior-be`) builds the one-shot, 5-min-TTL, single-document `jobToken` orchestration that
mints the URLs this service is handed â€” until then `PLATFORM_UI_INTERNAL_URL` points at a real
origin but no route actually serves `/print/reports/:jobToken`. âš¡ QA gate on the TR-21 token path
(auth bypass by construction) once it lands.
