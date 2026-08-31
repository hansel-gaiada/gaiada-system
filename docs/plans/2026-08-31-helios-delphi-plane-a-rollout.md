# `helios`/`delphi` observability rollout — blackbox tier + alerting audience split

**Date:** 2026-08-31 · **Status: PLANNED.** Configs authored and cross-checked against the live
estate read-only; nothing has been applied to any server. AUTHORING-ONLY pass by design — see §7
for the exact apply/rollback steps, none of which have been run.
**Related:** [`docs/plans/2026-08-21-multi-server-observability.md`](2026-08-21-multi-server-observability.md)
§12 (the binding owner ruling this doc implements) · [`docs/plans/2026-08-18-observability-relocation.md`](2026-08-18-observability-relocation.md)
(why storage/alerting live on SumoPod) · `infra/runbooks/alerting-wire-a-real-receiver.md` (the
pre-existing, still-open alerting gap this doc extends) · `infra/observability/prometheus/proposed-client-properties-job.yml`
+ `infra/observability/scripts/gen-client-property-targets.mjs` (MON-01, now wired in here)

---

## 0. What this pass corrects before designing anything

The task that opened this pass assumed two things that turned out to be **stale or inverted**
relative to what is already ratified and dated in this repo. Both are corrected here rather than
carried forward silently, per this seat's own standard (surface conflicts, don't paper over them).

### 0.1 `helios`/`delphi` are NOT white-box (agent) targets — they are OBSERVE-ONLY

The task framed helios/delphi as "company boxes" to onboard with the full node-exporter +
otel-collector agent bundle. That is **prohibited by a binding, dated owner ruling**, recorded
twice and never reversed:

- `docs/plans/2026-08-21-multi-server-observability.md` §12, §12.0, §16 (owner, 2026-08-22 and
  2026-08-23): *"for now we shouldnt do anything to helios or delphi. we just want to have
  informations from it not actively control or modify it. full control is for production."*
  Installing node-exporter or an OTel collector, or adding a WireGuard peer, **is** a
  modification. This is a **timing** choice, not a permanent ceiling — full detail is the intended
  destination, "when we are ready" — but that readiness is a **new, separately-dated owner
  ruling**, and none has landed.
- `infra/runbooks/onboard-server.md` §0 states the same thing verbatim as a hard never-touch
  entry and instructs the runbook to abort if run against either host.

**Read-only inspection confirms why this matters in practice, not just on principle.** SSH probes
this pass (uname, `docker ps -a`, `ss -lntp`, `systemctl list-units`) on both hosts show:

| | `helios` | `delphi` |
|---|---|---|
| Docker containers | **0** | **0** |
| Web stack | native nginx + 10 PHP-FPM pools (7.1–8.5) | native nginx + 8 PHP-FPM pools (7.1–8.5) |
| CloudPanel | `clp-nginx.service`, `clp-php-fpm.service` running — confirms the design doc §13(a) hypothesis: "cloud panel" is literally CloudPanel CE | same |
| Datastores | MariaDB, Postgres, Redis, MinIO, Memcached, pgbouncer, Varnish — all bound `127.0.0.1` | same shape |

Both are **live, multi-client CloudPanel hosting boxes** — many PHP-FPM pools at different
versions is many different client sites/CMS stacks sharing one kernel. Installing an agent here
is not "add a sidecar to our infra" the way `gda-aicenter` onboarding would be; it is a change to
a box carrying an unknown number of live client sites, with zero rollback margin if it goes
sideways at 2am. The owner's caution reads as well-founded, not merely procedural, once you've
looked.

**So Job A, as literally specified in the task (white-box agent bundle on helios/delphi), is not
built here.** What *is* built is the **blackbox / observe-only tier** the design doc already
specified for exactly this situation (§12, MSO-11) — reachability, TLS-cert-expiry, latency —
which needs no install and no modification on either host. If the owner later grants full control,
`infra/runbooks/onboard-server.md` already documents the graduation path (`monitoring_tier` flips
`blackbox` → `agent`); nothing here blocks that, and nothing here should be read as a substitute
for it.

### 0.2 Client-site probing runs FROM SumoPod, not from `gda-aicenter`

The task's design constraint said to probe client sites **from `gda-aicenter`** ("where
blackbox-exporter already lives") specifically to keep the client inventory off SumoPod. That
inverts a decision the repo already made, in writing, one day before this pass
(`infra/observability/prometheus/proposed-client-properties-job.yml`, MON-01, header dated
2026-08-30):

> *"NOT the ERP box. It is Zone A, it holds the company database, and it has no business making a
> standing outbound connection to third-party infrastructure every 60 seconds. The ops/
> observability host is the natural home."*

Both concerns are real, but they constrain **different things**, and MON-01's design already
reconciles them without contradiction:

- **"Client inventory must never live on SumoPod"** is about where `DATABASE_URL` / the full
  `search_properties` table lives. It stays on `gda-aicenter`, which already has it — nothing
  changes here.
- **"Probing should not originate from `gda-aicenter`"** is about which box's IP shows up in ~63
  clients' access logs making a scheduled GET every 60s, and which box's egress posture a
  compromise of the prober would inherit. `gda-aicenter` holds the platform DB; it has no business
  making that standing connection. SumoPod is already the estate's telemetry egress point.

The seam between them is `gen-client-property-targets.mjs`, which already exists and already
does exactly this: it runs the DB query, and only the **already-minimized** output (site URL +
`property_domain`/`tenant_id`/`client_id`, per `toFileSd()` — never the full row, never
`DATABASE_URL`) crosses to the probing host. §3 below wires that seam up; it does not invent it.

**This pass follows the dated, already-reviewed repo design (probe from SumoPod), not the task's
inverted assumption, and states so explicitly rather than silently picking one.**

---

## 1. What was verified read-only this pass (no server was modified)

| Host | Check | Result |
|---|---|---|
| `helios` | `uname -a`, `docker ps -a`, `ss -lntp`, `systemctl list-units` | Ubuntu 24.04-class kernel (6.8.0-136), **0 containers**, CloudPanel + native nginx/PHP-FPM/MariaDB/Postgres/Redis/MinIO, port 8443 (CloudPanel UI) `0.0.0.0` |
| `delphi` | same | **0 containers**, CloudPanel + native stack, ports 80/443/8443 `0.0.0.0`, `monarx-agent` present (third-party malware scanner, not ours) |
| `sumopod` | `docker ps --filter name=gaiada-obs`, `df -h /` | 7 `gaiada-obs-*` containers, all `Up 8-12 days` — matches `docker-compose.obs-remote.yml` exactly, nothing extra. **52G free / 76% used** — worth flagging (§6) but not this pass's blocker |
| `gda-aicenter` | (config read only, no SSH needed — otel-collector config already in repo) | `blackbox-http` is the only existing blackbox job; `job` label alone is enough to keep it from colliding with the two new jobs added here |

No packet was sent toward `helios` or `delphi` beyond the SSH session itself (which the owner's
own re-probe on 2026-08-30 already established is safe: SSH is filtered, HTTP/HTTPS answer). No
blackbox probe of either host's endpoints happened, because none has been named yet (§4, OQ-6).

---

## 2. Design — two tiers, two audiences, one hub

```
                              gda-aicenter (10.88.0.1) — Zone A, has the DB
                              ────────────────────────────────────────────
                              gen-client-property-targets.mjs (cron, §3)
                              reads search_properties, writes a MINIMAL
                              json file (domain/tenant/client/url only)
                                        │
                                        │ rsync — ONE small file, over the
                                        │ existing SSH/WireGuard path
                                        ▼
   SumoPod hub (10.88.0.2) — ops, already the telemetry egress point
   ─────────────────────────────────────────────────────────────────
   blackbox-exporter (NEW, this rollout)          Prometheus (existing, gaiada-obs)
     scraped by the local Prometheus                 job blackbox-estate  ← helios/delphi
     publishes nothing                               job client-properties ← MON-01 client sites
                                                       (both probed FROM HERE, never from
                                                        gda-aicenter or the client's own box)
                       │                                         │
                       ▼                                         ▼
              Alertmanager (existing)                   Alertmanager (existing)
              EstateProbeDown → EXISTING                ClientPropertyDown → NEW
              production/staging routing                account-managers receiver
              (engineering pager)                        (different transport, different SLA)

   helios (production, CloudPanel, MANY client sites) ◀── probed, never touched
   delphi (staging, CloudPanel, MANY client sites)     ◀── probed, never touched
```

### 2.1 White-box vs black-box, restated correctly against this estate's actual nouns

The task framed the split as "white-box for company boxes" vs "black-box for client servers /
cPanel". Having read the estate's own design doc, the real split has **three** buckets, and the
task's two collapse two genuinely different things into one:

| Bucket | Hosts | Tier | Audience |
|---|---|---|---|
| Plane A, fully owned | `gda-aicenter`, `sumopod` | **agent** (already DEV-VERIFIED) | engineering |
| Plane A, observe-only | `helios`, `delphi` | **blackbox** (this rollout, MSO-11) | engineering — these are OUR hosting boxes, even though we can only probe them |
| Plane B, clients' own sites | ~63 `search_properties` rows | **blackbox** (this rollout, MON-01) | **account managers** — these are not our infrastructure at all |

The task's "black-box for client servers/cPanel" language actually names the Plane B bucket
(client sites, wherever they are hosted — cPanel, Hostinger, anything). `helios`/`delphi`
themselves are **our own** hosting infrastructure (Plane A) that happen to be blackbox-tier for
now — their alerts still belong to engineering, not account managers, because "helios is
unreachable" is our hosting business being down, not one client's site being down. Both use the
same exporter and the same hub, but they must never share a receiver — §2.2 is why.

### 2.2 The alerting audience split (the task's real ask)

- **`EstateProbeDown`** (`helios`/`delphi` reachability) uses `severity=page`/`ticket` — the
  **existing** production/staging routing tree in `alertmanager.yml` (MSO-02, already
  DEV-VERIFIED against the remote). No new receiver. `helios` (env=production) pages engineering;
  `delphi` (env=staging) tickets. This is System health, exactly as the task asked, just delivered
  via probes instead of an agent because that is all the current ruling allows.
- **`ClientPropertyDown`/`ClientPropertyCertExpiringSoon`** (client sites) use **new** severities
  `client_page`/`client_ticket`, spelled deliberately differently from `page`/`ticket` so they
  cannot collide with the engineering routes by matcher accident, and route to a **new**
  `account-managers` receiver with its own webhook/email transport
  (`AM_ALERT_WEBHOOK_URL`/`AM_ALERT_EMAIL_TO`) — never Telegram to the on-call engineer's phone.
  This is Client site health, and it now has a real, distinct SLA path instead of falling into
  `default-multi` alongside engineering tickets (which — per
  `infra/runbooks/alerting-wire-a-real-receiver.md` — was the receiver that silently swallowed
  `GatewayBudgetNearCap` and `SyntheticJourneyFailing` for 24h+ because its transports were all
  placeholders).

Full diffs: `infra/observability/alertmanager/alertmanager.yml`,
`infra/observability/prometheus/rules/alerts-estate.yml`.

### 2.3 The dead-man's-switch — closing the "who notices if SumoPod dies" gap

The 2026-08-18 relocation moved storage/alerting to SumoPod specifically so `gda-aicenter` dying
no longer takes the alerter with it (`Watchdog` → `deadmansswitch` → an external healthchecks.io
ping). That inverted the risk without eliminating it: **if SumoPod dies, the box that would have
noticed is the box that died.** The existing `Watchdog`/`DEADMANSSWITCH_URL` heartbeat still
covers "Prometheus/Alertmanager stopped evaluating rules" — but it originates FROM SumoPod, so a
total box or network failure could in principle take the heartbeat out before it fires.

**Added this pass:** a second, genuinely outside observer. `gda-aicenter`'s existing out-of-band
cron (`infra/scripts/healthcheck.sh` — already "the WS9 D15 OUT-OF-BAND alerter, deliberately
independent of the Prometheus/Alertmanager pipeline") now also actively polls SumoPod's
Alertmanager (`http://10.88.0.2:9093/-/healthy`) over the live WireGuard link every 5 minutes,
using the **host's** curl (not the bot container — `10.88.0.2` is on the host's `wg0` interface,
not the container network namespace, so an exec-based check would silently always fail). On
failure it alerts immediately over the same Telegram/email transports as the local checks — it
does not wait for SumoPod's own heartbeat to go silent, which would be strictly slower. On success
it pings a **second, separate** dead-man's-switch (`SUMOPOD_DEADMANSSWITCH_URL` — its own
healthchecks.io check, distinct from `DEADMANSSWITCH_URL`), so "gda-aicenter's cron died" and
"gda-aicenter can't reach SumoPod" stay individually diagnosable.

Net result: two independent legs, from two different boxes, to two different external checks —
SumoPod dying is now detected by (a) its own heartbeat going silent AND (b) gda-aicenter's active
poll failing loudly within 5 minutes, whichever notices first.

---

## 3. Files changed/added this pass

| File | Change |
|---|---|
| `infra/observability/prometheus/rules/alerts.yml` | `ServiceDown` scoped to `job="blackbox-http"` — an unscoped `probe_success == 0` would have paged engineering for a client site timing out |
| `infra/observability/prometheus/rules/alerts-estate.yml` | **NEW.** `EstateProbeDown`, `EstateProbeCertExpiringSoon` (Plane A blackbox), `ClientPropertyDown`, `ClientPropertyCertExpiringSoon` (Plane B) |
| `infra/observability/prometheus/prometheus.remote.yml` | Two new scrape jobs on the SumoPod Prometheus: `blackbox-estate` (file_sd, starts empty — OQ-6 blocks population) and `client-properties` (file_sd, generated file, MON-01 now wired in rather than left proposed) |
| `infra/observability/prometheus/targets/blackbox-estate.json` | **NEW.** `[]` — intentionally empty; see `targets/README.md` for why and the format once the owner names endpoints (OQ-6) |
| `infra/observability/prometheus/targets/README.md` | **NEW.** Explains both target files' provenance and the consent/naming gates |
| `infra/compose/docker-compose.obs-remote.yml` | **NEW** `blackbox-exporter` service (SumoPod, publishes nothing); Prometheus now mounts `targets/`; alertmanager env gets `AM_ALERT_WEBHOOK_URL`/`AM_ALERT_EMAIL_TO` |
| `infra/observability/alertmanager/alertmanager.yml` | New route for `severity=~"client_page\|client_ticket"` → new `account-managers` receiver |
| `infra/compose/.env.example` | Documents `AM_ALERT_WEBHOOK_URL`, `AM_ALERT_EMAIL_TO`, `SUMOPOD_OBS_URL`, `SUMOPOD_DEADMANSSWITCH_URL` |
| `infra/scripts/healthcheck.sh` | Extended with the outside-SumoPod dead-man's-switch leg (§2.3) |
| `infra/scripts/sync-client-property-targets.sh` | **NEW.** Runs the generator on `gda-aicenter`, rsyncs only the minimal output to SumoPod |
| `infra/runbooks/enable-estate-blackbox-and-alert-routing.md` | **NEW.** Exact apply commands + verification + rollback, per box |

Nothing in `infra/observability/blackbox/blackbox.yml` needed changing — `http_2xx` already covers
both new jobs and already exports `probe_ssl_earliest_cert_expiry` for free.

---

## 4. What is deliberately NOT done here, and why

- **No agent bundle, no WireGuard peer, no `authorized_keys` change on `helios`/`delphi`.** §0.1.
- **`targets/blackbox-estate.json` ships empty.** Populating it needs owner-named endpoints
  (OQ-6, `docs/plans/2026-08-21-multi-server-observability.md` §10/§15.1) — this estate does not
  port-scan or crawl to discover what to probe. Until named, this job scrapes nothing and fires
  nothing, which is correct, not broken.
- **`AM_ALERT_WEBHOOK_URL`/`AM_ALERT_EMAIL_TO` are not filled with real values here.** Per
  `infra/runbooks/alerting-wire-a-real-receiver.md`'s own lesson, a receiver with placeholder
  transports is worse than no receiver — it looks configured while delivering nothing. Someone
  with the account-manager team's actual contact channel has to fill these in; picking a channel
  is a business decision, not something this pass should assume on the owner's behalf.
- **`DEADMANSSWITCH_URL`/`SUMOPOD_DEADMANSSWITCH_URL` are not minted here.** Creating a real
  healthchecks.io/Cronitor check is a two-minute human action with no technical blocker; doing it
  as a side effect of an authoring-only pass would create a credential nobody reviewed.
- **No `infra_hosts` row, no `monitoring_tier` migration.** MSO-04/MSO-09 are senior-db tickets in
  the design doc, out of this seat's scope, and the blackbox job here does not need the DB — the
  target file's static `host`/`env` labels are sufficient for MVP alerting (§2.2), exactly as
  MSO-11 specified before the migration lands.
- **Nothing executed against `sumopod`.** All verification in §1 was read-only (`docker ps`,
  `df -h`). No compose command was run.

---

## 5. Verification plan (to run when the owner approves applying this)

Full commands in `infra/runbooks/enable-estate-blackbox-and-alert-routing.md`. Summary:

1. `docker compose -f docker-compose.obs-remote.yml config -q` — dry-run parse on SumoPod before
   touching anything live.
2. `promtool check rules` on `alerts.yml` + `alerts-estate.yml` (scoped `ServiceDown` change and
   the four new rules) — 21 rules expected (19 existing + `ServiceDown` unchanged count + 4 new
   minus nothing removed — exact number recorded in the runbook's own output, not guessed here).
3. `amtool check-config` on the updated `alertmanager.yml`; `amtool config routes test` for
   `severity=client_page` and `severity=client_ticket` → `account-managers`, confirming neither
   matches `page-all`/`default-multi`.
4. `docker compose -p gaiada-obs -f docker-compose.obs-remote.yml up -d blackbox-exporter` —
   scoped to the one new service, never `--remove-orphans` bare.
5. `docker ps -a` diff on SumoPod before/after: exactly one container added
   (`gaiada-obs-blackbox-exporter-1`).
6. Once OQ-6 names endpoints and `targets/blackbox-estate.json` gets real entries: confirm
   `probe_success{job="blackbox-estate"}` appears with the right `host`/`env` labels, and that
   stopping the exporter turns the target `dark` within `RemoteWriteStalled`'s existing 10-minute
   window.
7. Fire a synthetic `client_page` alert via Alertmanager's API (same technique as
   `alerting-wire-a-real-receiver.md` §5) and confirm it reaches the `account-managers` transport
   and **not** any engineering transport.

---

## 6. Things noticed in passing, not fixed here

- **SumoPod is at 76% disk (52G free / 217G)**, up from the 50% measured at the 2026-08-18
  relocation. Not urgent, but `DiskSpaceLow`'s 15%-free threshold means there is real headway
  left, not infinite headway — worth a look next time anyone is on that box, not a blocker for
  this rollout (adding one blackbox-exporter container and two small target files is a rounding
  error against 52G).
- **`infra/CLAUDE.md` changed on disk mid-pass** (a concurrent session's 2026-08-31 workload
  consolidation plan, moving Postiz from SumoPod back to `gda-aicenter`). That plan's own text
  states observability stays on SumoPod, consistent with the CONTEXT this task was given — flagged
  here only because the shared checkout moved under this pass, per this repo's own standing
  caution, not because it changes anything designed above.
- **`RemoteWriteStalledLegacySingleHost`** (the belt-and-suspenders single-host rule from MSO-02)
  is still present alongside the generalized `RemoteWriteStalled`. Design doc §8 already tracks
  its retirement as a separate, later step once the generalized rule has run a full cycle without
  disagreeing — not touched here.
