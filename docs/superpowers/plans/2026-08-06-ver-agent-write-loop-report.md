# VER-AGENT — the D14 **agent** write loop, end to end on a live stack: evidence report

**Scope:** verification only. No production code changed. Two findings, both *correct behaviour* rather
than defects, plus one pre-existing fixture gap.

**What this closes.** `alpha-01.020.0052a` shipped assurance minting and I could only assert it at the
flag level (`/admin/info` → `assuranceElevationConfigured: true`). Nothing had ever driven the thing it
exists for: **an agent's suspended write being approved by a human and then actually executing.** That
path runs through `approvals.resolveExecute`, which is `minAssurance:"verified"` — so before this it was
statically unreachable, and VER-01 deliberately left `HUB_ASSURANCE_TOKEN` unset (both deploy tools are
`minAssurance:"low"`, so the verified tier had never been exercised live by anything).

**Recipe:** §2.2's — services from source against the already-running `gaiada-test-pg` /
`gaiada-test-cerbos` / `gaiada-redis-test-1`. Stands up no local stack, so it stays inside the
2026-07-31 "local stack OFF, server is truth" ruling.

## 0. What was started

| Component | How | Port | Notes |
|---|---|---|---|
| platform-nest | `node dist/main.js` (`npm run build` clean) | `:3030` | `PLATFORM_PORT`, **not** `PORT` — the default `:3004` was already taken by another session |
| mcp-hub | `npx tsx src/server.ts` | `:3012` | Cerbos-authoritative (`CERBOS_URL` set), so every decision below is the real policy path, not the in-code fallback |

Shared on both: `HUB_SERVICE_TOKEN=veragent-hub-token`,
**`HUB_ASSURANCE_TOKEN=veragent-assurance-token`** (the new one — the whole point of this run),
`PLATFORM_SERVICE_TOKEN`, `APPROVAL_GRANT_SECRET`. `HUB_REVOCATION_CHECK=true`, because elevation
conjunct 3 rides that same `/principal/resolve` lookup.

Two startup traps worth recording: the runtime role `platform_app_test` is NOBYPASSRLS and does not own
the schema, so bootstrap's `migrate()` fails `42501 permission denied for schema public` — migrations
need `MIGRATE_DATABASE_URL` as the superuser (a no-op here beyond `0085_assistant_write_intents.sql`)
while the app keeps the restricted role, which is what keeps RLS real under test. And `docker exec psql`
works passwordless over the local socket while TCP needs the real password
(`docker inspect gaiada-test-pg` → `POSTGRES_PASSWORD`).

## 1. The assurance tier itself — 5/5

Same identity throughout: `whatsapp / 62811001@c.us` → `design@gaiada-creative.test`, the only
non-automation VERIFIED `identity_links` row in the fixture DB.

| | Call | Result |
|---|---|---|
| A | `approvals.resolveExecute`, **plain** token | `denied: approvals.resolveExecute requires verified assurance; caller has low (step up on a verified surface)` |
| B | same call, **elevated** token | **allowed** — cleared the gate, reached the platform, `{"match":"none"}` (correct: no row matches empty args) |
| C | same call, elevated token, **`n8n`/`wf:delivery`** envelope | `denied: … requires verified assurance; caller has low` — **the §A13 line holds live** |
| D | `whoami`, **elevated** token | `{"provider":"whatsapp","externalId":"62811001@c.us","assurance":"verified"}` |
| E | `whoami`, **plain** token | `{"provider":"whatsapp","externalId":"62811001@c.us","assurance":"low"}` |

**D and E are the design's central claim, proven:** one identity, one already-verified D4 link, two
tiers — decided by *which service is calling*, never by anything the caller can assert. That is what
keeps `principal.ts`'s founding rule ("chat-surface envelopes can only ever mint LOW") literally true
even for an identity whose link IS verified. C proves the automation refusal is not theoretical.

## 2. The full loop — PASS

`task-filer` / `pm.createTask`, filed `origin='agent'` through the hub's own `approvals.request`
(agent envelope), approved over real HTTP, then resolved by the agent:

```
FILE     {"id":"019fd613-b35b-73ce-bc91-255b9266bd92","status":"pending"}   origin=agent  workflow_id=task-filer
DECIDE   {"id":"019fd613-b35b-73ce-bc91-255b9266bd92","status":"approved"}  (group_executive, HTTP 200)
RESOLVE  plain token    -> denied: … requires verified assurance; caller has low        <- negative control
RESOLVE  elevated token -> {"match":"executed","consumed":false,
                            "result":"{\"id\":\"019fd613-b4f3-701e-8b40-d1c872cba7a0\"}"}
ROW      approved / exec=executed / err=- /
         executed_by=019fd4ea-12e8… (hansel, the REQUESTER)
         decided_by =019fd4ea-12e4… (exec,   the APPROVER)      <- different ids, live
```

And the write is real, not just a claimed one:

```
 id                                   | title                                     | project_id        | tenant_id
 019fd613-b4f3-701e-8b40-d1c872cba7a0 | VER-AGENT loop proof run3 — filed by …    | 019fd4ea-13a5…    | 019fd4ea-12c4…
```

The negative control ran **against the same approved row**, in the same session, seconds apart — so the
denial is attributable to the caller's tier and nothing else.

## 3. Finding 1 — the approval does NOT amplify privilege (correct, and worth keeping)

Run 2 used the **member** (`design@…`) as requester and a **company_admin** as approver. The loop
matched and re-drove, and then:

```
tool_error: tool failed: not authorized: cerbos denied create on pm_task
exec=failed   executed_by=<the member>   decided_by=<the company_admin>
```

The approver *could* have created that task; the write ran as the **requester** and Cerbos refused it.
That is the "approver = privilege amplification" hazard demonstrated as prevented, on the live policy
path — and the failure is recorded as a **typed** `tool_error` (the hub allowed the call; the tool
itself refused), not as a silent no-op. Nothing was written.

## 4. Finding 2 — `pm` was not in the test tenant's `enabled_modules` (fixture gap, not a defect)

Run 1 failed with `tool_error: … platform /api/<tenant>/pm/tasks 404`. The route exists
(`pm.controller.ts:793`) and the hub's path matches; the 404 is the **per-tenant module gate**:
`Gaia Digital Agency` in the test DB had `{agency,hr,reports,assistant}`.

This is exactly the `seed:agency` hardcoded-list trap the 2026-08-06 report already warns about, so it
was fixed the way that warning prescribes — **additively**, never by overwriting:

```sql
UPDATE companies SET enabled_modules = enabled_modules || '{pm}'
WHERE id = '019fd4ea-12c4-…' AND NOT ('pm' = ANY(enabled_modules));
-- => {agency,hr,reports,assistant,pm}   (all five originals preserved)
```

A 404 from a tool whose route demonstrably exists should send you to `enabled_modules` first.

## 5. Fixtures left behind (shared DB — read before your next run)

VER-01's convention was to leave fixtures in place and document them. Left in this DB:

- `companies.enabled_modules` for the agency now **includes `pm`** (additive; production has it enabled
  anyway).
- A verified `identity_links` row **`telegram / tg:hansel-agent` → `hansel@gaiada.com`**, added because
  the only pre-existing non-automation verified link belonged to a `member`, who Cerbos correctly
  refuses `pm_task:create`. This is the same class of fixture insert VER-01 made for `pipeline_runs`.
- Three `automation_approvals` rows (`origin='agent'`, `task-filer`): two `failed` (§3, §4) and one
  `executed` (§2), plus one `pm_tasks` row.

## 6. What this does and does not prove

**Proven:** the verified tier is mintable, gated on the caller and not on anything assertable; the
automation refusal holds; an agent's approved write executes as the original requester with a real row
to show for it; `executed_by ≠ decided_by`; and the whole thing runs through Cerbos, not the in-code
fallback.

**Not proven here:** none of this ran on `gda-aicenter`. `task-filer` itself
(`44d99fe`) post-dates the `alpha-01.022.0056a` tag, so the box does not yet have the AgentDef — this
run exercised the same tools and endpoints it will use, driven directly rather than by the runner's own
LLM turn. A server-side run needs a release containing `44d99fe` first.
