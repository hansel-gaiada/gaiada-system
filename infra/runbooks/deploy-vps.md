# Runbook — Deploy the Trial Stack to the Personal VPS

One box, one compose file. Services: Postgres, Redis, WAHA, ai-gateway (Go), Keycloak, Cerbos,
platform-nest (API) + platform-ui, whisper, knowledge, mcp-hub, the bot + media-worker, and the
idle `sync-central` (waits on a real second site). Only WAHA's dashboard, Keycloak's admin
console (both localhost-bound), and the UI (`:3005`) are reachable; everything else is
box-internal.

> **The VPS no longer builds anything.** Every first-party service is pinned to a signed
> GHCR image (`GAIADA_TAG`), and routine deploys are one command — `git push --tags` — run
> by `.github/workflows/deploy.yml`. See `../../docs/blueprints/deployment-strategy.md`.
> What follows is the **one-time bootstrap** and the **manual/break-glass** path.

## Prerequisites

- Ubuntu/Debian VPS with Docker + the compose plugin (`curl -fsSL https://get.docker.com | sh`).
- The `gaiada-system` folder on the box — but only `infra/` is needed now; CI rsyncs compose
  files and scripts on every deploy. No application source, no Go/Node toolchain.
- Nothing needs to be publicly reachable. Telegram uses outbound long-polling; WAHA's
  dashboard binds to localhost (reach it with `ssh -L 3000:localhost:3000 user@vps`).
- `docker login ghcr.io` works on the box (CI re-authenticates per deploy with a
  short-lived job token; images are private because the repo is private).

## First deploy

```bash
cd gaiada-system/infra/compose
cp .env.example .env            # fill in: openssl rand -hex 16 for every token/password
                                # (UI_SESSION_SECRET is REQUIRED — compose aborts if it's blank)
cp groups.example.yaml groups.yaml   # edit once you know the real group ids

export GAIADA_TAG=v0.6.0        # the release you want; must exist in GHCR
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml run --rm --no-deps platform node dist/db/migrate.js
docker compose -f docker-compose.vps.yml up -d --no-build
docker compose -f docker-compose.vps.yml ps    # everything Up + healthy?
docker compose -f docker-compose.vps.yml logs -f bot   # watch it come up
```

To build from your working tree instead (local dev, or a box with no registry access),
layer the build override — this is the ONLY supported way to compile from source:

```bash
docker compose -f docker-compose.vps.yml -f docker-compose.local.yml \
               -f docker-compose.build.yml up -d --build
```

Keycloak imports the `gaiada` realm from `keycloak/gaiada-realm.json` on first boot, but the
platform stays in `AUTH_MODE=dev` until you set client secrets + MFA and flip
`PLATFORM_AUTH_MODE=oidc` (see `../../docs/runbooks/idp-keycloak.md`).

Then per surface:

- **Telegram (works immediately):** set `TELEGRAM_BOT_TOKEN` in `.env`, `up -d` again.
  DM the bot; group ids appear in the logs → add to `groups.yaml` (hot-reloads, no restart).
- **WhatsApp:** tunnel to the WAHA dashboard, start the `default` session, scan the QR with
  the spare number (once — the session persists in a volume).

## Update to a new version

**Normal path — one point, from your laptop:**

```bash
git tag v0.6.1 && git push --tags
```

That builds + signs every image, then `deploy.yml` backs up the databases, pulls, migrates,
starts, and health-checks the box. Watch it in the Actions tab. Nothing to do on the VPS.

**Rollback:** re-run the `deploy` workflow with the previous tag (Actions → deploy → Run
workflow). Images are already on the box, so this is a container restart, not a rebuild.
Schema is *not* reverted — migrations are forward-only; the pre-deploy backup is the
escape hatch.

**Break-glass (CI unavailable), on the box:**

```bash
cd gaiada-system/infra/compose
export GAIADA_TAG=v0.6.1
../scripts/backup.sh
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml run --rm --no-deps platform node dist/db/migrate.js
docker compose -f docker-compose.vps.yml up -d --no-build
```

## Changing a variable in `.env` on a running box

```bash
./infra/scripts/wire-env.sh platform          # recreates + echoes the vars back
VERIFY='RENDERER_TOKEN|REPORT_RENDERER_URL' ./infra/scripts/wire-env.sh platform
```

`docker compose restart` does **not** pick up an edited `.env` — compose bakes the environment
at container *create* time, so a restart re-runs the old environment while looking like it
worked. Only a recreate (`up -d --no-deps <svc>`) re-reads the file. The script also carries the
non-obvious invocation the VPS needs (`-f docker-compose.hostdata.yml --profile bot --profile
auth`); without those, postgres/redis are profile-disabled and compose rejects the project.

## Backups (nightly)

```bash
chmod +x ../scripts/backup.sh
crontab -e   # add:
# 0 3 * * * /home/<user>/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
```

Backs up all three application DBs (`gaiada`, `gaiada_platform`, `gaiada_knowledge`) — one
`*.sql.gz` each. **Never back up any data volume** — the bot's holds `keys.json` (LocalKms);
key material in the backup set voids crypto-shred (see `../../docs/runbooks/erasure-divestiture.md`).
Copy the newest `~/gaiada-backups/*.sql.gz` off-box weekly (e.g. `scp` to your laptop).

## Uptime alerting (optional)

`scripts/healthcheck.sh` pings each service's `/health` and, on any failure, sends a Telegram
message (set `TELEGRAM_BOT_TOKEN` + `ALERT_CHAT_ID`). Add to cron alongside the backup:

```bash
# */5 * * * * TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... /home/<user>/gaiada-system/infra/scripts/healthcheck.sh >> /var/log/gaiada-health.log 2>&1
```

## Health checks (manual)

```bash
C=docker compose -f docker-compose.vps.yml exec -T bot wget -qO-
$C http://bot:3001/health
$C http://ai-gateway:3002/health
$C http://mcp-hub:3003/health
$C http://platform:3004/health
$C http://knowledge:3005/health
$C http://platform-ui:3005/         # UI is also published on the host at :3005
$C http://report-renderer:3007/health   # TR-19 sidecar; internal-network only, no published port
```

Auth-gate smoke check (TR-19 acceptance criterion — a token-less request must 401; run from a
container on the same compose network, since `report-renderer` has no published port):

```bash
docker compose -f docker-compose.vps.yml exec -T platform \
  wget -qO- --header="Content-Type: application/json" \
  --post-data='{"url":"http://platform-ui:3005/"}' http://report-renderer:3007/render
# expect: HTTP 401 (busybox wget prints the body on error with -qO- but exits non-zero;
# check the response body / use curl -i from a debug shell if you need the status line)
```

## Known caveats — builds unverified in this dev environment

No Docker is available in the day-to-day dev environment these components were authored in.
**Validate the following on a real Docker host before any deploy that includes them** — do not
assume a passing local `npm test`/`go test` means the container builds or runs:

- `ai-gateway-go` — `docker build` and `docker compose config` never run against Docker locally.
- `render-gateway-go` — planned; same caveat will apply once it's built.
- ~~**`report-renderer` (TR-19)**~~ — **CLEARED 2026-08-03 on the production VPS itself**
  (`gda-aicenter`, Docker 29.7.0, linux/amd64). `docker build` of the pinned
  `mcr.microsoft.com/playwright:v1.61.1-noble` image succeeded, and a container on the live
  `gaiada_default` network returned: `/health` → `{"status":"ok"}`; an authorised render of
  `http://platform-ui:3005/` → **200 `application/pdf`, 16 624 bytes starting `%PDF-`** (a real
  `chromium.launch()` → `page.pdf()`, not a stub); a foreign origin → **403** (SSRF guard); no
  token → **401**. Nothing about this image remains unverified on the target host. The earlier
  Docker-Desktop-only verification is in `docs/modules/CHANGELOG.md`'s report-renderer entry.

## Cerbos: adding a NEW policy file (ASST-02 lesson, 2026-08-05)

Confirmed again while building `resource_assistant_thread.yaml` / `resource_assistant_memory.yaml`
(ASST-02): a **newly-added** Cerbos policy file is not picked up by `watchForChanges: true` over a
bind mount the way an *edit to an existing file* is — and an unlisted resource `kind` is a **SILENT
DENY** (every check against it returns deny, with no error anywhere), which reads exactly like an
authorization-logic bug in the new code, not a stale-policy problem.

- **Prod is already covered.** `deploy.yml`'s "Reload Cerbos policies" step (added for CP-18, the
  client-portal `resource_contract.yaml` rollout, and re-verified live 2026-08-04 — see
  `../../docs/plans/2026-08-04-client-portal-deployment.md`) runs `docker compose restart cerbos`
  unconditionally on every deploy, after `up -d` and before the health gate. It does not
  distinguish "new file" from "edited file" — it restarts every time — so a deploy that ships
  `resource_assistant_thread.yaml`/`resource_assistant_memory.yaml` (or any future new
  `resource_*.yaml`) needs **no extra step**. Do not assume prod is broken just because a fresh
  policy file was added; the existing step already handles it.
- **Local/dev is NOT covered automatically.** After adding a new policy file to
  `platform-nest/cerbos/policies/` on a dev box, restart the Cerbos container that the thing you're
  testing actually talks to, and confirm `healthy` before trusting any result:
  ```bash
  docker restart gaiada-test-cerbos   # the container the platform-nest TEST SUITE reaches (:3592)
  # NOT gaiada-cerbos-1 — that's the app's own dev Cerbos; restarting it changes nothing the tests see.
  docker inspect --format '{{.State.Health.Status}}' gaiada-test-cerbos   # wait for "healthy"
  ```
- **Before trusting a DENY, prove the kind resolves at all.** A matrix where every principal is
  denied on every action looks exactly like a passing "owner-only" test and is the signature of an
  unlisted kind. Smoke-check with `includeMeta: true` and read `matchedPolicy` off the response —
  `docker cp`/`docker exec` cannot help here (Cerbos is distroless, and `docker cp` reads the HOST
  bind-mount path anyway, never what the running process has loaded):
  ```bash
  curl -s -X POST http://localhost:3592/api/check/resources -H "Content-Type: application/json" -d '{
    "requestId":"smoke","includeMeta":true,
    "principal":{"id":"u1","roles":["user"],"attr":{"assurance":"high","companies":["t1"],"grants":[]}},
    "resources":[{"actions":["read"],"resource":{"kind":"assistant_thread","id":"x",
      "attr":{"id":"x","tenantId":"t1","ownerId":"u1","projectId":"","teamId":"","module":"","subjectUserId":""}}}]
  }'
  # expect "matchedPolicy":"resource.assistant_thread.vdefault" — its absence means the kind never loaded.
  ```

## nginx SSE: assistant stream (ASST-09, 2026-08-05)

The assistant's reply stream is Server-Sent Events, and nginx buffers proxied responses by
default — a client behind it receives nothing until the response completes, so a streaming
assistant renders as a frozen page. The client portal's own SSE stream
(`core/portal-stream.controller.ts`) hit exactly this and needed a hand-applied
`proxy_buffering off` vhost block before it worked in production (see
`../../docs/plans/2026-08-04-client-portal-deployment.md`). The assistant needs the identical
treatment.

**Only one hop crosses the public vhost.** Two SSE-shaped paths exist, but only one is reachable
through nginx:

1. `GET /api/assistant/threads/:id/stream` — **platform-ui's own proxy** (browser-facing; this is
   the one the browser fetches, because a bearer token can never reach client JS —
   `platform-ui/src/app/api/assistant/threads/[id]/stream/route.ts`). This is the path nginx must
   treat specially.
2. `GET /api/:tenantId/assistant/threads/:id/stream` — **platform-nest's** route
   (`assistant.controller.ts`). Route (1)'s handler calls this one itself, server-side, over
   `PLATFORM_URL` (in-cluster `http://platform:3004`), **never through the public vhost.** Node's
   own `fetch`/`ReadableStream` plumbing has no buffering proxy in front of it there, so this
   second hop needs no nginx change at all — don't add a block for it, there is nothing for it to
   attach to.

**The block (already in the repo, `infra/nginx/erp.gaiada.online.conf`, inserted right before
`location /`):**

```nginx
location ~ ^/api/assistant/threads/[^/]+/stream$ {
    proxy_pass http://127.0.0.1:3005;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header Connection        "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    gzip off;
}
```

Same shape as CP-5's `location = /api/portal/stream` block just above it in that file, on
purpose — `docs/FRONTEND-BFF-CONTRACT.md`'s SSE-BEHIND-A-PROXY note says to reuse it rather than
invent a variant. One deliberate difference: it is a **regex** location (`~`), not an exact-path
one, because the assistant route carries a thread id in the URL — an exact match can't express
that.

1. **Apply on the box** (this repo change does not deploy itself — nginx config is never synced
   by CI, same as the portal block before it):
   ```bash
   ssh gda-aicenter
   sudo cp /etc/nginx/conf.d/erp.gaiada.online.conf \
           /etc/nginx/conf.d/erp.gaiada.online.conf.bak-$(date -u +%Y%m%dT%H%M%SZ)
   sudo $EDITOR /etc/nginx/conf.d/erp.gaiada.online.conf   # paste the block above, before `location /`
   sudo nginx -t && sudo systemctl reload nginx
   ```
2. **Verify streaming is genuinely incremental, not one buffered flush** — open a real thread in
   the UI first so a `messageId` exists, or drive the route directly with a valid session/bearer
   and `messageId`:
   ```bash
   curl -N -s --max-time 15 \
     -H "authorization: Bearer $SESSION_OR_SERVICE_TOKEN" \
     "https://erp.gaiada.online/api/assistant/threads/$THREAD_ID/stream?messageId=$MESSAGE_ID"
   ```
   Expect `data:` frames to print one at a time, paced by the model's own token cadence — the
   first should arrive within a second or two, not after the full 15s timeout. If the terminal
   sits silent and then dumps every token at once right before `curl` exits, nginx is still
   buffering: re-check the block landed before `location /` (location order matters — nginx
   evaluates this regex location after all plain-prefix locations, so a `location /` defined
   *before* it would still lose to it, but a stray copy-paste error putting the new block
   *outside* the `server {}` block would not) and that the reload actually picked it up (`nginx
   -T | grep -A3 'assistant/threads'`).
3. **Cerbos.** This release also ships two NEW policy files,
   `resource_assistant_thread.yaml` and `resource_assistant_memory.yaml` (ASST-02). See "Cerbos:
   adding a NEW policy file" above — **prod needs no extra step** (the existing `deploy.yml`
   "Reload Cerbos policies" step restarts Cerbos unconditionally on every deploy, which is
   sufficient for a brand-new file). This is called out here only so nobody mistakes a Cerbos
   403 on the assistant surface for an nginx problem while debugging this ticket, or vice versa —
   they are independent failure modes that happen to ship in the same release. For **local dev**,
   the new policy files need the local-only step in that section
   (`docker restart gaiada-test-cerbos`, not `gaiada-cerbos-1`) before the assistant's Cerbos
   checks will resolve at all.

**Rollback:** restore the timestamped `.bak` copy, `nginx -t && systemctl reload nginx`. The SSE
block is additive-only (a new `location` block) and touches nothing else in the vhost, so
rollback cannot regress `/n8n/`, `/idp/`, the portal stream, or the UI root — verify with a plain
`curl -I https://erp.gaiada.online/` (expect 200) after any nginx change here regardless of
direction.

## Security notes

- All service tokens are distinct random values; the only exposed port is localhost-bound.
- Provider keys exist only in the `ai-gateway` service env (D8).
- OpenBao replaces the file-based LocalKms before real-data ingestion (checklist 0.4) — it
  belongs on a SEPARATE VPS from this stack, per the day-one spec.
- `report-renderer` (TR-19) holds only the shared `RENDERER_TOKEN`, never a tenant credential, and
  is origin-locked to `PLATFORM_UI_INTERNAL_URL` (`report-renderer/src/auth.ts`) so a leaked token
  cannot be used to make it fetch arbitrary internal or external hosts.

## Web Dev department — post-deploy checklist (learned on gda-aicenter, 2026-08-03)

The delivery chain (record → transcribe → ingest → pipeline run → gates) needs three things the
deploy does NOT do for you. All three shipped wrong to gda-aicenter and the department sat dead —
extraction never ran, then ran but opened zero gates.

1. **Start whisper — it is behind a compose profile, so a plain `up -d` skips it.**
   `WHISPER_URL` still points at `http://whisper:8000`, so every server-side transcription fails
   against a host that does not exist.
   ```
   docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml      --profile whisper up -d whisper
   ```
   Verify (whisper publishes NO host port — call it from inside the network):
   `docker exec gaiada-platform-1 node -e '...POST http://whisper:8000/v1/audio/transcriptions...'`
   Measured throughput on a 2-vCPU box: **0.35× realtime** (21s per 60s of audio), so the 20-minute
   `WHISPER_TIMEOUT_MS` covers roughly 57 minutes of audio. Do not extrapolate from a 3-second clip —
   fixed per-request overhead dominates there and makes it look ~4× *slower* than realtime.

2. **Set `N8N_BRIDGE_ENTITY_TYPES` or the event bridge never starts.** `n8nBridgeEnabled()` is
   fail-closed on all four of base URL + secret + events + entityTypes. Empty ⇒ no bridge ⇒ every
   EVENT-triggered flow is dark (WS11 fan-out and delivery track, `client.created` seeding,
   org-structure notify) while CRON flows keep working, so the stack looks healthy and runs simply
   never grow gates. Confirm from the log line, not from config:
   `docker logs gaiada-platform-1 | grep "n8n bridge on:"` — absence of that line is the symptom.
   Value: `pipeline_run,pipeline_gate,scope,client,org_structure` (note `scope.signed` is emitted
   under `scope`, not `pipeline_run`).

3. **Size `N8N_BRIDGE_TIMEOUT_MS` to the box, not to the default.** The dispatcher does four
   sequential AI calls; measured round-trip on gda-aicenter is **31–40s** against a 30000 default, so
   ingest threw `dispatcher_unreachable` *after the run had already been created* — leaving the
   recording orphaned from a perfectly good run (the DEF-1 shape). 120000 is the value in use.
   Measure it before trusting it: the local dev box does the same work in ~12s.

**Reading the DB on the VPS:** `DATABASE_URL` uses `platform_app`, which is `NOBYPASSRLS`. Every
FORCE-RLS table reads as **zero rows** unless you set the GUC first, and `reltuples` is `-1`, so it
will not save you either:
```sql
select set_config('app.current_tenant_ids','<companyId>',false); select count(*) from clients;
-- company_memberships keys on its own setting instead:
select set_config('app.principal_user_id','<userId>',false);  select count(*) from company_memberships;
```
Skipping this reports an empty department that is actually populated.

**Driving the API headlessly when `AUTH_MODE=oidc`:** the `x-user-id` dev path is closed and no
Keycloak client has direct access grants (do **not** enable one on `gaiada-ui`). Use the OBO
envelope — `Authorization: Bearer $PLATFORM_SERVICE_TOKEN` plus `x-obo-provider` /
`x-obo-external-id` matching a **verified** `identity_links` row. That yields assurance `linked`,
which satisfies `notLow`.

**Still owner-gated:** `clients.portal_user_id` is unset for every client, so the client-side
`scope_signoff` / review gates cannot be countersigned — a client portal identity is a business
decision, not a deploy step. The agency half signs fine (`complete:false`, waiting on the client).
