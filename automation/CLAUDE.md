# CLAUDE.md — automation (WS4)

Scope: `automation/` — self-hosted **n8n** compose plus the versioned workflow JSON. Root
`../CLAUDE.md` has program rules. **`README.md` here is the authoritative design doc** (the
backbone rule, scoped service accounts, the D14 write gate) — read it; this file adds only the
operational traps that live outside it.

## The backbone rule, in one line

**n8n = orchestration · MCP = access · custom services = logic.** Workflows hold no business logic
and touch no database. Every action is an mcp-hub tool call carrying `x-obo-provider: n8n` +
`x-obo-external-id: wf:<workflow>`, so it lands in the hub audit trail with least privilege.

**Adding a workflow means adding its `wf:<name>` entry to the hub's `automation-policy.ts`
allow-list** — otherwise every call is denied with `workflow wf:<x> is not scoped for <tool>`.
And the hub's D14 gate lets an unattended run perform **low-impact writes only**; anything
`medium`/`high` — or unclassified — suspends into a human approval.

## 🔴 Import with the CLI, never the public API

The workflow JSONs **declare their own `id`** (`ws11fanout000001`, `wswdprovision0001`, …) and
sub-workflow references depend on that exact string — `pipeline-delivery.json` points its Execute
Workflow node at `wswdprovision0001`.

`POST /api/v1/workflows` treats `id` as **read-only**: it either 400s (`request/body/id is
read-only`) or, once you strip the fields it rejects, returns **200 with a random id** — leaving a
dead Execute-Workflow reference behind an import that "succeeded". `n8n import:workflow` preserves
the declared id. `workflows/` is **not mounted** into the container, so:

```sh
docker cp automation/workflows/<f>.json gaiada-automation-n8n-1:/tmp/<f>.json
MSYS_NO_PATHCONV=1 docker exec gaiada-automation-n8n-1 n8n import:workflow --input=/tmp/<f>.json
```

`MSYS_NO_PATHCONV=1` is required under Git Bash or `/tmp/x.json` is rewritten to a Windows path.
**Afterwards, verify the landed id is the declared one** — that check is the whole point.

## Other realities

- The console is exposed at `/n8n/` behind basic auth. `N8N_PATH` is only half-honoured; the
  prefix-stripping nginx vhost is what actually makes the path work (see `../infra/CLAUDE.md`).
- Temporal is deliberately absent until a genuinely durable multi-step flow exists (spec §4).
- `generators/gen-delivery.mjs` generates delivery workflow variants into `workflows/` —
  regenerate rather than hand-editing the generated output.
- Workflow JSON is source. A change made in the n8n UI exists only in the container volume until
  it is exported back into `workflows/`.
