-- 202608271900_change_request_verification.sql — the QA verification half of the intake spine.
-- Program: PROGRESS-CLIENT-QA.md, Phase B (B.1 + B.2). Builds on 0088 (D-7) and
-- 202608271000_client_bug_intake_fields.sql.
--
-- ── NUMBERING (migrations/README.md rule 5) ───────────────────────────────────────────────────────
-- Timestamp naming. `ls migrations/*.sql | sort | tail` at write time showed head =
-- 202608271800_fix_webdev_permissions_ui_grantable.sql (199 files, several landed by concurrent
-- sessions during this workstream). 1900 is clear of all of them; re-verified immediately before
-- writing.
--
-- ── WHY 'verified' TRANSITIONS FROM 'in_progress', NOT FROM 'done' ────────────────────────────────
-- 0088's status vocabulary admits 'done', but a grep of platform-nest/src finds NOTHING that ever
-- writes it: the only occurrences are tests forging a status in a payload, plus unrelated tables
-- (hr_cases, pipeline stages). In practice a change request goes `new -> declined` or, via triage
-- convert, `new -> in_progress` — and then stays there forever, because closing it was always meant
-- to follow the linked pm_task / pipeline_run completing and that was never wired.
-- So building verification on top of 'done' would make it UNREACHABLE on live data. 'verified' is
-- therefore reachable from 'in_progress' as well as 'done'; the controller (B.3) owns which
-- transitions it offers, and this file only guarantees the shape of a verified row.
-- The dead 'done' state is left exactly as it is — wiring it is a separate concern with its own
-- owner decision, and quietly repurposing it here would hide the gap rather than record it.
-- Tracked in PROGRESS-CLIENT-QA.md.
--
-- ── WHY THESE CONSTRAINTS ARE VALIDATED, UNLIKE `wcr_bug_has_severity` ───────────────────────────
-- 202608271000 had to add its severity CHECK `NOT VALID`, because live rows predated the column and
-- a backfill cannot reach them from a migration (platform_owner is NOBYPASSRLS, the table is FORCE
-- RLS, so an UPDATE here matches zero rows and reports success).
-- That reasoning does NOT apply to this file, and the difference is worth stating so the next reader
-- does not cargo-cult `NOT VALID` onto every constraint in this table: the columns added below are
-- brand new and therefore NULL on every existing row, and no existing row can carry status
-- 'verified' because the value did not exist until this migration. Both constraints are thus
-- vacuously true for all history — there is nothing to backfill and nothing that could violate them.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · STATUS VOCABULARY GAINS 'verified'
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE webdev_change_requests DROP CONSTRAINT IF EXISTS webdev_change_requests_status_check;
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT webdev_change_requests_status_check
  CHECK (status IN ('new', 'triaged', 'in_progress', 'done', 'declined', 'verified'));

-- `wcr_route_matches_status` (0088) is deliberately NOT touched. It reads
--   (route IS NULL) = (status IN ('new','declined'))
-- and 'verified' is a POST-triage state, so it must carry a route — which the existing expression
-- already requires, with no edit. Restating it here would risk dropping a constraint another session
-- may have amended. Likewise `wcr_bug_has_severity` (202608271000) already obliges a verified bug to
-- carry a severity, since 'verified' is not in its ('new','declined') exemption set.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · WHO VERIFIED, WHEN, AND AGAINST WHAT BUILD
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE webdev_change_requests
  -- Plain users FK, matching `triaged_by`/`requested_by` (0088). A verifier may be a non-human
  -- principal — bots and automation ARE users rows on purpose — so nothing here assumes a person.
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  -- The build the fix was confirmed on. Text, never parsed for ordering, same as `seen_on_version`:
  -- for ERP-side work this is /VERSION (`Alpha MM.mmm.bbbba`), for a client site whatever that site
  -- reports. Pairing it with `seen_on_version` is the whole point — "broken in X, confirmed fixed in
  -- Y" is the claim a verification is actually making.
  ADD COLUMN IF NOT EXISTS verified_on_version text;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · THE STATE MACHINE STAYS STRUCTURAL
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Same idiom as `wcr_route_matches_status`: the relationship between a status and the fields that
-- status implies is a CHECK, not controller discipline. Attribution present exactly when verified —
-- this is what stops a "verified by nobody" row appearing in a report a month later, which is the
-- same failure `wcr_portal_has_requester` exists to prevent on the intake side.
-- `verified_on_version` is NOT included: a verifier who genuinely does not know the build should
-- record the verification honestly rather than be blocked, or invent a version to satisfy a CHECK.
ALTER TABLE webdev_change_requests DROP CONSTRAINT IF EXISTS wcr_verified_has_attribution;
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT wcr_verified_has_attribution
  CHECK ((verified_by IS NOT NULL AND verified_at IS NOT NULL) = (status = 'verified'));

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · INDEX — "what is waiting for QA?"
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- The queue B.3/B.4 read: converted work not yet attested. Partial, mirroring ix_wcr_new (0088:95)
-- and ix_wcr_open_bugs (202608271000 §4).
CREATE INDEX IF NOT EXISTS ix_wcr_awaiting_verification
  ON webdev_change_requests (tenant_id, updated_at)
  WHERE status IN ('in_progress', 'done') AND deleted_at IS NULL;

-- No RLS changes: the table keeps 0088's PLAIN CORE tenant wall (D-2a). The portal must be able to
-- READ a verified row (the client sees that their bug was confirmed fixed); who may WRITE one is a
-- Cerbos question, not an RLS one, and is tracked as B.5's adversarial case — a client must never be
-- able to verify their own bug.
