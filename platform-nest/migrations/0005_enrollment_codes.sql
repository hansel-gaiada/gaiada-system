-- Dual-proof identity enrollment (5b.5 / D4.4). A verified IdP user (MFA'd → high
-- assurance) requests a code; they then send that code TO the bot FROM the WhatsApp/
-- Telegram identity they want to link. The bot confirms with the code + the observed
-- external_id, proving control of BOTH the IdP account and the chat identity before
-- identity_links.verified_at is set (which is what unlocks elevated scope).
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_code ON enrollment_codes (code) WHERE consumed_at IS NULL;
