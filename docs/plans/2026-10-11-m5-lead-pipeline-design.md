# M5-P1: the lead pipeline on `agency_leads` (design)

**Status:** PLANNED. This is a design; nothing in it is built. **Date:** 2026-10-11. **Ruling:** WSK-D69 (owner, 2026-10-11) in
[`webdesk-design-v2.md`](../blueprints/webdesk-design-v2.md) §14. **Plan row:** M5-P1 in [`2026-10-11-webdesk-m5-plan.md`](./2026-10-11-webdesk-m5-plan.md).
**Builds on:** M5-L4 (`m5/leads` @ `2b98157f`, migration `202610111330_agency_leads_web_source.sql`), which adds source `web`, `submission_ref uuid`,
`origin_form`, `attribution jsonb` and `visitor_consent jsonb`, the partial unique `(tenant_id, submission_ref)`, and the tool `agency_intake.createFromWebSubmission`.
**Read for this design:** `202609050857_agency_discovery_intake.sql` and `202609051010_iam_…` (the only other migrations on agency tables), the AD-1 design
(`docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md`), `core/agency-leads.*`, `agency-lead-convert.*`, `agency-intake-portal.controller.ts`,
`core-tools.ts`, `approval-executables.ts`, `cerbos/policies/resource_agency_lead.yaml`, the platform-ui leads queue and detail, the finance currency migration
(`202608241012`), `events/{outbox.service,relay,consumer.service}.ts`, `search/sem-apply.ts` + `sem-executor-google-ads.ts`, providers addendum §A12.6, the SM-21
WS4 flow in `search.controller.ts`, and `legal/website-visitor-addendum.md` §3.6 and R-V5.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Stages are **global platform data**: a reference table `agency_lead_stages`. They are not per company, and they are not a CHECK list | P2–P4, the UI and agents key on what a stage means. With a reference table, adding a stage is an INSERT, so no CHECK is ever rebuilt (no DROP+ADD trap) |
| D2 | `status` keeps its AD-1 intake meaning. `stage` is the sales position. The two meet only at the ends: **won ⇔ converted, lost ⇔ declined**, enforced by CHECKs | Two machines on one row would otherwise contradict each other (for example, declined at `proposal`) |
| D3 | **Won only through Convert. Lost only through Decline**, and Decline is widened to every open status. Open stages move only by a staff decision (or an agent acting for one), never as a side effect of something a prospect did | A stage is the signal sent to ad platforms. It must come from a person's judgement, not from a form being filled |
| D4 | `deal_value numeric(20,4)` plus `deal_currency` referencing `finance_currencies(code)` (ISO 4217). Value and currency are set together or not at all. Precision may not exceed the currency's `minor_unit`. The Cerbos action is `update` | These are the finance conventions (`202608241012`, `…1015`, `…1019`) |
| D5 | `agency_lead_stage_events` is append-only (enforced by a trigger), holds **no personal data**, and keeps one row per stage change | M5-G5's erasure scrubs lead fields. An append-only table must never hold anything that erasure has to change |
| D6 | One writer, `transitionStage()`, changes `stage`. It writes the history row and emits `agency.lead.stage_changed` v1 in the same transaction | Every change is then an event, and nothing can drift between the history and the bus |
| D7 | **No new Cerbos kind and no new action.** Moving a stage = `triage`. Value = `update`. Won = `convert`. Lost = `triage` (decline) | No policy rule changes, no new permission rows, no bundle regeneration, no pinned-count churn, no Cerbos restart. The only IAM migration rewrites two descriptions. Section 6 covers the tier question |
| D8 | P2 consumes the event in `search`. It uploads only when the lead's snapshot says `visitor_consent.marketing === true`, de-duplicates on `submission_ref`, and files one WS4 approval per upload. That approval executes in-band at decide(), under its own simulate\|live switch | Section 8 |

## 2. Stages, and how they relate to `status`

| key | kind | Meaning | How a lead gets there |
|---|---|---|---|
| `enquiry` | open | The lead exists and nobody has spoken to them yet | The column default, on every insert (staff, invite, web) |
| `contacted` | open | We reached the person: a first call happened, or they replied | `moveStage` |
| `qualified` | open | Fit, need and budget are confirmed, and it is worth a proposal | `moveStage` |
| `proposal` | open | A proposal or quote has been sent | `moveStage` |
| `won` | won | The client agreed, and the ERP client, project and run have been created | **Convert only** |
| `lost` | lost | No deal, whichever side ended it. The reason sits on the lead (`declined_reason`) | **Decline only** |

- **In the pipeline:** every lead that is not deleted. The open statuses `new`, `invited`, `submitted`, `in_review` and `nurturing` may sit at any open stage.
  `nurturing` means "in the pipeline, parked": it shows as parked and can still be moved. `converted` requires `won` and `declined` requires `lost`, by CHECK.
- **Transitions:**
  - `moveStage` goes from any open stage to any other open stage, forwards or backwards, because deals do regress. Moving a lead to the stage it is already at returns 200 `changed:false` and writes nothing, which makes retries safe for agents. Asking for `won` or `lost` gives 400 `stage_terminal`. Moving a converted or declined lead gives 409 `lead_closed`.
  - **Convert** keeps its preconditions (status `submitted`, `in_review` or `nurturing`, under the lead lock), sets `won` in the same UPDATE, and gains an optional `deal`.
  - **Decline** (an AD-5 amendment) now works from `new`, `invited`, `submitted`, `in_review` and `nurturing`. A web lead is often lost before AD-1 is ever sent. Decline sets `lost` and revokes any unused invite tokens in the same transaction.
- **Intake submit** (`agency-intake-portal.controller.ts`): the guard becomes `status NOT IN ('converted','declined')`. Today it re-opens a declined lead as `submitted`. That contradicts AD-1 §4.1 ("declined [terminal]"), and under D2 it would break the CHECK and turn the prospect's submit into a 500. A late submission is still stored as evidence, the prospect still gets 200, the lead is left unchanged, and its owner is notified (`agency.lead.submitted_after_decline`). There is no reopen in v1: a returning prospect becomes a new lead, and web leads already arrive as one row per submission.
- **History starts at the first move.** A lead's entry into `enquiry` is its `created_at`. The backfill writes no history rows and emits no events.

## 3. Deal value and currency

- Stored as `numeric(20,4)`, `>= 0`. The currency is a 3-letter code that must exist in `finance_currencies`. That table is global reference data with no RLS, and every database has it, because migrations run in full.
- **The value is exact at the currency's minor unit:** `value × 10^minor_unit` must be an integer. So IDR (0) refuses `1500.5`, and USD (2) accepts `10.25` and refuses `10.255`. The API accepts a decimal string (preferred) or a finite JSON number, matched by `^\d{1,16}(\.\d{1,4})?$`. It always returns `dealValue` as Postgres's decimal **string**, and callers never do float arithmetic on it.
- **No hard-wired default currency** (the "internal now, SaaS later" ruling). Every value carries its code. The UI pre-selects the code most recently used on this tenant's leads.
- **Who:** anyone holding `update` on `agency_lead` (company_admin, manager, member). Value may also ride on `moveStage` and `convert` as `deal: {value, currency}`, and then the controller **also** authorizes `update`. Editing a value is allowed in any status. It emits no stage event, and P2 does no conversion-value restatement in v1. The edit is audited by `writeActivity`.

## 4. Schema: `<UTC stamp at write time>_agency_lead_pipeline.sql`, sorting after `202610111330` (P1-d's wording-only IAM migration is a separate file)

```sql
-- 1. Vocabulary: GLOBAL, no tenant_id and no RLS (the finance_currencies precedent). Create and seed it BEFORE the FK column below.
CREATE TABLE agency_lead_stages (key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{1,31}$'), position smallint NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('open','won','lost')), label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ux_agency_lead_stages_terminal ON agency_lead_stages (kind) WHERE kind <> 'open';   -- exactly one won, one lost
INSERT INTO agency_lead_stages (key, position, kind, label) VALUES ('enquiry',10,'open','Enquiry'), ('contacted',20,'open','Contacted'),
  ('qualified',30,'open','Qualified'), ('proposal',40,'open','Proposal sent'), ('won',90,'won','Won'), ('lost',99,'lost','Lost');
-- 2. A constant DEFAULT fills existing rows as DDL. There is no UPDATE here, so RLS is not involved.
ALTER TABLE agency_leads ADD COLUMN stage text NOT NULL DEFAULT 'enquiry' REFERENCES agency_lead_stages(key),
  ADD COLUMN deal_value numeric(20,4), ADD COLUMN deal_currency text REFERENCES finance_currencies(code);
-- 3. Terminal backfill, PER TENANT with the GUC set first (the 0051/0086 pattern; lint:migration-rls checks it).
DO $$ DECLARE co record; BEGIN FOR co IN SELECT id FROM companies LOOP
  PERFORM set_config('app.current_tenant_ids', co.id::text, true);
  UPDATE agency_leads SET stage = 'won'  WHERE tenant_id = co.id AND status = 'converted';
  UPDATE agency_leads SET stage = 'lost' WHERE tenant_id = co.id AND status = 'declined';
END LOOP; END $$;
-- 4. NEW named constraints, ADD only. No existing CHECK (status, source) is dropped or re-declared. Their validation scans
--    every row regardless of RLS, so a backfill that silently matched zero rows fails HERE, loudly, instead of shipping.
ALTER TABLE agency_leads ADD CONSTRAINT lead_won_iff_converted CHECK ((stage = 'won') = (status = 'converted')),
  ADD CONSTRAINT lead_lost_iff_declined CHECK ((stage = 'lost') = (status = 'declined')),
  ADD CONSTRAINT lead_deal_pair CHECK ((deal_value IS NULL) = (deal_currency IS NULL)),
  ADD CONSTRAINT lead_deal_nonneg CHECK (deal_value IS NULL OR deal_value >= 0);
CREATE INDEX ix_lead_stage ON agency_leads (tenant_id, stage) WHERE deleted_at IS NULL;
-- 5. Append-only history. No free text and no personal data. A lost reason stays on the lead, where G5 can scrub it.
CREATE TABLE agency_lead_stage_events (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES companies(id), lead_id uuid NOT NULL,
  from_stage text NOT NULL REFERENCES agency_lead_stages(key), to_stage text NOT NULL REFERENCES agency_lead_stages(key),
  deal_value numeric(20,4), deal_currency text REFERENCES finance_currencies(code), actor_id uuid REFERENCES users(id),
  via_agent text CHECK (via_agent IS NULL OR length(via_agent) <= 64),   -- currentVia()?.agent: "Alice's agent", not just "Alice"
  occurred_at timestamptz NOT NULL DEFAULT now(), origin_site text NOT NULL,
  CONSTRAINT fk_stage_event_lead_tenant FOREIGN KEY (lead_id, tenant_id) REFERENCES agency_leads (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT stage_event_moves CHECK (from_stage <> to_stage), CONSTRAINT stage_event_deal_pair CHECK ((deal_value IS NULL) = (deal_currency IS NULL)));
CREATE INDEX ix_stage_event_lead ON agency_lead_stage_events (tenant_id, lead_id, occurred_at DESC);
-- Triggers (the 0087 idiom): BEFORE UPDATE always raises. BEFORE DELETE raises unless current_setting('app.lead_purge', true) = 'on',
-- which only G5's retention purge sets (SET LOCAL). Its hard delete of a lead then cascades the history away; any other delete is refused.
-- RLS: ENABLE + FORCE, with the NULLIF-hardened plain tenant_isolation block copied from 202609050857. NO app_module_allowed: same doctrine as agency_leads.
-- COMMENT ON TABLE agency_leads (the text below), COMMENT ON COLUMN stage/status/deal_*, COMMENT ON TABLE agency_lead_stage_events.
-- Self-assert: exactly one won and one lost row in agency_lead_stages, and the four constraints exist (pg_constraint has no RLS).
```

**The rewritten header note.** Migrations are immutable, so it goes into this migration's header **and** into `COMMENT ON TABLE agency_leads`:

> agency_leads: the agency's lead record and its small sales pipeline (WSK-D69, owner, 2026-10-11). It began as the minimum record of the AD-1 discovery intake.
> That design said "NOT a CRM … if the group later wants sales-pipeline management it should own this table rather than this feature growing into it." D69 is
> that adoption: the M5 lead pipeline owns this table now. It has two state machines, kept apart on purpose. `status` is the intake lifecycle (new, invited,
> submitted, in_review, nurturing, converted, declined) and keeps its AD-1 meaning. `stage` is the sales position, from `agency_lead_stages`. They meet only at the
> ends: won ⇔ converted, lost ⇔ declined. Every stage change appends one row to `agency_lead_stage_events` and emits `agency.lead.stage_changed` (ids, stages,
> value; no personal data). It is a pipeline, not a general CRM: no forecasting, no probability weighting, no account hierarchy, no activity feed of its own.
> The contact fields, attribution and consent snapshot here are personal data. Erasure (M5-G5) scrubs those fields, and never edits the append-only history,
> which holds none. Plain tenant wall, deliberately not module-walled (AD-1 §3.1).

## 5. The writer and the event

`transitionStage(c, {tenantId, leadId, to, deal?, actorId, extraSet?})` in `core/agency-lead-pipeline.service.ts` is the **only** code that writes
`agency_leads.stage`. It runs these steps in this order, inside the caller's `withTenants([tenantId])` transaction, with no `{modules}` option:

1. `SELECT stage, status FROM agency_leads WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`. The `from_stage` is this locked value and never an earlier, unlocked read. Convert takes its advisory lock first and then this row lock. `moveStage`, the deal write and decline take only the row lock, so the locks cannot form a cycle.
2. **One** UPDATE sets `stage` together with `extraSet` (convert: `status`, the `converted_*` columns and `triaged_*`; decline: `status`, `declined_reason` and `triaged_*`) and `deal` when one is given. Both CHECKs therefore see both columns at once. Two UPDATEs would fail the CHECK.
3. `INSERT agency_lead_stage_events`. The value is the post-update value. `actor_id` and `via_agent` come from the principal and from `currentVia()`.
4. `emitEvent(c, tenantId, 'agency_lead', leadId, 'agency.lead.stage_changed', payload)`. That goes to the stream `events:agency_lead`. The existing `agency.lead.converted` and `.declined` events still fire. **Payload v1** (exact key set, pinned by a test):

```jsonc
{ "v": 1, "leadId": "uuid", "stageEventId": "uuid",          // the history row id: a consumer's idempotency key
  "submissionRef": "uuid | null",                              // WebDesk submission id for source 'web', otherwise null (P2 skips at once)
  "fromStage": "qualified", "toStage": "proposal",
  "dealValue": "15000000.0000 | null", "dealCurrency": "IDR | null", "occurredAt": "2026-10-11T09:00:00.000Z" }
```

No names, emails, phones, org name, attribution, consent or reason ever appear in the payload. Consumers fetch the lead. P1 also removes `reason` from
`agency.lead.declined` and `orgName` from the staff path's `agency.lead.created` (grep finds no consumer of either). `stage_changed` gets **no** `TOPIC_BY_EVENT` entry (AD-1 §9.3) and must **not**
be added to the n8n bridge's allow-list. The value is commercially sensitive.

## 6. Authorization, BFF routes and MCP tools

| Capability | Route (all new routes in `agency-leads.controller.ts`) | Cerbos on `agency_lead` | MCP tool | Impact |
|---|---|---|---|---|
| Move to an open stage | `POST /api/:t/agency/leads/:leadId/stage` `{stage, deal?}` → `{id, stage, changed, stageEventId?}` | `triage` (also `update` when `deal` is sent) | `agency_pipeline.moveStage` | low |
| Set or clear the value | `POST /api/:t/agency/leads/:leadId/deal` `{value, currency}` or `{value:null, currency:null}` | `update` | `agency_pipeline.setDealValue` | low |
| Stage history | `GET /api/:t/agency/leads/:leadId/stage-history` (newest first; 404 when the lead is invisible) | `read` (with `id`) | `agency_pipeline.stageHistory` | read |
| Reference lists | `GET /api/:t/agency/pipeline/reference` → `{stages:[{key,position,kind,label}], currencies:[{code,symbol,minorUnit}]}` | `read` | `agency_pipeline.reference` | read |
| Won | the existing `POST …/convert`, plus an optional `deal` (additive) | `convert` (also `update` when `deal` is sent) | `agency_intake.convert` (gains `deal` in its schema) | medium, unchanged |
| Lost | the existing `POST …/decline`, now from every open status | `triage` | `agency_intake.decline` | low, unchanged |
| Queue and detail | the existing GETs gain `stage`, `dealValue`, `dealCurrency` and `stageEnteredAt` (the latest history `occurred_at`; else `triaged_at` for won/lost; else `created_at`) | `read` | `listLeads`, `getLead` | read |

- **Who may do what.** A viewer reads. A member also sets the value. A manager also moves stages and declines. A company_admin or owner also converts. platform_admin may do everything. This leaves the AD-7
  tiers untouched. The only Cerbos/IAM work is wording: the catalog JSON plus a migration that rewrites the descriptions of `agency.lead.triage` (it now "moves pipeline stages, which can
  start a WS4-gated ad upload") and `agency.lead.update` (now "deal value"). Admins choose who to grant from those descriptions. The YAML header changes in a comment only.
  The decisions do not change, so no Cerbos restart is needed.
- Every new route authorizes **before** it validates. Denial tests send valid bodies, including a valid `deal`. Typed `reason` codes: `stage_unknown`, `stage_terminal`,
  `lead_closed`, `deal_incomplete`, `deal_value_invalid`, `deal_currency_unknown`, `deal_value_precision`. Moving a stage is **low** impact because it cannot send anything itself.
  Its only external effect, a P2 upload, needs its own WS4 approval (filing a request is low impact; IAM's precedent in `core-tools.ts`). Low tools need no executor entry.
- **UI** (platform-ui). Queue: `Stage` and `Value` columns, stage filter chips with counts, and a "hide closed" toggle. These **filter and never re-sort** (BFF contract rule 1).
  Detail: a stage chip beside the status chip, and a new **Pipeline** card under the summary. It shows a stepper of the open stages, with move buttons when `canTriage`; value and currency, editable when `canWrite`;
  "Won = Convert / Lost = Decline" pointers to those cards; and the history, as from → to, value, who and when, plus "via agent X" when an agent drove it. The card keeps an empty slot that P2 fills with
  "Ad platform uploads". ConvertCard gains optional value and currency. Decline is offered for every open status. Currencies and minor units come from `reference`.
  `stage` reuses `agency.lead.triage` and value reuses `agency.lead.write`; no new UI capability is added.

## 7. What P1 hands to P2–P4 (exports from `core/agency-lead-pipeline.service.ts`)

```ts
export const STAGE_CHANGED = "agency.lead.stage_changed";
export interface StageChangedV1 { v: 1; leadId: string; stageEventId: string; submissionRef: string | null; fromStage: string; toStage: string;
  dealValue: string | null; dealCurrency: string | null; occurredAt: string }
export function parseStageChangedV1(payload: unknown): StageChangedV1 | null;   // consumers validate the shape; they never trust it
export function marketingConsentState(snapshot: unknown): "given" | "not_given" | "unknown";  // "given" iff a plain object whose marketing === true
export function readLeadConversionFacts(c: PoolClient, tenantId: string, leadId: string): Promise<LeadConversionFacts | null>;
// LeadConversionFacts = { leadId, source, status, stage, deletedAt, submissionRef, originForm, webSiteSlug, attribution, visitorConsent,
//   contactEmail, contactPhone, dealValue, dealCurrency }. Contact fields are only for hashing in memory; they are never logged or persisted.
```

## 8. P2 interface sketch (the `search` module; P3 Meta CAPI and P4 LinkedIn CAPI have the same shape)

1. **Wiring.** `searchModule.eventHandlers["agency.lead.stage_changed"]`. **P2 also adds `"agency_lead"` to `startConsumerLoop([...])` in `main.ts`.** Without it, the handler is registered and never invoked (the SMM-14 trap). Module handlers run only when `search` is enabled for the tenant; events that arrive while it is disabled are acknowledged and never replayed.
2. **Skip without a read** when `submissionRef === null`. Otherwise run `readLeadConversionFacts`. That read and P2's module-walled ledger share one `withTenants(..., {modules:['search']})`; agency tables ignore the scope.
3. **Target.** Look up (tenant, `webSiteSlug` → `search_properties` row, `toStage`) in a per-platform configuration owned by P2. It holds the conversion action or event name and whether to send the value. No target means skip.
4. **The gate** runs when planning and again under the lock when executing. The lead exists and is not deleted. `marketingConsentState(visitorConsent) === 'given'` (strictly `marketing === true`: an absent, malformed or `"true"` value means no upload). The lead is not on G5's suppression list for the `ad_upload` scope. The platform has a usable identifier: Google needs `gclid`, `gbraid` or `wbraid` from `attribution`, or an email or phone for enhanced conversions for leads; Meta needs `em`, `ph`, `fbc` or `fbp`; LinkedIn needs an email or `li_fat_id`.
5. **De-duplication by submission ref.** Insert into `search_conversion_uploads` under `UNIQUE (tenant_id, platform, submission_ref, conversion_key) WHERE status <> 'skipped'`. Inserting that row **is** the claim. A lead that regresses and advances again never uploads twice. The platform's own de-dupe id is `${submissionRef}:${conversionKey}`, except for the platform's own Lead event, which uses the bare submission id: that is the event id the browser Pixel already sent, so the browser copy and the server copy merge. The ledger stores ids, stage, value, currency and status only. It never stores hashes, a gclid or contact data, and none of these go into `tool_args`.
6. **WS4.** One `automation_approvals` row per claimed upload, impact `high`, content-bound by hashing the ids, platform, conversion key, value and currency. The origin is `search` with `workflow_id='search.conversions.upload'`, and the row **executes in-band at decide()**, as the decider, which is the WSK-66, GH-12 and IAM shape. That way a human is present when personal data leaves. It costs two things: widening the origin CHECK with the catalog-read idiom of `202610101500` (never a hard-coded DROP+ADD), and adding `search` to the inbox's origin taxonomy. Set `neverAutoRetry`. Record the outcome before raising.
7. **Write mode** follows the §A12.6 pattern, kept separate from the campaign switch: `SEARCH_CONVERSIONS_LIVE_PLATFORMS` (default empty, meaning every platform runs in simulate; for example `google_ads`). Boot refuses to start if a listed platform has no registered live uploader. In simulate mode, the same approval path runs a simulator and records `simulated`, so the whole flow can be proven on dev. A platform stays simulated until its live uploader exists; Meta, for example, waits on O-7.
8. **Platforms, all UNVERIFIED until staging acceptance:**
   - **Google:** `UploadClickConversions` with `partial_failure`, the click id, `conversion_action`, `conversion_date_time` = `occurredAt`, the value and currency when allowed, `order_id`, `user_identifiers` (SHA-256 of a normalised email and an E.164 phone), and `consent.ad_user_data = GRANTED`. That consent value is only ever sent because the gate requires consent.
   - **Meta CAPI:** `event_id`, `action_source`, and `user_data` with `em`, `ph`, `fbc` and `fbp`.
   - **LinkedIn:** `conversionEvents` with `eventId`, and a SHA-256 email or the first-party tracking id.
   - Normalisation and hashing happen in memory, at execution only.

## 9. Tickets (order: L4 merged → P1-a ∥ P1-d → P1-b → P1-c → P1-e → P1-f)

| # | Scope (owned paths) | Tier | Model·effort | Done when (QA-executable) |
|---|---|---|---|---|
| P1-a | The §4 migration. `platform-nest/src/db/agency-lead-pipeline-schema.db.test.ts`. **Also fix the fixtures that break under the new CHECKs:** `core/agency-lead-convert-race.db.test.ts` and `core/d14-ad8-agency-intake-registry.test.ts`. In the first, line 77 inserts `declined` and line 182 sets `status='converted'`. Line 293 needs `stage='won'` as well: Postgres checks CHECKs before unique indexes, so otherwise the test's expected `ux_lead_client` error turns into a CHECK error. In the second, line 106 inserts `declined`. Every one of these must set `stage` consistently | senior-db | sonnet (seat default); DDL is given above; Opus review | `lint:migration-rls`, `lint:migration-names` and `lint:migration-immutable` are green. On the Linux gate, the migration is applied **as the NOBYPASSRLS migrator** to a DB at L4's head that holds `converted`, `declined` and `new` leads in two tenants; afterwards it reads won, lost and enquiry in **both** tenants. As `platform_app_test`, all of these hold: cross-tenant history is invisible; UPDATE and DELETE on history raise; deleting a lead with `app.lead_purge='on'` cascades its history; without the GUC the delete fails; `won` with `new` fails; a value without a currency fails; currency `XXX` fails; an unknown stage fails; the comment contains "D69"; the whole platform-nest suite is green |
| P1-b | `core/agency-lead-pipeline.service.ts` (new: `transitionStage`, move, deal, the §7 exports) and tests. Changes to `agency-leads.service.ts` (decline widened, `lost`, token revoke, payload hygiene), `agency-lead-convert.service.ts` (`won` plus deal, through `transitionStage`) and `agency-intake-portal.controller.ts` (the guard plus the late-submission notice) | senior-be | **opus·medium**: one writer threaded through convert's lock-and-recheck, decline and intake, with a race test; starting cheap would mean a full re-run | Each move writes exactly one history row and one event whose payload keys **equal** the v1 set. A same-stage move writes nothing. won and lost cannot be reached through a move. A move on a closed lead gives `lead_closed`. Convert sets `won` and emits `stage_changed` in the same transaction as the rest of convert, and the existing convert race test stays green. Decline works from every open status, sets `lost` and revokes unused tokens. A token minted before a decline and then submitted gives 200, stores the submission, leaves the lead declined/lost and notifies the owner. **Race:** on a lead in `in_review`, 20 concurrent moves plus one convert leave a contiguous chain (each `from` equals the previous `to`, and the last row is `won`). Precision: IDR `1500.5` is refused, USD `10.25` is accepted, `10.255` is refused. `declined` carries no `reason` and the staff `created` event carries no `orgName`. `marketingConsentState` holds over `true`, `false`, `"true"`, `null` and absent. The DB parts run on the Linux gate |
| P1-c | The §6 routes in `agency-leads.controller.ts` and `agency-lead-convert.controller.ts`. Four tools in `core-tools.ts` plus `core-tools.test.ts`. `mcp-hub/src/agency-pipeline-tools.test.ts`. `docs/FRONTEND-BFF-CONTRACT.md` (the Agency section. Verify, then replace, its "D14 resume is broken" paragraph, which predates convert's AD-8 executor entry). `docs/modules/CAPABILITY-INVENTORY.md`, regenerated with `UPDATE_INVENTORY=1` | medior | sonnet | `app.inject` tests show: a viewer is refused a move; a member is refused a move but may set the value; a manager may move; a company_admin may convert with a deal; every denial carries a **valid** body; 403 and 404 stay distinct; every typed reason is covered; list and detail return the new fields; history is newest first; `reference` returns six ordered stages plus active currencies. The hub test passes `moveStage`/`setDealValue` as low for a verified agent and refuses them to an n8n principal (minAssurance). The inventory test is green, and the contract § is in the same commit |
| P1-d | Wording only: `cerbos/policies/resource_agency_lead.yaml` (header comment), `src/rbac/permission-catalog.json` (two descriptions), `migrations/<stamp>_iam_agency_lead_pipeline_descriptions.sql` (UPDATE `permissions.description`; that table has no RLS; self-assert that 2 rows changed), comments in `platform-ui/src/lib/rbac.ts` | junior | haiku | The YAML diff touches only `#` lines. The catalog and parity tests are green. The migration self-asserts exactly 2 rows. The migration lints are green |
| P1-e | platform-ui: `lib/agencyLeads.ts`, `lib/agencyLeads-data.ts`, `lib/demoAgencyLeads.ts`, `app/(app)/agency/leads/actions.ts`, `…/[leadId]/page.tsx`, `components/agency/{AgencyLeadDetail,AgencyLeadsQueue}.tsx` and `agencyLeads.css`, with tests | medior | sonnet (senior-uiux review) | vitest is green: money formats by minor unit; types are copied from the SELECT aliases (`dealValue` is a string); move buttons only with `canTriage`; the value form only with `canWrite`; no direct Won/Lost button; Decline for every open status; **queue order equals input order**. `next build` is green. It has been driven against a platform-nest test container started from source, with screenshots of a move, a value and the history |
| P1-f | QA: the whole of it, end to end | qa | sonnet | On sumopod test containers from source: a web lead (flag on) goes contacted → qualified (with a value) → invite → submit → open → proposal → convert with a deal → won. A second lead is declined from `new` and goes to lost. The outbox `stage_changed` payloads have exactly the v1 keys, and **a grep of `outbox_events.payload` for the lead's email, phone and name finds zero hits**. The history chain is contiguous. Cerbos denials are proven with valid bodies, and the tools are driven through the hub. DEV-VERIFIED is claimed only for what was observed |

P2 is not broken down here. Recommended split: P2-core (the consumer, gate, ledger, WS4 in-band execution and write mode) as **senior-be · opus·high**, because it sends consent-gated personal data to third parties and a mistake there is unacceptable; then one adapter per platform as senior-be · sonnet. P2 builds after P1-b and L2, and goes live after G2 and G5.

## 10. Risks and traps

1. **RLS zero-row backfill.** CI migrates as a superuser, so it cannot see this trap. Mitigations: the per-tenant GUC loop; the new CHECKs, which validate regardless of RLS and so turn a missed backfill into a loud apply failure; and P1-a's apply as NOBYPASSRLS. On live, run the migration on a restored copy first, because an aborted apply is still a failed deploy.
2. **The CHECK DROP+ADD trap.** P1 only **adds** constraints, and stage vocabulary lives in rows. L4 already re-declared the `source` CHECK from a hard-coded list (with its own assertion). Any future widening of `status` or `source` must use the `202610101500` catalog-read idiom.
3. **Existing tests break when the CHECKs land.** These are the convert-race and d14-ad8 fixtures, named in P1-a. They run only on the Linux gate, so a green local run proves nothing.
4. **Two UPDATEs, where one sets status and a second sets stage,** violate the iff-CHECKs. `transitionStage` does both in one statement.
5. **Handler registered with no stream** (P2): the `agency_lead` stream must be in `startConsumerLoop`.
6. **Personal data on the bus:** the payload-key equality test, plus the outbox grep in QA.
7. **Validation pre-empting authz:** authorize first, and send valid denial bodies. Authorizing `update` conditionally for `deal` happens after the `triage`/`convert` check.
8. **Frontend-first drift:** UI types are transcribed from the SELECT aliases, and `dealValue` is a decimal string, never a number.
9. **Append-only versus purge:** G5 must set `app.lead_purge='on'`. Without it, a hard delete of a lead that has history fails. That is intended.
10. **Merge order:** P1 edits files that L4 changed (`agency-leads.controller.ts`, `core-tools.ts` and its test), so build on `main` after L4 merges.

## 11. Open questions for the owner (each default holds if it goes unanswered)

**ANSWERED 2026-10-13: the owner accepted every default below. Recorded as WSK-D87 (2026-10-26).**

| # | Question | Default |
|---|---|---|
| O1 | The stage list and labels: enquiry, contacted, qualified, proposal, won, lost? | As listed. Adding one later is a data row, not a CHECK rebuild |
| O2 | May account managers who hold `member` move stages? | No. It stays at triage tier (manager and up), as AD-7 ruled. Yes means widening triage's role arm, a bundle migration, and a Cerbos restart with a probe |
| O3 | Won requires Convert, and Convert requires an AD-1 submission. A web lead closed on the first call, with no AD-1, can never be won. Is that acceptable? | Keep it (D68: AD-1 follows the first call). The alternative, convert from `new`/`invited` with an empty-answers run, would be its own ticket |
| O4 | Do we send deal value to Google, Meta and LinkedIn? It is commercially sensitive | Yes, with the `won` upload only and only when it is set (value-based bidding needs it) |
| O5 | WS4 granularity for P2: one approval **per upload**, or one approval per property's upload configuration? | Per upload. That is the literal reading of D69 and matches every other external write; configuration-level approval would need a ruling |

**Flags for the orchestrator (not the owner):**
- **(a) L4 needs a REVISE before it merges.** On the event path, `origin_site` gets Zone B's box identity (`WEBDESK_ZONEB_ORIGIN_SITE`, default `'webdesk'`). On the HTTP path it gets the site slug. Every other writer stores `config.originSite`. The WebDesk site slug, which P2 needs to pick the property, is stored nowhere. The fix: add a `web_site_slug` column, and keep `origin_site = config.originSite`. If L4 has already merged, P1-a adds the column and L4's service gets a one-line fix.
- **(b) G5 needs** a suppression scope `ad_upload`, so that a marketing-only withdrawal blocks uploads without erasing anything, and its purge must set `app.lead_purge`.
- **(c) Addendum §3.6 rule 3 cannot be met for one path:** a withdrawal made through the banner after the form was submitted never reaches the ERP. Meeting it needs G6 to carry the consent id onto the submission (L2). This is an item for counsel and the owner.
- **(d) Changes to shipped behaviour:** the decline widening and the intake guard both change AD-5 and AD-3 behaviour. They are recorded here so they can go into the decision log.
