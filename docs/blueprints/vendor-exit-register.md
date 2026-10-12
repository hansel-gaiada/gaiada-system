# Vendor Exit Register

> **Status:** `LIVE REGISTER` — this file is the estate's answer to *"what does leaving cost?"*
> **Created:** 2026-09-21 · **Owner:** web@gaiada.com · **Re-check cadence:** yearly, **and at
> every new dependency's design review**
> **Doctrine:** [`vendor-independence-doctrine.md`](./vendor-independence-doctrine.md)
> (EST-D-VI2 requires this register to exist and to be kept current)
>
> **Binding rule — same as every tracker in this program: update the row in the SAME change that
> moves the work.** A stale row here is worse than no row, because it will be trusted.

## How to read it

**Band** answers one question: *if this vendor doubled its price or changed its licence tomorrow,
how long until we are off it?*

| Band | Exit cost | Rule |
|---|---|---|
| 🟢 **Green** | ≤ 1 week — drop-in replacement named | Acceptable at any scale |
| 🟡 **Amber** | 2–8 weeks — replacement exists, migration is real work | Acceptable **only while the exit is written in this file** |
| 🔴 **Red** | > 2 months, or no replacement exists | **Requires an explicit owner ruling recording why it is irreducible.** Never for commodity |

**Seat?** = does adding one more human increase the bill? Per EST-D-VI1 the answer must be **No**
for anyone who already has an ERP identity.

> **A note on the estimates.** Exit costs are engineering judgement from the shape of the
> integration, not from a rehearsal. None has been drilled. An exit that has never been tested is
> an estimate, not a guarantee — the same caveat this estate applies to its untested backup
> scripts.

---

## 1 · Data and infrastructure

| Dependency | Licence | Seat? | Replacement | Exit | Band |
|---|---|---|---|---|---|
| PostgreSQL 16/17 + pgvector | PostgreSQL | No | — (no reason to leave) | n/a | 🟢 |
| Valkey 8 *(swapped in from Redis 2026-09-21; server verification pending)* | BSD | No | Redis ≤7.2, KeyDB, Dragonfly | days | 🟢 |
| RustFS *(replaces MinIO in WebDesk, WSK-D42, 2026-10-10; swap in progress)* | Apache-2.0 | No | **Cloudflare R2 / NAS / MinIO via A-13's storage abstraction** — the abstraction and its test already exist | 1–2 wk | 🟢 |
| OpenBao | MPL-2.0 | No | Infisical, SOPS+age | 2–4 wk | 🟡 |
| Caddy · nginx | Apache-2.0 · BSD | No | each other | days | 🟢 |
| Docker engine | Apache-2.0 | No | Podman | 2–4 wk | 🟡 |
| VPS hosts (aicenter · sumopod · Hostinger) | — | No | any VPS — the estate is compose-portable | 1–2 wk/host | 🟢 |

## 2 · Platform services

| Dependency | Licence | Seat? | Replacement | Exit | Band |
|---|---|---|---|---|---|
| Keycloak 26 | Apache-2.0 | No | Authentik, Zitadel, Ory Hydra | 4–8 wk | 🟡 |
| Cerbos 0.54 | Apache-2.0 | No | OPA/Rego, OpenFGA | **> 2 mo** — 259 policy files | 🔴¹ |
| Temporal 1.28 | MIT | No | BullMQ (already in estate), river | 2–4 wk | 🟡 |
| NestJS · Next.js · React · Fastify · BullMQ · zod · jose | MIT | No | — | n/a | 🟢 |
| ClamAV | GPL-2.0 (socket) | No | VirusTotal API, none | days | 🟢 |
| imgproxy v3 | AGPL-3.0 | No | Thumbor (MIT), `sharp` in-process (Apache-2.0) | 1 wk | 🟢 |
| **Payload 3** | MIT / Enterprise for SSO | **Via Enterprise** | **Own editorial layer — WSK-40…51** | in flight | 🟢² |

¹ **Cerbos is Red by construction, and that is accepted.** The 259 policy files are *our* asset,
not the vendor's leverage — the PDP is Apache-2.0 with no tier we depend on, so the realistic
risk is abandonment, not extraction. **Mitigation, and the reason this Red is tolerable: never
adopt Cerbos Hub** (EST-D-VI2), so nothing we own lives outside this repo.

² Payload's exit is already funded and in flight — see
[`webdesk-independence.md`](./webdesk-independence.md). Band reflects the post-audit finding that
Payload holds two collections, one of which is a boot stub.

## 3 · Observability

| Dependency | Licence | Seat? | Replacement | Exit | Band |
|---|---|---|---|---|---|
| Grafana 11.4 | AGPL-3.0 | No (self-hosted) | Perses (Apache-2.0) — dashboards are portable JSON | 2–4 wk | 🟡 |
| Loki · Tempo | AGPL-3.0 | No | VictoriaLogs, Jaeger | 2–4 wk | 🟡 |
| Prometheus · Alertmanager · exporters · cAdvisor | Apache-2.0 | No | VictoriaMetrics, Mimir | 2–4 wk | 🟡 |
| OTel Collector | Apache-2.0 | No | — (OTel *is* the anti-lock layer) | n/a | 🟢 |
| ntfy | Apache-2.0/GPL | No | Gotify, email | days | 🟢 |

> **Standing rule for this section: instrumentation stays OTel-native, never vendor-SDK-native.**
> That one choice is what keeps every row above Amber instead of Red.

## 4 · Automation and delivery

| Dependency | Licence | Seat? | Replacement | Exit | Band |
|---|---|---|---|---|---|
| **GitHub — source** | Proprietary | **Yes** | Forgejo / Gitea (self-hosted) | 2–4 wk | 🟡 |
| **GitHub — Actions CI** (build/test jobs) | Proprietary | metered | **Self-hosted runner** — runbook written 2026-09-21 ([`self-hosted-ci-runner.md`](../../infra/runbooks/self-hosted-ci-runner.md)), awaiting one dedicated VPS → then Forgejo Actions runs the same YAML | 2–3 wk | 🟡⁹ |
| **GitHub — cosign keyless signing + build provenance** | Proprietary | — | private Sigstore, or key-based signing; provenance needs re-engineering | **> 2 mo — design, not migration** | 🔴⁷ |
| **GitHub — ghcr.io registry** | Proprietary | — | Gitea/Forgejo built-in registry, Harbor, Zot (Apache-2.0) | 1–2 wk | 🟢 |
| **GitHub — deploy trigger** (`git push --tags`) | — | — | identical on Forgejo | days | 🟢 |
| **n8n — WS4 CRON/notify + TR-11/TR-22 reporting** (17 flows) | ⚠️ Sustainable Use (fair-code) | No feature in use | platform-nest scheduler job (precedent: `startReconcileLoop`) · Node-RED · cron+script | **1–3 wk** | 🟡³ |
| **n8n — WS11 delivery pipeline** (`mtg-dispatcher` · `pipeline-fanout` · `pipeline-delivery` · `wd-provision`) | ⚠️ Sustainable Use (fair-code) | No feature in use | **must be DESIGNED** — `ai-agents` specialist + a real Temporal workflow | **2–3 months** | 🔴³ |
| Postiz | AGPL-3.0 | No | Mixpost Pro (rejected — EULA forbids reselling workspaces) | 4–8 wk | 🟡 |
| **WAHA** | ✅ **Core — Apache-2.0**, verified | ✅ **No** | Cloud API covers **DMs only**; **groups have no path at any price** | **no full exit exists** | 🔴⁴ |
| Cloudflare Pages/Workers | Proprietary | ✅ **No** — $5/mo per *account*, re-checked 2026-09-21 | own deploy pipeline (`webdesk/deploy` rsync driver exists) | 2–4 wk | 🟡⁸ |
| **Umami 3.x** *(WSK-D66; PLANNED, not yet deployed; self-hosted on `sumopod`, collector-only public)* | MIT | No | Plausible CE (AGPL-3.0), Matomo (GPL-3.0), PostHog; the event list in `src/scripts/tracking/events.ts` is our own contract, so only the endpoint and the reader change | 1–2 wk (history is not portable, and at 14-month retention it need not be) | 🟢¹⁰ |
| **DB-IP Lite** *(IP to country/city/ASN; local MMDB, no per-request call; PLANNED, recommended for phase V2, M5-V1)* | CC BY 4.0 (attribution link required) | No | MaxMind GeoLite2 (EULA, account + key, 30-day refresh duty), DB-IP paid tier, IPinfo database | days (same MMDB format; swap the file and the attribution line) | 🟢¹¹ |
| **IP-to-company data** *(CANDIDATE, not chosen; phase 5 only, needs owner ruling + DPA review; M5-V1)*: IPinfo IP-to-Company database (local file) or Snitcher (API) | Proprietary / commercial | No (Snitcher: unlimited team members) | each other; Dealfront/Leadfeeder; or none (country/network only) | 2–4 wk (the profile store keeps only derived attributes) | 🟡¹² |
| **Certified e-signature: VIDA** *(PV5-03 pick, approved 2026-10-12 for when the certified tier is first needed (PV-D25); PARKED, not contracted; runner-up Privy)* | Proprietary SaaS (per-signature) | No per-seat fee found; Business plan Rp175,000/mo, per-user status unconfirmed | Privy, Peruri Sign It, Digisign, Tilaka (all registered PSrEs) behind our `SignatureProvider` adapter | 3-8 wk (one new adapter, a new contract and sandbox; **custody exit: we store the signed PDF, certificate and audit record ourselves at signing time, so leaving never strands a signed contract**) | 🟡¹³ |
| **Payment gateway: Midtrans Snap** *(PV5-03 pick, approved by the owner 2026-10-12 (PV-D25); PLANNED, merchant registration pending; runner-up DOKU)* | Proprietary SaaS (per-transaction) | No | DOKU Checkout, Xendit, behind our `PaymentProvider` adapter | 2-4 wk (one new adapter plus a new merchant approval; payments and receipts already live in our ledger) | 🟡¹⁴ |
| **rrweb** *(the session recorder in the site and the event format the collector stores; exact version pinned; PLANNED, in use once the site recorder (M5-V6-d) ships; design §6.1)* | MIT | No | OpenReplay tracker, Highlight.io (Apache-2.0, an rrweb fork), PostHog session replay (rrweb underneath), Microsoft Clarity (hosted; the thing V6 is meant to replace) | 2-4 wk (a different recorder in the site, a new event parser and size and typing checks in the collector, a new player; recordings live 30 days, so no archive has to be converted) | 🟡¹⁵ |
| **rrweb-player** *(the replay view in the ERP, platform-ui; exact version pinned, 2.1.6; IN PROGRESS: M5-V6-c)* | MIT | No | `@rrweb/replay` (the bare Replayer it wraps, MIT) with our own small controls; or the player that ships with whichever recorder replaces rrweb | days (the player is a view over the events; only the controls change) | 🟢¹⁶ |

³ **AUDITED 2026-09-21 — the single row became two, because the answer was not uniform.**
Full evidence: [`../assessment/2026-09-21-agentic-native-n8n-audit.md`](../assessment/2026-09-21-agentic-native-n8n-audit.md).

This row previously read "2–6 weeks, Amber," hedged on whether the **agentic-native bar** (CLAUDE.md:
*every capability must work identically under a human, under n8n, and under an agent*) still held.
**The audit says: PARTIALLY — and its own hedge, "if the bar has slipped the number is optimistic,"
is now CONFIRMED optimistic.**

- **The bar holds for 17 of 21 workflows** — CRON sweeps, event-notify, TR-11/TR-22 reporting. Thin
  orchestration, 3–9 nodes, every effect reachable through a named human UI route **and** an
  already-callable MCP tool. Here n8n is a convenience, not a dependency, exactly as designed.
- **The bar has silently slipped for the 4 WS11 pipeline flows**, which hold sequencing, branching,
  a revise-loop with an escalation threshold, response parsing and argument assembly **that exist
  nowhere else in the codebase**. `pipeline-delivery.json` is a **64-node state machine** (verified).
  Replacing it is *new development*, not a migration.
- **A hard dependency with no fallback**, verified in source at `platform-nest/src/core/meetings.controller.ts:508`:
  `ingest()` is a **synchronous proxy to n8n's webhook** and, when the bridge is unreachable,
  deliberately returns `{ ok:false, reason:'dispatcher_unreachable' }` — *"we do NOT invent a run."*
  Honest behaviour, but it means **with n8n gone the meeting→pipeline capability is gone, not
  degraded.** That is a resilience finding independent of any licensing question.
- **No Enterprise-tier feature is in use** — no SSO, no external secrets, no environments, no
  queue-mode, no log streaming. **The licence-compliance claim holds today.**
- **The "three flows" figure everywhere in these docs is stale** — a 2026-07-15 snapshot. The
  checkout holds **21 workflow files**; 16 postdate it. Roughly 7× the surface the old estimate
  was implicitly sized against.

**The trigger is unchanged** — not price, but the first client login to n8n (OQ-VI2). What changed
is the cost *if* it fires: **2–3 months, not 2–6 weeks.**

⁷ **Found 2026-09-21 while SHA-pinning the workflows, and it splits the GitHub row in two.** The
CI/registry half of a GitHub exit is Amber as stated. The **signing and provenance half is Red**:
`sigstore/cosign-installer` keyless signing is bound to GitHub's OIDC issuer, and
`actions/attest-build-provenance` calls GitHub's own attestations API — neither has a Forgejo
equivalent. This is the WS10 SBOM+cosign+SLSA capability, so the cost lands on a real asset, not
boilerplate. **It strengthens the "readiness, not exit" recommendation (OQ-VI1).**

⁸ **Re-checked 2026-09-21 and downgraded from a seat risk.** Workers Paid is **$5/mo per
account** (10M requests + 30M CPU-ms included); Pages builds meter per account. Cloudflare's
per-seat product is **Zero Trust / Access** (~$7/user beyond 50 free), which the estate does not
use — and must never adopt as an auth layer (R1), since that is the one way this becomes a seat
cost. Band stays Amber on **exit** cost, not on price. Watch item: Pages *Functions* bill at
Workers rates, so SSR/middleware is not free.

⁹ **The runner move is fully unblocked by §3.1's OIDC distinction, and that is the useful
finding.** Cosign keyless signing and `attest-build-provenance` keep working on a **self-hosted
runner** — GitHub's Actions service still issues the OIDC token, whatever host runs the job.
They break only on **Forgejo**. So the billing win and the lock reduction are available now, at
zero risk to the WS10 signing chain; only a true platform exit pays that cost. Remaining blocker
is procurement, not engineering: **the estate owns no box that may safely host a hostile-code
executor** — not `sumopod` (observation plane), not `gda-aicenter` (live ERP + public surface +
lab-runner), not `GDA-AI01` (multi-tenant), not Hostinger (not ours to repurpose).

⁴ **AUDITED 2026-09-21 — two of the three exposures I originally named were wrong, and the one
that remains is worse than described.** Evidence:
[`../assessment/2026-09-21-waha-edition-and-whatsapp-fallback.md`](../assessment/2026-09-21-waha-edition-and-whatsapp-fallback.md).

**Withdrawn — the paid-tier leg.** The deployment runs **WAHA Core**: no licence-key env var
exists anywhere (`WAHA_API_KEY` is REST auth, `WAHA_DASHBOARD_PASSWORD` is a dashboard login —
neither is a licence), and the image is the free `devlikeapro/waha` family, not the separately
gated `waha-plus`. Every endpoint the bot actually calls — send, react, media, typing, group-admin
verbs on one hardcoded session, QR pairing, group-name enrichment — was never behind the old Plus
wall. **No live defect.** Reportedly the vendor also merged all former Plus features into Core at
2026.6.1, before this repo's pinned tag.

**Withdrawn — the licence leg.** WAHA Core is **Apache-2.0** (verified by direct read of the
upstream `LICENSE`), with **no resale, hosting or white-labeling restriction**. It is not
fair-code and does not belong in the same class as n8n. *Residual: the vendor's own site/ToS was
not exhaustively checked beyond the code licence.*

**Stands, and sharpened — the leg the Red should actually be named after.** This is an
**unofficial WhatsApp client**: the exposure is Meta's ToS and the ever-present risk of the number
being banned. And the "named fallback" this register previously claimed **is not a fallback**:

> **The official Cloud API cannot replace this bot's group capabilities at any price.** Cloud API
> groups are **business-created only** — there is no way to attach to a group a human already
> made in the ordinary app, which is precisely this bot's ingestion model. There is **no
> add-participant and no promote/promote-admin endpoint at all**, so `/group promote` has nothing
> to migrate to, and interactive buttons are excluded from groups outright. Only DM/Q&A traffic
> has a path. Attaching a warmed spare number by QR has no Cloud API analogue either, so the
> entire `wa-ban-recovery.md` warm-standby runbook has no equivalent.

**So the band is unchanged at Red, but the reason is corrected: not "it costs money to leave" —
"for groups, there is nowhere to go."** That is the definition of an irreducible dependency, and
it should be ruled on as one (§6) rather than tracked as something to fix.

⏰ **Time-sensitive, and the one item here with a date: from 2026-10-01, Meta charges for service
messages** (free-form replies inside the 24-hour window) for the first time since Nov 2024, at the
utility/authentication rate with no volume discount — confirmed on Meta's own page. Indonesia
indicative rates: marketing ~IDR 586/msg, utility ~IDR 357/msg, authentication ~IDR 357–438
(sources disagree), all +11% VAT. **These are aggregator figures, not Meta's own rate card —
confirm before budgeting.**** Unofficial WhatsApp client: a paid-tier exposure
(Plus), a licence exposure, and a Meta ToS exposure, against a network nobody can replace. The
official Business API is the named fallback and it costs per message. **OQ-VI5: confirm whether
Core or Plus runs today, and cost the fallback — before the next WhatsApp capability ships.**

¹⁰ **Umami — added 2026-10-11 (M5-V1), PLANNED.** Licence MIT, current major 3.x (3.4.0 listed as latest, GHCR tags `postgresql-latest` and `3.4.0`; source: GitHub releases and package page, accessed 2026-10-11). Three standing risks: ① it is a small-maintainer project with a **High advisory GHSA-3xx8-742v-m4mq (2026-06-30) listing no patched version** as fetched, so the public surface must be the collector only and the ERP reader must be network-private; ② its default geo file is a GeoLite2 copy (see ¹¹); ③ self-hosted data is kept indefinitely unless we delete it, so the 14-month retention is OUR job. Review: [`../plans/2026-10-11-m5-geo-and-company-data-review.md`](../plans/2026-10-11-m5-geo-and-company-data-review.md).

¹¹ **DB-IP Lite — added 2026-10-11 (M5-V1), PLANNED.** CC BY 4.0, monthly refresh, country/city/ASN editions in MMDB and CSV (source: db-ip.com/db/lite.php, accessed 2026-10-11). No account, no key, no deletion duty, which is why it is preferred over GeoLite2. Costs: lower accuracy than the paid tier, and a visible "IP Geolocation by DB-IP" link wherever results are shown (confirm placement with counsel for admin-only display). Not yet tested inside Umami; test before relying on it.

¹² **IP-to-company — added 2026-10-11 (M5-V1), a candidate only.** A local dataset (IPinfo, quote-only, enterprise) keeps the IP inside our estate; an API (Snitcher from USD 49/mo, volume-priced) makes the vendor a **new processor** that receives visitor IPs. Amber because the data leaves us or costs real money, and neither fits the "no new processor without a ruling" posture of the visitor addendum (R-V14). Do not wire until the owner rules.

¹³ **Certified e-signature, VIDA: added 2026-10-12 (PV5-03), PLANNED.** Pick and runner-up reasoning: [`pv5-provider-comparison.md`](./pv5-provider-comparison.md). Per-signature (about Rp3,000 each at the published Rp30,000 per 10 external signatures) with no per-seat fee found; the Rp175,000/mo Business plan's per-user status is unconfirmed and must be put in writing before contract. **Custody exit (the reason this is Amber, not Red):** at signing time we store the signed PDF, the certificate or evidence page and the provider's audit record as files with SHA-256 (PV5-11), so leaving never strands a signed contract. **What still breaks after we leave:** re-verifying a signature through the provider's validation service if it is switched off, and re-verifying the certificate chain once the provider's CA is gone or its revocation (OCSP/CRL) endpoints stop answering; signers also need a new KYC and certificate with the next PSrE. Not Green: a new PSrE means a new contract, sandbox and adapter. Not Red: five registered PSrEs exist. Public pricing and API terms of every PSrE are thin, so the band is an estimate that has not been drilled.

¹⁴ **Payment gateway, Midtrans: added 2026-10-12 (PV5-03), PLANNED.** Reasoning: [`pv5-provider-comparison.md`](./pv5-provider-comparison.md). Per-transaction fees only (VA Rp4,000, QRIS 0.7%, card 2.9% + Rp2,000, no setup or monthly fee, read 2026-10-12); no seat concept. Amber, not Green, because moving needs a new merchant approval (company documents, a wait outside our control) as well as a new adapter. Hosted checkout means no card data ever reaches us, and payments and receipts live in our ledger, so history does not move. Virtual-account payments cannot be refunded through Midtrans's refund API, so refunds stay manual (out of PV-5 scope). Settlement timing was not found in public pages.

¹⁵ **rrweb: added 2026-10-13 (M5-V6-c), PLANNED.** MIT; the 2.x line is stable (2.0.0 on 2026-06-01, 2.1.6 on 2026-09-18; source: the npm registry). Runs in the visitor's browser and in our collector's parser; no personal data is sent to the project. Standing risks: ① the format is the lock: the site recorder (V6-d), the collector's checks (V6-a) and the player all speak rrweb events, so leaving means changing all three together; ② it is a small-maintainer project with a long alpha history, so the exact version is **pinned** and updated deliberately, never floated (the platform-ui lockfile pins every `@rrweb/*` package too; see the `overrides` block in `platform-ui/package.json`); ③ masking is ours to prove (V6-e decodes stored chunks for a typed test string). Because the MIT source can be vendored and recordings expire after 30 days, abandonment is survivable: the band is Amber on the work, not on the licence. Exit drill: not rehearsed. Addendum v0.2 §8.2 row.

¹⁶ **rrweb-player: added 2026-10-13 (M5-V6-c), IN PROGRESS.** MIT, **2.1.6** exactly (published 2026-09-18, more than two weeks old when chosen; the newer 2.1.7 of 2026-10-02 was too fresh). Runs in staff browsers in the ERP only; it loads no remote code and sends nothing anywhere. It adds one direct runtime dependency to platform-ui, with `@rrweb/packer`, `@rrweb/replay`, `@rrweb/types`, `@rrweb/utils`, `rrdom`, `rrweb` and `rrweb-snapshot` pinned to 2.1.6 through `overrides` so a fresh install cannot float to a newer release. The replayed page runs in an iframe sandboxed to `allow-same-origin` only; `UNSAFE_replayCanvas` stays off; the player page's CSP admits images only from the site's own domains (`platform-ui/src/lib/replaysCsp.ts`). Addendum v0.2 §8.2 row.

## 5 · AI

| Dependency | Seat? | Replacement | Exit | Band |
|---|---|---|---|---|
| **Provider layer** (claude · gemini · openai · ollama · hermes · whisper) | No | one interface, six vendors already behind it | **hours** | 🟢 |
| Anthropic / Claude Code seats (the agent army) | **Yes** | other coding agents; the gateway means no *shipped* capability depends on it | n/a — dev tooling | 🟢⁵ |
| Ollama Cloud (shared, weekly-limited) | No | local Ollama, any OpenAI-compatible endpoint | hours | 🟢 |
| Local Ollama | No | — (this *is* the floor) | n/a | 🟢 |
| **`fedirz/faster-whisper-server`** | No | **speaches-ai/speaches** (the named successor), or whisper.cpp / WhisperX | 1–2 wk | 🟡⁶ |

⁶ **A different failure mode than the rest of this register: rot, not lock.** Found 2026-09-21
while pinning tags. The upstream repo is **archived** (moved to `speaches-ai/speaches`) and has
shipped nothing since **January 2025**; `:latest-cpu` itself dates from **October 2024**. It is
now digest-pinned, which freezes a known-good build and stops the drift — **but a pin is not
maintenance.** No security patches will ever arrive for this image, and it processes uploaded
audio. **The register should track abandonment as its own axis:** low exit cost and no seat tax
still leaves you running unmaintained code. Migration to speaches is a deliberate decision, not
a tag bump.

⁵ **Accepted per EST-D-VI4.** Per-seat, but it is the development team, not the product runtime.
The provider interface is what guarantees this seat cost can never propagate into a client
deliverable. **Protect the interface: no capability may call a provider SDK directly.**

## 6 · Irreducible — bought deliberately (EST-D-VI4)

| Dependency | Why irreducible | Posture |
|---|---|---|
| Frontier model capability | weights + training compute | Provider swappable; capability tier is not |
| Email deliverability | IP warming, sender reputation | **Buy per volume. Never self-host the MTA.** ✅ Provider chosen 2026-09-21: **Resend free tier → SES at volume → Postmark as the named upgrade** (doctrine §4.1). All per-volume, none per-seat. **The exit is Green despite this being an irreducible buy**, because `MAIL_SMTP_*` is provider-agnostic — switching is an env var, not a migration. Volume forecast still owed to A-10 |
| WhatsApp **groups** | Meta owns the network, **and the Cloud API cannot attach to human-created groups or manage participants at all** | **Genuinely irreducible — no fallback exists at any price.** Verified 2026-09-21. Should be ruled as accepted-irreducible, not tracked as a gap |
| WhatsApp **DMs** | Meta owns the network | Cloud API is a real fallback here, per-message. Charging for service messages starts **2026-10-01** |
| Social platform APIs | the platforms own the graph | Postiz contains it |
| DNS · registrar · TLS roots | delegated authority | **Buy. Keep registrar and DNS at different vendors** |
| SEO/backlink corpora | a decade of crawling | Buy if needed — benchmark §6: NOT A CONTEST |
| Kernel · CPU · hypervisor | physics and capital | Mitigated by being portable *between* hosts |

---

## Register summary

| Band | Count | Notes |
|---|---|---|
| 🟢 Green | 22 | +Umami, +DB-IP Lite (2026-10-11); +rrweb-player (2026-10-13) |
| 🟡 Amber | 22 | all have a named replacement in this file; +IP-to-company candidate (2026-10-11); +VIDA e-signature and +Midtrans gateway (PV5-03 picks, 2026-10-12); +rrweb recorder (2026-10-13) |
| 🔴 Red | 4 | **Cerbos** (accepted — our asset, no tier dependency) · **WAHA** (corrected 2026-09-21: Core/Apache-2.0, not a paid tier — Red now stands on *"groups have no fallback at any price"*) · **GitHub signing/provenance**⁷ (design decision, not migration) · **n8n WS11 pipeline**³ (the agentic-native bar slipped; 2–3 months, not weeks) |
| **Seat-priced** | **4** *(was 5)* | GitHub *(being removed — machine identity + WSK-49)* · Payload *(being removed — WSK-40…51)* · Google Workspace *(edge tool)* · Claude Code *(accepted, dev tooling)*. — **Cloudflare dropped off this list 2026-09-21: the re-check found Workers Paid is per account, not per seat.** |

**The register's own headline: after the two in-flight removals land, no seat-priced dependency
remains in the product runtime.** What is left is Cloudflare (a re-check), Google Workspace (an
edge tool), and the agent army (deliberately accepted).

---

## Change log

| Date | Change |
|---|---|
| 2026-09-21 | Register created from `vendor-independence-doctrine.md` §2. Payload removal in flight (WSK-40…51). **Nothing in this register has been exit-drilled.** |
| 2026-09-21 | **Redis→Valkey 8 landed** (6 services, 5 compose files) and **all floating tags pinned** — incl. two found only during the sweep: a **tagless `openbao/openbao`** (the key-custody vault, implicitly `:latest`) and `clamav:stable`. Working tree only; **server verification pending**. |
| 2026-09-21 | **Cloudflare re-checked and CORRECTED** — Workers Paid is $5/mo per *account*, not per seat; the doctrine's original claim was wrong and is corrected in place, not deleted. Seat-priced count 5 → 4. R-2 stands. **SMTP provider chosen** — Resend → SES → Postmark (doctrine §4.1); Green exit because `MAIL_SMTP_*` is provider-agnostic. |
| 2026-09-21 | **WAHA audited — two of three exposures WITHDRAWN, the third sharpened.** It runs **Core**, licensed **Apache-2.0** (verified upstream), with no licence key and no resale restriction — so the "paid tier" and "licence" legs were wrong. The **Meta ToS / unofficial-client** leg stands, and the register's claimed fallback turns out **not to be one: the Cloud API cannot attach to human-created groups or manage participants at all.** Red unchanged, reason corrected. ⏰ Meta begins charging for service messages **2026-10-01**. |
| 2026-09-21 | **n8n row SPLIT after audit** ([`../assessment/2026-09-21-agentic-native-n8n-audit.md`](../assessment/2026-09-21-agentic-native-n8n-audit.md)). The agentic-native bar holds for 17 of 21 flows and **has silently slipped for the 4 WS11 pipeline flows**, whose logic exists nowhere else (`pipeline-delivery.json` = 64-node state machine). Plus a **hard dependency with no fallback** at `meetings.controller.ts:508`. Red count 3 → 4; the row's honest cost goes 2–6 weeks → **2–3 months**. No Enterprise feature in use — licence compliance verified. |
| 2026-09-21 | **Two new findings from the sweep, both now rows above:** ① the GitHub row splits — CI/registry is Amber, **cosign-keyless + build-provenance is Red** (GitHub-OIDC-bound, no Forgejo equivalent); ② `fedirz/faster-whisper-server` is **archived upstream**, last built Jan 2025 — digest-pinned, but that is a freeze, not maintenance. **Abandonment is a distinct risk axis this register did not originally model.** |
| 2026-10-11 | **Analytics and geo rows added (M5-G4/M5-V1):** Umami 3.x (🟢), DB-IP Lite (🟢), IP-to-company candidate (🟡, not chosen). Review in [`../plans/2026-10-11-m5-geo-and-company-data-review.md`](../plans/2026-10-11-m5-geo-and-company-data-review.md). Nothing drilled. |
| 2026-10-12 | **PV-5 provider rows added (PV5-03):** certified e-signature VIDA (🟡, custody exit) and payment gateway Midtrans (🟡), runners-up Privy and DOKU. Owner ruling PV-D25 the same day: Midtrans approved; VIDA approved but parked until the certified tier is first needed. Comparison in [`pv5-provider-comparison.md`](./pv5-provider-comparison.md). Nothing drilled. |
| 2026-10-13 | **Session replay rows added (M5-V6-c):** rrweb (🟡, the event format is the lock; PLANNED until the site recorder ships) and rrweb-player (🟢, 2.1.6 pinned, in platform-ui; IN PROGRESS). Both MIT, no seat. Addendum v0.2 §8.2. Nothing drilled. |
