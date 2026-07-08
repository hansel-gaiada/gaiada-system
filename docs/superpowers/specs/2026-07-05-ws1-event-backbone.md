# Workstream 1 · Sub-spec — Event Backbone

**Date:** 2026-07-05
**Status:** Design approved (brainstorming stage — not yet built)
**Parent:** `2026-07-04-ws1-gaiada-platform-architecture.md`; register item in `2026-07-05-phase-5-full-fidelity.md` ("Event backbone (Redpanda/NATS) — modules emit/consume; outbox table feeds it")
**Scope:** Intra-platform event pub/sub — how core-schema/module writes become events that other modules (in-process) and external standalone services (ai-agents, automation/n8n, etc.) can react to. This is distinct from and a prerequisite for the deferred cross-site sync engine (`2026-07-04-ws1-sync-engine.md`), which this spec's outbox table is designed to feed later without a schema migration.

---

## 0. Why this exists

The full-fidelity register flags the event backbone as the keystone unblocking:
- **Sync engine** (T2 cross-site reconciliation) — currently deferred to target-state, but its `sync_outbox` concept is the same shape as this spec's outbox table.
- **RAG re-ingestion** (WS8) — the knowledge indexer needs to "subscribe to source changes: re-embed on update, hard-delete embeddings + KG nodes on tombstone/erasure" (`2026-07-04-ws8-ai-native-agent-platform.md:92`), which requires *some* durable, replayable stream of domain events to subscribe to.

Before this spec, `platform-nest/src` has **no outbox, event-emitter, or pub/sub code** — this is greenfield within an otherwise-built ModuleContract framework (`platform-nest/src/modules/contract.ts`, `registry.ts`, `module-enabled.guard.ts`).

---

## 1. Architecture

```
[service code]──(same txn)──▶ outbox_events table ──▶ [relay worker, polls every ~500ms]
                                                              │
                                                              ▼
                                                    Redis Streams (per entity_type)
                                                    ┌─────────────┴─────────────┐
                                              [EventConsumerService,      [external services:
                                           in-process, dispatches to     ai-agents RAG re-index,
                                           ModuleContract.eventHandlers]  automation/n8n, etc.
                                                                           — plain Redis clients]
```

**Broker: Redis Streams**, not Redpanda/NATS as the register literally names. The platform already runs Redis for wa-chat-bot's BullMQ media queue (`infra/compose/docker-compose.vps.yml`) — Redis Streams gives consumer groups, at-least-once delivery, and replay via the pending-entries list with **zero new infrastructure**. Redpanda/NATS remain candidates if event volume or fan-out ever outgrows Redis Streams; not needed for v1 scale.

---

## 2. Outbox table

Extends the shape already specced for `sync_outbox` in `2026-07-04-ws1-core-schema-and-module-framework.md:96`, so the deferred sync engine can read the same rows later without a migration:

```sql
CREATE TABLE outbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  entity_type   text NOT NULL,        -- e.g. 'deliverable', 'creative_asset'
  entity_id     uuid NOT NULL,
  event_type    text NOT NULL,        -- e.g. 'deliverable.approved'
  payload       jsonb NOT NULL,
  origin_site   text NOT NULL DEFAULT 'central',  -- reserved for future sync engine
  schema_version int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  relayed_at    timestamptz            -- NULL = not yet pushed to Redis Streams
);
CREATE INDEX ON outbox_events (relayed_at) WHERE relayed_at IS NULL;
```

- `event_type` (distinct from `entity_type`) lets a module emit a meaningful domain event without consumers having to infer intent from diffing `payload`.
- FORCE RLS applies (tenant_id-scoped), same pattern as every other core table.
- `origin_site`/`schema_version` are carried now, unused by v1 (single-region, no multi-site sync yet), so the sync engine doesn't require a schema change when it's eventually built.

---

## 3. Write path — explicit emit()

Module/service code calls an injected `OutboxService.emit(tenantId, entityType, entityId, eventType, payload)` **inside the same DB transaction** as the business write. This is a deliberate choice over blanket DB triggers: events are intentional domain events (`'deliverable.approved'`), not raw row-diffs, matching the register's "modules emit/consume" wording and keeping module boundaries at the application layer rather than the DB layer.

---

## 4. Relay & delivery semantics

- **Relay worker**: a `platform-nest` scheduled provider (same PG-scheduler-idempotency pattern as the bot's digest scheduler) polls `outbox_events WHERE relayed_at IS NULL ORDER BY created_at LIMIT N`, `XADD`s each row to stream `events:{entity_type}` (carrying the outbox `id`), then marks `relayed_at`. Crash-safe: an interrupted batch just reprocesses unrelayed rows on the next tick.
- **Streams are per `entity_type`**, not one global stream — keeps consumer groups scoped, so one noisy entity type can't starve others.
- **Consumer groups**: one per subscriber (e.g. `in-process-platform`, `ragindex`) via `XGROUP CREATE`. Redis Streams' pending-entries list gives retry-on-crash for free.
- **Guarantee: at-least-once.** Every consumer — in-process handler or external service — **must be idempotent**, keyed on the outbox `id`. Same idempotent-apply discipline already established in the sync-engine spec; one consistent mental model across both.
- **Dead-letter**: a handler that throws is not ACKed; after N redeliveries (via `XPENDING`/`XCLAIM`) the event moves to `events:{entity_type}:dead-letter`, alerting through the same path as the bot's existing cost-cap alert.

---

## 5. Consumer contract

**In-process (platform-nest's own modules)**: extend `ModuleContract` (`platform-nest/src/modules/contract.ts:47-59`) with an optional field:

```ts
eventHandlers?: {
  [eventType: string]: (event: OutboxEvent) => Promise<void>;
};
```

A single core `EventConsumerService` reads each stream's consumer group and dispatches to whichever *enabled* module registered a handler for that `event_type` — mirrors how routes/permissions/mcpTools already flow through the registry (`registry.ts`). Each handler invocation is wrapped individually (try/catch + timeout) so one module's failure can't stall others sharing the consumer loop.

**External services** (ai-agents' RAG indexer, automation/n8n, and any future consumer): plain Redis clients speaking the same Streams protocol, with their own consumer group name. No special integration surface is needed — these are already separate standalone projects per the project's non-monorepo convention, and Redis Streams are network-addressable. This is how WS8's "indexer subscribes to source changes" requirement gets satisfied without coupling ai-agents into platform-nest's process.

**Event contract stability**: `event_type` + `schema_version` in the payload; consumers ignore unknown fields; a version bump is additive-only (no breaking payload changes without a new `event_type` or a major version bump).

---

## 6. Testing

- Unit tests for `OutboxService.emit()` — asserts the outbox row is written in the same transaction as the business write (rollback ⇒ no orphan outbox row).
- Relay-worker tests against a real Redis (live-infra testing is already this codebase's convention — platform tests require live Postgres + Cerbos per `platform-nest/.env.example` + `test-all.sh`).
- A replay/idempotency test: kill the relay mid-batch, restart, assert no duplicate side effects downstream (consumers dedupe on outbox `id`).

---

## 7. Open items (flagged, not silently dropped)

- **Retention/trimming**: no `XTRIM`/outbox-row-purge policy defined yet — not needed at v1 event volume, but must be addressed before this becomes a growth liability.
- ~~**Relationship to the future sync engine**...~~ **Resolved** in `2026-07-06-ws1-sync-engine-revision.md` §1 (D7 fix): `outbox_events` *is* `sync_outbox` — one table, two independent cursor-based readers (this spec's relay, and the sync engine's push/pull). No dual-write, no sibling table.
- **WS8 event taxonomy**: which specific event types trigger re-embed vs. hard-delete in the RAG indexer is WS8's responsibility to define when it becomes a consumer of this backbone, not this spec's.
