# Automation & Orchestration — WS4

**Status: v1 glue built** — self-hosted N8N + a template workflow that calls the MCP hub.
Temporal is deliberately absent until a genuinely durable multi-step flow exists (spec §4).

**Spec:** `../docs/superpowers/specs/2026-07-05-ws4-automation-orchestration.md`

## The backbone rule (non-negotiable)

**N8N = orchestration · MCP = access · custom services = logic.**
Workflows here hold no business logic and touch no database — every action is an
**mcp-hub tool call** carrying a named service identity (`x-obo-provider: n8n`,
`x-obo-external-id: wf:<workflow>`), so every automation action lands in the hub's audit
trail with least-privilege visibility (the hub's policy decides what n8n may call).

## Run

```bash
cp .env.example .env       # set N8N_PASSWORD
docker compose up -d       # http://localhost:5678 (localhost-bound; tunnel in remotely)
```

## Template workflow

`workflows/summarize-via-mcp.json` — import it in the n8n UI, replace
`REPLACE_WITH_HUB_SERVICE_TOKEN`, activate. It exposes `POST /webhook/summarize {"text": ...}`
→ calls the hub's `llm.summarize` (raw JSON-RPC `tools/call`; the hub is stateless so no
handshake is needed — responses come SSE-framed, parsed by the Code node) → returns the
summary. Use it as the copy-paste pattern for future glue ("on X → call MCP tool → notify").

Note: when n8n runs on the same Docker network as the VPS stack, `http://mcp-hub:3003` resolves;
running it standalone next to a locally-started hub, use `http://host.docker.internal:3003`.

## What comes later (spec §1/§4)

Temporal for durable flows (first candidate: multi-step agent goals / reconciliation, P4+),
event-backbone triggers, per-workflow scoped service accounts minted by the platform's RBAC.
