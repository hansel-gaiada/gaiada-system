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

## Outstanding

- **A robot sprite for automations.** LPC ships none. Needs a CC0 source or a small commission —
  the only unsolved asset in the cast. Until then the automation avatar is an original placeholder
  drawn in-house, which carries no third-party obligation.

## Adding a row

Record: asset, source URL, author, licence (exact name and version), whether commercial use is
permitted, whether attribution is owed, whether share-alike applies, date assessed, and who
assessed it. If any field is "unclear", the asset does not get committed until it is clear.
