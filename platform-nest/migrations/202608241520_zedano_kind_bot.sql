-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PK-01 follow-up · the Hermes orchestrator is not an employee
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- `zedano@gaiada.com` ("Zedano (Hermes agent)", title "AI Agent") carries `users.kind = 'employee'`
-- on the live estate. That is wrong, and it is wrong in the direction PK-01 chose deliberately: the
-- discriminator defaults to `employee` so an unclassified account shows up in people surfaces, where
-- it is VISIBLE and gets corrected, rather than silently vanishing from a headcount.
--
-- It got corrected the hard way. `seed:retire-placeholder-hr` listed 18 candidate HR files instead
-- of the expected 17, and the extra was this account — an AI appearing as staff on every HR surface.
--
-- ── WHY `bot` AND NOT A NEW `orchestrator` KIND (owner decision 2026-08-24) ────────────────────────
-- `bot` is already the kind for exactly this. PK-01's own spec assigns "Hermes and its personas" to
-- it, and the migration that created the column explains the split: an n8n workflow is a pinned,
-- enumerable script (`automation`), whereas a model-driven agent's next action is not enumerable in
-- advance (`bot`). Different audit expectation, different assurance floor.
--
-- An `orchestrator` value was considered and rejected. `users.kind` answers "what IS this account"
-- and is consumed as an ALLOW-LIST (`AND u.kind = 'employee'`), so each extra value multiplies the
-- readers that must enumerate "which kinds are AI" — and PERMISSION-CONTRACT §15 records what
-- happens when one such gate is keyed on the wrong axis: keying mcp-hub's impact gate on
-- `provider = 'n8n'` left every agent-driven high-impact write unattended. PK-01 split kinds on
-- AUDIT CLASS, and an orchestrator is the same audit class as a persona: both model-driven, neither
-- enumerable. What makes this account an orchestrator is what it DOES — route work to other agents —
-- which belongs in `agent_registry` or a role, not in the principal discriminator.
--
-- ⚠ THIS DOES NOT PREVENT RECURRENCE, AND THAT IS NOT AN OVERSIGHT I CAN CLOSE HERE. No code in this
-- repo creates this row — it is provisioned by hand on the Hermes side (`hermes-config/`,
-- `persona/`), so there is no seed to correct and nothing to stop the next hand-created agent
-- landing as `employee` again. The durable fix is to provision agent principals through a seed the
-- way `provision-roster` does for staff, which is tracked work, not this migration's job.
--
-- ⚠ RELATED GAP, DELIBERATELY NOT TOUCHED: `agent_registry` holds NO row for this account. That
-- table is what ties an agent to an eval suite and an identity
-- (`agent_registry_enabled_requires_evidence` CHECKs that an enabled agent has both), so the
-- orchestrator is currently outside the mechanism that is supposed to gate it. Fixing that is an
-- agent-platform change (WS8), not a discriminator correction, and doing it silently inside this
-- migration would bury it.
--
-- No RLS guard needed: `users` carries no row security (stated in 202608201442's own tail comment),
-- so a plain UPDATE here matches every row it should. Confirmed rather than assumed — an unguarded
-- UPDATE on a FORCE-RLS table is the failure this repo's `lint:migration-rls` exists to catch.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  changed integer;
  strays  integer;
BEGIN
  UPDATE users
     SET kind = 'bot'
   WHERE email = 'zedano@gaiada.com'
     AND kind <> 'bot';

  GET DIAGNOSTICS changed = ROW_COUNT;

  -- Idempotent, so 0 is fine on a re-run or on a database that never had the row (every test DB).
  -- More than one would mean `users.email` is not unique, which would be a much larger problem.
  IF changed > 1 THEN
    RAISE EXCEPTION 'expected at most 1 row for zedano@gaiada.com, updated %', changed;
  END IF;

  RAISE NOTICE 'zedano kind -> bot: % row(s) changed', changed;

  -- A CENSUS, NOT A SPOT FIX. If another AI-shaped account is sitting in `employee`, this migration
  -- has found only one of them and the surface is still wrong. Reported rather than auto-corrected:
  -- `title ILIKE '%AI Agent%'` is a heuristic, and silently rewriting a principal's kind on a
  -- heuristic is how a real person with an unlucky job title stops being counted as staff.
  SELECT count(*) INTO strays
    FROM users
   WHERE kind = 'employee'
     AND (title ILIKE '%AI agent%' OR name ILIKE '%hermes%' OR name ILIKE '%(agent%');

  IF strays > 0 THEN
    RAISE WARNING
      'PK-01: % further account(s) look like AI principals but still carry kind=employee — '
      'check them by hand (this migration deliberately does not guess)', strays;
  END IF;
END $$;
