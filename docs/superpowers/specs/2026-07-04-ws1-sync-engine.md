# Workstream 1 · Sub-spec — Sync Engine + HA/DR Topology

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-ws1-gaiada-platform-architecture.md` (sub-spec #3 — highest-risk area)
**Scope:** Multi-site data replication and reconciliation, plus the high-availability / disaster-recovery topology. Security of the sync channel is summarized here and detailed in the Security workstream.

---

> **Critique-pass refinement (roadmap §3b):** full offline-write + T2 reconciliation applies **only to connectivity-poor sites** (e.g. resort). Well-connected sites use **central-primary + read-replica** (no local reconciliation) — cutting the riskiest code where it isn't needed. The design below is the full-capability version; simpler sites use a reduced subset.

> **Status (D1 + adversarial review):** the custom sync engine is **DEFERRED to target-state** — v1 uses a single managed primary + read replicas (no reconciliation). When this IS built, the review's **D3 fixes are mandatory, not optional**: (1) separate replay-dedup (by event id / (origin_site, hlc) cursor) from conflict-resolution; (2) ONE coherent clock+conflict model — delete the contradictory "field-level LWW on a single row clock" language; standardize on HLC, drop "updated_at doubles as the clock"; (3) a declarative per-field `conflictPolicy` (default status/decision/money → conflict-queue); (4) HLC monotonicity seeded on failover/startup; (5) consistent snapshot↔cursor watermark for bootstrap; (6) tombstone GC gated on a convergence watermark; (7) **every drop/merge writes a reviewable `sync_conflicts` + audit row — no silent loss.** A property-based convergence + partition/chaos test suite is part of the deliverable.

## 1. Topology (refined)

- **Every company (main + each child) is a resilient PAIR:** its own **physical server (primary)** + **VPS (hot standby/fallback)** + DB. The VPS is the second line of defense when the physical server is down.
- **Central** is the biggest such pair (physical + VPS) and holds **all tenants** — the reconciliation hub + management cross-company view.
- **Hub-and-spoke:** each company pair syncs only with central (no peer mesh).

```
 Company A                 Company B                 ...        CENTRAL (all tenants)
 ┌───────────────┐         ┌───────────────┐                   ┌────────────────────┐
 │ physical (P)  │◄──T1──► │ physical (P)  │◄──T1──►           │ physical (P) ◄─T1─► │
 │      ▲        │         │      ▲        │                   │      ▲       VPS(S) │
 │      │ stream │         │      │ stream │                   │      │             │
 │   VPS (S)     │         │   VPS (S)     │                   │  (biggest pair)     │
 └──────┬────────┘         └──────┬────────┘                   └─────────▲──────────┘
        │  T2 (outbox reconciliation, scheduled, hub-and-spoke)          │
        └────────────────────────────────────────────────────────────────┘
```

---

## 2. TWO replication tiers (do not conflate)

| Tier | Between | Mechanism | Consistency | Purpose |
|---|---|---|---|---|
| **T1 — intra-company HA** | a company's **physical ↔ its VPS** | **Postgres synchronous/streaming replication** + auto-failover (Patroni/repmgr) | near-realtime, near-zero RPO | Hot-swap on hardware/node failure. Standard Postgres HA. |
| **T2 — cross-site reconciliation** | each company pair **↔ central** | **App-level transactional outbox** (custom Go sync engine) | eventual; RPO = sync interval | Aggregate all tenants at central; local-first offline writes; unified management view. |

**T1 gives uptime. T2 gives aggregation + offline resilience. Neither is a backup (see §7).**

---

## 3. T2 — reconciliation design

### 3.1 Selective scope (`site_subscriptions`)
Each company node holds: **its own tenant(s)** (full, bidirectional with central) + **shared global reference data** (users, companies, roles — pulled from central). It does **not** hold other tenants' operational data. **Central holds everything.**

### 3.2 Change capture — transactional outbox
Every data change writes a `sync_outbox` row **in the same DB transaction** (no lost/phantom events):
`{ id, tenant_id, entity_type, entity_id, op(insert/update/delete), payload jsonb, hlc, origin_site, schema_version, created_at, synced_at }`.

### 3.3 Clock — Hybrid Logical Clock (HLC)
Wall-clock + logical counter; monotonic, tolerant of skew, gives causal ordering. Every row carries an HLC used for LWW.

### 3.4 Protocol
Per-node cursors (`last_pushed_hlc`, `last_pulled_hlc`). Each tick (**scheduled interval + opportunistic push when online**):
- **Push:** node → central outbox events since cursor; central applies **idempotently**, acks; node marks synced.
- **Pull:** central → node events for the node's subscribed scope since cursor; node applies idempotently.
- **Idempotent apply:** upsert only if incoming `hlc > stored hlc`. Batched + resumable via cursors.

### 3.5 Conflict resolution (hybrid)
- **Ownership partitioning** → most records written only by their owner site → conflict-free by construction.
- **Concurrent edits to a shared record** → **field-level LWW by HLC** (`origin_site` tiebreak) to minimize lost updates.
- **True semantic conflicts** → `sync_conflicts` queue for human review; both versions retained.
- **Deletes** → tombstones (soft-delete + HLC), resolved deterministically.

### 3.6 Bootstrap / backfill
New node or post-outage: snapshot of subscribed scope, then incremental from cursor; checkpointed/resumable.

### 3.7 Reliability & monitoring
Retries w/ backoff; failed events → `sync_dead_letter`; **per-node sync-lag metric** with alerting when a node falls behind (same alert path as the WA bot cost-cap alert → management group + logs).

### 3.8 Schema skew across sites
All sites run compatible schema versions; **version-tagged payloads** are forward/backward tolerant; migrations roll out **hub-first, then nodes**; a version-skew guard **queues** incompatible events rather than corrupting.

### 3.9 Files / large blobs
Metadata syncs via the outbox; large blobs sync via a **content-addressed store** (checksum dedup, lazy fetch). Detailed in the storage sub-spec.

---

## 4. New tables
`sync_outbox`, `sync_cursors`, `sync_conflicts`, `sync_dead_letter`, `site_subscriptions`.

---

## 5. Implementation
A dedicated **Go sync engine** service runs at each node and at central. Chosen for concurrency + easy static-binary deploy across heterogeneous sites.

---

## 6. Sync-channel security (floor; detail in Security workstream)
- **mTLS** between every node and central; each node authenticates with a service identity.
- **Peer allowlist** — central accepts sync connections only from known nodes; **no public listeners** on DB/sync ports.
- Private mesh (e.g. WireGuard) for site interconnect; the Gateway is the only sanctioned ingress.
- Sync events optionally signed; all sync actions audited.

---

## 7. Backups & disaster recovery — CRITICAL (HA ≠ backup)

**Replication copies destruction.** T1/T2 protect against *failure*, not against *malice* (ransomware, attacker, bad migration, accidental mass-delete) — corruption propagates to standbys and central within seconds. Recovering from those requires copies that a compromised admin/attacker cannot alter:

- **Immutable, versioned backups** — append-only object storage with **object-lock / WORM**; retention policy; per-node + central.
- **Point-in-time recovery (PITR)** — continuous WAL archiving → restore to a clean moment *before* the incident.
- **Air-gap / isolation** of backup credentials from the live environment (breach of live ≠ breach of backups).
- **Tested restore drills** — a backup unverified by restore is not a backup.

**The real "0 downtime + salvage everything":** T1 hot-swap for hardware failure (near-zero RTO) **+** immutable backups + PITR for malicious/logical destruction (bounded, clean recovery point). Both are required; neither substitutes for the other.

---

## 8. Open items (feed Security workstream + storage sub-spec)
- RPO/RTO targets per tier (define concrete numbers).
- Failover automation + split-brain prevention for T1 (Patroni quorum, witness).
- Backup retention/rotation + restore-drill cadence.
- Content-addressed blob store choice (MinIO w/ object-lock, etc.).
- Exact WireGuard/mTLS topology + certificate lifecycle.
