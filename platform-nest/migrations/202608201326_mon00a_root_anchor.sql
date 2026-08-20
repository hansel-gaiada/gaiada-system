-- MON-00a — the root anchor. Foundation for the cross-root boundary (docs/plans/2026-08-20-monitoring-gated-rulings.md §1).
--
-- ── WHY A COLUMN AND NOT A RECURSIVE CTE AT READ TIME ─────────────────────────────────────────────
-- The boundary has to be evaluable inside a Cerbos condition and inside an RLS predicate, on every
-- request. Walking `parent_company_id` upward per check is both slow and, worse, unavailable to the
-- PDP — which only sees the attributes we hand it. So the root is materialised, and a trigger keeps
-- it honest rather than a convention nobody remembers.
--
-- ── WHY THE USER ALSO NEEDS AN ANCHOR ────────────────────────────────────────────────────────────
-- The obvious idea — derive a principal's root from its memberships — CANNOT WORK for the exact
-- principal that leaks. `group_executive` is a GLOBAL grant and its holders have ZERO
-- `company_memberships` rows (that is the whole of IAM-TRAP4: `inTenant` is built from memberships
-- and is therefore permanently false for them). A membership-derived root would be the empty set for
-- the one role that can currently read every company in the database. Hence `users.home_company_id`.
--
-- NULL home_company_id means NO ANCHOR, AND THEREFORE DENIED. It does NOT mean "operator staff".
-- The first cut of this work made that mistake — null read as "the SaaS provider, allow everything" —
-- and the boundary test caught it immediately: a customer's `group_executive` has no memberships, so
-- the backfill leaves it null, so the very principal being fenced in would have been handed the whole
-- estate by the safe-looking default. Operator reach is an EXPLICIT global platform_admin grant
-- instead; absence of a value never grants anything.
--
-- ── THE ABORT CONDITION ──────────────────────────────────────────────────────────────────────────
-- If any user already holds memberships in two different roots, this migration RAISES instead of
-- guessing which root is home. On today's estate that cannot fire (one root exists), but shipping a
-- silent `LIMIT 1` here is how a person ends up anchored to the wrong holding — and an unordered
-- LIMIT 1 in a migration is already a documented trap in this repo.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. companies.root_company_id
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE companies ADD COLUMN IF NOT EXISTS root_company_id uuid REFERENCES companies(id);

COMMENT ON COLUMN companies.root_company_id IS
  'MON-00a. The company at the top of this company''s ancestry (a root points at itself). The unit of '
  'tenant isolation under SaaS: no request may combine data from two roots. Trigger-maintained — do '
  'not write it by hand.';

-- Resolve a company's root by walking parents. Depth-capped: a cycle introduced by a bad write must
-- surface as an error, not as an infinite loop inside a trigger holding a row lock.
CREATE OR REPLACE FUNCTION company_resolve_root(p_company_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  cur   uuid := p_company_id;
  nxt   uuid;
  hops  integer := 0;
BEGIN
  LOOP
    SELECT parent_company_id INTO nxt FROM companies WHERE id = cur;
    IF nxt IS NULL THEN
      RETURN cur;
    END IF;
    hops := hops + 1;
    IF hops > 32 THEN
      RAISE EXCEPTION 'company_resolve_root: ancestry deeper than 32 or cyclic at company %', cur;
    END IF;
    cur := nxt;
  END LOOP;
END $$;

-- Backfill. Ordered by depth so a parent's root is already set when its children are computed —
-- though company_resolve_root() does not depend on that, it keeps the result verifiable.
UPDATE companies SET root_company_id = company_resolve_root(id) WHERE root_company_id IS NULL;

-- Maintain it. Derive on insert; on update, a re-parent WITHIN the same root is fine (reorganising a
-- holding), but a re-parent that would MOVE A COMPANY BETWEEN ROOTS is refused: that is not an org
-- change, it is a transfer of ownership between two customers, and it must not happen as a side
-- effect of an UPDATE.
CREATE OR REPLACE FUNCTION companies_maintain_root()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  new_root uuid;
BEGIN
  new_root := CASE WHEN NEW.parent_company_id IS NULL THEN NEW.id
                   ELSE company_resolve_root(NEW.parent_company_id) END;

  IF TG_OP = 'UPDATE' AND OLD.root_company_id IS NOT NULL AND new_root <> OLD.root_company_id THEN
    RAISE EXCEPTION
      'cross-root re-parent refused: company % would move from root % to root %. Moving a company '
      'between holdings is an ownership transfer, not an org edit.',
      NEW.id, OLD.root_company_id, new_root;
  END IF;

  NEW.root_company_id := new_root;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_companies_maintain_root ON companies;
CREATE TRIGGER trg_companies_maintain_root
  BEFORE INSERT OR UPDATE OF parent_company_id, root_company_id ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_maintain_root();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. users.home_company_id
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_company_id uuid REFERENCES companies(id);

COMMENT ON COLUMN users.home_company_id IS
  'MON-00a. The company this person belongs to; their root is its root_company_id. NULL means NO '
  'ANCHOR and therefore DENIED — it does NOT mean operator staff. Operator reach is an explicit '
  'global platform_admin grant. An empty derived root set fails CLOSED, never open.';

DO $$
DECLARE
  spanning integer;
  offender text;
BEGIN
  -- Abort rather than guess. See the header: a silent pick here mis-anchors a real person.
  SELECT count(*), min(user_id::text) INTO spanning, offender
  FROM (
    SELECT m.user_id
    FROM company_memberships m
    JOIN companies c ON c.id = m.tenant_id
    WHERE m.deleted_at IS NULL AND m.status = 'active'
    GROUP BY m.user_id
    HAVING count(DISTINCT c.root_company_id) > 1
  ) s;

  IF spanning > 0 THEN
    RAISE EXCEPTION
      'MON-00a: % user(s) hold active memberships in more than one root (e.g. %). Home company '
      'cannot be derived unambiguously; resolve these before applying.', spanning, offender;
  END IF;
END $$;

-- Anchor everyone who has exactly one root's worth of memberships. Deliberately ordered so the pick
-- is deterministic even though the guard above proves there is only one root to pick from.
UPDATE users u
   SET home_company_id = sub.tenant_id
  FROM (
    SELECT DISTINCT ON (m.user_id) m.user_id, m.tenant_id
      FROM company_memberships m
     WHERE m.deleted_at IS NULL AND m.status = 'active'
     ORDER BY m.user_id, m.created_at, m.tenant_id
  ) sub
 WHERE u.id = sub.user_id AND u.home_company_id IS NULL;

-- Membership-less users (a global `group_executive` holder has NO membership rows at all — that is
-- the whole of IAM-TRAP4) get no anchor from the backfill above, and an unanchored principal is
-- DENIED by design. On a single-root estate that would be a pure regression for no safety gain:
-- there is exactly one root, so there is nothing to be ambiguous about. Anchor them to it.
--
-- With two or more roots this deliberately does NOTHING: guessing which customer an unanchored
-- person belongs to is precisely the decision a migration must not make silently. They stay denied
-- until someone sets home_company_id, which is the fail-closed direction.
DO $$
DECLARE
  n_roots integer;
  sole    uuid;
  fixed   integer;
BEGIN
  SELECT count(DISTINCT root_company_id) INTO n_roots FROM companies WHERE deleted_at IS NULL;
  IF n_roots = 1 THEN
    SELECT DISTINCT root_company_id INTO sole FROM companies WHERE deleted_at IS NULL;
    UPDATE users SET home_company_id = sole WHERE home_company_id IS NULL AND deleted_at IS NULL;
    GET DIAGNOSTICS fixed = ROW_COUNT;
    RAISE NOTICE 'MON-00a: single-root estate — anchored % previously unanchored user(s) to %', fixed, sole;
  ELSE
    RAISE NOTICE 'MON-00a: % roots present — unanchored users left DENIED until home_company_id is set explicitly', n_roots;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_companies_root ON companies (root_company_id);
CREATE INDEX IF NOT EXISTS ix_users_home_company ON users (home_company_id) WHERE home_company_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Self-check. Every assertion here is one whose failure would leave the boundary silently
--    unenforceable, which is worse than a failed migration.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  unset_roots  integer;
  bad_roots    integer;
  roots        integer;
BEGIN
  SELECT count(*) INTO unset_roots FROM companies WHERE root_company_id IS NULL AND deleted_at IS NULL;
  IF unset_roots > 0 THEN
    RAISE EXCEPTION 'MON-00a: % live company(ies) still have no root_company_id', unset_roots;
  END IF;

  -- A root must point at itself. If this is ever false the column has been hand-written.
  SELECT count(*) INTO bad_roots
  FROM companies WHERE parent_company_id IS NULL AND root_company_id <> id AND deleted_at IS NULL;
  IF bad_roots > 0 THEN
    RAISE EXCEPTION 'MON-00a: % root company(ies) do not point at themselves', bad_roots;
  END IF;

  SELECT count(DISTINCT root_company_id) INTO roots FROM companies WHERE deleted_at IS NULL;
  RAISE NOTICE 'MON-00a OK: % distinct root(s) anchored', roots;
END $$;
