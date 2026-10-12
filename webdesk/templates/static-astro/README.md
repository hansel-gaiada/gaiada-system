# Static site (Astro)

Kind: `static`. A fully static Astro site whose content comes from WebDesk's `/v1` at build time.
Published from the monorepo (`webdesk/templates/static-astro/`); do not edit the template repo directly.

`code.scaffold` fills this repo: it writes `src/pages/**`, `src/lib/webdesk-sdk.ts`, `astro.config.mjs`,
`tsconfig.json`, `package.json`, `.env.example`, `.gitignore`, `docs/`, `vendor/` (the SDK and block
tarballs) and `CONTRACT.lock`. `src/layouts/` and `src/components/` are the hand-owned skeleton.
`src/pages/index.astro` here is a placeholder the scaffolder replaces.

## What this repo may not do

- No hand-rolled `fetch` to WebDesk; every page goes through `src/lib/webdesk-sdk.ts`.
- No secrets, tokens or client names in the repo; values come from CI secrets or the preview environment.
- No deploy target or Cloudflare account here: deployment is configuration (M6-P6), gated by
  `WEBDESK_DEPLOY_GRANT` in `.github/workflows/site.yml`.
- Nothing builds or deploys without `CONTRACT.lock`.
