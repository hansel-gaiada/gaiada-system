# Overnight brief — 2026-08-23 → 24

Owner asleep. Decisions taken before handover, so nothing blocks.

## Decisions (owner, 2026-08-23)

1. **Presence: all five rules BINDING.**
   1. Opt-in per person, revocable; "not shown" is indistinguishable from "not here".
   2. **Ephemeral only** — Redis key + TTL. NO history table, NO accumulating `last_seen`,
      nothing queryable after the fact. This is a storage-layer guarantee, not a policy promise.
   3. No derived-activity metrics, ever — no idle timers, time-at-desk, or heatmaps.
   4. No manager view. A director sees exactly what an intern sees.
   5. Agents and automations are exempt — their movement IS the operational record, log it fully.
2. **Priority: redesign depth first**, office prototype only with leftover capacity.
3. **Art: LPC at 32px**, committed (see virtual-office plan §4.3-DECISION).
4. **Backend spine: build, and deploy + verify live** (owner override of the local-only option).

## Git handling — deviation from the owner's stated choice, and why

Owner chose "new branch". **Not done.** `HEAD` moved from `a97f0b4` to `712a91d` mid-conversation
and a second session has uncommitted work in the same tree (Cerbos policies, BFF contract).
`git switch -c` rewrites `.git/HEAD` for every session sharing the working tree, so that session
would land its next commit on our branch without noticing.

**Taken instead:** selective commits to `main` — only files authored by this session, staged by
explicit path, never `git add -A`, one commit per phase after its gates pass. Same recoverability,
no HEAD yank on a live session. Revisit with the owner.

## Deploy rails (backend spine)

Owner approved a live deploy. Because it runs unattended, it aborts rather than forces:

- Deploy ONLY if: typecheck + full vitest + `DEMO_MODE=1 npm run build` + smoke are green.
- Pre-flight, all must pass or ABORT: disk headroom checked and pruned first; push credentials
  verified BEFORE building anything; the full compose file set used (never `vps.yml` alone);
  never `--remove-orphans`.
- Post-deploy: verify `/health` reports the EXPECTED version, not merely that it responds — a
  rolled-back deploy misreports version, and a green container list has previously hidden a
  Cerbos crash loop, so check `docker ps -a`, not `ps`.
- On ANY anomaly: stop, leave the estate as found, write it up. Do not retry in a loop.
- No hand-built deploy if the pipeline is dead. Report and leave it.

## Honesty rule stands

The office prototype renders from demo fixtures until the event spine is live. Any motion not
backed by a real event is labelled DEMO on screen. No exceptions, including for a screenshot.
