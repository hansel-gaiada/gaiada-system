# Total-estate simulation — findings, run 1

Status: **IN PROGRESS**. Opened 2026-08-24. Harness lives in `simulation/` (see its `CLAUDE.md`).

Corpus for this report: `/var/lib/gaiada-sim/logs/{smoke-02,fast-01,fast-02}/` on `gda-aicenter`.
`fast-02` is the reference run: **314 steps, 4 ticks, 5 departments, 19 real staff**.

Everything below was produced by the estate doing real work, not by a unit test. Each finding names
the evidence and the file, so it can be re-driven rather than taken on trust.

---

## The defects

### F1 — `mcp-hub` advertises argument schemas and enforces none · **HIGH · systemic**

`mcp-hub/src/registry.ts` types `inputSchema` as *"JSON Schema advertised over MCP"*, and
`src/hub.ts:67` dispatches with `decision.tool.handler(args, principal)` — **no validation anywhere
between the MCP request and the handler**. Every tool's `required: [...]` is decorative.

The consequence is not a clean error. `platform-tools.ts:33` does:

```ts
handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/projects`, principal)
```

`String(undefined)` is `"undefined"`, so a model that omits an argument produces
`GET /api/undefined/projects`.

**Observed, not theorised.** The first probe goal of this exercise (`status-reporter`, live runner)
returned: *"Unable to retrieve project data: projects.list tool repeatedly failed (500 errors)."* The
agent burned four attempts and gave up. Nine real run events, zero useful output.

**Blast radius** is every tool in `platform-tools.ts`, `platform-write-tools.ts`, `pm-tools.ts`,
`pipeline-tools.ts`, `delivery-tools.ts`, `module-tools.ts`. The write tools are worse than the read
ones: `platform-write-tools.ts:73` builds `{ name: args.name, clientId: args.clientId }`, so an
omitted field POSTs `undefined` into a create — a data-integrity risk, not just a failed call.

**Fix shape:** validate against the already-declared `inputSchema` once, centrally, in `hub.ts`
before dispatch, and return an MCP `isError` result. One place, and every tool inherits it. Doing it
per-handler is the same mistake in 70 copies.

### F2 — a malformed `:tenantId` reaches Postgres and surfaces as 500 · **HIGH**

```
GET /api/undefined/projects   -> 500 {"error":"internal error","code":"internal_error"}
GET /api/not-a-uuid/pm/tasks  -> 500 {"error":"internal error","code":"internal_error"}
```

Platform log: `[unhandled-exception] GET /api/undefined/projects -> error: invalid input syntax for
type uuid: "undefined"`. The path parameter is passed to the driver unvalidated; Postgres raises; the
exception is unhandled.

This is **independent of F1** and must be fixed separately — F1 is why a bad value gets sent, F2 is
why sending one is a server error instead of a client error. Reproduced in every run.

**Notably narrow.** The other malformed-input probes all behave correctly and produced no findings:
`limit=0`, `limit=999999`, `status=<script>`, a non-uuid `projectId`, a non-uuid comment `entityId`,
a 9,000-character title, and a well-formed-but-absent task id. So this is specifically the tenant
path segment, not general input handling.

**Fix shape:** reject a non-uuid `:tenantId` at the edge (pipe/guard) with a 400. A tenant id that
cannot be a tenant id should never reach authorization, let alone the database.

### F3 — the bot's webhook secret is logged in plaintext · **MEDIUM · security**

`wa-chat-bot` authenticates `POST /webhook` with `?token=<secret>`, and Fastify's request logger
writes the full URL:

```
"req":{"method":"POST","url":"/webhook?token=<the actual shared secret>", ...}
```

So the secret is in the bot's stdout, in `docker logs`, and in Loki for the retention period. Anyone
with log read access has the credential — and log access is normally granted far more freely than
secret access. WAHA's own hook configuration is what puts it in the query string, so this is not the
bot's fault, but it is the bot's exposure.

**Fix shape:** accept the secret from a header (WAHA supports custom hook headers) and keep the
query form only as a deprecated fallback; and/or redact `token` in the logger's `req.url`
serialiser. The redaction is worth doing regardless — it is one serialiser and it closes the whole
class.

### F4 — an unresolvable OBO envelope is indistinguishable from an authorization failure · **LOW · diagnosability**

`AuthGuard` (`platform-nest/src/auth/guards.ts`) looks up `(provider, external_id)` in
`identity_links`; when the row is missing it falls through to `{ ...ANONYMOUS, via }` and the request
proceeds as anonymous. Cerbos then denies, and the caller sees:

```
403 {"error":"not authorized: cerbos denied read on pm_task"}
```

A **typo in an identifier** and a **genuine permission problem** produce the identical response. This
cost real time during bring-up: I chased a phantom Cerbos/RLS bug through five layers — policy,
derived roles, `assemblePrincipal`, RLS row visibility — before the audit row revealed the actual
cause. The tell is `activities.actor_id IS NULL` (`(null actor)`), which nothing surfaces to the
caller.

**Fix shape:** when an OBO envelope is *presented but unresolvable*, that is a 401 about the
envelope, not a 403 about permissions. Presenting an unknown identity is an authentication failure.
At minimum, log it distinctly.

---

## Observations that are not defects, but are decisions

### O1 — an ordinary employee cannot raise a task

`resource_pm_task.yaml` reserves `create`/`delete`/`manage` for `company_admin`/`manager`. On the
live estate exactly **5 of 19** real staff hold `manager` — one lead per department (Azlan/Web Dev,
Monic/Creatives, Rai/SEO, Radit/Social Media, Edward/GM). Everyone else gets **403 on task create**.

The first smoke run skipped three departments entirely until the harness was rebuilt to have leads
raise work and members do it. A `member` *can* still pass the ball (owner decision 2026-08-06,
"anyone can pass the ball") — so the model is "you may not create work, but you may move it".

That may be exactly right. But set against the non-negotiable *"Agency is a first-deploy child
company — the digital-agency vertical must be genuinely operable, not a demo"*, it is worth an
explicit decision rather than an emergent one: in a real agency, anyone can raise an issue.

### O2 — six invented people are on the office floor, indistinguishable from real staff

The live org tree holds 26 people: **20 real, 6 retained placeholders** — Ayu (Owner), Budi (PM),
Citra (Design), Dewi (Copy), Eka (Client Lead), Gaiada Exec (all `@gaiada-creative.test` /
`@gaiada.test`, all still `status = active`).

`retire-placeholder-hr.ts` retained them **deliberately** ("kept five `@gaiada-creative.test` seed
ACTORS") because approval flows need an approver. That is defensible. But the office renders them as
ordinary seated employees, so the floor the owner looks at is 23% fabricated people, and nothing
visually distinguishes them. Given the Office World programme's §0 insists on real names, this is
worth either a visual marker or a decision to retire them once a real approver exists.

### O3 — the approval flow has no drivable owner

`approval:queue` skips every run: the retained placeholder actors have no `identity_links` row, so
they cannot be driven over any service path at all. The approval surface is therefore **untested by
this simulation**. Not a defect — but it means "approvals work" is currently an untested claim.

### O4 — the agentic-native bar is still unmeasured

The corpus computes `parityGaps` (endpoints that succeed on one identity path and fail on another),
which is the bar (`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md`) turned into a
measurement. It is currently **empty, and that is not a pass** — only the service/agent arm is live.
The human arm needs `simulation/scripts/enable-staff-logins.sh`. Until then the table has one arm
and can prove nothing. The run records this itself as `parity-arm-missing`.

---

## What the simulation covers, and what it does not

**Covered, DEV-VERIFIED:** task raise → assign → follow → comment → time-log → priority patch →
**ball handoff** → return → review → assignment-history read, across 5 departments on real people;
real agent goals executing against the real runner, gateway, model and MCP tool surface; the daily
read surfaces; 11 malformed-input probes; real WAHA-shaped inbound webhooks reaching the bot's real
durable intake path (200, ~30–60ms).

**Not covered yet, and why:**

| Gap | Reason |
|---|---|
| **Outbound provider calls** | The fake boundary listens (`:4599`, WAHA-shaped sends + generic provider paths, with injected 429 / 502 / timeout / malformed-200 faults), but **nothing in the estate points at it** — the bot's `WAHA_URL` targets the real WAHA. Pointing it at the stub is an estate env change + restart, deliberately not done unilaterally. Until then `externals.jsonl` stays empty and outbound retry/back-off handling is **untested**. |
| **The human identity arm** | Blocked on the credential change above. |
| **Approvals** | O3. |
| **n8n automation flows** | Not yet driven; the 17 automation principals exist but no scenario triggers a flow. |
| **Client portal** | No scenario acts as a client contact. |

**Safety posture of what did run:** every created record carries `[SIM]` and is ledgered in
`created.jsonl` for precise teardown. Inbound injection is gated **twice** — a config flag *and* a
live check that the bot's session cannot deliver (allow-list of safe states, fails closed). Nothing
was sent to any real handset and no provider quota was spent.

---

# Run 2 — `live-02`, with BOTH identity arms live

1,497 steps, 37+ ticks, live-paced. `scripts/enable-staff-logins.sh` had been run, so this is the
first run where `humanPathLive: true` and the parity table means anything.

A real deploy (`alpha-01.071.0149b`) landed **mid-run**, at 08:29:48. That was not planned, and it
turned out to be the most valuable thing that happened.

## F5 — a deploy drops live traffic on the floor · **MEDIUM · operational · NEW**

The simulation was driving real work when `gaiada-platform-1` restarted. Measured blast radius:

| Window | What |
|---|---|
| 08:29:46 – 08:30:12 (**26s**) | **43 transport failures** — connection refused / fetch failed, no HTTP status at all |
| 08:30:37 – 08:32:27 (**~2 min**) | **26 × 5xx** across `POST /pm/tasks`, `GET /projects`, `GET /notifications`, `GET /pm/tasks?assignee=me`, `GET /pm/productivity` |

So a routine deploy produces roughly **two and a half minutes** in which a logged-in employee gets
connection errors and then server errors on essentially every read surface. Not one endpoint — all
of them.

This is invisible to every existing check. CI does not deploy; the post-deploy gate reads a healthy
`/health` *after* the dust settles; nobody is clicking during the window. It is visible only because
something was driving real traffic through it, which is precisely what a continuous simulation is
for.

**Fix shape:** drain before stop (connection draining at nginx, or a `stop_grace_period` plus a
readiness gate so the proxy stops routing before the container goes), and/or retry-once on
idempotent GETs at the BFF. Worth a deliberate decision — at 7 possible concurrent logins the
current behaviour may be perfectly acceptable, and "we accept a 2-minute window" is a fine answer.
What is not fine is not knowing.

**Not a defect, and worth separating:** the 5xx on those five endpoints are restart turbulence, NOT
endpoint bugs. Every one falls inside the restart window and none recurs outside it. A reader of
`findings.jsonl` who sees `5xx GET /api/:id/projects` and files a ticket against the projects
endpoint would be chasing a ghost.

## F1 and F2 are still present in `alpha-01.071.0149b`

The two known defects fire **straight through** the restart — 08:23:09 to 08:39:23, spanning both
the old and the new build:

```
5xx GET /api/undefined/projects    n=7   08:23:09 .. 08:39:23
5xx GET /api/not-a-uuid/pm/tasks   n=7   08:23:09 .. 08:39:23
malformed-path-segment             n=8   08:23:09 .. 08:39:23
```

So whatever `0149b` contained, it did not close the unvalidated `:tenantId` path. Recorded because
"a fix was deployed" and "the defect is gone" are different claims, and only the second one counts.

## The agentic-native bar: first real measurement

Six endpoints were driven on **both** the human (real OIDC session) and OBO (service-on-behalf-of)
arms:

| Endpoint | human | obo |
|---|---|---|
| `GET /pm/tasks/:id/assignment-history` | 57 ok / 0 fail | 38 ok / 0 fail |
| `PATCH /pm/tasks/:id` | 114 ok / 0 fail | 76 ok / 0 fail |
| `POST /comments` | 171 ok / 0 fail | 122 ok / 1 fail |
| `POST /pm/tasks` | 57 ok / 6 fail | 60 ok / 9 fail |
| `POST /pm/tasks/:id/follow` | 57 ok / 0 fail | 38 ok / 0 fail |
| `POST /pm/tasks/:id/time` | 57 ok / 0 fail | 38 ok / 0 fail |

**No genuine parity gap.** The single `POST /comments` failure is at 08:30:12 — inside the restart
window, status 0, `fetch failed`. The `POST /pm/tasks` failures hit BOTH arms and are likewise the
restart. Every deliberate authorization difference behaved identically under a human and under a
service principal.

**Scope, stated plainly so this is not over-read:** six endpoints, all of them on the delivery
chain. This is evidence for the bar on the PM task surface, not a pass for "every department
capability". Read surfaces, approvals, n8n flows and the client portal remain unmeasured —
`dailyReads` runs on the OBO arm only, so it contributes nothing to the comparison. Widening the
human arm across the read scenarios is the cheapest next increase in coverage.

---

# F6 — the agent layer produces nothing. **0 of 110.** · **HIGH — the headline result**

This is the finding the whole exercise exists to have produced, and it only became visible once
agents were driven continuously rather than probed once.

**120 real goals submitted to the live runner. 110 finished. Zero produced useful work.**

```
budget_exhausted  53
ok                48     <-- see below
failed             9
queued/running    10
```

Representative outcomes, verbatim:

> `budget_exhausted` — *"per-run toolCalls budget exhausted — run suspended for human resume, nothing committed"*
> `ok` — *"Unable to produce status report: projects.list and tasks.list both failed with 500 errors. No project or task data was returned, so open task load per department and biggest risk cannot be determined."*
> `ok` — *"Unable to retrieve project data because projects.list failed repeatedly. No status report can be produced."*

Filtering all 110 finished goals for an outcome that does **not** report failure returns exactly
**one**, and that one is itself a `failed` goal (`tool not on the agent's allow-list:
mcp__gaiada__pm_listTasks`). So the true success count is **zero**.

## Why: F1 and F2, compounding

The platform log shows what the agents are actually sending:

```
GET /api/undefined/projects              -> uuid: "undefined"
GET /api/undefined/projects/undefined/tasks
GET /api/live-02/pm/tasks                -> uuid: "live-02"
GET /api/gaiada/pm/tasks                 -> uuid: "gaiada"
GET /api/Gaiada/pm/tasks                 -> uuid: "Gaiada"
GET /api/live-02/modules/agency/approvals/pending
```

`live-02` is the **simulation's run id**, which appears in the goal text. The model has no validated
`tenantId` to supply (F1: the hub advertises `required` and enforces nothing), so it **guesses one
from surrounding context** — the run id, the company name, the literal string `undefined`. Each guess
reaches Postgres as a uuid cast (F2) and returns 500. The agent retries, burns its tool-call budget,
and suspends.

That is the whole failure loop, and it means **F1 and F2 are not two tidy input-validation bugs. They
are jointly the reason the agentic layer does not work at all.** Their severity should be read
accordingly.

## F7 — a goal that accomplished nothing is reported `ok` · **HIGH**

48 goals carry `status: "ok"` while their own `outcome` says the work was impossible. Any supervisor
view, dashboard or report counting `status = ok` would show **48 successes today**.

This is the most dangerous finding here, and it is independent of F1/F2: even after those are fixed,
a goal that fails to achieve its objective must not terminate `ok`. The status is derived from "the
run completed without throwing" rather than from "the objective was met". A human reading the office
canvas sees busy agent desks; a human reading the goal list sees `ok`; and neither is true.

## F8 — an agent called a tool that is not on its own allow-list · **MEDIUM**

`failed — tool not on the agent's allow-list: mcp__gaiada__pm_listTasks`. Either the agent's prompt
advertises a tool its allow-list denies, or the allow-list and the registry have drifted apart. Nine
goals ended `failed`; this is the shape of at least one of them.

## Correction to run 2's `POST /pm/tasks` conclusion

The earlier section attributes all `POST /pm/tasks` 5xx to restart turbulence. That was wrong for one
of the seven. Six fall inside 08:30:37–08:32:27, but one fired at **08:48:41**, sixteen minutes after
the platform stabilised:

```
POST /api/019fb652-c68b-728f-b779-04465fcec5ae/pm/tasks
  -> invalid input syntax for type uuid: "not-a-uuid"
```

The tenant is valid; the **body** carries `projectId: "not-a-uuid"` (the `create-task-bad-project`
edge probe, which fires on a tick stride — hence the apparently random timing). So uuid validation is
missing on **body fields as well as path parameters**, and F2's scope is wider than first recorded.
It returns 500 where 400 belongs, same as the path case.
