# IAM session handoff — 2026-08-18

**What this session was asked for:** finish the Phase-1 leftovers, then continue Phase 2, pushing and
deploying between tickets, aiming to finish the whole program in a day.

**What is honest about that:** Phases 1→7 is ~25 remaining tickets including a ~39-rule policy sweep,
four UI surfaces and a QA battery. This session moved the critical path four tickets forward and left
everything it touched verified. It did **not** finish the program, and the deploy leg never ran.

---

## 1. Four releases shipped, all verified ON the box

The deploy leg was NOT blocked in the end. The 403 was the wrong active `gh` account
(`ClementHansel` instead of `hansel-gaiada`, both in the keyring, the active one reverting between
shell invocations) — see [[gh-active-account-reverts]]. Switch and push in ONE command.

| Version | Content | Live proof |
|---|---|---|
| `alpha-01.041.0094a` | P2-06 JML · P2-12 backend positions · P2-08 part A grant/revoke · P2-09 sweeps · migration `0111` | `/health`, ledger at `0111`, 5 Phase-2 tables, new routes 401-not-404 |
| `alpha-01.042.0095a` | The four owner decisions · migration `0112` | Live Cerbos probe: `member`/`client`/`delete` → **DENY** (was ALLOW); `hr_manager`/`position`/`assign` → **ALLOW** (was 403); 100 sensitive keys |
| `alpha-01.043.0095b` | compose passthrough for `POSITION_SYNC_ENABLED` (infra only ⇒ revision letter) | both vars present in the container |
| `alpha-01.044.0096a` | the busy-loop fix (§3.7) | `sweep on: every 86400000ms`, CPU 4.5%, empty-value coercion demonstrated inside the container |

**`POSITION_SYNC_ENABLED=1` is ON, and the reconciler is VERIFIED live** — not merely enabled. Driven
through the real SSO flow (`scripts/sso-login.sh`) against the real VPS in a scratch tenant since
retired: a hire returned `reconciled: {granted: 1}`; a transfer re-pointed the grant's claim from the
closed seat to the new open seat in the destination department with ZERO stale claims; a terminate set
`userDisabled: true`.

⚠ `transfer` reported `granted: 0, revoked: 0` and that is CORRECT, not a miss: both seats conferred
the same role at company scope, so the grant artifact is unchanged and only its justification moves
(the A2 refcount). Verified by reading the claim rows, not by accepting the zeroes.

⚠ **`alpha-01.044.0096a` is tagged at commit `124d020`, deliberately NOT at `origin/main` HEAD** — a
concurrent session's observability relocation sits on top and was not mine to ship.

## 2. What landed

**Phase 1 leftovers — closed.**
- The `client_contact` persona defect was **already fixed** (IAM-VERIFY-01, `personas.ts:140`); the
  memory note claiming otherwise was stale.
- The rollout register was stale ("28 of 61 kinds"). Measured from the policies: **55 of 72**, and the
  remaining 17 are now a classified list with a reason each, not a batch number.
- `member`'s missing permission arm turned out to be **correct** — its `module_staff` rule gates
  directory read on `resource.attr.module` while all six module-staff roles carry `core.member.read`,
  so a flat mirror would grant tenant-wide directory read the role arm refuses. Recorded as do-not-wire.
- **IAM-02c deferred with its gate stated** (it is gated on the IAM-04 rollout completing; the half
  that mattered — explicit module bundles + a drift guard that derives composed names — is already done).
- IAM-SEC-03's "detection gap OPEN" row closed; sensitivity sign-off is 107 keys, not 79.

**P2-06 (joiner/mover/leaver)** — 7 endpoints, the §5.2 mover criterion proven against running Cerbos,
the org-blob pipeline reduced to one implementation. Report: `2026-08-18-p2-06-report.md`.

**P2-12 backend (positions)** — CRUD + role-set composer + assign/unassign. Built because P2-06 needed
it: until now a seat could only be created with raw SQL.

**P2-08 part A (grant/revoke)** + **P2-09 (expiry + drift sweep)** — report:
`2026-08-18-p2-08-p2-09-report.md`.

## 3. Findings that change future work (each recorded in the contracts, not just here)

1. **The ceiling could not pass `company_admin` granting `member`** — bundles carry self-service keys no
   admin holds. Both the ceiling and the sensitive gate now subtract the baseline bundle.
   ⚠ **This relaxes a guard P2-04 shipped and needs ratification** (PERMISSION-CONTRACT §12.1).
2. **`targetUserId` was an attribute no handler could send**, so two self-target DENY rules were
   structurally unreachable. Third instance of that shape in this program.
3. **The leaver flow would have disabled every leaver's login** (RLS zero-row trap under `withGlobal`).
4. **HR cannot place, transfer or terminate anyone** — design §5.1 contradicts §4.1/§6.2 and the policy.
   Cerbos was honoured; the owner call is recorded with a recommendation (PERMISSION-CONTRACT §11.2).
5. **The elevated fence is shadowed** on the grant surface — every fenced role is refused by an earlier
   guard, so no test can make the fence the deciding one.
6. **The sensitivity flags are now load-bearing and have never been reviewed.** The sign-off item just
   became a dependency, not a nicety.

## 4. What remains, in the order I would take it

| Next | Why it is next |
|---|---|
| **Fix the push credential and ship the four commits** | Everything below is unverifiable on the live estate until this happens |
| **Owner decisions (2)**: ratify the ceiling subtraction; rule on HR's assign/unassign reach | Both block correct UI work — P2-10 must know whether to render placement fields for HR |
| **P2-08 part B** — `decide_override` | The dept-head surface refuses above-baseline sensitive grants until it exists. Needs a catalog entry + bundles migration + re-derived parity chain |
| **`expires_at` at resolution time** | One clause in `assemblePrincipal()`; belongs with IAM-SEC-06's filter. Until then expiry is sweep-latency, not instant |
| **P2-07** — MCP tools + D14 registration | None of the Phase-2 capabilities meet the agentic-native bar (HTTP only). Deliberately not rushed: D14 entries need preconditions + lock ordering |
| **P2-10/P2-11/P2-12 FE/P2-14** | The dept-head page and positions admin now have real backends to call |
| **P2-15** — backfill/adoption | Nothing has been backfilled; no `employees` row exists outside tests |
| **P2-16** — the QA battery in all three modes | Blocked on P2-07 for the agent/n8n modes |
| **Scheduled (future-dated) JML** | Refused today with a typed 400; needs an as-of reconciler pass |

Phase 3 (owner role, superadmin collapse, `group_executive` removal, two-person rule, MFA wiring),
Phase 4 (role-authoring UI), Phases 5–7 are untouched.

## 5. Test-infrastructure note for the next session

`gaiada-test-pg` could not start: port `55433` is held by an unrelated `mimi-postgres` container on
this machine. A fresh **`gaiada-test-pg-2` on `55435`** was used instead, with
`DATABASE_URL_TEST=postgres://postgres:<pw>@localhost:55435/gaiada_platform_test`, and
`gaiada-cerbos-1` was recreated (so policy is current by construction). Both containers are still
running. Either stop `mimi-postgres` and use the canonical container, or keep using `55435`.

---

## 3.7 🔴 THE INCIDENT I CAUSED (and found, and fixed) — read this before adding any env-driven loop

Enabling the flag I had just made reachable produced
`IAM grant-expiry + position-drift sweep on: every 0ms`, and platform sat at **~46% CPU** sweeping
Postgres continuously. Nothing threw. `/health` stayed 200. No container restarted. **A busy loop
presents as healthy uptime** — every signal the deploy gate checks stayed green, and the only reason
it was visible at all is that the loop logs its interval at boot.

Three causes, all inside my own change:

1. compose was given `POSITION_DRIFT_SWEEP_INTERVAL_MS: ${POSITION_DRIFT_SWEEP_INTERVAL_MS:-}` — that
   form passes an **empty string** into the container when the var is unset; it does not leave it unset.
2. `config.ts` read it as `Number(process.env.X ?? default)` — `??` fires only on `undefined`/`null`,
   and **`Number("") === 0`**.
3. `startPositionMaintenanceLoop` accepted a `0` interval without complaint.

Fixed at all three (a value that reaches a loop from several directions needs guarding at each):
`positiveIntFromEnv()` treats empty/NaN/≤0 as unconfigured; the loop refuses a non-positive interval
loudly and returns an inert handle; compose carries a real default (`:-86400000`). Mitigated on the box
within a minute by setting the interval explicitly (CPU → ~5%) before the code fix shipped.

**Also found while fixing it:** the same `POSITION_*` env block had been committed **twice** into
`docker-compose.vps.yml`. Compose tolerated it (last key wins), which is exactly why two copies shipped
unnoticed. De-duplicated in `0096a`.

Pinned by `platform-nest/src/admin/sweep-interval-guard.test.ts` (11 cases). The incident is its own
teeth proof — the 0ms behaviour was observed on the live box, not hypothesised.

**Transferable rules:** never `Number(env ?? default)` for anything compose passes; give numeric compose
vars a REAL default, never the bare `${VAR:-}`; make every self-rescheduling loop refuse a non-positive
interval; and after enabling any flag on the box, **check CPU**, not just `/health`.

## 3.8 Test-infra gotcha that cost a false regression

`src/admin/service-assignments-org7.test.ts` failed 2 event-path cases, in isolation as well as in the
suite — and it was NOT a code defect. The disposable test Redis had been up 14 hours with stale
consumer-group state, so the consumer never saw the new events. `docker exec gaiada-redis-test-1
redis-cli FLUSHALL` → 9/9. That container is designed to be thrown away; flush it before trusting an
event-path red.

Also: `gaiada-test-pg` could not start (port `55433` held by an unrelated `mimi-postgres`), so
`gaiada-test-pg-2` on **`55435`** stood in all session.

## 3.9 Still open, in the order I would take it

| Next | Why |
|---|---|
| **Rotate `hansel@gaiada.com`'s password** | A redaction slip printed it into the session transcript. Owner action. |
| **Catalog marker** | Replaces the ceiling's interim baseline subtraction — the owner's ruled end-state (§12.1). |
| **P2-08 part B** (`decide_override`) | Dept heads cannot grant sensitive roles at all until it exists; also gates flipping dept-head assign to the owner's chosen REQUEST path. Needs a catalog entry + bundles migration + re-derived parity chain. |
| **P2-07** MCP tools + D14 | None of the Phase-2 capabilities meet the agentic-native bar — HTTP only. |
| **P2-10 / P2-11 / P2-12-FE / P2-14** | All four UI surfaces. **Not started.** Backends are live and the HR-reach question is now settled, so they can be built correctly. |
| **P2-15** backfill | No real `employees`/`positions` data exists on live; nothing changes for anyone until it does. |
| **P2-16** QA battery | Blocked on P2-07 for the agent/n8n modes. |
| **P2-17** contract sync | Partially done inline; needs a final pass. |

Deferred by design: scheduled (future-dated) JML — refused with a typed 400 because the reconciler
resolves on `valid_to IS NULL` and has no as-of axis. Phases 3–7 untouched.
