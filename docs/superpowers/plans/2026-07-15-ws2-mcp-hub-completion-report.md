# WS2 — MCP Hub completion report

**Date:** 2026-07-15
**Spec:** `../specs/2026-07-04-ws2-mcp-hub.md`
**Status:** COMPLETE to spec, including the target-state items (mTLS, site/central, Cerbos).

## What was already there (pre-2026-07-15)

The hub had moved well past the "skeleton" its README claimed: MCP server (official SDK,
Streamable HTTP, stateless), OBO principal minting, deny-by-default in-code policy with
per-principal visibility + per-call authz + JSONL audit, platform read/write tools with the D14
impact taxonomy, per-workflow automation scoping + the write-suspend gate, the admin console
backend (`/api/admin/hub/{status,config,tools}`) + UI, and full compose wiring.

## What this change added (by spec section)

### §6 — primitive & tool completeness (hub)
- **Missing core tools:** `projects.get`, `tasks.get`, `clients.list/get`, `deliverables.list/get`,
  `time.list`, `activity.feed` (reads); `clients.create/update`, `deliverables.create/update`,
  `time.log/update` (writes, impact `low`). Two platform single-GET routes were added to
  `platform-nest/src/core/client-work.controller.ts` (`clients/:id`, `deliverables/:id`).
- **AI tools split:** `ocr.extract`, `vision.describe`, `media.transcribe` as named dispatchers over
  the Gateway `/media` path; `media.extract` kept as the general alias. `image.enhance` (Magnific)
  is registered but fails closed — the Go Gateway exposes no enhance capability yet.
- **MCP Resources** (`resources.ts`, `hub.ts`): `gaiada://<tenant>/<kind>[/<id>]` templates for
  project/task/client/activity, per-principal gated, fronting the same platform reads.
- **MCP Prompts** (`prompts.ts`): `summarize-project-status`, `draft-standup-digest`,
  `draft-client-update`.

### §2/§6 — ModuleContract.mcpTools aggregation
- `McpToolDef` (`platform-nest/src/modules/contract.ts`) gained an HTTP mapping
  (`method`, `pathTemplate`, `write`, `impact`); the agency module's defs now carry it.
- New service-authed `GET /mcp/tool-defs` (`modules/mcp-tools.controller.ts`) returns the union of
  compiled-in modules' tool defs.
- Hub `module-tools.ts` fetches it at boot and registers a generic platform-front handler per def
  (path-param substitution + OBO envelope); the hardcoded agency tool was removed. Fail-soft.

### §5 — Cerbos authoritative policy
- Versioned `cerbos/policies/resource_mcp_tool.yaml` encodes exactly the in-code decisions
  (assurance rank, automation scope, LOW-only unattended writes).
- Hub `cerbos.ts` + `policy.ts` async `visibleToolsFor`/`authorizeCall`: when `CERBOS_URL` is set,
  Cerbos decides allow/deny (one batched CheckResources for the list); the in-code engine remains
  the fail-closed fallback AND the human-readable deny/**suspend** reason source (WS4 depends on the
  suspend reason). Call sites in `hub.ts` switched to the async variants.

### §8 / D11 — rate limiting + revocation
- `ratelimit.ts`: token bucket per principal + a 10× per-service-token ceiling; 429 + audit on
  breach. In-memory (Redis is the multi-instance target-state).
- `revocation.ts`: every request re-checks the caller isn't a revoked identity via the platform's
  `POST /principal/resolve`, cached per principal (fail-open on transport error, fail-closed on an
  explicit `revoked:true`). The platform's resolve now returns a **`revoked` flag** — true when a
  VERIFIED link's user was deactivated/deleted (distinct from an unknown identity). This closes the
  gap for gateway-backed tools that never re-hit the platform.

### §3 — mTLS / zero-trust floor
- `tls.ts` + `server.ts`: `HUB_TLS_MODE=off|permissive|enforced`. Enforced serves `/mcp` over HTTPS
  requiring a CA-signed client cert whose CN is on the peer allowlist (mirror of the gateway's
  `verify.go`). `/health` and `/tools` stay reachable certless for probes. Certs are minted from the
  shared internal CA the gateway persists, via the existing `synccert` tool — no new PKI.

### §2/§7 — site/central topology
- `HUB_TOPOLOGY=site|central`. `rollup.metrics` is now real on **central** (fronts the platform's
  D12 cross-company `/rollups` read — the single sanctioned cross-company path; verified-only) and
  returns a clear note on a site hub. Compose gains an idle `mcp-hub-central` (profile `central`).

### Cleanup
- `mcp-hub/README.md` rewritten; `mcp-hub/.env.example` completed (was missing PLATFORM_*/KNOWLEDGE_*
  and all the new vars); compose env + volume; UI `HubTool` + hub console gained write/impact columns;
  `CLAUDE.md` bullet updated.

## D16 (PlanResources) — verification, not new build

`planResources` is implemented and tested in `platform-nest/src/rbac/cerbos.ts` /
`cerbos.test.ts`. The set-returning list routes the hub fronts (`projects.list`, `tasks.list`,
`clients.list`, `deliverables.list`, `activity.feed`) achieve O(1) list-authz via a **single
collection-level `authorize` check plus the RLS tenant-predicate pushdown** (`withTenants` binds the
authorized tenant set) — that IS the "predicate pushed into SQL" the spec calls for, not N per-row
checks. No fix required; the hub only fronts these routes.

## Tests

59 hub tests (`mcp-hub/src/*.test.ts`): tools, primitives (resources/prompts), module aggregation,
Cerbos parity + fail-closed fallback, rate limit, revocation, mTLS peer check, topology — all green;
`tsc --noEmit` clean. Platform: `mcp-tools.controller.test.ts` (aggregation) green; `tsc` clean.

## Still deferred (explicit)

- OpenBao-minted short-lived service credentials (target-state; static token + documented rotation
  for v1).
- Magnific `image.enhance` — awaits a Gateway enhance capability.
- Redis-backed rate limiting for multi-instance deployments.
- Central-hub fan-out to site hubs (v1 central reads the central platform directly; spec §9 open item).

## Live verification (run when the stack is up)

With `platform-nest` + `ai-gateway-go` + Cerbos + Ollama running, connect a real MCP client
(`claude mcp add`, see README) and confirm: per-principal tool/resource/prompt listing, a medium
write suspends, an out-of-scope automation workflow is denied, rate limiting trips a 429, a revoked
identity gets 403, and (with certs enrolled + `HUB_TLS_MODE=enforced`) a non-allowlisted peer is
refused while an enrolled one succeeds. The admin console (`/systems/hub`) shows the aggregated
tools with write/impact columns.
