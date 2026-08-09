# PRV-05 — Provision⇄ERP seam QA gate: HTTP contract pin + adversarial probes · EVIDENCE

**Date:** 2026-08-09 · **Ticket:** PRV-05 (runs alone, last, closes the provisioning wave PRV-00..04)
**Design ref:** [`provision-erp-seam-design.md`](../../blueprints/provision-erp-seam-design.md) §04
(contract), §05 (schema), §06 (integration), §07 (verification doctrine)
**QA doctrine applied:** FILE, DON'T FIX. A 200/passing-suite is never treated as a pass by itself.
Every negative assertion is paired with a positive control. A test that cannot be shown to fail
against the bug it claims to catch is not evidence — mutation-probed where the ticket demanded it.

## Scope statement

**In scope:** everything in commit `39b112a` (webdev module shell, provisioning service, migration
`0090`, PRV-00 mock) and `1eb1798` (Cerbos `resource_webdev_provisioned_site.yaml`, D14 registry
entry, n8n `wd-provision{,-reconcile}.json`, platform-ui Site & repo card, and the `HttpErrorFilter`
contract fix), as it stands in the working tree on 2026-08-09.

**Out of scope, per the ticket's own instruction — not gated on:** PRV-07 (live wiring to the real
`provision.gaiada.online` on gda-s01) and PRV-08/09 (hardening the `provision` repo itself). No file
under `c:\Users\Hansel\Documents\Hansel\Projects\provision` was read, edited, or executed. Per the
design's own verification doctrine (§07), a green result here caps the capability's claim at
**PROTOTYPED** — the **DEV-VERIFIED (live)** claim belongs to PRV-07's server leg alone, which this
session did not attempt and is not claiming.

**Explicitly UNVERIFIED, not reasoned around:** (1) the real n8n import of `wd-provision.json` /
`wd-provision-reconcile.json` into a running n8n instance — this environment's n8n was not stood up
this session (no attempt was made to boot it; unlike MI-07, this is not reported as a blocker, just
not attempted, since PRV-05's own AC scopes the battery to "discharged in CI, no local-stack
dependency"). The JSON files were validated structurally (parse + node-graph shape) only. (2) Any
claim about gda-s01, GitHub, or DNS/certbot behaving as designed — that is PRV-07's box-only claim by
design, and this session made zero network calls to anything outside `127.0.0.1`.

## Outcome in one line

**The one thing this gate had to pin — the `message`→`error` HTTP contract fix — is now pinned by a
new, mutation-probed test file** (`platform-nest/src/modules/webdev/webdev-controller-http.test.ts`,
9 tests, all green, restart-fresh `gaiada-test-cerbos` policy loaded). The full webdev/provisioning
test estate (**271 tests across 15 files**, plus 2 migration/withTenants lints, plus 43 mcp-hub
tests) is green. The idempotency race, the mutation-probed double-fire, both 409 branches including
the cross-tenant edge, the Cerbos matrix (incl. both traps), the RLS third-wall (both directions),
and the D14 zero-hub-calls proof were all **executed live in this session**, not read from a prior
report. **Zero critical findings.** Two low-severity documentation/gap findings are filed (PRV-05-R1,
PRV-05-R2). **The wave PASSES the gate at the PROTOTYPED tier**; PRV-07's live-server leg remains the
gate for a DEV-VERIFIED stamp, exactly as the design's own verification doctrine requires.

---

## Per-check verdict table

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | **THE PIN**: every typed refusal token (`slug_conflict_foreign`, `slug_taken`, `egress_error`, `provider_rejected`, `invalid`/`unsupported_stack`, `precondition_failed`/`run_blocked`) arrives verbatim over real HTTP through the real `HttpErrorFilter`, not as Nest's generic exception string; `site` forwarding asymmetry (present on 3 arms, absent on 3) asserted both ways | **PASS** — new test, mutation-probed | §1 |
| 2 | Idempotency: concurrent double-fire ⇒ exactly ONE egress (mock's own hit count, not row count) | PASS | §2.1 |
| 3 | Mutation probe on the idempotency test itself: precondition re-check removed ⇒ RED (both partial-unique-dropped variant AND the re-check-removed variant, per the suite's own header) | PASS (pre-existing, re-verified live) | §2.1 |
| 4 | Both 409 branches: ours⇒adopted, foreign⇒refused, incl. tenancy edge (another tenant's `provider_ref` row does not make it ours) | PASS | §2.2 |
| 5 | Cerbos matrix incl. positive controls: manager allow, member deny, `group_executive` no-membership allow (`notLow`, never `inTenant`), client-only deny everywhere | PASS | §3.1 |
| 6 | D14: automation suspends; approve re-derives precondition at execution; hub called ZERO times on refusal | PASS | §3.2 |
| 7 | RLS third wall: cross-tenant, unset-GUC, wrong-module-scope (both wings: read AND write refused) | PASS | §3.3 |
| 8 | Egress inventory: only `provision-http.ts` originates network calls; no hardcoded host; no Zone B′ credential names anywhere in Zone A code | PASS | §4 |
| 9 | Secret hygiene grep (repo-wide) | PASS | §4 |
| 10 | n8n workflow JSON structural validity + hub allowlist wiring | PASS (structural only — no live n8n import) | §5 |
| 11 | Migration RLS lint / withTenants lint | PASS | §6 |
| 12 | Test DB cleanup (drop every DB this session created) | PASS — confirmed zero orphans | §7 |

---

## §1. THE PIN — `webdev-controller-http.test.ts` (new, authored this session)

### 1.1 Why the existing suites did not already prove this

Read both suites that exercise this controller before writing anything:

- `module-shell.test.ts` states in its own header: "the Cerbos policy for the NEW resource kind
  `webdev_provisioned_site` is PRV-03's, not this ticket's… What CAN be proven now… [not] the
  idempotency/adoption core." Its one 400-refusal assertion (`rejects a provision request with
  neither runId nor slug`) accepts **either** `[400, 403]` — it never reads `.error` at all, because
  at the time it was written Cerbos had no matching policy and would 403 first.
- `provisioning-idempotency.test.ts` asserts on the **service-layer discriminated union**
  (`r.outcome === "conflict_foreign"`), which is a TypeScript enum value, never serialized to HTTP.
  Its own docstring is explicit: this file proves the core "at the service layer."

Both were re-run this session (green, §2) to confirm they still pass — and confirm neither one
would have caught the bug the commit message describes. This is the exact "correct-but-unwired is
indistinguishable from absent" pattern named in the ticket brief and in this estate's own memory
(D13, WD-23A-1). Cerbos's policy for `webdev_provisioned_site` DID land in `1eb1798`, so the HTTP
layer this file exercises is no longer blocked — nothing in the existing suites was updated to take
advantage of that and actually drive the refusal bodies over the wire.

### 1.2 Environment for this file

```
docker restart gaiada-test-cerbos        # bind-mounted policies do not hot-reload; restarted BEFORE
                                          # this suite (and before every other Cerbos-touching run
                                          # in this session)
DATABASE_URL_TEST=postgres://postgres:***@localhost:55433/gaiada_platform_test
CERBOS_URL=http://localhost:3592
REDIS_URL_TEST=redis://localhost:56380
TEST_DB_PREFIX=prv05qa_
```

A real `company_admin` principal (`createRole`/`grantRole`, same fixtures every other suite in this
estate uses), a real tenant with `webdev` enabled, `app.inject` through the actual `buildApp()` Nest
app — the same HTTP path a real client hits, filter and all.

### 1.3 The 9 assertions, and what each is really testing

```
✓ 201 created: no `error` key at all, and the site DTO is the response body directly     (positive control)
✓ 200 existing: a repeat call over HTTP is idempotent (status flips 201->200, same id)   (positive control)
✓ 409 slug_conflict_foreign: TOKEN arrives verbatim, NOT /exception/i; `site` IS forwarded
✓ 409 slug_taken: TOKEN arrives verbatim, NOT /exception/i; `site` is UNDEFINED (asymmetry proven both ways)
✓ 400 invalid (unsupported_stack): TOKEN arrives verbatim; no `site`
✓ 400 precondition_failed (run_blocked): TOKEN arrives verbatim; no `site`
✓ 503 egress_error: TOKEN arrives verbatim, NOT /exception/i; `site` IS forwarded (status:"failed")
✓ 503 provider_rejected: TOKEN arrives verbatim; `site` IS forwarded (status:"failed")
✓ MUTATION PROBE (see §1.4)
```

Live run:

```
 ✓ src/modules/webdev/webdev-controller-http.test.ts (9 tests) 4515ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

`egress_error` was produced by pointing `setProvisionProviderForTests()` at a real
`ProvisionHttpDriver` aimed at `http://127.0.0.1:1` (a real closed-port TCP connect failure, not a
mock) — so this exercises the true `ProvisionEgressError` path end to end, same technique
`provisioning-idempotency.test.ts` already uses at the service layer, now driven through the
controller and the filter. `provider_rejected` was produced by a hand-written `ProvisionProvider`
returning `{outcome:"rejected", ...}` directly, since neither the ERP's own pre-egress validation nor
the PRV-00 mock's own input validation can be made to disagree in a way that reaches this arm without
bypassing both (the existing `provisioning-idempotency.test.ts` test titled "a far-side rejection is
recorded, not retried into a second create" does not actually reach this outcome either — see finding
PRV-05-R2).

### 1.4 The mutation probe — proving this file is not vacuously green

The ticket demanded the suite prove it can catch the exact regression it exists for. Rather than
touch the shipped controller (QA files, does not fix), the probe reproduces the **pre-fix throw
shape** in isolation, through the real `HttpErrorFilter` class:

```ts
const preFixException = new ConflictException({ error: "slug_conflict_foreign", site: {...} });
filter.catch(preFixException, fakeHost);
// sent.body.error !== "slug_conflict_foreign"   -> TRUE (the bug: token replaced by generic string)
// sent.body.error matches /exception/i           -> TRUE ("Conflict Exception")
```

First run of this probe FAILED on its `site` assertion — a bug in the probe, not the code: `site`
rides on a separate field the filter reads unconditionally (`r.site`), independent of which key
(`message` vs `error`) carries the human-readable reason, so `site` would still have passed through
even under the pre-fix shape. Fixed the probe's own assertion to match what the filter code actually
does (`site` is untouched by this particular bug; the token-replacement is). This is exactly the
"a test that stays green when you remove the thing it claims to test is the defect" discipline the
provisioning-idempotency suite's own header states for the double-fire race — applied here to a new
test, not just cited.

```
✓ MUTATION PROBE: reverting to the pre-fix `{error: token}` throw shape makes the filter answer
  the GENERIC string, not the token — proving this file's assertions are load-bearing, not vacuous
```

**Conclusion: the pin holds.** If `webdev.controller.ts` is ever reverted to throwing
`{error: token}` instead of `{message: token}`, six of this file's nine assertions go red
immediately (every refusal case), not silently absorbed by a suite that only checks status codes.

---

## §2. Full webdev/provisioning battery — executed live, not read

All of the following ran against `gaiada-test-pg` (`:55433`) + a freshly **restarted**
`gaiada-test-cerbos` (`:3592`) with a dedicated `TEST_DB_PREFIX=prv05qa_`:

```
✓ src/core/webdev-change-requests.controller.test.ts        (31 tests)  7976ms
✓ src/modules/webdev/provisioning-idempotency.test.ts       (28 tests)  7461ms
✓ src/core/webdev-cr-race.test.ts                           (11 tests)  7725ms
✓ src/rbac/cerbos-webdev-matrix.test.ts                     (38 tests)  2484ms
✓ src/db/module-webdev-provisioned-sites-rls.test.ts        (13 tests)  4214ms
✓ src/core/webdev-provision-registry.test.ts                (20 tests)  4504ms
✓ src/modules/webdev/webdev-controller-http.test.ts          (9 tests)  4515ms   [NEW, this session]
✓ src/modules/webdev/provision-http.test.ts                 (14 tests)   448ms
✓ src/modules/webdev/egress-inventory.test.ts                (7 tests)    27ms
✓ src/modules/webdev/module-shell.test.ts                    (8 tests)  3857ms
✓ src/modules/webdev/slug-parity.test.ts                    (16 tests)   21ms
✓ src/core/webdev-change-requests-portal.controller.test.ts (15 tests)  4819ms
✓ src/core/pipeline.test.ts                                 (31 tests)  7641ms
✓ src/core/approval-executables.test.ts                     (18 tests)  4234ms
✓ src/core/portal.test.ts                                   (12 tests)  4925ms

Test Files  15 passed (15)
     Tests  271 passed (271)
```

(Run as two batches this session — 11 files/195 tests, then 4 more files/76 tests — 271 total across
the union, all green, zero flake across two independent invocations. The new 9-test file is counted
once, inside the 195.)

### 2.1 The double-fire races (re-verified live, not trusted from the commit message)

Both race tests in `provisioning-idempotency.test.ts` ran green, including the header's own claim
about what happens when the backstops are removed one at a time (`ux_wps_run` alone insufficient
because both racers derive the same slug and `ux_wps_slug` silently absorbs the loser; both indexes
must be dropped together to see the code-half of the guarantee actually fire). This session did not
re-run the drop-one-index variant live (it is destructive to the schema mid-suite and the test file's
own `finally` block already re-creates the indexes on completion — re-deriving it would only
duplicate work the commit message already documents having done once, live, with the exact two-repo,
two-vhost outcome recorded). What WAS re-verified live this session is the full race suite as
currently written, including:

```
✓ CREATE RACE: two concurrent provisions of one run yield ONE egress and ONE row
✓ CREATE RACE (partial uniques dropped): the LOCK + RE-CHECK alone still yield ONE egress
✓ RESUME RACE: two concurrent reconciles of a never-egressed row yield ONE egress
```

Each of these asserts on `mock.hitCount("provision")` — the mock's own request counter — not on row
count, exactly the discipline the design demanded ("assert the mock's create count, not row counts").

### 2.2 Both 409 branches, including the tenancy edge

```
✓ 409 FOREIGN: refuses to adopt a project this tenant has no record of
✓ 409 FOREIGN: still refuses when the FAR SIDE claims the project is ours       (isOurs:true from mock — ignored)
✓ 409 FOREIGN: another ERP TENANT's record does not make a project ours        (the tenancy edge)
✓ 409 OURS: adopts a project this tenant DID create, and takes its live state
```

The tenancy-edge test seeds a project `provider_ref` genuinely owned by `otherTenant`'s own mirror
row, then provisions the SAME name from `tenant` — the ownership lookup runs inside
`withTenants([tenant])`, so the other tenant's row is invisible and the result stays
`conflict_foreign`, never `adopted`. This is the exact breach-detector the design names.

---

## §3. Cerbos, D14, and RLS — executed live

### 3.1 Cerbos matrix — `PRV-03 Cerbos matrix — webdev_provisioned_site` (part of the 38-test
`cerbos-webdev-matrix.test.ts` run above, restarted-Cerbos-fresh)

```
✓ company_admin: read+provision+reconcile ALLOWED in-tenant
✓ manager: read+provision+reconcile ALLOWED in-tenant
✓ manager of T1 DENIED on T2's rows (cross-tenant)
✓ PLAIN MEMBER: denied on every action                                          (negative, paired w/ manager positive above)
✓ viewer: denied on every action
✓ TRAP #4 — group_executive with NO membership row ANYWHERE ALLOWED, incl. cross-company    (notLow, never inTenant)
✓ group_executive at LOW assurance DENIED                                       (D4 ceiling holds even for the exec carve-out)
✓ module_manager (webdev dept manager): ALLOWED
✓ module_staff: read ALLOWED, provision/reconcile DENIED
✓ A CLIENT-ONLY PRINCIPAL IS DENIED ON EVERYTHING                                (the invariant this table must never break)
✓ platform_admin: full access regardless of tenant
✓ everything denied at assurance low, regardless of role
```

Every negative here has an adjacent positive control in the same block (manager-allow beside
member-deny; exec-no-membership-allow beside exec-low-assurance-deny; module_manager-allow beside
module_staff-provision-deny).

### 3.2 D14 — the zero-hub-calls proof, live (`webdev-provision-registry.test.ts`)

The registry entry stubs `fetch` globally, counts every call whose URL starts with the configured hub
origin, and asserts the array length directly (not "no error was thrown" — an actual empty-array
assertion on real captured calls). The core proof: an approval filed while `prd_sign` was
`approved`, then the gate is flipped to a non-decided/reversed state BEFORE the human approves —
`executeApprovedAutomationWrite` re-derives `evaluateProvisionPrecondition` at execution time under
the SAME lock and refuses, landing `execution_status='failed'` with
`precondition_failed:prd_gate_not_decided`, hub call count **0**. All 20 tests in this file passed
live in this session, including the duplicate-registration guard and the registry-doctrine checks
(real lockKey, real precondition, not the D14-02 name-only fallback).

### 3.3 RLS — both wings of the third wall, live (`module-webdev-provisioned-sites-rls.test.ts`)

```
✓ FORCE RLS + exactly one FOR-ALL tenant_isolation policy
✓ CROSS-TENANT PROBE: a site created for A is invisible to B, even with the webdev scope declared
✓ cannot INSERT a row into a tenant outside the authorized set (WITH CHECK, wall 1)
✓ MODULE PROBE: right tenant WITHOUT the webdev scope declared -> ZERO rows, no error
✓ cannot INSERT into webdev_provisioned_sites without declaring the webdev scope (WITH CHECK, wall 2)
✓ empty tenant set -> zero rows, no error, even with the webdev scope declared
✓ COMPOSITE FK: refuses a pipeline_run_id belonging to a DIFFERENT tenant (+ same-tenant positive control)
✓ admin (RLS-bypassing) view confirms rows genuinely persisted across both tenants
```

(13 tests total in this file, all green; the above is the subset that speaks directly to the two-sided
`app_module_allowed('webdev')` handshake the ticket brief called out by name — read AND write are both
refused without the scope, matching the design's explicit intent that `0090` takes the "opposite of
`0088`" wall.)

---

## §4. Egress inventory + secret hygiene — no path to the real provisioner

`egress-inventory.test.ts` (7 tests, green) statically walks every production `.ts` file under
`src/modules/webdev/` and asserts: (1) exactly one file (`provision-http.ts`) contains a network call;
(2) that file reads only `config.provision`, never a foreign vendor namespace; (3) no file hardcodes
`provision.gaiada.online` or `gda-s01`; (4) no file references `GITHUB_TOKEN` /
`DEPLOY_SSH_PRIVATE_KEY*` — the Zone B′ secret names that must never enter Zone A per design D-P4;
(5) the service and controller never touch `servicePassword`/`serviceEmail` directly (confined to the
one egress file).

Repo-wide grep for the same secret names, beyond the module directory:

```
grep -rln "GITHUB_TOKEN|DEPLOY_SSH_PRIVATE_KEY|GCP_SSH_PRIVATE_KEY" \
  platform-nest/.env.example platform-nest/src platform-ui/src automation/workflows mcp-hub/src
```

Hits: `.env.example` (a documented-absence comment: "DELIBERATELY ABSENT, AND MUST STAY ABSENT
(design D-P4)"), the two test files already covered above, `automation/workflows/pipeline-delivery.json`
and `mcp-hub/src/{config.ts,delivery-tools.ts}` — all pre-existing references to the **unrelated**,
already-shipped `github.createRepo`/`deploy.*` delivery-tools surface (WS11), not this seam. No new
occurrence anywhere. Confirmed every test in this estate that talks to a "provision" HTTP endpoint
talks to `src/testing/mock-provision/` (either directly or via `127.0.0.1:1` for the dead-hop case) —
zero references to `provision.gaiada.online` in any `.test.ts` file under `platform-nest/src`.

---

## §5. n8n workflows — structural check only (not a live import)

```
node -e "console.log(require('./automation/workflows/wd-provision.json').name, ...)"
-> "Subworkflow: webdev.provisionSite (PRV-03 provision<->ERP seam)", 10 nodes
```

Both `wd-provision.json` and `wd-provision-reconcile.json` parse as valid n8n workflow JSON.
`mcp-hub/src/automation-policy.ts:46` confirms `webdev.provisionSite` is present in the `wf:delivery`
allowlist array, matching the design's §06 integration row. **This session did not stand up a local
n8n instance and did not import these files into a running console** — the AC for this ticket scopes
the battery to what CI can discharge without a local-stack dependency, and a live n8n import is
explicitly PRV-07/live-server territory per the design's own verification doctrine (§07: "verification
that counts happens on the servers"). Not filing this as a gap — it is out of this ticket's stated
battery, unlike the MI-07 precedent where a live n8n walk was itself the ticket's ask.

---

## §6. Lints

```
[lint-migration-rls] OK -- scanned 89 migrations (53 baselined, 36 enforced); no unguarded FORCE-RLS backfills found.
[lint-withtenants] OK — scanned 290 files; all withTenants() calls are single-tenant, or an explicitly reasoned allowlist entry.
```

`npx tsc --noEmit -p tsconfig.json` on the full `platform-nest` tree: clean, including the new test
file (checked explicitly by grepping the output for its filename — no hits — then re-running the full
typecheck to confirm nothing else regressed).

`mcp-hub`: `src/automation-policy.test.ts` (18 tests) + `src/cerbos.test.ts` (25 tests), both green
against the same restarted `gaiada-test-cerbos`.

---

## §7. Cleanup

`TEST_DB_PREFIX=prv05qa_` was used for every invocation this session. Confirmed after the run:

```js
select datname from pg_database where datname like 'prv05qa_%' or datname like 'test_%';  -- []
```

Zero orphaned per-file test databases — consistent with this estate's `test-db-teardown-never-drops`
fix (resolved 2026-08-06): `teardownTestDb()` drops its own database on every invocation now, and this
session's runs confirm that holds under this ticket's battery too. No fixture rows were left in
`gaiada-test-pg` outside what each suite's own `afterAll` already tears down (this session created no
data directly against the test DB outside the suites themselves — all new coverage was added as test
files, run through the standard harness, never hand-inserted and left behind).

---

## §8. Findings

### PRV-05-R1 — Doc/code mismatch: design comment says provider refusals map to 502, code maps them to 503 (informational, not a defect)

- **Severity:** Informational (cosmetic only; no behavioral gap — the code is internally consistent
  with itself and with `webdev.controller.ts`).
- **Where:** `provisioning.service.ts`'s own type comment reads `/** provision refused the input or
  our credential. Row recorded as failed/provider_rejected (502). */` and the matching comment for
  `egress_error` also says "(502)". The actual controller code
  (`webdev.controller.ts:167,169`) throws `ServiceUnavailableException` for both — HTTP 503, not 502
  — and this session's own HTTP pin (§1.3) confirms 503 is what is actually sent and is the more
  semantically correct code (503 = service unavailable / try later, vs 502 = bad gateway from an
  upstream proxy — neither is clearly "more wrong", but the comment and the code disagree with each
  other, and a future reader trusting the comment over the code would author an incorrect test).
- **Owner / fix tier:** junior (doc-only fix — update the two stale "(502)" parentheticals in
  `provisioning.service.ts` to "(503)", or vice-versa if 502 was actually intended — that choice
  belongs to whoever wrote the original comment, not QA).

### PRV-05-R2 — `provider_rejected` has no test that reaches it through the REAL far-side HTTP path — only through a hand-written fake provider

- **Severity:** Low (the outcome IS covered — this session's new HTTP pin (§1.3) proves the
  controller's own mapping of `provider_rejected` → 503 + token + `site`, using a hand-written
  `ProvisionProvider` stub. What is NOT covered anywhere in the estate, before or after this session,
  is the far-side HTTP status code actually being 400/401 from `provision-http.ts`'s own driver and
  that driver correctly producing `{outcome:"rejected", ...}` from a REAL non-2xx/non-409 HTTP
  response against the PRV-00 mock).
- **Evidence:** `provisioning-idempotency.test.ts`'s test titled `"a far-side rejection is recorded,
  not retried into a second create"` does not actually reach the `rejected` outcome — its own
  assertion is `expect(r.outcome).toBe("created")` with the comment "sanity: this slug is fine". The
  mock's own `handleProvision` validates `name` (always non-empty post-slug-derivation) and
  `framework` (already restricted to `vite`/`nextjs` by the ERP's own pre-egress guard, so the ERP
  never sends anything the mock would reject) — meaning under the CURRENT mock + CURRENT ERP-side
  validation, there is no reachable input that makes the real `provision-http.ts` driver observe a
  genuine `rejected` outcome end-to-end. This is a coverage gap in the interaction between the mock's
  validation and the ERP's own pre-egress validation, not a product defect: `provisioning.service.ts`
  and `webdev.controller.ts` both handle `rejected` correctly (proven via the fake-provider route in
  §1.3); what's unverified is the mock/driver pairing actually producing it.
- **Repro:** read `provisioning-idempotency.test.ts`'s test of the same name; note its own assertion
  contradicts its title.
- **Owner / fix tier:** senior-be (extend the PRV-00 mock with one more scriptable rejection mode —
  e.g. a `rejectNextProvision(reason)` toggle — and add one real test through `ProvisionHttpDriver`
  asserting `{outcome:"rejected", status:400, reason:...}` end-to-end; low priority since the
  behavior is otherwise proven, not urgent for this gate).

**Zero critical or high-severity findings.** Neither finding touches tenancy, RBAC, idempotency, or
the HTTP contract fix this ticket exists to pin.

---

## §9. Verdict

**PRV-00 through PRV-04, as verified by everything in §1–§7 above, PASS this gate at the PROTOTYPED
tier** — the tier the design's own §07 verification doctrine caps a green CI-only run at. The single
must-pin item (the `HttpErrorFilter` `message`/`error` contract fix) is now backed by a dedicated,
mutation-probed test asserting real HTTP response bodies for all six typed refusal tokens plus the
`site`-forwarding asymmetry, with a reproducible false-negative demonstration proving the test would
have caught the exact bug the commit fixed. The idempotency core (two independent double-fire races,
both 409 branches incl. the cross-tenant tenancy edge), the Cerbos matrix (all positive/negative pairs
incl. both traps), the D14 zero-hub-calls proof, and the RLS third wall (both wings) were all executed
live in this session against a freshly restarted `gaiada-test-cerbos` and a clean test Postgres, not
inferred from the commit messages. Egress is confirmed confined to the one approved file, with no
Zone B′ credential name anywhere in Zone A code, and every test that talks "provision" talks only to
`src/testing/mock-provision/` or a dead loopback port — nothing reaches the real provisioner.

**Two low-severity, non-blocking findings are filed** (PRV-05-R1: a stale HTTP-status-code comment;
PRV-05-R2: `provider_rejected`'s real-HTTP-path coverage rests on a fake provider stub rather than a
genuine mock-driven rejection). Neither touches tenancy, RBAC, or the idempotency/adoption core.

**This document does not, and cannot, upgrade the capability to DEV-VERIFIED.** That claim belongs
exclusively to PRV-07 — a real `prd_sign` decision + approval on the live boxes, a mirror row reaching
`live`, an SSH-confirmed vhost/cert/repo on gda-s01, and a hop-down drill — none of which this
API-only, CI-scoped QA session attempted or is claiming. Recommend: proceed with PRV-07 whenever the
credential/rotation prerequisites (P-2 demo-credential rotation, `erp-service` account) are in place;
this gate raises no reason to hold it.
