# webdesk/deploy — WSK-29 frontend-deploy driver seam

Zone A tooling. Not the WebDesk backend (that's `webdesk/api`/`webdesk/payload`, Zone B) — this
package deploys the STATIC frontend artifacts WebDesk's own pipeline produces (WSK-15/16/17) to the
two non-WordPress hosting targets named in WSK-D26: `delphi` (staging) and `helios` (production).
WordPress sites stay on Hostinger and are out of scope here.

## Status: PROTOTYPED, not DEV-VERIFIED

The driver (`SshRsyncDeployDriver`) is real and unit-tested (`npm test`, fake `ExecFn`, zero
network). `deploy()` has never been run for real against `delphi`/`helios` and must not be, for two
independent reasons — either one alone is enough to block it:

1. **`delphi`/`helios` are OBSERVE-ONLY** by owner ruling (2026-08-22). Deploying IS modifying them.
2. **They are live cPanel/WHM shared-hosting boxes serving real third-party customer sites**
   (confirmed 2026-08-27 — see the WSK-29 report for the exact evidence: per-account php-fpm pools,
   per-account home directories under `/home`, FTP-only accounts). There is no safe generic path to
   write a release to; `HostConfig.remoteBasePath` has no default on purpose and `deploy()` refuses
   with a named message when it's unset.

`probe()` (a bare `ssh ... true` — no write, no exec of anything else) is safe under the observe-only
ruling and IS real: `npm run probe:live` runs it for real against whichever host you've configured.

## Config

```
DELPHI_SSH_HOST / DELPHI_SSH_USER / DELPHI_SSH_KEY_PATH / DELPHI_SSH_PORT / DELPHI_REMOTE_BASE_PATH
HELIOS_SSH_HOST / HELIOS_SSH_USER / HELIOS_SSH_KEY_PATH / HELIOS_SSH_PORT / HELIOS_REMOTE_BASE_PATH
WEBDESK_DEPLOY_CONNECT_TIMEOUT_SEC   # default 10
DEPLOY_USE_SSH_ALIAS=1                # dev-only: resolve via this machine's own ~/.ssh/config
                                       # "delphi"/"helios" Host entries instead of the *_SSH_HOST vars
```

No var, no default host — see `config.ts`'s `MissingHostConfig`.

## Commands

```
npm ci && npm run typecheck && npm test
npm run probe:live      # REAL network, read-only — see the header comment in scripts/probe-live.mjs
```

## What still needs to happen before `deploy()` can run for real

1. An explicit owner ruling lifting observe-only **for deploys specifically** on delphi/helios
   (narrower than re-authorising the general monitoring/probe tier — WSK-D26's own blocker #1).
2. Ops decides and provisions the actual hosting account/vhost docroot on each box that WebDesk's own
   frontends deploy into, and sets `*_REMOTE_BASE_PATH` to it. This is a new finding from this
   ticket, not the reachability question the program had previously recorded — see the report.
3. Wiring this driver behind an actual caller. Today nothing calls `getDriver()` — the aggregated
   `webdesk.deploy.staging`/`webdesk.site.promote` MCP tools (WSK-31, `platform-nest/src/modules/
   webdev/webdesk-control.controller.ts`) still answer `501 webdesk_control_plane_not_wired`, and
   wiring them to call into this package is a `platform-nest`/`webdesk/api` change outside this
   ticket's file ownership (`.github/workflows/`, `mcp-hub/`, `webdesk/deploy/`) — reported, not made.
