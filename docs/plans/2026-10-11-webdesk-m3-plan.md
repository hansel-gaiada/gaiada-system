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
| **T6** | Read quota in Redis (multi-replica). The storage-lifecycle defect (locked object versions never freed, quota counting rows) moved into WSK-43, which redesigns media deletes anyway | Sonnet | — | wave 3 |
| **T7** | ERP: Cerbos DENY on publish/schedule for automation and bot principals (never on `request_publish`: the importer files its batch request as automation); requester-own read of an approval, same tenant only | Sonnet, Opus review | — (Cerbos) | ships in 1.0.0-alpha.348; the WebDesk orchestrator gates, releases and probes live Cerbos |
| **WSK-48b** | Delete Payload; `webdesk/payload/` → `webdesk/delivery/` (vocabulary source); differential → golden suite | Sonnet, Opus review, **then the WebDesk orchestrator reviews before main** (it touches CI, release and compose) | **0011** | after T1, T2, T4 |
| **WSK-61** | Scheduler: due publishes/takedowns, live-item version swaps, forms purge, idempotency sweep | Sonnet, Opus review | **0012** | after T4, T5a |
| **WSK-46** | Draft preview as an instant page on the site (D52): hashed expiring tokens + public `/v1/t/:tenant/preview/:token`; an ERP Preview action; a `/preview/` page in gaiada-web-revamp | Sonnet, Opus review; the site part with the site owner | **0013** | WebDesk part after WSK-61; ERP part after the M2 editor follow-ups merge (347); site part needs `api.gaiada.com` public |
| **WSK-43a** | Media library, WebDesk half: asset metadata, token uploads, soft delete refused while in use (D54), purge job (frees locked versions), quota in bytes held | Sonnet, Opus review | **0014** | after wave 3 |
| **WSK-43b** | Media library, ERP half: Cerbos kind `webdesk_media_asset` (six artifacts), BFF routes, MCP tools | Sonnet, Opus review; the WebDesk orchestrator releases it (Cerbos restart) | — | after 43a |
| **WSK-43c** | Media library UI: a Media tab in the Website workspace, and a picker for media fields in the editor | Sonnet, Opus review | — | after the M2 editor follow-ups (350) and 43b |
| **WSK-43d** | gaiada-web-revamp's pull step downloads library images into the static build (D53) | with the site owner | — | after 43a |
| **WSK-45** | WYSIWYG Markdown editor (D49): 305/315 real gaiada.com bodies open visually and round-trip byte-identical; the rest open as source | Sonnet, Opus review; the WebDesk orchestrator releases it | — | done, awaiting release |
| **WSK-49a–e** | Client editors through the client portal (D58, D59): see the section below | Sonnet, Opus review; portal parts coordinated with the Three-perspectives program | — | after the ERP-side wave |

**Merging.** Each wave merges to main only after `webdesk/qa/linux-gate.sh` is green on the merged tree (main + the wave), under WSK-D47(b), and the WebDesk orchestrator is told each time.

**Decided on the way (2026-10-11).** A command response that carries a one-time secret (`key.mint`, `key.rotate`) is never stored by the durable idempotency store, not even encrypted; a replay of it is 409 `idempotency-response-withheld`. In production the PDP already refuses a reused HIGH approval before the service runs, so a stored copy could never be served and would only be a liability.

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

## WSK-43 · The media library

Rulings: WSK-D53 (library images reach a static site through its build) and WSK-D54 (an image in use cannot be deleted).
What exists: uploads through the public api with an api key, presigned reads, imgproxy transforms, ClamAV scanning, and the control
read `media.list`. The media primitive stores `{url, alt?, width?, height?, mime?}`, so content refers to an image by URL.

- **Schema (0014).** `media_assets` gains `title`, `alt` (a per-locale map), `tags text[]`, `original_filename`, `width`, `height`,
  `updated_at`, `deleted_at`, `purge_after` and `purged_at`. A library asset's canonical URL is WebDesk's media route
  `/v1/t/<tenant>/media/<assetId>`, and that is what the editor writes into the media field.
- **Uploads never pass through the ERP.** A control command `media.uploadToken` (MEDIUM, editorial assertion) mints a short-lived,
  single-use upload token bound to the tenant, site, bucket, size cap and allowed types. The browser then uploads straight to
  WebDesk on a public route with that token; the existing scan and store path runs. Only the token's hash is stored.
- **Commands.** `media.update` (title, alt, tags), `media.delete` (soft; 409 `media-in-use` listing the items whose live or
  head version references the asset's URL, D54) and a `media.usage` read. `media.list` gains search (title, tags, filename),
  tag and type filters, and hides deleted assets.
- **Lifecycle.** A deleted asset gets `purge_after = deleted_at + the bucket's GOVERNANCE retention`. A scheduler job
  (`media-purge`, hourly, on WSK-61's scheduler) deletes the stored object versions once retention has passed and sets
  `purged_at`. This closes the defect that locked object versions are never freed. The media quota counts the bytes of every
  asset not yet purged, which is what storage actually holds.
- **Static sites (D53).** The site's build step downloads each referenced image through the read key and rewrites its URL into
  the static output. WebDesk serves no public image traffic for a static site.
- **ERP and UI.** A Cerbos kind `webdesk_media_asset` (read, upload, update, delete) with its six artifacts, BFF routes and MCP
  tools for every action, then a Media tab and a picker in the Website workspace.

## WSK-49 · Client editors through the client portal

Rulings: WSK-D58 (a client publisher self-publishes a single item; batches need a second client person) and WSK-D59 (clients change
only what the composition marks client-editable). Built now against a test client tenant, before the first client site moves onto WebDesk.

- **Who is a client editor (proposal, to ratify).** Not every client contact: a client user needs an explicit website-editor grant on
  their own company, given by Gaiada staff or the client's company admin. Cerbos sees it as a scoped grant; `isClientOnly`, never
  `!isElevated`, decides the portal shell (estate rule).
- **49a · vocabulary 1.2.0 (MINOR).** `ui.clientEditable` on the composition and on FieldDef; the classifier rates it MINOR; vendored copies
  and codegen follow. No stored value changes.
- **49b · WebDesk write plane.** The editorial assertion gains a client marker. With it, create, update and restore refuse any change to a
  path that is not client-editable (`422 field-not-client-editable`, listing the paths), and publish obeys D58. Without it, nothing changes.
- **49c · ERP authorisation and BFF.** Cerbos rules on `webdesk_content_item` (and `read` on `webdesk_media_asset`) for client editors,
  scoped to their own company: read, update client-editable content, request publish, self-publish one item, approve another client's batch.
  A portal BFF namespace that reuses the content service in client mode, diff-checks every client write against D59 before it leaves the
  ERP, and mints the assertion with the client marker.
- **49d · Portal UI.** A Website area in the client portal's own route group and shell, reusing the editor components in client mode:
  non-editable fields read-only with a reason, self-publish for one item, a batch request a second client person approves.
- **49e · Test client.** A seeded test client company with its own WebDesk tenant and site, so every part above is proven end to end.

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
