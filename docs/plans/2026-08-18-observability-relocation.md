# Relocating the observability stack to the SumoPod VPS

**Date:** 2026-08-18 · **Status:** PLANNED — access RESOLVED, execution gated on WireGuard (§4) · **Owner ask:** move Prometheus/Loki/Tempo off `gda-aicenter` to the SumoPod VPS "as it has more room"
**Related:** [`docs/blueprints/monitoring-program.md`](../blueprints/monitoring-program.md) §2 · `infra/runbooks/deploy-vps.md` §"Postiz / SMM"

---

## 0. Access — RESOLVED, and the premise CONFIRMED

Owner supplied credentials 2026-08-18. Access is now key-based: a dedicated key
(`~/.ssh/sumopod_ed25519`, generated for this host rather than reusing another project's) is
installed in `ubuntu@150.109.15.108:~/.ssh/authorized_keys`, and `ssh sumopod` works under
`BatchMode`. Details in the gitignored `CREDENTIALS.local.md` §9.

⚠ **The password was pasted into a chat transcript, so treat it as exposed and rotate it.** Key auth
means nothing depends on it any more, which is what makes rotation cheap.

**The premise holds, decisively.** Measured, not assumed:

| Host | Disk | Free | Memory available | Containers |
|---|---|---|---|---|
| `gda-aicenter` (current) | 49 G | **8.9 G (82% used)** | 4.7 G | 33 |
| **SumoPod `150.109.15.108`** | **217 G** | **105 G (50% used)** | **9.4 G** | **36 running / 37 total** |
| `aire-vps` | 79 G | 12 G (85%) | — | — |
| `gda-ce01` | 164 G | 4.8 G (98%) | — | — |

That is ~12x the free disk and ~2x the free memory. The observability stack's entire footprint
(~4.5 G of data plus ~2 G of images) is noise against 105 G. Host: `VM-4-181-ubuntu`,
Ubuntu 24.04.4 LTS.

**Build cache is at 57.16 G with 54.71 G reclaimable and zero active** — the exact condition the
runbook documents as recurring on this box (it previously reached 147 G and filled the disk to 85%).
`docker builder prune -af` is the one sanctioned maintenance action there. **I have not run it**: with
105 G free it is not needed for this migration, and every command on a box running someone's
production should have to justify itself. Worth doing as deliberate maintenance, not as a side effect
of this work.

### 0.1 The runbook's container baseline is stale, and that is a safety problem

`infra/runbooks/deploy-vps.md` states **19 containers** and instructs the operator to treat anything
other than "19 before, 19 + ours after" as an incident. The measured baseline today is **37 total /
36 running**. Anyone following the runbook literally would either raise a false incident over 18
containers that legitimately belong there, or — worse — learn to ignore the check. The runbook has
been corrected to take a fresh baseline per session rather than to hardcode a number that drifts.

## 1. Why this move is worth doing anyway — and it is not the disk

The disk was the stated reason, but the stronger argument is independent of it:

**Today, if `gda-aicenter` dies, the thing that would notice dies with it.** Prometheus,
Alertmanager and every rule run *on the box they watch*. The only out-of-band survivor is the
external dead-man's-switch and the cron `healthcheck.sh`. Moving storage and alerting to a second
host means an outage of the monitored box is *reported* rather than silently un-noticed.

That reframes the goal: this is a **resilience** change that also happens to reclaim ~4.5 GB.

## 2. Why "just move the three containers" does not work

Signals divide by transport, and only one half can be relocated freely:

| Signal | Transport today | Relocatable? |
|---|---|---|
| Traces → Tempo | **push** (OTLP from the OTel collector) | ✅ endpoint change only |
| Logs → Loki | **push** (collector's `filelog` receiver → Loki) | ✅ endpoint change only |
| App/business metrics | push (OTLP → collector → `:8889`) | ✅ |
| **Infra metrics → Prometheus** | **PULL** — Prometheus scrapes 14 targets | ❌ **this is the whole problem** |

Prometheus *pulls*. The targets — `node-exporter`, `cadvisor`, `blackbox-exporter`, two
`postgres-exporter`s, two `redis-exporter`s, the collector's own `:8889`/`:8888` — live on
`gda-aicenter`'s compose network with **no published ports**. A remote Prometheus can only reach them
by exposing eight-plus ports across the link, which is both a new attack surface and a direct
violation of the target host's "never publish on `0.0.0.0`" rule.

## 3. The correct topology: collection stays, storage moves

```
gda-aicenter (10.88.0.1)                    SumoPod VPS (10.88.0.2)
────────────────────────────                ───────────────────────────
exporters (unchanged, unpublished)          prometheus   (storage + rules)
  node / cadvisor / blackbox                alertmanager (transports)
  pg x2 / redis x2                          grafana      (dashboards)
        │ scraped locally                   tempo        (traces)
        ▼                                   loki         (logs)
  otel-collector  ──── WireGuard ─────────▶  ntfy
   · prometheus receiver (scrapes)           ▲
   · prometheusremotewrite exporter ─────────┘  (needs --web.enable-remote-write-receiver)
   · otlp exporter → tempo
   · loki exporter → loki
   · sending_queue + persistent buffer
```

**One process crosses the tunnel, in one direction, outbound.** The OTel collector already fans out
three signals; giving it a `prometheus` *receiver* (the same scrape configs Prometheus uses today)
plus a `prometheusremotewrite` *exporter* turns the pull half into a push. No exporter is exposed, no
inbound port is opened on either box, and the collector's existing `sending_queue` — given persistent
storage — buffers a tunnel blip instead of silently dropping telemetry.

This is the standard agent/remote-write topology, and it is strictly better than port-forwarding
exporters even if the tunnel were free.

## 4. Prerequisites, in order

| # | Prerequisite | Why it blocks |
|---|---|---|
| 1 | ~~SSH access~~ | ✅ RESOLVED — key auth working (§0) |
| 2 | **WireGuard `10.88.0.1 ↔ 10.88.0.2` established** | Designed in the runbook for Postiz, but Postiz is **PROTOTYPED — nothing has been deployed to that host**, so the tunnel almost certainly does not exist. Everything here rides it. |
| 3 | ~~Measured free space~~ | ✅ RESOLVED — 105 G free, premise confirmed (§0) |
| 4 | `--web.enable-remote-write-receiver` on the relocated Prometheus | Otherwise remote_write is refused and metrics vanish |
| 5 | Decide Grafana's reachability | It moves off the box the SSH tunnel currently lands on; either tunnel to the VPS instead, or bind Grafana to `10.88.0.2` and reach it from `gda-aicenter` |

## 5. Host-safety rules that are NOT optional on this box

From `infra/runbooks/deploy-vps.md` — that VPS runs the owner's private production (**36 running /
37 total** as measured today; the runbook's "19" is stale, see §0.1), and these are quoted as written,
not paraphrased:

- **Never a Docker command that is not scoped to our project.** Every command carries
  `-p gaiada-obs` (proposed name) or `-f` our compose file. Specifically banned: `docker system
  prune` (any flags), `docker image prune -a`, `docker volume prune`, `docker network prune`, and
  any `--remove-orphans` without the project flag.
- **Never publish on `0.0.0.0`.** Docker's DNAT rules are evaluated *before* ufw's, so a `0.0.0.0`
  bind is internet-reachable on a box whose firewall reports "deny incoming". Bind everything to
  `10.88.0.2` or `127.0.0.1`. This applies to Grafana `:3000`, Prometheus `:9090`, Alertmanager
  `:9093`, Loki `:3100`, Tempo `:4317/4318` — every one of them.
- **`docker ps -a` before and after every session, diffed.** Take the baseline FRESH each session --
  do not trust a number written down previously, because it drifts (the runbook's 19 is now 37). The
  invariant is *baseline + exactly our containers*, not any particular integer.
- Safe and wanted: `docker builder prune -af`.

## 6. Migration sequence (once unblocked)

1. Establish + verify WireGuard both directions; add a `WireGuardDown` alert **on the remote side**
   (the surviving side is the one that must notice).
2. Stand up `gaiada-obs` on the VPS: Prometheus (remote-write receiver on), Tempo, Loki, Grafana,
   Alertmanager, ntfy — all bound to `10.88.0.2`. Nothing removed from `gda-aicenter` yet.
3. Reconfigure `gda-aicenter`'s collector: add the `prometheus` receiver + `prometheusremotewrite`,
   repoint OTLP/Loki exporters across the tunnel, enable a persistent sending queue.
4. **Run both in parallel** and diff: same series count, same 14 targets, rules loading, alerts
   firing to the same transports. Do not decommission on faith.
5. Migrate history if wanted (`prometheus-data` 400 MB, `loki-data` 29 MB, `tempo-data` 4 GB) the
   same way the consolidation did — stop, volume-copy, start.
6. Only then remove Prometheus/Loki/Tempo/Grafana/Alertmanager from `gda-aicenter`, keeping **all
   exporters and the collector** local.
7. Update `PROMETHEUS_URL` for the ERP console from `http://prometheus:9090` to
   `http://10.88.0.2:9090`, and confirm platform-nest routes over the tunnel.
8. Keep the cron `healthcheck.sh` + external dead-man's-switch **on `gda-aicenter`** regardless —
   after this move it is the only local thing that can report the box is alive.

## 7. Risks this introduces

| Risk | Mitigation |
|---|---|
| Visibility now depends on a tunnel | Persistent send queue on the collector; `WireGuardDown` alert on the remote side; local cron healthcheck retained |
| Blast radius on someone's production box | §5 rules; scoped project; `docker ps -a` diff; no prune |
| A `0.0.0.0` bind slipping in | Explicit bind addresses in the compose file, defaulting to `127.0.0.1` so a missing value fails safe |
| Remote box fills too | It is documented to accumulate build cache to 147 GB; the `DiskSpaceLow`/`DiskWillFillIn24h` rules should scrape the VPS's own node-exporter, not just `gda-aicenter`'s |
| Two half-migrated stacks | Step 4's parallel run and diff; decommission is a separate, later step |

## 8. Provenance

Capacity figures are from live `df`/`docker system df`/`docker ps` on each host on 2026-08-18,
including `150.109.15.108` once the owner supplied access. Host-safety rules are
quoted from `infra/runbooks/deploy-vps.md`. Nothing in this document has been executed.
