# PROGRESS — session 2026-08-26

Office animation work (munder-difflin review → The Office canvas).
Status values: **DONE** · **IN PROGRESS** · **NOT DONE**

| # | Task | Status |
|---|---|---|
| 1 | Review `munder-difflin` — what it is, licence, reusable parts | DONE |
| 2 | Review `awesome-llm-apps` — what applies to our stack | DONE |
| 3 | Identify the office animation source (= munder-difflin, not saboo) | DONE |
| 4 | Survey what The Office already is in `platform-ui` (don't rebuild) | DONE |
| 5 | Read `2026-08-23-virtual-office-plan.md` — built vs. planned | DONE |
| 6 | Get the office canvas rendering locally (no backend) | DONE |
| 7 | Capture the current animation behaviour (what moves, what doesn't) | DONE |
| 8 | Pick the gap worth closing (owner chose: fractional Fit) | DONE |
| 9 | Implement fractional Fit zoom | DONE |
| 10 | Verify: typecheck + full suite + drive the real page | DONE |
| 11 | Fix transit labels smearing over the floor (plate + truncation) | DONE |
| 12 | Stop overlapping transit labels occluding each other (lanes) | DONE |
| 13 | Stop concurrent dev servers fighting over one `.next` | DONE |
| 14 | Re-verify after 11-13 | DONE |
| 15 | Reach the live API (SSH tunnel to gda-aicenter) | DONE |
| 16 | Real SSO login + capture real org/agents/automations | DONE |
| 17 | Render the REAL office shape in the lab | DONE |
| 18 | Re-verify with real data | DONE |
| 19 | Fix Operations: one desk per AGENT, not per goal | DONE |
| 20 | Fix duplicate-id desk collapse (4 people on 1 desk) | DONE |
| 21 | Fix duplicate-id room teleport (people in wrong dept) | DONE |
| 22 | Re-verify: tests + build gate + real render | DONE |
| 23 | Record the change in MODULES.md + CHANGELOG.md | DONE |
| 24 | Repair changelog damage caused by delegating that edit | DONE |
| 25 | Rail becomes tabbed: Cast / Detail / Activity / Legend | DONE |
| 26 | Bottom cast strip with real, honesty-gated status | DONE |
| 27 | Fullscreen toggle + Esc to exit | DONE |
| 28 | Verify layout: tests + build gate + drive the page | DONE |
| 29 | Changelog: 0.55.0 survived dedup; layout recorded as 0.58.0 | DONE |
| 30 | Art: wire the unused office-env pack (walls/desks/props) | DONE |
| 31 | Split row pitch from column pitch (labels hit next row) | DONE |
| 32 | Fix desk/monitor aspect (32x32 squashed into 30x9px) | DONE |
| 33 | Desks overlapped the room nameplate (DESK_TOP_TILES) | DONE |
| 34 | Avatars stood a pace behind their desk, not at it | DONE |
| 35 | Make the floor read as ONE building, not detached rooms | DONE |
| 38 | Seated avatars faced the viewer, not their desk | DONE |
| 39 | Idle wandering + joke bubbles — conflicts with plan §3/§6 | BLOCKED — needs owner decision |
| 36 | Vacant seat renders as an odd dark cross | NOT DONE |
| 37 | Every person wears the same sprite outfit | NOT DONE |

### Changed this session
- `src/lib/office.ts` — added `fitScale`, `nearestZoomLevel`, `MIN_FIT_SCALE`; `Camera.scale`
  widened from `ZoomLevel` to `number`.
- `src/components/office/OfficeCanvas.tsx` — Fit uses `fitScale`; +/-/wheel rejoin the integer
  ladder via `nearestZoomLevel`; zoom readout formats a fractional scale.
- `src/lib/office.test.ts` — 9 new tests covering both new functions.

- `src/components/office/OfficeCanvas.tsx` — `drawTransitLabel`: delegation reasons now render on
  a plate with measured truncation (was bare `ink60` text over the floor, using canvas `maxWidth`
  which condenses glyphs rather than truncating). Overlapping labels alternate into two lanes.
- `next.config.ts` + `.gitignore` — `distDir` honours `NEXT_DIST_DIR` (default `.next`, unchanged),
  so parallel dev servers on this working copy stop corrupting each other's build.

- `src/lib/office-snapshot.ts` + `src/app/office-lab/page.tsx` — the lab renders a REAL captured
  scene when `OFFICE_SNAPSHOT` points at one, and says plainly which mode it is in.

### Added this session
- `src/lib/office-fixture.ts` — a dev-only fixture `OfficeScene` (no backend needed).
- `src/app/office-lab/page.tsx` — dev-only harness route, 404s in production, not in nav.

### Verification
- `npx tsc --noEmit` clean.
- `npx vitest run` — **177 files / 3209 tests, all passing** (full suite, not a fast gate).
- Re-ran after the label + lane work: typecheck clean, 177 files / 3209 tests still passing.
- Drove the real page: floor now measures 1246px inside a 1246px viewport (was 1466px, ~93px
  clipped left). All six rooms visible, zoom reads `0.9x`, replay walks the corridor.

### Fixed after the real-data pass
- `src/lib/office.ts` — `groupAgentSeats` / `describeAgentSeat`: ONE Operations desk per agent
  instead of per goal. Operations went **51 seats -> 2**, total avatars **82 -> 33**, and the floor
  plate **2061x1798 -> 1965x934** (Fit 0.50x -> 0.63x, clear of the clamp).
- `src/lib/office-data.ts` — uses the grouping; desks link at the in-flight goal when there is one.
- `src/components/office/OfficeCanvas.tsx` — `steadyPositions()` now keys `restRoomOf` and the new
  `slotOf` by the avatar OBJECT, not by `avatar.id`. Two separate defects, both from duplicate ids:
  `indexOf(a.id)` put four people on ONE desk, and an id-keyed `restRoomOf` teleported people into
  another department. Every department now renders its true headcount.

### Incident, repaired
Delegating the CHANGELOG edit to a subagent went wrong: instead of appending, it merged the Office
work into ANOTHER session's in-flight `platform-ui 0.54.0` Finance entry, **deleted a committed
`platform-nest 0.39.2` entry** (23 lines), and flipped that entry's status PROTOTYPED -> DEV-VERIFIED
using this ticket's evidence. Restored both docs from HEAD (corrupted copies backed up to the
scratchpad first), then wrote `platform-ui 0.55.0` by hand as its own entry. Final diff is
**50 insertions / 0 deletions** in CHANGELOG.md — pure addition. Trap recorded in the root
`CLAUDE.md`.

### OPEN — backend defect to fix elsewhere
**The live org structure returns duplicate person ids.** In `GM`, four different people (Ayu, Budi,
Eka, Gaiada Exec) all carry node id `p-019fb652` — 2 distinct ids for 5 people. The UI no longer
depends on their uniqueness, but the data is still wrong and anything else keying on that id is
suspect. Belongs to platform-nest / the org-structure seed, not platform-ui.

### REAL-DATA FINDINGS (Gaia Digital Agency, live, 2026-08-26) — NOT yet fixed
Captured through an SSH tunnel to `gda-aicenter`; server reported `Alpha 01.071.0167a`.
Real shape: **8 rooms, 82 avatars** — 26 humans, **51 agents**, 5 automations.

1. **[FIXED]** **Operations was swamped: 51 seats vs 8 in the largest real department.** `office-data.ts`
   creates ONE agent avatar per goal (`goals.forEach`), with no cap and no recency window, so the
   room grows without bound as goals accumulate. It already dominates the whole floor.
2. **[FIXED by 1]** All 50 goal avatars were named `pm-reporter` — every goal in this tenant used that agent, so
   the floor and the roster list show 50 indistinguishable entries.
3. **Nothing animates on real data.** 0 of 50 goals have an open run, so no avatar ever gets an
   `activeRunId`. The entire O4 agent-animation path is dead in production today.
4. **[IMPROVED]** The real floor was 2061x1798 px. Before this session's fractional Fit, "Fit" would have shown
   roughly a quarter of it. It now fits at **0.50x** — but `MIN_FIT_SCALE` is 0.45, so one or two
   more departments and Fit clamps and starts clipping again.
5. The only real animation is the 5 automations, all pending approval (amber "!").
6. Goal health, worth an ops look: **21 failed / 19 budget_exhausted / 10 ok** out of 50.

### Known, not fixed
- Several stale `next dev` processes from Aug 20-25 are still running against this working copy
  (one hung on port 3005). Left alone — they may belong to other sessions.
- Plan stages O0 / O2 / O3 / O5 remain unbuilt; nothing this session changed that.

## Notes

- The Office already exists: `/office` route, ~3,700 lines, hand-rolled **Canvas 2D**, no Pixi,
  no new dependency. Do NOT port munder-difflin's Pixi scene over it.
- Plan stages: **O1 read-only + O4 agent motion = built (demo-gated)**. **O0** (the real
  event/presence spine), **O2** (movement), **O3** (interaction), **O5** (lobby) = not built.
- Animation today is honesty-gated on purpose: it only runs for *proven* agent-run activity or
  live automation state. Humans never animate — there is no comparable activity feed.
- **Fit zoom, owner decision 2026-08-26:** "Fit" may now go fractional so the whole plate is
  visible. This consciously softens the pixel art below 1x and overrides the integer-only note in
  `office.ts`. Every user-driven zoom step stays integer and pixel-exact; only Fit may be
  fractional, floored at `MIN_FIT_SCALE`.
- Art is settled: LPC sprites, credits auto-generated from upstream `CREDITS.csv`
  (`npm run gen:office-credits`). The LimeZu question in plan §7 Q2 was answered = LPC.
- munder-difflin licence: MIT source, but its bundled tiles are LimeZu paid art. Irrelevant to us
  now that we're on LPC — patterns only, no code, no assets.

## NEXT: make the floor look authored, not generated (owner feedback 2026-08-26)

The complaint is not art quality, it is that our rooms read as GENERATED — identical desks on a
perfect grid, identical people, bare walls, one floor material per room — while the reference reads
as FURNISHED. Three concrete causes, all fixable with assets already committed and unused:

1. **Everyone is the same person.** `public/office-chars/people/uniform/` holds **30 outfits** and
   `.../skin/` holds **6 tones**. Neither is referenced anywhere in `src/`. Pick deterministically
   per avatar id (`hashId`) so a person always looks like themselves. Biggest single win.
2. **The walls are bare.** `public/office-env/paintings/` holds **12** pieces, unused; plus
   `furniture/storage/bookshelf*`, `office_equipment/clock`, `plants/plant_corner|plant_tall`.
   Hang them along the room's top wall band, deterministic per room key.
3. **The desk grid is a spreadsheet.** `deskSlotTile()` lays a strict cols x rows grid. Vary it:
   pods of 2-4 facing each other, some desks against a wall, a lounge cluster (`seating/sofa` +
   `common/coffee_table`) where a room has spare floor. Seats must stay DETERMINISTIC per person —
   the binding to real headcount is the point of the page and must not be lost.

Constraint that must survive: rooms are sized from REAL headcount and each desk is a specific
person's seat. "Authored-looking" must be achieved by varying ARRANGEMENT and DRESSING, never by
inventing seats or decoupling desks from people.
