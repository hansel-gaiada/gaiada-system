-- IAM-02d — seed the six code-known roles that have ZERO `roles` rows and are therefore
-- ungrantable: team_lead, viewer, it_manager, it, search_staff, search_manager.
--
-- THE BUG, per role (all verified against source + a live read-only query against
-- gda-aicenter's `gaiada_platform` on 2026-08-10 — every one of the six confirmed at 0 rows):
--
--   team_lead        — a REAL, live-relevant `derived_roles.yaml` raw-grant role
--                       (`g.role == "team_lead" && g.scopeType == "team"`), referenced across
--                       ~27 resource policies (pm_task/pm_project/project/task/client/comment/
--                       device/file/... — full PM read+update parity with `member`, per
--                       platform-ui/src/lib/rbac.ts's own "Gap 2" audit trail). NOT actually
--                       hard-ungrantable today: `src/core/teams.controller.ts`'s
--                       `teamLeadRoleId()` lazily INSERTs this exact global row (guarded by
--                       0073's `roles_global_name_uniq` partial index) the first time anyone is
--                       promoted to team lead via `POST .../teams/:teamId/members {role:"lead"}`.
--                       The zero-row live state simply means nobody has used that endpoint yet
--                       on gda-aicenter. Seeding here removes the first-call race, makes the
--                       role visible to any admin role-listing UI *before* the first promotion,
--                       and — this is the one that matters — unblocks PM callers that need to
--                       grant it directly without going through the Teams flow.
--   viewer            — a REAL, distinct raw-grant role (`g.role == "viewer"`, company/global
--                       scoped exactly like `member`), referenced in ~30 resource policies as a
--                       read-only baseline, and in `resource_pm_task.yaml` specifically granted
--                       update parity with member/team_lead/manager/company_admin (confirmed:
--                       line 15's read+update rule lists `viewer` beside them; line 20's
--                       create/delete/manage rule excludes it). `platform-ui/src/lib/rbac.ts`
--                       already models it fully (`viewer: ["pm.contribute"]`, matching
--                       `member`). No evidence this is a naming mistake — it is a deliberately
--                       narrower tier that simply has no seed row, so nobody could ever hold it.
--                       SEED, not delete (deleting would mean stripping it from ~30 Cerbos
--                       policies and rbac.ts, which is out of this ticket's scope and unsupported
--                       by any finding here).
--   it_manager, it    — `derived_roles.yaml`'s `it_staff` derived role matches
--                       `it_admin`/`it_manager`/`it` IDENTICALLY (same OR-condition, same scope,
--                       the ONLY Cerbos policy that reads any of the three is
--                       `resource_device.yaml`). So in enforcement these three names are exact
--                       synonyms of the already-seeded `it_admin`. They are NOT dead code,
--                       though: `src/admin/admin-systems.controller.ts` (line ~165) explicitly
--                       checks `r.role === "it_admin" || r.role === "it_manager" || r.role ===
--                       "it"` to gate the admin systems console, and rbac.ts models all three as
--                       distinct IT-operator tiers. Seeding lets that already-built three-tier
--                       model actually be assigned; it changes zero Cerbos decisions (it_staff's
--                       condition is unchanged and unconditional on which of the three you hold).
--   search_staff,     — THE live defect this ticket was written to catch. `derived_roles.yaml`'s
--   search_manager      generic `module_staff`/`module_manager` pair (WSD-2, the same mechanism
--                       0026 seeded for `hr_*` and 0069 seeded for `reports_*`) matches
--                       `g.role == (resource.attr.module + "_staff"/"_manager")`. Every
--                       search-module authorize() call passes `module: "search"` (confirmed:
--                       `search.controller.ts`, `search-reports.controller.ts`,
--                       `search-google-ads.controller.ts`, `search-google-oauth.controller.ts`,
--                       `resource_search_{property,campaign,engagement,keyword,ledger,audit,
--                       report}.yaml`), and `src/modules/search/index.ts:118` registers the
--                       module under `key: "search"`. `src/admin/service-reconciler.ts`'s
--                       `moduleRoleId(c, moduleKey, kind)` (line ~89) does
--                       `SELECT id FROM roles WHERE company_id IS NULL AND name = '<key>_<kind>'`
--                       and returns NULL on a miss; its caller then does
--                       `if (!rid) { skipped.push(userId); continue; }` — no grant, no error,
--                       reported only in an internal `skipped` array nothing surfaces to an
--                       operator. This is BYTE-FOR-BYTE the bug 0069's header documents for
--                       `reports_staff`/`reports_manager` before it landed, now reproduced for
--                       `search`. VERIFIED not yet a LIVE incident: a read-only query against
--                       gda-aicenter's `service_assignments` table returned 0 rows for every
--                       module_key (search-module service assignments are not live yet) — so no
--                       real user has silently lost a grant over this YET, but the moment a
--                       search-department service assignment goes active, it reproduces the
--                       exact silent-skip defect 0069 closed for reports.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not grant any of these six roles to any user, does
-- not touch any Cerbos policy, and does not touch platform-ui/src/lib/rbac.ts. Seeding a
-- `roles` row only makes a name GRANTABLE — an admin still has to assign it, and
-- `service-reconciler.ts` still only materializes `search_staff`/`search_manager` onto a SERVED
-- company via an active `service_assignments` row (of which there are currently none). Zero
-- authorization decisions change for any existing user.
--
-- IDIOM: identical to 0026 block (E) / 0069 — a global role has `company_id IS NULL`, and SQL
-- NULLs are distinct for `UNIQUE (company_id, name)` (0001's original constraint), so
-- `ON CONFLICT (company_id, name)` cannot de-duplicate a NULL-company_id row. A `NOT EXISTS`
-- guard scoped explicitly to `company_id IS NULL` is what makes this idempotent and safely
-- re-runnable (0073's `roles_global_name_uniq` partial index on `(name) WHERE company_id IS
-- NULL` now also backstops this at the constraint level, but the NOT EXISTS guard is kept for
-- consistency with the established migration idiom rather than relying on ON CONFLICT alone).
--
-- `roles` is GLOBAL reference data (company_id IS NULL here by construction), not tenant data —
-- the "migration runs as a BYPASSRLS-adjacent owner / unset tenant GUC" backfill trap
-- (migration-backfill-rls-trap.md) does not apply: there is no RLS on `roles` to bypass and no
-- tenant-scoped WHERE clause that could silently match zero rows.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, r.name, r.description
FROM (VALUES
  ('team_lead',      'Team lead (scope: team) — PM read+update parity with member; promoted via POST /api/:tenantId/teams/:teamId/members'),
  ('viewer',         'Read-only baseline (company/global scope) — same PM update parity as member on pm_task; excluded from create/delete/manage everywhere else'),
  ('it_manager',     'IT operator tier — Cerbos it_staff treats this identically to it_admin/it (resource_device.yaml); distinguished only by admin-systems console checks and the UI mirror'),
  ('it',             'IT operator tier — Cerbos it_staff treats this identically to it_admin/it_manager (resource_device.yaml); distinguished only by admin-systems console checks and the UI mirror'),
  ('search_staff',   'search-marketing module_staff (WSD-2) — draft-only baseline; reconciler-materialized onto a SERVED company via an active service_assignments row'),
  ('search_manager', 'search-marketing module_manager (WSD-2) — adds elevated actions (launch/set_scope/approve/admin); reconciler-materialized onto a SERVED company''s lead')
) AS r(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = r.name
);
