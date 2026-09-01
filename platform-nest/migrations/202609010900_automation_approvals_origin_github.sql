-- GH-12 (docs/blueprints/github-integration-foundation.md §7 GH-12, §4.2) — widen
-- `automation_approvals.origin` to admit 'github'.
--
-- ── WHY A NEW ORIGIN, NOT THE EXISTING D14 REGISTRY (`automation`/`agent`) ─────────────────────────
-- `core/approval-executables.ts`'s registry re-drives an approved write THROUGH mcp-hub
-- (`core/approval-execute.ts#attemptRedrive` -> `callHubTool`), and that re-drive is only reachable
-- past Cerbos when the tool is ALSO added to `resource_mcp_tool.yaml`'s executable-tool list — the
-- WSK-31/PRV-03 "pairing doctrine" this codebase already documents in that file. GH-12's own brief
-- forbids touching ANY cerbos policy (`resource_mcp_tool.yaml` included) and forbids repo creation
-- ever reaching mcp-hub at all (mcp-hub holds only the READ-ONLY `gaiada-agents` App — §2.2/§4.1).
-- So the standard hub-redrive shape is structurally unusable here regardless of origin: there is no
-- tool call this can safely re-drive through the agent-facing surface.
--
-- The shape that DOES fit is the one P2-08 part B already built for the identical problem (an
-- approval that must execute IN-BAND, inside `automation-approvals.controller.ts`'s own decide()
-- request, never through the hub): `origin='iam'`. That origin is deliberately not reused here —
-- reusing it would make a future reader believe GitHub repo creation is an IAM exception, and
-- `isIamRequest()`'s closed `workflow_id` switch (`iam-approval-execute.ts`) does not know GitHub's
-- shape. `origin='github'` keeps the same non-hub, in-band-execution mechanism
-- (`core/github/repo-creation.ts#executeApprovedGithubRepoCreation`, wired into `decide()` the same
-- way `executeApprovedIamRequest` already is) while keeping the audit trail honest about WHAT kind
-- of approval this is.
--
-- ── NO NEW CERBOS ACTION NEEDED ──────────────────────────────────────────────────────────────────
-- `resource_automation_approval.yaml`'s existing generic `create` action (company_admin/manager/
-- member) already covers filing this request, and its existing generic `decide` action is ALREADY
-- company_admin-only (+ the platform_admin wildcard) — the exact tier `resource_github_repo.yaml`'s
-- `create_repo` rule requires. No policy edit, no new literal action, unlike `decide_override`/
-- `decide_leave`'s own precedent (which each needed a NARROWER decider set than the generic action
-- already granted). The REAL, load-bearing gate is `resource_github_repo.yaml`'s own `create_repo`
-- rule (unmodified, already live) — `executeApprovedGithubRepoCreation` calls `authorize()` against
-- it directly, with this row's own id as `resource.attr.approvalId`, exactly like the read-mostly
-- registry controller already does for `read`/`link`/`unlink`.
--
-- Postgres cannot ALTER a CHECK in place, so this copies 0028's and 0115's own DO block verbatim:
-- look the constraint up BY DEFINITION rather than by name (0016 created it auto-named). Purely
-- additive: no existing row can violate a WIDER set, so this cannot fail on live data.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'automation_approvals'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%origin%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE automation_approvals DROP CONSTRAINT %I', cname);
  END IF;
END $$;
ALTER TABLE automation_approvals
  ADD CONSTRAINT automation_approvals_origin_check CHECK (origin IN ('automation','agent','hr','iam','github'));
