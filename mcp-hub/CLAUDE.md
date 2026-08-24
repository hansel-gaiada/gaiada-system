# CLAUDE.md — mcp-hub

Scope: `mcp-hub/` — the **MCP server**: the single tool surface through which agents, n8n and
external MCP clients reach the platform. Official MCP SDK, Streamable HTTP, stateless. Root
`../CLAUDE.md` has program rules.

```
npm ci && npm run typecheck && npm test     # vitest
npm run dev / npm start
```

## The principal model is the whole point

Clients **cannot assert roles**. The hub mints an **OBO principal** from the caller's named
service identity (`x-obo-provider`, `x-obo-external-id`) by resolving it against the platform
(`POST /principal/resolve`, which also returns a **`revoked` flag** — D11 revocation is
authoritative and checked here, not cached optimistically). Policy is **deny-by-default**.

- **Cerbos is authoritative** (versioned `mcp_tool` policy). `policy.ts`'s in-code engine is a
  **fail-closed fallback and the reason source** — not a second authority. Keep them aligned;
  `cerbos.test.ts` is the guard.
- **Cerbos does not hot-reload.** After a policy edit, restart it and prove the new decision with
  a probe. A healthy container has served two-day-stale policy.
- Every decision writes a JSONL audit line. That trail is the reason automation gets least
  privilege at all — don't add a path that bypasses it.

## Tools are aggregated, never hardcoded

The tool list comes from the platform's `ModuleContract.mcpTools` via **`GET /mcp/tool-defs`**.
Adding a tool means adding it to its module in `platform-nest`, not to a list here. Local
files (`platform-tools`, `platform-write-tools`, `pm-tools`, `delivery-tools`, `pipeline-tools`,
`work-activity-tools`, `module-tools`) are the *dispatchers* for those defs. Full primitive
surface: **Tools · Resources (`gaiada://…`) · Prompts**.

## Arguments are validated against the advertised schema

`hub.ts` holds the **only** invocation of a tool handler, and `validate-args.ts` gates it: a call is
checked against the tool's own `inputSchema` (`type · properties · required · enum · items ·
default`) before dispatch. A tool added later — including one aggregated from a module, which no
hub-side code ever sees — is covered because it declared a schema, not because anyone added a check.

- Until 2026-08-24 nothing enforced `required`. An omitted argument became the literal string
  `"undefined"` in a platform URL (`GET /api/undefined/projects`) and died as a 500 at a uuid cast.
  Read tools wasted a round trip; write tools carried it into a mutation.
- Validation runs **after** authorization (so a denied caller learns nothing about arguments) and
  **after** the D14-04 grant check (`argsSha256` binds the RAW args the approval was filed from —
  hashing the validated ones would fail every legitimate re-drive with `args_mismatch`).
- A rejection audits as `allow` + `ok:false` + `reason`. It is not a policy denial; keep
  `decision:"deny"` meaning "policy refused" and nothing else.
- `"5"`→`5` and `"true"`→`true` are coerced (lossless, and it is what LLM clients actually send);
  `5`→`"5"` is not.

## Two gates every write passes

1. **Workflow scoping** (`automation-policy.ts`) — each n8n workflow is least-privilege by its
   `wf:<name>` id, mapped to the exact tool names it may call. Deny-by-default: **a new workflow
   can call nothing until its allow-list entry is added**, and the refusal reads
   `workflow wf:<x> is not scoped for <tool>`.
2. **The D14 write gate** (`policy.ts`) — an unattended automation run may execute **low-impact
   writes only**. `medium`/`high`, *or any write tool that declares no impact tier*, is refused
   with a `suspend: … requires human approval` reason and surfaces as a pending approval.
   Unclassified = refused is deliberate; classify the tool rather than widening the gate.

**D14 approval semantics:** approving an approval **executes** it — as the *original* principal,
and only for **registry-listed** tools. `approval-grant.ts` + `approval-grant.replay.test.ts`
pin the single-use / replay behaviour. Every automation principal is minted `assurance: "low"`;
`assurance.ts` is where a `verified` assurance can be minted.

## Also here

Rate limiting (§8; in-process — Redis-backed multi-instance is deferred), `HUB_TLS_MODE` mTLS
floor reusing the gateway's persisted internal CA via `synccert` with a peer-CN allowlist, and
`HUB_TOPOLOGY` site/central (real `rollup.metrics` over D12 on central).

Deferred by decision: OpenBao-minted short-lived service creds, Magnific `image.enhance` (no
Gateway capability yet), Redis-backed rate limiting.

**Adding an MCP server to Hermes' own config is a hand edit** to its `config.yaml` — nothing
generates that entry.
