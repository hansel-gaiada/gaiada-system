# platform-nest migrations — naming protocol (LOCKED)

**Owner:** DevOps · **Established by:** WS0-1 (Backbone Program, 2026-07-17) · **Status:** NORMATIVE
**Amended 2026-08-19:** sequential numbering is CLOSED. See "The naming rule" immediately below.

This directory holds the ordered SQL migrations for `gaiada_platform`. The rules below are binding
for every ticket in the program. New migrations that violate them must not be merged, and
`npm run lint:migration-names` (CI-gated) refuses most violations mechanically rather than trusting
anyone to have read this file.

## The naming rule (read this and nothing else, if you are here to add a migration)

```
YYYYMMDDHHMM_snake_case_description.sql        # UTC.  date -u +%Y%m%d%H%M
```

That is it. There is no number to look up, nothing to reserve, and nobody to coordinate with. If a
concurrent session writes DDL in the same minute the lint fails the build and one of you adds a
minute — which is a loud collision, unlike the four silent ones below.

**The sequential `NNNN_` scheme is closed above `0118`.** The lint rejects `0120_*` and anything higher.
Legacy files keep their names forever (rule 4).

**`0119_monitoring_heartbeat_touch.sql` is the ONE grandfathered crossing.** It was written by a
concurrent session in the same window this rule landed — a legitimate migration against a rule its author
had no reason to have read yet. Renaming it would have been production-safe (it is not in the live
`schema_migrations`) but it was already applied on that session's own database, where a rename orphans the
ledger row and re-runs the file on their next boot. Breaking a colleague's working state to tidy a
filename is not a trade worth making, so it is exempted BY NAME in
`scripts/lint-migration-names.mjs` — **not** by raising the ceiling. `0120_*` still fails. If a second
name ever needs adding, the exemption has become a habit and the fix is the rule's REACH (a pre-commit
hook, a louder README), not a third entry.

### Why it changed, since a numbered scheme looks tidier

Four collisions, and the last three inside two days: `0003` and `0018` (historic, pre-protocol),
then `0114`, `0117` and `0118` — each one two concurrent sessions in this SHARED CHECKOUT both
running `ls migrations | sort | tail`, both seeing the same head, both taking the next number.

`0114` produced the rule "reserve the number by creating the file before writing DDL". `0118` then
collided *while that rule was being followed exactly*, and `0117` collided the same day. The rule
cannot work: it only helps if the other session lists the directory after your file exists, and two
sessions inside one window both list first. **The reservation is not atomic and nothing arbitrates
it.** Three data points is a protocol failing, not luck running out.

The alternatives considered were per-session number BLOCKS (a session claims `0130–0139` up front)
and a committed `CLAIMS.md` pushed before writing DDL. Both re-introduce coordination — a block can
be forgotten or overrun, and a claims file has the same race one layer up unless every session
push-rebases before every migration. A timestamp needs no coordination at all, which is the only
property that has actually survived contact with this repo.

### Why this cannot disturb already-applied migrations

The runner discovers with `readdirSync().filter(.sql).sort()` — plain lexicographic order — and the
ledger is keyed on the FULL FILENAME. `"2" > "0"`, so every 12-digit timestamp sorts after every
4-digit legacy name on every platform: no applied file moves, and no applied file is re-run. The lint
asserts that ordering property on each run rather than leaving it as a comment, because it is the one
assumption whose failure would rewrite history silently.

### What was NOT changed, deliberately

The four double-booked prefixes stay exactly as they are. Renaming an applied file orphans its ledger
row and the runner re-applies it on next boot (rule 4) — so the honest state is "the directory
contains five duplicate prefixes, all applied, all harmless because their pairs touch disjoint
tables", and the lint names them explicitly instead of pretending otherwise. The `0058`/`0059`/`0070`
gaps stay gaps: never backfill a number.

## How the runner works (read before adding a migration)

`src/db/migrate.ts` is the runner. It is invoked on every platform boot (`main.ts` → `migrate()`)
and can be run standalone (`node dist/db/migrate.js`).

- **Discovery + ordering:** `readdirSync(migrations/).filter(.sql).sort()`. The sort is JavaScript's
  default lexicographic (UTF-16 code-unit) order — **deterministic and platform-independent**. Files
  run in ascending filename order.
- **Ledger:** every applied file is recorded by its **full filename** in the `schema_migrations`
  table (`name text PRIMARY KEY`). A file whose name is already in the ledger is skipped; a file whose
  name is not is applied inside a single transaction, then inserted into the ledger.
- **Privilege:** migrations run as the **owner** (`MIGRATE_DATABASE_URL` → `platform_owner`), so every
  `CREATE TABLE` auto-grants DML to `platform_app` via `ALTER DEFAULT PRIVILEGES` (see
  `infra/db/init-cluster.sh`). After all files apply, the runner runs `RUNTIME_GRANTS_SQL` (idempotent):
  the tight `sync_app` footprint + the `platform_app` REVOKE on sync-internal tables. **You normally do
  not need to write GRANTs in a migration** — default privileges cover new `platform_owner` tables.

## The numbering rules (LOCKED)

1. **Format:** `YYYYMMDDHHMM_snake_case_description.sql` (UTC minute), one concept per file. The
   legacy `NNNN_` form is frozen — valid up to `0118`, refused above it by
   `npm run lint:migration-names`. Everything in rule 2 below is HISTORY, kept because it explains
   the gaps and duplicates a reader will find in the directory; it is no longer instruction.
2. **(HISTORICAL) Monotonic + unique from 0025 onward.** `0023` was consumed out-of-band by
   `0023_meeting_recordings.sql` (WS11 capture-edge work landed before this reservation could be
   drawn down) and `0024` was consumed by `0024_module_backfill.sql` (WSA-2 module registration
   backfill). Both merged before the ORG-CORE tickets started, so **the ORG-CORE reservation is
   rebased to 0025**: ORG-1 = `0025_rls_empty_set_hardening.sql`, ORG-2 =
   `0026_service_layer.sql`. The design doc
   (`docs/superpowers/specs/2026-07-17-org-core-shared-services-design.md`) has been updated to
   match (WS0-1, 2026-07-22). Take the next unused number; never reuse one.
   **2026-07-22 update (ORG-3):** `0027` was drawn down by
   `0027_service_assignment_unit_guard.sql` (ORG-3's security micro-migration — the
   `service_assignments.unit_id` composite-FK tenant guard), which merged before ORG-10 started.
   Per rule 5, **ORG-10's `module_hr` migration is rebased to `0028_module_hr.sql`** (not `0027` as
   previously recorded here). Whoever picks up ORG-10 next: use `0028`, and check this file again
   first in case a later ticket has since drawn that down too.
   **2026-07-30 update (tracker/reporting program, TR-01):** the tracker/reporting design doc
   (`docs/blueprints/tracker-reporting-foundation.md` §4) reserved **0050–0055** off a then-current
   ledger head of 0049. All four of 0050–0053 were consumed out of band before TR-01 executed
   (`0050_pm_short_codes.sql`, `0051_pm_short_codes_backfill_fix.sql`,
   `0052_pipeline_stage_idempotency.sql`, `0053_search_provider_incurred_cost.sql`). Per rules 3+5
   the whole program block is therefore **rebased by +4 to 0054–0059**: TR-01 `pm_task_assignees`
   = `0054` (**merged**), TR-03 `org_unit_memberships` = `0055`, TR-06 reports core = `0056`,
   `report_periods`/`report_documents` = `0057`, appraisal tables = `0058`, metric seeds = `0059`.
   The design doc's §4 headings still say 0050–0055 and have NOT been rewritten — treat this file,
   not the doc, as authoritative for numbers, and re-check it before writing DDL in case a later
   ticket has drawn one of 0055–0059 down too.
   **2026-07-30 update (TR-08, metric seeds).** The reservation table above assigns `0057` to
   TR-14 (`report_periods`/`report_documents`), `0058` to TR-23 (appraisal tables), and `0059` to
   TR-08 (metric seeds). TR-08 executed FIRST in this session's actual timeline — TR-14/TR-23 have
   not been implemented yet — so per rule 5 ("coordinate numbers across parallel tickets... the
   second to merge bumps to the following free slot") and the design doc's own §15 PROCESS RULE,
   TR-08 re-checked `ls migrations | tail` at implementation time, found head = `0056_module_
   reports_core.sql` with **`0057` still free**, and took it: **TR-08 shipped as
   `0057_report_metric_seeds.sql`**, NOT `0059`. Whoever implements TR-14 next: `0057` is now
   TAKEN — re-run `ls migrations | tail` and take the next genuinely free number (likely `0058`,
   but verify; TR-23 may have landed first). This is the second rebase-in-flight this program has
   hit (see the entry immediately above for the first) — the pattern is structural, not
   accidental: multiple sessions add migrations concurrently, so ONLY `ls`, never a doc or this
   file's own reservation table, is authoritative at the moment you actually write DDL.
   **2026-07-31 update (TR-14, `report_periods`/`report_documents`) — `0058`–`0066` are ALL
   unavailable, most of them TAKEN, two deliberately UNFILLED.** `ls migrations | sort | tail` at
   implementation time showed the real head as `0063_pm_task_assignee_intervals.sql` (TR-34),
   `0064_search_change_executions.sql` (SM-21), `0065_search_campaign_metrics_provenance.sql`
   (SM-25c), `0066_search_ads_execution_manifest.sql` (a further concurrent search-marketing
   migration). `0058`/`0059` remain the two reserved gaps for TR-23 (appraisal tables, not yet
   implemented) and TR-08 (already landed as `0057`, per the entry above) respectively — per rule
   3/the doc's own instruction, **do NOT fill 0058/0059**; they stay orphaned reservations, not
   free slots. TR-14 shipped as **`0067_report_periods_documents.sql`**. **Next unused is `0068`**
   — re-verify with `ls migrations | sort | tail` before trusting that, exactly as every entry in
   this log has had to.
3. **Duplicate prefixes are FORBIDDEN going forward.** Two files must never share a numeric prefix.
   (See the grandfather clause for the two historical exceptions.)
4. **Never rename, renumber, edit, or delete a migration that has been applied to any database.**
   The ledger keys on the exact filename — renaming an applied file orphans its ledger row, so the
   runner re-applies the (renamed) file on the next boot and its DDL fails against the objects that
   already exist, breaking startup. Corrections ship as a **new, higher-numbered** migration.
5. **(SUPERSEDED 2026-08-19) Coordinate numbers across parallel tickets.** This rule is what failed,
   four times. There is nothing to coordinate now: name the file for the minute you write it. Kept
   here only so a reader who followed a link to "rule 5" finds out it is gone.

## Grandfather clause — the five existing dual-prefix pairs

Five numeric prefixes are shared by two files each. `0003`/`0018` pre-date this protocol; `0114`,
`0117` and `0118` were collisions between concurrent sessions on 2026-08-18/19 and are the reason
the scheme is now closed (see "Why it changed" above). All five are
**already applied on every existing database**, so they are LEFT AS-IS by design (renaming them would
orphan ledger rows and break boot per rule 4). They are safe because the runner keys on full filenames
and orders deterministically, and because within each pair the two files are **independent** (no
cross-dependency, so their relative order is immaterial):

| Prefix | Files (lexical run order) | Independence |
|---|---|---|
| `0003` | `0003_idp_subject.sql` → `0003_user_title.sql` | different tables/columns |
| `0018` | `0018_pipeline_portal.sql` → `0018_pm.sql` | portal alters `pipeline_runs`/`clients` (from 0017/0001); pm creates fresh `pm_*` — disjoint |
| `0114` | `0114_iam_self_scoped_marker.sql` → `0114_social_post_variants.sql` | `permissions`/`role_permissions` vs `social_post_variants` — disjoint |
| `0117` | `0117_iam_monitoring_permissions.sql` → `0117_monitor_results_partition_rls.sql` | permission seeds vs `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on monitor partitions — disjoint |
| `0118` | `0118_iam_split_decide_assignment.sql` → `0118_social_variant_uploaded_media.sql` | `permissions`/`role_permissions` vs `social_post_variants` — disjoint |

These five are the **only** permitted duplicate prefixes, ever, and they are permitted only because
they already applied. The lint hard-codes exactly this set: a THIRD file on any of these prefixes
fails, as does any new pair. Disjointness was checked per pair, not assumed — within each pair the
relative order is immaterial, which is why four accidents cost nothing. That is luck, and closing the
scheme is what stops the run depending on it.

## WS0-1 resolution of the 0018 collision (rationale of record)

The 0018 collision (`0018_pipeline_portal.sql` vs `0018_pm.sql`) was resolved by **formally accepting
deterministic dual-prefix lexical ordering** (the 0003 precedent), **not** by renumbering. The
decision was forced by the ledger state: both files were already recorded in `schema_migrations` on
the live dev DB, so a rename would have orphaned those rows and re-run the DDL on next boot (rule 4).
Accepting the ordering is ledger-safe, requires no stateful surgery on the dev DB, and was verified:

- **Fresh empty-DB migrate:** green — all 24 files applied in deterministic order (real runner against
  a throwaway `gaiada_migtest` DB), `0018_pipeline_portal.sql` before `0018_pm.sql`.
- **Existing dev-DB re-migrate:** `up to date` (no-op) against the live `gaiada_platform`.

Verification is repeatable: create a fresh DB owned by `platform_owner`, point `MIGRATE_DATABASE_URL`
at it, run `node dist/db/migrate.js`, confirm the ordered `applied:` list and exit 0, then drop it.

   **2026-07-30 update (SM-51, search Google OAuth) — `0060` is TAKEN.** The search-marketing
   programme landed `0060_search_google_oauth_states.sql` and it is applied. It deliberately skipped
   past the TR reservation rather than drawing `0058`/`0059` down: those two are still reserved for
   TR-23 (appraisal tables) and — per the TR-08 note above — the reservation block, so taking the
   **first slot beyond the reservation** avoids a third rebase-in-flight for a program that has
   already been rebased once. **Next unused is `0061`.**

   Standing note for anyone about to write DDL, learned the hard way twice this session: two
   different search tickets were briefed with a stale number by their own coordinator (`0049` when
   `0049`–`0052` were already applied; `0057` when it had been consumed mid-ticket). Both agents
   checked `schema_migrations` **and** this file instead of trusting the instruction, which is the
   only reason neither collided with a live ledger row. **Re-check both immediately before writing —
   an instruction naming a number is a hint, not a fact.**

   **2026-07-31 update (TR-34, as-of task ownership) — `0063` is TAKEN.** `ls migrations | tail`
   showed head files through `0057_report_metric_seeds.sql` plus `0060`–`0062` (search-marketing,
   landed per the note above). `0058`/`0059` remain reserved for TR-23/TR-14 and were deliberately
   NOT filled. TR-34 shipped as `0063_pm_task_assignee_intervals.sql` (validity intervals on
   `pm_task_assignees`' owner/responsible roles — the ownership-axis counterpart to `0055`'s
   unit-axis history-rewrite fix). **Next unused is `0064`.**

   **2026-07-31 update (SM-21 + SM-25c, search-marketing) — `0064` and `0065` are TAKEN.** Two
   concurrent sessions on the same module, and they DID collide once: SM-25c drafted its file as
   `0064` while SM-21 was writing `0064_search_change_executions.sql`. Caught before either was
   applied anywhere (no `schema_migrations` row existed for either), and SM-25c renamed to `0065`.
   `0058`/`0059` remain reserved for TR-23/TR-14 and were again deliberately NOT filled.
   - `0064_search_change_executions.sql` (SM-21) — the api-mode change-proposal execution record;
     `UNIQUE (approval_id)` is the one-shot consumption of the WS4 approval.
   - `0065_search_campaign_metrics_provenance.sql` (SM-25c) — additive `simulated`/`connection_id`
     provenance columns on `search_campaign_metrics_daily`.
   Both are registered in `src/modules/search/index.ts`'s `migrations` array. **Next unused is
   `0066`** — and the lesson from the near-collision above is the one rule 5 already states: when two
   agents work one module in the same session, `ls migrations/` at the moment you write DDL is the
   only authority. A number in a ticket brief was stale for BOTH of these tickets.

   **2026-07-31 update (TR-14, `report_periods`/`report_documents`) — `0067` TAKEN; TR-23's `0058`
   reservation confirmed still orphaned.** TR-14 shipped as `0067_report_periods_documents.sql`
   (search-marketing had already taken `0060`-`0066` by the time it landed). `0058`/`0059` remain
   the two deliberately-unfilled reserved gaps (0058 for TR-23/appraisal tables, not yet implemented
   at that point; 0059 already consumed by TR-08 as `0057`) — **do NOT fill them.**

   **2026-07-31 update (TR-23, appraisal tables) — `0068` TAKEN.** `ls migrations | sort | tail` at
   implementation time showed the real head as `0067_report_periods_documents.sql` (TR-14, landed)
   with `0068` genuinely free — no further rebase needed. TR-23 shipped as
   `0068_report_appraisals.sql`: `report_appraisal_cycles`, `report_appraisals`,
   `report_appraisal_acks`, all three under the same 'reports' module third wall as
   0056/0057/0067. `0058`/`0059` remain the two permanently-orphaned reservation gaps for this
   program (0058 was this ticket's original doc-reserved number, drawn down past before TR-23
   executed; 0059 was consumed by TR-08 as `0057`) — **still do NOT fill them; they are dead
   numbers now, kept only as a record of how the program's reservation table drifted.** Registered
   in `src/modules/reports/index.ts`'s `migrations` array. **Next unused is `0069`** — re-verify
   with `ls migrations | sort | tail` before trusting that, exactly as every entry in this log has
   had to.

   **2026-08-01 update (TR-42, `reports_staff`/`reports_manager` global roles) — `0069` TAKEN.**
   `ls migrations | sort | tail` at implementation time showed the real head as
   `0068_report_appraisals.sql` with `0069` genuinely free — no rebase needed. TR-42 shipped as
   `0069_report_module_roles.sql`: seeds the two global (`company_id IS NULL`) roles
   `reports_staff`/`reports_manager` that `cerbos/policies/resource_report_document.yaml`'s
   `module_staff`/`module_manager` derived roles and `service-reconciler.ts`'s `moduleRoleId()` have
   been waiting on since TR-25 — 0026 block (E) seeded only the `hr_*` pair, so every real
   `module_key='reports'` service assignment reconciled to a silent skip (no grant, no error) until
   now. Same `NOT EXISTS`-guarded idiom as 0026 block (E), reused deliberately. No Cerbos policy
   edit, no `rbac.ts` edit — the policy already spells the role names generically. `0058`/`0059`
   remain the two permanently-orphaned reservation gaps for this program — still do NOT fill them.
   Registered in `src/modules/reports/index.ts`'s `migrations` array. **Next unused is `0070`** —
   re-verify with `ls migrations | sort | tail` before trusting that.

   **2026-08-04 update (MAIL-04 mail core) — this log had drifted by SEVEN numbers.** The entry
   above reported "next unused is `0070`"; the real head at implementation time was
   `0075_client_portal.sql`, and `0070`–`0075` had all been consumed by work that never appended
   here (`0070` is claimed by WD-23A-1's then-staged Google-OAuth file, `0071_it_network_discovery`,
   `0074_pipeline_runs_backfill_client_from_meeting`, `0075_client_portal`, …). The mail subsystem's
   ticket plan was written against `0076` on that stale basis and **`0076` was itself taken
   mid-session** by a concurrent session landing `0076_core_google_oauth_states.sql` (WD-23A-1).
   MAIL-04 therefore shipped as **`0077_mail_core.sql`** (`mail_log`, `mail_suppressions`,
   `mail_messages` — GLOBAL, no RLS per design §6.1, zero backfill DML). `0058`/`0059` remain the
   two permanently-orphaned gaps — still do NOT fill them. **Next unused is `0078`.**

   The standing lesson, now demonstrated twice in one day: **this file is a record, not an
   authority.** Multiple sessions share one working tree and land migrations concurrently, so a
   number written in any plan or in this log is a hint that can go stale between planning and DDL.
   Always run `ls migrations | sort | tail` immediately before naming a migration file, and append
   here in the same change.

   **2026-08-05 update (MAIL-25, mail truncation metadata) — `0081` collided mid-ticket; shipped as
   `0082`.** `ls migrations | sort | tail` at implementation time showed the real head as
   `0080_auth_magic_links.sql` (MAIL-10, landed) with `0081` genuinely free, and the file was
   written as `0081_mail_truncation_metadata.sql` on that basis — exactly the number the ticket
   brief itself warned "has moved four times today across concurrent sessions." Before this file's
   own test run finished, a concurrent HR-loans session landed `0081_hr_loans.sql` (untracked,
   uncommitted, same as this one at that moment) — a genuine duplicate-prefix collision, forbidden
   by rule 3 above. Neither file had been applied to any persistent database yet (both were
   freshly-written, uncommitted files; the only place either had run was a disposable per-test-file
   DB), so rule 4's "never rename an APPLIED migration" did not apply — this ticket's file was
   renamed to the next genuinely free number instead: **`0082_mail_truncation_metadata.sql`** (two
   additive columns on `mail_messages`: `body_truncated boolean NOT NULL DEFAULT false`,
   `body_truncated_chars integer NOT NULL DEFAULT 0`; zero backfill DML). `0081_hr_loans.sql` was
   left untouched — not this ticket's file to renumber. `0058`/`0059` remain the two
   permanently-orphaned reservation gaps — still do NOT fill them. **Next unused is `0083`** —
   re-verify with `ls migrations | sort | tail` before trusting that; this exact scenario (a number
   free at check-time, taken by the time the file lands) is the demonstrated failure mode, not a
   hypothetical one.

   **2026-08-06 update (T3b, `assistant_write_intents`) — landed as `0085`, no collision.**
   `ls migrations | sort | tail` at authoring time showed the real head as
   `0084_assistant_handoffs.sql` (ASST-21, landed same day), so this ticket's new table took
   `0085_assistant_write_intents.sql` — a brand-new table, zero DML, composite tenant-scoped FK to
   `assistant_tool_calls` (`ON DELETE CASCADE`), `UNIQUE (tool_call_id)` on a NOT-NULL column (the
   "NULL defeats UNIQUE" trap does not apply here — checked explicitly). Re-verified again
   immediately before the full-suite run (still `0085`, no concurrent session took it in the
   interim). `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps — still do NOT
   fill them. **Next unused is `0086`.**

   **2026-08-07 update (assistant thread-title backfill) — landed as `0086`, no collision.**
   `ls migrations | sort | tail` at authoring time showed the real head as
   `0085_assistant_write_intents.sql` with `0086` genuinely free. Shipped as
   `0086_assistant_thread_title_backfill.sql`: a DML-only backfill against the pre-existing
   `assistant_threads`/`assistant_messages` tables (0079), NOT a new-tables migration, so — same
   precedent as `0051_pm_short_codes_backfill_fix.sql` — it is deliberately NOT added to
   `assistantModule.migrations` (that array documents new-table migrations for the module
   registry/registration test, not every DML-only follow-up). Wraps every `assistant_threads`/
   `assistant_messages` touch with BOTH `app.current_tenant_ids` AND `app.scopes='assistant'`
   per-tenant (assistant's FORCE-RLS policy composes BOTH walls — a plain `app.current_tenant_ids`
   backfill, sufficient for `lint:migration-rls`'s own regex, would still silently match zero rows
   here without the module-scope GUC too). `0058`/`0059`/`0070` remain the permanently-orphaned
   reservation gaps — still do NOT fill them. **Next unused is `0087`.**

   **2026-08-07 update (P4-B1/B2, `pm_task_assignment_events`) — `0087` TAKEN, no collision.** The
   ticket brief (`2026-08-04-pm-repsona-parity-phase4-plan.md`) named `0078` off a stale head of
   `0077_mail_core.sql`; `ls migrations | sort | tail` at authoring time showed the real head as
   `0086_assistant_thread_title_backfill.sql` with `0087` genuinely free. Shipped as
   `0087_pm_task_assignment_events.sql`: the append-only Ball/assignment history ledger beside
   `pm_tasks.assignee` (plan §1.5/workstream B — Ball is NOT a new axis, only the history table is
   new). Composite tenant-scoped FK to `pm_tasks(id, tenant_id)` (reuses 0054's
   `ux_pm_tasks_id_tenant`), plain `tenant_isolation` policy off `app_current_tenants()` (pm_*
   convention, NOT the `app_module_allowed` third wall — see the file's own deviation-(2) note),
   append-only enforced by a genuine BEFORE UPDATE/DELETE trigger (0068's precedent, not a
   `platform_app` GRANT/REVOKE — the file explains why a REVOKE is untestable through this repo's
   test harness). `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps — still do
   NOT fill them. **Next unused is `0088`.**

   **2026-08-07 update (MI-01, `webdev_change_requests`) — `0088` TAKEN, no collision.** The
   design doc (`2026-08-07-webdev-maintenance-intake-design.md` §1.2) named "next-unused at merge
   time" rather than a fixed number, correctly anticipating drift. `ls migrations | sort | tail`
   at authoring time showed the real head as `0087_pm_task_assignment_events.sql` (untracked,
   concurrent PM session) with `0088` genuinely free; re-verified again immediately before writing
   the file (still free) and again before committing (a concurrent session had by then landed
   `0089_pm_dependency_enforcement.sql`, which is past this ticket's number and does not collide).
   Shipped as `0088_webdev_change_requests.sql`: the maintenance-intake table, brand new, zero DML.
   Guarded DO block adds `ux_pipeline_runs_id_tenant` (fresh — no prior migration had it) and
   no-ops on `ux_pm_tasks_id_tenant` (already exists, from `0054`). Deliberately takes the **plain
   CORE tenant wall** (0075's shape), NOT the `app_module_allowed('webdev')` third wall D-2 would
   otherwise assign — ratified as D-2a (design doc §1.1, `webdev-design.md` §14): the client portal
   is this table's primary writer and portal controllers declare no module scope, so a third wall
   would silently zero every portal read. Two partial-unique backstops (`ux_wcr_run`, `ux_wcr_task`)
   over the nullable link columns, plus two structural CHECK constraints
   (`wcr_route_matches_status`, `wcr_portal_has_requester`) encoding the v1 state machine and the
   portal threat model in DDL rather than controller discipline. Verified on a disposable
   per-test-file Postgres via the repo's own `initTestDb` harness (migrated as owner, queried as
   `platform_app_test`, NOSUPERUSER NOBYPASSRLS): cross-tenant isolation, unset-GUC-reads-zero-rows-
   no-error, the composite-FK cross-tenant rejection (with a same-tenant positive control), both
   CHECK constraints' bad-combination rejections, and both partial uniques' many-NULLs-allowed /
   second-non-null-refused behavior — 8/8 assertions green; test database dropped after the run
   (confirmed zero leftover `pgtest_f*`/prefixed databases). `npm run lint:migration-rls` green (88
   migrations scanned, 35 enforced). `0058`/`0059`/`0070` remain the permanently-orphaned
   reservation gaps — still do NOT fill them. **Next unused is `0090`** (`0089` is now TAKEN by a
   concurrent PM session's `pm_dependency_enforcement.sql`, landed between this ticket's
   authoring-time check and its commit — re-verify with `ls migrations | sort | tail` before
   trusting that, exactly as every entry in this log has had to).

   **2026-08-09 update (PRV-01, `webdev_provisioned_sites`) — `0090` TAKEN, no collision.** The
   design doc (`docs/blueprints/provision-erp-seam-design.md` §05) named "next-unused at merge
   time" rather than a fixed number, correctly anticipating drift. `ls migrations | sort | tail`
   at authoring time showed the real head as `0089_pm_dependency_enforcement.sql` with `0090`
   genuinely free; re-verified again immediately after the test suite ran, still free, no
   concurrent session had taken it in the interim. Shipped as `0090_webdev_provisioned_sites.sql`:
   the ERP-side mirror of a provision/webdesk-created site+repo, brand new, zero DML. Composite
   tenant-scoped FK to `pipeline_runs (id, tenant_id)`, reusing `ux_pipeline_runs_id_tenant`
   (added by 0088 — NOT recreated here). Takes the `app_module_allowed('webdev')` **THIRD WALL**
   (0028/0079's shape), deliberately NOT 0088's plain wall — see this file's own header for the
   full justification: 0088's D-2a exception applies only because the client portal is that
   table's primary writer, and nothing portal- or core-scoped ever touches
   `webdev_provisioned_sites` (every access path is the new `webdev` module's controllers,
   PRV-02). Two deviations from the design's literal §05 DDL sketch, both flagged in the
   migration's own header rather than made silently: (1) `provider_ref` is nullable (state-tied
   by a CHECK, `wps_provider_ref_present_once_egressed`) because the design's own state machine
   requires a pre-egress `requested` row that cannot yet have one; (2) an added tenant-scoped
   partial-unique on `(tenant_id, provider_ref)` beyond what the sketch enumerated, as a second
   idempotency backstop. Verified on a disposable per-test-file Postgres via the repo's own
   `initTestDb` harness against the **test containers** (`gaiada-test-pg` :55433 /
   `gaiada-test-cerbos` :3592, distinct `TEST_DB_PREFIX`), migrated as owner, queried as
   `platform_app_test` (NOSUPERUSER NOBYPASSRLS): cross-tenant isolation, the two-sided
   `app_module_allowed` handshake (unset AND wrong-scope both read zero rows, no error; correct
   scope reads the row), the composite-FK cross-tenant rejection (constructed mismatch against a
   real different-tenant run, with a same-tenant positive control), the status-tied provider_ref
   CHECK, the slug-grammar CHECK, and all three partial-unique backstops' many-NULLs-allowed /
   second-non-failed-refused / retry-after-failure-allowed behavior — 13/13 assertions green;
   test database dropped after the run (confirmed zero leftover `prv01_*`-prefixed databases; one
   unrelated `pgtest_f_*` database from a different concurrent session was left untouched, not
   this ticket's to clean up). `npm run lint:migration-rls` green (89 migrations scanned, 36
   enforced). `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps — still do NOT
   fill them. **Next unused is `0091`** — re-verify with `ls migrations | sort | tail` before
   trusting that, exactly as every entry in this log has had to.

   **2026-08-10 update (IAM program, `0091` AND `0092` TAKEN together — pre-assigned, no collision.)**
   Two migrations were authored **concurrently by two different sessions in this same checkout**, so
   for the first time the numbers were **assigned up front by the coordinating session** rather than
   each author reading the head and hoping. That is the fix for the race this log has recorded twice
   (see the `0089` and `0090` entries above, both of which discovered a concurrent taker only after
   authoring): when two migrations are in flight at once, `ls | tail` is *structurally* incapable of
   being right for the second author, because the first author's file does not exist yet.
   - `0091_iam_02d_ungrantable_roles.sql` (IAM-02d) — seeds `team_lead`, `viewer`, `it_manager`,
     `it`, `search_staff`, `search_manager` as global roles. Six role names were referenced by the
     Cerbos policies and `platform-ui/src/lib/rbac.ts` but had **no `roles` row**, so they could not
     be granted. Ships `src/rbac/role-catalog-drift.db.test.ts` as the recurrence guard.
   - `0092_user_roles_global_scope_unique.sql` (IAM-01c-2) — dedupes global-scope duplicate grants
     and adds partial unique index `user_roles_global_scope_uniq (user_id, role_id, scope_type)
     WHERE scope_id IS NULL`, closing the hole where `UNIQUE (user_id, role_id, scope_type,
     scope_id)` never fires because `scope_id IS NULL` and SQL NULLs are never equal.
   `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps — still do NOT fill them.
   **Next unused is `0093`.** Re-verify with `ls migrations | sort | tail` as always — and if another
   session is authoring a migration at the same time, agree the numbers in advance instead.

   **2026-08-10 update (IAM-02e, six BASELINE roles) — `0095` TAKEN, pre-assigned, no collision.**
   Coordinated up front like the `0091`/`0092` pair above: `0093`/`0094` were reserved for two other
   concurrently-working sessions per the coordinating session's ticket brief, so IAM-02e was told to
   use `0095` directly rather than reading `ls | tail` and hoping. Re-verified at authoring time
   (head was `0092_user_roles_global_scope_unique.sql`, `0093`/`0094` correctly absent yet) and again
   immediately before this entry (`0093_iam_permission_catalog.sql` has since landed; `0094` is still
   absent/in flight; `0095` remained free throughout). Shipped as
   `0095_iam_02e_baseline_roles.sql`: seeds `member`, `manager`, `company_admin`, `platform_admin`,
   `group_executive`, `it_admin` as global (`company_id IS NULL`) `roles` rows — the six baseline
   roles that, until now, were created ONLY by the manual `npm run seed:agency` script and by no
   migration at all, so a freshly-migrated environment with no seed run had no baseline roles at
   all. Same `NOT EXISTS`-guarded idiom as `0026`/`0069`/`0091`. **No new partial-unique index
   needed** — `0073_dedupe_global_roles.sql` already added
   `roles_global_name_uniq ON roles (name) WHERE company_id IS NULL`, well before this ticket;
   confirmed by reading that file directly rather than assuming. `0058`/`0059`/`0070` remain the
   permanently-orphaned reservation gaps — still do NOT fill them. **Next unused is `0096`**
   (`0094` may still land before it — re-verify with `ls migrations | sort | tail` before trusting
   that, exactly as every entry in this log has had to).

   **2026-08-10 update (IAM phase 1, `0096` TAKEN by the coordinating session).**
   `0096_iam_agency_approver_role.sql` seeds `agency_approver` — the SEVENTH role with the
   "seed-script-only, no migration behind it" defect that `0091` and `0095` closed for the other
   twelve. Taken by the coordinator rather than an agent because it closed a **red test in the
   shared tree**, and it is worth recording HOW it surfaced, because the mechanism is the point:
   `0091` shipped `src/rbac/role-catalog-drift.db.test.ts`, which asserts every role named in
   `platform-ui/src/lib/rbac.ts`'s `Role` union has a global `roles` row in a migrations-only
   database. `agency_approver` was absent from `rbac.ts` entirely (drift-register finding #1 — a
   live-held role the UI mirror conferred ZERO capabilities for), so the guard could not see the
   seeding gap underneath it. Owner decision **DR-2b** added the role to `rbac.ts`; the guard went
   red the same day. **Two half-defects had been hiding each other.** Not folded into `0095` per
   rule 4 (never edit an existing migration to absorb a late finding) — `0095`'s author found it
   while verifying their own work, after that file was written.
   Verified: `role-catalog-drift.db.test.ts` + `baseline-roles-migration.db.test.ts` 6/6 green,
   `npm run lint:migration-rls` OK across 94 migrations. `0058`/`0059`/`0070` remain the
   permanently-orphaned reservation gaps. **Next unused is `0097`** — `0094` is STILL in flight and
   absent as of this entry, so it will land out of numeric order; that is expected and harmless (the
   runner sorts lexicographically and applies by filename, and `0094`/`0096` are independent).
   Re-verify with `ls migrations | sort | tail` before trusting this, as always.

   **2026-08-10 update (IAM-02g, webdev `role_permissions` bundle) — `0098` TAKEN, pre-assigned, no
   collision.** The ticket brief named `0098` directly (reserved for IAM-03, released unused per
   the Wave 4 entry above — "the benchmark showed no index was warranted, so it returned to the
   pool"). Re-verified with `ls migrations | sort | tail` at authoring time: real head was
   `0097_webdev_module_roles.sql` with `0098` genuinely free. Shipped as
   `0098_iam_02g_webdev_role_permission_bundles.sql`: 10 `role_permissions` rows bundling
   `webdev_staff` (4: `webdev.change_request.read`, `webdev.provisioned_site.read`,
   `core.member.read`, `core.service_assignment.read`) and `webdev_manager` (6: adds
   `webdev.change_request.triage`, `webdev.provisioned_site.provision`/`.reconcile`,
   `core.service_assignment.read`; drops `core.member.read` — that generic rule is module_staff
   ONLY, per `resource_member.yaml`) — closing 0094's own finding (b): `0097` seeded the `roles`
   rows, but no migration bundled them, so a webdev module grant would have resolved to an EMPTY
   permission set the moment IAM-04's rollout makes `role_permissions` load-bearing. Zero DML
   against any other role; zero Cerbos policy edits; zero `rbac.ts` edits. `role-permission-
   bundles.json` regenerated (18 -> 20 roles, 925 -> 935 pairs) via `scripts/generate-role-
   bundles.mjs`, which was extended (REAL_ROLES + module_staff/module_manager resolvers) to close
   the same finding on the generator side. New completeness guard
   `src/rbac/role-bundle-completeness.db.test.ts` (IAM-02g) derives every global `roles` row live
   from the DB and asserts a non-empty bundle for each — no hand-maintained role list, so a future
   variant #5 fails loudly by name instead of by accident. `0058`/`0059`/`0070` remain the
   permanently-orphaned reservation gaps — still do NOT fill them. **Next unused is `0099`** —
   re-verify with `ls migrations | sort | tail` before trusting that; this checkout has three other
   concurrent sessions in flight as of this entry.

   **2026-08-10/11 update (HIER-1..HIER-3, the `team`/`org_unit` hierarchy consolidation) —
   `0100`–`0103` all TAKEN, no collision.** Four migrations landed across three tickets in this
   same program (`docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md`):
   - `0099_iam_dr5_company_admin_appraisal_read.sql` (DR-5) — landed between the entry above and
     this one.
   - `0100_user_roles_org_unit_scope.sql` (HIER-1) — adds `org_unit` to `user_roles.scope_type`,
     widens `scope_id` `uuid` -> `text`, adds the per-scope shape CHECK. **Expand-only by
     amendment** (its own header explains why): `team`/`record` stay in both CHECKs pending their
     writers' removal.
   - `0101_org_unit_closure.sql` (HIER-2/IAM-09) — the org-unit ancestor closure table.
   - `0102_iam_hier2_org_unit_lead_role.sql` (HIER-2) — seeds the global `org_unit_lead` role +
     its 2-permission bundle.
   - `0103_hier3_retire_team_scope.sql` (HIER-3) — the CONTRACT half: hard-aborts on any
     surviving `team`/`record` row, narrows both CHECKs to `(global,company,org_unit,project)`,
     drops `teams`/`team_memberships` (0 rows, count-asserted), deletes the global `team_lead`
     role (cascades its bundle), and deletes the 4 `core.team.*` catalog permissions (cascades
     any remaining bundle references). Landed in the SAME change as deleting
     `core/teams.controller.ts`, `resource_team.yaml`, and reworking the `team_lead` persona to
     `org_unit_lead` — values and writers retired together, per this program's own HIER-1 lesson.
   `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps — still do NOT fill them.
   **`0104` was ALREADY TAKEN by the time this entry was written** — a concurrent session
   (IAM-DR12, `0104_iam_dr12_drop_portal_staff_bundle_rows.sql`) was authoring it in this same
   checkout at the same time, pre-assigned per this file's own `0091`/`0092` precedent (the
   coordinating session assigns numbers up front when two migrations are known to be in flight
   together, rather than each author racing `ls | tail`). **Next unused is `0105`** — re-verify
   with `ls migrations | sort | tail` before trusting that, exactly as every entry in this log has
   had to.

   **2026-08-13 update (P2-01, IAM Phase 2 foundation) — `0109` TAKEN, no collision.** This log had
   again drifted (last entry said "next is `0105`"); `ls migrations | sort | tail` at authoring
   time showed the real head as `0108_iam_gap_02_invoice_self_approval_deny_and_revisions.sql`
   (four concurrent IAM/social migrations — `0105`-`0108` — had landed without a README entry each)
   with `0109` genuinely free; re-verified again immediately before writing DDL and once more before
   this entry (still free both times, no concurrent taker). Shipped as
   `0109_iam_phase2_positions.sql`: `employees` (HR-owned, THIRD wall
   `app_module_allowed('hr')`), `positions`/`position_roles`/`position_assignments`/
   `position_grant_claims` (CORE, plain `tenant_isolation` — design §2 preamble explicitly rules
   these platform-wide-read, not module-gated), plus three additive `user_roles` columns
   (`managed_by_position`, `expires_at`, `origin_approval_id`) + one exclusivity CHECK. Design:
   `docs/superpowers/plans/2026-08-13-iam-phase2-design.md`. Zero backfill DML — every table is a
   fresh CREATE TABLE; the `user_roles` ALTER only adds nullable columns (count/value-asserted
   unchanged in the test suite). The design's §2.3 guard trigger on `position_roles` is IMPLEMENTED
   for the denied-role registry and the scope-shape check; the `ui_grantable` bundle clause is
   DEFERRED to P2-03 (that column doesn't exist yet and this ticket is expressly forbidden from
   touching the permission catalog) — `CREATE OR REPLACE FUNCTION`, same trigger, no renumbering,
   when P2-03 lands. Full report: `docs/superpowers/plans/2026-08-13-p2-01-report.md`. `0058`/
   `0059`/`0070` remain the permanently-orphaned reservation gaps — still do NOT fill them. **Next
   unused is `0110`** — re-verify with `ls migrations | sort | tail` before trusting that, exactly
   as every entry in this log has had to; this checkout is shared with at least one other
   concurrent session (a monitoring feature, per this ticket's own brief) as of this entry.

   **2026-08-18 update (P2-06, IAM Phase 2 JML) — `0111` TAKEN.** `ls migrations | sort | tail`
   immediately before writing showed the head as
   `0110_iam_phase2_role_grant_kinds_ui_grantable.sql` with `0111` free.
   `0111_iam_phase2_employee_work_email_key.sql` adds ONE partial unique index —
   `ux_employees_tenant_work_email` on `(tenant_id, work_email) WHERE work_email IS NOT NULL AND
   deleted_at IS NULL` — because design §5.1's stated joiner natural key was NOT enforced by
   `0109`: its unique is on `(tenant_id, user_id) WHERE user_id IS NOT NULL`, and a `pending_start`
   candidate has no `user_id`, so two retries of the same hire before the principal existed would
   have produced two employee rows for one person. Index creation only, zero DML (the table had no
   rows in any environment before P2-06 wrote the first one). Case-insensitivity is maintained by
   the application lowercasing `work_email` on every write — recorded here because that half of the
   invariant lives in `employees.controller.ts`, not in the index. Full report:
   `docs/superpowers/plans/2026-08-18-p2-06-report.md`. `0058`/`0059`/`0070` remain the
   permanently-orphaned reservation gaps — still do NOT fill them. **Next unused is `0112`** —
   re-verify with `ls migrations | sort | tail` before trusting that.

   **2026-08-18 update (owner decisions) — `0112` TAKEN.** `ls migrations | sort | tail` immediately
   before writing showed the head as `0111_iam_phase2_employee_work_email_key.sql` with `0112` free.
   `0112_iam_owner_decisions_2026_08_18.sql` is **DML only, zero schema change**: it drops the
   `(member, core.client.delete)` bundle row (the live over-grant PERMISSION-CONTRACT §12.5 records),
   adds `(hr_manager, core.position.assign/.unassign)`, and clears `sensitive` on seven READ keys
   (107 -> 100, `hr.record.read` deliberately excluded). Every statement asserts its own DELTA with
   `GET DIAGNOSTICS` — never a total, per the 0093 lesson that a migration may assert what it did but
   never the state of a shared table forever. The `member` delete is tolerant of 0 rows (an
   environment seeded after the policy change never had the row) but refuses >1 (duplicates are a real
   defect). Two negative invariants are asserted rather than assumed: `hr.record.read` must still be
   sensitive, and `hr_staff` must NOT hold the position keys. Paired with the policy edits and the
   regenerated JSON in the same commit, because the parity suites compare all three. **Next unused is
   `0113`** — re-verify with `ls migrations | sort | tail` before trusting that.


   **2026-08-18 update (SMM-36, per-network inbox retention + purge) -- `0113` TAKEN.**
   `ls migrations | sort | tail` immediately before writing showed the head as
   `0112_iam_owner_decisions_2026_08_18.sql` with `0113` genuinely free.
   `0113_social_inbox_retention.sql` is additive-only, zero DML (both inbox tables have zero rows in
   every environment -- SMM-15's sync has not shipped yet): two purge-marker columns
   (`profile_data_purged_at`, `activity_content_purged_at`) on BOTH `social_inbox_threads` and
   `social_inbox_messages`, four state-law CHECK constraints ("if the marker is set, the column it
   covers is scrubbed"), and two partial retention-scan indexes matching 0105's own
   `deleted_at IS NULL` idiom. The retention NUMBERS themselves (LinkedIn 24h profile / 48h activity,
   documented; every other network `unverified`, never a guessed default) live in code
   (`src/modules/social/retention-policy.ts`), not in this migration -- a schema-level constant would
   need a new migration every time OQ-1 research corrects or adds a network. Registered in
   `src/modules/social/index.ts`'s `migrations` array. `0058`/`0059`/`0070` remain the
   permanently-orphaned reservation gaps -- still do NOT fill them. **Next unused is `0114`** --
   re-verify with `ls migrations | sort | tail` before trusting that; this checkout has other
   concurrent social-module sessions in flight as of this entry.

   **2026-08-19 update (the self-scoped marker) — `0114` TAKEN.** `ls migrations | sort | tail` showed
   the head as `0113_social_inbox_retention.sql` (a concurrent session took `0113`), so this is `0114`.
   `0114_iam_self_scoped_marker.sql` adds `role_permissions.self_scoped` and marks 21 (role, permission)
   pairs generated by `scripts/generate-role-bundles.mjs::computeSelfScoped`. Idempotent by
   construction: it clears every TRUE first, so a re-run (or a later bundle re-seed) cannot strand a
   stale marker. Asserts the DELTA (`marked <> expected` raises) rather than any total, per the 0093
   lesson. **Next unused is `0115`** — re-verify with `ls migrations | sort | tail`.

   **⚠ 2026-08-19 — `0114` NUMBER COLLISION (two files, both applied). NOT to be repeated.**
   `0114_iam_self_scoped_marker.sql` and `0114_social_creator_info_snapshot.sql` both exist and are
   both in `schema_migrations` on the live box. Two concurrent sessions each ran `ls migrations | sort
   | tail`, each saw `0113_social_inbox_retention.sql` as the head, and each reserved `0114` — the
   exact race rule 5 exists to prevent, and the second instance of it in this program (see the
   2026-08-10 note about pre-assigning numbers when authors overlap).

   **No damage this time, and here is precisely why**, so nobody concludes the protocol is optional:
   the runner orders by `readdirSync().sort()`, which is deterministic, so `..._iam_...` ran before
   `..._social_...` on every environment identically; the ledger is keyed on the FULL filename, so
   both rows coexist without either being skipped; and the two files touch disjoint tables
   (`role_permissions` vs the social tables). Change any one of those three and this is a corrupted
   estate rather than an untidy log.

   **Deliberately NOT renumbered.** Renaming an applied file makes the runner treat it as new work:
   the marker migration is idempotent (it clears every `self_scoped` before re-marking) so a re-run is
   harmless, but it would add a second ledger row for the same change and rewrite shipped history for
   no benefit. Both numbers stay; `0114` is now a permanently DOUBLE-BOOKED number, alongside the
   `0058`/`0059`/`0070` orphan gaps.

   **Next unused is `0115`** — and while two sessions are active in this checkout, RESERVE IT BY
   CREATING THE FILE before writing DDL, per rule 5. `ls | tail` alone is not sufficient and has now
   failed twice.

   **2026-08-19 update (P2-08 part B) — `0115` TAKEN, and RESERVED BEFORE THE DDL WAS WRITTEN.** The
   file was created as a stub the moment the number was chosen, then filled in — the rule this log
   added hours earlier after `0114` was double-booked, applied to its own author.
   `0115_iam_override_decide.sql` seeds `core.role_grant.decide_override` + its 4 bundle rows
   (generated from `role-permission-bundles.json`, itself generated from the policies) and widens
   `automation_approvals.origin` to admit `'iam'`, following `0028`'s drop-and-re-add DO block —
   Postgres cannot ALTER a CHECK in place, and the constraint is looked up BY DEFINITION because
   `0016` created it auto-named. Purely additive: no existing row can violate a wider set. **Next
   unused is `0116`.**

   **2026-08-19 update — `0117` TAKEN (reserved before DDL, again).**
   `0117_monitor_results_partition_rls.sql` FORCE-RLSes every `monitor_results` PARTITION. `0116`
   (MON-10, a concurrent session) hardened the partitioned PARENT and its own hardcoded nine-table
   list missed the partitions; in Postgres a partition queried directly is governed by its own
   policies, so tenant isolation was absent there. Amended in a NEW migration because 0116 is
   committed and possibly applied. Loops over `pg_inherits` rather than naming partitions, since 0116
   derives their names from the month it runs. **Partitions created later by a rollover job are NOT
   covered** — that belongs with the monitoring owner. **Next unused is `0118`.**

   **2026-08-19 update — `0118` TAKEN (reserved before DDL).**
   `0118_iam_split_decide_assignment.sql` splits `core.position.decide_assignment` out of
   `core.role_grant.decide_override` (owner instruction) and corrects the override key's description,
   which had claimed to cover placements. Holder list generated from the bundles; DELTA-asserted, 0 on a
   re-run. No behaviour change: both actions carry the identical four tiers. **Next unused is `0119`.**

   **🔴 2026-08-19 — `0118` DOUBLE-BOOKED TOO, AND THE MITIGATION I ADDED YESTERDAY DID NOT WORK.**
   `0118_iam_split_decide_assignment.sql` and `0118_social_variant_uploaded_media.sql` both exist and
   both applied. That is the SECOND collision in two days (`0114` was the first), and it happened
   *after* this log gained the rule "reserve the number by creating the file before writing DDL" — a
   rule I followed exactly and which still lost the race.

   **Why reserve-by-creating-the-file cannot work.** It only helps if the OTHER session lists the
   directory after my file exists. Two sessions that both run `ls | sort | tail` inside the same window
   both see `0117`, and both then create `0118`. The reservation is not atomic; nothing arbitrates.

   Harmless again, and by the same three properties as `0114`: `readdirSync().sort()` is deterministic
   so the order is identical everywhere, the ledger is keyed on the full filename so neither is skipped,
   and the two touch disjoint tables (`permissions`/`role_permissions` vs `social_post_variants`).
   **Three collisions in, that is luck holding, not a protocol working.**

   **This needs an owner/devops decision, and it is above what a single session should choose:**
     * per-session number BLOCKS (a session claims 0130-0139 up front and never leaves it), or
     * timestamp-prefixed filenames (`20260819T1530_iam_split.sql`), which cannot collide by
       construction and still sort deterministically, or
     * a committed `migrations/CLAIMS.md` that a session must push to before writing DDL, making the
       claim atomic through git rather than through the filesystem.

   Until one is chosen, expect this to recur whenever two sessions are active. `0114` and `0118` are now
   both permanently double-booked, alongside the `0058`/`0059`/`0070` orphan gaps. **Next unused is
   `0119` — and it is not safe to assume that.**
