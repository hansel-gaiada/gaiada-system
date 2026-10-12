# CLAUDE.md — insights-collector

Scope: `insights-collector/` — the **enrichment collector** of M5 phase 5 (`module gaiada/insights-collector`, go 1.26).
Design of record: `docs/plans/2026-10-12-m5-phase5-design.md` section 3 (V2), section 4.1/4.2/4.4/4.7 (V3-b: the consented channel) and tickets V2-a, V3-b in section 8. Status: **PROTOTYPED** (V3-b adds the consented channel; its Postgres tests run on CI only)
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
edge nginx ──X-Real-IP──> :8080  POST /lib/kestrel/e  ──resolve once──> Umami app:3000 (fd… pseudonym + cf-* geo headers)
                         :8080  POST /lib/kestrel/v   consented events (needs consentId)  ──> vdb consented_events (72 h buffer)
                         :8080  POST /lib/kestrel/f   withdrawal: delete the pair's rows, tombstone the visitor id
Docker / read-gate ─────> :8081  GET /healthz · GET /ops/v1/bots · GET /ops/v1/events (read key) · POST /ops/v1/forget (forget key)   (never reads X-Real-IP)
```

Per hit (`internal/ingest`): parse `X-Real-IP` (400 if absent or invalid) → body ≤ `MAX_BODY_BYTES` → only `type:"event"` (`identify` and every
other type: 400 and dropped) → `payload.website` must be in `INSIGHTS_WEBSITES` (403) → look the address up once in DB-IP **City Lite**
(country/region/city) and **ASN Lite** (number/organisation) → **bot** = vendored isbot list on the UA, or the ASN on `data/datacenter-asns.txt`
(bots are not forwarded, are counted in `bot_counts`, and are answered `{"beep":"boop"}` like Umami does) → forward a FRESH request to Umami
with only: `Content-Type`, `User-Agent`, `x-umami-cache` (passed through, ≤ 4 KB), `X-Real-IP: fd…` and `cf-ipcountry`/`cf-region-code`/`cf-ipcity`
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
- Purge loop (`store.Purger`, at start and every `PURGE_INTERVAL_MINUTES`): rows older than `BUFFER_RETENTION_HOURS` (default and MAXIMUM 72) and tombstones older than 14 months.
- Logs name outcomes only, never an id or an address; the leak tests search logs, every response, every stored row and the ops output.

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
- Does Umami accept an `fd…` `X-Real-IP` with `CLIENT_IP_HEADER=x-real-ip`? If not, `FORWARD_IP_MODE=real` is the recorded fallback.

## Not here yet

`/lib/kestrel/r` and replay (V6-a); the compose/nginx/edge routes for `/lib/kestrel/v|f`, the two key hashes in `.env.example` and the new env variables under `environment:` (V3-c; **V2-c's compose must also list `OPS_FORGET_KEY_SHA256`, or the collector refuses to start**).
