-- P3-08 — Task followers + comment reactions (tables, endpoints, notification fan-out).
--
-- pm_task_followers: a self-scoped preference (following IS a per-user opt-in, never a
-- client-supplied assignment) — the app layer always writes user_id = the calling principal,
-- enforced in SQL (pm.controller.ts follow/unfollow always parameterize user_id from
-- req.principal.userId, never from the request body). Drives the patchTask status-change and
-- comment-on-task notification fan-outs (recipients deduped into one Set per event so a
-- follower who is also the assignee/mentioned gets exactly one notification).
--
-- comment_reactions: one row per (tenant, comment, user, emoji) — a user can react with several
-- distinct emoji on the same comment, but never twice with the SAME emoji (the PK is the
-- idempotency key for the `ON CONFLICT DO NOTHING` add-reaction endpoint). emoji is a closed set
-- (CHECK), matching the P3-09 frontend's fixed reaction bar.
--
-- Both FORCE-RLS'd off the 0025 app_current_tenants() helper — same pattern as every pm_* table
-- since 0036/0038/0040/0041.
CREATE TABLE pm_task_followers (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  task_id uuid NOT NULL REFERENCES pm_tasks(id),
  user_id uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, user_id)
);
CREATE INDEX pm_task_followers_task_idx ON pm_task_followers (task_id);

CREATE TABLE comment_reactions (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  comment_id uuid NOT NULL REFERENCES comments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  emoji text NOT NULL CHECK (emoji IN ('👍','❤️','🎉','👀','✅','💡','🙏','🔥')),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, comment_id, user_id, emoji)
);
CREATE INDEX comment_reactions_comment_idx ON comment_reactions (comment_id);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_task_followers ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_task_followers FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_task_followers FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';

  EXECUTE 'ALTER TABLE comment_reactions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE comment_reactions FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON comment_reactions FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
