# Runbook — WebDesk public status page

## LIVE path (M4 T6b, 2026-10-11): `https://status.erp.gaiada.com`, served from sumopod

**Status: DEV-VERIFIED 2026-10-11.** Served from **sumopod**, never from the box it reports on (WSK-D64). It is
routed through the shared `erp-edge` Traefik on sumopod (WSK-D71, which amended D70's per-name file in mimi; cut over 2026-10-12 18:52Z). The design below this section (an in-project
`status-page` service on the WebDesk box, fed by its own health probes) is superseded and kept for its reasoning.

| Piece | Where |
|---|---|
| DNS | `status.erp.gaiada.com` CNAME `sumopod.erp.gaiada.com` (owner, 2026-10-11) |
| TLS + route | `erp-edge` (Traefik, `~/erp-edge`, repo `infra/sumopod/erp-edge/`): route file `~/erp-edge/dynamic/erp-status.yml` = `infra/sumopod/erp-edge/dynamic/erp-status.yml`; erp-edge's own Let's Encrypt certificate (resolver `erp-le`, TLS-ALPN-01). mimi's Traefik only passes `*.erp.gaiada.com` through, untouched (one file, `erp-passthrough.yml`). Runbook: `infra/runbooks/erp-edge-sumopod.md` |
| Page | compose project `erp-status` in `~/erp-status` (= `webdesk/ops/status-page/`): `web` (Caddy, read-only, cap_drop ALL + NET_BIND_SERVICE) published ONLY on `172.17.0.1:18480`; `renderer` (Node, read-only, cap_drop ALL) on the obs network only |
| Data | sumopod's own Prometheus. `blackbox-webdesk-api` probes `/v1` for its 401 problem+json (the api itself answers); `blackbox-estate` probes `/healthz` (Caddy alone answers). Alerts: `WebDeskApiDown`, `EstateProbeDown` |

The renderer writes `index.html` + `status.json` every 60 s. A probe silent for 5 min, or a Prometheus that does
not answer, renders as **unknown**, never green. Nothing internal (hosts, addresses, error text) is published.

**Deploy or update:**
- Copy `webdesk/ops/status-page/` to `~/erp-status`, with LF only, then `docker compose up -d`.
- The route file belongs to erp-edge (`infra/sumopod/erp-edge/dynamic/erp-status.yml`); its file provider watches the directory.
- To remove the page: delete `erp-status.yml` from `~/erp-edge/dynamic/`, then `docker compose down` in
  `~/erp-status`.

**Verify:**
- `curl https://status.erp.gaiada.com/` from a Linux client gives 200, a verified certificate, and the banner.
- `curl http://172.17.0.1:18480/status.json` on sumopod.
- `docker logs erp-status-renderer-1` shows one line a minute.
- A Windows curl may print `000` on a fresh certificate (a schannel revocation check); use `--ssl-no-revoke`
  there, or check from Linux.

First run 2026-10-11 14:45Z: both probes `1`; "All systems operational"; Let's Encrypt certificate valid to
2027-01-09.

---

## 1. What the status page is, and is not

**Is:** a small, public, static page reporting Zone B's **own** service health — proxy reachable,
api reachable, database reachable, queue reachable — refreshed on an
interval. Modeled on the ordinary "status.example.com" pattern: no auth, no secrets, safe to be
public by design, because it says only "up/down/degraded" per component, never *why* in operator
detail.

**Is not:** a window into Zone A. Zone B cannot read Zone A telemetry (this is the same invariant
the OTLP listener enforces the other direction — see `webdesk-zoneb-otel.md` §1) and the status
page must never grow a panel that tries to reach across that boundary. It is also not the
`/control/*` console or `/admin*` — those stay exactly as locked down as the Caddyfile already
has them (WSK-D20); the status page is a **new**, separate, intentionally-public route, not a
relaxation of an existing one.

---

## 2. Design

- **Generator** (`webdesk/ops/scripts/gen-status-page.mjs`): polls each Zone B service's own
  `/healthz` (proxy already serves one; `api` will once WSK-06/21 land real
  ones — until then the generator degrades a target to `unknown` rather than fabricating `up`,
  per the estate's "an empty list is a claim" discipline: a probe that can't reach its target
  reports that honestly, it does not default to green). Writes `status.json` (machine-readable)
  and re-renders `index.html` (human-readable) from it.
- **Serving**: a new compose service `status-page` (Caddy `file_server` over the directory the
  generator writes to — see compose diff), reachable **only** through the main proxy's public
  vhost at `/status/*`, not its own published port. This keeps "the proxy is the only public
  listener" (design §03) true — the status page is a route on that one listener, not a second
  listener.
- **Refresh loop**: the generator runs on a short interval inside the `status-page` container
  (`sleep $WEBDESK_STATUS_REFRESH_SECONDS` loop) rather than depending on an external cron, so the
  page degrades to a visible **stale-data banner** (timestamp shown, computed client-side against
  `status.json`'s own `generated_at`) instead of silently going wrong if the refresh loop itself
  dies — this mirrors `wd-backup-sentinel`'s "a stopped job must read as a failure, not silence"
  principle applied to a UI instead of an alert.

## 3. Caddyfile change (proposed, applied — see file diff in the final report)

```caddyfile
	# --- Public status page (WSK-28) --------------------------------------------
	# Own service only. Never a Zone A view (see webdesk-zoneb-otel.md §1 — same
	# boundary, opposite direction: Zone B cannot show what it cannot read).
	reverse_proxy /status/* status-page:80
```

Added **after** the existing `/v1`, `/forms`, `/media` routes and **before** the `@denied`
block, so it participates in the same fall-through-to-404 structure the file already uses — it
does not touch `/admin*`, `/api/*`, or `/control/*`, and the existing `@denied` matcher still
correctly 404s anything not explicitly routed, `/status` included if this line were ever removed
(fails closed, not open).

**Verified how:** `docker compose -f webdesk/docker-compose.yml --profile dev config` was run
after this edit and exits 0 (parse-clean, evidence in the final report) — this proves the
Caddyfile is still mounted correctly and the new `status-page` service resolves as a compose
dependency. It does **not** prove the route works at runtime: no container was started in this
session (the placeholder `status-page` image needs the generator's output directory to exist
first, which only happens once the container's own entrypoint runs) — that is a `docker compose
--profile dev up -d && curl` check for whoever next runs this stack live, not claimed here as
DEV-VERIFIED.

## 4. What was actually driven (dev-machine proof)

```
node webdesk/ops/scripts/gen-status-page.mjs --selftest
```
Ran the generator against three fabricated inputs (all healthy / one down / all unreachable) and
asserted: (a) `status.json` correctly reflects each component's state, (b) the emitted
`index.html` contains the string `degraded` when any component is down and `unknown` when a probe
target is unreachable rather than silently showing `up`, (c) `generated_at` is a real ISO
timestamp the client-side staleness banner can diff against. See the final report for the actual
run output.

## 5. Status vocabulary reminder

Generator logic: **PROTOTYPED** (selftest driven and observed). Caddy route: **PLANNED**, parse
proven only (§3) — not started, not curled. Do not call any part of this DEV-VERIFIED until it has
been brought up with `docker compose --profile dev up -d` and the `/status` path has actually
returned a page.
