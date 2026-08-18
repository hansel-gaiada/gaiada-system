# IAM session handoff — 2026-08-18

**What this session was asked for:** finish the Phase-1 leftovers, then continue Phase 2, pushing and
deploying between tickets, aiming to finish the whole program in a day.

**What is honest about that:** Phases 1→7 is ~25 remaining tickets including a ~39-rule policy sweep,
four UI surfaces and a QA battery. This session moved the critical path four tickets forward and left
everything it touched verified. It did **not** finish the program, and the deploy leg never ran.

---

## 1. 🔴 THE DEPLOY LEG IS BLOCKED (the one thing needing the owner)

`git push` returns **403**: the credential in the working environment is `ClementHansel`, which has no
write access to `hansel-gaiada/gaiada-system`. Deployment in this program is *defined* as
`git push --tags`, so **nothing below has reached `erp.gaiada.online`.**

Four commits sit on local `main`, in order:

| Commit | What |
|---|---|
| `ab078b4` | docs: the rollout register re-derived from the policies; three stale rows closed |
| `0c2bccf` | feat: P2-06 (JML) + P2-12 backend (positions) |
| `0d037a0` | feat: P2-08 part A (grant/revoke) + P2-09 (expiry + drift sweep) |
| `a02e65e` | docs: changelog + `platform-nest` 0.23.0 + regenerated MAP |

To ship: fix the credential, `git push origin main`, then the normal tag → `release.yml` →
`deploy.yml` path (`infra/runbooks/deploy-vps.md`). Migrations `0109`/`0110`/`0111` apply on boot.
⚠ Re-check `GAIADA_TAG`/`APP_VERSION` parity on the box first — a stale `.env` silently rolls back.

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
