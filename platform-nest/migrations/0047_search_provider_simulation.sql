-- SM-33 — provider SIMULATION provenance (docs/blueprints/seo-sem-execution-tracker.md §6 SM-33).
--
-- The owner directive is "no live vendor API until staging, so dev must show believable results".
-- Believable synthetic numbers are useful for a demo and DANGEROUS in a record: an unlabelled
-- plausible number is the most expensive kind of lie (the same reason the module's "—, never $0"
-- rule exists). So the simulator is only allowed to exist alongside a provenance bit that makes
-- simulated data structurally impossible to mistake for real data:
--
--   * search_provider_calls.simulated — was this metered row produced by a simulated driver (or
--     while the platform ran in `simulate` mode)? Synthetic dollars must never be summed into a
--     client's real spend report without a badge next to them. The budget tiers filter ON this
--     column (see below): each mode binds against its OWN ledger, so a simulated pull still accrues
--     and can still be refused by a cap, while never touching real-mode arithmetic.
--   * search_data_cache.simulated — was this cached market-data payload synthesized? This table is
--     the cross-tenant no-RLS cache (0034's single deliberate FORCE-RLS exemption, D-4), so a
--     simulated row left behind by a dev/demo session is visible to EVERY tenant that later asks
--     for the same market coordinate. Without this column, flipping the platform to `live` would
--     silently serve yesterday's invented volume figures as a real, paid-for pull.
--
-- BACKFILL SAFETY, AND WHY `NOT NULL DEFAULT false` IS LOAD-BEARING (addendum §A4): every
-- pre-existing row is asserted REAL — which is exactly true, because simulation did not exist before
-- this migration. The NOT NULL matters beyond tidiness: both budget counters and the cache read now
-- carry a `simulated = <mode>` predicate, and a NULL in that column would make `simulated = false`
-- evaluate to UNKNOWN — silently dropping REAL spend out of the live-mode month-to-date sum. That is
-- a fail-open on the money path, the same class as the §4d ceiling defect. There is no nullable
-- state to reach, by construction.
--
-- HOW THE TWO MODES STAY DISJOINT (the AC; addendum §A4.1/§A4.2 ruled the mechanisms):
--   * BUDGETS — `sumMonthToDate` / `sumGlobalMonthToDate` filter `simulated = <mode>`. Simulate mode
--     binds against simulated spend (so the stop-loss demo is the real choke-point doing real
--     arithmetic); live mode counts only real rows (so a mode flip can neither refuse real clients
--     for phantom dollars nor let demo history mask real spend). Ledger rows are NEVER excluded from
--     their own mode's sum — a simulated pull must still be able to exhaust a simulated budget.
--   * CACHE — `readFreshCache` carries `AND simulated = <mode>`, symmetrically: a live read can never
--     serve a simulated row, and a simulate read can never serve a live one. The PK stays
--     `cache_key` ALONE (key-on-mode was the rejected alternative): after a deliberate mode flip, the
--     first write for a key overwrites the other mode's row with payload AND flag updated atomically,
--     so provenance can never disagree with the payload it sits on. Accepted cost: cache churn once
--     per key after a flip.
--
-- TRANSITION (§A4.4): simulated rows are KEPT and BADGED forever, never purged for correctness —
-- rulings above make them permanently inert to live-mode money and cache paths, and SM-38's chip
-- labels them in any historical view. A production database starts from migrations + seeds, never
-- from a copy of a simulated-era database; `DELETE FROM ... WHERE simulated` is optional cosmetic
-- cleanup only, which is what the partial index below is for.
--
-- Additive, CREATE/ALTER-only; no RLS change (search_provider_calls keeps 0034's third-wall policy,
-- search_data_cache remains the ratified no-RLS exemption). No in-migration GRANTs, per
-- migrations/README.md — column privileges follow the table grants already in place.

ALTER TABLE search_provider_calls ADD COLUMN simulated boolean NOT NULL DEFAULT false;
ALTER TABLE search_data_cache ADD COLUMN simulated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN search_provider_calls.simulated IS
  'SM-33: true = this metered call was served by a SIMULATED provider driver (or dispatched while '
  'config.search.providerMode = simulate). Its cost_usd is a synthetic dollar figure. Every surface '
  'that renders provider-sourced data or spend MUST badge these rows (SM-38). The budget stop-loss '
  'sums are filtered by this column (simulated = <mode>), so each mode binds against its own '
  'disjoint ledger: a simulated pull can still exhaust a cap, without ever affecting real spend.';

COMMENT ON COLUMN search_data_cache.simulated IS
  'SM-33: true = this cached market-data payload was SYNTHESIZED by a simulation driver, not bought '
  'from a vendor. readFreshCache carries AND simulated = <mode>, symmetrically: a live read can '
  'never serve a simulated row and a simulate read can never serve a live one. The PK stays '
  'cache_key alone, so after a mode flip a write replaces the other mode payload and this flag '
  'atomically — provenance can never disagree with the payload. See providers/cache.ts.';

-- Operational index: the one query an operator actually runs on this column is "purge the simulated
-- rows before/after a staging cutover" (and its inverse, "count how much of the shared cache is
-- synthetic"). Partial, so it costs almost nothing on a live-mode deployment where no row is
-- simulated at all.
CREATE INDEX ix_search_data_cache_simulated ON search_data_cache (simulated) WHERE simulated;
