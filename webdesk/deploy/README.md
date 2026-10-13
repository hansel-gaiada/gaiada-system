# webdesk/deploy: RETIRED (M6-P6j, WSK-D29)

**This package no longer deploys or probes anything.** It was the control plane's ssh+rsync
deployer (WSK-29). The control plane (the ERP, the hub, the agents) holds no SSH key and deploys
nothing (WSK-D29, design v2 section 14). The ssh+rsync driver, its host config and the live probe
script were removed; `deploy()` and `probe()` reject with a message naming the replacement.

## What replaces it

Delivery is **per site** (WSK-D79). The site's own CI ships the build over SFTP with
`webdesk/templates/_deploy/deploy.sh`, using the per-site secret the ERP binds through
`POST sites/:id/delivery-binding` (M6-P6g). `delphi` and `helios` are still valid delivery targets for
a client site that chooses them; they are reached by that site's CI, never from the control plane.
The proof site's rebuild (`webdesk-rebuild.yml` in the site repo, forced command, WSK-D56) is the same
kind of path and is unaffected.

## What is left

`src/index.ts`: `deploy()`, `probe()` and `getDriver()`, all rejecting with `DeployRetiredError`, and a
test that pins that. Nothing in this repo imports the package. CI keeps typechecking and testing it
(`webdesk-light`) so a stray import cannot start working again silently.

Runbook: `infra/runbooks/webdesk-staging-rebuild.md`. Plan: `docs/plans/2026-10-11-webdesk-m6-plan.md` section 6.
