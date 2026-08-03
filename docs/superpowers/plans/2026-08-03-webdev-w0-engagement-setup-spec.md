# W0/W1 build spec — engagement setup, client invites, scheduling

**Date:** 2026-08-03 · Builds on the
[gap assessment](./2026-08-03-webdev-gap-assessment.md) + its
[ratified addendum](./2026-08-03-webdev-gap-assessment-addendum.md).
**Owner decision:** client auth = **A + C** — a magic-link email invite whose acceptance
**provisions a real Keycloak account**. Client-side dashboard is explicitly **deferred**.

## The owner's flow, as stated

```
PM sets up: project + schedule + external contacts
  └─ add client info → invite by email → they accept → system creates their
     Keycloak account (username/password) → they can access → data live both ways
```

---

## 0 · The insight that makes A+C one flow, not two options

`auth/oidc.ts:60 provisionUser()` **already** implements invite-then-login linking:

> "First login: link to a pre-existing (invited) account by email **ONLY when the IdP has verified
> that email** — otherwise anyone who registers an unverified address matching a colleague's could
> hijack their account. An unverified email that collides is **refused**."

So the flow the owner described is already anticipated in code — with one hard constraint:

⚠️ **If the Keycloak account is created with `emailVerified: false`, the client's first login THROWS**
(`"email collides with an existing account but is not IdP-verified — refusing to link"`). Not a soft
failure: the invited contact simply cannot get in, and the error names an internal invariant.

**Therefore the magic link is not a convenience — it is the email proof that earns the right to set
`emailVerified: true`.** The client clicked a single-use token sent to that address, so we know they
control it; that is exactly the evidence Keycloak's `emailVerified` flag is supposed to represent.
Set it any other way and we would be lying to our own takeover guard.

**Consequence for the build:** acceptance of the magic link and creation of the Keycloak user must be
one transaction-like step, and the Keycloak user MUST be created with `emailVerified: true`. This is
the single most important correctness constraint in W0.

---

## 1 · What must be built (nothing here exists today)

| | Capability | Current state |
|---|---|---|
| 1.1 | `client_contacts` (many contacts, project-scoped, signer/viewer) | `clients.portal_user_id` is singular and written only in test fixtures |
| 1.2 | `client_invites` (single-use, expiring, email-bound token) | nothing; `enrollment_codes` (0005) is the right **shape** to copy but is user-keyed, untenanted and for chat-identity linking — a new table, not a reuse |
| 1.3 | **Keycloak Admin API client** (create user, set credentials, `emailVerified: true`) | ⚠️ **platform-nest has NO Keycloak admin integration at all** — the only `keycloak` references are in the SEO endpoint guard. This is net-new. |
| 1.4 | The `client` role row | ⚠️ **never seeded anywhere**, though `resource_portal.yaml` and `derived_roles.yaml` both depend on it |
| 1.5 | `company_memberships` row for contacts + `kind='client'` | `kind` CHECK is `('employee','service')` (0026:173) |
| 1.6 | **Meeting scheduling** | ⚠️ `meeting_recordings` has `started_at`/`ended_at` but **no scheduled concept** — there is no way to schedule a meeting in the product |
| 1.7 | Meeting participants (both sides) | nothing |
| 1.8 | Notifications reaching client contacts | `notify()` silently drops non-members (`core/http.ts:78-81`) |

---

## 2 · Schema (one additive migration, next-unused at merge)

```sql
-- 2.1 many contacts per client, optionally scoped to a project
client_contacts(
  id, tenant_id -> companies, client_id -> clients, user_id -> users,
  project_id uuid NULL -> projects,          -- NULL = client-wide (every project)
  capability text CHECK (capability IN ('signer','viewer')),
  status     text CHECK (status IN ('invited','active','revoked')),
  invited_by -> users, invited_at, activated_at, revoked_at,
  UNIQUE (tenant_id, client_id, user_id, project_id)   -- + a partial unique for project_id IS NULL
)

-- 2.2 the magic link. Shape copied from enrollment_codes (0005): single-use, expiring,
--     partial index on unconsumed. Token is stored HASHED — it travels in an email.
client_invites(
  id, tenant_id -> companies, client_contact_id -> client_contacts,
  email citext NOT NULL,            -- bound at issue; acceptance must match it
  token_hash text NOT NULL UNIQUE,  -- sha256; never the raw token
  expires_at timestamptz NOT NULL,  -- short (72h) — it grants account creation
  consumed_at timestamptz, consumed_ip text,
  invited_by -> users, created_at
)
CREATE INDEX ... ON client_invites (token_hash) WHERE consumed_at IS NULL;

-- 2.3 membership kind gains 'client'  (see §5 — this is the hazardous one)
ALTER TABLE company_memberships DROP CONSTRAINT ... ;
  ADD CHECK (kind IN ('employee','service','client'));

-- 2.4 the run finally remembers its project + owner
ALTER TABLE pipeline_runs
  ADD COLUMN project_id uuid REFERENCES projects(id),
  ADD COLUMN owner_id   uuid REFERENCES users(id);

-- 2.5 scheduling, on the EXISTING registry rather than a parallel calendar
ALTER TABLE meeting_recordings
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN scheduled_by uuid REFERENCES users(id);
-- widen the status CHECK to add 'scheduled' as the pre-recording state
```

**Why scheduling rides `meeting_recordings` rather than a new `meetings` table:** that registry already
carries `client_id`, `project_id`, `title`, `kind` and mints the stable `meeting_id` the whole frozen
dispatcher contract keys on. A scheduled meeting is the same entity earlier in its life, so a parallel
table would duplicate the registry and force a merge at record time. New status `scheduled` →
`recording` → … the recorder attaches to the existing row instead of creating one.

**Why this makes D-3 true rather than nominal:** the row exists, scoped to client + project + both
sides' participants, **before** anyone presses record.

```sql
-- 2.6 who is in the meeting, on both sides
meeting_participants(
  id, tenant_id, recording_id -> meeting_recordings, user_id -> users,
  side text CHECK (side IN ('internal','client')),
  UNIQUE (tenant_id, recording_id, user_id)
)
```

---

## 3 · The invite → accept → provision flow

```
(1) PM adds client info + contacts        POST /api/:t/clients/:id/contacts
      → users row (email, no idp_subject) + client_contacts(status='invited')
      → client_invites row, raw token returned ONCE to the caller
      → email sent with the magic link
(2) Contact clicks the link               GET/POST /api/invites/:token/accept   (tenant-agnostic)
      → look up by sha256(token) WHERE consumed_at IS NULL AND expires_at > now()
      → ATOMIC single-use consume (UPDATE ... WHERE consumed_at IS NULL RETURNING)
      → they set a password on this screen
(3) System provisions                     Keycloak Admin API
      → create user: username=email, email=email, emailVerified=TRUE  ← §0, load-bearing
      → set the password credential
      → client_contacts.status='active', activated_at=now()
      → company_memberships row (kind='client', no role beyond `client`)
      → user_roles grant: role='client', scope_type='company', scope_id=tenant
(4) They log in normally                  Keycloak → platform
      → provisionUser() finds the users row BY EMAIL, sees emailVerified, links idp_subject
      → resource_portal.yaml: derived role `client` + inTenant both now hold
```

Security properties, deliberately mirroring the OAuth-state work already in the tree
(`modules/search/google/oauth-state.ts` — same estate, same reasoning):

- **Token stored hashed**, never raw — it travels through email, which is not a secure channel.
- **Single-use via atomic consume**, not check-then-act, so a double-clicked link cannot provision twice.
- **Email bound at issue time** and re-compared at acceptance, so a leaked token cannot be redeemed
  for a different address.
- **Short expiry (72h)** because this token grants account creation, not merely a read.
- **Acceptance is tenant-agnostic** (`/api/invites/:token/accept`) — the tenant travels inside the
  invite row, exactly as the Google callback carries it in signed state, because the clicker has no
  session yet and cannot supply `:tenantId`.
- **Revoke** (`DELETE .../contacts/:id`) sets `status='revoked'`, disables the Keycloak user and
  soft-deletes the membership — the portal then fails `inTenant` and every read returns nothing.

---

## 4 · "Live both ways" — what it already means, and what is actually missing

Stated precisely so the claim is not oversold: **the data layer is already live both ways.** The
portal reads the *same* `pipeline_runs` / `pipeline_stages` / `pipeline_gates` rows the internal
surfaces write (`portal.controller.ts`), so a client sees the current artifact on load and a client's
signature is immediately visible internally. There is no sync, no copy, no staleness.

What is missing is therefore **not** data propagation but:

1. **Notification** — `notify()` drops client contacts silently today (§1.8). Fixed for free by the
   membership row in §2.3, and then every pipeline event must actually address the scoped contacts.
2. **The client's own surface** to see it — the dashboard, explicitly **deferred** by the owner.
3. **Push/refresh** — everything is request-time server-rendered. Genuine live push (SSE/websocket)
   does not exist anywhere in this estate and is **out of scope**; the honest description is
   "current on every load", not "real-time".

---

## 5 · ⚠️ The one hazardous change — `kind='client'` and the staff-directory leak

Widening `company_memberships.kind` is what makes notifications and `inTenant` work, and it is also
the only change here that can leak data: **~20 non-test query sites read `company_memberships`**, and
any that does not filter `kind` will start listing client contacts as employees — in `/people`, the HR
directory, org charts and rollups.

The 0026 service-account work already established filtering on `kind`, so the pattern exists. But this
must be an **audited sweep with a lint or shape-pinning test**, not a careful read-through, because
the failure is a data-exposure bug that no current test asserts against and that looks like ordinary
data once it happens.

Treat this as the gate on W0: the migration may not land until the sweep + pin are in the same change.

---

## 6 · Build order inside W0/W1

```
W0-1  migration (§2, all of it — additive, no backfill) + seed the `client` role
W0-2  the kind='client' filter sweep + lint/shape-pin            ← gates the migration landing
W0-3  Keycloak Admin API client (create user, set credential, emailVerified) + config/env
W0-4  contacts + invites endpoints & Cerbos `client_contact` kind (manager-tier per D-2);
      widen scope_signoff.create to manager
W0-5  the accept screen (tenant-agnostic route + password set)

W1-1  PM engagement-setup UI: project → schedule → contacts, one flow
W1-2  scheduling UI + meeting_participants; recorder attaches to a scheduled row
W1-3  notify scoped client contacts on pipeline events (+ on schedule)
W1-4  agency scope sign-off UI (B1)
```

## 7 · Two prerequisites, now verified

### 7.1 ⚠️ There is NO email transport in this estate — and it should stay off the critical path

Verified: `platform-nest` has **no** mail code and **no** mail dependency (no nodemailer/resend/
sendgrid/postmark in `package.json`, no `sendEmail` anywhere). The only SMTP vars in the repo
(`infra/compose/.env.example:167-171`) belong to **Alertmanager** for observability alerts — a
different service, not a platform capability.

So "invite by email" is net-new infrastructure: a dependency, a mail service with a provider seam, a
`from` identity, deliverability/SPF-DKIM on the sending domain, plus bounce handling if it is to be
trusted for account provisioning.

**Recommendation — split it, so a mail stack does not gate the flow:**

- **W0 (now): "copy invite link".** `POST .../contacts` already returns the raw token exactly once;
  the PM copies the link and sends it however they already talk to that client (WhatsApp, their own
  email). The entire invite → accept → provision → login chain is then complete and testable **with
  zero mail infrastructure**, and the security properties in §3 are unchanged — the token is what
  proves email control, not the transport that carried it.
- **W1+ (follow-up): automated send.** Add the mail seam and have the invite dispatch itself; the
  endpoint contract does not change, only whether a human forwards the link.

⚠️ One honesty caveat to carry if we ship the copy-link version: `emailVerified: true` on the Keycloak
user is justified by "they clicked a token that was delivered to that address". If the PM pastes the
link into WhatsApp instead, that justification weakens to "the PM vouched that this address belongs to
this person". That is acceptable for a PM-driven B2B onboarding — the PM is a trusted actor who is
also the one entering the address — but it must be a stated decision, not a silent one, and the
automated-send follow-up restores the stronger property.

### 7.2 Keycloak admin access — the client exists, the permission does not

The `gaiada` realm already has a confidential `gaiada-platform` client (verified on the server). What
it lacks is a **service account with `manage-users`** on that realm. Two options, in order of
preference:

1. Enable the service account on `gaiada-platform` and grant it the `realm-management` →
   `manage-users` role. One client, already trusted by the platform.
2. A dedicated `gaiada-provisioner` client, if we want user-creation separable from the platform's own
   token audience.

**Never the master-realm admin credentials** — the platform must be able to create users in `gaiada`
and nothing else. New env: the client id/secret + the realm base URL (the platform already knows
`http://keycloak:8080/idp` internally).

### 7.3 Deferred by decision

Client-side dashboard.
