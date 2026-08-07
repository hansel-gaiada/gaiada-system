-- Backfill: every existing assistant thread with `title IS NULL` reads "New chat" forever in the
-- sidebar (owner complaint, 2026-08-07). The client-side fix that shipped in alpha-01.024.0063a
-- (AssistantWorkspace.tsx's `handleSend`) only titles a thread on `isFirstMessage && !title`, and
-- EVERY existing thread already has messages, so `isFirstMessage` is always false for them — that
-- fix never touched a single pre-existing row. The real fix has two halves: (1) server-side
-- titling on send, now in `assistant.controller.ts`'s `sendMessage` (same transaction as the
-- first user message's INSERT — see src/modules/assistant/thread-title.ts), which only ever
-- covers messages sent AFTER that code lands; (2) THIS migration, which closes the gap for
-- everything sent before it.
--
-- ── NUMBERING (rule 5, migrations/README.md) ──────────────────────────────────────────────────────
-- Re-verified at authoring time: `ls migrations | sort | tail` showed the real head as
-- `0085_assistant_write_intents.sql` (T3b, landed 2026-08-06) with `0086` genuinely free — no
-- rebase needed. `0058`, `0059`, `0070` remain the permanently-orphaned reservation gaps from
-- other programs — not touched, not filled.
--
-- ── THE BACKFILL-RLS TRAP (this repo has been bitten by it once already — 0050/0051) ──────────────
-- Migrations run as `platform_owner` (MIGRATE_DATABASE_URL), which does NOT have BYPASSRLS
-- (db-topology-roles). `assistant_threads`/`assistant_messages` carry FORCE ROW LEVEL SECURITY
-- with the TWO-SIDED module wall from 0079: `tenant_id = ANY(app_current_tenants()) AND
-- app_module_allowed('assistant')`. Both GUCs (`app.current_tenant_ids` AND `app.scopes`) are
-- unset during a migration run, so WITHOUT setting both, every SELECT/UPDATE below would match
-- ZERO rows, commit happily, and this migration would report success having changed nothing —
-- the exact failure mode 0050 shipped with. Fixed here the same way 0051 fixed it: loop over
-- every tenant, `PERFORM set_config(...)` BOTH GUCs (SET LOCAL semantics, scoped to this
-- transaction) before touching either table, per-tenant.
--
-- ── THE DERIVATION ALGORITHM MUST STAY IN SYNC WITH THE APP-LAYER ONES ─────────────────────────────
-- This backfill re-implements, in PL/pgSQL, the SAME algorithm as
-- `platform-ui/src/lib/assistant.ts`'s `deriveThreadTitle` and
-- `platform-nest/src/modules/assistant/thread-title.ts`'s `deriveServerThreadTitle`: collapse
-- whitespace, cap at 60 chars, break on a word boundary only when that leaves more than 20 chars,
-- else hard-truncate (a pasted URL/token must not be chopped to almost nothing), return nothing
-- for empty input. It ALSO strips the ASST-22 page-context preamble
-- (`"[Context: <label> (<ref>)]\n\n"`) before deriving, exactly like `deriveServerThreadTitle` —
-- a thread whose first message was sent with a page pinned has that preamble baked into the
-- PERSISTED `content` (it is sent AND displayed as-is, never hidden), so deriving from the raw
-- persisted text without stripping it first would title every such thread with the same
-- "[Context: ..." boilerplate. A SQL migration cannot import a TS function, so this is a
-- best-effort byte-for-byte port, not a shared call — if either TS derivation ever changes, this
-- file is intentionally left as a historical one-shot (README rule 4: never edit an applied
-- migration) and does not need to be kept in lockstep after the fact.
--
-- ── IDEMPOTENT / SAFE TO RE-RUN LOGICALLY (though the runner never re-applies an already-ledgered
--    file) ────────────────────────────────────────────────────────────────────────────────────────
-- Every touched row is gated on `title IS NULL`; a thread already titled (manually renamed, or
-- already covered by the server-side fix above) is never revisited, and a thread with no user
-- message yet (created but never sent) is skipped — it correctly stays "New chat".

DO $$
DECLARE
  co RECORD;
  th RECORD;
  raw_content text;
  stripped text;
  collapsed text;
  cut text;
  rev_pos int;
  last_space_1idx int;
  boundary text;
  derived text;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    -- Both RLS walls for assistant_* (0079) — see header. Per-tenant, SET LOCAL semantics (true
    -- as the third arg), so nothing here leaks across iterations or outside this transaction.
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    PERFORM set_config('app.scopes', 'assistant', true);

    FOR th IN
      SELECT id FROM assistant_threads WHERE tenant_id = co.id AND title IS NULL
    LOOP
      SELECT content INTO raw_content
        FROM assistant_messages
        WHERE thread_id = th.id AND role = 'user'
        ORDER BY seq ASC
        LIMIT 1;

      IF raw_content IS NULL THEN
        CONTINUE; -- no user message yet -- correctly stays "New chat"
      END IF;

      -- Strip the ASST-22 page-context preamble first (see header) -- same pattern
      -- thread-title.ts's PAGE_CONTEXT_PREFIX_RE matches: "[Context: <anything up to the first
      -- ']'>]" followed by a blank line, anchored to the start of the message.
      stripped := regexp_replace(raw_content, '^\[Context: .*?\]\n\n', '');
      collapsed := btrim(regexp_replace(stripped, '\s+', ' ', 'g'));

      IF collapsed = '' THEN
        CONTINUE; -- blank (or preamble-only) first message -- stays untitled, same as
                  -- deriveThreadTitle/deriveServerThreadTitle returning null
      END IF;

      IF length(collapsed) <= 60 THEN
        derived := collapsed;
      ELSE
        cut := substring(collapsed FROM 1 FOR 60);
        -- lastIndexOf(" ") on a 0-indexed 60-char string, ported to 1-indexed SQL: rev_pos is the
        -- 1-indexed position of the LAST space counting from the end (0 if none); last_space_1idx
        -- converts that to the ordinary 1-indexed position from the start.
        rev_pos := position(' ' IN reverse(cut));
        IF rev_pos > 0 THEN
          last_space_1idx := length(cut) - rev_pos + 1;
        ELSE
          last_space_1idx := 0;
        END IF;
        -- JS: `lastSpace > 20` (0-indexed) <=> `last_space_1idx > 21` (1-indexed) here.
        IF last_space_1idx > 21 THEN
          boundary := left(cut, last_space_1idx - 1);
        ELSE
          boundary := cut;
        END IF;
        derived := rtrim(boundary) || '…';
      END IF;

      UPDATE assistant_threads SET title = derived WHERE id = th.id;
    END LOOP;
  END LOOP;
END $$;
