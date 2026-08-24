# `integration_connection` — the company-tier key split

**Status: RULED (owner, 2026-08-24) → Design A. SHIPPED as IAM-14c.** The analysis below is kept
verbatim, because the reasoning for rejecting the cheap shape is the part worth re-reading. What
actually got built is recorded in the addendum at the end.

## The gap, precisely

`integration_connection` guards an at-rest credential vault (connection secrets by reference). Its
policy has three tiers:

| tier | who | reach | condition |
|---|---|---|---|
| wildcard | `platform_admin` | everything | — |
| **company** | `company_admin`, `manager` | ANY row in the tenant, incl. company-owned and other users' | `inTenant && notLow` |
| self | `member`, `viewer` | strictly their OWN row | `inTenant && notLow && owns` |

IAM-14b (2026-08-22) added a permission arm for the **self** tier only. The company tier is
deliberately unmirrored, and the reason is measured, not cautious:

> member and viewer hold all four keys (`core.integration_connection.{read,create,update,delete}`),
> so an unconditional mirror would hand every member the company's whole credential vault.

That is the Pattern-B over-grant IAM-04-B5 refused. It is still the right refusal.

**The cost of that refusal:** `owner` is permission-native (IAM-04c §3 — zero Cerbos rules), so it
reaches this kind ONLY through the perm arm. Today that means an owner can manage their own
connections and nothing else — they cannot see or rotate the company's integrations for a company
they own. That is the actual gap; it is not that member/viewer are over-granted.

## Why the cheap fix is illegal here

The obvious shape is a second key per action — `…read_any` alongside `…read` — both mapping to the
same Cerbos action, with the derived role carrying the scope distinction.

**The catalog forbids it.** Measured across all 301 entries: **zero** grantable keys share a
`(cerbosKind, cerbosAction)` pair. The mapping is 1:1 by convention, and
`cerbos-catalog-alignment.test.ts` builds `catalogPairs` as a Set of `kind::action` — duplicates
would silently collapse — while also requiring every catalog entry's `cerbosAction` to appear as a
literal in that kind's policy (its `orphanEntries` check).

So a scope-suffixed key is not expressible without weakening the alignment suite, which is the
machinery that keeps the DB catalog, the Cerbos policy and each module's declared permissions in
agreement. Not worth trading for this.

## The two viable shapes

### A — a real `manage` action  ← recommended

Add `manage` as a genuine Cerbos action on the kind, catalogued as
`core.integration_connection.manage` (grantable, **sensitive: true**, uiGrantable: true), held by
`company_admin` / `manager` / `platform_admin` / `owner` and **not** by `member` / `viewer`. The
company-wide endpoints authorize `manage` instead of the per-row action.

* Honest: "administer the company's connections" genuinely is a different capability from "manage my
  own", and the catalog says so in one key rather than four.
* Keeps the 1:1 invariant and the alignment suite intact.
* Gives `owner` the company tier through the perm arm, which is the whole point.
* **Cost:** a controller/API change — the company-wide list and edit paths must call `manage`. That
  is a real change to a live surface, and it is why this is a decision rather than a chore.

⚠ It also needs a migration adding the key to `owner`'s bundle explicitly. IAM-14 seeded
`owner = company_admin` with a one-time `INSERT..SELECT`; a key added to `company_admin` later does
**not** propagate, and `owner-role.db.test.ts` asserts the two sets are equal — so a migration that
forgets `owner` turns that suite red.

### B — leave it, and give `owner` a role-arm rule

Drop the "owner has zero Cerbos rules" property for this one kind and add `owner` to the existing
company-tier rule.

* Much smaller: one policy line, no catalog change, no API change.
* **But it breaks the design principle IAM-04c set** — `owner` being permission-native is what makes
  its reach auditable from `role_permissions` alone. One exception invites the next.
* And it fixes only `owner`. Any future permission-native role hits the same wall.

## Recommendation

**A**, and treat the API change as the substance of the ticket rather than an inconvenience. The
credential vault is exactly the kind where "administer the company's" deserves its own nameable,
grantable, revocable permission instead of being an emergent property of holding four per-row keys.

If the API change is unwelcome right now, **B is a defensible stopgap** — but it should be written
down as an exception with an expiry, not as the design.

## What I did NOT do

No code, no migration, no catalog edit. A frozen contract (`docs/PERMISSION-CONTRACT.md`) plus the
credential-vault kind plus an API change is not a combination to land unattended on an owner's
behalf, and the analysis above is worth more than a half-built version of the wrong shape.


---

# ADDENDUM — what shipped (IAM-14c, 2026-08-24)

**Design A, as recommended.** `core.integration_connection.manage` is a real Cerbos action with its
own catalog key, `sensitive: true`, held by `company_admin` / `manager` / `platform_admin` / `owner`
and by **neither `member` nor `viewer`**.

**Additive, deliberately.** The four per-row rules were left byte-identical, so a `company_admin`
acting on their own row still authorizes `read`/`update` and still matches the original rule. Nothing
that worked stopped working — verified by `integrations.test.ts` and `claude-seats.test.ts` passing
unchanged (27/27).

**The behavioural half was larger than this doc anticipated, in one way that matters.** The plan said
"the company-wide endpoints authorize `manage`". There *are* no company-wide endpoints: the same four
endpoints serve both tiers, distinguished only by the `ownerId` handed to Cerbos. So the split is
expressed as one shared helper —

```ts
connectionAction(perRowAction, authCerbosOwnerId, me)   // own row → per-row action; else → "manage"
```

— applied at all 11 authorize sites across **both** controllers (`integrations` and `claude-seats`,
which reuses the kind verbatim). Without that caller change the new key would have been dead config
that looked like a fix: `owner` reaches this kind only through the perm arm, so nothing would have
improved for it.

**Live PDP probes, before/after the change (the decisions, not the rules):**

| principal | row | action | result |
|---|---|---|---|
| `manage` key only (owner's shape) | company-owned | `manage` | ALLOW ← the gap closed |
| four old keys only (member's shape) | company-owned | `manage` | DENY ← no over-grant |
| four old keys only | own | `read` | ALLOW ← self tier untouched |
| `company_admin` role | company-owned | `manage` | ALLOW ← role arm intact |
| `member` role | company-owned | `manage` | DENY |
| `company_admin` role | own | `read` | ALLOW ← unchanged |

**The `owner` mirror was the trap this doc flagged, and it was real.** IAM-14 seeded
`owner = company_admin` as a one-time `INSERT..SELECT`; keys added later do not propagate, and
`owner-role.db.test.ts` asserts the two bundles are equal. The migration mirrors it explicitly and
self-checks that it did, plus asserts that `member`/`viewer`/`client` hold the key ZERO times — the
one assertion that keeps the unconditional perm-arm mirror safe.

**Catalog bookkeeping that adding a key requires** (all four are tripwires that fire deliberately):
`_meta.counts` in `permission-catalog.json`; membership of a permission group (`integrations_manage`,
already sensitive) plus that file's own `_meta`; and three hardcoded "sanity" count pins across
`cerbos-catalog-alignment`, `permission-groups-catalog-parity` and `ui-grantable-catalog`.

**Gates:** `iam-14c-integration-connection-manage.test.ts` 9/9 against live Cerbos; `src/rbac`
754/754; the two controller suites 27/27 unchanged; `cerbos compile` clean; `lint:migration-rls`
clean; the 1:1 `(cerbosKind, cerbosAction)` invariant still holds at zero duplicates.
