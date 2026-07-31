# report-renderer

Node + Playwright sidecar for tracker/reporting `TR-19`
(`docs/blueprints/tracker-reporting-foundation.md` §6.3). It is the **only image in the estate
that carries Chromium** — platform-ui's Next standalone image stays browser-free by design.

## What it does

`POST /render {url}` (behind `Authorization: Bearer $RENDERER_TOKEN`) launches Chromium, navigates
to `url`, and returns print-grade PDF bytes (A4, exact background colors, page-numbered footer).
`GET /health` is unauthenticated.

`url` **must be same-origin with `PLATFORM_UI_INTERNAL_URL`** — this service renders whatever URL
it is handed, so that check is the only thing standing between a leaked `RENDERER_TOKEN` and an
SSRF proxy against the internal network. See `src/auth.ts`.

Scope boundary (do not extend without a ticket): TR-20 builds the platform-ui print route this
sidecar targets; TR-21 builds the one-shot `jobToken` orchestration in platform-nest that mints
the URLs this service is handed. This service never sees a session cookie or tenant credential.

## Working precedent

`docs/blueprints/render-pdf.js` already solves the print-CSS/Playwright-PDF technique this
service uses (exact-color printing, `headerTemplate`/`footerTemplate` page numbers). Lift it,
don't rediscover it — this Dockerfile and `src/server.ts` do.

## Local dev

```sh
npm install
npm run typecheck
npm test
RENDERER_TOKEN=devtoken PLATFORM_UI_INTERNAL_URL=http://localhost:3005 npm run dev
```

## Version pin (read before bumping)

The Docker base image `mcr.microsoft.com/playwright:v1.61.1-noble` ships a specific Chromium
build. `package.json` pins the `playwright` npm dependency to the **exact same version, no caret**
— `chromium.launch()` looks for the browser revision matching the installed `playwright` package,
and a caret range could resolve a newer patch whose browser isn't preinstalled in this image.
Bump both together, deliberately, and re-verify a build on a real Docker host.

## Verification status

Typecheck and unit tests (`src/auth.test.ts`, `src/server.test.ts` — incl. the
token-less-request-\>401 acceptance check) run and pass with plain Node, no Docker involved.

**The Docker build and a real Chromium render were also verified (2026-07-31), on Docker Desktop
(Windows, Linux-VM backend)** — `docker build .` succeeds; a container built from this Dockerfile
launched Chromium, navigated to a real URL, and returned a genuine multi-page-capable PDF
(`file` reported `PDF document, version 1.4, 1 page(s)`); `docker compose ... up --no-deps
report-renderer` came up **healthy** per its own healthcheck; and the auth/SSRF gates (401
no-token, 401 wrong-token, 403 disallowed-origin) all behaved correctly against the running
container. Exact commands + output are in `docs/modules/CHANGELOG.md`'s report-renderer entry.

**Not yet verified:** a deploy to the real production Linux VPS (only Docker Desktop was
available here) — re-confirm `docker compose ps` shows this service healthy on the actual target
host before relying on it there, per `infra/runbooks/deploy-vps.md`. TR-20 (the print route) and
TR-21 (the one-shot token orchestration) also aren't built yet, so there is no real report to
render end-to-end through the whole pipeline yet — only this sidecar's own contract is proven.
