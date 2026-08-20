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

**`Alpha 01.049.0101a`** â€” see [`VERSIONING.md`](./VERSIONING.md) for the format, and

[`/VERSION`](../../VERSION) for the machine-readable source. The app version composes the module
versions below; the running build reports it at `GET /health`.

---

## Registry (at a glance)

| Module | Ver | Status | Workstream | Since |
|---|---|---|---|---|
| platform-nest | `0.32.0` | IN PROGRESS | WS1 | 2026-08-20 |
| platform-ui | `0.28.0` | IN PROGRESS | WS5 | 2026-08-20 |
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
| social-media | `0.5.5` | IN PROGRESS | Social Media | 2026-08-20 |
| monitoring | `0.2.0` | IN PROGRESS | Monitoring | 2026-08-19 |
| creative | `0.1.0` | PROTOTYPED | Creative | 2026-07 |
| render-gateway-go | `0.0.0` | PLANNED | Creative | 2026-07-23 |
| reports | `0.3.1` | PROTOTYPED | Cross-cutting | 2026-08-03 |
| report-renderer | `0.1.0` | DEV-VERIFIED | Cross-cutting | 2026-07-31 |
| mail | `0.0.19` | IN PROGRESS | Cross-cutting | 2026-08-06 |

---

## platform-nest â€” Platform Core Â· `0.26.0` Â· PROTOTYPED
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

## platform-ui â€” ERP Suite Â· `0.25.1` Â· PROTOTYPED

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

## social-media — SMM · Organic Publishing · `0.5.5` · IN PROGRESS

**0.5.5 (2026-08-20, SMM-21 — metrics: `pullMetrics` nightly ingest + Analytics tab):** P3's first
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
