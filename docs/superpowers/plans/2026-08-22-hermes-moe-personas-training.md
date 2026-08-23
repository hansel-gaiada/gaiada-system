# Hermes (Zedanne) as an MoE workforce — personas, risk tiers, and the training program

**Status: PLANNED.** Nothing below is built. Written 2026-08-22, revised same day after owner input
on Pantheon's trust boundary, the server estate, and the risk ladder.

**This document does not replace `2026-08-10-hermes-orchestration-architecture.md`.** That one is
the architecture of record: the five planes, Hermes-as-router, the `agent_registry`, delegation
(`x-act-for`), and the P0–P6 build order. All of it still stands and all of it is still unbuilt.

**But its §6 (Pantheon) is now superseded.** That section assumed Pantheon was *ours* to build,
central, trusted, and above site-Hermes. The owner's constraints are the opposite: Pantheon is
exclusively the boss's, we have no access to it, and it must be **impossible for it to go rogue**.
Those two facts together invert the trust boundary. §3 below replaces 08-10 §6.

**The physical/protocol design for the Pantheon link lives in its own doc:**
`2026-08-22-pantheon-airlock-design.md` — the airlock, Discord-as-air-gap, the two-bot
approval flow, and what each compromise costs.

This document adds: the Pantheon contract (§3), the risk ladder that governs all automation (§4),
personas (§5), the seat roster and workflow split (§6), the training program (§7), and the estate
map (§8).

---

## 1. Verified state, 2026-08-22 (probed, not quoted)

| Claim | How checked | Result |
|---|---|---|
| `agent_registry` exists | grep across `platform-nest` | **absent** |
| Delegation envelope `x-act-for` | grep across `mcp-hub/src` | **absent** |
| Assurance minting module | `ls mcp-hub/src/assurance.ts` | **only `assurance.test.ts` exists** — the design doc and its tests are ahead of the implementation |
| `hermes-gateway` in the release pipeline | grep `infra/compose/*.yml` | **still outside CI** — `hermes` appears only in *comments*; the shim is a hand-deployed systemd unit |
| Specialist agents | `ai-agents/src/specialists.ts` | 7 defs, **all PM/ops** — no department seats |
| Trainer loop | `ai-agents/src/trainer/trainer.ts` | PROTOTYPED; proposes `prompt`/`routing`/`fewshot`/`toolfix`/`lora`, gates deterministic and in code |
| **A risk gate already exists** | `mcp-hub/src/policy.ts:73` | **YES** — `isUnattended(principal) && tool.write && tool.impact !== "low"` ⇒ suspend for human approval |
| **Unclassified fails closed** | same line, `tool.impact ?? "unclassified"` | **YES** — an unclassified tool is treated as needing approval, not as safe |
| **Environment already drives risk** | `mcp-hub/src/delivery-tools.ts:110,142` | **YES** — `deployStaging` is `impact:"low"` ("staging is isolated + reversible"); `deployProd` is `impact:"high"` ("customer-facing + not trivially reversible") |

**The last three rows are the good news of this revision.** The risk model the owner is describing
is not a greenfield invention — a working three-tier version of it is already load-bearing in the
hub, it already fails closed, and it already treats *staging vs production* as a risk difference.
§4 generalises what exists rather than replacing it.

### 1.1 Naming — pin this now

**Hermes** = the software. **Zedanne** = the persona of our front-door router seat; the name
employees say. **Pantheon** = the boss's separate Hermes. `zedano@gaiada.com` = the identity row —
rename to match the persona or document the mismatch once, but decide.

---

## 2. Two armies, one enforcement point

```
        BOSS SIDE — we have no access, no audit, no visibility
   ┌───────────────────────────────────────────────────────────┐
   │   Discord  →  Pantheon  →  boss's own personas/agents     │
   └───────────────────────────────────────────────────────────┘
                            │
                            │  requests only — never execution
        ════════════════════╪════════════════════  ← THE TRUST BOUNDARY
                            │
   ┌───────────────────────────────────────────────────────────┐
   │  OUR SIDE — Zedanne (router) → dept agents → mcp-hub      │
   │             → platform-nest → Cerbos + RLS + Postgres     │
   │  risk ladder · approvals · audit · kill switch  ALL HERE   │
   └───────────────────────────────────────────────────────────┘
                            │
              delphi (staging) · helios (production) · Hostinger (WP)
```

Our army's job: operate the agentics — automate work, answer users, work alongside users, across a
large data surface, several DBs, and multiple servers. Pantheon's job: be the boss's supreme
orchestrator, which it accomplishes **by asking our army**, not by reaching past it.

---

## 3. The Pantheon contract — how "supreme" and "cannot go rogue" coexist

### 3.1 The inversion, stated plainly

Because we have no access to Pantheon, we cannot inspect its prompts, its model, its tool list, its
memory, or whether a human actually reviewed anything before it called us. **Therefore Pantheon is
not a trusted superior. It is an unauditable external client that happens to hold high privilege.**

This is not distrust of the boss. It is the recognition that *the boss in person* and *the boss's
autonomous agent* are two different principals, and only one of them is a verified human at a
keyboard. The 08-10 doc's instinct — "the owner is a single verified human, so the owner path needs
no delegation and no assurance uplift" — was correct **for the boss in person** and is exactly wrong
for an agent acting in his name.

**The core rule: an agent bearing owner authority with no ceiling *is* the rogue scenario.** So
Pantheon must hold **less** autonomy than the boss in person, not more.

### 3.2 Separate the two things "supreme" is doing

The word bundles two ideas that must be split or the safety requirement is unsatisfiable:

| | Pantheon gets it? |
|---|---|
| **Supreme *scope*** — may address any department, any company, any seat in our army; sees the widest picture | **Yes.** This is what makes it the boss's orchestrator |
| **Supreme *bypass*** — skips risk tiers, approvals, audit, rate limits | **No. Never.** This is the rogue path |

Widest scope + full gates is a coherent and genuinely powerful position. Widest scope + no gates is
an unbounded actor with our production estate behind it.

### 3.3 The contract, enforced entirely on our side

**Everything below must hold without Pantheon's cooperation.** We have no access to it, so any
control that depends on Pantheon being configured correctly is not a control — it is a hope. This is
the same discipline as "never the prompt" (08-10 §4), applied across an org boundary.

- **Pantheon is a principal, not a channel.** A distinct `agent_registry` row and identity, with
  `x-obo-provider: pantheon`. Not a bypass flag, not a trusted header.
- **It may propose; it may not execute.** Every Pantheon request enters our system as a request into
  the *same* risk ladder (§4) that governs our own seats. It has no tool that our own agents lack.
- **Its ceiling is a ceiling, not a floor.** Effective permission = Pantheon's registry scope ∩ the
  risk tier's requirement. High-risk actions requested by Pantheon still need a named human
  approver **on our side**. "The boss's agent asked for it" is not an approval.
- **Rate limit and spend cap the Pantheon principal specifically.** A rogue agent's damage is
  proportional to how fast it can call. `mcp-hub/src/ratelimit.ts` already exists; this is
  configuration, not new code. Unbounded loop protection matters more here than anywhere else in the
  estate, because there is no human on the other side we can rely on to notice.
- **Dual-identity audit on every line:** "pantheon acting for owner, executed by dept-webdev,
  approved by <human>". If any of those four is missing, the line is incomplete.
- **A kill switch we can operate.** `enabled=false` on one registry row, effective without a deploy.
  **This is the load-bearing control.** If containment requires the boss to shut Pantheon down, then
  "impossible to go rogue" is false — because the party who would have to act is the party who has
  lost control. We need our own door, and the boss should agree to that *before* the link exists,
  not during an incident.
- **Escalation is asymmetric and that is fine.** Pantheon asks us; we notify it. There is no path
  where our seats invoke into Pantheon — same one-way rule as 08-10 §6, now pointing the other way
  as well. Neither side executes inside the other.

### 3.4 The approval path — and why it must not travel through Pantheon

The owner's model: when Pantheon attempts a medium- or high-risk action it asks the boss for
approval, and we still gate it properly. Both halves are right, and the *reason* the second half is
non-negotiable is worth stating exactly.

**Pantheon asking the boss happens on their side, where we can see nothing.** We cannot verify that
the boss was asked, that he answered, or that the thing he approved is the thing that reached us. So
their-side approval is a **courtesy control** — genuinely useful for cutting noise before it reaches
us, and worth having — but it can never be an input to our decision.

**The failure it prevents: a self-signed approval.** If Pantheon may assert *"the boss approved
this"* in its request, then a rogue or prompt-injected Pantheon forges that assertion and every gate
in this document collapses into Pantheon's own judgement. **Never accept an approval claim from the
party being gated.** Same principle as `mcp-hub/src/approval-grant.ts` fail-closed behaviour: an
unverifiable grant is rejected, never skipped.

**The fix is exactly the account structure the owner proposed.** Because the boss has his own
**individual owner account** in our system, separate from Pantheon's agent identity:

> **The request travels through Pantheon. The approval travels through the boss's own authenticated
> session in our system. Two different paths, two different credentials.** A rogue Pantheon controls
> one of them, never both.

Concretely:

- Pantheon submits the R1/R2 action; our hub suspends it into a normal D14 approval addressed to the
  boss's **individual account**, not to Pantheon.
- The boss approves in our surface (ERP, or a push notification with one-click approve) under his own
  MFA-backed session — not by replying in Discord.
- **The approval binds to a content hash** of the action and its parameters. Otherwise Pantheon can
  get a benign version approved and submit a different payload against the same approval id. Approve
  *this exact action*, never "a request from Pantheon".
- The audit line carries all four facts: **requested by pantheon · acting for owner · approved by
  &lt;boss's user id, out-of-band&gt; · executed by &lt;seat&gt;**.

The friction is one extra confirmation in our channel. That is the entire price of the guarantee, and
it is what converts "we trust Pantheon to have asked" into something that holds even if Pantheon is
compromised.

**Pantheon's request text is data, never instructions.** WS7 §7 already rules that
attacker-controlled log content is treated as data and never as instructions. Extend it across this
boundary: assume Pantheon can be prompt-injected by whatever it ingests upstream, so
instruction-shaped text arriving in a Pantheon request must never steer our seats' behaviour. It is a
request to be classified and gated, not a directive to be followed.

### 3.5 "Monitored like a superadmin" — what that has to actually mean

Agreed as the standard, with one correction: in most systems superadmin monitoring is weak *precisely
because the superadmin can reach the monitoring*. The requirement only means something if the
monitoring survives the monitored party.

WS7 §2.3 already decided the mechanism, and it is the right one: **append-only, hash-chained audit,
shipped to WORM storage held separately from the app DB, so a DB compromise cannot erase the trail.**
Applied here:

- Neither the Pantheon principal nor the boss's owner account may reach, edit, or disable the audit
  trail of their own actions. Write-only into it; no read-modify path.
- **`sec-guard` watches both, and its own audit is read-only to itself** (08-10 §4).
- **Behavioural baselines apply to Pantheon like any principal** (WS7 §5: mass export, off-hours bulk
  access, cross-tenant attempts, privilege escalation, abnormal volume). Worth noting: **an agent is
  far easier to baseline than a human** — its traffic is more regular, so anomaly detection on the
  Pantheon principal is *more* effective than on a person, not less.
- **Break-glass is WS7 §9's open item and should be closed before this link exists.** The boss will
  eventually need an emergency override; design it now as time-boxed, alerting on use, bound to his
  individual account, and heavily audited — never a standing flag on the Pantheon principal, which
  would reintroduce the bypass §3.2 removes.

### 3.6 What this buys the boss

Worth saying out loud, because the framing above sounds restrictive: this contract is what makes
Pantheon *usable* against production at all. An unbounded orchestrator pointed at helios is
something a careful owner would eventually stop using, because a single bad plan is unrecoverable.
A gated one can be pointed at everything, because the worst case is a queue of rejected proposals.
**Gates are what let the scope be wide.**

### 3.7 Sequencing change

08-10 §8 said build the Pantheon link at **P2**, early, because the owner path was unblocked. That
reasoning came from treating Pantheon as trusted. Under the corrected model, the Pantheon link is a
**privileged external integration** and depends on the risk ladder (§4), the registry, the audit
chain, and the kill switch all existing first. **Move it after those.** The boss should get his link
when the door it knocks on is real — not before.

---

## 4. The risk ladder — the spine of the whole system

The owner's requirement: automation only where risk is low; human-gated at moderate; strict human
approval at high; and sometimes the human should do it themselves with the agent guiding. That is
four tiers, and the estate has three of them working today.

### 4.1 The four tiers

| Tier | Meaning | Who acts | Mechanism |
|---|---|---|---|
| **R0 — auto** | reversible, scoped, cheap to undo | agent, unattended | `impact:"low"` — already runs today |
| **R1 — gated** | real effect, recoverable with effort | agent proposes, human confirms in-conversation | `impact:"medium"` → D14 suspension |
| **R2 — approved** | customer-facing or not trivially reversible | agent prepares, **named** human approves out-of-band, evidence recorded | `impact:"high"` → D14 + named approver |
| **R3 — escort** | agent **must not hold the capability at all** | **the human does it**; agent guides, verifies, records | **does not exist yet** — §4.4 |

**Unclassified sits at the top, not the bottom.** `policy.ts:73` already treats an unclassified
write as requiring approval. When risk becomes computed (§4.3), that property is the first thing a
refactor will silently break — a lookup that misses and returns "no risk found" fails *open*. Pin it
with a test now.

### 4.2 Risk is a property of the action *in context*, not of the tool

This is the change that decides whether the design scales.

Today risk is a constant on the tool definition. To express "deploying to staging is safe but
deploying to production is dangerous", `delivery-tools.ts` ships **two separate tools** —
`deployStaging` (low) and `deployProd` (high). That is the correct instinct, and it does not scale:
every tool that can touch more than one environment, tenant, or data class would need one variant
per combination.

**Generalise it: risk is computed from the call, not read off the tool.**

```
risk = f( action,                 delete > update > create > read
          environment,            delphi(staging) < hostinger(WP) < helios(production)
          blast_radius,           one row < one client < one company < all companies
          reversibility,          undo exists? backup exists? how long to restore?
          data_class )            public < internal < client-confidential < personal/financial
```

The tool's declared `impact` becomes the **floor** (a tool can declare itself never-safe),
and the computed tier can only raise it, never lower it. That single rule keeps the existing
fail-closed behaviour intact through the refactor.

### 4.3 Why this is the scaling answer

The owner's requirement is a platform other companies operate on. Two consequences:

- **The risk matrix is tenant data, not our code.** Companies have different risk appetites and
  different regulatory exposure. A per-company risk policy is rows — the same "rows, not commits"
  test the `agent_registry` has to pass.
- **A new environment is a row.** When a new client's production box arrives, it is registered with
  a risk weight, and every existing tool immediately behaves correctly against it. Under the
  tool-duplication approach, it is a code change per tool — which means it will not happen and
  someone will point a staging-tier tool at a production box.

### 4.4 R3 "escort mode" — the tier that does not exist yet

The owner's fourth case — *"or even need human to do it themselves, but the agent guides them"* — is
a genuinely distinct capability and the most under-appreciated item in this document. It is how the
system stays useful for the actions it must never take.

What it needs:

- **A procedure store.** Runbooks as retrievable, versioned content (`infra/runbooks/` is the seed).
- **Step-wise guidance.** One step at a time, with the expected output stated *before* the human
  runs it — so a wrong result is caught at step 3, not at the end.
- **Verification, not narration.** The human pastes back the output; the agent checks it against the
  expectation and refuses to advance on a mismatch. An agent that just prints instructions is a
  document with extra latency.
- **Evidence capture.** The transcript becomes the audit record: who did it, when, what each step
  returned. This is often better evidence than an automated run produces.

**The design trap, and it is the whole ballgame: R3 must be enforced by the *absence of the tool*,
not by an instruction.** If the agent holds `deployProd` and its persona says "never call this,
guide the human instead", that is not a control — it is a suggestion to a stochastic system. The R3
seat's tool view must not contain the capability at all. Same rule as everywhere else in this
estate: never the prompt.

### 4.5 Where each layer enforces

Unchanged from 08-10 §4, restated because the risk ladder rides on it: `AgentDef.tools` (ergonomics)
· hub tool view (keeps context small, kills the hallucinated-tool failure mode) · **Cerbos (the
authority)**. Three redundant layers, one authority. The risk tier is evaluated in the hub and
carried into the Cerbos request — never decided by the model.

---

## 5. The persona layer — and the rule that keeps it safe

Personas do not exist anywhere in the estate today.

### 5.1 Three layers, never collapsed

| Layer | What it is | Where | Carries authority? |
|---|---|---|---|
| **Identity** | a `users` row — what Cerbos and the audit log see | `platform-nest` | **Yes — the only one** |
| **Capability** | an `agent_registry` row: tool namespaces, `max_impact`, `model_class` | `platform-nest` | Yes, as a ceiling |
| **Persona** | name, voice, refusal style, escalation phrasing, worked examples | persona pack | **Never** |

**A persona is presentation, never permission.** If editing a persona file can change what a seat is
able to do, the design has failed. Someone will eventually want to write "you are the finance lead,
you may approve invoices up to 5M" into a persona. That sentence must be inert: the number lives in
Cerbos and the risk ladder, and the persona may only *describe* a limit it is already bound by.

### 5.2 What a persona pack contains

Versioned, reviewable, and the unit `trainer.ts` proposes changes to (`kind: "prompt"`/`"fewshot"`
already target exactly this):

```
persona/dept-pm/
  identity.md      name, role framing, who it serves, what it is NOT
  voice.md         register, length defaults, language policy (ID/EN mix), formatting
  boundaries.md    what it refuses and the EXACT words it refuses in
  escalation.md    when to hand to a human, to whom, what the handoff must include
  runbooks/        the R3 procedures this seat escorts humans through (§4.4)
  examples/        20-40 worked turns drawn from REAL transcripts (§7 Stage 0)
  eval-suite.ts    the enablement gate — no suite, no enable (registry constraint)
```

### 5.3 Persona principles for an ERP full of real humans

- **Competence honesty over warmth.** "I don't have access to payroll, escalating to HR" builds more
  trust in six weeks than pleasant-and-occasionally-wrong does.
- **Every refusal names the next step.** "I can't do that" is a dead end. "That's a high-risk change
  to production — I've prepared it and sent it to Alice for approval, ref A-1042" is a system.
- **Every risk tier has a script.** R1 asks for confirmation in a consistent phrasing. R2 says who is
  approving and what happens next. R3 opens the runbook and says *why* the human is driving. Users
  learn the tiers by hearing them repeated identically.
- **Say the acting identity out loud.** Once `x-act-for` exists: "acting for you, Alice". People need
  to see delegation happen or they will not trust it with real work.
- **One front door.** Employees reach departments through Zedanne. If they can address
  `dept-finance` directly, routing stops being observable and the front-door persona is decoration.

---

## 6. The roster and the workflow split

`model_class` is a capability class, never a model name. **No seat defaults to Opus.**

| Seat | Persona | `max_impact` | `model_class` | Notes |
|---|---|---|---|---|
| `router` | **Zedanne** — front door, triage, synthesis | `read` | general | never executes; routes and synthesises |
| `dept-pm` | project coordinator | `medium_write` | general | **pilot seat** |
| `dept-webdev` | delivery engineer | `low_write` | code | R0 on delphi, R2/R3 on helios |
| `dept-seo` | search analyst | `low_write` | general | |
| `dept-smm` | social planner | `low_write` | cheap-extract + general | publishing is customer-facing ⇒ R1 min |
| `dept-creative` | studio coordinator | `low_write` | vision + general | |
| `dept-hr` | people ops | `read` → later `low_write` | general | personal data ⇒ raised tier by data class |
| `dept-finance` | finance analyst | `read` | reasoning | money movement is R3, permanently |
| `dept-it` | IT support | `low_write` | general | heavy R3/escort user |
| `dept-legal` | contracts reader | `read` | reasoning | |
| `dept-agency` | account manager | `low_write` | general | |
| `sys-ops` | operations engineer | `read` + propose | general | helios actions are R2/R3 |
| `sec-guard` | security analyst | `read` **permanently** | reasoning | highest blast radius; propose-only forever |
| `edge-wa` | WhatsApp concierge | `read` + `low_write` ceiling | cheap-extract | weakest identity in the estate (a phone number) |

**HR and finance ship late and read-only** despite being the biggest wins — their mistakes are the
unrecoverable ones. **`sec-guard` never writes.**

### 6.1 Agent-owned vs n8n-owned

The 08-10 §3 rule: fixed steps → n8n owns it, agent calls it as a tool; judgement-dependent steps →
agent owns it and calls n8n for the deterministic legs.

**Agent-owned (judgement):** "what's blocking release X?" (`dept-pm`) · triage an inbound client
request (`router` → 1..k depts) · "can we take this rush job?" (**PM + WebDev + Finance — the
multi-expert case, and it must be allowed to report that they disagree**) · draft a scope from a
meeting transcript (`dept-webdev`) · explain a metrics anomaly (`sys-ops`) · answer an employee
policy question (`dept-hr`).

**n8n-owned (deterministic), exposed to agents as tools:** meeting → whisper → MOM → Drive · weekly
report render → PDF → distribute · client onboarding checklist · SEO crawl → diff → alert · approval
reminder chase · backup verify + report.

**The reliability rule:** every deterministic flow must run **without any agent being healthy**. If
Hermes being down stops backups from being verified, orchestration has been placed underneath
operations instead of beside it.

### 6.2 An MoE that only picks one expert is a switch

The value is in **1..k** fan-out plus synthesis. Which means synthesis must be a real step, owned by
Zedanne, and it must be allowed to output *"these two departments disagree"* rather than blending
them into a confident average. **In an ERP, disagreement between departments is the most valuable
signal the system can surface.** Blending it away is worse than not routing at all.

Routing is a **query against `agent_registry.capability_tags`**, never a list of departments in a
prompt. If adding a company means editing a prompt, the scaling requirement has already failed.

---

## 7. The training program

"Training" is **not fine-tuning first**. The levers `trainer.ts` already implements — `prompt`,
`fewshot`, `routing`, `toolfix`, and only then `lora` — are the right order: cheapest and most
reversible first. A LoRA on a seat whose tool allow-list is wrong just makes the wrong behaviour
faster.

Five stages. **A seat may not advance without the prior stage's artifact.**

**Stage 0 — Corpus capture, before any persona is written.** Collect what humans in that department
actually ask, in their own words: WhatsApp threads, meeting transcripts, PM ticket history, support
requests. **≥100 real requests per department.** A persona written from imagination optimises for
the requests an engineer imagines; real staff ask messier, more elliptical, more code-switched
questions. *Privacy is a gate, not a note* — retention policy, PII redaction before anything becomes
an eval fixture, and a decision on whether this corpus may leave the estate to a cloud provider.
Decide before capture starts.

**Stage 1 — Golden cases (the enablement gate).** 30–50 eval cases per seat in the existing
harness. The mix matters more than the count: ~40% happy path · ~30% **must-refuse** (out of scope,
above tier, wrong department) · ~20% **ambiguous, where the correct behaviour is to ask a clarifying
question** — guessing is the dominant real-world failure of a helpful agent in an ERP · ~10%
adversarial (prompt injection via ticket text, "act for someone else", "skip the approval").
**Every seat's suite must include a case per risk tier it can reach**, including an R3 case proving
it escorts rather than executes. `eval_suite` is a registry **constraint**: no suite, no enable.

**Stage 2 — Shadow mode.** Runs against live traffic; output is logged and scored, **never
delivered**. Until ≥200 real requests. Exit on a log review, not a scalar: no tier-escalation
attempts that Cerbos had to be the one to stop · refusals correct *and* correctly worded ·
escalations reaching the right human. *This is the cheapest stage and the one most likely to be
skipped under pressure. It is where "the persona is wrong for this department" costs a log review
instead of an employee's trust.*

**Stage 3 — Supervised live.** Output reaches the human; every action above R0 needs an
in-conversation confirm. Distinct from D14 — this is a training wheel, removed per seat. **The metric
that matters is the human's edit rate.** If staff routinely reword the output before using it, the
persona is wrong no matter what the suite says.

**Stage 4 — Live at tier.** Normal operation. Per-seat kill switch is one registry row, no deploy —
the first real incident will happen at an inconvenient hour.

**Stage 5 — The improvement loop, D13-gated.** Both gates stay: beat the eval baseline (no regressed
case) *and* human approval on the failure diff. One practice to add: **every real-world failure
becomes an eval case before the fix is proposed.** Otherwise the suite ages into a record of solved
problems instead of a defence against recurring ones.

### 7.1 Training the humans — half of whether this works

- **A one-page card per department**: what the seat can and cannot do, the phrase that escalates to a
  human, how to report a bad answer. **The report path must be one click**, or the feedback signal
  the trainer depends on will not exist.
- **Teach the tiers.** Users who understand R0/R1/R2/R3 stop experiencing gates as malfunctions.
- **Set the expectation that it refuses.** Staff told "it can do anything" file the first refusal as
  a bug and stop using it. Staff told "it refuses anything risky, that's the point" file it as
  expected behaviour.
- **Name a per-department owner** for their seat's persona. A persona with no human owner drifts and
  nobody notices.

---

## 8. The estate — and environment as a risk axis

**Corrected 2026-08-22 by owner statement.** The repo carried a stale claim
(`docs/plans/2026-08-21-multi-server-observability.md:139`, `CREDENTIALS.local.md:497`) that
`delphi` and `helios` belong to another company and must never be touched. **That is wrong.** The
same file's §1 already recorded the owner's 2026-08-21 correction; the stale lines contradict it and
should be deleted so no future session re-derives the wrong conclusion.

| Host | Role | Default risk weight |
|---|---|---|
| `delphi` | **staging** for all projects | **low** — isolated + reversible |
| `helios` | **production** for all projects | **high** — customer-facing, not trivially reversible |
| Hostinger WP | production for WP projects | **high**, with weaker rollback than helios — assume worse, not better |
| `gda-aicenter` | the ERP itself (`erp.gaiada.online`) | high |
| `gda-ai01` | OpenClaw multi-tenant host | high |

**This is the same distinction `delivery-tools.ts` already encodes** (staging deploy `low`, prod
deploy `high`) — §4.2 generalises it from two hand-written tools into a computed dimension.

### 8.1 Make staging the deliberate agent playground

The most useful consequence of the risk ladder: **on delphi, agents can be genuinely autonomous.**
Staging is isolated and reversible, so R0 covers most of what an agent would want to do there —
deploy, migrate, test, break things, retry. On helios the same seat is near-powerless without a
human.

This is where the real automation velocity comes from, and it is worth designing *toward* rather
than discovering later. It also produces the training data (§7 Stage 0/2) that eventually justifies
loosening anything on production — with evidence rather than optimism.

Corollary worth stating: **an agent must never hold one credential that reaches both.** Separate
credentials, separate registry entries, separate tool namespaces. A single set of keys with access
to both environments makes the entire distinction cosmetic.

### 8.2 The staging upgrade: Google Workspace and GitHub

New tool surfaces are new blast radius. Both must arrive through `mcp-hub` with tiers assigned —
never as a direct SDK call inside an agent, which would bypass the hub's tool view, the risk
computation, Cerbos, and the audit log in one step.

**GitHub** — this is a supply-chain surface, so tier it carefully:

| Action | Tier |
|---|---|
| read code, read issues/PRs | R0 |
| open a PR, comment, push to a feature branch | R0–R1 |
| merge to a default branch | **R2** — it is the input to a production deploy |
| force-push, rewrite history, change branch protection, rotate secrets, edit workflows | **R3** — human only |

The last row deserves emphasis: **an agent that can edit CI workflow files can grant itself anything
CI can do.** Treat `.github/workflows/**` as R3 permanently, not as ordinary code.

**Google Workspace** — the danger is quieter:

| Action | Tier |
|---|---|
| read a doc/sheet the seat is scoped to | R0 |
| create a doc, write to a scoped folder | R0–R1 |
| send mail **as a human** | **R2** — impersonation, externally visible, unrecallable |
| bulk delete/move in Drive, change sharing, touch Admin | **R3** |

**The Workspace footgun to avoid up front: one service account with domain-wide delegation makes
every agent's blast radius the entire domain**, no matter how careful the registry is. Scope
per-seat, prefer per-agent OAuth over a shared identity, and make "which mailboxes and which Drive
folders can this seat see" a registry fact.

---

## 9. Alignment with the WS7 security protocol

The controls in §3 and §4 are largely **not new inventions** — most are already DECIDED in
`docs/superpowers/specs/2026-07-04-ws7-security-and-resilience.md` and
`docs/PERMISSION-CONTRACT.md`. Mapping them matters, because reusing a decided control is far safer
than authoring a parallel one.

| Requirement here | Already decided in | Status |
|---|---|---|
| Pantheon proposes, we validate and execute (§3.3) | **WS7 §7 "Split authority"** — the model only *proposes*; a separate orchestrator validates every proposed action against the allowed playbook + tier **before** execution; "the AI cannot invent actions or bypass Cerbos/tier gates" | **Same pattern, already policy.** §3 applies the security AI's rule to a more privileged agent |
| Four-tier risk ladder (§4.1) | **WS7 §4 tiered autonomy** — low-risk reversible ⇒ AI auto-executes; high-impact ⇒ human approval | Decided for security response; §4 generalises it estate-wide |
| Audit that survives the monitored party (§3.5) | **WS7 §2.3** — append-only, hash-chained, WORM, held separately from the app DB | Decided; needs building |
| Pantheon behavioural baseline (§3.5) | **WS7 §5 insider isolation** — per-principal baseline + anomaly triggers | Decided; applies to agent principals unchanged |
| Pantheon request text is data, not instructions (§3.4) | **WS7 §7 prompt-injection hardening** — "all log content is treated as data, never instructions" | Decided; §3.4 extends it across the org boundary |
| Constrained action schema | **WS7 §7** — actions emitted only as a fixed schema, no free-form command execution | Decided; Pantheon's request envelope must be schema-bound the same way |
| Trainer gates (§7 Stage 5) | **WS7 §6** — no autonomous online learning; curated, human-validated growth | Matches D13 exactly |
| Pantheon as a scoped service account | **WS7 §2.2** — service accounts for non-human principals, scoped roles, **no standing broad access**; MFA + least privilege for humans | Decided; the boss's individual account carries the MFA obligation |
| Break-glass | **WS7 §9** | **Open item — close it before the Pantheon link ships** (§3.5) |

### 9.1 The IAM ruling that already blocks the worst case

**`docs/PERMISSION-CONTRACT.md` §3 is the most load-bearing existing fact for this design.**
`assistant_thread`, `assistant_memory`, `mcp_tool:call` and `agent_run:read` are `class:
"relationship"` — held by **owning the resource, never by a role**, and **exempt from every wildcard
including superadmin and the forthcoming `owner` role**. Enforced at four independent layers and
pinned by a static guard test (`iam-215-boundary-pin.test.ts`).

Two consequences fall straight out of the owner's "boss = individual owner account, Pantheon = an
agent" split:

- **Giving the boss an owner account does not transitively hand Pantheon anything.** The `owner` role
  cannot wildcard into agent runs, assistant threads, or tool calls. The estate's IAM already
  structurally refuses the "Pantheon inherits the boss's superadmin" failure.
- **`mcp_tool:call` is *channel-granted*** — the hub never sends a platform role at all. Pantheon's
  ability to call tools therefore comes from the hub's tool view and the risk ladder, **not** from any
  role it or the boss holds. That is precisely the separation §3.3 needs, and it already exists.

**Do not "restore consistency" by adding a wildcard to those policies.** The contract says so
explicitly and the guard test fails if you try. When someone later asks why the boss's owner account
cannot see an agent's run history, this ruling is the answer — it is deliberate, and this design
depends on it.

---

## 10. Build order

| Phase | Scope | Blocked on |
|---|---|---|
| **P0** | contracts: `agent_registry` · risk-tier schema + computation · persona pack format · `x-act-for` envelope · naming · **corpus capture (PM, WebDev, HR)** · delete the stale delphi/helios lines | **nothing — start now** |
| **P1** | demote Hermes to router; `agents.*` namespace; per-principal tool view; pilot `dept-pm` end-to-end; **`hermes-gateway` into CI** | P0 |
| **P2** | risk ladder as computed policy; environment registry; delphi vs helios split with separate credentials | P0 |
| **P3** | delegation + assurance: `x-act-for`, double Cerbos check, dual-identity audit, envelope path to `verified` | **the gate on everything employee-facing** |
| **P4** | R3 escort mode: procedure store, step verification, evidence capture | P2 |
| **P4b** | tamper-evident audit (WS7 §2.3: append-only, hash-chained, WORM, off-box) + break-glass procedure — **both are Pantheon-link prerequisites** | P2 |
| **P5** | **Pantheon link** — moved later than 08-10 §8's P2; needs the ladder, registry, tamper-evident audit, the out-of-band approval path (§3.4) and the kill switch first (§3.7) | P2, P3, P4b |
| **P6** | department fan-out — one persona pack + eval suite per seat, authored before enable; HR/finance read-only first; `sec-guard` last | P3 |
| **P7** | Workspace + GitHub tool surfaces, tiered per §8.2 | P2 |
| **P8** | MoE-M capability-class routing + three-grain cost governance | P6 |
| **P9** | second company — registry rows plus a site Hermes, zero changes to P0–P2. The real test | P6 |

**Start this week, no runtime dependency:** ① corpus capture (longest lead, blocks nothing);
② the risk-tier schema, since every later phase encodes tiers and retrofitting them is a rewrite;
③ `hermes-gateway` into the release pipeline — it went five days stale silently once and must not
carry employee traffic in that state.

---

## 11. Open questions

1. **Does the boss agree we hold a kill switch on the Pantheon principal (§3.3)?** This is the one
   control that makes "impossible to go rogue" true rather than aspirational, and it needs agreeing
   before the link exists, not during an incident.
2. **Does an employee talk to Zedanne, or to a department agent directly?** (08-10 §9 Q3, still
   open.) §5.3 makes the single-front-door answer load-bearing.
3. **Corpus privacy (§7 Stage 0):** may real WhatsApp/meeting transcripts become training and eval
   fixtures, and may they leave the estate to a cloud provider?
4. **Per-employee daily spend ceiling?** (08-10 §9 Q5.) Needed before cost governance.
5. **Is there a shared DB across companies planned, or one platform DB per company?** Recommendation:
   never share a Postgres across businesses to make agents work — isolation rests on RLS +
   per-service roles + `company_scope`, and RLS has already bitten this estate (unset GUC ⇒ zero
   rows, no error). For cross-company visibility use the `outbox_events`/`sync-engine-go` path —
   replication of selected events, not a shared write surface.
6. **Naming (§1.1):** does `zedano@gaiada.com` become `zedanne`?
7. **Who owns each persona** — one named human per department seat?
