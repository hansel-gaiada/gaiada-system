# Third-party asset licence manifest

Every third-party visual asset in the estate is recorded here **before** it is committed. The rule
is simple and absolute: *if it is not in this file with a licence, it does not go in the repo.*
"Found it on a tileset site" is not provenance.

This exists because asset licences do not inherit from a repository's code licence, are frequently
misread as "free" when they are non-commercial, and become impossible to reconstruct two years
later when nobody remembers where a tile came from.

Status: **24 LPC sprite files committed 2026-08-23** under `platform-ui/public/office-sprites/`
(body/head/hair/torso/legs/feet, male + female, `walk.png` + `sit.png` — the exact set verified
electable OGA-BY 3.0 / CC0 below). The credits surface obliged by this file's own rules ships at
`/office/credits`, generated from `CREDITS.csv` by `platform-ui/scripts/generate-office-credits.mjs`
— see that script and `platform-ui/src/lib/office-credits.generated.ts`.

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

## LPC licence position — RESOLVED 2026-08-23 (owner read the licences; supersedes the CC-BY-SA framing above)

**Share-alike is avoidable entirely, and we are avoiding it.**

Calling LPC "CC-BY-SA" was wrong. Licences are recorded **per asset** in `CREDITS.csv`
(13,915 rows, 72 authors across the whole library) and most assets are **multi-licensed** —
typically `OGA-BY 3.0, CC-BY-SA 3.0, GPL 3.0`. Multi-licensed means the user **elects one**. We
elect **OGA-BY 3.0** wherever it is offered, and CC0 where that is offered. Neither carries
share-alike, so **our derivative sprites stay ours** and the application is unaffected either way.

Owner decision: use the free assets, keep the set small — this is an internal office tool, not a
character-creator product. No thousand-variant wardrobe.

### The curated set, measured rather than assumed

Across the ten asset groups the office needs (male/female bodies, male/female heads, eyes, two
hairstyles, a shirt, trousers, shoes): **813 candidate rows, 765 of them electable with no
share-alike (94%), 18 distinct authors to credit.**

The 48 exceptions are concentrated in exactly two groups, so they are avoided by picking a
different variant within the same group, not by giving anything up:

| Group | Rows that are CC-BY-SA-only | Action |
|---|---|---|
| `torso/clothes/longsleeve` | 33 | Choose an OGA-BY variant from the same group |
| `head/heads/human/male` | 15 | Choose an OGA-BY variant from the same group |

**Target: a 100% OGA-BY / CC0 set. Zero share-alike.** Verify each chosen file against
`CREDITS.csv` before committing it — the group is mixed, so the *variant* is what determines the
licence, not the folder.

### What OGA-BY 3.0 actually obliges

Attribution: name the author, link the source, state the licence. That is all — no share-alike, no
copyleft reaching our code or our recolours. The credits surface must be **generated from
`CREDITS.csv`**, never hand-maintained, or it silently rots.

### One unresolved gap, and the rule that catches it

The `eyes` sample originally pulled (`eyes/human/adult/neutral/walk.png`) matched **no row** in
`CREDITS.csv`. 116 `eyes/` rows exist and the ones sampled are CC0, so a licensed variant is
certainly available — but **an asset with no credit row has unknown provenance and does not ship**,
per this file's own rule. Resolve the exact eyes file to a real CREDITS row before committing it.

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

---

## Decided: "Waha" in-house pack — AI-generated, Office subset only

| Field | Value |
|---|---|
| **Asset** | `Waha` character + office pixel pack, delivered by the Creative team 2026-08-24 (2,052 PNG) |
| **Source** | **Generated with ChatGPT by the Gaiada Creative team.** Not downloaded, not licensed from a third party — confirmed by the owner 2026-08-24 |
| **Licence** | **None, and none is needed.** Purely AI-generated images have no human author, so no third-party copyright subsists to license. OpenAI's Terms of Use additionally assign output rights to the generating account and permit commercial use |
| **Commercial use** | Permitted |
| **Attribution** | Not required (no third-party author). The `/office/credits` surface stays for the LPC sprites above |
| **Share-alike** | None. This is the practical reason to prefer this pack over LPC where it is usable |
| **Date assessed** | 2026-08-24 |
| **Adopted** | **`Office/` subset only** — 135 files: floors, walls, doors/windows, furniture, equipment, props, plants, lighting, signage, paintings |
| **Excluded** | The entire `Character/` tree — 1,917 files. See the two reasons below |

### The consequence nobody should discover later

Because there is no human authorship, **we hold no copyright in this art either.** Anyone may copy
the office environment out of our product and we have no claim against them. For interior fixtures
in an internal ERP that is an acceptable trade; it would not be acceptable for anything that is part
of the product's identity, so **this pack must never be the source of a logo, an icon set, or
brand art.** Those need a human author precisely so that they can be owned.

### Why `Character/` is excluded

1. **Similarity risk in the 30 "Special Uniform" sets.** The v2 delivery renames them to generic
   archetypes (`01_Ninja`, `05_Magical_Sailor`, `11_Samurai`), which was the right instinct. But the
   v1 contact sheet labelled the same 30 sets *Naruto, Sasuke, Kakashi, Itachi, Sailor Moon, Goku,
   Vegeta, Luffy, Zoro, Tanjiro, Nezuko, Gojo* — i.e. the prompts were the character names. A folder
   rename does not change what the model drew, and "no copyright in the output" is not a defence
   against the output resembling someone else's protected character. We need none of the 30 for an
   office, so excluding the category removes the question entirely rather than answering it.
2. **They are technically unusable regardless** — see the defect list in
   `docs/superpowers/plans/2026-08-24-office-world-programme.md` §7.

An AI-generated asset is not automatically safe. The generator's output carries no licence, but it
can still carry someone else's character design, and that is a separate question this row answers
separately.
