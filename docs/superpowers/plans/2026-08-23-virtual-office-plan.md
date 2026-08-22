# The Office — a pixel-art virtual workspace for people, agents and automations

Status: **PLANNED**. Opened 2026-08-23.

Owner request: a pixel-art virtual office where every principal — human employee, internal agent,
automation, external agent — has an avatar and a place. Human employees can drive their own avatar,
walk around, and interact. An avatar with nobody driving it moves on its own, and its movement
represents real delegation. An avatar a human *is* driving produces conversational bubbles and
gestures on interaction.

This is the largest single feature proposed for this estate. It is planned in stages that each
stand on their own, because the realistic outcome is that some stages ship and later ones wait.

---

## 1. The decision that shapes everything: one spine, two renderers

`2026-08-22-agent-floor-plan.md` proposes an **Agent Floor** — an operations view of agent activity
driven by a new event spine (S0: `agent_run_events` with timestamps, `parent_run_id`, SSE).

The Office needs the *same* facts. An agent avatar walking from the PM room to the Design room to
hand over work is exactly the Agent Floor's delegation edge, rendered as a sprite instead of a
line. If these are built as two features they will grow two event pipelines, two presence models
and two sources of truth, and they will disagree — at which point neither is trustworthy.

**They are one system with two renderers:**

| | Agent Floor | The Office |
|---|---|---|
| Register | Operations. Dense, still, honest | Social. Spatial, playful |
| Audience | Whoever is on point when something breaks | Everyone, all day |
| Answers | "What is the estate doing, and what is stuck?" | "Who is around, and what is happening?" |
| Renderer | SVG floor plan + tables | Canvas tile map + sprites |
| Data | **The same event + presence spine** | **The same event + presence spine** |

Practical consequence: **the Agent Floor's S0 is also this feature's O0.** Build it once. The
Office is then a second renderer over a spine that already has a consumer proving it works — which
is also the cheapest way to keep the honest-ops view honest, because both views break together if
the spine breaks.

Second consequence, and a pleasing one: the "main door and waiting room" the owner asked for
becomes **literal**. The airlock's intent queue (`2026-08-22-pantheon-airlock-design.md` step A2)
renders as the office lobby, with external agents actually sitting in chairs until received. Same
data as the Agent Floor's waiting-room panel, drawn as a room.

---

## 2. The risk that can sink this feature

**A map of where everybody is, all day, is workplace surveillance.** That is not a reason to refuse
it — Gather and its peers are used happily by many teams — but it is the difference between a
feature people enjoy and one they resent and route around. This estate has an HR module and a
`legal/` tree; the question will be asked.

Five constraints, proposed as **binding design rules**, not preferences:

1. **Presence is opt-in, per person, and revocable in one click.** A person who opts out has no
   avatar on the map and is not listed as absent. "Not shown" must be indistinguishable from
   "not here" — otherwise opting out becomes its own signal and the choice is fake.
2. **Presence is ephemeral and never becomes a record.** Position and online-state live in memory
   with a short TTL. No location history table, no `last_seen` column that accumulates, nothing
   queryable after the fact. If it cannot be reconstructed tomorrow, it cannot be used in a
   performance review.
3. **No derived-activity metrics. Ever.** No idle timers, no time-at-desk, no "hours present", no
   heatmaps of who visited whom. This rule exists because these metrics are trivially derivable
   from position data and their absence must be a deliberate, stated commitment.
4. **No manager view.** There is no report, export or API that answers "where was X". The map is
   the map, live, for everyone equally, with the same information for a director and an intern.
5. **Agents and automations get none of these protections** — they are software, their movement
   *is* the operational record, and it should be logged thoroughly. The asymmetry is the point.

If any of these five is negotiated away, that changes what the feature is, and it should be a
deliberate, recorded decision rather than a drift.

---

## 3. Honesty carries over

The Agent Floor's governing rule applies unchanged, and pixel art makes it *more* important because
a cute sprite is more persuasive than a chart: **motion is a claim.**

- An agent avatar walks **only** when a real delegation event says so. It does not wander to look
  busy.
- An idle agent stands still. A room with nothing happening is a still room.
- An agent whose run is in flight but silent renders as "working, last heard 4m ago" — a visible
  state, not a looping animation implying live contact.
- **Human avatars are exempt in one direction only**: a human-driven avatar moves because a human
  pressed a key, which is itself a real event. Idle-fidget animation for *humans* is acceptable
  because it asserts nothing about work.

---

## 4. Architecture

### 4.1 Transport — **SSE down + batched HTTP POST up** (infra-verified 2026-08-23)

Decided, not provisional. An infrastructure probe against the live estate settled it:

**What already works, untouched**
- **SSE is deployed and deliberately tuned.** `infra/nginx/erp.gaiada.online.conf:160-198` gives
  the portal stream `proxy_buffering off`, `proxy_cache off`, `gzip off`, `Connection ""` and
  `proxy_read_timeout 3600s` — because `location /`'s 300s default and hardcoded
  `Connection: upgrade` would otherwise break a plain SSE GET. This is solved, commented, working
  production config, and a second stream (assistant) already reuses it.
- **Redis is in production** — `docker-compose.vps.yml:58-64`, `redis:7-alpine`, `--appendonly yes`,
  internal-only, no exposed port. It is used as **Redis Streams** (`events/relay.ts` `XADD`, tailed
  with cursors by `portal-live.service.ts:192`), not pub/sub — but Streams is the right primitive,
  and ephemeral presence is a natural fit as plain keys with TTL (`SET presence:<tenant>:<user> …
  EX 30`), which also satisfies §2's "never becomes a record" rule at the storage layer rather
  than by policy alone.
- **Headroom is fine.** ~2.7 GB of 7.8 GB used on the host, and no `cpus:`/`mem_limit` caps
  anywhere in the prod compose — the constraint is whole-host RAM, not a per-container ceiling.

**Why not WebSocket**
- It would **not** pass nginx today. The only upgrade-aware block points at `platform-ui:3005` for
  Next.js server actions, not at `platform-nest` — which is not even published in prod. WS would
  need a new `location` block, a raised timeout, and a reachable backend port. n8n proves the
  operator can wire this (`$n8n_connection_upgrade` map, lines 8-11), so it is not hard — it is
  simply new production surface, and it is process rather than config.
- **Real concurrency is single-digit.** Only **7 of ~47** roster rows have a working login. Avatar
  updates at 2–4 Hz for a dozen users is trivial over POST. WebSocket machinery buys nothing at
  this scale while adding a second protocol both nginx and Nest must newly support.

**Design consequences that follow from the verified facts**
- **Send intent, not position.** The client posts "walking to tile (x,y)"; every client interpolates
  the path locally. Network traffic becomes a few messages per *action* instead of per frame. Local
  render is 60fps and interpolated — the network is not the frame rate.
- **The 30-minute connection cap is a design input, not a bug.** `MAX_CONNECTION_MS` forces periodic
  reauthorization. Reconnection must therefore be *seamless* — resume with a full state snapshot —
  or every avatar in the office visibly blips every half hour.
- **Presence TTL must exceed the heartbeat interval with margin.** The stream heartbeats every 25s
  specifically to reset nginx's read timeout; a 30s TTL would race it. Use ~60s, refreshed on
  heartbeat, so a brief reconnect does not evict a present person.
- **One correction to an earlier assumption:** the SSE fan-out is an **in-process `Set<Subscriber>`**
  (`portal-live.service.ts:103`), not Redis pub/sub. It is correct only because Nest runs as a
  single instance today (no `replicas`, no upstream pool, nginx proxies to bare loopback ports).
  Presence can safely follow the same pattern **provided that stays true** — but the moment Nest is
  replicated, presence and the portal stream both break together, silently. Note it as a scaling
  landmine rather than solving it now.

### 4.2 Rendering
Canvas 2D, hand-rolled, no engine. No new runtime dependency: the four-dep discipline holds. A tile
map, a sprite layer, a name/bubble layer. `requestAnimationFrame` paused on `visibilitychange` and
when the canvas is off-screen — this estate has already had a busy loop pin a core at 46%, and a
game loop in a background tab is the same bug wearing a costume.

### 4.3 Desks, rooms and the office — **the part that makes it real**

Reference reviewed 2026-08-23: `github.com/pixel-agents-hq/pixel-agents` (MIT), which renders coding
agents as pixel characters in a tile office — Canvas 2D, an expandable 64×64 tile grid, an in-app
**layout editor** (paint floors and walls, place and rotate furniture), named **Areas** bound to
workspace folders, layouts persisted as shareable JSON, and characters driven by real hook events
(`SessionStart`, `PreToolUse`, `PermissionRequest`, `Stop`) through pathfinding and state machines.
It is a good design and it resolves a question this plan had left open.

**The thesis: what makes the animation feel real is not the sprite quality. It is that every
element resolves to a real entity.** A gorgeous office with invented rooms is a screensaver. A
plain office where *this room is really Web Development, this desk is really the vacant Backend
Engineer position, and the character at it is really the person holding it* carries meaning in
every movement. Bind first, decorate second.

**Authoring: an editor, not hand-coded maps and not procedural generation.** The plan previously
posed those as the only two options; both are wrong. Hand-drawn maps go stale the moment the org
changes. Procedural offices look generic and nobody loves them. The third answer is what the
reference does: **author the office once in an in-app layout editor, and store it as versioned
JSON data.** Non-engineers can rearrange the office, no deploy is needed to move a desk, and the
map stops being code.

**The binding model — this is the load-bearing part.** Every Area carries a typed binding to a
real record, so the office is a *view of the org*, not a picture of one:

| Space | Bound to | What it means when reality changes |
|---|---|---|
| **Floor** | A company (`companies.id`) | A new entity in the holding needs a floor. Its absence is visible |
| **Room** | A department (via `deptSlug`, the existing registry key) | A new department with no room renders in an "unassigned" holding area rather than vanishing |
| **Desk** | **A position, not a person** | The org is already position-driven. A desk is a seat; the occupant is resolved at render time |
| **Lobby** | The airlock intent queue | External agents genuinely wait here |
| **Meeting room** | A live meeting record | Occupied when a real meeting is running |
| **Utility room** | Automations / workflows | Where the robots live. Not a department, because automations belong to no department |

**Desks map to positions, not people** — the single best consequence of the binding model. This
estate's IAM is already position-driven, so a desk is a seat that exists whether or not anybody
holds it. A **vacant desk is a visible open role**. An overloaded department is a room with more
occupied desks than chairs. Nobody has to build a headcount report; the office *is* one, and it
cannot drift from the org because it is rendered from it.

**Reconciliation is a first-class screen, not an error state.** Because bindings can dangle, the
editor needs a plain list: rooms bound to deleted departments, departments with no room, desks
bound to abolished positions. That list is the mechanism that stops the office quietly becoming
fiction — the same instinct as the envelope's "excluded companies are counted with a reason".

**Craft that sells the space** (in rough order of payoff): 3/4 top-down perspective on a **16×16
grid rendered at integer 2× or 3× zoom** — 16px is the de-facto standard for this genre and what
the mature asset packs ship, so matching it keeps every pack compatible; wall occlusion so
characters pass *behind* furniture; soft contact shadows; a few ambient props per room drawn from
the department's real craft (a graded monitor in Creative, a rack in IT); and a day/night floor
tint from real clock time, which is honest because time genuinely passes.

### 4.3-DECISION — **LPC at 32px, committed 2026-08-23**

Owner reviewed real composited sprites and approved. This supersedes the LimeZu recommendation in
§4.3a/§4.4a/§4.5 below; those sections are kept for the reasoning trail, not as live guidance.

**Chosen:** the Universal LPC Spritesheet Character Generator asset set, GPL3 / CC-BY-SA 3.0.

**Verified by building with it, not by reading about it:**
- `head/heads/human/` is a real separate layer — male, female, small, gaunt, plump, elderly.
- Seven human skin ramps applied by **runtime palette swap** on body and head. No per-tone files.
- Genuine office wear exists: shirt, longsleeve, blouse, vest, formal and striped trousers,
  skirts, shoes. (An earlier reading that clothing was missing came from a GitHub tree response
  **truncated at 61,014 entries** — listing directories directly disproved it.)
- 86 hair styles, beards, glasses, earrings.
- walk / idle / run / **sit** animations. `sit` matters: an office is mostly people at desks.
- Agents reuse the *same* body and head under a steel palette — synthetic, humanoid, free.

**Consequences, accepted deliberately:**
1. **The style contract in §4.3b changes to 32×32 tiles and 64×64 character frames.** The 16×16
   LimeZu direction is retired. Environment art must be re-sourced at 32px to match.
2. **CC-BY-SA obligations are now live.** Derivative sheets (recolours, composites) stay
   share-alike; a credits page listing contributing artists is mandatory. Application code is
   unaffected. This needs a legal read before derivatives ship, not after.
3. **LPC ships no robot.** The automation avatar is the one unsolved asset — needs a CC0 robot
   sprite or a small commission. Everything else in the cast is covered.
4. Wardrobe leans medieval. The modern pieces exist but must be **curated**, not adopted wholesale.

**Two traps found while building the sample, worth keeping:** the sheet named `pants` is a minimal
undergarment, not trousers — use `legs/formal`; and a cream trouser on a cream blouse reads as bare
legs, so the wardrobe needs contrast checking, not just presence checking.

---

### 4.3a Sourcing the art — free is four different things

Free assets absolutely exist and buying/commissioning original art is **not** required to start.
But "free" spans four licences and only some survive contact with a commercial internal product:

| Licence | Use here | Catch |
|---|---|---|
| **CC0 / public domain** | Safest. Use, edit, ship, no attribution owed | Quality is uneven; office-specific sets are thinner than fantasy/platformer |
| **CC-BY** | Fine | Attribution is mandatory and must actually appear |
| **CC-BY-SA / GPL art** (e.g. the LPC ecosystem) | **Risky** | Share-alike is viral on *derivatives*. Palette-swapped or extended sprites may have to be released under the same terms. The LPC layered character generator is otherwise a perfect fit, which makes this trap easy to walk into |
| **"Free to download, non-commercial"** | **Disqualified** | Common on itch.io and easily mistaken for free |

**Recommended pack: LimeZu's *Modern Interiors* / *Modern Office*** (16×16, itch.io). Verified
2026-08-23:

- **A genuinely free version exists** (`Modern_Interiors_Free_v2.2.zip`, ~1 MB, limited content).
- **The complete pack is name-your-own-price with a $1.50 USD minimum** (~149 MB), or bundled with
  two further packs for $5.00. This is not a budget line item; it is a rounding error, and it
  should not be treated as a procurement decision.
- **Licence: "edit and use the asset in any commercial or non commercial project."** Editing for
  our own use is explicitly permitted. Credit is required, linking to `https://limezu.itch.io/`.
  Reselling or redistributing the assets — modified or unmodified — is prohibited.

**The paid tier also ships a Character Generator (2.0, Windows and Linux)** — a layered character
builder. §4.4's palette-swappable hair, skin and outfit personalisation, which this plan had scoped
as a custom layered sprite system, largely arrives solved there.

**OWNER DECISION 2026-08-23: use the FREE version.** Planned accordingly. Three consequences,
recorded so nobody rediscovers them mid-build:

1. **The free download is a sampler** — ~1 MB against ~149 MB. It is enough to prove the bindings,
   the transport and the presence model in O1. It is very unlikely to furnish a multi-department
   office at O2 without filling gaps from other sources.
2. **No Character Generator.** Per-person hair/skin/outfit personalisation returns to being custom
   work, or is dropped from first release. This is the real cost of the free tier — not the tiles.
3. **The free version's licence terms are NOT stated on the pack's page** — only the complete
   version's grant ("edit and use in any commercial or non commercial project") is documented.
   **Do not assume the free tier inherits it.** Before any free-tier asset is committed, read the
   licence file inside the zip and the linked free-version devlog, and record the finding in the
   manifest. If the free tier turns out to be non-commercial or silent, that reopens the choice —
   and at a $1.50 minimum, the paid tier is the cheaper answer to a licensing question.

The $1.50 was never really a cost decision; it is a "do we want the character generator and full
room coverage" decision, and it can be revisited at O2 with real information instead of a guess.

### 4.3b Style spec — "GBA-era top-down", and the IP line

Owner direction: a Pokémon-style / classic pixel look. That is achievable and safe, with one hard
boundary.

**The style is free to emulate. The assets are not.** A visual style — 16×16 top-down JRPG — is not
protectable, and countless commercial games use it. But a large share of the "free Pokémon
tilesets" circulating online are **literally ripped from Nintendo ROMs**, relabelled and reposted.
Using those in a commercial product is infringement, and the exposure is invisible until it is
not. The rule that prevents it is the one already in §4.3a: **no asset enters the repo without a
traceable licence in the manifest.** "Found it on a tileset site" is not provenance. Nothing
depicting or derived from an actual Nintendo character, tile or UI element, ever.

Convenient fact: LimeZu's *Modern Interiors* is already this lineage — 16×16 top-down RPG, the
Stardew/GBA family — so the owner's two preferences do not conflict.

**Because free assets will be mixed from several sources, a style contract is what keeps them
looking like one product.** Freeze before O1 and reject anything that violates it:

| Property | Value |
|---|---|
| Tile grid | 16×16 |
| Perspective | 3/4 top-down (furniture shows a front face; not pure overhead) |
| Character size | 16×32 (roughly two tiles tall) |
| Walk cycle | 4 directions, 3–4 frames each |
| Outlines | 1px dark outline on characters and furniture; none on floors |
| Palette | Limited and shared — all sources re-palettised to one ramp |
| Anti-aliasing | None. Hard pixel edges only |
| Zoom | Integer only (2×/3×). Fractional scaling destroys pixel art |

Re-palettising every source to one shared ramp is the single highest-leverage step: mismatched
palettes are what make asset-flip projects look cheap, far more than mismatched draughtsmanship.

**Additional CC0 sources to fill gaps** (verify each, per asset, never per site): OpenGameArt's
CC0 collection, the `rgsdev` CC0 16×16 top-down template (CC0, no credit required), and
DungeonTileset II (CC0). Office-specific CC0 coverage is genuinely thin compared with
fantasy/platformer — expect to fill gaps by re-colouring and recombining rather than by finding a
ready-made free office.

**The redistribution clause is the trap, and it is a real one.** "Do not redistribute" sits badly
with committing sprite sheets into a repository. It is fine while `gaiada-system` is private; it
becomes a licence breach the moment any part of it is published, mirrored to a public remote, or
baked into a publicly shared artifact. Two mitigations, both cheap: keep purchased/licensed art in
a dedicated path with its terms beside it, and never inline those sprites into anything published
outside the estate.

**Mandatory: an asset licence manifest.** Every asset records source URL, author, licence, date
obtained, and whether attribution is owed — kept in `legal/` (which already exists) with the
attribution surface rendered in-app. This is the difference between "we think it's free" and being
able to prove it two years from now when nobody remembers where a tile came from.

**Also worth surveying before choosing:** Kenney's libraries (widely CC0 — verify per pack),
OpenGameArt (mixed licences, verify **per asset**, never per site), and the wider itch.io office
tag. Treat every "free" label as unverified until someone reads the actual terms.

**Authoring tool: Tiled**, not a bespoke editor to begin with. Tiled is a free, open-source desktop
map editor, its JSON/TMX export is a documented standard, and the LimeZu-class packs are built for
it. It is an *authoring* tool, so it ships nothing into the app and adds no runtime dependency —
we render its JSON with our own Canvas code. That removes the in-app layout editor from the
critical path entirely; build one later only if non-engineers need to rearrange the office without
help. This materially cuts O1.

**Licensing warning on the reference project itself.** `pixel-agents` is MIT for its *code*, but
its characters are credited to an external pack ("JIK-A-4, Metro City"), and an asset licence does
not inherit the repository's MIT. Reading their MIT code is fine and encouraged; vendoring their
art is not, until someone reads that pack's terms.

### 4.4 Avatars — three layers
1. **Deterministic base.** Generated from the principal id, so every principal has a stable
   distinct look with no art request and no lookup table.
2. **Kind is legible at a glance**, and the taxonomy is shared with the Agent Floor so it is
   learned once. The ops view draws it as geometry, the office draws it as sprites; the categories
   and their meanings are identical.

   | Principal | Office sprite | Agent Floor mark | Why this form |
   |---|---|---|---|
   | **Human employee** | A person. Palette-swappable hair, skin, outfit | Circle, initials | People are the only human silhouettes on screen, and the only ones a person customises |
   | **Internal AI agent** | Humanoid but plainly synthetic — an android, in its department tone | Rounded square, monogram | It exercises judgment and holds a departmental seat, so it reads as a *colleague* — but never as a person |
   | **Automation / workflow** | A small boxy **robot**. Mechanical, treaded or hovering, no face, neutral grey — no department tone | Rounded square, dashed hairline | It runs a fixed script. No judgment, no seat, no personality. The absence of a department colour is information: nobody owns its decisions because it makes none |
   | **External agent** | Visually foreign — different silhouette, cooler palette, a visible badge — and **always** drawn with its assurance tier (`anonymous \| low \| verified`) | Hexagon | It is not ours. An unverified external agent must never be mistakable for an internal one |

   The android/robot split is the one people will feel most: an agent that can be reasoned with
   looks like it can be reasoned with, and a workflow that will do exactly the same thing every
   time looks mechanical. That is not decoration — it sets the right expectation before anyone
   interacts.

   **Assurance is drawn, never implied.** An `anonymous` external agent and a `verified` one must
   be distinguishable at a glance, without hovering.
3. **Personalisation on top** — palette swaps for hair, skin, outfit, chosen by the person. This
   is the part people actually care about, and it is cheap once the sprite sheet is layered.

### 4.4a The avatar builder — and the constraint that decides the asset choice

Owner request 2026-08-23: employees are male and female, and each person customises **hair,
head/face, body/clothing, and pants/legs**.

**The crux: a customiser requires layer-separated art.** You cannot build one from flattened
character sprites — there is nothing to swap. This single fact, not budget, decides which pack we
use, because *the layered pipeline is exactly what the free tier does not include*. LimeZu's
Character Generator is paid-only ($1.50). So the feature just requested is precisely the one the
free download cannot deliver.

Three honest routes:

| Route | Layered? | Cost | Style fit | Licence |
|---|---|---|---|---|
| **(A) LimeZu paid + Character Generator** | Yes, purpose-built | **$1.50** | **Exact** — same pack as the office | Commercial use and editing permitted, credit required, no redistribution of raw assets |
| **(B) LPC / Universal LPC Spritesheet Generator** | Yes, purpose-built, male + female bases | **$0** | **Poor** — LPC characters are 64×64 fantasy-leaning; our style contract is 16×32. Adopting LPC means re-scaling the *entire* office and abandoning the 16×16 look | GPL3 **or CC-BY-SA 3.0**. Commercial use allowed, but share-alike is viral on derivative art, and attribution covers many contributing artists |
| **(C) Commission layered 16×32 sprites** | Yes | 5–10 artist-days | Exact, bespoke | Ours outright |

**Recommendation: (A).** It is the tool built for this job, it is style-consistent with the office
we are already planning, and at $1.50 the decision is not really about money — it is about whether
the avatar builder ships at all. (B) is genuinely free and genuinely good, but it is not a drop-in:
it changes the art direction of the whole product, and its share-alike terms need a real legal read
before derivative sprites are generated, not an optimistic one. (C) is the fallback if licensing
stalls.

**This supersedes the free-tier decision only for characters.** Free-tier environment tiles remain
viable; it is the *character layers* that the free download cannot provide.

#### Layer model

Fixed stack, back to front. Every layer is independently selectable and independently palette-swappable:

| # | Layer | Notes |
|---|---|---|
| 1 | **Base body** | Includes male- and female-presenting bases, plus a neutral option. Carries skin tone |
| 2 | Head / face | Eyes, brows, facial features |
| 3 | **Bottom** (pants / legs / skirt) | Drawn before the top so a shirt overlaps the waistband correctly |
| 4 | **Top** (body / clothing) | |
| 5 | Shoes | |
| 6 | **Hair** | Last, so it sits over the collar |
| 7 | Accessory | Glasses, lanyard, headset. Optional |

**Do not gender-lock the cosmetic layers.** The base body is a choice; hair, clothing and
accessories are then available to everyone. This is less code (no per-gender option matrices), it
avoids a class of complaint that costs more to handle than it ever saves, and it is what every
modern character creator does.

#### Storage and composition

- **Store a small JSON per person** — layer ids plus palette indices — **never a rendered PNG.**
  An avatar is then ~100 bytes, and re-skinning or extending the sprite sheet later does not
  invalidate everyone's saved character.
- **Compose at runtime** into an offscreen canvas, once per person per direction, and cache. Draw
  the cached frames thereafter. Composition cost is paid on join, not per frame.
- Avatar config is ordinary durable user preference data — unlike presence (§2), which is
  deliberately ephemeral. Keep the two apart: one is a saved choice, the other is a live location.
- The builder is a normal ERP page with a live preview, walking on all four directions so people
  see the result in motion rather than as a static portrait.

### 4.5 The art pipeline — **revised 2026-08-23: license the world, author the identity**

Two independent axes, easily conflated: **cost** (free vs paid) and **origin** (existing vs
commissioned). The recommendation here is about *origin* — use existing art for the environment
rather than commissioning it. On cost it happens to land at **$0–$5 total**, so cost is not the
deciding factor and should not be argued about.

The earlier framing (commission everything / generate everything / licence a pack) was a false
choice. Environment art and character identity have different economics, so they get different
answers:

- **Environment — tiles, desks, rooms, props: use a licensed pack.** This is bulk work with no
  brand content in it, the packs are excellent and cost a rounding error, and nobody will ever look
  at a desk tile and wish it had been bespoke. LimeZu *Modern Interiors* + *Modern Office* per
  §4.3a. This removes the art dependency from the critical path almost entirely.
- **Characters — start with the pack's, differentiate later.** The pack's characters are good
  enough to ship O1 and O2. The differentiation that matters is the **kind taxonomy** in §4.4 —
  android agents, grey robots for automations, foreign-looking external agents — and those four
  silhouettes are a small, well-scoped commission (or in-house Creative job), not a full character
  system. Do them once the office is real and the need is proven.
- **Procedural generation is demoted to a fallback**, not the plan. It exists only if licensing
  stalls.

**The sprite contract must still be frozen before O2** — frame size (16×16 tiles, characters
16×32), direction count, animation frame counts, layer order and palette slots. The renderer is
built against it, and changing it later is a rewrite rather than an edit. Adopting a pack's
existing conventions is the cheapest way to freeze it correctly, because they are already
internally consistent and battle-tested.

**Revised art estimate: 2–4 days of integration** (slicing, Tiled tilesets, sprite contract), plus
a later **5–10 day** commission for the four kind-differentiated character sets. Down from the
10–20 days of original art the first draft assumed.

### 4.6 Interaction and the conversation bubbles
Two distinct behaviours, as the owner described:

- **Unattended avatar → delegation interaction.** Two agents meeting is a real handover: the bubble
  shows what was actually delegated, and resolves to the run. This is operational content.
- **Human-driven avatar → social interaction.** Gestures and lines from a **curated phrase bank**,
  authored and reviewed, varied by department and time of day.

**No free-form model generation in the office.** A language model improvising jokes into a
workplace, in front of colleagues, attributed to a named employee's avatar, is a content-safety
and HR incident waiting to happen, and it would be attributed to the person, not the model. A
curated bank is funnier in practice anyway because it can be written by someone who knows the team.
Per-person opt-out of receiving social interactions, and a global quiet mode.

---

## 5. Stages

Each stage is independently shippable and independently useful.

| Stage | What | Depends on | Estimate |
|---|---|---|---|
| **O0** | **Event + presence spine.** This *is* Agent Floor S0 (`agent_run_events`, `parent_run_id`, SSE) plus ephemeral presence (opt-in, TTL, no history) | — | **5–8 d** (shared with the Agent Floor, counted once) |
| **O1** | **Read-only office.** Map renders from a Tiled export, Areas bound to real companies/departments/positions, avatars placed, nobody moves. Proves art, bindings, transport and presence with no input layer | O0, sprite contract, licensed pack | **5–7 d** |
| **O2** | **Movement.** Keyboard/touch control, intent-based pathing, interpolation, collision. The largest engineering stage | O1 | **10–14 d** |
| **O3** | **Interaction.** Proximity detection, bubbles, gestures, curated bank, opt-outs, quiet mode | O2 | **8–10 d** |
| **O4** | **Agents and automations move for real.** Delegation events drive agent avatars between rooms | O0, O2 | **6–8 d** |
| **O5** | **The lobby.** External agents queue at the door, are received or refused, with the reason visible | Airlock A2 + third-party identity | **6–8 d** after its dependencies |
| **Art** | Licensed pack integration: slicing, Tiled tilesets, sprite contract | Licence verification | **2–4 d** |
| **Art+** | Commission the four kind-differentiated character sets (human / android / robot / external) | O2 shipped | **5–10 d** |

**Engineering total: roughly 40–55 engineer-days**, plus 2–4 days of asset integration up front and
a 5–10 day character commission later — down from the 10–20 days of original art the first draft
assumed, because the environment is now bought rather than drawn. Licensing a pack and authoring in
Tiled removes both the art pipeline and a bespoke layout editor from the critical path.

It is still worth stating plainly: this is comparable to the entire ERP UI redesign (35–44 days),
and it should be scheduled as a programme rather than slipped in.

---

## 6. What could go wrong

| Risk | Mitigation |
|---|---|
| **Presence read as surveillance** | The five rules in §2, decided and written down before O0 |
| **Cute sprites make dishonest motion easy** | §3, and the Agent Floor's tabular equivalent stays the source of truth |
| Art blocks engineering | Licensed pack from day one (§4.3a); procedural is the fallback, not the plan; sprite contract frozen before O2 |
| **Asset licence breach** | Manifest in `legal/` per asset; no-redistribution art never inlined into anything published outside the estate; every "free" label treated as unverified until the terms are actually read |
| The office becomes a toy nobody opens twice | O1 must be useful read-only. If "who is around" is not worth opening on its own, movement will not save it |
| Two event pipelines drift apart | §1 — one spine, enforced. The Agent Floor is built first and proves it |
| Game loop burns CPU in a background tab | Pause on `visibilitychange` and off-screen. Non-negotiable; there is precedent |
| **Nest is replicated later and presence silently breaks** | The SSE fan-out is an in-process `Set`, correct only at one instance. Presence inherits that. Record it as a known landmine; the fix (move fan-out onto the Redis Streams already in production) is understood but should not be pre-built |
| Avatars blip every 30 minutes | The stream's `MAX_CONNECTION_MS` cap forces reauthorization; reconnect must resume from a full snapshot, and presence TTL (~60s) must exceed the 25s heartbeat with margin |
| LLM-generated jokes cause an HR incident | Curated bank only. No generative text in the office |
| Scope creep into a game | The office models the org. No inventory, no minigames, no economy |

---

## 7. Open questions for the owner

1. **Are the five presence rules in §2 accepted as binding?** This is the first decision and it
   changes what gets built. Specifically: is presence opt-in, and is a manager view genuinely off
   the table?
2. **Art route — the avatar builder forces a sharper question (§4.4a).** A customiser needs
   layer-separated art, and the free LimeZu tier does not include the Character Generator. Choose:
   **(A)** pay the $1.50 for the layered generator, style-consistent, recommended; **(B)** go LPC —
   free and layered, but 64×64 fantasy-leaning art that re-scales the whole office and carries
   CC-BY-SA share-alike needing a legal read; or **(C)** commission 16×32 layered sprites (5–10
   artist-days). Free-tier *environment* tiles remain fine either way.
3. **Does this replace or sit beside the Agent Floor?** Recommendation: beside. The ops view must
   stay dense and still; the office is the social view. Same data, different door.
4. **Scheduling.** This is 40–55 engineer-days plus art, against an ERP redesign with Phases 2–5
   still unstarted (~31–39 days remaining). Which goes first? They cannot go at once.
