# What is blocked and what is unblocked — 2026-08-06

Written so each item below can become its own focused session. Build health at the time of writing:
**CI green on all 9 jobs** at `cec0504` (current `main`) — platform-nest, platform-ui, mcp-hub,
ai-agents, gateway-go, sync-engine-go, wa-chat-bot, report-renderer, observability-lint.

Programme progress: **~37 of 47** tickets across the D14 resume path + the ERP assistant.

---

## 1. UNBLOCKED — proceed whenever you like

| Programme | State | Note |
|---|---|---|
| **WS11 delivery pipeline / webdev DEF-3** | **Unblocked**, but read the note — the original claim here was overstated. | **CORRECTED 2026-08-06 after VER-01.** `deploy.staging` + `deploy.production` are registered with real server-side preconditions, and VER-01 verified the whole executor live. BUT `deploy.staging` is `impact:"low"`, so it **never suspends on the D14 gate in the first place** — its registry entry therefore serves the *agent re-run* path, not the n8n path. The WD-08 dead end (`wf:delivery` unable to finish a prod deploy unattended) was never an impact-gate problem for the staging tool at all. `deploy.production`'s tier is the one that matters; verify it per-tool before claiming any specific pipeline is unblocked. Two independent passes agree on this (the D14-15 registry comment was inverted the same way). |
| **Agentic-native criterion 4** | Satisfiable. The mechanism ("approval must actually execute on decision") exists. | Per-capability compliance still needs each write registered individually — one ticket per tool, by decision. |
| **ERP assistant phases 0–3 + drawer** | Built, CI green, on `main`. | Needs 2 remaining server steps to be *usable* — see §3. |
| **Mail subsystem / magic links / employee portal** (other session) | Landed, CI green. | No D14 dependency for anything except the approval-action half (§2.4). |

---

## 2. BLOCKED — with the exact blocker

### 2.1 The assurance ceiling — ONE fix unblocks four things
**Blocker:** `mcp-hub/src/principal.ts` mints **every** envelope-derived OBO principal at
`assurance: "low"`, and there is no code path to `"verified"`. D14-14's `approvals.resolveExecute`
is registered `minAssurance: "verified"` (deliberately — the honest tier).

**Therefore blocked:**
- **PM Phase 4 `J2`** write half (bot/agent writes to PM)
- **ASST-23** — assistant write proposals (assistant Phase 6)
- **D14-17** — assistant write-tool registry entries
- **Hermes' own MCP authority** into the ERP — the live two-way link runs low-assurance for the
  same reason, so this is one gap seen from two directions

**Options (owner decision):**
1. Build a verified-assurance minting path for agent envelopes — the real fix; touches D4 dual-proof
   enrollment territory. *Recommended.*
2. Lower `approvals.resolveExecute` to `minAssurance: "low"` — works immediately, puts a
   high-impact write behind the weakest gate. *Argued against.*
3. Accept the agent-write half stays inert and stop counting it as deliverable.

**Session shape:** one design session (architect) + one implementation ticket. Everything above
unblocks together.

### 2.2 Verification debt (VER-01…04) — ✅ CLOSED 2026-08-06
~~The assistant has never been driven against a live platform-nest.~~ **All four VER tickets now
PASS.** Resolved by running the services **from source** against the already-running
`gaiada-test-pg` + `gaiada-test-cerbos` — which is *not* an exception to the 2026-07-31 "local stack
OFF, server is truth" ruling, because it stands up no local stack: it borrows two containers that
were already up and adds ordinary processes on scratch ports. That recipe is the reusable answer for
every future live-verification ticket. Reports:

| | Verdict |
|---|---|
| `2026-08-06-ver-01-deploy-legs-report.md` | D14 executor: authority rule, precondition gating, single-use claim under **real** concurrency (8 racing calls + live consumer ⇒ exactly one won), registry-scoping |
| `2026-08-06-ver-02-live-assistant-report.md` | Assistant live, not DEMO_MODE-only: real SSE, owner-privacy fails closed vs a real `company_admin`, tenant re-scoping proven at the RLS layer, stop-cancels-upstream proven at 4 layers |
| `2026-08-06-ver-03-a11y-dark-report.md` | 4 real a11y defects found + fixed + unit-tested; the dark-theme premise was stale (already tokenized) |
| `2026-08-06-ver-04-live-legs-report.md` | The two previously-stubbed D14 legs (Redis delivery, executed_by ≠ decided_by) |

**Two methodology cautions worth carrying forward.** Proving a *non-event* (a webhook that must NOT
fire) needs a second independent source — VER-01 used mcp-hub's own audit log showing zero entries.
And an `echo`-fast provider **cannot** be used to race a cancellation: it completes in <1ms, so
VER-02 had to introduce a slow test-double before `stop()` was testable at all; three attempts
against `echo` all reported `stopped:false`, which would have read as a product bug.

### 2.3 Tool-call transcript fidelity — needs an architect call
`assistant_tool_calls` rows carry `args = {}` and no `duration_ms`, because the ai-agents runner's
step transcript is only `"<tool> ok"` / `"<tool> failed"`. Real args exist only for a suspended
write's `automation_approvals.tool_args`. Closing it means richer tool steps from `ai-agents` —
which would put raw args in the agents DB. Judged a worse trade by the implementer; I agree, but it
means the UI shows *which* tool ran, not what it was called with.
Same root cause: a stale-wall-1 hub deny lands `failed` rather than `denied`.

### 2.4 D14-16 — mail approval-action registry entry
**Deferred by design.** The mail approval-action tool does not exist yet, so an entry would be dead
config. Build it *with* the mail program, not before.

### 2.5 ASST-20 — feedback → episodic
**Deferred post-v1.** Little value until eval loops consume the signal.

### 2.6 CHORE-02 — 804 orphaned databases on `gaiada-postgres-1`
Not urgent (shm at 2%). Must use an explicit **KEEP-allowlist**, never a pattern denylist: that
instance holds `gaiada`, `gaiada_platform`, `gaiada_knowledge`, `gaiada_keycloak`, `gaiada_n8n`, and
the orphans use many prefixes (`qa1_`, `sm14b_`, `sm50_`, `qa081013_`, `wd29full_`, `arch1_`…).

### 2.7 ASST-24 — the phases 2–6 QA gate
Buildable now, but it will run with **ASST-23 outstanding** (blocked by §2.1). Worth running anyway.

---

## 3. Server (`gda-aicenter`) — done vs remaining

### Done this session (verified)
- **Assistant module enabled additively** — `Gaia Digital Agency` now has 11 modules, all 10
  originals preserved. **Do NOT re-run `npm run seed:agency` to do this:** `ensureCompany`
  overwrites `enabled_modules` wholesale and its hardcoded list is only
  `[agency,hr,reports,assistant]`, so a re-run would drop `pm`, `it`, `billing`, `knowledge`,
  `clients`, `automation-console`, `search`.
- **nginx SSE block applied by hand** — backed up, extracted from the repo's committed version,
  inserted before `location /`, `nginx -t` passed, reloaded. Hand-edited deliberately: the live file
  carries an n8n fix that exists nowhere else, so copying the repo file would revert it.
- **hermes-gateway updated** — `server.mjs` + `stream-parser.mjs` installed (backup kept), restarted;
  process start (01:04:04) is newer than the file (01:01:06), so it is running the new code.
- **Everything documented** in the gitignored `CREDENTIALS.local.md` §10 + §6 index, and in the
  `hermes-bidirectional` memory.

### Remaining — ✅ BOTH DONE 2026-08-06

1. **Release cut + deploy — DONE.** Another session cut `alpha-01.021.0053a`, which contains **all**
   of this session's work (HERMES wiring, ASST-21, the hermes session-fork fix, the three-hop session
   signal). Built, deployed, live. **Tag parity verified after the deploy completed** — `.env`
   `GAIADA_TAG`, `.env` `APP_VERSION`, `.deployed-tag` and the running image all read
   `alpha-01.021.0053a`, so a `docker compose up -d` is safe.

   **New observation about the stale-tag footgun:** mid-deploy the box is *transiently* inconsistent
   (image already at the new tag while `.env`/`.deployed-tag` still read the old one). During that
   window an `up -d` really would roll back. The correct response is to **wait for the run to finish
   and re-check**, not to "fix" `.env` by hand — the deploy writes it at the end. Do not treat a
   mid-flight mismatch as the documented bug.

2. **The three `.env` lines — ALREADY SET**, and correctly:
   ```
   LLM_CHAIN=gemini,claude,hermes      # hermes appended LAST
   HERMES_URL=http://host.docker.internal:3009
   HERMES_MODEL=hermes
   ```
   Confirmed reaching the `ai-gateway` container, so Hermes is a live selectable brain on the server.

   **Correction to an earlier claim in this document's own history:** two prior "findings" of mine
   (`.env` has no `GAIADA_TAG` so the footgun doesn't apply; neither `HERMES` var is set) were reads
   of **`~/gaiada/.env`, which does not exist**. The core-stack env file is
   `~/gaiada/infra/compose/.env` — as `CREDENTIALS.local.md` §6 already documented. A silent
   empty/missing file read like a real negative result twice; use an explicit existence check.
   Appending `hermes` last leaves unhinted behaviour identical for every existing caller of the shared
   gateway (wa-chat-bot, knowledge, search). Until it is in the chain the brain picker is an **honest
   no-op**: `chain.RunWithHint` only reorders a provider already in the chain, and an unmatched hint
   falls through silently — the reply still arrives and `meta` names who really served.

### Then verify (keep it small — Hermes is on free-tier Gemini, both creds already seen 429-ing)
- One tiny Hermes stream call (`"Reply with the single word: ok"`) — see `CREDENTIALS.local.md` §10a.
- One authenticated assistant thread: send → confirm **incremental** frames (the only real proof the
  nginx block works) → pick Hermes → confirm the badge names Hermes.

---

## 4. Traps found this session — do not re-derive

- **`hermes-gateway` checks auth BEFORE routing.** Every path, including a nonexistent one, returns
  `unauthorized`. A 401 proves nothing about whether a route exists.
- **A 307 proves nothing about routing** either — platform-ui's middleware redirects unauthenticated
  requests before routing, so `/definitely-not-a-page` 307s too.
- **`jsonb_set(..., create_missing=true)` only creates the FINAL path segment.** A nested write
  silently no-ops when an intermediate key is absent. Use a nested `||` merge and test that siblings
  survive.
- **CI never touches `hermes-gateway`** — it is the only non-dockerized service, so it goes stale
  silently (it was 5 days behind).
- **CI failures on my commits were mail-side three times** (`hr.test.ts` count assertions,
  `mail_log_reply_token_key` duplicate in `corpus.test.ts`). Check ownership before assuming a
  regression.
- Pre-existing **duplicate migration numbers at `0003` and `0018`**.
- **`role="log"` is an implicit `aria-live="polite"` region, and a TEXT-NODE mutation counts.** The
  assistant's typewriter smoother rewrites the streaming row every 16ms inside `.asst-thread`, which
  is the "announce every token" screen-reader failure mode *without anyone writing
  `aria-live="assertive"` anywhere*. Auditing for the explicit attribute would have missed it. Fix is
  to scope `aria-live="off"` to the streaming row only, so other rows still announce.
- **An `echo` provider cannot test cancellation** (see §2.2) and **proving a non-event needs a second
  source** (also §2.2).
- **`~/gaiada/.env` does not exist** — it's `~/gaiada/infra/compose/.env` (see §3).

---

## 5. Follow-ups routed to other lanes (not done here, deliberately)

- **`components/pm/TaskDrawer.tsx` has the identical missing Tab-focus-trap bug** that VER-03 fixed in
  `AssistantDrawer.tsx` (the assistant drawer was modelled on it). Focus can walk off the panel onto
  the shell behind the scrim. That file is **Lane B (PM console)** per `docs/ui-work-split.md`, so it
  was flagged rather than touched — but it is a known, located, one-pattern fix.
- **Two cross-lane token questions for the `ui-work-split` Phase-0 owner:** whether `--accent` needs
  its own text-contrast tier, and whether the underline-inputs' `outline:none` convention clears
  WCAG 2.4.11. Both are systemic, so neither was decided unilaterally.
