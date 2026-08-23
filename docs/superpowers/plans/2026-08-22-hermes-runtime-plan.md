# Hermes runtime plan — the agent's own side: config, skills, memory, RAG

**Status: PLANNED.** Written 2026-08-22.

The three other 2026-08-22 docs are **ERP-side** — what the platform must build so agents can act
safely. This one is the **Hermes side**: the thing actually running on `gda-aicenter`. It covers what
Hermes' own setup is, whether `hermes-gateway` survives the architecture, and how memory and RAG are
supposed to work across three stores that currently do not know about each other.

Companions: `2026-08-22-hermes-build-inventory.md` (counts) ·
`2026-08-22-hermes-moe-personas-training.md` (design) · `2026-08-22-pantheon-airlock-design.md`.

---

## 1. What is actually on the box today (verified from `CREDENTIALS.local.md` §10a–10c)

| Piece | Where | State |
|---|---|---|
| **Hermes itself** | `/opt/hermes-zen/` — `HERMES_HOME`, `azlan:azlan`, **0700** | hand-installed |
| Its config | `/opt/hermes-zen/config.yaml` — `model.provider: "gemini"` | hand-edited |
| Its MCP client into our hub | `config.yaml` → `mcp_servers.gaiada` | DEV-VERIFIED both directions |
| Provider creds / session | `/opt/hermes-zen/.env`, `auth.json` (0600) | server-only |
| **Its version history** | `config.yaml.bak-20260730-deepseek`, `.bak-preDeepseekSwitch`, `.bak-preGaiadaMCP`, `.gemini.bak` | **a pile of `.bak` files** |
| The shim | `/opt/hermes-gateway/{server.mjs,stream-parser.mjs}` + systemd | outside CI |
| Agent working dir | `/opt/hermes-gateway/work` (`HERMES_CWD`) — tool isolation | — |

### 1.1 The two findings that matter most

**① Hermes' brain is not in version control.** Its config, its model choice, its MCP wiring — and
whatever persona and skills it carries — exist **only as hand-edited files on one box**, with `.bak`
files as the change history. This directly violates the estate's own standing rule: *a hand-applied
infra change has a maximum lifetime of one deploy.* Every other component ships by tag; the component
the entire orchestration plan depends on does not.

**② Hermes runs on free-tier Gemini, with an explicit "keep test volume low" warning.** The router
that all 14 seats are supposed to route through is, today, on a free tier. **This is a capacity gate,
not a detail** — it will not survive employee traffic, and it must be resolved before Stage 2 shadow
mode, which deliberately generates ≥200 real requests per seat.

### 1.2 The honest gap in this document

**I have not seen inside `config.yaml` beyond `model.provider` and `mcp_servers.gaiada`.** Whether
Hermes has a `soul.md`, how it defines skills, what its memory format is, and what its tool-approval
model looks like are **not recorded anywhere in this repo**. §5's first task is therefore *discovery*,
not design — inventory the box, then write the contract. Nothing below invents a Hermes config schema.

---

## 2. Do we need `hermes-gateway`? — what it is actually for

**What it does:** a zero-dependency HTTP shim exposing Hermes through the **Gateway contract**
(`POST /complete`, `POST /media`, `POST /complete/stream`), by shelling out to `hermes -z <prompt>`
and parsing the reply out of its boxed transcript. Its purpose was to make the local Hermes agent the
**AI brain of `wa-chat-bot`** in place of cloud Gemini, with no bot changes — because the bot holds no
model key and reaches everything through that contract.

So it exists to make **Hermes look like a model**.

### 2.1 Why that shape does not survive the new architecture

The five-plane rule (08-10 §2) says a plane never reaches past the one below: edge → orchestration →
agents → tools → **models**. `hermes-gateway` places Hermes at **P0 (models)**. The new architecture
places Hermes at **P3 (orchestration)**.

**Concretely: it exposes an agent — one with tools, skills and memory — through an interface whose
callers believe they are calling an LLM.** A bot asking for a summary is, underneath, invoking
something that can call tools. The README already documents the symptom: an unapproved tool call
hangs until `HERMES_STREAM_TIMEOUT_MS` turns it into a typed error. That is not a bug in the shim; it
is the plane conflation showing through.

### 2.2 The verdict

**Two different jobs, and only one of them needs this shim:**

| Job | Interface | Verdict |
|---|---|---|
| **Hermes as a local brain** (cheap inference for the bot) | `/complete`, `/media` — the Gateway contract | The shim is correct for this, **but the job itself is fading**: local inference tops out around 12.5 tok/s, `gemma-mm` does not fit the Arc iGPU, and the local stack is OFF by owner decision |
| **Hermes as the router** (the new architecture) | needs `submitRequest` / `getStatus` / `resumeSession` / `listAgents` — **not a completion endpoint** | The shim is the **wrong shape**. Do not extend it into this |

**DECIDED 2026-08-23 (owner): the local brain is obsolete.** The shim retires with it, and the
router gets its own control API. §7 is the decommission plan.

**Care needed either way:** it is wired in today — `ai-gateway-go` carries a `hermes` provider, and on
the trial box `GATEWAY_CENTRAL_URL` points at the shim, so `central-forward` reaches the *same*
Hermes. Read the compose comment block at `docker-compose.vps.yml:170` before touching any of it;
that topology has already produced a debugging session where every brain-picker option was inert.

**Note the one thing that changes because of the retirement:** the long-standing "get `hermes-gateway`
into CI" item is now **dropped, not deferred**. Pipeline work on a component being removed is wasted;
the risk it carried (a hand-deployed unit that went five days stale silently) is closed by deleting
it, not by shipping it properly. §7.5 step 7 is where it actually goes away.

---

## 3. The Hermes-side component that does not exist yet

Everything in §1 argues for one thing: **a `hermes-config/` component in the repo**, versioned,
reviewed, and deployed by tag like everything else.

```
hermes-config/
  config.yaml.tmpl        model provider · MCP servers · approval policy — secrets by env ref only
  soul/                   the router's identity  (Zedanne's persona pack, symlinked from persona/)
  skills/                 whatever Hermes' skill format turns out to be (§5 discovery)
  mcp/gaiada.json         the MCP client entry into our hub — TODAY HAND-WRITTEN on the box
  README.md               how it deploys, how to roll back
  test/                   config lint + a smoke run against a fake hermes binary
```

**Non-negotiables for it:**

- **No secrets in the repo.** `.env` and `auth.json` stay server-only, referenced by name. The
  template ships; the values do not.
- **The MCP client entry is generated, not hand-written.** It is the one wire that gives Hermes its
  tool surface — hand-editing it on the box is how the tool view silently drifts from the registry.
- **The persona is the same artifact as everywhere else.** Zedanne's `soul` IS the persona pack from
  the personas doc §5.2 — not a second, divergent definition. One source, two consumers; this estate
  has already paid for mirrors that drift.
- **Approvals stay ON.** `--yolo` is never the default. Autonomy comes from the risk ladder, which is
  enforced in the hub where it is auditable — never from a flag on the agent's own command line.

---

## 4. Memory — three stores today, and the rule that orders them

This is the part with no plan at all today, and it is the one most likely to cause a data incident.

### 4.1 What exists

| Store | Where | Holds | Governed? |
|---|---|---|---|
| **Hermes' own memory** | inside `/opt/hermes-zen`, format unknown | whatever it has learned from conversations | **NO** — no tenancy, no RLS, no backup, no retention, no audit |
| **Episodic** | `agent_episodes` + `agent_episode_feedback` (`ai-agents`) | what agents did, human feedback labels | partly — Postgres, but DB placement undecided |
| **Semantic / RAG** | `knowledge_chunks` in **`gaiada_knowledge`**, pgvector, D9-isolated | ERP records + the public gaiada.com crawl | **YES** — two-tier `audience`, tenant pre-filter, own role |
| **Knowledge graph** | `ai-agents/src/knowledge/graph.ts`, fed by the event bridge | entity relations | partly |
| **Business truth** | `gaiada_platform` | the actual records | **YES** — RLS, Cerbos, per-service roles |

### 4.2 The problem: Hermes' local memory is an ungoverned PII store

An ERP router that remembers things about employees, in a file on a box, is:

- **untenanted** — nothing stops a memory formed in company A from surfacing in company B. In a
  holding-OS serving multiple businesses this is the **highest-severity failure mode in the design**;
- **unauditable** — it cannot answer "what does the system know about Alice?";
- **irrevocable** — Alice leaves, and her data is in an opaque file no process reaches;
- **unbacked-up** — and 0700 on one box;
- **outside the legal gate** — the estate requires PII encrypted at rest and gates real employee data
  behind Legal Gate 1. A file-based agent memory clears none of that.

### 4.3 The governing rule

> **Hermes keeps conversation state only. Every durable memory goes to a governed store, through a
> tool, under the caller's tenancy.**

Session state (the current thread, `--resume <id>`) is fine and useful — it is short-lived, scoped to
one conversation, and carries no cross-tenant reach. Anything that should outlive the conversation
gets written through `knowledge.*` or the episodic store, where tenancy, retention, audit and
revocation already exist.

**And the second half of the rule, which prevents a whole class of stale-answer bugs:**

> **Memory is context. The platform is truth.** An agent must never answer a business question from
> memory. It remembers *that* it discussed a task; it re-reads the task before saying anything about
> its status.

### 4.4 The four tiers, and who owns each

| Tier | Lifetime | Store | Tenancy |
|---|---|---|---|
| **Session** | one conversation, TTL'd | Hermes local | the caller's, by construction |
| **Episodic** | per run + feedback | `agent_episodes` | `tenant_id` (column exists) |
| **Semantic** | the corpus | `knowledge_chunks` | `audience` tier + tenant pre-filter |
| **Relational** | entity graph | knowledge graph | via the event bridge |

**Per-seat scoping:** a seat's retrieval is scoped to its `company_scope` and its acting user. Note
the sharp edge — **`sec-guard` reads broadly by design, so its memory becomes a cross-tenant
aggregation.** It is the one seat whose memory needs an explicit isolation decision rather than the
default. (It is also read-only and propose-only, which limits but does not remove the exposure.)

---

## 5. Does agent memory need its own database?

### 5.1 The precedent already set

The DB topology plan gives the estate's own answer shape: `gaiada_platform` (authoritative business
records), **`gaiada_knowledge`** (RAG derived store, own `knowledge_owner`/`knowledge_app` roles),
`gaiada_bot` on a separate instance, plus `gaiada_keycloak` and `gaiada_n8n`. The rule stated there:
some things are *"separated by role, not database"* — but **derived, high-volume, regenerable data
earns its own database**, which is exactly why `gaiada_knowledge` is one.

### 5.2 Recommendation: yes — `gaiada_agents`, with a split

**Create `gaiada_agents`** (`agents_owner` migrator / `agents_app` runtime, NOBYPASSRLS non-owner,
same pattern as every other DB) holding **episodes, traces, eval runs, and trainer proposals**.

Three reasons, in order of weight:

1. **Retention differs.** Agent traces contain verbatim user text — the highest-PII, lowest-business-
   value data in the estate. It needs aggressive, independent purging. Sharing a database with
   business records means one retention policy for two very different obligations.
2. **Volume and churn differ.** Traces grow orders of magnitude faster than ERP rows and need their
   own vacuum, index and backup posture.
3. **Blast radius.** `ai-agents` is the newest and fastest-moving component; its RLS mistakes should
   not be able to reach ERP core.

**But split it deliberately — this is the important half:**

| Data | Where | Why |
|---|---|---|
| **The decision** — approvals, `approved_by`/`executed_by`, activity rows | **`gaiada_platform`** | authoritative business records; needs FKs, joins, and the existing audit chain |
| **The reasoning** — episodes, traces, eval runs, proposals | **`gaiada_agents`** | derived, high-volume, high-PII, independently purgeable |

*The record of what was decided is a business fact. The record of how the model got there is
telemetry.* Keeping them in one table would force the strictest retention rule onto both, or the
loosest — and neither is acceptable.

**Cost to accept, stated plainly:** no FK from a trace to a task, so correlation is by id and the
**correlation id (build inventory item 15) becomes load-bearing rather than nice-to-have.**

---

## 6. RAG — reuse it, do not rebuild it

**`gaiada_knowledge` is LIVE**, populated since 2026-08-03, serving two tiers (`public` = the
gaiada.com crawl readable with no identity; `internal` = ERP records behind the tenant pre-filter),
with pgvector + HNSW and an array fallback. **Do not create a second vector store for agents.** Every
seat retrieves through `knowledge.*`, which already carries the tenancy and audience gates.

**Four traps carried forward from the live system:**

- **Embedding dimension is pinned at 768** (`nomic-embed-text`, matching `vector(768)`). **Changing
  the embedding model is a full reindex**, not a config flip — treat it as a migration.
- **"0 errors" does not mean complete.** The first sweep reported `130 sources, 306 chunks, 0 errors`
  while indexing *zero* tasks, because the console writes `pm_tasks` and the sweep read `tasks`.
  **Reconcile every run against source-table counts**; the error count is not evidence.
- **Triggering a sweep is awkward** — the scheduler does not run at t=0 and the admin endpoint needs
  an elevated session. The documented restart-with-short-interval trick is the working path.
- **ACL sub-scoping is unsafe while `scope` is caller-supplied**, and PDF/DOCX bodies are
  metadata-only by design. Both are recorded limits, not bugs to discover again.

### 6.1 What RAG still needs for the workforce

| # | Item | Why |
|---|---|---|
| R1 | **Per-seat retrieval scoping** | a seat retrieves within its `company_scope` ∩ the acting user; today `knowledge.search` has no seat concept |
| R2 | **Persona corpus separation** | a seat's few-shot examples and runbooks must not pollute the business corpus |
| R3 | **Provenance on every answer** | the seat cites which chunks it used — required for the trainer's failure diffs and for a human to check it |
| R4 | **Ingest of the new sources** | runbooks, persona packs, meeting transcripts (subject to the corpus-privacy decision) |
| R5 | **`sec-guard` isolation decision** | broad read ⇒ cross-tenant aggregation (§4.4) |

---

## 7. Decommissioning the local brain — DECIDED 2026-08-23

**Owner decision: local Hermes usage moves to server Hermes usage; the local brain is obsolete now.**
This answers open question 6 and settles §2.2.

### 7.0 ⚠ LIVE STATE PROBED 2026-08-23 — several planning assumptions were wrong

`§7.1–7.6` below were written from the repo. **Probed against `gda-aicenter` on 2026-08-23, the live
box differs materially.** Read this subsection before acting on any of the rest.

| Assumed from the repo | **Actually live** | Consequence |
|---|---|---|
| `GATEWAY_TOPOLOGY_MODE=site` | **`central`** | **The catastrophic ordering trap (§7.2) does NOT currently apply** — cloud providers are not being stripped |
| `GATEWAY_CENTRAL_URL` → the shim | **empty** | the `central-forward` path is already out of play; only the *named* `hermes` provider remains |
| `hermes` merely *available* in the chain | **`LLM_CHAIN=hermes,gemini,claude,openai` — hermes is FIRST** | **Hermes is the stack's PRIMARY brain today, not a fallback.** Retiring it changes the primary path for every LLM call |
| `EMBED_CHAIN=ollama,gemini` | **`EMBED_CHAIN=ollama`** — no fallback at all | **§7.3 is upgraded from "important" to "single point of failure"**: there is zero redundancy on embeddings |
| shim on `:3002` (per its README) | **`:3009`** (`HERMES_URL=http://host.docker.internal:3009`) | the README default is stale; the wiring itself is correct |
| — | shim binds **`0.0.0.0:3009`** | reachable beyond loopback. Auth is fail-closed (401 verified), but this contradicts the estate's "never publish on `0.0.0.0`" rule |

**Two live observations that are findings in their own right:**

**① A 30-second poll has been burning inference 24/7 for over two weeks.** The shim's journal shows a
request every 30s, each consuming **6.5–11 seconds** of model time and returning **4–5 characters** —
against `/opt/hermes-zen`'s configured provider. Service CPU is **14h57m** over 16 days. Whatever this
probe is (health check or availability poll), it is the dominant consumer of the router's inference
budget and explains far more of the free-tier pressure than real usage does. **Find and fix it before
sizing the router's provider tier** — otherwise the capacity decision is made against noise.

**② The shim has served nothing since 2026-08-22 07:17:28** (~24h at time of probing), and latency was
degrading before it stopped: **6.6s at 07:03 → 10.2s by 07:17**, with intermittent missing intervals
from 07:11 onward. `/opt/hermes-zen`'s mtime is **07:17 the same minute**. Something changed at that
moment. The service is still `active (running)`.

> **What this means for the cutover: the local brain may already be dormant.** That de-risks the
> retirement considerably — but it also means the stack has been failing over `hermes → gemini` on
> every call for a day, paying a timeout penalty first, and **nobody noticed**. Confirm which of the
> two it is (no traffic vs. failing calls) before step 4; it changes whether the cutover is a
> formality or a repair.

**Revised step 1.** Because topology is already `central` and `GATEWAY_CENTRAL_URL` is empty, the
first cutover action is simply **removing `hermes` from the head of `LLM_CHAIN`** so `gemini` becomes
primary. The `[dead, dead, echo]` scenario of §7.2 is not reachable from the current configuration —
but keep §7.2 on file, because a future `site`-mode flip makes it live again.

### 7.1 What that means precisely — and the distinction that must not blur

**Hermes-as-*brain* retires. Hermes-as-*router* stays.** The agent at `/opt/hermes-zen` is not going
away — it is the P3 orchestrator the whole workforce plan routes through. What retires is the use of
Hermes as a **model provider** (P0), and the shim that made that possible.

| Retires | Stays |
|---|---|
| `hermes-gateway` shim + its systemd unit | **Hermes the agent** (`/opt/hermes-zen`) — becomes the router |
| The `central-forward` path pointing at the shim | **ollama for EMBEDDINGS** — see §7.3, non-negotiable |
| The named `hermes` chain provider (`HERMES_URL`/`HERMES_MODEL`/`HERMES_TOKEN`) | `whisper` in `MEDIA_CHAIN` |
| `GATEWAY_TOPOLOGY_MODE=site` on gda-aicenter | The gateway as sole key-holder — **strengthened**, §7.4 |
| ollama for **generation** (`OLLAMA_URL`/`OLLAMA_MODEL`) | The brain-picker UI (minus the hermes option) |

### 7.2 ⚠ The ordering trap — not currently reachable (see §7.0), but keep it on file

**There are two independent paths pointing at the shim today**, and the compose comments are explicit
that they are separate code paths that happen to share a target:

1. **`central-forward`** — the older path. `GATEWAY_TOPOLOGY_MODE=site` makes the gateway **strip
   gemini/claude/openai** and append `central-forward`, which POSTs the Gateway contract to
   `GATEWAY_CENTRAL_URL`. On gda-aicenter that URL **is** hermes-gateway.
2. **The named `hermes` provider** (ASST-15) — `HERMES_URL`, reached only when explicitly in
   `LLM_CHAIN` or picked by hint.

**So if the shim is stopped while `TOPOLOGY_MODE` is still `site`, the effective chain becomes
`[hermes(dead), central-forward(dead), echo]`.** Cloud providers were already stripped by site mode,
so there is nothing left to fall back to.

> **The failure is not an error — it is the `echo` terminator answering.** The stack keeps returning
> 200s full of nonsense. Nothing pages. This is the single most dangerous property of this migration:
> **getting the order wrong degrades silently rather than failing loudly.**

**Therefore: flip `GATEWAY_TOPOLOGY_MODE` to `central` and prove a real cloud completion BEFORE the
shim is stopped.** Never the other way round.

*(This topology has already burned one debugging session — the one where every brain-picker option was
inert and the "served by" badge never named Hermes. Read the comment block at
`infra/compose/docker-compose.vps.yml:170` before touching any of it.)*

### 7.3 ⚠ ollama does TWO jobs — retire one, keep the other

`EMBED_CHAIN` is a **separate chain from generation**. **Live it is `EMBED_CHAIN=ollama` with NO
fallback** (§7.0) — so ollama is a hard single point of failure for the entire RAG corpus:

```
LLM_CHAIN     openai,ollama,gemini,claude     ← ollama here RETIRES
EMBED_CHAIN   ollama,gemini                   ← ollama here MUST STAY
OLLAMA_EMBED_MODEL = nomic-embed-text         ← 768 dims
```

**`nomic-embed-text` emits 768 dimensions, matching the `vector(768)` column** created by platform
migration `0034_module_search.sql` and used by the live `knowledge_chunks` store.

> **Removing ollama wholesale would silently break embeddings, and switching the embedding model is a
> FULL REINDEX of the entire RAG corpus — not a config flip.** Retire ollama from `LLM_CHAIN` only.
> Leave `EMBED_CHAIN`, `OLLAMA_URL` and `OLLAMA_EMBED_MODEL` untouched.

### 7.4 The violation this migration closes

`CLAUDE.md` carries a **non-negotiable**: *"Only the Gateway holds provider keys. No other service
ever does."*

**Hermes is currently in violation.** `CREDENTIALS.local.md` §10b records `/opt/hermes-zen/.env` and
`auth.json` as holding **provider creds / session** — Hermes runs on its own free-tier Gemini
credential, entirely outside the gateway's DLP, daily cost cap, egress audit and failover.

**Consolidating on the server is the moment to fix that:**

- Point Hermes' own `model.provider` at the **ai-gateway**, not at a provider directly.
- **Delete the provider credentials** from `/opt/hermes-zen/.env` and `auth.json`.
- Result: the router's own inference becomes metered, capped, audited and failover-covered like every
  other call in the estate — and **blocker B8 (free-tier Gemini) is closed by construction**, because
  Hermes stops choosing its own provider at all.

This is the highest-value part of the whole decommission, and it is easy to miss because it looks
like a config detail rather than a control.

### 7.5 Cutover runbook

**Pre-flight**

- Confirm cloud provider keys are present in `infra/compose/.env` (the gateway must have something to
  fall back *to* before anything is removed).
- **Snapshot** the current values of `GATEWAY_TOPOLOGY_MODE`, `GATEWAY_CENTRAL_URL`, `HERMES_URL`,
  `HERMES_MODEL`, `HERMES_TOKEN`, `LLM_CHAIN`, `EMBED_CHAIN`, `MEDIA_CHAIN` — this snapshot is the
  rollback.
- ⚠ **`up -d` with a stale `.env` silently rolls the release back.** Source the env properly and
  export `GAIADA_TAG` / `APP_VERSION` before any compose command.

| Step | Action | Verify before continuing |
|---|---|---|
| **1** | `GATEWAY_TOPOLOGY_MODE=central`; ensure `hermes` is **not** in `LLM_CHAIN`; **leave `EMBED_CHAIN` alone**. Restart `ai-gateway` | A real completion returns real content and **"served by" names a cloud provider — never `echo`**. This is the gate for everything below |
| **2** | Clear `HERMES_URL`, `HERMES_MODEL`, `HERMES_TOKEN` | Completions still succeed; the brain picker no longer offers a working hermes option |
| **3** | Clear `GATEWAY_CENTRAL_URL` | Completions still succeed |
| **4** | `systemctl stop` + `disable hermes-gateway` | **Completions still succeed** — this is the proof steps 1–3 actually took. **Leave the files on disk for a soak period; do not delete yet** |
| **5** | Repoint `/opt/hermes-zen/config.yaml` `model.provider` at the ai-gateway; **delete provider creds from `.env` + `auth.json`** (§7.4) | Hermes answers a prompt **and the gateway logs the call** — both halves, or the key is still being used from somewhere |
| **6** | Verify embeddings independently | A `knowledge.search` returns hits; a fresh ingest produces 768-dim vectors. **Do this explicitly — it is the step most likely to be assumed rather than checked** |
| **7** | After a clean soak: remove `HERMES_*` from compose, delete `/opt/hermes-gateway/`, archive `hermes-gateway/` in the repo | Full stack verification |

**Rollback at any step:** restore the snapshotted env values and `systemctl start hermes-gateway`.
Rollback stays available until step 7, which is why step 7 waits.

**Do not treat this as a hand-applied change that lives past one deploy.** Compose defaults belong in
git and ship by tag; only the server-side `.env` values are edited on the box, and they should be
reconciled into `.env.example` in the same change.

### 7.6 What this settles in the rest of the plan

| Was | Now |
|---|---|
| §2.2 "does the shim survive?" | **No.** It retires; the router gets its own control API (H4) |
| H9 "retire or re-scope the local-brain experiment" | **Retire.** Becomes the §7.5 cutover |
| B8 free-tier Gemini capacity gate | **Closed by §7.4** — Hermes stops holding its own provider credential and draws through the gateway |
| Open question 6 | **Answered** |
| `ai-gateway-go`'s `hermes` provider *code* | Leave in place, unwired. Removing code is a separate, lower-priority change with its own tests — do not bundle it into a live cutover |

---

## 8. Build order — the Hermes side

| # | Item | Depends on |
|---|---|---|
| **H0** | **Inventory `/opt/hermes-zen`** — config schema, soul/persona format, skills format, memory format, approval model. *Discovery, not design.* Everything below is shaped by what this finds | — |
| **H1** | **Cutover §7.5** — retire the local brain; Hermes draws inference **through the gateway**, closing the free-tier capacity gate and the provider-key violation | H0 |
| **H2** | Create `hermes-config/` in the repo; move config, MCP entry, soul, skills under version control; secrets stay server-side by reference | H0 |
| **H3** | ~~`hermes-gateway` into CI~~ — **dropped: it retires instead (§7).** Do not spend pipeline work on a component being removed | — |
| **H4** | Router control API (`submitRequest`/`getStatus`/`resumeSession`/`listAgents`) — **a new surface, not an extension of the shim** | H2, `agents.*` |
| **H5** | Cut Hermes' tool view to the router set. Acceptance: **it provably cannot call a PM tool directly** | H4 |
| **H6** | `gaiada_agents` database + roles; move episodes/traces off wherever they currently land | — |
| **H7** | Memory rule enforced: Hermes keeps session state only; durable writes go through tools | H2, H6 |
| **H8** | RAG items R1–R5 | H6 |
| **H9** | Post-soak cleanup: remove `HERMES_*` from compose, delete `/opt/hermes-gateway/`, archive the repo component | H1, H4 |

**H0 first, and genuinely first.** Four things in this plan are shaped by what is actually in that
directory, and guessing at them would produce exactly the half-built plan this is meant to avoid.

---

## 9. Open questions

1. **What is actually in `/opt/hermes-zen`?** (H0.) Soul/persona format, skills format, memory format,
   approval model. Cannot be answered from this repo.
2. ~~What provider and tier does the router run on?~~ **ANSWERED by §7.4** — it draws through the
   gateway. Remaining: which capability class and cost tier the router seat gets.
3. **Where do `agent_episodes` currently point?** Confirm before moving them to `gaiada_agents`.
4. **Does Hermes' own memory contain employee data today?** If yes, it is an ungoverned PII store and
   needs a purge decision, not just a migration path.
5. **Does `sec-guard` get isolated memory**, given broad read ⇒ cross-tenant aggregation?
6. ~~Is the local-brain experiment still wanted?~~ **ANSWERED 2026-08-23: no.** See §7.
7. **Does anything outside this estate call `hermes-gateway`?** The cutover assumes only the gateway
   and the bot do. Confirm before step 4.
