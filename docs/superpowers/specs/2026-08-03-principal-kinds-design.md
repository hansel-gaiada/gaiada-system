# Principal kinds — `users.kind` (employee · client · automation · bot)

Status: **PLANNED**. Owner decision 2026-08-03. Supersedes the interim fix described in
"What ships today" below.

## Why non-human principals are `users` rows at all

Not an accident, and not worth undoing. Authorization in this platform is defined over
*principals*, and a principal is a `users` row:

```
OBO envelope (provider, external_id)  ->  identity_links  ->  users  ->  user_roles  ->  Cerbos
```

An n8n workflow presents `x-obo-provider: n8n` + `x-obo-external-id: wf:<name>`; the AuthGuard
resolves the VERIFIED identity link to a real principal. A workflow that is not a user therefore
cannot be authorized *at all* — it lands anonymous and Cerbos denies. Observed live on 2026-08-03:
the five `wf:reports-*` accounts had never been seeded, and every one of those CRONs failed with
`403 cerbos denied pending_reminders on checkin`.

The payoff is one authorization substrate rather than two: per-principal least privilege
(`wf:task-sla` = `member`, `wf:wd-digests` = `company_admin`), every automation write attributed to
a named actor in the audit log, and revocation through the same `session_version` bump a human gets.
A parallel path for non-humans is how you end up authorized on one endpoint and denied on another.

The cost is that "principal" and "person" are different sets, and every people-shaped surface has to
know the difference.

## What ships today (interim)

`company_memberships.kind ('employee','service')` — added by `0026` for the shared-service
reconciler — is being reused to mark automation accounts as `service`, and the people-shaped
readers filter on it:

- `GET /api/:t/members` — employee-only by default, `?includeService=1` opts in (pre-existing).
- `GET /api/:t/users` — same convention, added 2026-08-03. Settings → Users & Roles opts in and
  badges the row (that is where automation grants get audited and revoked); the People directory
  and HR take the default.

This works and is reconciler-safe: the reconciler only deletes rows that are `kind='service'`
**AND** `managed_by IS NOT NULL`, and seeded automation memberships have `managed_by NULL`.

**But it overloads one column with two questions.** `company_memberships.kind` answers *"why is
this principal in this company"* (a real member vs materialized by a shared-service assignment).
Whether an account is a human is a property of the ACCOUNT, not of one membership — and the two
axes are independent: a served-company HR manager is a human with `kind='service'`.

## The target model

Add a discriminator to `users`, where it belongs, with **four** kinds:

| `users.kind` | What it is | Authenticates via | Appears in people surfaces |
|---|---|---|---|
| `employee` | Staff | Keycloak SSO (`idp_subject`) | yes |
| `client` | External client portal user | client Keycloak realm | no — client-facing surfaces only |
| `automation` | n8n workflow service account | OBO envelope `provider=n8n` | no |
| `bot` | Hermes and its personas, WA/TG bot identities | OBO envelope, per-persona external id | no |

`bot` is deliberately distinct from `automation`: a workflow is a fixed, reviewable script whose
tool allow-list is pinned in the MCP hub, whereas a Hermes persona is a model-driven agent whose
next action is not enumerable in advance. They warrant different budget attribution, different
audit expectations, and different assurance floors — collapsing them into one kind throws that
distinction away exactly where it matters most.

`company_memberships.kind` **stays as-is** and keeps its current meaning. The two are orthogonal:
`users.kind` = what this account is; `company_memberships.kind` = why it is in this company.

### Migration sketch

1. `ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'employee' CHECK (kind IN ('employee','client','automation','bot'))`.
2. Backfill from evidence already in the DB, not from guesses:
   - `automation` — a verified `identity_links` row with `provider='n8n'`.
   - `client` — the user is some `clients.portal_user_id`.
   - `bot` — verified `identity_links` with `provider IN ('whatsapp','telegram')` and no employee
     membership, plus the Hermes persona ids once those exist.
   - everything else stays `employee`.
   `company_memberships` is FORCE-RLS and migrations run as `platform_owner` (NOBYPASSRLS), so any
   step reading it must set `app.current_tenant_ids` per tenant — see
   `0051_pm_short_codes_backfill_fix.sql` and `scripts/lint-migration-rls.mjs`.
3. Move the readers onto `u.kind = 'employee'` and retire the `m.kind='service'` filter added for
   the interim fix (leaving `m.kind` itself alone for the reconciler).
4. Partial unique index thinking applies here too: if any per-kind uniqueness is added later,
   remember a nullable column in a UNIQUE constraint is not constrained for its NULLs — that is
   how `roles` accumulated ten `manager` rows (`0073`).

### Surfaces to revisit when this lands

People directory · HR headcount + directory · assignee pickers (tasks, projects, onboarding,
appraisals) · org-structure person nodes · `Me.serviceScopes` consumers · anything counting
"PEOPLE". Each currently trusts membership alone.

## Verified numbers at the time of writing (gda-aicenter)

37 active users, 0 disabled, 0 orphaned (every user has a membership):

| Class | Count |
|---|---|
| n8n automation service accounts | 17 |
| Seeded test people (`*.test`, dev-login only, no `idp_subject`) | 17 |
| Messaging-linked (WhatsApp/Telegram) | 2 |
| Real SSO humans | **1** |

Both `clients` rows have `portal_user_id` NULL — there is no `client` principal yet, which is why
the client portal cannot be exercised end-to-end.
