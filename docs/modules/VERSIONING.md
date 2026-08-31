# Gaiada — Versioning

Two levels, deliberately different, because they answer different questions:

| Level | Format | Answers |
|---|---|---|
| **Module** | `0.7.0` (semver) | "what changed in *this* component?" |
| **App** | `Alpha 01.001.0001a` | "what is *deployed*, and which module set is it?" |

Module versions already live in [`MODULES.md`](./MODULES.md); per-module history is in
[`CHANGELOG.md`](./CHANGELOG.md). This document defines the **app** version that sits on top,
and the rules for moving both.

The current app version is in [`/VERSION`](../../VERSION) at the repo root — one line, nothing else,
so scripts and Dockerfiles can read it without parsing markdown.

---

## App version format — SemVer 2.0.0

**Ruling (2026-08-31): the app version is [Semantic Versioning 2.0.0](https://semver.org), with the
stage as a pre-release identifier.** The modules already use SemVer; this makes the app agree with
them and with every tool that reads a version.

```
/VERSION   1.0.0-alpha.302
tag        v1.0.0-alpha.302
            │ │ │  │      │
            │ │ │  │      └─ pre-release counter — +1 on every cut, never reused
            │ │ │  └──────── stage: alpha -> beta -> rc -> (none)
            │ │ └─────────── PATCH
            │ └───────────── MINOR
            └─────────────── MAJOR
```

The stage ladder needs no rules of its own — SemVer's precedence gives it for free:

```
1.0.0-alpha.302  <  1.0.0-beta.1  <  1.0.0-rc.1  <  1.0.0
```

...because a pre-release always sorts below the release it precedes, alphanumeric identifiers
compare alphabetically (`alpha` < `beta` < `rc`) and numeric ones numerically. "Which build is
newer?" is answerable by any SemVer library, by `sort -V`, and by every package manager — instead of
by reading a bespoke table.

### What this replaces, and why

The previous format was `Alpha 01.071.0301a` — stage, milestone, *app release counter*,
*module-reference counter*, revision letter. Two of those fields were fiction:

| Old field | Documented rule | What actually happened |
|---|---|---|
| app release counter | "+1 for every app version cut" | **frozen at `071` for 65 consecutive cuts** |
| module-reference counter | derived: advance by the number of module bumps | **+1 per release regardless** — 33 cuts moved *no* module, 13 moved several |
| revision letter | `a → b → c` for a re-cut of the same module set | used twice in 149 tags |

So the third field was already a plain monotonic release counter and the second was dead. Rather
than rule one of two fictions authoritative, both are retired: `1.0.0-alpha.N` keeps exactly the one
counter that was really in use, and gets ordering, tooling and comparability as a side effect.

A *derived* counter was the deeper mistake. It made the version a function of bookkeeping that
nobody maintained (the App release log went 69 cuts without an entry), so it silently degraded into
a counter anyway. A version should be cheap to produce correctly.

### Migration

Continuity is preserved: legacy `…0301a` was the last of the old line, and the first SemVer cut is
`1.0.0-alpha.302`. The counter never restarts and no number is reused, so builds stay comparable
across the cutover.

`deploy.yml` accepts **both** spellings during the transition — several sessions cut releases here
concurrently and one may have a legacy-format release in flight; a hard switch would fail *their*
deploy on a tag they pushed correctly. Drop the legacy branch once none can still be in flight.

MAJOR/MINOR/PATCH stay at `1.0.0` until the first non-alpha cut; moving to Beta is
`1.0.0-beta.1`, and the first production release is `1.0.0`. That also settles the old
"production stage name" open question below — there is no production stage *name*, there is simply
the absence of a pre-release identifier.

---

## Rules

1. **Every notable module change bumps that module's version** in `MODULES.md` **and** adds a
   `CHANGELOG.md` entry. This rule already existed; the app version depends on it being followed.
2. **Every app version records its module manifest** — the exact version of all 14 modules — in
   the App release log in `CHANGELOG.md`. Without the manifest the app version is just a number;
   with it, any deployed build is fully reconstructible.
3. **The app version does not encode how much changed.** *(Rewritten 2026-08-31 — this rule used to
   say a release's size should show in the module-reference counter. It never did: 33 cuts moved no
   module at all and still advanced it.)* Scale of change is what `CHANGELOG.md` and the module
   SemVer numbers are for. The app version answers one question — **which build is this, and is it
   newer than that one** — and answers it for machines as well as people.
4. **The deployed tag is the app version with a `v`.** `1.0.0-alpha.302` → `v1.0.0-alpha.302`.
   Tags are immutable here: never move a pushed tag, cut the next version instead.
5. **`/VERSION` is the single source.** CI reads it; the running app reports it. If they disagree,
   the running app is wrong and the deploy is suspect.
6. **Never pick the number by hand.** Run `node scripts/next-version.mjs`; it derives the next free
   version from the **tags**. See "Cutting a release" below for why.

---

## Cutting a release

```sh
node scripts/next-version.mjs          # -> Alpha 01.071.0301a   (the next FREE version)
node scripts/next-version.mjs --tag    # -> alpha-01.071.0301a
```

Write that into `/VERSION`, move the **App version** line in `MODULES.md` to match, add the row to
the App release log (rule 2), commit, then tag and push.

**Why this is not optional.** Several sessions cut releases against this repo concurrently. On
2026-08-31 two of them independently chose `Alpha 01.071.0208a` minutes apart. Both wrote the *same
string* into `/VERSION`, so git auto-merged with **no conflict** — the collision never appeared in a
diff. But a tag resolves to exactly one commit, so `alpha-01.071.0208a` captured only one of the two
builds, and the fix merged moments later was **not in it** while `/VERSION` still read `0208a`.

A `version-gate` CI job now fails any pull request that edits `/VERSION` to a version whose tag
already exists. It runs only when `/VERSION` actually changes.

> **`/VERSION` is not "what is deployed", and not "what `main` contains."** It names the version most
> recently *cut*. After a release, `main` immediately moves ahead of its own tag. To answer "did
> commit `C` actually ship in tag `T`?" the only reliable check is:
>
> ```sh
> git merge-base --is-ancestor C T && echo "shipped" || echo "NOT in that build"
> ```
>
> Reading `/VERSION` would have reported the `0208a` fix as shipped. It had not shipped.

---

## Where the version shows up at runtime

- `GET /health` on platform-nest returns `version`, alongside `ok` and `modules`.
- Services receive it as the `APP_VERSION` environment variable, set from `/VERSION` at deploy time.

An unset `APP_VERSION` reports `"unknown"` rather than a stale default — a build that cannot state
its version should say so loudly instead of lying quietly.

---

## ~~Open question~~ — SETTLED by the SemVer ruling (2026-08-31)

Adopting SemVer answers this: **there is no production stage *name*.** Production is the absence of
a pre-release identifier.

```
1.0.0-alpha.302  →  1.0.0-beta.1  →  1.0.0-rc.1  →  1.0.0
```

That is exactly the recommendation below (`RC` → then the real thing), and it needs no local
convention to enforce it — `1.0.0` sorts above every `1.0.0-*` by the spec. The rehearsal step the
recommendation wanted is `1.0.0-rc.N`, and Gate 1 still gates reaching it.

The original discussion is kept below for the reasoning.

---

### Original discussion (superseded)

`Alpha` and `Beta` are settled. For production, the usual options:

| Option | Reads as |
|---|---|
| `RC` then `Stable` | Explicit release-candidate step before the real thing. Most conservative. |
| `GA` | "Generally available" — standard in SaaS, implies a support commitment. |
| `Live` | Plain and unambiguous for a non-engineering audience. |
| `Prod` | Blunt, matches the environment name. |

Recommendation: **`RC` → `Stable`**. It keeps a rehearsal step between Beta and the first build that
carries real customer data, which matters here because legal Gate 1 gates real employee data.

Not urgent — nothing can reach that stage until Gate 1 passes.
