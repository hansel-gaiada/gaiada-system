# Runbook - the social simulator: turn it on beside Postiz, seed the mock clients, turn it off, purge (SCP-Sa, SCP-Sb, SCP-Sa2, SCP-Sf)

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
   does nothing unless the platform service's `environment:` block lists it. As of SCP-Sb the VPS compose file does not carry
   the row; it needs
   `SOCIAL_SIMULATION_ENABLED: ${SOCIAL_SIMULATION_ENABLED:-}` in the `platform` service of
   `infra/compose/docker-compose.vps.yml`. Prove it after the recreate (step 3), do not assume it.
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

## 6. Remove unused simulated accounts of one client (optional, any time)

With the switch on or off, per client, as one of the four approvers:

```sh
# DELETE /api/<tenantId>/modules/social/engagements/<engagementId>/simulated-accounts[?networks=tiktok,facebook]
# -> 200 {"removed":[{"id","network","handle"}]}
```

It soft-deletes only the client's `simulated = true` accounts (a real account is never read by the statement) and answers
`409 simulated_account_in_use` with the account ids, removing nothing, while **any** variant references one of them. A
soft-deleted simulated account keeps its kind (the database never lets it become real), and a later seed revives the same
row. A simulated account that was used stays until step 7 removes it with everything that hangs off it.

## 7. Turn off and purge before real client data (SCP-Sf)

This is the step "Before real clients use the portal" names. It removes the simulator's whole footprint and nothing else, and
it runs **after** the switch is off. The rules are in `platform-nest/src/seed/social-simulation-purge-plan.ts` (its header);
the script is `platform-nest/src/seed/social-simulation-purge.ts`.

**What it removes, per company, in one transaction.** Every simulated account (soft-deleted ones too) and everything that
hangs off it: every variant on it (published by the simulator or not), those variants' metric rows (`simulated`, and `manual`
numbers a person typed about them: the dry run counts these separately), their client reviews, their undecided publish
approvals (withdrawn to `cancelled`, as an unschedule does, never deleted), the account's `simulated` daily rows and its
best-time suggestion, and the publisher orgs SCP-Sb created for the simulator (`simulated:no-key`, `simulated-<client id>`)
once no account names them.

**What it never touches.** A real account, a variant on a real account, a `pull` metric or daily row, an OAuth grant or state,
an inbox thread, a usage-ledger row, a post's content or date, a cycle, and every history row (`activities`, `work_activity`,
notifications, decided approvals). It never deletes a post and never turns a simulated row real.

**What happens to the posts.**

| The post | After the purge |
|---|---|
| planned to final, changes, blocked | unchanged; the next `final_approve` makes its variants afresh on the accounts that exist then |
| client, approved, scheduled or live through the simulator, with no variant left on a real account | back to `final` (the approver's final check), `schedule_via`, `live_url` and `went_live_at` cleared, `simulated` false. The approver's `final_approve` puts it on the client's real accounts and asks the client again |
| scheduled or marked live **by hand** | unchanged (a person's record of something done outside the ERP); only its rows on simulated accounts go |
| on both kinds (a real account beside a simulated one) | status unchanged; a live one loses its simulated mark and, if its link was the simulator's, takes the first real link |
| Composer, archived or deleted | unchanged |

**What it refuses** (exit `2`; nothing changes in that company; other companies go on): a row breaking the account-kind rule;
a `simulated` variant, metric or daily row on a real account; a `pull` metric or daily row, an OAuth grant or state, an inbox
thread or a usage-ledger row on a simulated account; a provider post id or a published link on a simulated account's variant
that is not the simulator's (a hand-posted link is fine); a post marked simulated that is not a simulated go-live; a post live
through the publisher on simulated accounts whose link is not the simulator's. Each refusal is printed with the row ids. Every
one of them is impossible through the simulator's fences, so it is a bug or a hand edit to look at: a person decides each row,
then the purge runs again. Two refusals stop the whole run before any company is read: the switch still on, and a table the
purge does not know pointing at an account, a variant or an org (a new table must be classified in the plan file first).

### 7.1 Switch off

Step 5, exactly: back up `.env`, remove (or blank) `SOCIAL_SIMULATION_ENABLED`, and the recreate with `GAIADA_TAG` and
`APP_VERSION` passed inline (portal-go-live.md, house rules 2 and 3: a stale `.env` tag silently rolls the release back).

```sh
cd ~/gaiada/infra/compose
cp .env .env.bak-sim-off-<yyyymmdd>
docker inspect gaiada-platform-1 --format '{{.Config.Image}}'                                     # the running tag
docker inspect gaiada-platform-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^APP_VERSION='
# remove or blank SOCIAL_SIMULATION_ENABLED in .env, then:
COMPOSE="docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml --profile bot --profile auth"
GAIADA_TAG=<running tag> APP_VERSION=<running version> $COMPOSE up -d --no-deps platform
docker inspect gaiada-platform-1 --format '{{.Config.Image}}'                                     # the SAME tag as before
docker exec gaiada-platform-1 printenv SOCIAL_SIMULATION_ENABLED                                    # empty, or 0
curl -s <the platform health URL> | grep -o '"socialSimulation":[a-z]*'                           # "socialSimulation":false
```

### 7.2 Back up, then the dry run

```sh
~/gaiada/infra/scripts/backup.sh                                   # note the file names
docker exec gaiada-platform-1 node dist/seed/social-simulation-purge.js
echo "exit=$?"        # 0 = nothing refused; 2 = a refusal (or an error, or the switch is still on)
```

It prints one block per company that holds anything: the counts per table (`social_accounts (simulated)`,
`social_post_variants (on a simulated account)`, `social_post_variants (simulated mark)`, `social_posts (simulated mark)`,
`social_post_metrics (source simulated)`, `social_metrics_daily (source simulated)`, `social_publisher_orgs (the simulator's)`)
with what it would remove, the typed-in metric rows it would remove, every post it would move back (`WOULD MOVE BACK <id>
<client> "<title>" <from> -> final`), repair or keep, and every org it leaves and why. Read it. Go on only if it is what you
expect and the exit is `0`.

### 7.3 Apply

```sh
docker exec gaiada-platform-1 node dist/seed/social-simulation-purge.js --apply
echo "exit=$?"
```

Each company's block now reads `before -> after`. Every statement checks its row count against the plan, so a row that moved
between the dry run and the apply rolls that company back with a message naming the table; run the dry run again. One activity
row per company (`simulation_purged`) and one per post moved back or repaired (`simulated_variants_removed`) are written.

### 7.4 Verify zero simulated rows

A second dry run must print no company block (and exit `0`). Then the owner's superuser read on the ERP database (an app-role
read sees zero rows through RLS and would prove nothing); every count must be `0`:

```sql
SELECT (SELECT count(*) FROM social_accounts WHERE simulated)                          AS simulated_accounts,
       (SELECT count(*) FROM social_post_variants WHERE simulated)                     AS simulated_variants,
       (SELECT count(*) FROM social_post_variants v JOIN social_accounts a ON a.id = v.account_id
         WHERE a.simulated)                                                            AS variants_on_simulated_accounts,
       (SELECT count(*) FROM social_posts WHERE simulated)                             AS simulated_posts,
       (SELECT count(*) FROM social_post_metrics WHERE source = 'simulated')           AS simulated_post_metrics,
       (SELECT count(*) FROM social_metrics_daily WHERE source = 'simulated')          AS simulated_daily_metrics,
       (SELECT count(*) FROM social_post_variants WHERE published_url LIKE 'https://simulated.invalid/%'
                                                     OR provider_post_id LIKE 'simulated:%') AS simulator_links_or_ids,
       (SELECT count(*) FROM social_posts WHERE live_url LIKE 'https://simulated.invalid/%') AS simulator_live_links;
-- the simulator's orgs: 0, or only the ones the dry run listed as LEFT (they hold a real account)
SELECT id, client_id FROM social_publisher_orgs WHERE api_key_ref = 'simulated:no-key';
```

**Revert.** There is no undo short of the backup from 7.2: the purge deletes. Restoring that backup restores every table it
covers, so it is a last resort, decided by the owner. The switch-off itself reverts with step 2.

## Everything in one place: what each command may and may not do

| Command | Writes | Needs the switch | Touches a real account |
|---|---|---|---|
| `social-simulation-prepare.js` (dry run) | nothing | no | no |
| `social-simulation-prepare.js --apply` | `simulated = true` + `simulated:<network>` on the CP-21 seed fingerprint only, plus an activity row | no | never; real accounts are counted, rows breaking the rule and grants on simulated accounts are printed and left |
| `POST .../simulated-accounts` | simulated accounts and, if absent, the client's publisher org | on | refuses (409) rather than sit on a real account's network |
| `DELETE .../simulated-accounts` | soft-deletes unused simulated accounts | no | no |
| `social-simulation-purge.js` (dry run) | nothing | must be OFF | no |
| `social-simulation-purge.js --apply` | deletes the simulator's footprint (step 7), withdraws its undecided publish approvals, moves posts the simulator carried back to `final`, plus activity rows | must be OFF | never; it refuses the company instead of guessing |
| Postiz connect / sync, LinkedIn and YouTube connect | real accounts only | no (allowed with it on since SCP-Sa2) | yes, never a simulated one (409 `simulated_account_on_real_publisher`, or a named skip in the sync) |
