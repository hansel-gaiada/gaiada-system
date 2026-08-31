# webdesk/ops — Zone B ops baseline (WSK-28)

**Status: PLANNED / PROTOTYPED per-item — see each file. The Zone B box does not exist (A-12).**
Everything here is authorship + provable-in-isolation config, not a live rollout. Do not read any
green selftest or clean `docker compose config` in this directory as evidence the box works — it
is evidence the *config and scripts* are internally consistent, which is a real but narrower
claim.

## What's here

| Path | What | Runbook |
|---|---|---|
| `secrets-layout.md` | Where every Zone B secret lives and how it's issued — no values | — |
| `otel/proposed-zonea-otlp-listener.yaml` | Proposal for the Zone A write-only OTLP listener — **not applied**; `infra/observability/` is outside this ticket's file ownership | `../../infra/runbooks/webdesk-zoneb-otel.md` |
| `scripts/check-otlp-write-only.mjs` | Static auditor: does a collector config expose any read/query surface alongside the push-only `otlp` receiver | `../../infra/runbooks/webdesk-zoneb-otel.md` |
| `scripts/check-cdn-bypass.mjs` | Static + probe-capable auditor: would a request that skips the CDN edge reach Zone B media unauthenticated | (this file, §CDN-bypass) |
| `scripts/webdesk-backup-local.sh` | Nightly PG dump + MinIO mirror into the local versioned/object-locked `backups` bucket | `../../infra/runbooks/webdesk-zoneb-backups.md` |
| `scripts/wd-backup-sentinel.sh` | Staleness alarm — a stopped backup job must read as a failure, not silence | `../../infra/runbooks/webdesk-zoneb-backups.md` |
| `scripts/gen-status-page.mjs` | Renders the public Zone B status page from local health probes | `../../infra/runbooks/webdesk-zoneb-status-page.md` |
| `status-page/` | Static output directory the `status-page` compose service serves | `../../infra/runbooks/webdesk-zoneb-status-page.md` |

Box hardening + synccert issuance live at `../../infra/runbooks/webdesk-zoneb-box-hardening.md`
(no script needed — those are host-provisioning steps, not project files).

## CDN-bypass check — why it exists and what it actually proves

Design §11a: self-hosted media is only safe if the CDN is mandatory — "a cache hit never touches
the origin, which is what makes one box able to serve many sites. A media path that bypasses the
CDN is a defect." That's a claim about *traffic pattern*, but it is also a **security property**:
if the origin (Zone B) answers a media request that skipped the CDN just as happily as one that
went through it, then (a) the box has no defense against someone hammering it directly, bypassing
whatever WAF/rate-limit Cloudflare provides, and (b) `Cache-Tag` purge and the cookieless-serving
discipline (WSK-07) can be routed around entirely.

`scripts/check-cdn-bypass.mjs` encodes the mechanism this ticket specifies (a shared secret header
Cloudflare injects via an Origin Rule/Transform Rule — `X-Webdesk-Edge-Verify` — checked at Caddy
before any media route is reached; see the Caddyfile diff) and, like every other checker in this
ticket, ships a `--selftest` that proves the check would **fail** if the direction were reversed:
it builds a fake origin that (wrongly) serves media with the header absent, asserts the checker
flags it, then builds one that correctly 403s, and asserts the checker passes it. It cannot prove
the *real* Caddyfile enforces this at runtime without a running proxy + a real Cloudflare edge in
front of it — that is exactly the "authored, unverifiable until the box exists" boundary this
whole ticket lives inside of.

## Reading a status line in these files

`PLANNED` — described, nothing run. `PROTOTYPED` — driven against a throwaway/local stand-in on
this dev machine, observed once. `DEV-VERIFIED` — driven against the real thing and observed;
**nothing in this directory reaches that bar**, because the real thing (Zone B's actual box) does
not exist. Never read a clean parse or a green selftest here as more than what it is.

## Compose-overlay lessons (carried over from the WITHDRAWN helios overlay, 2026-08-29)

`docker-compose.helios.yml` and `nginx/webdesk-vhost.conf.template` were deleted when the owner
ruled Zone B onto `sumopod` instead of `helios` (WSK-D27; see `webdesk-design.md` §14). The
direction is withdrawn — **these mechanics are not**, and the next overlay (sumopod) needs every
one of them:

- **`ports:` merges ADDITIVELY across compose files.** An overlay cannot remove a published port by
  redeclaring the list. Use `ports: !reset []` to clear the base file's publication. The base file
  publishes every backing service on `0.0.0.0`, which is correct for a throwaway dev stack and
  dangerous on any box with neighbours.
- **`!reset` REMOVES a key; it cannot reset-and-replace.** Written as `ports: !reset` with a list
  underneath, Compose discards the list too — the first draft of that overlay resolved to a proxy
  with NO published port and services with NO command, and `docker compose config` **exited 0 on
  it**. Replacement needs `!override`. Same reasoning applies to `profiles: !reset []`, since the
  base file gates services behind the `dev` profile and a production overlay must be unconditional.
- **Audit the RESOLVED config, never the overlay.** `docker compose ... config | grep -A3 ports:`
  and confirm the only published port is the proxy's, bound to `127.0.0.1`.
- **Topology to reproduce:** one public listener only; `postgres`, `redis`, `minio`, the Payload
  internal listener, the public gateway and `api` all on the private compose network with **no host
  ports at all**; the Payload admin reachable only through an SSH tunnel (design D-5 / WSK-D20).
- **Say what is deliberately absent.** That overlay omitted `worker` (no worker entrypoint exists
  yet — shipping the base file's `sleep infinity` stub to production would be a container that
  prints a sentence), plus `clamav`, `imgproxy`, `otel-collector` and `status-page`. Absence stated
  is a decision; absence unstated is a gap.
