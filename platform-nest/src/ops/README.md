# platform-nest ops scripts

Operator tools that ship inside the platform image. The hosts have no Node, so each one is compiled with the rest of the
backend (`tsc -p tsconfig.build.json` writes `src/ops/*.ts` to `dist/ops/*.js`, and the Dockerfile copies `dist/` into the
image) and is run with `node` inside the container. None of them is a Nest route.

The platform container on the live box is `gaiada-platform-1`. Run every command below from the host as
`docker exec gaiada-platform-1 <command>`, or, for a one-off container, with
`docker compose ... run --rm --no-deps platform <command>`.

Status words used here: PLANNED, IN PROGRESS, PROTOTYPED, DEV-VERIFIED.

## `portal-go-live-check.js` (PGL-01, IN PROGRESS)

The readiness check for the day real clients first use the portal. It is **strictly read-only**: one `BEGIN READ ONLY`
transaction that Postgres confirms before anything is read, ended with ROLLBACK. It prints one line per check.

```
docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js          # one line per check
docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js --json   # the same data as JSON
```

Each line is `PASS`, `BLOCK`, `WARN`, `INFO`, `MANUAL` or `ERROR`, then the check id, then the evidence. It never prints a
secret: a key is reported as set or unset and by its prefix class (`SIM-`, `SB-`, other) only.

The cut-over runbook that uses this check as its gate: `infra/runbooks/portal-go-live.md` (PGL-04, PLANNED).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | No check is BLOCK or ERROR. MANUAL lines are still for a person to clear. |
| `1` | At least one check is BLOCK. |
| `2` | At least one check could not run (ERROR), or the run itself failed. An error is never a PASS. 2 outranks 1: the BLOCK lines are still printed, but nothing can be certified from an incomplete picture. |

### The checks (ids are stable; the cut-over runbook cites them)

| Id | Reads | BLOCK when |
|---|---|---|
| `mfa.simulation` | `MFA_SIMULATION_ENABLED` | it is on (`1` or `true`, as the code reads it) |
| `mfa.real` | nothing: always MANUAL | never. No source in the platform records a real second factor (see below) |
| `payments.simulation` | `PAYMENTS_SIMULATION_ENABLED`, `MIDTRANS_ENVIRONMENT` | the flag is on, or the environment is not `production` (blank counts as sandbox) |
| `payments.keys` | `MIDTRANS_SERVER_KEY`, `MIDTRANS_TENANT_ID`, the merchant company's billing profile | the key is unset or a `SIM-` key, the company id is missing or not a live company, or its billing profile has no `gateway_clearing_account_code`. WARN when the key looks like a sandbox key (`SB-`) beside `production` |
| `signatures.simulation` | `SIGNATURE_SIMULATION_ENABLED` | it is on |
| `billing.mock` | every `company_billing_profiles` row | legal name contains `DEV MOCK`, bank is `MOCK BANK`, account is all zeros, prefix ends in `-DEV`, or the address or bank says `seed data` (the seed's own placeholder text) |
| `seal.mock` | every seal certificate valid now (`company_seal_certificates`) | subject contains `DEV MOCK`, or does not match the company's billing legal name, or no company has an active certificate |
| `placeholders.p03` | ACTIVE `client_contacts` whose user's email matches `portal@%.test` | any exist (lists the clients) |
| `placeholders.p04` | ACTIVE contacts held by a user whose `users.kind` is not `client` | one has capability `signer` or `admin` (`admin` signs as `signer` does). A staff `viewer` contact is WARN |
| `mail.sender` | `MAIL_ENABLED`, the notify stream's transport host and From address | mail is off, the host is empty or `mailpit`, or the From domain is `.invalid`, `.test`, `.example` or `.localhost` |
| `mail.client` | `CLIENT_MAIL_ENABLED`, else `CONVERSATION_CLIENT_MAIL_ENABLED` | neither is `1` |
| `data.simulated` | simulated checkouts, simulated PSrE signatures, distinct simulated MFA sessions | INFO only (the question of what happens to them is PGL-Q1) |
| `legal.gate1`, `mail.deliverability`, `contrast.manual` | nothing: always MANUAL | never. Each prints the runbook step that clears it |

Environment names are read through the same `config` object the platform uses, so a name or a parsing rule cannot drift.
The client-mail flag is the one exception: `CLIENT_MAIL_ENABLED` and its one-release alias `CONVERSATION_CLIENT_MAIL_ENABLED`
are each read from the environment directly, so the evidence can say which one is set. The platform treats either as on
(`readClientMailEnabled` in `config.ts`, PGL-09).

### `mfa.real` is MANUAL on purpose

`assuranceFor()` in `src/auth/oidc.ts` derives high assurance on each request from the token's `amr` claim and stores
nothing. The only step-up rows in the database are the simulated ones (`activities.verb = 'auth.step_up_simulated'`, counted
in `data.simulated`). The in-process `amrClaimMissingCount` cannot be read by another process. So a check that said PASS would
be invented. To clear it by hand: `infra/runbooks/enable-mfa.md` applied, a staff account signs in with a real second factor,
`GET /api/me` shows assurance `high` with **no** `assuranceSource`, and the Keycloak sign-in events show that login.

### The RLS zero-row trap, and why a PASS can be trusted

A query without its tenant setting reads **zero rows with no error**, so "no placeholder contacts" would be a PASS on a
database full of them. Every database line is therefore judged only after positive controls taken through the same connection
and tenant context as its own reads:

- `ctx`: the tenant setting is read back with `current_setting` and must equal the company being read, for every company.
- `clients`, `profiles`, `contacts`: at least one client, billing profile or client contact is visible estate-wide, for the
  checks that depend on them. These are estate-wide on purpose, so a holding company with no clients does not fail the run.

A control that reads zero turns the line into `ERROR` and the run into exit 2. Zero companies readable is the same. Every
table read is a core tenant-policy table, so no module scope (`app.scopes`) is declared; a table that later moved behind a
module wall would read zero and be reported, not passed.

### Tests

`src/ops/portal-go-live-check.test.ts` (rules, controls, exit codes, output, secrets; no database) and
`src/ops/portal-go-live-check.db.test.ts` (real Postgres and RLS: each bad state seeded and seen as BLOCK, the unset tenant
setting seen as exit 2, the read-only guarantee). The database suite skips without `DATABASE_URL_TEST`; check the skip count.

## `client-reports-backfill.js` (PV7-04a)

Gives the social and search reports delivered before PV7-04a their client report, so a client sees every report already
delivered to them. **Dry run by default**: without `--apply` it only lists what it would publish and what it would skip.

```
docker exec gaiada-platform-1 node dist/ops/client-reports-backfill.js [--company <uuid>]            # list
docker exec gaiada-platform-1 node dist/ops/client-reports-backfill.js [--company <uuid>] --apply    # create
```

- With `--apply` each report is created exactly as a delivery does it (its own role file under its own storage key, linked to the
  deliverable, client-wide when the engagement has no project), stamped with the original delivery time, with no notice and no
  SSE event: these are history, not news.
- Idempotent: a report that already has a client report (any status, a withdrawn one included) is never touched.
- Every read and write runs inside `withTenants([company])` with the social and search module scopes declared.
- Runs only on the owner's go. Exit `0` on success, `2` on an error.

## `seal-key.js` (PV5-07)

The ops tool for a company's document sealing key: `create`, `list` and `verify`. Runbook: `infra/runbooks/company-seal-keys.md`.

```
docker compose ... run --rm --no-deps -v /etc/gaiada/seal-keys:/seal-keys platform \
  node dist/ops/seal-key.js create --company <company uuid> --out /seal-keys [--years 5]
docker compose ... run --rm --no-deps platform node dist/ops/seal-key.js list --company <company uuid>
docker compose ... run --rm --no-deps -v /tmp/x.pdf:/tmp/x.pdf:ro platform \
  node dist/ops/seal-key.js verify --company <company uuid> --pdf /tmp/x.pdf
```

- `create` needs the key directory mounted read-write, names the certificate after the company's billing legal name, and writes
  an encrypted key and its passphrase as two files (mode 0400, never overwritten). It records only the public certificate in
  `company_seal_certificates`.
- It never prints key material or the passphrase: stdout carries the serial, fingerprint, validity and file paths.
- `list` and `verify` only read.
