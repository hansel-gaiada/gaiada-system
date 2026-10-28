# Runbook - the social simulator: turn it on beside Postiz, seed the mock clients, turn it off, purge (SCP-Sa, SCP-Sb, SCP-Sa2)

**Status: PLANNED.** Nothing here has been run on a server. The orchestrator or the owner runs every live step, one at a
time, and pastes the real output into the hand-back. Plan: `docs/plans/2026-10-15-social-content-pipeline.md` section 5
(SCP-D1, SCP-D3; SCP-D9 for the side-by-side mode). Contract: `docs/FRONTEND-BFF-CONTRACT.md` section 63.1 file 8 and
section 63.16. The containment is SCP-Sa's and SCP-Sa2's (`platform-nest/src/modules/social/publisher/simulation.ts`, seven
fences, and migration `202610280100_social_account_kind.sql`); this runbook is the operator's side of it.

The repo is PUBLIC. Every value below is a `<placeholder>`; real ids, tokens and addresses stay on the server.

## What the simulator is, in one paragraph

With `SOCIAL_SIMULATION_ENABLED` on, the social module can publish a post that never leaves the ERP: a variant whose
account is marked `simulated` goes through the real approval and dispatch path to an in-process simulator, which answers
with a link under `https://simulated.invalid/` (it can never resolve) and marks the variant `simulated`. That is a post that
never appeared on a client's account while the calendar says it did, so the switch is **for the dev review only**. Since
SCP-Sa2 (owner ruling SCP-D9, 2026-10-28: "use simulator with postiz. so we can know if its working or not at the same
time") it runs **side by side** with a real Postiz: a simulated account publishes through the simulator, a real account
through Postiz (or `direct` for LinkedIn/YouTube), in the same ERP, the same company, even the same client. What keeps them
apart is that **every account is exactly one kind**, enforced in the database, and each driver refuses the other kind. It is
off by default and is switched off, with the simulated rows purged, **before the ERP holds real client data**.

House rules for any `.env` change on the ERP box (back up `.env` first, pass `GAIADA_TAG` and `APP_VERSION` inline, recreate
only `platform` with `--no-deps`, never `--remove-orphans`, prove the variable reached the container, one step at a time) are
in `infra/runbooks/portal-go-live.md`, "House rules for flag flips on this estate". They apply to every recreate below.

## Side by side (SCP-Sa2): the rule, the fences, and what you see

**The rule: one kind per account.**

| | Simulated account | Real account |
|---|---|---|
| `social_accounts.simulated` | `true` | `false` |
| `postiz_integration_id` | `simulated:<network>` (always) | NULL, an engine id, or `direct:<network>`; never `simulated:...` |
| `connected_by` | always NULL (seeded, never connected by a person) | anything |
| OAuth grant (`social_oauth_tokens`) | never, of any status | allowed |
| Publishes through | the simulator, only while the switch is on | Postiz, or `direct` (switch on or off) |
| Provider post ids | `simulated:<network>:<ms>:<uuid>` | the engine's own |

**The fences, and where they sit.**

- Database (migration `202610280100_social_account_kind.sql`): the CHECK `social_accounts_kind_ck` (the table above, first
  three rows); `trg_social_accounts_kind_guard` (a simulated account never becomes real; a real one becomes simulated only if
  it never reached an engine: no integration id, no `connected_by`, no grant); `trg_social_oauth_tokens_real_account_only`
  (no grant row names a simulated account).
- Boot, with the switch on (an error that aborts startup): a row that breaks the kind rule (any company, soft-deleted
  included), or a grant on a simulated account. A capability override (`SOCIAL_PUBLISHER_CAPABILITY_DRIVERS`) that names
  `simulated` refuses boot whether the switch is on or off. Postiz configured, overrides naming a real driver, live grants and
  real accounts **do not** refuse boot any more.
- Runtime: the simulator refuses a variant whose account is not simulated (`simulated_account_required`). Every real path
  (the dispatch resolver, the status sweep and its webhook intake, the metrics sweep, the cancel effect, the TikTok
  creator-info probe) refuses a simulated account, a `simulated:` integration id or a `simulated:` provider post id
  (`simulated_account_on_real_publisher`, 409). A real connect (Postiz, LinkedIn, YouTube) on a handle a simulated account of
  the same client holds refuses the same code and writes nothing; the Postiz connector sync skips such a handle
  (`handle_held_by_simulated_account`) and never marks a simulated account disconnected.

**What you see.**

```sh
curl -s <the platform health URL> | grep -o '"socialSimulation":[a-z]*\|"socialPublisher":"[a-z]*"'
# "socialSimulation":true  and  "socialPublisher":"postiz"   = side by side
docker logs gaiada-platform-1 2>&1 | grep 'social:simulation-enabled'
# ... Real accounts publish through 'postiz' beside it; every account is exactly one kind (SCP-D9) ...
```

A failed variant's `last_error` starting `simulated_account_on_real_publisher:` means a real path met a simulated account and
refused: nothing was sent to Postiz. The status and metrics sweeps log the same code on `[SOCIAL-POST-STATUS-SYNC]` and
`[SOCIAL-METRICS-PULL]` lines and leave the row as it was. Any such line is a bug to report, not a state to work around.

## 0. Preconditions

1. The release carrying SCP-Sa2 is deployed (the migration `202610280100_social_account_kind.sql` has run, after SCP-Sa's
   `<prefix>_social_simulation.sql`, and the `simulated-accounts` routes exist).
2. **Before that release is deployed: the migration's pre-check.** The migration backfills `simulated:<network>` onto every
   simulated account with no integration id (the CP-21 demo rows the prepare script marked, and the three older seed rows
   marked simulated by the owner's decision, all soft-deleted). Any OTHER shape that breaks the rule makes it **refuse**
   (the deploy's migration step fails, nothing changes). The owner runs this read on the ERP database first, as the
   superuser (an app-role read sees zero rows through RLS); every count must be 0:

   ```sql
   -- simulated rows the migration will not guess at (an engine id, or a person connected them)
   SELECT id, tenant_id, network, handle, postiz_integration_id, connected_by IS NOT NULL AS connected, deleted_at
     FROM social_accounts
    WHERE simulated AND (connected_by IS NOT NULL
                         OR (postiz_integration_id IS NOT NULL AND postiz_integration_id NOT LIKE 'simulated:%'));
   -- real rows carrying the simulated prefix
   SELECT id, tenant_id, network, handle, postiz_integration_id FROM social_accounts
    WHERE NOT simulated AND postiz_integration_id LIKE 'simulated:%';
   -- grants (any status) on simulated accounts; ids and statuses only, never the ciphertext columns
   SELECT t.id, t.tenant_id, t.account_id, t.network, t.status
     FROM social_oauth_tokens t JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id
    WHERE a.simulated;
   -- for the record: the rows the backfill WILL write (expected: the CP-21 rows and the three soft-deleted ones)
   SELECT id, tenant_id, network, deleted_at FROM social_accounts WHERE simulated AND postiz_integration_id IS NULL;
   ```

   A row in any of the first three is decided by a person (it is either simulated or real; make it one kind through the
   module's own tools, or revoke a grant through the disconnect flow) before the deploy.
3. **The compose passthrough.** `SOCIAL_SIMULATION_ENABLED` is read from the container's environment, and a variable in `.env`
   does nothing unless the platform service's `environment:` block lists it. The VPS compose file carries the row since
   release 444 (`SOCIAL_SIMULATION_ENABLED: ${SOCIAL_SIMULATION_ENABLED:-0}`), and since 449 also
   `SOCIAL_METRICS_PULL_ENABLED` (default 0) and `SOCIAL_METRICS_PULL_INTERVAL_MS` (default 86400000; the dev review uses
   3600000). On gda-aicenter `.env` had no `SOCIAL_SIMULATION_ENABLED` line at all: add it, do not just edit it. Prove it after
   the recreate (step 3), do not assume it.
4. **Postiz stays as it is.** `SOCIAL_POSTIZ_BASE_URL` stays set (the side-by-side mode is the point). Do not set
   `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` to anything naming `simulated` (boot refuses it, switch on or off).
5. **TikTok.** `SOCIAL_NETWORKS_ENABLED` defaults to `instagram,facebook,linkedin`; TikTok is off at the deployment level.
   The seeded TikTok account satisfies the pipeline's account guards (`final_approve`, `reschedule`), but a TikTok variant
   refuses to publish with `network_disabled` until the variable names it, for example
   `SOCIAL_NETWORKS_ENABLED=instagram,facebook,linkedin,tiktok`. Extending it is the owner's call and is not needed to seed.
   The flag is per network, not per kind: enabling TikTok enables it for real TikTok accounts too.
6. A database backup first: `~/gaiada/infra/scripts/backup.sh`. Note the file names.

## 1. Prepare the database (dry run first)

The prepare script lists what would still make boot refuse the switch and marks the CP-21 demo-seed accounts simulated, so
the demo publishes through the simulator. It can run any number of times, with the switch on or off.

```sh
# DRY RUN: reads only. One block per company; ids, client names and reasons.
docker exec gaiada-platform-1 node dist/seed/social-simulation-prepare.js
echo "exit=$?"        # 0 = nothing blocks the switch; 2 = something does (or an error)
```

What it prints, per company (deleted companies included):

- `WOULD MARK` - an account the **CP-21 demo seed** wrote. The rule is a fingerprint, not a name: its publisher org's
  `api_key_ref` is exactly `seed:portal-demo-no-key`, its org id is exactly `seed-<its client id>`, it was never connected to an
  engine (no integration id, no `connected_by`), no OAuth grant of any status names it, and no variant on it carries a provider
  post id, a published time or is a native import. Soft-deleted rows are classified by the same rule. Such a row cannot
  publish through Postiz anyway (it has no integration id); marking it lets it publish through the simulator.
- `KIND RULE BROKEN` - a row that is neither kind (see the table above), with the reasons. Blocks the switch. On a database
  that ran the migration there are none.
- `OAUTH GRANT ON A SIMULATED ACCOUNT` - a grant (any status) on a simulated account. Blocks the switch. Never touched.
- A count of the **real accounts**: they stay real and publish through Postiz beside the simulator. Since SCP-Sa2 they are
  not blockers and are not listed (they were `UNCLASSIFIED` before), nor are live grants on real accounts.

If the dry run is what you expect, mark the `WOULD MARK` rows:

```sh
docker exec gaiada-platform-1 node dist/seed/social-simulation-prepare.js --apply
echo "exit=$?"
```

`--apply` runs one transaction per company, sets `simulated = true` and `postiz_integration_id = 'simulated:<network>'` (the
kind rule needs both, in one statement) on exactly the classified ids and nothing else (no row is deleted, no status, handle
or org changes, no soft-delete is cleared), checks the row count against the plan and rolls the company back on a mismatch,
and writes one activity row per company. It is idempotent. The exit code is the prediction of boot: **do not go on until it
is `0`.**

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
curl -s <the platform health URL> | grep -o '"socialPublisher":"[a-z]*"'  # "socialPublisher":"postiz" (side by side)
docker logs gaiada-platform-1 2>&1 | grep 'social:simulation-enabled'    # one WARNING line on every start, naming 'postiz'
```

If the container exits at start with `BOOT ERROR: SOCIAL_SIMULATION_ENABLED is on while ...`, the message names which fence
refused (N rows breaking the account-kind rule, or N grants on simulated accounts), or `... routes ... to 'simulated'` for an
override. Revert the `.env` line (step 5), fix the named cause, and repeat from step 1.

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
handle; nothing is written: a network holds one kind per client, or the pipeline would see two accounts), `409
publisher_org_not_active` (the client's publisher org is suspended or deleted).

The same call is the **Seed simulated accounts** button on the client page. Each client gets, per network, one connected
account with the integration id `simulated:<network>` under an active publisher org of its own (created if the client had
none; its key reference is `simulated:no-key`, an alias that resolves to nothing). `networkEnabled: false` on TikTok is
precondition 5. A client whose real account is connected through Postiz on a network keeps it; seed the simulated accounts on
the other networks only (`{"networks":[...]}`).

Check one client's result: `GET /api/<tenantId>/modules/social/accounts?clientId=<clientId>` lists the accounts with
`simulated: true` beside any real ones, and Connections shows each simulated one with a SIMULATED chip.

## 5. Turn the switch off (and what that leaves)

```sh
cd ~/gaiada/infra/compose
cp .env .env.bak-sim-off-<yyyymmdd>
# remove (or blank) SOCIAL_SIMULATION_ENABLED in .env, then the recreate
curl -s <the platform health URL> | grep -o '"socialSimulation":[a-z]*'   # "socialSimulation":false
```

With the switch off and simulated rows still present, nothing breaks and nothing of theirs publishes: a simulated account's
variant refuses `simulation_disabled` at dispatch, and the simulator is not registered. Real accounts keep publishing through
Postiz exactly as before, and the reverse fence still keeps Postiz off the simulated rows. The seed route refuses
`simulation_disabled` too; the teardown route (step 6) still works.

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
those rows. A soft-deleted simulated account keeps its kind (the database never lets it become real), and a later seed
revives the same row.

## Everything in one place: what each command may and may not do

| Command | Writes | Needs the switch | Touches a real account |
|---|---|---|---|
| `social-simulation-prepare.js` (dry run) | nothing | no | no |
| `social-simulation-prepare.js --apply` | `simulated = true` + `simulated:<network>` on the CP-21 seed fingerprint only, plus an activity row | no | never; real accounts are counted, rows breaking the rule and grants on simulated accounts are printed and left |
| `POST .../simulated-accounts` | simulated accounts and, if absent, the client's publisher org | on | refuses (409) rather than sit on a real account's network |
| `DELETE .../simulated-accounts` | soft-deletes unused simulated accounts | no | no |
| Postiz connect / sync, LinkedIn and YouTube connect | real accounts only | no (allowed with it on since SCP-Sa2) | yes, never a simulated one (409 `simulated_account_on_real_publisher`, or a named skip in the sync) |
