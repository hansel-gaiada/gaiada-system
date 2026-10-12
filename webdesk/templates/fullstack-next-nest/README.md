# Fullstack site (Next + Nest + Tailwind + TypeScript)

Kind: `fullstack`. `apps/web` (Next + Tailwind) and `apps/api` (Nest, client business logic) in an npm
workspace. Published from the monorepo (`webdesk/templates/fullstack-next-nest/`).

`code.scaffold` fills this repo (pages, the vendored SDK and block library under `vendor/`,
`CONTRACT.lock`). Its `fullstack` kind (`ai-agents/src/code-scaffold/templates/node-site.ts`, M6-P4b1)
writes into `apps/web` only, with a React block renderer, and leaves the workspace root and `apps/api`
alone.

## OPEN owner decision: no database layer

Whether client sites use the unified WebDesk Postgres (Tension A in
`docs/blueprints/site-provisioning-templates.md`) is undecided. Until the owner rules, this template has
**no database layer at all**: no `db/`, no migrations, no `DATABASE_URL`, no ORM. Adding a private
`postgres:` service (to compose or anywhere else) is **not allowed**.

## What this repo may not do

- No database, no private Postgres, no secrets, tokens or client names in the repo.
- No hand-rolled calls to WebDesk outside the vendored SDK.
- No deploy target here: deployment is configuration (M6-P6), gated by `WEBDESK_DEPLOY_GRANT`.
- Nothing builds or deploys without `CONTRACT.lock`.

## Local dev

    npm install
    npm run dev:web   # http://localhost:3000
    npm run dev:api   # http://localhost:4000/health
