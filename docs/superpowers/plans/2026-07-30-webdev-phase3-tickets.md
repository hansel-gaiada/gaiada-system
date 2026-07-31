# Web Dev — Phase 3 Ticket Plan (external wiring)

> ⚠️ **PARTIALLY SUPERSEDED (2026-08-01).** Waves 1–2 have LANDED (WD-28, WD-26, WD-29 —
> all DEV-VERIFIED, see `docs/modules/CHANGELOG.md`). **WD-23A and LD-13 are superseded by
> [`2026-08-01-wd23a-respec.md`](./2026-08-01-wd23a-respec.md)** — the SEO programme shipped a
> complete, adversarially-verified Google OAuth core *after* this plan was written, so WD-23A
> becomes a promote-to-core refactor (split WD-23A-1 / WD-23A-2) instead of a from-scratch build.
> Do **not** implement LD-13's Redis-nonce state store. Everything else in this plan stands.

**Status:** READY for /army — Waves 1–2 immediately (credential-free); Waves 3+ gated on owner
actions (OQ-2 / OQ-9 / OQ-3, see "What blocks Phase 3") · **Date:** 2026-07-30 ·
**Architect:** system-architect (Fable·max)
**Governing design:** `docs/blueprints/webdev-design.md` §12 Phase-3 sketch (reserved WD-21…WD-27),
§03 (trust zones), §04 (D-2 core-vs-module walls), §07 (AI routing), §09 (integration points),
§11 (security), §13 (open questions), §14 (decision log D-1…D-13) ·
**Source scope:** `docs/superpowers/plans/web-dev-integrations-plan.md` Phase 2 (Tracks A / B / C2 / D)
**Substrate:** integrations Phase-1 (`web-dev-phase1-tickets.md` P1-01…P1-11, closed by WD-20) and
webdev Phase-1 (WD-01…WD-08) are both **DEV-VERIFIED** — evidence:
`2026-07-30-wd20-evidence.md`, `2026-07-30-wd08-evidence.md`, `2026-07-29-wd01-evidence.md`.
**Contract:** `docs/FRONTEND-BFF-CONTRACT.md` (BE tickets update it; work-activity is §11,
connections §12, claude seats §12a; new Phase-3 surfaces take §15+ — §13/§14 are consumed by
Creative/search-marketing).

Phase 3 = wire the externals the code-first program deliberately deferred: GitHub org App +
webhook receiver, per-user Google Drive OAuth (two-way), Anthropic Admin usage, and the AI
digest/nag automation — all landing on the **shipped** work-activity spine (`work_activity` +
linker + `ingestWorkActivity`) and connections vault (`integration_connections` + `secret-box`).
**No new deployable, no new module** (design D-1/D-11: everything here is core platform-nest +
platform-ui + mcp-hub + n8n).

---

## Changes from the §12 sketch (say-what-changed, per the design's own instruction)

1. **WD-23 split → WD-23A / WD-23B.** The sketch's single Drive ticket bundles the OAuth
   handshake, token lifecycle, read APIs, two-way writes, AND the change-detection poll — well
   past the Phase-1 ~230k-token/ticket calibration, and it mixes the security-critical seam
   (handshake/custody) with routine API work. 23A = handshake + custody + read (opus-flagged);
   23B = two-way writes + change sweep (medior, rides 23A's plumbing).
2. **Repo read endpoints moved WD-21 → WD-22.** WD-21 stays the pure trust-boundary ticket (App
   client, webhook receiver, login mapping, linker rules); WD-22 becomes end-to-end "Repositories
   live" (thin BE reads over WD-21's App client + the FE tab). Keeps the ⚡ ticket small and the
   review surface focused.
3. **NEW WD-28 — PM short-codes.** Adopts OQ-7's stated default ("add per-project short-code +
   sequence at the start of Phase 3") as its own ticket instead of burying it inside WD-21.
   It is a core-PM schema change with a backfill and a concurrency-correct allocator — wrong shape
   to smuggle into a webhook ticket, and it is independently valuable (humans get `WEB-142`).
4. **NEW WD-29 — pipeline state-transition idempotency (DEF-2 fix).** The briefing asked whether
   the DEF-2 class threatens Phase 3 and whether an idempotency primitive belongs here rather than
   deferred with Temporal. Assessment: Phase 3's own inbound paths are **safe by construction**
   (every inbound write funnels through `ingestWorkActivity`, whose
   `UNIQUE(tenant_id, source, source_ref)` is the idempotency primitive — WD-08 §1.6 confirms
   DEF-2 lives specifically in the *pipeline stage* write path, where two n8n webhook triggers
   recompute run state with no lock). But Phase 3 multiplies event traffic on the same backbone,
   the duplicates are client-facing (portal/console show doubled stages), and the durable fix is
   bounded and platform-side (serialize per-run transitions; Temporal stays deferred per the
   design's non-goal). Promoted into Phase 3 as its own ticket.
5. **WD-26 absorbs the n8n hygiene backlog.** WD-08 filed two n8n regressions (WD-08-R1: bridge
   webhook returns HTTP 200 on bad secret; WD-08-R2: dedupe response omits `runId` — both in
   `mtg-dispatcher.json`). WD-26 is Phase 3's **sole n8n owner** (imports + restarts race — the
   single-agent rule), so those fixes ride it, and its new flows are built to the corrected
   response-node discipline from day one.
6. **No WD-20-R1 ticket.** The sketch-era regression (`work_activity` missing the
   `group_executive` carve-out) is **already fixed** in `resource_work_activity.yaml` (comment
   dated 2026-07-30) and re-confirmed live by WD-08 §2.6. The phase1-tickets doc / WD-20 evidence
   still call it "filed, not fixed" — stale; WD-27 re-runs the matrix test as a parity check only.
7. **Digests ride `llm.summarize`, not a WS8 runner goal (deviation from §07/§10, flagged).**
   The shipped CRON-flow family (`compliance-gate-nag`: read tool → `llm.summarize` → `notify`)
   is exactly the digest shape, and no n8n→agent-runner seam exists today (specialists v2 arrive
   in P4/P5). Building that seam now would be invention for a notify-only flow. The WS8 upgrade
   remains a clean later swap because the flow's tool-call shape is preserved (same D-10
   principle the design applies to `design.prototype`). This is a refinement, not a relitigation
   — if the owner wants the WS8 seam now, say so before Wave 1.

---

## Owner decisions — required (each unblocks a track; none blocks Waves 1–2)

| # | Decision / action | Unblocks | Default if unanswered |
|---|---|---|---|
| OQ-2 | **GitHub org + App registration** (org name; who registers the App; where the private key + webhook secret live pre-OpenBao). The App needs: repo metadata+contents read, PR read, webhook events push/pull_request/pull_request_review/deployment_status, a webhook URL reachable from GitHub (dev: a tunnel; prod: the VPS), and installation on the org | WD-21 → WD-22 | Track A does not start |
| **OQ-9 (NEW)** | **Google OAuth client** — the design's §13 table omits this entirely; surfaced here as a new owner action. Needed: a Google Cloud project OAuth 2.0 **Web application** client (client id + secret), authorized redirect URI(s) `https://<erp-host>/api/integrations/google/callback` **and** `http://localhost:3004/api/integrations/google/callback` (dev), consent screen (Internal if the org is Google Workspace; else External + test users), scopes `drive.readonly` + `drive.file` | WD-23A → WD-23B → WD-24 | Track B does not start |
| OQ-3 | **Anthropic Admin API key** (org admin key, `ANTHROPIC_ADMIN_KEY`) | WD-25 | Per design default: seat registry stays value-without-metrics (already landed); WD-25 waits |
| OQ-7 | PM short-code format confirmation — WD-28 implements the design default (per-project code + per-project sequence, display `CODE-SEQ`). Owner may override the auto-derived backfill codes per project later; the mechanism doesn't change | Nothing (default adopted) | Proceed with default |

---

## Locked design decisions (implementers do NOT re-derive these)

**Inherited hard constraints, restated:** D-11 — the GitHub webhook receiver lands in **core**
(`platform-nest/src/core/`), never the `webdev` module. D-2 — `work_activity` /
`integration_connections` / pipeline tables stay core (plain tenant wall); Phase 3 creates **no**
`webdev_*` third-wall tables. §03/§11 — signature verify **before parse**; idempotency by
delivery/event id; inbound events create `work_activity` rows **only**, never a privileged
transition. Token custody — AES-256-GCM via `secret-box`, columns never serialized, `hasToken`
only; every ticket touching tokens re-asserts it in tests.

1. **Migration numbering — verify, never inherit.** Live ledger head is
   `0049_meeting_recordings_audio_ref.sql` (verified on disk AND in the DB **today**, 2026-07-30).
   The design's D-12 "webdev takes `0049+`" correction is itself already stale — `0049` was
   consumed by WD-04 the same week. **No ticket in this plan is assigned a fixed number.** Every
   DDL ticket (WD-28, WD-29, WD-23B) takes **next-unused at merge time** per
   `platform-nest/migrations/README.md` rule 5, re-checking the ledger at merge and coordinating
   with the SMM-01 and CR-01 programs, which are live and racing for the same block.
2. **GitHub webhook receiver** = `platform-nest/src/core/github-webhook.controller.ts`,
   `POST /api/webhooks/github`. HMAC-SHA256 of the **exact raw request bytes** vs
   `X-Hub-Signature-256`, compared with `crypto.timingSafeEqual`, **before any JSON.parse**
   (Nest+Fastify raw-body capture is the implementer's mechanism to verify — `rawBody: true` on
   the app factory or a Fastify content-type parser; the requirement is the raw-bytes MAC, not the
   mechanism). Fail-closed: `GITHUB_WEBHOOK_SECRET` unset → 503 (mirror `secret-box`); bad/missing
   signature → 401 with a generic body; body size cap 5 MB. Valid but unhandled event types → 204
   drop. Handled events respond 2xx fast (GitHub's 10s budget) — processing is a row insert, no
   queue needed in v1.
3. **Tenant resolution (installation → tenant):** a company-scoped `integration_connections` row
   — `owner_kind='company'`, `provider='github'`, `external_account=<org login>`,
   `meta.installationId=<id>` — created by an admin via the shipped Connections API when the App
   is installed. The receiver resolves `payload.installation.id → tenant_id` via a **narrow**
   non-tenant-scoped lookup (the same class of system query the outbox relay/consumers already
   use; returns only `tenant_id`). Never blanket-bypass RLS for this. Unknown installation → 204
   drop + structured log (a 4xx would make GitHub retry forever).
4. **Only write path = `ingestWorkActivity()`** (`src/core/work-activity-ingest.service.ts` —
   `WORK_ACTIVITY_SOURCES` already contains `github`/`google_drive`/`claude`; the 0030 CHECK
   accepts them). Idempotency keys (`source_ref`): push commit → `gh:<deliveryId>#<commitSha>`;
   PR/review/deployment event → `gh:<deliveryId>`; Drive attach → `drv:attach:<fileId>:<targetId>`;
   Drive change → `drv:change:<fileId>:<changeTsOrRevisionId>`; Claude usage →
   `claude:usage:<date>:<seatEmail>`. Duplicate delivery ⇒ the UNIQUE dedupes (existing
   `ON CONFLICT` semantics) — this is the structural DEF-2-class defense for all Phase-3 inbound
   paths, and WD-27 probes it adversarially.
5. **Event allowlist v1 (keep small):** `ping` (200, no row), `push` (one row per commit, verb
   `pushed`), `pull_request` (opened/closed/merged/reopened → verb `pr_<action>`),
   `pull_request_review` (verb `reviewed`), `deployment_status` (verb `deployed`). Payload keeps
   `{repo, ref/branch, title, url, sha}` slims — never the full GitHub payload blob.
6. **GitHub App custody + coexistence:** env `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
   (base64-encoded PEM), `GITHUB_WEBHOOK_SECRET` in `infra/compose/.env` → OpenBao target-state;
   add all three to `.env.example` (which is missing even `INTEGRATION_TOKEN_KEY` — backfill that
   row too, see stale-claims). The existing hub delivery-tool envs `GITHUB_TOKEN`/`GITHUB_ORG`
   (used by `github.repoStatus`/`createRepo`, proven fail-closed in WD-08 §1.7) **stay separate
   in v1** — consolidation onto App auth is a later ticket, not this phase.
7. **App client** (`src/core/github-app.service.ts`): RS256 App JWT → installation access token
   (`POST /app/installations/:id/access_tokens`), cached ~50 min, single-flight mint; repo list
   via `GET /installation/repositories` with a short in-process TTL cache (no repo table — the
   feed and `work_activity` are the persistent record). Raw `fetch`, no SDK dependency (estate
   precedent: `dataforseo.ts`).
8. **Per-person login mapping:** user-owned `provider='github'` connection rows,
   `external_account` = GitHub login — self-service via the shipped Connections UI/API + Cerbos
   policy (no new schema, no new policy). The linker's actor rule maps `sender.login → user` via
   these rows (resolved by the caller into `LinkerContext`, keeping the engine pure).
9. **Linker GitHub rules** extend `deriveLinks` exactly at the file's documented Phase-2
   extension point (pure rule, caller resolves ids): scan branch name + commit message + PR title
   for `/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/`; caller resolves `(short_code, seq) → pm_task id` into
   `ctx`; matched task → link `confidence:'exact'`, rule `github:short_code` (an explicit human
   reference is hint-grade); the existing uuid-scan and derived-chain rules still apply after.
10. **Short-codes (WD-28):** additive migration — `projects.short_code text NULL` +
    `UNIQUE(tenant_id, short_code) WHERE deleted_at IS NULL AND short_code IS NOT NULL`;
    `projects.task_seq int NOT NULL DEFAULT 0` (the per-project counter);
    `pm_tasks.seq int NULL` + `UNIQUE(tenant_id, project_id, seq) WHERE seq IS NOT NULL`.
    Allocation on task create = single statement
    `UPDATE projects SET task_seq = task_seq + 1 WHERE id=$1 RETURNING task_seq` (atomic, no
    advisory lock needed). Backfill: derive each project's code from its name (first 3–4
    uppercase alnum, numeric suffix on collision), then number existing tasks by `created_at`.
    Display form `CODE-SEQ` (`WEB-142`) exposed on PM task GET/list + board card + task detail.
    Codes are owner-renamable later (rename does not renumber tasks).
11. **DEF-2 fix shape (WD-29):** serialize *pipeline run state transitions* in platform-nest —
    every stage-create/stage-update/gate-decide write for a run executes inside a transaction
    holding `pg_advisory_xact_lock(hashtextextended(run_id::text, 0))`; add a **partial unique
    guard** on auto-created extraction stages (the duplicated class: `UNIQUE(run_id, track, name)`
    scoped to extraction-stage names only — revise-loop `claude_design` revisions are legitimately
    repeated, WD-08 §1.6, so the index must NOT cover them); ship a data-repair migration that
    removes the existing duplicate `claude_design` rows (keep-oldest, only where truly identical
    duplicates from the race — the 4-and-2 duplicates named in the briefing) before the index.
    `pipeline-delivery.json` is **not edited** — the n8n workflow stays byte-identical (D-10
    spirit); the fix is entirely under the tools' platform endpoints.
12. **DEF-3 constraint (encode, don't fix):** every Phase-3 automation is read / append
    (`work_activity`) / notify-only — LOW impact. None may perform a medium+ write; any future
    escalation (e.g. stale-nag auto-reassign) waits on the owner's DEF-3 decision (an
    `approvals.request` node after the D14 suspend, or an impact reclass). State this in WD-26's
    AC so it is tested, not assumed.
13. **Drive OAuth flow (WD-23A):** `GET /api/:tenantId/integrations/google/connect` (auth'd) →
    mint a 128-bit nonce, store server-side in Redis `oauth:state:<nonce>` =
    `{tenantId, userId, iat}` TTL 10 min → 302 to Google with
    `state=<nonce>&access_type=offline&prompt=consent&scope=drive.readonly drive.file`.
    Callback = **static path** `GET /api/integrations/google/callback` (no tenant segment — the
    OAuth client allows fixed redirect URIs): load+delete the state (single-use), require the
    caller's **session user == state.userId** (kills login-CSRF/state-fixation — a forged or
    replayed state, or another user's callback, is 403), exchange the code (confidential client,
    secret from env `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`), seal tokens via the
    shipped `setConnectionTokens()` into the caller's per-tenant `provider='google_drive'` row
    (`status='linked'`), record the **granted** `scope` param (not the requested set) into
    `scopes[]`, redirect back to the Connections tab. Refresh: single-flight per connection,
    refresh ≤5 min before expiry, `invalid_grant` → `status='error'` + notification + `hasToken`
    stays true until re-link. Raw REST via `fetch` (no `googleapis` dep).
14. **Drive storage decisions (WD-23B):** per-project folder id = additive core column
    `projects.drive_folder_id text NULL` (exact 0029 `department_id` pattern; created in the
    acting user's Drive on first use, idempotent — if set, reuse). Change cursor =
    `meta.driveChangesCursor` on the user's connection row (jsonb, no DDL). **Change sweep = an
    in-process chained-setTimeout loop** (`startDriveSweepLoop`, mirroring
    `src/modules/pm/burndown-job.ts` / the consumer loops; Redis-gated start in `main.ts`;
    interval env `DRIVE_SWEEP_INTERVAL_MS` default 10 min; single-instance assumption documented)
    — NOT an n8n flow: tokens never leave platform-nest and it keeps Phase 3's n8n footprint
    confined to WD-26. Two-way ops v1: list/search files; attach file → task/project (writes the
    activity row + exact links, plus payload `{name, mimeType, webViewLink, iconLink}`); create
    per-project folder; move an existing Drive file into the project folder; push an ERP `files`
    attachment (by files id, size-capped) up to the folder. Attach authz = member `inTenant` +
    the caller's own linked connection; the activity row is system-written server-side.
15. **Claude usage pull (WD-25):** env `ANTHROPIC_ADMIN_KEY` (platform-nest only; never the
    gateway — this is org administration, not inference). Same in-process loop pattern as #14
    (`startClaudeUsageLoop`, daily, env-gated: loop simply doesn't start without the key —
    fail-soft). Map usage records to seats via the shipped `provider='claude'` connection rows
    (`external_account` = seat email); unmatched actors land unlinked (feed-visible, linkable
    later). Rows: `source='claude'`, `verb='usage'`, payload = the day's per-seat metrics,
    `source_ref` per #4. **Exact Admin API endpoint paths/shapes are verified against the live
    Anthropic administration docs at build time** (per-user Claude Code analytics + org
    usage/cost reports — the admin key is a distinct `sk-ant-admin…` credential); the AC pins
    behavior, not URL strings.
16. **Digest/nag flows (WD-26):** two n8n CRON workflows modeled on `compliance-gate-nag.json`
    (read → `llm.summarize` → `notify`): `wd-digests.json` (daily 17:00 + weekly Fri per-person
    and per-project digests) and `wd-stale-nag.json` (daily; open pm_tasks with **no
    `work_activity` in N=5 days** → notify assignee; ≥2N → also notify the project owner).
    Distinct from the existing `task-sla.json` (due-date SLA escalation on core tasks) and
    `digest-fanout.json` (WA-bot digests) — name the difference in the workflow descriptions.
    New scoped accounts `wf:wd-digests`, `wf:wd-stale-nag` (per-flow scoping doctrine):
    `AUTOMATION_ALLOWLIST` entries in `mcp-hub/src/automation-policy.ts` + seed rows in
    `platform-nest/src/seed/automation.ts` (note: that seed still hardcodes
    `AGENCY_NAME="Gaiada Creative"` vs the live tenant "Gaia Digital Agency" — a known fresh-box
    trap flagged by WD-01; do NOT silently rename, it is an owner naming decision).
    New hub read tools (hub-native, like the pipeline tools): `workActivity.feed` → fronts
    `GET /api/:t/work-activity` (the existing `activity.feed` tool reads the OLD flat
    `activities` audit table — it does NOT serve this feed; do not reuse it) and
    `workActivity.staleTasks` → fronts a new BE read
    `GET /api/:t/work-activity/stale-tasks?days=N` (open pm_tasks with no linked activity since
    N days; add to `work-activity.controller.ts`). Deterministic **relink sweep**:
    `POST /api/:t/work-activity/relink` (admin/service; re-runs the pure linker over rows with
    zero links, bounded batch) + a weekly call from `wd-digests` — AI-suggested linking is out of
    v1. Also in this ticket: the **WD-08-R1 fix** (explicit error Respond-node/onError branch in
    `mtg-dispatcher.json` returning 401/403 with a generic body when the secret check throws —
    and the same discipline in both new flows) and the **WD-08-R2 fix** (dedupe branch echoes the
    original `runId`).
17. **Cerbos:** one new policy, `resource_github_repo` (read-only mirror data): `read` for
    member/team_lead/manager/company_admin/viewer gated `inTenant && notLow`; **`group_executive`
    gets its own global rule gated `notLow` only — never `inTenant`** (the WD-20-R1 lesson: a
    global cross-company role can never satisfy `inTenant`); `platform_admin` `*`. Extend
    `src/rbac/cerbos-webdev-matrix.test.ts` with the grid. **Every ticket that adds/edits a
    policy must restart the Cerbos container in its verification steps** — on this Windows
    Docker Desktop setup Cerbos does NOT hot-reload bind-mounted policy edits.
18. **Contract/doc upkeep:** BE tickets add rows to `docs/FRONTEND-BFF-CONTRACT.md` — extend §11
    (feed now carries github/google_drive/claude sources; stale-tasks + relink endpoints), §12
    (OAuth connect/callback + provider-data endpoints), §12a (usage metrics); new **§15 GitHub
    surfaces** and **§16 Drive surfaces** with shapes canonical in NEW `platform-ui/src/lib/github.ts`
    and `lib/drive.ts`. MODULES.md: `webdev` is `0.7.0 · IN PROGRESS` — first Phase-3 merge bumps
    the minor (0.8.x) + CHANGELOG per the status-language rule (PLANNED / IN PROGRESS /
    PROTOTYPED / DEV-VERIFIED — never "built/done").

---

## Execution waves (1–2 agents; live-verification windows are EXCLUSIVE)

Phase-1 lesson, encoded: **parallelism is cheap for code and expensive for live verification** —
a FE rebuild concurrent with a live console walk produced `ECONNRESET` noise and cost a clean
gate pass (WD-20 §7), and n8n imports + restarts race (single-agent rule). Rules for this phase:
two agents may CODE concurrently only on disjoint areas; only ONE agent touches the live stack
(migrations, n8n import/activate, Cerbos restart, dev-server, live walks) at a time — waves
below name the live-window owner; **all n8n JSON work lives in WD-26's agent, ever** (the two
in-process sweeps in 23B/25 deliberately avoid n8n so this holds).

```
W1 (today):        WD-28 (senior-be: PM short-codes)      ∥  WD-26 (medior: digests/nag/relink + n8n hygiene)
                   — disjoint files; live window: WD-26 owns n8n import/activate; WD-28 applies its
                     migration only after WD-26's live wiring settles (end-of-wave, coordinator-ordered)
W2 (today+):       WD-29 (senior-be, opus·medium) ALONE — its live re-drive + concurrent-delivery probe
                     needs a quiet stack (no other live work during its verification window)
W3 (per OQs):      WD-21 (senior-be, Track A)             ∥  WD-23A (senior-be, opus·medium, Track B)
                   — both unblock independently; if only one OQ has landed, run it solo and slot
                     WD-25 (if OQ-3 landed) as the second seat. Live windows serialized:
                     webhook forgery probes vs OAuth walk never overlap
W4:                WD-22 (medior: Repositories live)      ∥  WD-23B (medior: Drive two-way + sweep)
W5:                WD-24 (medior: Deliverables tab)       ∥  WD-25 (medior: usage pull — here at latest)
W6:                WD-27 (qa: Phase-3 gate) ALONE, last — nothing else touches the stack during it
```

Graph: WD-28 → WD-21 (linker short-code resolution) · WD-21 → WD-22 · OQ-9 → WD-23A → WD-23B →
WD-24 (24 needs both) · OQ-3 → WD-25 · WD-26/WD-29 independent · all → WD-27.

**Buildable today with zero external credentials:** of the sketch's reserved seven, **WD-26 is
the one ticket buildable today** (it rides the landed `work_activity` spine + the existing
n8n/hub backbone and needs no key). The two tickets this plan adds (WD-28, WD-29) are also
credential-free — together they form Waves 1–2, so Phase 3 **starts now** regardless of owner
actions.

---

## Tickets

⚡ = QA-gated path (adversarial probes in WD-27 + architect design-review on the diff).
Model = seat default (senior Sonnet·high, medior Sonnet·medium, qa Sonnet·medium) unless flagged.

| ID | Title | Tier | Model·Effort | Files / areas | Deps | Acceptance (done when) | QA ⚡ / risk posture |
|---|---|---|---|---|---|---|---|
| WD-28 | **PM short-codes** (OQ-7 default): `projects.short_code` + per-project `task_seq` counter + `pm_tasks.seq`, atomic allocation on create, backfill, `CODE-SEQ` exposed in PM API + board card + task detail | senior-be | Sonnet·high (default) | migration (**next-unused** per LD-1); `src/modules/pm/pm.controller.ts` (create + reads); backfill in-migration; `platform-ui/src/components/pm/*` (card/detail render); `lib/pm.ts` type; contract §5 row; tests | — | Two concurrent task creates in one project get distinct `seq` (test drives the single-statement counter); backfill gives every existing project a unique code + every task a seq; GET list/detail return `shortCode`/`seq`/display code; board + detail render it; uniques enforced; `tsc` + BE suite green; migration applied to the dev DB in its live window | risk: MEDIUM — core-PM schema + backfill over live data; additive, no behavior change to existing flows; concurrency pinned by LD-10 so no Opus |
| WD-29 ⚡ | **Pipeline state-transition idempotency (DEF-2 fix):** advisory-xact-lock serialization of per-run stage/gate writes in platform-nest + partial unique guard on extraction-stage identity + data-repair of existing duplicate `claude_design` rows; `pipeline-delivery.json` untouched | senior-be | **opus·medium** — a concurrency fix whose failure mode is silent (races pass ordinary tests; a subtly wrong lock scope quietly reintroduces duplicate client-facing stages), and verification needs a deliberately-racing driver; cheap-then-escalate would burn a full re-run plus a re-gate | `src/core/pipeline.controller.ts` (+ its service/write helpers); repair+index migration (**next-unused**); new concurrent-redelivery test (two simultaneous `gate.decided`-shaped writes); live re-drive per the WD-01 recipe | — (W2, quiet stack) | A test firing two concurrent stage-creating transitions for one run yields exactly one stage row (lock proven, not sleep-based); repair migration removes the known duplicate rows and the partial unique holds; revise-loop revisions still create their legitimate second `claude_design` (WD-08 §1.6 sequence re-drivable); full pipeline suite + a live re-drive green; workflow JSON byte-identical | ⚡ YES — client-facing state integrity; DEF-2 register: `2026-07-30-wd08-evidence.md` §1.6 |
| WD-26 | **Digests + stale-nag + relink + n8n hygiene:** `wd-digests` + `wd-stale-nag` flows (LD-16), `workActivity.feed`/`workActivity.staleTasks` hub tools, stale-tasks + relink BE reads, `wf:wd-*` accounts (allowlist + seed), WD-08-R1 + WD-08-R2 fixes in `mtg-dispatcher.json` | medior | Sonnet·medium (default) | `automation/workflows/{wd-digests,wd-stale-nag,mtg-dispatcher}.json`; `mcp-hub/src/platform-tools.ts` (or sibling) + `automation-policy.ts`; `platform-nest/src/core/work-activity.controller.ts`; `src/seed/automation.ts`; hub + BE tests; live import/activate/restart | — (buildable today) | Manually-triggered `wd-digests` produces a real per-person digest notification from live feed rows via `llm.summarize` (bell verified); `wd-stale-nag` nags a seeded stale task and escalates at 2N; relink links a deliberately-unlinked row; new tools invisible to other `wf:*` accounts (allowlist test); **bad-secret POST to the dispatcher now returns 401/403** (R1) and a dedupe re-post echoes the original `runId` (R2); flows are notify/append-only — no medium+ write anywhere (LD-12); re-import clean; evidence attached | risk: LOW-MED — additive flows on shipped backbone; n8n single-agent rule; owns W1's live window |
| WD-21 ⚡ | **GitHub App client + webhook receiver + login mapping + linker rules** (Track A trust boundary): App JWT/installation-token client, `POST /api/webhooks/github` per LD-2..6, installation→tenant resolution, per-person login mapping consumption, linker `github:short_code` + actor rules | senior-be | Sonnet·high (default) — deliberately NOT Opus: the HMAC-verify pattern is cookbook, blast radius is structurally capped (only `ingestWorkActivity`, no privileged transitions), idempotency rides the shipped UNIQUE, and WD-27 adversarially probes forgery; the ACs pin every security invariant | NEW `src/core/github-webhook.controller.ts`, `src/core/github-app.service.ts`; `work-activity-linker.ts` + `work-activity-ingest.service.ts` (context resolution); `main.ts` raw-body config; env + `.env.example` (incl. the missing `INTEGRATION_TOKEN_KEY` row); contract §15; tests | OQ-2; WD-28 (linker resolution) | Forged/missing signature → 401 **without parsing** (test asserts no parse side effects); secret unset → 503; replayed delivery id → no duplicate rows; unknown installation → 204 + log; a real (or fixture-replayed) push with `WEB-<seq>` in the branch lands a feed row exact-linked to the task, actor mapped via the login row; tokens/private key never in any response or log line; hub `github.repoStatus` path untouched (regression test); Cerbos untouched this ticket | ⚡ YES — inbound trust boundary + secret custody; probed by WD-27 |
| WD-22 | **Repositories tab live:** thin BE reads over WD-21's client (`GET /api/:t/integrations/github/repos`, per-repo recent PRs/commits) + `resource_github_repo` policy (LD-17) + FE tab replacing the teach-state + person-profile "my repos" card | medior | Sonnet·medium (default) | BE routes in `src/core/integrations.controller.ts` (or sibling); `cerbos/policies/resource_github_repo.yaml` + matrix-test rows; NEW `platform-ui/src/lib/github.ts`; `(app)/departments/[deptId]/repositories/page.tsx`; `people/[userId]` card; `demoFixtures.ts`; contract §15 rows | WD-21 | Tab lists real org repos with recent activity (feed-joined) live; per-repo drill shows that repo's `work_activity`; member can read, exec can read cross-company (matrix test incl. the `notLow`-not-`inTenant` exec rule), rival tenant cannot; degrades to teach-state without a company connection; **Cerbos container restarted** after policy sync and verified; DEMO + live e2e green | risk: LOW — read-only mirror; policy follows LD-17 verbatim |
| WD-23A ⚡ | **Drive OAuth handshake + token lifecycle + read APIs** (Track B trust boundary): connect/callback per LD-13, sealed tokens via `secret-box`, granted-scope recording, refresh single-flight, list/search endpoint | senior-be | **opus·medium** — OAuth account-linking CSRF/state machine + real-token custody on write-capable scopes; state-validation bugs pass happy-path tests and are exploit-grade (they silently bind the wrong Google account to a user); same rationale class as P1-08's flag (this ticket puts the first real tokens into that vault) | `src/core/integrations.controller.ts` (+ google service NEW `src/core/google-drive.service.ts`); Redis state store; env `GOOGLE_OAUTH_CLIENT_ID/SECRET` + `.env.example`; `GET /api/:t/integrations/google/files?q=`; contract §12/§16; tests | OQ-9 | Full round-trip live: connect → Google consent → callback → row `linked` with `hasToken:true` and ciphertext-only in DB; forged state 403, replayed state 403 (single-use), cross-user callback 403 (session≠state.userId) — all test-proven; granted scopes recorded from the `scope` response param; refresh single-flight under parallel calls (test); `invalid_grant` → `status='error'` + notification; list/search returns the linked user's files; token non-exposure re-asserted on every new response shape | ⚡ YES — OAuth/CSRF + token custody; probed by WD-27 |
| WD-23B | **Drive two-way + change sweep:** attach-as-deliverable, per-project folder create (+ `projects.drive_folder_id` migration), move/push into folder, `startDriveSweepLoop` change-detection per LD-14 | medior | Sonnet·medium (default) | `google-drive.service.ts` + controller routes; migration (**next-unused**) for `drive_folder_id`; NEW sweep loop + `main.ts` Redis-gated start; `work-activity` rows per LD-4; contract §16; tests (loop mirrors the consumer-test pattern) | WD-23A | Attach writes one idempotent activity row with exact task/project links + webViewLink payload; folder create is idempotent per project (second call reuses); push/move land the file in the folder (live-verified); sweep with a doctored cursor re-run produces zero duplicate rows (UNIQUE proven); loop is Redis-gated and interval-configurable; no n8n involvement | risk: MED — external writes, but user-token-scoped (WS4 not applicable — user-initiated, not automation) |
| WD-24 | **Deliverables tab + task attach flow (FE):** Drive picker over 23A's list API, attach affordance on PM task detail + project view, Deliverables tab live over `deliverable_evidence`-shaped feed reads, teach-state preserved for unlinked users | medior | Sonnet·medium (default) | NEW `platform-ui/src/lib/drive.ts`; `components/departments/DrivePicker.tsx`; `(app)/departments/[deptId]/deliverables/page.tsx`; `components/pm/*` attach affordance; `demoFixtures.ts`; e2e | WD-23A, WD-23B | A member picks a Drive file on a task and it appears as deliverable evidence on the task, the project, and the Deliverables tab (live); unlinked user sees the connect teach-state with CTA; degrades cleanly on 403/404; DEMO_MODE walk + `tsc` + `next build` green | risk: LOW — FE over shipped patterns |
| WD-25 | **Claude Admin usage pull:** `startClaudeUsageLoop` per LD-15 (daily, key-gated, idempotent per seat×day) + per-seat usage surfaced in the Connections team grid + person-profile Claude card | medior | Sonnet·medium (default) | NEW `src/core/claude-usage.service.ts` (loop + mapper); env `ANTHROPIC_ADMIN_KEY` + `.env.example`; `lib/claudeSeats.ts` + Connections/team-grid + `people/[userId]` FE touch; contract §12a extension; tests (mock the Admin API; verify endpoint shapes against live Anthropic admin docs at build) | OQ-3 | With the key set, one loop tick ingests per-seat rows (source `claude`, idempotent — second tick adds nothing); seats map via `provider='claude'` rows, unmatched actors land unlinked; without the key the loop never starts and nothing errors (fail-soft, WS9-style); grid + profile render usage and degrade to the seat-only state; admin key never serialized/logged | risk: LOW-MED — read-only external pull; custody asserted |
| WD-27 ⚡ | **Phase-3 QA gate** (runs alone, last): adversarial webhook forgery (bad/absent/replayed sig, secret-unset 503, oversized body, unknown installation), delivery-id replay → row-count stable, OAuth probes (forged/replayed state, cross-user callback, granted-scope audit vs minimal set), **token non-exposure re-sweep with REAL tokens present** (first time live rows exist — API + logs + DB ciphertext), refresh single-flight sanity, RLS probes on all touched tables incl. new columns, Cerbos matrix re-run (`github_repo` grid + `work_activity` exec-parity re-check), DEF-2 regression probe (concurrent double-delivery on pipeline + github paths; duplicate-stage scan), digest/nag live-fire, sweep-idempotency re-poke, full console walk (Repositories · Deliverables · Connections-with-real-links · profile cards, DEMO + live), contract-doc conformance (§11/§12/§12a/§15/§16) | qa | Sonnet·medium (default) | evidence doc `2026-07-XX-wd27-evidence.md`; may author probe tests (QA doctrine: file, don't fix) | all shipped Phase-3 tickets (gates the delivered subset if a track is still OQ-blocked; a later-landing track re-opens a delta gate) | Written evidence per check with positive controls (per the WD-08 standard); zero critical findings open; regressions filed as tickets, not fixed; explicit statement of which tracks were in scope | — (is the gate) |

**Model discipline check:** **2 Opus flags out of 10** (WD-29, WD-23A — both justified inline;
both are start-on-Opus cases because a plausible-but-subtly-wrong result survives ordinary tests
and costs a full re-run + re-gate). Everything else is seat default, including WD-21, whose
non-flag is argued explicitly in its row. Escalate to the architect ONLY if a ticket must deviate
from a locked decision or contract shape above — otherwise proceed.

---

## Cost / effort estimate

Calibration: webdev Phase 1+2 = 9 tickets ≈ **2.07M subagent tokens (~230k/ticket), 7 agents,
zero Opus**. Phase 3 = 10 tickets, heavier on live wiring and the gate:

| Wave | Tickets | Est. tokens | Notes |
|---|---|---|---|
| W1 | WD-28 + WD-26 | ~510k | WD-26 runs hot (~280k): n8n import/verify cycles are chatty |
| W2 | WD-29 | ~260k | Opus·medium seat; includes live re-drive |
| W3 | WD-21 + WD-23A | ~540k | The two trust-boundary tickets; 23A is the second Opus seat |
| W4 | WD-22 + WD-23B | ~430k | |
| W5 | WD-24 + WD-25 | ~380k | |
| W6 | WD-27 | ~350k | WD-08-scale gate breadth |
| **Total** | **10 tickets** | **≈ 2.3M–2.8M** | ~10 agent-runs; 2 Opus·medium seats (dollar premium on those two only); wall-clock is dominated by the serialized live-verification windows, not tokens. Credential-free subset (W1–W2) ≈ 0.8M |

---

## What blocks Phase 3 from starting

**Nothing blocks the start.** Waves 1–2 (WD-26, WD-28, WD-29) need zero external credentials and
can mobilize today. The gated remainder:

- **OQ-2 (owner):** GitHub org name + App registration + private-key/webhook-secret custody →
  unblocks **WD-21**, then WD-22. Until then Track A does not start; the Repositories tab keeps
  its shipped teach-state.
- **OQ-9 (owner, NEWLY SURFACED):** Google OAuth client (id + secret + redirect URIs + consent
  screen with `drive.readonly`/`drive.file`) → unblocks **WD-23A**, then WD-23B → WD-24. The
  design's §13 open-questions table does not list this — it is a genuine gap in the blueprint,
  raised here as OQ-9.
- **OQ-3 (owner):** Anthropic Admin API key → unblocks **WD-25**. Design default already in
  force: seat registry without metrics.
- **WD-27** runs after whatever subset has shipped; an OQ that lands late gets a delta gate.

---

## Known-defect inheritance (do not re-discover)

| Defect | State (register: `2026-07-30-wd08-evidence.md`) | Phase-3 disposition |
|---|---|---|
| DEF-2 — `pipeline-delivery` Load+decide race (stateless recompute, two webhook triggers, no lock; duplicate `claude_design` rows in live data) | Open, characterized (§1.6; timing-dependent) | **Fixed by WD-29.** Phase 3's own inbound paths are structurally immune (LD-4: everything funnels through the F2 UNIQUE) — WD-27 probes both claims |
| DEF-3 — `deploy.production` D14 suspend with no `approvals.request` node ⇒ `wf:delivery` can never complete prod unattended | Open, awaiting owner decision (§1.7: fail-soft proven correct) | **Not a Phase-3 blocker** — no Phase-3 automation performs a medium+ write (LD-12 encodes the trap so nothing new walks into it) |
| WD-08-R1 — dispatcher webhook returns HTTP 200 on bad bridge secret (masks probing) | Filed | **Fixed in WD-26** (+ the new flows built to the corrected response discipline) |
| WD-08-R2 — dedupe response omits `runId` (cosmetic) | Filed | **Fixed in WD-26** |
| WD-20-R1 — `work_activity` exec carve-out missing | **Already fixed** (policy comment 2026-07-30) + re-confirmed live (WD-08 §2.6) | No ticket; WD-27 re-runs the matrix as a parity check |
| DEF-4 — upload concurrency quirk (WD-08 respected it via serialized uploads) | Characterized | No Phase-3 surface touches it; WD-27 does not re-probe |
| Operational: Cerbos does not hot-reload policy edits on this Windows Docker Desktop (bind-mount fsnotify) | Standing | Every policy-touching ticket restarts the container in its AC (LD-17) |

---

## Stale-doc corrections this plan relies on (report-and-annotate, applied by the named tickets)

1. **D-12's `0049+` is consumed** — `0049_meeting_recordings_audio_ref.sql` (WD-04) is the live
   head as of today. Next-unused is `0050`+ **at this moment** and will drift again (SMM/CR race).
   LD-1 makes every DDL ticket re-verify; no doc edit needed beyond this record.
2. **WD-20-R1 "filed, not fixed" is stale** in `web-dev-phase1-tickets.md` and the WD-20 evidence
   — the fix landed in `resource_work_activity.yaml` and WD-08 §2.6 re-confirmed it. WD-27's
   evidence doc should note the reconciliation.
3. **§13 has no Google-OAuth-client row** — OQ-9 raised above; the design doc's §13 table should
   gain the row when next amended.
4. **§12's WD-21 note cites "integrations OQ-1"** for the short-code question that §13 numbers
   OQ-7 — aliasing only; WD-28 implements the same default either way.
5. **`infra/compose/.env.example` predates the vault** — it documents neither
   `INTEGRATION_TOKEN_KEY` (P1-08's fail-closed key: fresh box ⇒ 503 on token writes with no
   documented knob) nor any Phase-3 credential. WD-21/WD-23A/WD-25 each add their rows; WD-23A
   backfills the `INTEGRATION_TOKEN_KEY` row (first ticket that exercises real tokens).
6. **`activity.feed` (hub tool) reads the legacy `activities` audit table**, not `work_activity`
   — recorded in LD-16 so nobody wires digests to the wrong feed.
7. **`src/seed/automation.ts` hardcodes `AGENCY_NAME="Gaiada Creative"`** vs the live tenant
   "Gaia Digital Agency" (WD-01 finding, still present) — WD-26 extends that seed and must leave
   the name for the owner; noted so a fresh-box seed failure isn't misattributed.

---

*Cross-references:* [webdev design](../../blueprints/webdev-design.md) ·
[integrations plan](./web-dev-integrations-plan.md) ·
[integrations P1 tickets](./web-dev-phase1-tickets.md) ·
[WD-01 evidence](./2026-07-29-wd01-evidence.md) · [WD-20 evidence](./2026-07-30-wd20-evidence.md) ·
[WD-08 evidence / defect register](./2026-07-30-wd08-evidence.md) ·
[migrations protocol](../../../platform-nest/migrations/README.md) ·
[work-activity ingest](../../../platform-nest/src/core/work-activity-ingest.service.ts) ·
[linker extension points](../../../platform-nest/src/core/work-activity-linker.ts) ·
[integrations controller](../../../platform-nest/src/core/integrations.controller.ts) ·
[secret-box](../../../platform-nest/src/core/secret-box.ts) ·
[hub allowlist](../../../mcp-hub/src/automation-policy.ts) ·
[CRON-flow template](../../../automation/workflows/compliance-gate-nag.json) ·
[BFF contract](../../FRONTEND-BFF-CONTRACT.md) · [MODULES registry](../../modules/MODULES.md)
