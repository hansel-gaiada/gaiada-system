-- P1-01: projects gains an owning department_id (org-node id, nullable).
--
-- Projects can now be associated with a department in the org structure.
-- This allows cross-department work to flow via task assignment while
-- projects can be owned by specific departments. The department_id is
-- free-form text (matching org-node id format in the JSONB org structure),
-- with no foreign key constraint (org-node ids are not a database table).
--
-- Used by: the UI Projects "Department" column + each department console's
-- owned-projects list. GET endpoints return department_id; POST/PATCH accept
-- departmentId (camelCase in body, snake_case in DB).

ALTER TABLE projects ADD COLUMN department_id text;
