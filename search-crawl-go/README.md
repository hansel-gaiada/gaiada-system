# search-crawl-go (SM-07)

Job-mode crawl worker for the SEO/SEM module (`docs/blueprints/seo-sem-design.md` §12 SM-07). One
process = one crawl of one registered, verified `search_properties` row for one tenant, then exit.

**The egress guard (`internal/egress`) is the deliverable this ticket is actually gated on** (design
§12: "QA gate mandatory (SSRF)"). `internal/crawler` is a minimal same-host page fetcher that
exists to prove the guard end-to-end — it is deliberately NOT SEONaut, NOT open-seo-crawler, and
NOT Unlighthouse; see the scope note in `internal/crawler/crawler.go`'s package doc and the SM-07
ticket report for exactly what was deferred to SM-08/later and why.

## Layout

- `internal/egress` — the SSRF floor. `Guard.Transport()` returns an `*http.Transport` whose
  `DialContext` is the ONLY enforcement point: per-job hostname allowlist (resolved once at
  dispatch from the tenant's `search_properties`), then DNS resolution + private/reserved-IP
  denial (RFC1918, loopback, link-local incl. `169.254.169.254`, IPv6 equivalents, IPv4-mapped
  IPv6, CGNAT) on the address actually dialed — the literal validated IP, never the hostname
  again, so there is no second resolution for a DNS-rebind race to exploit. Every dial attempt
  (allowed or refused) is reported to an append-only JSONL audit sink (`internal/egress/audit.go`)
  naming the reason. `internal/egress/ratelimit.go` adds a per-host RoundTrip-level rate cap
  (dial-level would miss requests reusing a keep-alive connection).
- `internal/robots` — minimal robots.txt fetch + match (RFC 9309 group selection + longest-prefix
  Allow/Disallow), takes an injected `*http.Client` so production wires the guarded client and
  tests use a plain one against `httptest`.
- `internal/crawler` — same-host breadth-first page fetch + link extraction (`golang.org/x/net/html`),
  bounded by `MaxPages`; produces a raw `Report` (SM-08's ingest adapters, not built here, turn
  that into `search_audits`/`search_audit_findings` rows).
- `internal/db` — resolves the job's allowlist from Postgres through the SAME tenant choke-point as
  the rest of the platform: one transaction, `SELECT set_config('app.current_tenant_ids', ...)` +
  `set_config('app.scopes', 'search')`, then query — so RLS + the search module's third-wall both
  apply. Runs as `platform_app` (NOBYPASSRLS), the same runtime role platform-nest itself uses; the
  crawl worker gets no elevated DB privilege.
- `cmd/crawl` — the job entrypoint (env-var driven, see below).

## Running a job

```
DATABASE_URL=postgres://platform_app:<pw>@postgres:5432/gaiada_platform \
TENANT_ID=<company uuid> \
PROPERTY_ID=<search_properties uuid> \
AUDIT_LOG_PATH=/app/data/egress-audit.jsonl \
REPORT_PATH=/app/data/report.json \
MAX_PAGES=25 \
MIN_HOST_GAP_MS=1000 \
./crawl
```

Refuses (writing an audit line, non-zero exit) if: the tenant has no matching
`search_properties` row (`unknown_property`), the property isn't yet verified
(`not_verified` — the activation checklist gate), or (optionally) `TARGET_URL` is set and its
host doesn't match the registered domain (`not_allowlisted`). Everything past that point is
enforced live by the Guard as the crawl runs — a redirect or a resolved private IP is refused
mid-crawl exactly the same way, not just at start.

## Dev commands (Windows + Smart App Control -> always via WSL)

```
.\wsl.ps1                 # go build ./...
.\wsl.ps1 vet
.\wsl.ps1 test            # unit + adversarial SSRF suite; internal/db's live-DB test self-skips
                           # unless TEST_DATABASE_URL is set (point it at platform_app, not a
                           # superuser, so it exercises the real runtime privilege)
.\wsl.ps1 run              # go run ./cmd/crawl (set the env vars above first)
```
