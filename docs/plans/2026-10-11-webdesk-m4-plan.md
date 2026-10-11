# WebDesk M4 · production-ready — plan, tickets and evidence

**Started:** 2026-10-11 (session gaiada-system-0c) · **Board:** `TASKS.md` (outer folder), section *M4 · WebDesk
production-ready* · **Design:** `docs/blueprints/webdesk-design-v2.md` §03 (containment, WSK-D34), §12 P1, §13 OQ-2.7 ·
**Authority on gda-aicenter:** OQ-2.2 / WSK-D43 (act inside the `webdesk` project, backup first); anything outside that
project is asked for. The owner approved the egress guard below on 2026-10-11.

Status words are the estate's: PLANNED · IN PROGRESS · DEV-VERIFIED (driven on a Linux server, result observed).

**This repository is public.** Raw probe output names host addresses and ports, so it lives in the gitignored
`docs/blueprints/webdesk-m4-probe-runs.local.md` on the operator laptop. This file carries results only.

## Tickets

| # | Ticket | Who | State |
|---|---|---|---|
| T1 | Containment probe set (§03, six probes) on gda-aicenter, with controls | orchestrator | **DEV-VERIFIED** 2026-10-11, 39/39 |
| T1b | Egress guard: default-deny for the webdesk network (probe 6 failed on the 4-port deny-list) | orchestrator | **DEV-VERIFIED** 2026-10-11, live |
| T2 | WSK-68: read-only `BYPASSRLS` backup role, nightly dump into the existing offsite pull | senior-db (Sonnet) + orchestrator on the box | IN PROGRESS |
| T3 | Restore drill from the offsite copy, timed | orchestrator | PLANNED (after T2) |
| T4 | `deploy-webdesk.yml`: WebDesk's own deploy job in the release (signed image, never the `gaiada` project) | devops (Sonnet) + orchestrator | PLANNED |
| T5 | The August provisional greens re-run on Linux (the ones nothing runs today) | qa (Sonnet) + orchestrator on sumopod | PLANNED |
| T6 | OTel to sumopod + public status page | devops (Sonnet) + orchestrator | PLANNED; ruled WSK-D63/D64 |
| T7 | Per-tenant cost and quotas written (A-10 / OQ-2.7) | orchestrator measures, Sonnet drafts | PLANNED |
| T8 | Stale WebDesk copy on sumopod retired | orchestrator | **DONE** 2026-10-11; volumes deleted after 2026-10-25 |
| T9 | Deploy procedure committed | — | already on main: `infra/runbooks/webdesk-live-swap.md` (LF-safe archive, refuse CR, image from the signed release, never built on the box) |
| — | ERP names Phase B · B4 retire | — | waits for B2 + two quiet weeks |

## T1 · Containment probes: `webdesk/ops/probes/containment-probe.sh`

Runs on the box, discovers every address and port at run time, and gives each probe a control that would fail
if the property were absent. It changes nothing in either project: it starts throwaway `m4probe-*` containers
and two throwaway compose projects, and removes them on exit.

| Probe | Verifies | Control | Result (run `m4probe-1791721075`, 2026-10-11T12:18Z) |
|---|---|---|---|
| 1 Resolved-config port audit | AC 2 | The checker flags a planted `0.0.0.0` proxy and a planted api port. Running services equal the resolved services. | PASS: only `proxy`, on `127.0.0.1` |
| 2 nginx routes to the loopback Caddy; `:80`/`:443` are nginx's | AC 2 | An unknown Host on the same listener is not routed to WebDesk. | PASS: `api.erp.gaiada.com` gets 401 problem+json; Caddy is unreachable on all 7 non-loopback host addresses |
| 3 Host Postgres unreachable from the webdesk network | AC 6 | (A) the same probe reaches host Postgres from the default bridge; (B) the same network reaches its own proxy | PASS on 7 addresses; both controls open |
| 4 CPU, memory, pids limits | AC 8 | A container started without limits fails the same check. | PASS: 5/5 live containers + resolved config |
| 5 `--remove-orphans` cannot reach webdesk | AC 1 | In two throwaway projects, `--remove-orphans` removes its own orphan and the other project's container survives. | PASS; every `webdesk-*` container carries project `webdesk` |
| 6 Egress sweep | §03 blast radius, §11 | A planted ERP value is found by the same match; the same probe reaches the internet. | PASS after T1b (130 targets: 32 ERP container ports, 84 host address:port, 13 WireGuard, metadata) |

**Credential sweep (6a).** ERP secret-like values from the ERP `.env` were searched for in 5 containers' env, the
project tree, `/etc/webdesk` and every bind mount. 0 were found. Two values are shared **by design**, and the
probe names them:
- `WEBDESK_EVENT_SECRET`, the B→A event HMAC (§03 channel 1; a forged fact is noise, not authority).
- `WEBDESK_CONTROL_WS4_KEY` (= WebDesk's `WEBDESK_APPROVAL_ASSERTION_KEY`), the WS4 approval HMAC: the ERP signs,
  WebDesk verifies, and only WebDesk's own control plane accepts it. Follow-up F1 makes it asymmetric.

## T1b · The egress guard (owner-approved 2026-10-11)

**Run 1 (before), 35 passed / 45 failed.** The 2026-09-04 `webdesk-host-deny.service` (box-only, in no repo file)
dropped only host ports 5432, 6379, 11434 and 4310 from the webdesk subnet. From a webdesk container these were
still open:
- the cloud **metadata service**;
- the **WireGuard peer** (sumopod): sshd, Loki, OTLP, a Postgres, Prometheus and Alertmanager;
- **every other host listener** on every host address: sshd, MariaDB `:3306`, Ollama `:11435`, platform-ui `:3005`,
  LLMNR `:5355`, the control vhost `:9443`.

**Fix:** `webdesk/ops/host/webdesk-egress-guard.sh` (installed at `/usr/local/sbin/`, run at boot by
`webdesk/ops/host/webdesk-host-deny.service`). Every rule matches the webdesk network's **source subnet, read from
Docker at run time**, so ERP and neighbour traffic is never matched.
- To the host itself, a webdesk container gets replies only (chain `WEBDESK-HOST-IN`).
- Beyond the host, it may reach its own bridge, DNS to the cloud resolver, and the public internet (chain
  `WEBDESK-EGRESS` in `DOCKER-USER`). Link-local, 10/8, 172.16/12, 192.168/16, CGNAT, loopback, 0/8 and multicast
  are dropped.
- The ERP stays reachable by its public name (the OIDC issuer and the n8n bridge are `https://erp.gaiada.online`,
  which hairpins through the public IP).
- It removes the superseded 4-port rules, so one mechanism remains.

**Proven before the live box** on sumopod against a throwaway network (`webdesk/ops/host/test-egress-guard.sh`),
12/12 checks:
- own bridge, DNS, internet and host→loopback-published replies still work;
- host sshd (gateway and host address), link-local and the WireGuard peer are blocked, and both host-sshd paths
  were open before the guard;
- a second `apply` keeps the rule count (18);
- `remove` leaves 0 rules.

**Applied live** 2026-10-11T12:16Z (backup of the old unit and `iptables-save` in
`~/webdesk-backups/m4-egress-<ts>/`). Identical before and after:
- api-container DNS ok;
- `https://erp.gaiada.online/health` 200 from inside the api;
- internet 200;
- `/v1` 401 through nginx and from outside;
- the api's content tick `errors=0` on the next two minutes.

Run 3 (after): **39/39**.

**Rollback:** `sudo /usr/local/sbin/webdesk-egress-guard.sh remove`, then restore the backed-up unit.

## T2 · WSK-68 backup role (in progress)

Role `webdesk_backup`:
- `LOGIN BYPASSRLS NOINHERIT`, no password, so it can only use the container's unix socket;
- `default_transaction_read_only=on`, SELECT only, default privileges for the migrator's future tables;
- created in `init-roles.sh` for new clusters and by an idempotent `ops/scripts/ensure-backup-role.sh` for the live
  one;
- `check-rls-integrity.mjs` permits exactly this one BYPASSRLS role, read-only, with negative controls.

Nightly at 03:05 UTC, `ops/scripts/webdesk-backup-nightly.sh` writes `~/gaiada-backups/webdesk-<stamp>.sql.gz` and
**fails if the dump has zero tenant rows** (an RLS-blinded dump is the failure this exists to catch). sumopod's
existing 04:15 UTC pull (`infra/scripts/erp-offsite-pull.sh`, forced-command reader) already takes every top-level
`*.sql.gz`, encrypts it to the owner's age key and keeps 90 days. So the offsite copy needs no change on sumopod, and
WebDesk holds no credential for the target (backups runbook §1).

## T3 · Restore drill (after T2)

1. Take the newest `webdesk-*.sql.gz.age` from sumopod and decrypt it on the operator laptop (the age key lives only
   there).
2. Stream it into a throwaway `postgres:16-alpine` with `--network none` on gda-aicenter, where the plaintext already
   lives, so plaintext never lands on sumopod.
3. Time it from fetch to verified.
4. Verify per-table row counts against live, and that `webdesk_app` with no tenant GUC sees zero rows (RLS came back
   with the schema).
5. Record the observed RTO in the backups runbook §5, replacing the estimate.

## T4 · `deploy-webdesk.yml` (spec)

A reusable workflow (`workflow_call` from `release.yml` + `workflow_dispatch` for rollback), `environment: production`,
using the same `VPS_*` secrets as `deploy.yml`. It runs after `deploy` (one box, serialised), skips when the signed
digest equals the running one, and **never** joins `deploy.yml`'s `COMPONENTS` (whose `up --remove-orphans` targets
the `gaiada` project).

Steps:
1. `cosign verify` `gaiada-webdesk-api:<tag>` and read its digest.
2. On the box: GHCR login with the job token, pull by digest, refuse if the image id differs from the digest.
3. Tag the running image `webdesk-api:pre-<tag>`. Local `webdesk-api:*` tags are outside `deploy.yml`'s prune
   pattern `ghcr.io/<owner>/gaiada-*`.
4. `pg_dump -Fc` as `webdesk_backup` into `~/webdesk-backups/pre-<tag>-<ts>/`, plus the compose files and
   `migrations/`.
5. rsync the tag's `webdesk/{migrations,scripts,ops,docker-compose*.yml,package*.json}` into a staging dir; run
   `compose config -q` there against `/etc/webdesk/.env` (a new required variable stops the job before anything live
   changes), then swap it into the project dir.
6. Migrate as `webdesk_migrator` from a throwaway node container on the project network, twice (the second applies
   0), then `check-rls-integrity.mjs` as the owner. Then `storage-bootstrap.mjs` (idempotent).
7. `up -d --no-deps --no-build api` with the **release overlay** (`WEBDESK_API_IMAGE=ghcr.io/…@<digest>`). This
   replaces the hand-tagged `webdesk-api:latest`.
8. Health:
   - `listening on :3000` and the editorial JWKS log line;
   - proxy `/healthz` 200;
   - `/v1` 401 problem+json through nginx;
   - the next content tick `errors=0`;
   - containment probe 1 (the port audit).
9. On a health failure: re-pin `pre-<tag>` and restore the compose files. Migrations are never rolled back.
10. On success: persist `WEBDESK_API_IMAGE` in `/etc/webdesk/.env` and write `~/gaiada-webdesk/.deployed-tag`.

**Proof:** a `workflow_dispatch` with the currently live tag (a no-op swap) on the live box, then the next real
release. Both are asked for before they run.

## T5 · The August provisional greens

The August tracker lists 36 green rows; the design's "34" is a stale roll-up. Of the 36:
- 10 are rulings or documents and need no run.
- A-01, WSK-00 (the Payload spike), WSK-02, WSK-04b and the Payload half of WSK-04 went with Payload (D37).
- Most of the rest are covered by suites that already run on Linux: the sumopod `linux-gate.sh` (root, blocks, api,
  vocabulary, migrations) and CI `webdesk-light` / `webdesk-api`.

**Nothing runs these today** (inventory 2026-10-11):

| Ticket | What | Command |
|---|---|---|
| WSK-14 | `wsk14-breaking-change`, `wsk14-composition-validator`, `wsk14-renderer-invariant` (`webdesk/delivery/test/`) | `node --import tsx ../delivery/test/<name>.test.mjs` from `webdesk/api` |
| WSK-03/04 | the consolidated cross-path tenancy script (`migrations/tests/rls.spec.sql` runs only inside it) | `node webdesk/scripts/wsk04-cross-path-suite.mjs` (needs the three DB URLs) |
| WSK-18 | P3 gate: cross-machine determinism, contract coherence, unknown-block rejection, artifact-URL expiry | `webdesk/scripts/check-determinism-crossmachine.mjs`, `check-contract-coherence.mjs`, `check-unknown-block-rejection.mjs`, `check-artifact-url-expiry.mjs --docker` |
| WSK-15 | the codegen double-run gate | `cd webdesk/api && npm run codegen:gate` |
| WSK-11 | `mail-retry-backoff.spec.ts` (self-skips on sumopod without the docker socket, owner veto) | CI runs it; record CI as its Linux evidence |
| — | `webdesk/deploy` suite | CI only, not in the gate |
| — | `ops/scripts/check-cdn-bypass.mjs --selftest`, `check-otlp-write-only.mjs` | neither |

The manual drives are superseded by live evidence on the board:
- WSK-17's rebuild by WSK-55's dist parity;
- WSK-22's real-issuer reachability by the live control channel (WSK-63).

WSK-12's real-n8n flow cannot be superseded yet: the live bridge URL is unset (see Defects). WSK-07's imgproxy route
is not deployed anywhere, so it gets no Linux claim.

Plan: add a `legacy` stage to `webdesk/qa/linux-gate.sh` that runs the rows above, run it on sumopod, and fix or
record whatever is red.

## T6 · OTel and the status page (ruled 2026-10-11: WSK-D63, WSK-D64)

- **OTLP path (WSK-D63 (2)).** The ERP's existing `gaiada-otel-collector` gets a second, write-only OTLP/HTTP receiver:
  bearer-authenticated, rate-limited, published on the docker0 address only. `webdesk-egress-guard.sh` gains exactly
  one RETURN for that address and port, and the collector forwards to sumopod's Tempo/Loki over WireGuard as it does
  today. The api sets `OTEL_ENABLED` + `WEBDESK_OTEL_ZONEA_PUSH_ENABLED` and the endpoint/bearer. The ERP compose
  change ships with a release; the guard change and the probe update ship with it, and probe 6 must then show exactly
  that one host port open.
- **Status page (WSK-D64).** `status.erp.gaiada.com`, a CNAME to `sumopod.erp.gaiada.com` (the owner creates it), is
  served from sumopod and fed by its existing blackbox probes for `api.erp.gaiada.com` (`/healthz`, a `/v1` 401
  problem+json). It replaces the in-project `status-page` sketch in `webdesk-zoneb-status-page.md`.

## T7 · Per-tenant cost and quotas

To measure:
- the WebDesk containers' CPU and RAM at rest and during a full site build (34 `/v1` requests);
- database bytes per tenant;
- RustFS bytes per tenant;
- nginx request counts for `api.erp.gaiada.com`.

The GitHub rebuild cost is already measured: about $0.016 a run.

Then write quotas for reads per minute (live 3000), storage bytes (default 10 GiB), forms and webhooks. §03's
capacity statement is the interim ceiling (OQ-2.7).

## Follow-ups found (each a box on the board)

- **F1** Make the WS4 approval assertion asymmetric (Ed25519, like the editorial assertion D39), so the surface holds
  only a public key.
- **F2** Pin the `webdesk_default` subnet in compose. The guard reads the subnet at boot, so a network recreated
  later is uncovered until the unit restarts; probe 3 catches it. The live-swap runbook should re-apply the guard
  after any `down`.
- **F3** The aicenter overlay's header promises full `cap_drop`, but no service has `cap_drop` (resolved config and
  live `CapDrop` empty). Add `cap_drop: [ALL]` with the minimum `cap_add` per service.
- **F4** `redis` runs an older image than `redis:7-alpine` now names (an unpinned tag). Pin it by digest like RustFS.
- **F5** The box's project dir still carries the deleted `payload/` tree. The live-swap install step copies listed
  paths and never deletes; T4's staging-dir swap fixes it.
- **F6** AC 7 (rootless Docker for the webdesk project) is not built; the daemon is rootful. ACs 3–5 have no probe
  (AC 3 is moot since Payload is gone; ACs 4 and 5 follow from probes 1 and 3).
- **F7** Pre-existing, not WebDesk's, raised with the owner: MariaDB `*:3306` and Ollama `*:11435` listen on every
  interface of the ERP box. Whether the cloud firewall exposes them to the internet is unverified.
- **F8** (M3 area; logged on the board under M3 *Defects found on the way* by its session, which also found
  `wd-zoneb-intake.json` lacks `schedule.fired`) The live api has `WEBDESK_ZONEB_BRIDGE_URL` empty, so no
  `form.received` or `schedule.fired` leaves WebDesk. Scheduled publish still works through the ERP sweep. When the
  URL is set, it must be the public https name: the guard drops every private path.

## Log

- 2026-10-11 12:07Z: probe run 1 on gda-aicenter, 35/45 (probe 6 failed).
- 12:13Z: guard proven on sumopod against a throwaway network, 12/12.
- 12:16Z: guard applied live (owner-approved).
- 12:18Z: run 3, 39/39.
- 12:20Z: sumopod stale copy archived to `~/webdesk-retired-20261011/` (pg_dumpall, 4 volume tars, project dir,
  SHA256SUMS), then `docker compose -p webdesk down` (volumes kept; containers and network gone; `:8380` free).
