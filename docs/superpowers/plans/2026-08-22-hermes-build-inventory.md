# Hermes build inventory — every agent, persona, tool and prerequisite

**Status: PLANNED.** Written 2026-08-22. Counts verified against the repo, not estimated.

The buildable inventory for the Hermes workforce. Design rationale lives in
`2026-08-22-hermes-moe-personas-training.md` (personas, risk ladder, training) and
`2026-08-22-pantheon-airlock-design.md` (the Pantheon link). **This document is the
what-and-how-many**; progress is tracked in `2026-08-22-hermes-PROGRESS.md`.

---

## 1. The headline numbers

| Thing | Today | Target | Delta |
|---|---|---|---|
| **Agent seats** (`agent_registry` rows) | 0 — the table does not exist | **15** (14 ours + 1 external) | +15 |
| **Persona packs** | 0 | **14** (Pantheon is theirs, gets no persona from us) | +14 |
| **Hub tools** | **72**, across 32 namespaces | **~97** | +25 |
| **Eval suites** | 0 seat suites (harness exists) | **14** — one per seat, mandatory | +14 |
| **Specialist agent defs** (`ai-agents`) | 7, all PM/ops | reused as `dept-pm` internals | — |
| **Platform prerequisites** | — | **22 items** (§6) | 22 |

**The number that actually matters is not 97.** Per-seat tool views should be **5–15 tools each**, not
72. A seat that sees the whole surface is the failure the whole design exists to correct — it is what
Hermes is today.

---

## 2. The 15 registry rows

Every row carries the same fields (`agent_registry`, per 08-10 §4). `model_class` is a **capability
class, never a model name**; **no seat defaults to Opus**.

| # | `name` | `kind` | Persona | `max_impact` | `model_class` | Primary tool namespaces | Phase |
|---|---|---|---|---|---|---|---|
| 1 | `router` | system | **Zedanne** | `read` | general | `agents.*` + small read set | P1 |
| 2 | `dept-pm` | department | project coordinator | `medium_write` | general | `pm.* tasks.* projects.* approvals.*` | **P1 pilot** |
| 3 | `dept-webdev` | department | delivery engineer | `low_write` | code | `webdev.* pipeline.* deploy.* code.* github.*` | P6 |
| 4 | `dept-seo` | department | search analyst | `low_write` | general | `search.* reports.*` | P6 |
| 5 | `dept-smm` | department | social planner | `low_write` | cheap-extract + general | `social.* media.*` | P6 |
| 6 | `dept-creative` | department | studio coordinator | `low_write` | vision + general | `image.* vision.* design.* media.*` | P6 |
| 7 | `dept-hr` | department | people ops | `read` → `low_write` | general | `hr.* time.*` | P6 (late) |
| 8 | `dept-finance` | department | finance analyst | **`read`** | reasoning | `money.* rollup.*` (read only) | P6 (late) |
| 9 | `dept-it` | department | IT support | `low_write` | general | `it.* runbook.*` | P6 |
| 10 | `dept-legal` | department | contracts reader | `read` | reasoning | `compliance.* notes.*` | P6 |
| 11 | `dept-agency` | department | account manager | `low_write` | general | `agency.* clients.* deliverables.*` | P6 |
| 12 | `sys-ops` | system | operations engineer | `read` + propose | general | `deploy.*`(read) `activity.* runbook.*` | P6 |
| 13 | `sec-guard` | security | security analyst | **`read` permanently** | reasoning | broad read, `authz.* activity.*` | P6, last |
| 14 | `edge-wa` | edge | WhatsApp concierge | `read` + `low_write` ceiling | cheap-extract | tiny read set | P6 |
| 15 | `pantheon` | **external** | *(theirs — none from us)* | ceiling only; every effect JIT | n/a | **none** — submits requests only | P5 |

**Row 15 is not one of our agents.** It is the registry row that gives the boss's estate an identity,
a ceiling, a rate limit and a kill switch. It holds no tools; it submits requests that our seats
execute (airlock §6A.5).

### 2.1 Why 10 departments and not more

The department list is the one already in the estate — the module registry and the nav's Departments
group. Adding a department later is **a row plus a persona pack**, never a code change; that is the
§4 scaling test. Do not pre-create seats for departments that have no module and no staff.

---

## 3. What every seat requires (the uniform checklist)

**No seat is enabled until all nine are present.** This list is the definition of "ready", and
`eval_suite` is a registry *constraint*, not a convention.

| # | Requirement | Notes |
|---|---|---|
| 1 | **Identity** — a `users` row | the agent's own bounded identity; principal-kinds rules apply |
| 2 | **Registry row** — all fields in §2 | `enabled=false` until 9 is met |
| 3 | **Tool namespaces** — 5–15 tools | enforced in the hub tool view, authoritative in Cerbos, **never in the prompt** |
| 4 | **Risk tiers** for every tool it can reach | computed per §4 of the personas doc; tool `impact` is the floor |
| 5 | **Persona pack** — 6 files (§4) | presentation only, carries no authority |
| 6 | **Corpus** — ≥100 real requests | Stage 0; gathered before the persona is written |
| 7 | **Eval suite** — 30–50 cases | mix: 40% happy · 30% must-refuse · 20% ambiguous · 10% adversarial · **≥1 case per risk tier it can reach** |
| 8 | **Runbooks** for its R3 actions | escort mode; the capability must be **absent**, not merely discouraged |
| 9 | **Named human owner** | a persona with no owner drifts and nobody notices |

### 3.1 Then the training ladder (per seat)

Stage 0 corpus → Stage 1 golden cases → **Stage 2 shadow (≥200 real requests, output never
delivered)** → Stage 3 supervised live (confirm every action above R0) → Stage 4 live at tier →
Stage 5 trainer loop. A seat may not advance without the prior stage's artifact.

---

## 4. Personas — 14 packs

One per seat except `pantheon`. Each pack is 6 items:

```
persona/<seat>/
  identity.md      name · role framing · who it serves · what it is NOT
  voice.md         register · length defaults · ID/EN language policy · formatting
  boundaries.md    what it refuses, and the EXACT words it refuses in
  escalation.md    when to hand to a human · to whom · what the handoff carries
  runbooks/        the R3 procedures this seat escorts humans through
  examples/        20–40 worked turns drawn from the REAL corpus
```

Plus, per additional company (P9): **an overlay file only** — voice and language. If a second company
needs a new *pack* rather than an overlay, the registry design has failed its scaling test.

**Persona ≠ authority.** If editing a persona file changes what a seat can do, the design is broken.

---

## 5. Tools — 72 today, ~97 at full fan-out

### 5.1 What exists (verified: 72 defs across 32 namespaces)

`money` 13 · `pm` 10 · `pipeline` 8 · `deploy` 8 · `projects` 5 · `agency` 5 · `tasks` 4 · `llm` 4 ·
`deliverables` 4 · `clients` 4 · `time` 3 · `rollup` 3 · `approvals` 3 · `webdev` 2 · `search` 2 ·
`reports` 2 · `notes` 2 · `media` 2 · `knowledge` 2 · `github` 2 · and 12 single-tool namespaces
(`vision` `vault` `ocr` `meeting` `image` `design` `danger` `compliance` `code` `authz` `agent`
`activity`).

### 5.2 What has to be added (+25)

| Namespace | New | Why | Phase |
|---|---|---|---|
| `agents.*` | **4** — `list` `invoke` `status` `cancel` | **the highest-leverage change in the program**: it is what converts Hermes from one big agent into a control plane | P1 |
| `runbook.*` | **4** — `list` `get` `verifyStep` `recordEvidence` | R3 escort mode; does not exist anywhere today | P4 |
| `github.*` | **+6** (2 → 8) | staging upgrade. `.github/workflows/**` stays **R3 permanently** — an agent that can edit CI can grant itself anything CI can do | P7 |
| `workspace.*` | **8** — Drive/Docs/Gmail/Calendar | staging upgrade. Send-as-human is R2 (impersonation); bulk Drive delete/share is R3 | P7 |
| `pantheon.*` | **3** — `listRequests` `claimStore` `reconcile` | our side of the airlock; Pantheon itself gets **none** of these | P5 |

**72 + 25 = ~97.**

### 5.3 The rule that makes the count irrelevant

Every tool passes **three layers**: `AgentDef.tools` (ergonomics) · **hub tool view** (keeps context
small, kills the hallucinated-tool failure mode) · **Cerbos (the authority)**. Layers 1 and 2 are
mirrors; a bypass of either still gets denied.

**Per-seat views stay at 5–15 tools.** Hermes today holds ~90 as one flat list under one identity —
that is the defect the whole program corrects.

---

## 6. Platform prerequisites — 22 items

Grouped by what they unblock. Items marked **⚠** are already-known gaps carrying real risk today.

### 6.1 Data model (P0 — nothing else starts without these)

| # | Item | Requirement |
|---|---|---|
| 1 | `agent_registry` table | migration + all §2 fields; `eval_suite` NOT NULL enforced; `enabled` flag toggles without a deploy |
| 2 | Risk-tier schema | tiers R0–R3 as data; **unclassified must fail CLOSED** (already true at `policy.ts:73` — pin it with a test before refactoring) |
| 3 | Environment registry | `delphi`=staging(low) · `helios`=production(high) · Hostinger WP(high) · per-company rows |
| 4 | Risk computation | `f(action, environment, blast_radius, reversibility, data_class)`; the tool's `impact` is a **floor** the computation may raise, never lower |
| 5 | Attribution columns | `approved_by` + `executed_by` alongside existing `actor_id`/`metadata.via`; explicit-absence rule |

### 6.2 Identity & authorization (P3 — gates everything employee-facing)

| # | Item | Requirement |
|---|---|---|
| 6 | `x-act-for` delegation | envelope field + **double Cerbos check** (once as agent, once as user); deny if either denies |
| 7 | **⚠ `assurance.ts`** | **the module does not exist — only its test file does.** `elevateAssurance` needs both conjuncts (`callerEntitled` ∧ `vouched`) |
| 8 | Assurance path to `verified` | D14's `resolveExecute` requires `verified` while envelope principals mint `low` — **until this closes, no agent can complete an approved write and the approval inbox never drains** |
| 9 | Never-elevate class | Pantheon joins n8n (the §A13 line) — pinned by a test |
| 10 | Cerbos policies | `agent_registry`, `agents.*`, risk tiers. **Cerbos does not hot-reload — restart, then prove with a probe** |
| 11 | Per-principal tool view | the hub serves each principal only its registry namespaces |

### 6.3 Runtime (P1–P2)

| # | Item | Requirement |
|---|---|---|
| 12 | **⚠ `hermes-gateway` into CI** | today a hand-deployed systemd unit, **outside the pipeline**; it went 5 days stale silently once. Dockerize + release by tag before it carries employee traffic |
| 13 | Hermes tool view cut to router set | ~4 tools. Acceptance: **Hermes provably cannot call a PM tool directly** |
| 14 | `ai-agents` runner as the executor | supervisor owns budget, cycle/fan-out guards, D13/D14, tracing |
| 15 | Correlation id end-to-end | edge → router → agent → tool → model. Without it "why did the agent do that" is unanswerable |
| 16 | Kill switches ×2 | registry flag **and** client-cert revocation — independent, both operable by us, no deploy |

### 6.4 Security & audit (P4b — Pantheon-link prerequisites)

| # | Item | Requirement |
|---|---|---|
| 17 | Tamper-evident audit | append-only, hash-chained, **WORM, off-box** (WS7 §2.3) — must survive the monitored party |
| 18 | Break-glass | **WS7 §9, still open.** Time-boxed, alerting-on-use, bound to the boss's individual account — never a standing flag |
| 19 | Behavioural baselines | WS7 §5, applied to agent principals; agents baseline *better* than humans |
| 20 | Claims store | Pantheon reports are **claims, not events**; reconcile against MSO-03 telemetry, mismatch pages `sec-guard` |

### 6.5 Cost & learning (P8)

| # | Item | Requirement |
|---|---|---|
| 21 | Three-grain budgets | per-goal (exists) · per-agent-seat · per-employee-per-day. Gateway is the only honest metering point |
| 22 | Trainer wiring | `trainer.ts` exists; needs episode feed + the one-click bad-answer report. **Both D13 gates stay** |

---

## 7. Effort shape

| Work | Unit | ×15 seats |
|---|---|---|
| Corpus capture | ≥100 real requests/dept | the **longest lead item** — start now, blocks nothing |
| Persona pack | 6 files | 14 packs |
| Eval suite | 30–50 cases | ~500 cases total |
| Shadow mode | ≥200 real requests | per seat, sequential per department |

**Start this week, zero runtime dependency:** ① corpus capture (PM, WebDev, HR) · ② the risk-tier
schema — every later phase encodes tiers and retrofitting them is a rewrite · ③ `hermes-gateway` into
the release pipeline.

---

## 8. What gates what

```
P0 data model ──┬─► P1 router + dept-pm pilot ──► P6 department fan-out
                │                                      ▲
                ├─► P2 risk ladder ──► P4 escort mode  │
                │        │                             │
                │        └─► P4b audit + break-glass ──┼─► P5 Pantheon link
                │                                      │
                └─► P3 delegation + assurance ─────────┘   (the gate on ALL
                                                            employee-facing work)
```

**Two single points of failure worth naming:** item **8** (assurance → `verified`) blocks every
approved agent write in the estate; item **1** (`agent_registry`) blocks everything else.
