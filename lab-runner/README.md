# lab-runner — the LMS lab execution sidecar (LMS L5)

Executes a learner's submission in a capped, unprivileged, network-less container and returns a
graded result. Design: [`../docs/blueprints/lms-foundation.md`](../docs/blueprints/lms-foundation.md) §5.

**No ERP network path, no identity, no database.** It never learns who a learner is and never
reaches Postgres. It takes files plus a grading spec and returns a grade; the platform owns
everything else. That is what keeps a compromise here from being a compromise of the ERP.

## ⚠ The one fact that shapes every decision in this service

**The target host has no KVM** (owner-confirmed 2026-08-25). There is no hypervisor underneath, so
the `docker run` argument list in `src/sandbox.ts` *is* the isolation — not a second layer beneath
a microVM. It also shares a kernel with ~50 containers across seven other projects on that box,
including Postiz's social OAuth tokens.

Read `src/sandbox.ts` before changing anything. Every flag states why it is there.

## Run it

```
npm ci
LAB_RUNNER_TOKEN=... LAB_RUNNER_IMAGES=node22=node:22-alpine npm start
npm test          # 25 unit tests — the sandbox flags and the grader
npm run typecheck
```

## Contract

```
POST /runs      { challengeId, image, files[], command?, limits?, gradingSpec } -> 202 { runId }
GET  /runs/:id                                                                  -> the result
GET  /health                                                                    -> posture (unauthenticated)
```

`image` is a **key into the allow-list**, never an image reference. `/health` reports the runtime,
the concurrency state and the effective limits, so "we thought gVisor was on" is answerable rather
than assumed.

### Grading

Four check kinds — `exitCode`, `stdoutMatches`, `stdoutLacks`, `fileExists` — evaluated
**server-side**. The browser never asserts a pass.

⚠ **`fileExists` is a convenience check, not evidence.** The artefact listing is produced inside the
learner's own container, so `touch dist/app.js` satisfies "did you produce dist/app.js" without
building anything. Pair it with a `stdoutMatches` on the real tool's success line for anything that
matters. No artefact report can be non-forgeable while the learner controls the process that
produces the artefacts.

A spec with **no checks scores zero, never 100** — "nothing to check" and "passed everything" are
different findings.

## What was verified, and how

Driven end-to-end against real Docker, 2026-08-25:

| Case | Result |
|---|---|
| A correct submission | 100, passed, artefacts listed |
| A submission with a real bug | 0, and the detail quotes the failing line |
| DNS lookup from inside a lab | `DNS_BLOCKED` — no network |
| `files[]` path `../../../../etc/cron.d/pwn` | refused: *"it escapes the submission directory"* |
| `image: "alpine:latest"` | refused: *"the caller names a KEY, not an image reference"* |
| `while(true){}` | killed on the wall clock; every check reads *"the run hit its time limit"* |
| 400 background processes | `can't fork: Resource temporarily unavailable` — `--pids-limit` bit |
| `touch /etc/probe` and `touch /lab/tamper` | both *"Read-only file system"* |

After the matrix: zero leaked containers, volumes or networks; queue back to idle.

### Two bugs the drive found that the unit tests could not

1. **A plain `--tmpfs /work` is root-owned**, so `--user 65534` could not write a byte to it. Every
   run failed with `cp: can't create '/work/...': Permission denied`.
2. **A docker volume chowned by a prep container is not portable.** Docker Desktop masks volume
   ownership per container — the chown appears to take and the next container still sees `root`.
   `chmod 0777` behaves the same way. Verified directly.

The fix is `--tmpfs /work:rw,nosuid,size=128m,mode=1777,uid=65534,gid=65534`: no prep step, no
cleanup, identical behaviour on Docker Desktop and on Linux. `src/sandbox.test.ts` pins it.

## Deployed (SumoPod, 2026-08-25)

`gaiada-lms-lab-runner`, image `gaiada-lab-runner:0.1.1`, bound to **127.0.0.1:4310**, running with
`LAB_RUNNER_RUNTIME=runsc`. gVisor is installed on that host as a NON-DEFAULT runtime, so a lab gets
a user-space kernel (`4.19.0-gvisor`) between it and the host — which is the only meaningful
hardening available there, because the box has no KVM.

The full matrix was re-driven ON the box after deploy; all eight cases behave as the table above
describes. Afterwards: zero leaked containers, networks or temp directories, and the container set
was identical to the pre-session baseline apart from the runner itself.

### A third bug, which only the real host could show

`mkdtemp` creates its directory **0700, owned by the creating process**. The lab container runs as
uid 65534, so `/lab` mounted fine and then every run died on
`cp: can't stat '/lab/.': Permission denied`. Docker Desktop's uid-translation layer hides this
completely — the local drive was fully green. The fix is `chmod 0755` on the submission directory
and `0644` on its files, which is safe precisely because that mount is read-only.

Two lessons worth keeping: a local Docker drive is not a substitute for the target host, and
"Permission denied" rather than "No such file" was the clue that the *mount* was right and the
*mode* was wrong.

### Operating notes

- **Never bind `0.0.0.0`** on the host side. Docker's DNAT is evaluated before ufw's, so a
  `0.0.0.0` publish is internet-reachable on a box whose firewall says otherwise. The container
  listens on 0.0.0.0 *inside itself* — which is the only way a published port reaches it — and the
  publish is pinned to loopback. `-p 127.0.0.1:4310:4310`, never `-p 4310:4310`.
- It is a bare `docker run`, deliberately not a compose project, so no other project's
  `--remove-orphans` can delete it.
- `TMPDIR` and the `-v /var/lib/gaiada-lab/tmp:/var/lib/gaiada-lab/tmp` mount must name the SAME
  path. The runner bind-mounts submissions into lab containers and the daemon resolves those paths
  on the host; a path that existed only inside the runner would mount as an empty directory and
  every submission would silently run against nothing.
- Pin images by digest in `LAB_RUNNER_IMAGES` when the catalogue grows.
- Host-safety rules for that box are in `../infra/runbooks/deploy-vps.md` — no unscoped Docker
  command, no `system prune`, no bare `--remove-orphans`.
