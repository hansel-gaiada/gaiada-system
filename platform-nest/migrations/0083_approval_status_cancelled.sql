-- 0083_approval_status_cancelled.sql — `cancelled` becomes a legal automation_approvals status.
--
-- 0014 defined `CHECK (status IN ('pending','approved','rejected'))`. That covers what a DECIDER can
-- do, but not what a REQUESTER can do: withdraw. Employee-portal wave E hit this immediately — an
-- employee withdrawing their own pending loan request must also retire the approval sitting in a
-- decider's inbox, and writing 'cancelled' there violated the constraint, surfacing as a 500 on an
-- otherwise correct code path.
--
-- 'rejected' would have been the zero-migration workaround and it is wrong: it records that someone
-- with authority refused the request, when in fact nobody ever looked at it. That distinction is the
-- whole audit value of the field.
--
-- ⚠ This also exposes an EXISTING gap left alone here on purpose. `hr.controller.ts`'s
-- cancelLeave() updates hr_leave_requests but never touches its paired approval, so every withdrawn
-- leave request has left a permanently-'pending' row in the approvals inbox since 0028. This
-- migration makes the fix POSSIBLE (a one-line UPDATE in cancelLeave, mirroring
-- LoansController.cancelLoan) but does not apply it: leave is outside wave E's scope, and silently
-- changing another feature's write path is how unrelated regressions arrive. Backfilling the stale
-- rows is likewise deliberately not attempted — nothing distinguishes "withdrawn" from "still
-- genuinely awaiting a decision" in the existing data, so a sweep would have to guess.
--
-- Widen-only, robust to the constraint's auto-generated name, and idempotent on re-run.
--
-- ⚠ IDENTIFIED BY COLUMN SET, NOT BY SUBSTRING. The first version of this migration found the
-- constraint with `pg_get_constraintdef(oid) ILIKE '%status%' AND ILIKE '%pending%' LIMIT 1`, copying
-- 0028's shape for the `origin` CHECK. That matches TWO constraints on this table, because 0078's
--     CHECK (execution_status IN ('not_applicable','pending','executing',...))
-- contains both substrings — "status" as a tail of "execution_status", and "pending" outright. With
-- no ORDER BY, `LIMIT 1` picks nondeterministically: it chose the right one on a freshly-migrated
-- test database (so the local suite went green) and the WRONG one on the live box, which then failed
-- the deploy with `constraint "automation_approvals_status_check" already exists` — it had dropped
-- the execution_status constraint and gone on to collide with the untouched status one. The deploy
-- rolled back and migrations are transactional, so nothing was damaged, but the near-miss is the
-- point: an unordered LIMIT 1 in a migration is a coin flip that can land differently per database.
--
-- Matching on `conkey` (the exact single column `status`) cannot be fooled that way, and the
-- DROP ... IF EXISTS by canonical name makes a re-run and a name collision the same harmless case.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'automation_approvals'::regclass
     AND con.contype = 'c'
   GROUP BY con.conname
     -- `attname` is `name`, not `text`, so the cast is required — `name[] = text[]` has no operator.
     -- ORDER BY inside the aggregate keeps the comparison stable if this is ever widened to a
     -- multi-column check.
  HAVING array_agg(att.attname::text ORDER BY att.attname::text) = ARRAY['status']::text[];

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  END IF;
  -- Covers the re-run case and the name collision the first attempt hit.
  ALTER TABLE automation_approvals DROP CONSTRAINT IF EXISTS automation_approvals_status_check;

  ALTER TABLE automation_approvals
    ADD CONSTRAINT automation_approvals_status_check
    CHECK (status IN ('pending','approved','rejected','cancelled'));
END $$;

COMMENT ON COLUMN automation_approvals.status IS
  'pending | approved | rejected (a decider acted) | cancelled (the REQUESTER withdrew before anyone acted).';
