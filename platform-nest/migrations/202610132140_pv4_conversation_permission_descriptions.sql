-- 202610132140_pv4_conversation_permission_descriptions.sql — PV4-11 follow-through for owner ruling PV-D34
-- (2026-10-13: conversation messages are permanent; no edit, no retract).
--
-- 202610130120 seeded two permission descriptions that promise what PV-D34 removed: `core.conversation.manage`
-- ("... and retract a staff message") and `portal.converse` ("... edit or retract your own message"). Those texts are
-- shown where staff grant permissions, so they must not describe a power that no longer exists. That migration is
-- applied on live and is immutable (rule 4 in migrations/README.md), so the text is corrected here instead.
-- `permission-catalog.json` carries the same new wording (same change). Text only: no key, action, class, grant or
-- count moves, so no pin and no Cerbos change.

UPDATE permissions
   SET description = 'Close or reopen a client conversation thread and edit its subject. Messages are permanent (PV-D34): nothing retracts them.'
 WHERE key = 'core.conversation.manage';

UPDATE permissions
   SET description = 'Open a thread and post in the client conversation (any active contact; viewers included — posting is not signing). Messages are permanent once sent (PV-D34).'
 WHERE key = 'portal.converse';

DO $$
BEGIN
  IF (SELECT count(*) FROM permissions
       WHERE key IN ('core.conversation.manage', 'portal.converse')
         AND description ILIKE '%retract%' AND description NOT ILIKE '%nothing retracts them%') <> 0 THEN
    RAISE EXCEPTION '202610132140: a conversation permission description still offers edit or retract';
  END IF;
  IF (SELECT count(*) FROM permissions WHERE key IN ('core.conversation.manage', 'portal.converse')) <> 2 THEN
    RAISE EXCEPTION '202610132140: expected both conversation permission rows to exist';
  END IF;
END $$;
