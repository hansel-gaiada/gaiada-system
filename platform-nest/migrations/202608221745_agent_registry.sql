-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- agent_registry — the agent workforce as DATA (P0/B1)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Design: docs/superpowers/plans/2026-08-10-hermes-orchestration-architecture.md §4
--         docs/superpowers/plans/2026-08-22-hermes-build-inventory.md §2 (the 15 rows)
--         docs/superpowers/plans/2026-08-22-hermes-moe-personas-training.md §4 (roster + tiers)
-- Tracker: docs/superpowers/plans/2026-08-22-hermes-PROGRESS.md (B1 — this table blocks everything)
--
-- THE POINT OF THIS TABLE: "New departments and new businesses must be ROWS, NOT COMMITS." If adding
-- a department or a company means editing a switch statement or a prompt, the design has already
-- failed its own scaling requirement. Routing (MoE-A) gates on capability_tags here; the hub's
-- per-principal tool view gates on tool_namespaces here. Neither reads a hard-coded list.
--
-- ── WHY GLOBAL / NO RLS (deliberate, same posture as infra_hosts and the permission catalog) ──────
-- This is PLATFORM CONFIGURATION describing our own agent workforce — not tenant business data. Two
-- concrete reasons it must not be FORCE-RLS'd:
--   1. The ROUTER must see every enabled seat in order to route at all. Under tenant RLS it would see
--      only the acting tenant's rows and silently under-route — a failure that looks like "the agent
--      didn't know about that department" rather than an authorization error.
--   2. `company_scope` is the seat's REACH, not its owner. A group-scoped seat (NULL) is nobody's
--      tenant row by construction, so there is no tenant_id to gate on.
-- Read via withGlobal() only, exactly like `permissions` (0001_core.sql / 0093) and `infra_hosts`
-- (202608211610). This keeps lint:withtenants and lint:migration-rls satisfied the same way they do.
-- Authorization over what a seat may DO is Cerbos' job, not this table's.
--
-- ── WHAT IS ENFORCED HERE RATHER THAN BY CONVENTION ───────────────────────────────────────────────
-- Four of the program's non-negotiables are expressed as CHECK constraints below, because each one
-- is a rule that a future ticket would otherwise be free to violate silently:
--   · an agent with no eval suite CANNOT BE ENABLED   (the enablement gate — §7 "evals as the gate")
--   · `sec-guard` can never hold anything above `read` (highest blast radius in the estate)
--   · an `external` seat (Pantheon) holds NO tools     (it proposes; our seats execute)
--   · model_class is a CAPABILITY CLASS, never a model name (so "gpt-4o" cannot be stored)
-- A constraint is not a substitute for the runtime checks; it is the layer that survives them.

CREATE TABLE agent_registry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Naming convention from the architecture doc: dept-* / sys-* / sec-* / edge-* / the router / ext-*.
  -- Enforced so the roster cannot drift into ad-hoc names that the router's matching has to special-case.
  name              text NOT NULL CHECK (name ~ '^(router|pantheon|(dept|sys|sec|edge)-[a-z0-9][a-z0-9-]*)$'),

  kind              text NOT NULL CHECK (kind IN ('department','system','security','edge','external')),

  -- The seat's REACH. NULL = group scope (cross-company). See the partial unique indexes below —
  -- NULL does NOT collide in a plain UNIQUE, which is exactly the trap this estate has hit before.
  company_scope     uuid REFERENCES companies(id) ON DELETE CASCADE,

  -- What the router matches classified intent against (MoE-A gating). Data, never a prompt.
  capability_tags   text[] NOT NULL DEFAULT '{}',

  -- The hub namespaces this principal may SEE. Layer 2 of the three-layer allow-list
  -- (AgentDef → hub tool view → Cerbos-authoritative). Keeps the model's context small AND removes
  -- the hallucinated-tool failure mode. Never the prompt.
  tool_namespaces   text[] NOT NULL DEFAULT '{}',

  max_impact        text NOT NULL DEFAULT 'read'
                      CHECK (max_impact IN ('read','low_write','medium_write','high_write')),

  -- MoE-M capability class. NEVER a model name: agents ask for a class and the gateway routes.
  -- If this ever needs a new value, that is a deliberate gateway change, not a per-seat decision.
  model_class       text NOT NULL DEFAULT 'general'
                      CHECK (model_class IN ('cheap-extract','general','code','reasoning','vision')),

  -- The agent's own bounded identity (principal-kinds: bots/automation are `users` rows on purpose).
  -- Nullable so a seat can be defined before its identity is provisioned; enabling still requires it.
  identity_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,

  -- Required to ENABLE, not required to EXIST (see the CHECK). This is the registry constraint the
  -- design asks for — "an agent with no eval suite cannot be enabled" — expressed so that authoring a
  -- seat during development stays possible while shipping one without evidence does not.
  eval_suite        text,

  enabled           boolean NOT NULL DEFAULT false,
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- ── The four structural non-negotiables ────────────────────────────────────────────────────────

  -- (1) THE ENABLEMENT GATE. Agent behaviour is stochastic; "I ran it once" is not evidence. A seat
  -- may be authored freely, but turning it on requires both an eval suite and a real identity.
  CONSTRAINT agent_registry_enabled_requires_evidence
    CHECK (NOT enabled OR (eval_suite IS NOT NULL AND identity_user_id IS NOT NULL)),

  -- (2) sec-guard is PROPOSE-ONLY, PERMANENTLY. It must see broadly to be useful, which makes it the
  -- highest blast radius in the estate. Recommendation held in the architecture doc §9 Q2: never write.
  CONSTRAINT agent_registry_sec_guard_is_read_only
    CHECK (name <> 'sec-guard' OR max_impact = 'read'),

  -- (3) AN EXTERNAL SEAT HOLDS NO TOOLS. Pantheon proposes; our seats execute. If an external row
  -- could carry tool_namespaces it would hold standing privilege on our estate, which is precisely
  -- the property that makes "cannot go rogue" true rather than aspirational.
  CONSTRAINT agent_registry_external_holds_no_tools
    CHECK (kind <> 'external' OR cardinality(tool_namespaces) = 0),

  -- (4) THE ROUTER DOES NOT EXECUTE. Hermes orchestrates; ai-agents executes. Two orchestrators
  -- already exist in this estate and letting both execute splits budget/D14/tracing/eval enforcement
  -- across two paths — the split-brain the architecture doc §3 exists to prevent.
  CONSTRAINT agent_registry_router_is_read_only
    CHECK (name <> 'router' OR max_impact = 'read')
);

-- ── Uniqueness, and the NULL trap ────────────────────────────────────────────────────────────────
-- `UNIQUE (name, company_scope)` alone is NOT enough: NULL is never equal to NULL in a unique
-- constraint, so every group-scoped seat would be insertable an unlimited number of times and the
-- duplicate would only surface as "the router picked a different row this time". This estate has
-- been bitten by exactly this. Two partial indexes cover both halves.
CREATE UNIQUE INDEX agent_registry_name_per_company
  ON agent_registry (name, company_scope) WHERE company_scope IS NOT NULL;
CREATE UNIQUE INDEX agent_registry_name_group_scoped
  ON agent_registry (name) WHERE company_scope IS NULL;

-- Routing reads: "which enabled seats match these capability tags?"
CREATE INDEX agent_registry_capability_tags ON agent_registry USING gin (capability_tags);
-- Hub tool-view reads: resolve a principal's namespaces by identity.
CREATE INDEX agent_registry_identity ON agent_registry (identity_user_id) WHERE identity_user_id IS NOT NULL;
-- The router's hot path only ever wants enabled rows.
CREATE INDEX agent_registry_enabled ON agent_registry (enabled) WHERE enabled;

COMMENT ON TABLE agent_registry IS
  'The agent workforce as DATA (P0/B1). One row per seat: 1 router + 10 department seats + sys-ops + '
  'sec-guard + edge-wa + the external `pantheon` principal. A new department or a new COMPANY is rows '
  'here, never a commit — that is the scaling test the whole design is measured against. GLOBAL, no '
  'RLS (read via withGlobal()): the router must see every enabled seat to route, and company_scope is '
  'the seat''s reach rather than its owner. Four non-negotiables are CHECK constraints, not '
  'conventions: no enable without an eval suite + identity; sec-guard read-only forever; an external '
  'seat holds no tools; the router never executes.';

COMMENT ON COLUMN agent_registry.company_scope IS
  'The seat''s reach. NULL = group scope (cross-company). Enforced by TWO partial unique indexes '
  'because NULL never collides in a plain UNIQUE — a duplicate group seat would otherwise be silent.';
COMMENT ON COLUMN agent_registry.tool_namespaces IS
  'Layer 2 of the three-layer allow-list (AgentDef · hub tool view · Cerbos-authoritative). Cerbos is '
  'the authority; this keeps the model''s context small and removes the hallucinated-tool failure '
  'mode. NEVER expressed in a prompt.';
COMMENT ON COLUMN agent_registry.model_class IS
  'MoE-M CAPABILITY CLASS, never a model name — the CHECK makes storing "gpt-4o" impossible. Seat '
  'economics are a standing rule: no seat defaults to Opus; model choice is a budget decision.';
COMMENT ON COLUMN agent_registry.eval_suite IS
  'Required to ENABLE, not to exist. Authoring a seat during development stays possible; shipping one '
  'without evidence does not.';

-- ── SELF-ASSERTION (0106/.../202608201519 idiom) ──────────────────────────────────────────────────
-- Prove the four structural constraints actually reject, rather than trusting that they were written
-- correctly. A CHECK that does not fire is indistinguishable from no CHECK at all.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_name = 'agent_registry';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected agent_registry to exist, found %', n;
  END IF;

  -- (1) enable without evidence must fail
  BEGIN
    INSERT INTO agent_registry (name, kind, max_impact, enabled) VALUES ('dept-pm','department','read',true);
    RAISE EXCEPTION 'agent_registry_enabled_requires_evidence did NOT fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (2) a writing sec-guard must fail
  BEGIN
    INSERT INTO agent_registry (name, kind, max_impact) VALUES ('sec-guard','security','low_write');
    RAISE EXCEPTION 'agent_registry_sec_guard_is_read_only did NOT fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (3) an external seat holding tools must fail
  BEGIN
    INSERT INTO agent_registry (name, kind, tool_namespaces) VALUES ('pantheon','external','{pm}');
    RAISE EXCEPTION 'agent_registry_external_holds_no_tools did NOT fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (4) a model NAME in model_class must fail
  BEGIN
    INSERT INTO agent_registry (name, kind, model_class) VALUES ('dept-seo','department','gpt-4o');
    RAISE EXCEPTION 'model_class CHECK did NOT fire (a model name was storable)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (5) the NULL-scope duplicate trap: a second group-scoped row of the same name must fail
  INSERT INTO agent_registry (name, kind) VALUES ('dept-hr','department');
  BEGIN
    INSERT INTO agent_registry (name, kind) VALUES ('dept-hr','department');
    RAISE EXCEPTION 'agent_registry_name_group_scoped did NOT fire (NULL company_scope duplicated)';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  DELETE FROM agent_registry WHERE name = 'dept-hr';
END $$;
