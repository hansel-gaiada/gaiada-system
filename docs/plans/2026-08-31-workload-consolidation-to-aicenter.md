# Plan — consolidate gaiada-social, WebDesk and lab-runner onto `gda-aicenter`

**Status: PLANNED.** Authored 2026-08-31 against read-only inspection of `gda-aicenter` and the
repo's own compose/runbook history. **Nothing in this plan has been executed.** No container has
been started, stopped, or reconfigured on any server as part of authoring it — see §7 for the
exact read-only commands run to ground the numbers below.

Read first: `CLAUDE.md` (root), `infra/CLAUDE.md`, `docs/blueprints/webdesk-design-v2.md` §02–§03
(architecture and trust zones — its Zone A/B tier table is **superseded by the re-zoning below**,
but its analysis of what WebDesk is and why isolation matters still holds and this plan builds on
it rather than repeating it), `infra/compose/docker-compose.vps.yml` +
`docker-compose.hostdata.yml` (the existing server compose set), `infra/runbooks/deploy-vps.md`
(house deploy conventions), `infra/runbooks/webdesk-zoneb-box-hardening.md` and
`webdesk-zoneb-backups.md` (the SumoPod-era hardening/backup runbooks — their *analysis* is
reused throughout; their *target host* is not).

## 0. The ruling this plan executes

Owner re-zoning, 2026-08-31, **replaces** the old Zone A/B / capacity-driven tier model:

| Tier | Hosts | Carries |
|---|---|---|
| ERP control plane | `gda-aicenter` | The ERP itself, and everything operational to it |
| Client project delivery | `delphi` (staging) / `helios` (production) / WP server / client servers | Client projects **only** |
| Observation | `sumopod` | Telemetry for the whole estate — stays put; a monitor co-located with what it monitors dies with it |

**The move, verbatim from the ticket:** `gaiada-social-*` (Postiz + Temporal + 2× Postgres +
Redis, 5 containers), `webdesk-*` (Payload/api/gateway/Postgres/Redis/MinIO/Caddy, 7 containers),
`gaiada-lms-lab-runner` (1 container, executes **untrusted** learner code) — all from `sumopod` to
`gda-aicenter`. Observability (`gaiada-obs-*`, 7 containers) stays on `sumopod`.

---

## 1. Accepted-risk statement

**This has been decided twice and reaffirmed. This section states what was accepted, not whether
it should have been.**

Landing a **public listener** (WebDesk's `/v1` + `/forms` + `/media`) and **untrusted code
execution** (lab-runner, running learner submissions with only `runc`/gVisor as the boundary —
this host has no KVM either, exactly as SumoPod had none) on the same kernel as the ERP's host
Postgres, Keycloak and Cerbos means those three trust anchors no longer get a *machine boundary*
for free. Everything a separate box would have provided — a different kernel to escape into, a
different attack surface to enumerate, a blast radius capped at "this one box" — must now be
re-created entirely in software, on one kernel, by containment alone. Concretely, containment
must therefore do all of the following, none of it optional:

1. **Every incoming service gets its own compose project, own network, own resource ceiling, own
   non-root user, dropped capabilities, `no-new-privileges`, and read-only rootfs where the
   process tolerates it** (§2). There is no second layer beneath this — it is not defense in
   depth on top of a hypervisor, it *is* the depth, the same framing `lab-runner/dist/sandbox.js`
   already uses for its own per-attempt containers, now extended one level up to the services
   that host it.
2. **No service outside the ERP's own compose project (`gaiada`) may ever join `gaiada_default`
   (172.18.0.0/16).** This is the one line that, added anywhere below, silently defeats every
   other control in this document. Every artifact in this plan is written so that line is never
   needed and never present.
3. **Untrusted code execution gets the strongest per-container isolation this host can offer**
   (gVisor/`runsc`), installed and verified *before* lab-runner's first real submission, not
   after (§2.3).
4. **Backups of anything that moves here must not live on this box** (§6) — a full-box
   compromise must not also compromise the recovery path.
5. **The pre-existing condition this plan's own read-only inspection found** (§5) — the host
   Postgres's `pg_hba.conf` grants password-authenticated access to `172.16.0.0/12`, a range wide
   enough to include whatever subnet Docker hands the new isolated projects — is not introduced
   by this plan, but landing an internet-facing, untrusted-code-adjacent workload on this box is
   exactly the scenario that turns it from an academic gap into a live one. It must be tightened
   as part of this program, not treated as somebody else's follow-up.

What remains true, and is the actual containment claim this plan can honestly make: **none of the
three incoming workloads ever holds an ERP credential.** WebDesk keeps its own Postgres with its
own owner/migrator/app role split (never the host cluster); Postiz keeps its own two Postgres
instances; lab-runner holds no database credential and no ERP identity at all. A compromise of any
of the three yields a path to *attempt* things against the ERP's surfaces, not a key that opens
them.

---

## 2. Isolation design

### 2.1 WebDesk

**Artifacts:** `webdesk/docker-compose.aicenter.yml` (new overlay, used with the existing
`webdesk/docker-compose.yml` base — never alone), `infra/nginx/webdesk.aicenter.conf` (new vhost).

| Control | How |
|---|---|
| Separate compose project | `name: webdesk` (base file, unchanged) |
| Separate network, no route to the ERP | No service in the overlay ever names `gaiada_default`; the project's implicit `webdesk_default` network is the only one in play |
| Own Postgres | Carried unchanged from the base file — **never** the host cluster; would collapse the credential separation that is this plan's actual containment claim (§1) |
| Hard `cpus`/`mem_limit`/`pids_limit` on every container | Set as literal numbers on every service in the overlay — never an interpolated `${VAR:-}` default, per the estate's own "empty env var becomes zero" trap |
| `no-new-privileges`, dropped caps, read-only rootfs | `security_opt: [no-new-privileges:true]` on every service; `read_only: true` + an explicit `/tmp` tmpfs on `payload`/`payload-gateway`/`api` (Node needs a writable `/tmp`; nothing else) |
| Env files owned by a separate unix user, 0600 | `.env` and `.env.control` live under `/etc/webdesk/`, owned by a dedicated `webdesk-svc` user, mode 0600 — never root:root, never world-readable, never in the release image (§4 step 2) |
| Caddy is not the public listener | `proxy` publishes `127.0.0.1:8380` only (unchanged from the base overlay pattern); `infra/nginx/webdesk.aicenter.conf` is the actual public listener, on a **new hostname** (never `erp.gaiada.online`/`aicenter.gaiada.online` — those are the ERP's own origins and must not share a TLS SAN or cookie scope with third-party client sites) |

**What changes in WebDesk's own config to make this true:** nothing in `webdesk/docker-compose.yml`
(the base file) or `webdesk/proxy/Caddyfile` needs to change — Caddy already refuses `/admin`,
`/api/graphql` and `/control/*` (WSK-D20/D-5), and that denylist is exactly what the new nginx
vhost proxies to. The overlay only changes *where Caddy is reachable from* (loopback, unchanged
from the SumoPod overlay's own shape) and *what fronts it publicly* (a real nginx vhost with its
own copy of the same three-path denylist, evaluated before the `proxy_pass`, as defense in depth —
see the vhost file's own comment for why a second, independent denylist copy is deliberate here).

### 2.2 gaiada-social (Postiz)

**Artifact:** `infra/compose/docker-compose.social.yml`, retargeted in place (see its own header
for the full diff rationale). Same containment shape as WebDesk, adapted to what already existed:

- Still its own compose project (`gaiada-social`), still digest-pinned, still outside the release
  path — none of that changes.
- `cpus`/`mem_limit`/`pids_limit` added to all five services (previously `mem_limit` only).
- `SOCIAL_BIND_ADDR` defaults to `127.0.0.1` — the WireGuard-tunnel option is retired, since
  `platform-nest` now reaches Postiz over loopback, same host.
- No line in this file ever names `gaiada_default`; the project's own `gaiada-social_default`
  network is untouched by the retarget.
- **Postiz needs no public nginx vhost at all.** Its OAuth callback URLs already point at
  `https://erp.gaiada.online/social`, served by `platform-ui` — which is now on the same box. The
  only public surface Postiz needs is the one `platform-ui` already has.

### 2.3 lab-runner

**Artifacts:** `infra/systemd/gaiada-lab-runner.service` (new), `infra/docker/daemon.json.gda-
aicenter-with-gvisor.json` (reference — the exact daemon.json merge, not applied by this plan).

This is the one workload where **only `runc` being available is a real, structural gap**, and it
is addressed head-on rather than argued around:

- **gVisor (`runsc`) must be installed and registered as a non-default Docker runtime before
  lab-runner's first real submission.** Exact install + `daemon.json` merge + verification
  sequence: `infra/docker/daemon.json.gda-aicenter-with-gvisor.json`'s own header. This mirrors
  exactly what was already done and DEV-VERIFIED on SumoPod (`lab-runner/README.md`, "Deployed
  (SumoPod, 2026-08-25)" — `LAB_RUNNER_RUNTIME=runsc`, kernel `4.19.0-gvisor` between each
  submission and the host) — it is not a new technique, it is redeploying a proven one to a new
  box.
- **Every other flag `lab-runner/dist/sandbox.js` already applies to each per-attempt
  container** — `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` rootfs,
  `--user 65534:65534`, `--memory`/`--memory-swap`/`--cpus`/`--pids-limit`, `--network none` by
  default — carries unchanged. That code is host-agnostic; nothing about it needs to change for
  this move, and nothing in this plan touches it.
- **The runner container itself** (the sibling-spawner, not the sandboxes it creates) gets the
  same posture one level up, in `infra/systemd/gaiada-lab-runner.service`: non-root, capabilities
  dropped, `no-new-privileges`, resource-capped. The two things it cannot have that a lab
  container can — a read-only rootfs (needs `docker-cli` + `npm` deps on a normal filesystem) and
  no Docker socket (it *is* the thing that holds the socket) — are named explicitly in that file
  rather than silently absent.
- **Verdict on whether this is a blocker for landing lab-runner at all: no, conditionally.**
  Installing gVisor is a well-trodden, previously-proven operation (§4 Phase 3) and is not itself
  the blocker. What this plan DOES treat as a hard precondition, not a nice-to-have, is the
  capacity finding in §3: a 4-vCPU box already at load ~2.1/4 cannot absorb "worst-case ceilings
  across all three new workloads" without risking the ERP's own control-plane containers, and
  lab-runner is the workload whose failure mode (a starved Cerbos/Keycloak on a box that also
  executes untrusted code) is the worst of the three to get wrong. **This plan sequences
  lab-runner LAST, gated on the gVisor install landing clean AND on an explicit capacity decision
  (resize or accept `LAB_RUNNER_CONCURRENCY=1`) — see §4 Phase 3 and §3's verdict.** This is a
  recommendation to sequence and throttle, not a re-litigation of the landing decision itself.

---

## 3. Capacity verdict

**Measured 2026-08-31, read-only** (commands in §7): GCE e2-standard-4, **4 vCPU / 15.6 GiB total,
~10 GiB "available" (7.2 GiB free + 3.6 GiB reclaimable buff/cache), load ~2.1/4**, 27 containers
already running, **99 GB disk, 46% used, 52 GB free**. Host Postgres: `max_connections=100`, **9
active** (91 headroom). No `runsc`/gVisor runtime registered; only `runc` present.

### Memory — declared ceilings vs. actual usage

| Workload | Actual measured (from the ticket) | Sum of hard `mem_limit` ceilings in the artifacts above |
|---|---|---|
| gaiada-social | ~1.8 GiB RSS | 3g + 512m + 320m + 768m + 384m ≈ **4.97 GiB** |
| WebDesk | ~306 MiB RSS | 256M + 1024M + 512M + 768M + 1024M + 256M + 512M ≈ **4.35 GiB** |
| lab-runner | negligible idle; burst-only | runner 512m + 1 concurrent lab × 768M(max) ≈ **1.25 GiB** worst case |
| **Total** | **~2.1 GiB actual** (~9% of the box's 4 vCPU per the ticket's own figure) | **≈ 10.6 GiB worst-case ceiling** |

**Reading it:** actual measured usage is trivial — about a fifth of the box's total RAM, matching
the ticket's own "~9% of 4 vCPU" figure for the social stack alone. The ceilings, summed for the
worst case where every container hits its cap simultaneously, are **≈10.6 GiB against ~10 GiB
currently available** — that is not comfortable headroom, it is essentially the whole available
budget, with **zero margin left for the ERP's own containers to grow** and no buffer for a
simultaneous spike (a Postiz cron publish run + a WebDesk media upload burst + a lab-grading batch
landing in the same minute is not a contrived scenario for three workloads that all just moved
onto the same box). Docker's `mem_limit` triggers an OOM-kill at the ceiling, not graceful
degradation, so "the ceilings sum to more than available" is a real risk, not an accounting
nicety — it means a genuine coincidence of load WILL kill something, and on this box "something"
may be an ERP container that never had a resource problem before this migration.

### CPU — the sharper number

| Workload | Sum of `cpus` ceilings |
|---|---|
| gaiada-social | 1.5 + 0.5 + 0.25 + 0.5 + 0.5 = **3.25** |
| WebDesk | 0.5 + 1.0 + 0.5 + 1.0 + 1.0 + 0.25 + 0.5 = **4.75** |
| lab-runner | runner 1.0 + 1 concurrent lab × 1.0(max) = **2.0** |
| **Total** | **≈10 vCPU-equivalent ceiling on a 4-vCPU box** |

CPU ceilings are soft (CFS quota, not a reservation), so this is not automatically fatal the way
the memory sum is — Linux scheduling shares fairly under contention rather than refusing to run.
But a **2.5× oversubscription of CPU ceilings on a box already running its ERP control plane at
load 2.1/4** means that under real concurrent load, Cerbos/Keycloak/platform-nest are competing
for cycles with three newly-landed workloads, one of which (lab-runner) exists specifically to run
someone else's arbitrary code. A starved Cerbos on this estate fails *closed* (a documented trap
already: "a healthy Cerbos container has served two-day-stale policy" is one flavor of this class
of problem; a CPU-starved one is another), which is the wrong failure mode to introduce with a
capacity decision made in passing.

### Postgres connections — not actually at risk

None of the three incoming workloads uses the host Postgres cluster. WebDesk keeps its own
Postgres container; Postiz keeps its own two. **`max_connections=100` / 9-in-use is unaffected by
this migration and is not a constraint on it** — worth stating plainly since the design docs this
plan builds on spent real effort on connection-pool topology for a different concern (Zone
A/Zone B separation) that does not translate into a host-Postgres capacity risk here.

### Disk — adequate short-term, needs the standard discipline

52 GB free comfortably covers the new images (~1–2 GB for WebDesk's Node services, ~7.6 GB for the
Postiz/Temporal image set per the compose file's own disk-history comment, lab-runner's image is
already ~small) plus initial volume growth. Two standing risks, both already-documented estate
patterns rather than new ones: **prune before deploying** (the estate's own documented rollback
failure mode — a full disk turns a healthy release into a rollback) and **Postiz's upload volume
is unbounded growth** (already flagged in `infra/runbooks/deploy-vps.md`'s Postiz section) — add
it to whatever disk alerting exists on this box before, not after, it matters.

### Verdict

**The e2-standard-8 resize (8 vCPU / 32 GiB) is a PREREQUISITE, not merely advisable, before
landing all three workloads concurrently at their designed ceilings.** The memory sum alone
(~10.6 GiB of ~10 GiB available) already crosses into "will OOM-kill something under realistic
concurrent load," and the CPU sum (≈10 vCPU-equivalent ceilings on 4 physical cores, layered on an
existing 2.1/4 baseline) is the sharper version of the same finding. This is a GCE stop/resize/
start operation — briefly state-destroying to every container on the box — and is explicitly
**out of this plan's execution authority**: it requires its own owner/orchestrator confirmation
and a scheduled maintenance window, is not something this plan executes, and is called out as a
blocking dependency in §4 Phase 0.

**If the resize is deferred:** land (b) WebDesk and (a) gaiada-social — their combined ceiling
(~9.3 GiB / ~8 vCPU) is closer to fitting, though still tight — and hold (c) lab-runner back
entirely until either the resize lands or `LAB_RUNNER_CONCURRENCY` stays at the throttled value
this plan's artifact already sets (1, not SumoPod's 2) and the operator accepts materially slower
grading throughput as the cost of not resizing.

---

## 4. Runbook — step by step, with rollback

Every step below honors the estate's server hard rules: **check tag/config parity before any
`up -d`** (trust `docker inspect`, never `/health`, which can report a stale version even after a
failed deploy); **never `--remove-orphans`** without a project scope; **the server compose set is
always both files together** (`docker-compose.vps.yml` + `docker-compose.hostdata.yml`) for
anything touching the existing `gaiada` project; **prune before deploying**; **a `.env` var does
nothing unless the service's `environment:`/`env_file` block also names it**.

### Phase 0 — preconditions (before any container moves)

| # | Step | Verification | Owner action needed |
|---|---|---|---|
| 0.1 | Confirm the capacity decision (§3): resize now, or accept the throttled/partial-landing fallback | Written confirmation in this ticket | **Yes — explicit, before Phase 2** |
| 0.2 | If resizing: schedule the GCE stop/resize/start maintenance window | GCE console shows `e2-standard-8`; `nproc` on the box returns 8 | **Yes — this plan does not execute it** |
| 0.3 | Confirm DNS/hostname for WebDesk's public vhost (never `erp.gaiada.online`) | A resolvable hostname exists, pointed at `gda-aicenter`'s public IP | **Yes — owner decision, no repo default assumed** |
| 0.4 | `docker system df` and `docker image prune -f` (safe: prunes only dangling images, not running containers) | Free disk stays ≥40 GB after the new images land | No — routine hygiene |
| 0.5 | Snapshot the pre-migration container baseline | `docker ps -a --format '{{.Names}}\t{{.Status}}' \| sort > /tmp/baseline-pre-migration.txt` | No |

### Phase 1 — WebDesk (lowest risk: no untrusted code, smallest footprint)

```sh
# On gda-aicenter, as the webdesk-svc deploy identity (create it first if it doesn't exist —
# see §4 step "filesystem/secrets" below).
sudo mkdir -p /etc/webdesk
sudo chown webdesk-svc:webdesk-svc /etc/webdesk
# .env and .env.control are hand-populated by the operator — never generated by this plan,
# never containing a real Zone A credential (WSK-01 hard rule, unchanged).
sudo -u webdesk-svc chmod 600 /etc/webdesk/.env /etc/webdesk/.env.control

cd ~/gaiada-webdesk/webdesk   # a checkout of just this component, per the estate's per-component deploy convention
docker compose --env-file /etc/webdesk/.env \
  -f docker-compose.yml -f docker-compose.aicenter.yml config -q     # true dry run FIRST
docker compose --env-file /etc/webdesk/.env \
  -f docker-compose.yml -f docker-compose.aicenter.yml config | grep -A3 'ports:'
  # MUST show only proxy's 127.0.0.1:8380 — resolved config, never the overlay text

docker compose --env-file /etc/webdesk/.env \
  -f docker-compose.yml -f docker-compose.aicenter.yml up -d
docker compose --env-file /etc/webdesk/.env \
  -f docker-compose.yml -f docker-compose.aicenter.yml ps    # every service Up (postgres healthy)
```

**Apply the nginx vhost** (manual, never CI-synced on this box — same convention as every other
hand-applied vhost here): copy `infra/nginx/webdesk.aicenter.conf` to `/etc/nginx/conf.d/`, fill
in `<WEBDESK_PUBLIC_HOST>`, `sudo certbot --nginx -d <host>`, `nginx -t && systemctl reload nginx`.
Full steps and verification curls are in the vhost file's own header.

**Verification:**
```sh
curl -sI https://<WEBDESK_PUBLIC_HOST>/healthz         # 200
curl -sI https://<WEBDESK_PUBLIC_HOST>/admin            # 404 — 200 means STOP and investigate
curl -sI https://erp.gaiada.online/                     # 200 — proves the ERP vhost is undisturbed
docker exec <webdesk-postgres-container> pg_isready -U webdesk_owner -d webdesk
```

**Rollback:** `docker compose -f docker-compose.yml -f docker-compose.aicenter.yml down` (never
`-v` unless data loss is intended — see §6 for the data-migration/backup plan first). Restore the
nginx vhost's timestamped `.bak` or remove the new file; `nginx -t && systemctl reload nginx`.
This project cannot affect `gaiada_default` or any ERP container by construction (§2.1), so
rollback here carries no risk to the ERP stack — verify with the same `erp.gaiada.online` curl.

### Phase 2 — gaiada-social (Postiz)

```sh
cd ~/gaiada-system/infra/compose   # this IS in the main checkout, unlike webdesk/lab-runner

# 0. Baseline + dry run, same discipline as the SumoPod bootstrap this supersedes.
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort | tee /tmp/social-baseline.txt
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml config -q
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml config | grep -A2 'published'
  # must show 127.0.0.1, never 0.0.0.0

# 1. Fill the SOCIAL_* block into gda-aicenter's OWN .env now (it moved here from the SumoPod .env
#    — see infra/CLAUDE.md's updated note). SOCIAL_BIND_ADDR=127.0.0.1 (the new default).

# 2. Datastores + Temporal first, same order as before — Postiz depends on the search-attribute
#    fix landing before it ever starts.
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml up -d \
  social-postgres social-redis social-temporal-postgres social-temporal

# 3. THE STEP THAT FAILS SILENTLY IF SKIPPED (unchanged from the original bootstrap):
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml exec -T social-temporal \
  temporal operator search-attribute remove --name CustomStringField \
  --address social-temporal:7233 --namespace default --yes

# 4. Now Postiz.
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml up -d postiz

# 5. Prove the backend actually bound its port (healthy != evidence, same lesson as before):
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4007/api/public/v1/posts   # expect 401

# 6. Registration ceremony (same as the original bootstrap) — enable once, create the one org,
#    close the door again, verify closed. See infra/runbooks/deploy-vps.md's existing steps 6-7
#    for the exact commands; only the host changed (127.0.0.1 instead of 10.88.0.2), not the
#    sequence.

# 7. Diff the baseline.
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort > /tmp/social-after.txt
diff /tmp/social-baseline.txt /tmp/social-after.txt   # exactly +5 containers, nothing else moved
```

No new nginx vhost needed (§2.2) — `platform-nest`'s existing `SocialPublisher` adapter config
just needs its target URL updated from the WireGuard address to `http://127.0.0.1:4007`.

**Rollback:** `COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml down` (no `-v`
unless account data loss is accepted). Separate project, own network — cannot affect the `gaiada`
project or `gaiada_default` by construction.

### Phase 3 — lab-runner (last, gated)

**Precondition check (hard gate, do not skip):** Phase 0's capacity decision is resolved AND the
gVisor install below is verified BEFORE the systemd unit ever starts.

```sh
# 1. Baseline.
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort > /tmp/pre-gvisor-baseline.txt

# 2. Install gVisor + merge daemon.json — full sequence in
#    infra/docker/daemon.json.gda-aicenter-with-gvisor.json's own header. Summary:
sudo apt-get update && sudo apt-get install -y ca-certificates
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak-$(date -u +%Y%m%dT%H%M%SZ) 2>/dev/null || true
# merge the "runtimes" key from the reference file into /etc/docker/daemon.json by hand
sudo dockerd --validate --config-file /etc/docker/daemon.json
sudo systemctl restart docker    # DISRUPTIVE — restarts every container's PID namespace.
                                  # Confirmed maintenance window required (Phase 0).

# 3. Verify the daemon restart did not regress anything already running.
docker info --format '{{json .Runtimes}}' | grep -o runsc
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort > /tmp/post-gvisor-baseline.txt
diff /tmp/pre-gvisor-baseline.txt /tmp/post-gvisor-baseline.txt
  # every container should be back Up/healthy; no NEW restart count above its prior baseline

# 4. Build + place the runner image, deploy the systemd unit.
docker build -t gaiada-lab-runner:0.1.1 ./lab-runner   # from a checkout of lab-runner/
sudo useradd --system --no-create-home webdesk-svc 2>/dev/null || true   # if not already created in Phase 1
sudo mkdir -p /etc/gaiada-lab-runner /var/lib/gaiada-lab/tmp
sudo chown webdesk-svc:webdesk-svc /etc/gaiada-lab-runner /var/lib/gaiada-lab/tmp
# populate /etc/gaiada-lab-runner/lab-runner.env by hand: LAB_RUNNER_TOKEN (openssl rand -hex 32),
# LAB_RUNNER_IMAGES=node20=node:20-alpine (widen the allow-list deliberately, never with :latest)
sudo chmod 600 /etc/gaiada-lab-runner/lab-runner.env
sudo cp infra/systemd/gaiada-lab-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gaiada-lab-runner.service

# 5. Re-drive the SAME eight-case matrix lab-runner/README.md already ran on SumoPod, ON THIS box
#    — do not accept the SumoPod result as evidence for a different host and a different runtime
#    install. At minimum: a correct submission scores 100; DNS from inside a lab returns
#    DNS_BLOCKED; `image: "alpine:latest"` is refused (KEY not reference); a fork bomb hits
#    --pids-limit; GET /health reports runtime "runsc", not "runc".
curl -s http://127.0.0.1:4310/health | grep -o '"runtime":"[a-z]*"'   # expect runsc
```

**Verification:** the full matrix from `lab-runner/README.md`'s own table, re-run against this
host — not assumed from the SumoPod result, per the estate's "scripted/cross-process verification
≠ real-input verification" rule and the same host-specific-bugs lesson lab-runner's own README
already documents (the `/work` tmpfs ownership bug and the `mkdtemp` mode bug were BOTH invisible
on Docker Desktop and only surfaced on the real Linux target — assume this host can surface a
third one).

**Rollback:** `sudo systemctl disable --now gaiada-lab-runner.service`. If the gVisor install
itself is the problem (not just the service): restore `/etc/docker/daemon.json`'s `.bak`,
`sudo systemctl restart docker`, re-diff against the pre-gvisor baseline. `runsc` staying
installed-but-unregistered is harmless; leaving `LAB_RUNNER_RUNTIME=runsc` set while the runtime
is unregistered is not — the runner would refuse to start rather than silently fall back to
`runc` (config.js's own `required()` guard pattern), which is the correct fail-closed behavior.

---

## 5. Contradicting finding — pre-existing `pg_hba.conf` exposure, worth raising now

Read-only inspection of the host Postgres (§7) found: **`listen_addresses = 'localhost,
172.17.0.1'`** (loopback plus the default Docker bridge's gateway address, so ERP containers can
reach it via `host.docker.internal`), and `pg_hba.conf` grants:

```
host    all             all             172.16.0.0/12           scram-sha-256
```

That is every database, every role, from any source address in `172.16.0.0/12` — a range wide
enough to include the ERP's own `gaiada_default` (172.18.0.0/16, confirmed) **and every other
subnet Docker's default IPAM pool hands out to a new project** (`webdesk_default`,
`gaiada-social_default`, and any bridge network `lab-runner`'s per-attempt sandboxes create,
unless those are given explicit non-`172.16.0.0/12` subnets). Password authentication is still
required — this is not an open door — but it is a **materially wider network path to attempt
credentials against the ERP's own database than "the ERP's own containers" alone**, and it
predates this plan entirely.

**This is not introduced by the migration and this plan does not fix it** (editing host Postgres
config is a live-server change outside this plan's authority). It is flagged here because landing
an internet-facing workload (WebDesk) and an untrusted-code-execution workload (lab-runner) on
this box is precisely the scenario that turns a theoretical gap into a live one, and it should not
be discovered later as a surprise. **Recommended follow-up, requiring its own owner/DBA
confirmation and its own change window:** tighten the `172.16.0.0/12` rule to the ERP's actual
subnet (`172.18.0.0/16`) plus nothing else, and/or add an explicit host-firewall DROP for
inbound `:5432` from the new projects' subnets. Neither is executed by this plan.

---

## 6. Data migration + backups

**Rule this plan follows throughout:** backups of a workload must not live on the same box as the
workload. Since WebDesk and gaiada-social are moving from `sumopod` to `gda-aicenter`, and
`sumopod` keeps observability and is staying up, **`sumopod` becomes the natural pull-model backup
target** for both — this is exactly the "second estate box" phase already designed (unexecuted)
in `infra/runbooks/webdesk-zoneb-backups.md` §3, just with the roles of "workload box" and "backup
box" swapped from what that runbook assumed. Reuse its pull-model mechanism unmodified:
`gda-aicenter` gets the restricted `*-backup-pull` forced-command SSH user; `sumopod` (or wherever
the operator designates) initiates the pull on its own cron, using its own key, and
`gda-aicenter` never holds a credential *for* the backup target — see that runbook §1 for why that
asymmetry is the whole point.

### What actually needs to move (there is nothing live to migrate — first landing, not a cutover)

Per the ticket's own framing and this plan's read-only inspection, **neither WebDesk nor
gaiada-social has ever been deployed anywhere** (`docker-compose.social.yml`: "STATUS:
PROTOTYPED... NOT deployed anywhere"; `webdesk/docker-compose.sumopod.yml`'s hardening runbook:
"nothing below has been run against real hardware"). **This is a first landing on `gda-aicenter`,
not a data migration off SumoPod** — there is no Postiz OAuth token, no WebDesk tenant row, no
media file sitting on SumoPod today that this plan needs to move. If that changes before this
plan executes (i.e., someone stands up either stack on SumoPod in the interim), re-scope this
section before proceeding — moving live OAuth tokens or tenant data is a materially different,
higher-risk operation than what is planned here, and the estate's own rule stands: **never back up
the Postiz volumes** (they hold live OAuth tokens; the same crypto-shred-adjacent reasoning as the
bot's `keys.json`) even if it comes to that.

### Backup targets once each stack is live on `gda-aicenter`

| What | Where it lives on `gda-aicenter` | Pull target | Notes |
|---|---|---|---|
| WebDesk Postgres | `webdesk_pgdata` volume | `sumopod` (pull, per `webdesk-zoneb-backups.md` §1–2) | Nightly `pg_dump` -> versioned + object-locked bucket, same mechanism, box roles swapped |
| WebDesk MinIO | `webdesk_miniodata` volume | Same pull target | `mc mirror`-style pull, same GOVERNANCE-mode retention |
| Postiz Postgres | `social-postiz-pg` volume | `sumopod` | New — this volume was never covered by a backup runbook before (SumoPod had none written) |
| Postiz uploads | `social-postiz-uploads` volume | **Not backed up** | Unbounded growth, and per `deploy-vps.md`'s existing Postiz section, media is reconstructible by re-attaching accounts — not archived |
| Temporal Postgres | `social-temporal-pg` | Not backed up | Workflow execution history only; disposable, re-provisions clean |
| lab-runner | Nothing persistent | N/A | "Results are not durable state — the platform records the grade; this service is a compute surface, not a store" (`lab-runner/dist/config.js`'s own doc comment) |

**RTO/RPO:** carry the same PLANNED targets `webdesk-zoneb-backups.md` §5 already states (≤24h
RPO, ≤2h RTO for Postgres restore to a throwaway instance) — they were host-agnostic estimates
based on `infra/scripts/restore-drill.sh`'s precedent, not SumoPod-specific measurements, so they
transfer. They remain **targets, not measurements** until a real restore drill runs on
`gda-aicenter`, which this plan does not execute.

---

## 7. What was actually verified (read-only, this ticket)

```
$ ssh gda-aicenter docker info --format '{{json .Runtimes}}'
  -> only "io.containerd.runc.v2" and "runc". No runsc, no gVisor, no Kata.

$ ssh gda-aicenter df -h / ; free -h ; nproc
  -> 99G disk, 46% used, 52G free. 15Gi total mem, 7.2Gi free, 10Gi available. 4 vCPU.

$ ssh gda-aicenter sudo cat /etc/nginx/sites-enabled/*  (vhost server_name lines)
  -> aicenter.gaiada.online, erp.gaiada.online, rhproptest.gaiada1.online, default.
     Confirms nginx owns :80/:443 and the three real vhosts named in the ticket.

$ ssh gda-aicenter sudo -u postgres psql -tAc 'show max_connections;'
  -> 100
$ ssh gda-aicenter sudo -u postgres psql -tAc 'select count(*) from pg_stat_activity;'
  -> 9

$ ssh gda-aicenter docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
  -> 27 containers, all `gaiada-*`, confirming the project name and the ticket's container count.

$ ssh gda-aicenter docker network ls ; docker network inspect gaiada_default --format '{{json .IPAM.Config}}'
  -> only bridge/gaiada_default/host/none exist. gaiada_default = 172.18.0.0/16.

$ ssh gda-aicenter sudo cat /etc/postgresql/*/main/postgresql.conf | grep listen_addresses
  -> listen_addresses = 'localhost,172.17.0.1'
$ ssh gda-aicenter sudo cat /etc/postgresql/*/main/pg_hba.conf | grep -v '^#'
  -> the 172.16.0.0/12 rule flagged in §5.

$ ssh gda-aicenter docker inspect gaiada-platform-1 --format '...' | grep DATABASE_URL
  -> confirms platform-nest reaches host Postgres via host.docker.internal:5432, corroborating
     the listen_addresses/pg_hba reading above.
```

No `docker run`, `docker compose up`, `systemctl`, or file write of any kind was issued against
either server. Every command above is a read (`docker ps`, `docker inspect`, `docker network
inspect`, `cat`, `df`, `free`, `nproc`, a read-only `psql -tAc`).

---

## 8. Summary for the report

- **Capacity verdict:** actual usage of all three incoming workloads is small (~2.1 GiB RAM,
  ~9% of 4 vCPU) but **declared worst-case ceilings sum to ~10.6 GiB RAM / ~10 vCPU-equivalent
  against a 4-vCPU/~10-GiB-available box already at load 2.1/4** — the e2-standard-8 resize is a
  **prerequisite**, not advisory, for landing all three concurrently at their designed limits.
  Host Postgres connection budget (100 max, 9 in use) is unaffected — none of the three workloads
  touches it.
- **Isolation design:** three separate compose projects/own networks, hard resource ceilings on
  every new container, WebDesk keeps its own Postgres, nginx (not Caddy) is the public listener
  for WebDesk via a new vhost, Postiz needs no new public listener (loopback to `platform-ui`,
  same box now), lab-runner gets gVisor installed and verified before first use and is sequenced
  last, gated on both the gVisor install and the capacity decision.
- **Contradicting finding:** host Postgres's `pg_hba.conf` grants password-auth from the whole
  `172.16.0.0/12` range, wider than the ERP's own `gaiada_default` subnet and likely reachable
  from the new projects' own bridge networks — pre-existing, not fixed by this plan, flagged as a
  required follow-up with its own confirmation.
- **Execution commands:** §4's three phases, each with dry-run/`config -q` checks, explicit
  verification curls/commands, and a rollback that cannot touch the `gaiada` project by
  construction (separate compose projects, no shared network).

Nothing above has run. Every status claim in the artifacts this plan produced is **PLANNED**.
