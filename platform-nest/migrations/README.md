# platform-nest migrations — numbering protocol (LOCKED)

**Owner:** DevOps · **Established by:** WS0-1 (Backbone Program, 2026-07-17) · **Status:** NORMATIVE

This directory holds the ordered SQL migrations for `gaiada_platform`. The rules below are binding
for every ticket in the program. New migrations that violate them must not be merged.

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

1. **Format:** `NNNN_snake_case_description.sql`, zero-padded 4-digit prefix, one concept per file.
2. **Monotonic + unique from 0025 onward.** `0023` was consumed out-of-band by
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
5. **Coordinate numbers across parallel tickets.** If two in-flight tickets both need "the next
   number", the second to merge bumps to the following free slot. When in doubt, ask the coordinator.

## Grandfather clause — the two existing dual-prefix pairs

Two numeric prefixes are shared by two files each. Both pairs pre-date this protocol and are
**already applied on every existing database**, so they are LEFT AS-IS by design (renaming them would
orphan ledger rows and break boot per rule 4). They are safe because the runner keys on full filenames
and orders deterministically, and because within each pair the two files are **independent** (no
cross-dependency, so their relative order is immaterial):

| Prefix | Files (lexical run order) | Independence |
|---|---|---|
| `0003` | `0003_idp_subject.sql` → `0003_user_title.sql` | different tables/columns |
| `0018` | `0018_pipeline_portal.sql` → `0018_pm.sql` | portal alters `pipeline_runs`/`clients` (from 0017/0001); pm creates fresh `pm_*` — disjoint |

These are the **only** permitted duplicate prefixes, ever. No new duplicates.

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
