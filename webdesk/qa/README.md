# webdesk/qa

## `linux-gate.sh` (WSK-58) -- one Linux gate for the WebDesk proof's suites

Runs the CI steps of `webdesk-light` (root, blocks) and `webdesk-api`, plus the WSK-64 vocabulary
suites (`payload/test/wsk64-classifier`, `wsk64-item-fields`, `vocabulary`, `envelope-contract`),
each in throwaway containers. No host paths, no host ports: the source tar is untarred into a
per-run docker volume, everything joins one network `wg58-<id>`, and an EXIT trap removes the
containers, network and volume.

```
bash webdesk/qa/linux-gate.sh [--with-docker-socket] <run-id> <source.tar> [webdesk-root,webdesk-blocks,webdesk-api,vocabulary]
```

The tar must come from `git -c core.autocrlf=false archive --format=tar <ref>` (CRLF blobs break
`init-roles.sh`; the script refuses a CRLF archive). Logs: `~/wg58-<id>/<suite>.log`. The last stdout
line is `### done <id> PASS` or `### done <id> FAIL`; exit 0 only if every selected suite passed.

On sumopod:

```
git -c core.autocrlf=false archive --format=tar <ref> | ssh sumopod 'cat > ~/wg58-<id>.tar'
scp webdesk/qa/linux-gate.sh sumopod:~/linux-gate.sh
ssh sumopod 'nohup bash ~/linux-gate.sh <id> ~/wg58-<id>.tar > ~/wg58-<id>.out 2>&1 & echo started'
ssh sumopod 'tail -3 ~/wg58-<id>.out'     # poll until "### done <id> ..."
```

Local Docker Desktop (Git Bash; a smoke test only, not the Linux-server verification):
`MSYS_NO_PATHCONV=1 bash webdesk/qa/linux-gate.sh myrun /tmp/src.tar`.

Notes: ClamAV needs 3 to 7 minutes to load signatures on a cold laptop (the script waits up to
400 s). `mail-retry-backoff.spec.ts` stops/starts Mailpit through the docker CLI, so with
`--with-docker-socket` the runner gets the docker socket and a static `docker` binary (from
`docker:cli`). Mailpit always lives in the network
namespace of a holder container so a stopped Mailpit refuses connections instantly (like
`127.0.0.1` in CI) instead of failing slowly on DNS.

**The docker socket is opt-in: `--with-docker-socket`, OFF by default.** Without it,
`mail-retry-backoff.spec.ts` (which `docker stop`s Mailpit to prove retry/backoff) self-skips, and the
summary names that skip, along with every other vitest file that skipped something. **The socket is
host root.** With the flag, every `webdesk/api` spec runs with the host's docker socket, which is what
CI's runner has too. On a shared host (sumopod runs other projects' containers) a spec could stop or
start any of them. Today only `mail-retry-backoff.spec.ts` uses it, on the per-run Mailpit
(`MAILPIT_CONTAINER_NAME` is always set). Pass the flag only on a box whose owner agrees, and review new
specs that shell out to `docker` with that in mind.
