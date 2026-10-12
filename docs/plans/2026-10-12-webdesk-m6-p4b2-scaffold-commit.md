# M6-P4b2: the scaffold reaches the repo through platform-nest

Status: PLANNED → IN PROGRESS (this ticket). Parent plan: `docs/plans/2026-10-11-webdesk-m6-plan.md` (row M6-P4b2).
Depends on M6-P4b1 (`code.scaffold` v2 dry run) and M6-P4c (provisioning completion, the pinned snapshot).

## The problem in one paragraph

`code.scaffold` v2 composes a site tree in ai-agents and stops at a dry run. The agents' GitHub App and the hub are read-only
by design (D29, `core/github/apps.ts`): only platform-nest holds the `gaiada-erp` write credential. So the tree has to travel
to platform-nest, be verified there, and be written there with the ERP App through the Git Data API
(blobs → tree → commit → fast-forward ref). No write credential may exist in ai-agents or mcp-hub, not even as a forwarder
(`core/github/repo-creation.ts` header: the agent-facing, prompt-injectable surface must not carry the write arm).

## Decision: the transport

**The scaffold job itself hands the tree to platform-nest through ONE hub tool, `webdev.provisionedSites.commitScaffold`,
at the end of the job, with the run's OBO envelope.** The bytes ride in the tool's arguments (every file base64, with its
size and sha256), the hub forwards them unchanged to `POST /api/:tenantId/modules/webdev/provisioned-sites/:siteId/scaffold-commit`,
and platform-nest verifies and commits.

- The delivery workflow opts in: its `code.scaffold` call now passes `provisionedSiteId` (the site it already read and found
  `complete`). The hub writes it into the goal as `commit: { provisionedSiteId }`, a sibling of the frozen §06 envelope (the
  envelope itself is unchanged). A goal without it stays a pure dry run.
- The job never pushes: `runner-job.ts` still hard-codes `{ mode: "dry_run" }` and `git-writer.ts`'s push branch stays
  unreachable. What changed is that a composed tree can now be *offered* to platform-nest, which decides everything.
- The goal's blackboard records only the commit result (repo, branch, tree and commit sha), never the bytes.

Why this one:

| Criterion | How it is met |
|---|---|
| (a) no write credential outside platform-nest | ai-agents and the hub only carry bytes; platform-nest mints the ERP token, inside `githubRequest()` |
| (b) bytes verifiable | platform-nest recomputes every sha256 and size, then checks GitHub's returned blob sha against the git blob sha it computed itself |
| (c) within limits | see the measurements; the caps keep every conforming request under platform-nest's 1 MiB body limit |
| (d) fewest moving parts | one new tool and one route. No new store, no new queue, no n8n wait loop, no new credential, no new HTTP client |

### Measured tree sizes (`code.scaffold` v2 on the qa-p3-acme fixtures, real packed block library)

The block library was packed from `webdesk/blocks` (`src`, `README.md`, `package.json`, gzip): **26,934 bytes**. The PRD was
padded to 2 kB (typical) and 100 kB (the goal text cap).

| kind | files | raw bytes (2 kB PRD) | raw bytes (100 kB PRD) | base64 JSON on the wire (100 kB PRD) | largest files |
|---|---|---|---|---|---|
| astro | 22 (21 after this ticket) | 78,428 | 176,428 | ~238 kB | `docs/PRD.md`, `vendor/webdesk-sdk/index.d.ts` 35,876, `vendor/webdesk-blocks.tgz` 26,934 |
| node | 18 | 59,610 | 157,610 | ~213 kB | `docs/PRD.md`, `apps/web/vendor/webdesk-sdk/index.d.ts` 35,876 |
| wp | 17 | 59,795 | 157,795 | ~213 kB | `docs/PRD.md`, `inc/block-templates.php` 9,635 |

### Limits on every hop of the chosen path

| Hop | Limit | Headroom for a realistic tree |
|---|---|---|
| ai-agents → hub (`deps.ts` `callTool`, MCP over HTTP) | client side none; hub `express.json({ limit: "4mb" })` | ~17× |
| hub → platform-nest (`module-tools.ts` `callPlatform`) | platform-nest Fastify global `bodyLimit` **1 MiB** (default, never raised; `mail/inbound/raw-body.ts` header) | ~4.4× |
| platform-nest → GitHub (`githubRequest`, one blob per request) | GitHub blob API (100 MB per blob); 15 s per request timeout | far |
| goal storage (`agent_goals.blackboard` jsonb) | only the commit result is stored | n/a |

Caps (platform-nest refuses beyond them, and the job checks the same numbers before calling): **at most 300 files,
512 KiB per file, 600 KiB in total**. With base64 (×4/3) and ~300 bytes of JSON per entry, the largest conforming request is
about 940 kB, inside the 1 MiB body limit. A future tree that outgrows this raises the route's limit with a URL-scoped body
hook (the `mail/inbound/raw-body.ts` precedent), a follow-up, not this ticket.

### Rejected options

- **Contents in the goal result, platform-nest reads them.** The bytes would sit in `agent_goals.blackboard` (jsonb, fine for
  Postgres) but `GET /goals/:id` returns the blackboard to every `agents.status` poll, so ~240 kB would ride every poll. And
  platform-nest has no client for the runner: it would need a new runner credential and a new pull, or n8n would carry the
  bytes (a poll loop in the workflow, then a second hop). More moving parts and a second copy of the bytes at rest.
- **Upload a tarball as an ERP file or pipeline artifact.** `files.controller.ts` has no hub wrapper (deliberately: arbitrary file
  bytes by id are not exposed to agents, `hub-client.ts` header), so this needs a new upload tool plus a second tool to commit
  it, a stored object to garbage-collect, and the same 1 MiB body limit on the upload. Two writes where one suffices.
- **The workflow calls the commit tool after polling the goal.** The goal is asynchronous (`code.scaffold` answers with a goal
  id at once); n8n would need a Wait/poll loop and would have to carry the bytes. n8n's own payload limit (16 MB default) is
  not the problem; the poll loop and the duplicated bytes are.

## The integrity checks (platform-nest, before anything is written)

All are in `modules/webdev/scaffold-commit.ts` (pure, unit-tested) and run in this order; the first failure is the answer.

1. **Shape and caps.** ≤ 300 files, each ≤ 512 KiB, total ≤ 600 KiB (`scaffold_too_large`); every entry has a path, base64,
   a lowercase 64-hex sha256 and an integer size (`scaffold_manifest_invalid`).
2. **Paths.** Relative POSIX only. Refused (`scaffold_path_refused`): empty, absolute (`/x`, `C:/x`, `\\x`), backslashes, NUL or
   control characters, `.` or `..` segments, empty segments (`a//b`, trailing `/`), any `.git` segment in any case, `.gitmodules`,
   over 400 bytes. Duplicates, including case-only duplicates (`README.md` / `readme.md`), and a file that is also a directory
   of another file (`a` and `a/b`) are refused (`scaffold_path_conflict`).
3. **Modes.** Only `100644` (a regular file). A symlink (`120000`), submodule (`160000`), executable or tree is refused
   (`scaffold_mode_refused`). The Git Data API is called with mode `100644` only.
4. **Bytes.** Each file's decoded length must equal its declared size and its sha256 must equal the manifest's
   (`scaffold_hash_mismatch`, naming the path). Base64 must be canonical (re-encoding gives the same text).
5. **The lock.** `CONTRACT.lock` must exist at the root, parse as the five-key §06 object, and its `snapshotId` must equal the
   snapshot the site PINNED at completion (`webdev_provisioned_sites.contract_snapshot_id`), with `contractVersion`,
   `vocabularyVersion` and `contentHash` equal to that snapshot row's (`scaffold_lock_missing`, `scaffold_lock_invalid`,
   `scaffold_lock_snapshot_mismatch`). A `contractSnapshotId` in the request, if sent, must agree too.
6. **`.github/` belongs to the template.** Any path under `.github/` is refused (`scaffold_template_path_refused`) unless the
   template's base tree already holds a byte-identical blob at that path (same git blob sha), which makes it a no-op. Reason:
   workflow files run with the repo's secrets and the org's runners; the per-kind templates already own
   `.github/workflows/site.yml`; and the ERP App should not need `workflows: write`. So the scaffolder stops emitting
   `.github/workflows/qa-harness.yml` (astro); the QA-harness workflow moves to the static template when webdev P5 lands
   (`qa-harness-workflow.ts` stays as its reference text).
7. **The base tree.** A path that the template holds as a directory, a symlink or a submodule, or whose parent the template holds
   as a file, is refused (`scaffold_path_conflicts_template`). A base tree that already has a root `CONTRACT.lock` is not
   pristine (`scaffold_repo_not_pristine`).
8. **At GitHub.** Every blob sha GitHub returns must equal the git blob sha computed locally from the verified bytes
   (`github_blob_sha_mismatch`), so the bytes that land are provably the bytes that were checked.

## Scope of the write

- **Which repo.** Only the repo GH-12 created for THIS provisioned row: `provider = 'erp_repo'`, `provider_ref` = an
  `automation_approvals` row with `origin = 'github'`, `workflow_id = 'github:create_repo'`, `status = 'approved'`; the repo is
  `config.githubOrg` / that approval's `tool_args.name`, and `repo_url` must point at exactly that repo
  (`scaffold_repo_unresolved` otherwise). The site's `completion_state` must be `complete` (`scaffold_site_not_complete`) and
  the request's `runId` must equal the row's `pipeline_run_id` (`scaffold_run_mismatch`).
- **First fill only.** The default branch head must be the template-generated commit: a commit with no parents (GitHub's
  template generation always produces exactly one), whose tree carries no `CONTRACT.lock`. Anything else is
  `scaffold_repo_not_pristine`: a human commit, a template that adds its own commits, a force-push.
- **Idempotent re-submit.** The identity of a tree is the sha256 of its canonical manifest (sorted `path`, `sha256`, `bytes`). Once
  `committed`, the same manifest returns the recorded commit and makes no GitHub call (`outcome: "already_committed"`); a
  different manifest is `scaffold_already_committed`.
- **Out of scope:** a re-scaffold over a filled repo. It overwrites human work, so it is a separate, human-approved feature
  (a D14-gated write with its own executable-registry pairing), not something the unattended first-fill path may grow into.

## The state machine (`webdev_provisioned_sites.scaffold_state`, migration `202610122130_webdev_scaffold_commit.sql`)

```
NULL ──[claim]──> pending ──[objects]──> commit_created ──[ref]──> committed
```

- **claim** (under the site's provisioning lock, after every integrity check and the pristine read): records the manifest digest,
  the snapshot id, the branch, the base (template) commit sha, file count, total bytes, the goal id and the actor.
  A row already `pending`/`commit_created` with the SAME digest is resumed. One with a DIFFERENT digest is superseded only
  while nothing has landed (the ref is still the recorded base), else `scaffold_repo_not_pristine`.
- **objects** (outside the lock; blobs, trees and commits are content-addressed, so a repeat is harmless): blobs (skipping any
  the base tree already holds), one tree on `base_tree`, one commit whose parent is the base and whose author and committer
  are the acting principal's user (§4.4; the ledger's `push` attribution), message trailers `Gaiada-Activity:` (the ledger
  correlation id), `Gaiada-Provisioned-Site:` and `Gaiada-Contract-Snapshot:`. Recorded as `commit_created` (tree and commit
  sha) under the lock, only if the claim still holds the same digest.
- **ref** (under the lock): read the branch head. Equal to the recorded commit: the update landed and the answer was lost, so
  record `committed`. Equal to the base: `PATCH …/git/refs/heads/<branch>` with `force: false`, then `committed`. Anything else:
  `scaffold_repo_not_pristine`, recorded, state kept. GitHub's fast-forward check makes the update race-safe even against a
  human push landing between the read and the write.
- **Crash between "commit created" and "ref updated"** resumes from the recorded commit sha, never a second commit. A crash before
  `commit_created` was recorded leaves only a dangling commit object at GitHub (never referenced), and the next attempt makes
  a new one.
- Every step that cannot finish records `scaffold_error` (a typed token) and keeps the state. The two GitHub writes
  (objects, ref) are each wrapped in `withGithubLedger` (`action: "push"`, attribution required), so `activities` holds the
  attempted/succeeded/failed rows.
- Schema invariants: a state only with its links (`wps_scaffold_links`), and only on a `complete` site.

## Authorization decision

- **Hub:** `webdev.provisionedSites.commitScaffold` is `write: true`, **`impact: "low"`**, `minAssurance: "low"`, allow-listed for
  `wf:delivery` only. An unattended `wf:delivery` run executes it without a new approval. Why that is acceptable:
  1. The repo was created by a company_admin's D14 approval (GH-12, HIGH) for exactly this provisioning, and §08 defines
     provisioning as "a private GitHub repo from a per-kind template, the right folder structure inside it, …". M6-P4c already
     ruled that one approval covers the registry row, the WebDesk tenant and the pin; the first fill is the last leg of the same
     provisioning, deciding nothing new (repo, snapshot and kind all come from the approved, completed row).
  2. The tool can do nothing BUT a first fill: it refuses any write over a commit that is not the template's, so it never
     overwrites human work, and it is reversible (the template commit stays the parent; resetting the branch undoes it).
  3. The content is pinned: integrity-checked against the manifest and the site's own pinned contract snapshot.
  4. `resource_github_repo.yaml` already classifies `push` as ordinary write traffic, role-tier gated and NOT D14-gated
     (GH-03, coordinator ruling 2026-08-31); D14 is reserved there for deploy, secret writes and repo create/delete.
  If the tool ever grows a re-scaffold, it must become `medium` with an executable-registry pairing; that is why re-scaffold is
  a separate tool, out of scope here.
- **Platform:** two existing gates, no policy change: `webdev_provisioned_site · provision` on the request tenant (the first fill
  completes §08's provisioning; same tier as `reconcile`: company_admin, manager, the webdev module manager, platform_admin),
  then `github_repo · push` on the **GitHub org tenant** resolved by `resolveGithubOrgTenant` (the GHT-1 order WSK-60's
  `workflow-dispatch.ts` follows), which is also the tenant the ERP App credential and the ledger rows live under.
  `wf:delivery` is a `manager` service account (`seed/automation.ts`), so it passes both.
- **Cerbos artifacts touched: none.** No new kind, no new action, no edit to `resource_mcp_tool.yaml` (a low-impact write passes
  its generic impact conjunct by attributes; no executable-list entry is needed because a low write never suspends).

## The delivery flow

`pipeline-delivery.json`, code stage: `Provisioning complete?` now forwards the provisioned `siteId`, and `MCP code.scaffold`
sends `provisionedSiteId: $json.siteId`. The commit is triggered by the goal's completion (the job), not by a second workflow
node: the workflow stays one synchronous pass, and the bytes never enter n8n. The stage's `artifactRef` still holds the
`code.scaffold` reply; the commit outcome is in the goal's blackboard and on the provisioned row (`scaffold` on
`GET provisioned-sites/:id`).

## Out of scope / follow-ups

- Re-scaffold over a filled repo (human-approved, medium, its own executable pairing).
- The Web Dev review gate opens when the job is queued, not when the commit lands (unchanged from M6-P4e). A goal-completion
  event that wakes the workflow would let the gate wait for the commit.
- Raising the 1 MiB body limit for this route (URL-scoped hook), when a real tree needs more than 600 KiB.
- Moving the QA-harness workflow into the static template (with webdev P5).
