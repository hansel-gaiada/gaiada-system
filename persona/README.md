# persona/ — the seat personas

**Status: PLANNED (first two packs authored 2026-08-23).**

One directory per `agent_registry` seat. Design:
`docs/superpowers/plans/2026-08-22-hermes-moe-personas-training.md` §5. Tracker:
`docs/superpowers/plans/2026-08-22-hermes-PROGRESS.md`.

```
persona/<seat>/
  identity.md    name · role framing · who it serves · what it is NOT
  voice.md       register · length · ID/EN language policy · formatting
  boundaries.md  what it refuses, and the EXACT words it refuses in
  escalation.md  when to hand to a human · to whom · what the handoff carries
  runbooks/      the R3 procedures this seat escorts humans through
  examples/      20–40 worked turns drawn from the REAL corpus (Stage 0)
```

## The one rule that governs everything here

> **A persona is presentation, never permission.**

If editing a file in this directory can change what a seat is *able to do*, the design has failed.
Capability lives in three places and none of them are here:

| Layer | Where | Authority |
|---|---|---|
| Identity | `users` row | the only thing Cerbos and the audit log see |
| Capability | `agent_registry` row | tool namespaces, `max_impact`, `model_class` — a **ceiling** |
| Presentation | **this directory** | **none** |

Someone will eventually want to write *"you are the finance lead, you may approve invoices up to 5M"*
into a persona. That sentence must be **inert**. The number lives in Cerbos and the risk ladder; a
persona may only *describe* a limit it is already bound by.

The same rule is why **R3 is enforced by the ABSENCE of the tool from the seat's view**, never by a
boundary written here. A persona saying "never call this" is a suggestion to a stochastic system.

## Two structural facts these packs are written against

**Single front door (owner decision, 2026-08-23).** Employees always reach department seats *through*
the router. Department personas therefore never assume direct address, and the router's persona is
load-bearing rather than decorative — it is where routing, clarification and synthesis actually live.

**Zedano, not "Zedanne".** `SOUL.md` on the box says *"Your name is Zedano"* and the identity row is
`zedano@gaiada.com`. Two sources agreed; the third spelling appeared only in conversation.

## Status of each pack

| Seat | identity | voice | boundaries | escalation | runbooks | examples |
|---|---|---|---|---|---|---|
| `router` (Zedano) | ✅ | ✅ | ✅ | ✅ | n/a — routes, never executes | ⛔ blocked on corpus |
| `dept-pm` | ✅ | ✅ | ✅ | ✅ | 📋 stub | ⛔ blocked on corpus |

**`examples/` is deliberately empty.** Stage 0 requires ≥100 real requests per department, and the
corpus-privacy decision (may real WhatsApp/meeting transcripts become fixtures? may they leave the
estate?) is still open. Writing invented examples would defeat the purpose: a persona built from
imagination optimises for the requests an engineer imagines, and real staff ask messier, more
elliptical, more code-switched questions than anyone predicts. **These packs ship structurally
complete and example-light on purpose.**
