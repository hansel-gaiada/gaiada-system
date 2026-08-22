# IAM Phase 3 — readiness assessment (2026-08-22)

Owner asked for Phase 3 next. This is what reading the code (not the docs) established before starting
it, because three of its four tickets turn out to be blocked, already satisfied, or in direct conflict
with work that landed today. Every claim below was checked against source or the live estate; none of
it is inferred from the design documents.

**Conclusion up front: Phase 3 cannot be started at its stated scope.** Its root dependency is not a
scheduling preference — it is an arithmetic fact about the live estate plus a dependency the Phase 2
design states about itself. The unblock order is at the end.

---

## The four tickets, as they actually stand

### IAM-13 — collapse `platform_admin` / `superadmin` (D-6) · **already a no-op**

There is **no separate `superadmin` role**. The only occurrence in the estate is a seed *variable*
name (`src/seed/agency.ts`: `superadmin: await ensureUser("hansel@gaiada.com", …)`), which is then
granted `platform_admin`. Nothing in `permission-catalog.json`, the Cerbos policies, or `roles`
defines a second elevated platform tier.

So D-6's "collapse" has nothing to collapse. Its remaining substance is the *other* half of the
sentence — "it is **appointable**" — which is IAM-16, below.

### IAM-14 — introduce `owner` (D-8) · **blocked by the Phase 2 design's own words**

Phase 2 design §10: `owner` is a "zero policy rules, exclusion-generated bundle — per IAM-04c it
**hard-depends on perm-arm coverage of its envelope, which is still partial**".

That is a real dependency, not caution: an exclusion-generated bundle is defined by what it does NOT
include, so a partial permission-arm means the generated envelope is silently wrong rather than
visibly incomplete. `owner` is also described as "the highest-risk role in the system — real,
non-technical people". Generating its envelope from incomplete data is the worst combination of those
two facts.

Perm-arm completion is tracked as Phase 7, on its own register.

### IAM-15 — remove `group_executive` (D-7) · **151 files, and it would delete today's work**

Measured, not estimated:

| | count |
|---|---|
| Cerbos policy files naming `group_executive` | **64** |
| TypeScript files naming it | **87** |

The program doc calls this a "~39-rule sweep" and elsewhere "~60 policies"; the real footprint is
larger than either.

⚠ **It also directly undoes MON-00c.** Today's work root-bounded `group_executive` behind
`variables.inRoot` across ~40 policies, and I re-anchored **19 test files** around that change
(`4fa397f`, `d9bd1e6`, `27e9b49`, `81e81c3`, `4e10257`, `3973f3b`). Removing the role deletes all of
it. That is not an argument against removal — D-7's reasoning ("the last unrestricted cross-company
business role") still stands, and root-bounding was always interim protection. It IS an argument for
sequencing: doing removal now means the root-bounding work was wasted, and doing it last means the
estate is protected in the meantime either way.

### IAM-16 — two-person appointment (D-9) · **the real blocker, and it is arithmetic**

This is the one genuinely unstarted, tractable-looking ticket. It is not tractable yet, and the
reason is worth stating precisely.

**The door it must close is open BY DESIGN, and the code says so.** `grant-write.service.ts`'s
elevated fence binds the `ui` origin only:

> ⚠ This fence binds the `ui` origin ONLY. Design §6.3.6 is explicit that the existing
> global-scope-guarded admin path REMAINS a door to the elevated tier until IAM-16's two-person
> appointment flow exists.

`global-only-role-scope.test.ts` pins that door open on purpose ("still permits an elevated role at
GLOBAL scope"). So IAM-16 = build the two-person path, then close `legacy_admin` for elevated roles
and flip that pin.

**Why it cannot be done yet.** D-9 specifies the pair as **1 superadmin + 1 owner**. The live estate:

| role | holders |
|---|---|
| `platform_admin` | **1** |
| `group_executive` | 1 |
| `owner` | role does not exist |

A rule requiring two distinct elevated deciders cannot be satisfied by one `platform_admin` and no
`owner`. Closing the legacy door today would make appointing a *second* `platform_admin` impossible —
bricking the exact flow the rule exists to protect, and with no way out except a seed run against
production.

The Phase 2 design anticipated precisely this for the related MFA item: "`assurance:"high"` is
currently unreachable live anyway; gating Phase-2 flows on it **would brick the owner**". The same
shape of mistake is available here.

**What IS already built** (Phase 2, and it should not be rebuilt): the override machinery with a
structural requester ≠ decider DENY (`iam-approval-execute.ts`, `override-request-decide.test.ts`),
the self-target refusal (D-9's "no self-escalation"), and the elevated fence itself. IAM-16 needs a
new *origin* the fence permits only on proof of an approved two-person appointment — not new
approval plumbing.

---

## Recommended order

1. **Phase 7 perm-arm coverage** — the only true root blocker. Unblocks `owner`.
2. **IAM-14 `owner`** — once its envelope can be generated from complete data.
3. **IAM-16 two-person appointment** — satisfiable once a second elevated principal class exists;
   then close the `legacy_admin` door and flip `global-only-role-scope.test.ts`'s pin.
4. **IAM-15 `group_executive` removal LAST** — so MON-00c's root-bounding protects the estate for as
   long as the role exists, and the 151-file sweep happens once.

**IAM-13 needs no ticket** beyond a note that D-6 is satisfied: record that the estate has exactly one
elevated platform role, and that appointability is IAM-16's remit.

## What was NOT done, and why

No code was changed for Phase 3. Building `owner` against a dependency its own design calls partial,
or closing an appointment door that would leave one person unable to appoint anyone, would both be
worse than reporting. The 151-file `group_executive` sweep was not started because doing it before
IAM-16 discards today's protection for no gain.
