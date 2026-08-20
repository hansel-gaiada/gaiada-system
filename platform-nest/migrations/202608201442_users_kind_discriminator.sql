-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PK-01 · `users.kind` — the principal discriminator
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Owner-approved target model, `docs/superpowers/specs/2026-08-03-principal-kinds-design.md`.
--
-- WHY A DISCRIMINATOR EXISTS AT ALL. Authorization here is defined over PRINCIPALS, and the only
-- route to being authorized is `OBO envelope -> identity_links -> users -> user_roles -> Cerbos`. A
-- workflow that is not a `users` row lands ANONYMOUS and Cerbos denies it — proven live 2026-08-03
-- when five unseeded `wf:reports-*` accounts made every reports CRON fail `403 cerbos denied`. One
-- authz substrate, not two. The unavoidable cost is that "principal" and "person" became different
-- sets with nothing in the schema to tell them apart, and on 2026-08-03 HR reported 36 people when
-- 19 were people and 17 were n8n service accounts.
--
-- The 2026-08-03 interim fix reused `company_memberships.kind ('employee','service')`. That column
-- answers a DIFFERENT question — *why is this account in this company* — and the two axes are
-- genuinely orthogonal: a served-company HR manager is a human whose membership is `kind='service'`.
-- Overloading it cannot express `bot` vs `automation` at all, which is precisely the distinction the
-- agent work now needs. `company_memberships.kind` is left completely alone here (the shared-service
-- reconciler depends on it) and no reader is repointed in this migration — see the tail comment.
--
-- WHY FOUR KINDS, AND WHY `bot` IS NOT `automation`. An n8n workflow is a fixed, reviewable script
-- whose tool allow-list is pinned in the MCP hub. A Hermes persona is a model-driven agent whose next
-- action is not enumerable in advance. Different budget attribution, different audit expectation,
-- different assurance floor — collapsing them discards the distinction exactly where it matters, and
-- `mcp-hub`'s impact gate already had to be split along this same seam once (see PERMISSION-CONTRACT
-- §15, where keying it on `provider = 'n8n'` left every agent-driven high-impact write unattended).

ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'employee'
    CHECK (kind IN ('employee', 'client', 'automation', 'bot'));

-- `DEFAULT 'employee'` is the safe direction on purpose: a new row of an unclassified kind shows up
-- in people surfaces, which is VISIBLE and gets corrected. The opposite default would silently hide
-- a real joiner from HR, and a person missing from a headcount is a bug nobody reports.

COMMENT ON COLUMN users.kind IS
  'PK-01. What this ACCOUNT is: employee|client|automation|bot. Orthogonal to '
  'company_memberships.kind, which is why the account is in a given company (employee|service) — a '
  'served-company HR manager is users.kind=employee with membership kind=service. `bot` is distinct '
  'from `automation` deliberately: a pinned n8n workflow is enumerable in advance, a model-driven '
  'persona is not, so they carry different audit and assurance expectations.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Backfill — from EVIDENCE ALREADY IN THE DATABASE, never from a guess
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ THE ZERO-ROW TRAP IS LIVE IN THIS BLOCK. Migrations run as `platform_owner`, which is
-- NOBYPASSRLS. `users` and `identity_links` carry no RLS, but `company_memberships`,
-- `client_contacts` and `clients` are all FORCE ROW LEVEL SECURITY behind
-- `tenant_id = ANY(app_current_tenants())`. With the GUC unset that function returns NULL, every
-- read matches ZERO rows, and **no error is raised** — the classification would silently fall
-- through to 'employee' for every account and the migration would still report success. This is the
-- exact failure 0050 shipped and 0051 had to repair.
--
-- So the GUC is set to EVERY company id for the duration of this block. That is sound here because
-- the question is deliberately estate-wide ("does this account hold ANY employee membership
-- anywhere?"), not per-tenant. `set_config(..., true)` keeps it scoped to this transaction.
DO $$
DECLARE
  all_tenants text;
  n_automation integer;
  n_bot integer;
  n_client integer;
  n_employee integer;
  n_review integer;
BEGIN
  SELECT string_agg(id::text, ',') INTO all_tenants FROM companies;

  -- A fresh database has no companies at all. Guarded rather than assumed: string_agg over zero rows
  -- is NULL, and set_config(NULL) would leave the GUC unset — re-arming the very trap above.
  IF all_tenants IS NULL THEN
    RAISE NOTICE 'PK-01: no companies present (fresh DB); every user stays kind=employee by default';
  ELSE
    PERFORM set_config('app.current_tenant_ids', all_tenants, true);
  END IF;

  -- ── ONE statement, a TOTAL function of the evidence ────────────────────────────────────────────
  -- Written as a single CASE rather than four sequential `UPDATE ... WHERE kind <> ...` statements,
  -- and that shape is the point rather than a style preference.
  --
  -- ⚠ THE SEQUENTIAL VERSION COULD NOT CORRECT A WRONG VALUE. Each statement only ever assigned
  -- TOWARD a non-employee kind, so nothing could ever move a row BACK. Found by this migration's own
  -- negative control (`users-kind-discriminator.db.test.ts`): after a deliberately GUC-blinded run
  -- classified a staff member as `bot`, re-running the real block left them a `bot` forever, because
  -- no rule in it can say "and otherwise you are an employee". Since step 3 of the design repoints
  -- every people-shaped reader onto this column, that stuck value is a staff member permanently
  -- missing from HR with nothing to repair it.
  --
  -- A single CASE makes the classification a total function of the evidence: every run recomputes
  -- every row from scratch, so a wrong value self-heals and the statement is safe to re-run. It also
  -- makes PRECEDENCE explicit instead of emergent from statement order:
  --
  --   automation first — an n8n link is unambiguous mechanism, not a hint.
  --   client before bot — a portal contact who also enrolled WhatsApp is a CLIENT; reading it the
  --                       other way would hide them from client surfaces to call them a bot.
  --   bot needs BOTH halves — a messaging identity AND no staff membership (see below).
  --   employee is the fallback, which is the safe direction (visible, therefore correctable).
  UPDATE users u SET kind = CASE
    -- `identity_links` is the authoritative statement that this account authenticates as a workflow;
    -- the AuthGuard resolves exactly this row to mint the principal. Keyed on provider rather than an
    -- email pattern because the email is a seed convention while the link is the mechanism.
    WHEN EXISTS (SELECT 1 FROM identity_links il WHERE il.user_id = u.id AND il.provider = 'n8n')
      THEN 'automation'

    -- ⚠ The design doc (2026-08-03) says to key `client` on `clients.portal_user_id`. That is now
    -- STALE: migration 0072 replaced it with `client_contacts` and records in its own header that
    -- portal_user_id "is written ONLY in testing/fixtures.ts and is NULL for every real client
    -- (verified on gda-aicenter)". Keying on the retired column alone would classify zero real rows
    -- while looking like it worked. Both are read — client_contacts as the real source,
    -- portal_user_id so fixture-built databases classify the same way production does.
    WHEN EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.user_id = u.id AND cc.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM clients c WHERE c.portal_user_id = u.id)
      THEN 'client'

    -- The second half of this rule is load-bearing. A real employee who enrolled WhatsApp for
    -- notifications has byte-identical `identity_links` to a bot identity, so without the membership
    -- guard this rule reclassifies staff as bots and drops them out of every people surface — a
    -- person lost from HR because of a notification preference. Checked against
    -- `company_memberships.kind = 'employee'` (the interim discriminator, still correct for this one
    -- question), which is exactly why the GUC above is not optional.
    WHEN EXISTS (
           SELECT 1 FROM identity_links il
           WHERE il.user_id = u.id AND il.provider IN ('whatsapp', 'telegram')
         )
         AND NOT EXISTS (
           SELECT 1 FROM company_memberships cm
           WHERE cm.user_id = u.id AND cm.kind = 'employee' AND cm.deleted_at IS NULL
         )
      THEN 'bot'

    ELSE 'employee'
  END;

  -- Reported, not silently assumed, so the numbers can be checked against the estate rather than
  -- trusted. (Live at time of writing, 2026-08-20: 53 active users — 17 n8n, 2 messaging-linked,
  -- 25 seeded `.test`, and exactly ONE real SSO human.)
  SELECT count(*) FILTER (WHERE kind = 'automation'),
         count(*) FILTER (WHERE kind = 'bot'),
         count(*) FILTER (WHERE kind = 'client'),
         count(*) FILTER (WHERE kind = 'employee'),
         count(*) FILTER (WHERE kind = 'employee' AND idp_subject IS NULL AND email NOT LIKE '%.test')
    INTO n_automation, n_bot, n_client, n_employee, n_review
  FROM users WHERE deleted_at IS NULL;

  RAISE NOTICE 'PK-01 backfill: automation=%, bot=%, client=%, employee=% (of which % have no idp_subject and are not seeded .test accounts — review those)',
    n_automation, n_bot, n_client, n_employee, n_review;
END $$;

-- Partial index only where a kind filter is actually selective. Every people-shaped read becomes
-- `kind = 'employee'`, which is the majority of the table, so a plain btree on `kind` would rarely be
-- chosen; the useful lookup is "the non-human accounts", which is the small side.
CREATE INDEX users_kind_non_employee_idx ON users (kind) WHERE kind <> 'employee';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- DELIBERATELY NOT IN THIS MIGRATION
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Step 3 of the design sketch — repointing every people-shaped reader from the interim
-- `company_memberships.kind='service'` filter onto `users.kind='employee'` — is NOT done here, and
-- that is a scope decision rather than an omission. The surfaces involved (people directory, HR
-- headcount and directory, assignee pickers for tasks/projects/onboarding/appraisals, org-structure
-- person nodes, `Me.serviceScopes` consumers, every "PEOPLE" count) each currently trust membership
-- alone, and flipping them in the same change that introduces the column would make a bad backfill
-- and a bad reader indistinguishable from one another. The column ships and is proven first; the
-- readers move next, against a discriminator whose values have already been checked.
