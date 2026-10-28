# Runbook - re-import the four n8n workflows that now pass `tenantId` to the AI tools (AIP-03b)

**Status: PLANNED.** Nothing here has been run on a server. The owner runs every live step, one at a time, and pastes the
real output back. Plan: `docs/plans/2026-10-27-ai-plan.md` (AIP-03b). The repo is PUBLIC: every value below is a
`<placeholder>`; real company ids and tokens stay on the server.

## What changed and why

Release 448 made the MCP hub record each gateway call as an `ai_usage_events` row. The company comes ONLY from the tool
call's own `tenantId` argument; a call with no `tenantId` writes no row (correct: never bill the wrong company). Four
workflow files now pass it. Nothing else in them changed (ids, node names, graph are identical).

| File | Declared id | Company comes from |
|---|---|---|
| `automation/workflows/mtg-dispatcher.json` | `ws11mtgdispatch0` | the bridge envelope's `tenantId` (all four AI calls) |
| `automation/workflows/pipeline-delivery.json` | `ws11delivery0001` | the run's `tenant_id`, read by `pipeline.getRun` (both `design.prototype` calls) |
| `automation/workflows/wd-digests.json` | `wswddigests00001` | `$env.AGENCY_TENANT_ID`, the same company its feed and notify calls already use |
| `automation/workflows/summarize-via-mcp.json` | NONE declared (see step 3) | `$env.N8N_USAGE_TENANT_ID`; empty by default = no usage row |

`compliance-gate-nag.json` makes no AI call and is not touched.

## Prerequisites

1. The mcp-hub release that accepts `tenantId` on `llm.summarize`, `llm.extract` and `design.prototype` (the AIP-03b
   release) is deployed. Importing earlier is harmless, but no usage is recorded until the hub is current.
2. Set `N8N_USAGE_TENANT_ID` (new, optional, default empty) in `automation/.env` on the n8n host ONLY if the owner wants
   `summarize-via-mcp` calls recorded against one company. Then recreate the container so it reaches `$env`:
   `docker compose up -d n8n` (use the box's usual compose file set, including `docker-compose.vpsnet.yml`).
   `N8N_BLOCK_ENV_ACCESS_IN_NODE` is already `"false"` in `automation/docker-compose.yml`, so `$env.*` works.

## Steps

The container name below is `gaiada-automation-n8n-1`; confirm it with `docker ps`. Run from the repo checkout that holds
the new files. Under Git Bash, prefix `docker exec` with `MSYS_NO_PATHCONV=1`. This is the procedure in
`automation/CLAUDE.md` ("Import with the CLI, never the public API"): never import through `POST /api/v1/workflows`.

### 1. List what is live (record the ids and which are active)

```sh
docker exec gaiada-automation-n8n-1 n8n list:workflow
```

Note, for each of the four, whether it is currently active. Import turns an imported workflow OFF, so this list is what
you reactivate in step 4.

### 2. Import mtg-dispatcher, pipeline-delivery and wd-digests (they declare an id, so import replaces in place)

```sh
for f in mtg-dispatcher pipeline-delivery wd-digests; do
  docker cp automation/workflows/$f.json gaiada-automation-n8n-1:/tmp/$f.json
  docker exec gaiada-automation-n8n-1 n8n import:workflow --input=/tmp/$f.json
done
docker exec gaiada-automation-n8n-1 n8n list:workflow
```

Verify the listing shows exactly the declared ids (`ws11mtgdispatch0`, `ws11delivery0001`, `wswddigests00001`) and no new
duplicate row. This check is the point: `pipeline-delivery` is referenced by id from other workflows.

### 3. Import summarize-via-mcp (it declares NO id: do not import the file as it is)

The file has no top-level `id`, so a plain import would create a second workflow with a random id and a clashing
`summarize` webhook. Take the live id from step 1 and stamp it onto a temporary copy:

```sh
LIVE_ID=<id of "summarize-via-mcp (template)" from step 1>
node -e 'const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));j.id=process.argv[2];fs.writeFileSync(process.argv[3],JSON.stringify(j))' \
  automation/workflows/summarize-via-mcp.json "$LIVE_ID" /tmp/summarize-via-mcp.stamped.json
docker cp /tmp/summarize-via-mcp.stamped.json gaiada-automation-n8n-1:/tmp/summarize-via-mcp.json
docker exec gaiada-automation-n8n-1 n8n import:workflow --input=/tmp/summarize-via-mcp.json
docker exec gaiada-automation-n8n-1 n8n list:workflow
```

The repo file stays without an id (adding one is a separate decision). If the workflow was never imported on this box,
import the repo file directly.

### 4. REACTIVATE every workflow that was active in step 1 (import deactivated them)

n8n 2.x has no `update:workflow --all`; publish per workflow, only for ones that were active before:

```sh
for id in ws11mtgdispatch0 ws11delivery0001 wswddigests00001 "$LIVE_ID"; do
  docker exec gaiada-automation-n8n-1 n8n publish:workflow --id="$id"
done
```

CLI-published workflows register their webhooks only after a restart, so then:

```sh
docker restart gaiada-automation-n8n-1
```

Do this when no meeting recording or gate decision is in flight. The event bridge redelivers on failure and the
workflows already dedupe.

### 5. Verify

- `n8n list:workflow` / the UI: the four are active again (`mtg-dispatcher` and `pipeline-delivery` have webhook
  triggers, `wd-digests` its two schedules).
- Drive one: `POST /webhook/summarize` with `{"text":"..."}`. With `N8N_USAGE_TENANT_ID` set the hub writes one
  `ai_usage_events` row for that company; with it empty, no row (correct).
- For a real company's flow, fire a meeting recording through the bridge, or let the next `wd-digests` run, then on the
  database (the owner runs it):

```sql
SELECT occurred_at, tenant_id, surface, capability, task, outcome
FROM ai_usage_events ORDER BY occurred_at DESC LIMIT 10;
```

  Rows from `mtg-dispatcher` and `pipeline-delivery` carry the meeting's or run's own company, never one the workflow
  chose.

## Roll back

Re-import the previous version of the four files from git (`git show <sha>:automation/workflows/<f>.json`) with the same
steps. Usage rows already written stay; later calls simply stop recording.
