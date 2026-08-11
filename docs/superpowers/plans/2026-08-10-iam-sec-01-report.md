# IAM-SEC-01 — `notLow` assurance floor on `agent_run:read` — report

**Status: PROTOTYPED.** Policy edit + test extension made, verified locally against a restarted
`gaiada-test-cerbos`. Not deployed; not reviewed by anyone but this session.

## 1. Independent verdict: OVERSIGHT, not deliberate — proceeded with the change

Re-derived the gap from source rather than trusting the ticket's framing, per instruction.

**Evidence for oversight:**

- Of the platform's 61 Cerbos resource kinds, **58 carry `variables.notLow`**. Only three don't:
  `agent_run`, `mcp_tool`, `rollup`.
- The other two exceptions are both **documented, deliberate substitutions**, not omissions:
  - `resource_rollup.yaml` grants `read` only to `derivedRoles: ["platform_admin",
    "group_executive"]` — a role-only gate to the two roles that never carry `low` in practice.
    Its own file is one line; the substitution needs no comment because the role list alone does
    the job the ceiling would.
  - `resource_mcp_tool.yaml` has its **own, more precise** per-tool assurance-rank check baked
    into the `all.of` (`assurance == "verified" || (assurance == "low" && tool.minAssurance !=
    "verified") || ...`) — a finer-grained mechanism than the binary `notLow`, and the file's
    ~90-line header (cross-referenced by IAM-01b-2's independent finding, already landed this
    session-set) explains at length why this kind has no role axis at all and needed its own
    scheme.
- `resource_agent_run.yaml` has **neither** an alternative mechanism **nor any discussion of
  assurance anywhere in its header.** The header is unusually long and detailed — it analyzes
  `isElevated`, `owns`, and `origin` exhaustively, including a hypothetical future kind of
  owner-attributed run that must NOT be covered — but assurance is never mentioned once, positively
  or negatively. A file that goes out of its way to rule out a hypothetical future edge case but
  says nothing about a present, load-bearing variable used in 58 sibling files is the signature of
  something nobody thought to add, not something considered and rejected.
- The strongest positive evidence: the header's own safety argument for the additive rule
  ("the transcript is ... output fetched under the READER's OWN authority, not someone else's")
  is **word-for-word the same sensitivity class** as `resource_assistant_thread.yaml`'s owner-only
  transcript rule, which explicitly carries `notLow` for exactly that reason (D4: "low-assurance
  chat sessions get NO company data"). A handoff run's transcript and its parent thread's
  transcript are the same kind of tenant data read by the same owner — there is no principled
  reason for one to have the ceiling and the other not.
- Checked whether IAM-01b-2 (this session-set's own prior finding on `agent_run`) already covers
  this and makes the ticket redundant: it doesn't. IAM-01b-2 examined a different question —
  whether `agent_run:read`'s absence from the superadmin/`platform_admin` 215-permission catalog
  was deliberate (yes: the real gate is `isElevated()` in code, so Cerbos-side superadmin coverage
  would be inert). It never examined this rule's assurance floor at all.

**Verdict: proceed.** Changed the file per the ticket.

## 2. What changed

**File:** `platform-nest/cerbos/policies/resource_agent_run.yaml`

The `read` rule's condition gained `variables.notLow`, ordered to match the sibling
(`resource_assistant_thread.yaml`: `inTenant && notLow && owns`):

```yaml
condition:
  match:
    expr: >-
      variables.inTenant && variables.notLow && variables.owns &&
      request.resource.attr.origin == "assistant_handoff"
```

(was `variables.inTenant && variables.owns && ...` — no `notLow`.)

Added two header sections:
1. An "IAM-SEC-01" block explaining what changed, why (the cross-check against the other two
   `notLow`-less kinds and their documented substitutions, the sensitivity-parity argument with
   `resource_assistant_thread.yaml`), and that this is an **owner-sighted narrowing**, not a
   silent policy drift-fix.
2. A 4th bullet in the existing "CRITICAL ENVIRONMENT TRAP" list, noting this is an edit to an
   existing (not brand-new) file, so it should hot-reload per ASST-23's precedent — but restart
   anyway before trusting results, because the one failure mode that matters for a *narrowing*
   change is a stale policy silently keeping the OLD, wider rule in memory (silently ALLOWING
   what should now DENY), which is the opposite of the usual "everything looks like an unlisted
   silent DENY" trap this file already documented.

**Test file:** `platform-nest/src/rbac/cerbos-agent-run.test.ts` (extended, not new)

Added a `describe("IAM-SEC-01: notLow assurance floor ...")` block with 4 cases:
- low-assurance owner, correct origin → **DENY** (the narrowing).
- linked-assurance owner → **ALLOW** (floor excludes only `low`, doesn't raise the bar to `high`).
- high-assurance owner → **ALLOW** (unchanged control case).
- low-assurance non-owner, and low-assurance owner with wrong origin → both **DENY** (proves the
  new conjunct is additive-restrictive on top of the existing `owns`/`origin` checks, not a
  replacement of them — i.e., it can't accidentally become a new way IN).

Extended `principal()` to take an optional `assurance` parameter (default `"high"`, matching the
existing tests' implicit assumption) rather than hardcoding it, mirroring
`cerbos-assistant.test.ts`'s helper shape exactly.

## 3. Cerbos restart — done before trusting any result

Per the file's own environment-trap doc and the ticket's explicit instruction:

```
docker restart gaiada-test-cerbos
# polled docker inspect --format='{{.State.Health.Status}}' until "healthy" (3 polls, ~4s)
```

Confirmed the container the test harness actually reaches (`gaiada-test-cerbos`, publishing
`:3592` — not the app's own `gaiada-cerbos-1`, which was left untouched). All test runs below ran
strictly after this restart completed and reported `healthy`.

## 4. Test results (real output)

```
CERBOS_URL=http://localhost:3592 npx vitest run src/rbac/cerbos-agent-run.test.ts
```
→ **12/12 passed** (the 8 pre-existing ASST-21 cases unchanged/green — proving no regression on
the additive owner/origin/tenant/elevated-bypass logic — plus the 4 new IAM-SEC-01 cases).

Also ran alongside the sibling suite for cross-file sanity (both talk to the same restarted
container, same shared `_variables.yaml`):

```
CERBOS_URL=http://localhost:3592 npx vitest run src/rbac/cerbos-assistant.test.ts src/rbac/cerbos-agent-run.test.ts
```
→ **26/26 passed** (14 assistant_thread/assistant_memory + 12 agent_run), including
`cerbos-assistant.test.ts`'s own pre-existing "low assurance is DENIED even for the owner"
case for the sibling kind — confirming both files agree on the shared floor now.

Did not run the full platform-nest suite (out of scope per the file-ownership constraint, and
other sessions are concurrently touching this checkout — a full run would pick up unrelated
in-flight changes and produce a report that isn't attributable to this ticket).

## 5. Blast radius

**Verdict: zero live behavior change today.** This is a defense-in-depth close of a currently
*unreachable* gap, not a fix that stops any real request in the field. Traced every code path
that can reach this Cerbos rule:

1. **The real consumption path — `platform-ui`'s roster/run-watch panel
   (`RosterPanel.tsx`) via `GET /api/:t/agents/runs/:runId`.** This is an in-app browser session
   authenticated through `AuthGuard`'s OIDC branch (`principalFromToken` → `assuranceFor()`,
   `platform-nest/src/auth/oidc.ts:95`), which returns **only `"high"` or `"linked"` — never
   `"low"`** — or through the dev `x-user-id` path (`platform-nest/src/auth/guards.ts:70`), which
   is hardcoded `assemblePrincipal(userId, "high")`. Neither can produce a low-assurance principal.
   **No real user watching a run they triggered from the assistant UI is, or ever was, affected.**

2. **The OBO-envelope branch of `AuthGuard` itself** (`guards.ts:76-96`, for a service calling
   platform-nest's own `/api/:t/*` routes on behalf of an external chat identity): an
   **unverified or unknown** external identity collapses to the full `ANONYMOUS` constant
   (`userId: null`), not a `"low"` principal carrying the real user's id. Since `variables.owns`
   requires `principal.id == resource.attr.ownerId` and `ANONYMOUS`'s id resolves to the literal
   string `"anonymous"` in `cerbos.ts`'s `principalPayload`, this branch could **never** satisfy
   `owns` for any real run, with or without this ticket's change. Grepped `wa-chat-bot/` and
   `mcp-hub/` for any reference to `agent_run` — **zero hits in both** — confirming neither service
   calls this endpoint via OBO today.

3. **The one place a real `userId` + `assurance: "low"` principal shape is actually minted:**
   `IdentityController.resolve` (`POST /principal/resolve`,
   `platform-nest/src/identity/identity.controller.ts:27`) — `return { ...ANONYMOUS, userId:
   row.user_id }` for a known user whose external (WhatsApp/Telegram) link row exists but is
   **not yet verified** (dual-proof enrollment started, not completed). This is the shape that
   matches the ticket's own framing ("bot/WhatsApp/Telegram-originated principals"). **But** that
   same object inherits `ANONYMOUS.companies = []` — it is never enriched with the user's real
   tenant memberships, because the enrichment branch (`assemblePrincipal(row.user_id, "linked")`)
   only runs when `verified_at` IS set. So `variables.inTenant` (`resource.tenantId in
   principal.companies`) was **already false** for this shape, independent of assurance — this
   path was a hard DENY before this ticket, for an unrelated, pre-existing reason. Grepped for
   consumers of `/principal/resolve` in `mcp-hub` and `wa-chat-bot`: none currently perform their
   own `agent_run` Cerbos check against a principal obtained this way (neither service references
   `agent_run` at all, confirmed above).

4. **n8n/automation principals** are minted `assurance: "low"` by construction platform-wide
   (documented in multiple places: `main.ts:81`, `search/pull-scheduler.ts:11`,
   `knowledge/ingest/scheduler.ts:6`) — but they structurally **cannot own** a handoff run at all:
   a handoff can only be created via the assistant thread's `handoff` action, which is itself
   `user`-role + `owns` + **`notLow`**-gated at the thread layer
   (`resource_assistant_thread.yaml`). An automation principal can never pass that gate to create
   one in the first place, so it can never later be denied reading one either — this axis was
   never reachable and remains never reachable.

**Net:** every currently-reachable path to this rule already carries sufficient assurance (path
1), or was already denied by `inTenant`/`owns` for an independent, pre-existing reason (paths 2–4).
**Nothing that works today breaks.** The value of this change is prophylactic, not corrective: it
closes the inconsistency *before* it becomes live-reachable — e.g., if a future ticket fixes the
`companies: []` gap on the unverified-link principal shape (path 3) to make partially-enrolled
users functional for other purposes, or if the bot/hub ever grows a feature that performs its own
`agent_run` Cerbos check using a `/principal/resolve` result instead of only gating locally. Flag
for whoever picks up such a ticket: re-run this suite once that companies-enrichment gap closes,
because that is the day this floor starts actually doing work.

## 6. Files touched

- `platform-nest/cerbos/policies/resource_agent_run.yaml` — added `variables.notLow` to the
  `read` rule condition; added the IAM-SEC-01 header section and env-trap bullet #4.
- `platform-nest/src/rbac/cerbos-agent-run.test.ts` — extended: header note, `principal()` gained
  an `assurance` param, new `describe("IAM-SEC-01: notLow assurance floor ...")` block (4 cases).
- `docs/superpowers/plans/2026-08-10-iam-sec-01-report.md` — this report (new).

No other file was touched. No migration, no other policy, `rbac.ts` untouched, nothing deployed.

## 7. Blockers / follow-ups

None blocking. Suggested (not performed, out of this ticket's file-ownership scope):
- IAM-01b-2's already-landed writeup should get a one-line cross-reference to this ticket so a
  future reader doesn't wonder whether the two overlap (they don't — different questions).
- Whoever eventually revisits the `companies: []` limitation on unverified-but-known identity
  links (§5, path 3) should re-run `cerbos-agent-run.test.ts` at that point — that's the change
  that would make this floor's denial start mattering for a real (if narrow) population.
