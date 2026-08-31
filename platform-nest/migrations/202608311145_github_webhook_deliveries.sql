-- 202608311145_github_webhook_deliveries.sql — GH-07: delivery-idempotency ledger for
-- `POST /api/webhooks/github` (docs/blueprints/github-integration-foundation.md §4.5, §5.3).
--
-- ── FILENAME NOTE (timestamp scheme is NORMATIVE — migrations/README.md) ───────────────────────────
-- On-disk head at authoring time is `202608310900_iam_github_repo_permissions.sql` (`ls
-- platform-nest/migrations | sort | tail -5` checked directly, per this ticket's own instruction —
-- two files landed today ahead of this one: 202608310735 and 202608310900). `2026083111 45 >
-- 2026083109 00`, so this file sorts after both and is safe to apply.
--
-- ── WHY THIS TABLE EXISTS, SEPARATE FROM `activities` AND `github_repos` ──────────────────────────
-- GitHub redelivers webhooks (network retry, or a human clicking "Redeliver" in the App's UI) and
-- guarantees nothing about ordering or exactly-once. `X-GitHub-Delivery` is GitHub's OWN dedup key
-- for one HTTP delivery attempt — this table's job is only to answer "have I already processed this
-- exact delivery", nothing else. It is deliberately NOT folded into `activities` (that ledger's unit
-- is an ERP-initiated OUTBOUND call, keyed by a correlation id this receiver CONSUMES, not produces —
-- see core/github/ledger.ts) and NOT folded into `github_repos` (that table is repo STATE, not an
-- event log; a single delivery can touch zero, one, or several repo rows, e.g. a `push` webhook).
--
-- ── THE UNIQUE INDEX IS THE ATOMICITY PRIMITIVE, NOT A CONVENIENCE ─────────────────────────────────
-- A GitHub "redelivery storm" (several redeliveries of the same delivery id reaching the receiver at
-- nearly the same instant — the shape this estate's own d14-09-redelivery-storm.test.ts exercises for
-- a different queue) must not double-write `github_repos` or double-file a `work_activity` row.
-- `INSERT ... ON CONFLICT (delivery_id) DO NOTHING RETURNING id` is atomic under Postgres row-level
-- locking: of N concurrent inserts for the same delivery_id, exactly one returns a row and every
-- other returns none — no advisory lock, no SELECT-then-INSERT race window. The receiver takes "no
-- row returned" as "already seen, ack without reprocessing".
--
-- ── PLAIN `UNIQUE`, NOT THE `github_repos` PARTIAL-INDEX PATTERN ───────────────────────────────────
-- `github_repos` needed a partial unique index because it soft-deletes and a live row must be able to
-- re-claim a full_name a deleted row once held (see that migration's header). This table never
-- soft-deletes a delivery record — a delivery id is either seen or not, permanently — so a plain
-- `UNIQUE (delivery_id)` is the correct, simpler primitive here; there is no second state for a
-- deleted row to collide with.
--
-- ── `tenant_id` NOT NULL, RESOLVED THE SAME WAY GH-06's SWEEP RESOLVES IT ──────────────────────────
-- Same ruling as `github_repos` (migration 202608310735) and `config.githubRepoSync.tenantId`
-- (config.ts, GH-06): the operating company that owns the `gaiadabali` GitHub org, always — a single
-- App installation, a single org, a single ERP tenant. The receiver reads this from
-- `config.githubRepoSync.tenantId` (the SAME env var GH-06's sweep already requires) rather than
-- inventing a second one — one knob, one meaning, matching §2.3(c)'s "every function still takes
-- tenantId as a parameter... the ruling says which value callers pass" precedent one layer down.
--
-- ── `status`/`error` — SO A STUCK OR FAILED DELIVERY IS VISIBLE, NOT SILENT ────────────────────────
-- A delivery is inserted `received` before any handler runs (mirrors `activities`' own "write before
-- the call" discipline — core/github/ledger.ts's header), then flipped to `processed` or `failed`
-- once the handler resolves. A row stuck at `received` past a grace window is the webhook-receiver
-- analogue of `findDanglingGithubAttempts()` (ledger.ts) — a future reconcile job's query to write,
-- not built here (out of this ticket's scope; GH-13 territory), but the column exists so that job has
-- something to select on rather than needing a schema change first.

CREATE TABLE github_webhook_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),

  -- GitHub's own per-delivery-attempt id (`X-GitHub-Delivery` header) — the idempotency key.
  delivery_id    text NOT NULL,
  event          text NOT NULL,             -- X-GitHub-Event header, e.g. 'push', 'pull_request'
  action         text,                      -- the payload's own `action` field, when the event has one
  full_name      text,                      -- repo 'org/name', when the event is repo-scoped

  status         text NOT NULL DEFAULT 'received'
                 CHECK (status IN ('received', 'processed', 'failed')),
  error          text,                      -- set only when status = 'failed'

  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,

  origin_site    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- THE atomicity primitive — see header. Plain unique, not partial: a delivery id is never
-- soft-deleted or reused.
CREATE UNIQUE INDEX ux_github_webhook_deliveries_delivery_id ON github_webhook_deliveries (delivery_id);

-- Lets a reconcile job cheaply find recent activity, or deliveries stuck at 'received' past a grace
-- window, without a full scan.
CREATE INDEX idx_github_webhook_deliveries_tenant_received
  ON github_webhook_deliveries (tenant_id, received_at DESC);
CREATE INDEX idx_github_webhook_deliveries_status
  ON github_webhook_deliveries (tenant_id, status) WHERE status <> 'processed';

ALTER TABLE github_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON github_webhook_deliveries FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE github_webhook_deliveries IS
  'GH-07 / blueprint §4.5, §5.3. One row per X-GitHub-Delivery id the receiver has SEEN. The unique '
  'index on delivery_id is the idempotency primitive: a redelivery storm inserts N times '
  'concurrently, exactly one INSERT wins, every other caller reads back zero rows and skips '
  'reprocessing. Not an event log of what changed (see activities / work_activity / github_repos for '
  'that) — only "have I already handled this exact delivery attempt".';

COMMENT ON COLUMN github_webhook_deliveries.delivery_id IS
  'GitHub''s own X-GitHub-Delivery header value — a UUID GitHub mints per delivery ATTEMPT (a '
  'redelivery of the same underlying event reuses the same id if resent from the Recent Deliveries '
  'UI, matching what this receiver needs for exactly-once processing).';

COMMENT ON COLUMN github_webhook_deliveries.status IS
  '''received'' is written BEFORE the event handler runs (crash-safety, same discipline as '
  'core/github/ledger.ts''s attempted/succeeded/failed shape); ''processed''/''failed'' after. A row '
  'stuck at ''received'' past a grace window is a handler that crashed mid-flight — visible here for '
  'a future reconcile job, not silently lost.';
