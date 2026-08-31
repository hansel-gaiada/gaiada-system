# WSK-00 · Layer 1 findings — the mechanism

**Date:** 2026-08-26 · **Status:** PROTOTYPED (probes written, run, and observed on a live PG 16)
**Result: 8 / 8 pass, including a negative control that genuinely fails when the safeguard is removed.**

## Verdict

**The Postgres half of WSK-D16 is sound. The risk is not in the database — it is entirely in whether
Payload's query paths can be pinned to one of two disciplines.** Layer 2 answers that.

## What was proven

| Probe | Result | What it establishes |
|---|---|---|
| P1 (×2) | PASS | GUC-scoped reads return exactly one tenant's rows, both directions |
| P3 | PASS | **Fail-closed**: an unset GUC yields ZERO rows — not an error, not everything |
| P4 | PASS | Tenant context does **not** survive connection reuse under the SESSION strategy |
| **P4b** | **PASS (negative control)** | **Remove the reset and it DOES leak** — ACME's rows appear on a checkout that set no context at all |
| P5 | PASS | Cross-tenant INSERT refused by `WITH CHECK` |
| P6 | PASS | `webdesk_app` cannot DDL |
| P7 | PASS | `webdesk_app` cannot disable RLS on its own tables |

P4b is the one that matters most. A probe that cannot fail proves nothing; this one runs P4's exact
scenario against a variant that skips the reset, and it leaks on cue. So P4's pass is evidence, not
decoration.

## The finding that shapes layer 2

Two strategies both work at the mechanism level, and they are **not** equally safe:

- **TX** — `SET LOCAL` inside a transaction. **Safe by construction**: the setting dies with the
  transaction, so there is no reset to forget and no way to leak across a pooled connection. Cost:
  every caller must be inside a transaction.
- **SESSION** — `set_config(..., false)` on checkout, reset on release. Works for callers that are
  not in a transaction. **Its safety rests entirely on one line in a `finally` block.** P4b shows
  what removing it does: the next checkout of that physical connection inherits the previous
  tenant's context.

So the real question for layer 2 is narrow and answerable: **does Payload run every operation —
Local API, REST, admin, jobs, migrations — inside a transaction we control?**

- **If yes** → TX strategy, safe by construction, WSK-04 proceeds as designed.
- **If no** → safety depends on a reset that must be correct on *every* path forever, including
  paths inside a third-party library that we do not call directly and that can change on a minor
  version bump. That is the shape of risk WSK-D16's fallback trigger was written for.

## Reproduce

```bash
cd webdesk/spike-rls
docker compose up -d
docker exec -i webdesk-spike-spikedb-1 psql -U webdesk_owner -d webdesk_spike < sql/001_schema.sql
npm install && node probes/raw.mjs
```

Compose project `webdesk-spike`, port **55432** — isolated from every other estate stack.

## Honest scope limit

This proves the **database and pool mechanics only**, with code we fully control. It says nothing
yet about Payload. No status above PROTOTYPED is claimed, and nothing here justifies starting
WSK-04.
