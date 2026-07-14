# Workstream 1 · Sub-spec — Sync Engine Revision (closes D3/D5/D7)

**Date:** 2026-07-06
**Status:** BUILT 2026-07-14 (`sync-engine-go/`) — see `../plans/2026-07-14-ws1-sync-engine-completion-report.md`. Closes D3/D5/D7.
**Supersedes-in-part:** `2026-07-04-ws1-sync-engine.md` (topology §1-2, tables §4, security floor §6, backup/DR §7 all still stand; this doc replaces §3 reconciliation design and §8 open items with the adversarial review's mandatory fixes, and removes the "deferred to target-state" status per the full-fidelity mandate)
**Fixes:** D3 (silent data loss/corruption), D5 (RLS tenant-isolation gap on the sync path), D7 (event-backbone/sync-outbox collision) from `2026-07-05-adversarial-weakness-review.md`
**Depends on:** `2026-07-05-ws1-event-backbone.md` (shares one outbox table), `2026-07-06-ws3-go-gateway-rewrite.md` (mTLS node identity)

---

## 0. Status change

The original spec (`2026-07-04-ws1-sync-engine.md:12`) marked this "DEFERRED to target-state — v1 uses a single managed primary + read replicas." Per the full-fidelity mandate (`2026-07-05-phase-5-full-fidelity.md`), that deferral is lifted: this sub-spec is buildable and verifiable now, **without a real second physical site**, via a local multi-node chaos harness (two or more Postgres containers simulating site + central on one dev machine). Deploying it into production still waits for an actual second site — but the code, and its correctness, do not.

---

## 1. Resolves D7 — one outbox, not two

`2026-07-04-ws1-core-schema-and-module-framework.md` speccs a `sync_outbox` table; `2026-07-05-ws1-event-backbone.md` independently speccs `outbox_events` "shaped to match" it, leaving whether they're literally the same table as an open item. The adversarial review (D7) resolves this directly: **"Single change-capture spine: derive the backbone from sync_outbox via CDC/relay — the backbone is a derived projection, not a second write."**

**Resolution: one table, two independent readers.**

- `outbox_events` (as defined in the event-backbone spec) *is* `sync_outbox` — no separate table, no dual-write.
- The event-backbone's polling relay (→ Redis Streams) and the sync engine's T2 push/pull both read the same rows via their **own cursors** (`relayed_at` for the event-backbone relay; `sync_cursors.last_pushed_hlc`/`last_pulled_hlc` for the sync engine, per-node). Neither consumer's cursor affects the other's.
- This satisfies "one source of truth per capability": every domain event is written once, in the same transaction as its business write, and every downstream concern (real-time module reactions, cross-site sync, future RAG re-ingestion) reads from that one append-only log.

**Action item on the event-backbone spec**: its §7 open item ("whether `sync_outbox` becomes literally this same table... left for the sync-engine sub-spec to decide") is now resolved — see the cross-reference added there.

---

## 2. Resolves D3 — the conflict/clock model

The original §3 conflict-resolution design is internally contradictory (advertised field-level LWW on a single row-level HLC silently degrades to whole-row LWW; the clock is named three incompatible ways). Per the review's exact prescription:

1. **Replay-dedup is separate from conflict-resolution.** Dedup by `(origin_site, event id)` cursor position — never by comparing to a row's stored clock. A duplicate delivery of an already-applied event is a no-op at the cursor level, full stop, before conflict logic ever runs.
2. **One clock, everywhere: HLC.** Delete every reference to `updated_at` as a logical clock (it's a non-monotonic wall-clock column and must not double as one). `outbox_events.hlc` (wall-clock + logical counter) is the only clock used for ordering and conflict comparison.
3. **Declarative per-field `conflictPolicy`** on `EntityDef`, one of `lww | conflict-queue | numeric-merge | max/min`. Default: **status/decision/money fields → `conflict-queue`**; everything else → `lww`. Concurrency is detected via a **version-vector/base-version** comparison (has this field changed since the writer last read it?), not a scalar HLC compare — this is what actually makes field-level resolution possible instead of silently collapsing to row-level.
4. **HLC monotonicity across failover.** On node startup/promotion, seed HLC from `max(wall_clock, MAX(persisted hlc for origin_site))`, with a startup guard rejecting any computed HLC less than the last-known value for that site. T1 replication (physical ↔ VPS) for outbox-containing transactions must be **synchronous**, not async — an async standby promoted mid-lag could otherwise mint HLCs that regress behind what central already has.
5. **Bootstrap = consistent snapshot + cursor watermark in the same transaction.** New-node bootstrap takes a snapshot of the subscribed scope (including tombstones) and records the cursor as that snapshot's max outbox HLC, captured atomically with the snapshot — not as a separate step that can drift. A post-backfill merkle checksum gate verifies the snapshot applied correctly; a standing anti-entropy sweep catches drift afterward.
6. **Tombstone GC gated on a convergence watermark**: never purge a tombstone newer than `min(cursor)` across all subscribed nodes — a tombstone can't be GC'd until every node has definitely seen it, or a late-arriving pull would resurrect a deleted row. Delete-wins semantics on delete-vs-update conflicts. Erasure (D2 crypto-shred) reconciles by retaining the tombstone row but shredding its key — the tombstone marker survives GC-eligibility checks even after the underlying data is unrecoverable.
7. **No silent loss, ever.** Every LWW resolution, every failover-triggered drop, every conflict-queue enqueue writes a `sync_conflicts` row (both versions retained) **and** an audit-log row. "The clock decided" is never an unrecorded event.

---

## 3. Resolves D5 — tenant isolation on the sync path

The sync engine reads/writes across all tenants to build pull/push payloads — a genuine cross-tenant path that RLS-on-a-scalar cannot express and that must not run under BYPASSRLS.

- **RLS moves from scalar to array-set**: `tenant_id = ANY(current_setting('app.current_tenant_ids')::uuid[])`, populated per operation from the sync engine's authorized tenant set (not a blanket bypass).
- **Sync pull/apply loops per authorized tenant**, issuing `SET LOCAL app.current_tenant_ids` **inside each transaction** — so RLS keeps filtering even on the sync path. No app/service role runs with BYPASSRLS.
- **`site_subscriptions` becomes a central-authoritative, node-immutable ACL**, enforced server-side on every pull batch and every applied push, keyed to the node's **mTLS identity** (the client-cert CN/SAN minted by the Go gateway's internal CA, per `2026-07-06-ws3-go-gateway-rewrite.md` §3). mTLS proves *which node* is connecting; this ACL is the separate, server-side check for *which tenant rows that node is actually allowed to touch* — closing the gap where "mTLS is satisfied" was being treated as sufficient tenant authorization.
- Every `outbox_events` row is stamped with its origin `tenant_id`; an incoming event outside a node's authorized set is rejected and wired to the anomaly-alert path (same path as the bot's cost-cap alert), not silently dropped or silently applied.
- Pooled connections used for sync work are never reused across tenant contexts without an explicit `RESET` — no pooling shortcut that could leak a prior tenant's session variable into the next request.

---

## 4. Testing — property-based convergence + chaos, not just unit tests

This is the review's explicit condition for calling D3 closed, not an optional nice-to-have:

- **Property-based convergence tests**: generate random interleavings of concurrent writes across N simulated nodes + central, assert all nodes converge to the same final state after sync settles, for every `conflictPolicy` type.
- **Partition/chaos tests**: kill a node mid-sync, kill central mid-apply, simulate clock skew and T1 failover mid-transaction, restart and assert no data loss (every dropped/merged write has a corresponding `sync_conflicts` or audit row — nothing vanishes unrecorded) and no resurrection (tombstones stay dead).
- **Local harness**: 2+ Postgres containers (site + central) + the Go sync engine binary running against both, orchestrated via `docker compose` — the same harness later validates a real second physical site without code changes.

---

## 5. Unresolved (explicitly deferred, not silently dropped)

- Exact RPO/RTO numeric targets per tier (T1 vs T2) — still an open item from the original spec, unaffected by this revision.
- WireGuard/mTLS certificate lifecycle detail beyond what the Go gateway spec already covers for node identity.
- Content-addressed blob store choice for large files synced outside the outbox (metadata-only in `outbox_events`) — separate storage sub-spec.
