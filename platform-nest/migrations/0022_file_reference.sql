-- File attachments as references (BFF §4): the UI attaches a filename (+ optional URL) without
-- uploading binary content yet (true multipart is a documented follow-up). A reference row has
-- no stored blob, so storage_key becomes nullable and an optional url is recorded.
ALTER TABLE files ALTER COLUMN storage_key DROP NOT NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS url text;
