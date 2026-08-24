# LMS — learning foundation blueprint

**Status:** `PLANNED` — design settled, no code written. All owner decisions taken 2026-08-24 (§8, §9).
**Scoped:** 2026-08-24
**Owner ask (2026-08-24):** an LMS for **all departments and all levels** — operational *and*
management — so the whole company can be upgraded. Seed trainings per department, then each HOD
authors more. A **general track every employee must pass** (ERP usage, Claude usage, fundamentals).
Then focus on Web Dev: FE, BE, UI/UX, DevOps, Cyber Security, QA — each with **theory and real
practice**, ordered by difficulty, in an environment where code **runs and produces a result**.

Sequenced after HR-FULL (waves A–D), which is deployed and seeded as of 2026-08-24.

---

## 1 · The one structural decision everything else follows from

**This is two systems, and conflating them is the trap.**

| | What it is | Risk | Where it runs |
|---|---|---|---|
| **The LMS** | catalogue · paths · levels · enrolment · progress · completion · certification · HOD authoring | ordinary CRUD + workflow | `platform-nest`, `gda-aicenter` — executes nothing |
| **The lab runner** | sandboxed execution of employee-written code, graded | **security-critical, resource-hungry** | a SEPARATE service on **SumoPod** |

If the LMS depends on the lab runner, then the mandatory general track — ERP usage, Claude usage,
fundamentals, needed by all 23 employees and requiring **zero** code execution — waits on the
hardest, riskiest component in the programme. That is backwards.

**Therefore: a learning ACTIVITY is polymorphic.** `read · watch · quiz · scenario · lab`. A lab is
one activity type behind an HTTP contract. Theory ships first; labs land per-discipline as the
runner matures; nothing is rebuilt when they do.

This also keeps management training coherent. A department head's course is scenario- and
case-based, not a coding challenge — an activity model that assumed code would have no way to
express it, and "all levels" is half the ask.

## 2 · What this reuses rather than rebuilds

Audited against the estate 2026-08-24. Three seams already exist, and two of them have an obvious
wrong answer:

1. **Certification expiry is already solved.** `hr_records` carries `issued_on` / `expires_on` /
   `reference` plus an idempotent reminder sweep (HR-FULL wave A). On completion the LMS **writes an
   `hr_record`** — it must NOT invent a parallel expiry model, or a certificate ends up with two
   expiry dates that disagree and a compliance page that contradicts the learner's own profile.
2. **`hr_review_cycles` is already cohort + window + completion.** "Everyone in this cohort completes
   this path by this date" is the same shape as a review cycle. Check reuse before adding a second
   cohort engine; if the shapes genuinely diverge, say why in the migration.
3. **The `knowledge` module already stores and retrieves content** (D9 RAG). Course material is
   content. Whether the LMS owns a store or reads that one is the first real design decision — and
   **two stores with two ingestion paths is the wrong answer.**

Plus one authorization primitive that fits the HOD requirement exactly:

4. **`org_unit_lead` + `unitAncestors`** already expresses "the head of this department, over this
   subtree" (HIER-2/DR-9). "Each HOD authors for their own department" needs no new role — it needs
   that derived role and the ancestry attribute the reports and appraisals surfaces already pass.

## 3 · The catalogue model

Four axes, because the ask has four:

- **Track** — `general` (mandatory, everyone) or a **department** (Creatives · GM · HR · Operations ·
  SEO · Social Media · Web · Web Dev — the eight in the live org blob).
- **Discipline** — a subdivision within a department. Web Dev: FE · BE · UI/UX · DevOps · Cyber
  Security · QA. Most departments will have one or none at first; the column exists because Web Dev
  needs it and retrofitting a subdivision later is worse.
- **Level** — `foundation → practitioner → advanced → lead`. This is what makes it "all levels":
  the same discipline carries a management-tier path that is scenario-based rather than hands-on.
- **Path** — an ORDERED sequence of courses with prerequisites. This is the "steps so difficulties
  are in order" requirement, and it belongs on the path rather than on the course, because the same
  course legitimately sits at different points in two different paths.

```
track ─┬─ general (mandatory for all)
       └─ department ─── discipline ─── level ─── path ─── course ─── module ─── activity
                                                                                    ├ read
                                                                                    ├ watch
                                                                                    ├ quiz
                                                                                    ├ scenario
                                                                                    └ lab ──→ runner
```

**Enrolment is assignment, not browsing.** The general track is auto-assigned to every active
employee; a department path is assigned by the HOD or by a review cycle. Progress is per-activity;
completion is per-course; certification is per-path and writes the `hr_record`.

## 4 · The general track — the piece with the widest reach

Mandatory for all 23 employees, zero sandbox, and therefore the first thing that should ship:

- **ERP usage** — navigating the suite, filing leave, timesheets, the approvals inbox, what a
  department console is for.
- **Claude / AI usage** — what the assistant can reach, what it must not be given, when a write
  needs a human, and why an agent's answer is a claim rather than a fact.
- **Fundamentals** — security basics, data handling, the client-confidentiality line.

**The ERP IS its own lab for ERP training** — owner decision, §8.4. "File a leave request" is
verified against real rows rather than self-declared, using the real system. It must NEVER run
against the live tenant, or training generates real approvals landing on real managers; the isolation
and disposal mechanism is §8.4 and §9.

## 5 · The lab runner — design against SumoPod as measured

**Host: SumoPod** (`150.109.15.108`). Owner decision 2026-08-24. Measured that day:

```
4 vCPU EPYC 7K62 · 15.6GB RAM (7.3GB available) · swap 1987MB ~fully used
217GB disk (103GB free) · load 6.39 on 4 vCPU · 45 containers
KVM: NO · cgroup v2: yes · unprivileged userns: yes
```

Three consequences, stated because each one shapes the build:

1. **Disk is ample; CPU and RAM are not.** The runner is a **queue with a concurrency cap**, never
   free-for-all execution. A lab attempt gets hard cgroup limits (CPU quota, memory, pids) and a
   wall-clock kill. Backpressure is a queued attempt, not a starved box — SumoPod also runs Postiz
   and two unrelated projects (`mimi-*`, `lqta-*`), and starving those is a production incident
   somewhere else.
2. **No KVM ⇒ no Firecracker, no hardware-isolated microVM.** Containers only. Hardening is
   therefore layered: rootless/userns-remapped, read-only rootfs, all capabilities dropped,
   `no-new-privileges`, seccomp, **no network by default**, and gVisor (`runsc`, ptrace mode) for
   the untrusted-code path. Slower than native; correct.
3. **Privileged nested Docker is OFF the table on this box.** It holds Postiz's social OAuth tokens
   and two other projects' data. A privileged lab container is a credential-theft path, and a Cyber
   Security curriculum explicitly teaches people to look for one.

### 5.1 · Which is why DevOps and Cyber are re-framed, not deferred

The ask — "DevOps will do DevOps-related challenges and have results" — is achievable **without**
privilege, and the reframing is the interesting part of this design:

- **DevOps → produce an ARTEFACT, graded on real tool output.** Write the Dockerfile, the CI
  workflow, the compose file, the Terraform, the nginx config, the k8s manifest. The runner then
  *actually* builds / lints / `terraform plan`s / `kubectl --dry-run=server`s it in a capped
  container and grades the genuine output. The learner sees a real build log and a real failure —
  the learning is identical; only the blast radius changes.
- **Cyber Security → attack a DISPOSABLE TARGET.** The industry-standard shape: a deliberately
  vulnerable app container (Juice Shop / DVWA lineage) plus an attacker container, joined on a
  private network with no route out, both destroyed after. Unprivileged on both sides. Grading is
  "did you obtain the flag", which is objective.
- **FE / BE / QA → run and assert.** The tractable case: execute, capture stdout/exit/artefacts,
  assert against a rubric. FE adds a headless browser (the estate already runs Playwright for
  `report-renderer`, so that capability exists in-house).
- **UI/UX → artefact + rubric**, largely peer/HOD-reviewed rather than machine-graded. Worth saying
  plainly: not everything should be auto-graded, and pretending otherwise produces a course that
  teaches people to satisfy a grader.

**What genuinely needs KVM** — real multi-node k8s, kernel exploitation, anything requiring a VM —
is deferred, and the cheap unlock is asking SumoPod whether nested virtualization can be enabled
(often a provider toggle). Do not let it gate the other five disciplines.

### 5.2 · The contract

The runner is a **separate service with no ERP network path**. It never holds learner identity,
never reaches Postgres, and returns a graded result over HTTPS:

```
POST /runs   { challengeId, image, files[], limits, gradingSpec }  -> { runId }
GET  /runs/:id                                                     -> { status, exitCode,
                                                                        stdout, stderr,
                                                                        artefacts[], grade }
```

Platform-side, a `lab` activity records the attempt and the grade. **The grade is authoritative
server-side**; the browser never asserts a pass. Attempts are rate-limited per learner, because an
LMS lab endpoint is an obvious way to get free compute.

## 6 · Constraints inherited

1. **The module third wall.** Every LMS table composes
   `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('<mod>')`. Whether these tables
   live under `hr` or a new `lms` module key is an open question (§8).
2. **Sensitivity tier.** A completion record is **performance-adjacent**. `hr_case` vs `hr_record`
   is a real choice, and §5 of the HR blueprint applies: the TR-* reports program owns appraisals,
   so *"did they complete the training"* must not quietly become a second scoring surface that
   feeds a review nobody agreed it should feed.
3. **Legal.** Course content is not personal data; **completion and score records are.** They sit
   behind the same Gate-1 posture as the rest of HR, and a failed attempt is more sensitive than a
   passed one.
4. **Agentic-native bar.** Every capability must work under a human, under n8n, and under an agent.
   Read tools are straightforward; a write tool that enrols people needs a D14 executor or it
   suspends and silently does nothing.

## 7 · Sequencing

Ordered so that the widest reach lands first and the riskiest component gates nothing:

| Wave | Delivers | Needs the runner? |
|---|---|---|
| **L1** | Catalogue + paths + levels + enrolment + progress + completion + certification into `hr_records` | no |
| **L2** | The mandatory general track, auto-assigned to all active employees | no |
| **L3** | HOD authoring, scoped by `org_unit_lead`; draft → review → publish | no |
| **L4** | Web Dev curriculum STRUCTURE — six disciplines, ordered paths, theory + quizzes | no |
| **L5** | The lab runner on SumoPod + FE/BE/QA labs | **yes** |
| **L6** | DevOps artefact-graded labs; Cyber disposable-target labs | **yes** |
| **L7** | The other seven departments' content, authored by their HODs | no |

L1–L4 covers every employee and every department with no execution risk at all. L5 is where the new
service appears.

## 8 · Decisions taken (owner, 2026-08-24)

**1 · Its own `lms` module, writing HR records.** Not filed under `hr`. The LMS is a company-wide
capability serving all eight departments, and filing it under one department would make Creatives'
or SEO's training silently depend on `hr` being served to them. Certification crosses a ONE-WAY seam:
the LMS writes an `hr_record` on path completion and reads nothing back. Cost accepted: a second
module key and a second per-company enablement path.

**2 · The LMS owns authoring; publishes INTO knowledge.** One store per purpose, one direction of
flow. Authored content has a lifecycle the knowledge store does not model — drafts, versions, module
ordering, HOD review — so the LMS owns that. On publish, the course registers as a knowledge source
so the assistant can cite it, which is what makes the Claude-usage track coherent: an employee can
ask Claude about training they have been assigned.

**3 · Grading is MIXED by discipline.** Machine-graded where the answer is objective (FE/BE/QA
assertions, DevOps build/lint/plan output, Cyber capture-the-flag); HOD or peer review for UI/UX and
for management scenarios. Stated because the alternative is worse in a specific way: an auto-gradeable
proxy for "is this good design" mostly is not one, and it teaches people to satisfy the grader.

**4 · ERP training runs in the REAL system, isolated, and is disposed of afterwards.**
Owner: *"need to isolate the training. so it really use the live version, but delete when finish."*

Three requirements — isolate · really the live version · delete when finished — and the safe shape is
NOT a hard delete. Measured 2026-08-24: **186 tables carry `tenant_id`**, and there is **no
hard-delete path for a company** in the estate today (companies are soft-deleted). A cascade across
186 FK-linked tables on the production database, written new, is the highest-risk operation this
programme could contain, and it would run against the box holding the business.

The disposal mechanism is **reset, not delete** — §9. Two invariants hold regardless:

- **Real code, real walls.** Training uses the actual ERP — the same image, the same migrations, the
  same three isolation walls (Cerbos + `withTenants` + module-sliced RLS). No mock, or it teaches
  people a surface that does not exist.
- **A trainee's grants in the training scope are revoked on disposal.** ORG-6's no-orphaned-grant
  invariant applies: a half-disposed training environment that leaves live role grants behind is a
  worse outcome than not disposing at all.

## 9 · The training tenant — disposal by RESET, not by delete

Owner decision, 2026-08-24. A **real company inside the live ERP**, with fake staff, used as the lab
for ERP-usage training. Real image, real migrations, real Cerbos + `withTenants` + module-sliced RLS
— so it teaches the surface that actually exists. "Delete when finish" is satisfied by **deleting the
trainee's work and re-seeding the tenant to a known baseline**, not by deleting the company.

**Why reset rather than delete, stated once so it is not relitigated:** 186 tables carry `tenant_id`
and the estate has no hard-delete path for a company. A cascade across 186 FK-linked tables, written
new and run against the production database, is the single highest-risk operation this programme
could contain — and the learning outcome is identical either way. Reset touches only the bounded set
of tables the exercises actually write.

### 9.1 · Rules the reset must hold

1. **Bounded by construction, not by hope.** The reset deletes from an EXPLICIT allow-list of tables
   the exercises write (leave requests, cases, timesheets, attendance, notifications…). It must never
   be "delete everything with this tenant_id" — that is the 186-table cascade wearing a different
   hat, and one new module later it silently grows teeth.
2. **Scoped to the training tenant, and it must be impossible to point elsewhere.** The tenant id is
   resolved from a `companies.is_training` flag, never passed in. A reset that can take an arbitrary
   tenant id is one typo from clearing a real company.
3. **Grants revoked (ORG-6).** A trainee holds real roles in the training tenant. Disposal revokes
   them; a half-disposed environment leaving live grants behind is worse than not disposing at all.
4. **Re-seeded to a KNOWN baseline**, so every trainee starts from the same state and an exercise
   that depends on prior data behaves the same on the hundredth run as the first.
5. **Never reachable from a real company's scope.** The training tenant must not appear in anyone's
   company switcher except while they are enrolled, and must be excluded from every rollup — or its
   fake headcount lands in a real report.

### 9.2 · Action, not a decision

Ask SumoPod whether **nested virtualization (KVM)** can be enabled. It is often a provider toggle. It
unlocks the genuinely privileged DevOps/Cyber tier (real multi-node k8s, kernel work) later without
changing anything designed above it. Do not let it gate L1–L6.

## 10 · Previously open, now settled

Recorded so the reasoning is not lost:

- **Cohorts** — a NEW table, not an extension of `hr_review_cycles`. A review cycle carries an
  outcome and an appraisal link that a training cohort does not, and overloading it makes both
  harder to read. (Engineering call, 2026-08-24.)

## 11 · Cross-references

- HR department: [`hr-department-foundation.md`](./hr-department-foundation.md) — §3.3 records this
  as owner-committed and deliberately sequenced last
- Employee's own hub: [`employee-portal-foundation.md`](./employee-portal-foundation.md)
- Appraisals (the surface this must NOT duplicate):
  [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md)
- SumoPod's provenance as a host: `smm-design-addendum-2026-08-12.md` §A4k
