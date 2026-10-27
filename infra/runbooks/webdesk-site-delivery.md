# Runbook - deliver a WebDesk site: principal, vault, secret, grant, bind, key, staging, DNS, promote (M6-P6k)

**Status: BUILT, NEVER RUN.** Every route, field and token below was read from the code and docs at `dc636175`. **No one has
run this page end to end, and nothing here has touched a real host.** It becomes DEV-VERIFIED only after the P6 gate's first
run follows it from this page alone. If a step is wrong, fix the page in the same change.

**Four steps cannot finish today.** They are marked **BLOCKED** where they occur and listed in "Not built yet" at the end.

| Gap | Effect today |
|---|---|
| **O-3** | The GitHub App lacks `organization_secrets`. Every live grant fails `github_permission_missing: organization_secrets`. |
| **M6-P6h2** | The grant does not grant the PRODUCTION per-site secret. Every promote fails `production_secret_not_granted`. |
| **M6-P6l** | The fullstack API on a Node host is not built. `deploy-api` refuses and uploads nothing. |
| **M6-P6b** | The hosting-account facts (hPanel: plan, transport, per-docroot principal) are owner-supplied and pending. |

Plan: `docs/plans/2026-10-11-webdesk-m6-plan.md` (M6-P6k, section 6.3). Rulings: `docs/blueprints/webdesk-design-v2.md` section 14,
WSK-D79 (delivery is per site), D29 (the ERP never holds a deploy credential), D81, D82, D83.

**This repo is public.** Write no secret value, host name, user name or client name into it. This page uses placeholders:

| Placeholder | Meaning |
|---|---|
| `<t>` | the company's tenant id in `/api/<t>/...` |
| `<id>` | a provisioned site's id (`GET provisioned-sites`) |
| `<staging-row>`, `<prod-row>` | the `webdev_sites` row ids of the two environments (`delivery.environments[].siteId`) |
| `<slug>`, `<repo-id>` | the repo's name and GitHub numeric id |
| `<tenant-slug>`, `<site-id>`, `<env-id>` | the WebDesk tenant slug, the WebDesk site id and an environment id (from `GET control/sites`) |
| `<vault-id>` | an `integration_connections` id |
| `<docroot>`, `<wp-root>` | the document root's name, and the WordPress root |

All BFF routes below are under `/api/<t>/modules/webdev/` unless a path starts with `/api/<t>/` itself.

## At a glance

Run steps 1 to 5 once per site, and again for the production environment. Steps 6 to 10 follow in order.

| # | Step | Who | Done when |
|---|---|---|---|
| 0 | Preconditions | owner, operator | the site is provisioned and its scaffold is committed |
| 1 | Mint the principal | operator, on the host | a docroot-locked login exists and a test upload works |
| 2 | The vault record | staff, then the operator | `GET integrations/connections` shows `status: linked`, `hasToken: true` |
| 3 | The org secret and the grant | org owner, then staff | `deployGrant.state` is `granted` |
| 4 | Bind the delivery target | staff | `delivery.environments[].state` is `ready` |
| 5 | The content key | two staff, then the operator | repo secrets `WEBDESK_API_KEY` and `WEBDESK_HOST` exist |
| 6 | Staging deploy | operator, then staff | the staging URL serves a stamp with this build's id |
| 7 | Domain and DNS | staff, the domain's owner | `check.state` is `pointing` and the environment has the domain |
| 8 | Promote | two staff | the production URL serves a stamp naming the approval (BLOCKED, M6-P6h2) |
| 9 | Rotate | operator, org owner | the new credential deploys and the old one is refused |
| 10 | Roll back | operator | the previous release serves again, its stamp read back |
| 11 | Teardown | two staff, operator | the grant is revoked and the host principal is gone |

## 0. Preconditions

**Who:** owner, operator. **Read, do not change.**

1. The site is provisioned. `GET provisioned-sites/<id>` shows:
   - `completion.state` = `complete`;
   - `scaffold.state` = `committed`;
   - `delivery.environments` has the staging row. This gives you `<staging-row>`.

   The staff click or the signed PRD produce this. Their runbooks are not repeated here.
2. The org Actions secret **`WEBDESK_DEPLOY_GRANT`** exists, with "Selected repositories" and no repository selected. Its value is any non-empty marker. The templates' `deploy` job fails without it.
3. The ERP's control channel to WebDesk is live. Without it every approval in this runbook ends `webdesk_not_configured` or `webdesk_unavailable`.
   - [webdesk-control-channel.md](./webdesk-control-channel.md): makes the ERP-to-WebDesk channel real.
   - [webdesk-ws4-keys.md](./webdesk-ws4-keys.md): installs and rotates the keys that sign each approved HIGH command.
   - [webdesk-editorial-keys.md](./webdesk-editorial-keys.md): installs and rotates the keys that sign publishes.
4. The `gaiada-erp` GitHub App is installed on the repo, with `Actions: write` (a dispatch needs it) and, for the grant, **`Organization permissions: Secrets: read and write`** (O-3, BLOCKED until the owner grants and accepts it).

**Refusals you may see here:** none; this step only reads.

## 1. Mint the principal

**Who:** the operator, in the hosting panel (by hand). No panel API is known, so nothing automates this (M6-P6b still owes the account facts). **Once per site and per environment.**

**What you make:** one login that can reach ONE document root and nothing else. Never reuse a login across sites or environments, and never use the account owner's login or the host's account-wide API token.

**Shape (from `webdesk/templates/_deploy/README.md`, "The per-site deploy secret"):**
- the transport is `sftp` or `ftps` (explicit TLS). Plain FTP is refused by name;
- the login has a password, or for `sftp` a private key;
- you note the host, the port, the pinned identity and the paths you will need in step 3;
- the identity is pinned. For `sftp`, pin the host key line(s) (`knownHosts`, `[host]:port` form for a non-22 port). For `ftps`, pin the certificate fingerprint (`certSha256`) or the CA (`caPem`). A secret with no pin is refused.

**Static and fullstack:** `remoteBase` is the parent of the docroot (it also holds `releases/` and the lock), and `docroot` is its name inside the base.
**wp:** `remoteBase` is the WordPress root (the directory that holds `wp-content/`). The deploy writes only `wp-content/themes/gaiada-webdesk/`, and keeps its releases in `wp-content/.webdesk-deploy/`. WordPress must already be installed.

**Success looks like:** you log in as the new principal from outside the host, upload a throwaway file inside the docroot, and are refused on any other site's root. Delete the throwaway file.

**Refusals:** none from the ERP. The host's own refusal is the control.

## 2. The vault record

**Who:** staff in the console create the record. The operator seals the credential into it.

**Why a record:** the vault is the custody copy (WSK-D33 option (c)). It is also what step 4 points at, and what lets you reveal the credential later for a rollback or a rotation. The org secret in step 3 is a second copy; a rotation changes both.

**2a. Create the record (staff, a manager or above; M6-P6o2).** Make the row's OWN record, once per row (the staging row, and the production row, each get their own):

    POST /api/<t>/modules/webdev/sites/<row>/deploy-credentials
    {"provider":"ssh","externalAccount":"<label, no secret>"}

- `provider` is `ssh` for SFTP, `ftp` for FTPS. It must match the `access` you bind in step 4.
- The record belongs to that row (`ownerKind: "webdev_site"`, `ownerId: <row>`). The bind and the write accept it for that row only. Another site's record, or the same site's other environment's record, is refused `vault_ref_wrong_owner`.
- **No token is accepted over HTTP.** The record starts `unconfigured`, and a repeat create returns the same `id`. Keep that `id` as `<vault-id>`.
- See the row's records: `GET /api/<t>/modules/webdev/sites/<row>/deploy-credentials`.
- Records made earlier still work. A `company` record (`POST /api/<t>/integrations/connections {"provider":"ssh","ownerKind":"company"}`) or one owned by the site's own client is still accepted by the bind. A `user` record is refused. Prefer the row's own record for new sites.

**2b. Seal the credential into it (staff, a manager or above; M6-P6o, WSK-D88).**

    PUT /api/<t>/modules/webdev/deploy-credentials/<vault-id>
    {"credential": {"version":1,"environment":"staging","transport":"sftp","host":"<host>","port":<port>,"user":"<principal>","password":"<secret>","knownHosts":"<pinned line>","remoteBase":"<base>","docroot":"<docroot>","siteUrl":"https://<staging-domain>"}}

- `credential` is the per-site deploy secret's JSON, exactly the shape in step 3b's table (the ERP checks it with the same rules as the deploy job's `deploy-from-secret.sh`). Type it into the request once, from the host's own panel. Do not save it in a file.
- The ERP stores it as one canonical line, sealed in the vault, and never shows it again. The answer is the masked record (`hasToken: true`, `status: "linked"`) and a `sealedVersion` (a hash of the ciphertext, not of the value).
- `ssh` records take `transport: sftp`; `ftp` records take `transport: ftps`. The record must be the row's own, the company's, or the site's own client's.
- A row's own record takes that row's `environment` only: a staging credential into the production row's record is refused `deploy_credential_wrong_record: environment`.
- This replaces the local VLT-4 script (`scripts/vault-import-hosting-credentials.local.mjs`) for deploy principals. Delete the credential from any local credentials file in the same sitting.
- **One record per owner and provider.** The vault holds one `ssh` and one `ftp` record per owner. Since M6-P6o2 each row is an owner, so every site and every environment has its own `ssh` and `ftp` record and nothing collides. A `company` record is still one per company: two company sites cannot share it as separate principals, so give each row its own record (2a).

**2c. Write the org secret from the vault (two staff; M6-P6o, WSK-D88).** Do this after the bind (step 4), because the write reads the row's `vaultRef`.

    POST sites/<staging-row>/deploy-secret        {"reason":"<optional, why now>"}

- `201 {approvalId}`. This files ONE HIGH approval. A **second** person approves it in the Approvals inbox (`POST /api/<t>/automation-approvals/<approvalId>/decide {"decision":"approved"}`). The requester can never approve their own request (`403 self_approval`).
- The approver needs `company_admin` (the generic decide) and `github_repo · secret_write` (company_admin or the webdev module manager). On approval the ERP decrypts the record in memory, seals it to the organisation's public key and writes `WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>` with "Selected repositories". A new secret starts visible to no repository; the grant (step 3c, run automatically after the write) adds this site's repo once every deploy-gate condition holds.
- **This replaces step 3b's hand-made secret** wherever O-3 is in effect. Until then the write fails `github_permission_missing: organization_secrets` and nothing is written.
- Check where it stands: `GET sites/<staging-row>/deploy-secret`. `written` means GitHub holds what the vault holds. `pending` with a `reason` is NOT success. `stale` means the vault was resealed and the rewrite is not approved yet (step 9).

**Success looks like:** `GET /api/<t>/modules/webdev/sites/<row>/deploy-credentials` shows the record with `status: "linked"` and `hasToken: true` (for an older company record: `GET /api/<t>/integrations/connections?owner=company&provider=ssh`), and `GET sites/<row>/deploy-secret` shows `state: "written"`. The plaintext is never in any response.

**Refusals you may see:**
| Token / status | Meaning |
|---|---|
| 400 `provider must be one of ...` | The provider is not one of `github,google_drive,claude,cpanel,ftp,ssh,wp_admin`. |
| 403 | You are not a manager or above for a vault record (create, seal; a row's own record also needs `webdev_site · update`), or you lack `provision` + `github_repo · push` (file). |
| 400 `deploy_secret_body_invalid` | The seal body is not exactly `{credential}`, or the filing body is not empty or `{reason}`. |
| 422 `deploy_credential_invalid` | The credential does not have the documented shape. The reason names the fields, never a value. |
| 422 `deploy_credential_wrong_record` | sftp into an `ftp` record (or ftps into `ssh`), a user's record, or a revoked one. For a row's own record: `environment` (the credential is for the other environment) or `owner` (its row was deleted or is not staging or production). |
| 400 `deploy_secret_body_invalid` (2a) | The create body is not exactly `{provider: "ssh"\|"ftp"}` or `{provider, externalAccount}`. |
| 409 `deploy_secret_not_deliverable` (2a) | The row is a preview or development row; only staging and production rows get a deploy record. |
| 503 `deploy_secret_not_configured` | `INTEGRATION_TOKEN_KEY` is not set on the platform. Nothing is stored unencrypted. |
| 409 `deploy_secret_no_vault_record` | The row is not bound to a vault record (step 4). |
| 422 `deploy_secret_vault_unusable` | The bound record is not linked, has the wrong provider or the wrong owner. |
| 409 `deploy_secret_site_revoked` | The site's deploy grant is revoked (an archived site keeps no deploy access, WSK-D82). Nothing is written. |
| 409 `deploy_secret_request_open` | A write for this row already waits for approval. |
| 403 `self_approval` | The requester tried to approve their own write. Ask someone else. |
| `github_permission_missing: organization_secrets` (the write fails; the decision stands) | **O-3.** The App lacks the org-secrets permission. BLOCKED until the owner grants it and accepts it on the installation. |
| `deploy_secret_vault_changed` (the write fails) | The record was resealed or re-bound after the request was filed. File a new request. |
| `deploy_secret_credential_mismatch: environment`, `transport` or `docroot` (the write fails) | A staging credential on a production row (or the reverse), a transport that does not match the record, or a static site's credential without `docroot`. |

## 3. The org secret and the grant

Two halves. The org owner makes the secret. Staff make the ERP grant the repo read access to it. **The ERP never reads, holds or writes the secret value** (D29).

### 3a. Read the exact name

    GET provisioned-sites/<id>

- `deployGrant.siteSecretName` is the name to create: `WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>`, for example `WEBDESK_DEPLOY_ACME_SITE_STAGING_123456789` (a placeholder).
  - `<SLUG>` is the repo's name and `<ENV>` is `STAGING` or `PRODUCTION`. Each is uppercased, with every character outside `A-Z0-9` turned into `_`.
  - `<REPOID>` is the GitHub repository's numeric id.
- Until the first grant has read the repo, `siteSecretName` is `null` and `siteSecretNote` says why. Run 3c once to learn the name.
- The workflow derives the same name with `.webdesk/deploy/secret-name.sh`, so a name you type by hand and get wrong simply never matches.
- The ERP records and lists only the STAGING name (see 3d).

### 3b. Create the secret (the org owner, by hand, in GitHub)

1. Org Settings, Secrets and variables, Actions, **New organization secret**. Name: exactly the name above.
2. **Repository access: "Selected repositories", and select ONLY this site's repo.** Never "All repositories" or "Private repositories": that voids the gate, and the ERP refuses to grant through such a secret (`deploy_grant_secret_not_selected`).
3. The value is ONE minified JSON object on one line. Fields (from `_deploy/README.md`; any other field is refused, and a message names the field, never a value):

| Field | Required | Notes |
|---|---|---|
| `version` | yes | the number `1` |
| `environment` | yes | `staging`, `production` or `development`; must equal the run's environment |
| `transport` | yes | `sftp` or `ftps` |
| `host`, `user` | yes | the host and the principal from step 1 |
| `port` | no | default 22 (sftp) or 21 (ftps) |
| `password` or `privateKey` | one | `privateKey` is sftp only |
| `knownHosts` | sftp: yes | the pinned host key line(s) |
| `certSha256` or `caPem` | ftps: one | the pinned identity |
| `checkHostname` | no | ftps; default true |
| `remoteBase` | yes | see step 1 |
| `docroot` | static: yes | its name inside `remoteBase`; ignored for wp |
| `siteUrl` | yes | the `https://` origin the stamp is read from |

Placeholder shape, not a credential:

    {"version":1,"environment":"staging","transport":"sftp","host":"<host>","port":<port>,"user":"<principal>","password":"<secret>","knownHosts":"<pinned line>","remoteBase":"<base>","docroot":"<docroot>","siteUrl":"https://<staging-domain>"}

The org secret does not exist until you create it. That is fine: the grant waits (3c).

### 3c. Grant (staff)

    POST provisioned-sites/<id>/deploy-grant        (no body)

Authorization is `webdev_provisioned_site` `provision` on the company, then `github_repo` `push` on the GitHub org tenant. A low-assurance session is refused. It re-checks every condition at that moment and is safe to repeat.

**Success looks like:** `200 {outcome: "granted" | "already_granted" | "partial", state, repo, repositoryId, snapshotId, headSha, secrets: [{name, result}]}`, and on `GET provisioned-sites/<id>`:
- `deployGrant.state` = `granted`, with `pendingNames` empty and `error` empty;
- each `secrets[].result` is `granted`.

A `result` of `missing` is not an error: the owner has not created that secret yet. The state rests at `pending` and `pendingNames` lists it. Create it (3b), then POST again.

### 3d. What the grant covers today

- The fixed gate flag `WEBDESK_DEPLOY_GRANT` (the list is `WEBDESK_DEPLOY_SECRET_NAMES` in the platform's environment; default `WEBDESK_DEPLOY_GRANT`).
- The STAGING per-site secret.
- **Not the PRODUCTION one. This is M6-P6h2.** A promote is refused `production_secret_not_granted` and dispatches nothing (step 8). Creating the production secret by hand in GitHub does not change that: the ERP decides from what it has recorded as granted.

The grant also runs by itself, after the scaffold's first fill. That automatic path never undoes an operator's revoke.

**Refusals you may see:**

| Token | Status | Meaning |
|---|---|---|
| `deploy_grant_not_configured` | 503 | `WEBDESK_DEPLOY_SECRET_NAMES` holds an invalid or repeated name. |
| `deploy_grant_repo_unresolved` | 409 | The repo is not the one GH-12 created for this site. |
| `deploy_grant_site_not_complete` | 409 | The pinned contract or the repo step is not complete. |
| `deploy_grant_no_registry_row` | 409 | There is no live provisioned `webdev_sites` row. |
| `deploy_grant_registry_mismatch` | 409 | The registry row names a different repo. |
| `deploy_grant_not_committed` | 409 | The scaffold's first fill is not `committed`. |
| `deploy_grant_no_lock` | 409 | The default branch has no `CONTRACT.lock` at its head. |
| `deploy_grant_lock_invalid` | 409 | `CONTRACT.lock` does not parse. |
| `deploy_grant_lock_mismatch` | 409 | The lock does not name the site's pinned snapshot. |
| `deploy_grant_superseded` | 409 | The site changed under the grant. Run it again. |
| `deploy_grant_secret_not_selected: <name>` | recorded on the row | The secret's visibility is not "Selected repositories". Fix it in GitHub. Nothing was written. |
| `github_permission_missing: organization_secrets` | 503 | **O-3.** The App lacks the org-secrets permission. BLOCKED until the owner grants it and accepts it on the installation. |
| `github_app_not_installed`, `github_not_configured`, `github_org_unavailable` | 503 | The App is not installed on the repo, has no credential, or the company's org tenant cannot be resolved. |
| `github_rate_limited` | 429 | Wait. |
| `github_request_failed` | 502 | GitHub or the network failed. |

## 4. Bind the delivery target

**Who:** staff holding `webdev_site` `update` (manager tier). **Precondition:** the vault record is `linked` (step 2).

    POST sites/<staging-row>/delivery-binding
    {"hostKind":"shared-hosting","hostRef":"<opaque-label>","access":"ssh","vaultRef":"<vault-id>"}

- The body is EXACTLY these four keys. A `host`, `username`, `path` or `password` key is a 400: nothing of the kind has a column.
- `hostKind` is `shared-hosting`, or `our-box` for `delphi`/`helios`.
- `hostRef` is an opaque label, `^[a-z0-9][a-z0-9_-]{0,62}$` (no dot, `@`, slash, colon or space), such as `hostinger-1`.
- `access` is `ssh` (SFTP) or `ftp` (FTPS). It must match the vault record's provider.
- A re-bind replaces all four facts. Bind each environment's row separately.
- This is the HOST side. It does not touch the GitHub grant, and neither implies the other.

**Success looks like:** `200` with `deliveryState`, and `GET provisioned-sites/<id>` shows `delivery.environments[].state` = `ready` for that row (`awaiting_deploy_credential` until then).

**Refusals you may see:**

| Token | Status | Meaning |
|---|---|---|
| `binding_body_invalid` | 400 | Not exactly the four string keys. |
| `host_kind_not_bindable` | 400 | `hostKind` is not `shared-hosting` or `our-box`. |
| `host_ref_invalid` | 400 | `hostRef` is not an opaque label. |
| `access_not_bindable` | 400 | `access` is not `ssh` or `ftp`. |
| `vault_ref_invalid` | 400 | `vaultRef` is not a uuid. |
| `vault_ref_unknown` | 422 | No such record in this tenant. Another tenant's record gives the same answer. |
| `vault_ref_wrong_provider` | 422 | `ssh` needs a provider `ssh` record, and `ftp` needs `ftp`. |
| `vault_ref_not_linked` | 422 | No credential is sealed in the record (step 2b). |
| `vault_ref_wrong_owner` | 422 | The record belongs to a user, to another client, or is another row's own record (another site, or this site's other environment; M6-P6o2). |
| `site_environment_not_deliverable` | 409 | Only a `staging` or `production` row can be bound. |
| 404 | | Unknown or foreign site. |

**The production row.** Create it once, from the staging row, when the production domain is known:

    POST sites/<staging-row>/production
    {"domain":"<production-domain>"}

`201`. It copies project, client, kind, repo and adoption, and starts unbound. Then repeat steps 1 to 4 for it (principal, vault record, secret `...PRODUCTION...`, bind). Refusals: `production_body_invalid` (400, exactly `{domain}`), `production_domain_invalid` (400), `not_a_provisioned_staging_row` (409), `production_row_exists` (409, once only), `domain_taken` (409), `property_domain_conflict` (409, the domain's search property belongs to another client).

## 5. The content key

**What it is:** the key the site's BUILD job reads content with. It is the only credential the build job holds. The plan (section 6.3) names it as a `read` key for the production environment of the WebDesk site (WSK-66 `key.mint`); `envId` picks the environment, so choose the one the build reads from.

**5a. File the request (staff holding `promote` on `webdev_provisioned_site`):**

    POST control/sites/<site-id>/keys
    {"tenantSlug":"<tenant-slug>","envId":"<env-id>","scope":"read"}

- `<site-id>`, `<tenant-slug>` and `<env-id>` come from `GET control/sites`.
- It answers `202 {approvalId}`. Filing again for the same site, environment and scope returns the open request with `alreadyPending: true`.

**5b. Approve it (a DIFFERENT authorised user, in the Approvals inbox):**

    POST /api/<t>/automation-approvals/<approvalId>/decide
    {"decision":"approved"}

The result carries `command: "key.mint"`, `executionStatus: "executed"`, `apiKeyId`, `envId`, `scope` and **`plaintextOnce`**. That is the ONLY copy. It is never stored, logged or shown again.

**5c. Paste it (the operator, by hand, once):** in the SITE repo's Actions secrets set `WEBDESK_API_KEY` to the key. Also set `WEBDESK_HOST` (a secret or a variable; the WebDesk public API host). Then close the page that showed the key.
- **fullstack:** also set `WEBDESK_TENANT_SLUG` (a secret or variable).
- **wp:** the theme reads `GAIADA_WEBDESK_BASE_URL`, `GAIADA_WEBDESK_TENANT` and `GAIADA_WEBDESK_API_KEY` from `wp-config.php` constants or environment variables. Set the three on the host by hand. Until all three are set, every page answers 503. The wp build job needs none of them.

**Success looks like:** the approval is `executed`, and the secrets exist. The first staging build (step 6) reads content with the key.

**Refusals you may see:**

| Token | Meaning |
|---|---|
| 400 `invalid_request` | The body is not exactly `{tenantSlug, envId, scope}`, or `scope` is not `read`/`write`. |
| 404 `site-not-found` | The pair `(tenantSlug, siteId)` is not an active site of this company. |
| 404 `environment-not-found` | `envId` is not one of this site's environments. |
| decide: 403 `not authorized: a key mint may not be approved by the principal who requested it` | The decider is the requester. A key mint is never self-approved. |
| decide: 403 or `webdesk_denied` | The decider lacks `promote` on the site. |
| decide: `webdesk_not_configured`, `webdesk_unavailable`, `webdesk_unreachable` | The control channel is not up. Nothing was minted. |
| decide: `webdesk_refused: <status> <slug>` | WebDesk refused the command. |
| decide: `webdesk_ambiguous` | The answer was lost. A key may exist. Check the site's keys in WebDesk first. **Never resend.** |

## 6. Staging deploy

**Who:** the operator (a push) or two staff (a content publish). **Preconditions:** steps 1 to 5 done for the STAGING row; `deployGrant.state` = `granted` (**BLOCKED live until O-3**).

**Two things deploy staging:**
- **A push to the repo's default branch.** `.github/workflows/site.yml` builds, writes the stamp, and its `deploy` job runs. A push to any other branch or tag, or a pull request, builds and verifies and deploys nothing.
- **The ERP's dispatch** after an approved content publish, or an approved `content.rebuild`: it runs `site.yml` with `kind=publish` or `rebuild`. Its stamp is proved against the approval. The runbook for the editor flow, the states and the failure reasons is [webdesk-staging-rebuild.md](./webdesk-staging-rebuild.md) (it describes the hand-built proof site; the template path reads the registry instead).
- A **wp** site's staging is never rebuilt on a publish: its theme reads WebDesk live. The ERP records nothing and says `rebuild_not_applicable`. A wp site deploys its theme by a push, and by a promote.
- A **fullstack** site's web half deploys like static. **Its API leg is M6-P6l and refuses**: the `deploy-api` job fails with "the fullstack API deploy to a Node host is M6-P6l, not built yet" and uploads nothing.

**What the deploy job does** (`webdesk/templates/_deploy/README.md`): it checks `WEBDESK_DEPLOY_GRANT`, finds the per-site secret by its derived name, verifies the artifact against its manifest, uploads to a new release directory, reads every file back and compares sha256, swaps the docroot with two renames, reads the stamp over HTTPS, and keeps the newest three releases (the live one plus two).

**Success looks like (read all three):**
1. The run is green.
2. `https://<staging-domain>/webdesk-build.json` (for wp: `https://<staging-domain>/wp-content/themes/gaiada-webdesk/webdesk-build.json`) shows `buildId` of the run, `environment` `staging`, and for a dispatch the `approvalId`. The deploy script itself refuses to finish unless the site serves that `buildId`.
3. `GET provisioned-sites/<id>`, `builds.environments[]` for `staging`: `target.ready` is `true`, and `latest.state` is `live` (it is `rebuilding` until the stamp proves it, and `unverified` after the poll window, 20 minutes by default, without proof, which is NOT live).

**Typed refusals (the deploy job's own, in the run log):**

| Message | Meaning |
|---|---|
| "this repo has not been granted deploy access" | `WEBDESK_DEPLOY_GRANT` is empty. Step 3. |
| "the per-site deploy secret `<name>` does not exist yet or is not granted to this repo; see the console's pending list" | Step 3b, or the grant (3c) has not completed. |
| "`CONTRACT.lock` is missing" | The repo was not filled by `code.scaffold`. |
| `deploy-from-secret`: exit 2 | The secret's shape is wrong (the message names the FIELD), or its `environment` differs from the run's, or plain FTP. |
| `deploy.sh` exit 3 | Lock held by another deploy. Wait. |
| exit 4 | A file read back differs from the manifest; nothing was activated. |
| exit 5, 6 | Activation failed or the stamp did not show the build; the swap was undone. |
| exit 7 | The host refused an operation (a permission or a quota). |

**ERP-side failure reasons (`builds...latest.failureReason`, and `webdesk_rebuild_failed: <reason>` on an approval):**

| Reason | Meaning |
|---|---|
| `rebuild_not_configured` | No `WEBDESK_REBUILD_TARGETS` entry and no provisioned site linked to this WebDesk tenant. |
| `rebuild_target_ambiguous` | Two provisioned sites claim the same WebDesk tenant. |
| `rebuild_target_incomplete` | The site is not scaffolded and complete, or has no default branch or live row. |
| `rebuild_not_applicable` | A wp site on a publish: nothing to rebuild. |
| `site_url_unknown` | The environment's registry row still has the `.provisioned.invalid` domain. Claim the domain (step 7). |
| `deploy_not_granted` | The staging per-site secret is not granted. Step 3. |
| `github_app_not_installed`, `github_app_permission_missing`, `workflow_not_found`, `workflow_not_dispatchable`, `github_not_configured`, `github_org_unavailable`, `github_rate_limited`, `github_dispatch_failed` | See the failure-reasons table in webdesk-staging-rebuild.md. |
| `deploy_denied` | The approver lacks `github_repo` `deploy` on the org tenant. |
| `decider_inactive`, `dispatch_unconfirmed`, `build_ledger_unavailable` | See the same table. |

A push deploy needs only the secret's own `siteUrl`. The ERP-driven rebuild needs the staging row's real domain, so claim it (step 7) before relying on a publish to reach staging.

## 7. Domain and DNS

**Who:** staff claim; the owner (our domains) or the client (theirs) edits the records. **No DNS credential is stored and no DNS API is called, anywhere.**

Run [webdesk-domain-dns.md](./webdesk-domain-dns.md) for each environment's row in this order. It achieves the following, in five steps:

1. **Claim the real domain** on the registry row, once: `POST sites/<row>/domain {"domain":"..."}`. It also creates or links the domain's search property. A client's property starts unverified, so monitoring probes nothing until consent is granted.
2. **Bind the delivery target** (step 4 above).
3. **Read the records to create:** `GET sites/<row>/dns` returns `checklist.state` (`not_claimed`, `needs_binding`, `target_unknown`, `ready`) and the `records`. `target_unknown` means the operator must document the host's DNS target in `WEBDEV_DNS_TARGETS`.
4. **Create the records** in the DNS panel and read again until `check.state` is `pointing`.
5. **Give the WebDesk environment the domain** (so browser calls to WebDesk are answered): `POST control/sites/<site-id>/domain {"tenantSlug","envId","domain"}` files one HIGH approval; a DIFFERENT `company_admin` approves it.

**Success looks like:** `check.state` = `pointing`; the approval's result shows `domain` and `previousDomain`; TLS is valid on the domain (the host's free certificate needs DNS pointing first, M6-P6b to confirm).

`pointing` is a DNS fact only. It is not consent to probe and says nothing about TLS.

The refusals (`domain-not-claimed`, `domain-environment-mismatch`, `domain-site-mismatch`, `domain-request-pending`, `domain-unchanged`, `property_domain_conflict`, `domain_already_set`) are explained in the "When something is off" table of that runbook.

## 8. Promote (production)

**Status: BLOCKED by M6-P6h2.** The routes and the deploy job exist. The grant does not cover the production per-site secret, so every promote fails `production_secret_not_granted`. Do not work around it.

**Preconditions:**
- a production registry row exists, with a real domain (step 4, "The production row");
- the production row is bound (step 4) and its principal, vault record and per-site secret exist (steps 1 to 3);
- the STAGING deploy is live and checked (step 6), and the production domain is claimed (step 7).

**8a. File (staff holding `promote` on `webdev_provisioned_site`):**

    POST control/sites/<site-id>/promote
    {"tenantSlug":"<tenant-slug>"}

It answers `202 {approvalId}` and deploys nothing. The target (repo, branch, production URL) is the registry's, never the caller's. Filing again returns the open request with `alreadyPending: true`.

**8b. Approve (a DIFFERENT user who ALSO holds `github_repo` `deploy` with this approval id):** `POST /api/<t>/automation-approvals/<approvalId>/decide {"decision":"approved"}`. The one action is a `workflow_dispatch` of `site.yml` with `kind=promote`, `environment=production` and the approval id. A production deploy never happens from a push, from a publish or without an approval id: the workflow refuses those loudly.

**Success looks like:**
- the decide result: `command: "site.promote"`, `executionStatus: "executed"`, `environment: "production"`, `build.state: "rebuilding"`;
- later, `builds.environments[]` for `production`: `latest.kind` = `promote`, `latest.state` = `live`;
- `https://<production-domain>/webdesk-build.json` shows `environment` `production` and `approvalId` equal to the approval. A promote is `live` only through this stamp. If it is not proved within 20 minutes it is `unverified`, never `live`.
- A decided approval presented again is a 404 and runs nothing.

**Refusals you may see (typed, in order):**

| Token | Where | Meaning |
|---|---|---|
| 400 `invalid_request` | filing | The body is not exactly `{tenantSlug}`. |
| 404 `site-not-found`, 409 `site-archived` | filing | Not an active site of this company. |
| 409 `promote-not-ready` + `reason` | filing | The target does not resolve. `reason` is one of the tokens below. |
| 409 `promote-in-flight` | filing, execution | A production promote of this site is still deploying. GitHub keeps only one waiting run, so a second could replace the first. Wait for `live` or `unverified`. |
| `webdesk_promote_failed: <reason>` | decide | The dispatch did not happen. A failed row is written and nothing was dispatched. |
| `production_not_registered` | reason | No production row. `POST sites/<staging-row>/production`. |
| `site_url_unknown` | reason | The production row still has the placeholder domain. |
| `production_secret_not_granted` | reason | **M6-P6h2.** The production per-site secret is not granted. |
| `rebuild_target_incomplete`, `rebuild_target_ambiguous` | reason | As in step 6. |
| `deploy_denied` | reason | The approver lacks `github_repo` `deploy`. |
| 403 `not authorized: a production promote may not be approved by the principal who requested it` | decide | The decider is the requester. Use a different user. |
| `webdesk_denied` | decide | The decider lacks `promote` on the site. |

## 9. Rotate

There are two copies of a deploy credential (the vault record and the org secret) and one on the host. A rotation changes all three, in this order, so there is never a window where nothing works.

**9a. The deploy principal (the operator, with an org owner):**

1. Mint a NEW principal on the host, for the same docroot (step 1). Do not touch the old one yet.
2. Prove the new one logs in, outside the system.
3. Reseal the vault record with the new credential. This is `docs/runbooks/credential-vault-rotation.md` section 1, steps 4 to 5 (and BLOCKED the same way as step 2b if the seal path is not available).
4. The org owner updates the per-site org secret's JSON by hand with the new credential. The name, the repo list and the visibility do not change.
5. Run a deploy (step 6 for staging) and read the stamp back. This proves the new credential end to end.
6. Delete the OLD principal on the host, then try it and confirm the host refuses it. A rotation nobody confirmed dead is not a rotation.

Never rotate `INTEGRATION_TOKEN_KEY`: that loses every sealed row. `docs/runbooks/credential-vault-rotation.md` section 2 says why.

**9b. The content key:** `POST control/keys/:keyId/rotate` and `POST control/keys/:keyId/revoke` are **501 stubs** (`webdesk_control_plane_not_wired`). To replace a key today: mint a new `read` key (step 5), paste it over `WEBDESK_API_KEY` (and the wp constant), run a deploy. There is no ERP route that revokes the old key. Not built; no ticket named in the code. Report it.

**9c. The WS4 and editorial signing keys** are separate keys with their own rotation:
[webdesk-ws4-keys.md](./webdesk-ws4-keys.md) and [webdesk-editorial-keys.md](./webdesk-editorial-keys.md).

## 10. Roll back

Each deploy keeps the live release plus two older ones on the host, and **a rollback is the same two-rename swap the other way**, so it also rolls forward. `deploy.sh` in `rollback` mode takes the lock, swaps the newest older release (or `DEPLOY_ROLLBACK_TO`) back in, requires THAT release's stamp to be served, and undoes itself if it is not. Expect about one round trip of 404s (about 0.2 to 0.5 s over a WAN) while the docroot name is missing.

**What triggers it today:** nothing in the console. The `site.yml` workflow has no rollback input, and `POST control/sites/<site-id>/rollback` is a **501 stub** (`webdesk_control_plane_not_wired`). **Run it by hand:**

1. Reveal the credential for the environment (staff file a reveal request on the vault record, a different manager approves, and the requester redeems it within 15 minutes; the value is shown once):
   - `POST /api/<t>/integrations/connections/<vault-id>/reveal-requests` with `{"reason":"..."}`;
   - `POST /api/<t>/automation-approvals/<approvalId>/decide` with `{"decision":"approved"}` (a different person);
   - `POST /api/<t>/integrations/connections/<vault-id>/reveal` with `{"approvalId":"..."}`.
2. From a clone of the site repo (or `webdesk/templates/_deploy/`), on a machine with `bash`, `lftp`, `openssh-client`, `openssl`, `curl`, `jq`: export `DEPLOY_SECRET_JSON` (the per-site secret's JSON, from the value you hold, never on a command line), `DEPLOY_SITE_KIND` (`static` or `wp`; a fullstack web half is `static`), `DEPLOY_ENVIRONMENT`, `DEPLOY_MODE=rollback`, and for wp `DEPLOY_WP_THEME=gaiada-webdesk`. Optionally `DEPLOY_ROLLBACK_TO=<release id>`. Then run `bash .webdesk/deploy/deploy-from-secret.sh`. Do not enable `set -x`: the script refuses it.
3. Success looks like: `ROLLBACK OK release=<id> build=<id>`, and the site's own `webdesk-build.json` shows that older build id.
4. Clear the shell's variables.

**Refusals:** exit 2 (config or secret shape), 3 (lock held), 4 (`rollback: there is no older release to go back to`, `no such release`, or the release has no stamp to prove itself), 5 (the swap failed and was undone), 6 (the stamp did not show the build; the previous release is live again). If both the swap back and the check fail the script says to check the docroot by hand.

**A content or code change can also be rolled back forward:** revert on the default branch and push (staging), or an approved promote of the reverted default branch (production). A rollback by hand does not change the repo, so the next push redeploys the newer build.

### Clearing a domain

`site.setDomain` is reversible, and so is a claim of the WebDesk environment's domain:
1. Read the executed approval's `previousDomain`.
2. File `POST control/sites/<site-id>/domain` again with that `domain`, or `"domain": null` to clear it. A different `company_admin` approves it.
3. A clear needs no claim and answers no browser origin at all. A restore of a domain that is no longer on the registry is refused `domain-not-claimed`: clear instead.
4. This does not edit DNS and does not release the registry's claim. Records are the owner's or the client's to remove.

Details and the drill: the "Rollback" section of [webdesk-domain-dns.md](./webdesk-domain-dns.md).

## 11. Teardown

**An archive revokes the deploy grant (M6-P4g2, WSK-D82).**

1. **Staff file the archive:** `POST control/sites/<site-id>/archive {"tenantSlug":"<tenant-slug>"}` answers `202 {approvalId}`. **It is irreversible in WebDesk**: the site stops serving content and takes no writes, and there is no un-archive.
2. **A DIFFERENT authorised user approves it** (`decide`). The result is `command: "site.archive"`, `executionStatus: "executed"`, `status: "archived"`, and `deployRevoke[]`, one entry per linked provisioned repo, each `outcome` `revoked`, `not_granted`, `partial` or `failed`.
3. **A `partial` or `failed` revoke does not undo the archive.** Re-run it by hand:

       DELETE provisioned-sites/<id>/deploy-grant
       {"reason":"<8 to 500 characters>"}

   It answers `200 {outcome: "revoked" | "not_granted" | "partial", state, secrets: [{name, result}]}`. `reason` is required and validated after authorization. A `409` on a secret visible to all repos keeps the state and records `deploy_grant_secret_not_selected`. Only an operator's `POST deploy-grant` undoes a revoke.
4. **By hand, the rest** (nothing in the ERP does it):
   - the org owner deletes each per-site org secret;
   - the operator deletes each per-site principal on the host, and the site's files if the client has left;
   - staff revoke each vault record: `DELETE /api/<t>/integrations/connections/<vault-id>` (a soft revoke: the status becomes `revoked` and the token columns are cleared);
   - clear the site repo's `WEBDESK_API_KEY`;
   - the registry rows are NOT removed: no code path deletes them. The grant's own state records the revoke.

## Troubleshooting: failure tokens

| Token | Where you see it | Step | First thing to do |
|---|---|---|---|
| `github_permission_missing: organization_secrets` | `deployGrant.error`; the grant (503) | 3 | **O-3.** The owner adds Secrets: read and write to the App, then accepts it on the installation. |
| `deploy_grant_secret_not_selected: <name>` | `deployGrant.error` | 3 | Set the secret's access to "Selected repositories" in GitHub. |
| `pending` with `pendingNames` | `deployGrant.state` | 3 | Create the named org secret, then `POST deploy-grant` again. |
| `deploy_grant_no_lock`, `_lock_invalid`, `_lock_mismatch` | the grant | 3 | The default branch's `CONTRACT.lock` is missing or not this site's pinned snapshot. |
| `vault_ref_not_linked` | bind | 2, 4 | Seal a credential into the record (2b). |
| `vault_ref_wrong_provider` | bind | 2, 4 | `ssh` needs a provider `ssh` record; `ftp` needs `ftp`. |
| `vault_ref_unknown` | bind | 4 | The id is wrong or belongs to another tenant. |
| `awaiting_deploy_credential` | `delivery.environments[].state` | 4 | The binding is incomplete, or the record lost its credential. |
| `deploy_not_granted` | staging build | 3, 6 | Staging per-site secret is not granted. |
| `site_url_unknown` | staging build or promote | 7 | Claim the environment's real domain on its registry row. |
| `rebuild_not_applicable` | staging build | 6 | Not an error. A wp theme reads WebDesk live. |
| `production_not_registered` | promote | 4, 8 | `POST sites/<staging-row>/production {domain}`. |
| `production_secret_not_granted` | promote | 8 | **M6-P6h2.** Not fixable by the operator today. |
| `promote_in_flight` / `promote-in-flight` | promote | 8 | Wait for the earlier promote to go `live` or `unverified`. |
| `unverified` | `latest.state` | 6, 8 | 20 minutes passed with no proving stamp. Not live. Check the Actions run, then the served stamp by hand. |
| `deploy_denied` | a dispatch | 6, 8 | The approver needs `github_repo` `deploy` on the org tenant. |
| `webdesk_ambiguous` | decide | 5, 7, 11 | The answer was lost. Read WebDesk's state first. Never resend. |
| `webdesk_not_configured`, `webdesk_unavailable`, `webdesk_unreachable` | decide | 5, 7, 8, 11 | The control channel is down or not set up. Section 0, item 3. |
| the per-site secret `<name>` "does not exist yet or is not granted to this repo" | the deploy job | 3 | Name mismatch, not created, or not granted. |
| "the fullstack API deploy to a Node host is M6-P6l, not built yet" | the `deploy-api` job | 6 | Expected. The API half is not built. |
| `WEBDESK_HOST is not set` | a fullstack build | 5 | Set `WEBDESK_HOST`, `WEBDESK_API_KEY` and `WEBDESK_TENANT_SLUG` (D83). |
| every wp page answers 503 | the live site | 5 | The three `GAIADA_WEBDESK_*` values are not all set on the host. |
| `webdesk_control_plane_not_wired` (501) | `deploy/staging`, `rollback`, `keys/:keyId/rotate`, `keys/:keyId/revoke`, `sites/:siteId/status`, `submissions` | 9, 10 | Expected. These routes are stubs. |

## Not built yet

| What | Ticket or state | Effect on this page |
|---|---|---|
| The org-secrets permission on the GitHub App | **O-3** (owner) | Every live grant fails; steps 3, 6, 8 cannot finish on a real org. |
| The grant of the PRODUCTION per-site secret | **M6-P6h2** | Every promote fails `production_secret_not_granted`. |
| The fullstack API on a Node host | **M6-P6l** | `deploy-api` refuses; only the web half deploys. |
| The hosting-account facts (principal locking, transport per plan, docroot swap, TLS, CDN) | **M6-P6b** (owner at the panel) | Step 1 is by hand; every claim about the host is unmeasured. |
| A tracked path to seal a hosting credential into the vault | VLT-4 (the import script is local and untracked) | Step 2b cannot be done from the repo. |
| A console or route for rollback | `POST control/sites/:siteId/rollback` is a 501 stub | Step 10 is by hand. |
| ERP revoke or rotate of a WebDesk content key | `keys/:keyId/rotate` and `/revoke` are 501 stubs | Step 9b is partly by hand. |
| A scheduled re-check that revokes a repo that lost its lock | listed as a follow-up in `docs/plans/2026-10-13-webdesk-m6-p4g-deploy-grant.md` | A granted repo keeps its grant until revoked. |

**The P6 gate** (`docs/plans/2026-10-11-webdesk-m6-plan.md`, "M6-P6 gate") is the first run of this page. Whoever runs it fixes this page where it was wrong, and records the date here.
