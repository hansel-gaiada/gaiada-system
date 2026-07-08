-- 5b.1: link platform users to their IdP identity. Auto-provisioned on first OIDC login;
-- the JWT `sub` is the stable join key (email can change).
ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_subject text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_idp_subject ON users (idp_subject) WHERE idp_subject IS NOT NULL;
