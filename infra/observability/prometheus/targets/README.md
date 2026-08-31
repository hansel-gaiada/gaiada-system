# Prometheus file_sd targets

Two planes, deliberately separate because they route to different humans
(`infra/observability/prometheus/rules/alerts-estate.yml`).

## `blackbox-estate.json` — Plane A, HAND-MAINTAINED

Our own estate endpoints. `severity: page` → engineering.

Populated 2026-08-31 from the `gaiada-setups` harvest (`_data/raw/<host>-harvest.txt`
`server_name` directives) — our own recorded inventory, **never a scan of the boxes**.
helios and delphi are observe-only hosts under the 2026-08-22/23 owner ruling: we probe
them from outside and install nothing on them.

Deliberately ONLY estate endpoints. The 15 client domains helios serves and the 20
delphi serves are **not** listed here: they belong to Plane B, and putting them in Plane A
would page an engineer at 3am for a client's marketing site.

Add an entry only when the thing is ours and its being unreachable is an engineering
matter. Labels `host` and `env` are required — the alert annotations interpolate both.

## `client-properties.json` — Plane B, GENERATED. DO NOT HAND-EDIT.

Written by `infra/observability/scripts/gen-client-property-targets.mjs` (sourced from
`search_properties WHERE verified_at IS NOT NULL`) and rsynced by
`infra/scripts/sync-client-property-targets.sh`. `severity: client_page` /
`client_ticket` → account managers, never engineering.

⚠ **MEASURED 2026-08-31: this plane currently yields ZERO targets.** Live has 19
`search_properties` rows and **0 with `verified_at` set**, so the generator correctly
produces an empty file. Client-site health is therefore NOT being monitored yet, and the
gap is *data*, not config — a property has to be verified before we claim to be watching
it. Two ways to close it, both a decision rather than a config change:

1. Verify the existing 19 properties (the real Search-Console-ownership path), or
2. Decide to seed the tracked-sites registry from the `gaiada-setups` mirror, which
   already knows the domains — and accept that "verified" then means "we recorded it",
   not "we proved ownership".

Until one of those happens, do not describe the two-pane health surface as covering
client sites. The estate pane is real; the client pane is an empty query.
