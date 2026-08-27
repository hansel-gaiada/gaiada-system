# Runbook — WebDesk Zone B OTel export + the Zone A write-only OTLP listener (WSK-28)

**Status: PLANNED (Zone B side authored + config exists in `webdesk/otel/`) / PROTOTYPED (write-
only property checked by a selftest-capable script) / BLOCKED (the Zone A listener itself — see
§4, out of this ticket's file ownership).**

Read first: `docs/blueprints/webdesk-design.md` §02 diagram (`ZB -. "B→A #2: OTLP push
(write-only)" .-> GRAF`), §03 B→A channel table (channel #2: "Write-only bearer + TLS;
rate-limited; fail-soft `OTEL_ENABLED` on the Zone B side" / "May never cause: Reads of any kind;
the listener exposes no query surface").

---

## 1. The security property, stated precisely

**Zone B may push telemetry into Zone A. Zone B may never read anything back.** This is not the
same property as "Zone B has no Zone A credential" (§03's control-channel table already covers
that) — it's narrower and about a specific listener: even a listener that required strong auth
would violate this property if it also exposed a way to *query* what had been ingested, because a
compromised Zone B could then read Zone A's own operational telemetry (error rates, internal
hostnames in span attributes, trace topology) — a reconnaissance channel into Zone A that the
design explicitly forbids ("the listener exposes no query surface").

**What "write-only" has to mean concretely**, for a real OTel Collector:
1. The **receiver** Zone B talks to is `otlp` (gRPC and/or HTTP) — a receiver, by construction,
   only *accepts* data; it has no query API of its own.
2. **No exporter, extension, or receiver on that same collector instance answers a read.** Two
   collector installs is the cleanest way to guarantee this rather than assert it by config
   review: a **dedicated collector instance** whose only pipelines are `otlp → (auth-check) →
   downstream exporters`, with **zero** of the read-side extensions the estate's existing
   `config.yaml`/`config.tier1-metrics.yaml`/`config.tier2-logs.yaml` never enable either
   (no `pprofextension`, no `zpagesextension`, no `prometheus` **receiver** scraping this
   instance back out, no reverse route from downstream Grafana/Mimir/Tempo back through this same
   listener).
3. **Auth on the receiver is bearer-token, one direction.** The token authenticates "this sender
   may push," not "this caller may query." OTel Collector's `bearertokenauth` extension attached
   to the `otlp` receiver's `auth:` stanza does exactly this — it has no read semantics to misuse.
4. **Network-level:** the listener's port is reachable from Zone B's egress IP(s) only (firewall
   allowlist, not the collector's job) and is never the same port/process the internal Grafana
   stack queries on — so even a network-level scan from a compromised Zone B finds a push-only
   endpoint, not a path toward `grafana:3000` or `mimir:9009`'s query API.

---

## 2. Zone B side (this ticket, already-existing files extended)

`webdesk/otel/otel-collector-config.yaml` already runs a **local dev sink** collector (per its own
header, restated in `docker-compose.yml`: "fail-soft; local dev sink only — WSK-28 wires the real
Zone A listener"). This ticket does not change that file's dev behavior — it stays a local sink so
`docker compose --profile dev up` keeps working with zero external dependency. What this ticket
adds is the **export leg** the `api`/`worker` services use once `OTEL_ENABLED=true` and
`OTEL_EXPORTER_OTLP_ENDPOINT` points at the real Zone A listener instead of the local collector:

- `OTEL_ENABLED` — already wired end-to-end (compose `environment:` block on `api`, per the
  estate's compose-env-passthrough rule) and **fail-soft by construction**: false is a supported
  steady state, not an error path. This ticket does not change that contract, only documents that
  the *real* value at `OTEL_EXPORTER_OTLP_ENDPOINT` will one day be the Zone A listener's public
  URL, never a Zone A-internal hostname (consistent with WSK-01's "zero Zone A hostnames" AC — the
  listener's *public* address is not a Zone A internal credential/hostname, it is the one address
  Zone B is explicitly allowed to know, same as the n8n bridge trigger URL).
- **New:** `OTEL_EXPORTER_OTLP_HEADERS` (bearer token for the write-only listener's auth
  extension) — added to `.env.example` and the `api`/`worker` `environment:` blocks (§5).

---

## 3. What Zone B must NOT be able to do to the listener (the check)

`webdesk/ops/scripts/check-otlp-write-only.mjs` (this ticket) is a **static config auditor**,
not a live probe (there is nothing live to probe yet). It takes a Zone A collector config file
and asserts, by parsing the YAML:

1. Every pipeline whose receiver is `otlp` on the write-only listener's named receiver id has
   **no exporter that is itself queryable by network** in this pipeline's export set beyond the
   internal downstream (Grafana stack) — i.e. no `otlp`/`otlphttp` exporter pointed back out
   toward anything Zone B could be the other end of.
2. The `otlp` receiver in question declares an `auth:` extension.
3. No `pprofextension`, `zpagesextension`, or a `prometheus` **receiver** exists anywhere in the
   same config that a Zone-B-reachable network path could reach (this check cannot see the
   firewall; it flags the config-level exposure so the firewall reviewer has one less thing to
   trust blindly).
4. **Selftest mode** (`--selftest`, no file needed, following the `check-rls-integrity.mjs`
   pattern this project already uses): constructs a known-good config in memory, asserts the
   checker passes it, then mutates it to add a `zpages` extension (a read-capable surface) and
   asserts the **same checker now fails** — proving the check would catch the exact regression it
   exists to catch, not just "look like it checks something."

**Verified how:** `node webdesk/ops/scripts/check-otlp-write-only.mjs --selftest` was run on this
dev machine — see the compose/scripts verification block in the final report for the actual exit
code. This proves the checker's *logic* is sound. It has **not** been run against a real Zone A
collector config, because that config does not exist yet (§4).

---

## 4. The Zone A listener itself — BLOCKED, outside this ticket's file ownership

This is the part of WSK-28 that structurally cannot be delivered by this ticket alone. The
ticket's file ownership is `webdesk/ops/`, `infra/runbooks/webdesk-*.md`, and
`webdesk/docker-compose*.yml` — **not** `infra/observability/` (the estate's actual Zone A
collector configs: `config.yaml`, `config.tier1-metrics.yaml`, `config.tier2-logs.yaml`) and
**not** `.github/workflows/` (owned this cycle by the CI/deploy agent). Standing up a real
write-only listener means:

1. A new receiver (or a wholly new collector instance — recommended, per §1.2) added to
   `infra/observability/otel-collector/config*.yaml`.
2. A bearer token minted and placed in Zone A's own secrets custody (not this ticket's to hold —
   Zone B's copy of that same token is the only half this ticket's `.env.example` may carry).
3. A firewall rule on whichever Zone A box terminates it, restricting source IPs to Zone B's
   egress.
4. Wiring into the existing WS9 Grafana stack so the ingested telemetry is actually visible
   somewhere (§02 diagram: `GRAF[WS9 Grafana stack<br/>+ OTLP ingest listener NEW]`).

**Deliverable of this ticket instead:** a complete, reviewable **proposal** —
`webdesk/ops/otel/proposed-zonea-otlp-listener.yaml` — written in the exact shape
`infra/observability/otel-collector/config.tier1-metrics.yaml` uses (same receiver/processor/
exporter/service block structure, same `memory_limiter` discipline), with inline comments marking
every place the write-only property depends on a choice made there. It is **not applied anywhere**
— applying it requires editing `infra/observability/`, which this ticket explicitly does not
touch. Whoever owns that directory (or the owner, directly) should review the proposal file,
apply it as a real addition to the Zone A observability stack, and re-run
`check-otlp-write-only.mjs` against the applied config as its own verification step before this
row can move past PLANNED.

---

## 5. Zone B env vars added (`.env.example` + compose `environment:`)

| Var | Purpose | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_HEADERS` | Bearer token for the Zone A write-only listener's `auth:` extension. Empty by default — fail-soft, same discipline as every other WSK-28-adjacent credential in this file | *(empty)* |
| `WEBDESK_OTEL_ZONEA_PUSH_ENABLED` | Explicit second gate, independent of `OTEL_ENABLED` — lets the dev-sink collector keep running locally while the real Zone A push stays off until an operator deliberately flips this, rather than the endpoint URL alone deciding it | `false` |

Both are additive to the existing `OTEL_ENABLED`/`OTEL_EXPORTER_OTLP_ENDPOINT` pair already wired
in `docker-compose.yml`'s `api` service — see the compose diff in the final report.

## 6. Status vocabulary reminder

Zone B's export leg config: **PLANNED** (values named, not yet pointed at a real target). The
write-only checker: **PROTOTYPED** (selftest driven and observed on this machine). The Zone A
listener: **BLOCKED** — proposal authored, application owned by whoever holds
`infra/observability/`, verification (an actual OTLP span landing in Zone A Grafana through the
listener) cannot happen before that application and before A-12.
