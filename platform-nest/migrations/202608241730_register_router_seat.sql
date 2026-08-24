-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- WS8 · register the router seat, DISABLED, so the orchestrator is inside the mechanism that gates it
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- `zedano@gaiada.com` has been the live Hermes orchestrator since 2026-07-31 and `agent_registry`
-- held no row for it at all. That table is what ties an agent to an eval suite and a bounded
-- identity, so the one agent actually running was the one agent outside its own control surface.
--
-- ── WHY THIS IS A DISABLED SEAT AND NOT AN ENABLED ONE ────────────────────────────────────────────
-- `agent_registry_enabled_requires_evidence` CHECKs `NOT enabled OR (eval_suite IS NOT NULL AND
-- identity_user_id IS NOT NULL)`. There is no eval suite for the router yet, and inventing a name to
-- satisfy the constraint would be the exact defeat the constraint exists to prevent: the migration
-- that created it says "agent behaviour is stochastic; 'I ran it once' is not evidence."
--
-- So `enabled = false`. This is not a placeholder or a compromise — it is the state the schema was
-- designed to express, in that table's own words: "Nullable so a seat can be defined before its
-- identity is provisioned; enabling still requires it" and "a seat may be authored freely, but
-- turning it on requires both an eval suite and a real identity." Registering it disabled makes the
-- orchestrator VISIBLE in the registry, and leaves the evidence gate exactly where it was rather
-- than stepping around it.
--
-- ⚠ WHAT THIS DOES NOT CLAIM. `enabled = false` here does NOT stop the live orchestrator working —
-- Hermes runs from its own config (`hermes-config/`, `persona/`) and does not consult this table.
-- Nothing about today's behaviour changes. What changes is that the seat now exists to be gated, so
-- when the registry does become load-bearing the router is not the one seat missing from it. Anyone
-- reading `enabled = false` as "the router is off" would be wrong, which is why it is stated here.
--
-- ── WHY `name = 'router'` ─────────────────────────────────────────────────────────────────────────
-- Not a guess. The table's own CHECK reserves the literal `router` as one of two singleton names
-- (`^(router|pantheon|(dept|sys|sec|edge)-...)$`), and `persona/router/identity.md` opens with "Your
-- name is **Zedano**. You are the front door to the Gaiada agent workforce." The reserved name and
-- the persona directory are the same seat.
--
-- `company_scope = NULL` is group scope — the router serves every company, which is why the table
-- carries partial unique indexes for the NULL case rather than a plain UNIQUE.
--
-- `capability_tags` and `tool_namespaces` are left EMPTY on purpose. They are what the router matches
-- intent against and what bounds its hub view; populating them from guesswork would put routing
-- configuration in a migration whose author does not know the intended taxonomy. An empty allow-list
-- is also the fail-closed direction.
--
-- `max_impact` keeps the table default `'read'`. The orchestrator routes work to other agents rather
-- than writing itself, and if that is ever wrong the fix is a reviewed change to this row, not a
-- generous default chosen today.
--
-- No RLS guard needed: `agent_registry` has no tenant_isolation policy (its scoping is the
-- `company_scope` column, and group-scope rows are NULL by design). Checked, not assumed.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  zedano uuid;
  existing integer;
BEGIN
  -- Keyed on the identity link, not the email: `identity_links.provider = 'hermes'` is the mechanism
  -- that makes this account an agent principal, and PK-01's backfill records why that is the right
  -- key ("the email is a seed convention while the link is the mechanism"). Falls back to the email
  -- only so a database without the link still resolves the seat it is meant to describe.
  SELECT u.id INTO zedano
    FROM users u
   WHERE EXISTS (SELECT 1 FROM identity_links il WHERE il.user_id = u.id AND il.provider = 'hermes')
     AND u.deleted_at IS NULL
   ORDER BY u.created_at
   LIMIT 1;

  IF zedano IS NULL THEN
    SELECT id INTO zedano FROM users WHERE email = 'zedano@gaiada.com' AND deleted_at IS NULL;
  END IF;

  -- No identity here is an ordinary state, not an error: every test database and every fresh
  -- environment reaches this migration before any Hermes principal exists. Registering a seat with a
  -- NULL identity would be legal (the column is nullable) but would describe nothing, so skip.
  IF zedano IS NULL THEN
    RAISE NOTICE 'no hermes principal on this database — router seat not registered (expected on a fresh DB)';
    RETURN;
  END IF;

  SELECT count(*) INTO existing FROM agent_registry WHERE name = 'router' AND company_scope IS NULL;
  IF existing > 0 THEN
    -- Idempotent, and deliberately NOT an UPDATE. If a router seat already exists, something else
    -- authored it and overwriting its capability_tags, tool_namespaces or max_impact from this
    -- migration's defaults would silently narrow a configured agent.
    RAISE NOTICE 'router seat already registered — left untouched';
    RETURN;
  END IF;

  INSERT INTO agent_registry (name, kind, company_scope, identity_user_id, eval_suite, enabled, notes)
  VALUES (
    'router', 'system', NULL, zedano, NULL, false,
    'Zedano — the live Hermes orchestrator, registered 2026-08-24 so the running agent is inside the ' ||
    'registry that gates agents. DISABLED because no eval suite exists yet; enabling requires one ' ||
    'per agent_registry_enabled_requires_evidence. This flag does NOT control the live orchestrator, ' ||
    'which runs from hermes-config/ and does not read this table.'
  );

  RAISE NOTICE 'router seat registered (disabled) for user %', zedano;
END $$;
