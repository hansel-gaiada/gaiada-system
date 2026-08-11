# Identity, Staff & Permissions Program (IAM-*)

**Status:** PLANNED — 2026-08-10. Owner decisions locked (§1). Nothing built yet.
**Why now:** Web Dev and PM are both blocked on a mature, deployed permission model. IT and HR are
immature and department features are fragmented. Retrofitting this after more modules land costs
more every week.

---

## 1. Locked owner decisions (2026-08-10)

Do not relitigate these without the owner. Each was chosen explicitly.

| # | Decision | Consequence |
|---|---|---|
| D-1 | **Custom roles over a fixed permission catalog.** Permissions ship with features (code); roles are data, composed in the UI. | New role = zero code. New permission = a code change, by design. |
| D-2 | **Cerbos moves from role-name matching to PERMISSION matching**, with a compat shim so the ~60 existing policies keep passing during migration. | The single largest engineering item. Unavoidable if roles are to be data. |
| D-3 | **Position-driven access with per-person overrides.** A position in the org chart carries a role set; placement grants, transfer revokes+regrants. | Joiner/mover/leaver becomes correct by construction, not by memory. |
| D-4 | **Split employee record (HR) / login account (IT) / client contact (portal).** | HR can manage a person who has no login. IT owns the login lifecycle. |
| D-5 | **Role authoring:** superadmin authors the global library; **company_admin authors company-local roles**, bounded by that company's entitled permission set. | Two authoring tiers, both audited, both ceiling-enforced. |
| D-6 | **`platform_admin` and `superadmin` are ONE role.** It is **appointable** — any user can be promoted or demoted. | Removes the duplicate tier. Adds an appointment flow. |
| D-7 | **`group_executive` is OBSOLETE and removed.** "Higher-level management" becomes a named position in a company org chart carrying a normal library role, scoped to that company. | Deletes the last unrestricted cross-company business role. Touches every policy naming it. |
| D-8 | **New `owner` role.** Company owner; may hold one company, several, or the holding. Everything business + role authoring in owned companies; **no platform/system controls**. | Highest-risk role in the system — real, non-technical people. |
| D-9 | **Safeguards (all four):** step-up auth on sensitive actions; two-person rule on elevated appointment; immutable audit + alert on elevated actions; no self-escalation. | Two-person rule is satisfied by **1 superadmin + 1 owner** (typically superadmin + the requesting owner/GM), not necessarily 2 superadmins. |
| D-10 | **Dept-head overrides are routed by what is being granted** (ordinary → company_admin/owner; `hr.*` → HR manager; finance → owner; etc.), through the existing approvals inbox. | Needs a configurable permission→approver routing table. |
| D-11 | **Sequencing: freeze and ship the permission contract FIRST**, build everything else behind it. | Phase 1 unblocks Web Dev + PM; Phases 2+ are invisible to them. |

### Tier model

| Tier | Scope | Nature |
|---|---|---|
| `superadmin` | Platform-wide, all companies | System tier. Appointable. Not a business role. |
| `owner` | 1..N companies, or the holding | Business tier. All business ops + company-local role authoring in owned companies. |
| `company_admin` | One company | Administers a company; authors company-local roles. |
| dept head | Their org-unit subtree | Assigns library roles; **requests** overrides. |
| HR / IT / member / viewer | Company or subtree | Operational roles from the library. |
| `client` | One company, portal only | Unchanged — separate trust surface. |

---

## 2. Where the codebase actually stands

Verified against source on 2026-08-10, not from status docs.

### What is solid and gets kept

- `user_roles(user_id, role_id, scope_type ∈ global|company|team|project|record, scope_id)` —
  `migrations/0001_core.sql:55`. The grant table itself is the right shape.
- Cerbos scope cascade in `cerbos/policies/derived_roles.yaml` — ~60 resource policies over it.
- `src/rbac/principal.ts` — per-request principal assembly from the DB, never client-asserted.
  Carries `assurance` (low/linked/high), authorized tenant set, `sessionVersion` (D11 revocation).
- `service_assignments` + the `managed_by` reconciler — already materializes module roles onto
  **served** companies. This is the exact pattern D-3's position reconciler should copy.
- `org_unit_memberships` (`0055`) — **temporal** (`valid_from` / `valid_to`), with a GiST
  non-overlap constraint on primary memberships. Correct substrate for "who reported to whom, as
  of a date".
- `client_contacts` — clients deliberately kept OUT of `company_memberships` so they can never be
  listed as staff (0072 header). Keep this boundary exactly as-is.
- Step-up / `minAssurance` machinery and the approvals inbox both exist and are reusable for D-9/D-10.

### The blocking gaps

1. **Roles are hardcoded strings, not data.** Cerbos matches `g.role == "hr_manager"` literally;
   `platform-ui/src/lib/rbac.ts` mirrors a hand-written `Role` union and `CAPABILITIES` tuple. A
   role created in the UI today would match **zero** policies and confer **nothing**.
2. **`permissions` and `role_permissions` are DEAD schema.** Both exist in `0001_core.sql` with
   **zero runtime reads** anywhere in `src/`. Someone designed for permission-based authz and then
   built role-name authz on top. This dead seam is what D-1/D-2 revive.
3. **No `org_unit` scope type.** `scope_type` has no department option, so "a dept head manages
   permissions for people under that department" is currently **inexpressible**, and grants do not
   cascade down the org tree.
4. **No `positions` table.** `org_unit_memberships` attaches a *user* to a *unit node* — there is
   no position/job entity to hang a role set on. D-3 requires one.
5. **No employment record.** `users` fuses staff, bots, and (partly) clients. Hire date, position,
   reporting line, employment status live nowhere. `hr_records`/`hr_cases` are case files, not the
   people file.
6. **The org tree is a JSON blob.** `company_org_structure` holds the tree; `org_units` is a lazy
   relational anchor keyed on free-form text `node_id` (`'d-hr'`, `'d-web'`). Subtree queries for
   delegation need a real traversal path — the blob cannot be joined against.
7. **Logins barely exist.** ~7 of ~47 platform users have Keycloak accounts. A `users` row is not a
   login. The `gaiada-provisioner` Keycloak client exists but no IT console drives it.
8. **`group_executive` is load-bearing in ~60 policies** and must be removed (D-7).

---

## 3. Target model

```
company_org_structure (JSON tree)  ──anchors──>  org_units (+ closure table, NEW)
                                                      │
                                                      ├── positions (NEW)  ──> role_assignments
                                                      │       │
employee (NEW, HR owns) ───────holds──────────────────┘       │
   │  hire date, employment status, reporting line            │
   │  0..1                                                     │
   ▼                                                          ▼
users (IT owns: Keycloak link, session_version, MFA)  ──> user_roles (grants, + org_unit scope)
                                                                 │
client_contacts (portal, separate) ──────────────────────────────┤
                                                                 ▼
                                              resolved PERMISSIONS per scope
                                                                 │
                                                                 ▼
                                              Cerbos (permission-matching policies)
```

**The authorization chain becomes:**
`employee → position → role assignment → role → permissions → scope → Cerbos decision`,
with per-person overrides (approved, time-boxed) layered on top.

---

## 4. Phases

Ordered by dependency. Phase 1 is the unblock; everything after is invisible to Web Dev and PM.

### Phase 1 — Permission contract freeze (UNBLOCKS WEB DEV + PM)

Goal: a stable, published contract consumers can code against **today**, that will not change when
Phases 2+ land.

- **IAM-01** Permission catalog. Wire the dead `permissions` table as the live registry. Define the
  naming convention (`<module>.<resource>.<action>`), seed from today's `CAPABILITIES` tuple plus
  every action in the ~60 Cerbos policies. One reviewed list — this is the contract.
- **IAM-02** Role→permission bundles. Seed each current built-in role as a bundle in
  `role_permissions`. Behaviour must be byte-identical to today's role-name matching.
- **IAM-03** Principal carries resolved permissions. Extend `src/rbac/principal.ts` to emit
  `perms: { [scope]: permission[] }` alongside today's `roles` — **additive, nothing removed**.
- **IAM-04** Cerbos compat shim + permission derived roles. Policies may match either a role name
  (legacy) or a permission (new). Both paths must pass the existing suite unchanged.
- **IAM-05** The public check API: `can(permission, scope)` server-side, and the matching
  `platform-ui/src/lib/rbac.ts` mirror generated **from** the catalog rather than hand-written.
- **IAM-06** Test personas + fixtures: superadmin, owner, company_admin, dept head, HR, IT, member,
  viewer, client. Published so PM and Web Dev can test permission-gated behaviour deterministically.
- **IAM-07** Contract doc + drift test. A test that fails if the catalog, the Cerbos policies, and
  the UI mirror disagree.

**Exit criteria:** full existing test suite green; Web Dev and PM have a written contract, a check
API, and personas; no consumer-visible change after this phase.

### Phase 2 — Org scope and positions (Hierarchy consolidation: HIER-1..3)

**Scope change:** Phase 2 **replaces** the vestigial `team` hierarchy with `org_unit`. Investigation
(`2026-08-10-hierarchy-consolidation.md`) confirmed `team` is unused (0 rows; 0 grants; 0 storable
`team_lead` reach outside the `team` resource itself) and is the sole driver of the IAM-04 rollout's
70% hazard rate — specifically, 22 of 40 HAZARDOUS kinds are dead-grant suspects rooted in `team_lead`
alone. Retiring `team` and `record` (equally vestigial) is **the measured payoff**: converts 17 kinds
to SAFE, drops hazard rate to 39%, and **eliminates the entire expensive dead-grant mitigation class**
(rollout batches 4–7 dissolve). Sequencing mandates HIER-1/2/3 BEFORE IAM-04-ROLLOUT batches 4–7.
Detailed specifications in `2026-08-10-iam-hier-01-plan.md` (HIER-1 through HIER-5).

- **IAM-08** (`HIER-1 absorption`): Replace `team` and `record` scope types with `org_unit` (DR-10).
  Widens `user_roles.scope_id` `uuid` → `text` to store org-unit node IDs (DR-8), guarded by
  per-scope shape CHECK. Count-asserts zero `team`/`record` grants pre-drop.
- **IAM-09** (`HIER-2 dependency`): Org-unit closure table, keyed on text node IDs, indexed for
  ancestry-list queries. Maintained from JSON blob on every org PUT. **Load-bearing for
  `org_unit_lead` cascade:** `org_unit_lead` grants match any unit in the resource's computed
  ancestry list, cascading down the subtree fail-closed.
- **IAM-10** (`HIER-2 mechanism`): `org_unit_lead` derived role — scoped, attribute-dependent,
  matches any ancestor of the resource (computed from IAM-09's closure table). Binding authoring
  rule: **own-rule only, never mixed with scope-only roles.** Replaces `team_lead`. Cerbos
  restarted.
- **IAM-11** `positions` table (unit, title, role set, headcount) + link from
  `org_unit_memberships`.
- **IAM-12** Position reconciler — placement grants, transfer revokes+regrants. Model on
  `service-reconciler.ts`; reuse the `managed_by` invariant so reconciler-owned grants are never
  hand-editable.

### Phase 3 — Elevated tiers and safeguards

- **IAM-13** Collapse `platform_admin`/`superadmin` (D-6); make it appointable.
- **IAM-14** Introduce `owner` (D-8) with its exact envelope: all business + company-local role
  authoring in owned companies; **denied** platform/system controls.
- **IAM-15** Remove `group_executive` (D-7) — policy sweep across ~60 files, `rbac.ts`, seeds, and
  migration of existing holders to named company roles.
- **IAM-16** Two-person rule (D-9): elevated appointment requires 1 superadmin + 1 owner.
- **IAM-17** No self-escalation invariant + test. Nobody widens their own access, at any tier.
- **IAM-18** Step-up wiring for sensitive actions; immutable audit + alert on every elevated action.

### Phase 4 — Role authoring UI

- **IAM-19** Global role library (superadmin) — compose permissions into named roles.
- **IAM-20** Company-local role authoring (company_admin/owner), ceiling-enforced against the
  company's entitled permission set.
- **IAM-21** Assignment UI: assign library roles to positions and people, scoped.
- **IAM-22** Override request + routed approval (D-10) with the permission→approver routing table;
  time-boxed, expiring, audited.

### Phase 5 — HR: the people file

- **IAM-23** `employee` record (D-4): hire date, employment status, position, reporting line,
  separate from `users`.
- **IAM-24** HR console: hire / transfer / promote / terminate, driving positions.
- **IAM-25** Backfill existing staff from `company_memberships` + `org_unit_memberships`.

### Phase 6 — IT: accounts and logins

- **IAM-26** IT console over the existing `gaiada-provisioner` Keycloak client: create/disable
  logins, MFA, credential reset.
- **IAM-27** Joiner/mover/leaver flow: HR event → IT fulfilment task → provisioning → access
  follows position automatically.
- **IAM-28** Close the ~40-user login gap; reconcile `users` rows against Keycloak accounts.
- **IAM-29** Leaver path: disable login, bump `session_version` (D11 revocation), revoke grants,
  retain the employment record.

### Phase 7 — Migration and decommission

- **IAM-30** Migrate all ~60 Cerbos policies from role-name to permission matching.
- **IAM-31** Remove the compat shim; role names become display labels only.
- **IAM-32** Full authz parity + adversarial suite; RLS sweep over every new table.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| The Cerbos rewrite (D-2) silently widens access | Compat shim + parity suite: every existing policy decision must be identical pre/post, asserted per policy. |
| `owner` is over-powered and used by non-technical people | Envelope denied-by-default for platform controls; step-up on destructive actions; alert on every elevated action. |
| Removing `group_executive` breaks live access | Migrate holders to named company roles **before** deleting the role; the drift test (IAM-07) catches orphaned policy references. |
| Position reconciler mass-revokes on an org edit | Reuse the `managed_by` invariant and the service-reconciler's proven suspend-don't-delete semantics; dry-run diff before apply. |
| Phase 1 contract still churns, re-blocking consumers | The catalog is reviewed and frozen once; additions are additive-only, removals require an owner decision. |
| Org JSON blob and relational anchors drift | Closure table rebuilt transactionally on every org PUT; reconciliation test. |

---

## 6. Open items (not blocking Phase 1)

- Which permissions are "sensitive" for step-up and for D-10 routing — needs a pass with HR/finance.
- Whether `owner` at the **holding** level implies every current and future company automatically,
  or an explicit per-company grant list.
- Whether client portal permissions join the same catalog or stay a separate vocabulary
  (recommendation: same catalog, `portal.*` prefix, but no shared roles).
- Bot/agent principals stay `users` rows per the existing `principal-kinds` decision — revisit only
  if the agent-attribution work forces it.
