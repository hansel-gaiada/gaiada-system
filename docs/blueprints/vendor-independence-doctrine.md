# Vendor Independence — the doctrine, the estate audit, and the exit ladder

> **Status:** `PROPOSED` — doctrine and audit. No code changed by this document.
> **Date:** 2026-09-21 · **Owner conversation:** web@gaiada.com
> **Scope:** the whole estate, not one component. Promotes
> [`webdesk-independence.md`](./webdesk-independence.md) §4.3 (WSK-D40) from a WebDesk rule to an
> estate rule.
> **Reads with:** [`github-integration-foundation.md`](./github-integration-foundation.md) ·
> [`smm-foundation.md`](./smm-foundation.md) (the estate's first and best licence analysis) ·
> [`../assessment/2026-09-17-market-benchmark.md`](../assessment/2026-09-17-market-benchmark.md)
>
> **📌 OWNER RULING 2026-09-21: no per-seat pricing, no enterprise tier, anywhere in the estate.
> Vendor lock is to be minimised.**

---

## §0 · What the ruling can mean, and what it cannot

The first half is achievable and nearly already true: **no per-seat pricing, no enterprise tier.**
Taken literally, estate-wide, it costs less than you would think — §2 finds **exactly three**
per-seat or tier-gated dependencies inside the system, and two of them are already half-solved.

The second half needs an honest definition. **"Vendor lock free" as a binary is not achievable
and chasing it is how estates get worse, not better.** Everything has a vendor: the kernel, the
registrar, the VPS, the CPU. What *is* achievable, measurable and worth ruling on is:

> **Bounded exit cost.** For every dependency, we know what leaving costs, we have named the
> replacement, and the number is small enough that the vendor cannot extract from us.

A dependency you could leave in a week is not lock, whatever its licence. A dependency you could
never leave is lock, even if it is free and MIT. That reframing is what §1 makes operational.

### The doctrine is not new — it is latent in three decisions you already made

This document mostly names something the estate has been doing right by instinct:

1. **The AI gateway is provider-pluggable** — `ai-gateway-go/internal/providers/` ships claude ·
   gemini · openai · ollama · hermes · whisper behind one interface. **Model-vendor exit cost is
   already near zero**, which is the single most valuable lock to have pre-broken in 2026.
2. **The agentic-native bar** (CLAUDE.md, OPEN): *"every department capability must work
   identically under a human, under n8n, and under an agent."* That rule was *intended* to mean
   nothing may depend on n8n exclusively — bounding the n8n exit cost as an architectural
   invariant, before anyone noticed n8n's licence. **⚠️ Audited 2026-09-21: the bar holds for 17
   of 21 workflows and has silently slipped for the 4 newest (§3.2).** A rule is only an invariant
   while it is enforced; this one is the cautionary example among the three, not a third success.
3. **OpenBao, not Vault.** `openbao/openbao` is the MPL-2.0 fork taken after HashiCorp relicensed
   Vault to BUSL. That exit was already made, correctly, without a doctrine to point at.

The rules in §5 generalise those three instincts. They do not introduce a new posture.

---

## §1 · The two tests

Two independent axes, routinely confused. A dependency can fail either, both, or neither.

### The Seat Test — *does it price per human?*

> **Does adding one more person — a staff member, a client contact, an agent — increase the bill?**

Per-seat pricing taxes growth in the one dimension a growing agency grows. Per-resource pricing
(per GB, per CPU, per message, per site) scales *with* the business instead of against it. This
is the axis the owner's ruling is about, and it is the cheaper of the two to fix — a seat
dependency is usually removable by collapsing people behind one machine identity, which is
exactly the pattern already ruled for GitHub.

### The Exit Test — *how long to leave, and who decides?*

> **If this vendor doubled its price or changed its licence tomorrow, how many days until we are
> off it — and is the answer written down?**

| Band | Exit cost | Treatment |
|---|---|---|
| **Green** | ≤ 1 week · drop-in replacement named | Acceptable at any scale |
| **Amber** | 2–8 weeks · replacement exists, migration is real work | Acceptable if the exit is *written down* and re-checked yearly |
| **Red** | > 2 months, or no replacement exists | Only for capabilities we cannot build (§4). Never for commodity. |

### The quadrants

|  | **Low exit cost** | **High exit cost** |
|---|---|---|
| **No seat tax** | ✅ The target for everything | ⚠️ Tolerable — the risk is a licence change, not a bill (most AGPL components live here) |
| **Seat tax** | ⚠️ Annoying but survivable — leave when convenient | 🚨 **The dangerous quadrant.** Pays per head *and* cannot be left. Nothing may sit here. |

**Estate finding: nothing is currently in the red quadrant.** GitHub is the closest and it is
being pulled out by decisions already taken (§3.1).

---

## §2 · The estate audit

Read from the committed compose files, `package.json`s, and `ai-gateway-go/internal/providers/`
on 2026-09-21. Verdicts: **KEEP** (permissive, no tier) · **KEEP+RULE** (copyleft — usable, with
a written constraint) · **ACT** (cheap fix available now) · **EXIT-READY** (build the exit, do
not necessarily take it) · **IRREDUCIBLE** (§4).

### 2.1 — Infrastructure and data

| Component | Licence | Seat? | Exit | Verdict |
|---|---|---|---|---|
| PostgreSQL 16/17 + pgvector | PostgreSQL | No | Green | **KEEP** — the estate's single best dependency |
| **`redis:7-alpine`** (several files) | ⚠️ **RSALv2/SSPL ≥ 7.4** | No | Green | **ACT** — `7-alpine` floats onto source-available tags. One file already pins `7.2-alpine` correctly; the rest do not. **Swap all to Valkey 8 (BSD)** — drop-in for BullMQ, hours of work, ends the question permanently |
| MinIO → **RustFS** (WebDesk, WSK-D42, 2026-10-10) | MinIO ⚠️ AGPL-3.0, community build stripped since 2025 · RustFS Apache-2.0 | No | Green once swapped | **REPLACE in WebDesk** (owner 2026-10-10) — RustFS `1.0.0`, pinned by digest. A-13's storage abstraction + R2/NAS config swap stays the written exit; keep its abstraction test green. Any other estate MinIO keeps the never-patch rule until ruled separately |
| OpenBao | MPL-2.0 | No | Green | **KEEP** — already the right call over BUSL Vault |
| Caddy · nginx | Apache-2.0 · BSD | No | Green | **KEEP** |
| Docker / runc | Apache-2.0 | No | Amber | **KEEP** — note Docker *Desktop* is per-seat for business use; the estate runs the engine, not Desktop. Keep it that way |

### 2.2 — Platform services

| Component | Licence | Seat? | Exit | Verdict |
|---|---|---|---|---|
| Keycloak 26 | Apache-2.0 | No | Amber | **KEEP** — no tier. (Red Hat build is paid *support*, not features; do not buy it) |
| Cerbos 0.54 | Apache-2.0 | No | Amber | **KEEP** — **Cerbos Hub is the paid tier; never adopt it.** The PDP is complete without it. High exit cost by design (259 policy files) but that is *our* asset, not the vendor's leverage |
| Temporal 1.28 | MIT | No | Amber | **KEEP** — self-hosted. Temporal Cloud is the paid tier; not used |
| NestJS · Next.js · React · Fastify · BullMQ · zod · jose | MIT | No | Green | **KEEP** |
| ClamAV | GPL-2.0, socket boundary | No | Green | **KEEP** |
| imgproxy v3 | ⚠️ AGPL-3.0 (Pro is paid) | No | Green | **KEEP+RULE** — never patch. Escape hatches named: Thumbor (MIT), `sharp` in-process (Apache-2.0) |
| **Payload 3** | MIT — but **Enterprise tier for SSO** | Via Enterprise | Green | **EXIT — already ruled.** [`webdesk-independence.md`](./webdesk-independence.md) |

### 2.3 — Observability

| Component | Licence | Seat? | Exit | Verdict |
|---|---|---|---|---|
| Grafana 11.4 · Loki · Tempo | ⚠️ AGPL-3.0 | No (self-hosted) | Amber | **KEEP+RULE** — never patch. **Grafana Cloud is per-user; never adopt it.** Dashboards are portable JSON, which bounds the exit |
| Prometheus · Alertmanager · exporters · OTel Collector · cAdvisor | Apache-2.0 | No | Green | **KEEP** — OTel is itself an anti-lock choice; keep instrumentation OTel-native, never vendor-SDK-native |
| ntfy | Apache-2.0/GPL | No | Green | **KEEP** |

### 2.4 — Automation and delivery — *where the problems are*

| Component | Licence | Seat? | Exit | Verdict |
|---|---|---|---|---|
| **GitHub** — source · Actions · **ghcr.io registry** · the deploy trigger | Proprietary | **YES** (Team/Enterprise) + metered minutes | Amber | 🚨 **EXIT-READY (§3.1).** Four dependencies wearing one coat |
| **n8n 2.30.4** | ⚠️ **Sustainable Use License — fair-code, NOT open source.** Enterprise tier for SSO/RBAC/environments/external secrets | Via Enterprise | Amber | 🚨 **EXIT-READY (§3.2).** Internal use is permitted; **letting clients in is not** — and client delivery is the business model |
| Postiz (digest-pinned) | AGPL-3.0 | No | Amber | **KEEP+RULE** — already analysed properly in `smm-foundation.md` §6/§9 (run AGPL-contained; Mixpost Pro rejected precisely because its EULA forbids reselling workspaces). **This is the template for how the estate should reason about every licence** |
| **WAHA** (`devlikeapro/waha`) | ✅ **Core — Apache-2.0** (audited 2026-09-21; the "Plus is a paid licence" claim here was **wrong** for this deployment and is corrected, not deleted) | ✅ **No** | Red | **IRREDUCIBLE (§4)** — and for a sharper reason than licensing: it is an unofficial WhatsApp client, and **the official Cloud API cannot attach to human-created groups or manage participants at all**, so for group traffic there is no fallback at any price. Pin: ✅ done |
| Cloudflare Pages/Workers (R-2, adopted) | Proprietary | ✅ **NO — corrected 2026-09-21** | Amber | **THIS ROW WAS WRONG and is corrected rather than quietly deleted.** Workers Paid is **$5/mo per _account_** (10M req + 30M CPU-ms), and Pages builds meter per account (500 free / 5,000 paid); Cloudflare's own docs mention seats nowhere for this product. The genuinely per-seat Cloudflare product is **Zero Trust / Access (~$7/user beyond 50 free)** — not used here, and must never become the auth layer (R1). `cloudflared` tunnels are free. **R-2 stands; `webdesk-independence.md` OQ-3.6 closed.** One watch item only: Pages *Functions* bill at Workers rates, so SSR/middleware is not free — a per-resource cost, which the doctrine permits |
| `cloudflare/cloudflared:latest` · `faster-whisper-server:latest-cpu` | — | No | — | **ACT: pin.** Floating tags violate the estate's own rule and are a supply-chain exposure, not just untidiness |

### 2.5 — AI

| Component | Seat? | Exit | Verdict |
|---|---|---|---|
| **The gateway's provider interface** (claude · gemini · openai · ollama · hermes · whisper) | No | **Green** | ✅ **The estate's best anti-lock asset.** Protect it: no capability may call a provider SDK directly |
| Anthropic / Claude Code seats (the agent army) | **YES** | Green–Amber | **Accepted, and correctly so (§4).** Dev tooling, not product runtime. The gateway means *product* AI is never locked to it |
| Ollama Cloud (shared, weekly-rate-limited) | No | Green | **KEEP as a dev tier only** — already ruled: never a hard prod dependency |
| Local Ollama + Whisper on-box | No | Green | **KEEP** — the floor under the gateway |

### 2.6 — SaaS at the edges

| Component | Seat? | Verdict |
|---|---|---|
| Google Workspace / Drive (an `integration_connections` provider) | **YES** | **Amber** — a real per-seat bill, outside the system. Drive is used as a deliverable store; the exit is the estate's own MinIO |
| Semrush · Canva · Sentry · Zapier connectors | **YES** | **Not adopted — keep it that way.** Benchmark §6 already ruled SEO *data* NOT A CONTEST, so Semrush may be a deliberate buy; the others are not needed |
| Figma | **YES** | **Adopted as an edge tool. Owner ruling DW-Q6 (2026-10-13) amends this row.** It is connected read-only: frames, comments and exports appear on tasks and requests. The exit is that every delivered design is exported into the Asset Library, so nothing depends on Figma staying |
| SMTP delivery provider | No — per volume | **BUY, and now chosen — §4.1.** Never self-host the MTA |
| Linear | **YES** | ✅ **Already retired.** The estate has done this before |
| web3forms | No | ✅ Being killed at M0 |

---

## §3 · The three real problems, ranked

### 3.1 — GitHub is four dependencies wearing one coat

This is the deepest lock in the estate and it does not look like one, because it bills as a single
line item:

| Role | What depends on it |
|---|---|
| **Source host** | everything |
| **CI runner** | 19 jobs, all `runs-on: ubuntu-latest`, all metered |
| **Container registry** | `ghcr.io/hansel-gaiada/*` — **ten of the estate's own images** |
| **Deploy trigger** | `git push --tags` is the single deploy point for the whole estate |

Lose GitHub and you lose the ability to build, to pull your own images, and to ship — not just to
push code. That concentration is the finding; the seat bill is the symptom that revealed it.

**The good news is that the exit is genuinely bounded, and mostly already funded:**

- **Workflow YAML is portable.** Forgejo Actions and Gitea Actions run GitHub Actions syntax. The
  19 jobs move largely as-is. *Precondition:* pin third-party actions by commit SHA and prefer
  trivial first-party steps — which is the security best practice anyway.
- **The self-hosted runner is already planned** — v2.2 §10 lever 1, justified on billing. **The
  same box also cuts the lock.** One build, two payoffs. Its placement constraint stands: not
  `sumopod`, not `gda-aicenter` — a runner executes arbitrary repo code.
- **The registry is a container** — Gitea/Forgejo ship one; Harbor and Zot are Apache-2.0.
- **Seats are already ruled away** — github-integration-foundation decision 1 puts all ERP→GitHub
  traffic on one org-owned machine identity, and WSK-49 keeps editors on ERP identities.

#### Correction, 2026-09-21 — "the workflow YAML is portable" is true and not sufficient

A full inventory of all four workflows (done while SHA-pinning them, §6 item 4) found **three
blockers that portable YAML does not solve.** They are named here because the paragraph above,
as originally written, would have under-quoted the exit:

1. **Sigstore / cosign keyless signing** (`sigstore/cosign-installer` in `deploy.yml` and
   `release.yml`) depends on **GitHub's OIDC token issuer** for the keyless flow. Forgejo Actions
   issues no equivalent token trusted by public Fulcio/Rekor. Leaving GitHub means either a
   private Sigstore instance or key-based signing — **a design decision, not a port.**
2. **`actions/attest-build-provenance`** calls GitHub's own attestations API and is
   GitHub-OIDC-bound. No Forgejo/Gitea equivalent exists; SLSA provenance would need generating
   another way. (Note this is WS10 capability the estate deliberately built — SBOM + cosign +
   SLSA — so the exit cost lands on a real asset, not on boilerplate.)
3. **GHCR is baked in beyond the workflows** — every `IMAGE:` reference, the `docker login`
   target, the deploy-side pull, and `actions/delete-package-versions` (a GHCR-specific packages
   API call that would be *replaced*, not ported).

Also flagged: `release.yml`'s `ci-gate` job reads the GitHub REST API via `gh api`; Forgejo's API
is compatible-but-not-identical, so that gate needs rewriting rather than assuming.

**What this changes:** the CI-runner and registry halves stay Green/Amber as stated. **The
signing and provenance half is the real cost, and it is a design decision rather than a
migration.** That strengthens, not weakens, the recommendation — build readiness, do not exit.
`anchore/sbom-action`, by contrast, is a self-contained Syft wrapper with no GitHub API calls and
ports cleanly.

#### The distinction that keeps item 3 unblocked — a self-hosted runner is NOT "off GitHub"

Worth stating precisely, because conflating the two would wrongly make the runner look blocked on
the signing problem:

> **Cosign keyless signing and `actions/attest-build-provenance` continue to work on a
> self-hosted runner.** The OIDC token is issued by **GitHub's Actions service** and injected into
> the job (`ACTIONS_ID_TOKEN_REQUEST_URL`/`TOKEN`) regardless of which host executes it — it needs
> only that github.com still orchestrates the workflow, that `id-token: write` is granted, and
> that the runner can reach GitHub outbound.
>
> **They break on Forgejo/Gitea**, where no GitHub OIDC issuer is in the loop and Fulcio trusts
> that issuer specifically.

So **moving the runner host never threatens SLSA/cosign; leaving GitHub the platform does.** Item
3 can proceed at full speed, today, with zero risk to the WS10 signing chain. Only a true GitHub
exit (OQ-VI1) pays the signing cost — one more reason the answer to OQ-VI1 should stay
"readiness, not exit".

**Recommendation — and this is the part to get right: do not migrate off GitHub now.** Pull the
two levers already decided (self-hosted runner, no human seats) and the *pain* disappears while
the *platform* stays. Then build exit readiness — a mirror, pinned actions, a registry plan — and
measure it. **Exit readiness is not exit.** Paying a migration cost for a lock you are not
currently suffering is how independence projects consume the quarter they were meant to save.

### 3.2 — n8n is fair-code, and the business model collides with its licence

`n8nio/n8n:2.30.4` is under the **Sustainable Use License**. It is source-available, **not** OSI
open source. The shape of it:

- ✅ **Internal business use is permitted** — which is exactly what the estate does today (three
  flows, behind basic auth). **You are compliant right now.**
- 🚨 **Hosting it for third parties, or white-labeling it, is not.** The estate's whole direction
  is multi-tenant client delivery. The day a client gets an n8n login, or the day "automation" is
  sold as a client-facing capability, the licence is the blocker — not a bill.
- ⚠️ **SSO, RBAC, environments and external secrets are Enterprise-tier** — a direct hit on the
  owner's ruling, and on the estate's one-identity principle.
- ⚠️ Fair-code licences are **changeable at the vendor's discretion** for future versions.

**No estate document has ever analysed this** — which is notable, because `smm-foundation.md`
analysed Postiz's AGPL exposure thoroughly and rejected Mixpost Pro specifically over reselling
rights. The same rigour was never applied to n8n.

**This paragraph originally read: "the exit is cheaper than it looks, because you already wrote
the rule that bounds it." That was half right, and the audit that checked it says which half.**

> **AUDITED 2026-09-21 — verdict: PARTIALLY.** Full evidence:
> [`../assessment/2026-09-21-agentic-native-n8n-audit.md`](../assessment/2026-09-21-agentic-native-n8n-audit.md).
> The audit was commissioned to test the optimistic claim above, and it falsified a third of it.

- ✅ **The bar holds for 17 of 21 workflows** — CRON sweeps, event-notify, TR-11/TR-22 reporting.
  Thin orchestration (3–9 nodes), every effect reachable through a named human UI route **and** an
  already-callable MCP tool. Here n8n genuinely is a convenience. Exit: **1–3 weeks**.
- 🚨 **The bar has slipped for the 4 WS11 pipeline flows.** `mtg-dispatcher`, `pipeline-fanout`,
  `pipeline-delivery`, `wd-provision` hold sequencing, branching, a revise-loop with an escalation
  threshold, response parsing and argument assembly **that exist nowhere else in the codebase**.
  `pipeline-delivery.json` is a **64-node state machine** (verified). Replacing it is **new
  development, not migration: 2–3 months.**
- 🚨 **A hard dependency with no fallback**, verified at
  `platform-nest/src/core/meetings.controller.ts:508` — `ingest()` is a **synchronous proxy to
  n8n's webhook** that returns `{ ok:false, reason:'dispatcher_unreachable' }` when the bridge is
  down (*"we do NOT invent a run"*). Honest behaviour; but **with n8n gone the meeting→pipeline
  capability is gone, not degraded.** This is a resilience finding that stands on its own,
  independent of any licence question, and it should be fixed whether or not n8n ever leaves.
- ✅ **No Enterprise-tier feature is in use** — no SSO, no external secrets, no environments, no
  queue-mode, no log streaming. **Licence compliance today is verified, not assumed.**
- ⚠️ **"Three flows" is a stale figure** repeated throughout these documents from a 2026-07-15
  snapshot. There are **21 workflow files**; 16 postdate it. ~7× the surface the old estimate
  assumed.

**What this means, stated plainly: the rule did not hold itself.** The backbone rule was violated
in the newest, largest and most actively developed flow in the repo — which is precisely where a
rule is hardest to enforce and most expensive to break. **The trigger for the n8n exit is
unchanged** (OQ-VI2: the first client login, not price); only its cost changed, from weeks to
months. Verifying the bar was the highest-value n8n work, and it remains so — for the *other*
capabilities nobody has audited yet.

Replacements, if and when: **Node-RED** (Apache-2.0, visual, mature, thinner connectors) ·
**Windmill** (AGPL — copyleft, but not fair-code) · **Temporal**, which the estate *already runs*
for Postiz (MIT, code-first, no visual builder) · or flows as code in `platform-nest`, which the
agentic-native bar implies already exists.

### 3.3 — Licence hygiene: four cheap fixes

None of these cost money; all are hours.

1. **Redis → Valkey 8** everywhere (`7-alpine` floats onto RSALv2/SSPL). One file already pins
   `7.2-alpine`; make it uniform by replacing, not pinning.
2. **Pin `cloudflared:latest`, `faster-whisper-server:latest-cpu`, and `devlikeapro/waha`.** The
   estate already has this rule and enforces it elsewhere — three files missed it.
3. **Write the AGPL rule down once:** MinIO · imgproxy · Grafana · Loki · Tempo · Postiz are all
   AGPL-3.0. Unmodified upstream keeps §13 trivially satisfied. **The rule is: we never patch an
   AGPL component.** If one needs patching, that is the signal to replace it.
4. **Never adopt the managed tier of a self-hosted component** — Cerbos Hub, Grafana Cloud,
   Temporal Cloud, n8n Cloud, Payload Cloud. Each converts a per-resource dependency into a
   per-seat one, silently, at the exact moment the self-hosted version becomes inconvenient.

---

## §4 · What is irreducible — stated honestly

A doctrine that pretends everything is replaceable is a doctrine nobody follows. These are real
locks, and the correct posture is to **buy them deliberately, per-resource where possible, and
never build them.**

| Lock | Why it cannot be broken | Posture |
|---|---|---|
| **Frontier model capability** | Weights and training compute. Local Ollama is the floor, not a substitute | ✅ **Already handled** — the gateway makes the *provider* swappable even though the *capability tier* is not |
| **Email deliverability** | IP warming and sender reputation are earned over years | **Buy per-volume. Never self-host the MTA.** Benchmark §6.2: NOT A CONTEST |
| **WhatsApp — DMs** | Meta owns the network | Accept; the Cloud API **is** a real fallback here, per-message. ⏰ Service messages become chargeable **2026-10-01** |
| **WhatsApp — groups** | Meta owns the network **and the Cloud API has no way to attach to a human-created group, and no add-participant or promote-admin endpoint at all** | **Accept as genuinely irreducible — verified 2026-09-21, no fallback exists at any price.** Corrects this doctrine's earlier claim that the Business API was "the fallback": it is not, for groups |
| **Social platform APIs** | The platforms own the graph | **Accepted** — Postiz already contains this |
| **DNS, registrar, TLS roots** | Delegated authority | **Buy. Keep registrar and DNS at different vendors** |
| **SEO/backlink corpora** | A decade of crawling | **Buy if needed.** Already ruled NOT A CONTEST |
| **VPS / kernel / CPU** | Physics and capital | **Accepted.** Mitigated by being portable *between* hosts |
| **Claude Code seats (the agent army)** | It is the development team | **Accept.** Dev tooling, not product runtime — the gateway guarantees no shipped capability depends on it |

### 4.1 — SMTP: the deliberate buy (ladder item 10)

R7 says buy the irreducible per resource, and §6.2 of the WebDesk assessment rules deliverability
**NOT A CONTEST** — IP warming and sender reputation are earned over years, so the MTA is never
self-hosted. What remained was picking a provider.

**The decision is unusually low-stakes, and that is itself the finding.** `webdesk/api/src/mail/mail.config.ts`
speaks plain `MAIL_SMTP_HOST/PORT/USER/PASSWORD`, and SES, Postmark and Resend all expose ordinary
SMTP endpoints — so **switching provider is an env-var change with no code change.** A Green exit
by construction. Choose on price and deliverability, not on lock, and do not over-deliberate.

| Provider | Price (web-retrieved 2026-09-21 — confirm before budgeting) | Fits |
|---|---|---|
| **Amazon SES** | **~$0.10 / 1,000**, unchanged for a decade | Cheapest at any volume (~$10 at 100k/mo). Costs: a sandbox-exit approval, and it is thin on analytics and support |
| **Postmark** | ~$15/mo base + ~$1.80 / 1k overage | Best deliverability and support. **Its "message streams" are the exact shape `webdesk/api/src/mail` already models with per-tenant stream isolation** — the closest conceptual fit |
| **Resend** | 3,000/mo free, tiers above | Best for starting; the free tier covers dev and early WebDesk forms outright |

**Recommendation: Resend's free tier for the WebDesk forms / M0 work, then SES once real volume
exists.** Keep **Postmark** as the named upgrade if transactional latency ever becomes
revenue-critical (magic links, OTP, approvals someone is waiting on). All three are per-volume,
none is per-seat, and all three are one env var apart — a reversible decision, to be treated as
one. Feed the volume forecast into A-10.

> **Caveat, stated because this repo is PUBLIC and these numbers will get quoted:** the prices
> above are from a 2026-09-21 web retrieval, not a vendor quote. Confirm on the provider's own
> pricing page before committing spend. SES is region-priced (Indonesia → `ap-southeast-*`).

### The tension this ruling creates with an existing decision

CLAUDE.md's non-negotiables include **"Managed-first for v1; all-local is target-state and
hiring-gated."** A hard anti-vendor posture pulls against that, and the pull is real: **every
self-hosted component is a patch treadmill on an internet-facing estate run by a team the
benchmark itself scores at "bus factor above 1: missing."**

Independence from *seats* does not mean self-hosting *everything*. The brake belongs in the
doctrine: where a component is commodity **and** security-critical **and** priced per resource —
email, DNS, TLS, backups-of-last-resort — **buying is the independent choice**, because an
unpatched self-hosted mail server is a worse dependency than a $15/month invoice.

---

## §5 · The doctrine — the rules to adopt

**R1 · No seat tax.** No component of this estate may require a per-seat third-party account for
a person who already has an ERP identity. Refused at design time, not negotiated at renewal.
*Escape:* collapse the people behind one machine identity and make the ERP ledger the record —
the pattern already ruled for GitHub.

**R2 · No enterprise tier.** If a capability is only available in a paid tier of a self-hosted
component, the capability is built, done without, or the component is replaced. **The managed
cloud tier of a component we self-host is never adopted** — Cerbos Hub, Grafana Cloud, Temporal
Cloud, n8n Cloud, Payload Cloud.

**R3 · Every dependency has a written exit.** Named replacement, estimated exit cost, and a band
(Green/Amber/Red). **No Red-band dependency without an explicit owner ruling recording why it is
irreducible (§4).** An exit that exists only in someone's head is not an exit.

**R4 · Prefer OSI-permissive > copyleft > fair-code > proprietary**, in that order, and never
patch a copyleft component — if it needs patching, replace it. Fair-code (n8n's Sustainable Use
License, BUSL, SSPL, RSALv2) is **proprietary with a source tarball**: usable internally, never
in a client-facing path, never assumed stable across versions.

**R5 · Pin everything, by tag or digest.** A floating tag is an unbounded exit cost wearing a
version number — and it is how `redis:7-alpine` quietly became source-available.

**R6 · Abstract at the provider boundary, not the vendor boundary.** The gateway's provider
interface is the pattern: one internal interface, N vendors behind it, no capability calling a
vendor SDK directly. Apply it to storage (A-13 already does), to telemetry (OTel already does),
and to any future class with more than one credible vendor.

**R7 · Buy the irreducible, per resource.** Where a capability cannot be built and is
security-critical commodity — deliverability, DNS, TLS — buying is the independent choice. **The
enemy is the seat and the lock, not the invoice.**

---

## §6 · The exit ladder — what to actually do, in order

| # | Action | Cost | Why here |
|---|---|---|---|
| **1** | ✅ **Redis → Valkey 8, estate-wide** — 6 services across 5 compose files; `redis-server`→`valkey-server` commands and `redis-cli`→`valkey-cli` healthchecks updated with them. Service names, volumes and `REDIS_URL` topology deliberately unchanged | done 2026-09-21 · **server-verification pending** | Removes a source-available licence from the estate outright. Cheapest real win available |
| **2** | ✅ **Floating tags pinned** — `cloudflared:latest`→`2026.9.1` · `waha`(tagless)→`noweb-2026.7.2` · `openbao/openbao`(**tagless — the key-custody vault**)→`2.6.2` · `clamav:stable`→`1.5.3` · `faster-whisper-server:latest-cpu`→**digest** | done 2026-09-21 | Enforces a rule the estate already has. Two were found only during the sweep: a tagless secrets vault, and `:stable`, which drifts exactly like `:latest` while looking safe |
| **3** | ✅ **Runbook written — [`self-hosted-ci-runner.md`](../../infra/runbooks/self-hosted-ci-runner.md)**. Design only; nothing provisioned. **Blocked on one owner decision: the estate owns no suitable box.** Every candidate carries production data (`gda-aicenter`), the observation plane (`sumopod`), or another tenant (`GDA-AI01`, Hostinger) — so this needs **one small dedicated VPS (2 vCPU/4GB class), never co-tenanted**. Recommended shape: rootless, ephemeral one-job-per-container, no inbound port, default-deny egress | runbook done 2026-09-21 · **awaiting a box** | **Already funded on billing grounds; also the single largest lock reduction — and, per §3.1, it costs the signing chain nothing.** First wave = the ~13 ordinary `ci.yml` push/PR jobs (the volume driver). **Never move:** `release.yml` `build-sign` and `deploy.yml` `deploy` — they hold the production SSH key, run rarely, and GitHub's ephemeral VMs are exactly the isolation you want between an arbitrary CI job and that key |
| **4** | ✅ **All 43 `uses:` lines SHA-pinned** across the 4 workflows — 11 distinct actions, every one resolved to a real 40-char commit SHA with the semver kept as a trailing comment; none guessed. Produced the blocker list now folded into §3.1 | done 2026-09-21 | Security best practice *and* the precondition for portable workflows (§3.1) |
| **5** | ✅ **Audited — [`2026-09-21-agentic-native-n8n-audit.md`](../assessment/2026-09-21-agentic-native-n8n-audit.md).** Verdict **PARTIALLY**: holds for 17 of 21 flows, **slipped for the 4 WS11 pipeline flows**, plus one hard dependency with no fallback. Not "three flows" — **21**, a stale figure since 2026-07-15 | done 2026-09-21 | Proved the optimistic assumption **wrong**, which is exactly why it was worth doing before any migration. n8n's row in the register is now split: Amber 1–3 wk / **Red 2–3 months** |
| **6** | ✅ **Exit register written** — [`vendor-exit-register.md`](./vendor-exit-register.md), 38 rows, re-checked yearly and at every new dependency's design review | done 2026-09-21 | R3. Makes the doctrine checkable instead of aspirational. **Headline: 2 Red bands (Cerbos — accepted; WAHA — unmitigated), and after the two in-flight removals land, no seat-priced dependency remains in the product runtime** |
| **7** | **GitHub exit readiness** — read-only Forgejo/Gitea mirror + a registry plan | Days | Readiness, **not** migration. Measure it; do not take it |
| **8** | **WSK-40…51** — the Payload removal and ERP editorial auth | Weeks | The one seat dependency inside the product |
| **9** | ✅ **Cloudflare re-checked — there is no trap.** Workers Paid is $5/mo **per account**, not per seat. R-2 stands; OQ-3.6 (webdesk-independence) closed | done 2026-09-21 | Adopted before the trap was named — and it turned out not to be one. **§2.4's claim was mine and it was wrong; corrected in place** |
| **10** | ✅ **SMTP provider recommended — §4.1.** Resend free tier now → SES at volume → Postmark if latency becomes revenue-critical. All per-volume, none per-seat, all one env var apart | done 2026-09-21 | An irreducible buy, deliberately made (R7) |

**Items 1, 2, 4 and 9 are a single afternoon between them** and close four of the audit's
findings. Start there.

---

## §7 · What independence costs — the counter-case, stated so it is not discovered later

1. **Ops burden lands on a bus factor of one.** Every self-hosted component is patching, backups
   and an upgrade path. The benchmark already lists bus factor as a gap; this doctrine makes it
   heavier. R7 is the brake and it must be used, not admired.
2. **Independence work is not product work.** Items 1–7 ship no client value. They are insurance,
   and insurance is bought in proportion to the risk — which is why §6 is ordered by
   cost-to-benefit and why §3.1 recommends *not* migrating off GitHub today.
3. **"No enterprise tier" forecloses real capabilities.** n8n SSO, Grafana Cloud's managed
   alerting, Cerbos Hub's policy CI. Each is a genuine convenience being refused. The trade is
   deliberate: the estate builds the equivalent behind its own identity layer, which the benchmark
   scores **AHEAD of every ERP** — but "we'll build it" is a commitment, not a free pass.
4. **Self-hosting is not always the independent choice.** An unpatched mail server, an
   unmonitored DNS server, an expired self-managed TLS chain — each is a worse dependency than the
   invoice it replaced.

---

## §8 · Proposed decisions — for ratification

Drafted, **not** self-ratified. R1–R7 belong in **CLAUDE.md § "Non-negotiable decisions"**, since
they are estate-wide and bind every component.

| # | Decision | Why |
|---|---|---|
| **EST-D-VI1** | **No per-seat third-party account for anyone who already has an ERP identity; no enterprise tier of any self-hosted component; the managed cloud tier of a component we self-host is never adopted.** Promotes `webdesk-independence.md`'s WSK-D40 from WebDesk scope to estate scope. | A dependency that prices per human taxes every new editor, client contact and agent. Converts the estate's identity layer — benchmarked AHEAD of every ERP — into avoided spend. |
| **EST-D-VI2** | **Every dependency carries a written exit: named replacement, estimated cost, band (Green ≤1wk / Amber 2–8wk / Red >2mo). No Red-band dependency without an explicit owner ruling recording why it is irreducible.** | "Vendor lock free" is not measurable; bounded exit cost is. An exit that exists only in someone's head is not an exit — the same reason this program already rules that no ruling exists outside the decision log. |
| **EST-D-VI3** | **Licence order of preference: OSI-permissive > copyleft > fair-code > proprietary. Never patch a copyleft component. Fair-code (Sustainable Use, BUSL, SSPL, RSALv2) is proprietary-with-source: internal use only, never in a client-facing path.** | `smm-foundation.md` already reasoned exactly this way about Postiz and Mixpost Pro and got the right answer. n8n never received the same scrutiny and sits one client-login away from a licence breach. |
| **EST-D-VI4** | **Buy the irreducible, per resource — deliverability, DNS, TLS, registrar. The enemy is the seat and the lock, not the invoice.** Amends *"managed-first for v1"* rather than contradicting it. | Independence from seats is not self-hosting everything. An unpatched self-hosted mail server on a bus factor of one is a worse dependency than a $15/month invoice. |

---

## §9 · Open questions

| # | Question | Default if unanswered |
|---|---|---|
| **OQ-VI1** | Is a GitHub *exit* wanted, or only exit *readiness*? They differ by weeks of work. | **Readiness only** (§3.1). Pull the runner + no-seats levers; keep the platform |
| **OQ-VI2** | Will clients ever touch n8n directly — a login, a white-labeled console, "automation" sold as a capability? **Now materially more expensive to answer "yes" to:** the 2026-09-21 audit prices that replacement at **2–3 months**, not 2–6 weeks, because the WS11 pipeline's logic exists only inside n8n. | **No.** If yes, the licence forces a replacement *before* the first client, not after — and it must now be budgeted as a quarter, not a sprint |
| **OQ-VI3** | Is Semrush a deliberate buy for the SEO data the benchmark already rules NOT A CONTEST? | Deliberate buy, per-resource plan, one account — never per-seat |
| **OQ-VI4** | Google Workspace/Drive: keep as a deliverable store, or migrate deliverables to the estate's own MinIO? | Keep for now; revisit when Drive's seat count grows faster than headcount |
| ~~**OQ-VI5**~~ | ~~Does WAHA run Core or Plus today, and is the Business API costed as the fallback?~~ | ✅ **RESOLVED 2026-09-21** — [`../assessment/2026-09-21-waha-edition-and-whatsapp-fallback.md`](../assessment/2026-09-21-waha-edition-and-whatsapp-fallback.md). **Core, Apache-2.0, no licence key, no defect.** And the Business API is **not** a fallback for groups at any price — which is the real finding |
| **OQ-VI8** | **NEW, and it is a business question, not a technical one.** Group capability cannot survive a move off WAHA. So: is WhatsApp *group* automation a capability this business is willing to run permanently on an unofficial client, accepting ban risk with only a manual warm-standby runbook — or should group features be capped where they are? | **Accept and cap.** Treat group automation as a permanently unofficial capability: no new group features without an explicit ruling, and keep `wa-ban-recovery.md` rehearsed |
| **OQ-VI9** | ⏰ **Dated.** Meta charges for service messages from **2026-10-01**. Has anyone costed the bot's actual inbound-reply volume against that? | Measure one week of service-window replies **before** 2026-10-01; aggregator rates (~IDR 357/msg +VAT) are not Meta's own rate card |
| ~~**OQ-VI6**~~ | ~~Who owns the exit register and how often is it re-checked?~~ | ✅ **RESOLVED 2026-09-21.** Register exists: [`vendor-exit-register.md`](./vendor-exit-register.md). Owner `web@gaiada.com`; re-checked yearly **and** at every new dependency's design review; rows update in the same change that moves the work |
| **OQ-VI7** | **NEW — abandonment is a risk axis this doctrine did not model.** `fedirz/faster-whisper-server` is archived upstream (last build Jan 2025) and now digest-pinned — frozen, but unmaintained, and it processes uploaded audio. How should the register track *rot* as distinct from *lock*? | Add a maintenance-status column at the first yearly re-check; treat "archived upstream" as an automatic Amber regardless of exit cost |
