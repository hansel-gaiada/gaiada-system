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
| T2 | WSK-68: read-only `BYPASSRLS` backup role, nightly dump into the existing offsite pull | senior-db (Sonnet) + orchestrator on the box | **LIVE** 2026-10-11 (gate m4wsk68 green; role, dump, cron, offsite) |
| T3 | Restore drill from the offsite copy, timed | orchestrator | **DEV-VERIFIED** 2026-10-11, 26 s end to end |
| T4 | `deploy-webdesk.yml`: WebDesk's own deploy job in the release (signed image, never the `gaiada` project) | devops (Sonnet) + orchestrator | BUILT, dispatch-only (harness 32/32); not yet run on the box |
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

| Ticket | What | Command | In the gate (`legacy` suite) |
|---|---|---|---|
| WSK-14 | `wsk14-breaking-change`, `wsk14-composition-validator`, `wsk14-renderer-invariant` (`webdesk/delivery/test/`) | `node --import tsx ../delivery/test/<name>.test.mjs` from `webdesk/api` | `wsk14-breaking-change`, `wsk14-composition-validator`, `wsk14-renderer-invariant`, `wsk64-snapshot-probe` (a CLI; the step checks it emits a valid snapshot) |
| WSK-03/04 | the consolidated cross-path tenancy script (`migrations/tests/rls.spec.sql` runs only inside it) | `node webdesk/scripts/wsk04-cross-path-suite.mjs` (needs the three DB URLs) | `wsk04-cross-path-suite`, against the migrated gate database |
| WSK-18 | P3 gate: cross-machine determinism, contract coherence, unknown-block rejection, artifact-URL expiry | `webdesk/scripts/check-determinism-crossmachine.mjs`, `check-contract-coherence.mjs`, `check-unknown-block-rejection.mjs`, `check-artifact-url-expiry.mjs --docker` | `c2-contract-coherence` (selftest + both fixture tenants), `c3-unknown-block-rejection` (selftest + real), `c1-determinism-selftest` + `c1-determinism-crossmachine` (SKIP without `--with-docker-socket`: it starts two containers), `c4-artifact-url-expiry-selftest` + `c4-artifact-url-expiry` (against the gate's RustFS, no `--docker`) |
| WSK-15 | the codegen double-run gate | `cd webdesk/api && npm run codegen:gate` | `wsk15-codegen-gate` (seeds two throwaway tenants in the gate database, runs the gate, removes them) |
| WSK-11 | `mail-retry-backoff.spec.ts` (self-skips on sumopod without the docker socket, owner veto) | CI runs it; record CI as its Linux evidence | not in `legacy`: still the `webdesk-api` suite's skip, named in its summary |
| — | `webdesk/deploy` suite | CI only, not in the gate | `deploy-typecheck-test` |
| — | `ops/scripts/check-cdn-bypass.mjs --selftest`, `check-otlp-write-only.mjs` | neither | `ops-check-cdn-bypass-selftest`, `ops-check-otlp-write-only-selftest`, `ops-test-deploy-webdesk` (the T4 harness) |

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

## F1 · WS4 approval assertion made asymmetric: design (2026-10-12)

**Today.** The header is `x-ws4-assertion: <base64url(claims)>.<hmacHex>`:
- HMAC-SHA256 over the literal payload bytes;
- claims `{approvalId, commandHash, exp}` (`webdesk/api/src/control/auth/ws4-assertion.ts` and
  `platform-nest/src/modules/webdev/webdesk-ws4-assertion.ts`);
- single use is enforced by `audit_entries.ws4_approval_id`.

The key is shared: the ERP's `WEBDESK_CONTROL_WS4_KEY` must equal WebDesk's `WEBDESK_APPROVAL_ASSERTION_KEY`. The
containment probe accepts it as "shared by design", because only WebDesk's own control plane accepts it. A WebDesk
compromise therefore yields a key that can mint approvals for WebDesk itself, which that compromise could do anyway.
The point of F1 is that **WebDesk holds no signing secret at all**: the same posture the editorial assertion
already has (WSK-D39).

**Target: v2, a JWS compact token with `alg: EdDSA`.**
- **Header:** `{alg: "EdDSA", kid, typ: "ws4+jwt"}`.
- **Payload:** the same claims plus `aud: "webdesk-control-plane"`.
- **Format detection:** v1 has two dot-separated parts and v2 has three, so the verifier tells them apart without
  guessing.
- **Keys:**
  - A NEW Ed25519 key pair, kid `ws4-<yyyy-mm>`, never the editorial key: the two channels must not be able to
    replay each other's tokens. `typ` and `aud` are checked as well.
  - The private key lives only on the ERP, with the same custody as the editorial signing key.
  - The public key goes in a pinned file `/etc/webdesk/ws4/ws4.jwks.json`, a read-only file mount loaded by the
    same loader as `editorial-jwks.ts`, generalised. The loader refuses boot on a malformed file and holds 1 or 2
    keys, 2 during a rotation.
- **The verifier pins `alg` to EdDSA and looks the key up only by kid in the WS4 set.** It refuses `none`, any HS*
  (the HMAC-with-public-key confusion), a wrong `typ` or `aud`, an unknown kid, a past `exp` and a `commandHash`
  mismatch. Replay is refused by the unchanged single-use check.

**Phases (each verified before the next; nothing breaks in between):**
1. **WebDesk accepts both.**
   - v2 when the WS4 JWKS file is present.
   - v1 only while `WEBDESK_APPROVAL_ASSERTION_KEY` is set.
   - The audit row records which version was used.
   - Shared test vectors in both repos (the nest signer ↔ the WebDesk verifier) plus the adversarial matrix above,
     with each row's exact refusal reason.
   - Ships with a release (auto-deploy).
2. **The ERP signs v2.**
   - The platform mints v2 when its WS4 private key is configured, else v1.
   - Live: provision the key pair (a runbook like `webdesk-editorial-keys.md`), install the JWKS on the box, restart
     the platform.
   - Probe: one HIGH command executes and its audit row says v2. A v1 token is still accepted (overlap).
3. **Remove HMAC.**
   - Unset both HMAC keys. WebDesk refuses v1 when its key is absent (boot logs it).
   - Containment probe 6 drops `WEBDESK_CONTROL_WS4_KEY` from its shared-by-design list, so it would then FAIL if
     the value reappears anywhere in the surface.
   - Rotation runbook: two kids overlap, then the old one is removed.

**Tier.** The signer and verifier cores are Opus work (alg confusion and replay are the failure modes). The key
runbook and the probe change are Sonnet work. About 1–2 sessions. **Status: phases 1 and 2 BUILT as code (branch `webdesk/m4-f1-ws4-eddsa`, migration 0018, runbook `infra/runbooks/webdesk-ws4-keys.md`); local unit matrix green; Linux/CI suites and every live step pending. Not live.**

## Follow-ups found (each a box on the board)

- **F1** Make the WS4 approval assertion asymmetric (Ed25519, like the editorial assertion D39), so the surface holds
  only a public key.
- **F2** Pin the `webdesk_default` subnet in compose. The guard reads the subnet at boot, so a network recreated
  later is uncovered until the unit restarts; probe 3 catches it. The live-swap runbook should re-apply the guard
  after any `down`. **LIVE 2026-10-11 14:14Z**: the aicenter overlay pins `172.19.0.0/16`; applied by `docker compose down`, then
  `up -d --no-build` and `systemctl restart webdesk-host-deny`.
- **F3** The aicenter overlay's header promises full `cap_drop`, but no service has `cap_drop` (resolved config and
  live `CapDrop` empty). Add `cap_drop: [ALL]` with the minimum `cap_add` per service. **LIVE 2026-10-11 14:14Z**: `cap_drop: [ALL]` on all five overlay services, `cap_add` only where an entrypoint
  needs it (see the overlay comments); CI gate `webdesk/scripts/check-compose-hardening.mjs`. Boot proof
  `webdesk/ops/probes/compose-boot-proof.sh` on sumopod: 44/44 with the real compose files.
- **F4** `redis` runs an older image than `redis:7-alpine` now names (an unpinned tag). Pin it by digest like RustFS. **LIVE 2026-10-11 14:14Z**: redis, postgres and caddy are digest-pinned in the aicenter overlay (indexes as of
  2026-10-11), and those images are what runs.
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
- 12:59Z: WSK-68 live.
  - `ensure-backup-role.sh` printed CHANGED, then unchanged.
  - The first `webdesk_backup` dump: 3.86 MB, 25 tables, 1 tenant, 326 items.
  - The live RLS checker passed: 23 tenant tables, no other BYPASSRLS role.
  - Cron installed at 03:05 UTC.
- 13:03Z: sumopod's pull took the dump offsite (age).
- 13:07Z: restore drill, 26 s end to end (backups runbook §6a).
- T4 review: the tools container ran as root with `--cap-drop ALL`, where `cp -a` exits 1 (reproduced on sumopod), so
  the first apply would have died after the tree swap. It now runs unprivileged (`npm install` proven under
  `--cap-drop ALL`).
- T4 proof order: an `apply` with the live tag (351) would swap in 351's tree, which lacks the WSK-68 scripts, and
  break the backup cron. So: `plan` with 351 first (changes nothing); `apply` only with the first release that
  contains the M4 commits.
- 13:20Z: after the erp.gaiada.com cut-over recreated the api (355), probes 39/39 again.
- 13:28Z: T4 `plan` dispatch with `v1.0.0-alpha.355`: `RESULT: plan OK` on the box (run 38143307486). Its proxy/
  NOTE is comments only (the live Caddyfile predates WSK-48b).
- T5 landed (main `696d3464`): gate run m4t5 had legacy 15/0/1 (c1 needs the docker socket). c1 then went to CI's
  `webdesk-api` job (PR #15).
- 14:03Z: per-source offsite staleness alert `OffsiteBackupOneSourceStale` live on sumopod (main `d248af5d`). Before
  it, every backup metric was an aggregate, so one stopped source (e.g. the WebDesk dump) could never fire.
- 14:12Z–14:14Z: compose hardening applied live (owner-approved).
  - Before the downtime: backup in `~/webdesk-backups/m4-hardening-<ts>/` (dump + compose files), the five running
    images tagged `webdesk-rollback/<svc>:pre-hardening`, pinned images pulled.
  - Then `down`, `up -d --no-build` and the guard restart: **56 s of downtime**.
  - After: CapDrop ALL with the designed CapAdd and 0 restarts on all five; subnet `172.19.0.0/16`; redis PONG; the
    api's JWKS loaded and listening; content tick `errors=0`; probes 39/39; `/v1` 401 from outside.
  - The read quota now in effect is the configured 3000/min (`.env`; was the accidental code default 300).
- CI on PR #15: c1 cross-machine determinism PASSED (acme and globex byte-identical across two independent
  containers).
- 14:45Z: `https://status.erp.gaiada.com` live on sumopod (T6b). Main `f2b965c0`: probe job `blackbox-webdesk-api`,
  alert `WebDeskApiDown`, and the blackbox-estate drift fix. WSK-D70 (mimi file per name) is amended by WSK-D71 (M5):
  the page moves behind the shared `erp-edge` Traefik at M5's cut-over.
- T6a built and tested (guard harness 32/32 on sumopod, after fixing its control), branch `webdesk/m4-t6a-otlp`.
  Held: the WebDesk api has no OpenTelemetry SDK yet, so nothing would send.
- 15:06Z: rehearsal of the deploy's tools step on the live box: rc=0 in 22 s, changes=0.
- 15:41Z: release 356 (ERP-only) deployed; probes 39/39 afterwards.
- 15:57–15:59Z: **release 357 deployed to WebDesk by `deploy-webdesk`**, its first live apply (owner-approved).
  - plan run 38153324995 OK; apply run 38153398370 OK.
  - The api now runs `ghcr.io/hansel-gaiada/gaiada-webdesk-api@sha256:5560bb9d…` on the release overlay (three
    compose files).
  - Backup taken as `webdesk_backup`; migrations 0 applied twice; RLS gate OK; health all PASS.
  - Probes 39/39. The nightly backup script survived the tree swap. The upload refusal is 404 problem+json
    `upload-not-found`.
  - From now on every manual compose call on the box needs all three files plus `--no-build`.
- 16:58Z: **358 deployed to WebDesk** (plan 38157565110, apply 38157632390). Migration 0015 applied once; health PASS;
  probes 39/39; `ensure-backup-role` unchanged (the backup role reads 0015's objects).
- The skip path proven live on the already-current 358 (run 38157846946, from the branch): "already current", the api's
  StartedAt unchanged.
- **release.yml wired** (owner-approved 2026-10-12; main `4d104aa1`): every release runs deploy-webdesk (apply,
  skip_if_current) after a successful ERP deploy.
