# sync-engine-go — cross-site reconciliation (WS1 T2)

One Go binary runs at **central** (serves push/pull over mTLS) and at each **site** (drives
push→pull→GC on a ticker). It reconciles the shared `outbox_events` log across sites with
HLC-ordered, declarative per-field conflict resolution, per-tenant RLS on every operation, and a
central-authoritative ACL. Buildable and verifiable now via a local two-Postgres harness — no real
second physical site required.

Specs: `docs/superpowers/specs/2026-07-06-ws1-sync-engine-revision.md` (closes D3/D5/D7);
plan: `docs/superpowers/plans/2026-07-06-ws1-sync-engine-plan.md`.

## Design in one screen

- **One clock: HLC** (`internal/hlc`). Padded text `"%013d.%010d"` so SQL `hlc > cursor` /
  `MAX(hlc)` are correct as plain text. platform-nest stamps it on every emit
  (`src/events/hlc.ts`, migration `0012_outbox_hlc.sql`); the Go side parses the identical form.
- **Dedup ≠ conflict.** Replay dedup is a lookup/insert on `sync_applied_events (origin_site,
  event_id)` — never an HLC compare, and it **never touches `outbox_events.relayed_at`** (that is
  the event-backbone relay's cursor; the two readers are independent, D7).
- **Per-field policy** (`internal/conflict`): status/money fields → `conflict-queue` (recorded for
  review, converged provisionally to the highest-HLC value — deterministic, never silently lost),
  everything else → `lww`. Every divergence writes a `sync_conflicts` row **and** an `activities`
  audit row (D3 #7).
- **RLS everywhere** (`internal/db.WithTenant`): `SET LOCAL app.current_tenant_ids` per tx, no
  BYPASSRLS — a Go port of platform-nest's `withTenants`.
- **ACL** (`internal/protocol/acl.go` + `site_subscriptions`): mTLS proves *which node*; the ACL
  proves *which tenants* it may touch, enforced server-side on every batch (D5). Out-of-scope
  events go to the anomaly path, never silently dropped.
- **mTLS** (`internal/mtls`, `internal/certs`): reuses the gateway's persisted internal CA
  (`data/ca-cert.pem`). Issue node certs with `cmd/synccert`.
- **Bootstrap + anti-entropy** (`internal/bootstrap`): consistent snapshot + atomic watermark, a
  post-backfill merkle checksum gate, and a standing anti-entropy sweep (the completeness backstop
  behind the scalar pull cursor).
- **Tombstone GC** (`internal/gc`): purges a delete tombstone only once every subscriber's cursor
  has passed it AND the relay has shipped it; delete-wins, no resurrection.

## Run the tests

Build + vet + DB-less unit tests need nothing:

```bash
go build ./... && go test ./...   # DB-backed tests self-skip without the env vars below
```

The DB-backed suites (apply, ACL, central server, bootstrap, convergence/chaos) need two
databases with the **platform-nest migrations** applied and a **NOBYPASSRLS** role (a superuser
bypasses RLS and tests nothing):

```bash
docker compose -f docker-compose.chaos.yml up -d
# apply ../platform-nest/migrations/*.sql to both DBs, create a NOSUPERUSER NOBYPASSRLS role, then:
export DATABASE_URL_TEST=postgres://sync_app:test@localhost:55432/site_a
export DATABASE_URL_CENTRAL=postgres://sync_app:test@localhost:55433/central
export DATABASE_URL_SITE_A=$DATABASE_URL_TEST
go test ./...
```

On Windows with Smart App Control (enforce), plain `go test` may block the temp test binary; use
`bash run-tests.sh` (compiles to a fresh project-local name per attempt). CI on ubuntu runs plain
`go test` (see `.github/workflows/ci.yml`, job `sync-engine-go`).

## Provision certs

```bash
# reuse the gateway's CA (data/ca-cert.pem, data/ca-key.pem):
go run ./cmd/synccert -ca-cert data/ca-cert.pem -ca-key data/ca-key.pem \
  -cn site-a -out-cert certs/site-a.crt -out-key certs/site-a.key
# greenfield dev with no gateway yet: add -init to generate a CA at those paths first.
```

## Deploy

`infra/compose/docker-compose.vps.yml` runs a `sync-central` service (idle until a real second
site is enrolled). A site node runs the same image with `SYNC_MODE=site`, `CENTRAL_URL`, and its
issued client cert. Config is env-driven (`internal/config`).
