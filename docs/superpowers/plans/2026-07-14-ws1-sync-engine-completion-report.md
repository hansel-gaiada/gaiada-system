# WS1 Sync Engine — Completion Report (2026-07-14)

**Status:** BUILT and green. Implements `2026-07-06-ws1-sync-engine-revision.md` (closes D3/D5/D7)
and `2026-07-06-ws1-sync-engine-plan.md`, extended to a fully runnable engine (the original plan
built only the reconciliation primitives).

## What shipped

`sync-engine-go/` — one Go binary, central or site role (`SYNC_MODE`):

- **HLC clock** stamped by platform-nest on every emit (`migrations/0012_outbox_hlc.sql`,
  `src/events/hlc.ts`, wired in `outbox.service.ts` + seeded in `main.ts`) and mirrored in
  `internal/hlc`. Canonical zero-padded `"%013d.%010d"` text so SQL `hlc > cursor` / `MAX(hlc)` are
  correct as plain text. Failover monotonicity guard (D3 #4).
- **Sync schema** `migrations/0013_sync_tables.sql`: `sync_cursors`, **`sync_applied_events`**
  (dedup ledger), `sync_conflicts` (FORCE RLS), `sync_dead_letter`, `site_subscriptions`.
- **Idempotent apply** (`internal/protocol/apply.go`): dedup by `(origin_site, event_id)` — never
  by clock, and **never via `relayed_at`** (D7 independent cursors); declarative per-field conflict
  resolution; every divergence writes a `sync_conflicts` row **and** an `activities` audit row
  (D3 #7); entity write-back registry (`writeback.go`) for deliverable/campaign/time_entry, unknown
  types dead-lettered.
- **Per-tenant RLS** (`internal/db.WithTenant`) — Go port of `withTenants`, no BYPASSRLS (D5).
- **ACL** (`acl.go` + `site_subscriptions`) enforced server-side per batch; out-of-scope events go
  to the anomaly path, not silently dropped (D5).
- **mTLS** (`internal/mtls`, `internal/certs`, `cmd/synccert`) reusing the gateway's persisted CA.
- **Wire protocol + central server** (`push.go`/`pull.go`/`collect.go`/`syncclient.go`,
  `internal/server`): `POST /sync/push`, `GET /sync/pull` over mTLS; CN → ACL.
- **Engine binary** (`cmd/sync`, `internal/config`): central serves; site runs push→pull→GC ticker.
- **Bootstrap + anti-entropy** (`internal/bootstrap`): consistent snapshot + atomic watermark,
  merkle checksum gate, drift-detecting anti-entropy sweep.
- **Tombstone GC** (`internal/gc`): purge only past `min(cursor)` across subscribers AND after the
  relay shipped it; delete-wins, no resurrection.

## Verification

- Full Go suite green against a live 2-Postgres harness (NOBYPASSRLS role): hlc, conflict, db,
  certs, mtls (handshake + CN-allowlist rejection), protocol (idempotency, conflict+audit,
  LWW write-back, dead-letter, ACL, `relayed_at` untouched), central server push/pull over mTLS,
  bootstrap (converge + merkle gate + anti-entropy), GC (watermark + un-relayed + unpulled-subscriber
  guards), and the property-based **convergence** + **partition/chaos/idempotency/delete-wins** tests.
- platform-nest: HLC unit tests + outbox suite green (every emitted row carries a strictly
  increasing padded HLC); `tsc` clean.
- CI: new `sync-engine-go` job provisions Postgres + migrations + a NOBYPASSRLS role and runs the
  full suite; `test-all.sh` extended; `infra/compose` runs an idle `sync-central` service.

## Deliberate deviations (flagged, not silent)

1. **HLC stored as a first-class `outbox_events.hlc` column** (spec-faithful) rather than inside the
   payload — required a platform-nest migration + write-path edit; the outbox schema previously had
   no clock at all.
2. **Cert issuance code is mirrored in `internal/certs`, not imported** from
   `ai-gateway-go/internal/tls` — Go forbids cross-module `internal/` imports. The **CA (trust
   root) is genuinely shared**: `synccert` loads the gateway's persisted `data/ca-cert.pem`/key.
3. **conflict-queue converges provisionally to the highest-HLC value** while recording the conflict
   for review — so state converges deterministically across nodes AND nothing is silently lost. A
   defensible reading of "no silent loss"; the shown value is deterministic and flagged.
4. **Scalar HLC pull cursor** is a fast-path low-watermark; correctness against late, lower-HLC
   events from another origin is guaranteed by the applied-events ledger (dedup) + the anti-entropy
   sweep (the spec's mandated completeness backstop), not the cursor alone.
5. **Windows Smart App Control** blocks unsigned temp test binaries; `run-tests.sh` recompiles to a
   fresh project-local name per attempt. CI on ubuntu runs plain `go test` (full `go vet`).

## Not in scope (per spec §5)

Real second-physical-site deploy (code + correctness done; deploy waits on infra); WireGuard detail
beyond CA node identity; content-addressed blob store for large files synced outside the outbox.
