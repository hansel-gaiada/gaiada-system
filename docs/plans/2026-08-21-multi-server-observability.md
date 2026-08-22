# Multi-server Plane A observability (MSO)

**Date:** 2026-08-21 · **Status:** IN PROGRESS — MSO-00/01 DEV-VERIFIED live; MSO-02 (per-host
alerts + env routing) PROTOTYPED — promtool/amtool-verified against the remote and against a live
true condition, NOT YET DEPLOYED to the remote box (see §8 status note); MSO-04 (`infra_hosts`)
and MSO-05 (estate endpoint) PROTOTYPED, backend only, unit + live-DB tested, not yet consumed by a
UI; OQ-2/3/4 ANSWERED below (§10); MSO-03/06/07/08 still PLANNED ·
**Owner ask:** "we need to see more servers in there. we are having lots of servers for staging,
production etc." — the ERP's Systems → Observability console must become a multi-host,
multi-environment view.
**Related:** [`docs/blueprints/monitoring-program.md`](../blueprints/monitoring-program.md) (the
two-plane ruling, §0) · [`docs/plans/2026-08-18-observability-relocation.md`](2026-08-18-observability-relocation.md)
(§9–§13 execution record) · `docs/FRONTEND-BFF-CONTRACT.md` **§20.1a** (the API contract this design
adds) · `infra/CLAUDE.md`

---

## 0. Ruling, in one screen

1. **Scope guard, restated as binding:** this is **Plane A** — our own infrastructure. Staff-only
   (`isElevated`), never tenant-scoped, never sellable, never merged with Plane B (`/monitoring`,
   clients' websites). Nothing in this design touches Plane B code, tables, or Cerbos policies.
2. **Onboarding (server N+1):** a **per-host agent bundle** — node-exporter + the OTel collector —
   that scrapes locally and **remote_writes outbound** over a **WireGuard hub-and-spoke** centred on
   the SumoPod obs host (`10.88.0.2`). No inbound port is ever opened on a monitored host; nothing
   is ever published on `0.0.0.0`. This is the pattern the relocation already DEV-VERIFIED for
   `gda-aicenter`; new hosts repeat it, they do not invent a second one.
3. **Inventory becomes data:** a global, non-tenant table `infra_hosts` in the platform DB is the
   console's source of truth for *which hosts should exist* and what env/role each is. The `host`
   series label is the join key. Environment and host identity are **also** stamped into every
   series as remote_write external labels, so alert rules can route by env.
4. **The API** extends `GET /api/admin/observability` to an estate shape (`hosts[]` + estate
   rollup), expand/contract — contract text in `docs/FRONTEND-BFF-CONTRACT.md` §20.1a. Every field
   distinguishes **measured-zero from not-measured**; scrape staleness is a first-class per-host
   state, not a footnote.
5. **Blocking prerequisite found during verification:** the relocation's local decommission is
   being **undone by every deploy** — `docker-compose.observability.yml` still defines the storage
   services and `COMPOSE_FILES` includes it, so `alpha-01.059.0116a` resurrected
   prometheus/grafana/loki/tempo/alertmanager on `gda-aicenter` two days ago. That drift must be
   killed (MSO-00) before anything else lands, or the estate keeps paying for two stacks and every
   future probe of "what runs where" lies.

---

## 1. Verified current state (2026-08-21, probed — not quoted from docs)

| Claim | Verified how | Result |
|---|---|---|
| Storage relocated to SumoPod | `curl 10.88.0.2:19090/api/v1/query` from `gda-aicenter` | remote store serving; 16 `up` series / 9 job groups |
| Platform console works against it | env of running `gaiada-platform-1` + in-container fetch | `PROMETHEUS_URL=http://10.88.0.2:19090`, fetch returns 16 series |
| ⚠ Local storage stack resurrected | `docker ps` + compose `config_files` label | prometheus/grafana/loki/tempo/alertmanager all **Up 2 days**, created by the `alpha-01.059.0116a` deploy; label names `docker-compose.observability.yml` |
| Resurrected stack is *active*, not idle | `curl localhost:9090/api/v1/targets`, `/rules` on the box | local Prometheus scraping **14 targets**, evaluating the full rule set |
| Resurrected Alertmanager notifies into a void | `curl localhost:9093/api/v2/status` | rendered config points at `mailpit:1025` / `gaiada.invalid` dev defaults — no live duplicate paging, but rules evaluate twice and disk fills twice |
| Host labels on series | `count by (host, job)(up)` on the remote | **only** `host="sumopod"` (static label on its node job). Every `gda-aicenter` series is host-less |
| cAdvisor per-container discovery | `count(container_last_seen{name!=""})` | **empty result** — still broken estate-wide (MON-09n) |
| Remote Alertmanager reachable over the tunnel | `curl 10.88.0.2:9093/api/v2/status`, `/alerts` | serving; only `Watchdog` active |
| `RemoteWriteStalled` is single-host | `infra/observability/prometheus/rules/alerts.yml:93` | `absent_over_time(up{job="otel-collector-self"}[10m])` — keyed to one host's collector, does not generalize |
| Known ssh estate on the operator machine | `~/.ssh/config` | `gda-aicenter`, `sumopod`, `aire-vps`, `gda-ai01`(+`gda-tunnel`, same IP), `gda-ce01`, `delphi`, `helios`. **CORRECTED 2026-08-21 by owner decision:** `delphi` and `helios` ARE the owner's and ARE authorized onboarding targets — an earlier session had them on a never-touch list believing they belonged to another company, and that belief was wrong. They are LIVE, so they wait for the MSO-03 runbook. **`gda-ce01` is OUT OF SCOPE** — owner: "we shouldnt have anything to do with gda-ce01" |

### 1.1 The drift ruling: the resurrected local stack is NOT design

The relocation (§9 of the relocation doc) stopped the storage services **by name** on the box but
never removed them from `docker-compose.observability.yml`, and §2.5 of the monitoring program had
*just added* that file to `COMPOSE_FILES` so the pipeline would own the observability services. Net
effect: **every deploy re-creates the storage layer the relocation removed.** The intended design —
stated in both docs and in the obs-remote compose header — is *collection stays local (collector +
exporters), storage/query/alerting live on the obs host*. So:

- **Intended on `gda-aicenter`:** otel-collector, node-exporter, cadvisor, blackbox-exporter,
  postgres-exporter ×2, redis-exporter ×2, synthetic-prober. (The collector scrapes these locally
  and remote_writes — that local *scraper* is by design.)
- **Drift on `gda-aicenter`:** prometheus, grafana, loki, tempo, alertmanager(+render), ntfy — the
  duplicated backends. This is why the disk reclaim recovered 860 MB instead of ~2.8 GB: the
  volumes were re-attached to live containers and refilling.

This also explains a booby trap for THIS program: any "add a host" work tested against the box's
`:9090` would be testing the **zombie** Prometheus, not the real one.

---

## 2. Onboarding architecture — how server N+1 starts reporting

### 2.1 Options weighed

| Option | Reachability needed | Security posture | Verdict |
|---|---|---|---|
| **(a) Central Prometheus scrapes node_exporter on each host directly** | Central store must dial *into* every host: exporter ports published per host, over WireGuard, public TLS, or Tailscale | Worst. Every exporter bind is a foot-gun on this estate — **Docker's DNAT rules are evaluated before ufw's**, so one `0.0.0.0` bind is internet-reachable on a box whose firewall reports "deny incoming". Multiplies inbound surface by (hosts × exporters); central static scrape YAML grows per host and drifts | **Rejected** |
| **(b) Per-host collector that remote_writes outbound** | Only **outbound** host → hub `10.88.0.2:19090`. Zero inbound ports on monitored hosts; exporters stay unpublished on the compose network | Best available. One egress flow per host; hub ports bound to the WireGuard address only. Known weaknesses: the remote-write receiver is unauthenticated *inside the mesh* (any wg peer could inject series — acceptable at current scale, hardening noted below), and the metrics queue is in-memory (MON-09p, pre-existing) | **✅ Chosen** |
| **(c) Prometheus service discovery (file_sd/http_sd)** | Same as (a) — SD only automates *finding* targets for a pull model | Inherits (a)'s posture. SD answers "what should the scraper dial", which we don't need once nothing is dialed inward. The `infra_hosts` table (§3) plays the SD role for the *console* instead | **Rejected as transport; its job moves to the inventory** |

**Transport for (b):** stay on **WireGuard hub-and-spoke**, hub = SumoPod. Weighed against:
- *Public TLS remote_write endpoint:* violates the estate's never-publish posture on a box running
  the owner's private production, and adds cert + auth machinery to build and rotate. Rejected.
- *Tailscale:* easier mesh ops, but introduces a third-party control plane onto boxes we do not
  fully own (SumoPod carries the owner's private production; `gda-ce01`/`aire-vps` status unknown),
  plus a new dependency for zero capability WireGuard doesn't already give us here. Rejected
  unless the owner overrides (OQ-4).

### 2.2 The agent bundle (one pattern, N hosts)

New compose file `infra/compose/docker-compose.obs-agent.yml`, project `gaiada-obs-agent`:

```
new host (10.88.0.N)                          SumoPod hub (10.88.0.2)
──────────────────────────────                ────────────────────────
node-exporter   (no published ports)          prometheus  :19090 (wg-bound)
[cadvisor]      (OFF until MON-09n)           loki        :13100 (wg-bound)
[role exporters as needed]                    tempo       :4317  (wg-bound)
      │ scraped locally                       alertmanager:9093  (wg-bound)
      ▼
otel-collector ── wg, outbound only ──▶ remote_write /api/v1/write
   · prometheus receiver (local jobs only)
   · prometheusremotewrite + external_labels {host: <key>, env: <env>}
   · [filelog → Loki]  optional leg, off by default
```

Parameterized by exactly three values: `HOST_KEY` (the `infra_hosts.key`, becomes the `host`
label), `HOST_ENV` (becomes the `env` label), `OBS_HUB` (defaults `10.88.0.2`). The collector
config template contains **only local jobs** — a new host never inherits `gda-aicenter`'s scrape
list (the obs-remote compose header records why copying scrape configs across hosts manufactures
permanently-down targets).

`gda-aicenter` itself is retro-fitted to the same identity scheme (external labels added to its
existing collector, MSO-01) — it is host #1 of the pattern, not a special case.

**Onboarding a host is then:** ① generate wg keypair on the host, add **one peer entry on the hub**
(`wg set … allowed-ips 10.88.0.N/32` + persist — a host-level change on SumoPod, flagged to the
owner as a standing policy, OQ-3); spoke config points only at the hub (`AllowedIPs 10.88.0.2/32`),
so agents cannot reach each other — least privilege by construction. ② `infra_hosts` row
(status `onboarding`). ③ `docker compose -p gaiada-obs-agent up -d` with the three values.
④ verify per runbook: labeled series arriving, disk rules matching the new host, console row turns
`fresh`. Runbook: `infra/runbooks/onboard-server.md` (MSO-03).

### 2.3 Hard rules the runbook must carry (each one already bitten this estate)

- **Never publish an exporter or the collector on `0.0.0.0`** — Docker DNAT precedes ufw. The
  agent bundle publishes **nothing**; the collector reaches exporters over the compose network and
  egresses over wg only.
- **`delphi` and `helios` are another company's VPSes. Never install anything, never probe, never
  scrape.** The inventory is explicit opt-in; nothing may enumerate `~/.ssh/config` or scan
  `10.88.0.0/24` to "discover" hosts.
- On shared boxes (SumoPod, and any box we do not exclusively own): every docker command scoped
  `-p gaiada-obs-agent`; no prune of any kind; `docker ps -a` diffed before/after, fresh baseline.
- A hand-applied infra change has a maximum lifetime of one deploy (§2.5 of the monitoring
  program). Agent configs live in the repo and ship by tag like everything else.

---

## 3. Where the inventory lives — data, and why

**Ruling: a table.** `infra_hosts`, global (non-tenant), in the platform DB. Static YAML loses on
three counts that are specific to this estate:

1. **The console must render expected-but-silent hosts.** A host list *derived from series* cannot
   contain a host that has never reported or has gone fully dark — the exact "stale target looks
   calm" failure this design is required to kill. The expected-list must live somewhere that does
   not depend on the host reporting. Prometheus config can't express it without per-host rule
   generation machinery; a DB row can.
2. **Rows survive deploys.** `deploy.yml` rsyncs `infra/` from the tag and has now reverted
   hand-applied file changes twice (§2.5, §10 of the relocation doc). Env/role/owner metadata in a
   file would be one stale-tag deploy away from silently reverting; a row is not.
3. **It follows the estate's settled direction** — roles become data (IAM program), monitors are
   ERP rows that *generate* blackbox config (monitoring program K5). Config-as-authority is the
   direction this program keeps walking away from.

What stays config: each host's agent bundle (HOST_KEY/HOST_ENV values, wg addresses) — the platform
has no channel to push config onto hosts, and should not grow one for this. The table is metadata +
expectations, not a control plane. **v1 has no CRUD UI**: rows land by seed/migration (the cadence
of adding servers is the cadence of infra work anyway); an admin CRUD endpoint is a later ticket if
the owner wants it.

### 3.1 Schema sketch (timestamp-named migration, MSO-04)

```sql
CREATE TABLE infra_hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]*$'), -- = `host` label, immutable
  display_name  text NOT NULL,
  env           text NOT NULL CHECK (env IN ('production','staging','ops','dev')),
  role          text NOT NULL DEFAULT '',            -- 'erp-core' | 'observability-hub' | 'ai-host' | …
  provider      text,
  wg_ip         inet,                                 -- mesh address ledger; partial-unique where set
  ssh_alias     text,                                 -- operator convenience ONLY; nothing dials it
  status        text NOT NULL DEFAULT 'onboarding'
                CHECK (status IN ('active','onboarding','decommissioned')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX infra_hosts_wg_ip ON infra_hosts (wg_ip) WHERE wg_ip IS NOT NULL;
```

Non-tenant on purpose (there is nothing per-tenant about our servers); read via `withGlobal` with
the justification comment the escape hatch requires; the RLS linters must be satisfied the same way
the permission catalog's global tables satisfy them (MSO-04 acceptance includes both linters green).
Seed v1 with the two **verified** hosts only — `gda-aicenter` (production / erp-core) and `sumopod`
(ops / observability-hub); the rest land after OQ-1 answers what they are.

### 3.2 Drift between label and table is surfaced, never reconciled silently

- Series exist for a `host` with no row → console renders an **"unregistered host"** row, visibly
  abnormal. (Someone shipped an agent without the row — or mislabeled one.)
- Row exists with no series ever → **"never reported"**, visibly abnormal (status `onboarding`
  renders it as expected-pending instead).
- Row `env` ≠ series `env` label → drift badge on the row. The **table is authoritative for env**;
  the label exists so alert routing can see env without a DB join.

---

## 4. Series identity — the change that must land before host #2

Verified: every `gda-aicenter` series is host-less, and both node jobs use
`instance="node-exporter:9100"` — the only thing separating SumoPod's node metrics from
`gda-aicenter`'s today is the hand-added `host: sumopod` static label. **A second agent-bundle host
shipped without labels would emit literally identical series** (`up{job="node",instance="node-exporter:9100"}`)
and the store would interleave two hosts' samples into one series — corruption, not ambiguity.

So MSO-01, before any onboarding:

- `prometheusremotewrite.external_labels: {host: gda-aicenter, env: production}` in
  `infra/observability/otel-collector/config.yaml` (and mirrored on the parked `otlphttp/metrics`
  exporter so MON-09p, if ever completed, does not silently drop identity).
- Remote self-scrape jobs get static labels too: `host: sumopod` on the `prometheus` job (it is
  missing there today), `env: ops` on both of SumoPod's jobs.
- The agent bundle template (MSO-03) carries the same two labels from its three parameters.

Cutover note: series before the label change have a different identity; with 30d retention the
unlabeled history washes out on its own. Dashboards/rules keep matching (nothing matches on the
*absence* of `host`), but the Host & Infrastructure dashboard should gain a `$host` variable in the
same change so both eras stay readable (part of MSO-01 acceptance).

---

## 5. The API contract

Full §-numbered text added to **`docs/FRONTEND-BFF-CONTRACT.md` §20.1a** (status ⛔ PENDING) — that
file is the contract of record; this section only records the two structural decisions:

1. **Expand/contract, not atomic replace.** The BE ships `hosts[]` + `estate` alongside the legacy
   single-host fields for one release; the UI switches; the legacy fields are then dropped. Four
   releases shipped during the relocation week alone — "FE and BE land in the same tag" is not a
   safe assumption on this estate, and frontend-first drift (a console reading fields the backend
   never sends) is the program's recurring bug class.
2. **Alerts come from Alertmanager, not from Prometheus's `ALERTS` series.** The console must show
   *notification* state — a silenced alert rendering as firing teaches operators to distrust the
   board (and the reverse hides a mute). One flat `alerts[]` with nullable `host` attribution
   (app-level alerts have no host label and stay estate-level); Alertmanager unreachable ⇒
   `alerts: null` + reason — never a silent fallback to a second source that can disagree.

New platform config: `ALERTMANAGER_URL` (deploy value `http://10.88.0.2:9093`) beside the existing
`PROMETHEUS_URL`; both read in `config.observability`.

---

## 6. Signal set — chosen for the person on call

Per host, in render order (the contract fixes the null-vs-zero semantics of each):

| Signal | Source | Why it earns a slot |
|---|---|---|
| **Freshness** — `fresh / stale / dark / never` + last-sample age | `max by (host) (last_over_time(timestamp(up{host!=""})[48h:1m]))` | **The lead signal.** A stale feed is the most dangerous state because it looks calm; it gates how every other cell renders. Thresholds: fresh ≤ 90 s, stale ≤ 600 s, dark > 600 s (deliberately the same 10 m boundary as `RemoteWriteStalled`, so console and pager cannot disagree), never = nothing in the 48 h lookback |
| CPU busy % + cores + load1 | `node_cpu_seconds_total`, `node_load1` by host | load1 without core count is unreadable across heterogeneous boxes |
| Memory used % | `node_memory_*` by host | |
| Disk used % + free GB + **projected free GB at +24 h** | same FS pinning as the `DiskSpaceLow` rule, `predict_linear` 6 h→24 h | this estate has had a full disk roll back a healthy release; a box observed at 98 % (that example was `gda-ce01`, since ruled out of scope — the *signal* is still the point, the box is not ours to watch). The projection is the actionable number, and it must stay expression-identical to `DiskWillFillIn24h` |
| Scrape targets up/down + down job names | `up` by host | per-host, so one broken exporter on staging can't hide inside an estate total |
| Containers running | `container_last_seen{name!=""}` by host | **unavailable estate-wide today** (MON-09n) — renders as unavailable-with-reason, never 0 (§7) |
| Datastores (`pg_up` / `redis_up` per instance) | exporters, where a host ships them | the target-up-≠-check-valid lesson: these were 0 for weeks behind green targets |
| Uptime days | `node_boot_time_seconds` | silent reboots |
| Firing/suppressed alerts attributed to the host | Alertmanager v2 | includes silence state (§5.2) |

Estate rollup: host counts by freshness state, alert counts by state, and nothing else — the board
itself is the detail. Watchdog stays excluded (permanent-red lesson); **`RemoteWriteStalled` is
never excluded** — it is the "this whole board is meaningless" banner and the contract requires the
UI to render it as exactly that.

---

## 7. Explicitly unavailable today — rendered as unavailable-with-reason, never blank or zero

Following the `available:false + reason` precedent already in the controller:

| What | Why | Renders as |
|---|---|---|
| **Per-container metrics / container up-down counts** | cAdvisor discovery broken estate-wide: daemon uses the containerd snapshotter (`GraphDriver: null`) and cAdvisor's RW-layer lookup fails during container-handler construction (MON-09n; five hypotheses eliminated, not the `disk` metric class). `count(container_last_seen{name!=""})` verified **empty** | `containersRunning: {value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter"}` |
| Alert silence state, if `ALERTMANAGER_URL` unset/unreachable | new dependency of §5.2 | `alerts: null` + reason naming the URL state |
| Logs/traces for newly onboarded hosts | optional agent legs, off by default | not a console field at all — the console never implies them |
| Blackbox/synthetic probes of a new host's services | probe lists are per-host, none exist until written | absent from that host's `targets.downJobs` universe; runbook says so |
| Datastore health on hosts shipping no pg/redis exporters | nothing to measure | `datastores: null` + note — distinct from measured-and-down |
| History before the host-label cutover | different series identity (§4) | Grafana concern only; console is an instant snapshot |
| Anything from a `dark`/`never` host | instant vectors empty past Prometheus's 5 m staleness | readings `null`; the freshness state carries the reason |

---

## 8. Alerting changes (MSO-02)

**Status (2026-08-22): PROTOTYPED, verified against the remote (10.88.0.2:19090 /
`gaiada-obs-prometheus-1`, `gaiada-obs-alertmanager-1` on SumoPod), committed to the repo, NOT YET
deployed to the box.** Repo is ahead of the running config — see the status note at the end of this
section for exactly what applying it involves and why it was deliberately not done unattended.

- **`RemoteWriteStalled` generalizes per host, and carries `env` too (a deliberate departure from
  the literal expression first sketched above):**
  `(time() - max by (host, env) (last_over_time(timestamp(up{host!=""})[48h:1m]))) > 600`, `for: 0m`,
  severity `page`, description carrying the same "quiet estate = UNKNOWN, not healthy" wording.
  `by (host, env)` instead of `by (host)`: env is a functional dependent of host (one env per host,
  same collector `external_labels`, §4), so grouping by both adds no new split of a host's series —
  it only carries `env` into the alert's own labels, which the env-based routing this section adds
  needs (`max by (host)` alone would drop `env` and the alert could not be routed by environment at
  all). The estate endpoint's own freshness query stays `by (host)` only because it joins to
  `infra_hosts` in application code instead (contract note 10) — a Prometheus alert has no such
  join available to it.
  The existing single-host `absent_over_time` rule is kept, renamed `RemoteWriteStalledLegacySingleHost`
  with a static `env: production` label, as a belt-and-suspenders cross-check until the generalized
  rule has run a full cycle on the remote without disagreeing with it, then retired (two rules
  briefly, drift-safe direction).
  Known bound: a host dark longer than the 48 h lookback drops out of the expression — the console's
  inventory-driven `never` state is the long-horizon catch, and the alert's own firing→resolved
  transition is itself a page.
- **`DiskSpaceLow`/`DiskWillFillIn24h`/`PostgresDown`/`RedisDown` generalize by inheritance, not by
  aggregation.** None of these four use a `by (...)` clause, so once MSO-01 stamped `host`/`env`
  onto every series via the collector's `external_labels`, these rules already carried host/env
  through unchanged — the fix here is adding `host!=""` (exclude pre-cutover unlabeled series) and,
  for the two disk rules, `mountpoint="/"` to close contract note 10's flagged divergence: the
  estate endpoint's disk queries (`observability.controller.ts`'s `FS` constant) already pinned
  `mountpoint="/"`, the alert rules had not. Verified live this narrows correctly, not just
  theoretically — `gda-aicenter` only ever reports `/` and a tiny `/boot/efi` vfat partition that
  should never drive a disk alert, and `sumopod` only reports `/`.
- **Env-aware routing — DEV-VERIFIED against the remote Alertmanager, both directions:**
  `amtool config routes test` against the rendered config resolves `severity=page,env=production` →
  `page-all`, `severity=page,env=staging` → `default-multi`, `severity=page,env=dev` →
  `default-multi`, `severity=page,env=ops` → `default-multi` (all four `infra_hosts.env` CHECK
  values), `severity=page` with no `env` label at all → `page-all` (fail-safe: an alert this estate
  cannot attribute to an environment pages rather than silently downgrading), `severity=watchdog` →
  `deadmansswitch` (unaffected), `severity=ticket,env=production` → `default-multi` (ticket severity
  is never upgraded to a page by being in production — env sets a paging *ceiling*, not a floor).
  Rules themselves stay env-agnostic; the label rides in from `external_labels` so one rule file
  keeps covering every host (the pattern the remote prometheus config already established for the
  shared `node` job).
- **Real live case this caught in the act of verifying it:** at verification time `sumopod`
  (`env=ops`) was genuinely at 14.6% free on `/` — `DiskSpaceLow`'s new expression matches it live
  today, and the env-routing test above confirms it resolves to `default-multi` (ticket), not
  `page-all` — exactly the outcome OQ-2 calls for on an `ops` host, and a live demonstration of why
  this ticket exists rather than a synthetic one.
- All rule changes went through `promtool check rules` (19 rules before → 20 after, both SUCCESS)
  plus a new `infra/observability/prometheus/rules/alerts_test.yml` (`promtool test rules`, 5 test
  groups, all green) run against the remote's own `prom/prometheus:v3.1.0` image, and `amtool
  check-config` / `amtool config routes test` against the remote's own `prom/alertmanager:v0.28.0`
  image — all via scratch copies inside the containers (`docker cp` to `/tmp`), never by touching
  the live mounted `/etc/prometheus/rules/alerts.yml` or `/etc/alertmanager/alertmanager.yml`. No
  container was restarted; `docker ps -a` on SumoPod shows identical uptimes before and after.
  `infra/scripts/lint-observability.sh` was also run locally (YAML-parse fallback path, promtool/
  amtool not installed on this workstation) — 0 YAML failures across `infra/observability/**`
  including the new files; its unrelated Grafana-dashboard JSON-check step fails on this Windows
  workstation on a pre-existing path-translation bug (`C:\c\Users\...`), reproducible on `main`
  before this change and not touched by it.
  **A loaded rule file is not a served rule file on this estate** (design principle, restated): the
  repo change above is verified but **not yet applied to the remote**. Applying it is a separate,
  explicit step — `rsync -az infra/observability/ sumopod:~/gaiada-obs/infra/observability/`
  followed by `docker restart gaiada-obs-prometheus-1 gaiada-obs-alertmanager-1` (bind-mounted
  config does not hot-reload on content change alone, per the 2026-08-18 relocation doc's own
  finding) — deliberately not run unattended here because it touches the live production paging
  path for a shared, already-imperfect checkout, and because `RemoteWriteStalled`'s DEV-VERIFIED
  legacy form is the one alert that would notice if the swap itself went wrong. Recommend running it
  as its own reviewed step, watching for the `sumopod` `DiskSpaceLow` ticket appearing in Telegram/
  email (confirms the new rule fired for real, live) and the absence of any new page for it
  (confirms the routing held).

---

## 9. Tickets

Seat default is the tier's own model; Opus flagged only where a cheap-first failure would force a
full re-run.

| # | Tier · model | Scope | Done when | Depends on |
|---|---|---|---|---|
| **MSO-00** | devops · **opus·medium** — compose surgery on the live estate; a mistake here recreates the §2.3 outage class and there is one shot per deploy cycle | Kill the resurrection: split `docker-compose.observability.yml` into a collection-only file for `gda-aicenter` (collector + exporters + synthetic-prober); storage services (prometheus/grafana/loki/tempo/alertmanager/render/ntfy) leave the `gda-aicenter` file set entirely (obs-remote.yml already owns them). Update `COMPOSE_FILES` repo variable in the same change. Decommission the resurrected containers **and volumes** on the box; absorb MON-09h (retire `alertmanager-mail/otel-metrics/loki/obs-local` compose files or mark dev-only) | After the **next tag deploy**, zero storage containers on `gda-aicenter` (`docker ps` proof); remote still receiving (16 `up` series pre-MSO-01); measured disk delta recorded in the plan doc | — |
| **MSO-01** | devops · seat default | Host/env external labels per §4, incl. remote self-scrape labels and the dashboard `$host` variable | `count by (host)(up)` shows every job under a host; **zero** host-less groups after the 5 m staleness window; rules still loaded and matching (promtool + live `/api/v1/rules` probe); dashboard renders both hosts | MSO-00 |
| **MSO-02** | devops · seat default | Per-host `RemoteWriteStalled`/`DiskSpaceLow`/`DiskWillFillIn24h`/`PostgresDown`/`RedisDown` + env-based Alertmanager routing per §8 — 🟡 PROTOTYPED 2026-08-22, verified against the remote, **not yet deployed** (repo ahead of the box; see §8 status note for the exact deploy commands withheld pending an explicit go) | promtool unit tests: labeled dark host fires, live host doesn't (`alerts_test.yml`, 5 groups green); routing tree verified with `amtool config routes test` for each of the 4 `infra_hosts.env` values, both directions (production pages, staging/dev/ops don't); live rule probe on the remote (`gaiada-obs-prometheus-1`/`gaiada-obs-alertmanager-1`, scratch-copy method, no restart) | MSO-01, OQ-2 |
| **MSO-03** | devops · seat default | Agent bundle `docker-compose.obs-agent.yml` + collector template + `infra/runbooks/onboard-server.md` (wg peer procedure incl. hub-side commands and the wg_ip ledger, verification checklist, the §2.3 never-list verbatim) | Dry-run onboarding of the first owner-approved host (OQ-5) end-to-end by following ONLY the runbook: labeled series arrive, disk rules match the host, `docker ps -a` diff on the target box shows exactly ours | MSO-01, OQ-1/OQ-5 |
| **MSO-04** | senior-db · seat default | `infra_hosts` migration + seed (§3.1) — global table, linter-clean, seed idempotent (`ON CONFLICT (key) DO UPDATE`) | Applies on a throwaway DB; `lint:withtenants` + `lint:migration-rls` green; re-running the seed churns nothing | — (parallel) |
| **MSO-05** | senior-be · **opus·medium** — per-field null-vs-zero discipline across ~12 fields and three upstreams (Prometheus, Alertmanager, DB) is exactly the class this estate has repeatedly shipped wrong; a re-run costs more than starting strong | Estate snapshot per contract §20.1a: `by (host)` aggregate queries (O(signals), never O(hosts×signals)), freshness state machine, Alertmanager v2 client + `ALERTMANAGER_URL` config, `withGlobal` inventory join, unregistered/never-reported surfacing, legacy fields kept for one release (expand phase) | Every §20.1a field note satisfied against a live probe; unit tests mock empty vectors and assert **no field ever coerces to 0**; `app.inject` suite over the endpoint; contract §20.1a rows flipped to 🟡/✅ only by QA | MSO-01, MSO-04 |
| **MSO-06** | medior (senior-fe reviews) · seat default | Console UI: estate board grouped by env, freshness as the lead cell, stale-greying ("as of Xm ago"), unavailable-with-reason blocks, unregistered/never-reported visibly abnormal, decommissioned muted, `RemoteWriteStalled` rendered as the whole-board banner; `lib/observability.ts` mirrors §20.1a | Driven in a browser against the live BE; a dark host demonstrably cannot render green; dark-theme + responsive from first commit | MSO-05 |
| **MSO-07** | qa · seat default | Adversarial pass: stop the agent on a non-prod host → console `dark` ≤ 12 m and `RemoteWriteStalled` fires; mock-empty-Prometheus null audit (zero coerced 0s); inject an unlabeled/unknown-host series → unregistered row appears; AM down → `alerts:null` + reason; measured-zero case (0 firing alerts ≠ null) renders distinctly | All five drills pass **driven through the real surface**, screenshots/logs attached to the ticket | MSO-03, MSO-05, MSO-06 |
| **MSO-08** | devops · seat default (repeat per host) | Onboard each remaining owner-approved host per runbook; add its `infra_hosts` row (status → active) | Console row `fresh`; disk rules verified matching the host's series via promtool test (never by filling a real disk); box-owner rules obeyed (`docker ps -a` diff) | MSO-03, OQ-1 |

**Status update (2026-08-21, MSO-05 ticket close-out):** MSO-04 and MSO-05 above both moved to
🟡 PROTOTYPED in the same pass — MSO-04's `infra_hosts` table did not exist when MSO-05 started, and
MSO-05 cannot satisfy its own "expected-but-dark hosts must appear" acceptance criterion without it
(§3.1's own opening line), so MSO-05 built MSO-04's migration verbatim rather than blocking on a
separate ticket, per this doc's own §3.1 fallback clause. `estate-observability.ts` (pure
freshness/null-vs-zero logic) has 31/31 unit tests green with no infrastructure; the `app.inject`
suite (`observability-estate.db.test.ts`) has 8/8 green against a real Postgres + Cerbos +
stubbed Prometheus/Alertmanager. Neither ticket is DEV-VERIFIED against the LIVE remote Prometheus
end-to-end yet (that needs a live `ALERTMANAGER_URL` deploy value and a platform restart) or
consumed by a UI (MSO-06, separate ticket, separate session) — hence PROTOTYPED, not further.
Contract deviations found while building (the `alerts` field-name collision in §20.1a's own text,
Alertmanager fetched independently of Prometheus, the still-single-host disk alert rules) are
recorded in `docs/FRONTEND-BFF-CONTRACT.md` §20.1a notes 8–12, not here — that file is the contract
of record.

Critical path: **MSO-00 → MSO-01 → MSO-05 → MSO-06 → MSO-07**, with MSO-03/04 in parallel after
MSO-01/—. Highest value per unit of effort: **MSO-00** (stops active waste and lies today) and
**MSO-01** (unblocks everything multi-host).

---

## 10. Owner questions (genuinely owner-level; everything else is decided above)

1. **OQ-1 — Which servers, and what is each?** Known candidates from the operator ssh config:
   `aire-vps` (43.165.196.80), `gda-ai01` (34.143.206.68, the OpenClaw host), `gda-ce01`
   (34.158.47.112, **98 % disk — most urgent candidate**). Confirm env (production/staging/ops/dev)
   and role for each, and name any staging boxes not yet in ssh config ("lots of servers" implies
   more than we can see). `delphi`/`helios` are treated as permanently out of scope — confirm.
2. **OQ-2 — Paging policy by environment — ANSWERED 2026-08-21 (owner: "use the best way n
   safest").** **PRODUCTION pages** (current transports, unchanged). **staging/dev/ops are
   ticket-only** — never a page. Rationale, written down because it is the whole point of the
   ruling: alert fatigue IS the failure mode that makes real pages get ignored. A staging box waking
   someone at 3am does not make the estate safer — it trains the responder to treat the pager as
   noise, which is precisely how a genuine production page gets snoozed. Routing is by the `env`
   label MSO-01 landed (§4), so one rule file keeps covering every host regardless of environment —
   the routing tree branches on `env`, the rules themselves stay env-agnostic. This is now MSO-02's
   acceptance criterion, not an open question: `amtool config routes test` must show production ⇒
   page transports, staging/dev/ops ⇒ ticket-only receiver, for every env value in the CHECK
   constraint on `infra_hosts.env`.
3. **OQ-3 — Hub blast-radius acceptance — ANSWERED 2026-08-21: ACCEPT peer-per-host.** The
   mitigation is already load-bearing in the design (§2.2): every spoke's `AllowedIPs` is
   `10.88.0.2/32` **only**, so an onboarded host can reach the hub and reach nothing else on the
   mesh — a compromised spoke cannot pivot to another spoke, by construction, regardless of how many
   peers the hub accumulates. **Revisit trigger, recorded so this isn't re-litigated per host:** if
   the fleet outgrows a handful of hosts, move the hub to a dedicated box rather than keep widening
   the peer list on the box that also carries the owner's private production. Until that trigger
   fires, each onboarding (MSO-08) adds one peer entry on SumoPod as standing policy — not a
   one-off exception each time.
4. **OQ-4 — Confirm no-Tailscale — ANSWERED 2026-08-21: STAYS REJECTED.** Fewer external
   dependencies and no third-party control plane on hosts this program does not fully own (SumoPod
   carries the owner's private production; `aire-vps`'s ownership status is still unresolved per
   OQ-1). Spend for the whole design **as ratified: zero** (no new boxes, no SaaS) — Tailscale would
   have been the one line item that could have changed that, and it is exactly the item this answer
   removes. Reversible later at zero sunk cost if the fleet's ops posture ever changes; not
   revisited absent that.
5. **OQ-5 — First onboarding target** — ANSWERED 2026-08-21: NOT `gda-ce01`, which the owner has ruled out of scope entirely. Dry-run the runbook on `gda-aicenter` (already instrumented, and the box we can afford to be wrong about) BEFORE touching the live estate. The superseded recommendation read: `gda-ce01` — it is
   the box most likely to fill a disk unobserved, so it buys the most safety per hour of work.

---

## 11. Provenance

Every row in §1 was probed live on 2026-08-21 over `ssh gda-aicenter` (read-only) and, for the
remote store/Alertmanager, via `curl` from that box across the WireGuard tunnel — the same path the
platform console uses. Repo claims are read from the files named inline at commit `dd89e0e`. Nothing
in this document has been executed; no server state was mutated.
