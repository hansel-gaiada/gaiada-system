# Placeholder principals — who stands in for whom, and what must be reassigned

**Status: LIVE. This document describes the real production estate (`erp.gaiada.online`).**

Some roles in the live estate are held by a **stand-in account** because the real person does not
yet have an ERP account, or has not been named. Owner ruling (2026-08-25):

> "for now point it to hansel@gaiada.com. as he is superadmin that have platform wide access and
> proven email. so for all specifics email or person that block the progress, u can use
> hansel@gaiada.com. but need to make a document that mention the usage of that user to unblock
> and the detail. so we can move it to the real person in charge of that later in production."

**This file is that document.** Every stand-in grant must appear in the register below, and
every row must be retired before the estate carries real statutory weight.

## Why this needs a register at all

A stand-in grant is invisible once made. `hansel@gaiada.com` legitimately holds platform-wide
access, so a finance grant on top of it changes nothing anyone would notice, produces no warning,
and looks identical to a correctly-assigned role. Six months later nobody can tell which grants
were deliberate and which were scaffolding.

That matters most in finance, where the principal is the audit artefact:

- **A period sign-off names a person.** `finance_fiscal_periods.signed_off_by` is the record that
  "these figures are final". If the stand-in signs, the books assert that Clement Hansel closed
  the period — and an auditor will read it exactly that way.
- **Every journal carries its actor.** Entries posted by a stand-in are attributed to that person,
  permanently, because the ledger is append-only and correction is by reversal. **Reassigning the
  role later does NOT re-attribute history.**

So: use the stand-in to unblock, record it here, and retire it before anyone relies on the books.

## Register

| # | Stand-in | Real holder should be | Scope | Granted | Retire by |
|---|---|---|---|---|---|
| P-01 | `hansel@gaiada.com` | **Accountant** — the person who actually keeps the books | `finance_manager` on D & A Syrowatka, Gaia Digital Agency, Viceroy Bali | 2026-08-25 | Before any real transaction is posted |
| P-02 | `hansel@gaiada.com` | **Finance manager** — approves, signs off periods | same grant as P-01 | 2026-08-25 | **Before the first period sign-off** |
| P-03 | 19 × `portal@<slug>.test` (one per client) | **The client's own representative** — a real person at that company | Global `client` role, `company` scope = Gaia Digital Agency; `client_contacts.capability = 'signer'` | 2026-08-31 | **Before the first contract is sent to any of these clients** |

### Not placeholders — real, and deliberately so

| Who | Role | Note |
|---|---|---|
| `anthony@gaiada.com` (Anthony Syrowatka) | Ownership: holds **D & A Syrowatka 100%**, `kind='holding'` | A **real** existing active account, not a stand-in. One row, not three: a `holding` edge confers the company *plus all descendants*, so this single edge gives him both operating companies. Owner ruling: "by default it should be Anthony 100%" |

## P-01 / P-02: the two are the same grant, and that is itself a problem

The accountant and the finance manager are stand-ins for **the same account**, which collapses a
**segregation-of-duties** control the module was built around: the person who posts an entry should
not be the person who approves it and declares the period final.

While P-01 and P-02 are both `hansel@gaiada.com`:

- SoD on finance is **not** in force in the live estate, whatever the policy says.
- `finance_period_close_readiness()` will still report `NO_ACCOUNTANT_SIGNOFF` for unsigned
  periods — that is correct and should be **left alone**. Do not sign off a period with the
  stand-in to make the check green: it would satisfy the control while destroying the only thing
  it protects, and it does so invisibly, because a green readiness looks identical whether a human
  or a stand-in signed.

This is acceptable while the books are empty. It stops being acceptable the moment real
transactions are posted.

## Retiring a stand-in

1. Create the real person's ERP account (or confirm it exists) and their IAM position.
2. Grant them the role at the same scope.
3. **Revoke the stand-in grant** — `user_roles` row for `hansel@gaiada.com` at that scope.
4. Strike the row from the register above, with the date and who it went to.
5. **Do not** attempt to re-attribute historical journals or sign-offs. They are append-only and
   correction is by reversal; the history correctly records who actually did it. If entries were
   posted under a stand-in, note that fact in the period's audit file rather than editing anything.

## P-03: the client portal logins

Owner ruling (2026-08-31): *"also make a login sso for those clients now. and document it. later in
staging we will put their real login details"*. Provisioned the same day by
`platform-nest/src/admin/provision-client-portal-logins.ts` against the live estate.

**These are a different shape of stand-in from P-01/P-02.** Those over-grant a *real* person's
account; these are *dedicated* accounts that stand in for a person who has not been named yet. That
is the safer shape — nothing is attributed to a real human by mistake — but it still has to be
retired, for the reason below.

### The scheme

| | |
|---|---|
| **Address** | `portal@<slug>.test`, slug derived from the client name with diacritics folded (`Apéritif Restaurant` → `aperitif-restaurant`) |
| **Why `.test`** | Reserved by RFC 2606, so it can **never** route. These accounts cannot receive mail and cannot be confused with a real person's address. Using the client's real domain would mean creating Keycloak accounts against addresses we do not own. |
| **Password** | A **distinct** random password per client. One shared password across 19 portals would mean one leak exposes every client's data. Non-temporary, matching `seed/client-logins.ts` — a forced password-change screen is an unexplained extra step for someone handed a credential out of band. |
| **Where the passwords live** | The gitignored `CREDENTIALS.local.md`, owner's machine only. **Never** the repo, a ticket, or chat. |
| **Recoverable?** | **No.** The script prints each password once and stores nothing. To rotate, re-run the script — it is idempotent (reuses user, contact and role; re-sets only the password). |
| **Sign-in** | Keycloak SSO at `https://erp.gaiada.online/login` |

Each login is four rows, created in this order so that a failure at the last step still leaves the
authorization side correct: a `users` row with `kind='client'` (PK-01's discriminator — a portal
contact is not an employee), a `client_contacts` row binding user to client, the **global `client`
role** (without it the login reaches an empty portal and looks like a data bug), then the Keycloak
account and password.

### The one real hazard: these placeholders can sign

`client_contacts.capability = 'signer'` is not cosmetic. A signer can execute a contract from the
portal — `portal-commerce.controller.ts` writes `contracts.status='signed'`, `signed_at`, and a
`contract_signatures` row carrying `signer_name`. **That is an irreversible attribution**, and this
register's own rules say a stand-in must not hold one without the owner explicitly accepting it.

Checked on provisioning day: **zero** live contracts belong to any of these 19 clients, so the
exposure today is nil. It becomes real the moment a contract is *sent* to one of them.

So, before that happens, do one of:

1. **Replace the placeholder with the client's real representative** (the intended path — see
   *Retiring a stand-in* above), or
2. **Downgrade the capability to `viewer`** for any client not yet represented by a real person:
   `UPDATE client_contacts SET capability='viewer' WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'portal@%.test')`.
   Viewers keep full read access to the portal; only signing is withheld.

Do **not** simply avoid sending contracts and rely on that — the control has to be in the data, not
in someone remembering.

### Retiring one

Follow *Retiring a stand-in* above, plus: soft-delete the `client_contacts` row and disable the
Keycloak account. Leave the `users` row — it may already be referenced by portal activity, and
`kind='client'` keeps it out of employee-facing reads.

## Rules for adding a new stand-in

- It goes in the register **in the same change** that creates the grant. A grant made without a row
  here is a defect, not a shortcut.
- Name the **real role** it stands in for, not just "temporary".
- State what specifically must happen before it is retired — "before the first sign-off" is useful,
  "later" is not.
- Never use a stand-in for something that writes an **irreversible** attribution (a period
  sign-off, an approval that executes) unless the owner has explicitly accepted that the record will
  permanently name the wrong person.

## Related

- `docs/plans/2026-08-25-finance-phase2-PROGRESS.md` — §A6, the open question this unblocks.
- `docs/PERMISSION-CONTRACT.md` — the frozen IAM Phase 1 contract.
- `docs/blueprints/finance-accounting-foundation.md` — §2.2 the SoD matrix these grants collapse.
