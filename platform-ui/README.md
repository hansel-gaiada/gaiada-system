# Gaiada Platform UI (ERP Suite)

The web ERP surface for Gaiada and its child companies. Standalone Next.js project;
talks ONLY to the platform API (BFF pattern — the browser never sees tokens).

Design source: `../design/erp-suite-dashboard-handoff/` · Spec: `../docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md`

## Run
1. `cp .env.example .env` and fill values (PLATFORM_SERVICE_TOKEN must match the platform's).
2. Start the platform (`cd ../platform && npm run dev`) with Postgres up.
3. `npm install && npm run dev` → http://localhost:3005

## Rules
Plain CSS design tokens only (no Tailwind). Zero radius, no shadows, 0.5px hairlines,
opacity-only hovers. UI never asserts identity or roles (D4/OBO); no secrets rendered.
