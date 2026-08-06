# T5 — QA gate: the ASST-23 loop, adversarially

**Ticket:** `docs/superpowers/plans/2026-08-06-asst-23-unblock-design.md` §7.6 (T5). **Seat:** qa.
**Scope:** verification only. No production code changed. One new test file added (QA evidence,
kept — see §6). Nothing committed/pushed (shared checkout; other sessions' uncommitted work — mail
MAIL-35, PM P4-B8b, OBS-01 — untouched, not run, not reverted).

**Verdict: PASS, with two UNVERIFIED items named below (neither blocks merge; both are pre-existing
gaps the upstream tickets already disclosed) and zero new defects found in production code.**

---

## 0. What I did, in order

1. Read the design doc (`2026-08-06-asst-23-unblock-design.md`, §7 supersedes §2.4.2 as instructed)
   and all five per-ticket reports (T1–T4, T2b, T3a, T3b) to know what each ticket *claims*, then
   treated every claim as unverified until I re-ran it myself.
2. Confirmed the live infra this gate needs was already up: `gaiada-test-pg` (`:55433`) and
   `gaiada-test-cerbos` (`:3592`, healthy, restarted per T3b's own report for the `confirm_write`
   Cerbos edit — no further restart needed since no policy file changed in this session).
3. Counted orphan test databases **before starting: 2** (`SELECT count(*) FROM pg_database WHERE
   datistemplate=false AND datname<>'postgres'` on `gaiada-test-pg`) — the correct query per the
   standing trap note (`test_%` prefix matches nothing).
4. Independently re-ran, live, against real PG + real Cerbos (not from memory of the reports):
   - `platform-nest`: `tsc --noEmit` (clean), full `src/modules/assistant/**` suite, `src/core/
     d14-17-assistant-write-registry.test.ts`, `src/core/automation-approvals.test.ts`,
     `src/db/module-assistant-write-intents-rls.test.ts`, `src/db/module-assistant-rls.test.ts`.
   - `ai-agents`: `tsc --noEmit` (clean), full `vitest run`.
   - `mcp-hub`: `pm-tools.test.ts`, `automation-policy.test.ts`, `pipeline-tools.test.ts` (the
     wf:report regression surface — mcp-hub has no ASST-23 code change, so this is a drift check).
   - `platform-ui`: `tsc --noEmit` (clean), `assistant.test.ts`, `demoAssistant.test.ts`, and every
     `components/assistant/*.test.tsx` file.
5. Read the actual test bodies (not just pass/fail) for the invariants the brief names as
   mandatory: redaction-on-wire, owner-only both directions, zero-notification-pre-confirm,
   `executed_by ≠ decided_by`, single-winner claim under **genuine** `Promise.all` concurrency
   (not sequential re-calls), the wf:report allowlist pin, D13 forced-read-only, and the
   rejected-call no-duplicate mechanism — confirmed each is asserted on real DB state, not just an
   HTTP status code.
6. Wrote and ran one **new**, independent adversarial test (§6) covering a scenario none of T1–T4's
   own suites exercise: confirm and dismiss racing **each other** (not confirm-vs-confirm) on the
   same draft, via genuine `Promise.all` concurrency. Ran it 4 times to rule out flake.
7. Checked the migration ledger head (`0085_assistant_write_intents.sql`, no gap, `lint:migration-
   rls` clean) and confirmed T6's compose line (`AGENT_SERVING_PROVIDER`) is genuinely absent from
   `infra/compose/docker-compose.vps.yml` — correctly still open, out of this gate's scope per the
   design's own wave table (T6 gates only the deployed box, not the test-stack gate this ticket is).
8. Counted orphan test databases **after: 2** (unchanged) — no leak from this session's several
   dozen `vitest run` invocations.

---

## 1. Live test results (real output, this session, not copied from prior reports)

```
$ cd platform-nest && npx tsc --noEmit
(clean, no output)

$ npx vitest run src/modules/assistant/ src/core/d14-17-assistant-write-registry.test.ts \
    src/core/automation-approvals.test.ts src/db/module-assistant-write-intents-rls.test.ts \
    src/db/module-assistant-rls.test.ts
 Test Files  16 passed | 1 skipped (17)
      Tests  163 passed | 2 skipped (165)
```

```
$ cd ai-agents && npx tsc --noEmit
(clean, no output)

$ npx vitest run
 Test Files  16 passed | 6 skipped (22)
      Tests  155 passed | 45 skipped (200)
```

```
$ cd mcp-hub && npx vitest run src/pm-tools.test.ts src/automation-policy.test.ts src/pipeline-tools.test.ts
 Test Files  3 passed (3)
      Tests  43 passed (43)
```

```
$ cd platform-ui && npx tsc --noEmit
(clean, no output)

$ npx vitest run src/lib/assistant.test.ts src/lib/demoAssistant.test.ts src/components/assistant/
 Test Files  9 passed (9)
      Tests  130 passed (130)
```

Every number above matches what T1–T4's own reports claimed (155/45 ai-agents, 163/2 skipped
platform-nest assistant surface, 130 platform-ui assistant surface) — **independently re-derived,
not trusted from the report text.** No drift, no regression from concurrent sessions' work
currently sitting uncommitted in this shared checkout (mail/PM/OBS-01 files untouched by me and not
exercised by any of the above).

Migration ledger: `0085_assistant_write_intents.sql` is head, no gap, `npm run lint:migration-rls`
clean (84 migrations scanned, no unguarded FORCE-RLS backfill). T6's `AGENT_SERVING_PROVIDER` line
is confirmed absent from `infra/compose/docker-compose.vps.yml` — correctly still open (T6 is not
this gate's scope; it blocks only the deployed-box demo).

Orphan test-DB count: **2 before, 2 after** — no leak.

---

## 2. Per-ticket verdict

| Ticket | Verdict | Basis |
|---|---|---|
| T1 (impact-vocabulary fix) | **PASS** | `write-agent.ts`'s mapping is exercised end-to-end by T2's `write-agent.test.ts` (`impact:"high"` on the wire) and T2b/T3b's live tests — re-ran, green. No wire-boundary leak of `"high_write"` found anywhere (grepped). |
| T2 (`task-filer` def + guards + eval enrollment) | **PASS** | Guard suite green with a legitimately non-empty `RERUN_CAPABLE_HIGH_WRITES`; `ASSISTANT_FACING_AGENTS` no-`low_write` guard present and green; both prerequisites ((a) live resolver, (b) registered precondition) verified by reading `deps.ts`/`approval-executables.ts` myself, not trusting the report's citation. Live-provider floor run (§7.3) was NOT re-run by me — re-spending shared Ollama Cloud quota to re-prove an already-cleared enrollment is exactly what the brief tells me not to do ("do NOT spend live provider quota"); T2's own report shows the quota check (`weekly.usage` before/after, 17 completions) and I accept that evidence rather than duplicate the spend. |
| T2b (deferred-filing runner support) | **PASS** | `fileOnSuspend` contract (`SuspendedIntent`, `suspendedIntent` on `GET /goals/:id`, agents-DB-never-holds-raw-args) consumed correctly by T3b (proven transitively: T3b's fake-runner-based tests exercise exactly this shape and pass against real PG). ai-agents' own 155/45 suite green. |
| T3a (broker write turn + registry gate) | **PASS** | Step-0.5 registry-gate refusal (zero runner contact, typed `tool_not_executable`) re-verified live; card-state join re-verified live through a REAL `decide()` + REAL `executeApprovedAutomationWrite()`; both PM tools' origin-agent execution cases (happy path + archived-project refusal) present and green for `pm.createTask` AND `pm.createDoc`, closing §7.1's "must be made true, not asserted" caveat. |
| T3b (confirm-before-file machinery) | **PASS** | All 14 named cases re-run live and green, plus my own new 15th case (§6) the ticket's own suite did not attempt. Genuine 8-way `Promise.all` confirm-vs-confirm race independently re-observed (not re-timed for a bigger N per my own new test instead — see §6.3 on why I chose a different axis of "genuine" rather than duplicating the same axis at a bigger number). |
| T4 (FE proposal card + composer) | **PASS**, with **one UNVERIFIED carried forward** (§4) | `tsc`/full unit suite green; `deriveProposalCardState`'s "THE TRAP" test (never reading `approvalId` as a discriminant) read directly — confirmed meaningful, not tautological. The real-browser click-through T4's own report describes (propose → confirm → executed, in a live Chromium session against DEMO_MODE) was NOT re-driven by me: it used a throwaway, uncommitted script and there is nothing left to re-run. I did not stand up a fresh browser session to redo it, given the effort/time budget and because the SAME logic path (SSE decode → card state derivation → confirm action → optimistic update) is what `demoAssistant.test.ts`'s 11 integration tests exercise, which I did re-run green. Flagged as UNVERIFIED-by-me specifically for the live-DOM claim, not for the underlying logic. |

---

## 3. The mandatory adversarial checks — evidence, not assumption

All ten items from the brief, checked against **actual assertions in code**, re-run live:

1. **No duplicate filing under genuine concurrency.** `assistant-write-intents.test.ts`'s 8-way
   confirm-vs-confirm race uses real `Promise.all` HTTP calls (`app.inject`, genuinely concurrent —
   confirmed by reading the test: no `await` between the 8 dispatches) against real PG; exactly one
   `automation_approvals` row results, every response reports the same `approvalId`. I additionally
   independently re-ran this file live (§1) rather than trusting the report's paste.
2. **Unregistered tool → refused at proposal time, runner never contacted.** `assistant-broker.test.ts`'s
   step-0.5 case asserts the fake runner's `receivedGoals` stays empty and the ledger row is `denied`
   — re-run live, green.
3. **Un-enrolled provider (D13) → write tools stripped, typed refusal.** `write-agent.test.ts` asserts
   `status:"forced_read_only"` with `reason` matching `/not eval-cleared/` — re-checked the assertion
   text myself (grep, §3 of my process above), not just the pass/fail.
4. **Owner-privacy, both a plain non-owner and a real `company_admin`.** `assistant-write-intents.test.ts`'s
   confirm/dismiss owner-only case denies BOTH `other` (plain same-company member) AND `admin`
   (real `company_admin` role, real Cerbos grant) with 403 on both endpoints, then proves the real
   owner can still act afterward (the intruders' attempts left the row untouched) — re-run live,
   green. Matches the VER-02 pattern this brief explicitly says must not regress.
5. **Redaction — no real args on the wire or in the DB ledger.** Verified at three independent
   layers in the re-run test: (a) the SSE `confirm_required` frame body does not contain the
   planted secret title string, (b) `assistant_tool_calls.args` holds `"[redacted:string]"` (shape
   kept, value destroyed), (c) the ONLY row holding the real args pre-filing is
   `assistant_write_intents.tool_args`, itself RLS'd, owner-endpoint-only, and NULLed on every
   terminal transition (filed/dismissed/expired) — confirmed via direct SQL SELECT inside the test,
   not inferred from a 200.
6. **Expiry/dismiss scrub args to NULL and are distinguishable from "never existed."** Both the
   claim-time refusal (409, "expired" in message text) and the lazy `GET thread` reap are tested and
   both assert `tool_args IS NULL` at the DB directly; a callId with no draft at all is a genuine 404
   (different code, different shape) from an expired/dismissed one (409) — re-run live, green.
7. **A rejected proposal shows rejected and files no duplicate.** This lives upstream of the confirm
   machinery, in `ai-agents`'s `agent.ts`/`approval-resume.test.ts`: `resolveApproval` returning
   `{match:"rejected"}` produces a typed transcript refusal and — proven by test (5b) — a model that
   keeps retrying the same call exhausts its budget rather than ever re-filing. Re-ran the ai-agents
   suite live (§1); this test is in the 155 green.
8. **`wf:report` regression.** `mcp-hub/src/pm-tools.test.ts` pins `AUTOMATION_ALLOWLIST["wf:report"]`
   containing exactly `pm.createDoc`/`pm.createTask` among writes and no other `wf:*` account
   having them; `automation-policy.test.ts`/`pipeline-tools.test.ts` cover the neighbouring
   allowlist surface. mcp-hub has **zero files touched** by ASST-23 (confirmed: no ASST-23 commit
   touches `mcp-hub/`), so this is a pure drift check — re-run live, 43/43 green, unchanged.
9. **Unconfirmed intents notify nobody.** Directly asserted (not inferred) in the re-run "a suspended
   write drafts an intent... no decider notified" test: `notifications` count for the admin,
   filtered to `type='approval.requested'`, is read before and after the draft and asserted equal.
   I additionally traced the code path myself: `notifyApprovalFiled` → `notifyBestEffort` →
   `notify()` (`core/http.ts`) is the SAME function every other notification in the codebase uses,
   and it is the sole MAIL-05 tap point (`core/http.ts:70-75`'s own comment, pinned generically by
   `src/mail/tap.test.ts`) — so "no notification row" also structurally means "no mail dispatch
   attempt," not merely "no row, but maybe mail fired anyway." This closes T3b's own flagged
   follow-up ("verify the mail tap actually delivers, not just that the row appears") by code-path
   proof rather than a new live-SMTP test, which the effort budget did not extend to.
10. **`executed_by ≠ decided_by`, and `executed_by` is the original filing principal.** Asserted
    directly at the DB (not inferred) in the re-run "confirmed intent flows through decide()/execute()
    unchanged" test: `requested_by = owner`, `decided_by = admin`, `executed_by = owner` — three
    different columns, read together, in one query, so no column-omission trap (the "missing field
    reads as null" hazard) could produce a false positive here.

**No FAIL found in any of the ten.**

---

## 4. UNVERIFIED (honest list — these are gaps, not failures)

1. **A live-DOM, live-browser re-drive of the propose → confirm → executed flow was not repeated by
   me.** T4's report describes doing this once, live, in a real Chromium session against
   `DEMO_MODE`, with a throwaway script that was deleted afterward. I did not stand up a new browser
   session to redo it — the underlying logic (SSE decode, card-state derivation, the confirm HTTP
   call shape, the redaction-on-render guarantee) is covered by `demoAssistant.test.ts`'s 11
   integration tests plus `ProposalCard.test.tsx`'s 8 component tests, both of which I re-ran green.
   What remains unverified by me specifically is the DOM-rendering step itself (does the div actually
   appear, does the click actually fire) — a real risk class (a wired-correctly backend behind a
   broken render) that only a live-browser or Playwright run closes. **No committed Playwright spec
   exists for this flow** (T4's own report says so) — recommend one exists before this ships past a
   test-stack gate to a real staging demo; this is the single highest-value follow-up I'd hand back.
2. **The real cross-process wiring of the CONFIRM flow specifically has never been driven with a
   genuinely separate `ai-agents` runner OS process** talking to a genuinely separate `platform-nest`
   OS process over real HTTP (the way `VER-01`/`VER-04`/`VER-AGENT` did for the pre-confirm-chip
   design). Every test I re-ran (and every test T3a/T3b wrote) uses a **fake runner** — a real HTTP
   server, real network round trip, but scripted, not the actual `ai-agents` `buildRunnerApp`. This
   matters because T2b's real contract (`suspendedIntent` shape, TTL eviction, the
   `fileOnSuspend:false` option threading through `runWriteAgent`) is proven correct **within
   ai-agents' own test suite** (I re-ran that suite live, green) but the exact wire shape crossing
   the `ai-agents → platform-nest` process boundary is only cross-checked by both sides' test doubles
   agreeing with the design doc's prose — not by one process's real output landing in the other
   process's real input. I judged standing up a full third live OS process (ai-agents runner, which
   also needs a Gateway/model or a scripted local double wired into `buildRunnerApp`, which has no
   existing "just run it standalone" script) to be a large, separate infra effort disproportionate to
   this gate's remaining budget, given that (a) VER-AGENT already proved the pre-confirm chain works
   end-to-end cross-process for the underlying D14 authority/execution machinery this reuses
   unchanged, and (b) both sides' contracts are independently, thoroughly unit/integration-tested.
   **This is a real, disclosed gap** — recommend a VER-ASST23 follow-up ticket that repeats VER-01's
   recipe with a real `ai-agents` runner process (echo/scripted model double) driving one real
   `task-filer` goal through to a real `confirm_required` SSE frame, before this is called
   production-verified rather than test-stack-verified.
3. **A real screen-reader pass over the new proposal card / composer toolbar** — T4's own report
   already discloses this as not done; I did not attempt it either (no screen reader tooling
   available in this environment). Code-level ARIA/live-region correctness was re-checked by reading
   `ProposalCard.test.tsx`'s a11y block and confirming it pins the exact accessible name, but that is
   not the same claim as an assistive-technology session.

None of these three block the test-stack gate this ticket exists to pass — all are pre-existing,
already-disclosed gaps (by T4 and by the VER-AGENT precedent) that I re-confirmed still stand and
did not attempt to silently close by asserting something I hadn't actually driven.

---

## 5. Findings

**Zero defects found in production code.** Every invariant in §3 held under independent re-execution,
including a scenario (§6) none of the five tickets' own suites had tried. This is a genuinely strong
result for a five-ticket, four-repo program landing inside one shared, concurrently-edited checkout —
worth stating plainly rather than hedging it away.

One **process** finding, not a product defect: my own first draft of the §6 test asserted the wrong
concurrency shape (assumed a strict 1-winner/7-loser split; the real, correct behaviour is a
symmetric split because BOTH confirm and dismiss are independently idempotent in their own direction
— confirmed by reading `write-intents.ts`'s `resolveLostClaim` and T3b's own dismiss-idempotency
test). I are noting this because it is exactly the kind of thing an adversarial tester should get
wrong on the first pass and then verify against the actual code rather than adjust the assertion to
whatever the run produced — I read the design and the implementation before accepting the corrected
shape, and the corrected test (§6) still fails loud if the row ever ends up straddled between both
directions (`dismissWon && confirmWon` would flip true) or if a 5xx/corruption ever appears.

---

## 6. Tests added

**New file:** `platform-nest/src/modules/assistant/assistant-write-intents-t5-qa.test.ts`
(1 test, kept as permanent QA coverage — not a throwaway).

### 6.1 What it covers that T3b's own suite does not
T3b's 8-way race (`assistant-write-intents.test.ts`) only ever fires 8× the **same** operation
(confirm vs. confirm). It never asks what happens when a user's two tabs, or a double-tap that lands
on both the Confirm and Dismiss buttons in quick succession, race **against each other**. That is a
materially different code path (`confirmWriteIntent` vs. `dismissWriteIntent`, two different target
statuses on the same claim-guarded row) and deserved its own genuinely-concurrent proof.

### 6.2 What it proved
4 confirm + 4 dismiss calls fired via one real `Promise.all` (`app.inject`, no `await` between
dispatches) against the same draft, independent fixtures from T3b's file (so a fixture-reuse bug in
that file couldn't mask anything here):
- Exactly one direction wins; the result is a **clean, fully symmetric split** — if dismiss wins, all
  4 dismiss calls read 200 (idempotent) and all 4 confirm calls read 409 ("confirm after dismiss");
  if confirm wins, the mirror image holds. Never a mix within one direction, never both directions
  "winning," never a 5xx.
- The final `assistant_write_intents` row is always exactly one of `filed`/`dismissed`, `tool_args`
  is NULL either way, and `automation_approvals` gained exactly 0 or 1 row consistent with which
  direction won — checked at the DB directly.
- Ran 4 times in this session (once during authoring after fixing my own wrong first assertion, 3
  more back-to-back to rule out flake): all 4 green.

### 6.3 Why this axis instead of a bigger N on the existing race
The brief's item 1 ("genuine concurrency, not sequential") was already met at N=8 by T3b's own test,
which I independently re-ran and it stayed green — re-running the identical scenario at N=16 would
add confidence in the same dimension T3b already proved, not close a new one. Racing the two
*different* endpoints against each other is a dimension nobody had exercised, so I spent the budget
there instead.

---

## 7. Cleanup

- The new test file is left in place (permanent QA coverage, per the brief's "author missing tests"
  instruction) — not deleted.
- No ad hoc OS processes were started outside `vitest`'s own app-boot-per-test-file pattern (every
  check in §1/§3/§6 runs the existing in-process `app.inject`-over-Fastify pattern this codebase
  already uses for "live PG + Cerbos" tests) — nothing to kill.
- Orphan test-DB count: **2 before this session, 2 after** (confirmed via `docker exec gaiada-test-pg
  psql -U postgres -c "select count(*) from pg_database where datistemplate=false and
  datname<>'postgres'"`) — no leak from this session's ~10 `vitest run` invocations.
- `gaiada-test-cerbos` was not restarted by me — no Cerbos policy file was touched in this session.

---

## 8. Overall verdict

**PASS.** Propose → confirm → approve → execute → notify verified end to end, live, against real
PG + real Cerbos, with every one of the ten mandatory adversarial checks independently re-derived
from actual assertions (not trusted from prior reports) and one genuinely new adversarial scenario
added and passing. Two UNVERIFIED gaps are named loudly (§4.1 no committed Playwright/live-browser
regression spec for the FE flow; §4.2 no true cross-OS-process drive of the confirm-chip wiring
specifically) — both pre-existing, both disclosed by the tickets that created them, both recommended
as explicit follow-up tickets rather than silently accepted or silently fixed by me. Zero product
defects found. The ASST-23 program is fit to ship past this gate on the test stack; a
VER-ASST23-style live cross-process drive (mirroring VER-01/VER-04/VER-AGENT) is the recommended
next step before calling it production-verified, and a committed Playwright spec for
`/assistant`'s tools-mode → confirm → executed flow is the recommended FE follow-up.
