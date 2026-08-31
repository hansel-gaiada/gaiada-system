-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- activities: approval attribution — `approved_by`, `approval_channel`, `executed_by` (P0 item 5)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Design: docs/superpowers/plans/2026-08-22-pantheon-airlock-design.md §6A.
--
-- ⚠ FILENAME NOTE: stamped 202608261100 rather than the literal `date -u` (which read 202608260744
-- on this machine). The head was already 202608261030 from a concurrent session, and a migration
-- that sorts BEFORE an applied one never runs on an existing database — silently. Ordering is the
-- property the naming rule exists to protect, so it wins over matching a clock that is behind.
--
-- ── WHAT THIS FIXES: APPROVAL IS NOT DELEGATION ──────────────────────────────────────────────────
-- The estate already records the agent that drove a call, as the owner's `Co-Authored-By` framing:
-- `actor_id` names the human (author), `metadata.via` names the agent (co-author). That models
-- DELEGATION — "Alice's agent acted AS Alice", effective permission = agent ∩ Alice.
--
-- It cannot express APPROVAL — "Pantheon acted on its OWN authority, and a human authorised THIS
-- action". Recorded in the author/co-author shape that would read as *"the boss did it, co-authored
-- by Pantheon"*, which is false: he did not do it, he permitted it.
--
-- The difference is not pedantry; it decides what the record can answer during an incident. Ask
-- "what did the boss actually DO last month?" and a delegation-shaped record returns 400 actions he
-- merely clicked approve on.
--
-- ── WHY COLUMNS, WHEN `via` IS A METADATA KEY ────────────────────────────────────────────────────
-- Deliberate divergence from the `via` precedent, for one reason: `approved_by` is the security-
-- relevant half. A jsonb key can hold a uuid that references nobody, and an audit row claiming
-- approval by a nonexistent user is worse than no row at all — it manufactures accountability. A
-- column with a foreign key cannot lie that way. `via` carries no such weight (it is
-- authorization-neutral by construction), so it stays where it is.
--
-- ── AND WHY `writeActivity` IS NOT GIVEN THREE MORE PARAMETERS ───────────────────────────────────
-- It has 263 call sites. The estate already learned that threading an attribution field through them
-- makes it OPT-IN, and "the failure mode of an opt-in audit field is that the site somebody forgets
-- is the site that mattered, with nothing failing when they forget". These are populated from
-- request-scoped ambient context exactly as `via` is — that wiring is a follow-up, and the columns
-- are useless-but-harmless until it lands.

ALTER TABLE activities
  -- The human who AUTHORISED this action. NULL = none was required (see the CHECK below for why
  -- that is not the same as "we failed to record one").
  ADD COLUMN approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- WHERE the approval was given. Same authority, different assurance: an ERP approval rides an
  -- MFA-backed session this estate controls; a Discord approval rides a third-party account it does
  -- not. Recording them as interchangeable would record something false.
  ADD COLUMN approval_channel text,
  -- WHICH seat actually held the tool. For a Pantheon-originated action the actor is `pantheon` and
  -- the executor is one of OUR seats — the two are different facts and collapsing them loses the one
  -- that says where the capability lived.
  ADD COLUMN executed_by text;

-- An approval must say where it came from. Without this, `approved_by` alone cannot answer the
-- question that matters after a channel compromise — "which approvals arrived via Discord in the
-- last 30 days?" — and the honest answer would become "all of them".
ALTER TABLE activities
  ADD CONSTRAINT activities_approval_channel_required
  CHECK (approved_by IS NULL OR approval_channel IS NOT NULL);

-- Constrained rather than free text: a channel invented at a call site is a channel no query will
-- find. Extending this list is a deliberate change, which is the point.
ALTER TABLE activities
  ADD CONSTRAINT activities_approval_channel_known
  CHECK (approval_channel IS NULL OR approval_channel IN ('erp', 'discord', 'wa', 'telegram', 'api'));

-- The revocation-scope query. Partial: approvals are a small minority of activity rows, and an index
-- over the whole table would be mostly empty entries.
CREATE INDEX idx_activities_approvals ON activities (approval_channel, occurred_at DESC)
  WHERE approved_by IS NOT NULL;

COMMENT ON COLUMN activities.approved_by IS
  'The human who AUTHORISED this action — distinct from actor_id (who did it) and metadata.via (which '
  'agent drove it). Approval is not delegation: recording an approval in the author/co-author shape '
  'would claim the approver performed the action.';
COMMENT ON COLUMN activities.approval_channel IS
  'Where the approval was given (erp | discord | wa | telegram | api). Same AUTHORITY, different '
  'ASSURANCE — an ERP approval rides an MFA session this estate controls, a Discord one does not. '
  'Required whenever approved_by is set, so a channel compromise can be scoped in one query.';
COMMENT ON COLUMN activities.executed_by IS
  'The seat that actually held the tool, when the actor did not. Pantheon proposes; our seats execute.';

-- ── SELF-ASSERTION ───────────────────────────────────────────────────────────────────────────────
-- Prove both constraints REJECT. A CHECK that never fires is indistinguishable from no CHECK, and
-- these two are the whole content of the migration.
DO $$
DECLARE
  n integer;
  t uuid;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'activities' AND column_name IN ('approved_by','approval_channel','executed_by');
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 new columns, found %', n; END IF;

  SELECT id INTO t FROM companies ORDER BY id LIMIT 1;
  IF t IS NULL THEN
    RAISE NOTICE 'no company row — constraint assertions skipped (fresh database)';
    RETURN;
  END IF;

  -- ⚠ THE TENANT GUC IS REQUIRED, AND ITS ABSENCE FAILED A LIVE DEPLOY (2026-08-26).
  --
  -- `activities` is FORCE-RLS. Migrations run as `platform_owner`, which is NOBYPASSRLS, so the two
  -- probe INSERTs below are refused by the POLICY before either CHECK can fire:
  --   "new row violates row-level security policy for table \"activities\""
  -- That error is neither `check_violation` nor `not_null_violation`, so the handlers below did not
  -- catch it, the DO block aborted, and the deploy of alpha-01.071.0172a rolled back.
  --
  -- ★ CI COULD NOT HAVE CAUGHT THIS. Test databases run migrations as a SUPERUSER, which bypasses
  -- RLS, so the probes inserted happily and the whole suite was green. The privilege difference
  -- between the test harness and the live migrator is the entire bug, and it is invisible from the
  -- test side. Same family as the trap platform-nest/CLAUDE.md documents for backfills, with the
  -- opposite symptom: a backfill silently matches ZERO rows, an INSERT loudly refuses.
  --
  -- Setting the GUC rather than widening the EXCEPTION handler is deliberate. Catching the RLS error
  -- would make both assertions "pass" while proving NOTHING — the row would be rejected by the
  -- policy, never reaching the CHECK the block exists to exercise, and a constraint that is never
  -- exercised is indistinguishable from a constraint that is not there. Which is precisely the
  -- argument in this block's own header.
  PERFORM set_config('app.current_tenant_ids', t::text, true);

  -- An approval with no channel must fail.
  BEGIN
    INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, origin_site, approved_by)
    VALUES (gen_random_uuid(), t, NULL, 'test', 'test', NULL, 'test', (SELECT id FROM users LIMIT 1));
    RAISE EXCEPTION 'activities_approval_channel_required did NOT fire';
  EXCEPTION WHEN check_violation THEN NULL; WHEN not_null_violation THEN NULL;
  END;

  -- An invented channel must fail.
  BEGIN
    INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, origin_site, approval_channel)
    VALUES (gen_random_uuid(), t, NULL, 'test', 'test', NULL, 'test', 'carrier-pigeon');
    RAISE EXCEPTION 'activities_approval_channel_known did NOT fire';
  EXCEPTION WHEN check_violation THEN NULL; WHEN not_null_violation THEN NULL;
  END;
END $$;
