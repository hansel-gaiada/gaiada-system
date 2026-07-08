# Gaiada Agent Platform — WS8 (steps 1–3 built)

Specialist-agent framework: models via the **AI Gateway**, tools via the **MCP hub** with the
requesting user's OBO envelope — an agent can never act with more authority than the human it
serves, and this process holds no provider keys and no database access, by construction.

**Spec:** `../docs/superpowers/specs/2026-07-04-ws8-ai-native-agent-platform.md`
**Status:** build-sequence **steps 1–3** done (specialists + orchestrator + knowledge/memory
platform). Local-model registry and the eval-gated trainer come next.

## Knowledge & memory platform (WS8 §3-4, D9 — this package is the SOLE owner)

`src/knowledge/` — store + HTTP service (`:3005`). D9 enforced and tested:
**retrieval-time authorization** (tenant + ACL as a hard SQL pre-filter BEFORE similarity
ranking — a cross-tenant chunk is never a candidate; the caller's tenant set comes from the
platform-resolved OBO envelope, so unverified identities get zero results);
**source-driven lifecycle** (re-ingest replaces, erase hard-deletes — crypto-shred reaches
this derived store); **memory integrity** (provenance + trust + confidence on every row;
untrusted content quarantined and never retrieved; agent-written facts down-weighted).
Embeddings via the Gateway's `/embed` (local-first ollama → gemini → offline hash).
The MCP hub's `knowledge.search` is a thin wrapper over this service.

## Orchestrator (WS8 §2.2)

`supervisor` plans a goal, routes subtasks to specialists, and aggregates from a shared
**blackboard**. Brigade bounds enforced in code, not trusted to the model: per-goal budget
across the whole tree (two-tier with the Gateway's daily cap), fan-out cap, cycle guard
(identical subtasks never re-run), specialist failures become blackboard data the planner
must handle, and a `high_write` approval suspension bubbles up and suspends the entire goal.

```bash
npm run run-agent -- supervisor "Morning briefing for tenant <uuid>" telegram tg:555
```

## D14 action safety — enforced by the runner, tested

- **Allow-list**: an agent may only call the tools its definition names; anything else is a
  typed refusal and the run stops.
- **Impact taxonomy** on every allow-listed tool (`read` / `low_write` / `high_write`);
  `high_write` suspends for human approval — the tool is **never executed**.
- **Per-run budgets** (model steps + tool calls); exhaustion raises a **typed error carrying
  the transcript** — never a committed placeholder answer.
- Tool failures are fed back to the model as failures, not swallowed as facts.

## Specialists today (all read-only — write agents wait for the D13 eval/tool-contract gates)

- **status-reporter** — projects + tasks → factual status report.
- **approvals-chaser** — pending agency approvals → nudge list.

## Run one (needs ai-gateway + mcp-hub + platform up)

```bash
npm install
cp .env.example .env   # GATEWAY_TOKEN + HUB_SERVICE_TOKEN
npm run run-agent -- status-reporter "Status report for tenant <uuid>" telegram tg:555
```

The envelope (`telegram tg:555`) decides what the agent may see: an unlinked identity gets
denials from the platform and the agent reports that it couldn't access the data.
