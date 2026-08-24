-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PK-01 follow-up (2) · classify Hermes principals by the MECHANISM, not by an email
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Supersedes the rule in 202608241520, which fixed `zedano@gaiada.com` by matching its EMAIL. That
-- worked and is applied, but it is the wrong key, and PK-01's own backfill says so in a comment on
-- the branch immediately above the one that failed here:
--
--     "Keyed on provider rather than an email pattern because the email is a seed convention
--      while the link is the mechanism."
--
-- ── THE ACTUAL ROOT CAUSE, WHICH IS NOT "SOMEONE FORGOT" ──────────────────────────────────────────
-- Zedano was not unclassifiable. It HAS an `identity_links` row — `provider = 'hermes'`. PK-01's
-- backfill reached `bot` only for an account with a MESSAGING identity (the WA/TG bot identities the
-- design doc lists) and no staff membership. `hermes` is neither of the providers that branch tests,
-- so the row fell through to the `employee` fallback — which PK-01 chose deliberately, because a
-- misfiled principal showing up in people surfaces is visible and gets corrected, whereas the
-- opposite default hides a real joiner from HR.
--
-- It did get corrected, but only because `seed:retire-placeholder-hr` reported 18 candidate HR files
-- where 17 were expected. That is a lucky catch, not a mechanism.
--
-- ── WHY THIS IS WORTH A SECOND MIGRATION RATHER THAN LEAVING THE EMAIL FIX ─────────────────────────
-- `docs/superpowers/plans/2026-08-22-hermes-*` provisions 14 personas beside the orchestrator. Every
-- one of them will carry a `hermes` identity link and hit the same branch, so an email-keyed fix
-- solves exactly one of fifteen and the other fourteen arrive silently as staff. Keying on the link
-- means the rule already describes them.
--
-- ⚠ WHAT THIS STILL DOES NOT DO. A migration runs once, so this classifies the rows that exist TODAY
-- (one). It is not a constraint and cannot be: `users.kind` has a NOT NULL DEFAULT 'employee', and
-- nothing in this repo creates Hermes principals — they are hand-provisioned on the agent side
-- (`hermes-config/`, `persona/`). The durable fix is to provision agent principals through a seed the
-- way `provision-roster` does for staff, so `kind` is set at creation. Tracked as agent-platform
-- work; deliberately not smuggled in here.
--
-- No RLS guard: `users` and `identity_links` carry no row security (202608201442 states this, and it
-- was re-checked). `company_memberships` DOES, which is why the membership half of the test below is
-- written as a NOT EXISTS against a table this migration only reads — see the note on it.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  changed integer;
BEGIN
  -- ⚠ THE MEMBERSHIP HALF IS DELIBERATELY OMITTED, unlike PK-01's original `bot` branch.
  --
  -- PK-01 required "a messaging identity AND no staff membership", the second half guarding against
  -- misfiling a HUMAN who merely linked a chat account. That guard does not transfer: a `hermes`
  -- link is not something a person acquires by connecting Telegram — it is minted for an agent. And
  -- reading `company_memberships` here would be actively wrong, because it is FORCE RLS and this
  -- migration runs as `platform_owner` (NOBYPASSRLS) with no tenant GUC set: the subquery would
  -- match ZERO rows, `NOT EXISTS` would be true for everyone, and the guard would silently pass
  -- while appearing to be enforced. That failure mode is exactly what `lint:migration-rls` exists to
  -- catch, and writing an unguarded read to make a condition "safer" is how it gets defeated.
  UPDATE users u
     SET kind = 'bot'
   WHERE u.kind <> 'bot'
     AND EXISTS (
       SELECT 1 FROM identity_links il
        WHERE il.user_id = u.id AND il.provider = 'hermes'
     );

  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'hermes principals reclassified to bot: % row(s)', changed;

  -- Idempotent by construction (`kind <> 'bot'`), so 0 is the expected result on a re-run and on
  -- every fresh test database. No assertion on the count: asserting >= 1 would make this migration
  -- fail on any database that has no Hermes principal yet, which is most of them.
END $$;
