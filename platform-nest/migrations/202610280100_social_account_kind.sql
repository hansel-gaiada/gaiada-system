-- SCP-Sa2 (owner ruling SCP-D9, 2026-10-28; plan §5; BFF §63.1 file 8) -- every social account is exactly ONE kind,
-- simulated or real, and the database says so.
--
-- WHY
--   SCP-Sa (202610271600 + publisher/boot.ts) kept the social simulator and anything real strictly apart: boot refused
--   SOCIAL_SIMULATION_ENABLED beside a configured Postiz, an OAuth grant or any non-simulated account. The owner ruled
--   (SCP-D9): "use simulator with postiz. so we can know if its working or not at the same time". The simulator and the
--   real Postiz now run SIDE BY SIDE: a simulated account publishes through the simulator, a real account through Postiz.
--   The hazard SCP-D3 guarded is unchanged (a post our calendar shows as published that never appeared), so the
--   containment moves from "never both" to "never mixed": an account is one kind for its whole life, and each driver
--   refuses the other kind (publisher/simulation.ts). This file is the database half of "one kind".
--
-- WHAT IT ADDS
--   1. social_accounts_kind_ck, a named CHECK:
--        simulated = true  => postiz_integration_id IS NOT NULL AND LIKE 'simulated:%' AND connected_by IS NULL
--        simulated = false => postiz_integration_id IS NULL OR NOT LIKE 'simulated:%'
--      So the `simulated:` prefix (SCP-Sb's seed writes `simulated:<network>`) belongs to simulated accounts alone, and a
--      simulated account is never one a person connected. Code uses the prefix as a SECOND, independent signal of the kind
--      (the reverse fence: a real driver refuses an integration id or provider post id that starts `simulated:`), which is
--      only sound because this CHECK ties the prefix to the column. `simulated` is NOT NULL (202610271600), so the CHECK
--      never meets a NULL mark; the integration id's NULL is spelled out on both sides (a CHECK passes on NULL).
--   2. trg_social_accounts_kind_guard: the kind is fixed once a row has been used as a kind. true -> false is ALWAYS
--      refused (a simulated account's variants carry `simulated:` provider ids that would then be asked of Postiz); false
--      -> true only for a row that never reached an engine (no integration id, no `connected_by`, no OAuth grant of any
--      status), which is exactly the CP-21 demo-seed shape social-simulation-prepare.ts marks. A row with an engine id or
--      a grant may have real posts in flight; marking it simulated would hand them to the simulator.
--   3. trg_social_oauth_tokens_real_account_only: an OAuth grant (a credential that publishes for real through `direct`)
--      can never be written for a simulated account, on INSERT or on any UPDATE that moves it.
--
-- THE LIVE SHAPES (checked before writing this, and handled here, never by hand)
--   * SCP-Sb's seeded accounts: simulated, `simulated:<network>`, no connected_by. Already valid.
--   * CP-21 demo-seed rows marked by social-simulation-prepare.ts --apply BEFORE this file: simulated with a NULL
--     integration id (that script's rule 3 requires NULL and no connected_by).
--   * Three older seed rows marked simulated on live by the owner's decision: soft-deleted, NULL integration id.
--   The last two would fail the CHECK. THE BACKFILL: for `simulated = true` rows whose integration id is NULL, and only
--   those, set `postiz_integration_id = 'simulated:' || network` (the seed's own value). Deleted rows included (the CHECK
--   validates every row). A non-simulated row is NEVER written. `updated_at` is left as it was: the row's meaning does
--   not change, only its id is made to say what the mark already said.
--   ANY OTHER SHAPE THAT BREAKS THE RULE IS NOT GUESSED AT: a simulated row with a non-`simulated:` integration id or a
--   connected_by, a real row with a `simulated:` id, or an OAuth grant on a simulated account makes this file RAISE with
--   the counts and the query that lists them (infra/runbooks/social-simulation.md, "Side by side"). A person decides.
--
-- THE ZERO-ROW TRAP
--   The migration owner is NOBYPASSRLS and both tables are FORCE RLS with the third wall (tenant AND the `social` module
--   scope). A bare UPDATE would match zero rows and the CHECK would then refuse to validate: loud, not silent, but useless.
--   So the precheck and the backfill run per company with BOTH GUCs set (app.current_tenant_ids, app.scopes = 'social';
--   the 0051/0108/202610132215 idiom plus the social scope). Every company, deleted ones too: the CHECK validates them all.
--   The CHECK's own validation is a table scan that RLS does not filter, so a row the loop could not see still fails the
--   ADD CONSTRAINT loudly, never quietly.
--
-- THE TRIGGERS' READS UNDER RLS
--   Both trigger functions are SECURITY INVOKER and read the OTHER table under the caller's RLS. That is sound here, and
--   fail-closed: the statement that fires them is itself held to the same three-wall policy (same tenant via the composite
--   FKs, same `social` scope), so a caller allowed to write the row can see the related rows. If the related row is not
--   visible, the write is refused anyway (the FK or the WITH CHECK), so "not found" never waves a forbidden write through.
--
-- Reverse: DROP TRIGGER trg_social_oauth_tokens_real_account_only ON social_oauth_tokens; DROP TRIGGER
--   trg_social_accounts_kind_guard ON social_accounts; DROP FUNCTION social_oauth_tokens_real_account_only();
--   DROP FUNCTION social_accounts_kind_guard(); ALTER TABLE social_accounts DROP CONSTRAINT social_accounts_kind_ck.
--   The backfilled ids may stay (they are what the seed writes). With the constraint gone, the boot check in
--   publisher/boot.ts still refuses SOCIAL_SIMULATION_ENABLED beside a row that breaks the rule.
--
-- Applies on its own with plain `psql -f` (CI's sync-engine-go job) and again without error: every statement is guarded
-- (the backfill matches nothing the second time; DROP ... IF EXISTS before each ADD/CREATE). No grant, no secret, no
-- company names or ids. Neither table is in the sync-engine's write-back registry.

DO $$
DECLARE
  co RECORD;
  n_sim_bad integer := 0;
  n_real_bad integer := 0;
  n_grants integer := 0;
  n_fixed integer := 0;
  n_left integer := 0;
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'social_accounts' AND column_name = 'simulated') THEN
    RAISE EXCEPTION 'SCP-Sa2: social_accounts.simulated is missing; 202610271600_social_simulation.sql must run first';
  END IF;

  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    PERFORM set_config('app.scopes', 'social', true);

    -- The shapes this file will not guess at (see the header).
    SELECT count(*) INTO n FROM social_accounts
     WHERE simulated AND (connected_by IS NOT NULL
                          OR (postiz_integration_id IS NOT NULL AND postiz_integration_id NOT LIKE 'simulated:%'));
    n_sim_bad := n_sim_bad + n;
    SELECT count(*) INTO n FROM social_accounts WHERE NOT simulated AND postiz_integration_id LIKE 'simulated:%';
    n_real_bad := n_real_bad + n;
    SELECT count(*) INTO n FROM social_oauth_tokens t
      JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id
     WHERE a.simulated;
    n_grants := n_grants + n;

    -- The backfill: simulated rows with no integration id get the seed's own id. Never a non-simulated row.
    UPDATE social_accounts
       SET postiz_integration_id = 'simulated:' || network
     WHERE simulated AND postiz_integration_id IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    n_fixed := n_fixed + n;

    SELECT count(*) INTO n FROM social_accounts WHERE simulated AND postiz_integration_id IS NULL;
    n_left := n_left + n;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);
  PERFORM set_config('app.scopes', '', true);

  IF n_sim_bad + n_real_bad + n_grants > 0 THEN
    RAISE EXCEPTION 'SCP-Sa2: % simulated account(s) carry a non-simulated integration id or a connected_by, % real account(s) carry a simulated: integration id, and % OAuth grant(s) name a simulated account. This file does not guess which kind they are: list them with the queries in infra/runbooks/social-simulation.md ("Side by side", step 0) and decide each before deploying', n_sim_bad, n_real_bad, n_grants;
  END IF;
  IF n_left <> 0 THEN
    RAISE EXCEPTION 'SCP-Sa2: % simulated account(s) still have no integration id after the backfill (RLS zero-row trap?)', n_left;
  END IF;
  RAISE NOTICE '[SCP-Sa2] simulated accounts given their simulated:<network> integration id: % row(s)', n_fixed;
END $$;

-- (1) One kind per row. One ALTER keeps the DROP and the ADD together, so a re-run replaces and never stacks.
ALTER TABLE social_accounts
  DROP CONSTRAINT IF EXISTS social_accounts_kind_ck,
  ADD CONSTRAINT social_accounts_kind_ck CHECK (
    (simulated
       AND postiz_integration_id IS NOT NULL
       AND postiz_integration_id LIKE 'simulated:%'
       AND connected_by IS NULL)
    OR
    (NOT simulated
       AND (postiz_integration_id IS NULL OR postiz_integration_id NOT LIKE 'simulated:%'))
  );

-- (2) The kind does not change once the row has been used as a kind. Fires only when `simulated` is in the SET list and
-- actually changes, so every ordinary write (status, handle, soft-delete, the seed's own repair) is untouched.
CREATE OR REPLACE FUNCTION social_accounts_kind_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
BEGIN
  IF OLD.simulated AND NOT NEW.simulated THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('social_accounts_kind_guard: account %s is simulated and cannot become real (SCP-D9: an account is one kind for its whole life; its simulated posts would be asked of a real engine)', OLD.id);
  END IF;
  IF NEW.simulated AND NOT OLD.simulated THEN
    IF OLD.postiz_integration_id IS NOT NULL OR OLD.connected_by IS NOT NULL
       OR EXISTS (SELECT 1 FROM social_oauth_tokens t WHERE t.account_id = OLD.id AND t.tenant_id = OLD.tenant_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = format('social_accounts_kind_guard: account %s reached a real engine (an integration id, a connected_by or an OAuth grant) and cannot be marked simulated (SCP-D9)', OLD.id);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_social_accounts_kind_guard ON social_accounts;
CREATE TRIGGER trg_social_accounts_kind_guard
  BEFORE UPDATE OF simulated ON social_accounts
  FOR EACH ROW
  WHEN (OLD.simulated IS DISTINCT FROM NEW.simulated)
  EXECUTE FUNCTION social_accounts_kind_guard();

-- (3) No OAuth grant on a simulated account.
CREATE OR REPLACE FUNCTION social_oauth_tokens_real_account_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM social_accounts a
              WHERE a.id = NEW.account_id AND a.tenant_id = NEW.tenant_id AND a.simulated) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('social_oauth_tokens_real_account_only: account %s is simulated; an OAuth grant publishes for real and is never stored for a simulated account (SCP-D9)', NEW.account_id);
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_social_oauth_tokens_real_account_only ON social_oauth_tokens;
CREATE TRIGGER trg_social_oauth_tokens_real_account_only
  BEFORE INSERT OR UPDATE OF account_id, tenant_id ON social_oauth_tokens
  FOR EACH ROW
  EXECUTE FUNCTION social_oauth_tokens_real_account_only();

-- Assert what this file made, and that the walls are as they were. Catalogue reads only.
DO $$
DECLARE
  n integer;
  t text;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('social_accounts') AND conname = 'social_accounts_kind_ck' AND contype = 'c' AND convalidated;
  IF n <> 1 THEN
    RAISE EXCEPTION 'SCP-Sa2: social_accounts_kind_ck is missing or unvalidated';
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O'
     AND ((tgrelid = to_regclass('social_accounts') AND tgname = 'trg_social_accounts_kind_guard')
       OR (tgrelid = to_regclass('social_oauth_tokens') AND tgname = 'trg_social_oauth_tokens_real_account_only'));
  IF n <> 2 THEN
    RAISE EXCEPTION 'SCP-Sa2: expected trg_social_accounts_kind_guard and trg_social_oauth_tokens_real_account_only enabled, found %', n;
  END IF;

  FOREACH t IN ARRAY ARRAY['social_accounts', 'social_oauth_tokens'] LOOP
    SELECT count(*) INTO n FROM pg_class WHERE oid = to_regclass(t) AND relrowsecurity AND relforcerowsecurity;
    IF n <> 1 THEN
      RAISE EXCEPTION 'SCP-Sa2: % must keep RLS ENABLED and FORCED', t;
    END IF;
  END LOOP;
END $$;
