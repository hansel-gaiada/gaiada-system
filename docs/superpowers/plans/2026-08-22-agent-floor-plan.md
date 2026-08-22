# The Agent Floor — a live, animated view of the agentic estate

Status: **PLANNED**. Opened 2026-08-22. Owner request: a fully animated UI showing agents
working and delegating, with third-party agents arriving at a main door and waiting to be
received.

Consumer of, not a replacement for: `2026-08-22-pantheon-airlock-design.md` (the door itself),
the D14 approval program, and the WS8 agent platform. This document covers **the surface**, plus
the minimum backend spine the surface honestly requires.

---

## 1. The governing rule

**Motion is a claim. Every animation on this surface asserts that something happened.**

This estate already has a doctrine for that — `platform-ui/CLAUDE.md`: a capability whose backend
is missing must render its cost tier, its missing endpoint and its owning ticket; *never a blank
table, never a false success*. An agent avatar that pulses as though it were thinking, while the
backend has told us nothing since the run started, is a worse violation than any blank table,
because it is persuasive. Somebody will watch this screen to decide whether the estate is healthy.

Five rules, binding on every element:

1. **No event, no motion.** An element may only animate in response to a state change we actually
   received. Decorative idle motion — breathing glows, drifting particles, "thinking" shimmer — is
   banned outright.
2. **Idle must look idle.** When nothing is running the floor is still. Stillness is information.
3. **Synthetic pacing must be labelled.** Replaying a finished run at invented speed is legitimate
   and useful; presenting it as live is not. Replays carry a persistent `REPLAY` marker and a
   scrubber, so they can never be mistaken for the live floor.
4. **Every mark resolves to a record.** Hover or focus on anything animated yields its goal id,
   run id and timestamp. The animation is never the only source of truth.
5. **Unknown is a state, and it is drawn.** "Running, last heard from 4 minutes ago" is the honest
   rendering of a run with no progress events — not a spinner implying continuous contact.

---

## 2. What is real today

Verified against source 2026-08-22. Evidence is in the survey; the conclusions that constrain
design:

### Real
| Fact | Where |
|---|---|
| Goal rows with status, counts, `created_at/started_at/ended_at` | `ai-agents/src/runner/store.ts:195` |
| Goal status machine: `queued/running/ok/suspended/budget_exhausted/failed/interrupted/cancelled` | `store.ts:13` |
| Supervisor→specialist fan-out, ordered | `orchestrator.ts:169-206`, `blackboard` jsonb |
| Run rows with `started_at`/`ended_at`, `steps[]`, `toolsCalled`, provider | `store.ts:218` |
| A working 4s poll the UI already runs | `(app)/agents/GoalsTable.tsx:8` |
| A **real human-in-the-loop queue** with timestamps and a decision/execution split | `automation_approvals`, `0014_...sql`, D14's `0078_automation_approval_execution.sql` |
| Proven SSE transport to imitate | `core/portal-stream.controller.ts:38` + `api/portal/stream/route.ts` |

### Not real — and each one kills a specific feature
| Missing | What it blocks |
|---|---|
| **Per-step timestamps.** `AgentStep = { kind, detail }` — no `ts` | Any true timeline. This is the single blocking fact. |
| **In-flight emission.** `steps[]` is serialised once, after the run ends | Live progress within a run |
| **`parent_run_id`.** Delegation survives only as blackboard prose | An animated delegation graph |
| **Any agent transport.** No SSE/WS on the runner; it cannot reach `outbox_events` (different DB) | Push updates; we are limited to polling |
| **Queryable external-call record.** Hub allow/deny goes to a JSONL file only | The door's live traffic view |
| **Third-party identity.** mcp-hub admits by one of two shared secrets; no client registry | Seating a *named* external agent in the waiting room |

**Conclusion: the flowing animation the owner pictured cannot be built honestly today.** One
backend ticket (S0) unlocks nearly all of it. Meanwhile a genuinely useful, fully honest subset
ships immediately — including the best part of the idea, the waiting room, which is real data.

---

## 3. Relationship to the airlock plan

The airlock doc owns the door; this doc owns the window onto it. Three concrete couplings:

- **The waiting room is the airlock's intent queue.** Airlock step **A2** specifies an
  "append-only intent queue". That queue *is* the chairs. Until A2 exists, the waiting room renders
  the one real queue we have — `automation_approvals` in `pending`.
- **The attribution model is the caption.** §6A.3 defines `actor` / `via` / `approved_by` /
  `executed_by`. Every card on this floor renders those four facts, and the "Pantheon + Boss"
  summary is *derived* from them, never asserted — the doc is explicit that the summary must be
  derivable. §6A.4's explicit-absence rule means an R0 row draws "tier R0 — no approval required",
  not an empty space.
- **Kill switches must be visible.** A7 gives two independent stops. If they exist and this screen
  does not show their state, the screen is lying by omission during the exact incident it is for.

---

## 4. Stages

### S0 — the event spine (backend; the unlock)

The smallest change that makes everything else honest. In the **ai-agents service's own Postgres**
(`gaiada_knowledge`), not platform-nest — the runner has no connection to the other DB, and
pretending otherwise is how this stalls.

1. `agent_run_events` — append-only: `event_id`, `run_id`, `goal_id`, `seq`, `ts`, `kind`
   (`model | tool | delegate | approval_wait | error`), `detail`, `duration_ms`, `parent_run_id`.
   Append-only because a replay must be reconstructible and an audit must not be rewritable.
2. **Emit at each step**, not at the end. `agent.ts`'s step loop already knows when each step
   starts and finishes; it currently discards the timing.
3. `parent_run_id` on `agent_runs` — turns the blackboard's prose into a real edge.
4. `GET /runs/:id/events?since=<seq>` on the runner, and an SSE endpoint modelled on
   `portal-stream.controller.ts`, which already solves heartbeat and connection capping.
5. A `platform-ui/src/app/api/agents/stream/route.ts` handler — the browser cannot reach the
   backend directly under the single-egress rule, and this is exactly the carve-out CLAUDE.md
   already permits.

Nothing in S0 is UI. It is the difference between a real product feature and a screensaver.

**Estimate 5–7 engineer-days.** Owning seat: senior-be with senior-integrator on the transport.

### S1 — what ships now, fully honest (no S0 dependency)

1. **The waiting room** — real `automation_approvals` in `pending`: who asked, which tool, the
   impact tier, how long they have waited, and the D14 execution state after a decision. Approving
   *executes*, so the card says so before you click. This is the highest-value panel in the whole
   feature and it needs no new backend.
2. **The floor, at goal grain** — one room per department, agents as marks, driven by the existing
   4s poll. Marks change state; they do not travel. A running goal with no recent event renders
   "running · last heard 4m ago", per rule 5.
3. **The delegation graph, static** — supervisor→specialist edges from the blackboard, drawn as a
   graph with no motion, because we have no timings. Honest and immediately useful.
4. **Run replay** — the existing `steps[]` transcript, played back with a scrubber and a permanent
   `REPLAY` marker and the run's real start/end times shown.
5. **Kill-switch and hub-health strip** — whatever A7/metrics genuinely expose.

**Estimate 6–8 engineer-days.**

### S2 — the live floor (requires S0)

Real transit animation: a token leaves the supervisor when a `delegate` event arrives and lands on
the specialist when its first event arrives. Per-step progress inside a run. Live delegation edges.
The replay marker disappears because the floor is genuinely live.

**Estimate 8–10 engineer-days.**

### S3 — the main door (requires airlock A2 + an identity concept)

Named external agents arriving, queueing, being received or refused, with the refusal reason
visible. Blocked on two things that are not UI: the intent queue (A2) and a third-party identity
richer than "which of two secrets it holds". Design it now, build it when the door exists.

**Estimate 6–8 engineer-days after its dependencies.**

---

## 5. Animation specification

**Technique.** Hand-rolled: CSS transforms and transitions for state, inline SVG for the floor
plan and edges. No animation library — platform-ui has held at four runtime dependencies through
several large programs and this feature does not justify breaking that. Motion uses the system's
single easing curve (`--erp-ease`) and existing duration tokens; a new motion vocabulary here
would make this screen look like a different product.

**What animates**
| Event | Motion | Duration |
|---|---|---|
| Goal enters `running` | Mark lifts one elevation tier, tone saturates | 180ms |
| Goal reaches a terminal state | Mark settles, status ring resolves to the status colour | 280ms |
| Delegation (S2) | Token traverses the supervisor→specialist edge | 280–520ms |
| Request enters the waiting room | Card slides into the queue | 180ms |
| Approval decided | Card leaves toward the floor (approved) or the record (refused) | 280ms |

**What never animates:** idle agents, background ambience, anything not backed by an event, and
anything whose timing we invented outside a labelled replay.

**Performance.** SVG comfortably carries the expected tens of marks; a Canvas layer is the
contingency past roughly sixty concurrent, not the starting point. Three hard requirements, one
of them from scar tissue: pause the loop on `visibilitychange` so a backgrounded tab does not
burn CPU — this estate has already had a busy-loop pin a core at 46% — pause off-screen work with
`IntersectionObserver`, and cap concurrent animated tokens with the excess resolving instantly
rather than queueing.

**Reduced motion.** `prefers-reduced-motion` collapses transit to instant state changes. The view
keeps every piece of information; it simply stops moving. The global kill-switch in `globals.css`
already forces durations to ~0, so the design must remain fully legible with no transitions at
all — verify it in that mode, not just assume it.

**Accessibility.** The floor is decorative-plus-informative, so the information must exist without
it: every panel has a tabular equivalent, the same discipline `ReportTableView` already applies to
the chart kit. State changes announce through a polite live region — and note `role="log"` is
already an `aria-live` region in this codebase; assertive announcements on a busy floor would be
unusable, so politeness is mandatory, with a rate limit.

---

## 6. Avatars and identity marks

No external avatar service and no uploaded images: the CSP forbids third-party requests, there is
no avatar data in the estate today, and inventing faces for software agents is the wrong register
for a private-bank aesthetic. Marks are **generated deterministically from the principal id**, so
they are stable across sessions with no lookup table — the same technique already chosen for
company tones.

**Shape carries kind.** This is information, not decoration, and it is the fastest read on the
screen:

| Principal | Mark | Rationale |
|---|---|---|
| Human | Circle, initials, bronze hairline | People are the only circles |
| Internal agent | Rounded square, monogram, department `--cat-N` tone | Belongs to a department |
| Automation / workflow | Rounded square, dashed hairline | Unattended, no seat behind it |
| External / third-party | Hexagon, solid fill, **always** with its assurance tier | Never mistakable for one of ours |

**Assurance is drawn, not implied.** The hub already grades callers `anonymous | low | verified`.
An unverified external agent must never render as visually equal to a verified one.

**Attribution clusters.** §6A's four facts render as a mark cluster: actor, then `via`, then
`approved_by`, with `executed_by` on the caption. "Pantheon + Boss" is then something the reader
*sees* rather than a string we assert.

---

## 7. Build it ourselves, and why

**Ourselves.** Three reasons, in order of weight:

1. **Dependencies.** Every candidate — a graph library, an animation runtime, a diagram toolkit —
   is a new runtime dependency in a project that has deliberately held at four through several
   large programs. This feature is not the thing to spend that on.
2. **The data model is ours and unusual.** Goals with blackboard fan-out, D14's decision/execution
   split, the hub's assurance tiers, the airlock's intent queue. No off-the-shelf agent-observability
   view models any of that; adapting one costs more than drawing our own floor plan.
3. **The design system is bespoke.** A template arrives with its own palette, radii and motion
   vocabulary, all of which this program just spent a phase unifying.

**What is worth borrowing:** the *interaction conventions* of mission-control views — a queue that
never reorders under the cursor, terminal states that stay put, one detail pane rather than
per-node popovers. Conventions are free; code is not.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **The screen becomes decorative and quietly stops being trusted** | The five rules in §1, enforced in review. The tabular equivalent is the test: if the table is useless, the animation was carrying invented information |
| S0 slips and S1 becomes the permanent state | S1 is designed to be complete on its own, not a stub. Nothing in it implies S2 is coming |
| Polling load at 4s across many goals | S1 keeps the existing single poll; S0 replaces it with SSE rather than adding a second poller |
| Replay mistaken for live | Persistent marker plus a scrubber; never auto-plays on load |
| External agents rendered as trustworthy | Assurance tier always drawn; hexagon never borrows an internal tone |

---

## 9. Open questions for the owner

1. **Where does this live?** A new top-level surface, or an upgrade of the existing `/agents`
   route? The existing route already has goals, goal detail and run transcript pages that this
   would absorb.
2. **Who can see it?** It shows cross-company agent activity. Under the permission contract this
   is elevated-only by default, but the department view could reasonably be visible to that
   department's staff.
3. **Is S0 approved?** It is a backend ticket in the ai-agents service and it is the gate for
   everything animated. S1 proceeds either way.
