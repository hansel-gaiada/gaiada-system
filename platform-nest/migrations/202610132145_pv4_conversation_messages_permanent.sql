-- 202610132145_pv4_conversation_messages_permanent.sql — PV-4 / PV4-11: a conversation message is permanent.
-- Ruling: PV-D34 (owner, 2026-10-13): "conversation messages can never be edited or retracted. A message is permanent
-- from the moment it is posted; a correction is a new message. Replaces the built 15-minute window."
-- Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-11). Table: 202610122330_pv4_conversation_data_model.sql.
--
-- WHAT THIS ADDS
--   One function, conversation_messages_permanent_guard(), and two row triggers on conversation_messages:
--     trg_conversation_messages_no_update  BEFORE UPDATE  -> always refused
--     trg_conversation_messages_no_delete  BEFORE DELETE  -> refused unless the operator escape hatch below is on
--   plus COMMENT ON COLUMN for edited_at and retracted_at (unused since PV-D34).
--   The application no longer has an edit or retract route (PV4-11 removed all four), so this is the backstop that
--   keeps "never" true even if a future route, script or migration forgets the rule.
--
-- SQLSTATE: 'PD034' (PV-D34). A custom class: it collides with no standard Postgres code and no code the app maps.
--   The message text is 'conversation messages are permanent (PV-D34)'. A caller that must tell this refusal from any
--   other error keys on the SQLSTATE, not the text.
--
-- ── THE OPERATOR ESCAPE HATCH (deliberate, documented, NOT for application code) ──────────────────────────
-- A DELETE is allowed only inside a transaction that ran  SET LOCAL app.conversation_purge = 'on'  (or
-- set_config('app.conversation_purge', 'on', true)). It exists for two cases and no others:
--   * data erasure an operator has to perform by hand (a legal erasure order, a client off-boarded under contract), and
--   * test teardown of rows a test created.
-- NO APPLICATION CODE MAY SET IT. Nothing under platform-nest/src sets it today; a static test
-- (conversation-messages-permanent.test.ts) fails the build if any non-test source file ever names the setting.
-- The hatch opens DELETE only. UPDATE has no hatch at all: a message is never rewritten, by anyone, through this
-- trigger. (An operator who must redact the body of a message disables the trigger explicitly, as a superuser, and
-- records why; that is a visible, auditable act, which a session GUC is not.)
--
-- ── WHAT THE TRIGGER DOES NOT COVER (stated so nobody assumes it) ─────────────────────────────────────────
--   * A superuser can disable it (ALTER TABLE ... DISABLE TRIGGER). Same trust boundary as every guard trigger in this
--     schema (pv5_legacy_flag_guard, the contract immutability triggers).
--   * Created ENABLE (origin), not ENABLE ALWAYS, on purpose: a replication apply worker running with
--     session_replication_role = replica (the multi-site sync path, `origin_site`) must be able to apply an upstream row
--     as it is. Nothing in the app sets session_replication_role.
--   * TRUNCATE does not fire a row trigger. The runtime roles are granted SELECT/INSERT/UPDATE/DELETE only
--     (infra/db/init-cluster.sh default privileges), so they cannot TRUNCATE; the owner can, which is the owner's trust.
--   * Rows cascade-deleted from a parent: there is none. conversation_messages references its thread with NO ACTION
--     (fk_conv_messages_thread_tenant), so deleting a thread that still has messages already fails on the FK; and
--     nothing references conversation_messages with CASCADE (conversation_drafts.sent_message_id and
--     webdev_change_requests.source_message_id are plain references). Were a cascade ever added, this trigger would
--     refuse it unless the hatch is on.
--
-- ── EXISTING DATA ─────────────────────────────────────────────────────────────────────────────────────────
-- NO DML in this file: nothing is backfilled. A row that was edited or retracted under the old 15-minute window keeps
-- edited_at / retracted_at as written; the columns stay (no column drop, per the ruling). The read path still hides a
-- row with retracted_at set, so a message removed before PV-D34 does not reappear.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────────
-- Ship in the same release as the PV4-11 code that removed the routes (before that code, PATCH/DELETE on a message would
-- 500 against this trigger). Brief ShareRowExclusive lock on conversation_messages while the triggers are created.
-- Reverse: DROP TRIGGER trg_conversation_messages_no_delete ON conversation_messages;
--          DROP TRIGGER trg_conversation_messages_no_update ON conversation_messages;
--          DROP FUNCTION conversation_messages_permanent_guard();
-- No secrets; no company names or ids.

CREATE FUNCTION conversation_messages_permanent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The operator escape hatch (header). current_setting(.., true) is NULL when unset, and NULL = 'on' is not true.
    IF current_setting('app.conversation_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'conversation messages are permanent (PV-D34)'
    USING ERRCODE = 'PD034',
          HINT = 'A correction is a new message. Operator erasure of a row: SET LOCAL app.conversation_purge = ''on'' in the deleting transaction (see migration 202610132145).';
END;
$$;

CREATE TRIGGER trg_conversation_messages_no_update
  BEFORE UPDATE ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION conversation_messages_permanent_guard();

CREATE TRIGGER trg_conversation_messages_no_delete
  BEFORE DELETE ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION conversation_messages_permanent_guard();

COMMENT ON COLUMN conversation_messages.edited_at IS
  'UNUSED since PV-D34 (2026-10-13): messages are permanent, nothing sets this column. Kept so rows edited under the retired 15-minute window keep their value; no column drop.';
COMMENT ON COLUMN conversation_messages.retracted_at IS
  'UNUSED since PV-D34 (2026-10-13): messages are permanent, nothing sets this column. Kept so rows retracted under the retired 15-minute window keep their value (the read path still hides them); no column drop.';
COMMENT ON FUNCTION conversation_messages_permanent_guard() IS
  'PV-D34: refuses UPDATE of any conversation_messages row, and DELETE unless the transaction set app.conversation_purge = on (operator erasure / test teardown only; no application code may set it). SQLSTATE PD034.';

-- ── self-assertion: both triggers exist, are row-level BEFORE triggers of the right event, and are enabled ──────
-- pg_trigger.tgtype bits: 1 = ROW, 2 = BEFORE, 8 = DELETE, 16 = UPDATE. tgenabled 'O' = enabled (origin).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'conversation_messages'::regclass AND tgname = 'trg_conversation_messages_no_update'
                    AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 1 + 2 + 16
                    AND tgfoid = 'conversation_messages_permanent_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'PV4-11: trigger trg_conversation_messages_no_update is missing, disabled or of the wrong kind';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'conversation_messages'::regclass AND tgname = 'trg_conversation_messages_no_delete'
                    AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 1 + 2 + 8
                    AND tgfoid = 'conversation_messages_permanent_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'PV4-11: trigger trg_conversation_messages_no_delete is missing, disabled or of the wrong kind';
  END IF;
END $$;
