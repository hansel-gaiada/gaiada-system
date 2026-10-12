# WordPress site (headless theme)

Kind: `wp`. `wp-content/themes/gaiada-webdesk/` is the canonical WebDesk theme, byte for byte
(`webdesk/wordpress/theme/gaiada-webdesk/` in the monorepo), except `vendor/gaiada-sdk/sdk.php`, which
`code.scaffold` replaces with the tenant's own generated PHP SDK. The theme **renders entirely from
WebDesk's `/v1`**: no content lives in the WordPress database, and the theme never writes options.

`code.scaffold` fills this repo (the SDK file, `README.md` and `CONTRACT.lock`). Do not edit the theme
here; change it in the monorepo, where `webdesk/templates/check-wp-theme.mjs` guards against drift.

## Configure (wp-config.php constants or environment variables)

See `.env.example` for the names: `GAIADA_WEBDESK_BASE_URL`, `GAIADA_WEBDESK_TENANT`,
`GAIADA_WEBDESK_API_KEY`. Until the three are set every page answers 503.

## What this repo may not do

- No secrets, tokens or client names in the repo.
- No content in the WordPress database; no Composer, no plugin dependencies.
- No deploy target here: deployment is configuration (M6-P6), gated by `WEBDESK_DEPLOY_GRANT`.
- `docker-compose.yml` is LOCAL DEV ONLY.
- Nothing builds or deploys without `CONTRACT.lock`.
