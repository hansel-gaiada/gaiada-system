# What is blocked and what is unblocked — 2026-08-06

Written so each item below can become its own focused session. Build health at the time of writing:
**CI green on all 9 jobs** at `cec0504` (current `main`) — platform-nest, platform-ui, mcp-hub,
ai-agents, gateway-go, sync-engine-go, wa-chat-bot, report-renderer, observability-lint.

Programme progress: **~37 of 47** tickets across the D14 resume path + the ERP assistant.

---

## 1. UNBLOCKED — proceed whenever you like

| Programme | State | Note |
|---|---|---|
| **WS11 delivery pipeline / webdev DEF-3** | **Unblocked.** `deploy.staging` + `deploy.production` are registered in the executable registry with real server-side preconditions. | This was the WD-08 dead end where `wf:delivery` could *never* complete a production deploy unattended. It is closed for the n8n/automation path. |
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

### 2.2 Verification debt (VER-01…04) — needs a live-stack decision
The assistant has **never been driven against a live platform-nest** — only `DEMO_MODE=1`. Also
unverified: D14-08's approvals UI click-through, the live Redis delivery leg for D14-09 item (a), and
a live mcp-hub process.

**Blocker:** these need either `gda-aicenter` or an explicit exception to the 2026-07-31
"local stack OFF, server is truth" ruling. Not a code problem.

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

### Remaining (2 steps)
1. **Cut a release + deploy.** `VERSION`/newest tag are both `alpha-01.019.0047b`, which predates
   `48a9aa7` (the `HERMES_URL`/`HERMES_MODEL` compose passthrough), `b9e0856` (ASST-21) **and** the
   other session's `cec0504`. A cut therefore ships another session's unreleased work — deliberately
   left to the owner rather than done unilaterally.
2. **Three `.env` lines** on the box (I was blocked from writing to the production secrets file, which
   is a reasonable guard):
   ```
   HERMES_URL=http://host.docker.internal:3009
   HERMES_MODEL=hermes
   LLM_CHAIN=gemini,claude,hermes      # append hermes LAST
   ```
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
