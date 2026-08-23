# Full-app bug audit — plan

**Status:** PLANNED. Drafted 2026-08-12. Not yet executed.
**Trigger:** run this when feature work is quiet and before the staging cut, not during active
development — a moving tree produces a report you cannot act on.
**Output:** `docs/audits/<date>-findings.md` — a verified, severity-ranked findings register where
every row is ticket-ready.

---

## 1. Why this shape

A generic "scan the repo" pass would be near-worthless here, for three reasons this program has
already paid for:

1. **The dominant bug class is not local.** Per the root guide, the recurring defect is
   *frontend-first drift*: a console reads a field the backend never sends, renders a confident
   wrong answer, and nothing throws. No linter, type-checker, or single-file review sees that —
   it only appears when you compare the UI's reads against a live response.
2. **A green unit suite is not evidence.** The binding status vocabulary says DEV-VERIFIED means
   *you drove it and observed the result*. 610 test files pass today and the known open defects
   still exist. The audit must drive real surfaces.
3. **An unverified finding is worse than no finding.** A report padded with plausible-but-wrong
   items burns more time than it saves and trains everyone to ignore the next one. Every finding
   gets an adversarial verification pass before it reaches the register.

So the audit runs in three movements: **cheap breadth** (automated sweeps) → **targeted depth**
(the bug classes this codebase actually produces) → **verification** (kill the false positives).

## 2. Scope

| In scope | Out of scope |
|---|---|
| `platform-nest` (594 files) | `docs/`, `design/`, `legal/`, `data/` prose |
| `platform-ui` (762) | Historic narrative under `docs/history/` |
| `wa-chat-bot` (131) | `creative-grading-trainer` (research sandbox) |
| `ai-gateway-go` (48), `mcp-hub` (46), `sync-engine-go` (35) | Third-party container internals |
| `ai-agents` (53), `search-crawl-go` (14), `report-renderer` (4) | |
| `infra/` compose + nginx + scripts (config defects count) | |
| `automation/` workflow JSON (logic defects count) | |

~1,690 code files. **Empty dirs are a finding in themselves**: `hermes-gateway`, `meeting-bot`,
and `capture-helper` have test files or a CLAUDE.md but zero committed code files — confirm during
Phase 0 whether that is intentional (edge services built elsewhere) or a packaging gap.

### Assumptions (change these before running if wrong)

- **Audit target is a pinned commit built into test containers from source**, not
  `erp.gaiada.online`. The live server runs whatever tag was last deployed; auditing it means
  auditing an unknown tree. Live is used only in Phase 5, and only to compare behaviour.
- **No production data is touched.** Phase 5 uses seeded test tenants. The Legal Gate 1 constraint
  on real employee data holds throughout.
- **Findings land in a doc register first, not directly in tickets.** Triage into tickets is a
  human decision after reading the report.

## 3. Phases

### Phase 0 — Freeze and baseline (½ day)

Do not skip. Without this the report cannot be reproduced or re-run.

- Pin the audit commit; record SHA + `/VERSION` at the top of the register. This checkout is
  shared by concurrent sessions — HEAD will move under you, so work from a dedicated worktree.
- Regenerate `docs/MAP.md` (`node scripts/gen-map.mjs`). The audit reads the map as its inventory
  of controllers, routes, compose services, module registry, and migration head. A stale map means
  a blind spot.
- Run `infra/scripts/test-all.sh` and record what is **already red**. Pre-existing failures are
  Phase 1 findings, not noise to be normalised.
- Stand up test containers from source at the pinned commit. Verify the stack answers before
  auditing it.
- Resolve the empty-component question above.

**Exit:** a recorded baseline — SHA, version, red tests, running stack.

### Phase 1 — Automated breadth (1 day, mostly unattended)

Cheap, wide, high-noise. Run everything; triage later.

| Sweep | Tooling | Targets |
|---|---|---|
| Build + typecheck + lint | each component's own CI job | all |
| Test suites, with coverage | `infra/scripts/test-all.sh` | all |
| Go race + vet | `go test -race ./...`, `go vet` | the 4 Go services |
| Static security | `semgrep` skill | all |
| Deep taint/dataflow | `codeql` skill, "important only" mode | TS + Go |
| Fail-open defaults | `insecure-defaults` skill | `infra/`, all `.env` handling |
| Dependency risk | `supply-chain-risk-auditor` skill | every lockfile + `go.mod` |
| CI/agent-pipeline injection | `agentic-actions-auditor` skill | `.github/workflows/` |

Two known traps to encode as explicit checks rather than hoping a scanner finds them: a var in
`.env` does nothing unless the service's compose `environment:` block lists it, and `up -d` with a
stale `GAIADA_TAG`/`APP_VERSION` silently rolls the release back.

**Exit:** raw tool output parked in `docs/audits/<date>-raw/`. Nothing promoted to the register yet.

### Phase 2 — Contract conformance (2 days) ← *highest expected yield*

This is where the drift bugs live. Three sources of truth get compared pairwise:

1. `docs/FRONTEND-BFF-CONTRACT.md` (§-numbered, frozen)
2. The actual `@Controller` surface in `platform-nest` (from the regenerated MAP)
3. Every fetch/read in `platform-ui`

For each UI data read, answer: does the endpoint exist, does it return this field, and is the
field's type/nullability what the UI assumes? **A missing field reads exactly like NULL** — an
omitted column is indistinguishable from a null value, and that has already produced two wrong
conclusions here. So field presence must be checked against a *live response body*, not against a
TypeScript interface.

Also check contracts known to be frontend-first (UI shipped against endpoints that may not exist):
the PM/AI tracker contract, the org-structure endpoint, and the IT device contract.

Assign: `senior-fe` + `senior-be` working the same list from both ends, `senior-integrator` for
cross-service seams (gateway ↔ hub ↔ bot ↔ n8n).

**Exit:** a per-§ conformance table — BUILT / DRIFTED / MISSING — with the drifts as findings.

### Phase 3 — Authorization and data safety (2 days)

Cerbos + Postgres RLS are the authority; UI `lib/rbac.ts` and the hub's in-code engine are
mirrors. Mirrors drift.

- **Mirror parity**: for each permission in `docs/PERMISSION-CONTRACT.md`, does Cerbos, RLS, the
  UI, and the hub agree? Any disagreement where a mirror is *more permissive* than Cerbos is
  high-severity by definition.
- **Probe, don't read policy.** Cerbos does not hot-reload; a healthy container has served
  two-day-stale policy. Restart, then prove each decision with a live probe.
- **RLS coverage**: every tenant-scoped table has a policy, and the policy is not defeated by an
  unset GUC. The zero-row trap — unset GUC yields zero rows with no error — means an
  under-permissive bug is silent. Check both directions: can tenant A read tenant B, and does
  tenant A's own read return rows.
- **`isClientOnly` vs `!isElevated`** — audit every call site; these are not equivalent and
  conflating them leaks staff surface to client users.
- **PII/PAN scrubbing before persist**, and crypto-shred key handling.
- **Agent attribution**: audit trails must name the human, not their agent.

Assign: `senior-db` (RLS, migrations), `senior-be` (Cerbos, guards), `senior-integrator` (hub
engine). Consider a `threat-model` skill pass to frame it first.

**Exit:** a permission × layer parity matrix; every mismatch a finding.

### Phase 4 — Per-component depth review (3 days, parallel)

One reviewer per component, each running the `find-bugs` skill plus a language-specific lens:

- **Go services** — `golang-concurrency` (goroutine leaks, channel ownership, races),
  `golang-error-handling` (swallowed errors), `golang-security`, `golang-context` (leaked or
  never-cancelled contexts).
- **`platform-nest`** — transaction boundaries, N+1s, event/outbox correctness, module registry
  wiring, error surfaces that leak internals.
- **`platform-ui`** — state and data-wiring correctness, RBAC-gated rendering, error/empty/loading
  states, `role="log"` live-region spam, a11y against `docs/a11y-manual-checklist.md`.
- **`automation/` + `wa-chat-bot`** — silent-failure paths. n8n workflows without error branches
  are findings; use the `n8n-error-handling` lens.
- **`infra/`** — compose passthrough, `--remove-orphans` blast radius, disk headroom before
  deploy, health checks that check the wrong thing (a green deploy has hidden a Cerbos crash loop
  because the gate ran `ps` without `-a`), and rsync without `--delete` leaving stale files.

Tier the reviewers per the agent-army standard — do not put a senior seat on mechanical sweeps.

**Exit:** per-component finding lists.

### Phase 5 — Live drive (2 days) ← *the DEV-VERIFIED half*

Scripted verification is not real-input verification. Drive the actual surfaces:

- **Web**: `webapp-testing` / `playwright-skill` against the running UI — the critical journeys
  end to end (login → company switch → each department console → a write that goes through the
  D14 approve-executes path → client portal as a client-only principal).
- **Auth**: headless login via `scripts/sso-login.sh`. Remember only ~7 of 47 `users` rows can
  actually log in — a `users` row is not a login. Test with principals that exist.
- **Bot/automation**: drive WhatsApp/Telegram and the three live n8n flows with real message
  shapes, not synthetic payloads.
- **AI path**: gateway → hub → agent, checking that the provider bearer is actually sent and that
  no service other than the gateway holds keys.
- **Load smoke**: a short `k6` pass on the hottest endpoints — enough to surface N+1s and
  connection-pool exhaustion, not a full performance program.

Assign: `qa` seat owns this phase and is the merge gate.

**Exit:** observed-behaviour notes per journey; every divergence a finding.

### Phase 6 — Verification (1 day) ← *do not skip*

Every candidate finding from Phases 1–5 goes through the `fp-check` skill: TRUE POSITIVE or FALSE
POSITIVE, with documented evidence and, for true positives, a concrete failure scenario
(inputs/state → wrong output). Findings that cannot be given a failure scenario do not go in the
register.

For anything high-severity, verify with an independent reviewer who did not find it, prompted to
*refute* rather than confirm.

Then run `variant-analysis` on each confirmed true positive: the same mistake almost always exists
in three other places. This step reliably doubles the register — and is the difference between
fixing symptoms and fixing a class.

**Exit:** confirmed findings only; false positives archived with their reasoning (so the next
audit doesn't re-raise them).

### Phase 7 — Report and triage (½ day)

Assemble `docs/audits/<date>-findings.md`. Row schema:

```
ID · Severity · Component · File:line · One-line claim · Failure scenario ·
Evidence (how it was verified) · Class (single/variant-of) · Suggested fix · Blocks-staging?
```

Severity ladder:

- **S1 — blocks staging.** Data leak across tenants, authz bypass, PII exposure, data loss,
  silent wrong answers in a money/HR path.
- **S2 — must fix before the next release cut.** Broken journey, contract drift the UI depends on,
  crash under real input.
- **S3 — scheduled.** Correctness bugs in secondary paths, missing error handling, a11y failures.
- **S4 — logged.** Cleanups, inefficiencies, test gaps.

Close with a **coverage statement**: what was audited, what was sampled rather than exhausted, and
what was skipped. Silent truncation reads as "we covered everything" when it didn't.

## 4. Cost and sequencing

~11–12 working days of agent time, but Phases 1 and 4 parallelise heavily. Realistic wall clock is
**4–6 days** with a fleet, sequenced:

```
P0 freeze  →  P1 sweeps ─┐
                          ├→ P4 depth ─┐
           →  P2 contract ┤            ├→ P6 verify → P7 report
           →  P3 authz ───┘  P5 live ──┘
```

P2 and P3 start as soon as P0 lands — they don't need P1's output. P6 is a hard barrier: nothing
reaches the register unverified.

**If you only get two days**, run P0 → P2 → P3 → P6. Contract drift and authz mirror drift are
where this codebase's real defects have historically been, and both are staging-blocking classes.
The automated sweeps are the *least* valuable part despite being the cheapest.

## 5. Definition of done

- Every in-scope component has been through P4, or is explicitly listed as skipped with a reason.
- Every register row is verified with a failure scenario.
- Every confirmed finding has had variant analysis run against it.
- The coverage statement is written and honest.
- S1 rows are converted to tickets before the report is considered actionable.

## 6. Known-issue seed list

Start the register pre-populated with these — they are already-known defects that a fresh audit
should either confirm still open or close with evidence:

- Deploy rollback misreports the version; `/health` shows a stale one.
- Deploy health gate ran `ps` without `-a` and rsync had no `--delete` — a green deploy hid a
  Cerbos crash loop.
- `N8N_PATH` is half-broken behind the `/n8n/` basic-auth proxy.
- Migrations 0058–0059 are dead ledger entries.
- Whisper capture unstarted; the Web Dev dispatcher times out.
- The agentic-native bar is OPEN and must close before staging.
- Credential rotation was deferred on 2026-08-06 and is still owed.
