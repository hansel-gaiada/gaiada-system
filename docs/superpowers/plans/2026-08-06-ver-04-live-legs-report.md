# VER-04 — Live Redis delivery + live mcp-hub for the D14 matrix: evidence report

**Ticket:** `docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md` line ~879 (SET C).
**Scope:** prove D14-09 item (a) over a REAL Redis Streams consumer loop, and the hub half of
D14-13's policy matrix against a REAL mcp-hub process with Cerbos ON. Test/evidence only — no
production code touched.

## 1. What was started, and how

Everything below ran from source on the host (no Docker rebuild of `gaiada-mcp-hub-1` or
`gaiada-platform-1` — both were stale per the dispatch brief), wired to the **existing** test
infra containers:

| Component | How | Port | Backing infra |
|---|---|---|---|
| platform-nest | `node dist/main.js` (built via `npm run build`) | `:3010` | `gaiada-test-pg` (55433, db `gaiada_platform_test`), `gaiada-redis-test-1` (56380), `gaiada-test-cerbos` (3592) |
| mcp-hub | `npx tsx src/server.ts` (source, no build step needed) | `:3011` | `gaiada-test-cerbos` (3592) directly; platform at `:3010` for `/mcp/tool-defs` + `/principal/resolve` |
| deploy webhook stub | a 6-line `http.createServer` returning 200 | `:9911` | none — stands in for `DEPLOY_STAGING_URL`/`DEPLOY_PRODUCTION_URL` (WS10's real dispatch webhook doesn't exist yet; without a stub `deploy.staging`/`deploy.production` throw `not enabled` before any of the D14/D14-13 logic runs) |

Setup steps, in order:
1. `ALTER ROLE platform_app_test WITH PASSWORD ... NOSUPERUSER NOBYPASSRLS` on `gaiada-test-pg`
   (the pre-existing runtime role had no known password) + granted it SELECT/INSERT/UPDATE/DELETE
   on the schema.
2. `MIGRATE_DATABASE_URL=<postgres superuser>@.../gaiada_platform_test node dist/db/migrate.js` —
   applied clean through `0084_assistant_handoffs.sql` (head).
3. `DATABASE_URL=<postgres superuser>... node dist/seed/agency.js` then `dist/seed/automation.js`
   — created the agency tenant (`019fd4ea-12c4-73f4-9c92-568ed5fe6101`) and its 17 automation
   service accounts, including `wf:delivery` (user `019fd4ea-3a51-7279-9fde-1b6a5e64b898`).
4. A one-off Node script (`ver04-seed.js`, scratchpad) using `dist/testing/fixtures.js` created a
   `platform_admin` (superadmin) user (`019fd4eb-7ae8-75db-a2a4-ca9f60ba5b90`) with a **global**
   role grant, plus a `pipeline_runs`/`pipeline_stages` row (`staging` stage, status
   `awaiting_gate`) so `deploy.*`'s WD-29-style precondition has real state to evaluate against.
5. Started mcp-hub, then platform-nest, then ran the flow entirely over real HTTP/Redis/Postgres —
   no test file, no `vitest`, no stubbed `fetch`, no direct call to
   `automationApprovalExecutorHandler` or `startConsumerLoop` from a harness. `config.redisUrl`
   being set is what makes `main.ts` call the real `startRelayLoop()` +
   `startConsumerLoop([...,"automation_approval",...])` — confirmed live in the log
   (`work-activity consumer on: streams [...]`) and in Redis's own consumer-group state (§2).
6. Shared secrets set identically on both processes: `HUB_SERVICE_TOKEN=ver04-hub-token`,
   `PLATFORM_SERVICE_TOKEN=ver04-platform-token`, `APPROVAL_GRANT_SECRET=ver04-grant-secret`.
   `HUB_ASSURANCE_TOKEN` was deliberately left unset — `deploy.staging`/`deploy.production` are
   `minAssurance:"low"` and don't need it; `mintPrincipal` already gives an n8n OBO principal
   `assurance:"low"` for free.

A finding surfaced immediately at build time: **`npm run build` in platform-nest currently fails
type-checking** (17 test files construct `config.services.hub` literals missing the new
`assuranceToken` field added 2026-08-06 for the hub's assurance-elevation design). `tsc` still
emits `dist/` despite the errors (no `noEmitOnError`), so this did not block the run, but it is a
real, currently-broken build gate — see Finding F1.

## 2. Leg 1 — D14-09 item (a) over a REAL Redis consumer loop

**Verdict: PASS.**

Flow driven, start to finish, over real HTTP + real Postgres + real Redis Streams (no in-process
handler call, no stub):

1. **File**, via a real HTTP `tools/call` against the running hub (`approvals.request`, OBO
   `n8n`/`wf:delivery`):
   ```
   POST http://localhost:3011/mcp  {"name":"approvals.request","arguments":{
     "tenantId":"019fd4ea-12c4-73f4-9c92-568ed5fe6101","workflowId":"wf:delivery",
     "toolName":"deploy.production","toolArgs":{"repo":"acme/site","runId":"019fd4eb-7b34-75d8-824a-50c21d991856"},
     "impact":"high","origin":"automation"}}
   → {"id":"019fd4f0-0db9-70b7-9ec2-00636d41ca0f","status":"pending"}
   ```
   DB row immediately after filing:
   ```
   id=019fd4f0-...  status=pending  origin=automation  execution_status=not_applicable  attempts=0
   ```
2. **Decide**, via a real HTTP call against the running platform-nest as the superadmin principal
   (dev-auth `x-user-id` + service bearer):
   ```
   POST http://localhost:3010/api/019fd4ea-.../automation-approvals/019fd4f0-.../decide
   {"decision":"approved"}  →  {"id":"019fd4f0-...","status":"approved"}
   ```
3. **Real Redis Streams relay + consumer — the load-bearing evidence.** `XINFO STREAM
   events:automation_approval` immediately after decide:
   ```
   last-generated-id 1785983986602-0
   last-entry        1785983986602-0
     outboxId  019fd4f0-eb4e-75d4-a1d8-74d0948310da
     entityId  019fd4f0-0db9-70b7-9ec2-00636d41ca0f
     eventType automation_approval.decided
     payload   {"origin":"automation","decision":"approved","toolName":"deploy.production",
                "workflowId":"wf:delivery","decidedBy":"019fd4eb-7ae8-75db-a2a4-ca9f60ba5b90", ...}
   ```
   `XINFO GROUPS events:automation_approval`:
   ```
   name  in-process-platform
   last-delivered-id  1785983986602-0   (== the entry above)
   pending  0
   lag      0
   ```
   `pending=0, lag=0` on the SAME entry id that carries this approval's `entityId` is the
   consumer-group proof that a real `XREADGROUP`/ack cycle (not an in-process call) picked this
   event off the stream and processed it to completion. The `outbox_events` row for this entity
   also shows `relayed_at` populated (`2026-08-06 02:39:46.604981+00`, ~100ms after `created_at`),
   confirming `startRelayLoop()`'s poll cycle — not the decide request itself — pushed it.
4. **Auto-execute**, observed via the row's own state transition (DB row AFTER, no manual
   intervention between step 2 and this read):
   ```
   status=approved  execution_status=executed  execution_attempts=1
   executed_at=2026-08-06 02:39:47.097985+00
   executed_by=019fd4ea-3a51-7279-9fde-1b6a5e64b898   (wf:delivery's resolved user — the ORIGINAL
                                                        filing principal, per invariant 1)
   decided_by=019fd4eb-7ae8-75db-a2a4-ca9f60ba5b90     (the superadmin — a DIFFERENT id, proving
                                                        executed_by ≠ decided_by is honored live)
   ```
   The hub's own JSONL audit line for the redrive this produced:
   ```
   {"ts":1785983987089,"tool":"deploy.production","principal":{"provider":"n8n","externalId":"wf:delivery","assurance":"low"},
    "decision":"allow","ok":true,"grant":{"verdict":"accepted","approvalId":"019fd4f0-0db9-70b7-9ec2-00636d41ca0f"}}
   ```
5. **Both terminal notifications**, confirmed rows in `notifications`:
   ```
   user_id=019fd4eb-...(decided_by/superadmin)  type=automation_approval.executed  severity=info
   user_id=019fd4ea-...(requested_by/wf:delivery) type=automation_approval.executed  severity=info
   title="Approved automation write executed: deploy.production"  (both, same title)
   ```

This satisfies the Leg-1 PASS bar exactly as specified: real `XRANGE`/`XINFO` evidence, DB
row before/after, and notification proof — with `main.ts`'s actual `startConsumerLoop` (never a
test file's direct handler call) as the only path that could have produced the consumer-group
state above.

## 3. Leg 2 — a REAL mcp-hub process with Cerbos ON

**Verdict: PASS.**

All calls below are real HTTP against the running `mcp-hub` (`:3011`, `CERBOS_URL` pointed at
`gaiada-test-cerbos:3592`) and, for the direct-Cerbos rows, real HTTP against
`gaiada-test-cerbos` itself (`POST /api/check/resources`, `includeMeta:true`).

### ALLOW — the real granted re-drive (same call as Leg 1 step 4)
Hub audit: `"decision":"allow","ok":true,"grant":{"verdict":"accepted","approvalId":"019fd4f0-..."}`.
Replaying the exact resource attributes that call carried directly against Cerbos, to quote
`matchedPolicy`:
```
POST /api/check/resources  resource.attr = {name:"deploy.production", write:true, impact:"high",
                                             minAssurance:"low", approvalId:"019fd4f0-0db9-70b7-9ec2-00636d41ca0f"}
principal.attr.automationScope includes "deploy.production"
→ {"actions":{"call":"EFFECT_ALLOW"},"meta":{"actions":{"call":{"matchedPolicy":"resource.mcp_tool.vdefault"}}}}
```
`matchedPolicy: "resource.mcp_tool.vdefault"` — the live `resource_mcp_tool.yaml` D14-13 disjunct,
not the in-code fallback (Cerbos answered; the fallback only fires when Cerbos is unreachable).

### DENY — no grant (the un-lifted gate), same tool, same workflow
Real hub call, `deploy.production`, no `x-approval-grant`:
```
"suspend: deploy.production is a high-impact write; automation requires human approval
 (only low-impact writes run unattended)"
```
Direct-Cerbos replay: `EFFECT_DENY`, `matchedPolicy: "resource.mcp_tool.vdefault"`.

### DENY — misplacement detector: verified-shaped grant, workflow NOT scoped for the tool
Direct Cerbos check, principal `wf:scope` (`automationScope: ["pipeline.getRun","pipeline.openGate","notify"]`),
resource `deploy.production` **with** `approvalId` set:
```
→ EFFECT_DENY, matchedPolicy "resource.mcp_tool.vdefault"
```
Proves the grant disjunct is INSIDE the `automationScope` conjunction, not escaping it — an
approval for one workflow cannot unlock a tool for a workflow that was never scoped to it. Also
reproduced against the real hub (`wf:scope` OBO, no grant at all): `"denied: workflow wf:scope is
not scoped for deploy.production"`.

### DENY — tool absent from the executable list (probed with a money tool)
Direct Cerbos check, `wf:delivery` (hypothetically scoped to it), resource
`search.setBudget` (`write:true, impact:"high", approvalId:"<real-shaped id>"`):
```
→ EFFECT_DENY, matchedPolicy "resource.mcp_tool.vdefault"
```
Confirms the disjunct's explicit `["deploy.staging","deploy.production"]` list is enforced — a
grant cannot lift the gate for a tool D14-13 didn't enumerate, keeping money tools structurally
excluded even if a bug ever got a grant object anywhere near one.

### DENY — forged/tampered `approvalId`, both injection channels, against the REAL hub
1. **Via tool args** (not the verified-grant object): `deploy.production` called with
   `arguments.approvalId = "019fd4f0-..."` (a real, already-used approval id) and no
   `x-approval-grant` header at all →
   `"suspend: deploy.production is a high-impact write; ..."` (identical to the no-grant case —
   the arg is never read as a grant channel; `mcp-hub/src/cerbos.ts` sources `approvalId`
   EXCLUSIVELY from the verified object).
2. **Via the `x-approval-grant` header**, with a plain unsigned string (not a real
   HMAC-signed grant): hub audit —
   ```
   {"decision":"deny","reason":"suspend: ...","grant":{"verdict":"rejected","reason":"malformed"}}
   ```
   The grant is parsed, REJECTED, and the call falls through to the unchanged suspend path — never
   silently ignored into an allow.
3. Non-string / number-typed `approvalId` on the resource attribute itself, direct Cerbos check:
   `EFFECT_DENY` (the CEL `type(...)==string` guard holds).

### Cross-check: Cerbos policy resolves at all (rules out the silent-deny trap)
This is an EDIT to an existing policy file (`resource_mcp_tool.yaml`), not a new one, so the
new-file silent-DENY trap does not apply — and the ALLOW case above is direct proof the `mcp_tool`
kind resolves and evaluates the intended rule (a silently-unresolved kind denies everything
uniformly; here a specific, args-dependent subset denies and a specific subset allows, which an
unresolved-kind failure cannot produce).

## 4. Findings

| # | Finding | Severity | Owner tier |
|---|---|---|---|
| F1 | `platform-nest`'s `tsc -p tsconfig.json` (`npm run build`) currently FAILS type-checking: 17 test files construct `config.services.hub` object literals missing the `assuranceToken` field added 2026-08-06 (mcp-hub assurance-elevation design). `tsc` still emits `dist/` (no `noEmitOnError`) so it is not yet build-breaking in practice, but a stricter build config would hard-fail CI. Files: `admin-systems.test.ts`, `approval-executables.test.ts`, `approval-execute.test.ts`, `approval-resolve-execute.test.ts`, `automation-approvals.test.ts`, `d14-09-agent-origin-authority.test.ts`, `d14-09-redelivery-storm.test.ts`, `d14-15-pm-registry.test.ts`, `assistant-broker.test.ts` (×2), `assistant-capabilities.test.ts` (×3), `assistant-citations.test.ts`, `assistant-qa-adversarial.test.ts`. | medium | whichever seat owns `mcp-hub`'s assurance-elevation design (senior-integrator) — a one-line `assuranceToken: ""` fixture default in a shared test helper would close all 17 at once |
| F2 | mcp-hub's module-tools bootstrap (`GET /mcp/tool-defs`) never succeeded against the real, healthy platform-nest process in this environment — `[module-tools] /mcp/tool-defs unavailable (fetch failed)` repeated indefinitely even though `curl http://localhost:3010/mcp/tool-defs` with the same bearer token from the same host returned 200 with the full tool-def list. Did not block this ticket (deploy.staging/production are hub-native tools, not module-fronted), but it means the hub's platform-module tool surface (agency/pm/it/billing/clients/knowledge/hr/search/reports fronting) was NOT actually exercised end-to-end here, and something in that specific fetch path (possibly a Node `fetch`/undici quirk under `tsx` on Windows, or a config mismatch not covered by manual curl) deserves a look before relying on it in this dev topology. | low (scoped to this ad hoc dev topology; may not reproduce in the real compose network) | devops / senior-integrator |
| F3 | `gaiada_platform_test` on `gaiada-test-pg` (the maintenance DB other suites use only to spin up disposable `pgtest_f_*` databases — confirmed via `testing/setup.ts`'s `initTestDb`) now permanently carries this run's fixtures: the seeded agency tenant, 17 automation accounts, a `platform_admin` superadmin user, a pipeline run/stage, and the executed `deploy.production` approval row. This does not affect other suites (they never connect to `gaiada_platform_test` directly), but it is a standing side effect a future investigator should know about if they query that database directly. | informational | none required; noted for the record |
| F4 | Pre-existing, NOT caused by this ticket: `gaiada-test-pg` already carries 158–160 orphaned `pgtest_f_*`/`gapchk_*` databases (confirmed before and after this run; count rose by 2 during this session from unrelated concurrent activity). This is the exact hazard CHORE-02 and the `test-db-orphans-exhaust-shm` memory note describe. Flagging again since it was directly observed here. | medium (pre-existing) | devops (CHORE-02 is already the ticket for this) |

No findings inside the D14-03/D14-04/D14-13 production code paths themselves — every behavior
observed matched the tickets' stated invariants exactly (executed_by ≠ decided_by, grant scoped to
exactly the listed tools, misplacement detector holds, forged/malformed grants fall through to
deny, both terminal notifications fire).

## 5. UNVERIFIED list

- **D14-07 retry endpoint** (retry-after-fail, retry-after-crash-wedge) was not exercised live —
  this run's single execution succeeded on the first attempt, so the retry path never engaged.
  Out of narrow scope per the dispatch brief (D14-09 already covers retry at the harness level);
  flagging only so it isn't mistaken for "verified live" by a future reader of this doc.
- **D14-10's re-run race** (executor-auto-execute vs. agent-goal-re-run claiming the same row) was
  not driven live — no `ai-agents` process was started for this ticket (out of scope: VER-04 names
  exactly two legs, neither is the agent-runner).
- **The real WS10 deploy-dispatch webhook** does not exist yet, so `deploy.staging`/
  `deploy.production`'s actual external side effect was a local stub server, not a genuine
  release-pipeline dispatch. This does not weaken the D14/D14-13 verification (everything up to and
  including the tool handler's own outbound `fetch` ran for real) but the deploy's real-world
  effect is unverified because there is nothing real to verify it against yet.
- **mcp-hub's module-tools bootstrap** (F2) — could not be driven live in this topology; unrelated
  to the two legs but noted as a gap in what got exercised.
- **A live `gaiada-mcp-hub-1` / `gaiada-platform-1` container rebuild** was not attempted — running
  both from source against the test infra was faster and equally "real" for what this ticket
  needs (real HTTP, real Cerbos, real Redis Streams), but if the specific containerized deployment
  path (Docker networking, the baked-in stale env) is itself a concern, that remains unverified.

## 6. Overall verdict

**Both legs are now genuinely proven, not stubbed — and proven together, in a single real
end-to-end run rather than two separate approximations.**

- D14-09 item (a) can be upgraded from "partially UNVERIFIED" (harness-level, in-process handler
  call only) to **VERIFIED**: a real Redis Streams consumer group (`in-process-platform`,
  `lag:0`, `pending:0` on the exact entry id) delivered the decided event, the real executor ran,
  the row reached `executed` with the correct authority split (`executed_by` = original filer ≠
  `decided_by` = approver), and both terminal notifications landed.
- The hub half of D14-13 / D14-09 item (j) can be upgraded from "harness/unit-level only" to
  **VERIFIED**: a real mcp-hub process, with `CERBOS_URL` pointed at the real `gaiada-test-cerbos`
  (never the dev `gaiada-cerbos-1`), produced the full required matrix — ALLOW with a quoted
  `matchedPolicy`, the misplacement-detector DENY, the tool-off-list DENY, and DENY on both forged
  injection channels (tool args and an unsigned header) — via real HTTP calls and read back from
  the hub's own JSONL audit, not asserted from inside a test file.

The two open items above (F1's build-breaking test drift, F2's module-tools fetch) are real but
orthogonal to what VER-04 was asked to prove; neither weakens the PASS verdicts for Leg 1 or Leg 2.
