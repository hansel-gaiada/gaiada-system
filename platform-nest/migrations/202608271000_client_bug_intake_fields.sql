-- 202608271000_client_bug_intake_fields.sql — bug-grade fields on the maintenance-intake spine.
-- Program: PROGRESS-CLIENT-QA.md, Phase A (A.1 + A.2). Extends webdev D-7 (0088); does not deviate
-- from it — every column here is additive and the D-7 lifecycle is untouched by THIS file (the
-- 'verified' status lands in Phase B, deliberately separate so the state-machine CHECK changes alone).
--
-- ── NUMBERING (migrations/README.md rule 5) ───────────────────────────────────────────────────────
-- Timestamp naming (the numeric series ended; see the 2026-08-25/26 files). `ls migrations | sort |
-- tail` at write time showed head = 202608261930_finance_eliminate_intercompany_reapply.sql.
-- Re-verified immediately before writing — no collision. Do NOT fill the orphaned 0058/0059/0070 gaps.
--
-- ── DEPT-AGNOSTIC COLUMN NAMES (owner decision, 2026-08-27) ───────────────────────────────────────
-- Scope was settled as "extend webdev_change_requests in place, generalize later". The binding half
-- of that decision is that NOTHING added here may be webdev-shaped: when SMM/SEO/Creative client work
-- gains an intake path, the migration must be a TABLE RENAME, not a column reshape. Hence
-- `affected_url` / `environment` / `seen_on_version` rather than site_url / preview_env / build_tag.
--
-- ── WHY THE severity CHECK IS `NOT VALID` (this is the load-bearing decision in this file) ────────
-- We want "a bug must carry a severity". We CANNOT get there with a backfill, because migrations run
-- as platform_owner, which is NOBYPASSRLS, against a FORCE-RLS table. An `UPDATE webdev_change_requests
-- SET severity='medium' WHERE kind='bug'` in this file runs with `app.current_tenant_ids` UNSET, so
-- the tenant_isolation policy matches ZERO rows and the statement reports success having changed
-- nothing (the 0050 trap; 0088's header calls it out as not-applicable there because that table was
-- brand new — here it very much applies, because the table is live and portal-written).
-- A silently-empty backfill followed by a VALIDATED check is the worst outcome: the ALTER would then
-- fail on pre-existing bug rows, or — if it passed — it would have passed for the wrong reason.
-- So: the constraint is added NOT VALID (enforced for every INSERT/UPDATE from now on, not evaluated
-- against history), and pre-existing rows are left honestly un-severitied rather than fake-backfilled.
-- Validate it later from the APPLICATION path (tenant GUC set), not from a migration:
--   ALTER TABLE webdev_change_requests VALIDATE CONSTRAINT wcr_bug_has_severity;
-- Tracked in PROGRESS-CLIENT-QA.md as part of A.7.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · BUG-GRADE COLUMNS
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- All nullable: a `content`/`design`/`feature` request has no reproduction steps, and NULL is the
-- honest value for them. Only `kind='bug'` is constrained, and only for severity (§3).
ALTER TABLE webdev_change_requests
  -- Triage ordering key. Deliberately a small closed vocabulary, not an integer: an agent proposing
  -- a triage decision must emit a value from a set, and a free integer invites drift between the
  -- portal form, the staff queue and the MCP tool (agentic-native criterion 2, deterministic contract).
  ADD COLUMN IF NOT EXISTS severity text,
  -- Structured repro, kept SEPARATE from `body`. `body` is the requester's narrative; this is the
  -- thing QA re-runs. Splitting them is what lets the verify step (Phase B) mean something specific.
  ADD COLUMN IF NOT EXISTS repro_steps text,
  -- Where it was seen: 'production' | 'staging' | 'preview' — free text on purpose (client sites are
  -- provisioned per-project and their environment names are not ours to close over).
  ADD COLUMN IF NOT EXISTS environment text,
  -- The build the reporter saw it on. For ERP-side reports this is /VERSION (`Alpha MM.mmm.bbbba`);
  -- for a client site it is whatever the provisioned site reports. Text, never parsed for ordering.
  ADD COLUMN IF NOT EXISTS seen_on_version text,
  -- The specific surface. Capped by the controller (not here) alongside TITLE_CAP/BODY_CAP.
  ADD COLUMN IF NOT EXISTS affected_url text;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · SOURCE GAINS 'ci' — the machine intake path
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- D-9's QA harness reports failures back; a failed run auto-files a bug (Phase D.1). That filing is
-- neither 'portal' (no client asked) nor 'internal' (no human logged it), and collapsing it into
-- 'internal' would make "who reported this?" unanswerable in the triage queue a month later — the
-- exact failure `wcr_portal_has_requester` exists to prevent on the portal side.
--
-- `wcr_portal_has_requester` is deliberately NOT touched: it reads
--   source <> 'portal' OR (client_id IS NOT NULL AND requested_by IS NOT NULL)
-- so 'ci' rows satisfy it vacuously and are permitted to carry no client and no requester. That is
-- correct — CI is not a person and must not borrow one's identity (principal-kinds: bots are `users`
-- rows where a bot genuinely acts, but a QA harness reporting a fact is not acting for anyone).
ALTER TABLE webdev_change_requests DROP CONSTRAINT IF EXISTS webdev_change_requests_source_check;
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT webdev_change_requests_source_check
  CHECK (source IN ('portal', 'internal', 'ci'));

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · CONSTRAINTS
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Closed severity vocabulary. Nullable-tolerant: non-bug kinds carry NULL.
ALTER TABLE webdev_change_requests DROP CONSTRAINT IF EXISTS wcr_severity_vocab;
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT wcr_severity_vocab
  CHECK (severity IS NULL OR severity IN ('critical', 'high', 'medium', 'low'));

-- "A TRIAGED bug carries a severity" — deliberately NOT "a bug carries a severity".
--
-- The first draft of this file required severity at INSERT. It was wrong on two counts, and the
-- existing suite caught it: 10 of 46 change-request tests went red (46/46 green with this file
-- pulled aside, so the regression was unambiguously this constraint, not pre-existing).
--   1. PRODUCT: the portal is this table's primary writer, and making a CLIENT self-assign severity
--      at intake is asking the reporter to trade off their own bug against everyone else's. Clients
--      rationally answer "critical". Severity is a TRIAGE output — in D-7 the PM disposes of the
--      request (§2.3), and that is the moment the value becomes meaningful.
--   2. STRUCTURAL: `wcr_route_matches_status` (0088) already establishes the house idiom — the
--      state machine is expressed as a CHECK over (status, field), not as controller discipline.
--      Severity is the same shape of fact as route: absent before triage, present after it.
--
-- So the rule mirrors that constraint's phrasing exactly. Pre-triage statuses ('new','declined')
-- may carry NULL; every post-triage bug must carry a severity.
--
-- Still NOT VALID — see the header. Live rows predate the column and a backfill CANNOT reach them
-- from a migration (NOBYPASSRLS + FORCE RLS ⇒ zero rows, silently). Enforced for all new writes.
ALTER TABLE webdev_change_requests DROP CONSTRAINT IF EXISTS wcr_bug_has_severity;
ALTER TABLE webdev_change_requests
  ADD CONSTRAINT wcr_bug_has_severity
  CHECK (kind <> 'bug' OR status IN ('new', 'declined') OR severity IS NOT NULL) NOT VALID;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · TRIAGE-QUEUE INDEX
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- The staff queue's new hot path: open bugs, worst first (A.6). Partial over the open statuses so it
-- stays small — mirrors ix_wcr_new's shape (0088:95). `severity` is not orderable as text in the sense
-- we want ('critical' < 'high' alphabetically is wrong), so ordering is resolved in the query with a
-- CASE; this index exists to narrow the row set, not to provide the order.
CREATE INDEX IF NOT EXISTS ix_wcr_open_bugs
  ON webdev_change_requests (tenant_id, severity)
  WHERE kind = 'bug' AND status IN ('new', 'triaged', 'in_progress') AND deleted_at IS NULL;

-- No RLS changes. The table keeps 0088's PLAIN CORE tenant wall (D-2a): the portal is still its
-- primary writer, and adding an app_module_allowed() clause here would make every portal read return
-- ZERO rows, silently — the precise failure D-2a exists to avoid.
