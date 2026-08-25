# Network Security Console — Design

Status: **PLANNED**. Nothing in this document is built.
Supersedes nothing; **extends** `2026-08-03-it-network-discovery-design.md`, which stays the
authority for device discovery, the site collector and the privacy gate. Read that first — this
document assumes it and does not repeat it.

Owner ask (2026-08-25): a network monitoring interface showing live topology (MAC / IP / name /
device info for every connected host, router, CCTV), a dedicated page for WiFi-signal-based people
detection, and the beginnings of network security — "know what's in and out of our network, so we
can mitigate and isolate any IP that tries to hack or disturb our local system."

---

## 1. What already exists — the honest starting line

The topology half of the ask is ~85% built and 0% running.

| Surface | State |
|---|---|
| `platform-ui/src/app/(app)/it/topology/page.tsx` | Server-computed graph (gateway → AP/switch → client), uplink edges, stale-collector banner. **PROTOTYPED** — unit-tested, `next build` green, never driven in a browser |
| `platform-ui/src/app/(app)/it/devices/` | Registry: MAC, IP, hostname, vendor, model, firmware, class badges |
| `GET /api/:t/it/topology`, `POST /api/:t/it/discovery/report`, `PATCH`/`DELETE /it/devices/:id` | **DEV-VERIFIED** (34 IT tests on live PG + Cerbos) |
| migration `0071` | Applied on the test DB; `lint:migration-rls` clean |
| `platform-ui/src/app/(app)/systems/observability/` | Plane A — the servers console. Already the "server page" |

**Deployment reality:** all of the above is on `main` at commit `b6186b6`, deliberately **untagged**.
The tag-triggered pipeline never picked it up, so `gda-aicenter` still serves
`alpha-01.005.0015b` — which predates the entire discovery build and still renders 8 seeded
fictional devices at "Bali Office" on `10.0.x.x`, an address range that does not exist in the
office. To an operator this reads as "the topology page is broken." It is not broken; it is a
different, older build.

Three blockers gate everything downstream, and none are code:

- **B1 — no UniFi read-only API key.** (discovery design §10 O1)
- **B2 — no always-on office host** to run the collector. (O3)
- **B3 — `it-site-collector/` was never written.** (IT-04)

The ERP cannot poll the office: `gda-aicenter` → `https://10.10.0.1/...` returns HTTP `000`, no
route. This is not a configuration gap, it is RFC1918 behind office NAT. Discovery **must** be
push-based from inside the office. Every phase below inherits that constraint.

---

## 1b. Office survey, 2026-08-25 — measured, not assumed

Run from a laptop on the `GDA` SSID (`10.10.2.98/22`). Full `/22` ping sweep to populate ARP, then
reverse DNS per neighbour, then unauthenticated probes of the gateway.

**The gateway.** `10.10.0.1` is a **UDM-Enterprise** — `"shortname":"UDMENT"`, marketed as the
*Enterprise Fortress Gateway*, UniFi OS `3.0.1`, MAC `28:70:4E:74:55:0F`. `cloudConnected: true`,
`remoteAccessEnabled: true`, and a `directConnectDomain` under `id.ui.direct`. Two oddities worth an
answer from whoever provisioned it: the console's name is **"ENZO Villa"**, which is not this
company, and `deviceState` reports `"setup"`.

`/proxy/network/integration/v1/sites` and the legacy `/api/s/default/stat/{sta,device}` both return
`401` — the Network API is present and needs only the key from O1, exactly as the August design
assumed. Note that `/proxy/protect/...` returning `200` is **not** evidence Protect is installed:
UniFi OS serves its SPA login shell (`text/html`) for any unauthenticated `/proxy/*` path. That
probe cannot answer the camera question either way.

**The clients.** 40 live hosts. Roughly 25 carry locally-administered (randomised) MACs and
consumer hostnames — the personal-phone population, consistent with August. Nine are corporate:
`GDA-05`, `GDA-08`, `GDA-09`, `GDA-13`, `GDA-15`, `GDA-23`, `GDA-AIO-02`, plus a `MacBookAir` and
one named laptop. The AP is Wi-Fi 7 (802.11be, 6 GHz, 8 colocated BSSIDs) — newer hardware than the
August notes imply.

**There is a second network, and the client VLAN can reach all of it.** Not one AP, switch, camera
or printer is L2-visible in the client `/22` — but that is not segmentation, it is just a different
subnet. `192.168.0.1` answers ICMP and 443 from the staff WiFi, serves UniFi OS, and reports the
**same MAC** as `10.10.0.1`: one UDM-Enterprise hosting both networks. A full sweep of
`192.168.0.0/24` from the staff WiFi returns **98 live hosts**.

**What is on it** (TCP fingerprint + HTTP identity):

| Count | What | Evidence |
|---|---|---|
| ~50 | **UniFi Protect cameras** | 80/443, `Server: lighttpd`, `<title>UniFi Protect</title>` |
| 3 | Printers | `.17` HP Color LaserJet MFP M283fdw (515/631/9100); `.204`, `.207` Epson (`server: EPSON-HTTP/1.0`) |
| ~21 | UniFi APs / switches | SSH only |
| 7 + 1 | iPhones, and one host on 445 | personal/Windows devices on the infrastructure network |

Consequences:

- **O3 is CLOSED: the CCTV is Ubiquiti, UniFi Protect.** Scope the collector's Protect client as
  real work, not a conditional. Note the probe trap that nearly hid this: `/proxy/protect/*` on the
  gateway returns `200` with the UniFi OS SPA login shell for *any* unauthenticated path, so it is
  no evidence either way — the cameras themselves are what proved it.
- **Phase 2 is more urgent, not less.** The gap is not "clients share a broadcast domain"; it is
  that every personal phone on the staff SSID has IP reachability to every camera's web interface,
  every printer and every AP. That is the highest-severity item in this document.
- **Any office-side collector must sweep BOTH segments.** A `10.10.0.0/22`-only scan misses the
  cameras, the printers and the APs — most of the estate.
- **A scan cannot replace the UniFi API.** MAC addresses come from ARP, which only works on the
  local segment; the laptop is *routed* to `192.168.0.0/24`, so a scan yields IP and fingerprint
  there but **no MAC, no hostname, no uplink AP, no switch port**. The read-only API key stays the
  right unlock.

---

## 2. The four planes

The estate is now four consoles, not three. Naming them apart matters because they answer
different questions and have different tenancy and different blast radius.

| Plane | Route | Question it answers | State |
|---|---|---|---|
| Hardware | `/it/topology`, `/it/devices` | *What exists on the network?* | Built, not running |
| Servers | `/systems/observability` | *What are we running, and is it healthy?* | Built, live |
| **Network** | **`/it/network/*`** | ***What moves, and can we stop it?*** | **This document** |
| Presence | `/it/network/presence` | *Are there people in the room?* | This document, §7 |

### 2.1 Inventory is not traffic

The single most important structural point. Device discovery answers "a camera exists at
`10.10.2.31`." It says nothing about that camera opening an outbound TLS session to a host in
another country every 40 seconds. "What's in and out of our network" is a **second, independent
data source** — flow records and IDS events — with different volume characteristics (millions of
rows/day vs ~60 device rows), a different retention policy, and a different collector feed.

Building the security console on top of the device registry alone would produce a page that looks
like security and detects nothing.

### 2.2 Presence is not security

`/it/network/presence` is filed under the network console because it rides WiFi hardware, but it is
functionally a **facilities/occupancy tool**. It must be visually and linguistically separated from
the threat tabs. If "3 people detected in Meeting Room 2" renders in the same list as "IDS: inbound
exploit attempt," an operator will eventually read the first as the second. Separate tab, separate
vocabulary ("occupancy", never "intruder"), no shared alert channel.

---

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| N1 | **Extend the existing `it-site-collector` with flow/IDS feeds; do not build a second agent.** | One office host, one outbound channel, one credential, one run log. A second agent doubles B2 and B3. |
| N2 | **UniFi DPI / Traffic Identification + UniFi Threat Management (Suricata IDS/IPS) are the v1 traffic sources.** No span port, no standalone Suricata, no nmap. | Same reasoning as D3 in the discovery design: the gateway already sees every packet. A second sensor is a second, worse source of truth. |
| N3 | **Flow data is aggregated at the collector, never shipped raw.** Per-client per-destination-ASN per-hour rollups, plus full detail only for IDS-flagged flows. | Raw flow at office scale is millions of rows/day. The ERP is not a SIEM and must not become one by accident. |
| N4 | **Retention is set before the first row lands:** rollups 90 days, IDS events 180 days, raw flow for flagged sessions 30 days. Enforced by a sweep, same shape as `platform-nest/src/admin/grant-expiry-sweep.ts`. | Retention added later never happens, and the table is unbounded until it does. |
| N5 | **Enforcement rides D14.** `network.isolateClient` becomes an entry in `platform-nest/src/core/approval-executables.ts` with its own `lockKey` and `precondition`. Proposing is not executing; **approving executes**. | The registry doctrine in that file is explicit: additions are deliberate, one per ticket, each carrying its own precondition. There is no generic bridge and this must not become one. |
| N6 | **Enforcement is quarantine-scoped, not arbitrary firewall editing.** The ERP may move a client into a pre-created quarantine rule group and nothing else. It may not author, reorder or delete firewall rules. | Bounds the blast radius to one reversible operation. An ERP bug becomes "one device lost internet", never "the office lost its firewall". |
| N7 | **A protected-target deny-list is enforced server-side, in the precondition, not in the UI.** Never isolatable: the gateway, every adopted infrastructure device, the collector host, and the client the approver is currently connected from. | Without this, the first real incident response ends with the responder locking themselves out mid-response. |
| N8 | **Every isolation auto-expires (default 4h, max 24h) and a global kill-switch reverts all active isolations.** | An isolation that outlives the incident is an outage nobody remembers causing. |
| N9 | **WiFi presence stores occupancy counts per zone. Never identity, never per-person tracks, never raw CSI at rest.** | §7. This is the difference between a room sensor and covert workplace surveillance of staff. |
| N10 | **The CCTV inventory question is answered by the collector, not by a scan.** | §4. UniFi already reports vendor/OUI, hostname and uplink port for every wired client; that identifies the cameras as a side effect of Phase 1. |

**Rejected: standing up the ERP as the enforcement point.** Considered having the ERP hold firewall
state as source of truth and reconcile UniFi to it. Rejected — it makes the ERP a single point of
failure for office connectivity, and reconciliation loops silently fight manual changes made in the
UniFi console during an incident. UniFi stays authoritative; the ERP proposes and records.

---

## 4. Open question: the CCTV cameras

The owner does not currently know whether the cameras are Ubiquiti (UniFi Protect) or another brand
(Hikvision/Dahua/etc.), and this changes the work:

- **UniFi Protect** — a second API surface on the same gateway. The collector gains a Protect
  client; cameras become first-class `infrastructure` devices carrying model, firmware and
  recording state.
- **Other brand** — cameras still appear in topology via UniFi as ordinary wired clients (IP, MAC,
  vendor OUI, switch port), but with no camera-specific detail unless an ONVIF probe is built.

**This does not need a scan and does not block anything.** Phase 1's very first successful collector
run enumerates every client with its vendor OUI and uplink switch port; the cameras identify
themselves in that output. Scope cameras as **UniFi-Protect-first with ONVIF deferred**, and settle
it from real data at the end of Phase 1 rather than guessing now.

If an answer is wanted sooner, it must be obtained from **inside the office** — the same way the
2026-08-03 survey was run, from a laptop on the `GDA` SSID. It cannot be run from the datacenter or
from a dev session; there is no route (§1).

---

## 5. Architecture

```
OFFICE (10.10.0.0/22)                        DATACENTER (gda-aicenter)
┌────────────────────────────────┐           ┌──────────────────────────────────┐
│ UniFi OS gateway 10.10.0.1     │           │ platform-nest  module `it`       │
│  /proxy/network/integration    │           │  POST /it/discovery/report       │  <- Phase 1
│  + DPI / traffic identification│           │  POST /it/network/flows/report   │  <- Phase 3
│  + threat management (IDS/IPS) │           │  POST /it/network/threats/report │  <- Phase 3
│  + Protect (if UniFi cameras)  │           │  GET  /it/network/{flows,threats}│
│  + quarantine rule group       │           │  GET  /it/network/rules          │
│            ^                   │           │  POST /it/network/isolate        │  <- Phase 4
│            | X-API-KEY (local) │  HTTPS    │        (files a D14 approval)    │
│  ┌─────────┴────────────────┐  │  outbound │                                  │
│  │ it-site-collector        │──┼──────────>│  automation_approvals            │
│  │  poll  -> classify -> push  │  │  only  │  approval-executables.ts:        │
│  │  pull  <- pending actions   │<─┼────────│    network.isolateClient         │
│  └──────────────────────────┘  │  (poll)   │  retention sweep (N4)            │
└────────────────────────────────┘           └──────────────────────────────────┘
```

**Note the action channel is pull, not push.** The ERP never opens a connection into the office; it
cannot (§1). The collector polls for approved-and-pending isolation actions on its normal interval
and applies them locally. Consequence: **isolation is not instant** — worst case is one poll
interval (5 min for discovery, tightened to 60s for the action channel). This must be stated in the
UI. An operator who believes a block took effect immediately will act on a false assumption during
the one moment it matters.

---

## 6. Phases

Phases 1 and 5 are independent and can run in parallel from day one.

### Phase U — the UI, front-loaded (DONE, 2026-08-25)

Built ahead of every backend phase, at the owner's request, so the surface can be judged before
anything is bought or wired. Frontend-first is the house pattern here (`it-device-contract`,
`org-structure-contract`): the readers degrade on 404/403 and the pages ship against an unbuilt
backend.

Shipped:

- `platform-ui/src/lib/network.ts` — data layer + the BFF contract in §5, plus pure helpers
  (`topTalkers`, `egressByCountry`, `summarizeThreats`, `isFeedStale`, `describeExpiry`,
  `canProposeIsolation`).
- `platform-ui/src/lib/demoNetwork.ts` — labelled fixtures, seeded from the §1b survey.
- `/it/network` (Traffic), `/it/network/threats`, `/it/network/rules` (Isolation),
  `/it/network/presence` (Occupancy), under a `Network` tab in the IT console.
- `components/it/network.css`, `components/it/NetworkBanners.tsx`.
- `demoFixtures.ts` routes for the four endpoints — **explicit**, because that file's final GET
  catch-all answers unmatched paths with `ok([])`, an empty ARRAY, which would hand these
  object-shaped readers `rollups: undefined` and crash the render instead of degrading.

Two rules the fixtures are built around, both from this repo's own history:

1. **A fixture must never pass for live data.** Every response carries a `source` discriminator and
   every page renders a "Demo data" banner on `"fixture"`. The IT module shipped 8 invented devices
   at a site that does not exist into the live tenant and they read as a bug for months.
2. **No staff-identifying data in a committed fixture.** ~25 of the 40 hosts have hostnames naming
   the employee holding the phone. The corporate asset names are real; every personal device is
   collapsed into an unnamed aggregate — which is also how the shipped product must treat them.

Verification: 25 new unit tests; full suite **3141 passed / 175 files**; `tsc` clean;
`next build` and the `DEMO_MODE=1` build gate both green; **all four pages driven in a browser** and
screenshotted (logged in, 200, correct KPIs, banners and row counts, no page errors). One layout
defect found and fixed only by driving it: `HairlineTable`'s grid has no column gap, so a
right-aligned header renders flush against the next left-aligned one and the two read as a single
word — every right-aligned column now sits at the end of the table.

Status: **DEV-VERIFIED** as a surface. It renders fixtures. It measures nothing until Phase 1.

### Phase 0 — unblock and deploy what exists

- Mint the read-only UniFi API key (B1). Store per the repo secrets convention; **never** in the ERP DB.
- Choose the always-on office host (B2). A workstation that sleeps makes topology flap.
- Purge the 8 seeded fictional device rows from the live tenant — exact SQL in the discovery design
  §12, including the per-tenant GUC loop (without it the statement matches ZERO rows and reports
  success — the `migration-backfill-rls-trap` failure mode).
- Cut a release: VERSION bump + tag, apply migration `0071` to the live DB.
- **Outcome:** the topology page that already exists finally runs. This is the cheapest visible win
  in the whole plan.

### Phase 1 — the collector (delivers the topology ask)

- Build `it-site-collector/` per discovery design §4 (IT-04): UniFi auth → sites/devices/clients →
  classify → batch push → run log.
- Browser-verify `/it/topology` against real data — IT-06 is PROTOTYPED, not verified.
- Answer §4 from the first run's client list.
- **Outcome:** live MAC / IP / hostname / vendor / uplink for every host, router and camera.
  **The owner's topology ask is complete here.**

### Phase 2 — segment the clients (no ERP code)

**Rescoped by the §1b survey.** Infrastructure is already on VLANs the client network cannot reach —
no AP, switch or camera is visible from `10.10.0.0/22`. What remains flat is the **client**
network: managed workstations and ~25 personal phones share one broadcast domain, so any
compromised personal phone sits at layer 2 with every workstation.

That exposure is unchanged and still the highest-severity finding, and **no dashboard fixes it** — a
security console watching an unsegmented network mostly watches the breach happen. But the work is
narrower than a from-scratch VLAN design: split managed from BYOD, and add the quarantine segment
Phase 4 needs. Pure networking work.

Phase 2 is also a **hard prerequisite for Phase 4**: quarantine (N6) needs a quarantine VLAN to move
a client into.

### Phase 3 — traffic and threat visibility (read-only)

- Collector gains DPI + threat-management feeds (N2), aggregating per N3.
- New tables + retention sweep (N4).
- `/it/network` — flows: top talkers, egress destinations, unusual-destination surfacing.
- `/it/network/threats` — IDS/IPS events with triage state.
- Findings emit onto the existing event backbone (`network.threat.*`) so they reach `/admin/audit`
  and the notification bell, exactly as `device.*` events already do. An alert nobody sees is not
  security.

### Phase 4 — enforcement (owner explicitly opted in)

- Quarantine rule group pre-created in UniFi (needs Phase 2).
- `POST /it/network/isolate` files a D14 approval; **approving executes** (N5).
- `network.isolateClient` registered in `approval-executables.ts` with `lockKey` (the client's
  stable UniFi id) and a `precondition` enforcing N7's deny-list and re-checking the client still
  exists and is not already isolated.
- Auto-expiry sweep + global kill-switch (N8).
- `/it/network/rules` — current isolation state, who approved, when it expires, one-click revert.
- Cerbos: reuse an existing granted action if one fits; a **new** action is a silent DENY until
  Cerbos is restarted, which presents as a logic bug. The discovery build hit exactly this and
  solved it by reusing `create` (discovery design §9.1 deviation 1).

### Phase 5 — WiFi presence (spike first)

See §7.

---

## 7. WiFi people-detection

**It cannot run on the existing access points.** Every working implementation (ESP32-CSI-Tool,
Nexmon CSI, SenseFi, wifi-densepose) needs raw Channel State Information. UniFi does not expose CSI
on any API. This requires **dedicated hardware** — a handful of ESP32s, or a Raspberry Pi 4 with a
Nexmon-patched `bcm43455c0` — plus a new edge service. It is a hardware purchase and a research
spike, not a page.

The owner has not selected a repo. **Phase 5 therefore starts as an evaluation spike, not a build:**
one room, compare ESP32-CSI (~$5/node, presence + motion + rough count, low privacy exposure, most
likely to survive a live office) against Nexmon/RPi4 (richer CSI, needed for anything approaching
localization, kernel-fragile, and a sharply higher privacy bar). Report before committing to a UI.

**Privacy gate — binding.** The discovery design already refuses to persist BYOD devices, because
~25 of the 58 hosts carry hostnames that directly identify staff (`Ratihs-iPhone`, `A56-milik-Tini`,
`iphone-claraay`) and persisting them plus MAC and per-poll timestamps builds a continuous presence
log of named employees. Per-device BYOD persistence is an explicit opt-in requiring a DPIA addendum.

WiFi sensing is **strictly worse**: it senses humans directly, including people carrying no device,
inside rooms. Under the project's own Gate-1 rule and the DPIA/LIA discipline in `legal/`, it
requires a DPIA addendum and staff notice **before a single sample is stored**. N9 is the
mitigation: zone occupancy counts only. No identity, no per-person tracks, no raw CSI at rest.

A spike that never stores a sample outside the test room does not trip this gate. Anything beyond
that does.

---

## 8. Data model sketch (Phase 3–4, not final)

New tables, all with `FORCE ROW LEVEL SECURITY` + the authorized-tenant-set policy copied verbatim
from `0019_it_devices.sql:46-59`:

- `it_network_flow_rollups (tenant_id, device_id, hour, dest_asn, dest_country, app, bytes_in, bytes_out, sessions)`
- `it_network_threats (tenant_id, id, occurred_at, severity, signature, src_ip, dst_ip, device_id, action_taken, triage_state, triaged_by, notes)`
- `it_network_isolations (tenant_id, id, device_id, requested_by, approval_id, applied_at, expires_at, reverted_at, reason)`

Migration naming is timestamped (`YYYYMMDDHHMM_*.sql`) — the numbered scheme is closed; do not look
up a next number.

---

## 9. Open items

- **O1 — UniFi read-only API key.** Blocks Phase 1 and everything after. (= discovery O1)
- **O2 — always-on office host.** Blocks Phase 1. (= discovery O3)
- ~~**O3 — CCTV brand.**~~ **CLOSED 2026-08-25: UniFi Protect** (§1b). ~50 cameras.
- **O4 — Segmentation plan.** Rescoped by §1b and now the top priority: the staff/BYOD SSID must
  lose its route to `192.168.0.0/24`. Then split managed from BYOD, and add the quarantine segment
  Phase 4 needs.
- **O8 — Why is the gateway named "ENZO Villa", and why is `deviceState` `"setup"`?** A console
  carrying another site's name, cloud-connected with remote access enabled, is worth confirming
  with whoever provisioned it before it is trusted as the security boundary.
- **O5 — DPIA addendum for WiFi sensing.** Blocks any Phase 5 storage beyond the spike room.
- **O6 — WiFi sensing hardware selection.** Output of the Phase 5 spike.
- **O7 — Does UniFi Threat Management have IPS enabled, or only IDS?** Determines whether Phase 3
  shows "we detected" or "we blocked". Answerable in the UniFi console.

---

## 10. Out of scope

- Turning the ERP into a SIEM. N3 is the boundary: rollups plus flagged detail, not raw packet or
  full flow retention.
- Log ingestion from non-network sources (endpoint, server auth). That is the observability plane's
  territory and belongs in a separate piece of work.
- Arbitrary firewall rule authoring from the ERP (N6).
- Multi-site rollup via the Ubiquiti cloud Site Manager API — already considered and rejected in the
  discovery design; keep as a possible later supplement, not a v1 source.
