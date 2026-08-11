# CLAUDE.md — sync-engine-go

Scope: `sync-engine-go/` — cross-site reconciliation (`module gaiada/sync-engine-go`, go 1.26).
One binary runs in either role: **central** (serves push/pull over mTLS) or **site**
(push → pull → GC ticker). Deployed as the **idle `sync-central` compose service** — it waits on a
real second site, so "it isn't doing anything" is the expected state. Root `../CLAUDE.md` has
program rules; `README.md` here has the design narrative.

```
go build ./... && go vet ./... && go test ./...   # the CI `sync-engine-go` job
./run-tests.sh                                    # full suite incl. the 2-Postgres harness
docker compose -f docker-compose.chaos.yml up -d  # partition/chaos harness
go run ./cmd/sync      # the engine
go run ./cmd/synccert  # issues node certs from the gateway's persisted internal CA
```

`cmd/` = `sync`, `synccert`. `internal/` = `bootstrap certs config conflict db gc hlc metrics mtls
protocol server telemetry`. Smart App Control blocks locally-built Go exes on Windows — see
`wsl.ps1`.

## What it reconciles, and the invariants

The shared **`outbox_events`** log (the same table `platform-nest`'s relay reads — it is also
`sync_outbox`). Ordering is by **HLC**, stamped by `platform-nest` on emit; this service never
mints one.

- **D7 — the sync path NEVER touches the relay's `relayed_at`.** Dedup is its own ledger,
  `sync_applied_events`. Sharing that column would make two consumers fight over one cursor.
- **Per-tenant RLS on every operation** — `internal/db` is a Go port of `withTenants`. Same
  fail-closed consequence as the platform: an unset tenant context means zero rows, no error.
- **Conflict resolution is declarative per field**: `status` / money fields → conflict queue,
  everything else → last-write-wins. Don't add an imperative special case; extend the table.
- **`site_subscriptions` is central-authoritative** (D5). A site cannot widen its own ACL.
- **Tombstone GC is watermark-gated, delete-wins, no resurrection.** The watermark ordering is
  what makes that safe — a GC that runs ahead of it deletes rows a lagging site still needs.
- New-node bootstrap = snapshot + atomic watermark + merkle gate + anti-entropy sweep.

Schema: `0012_outbox_hlc.sql`, `0013_sync_tables.sql` in `platform-nest/migrations/`. mTLS reuses
the **gateway's** persisted internal CA — one CA for the whole internal mesh.

Convergence is covered by property-based tests plus partition/chaos on the local 2-Postgres
harness. If you change ordering, conflict rules, or GC, that harness is the gate — a green unit
run proves nothing about convergence.
