-- IAM-GAP-02 — the owner's correction to IAM-GAP-01's invoice approval design, plus a new
-- revision-tracking requirement:
--   (1) "approval is based on managers related. and superadmin and company admin will be able to
--       do that too due to the nature of account specification." — CONFIRMS the approver set
--       (company_admin/manager/platform_admin/group_executive); no schema change needed for this
--       part (see cerbos/policies/resource_invoice.yaml's own IAM-GAP-02 comment on the `approve`
--       ALLOW rule for the full "related" interpretation and why it resolves to same-company
--       `manager`, stated plainly rather than assumed).
--   (2) closes IAM-GAP-01's filed self-approval hole (report §4.5/§12.2): platform_admin/
--       group_executive's PRE-EXISTING wildcard sat above the maker/checker rule with no
--       condition, so either could approve an invoice it created itself. Closed with a NEW
--       EFFECT_DENY rule in resource_invoice.yaml — no schema change; that rule alone is the fix.
--   (3) "draft need to track the maker and the last person who make changes and the changes
--       itself. so we can have proper version control and able to identify and have forensic
--       capabilities." — THIS is the schema change: `invoices.updated_by` + a dedicated
--       `invoice_revisions` table, snapshot-based (see that table's own header for why snapshot,
--       not diff), wired into every write path (billing.controller.ts's create/setStatus/approve,
--       AND contracts.controller.ts's decidePayment() — the one invoice-status writer that lives
--       outside the billing module entirely).
--
-- Companion Cerbos: cerbos/policies/resource_invoice.yaml (new EFFECT_DENY `approve` rule; the
-- `approve` ALLOW rule's own reach is UNCHANGED by this migration — no new action, no new
-- catalog key, no role_permissions change; the DENY rule needs no catalog entry — a restriction
-- has nothing to grant). Companion handlers: src/modules/billing/invoice-revisions.ts (new,
-- shared snapshot/record helpers), src/modules/billing/billing.controller.ts,
-- src/core/contracts.controller.ts. Report: docs/superpowers/plans/2026-08-13-iam-gap-02-report.md.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- 0108 reserved by creating this file; docs/MAP.md's generated head at the time was 0107.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 · invoices.updated_by — "the last person who made changes"
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Parallel to `created_by`/`approved_by`. Written by every write path from this point forward
-- (see the three handler files above). Backfilled below (PART 4) for existing rows ONLY where a
-- non-fabricated answer exists.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 · invoice_revisions — "the changes themselves", so a row's history can be reconstructed
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- SNAPSHOT, not diff (see src/modules/billing/invoice-revisions.ts's header for the full
-- justification — repeated here because a migration file is read independently of the TS source):
-- forensics needs to answer "what did this look like before that edit" for ANY single edit in
-- isolation. A diff-only design requires replaying every prior revision in order to reconstruct
-- state at any point, so ONE missing or corrupt row breaks reconstruction for every edit after it.
-- A full before/after snapshot per mutation is self-contained: any one row answers both "before"
-- and "after" with no dependency on any other row. `changed_fields` is a derived, human-skimmable
-- convenience (computed by the application from the two snapshots) — it is NEVER authoritative and
-- is never used to reconstruct state, only to skim "what moved" without a manual JSON diff.
--
-- `before_snapshot` is NULL exactly once per invoice (the `created` revision — nothing existed
-- before it existed). `after_snapshot` is NEVER NULL (every mutation, including creation, produces
-- a resulting state). `actor_id` is nullable ONLY for the one-time `baseline_pre_revision_tracking`
-- marker this migration inserts for rows that predate this table (PART 5) — every revision produced
-- by the running application always has a real, authenticated actor; a live write path with no
-- principal is a bug, not a case this schema accommodates.
CREATE TABLE invoice_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  invoice_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL CHECK (action IN (
    'created', 'status_changed', 'approved', 'paid_via_payment_confirmation',
    'baseline_pre_revision_tracking'
  )),
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_invoice_revisions_invoice_tenant
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES invoices (id, tenant_id)
);
CREATE INDEX ix_invoice_revisions_invoice ON invoice_revisions (invoice_id, occurred_at);
CREATE INDEX ix_invoice_revisions_tenant ON invoice_revisions (tenant_id);

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0075/0105's NULLIF-hardened form, not
-- 0021's original — see 0025's own header for why the NULLIF guard is load-bearing: an UNSET GUC
-- reads as '' -> string_to_array('', ',') -> {''} -> a uuid[] cast ERROR rather than "matches
-- nothing" without it). Core (non-module-owned) table, same as `invoices` itself — no
-- app_module_allowed() clause; a company that disables the billing module must not lose visibility
-- into its OWN forensic trail as a side effect of a module toggle.
DO $$
BEGIN
  ALTER TABLE invoice_revisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE invoice_revisions FORCE ROW LEVEL SECURITY;
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON invoice_revisions FOR ALL
     USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
     WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))'
  );
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3, 4, 5 · Backfill — one per-tenant loop (RLS GUARD: migrations run as `platform_owner`,
-- which deliberately lacks BYPASSRLS — see 0074/0051's own headers and lint-migration-rls.mjs.
-- `invoices` already carries FORCE ROW LEVEL SECURITY from 0021, so any UPDATE/INSERT...SELECT
-- against its EXISTING rows must set `app.current_tenant_ids` first, per tenant, in THIS file.
-- `invoice_revisions` was just CREATE TABLE'd above in this SAME file (zero pre-existing rows by
-- construction), so PART 5's INSERT into it needs no GUC of its own — but its SELECT side reads
-- `invoices`, which DOES need the GUC, so the same loop iteration covers it regardless).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  co RECORD;
  recovered int; touched_updated_by int; baselined int;
  total_recovered int := 0; total_updated_by int := 0; total_baselined int := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    -- ── PART 3 · recover `created_by` from the `activities` log where a reliable signal exists ──
    -- IAM-GAP-01 added `created_by` with NO backfill, reasoning that `origin_site` records which
    -- DEPLOYMENT wrote a row, not which USER did — inventing an actor from that would be a
    -- fabricated audit trail. That reasoning stands. But `activities` is a DIFFERENT, genuinely
    -- historical signal: `billing.controller.ts::create()` has called
    -- `writeActivity(tenantId, req.principal.userId, "created", "invoice", id, ...)` since before
    -- this migration existed (activities.actor_id records exactly who invoked the create endpoint
    -- — the same fact created_by was always supposed to capture, just written to a different
    -- table). This is recovery of a REAL recorded fact, not invention.
    --
    -- Recovered ONLY when the signal is UNAMBIGUOUS: exactly one row in `activities` with
    -- verb='created', target_entity_type='invoice', target_entity_id=<this invoice>, and a non-null
    -- actor_id. Zero matching rows (pre-activities-logging era, or a seed-inserted row that never
    -- went through the API) or MULTIPLE DISTINCT actors (a genuinely ambiguous signal — should
    -- never happen for a single "created" event, but if it ever does, guessing which one is worse
    -- than an honest NULL) both leave `created_by` untouched. This is the ONLY backfill this
    -- migration performs against `created_by` — Cerbos's fail-closed `approve` condition is NOT
    -- weakened; a row that still has no recorded creator after this runs is still permanently
    -- unapprovable by anyone but the platform_admin/group_executive wildcard, exactly as
    -- IAM-GAP-01 designed. See the IAM-GAP-02 report §"the stuck draft" for the one row known
    -- live where this signal was checked and the operator step to take if it comes up empty.
    WITH distinct_actors AS (
      -- Every DISTINCT (invoice, actor) pair this tenant's activities log has for a 'created'
      -- event — collapsed with GROUP BY (not just SELECT DISTINCT) so the intent ("count how many
      -- different actors claim this invoice's creation") is legible from the query shape itself.
      SELECT act.target_entity_id AS invoice_id, act.actor_id
        FROM activities act
       WHERE act.target_entity_type = 'invoice'
         AND act.verb = 'created'
         AND act.actor_id IS NOT NULL
       GROUP BY act.target_entity_id, act.actor_id
    ),
    unambiguous AS (
      -- Only invoices where EXACTLY ONE distinct actor claims the 'created' event. The aggregate
      -- is irrelevant to correctness (there is only one value in the group when count = 1); it is
      -- required because a bare SELECT cannot sit alongside GROUP BY/HAVING.
      -- `(array_agg(...))[1]` and NOT `min()`: Postgres has NO min/max aggregate for `uuid`, and
      -- `actor_id` is a uuid. This shipped as `min(actor_id)` in alpha-01.040.0093a and failed on
      -- the server with `function min(uuid) does not exist`, rolling that deploy back — the
      -- migration is transactional, so nothing partially applied. array_agg accepts any type.
      SELECT invoice_id, (array_agg(actor_id))[1] AS actor_id
        FROM distinct_actors
       GROUP BY invoice_id
      HAVING count(*) = 1
    )
    UPDATE invoices i
       SET created_by = u.actor_id
      FROM unambiguous u
     WHERE i.id = u.invoice_id
       AND i.created_by IS NULL;
    GET DIAGNOSTICS recovered = ROW_COUNT;
    total_recovered := total_recovered + recovered;

    -- ── PART 4 · updated_by backfill — ONLY where "the last person to touch this row" is a fact
    -- already provable, not a guess. `updated_at = created_at` means no mutation has EVER touched
    -- this row since it was created (every write path in this codebase bumps `updated_at`), so the
    -- creator IS, trivially and truthfully, also the last (and only) person who touched it — this
    -- is the same class of inference as PART 3, not a fabrication. A row whose `updated_at` has
    -- moved but predates this migration has NO recorded actor for whichever historical mutation
    -- last touched it (the `updated_by` column did not exist yet), and is left NULL — an honest
    -- gap, same policy as `created_by`'s own no-invention rule.
    UPDATE invoices
       SET updated_by = created_by
     WHERE updated_by IS NULL
       AND created_by IS NOT NULL
       AND updated_at = created_at;
    GET DIAGNOSTICS touched_updated_by = ROW_COUNT;
    total_updated_by := total_updated_by + touched_updated_by;

    -- ── PART 5 · one baseline revision row per pre-existing invoice ──────────────────────────────
    -- Every invoice that exists before this migration runs gets exactly one `invoice_revisions`
    -- row marking "this is what it looked like when revision tracking began" — `actor_id = NULL`
    -- (a real one is not knowable; this is a system-generated marker, not a claimed edit),
    -- `before_snapshot = NULL` (deliberately — there is no captured "before" for pre-tracking
    -- history; claiming one would be exactly the fabricated-trail problem `created_by` avoided).
    -- Without this, a pre-existing invoice's revision history is SILENTLY EMPTY, which reads
    -- exactly like "nothing has ever happened to this row" — indistinguishable from a row that
    -- genuinely has no history. This marker makes the boundary explicit instead of silent: history
    -- is known FROM HERE FORWARD, and honestly unknown before it.
    INSERT INTO invoice_revisions (id, tenant_id, invoice_id, actor_id, action, before_snapshot, after_snapshot, changed_fields, occurred_at)
    SELECT gen_random_uuid(), i.tenant_id, i.id, NULL, 'baseline_pre_revision_tracking', NULL,
           jsonb_build_object(
             'id', i.id, 'tenantId', i.tenant_id, 'clientId', i.client_id,
             'periodStart', i.period_start, 'periodEnd', i.period_end, 'status', i.status,
             'currency', i.currency, 'lines', i.lines, 'total', i.total::text,
             'originSite', i.origin_site, 'createdBy', i.created_by, 'approvedBy', i.approved_by,
             'approvedAt', i.approved_at, 'updatedBy', i.updated_by, 'createdAt', i.created_at,
             'updatedAt', i.updated_at, 'deletedAt', i.deleted_at
           ),
           '{}', now()
      FROM invoices i
     WHERE i.tenant_id = co.id
       AND NOT EXISTS (SELECT 1 FROM invoice_revisions ir WHERE ir.invoice_id = i.id);
    GET DIAGNOSTICS baselined = ROW_COUNT;
    total_baselined := total_baselined + baselined;
  END LOOP;

  RAISE NOTICE '[0108] created_by recovered from activities log: % row(s)', total_recovered;
  RAISE NOTICE '[0108] updated_by backfilled (never-touched-since-creation rows only): % row(s)', total_updated_by;
  RAISE NOTICE '[0108] baseline invoice_revisions rows inserted: % row(s)', total_baselined;

  -- Reported rather than asserted non-zero: a fresh/test database legitimately has zero invoices,
  -- so none of the three counts above can be a hard precondition. What IS assertable is the
  -- INVARIANT below — every invoice must have at least one revision row after this migration, with
  -- no exceptions (an invoice with zero revisions is exactly the "partial capture that reads as a
  -- complete history" defect the ticket warned about).
  IF EXISTS (
    SELECT 1 FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM invoice_revisions ir WHERE ir.invoice_id = i.id)
  ) THEN
    RAISE EXCEPTION '0108: at least one invoice has ZERO invoice_revisions rows after the baseline backfill';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- PART 6 · Assert, don't assume
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE got integer;
BEGIN
  -- (a) invoices.updated_by landed
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'updated_by'
  ) THEN
    RAISE EXCEPTION '0108: invoices.updated_by is missing';
  END IF;

  -- (b) invoice_revisions exists with FORCE RLS + a tenant_isolation policy
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'invoice_revisions') THEN
    RAISE EXCEPTION '0108: invoice_revisions table is missing';
  END IF;
  SELECT count(*) INTO got FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'invoice_revisions' AND n.nspname = 'public' AND c.relforcerowsecurity = true;
  IF got <> 1 THEN
    RAISE EXCEPTION '0108: invoice_revisions does not have FORCE ROW LEVEL SECURITY set';
  END IF;
  SELECT count(*) INTO got FROM pg_policies
   WHERE tablename = 'invoice_revisions' AND policyname = 'tenant_isolation';
  IF got <> 1 THEN
    RAISE EXCEPTION '0108: invoice_revisions is missing its tenant_isolation policy';
  END IF;

  -- (c) the action CHECK constraint admits every action this pass's handlers actually emit
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'invoice_revisions'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%paid_via_payment_confirmation%'
  ) THEN
    RAISE EXCEPTION '0108: invoice_revisions.action CHECK constraint is missing an expected literal';
  END IF;
END $$;

COMMENT ON TABLE invoice_revisions IS
  'IAM-GAP-02 (2026-08-13): forensic revision history for `invoices` — WHO (actor_id), WHEN '
  '(occurred_at), and WHAT CHANGED (before_snapshot/after_snapshot, full-row, not a diff — see this '
  'migration''s own header for why) per mutation. One row per create/status-change/approve/'
  'payment-confirmed-paid transition, written in the SAME transaction as the mutation it documents. '
  'Pre-existing rows carry exactly one action=''baseline_pre_revision_tracking'' marker (actor_id '
  'NULL, before_snapshot NULL) instead of silent, indistinguishable-from-untouched emptiness.';

COMMENT ON COLUMN invoices.updated_by IS
  'IAM-GAP-02: the last user to mutate this row (set on every write path — see '
  'invoice-revisions.ts''s header for the enumerated list). Backfilled ONLY where provably true '
  '(updated_at = created_at -> the creator is trivially also the last/only toucher); left NULL '
  'where a historical mutation''s actor genuinely cannot be known — never guessed.';
