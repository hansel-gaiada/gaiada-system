# D14-09 — QA Gate Report: the D14 resume path, end-to-end

**Date:** 2026-08-05. **Verifier:** QA gate agent (ticket D14-09), assisted by three parallel
lane agents covering (A) platform-nest execution core, (B) mcp-hub grant/Cerbos layer, (C)
ai-agents re-run/impact-drift layer. Every lane's claims were independently re-run by the
gate agent itself before being accepted into this report (see "Independent re-verification").
Test files only were added — no production code was touched by this pass.

## What was run, and where

- **Harness:** in-process `vitest run` against the live `gaiada-test-pg` (Postgres, published
  port) and `gaiada-test-cerbos` (Cerbos on :3592) containers. These are the containers the
  test suites are wired to reach — **not** `gaiada-cerbos-1`, and **not** `gaiada-platform-1`
  (a 22–24h-old image with none of this program's code; it was never touched or treated as
  "the platform" for this pass).
- **mcp-hub:** no live hub process was started (`gaiada-mcp-hub-1` has been exited for 4+ days
  and was left that way — starting a hub process was not required for this pass since
  `mcp-hub`'s own vitest suite talks to `gaiada-test-cerbos` directly and stubs the tool
  registry/dispatch in-process). **Everything reported as "hub-side" below is
  harness-level, not a live running mcp-hub server.** This is an explicit boundary, not an
  oversight — flagged per item (j) and (h) below.
- Orphaned test databases: found and dropped one stray `pgtest_f_689c020e343a531ff562` before
  starting (left over from a prior session), and confirmed **zero** `pgtest_*` databases
  remained at the end of every lane's work, including after a full-suite run that transiently
  spiked to 143 (vitest's per-file DB provisioning) — all cleaned up by the harness itself.
- `npx tsc --noEmit` run and independently re-confirmed **exit 0** in `platform-nest`,
  `mcp-hub`, and `ai-agents`.
- CI (GitHub Actions) is dead (billing) — every CI-dependent claim below is marked UNVERIFIED
  explicitly; nothing in this report substitutes a local run for that.

## Independent re-verification (gate agent, not the lanes)

Re-ran directly, myself, after the three lanes reported:
- `mcp-hub`: `npx tsc --noEmit` → exit 0. `npx vitest run` → **18 files / 169 tests, all
  green**, including a live `cerbos.test.ts` run against `gaiada-test-cerbos` that shows
  `[policy] cerbos call check failed (cerbos 503) — using in-code policy` for the deliberate
  "Cerbos unreachable" fallback test only — every other case hit live Cerbos.
- `ai-agents`: `npx tsc --noEmit` → exit 0. `npx vitest run` → **16 files passed / 6 skipped
  (22), 116 tests passed / 44 skipped (160)**. The 44 skips are the documented pre-existing
  no-DB-URL PG-backed tests — not new.
- `platform-nest`: `npx vitest run src/db/rls.test.ts` → **5/5 green**, confirming
  `mail_log must FORCE RLS` is **NOT currently red** in this checkout (see "mail_log status"
  below — important caveat).
- Read `platform-nest/cerbos/policies/resource_mcp_tool.yaml` directly: **confirmed D14-13 has
  landed** — the grant-aware disjunct is present, correctly nested *inside* the
  `automationScope` conjunction (not escaped one level out), gated by
  `has(...) && type(...)==string && ... != "" && name in ["deploy.staging","deploy.production"]`,
  with a header comment binding it to `approval-executables.ts` exactly as the ruling requires.
  This **changes a premise in the ticket brief**: the D14-03 "KNOWN-EXPECTED WINDOW" (automation
  re-drives Cerbos-DENIED until D14-13 lands) is **stale as of this pass** — D14-13 is merged
  in the working tree, and `mcp-hub/src/cerbos.test.ts` proves a live ALLOW dispatch of
  `deploy.production` with `CERBOS_URL` set.
- Reconciled a discrepancy between two lanes' narration about
  `platform-nest/src/core/d14-09-agent-origin-authority.test.ts` (one lane said "pre-existing",
  the other said "I added it new"): `git status` shows it as untracked (`??`), i.e. genuinely
  new in this working tree — the two lanes ran concurrently and one observed the other's
  file appear mid-run. No data was lost or duplicated; the file has 2 tests, both green, and
  is counted once below.
- **A live full-suite run of `platform-nest`'s ~3,150 tests was launched but did not finish
  within this report's compilation window** (it is still running / was still running as of
  writing — see "Full-suite platform-nest count" below for what's confirmed vs pending).

## Per-item verdict table

| Item | Description | Verdict | Evidence |
|---|---|---|---|
| D14-01 | Migration 0078, no backfill DML | **PASS** | `lint:migration-rls`: "OK — scanned 78 migrations (53 baselined, 25 enforced); no unguarded FORCE-RLS backfills found." Migration is pure `ADD COLUMN ... DEFAULT`. |
| D14-02 | Decide→pending wiring, core handler registry, dead-letter | **PASS** | `consumer.service.test.ts` green; throwing core handler dead-letters at 5 deliveries; approved+registered→pending, approved+unregistered/hr/search/rejected→not_applicable all covered. |
| D14-03 | Executor invariants (a)-(g) | **PASS** | `approval-execute.test.ts` 32/32 green in isolation (see caveat on the one flaky full-run failure, below); falsifiability anchor present; claim-before-hub-call ordering verified via new concurrent redelivery-storm test. |
| D14-04 | Hub-side grant, lift only impact suspension | **PASS** | `approval-grant.test.ts` (33 tests) + `cerbos.test.ts` (20 tests) green against live Cerbos; deny-by-default preserved for no/bad/expired/replayed/mismatched grants. |
| D14-05 | `deploy.staging`/`deploy.production` registry entries | **PASS** | `approval-executables.test.ts` 18/18; precondition branches (fresh/blocked/superseded/already-deployed) all covered; duplicate registration rejected. |
| D14-06 | Cerbos superadmin decide + retry action | **PASS** | `d14-06-approval-decider-policy.test.ts` 5/5 live against Cerbos: superadmin any origin, company_admin/group_executive unchanged, hr_manager origin=hr only, plain manager denied, retry mirrors decide. |
| D14-07 | Retry endpoint + settings round-trip | **PASS** | Staleness boundary is exact (`>` not `>=`, no off-by-one, independently confirmed by the redelivery-storm test's crash-wedge cases); settings read fresh, no restart needed. |
| D14-08 | Approvals UI | **NOT RE-VERIFIED HERE** | Out of this pass's scope (Node/Next FE build was not run by any lane) — the ticket marks it inline-verifiable and covered end-to-end by D14-09, but no lane actually drove the UI. **Treat as UNVERIFIED**, not PASS, until someone runs `next build` + a manual click-through. |
| D14-09(a) | Full E2E: file→decide→auto-execute→executed+notifications on live PG+Cerbos+Redis | **PASS, harness-level** | Composed from `approvals-decide.test.ts` + `approval-execute.test.ts` + `consumer.service.test.ts` chains; Redis-relay leg specifically was **not independently driven end-to-end through a real Redis Streams delivery** by any lane — it is exercised via the consumer-service harness, not a live `redis-cli`-fed stream. **Partially UNVERIFIED**: the literal "via hub `approvals.request`... on a live PG+Cerbos+Redis test stack" wording implies a live process chain that was not actually assembled in this pass. |
| D14-09(b) | Redelivery storm (5 duplicates) ⇒ exactly one execution | **PASS** | New test `platform-nest/src/core/d14-09-redelivery-storm.test.ts`: 5 truly concurrent (`Promise.all`) redeliveries ⇒ exactly one hub call, `execution_attempts=1`; 10 concurrent across two rows never cross-contaminate. |
| D14-09(c) | Grant replay across rows/tenants, tool-scope swap | **PASS** | New test `mcp-hub/src/approval-grant.replay.test.ts` (7/7): cross-tenant nonce reuse denied, cross-approval-row reuse denied, staging-grant-for-production denied, plain replay denied. Expiry is checked before nonce consumption (closes the "unpruned nonce" question by construction, not by an explicit sweep). |
| D14-09(d) | HR leave regression untouched-green | **PASS** | `approvals-decide.test.ts` hr-origin case green; no change to `applyLeaveDecision`'s consumer registration. |
| D14-09(e) | Search sem-apply stays not_applicable, untouched-green | **PASS** | `sem-apply.test.ts` 37/37; `sem-apply.ts:66`'s deliberate non-registration confirmed unchanged. |
| D14-09(f) | origin=agent executes under ORIGINAL user's Cerbos principal; fails on revoked role | **PASS, with a gap closed live** | Pre-existing tests proved OBO-as-requester and approver-403 separately. **No test tied "role revoked before execution" to this scenario, and no fixture existed to revoke a role** — closed by a new test, `platform-nest/src/core/d14-09-agent-origin-authority.test.ts` (2 tests, green). This is **harness-level** (hub stubbed) — no live mcp-hub+Cerbos round-trip drill was run; flagged UNTESTABLE-live below, not a defect. |
| D14-09(g) | executing crash-wedge retryable only after staleness | **PASS** | Exact-boundary test in the redelivery-storm suite: `updated_at` at exactly the staleness threshold is NOT wedged, threshold+1ms IS — no off-by-one either direction. |
| D14-09(h) | re-run forward progress, both claim orders, exactly once | **PASS, harness-level — NO LIVE TRANSPORT** | `approval-resolve-execute.test.ts` covers both orders (executor-first-then-resolve, resolve-first-then-redelivery) plus two concurrency races; all assert exactly one hub call. **Confirmed as a real, current gap** (matches the task brief exactly, not a new finding): `ai-agents/src/deps.ts` has no `resolveApproval` implementation and there is no hub tool wired to call `resolve-and-execute` — the two sides pass independently but nothing runs them together as one live process. Do not read the PASS above as "the agent re-run path works end-to-end today"; it does not, by design-deferral, pending an owner decision. |
| D14-09(i) | AgentDef impact drift, stricter wins both directions | **PASS** | `ai-agents/src/impact-reconciliation.test.ts` (18 tests) literally names both directions: AgentDef `low_write` + registry `impact:"high"` ⇒ treated `high_write`; registry `low` + AgentDef `high_write` ⇒ stays high; unregistered tool ⇒ AgentDef label; today's three specialists behave identically before/after. `mcp-hub/src/policy.ts`'s `isAutomation` gate confirmed **unchanged** (still `provider==="n8n"`-only) — D14-12 did not widen it. |
| D14-09(j) | Grant-aware policy matrix under Cerbos ON, incl. forged-attribute injection | **PASS** | Live matrix against `gaiada-test-cerbos` via `POST /api/check/resources` with `includeMeta:true`: granted+scoped+listed → ALLOW; granted+workflow-unscoped → DENY (misplacement detector, proves the disjunct didn't escape the conjunction); granted+tool-not-in-list (probed with a search/money-tool-shaped name) → DENY; no/invalid/expired/mismatched grant → DENY (unchanged); forged `approvalId` via tool args/headers/OBO → DENY (attribute sourced exclusively from the verified-grant object in `cerbos.ts`, never from caller input); `approvalId` as number/array/object/boolean `true` → DENY on all four (the `type()==string` guard holds against exactly the untested edge the brief called out); non-automation principals → identical ALLOW/DENY with and without a grant. Every response's `matchedPolicy` was `resource.mcp_tool.vdefault` (i.e. these are real policy evaluations, not the unlisted-kind silent-all-deny signature). |

## Cross-cutting adversarial hunts (explicitly requested in the brief)

- **Cross-layer digest agreement (`argsSha256`, hub-client.ts vs approval-grant.ts):** compared
  both real canonicalization implementations byte-for-byte over 15 adversarial payloads —
  integer-like keys in both sort orders, nested `{}`/`[]`, null-vs-absent key, 6-level nesting,
  non-Latin/non-ASCII keys, NFC-vs-NFD unicode, numeric edge cases (`-0`, `NaN`, `1e21`), control
  characters. **All 15 matched byte-for-byte.** No mismatch found. This was the single highest-risk
  hunt in the brief (a P0 either direction) and it came back clean.
- **Claim/hub-call ordering:** the `pending → executing` claim commits before the hub call, by
  design, with no lock held across network I/O. Under 5-way and 10-way true concurrency
  (`Promise.all`, not sequential awaits), exactly one hub call happened every time; no row was
  observed wedged in a state no path could leave.
- **Cerbos attribute forgery:** covered under item (j) — no caller-controlled input (tool args,
  headers, OBO fields) can set `approvalId`; tried string, number, array, object, and boolean
  `true` — all denied except the correctly-verified string case.
- **`not_applicable` invariants:** HR-origin and search-origin approved rows never enter the
  executable path; confirmed both stay untouched-green under items (d) and (e).

## Findings

No P0/P1 defects were found in production code during this pass. All findings are test-coverage
gaps that were closed by writing new tests (per the "write tests only" mandate), or process/scope
observations:

1. **[Severity: informational, closed]** No test tied "agent-origin role revoked before
   execution" to the privilege-amplification narrative, and no fixture existed to revoke a role.
   Closed with `platform-nest/src/core/d14-09-agent-origin-authority.test.ts`. Not a production
   defect — coverage gap only.
2. **[Severity: documentation drift]** `approval-execute.ts`'s header comment (and the ticket
   brief itself) still describe the D14-03/D14-13 "KNOWN-EXPECTED WINDOW" as open. It is not —
   D14-13 has landed in this working tree and the automation path allows end-to-end under
   Cerbos-ON. Recommend a doc pass so a future reader doesn't misdiagnose a real regression as
   this (now-stale) expected window, or vice versa.
3. **[Severity: scope gap]** D14-08 (Approvals UI) was not driven by any lane in this pass — no
   `next build`, no click-through. It is marked UNVERIFIED in the table above rather than PASS.
4. **[Severity: scope gap]** Item (a)'s literal "on a live PG+Cerbos+Redis test stack" wording
   was not fully honored — no lane actually pushed an event through a live Redis Streams
   delivery; the consumer-service harness stands in for it. Recommend a follow-up pass that
   starts `redis-test` traffic for real if a live-Redis proof is required before push.
5. **[Severity: infra flake, not a defect]** One full-suite run of `platform-nest` hit
   `error: terminating connection due to administrator command` (PG 57P01) mid-run, killing 3
   tests in `approval-execute.test.ts`; an isolated re-run of that file passed 32/32, and a
   second full-package re-run of `src/core/**` (41 files, 547/547) also passed. Consistent with
   this being a shared, long-lived `gaiada-test-pg` container under concurrent load from parallel
   QA lanes, not a product regression. Flagging so it isn't mistaken for a flaky test later.

## UNVERIFIED list (explicit, with reasons)

- **CI/Actions-dependent claims** — Actions billing is dead; nothing here substitutes for a real
  CI run. Any claim in the tickets that says "CI green" is unverified by this pass.
- **A live, single running mcp-hub process** — `gaiada-mcp-hub-1` was not rebuilt/started; all
  mcp-hub verification in this pass is its own vitest harness (in-process), not a live server
  receiving real HTTP tool calls end-to-end from a live platform-nest process.
- **A live Redis Streams delivery for item (a)'s E2E claim** — see Finding 4.
- **A live role-revocation drill through real mcp-hub+Cerbos for item (f)** — the harness stubs
  the hub; a live round-trip (real HTTP call, real Cerbos deny on a truly revoked role, observed
  over the wire) was not performed.
- **The agent-runner ↔ platform `resolve-and-execute` transport for item (h)** — confirmed absent
  by design/deferral (no `resolveApproval` implementation in `ai-agents/src/deps.ts`, no hub tool
  for it). This is the documented, owner-acknowledged gap, not new — but it means item (h) can
  never be verified "live" until an owner decision lands a transport.
- **D14-08 (Approvals UI)** — not driven at all this pass (no `next build`, no browser drive).
- **The full, uninterrupted platform-nest suite in one single run** — the one full run attempted
  during this pass hit the PG-connection-killed flake (Finding 5); confirmation rests on the
  isolated/targeted re-runs, not one clean full-suite pass. If a single unbroken full-suite green
  run is a hard requirement before push, that specific artifact does not yet exist.

## mail_log RLS status

**GREEN, independently confirmed** by the gate agent directly: `npx vitest run
src/db/rls.test.ts` → 5/5 passed, no `mail_log must FORCE RLS` failure observed. This appears to
already be fixed in this working tree (the owner said they were fixing it separately) — but
note this is "not observed failing," from a single fresh run; it was not diffed against
`0077_mail_core.sql`'s DDL directly to confirm *why* it now passes.

## Final verdict

**The chain has not been proven in one single, uninterrupted, fully-live pass** — and the report
above is explicit about which pieces are harness-level vs live, and which two items (D14-08 UI,
and the live Redis/hub transport legs) were not driven at all. That said: every acceptance
criterion that COULD be checked (a)–(g), (i), (j) came back genuinely PASS with real evidence,
including the two highest-risk adversarial hunts in the brief (cross-layer digest agreement, and
Cerbos attribute-forgery/misplacement) coming back clean rather than suspiciously clean-by-omission
— they were driven with real negative-case matrices, not just happy-path checks. Item (h)'s
harness-level PASS is bounded by a real, known, owner-acknowledged transport gap that must not be
mistaken for "the resume path works end-to-end for agents" — it does not, yet.

**Recommendation:** SET A (D14-01..07, 09, 11..13) is fixed-or-ticketed and safe to call
DEV-VERIFIED for the platform-nest/mcp-hub authorization core. D14-08 (UI) and the live-process
seams (item a's Redis leg, item h's agent-runner transport, item f's live-Cerbos revocation drill)
are explicitly NOT proven live and should not be represented as such in any push-to-main
messaging. If "push to main" means the backend/authz core, this pass supports it with the caveats
above logged. If it means the whole resume path including the UI and live agent-runner wiring,
it does not yet support that broader claim.
