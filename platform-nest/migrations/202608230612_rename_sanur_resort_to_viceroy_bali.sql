-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Rename the placeholder resort to its real name, ON EXISTING DATABASES
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ FOUND ON THE LIVE BOX, NOT IN A TEST. Commit b48df97 corrected the seed's resort from the
-- placeholder `Sanur Resort` to the real `Viceroy Bali` (Ubud, est. 2005 by the Syrowatka family).
-- Every suite passed, because `src/testing/setup.ts` gives each test file a FRESH database — so the
-- seed always created the resort from nothing and the new name was simply the name.
--
-- Production is not a fresh database. `ensureCompany()` resolves a company BY NAME:
--
--     SELECT id FROM companies WHERE name = $1        -- 'Viceroy Bali' -> no row
--     ...if not found: INSERT a new company
--
-- So re-running `seed:agency` against the live estate would NOT rename anything. It would leave
-- `Sanur Resort` sitting there with whatever hangs off it, INSERT a brand-new empty `Viceroy Bali`
-- beside it, and then attach the four venues + the owner grants to the new one. Two resorts, one
-- holding the history and one holding the structure. A rename is not idempotent through a
-- lookup-by-name helper, and that is the trap this file closes.
--
-- Caught by checking the live company list before running the seed, rather than after.
--
-- ── WHY A MIGRATION AND NOT A HAND-EDIT ON THE BOX ────────────────────────────────────────────────
-- The estate has two hosts and a sync engine; a hand-run UPDATE is invisible to both, and to anyone
-- restoring from a backup. This runs at boot on every environment, exactly once, and says what it did.

DO $$
DECLARE
  n_old integer;
  n_new integer;
BEGIN
  SELECT count(*) INTO n_old FROM companies WHERE name = 'Sanur Resort' AND deleted_at IS NULL;
  SELECT count(*) INTO n_new FROM companies WHERE name = 'Viceroy Bali'  AND deleted_at IS NULL;

  IF n_old = 0 THEN
    -- A fresh database (the test path) seeds `Viceroy Bali` directly and never had the placeholder.
    RAISE NOTICE 'rename: no `Sanur Resort` row — nothing to do (fresh DB or already renamed)';

  ELSIF n_new > 0 THEN
    -- Both names present. That means the fork this migration exists to prevent has ALREADY happened,
    -- and merging two companies is a data decision (which one owns the clients, projects, invoices?)
    -- that a migration must not make silently. Fail loudly and let a human choose.
    RAISE EXCEPTION
      'rename: BOTH `Sanur Resort` and `Viceroy Bali` exist. The seed has already forked the resort; '
      'merging them is an owner decision (which row keeps the clients/projects/invoices), not '
      'something this migration may guess. Resolve by hand, then re-run.';

  ELSE
    -- `companies.name` carries no unique constraint, so this cannot collide; the n_new check above is
    -- what makes it safe, not the schema.
    UPDATE companies SET name = 'Viceroy Bali', type = 'resort', updated_at = now()
     WHERE name = 'Sanur Resort' AND deleted_at IS NULL;
    RAISE NOTICE 'rename: `Sanur Resort` -> `Viceroy Bali` (% row(s)); its id, children and history are unchanged', n_old;
  END IF;
END $$;

COMMENT ON TABLE companies IS
  'Company tree. ⚠ Renaming a company that `src/seed/agency.ts` resolves BY NAME requires a migration '
  'like 202608230612 — the seed''s ensureCompany() would otherwise INSERT a duplicate rather than '
  'rename, forking the company on every database that already had the old name.';
