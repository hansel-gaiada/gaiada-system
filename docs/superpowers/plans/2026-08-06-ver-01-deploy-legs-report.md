# VER-01 — the D14 `deploy.staging` / `deploy.production` executable-registry legs against a LIVE platform-nest: evidence report

**Ticket:** dispatch brief "VER-01" (this doc's own header).
**Scope:** test/evidence only — no production code touched (no defects found that required a fix).
**Recipe followed:** `docs/superpowers/plans/2026-08-06-ver-04-live-legs-report.md`'s live-stack pattern —
platform-nest and mcp-hub run from source against the already-running `gaiada-test-pg` (migration
head, `0084_assistant_handoffs.sql`) and `gaiada-test-cerbos`, with a dumb local HTTP sink standing
in for WS10's not-yet-built deploy dispatch webhook.

## 0. What was started, and how

| Component | How | Port | Backing infra |
|---|---|---|---|
| platform-nest | `node dist/main.js` (built via `npm run build` — clean, no errors) | `:3030` | `gaiada-test-pg` (`:55433`, db `gaiada_platform_test`, role `platform_app_test`/`test`, NOSUPERUSER NOBYPASSRLS), `gaiada-test-cerbos` (`:3592`), `gaiada-redis-test-1` (`:56380`) |
| mcp-hub | `npx tsx src/server.ts` (source) | `:3012` | `gaiada-test-cerbos` directly; platform at `:3030` |
| deploy sink | a ~25-line `http.createServer` logging every hit to a JSONL file + stdout | **`:9912`** (per the brief's instruction — `:9911` reserved for a sibling agent) | none — stands in for `DEPLOY_STAGING_URL`/`DEPLOY_PRODUCTION_URL`, which do not point at anything real anywhere in this run |

Both `gaiada-test-pg` and `gaiada-test-cerbos` were already up and at head from prior VER-02/VER-04
runs (same database — its fixtures, incl. the agency tenant, the `wf:delivery`/`wf:report`/etc.
automation service accounts, the VER-04 superadmin, and one pre-existing `pipeline_runs` row, were
left in place and reused rather than re-seeded). `npm run build` in platform-nest is clean (no
`tsc` errors) — VER-04's Finding F1 (missing `assuranceToken` fixture field) was already resolved
by VER-02 and remains resolved.

Shared secrets, identical on both processes: `HUB_SERVICE_TOKEN=ver01-hub-token`,
`PLATFORM_SERVICE_TOKEN=ver01-platform-token`, `APPROVAL_GRANT_SECRET=ver01-grant-secret`.
`HUB_ASSURANCE_TOKEN` deliberately left unset (both registered deploy tools are `minAssurance:"low"`
and don't need it). `REDIS_URL` was SET on platform-nest, so the real `startRelayLoop()` +
`startConsumerLoop([...,"automation_approval",...])` ran for the whole session — the async,
event-driven auto-execute path was live throughout, not just for the happy-path leg.

Four fresh `pipeline_runs` rows were inserted directly via SQL (`019fd530-0001-7000-8000-00000000000{1,2,3,4}`,
tenant = Gaia Digital Agency, `019fd4ea-12c4-...`, status `delivery_active`, no stage rows) to give
each of the five DONE-WHEN items a clean, isolated unit of pipeline state — this is fixture setup
only (what the precondition reads), not part of what is under test.

## 1. What was verified — five items, five real HTTP-driven runs

### 1. Happy path end-to-end — **PASS**

`deploy.staging`, `origin=automation`, filed via a real HTTP `tools/call` against the running hub
(`approvals.request`, OBO `n8n`/`wf:delivery`) against run `...0001`, decided `approved` by the
superadmin via `POST :tenantId/automation-approvals/:id/decide`:

```
FILE:   {"id":"019fd54d-7801-741b-bd88-17f00b032fbf","status":"pending"}
DECIDE: {"id":"019fd54d-7801-741b-bd88-17f00b032fbf","status":"approved"}
```

Row read back ~1s later (no manual intervention — this is the real Redis-relayed
`automation_approval.decided` → `automationApprovalExecutorHandler` path, the same one VER-04
proved live over Redis Streams for `deploy.production`):

```json
{
  "status": "approved", "executionStatus": "executed",
  "executedAt": "2026-08-06T04:20:52.878Z",
  "executedBy": "019fd4ea-3a51-7279-9fde-1b6a5e64b898",     // wf:delivery's resolved user — the ORIGINAL filing principal
  "decidedBy": "019fd4eb-7ae8-75db-a2a4-ca9f60ba5b90",       // the superadmin — DIFFERENT id, proving executed_by != decided_by live
  "executionResult": { "outcome": "ok", "truncated": false,
    "text": "{\"dispatched\":true,\"repo\":\"acme/site\",\"ref\":\"main\",\"response\":\"{\\\"ok\\\":true,\\\"sinkHit\\\":2}\"}" },
  "executionAttempts": 1
}
```

- **`executed_by` ≠ `decided_by`, and `executed_by` is the original filer** — confirmed directly
  from the row, not inferred.
- **The sink actually received the HTTP request**, independently: its own JSONL log recorded hit
  `#2` (hit `#1` was a manual `curl` smoke test of the sink before any scenario ran) with the exact
  `repo`/`ref`/`runId`/`target:"staging"` body `deploy.staging`'s handler constructs.
- **Both terminal notifications** landed, read back from `notifications` independently of the HTTP
  response:
  ```
  019fd4eb-...(decided_by/superadmin)      automation_approval.executed  severity=info
  019fd4ea-3a51-...(requested_by/wf:delivery) automation_approval.executed  severity=info
  title = "Approved automation write executed: deploy.staging"  (both)
  ```
- **mcp-hub's own audit line** for the re-drive, read independently of platform-nest's DB:
  ```json
  {"tool":"deploy.staging","principal":{"provider":"n8n","externalId":"wf:delivery","assurance":"low"},
   "decision":"allow","ok":true,"grant":{"verdict":"accepted","approvalId":"019fd54d-7801-741b-bd88-17f00b032fbf"}}
  ```

One deliberate methodology note: `deploy.staging` is registered `impact:"low"` in the hub
(`mcp-hub/src/delivery-tools.ts`), so on the REAL automation gate path it never suspends and
therefore never reaches `automation_approvals` on its own — the D14 gate only suspends
`write && impact !== "low"`. The only way to exercise `deploy.staging`'s **registry entry**
specifically (as opposed to `deploy.production`'s, which VER-04 already drove through the real
suspend gate) is a direct `approvals.request` call asserting a filing-time impact of `medium` —
exactly VER-04's own pattern for `deploy.production`, and exactly what this ticket's own DONE-WHEN
text asks for ("File a suspended `deploy.staging` approval"). This is flagged, not hidden: item 1's
PASS is for the registry entry, executor, and notification/authority machinery, not for a claim
that `deploy.staging` suspends unattended in real n8n traffic (it structurally cannot, by design).

### 2. Server-side precondition re-evaluation (the WD-29 lesson) — **PASS**

`deploy.production`, `origin=automation`, filed against run `...0002` while it was still
`delivery_active` (the state a human sees when they click Approve):

```
FILE: {"id":"019fd54e-5137-74fc-87c0-3c3955c83f5d","status":"pending"}
```

State changed BETWEEN filing and deciding — the run was parked `blocked` (a real WD-05-style
escalation outcome, done here via one `UPDATE pipeline_runs SET status='blocked' ...` to simulate
the concurrent write a real pipeline-controller action would make):

```sql
UPDATE pipeline_runs SET status='blocked' WHERE id='019fd530-0001-7000-8000-000000000002';
```

Then approved:

```
DECIDE: {"id":"019fd54e-5137-74fc-87c0-3c3955c83f5d","status":"approved"}
```

Row read back:

```json
{
  "status": "approved", "executionStatus": "failed",
  "executedAt": "2026-08-06T04:22:01.910Z",
  "executedBy": "019fd4ea-3a51-7279-9fde-1b6a5e64b898",
  "executionError": "precondition_failed: run_blocked",
  "executionResult": null, "executionAttempts": 1
}
```

- `execution_status='failed'`, `execution_error` populated with the typed reason exactly as
  `approval-executables.ts`'s `deployPrecondition` produces it.
- **The sink was NEVER called** for this approval — confirmed by grepping mcp-hub's own
  `ver01-tool-audit.jsonl` for this approval id: zero matches (the file has no `deploy.production`
  entry carrying `019fd54e-5137-...` at all — the hub was never reached, which is the point: the
  precondition refusing means the executor never mints a grant or calls out).
- **Loud, not silent**: both terminal notifications fired at `severity=warning` (the D14-03
  invariant-4 "reaches the bell AND the MAIL-05 email tap" behaviour), read back independently:
  ```
  019fd4eb-...(superadmin)   automation_approval.execution_failed  severity=warning  err="precondition_failed: run_blocked"
  019fd4ea-3a51-...(wf:delivery) automation_approval.execution_failed  severity=warning  err="precondition_failed: run_blocked"
  ```

A failure that still fired the webhook would have been the critical defect this item exists to
catch — it did not.

### 3. The single-use claim under GENUINE concurrency — **PASS**

This is the item that most needed a real race rather than a sequential re-call, and the
architecture as built offers no HTTP surface that lets a `pending` **`origin='automation'`** row
be claimed by two independent concurrent HTTP requests (the only two entry points into
`executeApprovedAutomationWrite` for that origin are the async Redis-consumer event handler and
D14-07's `/retry`, and `/retry` only accepts a row already `failed`/wedged — never `pending`).
D14-10's `resolve-and-execute` endpoint, however, drives the SAME executor (`executeApprovedAutomationWrite`
— literally the one function, no second implementation) for `origin='agent'` rows, and it is a
plain, repeatable, real-HTTP-callable POST regardless of the row's current state. So the race was
built on `deploy.staging` filed with `origin='agent'` — genuinely one of the two ticket-named tools,
just reached via the agent re-run surface rather than the automation-decide surface, which is the
same trade VER-04 made nowhere and this report states plainly rather than hides.

Filed directly against platform-nest as a real member of the tenant with a real verified identity
link (`design@gaiada-creative.test`, a WhatsApp-linked user, `member` role — NOT an admin, NOT the
superadmin) against run `...0003`:

```
FILE: {"id":"019fd54f-0da8-71d3-a4de-909d662851be","status":"pending"}
```

Decided `approved`, then — in the SAME script tick, no delay — **8 concurrent** real HTTP
`POST :tenantId/automation-approvals/resolve-and-execute` calls fired via `Promise.all` (i.e.
genuinely in flight simultaneously, all racing each other AND the live Redis consumer, which was
also eligible to claim this exact row since `REDIS_URL` was set for the whole session):

```json
[
  {"i":0,"status":200,"body":{"match":"executing","approvalId":"019fd54f-..."}},
  {"i":1,"status":200,"body":{"match":"executed","approvalId":"019fd54f-...","consumed":false,
     "result":"{\"dispatched\":true,...,\"response\":\"{\\\"ok\\\":true,\\\"sinkHit\\\":3}\"}"}},
  {"i":2,"status":200,"body":{"match":"executing","approvalId":"019fd54f-..."}},
  {"i":3..7}: all {"match":"executing", ...}
]
```

**Exactly ONE of the eight calls (`i=1`) got `match:"executed"`; the other seven got
`match:"executing"`** (they observed the in-flight claim rather than re-executing or erroring). The
final row: `executionStatus:"executed"`, `executionAttempts:1` — one attempt, not eight.
**The sink's own log shows exactly one new hit** for this run (`sinkHit:3`, following `sinkHit:2`
from item 1 — no `sinkHit:4..10` from the other seven racers). mcp-hub's own audit file independently
confirms exactly one `deploy.staging` tool-call entry for this approval id, with the grant
`"verdict":"accepted"` — the grant (single-use, minted once per won claim) was consumed exactly once.

This is a stronger proof than a sequential double-decide would have been: 8 genuinely concurrent
real network requests plus a live async consumer all contended for one `pending -> executing`
transition, and the `UPDATE ... WHERE id=$1 AND execution_status='pending'` claim let exactly one
through.

### 4. `deploy.production` is not low-impact; REJECT executes nothing — **PASS**

Direct Cerbos replay (no grant, `deploy.production`, `impact:"high"`), confirming the policy's own
impact gate independent of anything platform-nest did this session:

```
POST /api/check/resources  resource={name:"deploy.production", write:true, impact:"high", minAssurance:"low"}
→ {"actions":{"call":"EFFECT_DENY"}, "meta":{"matchedPolicy":"resource.mcp_tool.vdefault"}}
```

`deploy.production` filed (`origin=automation`, run `...0004`) and REJECTED (not approved):

```
FILE:   {"id":"019fd54d-d493-7015-ab90-d6f391bfe58b","status":"pending"}
ROW before decide: executionStatus="not_applicable"
DECIDE: {"id":"019fd54d-d493-7015-ab90-d6f391bfe58b","status":"rejected"}
ROW after reject + 1.5s wait: status="rejected", executionStatus="not_applicable",
  executedAt=null, executedBy=null, executionError=null, executionAttempts=0
```

`execution_status` never became `pending` (confirmed by `decide()`'s own code path: the
`executable` lookup is gated on `decision === "approved"`, so a `rejected` decision computes
`executionStatus="not_applicable"` before the UPDATE even runs) and the sink log shows zero new
hits attributable to this approval id. mcp-hub's audit file has zero entries for this approval id.

### 5. A tool with NO registry entry stays `not_applicable` forever — **PASS**

`search.setBudget` — one of the money-spending tools `approval-executables.ts`'s own header
explicitly forbids ever registering — filed (`origin=automation`, `impact=high`, no `runId`/pipeline
correlation needed since it has no registry entry to evaluate a precondition against) and APPROVED:

```
FILE:   {"id":"019fd54d-fe9b-770a-8024-6097e47a5bc4","status":"pending"}
DECIDE: {"id":"019fd54d-fe9b-770a-8024-6097e47a5bc4","status":"approved"}
ROW after approve + 1.5s wait: status="approved", executionStatus="not_applicable",
  executedAt=null, executedBy=null, executionError=null, executionAttempts=0
```

`execution_status` stayed `not_applicable` through the entire decided-event / Redis-relay round
trip (the event fires and is consumed — `automationApprovalExecutorHandler` runs — but `decide()`
already computed `executionStatus="not_applicable"` at decide time because `getExecutable("search.setBudget")`
returns `undefined`, so the row is never even `pending` for the executor to look at). Zero hub
audit entries for this approval id. This doubles as a live confirmation of the registry doctrine's
money-tool bar: even asserting `impact:"high"` and getting a human `approved` decision, a tool the
registry deliberately never lists cannot be auto-executed — the safe default (registry-scoped, not
origin-scoped) holds exactly as designed.

## 2. Findings

No defects found in `core/approval-executables.ts`, `core/approval-execute.ts`,
`core/automation-approvals.controller.ts`, or `cerbos/policies/resource_mcp_tool.yaml` — every
behaviour observed matched the four invariants (authority, single-use, TOCTOU, loudness) and the
registry doctrine exactly, under real HTTP, real Postgres, real Cerbos, real Redis Streams, and
genuine concurrent load.

| # | Finding | Severity | Notes |
|---|---|---|---|
| F1 | One stray manual `curl` verification hit (`POST /x {}`) landed in the sink's JSONL log as hit `#4`, after all five scenarios had already completed and their evidence captured. It is trivially distinguishable (wrong path `/x`, empty body, no `deploy.*` shape) from the three real dispatch hits (`#2` = item 1, `#3` = item 3) and does not affect any verdict above. | informational | none required — noted for anyone re-reading the raw sink log |
| F2 | `gaiada_platform_test` (the same DB VER-02/VER-04 used) now additionally carries: 4 fixture `pipeline_runs` rows (`019fd530-0001-...`, one left `status='blocked'` from item 2's simulated state change), and 5 new `automation_approvals` rows spanning all five scenarios. Does not affect other suites (disposable `pgtest_f_*` databases are what they use, confirmed via `testing/setup.ts`). | informational | none required |

## 3. UNVERIFIED list

- **A containerized deployment path** (rebuilding `gaiada-platform-1`/a fresh `mcp-hub` container
  image) was not attempted — running both from source against the test infra, per the VER-04/VER-02
  recipe, was faster and equally real for what this ticket needs. If the specific containerized
  compose networking/baked-in-env path is itself a concern, that remains unverified — the same
  disclosed gap VER-04 and VER-02 both carry.
- **`deploy.staging`'s real automation-gate suspend behaviour** was not exercised (see item 1's
  methodology note) — it cannot be, by design, since the tool is genuinely `impact:"low"` and the
  D14 gate only suspends `impact !== "low"` writes. What was verified is the registry entry, the
  executor, and the authority/notification machinery for `deploy.staging` specifically, via the
  direct-file path VER-04 already established as the sanctioned pattern for this exact situation.
- **The real WS10 deploy-dispatch webhook** does not exist yet, so both tools' actual external
  side effect was the local `:9912` sink, never a genuine release-pipeline dispatch — consistent
  with the ticket's own instruction not to deploy anything anywhere.
- **A genuinely concurrent race on an `origin='automation'` row** (as opposed to the `origin='agent'`
  row item 3 used) was not directly exercised, because the architecture provides no HTTP entry point
  that would let one exist for `automation` today (see item 3's opening paragraph for the full
  reachability argument). The claim SQL item 3 raced against is byte-for-byte the same
  `UPDATE ... WHERE execution_status='pending'` statement both origins share (there is no second
  implementation), so this is a narrow, disclosed scope choice rather than an unverified invariant.

## 4. Cleanup

- Both ad hoc processes (platform-nest `:3030`, mcp-hub `:3012`) and the sink (`:9912`) were killed
  by PID (`Get-NetTCPConnection` → `Stop-Process`) at the end of the session; all three ports
  confirmed unreachable afterward.
- Orphan test-database count: **0 before, 0 after**
  (`SELECT count(*) FROM pg_database WHERE datname LIKE 'pgtest%' OR datname LIKE 'gapchk%'` on
  `gaiada-test-pg`) — no new disposable databases were created by this ticket (platform-nest ran
  directly against the persistent `gaiada_platform_test`, never `testing/setup.ts`'s disposable-DB
  path).
- `DEPLOY_STAGING_URL`/`DEPLOY_PRODUCTION_URL` pointed at `http://localhost:9912/{staging,production}`
  for the entire session — never at `gda-aicenter` or any real host.

## 5. Overall verdict

**All five DONE-WHEN items PASS, each with independent evidence (DB row read back separately from
the HTTP response, the sink's own log, and mcp-hub's own audit file) rather than a single shared
observation standing in for all five.**

- Item 1 (happy path): `executed_by` = original filer ≠ `decided_by` = approver, sink hit once,
  both notifications fired.
- Item 2 (precondition re-evaluation): a state change between filing and approval produced
  `execution_status='failed'` with a typed `execution_error`, the sink was never called, and both
  notifications fired at `severity=warning`.
- Item 3 (single-use under concurrency): 8 genuinely concurrent real HTTP calls plus a live async
  Redis consumer all raced for one claim; exactly one won, the sink received exactly one request,
  `execution_attempts=1`.
- Item 4 (production not low-impact; reject executes nothing): Cerbos denies an ungranted
  `deploy.production` call directly; a rejected decision never reaches `execution_status='pending'`.
- Item 5 (registry-scoped, not origin-scoped): an approved write for a deliberately unregistered
  (money-spending) tool stays `not_applicable` forever, confirming the registry's own safe default.
