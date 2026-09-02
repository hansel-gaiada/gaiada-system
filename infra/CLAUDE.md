# CLAUDE.md — infra

Scope: `infra/` — compose files, nginx vhosts, observability stack, backup/restore, runbooks.
Root `../CLAUDE.md` has program rules. Runbooks are in `runbooks/` (`deploy-vps.md`,
`db-topology-cutover.md`, `observability{,-slo}.md`, `restore-drill.md`,
`nginx-mail-inbound-route.md`, `local-model-serving.md`) — read the runbook before improvising.

## Compose: the file set is load-bearing

Ten `docker-compose.*.yml` files in `compose/`. **Never run just one.**

- **On the server (`gda-aicenter`), Postgres and Redis run on the HOST**, not in Docker
  (`127.0.0.1:5432` / `6379`, reached as `host.docker.internal`). The `postgres:`/`redis:`
  services (profile `data`) are deliberately never started, which leaves every `depends_on`
  naming them pointing at an undefined service. So `-f docker-compose.vps.yml` **alone is an
  invalid compose project** — the parse error walks from `redis` → `postgres` → `whisper` as you
  add profiles. `docker-compose.hostdata.yml` is the override that `!reset`s exactly those
  blocks. Correct invocation:

  ```sh
  cd ~/gaiada/infra/compose
  COMPOSE_PROFILES="bot,auth,scan,mail-dev,whisper,jobs" \
    docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --no-build <service>
  ```

  **Do not read that parse error as "the deploy is broken."** `deploy.yml` passes the file list
  (`COMPOSE_FILES`) and `COMPOSE_PROFILES` as repo variables — neither lives in the box `.env`,
  so a human on the box gets neither by default and reproduces a failure the pipeline never sees.
  Verify with `docker compose ... config -q` (a true dry run) first.

- **Locally**, use `docker-compose.vps.yml` **+** `docker-compose.local.yml`. The override
  publishes Cerbos (`3592`/`3593` — a portless Cerbos fails all authz), `platform:3004`,
  `mcp-hub`, `pg-bot:55434` and a disposable `redis-test:56380` on loopback. The VPS file alone
  *unpublishes* those ports on any container it recreates; it silently killed `platform:3004`
  once and the host-run UI could not reach the backend.

- The local 16-container stack is **OFF by owner decision** — the server is the truth. Verify
  from source against already-running test containers rather than reviving it.

### Three ways `up -d` has broken a healthy release

1. **Stale `.env`** — `GAIADA_TAG`/`APP_VERSION` go stale on the box, so *any* `up -d` silently
   **rolls back** to the old image. Check tag parity before every one.
2. **`--remove-orphans`** deletes any container in the `gaiada` project whose profile isn't in
   *this* command. Always scope to explicit service names.
3. **Disk** — images are never pruned, the disk fills, and a one-line write failure triggers a
   rollback of a release that was healthy. Prune before deploying.

Also: a var in `.env` does nothing unless the service's `environment:` block lists it. And all ten
compose files sharing one mtime means *a deploy synced the directory* — not that another session
edited them under you.

### `docker-compose.social.yml` — RETARGETED to `gda-aicenter` (2026-08-31, supersedes SumoPod)

**DEV-VERIFIED 2026-09-01.** The owner's 2026-08-31 estate re-zoning ("system lives in aicenter")
moved the SMM publishing engine (Postiz, AGPL, contained) from the SumoPod VPS onto
`gda-aicenter`, superseding the 2026-08-13/18 SumoPod decision (addenda §A4k/§A4l) this section
used to describe. Plan + runbook: `../docs/plans/2026-08-31-workload-consolidation-to-aicenter.md`
(Phase 2). Executed 2026-09-01: 5 containers landed on `gda-aicenter` (postiz, social-postgres,
social-redis, social-temporal, social-temporal-postgres), Postiz's and Temporal's Postgres data
dump/restored from SumoPod (row counts verified both sides: 1 Organization, 1 User, 0
Integrations, 2 Temporal namespaces, 4 current_executions), all 5 healthy with 0 restarts,
`platform`'s `SOCIAL_POSTIZ_BASE_URL` repointed to loopback and recreated at unchanged image tag.
SumoPod's copy is deliberately left running (not decommissioned) pending soak time on the new one
— see the compose file's own header for the exact execution notes and the OAuth-URL caveat (the
erp.gaiada.online/social routing the design called for was never actually wired up on either
host; this migration preserved the existing direct-URL shape rather than introducing that change
as a side effect).

It is still its own compose project (`gaiada-social`), digest-pinned, outside the release path —
that part is unchanged. What changed:

- **It now runs on `gda-aicenter`, the SAME box as the ERP.** The old "19 containers of someone
  else's private production" caution is retired for this file specifically (SumoPod still applies
  to observability, which stays there); the caution that replaces it is sharper: this box runs the
  ERP's own host Postgres, Keycloak and Cerbos on the SAME kernel, so `docker-compose.social.yml`'s
  own header now carries the isolation rules in full — read it before touching this stack.
- **The `SOCIAL_*` block in `.env.example` now belongs on `gda-aicenter`'s `.env`.** Do not leave
  it filled on a SumoPod checkout after the migration runs; that would be secrets scattered onto
  a box with no use for them, the inverse of the old warning.
- **`platform-nest` reaches it over LOOPBACK now, not WireGuard.** The `10.88.0.1` ↔ `10.88.0.2`
  tunnel is retired for this hop (see the compose file's header for the full reasoning).
  `SOCIAL_BIND_ADDR` is still never `0.0.0.0` for the same DNAT-before-firewall reason as always —
  that rule outlives the specific box.

## Deploy

One point: `git push --tags` → `release.yml` (build + cosign-sign + SLSA provenance → GHCR) →
`deploy.yml` (roll the VPS, including the Cerbos restart step). `deploy.yml` enforces
tag ↔ `/VERSION`. After a *failed* deploy, `/health` can report a stale `APP_VERSION` while the
correct image is running — trust the running image, not that field.

If Actions is unavailable, `runbooks/deploy-vps.md` plus the hand-built path (build on the box
from `git archive`) is the fallback.

## Scripts

`scripts/test-all.sh` (local CI), `backup.sh` + `backup-cron.sh` (crypto-shred-safe, 3 databases),
`restore-drill.sh` (measured RTO), `healthcheck.sh` (the out-of-band dead-man's switch),
`lint-observability.sh` (promtool/amtool/otelcol validate — the CI `observability-lint` job),
`wire-env.sh`.

## Observability

`observability/` configs; the stack is an **opt-in second compose file**
(`docker-compose.observability.yml`): OTel Collector → Prometheus / Tempo / Loki + Grafana +
Alertmanager + exporters + ntfy. All services are instrumented **fail-soft** — a no-op unless
`OTEL_ENABLED`, so leaving it off is a supported state. `filelog → Loki` is env-limited on Docker
Desktop and works on Linux.

## nginx

`nginx/` holds the `erp.gaiada.online` vhost + snippets. Two things that are hand-applied and
easy to lose: the **SSE block** for the client portal, and the `/n8n/` prefix-stripping vhost
(`N8N_PATH` is only half-honoured, so the console works through the vhost rewrite rather than
through the app's own path setting).
