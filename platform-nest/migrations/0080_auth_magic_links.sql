-- 0080_auth_magic_links.sql — MAIL-10 (design §9; M8/M11 locked).
--
-- Low-risk convenience login via single-use, hashed magic-link tokens. Gated OFF by default
-- (MAIL_MAGIC_LINKS_ENABLED=0, config.ts/compose) — real-user enablement is staging §15 R5, NOT
-- this ticket.
--
-- ── WHY THIS TABLE HAS NO `tenant_id` (a deliberate choice, re-verify before copying this file) ──
-- A magic link authenticates AS A USER, before any tenant is selected — exactly the same shape as
-- mail_log's own NULL-tenant auth-mail rows (design §6.1/F2: "auth mail has no tenant"). Rather
-- than invent a tenant attribution for an event that has none, this table joins `users` /
-- `identity_links` in the GLOBAL, no-RLS class (accessed via `withGlobal`, src/db/index.ts) — NOT
-- the `app.mail_context`-GUC-gated class the three 0077 mail_* tables use, because that GUC
-- answers "did the caller opt into MAIL context", a different security boundary than "did the
-- caller opt into AUTH-TOKEN context"; reusing it here would blur the two.
--
-- Because this table carries NO `tenant_id` column, `src/db/rls.test.ts`'s estate-wide "every
-- TENANT-SCOPED table has FORCE RLS" invariant does not select it at all (that test's query joins
-- `information_schema.columns` on `column_name = 'tenant_id'`) — verified by running the suite
-- unmodified after this migration (see MAIL-10's report). If a future change adds a `tenant_id`
-- column here, it MUST also add FORCE ROW LEVEL SECURITY + a GUC-gated policy in the same change,
-- mirroring `0015_site_subscriptions_rls.sql` — do not repeat MAIL-04's original mail_log mistake
-- (shipped with a `tenant_id` column and no RLS at all, retrofitted by MAIL-22).
--
-- STORES ONLY A HASH — never a usable token. `token_hash` is sha256(rawToken) hex; the raw token
-- lives only in-process at mint time and is NEVER written to any row anywhere, including
-- `mail_log.payload` (see src/mail/magic-link/service.ts's header for why magic-link mail cannot
-- ride the normal enqueue-then-re-render-from-payload pipeline approval mail uses).
--
-- Zero backfill DML (freshly created, no pre-existing rows) — nothing for the 0052+ CI
-- backfill/RLS lint to flag.
CREATE TABLE auth_magic_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  email text NOT NULL,               -- snapshot of the address the link was issued for (audit
                                      -- trail; parity with client_invites' equivalent column)
  token_hash text NOT NULL UNIQUE,    -- sha256(rawToken) hex — the ONLY form ever persisted
  requested_ip text,
  consumed_ip text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,           -- NULL = unconsumed; set exactly once by the atomic consume
  created_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL
);
CREATE INDEX auth_magic_links_user_idx ON auth_magic_links (user_id, created_at);
-- Housekeeping only (mirrors client_invites' pruneExpiredInvites): the consume predicate already
-- refuses expired/consumed rows on its own; this index just makes a future prune sweep cheap.
CREATE INDEX auth_magic_links_expiry_idx ON auth_magic_links (expires_at) WHERE consumed_at IS NULL;
