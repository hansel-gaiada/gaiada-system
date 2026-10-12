# WebDesk site templates

Source of truth for the three site templates that `code.scaffold` fills (webdesk-design-v2.md §08,
WSK-D74). The GitHub repos `gaiadabali/template-static-astro`, `template-fullstack-next-nest` and
`template-wp` are **published copies** of these directories. Edit here, review here, then publish.

| Directory | Published to | Kind |
|---|---|---|
| `static-astro/` | `template-static-astro` | static Astro site |
| `fullstack-next-nest/` | `template-fullstack-next-nest` | Next + Nest + Tailwind, no database layer |
| `wp/` | `template-wp` | headless WordPress theme |

Publishing (the orchestrator, never CI): clone the template repo, then

    node webdesk/templates/publish.mjs <static|fullstack|wp> <path-to-clone>
    git -C <clone> diff   # review, commit and push by hand

`publish.mjs` only copies files; it never runs git and never touches the network.

`check-wp-theme.mjs` fails (exit 1) if `wp/wp-content/themes/gaiada-webdesk/` drifts from the
canonical theme in `webdesk/wordpress/theme/gaiada-webdesk/` (only `vendor/gaiada-sdk/sdk.php` may
differ). It runs as part of `npm test` in `webdesk/`.

Every template carries `.github/workflows/site.yml`: `verify` is skipped in a template repo, and
`deploy` needs the org secret `WEBDESK_DEPLOY_GRANT` (see M6-P4g, M6-P6).
