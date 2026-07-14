# Local dev on Windows: WSL for the Go services

This machine has **Windows Smart App Control (SAC)** enforced. SAC blocks any
unsigned Windows `.exe`, which includes everything Go compiles locally — so
native `go run` / `go build` / `go test` fail with:

```
fork/exec ...Temp\go-build...\gateway.exe: An Application Control policy has blocked this file.
```

SAC has no per-app exclusion list, and turning it off is a **one-way switch**
(you can't re-enable it without resetting Windows). So instead of disabling it,
**the two Go services run inside WSL**, where the binary is a Linux ELF that SAC
does not govern.

## What needs WSL vs what doesn't

| Component | Runtime | Runs via |
|---|---|---|
| `ai-gateway-go/` | Go (compiled) | **WSL** (or Docker) |
| `sync-engine-go/` | Go (compiled) | **WSL** (or Docker) |
| `platform-nest/`, `wa-chat-bot/`, `mcp-hub/`, `ai-agents/`, `hermes-gateway/`, `platform-ui/` | Node (`node.exe` is signed) | **native Windows** — no WSL needed |

Forcing the Node services into WSL only slows them down; SAC doesn't touch them.

## Setup already done on this machine

- WSL distro **Ubuntu** installed (`wsl -d Ubuntu`), default user root.
- **Go 1.26.5** installed at `/usr/local/go`, on PATH via `/etc/profile.d/go.sh`.
- Code is used in place from `/mnt/c/...` (this same working tree — no second copy).

## How to run the Go services

Each Go service has a `wsl.ps1` wrapper. From that service's folder in PowerShell:

```powershell
cd ai-gateway-go
.\wsl.ps1            # go build ./...
.\wsl.ps1 run        # go run ./cmd/gateway  -> http://localhost:3002/health
.\wsl.ps1 test       # go test ./...
.\wsl.ps1 vet
.\wsl.ps1 mod tidy   # any other go subcommand passes through
```

WSL2 forwards the port to Windows `localhost`, so `http://localhost:3002` works
from a Windows browser with **no firewall prompt**.

### sync-engine-go full suite (DB-backed convergence/chaos)

That suite needs two Postgres instances with the platform-nest migrations + a
NOBYPASSRLS role. `chaos-test.ps1` does the whole thing (up → migrate → role →
`go test ./...` in WSL):

```powershell
cd sync-engine-go
.\chaos-test.ps1                 # up + provision (fresh DBs) + full suite
.\chaos-test.ps1 -SkipProvision  # DBs already migrated -> just re-run tests
.\chaos-test.ps1 -Down           # tear the DBs down
```

Site-a publishes on **55434** (not 55432 — that's held by the unrelated
`aire-postgres` container); central on 55433. The tests reach the DBs over
Windows `localhost`, which WSL2 forwards. Provisioning always resets to fresh DBs
because `0001_core.sql` uses bare `CREATE TABLE`. Note: the committed
`run-tests.sh` (which recompiles to dodge SAC) is **superseded** — in WSL plain
`go test` just works, exactly like CI on Ubuntu.

## Alternative: Docker

Both Go services also have Dockerfiles and run under Docker Desktop (already
installed) without SAC issues — this matches how the stack deploys. Use WSL for
fast iteration, Docker for parity with deployment.
