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
