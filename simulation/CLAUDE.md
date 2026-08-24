# `simulation/` — total-estate work simulation

Drives the **real** ERP surface as the **real** roster, continuously, and writes everything it sees
to an analysable corpus. It exists to answer a question a unit suite cannot: *what breaks when the
whole estate does a day's work?*

It is a **harness, not a test suite**. It never asserts. It performs plausible business, records what
happened, and judges responses against one rule — a 5xx is always a defect.

## Commands

All from `simulation/`. Every script takes `SSH_HOST` (default `gda-aicenter`).

| Command | What |
|---|---|
| `scripts/link-identities.sh` | Give the 19 seeded staff verified WhatsApp `identity_links` so they can be driven over the OBO path. Idempotent, `--revert`, `--list`. |
| `scripts/enable-staff-logins.sh` | Clear `UPDATE_PASSWORD` and set a generated password so the **human** path works. Idempotent, `--revert`. Owner-run. |
| `scripts/build-roster.sh` | Regenerate `roster.generated.json` (name, userId, email, department, sim phone, Cerbos roles). |
| `scripts/deploy-and-run.sh` | Ship to the box, build, start. `--logs`, `--stop`, `--status`. |
| `SIM_MODE=live scripts/deploy-and-run.sh` | The live-paced loop (human-speed gaps). |
| `SIM_MAX_TICKS=2 scripts/deploy-and-run.sh` | Bounded smoke run. |
| `npx tsc --noEmit` | Typecheck. There are no unit tests here on purpose — see below. |

## Why there are no unit tests in this component

Everything worth knowing about this code is whether it drives the **live** estate correctly, and a
mock cannot tell you that. A green suite here would assert that the harness talks to a fake exactly
as designed — which is the one thing that was never in doubt. The corpus is the output that matters;
`summary.json` is the assertion.

## Shape

- `src/config.ts` — env only. Fails loudly on a missing token rather than sending `undefined` at a live estate.
- `src/log.ts` — the corpus. Append-only JSONL, **synchronous** writes.
- `src/http.ts` — the instrumented client. **This is where findings are detected**, not by reading logs later.
- `src/token.ts` — real authorization_code + PKCE, in-process, for the human path. Degrades to null.
- `src/roster.ts` — the cast, and who is allowed to do what.
- `src/scenarios.ts` — the work.
- `src/main.ts` — the loop.

## Rules that are load-bearing

- **It runs as its own compose project (`gaiada-sim`), never as a service in `gaiada`.**
  `--remove-orphans` deletes any container in the named project whose profile is absent from that
  command line, and the estate's deploy runs compose with a subset of its files. A harness in that
  project would be deleted by a routine deploy, or would make one delete something else.
- **Secrets are inherited, never handled.** `env_file: ../infra/compose/.env` is how the service
  tokens arrive. The staff password lives in a root-only file on the box, mounted read-only. Nothing
  in this directory should ever print, log or transport either.
- **Every created record carries `[SIM]` and lands in `created.jsonl` immediately** — before anything
  else happens to it, so a run that dies mid-scenario is still fully cleanable. This writes to an
  estate the owner demos from; simulated work that cannot be told from real work is somebody else's
  mess.
- **Never fabricate an interaction.** A department with one person does not get a "handoff" to
  themselves; the scenario is skipped, or the ball goes to another department and is *labelled*
  cross-department. A corpus that overstates what happened is worse than a smaller one.
- **`expect: [...]` is how a negative probe passes.** A deliberate 400/403 assertion must declare
  its expected statuses, or `http.ts` records it as a finding and buries the real ones.

## Traps this component has already hit

- **Authority is not uniform across the roster.** `resource_pm_task.yaml` reserves `create`/`delete`/
  `manage` for `company_admin`/`manager`. Exactly **5 of 19** real staff hold `manager` (one lead per
  department); everyone else is `member` and gets a **403 on task create**. The first smoke run
  skipped three departments before the chain was rebuilt around who may actually raise work. A
  `member` *can* still pass the ball — that asymmetry is deliberate ("anyone can pass the ball",
  owner decision 2026-08-06) and is exercised every tick.
- **An unresolvable OBO envelope degrades to ANONYMOUS and reports `403 cerbos denied`.** A typo in
  an `external_id` is indistinguishable from an authorization failure. This cost real diagnostic time
  during bring-up — the audit row shows `(null actor)`, which is the tell.
- **`sudo -u postgres` bypasses RLS.** Row counts taken as superuser are not what `platform_app`
  sees. Verify membership/visibility questions through the app's own connection, or the answer is
  meaningless.
- **6 of the 26 people in the org tree are retained placeholder personas** (`@gaiada-creative.test`),
  deliberately kept as workflow actors by `retire-placeholder-hr.ts`. `roster.generated.json` marks
  them `placeholder: true`. Reporting "26 people worked" overstates the roster by 30%.
- **The generated sim phone numbers are `+9990000NNNN`, not `+999000NNNN`.** Off-by-one-zero here
  produced a phantom "OBO is broken" investigation. `scripts/link-identities.sh --list` is the truth.

## The corpus

`/var/lib/gaiada-sim/logs/<runId>/` on the box:

| File | What |
|---|---|
| `manifest.json` | What this run was, so a corpus found later explains itself. |
| `steps.jsonl` | Every call: actor, identity path, scenario, step, status, latency. |
| `findings.jsonl` | Every judged defect, **every occurrence** (a defect firing 400 times is a different problem from one firing once). |
| `created.jsonl` | The teardown ledger. |
| `summary.json` | Rewritten each tick. Endpoint fail rates, finding counts, and **`parityGaps`**. |

`parityGaps` is the point: endpoints that succeed on one identity path and fail on another. That is
the **agentic-native bar** ("every capability must work identically under a human, under n8n, and
under an agent") measured rather than asserted. It needs **both** arms live — with only the service
path enabled the table has nothing to compare, and the run says so.
