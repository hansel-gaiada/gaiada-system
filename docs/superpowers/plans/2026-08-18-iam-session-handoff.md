# IAM session handoff — 2026-08-18

**What this session was asked for:** finish the Phase-1 leftovers, then continue Phase 2, pushing and
deploying between tickets, aiming to finish the whole program in a day.

**What is honest about that:** Phases 1→7 is ~25 remaining tickets including a ~39-rule policy sweep,
four UI surfaces and a QA battery. This session moved the critical path forward, shipped and verified
FOUR releases on the live estate, and left everything it touched verified. It did **not** finish the
program — the four UI surfaces were never started, and Phases 3–7 are untouched.

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
| `alpha-01.044.0096a` | the busy-loop fix (§6) | `sweep on: every 86400000ms`, CPU 4.5%, empty-value coercion demonstrated inside the container |
| `alpha-01.045.0097a` | the self-scoped marker — the ceiling's durable mechanism (§9) · migration `0114` | see §9 |
| `alpha-01.046.0098a` | **P2-08 part B** — the routed override · migration `0115` | routing + structural self-approval DENY probed live |
| `alpha-01.047.0099a` | dept-head assign → request path · **and** `0117`, FORCE RLS on `monitor_results` partitions (another session's gap) | all 4 partitions `relforcerowsecurity=t` on the box |
| `alpha-01.048.0100a` | `decide_override` split into `decide_override` + `decide_assignment` · migration `0118` | both keys, 4 holders each, description corrected |

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
4. ~~**HR cannot place, transfer or terminate anyone**~~ — **RESOLVED by owner ruling**: `hr_people_ops`
   now holds `position.assign`/`.unassign` (`0112`). `hr_staff` deliberately does not. The owner's chosen
   end-state (a dept head's assignment becoming a REQUEST) waits on P2-08 part B; direct assign stays
   live until then rather than leaving a gap. See PERMISSION-CONTRACT §11.2.
5. **The elevated fence is shadowed** on the grant surface — every fenced role is refused by an earlier
   guard, so no test can make the fence the deciding one.
6. ~~**The sensitivity flags have never been reviewed**~~ — **REVIEWED by the owner**: a READ is not
   sensitive authority except `hr.record.read`; seven keys un-flagged, 107 → 100 (`0112`). Full list:
   `2026-08-18-sensitivity-review.md`. That review is also what surfaced finding 7.
7. 🔴 **`member` could delete ANY client in the tenant, live** — pre-existing, not Phase 2. Found by
   asking why the BASELINE role held a `delete` key, then probing the live engine (ALLOW on
   create/update/delete, no `owns` gate). Owner ruled: keep create/update, drop delete. Fixed in `0095a`
   and probed DENY on live. See PERMISSION-CONTRACT §12.5.

## 4. What remains

**Superseded — see §8 below**, which is the current list. (The original §4 opened with "fix the push
credential", which turned out to be the wrong active `gh` account, and listed `expires_at` at resolution
time, which shipped in `0095a`.)

## 5. Test-infrastructure note (see also §7)

`gaiada-test-pg` could not start: port `55433` is held by an unrelated `mimi-postgres` container on
this machine. A fresh **`gaiada-test-pg-2` on `55435`** was used instead, with
`DATABASE_URL_TEST=postgres://postgres:<pw>@localhost:55435/gaiada_platform_test`, and
`gaiada-cerbos-1` was recreated (so policy is current by construction). Both containers are still
running. Either stop `mimi-postgres` and use the canonical container, or keep using `55435`.

---

## 6. 🔴 THE INCIDENT I CAUSED (and found, and fixed) — read this before adding any env-driven loop

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

## 7. Test-infra gotcha that cost a false regression

`src/admin/service-assignments-org7.test.ts` failed 2 event-path cases, in isolation as well as in the
suite — and it was NOT a code defect. The disposable test Redis had been up 14 hours with stale
consumer-group state, so the consumer never saw the new events. `docker exec gaiada-redis-test-1
redis-cli FLUSHALL` → 9/9. That container is designed to be thrown away; flush it before trusting an
event-path red.

Also: `gaiada-test-pg` could not start (port `55433` held by an unrelated `mimi-postgres`), so
`gaiada-test-pg-2` on **`55435`** stood in all session.

## 8. Still open, in the order I would take it

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

---

## 9. The self-scoped marker (`0114`) — and the correction the ruling needed

The owner ruled on 2026-08-18 that the ceiling's interim "subtract the baseline `member` bundle"
should be replaced by a per-key catalog marker. That shipped as `alpha-01.045.0097a`, with one
substantive correction found by measuring before committing to it.

**What the marker is.** `role_permissions.self_scoped`: TRUE for a (role, key) pair when EVERY Cerbos
ALLOW rule granting that key to that role is self-scoped (`resource.attr.X == principal.id`, or
`variables.owns`). 21 pairs today — member 17, viewer 4. **Derived, not hand-listed**:
`scripts/generate-role-bundles.mjs::computeSelfScoped` reuses the hazard scan's Pattern-B predicate
verbatim, emits `selfScoped` into `role-permission-bundles.json`, and
`self-scoped-marker-parity.db.test.ts` fails if policies, JSON and DB disagree.

**🔴 The marker does NOT subsume the baseline argument.** Measured with the real bundles:

| grant | required | missing with marker-only |
|---|---:|---:|
| `company_admin` → `member` | 55 | 0 |
| `org_unit_lead` → `member` | 55 | **55** |
| `hr_manager` → `hr_staff` | 15 | **1** (`core.member.read`) |

Marker-only would have refused every dept-head grant — re-breaking the surface the interim existed to
protect. Both rules now apply, each on its correct side: the **marker on the REQUIRED side** ("is this
authority over OTHER people?"), the **baseline on the HELD side** ("a grantor is themselves staff, so
passing on baseline reach confers nothing new"). The held-side placement also keeps refusals truthful —
a missing key is one the grantor genuinely lacks, not one the algebra hid.

**Why the marker was still worth building:** `hr.case.cancel` and `core.client.delete` both sat in
`member`'s bundle; the subtraction removed both, and only the first was self-service. The second was
real tenant-wide reach and a live over-grant (§12.5). A subtraction cannot tell those apart. The parity
suite pins `core.client.delete` as never-markable, on both sides of the chain.

**A bug in my own tooling, worth the warning:** the first version of the generator predicate contained a
literal backspace byte — a Python heredoc read `` as an escape — so the regex silently matched nothing
and produced 7 pairs instead of 21. It was caught by instrumenting the tally when `viewer` looked wrong,
not by reading the code. Same class as `Number("") === 0`: a value that looks right and quietly means
something else. When generating code from a script, check the emitted bytes (`cat -A`), not the source.

## 10. P2-08 part B — scoped, not started

The next ticket, deliberately left unstarted rather than half-built. Everything needed to begin:

- **The seam already exists.** `automation-approvals.controller.ts` picks the Cerbos action from the
  row's `origin` + `workflow_id` (`hr:leave` → `decide_leave`). An override is `origin='iam'`,
  `workflow_id='iam:override'` → `decide_override`. One route, no fork — the precedent is in that file.
- **The catalog convention is proven:** a literal Cerbos action can carry a domain-appropriate key —
  `hr.leave.decide` → `automation_approval:decide_leave`. So the override key is
  `core.role_grant.decide_override` → `automation_approval:decide_override`.
- **Execution must be in-band** (design §6.5), not via the D14 registry: that registry is deliberately
  origin-scoped to `automation|agent` (`approval-executables.ts`), and HR's own non-registry origin
  uses a module eventHandler — which IAM cannot, not being a module. So: execute through
  `GrantWriteService` inside the decide handler when `origin='iam'`, tagging `expires_at` +
  `origin_approval_id` (both columns already exist and are already written by P2-08 part A).
- **Requester ≠ decider** is a structural Cerbos DENY, the pattern `resource_invoice.yaml` already uses.
- **Then flip dept-head assign to the request path** (owner's chosen end-state, §11.2) — it stays
  direct until this lands, because removing a working capability with nothing in its place is worse.

Work: 1 policy edit, 1 catalog key, 1 bundles migration + regeneration, 1 request endpoint, 1 branch in
the decide handler, and an adversarial battery (self-approval, cross-tenant, expired, non-routed
approver). Roughly one focused session.

---

## 11. Where P2-07 actually stands (partial, and honestly labelled)

**Done:** the `hr` module declares `hr.listEmployees` and `hr.getEmployee` — the employee READ surface is
agent-reachable through `GET /mcp/tool-defs`, which the hub aggregates (nothing hardcoded hub-side).
`hr` owns them because `employees` sits behind the HR module's own RLS wall.

**NOT done, deliberately: the JML WRITE tools.** Design §9 requires medium/high writes to be registered
with the impact gate so *an agent-origin approval EXECUTES*. Declaring `hr.hireEmployee` /
`transferEmployee` / `terminateEmployee` before those `registerExecutableApproval` entries exist would
give an agent a path that suspends and then, on a human's approval, **does nothing** —
`getExecutable()` returns undefined for an unregistered tool, `execution_status` lands
`not_applicable`, and the hire never happens. Silently. For a hire that is a person approved and never
onboarded.

`src/modules/hr/hr-employee-tools.test.ts` pins this: the moment one of those three names is declared
without an executor, the suite goes red.

**What each write tool needs** (`deploy.staging`'s registry entry is the worked precedent):
- a `precondition` that re-checks the world at execution time — a hire whose position was retired while
  the approval waited must refuse, the same staleness rule `iam-approval-execute.ts` already applies to
  assignment requests;
- a `lockKey` keyed on the person, so two approvals for the same employee cannot interleave;
- a golden agent-mode fixture per capability, and the UI-vs-tool reach parity test §9 asks for.

**A structural gap P2-07 surfaced, which is NOT mine to decide:** `positions` and `role-grants` are CORE
controllers, and `/mcp/tool-defs` is the union of registered **modules'** tools. There is no module for
them to be declared under. Options: fold them into an existing module (semantically wrong — role
granting is not HR), introduce an `iam` module contract (a real architectural addition), or give the
platform a core-tools surface. Until one is chosen, positions and grants cannot be agent-reachable at
all, and no amount of tool-writing changes that.

## 12. 🔴 Migration numbering is broken, twice over — owner decision needed

`0114` AND `0118` are both double-booked. The second collision happened *after* this ledger gained the
rule "reserve the number by creating the file before writing DDL" — a rule followed exactly, which still
lost the race, because creating a file only helps if the other session lists the directory afterwards.
Reserve-by-file is not atomic and nothing arbitrates it.

Harmless three times running by the same three properties (deterministic `readdirSync().sort()`, a ledger
keyed on the full filename, disjoint tables). That is luck holding, not a protocol working.

Candidates, in `migrations/README.md`: per-session number blocks · **timestamp-prefixed filenames**
(recommended — removes the race by construction and the runner's sort keeps working) · a git-committed
claims file. Expect recurrence until one is picked.

---

# 2026-08-19 continuation — §§11 and 12 are CLOSED, and two live defects were found closing them

Everything in §11 and §12 above is now resolved rather than pending. Three releases:
**`Alpha 01.050.0102a`**, **`Alpha 01.051.0104a`**, plus one non-versioned tooling commit. All three
verified on the live box (`gda-aicenter`), not by a green CI run — CI on `main` is red for reasons that
belong to another session (see §16).

## 13. §11's write half is done, and the executor had an RLS hole in it

`hr.hireEmployee` / `hr.transferEmployee` / `hr.terminateEmployee` are declared, each with a D14 entry
(`registerJmlExecutableApprovals`), and all three names are in `resource_mcp_tool.yaml`'s executable
allow-list. **All three parts are load-bearing**: an entry without the allow-list passes its precondition
and is then denied at the hub door; a tool without an entry suspends and then does nothing on approval.
`hr-employee-tools.test.ts`'s invariant now reads "declared WITH an executor".

`lockKey` is the PERSON — `employeeId`, else the case-folded `workEmail` (a joiner has no employee row
yet). Preconditions detect a first attempt that already landed (`employee_already_exists`,
`already_in_target_position`, `already_terminated`) and refuse a stale request (`position_not_active`).
None sets `neverAutoRetry`: landed-ness IS observable here, which is `deploy.*`'s property rather than
`social.publishPost`'s.

🔴 **The defect worth remembering, and it was in `approval-execute.ts`, not in the new code.**
`employees` sits behind the HR module's third RLS wall; the executor opens its claim transaction with NO
module scope (correct for every prior entry, whose tables are core). With `app.scopes` unset,
`app_module_allowed('hr')` is false, so all three preconditions read **ZERO ROWS and no error** — and for
the hire that is silent in the PERMISSIVE direction: the one guard between a retried approval and a person
created twice would have passed every time. Fixed with a declared
`ExecutableApprovalEntry.preconditionModules`, applied by the executor as transaction-local `app.scopes`
before BOTH precondition sites. `d14-jml-registry.test.ts` (37 cases) asserts the BROKEN unscoped
behaviour on purpose, so the declaration cannot be dropped as cosmetic.

**Live:** `/mcp/tool-defs` on the box returns 69 tools (was 67) with the three writes at
`medium/medium/high`; the hub's own `/tools` lists 128 including all three, so the advertising chain is
closed end to end.

## 14. §11's structural gap is closed — core owns a tool surface now

`src/core/core-tools.ts` is a registry for CORE-owned tools, unioned into `/mcp/tool-defs` ahead of the
module tools. Of §11's three options this is the third: folding into `hr` is semantically wrong (and
`hr`'s tools are precisely the ones behind its RLS wall, which these are not), and an `iam`
ModuleContract would be a module whose tables are core and which no tenant can switch off.

A core tool has **no per-tenant enablement gate** — core has no flag to consult. Stated in the file
because that is a stronger default than a module tool's.

Declared: `iam.listPositions`, `iam.listAttachableRoles`, `iam.listRoleGrants`, plus
`iam.requestAssignment` and `iam.requestOverride` at impact **`low`** — their whole effect is a pending
row a human decides, and `medium` would mean needing an approval to ask for an approval.

🔴 **NOT declared, and this is an OWNER DECISION rather than missing work:** `iam.grantRole`,
`iam.revokeRoleGrant`, `iam.assignPosition`, `iam.unassignPosition`. The D14-executor objection is gone
(the pattern is worked), but a role-granting tool is a privilege-escalation surface and this estate's
audit attribution still says "Alice", not "Alice's agent". If the owner wants them: three D14 entries
plus allow-list names. Small, and blocked on the decision, not the code.

**Three of the five tool schemas were wrong on first writing** and are now pinned by a test: a filter the
handler ignores, an optional arg the endpoint 400s without, and — the worst shape — `scopeKind` where the
handler reads `scopeType`, which would have SUCCEEDED and silently defaulted to company scope.

## 15. §12 is decided: sequential migration numbering is CLOSED

New migrations are `YYYYMMDDHHMM_snake_case.sql` (UTC). `NNNN_` is closed above `0118`, enforced by
`npm run lint:migration-names` in CI. There is nothing to reserve and nobody to coordinate with.

The lint's FIRST RUN found a fourth collision nobody had noticed: **`0117` is double-booked too**
(`0117_iam_monitoring_permissions.sql` vs `0117_monitor_results_partition_rls.sql`). Five duplicate
prefixes now exist (`0003`, `0018`, `0114`, `0117`, `0118`); all are allow-listed by name and a THIRD file
on any of them fails. Applied files are never renamed — the ledger keys on the filename.
`docs/MAP.md` no longer advertises a "next free number"; advertising one is what made sessions race.

## 16. 🔴 What is red on `main` and is NOT this program's

1. **The monitoring parity drift.** MON-11a/b landed `monitor`, `monitor_channel`, `monitor_incident`,
   `monitor_maintenance` and `status_page` Cerbos policies with no `permission-catalog.json` entries, no
   bundle rows and no `permissions` rows. 12 tests fail across 7 files in `src/rbac` (catalog count,
   bundle regen-no-diff, DB parity, alignment). Nothing in `hr.*` or IAM drifted. Left alone: that ticket
   is in flight and editing its catalog underneath it would collide.
2. **Fixed here, since it was a stale pin from a SHIPPED ticket rather than in-flight work:**
   `src/mail/templates.test.ts` did not know about `social.post_failed`, which SMM-13 registered without
   updating the pin. CI's platform-nest job was failing at the mail gate before it ever reached (1).

## 17. 🔴 Cerbos had silently stopped deciding which tools a caller can see

Found by reading `docker logs gaiada-cerbos-1` while verifying `0102a`:

```
InvalidArgument: number of resources in batch (128) exceeds configured limit (50)
```

`mcp-hub`'s `visibleToolsFor` asks Cerbos about EVERY registered tool in one `CheckResources` call. The
server's batch limit is 50. So from the moment the hub passed 50 tools, every visibility check failed and
`policy.ts` fell back to the in-code engine — **Cerbos was not authoritative for the tool list**, which is
the one job `resource_mcp_tool.yaml` exists to do.

- **Not fail-open.** The in-code engine is deny-by-default and mirrors the assurance and
  automation-scope rules. What was lost is any listing rule expressible only in the policy.
- **The per-CALL path was never affected** — `cerbosAllowsTool` batches exactly one resource. So D14-13's
  executable allow-list has governed real calls throughout, including §13's new names.
- Fixed by chunking client-side at `CERBOS_RESOURCE_BATCH_MAX = 40`, concurrent chunks, merged verdicts,
  any chunk's failure rejecting the whole call (a partial allow-set is indistinguishable from a deny —
  exactly the ambiguity that let this hide). 4 new cases, verified red-then-green.

**The transferable lesson:** the fallback logged one warning and returned a plausible answer, so nothing
alerted and no test failed. When a graceful-degradation path exists, ask what proves it is not currently
active — a warning log is not that proof. Also note the hub's boot banner says "(0 from modules so far)"
before its bootstrap tick, which looks like a second failure and is not one.

## 18. Also fixed: a test that shipped red with the `0118` split

`authz-permissions.controller.test.ts`'s superadmin parity sweep probed `decide_assignment` /
`decide_override` with no `creatorId`. Those actions carry a fail-closed DENY on an unknown creator, and
`resourcePayload()` defaults an omitted `creatorId` to `""` — so the probe tripped the DENY by
construction and reported two mismatches. **The policy was right; the probe was unsatisfiable**, the same
shape as `positions.controller.ts`'s "rule a handler can never satisfy" note. Fixed by probing with a
creator who is somebody else. Earlier targeted runs never covered this file, which is why the split
shipped with it red.

## 19. Where Phase 2 stands after this

Closed: P2-06, P2-07 (both halves), P2-08, P2-09, the `decide_assignment` split, and both items §§11–12
left open. Still open and untouched: the UI surfaces (**P2-10 / P2-11 / P2-12-FE / P2-14**), **P2-15**
backfill, **P2-16** QA battery, **P2-17** doc sync, and Phases 3–7. Two things need the owner rather than
a session: the direct IAM grant tools (§14) and whether the agent-attribution gap blocks staging.
