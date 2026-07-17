-- Allow system/AI-authored comments (BFF §5 AI Tracker): a NULL author_id means the comment
-- was written by the platform (e.g. the PM AI Tracker), not a user. Backward-compatible —
-- every human comment path still supplies an author_id; listComments already LEFT JOINs users.
ALTER TABLE comments ALTER COLUMN author_id DROP NOT NULL;
