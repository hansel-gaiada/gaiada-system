# For the release owner — the version sequence on `main` is non-monotonic

**Not urgent, not breaking anything today, and it will bite the next person who cuts a release.**
Written up rather than fixed, because concurrent sessions are each bumping `/VERSION` independently and
this needs one owner rather than a third session editing shared release state.

## What the sequence actually is

`/VERSION` history on `main`, newest first, with the build number each commit set:

| Commit | `/VERSION` set to | Build |
|---|---|---|
| `ef41ad2` | `Alpha 01.066.0142a` | **0142** ← current `main` |
| `90bd1c9` | `Alpha 01.065.0141a` | 0141 |
| `51fcc0f` | `Alpha 01.066.0143a` | **0143** |
| `662bf35` | `Alpha 01.065.0142a` | **0142** |
| `af2b968` | `Alpha 01.064.0140a` | 0140 |
| `2fccb9f` | `Alpha 01.063.0139a` | 0139 |

Read bottom-up, the build number goes **0139 → 0140 → 0142 → 0143 → 0141 → 0142**.

## The three concrete problems

1. **Build `0142` is used twice** — `alpha-01.065.0142a` and `alpha-01.066.0142a` are both tagged and
   both pushed. The build number is supposed to be the monotonic part.
2. **`0143` is already tagged while `/VERSION` reads `0142`.** So the next cut that naively increments
   lands on `0143` and **collides with an existing tag** — `git push --tags` will refuse it, or worse,
   someone force-moves a tag that has already deployed.
3. **The sequence went backwards twice.** `0143` → `0141` and `0143` → `0142` both happened, which means
   merges are picking arbitrary winners between two sessions that each bumped `/VERSION`.

## What is NOT wrong

- **Every tag matches its own commit's `/VERSION`.** I checked all three: `alpha-01.065.0142a` →
  `Alpha 01.065.0142a`, `alpha-01.066.0142a` → `Alpha 01.066.0142a`, `alpha-01.066.0143a` →
  `Alpha 01.066.0143a`. So `deploy.yml`'s tag↔VERSION cross-check passed for each, and **no deploy
  shipped a mislabelled build**.
- **The live estate is healthy and correctly labelled.** `gda-aicenter` reports
  `APP_VERSION=Alpha 01.066.0142a`, matching the newest tag, with all 27 containers up and zero
  restarting. This is a bookkeeping problem, not a production one.

## Why it happened, and the fix that actually holds

`/VERSION` is a single line in a file that every session edits, and a generated-file-style conflict has
no meaningful three-way merge: git picks a side and both sides look plausible. This is the same class of
hazard the root `CLAUDE.md` already records for `docs/MAP.md` ("a generated file has no meaningful
three-way merge … regenerate from the merged tree rather than resolving hunks").

Suggested, in order of how much it actually prevents:

1. **Immediate:** set `/VERSION` past the highest existing tag (i.e. `0144` or beyond) so the next cut
   cannot collide. One line, unblocks the next release.
2. **Cheap guard:** have the release workflow refuse a tag whose build number is not strictly greater
   than every existing tag's. That converts this from a silent history problem into a loud refusal at
   the one moment someone is paying attention.
3. **Root cause:** bump `/VERSION` *in the release commit only*, never on feature branches, so two
   feature merges can never disagree about it.

## Duplicate `0142`

Leave both tags. They are pushed and at least one has deployed; deleting or moving a pushed release tag
is worse than an untidy history. Recording it here is the honest resolution.
