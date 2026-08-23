# The Pantheon airlock — connecting two AI estates without either being able to destroy the other

**Status: PLANNED.** Nothing below is built. Written 2026-08-22.

Companion to `2026-08-22-hermes-moe-personas-training.md` (§3 = the Pantheon contract) and
`2026-08-10-hermes-orchestration-architecture.md`. This document answers one question: **physically
and protocol-wise, how does Pantheon reach us safely?**

---

## 1. The requirement, restated — and the contradiction that has to be resolved first

The owner's constraints:

1. Pantheon must be able to act on our system, controlled by the boss through Discord.
2. Medium/high risk still needs boss approval in Discord.
3. Pantheon must not be able to go rogue and be destructive toward us.
4. **"Total isolation" to Pantheon** — no trace back, so a successful attack on our system cannot
   pivot into Pantheon.
5. Pantheon already manages delphi, helios, SEO, web builder, and reports to Discord.

**Constraints 1 and 4 are in direct tension, and pretending otherwise produces a design that
satisfies neither.** You cannot have total isolation *and* access. What you can have — and what this
design delivers — is isolation on the three dimensions that actually matter, with access reduced to
something too narrow to be dangerous:

| Dimension | Achievable? | How |
|---|---|---|
| **Network isolation** | **Yes, total.** Neither side holds a route to the other | Pantheon only ever dials *in*; we never dial out. Return messages go via Discord |
| **Credential isolation** | **Yes, total.** Neither side stores the other's keys | We hold no Pantheon credential, no hostname, no IP |
| **Blast-radius isolation** | **Yes** | A compromise of either side reaches a queue, not a system |
| **"No access at all"** | **No** — and it is not what you want | Replaced by a *narrow, signed, audited message contract* |

So the honest formulation of the goal is: **two estates that can pass messages but cannot reach each
other.** That is a solved problem, and §2 names how the industry solves it.

---

## 2. How this is actually done at scale (since the owner asked)

Six patterns do the work. This design uses all six; none of them are exotic.

**① Zero standing privilege (ZSP) / just-in-time access.** *(Microsoft PIM, Google's access model.)*
The single most important idea for "cannot go rogue". Nothing holds permanent power. Every
privileged action requires a grant that is **requested, approved, scoped, and expires** — minutes,
not forever. A compromised principal with zero standing privilege is worth very little, because
owning it grants nothing until someone approves something. **Pantheon must have zero standing
privilege on our estate.**

**② A broker with a narrow verb set, not a tunnel.** A VPN or an SSH route means "everything is
reachable, we just hope nothing goes wrong". A broker means "these 12 message types exist and
nothing else is expressible". You cannot exploit a path you cannot address.

**③ Asynchronous message passing instead of synchronous RPC.** Underrated and load-bearing. If
Pantheon calls our API directly, it holds a live connection into our runtime — protocol negotiation,
connection state, error oracles, timing. If Pantheon *writes a message to a queue* and something
else picks it up later, there is no connection to attack. **Queues are a security control, not just
an architecture preference.**

**④ Content-addressed, signed requests.** The request is an artifact with provenance — signature,
hash, replayable, non-repudiable. Your estate already does exactly this for container images
(cosign/SLSA in WS10). Same idea, applied to instructions instead of binaries.

**⑤ Separate identity planes.** No shared IdP realm, no shared secret store, no federated trust
between the two estates. Pantheon authenticating to us must not be the same fact as Pantheon
authenticating to anything of the boss's.

**⑥ Out-of-band approval / dual control.** *(AWS and Google both require this for destructive ops.)*
The approval must not travel the same path as the request. §5 is the whole story here.

**Two more from adjacent domains worth stealing:** *data diodes* (defence/intel — physically one-way
links) motivate §4's "we never dial out"; *cell-based architecture* (AWS) motivates keeping the
airlock small enough that its compromise is not interesting.

---

## 3. Your existing plan already has the right bones — and one dangerous gap

The owner asked me to check the unified-backend plan. It exists and it is **locked**
(`webdev-central-backend-program`, 2026-07-23; `docs/blueprints/webdev-design.md`), and it already
contains the trust model this problem needs:

> **Zone A** = ERP internal (platform-nest + company DB + AI, **not** internet-exposed).
> **Zone B** = website platform (internet-facing, multi-tenant).
> **Connection is one-way**: ERP→Zone B outbound control only (Keycloak client-credentials + mTLS);
> Zone B→ERP only via **signed, schema-validated webhooks** into the n8n event bridge.
> **No cross-zone DB grants.** Topology is 3 separate boxes. Worst-case Zone B breach exposes website
> and form data, **never company ERP data**.

`webdev-design.md` names the hazard exactly right: *"an internet-facing site platform must never
become a path into company data."*

**So the owner's instinct is correct: the unified backend is the right neighbourhood for the bridge.
But it must not be the bridge itself.** Two reasons, and the second is the serious one.

### 3.1 A broker's value comes from being small; Zone B is large

Zone B is Payload 3 + Next.js + NestJS services + BullMQ + Redis + Postgres + MinIO + Caddy — a
large, feature-rich, internet-facing application. It will have CVEs; everything that size does. If
the trust boundary between the two estates *is* Zone B, then **every Payload CVE becomes a
Pantheon-boundary breach.** The airlock should be a few hundred lines of stateless validation whose
entire job is to say yes or no to a message shape.

### 3.2 The unified backend is about to become far more valuable than Zone B was

The Zone A/B model tolerates a Zone B breach because Zone B holds *website and form data* only. The
owner's proposal changes that: buckets and DBs for **all projects — staging, WP, and production**.
That is the crown jewels of every client project in one place.

**Combining "holds all project data" with "is the entry point for an external AI estate" inverts the
goal.** Compromise the entry point, get everything. Keep them separate and a breach of the airlock
yields a message queue.

**Recommendation: the unified backend is a *consumer* behind the airlock, exactly like Zone A is —
not the airlock itself.**

### 3.3 The failure mode most likely to make all of this cosmetic

**Pantheon already administers delphi and helios.** If the unified backend (or the airlock) runs on a
box Pantheon administers, none of this design does anything — Pantheon reads the database directly
and the broker is decoration.

> **Hard requirement: the airlock and the unified backend must run on infrastructure Pantheon does
> not administer, with credentials Pantheon has never held.** Not the same box as delphi or helios,
> not managed by the same automation, not reachable by the same SSH keys.

This is **open question #1** in §9 and it is the one that decides whether the rest is real.

### 3.4 "The unified backend stays under ERP control" — what that settles, and what it does not

**Owner, 2026-08-22: the unified backend remains under ERP control.** That is the right answer and it
closes the worst version of §3.3 — the box is ours, Pantheon does not administer it, so the airlock in
front of it is not decoration.

Two things it does **not** settle, and both need holding onto:

**① "ERP controls Zone B" must never drift into "Zone B reaches Zone A".** The locked decision is
one-way: ERP→Zone B outbound control via Keycloak client-credentials + mTLS; Zone B→ERP **only** as
signed, schema-validated webhooks into the n8n event bridge; **no cross-zone DB grants**. Once the
unified backend also faces Pantheon, there will be pressure to let it query the ERP directly "because
it is ours anyway". **Ownership is not a trust boundary.** The wall exists because Zone B is
internet-facing, and that is still true no matter who administers it.

**② Pantheon may reach the unified backend's *data plane* without ever passing the airlock — through
the boxes it already administers.** This one is worth tracing carefully:

- The locked design has client sites reach Zone B with **scoped per-tenant API keys**.
- Those sites run on **helios** (production) and **delphi** (staging).
- Pantheon administers helios and delphi.
- ⇒ **Pantheon can read those tenant keys off the boxes**, and use them directly against the unified
  backend.

No airlock stops that, because it is not a bypass — it is the keys working exactly as designed, held
by whoever holds the box. Three consequences:

- **Blast radius is bounded, and that is the locked design doing its job:** a per-tenant key reaches
  that tenant's website and form data. Not other tenants, not the control plane, never Zone A.
- **The control plane must be a separate credential and a separate surface from the tenant data
  plane.** If a tenant key lifted from helios can reach provisioning, promotion, migrations, or
  storage administration, then owning any project box is owning the whole platform. **This is the
  single most important structural rule in this section.**
- **Per-tenant keys must be rotatable and individually revocable** (already locked), and rotation
  should be routine rather than incident-driven — because the threat model now includes "the box this
  key lives on is administered by someone outside our trust boundary".

**Net: "under ERP control" makes the airlock real, and makes control-plane/data-plane separation
non-optional.**


---

## 4. The airlock

```
   BOSS ESTATE                          THIRD PARTY                    OUR ESTATE
   ───────────                          ───────────                    ──────────

   Discord ──► Pantheon                   Discord                  ┌──────────────────┐
                 │                          ▲  │                   │   AIRLOCK        │
                 │  ① outbound only         │  │                   │  stateless       │
                 │     mTLS + signed        │  │ ④ approval        │  no project data │
                 │     request envelope     │  │    (our bot)      │  tiny verb set   │
                 └──────────────────────────┼──┼──────────────────►│                  │
                                            │  │                   └────────┬─────────┘
   ✗ NO route from our estate to Pantheon   │  │                            │ ② append-only
   ✗ NO Pantheon credential stored by us    │  ▼                            ▼   intent queue
   ✗ NO Pantheon hostname/IP known to us    │                       ┌──────────────────┐
                                            │                       │ risk classifier  │
              ③ our replies/notifications ──┘                       │ + Cerbos + D14   │
                 go out through Discord,                            └────────┬─────────┘
                 never a direct link                                         │
                                                            ┌────────────────┴───────────────┐
                                                            ▼                                ▼
                                                   Zone B unified backend            Zone A ERP
                                                   (projects: staging/WP/prod        (platform-nest,
                                                    DBs + buckets)                    Cerbos, RLS)
```

### 4.1 What the airlock is

- **Stateless.** Holds no project data, no business data, no long-lived secrets beyond its own
  verification keys. Losing it entirely costs you a redeploy.
- **A fixed, versioned verb set.** Pantheon can express perhaps a dozen message types
  (`request.action`, `report.completed`, `query.status`, …) and literally nothing else. Anything
  unparseable is dropped and alerted — never "best-effort interpreted".
- **Schema-bound, per WS7 §7** ("actions emitted only as a fixed schema, no free-form command
  execution"). No free text reaches an executor as an instruction.
- **The only thing Pantheon can address.** No other endpoint of ours is routable from outside.
- **Write-only into an append-only intent queue.** The airlock never executes anything itself. It
  validates and enqueues; our own workers pick up, classify risk, and run the normal gates.

### 4.2 The connection, and why it is one-way in the direction that matters

- **Pantheon dials in. We never dial out.** Our estate holds no address, no credential, and no route
  for Pantheon. An attacker who fully owns our estate finds nothing pointing back — which is exactly
  constraint #4.
- **mTLS with a client certificate we issue and can revoke**, short-lived and rotated. Revocation is
  a second kill switch that is independent of the registry flag.
- **Every request carries a detached signature** over a canonical body (action, params, nonce,
  timestamp), plus a monotonic sequence number so replay and gaps are both detectable.
- **Rate and spend caps on the Pantheon principal specifically** (`mcp-hub/src/ratelimit.ts` already
  exists). A rogue loop's damage is proportional to how fast it can call, and there is no human on
  the other side we can rely on to notice.

### 4.3 Zero standing privilege applies here too

Pantheon holds **no standing permission** on our estate. Its registry row grants the *ability to
submit requests*, not the ability to cause effects. Every effect above R0 is a JIT grant: requested,
approved, scoped to one action, bound to a content hash, and expiring. Between approvals, owning
Pantheon's credential buys an attacker the ability to fill a queue.

---

## 5. Discord as the air gap — and how to keep approvals honest

The boss wanting everything in Discord is not an obstacle. **It is the single best property of this
setup**, and it is worth understanding why.

**Discord is a third party neither estate hosts.** Using it as the return path means our estate needs
no route to Pantheon and Pantheon needs no route to us for replies. Neither side can be reached
*through* the message bus, because neither side operates it. This is a soft data diode, and it falls
out of the boss's existing habits for free.

### 5.1 The trap: approval must not travel through Pantheon

Per the companion doc §3.4 — if Pantheon can assert *"the boss approved this"*, a rogue or
prompt-injected Pantheon forges that assertion and every gate collapses. **Never accept an approval
claim from the party being gated.**

But the owner wants the approval in Discord. **Both are satisfiable, because "Discord" and
"Pantheon" are not the same channel.**

### 5.2 The design: two separate Discord applications

> **Pantheon's bot** is the boss's — we do not control it and never see it.
> **Our approval bot** is *ours*, installed in the boss's Discord. It is a distinct application, with
> its own token, its own endpoint, and its own signing key.

The flow:

1. Pantheon submits an R1/R2 action through the airlock.
2. Our workers classify the risk tier and suspend it into a normal D14 approval.
3. **Our bot** posts the approval card into a dedicated channel: what will happen, which seat will
   execute, what the blast radius is, and the **content hash**.
4. The boss clicks **Approve** in Discord.
5. Discord delivers a **signed interaction** to *our* endpoint. Discord signs every interaction with
   **Ed25519**, and verifying that signature is mandatory for any Discord app — so we can prove the
   click came from Discord, and the payload tells us which Discord user id clicked.
6. We map that Discord user id to the boss's **individual owner account** (an `identity_link`, the
   same pattern the estate already uses for OBO providers), and record the approval against it.
7. The approval is **bound to the content hash** from step 3. A different payload against the same
   approval id is rejected.

**Pantheon is not in that loop at any step.** The request came through Pantheon; the approval came
through Discord's own signed webhook to our own application. Two paths, two credentials, two
verifiable facts. A rogue Pantheon controls one of them.

### 5.3 The relay option (Pantheon carries the approval) — constructible, but do not build it

The owner proposed an alternative: gate Pantheon, have *it* ask the boss in Discord, and relay the
approval back — "like password validation" — so we never touch Discord at all. It is worth working
through properly, because the first half is sound and the reason it fails is subtle.

**The construction that makes a relay safe.** A courier can carry something it cannot forge. The rule
is that **the approval must be signed by a key Pantheon does not hold** — held by the boss, not by his
agent:

1. Pantheon submits the action. We compute a **challenge**: a nonce plus the content hash of the exact
   action and parameters.
2. We return the challenge. Pantheon relays it to the boss in Discord.
3. The boss produces a **response only he can produce** — a signature, or a code from an authenticator
   device holding a secret we shared with him and never with Pantheon.
4. Pantheon relays the response back. We verify it against the challenge we issued.

Pantheon is a **dumb courier** by construction: it carries a value it cannot compute. This is exactly
how TOTP, FIDO, and bank card-readers work over untrusted channels, so the instinct is a good one.

**The first flaw, and it is fixable: a plain code proves presence, not consent.** A TOTP-style code
proves *the boss was present at time T* — it says nothing about *which* action he meant. A rogue
Pantheon asks him to approve something harmless, collects the code, and submits it against a
destructive action instead. The fix is **content-bound signing**: he must sign the content hash, not
merely prove presence. Banks call this *"what you see is what you sign"*, and it is why transaction
signing devices display the amount and account before producing a code.

**The second flaw is the one that kills it: Pantheon controls what the boss sees.** Content-binding
proves he signed hash `a3f9`. It does **not** prove he knew `a3f9` meant *"drop the production
database"*, because the party being gated is the party that wrote the description next to it on the
screen. A compromised Pantheon renders "approve routine staging refresh" above a hash that means
something else entirely, and the boss signs it correctly, willingly, and disastrously.

**There is no fix that stays inside the relay.** The boss would have to verify the hash against a
description he received from *somewhere Pantheon does not control* — which is a second channel, which
is the thing the relay was trying to avoid. This is precisely why banks moved to a separate device
that displays the transaction independently of the computer requesting it.

**Verdict: cryptographically constructible, strategically worse.** It converges on needing our own
channel anyway, and arrives there with more cryptography, a worse experience for the boss, and one
remaining hole. §5.4 is the better answer, and it is also the simpler one.

### 5.4 The shared channel — the recommended design

The owner's second proposal, and the right one: **the boss creates one channel; our agents and his
agents both talk in it.** This is more native than a bespoke relay and strictly safer, because the
approval card the boss reads is rendered by **our** bot from **our** data.

To be precise about what we are asking him for — the phrasing matters, because "subscribe to the
boss's Discord" sounds far larger than what is needed:

> **It is a meeting room, not a wiretap.** We are not reading his server. He creates **one channel**
> and invites our bot into it. Our bot's scope is that channel and nothing else — no guild-wide read,
> no member list, no other channels, no DM history. Least privilege applies to Discord permissions
> exactly as it applies everywhere else in this estate.

The rules that make it safe:

- **Our bot renders the approval card from our own request record** — never from anything posted in
  the channel. This is the entire difference between §5.4 and §5.3: the description the boss reads
  comes from the system doing the gating, not from the system being gated.
- **Channel content is data, never instructions — in both directions.** Pantheon's messages are
  visible to our seats; per WS7 §7 they are input to classify, never a directive to follow. Our seats
  must be immune to a message in that channel telling them to do something.
- **Summaries and hashes only — never full payloads.** The channel carries "deploy `repo@sha` to
  helios · blast radius: 1 site · hash `a3f9`", not business data. This matters beyond tidiness:
  Discord is a third party, and this estate has explicit PII rules and a legal gate before real
  employee data moves anywhere. **Operational payloads must not transit Discord.**
- **Approval is still verified cryptographically**, exactly as §5.2 describes: Discord's Ed25519
  interaction signature proves the click came from Discord, the Discord user id maps to the boss's
  individual owner account via `identity_link`, and the approval binds to the content hash. The shared
  channel changes the *venue*, not the verification.
- **We still never touch Pantheon.** The owner's actual concern is preserved in full: no access to his
  agent, no credentials for it, no route to it. We simply have our own presence in a room he owns.

### 5.5 Why requests still go through the airlock, not the channel

Approvals belong in Discord — they are low-volume, human-readable, and the boss is already there.
**Machine requests should not follow them**, for four reasons:

- **Availability.** Discord becomes a hard operational dependency; their outage becomes our outage.
- **No mTLS, no client certificates.** The channel cannot carry the mutual authentication or the
  revocation lever §4.2 depends on.
- **Rate limits.** Discord's per-bot limits are far below what an automation path needs, and they are
  not ours to raise.
- **Confidentiality.** Action payloads would leave the estate to a third party — see the PII rule
  above.

**So: the airlock carries machine traffic; the channel carries human decisions.** Each does the thing
it is actually good at, and neither becomes a single point of failure for the other.

### 5.6 What this newly depends on, and how to harden it

Binding approval authority to a Discord account means **a Discord account compromise is now an
approval compromise.** That is a real, named cost of the convenience, and it should be mitigated
rather than ignored:

- **Discord 2FA mandatory** on the boss's account; server set to require it for the approval role.
- **A dedicated approval channel** that only the boss and our bot can post in, so a compromise of any
  other channel is not an approval surface.
- **Tier the second factor, not just the approval:**
  - **R1** — Discord button is sufficient.
  - **R2** — Discord button **plus** a TOTP code typed into the modal, or a confirmation in the ERP
    under his MFA session. One channel should not be able to authorise a hard-to-reverse action alone.
  - **R3** — **not approvable at all.** Escort mode: the agent produces the runbook and verifies each
    step; a human's hands are on the keys. No button exists to click.
- **Every approval is echoed** to a second surface (the ERP inbox, email) so a silent forged approval
  is visible after the fact even if it succeeded.

---

## 6. Pantheon's reports are claims, not facts

The owner wants Pantheon to inform us of what the boss had it do. Take that input — it is genuinely
useful for keeping our picture current — but record it truthfully:

**"Pantheon reports that it deployed X to helios" is a claim, not an event.** Store it as an attested
claim with its signature, never as a fact in the same table as things we observed. A compromised
Pantheon that can write believable history into our system is a serious problem in its own right: it
can hide its own actions.

**We can verify a good share of these independently, and the mechanism is already in flight.** MSO-03
(the multi-server observability onboarding runbook) puts our own collector on delphi and helios. Once
that lands, "Pantheon says it deployed" can be checked against *our own* telemetry from the box. Where
claim and observation disagree, that is a high-value security signal and should page `sec-guard`.

*(Caveat, stated rather than glossed: if Pantheon administers those boxes it could tamper with the
collector too. This is defence in depth, not proof. It still raises the cost of a silent lie
substantially, which is what defence in depth is for.)*

---

## 6A. Attribution — one model for humans, agents, and Pantheon

The owner's requirement: a Pantheon action approved by the boss records as **Pantheon + boss**; an R0
action records as **Pantheon alone**; and this must line up with how the estate already records a
human acting alone, an agent acting alone, or both. That alignment is right, and the estate is
closer to it than it looks — with one gap that matters.

### 6A.1 What already exists (verified, `PERMISSION-CONTRACT.md` §15.2)

Attribution shipped as the owner's **`Co-Authored-By` framing**: *author = the human, co-author = the
agent, recorded alongside and never instead.*

- `activities.actor_id` names the **human**.
- `metadata.via` names the **agent** (`agent:<def.name>`), stamped by `runAgent` from the agent's own
  definition — never from callers, who pass the human's envelope and would forget.
- `mcp-hub/src/obo-headers.ts` is the **one** place the outbound envelope is built (it replaced 14
  hand-built header objects, because the 15th always omits one).
- It is **authorization-neutral** — nothing in `can()`/Cerbos reads it, so adding a role needs no
  policy re-reasoning.
- It is **fail-silent by design**: outside a request scope, `via` is simply absent.

### 6A.2 The gap: two roles cannot express approval

"Pantheon + boss" is ambiguous between **two different security facts**, and collapsing them would be
a real defect:

| Relationship | Meaning | Effective permission |
|---|---|---|
| **Delegation** (`x-act-for`) | the agent acted **using the human's authority** | agent scope ∩ user's permissions |
| **Approval** (this design) | the agent acted **on its own authority**, and a human **authorised this specific action** | agent scope only; the approval unlocks the tier |

The Pantheon case is **approval, not delegation.** Recording it in the existing author/co-author shape
would read as *"the boss did it, co-authored by Pantheon"* — which is false. **The boss did not do it;
he permitted it.**

This is not pedantry. It decides what the record can answer during an incident. Ask *"what did the
boss actually do last month?"* and a delegation-shaped record returns 400 actions he merely clicked
approve on. Ask *"what did Pantheon do on its own authority?"* and you cannot separate the approved
ones from the unattended ones.

### 6A.3 The model: three roles, plus the executor

Extend the existing shape rather than replacing it — it is already additive and
authorization-neutral, which is exactly the property that lets a third role be added safely.

| Role | Question it answers | Today |
|---|---|---|
| **actor** | who or what performed it | `actor_id` |
| **via** (co-author) | which agent drove it, when a human is the actor | `metadata.via` — exists |
| **approved_by** | who authorised it, when the tier required approval | **new** |
| **executed_by** | which of *our* seats actually held the tool | **new**, needed by §4 |

Applied across every case the estate has, which is the consistency the owner is asking for:

| Scenario | actor | via | approved_by | executed_by |
|---|---|---|---|---|
| Alice clicks a button (attended) | Alice | — | — (R0/attended) | — |
| Alice's agent acts for her | Alice | `agent:dept-pm` | — | `dept-pm` |
| n8n runs an R0 flow unattended | the n8n principal | `wf:<name>` | — (R0) | — |
| An agent attempts an R1 write, Alice approves | the agent | `agent:dept-pm` | Alice | `dept-pm` |
| **Pantheon, R0** | `pantheon` | — | — (**R0, none required**) | our seat |
| **Pantheon, R1/R2** | `pantheon` | — | **the boss** (Discord, hash, interaction id) | our seat |

**The display stays exactly as the owner described it** — "Pantheon" or "Pantheon + Boss". The row
underneath carries the four facts so the summary can be *derived* rather than asserted.

### 6A.4 Three rules that keep the record honest

**① Absence must be explicit, never implied.** An R0 row must record *"tier R0 — no approval
required"*, not simply omit the approver. This estate has already been bitten by exactly this:
**a missing field reads identically to a null one**, so "no approval was needed" and "we failed to
record who approved" become indistinguishable in the one record you would consult during an incident.

**② Pantheon attribution fails CLOSED — a deliberate divergence.** The existing `via` stamping is
fail-silent, which is correct for internal work: a sweep or a consumer outside request scope should
still write its row. **For Pantheon it must be inverted — if we cannot attribute the action, we do not
execute it.** An unattributable action from an unauditable external estate is not a logging gap; it is
a security event. Same reasoning as `approval-grant.ts` rejecting an unverifiable grant rather than
skipping the check.

**③ The approval record must be independently verifiable later.** Not "the boss approved", but *the
content hash, the Discord interaction id, the timestamp, and the tier at decision time*. Otherwise a
year from now the record asserts a fact nobody can re-check — and per WS7 §2.3 this chain lands in
append-only WORM storage that neither Pantheon nor the boss's account can reach.

### 6A.6 A Discord approval is the same authority, not the same assurance — so tag it

The question: does the boss approving in Discord mean the same as approving in the ERP, or should it
carry a channel tag?

**Tag it — always — and the tag is not cosmetic: it decides what that approval is allowed to unlock.**

Separate three things that "the boss approved it" runs together:

| | Discord | ERP |
|---|---|---|
| **Who** — the authority | the boss's individual owner account | **identical** |
| **How strong** — the proof it was really him | Discord account + their 2FA; a third-party identity we neither operate nor can revoke; no binding to our session version | our IdP, MFA, revocable, session-version bound |
| **Where** — the channel | `discord` | `erp` |

Same authority. **Different assurance.** Recording them as equivalent would record something false.

**This is not a new mechanism — it is `assurance` doing exactly its job.** `mcp-hub/src/principal.ts`
already ranks `anonymous` → `low` → `verified`, and its founding rule is that **"chat-surface envelopes
can only ever mint LOW assurance"**. Discord is a chat surface. So a Discord approval mints `low` by
construction, in the same class as WhatsApp — no special case needed.

`elevateAssurance` is the one designed path out of `low`, and it needs **both** conjuncts:
`callerEntitled` (the presenting caller holds the elevated token) **and** `vouched` (the platform's own
proof of the identity). Neither alone suffices — *"the caller's token is authority to elevate, never a
substitute for the platform's proof."*

**So the tier ladder falls out of existing machinery instead of a bespoke rule:**

| Tier | Assurance required | What that means in practice |
|---|---|---|
| **R1** | `low` | the Discord button alone is enough |
| **R2** | `verified` | Discord alone **cannot** reach it — needs elevation (both conjuncts) or a confirm in the ERP under his MFA session |
| **R3** | — | no approval path exists at all; escort mode only |

That is exactly the tiered second factor of §5.6, now expressed in the estate's own vocabulary rather
than as a rule someone has to remember. **And it is the same blocker the 08-10 doc already tracks:**
D14's `approvals.resolveExecute` requires `verified` while envelope-derived principals mint `low`, so
the assurance-elevation work is a **shared dependency**, not extra scope for this design.

**Pantheon's own principal joins the never-elevate class.** `assurance.test.ts` pins that an n8n
principal is *never* elevated even when entitled and vouched (the §A13 line — the control keeping
automation away from money-spending tools). **Pantheon belongs in that same class for the same
reason.** Keep the two principals strictly apart: *Pantheon requesting* can never be elevated; *the
boss approving* can, through the designed path.

**Three practical reasons the channel tag earns its place, beyond correctness:**

- **Revocation scope.** If his Discord is ever compromised, *"which approvals arrived via Discord in
  the last 30 days?"* must be answerable in one query. Without the tag you cannot scope what to
  re-verify, and the honest answer becomes "all of them".
- **It must be explicit, never inferred.** Same rule as §6A.4 ① — a channel you deduce from the
  presence of an interaction id is a channel you will deduce wrongly once.
- **One approval concept, extra fields — not a parallel "Discord approval" record.** This estate has
  already paid for mirrors that drift (the permission mirrors, the role bundles). The Discord path
  writes the *same* approval row with `channel` and `assurance` populated.

### 6A.5 One clarification on "let Pantheon do its work"

Worth stating precisely, because the difference is load-bearing:

> **After approval, we do not hand Pantheon the capability — our seat executes the approved request.**

If Pantheon held the tool, it would need standing privilege on our estate, and §4.3's zero-standing-
privilege property (the thing that makes owning Pantheon's credential nearly worthless) would be gone.
Pantheon proposes; our seat executes; the audit names both. That is why `executed_by` exists in §6A.3.

**Scope boundary, so it is unambiguous:** this applies to actions **on our estate**. Actions Pantheon
takes on its own infrastructure (delphi, helios, SEO, the web builder) are outside our gate entirely —
we do not approve them and cannot. What arrives from those is a **report**, and §6 already rules that a
report is a claim, not an event.

---

## 7. What each compromise actually costs

The test of an isolation design is what happens when it fails. Walking the cases:

| Scenario | Reach | Why it stops there |
|---|---|---|
| **Pantheon fully compromised** | Can fill our intent queue with requests. Can execute **R0 only**. Everything above needs a Discord approval it cannot produce | Zero standing privilege; approval travels a path it does not control |
| **Pantheon + the boss's Discord account** | Can execute R1. R2 needs the second factor; R3 has no button | Tiered second factor (§5.3) |
| **The airlock compromised** | An attacker gets a queue writer and a validation service. No project data, no ERP data, no credentials worth stealing | Stateless, no data, narrow verb set |
| **Zone B (unified backend) compromised** | Project data for staging/WP/prod — serious, but **no path to Zone A** and no path to Pantheon | Existing locked one-way rule; no cross-zone DB grants |
| **Our whole estate compromised** | **No pivot into Pantheon.** No route, no credential, no hostname exists on our side | We never dial out; replies go via Discord |
| **Discord compromised** | An attacker can approve R1 and see approval cards | R2 second factor; R3 unapprovable; audit echoed to a second surface |

**The property worth noticing: no single compromise reaches both estates.** That is the actual
meaning of the owner's "no trace back", made concrete.

---

## 8. Build order

| Step | What | Depends on |
|---|---|---|
| **A0** | **Answer §9 Q1** — who administers the airlock/unified-backend box. Everything else is theatre if the answer is "Pantheon" | — |
| **A1** | The message contract: the ~12 verbs, the signed envelope, canonical body, nonce + sequence, content-hash rule. Freeze it as a doc first, like every other contract in this estate | A0 |
| **A2** | The airlock service: mTLS termination, signature verification, schema validation, rate limits, append-only intent queue. Small and boring on purpose | A1 |
| **A3** | Risk classification + D14 wiring on the consumer side (the ladder from the companion doc §4) | A2, risk ladder |
| **A4** | **Our** Discord application, scoped to the ONE shared channel the boss creates: approval cards rendered from our own records, Ed25519 interaction verification, `identity_link` to his owner account, content-hash binding, tiered second factor | A3 |
| **A5** | Tamper-evident audit (WS7 §2.3, WORM, off-box) + the claims store for Pantheon reports | A2 |
| **A5b** | Attribution schema (§6A): add `approved_by` + `executed_by` alongside the existing `actor_id`/`metadata.via`; explicit-absence rule; fail-closed attribution on the Pantheon path | A3 |
| **A6** | Independent verification: MSO-03 collectors on delphi/helios; claim-vs-observation reconciliation into `sec-guard` | A5, MSO-03 |
| **A7** | Kill switches — registry flag **and** client-certificate revocation, two independent mechanisms, both operable by us | A2 |
| **A8** | Enable R0 only. Live for a period with everything above R0 rejected, to prove the shape before granting reach | A4, A7 |
| **A9** | Open R1, then R2. R3 never opens — escort mode only | A8 |

The unified backend proceeds on its own existing plan and timeline. **It is a consumer behind the
airlock, not a dependency of it** — which also means neither project blocks the other.

---

## 9. Open questions

1. ~~Who administers the airlock/unified-backend box?~~ **ANSWERED 2026-08-22: it stays under ERP
   control.** Remaining sub-question: is the airlock on the *same* box as the unified backend, or its
   own? Recommend its own — §3.1's CVE-surface argument is about size, not ownership.
2. **Does Pantheon hold root on delphi and helios today?** Now doubly load-bearing: it changes what
   our observability there can be trusted to prove (§6) **and** whether Pantheon can lift per-tenant
   keys off those boxes (§3.4 ②). If yes, control-plane/data-plane separation on the unified backend
   moves from good practice to a hard requirement.
3. **Will the boss accept a second factor for R2** (TOTP in the Discord modal, or one confirmation in
   the ERP)? This is the only place the design asks him for friction, and it is the difference
   between "a Discord compromise costs you R1" and "a Discord compromise costs you production".
4. **Is the unified backend one platform DB per project, or shared?** Recommendation unchanged: never
   share a Postgres across businesses to make agents work — isolation rests on RLS + per-service roles
   + `company_scope`, and RLS has already bitten this estate (unset GUC ⇒ zero rows, no error).
5. **Does Pantheon need to read from us at all, or only write?** Read access is a much larger design
   (it is an exfiltration surface, and per-tenant scoping applies). If the answer is "status only",
   say so now and keep the verb set tiny.
6. **Will the boss create the shared channel and invite our bot at channel scope only** (§5.4)? If
   he prefers a guild-wide install, push back — least privilege applies to Discord permissions too.
7. **Break-glass** (WS7 §9, still open): the boss will eventually want an emergency override. Design it
   time-boxed, alerting-on-use, bound to his individual account — never a standing flag on the
   Pantheon principal.
