# `integration_connection` — the company-tier key split

**Status: BLOCKED ON AN OWNER DECISION.** No code changed. This is the analysis, the two viable
shapes, and a recommendation — written so the decision is a five-minute read rather than a
re-investigation.

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
