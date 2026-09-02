# Prometheus `file_sd` target files — why they start empty

Both files in this directory are consumed by `prometheus.remote.yml` via `file_sd_configs` on the
SumoPod hub. Prometheus reloads a `file_sd` file on its own (`refresh_interval`) — no restart, no
`--web.enable-lifecycle` reload needed.

## `blackbox-estate.json` — Plane A, `helios`/`delphi`

**Status: intentionally `[]`.** This is the target list for MSO-11
(`docs/plans/2026-08-21-multi-server-observability.md` §12.6) — the blackbox tier for the two
OBSERVE-ONLY hosts. Populating it requires **owner-named endpoints** (OQ-6, same document §10):
this estate does not port-scan or crawl to "discover" what to probe — an unnamed service simply
stays invisible, permanently, by design. Do not add an entry by guessing a URL from the host's
public IP or from CloudPanel's default vhost.

**Format**, once the owner names endpoints:

```json
[
  {
    "targets": ["https://example-client-site.tld/"],
    "labels": { "host": "helios", "env": "production", "endpoint_name": "example-client-site" }
  },
  {
    "targets": ["https://staging.example-client-site.tld/"],
    "labels": { "host": "delphi", "env": "staging", "endpoint_name": "example-client-site-staging" }
  }
]
```

`host`/`env` are what let `alerts-estate.yml`'s `EstateProbeDown` ride the *existing*
production-pages/staging-tickets routing tree in `alertmanager.yml` — get them wrong and an
outage on `delphi` (staging) pages engineering at 3am, or an outage on `helios` (production)
silently downgrades to a ticket. Cross-check against `infra_hosts.env` once MSO-09 lands (currently
PLANNED, not applied) rather than typing it from memory a second time.

## `client-properties.json` — Plane B, client sites (MON-01)

**Not committed here** — it is *generated*, not hand-written
(`infra/observability/scripts/gen-client-property-targets.mjs`), and a generated file that also
lives in git would drift the moment the generator runs. See
`infra/runbooks/enable-estate-blackbox-and-alert-routing.md` §4 for exactly how it is produced and
shipped to this path on the hub.

**Never hand-edit `client-properties.json` on the hub.** The consent gate
(`search_properties.verified_at IS NOT NULL AND status = 'active'`) lives in the generator's SQL,
not in this directory — a hand-added entry is a probe against a client's server with no recorded
consent trail.
