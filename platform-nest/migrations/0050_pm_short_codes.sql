-- WD-28 — PM per-project short-codes (OQ-7 default): projects.short_code + per-project task_seq
-- counter + pm_tasks.seq. Additive, no behavior change to existing flows. `projects`/`pm_tasks`
-- are CORE (plain tenant wall, D-2) — no webdev module third-wall added here.
--
-- ATOMICITY (the whole point of this ticket): allocation of a task's seq is the single statement
--   UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq
-- issued inside the request's existing transaction (src/db/index.ts `withTenants`: BEGIN..COMMIT
-- around the whole handler). An UPDATE takes a row-level lock on the targeted `projects` row for
-- the remainder of that transaction, so a second concurrent allocation on the SAME project blocks
-- until the first transaction commits (or rolls back) and then always observes the already-
-- incremented counter — no read-then-write window, no advisory lock needed (this is exactly the
-- class of race that produced DEF-2 elsewhere; a single-statement RETURNING counter closes it by
-- construction rather than by locking discipline the caller could get wrong). The partial UNIQUE
-- index below is the schema-level backstop if that invariant is ever violated by a future code
-- path that doesn't go through the shared allocator.

ALTER TABLE projects ADD COLUMN short_code text;
ALTER TABLE projects ADD COLUMN task_seq integer NOT NULL DEFAULT 0;

-- Per-tenant uniqueness (a code is meaningful within its own company); soft-deleted projects
-- don't hold their code hostage (a purged project's code can be reused).
CREATE UNIQUE INDEX projects_short_code_uidx
  ON projects (tenant_id, short_code)
  WHERE deleted_at IS NULL AND short_code IS NOT NULL;

ALTER TABLE pm_tasks ADD COLUMN seq integer;

-- Per-project uniqueness (matches the design's literal LD-10 shape). Includes tenant_id
-- defensively even though project_id already implies one tenant — mirrors the shape of every
-- other pm_* composite unique in this ledger (e.g. 0036/0038/0043).
CREATE UNIQUE INDEX pm_tasks_seq_uidx
  ON pm_tasks (tenant_id, project_id, seq)
  WHERE seq IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- BACKFILL — idempotent by construction: both passes below only ever touch rows whose short_code
-- / seq is still NULL, so a second run of this same logic (verified live by re-executing this
-- block against the dev DB after the migration had already applied it once) finds no NULL rows
-- left and changes nothing — no renumbering, no duplicate assignment, no code reassignment.
-- ---------------------------------------------------------------------------------------------

-- 1) Derive a short_code for every project that doesn't have one yet: first 3-4 uppercase
--    alphanumeric characters of the name (padded with 'X' if the name yields fewer than 3),
--    numeric suffix appended on collision WITHIN THE SAME TENANT. Processed in
--    (tenant_id, created_at) order so the assignment is deterministic and reproducible.
DO $$
DECLARE
  proj RECORD;
  base text;
  candidate text;
  n int;
BEGIN
  FOR proj IN
    SELECT id, tenant_id, name FROM projects
    WHERE short_code IS NULL AND deleted_at IS NULL
    ORDER BY tenant_id, created_at, id
  LOOP
    base := upper(regexp_replace(proj.name, '[^a-zA-Z0-9]', '', 'g'));
    base := substring(base FROM 1 FOR 4);
    IF length(base) < 3 THEN
      base := rpad(base, 3, 'X');
    END IF;
    IF base = '' THEN
      base := 'PRJ';
    END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM projects
      WHERE tenant_id = proj.tenant_id AND short_code = candidate AND deleted_at IS NULL
    ) LOOP
      n := n + 1;
      candidate := base || n::text;
    END LOOP;
    UPDATE projects SET short_code = candidate WHERE id = proj.id;
  END LOOP;
END $$;

-- 2) Number every task that doesn't have a seq yet, per project, in created_at order, continuing
--    from that project's CURRENT task_seq (0 for a project with no prior allocations) — so a
--    re-run is a true no-op (every task already has a seq, the `seq IS NULL` filter matches
--    nothing, and task_seq is left untouched). Soft-deleted tasks are numbered too (a seq, once
--    issued, is never reused even if the task is later deleted — matches the git-commit-number
--    intuition a short-code display implies).
DO $$
DECLARE
  proj RECORD;
  tsk RECORD;
  next_seq int;
BEGIN
  FOR proj IN SELECT id, task_seq FROM projects WHERE deleted_at IS NULL LOOP
    next_seq := proj.task_seq;
    FOR tsk IN
      SELECT id FROM pm_tasks
      WHERE project_id = proj.id AND seq IS NULL
      ORDER BY created_at, id
    LOOP
      next_seq := next_seq + 1;
      UPDATE pm_tasks SET seq = next_seq WHERE id = tsk.id;
    END LOOP;
    IF next_seq <> proj.task_seq THEN
      UPDATE projects SET task_seq = next_seq WHERE id = proj.id;
    END IF;
  END LOOP;
END $$;
