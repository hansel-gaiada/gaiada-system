# Agency — Discovery Intake (AD-1): design + ticket decomposition

Status: **PLANNED**. Drafted 2026-09-05. No code written against this yet.

Source material: `Website_Brand_Guidelines_Client_Onboarding.xlsx` (the agency's existing
client-discovery workbook, 12 sheets) and a working standalone HTML form built from it
(122 questions, 13 sections). This document is about bringing that capability *into* the platform
rather than leaving it beside it.

**The capability in one line:** a prospect who is not yet a client fills a structured discovery
questionnaire through a link we sent them; the agency is notified, reviews the answers in the ERP,
and either declines, nurtures, or converts — where converting mints the client, the project, the
delivery run seeded from their own answers, and the delegation tasks.

---

## §0 · What already exists (verified in code on 2026-09-05, not assumed)

Everything below was read, not inferred. It matters because most of this feature is *assembly*,
not invention.

| Thing | State | Where |
|---|---|---|
| `agency` module | registered in `main.ts`; campaigns, briefs, approvals | `platform-nest/src/modules/agency/agency.controller.ts` |
| `agency_briefs` | exists but is a **campaign** brief — `campaign_id NOT NULL` | `migrations/0002_module_agency.sql:20` |
| Client portal | token-scoped contacts, `resolvePortalScope` | `platform-nest/src/core/portal-scope.ts` |
| **Intake → triage → convert precedent** | MI-02 webdev change requests. **This design is its sibling and copies its idioms deliberately.** | `docs/superpowers/plans/2026-08-07-webdev-maintenance-intake-design.md` |
| Pipeline runs/stages/gates | tracks `delivery\|report\|scope`, client sign gates | `migrations/0017_pipeline.sql`, `core/pipeline.controller.ts` |
| PM tasks + assignees | poly-assignee, in-process task creation | `platform-nest/src/modules/pm/` |
| Free-text scrubbing | `scrubText()` | `platform-nest/src/core/scrub.ts` |
| Transactional outbox | `emitEvent(client, tenantId, entityType, entityId, eventType, payload)` | `platform-nest/src/events/outbox.service.ts` |
| Best-effort notify | `notifyBestEffort(tenantId, actorId, recipientIds, type, payload)` — **`actorId` is already `string \| null`** | `platform-nest/src/core/client-notify.ts:70` |
| Portal realtime bus | topic+timestamp only, carries no business data | `platform-nest/src/core/portal-live.service.ts` |

### 0.1 The two gaps that shape this whole design

**Gap 1 — there is no prospect.** `grep` for `CREATE TABLE .*(lead|prospect|deal|opportunit)` across
all 226 migrations returns nothing. The estate has `companies`, `clients`, `client_contacts` and
that is all. Every client-facing surface resolves authorization from an *existing* `clients` row via
`resolvePortalScope`. **A prospect has nowhere to exist and no way to authenticate.** This is the
reason AD-1 cannot simply be "another portal page".

**Gap 2 — there is no unauthenticated write surface.** Every `@Controller` in `platform-nest`
carries `AuthGuard` except two: `health.controller.ts` and `mcp-tools.controller.ts` (the latter is
`ServiceGuard`-gated for the hub's `PLATFORM_SERVICE_TOKEN`). There is no `@Public()` decorator, no
`SkipAuth`, no anonymous path of any kind. **AD-1 would be the first write reachable without a
platform session**, which is why §4 is the longest section here and why the framing in §2 matters
more than any other decision in this document.

---

## §1 · Scope, and the one thing this is not

**In scope:** prospect discovery capture, staff review, triage disposition, conversion into
client + project + delivery run, and delegation to a team.

**Not in scope, deliberately:** a CRM. `agency_leads` (§3) is *not* a deal pipeline — no stages, no
forecast, no value-weighted funnel, no activity feed of its own. It is the minimum record that lets
a prospect exist long enough to be converted or declined. If the group later wants sales-pipeline
management, that is its own program and it should own `agency_leads` rather than this feature
growing into it. Stating the boundary now is cheaper than defending it later.

**Also not in scope:** replacing the workbook. The four agency-side sheets (Design System,
Approvals & Sign-off, QA Checklist, Project Decision Log) are filled by *us* after discovery and
stay where they are. Only the seven client-facing sheets become the questionnaire.

---

## §2 · The access model — **capability-token authenticated, not "public"**

This is the load-bearing decision of AD-1 and it should be read before anything else.

The naive reading of "public prospect form" is an open, unauthenticated `POST` on the internet that
writes to the ERP's database. Given §0.1 Gap 2, that would be the single largest new attack surface
in the estate, and it would arrive with no rate limit, no tenant resolution, no attribution and no
abuse story.

**The design refuses that framing.** Access is by a **capability token** — a bearer secret we mint
and send to a named prospect. The endpoint is therefore *not* unauthenticated; it is authenticated
by something other than a platform session. That distinction is not cosmetic:

| Property | Open public POST | Capability token (this design) |
|---|---|---|
| Tenant resolution | must be guessed from body or host | **path-scoped, then token-verified** — see §2.3 |
| Who submitted | unknowable | the lead the token was minted for |
| Abuse ceiling | the internet | the tokens we chose to issue |
| Revocation | none | revoke the row |
| Attribution for criterion 6 | impossible | lead id + token id |
| Replay | unbounded | single-submission, expiring |

It also matches how the agency actually works: discovery goes to a prospect *after* a first
conversation, not to anonymous traffic.

### 2.1 Two token kinds, one mechanism

```
kind='invite'   minted by staff for ONE named prospect. Expiring (default 30d),
                single-submission. Creates the lead up front, so staff can see
                "sent, not yet returned" in the queue. -> v1
kind='open'     a long-lived per-tenant form key for cold inbound from the marketing
                site. Mints a NEW lead per submission. -> SCHEMA-ADMITTED, ENDPOINT-REFUSED in v1
```

`open` is admitted by the CHECK constraint now so that enabling it later needs no migration — the
same move MI-02 made for its `control_plane` route (§2.3 there), and for the same reason. The v1
endpoint returns a typed refusal naming AD-9 (§8). **Why it is not in v1:** an open key is only
safe behind bot defence (Turnstile or equivalent), a per-IP rate limit, and a quarantine state so
that junk never reaches the triage queue directly. That is a coherent ticket; it is not a flag flip,
and shipping it as one would be exactly the "lite deviation" the full-fidelity mandate forbids.

### 2.2 Token handling rules

- **Store a hash, never the token.** `token_hash bytea NOT NULL` (SHA-256). The plaintext exists
  once, in the response to the staff member who minted it, and in the link they send. A leaked
  database therefore leaks no working links. Mirrors the estate's credential-reveal discipline
  (`core/connection-reveal.ts`).
- **Compare in constant time**, and look the token up *by hash* so the lookup itself is not a
  timing oracle.
- **Not a URL query parameter.** `?token=` lands in nginx access logs, `Referer` headers on any
  outbound link, and browser history. The link carries it as a **fragment** (`#t=…`, never sent to
  a server) which the page reads and replays in an `X-Intake-Token` header. This is the one place
  the static-form work already done needs a change.
- **Rate limit at the edge regardless.** The token bounds *who*, not *how often*.

### 2.3 AMENDMENT (2026-09-05, found during AD-2/AD-3) — a hash-only lookup is impossible here

§2.2 above says "look the token up **by hash**", and as originally written **that cannot work**.
The AD-2/AD-3 implementer raised it rather than quietly routing around it, and the objection is
correct:

`agency_intake_tokens` ships FORCE RLS with a plain tenant wall and — deliberately, per the
migration header — **no `principal_lookup`-style bypass policy**. Under FORCE RLS with
`app.current_tenant_ids` unset, *every* query against the table returns zero rows. So a lookup that
knows only the hash has no tenant to open a `withTenants` transaction with, and would resolve
nothing, always. The two properties are simply incompatible: either the table has an RLS bypass, or
the tenant arrives from outside the token.

**Resolution taken: the tenant arrives in the path**, `/api/:tenantId/intake/...`, which is how
every other route in this codebase resolves tenancy. The lookup is then hash-based *within* that
tenant.

Why this does not weaken the model:
- **The `tenantId` is never an authorization fact.** It only chooses which tenant's rows the query
  can see. A caller who supplies a wrong tenant with a valid token resolves nothing — outcome
  identical to an unknown hash, and indistinguishable to the caller.
- **A tenant id is not a secret.** It appears in every authenticated URL in the estate already.
- The alternative — adding an RLS bypass policy so an anonymous surface can read a table
  tenant-blind — trades a URL segment for a hole in the wall, on the one table reachable without a
  platform session. That is the wrong trade.

**What this costs, stated plainly:** the claim in §2.2's table that the tenant is "carried by the
token" is no longer true, and a `kind='open'` public link will therefore carry the tenant id in its
URL. Harmless here (one agency, one tenant), but AD-9 should not assume otherwise. If a future
requirement genuinely needs the tenant hidden, the clean fix is a compound token
(`<tenantId>.<secret>`) parsed server-side — not an RLS exemption.

---

## §3 · Schema

Migration name at write time: `date -u +%Y%m%d%H%M` + `_agency_discovery_intake.sql`. Head on
2026-09-05 was `202609040505_automation_approvals_origin_credential_reveal.sql`. The sequential
`NNNN_` scheme is closed above `0118` and CI-enforced — do not use it.

### 3.1 The module-wall decision — **plain tenant wall, following MI-02 §1.1**

`agency_*` tables are module-walled by default (`app_module_allowed('agency')`). **These three
tables are not**, and the reasoning is MI-02's, which was owner-ratified as D-2a:

1. The primary writer is a **core, non-module surface** that declares no module scope. Under
   `withTenants(..., { modules: [...] })` the third wall is a two-sided handshake (`0028:39–52`); a
   controller that declares nothing reads **zero rows, silently**. That is the failure mode on the
   feature's primary path.
2. A prospect's submission vanishing because someone toggled `enabled_modules` is precisely the
   "fail the portal closed for reasons no one would find" failure that `0072:214` and `0075:242`
   rule against.
3. What the wall would buy — keeping non-agency staff out — is provided by Cerbos (§5) instead.

**So: no `module` column, no `app_module_allowed()` clause.** Plain tenant wall, FORCE RLS,
`NULLIF`-hardened per 0025.

### 3.2 Why the submission is a separate table from the lead

`agency_leads` is **mutable state** (owner, status, triage disposition).
`agency_discovery_submissions` is an **immutable document** — what the prospect actually said, at a
point in time.

Conflating them means triage mutates the record of the client's own words. For an agency that is
not a modelling nicety: the discovery answers are the evidentiary basis of scope, and "you told us
X" has to survive the row being edited. A submission is therefore `INSERT`-only; corrections arrive
as a *new* submission with `supersedes_id` set, and both are kept.

### 3.3 DDL

```sql
-- <stamp>_agency_discovery_intake.sql — agency discovery intake (AD-1).
-- RLS: CORE plain tenant wall, deliberately NOT app_module_allowed('agency') — see design §3.1
-- (MI-02 D-2a doctrine: the primary writer is a non-module surface).
-- No DML: nothing to backfill, so the 0050 NOBYPASSRLS backfill trap does not apply.

-- Tenant-scoped composite-FK targets (0075 §0 pattern). Additive, cannot fail: id is each
-- table's PK so (id, tenant_id) is trivially unique.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_runs', 'pm_tasks', 'projects', 'clients'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('ux_%s_id_tenant', t)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT ux_%s_id_tenant UNIQUE (id, tenant_id)', t, t);
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────── leads
CREATE TABLE agency_leads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  org_name text NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  source text NOT NULL DEFAULT 'invite' CHECK (source IN ('invite','open','staff')),
  -- Lifecycle (§4.1). 'invited' exists so the queue can show "sent, not yet returned".
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','submitted','in_review','nurturing','converted','declined')),
  owner_id uuid REFERENCES users(id),          -- the AM who owns the prospect
  converted_client_id uuid,
  converted_project_id uuid,
  pipeline_run_id uuid,
  declined_reason text,
  triaged_by uuid REFERENCES users(id),
  triaged_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- STRUCTURAL state machine, not controller discipline (0075 doctrine).
  CONSTRAINT lead_converted_has_client CHECK (
    (status = 'converted') = (converted_client_id IS NOT NULL)
  ),
  CONSTRAINT lead_declined_has_reason CHECK (
    status <> 'declined' OR declined_reason IS NOT NULL
  ),
  CONSTRAINT fk_lead_client_tenant  FOREIGN KEY (converted_client_id, tenant_id)  REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_lead_project_tenant FOREIGN KEY (converted_project_id, tenant_id) REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_lead_run_tenant     FOREIGN KEY (pipeline_run_id, tenant_id)      REFERENCES pipeline_runs (id, tenant_id)
);

-- One client per lead and one run per lead — the schema backstop behind §6's lock argument.
-- PARTIAL uniques over the non-null set: a plain UNIQUE on a nullable column constrains nothing
-- (trap #6, the 0072:73 / 0075:148 house pattern).
CREATE UNIQUE INDEX ux_lead_client ON agency_leads (converted_client_id) WHERE converted_client_id IS NOT NULL;
CREATE UNIQUE INDEX ux_lead_run    ON agency_leads (pipeline_run_id)     WHERE pipeline_run_id IS NOT NULL;
CREATE INDEX ix_lead_queue  ON agency_leads (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_lead_owner  ON agency_leads (tenant_id, owner_id) WHERE deleted_at IS NULL;

-- ───────────────────────────────────────────────────────── intake tokens
CREATE TABLE agency_intake_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  lead_id uuid,                                 -- NULL only for kind='open'
  kind text NOT NULL CHECK (kind IN ('invite','open')),
  -- SHA-256 of the plaintext. The plaintext is returned exactly once, at mint (§2.2).
  token_hash bytea NOT NULL,
  expires_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tok_invite_has_lead CHECK ((kind = 'invite') = (lead_id IS NOT NULL)),
  CONSTRAINT fk_tok_lead_tenant FOREIGN KEY (lead_id, tenant_id) REFERENCES agency_leads (id, tenant_id)
);
-- Lookup is BY HASH (§2.2) — this index is the whole read path, and it must be unique so a
-- collision cannot silently authenticate the wrong lead.
CREATE UNIQUE INDEX ux_tok_hash ON agency_intake_tokens (token_hash);
CREATE INDEX ix_tok_lead ON agency_intake_tokens (tenant_id, lead_id) WHERE lead_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────── submissions
CREATE TABLE agency_discovery_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  lead_id uuid NOT NULL,
  token_id uuid REFERENCES agency_intake_tokens(id),
  -- The questionnaire contract this payload was produced against. A stored answer set is
  -- meaningless without knowing which question set produced it.
  schema_version text NOT NULL,
  -- The answers, keyed by the form's stable machine ids. JSONB, not 122 columns: the question set
  -- WILL change and a column-per-question schema turns every wording change into a migration.
  -- Reads that need one field use the generated columns below.
  answers jsonb NOT NULL,
  -- Submission-time facts, kept out of `answers` so the answer set stays purely the client's words.
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Written by the app, NOT a generated column. A GENERATED expression must be provably IMMUTABLE
  -- and the jsonpath route is not worth the gamble on a migration that cannot be rehearsed locally
  -- (the 16-container stack is off by owner decision). The submission is INSERT-only (§3.2), so an
  -- app-written count cannot drift the way it could on a mutable row.
  answered_count int NOT NULL DEFAULT 0,
  required_answered int NOT NULL DEFAULT 0,
  required_total int NOT NULL DEFAULT 0,
  supersedes_id uuid REFERENCES agency_discovery_submissions(id),
  redactions int NOT NULL DEFAULT 0,            -- count from scrubText(), §7
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_sub_lead_tenant FOREIGN KEY (lead_id, tenant_id) REFERENCES agency_leads (id, tenant_id)
);
CREATE INDEX ix_sub_lead ON agency_discovery_submissions (tenant_id, lead_id, created_at DESC);
-- A token is single-submission (§2.1). This is the schema half of the submit idempotency story;
-- the transition half is the token's used_at check under lock (§6.1).
CREATE UNIQUE INDEX ux_sub_token ON agency_discovery_submissions (token_id) WHERE token_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────── RLS
-- Plain tenant wall on all three. NO app_module_allowed() (§3.1). NULLIF hardening per 0025.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_leads','agency_intake_tokens','agency_discovery_submissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
  END LOOP;
END $$;
```

**Notes the implementer must not "simplify" away**

- **Composite FKs are the tenancy guarantee, not the plain FK.** An FK check runs as the table
  owner, outside RLS (0075 §0). A single-column FK to `clients(id)` would happily point across
  tenants.
- **`answers` is JSONB on purpose.** 122 columns would make every question reword a migration, and
  the question set is expected to change per vertical.
- The CHECK constraints encode the lifecycle **structurally**. `lead_converted_has_client` is what
  makes "converted with no client" unrepresentable rather than merely untested.
- `ON CONFLICT` is never used against the partial uniques (trap #6's second half); the convert path
  re-checks preconditions under a lock instead (§6.2).

---

## §4 · Lifecycle

### 4.1 Lead state machine — all transitions server-side, all event-emitting

```
   staff: create lead                          (source='staff' — e.g. they phoned in)
                    │
                    ▼
                  new ◄─── an ACTIONABLE state: met them, never sent the form.
                    │       Amended 2026-09-05 after AD-4/5 review found that a staff-created
                    │       lead was landing in 'invited' with nothing ever invited, which hides
                    │       the most droppable thing in an agency pipeline.
                    ▼ staff mints an invite token   (kind='invite')
                invited ──── token expires / revoked ───► (stays invited; staff re-mints)
                    │
                    ▼ prospect submits  [AD-2, token-guarded]
                submitted ──────────────────────────────► notify AM + agency queue
                    │
                    ▼ staff opens it   [AD-4]
                in_review
                    │
      ┌─────────────┼──────────────────┬─────────────────────┐
      ▼             ▼                  ▼                     ▼
  declined      nurturing          converted            (re-submit:
  [terminal,    [not ready;        [AD-5 spawner]        new submission
   reason        re-invite later]        │                row, supersedes_id,
   required]                             │                lead stays put]
                                         ▼
                            client + project + pipeline_run
                            + delegation tasks  [AD-6]
```

`nurturing` is not decoration — it is the difference between "we said no" and "not this quarter",
and an agency that cannot express the second one loses the prospect entirely.

### 4.2 What conversion creates, and why the pipeline picks it up with zero special-casing

This mirrors MI-02 §3.1 closely enough that the differences are the interesting part. One
`withTenants([tenantId], …)` transaction:

1. **`clients` row** — `name` from `answers.org_name`. Plus a **`client_contacts` row** from
   `contact_name`/`contact_email`, which is what later lets the new client into the portal at all.
2. **`projects` row** — the website project itself.
3. **`pipeline_runs` row** — `title` from the project, `client_id`/`project_id` from 1 and 2,
   `owner_id` = the converting staff member (validated by the existing `assertOwnerIsStaff` idiom,
   `pipeline.controller.ts:141`), `status='delivery_active'`, `source_meeting_id = NULL` (the
   honest value; the 0017 dedupe index is partial on non-null).
4. **Two pre-filled extraction stages**, exactly the shape `createRun` writes
   (`pipeline.controller.ts:215`):
   - `delivery/prd_extract` `status='done'`, `artifact_ref` = a requirement doc **rendered from the
     discovery answers** (objective, audience, features, pages, integrations),
   - `scope/scope_extract` `status='done'`, `artifact_ref` = a scope note rendered from the answers
     (in-scope, out-of-scope, dependencies — the workbook's own Scope section maps 1:1).
   No `report` track: there is no meeting to minute.
5. **Open the delivery-track client `prd_sign` gate** — an ordinary `pipeline_gates` row,
   `actor_side='client'`. Triage already served as the internal review beat, exactly as MI-02 §2.1
   argues for its own case.
6. **UPDATE the lead** — `status='converted'`, the three FK columns, `triaged_by/_at`.
7. **`emitEvent('pipeline_run', runId, 'pipeline.run.created', …)`** in the same transaction. **This
   is the load-bearing line for zero-special-casing**: the shipped `pipeline-fanout` n8n workflow
   triggers on exactly this event (`automation/workflows/pipeline-fanout.json:11`) and opens the
   client `scope_signoff` gate and PM notify by itself. Also emit `agency.lead.converted`.
8. After commit: `notifyBestEffort` to the AM and the new client contact, and
   `writeActivity('converted', 'agency_lead', …)`.

**The hard build gate holds by construction.** It requires PRD-signed AND scope-dual-signed, and
the converted run satisfies it the same way every run does — by real client signatures, never by
pre-seeded gate rows, which would forge what a client signed.

### 4.3 Delegation (AD-6) — the part that makes it operable rather than a record

Conversion is where work gets handed to people, so delegation is part of the same transaction, not
a follow-up screen someone forgets.

The convert request carries an optional `delegations: [{ role, assigneeId, dueAt }]`. For each, a
`pm_tasks` row under the new project, created **through the PM module's task-creation service as an
in-process call** (PM tables are plain-tenant-wall, so the core transaction reaches them — the same
route MI-02 §2.3 uses for its `pm_task` route). Defaults, offered in the triage drawer and
overridable:

| Task seeded | Default assignee | Sourced from |
|---|---|---|
| Review discovery answers & flag contradictions | the AM (lead owner) | always |
| Produce sitemap from stated pages | PM | `answers.pages_required` |
| Confirm integrations & API access | tech lead | `answers.integrations` non-empty |
| Chase missing content owners | AM | `answers.asset_inventory` has any "Does not exist" |
| Confirm domain/DNS control | tech lead | `answers.dns_owner` |

That last one exists because the form asks it and because DNS control blocks launch more often than
anything else. The point of seeding from answers is that the *client's own words* generate the work,
which is the whole argument for capturing them structurally.

**Assignee validation is not optional:** each `assigneeId` goes through the same staff-membership
check as `assertOwnerIsStaff`. A body-supplied user id that is not staff in this tenant is a
`BadRequest`, never a silent skip.

---

## §5 · Authorization

### 5.1 The prospect side rides a token guard, and **no Cerbos derived role at all**

The prospect is not a principal. They have no `users` row, no membership, no derived role. Inventing
one would be the single most dangerous thing this feature could do — `0072:32` records that the
`client` derived role satisfies exactly one policy file, and that invariant is easy to destroy
silently.

**So the prospect path does not call `authorize()`.** Its authorization is the token: valid, unused,
unexpired, unrevoked, and bound to the lead being written. That check lives in one place —
`IntakeTokenGuard` — and the controller is otherwise ordinary.

This is a real widening of the threat surface and it is worth being explicit about what bounds it:

- The guard resolves `tenantId` and `leadId` **from the token row**, never from the body or the
  host. `0075`'s "rule 1" applied to a caller who is not even a user.
- The token authorizes **exactly two operations**: read the questionnaire definition, and submit
  once against its own lead. There is no read of any other lead, no list, no update.
- Everything else about the row is server-derived: `tenant_id`, `lead_id`, `source`, `status`,
  `origin_site`, `created_at`.

### 5.2 New Cerbos resource kinds (staff-only — the `client` role appears in neither)

Two new policy files, both following the shape of `resource_agency_brief.yaml` including the
IAM-04-ROLLOUT-B12 permission-matching arm:

```
resource_agency_lead.yaml         actions: read, create, update, triage, convert, delete
resource_agency_discovery_submission.yaml   actions: read, delete
```

- `triage` and `convert` are **separate actions**, not `update`. Converting mints a client and a
  project; that is a different act from editing a phone number, and an AM who may do the second
  should not automatically do the first.
- The submission has **no `update`** — it is `INSERT`-only by design (§3.2). Omitting the action is
  how that becomes an authorization fact rather than a convention.
- Each new action needs its `perm_agency_lead_<action>` entry in `rbac/permission-catalog.json` and
  a group in `permission-groups.json`, or the dual-match test (`cerbos-permission-dual-match.test.ts`)
  will fail — correctly.

### 5.3 Operational trap — **Cerbos does not hot-reload here**

Adding the policy files is not enough. Restart the Cerbos container, then **prove the new decision
with a probe**. CLAUDE.md records that a *healthy* Cerbos container has served two-day-stale policy.
Health is not currency.

---

## §6 · Idempotency

Criterion 3 of the agentic-native bar, and the place MI-02's DEF-2 lesson applies hardest.

### 6.1 Submit — the token is the dedupe key

A prospect double-clicking Submit, or a network retry replaying the POST, must not create two
submissions. The token is single-submission, so:

```
withTenants([tenantId], async (c) => {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_INTAKE_LOCK_NS, tokenId]);
  // Re-read used_at UNDER the lock. THIS line is the fix, not the lock.
  //   -> already used  => 200 with the existing submission id (a retry is not an error)
  //   -> revoked/expired => 403 typed refusal
  // insert submission, stamp token.used_at, flip lead to 'submitted', emitEvent — one transaction
});
```

Returning **200 with the existing id** rather than 409 is deliberate here and differs from the
convert path: the prospect is not an operator who can interpret a conflict, and a retry after a
dropped response is the overwhelmingly likely cause. The operator-facing convert path below does the
opposite, for the opposite reason.

`AGENCY_INTAKE_LOCK_NS = 0x41490001` ('AI'+1) — a new namespace, not `PIPELINE_RUN_LOCK_NS`
(0x50520001). The resource being serialized is the token; no run id exists yet to lock on.

### 6.2 Convert — lock, re-check, act

The double-trigger surface: two AMs convert the same lead concurrently; an agent retries; a PM
double-clicks. **A lock alone does nothing** — the DEF-2 finding (`pipeline-lock.ts:17–25`): both
racers take it in turn and both insert, each on a stale snapshot.

```
withTenants([tenantId], async (c) => {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_LEAD_LOCK_NS, leadId]);
  // Re-read status, converted_client_id, pipeline_run_id UNDER the lock and re-check:
  //   require status IN ('submitted','in_review','nurturing').
  //   Loser sees status='converted' and returns 409 { existing: {clientId, projectId, runId} }
  //   -- mirroring existingStageForRepeatedCreate (pipeline.controller.ts:89-124), because a
  //   second convert is a stale retrigger, never an intent.
  // spawn client+project+run+stages+gate+tasks, UPDATE lead -- same transaction
});
```

Lock scope is **the lead id**, not the tenant (the `pipeline-lock.ts:32` lesson — a tenant-wide lock
would serialize every triage in a one-agency deployment) and not narrower: the lead is the unit two
deciders can disagree about. No second lock is taken on the freshly-minted run id, so there is no
lock-ordering deadlock question — the same reasoning `createRun` documents at
`pipeline.controller.ts:208`.

**Schema backstop:** `ux_lead_client` and `ux_lead_run` (§3.3) mean a second client or run can never
be *linked* even by a future hand-written path. That is the 0052 philosophy — make the duplicate
physically impossible, not merely unlikely.

---

## §7 · PII, retention, and the honest bit about what this table holds

- **`scrubText()` on every free-text answer before persist**, per the program-wide "scrub
  PAN/national-IDs before persist" rule. The `redactions` count is stored on the row so a reviewer
  can see that scrubbing happened rather than assuming it.
- A discovery submission holds **business** information (strategy, budget, competitors) and a small
  amount of **personal** information (contact name, email, phone). It is commercially sensitive
  rather than special-category, but the budget field alone makes it something no client should ever
  see for another client — which is what the tenant wall and the absent `client` derived role are
  for.
- **Retention has no default and that is a gap, not an omission.** A declined lead's submission
  currently lives forever. AD-10 (§8) proposes purge-after-N-months with the tenant setting it.
  Flagged rather than silently inherited.
- The prospect is not a platform user, so there is no self-service export or erasure path. If the
  group's privacy posture requires one, it is a ticket, and this document is where the absence is
  recorded.

---

## §8 · Agentic-native compliance (`2026-08-03-agentic-native-erp-plan.md`)

Read before writing this design, as CLAUDE.md requires. The bar applies **per capability**, so the
three capabilities here are assessed separately.

| # | Criterion | `intake.submit` | `lead.triage` | `lead.convert` |
|---|---|---|---|---|
| 1 | Tool parity | n/a — a prospect is not an agent; deliberately **not** tool-exposed | `agency_intake.triage` | `agency_intake.convert` |
| 2 | Deterministic contract | structured JSON in/out; typed refusals (`token_expired`, `token_used`, `token_revoked`) | typed | typed |
| 3 | Idempotent writes | token single-use + `ux_sub_token` (§6.1) | status re-check | lock + re-check + `ux_lead_client` (§6.2) |
| 4 | Impact-classified | **low** — writes a lead-scoped row, mints nothing | **low** | **medium → D14 approval.** Mints a client, a project and a run. |
| 5 | Explicit refusal | typed reason, never an empty 200 | Cerbos reason surfaced | Cerbos reason surfaced |
| 6 | Observable | `writeActivity` with **`actor = NULL`** + `{ leadId, tokenId, actorKind: 'prospect' }` in metadata | actor = staff | actor = staff |
| 7 | Golden case | AD-8 drives the real endpoint end to end | AD-8 | AD-8 |

**Two things this design must declare rather than quietly assume:**

**(a) Criterion 6 and the non-human actor.** A prospect has no `users` row, so `writeActivity` gets
`actor = NULL` and the truth lives in metadata. The plan anticipates non-human actors ("the actor
may be non-human") but the estate's answer — `users.kind` — is item 2 of the cross-cutting list and
has **not shipped**. This is therefore the first actor in the estate that is deliberately not a
user, and it should be named in the `users.kind` work rather than discovered by it. **AD-1 does not
attempt to solve `users.kind`**; it records the dependency.

**(b) Criterion 4 depends on a known-broken path.** The plan's highest-leverage open item is *"Fix
the D14 resume path. Approving a suspended write currently executes nothing."* `lead.convert` is
medium-impact and therefore gated — which means **on today's estate, an agent-initiated convert
would suspend and never execute.** That is not a defect this feature introduces or can fix. The
consequence, stated plainly: **convert is a human-driven capability until D14 resume lands.** The
tool ships and is authorized correctly; it simply cannot complete unattended, and AD-8's golden case
must assert the suspension rather than pretend it completed.

---

## §9 · Surfaces

### 9.1 Prospect (unauthenticated, token-guarded)

Not in `platform-ui`'s authenticated app. The existing standalone form is the artifact — it already
carries the 122 questions, stable ids, autosave and validation. Three changes:

1. Read the token from the URL **fragment**, replay it as `X-Intake-Token` (§2.2).
2. `GET /intake/questionnaire` on load, so the question set comes from the platform and a
   redeployed form cannot drift from the stored `schema_version`.
3. Post to `POST /intake/submissions`.

Hosting is a deployment question, not a platform one, and it is genuinely constrained: the
Delphi/Helios CSP hardcodes `font-src 'self'` and `connect-src 'self'` with no per-host knob
(`gaiada-setups/runbooks/csp-per-host-allowances.md`), so wherever it lands it needs self-hosted
fonts and a same-origin path proxied to the platform.

### 9.2 Staff (`platform-ui`)

| Route | Purpose |
|---|---|
| `/agency/leads` | the queue — `submitted` first, then `invited`, with age |
| `/agency/leads/[id]` | the submission rendered readably, section by section, plus triage actions |
| `/agency/leads/[id]/compare` | when `supersedes_id` is set: what changed between submissions |

The detail view must render **all 122 answers**, grouped by the form's own sections, with unanswered
optional fields visibly absent rather than blank. A reviewer's first question is always "what did
they *not* tell us".

Each new BFF route needs its § in `docs/FRONTEND-BFF-CONTRACT.md` in the same change. A stale row
there has caused real defects.

### 9.3 Realtime

`agency.lead.submitted` maps to a new portal topic only if the *client* portal should ever show it.
It should not — a prospect has no portal. **No `TOPIC_BY_EVENT` entry**, per that file's allowlist
principle: adding an internal event to the backbone must never, by default, wake a client's browser.
Staff-side liveness rides the existing staff notification path.

---

## §10 · Tickets

| id | Ticket | Depends on | Notes |
|---|---|---|---|
| **AD-1** | Migration: three tables, RLS, composite FKs, partial uniques | — | §3.3 verbatim; take the UTC stamp at write time |
| **AD-2** | `IntakeTokenGuard` + mint/revoke service | AD-1 | hash-only storage, constant-time compare |
| **AD-3** | Prospect controller: `GET /intake/questionnaire`, `POST /intake/submissions` | AD-2 | §6.1 idempotency; scrub on persist |
| **AD-4** | Staff reads: queue + detail | AD-1 | Cerbos `read`; explicit refusal, never `[]` |
| **AD-5** | Triage: decline / nurture | AD-4 | typed reasons, event-emitting |
| **AD-6** | Convert spawner + delegation | AD-5 | §4.2 + §4.3, one transaction, §6.2 lock idiom |
| **AD-7** | Cerbos policies + permission catalog + groups | AD-1 | restart + probe (§5.3) |
| **AD-8** | MCP tools `agency_intake.*` + the golden case | AD-6, AD-7 | must assert D14 suspension, §8(b) |
| **AD-9** | `kind='open'` — Turnstile, per-IP limit, quarantine state | AD-3 | deferred by §2.1 |
| **AD-10** | Retention policy for declined leads | AD-1 | flagged in §7 |
| **AD-11** | UI routes + BFF contract § | AD-4, AD-6 | §9.2 |

AD-1 → AD-8 is the coherent first cut. AD-9 through AD-11 are named so they are not lost.

---

## §11 · Open questions for the owner (each with a default that holds if unanswered)

1. **Open (cold inbound) intake — wanted at all?** *Default: no, invite-only.* If the marketing site
   needs a "start your project" form for anonymous traffic, AD-9 becomes v1 scope and needs a bot
   defence decision (Turnstile is the obvious fit; it is already a familiar dependency).
2. **Does conversion create the project, or only the client?** *Default: both, plus the run (§4.2).*
   The alternative — client only, project later by hand — is defensible if projects carry commercial
   terms that are not settled at conversion.
3. **Who owns a lead by default?** *Default: the staff member who minted the invite.* Round-robin
   across the AM pool is the alternative and needs an AM-pool concept that does not exist.
4. **Invite expiry.** *Default: 30 days*, re-mintable without losing the lead.
5. **Retention for declined leads.** *Default: keep indefinitely* — flagged as a gap in §7, not a
   recommendation. A tenant-level purge window is the likely answer.
6. **Should the questionnaire be per-vertical?** *Default: one set, `schema_version` pinned per
   submission.* The column is already there; the branching is not, and a hotel and a clinic plausibly
   need different questions.

---

## §12 · Traps audit for this feature

Walked against CLAUDE.md's program-wide list and MI-02 §6.

| Trap | Applies? | Handling |
|---|---|---|
| Shared checkout, concurrent sessions | **yes** | migration stamp taken at write time, not from this doc |
| Generated files from a clean worktree | **yes** | `docs/MAP.md` regenerated via `git worktree add --detach`, never from this checkout |
| Changelog consolidation by a subagent | **yes** | entries written by hand, next free version, `git diff --numstat` **and** heading-uniqueness check |
| Third wall silently returning zero rows | **yes** | avoided by §3.1 — no module wall on these tables |
| NULL defeats UNIQUE | **yes** | every backstop is a partial unique over the non-null set |
| Cerbos stale policy | **yes** | §5.3 restart + probe |
| `.env` var not in the compose `environment:` block | **yes** | any token pepper/TTL must be added in both places |
| A missing field reads exactly like NULL | **yes** | `answers` is JSONB; readers must distinguish "key absent" from "answered empty" — the UI depends on it (§9.2) |
| Frontend-first drift | **yes** | the prospect form must read its question set from `GET /intake/questionnaire`, not carry its own copy (§9.1) |
| Reader folds 403/404 into `[]` | **yes** | criterion 5; the queue must say "you cannot see this" rather than render empty |
| D14 resume path broken | **yes** | §8(b) — convert is human-driven until it lands |

---

## §13 · What this does not claim

Nothing here is PROTOTYPED or DEV-VERIFIED. This document is **PLANNED**: it has been checked
against the code it cites, and every file, line reference and precedent in it was read on
2026-09-05 rather than recalled. The schema has not been applied, no endpoint exists, and no test
has driven any of it.
