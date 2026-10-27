# Runbook - the social simulator: turn it on, seed the mock clients, turn it off, purge (SCP-Sa, SCP-Sb)

**Status: PLANNED.** Nothing here has been run on a server. The orchestrator or the owner runs every live step, one at a
time, and pastes the real output into the hand-back. Plan: `docs/plans/2026-10-15-social-content-pipeline.md` section 5
(SCP-D1, SCP-D3). Contract: `docs/FRONTEND-BFF-CONTRACT.md` section 63.1 file 8 and section 63.16. The containment is
SCP-Sa's (`platform-nest/src/modules/social/publisher/simulation.ts`, six fences); this runbook is the operator's side of it.

The repo is PUBLIC. Every value below is a `<placeholder>`; real ids, tokens and addresses stay on the server.

## What the simulator is, in one paragraph

With `SOCIAL_SIMULATION_ENABLED` on, the social module can publish a post that never leaves the ERP: a variant whose
account is marked `simulated` goes through the real approval and dispatch path to an in-process simulator, which answers
with a link under `https://simulated.invalid/` (it can never resolve) and marks the variant `simulated`. That is a post that
never appeared on a client's account while the calendar says it did, so the switch is **for the dev review only**, and it
refuses to run beside anything real: boot aborts if a real publisher is configured, if any live OAuth grant exists, or if
**any** `social_accounts` row is not simulated (in any company, soft-deleted rows included). A real account cannot be
connected while it is on. It is off by default and is switched off, with the simulated rows purged, **before the ERP holds
real client data**.

House rules for any `.env` change on the ERP box (back up `.env` first, pass `GAIADA_TAG` and `APP_VERSION` inline, recreate
only `platform` with `--no-deps`, never `--remove-orphans`, prove the variable reached the container, one step at a time) are
in `infra/runbooks/portal-go-live.md`, "House rules for flag flips on this estate". They apply to every recreate below.

## 0. Preconditions

1. The release carrying SCP-Sa and SCP-Sb is deployed (the migration `<prefix>_social_simulation.sql` has run, and the
   `simulated-accounts` routes exist).
2. **The compose passthrough.** `SOCIAL_SIMULATION_ENABLED` is read from the container's environment, and a variable in `.env`
   does nothing unless the platform service's `environment:` block lists it. As of SCP-Sb the VPS compose file does not carry
   the row; it needs
   `SOCIAL_SIMULATION_ENABLED: ${SOCIAL_SIMULATION_ENABLED:-}` in the `platform` service of
   `infra/compose/docker-compose.vps.yml`. Prove it after the recreate (step 3), do not assume it.
3. **No real publisher.** `SOCIAL_POSTIZ_BASE_URL` and `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` are unset on the platform
   service (boot refuses the switch otherwise).
4. **TikTok.** `SOCIAL_NETWORKS_ENABLED` defaults to `instagram,facebook,linkedin`; TikTok is off at the deployment level.
   The seeded TikTok account satisfies the pipeline's account guards (`final_approve`, `reschedule`), but a TikTok variant
   refuses to publish with `network_disabled` until the variable names it, for example
   `SOCIAL_NETWORKS_ENABLED=instagram,facebook,linkedin,tiktok`. Extending it is the owner's call and is not needed to seed.
5. A database backup first: `~/gaiada/infra/scripts/backup.sh`. Note the file names.

## 1. Prepare the database (dry run first)

Boot refuses the switch while any non-simulated account exists. The prepare script lists them and marks the plainly-mock ones.
It runs **before** the switch is on and can run any number of times.

```sh
# DRY RUN: reads only. One block per company; ids, client names and reasons.
docker exec gaiada-platform-1 node dist/seed/social-simulation-prepare.js
echo "exit=$?"        # 0 = nothing would block the switch; 2 = something still would (or an error)
```

Read every line. What it prints, per company (deleted companies included):

- `WOULD MARK` - an account the **CP-21 demo seed** wrote. The rule is a fingerprint, not a name: its publisher org's
  `api_key_ref` is exactly `seed:portal-demo-no-key`, its org id is exactly `seed-<its client id>`, it was never connected to an
  engine (no integration id, no `connected_by`), no OAuth grant of any status names it, and no variant on it carries a provider
  post id, a published time or is a native import. Soft-deleted rows are classified by the same rule.
- `UNCLASSIFIED` - every other non-simulated account, with the reasons it failed the rule. **The script never touches these.**
  A person decides each: it is not plainly mock seed, so either remove it through the module's own tools (after checking it
  is really mock) or do not turn the switch on.
- `LIVE OAUTH GRANT` - an active grant (LinkedIn or YouTube) that boot also refuses. Never touched; it is revoked through the
  module's disconnect flow.

If the dry run is what you expect, mark the `WOULD MARK` rows:

```sh
docker exec gaiada-platform-1 node dist/seed/social-simulation-prepare.js --apply
echo "exit=$?"
```

`--apply` runs one transaction per company, sets `simulated = true` on exactly the classified ids and nothing else (no row is
deleted, no status, handle, org or integration id changes, no soft-delete is cleared), checks the row count against the plan
and rolls the company back on a mismatch, and writes one activity row per company. It is idempotent. The exit code is the
prediction of boot: **do not go on until it is `0`.**

## 2. Turn the switch on

```sh
cd ~/gaiada/infra/compose
cp .env .env.bak-sim-on-<yyyymmdd>
# set SOCIAL_SIMULATION_ENABLED=1 in .env, then the recreate (portal-go-live.md, house rule 3)
```

## 3. Prove it

```sh
docker exec gaiada-platform-1 printenv SOCIAL_SIMULATION_ENABLED        # 1
curl -s <the platform health URL> | grep -o '"socialSimulation":[a-z]*'   # "socialSimulation":true
docker logs gaiada-platform-1 2>&1 | grep 'social:simulation-enabled'    # one WARNING line on every start
```

If the container exits at start with `BOOT ERROR: SOCIAL_SIMULATION_ENABLED is on while ...`, the message names which fence
refused (a real engine, a live grant, or N non-simulated rows). Revert the `.env` line (step 5), fix the named cause, and
repeat from step 1.

## 4. Seed the mock clients' simulated accounts

One call per client, as one of the four Social approvers (a Social Media or GM lead-seat holder, the owner, the platform
administrator). The body is optional; with none, all three networks are seeded. It is idempotent.

```sh
# POST /api/<tenantId>/modules/social/engagements/<engagementId>/simulated-accounts       body: {} or {"networks":["instagram","facebook","tiktok"]}
# -> 200 {"accounts":[{"id","network","handle":"@mock-<client name>","simulated":true,"created":true|false,"networkEnabled":true|false}]}
```

Refusals: `403 not_a_social_approver` (not one of the four), `409 simulation_disabled` (the switch is off), `400
unknown_field|invalid_field`, `404 engagement_not_found` (also another company's engagement), `409
account_exists_not_simulated` (the client already has a live real account on a requested network, or a real row on the seeded
handle; nothing is written), `409 publisher_org_not_active` (the client's publisher org is suspended or deleted).

The same call is the **Seed simulated accounts** button on the client page. Each client gets, per network, one connected
account with the integration id `simulated:<network>` under an active publisher org of its own (created if the client had
none; its key reference is `simulated:no-key`, an alias that resolves to nothing). `networkEnabled: false` on TikTok is
precondition 4.

Check one client's result: `GET /api/<tenantId>/modules/social/accounts?clientId=<clientId>` lists the accounts with
`simulated: true`, and Connections shows each with a SIMULATED chip.

## 5. Turn the switch off (and what that leaves)

```sh
cd ~/gaiada/infra/compose
cp .env .env.bak-sim-off-<yyyymmdd>
# remove (or blank) SOCIAL_SIMULATION_ENABLED in .env, then the recreate
curl -s <the platform health URL> | grep -o '"socialSimulation":[a-z]*'   # "socialSimulation":false
```

With the switch off and simulated rows still present, nothing breaks and nothing publishes: a simulated account's variant
refuses `simulation_disabled` at dispatch, and the simulator is not registered. The seed route refuses `simulation_disabled`
too; the teardown route (step 6) still works.

## 6. Purge the simulated rows (before real client data)

Switch off first (step 5). Then, per client, as one of the four approvers:

```sh
# DELETE /api/<tenantId>/modules/social/engagements/<engagementId>/simulated-accounts[?networks=tiktok,facebook]
# -> 200 {"removed":[{"id","network","handle"}]}
```

It soft-deletes only the client's `simulated = true` accounts (a real account is never read by the statement) and answers
`409 simulated_account_in_use` with the account ids, removing nothing, while **any** variant references one of them. A
simulated account that was used (it carries simulated posts) therefore stays until its simulated posts and metrics are purged
by the purge script of SCP-Sf (the plan lists it under "Before real clients use the portal"); this runbook does not delete
those rows. Soft-deleted simulated accounts do not count at boot (boot counts only non-simulated rows), and a later seed
revives the same row.

## Everything in one place: what each command may and may not do

| Command | Writes | Needs the switch | Touches a real account |
|---|---|---|---|
| `social-simulation-prepare.js` (dry run) | nothing | no | no |
| `social-simulation-prepare.js --apply` | `simulated = true` on the CP-21 seed fingerprint only, plus an activity row | no (it runs before the switch) | never; unclassified rows and grants are printed and left |
| `POST .../simulated-accounts` | simulated accounts and, if absent, the client's publisher org | on | refuses (409) rather than sit beside one |
| `DELETE .../simulated-accounts` | soft-deletes unused simulated accounts | no | no |
