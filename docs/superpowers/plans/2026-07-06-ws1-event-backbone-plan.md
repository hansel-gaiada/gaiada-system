# Event Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `platform-nest` a transactional outbox + Redis Streams relay so modules can emit domain events in the same DB transaction as their writes, and other modules (in-process) or external services (ai-agents, automation/n8n) can consume them reliably.

**Architecture:** Service code calls `OutboxService.emit()` inside its existing transaction (writes a row to `outbox_events`). A polling relay worker moves unrelayed rows into per-`entity_type` Redis Streams. A core `EventConsumerService` reads those streams via consumer groups and dispatches to whichever enabled module registered a handler in its `ModuleContract.eventHandlers`. External services consume the same streams as plain Redis clients.

**Tech Stack:** NestJS (Fastify adapter), PostgreSQL (`pg`), Redis Streams via `ioredis`, Vitest.

## Global Constraints

- Outbox writes MUST happen in the same DB transaction as the triggering business write (use the existing `withTenants()` helper from `platform-nest/src/db/index.ts`, never a separate connection).
- RLS: `outbox_events` gets the same array-set tenant policy as every other core table (`tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[])`) — copy the exact policy shape from `platform-nest/migrations/0009_files.sql:23-31`.
- `origin_site` column defaults from `config.originSite` (`platform-nest/src/config.ts:12`), matching every other core table's convention.
- Delivery is at-least-once — every consumer must be idempotent, keyed on the outbox row's `id`.
- No third-party web framework changes; this only adds `ioredis` as a new dependency.
- Live-infra testing convention: tests skip via `describe.skipIf(!TEST_URL)` when `DATABASE_URL_TEST` isn't set (see `platform-nest/src/testing/setup.ts`), and analogously skip without a live Redis (`REDIS_URL_TEST`).

---

## File Structure

```
platform-nest/
  migrations/0010_outbox_events.sql       — new table + RLS policy
  src/
    events/
      outbox.service.ts                    — OutboxService.emit()
      outbox.service.test.ts
      redis.ts                             — ioredis connection helper (shared by relay + consumer)
      relay.ts                             — polling relay: outbox_events -> Redis Streams
      relay.test.ts
      consumer.service.ts                  — EventConsumerService: XREADGROUP -> dispatch to ModuleContract.eventHandlers
      consumer.service.test.ts
      types.ts                             — OutboxEvent type shared across the above
    modules/contract.ts                    — MODIFY: add eventHandlers field
    main.ts                                — MODIFY: start relay + consumer on bootstrap
package.json                               — MODIFY: add ioredis dependency
infra/compose/docker-compose.vps.yml       — MODIFY: add REDIS_URL to the platform service
```

---

### Task 1: `outbox_events` table + RLS

**Files:**
- Create: `platform-nest/migrations/0010_outbox_events.sql`
- Test: `platform-nest/src/events/outbox.service.test.ts` (Step 2 below verifies the table shape indirectly via `OutboxService`)

**Interfaces:**
- Produces: table `outbox_events(id uuid, tenant_id uuid, entity_type text, entity_id uuid, event_type text, payload jsonb, origin_site text, schema_version int, created_at timestamptz, relayed_at timestamptz)`, with a partial index on `relayed_at IS NULL`.

- [ ] **Step 1: Write the migration**

```sql
-- Event backbone outbox (WS1 sub-spec 2026-07-05-ws1-event-backbone.md). This table also
-- IS sync_outbox per the sync-engine revision (2026-07-06-ws1-sync-engine-revision.md §1) —
-- one table, two independent cursor-based readers (this relay, and the future sync engine).
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  origin_site text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  relayed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_events_unrelayed ON outbox_events (created_at) WHERE relayed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_events_entity ON outbox_events (tenant_id, entity_type, entity_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON outbox_events';
  EXECUTE 'CREATE POLICY tenant_isolation ON outbox_events FOR ALL
    USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
    WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))';
END $$;
```

- [ ] **Step 2: Run migrations against the test DB to confirm it applies cleanly**

Run: `cd platform-nest && DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/gaiada_platform_test npx vitest run src/health/health.e2e.test.ts`

Expected: PASS (this suite calls `initTestDb()`, which runs every migration including the new one — a migration syntax error would fail here).

- [ ] **Step 3: Commit**

```bash
git add platform-nest/migrations/0010_outbox_events.sql
git commit -m "feat(platform-nest): add outbox_events table (event backbone + future sync engine)"
```

---

### Task 2: `OutboxEvent` type + `OutboxService.emit()`

**Files:**
- Create: `platform-nest/src/events/types.ts`
- Create: `platform-nest/src/events/outbox.service.ts`
- Test: `platform-nest/src/events/outbox.service.test.ts`

**Interfaces:**
- Consumes: `withTenants` from `platform-nest/src/db` (signature: `withTenants<T>(tenantIds: string[], fn: (client: PoolClient) => Promise<T>): Promise<T>`), `newId` from `platform-nest/src/db`, `config.originSite` from `platform-nest/src/config`.
- Produces: `export interface OutboxEvent { id: string; tenantId: string; entityType: string; entityId: string; eventType: string; payload: Record<string, unknown>; originSite: string; schemaVersion: number; createdAt: string }`; `export async function emitEvent(client: PoolClient, tenantId: string, entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>): Promise<string>` (returns the new outbox row's `id`).

- [ ] **Step 1: Write the failing test**

```typescript
// platform-nest/src/events/outbox.service.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("OutboxService.emit", () => {
  let co: string;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Outbox Test Co");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("writes a row in the same transaction as the caller", async () => {
    const entityId = "00000000-0000-0000-0000-000000000001";
    await withTenants([co], async (c) => {
      await emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { approvedBy: "u1" });
    });
    const { rows } = await adminPool().query(
      `SELECT tenant_id, entity_type, entity_id, event_type, payload, relayed_at FROM outbox_events WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("deliverable.approved");
    expect(rows[0].payload).toEqual({ approvedBy: "u1" });
    expect(rows[0].relayed_at).toBeNull();
  });

  it("rolls back the outbox row if the transaction rolls back", async () => {
    const entityId = "00000000-0000-0000-0000-000000000002";
    await expect(
      withTenants([co], async (c) => {
        await emitEvent(c, co, "deliverable", entityId, "deliverable.approved", {});
        throw new Error("simulated failure after emit");
      }),
    ).rejects.toThrow("simulated failure");
    const { rows } = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1`, [entityId]);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-nest && DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/gaiada_platform_test npx vitest run src/events/outbox.service.test.ts`
Expected: FAIL with `Cannot find module './outbox.service'`

- [ ] **Step 3: Write the types file**

```typescript
// platform-nest/src/events/types.ts
export interface OutboxEvent {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  originSite: string;
  schemaVersion: number;
  createdAt: string;
}
```

- [ ] **Step 4: Write the minimal implementation**

```typescript
// platform-nest/src/events/outbox.service.ts
// OutboxService (WS1 event-backbone spec §3): explicit emit(), same transaction as the
// caller's business write. This is the ONLY write path into outbox_events — no triggers.
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";

export async function emitEvent(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  entityId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO outbox_events (id, tenant_id, entity_type, entity_id, event_type, payload, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tenantId, entityType, entityId, eventType, JSON.stringify(payload), config.originSite],
  );
  return id;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd platform-nest && DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/gaiada_platform_test npx vitest run src/events/outbox.service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add platform-nest/src/events/types.ts platform-nest/src/events/outbox.service.ts platform-nest/src/events/outbox.service.test.ts
git commit -m "feat(platform-nest): add OutboxService.emit() (event backbone write path)"
```

---

### Task 3: Extend `ModuleContract` with `eventHandlers`

**Files:**
- Modify: `platform-nest/src/modules/contract.ts:47-59`
- Test: none required (type-only change; exercised by Task 6's test)

**Interfaces:**
- Produces: `ModuleContract.eventHandlers?: { [eventType: string]: (event: OutboxEvent) => Promise<void> }`.

- [ ] **Step 1: Modify the interface**

Add the import and field to `platform-nest/src/modules/contract.ts`:

```typescript
import type { OutboxEvent } from "../events/types";
```

```typescript
export interface ModuleContract {
  key: string; // 'agency', 'resort', ...
  /** Migration files this module owns (must exist in migrations/; applied globally). */
  migrations: string[];
  /** Fastify-era route registrar. In the NestJS port each vertical is a NestJS module +
   *  controller instead, so this is OPTIONAL (kept for the registry/rollup metadata shape). */
  routes?: (app: FastifyInstance) => void;
  permissions: PermissionDef[];
  customFieldTargets: string[];
  mcpTools: McpToolDef[];
  rollupProviders: RollupProvider[];
  uiManifest: UiManifestEntry[];
  /** Event backbone (WS1 sub-spec): handlers for domain events this module reacts to,
   *  keyed by event_type. Dispatched by EventConsumerService only if the module is
   *  enabled for the event's tenant. */
  eventHandlers?: { [eventType: string]: (event: OutboxEvent) => Promise<void> };
}
```

- [ ] **Step 2: Run the existing test suite to confirm no regression**

Run: `cd platform-nest && DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/gaiada_platform_test npx vitest run src/modules/agency/agency.test.ts`
Expected: PASS (optional field doesn't break the existing `agencyModule` contract object, which doesn't set it)

- [ ] **Step 3: Commit**

```bash
git add platform-nest/src/modules/contract.ts
git commit -m "feat(platform-nest): add ModuleContract.eventHandlers for event backbone consumers"
```

---

### Task 4: Redis connection helper + `ioredis` dependency

**Files:**
- Modify: `platform-nest/package.json`
- Create: `platform-nest/src/events/redis.ts`
- Modify: `platform-nest/src/config.ts`

**Interfaces:**
- Produces: `export function getRedis(): Redis` (a shared `ioredis` client, lazily constructed from `config.redisUrl`), `export function closeRedis(): Promise<void>`.

- [ ] **Step 1: Add the dependency**

```bash
cd platform-nest && npm install ioredis@^5.4.1
```

- [ ] **Step 2: Add `redisUrl` to config**

Modify `platform-nest/src/config.ts`, adding after `filesDir`:

```typescript
  // Event backbone (5c continuation): Redis Streams for outbox relay + consumption.
  redisUrl: process.env.REDIS_URL ?? "",
```

- [ ] **Step 3: Write the connection helper**

```typescript
// platform-nest/src/events/redis.ts
// Shared ioredis client for the event backbone (relay writer + consumer reader). One
// connection per process is enough at v1 scale; both relay.ts and consumer.service.ts
// import getRedis() rather than constructing their own clients.
import Redis from "ioredis";
import { config } from "../config";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    if (!config.redisUrl) throw new Error("REDIS_URL not set");
    client = new Redis(config.redisUrl);
  }
  return client;
}

export function setRedis(r: Redis | null): void {
  client = r;
}

export async function closeRedis(): Promise<void> {
  await client?.quit();
  client = null;
}
```

- [ ] **Step 4: Verify the package installs and typechecks**

Run: `cd platform-nest && npx tsc --noEmit`
Expected: exit 0 (no type errors)

- [ ] **Step 5: Commit**

```bash
git add platform-nest/package.json platform-nest/package-lock.json platform-nest/src/config.ts platform-nest/src/events/redis.ts
git commit -m "feat(platform-nest): add ioredis dependency + shared connection helper"
```

---

### Task 5: Relay worker (outbox → Redis Streams)

**Files:**
- Create: `platform-nest/src/events/relay.ts`
- Test: `platform-nest/src/events/relay.test.ts`

**Interfaces:**
- Consumes: `getRedis()` from `./redis`, `withGlobal` from `../db` (relay reads/updates `outbox_events` across all tenants, so it needs global access — see note in Step 3).
- Produces: `export async function relayBatch(limit?: number): Promise<number>` (returns count of rows relayed), `export function startRelayLoop(intervalMs?: number): { stop: () => void }`.

- [ ] **Step 1: Write the failing test**

```typescript
// platform-nest/src/events/relay.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { relayBatch } from "./relay";
import { setRedis, closeRedis } from "./redis";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("relay worker", () => {
  let co: string;
  let redis: Redis;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Relay Test Co");
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
  });
  afterAll(async () => {
    await closeRedis();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await redis.del("events:deliverable");
  });

  it("moves unrelayed rows into the per-entity-type stream and marks them relayed", async () => {
    const entityId = "00000000-0000-0000-0000-000000000010";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { x: 1 }));

    const count = await relayBatch(100);
    expect(count).toBe(1);

    const entries = await redis.xrange("events:deliverable", "-", "+");
    expect(entries).toHaveLength(1);
    const fields = entries[0][1];
    const asObj = Object.fromEntries([0, 2, 4].map((i) => [fields[i], fields[i + 1]]));
    expect(asObj.entityId).toBe(entityId);
    expect(asObj.eventType).toBe("deliverable.approved");

    const again = await relayBatch(100);
    expect(again).toBe(0); // already relayed, not re-sent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-nest && DATABASE_URL_TEST=... REDIS_URL_TEST=redis://localhost:6379/1 npx vitest run src/events/relay.test.ts`
Expected: FAIL with `Cannot find module './relay'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// platform-nest/src/events/relay.ts
// Polling relay (WS1 event-backbone spec §4): moves outbox_events rows into per-entity_type
// Redis Streams. Crash-safe — an interrupted batch just gets picked up by the next tick,
// since rows are only marked relayed_at after a successful XADD.
import { withGlobal } from "../db";
import { getRedis } from "./redis";

interface UnrelayedRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  origin_site: string;
  schema_version: number;
  created_at: Date;
}

export async function relayBatch(limit = 100): Promise<number> {
  const redis = getRedis();
  const { rows } = await withGlobal((c) =>
    c.query<UnrelayedRow>(
      `SELECT id, tenant_id, entity_type, entity_id, event_type, payload, origin_site, schema_version, created_at
       FROM outbox_events WHERE relayed_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    ),
  );
  for (const row of rows) {
    await redis.xadd(
      `events:${row.entity_type}`,
      "*",
      "outboxId", row.id,
      "tenantId", row.tenant_id,
      "entityId", row.entity_id,
      "eventType", row.event_type,
      "payload", JSON.stringify(row.payload),
      "originSite", row.origin_site,
      "schemaVersion", String(row.schema_version),
    );
    await withGlobal((c) => c.query(`UPDATE outbox_events SET relayed_at = now() WHERE id = $1`, [row.id]));
  }
  return rows.length;
}

export function startRelayLoop(intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await relayBatch();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("relay tick failed:", (err as Error).message);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
```

**Note on RLS**: the relay reads/writes across all tenants by design (it's infrastructure, not a tenant-scoped request), so it uses `withGlobal` rather than `withTenants`. `withGlobal` connects with the app's normal least-privilege role — since `outbox_events` FORCE RLS is on and no tenant context is set, the relay's plain SELECT/UPDATE would return zero rows under RLS. Fix this in Step 3.5 below by having the relay iterate authorized tenants explicitly instead of relying on a bypass.

- [ ] **Step 3.5: Fix RLS scoping — relay must not bypass RLS**

Replace the `withGlobal` reads/updates in `relay.ts` with a per-tenant loop, matching the D5 discipline already used everywhere else in this codebase (`withTenants`):

```typescript
// platform-nest/src/events/relay.ts (revised)
import { withGlobal, withTenants } from "../db";
import { getRedis } from "./redis";

interface UnrelayedRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  origin_site: string;
  schema_version: number;
  created_at: Date;
}

export async function relayBatch(limit = 100): Promise<number> {
  const redis = getRedis();
  const tenantIds = (
    await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))
  ).rows.map((r) => r.id);
  if (tenantIds.length === 0) return 0;

  const rows = await withTenants(tenantIds, (c) =>
    c.query<UnrelayedRow>(
      `SELECT id, tenant_id, entity_type, entity_id, event_type, payload, origin_site, schema_version, created_at
       FROM outbox_events WHERE relayed_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    ),
  ).then((r) => r.rows);

  for (const row of rows) {
    await redis.xadd(
      `events:${row.entity_type}`,
      "*",
      "outboxId", row.id,
      "tenantId", row.tenant_id,
      "entityId", row.entity_id,
      "eventType", row.event_type,
      "payload", JSON.stringify(row.payload),
      "originSite", row.origin_site,
      "schemaVersion", String(row.schema_version),
    );
    await withTenants([row.tenant_id], (c) =>
      c.query(`UPDATE outbox_events SET relayed_at = now() WHERE id = $1`, [row.id]),
    );
  }
  return rows.length;
}

export function startRelayLoop(intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await relayBatch();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("relay tick failed:", (err as Error).message);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
```

`companies` is a global (non-RLS) table, so `withGlobal` is correct there; the outbox reads/writes now run through `withTenants` per the platform-wide D5 convention (`platform-nest/src/db/index.ts:32-49`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-nest && DATABASE_URL_TEST=... REDIS_URL_TEST=redis://localhost:6379/1 npx vitest run src/events/relay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add platform-nest/src/events/relay.ts platform-nest/src/events/relay.test.ts
git commit -m "feat(platform-nest): add outbox relay worker (polls outbox_events -> Redis Streams)"
```

---

### Task 6: `EventConsumerService` (in-process dispatch to `ModuleContract.eventHandlers`)

**Files:**
- Create: `platform-nest/src/events/consumer.service.ts`
- Test: `platform-nest/src/events/consumer.service.test.ts`

**Interfaces:**
- Consumes: `getRedis()` from `./redis`, `allModules()` from `../modules/registry`, `isModuleEnabled()` from `../modules/registry`, `OutboxEvent` from `./types`.
- Produces: `export async function consumeOnce(entityType: string, groupName?: string): Promise<number>` (processes pending stream entries once, returns count handled), `export function startConsumerLoop(entityTypes: string[], intervalMs?: number): { stop: () => void }`.

- [ ] **Step 1: Write the failing test**

```typescript
// platform-nest/src/events/consumer.service.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { relayBatch } from "./relay";
import { consumeOnce } from "./consumer.service";
import { setRedis, closeRedis } from "./redis";
import { registerModule, resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import type { ModuleContract } from "../modules/contract";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("EventConsumerService", () => {
  let co: string;
  let redis: Redis;
  const received: unknown[] = [];

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Consumer Test Co");
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
  });
  afterAll(async () => {
    await closeRedis();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await redis.del("events:deliverable");
    try {
      await redis.xgroup("DESTROY", "events:deliverable", "in-process-platform");
    } catch {
      // group may not exist yet, ignore
    }
    received.length = 0;
    resetModules();
  });

  it("dispatches to the enabled module's handler for the matching event_type", async () => {
    const testModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: {
        "deliverable.approved": async (event) => {
          received.push(event);
        },
      },
    };
    registerModule(testModule);
    // Enable "agency" for this tenant so the dispatch isn't skipped.
    await withTenants([co], (c) =>
      c.query(`UPDATE companies SET enabled_modules = array_append(enabled_modules, 'agency') WHERE id = $1`, [co]),
    );

    const entityId = "00000000-0000-0000-0000-000000000020";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { by: "u1" }));
    await relayBatch(100);

    const handled = await consumeOnce("deliverable");
    expect(handled).toBe(1);
    expect(received).toHaveLength(1);
    expect((received[0] as { entityId: string }).entityId).toBe(entityId);
  });

  it("does not dispatch if the module isn't enabled for the event's tenant", async () => {
    const testModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: { "deliverable.approved": async () => { received.push("should not run"); } },
    };
    registerModule(testModule);
    // Note: enabled_modules defaults empty for a fresh company — do NOT enable "agency" here.
    const entityId = "00000000-0000-0000-0000-000000000021";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", {}));
    await relayBatch(100);

    await consumeOnce("deliverable");
    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-nest && DATABASE_URL_TEST=... REDIS_URL_TEST=redis://localhost:6379/1 npx vitest run src/events/consumer.service.test.ts`
Expected: FAIL with `Cannot find module './consumer.service'`

- [ ] **Step 3: Write the minimal implementation**

```typescript
// platform-nest/src/events/consumer.service.ts
// EventConsumerService (WS1 event-backbone spec §5): reads each entity_type stream's
// consumer group, dispatches to whichever ENABLED module registered a handler for that
// event_type. Each handler call is isolated (try/catch) so one module's failure can't
// stall dispatch to others sharing the same batch.
import { allModules, isModuleEnabled } from "../modules/registry";
import { getRedis } from "./redis";
import type { OutboxEvent } from "./types";

const GROUP = "in-process-platform";
const CONSUMER = "platform-1";

async function ensureGroup(stream: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.xgroup("CREATE", stream, GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!(err as Error).message.includes("BUSYGROUP")) throw err;
  }
}

function parseFields(fields: string[]): OutboxEvent {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return {
    id: obj.outboxId,
    tenantId: obj.tenantId,
    entityType: "", // filled by caller from the stream name
    entityId: obj.entityId,
    eventType: obj.eventType,
    payload: JSON.parse(obj.payload || "{}"),
    originSite: obj.originSite,
    schemaVersion: Number(obj.schemaVersion || "1"),
    createdAt: new Date().toISOString(),
  };
}

export async function consumeOnce(entityType: string, groupName = GROUP): Promise<number> {
  const redis = getRedis();
  const stream = `events:${entityType}`;
  await ensureGroup(stream);
  const result = await redis.xreadgroup("GROUP", groupName, CONSUMER, "COUNT", "50", "STREAMS", stream, ">");
  if (!result) return 0;
  const [[, entries]] = result as [string, [string, string[]][]][];
  let handled = 0;
  for (const [entryId, fields] of entries) {
    const event = { ...parseFields(fields), entityType };
    for (const mod of allModules()) {
      const handler = mod.eventHandlers?.[event.eventType];
      if (!handler) continue;
      if (!(await isModuleEnabled(event.tenantId, mod.key))) continue;
      try {
        await handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`event handler failed (module=${mod.key}, event=${event.eventType}):`, (err as Error).message);
        continue; // leave un-ACKed -> redelivered / eventually dead-lettered (Task 7)
      }
    }
    await redis.xack(stream, groupName, entryId);
    handled++;
  }
  return handled;
}

export function startConsumerLoop(entityTypes: string[], intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const t of entityTypes) {
      try {
        await consumeOnce(t);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`consumer tick failed for ${t}:`, (err as Error).message);
      }
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-nest && DATABASE_URL_TEST=... REDIS_URL_TEST=redis://localhost:6379/1 npx vitest run src/events/consumer.service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add platform-nest/src/events/consumer.service.ts platform-nest/src/events/consumer.service.test.ts
git commit -m "feat(platform-nest): add EventConsumerService (dispatches to ModuleContract.eventHandlers)"
```

---

### Task 7: Dead-letter on repeated handler failure

**Files:**
- Modify: `platform-nest/src/events/consumer.service.ts`
- Test: `platform-nest/src/events/consumer.service.test.ts` (add a case)

**Interfaces:**
- Produces: `export const DEAD_LETTER_MAX_RETRIES = 5`. Entries un-ACKed past this count move to `events:{entityType}:dead-letter` (a plain `XADD`, not a consumer group) and are ACKed on the original stream so they stop being redelivered there.

- [ ] **Step 1: Write the failing test (append to `consumer.service.test.ts`)**

```typescript
  it("moves an event to the dead-letter stream after repeated handler failure", async () => {
    const failingModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: {
        "deliverable.approved": async () => {
          throw new Error("always fails");
        },
      },
    };
    registerModule(failingModule);
    await withTenants([co], (c) =>
      c.query(`UPDATE companies SET enabled_modules = array_append(enabled_modules, 'agency') WHERE id = $1`, [co]),
    );
    const entityId = "00000000-0000-0000-0000-000000000030";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", {}));
    await relayBatch(100);

    // Retry past DEAD_LETTER_MAX_RETRIES.
    for (let i = 0; i < 6; i++) await consumeOnce("deliverable");

    const dead = await redis.xrange("events:deliverable:dead-letter", "-", "+");
    expect(dead.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-nest && DATABASE_URL_TEST=... REDIS_URL_TEST=redis://localhost:6379/1 npx vitest run src/events/consumer.service.test.ts`
Expected: FAIL (dead-letter stream is empty — nothing writes to it yet)

- [ ] **Step 3: Implement retry counting + dead-letter**

Modify `consumeOnce` in `platform-nest/src/events/consumer.service.ts` to check delivery count via `XPENDING` and dead-letter past the threshold:

```typescript
export const DEAD_LETTER_MAX_RETRIES = 5;

export async function consumeOnce(entityType: string, groupName = GROUP): Promise<number> {
  const redis = getRedis();
  const stream = `events:${entityType}`;
  await ensureGroup(stream);
  const result = await redis.xreadgroup("GROUP", groupName, CONSUMER, "COUNT", "50", "STREAMS", stream, ">");
  if (!result) return 0;
  const [[, entries]] = result as [string, [string, string[]][]][];
  let handled = 0;
  for (const [entryId, fields] of entries) {
    const event = { ...parseFields(fields), entityType };
    let allOk = true;
    for (const mod of allModules()) {
      const handler = mod.eventHandlers?.[event.eventType];
      if (!handler) continue;
      if (!(await isModuleEnabled(event.tenantId, mod.key))) continue;
      try {
        await handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`event handler failed (module=${mod.key}, event=${event.eventType}):`, (err as Error).message);
        allOk = false;
      }
    }
    if (allOk) {
      await redis.xack(stream, groupName, entryId);
      handled++;
      continue;
    }
    const pending = await redis.xpending(stream, groupName, entryId, entryId, 1);
    const deliveryCount = Array.isArray(pending) && pending[0] ? Number((pending[0] as unknown[])[3]) : 1;
    if (deliveryCount >= DEAD_LETTER_MAX_RETRIES) {
      await redis.xadd(`${stream}:dead-letter`, "*", ...fields);
      await redis.xack(stream, groupName, entryId); // stop redelivering on the live stream
    }
    // else: leave un-ACKed, will be redelivered on a future XREADGROUP with ">" via XCLAIM in a later pass
  }
  return handled;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-nest && DATABASE_URL_TEST=... REDIS_URL_TEST=redis://localhost:6379/1 npx vitest run src/events/consumer.service.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add platform-nest/src/events/consumer.service.ts platform-nest/src/events/consumer.service.test.ts
git commit -m "feat(platform-nest): dead-letter events after repeated handler failure"
```

---

### Task 8: Wire relay + consumer into bootstrap and compose

**Files:**
- Modify: `platform-nest/src/main.ts`
- Modify: `infra/compose/docker-compose.vps.yml`

**Interfaces:**
- Consumes: `startRelayLoop` from `./events/relay`, `startConsumerLoop` from `./events/consumer.service`.

- [ ] **Step 1: Start both loops in `bootstrap()`**

Modify `platform-nest/src/main.ts`:

```typescript
import { startRelayLoop } from "./events/relay";
import { startConsumerLoop } from "./events/consumer.service";
```

```typescript
async function bootstrap(): Promise<void> {
  await migrate();
  registerModule(agencyModule);
  registerCoreRollupProvider(coreTaskRollups);
  registerCoreRollupProvider(clientWorkRollups);
  await syncMetricDefinitions();
  if (process.env.REDIS_URL) {
    startRelayLoop();
    // Entity types with at least one registered handler; extend as modules add eventHandlers.
    startConsumerLoop(["deliverable"]);
  }
  const app = await buildApp();
  const port = Number(process.env.PLATFORM_PORT ?? 3004);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`Gaiada Platform (NestJS) on ${host}:${port}`);
}
```

Guarding on `process.env.REDIS_URL` keeps local/test bootstraps (which don't set it) from crashing on `getRedis()`'s "REDIS_URL not set" throw.

- [ ] **Step 2: Add `REDIS_URL` to the `platform` service in compose**

Modify `infra/compose/docker-compose.vps.yml`, in the `platform` service's `environment:` block (after `FILES_DIR`):

```yaml
      REDIS_URL: redis://redis:6379
```

And add `redis` to its `depends_on`:

```yaml
    depends_on:
      postgres:
        condition: service_healthy
      cerbos:
        condition: service_started
      redis:
        condition: service_started
```

- [ ] **Step 3: Verify the app still boots locally**

Run: `cd platform-nest && npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add platform-nest/src/main.ts infra/compose/docker-compose.vps.yml
git commit -m "feat(platform-nest): start event relay + consumer loops on bootstrap (compose: platform depends on redis)"
```

---

## Self-Review Notes

- **Spec coverage**: outbox table + RLS (Task 1), explicit `emit()` write path (Task 2), `ModuleContract.eventHandlers` extension (Task 3), Redis Streams relay (Task 5), in-process consumer dispatch (Task 6), dead-letter (Task 7), bootstrap wiring (Task 8) — all six spec sections (§2–§5) have a corresponding task. External-consumer support (§5, "plain Redis clients") needs no platform-nest code — it's satisfied by the streams existing and being network-addressable; no task needed.
- **Deferred per spec §7, not built here**: retention/trimming (`XTRIM`), and WS8's specific event taxonomy (that's WS8's task when it becomes a consumer, not this plan's).
- **Type consistency checked**: `OutboxEvent` (Task 2's `types.ts`) is the same shape referenced in `ModuleContract.eventHandlers` (Task 3) and produced by `consumer.service.ts` (Task 6) — `entityType`, `entityId`, `eventType`, `payload`, `tenantId`, `originSite`, `schemaVersion`, `createdAt` match across all three.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-06-ws1-event-backbone-plan.md`.**
