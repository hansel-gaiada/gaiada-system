# Agent event spine (S0) — deploy notes

Status: **BUILT AND VERIFIED LOCALLY. NOT DEPLOYED.** Per the overnight scope boundary this ticket was
given ("build and verify locally only; do not deploy, push, tag, or touch any live/remote database"),
this document replaces the deploy step — it is what the owner (or the devops seat) runs when ready.

Companion doc: `docs/superpowers/plans/2026-08-22-agent-floor-plan.md` §4 S0 — the spec this implements.

---

## 1. What ships

All changes are confined to `ai-agents/` (the standalone agent-runner/knowledge service). Nothing in
`platform-nest/`, `platform-ui/`, or any other service changed.

| File | What changed |
|---|---|
| `ai-agents/src/agent.ts` | New `StepEvent`/`EmitStep` types; `runAgent` takes an optional 5th `emit` param, called at every step boundary (model call, tool call, approval consult, terminal error) |
| `ai-agents/src/evals/trace.ts` | `traceRun` takes an optional 7th `emit` param, forwarded to `runAgent` |
| `ai-agents/src/write-agent.ts` | `WriteAgentOptions.emit`, forwarded to both internal `runAgent` calls |
| `ai-agents/src/orchestrator.ts` | New `DelegationTracking`/`SpecialistRunRecord` types; `runOrchestrator` takes optional `runId`/`emit`/`delegation` in its options bag; emits `delegate` events and calls `onSpecialistRun` for each specialist it spawns |
| `ai-agents/src/runner/store.ts` | New `agent_run_events` table + `agent_runs.parent_run_id` column (both via the existing inline-DDL `init()`); `GoalStore.insertEvent`/`listEvents`; `RunInput`/`RunSummary`/`RunRow` gain `parentRunId` |
| `ai-agents/src/runner/events-bus.ts` | **New file.** In-process EventEmitter pub/sub for the SSE route (see §4 for why this is not Redis) |
| `ai-agents/src/runner/service.ts` | `makeEmitter()` (persists + republishes events, fail-soft); `activeRunsByGoal` (ephemeral, in-memory); wires emitters/delegation into all three `processGoal` branches; two new routes: `GET /runs/:id/events` and `GET /runs/:id/events/stream`; `GET /goals/:id` gains an additive `activeRunIds` field |
| `ai-agents/src/*.test.ts` (agent, orchestrator, runner/store, runner/service) | New tests — see the report for counts |

**No changes to any existing table shape, response field meaning, or route behaviour.** Every new field
is additive (`parentRunId`, `activeRunIds`, the two new routes). Existing consumers —
`platform-nest/src/admin/intelligence.controller.ts` and the `/agents` UI — read a fixed, explicit
whitelist of fields from the runner's JSON (see `reshapeGoal`/`reshapeRun` there) and silently ignore
anything new, so they are unaffected. Verified by reading, not just asserted — see the final report.

---

## 2. What must be applied, in order

This is **not a migration** in the platform-nest sense — `ai-agents` has no migration runner. Schema
changes here are inline DDL inside `PgGoalStore.init()`, run automatically every time the `agent-runner`
process boots (the exact mechanism `agent_goals`/`agent_runs` already use — see `store.ts`'s own header).
There is nothing to run by hand beyond shipping the new code.

1. **Pre-flight (mandatory, per the overnight brief's deploy rails):**
   - Disk headroom checked and pruned first (`docker system df`, prune if needed).
   - Push credentials verified BEFORE building anything.
   - Confirm the FULL compose file set will be used — `docker-compose.build.yml` +
     `docker-compose.vps.yml` together, never `vps.yml` alone (`server-compose-file-set.md`).
   - Never pass `--remove-orphans`.
2. **Gate (must ALL be green, or abort — no forcing):**
   - `cd ai-agents && npm ci && npm run typecheck && npm test` — clean, as verified locally (see the
     final report for the actual run).
   - There is no `DEMO_MODE=1 npm run build` step for `ai-agents` — it has no build script (`tsx` runs
     TypeScript directly; see `package.json`). The equivalent gate here is `npm run typecheck` (already
     required above) plus the smoke check in step 4.
3. **Build + push** the `gaiada-ai-agents` image exactly as the existing pipeline does
   (`docs/superpowers/plans/hand-built-deploy-runbook.md` if the Actions pipeline is down;
   `git push --tags` otherwise per `deployment-pipeline.md`). No new build steps, no new Dockerfile
   changes — this ticket added no dependencies.
4. **Roll `agent-runner` AND `knowledge`** — both containers run the SAME image
   (`ghcr.io/.../gaiada-ai-agents:${GAIADA_TAG}`; see `infra/compose/docker-compose.vps.yml` lines
   ~863–894), so both restart on this deploy even though only `agent-runner`'s boot path
   (`PgGoalStore.init()`) touches the new schema. This is expected and does not need to be prevented.
5. **Schema applies itself on `agent-runner` boot.** `PgGoalStore.init()` runs:
   - `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id text;` (idempotent on a table that
     already has the column — safe to run every boot, as it already does for `agent_goals`/`agent_runs`).
   - `CREATE TABLE IF NOT EXISTS agent_run_events (...)` + two indexes (also idempotent).
   - Runs under `MIGRATE_DATABASE_URL` (the `knowledge_owner` role) exactly like the existing tables —
     **no new DB role, no new grant step**: `init-cluster.sh` already default-grants future
     `knowledge_owner`-created tables to `knowledge_app` (the runtime role both `agent-runner` and
     `knowledge` connect as) — see `store.ts`'s own header comment, unchanged by this ticket.
   - If BOTH containers restart around the same moment, this is harmless: every statement is
     `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`, and Postgres serializes concurrent DDL on the same
     table (the loser of a race waits, not errors, on `CREATE TABLE IF NOT EXISTS` in practice on modern
     Postgres; if it ever did conflict, `agent-runner` simply fails one boot attempt and `restart:
     unless-stopped` retries it — no data loss, no corruption, because nothing here writes application
     data, only DDL).

---

## 3. Rollback

Because every change is additive:

- **Code rollback** is a plain image rollback to the previous `GAIADA_TAG` — no DDL undo required. The
  new `agent_run_events` table and `agent_runs.parent_run_id` column simply go unused by the older code;
  they do not block it (older code never selects `parent_run_id` by name — it uses explicit column lists
  everywhere in `store.ts`, confirmed by reading, not assumed).
- **If a DDL rollback is ever wanted anyway** (e.g. to fully undo the schema, not just the code):
  ```sql
  DROP TABLE IF EXISTS agent_run_events;
  ALTER TABLE agent_runs DROP COLUMN IF EXISTS parent_run_id;
  ```
  Run this manually against `gaiada_knowledge` as `knowledge_owner` — there is no automated down-migration
  because there is no migration framework in this service. Only do this if the code rollback ALSO
  happened first (older code never references either, but never run a schema drop against code that's
  still writing to it).
- **No data migration, no backfill.** `agent_run_events` starts empty; `parent_run_id` starts NULL on
  every existing row. Nothing pre-existing needs correcting.

---

## 4. What to check afterwards

Standard post-deploy discipline for this estate (per the owner's memory, both scars are real and have
bitten before — do not skip either):

1. **`docker ps -a`, not `ps`.** A plain `ps` hides a crash-looping container behind a green list of
   everything else. Confirm both `agent-runner` and `knowledge` show `Up` and are NOT in a restart loop
   (check `docker inspect --format '{{.RestartCount}}' <container>` if in doubt — a climbing count means
   `init()` is failing every boot, most likely a DDL or connection-string problem).
2. **`/health` — reports the EXPECTED version, not merely responds.** Honest caveat: **`agent-runner`'s
   `/health` does not carry a version field today** (`{ ok, agents, writeAgents, queue }` — verified by
   reading `service.ts`; this predates this ticket and this ticket did not add one, staying additive-only
   per its own constraint). A green `/health` response is therefore NOT sufficient evidence of which
   image is actually running — this is the exact "rolled-back deploy misreports version" trap the brief
   warns about, except here it's worse: there is no version string to misreport, so `/health` alone
   cannot even be WRONG about it, it is simply silent. Verify the running image directly instead:
   ```bash
   docker inspect --format '{{.Config.Image}}' <agent-runner-container-id>
   docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' <agent-runner-container-id>   # if the build sets this label
   ```
   and confirm it matches the tag/digest just pushed. **Follow-up worth filing**: add a `version` field to
   `agent-runner`'s `/health` (reading `package.json` or a baked build arg), matching the platform-wide
   `/VERSION`-is-source convention (`app-versioning-scheme.md`) — out of scope for S0 itself (additive-only;
   not asked for in the spec), but the gap this deploy note just worked around should not persist.
3. **Functional probe — confirm the new routes actually exist on the deployed instance** (a route can be
   missing from a bad build even when `/health` is green):
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $AGENT_RUNNER_TOKEN" \
     "https://<host>/runs/00000000-0000-0000-0000-000000000000/events?tenant=<any-real-tenant-uuid>"
   # expect 200 with {"events":[]} for a nonexistent run id (this endpoint deliberately never 404s —
   # see store.ts's GoalStore.listEvents doc) — a 404 here means the route did not deploy.
   ```
4. **Schema probe:**
   ```sql
   \d agent_run_events            -- table exists, expected columns
   \d agent_runs                  -- parent_run_id column present
   SELECT count(*) FROM agent_run_events;  -- 0 immediately after deploy; climbs as goals run
   ```
5. **Drive one real goal end-to-end** post-deploy (the same shape as the local proof in the final
   report): trigger a goal, poll `GET /goals/:id` for `activeRunIds`, confirm `GET /runs/:id/events`
   returns events while `status` is still `running`. This is the actual feature — a route that 200s with
   an empty list forever is not proof it works.
6. **On ANY anomaly:** stop, leave the estate as found (roll the image back per §3), write up what was
   seen. Do not retry in a loop, per the overnight brief's standing instruction.

---

## 5. Explicit scope boundaries and deviations from the spec (read before building on top of this)

- **The SSE bus is a bare in-process `EventEmitter`, not Redis**, unlike `portal-stream.controller.ts`'s
  pattern. This is deliberate, not a shortcut: `agent-runner` runs its whole goal queue in one process
  today (`GoalQueue` is in-memory — see `queue.ts`), so there is no cross-process "someone else's write"
  case to solve for yet. **If `agent-runner` is ever horizontally scaled, `events-bus.ts` is exactly
  where a Redis (or `LISTEN`/`NOTIFY`) backend slots in** — the SSE route in `service.ts` only depends on
  `events-bus.ts`'s two-function interface, not on EventEmitter specifically.
- **No `platform-ui` proxy route.** The floor-plan spec's §4 item 5 also names a
  `platform-ui/src/app/api/agents/stream/route.ts` handler (the single-egress carve-out). This ticket's
  scope explicitly excluded touching anything under `platform-ui/` (another session was mid-flight
  there) — building that proxy is follow-up work for whoever picks up S1/S2.
- **`GET /runs/:id/events`/`/events/stream` do not 404 for a wrong tenant or nonexistent run — they
  return an empty list/stream.** Every other tenant-scoped read in this file (`GET /goals/:id`,
  `GET /runs/:id`) 404s on a tenant mismatch specifically to avoid cross-tenant existence-probing. The
  events endpoints deliberately deviate: an in-flight run frequently has **no `agent_runs` row at all**
  (rows are still only inserted once a run ends — unchanged, additive-only), so gating the events
  endpoint on one existing would defeat the entire point of an in-flight endpoint. This is not a data
  leak (results are always tenant-filtered at the SQL/pub-sub level) — it's a narrower "nothing here" than
  the rest of the API gives, documented in `store.ts`'s `GoalStore.listEvents` doc and pinned by a test.
- **`activeRunIds` on `GET /goals/:id` was NOT in the original spec** — it was added because building
  the in-flight proof surfaced a real gap: without it, a client has no way to discover a run's id while
  it is still executing (the only place a runId is normally surfaced — the `runs[]` array — is populated
  at the END of a run, same as before this ticket). It is ephemeral and per-process, mirroring the
  existing `suspendedIntentsById` pattern (T2b) exactly — never persisted, never queryable after the
  goal ends. Flagging this because it is the one place this implementation went beyond the literal spec
  text; it is small, additive, and necessary for the spec's own stated goal ("prove in-flight emission"
  is not achievable by an external client without it).
- **`orchestrator.ts`'s `onSpecialistRun` hook does NOT fire for the three whole-goal-aborting rethrows**
  (`GoalSuspendedError`, `ApprovalRequiredError`, `GoalBudgetExhaustedError`). Those carry the goal's
  blackboard, not a clean single-specialist step transcript, so no `agent_runs` row is persisted for that
  specific specialist attempt in that case. The in-flight EVENTS for that specialist still exist (tagged
  to a runId with no corresponding row — the same "no FK" shape the supervisor's own events already use)
  — only the final row-with-parent-edge is the thing not attempted here. See `orchestrator.ts`'s
  `DelegationTracking` doc and the corresponding test
  (`orchestrator.test.ts`: "onSpecialistRun is NOT called for the whole-goal-aborting rethrows").
- **Append-only is an application-layer guarantee, not a DB-role-enforced one.** `GoalStore` exposes only
  `insertEvent`/`listEvents` — no update, no delete — matching every other table this file owns. A
  stricter guarantee (`REVOKE UPDATE, DELETE ON agent_run_events FROM knowledge_app`) would need a real
  migration in the platform-nest sense and is DB-seat territory; flagged here as a natural follow-up, not
  attempted in this ticket (schema/grant changes need the senior-db seat or an architect-approved spec —
  this ticket's own operating rule).
