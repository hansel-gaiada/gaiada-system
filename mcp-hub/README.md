# Gaiada MCP Hub — WS2

The one governed access layer exposing company tools/data to AI clients (bot, agents, n8n)
over the **Model Context Protocol** (official TypeScript SDK, Streamable HTTP, stateless).

Spec: `../docs/superpowers/specs/2026-07-04-ws2-mcp-hub.md`
Completion report: `../docs/superpowers/plans/2026-07-15-ws2-mcp-hub-completion-report.md`

**Status: complete to spec (incl. target-state).** The authorization spine, the full core +
module tool surface, MCP Resources & Prompts, Cerbos-authoritative policy, rate limiting, D11
revocation, the mTLS/zero-trust floor, and site/central topology are all built and tested.

## What it enforces

- **On-behalf-of (OBO, §5):** the calling service authenticates with a bearer token
  (fail-closed); the END USER arrives as an envelope (`x-obo-provider`, `x-obo-external-id`)
  and the **hub** mints the principal — a client has no field with which to assert a role or
  assurance. No envelope → anonymous minimal principal.
- **Deny-by-default policy:** tool visibility is filtered per principal (nothing is advertised
  that can't be called), and every call is authorized again. When `CERBOS_URL` is set, the
  versioned **`mcp_tool` Cerbos policy** is authoritative (batched CheckResources for the list,
  single check per call); the in-code engine (`policy.ts`) stays as the fail-closed fallback and
  the source of the human-readable deny/**suspend** reasons.
- **Automation least-privilege (WS4 §3 / D14):** an n8n workflow principal is scoped to its
  allow-list (`automation-policy.ts`); unattended runs perform LOW-impact writes only —
  medium/high/unclassified writes **suspend for human approval** via `approvals.request`.
- **Rate limiting (§8):** token bucket per principal + a coarser per-service-token ceiling (429).
- **D11 revocation (§5):** every request re-checks the caller isn't a revoked (verified-then-
  deactivated) identity via the platform's `POST /principal/resolve` (cached per principal) —
  this covers gateway-backed tools that otherwise never re-hit the platform.
- **mTLS / zero-trust floor (§3):** `HUB_TLS_MODE=enforced` serves `/mcp` over HTTPS requiring a
  client cert signed by the shared internal CA whose CN is on the peer allowlist.
- **Audit:** every call (allow / deny / rate-limit / revoked) appended to
  `data/tool-audit.jsonl` — principal, tool, decision, outcome; arguments are not recorded.

## Primitives (MCP §6)

- **Tools** — core, platform-fronting, AI-backed, and module-contributed (below).
- **Resources** — readable context (`gaiada://<tenant>/project/<id>`, `/clients`, `/activity`, …),
  per-principal gated, fronting the same platform reads.
- **Prompts** — reusable templates (`summarize-project-status`, `draft-standup-digest`,
  `draft-client-update`).

## Tools

- Probe/identity: `ping`, `whoami` (anonymous).
- AI-backed (via the Gateway — the hub holds no provider keys): `llm.summarize`, `ocr.extract`,
  `vision.describe`, `media.transcribe`, `media.extract`. `image.enhance` is registered but fails
  closed until the Gateway exposes an enhance capability.
- Platform reads: `projects.list/get`, `tasks.list/get`, `clients.list/get`, `deliverables.list/get`,
  `time.list`, `activity.feed`, `compliance.gates`, `knowledge.search/graph`.
- Platform writes (D14-tagged): `projects.create`, `tasks.create/update`, `clients.create/update`,
  `deliverables.create/update`, `time.log/update`, `notify`, `approvals.request`, `agent.feedback`,
  `authz.check` (non-mutating probe).
- Module-contributed: aggregated at boot from the platform's `ModuleContract.mcpTools` via
  `GET /mcp/tool-defs` (e.g. `agency.listCampaigns`, `agency.pendingApprovals`).
- Central-only: `rollup.metrics` — cross-company management rollups (verified principals; served
  only when `HUB_TOPOLOGY=central`, over the platform's D12 `/rollups` read).

## Connect from Claude Code (example client)

```bash
claude mcp add --transport http gaiada-hub http://localhost:3003/mcp \
  --header "Authorization: Bearer <HUB_SERVICE_TOKEN>" \
  --header "x-obo-provider: telegram" \
  --header "x-obo-external-id: <your-id>"
```

## Run

```bash
npm install
cp .env.example .env    # set HUB_SERVICE_TOKEN (+ PLATFORM_*/GATEWAY_*/CERBOS_URL as needed)
npm test
npm start               # MCP endpoint: POST /mcp on :3003
```

AI-backed tools require `../ai-gateway-go` running; platform-fronting tools/resources require
`../platform-nest`; module aggregation, D11 revocation, and Cerbos policy each light up when their
service is configured — all degrade fail-soft (the hub keeps its local tools and the in-code policy).

## Deployment (§7) & mTLS (§3)

- **Topology:** `HUB_TOPOLOGY=site` (default; fronts the local platform) or `central` (adds
  cross-company rollups). Compose defines an idle `mcp-hub-central` under the `central` profile.
- **mTLS:** mint certs from the CA the gateway persists (`data/ca-cert.pem`) with the `synccert`
  tool (`-cn mcp-hub` for the server; one per caller CN), mount them, set `HUB_TLS_MODE=enforced`.
  `/health` and `/tools` stay reachable for probes; `/mcp` requires an allowlisted peer.
- **Service token:** static shared secret in v1 — rotate on a schedule (short-lived minted creds
  are the OpenBao target-state, deferred).
