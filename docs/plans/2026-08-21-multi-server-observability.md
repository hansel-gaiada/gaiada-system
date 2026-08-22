# Multi-server Plane A observability (MSO)

**Date:** 2026-08-21 · **Status:** IN PROGRESS — MSO-00/01 DEV-VERIFIED live; MSO-02 (per-host
alerts + env routing) PROTOTYPED — promtool/amtool-verified against the remote and against a live
true condition, NOT YET DEPLOYED to the remote box (see §8 status note); MSO-04 (`infra_hosts`)
and MSO-05 (estate endpoint) PROTOTYPED, backend only, unit + live-DB tested, not yet consumed by a
UI; OQ-2/3/4 ANSWERED below (§10); MSO-03/06/07/08 still PLANNED; **2026-08-22 owner ruling
(§12): `helios`/`delphi` are OBSERVE-ONLY — agent onboarding prohibited; MSO-03/08 amended,
MSO-09/10/11 added (PLANNED)** ·
**Owner ask:** "we need to see more servers in there. we are having lots of servers for staging,
production etc." — the ERP's Systems → Observability console must become a multi-host,
multi-environment view.
**2026-08-22 (later, same day):** owner named fleet roles — `delphi`=STAGING, `helios`=PRODUCTION,
`wp hostinger`=the WordPress-projects host; all three host **web projects the agency builds for
clients**, not our own ERP infra — and reframed observe-only as a **timing** choice, not a
permission ceiling ("we will set it up when we are ready"); `gda-aicenter`+`sumopod` (the ERP's own
servers) are slated for future consolidation onto one box (noted, not designed). Options analysis
for zero-touch signal sources (CloudPanel / Hostinger / underlying provider) plus how this joins the
IT device topology and a future Network page: **§13–§15**. §12 and OQ-6/7/8 amended in place below.
**2026-08-23 owner ruling (§16): the monitoring IA is THREE SEPARATE PAGES** — servers
(`/systems/observability`), devices (the existing `/it/topology`), network (`/it/network`, does not
exist yet). MSO-17 AMENDED in place, MSO-19–22 + OQ-9/10 added, the Network page fully specified
in §16. Binding cross-reference: `docs/blueprints/monitoring-program.md` §9.
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
6. **Scope ruling 2026-08-22 (owner), superseding part of this design:** `helios` and `delphi`
   are **OBSERVE-ONLY** — we may collect information FROM them; we may NOT install, configure,
   restart, or modify anything ON them. Installing node-exporter or an OTel collector IS a
   modification, so the §2 agent bundle is out of scope for these two hosts. "Full control"
   (MSO-03 onboarding) applies only to production hosts we fully own. Design, signal matrix,
   schema change, and tickets: **§12**.

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
| Known ssh estate on the operator machine | `~/.ssh/config` | `gda-aicenter`, `sumopod`, `aire-vps`, `gda-ai01`(+`gda-tunnel`, same IP), `gda-ce01`, `delphi`, `helios`. **CORRECTED 2026-08-21 by owner decision:** `delphi` and `helios` ARE the owner's and ARE authorized onboarding targets — an earlier session had them on a never-touch list believing they belonged to another company, and that belief was wrong. They are LIVE, so they wait for the MSO-03 runbook. **SUPERSEDED IN PART 2026-08-22 (owner, §12):** the ownership correction stands; the authorization does not — `delphi`/`helios` are now **OBSERVE-ONLY**, no longer onboarding targets for MSO-03/08. **`gda-ce01` is OUT OF SCOPE** — owner: "we shouldnt have anything to do with gda-ce01" |

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
- **CORRECTED 2026-08-22 (owner):** `delphi` and `helios` **are the owner's** — `delphi` is the
  **staging** server for all projects, `helios` is **production**. The previous never-touch claim
  here was wrong and contradicted §1 of this same document; it has been removed rather than left
  to be re-derived. **SUPERSEDED LATER THE SAME DAY — 2026-08-22 owner ruling (§12):** an earlier
  version of this correction went on to say they "are authorized onboarding targets and wait for
  the MSO-03 runbook". That authorization is now REVOKED: *"for now we shouldnt do anything to
  helios or delphi. we just want to have informations from it not actively control or modify it.
  full control is for production."* They are **OBSERVE-ONLY** — collect information FROM them,
  never install/configure/restart/modify anything ON them; the agent bundle, a WireGuard
  peer/keypair, and any `authorized_keys` change are all modifications and are out of scope for
  these two hosts. §12 designs the agentless tier that watches them instead.
  **The opt-in rule still stands and is unrelated to ownership:** the inventory is explicit opt-in;
  nothing may enumerate `~/.ssh/config` or scan `10.88.0.0/24` to "discover" hosts. `gda-ce01`
  remains OUT OF SCOPE.
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
| **MSO-03** | devops · seat default | Agent bundle `docker-compose.obs-agent.yml` + collector template + `infra/runbooks/onboard-server.md` (wg peer procedure incl. hub-side commands and the wg_ip ledger, verification checklist, the §2.3 never-list verbatim) — **AMENDED 2026-08-22 (§12):** `helios`/`delphi` are no longer eventual targets of this runbook (observe-only); runbook §0/§1/§2/§6/§9 updated with the dated reversal | Dry-run onboarding of the first owner-approved host (OQ-5) end-to-end by following ONLY the runbook: labeled series arrive, disk rules match the host, `docker ps -a` diff on the target box shows exactly ours | MSO-01, OQ-1/OQ-5 |
| **MSO-04** | senior-db · seat default | `infra_hosts` migration + seed (§3.1) — global table, linter-clean, seed idempotent (`ON CONFLICT (key) DO UPDATE`) | Applies on a throwaway DB; `lint:withtenants` + `lint:migration-rls` green; re-running the seed churns nothing | — (parallel) |
| **MSO-05** | senior-be · **opus·medium** — per-field null-vs-zero discipline across ~12 fields and three upstreams (Prometheus, Alertmanager, DB) is exactly the class this estate has repeatedly shipped wrong; a re-run costs more than starting strong | Estate snapshot per contract §20.1a: `by (host)` aggregate queries (O(signals), never O(hosts×signals)), freshness state machine, Alertmanager v2 client + `ALERTMANAGER_URL` config, `withGlobal` inventory join, unregistered/never-reported surfacing, legacy fields kept for one release (expand phase) | Every §20.1a field note satisfied against a live probe; unit tests mock empty vectors and assert **no field ever coerces to 0**; `app.inject` suite over the endpoint; contract §20.1a rows flipped to 🟡/✅ only by QA | MSO-01, MSO-04 |
| **MSO-06** | medior (senior-fe reviews) · seat default | Console UI: estate board grouped by env, freshness as the lead cell, stale-greying ("as of Xm ago"), unavailable-with-reason blocks, unregistered/never-reported visibly abnormal, decommissioned muted, `RemoteWriteStalled` rendered as the whole-board banner; `lib/observability.ts` mirrors §20.1a | Driven in a browser against the live BE; a dark host demonstrably cannot render green; dark-theme + responsive from first commit | MSO-05 |
| **MSO-07** | qa · seat default | Adversarial pass: stop the agent on a non-prod host → console `dark` ≤ 12 m and `RemoteWriteStalled` fires; mock-empty-Prometheus null audit (zero coerced 0s); inject an unlabeled/unknown-host series → unregistered row appears; AM down → `alerts:null` + reason; measured-zero case (0 firing alerts ≠ null) renders distinctly | All five drills pass **driven through the real surface**, screenshots/logs attached to the ticket | MSO-03, MSO-05, MSO-06 |
| **MSO-08** | devops · seat default (repeat per host) | Onboard each remaining owner-approved host per runbook; add its `infra_hosts` row (status → active) — **AMENDED 2026-08-22 (§12):** candidate universe excludes `helios`/`delphi` (observe-only) as well as `gda-ce01`; remaining candidates are whatever OQ-1 approves (`aire-vps`, `gda-ai01`, unnamed staging boxes) | Console row `fresh`; disk rules verified matching the host's series via promtool test (never by filling a real disk); box-owner rules obeyed (`docker ps -a` diff) | MSO-03, OQ-1 |

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

**2026-08-22:** the observe-only ruling adds **MSO-09/10/11** and amends MSO-06/07 — ticket
table in §12.6; those tickets do not sit on this critical path, but MSO-11 is the only route to
any visibility of `helios`/`delphi` at all.

---

## 10. Owner questions (genuinely owner-level; everything else is decided above)

1. **OQ-1 — Which servers, and what is each?** Known candidates from the operator ssh config:
   `aire-vps` (43.165.196.80), `gda-ai01` (34.143.206.68, the OpenClaw host), `gda-ce01`
   (34.158.47.112, **98 % disk — most urgent candidate**). Confirm env (production/staging/ops/dev)
   and role for each, and name any staging boxes not yet in ssh config ("lots of servers" implies
   more than we can see). `delphi`/`helios`: this question's original "permanently out of scope —
   confirm" was corrected twice; final state (owner ruling 2026-08-22, §12): they are the owner's
   boxes and are **OBSERVE-ONLY** — never onboarding targets, watched via §12's blackbox tier.
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
6. **OQ-6 — Probe list for `helios`/`delphi` (blocks MSO-11).** Name the endpoints we should
   probe on each — URLs and/or ports (e.g. "https://<site> served from helios", "tcp/22",
   "ICMP"). We will NOT port-scan or crawl to discover services — the §2.3 opt-in rule applies
   to probes exactly as it applies to agents; an unnamed service simply stays invisible, and
   §12.3's console will honestly show only what you name. Also confirm ICMP is acceptable
   (some providers rate-limit or flag it).
   **AMENDED 2026-08-22 (later, same day):** still open, still blocking MSO-11 — this pass did not
   name a probe list (that would require the owner or would require crawling, which is exactly the
   opt-in rule this OQ itself protects). What changed is confidence about WHO answers ICMP/TCP/HTTP
   probes of these two hosts at all: passive lookup (§13(c)) places both `helios` and `delphi` on
   Hostinger's own network, which is consistent with, but does not replace, the owner naming actual
   endpoints.
7. **OQ-7 — Read-only SSH polling: NOT adopted; you may override (§12.2 has the full trade).**
   Architect recommendation is NO: the safe form (dedicated user + forced-command key) requires
   modifying `authorized_keys` ON the host — prohibited by your own ruling — and the unsafe form
   (reusing your personal key from the hub) hands whoever compromises the hub a shell on your
   production. Cost of NO, stated honestly: disk/memory/CPU/reboots on `helios`/`delphi` stay
   UNKNOWN — nobody will see a disk filling there. If you want that visibility before granting
   full control, say so explicitly and we design the forced-command variant as a one-time,
   owner-authorized modification.
   **AMENDED 2026-08-22 (later, same day, per §12.0):** the recommendation stays NO **for now** —
   nothing here withdraws the "prohibited for now" ruling. What changes is that the honest cost above
   may be smaller than it reads: §13(b) found evidence (passive lookup, not host contact) that
   `helios`/`delphi` likely sit on Hostinger's own VPS product, which — if confirmed — exposes
   CPU/RAM/disk/network/uptime through Hostinger's own API with **zero host contact of any kind**,
   recovering most of the disk/memory/CPU blindness this OQ describes **without** the credential
   trade-off SSH-polling forces. See §13 for the full trade (a Hostinger API token is not
   read-only-scoped either, so it is not a free lunch — just a different, possibly smaller, blast
   radius than a shell credential). This OQ (self-execute a command on the box) stays closed; §13's
   provider-API path is evaluated as its own option, not as a variant of this one.
8. **OQ-8 — Zero-touch side channels for `helios`/`delphi`.** (a) Who hosts each box, and does
   the provider's panel expose a read-only metrics/status API (CPU/RAM/disk) we may consume from
   the hub with a scoped token? That would recover some of §12.4's UNOBTAINABLE column without
   touching the hosts. (b) Do the boxes already expose any status/metrics endpoint you know of
   that we may read? We will not probe to find out.
   **ANSWERED IN PART 2026-08-22 (later, same day) — see §13 for the full analysis.** (a) Passive,
   no-host-contact lookup (WHOIS/ASN/rDNS via third-party registries — zero packets to `helios` or
   `delphi` themselves) places both on ASN AS47583 ("Hostinger International Limited") with
   `srv####.hstgr.cloud` reverse DNS — Hostinger's own default hostname pattern for its KVM VPS
   product. High confidence this means Hostinger IS the underlying provider (not a reseller of a
   further hypervisor), **not confirmed by the owner**. If confirmed, Hostinger's own public API has
   a documented `VPS.getMetricsV1` endpoint (CPU/RAM/disk/network/uptime) — see §13(b) for the token
   scoping caveat before treating this as free. (b) "Cloud panel" is very likely `cloudpanel.io`
   (CloudPanel CE) self-installed on the VPS — common on Hostinger KVM VPS — but it has **no official
   REST API** (confirmed via CloudPanel's own feature-request board: a "Panel REST API" is requested,
   not shipped) and no documented metrics CLI subcommand; only a human dashboard behind a login whose
   blast radius is the whole box. Still open: which Hostinger account each of `helios`/`delphi`/
   `wp hostinger` sits under (one token vs three), and each host's actual plan tier.

---

## 11. Provenance

Every row in §1 was probed live on 2026-08-21 over `ssh gda-aicenter` (read-only) and, for the
remote store/Alertmanager, via `curl` from that box across the WireGuard tunnel — the same path the
platform console uses. Repo claims are read from the files named inline at commit `dd89e0e`. Nothing
in this document has been executed; no server state was mutated.

---

## 12. 2026-08-22 owner ruling: `helios`/`delphi` are OBSERVE-ONLY — the agentless tier

**Ruling (owner, 2026-08-22, verbatim):** *"for now we shouldnt do anything to helios or delphi.
we just want to have informations from it not actively control or modify it. full control is for
production."*

**Binding interpretation.** `helios` and `delphi` are **observe-only**: we may collect information
FROM them; we may NOT install, configure, restart, or modify anything ON them. Installing
node-exporter or an OTel collector IS a modification — so the §2 agent bundle, a WireGuard
peer/keypair, and everything in the MSO-03 runbook are **out of scope for these two hosts**.
"Full control" (the agent path) applies only to production hosts we fully own — today
`gda-aicenter` and `sumopod`. This supersedes, as of 2026-08-22: §1's "authorized onboarding
targets" row, §2.3's same-day ownership correction (ownership stands; authorization does not),
MSO-03's eventual-target list, and MSO-08's candidate universe. It does NOT reopen: `gda-ce01`
(fully out of scope, unchanged), the Hostinger WP host (shared hosting — already Plane B, never
an agent candidate), or the opt-in/no-scan rule (which applies to probes exactly as it applied to
agents).

**Graduation path, recorded so it is not re-litigated ad hoc:** when the owner later grants full
control over a host, that is a NEW dated ruling; the host then goes through MSO-03 unchanged
(`infra_hosts.monitoring_tier` flips `blackbox` → `agent`; the probes stay — they remain useful
under the agent tier).

### 12.0 2026-08-22 (later, same day) — reframed: a timing choice, not a permanent ceiling

**Owner, verbatim:** *"we want full detail on the servers and we will set it up when we are ready."*
Full-detail (agent tier) is the **intended destination** for every server the agency operates,
including `helios`/`delphi`; blackbox is the **interim** state while the owner schedules the work,
not a permanent architectural boundary. This changes nothing structural in §12.1–§12.6 below — agent
installation on `helios`/`delphi` stays PROHIBITED **for now**, the CHECK constraint in §12.5 stays
fail-closed, the runbook's never-touch list stays in force — but it changes the question this
section exists to answer: no longer *"may we ever see more than a probe?"* (yes, later, on the
owner's schedule) but **"what is the cheapest safe path to full detail, and what do we get for free
in the interim, without installing anything or touching the host?"** §13 answers that with an
options analysis; §15 turns it into tickets.

**Also ratified this pass — fleet roles and a planned consolidation, not designed here:**
`delphi` = STAGING, `helios` = PRODUCTION, `wp hostinger` = the WordPress-projects host; all three
are the agency's OWN servers (not a third party's — the 2026-08-21 ownership correction in §1/§2.3
stands) and all three host **web projects the agency builds for clients** — i.e. they are Plane A
boxes (our infrastructure) that carry Plane B payloads (clients' websites). §14 works out what that
means for the UI. Separately, `gda-aicenter` and `sumopod` (the ERP's own servers, both `agent` tier
today) are slated to be **consolidated onto one server** — the owner's plan, not this program's.
That has monitoring implications this doc records but does not design: today's hub-and-spoke
(§2, hub = `sumopod`) and the `infra_hosts` rows for both boxes assume two independent hosts, and a
merge would retire or repurpose one row, potentially relocate the WireGuard hub (the OQ-3 revisit
trigger — "if the fleet outgrows a handful of hosts, move the hub" — anticipates hub relocation for
growth, not for a merge down to one box, so this is a new case for whoever plans it) and needs a
decision on whether pre-merge history for the retired host's series stays queryable. Tracked as
MSO-18 (§15), blocked on the owner naming a timeline — **do not design the consolidation itself**,
per this pass's own instructions.

### 12.1 Agentless options, honestly

| Option | What it actually yields | What it costs / risks | Verdict |
|---|---|---|---|
| **(a) Blackbox probing from the hub** — ICMP/TCP/HTTP(S)/TLS probes of owner-named endpoints; blackbox exporter in the `gaiada-obs` project on SumoPod, scraped by the hub Prometheus | Reachability per endpoint, TCP/HTTP latency from our estate, HTTP status + body match on named URLs, TLS cert expiry. Genuinely zero-touch: the host sees ordinary network requests | One new container on the hub (scoped `-p gaiada-obs`; `cap_add: NET_RAW` only if ICMP is wanted). Tells us NOTHING about the inside of the box | **✅ ADOPTED — the observe-only tier** |
| **(b) Read-only SSH polling** — an exporter on OUR side running `df`/`free`/`uptime` over SSH | Disk, memory, load, uptime — the internals (a) cannot see | Requires a standing credential on our hub that can execute commands on the owner's production; the safe setup itself modifies the host. Full trade in §12.2 | **❌ NOT ADOPTED** (owner may override — OQ-7) |
| **(c) Consume something already exposed** — an existing metrics/status endpoint, or the hosting provider's metrics API | Provider APIs often expose CPU/RAM/disk-ish gauges with zero host contact; an existing endpoint costs nothing | Existence unknown — and we may not probe or scan to find out. Needs owner answers (OQ-8) | **OPEN — adopt if OQ-8 yields anything** |

Probes originate from the **hub (SumoPod)**, not from `gda-aicenter`: watching the rest of the
estate must not fate-share with the most complex monitored host, and the hub Prometheus scrapes
the exporter locally (no remote_write leg to break). The existing `gda-aicenter` blackbox exporter
keeps its WS9 job — synthetic probes of the ERP's own endpoints — different purpose, different job
name (`blackbox-estate` is the new hub job). Observe-only hosts NEVER join the WireGuard mesh: no
peer, no keypair, nothing — mesh membership requires a spoke config on the host, which is itself a
modification, and the mesh is the full-control tier's transport.

### 12.2 The SSH-polling ruling, with the security trade stated honestly

**Is running read-only commands over SSH a "modification"?** Strictly, no: `df`/`free`/`uptime`
change no config, install nothing, restart nothing — it is information-gathering, plus auth-log
entries on their side. It is still NOT adopted, for two reasons that are about *capability*, not
semantics:

1. **The safe form requires the forbidden act.** A credential fit for unattended polling is a
   dedicated user, or a forced-command `no-pty` key in `authorized_keys` restricted to one fixed
   read-only script. Creating either **is editing files on the host** — a modification,
   prohibited. There is no way to stand up constrained SSH polling without first touching the box.
2. **The unsafe form manufactures exactly the capability the owner just withdrew.** Skipping that
   setup means reusing the operator's personal full-shell key from the hub. Then whoever
   compromises SumoPod — a box that also carries the owner's private production and our whole obs
   stack — gains **interactive shell on `helios` (the owner's production) and `delphi`**. Today a
   hub compromise yields metrics disclosure and one outbound wg route per spoke; with a stored key
   it yields command execution on two more boxes. A standing remote-execution credential IS
   "control", regardless of what the polling script happens to run.

**So: not adopted.** The honest cost: disk/memory/CPU/reboots on these two hosts stay UNKNOWN —
on an estate whose worst recorded incidents are silent disk fills, nobody will see a disk filling
on `helios`. That blindness is rendered as blindness (§12.3), never as green. If the owner wants
those signals before granting full control, the least-bad path is the forced-command variant as a
one-time, explicitly owner-authorized modification — his call (OQ-7), recommendation NO.

### 12.3 The honesty requirement — how an observe-only host renders

An observe-only host has a structurally smaller signal set. The console MUST NOT render that as
health. A host we can only probe is **"reachable — internals unknown"**, never "healthy". This
estate has shipped absence-as-green 8+ times; the tier exists so absence can be typed. Three
distinct facts, never collapsed: **measured** (a value), **expected-but-missing** (a fault —
alarming), **not-collected-for-tier** (by design — calm, but explicitly not knowledge).

- **`infra_hosts.monitoring_tier`** (§12.5) tells the API which signals are *expected* per host,
  so an absent signal stops being ambiguous: absence of node metrics on a `blackbox` host produces
  ZERO fault indications; the identical absence on an `agent` host stays alarming.
- **Contract §20.1a gains an addendum (note 13, the contract file is the file of record):**
  `HostSnapshot.tier`; a `probes` block (per-target `probe_success`, latency, TLS expiry) as the
  observe-only tier's primary signal; `estate.hosts.byTier`. For `tier:"blackbox"` hosts,
  `host`/`targets`/`datastores` are `null` and `containersRunning` carries a tier-reason note —
  rendered as "not collected (observe-only)", a THIRD visual state distinct from both the
  dark-host treatment (expected signals stopped) and healthy.
- **Reachability is `probe_success` only — never `up`.** The `up` series of a blackbox scrape job
  measures the EXPORTER answering the hub, so it stays `1` while the probed host is down; deriving
  reachability from it would render a dead host green forever. This is the probe tier's version of
  "a green scrape target means the exporter answered" (monitoring program §2.7), and it is the
  trap MSO-10's unit tests must pin. `freshness` for a probe-fed host means exactly "probe results
  are arriving" (pipeline liveness) — a host can be `fresh` and unreachable at once, and that must
  render as DOWN, not calm.
- The strongest state an observe-only host can reach on the board: **"reachable, cert OK, N/N
  probes passing — internals unknown (observe-only)"**. It must be impossible to read disk or
  memory health into that row, and impossible to confuse it with a full-signal green host.
- **Alerting:** `EstateProbeDown` (`probe_success == 0`) rides the existing OQ-2 env routing —
  `helios` (`env=production`) pages, `delphi` (`env=staging`) tickets. A page we cannot "fix" is
  still the owner learning his production is unreachable, which is the entire point of this tier.
  The generalized §8 freshness alert already covers a stalled probe *pipeline* (hub-side failure)
  because probe series carry `host`/`env`; its description must say "signal feed stopped" —
  wording honest for both tiers (MSO-11 adjusts wording only, not shape).

### 12.4 Signal matrix — what each tier can and cannot see

| Signal | agent tier (`gda-aicenter`, `sumopod`) | blackbox tier (`helios`, `delphi`) | ssh-poll (NOT adopted) | provider API (if OQ-8 yields one) |
|---|---|---|---|---|
| Reachability from our estate | implied by the feed | ✅ `probe_success` per named endpoint | ✅ | sometimes (status page) |
| Latency (ICMP/TCP/HTTP) | ~ (app-level only) | ✅ `probe_duration_seconds` | crude | ✗ |
| HTTP status / body match | ✅ (WS9 synthetic, own endpoints) | ✅ owner-named URLs only | ✅ | ✗ |
| TLS cert expiry | ✅ | ✅ | ✅ | ✗ |
| Disk used/free + fill projection | ✅ | ✗ **UNOBTAINABLE** | ✅ (`df`) | often (coarse gauge) |
| Memory | ✅ | ✗ **UNOBTAINABLE** | ✅ (`free`) | often |
| CPU / load | ✅ | ✗ **UNOBTAINABLE** | ✅ (`uptime`) | often |
| Uptime / silent reboots | ✅ | ✗ (only outages we happened to probe through) | ✅ | sometimes |
| Container / process state | ✅ pending MON-09n | ✗ **UNOBTAINABLE** | partial — needs docker-group, a bigger grant | ✗ |
| Datastore health (`pg_up`-class) | ✅ | ✗ **UNOBTAINABLE** | awkward | ✗ |
| Logs / traces | optional agent legs | ✗ | ✗ (tailing = heavy foothold) | ✗ |
| Alertable conditions | full rule set | reachability, cert expiry, feed-stalled ONLY | — | — |

The **UNOBTAINABLE** column is the price of the ruling and is accepted; the console states it per
host rather than hiding it. No agentless mechanism recovers those signals — only an agent or
on-host command execution can.

### 12.5 Schema change (specified here; the migration is MSO-09's to write)

Timestamp-named migration on the pattern of `202608211610_mso04_infra_hosts.sql`, in this order:

1. `ALTER TABLE infra_hosts ADD COLUMN monitoring_tier text NOT NULL DEFAULT 'blackbox' CHECK
   (monitoring_tier IN ('agent','blackbox'))` — **fail-closed default**: a new row is observe-only
   until someone deliberately promotes it; a careless insert must never imply control. No third
   value until the owner sanctions one (ssh-poll, if ever approved, is a new CHECK value by
   migration — do not pre-create it).
2. `UPDATE infra_hosts SET monitoring_tier = 'agent' WHERE key IN ('gda-aicenter','sumopod')` —
   BEFORE step 3, so the new constraint cannot trip on a hand-set `wg_ip`.
3. `ALTER TABLE infra_hosts ADD CONSTRAINT infra_hosts_observe_only_off_mesh CHECK
   (monitoring_tier = 'agent' OR wg_ip IS NULL)` — the ruling as a structural invariant: an
   observe-only host can never hold a mesh address, so "add it to the mesh just for probing"
   fails in the database, not in a code review.
4. Seed `helios` (env `production`, role `owner-projects`, status `onboarding`, tier `blackbox`,
   `wg_ip` NULL) and `delphi` (env `staging`, otherwise identical), notes carrying the ruling
   verbatim with its date; `ON CONFLICT (key) DO UPDATE` idempotent like the MSO-04 seed.
   `status` flips to `active` only when MSO-11's probes are verified live — same discipline as
   the runbook's §7.
5. Column and constraint COMMENTs carry the ruling text and a pointer to this section.

The API derives *expected-but-missing vs not-expected* from `monitoring_tier` — the tier is data,
so an absent signal is typed instead of ambiguous. Probe target lists (which URLs/ports per host)
stay CONFIG in `infra/observability/` keyed by `infra_hosts.key`, shipping with the obs stack like
every other scrape config; every probed key MUST have an inventory row, and §3.2's
unregistered-host surfacing already catches the drift if one doesn't.

### 12.6 Tickets added/amended (numbering continues §9's; seat default unless flagged)

| # | Tier · model | Scope | Done when | Depends on |
|---|---|---|---|---|
| **MSO-09** | senior-db · seat default | §12.5 migration: `monitoring_tier` (fail-closed default), off-mesh CHECK, promote the two agent hosts, seed `helios`/`delphi` observe-only rows | Applies on a throwaway DB; `lint:withtenants` + `lint:migration-rls` green; seed idempotent (re-run churns nothing); inserting a `blackbox` row with a `wg_ip` FAILS | — (parallel) |
| **MSO-10** | senior-be · **opus·medium** — the measured / expected-missing / not-collected-for-tier tri-state plus the `up`-vs-`probe_success` trap is exactly the absence-as-green class this estate has shipped 8+ times; one wrong coercion silently renders an unwatchable host healthy | Estate API tier-awareness per contract §20.1a note 13: `tier` field, `probes` block (`probe_success`/`probe_duration_seconds`/`probe_ssl_earliest_cert_expiry` by `host`), per-tier expected-signal derivation, `estate.hosts.byTier`, tier-reason notes on not-collected fields; reachability NEVER derived from `up` | Unit tests pin: all-probes-green `blackbox` host is not representable as agent-green; `probe_success=0` + fresh pipeline ⇒ unreachable-and-fresh renders DOWN; absent node signals alarm on `agent` tier and produce zero fault indications on `blackbox` tier; `app.inject` suite green | MSO-09 (build against stubs; live verification needs MSO-11) |
| **MSO-11** | devops · seat default | Hub-side prober: blackbox exporter container in `gaiada-obs` on SumoPod (scoped `-p`, publishes nothing, `NET_RAW` only if ICMP wanted), `blackbox-estate` scrape job with per-target `host`/`env` labels for OWNER-NAMED endpoints only (OQ-6); alerts `EstateProbeDown` (env-routed per OQ-2: helios pages, delphi tickets) + `TlsCertExpiringSoon` (ticket, ≤21 d); generalize the §8 freshness alert's description to "signal feed stopped" (tier-honest wording); coordinate with MSO-02's undeployed rule file so the box gets ONE reviewed rules deploy | Probes live for every OQ-6 endpoint; stopping the exporter turns both hosts `dark` ≤ 12 m and the feed-stalled alert fires; `amtool config routes test`: helios probe-down ⇒ page, delphi ⇒ ticket; `docker ps -a` diff on SumoPod shows exactly one added container | MSO-09, OQ-6; sequence with MSO-02's deploy |
| **MSO-06 (amend)** | medior (senior-fe reviews) · seat default | Console tier rendering: "Observe-only" badge; strongest-state copy "reachable — internals unknown"; not-collected-for-tier treatment distinct from BOTH the dark-host treatment and healthy; `probes` card (per-target state, latency, cert days); `byTier` in the estate strip; demo fixture gains an observe-only host exercising every branch | Fixture-driven: an all-green observe-only host is visually distinct from an all-green agent host; no rendering path shows disk/memory/containers for a `blackbox` host as anything but "not collected (observe-only)" | MSO-10 shape (fixtures may lead the backend) |
| **MSO-07 (amend)** | qa · seat default | Three added drills, driven through the real surface — NEVER against `helios`/`delphi` themselves: register a throwaway `blackbox` row probing a disposable target (a dead TEST-NET/RFC 5737 address for down; a controllable endpoint on `gda-aicenter` for up) | (i) target down ⇒ console shows unreachable and the alert routes by env; (ii) all-probes-green observe-only host never renders full-health; (iii) tier-absence produces no fault while agent-absence alarms; throwaway row removed afterwards | MSO-10, MSO-11, MSO-06 amend |

### 12.7 What was deliberately NOT done in the pass that wrote this section

Nothing was probed, pinged, or SSH'd — not `helios`, not `delphi`, not `gda-ce01`, not the live
estate. This section is design from repo + docs only. The first packet our estate ever sends
toward `helios`/`delphi` is MSO-11's, after OQ-6 names the targets.

---

## 13. 2026-08-22 (later, same day) — options analysis: zero-touch signal sources for `helios`/`delphi`/`wp hostinger`

**Method note, stated once so it is not repeated per row below:** everything in this section is
desk research — repo docs, this program's own prior findings, and passive third-party lookups
(WHOIS/ASN/reverse-DNS via public registries and route-collector mirrors) that send **zero packets
to `helios`, `delphi`, or the Hostinger WP host** — those queries go to registry/route-collector
servers, not to the target boxes, the same category of research as reading a vendor's own docs. No
host in the never-touch list was pinged, port-scanned, SSHed into, or authenticated against. Anything
below marked ⚠ **UNVERIFIED / GENERAL KNOWLEDGE** is not backed by a fetched primary source in this
pass — flagged that way deliberately, because §13(b)/(c) below feed a credential decision.

### 13(a) CloudPanel

**Is "cloud panel" cloudpanel.io, or the provider's own console? Genuinely ambiguous — not resolved
this pass.** Given §13(c)'s finding that both boxes sit on Hostinger's own network, the more likely
reading is literally `cloudpanel.io` (CloudPanel CE, the free open-source panel) self-installed on
the VPS — Hostinger's KVM VPS provisioning flow commonly offers CloudPanel as a one-click OS/app
template ⚠ **UNVERIFIED / GENERAL KNOWLEDGE, not confirmed for these two specific boxes**. The other
reading — the owner means Hostinger's own hPanel/"VPS panel" colloquially — is equally plausible from
the phrase alone. **First step: ask the owner for the login URL or a screenshot** (CloudPanel
defaults to `https://<ip-or-host>:8443`; hPanel is `https://hpanel.hostinger.com/...`) rather than
guess further.

| Question | Finding | Source / confidence |
|---|---|---|
| Does it expose an API? | **No official REST API.** CloudPanel ships a CLI (`clpctl`) but no HTTP API; a "Panel REST API" is an open, unbuilt feature request on CloudPanel's own board | `feature-requests.cloudpanel.io` (fetched via search), CloudPanel v2 docs (`root-user-commands`/`site-user-commands`, fetched via search snippets — the pages themselves 404'd on direct fetch in this pass, so the exact command list is not independently confirmed, only search-indexed excerpts of it) |
| Exportable stats / metrics endpoint? | None found. `clpctl` commands found (`user:add`, `db:backup`, `db:export`, `user:reset:password`, `cloudflare:update:ips`, `cloudpanel:enable:basic-auth`, `system:permissions:reset`) are site/user/db/security management, not a stats query | Same as above — a metrics subcommand may exist and simply wasn't in the indexed excerpts; treat "none found" as "none confirmed," not "confirmed absent" |
| What signals, what granularity? | CPU %, memory %, disk usage, load average (1/5/15m) on a **web dashboard graph** per CloudPanel's own marketing/tutorial pages | `cloudpanel.io/blog`, `/tutorial` pages ⚠ **GENERAL MARKETING CONTENT, not API/technical docs** — exact retention window and sampling interval not stated anywhere found |
| Credential + blast radius | The CLI (`clpctl`) requires **root SSH on the box** and can reset ANY panel user's password, manage every site/database, and toggle server-wide security settings. The web dashboard login is a CloudPanel account; if the owner's own super-admin login were reused for an unattended reader, the blast radius is functionally identical to the SSH case §12.2 already ruled out — a stolen credential controls every site and database on the box, not just a graph | Derived from confirmed `clpctl` command list above; the "reuse-personal-login" trap is this program's own §12.2 reasoning applied to a second credential type |
| Tri-state landing | `not-collected-for-tier` today (no machine feed exists to collect from) | — |

**Honest naming of the fragile option, because it would otherwise sound bright:** the dashboard *is*
a web page a logged-in browser renders from underlying HTTP calls, and in principle those calls could
be reverse-engineered and polled by a script holding the owner's login. **This is explicitly NOT
recommended.** It is an undocumented, unversioned internal endpoint with no stability contract; it
would need updating on every CloudPanel upgrade with no changelog to trigger the update; and it
requires standing use of the same credential class §13's blast-radius row just described. Naming it
here so nobody proposes it later as if it were a normal integration.

**Recommendation (a): do not invest here.** CloudPanel's sanctioned interface is a human dashboard
behind a credential that can reconfigure the whole box. If the owner specifically wants CloudPanel's
own numbers, the correct spend is watching/voting CloudPanel's own REST-API feature request, not
building a scraper against a moving target.

### 13(b) Hostinger

**Finding, passive lookup, not host contact (confidence: high but owner-unconfirmed):** both
`helios` (187.77.116.133) and `delphi` (72.61.142.88) resolve, via public WHOIS/ASN registries, to
**AS47583 "Hostinger International Limited"** (org "Hostinger Operations UAB"), and their
reverse-DNS names — `srv1700943.hstgr.cloud` and `srv1761905.hstgr.cloud` respectively — match
Hostinger's own default auto-assigned hostname pattern for its **KVM VPS** product. This is new
information this program did not have before: `helios` and `delphi` most likely run ON Hostinger's
own infrastructure, the same provider family as `wp hostinger`. **Not confirmed by the owner** — the
rDNS pattern is a strong but not certain signal (a custom hostname could coincidentally match, though
that is an unlikely coincidence for a Hostinger-specific domain). Confirm by checking whether all
three appear as line items in one Hostinger hPanel account.

| Question | Finding | Source / confidence |
|---|---|---|
| Does the API expose usage metrics? | **Yes, for VPS specifically.** Hostinger's public API (`developers.hostinger.com`, currently **BETA**, no stated SLA) documents `VPS.getMetricsV1(virtualMachineId, date_from, date_to)` returning CPU, memory, disk, network, and uptime | Hostinger's own docs/support pages (fetched) + the endpoint's own reference page (fetched via a third-party MCP-tool mirror of the same OpenAPI spec — secondary source, but describing Hostinger's own published schema) |
| Granularity / retention? | **Not found in this pass.** Neither source states sampling interval or max queryable range | Flagged UNKNOWN rather than guessed — would need an actual authenticated call to observe |
| What does the WP-hosting tier permit? | A `Websites` API endpoint exists (list/manage sites, filter by domain/status) but **no resource-usage-metrics endpoint was found for shared/managed hosting** comparable to the VPS one — the metrics endpoint found is explicitly scoped to VPS. Hostinger's own "resource usage" help pages for shared/Business/Agency plans describe a **human hPanel page only** (bandwidth, disk quota, CPU seconds — typical shared-hosting quota stats), with no confirmed API path | Search-indexed Hostinger support articles; **genuinely open** — if `wp hostinger` turns out itself to be a VPS (plausible now, given the ASN finding above applies to the same provider family), the VPS metrics API may apply to it too. Confirm plan tier before assuming either way |
| Credential + blast radius | **No read-only or per-resource scoping was found to exist.** Hostinger's own docs state a token "will have the same permissions as the owning user" — i.e., whatever the hPanel account itself can do: manage every VPS, every website, DNS, domains, and (unconfirmed but plausible) billing. Tokens *can* be set to expire, which bounds exposure over time but does not narrow *what* the token can do while live. This is a wide blast radius, structurally similar in kind (though narrower in immediate mechanism) to the SSH-key reuse trap §12.2 already ruled out — a stolen Hostinger token is not "read a graph," it is "everything the account owner can click in hPanel, plus API-only actions" | Hostinger's own support article on the API (fetched) |
| Tri-state landing | If adopted: `measured` for CPU/RAM/disk/network/uptime, landing under a **new** `monitoring_tier` value (§15, MSO-13) distinct from `blackbox` — it is not a probe, it is provider-reported telemetry, and conflating the two tiers would hide that the signal source is a third party's word, not our own measurement | — |

**Recommendation (b): this is the most promising interim answer found in this pass**, conditional on
two owner confirmations (below) and an explicit, eyes-open acceptance of the token's account-wide
blast radius — treat a Hostinger API token exactly as carefully as a root credential, never log it,
store it the way `CREDENTIALS.local.md`/secret patterns already require, and set an expiry.

### 13(c) The underlying cloud provider

**Answered, in effect, by (b).** The passive ASN/rDNS lookup places both hosts on Hostinger's own
network under Hostinger's own naming convention — there is no evidence of a distinct third-party
hypervisor provider "beneath" Hostinger to query separately (i.e., this does not look like Hostinger
reselling AWS/DigitalOcean/a hyperscaler's VPS product under the hood; industry-general knowledge is
that Hostinger operates its own infrastructure ⚠ **UNVERIFIED for this specific case, not re-derived
from a primary source in this pass**). So there is no additional hypervisor-level metrics API to chase
beyond Hostinger's own — §13(b) IS the answer to (c) as far as this research can reach.

**What cannot be determined without the owner:** (i) whether `helios`, `delphi`, and `wp hostinger`
sit under one Hostinger account or several (determines whether one token covers all three); (ii) each
host's actual plan/product tier (KVM VPS vs shared/managed WordPress hosting) — plan tier gates
whether `VPS.getMetricsV1` applies at all; (iii) whether Hostinger's account system offers any
reduced-privilege team member/sub-token role that would narrow the blast radius in 13(b) — nothing
found in this pass says yes or no, and it is worth asking Hostinger support directly rather than
inferring further from public docs.

### 13.1 Recommendation, first step

1. **Zero-cost, zero-risk first move:** ask the owner to confirm (i) which login "cloud panel" means
   (URL or screenshot) for `helios`/`delphi`, (ii) whether all three hosts are one Hostinger account,
   and (iii) each host's plan tier. Nothing below should be built before this, because it changes
   which of 13(a)/(b) even applies.
2. **If confirmed as Hostinger VPS:** mint one Hostinger API token (accepting 13(b)'s blast radius as
   a documented, deliberate risk — not a surprise later), call `VPS.getMetricsV1` for `helios`/
   `delphi` (and `wp hostinger` if it is also a VPS) from the hub on a schedule, feed the result into
   a **new** `monitoring_tier` value (§15, MSO-13/14) so the console never conflates provider-reported
   telemetry with our own probes or our own agent-collected metrics. This closes most of §12.4's
   UNOBTAINABLE column (disk/memory/CPU/uptime) for these hosts with **zero packets to the guest OS**
   — no SSH, no agent, no exporter — only ordinary HTTPS calls to Hostinger's own API, which is not
   "touching the host" any more than opening hPanel in a browser is.
3. **Do not build a CloudPanel scraper.** No official feed exists, and the credential available for
   it carries the same blast-radius class as SSH access.
4. **For `wp hostinger`, if it is confirmed genuinely shared hosting** (not a VPS): the ceiling stays
   the existing blackbox probe tier (MSO-11) plus the `Websites` API's non-metrics fields (enabled
   state, domain list) as cheap inventory metadata — not a performance signal. Revisit only if
   Hostinger's docs (or support) later confirm a resource-usage endpoint for that tier.

---

## 14. How this joins the existing surfaces — Plane A estate, IT device topology, and a future Network page

**The subtlest point in this whole design, named as such rather than glossed over.** The owner wants
"servers, tools, services, devices" all monitored, with devices on the existing topology surface and
network on its own page. Those words span **three different nouns that must not blur into one page**:

| Noun | What it is | Where it lives today | Scope |
|---|---|---|---|
| **Host** (`infra_hosts`) | A machine **we or a provider operate** — `gda-aicenter`, `sumopod`, and now `helios`/`delphi`/`wp hostinger` | Plane A estate view, MSO-05/06 (`/systems/observability`) | Staff-only (`isElevated`), **non-tenant** |
| **Device** (`it_devices`/`it_device_links`) | A piece of hardware **inside a tenant's own office** — a switch, an AP, a printer, a CCTV camera, a workstation | IT department's existing device registry + topology (`platform-nest/src/modules/it/`, `/it`) | **Tenant-scoped** (RLS on `tenant_id`), Cerbos resource `device` — a sellable ERP department feature, not "our infra" in the Plane A sense even when the tenant happens to be GDA itself |
| **Property/monitor** (`search_properties`, future `monitors`) | A **client's website or service being watched for uptime** | Plane B, `docs/blueprints/monitoring-program.md` §3 (`/monitoring`, staff cross-client board; `/portal/status`, client-facing) | Tenant **and** client scoped (RLS), sellable, Cerbos-gated |

None of these three should merge, and none of the three pages should try to render another's noun.
The IT device/topology page already exists and needs no change here — it is a tenant's own office LAN,
untouched by this program. A new **Network** page, per the owner's ask that network get its own page,
belongs in the **same tenant-scoped IT department** as an extension of that noun — a subnet/VLAN/
WAN-uplink/AP-level view layered over the device inventory (e.g. `/it/network`), not a Plane A page.
**It must not become the place `helios`/`delphi`/`wp hostinger` get rendered** — that is the single
easiest way to accidentally blend "our office WAN" with "the internet-facing hosting network our
clients' sites live on," which is exactly the Plane A/B merge this program is bound never to do
(monitoring-program.md §0). The IT department's own design of that page (including whatever the
office-network-and-it-discovery-gap UniFi integration ends up needing) is out of scope for this
integrator doc beyond flagging that boundary. **SUPERSEDED 2026-08-23: no longer out of scope —
the owner ratified the three-page IA and this doc now carries the Network page's full
specification (§16); MSO-17 is amended in place in §15.**

### 14.1 The genuinely hard part: one Plane A host carries many Plane B properties

`helios`/`delphi`/`wp hostinger` are Plane A hosts (§12.0) that **host CLIENT websites** — Plane B
payloads. Concretely: `helios` (production web-hosting) may carry client A's site and client B's
site at once; those clients may be different `clients` rows under one tenant (GDA) today, or — once
the platform serves unrelated SaaS tenants (monitoring-program.md §1) — different tenants entirely.
So one non-tenant `infra_hosts` row can correspond to **N** tenant+client-scoped `monitors`/
`search_properties` rows, potentially spanning tenant boundaries. That is exactly the shape MON-00
(monitoring-program.md §1.2) already exists to guard: hierarchy-aware rollups may never cross a root
company, and a naive host↔property join is precisely the kind of cross-client aggregate MON-00 is
gating.

**How to express the relationship without merging the planes — recommended, PLANNED, not built:**

- **A one-directional, staff-only, informational cross-reference — never a join that carries
  authorization, never surfaced tenant-side.** On the Plane A host detail view (staff `isElevated`,
  non-tenant), a card reading "Known Plane B properties on this host" — populated by a staff-scoped
  aggregate query run under the SAME cross-client authority the Plane B Operations board already uses
  (`monitoring.read` already aggregates across every client for staff — this is not a new authority
  boundary, it reuses one that exists). It answers exactly one operational question — *"if this box
  goes down, whose sites are affected"* — and nothing else.
- **Data source: explicit metadata, not live correlation.** Add a nullable
  `hosting_host_key text REFERENCES infra_hosts(key)` column to `search_properties` (and later
  `monitors`) — verified today, `0116_module_monitoring.sql`'s `monitors` table has **no such
  column**, so this is genuinely new, not an oversight to wire up. Populated manually at provisioning
  time by whoever stands up a client's site; needs no live DNS/IP correlation at read time (avoiding
  the SSRF-adjacent pattern monitoring-program.md §3.5 already treats as a hazard elsewhere). Drift
  (a site quietly moved to a different host and nobody updated the column) is caught the same way
  §3.2 already surfaces `infra_hosts` drift: the blackbox probe's resolved IP (MSO-11, once OQ-6 names
  targets) can be compared against the row's declared host and flagged, not silently trusted.
- **Hard boundary, stated so it cannot be built the wrong way by a future session:** this
  cross-reference is READ-ONLY staff metadata. It must **never** be exposed through any
  tenant-scoped endpoint, must **never** let a `monitoring.read` holder on the client side see which
  physical box — or which other tenants/clients — share it (that leaks agency infrastructure, e.g.
  "your site shares a VPS with a stranger's," to a client), and must **never** become an authorization
  join anywhere. It is a blast-radius view for staff, nothing else.
- **This spans both planes' schemas and is therefore a contract question, not a call this integrator
  doc settles.** Adding `hosting_host_key` touches Plane B's `monitors`/`search_properties` tables
  (owned by the monitoring-program.md design, not this MSO plan) while reading Plane A's `infra_hosts`
  (owned here) — the kind of cross-cutting schema decision that needs an explicit architect ratification
  before a migration lands on either side, per this seat's own rule to STOP on contract questions.
  **BLOCKED on architect sign-off** — ticketed as MSO-16 (§15) rather than assumed.

### 14.2 Summary sketch

```
Plane A (staff-only, non-tenant)              Plane B (tenant+client RLS)          IT dept (tenant RLS)
─────────────────────────────────              ──────────────────────────           ────────────────────
/systems/observability                         /monitoring (staff board)            /it (devices + topology)
  infra_hosts: gda-aicenter, sumopod              search_properties, monitors          it_devices, it_device_links
    (agent tier)                                    per tenant+client                    per tenant (office LAN)
  infra_hosts: helios, delphi, wp-hostinger    /portal/status (client)              /it/network (NEW — subnet/
    (blackbox / provider-api tier, §13)          per client, public slug              WAN/AP view, same tenant scope)
        │
        └── "known properties hosted here" ──▶ staff-only informational card (§14.1)
            (MSO-16, BLOCKED on architect — new hosting_host_key column, Plane B side)
```

Nothing above merges a table, an RLS policy, or a Cerbos resource across the vertical lines; the only
cross-plane element is the one read-only, staff-gated informational card, and even that is not built
without an architect ratifying the schema touch on the Plane B side.

---

## 15. Tickets (this pass) and open owner questions

Numbering continues §9/§12.6. Seat default unless flagged; tier · model·effort as elsewhere in this
doc.

| # | Tier · model | Scope | Done when | Depends on |
|---|---|---|---|---|
| **MSO-12** | devops · seat default | Spike, mostly owner-driven: confirm with the owner (i) which login "cloud panel" means for `helios`/`delphi` (URL/screenshot), (ii) whether `helios`/`delphi`/`wp hostinger` share one Hostinger account, (iii) each host's plan tier (VPS vs shared). If VPS confirmed, obtain one Hostinger API token from the owner (accepting §13(b)'s blast radius explicitly, in writing, before it is created) | Three confirmations recorded in this doc; token (if any) stored per the repo's secret pattern, never logged, expiry set | — |
| **MSO-13** | senior-db · seat default | `infra_hosts` migration: add `monitoring_tier` value `provider-api` (a THIRD tier alongside `agent`/`blackbox` — provider-reported telemetry is not our own measurement and must not be labeled as either existing tier), plus `external_ref jsonb` (or a narrower typed column) to hold the provider's own identifier (e.g. Hostinger `virtualMachineId`) keyed off `infra_hosts.key` | Applies on a throwaway DB; `lint:withtenants` + `lint:migration-rls` green; a `provider-api` row with no `external_ref` fails a check constraint (fail-closed, same discipline as MSO-09's off-mesh constraint) | MSO-12 (needs the confirmed facts to seed correctly) |
| **MSO-14** | senior-integrator · **opus·medium** — a stolen provider credential has account-wide reach per §13(b); getting the ingestion/credential-handling wrong here is a security incident, not a re-run | Hub-side poller: calls Hostinger `VPS.getMetricsV1` on a schedule for each `provider-api`-tier host, converts CPU/RAM/disk/network/uptime into the same host-labeled series shape the estate endpoint already expects (or a parallel field set if the shapes don't reconcile — do not force-fit into `HostHealth` if the semantics differ); token never logged, stored per the established secret pattern, read from env not committed config | Live pull against the real Hostinger API for at least one confirmed host, values sane against what hPanel's own UI shows for the same window; token handling reviewed against `golang-security`/secrets-management norms before merge | MSO-12, MSO-13 |
| **MSO-15** | medior (senior-fe reviews) · seat default | Console tier rendering, extending the MSO-06 amendment: a `provider-api` badge distinct from both `agent` and `blackbox`, with copy that credits the reading to the provider ("Hostinger-reported," not "measured by us") so an operator never mistakes third-party telemetry for our own instrumentation | Fixture-driven: a `provider-api` host is visually distinct from both other tiers in every state (fresh/stale/dark) | MSO-14 shape (fixtures may lead the backend) |
| **MSO-16** | **architect** — cross-plane schema touch, explicitly BLOCKED pending ratification per this seat's own contract-question rule | Design + ratify the `hosting_host_key` cross-reference (§14.1): schema (which side owns the column — Plane B's `search_properties`/`monitors`, read by a Plane A-staff-scoped query), the exact staff-only exposure surface, and the "never tenant-visible, never an auth join" invariant as a pinned test, not prose | Architect-ratified design note in `docs/blueprints/monitoring-program.md` (Plane B owns the column) or a cross-doc addendum here (Plane A reads it); a test asserting no tenant-scoped route can ever return `hosting_host_key` or any host identity derived from it | §14.1's design as a starting point; MSO-13 (tier vocabulary) |
| **MSO-17** | medior (senior-fe reviews) · seat default — **AMENDED 2026-08-23 (§16): fully specified; the former "IT department's own design call" dependency is resolved by §16.2–§16.6** | Network page **v1** per §16: new IT tab `/it/network` consuming ONLY the existing `GET /api/:t/it/topology` payload (no new endpoint in v1) — wireless segments by SSID, wired segment, infrastructure chain (gateway → AP/switch), per-segment device counts + status rollup; discovery-freshness banner as the LEAD element (same discipline as `/it/topology`'s it-sync banner); "not observed"/"not collected" states per §16.5; authz = existing `ModuleEnabledGuard("it")` + Cerbos `device:read` data, **no new Cerbos action** (§16.3). Explicitly does NOT render `helios`/`delphi`/`wp hostinger`, `infra_hosts`, the WireGuard mesh, ERP inter-service links, or client-site status (§16.2) | Driven in a browser against the live BE and against a dead-collector fixture — in the latter every segment renders UNKNOWN and cannot be read as green; a Plane A host name appears nowhere in the page's data path (MSO-22 pins it); `nav.ts` + `docs/sidebar-nav-map.md` + the IT layout tab strip updated in the same commit | §16 (this doc); real data arrives only with MSO-19 — the page ships honest-empty before that, exactly as `/it/topology` does today |
| **MSO-18** | devops · seat default, **BLOCKED on an owner timeline** | Plan (not execute) the `gda-aicenter`+`sumopod` consolidation's observability fallout per §12.0: which `infra_hosts` row retires vs is repurposed, whether the WireGuard hub relocates, whether pre-merge series history stays queryable under the old `host` label. Explicitly: do not design or execute the consolidation itself | A short addendum to this doc naming the plan, written only after the owner names a timeline | Owner timeline (unset) |

### 15.1 What is still needed from the owner (consolidated)

1. Which login is "cloud panel" — a URL or screenshot for `helios`/`delphi` (§13(a), §13.1 step 1).
2. Do `helios`, `delphi`, and `wp hostinger` share one Hostinger account, or separate accounts/
   resellers (§13(b)/(c))?
3. Each host's actual Hostinger plan tier — KVM VPS vs shared/managed WordPress (§13(b)) — this gates
   whether `VPS.getMetricsV1` applies at all.
4. Explicit go-ahead to mint a Hostinger API token, having read §13(b)'s blast-radius trade (no
   read-only scoping was found to exist) — or, if the owner wants to ask Hostinger support whether a
   reduced-privilege team-member token exists, that answer first.
5. OQ-6 (still open, unchanged by this pass): the actual probe list (URLs/ports) for `helios`/
   `delphi`/`wp hostinger` blackbox probing — required before MSO-11 can send its first packet.
6. A rough timeline for the `gda-aicenter`+`sumopod` consolidation (§12.0, MSO-18) — not needed to
   design it, only to know when to plan the hub-relocation/row-retirement work.

---

## 16. 2026-08-23 owner ruling — the monitoring IA is THREE SEPARATE PAGES; the Network page specified (MSO-17)

**Ruling (owner, 2026-08-23, binding):** the monitoring interface is **three separate pages,
deliberately not merged**:

1. **Server monitoring** — the Plane A estate console this program is building:
   `/systems/observability`.
2. **Devices monitoring** — the **existing** IT topology surface: `/it/topology` (with its
   `/it/devices` registry tab).
3. **Network monitoring** — a **Network page that DOES NOT EXIST YET**: `/it/network`, specified in
   §16.2–§16.6 and built as MSO-17 (amended in place, §15).

"Servers", "devices" and "network" share vocabulary but are three different nouns with different
data, different tenancy and different audiences; separate pages is the correct answer and it
preserves the two-plane boundary (monitoring-program.md §0). **Recorded with its date so nobody
later "helpfully" consolidates them** — a merged "everything monitoring" page is exactly how Gaia
Nexus ended up with fake gauges, and §14 named the blur risk before the owner ruled. Plane B
`/monitoring` (clients' properties — the sellable module) is a **fourth** surface owned by
monitoring-program.md §3–§5; it sits outside this ruling and must not be folded into any of the
three either. The binding cross-reference lives in the blueprint (monitoring-program.md §9), so a
session that reads only the blueprint still hits the ruling.

**Fleet facts (owner-confirmed 2026-08-22, restated because this section will be read alone):**
`helios` = production, `delphi` = staging, `wp hostinger` = the WordPress-projects host; all three
host **client web projects the agency builds** (Plane A boxes carrying Plane B payloads, §14.1).
`gda-aicenter` + `sumopod` are the ERP's own servers, slated for eventual consolidation onto one
box (MSO-18, blocked on an owner timeline). Passive lookup — NOT owner-confirmed — places
`helios`/`delphi` on Hostinger's own network (AS47583, `srv####.hstgr.cloud` rDNS; §13(c)).

### 16.1 The three pages — what each shows, and what each must never show

| | 1 · Server monitoring | 2 · Devices monitoring | 3 · Network monitoring |
|---|---|---|---|
| **Route** | `/systems/observability` (exists) | `/it/topology` + `/it/devices` (exists) | `/it/network` (**does not exist** — MSO-17) |
| **Shows** | Machines **we operate or rent to run the platform and the hosting business**: the `infra_hosts` estate by tier (agent: node/containers/datastores; blackbox: probe results; provider-api later), Alertmanager alerts, freshness as the lead signal | The **tenant's own office hardware**: registered + discovered devices, uplink graph (gateway → AP/switch → device), heartbeats, discovery freshness | The **tenant's own network fabric** as a first-class noun: WAN uplink, wireless segments (SSIDs), wired segment, subnets/VLANs, per-segment counts + rollups, discovery freshness (§16.2) |
| **Data source** | `infra_hosts` (GLOBAL, no `tenant_id`, read via `withGlobal`) + remote Prometheus (`10.88.0.2:19090`) + Alertmanager | `it_devices` / `it_device_links` / `it_discovery_runs` (all `tenant_id` + FORCE RLS), fed by push from the (unbuilt) `it-site-collector` | v1: the existing `GET /api/:t/it/topology` payload, regrouped; v2: network-entity rows (MSO-20) — same tables/tenancy family as column 2 |
| **Tenancy** | **Plane A: staff-only, non-tenant.** Never sellable | Tenant-scoped ERP department feature (sellable), RLS-enforced | Tenant-scoped, identical to column 2 |
| **Authorization** | `AuthGuard` + `isElevated` (`src/admin/observability.controller.ts:180`); nav under Systems | `ModuleEnabledGuard("it")` + Cerbos `device:read` (any member); writes `device:create/update/delete` (company-admin / IT staff) | Same as column 2 — **ruled: no new Cerbos action** (§16.3) |
| **MUST NOT show** | Any `it_devices` row — office printers/APs/workstations/CCTV/office NAS of ANY tenant. Any Plane B monitor/property status. (The one sanctioned cross-plane element — the MSO-16 "properties on this host" card — remains BLOCKED on architect ratification; this ruling does not unblock it) | Any `infra_hosts` machine — `gda-aicenter`, `sumopod`, `helios`, `delphi`, `wp hostinger` NEVER appear here, even though colloquially they are "GDA's servers". Client-site uptime (Plane B) | The WireGuard mesh, `infra_hosts`, the hosting network `helios`/`delphi` sit on, ERP inter-service connectivity, client-site reachability — each ruled to its own home in §16.2 |

**The trap, named:** `it_devices` and `infra_hosts` both colloquially contain "machines", both
vocabularies say "server", "network" and "monitoring" — and `it_devices.kind` literally includes
`'server'`. The word is not the discriminator. **A machine WE operate to run the platform or the
hosting business is an `infra_hosts` row and renders only on page 1; a machine that is the
tenant's own asset in the tenant's own office is an `it_devices` row and renders only on pages
2–3.** `kind='server'` exists for genuine office hardware (an on-prem NAS, a local test box) — it
is not a licence to register cloud VPSes as devices, and the estate console is not a licence to
render a tenant's office NAS as infrastructure.

**How a hurried implementer tells them apart at a glance — four checks, any one suffices:**

1. **The route group.** `/systems/*` = ours, staff, no company switcher. `/it/*` = a tenant
   department page, company switcher applies.
2. **The table shape (structural, not convention).** `infra_hosts` has NO `tenant_id` and is read
   via `withGlobal` with a justification comment; the IT tables carry `tenant_id` + FORCE RLS. A
   row WITH `tenant_id` cannot be served by the estate endpoint; a row WITHOUT one cannot be
   served under `/api/:tenantId/*`. (Do not lean on RLS's zero-row behaviour to hide a wrong join
   — it hides the design error exactly as silently, [[migration-backfill-rls-trap]].)
3. **The noun test.** Has `env` / `monitoring_tier` / a Prometheus `host` label → infra host. Has
   `ssid` / `uplink_mac` / `device_class` → office device.
4. **The litmus question.** "Would a paying SaaS tenant ever be allowed to see this row?" Their
   own office devices: yes. Our hosts: never.

MSO-22 (§16.7) pins checks 1–2 as tests so the ruling survives sessions that read none of this.

### 16.2 What "network monitoring" means on page 3 — the candidates, ruled

Four different things answer to the phrase; only one belongs on the page:

| Candidate | Ruling | Where it lives instead |
|---|---|---|
| **The office LAN** — `10.10.0.0/22` behind the UniFi OS gateway at `10.10.0.1` (~58 live hosts measured 2026-08-03, [[office-network-and-it-discovery-gap]]) | ✅ **THIS PAGE.** The only network the tenant itself owns | — |
| **The WireGuard mesh** (hub `10.88.0.2` ↔ agent hosts) | ❌ Plane A transport | Its health IS the estate console's lead signal already — freshness + `RemoteWriteStalled` (§6, §8). A dedicated mesh view, if the fleet ever earns one, goes on page 1, never tenant-side |
| **ERP inter-service connectivity** (container ↔ container) | ❌ Plane A application observability | Grafana/Tempo + the WS9 synthetic prober; the ERP console deliberately links out rather than re-implementing (blueprint §5.1) |
| **External reachability of client sites** | ❌ Plane B product | `/monitoring` — literally the monitoring module's job (http/tcp/dns/tls drivers, blueprint §3). Reachability of OUR hosts is the estate console's blackbox tier (MSO-11) — also not this page |

One page, one noun, one plane. If any ❌ row ever renders on `/it/network`, the two-plane boundary
is broken; MSO-17's acceptance and MSO-22's pin both assert it.

### 16.3 Tenancy and authorization — resolved, no straddle

The page is **tenant-scoped IT**, same plane and same gates as the topology page. The straddle
risk was real — "network monitoring" naively includes the WireGuard mesh, which is Plane A, and a
page carrying both would put staff infrastructure behind a tenant gate or tenant data on a staff
console. It is resolved by **ruling the mesh (and everything else Plane A) off the page** (§16.2),
not by inventing a mixed-tenancy page. There is deliberately no shared *data* component between
pages 1 and 3: what they may share is a rendering idiom (freshness banners, UNKNOWN styling),
which lives in shared UI components; they must never share a data source, an endpoint, or a gate —
and a shared idiom is not a reason to merge the pages.

**Authorization ruling: reuse Cerbos `device:read`; no new action, no new resource.** v1 renders
the same rows the device surface already authorizes; the principals who can read the device list
can already infer the network from it, so a separate permission would be a fake boundary with real
drift cost — an unlisted Cerbos action is a silent DENY and needs a restart to land
(it.controller.ts's own IT-05 header note, [[cerbos-new-policy-needs-restart]]). If the owner ever
wants network visibility narrower than device visibility, `it.network.read` is one catalog+policy
migration away; do not pre-create it.

### 16.4 Data sources — what exists, what does not

**Exists (verified in-repo this pass):** `it_devices` (with `ssid`, `is_wired`,
`uplink_mac`/`uplink_port`, free-text `network`/`site`, `device_class`, `external_id`),
`it_device_links` (resolved edges, one uplink per child), `it_discovery_runs` (freshness + BYOD
aggregate) — migration `0071`, FORCE RLS on all three; `GET /api/:t/it/topology` (devices + links
+ lastRun, server-computed); `POST /api/:t/it/discovery/report` (push ingest — classification is
recomputed server-side and BYOD rows are dropped **server-side** unless
`config.itDiscovery.persistByod`, so the privacy gate does not depend on collector correctness);
derived status + dark-by-default reaper; the `/it/topology` UI with its it-sync freshness banner;
DEMO fixtures.

**Does not exist — in dependency order:**

1. **`it-site-collector` — the only real feed, for pages 2 AND 3.** The ERP cannot poll the
   office: `10.10.0.1` is RFC1918 behind NAT, verified HTTP 000 from `gda-aicenter` — discovery is
   push-only, and no pusher has ever run. Blocked on OQ-9 (UniFi Integration API key + an
   always-on office host). Until it ships, both pages truthfully render "Not connected".
2. **Network entities as data.** Nothing models an SSID, subnet, VLAN or WAN uplink as a row;
   `network` is a free-text device column. v1 therefore derives segments from device rows; v2
   (MSO-20) makes them rows.
3. **Network-level signals in the report shape.** `DiscoveryReport` carries devices only — no WAN
   state, no per-AP radio/client stats, no DHCP pool, no ISP latency.
4. **Contract rows.** BFF contract §6 covers devices; **§6a** (network reads) lands with MSO-20.
5. **A capability inventory of the UniFi Integration API on this UDM.**
   `/proxy/network/integration/v1/sites` returned 401 (the API exists; a key is needed); which
   network-level facts v1 of that API actually serves is UNVERIFIED. MSO-19 records the inventory
   empirically **before** MSO-20's schema is designed — do not design tables for data the API may
   not serve.

### 16.5 Honesty requirements (binding, testable)

The estate-wide rule — a thing we cannot observe renders UNKNOWN, never healthy — applied to the
surface most prone to violating it: **an un-probed link looks identical to a working one.** Plus
one structural fact that makes fabrication uniquely easy here: **the ERP is completely blind to
the office network** (NAT, §16.4 item 1), so ANY reachability-flavoured signal computed
server-side would be fiction by construction. Everything on this page is collector-reported or
absent.

1. **Feed freshness is the page's lead element** — same discipline as `/it/topology`'s it-sync
   banner. Dead collector ⇒ the whole page carries the stale banner and every segment greys with
   its age; last-known-good must LOOK old, never current.
2. **Not reported this run ⇒ "not observed", never green.** Presence in inventory is not health.
3. **Liveness comes from the controller's client table only, never ICMP** — measured undercount
   is 5× (12 of 58 hosts answered ping).
4. **Empty is a claim** ([[empty-list-is-a-claim]]): "no segments known" states collector status,
   not network status, and must not render as a green all-clear.
5. **Tri-state, same as §12.3:** measured / expected-but-missing (fault — alarming) /
   not-collected-by-design (v1 collects no WAN stats — calm, but explicitly not knowledge).

### 16.6 Phasing — what is worth building first when the data source does not exist

```
Phase 0  MSO-19  it-site-collector v1           ← the root data gate; also un-blinds /it/topology
Phase 1  MSO-17  /it/network v1 (derived view)  ← buildable NOW against fixtures + honest empty state
         MSO-22  IA boundary pin tests          ← cheap, immediate, independent
Phase 2  MSO-20  network entities as data + §6a ← gated on MSO-19's empirical API inventory
Phase 3  MSO-21  page v2: WAN card + events     ← gated on MSO-20
```

MSO-17 and MSO-19 are independent and can run in parallel: the page ships with the honest
"Not connected" state exactly as the topology page does today, and lights up the day the
collector first reports. Building MSO-20's schema before MSO-19 has run against the real
controller is explicitly forbidden by §16.4 item 5.

### 16.7 Tickets (MSO-17 amended in place in §15; these are new)

| # | Tier · model | Scope | Done when | Depends on |
|---|---|---|---|---|
| **MSO-19** | devops · seat default | `it-site-collector` v1 per the 2026-08-03 design doc (§4/§9, `docs/superpowers/specs/2026-08-03-it-network-discovery-design.md`): office-side agent polling the UniFi Integration API (revocable `X-API-KEY`) → `POST /api/:t/it/discovery/report` on an interval, over TLS; BYOD posture unchanged (server-side drop; collector ships the controller's client table and classifies nothing itself); purge the live tenant's 8 seeded fiction rows first (design doc §12 SQL, per OQ-9c); append an **empirical inventory of what the Integration API actually serves on this UDM** to the design doc (feeds MSO-20) | Live run from the office host against the real controller; `/it/topology` (and `/it/network` once built) shows the real `10.10.0.x` estate; stopping the collector turns the feed stale within the reaper window; the API inventory is written down | OQ-9 (key + host + purge approval), OQ-10 (which tenant it posts to) |
| **MSO-20** | senior-be + senior-db · seat default | Network entities as data: extend `DiscoveryReport` with a network block (WAN uplink state, per-AP radio/client stats, subnets/VLANs — exactly what MSO-19's inventory confirmed the API serves, nothing speculative); timestamp-named migration for `it_networks`(+stats) with `tenant_id` + FORCE RLS; `GET /api/:t/it/network`; BFF contract **§6a** rows (⛔ PENDING until QA flips them) | Applies on a throwaway DB; `lint:withtenants` + `lint:migration-rls` green; `app.inject` suite; null-vs-zero discipline — a missing WAN reading is `null`+reason, never 0/up (unit tests mock an empty report and assert no coercion; the worked in-repo model is `estate-observability.ts`) | MSO-19 (inventory), MSO-17 (a consumer exists) |
| **MSO-21** | medior (senior-fe reviews) · seat default | Page v2: WAN uplink card, per-segment utilization, `network.wan.down` / `network.segment.dark` outbox events with the **registration pin shipped with the taxonomy, not after** (blueprint §4.2 lesson); dedupe against existing `device.offline` events so one dead AP does not notify twice | Driven in a browser; events land in `/admin/audit` + the notification bell; the pin test asserts the new entity types are registered end-to-end | MSO-20 |
| **MSO-22** | junior · seat default | The IA boundary pin, as tests: (i) nothing under `platform-nest/src/modules/it/` references `infra_hosts` or `withGlobal`; (ii) the estate observability controller never selects from `it_devices`/`it_device_links`; (iii) in platform-ui, `(app)/it/**` imports nothing from `lib/observability*` and `(app)/systems/observability/**` imports nothing from `lib/it` | Tests green; each failure message quotes the 2026-08-23 ruling and points at §16.1 | — (land any time; before MSO-17 merges is ideal) |

Recommended model·effort: **all seat default, no Opus flags** — none of these tickets carries the
hazard class that has justified Opus elsewhere in this doc (no authz redesign — §16.3 deliberately
reuses an existing gate; no concurrency or migration-integrity hazard; MSO-20's tri-state
discipline has a worked in-repo model). The riskiest surface — the UniFi credential and the BYOD
privacy gate — is bounded by server-side enforcement that already exists.

### 16.8 What only the owner can answer (this section's additions; §10 / §15.1 items unchanged)

- **OQ-9 — collector prerequisites.** (a) Mint a UniFi Integration API key on the office UniFi OS
  console (revocable `X-API-KEY`) — and state whether it is read-only-scoped, which the 2026-08-03
  design assumed but never verified. (b) Name the always-on office host the collector runs on.
  (c) Approve purging the live tenant's 8 seeded fiction devices (design doc §12 SQL) before the
  first real report, so real discovery is not merged into fiction.
- **OQ-10 — which company owns the office-network data.** The physical office serves
  shared-service departments across the holding's siblings ([[erp-holding-os-vision]]), but the
  collector posts to exactly ONE `:tenantId`, and RLS makes that choice the visibility boundary
  for pages 2–3. GDA is the default until ruled otherwise; if the answer is "the holding", that is
  a deliberate decision to make office-network visibility follow DnA Holding membership rather
  than GDA membership — either is buildable, but it must be chosen, not inherited from whoever
  writes the collector's config file.
