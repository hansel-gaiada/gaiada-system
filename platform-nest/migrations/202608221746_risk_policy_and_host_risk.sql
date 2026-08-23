-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- risk_policy + infra_hosts.risk_weight — the risk ladder as DATA (P0)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Design: docs/superpowers/plans/2026-08-22-hermes-moe-personas-training.md §4 (the four tiers)
-- Tracker: docs/superpowers/plans/2026-08-22-hermes-PROGRESS.md items 2–4
--
-- ── WHAT ALREADY EXISTS, AND IS DELIBERATELY REUSED ───────────────────────────────────────────────
-- `infra_hosts` (202608211610) IS the environment registry. It already carries
-- `env IN ('production','staging','ops','dev')` per host. Building a second "environments" table
-- beside it would create exactly the drifting mirror this estate has paid for before, so this
-- migration EXTENDS it instead.
--
-- The hub already treats environment as a risk axis, too: `delivery-tools.ts` ships deployStaging as
-- impact "low" ("staging is isolated + reversible") and deployProd as impact "high" ("customer-facing
-- + not trivially reversible"). That instinct is correct and does NOT scale — it expresses the
-- difference by DUPLICATING THE TOOL, so every tool touching more than one environment would need one
-- variant per combination. This table is that instinct, generalized: risk becomes a property of the
-- CALL, computed, rather than a constant frozen onto the tool.
--
-- ── THE ONE INVARIANT THAT MUST SURVIVE EVERY FUTURE REFACTOR ─────────────────────────────────────
-- The tool's declared `impact` is a FLOOR. Computation may RAISE a call's tier and may never LOWER
-- it, and an unmatched lookup must FAIL CLOSED. `mcp-hub/src/policy.ts:73` already gets this right
-- today (`tool.impact ?? "unclassified"` suspends rather than allows) — and a computed-risk refactor
-- is precisely where that property gets lost, because a lookup that misses naturally returns "no risk
-- found", which reads as safe. The DEFAULT on `min_tier` below is 'R2', not 'R0', for that reason.

-- ── 1 · host risk weight ──────────────────────────────────────────────────────────────────────────
-- Nullable ON PURPOSE: NULL means "derive from env", which keeps one source of truth for the common
-- case. The override exists for hosts whose env label understates them — e.g. shared WordPress
-- hosting is nominally production but has WEAKER rollback than our own production box, so assuming
-- parity with helios would be optimistic in the one direction that costs money.
ALTER TABLE infra_hosts ADD COLUMN risk_weight text
  CHECK (risk_weight IS NULL OR risk_weight IN ('R0','R1','R2','R3'));

COMMENT ON COLUMN infra_hosts.risk_weight IS
  'Optional per-host override of the tier derived from `env` (production/ops => R2, staging/dev => R0). '
  'NULL means derive. Set it only where the env label understates the host — e.g. shared WP hosting, '
  'which is production with weaker rollback than our own box.';

-- ── 2 · seed the hosts the owner has now named (closes MSO-04 OQ-1) ───────────────────────────────
-- 202608211610 deliberately seeded only gda-aicenter and sumopod, recording that "every other host
-- from the operator's ssh config waits on OQ-1 (owner has not yet named env/role for them), so
-- seeding them here would be a guess this migration is not entitled to make."
--
-- OWNER ANSWERED 2026-08-22: `delphi` is STAGING for all projects, `helios` is PRODUCTION for all
-- projects, and shared WordPress hosting is production for WP projects. That is no longer a guess.
--
-- ⚠ CORRECTED, and worth recording because it flipped twice: an earlier session had delphi/helios on a
-- never-touch list believing they belonged to another company. That belief was WRONG; they are the
-- owner's. The stale claims in the observability plan and CREDENTIALS.local.md were removed 2026-08-22.
INSERT INTO infra_hosts (key, display_name, env, role, status, risk_weight, notes)
VALUES
  ('delphi', 'Delphi (staging)', 'staging', 'project-staging', 'onboarding', NULL,
   'Owner 2026-08-22: staging server for all projects. Isolated + reversible — this is the DELIBERATE '
   'agent playground, where automation velocity comes from. Awaits the MSO-03 onboarding runbook.'),
  ('helios', 'Helios (production)', 'production', 'project-production', 'onboarding', NULL,
   'Owner 2026-08-22: production server for all projects. Customer-facing, not trivially reversible.'),
  ('hostinger-wp', 'Hostinger (WordPress production)', 'production', 'wp-production', 'onboarding', 'R3',
   'Owner 2026-08-22: production for WP projects. risk_weight forced to R3 rather than derived: shared '
   'hosting has weaker rollback than our own production box, so env=production UNDERSTATES it.')
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  env          = EXCLUDED.env,
  role         = EXCLUDED.role,
  risk_weight  = EXCLUDED.risk_weight,
  notes        = EXCLUDED.notes,
  updated_at   = now();

-- ── 3 · the risk policy table ─────────────────────────────────────────────────────────────────────
-- GLOBAL, no RLS — same posture as agent_registry and infra_hosts, for the same reason: the hub must
-- evaluate a call's tier before it knows whose tenant it belongs to. `company_scope` is the policy's
-- REACH (NULL = the estate default), which is what lets a second business carry a different risk
-- appetite without a code change — the P9 scaling test.
CREATE TABLE risk_policy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_scope uuid REFERENCES companies(id) ON DELETE CASCADE,

  -- '*' is a wildcard on every dimension. Matching is INTENTIONALLY non-exclusive: every matching row
  -- contributes and the STRONGEST tier wins (see §4). No "most specific row wins" precedence, because
  -- that requires a total order nobody can keep correct, and its failure mode is a silent downgrade.
  action        text NOT NULL DEFAULT '*',
  env           text NOT NULL DEFAULT '*' CHECK (env IN ('*','production','staging','ops','dev')),
  data_class    text NOT NULL DEFAULT '*'
                  CHECK (data_class IN ('*','public','internal','client_confidential','personal_financial')),

  -- Fail-closed default. An unmatched or newly-added dimension lands at R2 (named human approval),
  -- never R0. See the invariant note in the header.
  min_tier      text NOT NULL DEFAULT 'R2' CHECK (min_tier IN ('R0','R1','R2','R3')),

  rationale     text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX risk_policy_rule_per_company
  ON risk_policy (action, env, data_class, company_scope) WHERE company_scope IS NOT NULL;
CREATE UNIQUE INDEX risk_policy_rule_default
  ON risk_policy (action, env, data_class) WHERE company_scope IS NULL;
CREATE INDEX risk_policy_lookup ON risk_policy (enabled, env, action) WHERE enabled;

COMMENT ON TABLE risk_policy IS
  'The risk ladder as DATA. R0 auto · R1 human-confirmed · R2 named approver · R3 the human acts and '
  'the agent only escorts. Every MATCHING row contributes and the STRONGEST tier wins — deliberately '
  'not "most specific wins", whose failure mode is a silent downgrade. The tool''s declared impact is '
  'a FLOOR the computation may raise and may never lower. company_scope NULL = estate default; a '
  'per-company row is how a second business carries a different risk appetite with no code change.';

-- ── 4 · the default ladder ────────────────────────────────────────────────────────────────────────
-- Deliberately SHORT. Every row here is a rule someone must be able to defend; a long default matrix
-- is one nobody reads. Anything not covered lands on the fail-closed R2 default.
INSERT INTO risk_policy (action, env, data_class, min_tier, rationale) VALUES
  ('read',   '*',          '*',                   'R0',
   'Reading is reversible and non-destructive. The gate on reads is SCOPE (Cerbos + RLS), not tier.'),
  ('read',   '*',          'personal_financial',  'R1',
   'Salary, payroll and payment data: reading is still a disclosure. Confirm who is asking.'),
  ('*',      'staging',    '*',                   'R0',
   'Staging is isolated and reversible — this is the deliberate agent playground. Real automation '
   'velocity comes from agents being genuinely autonomous HERE while near-powerless on production.'),
  ('*',      'dev',        '*',                   'R0', 'Dev is disposable.'),
  ('create', 'production', '*',                   'R1',
   'Creating is additive and usually reversible by deletion, but it is customer-visible in production.'),
  ('update', 'production', '*',                   'R1', 'Recoverable with effort; a human confirms.'),
  ('delete', '*',          '*',                   'R2',
   'Deletion is the least reversible ordinary action. A named approver, out of band.'),
  ('deploy', 'production', '*',                   'R2',
   'Customer-facing and not trivially reversible — matches delivery-tools.ts deployProd (impact high).'),
  ('send',   '*',          '*',                   'R2',
   'Outbound communication to a human is UNRECALLABLE once sent, and it speaks in someone''s name.'),
  ('grant',  '*',          '*',                   'R2',
   'Privilege escalation surface. A role-granting tool that an agent may call unattended is the path '
   'by which an agent widens its own reach.'),
  ('*',      '*',          'personal_financial',  'R2',
   'HR and finance mistakes are the unrecoverable ones. This is why those seats ship read-only first.'),
  ('delete', 'production', '*',                   'R3',
   'Destroying customer-facing state: the human acts, the agent escorts and verifies. R3 must be '
   'enforced by the ABSENCE of the tool from the seat''s view, never by an instruction in a prompt.'),
  ('rotate', '*',          '*',                   'R3',
   'Credential and secret rotation: a wrong move locks the estate out of itself.')
ON CONFLICT DO NOTHING;

-- ── SELF-ASSERTION ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM infra_hosts WHERE key IN ('delphi','helios','hostinger-wp');
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 newly-seeded hosts, found %', n; END IF;

  SELECT count(*) INTO n FROM infra_hosts WHERE key = 'delphi' AND env = 'staging';
  IF n <> 1 THEN RAISE EXCEPTION 'delphi must be staging (owner 2026-08-22)'; END IF;

  SELECT count(*) INTO n FROM infra_hosts WHERE key = 'helios' AND env = 'production';
  IF n <> 1 THEN RAISE EXCEPTION 'helios must be production (owner 2026-08-22)'; END IF;

  -- The fail-closed default must actually be R2, not R0. This is the single property a future
  -- refactor is most likely to invert, because "no rule matched" intuitively reads as "safe".
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_name = 'risk_policy' AND column_name = 'min_tier' AND column_default LIKE '%R2%';
  IF n <> 1 THEN RAISE EXCEPTION 'risk_policy.min_tier must DEFAULT to R2 (fail closed), not R0'; END IF;

  -- An invalid tier must be rejected outright.
  BEGIN
    INSERT INTO risk_policy (action, min_tier, rationale) VALUES ('probe','R9','invalid tier');
    RAISE EXCEPTION 'risk_policy min_tier CHECK did NOT fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
