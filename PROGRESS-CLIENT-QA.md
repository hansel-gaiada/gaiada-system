# PROGRESS — Client-project QA & bug tracking (ERP-native, Linear-free)

**Source of truth for this workstream.** Update the Status cell the moment a task changes state.
Do not batch updates at the end — a stale row here is the failure mode this file exists to prevent.

**Status vocabulary (program-binding, `gaiada-system/CLAUDE.md`):**
**PLANNED** · **IN PROGRESS** · **PROTOTYPED** · **DEV-VERIFIED** · **BLOCKED**
Never write "done", "built", "complete", or "production-ready".
**DEV-VERIFIED** means *you drove the real surface and observed the result*. A green unit suite is not that.

---

## Why this exists

Owner decision (2026-08-26/27): client-project bug + QA tracking is built **ERP-native**, not on Linear.
Linear is adopted separately as **disposable scaffolding for tracking ERP dev/staging bugs only**, and
is retired once this workstream is DEV-VERIFIED. Nothing here may depend on Linear.

Rationale: agency clients already authenticate to the ERP portal (`(portal)/portal/*`). Linear would
mean separate accounts per client or a public form, and its free tier caps at 250 active issues —
which bites hardest on exactly the long-lived, busy case this serves.

## What already exists (do NOT rebuild)

| Asset | Where | Note |
|---|---|---|
| Change-request intake + triage | `platform-nest/src/core/webdev-change-requests.controller.ts` | `kind` already includes `bug`; routes `bug → pm_task` |
| CR table | `migrations/0088_webdev_change_requests.sql` | **PLAIN core tenant wall on purpose** so the portal can write it — do not module-wall it |
| CR lifecycle | same | `new → (declined \| triaged → in_progress → done)` |
| PM task conversion | `createPmTaskInTx` | triage `convert` already spawns a PM task |
| Client notifications | `client-notify.ts` (`notifyBestEffort`, `resolveClientRecipients`) | |
| File attachments | `core/files.controller.ts` | full upload/download CRUD |
| Client portal | `platform-ui/src/app/(portal)/portal/*` | projects, requests, timeline, approvals |
| **`webdev_qa_runs` DESIGN** | `docs/blueprints/webdev-design.md` §304, D-9 | schema + staging-gate rule already ratified, **scheduled webdev P5, not built** |
| Signed Zone-B webhook pattern | `modules/webdev/zoneb-events.service.ts` | HMAC-SHA256 over raw bytes, idempotent by `(tenant, event_id)` |

## Gaps this workstream closes

1. CR has no `severity`, no structured reproduction steps, no environment/build, no affected URL.
2. CR lifecycle ends at `done` — there is **no QA verification state** (who verified, on which build).
3. `source` is `portal|internal` only — CI cannot file.
4. No duplicate/regression linking.
5. `webdev_qa_runs` is designed but does not exist — no CI results, no D-9 staging gate.

## Binding constraints (from `CLAUDE.md` — violating these has cost real tickets)

- Migrations are **timestamp-named** now: `YYYYMMDDHHMM_name.sql`. Head as of writing:
  `202608261930_finance_eliminate_intercompany_reapply.sql` (194 files). Do **not** look up a "next number".
- `webdev_change_requests` keeps the **plain core tenant wall**. `webdev_qa_runs` is **third-walled**
  (module wall) per D-2 — it is not portal-written.
- **Cerbos does not hot-reload.** Restart it, then prove the new decision with a probe. Health ≠ current.
- Update `docs/FRONTEND-BFF-CONTRACT.md` §-rows in the same change as the endpoint.
- `docs/modules/MODULES.md` + `CHANGELOG.md`: **write these yourself, never delegate.** Take the NEXT
  free version. Verify `git diff --numstat` shows N insertions / 0 deletions **and**
  `grep -oE '^### ' file | sort | uniq -d` is empty.
- `docs/MAP.md` must be regenerated from a **clean worktree** (`git worktree add --detach`), never this
  shared checkout.
- **Agentic-native bar** (`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md`, OPEN): every
  capability must work identically under a human, under n8n, and under an agent. Read before building.
- This checkout is shared by concurrent sessions. Re-read before assuming a regression.

---

## Tasks

### Phase 0 — Ratify against existing design

| # | Task | Status |
|---|---|---|
| 0.1 | Read agentic-native bar; record how bug-file + triage + verify satisfy human/n8n/agent parity | DEV-VERIFIED — see §Agentic parity |
| 0.2 | Reconcile gaps 1–5 above against webdev-design D-7/D-9; record any deviation as an owner decision | DEV-VERIFIED — gaps 1–4 are additive to D-7 (no deviation); gap 5 is D-9 built as designed |
| 0.3 | Decide scope: does this serve webdev client projects only, or SMM/SEO/Creative client work too? | DEV-VERIFIED — owner chose extend-in-place; see Decisions log |
| 0.4 | **Tracked gap** (full-fidelity mandate): SMM / SEO / Creative client work has no bug-intake path until the generalization lands | PLANNED |

### Phase A — Bug fields on the CR spine

| # | Task | Status |
|---|---|---|
| A.1 | Migration: add `severity`, `repro_steps`, `environment`, `seen_on_version`, `affected_url` to `webdev_change_requests` | PROTOTYPED — `202608271000_client_bug_intake_fields.sql`; applies cleanly in sequence (195 migrations, fresh DB) |
| A.2 | Migration: extend `source` CHECK to admit `ci`; keep `wcr_portal_has_requester` intact | PROTOTYPED — same file; `ci` rows satisfy `wcr_portal_has_requester` vacuously (intended) |
| A.2b | Apply the migration against a test container from source and confirm the portal path still reads non-zero rows | PROTOTYPED — 47/47 green incl. 0088's plain-wall guard, **on Windows/local; server run is what counts** |
| A.2c | `VALIDATE CONSTRAINT wcr_bug_has_severity` from the application path (tenant GUC set) — **cannot** be done in a migration, see file header | PLANNED |
| A.3 | Backend: severity accepted at TRIAGE (not intake); typed 400 when converting a bug without one | PROTOTYPED — `webdev-change-requests.controller.ts`; both convert paths write it, decline exempt |
| A.3b | Portal create DTO: `repro_steps` / `environment` / `seen_on_version` / `affected_url` + caps | PROTOTYPED — portal + staff-internal both accept them, identical caps, all `scrubText`-ed; `severity` accepted on NEITHER intake path |
| A.4 | Cerbos: policy for the new fields/actions; **restart + probe the decision** | PLANNED |
| A.5 | Portal UI: bug-report form (repro, environment, seenOnVersion, URL) — NOT severity, it is not on the intake contract | PROTOTYPED — form + server action + types + demo store; `tsc --noEmit` exit 0. **platform-ui tests could NOT be run** — see A.5b |
| A.5b | **BLOCKER:** `platform-ui/node_modules` is a LINUX install in a Windows checkout (`@rollup/rollup-linux-x64-*`, no `.bin/vitest.cmd`; `platform-nest` correctly has `rollup-win32-x64-msvc`). `PortalChangeRequestForm.test.tsx` and `portal.test.ts` are unrunnable here. Do NOT `npm install` in the shared checkout while other sessions build. Run on the server. | BLOCKED |
| A.6 | Staff UI: triage queue renders severity; filter + sort by it | PLANNED |
| A.7 | Tests: unit + RLS regression (portal path must still read non-zero rows) | PLANNED |

### Phase B — QA verification lifecycle

| # | Task | Status |
|---|---|---|
| B.1 | Migration: add `verified` status; `wcr_route_matches_status` needed NO edit (verified is post-triage, so it must carry a route — the existing expression already says so) | PROTOTYPED — `202608271900_change_request_verification.sql`; 3 lints green |
| B.2 | Migration: `verified_by`, `verified_at`, `verified_on_version` + `wcr_verified_has_attribution` (VALIDATED, unlike A.1 — new columns are NULL on all history and no row could hold status `verified` before this file) | PROTOTYPED — same file |
| B.3 | Endpoint: `POST change-requests/:id/verify` (+ un-verify back to `in_progress`) | **PROTOTYPED** — verify + unverify in one handler (one lock, one authz check, one audit shape). `src/core` + `src/rbac` + `src/db`: **2240 passed / 0 failed** (144 files) against a fresh DB and a Cerbos container running the NEW policy; `tsc` exit 0. 5 new tests incl. the adversarial pair. |
| B.3a | IAM chain for `webdev_change_request::verify` | **PROTOTYPED** — 8 artifacts in a worktree at `AppData/Local/Temp/claude/wt-verify` cut from `e02ba16c`. `src/rbac` + ui-grantable guard: **509 passed / 0 failed** (806 incl. skips). Cerbos decision DRIVEN and observed — 6 probes against a real container on the new policy: webdev_manager ALLOW, webdev_staff DENY, company_admin ALLOW, client DENY, plus two controls proving the denials are real. NOT on the server; not committed. |
| B.3c | **ROLE-ARM ONLY, deliberately.** A `perm_*` mirror for `verify` was written then REMOVED on evidence: IAM-04-REG1's sweep showed it adds `webdev_change_request.verify: [webdev_manager]` to the out-of-scope register — the SAME hazard `...triage` already carries, because `module_manager` composes from `attr.module` and is narrower than a tenant-wide mirror. That pin says do NOT widen the baseline to silence it, so the mirror was dropped rather than the baseline grown. Consequence: a principal granted this key via the PERMISSION arm gets nothing until a follow-up IAM ticket audits triage's mirror and this one together. | PLANNED |
| B.3d | **`role-permission-bundles.json` is GENERATED** (`npm run gen:role-bundles`) — I hand-edited it and `REGEN-NO-DIFF` caught it. Reverted and regenerated; the generator independently produced the same 1685 pairs and the same 5 roles I had derived. Never hand-edit that file. | PLANNED |
| B.3b | **HOW to do B.3a without a red run** (agreed with gaiada-system-ec, who has paid for each of these today): (1) `git worktree add --detach <tmp> origin/main` and work THERE — never the shared checkout, which is the root cause; (2) **DERIVE every pinned count from the catalog array and paste the derived value — never reuse a literal.** `384` is already stale and moves when finance `0.16.0` lands. Evidence the numbers genuinely disagree across trees: `sensitive` derives to **178** here, ec reported **176** in theirs, and two branches both claimed **175**; (3) end the IAM migration with a block that RAISEs if any grantable non-portal key has `ui_grantable=false` — the guard that would have caught the `position_roles_guard()` (0110 clause b) bug at apply time instead of as nine unrelated seed failures (pattern: ec's `202608272010_iam_finance_ap_credit_writeoff.sql`, not visible from this tree); (4) **restart Cerbos and probe before believing any authz test** — a healthy container serves stale policy and cost ec two phantom failures today. **Refinement (ec, accepted):** do NOT read this as "stop pinning". The pin has a real job — forcing a human to consciously acknowledge the permission surface grew; deriving it everywhere makes the test tautological and that guard vanishes. The actual defect is that ONE number is duplicated in FOUR places (`_meta.counts` + three test literals). Correct fix is one pin in `_meta.counts` with the three tests asserting against it. That is a separate focused change by ONE session, raised with the owner, NOT to be folded into this feature. Until it lands: derive, and update the literal deliberately. | PLANNED |
| B.3e | **Legacy-row accommodation in `verify`:** `wcr_bug_has_severity` is NOT VALID, so a pre-migration bug can sit at `in_progress` with NULL severity. Verifying one would violate the CHECK as a 500 naming a constraint the caller never heard of. Detected and answered as a typed 400 that says what to send; `severity` is accepted on THIS endpoint only for that case — the caller is an authorized VERIFIER supplying what triage never captured, not a client ranking their own bug. | PLANNED |
| B.3f | **Regression I introduced and fixed:** `webdev-cr-race.test.ts` went `[400,400]` instead of `[200,409]` — its concurrent-convert race uses a BUG, which A.3 now requires a severity for. Supplied on BOTH flights deliberately: had only one carried it, the test would still have seen two different status codes and looked like it passed for the reason it was written for. | PLANNED |
| B.4 | UI: verify action for staff; portal shows verification state to the client | PLANNED |
| B.5 | Tests incl. adversarial authz (a client must not be able to verify their own bug) | PLANNED |

### Phase C — `webdev_qa_runs` (D-9, webdev P5)

| # | Task | Status |
|---|---|---|
| C.1 | Migration: `webdev_qa_runs` **exactly per webdev-design.md §304** + `webdev_qa_runs_corr` unique index | PLANNED |
| C.2 | Signed webhook receiver — HMAC-SHA256 over **raw bytes**, verify before parse, idempotent by `(tenant, repo, correlation_id)` | PLANNED |
| C.3 | QA harness package for client repos: Playwright E2E + `@axe-core/playwright` + Lighthouse budgets + visual baselines | PLANNED |
| C.4 | CI template that runs the harness and reports back | PLANNED |
| C.5 | Console + gate cards render the QA summary | PLANNED |
| C.6 | **D-9 gate:** `deploy.staging` requires last QA green or an explicit PM override recorded in the gate note | PLANNED |
| C.7 | Tests: signature rejection, replay/idempotency, gate refusal | PLANNED |

### Phase D — Wire-up, contracts, verification

| # | Task | Status |
|---|---|---|
| D.1 | Failed QA run auto-files a CR (`kind=bug`, `source=ci`) with dedupe against open bugs | PLANNED |
| D.2 | Duplicate/regression linking between CRs (lean on PM `dependsOn` DAG, do not add a new edge table) | PLANNED |
| D.3 | Update `docs/FRONTEND-BFF-CONTRACT.md` § rows | PROTOTYPED — §16f: 5 rows + header, marked `NEW(unverified):`; header states MI-01..05 DEV-VERIFIED does NOT extend to them |
| D.4 | Update `docs/PERMISSION-CONTRACT.md` if the authz surface changed | PLANNED |
| D.5 | `MODULES.md` + `CHANGELOG.md` — hand-written, numstat + duplicate-heading checked | PROTOTYPED — platform-nest `0.41.0`; numstat 50/0, headings clean, version unique |
| D.6 | Regenerate `docs/MAP.md` from a clean worktree | PLANNED |
| D.7 | Full suite (`npx vitest run`, not a fast gate) + `npx tsc --noEmit`; record the FILE COUNT | PLANNED |
| D.8 | **Drive the real surface**: file a bug as a client, triage it, verify it, watch a CI run land | PLANNED |
| D.9 | Retire Linear for ERP tracking once D.8 is DEV-VERIFIED | PLANNED |

### Phase E — Agentic-native parity (required by the OPEN bar, not optional)

Capabilities in scope: **file-bug**, **triage-bug**, **verify-bug**, **read-qa-run**.
Source: `docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md` §"The readiness bar" (7 criteria).

| # | Criterion | Task | Status |
|---|---|---|---|
| E.1 | **1 · Tool parity** | `mcp-hub`: expose file-bug / triage-bug / verify-bug / read-qa-run as MCP tools with the SAME Cerbos authz as the endpoints | PLANNED |
| E.2 | **2 · Deterministic contract** | Structured req/resp; refusals typed, never prose. No rendered strings | PLANNED |
| E.3 | **3 · Idempotent writes** | Natural dedupe key for CR create (CI retries at-least-once); `qa_runs` already keyed by `(tenant, repo, correlation_id)` | PLANNED |
| E.4 | **4 · Impact-classified writes** | Register triage/convert/verify with the D14 impact gate; approving must EXECUTE, not just record | PLANNED |
| E.5 | **5 · Explicit refusal** | Portal + staff readers must not fold 403/404 into `[]` — audit the reader-degrade pattern | PLANNED |
| E.6 | **6 · Observable** | `work_activity` row on every state change, actor + tenant, actor may be non-human | PLANNED |
| E.7 | **7 · One golden case** | End-to-end fixture: file → triage → fix → verify, reusable as an eval case | PLANNED |

> **Why this phase was added after the plan was first written:** reading the bar (task 0.1) revealed
> that the original Phase A–D had **no mcp-hub task at all** (criterion 1) and no D14 registration
> (criterion 4). Per the bar's own warning, these must be built *to* the bar, not retrofitted —
> "that option disappears the moment it ships."

---

## Agentic parity — how each capability meets the bar

The failure mode the bar exists to prevent: *a capability that only exists as a UI interaction.*
The portal bug form must therefore be **one client** of file-bug, never its definition.

| Mode | file-bug | triage-bug | verify-bug |
|---|---|---|---|
| **Full human** | portal form (A.5) | staff queue (A.6) | staff verify action (B.4) |
| **Assisted (n8n)** | CI failure → auto-file (D.1) | — | — |
| **Agentic** | agent files from a monitored surface | agent proposes route, D14-gated | agent proposes verify, D14-gated |

All three modes share the same endpoint, the same Cerbos decision, and the same `work_activity`
attribution. Agent-driven triage/verify are **medium-impact** writes: they route through D14 approval
rather than executing directly.

---

## Decisions log

| Date | Decision |
|---|---|
| 2026-08-26 | Build client-project bug/QA tracking ERP-native; Linear is disposable scaffolding for ERP-internal bugs only |
| 2026-08-27 | Implement the **already-designed** `webdev_qa_runs` (D-9) rather than inventing a QA model |
| 2026-08-27 | `webdev_change_requests` is extended, not replaced — it already carries `kind='bug'` and portal write access |
| 2026-08-27 | **Incidental repo hygiene (not a Phase task):** `CHANGELOG.md` carried 9 duplicate headings in committed HEAD (`[0.0.0]` x4, `[0.5.0]` x2, `mail (continued)` x4), which permanently blinded the duplicate-heading safety check `CLAUDE.md` prescribes for that file — a future session has no clean baseline to compare against. Disambiguated by prefixing the owning module / numbering the continuations. **Heading text only:** 286 `###` and 28 `##` headings before and after, every non-heading line byte-identical. NOTE: `## mail (continued 4)` sits after `## creative` in file order — renamed, deliberately NOT relocated. |
| 2026-08-27 | **Scope (owner):** extend `webdev_change_requests` in place. New columns MUST be named dept-agnostically so a later generalization to SMM/SEO/Creative is a table rename, not a reshape. Non-webdev client bug intake is a **tracked gap (0.4)**, not a dropped requirement — recorded here per the full-fidelity mandate. |

## Verification log

_Append evidence here as tasks reach DEV-VERIFIED. Record what you drove and what you observed._

| Date | Task | Evidence |
|---|---|---|
| 2026-08-27 | A.1–A.3 | Fresh postgres:17 container, all 195 migrations applied from scratch in order. `webdev-change-requests.controller.test.ts` + `-portal.controller.test.ts`: **47/47 pass** (46 pre-existing + 1 new refusal test). `npx tsc --noEmit` exit 0. All three migration lints green — `lint-migration-rls` reports "no unguarded FORCE-RLS backfills", confirming the `NOT VALID` choice. **NOT DEV-VERIFIED:** this is a local Windows run and no real surface was driven; per `tests-run-on-server-not-local` the server run is the one that counts. |
| 2026-08-27 | A.5 | Portal form renders the four bug fields only for `kind='bug'`; server action forwards them; `PortalChangeRequest` + demo store carry all five columns. `node node_modules/typescript/bin/tsc --noEmit` exit 0. **No test run:** platform-ui's node_modules is a Linux install (A.5b), so `tsc` is the only local signal — weaker than every other row in this log. |
| 2026-08-27 | A.3b | Fresh container, 195 migrations from scratch. **48/48 pass** (47 + 1 new portal round-trip test asserting bug detail survives submit→read-back AND that a client-supplied `severity: "critical"` is ignored, landing NULL). `tsc --noEmit` exit 0. Local Windows run — **not** DEV-VERIFIED. |
| 2026-08-27 | A.1 (design correction) | First draft required severity at INSERT. Baseline proved it was my regression: **46/46 green with the migration pulled aside, 36/46 with it.** Reshaped to require severity only post-triage, mirroring `wcr_route_matches_status`. |
| 2026-08-27 | 0.1 | Read `2026-08-03-agentic-native-erp-plan.md` §20–52 (three operating modes + 7-criterion bar). Mapping recorded in §Agentic parity. Bar exposed two omissions in the first draft of this plan — no MCP tool task (criterion 1) and no D14 registration (criterion 4) — both now tracked as Phase E. |
