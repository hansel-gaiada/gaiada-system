# IT Network Discovery + Device Registry — Design

**Status: PLANNED** (nothing in this doc is built). Module `it` → target **0.2.0**.
Author: investigation + design, 2026-08-03. Supersedes the "topology" half of memory
`it-device-contract`.

---

## 1. Problem — what was actually measured

IT > Topology "doesn't show all devices in the network". It is **not a bug**: the feature
does not exist. Measured evidence, 2026-08-03, from a laptop on the office SSID `GDA`:

| Reality | ERP |
|---|---|
| Subnet `10.10.0.0/22`, gateway `10.10.0.1` | Seeded fiction on `10.0.0.x`/`10.0.10.x`/`10.0.20.x` |
| **~58 live hosts** | **8 rows**, all hand-seeded |
| UniFi OS gateway, live controller | Zero integration of any kind |
| One flat /22, no VLANs | Seed models VLAN1/10/20 that don't exist |

Composition of the 58: 1 gateway, ~17 managed workstations (`GDA-01`…`GDA-16`,
`GDA-AIO-02`), 3 Macs (`MacBookAir`, `Air-ayu-7`, `Mac`), ~25 personal phones, ~12
unidentified.

Code findings:
- `it.controller.ts:3` — *"Topology is computed client-side."*
- `buildTopology()` (`platform-ui/src/lib/it.ts:140`) groups rows by two **free-text**
  strings (`site`, `network`). No uplinks, no edges, no graph. It is a grouped list.
- Codebase-wide grep for UniFi/SNMP/ARP/mDNS/DHCP-lease/nmap discovery: **zero hits.**
  The only "UniFi" occurrences are string literals in `seed/agency.ts:285` and
  `demoFixtures.ts:710`.
- **No `PATCH`** endpoint → registered devices can never be corrected, despite
  `0019_it_devices.sql:2` and `lib/it.ts:17` both promising "register/**edit**".
- **No `DELETE`** → `deleted_at` is filtered on by every query but never written.
- **Registered devices are permanently `unknown`**: `registerDevice`
  (`it/devices/actions.ts:27`) sends no status, so the DB default `'unknown'` sticks, and
  nothing ever calls the heartbeat endpoint. Adding all 58 hosts by hand today yields 58
  grey tiles.
- Heartbeat ingest requires `update` authz on the device with no device-scoped token, so
  an unattended agent would need a fully elevated principal.

### 1.1 Two measurement traps (do not repeat)

1. **ICMP undercounts by 5×.** Only 12 of 58 hosts answer ping. The ARP/neighbour table is
   the reliable presence signal. Any collector that uses ping for liveness will report a
   near-empty network.
2. **~60% of MACs are randomized** (locally-administered bit set — iOS/Android/macOS
   private Wi-Fi addresses). **MAC is therefore not a stable device identity** for BYOD.
   Keying the registry on MAC alone will manufacture a new "device" every time a phone
   rotates its address. See §5.2.

---

## 2. The hard constraint that shapes everything

The ERP runs on `gda-aicenter` (datacenter). The UniFi controller is `10.10.0.1` — RFC1918,
behind office NAT. **Verified**: from the server,
`curl https://10.10.0.1/proxy/network/integration/v1/sites` → HTTP `000` (no route).

So a server-side poller is **impossible**. Discovery must originate inside the office and
**push** outward. This is not a preference; it is the network.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Push-based site collector.** A small agent runs on an office host, polls UniFi locally, POSTs a batch report to the ERP. | Only option that works (§2). No inbound firewall holes. Matches the platform's existing `origin_site` / site↔central design. |
| D2 | **UniFi Integration API with a revocable `X-API-KEY`**, not admin credentials. | Verified present: `/proxy/network/integration/v1/sites` → `401` (endpoint exists). A scoped, revocable key beats storing a UniFi admin password. Legacy `/api/s/default/stat/{sta,device}` is the documented fallback — also `401`, i.e. present. |
| D3 | **UniFi is the sole discovery source for v1.** No SNMP, no nmap, no mDNS. | The controller already knows every client, MAC, hostname, uplink AP, switch port and radio. Active scanning would add a second, worse source of truth. |
| D4 | **Do not persist BYOD personal devices by default.** Classify into `infrastructure` / `managed` / `byod`; persist the first two as device rows, reduce `byod` to counts only. Per-device BYOD persistence is an explicit opt-in flag. | See §6 — this is a compliance gate, not a nicety. |
| D5 | **Status is derived from `last_seen_at` freshness**, not from pushed heartbeats. A reaper marks stale rows `offline`. | Kills the "permanently unknown" dead-end without requiring every device to be an agent. |
| D6 | **Discovered rows are not hand-editable; manual rows are not overwritten.** `discovery_source` discriminates. Manual edits to a discovered row are stored as an override layer that survives the next poll. | Otherwise every poll silently reverts operator corrections. |
| D7 | Keep the topology graph **server-computed** behind a new endpoint. | `buildTopology()` cannot express uplinks; the graph needs the DB, not a client-side regroup. |

**Rejected:** the Ubiquiti *cloud* Site Manager API (`api.ui.com`). It is reachable from the
datacenter and needs no office agent — but it is console/device-oriented with thin
client-level detail, and it routes company network inventory through Ubiquiti's cloud. Keep
as a possible later supplement for multi-site rollup, not as the v1 source.

---

## 4. Architecture

```
OFFICE (10.10.0.0/22)                       DATACENTER (gda-aicenter)
┌──────────────────────────────┐            ┌────────────────────────────────┐
│ UniFi OS gateway 10.10.0.1   │            │ platform-nest  module `it`     │
│  /proxy/network/integration  │            │  POST /api/:t/it/discovery/     │
│            ▲ X-API-KEY       │            │       report   (batch upsert)   │
│            │ (local, TLS)    │            │  PATCH/DELETE /it/devices/:id   │
│  ┌─────────┴──────────────┐  │  HTTPS     │  GET  /it/topology  (graph)     │
│  │ it-site-collector      │──┼───────────▶│  reaper: stale ⇒ offline        │
│  │ (Node, container)      │  │  outbound  │           │                     │
│  │  poll → classify → push│  │  only      │           ▼                     │
│  └────────────────────────┘  │            │  it_devices / it_device_links   │
└──────────────────────────────┘            │  it_discovery_runs              │
                                            └────────────────────────────────┘
```

**`it-site-collector/`** — new standalone component (per the repo's "separate projects, not a
monorepo" rule). Responsibilities, in order: authenticate to UniFi locally → fetch sites,
devices (APs/switches/gateway) and clients → classify each (§5.2) → build a batch report →
POST to the ERP with a client-credentials token → log the run. Stateless; a crash loses at
most one interval. Poll interval 5 min (configurable).

It runs in the office, ideally as a container on an always-on office box. **Open item O3.**

---

## 5. Data model — migration `0071`

> Ledger note: `migrations/README.md` says next-unused is `0070`, but
> `docs/superpowers/plans/wd23a-1/0070_core_google_oauth_states.sql.staged` has claimed
> `0070` without landing. **Take `0071`** and re-verify at implementation time.

### 5.1 `it_devices` — additive columns

```
discovery_source  text NOT NULL DEFAULT 'manual'   -- 'manual' | 'unifi'
device_class      text NOT NULL DEFAULT 'managed'  -- 'infrastructure'|'managed'|'byod'
external_id       text          -- UniFi stable _id; NOT the MAC (§1.1.2)
hostname          text
is_wired          boolean
ssid              text
uplink_mac        text          -- parent AP/switch MAC  → topology edges
uplink_port       integer       -- switch port, when wired
first_seen_at     timestamptz
last_seen_at      timestamptz   -- drives derived status (D5)
overrides         jsonb NOT NULL DEFAULT '{}'  -- operator edits that survive polls (D6)
```

- Partial unique index `(tenant_id, external_id) WHERE discovery_source='unifi' AND deleted_at IS NULL`.
- Keep the existing `heartbeats` array; the collector appends a reachability sample so the
  existing sparkline keeps working.
- `status` becomes **derived** (D5), never written by the collector directly.

### 5.2 Identity + classification

Upsert key is `external_id` (UniFi's own stable client id), **never MAC** — §1.1.2. Classify:

- `infrastructure` — anything UniFi reports as an adopted *device* (gateway, AP, switch).
- `managed` — client whose hostname matches a configurable corporate pattern
  (`^GDA-`, `^DESKTOP-`, `^LAPTOP-`, plus an explicit allowlist for the 3 Macs and named
  hosts like `Dina.local`, `MSI.local`, `Laptop-Tini.local`).
- `byod` — everything else (default-deny). ~25 of the 58 hosts land here.

The unidentified ~12 hosts (no rDNS, no open ports) will classify from UniFi's data, which
sees them properly — that is a direct benefit of D3 over active scanning.

### 5.3 New tables

- `it_device_links (tenant_id, child_device_id, parent_device_id, port, medium)` — the real
  topology edge set, so the graph survives hostname/IP churn.
- `it_discovery_runs (id, tenant_id, started_at, finished_at, source, ok, devices_seen, devices_upserted, byod_count, error)` — audit + a "last successful sync" indicator for the UI. Without this, a dead collector is indistinguishable from an empty network.

All new tables get the standard `FORCE ROW LEVEL SECURITY` + authorized-tenant-set policy,
copied verbatim from `0019_it_devices.sql:46-59`.

> Migration hygiene: this migration has backfill DML (classifying existing rows), so per
> memory `migration-backfill-rls-trap` it must pass the `0052+` CI RLS lint — the backfill
> must not silently affect zero rows.

---

## 6. Privacy gate — must be settled before any BYOD persistence

The 58 hosts include hostnames that directly identify staff: `Ratihs-iPhone`,
`Irie-s-S23-FE`, `A56-milik-Tini`, `iphone-claraay`, `A04s-milik-I-Made-Ari`,
`A12-milik-Mikaelus`, `Edward-s-AQUOS-R9-pro`. Persisting these plus MAC and per-poll
timestamps builds a **continuous presence/attendance log of named employees on their
personal devices**.

This collides with the project's own rules — CLAUDE.md: *"do NOT ingest real employee data
until Gate 1 (legal) + the day-one gate (technical) are both green"* — and with the existing
DPIA/LIA discipline in `legal/`.

Therefore **D4 is a gate, not a default**: v1 persists `infrastructure` + `managed` only;
`byod` is reduced to an aggregate count on `it_discovery_runs`. Turning on per-device BYOD
persistence requires a DPIA addendum + notice, and should be tracked as its own decision.
This also happens to be the right engineering call: BYOD phones with rotating MACs are
inventory noise.

## 7. Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/:t/it/discovery/report` | Collector batch upsert. Idempotent per run. Authz: new Cerbos action `discover` on `device`; principal is a client-credentials service account, **not** a human. |
| `PATCH` | `/api/:t/it/devices/:id` | Closes the missing-edit gap. Writes to `overrides` for discovered rows (D6), direct columns for manual rows. |
| `DELETE` | `/api/:t/it/devices/:id` | Soft — finally sets `deleted_at`. |
| `GET` | `/api/:t/it/topology` | Server-computed graph: nodes + `it_device_links` edges + last-sync metadata. |

⚠️ Adding a new Cerbos action/policy requires a **Cerbos restart** — per memory
`cerbos-new-policy-needs-restart`, an unlisted kind/action is a silent DENY that presents as
a logic bug, so this will 403 for everyone until Cerbos is bounced.

## 8. UI

- **Topology** — render the real graph from `GET /it/topology`: gateway → APs/switches →
  clients, using `it_device_links`. Show "last synced N min ago" and a loud banner when the
  collector is stale; an empty map must never be ambiguous between "no devices" and "the
  collector is dead".
- **Devices** — add edit + delete, search, pagination (breaks today at 58+ rows), a
  `discovery_source` badge (Discovered vs Manual), a `device_class` filter, and the
  `firmware`/`labels` fields the API already accepts but `DeviceForm` never sends.
- Keep graceful degradation (`skipUnavailable`) so the pages ship before the collector runs.

## 9. Build order + status

| Ticket | Scope | Status |
|---|---|---|
| IT-01 | Migration `0071` + RLS + backfill classify | **DEV-VERIFIED** — applied on the test DB; `lint:migration-rls` clean |
| IT-02 | `PATCH`/`DELETE` + tests | **DEV-VERIFIED** |
| IT-03 | Derived status + stale reaper (D5) | **DEV-VERIFIED** — reaper is dark by default (`IT_DISCOVERY_REAPER_ENABLED`) |
| IT-05 | `POST /it/discovery/report` + `GET /it/topology` | **DEV-VERIFIED** |
| IT-06 | UI: real graph, edit/delete, search, badges, stale banner | **PROTOTYPED** — unit-tested + `next build` green; not driven in a browser |
| IT-07 | Fictional seed devices off by default + labelled | **PARTIAL** — code done; the live tenant's 8 rows are **not** purged (see §12) |
| IT-04 | `it-site-collector/` — UniFi client, classifier, batch push, run log | **NOT STARTED** — blocked on O1 |

Verification: 34 IT tests (20 pure + 14 against live Postgres + Cerbos), full backend suite
2590 passed / 4 skipped / 0 failed, platform-ui 939 passed, `tsc` clean both sides, `next build` green.

### 9.1 Deviations from this design, as built

1. **The ingest endpoint authorizes on the existing Cerbos `create` action**, not a new `discover`
   one (§7 proposed the latter). `resource_device.yaml` enumerates actions explicitly and an
   unlisted action is a *silent DENY* that reads as a logic bug — and a policy change is not
   hot-reloaded over the Windows bind mount, so it needs a Cerbos restart. `create` is already
   granted to exactly `company_admin`/`it_staff`, so reuse keeps this deployable with no policy
   change and no restart. The §7 ⚠️ warning is therefore moot as built.
2. **`status` is not editable on a discovered row.** §5.1 left this implicit; the API rejects it,
   because an operator-pinned status would make the registry contradict the network.
3. **Migration number is `0071`**, as §5 anticipated — `0070` is still claimed by the unlanded
   staged file in `wd23a-1/`.

## 12. Ops follow-ups (not done)

**Purge the seeded fiction from the live tenant on `gda-aicenter`.** The seed no longer plants these
rows, but the 8 already in the live DB will keep rendering. They are identifiable precisely — do not
delete "names that look invented":

```sql
-- Per tenant, because migrations/scripts run as platform_owner (NOBYPASSRLS) and it_devices is
-- FORCE-RLS: without the GUC this matches ZERO rows and reports success. Same trap as 0050.
DO $$
DECLARE co RECORD;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE it_devices SET deleted_at = now(), updated_at = now()
     WHERE deleted_at IS NULL
       AND discovery_source = 'manual'
       AND (labels @> ARRAY['demo-fixture'] OR ip LIKE '10.0.%' OR ip LIKE '10.1.%');
  END LOOP;
END $$;
```

Review the `SELECT` form of that predicate before running the `UPDATE` — if anyone has since
hand-registered a genuine device on a `10.0.*`/`10.1.*` address it would be caught too.

## 10. Open items / blockers

- **O1 — UniFi API key (blocking IT-04).** Needs a key minted in the UniFi console
  (Settings → Admins → API key), scoped read-only. Nobody can write the collector's auth
  path without it. Store per the repo's secrets convention; never in the ERP DB.
- **O2 — Privacy gate (§6).** Confirm v1 ships `infrastructure`+`managed` only. Recommended:
  yes.
- **O3 — Collector host.** Which always-on office machine runs it? A workstation that sleeps
  makes topology flap. Ideal: a small always-on box or the gateway-adjacent host.
- **O4 — "GDA Macbook".** No such SSID is broadcasting and no such saved profile exists;
  only `GDA` (plus a stale `Gaia Digital Agency`). Either it is a hidden/offline SSID, a
  MacBook hotspot, or it meant the 3 Mac clients. Unresolved.

## 11. Out of scope (but found, and worth acting on separately)

**The network is one flat /22.** Company workstations, the Macs, and ~25 personal phones
share a single broadcast domain with no VLAN separation. Any compromised personal phone sits
at layer 2 with every workstation. The seed data ironically models the VLAN segmentation
(VLAN1/10/20) that reality lacks. This is a networking change, not an ERP change — it
belongs in a separate piece of work, but it is the highest-severity thing this
investigation turned up.
