# WebDesk M3 — a complete CMS, Payload removed (working plan)

**Started:** 2026-10-11 · **Status lives in** [`TASKS.md`](../../TASKS.md) (M3) · **Rulings:**
[`webdesk-design-v2.md`](../blueprints/webdesk-design-v2.md) §14, WSK-D49…D51 (owner, 2026-10-11) ·
**Follows:** [`2026-10-10-webdesk-gaiada-proof.md`](./2026-10-10-webdesk-gaiada-proof.md) (M1/M2)

Status words are the estate's: PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED (driven on a Linux
server, result observed). Every ticket's gate is `webdesk/qa/linux-gate.sh` on sumopod, plus its own checks.

## Tickets

| # | Scope | Seat | Migration | Order |
|---|---|---|---|---|
| **T1** | `/v1` read path: reserved collection keys, percent-decoded segments, bad cursor → 400, bad `%` → problem+json, no raw error text in 500s | Sonnet | — | wave 1 |
| **T2** | Codegen `oneOf` → `anyOf`; schema-draft prompt teaches 1.1.0; WordPress theme knows `fields` | Sonnet | — | wave 1 |
| **T3** | MinIO residue: residency statement, `check-artifact-url-expiry.mjs` | Haiku | — | wave 1 |
| **T4** | Slugs released on delete (D51); `schema_migrations` revoked from `webdesk_app`; promotion keyed by localization group, soft-deletes, writes versions | Sonnet, Opus review | **0010** | wave 2 |
| **T5a** | WSK-21 commands (keys, lifecycle, schema, releases): durable idempotency; HIGH commands claim the WS4 approval before the effect | Sonnet, Opus review | — | wave 2 |
| **T5b** | The same for promotion (WSK-25) and privacy (WSK-38) | Sonnet, Opus review | — | after T4 |
| **T6** | Read quota in Redis (multi-replica); storage lifecycle for locked versions; quota counts bytes held | Sonnet | — | wave 3 |
| **T7** | ERP: Cerbos DENY on publish/schedule for automation principals; requester-own read of an approval | Sonnet, Opus review | — (Cerbos) | wave 3 |
| **WSK-48b** | Delete Payload; `webdesk/payload/` → `webdesk/delivery/` (vocabulary source); differential → golden suite | Sonnet, Opus review | **0011** | after T1, T2 |
| **WSK-61** | Scheduler: due publishes/takedowns, live-item version swaps, forms purge, idempotency sweep | Sonnet, Opus review | **0012** | after T4, T5a |
| WSK-46 · WSK-45 · WSK-43 · WSK-49 | Preview, WYSIWYG Markdown editor (D49), media library, client editors | later waves | | |

The three editor defects (`lint.unavailable`, `502 webdesk_ambiguous`, `503 webdesk_not_configured`) are being
fixed by the M2 session (`webdesk/editor-followups`); M3 does not touch `platform-ui/src/components/webdesk/**` meanwhile.

## T4 · Promotion after the write plane

WSK-25's promotion predates migration 0009 and still behaves as if `content_items` were the only copy:

1. Its export includes soft-deleted items, so a promotion resurrects them as live.
2. It upserts on `(collection_id, locale, slug)`, but an item's identity is `(site, localization_group_id, locale)`;
   the slug is mutable. A renamed slug therefore collides with `ux_content_items_group_locale`.
3. Restore hard-deletes rows, which fails on the `content_versions` FK once versions exist, and would erase
   append-only history if it did not.
4. It changes the live projection without appending a version, so `published_version` points at content that is
   no longer live and the editor's working copy disagrees with production.

**Target:** export only live rows. Restore soft-deletes the local items the bundle does not describe, **before**
upserting. Upsert by group and locale; a slug held by another live item is a 409 `slug-taken` and the whole apply
rolls back (D51). Every item written gets a `content_versions` row attributed to the promotion's principal and
approval, with `head_version`/`published_version` moved to it; an unchanged item gets none.

## WSK-48b · Deleting Payload

- **The differential becomes a golden suite first.** `v1-differential.spec.ts` proved the WSK-48a port (710 pairs,
  0 unexplained). Its 662-request extra corpus is the only coverage of `/v1`'s error paths, so it is kept: on a run
  where the differential is green, the api's responses are recorded (volatile values normalised) as golden fixtures,
  and a new spec replays the corpus against the api alone. Then the old router can go.
- **Deleted:** the Payload app (Next app, collections, config, types, Dockerfile, its migrations and tenancy
  shims, `public-gateway.mjs`), its tests, the `payload` service in all three compose files, the CI job and the
  release image.
- **Kept and moved** (`git mv`, history preserved) to `webdesk/delivery/`: `vocabulary/**` and the vocabulary
  tests. `webdesk/delivery/vocabulary/` is the one source; the api, blocks and WordPress copies are vendored from it.
- **Migration 0011** drops exactly the tables and types Payload's own migration created, `IF EXISTS` (the live
  database was rebuilt on 2026-10-10 from WebDesk's migrations only, so this is expected to be a no-op there).

## WSK-61 · The scheduler

The read path already honours `publish_at`/`unpublish_at` by time, so visibility needs no worker. The worker exists
for what time alone cannot do:

| Job | Every | Does |
|---|---|---|
| `content.schedule-tick` | 60 s | Per tenant: flips due `scheduled` items to `published` (attribution from the schedule) and due takedowns to `unpublished` (reusing `content.unpublish`'s effect); executes due **version swaps on live items** from a new `content_schedules` table (migration 0012), which replaces today's 409 `schedule-live-item-requires-worker`. One transaction per item, `FOR UPDATE SKIP LOCKED`. After commit, fail-soft: the tenant webhook (`content.published` / `content.unpublished`) and a Zone B event |
| `forms.retention-purge` | hourly | `SubmissionsPurgeService.purgeDueSubmissions()` (written in WSK-10, never scheduled) |
| `control.idempotency-sweep` | hourly | `PgIdempotencyStore.sweepExpired()` (written in WSK-41, never scheduled) |

- **Runs as BullMQ job schedulers in the api process.** BullMQ creates one job per tick per scheduler id however
  many replicas run, and Redis is already a hard dependency (tenant webhooks, mail). Rejected: `setInterval` (runs
  once per replica), the compose `worker` stub (a second process to ship and harden for three small jobs), `pg_cron`
  (not in the image; puts application logic in the database).
- Any publish, unpublish or delete of an item cancels its pending swap: the newest human decision wins, recorded.
- Executed transitions are audited as `control.content.schedule.executed`, actor `system:scheduler`, with the
  original approval id in the args and **not** in `ws4_approval_id` (that index is single-use).
- **The rebuild at publish time (gaiada.com is static).** The schedule's approval already covers the staging
  rebuild (D46 R3). The ERP half (a new Zone B event kind, widened from the live CHECK definition, and a WSK-60
  dispatch under the original approval) is a separate box, after WSK-60 is live.
