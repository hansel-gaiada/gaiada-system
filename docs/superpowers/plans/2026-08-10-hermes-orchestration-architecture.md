# Hermes orchestration architecture — the agentic operating layer

**Status: PLANNED.** Nothing below is built. Written 2026-08-10.
Scope: how Hermes becomes the orchestrator for a department-agent workforce, how that workforce
reaches tools, how the owner's **Pantheon** master sits above it, and the order to build it in so the
embryo scales to N businesses instead of being rewritten.

Related: `2026-08-03-agentic-native-erp-plan.md` (OPEN — the capability bar this depends on),
`2026-07-15-ws8-agent-platform-plan.md` (the agent framework that already exists),
`docs/PERMISSION-CONTRACT.md`, `docs/FRONTEND-BFF-CONTRACT.md`.

---

## 1. What exists today (the embryo, honestly stated)

| Piece | State | Where |
|---|---|---|
| Hermes agent + its own MCP client into the hub | DEV-VERIFIED both directions | `/opt/hermes-zen/config.yaml` on gda-aicenter |
| `hermes-gateway` shim (`/complete`, `/media`, `/complete/stream`) | DEV-VERIFIED, hand-deployed, **not in CI** | `hermes-gateway/`, systemd unit |
| Agent framework: specialists, supervisor, budget/cycle guards, D13/D14 gates, evals, episodic memory, KG | PROTOTYPED, ~86 tests | `ai-agents/` |
| Tool surface aggregated from module contracts, Cerbos-gated, OBO principals, per-workflow scoping | PROTOTYPED | `mcp-hub/` |
| n8n workflow plane, least-privilege by `wf:<name>` | 3 flows DEV-VERIFIED | `automation/` |
| Model plane, sole holder of provider keys | DEV-VERIFIED | `ai-gateway-go/` |

**The embryo's actual defect is not missing agents — it is shape.** Hermes today holds the *whole*
aggregated hub tool surface as one flat list under one identity (`zedano@gaiada.com`, `member`,
one company). That is a single agent with ~90 tools, no departmental boundary, and no way to act
on behalf of an employee. Everything below is the correction.

---

## 2. Five planes — and the rule that keeps them apart

Draw the system as five planes. Each has exactly one owner component, and a capability may only
descend, never skip:

```
  P4  Conversation / edge     Discord (Pantheon) · WhatsApp · /assistant · n8n triggers
        ↓ intent + identity
  P3  Orchestration           Hermes (router) · ai-agents supervisor (durable goals)
        ↓ goal
  P2  Agents (MoE-A)          dept-* · sys-* · sec-* · edge-*  — bounded identity, scoped tools
        ↓ tool call + OBO envelope
  P1  Tools                   mcp-hub  →  platform-nest  →  Cerbos + RLS + Postgres
        ↓ inference
  P0  Models (MoE-M)          ai-gateway-go — the ONLY holder of provider keys
```

**The rule: a plane never reaches past the one below it.** No agent gets a provider key. No edge
surface calls a tool directly. No orchestrator writes to Postgres. This is what makes the thing
replicable per business — a new company clones P2–P4 and reuses P0/P1.

### The two different things people call "MoE"

Be precise; conflating them produces a routing layer nobody can debug.

- **MoE-M (mixture of *models*)** — lives in `ai-gateway-go`. Expert = a model. Gating = task class
  (cheap-extract / general / code / reasoning / vision) × cost tier × `isRoutable` eval attestation
  from the model registry. Agents ask for a **capability class**, never a model name.
- **MoE-A (mixture of *agents*)** — lives in the router. Expert = a department agent. Gating = the
  agent registry (§4), not a prompt. Output of routing is 1..k agents plus a synthesis step.

Both gating functions must be **data-driven**. If adding a department means editing a `switch`
statement, the design has already failed the "scales to other businesses" requirement.

---

## 3. Hermes' job: router, not doer

**Decision to make and hold: Hermes orchestrates, `ai-agents` executes.**

Two orchestrators already exist in this estate (Hermes on the box; `orchestrator.ts` in `ai-agents`),
and leaving both able to execute produces a split brain where budget, D14, tracing and evals are
enforced in one path and not the other.

| Concern | Owner |
|---|---|
| Intent classification, department selection, clarifying questions, response synthesis, conversational memory | **Hermes** |
| Goal decomposition, tool execution, per-goal budget, cycle/fan-out guards, D13 provider gate, D14 suspension, tracing, evals | **`ai-agents` supervisor** |
| Deterministic, scheduled, idempotent multi-step work | **n8n** |

**Concretely: strip Hermes' tool view down.** Hermes stops holding 90 tools and holds roughly four:
`agents.list`, `agents.invoke`, `agents.status`, plus a small read primitive set for framing
questions. Everything else it reaches *through* an agent. This is the single highest-leverage change
in the plan — it converts Hermes from "one big agent" into a control plane.

### n8n vs agent — the boundary rule

If the steps are known in advance and the same every time, **n8n owns it** and the agent calls the
workflow as a tool. If the steps depend on judgement about the input, the agent owns it and calls
n8n for the deterministic legs. An agent re-deriving a fixed 6-step pipeline every run is a cost
bug and a reliability bug at once.

---

## 4. The agent registry — the thing that makes this scale

New departments and new businesses must be **rows, not commits**. One registry, owned by
`platform-nest`, read by the router and by the hub:

```
agent_registry
  name                 'dept-pm' | 'sec-guard' | 'wa-concierge'
  kind                 department | system | security | edge
  company_scope        company id, or 'group' for cross-company
  capability_tags[]    what the router matches intent against
  tool_namespaces[]    the hub namespaces this agent may see
  max_impact           read | low_write | medium_write | high_write
  model_class          the MoE-M capability class, never a model name
  identity_user_id     FK → users (the agent's own bounded identity)
  eval_suite           required; an agent with no suite cannot be enabled
  enabled, version
```

Target roster (one per department + the three cross-cutting seats the requirement names):

- **Departments** — `dept-pm`, `dept-webdev`, `dept-seo`, `dept-smm`, `dept-creative`, `dept-hr`,
  `dept-finance`, `dept-it`, `dept-legal`, `dept-agency`.
- **System** — `sys-ops` (deploys, health, backups, migrations status). Read + propose; every write
  is D14 by construction.
- **Security** — `sec-guard`. **Highest blast radius in the estate**: it must see broadly to be
  useful. Ship it read-only + propose, with no `max_impact` above `read` until there is a reviewed
  case for each write. Its own audit trail is read-only to itself.
- **Edge** — `wa-concierge` (the WhatsApp seat). Its identity floor is the weakest in the system
  (a phone number), so it carries the lowest assurance ceiling and the smallest tool view.

### Where the tool allow-list is *actually* enforced

Three layers, deliberately redundant, with one authority:

1. `AgentDef.tools` in `ai-agents` — ergonomics and eval determinism.
2. **Hub tool view** — the hub serves each principal only its registry namespaces. This keeps the
   model's context small *and* removes the hallucinated-tool failure mode.
3. **Cerbos** — the authority. Layers 1 and 2 are mirrors; a bypass of either still gets denied.

Never the prompt. "You may only use these tools" in a system prompt is not a control.

---

## 5. Serving employees — the blocker, and the one fix that closes three gaps

The requirement "able to serve all employees" is currently **unsatisfiable**, and not for a
capacity reason. `Principal` holds a single `userId`, so when an employee asks an agent to do
something, the agent acts as *itself*, not as a bounded stand-in for that employee. That means an
agent is either too weak to help anyone or too strong to be safe.

**The fix — delegation as a first-class principal shape:**

- The envelope gains `x-act-for: <employee external id>` alongside the existing agent identity.
- The hub resolves **both** and mints a delegated principal.
- **Effective permission = agent scope ∩ acting user's permissions**, proven with a double Cerbos
  check (once as the agent, once as the user). Deny if either denies.
- The audit line records **both** identities: "dept-pm acting for Alice".

That one change closes three tracked gaps at once: the delegation blocker in the agentic-native
plan, the agent-attribution gate (audit says "Alice" today, not her agent), and the per-employee
budget attribution problem in §7.

**Second blocker: the assurance ceiling.** `mintPrincipal` always returns `assurance: "low"` from
the envelope, and D14's `approvals.resolveExecute` requires `verified`. Until envelope-derived
principals have a path to `verified`, no agent can ever complete an approved write — the approval
inbox fills and nothing drains. Fixing this and fixing Hermes' own ceiling are the same work.

---

## 6. Pantheon — the owner's master, and why employees cannot reach it

**Shape: Pantheon is central, site-Hermes is per-business, and the link is strictly one-way down.**

This is not a new topology — reuse the hub's existing `HUB_TOPOLOGY` site/central split rather than
inventing a second one.

```
   Discord (owner only)
        ↓
   hermes-Pantheon  ── central, gda-ai01, owner-bound identity, group scope
        ↓ authenticated, one-way
   site Hermes (gaiada) · site Hermes (business N) · …
        ↓
   department agents → hub → platform
```

Rules, enforced in the platform and Cerbos — **never in Discord configuration**:

- Pantheon connects with a **distinct provider** (`x-obo-provider: pantheon`) whose `identity_link`
  resolves to the owner's user with group-executive roles. There is exactly one such link.
- **Site agents cannot call upward.** No tool in a site agent's view reaches Pantheon. The only
  upward channel is notification/approval — a site agent may *ask*, never *invoke*.
- **Employees cannot mint a Pantheon principal**, because the separation is an identity fact, not a
  channel fact. An employee who somehow reached the Discord bot still resolves to their own
  principal and gets their own permissions.
- Pantheon's own writes are still D14-gated. "Owner" is not "ungoverned"; it is the widest scope.

**Sequencing insight worth acting on: build the Pantheon path *before* the employee path.** The
owner is a single verified human, so the owner path needs no delegation and no assurance uplift —
it can ship while §5 is still open. The employee path is gated on §5 and should not be attempted
before it.

---

## 7. Cross-cutting concerns to design in now, not retrofit

- **Cost.** The gateway is the only key-holder, so it is the only honest metering point. Budgets
  needed at three grains: per-goal (exists), per-agent-seat, per-employee-per-day. Enforce the
  standing rule: **no agent seat defaults to Opus**; `model_class` is a budget decision.
- **Durability.** Department goals will outlive a request. Long-running goals need durable state
  (Temporal is deferred and should stay deferred until a real durable flow exists — but the goal
  record must be persisted from day one so adopting it later isn't a rewrite).
- **Evals as the gate.** An agent with no eval suite cannot be enabled — make that a registry
  constraint, not a convention. Agent behaviour is stochastic; "I ran it once" is not evidence.
- **Observability.** Every hop already emits something (hub JSONL audit, agent traces, gateway
  provider reporting). They need one correlation id threaded end-to-end: edge → router → agent →
  tool → model. Without it, "why did the agent do that" is unanswerable.
- **`hermes-gateway` is outside CI** and went five days stale silently. Before it carries employee
  traffic it must be dockerized and in the release pipeline like everything else.
- **Refusal is a feature.** An agent that cannot do something must say so and stop. Silent partial
  completion is the worst failure mode in an ERP.

---

## 8. Build order

Each phase is independently useful and leaves the system coherent if the next one never happens.

**P0 — Contracts (no runtime change).** Freeze: agent registry schema · the delegated-principal
envelope contract · the `agents.*` hub namespace · naming (`dept-*`/`sys-*`/`sec-*`/`edge-*`) ·
the MoE-M capability classes. Write them into `PERMISSION-CONTRACT.md` and the BFF contract.

**P1 — Demote Hermes to router.** Ship the `agents.*` hub namespace and the per-principal tool
view. Cut Hermes' view to the router set. Pilot with **one** department end-to-end — recommend
`dept-pm`, because `task-triager` / `task-filer` / `pm-reporter` already exist and the PM tool
namespace is the deepest. Acceptance: an owner-issued request routes → executes → is auditable, and
Hermes provably cannot call a PM tool directly.

**P2 — Pantheon link.** Central/site wiring, owner identity, one-way enforcement, escalation channel.
Owner gets full function through Discord. Unblocked by §5 — this is why it comes early.

**P3 — Delegation + assurance.** `x-act-for`, double Cerbos check, dual-identity audit, envelope
path to `verified`. **This is the gate on everything employee-facing.** Nothing in P4 ships first.

**P4 — Fan-out.** The remaining departments, then `sys-ops`, then `wa-concierge`. `sec-guard` last
and read-only. One eval suite per agent, written before the agent is enabled.

**P5 — MoE-M + cost governance.** Capability-class routing in the gateway, `isRoutable` consult,
three-grain budgets, per-seat model tiers.

**P6 — Second business.** The real test of the design: a new company should be registry rows plus a
site Hermes, with zero changes to P0/P1. If it isn't, come back to §4.

---

## 9. Open questions for the owner

1. **One site Hermes per business, or one multi-tenant Hermes?** This plan assumes per-business
   (matches the site/central split and keeps blast radius per company). Confirm.
2. **Should `sec-guard` ever write?** Recommend never — propose-only, permanently.
3. **Does an employee talk to Hermes, or to a department agent directly?** This plan assumes always
   through Hermes (one front door, one place routing is observable).
4. **Is the WhatsApp seat allowed to act for an employee at all**, given a phone number is the
   weakest identity in the estate? Recommend read + low_write only, ever.
5. **What is the per-employee daily spend ceiling?** Needed before P5 can be specified.
