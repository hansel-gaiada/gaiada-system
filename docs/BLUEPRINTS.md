# Gaiada — Blueprints Index

Rendered, printable engineering blueprints for the program. These are the C-level / team-roadmap
documents; the running code (`README.md`, `CLAUDE.md`, the `docs/superpowers/` specs) remains the
source of truth for exact status.

> **Files (in-repo):** all three blueprints are committed under [`blueprints/`](./blueprints/) as **PDF**
> (print-ready, diagrams rendered) and **HTML** source:
> - `blueprints/GAIADA-WebDesk-Engineering-Blueprint.pdf` · `blueprints/webdesk-blueprint.html`
> - `blueprints/Gaiada-AI-Platform-System-Blueprint.pdf` · `blueprints/gaiada-blueprint.html`
> - `blueprints/GAIADA-Search-Marketing-Engineering-Blueprint.pdf` · `blueprints/search-marketing-blueprint.html`
>
> They are also hosted as artifacts (private until shared from the artifact's share menu; URLs below).
>
> **Regenerate the PDFs:** the HTML uses `<pre class="mermaid">` with no bundled JS (the artifact host
> renders Mermaid natively). To make PDFs, render through headless Chromium with Mermaid injected and
> diagrams scaled to fit the page — see `blueprints/render-pdf.js` (Playwright + `mermaid@10`,
> `useMaxWidth:false` + `svg{max-width:100%;max-height:225mm}` so nothing clips). Run from a dir with
> `mermaid` installed: `node render-pdf.js` (it renders all three files listed in the script's `files`
> array — add a new blueprint's `{in, out, foot}` entry there when one is added).

---

## 1. Gaiada AI Platform — System Blueprint

**Whole-system** blueprint: vision & operating model, master architecture, the WS0–WS11 + Compliance
workstream map, a service catalog (platform-nest, platform-ui, ai-gateway-go, mcp-hub, sync-engine-go,
ai-agents, wa-chat-bot, hermes-gateway, capture-helper, automation, observability, infra), data/tenancy/
sync, identity & zero-trust, the AI layer, automation & surfaces, security & resilience, observability &
delivery, deployment/infra, **how WebDesk fits (§12)**, and roadmap/status.

- **URL:** https://claude.ai/code/artifact/3a443c4b-15e0-45b2-8d28-0aa1f2cf7421
- **Version:** v1.0 · 2026-07-23
- **Print:** A4/Letter, page-breaks per section.

## 2. GAIADA WebDesk — Engineering Blueprint

**Website-platform** blueprint (Web Dev): the centralized, multi-tenant client-website backend
(Payload headless CMS + forms + mail + control-plane). Covers trust zones & network, deployment
topology, component specs, data model & tenancy, the content vocabulary/composition/codegen model,
the contract pipeline, key flows (provisioning, form submit, staging→live promotion), security
architecture, environments & promotion, observability/ops, and the phased roadmap with sample tickets.

- **URL:** https://claude.ai/code/artifact/9ccdc040-9886-4c1d-a7ca-c052ca16a731
- **Version:** v1.2 · 2026-07-23, amended 2026-08-04 twice (v1.1: C-02/C-03 mail — Hostinger
  unpinned → rented relay; three sending identities + per-stream keys; `From:` ours / `Reply-To:`
  human default; Zone A mail explicitly does NOT route through C-03; new decision D14. v1.2, same
  day: Zone A mail design went to v2 — domains locked, C-03's forms stream pinned to
  `forms.gaiada.online` on Brevo, deliberately off the `gaiada.com` employee-mail domain; Zone A
  `notify.`/`auth.gaiada.com` moved to the Google Workspace SMTP relay with Brevo failover — see
  [`superpowers/specs/2026-08-04-zone-a-mail-design.md`](./superpowers/specs/2026-08-04-zone-a-mail-design.md),
  since revised to **v3** the same day: the Zone A dev stage now runs against a Mailpit sink with
  all real-provider work moved to a Staging Reopen Register — Zone B scope unaffected, the
  `forms.gaiada.online` identity simply activates at that reopen).
  ⚠️ HTML only — the committed PDF and the hosted artifact still show v1.0.
- **Print:** A4/Letter, page-breaks per part.
- **Downstream docs:** [`blueprints/webdesk-design.md`](./blueprints/webdesk-design.md) (v1.0,
  2026-08-07 — the /army-ready design + 36-ticket program) ·
  [`blueprints/webdesk-design-reassessment.md`](./blueprints/webdesk-design-reassessment.md)
  (v1.0, 2026-08-26 — industry-standard reassessment; **R-1 and R-2 ruled**, R-3/R-4/R-5 open.
  Its amendments apply to the design doc as a pending v1.1 revision).

## 3. GAIADA Search-Marketing — Engineering Blueprint

**Search-marketing** blueprint (SEO department): SEO, SEM, and GEO/AEO as one `platform-nest` module
vertical (`search`) plus a department console — not adopted external apps. Leads with the foundation
research and the **locked provider/cost model** (DataForSEO Standard primary + Semrush premium behind
a pluggable abstraction, self-hosted crawlers, local-Hermes-first AI, ~$8–10/client/mo blended), then
covers scope & pillars, system overview, trust zones, the domain model & schema (incl. the dual-mode
`search_change_proposals` execution artifact), the data-provider abstraction & cost ledger, the
fork/adapt verdicts per OSS repo, AI design (task→model routing + the AI-drafts→human-approves→execute
spine), the console UX **button capability matrix**, ERP integration points, automation flows, trust &
security, the full **P0–P4 ticket decomposition** (26 tickets + 2 committed P4, /army-ready), and the
open questions & decision log.

- **URL:** https://claude.ai/code/artifact/631b6c12-cb1f-40bd-9a88-f0e91bfa751e
- **Version:** v1.1 · 2026-07-23
- **Print:** A4/Letter, page-breaks per section (28 pages).

## 4. GAIADA Social Media — Engineering Blueprint

**Social-media** blueprint (Social Media department): organic publishing, engagement, copywriting, and
digital-asset creation as one `platform-nest` module vertical (`social`) plus the **Publish** department
console (Calendar · Composer · Inbox · Analytics) — not an adopted external app. Its two defining hazards
frame the design: **public irreversibility** (a bad post ships to the world) and a **license boundary**
(the AGPL publisher must never infect the platform). Covers scope & pillars (v1 = organic; paid/listening/
influencer parked), system overview, trust zones & **AGPL containment** (Postiz runs as an isolated
REST-only engine; drafts never enter it; it sees a post only after WS4 approval), the domain model & schema
(`social_*` — master posts + per-network variants, connector registry, inbox threads, usage ledger), the
publisher boundary & cost ledger (X per-post fees + generative credits, stop-loss chain), the fork/adapt
plan (thin-fork invariants + Mixpost-Pro tripwires), AI design (task→model routing + brand-voice RAG + MCP
tools), the console **button capability matrix**, ERP integration, automation flows, security (wrong-account
defence in depth), the full **P0–P4 ticket decomposition** (27 tickets + 2 decision-gated, /army-ready), and
the open questions & decision log.

- **Design doc:** [`blueprints/smm-design.md`](./blueprints/smm-design.md) · **Foundation:** [`blueprints/smm-foundation.md`](./blueprints/smm-foundation.md)
- **⚠ Addendum (BINDING, read first):** [`blueprints/smm-design-addendum-2026-08-12.md`](./blueprints/smm-design-addendum-2026-08-12.md) — re-bases the design onto the current platform (permissions-as-data, the closed D14 execute contract, the agentic-native bar, no image-gen backend, the live client portal, migrations `0105+`) and re-plans §12 into 30 tickets + 3 decision-gated.
- **Version:** v1.0 · 2026-07-23 (+ addendum 2026-08-12)
- **Print:** A4/Letter, page-breaks per section. (Not yet hosted as a claude.ai artifact.)

---

## Relationship (Zone A ↔ Zone B)

The **Gaiada AI Platform** (Zone A) is the internal brain and control plane. **WebDesk** (Zone B) is
an internet-facing execution zone it commands one-way (Keycloak client-credentials + mTLS); WebDesk
reports back only via signed webhooks into the n8n event bridge. Client websites touch **only** Zone B,
so a Zone B compromise can never reach company data. WebDesk reuses Keycloak, the MCP Hub, WS4 approvals,
the Cerbos/RLS pattern, the n8n bridge, WS9 observability, and the WS10 delivery pipeline.

See §12 of the System Blueprint and the full WebDesk blueprint above.

## Module status & versions

The blueprints **summarize** status; the authoritative, git-tracked source is
[`modules/MODULES.md`](./modules/MODULES.md) (per-module version, status, future plans) and
[`modules/CHANGELOG.md`](./modules/CHANGELOG.md) (per-module change history + module-addition log).

**Status vocabulary** (nothing here is production-finished): `PLANNED` · `IN PROGRESS` ·
`PROTOTYPED` (works in dev, not production) · `DEV-VERIFIED` (prototyped + e2e on the local stack).
We deliberately avoid "built/done/complete". Bump a module's version + add a changelog entry on every
notable change.
