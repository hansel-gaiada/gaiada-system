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
-- Widen-only, robust to the constraint's auto-generated name, and idempotent on re-run — the same
-- shape 0028 used to widen this table's `origin` CHECK for 'hr'.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'automation_approvals'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%status%'
     AND pg_get_constraintdef(con.oid) ILIKE '%pending%'
   LIMIT 1;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE automation_approvals
    ADD CONSTRAINT automation_approvals_status_check
    CHECK (status IN ('pending','approved','rejected','cancelled'));
END $$;

COMMENT ON COLUMN automation_approvals.status IS
  'pending | approved | rejected (a decider acted) | cancelled (the REQUESTER withdrew before anyone acted).';
