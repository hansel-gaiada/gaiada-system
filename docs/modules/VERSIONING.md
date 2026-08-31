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

## App version format

```
Alpha 01.001.0001a
 │     │   │   │ │
 │     │   │   │ └─ revision letter
 │     │   │   └─── module-reference counter
 │     │   └─────── app release counter
 │     └─────────── milestone
 └───────────────── stage
```

### `Alpha` — stage

Where this build is meant to run. **Not** a quality claim about any single module — a module can be
`DEV-VERIFIED` inside an `Alpha` app.

| Stage | Meaning |
|---|---|
| `Alpha` | Early prototype. The trial box. Data is disposable; migrations may be re-run from scratch. |
| `Beta` | Staging. Real-shaped data, no destructive resets, deploys rehearsed as if production. |
| *(production stage TBD)* | See "Open question" below. |

### `01` — milestone

Ground-breaking change only: a re-architecture, a new trust zone, the first real-customer cutover.
Expect this to sit still for months. Bumping it **resets** the app release counter to `001` and the
module-reference counter to `0001a`.

### `001` — app release counter

`+1` for **every app version that gets cut**, whether or not it is deployed. This is the number that
makes two builds comparable at a glance: `001` is older than `014`, always. Never reused, never
decremented. Three digits; roll to four when you get there rather than wrapping.

### `0001` — module-reference counter

The **cumulative count of module version bumps**, across every module in the registry. It is
derived, not chosen: if a release bumps `platform-nest` and `platform-ui`, the counter advances
by 2. The first app version is the baseline `0001` — counting starts from that manifest, so the
number is only ever meaningful as a *difference* between two releases, never as an absolute.

That makes the number meaningful — the gap between two app versions tells you how much module churn
sits between them, which `001 → 002` alone would hide.

### `a` — revision letter

Same module set, cut again: a rebuild, an infra-only fix, a re-tag after a failed deploy. Goes
`a → b → c`. **Resets to `a`** whenever the module-reference counter moves.

An infra/CI change that touches no module is exactly this case: bump the letter, not the counter.

---

## Rules

1. **Every notable module change bumps that module's version** in `MODULES.md` **and** adds a
   `CHANGELOG.md` entry. This rule already existed; the app version depends on it being followed.
2. **Every app version records its module manifest** — the exact version of all 14 modules — in
   the App release log in `CHANGELOG.md`. Without the manifest the app version is just a number;
   with it, any deployed build is fully reconstructible.
3. **Major module change ⇒ significant app move.** A module minor bump (`0.6.x → 0.7.0`) is a
   feature; several in one release should read as a big release. That is what the module-reference
   counter conveys — don't flatten it by batching bumps into one.
4. **The deployed tag matches the app version.** Git tag = the app version, lowercased and
   hyphenated: `Alpha 01.001.0001a` → `alpha-01.001.0001a`.
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

## Open question — the production stage name

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
