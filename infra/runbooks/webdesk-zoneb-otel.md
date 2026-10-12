# Runbook — WebDesk telemetry: the one narrow exception (WSK-D63 (2), M4 T6a)

**Status: BUILT on branch `webdesk/m4-t6a-otlp`, NOT YET DEPLOYED. Config validated with `otelcol-contrib validate`
and driven end to end on a throwaway collector (token refusal, tagging, rate limit); the guard harness and the live
probe are still to run on `sumopod` / `gda-aicenter`. Nothing below is DEV-VERIFIED until the rollout's step (e).**

Decision: `docs/blueprints/webdesk-design-v2.md` §14, WSK-D63 (2). Design rule (§03 channel 2): *write-only bearer +
TLS; rate-limited; no query surface; fail-soft on the WebDesk side.*

---

## 1. The decided path

WebDesk's `api` pushes OTLP to a **second, write-only receiver on the ERP's existing `otel-collector`**. The collector
forwards it to sumopod over WireGuard exactly as it already does for the ERP.

```
webdesk api ──OTLP/HTTP + bearer──▶ 172.17.0.1:4319 ──(DNAT)──▶ gaiada-otel-collector-1 :4319 (otlp/webdesk)
 (webdesk_default)    egress guard allows ONLY this                 │ memory_limiter/webdesk → resource/webdesk
                      address:port, TCP                             │ → tail_sampling (traces) → batch
                                                                    ▼
                                         otlp/tempo (traces)  /  otlphttp/loki (logs)  ──WireGuard──▶ sumopod 10.88.0.2
```

| | |
|---|---|
| **Receiver** | `otlp/webdesk`, OTLP/**HTTP** only, container port **4319** (not 4317/4318, so a firewall rule or an audit can name it) |
| **Published** | `172.17.0.1:4319:4319` — the docker0 address, both sides literal in `infra/compose/docker-compose.observability.yml`. Never `0.0.0.0`, never a `${VAR}` that could resolve empty |
| **Auth** | `bearertokenauth/webdesk`, token from `WEBDESK_OTLP_BEARER_TOKEN`. A missing/wrong token is a 401 before any body is read |
| **Signals** | traces and logs. **No metrics pipeline**: the only metrics exporter is the Prometheus endpoint the ERP's alert rules read, and an untrusted sender must not mint series there (design §03: metric poisoning / alert fatigue). A metrics push gets 404 |
| **Tagging** | `resource/webdesk` **upserts** `service.namespace=webdesk` and `gaiada.ingest=otlp-push/webdesk`, so a sender cannot claim another namespace (driven: a sender-supplied `service.namespace=spoofed` came out as `webdesk`) |
| **Reads** | none. No extension besides `file_storage` and the bearer; the ERP receivers (4317/4318), self-metrics (8888) and the Prometheus exporter (8889) are not published |
| **ERP pipelines** | untouched. The webdesk pipelines are `traces/webdesk` and `logs/webdesk`, separate from `traces`, `metrics`, `metrics/scrape`, `logs` |

### Empty token means refuse, never open

`bearertokenauth` **refuses to start** on an empty token (`no bearer token provided`), which would crash-loop the ERP's
own collector on a release that precedes minting the token. The obvious fix, a known placeholder, is an open door:
it was tried on 2026-10-11 and a request carrying exactly the placeholder text was accepted (200). So compose passes
`"${WEBDESK_OTLP_BEARER_TOKEN:-\x01}"`: when the variable is empty or unset the token is the lone control character
U+0001, which no HTTP client can send (the server answers 400 to a header carrying it). Driven against the real
config: with that default, no header, `Bearer`, `Bearer ` and a wrong token all got 401 and the collector stayed up.
Compose rejects a newline in a default, hence U+0001. **Do not "simplify" it**: `check-otlp-write-only.mjs` fails CI
if the default changes. Mint tokens as plain strings starting with a letter (`wdotlp_` + hex).

### Rate limiting: what is used and what it bounds

The pinned collector (0.116.1) has no rate-limit processor. Three bounds, none of them a per-sender request quota:

1. **Traces: `tail_sampling/webdesk` with a `rate_limiting` policy, 500 spans/second** (decision wait 5 s, 5000 traces in
   memory). Driven: 6001 spans sent in three requests, 499 exported.
2. **Everything: `max_request_body_size` 4 MiB** on the receiver, and `memory_limiter/webdesk` (1024 MiB limit, 256 MiB
   spike) which checks the whole collector's heap, so WebDesk is shed first while the ERP's own limiter (80% of the
   host) keeps going. This is a pressure valve, not a rate.
3. **Network: a per-source packet-rate cap in the egress guard** (`hashlimit`, default 300 packets/s, burst 600,
   `WEBDESK_OTLP_PPS`; 0 disables). It bounds bandwidth for traces and logs alike. If the module is missing the guard
   does **not** apply the exception at all.

**Logs have no per-second cap in the collector**; they are bounded by 2 and 3. If log volume ever matters, filter by
severity in WebDesk first.

### TLS on the docker0 hop: not used, and why

Optional per the ruling. Skipped, deliberately:
- The hop never crosses a NIC: webdesk bridge → host (DNAT) → `gaiada_default`. Only the collector's own bridge segment
  sees the post-DNAT packet, and that segment is ERP containers.
- WebDesk containers run `cap_drop ALL`, so they cannot sniff; a host-root attacker already has everything.
- The token authorises one thing: writing traces and logs into a namespace-stamped, rate-bounded path. Replay value is low.
- TLS would add a CA, a server cert and a rotation to the ERP collector, and a trust anchor into the webdesk image,
  for a hop that is private by construction.

**Revisit (TLS becomes mandatory) if** the receiver is ever published beyond docker0, the two projects move to
different hosts, or the token's reach grows beyond write-only telemetry. `check-otlp-write-only.mjs` already refuses a
publish on any other address.

### What is still open

- **The api's SDK sends TRACES only** (§7; on main since `2d90332a`): an HTTP/protobuf exporter, with `Authorization`
  from `OTEL_EXPORTER_OTLP_HEADERS`, off unless both flags and an endpoint are set. Step (d) therefore delivers traces;
  step (e) can still use the hand-driven push below to test the receiver on its own.
- **Logs.** The collector accepts a logs pipeline because the ruling allows logs, but the api sends none. Zone-B logs
  may carry client-site content, so adding a logs exporter is its own reviewed change.

---

## 2. Files

| File | Role |
|---|---|
| `infra/observability/otel-collector/config.yaml` | `otlp/webdesk`, `bearertokenauth/webdesk`, `memory_limiter/webdesk`, `resource/webdesk`, `tail_sampling/webdesk`, `traces/webdesk`, `logs/webdesk` |
| `infra/compose/docker-compose.observability.yml` | the docker0-only publish and the token variable with its unsendable default |
| `infra/compose/.env.example`, `webdesk/.env.example` | `WEBDESK_OTLP_BEARER_TOKEN` (ERP) / `OTEL_EXPORTER_OTLP_*` (WebDesk), empty-means-refuse stated |
| `webdesk/ops/host/webdesk-egress-guard.sh` | the exception, off unless `WEBDESK_OTLP_PORT` is set or `apply --otlp` is passed |
| `webdesk/ops/host/webdesk-host-deny.service` | reads `/etc/webdesk/guard.env` (optional) so the exception survives a reboot |
| `webdesk/ops/host/test-egress-guard.sh` | proves it on a throwaway network with stand-in listeners |
| `webdesk/ops/probes/containment-probe.sh` | probe 6 allows exactly `<docker0>:<port>`, only while the guard has it on |
| `webdesk/ops/scripts/check-otlp-write-only.mjs` | static auditor, run in CI (`observability-lint`) against the real config and compose file |

The guard's two rules (port 4319; the address is `WEBDESK_OTLP_ADDR`, default `172.17.0.1`):

```
-A WEBDESK-EGRESS -p tcp -m conntrack --ctorigdst 172.17.0.1 --ctorigdstport 4319 -m hashlimit --hashlimit-name wd-otlp-fwd --hashlimit-mode srcip --hashlimit-above 300/second --hashlimit-burst 600 -j DROP
-A WEBDESK-EGRESS -p tcp -m conntrack --ctorigdst 172.17.0.1 --ctorigdstport 4319 -j RETURN
-A WEBDESK-HOST-IN -d 172.17.0.1 -p tcp --dport 4319 -m hashlimit --hashlimit-name wd-otlp-in --hashlimit-mode srcip --hashlimit-above 300/second --hashlimit-burst 600 -j DROP
-A WEBDESK-HOST-IN -d 172.17.0.1 -p tcp --dport 4319 -j RETURN
```

Both sit before the chains' other rules. The FORWARD pair matches the **original** destination because a published port
is reached by DNAT (the 172.16/12 drop would otherwise kill it); the INPUT pair covers docker's userland proxy.

---

## 3. Rollout (order matters; each step is safe to stop after)

**(a) Ship the collector change with the next ERP release.** The collector is recreated (a short gap; the Tempo/Loki
queues are on disk). With the token empty the receiver refuses everything. After the deploy, on `gda-aicenter`:

```bash
docker ps --filter name=gaiada-otel-collector-1 --format '{{.Status}}  {{.Ports}}'      # ... 172.17.0.1:4319->4319/tcp
ss -ltn | grep ':4319'                                                                   # bound to 172.17.0.1 only
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer anything' -d '{"resourceSpans":[]}' http://172.17.0.1:4319/v1/traces      # 401
```

**(b) Mint the token and set it in BOTH env files** (never echo it into a shared log):

```bash
TOKEN="wdotlp_$(openssl rand -hex 24)"
# ERP:     /home/Hansel/gaiada/infra/compose/.env       WEBDESK_OTLP_BEARER_TOKEN=$TOKEN
# WebDesk: /etc/webdesk/.env                            OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer $TOKEN
```

Recreate only the collector, with the deploy's own `COMPOSE_FILES` set (it has a literal image pin and no
`depends_on`, so the stale-tag footgun cannot move anything else; confirm only that one container is recreated):

```bash
cd /home/Hansel/gaiada/infra/compose && docker compose -p gaiada $COMPOSE_FILES up -d --no-deps --no-build otel-collector
# now: wrong token 401, right token 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"resourceSpans":[]}' http://172.17.0.1:4319/v1/traces                                          # 200
```

**(c) Apply the guard with the port.** First run the harness where it is safe (the orchestrator runs it on `sumopod`):
`bash webdesk/ops/host/test-egress-guard.sh webdesk/ops/host/webdesk-egress-guard.sh`. Then on `gda-aicenter`:

```bash
sudo install -m 0755 webdesk/ops/host/webdesk-egress-guard.sh /usr/local/sbin/webdesk-egress-guard.sh
sudo install -m 0644 webdesk/ops/host/webdesk-host-deny.service /etc/systemd/system/webdesk-host-deny.service
printf 'WEBDESK_OTLP_PORT=4319\n' | sudo tee /etc/webdesk/guard.env >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart webdesk-host-deny.service
sudo /usr/local/sbin/webdesk-egress-guard.sh status          # the four rules above
```

**(d) Switch WebDesk's OTel on.** In `/etc/webdesk/.env`: `OTEL_ENABLED=true`, `WEBDESK_OTEL_ZONEA_PUSH_ENABLED=true`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://172.17.0.1:4319`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, the headers line from (b).
Then recreate the api without building, with ALL THREE files (since release 357 the api runs on the release
overlay; the two-file form would swap it back to a stale local `webdesk-api:latest`):

```bash
cd /home/Hansel/gaiada-webdesk/webdesk && sudo docker compose --env-file /etc/webdesk/.env -p webdesk \
  -f docker-compose.yml -f docker-compose.aicenter.yml -f docker-compose.aicenter-release.yml up -d --no-build --no-deps api
```

(The api's traces SDK, §7, is what this step turns on.)

**(e) Verify.** Hand-driven push from inside the guarded network (works with or without the SDK):

```bash
docker run --rm --network webdesk_default -e TOK="$TOKEN" node:22-alpine node -e '
  const b={resourceSpans:[{resource:{attributes:[{key:"service.name",value:{stringValue:"webdesk-api"}}]},scopeSpans:[{spans:[{traceId:"0af7651916cd43dd8448eb211c80319c",spanId:"b7ad6b7169203331",name:"t6a-rollout-probe",kind:1,startTimeUnixNano:"1760000000000000000",endTimeUnixNano:"1760000001000000000"}]}]}]};
  fetch("http://172.17.0.1:4319/v1/traces",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.TOK},body:JSON.stringify(b)}).then(r=>console.log(r.status));'
```

Expect `200`. About 20 s later, on sumopod's Grafana: Tempo `{ resource.service.namespace = "webdesk" }` shows
`t6a-rollout-probe`; Loki `{service_namespace="webdesk"}` shows webdesk logs once the api emits any (label name is
Loki's OTLP mapping of `service.namespace`; confirm in Explore). Then the live probe, which must show **exactly one**
extra open host port:

```bash
sudo WEBDESK_OTLP_PORT=4319 bash webdesk/ops/probes/containment-probe.sh      # probe 6: "OTLP exception: 172.17.0.1:4319 answers", no FAIL
```

## 4. Rollback (each step independent, fastest first)

1. **Close the door:** `sudo rm /etc/webdesk/guard.env && sudo systemctl restart webdesk-host-deny.service` — the guard is pure
   default-deny again; WebDesk's pushes fail soft.
2. **Stop the sender:** `OTEL_ENABLED=false` in `/etc/webdesk/.env`, recreate the api as in (d).
3. **Refuse at the receiver:** blank `WEBDESK_OTLP_BEARER_TOKEN` in the ERP env, recreate the collector as in (b); the receiver answers 401 to everything.
4. **Remove it:** revert the ERP commit and release; the publish and the receiver disappear. Nothing else changes.

## 5. The check (`webdesk/ops/scripts/check-otlp-write-only.mjs`)

A static auditor with a selftest (23 cases, each a mutation that must be caught). Against the real files
(CI job `observability-lint`):

```bash
node webdesk/ops/scripts/check-otlp-write-only.mjs infra/observability/otel-collector/config.yaml \
  --receiver otlp/webdesk --compose infra/compose/docker-compose.observability.yml --service otel-collector
```

It fails if: the receiver has no bearer authenticator, or names an undefined one; the token is a literal; a read-capable
extension (`zpages`, `pprof`, `health_check`, ...) exists; the receiver feeds a metrics pipeline, shares a pipeline, feeds
a Prometheus exporter, lacks a leading `memory_limiter` or the `service.namespace` upsert; two receivers share a port;
compose publishes anything but `172.17.0.1:<port>:<port>`, uses host networking, or changes the empty-token default.
It is static: the live proofs are the guard harness, probe 6 and the step (e) pushes.

## 6. Env vars

| Var | Where | Meaning |
|---|---|---|
| `WEBDESK_OTLP_BEARER_TOKEN` | ERP `infra/compose/.env` | the receiver's token. **Empty = refuse everything** |
| `OTEL_EXPORTER_OTLP_HEADERS` | WebDesk `/etc/webdesk/.env` | `Authorization=Bearer <same token>`; empty = no credential sent, nothing delivered |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_PROTOCOL` | WebDesk | `http://172.17.0.1:4319` / `http/protobuf` in production; the dev sink defaults stay |
| `OTEL_ENABLED`, `WEBDESK_OTEL_ZONEA_PUSH_ENABLED` | WebDesk | two independent gates, both default false |
| `WEBDESK_OTLP_PORT`, `_PPS`, `_ADDR` | `/etc/webdesk/guard.env` (systemd) | guard: exception port (unset = off), packets/s cap (300, 0 = none), docker0 address (172.17.0.1) |

## 7. The api's OTel SDK: traces only, fail-soft (M4)

**Where.** `webdesk/api/src/telemetry/` (entry `index.ts`, called first by `src/main.ts`). Tests: `webdesk/api/test/telemetry-*.spec.ts`.

**Gate: off unless all three hold.** `OTEL_ENABLED` is `true`/`1`, `WEBDESK_OTEL_ZONEA_PUSH_ENABLED` is `true`/`1`, and
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is a valid http(s) URL. Parsing is strict: empty,
unset, `false`, `0`, `yes`, `on`, anything else is OFF (an empty env var never becomes a value). A protocol other than
`http/protobuf` in `OTEL_EXPORTER_OTLP_PROTOCOL` also keeps it off. Off means the SDK module is not imported, nothing is
patched, no timer runs. A fault while starting is one warning line and the api boots normally.

**What it sends.** Traces only, OTLP/HTTP protobuf to `<endpoint>/v1/traces`, `Authorization` from
`OTEL_EXPORTER_OTLP_HEADERS` verbatim. No logs exporter, no metrics reader. Resource: `service.name=webdesk-api`,
`service.version` (from `package.json`), `service.namespace=webdesk` (the collector upserts it anyway). Spans: inbound HTTP
(`GET /v1/*`, method, status, route, scheme, host) and the Fastify route span; `pg` queries and `ioredis` commands made
INSIDE a request (query text with `$n` placeholders, redis command NAME only); outbound `fetch` (webhooks, events bridge,
Turnstile) made inside a request, with the URL reduced to scheme, host and `/[redacted]`. Queue/timer work with no request
parent produces no spans. Bounded: queue 512 spans, batch 128, export every 5 s, 2.5 s request timeout, 3 s batch timeout.

**What it never sends.** Applied to every span in one place, the exporter wrapper (`sanitizing-exporter.ts`, rules in
`redact.ts`), so it covers whatever any instrumentation records:
- bearer tokens in URL paths: `/v1/t/<slug>/preview/<token>` and `/v1/t/<slug>/media/upload/<token>` become `.../[redacted]`
  in `url.path`, `url.full`, `http.target`, `http.url`, `http.route`, the span name, and any other string on a span or event
  (the same rule `redactPreviewToken` uses for logs, plus a backstop for any 43-character base64url path segment);
- query strings (`url.query` is dropped, and the query is cut from every URL/target attribute), URL userinfo, fragments;
- request/response bodies and ALL header attributes (Authorization, Cookie, x-api-key, the control gate header);
- caller identity: client address/port, user agent, and the peer address of inbound connections;
- SQL parameter values (`enhancedDatabaseReporting: false`), redis arguments, exception messages and stack traces, span
  status messages (database errors quote values), the handler source text `@fastify/otel` would record, connection strings.
Trace context is not propagated in either direction (an inbound `traceparent` is ignored; none is injected outbound).

**Failure behaviour.** A refused, hung, erroring or slow collector drops spans; requests are unaffected. The exporter wrapper
turns every failure into a result code and logs one rate-limited line (`[webdesk:otel] trace export failed ...`, no URL or
token) per minute. SIGTERM flushes through the Nest shutdown hooks (`TelemetryModule`), bounded to 5 s.

**Enable (after rollout steps (a)-(c) above).** In `/etc/webdesk/.env`:
```
OTEL_ENABLED=true
WEBDESK_OTEL_ZONEA_PUSH_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://172.17.0.1:4319
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <the token from step (b)>
```
Recreate the api (step (d)). Expect `[webdesk:otel] tracing on (OTLP/HTTP protobuf, traces only)` in `docker logs`, then Tempo
`{ resource.service.name = "webdesk-api" }` within ~20 s of a request. Every request is sampled (the collector's 500 spans/s tail limit is the cap; no head sampler is configured). Roll back with
`OTEL_ENABLED=false` and a recreate. Cost: about 24 MB of node_modules (38 packages) in the image, roughly 30 MB RSS when on, nothing when off.

## 8. Live (2026-10-12): turned on, owner-approved

- (a) release 359 shipped the receiver: `172.17.0.1:4319`, 401 without a token.
- (c) the guard exception was applied at 02:23 CST: the four rules, with 4319 open from `webdesk_default` and 5432/4318
  still blocked.
- (b) a token was minted into both env files, with backups `*.bak-otel-20261012T022357Z`. Only the collector was
  recreated: a wrong token gives 401, the right one 200. The ERP `.env` is still shell-sourceable.
- (d) the api was recreated on the release overlay: `[webdesk:otel] tracing on (OTLP/HTTP protobuf, traces only)`,
  0 restarts.
- (e) 12 `webdesk-api` traces were in sumopod's Tempo within minutes (`{ resource.service.namespace = "webdesk" }`).
  A preview request with a fake 43-character token and a query-string secret is stored as
  `/v1/t/gaiada/preview/[redacted]`: 0 occurrences of either secret in any trace.
- Containment probes: 40/40 with `WEBDESK_OTLP_PORT=4319`. The OTLP exception is the only extra host port. Probe 6
  lists the bearer as shared by design: write-only, telemetry only.
