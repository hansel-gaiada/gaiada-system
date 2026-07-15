-- WS8 Step B: generalize the WS4 approvals suspension surface to also carry WS8 AGENT-originated
-- suspensions (approved decision — reuse the inbox rather than build a parallel one). A write-capable
-- agent that hits a `high_write` files the same kind of record (through the same mcp-hub
-- `approvals.request` tool + this store) under the requesting user's OBO principal; only the origin
-- (and which agent) differ. Same FORCE-RLS isolation, same Cerbos policy, same human-decide flow.
ALTER TABLE automation_approvals
  ADD COLUMN origin text NOT NULL DEFAULT 'automation' CHECK (origin IN ('automation', 'agent')),
  ADD COLUMN agent_name text; -- e.g. 'task-triager' when origin='agent'; NULL for automation
