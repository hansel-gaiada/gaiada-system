# Third-party asset licence manifest

Every third-party visual asset in the estate is recorded here **before** it is committed. The rule
is simple and absolute: *if it is not in this file with a licence, it does not go in the repo.*
"Found it on a tileset site" is not provenance.

This exists because asset licences do not inherit from a repository's code licence, are frequently
misread as "free" when they are non-commercial, and become impossible to reconstruct two years
later when nobody remembers where a tile came from.

Status: **no third-party art committed yet.** The row below is a decision on record, not a shipped
dependency.

---

## Decided: LPC character + environment art

| Field | Value |
|---|---|
| **Asset** | Universal LPC Spritesheet Character Generator asset set |
| **Source** | https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator |
| **Licence** | **GPL 3.0 OR CC-BY-SA 3.0** (dual). CC-BY-SA is the intended route |
| **Commercial use** | Permitted |
| **Attribution** | **Required.** Many contributing artists; the repo ships per-asset credit data alongside each sheet |
| **Share-alike** | **Yes — applies to derivative artwork.** Recolours and composites must be offered under CC-BY-SA. Does **not** reach application code |
| **Date assessed** | 2026-08-23 |
| **Assessed by** | This session, against the repository's own licence files |
| **Decision** | Adopted as the character and environment direction (see `docs/superpowers/plans/2026-08-23-virtual-office-plan.md` §4.3-DECISION) |

### Obligations, concretely

1. **A credits surface must ship with the feature**, not after it. It lists every contributing
   artist for every sheet actually used — generated from the repo's own credit data, not
   hand-maintained, because a hand-maintained list silently rots.
2. **Derivative sheets are CC-BY-SA.** Our palette-recoloured bodies, heads and composited
   characters inherit share-alike and must be made available on request under the same terms.
   This is acceptable precisely because we were never going to sell sprites.
3. **Application code is unaffected.** The ERP stays proprietary. Only the art derivatives carry
   copyleft. Do not let this get muddled — it is the most commonly misunderstood point.
4. **A legal read is still outstanding** before derivative sheets are generated at scale. This
   manifest records the assessment; it is not a substitute for sign-off.

---

## Rejected, and why (kept so the reasoning is not re-litigated)

| Asset | Licence | Why not |
|---|---|---|
| LimeZu *Modern Interiors* / *Modern Office* (paid, $1.50) | Commercial use + editing permitted, credit required, **no redistribution** | Excellent and style-consistent, but the owner chose the free route. The free tier omits the Character Generator, which is the layered pipeline the avatar builder needs |
| LimeZu free tier | **Not stated on the pack page** | Terms are undocumented for the free download specifically. Never assume a free tier inherits the paid grant |
| `pixel-agents` bundled characters | Repo is MIT; art credited to an external pack ("JIK-A-4, Metro City") | An asset licence does not inherit the repository's MIT. Reading their MIT *code* is fine; vendoring the art is not |
| Any "free Pokémon tileset" | Typically none — frequently ripped from Nintendo ROMs | Infringement. Nothing depicting or derived from an actual Nintendo asset, ever. The *style* is free to emulate; the sprites are not |

---

## Candidate: automation robot

| Field | Value |
|---|---|
| **Asset** | Pixel Robot |
| **Source** | https://opengameart.org/content/pixel-robot |
| **Author** | David Harrington |
| **Licence** | **CC0** — public domain, **no attribution required** |
| **Contents** | `robot-spritesheet.png`, 180×64. Idle (7 frames) + run (7 frames), ~20×26 per frame |
| **Date assessed** | 2026-08-23, by downloading and rendering the sheet, not from the description |
| **Status** | **Provisionally adopted**, subject to the design note below |

**Limitation, measured not assumed: it is front-facing only.** One direction, no turn. At first
pass that fails the four-direction requirement in the style contract.

**Why it is adoptable anyway — and why this is the better design.** An automation is a workflow. It
has no journey: it fires and completes. It does not walk from PM to Design to hand work over, the
way an agent does. So the automation avatar should be **stationary in the utility room, animating
only when it actually runs** — idle when idle, the run cycle when a workflow is executing. A
single-direction sprite is not a compromise here; a walking robot would be inventing a journey that
does not exist, which the honesty rule forbids anyway.

Consequences to carry into the build:
- The four-direction requirement in the style contract applies to **people and agents only**.
  Automations are exempt by nature, and the exemption should be stated rather than discovered.
- Scale: ~20×26 against LPC's 64×64 frame. Upscale 2× (integer only) to ~40×52, which sits
  correctly beside an LPC character. Verify against a real LPC figure before committing.
- CC0 means no attribution obligation and no share-alike — it does not inherit LPC's CC-BY-SA.
  Keep the two asset sets separately recorded; do not let one set's terms be assumed for the other.

**A second limitation, measured: the preview sheet has no alpha channel.** Verified by reading the
pixels — `robot-spritesheet.png` is 180×64 with **zero transparent pixels**, a solid purple matte
at `rgb(118,66,138)`, and the words "IDLE" and "RUN" baked into the image as labels.

That file is a *preview*, not the deliverable — `pixel-robot.zip` (33 KB) is the actual download and
most likely contains properly keyed sprites. **Fetch and verify the zip before adopting.** If the
zip is also matted, the preprocessing is still trivial for pixel art (no anti-aliasing means a
chroma key is exact), but it must be a one-time build step with the result committed, never a
runtime cost, and the label text must be cropped out.

Recorded because it is precisely the kind of thing that looks fine in a browser preview and then
ships a purple box behind every automation.

## Outstanding

- **Fetch and verify `pixel-robot.zip`** — confirm real alpha, frame dimensions and cell layout.
- Confirm the robot reads correctly at 2× beside a 64×64 LPC character, in both themes.
- Nothing else. The cast is otherwise covered.

## Adding a row

Record: asset, source URL, author, licence (exact name and version), whether commercial use is
permitted, whether attribution is owed, whether share-alike applies, date assessed, and who
assessed it. If any field is "unclear", the asset does not get committed until it is clear.
