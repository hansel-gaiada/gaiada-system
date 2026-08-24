# The Office World — in-house engine, builders, and a world people move in

Status: **PLANNED**. Opened 2026-08-24. Supersedes nothing; extends
`2026-08-23-virtual-office-plan.md`, which stays the source for presence rules and honesty.

Owner direction: build our own engine in-house (Creative is producing assets); build animation
paths, an office room builder, an office floor builder, and an avatar builder for employees; AI
agents get a fixed avatar; automations get a fixed avatar whose **colour varies by department and
is settable in the UI**; make a big world people can move around and interact in; employee↔employee
interaction opens a chat box shown as a bubble, in their own chat box, and as a notification;
employee↔agent opens the assistant, shown as a bubble and in assistant history; automations and
agents tell **department-themed jokes** at random intervals. And, explicitly first: **use the real
employee names.**

---

## 0. The prerequisite the owner named, and exactly where it stands

**The office is showing invented people right now, and it is not the office's fault.**

`platform-nest/src/seed/org-structure-refresh.ts` (commit `fa49547`, another session) diagnosed it:
the org tree is ONE JSON blob in `company_org_structure`, written once on 2026-08-04 from the old
placeholder roster. Every org and people surface reads that blob rather than the `users` tables —
and `office-data.ts` reaches it through `listDepartmentBriefs`/`getDepartment` → `getOrgStructure`,
so the office inherits the same stale names. That commit's own header is worth quoting:

> EVERY DATA CHECK PASSED AND THE APP STILL SHOWED THE WRONG PEOPLE. […] correct tables and a stale
> blob look exactly like a correct app until somebody opens the page.

And `seed:agency` can never fix it: its insert is `ON CONFLICT (tenant_id) DO NOTHING`, deliberately,
because the tree is user-editable in the org builder. That correctness is what makes the staleness
**sticky**.

**Two steps, neither done:**
1. **Deploy `fa49547`** — it sits after the live `alpha-01.069.0145a` tag.
2. **Run `npm run seed:org-structure-refresh`** on the box. It is a deliberately-invoked script, not
   something a deploy triggers.

Nothing else in this programme should start before that. Every feature below multiplies whatever
names are in the tree: an avatar builder, chat, notifications and jokes attached to *invented*
people would spread the fabrication across four more surfaces and make it far more expensive to
unpick. This is the same class of error as the invented company names reverted from the login page.

---

## 1. "Build our own engine" — we already have one; name what is actually missing

Worth being precise, because "build an engine" invites a rewrite of working code.

**Already built and shipped** (`lib/office.ts`, `components/office/OfficeCanvas.tsx`): a tile model,
a floor-plate allocator with corridors, BFS pathfinding over a walkable grid, layered sprite
compositing with runtime palette recolouring, a camera with integer zoom / pan / follow, an
event-driven animation loop with visibility and off-screen pausing, and hit-testing. That is an
engine. It is small, hand-rolled, dependency-free, and it works.

**Genuinely missing**, and this is the real scope:

| Gap | Why it is hard |
|---|---|
| **Authoring tools** (room / floor / avatar builders) | Today layout is code-derived. A builder means persisted layout data, an editing UI, and a migration path from generated layouts |
| **Multiplayer** | Two people seeing each other move. Presence, position transport, conflict, reconnection |
| **Interaction model** | Proximity, initiating, chat surfaces, notifications |
| **An asset pipeline** | Creative producing sprites means a contract, a naming scheme, a build step, and versioning |

Recommendation: **extend, do not rewrite.** Keep the four-dependency discipline. If a specific need
ever genuinely exceeds hand-rolled Canvas — hundreds of concurrent sprites, say — that is a
measured decision at the time, not an upfront bet.

---

## 2. The design problem to settle before Creative draws anything

**A chat bubble over someone's head is visible to everyone in the room.**

Employee↔employee chat rendered as a bubble means a private message is broadcast to every bystander
looking at that part of the floor. That is a leak, and worse, it is one people will not anticipate
because the mental model of "chat" is private.

**Proposed rule: a bubble shows THAT a conversation is happening, never WHAT is said.**
- Bystanders see an indicator — two figures in conversation, a neutral glyph.
- The participants see the words, in their own chat box, not on the canvas.
- Notifications go to participants only.

Jokes are the exception, and legitimately so: a joke is *authored to be public*, from a non-human,
with no private content. That is why jokes can render in-world while messages cannot.

This decision shapes the art (a "talking" indicator vs. a speech balloon with text), so it wants
settling before assets are drawn.

---

## 3. Avatars

| Principal | Avatar | Configurable |
|---|---|---|
| **Employee** | Built in the avatar builder — layered, per person | By the person |
| **AI agent** | **Fixed** — one canonical synthetic look | Not configurable |
| **Automation** | **Fixed** silhouette, **colour by department**, settable in the UI | Colour only |

The automation colour rule is a change from the current build and worth noting: today automations
are deliberately grey *with no department tone*, on the reasoning that an automation owns no
decisions so should carry no department identity. The owner wants department colour, settable. That
is a defensible different call — an automation does *belong* to a department operationally even if
it exercises no judgement — but the earlier reasoning should be consciously overridden rather than
silently lost.

---

## 4. Jokes — the constraint already recorded, still binding

`2026-08-23-virtual-office-plan.md` §4.6 rules out free-form model generation in the office:
a language model improvising into a workplace, attributed to a named principal in front of
colleagues, is an HR and content-safety incident waiting to happen — and it would be attributed to
the *person* whose avatar said it.

Department-themed jokes fit a **curated, reviewed phrase bank** perfectly, and a bank written by
someone who knows the team is funnier than generated output. Per-person opt-out of receiving them;
a global quiet mode. Frequency low enough that the office does not become noisy — this is ambience,
not entertainment.

---

## 5. Staging

Each stage is independently useful; none should start before §0.

| Stage | What | Depends on |
|---|---|---|
| **W0** | **Real names.** Deploy `fa49547`, run the refresh, verify the office renders the real roster | — |
| **W1** | **Asset contract with Creative** — frame size, layer order, palette slots, directions, animation set (idle / walk / sit / type / talk), naming, licence provenance for anything not original | W0 |
| **W2** | **Avatar builder** — layered composition over the contract, stored as a small per-person config, never a rendered image | W1 |
| **W3** | **Room + floor builders** — persisted layout data replacing code-derived plates, with an editing UI. Bindings to real departments survive the change | W1 |
| **W4** | **Presence + movement transport** — the O0 spine, plus position. **The five presence rules in the previous plan become live here**, and this is a new processing activity for the monitoring notice / ROPA / DPIA | W0 |
| **W5** | **Interaction** — proximity, employee↔employee chat (per §2), employee↔agent assistant, notifications | W4 |
| **W6** | **Jokes** — curated bank, opt-outs, quiet mode | W4 |

W4 is the one that changes the product's compliance posture, not just its features. It is not a
frontend task with a backend attached.

---

## 5a. Decisions taken 2026-08-24 (supersede the questions below where they overlap)

1. **Bubbles show THAT, not WHAT** (§2 accepted). Creative draws a *talking indicator*, not a text
   balloon. Jokes remain the exception — public by authorship, non-human, no private content.
2. **Employee↔employee chat is deferred to a new chat interface** the owner is building separately.
   The world becomes a LAUNCHER: it opens that surface and owns no message storage, no retention
   policy and no notification path of its own. This removes the presence-rule-2 conflict entirely —
   presence stays ephemeral, messages live in a system built for messages.
3. **Build for hundreds, not for the estate we have.** Owner override of the recommendation. W4's
   transport becomes WebSocket + a replica-safe state layer, which needs: a new nginx `location`
   with upgrade headers (the only upgrade-aware block today points at `platform-ui`, not
   `platform-nest`, which is not even published in prod), a raised `proxy_read_timeout`, and a
   presence bus that is not the current in-process `EventEmitter`. This is weeks of infrastructure
   ahead of measured demand at 7 possible concurrent logins — recorded as a deliberate choice, not
   an oversight.
4. **Automations get a department colour, settable in the UI.** This consciously overrides the
   earlier "an automation owns no decisions so carries no department tone" reasoning. Both readings
   are defensible; the override is deliberate and should not be silently re-reverted later.
5. **Smaller characters, bigger world.** Character frames drop **64×64 → 32×32**, tiles stay 16×16,
   so a figure is ~1 tile wide and ~1.5 tall — the GBA overworld proportion. At zoom 1 that is
   roughly 90 tiles and ~12 rooms across a 1440px viewport, against ~4.5 rooms today. Consequence
   accepted: **the 24 LPC sprites become interim placeholders**, since downscaling art drawn for
   64px loses what it was drawn for. Creative draws at 32×32 from the start rather than matching
   the current set — and when in-house art lands, the OGA-BY attribution obligation retires with it.
6. **Layouts must not be one corridor with two sides.** The current double-loaded corridor plan is a
   deterministic allocator, which was right for generated layouts and is wrong as a permanent
   constraint. The floor builder and room builder are **drag-and-drop canvases**, so layout becomes
   authored data rather than an algorithm's output. The allocator stays as the default for a floor
   nobody has arranged yet — never as the only shape available.
7. **Sequencing, owner directive:** ship what exists and get the automation animation running so the
   world reads as busy now. The real office-work simulation is being built in a separate session;
   this one focuses on the animation surface.

---

## 6. Open questions for the owner

1. **§2 — bubbles show that-not-what.** Accept? It is the difference between a fun feature and an
   accidental broadcast of private messages.
2. **Automation department colour** overrides the current "no department tone" reasoning (§3).
   Confirm that is deliberate.
3. **Scale.** Real concurrency is single-digit today (7 of ~47 principals can log in). A "big world"
   built for hundreds is a different transport and a different cost. Build for the estate we have?
4. **Creative's capacity and the licence rule.** Original in-house art carries no third-party
   obligation, which is a real simplification — but anything they source externally still needs a
   manifest row (`legal/asset-licences.md`).
