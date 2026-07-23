# Gaiada — Blueprints Index

Rendered, printable engineering blueprints for the program. These are the C-level / team-roadmap
documents; the running code (`README.md`, `CLAUDE.md`, the `docs/superpowers/` specs) remains the
source of truth for exact status.

> **Files (in-repo):** both blueprints are committed under [`blueprints/`](./blueprints/) as **PDF**
> (print-ready, diagrams rendered) and **HTML** source:
> - `blueprints/GAIADA-WebDesk-Engineering-Blueprint.pdf` · `blueprints/webdesk-blueprint.html`
> - `blueprints/Gaiada-AI-Platform-System-Blueprint.pdf` · `blueprints/gaiada-blueprint.html`
>
> They are also hosted as artifacts (private until shared from the artifact's share menu; URLs below).
>
> **Regenerate the PDFs:** the HTML uses `<pre class="mermaid">` with no bundled JS (the artifact host
> renders Mermaid natively). To make PDFs, render through headless Chromium with Mermaid injected and
> diagrams scaled to fit the page — see `blueprints/render-pdf.js` (Playwright + `mermaid@10`,
> `useMaxWidth:false` + `svg{max-width:100%;max-height:225mm}` so nothing clips). Run from a dir with
> `mermaid` installed: `node render-pdf.js`.

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
- **Version:** v1.0 · 2026-07-23
- **Print:** A4/Letter, page-breaks per part.

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
