-- Job title shown on the ERP UI user card (e.g. 'AI Manager'). Display-only; not authz.
ALTER TABLE users ADD COLUMN IF NOT EXISTS title text;
