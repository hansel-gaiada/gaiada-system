# LMS — learning foundation blueprint

**Status:** `PLANNED` — design only, no code written. · **Scoped:** 2026-08-24
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

⚠ **The ERP can be its own lab for ERP training, and this needs a deliberate decision.** "File a
leave request" is verifiable against real rows — which is elegant and which must NOT run against the
live tenant, or training generates real approvals for real managers. If this is built, it runs
against a dedicated demo tenant with the `hr` module enabled and no real people in it.

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

## 8 · Open questions — decide before L1, not during

1. **Module key: `hr` or a new `lms`?** The LMS serves all eight departments, so filing it under HR
   is arguably a category error — but the certification artefact IS an HR record, and a second module
   key means a second enablement path per company. Leaning `lms` as its own module that WRITES to
   HR's records, but this needs a decision.
2. **Content store: reuse `knowledge` (D9) or own one?** §2.3. Two stores is the wrong answer; which
   single one is right is not yet settled.
3. **Cohorts: extend `hr_review_cycles` or a new table?** §2.2.
4. **Is the ERP its own lab for ERP training?** §4 — elegant, and needs a demo tenant.
5. **Machine-graded vs reviewed** per discipline — UI/UX especially.
6. **KVM on SumoPod** — worth one email; unlocks the genuinely privileged DevOps/Cyber tier.

## 9 · Cross-references

- HR department: [`hr-department-foundation.md`](./hr-department-foundation.md) — §3.3 records this
  as owner-committed and deliberately sequenced last
- Employee's own hub: [`employee-portal-foundation.md`](./employee-portal-foundation.md)
- Appraisals (the surface this must NOT duplicate):
  [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md)
- SumoPod's provenance as a host: `smm-design-addendum-2026-08-12.md` §A4k
