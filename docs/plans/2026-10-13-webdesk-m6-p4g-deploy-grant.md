# M6-P4g: the deploy gate is the org secret grant

Status: PLANNED → IN PROGRESS (this ticket). Parent plan: `docs/plans/2026-10-11-webdesk-m6-plan.md` (row M6-P4g, and
§2's "design call put to the owner with O-3"). Builds on M6-P4b2 (`docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md`).
Design: `docs/blueprints/webdesk-design-v2.md` §08 (the two gates) and WSK-D29.

## The rule in one paragraph

A provisioned site's repo may READ the org's deploy secrets only once the ERP has proved that the repo is a registered,
locked repo: it has a live `webdev_sites` row and its default branch carries a `CONTRACT.lock` that names the site's
pinned contract snapshot. The ERP then adds the repo to each deploy secret's "selected repositories" list. A repo without
the grant holds nothing to deploy with, and the templates' `site.yml` step "Require deploy grant" fails the run in plain
sight when `secrets.WEBDESK_DEPLOY_GRANT` is empty. **The ERP never holds, reads or writes a secret value (D29)**: it only
changes which repositories may read a secret the owner created.

GitHub calls (all through `githubRequest()`, the §4.1 chokepoint, with the `erp` App, under the GitHub org tenant):

```
GET    /repos/{o}/{r}                                                 -> id, default_branch
GET    /repos/{o}/{r}/git/ref/heads/{branch}                          -> the head commit
GET    /repos/{o}/{r}/contents/CONTRACT.lock?ref={head}               -> the lock at that head
GET    /orgs/{org}/actions/secrets/{name}                             -> exists? visibility == "selected"?
PUT    /orgs/{org}/actions/secrets/{name}/repositories/{repo_id}      -> 204 (idempotent)
DELETE /orgs/{org}/actions/secrets/{name}/repositories/{repo_id}      -> 204 (idempotent)
```

The org-secret calls need the App's **Organization permissions → Secrets: read and write** (`organization_secrets: write`,
O-3). Measured 2026-10-12: the live installation has repository `secrets: write` only. Until the owner grants it, GitHub
answers 403 "Resource not accessible by integration", which the ERP reports as
`github_permission_missing: organization_secrets` (503), recorded on the site, never a generic 500.

## Amendment from M6-P6a (2026-10-13): two kinds of deploy secret

P6's credential model is one deploy principal per site and environment, locked to one document root. Its CI copy is an
org Actions secret created BY HAND by an org owner, with visibility limited to exactly that site's repo. A shared
account-wide secret would give every granted repo write access to every document root (and the staging account also
carries live client WordPress). So a grant covers:

1. **the fixed list**, `WEBDESK_DEPLOY_SECRET_NAMES` (default `WEBDESK_DEPLOY_GRANT`, the marker the templates check);
2. **one per-site secret**, named by ONE function, `siteDeploySecretName()` in `modules/webdev/deploy-grant.ts`:

   ```
   WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>    e.g. WEBDESK_DEPLOY_ACME_SITE_STAGING_123456789
   ```

   **Amended by M6-P6f (2026-10-13):** the last part was `<H8>` (8 hex of sha256(the provisioned site's id)); it is now the
   GitHub repository's numeric id, `<REPOID>`. A site repo's own workflow must derive the name of its own secret and never
   sees a provisioned site's id, while every workflow knows `github.repository_id`; a repository id is unique across GitHub,
   so it keeps H8's anti-collision job. `<SLUG>` is taken from the resolved repo's name (the slug in the normal case, and all
   the workflow can see). The ERP only learns the id at the grant's first read of the repo, so before then it shows no name
   and says why (`siteSecretNote`). The text below describes the original H8 design; read `<H8>` as `<REPOID>` and "the
   provisioned site's id" as "the repository's GitHub id".

   `<SLUG>` is the provisioned slug and `<ENV>` the registry row's `environment` (provisioned rows are `staging`), each
   uppercased with every non-alphanumeric character turned into `_`. **The readable part alone can collide**: slugs are
   unique only per company (`ux_wps_slug` is `(tenant_id, slug)`) while org secret names are org-wide, and the `_`
   mapping merges slugs that differ only by `-` versus `_`. So `<H8>`, the first 8 hex of sha256(the provisioned
   site's id), is part of the name: it is the identity. The derived name is recorded on the row at claim
   (`deploy_grant_site_secret_name`), re-derived and compared under the lock, and only ever PUT with this site's own
   repository id. No caller supplies it, so no other site's grant can name it.

**A secret that does not exist yet (404) is not an error.** The grant is recorded as `pending`, the name goes into
`deploy_grant_pending_names` and the answer's `pending`, `deploy_grant_error` stays empty, and a later run (the POST
route, or the next scaffold re-submit, which is never short-circuited while `pending`) completes it once the owner has
created the secret. Until P6, every site therefore rests at `pending` with its per-site name listed, while the fixed
marker is already granted (so the template's "Require deploy grant" step passes). Authorization and the GitHub calls are
unchanged: the same `GET` metadata, `PUT` and `DELETE …/repositories/{id}` per name.

## Amendment from M6-P6h2 (2026-10-13): one per-site secret per registry environment

M6-P6h added the production promote, and its target derivation needs the repo's PRODUCTION per-site secret among the granted
names. The grant used to compute ONE per-site name, from the staging row's `environment`, so every promote was refused
`production_secret_not_granted` and dispatched nothing. A grant now covers:

1. the fixed list; and
2. **one per-site secret per environment the site has in the registry**: ALWAYS the staging row's name, PLUS the production
   name when the site has a **live production row**: the `webdev_sites` row with `promoted_from_site_id` = the staging row and
   `deleted_at IS NULL`, created by M6-P6g's `POST sites/:id/production`. Both come from the same function
   (`siteDeploySecretName`, slug = the resolved repo's name) and the same repository id: `WEBDESK_DEPLOY_<SLUG>_STAGING_<REPOID>`
   and `WEBDESK_DEPLOY_<SLUG>_PRODUCTION_<REPOID>`. Neither is ever taken from a caller.

Everything else about a name is unchanged: a 404 secret is `pending` (not an error); a secret not set to "selected repositories"
is `not_selected`, an error that is never written through; a missing `organization_secrets` permission (O-3) stops the whole
grant as `github_permission_missing: organization_secrets`; the claim commits before any GitHub write and the grant runs under
the site lock; the names that landed are recorded even when a later one fails.

**How the two names are recorded: no new column.** `deploy_grant_site_secret_name` stays the STAGING row's name (the name the
claim records and the superseded check compares; its shape CHECK already fits both environments). The production name is
derivable, so it needs no column of its own: once its `PUT` landed it is in `deploy_grant_secret_names`, and while the owner
has not created the secret it is in `deploy_grant_pending_names`. The console and the answers say where each stands in an
additive `siteSecrets: [{environment, name, status: granted|pending|not_granted}]` (the DTO derives it from the row, the repo
name in `repo_url`, the recorded repository id and the live production row; `[]` while the name is not derivable).

**One schema change, because of the state.** `wps_deploy_grant_links` said `granted` holds no pending name. A site granted at
staging that then gets a production row, whose production secret the owner has not created yet, must list that name as pending,
and demoting the site to `pending` instead would stop the STAGING rebuilds it already has (a build target needs the grant
`granted`, M6-P6h). Migration `202610132340_webdev_deploy_grant_granted_with_pending.sql` therefore removes that one term from
the constraint, rebuilt from the LIVE definition (`pg_get_constraintdef`) with before/after assertions; every other clause is
kept. `granted` now means "a full grant landed (its time, at least one name)". Names added later wait in
`deploy_grant_pending_names` until a grant run lands them, which clears the list; the state only moves on a claim, a full
grant or a revoke. Nothing should read "pending names is empty" as a fact about `granted`: a build target asks about ONE name
(`perSiteSecretGranted`), and the recorded names are exact (a name is recorded only when its PUT landed, and a revoke clears
them). Consequence for P6h: a granted site whose production secret is still being created refuses the promote
(`production_secret_not_granted`) and keeps rebuilding staging.

**Revoke** removes the fixed list ∪ the recorded names ∪ the recorded staging name ∪ **every derivable per-site name**:
staging and production, whether or not a production row exists now (a removed row, or a secret created by hand before the
row, must not leave the repo able to read it). A name that was never created is a 404, which is nothing to revoke. This is
the same function the archive path calls (M6-P4g2's `revokeDeployAfterArchive` goes through `revokeDeployForSite`), so the
archive revokes both names with no change of its own.

**Trigger.** `POST sites/:id/production` re-runs the grant best effort after the production row is created
(`followProductionRow` in `deploy-grant.service.ts`, called by the controller; `:id` is the staging `webdev_sites` row, and
the provisioned site is found through `webdev_provisioned_sites.webdev_site_id`). It is the AUTOMATIC path, so like the
post-scaffold trigger it never re-grants a `revoked` site (`skipped_revoked`, no GitHub call). It never throws and never
fails the request: the 201 carries an additive `deployGrant` summary (or `null` when the staging row belongs to no provisioned
site), a refusal is data in `deployGrant.error` and is recorded on the row. It runs under the caller's own principal and needs
the grant's two checks (`webdev_provisioned_site` provision + `github_repo` push on the org tenant), so a caller who holds only
`webdev_site` create gets `outcome: "refused", error: "forbidden"`; the row is still created and the operator's
`POST …/deploy-grant` is the retry. An already-granted site is not short-circuited once a production row exists (the held
names no longer cover the names the site now needs), so the trigger lands the new name; one granted for BOTH names makes no
GitHub call.

**What the owner does:** create the org Actions secret `WEBDESK_DEPLOY_<SLUG>_PRODUCTION_<REPOID>` by hand (visibility
"Selected repositories", this repo only), exactly as `deployGrant.siteSecrets` shows, then re-drive the grant
(`POST …/provisioned-sites/:id/deploy-grant`). Until then a promote is refused `production_secret_not_granted`; nothing is
dispatched.

## Conditions, checked fresh at every grant

All are re-derived at grant time; none is trusted from the caller. Each failure is a typed token; the site's own facts
(rows 2 to 5 and 7) are checked before the repo is resolved (rows 3 and 6), then the lock (8 to 10).

| # | Condition | Token |
|---|---|---|
| 1 | The deploy secret names are configured and valid (`WEBDESK_DEPLOY_SECRET_NAMES`, default `WEBDESK_DEPLOY_GRANT`) | `deploy_grant_not_configured` (503) |
| 2 | The provisioned site exists (RLS: the request tenant, `webdev` wall) | 404 |
| 3 | It is an ERP repo control row (`provider = 'erp_repo'`) and the repo is the one GH-12 created for it (P4b2's `resolveRepo`: an approved `github:create_repo` approval, `config.githubOrg` / its name, `repo_url` naming exactly that repo) | `deploy_grant_repo_unresolved` (409) |
| 4 | §08 completion is `complete` (pinned snapshot) and the repo step is `provisioned`/`live` | `deploy_grant_site_not_complete` (409) |
| 5 | The linked `webdev_sites` row exists, is not deleted and is `origin = 'provisioned'` | `deploy_grant_no_registry_row` (409) |
| 6 | That registry row's `repo_url` names the same repo | `deploy_grant_registry_mismatch` (409) |
| 7 | P4b2's scaffold state is `committed` | `deploy_grant_not_committed` (409) |
| 8 | The default branch exists and carries a root `CONTRACT.lock` at its head, read through the contents API at that exact commit | `deploy_grant_no_lock` (409) |
| 9 | The lock parses as the five-key §06 object (P4b2's `parseContractLock`) | `deploy_grant_lock_invalid` (409) |
| 10 | The lock names the site's PINNED snapshot, with the same contract version, vocabulary version and content hash (P4b2's `checkLockAgainstPin`) | `deploy_grant_lock_mismatch` (409) |

Conditions 2 to 7 are read again under the site's provisioning lock immediately before any GitHub write.

Per secret (reported per name, never a crash):

| GitHub answer | Result |
|---|---|
| `GET` secret 404 | `missing`: the owner has not created it YET. Not an error: the grant stays `pending` and the name is listed in `deploy_grant_pending_names` / the answer's `pending` |
| `GET` secret, visibility `all` or `private` | `not_selected`: NOT written. A secret visible to all private repos voids the gate, so this is reported loudly: `deploy_grant_secret_not_selected: <names>` |
| `PUT` 204 | `granted` |
| `PUT` 409 | `not_selected` (the visibility changed between the read and the write) |
| any call 403 "not accessible by integration" | the whole grant stops: `github_permission_missing: organization_secrets` (503) |

## State (`webdev_provisioned_sites.deploy_grant_*`, migration `202610130100_webdev_deploy_grant.sql`)

```
NULL ──[claim]──> pending ──[every secret granted]──> granted
pending | granted ──[revoke]──> revoked
revoked ──[operator POST only]──> pending ──> granted
```

- **claim** (one transaction under the provisioning lock, COMMITTED before any write to GitHub): the snapshot the lock
  names, the GitHub repository id, the head commit the lock was read at, and the requesting principal. Committing the
  claim first is what makes revoke safe after a crash: once a PUT may have landed, the row already says `pending`.
- **grant** (a second transaction under the same lock, so a grant and a revoke never interleave): one `PUT` per secret,
  each in its own `withGithubLedger` (`action: "secret_write"`, the acting principal, `approvalId` = the site's GH-12
  approval, `basis: deploy-gate-grant / WSK-D29`, `secretName`). The names that landed are recorded even when a later
  name fails, so a partial grant is visible and a re-run completes it (GitHub's PUT is idempotent). All names granted:
  `granted`, `deploy_grant_granted_at`, error cleared, event `webdev.site.deploy_granted`.
- `deploy_grant_site_secret_name` is the STAGING per-site name (amendments above; the production name is derived, see the
  M6-P6h2 amendment); `deploy_grant_pending_names` the names not created yet. M6-P6h2: `granted` may list a pending name that
  was added after the grant (a production secret not created yet); a first grant is `granted` only when no name is pending.
- `deploy_grant_secret_names` is the set the repo is known to hold. It only grows until a revoke: a name removed from the
  configuration is NOT forgotten, so a revoke still removes it.
- **revoke** (under the lock): one `DELETE` per secret in the fixed list ∪ recorded ∪ every derivable per-site name, staging and production
  (M6-P6h2) (`deploy-gate-revoke / WSK-D29`, with the reason). 404 means nothing to revoke. Then `revoked`, `deploy_grant_revoked_at`, `_revoked_by`, `_revoke_reason`, the
  names cleared, event `webdev.site.deploy_revoked`. A 409 (the secret is visible to all repos) keeps the state and
  records `deploy_grant_secret_not_selected`, because "revoked" would then be false. A site the ERP never granted
  (`NULL`) is still swept defensively (the DELETEs run), but no state is recorded.
- Schema invariants (`wps_deploy_grant_links`): a grant state only on a `committed` scaffold, with its claim facts;
  `granted` with its time and at least one name (M6-P6h2, migration `202610132340`: no longer "and no pending name");
  `revoked` with its time and reason. Repository id positive, head sha 40
  hex, names valid GitHub secret names.
- **A failed re-check does not revoke.** A granted repo whose lock was later removed keeps its grant until an operator (or
  the archive path) revokes it; the template's own workflow also refuses without `CONTRACT.lock`. A scheduled re-check
  that revokes is a follow-up.

## Trigger

**Inline, at the end of the scaffold commit, as a separate step after `committed` is recorded** (in
`commitScaffoldForSite`, not inside P4b2's state machine).

- The commit's own state machine is untouched and stays crash-safe: `committed` is written in its own transaction before
  the grant starts, so a grant failure (for example O-3 not yet in effect) can neither undo nor block the first fill.
  The commit route still answers 200 with the commit; the grant's result rides along as an additive `deployGrant`
  object, and its error is recorded on the row.
- Why not a next scaffold state: it would couple two state machines, and a GitHub permission gap would make a landed
  scaffold read as unfinished. Why not an outbox consumer on `webdev.site.scaffold_committed`: consumers are
  Redis-gated (dark by default) and run with no principal, while the ledger needs the acting one.
- No new approval. The company admin's GH-12 approval (D14, HIGH) covers this provisioning; the grant adds no decision
  (repo, snapshot and secret names are all facts the ERP re-derives) and only lets a provably registered, locked repo READ
  secrets it is meant to deploy with. It is reversible (`DELETE`).
- A second automatic trigger (M6-P6h2): `POST sites/:id/production` re-runs the grant after the production row is created
  (amendment above). Same rules: best effort, never throws, never re-grants a `revoked` site.
- Resume paths: the scaffold job re-submitting the same tree (`already_committed`) re-runs the grant when it is not yet
  `granted` with the same names and snapshot; and the explicit route below. **The automatic path never re-grants a
  `revoked` site**: an operator's revoke is only undone by an operator's POST.

## Routes

- `POST /api/:t/modules/webdev/provisioned-sites/:id/deploy-grant`: re-check every condition and grant (idempotent).
  Body ignored. 200 `{outcome: "granted"|"already_granted"|"partial", state, repo, repositoryId, snapshotId, headSha,
  secrets: [{name, result}]}`.
- `DELETE /api/:t/modules/webdev/provisioned-sites/:id/deploy-grant`: revoke. Body `{reason}` (required, 8 to 500
  characters). 200 `{outcome: "revoked"|"not_granted"|"partial", state, secrets: [{name, result}]}`.
- `GET …/provisioned-sites/:id` gains an additive `deployGrant` object.
- No hub tool. The delivery flow gets the grant inline from `webdev.provisionedSites.commitScaffold`, so agents and n8n
  never reach either route: an operator re-drive or revoke is a human action.

## Authorization (no Cerbos change)

Every entry point (the scaffold follow-on, POST and DELETE) calls the same two existing checks inside the service, so no
rule lives only in the controller:

1. `webdev_provisioned_site · provision` on the request tenant (company_admin, manager, the webdev module manager,
   platform_admin; not low assurance). The grant is the last leg of §08's provisioning, exactly as the first fill is.
2. `github_repo · push` on the GitHub ORG tenant (`resolveGithubOrgTenant`, GHT-1 order: resolve, then authorize against
   the resolved tenant).

These are the pair that authorized the first fill. The ledger still records the true verb (`github.secret_write`), the
GH-12 approval and the basis (the WSK-D65 precedent for an action authorized by something other than its own D14 gate).
`github_repo · secret_write` (D14-gated, company_admin or module_manager with an approval id) is deliberately NOT used: it
means writing a credential, which this never does, and `wf:delivery` (a manager) could not pass it, so the automatic
path would always be refused.

**Revoke** is the fail-safe direction (it removes access) but it can stop a live site's deploys, so it is treated as at
least a medium write: the same two checks as the grant, a human only (no hub tool, so no unattended caller), not at low
assurance (both policies require `notLow`), a mandatory reason recorded on the row and in each ledger row, and it is
validated only AFTER authorization (a denied caller learns nothing from a malformed body).

## The exception path ("a bypass is recorded as an exception with a reason")

**Not built; a follow-up.** A manual grant for a repo that fails the conditions needs a D14 approval kind, an
executable-registry pairing and a company-admin-only gate. That is not small, and a half-built bypass is worse than none.
Today a bypass can only be made by an org owner in GitHub's UI, outside the ERP, and the ERP's revoke still removes it.

## The archive / registry-removal hook

**No code path archives or deletes a `webdev_sites` row today** (no writer sets `deleted_at`; `webdesk.site.archive` is a
501 stub). So there is nothing to hook into. What exists instead:

- the explicit revoke route above, and `revokeDeployForSite()` (`deploy-grant.service.ts`), which **any future archive or
  registry-removal path must call** before it soft-deletes the row (M6-P4g2's `revokeDeployAfterArchive` does, for a WebDesk
  site archive; since M6-P6h2 its revoke covers the production name too);
- condition 5: a deleted registry row can never be (re-)granted.

## What the owner must do in GitHub for this to work live

1. On the `gaiada-erp` App: Settings → Permissions → **Organization permissions → Secrets: Read and write**; then, as org
   owner, **accept the updated permissions** on the org's installation (O-3).
2. Create the org Actions secret **`WEBDESK_DEPLOY_GRANT`** (org Settings → Secrets and variables → Actions → New
   organization secret), with **Repository access: "Selected repositories"** and no repository selected. Its value is
   any non-empty marker; the template only checks that it is non-empty. Real deploy credentials (O-1, P6) are created
   the same way, with "Selected repositories", and their names added to `WEBDESK_DEPLOY_SECRET_NAMES`
   (comma-separated) in the platform's environment.
3. Per site, when P6 lands: create the per-site secret named exactly as the site's `deployGrant.siteSecretName` (also in
   `pendingNames` and in the grant answer's `pending`), with "Selected repositories" = that site's repo only. Then
   re-drive the grant (step 5); it completes from `pending` to `granted`. Once the site has a production row (M6-P6h2), do
   the same for the production name in `deployGrant.siteSecrets` (`environment: "production"`).
4. Never set a deploy secret to "All repositories" or "Private repositories": that grants it to every repo and voids
   the gate. The ERP refuses to grant through such a secret and reports `deploy_grant_secret_not_selected`.
5. Then re-drive each site already scaffolded: `POST …/provisioned-sites/:id/deploy-grant`.

## Out of scope / follow-ups

- The exception path (above).
- A scheduled re-check that revokes a repo which lost its lock or its registry row.
- Wiring the grant into the hourly `reconcile` resume path, so pending grants heal on their own once O-3 is granted.
- The archive path itself, which must call `revokeDeployForSite()`.
- ai-agents' `ScaffoldCommitReply` type may name the additive `deployGrant` field (it already passes through untouched).
- A check that the per-site secret's selected repositories hold no OTHER repo (an owner's mistake at creation), via
  `GET …/secrets/{name}/repositories`. Not built: the amendment kept the GitHub calls unchanged.
