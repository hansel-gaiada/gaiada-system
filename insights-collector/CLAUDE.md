# CLAUDE.md — insights-collector

Scope: `insights-collector/` — the **enrichment collector** of M5 phase 5 (`module gaiada/insights-collector`, go 1.26).
Design of record: `docs/plans/2026-10-12-m5-phase5-design.md` section 3 (V2), section 4.1/4.2/4.4/4.7 (V3-b: the consented channel), section 6.2/6.3 (V6-a: session replay) and tickets V2-a, V3-b, V6-a in section 8. Status: **PROTOTYPED** (V3-b adds the consented channel, V6-a the replay channel; their Postgres tests run on CI only)
(unit-tested; nothing deployed, never run against a real Umami). Root `../CLAUDE.md` has the program rules.

```
go vet ./... && go test ./...        # the V2-b CI job; no services needed (one Postgres test self-skips)
TEST_DATABASE_URL=postgres://… go test ./internal/store/   # real vdb: on the Linux gate only (NO local Docker)
.\wsl.ps1 [build|test|vet]           # if Smart App Control blocks native Go test binaries
```
The image (`Dockerfile`, distroless non-root) is built and cosign-signed by CI (V2-b). **Never build it on the laptop or on gda-aicenter.**

## What it is

A small Go service that sits between the public nginx `edge` and Umami on `sumopod` (compose project `umami`, `internal` network only,
no egress). The site's Umami tracker is unchanged; its hits for `COLLECT_API_ENDPOINT` (`/lib/kestrel/e`) reach the collector first.

```
edge nginx ──X-Real-IP──> :8080  POST /lib/kestrel/e  ──resolve once──> Umami app:3000 (2001:db8… pseudonym + cf-* geo headers)
                         :8080  POST /lib/kestrel/v   consented events (needs consentId)  ──> vdb consented_events (72 h buffer)
                         :8080  POST /lib/kestrel/f   withdrawal: delete the pair's rows AND recordings, tombstone the visitor id
                         :8080  POST /lib/kestrel/r   replay chunk (needs consentId; 404 unless REPLAY_ENABLED=1)  ──> vdb replay_sessions / replay_chunks (30 days)
Docker / read-gate ─────> :8081  GET /healthz · GET /ops/v1/bots · GET /ops/v1/events · GET /ops/v1/replay/{sessions,chunks} (read key) · POST /ops/v1/forget (forget key)   (never reads X-Real-IP)
```

Per hit (`internal/ingest`): parse `X-Real-IP` (400 if absent or invalid) → body ≤ `MAX_BODY_BYTES` → only `type:"event"` (`identify` and every
other type: 400 and dropped) → `payload.website` must be in `INSIGHTS_WEBSITES` (403) → look the address up once in DB-IP **City Lite**
(country/region/city) and **ASN Lite** (number/organisation) → **bot** = vendored isbot list on the UA, or the ASN on `data/datacenter-asns.txt`
(bots are not forwarded, are counted in `bot_counts`, and are answered `{"beep":"boop"}` like Umami does) → forward a FRESH request to Umami
with only: `Content-Type`, `User-Agent`, `x-umami-cache` (passed through, ≤ 4 KB), `X-Real-IP: 2001:db8:…` and `cf-ipcountry`/`cf-region-code`/`cf-ipcity`
when resolved. Umami's status and body come back to the tracker; 3 s timeout, then 502.

## The consented channel (V3-b; `internal/consent`, `internal/ops/events.go`, `internal/store/events*.go`)

- `POST /lib/kestrel/v` `{website, visitorId, consentId, events:[{t, kind, path, name?, data?}]}`, body <= 16 KB, <= 50 events, `text/plain` or JSON (the
  Content-Type is ignored). Answers: 204; 400 (`no-consent-id` first: no valid `consentId`, no storage; `bad-visitor-id`, `no-events`, `too-many-events`,
  `no-valid-events`, `bad-body`, `no-client-address`); 403 unknown website; 410 `visitor-forgotten` (visitor id OR consent id tombstoned; nothing stored);
  413; 429 (global bucket `CONSENT_RATE_PER_SECOND`, plus a per-visitor-id burst of 10 refilling 1 per 2 s; no address is kept for it); 503 vdb down.
  A bot (isbot UA, WebDesk's `bot` bucket, or a datacenter ASN) gets a silent 204 and is not stored.
- Per event, an invalid one is DROPPED, not the batch: `kind` pageview|event; `path` starts with `/`, no query, hash, backslash or control character, <= 512; an
  `event` needs a `name` from `CONSENT_EVENT_NAMES`; `data` keeps only `section_id link_location form_id language_to` (`[A-Za-z0-9_.:-]{1,64}`) and
  `step_index` (whole number 0..1000), everything else is dropped; `t` is epoch milliseconds (number) or RFC 3339, clamped to +-10 min of receipt (missing = receipt).
- Stored per row (`migrations/0002_consented_events.sql`): website, visitor_id, consent_id, received_at, occurred_at, kind, path, name, data, device
  (WebDesk `classifyUserAgent` buckets, ported in `consent/device.go`), country, city, asn, network_name, company (the CompanyResolver result as JSON). The
  geo, ASN and resolver result all come from ONE lookup of the request's address. **No IP column, no user-agent column** (static test + live catalogue check).
- `POST /lib/kestrel/f` `{website, visitorId, consentId}`: always 204 for a well-formed body (unknown pair or website: still 204, no oracle); deletes rows only
  where BOTH ids match; tombstones the visitor id (`withdraw`).
- `GET /ops/v1/events?website&after&limit<=1000` (read key) -> `{events:[{id, visitorId, consentId, receivedAt, occurredAt, kind, path, name|null, data|null,
  device, geo:{country, city}, network:{asn, name}|null, company:{kind,name,domain?,confidence,source,version?}|null}], next}`. `next` is the last id returned (or `after`
  when none). Rows younger than 15 s are never returned, and the page stops at the first young row, so a cursor cannot skip a late commit.
- `POST /ops/v1/forget` `{website, visitorIds<=100, consentIds<=100, mode:"withdraw"|"erase"}` (FORGET key) -> `{website, mode, deleted:{events}, tombstoned:{visitors, consents}}`.
  Deletes rows of either id and tombstones both kinds; idempotent (an `erase` upgrades a `withdraw` tombstone, never the reverse). Keys: no/unknown key 401; the
  read key on forget 403; the forget key on events or bots 403.
- **Tombstones hold `sha256(utf8(lower-case uuid text))` only**, the same contract as the ERP's `search_visitor_tombstones` (pinned by a known-vector test). Inserts and
  forgets serialise on one advisory lock (inserts shared, forgets exclusive), so a batch can never land after a forget has deleted that visitor's rows.
- Purge loop (`store.Purger`, at start and every `PURGE_INTERVAL_MINUTES`): rows older than `BUFFER_RETENTION_HOURS` (default and MAXIMUM 72), replay recordings started more than `REPLAY_RETENTION_DAYS` ago (default and MAXIMUM 30), and tombstones older than 14 months.
- Logs name outcomes only, never an id or an address; the leak tests search logs, every response, every stored row and the ops output.

## The replay channel (V6-a; `internal/replay`, `internal/consent/replay.go`, `internal/ops/replay.go`, `internal/store/replay*.go`)

Our own sampled rrweb recording (design 6.1 is the site's rules, 6.2 this). **OFF unless `REPLAY_ENABLED` is exactly `1`**: off, the route is a plain 404 for every method.
`replay.go` in `internal/replay` is the pure part (decode, inflate, input check, href rewrite); the HTTP handler sits in `internal/consent` and shares its limiter, ids and bot check.

- `POST /lib/kestrel/r` `{website, visitorId, consentId, recordingId, seq, chunk}`; the whole body <= 320 KB (the edge's cap, `MaxReplayBodyBytes`). `chunk` is a JSON
  string = base64 of a gzip stream (the browser's `CompressionStream`), or a JSON array of rrweb events (uncompressed). `recordingId` is the browser's UUID and becomes
  `replay_sessions.id`; `seq` is a whole number 0..999. Base64 costs 4/3, so under the 320 KB body cap the compressed chunk is effectively <= ~240 KB; the collector's own
  limit is 256 KB compressed (`replay.MaxCompressedBytes`) and 4 MB inflated.
- Answers: `200 {"record":true}` (stored, or an exact repeat of a stored `(recordingId, seq)`: idempotent); `200 {"record":false}` (a cap, the budget, or a bot: the site
  stops recording; the body never says which); 400 (`no-consent-id` first, `bad-visitor-id`, `bad-body`, `bad-recording-id`, `bad-seq`, `bad-chunk`, `no-client-address`);
  403 `unknown-website` or `recording-mismatch` (the recording id exists for another website, visitor or consent id: nothing stored, so a leaked id cannot be appended to);
  404 replay off; 410 `visitor-forgotten` (visitor id OR consent id tombstoned); 413 `body-too-large` / `chunk-too-large` (over the compressed limit, or the inflate-bomb limit:
  the gzip reader stops one byte past 4 MB, concatenated members count together); **422 `typed-input`** (below); 429 (the global bucket plus a per-visitor `r:` bucket, burst 10,
  1 per 2 s, separate from `/v`'s); 503 vdb down.
- **Typed input (422, nothing stored from the chunk):** an incremental input event (`type 3, source 5`) whose `text` is anything but absent, null or `""`; or, in a full snapshot
  or an added mutation node, a text-like `input` (every type except button/submit/reset/image/checkbox/radio/range/color; `hidden` and `file` count) or a `textarea` whose
  `value` attribute or text node is non-empty. A masked value (`***`) is still non-empty and still refused: the site's `maskInputFn` returns `""` outside forms, and forms are blocked.
  Attribute mutations that set `value` are NOT inspected (rrweb reports typing as input events, and an attribute mutation has no tag name). The chunk's meta event `href` is rewritten
  to origin + path (no credentials, query or hash; a non-http(s) href becomes `""`); the paths found become `replay_sessions.pages` (distinct, at most 50).
- **Caps** (checked in the store, atomically with the write, after the tombstone check; a duplicate `seq` returns before them): per recording 5 MB stored, 30 minutes from the first
  chunk's receipt, 1000 chunks; new recordings per website per rolling 24 h (`REPLAY_SITE_DAILY_RECORDINGS`, design 500) and per visitor id (`REPLAY_VISITOR_DAILY_RECORDINGS`);
  `REPLAY_BUDGET_MB` per website, summed over stored bytes, a HARD cap: a chunk that would pass it is refused whether the recording is new or not (design 9.14).
  Concurrent chunks can overshoot a cap by a few chunks (no table lock): bounded and accepted.
- Stored (`migrations/0003_replay.sql`): `replay_sessions(id, website, visitor_id, consent_id, started_at, last_chunk_at, chunks, bytes, pages)` and `replay_chunks(session_id, seq,
  received_at, bytes, data bytea)` (cascade from the session). `data` = gzip of the checked, rewritten events array. **No IP column, no user-agent column** (the generic schema test,
  a pinned column list in `internal/store/replay_test.go`, and a catalogue check on CI).
- **Retention:** the purge pass also deletes recordings whose `started_at` is older than `REPLAY_RETENTION_DAYS` (default and maximum 30). `/lib/kestrel/f` deletes the pair's
  recordings; `POST /ops/v1/forget` deletes every recording of the given visitor or consent ids and answers `deleted:{events, recordings}` (additive). Forget and chunk inserts share the
  one advisory lock, so a chunk cannot land after a forget.
- **Backup (O2):** `infra/sumopod/umami/backup.sh` already passes `--exclude-table-data` for `consented_events`, `replay_sessions`, `replay_chunks` and refuses a dump holding a COPY
  block for them; `TestBackupScriptExcludesTheReplayTablesByTheirExactNames` reads the script and the migrations, so a rename on either side fails.
- **Ops reads (READ key; the ERP's `view_replay` check is V6-b, here it is key-gated only; not gated by `REPLAY_ENABLED`, so stored recordings stay readable after a switch-off):**
  `GET /ops/v1/replay/sessions?website&visitorId[&limit<=200]` -> `{website, visitorId, sessions:[{id, consentId, startedAt, lastChunkAt, durationSeconds, chunks, bytes, pages}]}`
  (METADATA ONLY, newest first, a visitor id is required so there is no list of everyone); `GET /ops/v1/replay/chunks?website&recording[&after=<seq>][&limit<=50]` ->
  `{website, recording, visitorId, consentId, chunks:[{seq, receivedAt, bytes, events:[...rrweb events]}], next, more}` (CONTENT; one response holds at most ~8 MB inflated, the rest
  waits for the next call; a recording of another website is 404). O7: an MCP tool must call the sessions route only, never chunks.
- Logs name outcomes only (never an id, an address, a path or content); counters: `replay_*` in `/healthz`.

## Invariants (each has a test; do not weaken)

- **The visitor's address never leaves the request's memory**: not in a log line (no access log; errors are typed constants), not in a
  response, not in a stored row, not in what Umami receives. Umami gets `2001:db8::/32` (the IPv6 documentation range) + the first 12 bytes of HMAC-SHA256(**day key**, IP). Not fd00::/8: Umami 3.4.0's `is-localhost-ip` treats fc00::/7 as local and then stores no location at all (proved on sumopod in M5-V2-d).
  The day key is 32 random bytes, in memory only, replaced at 00:00 UTC and on restart (`internal/ingest/pseudonym.go`). It is never
  written anywhere; that is what stops anyone testing guessed addresses against the pseudonym.
  *Only exception:* `FORWARD_IP_MODE=real`, the documented fallback if V2-d shows Umami 3.4.0 mishandles the pseudonym. Not the default; it
  logs a warning at start; even then the address is not logged or stored.
- `net/http`'s own error log is rerouted to one constant line (`cmd/collector/typedlog.go`): its messages can name a remote address.
- **Payload allow-list** (`payloadAllow` in `ingest.go`): `website hostname screen language title url referrer name data tag`. `id` (Umami's
  distinct id), `ip`, `userAgent` and anything unknown are dropped. A persistent visitor id must never reach Umami.
- **Port 8080 trusts `X-Real-IP`; port 8081 never reads it** (nor `X-Forwarded-For`, nor the remote address). `internal/ops` is not
  given the geo database, so it cannot resolve or pseudonymise an address even by mistake.
- vdb holds **no IP or user-agent column** (`internal/store` schema test + a catalogue check on the gate). Migrations are DDL only.
- A bot hit is counted in memory and flushed every `BOT_FLUSH_SECONDS`; vdb down never touches the aggregate channel (counts are kept and retried).
- **Env discipline** (`internal/config`): an EMPTY value takes the default, an explicit `0` where invalid refuses to start and names the
  variable (memory: empty env must not become 0); a switch is on only for exactly `1`; a required variable (website list, collect path,
  database, ops key hash) refuses when empty. Errors never echo a value (`DATABASE_URL` has a password).

## Environment

| Variable | Default (when empty) | Notes |
|---|---|---|
| `COLLECT_API_ENDPOINT` | required | the same value Umami and the edge use; the collector serves and forwards this path |
| `INSIGHTS_WEBSITES` | required | comma-separated Umami website UUIDs; empty refuses to start (cannot silently admit or block all) |
| `DATABASE_URL` | required | vdb. The pool is lazy: vdb down at start does not stop the aggregate channel |
| `OPS_READ_KEY_SHA256` | required | 64 hex = SHA-256 of the ERP's read key; sent as `Authorization: Bearer <key>` |
| `OPS_FORGET_KEY_SHA256` | required | SHA-256 of the SEPARATE forget key; must differ from the read hash (the read key cannot forget) |
| `CONSENT_EVENT_NAMES` | the site's goal events + form steps + `language_switch` | comma list, `[a-z][a-z0-9_]{0,49}`. ASSUMPTION: the site's real list (`gaiada-web-revamp/.../events.ts`) is confirmed by V3-j |
| `CONSENT_RATE_PER_SECOND` | `100` | 1-10000; global ceiling on `/v` and `/f` |
| `BUFFER_RETENTION_HOURS` | `72` | 1-72 (a shorter buffer is allowed, a longer one is refused: 72 h is a promise in the notice) |
| `PURGE_INTERVAL_MINUTES` | `15` | 1-1440 |
| `REPLAY_ENABLED` | off | on only for exactly `1`; anything else (empty, `true`, ` 1`) leaves `/lib/kestrel/r` a 404 |
| `REPLAY_BUDGET_MB` | `2048` | 1-1048576; per website, a hard cap on stored recording bytes (preflight measures disk first: design 9.14) |
| `REPLAY_RETENTION_DAYS` | `30` | 1-30 (a shorter retention is allowed, a longer one is refused: 30 days is a promise in the notice) |
| `REPLAY_SITE_DAILY_RECORDINGS` | `500` | 1-100000; new recordings per website per rolling 24 h |
| `REPLAY_VISITOR_DAILY_RECORDINGS` | `10` | 1-1000; new recordings per visitor id per rolling 24 h |
| `LISTEN_ADDR` / `OPS_ADDR` | `:8080` / `:8081` | must differ |
| `UMAMI_URL` | `http://app:3000` | no path |
| `UMAMI_TIMEOUT_MS` | `3000` | 100–30000 |
| `MAX_BODY_BYTES` | `32768` | 1024–1048576 |
| `BOT_FLUSH_SECONDS` | `30` | 1–3600 |
| `GEO_DIR` / `GEO_CITY_FILE` / `GEO_ASN_FILE` | `/geo` / `dbip-city-lite.mmdb` / `dbip-asn-lite.mmdb` | missing file: start anyway, `/healthz` says `geo:degraded` |
| `GEO_REQUIRED` | off | `1` refuses to start without both files |
| `FORWARD_IP_MODE` | `pseudonym` | or `real` (fallback, see above) |
| `COMPANY_RESOLVER` | `network-only` | unknown name refuses to start |
| `LOG_LEVEL` / `BUILD_VERSION` | `info` / `dev` | the image sets `BUILD_VERSION` from the build arg |

Compose (V2-c) must list every one of these under `environment:` (a `.env` line alone does nothing; memory: compose passthrough trap).

## Data files (`data/`, embedded in the binary)

- `isbot-patterns.json`: isbot 5.2.2's pattern list, unchanged (JavaScript regexes; several use lookaround, so they run on
  `github.com/dlclark/regexp2` with a 50 ms match timeout, not Go's `regexp`). Licence **Unlicense**; see `isbot-NOTICE.md` (the design says MIT; the
  package says Unlicense). Refresh recipe is in the notice.
- `datacenter-asns.txt`: compute clouds only (design section 9 trap 1: corporate gateways, WARP and Private Relay are NOT bots). **PROPOSED, not yet
  reviewed**; review it against `/ops/v1/bots` after go-live. A malformed line stops the collector at start.

## CompanyResolver (`internal/company`)

`Resolver{Name(); Resolve(ip, asn) (Result, bool)}` registered by name. Empty `COMPANY_RESOLVER` selects `network-only`: the ASN organisation
labelled **network**, never company. It is built and validated at start but **not called on the aggregate channel**; the consented channel
(V3-b) uses it. After O-12, a new resolver is one more local-file implementation plus a `Register` call. The collector has no egress, so an
API vendor cannot be a resolver without a ruling and a network change.

## Tests and fixtures

- Geo tests use **generated** MMDB fixtures (`internal/geo/geotest`, via `github.com/maxmind/mmdbwriter`) over the RFC 5737/3849 documentation
  ranges; `203.0.113.7` is the acceptance address. No DB-IP data is committed and the full database must never be (its licence allows use with
  attribution, but it is ~100 MB and a real fixture would prove nothing more).
- The acceptance test searches logs, the request a fake Umami received, every response, the stored rows and the counters for the address.
- `internal/store`'s Postgres test needs `TEST_DATABASE_URL` (self-skips without it).

## Open items for V2-d (the proof on `sumopod`)

- Does Umami 3.4.0 take the collector's `cf-*` headers with `SKIP_LOCATION_HEADERS` removed, and does it **decode** a percent-encoded city
  (`S%C3%A3o Paulo`)? The collector sends non-ASCII as percent-encoding; if Umami does not decode, change `headerSafe` in `ingest.go`.
- DB-IP's City Lite MMDB field names (`country.iso_code`, `subdivisions[0]`, `city.names.en`) are assumed MaxMind-compatible. When a subdivision
  has no `iso_code`, the English name is sent as `cf-region-code`.
- ANSWERED by V2-d (sumopod, 2026-10-13): Umami 3.4.0 accepts a pseudonym as `X-Real-IP` but runs `is-localhost-ip` on it first, and an
  `fd…` (fc00::/7) address counts as local, so it stored NO location. The pseudonym is now in 2001:db8::/32, which Umami treats as public and
  for which it reads the `cf-*` headers. `FORWARD_IP_MODE=real` stays the fallback. Re-check on every Umami upgrade.

## Not here yet

The edge `/lib/kestrel/r` location (templated and commented in `nginx/edge.conf.template`; a later ticket enables it with its erp-edge route); the ERP side of recordings (V6-b: `view_replay`, the activity row, forgetting unverified recordings), the player (V6-c) and the site recorder (V6-d). The compose/nginx/edge routes for `/lib/kestrel/v|f`, the two key hashes in `.env.example` and the new env variables (including the five `REPLAY_*`) under `environment:` (V3-c; **V2-c's compose must also list `OPS_FORGET_KEY_SHA256`, or the collector refuses to start**).
