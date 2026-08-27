-- webdesk/migrations/0006_tenant_webhooks.sql
-- WSK-37 — per-tenant OUTBOUND webhooks. Clients register their own target URL so their form
-- submissions can land in their own CRM instead of every integration being bespoke work.
--
-- Requires 0001_platform_core.sql (tenants, webdesk_tenant_ctx()). Runs as webdesk_migrator (no
-- SET ROLE) — same posture as every prior migration in this ledger. webdesk_app's DML rights on
-- both new tables arrive automatically via postgres/init-roles.sh's `ALTER DEFAULT PRIVILEGES FOR
-- ROLE webdesk_migrator` rule — no GRANT needed here, only the immutability REVOKE below.
--
-- SECURITY CONTEXT (design §03 amendment — see webdesk/api/README.md's WSK-37 runbook for the
-- full egress-allowlist discussion): `target_url` is a CLIENT-SUPPLIED destination for outbound
-- HTTP FROM Zone B. That is a brand-new egress class the §03 allowlist table does not cover — the
-- SSRF defenses live in application code (tenant-webhooks/ssrf-guard.ts), not in this schema, but
-- the schema still carries its share of the containment: `target_url` itself is never logged in
-- the clear anywhere outside this table (delivery rows below store outcome, not the URL again).
--
-- ON `secret_ciphertext` NOT BEING A ONE-WAY HASH (deliberate deviation from the ticket's literal
-- "hashed at rest the way api_keys does — sha256 + pepper", flagged loudly in the WSK-37 report):
-- api_keys.key_hash is a VERIFICATION secret — Zone B only ever needs to check "does a presented
-- plaintext match", which a one-way hash does perfectly. A webhook secret is a SIGNING secret —
-- Zone B must produce a fresh HMAC over new bytes on every delivery, which is mathematically
-- impossible from a one-way hash (there is no plaintext to feed HMAC-SHA256 with). Storing the
-- literal generated secret AND labeling it "hashed" would be worse than useless: it would look
-- protected while being exactly as exposed as plaintext to anyone who reads this table. Instead
-- this column holds AES-256-GCM ciphertext, keyed by TENANT_WEBHOOK_SECRET_PEPPER (Zone B env
-- only, never in this database, never in git — same custody model api_keys' pepper already uses).
-- A database-only compromise (no env access) cannot recover a usable signing secret from this
-- column, which is the actual security property "hashed at rest" was reaching for.


CREATE TABLE tenant_webhooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  target_url   text NOT NULL,             -- validated https-only + SSRF-checked at write time by
                                           -- the service layer, not by a DB constraint (a DNS
                                           -- rebind can only be caught at dispatch time — see
                                           -- ssrf-guard.ts's own header for why this is re-checked
                                           -- on EVERY delivery, not just at registration).
  secret_ciphertext text NOT NULL,        -- AES-256-GCM(secret, key=sha256(pepper)) — see the
                                           -- header note above for why this is reversible
                                           -- ciphertext, not a one-way hash. Plaintext returned
                                           -- ONCE at registration/rotation, never again.
  enabled      boolean NOT NULL DEFAULT true,
  event_kinds  text[] NOT NULL DEFAULT ARRAY['form.received']::text[],
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (event_kinds <> '{}'::text[]),
  CHECK (target_url ~ '^https://')        -- belt-and-braces: HTTPS-only egress (§03 requirement),
                                           -- enforced twice (here AND in application code) so a
                                           -- direct DB write can never plant an http:// target.
);
CREATE INDEX ix_tenant_webhooks_tenant ON tenant_webhooks (tenant_id);
CREATE INDEX ix_tenant_webhooks_tenant_enabled ON tenant_webhooks (tenant_id) WHERE enabled;

CREATE TABLE tenant_webhook_deliveries (   -- the delivery log: "what was sent and when" (ticket
                                           -- brief, point 2). Never stores the payload body or the
                                           -- target URL again — only outcome metadata — so this
                                           -- table cannot itself become a second copy of
                                           -- submitted-field PII sitting next to the webhook config.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  webhook_id      uuid NOT NULL REFERENCES tenant_webhooks(id),
  event_id        text NOT NULL,          -- correlator only (matches the ZoneBEventEnvelope-style
                                           -- eventId minted for this delivery); idempotency key.
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
  attempt_count   int NOT NULL DEFAULT 0,
  response_status int,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX ix_tenant_webhook_deliveries_tenant ON tenant_webhook_deliveries (tenant_id);
CREATE INDEX ix_tenant_webhook_deliveries_webhook ON tenant_webhook_deliveries (webhook_id, created_at);

-- Delivery rows are the evidence trail a client can be shown ("what was sent and when") — same
-- reasoning as mail_log's own REVOKE DELETE (0004_mail.sql): not quietly erasable by the runtime
-- role. UPDATE stays granted — the BullMQ worker transitions pending -> sent/failed in place.
REVOKE DELETE ON tenant_webhook_deliveries FROM webdesk_app;

ALTER TABLE tenant_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_webhooks;
CREATE POLICY tenant_isolation ON tenant_webhooks FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());

ALTER TABLE tenant_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_webhook_deliveries;
CREATE POLICY tenant_isolation ON tenant_webhook_deliveries FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());
