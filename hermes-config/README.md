# hermes-config — Zedano's brain, under version control

**Status: PLANNED (scaffold).** Created 2026-08-23 from a sudo inventory of the live
`/opt/hermes-zen` on `gda-aicenter`. Nothing here deploys yet.

This component exists to close a standing gap: **Hermes' own configuration, persona and skills lived
only as hand-edited files on one box**, with `.bak` files as the change history — while every other
component in this estate ships by tag. That violates the program rule that *a hand-applied infra
change has a maximum lifetime of one deploy*.

Plans: `docs/superpowers/plans/2026-08-22-hermes-runtime-plan.md` (the Hermes side) ·
`docs/superpowers/plans/2026-08-22-hermes-PROGRESS.md` (tracker — item **H2**).

---

## What lives on the box (verified 2026-08-23)

`HERMES_HOME=/opt/hermes-zen`, `azlan:azlan`, `0700`.

| Path | What | Versioned here? |
|---|---|---|
| `config.yaml` | 517 B — model provider + MCP hub wiring | ✅ `config.yaml.tmpl` |
| `SOUL.md` | 554 B — the persona | ✅ `SOUL.md` |
| `skills/` | 13 **stock** vendor skills | 📋 documented in `skills/README.md`, not vendored |
| `hooks/`, `cron/` | **empty** — features unused | — |
| `bin/tirith` | vendor binary | — |
| `.env`, `auth.json` | **secrets — never leave the box** | ❌ by design |
| `sessions/` (636 MB), `state.db` (221 MB) | conversation history + agent state | ❌ data, not config |
| `memories/` | **empty** | — |
| `models_dev_cache.json`, `*_cache/` | regenerable caches | ❌ |
| `logs/` | `agent.log` + rotations | ❌ |

## Non-negotiables

- **No secrets in this directory, ever.** `config.yaml.tmpl` references `${GAIADA_HUB_TOKEN}` by name.
  The live `config.yaml` already does this correctly — the file is safe to version as-is.
- **Approvals stay ON.** `--yolo` is never the default. Autonomy comes from the risk ladder enforced
  in `mcp-hub`, where it is auditable — never from a flag on the agent's own command line.
- **The MCP entry is generated, not hand-written.** It is the single wire that gives Hermes its tool
  surface; hand-editing it on the box is how the tool view silently drifts from `agent_registry`.
- **`SOUL.md` is not a second persona definition.** When the persona program lands, Zedano's soul is
  *the same artifact* as the router seat's persona pack. One source, two consumers — this estate has
  already paid for mirrors that drift.

## Deploying (PLANNED — not wired)

Target: render `config.yaml.tmpl` → `/opt/hermes-zen/config.yaml` with env substitution, ship by tag
like every other component, and keep `.env`/`auth.json` untouched on the box.

**Rollback:** the box currently keeps `.bak` files by hand (`config.yaml.bak-preGaiadaMCP`,
`.bak-preDeepseekSwitch`, `.gemini.bak`, `.bak-20260730-deepseek`). Once this component deploys, that
practice **stops** — rollback becomes redeploying the previous tag, and the stray `.bak` files should
be removed so there is exactly one source of truth.

## Known issues this component should fix

1. **Stock, irrelevant skills.** `apple` and `smart-home` have no place in an ERP seat. See
   `skills/README.md`.
2. **41 KB of skill prompt per call** (`.skills_prompt_snapshot.json`) — context pollution and token
   cost on every request, mostly for skills the seat will never use.
3. **Full plugin discovery on every invocation** — `agent.log` shows *54 found, 47 enabled* per run,
   ~25 providers re-registered each time, because the shim spawns a fresh process per request. This is
   why a 4-character reply cost 6.5–11 s: **cold start, not inference.** Any warm-router design must
   avoid inheriting this.
4. **A stale `.mcp-discovery.lock` can wedge the agent indefinitely.** A zero-byte lock created
   2026-08-22 07:17 silently killed every subsequent invocation for 24 h+; `agent.log` ended on a
   clean discovery line with no error. Whatever supervises Hermes needs a liveness check that would
   catch this — see the tracker's B16, since the synthetic prober could not.
