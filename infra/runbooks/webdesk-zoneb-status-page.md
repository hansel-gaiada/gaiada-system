# Runbook — WebDesk Zone B status page (WSK-28)

**Status: PROTOTYPED.** The generator (`webdesk/ops/scripts/gen-status-page.mjs`) and the static
page it emits were driven against a set of fabricated health responses on this dev machine (§4).
Not yet driven against real Zone B services (no box), and the Caddy route has not been proven
live (no running proxy container in this session — see §3 for what was and wasn't checked).

---

## 1. What the status page is, and is not

**Is:** a small, public, static page reporting Zone B's **own** service health — proxy reachable,
api reachable, payload-gateway reachable, database reachable, queue reachable — refreshed on an
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
  `/healthz` (proxy already serves one; `api`/`payload-gateway` will once WSK-06/21 land real
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
