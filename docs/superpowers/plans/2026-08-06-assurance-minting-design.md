# Assurance minting — design + implementation (2026-08-06)

Closes the blocker recorded as §2.1 of `2026-08-06-session-blocked-unblocked.md`: `mcp-hub/src/principal.ts`
mints **every** envelope-derived principal at `assurance: "low"` and nothing mints `"verified"`, while
`approvals.resolveExecute` is registered `minAssurance: "verified"`. One gap blocks four things
(PM Phase-4 `J2` write half, `ASST-23`, `D14-17`, and Hermes' own MCP authority).

Chosen option: **(1) build a verified-assurance minting path** — the option the report recommends.
Option 2 (lower `resolveExecute` to `"low"`) is refused for the reason already recorded: it puts a
high-impact write behind the weakest gate.

---

## 1. What `verified` is allowed to mean

Three vocabularies overlap here and the words do not mean the same thing (already documented at
`platform-nest/src/modules/reports/index.ts:20`):

| Layer | Type | Values |
|---|---|---|
| mcp-hub | `mcp-hub/src/principal.ts` | `anonymous` \| `low` \| `verified` |
| platform | `platform-nest/src/rbac/principal.ts` | `low` \| `linked` \| `high` |
| module tool defs | `McpToolDef.minAssurance` | `low` \| `verified` |

`principal.ts`'s own header states two rules that this design treats as **binding, not as
limitations-for-now**:

> - *"chat-surface envelopes can only ever mint LOW assurance"*
> - *"`verified` principals will come from the platform IdP (WS1) — **never from an envelope**"*

Read together they settle the central question. It is **not** sufficient for an envelope to name an
identity whose `identity_links` row is verified — if it were, a WhatsApp chat session would mint
`verified` and the first rule would be false. The distinguishing fact is **which service is calling**,
not which identity it names. So:

> **Hub `verified` = a service entitled to elevate is calling, AND the platform independently vouches
> that the named identity is a real, active, non-revoked user reached through a dual-proof-verified
> link.**

Identity comes from the envelope. **Authority to call that identity `verified` comes from the caller.**

### Why this is a real second proof, not a rubber stamp
The platform's `linked` tier is not self-asserted: D4.4 dual-proof enrollment
(`identity/enroll/start` → `confirm`) requires an **MFA'd `high` platform session** to mint the code
*and* possession of the chat identity to redeem it. So `verified_at IS NOT NULL` carries MFA-rooted
provenance, and `assemblePrincipal` returning non-null additionally proves the user is `active` and
not soft-deleted.

---

## 2. The rule — three conjuncts, every one fail-closed

A principal is elevated `low → verified` if and **only if** all three hold:

| # | Conjunct | Where enforced | Fails to |
|---|---|---|---|
| 1 | **Caller entitlement** — the request authenticated with `HUB_ASSURANCE_TOKEN`, a service token distinct from `HUB_SERVICE_TOKEN` | `server.ts` `/mcp` auth | `low` (unset ⇒ nobody ever elevates = today's behaviour byte-for-byte) |
| 2 | **Not automation** — `!isAutomation(provider)` | `principal.ts` `elevateAssurance` | `low`, unconditionally, even *with* the elevated token |
| 3 | **Platform proof** — `POST /principal/resolve` returns a non-`revoked` principal with a `userId` and platform assurance `linked` or `high` | `revocation.ts` `resolvePlatformIdentity` | `low` (unreachable / non-OK / unverified link / unknown identity / revoked) |

Nothing a **client** controls appears in that list. Conjunct 1 is a secret, not a header value a caller
may pick; conjunct 3 is the platform's answer, not the caller's claim. This preserves the property the
file was built around — *"there is no field a client could set to claim a role"*.

### Conjunct 2 is not belt-and-braces — it is a binding ruling
The architect ruling at `seo-sem-design-addendum-providers.md` §A13 (2026-07-30, binding) makes the
assurance gate **the** control that keeps n8n away from money-spending `search.*` tools, on the basis
that *"every n8n principal is minted `assurance:'low'` by construction"*. Two independent controls hold
that line today: no allow-list entry (SM-55) **and** low assurance. An elevated n8n principal would
delete the second one. So automation providers are refused in code, with a regression test, and the
elevated token is never given to n8n.

### Which callers get the elevated token
| Service | Token | Ceiling |
|---|---|---|
| `platform` (platform-nest) | `HUB_ASSURANCE_TOKEN` | `verified` — it is the IdP; it authenticated the session that filed the row |
| `agent-runner` (ai-agents) | `HUB_ASSURANCE_TOKEN` | `verified` — carries the triggering human's envelope |
| `bot` (wa-chat-bot) | `HUB_SERVICE_TOKEN` | `low` — chat surface, per rule 1 |
| `knowledge` | `HUB_SERVICE_TOKEN` | `low` |
| n8n | `HUB_SERVICE_TOKEN` | `low` — and conjunct 2 on top |

`HUB_ASSURANCE_TOKEN` is *also* accepted as ordinary service auth, so an elevated caller needs one
token, not two.

---

## 3. Why the D14 agent-write path now completes

`approval-execute.ts`'s `resolveRedrivePrincipal` **already** does the right thing and needs no change:

- `origin='agent'` → it selects the requester's own link `WHERE verified_at IS NOT NULL`, so the
  envelope it hands the hub satisfies conjunct 3 by construction, and platform-nest holds the elevated
  token (conjunct 1). → `verified` → `approvals.resolveExecute` passes its `minAssurance` floor.
- `origin='automation'` → `{provider:"n8n"}`, refused by conjunct 2 → stays `low`. Correct, and it needs
  nothing: the automation re-drive calls the **original** tool server-side, never `resolveExecute`.

The layered authorization the D14-14 registration describes is untouched. This change adds a floor the
caller can now reach; it relaxes none of the checks stacked above it — Cerbos still decides, and the
platform endpoint's own `requested_by == principal.id` binding still means only the original requester
may resolve their own suspended call, never the approver.

## 4. Cerbos needs no policy change
`resource_mcp_tool.yaml`'s assurance conjunct is already written in terms of the *value*
(`request.principal.attr.assurance == "verified" || …`) and the hub already ships `assurance` as a
principal attribute (`mcp-hub/src/cerbos.ts`). A `verified` principal satisfies the first disjunct.

This is deliberate and worth stating, because a policy edit would have needed a Cerbos **restart** to
take effect (no policy change hot-reloads — memory `cerbos-new-policy-needs-restart`), and an
unlisted/unreloaded rule reads exactly like a logic bug.

## 5. Elevation is monotone — nothing loses access
Every assurance check in the hub is either a rank comparison (`policy.ts` `RANK`) or `!== "anonymous"`
(`resources.ts`, `prompts.ts`). There is no check of the form `assurance === "low"` that a higher tier
would *fail*, so elevating a principal can only ever widen, never narrow. Two consequences that were
verified rather than assumed:

- `checkin.submit` keeps working. It ships `minAssurance:"low"` deliberately (reports/index.ts) so the
  WA loop can reach it; `verified ≥ low`, so nothing breaks — and bot principals are not elevated anyway.
- The platform's `notLow` variable gates on the **platform's** assurance, not the hub's, so it is
  untouched by any of this.

## 6. What this deliberately does NOT do
- **Chat surfaces stay `low` forever.** So `rollup.metrics`, `reports.getCompliance` and `pm.runTracker`
  remain unreachable from WhatsApp/Telegram — the "conservative, correct default" those three sites
  describe stays in force rather than being silently lifted. A verified *human* tier for chat, if ever
  wanted, is a separate decision about surface trust (a hijacked WhatsApp account vs. an SSO+MFA
  session), not a consequence of this ticket.
- **No fourth tier.** Platform `high` and `linked` both map to hub `verified`. Adding a tier would ripple
  into the Cerbos policy and every `minAssurance` declaration in every module contract for no gain today.
- **mTLS peer CN is not used as the entitlement.** It would be the more elegant carrier
  (`config.tlsPeerAllowlist` already exists) but `HUB_TLS_MODE` is `off` in compose, so gating on it
  would ship the feature silently disabled — the exact failure class in memory
  `compose-env-passthrough-trap`. Recorded as target-state hardening.

## 7. One round-trip, one cache
`revocation.ts` already called `POST /principal/resolve` per principal per TTL window and threw away
everything except `revoked`. It now keeps the whole answer and serves both concerns from **one** cached
entry. Two reasons this matters beyond load: two caches could disagree within a window (revoked-false
from one window, verified from another), and the two concerns have **opposite** failure directions —

- revocation fails **open** (the platform being down is a separate degraded state), and
- elevation fails **closed** (an unproven identity is never `verified`),

so the cached value must distinguish *"the platform said no"* from *"the platform never answered"*. It is
modelled as an explicit `{status:"unavailable"} | {status:"resolved", …}` union, and `unavailable` is
never cached.
