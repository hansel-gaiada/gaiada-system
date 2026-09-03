-- CH — documents-only migration, no DDL change. `monitor_channels.last_delivery_at` /
-- `last_delivery_ok` / `failure_count` were added by 0116_module_monitoring.sql but NOTHING ever
-- wrote them (before this ticket or after it, until the accompanying application-code change in
-- the same commit) — every channel read as "unused" in `channelHealth()`
-- (platform-ui/src/lib/monitoringShared.ts) forever, even seconds after a real send. This migration
-- only pins the exact, honest semantics in COMMENT ON COLUMN so the schema documents what the two
-- writers (runner.ts's notifyIncidents(), monitoring.controller.ts's testChannel()) now actually do.
--
-- ── WHAT "OK" CAN HONESTLY CLAIM, AND WHY IT STOPS THERE ────────────────────────────────────────
-- `enqueueMail()` (src/mail/queue.ts) only INSERTs a `mail_log` row and returns; the actual SMTP/API
-- handoff happens later, asynchronously, in the mail sender worker (src/mail/sender.ts), and the
-- provider's own delivered/bounced verdict arrives later STILL, via the inbound webhook
-- (src/mail/webhook.controller.ts) updating that SAME `mail_log` row to `delivered` or `bounced`.
-- That IS a genuine authoritative delivery signal in this codebase — but it is keyed to a single
-- `mail_log` row via `entity_type`/`entity_id`, and the incident fan-out path
-- (runner.ts:notifyIncidents) records `entity_type='monitor'`/`entity_id=<monitorId>` on that row,
-- NOT the channel it was routed through — a single incident can fan out to several channels, and
-- today's schema has no column that says which `mail_log` row went to which `monitor_channel`.
-- Wiring the webhook's `delivered`/`bounced` verdict back onto `monitor_channels` would therefore
-- require a new attribution column on `mail_log` (or a join table), which is a schema change on a
-- table this module does not own — out of scope for this ticket without senior-db/architect
-- sign-off. Filed as a follow-up rather than improvised here.
--
-- So, uniformly for BOTH writers, `last_delivery_ok = true` means only "successfully handed to the
-- mail queue for delivery" (`enqueueMail()` returned `{skipped:false, status:'queued'}`) — an
-- ENQUEUE acknowledgement, not proof the provider accepted it or the recipient received it. A
-- recipient under an active suppression (`mail_suppressions` — prior hard bounce/complaint) comes
-- back `status:'suppressed'`: the row is written but the sender worker deliberately never reaches
-- it (queue.ts), so that outcome is recorded as a FAILURE here, not a success — a channel that will
-- silently never deliver is exactly the false-confidence case this column exists to catch.
COMMENT ON COLUMN monitor_channels.last_delivery_at IS
  'Timestamp of the most recent delivery ATTEMPT on this channel (success or failure), written by '
  'runner.ts notifyIncidents() and monitoring.controller.ts testChannel(). NULL means never '
  'attempted -- channelHealth() (platform-ui/src/lib/monitoringShared.ts) reads that as "unused".';

COMMENT ON COLUMN monitor_channels.last_delivery_ok IS
  'Outcome of the attempt at last_delivery_at. TRUE means only "successfully handed to the mail '
  'queue" (enqueueMail() returned status=queued) -- an enqueue ack, NOT provider-confirmed delivery '
  'or recipient receipt (enqueueMail only inserts mail_log; the sender worker and the provider '
  'bounce/delivered webhook run later, asynchronously, and are not attributed back to a channel -- '
  'see this migration''s header). FALSE covers a thrown enqueueMail() call AND a '
  'status=suppressed result (mail_suppressions match -- the row is queued in form only; the sender '
  'worker never reaches it). Never write TRUE for a globally mail-disabled attempt '
  '(config.mail.enabled=false / skipped:true) -- that is a platform-wide switch, not a fact about '
  'this channel, so both writers leave the columns untouched in that case rather than mark it '
  'either "ok" or "failing".';

COMMENT ON COLUMN monitor_channels.failure_count IS
  'CONSECUTIVE failed attempts (per last_delivery_ok''s definition above), reset to 0 on any '
  'successful enqueue, incremented on a thrown enqueueMail() or a status=suppressed result. Drives '
  'channelHealth()''s degraded (1-2) / failing (>=3) thresholds -- a channel that exists and is '
  'enabled while quietly failing every send is worse than no channel, because it looks like '
  'coverage.';
