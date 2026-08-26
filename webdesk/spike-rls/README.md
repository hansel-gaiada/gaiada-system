# WSK-00 - RLS feasibility spike

**Question:** can a per-request tenant GUC be made to hold under **every** path that reaches the
Zone B database, including the ones Payload owns and we do not call directly?

This exists because design v1.1 **WSK-D16** keeps RLS under a shared Payload instance. The risk was
accepted, not removed, so this buys the cheapest early answer. Deliverable is a **probe suite**,
not a design.

## Exit criterion (from WSK-D16)

> If any access path cannot be made to carry the GUC without patching
> `@payloadcms/db-postgres`, this spike returns to the ruling **with evidence** - not to a
> workaround invented mid-ticket.

Failure here, or a 2x overrun, moves the program to the pre-agreed Option D fallback (per-tenant
Payload schemas, RLS retained on our own tables) **without a fresh design round**.

## Layers

| Layer | Probes | Status |
|---|---|---|
| 1 - mechanism (raw `pg`, no Payload) | P1-P7 | `npm run probe:raw` |
| 2 - Payload Local API / REST / admin / jobs / migrations | P8+ | pending install |

Layer 1 is the precondition: if the pooled-connection mechanics do not hold with code we fully
control, no amount of Payload integration can rescue them.

## The two strategies under test

- **TX** - `SET LOCAL` inside a transaction. Self-scrubbing, correct by construction, but requires
  every caller to be inside a transaction. Payload does not guarantee that.
- **SESSION** - `set_config(..., false)` on checkout, reset on release. Works for non-transactional
  callers, but the GUC lives on a **shared pooled connection**, so a missed reset leaks tenant A's
  context to whoever checks that connection out next. **Probe 4 exists to catch exactly that**, and
  P4b proves the probe has teeth by running it against a deliberately broken variant.

## Run

```bash
docker compose up -d
npm install
node -e "..."   # apply sql/001_schema.sql as owner
npm run probe:raw
```

Compose project is `webdesk-spike` on port **55432** - isolated from every other estate stack, and
`--remove-orphans` in another project cannot touch it.
