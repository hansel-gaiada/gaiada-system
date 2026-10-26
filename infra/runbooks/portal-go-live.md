# Runbook - portal go-live cut-over (PGL-04): from review data to the first real client

**Status: PLANNED.** Nothing here has been run on a server. The orchestrator or the owner runs every live step, one at
a time, and pastes the real output into the hand-back. Plan: `docs/plans/2026-10-15-portal-go-live-tickets.md`
(PGL-04). Rulings: PV-D40 to PV-D47 in `docs/plans/2026-10-10-three-perspectives.md`. The gate for the whole runbook is
the readiness check (PGL-01, `platform-nest/src/ops/README.md`):

```sh
docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js          # one line per check
docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js --json
```

Exit `0`: no BLOCK or ERROR. Exit `1`: at least one BLOCK. Exit `2`: a check could not run (an error is never a PASS; 2
outranks 1). It is strictly read-only and never prints a secret. Run it before and after every step: the id named under
"Verify" must turn PASS (or, for a MANUAL id, be signed off by a named person).

This runbook reuses the others and does not restate them. Where a step says "see X section N", do exactly what that
section says, with the house rules below applied on top.

The repo is PUBLIC. Every value below is a `<placeholder>`; real names, keys and addresses stay on the server and in the
owner's records.

## House rules for flag flips on this estate (apply them in every step)

The ERP box is `gda-aicenter`, the checkout is `~/gaiada`, the compose directory is `~/gaiada/infra/compose`.

1. **Back up `.env` first.** `cp .env .env.bak-<step>-<yyyymmdd>` in `~/gaiada/infra/compose`, before every edit. The
   `.env` holds secrets: never print it, never paste it, never commit it.
2. **Pass `GAIADA_TAG` and `APP_VERSION` inline on every `up -d`.** A stale `.env` tag silently rolls the release back
   (`up -d` recreates from whatever the `.env` says). Read the running values first and reuse them:
   ```sh
   cd ~/gaiada/infra/compose
   docker inspect gaiada-platform-1 --format '{{.Config.Image}}'                                     # the tag, after the colon
   docker inspect gaiada-platform-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^APP_VERSION='
   ```
3. **Recreate only `platform`, with `--no-deps`. Never `--remove-orphans`** (it deletes every container whose profile is
   absent from the command: Mailpit, ClamAV and others). The compose file set is more than `vps.yml` alone: the VPS
   file alone is invalid on this box (postgres and redis are host-run, their services are profile-disabled), so the
   overlay and both profiles are mandatory, as `infra/scripts/wire-env.sh` and `infra/runbooks/deploy-vps.md` ("Changing
   a variable in `.env` on a running box") carry them. The deploy workflow's `COMPOSE_FILES` and `COMPOSE_PROFILES`
   repo variables are the authority for the box: if they list more files or profiles than below, use those.
   ```sh
   cd ~/gaiada/infra/compose
   COMPOSE="docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml --profile bot --profile auth"
   GAIADA_TAG=<running tag> APP_VERSION=<running version> $COMPOSE up -d --no-deps platform
   $COMPOSE ps platform          # healthy?
   ```
   `restart` does not re-read `.env`; only this recreate does. Name this line "the recreate" below.
4. **A var in `.env` does nothing unless the service's compose `environment:` block lists it.** Prove it reached the
   container, with the name only and never a secret's value:
   `docker exec gaiada-platform-1 printenv <NAME> | sed 's/./*/g'` (shows the length) or `printenv <NAME>` for a plain
   flag. An absent line means the passthrough is missing from the deployed compose file, not that the value is empty.
5. **After a Cerbos policy change, restart Cerbos and prove the decision with a probe.** A new policy file is not
   picked up by the watcher, and an unlisted kind is a silent deny. None of the steps below changes a policy; if the
   release being cut over ships one (PGL-05 to PGL-08 may), the deploy's "Reload Cerbos policies" step restarts it, and
   you still run the probe those tickets name before step 6.
6. **One step at a time.** One recreate, one verify, then the next. A step that fails its verify is reverted before the
   next begins.
7. **Database backup before the first step:** `~/gaiada/infra/scripts/backup.sh` (the three application databases, one
   `*.sql.gz` each; never a data volume). Note the file names in the hand-back.

## Preconditions (all must hold before step 1)

1. **Staging is done (PV-D45).** Real MFA and real billing come after staging, never before it.
2. **The owner actions are done.** None of these can be done by code or by this runbook:
   - the Midtrans merchant account, with its production server key and the id of the company that owns it;
   - the real billing values for each company that bills clients (legal name, address, tax id, bank, account, invoice
     prefix);
   - the Google Workspace SMTP relay for the ERP host, and DNS for `notify.gaiada.com` (SPF, DKIM, DMARC);
   - counsel's sign-off on `legal/client-portal-addendum.md` section 14 (G1 to G17, each signed with name and date);
   - the client's real representatives named (who signs, who only views), per client.
3. **The release carries PGL-01 (the check) and PGL-09 (the `CLIENT_MAIL_ENABLED` flag).** Until PGL-09 ships, the code reads
   only `CONVERSATION_CLIENT_MAIL_ENABLED` while the check also accepts `CLIENT_MAIL_ENABLED`, so a PASS on `mail.client`
   could be read as "client mail is on" when the app ignores the flag. Confirm PGL-09 is in the running release
   (`/api/health` version, and the changelog entry) before step 4.
4. **The PGL-Q1 data path is chosen** (the owner's call, recorded in the decision log). Pick one variant, below.

### Data path A: a fresh production database

Production starts from an empty database with the real companies, real billing profiles and real clients entered as
real data. The placeholders (P-03, P-04) and the mock rows never exist, so step 5 is a verify-only step. The simulated
rows listed by `data.simulated` live in the old review database, which is kept or retired by the owner.

- How the fresh database is created, migrated, seeded with the real tenants and cut over to (DNS, the Keycloak realm, the
  `.env` of the new box) is **not in this repo as a procedure**. It is an open item for the owner and the orchestrator:
  write it as its own reviewed plan before the date, and put its link here. Do not improvise it from this runbook.
- Steps 1 to 4 apply as written to the new box, with its own `.env`.
- Note for the check: its positive controls need at least one client, one billing profile and one client contact visible
  (see the README's RLS section). On an empty database those controls read zero and the run is exit 2, not PASS. Create
  the real client, its billing profile and the real contact (invited) before step 6, and confirm the controls read
  non-zero in the `--json` output. [UNVERIFIED: whether an `invited` contact satisfies the `contacts` control; confirm on
  staging.]

### Data path B: clean the current database

Production stays on the current database, which holds mock seed (the live ERP is mock seed today). Before step 6 the mock
data is cleaned:

| Clean-up | Needed for | Status |
|---|---|---|
| Purge the mock rows (the `data.simulated` records, other review data the owner names) | `data.simulated` reads zero | **DESTRUCTIVE. Needs its own reviewed script and the owner's explicit go. Not written; this runbook gives no SQL.** |
| Reverse the mock ledger postings (including each simulated payment's DR clearing / CR receivables) | books that match reality | **DESTRUCTIVE. Own reviewed script, owner's go, and a Finance review. Not written; no SQL here.** Postings are append-only: correction is by reversal, per `docs/PLACEHOLDER-PRINCIPALS.md`. |
| Retire the placeholders P-03 and P-04 | `placeholders.p03`, `placeholders.p04` | Step 5 (the register's procedure). |

Each destructive script is a separate ticket: written, reviewed, run first on a restored copy of the database (see
`infra/scripts/restore-drill.sh`), then run live only on the owner's go, with a dated backup taken immediately before. If
the owner has not given that go, the run returns BLOCKED at that row. The `data.simulated` line is INFO and never gates
the exit code, but the owner should see a zero before the first client logs in.

## The steps

For every step: take the `.env` backup (rule 1) and, where the step says so, a database backup (rule 7); apply; run the
recreate (rule 3); verify (rule 4 and the named id); and know the revert before you start.

### Step 1. Real MFA, then `MFA_SIMULATION_ENABLED=0`

- **Backup:** `.env` (`cp .env .env.bak-mfa-<yyyymmdd>`); a Keycloak realm partial export, exactly as `enable-mfa.md`
  section 3 opens (it writes `~/gaiada-realm-backups/gaiada-realm-export-<stamp>.json`).
- **Do:** `infra/runbooks/enable-mfa.md` sections 3.1 to 3.4: the AMR mapper on `gaiada-ui` and `gaiada-platform`, the
  reference value on the OTP execution, one staff account enrols a real authenticator, and a real browser login proves
  `GET /api/me` reads assurance `high` with no `assuranceSource`. Section 3.6 (forcing enrolment realm-wide) is the owner's
  separate decision. Only after 3.4 reads `high`: set `MFA_SIMULATION_ENABLED=0` in `.env` and run the recreate. The var is
  already in the compose `environment:` block (default `0`).
- **Owner decision, flagged:** every high-assurance staff action (PV-D26: period close, tax filing, bank-detail changes,
  AP payment release and the rest) needs a real second factor once the simulation is off. Every staff member who does
  those must be enrolled first (3.3 per person), or they are locked out of those actions. Enrol before the flag.
- **Verify:** `mfa.simulation` turns PASS. `mfa.real` stays **MANUAL by design** (the platform stores no record of a real
  second factor): the person who ran 3.4 signs it off by name, with the date, the `/api/me` result and the matching
  Keycloak sign-in event.
- **Revert:** set `MFA_SIMULATION_ENABLED=1` and run the recreate, only if the owner accepts the simulated factor on a
  non-real dataset again (it must not be on beside real data). The AMR mapper and the reference value are additive;
  their rollbacks are in `enable-mfa.md` 3.1 and 3.2 (clear or delete). Realm-wide enrolment: 3.6's rollback.
- Open item: `enable-mfa.md` names the older `erp.gaiada.online` host in its examples; the live ERP host is
  `erp.gaiada.com`. Use the live host.

### Step 2. Real billing values, then the seal key rotated

- **Backup:** `.env` is not touched in this step. Take the database backup (rule 7). The seal directory: copy the old
  key directory aside before the rotation (the runbook's rotate step moves it to `/root/seal-keys-retired-<date>-<uuid>`;
  keep that copy until a new seal is checked).
- **Do, billing:** replace the DEV MOCK billing profile with the real values for each company that bills clients, through
  the billing-profile route and screen (`PUT /api/<companyId>/billing-profile`, `finance_config` `update`; the same route
  `midtrans-payments.md` section 1.2 uses). The legal name, the bank and account, and the invoice prefix must all be real:
  no `DEV MOCK`, no `MOCK BANK`, no all-zero account, no prefix ending `-DEV`. Finance enters them; the values never go
  in the repo. [Open item for the owner: the billing profile screen's exact path is not restated here; the BFF contract
  section for the billing profile is the reference.]
- **Do, seal key:** `infra/runbooks/company-seal-keys.md`, section "Rotate": move the old key out of the mount, run
  "Create a company's key" again so the certificate is named after the NEW real legal name, check with `seal-key.js list`,
  and prove one seal with `seal-key.js verify`. The old certificate row stays so earlier seals still verify. Shred the
  retired directory only after the new key has sealed one copy. No restart is needed. Order matters: the key is named
  from the billing legal name, so billing comes first.
- **Verify:** `billing.mock` turns PASS (every profile), then `seal.mock` turns PASS (each active certificate names its
  company's real legal name and none is mock).
- **Revert:** billing values are edited back through the same route (only to the mock values on a review box, never beside
  real data). The seal key: move the new directory aside and move `/root/seal-keys-retired-<date>-<uuid>` back under
  `/etc/gaiada/seal-keys/<uuid>`; the old certificate row is still on record. A sealed copy made with the new key stays
  checkable against its own certificate either way.

### Step 3. Midtrans production keys, then `PAYMENTS_SIMULATION_ENABLED=0`

- **Backup:** `.env` (`cp .env .env.bak-midtrans-<yyyymmdd>`). Check no checkout is open before touching the key:
  `midtrans-payments.md` section 2 ("Never unset or rotate the key while checkouts are open"; the open-checkout count
  query there is owner-run).
- **Do:** `infra/runbooks/midtrans-payments.md`: section 1 (the clearing account on that company's billing profile),
  section 7 "Off" (`PAYMENTS_SIMULATION_ENABLED=0`, and replace the `SIM-` key and the `simulated` environment), and
  section 5 "Switching sandbox to production" in one edit: `MIDTRANS_SERVER_KEY=<production server key>`,
  `MIDTRANS_ENVIRONMENT=production`, `MIDTRANS_TENANT_ID=<companies.id of the merchant company>`, then the recreate. All of
  these are already passed through by the compose file. Check the boot line says `midtrans production`
  (`docker logs gaiada-platform-1 2>&1 | grep '\[payments\]'`).
- **Open item for the owner:** the steps to register the Payment Notification URL and the redirect URLs in the PRODUCTION
  Midtrans dashboard are only the values in `midtrans-payments.md` section 3 (`https://erp.gaiada.com/api/webhooks/payments/midtrans`
  and the portal invoices page). This repo has no record of the production dashboard's own screens or of a
  production-notification test; the sandbox drive (PV5-13 part B) is itself not yet done. Record who registered them
  and when.
- **`signatures.simulation`:** PV-D44 dropped PSrE and `SIGNATURE_SIMULATION_ENABLED=0` is already on live. There is no
  certified signing step in this cut-over. Verify it reads PASS now and again at step 6; if it reads BLOCK, set it to `0`
  (the compose block has it) and recreate.
- **Verify:** `payments.simulation` turns PASS (flag off and environment `production`), then `payments.keys` turns PASS
  (key set, not `SIM-`, tenant id live, clearing account on the billing profile; a WARN means a sandbox-looking `SB-`
  key beside `production`: fix it, do not accept it). `signatures.simulation` PASS.
- **Revert:** restore `.env.bak-midtrans-<date>` and recreate. Never leave checkouts open while the key is removed or
  swapped (section 2): reconcile any payment made meanwhile by hand from the Midtrans dashboard. Do not return to the
  simulation beside real data.

### Step 4. The mail sender, then the client mail flag

- **Backup:** `.env` (`cp .env .env.bak-mail-<yyyymmdd>`).
- **4a. The sender.** Set, in `.env`, the notify stream to the Google Workspace relay: `MAIL_ENABLED=1`,
  `MAIL_STREAM_NOTIFY_TRANSPORT=relay`, `MAIL_STREAM_NOTIFY_RELAY_HOST=<relay host>`, `MAIL_STREAM_NOTIFY_RELAY_PORT=<port>`,
  `MAIL_STREAM_NOTIFY_RELAY_USER` and `..._PASSWORD` (secrets), `MAIL_STREAM_NOTIFY_FROM=<name@notify.gaiada.com>`, and
  `MAIL_LINK_BASE_URL=https://erp.gaiada.com`. All are in the compose `environment:` block. The From domain must have SPF,
  DKIM and DMARC published (precondition 2). Then the recreate. [Open item for the owner: the exact relay host, port and
  the authentication form (SMTP AUTH or IP allow-list) are the owner's Workspace settings; the repo's mail design
  `docs/superpowers/specs/2026-08-04-zone-a-mail-design.md` is the reference, and this runbook does not invent them.]
  Mail goes live for staff and system mail at this point, so check a staff notification arrives before going on.
- **4b. The compose passthrough.** In `infra/compose/docker-compose.vps.yml`, under the `platform` service's
  `environment:` block, next to the other `MAIL_*` lines, add:
  ```yaml
        CLIENT_MAIL_ENABLED: ${CLIENT_MAIL_ENABLED:-0}
  ```
  `CONVERSATION_CLIENT_MAIL_ENABLED` is its read-only alias for one release (PGL-09); the deployed compose file does not pass
  it, so it cannot be turned on by accident, and it needs no passthrough once the new flag is read. This is a compose
  file edit, so it goes through a reviewed commit and the normal deploy (`git push --tags`), never a hand edit on the box.
  Check afterwards: `docker exec gaiada-platform-1 printenv CLIENT_MAIL_ENABLED` prints `0`.
- **4c. The flag on.** Only now: `CLIENT_MAIL_ENABLED=1` in `.env`, then the recreate. It gates every client-recipient mail
  type (PV-D47): the invite, a contract to sign, an issued invoice, a sign-off gate and a staff message in Conversation.
- **Verify:** `mail.sender` turns PASS (mail on, relay not `mailpit`, From not on a `.invalid`/`.test`/`.example`/`.localhost`
  domain), then `mail.client` turns PASS. `mail.deliverability` stays **MANUAL**: sign it off by name after a real message
  from the notify From address reaches a Gmail and an Outlook inbox (not spam) with SPF, DKIM and DMARC all passing in the
  message headers. A Mailpit catch proves rendering, never deliverability (PGL-11).
- **Revert:** `CLIENT_MAIL_ENABLED=0` and the recreate stops all client mail at once (no `mail_log` row, no enqueue). To
  stop the sender entirely: `MAIL_ENABLED=0`, or restore `.env.bak-mail-<date>`, then the recreate. The compose passthrough
  is harmless left in place (default `0`).

### Step 5. Placeholders P-03 and P-04 retired

- **Backup:** the database backup (rule 7). Soft-deleted rows and revoked grants are the record: nothing is hard-deleted.
- **Data path A (fresh database):** nothing to retire. Verify only; both ids must already read PASS.
- **Data path B (clean the current database):** follow `docs/PLACEHOLDER-PRINCIPALS.md`, "Retiring a stand-in" and the
  P-03 / P-04 sections. For P-03 (the 19 `portal@<slug>.test` logins): create the real representative's account and
  contact (the invite flow, step 7), then soft-delete the placeholder `client_contacts` row and disable its Keycloak
  account; leave the `users` row. For P-04 (the owner as `signer` on every client): revoke the stand-in contact row on each
  client, and strike each row from the register with the date and who it went to. Never re-attribute history: entries are
  append-only; note any posted under a stand-in in the period's audit file. Retiring P-04 also closes the leak where
  every client's contact list shows the owner's agency email as a signatory. These are production writes: **each needs the
  owner's go, a reviewed command (no SQL is given here) and a dated backup immediately before**; the classifier may
  block live DB writes, in which case the owner runs the ready command.
- **Verify:** `placeholders.p03` turns PASS (no active `portal@%.test` contact) and `placeholders.p04` turns PASS (no
  active signer or admin contact held by a non-client user). A staff `viewer` contact is only a WARN: decide with the
  owner whether it stays. Both must be PASS on a non-empty database: if either reads ERROR, a positive control read zero
  (the RLS trap): fix the tenant context, never read it as PASS.
- **Revert:** re-activate the soft-deleted contact row and re-enable the Keycloak account (the reverse of the retire), only
  with the owner's go and never beside real client data.

### Step 6. The readiness check, all-PASS

- **Backup:** none needed (read-only), but confirm steps 1 to 5 left a dated `.env` backup each.
- **Do:** run `docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js` and keep the full output; run it with
  `--json` too. If a release shipped a Cerbos policy, restart Cerbos and run the ticket's probe first (rule 5).
- **Verify:** exit code `0`, and every id in the checklist below reads PASS, except the MANUAL ids, each signed off by
  name in the hand-back:
  - `mfa.real`: the staff member who proved the real second factor (step 1);
  - `legal.gate1`: counsel, against `legal/client-portal-addendum.md` section 14 (G1 to G17 each signed with name and
    date, G17 the whole-checklist sign-off with the addendum version). The board item "Legal Gate 1 green for the portal"
    is ticked only then, and the sign-off is recorded in the decision log (the addendum says a drafter's tick is not
    enough);
  - `mail.deliverability`: the person who ran the inbox test (step 4);
  - `contrast.manual`: the person who reviewed the portal pages after PGL-02 (the contrast pass), against the colour
    pairs that ticket lists, in both themes.

  `data.simulated` is INFO: on path B its counts are zero or knowingly accepted by the owner; on path A it reads zero.
  Exit `1` or `2` stops the cut-over: fix the named id and rerun. Exit `2` is never waved through.
- **Revert:** n/a. The check changes nothing. A regression in any earlier step is reverted by that step's revert, and the
  check rerun.

### Step 7. The first real client invited

- **Backup:** the database backup (rule 7), taken after the step 6 run and before the invite.
- **Do:** the project manager invites the client's real representative through the existing invite route
  (`POST /api/:tenantId/clients/:clientId/contacts`, `signer` for who signs, `viewer` otherwise; BFF contract, the invite
  and `POST /api/invites/accept` rows). With `CLIENT_MAIL_ENABLED=1` and PGL-10 in the release, the invite can go by
  mail; if PGL-10 is not in the release the link is forwarded by hand. Never paste an invite token anywhere that is
  logged. Drive the first login as the client does: accept, sign in, open `/portal`, and check the contact list shows no
  staff user as a signatory. Stop at the first failed login; never retry a failed login on a real account.
- **Verify:** the check still exits `0` after the first client is active. `placeholders.p03` and `placeholders.p04` stay
  PASS (the new contact is a real client contact, not a placeholder). Record the invite, the accept and the first portal
  page load.
- **Revert:** revoke the contact (the PV-6 revoke: it disables the login and cannot be undone by the client). The
  contract and invoice rules are unaffected. Do not send the client a contract or an invoice until the revoke path has
  been proved on a throwaway contact of your own.

## The checklist: every readiness-check id

"Today" is the expected result on the review data as the plan describes it (almost everything BLOCK). It is a forecast, not
a measurement: the first live run of PGL-01 on `gda-aicenter` replaces this column with its real output (paste it into the
hand-back).

| Id | Today (review data, expected) | After the cut-over | Turned by |
|---|---|---|---|
| `mfa.simulation` | BLOCK (the simulated second factor is on, PV-D40) | PASS | Step 1 |
| `mfa.real` | MANUAL (always; the platform records no real second factor) | MANUAL, signed off by name | Step 1 (sign-off at step 6) |
| `payments.simulation` | BLOCK (simulation on, environment `simulated`) | PASS | Step 3 |
| `payments.keys` | BLOCK (a `SIM-` key) | PASS | Step 3 |
| `signatures.simulation` | PASS (PV-D44 turned it off on live; confirm) | PASS | Step 3 (verify only) |
| `billing.mock` | BLOCK (DEV MOCK profile, PV-D42) | PASS | Step 2 |
| `seal.mock` | BLOCK (the mock certificate, PV-D42) | PASS | Step 2 |
| `placeholders.p03` | BLOCK (the `portal@<slug>.test` contacts) | PASS | Step 5 (path A: never existed) |
| `placeholders.p04` | BLOCK (the owner as signer on every client) | PASS (a staff viewer contact is WARN) | Step 5 (path A: never existed) |
| `mail.sender` | BLOCK (relay is `mailpit`, no real From) | PASS | Step 4a |
| `mail.client` | BLOCK (neither flag is `1`) | PASS | Step 4c |
| `data.simulated` | INFO (counts of simulated checkouts, signatures and MFA step-ups) | INFO (zero, or accepted by the owner) | PGL-Q1 path (the clean-up scripts, or a fresh database) |
| `legal.gate1` | MANUAL | MANUAL, signed off by counsel | Precondition 2, recorded at step 6 |
| `mail.deliverability` | MANUAL | MANUAL, signed off by name | Step 4 (sign-off at step 6) |
| `contrast.manual` | MANUAL | MANUAL, signed off by name | PGL-02, signed at step 6 |

## What can go wrong

- **A flag change that did not take.** Restart is not recreate; or the var is not in the compose `environment:` block.
  Rules 3 and 4.
- **The release rolled back.** `GAIADA_TAG` missing on the recreate. Check the image tag of `gaiada-platform-1` after every
  recreate and compare it to the one you read before.
- **`--remove-orphans` ran.** It removes containers whose profile is absent. Restore from the profile list in the deploy
  workflow's `COMPOSE_PROFILES` and recreate them; do not repeat it.
- **Exit 2 from the check.** A control read zero or a check errored: this is the plan's "trap", never a PASS. Read the
  `ERROR` line, fix the cause, rerun.
- **A step fails its verify.** Revert that step before starting the next, and say so in the hand-back.

## Hand-back (what the person running this reports)

The `.env.bak-*` file names and dates, each recreate's image tag and `ps` health line, the readiness check's full output
before step 1 and after step 6 (real output, with no secret in it), the MANUAL sign-offs by name and date, and any
destructive clean-up script that was or was not run, with the owner's go quoted.

## Open items for the owner (not in the repo, not invented here)

1. The PGL-Q1 data path, and, for path A, the procedure to create and cut over to a fresh production database.
2. Path B's destructive scripts (purge mock rows, reverse mock ledger postings, retire placeholders): written, reviewed,
   trialled on a restored copy, and given the owner's go.
3. Registering the Midtrans production Payment Notification and redirect URLs, and a production-notification test.
4. The Google Workspace relay's host, port and authentication, and the `notify.gaiada.com` DNS records.
5. Whether the check's `contacts` positive control is satisfied by an `invited` contact (matters on path A).
6. Enrolling every staff member who performs high-assurance actions, before `MFA_SIMULATION_ENABLED=0`.
