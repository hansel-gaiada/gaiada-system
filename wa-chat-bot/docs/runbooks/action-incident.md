# Runbook — Action Incident Response

Covers the bot's **mutating actions** (create/assign/complete tasks, create projects, group
admin). For chat-ban recovery see `wa-ban-recovery.md`; for data erasure see
`erasure-divestiture.md`.

## 0. The one lever: kill-switch

All mutating actions gate on a runtime kill-switch. Flip it **off** and every write fails closed
immediately — reads, Q&A, and digests keep working. No redeploy.

```bash
# turn ALL actions off (incident)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<bot>/admin/actions/off
# turn them back on (after remediation)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<bot>/admin/actions/on
```

Boot default is `ACTIONS_ENABLED` (env). The runtime toggle overrides it until the process
restarts, so also set the env if you want the change to survive a restart.

## 1. What happened? — read the audit

Every action attempt writes one PII-safe line to the audit sink (actor is a hash, args are
scrubbed): `{ts, surface, chatId, actor, action, argsSummary, decision, outcome, error}`.

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "http://<bot>/admin/actions/audit?limit=200" | jq .
# or straight from disk:
tail -n 200 data/action-audit.jsonl | jq -c '{ts,action,decision,outcome,actor}'
```

- `decision: deny|stepup` + `outcome: blocked` → the gauntlet stopped it (working as intended).
- `decision: allow` + `outcome: failed` → the platform/gateway rejected the write; check `error`.
- Repeated `blocked` with `error: rate-limited` → someone is hammering an action (see §3).

## 2. Someone is doing something they shouldn't

Authorization is verified-only and enforced by the platform (Cerbos), not the bot. To stop a
specific person immediately:

1. **Revoke their identity** (platform, D11): `POST /admin/users/:userId/revoke` — bumps the
   session version; the next execute-time re-check denies. This is authoritative and instant.
2. If you don't yet know who, flip the **kill-switch off** (§0) while you investigate the audit.
3. For a bad Cerbos grant, fix the grant in the platform; the next `authz.check` reflects it.

Confirmation is double-checked (at propose AND execute), so a revocation mid-flow denies before
anything mutates.

## 3. Runaway / abuse

- Per-user, per-action **rate limits** (token buckets) already throttle; high-risk (group-admin)
  is tightest. Sustained abuse still shows as `blocked/rate-limited` in the audit.
- Kill-switch off is the blunt stop; identity revocation is the surgical one.

## 4. A wrong action was executed

Actions are **confirm-before-execute** and audited, but they are not auto-reversible. To undo:

- Business writes: reverse via the platform UI/API (e.g. re-open a task, reassign) — the audit
  gives you the `ref` (created id) and actor.
- Group admin: re-add a removed member / re-set the subject via the same `/group` commands.

## 5. After the incident

- Confirm the audit shows the expected `allow/blocked` pattern resumed.
- If you flipped env `ACTIONS_ENABLED=false`, revert it and redeploy.
- File the timeline from the audit (actor hashes are stable, so you can correlate without PII).
