-- M5-V3-h — the G5 DSR ledger learns about consented website-visitor profiles.
-- Design: docs/plans/2026-10-12-m5-phase5-design.md §4.7 (erasure), §8 row V3-h. Addendum:
-- legal/website-visitor-addendum.md §9.1 (visitor profile rows: by visitor id, consent id, or a lead's consent id).
-- Code: core/agency-privacy.* and modules/search/visitor-erase.ts. Builds on 202610121835 (the ledger) and
-- 202610131600 (the visitor tables; its HASH CONTRACT is reused here, hex-encoded).
--
-- WHAT THIS ADDS (DDL only: no INSERT/UPDATE/DELETE, so the RLS zero-row trap cannot bite):
--   1. agency_dsr_requests.visitor_id_hash / consent_id_hash — a rights request may now name the person by the
--      visitor id the privacy page shows them, or by their consent id. Stored ONLY as hex(sha256(lower(uuid text))),
--      which is exactly V3-d's tombstone hash hex-encoded: decode(visitor_id_hash,'hex') IS the tombstone id_hash,
--      so an erase run from the ledger's hashes alone (no plaintext held anywhere) can still tombstone. Content
--      binding (filed row vs the executing body) covers these two like email_hash / phone_hash.
--   2. dsr_has_subject is widened from "email or phone" to "any of the four hashes". It is DROPPED and ADDED in one
--      ALTER, but only after its CURRENT definition has been read from the catalog and found to be exactly the
--      two-hash predicate 202610121835 wrote (a constraint changed since then is never silently re-declared:
--      the a-drop-add-on-a-shared-check trap). The new definition is asserted after the ADD.
--   3. The erase's evidence, as counts and one status word (never an id):
--        profile_count, profile_event_count   consented profiles deleted, and their events (cascade)
--        tombstone_count                      tombstone rows written or upgraded to reason 'erase'
--        collector_forget                     what happened at the collector (sumopod), for an executed erase:
--            'not_needed'     no visitor or consent id was in scope, or the tenant has no collector website
--            'delivered'      forget mode:"erase" was accepted for every id and every website
--            'queued'         the collector was unreachable or refused: the ERP side committed anyway and the
--                             forget sits in the visitor jobs' retry queue. NEVER reported as delivered.
--            'not_configured' the INSIGHTS_* variables are unset in this process: nothing was sent
--            'id_not_held'    some id was known only by its hash (a run-by-approval whose id the ERP no longer
--                             holds): tombstoned by hash; the collector is told when ingest next sees its events
--        collector_forget_calls, collector_deleted_events   what the collector answered
--   4. CONSTRAINT dsr_collector_forget_on_erase: an executed erase row MUST carry collector_forget, and no other row
--      may. Written as an equality of two expressions that can never be NULL (phase and kind are NOT NULL; IS NOT
--      NULL is never NULL), so NULL cannot slip through the way `a IS NULL OR …` would. Added NOT VALID: the
--      ledger is append-only (UPDATE raises), so the executed erase rows written before this migration cannot
--      be back-filled and stay as they are; NOT VALID skips them and enforces the rule on EVERY new row.
--   5. Two partial indexes, as ix_agency_dsr_email / ix_agency_dsr_phone.
--
-- NOT DONE HERE: no change to RLS, grants, the append-only triggers or any other constraint. Existing rows keep
-- every value (new columns are NULL or 0 by constant default: no table rewrite).
-- To undo: DROP the two indexes and dsr_collector_forget_on_erase; re-add dsr_has_subject as the two-hash
-- predicate (only if no row has a visitor/consent hash alone); DROP the eight columns.
-- ROLLOUT: additive. The new code writes the new columns; old code ignores them. Apply before the code ships.

-- ─────────────────────────────────────────────────────────────── 1 + 3. columns
ALTER TABLE agency_dsr_requests
  ADD COLUMN visitor_id_hash          text CHECK (visitor_id_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN consent_id_hash          text CHECK (consent_id_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN profile_count            integer NOT NULL DEFAULT 0 CHECK (profile_count >= 0),
  ADD COLUMN profile_event_count      integer NOT NULL DEFAULT 0 CHECK (profile_event_count >= 0),
  ADD COLUMN tombstone_count          integer NOT NULL DEFAULT 0 CHECK (tombstone_count >= 0),
  ADD COLUMN collector_forget         text CHECK (collector_forget IN ('not_needed','delivered','queued','not_configured','id_not_held')),
  ADD COLUMN collector_forget_calls   integer NOT NULL DEFAULT 0 CHECK (collector_forget_calls >= 0),
  ADD COLUMN collector_deleted_events integer NOT NULL DEFAULT 0 CHECK (collector_deleted_events >= 0);
-- (The two hash CHECKs pass on NULL on purpose: a NULL hash means "not given". The format CHECK applies when set.)

-- ─────────────────────────────────────────────────────────────── 2. dsr_has_subject, read before it is replaced
DO $$
DECLARE
  live_def text;
  norm text;
  n int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'agency_dsr_requests'::regclass AND contype = 'c' AND conname = 'dsr_has_subject';
  IF n <> 1 THEN
    RAISE EXCEPTION 'M5-V3-h: expected exactly one CHECK dsr_has_subject on agency_dsr_requests, found %', n;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO live_def FROM pg_constraint
   WHERE conrelid = 'agency_dsr_requests'::regclass AND conname = 'dsr_has_subject';
  -- Compare without parentheses, whitespace or case, so either rendering Postgres chooses matches.
  norm := lower(regexp_replace(live_def, '[\s()]', '', 'g'));
  IF norm <> 'checkemail_hashisnotnullorphone_hashisnotnull' THEN
    RAISE EXCEPTION 'M5-V3-h: dsr_has_subject is not the two-hash predicate 202610121835 wrote (it is now: %) - '
      'refusing to re-declare a constraint that changed since; inspect it and adapt this migration.', live_def;
  END IF;
END $$;

ALTER TABLE agency_dsr_requests
  DROP CONSTRAINT dsr_has_subject,
  ADD CONSTRAINT dsr_has_subject CHECK (
    email_hash IS NOT NULL OR phone_hash IS NOT NULL OR visitor_id_hash IS NOT NULL OR consent_id_hash IS NOT NULL
  );

-- ─────────────────────────────────────────────────────────────── 4. an executed erase records the collector outcome
ALTER TABLE agency_dsr_requests
  ADD CONSTRAINT dsr_collector_forget_on_erase CHECK (
    (collector_forget IS NOT NULL) = (phase = 'executed' AND kind = 'erase')
  ) NOT VALID;

-- ─────────────────────────────────────────────────────────────── 5. indexes
CREATE INDEX ix_agency_dsr_visitor ON agency_dsr_requests (tenant_id, visitor_id_hash) WHERE visitor_id_hash IS NOT NULL;
CREATE INDEX ix_agency_dsr_consent ON agency_dsr_requests (tenant_id, consent_id_hash) WHERE consent_id_hash IS NOT NULL;

COMMENT ON COLUMN agency_dsr_requests.visitor_id_hash IS
  'M5-V3-h: hex(sha256(lower(visitor id uuid text))) - V3-d''s tombstone hash, hex-encoded. Never the id.';
COMMENT ON COLUMN agency_dsr_requests.consent_id_hash IS
  'M5-V3-h: hex(sha256(lower(consent id uuid text))) - V3-d''s tombstone hash, hex-encoded. Never the id.';
COMMENT ON COLUMN agency_dsr_requests.collector_forget IS
  'M5-V3-h: for an executed erase, what the collector was told: not_needed | delivered | queued (unreachable; retried by the visitor jobs, never reported as delivered) | not_configured | id_not_held. NULL on every other row.';

-- ─────────────────────────────────────────────────────────────── self-checks (catalog reads only: no RLS)
DO $$
DECLARE
  def text;
  n int;
  validated boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'agency_dsr_requests'::regclass AND conname = 'dsr_has_subject';
  IF def IS NULL
     OR lower(regexp_replace(def, '[\s()]', '', 'g')) <>
        'checkemail_hashisnotnullorphone_hashisnotnullorvisitor_id_hashisnotnullorconsent_id_hashisnotnull' THEN
    RAISE EXCEPTION 'M5-V3-h: dsr_has_subject is not the four-hash predicate after the ADD: %', def;
  END IF;

  SELECT convalidated INTO validated FROM pg_constraint
   WHERE conrelid = 'agency_dsr_requests'::regclass AND conname = 'dsr_collector_forget_on_erase';
  IF validated IS NULL THEN RAISE EXCEPTION 'M5-V3-h: dsr_collector_forget_on_erase is missing'; END IF;
  IF validated THEN RAISE EXCEPTION 'M5-V3-h: dsr_collector_forget_on_erase must be NOT VALID (older executed erase rows cannot be back-filled)'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'agency_dsr_requests'
     AND column_name IN ('visitor_id_hash','consent_id_hash','profile_count','profile_event_count','tombstone_count',
                         'collector_forget','collector_forget_calls','collector_deleted_events');
  IF n <> 8 THEN RAISE EXCEPTION 'M5-V3-h: expected 8 new columns on agency_dsr_requests, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema() AND tablename = 'agency_dsr_requests'
     AND indexname IN ('ix_agency_dsr_visitor','ix_agency_dsr_consent');
  IF n <> 2 THEN RAISE EXCEPTION 'M5-V3-h: expected the 2 new partial indexes, found %', n; END IF;

  -- The ledger must still be append-only and RLS-forced (nothing here may have touched it).
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'agency_dsr_requests'::regclass AND NOT tgisinternal
     AND tgname IN ('trg_agency_dsr_requests_no_update','trg_agency_dsr_requests_no_delete');
  IF n <> 2 THEN RAISE EXCEPTION 'M5-V3-h: agency_dsr_requests lost its append-only triggers (found %)', n; END IF;
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = 'agency_dsr_requests'::regclass AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN RAISE EXCEPTION 'M5-V3-h: agency_dsr_requests must keep RLS enabled and forced'; END IF;
END $$;
