# Why `team` and `org_unit` both exist — and why they should not

**Status:** ANALYSIS, 2026-08-10. Prompted by the owner asking why two scopes model the same thing.
**Answer: they should not both exist. `teams` is vestigial and has never been used in production.**

---

## 1. There are THREE hierarchies, not two

| # | Concept | Added | Shape |
|---|---|---|---|
| 1 | `teams` + `team_memberships` | `0001_core.sql` | tenant-scoped tree via `parent_team_id`; membership `role ∈ member \| lead` |
| 2 | `company_org_structure` | `0011` | the org chart, one JSON blob per company |
| 3 | `org_units` + `org_unit_memberships` | `0026` / `0055` | relational anchor for blob nodes (`department`/`division`) + **temporal** membership (`valid_from`/`valid_to`, GiST non-overlap) |

(1) and (3) are the **same shape** — a hierarchy of groups with people in them, one of whom leads.
They were built for the same job, three migrations apart.

## 2. Live data settles it (`gaiada_platform`, 2026-08-10)

| Table | Rows |
|---|---|
| `teams` | **0** |
| `team_memberships` | **0** |
| `user_roles` WHERE `scope_type='team'` | **0** |
| `org_unit_memberships` | **19** |
| `company_org_structure` | **2** |
| `org_units` | 0 (lazy — only materialized by a service assignment) |

**The `teams` hierarchy has never been used.** No teams, no members, not one team-scoped grant.
Meanwhile the org-chart lineage carries real data and is read by `company-admin.controller.ts`,
`dept-resolution.ts`, `checkins.controller.ts`, `document-builder.ts` and `fact-job.ts`. In the UI,
`teams` appears once (`lib/org.ts`); org-structure appears across the org builder, admin services,
entities and reports.

## 3. How it happened

`0001_core.sql` shipped the RBAC spec's generic scope cascade —
`global | company | team | project | record` — with `teams` as the intended mid-level grouping.
Then the org-chart lineage was built for the real requirement (departments, divisions, reporting
lines, as-of-date transfers): `0011` the blob, `0026` the anchor, `0055` temporal membership.

**Nobody removed the superseded one.** `team` stayed in the `scope_type` CHECK, `team_lead` stayed
in `derived_roles.yaml`, and ~27 resource policies kept naming `team_lead` in their baseline rules.

## 4. This is the root cause of the IAM-04 rollout cost

The rollout scan found **40 of 57 non-exempt kinds (70%) HAZARDOUS, 22 of them handler-confirmed
dead grants** — and the dominant driver is `team_lead`:

- `team_lead`'s derived role matches **only** `scopeType == "team" && scopeId == resource.attr.teamId`.
- `teamId` reaches authorization in **exactly two** production call sites: `core/teams.controller.ts`
  (the `team` resource itself) and `reports.controller.ts:166` (department grain only).
- So every other policy naming `team_lead` grants reach **no handler can enable**, against a table
  with **zero rows**.

The 70% hazard figure is not mostly an authorization-modelling problem. It is **one dead concept,
wired into most policies, being carried forward.**

## 5. The replacement already exists and is better

`org_unit_memberships` + `dept-resolution.ts` already provide what `team` never did:

- **Temporal** membership with a DB-enforced non-overlap constraint — "who reported where, as of a
  date" is answerable, which appraisals and reports require and `team_memberships` cannot do.
- **Server-side as-of-date resolution** (`dept-resolution.ts`) — pure, unit-tested, already used by
  the org PUT hook and the fact job. The resolver a lead-scoped policy needs is **already written**.
- **A real org chart UI** (`OrgBuilder.tsx`) that people already use, versus no teams UI at all.
- Alignment with owner decision **D-3** (position-driven access) and the stated model: *the
  department head manages permissions for employees under that department.* A department is an
  `org_unit`. It was never a `team`.

## 6. Recommendation

**Collapse to ONE hierarchy: the org chart.**

1. **Add `org_unit` to `scope_type`** (IAM-08) — as `team`'s **replacement**, not a fourth sibling.
2. **Replace `team_lead` with a unit-scoped lead role** that cascades down the org subtree, using
   the closure table IAM-09 already plans and the resolver `dept-resolution.ts` already provides.
3. **Retire `team` scope, `teams`, `team_memberships`, and `team_lead`.** Zero rows and zero grants
   mean this is a code-and-policy sweep with **no data migration and no user impact**.
4. **Sequence it BEFORE IAM-04-ROLLOUT.** Removing `team_lead` from ~27 policies should convert a
   large share of the 22 dead-grant kinds into SAFE ones. Rolling out permission arms first would
   mean carefully mitigating dead grants for a concept about to be deleted — paying the 70% cost to
   preserve something with no rows.

**Cheap validation before committing:** re-run the hazard scan with `team_lead` rules excluded and
count how many kinds move HAZARDOUS → SAFE. That converts the ordering argument from a strong
inference into a measured number, for the cost of one scan.

## 7. What this does NOT resolve

- `project` and `record` scope types are also in the 0001 CHECK. `project` is used; `record` should
  be checked for the same vestigial pattern before anyone builds on it.
- The `module_manager` directory-read oddity (`resource_member.yaml` grants the tenant-directory read
  to `module_staff` but not `module_manager`, so a dept manager cannot browse a directory their own
  staff can) is separate and still open.
