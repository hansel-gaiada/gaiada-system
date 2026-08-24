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
