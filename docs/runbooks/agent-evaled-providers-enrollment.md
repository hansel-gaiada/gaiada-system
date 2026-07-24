# Agent Evaluated Providers Enrollment Runbook

**Purpose.** Enable write-capable agents (like `task-triager`) to execute actions on external systems
via the MCP Hub. This runbook documents the gating mechanism and the enrollment process.

---

## Background

Agents have two execution modes:

| Mode | `evaledProviders` | Behavior | Use Case |
|---|---|---|---|
| **Read-only** | `[]` (default) | Agent can read data, ask questions, propose actions. Writes are declined with `forced_read_only` status. | Safe default; human reviews every action |
| **Write-enabled** | `['provider-key']` | Agent can execute approved actions; must still pass D14 approval gates. | Trusted workflows where human review happens earlier (e.g., approvals-chaser) |

The **default is always read-only**. This is intentional: it forces humans into every action loop until you explicitly enroll a provider.

---

## When to enroll a provider

Enroll when:
- You have a **tested, stable agent** (e.g., `task-triager`) that you want to run autonomously
- The **external system is ready** to receive actions (API stable, rate limits known, secrets rotated)
- You have **evaluated agent safety** against real data in your environment
- You understand that **D14 approvals still apply** — enrollment only flips read-only off; approval gates stay locked

**Do NOT enroll** if:
- The agent is experimental or the provider API is unstable
- You want the agent to fail-safe on unknown errors (it will, but writes won't happen)

---

## Enrollment process

### 1. Run the evaluation suite

The ai-agents package includes an eval suite that exercises the agent against your chosen
provider. Build a test scenario in your environment:

```bash
# From ai-agents/ directory
npm test -- --testNamePattern="eval.*<agent-name>.*<provider>"
# Example: npm test -- --testNamePattern="eval.*task-triager.*gemini"
```

The suite exercises:
- Basic goal execution (read path)
- Tool availability against the provider's schema
- Error handling (provider errors, rate limits, auth failures)
- Budget constraints (max tokens, max tool calls)

**Goal:** 100% green, no timeouts, no schema mismatches.

### 2. Run the tool-contract check

After the suite passes, verify that every tool the agent might call is:
- Registered in the MCP Hub's tool catalog
- Authorized for the agent's principal/scope (Cerbos gated)
- Callable with the provider's envelope (OBO identity, tenant scoping)

```bash
# In platform-nest or the MCP Hub repo
npm run test -- --testNamePattern="tool.*contract.*<agent-name>"
# Example: npm run test -- --testNamePattern="tool.*contract.*task-triager"
```

This check is security-critical — it prevents tool-call injection or scope escapes.

### 3. Update the agent's configuration

Once both the eval suite and tool contract are green:

1. **Locate the agent definition** (in `ai-agents/src/agents/` or the registry):
   ```ts
   // Example: ai-agents/src/agents/task-triager.ts
   export const taskTriager = {
     name: 'task-triager',
     model: 'default',
     evaledProviders: [],  // ← Change this
     // ... other config
   };
   ```

2. **Add the provider key** to the `evaledProviders` list:
   ```ts
   evaledProviders: ['gemini'],  // Now the agent CAN execute writes on Gemini
   ```

3. **Document the decision** in the commit message:
   ```
   agents: enroll gemini on task-triager (eval suite + tool-contract green)
   
   - Evaluated against task-triager specialist (10 test scenarios)
   - Tool-contract check passed (all write tools callable under task principal)
   - D14 approvals still required; writes will not auto-execute
   - Revert to evaledProviders=[] if provider becomes unstable
   ```

### 4. Redeploy

Push the change to your deployment:

```bash
cd ai-agents
git commit -m "agents: enroll <provider> on <agent>"
git push origin main

# Then in your deployment env, rebuild the agent-runner container:
docker compose --file infra/compose/docker-compose.vps.yml build agent-runner
docker compose --file infra/compose/docker-compose.vps.yml up -d agent-runner
```

Verify the new config is live:
```bash
curl -s http://localhost:3006/health | jq '.writeAgents'
# Should include the agent name if evaledProviders is non-empty
```

---

## Verification checklist

After enrollment:

- [ ] Eval suite passed (agent can read and propose writes)
- [ ] Tool-contract check passed (all MCP calls are gated correctly)
- [ ] Agent config pushed and redeployed
- [ ] `/health` endpoint shows the agent in `writeAgents` list (if `evaledProviders` was `[]`)
- [ ] D14 approvals are still in place (test by submitting a goal — it should not auto-execute)
- [ ] Monitoring is in place (OTel metrics on goal outcomes, approval SLA alerts)

---

## Rollback

If a provider becomes unstable or you need to pause an agent's write capability:

```ts
// In ai-agents/src/agents/<agent>.ts
evaledProviders: [],  // Revert to read-only
```

Then redeploy. Existing in-flight goals will complete, but new goals will be read-only (`forced_read_only`).

---

## Safety notes

- **Approval gates stay locked.** Enrollment only removes the `forced_read_only` artificial gate; D14 and D11
  controls (per-tenant, per-user, per-action-type) remain the source of truth.
- **One provider at a time.** Enroll and stabilize each provider before adding the next. Mix-and-match
  multi-provider agents are future work (deferred from v1).
- **Monitor the approval queue.** If an agent's goal gets suspended, it creates an approval item —
  ops should not let those pile up. Use WS4's approvals inbox to decide/reject, or revert the enrollment
  if it's too noisy.
- **Never auto-resume.** Auto-resumption of suspended goals is deferred to the Temporal phase; for now,
  a human must re-trigger a cancelled/suspended goal manually from the ERP.

---

## Example: enrolling `task-triager` on Gemini

```bash
# 1. Run evals
cd ai-agents
npm test -- --testNamePattern="eval.*task-triager.*gemini"
# ✓ 15 tests pass

# 2. Check tool contract
npm run test -- --testNamePattern="tool.*contract.*task-triager"
# ✓ 8 tool-gating tests pass

# 3. Update config
vi src/agents/task-triager.ts
# Change: evaledProviders: []  →  evaledProviders: ['gemini']

# 4. Commit and push
git add src/agents/task-triager.ts
git commit -m "agents: enroll gemini on task-triager (eval suite + tool-contract green)"
git push origin main

# 5. Redeploy
docker compose --file infra/compose/docker-compose.vps.yml build agent-runner
docker compose --file infra/compose/docker-compose.vps.yml up -d agent-runner

# 6. Verify
curl -s http://localhost:3006/health | jq '.writeAgents'
# ["task-triager"]  ← agent now in the write list

# Now when a goal is submitted for task-triager, it can execute writes on Gemini
# (subject to D14 approval gate).
```
