# `inRoot` after IAM-15 — owner ruling: accept the reduction

**Status: RULED (owner, 2026-08-24). No code change.** Recorded because the change was a
side-effect of another ticket rather than a decision anyone made, and a reduction in defence-in-depth
that nobody wrote down is indistinguishable from one nobody noticed.

## What changed, and it was not intended

MON-00c introduced `variables.inRoot` to bound cross-company reach to the caller's own root company
tree. Its principal consumer was `group_executive` — the one role whose rules were gated on `inRoot`
**alone**, with no `inTenant`, because a global exec has no `company_memberships` rows for `inTenant`
to match against.

IAM-15 (D-7) deleted that role and its 54 rules. The measurement afterwards:

| shape | live rules |
|---|---|
| `inRoot` as the **sole** gate | **1** — `resource_rollup.yaml`'s `perm_rollup_read` |
| `inTenant && notLow && inRoot` | 195 |

So for every surface except rollups, the root boundary is no longer independently enforced at the
PDP: a request that fails `inRoot` would already have failed `inTenant`. `inRoot` is still evaluated
195 times, but as a redundant conjunct rather than a distinct wall.

## Why this is acceptable

**Two independent walls still stand, and they fail differently.**

1. **Cerbos `inTenant`** — membership-derived. A principal cannot be authorized for a company it
   holds no grant in.
2. **`withTenants` / `CrossRootTenantSetError`** (MON-00b, Wall 1) — refuses a tenant SET that spans
   two root trees before any query runs, in code that every tenant-scoped read passes through.
   Plus Postgres FORCE RLS underneath it.

The lost property is specifically "the PDP would refuse a cross-root request even if membership said
yes". That combination — a principal holding memberships in two roots — is what MON-00b exists to
make impossible, and it is impossible: an attempt to construct that fixture during IAM-15 failed for
exactly that reason (recorded in `cross-root-boundary.db.test.ts`).

So the removed wall guarded a state the DB wall does not permit to exist. Defence-in-depth is thinner;
the reachable attack surface is unchanged.

## What is deliberately NOT done

- **No audit of the 195 `inTenant && inRoot` rules.** Dropping `inRoot` from them would be a real
  weakening; adding sole-`inRoot` rules would invent reach nobody asked for. They stay as they are.
- **No new role to "replace" the exec.** That was D-7's whole point.

## What would reopen this

Any of these should bring the ruling back for review rather than being absorbed quietly:

* A principal legitimately holding memberships across two roots — i.e. relaxing MON-00b. The DB wall
  is currently doing the work the PDP used to duplicate, so weakening it is not a local change.
* A new **global-scope** role or permission arm whose rules omit `inTenant` (the shape
  `group_executive` had). Such a rule needs `inRoot` as a sole gate, and `perm_rollup_read` is the
  only current precedent to copy.
* A cross-root feature — an operator console, group reporting — since the first thing it will want is
  exactly the reach this boundary refuses.

## Provenance

Found while completing IAM-15, not by an audit: the sweep left `cross-root-boundary.db.test.ts`
unable to isolate `inRoot` with a membership-less principal, which is what prompted the count.
`cerbos compile` clean; the suite records the loss of precision in its own fixture comments rather
than asserting a property it can no longer isolate.
