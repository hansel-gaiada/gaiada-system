# IAM-01a / IAM-02a — evidence and rulings needed

**Status:** ANALYSIS + **RULINGS DECIDED by the owner 2026-08-10**. Measured from source.

> **Decided:** Ruling 1 = **C, two-layer** (215 fine-grained enforcement primitives + curated UI
> permission groups). Ruling 2 = **`<domain>.<resource>.<action>`** dotted. Ruling 3 = **catalog
> boundary 215**, with 15 relationship-granted / bypass-exempt pairs that no role — including
> `owner` — may ever hold. Ruling 4 = **check live holders first** (IAM-02a-0) before touching the
> `group_executive` mirror. Ruling 5 = **per-module seeded roles with explicit bundles**; string
> composition is retired.
**Parent:** `2026-08-10-iam-phase1-tickets.md`.

Everything below is counted from `cerbos/policies/*.yaml`, `src/modules/*/index.ts`, and
`platform-ui/src/lib/rbac.ts` — not estimated. Two findings were verified by reading the raw policy
files after the parser reported them, because both were surprising.

---

## Part 1 — The three surfaces, measured

| Surface | Size | Granularity | Status |
|---|---|---|---|
| **Cerbos policies** | **230** concrete `(kind, action)` pairs, 61 kinds | fine | **the enforcement truth** |
| **`ModuleContract.permissions`** | **54** keys, 12 modules, all colon-style | mixed | declared, **zero consumers** |
| **`rbac.ts` `CAPABILITIES`** | **~40** capabilities | coarse | hand-written UI mirror |

The 54 module-declared keys are **not** a subset of the 230 Cerbos pairs. Several have no Cerbos
resource at all — `search:rank:read`, `search:content:publish`, `it:discovery:report`,
`assistant:handoff` — while most of the 230 pairs have no module declaration. So the existing
declarations are a **starting vocabulary, not a catalog**, and they cannot simply be adopted.

---

## Part 2 — Finding A: superadmin is deliberately NOT omnipotent

`platform_admin` reaches **215 of 230** pairs. The 15 it cannot reach:

| Kind | Actions it cannot reach |
|---|---|
| `assistant_thread` | all 9 (`create` `read` `update` `delete` `message` `stream` `stop` `handoff` `confirm_write`) |
| `assistant_memory` | `list` `propose` `confirm` `delete` |
| `mcp_tool` | `call` |
| `agent_run` | `read` |

**This is intentional and documented.** `resource_assistant_thread.yaml` omits the wildcard rule on
purpose, and says so at length:

> "DELIBERATELY: there is NO `company_admin` / `group_executive` / `platform_admin` rule below. This
> is the ONE resource policy in this repo that must NOT open with the wildcard `derivedRoles:
> ["platform_admin"]` allow-all rule … note its ABSENCE here is intentional, not a gap someone should
> 'restore for consistency'. Admin access to someone's private assistant thread is a separate,
> audited feature that is deliberately absent in v1."

Those actions are granted to the **base role `user`** under an `owns` condition
(`resource.attr.ownerId == principal.id`), which fails closed if a handler forgets to pass `ownerId`.

**Two consequences:**

1. **The catalog boundary has a natural definition:** the role-grantable permission set is exactly
   what superadmin can reach — **215**, not 230. The other 15 are *relationship-granted*
   (you get them by owning the thing), never role-granted.
2. `rbac.ts` declares `platform_admin: ALL`, which is an **over-claim** in the mirror. More
   importantly, the new **`owner` role (D-8) must inherit this exemption** — "everything business"
   must not quietly include reading employees' private assistant transcripts. This is a decision the
   owner envelope has to state explicitly, and today's policies already set the precedent.

---

## Part 3 — Finding B: `group_executive` is far weaker than the UI claims

`rbac.ts` declares `group_executive: ALL` (~40 capabilities). Cerbos grants it **118 of 230** pairs
across **35 of 61** kinds. Verified directly — `resource_project.yaml`'s wildcard rule lists
`derivedRoles: ["platform_admin"]` only; `group_executive` does not appear in the file.

A principal holding **only** a `group_executive` grant therefore cannot touch:

`project` · `task` · `client` · `deliverable` · `time_entry` · `file` · `comment` · `user` · `team` ·
`custom_field` · `hr_record` · `meeting_recording` · `notification` · `portal` · `agency_*` ·
`chat_group` · `identity_link` · `member` — **34 kinds**, CRUD included.

It also holds **zero** pairs that `platform_admin` lacks: it is a strict, much smaller subset.

**And `company_admin` (199/230) is materially STRONGER than `group_executive` (118/230)** — the
higher business tier is the weaker one in enforcement.

The drift direction is **UI over-claims, server refuses**: an owner sees every button and gets a 403
on roughly half. That is the safe direction (a visible refusal, never a silent one) but a poor owner
experience — and it is strong independent evidence that **D-7 (delete `group_executive`) is correct**.

⚠ **Unknown that must be checked before acting:** in practice, owner accounts probably also hold
`platform_admin`, which would mask this entirely. Whether anyone holds `group_executive` *alone* is a
live-data question — see IAM-02a-0 below.

---

## Part 4 — Finding C: role bundles are not a clean hierarchy

Effective coverage after expanding wildcards, per derived role:

| Derived role | Pairs (of 230) | Kinds (of 61) |
|---|---|---|
| `platform_admin` | 215 | 57 |
| `company_admin` | 199 | 55 |
| `group_executive` | 118 | 35 |
| `manager` | 109 | 41 |
| `member` | 74 | — |
| `team_lead` | 60 | — |
| `module_manager` | 56 | — |
| `module_staff` | 34 | — |
| `viewer` | 30 | — |
| `client` | 6 | — |
| `hr_people_ops` / `hr_people_reader` | 5 / 5 | — |
| `it_staff` | 3 | — |
| `module_approver` | 1 | — |

`viewer` holding 30 pairs is worth review during bundling — `rbac.ts` already documents that
`resource_pm_task.yaml` lets a viewer `update` a task exactly like a member.

---

## Part 5 — Finding D: `module_staff` / `module_manager` are string-composed

`derived_roles.yaml` composes the role name from the resource: `g.role == (resource.attr.module +
"_staff")`. One derived-role pair therefore serves `hr_*`, `search_*`, `reports_*` and any future
module — 26 + 14 rule usages.

Under permission-based authz this trick **does not survive as-is**: a permission is a concrete key,
so `<module>_staff` must resolve to a concrete bundle. Options are in Ruling 5 below. Note the
platform already seeds these roles per-module (migrations 0026, 0069, 0072), and
`service-reconciler.ts` no-ops on an unseeded module role — so per-module seeding is the existing
reality, and string composition is buying less than it appears.

---

## Part 6 — Rulings required

### Ruling 1 (IAM-01a) — what a "permission" IS

| Option | Enforcement | Authoring UX |
|---|---|---|
| **A. Flat fine-grained** — permission == Cerbos `(kind, action)`, 215 of them | 1:1, drift impossible | 215 checkboxes; unusable for HR/dept heads |
| **B. Coarse only** — ~40 capabilities as today | needs a mapping layer; **mapping is where drift lives** | pleasant, but cannot grant read-without-write |
| **C. Two-layer (RECOMMENDED)** — 215 fine-grained permissions are the enforcement primitive; curated **permission groups** are what the UI shows, with "advanced" expansion | 1:1, drift impossible | groups for everyday authoring, full control when needed |

Option C is what AWS IAM (actions + managed policies) and Google IAM (permissions + roles) both
settled on, for the same reason. It also means today's ~40 capabilities are **not thrown away** —
they become the first set of permission groups.

### Ruling 2 (IAM-01a) — key format

Recommended: **`<domain>.<resource>.<action>`**, dotted.

- `pm.task.update`, `hr.record.export`, `search.property.update`, `core.project.read`
- `domain` for the ~20 non-module core kinds (`project`, `task`, `user`, `company`, `team`, `file`,
  `comment`, …) = `core`.
- Normalizes the odd `resource_search_*` kind prefix away — the Cerbos kind stays
  `resource_search_property`, the permission is `search.property.update`. The mapping table carries
  the ugliness so the catalog does not.
- Migrates the 54 colon-style module declarations to the same format (IAM-01d).

> **Amendment (DR-4, owner decision, 2026-08-10):** `portal` is an owner-decided exception to the
> `core` default above. Literal application of this ruling gave `core.portal.*` (portal has no
> module prefix, so N4 puts it under `core`); the owner has since decided it becomes its own
> top-level domain, `portal.*`, instead. Reasoning: the client portal is a separate trust surface
> with its own route group and shell (see `client-side-separate-interface` in program memory), so
> it warrants its own domain rather than being folded into `core` alongside unrelated internal
> kinds. This is a deliberate, owner-sighted amendment to Ruling 2 for this one kind — it does not
> reopen the `core` default for the other ~31 non-module kinds. See
> `2026-08-10-permission-catalog.md` §8 J2 for the settled catalog-level record.

### Ruling 3 (IAM-01a) — the catalog boundary and permission classes

Three classes, so the 15 exempt pairs are modelled rather than forgotten:

| Class | Count | Meaning |
|---|---|---|
| **role-grantable** | 215 | in the catalog; assignable to roles |
| **relationship-granted** | 15 | `assistant_thread`, `assistant_memory`, `mcp_tool:call`, `agent_run:read` — held by owning the resource, never by role. **Not in the catalog.** |
| **bypass-exempt** | same 15 | no wildcard, no superadmin, **and no `owner`** |

⚠ `mcp_tool:call` and `agent_run:read` are grouped here because they share superadmin's exemption,
but only the assistant policies carry a written rationale. Both need a one-line verification that
their exemption is deliberate before the catalog is frozen.

### Ruling 4 (IAM-02a) — handling the `group_executive` over-claim in Phase 1

Phase 1's contract is "zero authorization decisions change". Correcting the mirror is a **UI** change,
not an authz change — but it is user-visible, and it would strip the owner's buttons **before** the
replacement `owner` role exists in Phase 3.

| Option | Effect |
|---|---|
| **a. Check live holders first, then decide (RECOMMENDED)** | New ticket **IAM-02a-0**: query the live box for who holds `group_executive`, and whether they also hold `platform_admin`. If everyone holds both, the over-claim is inert and correcting the mirror is free. If anyone holds it alone, defer to Phase 3. **Cheap, and it converts a guess into a fact.** |
| b. Correct the mirror now | Honest bundles immediately; risks removing the owner's UI before `owner` exists |
| c. Defer entirely to Phase 3 | Zero risk now; Phase 1 ships a bundle everyone knows is wrong, pinned by a test |

### Ruling 5 (IAM-02a) — `module_staff` / `module_manager` under permissions

| Option | Effect |
|---|---|
| **a. Per-module seeded roles with real bundles (RECOMMENDED)** | `hr_staff`, `search_staff`, `reports_staff` each become ordinary roles with explicit permission bundles. String composition disappears. A new module seeds its own roles — which migrations 0026/0069/0072 already do. Explicit, inspectable, and each module's tier can differ where it should. |
| b. Keep string composition alongside permissions | Preserves the WSD-2 trick and the reconciler's `<module>_staff` materialization untouched, but the permission model then has a second, magic grant path — exactly the dual-truth problem this program exists to remove. |

⚠ Either way, `service-reconciler.ts` materializes `<module>_staff` grants onto **served** companies.
Whatever is chosen must keep working for service assignments, and the `managed_by` invariant must
still hold. This is the highest-risk integration point in the bundling work.

---

## Part 7 — Ticket changes falling out of this

- **NEW — IAM-02a-0** (J, no deps): live-data check of `group_executive` / `platform_admin` holders.
  Blocks Ruling 4. Do this first; it is a single query.
- **NEW — IAM-01b-2** (M): verify the exemption rationale for `mcp_tool:call` and `agent_run:read`
  before freezing the catalog boundary at 215.
- **IAM-01b amended**: catalog is **215**, not ~230, and ships the three-class marking.
- **IAM-02a amended**: bundles are derived from *expanded* wildcard coverage; the parity suite
  (IAM-02b) must assert against the 230-pair matrix including the 15 exempt pairs, so a future change
  that "restores consistency" on the assistant policies fails loudly.
- **IAM-04c strengthened**: the bypass ruling now has a documented precedent to follow, and must
  state the `owner` role's exemption explicitly (Phase 3 depends on it).
