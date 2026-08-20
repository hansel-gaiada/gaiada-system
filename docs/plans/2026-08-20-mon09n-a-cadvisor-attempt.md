# MON-09n-a — cAdvisor `--disable_metrics=...,disk` attempt: RESULT = FAILED

**Date:** 2026-08-20 · **Ticket:** MON-09n-a (bounded attempt per `docs/plans/2026-08-20-monitoring-gated-rulings.md` §3)
**Outcome: the fix did not work. Per the ticket's own stop condition, no fallback (MON-09n-b /
`docker_stats`) was attempted.** No repo file ships from this ticket; the compose file is back to
its pre-attempt, committed state.

## What was tried

`gcr.io/cadvisor/cadvisor:v0.49.1`'s `-disable_metrics` default (confirmed via `--help` on the box):

```
advtcp,cpu_topology,cpuset,hugetlb,memory_numa,process,referenced_memory,resctrl,sched,tcp,udp
```

`disk` is **not** in that default (so disk-usage resolution was always being attempted). Added the
flag explicitly, default list preserved verbatim plus `disk` appended:

```
-disable_metrics=advtcp,cpu_topology,cpuset,disk,hugetlb,memory_numa,process,referenced_memory,resctrl,sched,tcp,udp
```

Applied by hand-editing `infra/compose/docker-compose.observability.yml` on `gda-aicenter` (backed
up first to `docker-compose.observability.yml.bak-mon09na`), validated with
`docker compose ... config -q`, then recreated **only** the `cadvisor` service by explicit name
(`up -d --no-build cadvisor`, no `--remove-orphans`).

## Verification — the exact acceptance criterion, before and after

Query against the remote Prometheus (SumoPod VPS, `http://10.88.0.2:19090`, reached from
`gda-aicenter` over the WireGuard tunnel per the relocation):

| Query | Before | After the flag |
|---|---|---|
| `count(container_last_seen{name!=""})` | `[]` (0 series) | `[]` (0 series) — **unchanged** |
| `count(container_last_seen)` (no filter) | `51` | `51` — **unchanged** |
| cadvisor container health | healthy | healthy (both times — "green but blind" both times) |

The container logs after recreation showed the **identical** failure, once per running container,
unchanged in wording or count:

```
W... manager.go:1169] Failed to process watch event {...Name:/system.slice/docker-<hash>.scope...}:
failed to identify the read-write layer ID for container "<hash>".
- open /rootfs/var/lib/docker/image/overlayfs/layerdb/mounts/<hash>/mount-id: no such file or directory
```

**Conclusion: the RW-layer lookup that fails is not gated by the `disk` metric class at all** — it
appears to run as part of container-handler/watch-event construction itself (`manager.go:1169`),
independent of which metrics are later collected from that handler. Disabling `disk` metrics
skips reporting disk-usage series but does not skip the lookup cAdvisor's factory performs when it
tries to *add* the container to its watch list in the first place. This is a more precise (and worse)
root cause than the ruling's working hypothesis — the lookup is structural to container discovery
under the containerd snapshotter on this cAdvisor version, not an opt-out-able metric collector.

## Rollback (executed, verified)

1. Restored `docker-compose.observability.yml` on the box from the pre-edit backup —
   `md5sum` confirmed byte-identical to the file at the currently-deployed tag
   (`alpha-01.057.0114a`) and to repo `HEAD` before this attempt (`120a6ee373458e90afb0d0554bfca70c`).
   Backup file deleted after restore.
2. Recreated `cadvisor` again by explicit service name (no `--remove-orphans`) — back to
   `Up ... (healthy)`, same "51 unnamed host-cgroup series, 0 named" state as the pre-attempt
   baseline. No other container was touched (see the ps -a diff in the main report — identical
   before/after this whole session).
3. The repo working tree's `infra/compose/docker-compose.observability.yml` edit was reverted
   (`git checkout --`) rather than committed — shipping a flag that does not fix the documented
   symptom, with a comment claiming it does, would be worse than the current documented gap.

## Disposition

Per the ticket: **STOP here.** MON-09n-b (`docker_stats` receiver on the existing
`otel-collector-contrib:0.116.1`, retiring cAdvisor after a parity check, rewriting the Host &
Infrastructure dashboard panels from `container_*` to the OTel metric names) is the next step, but
it is out of scope for this bounded attempt and needs its own ticket/review — not a decision to make
inside this one.
